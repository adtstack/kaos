/**
 * File history safety tests.
 *
 * Usage:
 *   node --import jiti/register tests/recovery-snapshots.ts
 */

import * as Y from "yjs";
import { gzipSync } from "fflate";
import {
	applyRecoveryRetention,
	auditRecoveryStorage,
	createRecoverySnapshot,
	getRecoveryContent,
	getRecoveryManifest,
	listRecoveryManifestIndexes,
	recoveryContentKey,
	selectRecoveryRetention,
	type RecoveryManifest,
	type RecoveryManifestEntry,
} from "../server/src/recoverySnapshot";
import { sha256Hex } from "../server/src/hex";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		failed++;
	}
}

class MemoryR2Object {
	constructor(
		readonly key: string,
		private readonly bytes: Uint8Array,
	) {}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.bytes.buffer.slice(
			this.bytes.byteOffset,
			this.bytes.byteOffset + this.bytes.byteLength,
		) as ArrayBuffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(this.bytes);
	}
}

class MemoryR2Bucket {
	readonly objects = new Map<string, Uint8Array>();
	readonly putOrder: string[] = [];
	readonly getOrder: string[] = [];
	readonly headOrder: string[] = [];

	async put(key: string, value: string | ArrayBuffer | Uint8Array, _options?: unknown): Promise<MemoryR2Object> {
		const bytes = typeof value === "string"
			? new TextEncoder().encode(value)
			: value instanceof Uint8Array
				? value
				: new Uint8Array(value);
		const copy = new Uint8Array(bytes);
		this.objects.set(key, copy);
		this.putOrder.push(key);
		return new MemoryR2Object(key, copy);
	}

	async get(key: string): Promise<MemoryR2Object | null> {
		this.getOrder.push(key);
		const bytes = this.objects.get(key);
		return bytes ? new MemoryR2Object(key, bytes) : null;
	}

	async head(key: string): Promise<{ key: string } | null> {
		this.headOrder.push(key);
		return this.objects.has(key) ? { key } : null;
	}

	async delete(key: string | string[]): Promise<void> {
		const keys = Array.isArray(key) ? key : [key];
		for (const item of keys) this.objects.delete(item);
	}

	async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
		objects: Array<{ key: string }>;
		truncated: boolean;
		cursor?: string;
	}> {
		const prefix = options?.prefix ?? "";
		const limit = options?.limit ?? 1000;
		const start = options?.cursor ? Number(options.cursor) : 0;
		const keys = Array.from(this.objects.keys()).filter((key) => key.startsWith(prefix)).sort();
		const page = keys.slice(start, start + limit);
		const next = start + page.length;
		return {
			objects: page.map((key) => ({ key })),
			truncated: next < keys.length,
			cursor: next < keys.length ? String(next) : undefined,
		};
	}

	clearGetOrder(): void {
		this.getOrder.length = 0;
	}

	clearHeadOrder(): void {
		this.headOrder.length = 0;
	}
}

function setText(doc: Y.Doc, fileId: string, path: string, content: string): void {
	doc.transact(() => {
		let text = doc.getMap<Y.Text>("idToText").get(fileId);
		if (!text) {
			text = new Y.Text();
			doc.getMap<Y.Text>("idToText").set(fileId, text);
		}
		if (text.length > 0) text.delete(0, text.length);
		text.insert(0, content);
		doc.getMap<string>("pathToId").set(path, fileId);
	});
}

function setNestedMetaText(doc: Y.Doc, fileId: string, path: string, content: string): void {
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 3);
		let text = doc.getMap<Y.Text>("idToText").get(fileId);
		if (!text) {
			text = new Y.Text();
			doc.getMap<Y.Text>("idToText").set(fileId, text);
		}
		if (text.length > 0) text.delete(0, text.length);
		text.insert(0, content);

		const meta = new Y.Map<unknown>();
		meta.set("path", path);
		meta.set("mtime", Date.now());
		doc.getMap<unknown>("meta").set(fileId, meta);
	});
}

function renamePath(doc: Y.Doc, fileId: string, oldPath: string, newPath: string): void {
	doc.transact(() => {
		doc.getMap<string>("pathToId").delete(oldPath);
		doc.getMap<string>("pathToId").set(newPath, fileId);
	});
}

function deletePath(doc: Y.Doc, path: string): void {
	doc.transact(() => {
		doc.getMap<string>("pathToId").delete(path);
	});
}

function applyEntry(state: Map<string, RecoveryManifestEntry>, entry: RecoveryManifestEntry): void {
	state.set(entry.fileId, entry);
}

function reconstructFrom(manifests: RecoveryManifest[]): Map<string, RecoveryManifestEntry> {
	const state = new Map<string, RecoveryManifestEntry>();
	for (const manifest of manifests.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
		for (const entry of manifest.changedEntries) {
			applyEntry(state, entry);
		}
	}
	return state;
}

async function hashText(text: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(text));
}

async function testStandaloneChangedOnlyManifestWithChangedCount(): Promise<void> {
	console.log("\n--- Test 1: file history manifest stores changed entries only ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-changed-only";

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial file history point is created");
	assertEqual(first.index?.kind, "file-history", "initial point is file-history");
	assertEqual(first.index?.storageVersion, "v2", "initial point uses v2 storage");
	assertEqual(first.index?.changedCount, 2, "initial point marks both files changed");
	assertEqual(first.index?.changedEntries.length, 2, "initial index includes changed entry preview");

	const firstManifest = await getRecoveryManifest(vaultId, first.manifestId!, bucket as unknown as R2Bucket);
	assert(firstManifest !== null, "initial file history manifest can be fetched");
	assertEqual(firstManifest?.schemaVersion, 3, "file history manifest has schemaVersion 3");
	assertEqual(firstManifest?.storageVersion, "v2", "v2 manifest has storageVersion");
	assertEqual(firstManifest?.kind, "file-history", "manifest kind is file-history");
	assertEqual(firstManifest?.changedEntries.length, 2, "initial manifest contains changed entries");
	if (firstManifest) assert(!("entries" in firstManifest), "file history manifest does not contain full entries");
	assert(bucket.putOrder.some((key) => key.startsWith(`v2/${vaultId}/recovery/manifests/`)), "manifest is written under v2 recovery prefix");
	assert(!bucket.putOrder.some((key) => key.startsWith(`v1/${vaultId}/recovery/`)), "v1 recovery prefix is not written");

	const noop = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:30:00Z"),
	});
	assertEqual(noop.status, "noop", "unchanged state is not stored again");

	setText(doc, "file-b", "b.md", "bravo v2");
	bucket.clearHeadOrder();
	const putOrderBeforeSecond = bucket.putOrder.length;
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(second.status, "created", "changed state creates a new file history point");
	assertEqual(second.index?.kind, "file-history", "second manifest remains file-history");
	assertEqual(second.index?.changedCount, 1, "changedCount is one");
	assertEqual(second.index?.changedEntries.length, 1, "index includes one changed entry");
	assertEqual(second.index?.changedEntries[0]?.fileId, "file-b", "only changed file is indexed");
	const secondContentHeads = bucket.headOrder.filter((key) => key.startsWith(`v2/${vaultId}/recovery/content/`));
	const secondContentPuts = bucket.putOrder
		.slice(putOrderBeforeSecond)
		.filter((key) => key.startsWith(`v2/${vaultId}/recovery/content/`));
	assertEqual(secondContentHeads.length, 1, "only changed content hash is checked with head");
	assertEqual(secondContentPuts.length, 1, "only changed content object is uploaded");

	const manifest = await getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket);
	assert(manifest !== null, "file history manifest can be fetched");
	assertEqual(manifest!.changedEntries.length, 1, "follow-up manifest contains only changed file");
	assert(!manifest!.changedEntries.some((entry) => entry.fileId === "file-a"), "unchanged file is not stored in manifest");
	assert(manifest!.changedEntries.some((entry) => entry.fileId === "file-b" && entry.kind === "modified"), "changed file is marked modified");

	doc.destroy();
}

async function testMissingLatestStateStartsNewBaseline(): Promise<void> {
	console.log("\n--- Test 1b: missing latest-state starts a new changed-only baseline ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-missing-latest-state";
	const latestStateKey = `v2/${vaultId}/recovery/latest-state.json.gz`;

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial point is created");

	await bucket.delete(latestStateKey);
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:30:00Z"),
	});
	assertEqual(second.status, "created", "missing latest-state does not synthesize old baseline from manifest");
	assertEqual(second.index?.changedCount, 2, "all active files become the new baseline");
	assert(await bucket.head(latestStateKey) !== null, "new point rewrites latest-state");
	const manifest = await getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket);
	assert(manifest !== null, "new baseline manifest can be fetched");
	assertEqual(manifest?.changedEntries.length, 2, "new baseline manifest stores active files as changed entries");
	assert(manifest!.changedEntries.every((entry) => entry.kind === "created"), "new baseline marks active files created");

	doc.destroy();
}

async function testRecoveryStorageStatusAndRepairDerivedObjects(): Promise<void> {
	console.log("\n--- Test 1c: light status is read-only and does not open gzip manifests ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-light-status";

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial file history point is created");

	bucket.clearGetOrder();
	const putCountBeforeStatus = bucket.putOrder.length;
	const status = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, {
		repair: false,
		manifestCheckLimit: 0,
		contentCheckLimit: 0,
	});
	assertEqual(status.status, "healthy", "light status reports healthy pointers");
	assertEqual(status.checkedManifestCount, 0, "light status does not check full manifests");
	assertEqual(bucket.putOrder.length, putCountBeforeStatus, "light status does not write to R2");
	assert(!bucket.getOrder.some((key) => key.includes("/recovery/manifests/") && key.endsWith(".json.gz")), "light status does not read gzip manifests");

	doc.destroy();
}

async function testRecoveryStorageMissingLatestStateIsDegraded(): Promise<void> {
	console.log("\n--- Test 1d: latest-state is not repaired from changed-only manifests ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-latest-state-degraded";
	const latestStateKey = `v2/${vaultId}/recovery/latest-state.json.gz`;

	setText(doc, "file-a", "a.md", "alpha");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial point is created");

	await bucket.delete(latestStateKey);
	const putCountBeforeRepair = bucket.putOrder.length;
	const repaired = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(repaired.status, "degraded", "repair reports missing latest-state as degraded");
	assert(repaired.issues.some((issue) => issue.kind === "latest-state-missing" && !issue.repaired && !issue.repairable), "latest-state issue is not repaired");
	assertEqual(bucket.putOrder.length, putCountBeforeRepair, "repair does not synthesize latest-state from changed-only manifests");

	doc.destroy();
}

async function testRecoveryStorageRepairCorruptLatestStateAndPointers(): Promise<void> {
	console.log("\n--- Test 1e: recovery storage repair fixes latest-index and manifest-index metadata ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-pointer-repair";
	const latestIndexKey = `v2/${vaultId}/recovery/latest-index.json`;

	setText(doc, "file-a", "a.md", "alpha");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	setText(doc, "file-a", "a.md", "alpha v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});

	await bucket.delete(latestIndexKey);
	const missingLatestIndexRepair = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(missingLatestIndexRepair.status, "repaired", "missing latest-index is repaired");
	assert(missingLatestIndexRepair.issues.some((issue) => issue.kind === "latest-index-missing" && issue.repaired), "missing latest-index issue is marked repaired");

	await bucket.put(latestIndexKey, JSON.stringify(first.index));
	const indexRepair = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(indexRepair.status, "repaired", "stale latest-index is repaired");
	assertEqual(indexRepair.latestIndexManifestId, second.manifestId ?? null, "repair report points latest-index to newest manifest");

	const manifestIndexKey = `v2/${vaultId}/recovery/manifest-indexes/${second.manifestId}.json`;
	await bucket.delete(manifestIndexKey);
	const missingIndexRepair = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(missingIndexRepair.status, "repaired", "missing manifest-index is repaired");
	assert(missingIndexRepair.issues.some((issue) => issue.kind === "manifest-index-missing" && issue.repaired), "missing manifest-index issue is marked repaired");

	await bucket.put(manifestIndexKey, JSON.stringify({ ...second.index, changedCount: 999 }));
	const staleIndexRepair = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(staleIndexRepair.status, "repaired", "stale manifest-index is repaired");
	assert(staleIndexRepair.issues.some((issue) => issue.kind === "manifest-index-stale" && issue.repaired), "stale manifest-index issue is marked repaired");

	doc.destroy();
}

async function testRecoveryStorageCorruptLatestStateIsDegraded(): Promise<void> {
	console.log("\n--- Test 1f: corrupt latest-state is degraded and not repaired ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-corrupt-latest-state";
	const latestStateKey = `v2/${vaultId}/recovery/latest-state.json.gz`;

	setText(doc, "file-a", "a.md", "alpha");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial point is created");

	await bucket.put(latestStateKey, new TextEncoder().encode("not gzip"));
	const stateRepair = await auditRecoveryStorage(vaultId, bucket as unknown as R2Bucket, { repair: true });
	assertEqual(stateRepair.status, "degraded", "corrupt latest-state is reported degraded");
	assert(stateRepair.issues.some((issue) => issue.kind === "latest-state-corrupt" && !issue.repaired && !issue.repairable), "corrupt latest-state issue is not repaired");

	doc.destroy();
}

async function testRecoveryStorageDegradedDoesNotRepairManifestOrContent(): Promise<void> {
	console.log("\n--- Test 1g: recovery storage audit reports corrupt manifest and missing content without repairing them ---");
	const corruptBucket = new MemoryR2Bucket();
	const corruptDoc = new Y.Doc();
	const corruptVaultId = "recovery-storage-corrupt-manifest";
	setText(corruptDoc, "file-a", "a.md", "alpha");
	const corruptSnapshot = await createRecoverySnapshot(corruptDoc, corruptVaultId, corruptBucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	const corruptManifestKey = `v2/${corruptVaultId}/recovery/manifests/${corruptSnapshot.manifestId}.json.gz`;
	await corruptBucket.put(corruptManifestKey, gzipSync(new TextEncoder().encode("not json")));
	const corruptPutCount = corruptBucket.putOrder.length;
	const corruptReport = await auditRecoveryStorage(corruptVaultId, corruptBucket as unknown as R2Bucket, { repair: true });
	assertEqual(corruptReport.status, "degraded", "corrupt manifest is reported degraded");
	assert(corruptReport.issues.some((issue) => issue.kind === "manifest-corrupt" && !issue.repairable), "corrupt manifest is not repairable");
	assertEqual(corruptBucket.putOrder.length, corruptPutCount, "corrupt manifest repair does not rewrite objects");
	corruptDoc.destroy();

	const missingContentBucket = new MemoryR2Bucket();
	const contentDoc = new Y.Doc();
	const contentVaultId = "recovery-storage-missing-content";
	setText(contentDoc, "file-a", "a.md", "alpha");
	const contentSnapshot = await createRecoverySnapshot(contentDoc, contentVaultId, missingContentBucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	const hash = contentSnapshot.index?.contentHashes[0];
	assert(typeof hash === "string", "test snapshot has a content object");
	await missingContentBucket.delete(recoveryContentKey(contentVaultId, hash!));
	const missingContentPutCount = missingContentBucket.putOrder.length;
	const missingContentReport = await auditRecoveryStorage(contentVaultId, missingContentBucket as unknown as R2Bucket, { repair: true });
	assertEqual(missingContentReport.status, "degraded", "missing content object is reported degraded");
	assert(missingContentReport.issues.some((issue) => issue.kind === "content-missing" && !issue.repairable), "missing content object is not repairable");
	assertEqual(missingContentBucket.putOrder.length, missingContentPutCount, "missing content repair does not rewrite content");
	contentDoc.destroy();
}

async function testRenameDeleteAndChainReconstruction(): Promise<void> {
	console.log("\n--- Test 2: rename/delete history reconstructs file state ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-chain";

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	renamePath(doc, "file-a", "a.md", "renamed/a.md");
	setText(doc, "file-b", "b.md", "bravo v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	deletePath(doc, "b.md");
	const third = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T02:00:00Z"),
	});

	const manifests = await Promise.all([
		getRecoveryManifest(vaultId, first.manifestId!, bucket as unknown as R2Bucket),
		getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket),
		getRecoveryManifest(vaultId, third.manifestId!, bucket as unknown as R2Bucket),
	]);
	assert(manifests.every((manifest) => manifest !== null), "all manifests can be loaded");

	const state = reconstructFrom(manifests as RecoveryManifest[]);
	assertEqual(state.get("file-a")?.path, "renamed/a.md", "chain reconstructs renamed path");
	assertEqual(state.get("file-a")?.kind, "renamed", "rename event is preserved");
	assertEqual(state.get("file-b")?.deleted, true, "chain reconstructs deletion");
	assertEqual(state.get("file-b")?.kind, "deleted", "delete event is preserved");

	doc.destroy();
}

async function testNestedV3MetaIsSnapshotted(): Promise<void> {
	console.log("\n--- Test 2b: v3 nested meta is recorded as file history without pathToId ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-v3-meta";

	setNestedMetaText(doc, "file-a", "a.md", "alpha");
	setNestedMetaText(doc, "file-b", "folder/b.md", "bravo");

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial v3 file history point is created");
	assertEqual(first.index?.kind, "file-history", "initial v3 point is file-history");
	assertEqual(first.index?.changedCount, 2, "initial v3 point marks both files changed");
	assertEqual(first.index?.changedEntries.length, 2, "initial v3 index records both changed entries");

	const firstManifest = await getRecoveryManifest(vaultId, first.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(firstManifest?.changedEntries.length, 2, "initial v3 manifest contains both changed entries");
	assert(firstManifest!.changedEntries.every((entry) => entry.kind === "created"), "initial v3 entries are marked created");

	setNestedMetaText(doc, "file-b", "folder/b.md", "bravo v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(second.status, "created", "v3 content change creates a file history point");
	assertEqual(second.index?.kind, "file-history", "v3 follow-up point remains file-history");
	assertEqual(second.index?.changedCount, 1, "v3 follow-up changedCount is one");

	const secondManifest = await getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(secondManifest?.changedEntries.length, 1, "v3 follow-up manifest contains only changed file");
	assert(!secondManifest!.changedEntries.some((entry) => entry.fileId === "file-a"), "v3 follow-up manifest omits unchanged file");
	assert(secondManifest!.changedEntries.some((entry) => entry.fileId === "file-b" && entry.kind === "modified"), "v3 touched file is marked modified");

	doc.destroy();
}

async function testLargeVaultFollowUpStoresChangedOnly(): Promise<void> {
	console.log("\n--- Test 3: 5k-file vault follow-up stores changed file only ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-large";

	for (let i = 0; i < 5000; i++) {
		setText(doc, `file-${i}`, `folder/${i}.md`, `content ${i}`);
	}
	const full = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(full.index?.kind, "file-history", "large initial point is file-history");
	assertEqual(full.index?.changedEntries.length, 5000, "large initial point records all files as initial changes");

	setText(doc, "file-1234", "folder/1234.md", "content 1234 changed");
	bucket.clearHeadOrder();
	const putOrderBeforeNext = bucket.putOrder.length;
	const next = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(next.index?.kind, "file-history", "large follow-up remains file-history");
	assertEqual(next.index?.changedCount, 1, "large follow-up changedCount is one");
	assertEqual(next.index?.contentHashes.length, 1, "large follow-up stores one content hash");
	assertEqual(
		bucket.headOrder.filter((key) => key.startsWith(`v2/${vaultId}/recovery/content/`)).length,
		1,
		"large follow-up checks only changed content hash",
	);
	assertEqual(
		bucket.putOrder.slice(putOrderBeforeNext).filter((key) => key.startsWith(`v2/${vaultId}/recovery/content/`)).length,
		1,
		"large follow-up uploads only changed content object",
	);

	const manifest = await getRecoveryManifest(vaultId, next.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(manifest?.changedEntries.length, 1, "large follow-up manifest contains one changed entry");
	assert(manifest!.changedEntries.some((entry) => entry.fileId === "file-1234" && entry.kind === "modified"), "large follow-up marks touched file modified");
	assert(!manifest!.changedEntries.some((entry) => entry.fileId === "file-1235"), "large follow-up omits untouched file");

	doc.destroy();
}

async function testFileHistoryPointerOrder(): Promise<void> {
	console.log("\n--- Test 4: file history content and pointer write order ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-pointer-order";

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	setText(doc, "file-a", "a.md", "alpha v2");
	const forced = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
		forceFull: true,
	});
	assertEqual(forced.index?.kind, "file-history", "forceFull is accepted but file history remains changed-only");

	const manifest = await getRecoveryManifest(vaultId, forced.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(manifest?.changedEntries.length, 1, "forced point stores only changed file entries");
	assert(!manifest!.changedEntries.some((entry) => entry.fileId === "file-b"), "forced point omits unchanged file state");

	const latestIndexKey = `v2/${vaultId}/recovery/latest-index.json`;
	const latestStateKey = `v2/${vaultId}/recovery/latest-state.json.gz`;
	const manifestPutIndex = bucket.putOrder.findIndex((key) => key.includes(`/recovery/manifests/`) && key.includes(forced.manifestId!));
	const latestStatePutIndex = bucket.putOrder.lastIndexOf(latestStateKey);
	const latestIndexPutIndex = bucket.putOrder.lastIndexOf(latestIndexKey);
	const contentPutIndex = bucket.putOrder.findIndex((key) => key.startsWith(`v2/${vaultId}/recovery/content/`) && key.endsWith(".md.gz"));
	assert(manifestPutIndex >= 0, "manifest object was written");
	assert(contentPutIndex >= 0 && contentPutIndex < manifestPutIndex, "content is written before manifest");
	assert(latestStatePutIndex > manifestPutIndex, "latest state is written after manifest");
	assert(latestIndexPutIndex > latestStatePutIndex, "latest pointer is written after manifest and state");
	assert(first.manifestId !== forced.manifestId, "new file history point has a new id");

	doc.destroy();
}

async function testContentHashVerification(): Promise<void> {
	console.log("\n--- Test 5: content object hash is verified before read ---");
	const bucket = new MemoryR2Bucket();
	const vaultId = "recovery-hash";
	const expectedHash = await hashText("expected content");
	await bucket.put(recoveryContentKey(vaultId, expectedHash), gzipSync(new TextEncoder().encode("tampered content")));

	let threw = false;
	try {
		await getRecoveryContent(vaultId, expectedHash, bucket as unknown as R2Bucket);
	} catch {
		threw = true;
	}
	assert(threw, "tampered content object is rejected");
}

async function testListIsNewestFirst(): Promise<void> {
	console.log("\n--- Test 6: file history listing is newest-first, bounded, lightweight, and ignores v1 ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-list";

	setText(doc, "file-a", "a.md", "alpha");
	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	setText(doc, "file-a", "a.md", "alpha v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});

	const listed = await listRecoveryManifestIndexes(vaultId, bucket as unknown as R2Bucket, 1);
	assertEqual(listed.manifests.length, 1, "list limit is respected");
	assertEqual(listed.totalManifestKeys, 2, "list reports total manifest key count");
	assertEqual(listed.limited, true, "list marks bounded result as limited");
	assertEqual(listed.manifests[0]?.manifestId, second.manifestId, "newest manifest is listed first");
	assertEqual(listed.manifests[0]?.changedCount, 1, "list reads changedCount from lightweight index");
	assertEqual(listed.manifests[0]?.kind, "file-history", "list reads file-history kind from lightweight index");
	assertEqual(listed.manifests[0]?.changedEntries.length, 1, "list reads changed entry preview from lightweight index");
	assertEqual(listed.manifests[0]?.changedEntries[0]?.fileId, "file-a", "list preview includes changed file id");
	assert(first.manifestId !== second.manifestId, "test created two distinct manifests");
	assert(bucket.putOrder.some((key) => key === `v2/${vaultId}/recovery/manifest-indexes/${second.manifestId}.json`), "lightweight manifest index is written");
	assert(!bucket.getOrder.some((key) => key.includes("/recovery/manifests/") && key.endsWith(".json.gz")), "listing does not read full gzip manifests");

	await bucket.put(`v1/${vaultId}/recovery/manifests/2026-06-20/legacy.json.gz`, "legacy");
	const listedAfterLegacy = await listRecoveryManifestIndexes(vaultId, bucket as unknown as R2Bucket, 20);
	assertEqual(listedAfterLegacy.totalManifestKeys, 2, "v1 recovery manifest is ignored by file history listing");

	doc.destroy();
}

async function testListSynthesizesLegacyIndexWithoutReadingManifest(): Promise<void> {
	console.log("\n--- Test 6b: listing missing-index v2 manifests does not open large gzip manifest ---");
	const bucket = new MemoryR2Bucket();
	const vaultId = "file-history-list-missing-index";
	const createdAt = "2026-05-27T00:00:00.000Z";
	const manifestId = `${new Date(createdAt).getTime().toString(36)}-abcd1234`;
	await bucket.put(
		`v2/${vaultId}/recovery/manifests/${manifestId}.json.gz`,
		gzipSync(new TextEncoder().encode("not json and intentionally never read")),
	);

	bucket.clearGetOrder();
	const listed = await listRecoveryManifestIndexes(vaultId, bucket as unknown as R2Bucket, 9);
	assertEqual(listed.manifests.length, 1, "missing-index v2 manifest key is listed");
	assertEqual(listed.manifests[0]?.manifestId, manifestId, "synthesized index keeps manifest id");
	assertEqual(listed.manifests[0]?.createdAt, createdAt, "synthesized index derives createdAt from manifest id");
	assertEqual(listed.manifests[0]?.changedEntries.length, 0, "synthesized index has no preview without opening manifest");
	assert(!bucket.getOrder.some((key) => key.endsWith(".json.gz")), "listing does not read full gzip manifest");
}

async function testRetentionPrunesOnlyV2AndGcContent(): Promise<void> {
	console.log("\n--- Test 7: v2 retention prunes v2 only and garbage collects unreferenced v2 content ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-retention";

	setText(doc, "file-a", "a.md", "one");
	const oldSameDayPrune = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-01-01T00:00:00Z"),
	});
	setText(doc, "file-a", "a.md", "two");
	const oldSameDayKeep = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-01-01T01:00:00Z"),
	});
	setText(doc, "file-a", "a.md", "three");
	const latest = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-09T00:00:00Z"),
	});

	const before = await listRecoveryManifestIndexes(vaultId, bucket as unknown as R2Bucket, 20);
	const selected = selectRecoveryRetention(before.manifests, undefined, new Date("2026-06-10T00:00:00Z"));
	assert(selected.prune.some((manifest) => manifest.manifestId === oldSameDayPrune.manifestId), "older automatic v2 manifest on same retained day is selected for pruning");
	assert(selected.keep.some((manifest) => manifest.manifestId === oldSameDayKeep.manifestId), "newest automatic v2 manifest for old day is retained");
	assert(selected.keep.some((manifest) => manifest.manifestId === latest.manifestId), "latest v2 manifest is retained");

	const hashOne = await hashText("one");
	const hashTwo = await hashText("two");
	const hashThree = await hashText("three");
	const orphanHash = await hashText("orphan content");
	await bucket.put(recoveryContentKey(vaultId, orphanHash), gzipSync(new TextEncoder().encode("orphan content")));
	const legacyRecoveryKey = `v1/${vaultId}/recovery/content/${orphanHash}.md.gz`;
	const legacySnapshotKey = `v1/${vaultId}/snapshots/2026-01-01/legacy/index.json`;
	const legacyBlobKey = `v1/${vaultId}/blobs/${orphanHash}`;
	await bucket.put(legacyRecoveryKey, "legacy recovery");
	await bucket.put(legacySnapshotKey, "legacy snapshot");
	await bucket.put(legacyBlobKey, "legacy blob");
	assert(await bucket.head(recoveryContentKey(vaultId, hashOne)) !== null, "prune candidate content exists before GC");
	assert(await bucket.head(recoveryContentKey(vaultId, hashTwo)) !== null, "retained old day content exists before GC");
	assert(await bucket.head(recoveryContentKey(vaultId, hashThree)) !== null, "latest content exists before GC");
	assert(await bucket.head(recoveryContentKey(vaultId, orphanHash)) !== null, "orphan content exists before GC");

	const result = await applyRecoveryRetention(
		vaultId,
		bucket as unknown as R2Bucket,
		undefined,
		new Date("2026-06-10T00:00:00Z"),
	);
	assertEqual(result.failed, 0, "retention completed without failures");
	assertEqual(result.prunedManifests, 1, "retention pruned one old v2 manifest");
	assert(await getRecoveryManifest(vaultId, oldSameDayPrune.manifestId!, bucket as unknown as R2Bucket) === null, "pruned v2 manifest is gone");
	assert(await getRecoveryManifest(vaultId, oldSameDayKeep.manifestId!, bucket as unknown as R2Bucket) !== null, "retained old-day v2 manifest remains");
	assert(await getRecoveryManifest(vaultId, latest.manifestId!, bucket as unknown as R2Bucket) !== null, "latest v2 manifest remains");
	assert(await bucket.head(recoveryContentKey(vaultId, hashOne)) !== null, "content referenced by retained previousContentHash is kept");
	assert(await bucket.head(recoveryContentKey(vaultId, hashTwo)) !== null, "content referenced by retained old-day manifest is kept");
	assert(await bucket.head(recoveryContentKey(vaultId, hashThree)) !== null, "content referenced by latest state is kept");
	assert(await bucket.head(recoveryContentKey(vaultId, orphanHash)) === null, "unreferenced orphan content is garbage collected");
	assert(await bucket.head(legacyRecoveryKey) !== null, "v1 recovery content is not touched");
	assert(await bucket.head(legacySnapshotKey) !== null, "v1 snapshot content is not touched");
	assert(await bucket.head(legacyBlobKey) !== null, "v1 blob content is not touched");

	doc.destroy();
}

async function testLargeFileHistoryPointDoesNotCreateBundle(): Promise<void> {
	console.log("\n--- Test 8: large file history point stores individual changed content objects, not bundles ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "file-history-large-no-bundle";

	for (let i = 0; i < 600; i++) {
		setText(doc, `file-${i}`, `notes/${i}.md`, `content ${i}`);
	}

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "large initial file history point is created");
	assertEqual(first.index?.kind, "file-history", "large initial point is file-history");
	assertEqual(first.index?.changedEntries.length, 600, "large initial point stores initial changed entries");

	const hash = await hashText("content 542");
	assert(await bucket.head(recoveryContentKey(vaultId, hash)) !== null, "large file history point writes individual content object");
	assert(!bucket.putOrder.some((key) => key.includes("/recovery/content-bundles/")), "large file history point does not create content bundle");
	const content = await getRecoveryContent(vaultId, hash, bucket as unknown as R2Bucket);
	assertEqual(content?.text, "content 542", "individual v2 content is fetched by hash");

	doc.destroy();
}

async function testTamperedManifestIsRejected(): Promise<void> {
	console.log("\n--- Test 9: tampered v2 manifest is rejected ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-tampered-manifest";

	setText(doc, "file-a", "a.md", "alpha");
	const created = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	const manifest = await getRecoveryManifest(vaultId, created.manifestId!, bucket as unknown as R2Bucket);
	assert(manifest !== null, "manifest can be loaded before tamper");
	manifest!.changedEntries[0]!.path = "tampered.md";
	await bucket.put(
		`v2/${vaultId}/recovery/manifests/${created.manifestId}.json.gz`,
		gzipSync(new TextEncoder().encode(JSON.stringify(manifest))),
	);
	assert(await getRecoveryManifest(vaultId, created.manifestId!, bucket as unknown as R2Bucket) === null, "manifest hash mismatch is rejected");

	doc.destroy();
}

await testStandaloneChangedOnlyManifestWithChangedCount();
await testMissingLatestStateStartsNewBaseline();
await testRecoveryStorageStatusAndRepairDerivedObjects();
await testRecoveryStorageMissingLatestStateIsDegraded();
await testRecoveryStorageRepairCorruptLatestStateAndPointers();
await testRecoveryStorageCorruptLatestStateIsDegraded();
await testRecoveryStorageDegradedDoesNotRepairManifestOrContent();
await testRenameDeleteAndChainReconstruction();
await testNestedV3MetaIsSnapshotted();
await testLargeVaultFollowUpStoresChangedOnly();
await testFileHistoryPointerOrder();
await testContentHashVerification();
await testListIsNewestFirst();
await testListSynthesizesLegacyIndexWithoutReadingManifest();
await testRetentionPrunesOnlyV2AndGcContent();
await testLargeFileHistoryPointDoesNotCreateBundle();
await testTamperedManifestIsRejected();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
