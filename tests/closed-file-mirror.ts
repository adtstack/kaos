/**
 * Integration test: verifies closed-file remote mirroring works.
 *
 * Reproduces the plugin's DiskMirror observer architecture (map observers,
 * afterTransaction handler, per-file Y.Text observers) using two Y.Docs
 * synced via Y.applyUpdate. No server needed.
 *
 * Tests:
 *   1. Remote edit to an "open" file   → detected via per-file Y.Text observer
 *   2. Remote edit to a "closed" file  → detected via afterTransaction handler
 *   3. Local edit to a closed file     → NOT detected (origin filtering works)
 *   4. Remote structural op (new file) → detected via pathToId map observer
 *   5. Remote delete                   → detected via meta map observer
 *
 * Usage: bun run test-closed-file-mirror.ts
 */
import * as Y from "yjs";

const ORIGIN_SEED = "vault-crdt-seed";
const LOCAL_ORIGINS = new Set(["y-codemirror.next", ORIGIN_SEED, "disk-sync"]);

// ── Tracking ────────────────────────────────────────────────────────────
// Instead of actual disk I/O, we record what DiskMirror would have done.
const scheduledWrites: string[] = [];
const scheduledDeletes: string[] = [];

function scheduleWrite(path: string) {
	scheduledWrites.push(path);
}
function scheduleDelete(path: string) {
	scheduledDeletes.push(path);
}
function resetTracking() {
	scheduledWrites.length = 0;
	scheduledDeletes.length = 0;
}

// ── Device A: "plugin" ─────────────────────────────────────────────────
const docA = new Y.Doc();
const pathToIdA = docA.getMap<string>("pathToId");
const idToTextA = docA.getMap<Y.Text>("idToText");
const metaA = docA.getMap<{ path: string; deleted?: boolean; mtime?: number }>(
	"meta",
);

// Track which files have per-file Y.Text observers ("open" files)
const textObservers = new Set<string>();

// ── Seed two files ──────────────────────────────────────────────────────
docA.transact(() => {
	const id1 = "file-open-001";
	const text1 = new Y.Text();
	text1.insert(0, "# Open file\n\nOriginal content.");
	pathToIdA.set("open-file.md", id1);
	idToTextA.set(id1, text1);
	metaA.set(id1, { path: "open-file.md", mtime: Date.now() });

	const id2 = "file-closed-002";
	const text2 = new Y.Text();
	text2.insert(0, "# Closed file\n\nOriginal content.");
	pathToIdA.set("closed-file.md", id2);
	idToTextA.set(id2, text2);
	metaA.set(id2, { path: "closed-file.md", mtime: Date.now() });
}, ORIGIN_SEED);

// ── Set up observers (mirrors DiskMirror exactly) ───────────────────────

// 1. pathToId map observer — structural: new files, renames
pathToIdA.observe((event) => {
	event.changes.keys.forEach((change, path) => {
		if (change.action === "add" || change.action === "update") {
			if (!LOCAL_ORIGINS.has(event.transaction.origin as string)) {
				scheduleWrite(path);
			}
		}
		if (change.action === "delete") {
			textObservers.delete(path);
			if (!LOCAL_ORIGINS.has(event.transaction.origin as string)) {
				scheduleDelete(path);
			}
		}
	});
});

// 2. meta map observer — remote deletes via tombstone
metaA.observe((event) => {
	event.changes.keys.forEach((change, fileId) => {
		if (change.action === "add" || change.action === "update") {
			const meta = metaA.get(fileId);
			if (
				meta?.deleted &&
				!LOCAL_ORIGINS.has(event.transaction.origin as string)
			) {
				scheduleDelete(meta.path);
			}
		}
	});
});

// 3. afterTransaction handler — catches remote Y.Text edits to CLOSED files
//    This is the fix at diskMirror.ts:112-138.
function findFileIdForText(ytext: Y.Text): string | null {
	for (const [fileId, text] of idToTextA.entries()) {
		if (text === ytext) return fileId;
	}
	return null;
}

docA.on("afterTransaction", (txn: Y.Transaction) => {
	if (LOCAL_ORIGINS.has(txn.origin as string)) return;

	for (const [changedType] of txn.changed) {
		if (!(changedType instanceof Y.Text)) continue;

		const fileId = findFileIdForText(changedType);
		if (!fileId) continue;

		const meta = metaA.get(fileId);
		if (!meta || meta.deleted) continue;

		const path = meta.path;

		// Skip if this path has a per-file text observer (open file)
		if (textObservers.has(path)) continue;

		scheduleWrite(path);
	}
});

// 4. Per-file Y.Text observer — ONLY for the "open" file
function observeText(path: string) {
	const fileId = pathToIdA.get(path);
	if (!fileId) return;
	const ytext = idToTextA.get(fileId);
	if (!ytext) return;

	ytext.observe((_event, txn) => {
		if (LOCAL_ORIGINS.has(txn.origin as string)) return;
		scheduleWrite(path);
	});
	textObservers.add(path);
}

observeText("open-file.md");
// NOTE: No observeText("closed-file.md") — simulates a closed file

// ── Device B: "remote device" ───────────────────────────────────────────
const docB = new Y.Doc();

// Sync initial state A → B
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

// Wire up bidirectional sync (simulates WebSocket provider)
docB.on("update", (update: Uint8Array) => {
	Y.applyUpdate(docA, update);
});

const pathToIdB = docB.getMap<string>("pathToId");
const idToTextB = docB.getMap<Y.Text>("idToText");
const metaB = docB.getMap<{ path: string; deleted?: boolean; mtime?: number }>(
	"meta",
);

// ── Test helpers ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

// ── Test 1: remote edit to OPEN file ────────────────────────────────────
console.log("\n--- Test 1: remote edit to open file ---");
resetTracking();

const openIdB = pathToIdB.get("open-file.md")!;
const openTextB = idToTextB.get(openIdB)!;
openTextB.insert(openTextB.length, "\n\nRemote edit to open file.");

assert(
	scheduledWrites.includes("open-file.md"),
	"open file: write scheduled via Y.Text observer",
);

// Verify CRDT state actually merged on A
const openTextA = idToTextA.get(pathToIdA.get("open-file.md")!)!;
assert(
	openTextA.toString().includes("Remote edit to open file."),
	"open file: CRDT content merged on Device A",
);

// ── Test 2: remote edit to CLOSED file ──────────────────────────────────
console.log("\n--- Test 2: remote edit to closed file ---");
resetTracking();

const closedIdB = pathToIdB.get("closed-file.md")!;
const closedTextB = idToTextB.get(closedIdB)!;
closedTextB.insert(closedTextB.length, "\n\nRemote edit to closed file.");

assert(
	scheduledWrites.includes("closed-file.md"),
	"closed file: write scheduled via afterTransaction handler",
);

// Verify CRDT state merged but NO per-file observer fired
const closedTextA = idToTextA.get(pathToIdA.get("closed-file.md")!)!;
assert(
	closedTextA.toString().includes("Remote edit to closed file."),
	"closed file: CRDT content merged on Device A",
);
assert(
	!textObservers.has("closed-file.md"),
	"closed file: no per-file Y.Text observer attached (still closed)",
);

// ── Test 3: LOCAL edit to closed file → should NOT schedule write ────────
console.log("\n--- Test 3: local edit (origin filtering) ---");
resetTracking();

// Simulate a local disk-sync write (e.g., syncFileFromDisk)
const closedTextA2 = idToTextA.get(pathToIdA.get("closed-file.md")!)!;
docA.transact(() => {
	closedTextA2.insert(closedTextA2.length, "\n\nLocal disk-sync edit.");
}, "disk-sync");

assert(
	!scheduledWrites.includes("closed-file.md"),
	'local disk-sync origin: no write scheduled (correctly filtered)',
);

// Also test y-codemirror.next origin
docA.transact(() => {
	closedTextA2.insert(closedTextA2.length, "\n\nLocal CM edit.");
}, "y-codemirror.next");

assert(
	!scheduledWrites.includes("closed-file.md"),
	'local y-codemirror.next origin: no write scheduled (correctly filtered)',
);

// ── Test 4: remote new file → detected via map observer ─────────────────
console.log("\n--- Test 4: remote new file creation ---");
resetTracking();

docB.transact(() => {
	const id = "file-new-003";
	const text = new Y.Text();
	text.insert(0, "# Brand new file from remote");
	pathToIdB.set("new-remote-file.md", id);
	idToTextB.set(id, text);
	metaB.set(id, { path: "new-remote-file.md", mtime: Date.now() });
});

assert(
	scheduledWrites.includes("new-remote-file.md"),
	"new file: write scheduled via pathToId map observer",
);

// ── Test 5: remote delete → detected via meta observer ──────────────────
console.log("\n--- Test 5: remote delete (tombstone) ---");
resetTracking();

docB.transact(() => {
	const fileId = pathToIdB.get("new-remote-file.md")!;
	pathToIdB.delete("new-remote-file.md");
	metaB.set(fileId, {
		path: "new-remote-file.md",
		deleted: true,
		mtime: Date.now(),
	});
});

assert(
	scheduledDeletes.includes("new-remote-file.md"),
	"delete: scheduled via pathToId delete + meta tombstone",
);

// ── Test 6: verify afterTransaction doesn't double-fire for open files ──
console.log("\n--- Test 6: no double-fire for open files ---");
resetTracking();

const openTextB2 = idToTextB.get(pathToIdB.get("open-file.md")!)!;
openTextB2.insert(openTextB2.length, "\n\nAnother remote edit.");

// The per-file observer fires (1 write), afterTransaction skips it
// because textObservers.has("open-file.md") is true.
const openFileWrites = scheduledWrites.filter((p) => p === "open-file.md");
assert(
	openFileWrites.length === 1,
	"open file: exactly 1 write (Y.Text observer only, afterTransaction skipped)",
);

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

docA.destroy();
docB.destroy();

process.exit(failed > 0 ? 1 : 0);
