import assert from "node:assert/strict";
import { TFile } from "obsidian";
import * as Y from "yjs";
import { commitServerFileRepair, inspectServerFile } from "../server/src/fileRepair";
import { ServerFileRepairService, readPendingServerRepairPaths } from "../src/runtime/serverFileRepairService";
import { BlobSyncManager } from "../src/sync/blobSync";
import { isLocalSafetyArtifactPath } from "../src/paths/conflictArtifactPath";

function bytes(content: string): ArrayBuffer { return new TextEncoder().encode(content).buffer as ArrayBuffer; }
function string(data: ArrayBuffer): string { return new TextDecoder().decode(data); }
async function hash(data: ArrayBuffer): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fixture(kind: "text" | "blob", options: { downloadFail?: boolean; createFail?: boolean; mutateDuringCommit?: boolean; journalFail?: boolean; rejectCommit?: boolean; emptyBlob?: boolean; corruptDownload?: boolean } = {}) {
	const path = kind === "text" ? "Notes/file.md" : "assets/file.canvas";
	const server = new Y.Doc(); server.getMap("sys").set("schemaVersion", 3);
	const remoteBytes = bytes(options.emptyBlob ? "" : "server A");
	const remoteRef = { hash: await hash(remoteBytes), size: remoteBytes.byteLength };
	if (kind === "text") {
		server.getMap("meta").set("id", new Y.Map([["path", path]]));
		server.getMap("idToText").set("id", new Y.Text("server A"));
	} else server.getMap("pathToBlob").set(path, remoteRef);
	const local = new Y.Doc(); Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
	if (kind === "text") { const value = local.getMap<Y.Text>("idToText").get("id")!; value.delete(0, value.length); value.insert(0, "unsent B"); }
	else local.getMap("pathToBlob").set(path, { hash: "b".repeat(64), size: 8 });
	const stored = new Map<string, { file: any; data: ArrayBuffer }>();
	const backups = new Map<string, ArrayBuffer>();
	const directories = new Set<string>();
	let clock = 1;
	const put = (candidate: string, data: ArrayBuffer, existing?: any) => {
		const file = existing ?? new TFile(); file.path = candidate; file.stat = { ctime: 1, mtime: clock++, size: data.byteLength };
		stored.set(candidate, { file, data }); return file;
	};
	const original = put(path, bytes("disk C"));
	let paneContent = "editor D";
	const panes: any[] = kind === "text" ? [{ file: original, editor: { getValue: () => paneContent } }] : [];
	let rejectNextCommit = options.rejectCommit === true;
	let serverCommits = 0; let projections = 0; let connects = 0; let mayCreate = options.createFail === true;
	const adapter = {
		exists: async (candidate: string) => directories.has(candidate) || backups.has(candidate) || stored.has(candidate),
		mkdir: async (candidate: string) => { directories.add(candidate); },
		writeBinary: async (candidate: string, data: ArrayBuffer) => { backups.set(candidate, data.slice(0)); },
		readBinary: async (candidate: string) => { const data = backups.get(candidate) ?? stored.get(candidate)?.data; if (!data) throw new Error("missing"); return data.slice(0); },
		write: async (candidate: string, content: string) => {
			if (options.journalFail && candidate.endsWith("record.json") && content.includes("commit-pending")) throw new Error("journal failure");
			backups.set(candidate, bytes(content));
		},
		read: async (candidate: string) => string(backups.get(candidate)!),
		list: async (candidate: string) => ({ folders: [...directories].filter((dir) => dir.startsWith(`${candidate}/`) && !dir.slice(candidate.length + 1).includes("/")), files: [] }),
	};
	const app: any = { workspace: { iterateAllLeaves: (visit: (leaf: any) => void) => panes.forEach((view) => visit({ view })) }, vault: {
		configDir: ".obsidian", adapter,
		getAbstractFileByPath: (candidate: string) => stored.get(candidate)?.file ?? null,
		read: async (file: any) => string(stored.get(file.path)!.data),
		readBinary: async (file: any) => { const entry = stored.get(file.path); if (entry?.file !== file) throw new Error("wrong identity"); return entry.data.slice(0); },
		createBinary: async (candidate: string, data: ArrayBuffer) => {
			if (stored.has(candidate)) throw new Error("EEXIST");
			if (mayCreate && candidate === path) { mayCreate = false; throw new Error("create failure"); }
			return put(candidate, data);
		},
		rename: async (file: any, destination: string) => {
			assert.equal(stored.get(file.path)?.file, file); assert.equal(stored.has(destination), false);
			const entry = stored.get(file.path)!; stored.delete(file.path); file.path = destination; stored.set(destination, entry);
		},
		trash: async (file: any) => { if (stored.get(file.path)?.file === file) stored.delete(file.path); },
	} };
	app.fileManager = { trashFile: app.vault.trash };
	const settings: any = { host: "https://server", vaultId: "vault", authorizationHeader: async () => "Bearer test", deviceName: "test" };
	const sync: any = { ydoc: local, sys: local.getMap("sys"), pathToBlob: local.getMap("pathToBlob"),
		getTextForPath: () => kind === "text" ? local.getMap<Y.Text>("idToText").get("id") : null,
		getBlobRef: (candidate: string) => local.getMap("pathToBlob").get(candidate),
		getBlobSourceVersion: (candidate: string) => {
			const item = (local.getMap("pathToBlob") as any)._map.get(candidate); return item ? `${item.id.client}:${item.id.clock}` : undefined;
		},
		provider: { shouldConnect: true, disconnect() { this.shouldConnect = false; }, async connect() { this.shouldConnect = true; connects++; } },
	};
	const settled: any = {}; const stages: any = {}; const settledSources: any = {};
	const manager = new BlobSyncManager(app, sync, { host: settings.host, vaultId: settings.vaultId, getAuthorizationHeader: settings.authorizationHeader,
		maxAttachmentSizeKB: 10240, attachmentConcurrency: 1, debug: false }, {}, undefined, [], undefined, () => false, settled, undefined, settledSources, stages);
	const pending = new Set<string>();
	const service = new ServerFileRepairService({ app, getSettings: () => settings, getLocalDeviceId: () => "local-device-1", isPathSyncable: () => true, getVaultSync: () => sync, getBlobSync: () => manager,
		setPending: (candidate, active) => { if (active) pending.add(candidate); else pending.delete(candidate); },
		setProjecting: () => {},
		projectText: async (candidate, file, expectedDisk, expectedServer, isCurrent) => {
			projections++; assert.equal(candidate, path); assert.equal(file, original); assert.equal(expectedDisk, "disk C"); assert.equal(expectedServer, "server A"); assert.equal(isCurrent(), true);
			assert.equal(string(stored.get(path)!.data), expectedDisk);
			paneContent = expectedServer; put(path, bytes(expectedServer), original); return { ok: true };
		},
	});
	(globalThis as any).__KAOS_TEST_REQUEST_URL__ = async (request: any) => {
		assert.equal(request.headers.Authorization, "Bearer test");
		if (request.url.includes("/blobs/")) {
			return { status: options.downloadFail ? 404 : 200, arrayBuffer: options.corruptDownload ? bytes("corrupt") : remoteBytes, text: "missing" };
		}
		if (request.method === "POST") {
			if (rejectNextCommit) { rejectNextCommit = false; return { status: 409 }; }
			serverCommits++;
			const repaired = await commitServerFileRepair(server, path, request.headers["X-KAOS-Repair-Token"], new Uint8Array(request.body));
			if (options.mutateDuringCommit) { paneContent = "new user edit"; }
			return { status: 200, headers: { "x-kaos-file-repair": "1" }, arrayBuffer: repaired.buffer };
		}
		return { status: 200, json: await inspectServerFile(server, path) };
	};
	return { path, service, app, settings, server, local, original, remoteRef, pending, stored, backups, panes,
		counts: () => ({ serverCommits, projections, connects }), pane: () => paneContent, stages, settled,
		version: () => inspectServerFile(server, path), manager };
}

async function main(): Promise<void> {
	const text = await fixture("text");
	const directory = await text.service.execute(await text.version(), text.original);
	assert.equal(string(text.stored.get(text.path)!.data), "server A"); assert.equal(text.pane(), "server A");
	assert.equal(string(text.backups.get(`${directory}/original.bin`)!), "disk C");
	assert.deepEqual(JSON.parse(string(text.backups.get(`${directory}/local-text.json`)!)), { crdt: "unsent B", editors: ["editor D"] });
	assert.deepEqual(await readPendingServerRepairPaths(text.app, text.settings, "local-device-1"), []);
	assert.deepEqual(text.counts(), { serverCommits: 1, projections: 1, connects: 1 });
	const blob = await fixture("blob");
	await blob.service.execute(await blob.version(), blob.original);
	assert.equal(string(blob.stored.get(blob.path)!.data), "server A");
	assert.equal(blob.settled[blob.path].hash, blob.remoteRef.hash); assert.deepEqual(blob.stages, {});
	const visibleBackup = [...blob.stored.keys()].find((candidate) => candidate !== blob.path)!;
	assert.equal(isLocalSafetyArtifactPath(visibleBackup), true); assert.equal(string(blob.stored.get(visibleBackup)!.data), "disk C");
	const emptyBlob = await fixture("blob", { emptyBlob: true });
	await emptyBlob.service.execute(await emptyBlob.version(), emptyBlob.original);
	assert.equal(emptyBlob.stored.get(emptyBlob.path)!.data.byteLength, 0, "zero-byte server attachment is a valid repair");
	const corruptBlob = await fixture("blob", { corruptDownload: true });
	await assert.rejects(corruptBlob.service.execute(await corruptBlob.version(), corruptBlob.original), /verification failed/);
	assert.equal(corruptBlob.counts().serverCommits, 0, "unverified attachment bytes never commit or replace local content");
	assert.equal(string(corruptBlob.stored.get(corruptBlob.path)!.data), "disk C");
	const failure = await fixture("blob", { downloadFail: true });
	await assert.rejects(failure.service.execute(await failure.version(), failure.original), /blob download failed/);
	assert.equal(failure.counts().serverCommits, 0); assert.equal(string(failure.stored.get(failure.path)!.data), "disk C");
	const swapFailure = await fixture("blob", { createFail: true });
	await assert.rejects(swapFailure.service.execute(await swapFailure.version(), swapFailure.original), /create failure/);
	assert.equal(string(swapFailure.stored.get(swapFailure.path)!.data), "disk C", "failed swap compensates without losing local bytes");
	assert.deepEqual(await readPendingServerRepairPaths(swapFailure.app, swapFailure.settings, "local-device-1"), [swapFailure.path]);
	assert.equal(swapFailure.counts().connects, 0, "ambiguous failure cannot reconnect and send discarded pending edits");
	assert.deepEqual(await readPendingServerRepairPaths(swapFailure.app, swapFailure.settings, "another-device"), [], "replicated backups never impose another device repair state");
	await swapFailure.service.execute(await swapFailure.version(), swapFailure.stored.get(swapFailure.path)!.file);
	assert.equal(string(swapFailure.stored.get(swapFailure.path)!.data), "server A", "explicit retry settles an interrupted download stage");
	assert.deepEqual(await readPendingServerRepairPaths(swapFailure.app, swapFailure.settings, "local-device-1"), []);
	assert.equal(swapFailure.counts().connects, 1, "successful retry restores persisted connection intent");
	const race = await fixture("text", { mutateDuringCommit: true });
	await assert.rejects(race.service.execute(await race.version(), race.original), /Local file or editor changed/);
	assert.equal(race.pane(), "new user edit"); assert.equal(string(race.stored.get(race.path)!.data), "disk C");
	assert.deepEqual(await readPendingServerRepairPaths(race.app, race.settings, "local-device-1"), [race.path]);
	const rejected = await fixture("text", { rejectCommit: true });
	await assert.rejects(rejected.service.execute(await rejected.version(), rejected.original), /Server state changed/);
	assert.equal(rejected.counts().serverCommits, 0);
	assert.equal(rejected.counts().connects, 0, "HTTP rejection cannot upload unsent B through resumed sync");
	assert.equal(rejected.server.getMap<Y.Text>("idToText").get("id")!.toString(), "server A");
	await rejected.service.execute(await rejected.version(), rejected.original);
	assert.equal(rejected.counts().connects, 1);
	const journalFail = await fixture("text", { journalFail: true });
	await assert.rejects(journalFail.service.execute(await journalFail.version(), journalFail.original), /journal failure/);
	assert.equal(journalFail.counts().serverCommits, 0);
	const openCanvas = await fixture("blob"); openCanvas.panes.push({ file: openCanvas.original });
	await assert.rejects(openCanvas.service.execute(await openCanvas.version(), openCanvas.original), /Close this attachment or canvas/);
	assert.equal(openCanvas.counts().serverCommits, 0);
	// A crash can leave the canonical Blob path absent after its backup rename.
	const crash = await fixture("blob", { createFail: true });
	await assert.rejects(crash.service.execute(await crash.version(), crash.original));
	crash.stored.delete(crash.path);
	assert.deepEqual(await readPendingServerRepairPaths(crash.app, crash.settings, "another-device"), []);
	assert.equal(crash.stored.has(crash.path), false, "foreign device cannot project a replicated safety backup");
	assert.deepEqual(await readPendingServerRepairPaths(crash.app, crash.settings, "local-device-1"), [crash.path]);
	// Test lightweight recovery when server version is oversized (room > 8 MiB)
	const oversizedText = await fixture("text");
	const oversizedVer = { ...(await oversizedText.version()), oversized: true };
	const dir = await oversizedText.service.execute(oversizedVer, oversizedText.original);
	assert.equal(string(oversizedText.stored.get(oversizedText.path)!.data), "server A", "lightweight text repair restores server content to disk");
	assert.equal(oversizedText.pane(), "server A", "lightweight text repair refreshes editor pane");
	assert.equal(oversizedText.counts().serverCommits, 0, "lightweight repair does not POST atomic CRDT to server");
	assert.equal(oversizedText.counts().connects, 1, "sync reconnects after lightweight repair");
	assert.equal(string(oversizedText.backups.get(`${dir}/original.bin`)!), "disk C", "safety backup is saved");

	// Test lightweight recovery fallback when commit throws 413
	const commit413Text = await fixture("text");
	const origHandler = (globalThis as any).__KAOS_TEST_REQUEST_URL__;
	(globalThis as any).__KAOS_TEST_REQUEST_URL__ = async (request: any) => {
		if (request.method === "POST") return { status: 413 };
		return origHandler(request);
	};
	const dir413 = await commit413Text.service.execute(await commit413Text.version(), commit413Text.original);
	assert.equal(string(commit413Text.stored.get(commit413Text.path)!.data), "server A", "413 fallback restores server content");
	assert.equal(commit413Text.counts().connects, 1, "sync reconnects after 413 fallback");
	(globalThis as any).__KAOS_TEST_REQUEST_URL__ = origHandler;

	delete (globalThis as any).__KAOS_TEST_REQUEST_URL__;
	console.log("PASS server-file-repair-service: text/editor/CRDT backups, Blob no-clobber swap and settlement, download/write failures, input races, journals, restart vacancy recovery, and lightweight recovery");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
