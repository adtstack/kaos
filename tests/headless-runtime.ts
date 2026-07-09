import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import { HeadlessVaultDoc } from "../src/headless/doc";
import { NodeVaultFilesystem } from "../src/headless/fsAdapter";
import { HeadlessSyncClient, type HeadlessProviderLogEvent } from "../src/headless/provider";
import { HeadlessReconciler, type HeadlessLogEvent } from "../src/headless/reconciler";
import { createEmptyHeadlessState, type HeadlessState } from "../src/headless/stateStore";
import { parseSyncClientKind } from "../server/src/routes/syncSocket";
import {
	attachConnectionClientKind,
	buildUpdateObservedTraceData,
	readConnectionClientKind,
} from "../server/src/connectionMetadata";

interface Fixture {
	root: string;
	stateDir: string;
	doc: Y.Doc;
	vaultDoc: HeadlessVaultDoc;
	fs: NodeVaultFilesystem;
	reconciler: HeadlessReconciler;
	events: HeadlessLogEvent[];
	state: HeadlessState;
	cleanup(): Promise<void>;
}

interface FixtureOptions {
	excludePatterns?: string[];
	stateDirName?: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "kaos-headless-vault-"));
	const stateDir = join(root, options.stateDirName ?? ".kaos-headless");
	const doc = new Y.Doc();
	const vaultDoc = new HeadlessVaultDoc(doc);
	const events: HeadlessLogEvent[] = [];
	const fs = new NodeVaultFilesystem(root, {
		excludePatterns: options.excludePatterns ?? [],
		configDir: ".obsidian",
		maxFileSizeBytes: 2 * 1024 * 1024,
		trashDir: join(stateDir, "trash"),
	});
	return {
		root,
		stateDir,
		doc,
		vaultDoc,
		fs,
		reconciler: new HeadlessReconciler({
			fs,
			doc: vaultDoc,
			deviceName: "headless-test",
			log: (event) => events.push(event),
		}),
		events,
		state: createEmptyHeadlessState("headless-test", "vault-test"),
		async cleanup() {
			doc.destroy();
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function findMarkdownFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	await walk("");
	return out.sort();

	async function walk(dir: string): Promise<void> {
		const entries = await readdir(join(root, dir), { withFileTypes: true });
		for (const entry of entries) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(rel);
			} else if (entry.isFile() && rel.endsWith(".md")) {
				out.push(rel);
			}
		}
	}
}

async function readVaultFile(fixture: Fixture, path: string): Promise<string> {
	return await readFile(join(fixture.root, path), "utf8");
}

async function writeVaultFile(fixture: Fixture, path: string, content: string): Promise<void> {
	const fullPath = join(fixture.root, path);
	await mkdir(dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content, "utf8");
}

async function reconcile(fixture: Fixture): Promise<void> {
	const result = await fixture.reconciler.reconcileOnce(fixture.state);
	fixture.state = result.state;
}

console.log("\n--- headless runtime: remote markdown materializes to disk ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("notes/remote.md", "remote content", "remote-device");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(await readVaultFile(fixture, "notes/remote.md"), "remote content");
		assert.equal(result.stats.remoteCreated, 1);
		assert.equal(fixture.state.paths["notes/remote.md"]?.contentHash, fixture.state.paths["notes/remote.md"]?.crdtHash);
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: local markdown imports into CRDT ---");
{
	const fixture = await createFixture();
	try {
		await writeVaultFile(fixture, "local.md", "local content");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.localCreated, 1);
		assert.equal(fixture.vaultDoc.getActiveEntry("local.md")?.content, "local content");
		assert.ok(fixture.state.paths["local.md"]);
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: missing baseline mismatch preserves disk as conflict artifact ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("same.md", "remote canonical", "remote-device");
		await writeVaultFile(fixture, "same.md", "local unknown");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.conflicts, 1);
		assert.equal(await readVaultFile(fixture, "same.md"), "remote canonical");
		assert.equal(fixture.vaultDoc.getActiveEntry("same.md")?.content, "remote canonical");
		const artifacts = (await findMarkdownFiles(fixture.root)).filter((path) => path.includes("KAOS conflict"));
		assert.equal(artifacts.length, 1);
		assert.equal(await readVaultFile(fixture, artifacts[0]!), "local unknown");
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: both-changed baseline keeps disk and preserves CRDT artifact ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("both.md", "base", "remote-device");
		await writeVaultFile(fixture, "both.md", "base");
		await reconcile(fixture);

		fixture.vaultDoc.replaceMarkdownContent("both.md", "remote edit", "remote-device");
		await writeVaultFile(fixture, "both.md", "local edit");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.conflicts, 1);
		assert.equal(result.stats.localModified, 1);
		assert.equal(await readVaultFile(fixture, "both.md"), "local edit");
		assert.equal(fixture.vaultDoc.getActiveEntry("both.md")?.content, "local edit");
		const artifacts = (await findMarkdownFiles(fixture.root)).filter((path) => path.includes("KAOS conflict"));
		assert.equal(artifacts.length, 1);
		assert.equal(await readVaultFile(fixture, artifacts[0]!), "remote edit");
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: remote delete trashes unchanged local file ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("gone.md", "delete me", "remote-device");
		await writeVaultFile(fixture, "gone.md", "delete me");
		await reconcile(fixture);

		assert.ok(fixture.vaultDoc.tombstoneMarkdown("gone.md", "remote-device"));
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.remoteDeleted, 1);
		await assert.rejects(readVaultFile(fixture, "gone.md"));
		const trashFiles = (await findMarkdownFiles(join(fixture.stateDir, "trash"))).filter((path) => path.endsWith("gone.md"));
		assert.equal(trashFiles.length, 1);
		assert.equal(await readFile(join(fixture.stateDir, "trash", trashFiles[0]!), "utf8"), "delete me");
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: remote delete preserves changed local file ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("preserve.md", "base", "remote-device");
		await writeVaultFile(fixture, "preserve.md", "base");
		await reconcile(fixture);

		assert.ok(fixture.vaultDoc.tombstoneMarkdown("preserve.md", "remote-device"));
		await writeVaultFile(fixture, "preserve.md", "local changed after baseline");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.preservedDeletes, 1);
		assert.equal(await readVaultFile(fixture, "preserve.md"), "local changed after baseline");
		assert.ok(fixture.state.paths["preserve.md"], "state remains until operator resolves the preserved delete");
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: remote rename moves unchanged old path aside ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("old.md", "rename me", "remote-device");
		await writeVaultFile(fixture, "old.md", "rename me");
		await reconcile(fixture);

		const entry = fixture.vaultDoc.getActiveEntry("old.md");
		assert.ok(entry);
		fixture.doc.transact(() => {
			const metaEntry = fixture.vaultDoc.meta.get(entry.fileId) as Y.Map<unknown>;
			metaEntry.set("path", "new.md");
			metaEntry.set("mtime", Date.now());
		});
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.remoteRenamed, 1);
		assert.equal(await readVaultFile(fixture, "new.md"), "rename me");
		await assert.rejects(readVaultFile(fixture, "old.md"));
		assert.equal(fixture.vaultDoc.getActiveEntry("old.md"), null);
		assert.equal(fixture.vaultDoc.getActiveEntry("new.md")?.fileId, entry.fileId);
		assert.equal(fixture.state.paths["old.md"], undefined);
		assert.equal(fixture.state.paths["new.md"]?.fileId, entry.fileId);
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: remote rename preserves changed old path without resurrection ---");
{
	const fixture = await createFixture();
	try {
		fixture.vaultDoc.ensureMarkdownFile("old.md", "base", "remote-device");
		await writeVaultFile(fixture, "old.md", "base");
		await reconcile(fixture);

		const entry = fixture.vaultDoc.getActiveEntry("old.md");
		assert.ok(entry);
		fixture.doc.transact(() => {
			const metaEntry = fixture.vaultDoc.meta.get(entry.fileId) as Y.Map<unknown>;
			metaEntry.set("path", "new.md");
			metaEntry.set("mtime", Date.now());
		});
		await writeVaultFile(fixture, "old.md", "local edit after rename");
		let result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.preservedRenames, 1);
		assert.equal(await readVaultFile(fixture, "old.md"), "local edit after rename");
		assert.equal(await readVaultFile(fixture, "new.md"), "base");
		assert.equal(fixture.vaultDoc.getActiveEntry("old.md"), null);
		assert.equal(fixture.state.paths["old.md"]?.renamedTo, "new.md");

		result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;
		assert.equal(result.stats.localCreated, 0);
		assert.equal(result.stats.remoteRenamed, 0);
		assert.equal(fixture.vaultDoc.getActiveEntry("old.md"), null);
		assert.equal(await readVaultFile(fixture, "old.md"), "local edit after rename");
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: excluded remote paths are not materialized ---");
{
	const fixture = await createFixture({ excludePatterns: ["secret/"] });
	try {
		fixture.vaultDoc.ensureMarkdownFile("secret/remote.md", "do not write", "remote-device");
		const result = await fixture.reconciler.reconcileOnce(fixture.state);
		fixture.state = result.state;

		assert.equal(result.stats.remoteCreated, 0);
		assert.equal(fixture.vaultDoc.getActiveEntry("secret/remote.md")?.content, "do not write");
		await assert.rejects(readVaultFile(fixture, "secret/remote.md"));
		assert.equal(fixture.state.paths["secret/remote.md"], undefined);
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: custom state trash is excluded from vault scan ---");
{
	const fixture = await createFixture({ stateDirName: ".custom-kaos-state" });
	try {
		await writeVaultFile(fixture, ".custom-kaos-state/trash/old/deleted.md", "trash");
		await writeVaultFile(fixture, "live.md", "live");
		const files = await fixture.fs.listMarkdownFiles();

		assert.deepEqual(files.map((file) => file.path), ["live.md"]);
	} finally {
		await fixture.cleanup();
	}
}

console.log("\n--- headless runtime: sync client kind parsing is low-cardinality and sanitized ---");
{
	assert.equal(parseSyncClientKind(new URL("https://example.test/vault/sync/v")), "obsidian");
	assert.equal(parseSyncClientKind(new URL("https://example.test/vault/sync/v?clientKind=kaos-headless")), "kaos-headless");
	assert.equal(parseSyncClientKind(new URL("https://example.test/vault/sync/v?client=Headless Node!!")), "headless_node__");
	assert.equal(parseSyncClientKind(new URL("https://example.test/vault/sync/v?clientKind=%20%20")), "unknown");
}

console.log("\n--- headless runtime: server update trace carries connection client kind ---");
{
	const connection: {
		state: unknown;
		setState(state: unknown | ((prevState: unknown) => unknown)): unknown;
	} = {
		state: { __ypsAwarenessIds: [1, 2] },
		setState(state) {
			this.state = typeof state === "function" ? state(this.state) : state;
			return this.state;
		},
	};
	const request = new Request("https://example.test/vault/sync/v?clientKind=kaos-headless");
	const clientKind = attachConnectionClientKind(connection, request);

	assert.equal(clientKind, "kaos-headless");
	assert.equal(readConnectionClientKind(connection), "kaos-headless");
	assert.deepEqual((connection.state as { __ypsAwarenessIds?: number[] }).__ypsAwarenessIds, [1, 2]);

	const traceData = buildUpdateObservedTraceData(connection, new Uint8Array([1, 2, 3]), true);
	assert.deepEqual(traceData, {
		updateBytes: 3,
		docChanged: true,
		clientKind: "kaos-headless",
	});
}

console.log("\n--- headless runtime: provider URL marks ticket-auth headless connections ---");
{
	const urls: string[] = [];
	const fetchCalls: Array<{ input: string; auth: string | null }> = [];
	class CapturingWebSocket {
		static OPEN = 1;
		readyState = 0;
		binaryType = "";
		constructor(url: string) {
			urls.push(url);
		}
		addEventListener(): void {}
		send(): void {}
		close(): void {
			this.readyState = 3;
		}
	}
	const fetchImpl: typeof fetch = async (input, init) => {
		fetchCalls.push({
			input: String(input),
			auth: headersGet(init?.headers, "Authorization"),
		});
		return new Response(JSON.stringify({
			ticket: "ticket-abc",
			expiresAt: Date.now() + 120_000,
			ttlMs: 120_000,
		}), { status: 200 });
	};
	const doc = new Y.Doc();
	const client = new HeadlessSyncClient(doc, {
		host: "https://worker.example",
		token: "secret-token",
		vaultId: "vault-id",
		deviceName: "headless-test",
		webSocketPolyfill: CapturingWebSocket as unknown as typeof WebSocket,
		fetchImpl,
	});
	try {
		await client.connect();
		const url = new URL(urls[0]!);
		assert.equal(url.protocol, "wss:");
		assert.equal(url.pathname, "/vault/sync/vault-id");
		assert.equal(url.searchParams.get("clientKind"), "kaos-headless");
		assert.equal(url.searchParams.get("schemaVersion"), "3");
		assert.equal(url.searchParams.get("device"), "headless-test");
		assert.equal(url.searchParams.get("ticket"), "ticket-abc");
		assert.equal(url.searchParams.has("token"), false);
		assert.equal(fetchCalls[0]?.input, "https://worker.example/vault/vault-id/auth/ticket");
		assert.equal(fetchCalls[0]?.auth, "Bearer secret-token");
	} finally {
		client.destroy();
		doc.destroy();
	}
}

console.log("\n--- headless runtime: provider URL preserves headless marker on legacy token fallback ---");
{
	const urls: string[] = [];
	const providerEvents: HeadlessProviderLogEvent[] = [];
	class CapturingWebSocket {
		static OPEN = 1;
		readyState = 0;
		binaryType = "";
		constructor(url: string) {
			urls.push(url);
		}
		addEventListener(): void {}
		send(): void {}
		close(): void {
			this.readyState = 3;
		}
	}
	const fetchImpl: typeof fetch = async () => new Response("missing", { status: 404 });
	const doc = new Y.Doc();
	const client = new HeadlessSyncClient(doc, {
		host: "http://127.0.0.1:8787",
		token: "legacy-token",
		vaultId: "vault-id",
		deviceName: "headless-test",
		webSocketPolyfill: CapturingWebSocket as unknown as typeof WebSocket,
		fetchImpl,
		log: (event) => providerEvents.push(event),
	});
	try {
		await client.connect();
		const url = new URL(urls[0]!);
		assert.equal(url.protocol, "ws:");
		assert.equal(url.searchParams.get("clientKind"), "kaos-headless");
		assert.equal(url.searchParams.get("token"), "legacy-token");
		assert.equal(url.searchParams.has("ticket"), false);
		assert.ok(providerEvents.some((event) => event.kind === "provider-ticket-auth-unsupported"));
	} finally {
		client.destroy();
		doc.destroy();
	}
}

console.log("\n--- headless runtime: private CLI is not imported by the Obsidian plugin entry ---");
{
	const mainSource = await readFile(join(process.cwd(), "src/main.ts"), "utf8");
	assert.equal(mainSource.includes("src/headless"), false);
	assert.equal(mainSource.includes("./headless/"), false);
	assert.equal(mainSource.includes("../headless/"), false);
}

console.log("\nheadless-runtime tests passed");

function headersGet(headers: HeadersInit | undefined, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	if (Array.isArray(headers)) {
		const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
		return found?.[1] ?? null;
	}
	const value = headers[name] ?? headers[name.toLowerCase()];
	return value ?? null;
}
