import * as Y from "yjs";
import {
	evaluatePathBindingIntegrity,
	type PathBindingIntegrityStatus,
} from "../src/sync/pathBindingIntegrity";
import { createNestedActiveMeta } from "../src/sync/fileMeta";
import { VaultSync } from "../src/sync/vaultSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function makeVaultSync(): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	vs.ydoc = new Y.Doc();
	vs.pathToId = vs.ydoc.getMap("pathToId");
	vs.idToText = vs.ydoc.getMap("idToText");
	vs.meta = vs.ydoc.getMap("meta");
	vs.sys = vs.ydoc.getMap("sys");
	vs.pathToBlob = vs.ydoc.getMap("pathToBlob");
	vs.blobMeta = vs.ydoc.getMap("blobMeta");
	vs.blobTombstones = vs.ydoc.getMap("blobTombstones");
	vs._textToFileId = new WeakMap();
	vs._pathIndex = new Map();
	vs._deletedPathIndex = new Set();
	vs._activePathCollisions = new Map();
	vs._pathIndexesDirty = true;
	vs.sys.set("schemaVersion", 3);
	vs._eventRing = [];
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightPathEvent = undefined;
	vs._device = "TestDevice";
	return vs as VaultSync;
}

console.log("\n--- Path binding integrity: pure duplicate-active-path classification ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Folder/note.md",
		activeFileIdsForPath: ["id-a", "id-b"],
		fileId: "id-a",
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"duplicate-active-path",
		"multiple active fileIds for one path are not ok",
	);
	assert(result.shouldBlockCrdtFlush, "duplicate active path blocks CRDT flush");
}

console.log("\n--- Path binding integrity: pure no-evidence structural rename classification ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "same",
		crdtHash: "same",
		baselineHash: null,
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"ambiguous-structural-rename",
		"same content and basename are ambiguous without rename evidence",
	);
	assert(result.shouldPreserve, "ambiguous structural rename preserves instead of applying");
}

console.log("\n--- Path binding integrity: missing baseline with divergent content is high risk ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "disk-content",
		crdtHash: "crdt-content",
		baselineHash: null,
		renameEvidence: "none",
	});
	assertEq<PathBindingIntegrityStatus>(
		result.status,
		"missing-baseline-risk",
		"divergent content without a baseline is not hidden by ambiguous rename classification",
	);
	assert(result.shouldPreserve, "missing baseline risk preserves instead of applying");
}

console.log("\n--- Path binding integrity: explicit rename evidence remains ok ---");
{
	const result = evaluatePathBindingIntegrity({
		path: "Old/note.md",
		candidatePath: "New/note.md",
		activeFileIdsForPath: ["id-a"],
		fileId: "id-a",
		diskHash: "same",
		crdtHash: "same",
		baselineHash: null,
		renameEvidence: "explicit-rename",
	});
	assertEq<PathBindingIntegrityStatus>(result.status, "ok", "explicit rename evidence allows path movement");
	assert(!result.shouldBlockCrdtFlush, "ok binding does not block CRDT flush");
}

console.log("\n--- VaultSync path index: duplicate active path has no silent winner ---");
{
	const vs = makeVaultSync();
	const textA = new Y.Text();
	const textB = new Y.Text();
	textA.insert(0, "A");
	textB.insert(0, "B");
	vs.idToText.set("id-a", textA);
	vs.idToText.set("id-b", textB);
	vs.meta.set("id-a", createNestedActiveMeta("Shared/path.md", 10, "A"));
	vs.meta.set("id-b", createNestedActiveMeta("Shared/path.md", 20, "B"));

	assertEq(vs.getFileId("Shared/path.md"), undefined, "collided path is not mapped to newest fileId");
	assertEq(vs.getTextForPath("Shared/path.md"), null, "collided path cannot return arbitrary Y.Text");
	assertEq(vs.getActiveFileIdsForPath("Shared/path.md").join(","), "id-a,id-b", "collision exposes both fileIds");

	const integrity = vs.runIntegrityChecks();
	assertEq(integrity.duplicateActivePaths, 1, "integrity reports duplicate active path");
	assertEq(integrity.orphansCleaned, 0, "collided active fileIds are preserved, not garbage-collected");
}

console.log("\n--- VaultSync reconcile: duplicate active path is not seeded as a new file ---");
{
	const vs = makeVaultSync();
	const textA = new Y.Text();
	const textB = new Y.Text();
	textA.insert(0, "A");
	textB.insert(0, "B");
	vs.idToText.set("id-a", textA);
	vs.idToText.set("id-b", textB);
	vs.meta.set("id-a", createNestedActiveMeta("Shared/path.md", 10, "A"));
	vs.meta.set("id-b", createNestedActiveMeta("Shared/path.md", 20, "B"));

	const result = vs.reconcileVault(
		new Map([["Shared/path.md", "disk"]]),
		new Set(["Shared/path.md"]),
		"authoritative",
		"TestDevice",
	);

	assertEq(result.seededToCrdt.length, 0, "collided disk path is not seeded");
	assertEq(result.pathBindingConflicts[0], "Shared/path.md", "collision is reported in reconcile result");
	assertEq(vs.idToText.size, 2, "no third fileId is created for the collided path");
	assertEq(vs.getActiveFileIdsForPath("Shared/path.md").join(","), "id-a,id-b", "original collided ids are preserved");
}

console.log("\n--- VaultSync reconcile: excluded CRDT paths are not restored to disk ---");
{
	const vs = makeVaultSync();
	const hiddenText = new Y.Text();
	hiddenText.insert(0, "hidden");
	const visibleText = new Y.Text();
	visibleText.insert(0, "visible");
	vs.idToText.set("hidden", hiddenText);
	vs.idToText.set("visible", visibleText);
	vs.meta.set("hidden", createNestedActiveMeta(".obsidian-mobile/plugins/example/README.md", 10, "A"));
	vs.meta.set("visible", createNestedActiveMeta("notes/visible.md", 10, "A"));

	const result = vs.reconcileVault(
		new Map(),
		new Set(),
		"authoritative",
		"TestDevice",
		undefined,
		(path) => !path.split("/").some((part) => part.startsWith(".")),
	);

	assertEq(result.createdOnDisk.join(","), "notes/visible.md", "excluded CRDT path is not scheduled for disk creation");
	assertEq(vs.getTextForPath(".obsidian-mobile/plugins/example/README.md")?.toString(), "hidden", "excluded CRDT data is retained without writing it");
}

console.log(`\npath-binding-integrity: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
