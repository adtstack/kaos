/**
 * File-level recovery snapshot safety tests.
 *
 * Usage:
 *   node --import jiti/register tests/recovery-snapshots.ts
 */

import * as Y from "yjs";
import { gzipSync } from "fflate";
import {
	applyRecoveryRetention,
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
		const bytes = this.objects.get(key);
		return bytes ? new MemoryR2Object(key, bytes) : null;
	}

	async head(key: string): Promise<{ key: string } | null> {
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
		for (const entry of manifest.entries) {
			if (entry.kind === "unchanged" && state.has(entry.fileId)) continue;
			applyEntry(state, entry);
		}
	}
	return state;
}

async function hashText(text: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(text));
}

async function testStandaloneFullManifestWithChangedCount(): Promise<void> {
	console.log("\n--- Test 1: v2 standalone full manifest records whole state and changedCount ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-v2-full";

	setText(doc, "file-a", "a.md", "alpha");
	setText(doc, "file-b", "b.md", "bravo");

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial recovery snapshot is created");
	assertEqual(first.index?.kind, "full", "initial recovery snapshot is full");
	assertEqual(first.index?.storageVersion, "v2", "initial recovery snapshot uses v2 storage");
	assertEqual(first.index?.changedCount, 2, "initial full marks both files changed");

	const firstManifest = await getRecoveryManifest(vaultId, first.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(firstManifest?.schemaVersion, 2, "v2 manifest has schemaVersion 2");
	assertEqual(firstManifest?.storageVersion, "v2", "v2 manifest has storageVersion");
	assertEqual(firstManifest?.entries.length, 2, "initial v2 manifest contains full file state");
	assert(bucket.putOrder.some((key) => key.startsWith(`v2/${vaultId}/recovery/manifests/`)), "manifest is written under v2 recovery prefix");
	assert(!bucket.putOrder.some((key) => key.startsWith(`v1/${vaultId}/recovery/`)), "v1 recovery prefix is not written");

	const noop = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:30:00Z"),
	});
	assertEqual(noop.status, "noop", "unchanged state is not stored again");

	setText(doc, "file-b", "b.md", "bravo v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(second.status, "created", "changed state creates a new v2 full manifest");
	assertEqual(second.index?.kind, "full", "second manifest remains full");
	assertEqual(second.index?.changedCount, 1, "changedCount is one");

	const manifest = await getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket);
	assert(manifest !== null, "v2 full manifest can be fetched");
	assertEqual(manifest!.entries.length, 2, "v2 full manifest contains all current files");
	assert(manifest!.entries.some((entry) => entry.fileId === "file-a" && entry.kind === "unchanged"), "unchanged file remains in full manifest");
	assert(manifest!.entries.some((entry) => entry.fileId === "file-b" && entry.kind === "modified"), "changed file is marked modified");

	doc.destroy();
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
	console.log("\n--- Test 2b: v3 nested meta is snapshotted without pathToId ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-v3-meta";

	setNestedMetaText(doc, "file-a", "a.md", "alpha");
	setNestedMetaText(doc, "file-b", "folder/b.md", "bravo");

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "initial v3 recovery snapshot is created");
	assertEqual(first.index?.kind, "full", "initial v3 recovery snapshot is full");
	assertEqual(first.index?.changedCount, 2, "initial v3 full marks both files changed");
	assertEqual(first.index?.fullFileCount, 2, "initial v3 full records both files");

	const firstManifest = await getRecoveryManifest(vaultId, first.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(firstManifest?.entries.length, 2, "initial v3 manifest contains both entries");
	assert(firstManifest!.entries.every((entry) => entry.kind === "created"), "initial v3 entries are marked created");

	setNestedMetaText(doc, "file-b", "folder/b.md", "bravo v2");
	const second = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(second.status, "created", "v3 content change creates a v2 full snapshot");
	assertEqual(second.index?.kind, "full", "v3 follow-up snapshot remains full");
	assertEqual(second.index?.changedCount, 1, "v3 delta changedCount is one");

	const secondManifest = await getRecoveryManifest(vaultId, second.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(secondManifest?.entries.length, 2, "v3 full manifest contains whole state");
	assert(secondManifest!.entries.some((entry) => entry.fileId === "file-a" && entry.kind === "unchanged"), "v3 full manifest includes unchanged file");
	assert(secondManifest!.entries.some((entry) => entry.fileId === "file-b" && entry.kind === "modified"), "v3 touched file is marked modified");

	doc.destroy();
}

async function testLargeVaultFullManifestUsesContentDedupe(): Promise<void> {
	console.log("\n--- Test 3: 5k-file vault writes full manifest and deduped content ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-large";

	for (let i = 0; i < 5000; i++) {
		setText(doc, `file-${i}`, `folder/${i}.md`, `content ${i}`);
	}
	const full = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(full.index?.kind, "full", "large initial snapshot is full");
	assertEqual(full.index?.fullFileCount, 5000, "large full records 5000 live files");

	setText(doc, "file-1234", "folder/1234.md", "content 1234 changed");
	const next = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T01:00:00Z"),
	});
	assertEqual(next.index?.kind, "full", "large follow-up snapshot remains full");
	assertEqual(next.index?.changedCount, 1, "large follow-up changedCount is one");

	const manifest = await getRecoveryManifest(vaultId, next.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(manifest?.entries.length, 5000, "large follow-up full manifest contains all files");
	assert(manifest!.entries.some((entry) => entry.fileId === "file-1234" && entry.kind === "modified"), "large follow-up marks touched file modified");
	assert(manifest!.entries.some((entry) => entry.fileId === "file-1235" && entry.kind === "unchanged"), "large follow-up marks untouched file unchanged");

	doc.destroy();
}

async function testFullManifestCadenceAndPointerOrder(): Promise<void> {
	console.log("\n--- Test 4: forced full manifest and latest pointer order ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-full";

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
	assertEqual(forced.index?.kind, "full", "forceFull creates a full manifest");

	const manifest = await getRecoveryManifest(vaultId, forced.manifestId!, bucket as unknown as R2Bucket);
	assertEqual(manifest?.entries.length, 2, "forced full stores whole file-state manifest");
	assert(manifest!.entries.some((entry) => entry.kind === "unchanged" && entry.fileId === "file-b"), "forced full includes unchanged file state");

	const latestIndexKey = `v2/${vaultId}/recovery/latest-index.json`;
	const latestStateKey = `v2/${vaultId}/recovery/latest-state.json.gz`;
	const manifestPutIndex = bucket.putOrder.findIndex((key) => key.includes(`/recovery/manifests/`) && key.includes(forced.manifestId!));
	const latestStatePutIndex = bucket.putOrder.lastIndexOf(latestStateKey);
	const latestIndexPutIndex = bucket.putOrder.lastIndexOf(latestIndexKey);
	const contentPutIndex = bucket.putOrder.findIndex((key) => key.startsWith(`v2/${vaultId}/recovery/content/`) && key.endsWith(".md.gz"));
	assert(manifestPutIndex >= 0, "forced manifest object was written");
	assert(contentPutIndex >= 0 && contentPutIndex < manifestPutIndex, "content is written before manifest");
	assert(latestStatePutIndex > manifestPutIndex, "latest state is written after manifest");
	assert(latestIndexPutIndex > latestStatePutIndex, "latest pointer is written after manifest and state");
	assert(first.manifestId !== forced.manifestId, "new full manifest has a new id");

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
	console.log("\n--- Test 6: v2 manifest listing is newest-first, bounded, and ignores v1 ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-list";

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
	assert(first.manifestId !== second.manifestId, "test created two distinct manifests");

	await bucket.put(`v1/${vaultId}/recovery/manifests/2026-06-20/legacy.json.gz`, "legacy");
	const listedAfterLegacy = await listRecoveryManifestIndexes(vaultId, bucket as unknown as R2Bucket, 20);
	assertEqual(listedAfterLegacy.totalManifestKeys, 2, "v1 recovery manifest is ignored by v2 listing");

	doc.destroy();
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

async function testLargeFullSnapshotDoesNotCreateBundle(): Promise<void> {
	console.log("\n--- Test 8: large v2 full snapshot stores individual content objects, not bundles ---");
	const bucket = new MemoryR2Bucket();
	const doc = new Y.Doc();
	const vaultId = "recovery-v2-large-full";

	for (let i = 0; i < 600; i++) {
		setText(doc, `file-${i}`, `notes/${i}.md`, `content ${i}`);
	}

	const first = await createRecoverySnapshot(doc, vaultId, bucket as unknown as R2Bucket, {
		now: new Date("2026-06-20T00:00:00Z"),
	});
	assertEqual(first.status, "created", "large initial full snapshot is created");
	assertEqual(first.index?.kind, "full", "large initial snapshot is full");

	const hash = await hashText("content 542");
	assert(await bucket.head(recoveryContentKey(vaultId, hash)) !== null, "large v2 full writes individual content object");
	assert(!bucket.putOrder.some((key) => key.includes("/recovery/content-bundles/")), "large v2 full does not create content bundle");
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
	manifest!.entries[0]!.path = "tampered.md";
	await bucket.put(
		`v2/${vaultId}/recovery/manifests/${created.manifestId}.json.gz`,
		gzipSync(new TextEncoder().encode(JSON.stringify(manifest))),
	);
	assert(await getRecoveryManifest(vaultId, created.manifestId!, bucket as unknown as R2Bucket) === null, "manifest hash mismatch is rejected");

	doc.destroy();
}

await testStandaloneFullManifestWithChangedCount();
await testRenameDeleteAndChainReconstruction();
await testNestedV3MetaIsSnapshotted();
await testLargeVaultFullManifestUsesContentDedupe();
await testFullManifestCadenceAndPointerOrder();
await testContentHashVerification();
await testListIsNewestFirst();
await testRetentionPrunesOnlyV2AndGcContent();
await testLargeFullSnapshotDoesNotCreateBundle();
await testTamperedManifestIsRejected();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
