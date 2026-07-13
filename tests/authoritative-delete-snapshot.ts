import * as Y from "yjs";
import {
	createNestedActiveMeta,
	createNestedDeletedMeta,
} from "../src/sync/fileMeta";
import { VaultSync } from "../src/sync/vaultSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(
		`  FAIL  ${message}\n        expected=${String(expected)}\n        actual=${String(actual)}`,
	);
	failed++;
}

function makeVaultSync(): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	const ydoc = new Y.Doc();
	vs.ydoc = ydoc;
	vs.meta = ydoc.getMap("meta");
	vs.pathToBlob = ydoc.getMap("pathToBlob");
	vs.blobTombstones = ydoc.getMap("blobTombstones");
	return vs;
}

const markdownPath = "notes/deleted.md";

console.log("\n--- Authoritative Markdown delete snapshot: deterministic tombstone set ---");
{
	const first = makeVaultSync();
	first.meta.set("id-z", {
		path: markdownPath,
		deletedAt: 200,
		device: "phone",
	});
	first.meta.set("id-a", {
		path: markdownPath,
		deleted: true,
		device: "desktop",
	});

	const second = makeVaultSync();
	second.meta.set("id-a", {
		path: markdownPath,
		deleted: true,
		device: "desktop",
	});
	second.meta.set("id-z", {
		path: markdownPath,
		deletedAt: 200,
		device: "phone",
	});

	const firstSnapshot = first.getAuthoritativeMarkdownDeleteSnapshot(markdownPath);
	const secondSnapshot = second.getAuthoritativeMarkdownDeleteSnapshot(markdownPath);

	assert(firstSnapshot !== null, "a tombstone-only Markdown path has an authoritative snapshot");
	assertEqual(
		firstSnapshot?.tombstones.map(({ fileId }) => fileId).join(","),
		"id-a,id-z",
		"Markdown tombstones are sorted by fileId",
	);
	assertEqual(
		firstSnapshot?.fingerprint,
		JSON.stringify([
			"markdown",
			markdownPath,
			[
				["id-a", null, "desktop"],
				["id-z", 200, "phone"],
			],
		]),
		"fingerprint includes each tombstone's ID, deletedAt, and device",
	);
	assertEqual(
		firstSnapshot?.fingerprint,
		secondSnapshot?.fingerprint,
		"map insertion order does not affect the Markdown fingerprint",
	);
}

console.log("\n--- Authoritative Markdown delete snapshot: active entries always win ---");
{
	const singleActive = makeVaultSync();
	singleActive.meta.set("stale-delete", {
		path: markdownPath,
		deletedAt: 100,
		device: "old-device",
	});
	singleActive.meta.set("live", createNestedActiveMeta(markdownPath, 300, "new-device"));
	assertEqual(
		singleActive.getAuthoritativeMarkdownDeleteSnapshot(markdownPath),
		null,
		"one live fileId rejects a stale Markdown tombstone",
	);

	const collision = makeVaultSync();
	collision.meta.set("stale-delete", createNestedDeletedMeta(markdownPath, 100));
	collision.meta.set("live-a", createNestedActiveMeta(markdownPath, 300, "A"));
	collision.meta.set("live-b", createNestedActiveMeta(markdownPath, 400, "B"));
	assertEqual(
		collision.getAuthoritativeMarkdownDeleteSnapshot(markdownPath),
		null,
		"a duplicate-active collision rejects the Markdown delete snapshot",
	);
}

console.log("\n--- Authoritative Markdown delete snapshot: episode changes are visible ---");
{
	const vs = makeVaultSync();
	vs.meta.set("deleted-id", {
		path: markdownPath,
		deletedAt: 100,
		device: "A",
	});
	const before = vs.getAuthoritativeMarkdownDeleteSnapshot(markdownPath);

	vs.meta.set("deleted-id", {
		path: markdownPath,
		deletedAt: 101,
		device: "B",
	});
	const after = vs.getAuthoritativeMarkdownDeleteSnapshot(markdownPath);

	assert(before !== null && after !== null, "both Markdown delete episodes produce snapshots");
	assert(
		before?.fingerprint !== after?.fingerprint,
		"deletedAt/device changes produce a different Markdown fingerprint",
	);
	assertEqual(
		vs.getAuthoritativeMarkdownDeleteSnapshot("notes/active.md"),
		null,
		"a path with neither tombstones nor active entries has no delete snapshot",
	);
}

const blobPath = "attachments/deleted.png";

console.log("\n--- Authoritative blob delete snapshot: live references always win ---");
{
	const vs = makeVaultSync();
	vs.blobTombstones.set(blobPath, { deletedAt: 500, device: "phone" });

	const snapshot = vs.getAuthoritativeBlobDeleteSnapshot(blobPath);
	assert(snapshot !== null, "a tombstone-only blob path has an authoritative snapshot");
	assertEqual(snapshot?.deletedAt, 500, "blob snapshot exposes deletedAt");
	assertEqual(snapshot?.device, "phone", "blob snapshot exposes device");
	assertEqual(
		snapshot?.fingerprint,
		JSON.stringify(["blob", blobPath, 500, "phone"]),
		"blob fingerprint covers the current tombstone",
	);

	vs.pathToBlob.set(blobPath, { hash: "live-hash", size: 42 });
	assertEqual(
		vs.getAuthoritativeBlobDeleteSnapshot(blobPath),
		null,
		"a live blob ref rejects a stale blob tombstone",
	);
}

console.log("\n--- Authoritative blob delete snapshot: episode changes are visible ---");
{
	const vs = makeVaultSync();
	vs.blobTombstones.set(blobPath, { deletedAt: 500, device: "A" });
	const before = vs.getAuthoritativeBlobDeleteSnapshot(blobPath);
	vs.blobTombstones.set(blobPath, { deletedAt: 501, device: "B" });
	const after = vs.getAuthoritativeBlobDeleteSnapshot(blobPath);

	assert(before !== null && after !== null, "both blob delete episodes produce snapshots");
	assert(
		before?.fingerprint !== after?.fingerprint,
		"deletedAt/device changes produce a different blob fingerprint",
	);
	assertEqual(
		vs.getAuthoritativeBlobDeleteSnapshot("attachments/active.png"),
		null,
		"a blob path without a tombstone has no delete snapshot",
	);
}

console.log(`\nauthoritative-delete-snapshot: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
