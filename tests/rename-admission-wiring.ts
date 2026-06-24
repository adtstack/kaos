/**
 * Wiring integration tests for rename admission.
 *
 * Tests planCategoryRenameAction — the same pure function called by main.ts —
 * and verifies the execution switch handles all action kinds correctly.
 *
 * This exercises the actual planner used in production, not a copy.
 */

import { classifySyncPath } from "../src/paths/pathCategory";
import { planCategoryRenameAction } from "../src/sync/policy/renameAdmissionPolicy";
import type { RenameAction } from "../src/sync/policy/renameAdmissionPolicy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

const EXCLUDE = ["templates/"];
const CONFIG = ".obsidian";

function plan(oldPath: string, newPath: string): RenameAction {
	const oldCategory = classifySyncPath({ path: oldPath, excludePatterns: EXCLUDE, configDir: CONFIG });
	const newCategory = classifySyncPath({ path: newPath, excludePatterns: EXCLUDE, configDir: CONFIG });
	return planCategoryRenameAction({ oldCategory, newCategory });
}

/**
 * Simulate execution — mirrors the switch in main.ts.
 * Returns which "API calls" would have been made.
 */
function simulateExecution(action: RenameAction) {
	const calls: string[] = [];

	switch (action.kind) {
		case "queue-markdown-rename":
			calls.push(`queueRename(${action.oldPath}, ${action.newPath})`);
			break;
		case "queue-blob-rename":
			calls.push(`queueRename(${action.oldPath}, ${action.newPath})`);
			break;
		case "tombstone-markdown":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`handleDelete(${action.oldPath})`);
			break;
		case "admit-markdown":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`markMarkdownDirty(${action.newPath})`);
			break;
		case "admit-blob-via-event":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`[no-op: blob admitted via create event]`);
			break;
		case "defer-blob-to-events":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`[no-op: blob deferred to delete event]`);
			break;
		case "same-identity":
			calls.push(`[no-op: same canonical identity]`);
			break;
		case "ignore":
			break;
	}
	return calls;
}

console.log("\n--- Test 1: markdown rename => queueRename called ---");
{
	const action = plan("notes/a.md", "notes/b.md");
	const calls = simulateExecution(action);
	assert(calls.length === 1, "one call made");
	assert(calls[0]!.startsWith("queueRename"), "queueRename called");
	assert(calls[0]!.includes("notes/a.md"), "uses old displayPath");
	assert(calls[0]!.includes("notes/b.md"), "uses new displayPath");
}

console.log("\n--- Test 2: markdown -> excluded => handleDelete + dropDirty ---");
{
	const action = plan("notes/a.md", ".trash/a.md");
	const calls = simulateExecution(action);
	assert(calls.some((c) => c.includes("handleDelete")), "handleDelete called");
	assert(calls.some((c) => c === "dropDirtyPath(notes/a.md)"), "drops old dirty");
	assert(calls.some((c) => c === "dropDirtyPath(.trash/a.md)"), "drops new dirty");
	assert(!calls.some((c) => c.startsWith("queueRename")), "queueRename NOT called");
}

console.log("\n--- Test 3: excluded -> markdown => markMarkdownDirty + dropDirty ---");
{
	const action = plan(".trash/a.md", "notes/a.md");
	const calls = simulateExecution(action);
	assert(calls.some((c) => c.includes("markMarkdownDirty")), "markMarkdownDirty called");
	assert(calls.some((c) => c === "dropDirtyPath(.trash/a.md)"), "drops excluded old dirty");
	assert(!calls.some((c) => c.startsWith("queueRename")), "queueRename NOT called");
	assert(!calls.some((c) => c.includes("handleDelete")), "handleDelete NOT called");
}

console.log("\n--- Test 4: excluded -> excluded => nothing ---");
{
	const action = plan(".trash/a.md", "templates/a.md");
	const calls = simulateExecution(action);
	assert(calls.length === 0, "no calls for ignore");
}

console.log("\n--- Test 5: blob rename => queueRename ---");
{
	const action = plan("assets/a.png", "assets/b.png");
	const calls = simulateExecution(action);
	assert(calls.length === 1, "one call");
	assert(calls[0]!.startsWith("queueRename"), "queueRename for blob");
}

console.log("\n--- Test 6: blob -> excluded => deferred to events ---");
{
	const action = plan("assets/a.png", ".trash/a.png");
	const calls = simulateExecution(action);
	assert(calls.some((c) => c.includes("deferred to delete event")), "deferred to events");
	assert(!calls.some((c) => c.includes("handleDelete")), "handleDelete NOT called (not markdown)");
}

console.log("\n--- Test 7: NFC -> NFD = same-identity, no mutation ---");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const action = plan(nfc, nfd);
	const calls = simulateExecution(action);
	assert(calls.length === 1, "one no-op call");
	assert(calls[0]!.includes("same canonical identity"), "recognized as same identity");
}

console.log("\n--- Test 8: cross-category markdown -> blob => tombstone markdown ---");
{
	const action = plan("notes/file.md", "assets/file.png");
	const calls = simulateExecution(action);
	assert(calls.some((c) => c.includes("handleDelete(notes/file.md)")), "tombstones markdown displayPath");
	assert(!calls.some((c) => c.startsWith("queueRename")), "does NOT queue rename");
}

console.log("\n--- Test 9: cross-category blob -> markdown => admit markdown ---");
{
	const action = plan("assets/note.png", "notes/note.md");
	const calls = simulateExecution(action);
	assert(calls.some((c) => c.includes("markMarkdownDirty(notes/note.md)")), "admits markdown");
	assert(calls.some((c) => c === "dropDirtyPath(assets/note.png)"), "drops old blob dirty");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
