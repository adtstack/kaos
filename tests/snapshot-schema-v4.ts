import assert from "node:assert/strict";
import * as Y from "yjs";
import { diffSnapshot, restoreFromSnapshot } from "../src/sync/snapshotClient";
import {
	createNestedActiveMeta,
	createNestedDeletedMeta,
	decodeFileMeta,
	isFileMetaDeletedValue,
	isNestedFileMeta,
} from "../src/sync/fileMeta";

console.log("=== Testing Snapshot Diff & Restore with Schema v4 (Nested Y.Map) ===");

// 1. Setup Snapshot Doc with Schema v4
const snapshotDoc = new Y.Doc();
snapshotDoc.getMap("sys").set("schemaVersion", 4);
snapshotDoc.getMap("sys").set("initialized", true);

const snapMeta = snapshotDoc.getMap("meta");
const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
const snapPathToId = snapshotDoc.getMap<string>("pathToId");

function addFileToDoc(doc: Y.Doc, path: string, content: string, fileId: string, mtime = 1000) {
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, content);
		doc.getMap<Y.Text>("idToText").set(fileId, text);
		doc.getMap<string>("pathToId").set(path, fileId);
		doc.getMap("meta").set(fileId, createNestedActiveMeta(path, mtime, "device-a"));
	});
}

addFileToDoc(snapshotDoc, "notes/unchanged.md", "# Unchanged", "id-unchanged", 1000);
addFileToDoc(snapshotDoc, "notes/modified.md", "# Original Content", "id-modified", 1000);
addFileToDoc(snapshotDoc, "notes/deleted.md", "# To Be Deleted", "id-deleted", 1000);

// 2. Setup Live Doc initialized from Snapshot state
const liveDoc = new Y.Doc();
Y.applyUpdate(liveDoc, Y.encodeStateAsUpdate(snapshotDoc));

// 3. Mutate Live Doc (time passes)
const liveMeta = liveDoc.getMap("meta");
const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
const livePathToId = liveDoc.getMap<string>("pathToId");

liveDoc.transact(() => {
	// A. Modify notes/modified.md
	const modText = liveIdToText.get("id-modified")!;
	modText.delete(0, modText.length);
	modText.insert(0, "# Changed Content");
	liveMeta.set("id-modified", createNestedActiveMeta("notes/modified.md", 2000, "device-b"));

	// B. Delete notes/deleted.md
	liveMeta.set("id-deleted", createNestedDeletedMeta("notes/deleted.md", 2000, "device-b"));
	livePathToId.delete("notes/deleted.md");

	// C. Create new file notes/new.md
	const newText = new Y.Text();
	newText.insert(0, "# Brand New File");
	liveIdToText.set("id-new", newText);
	livePathToId.set("notes/new.md", "id-new");
	liveMeta.set("id-new", createNestedActiveMeta("notes/new.md", 2000, "device-b"));
});

// 4. Run diffSnapshot
console.log("--- Step 1: diffSnapshot on Schema v4 doc ---");
const diff = diffSnapshot(snapshotDoc, liveDoc);

console.log("Diff results:", {
	contentChanged: diff.contentChanged.map((c) => c.path),
	deletedSinceSnapshot: diff.deletedSinceSnapshot.map((d) => d.path),
	createdSinceSnapshot: diff.createdSinceSnapshot,
	unchanged: diff.unchanged,
});

assert.equal(diff.contentChanged.length, 1, "Exactly 1 modified file detected");
assert.equal(diff.contentChanged[0].path, "notes/modified.md");
assert.equal(diff.contentChanged[0].snapshotContent, "# Original Content");
assert.equal(diff.contentChanged[0].currentContent, "# Changed Content");

assert.equal(diff.deletedSinceSnapshot.length, 1, "Exactly 1 deleted file detected");
assert.equal(diff.deletedSinceSnapshot[0].path, "notes/deleted.md");

assert.equal(diff.createdSinceSnapshot.length, 1, "Exactly 1 created file detected");
assert.equal(diff.createdSinceSnapshot[0], "notes/new.md");

assert.equal(diff.unchanged.length, 1, "Exactly 1 unchanged file detected");
assert.equal(diff.unchanged[0], "notes/unchanged.md");
console.log("  PASS: diffSnapshot correctly resolved all Schema v4 file states!");

// 5. Test restoreFromSnapshot
console.log("--- Step 2: restoreFromSnapshot on Schema v4 doc ---");
const retirements = liveDoc.getMap("markdownPathRetirements");
for (const path of ["notes/modified.md", "notes/deleted.md", "notes/unselected.md"]) {
	retirements.set(`previous:${path}`, {fileId: `previous:${path}`, oldPath: path, operationId: path, movedTo: "archive/note.md", movedAt: 1});
}
const restoreResult = restoreFromSnapshot(snapshotDoc, liveDoc, {
	markdownPaths: ["notes/modified.md", "notes/deleted.md"],
	device: "device-restore",
});

assert(!retirements.has("previous:notes/modified.md") && !retirements.has("previous:notes/deleted.md"), "explicit snapshot restore clears selected path retirements");
assert(retirements.has("previous:notes/unselected.md"), "snapshot restore leaves unrelated move records intact");
assert.equal(restoreResult.markdownRestored, 1, "1 markdown file content restored");
assert.equal(restoreResult.markdownUndeleted, 1, "1 markdown file undeleted");
assert.equal(restoreResult.markdownRejected.length, 0, "No markdown files rejected");

// Verify modified.md content restored
assert.equal(
	liveIdToText.get("id-modified")?.toString(),
	"# Original Content",
	"modified.md text reverted to snapshot content",
);
const modifiedMetaEntry = liveMeta.get("id-modified");
assert(isNestedFileMeta(modifiedMetaEntry), "modified.md meta entry is nested Y.Map");
const decodedMod = decodeFileMeta(modifiedMetaEntry);
assert.equal(decodedMod?.path, "notes/modified.md");
assert.equal(isFileMetaDeletedValue(modifiedMetaEntry), false);

// Verify deleted.md undeleted
assert.equal(
	liveIdToText.get("id-deleted")?.toString(),
	"# To Be Deleted",
	"deleted.md text restored to snapshot content",
);
const deletedMetaEntry = liveMeta.get("id-deleted");
assert(isNestedFileMeta(deletedMetaEntry), "deleted.md meta entry is nested Y.Map");
const decodedDel = decodeFileMeta(deletedMetaEntry);
assert.equal(decodedDel?.path, "notes/deleted.md");
assert.equal(isFileMetaDeletedValue(deletedMetaEntry), false);

console.log("  PASS: restoreFromSnapshot successfully restored content and preserved Schema v4 nested Y.Maps!");
console.log("=== All Schema v4 snapshot tests passed! ===");
