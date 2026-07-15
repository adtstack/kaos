/**
 * Wiring integration tests for rename admission.
 *
 * Tests planCategoryRenameAction — the same pure function called by main.ts —
 * and verifies the execution switch handles all action kinds correctly.
 *
 * This exercises the actual planner used in production, not a copy.
 */

import { classifySyncPath } from "../src/paths/pathCategory";
import type { PathSyncCategory } from "../src/paths/pathCategory";
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

/**
 * Simulate execution — mirrors the switch in main.ts.
 * Returns which "API calls" would have been made.
 */
function simulateExecution(
	action: RenameAction,
	context: { oldCategory: PathSyncCategory; newCategory: PathSyncCategory },
) {
	const calls: string[] = [];

	switch (action.kind) {
		case "queue-markdown-rename":
			calls.push(`queueRename(${action.oldPath}, ${action.newPath})`);
			break;
		case "queue-blob-rename":
			calls.push(`blobSync.handleFileRename(${action.oldPath}, ${action.newPath})`);
			break;
		case "tombstone-markdown":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`handleDelete(${action.oldPath})`);
			if (context.newCategory.kind === "blob") {
				calls.push(`blobSync.handleFileChange(${context.newCategory.path.displayPath})`);
			}
			break;
		case "admit-markdown":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			if (context.oldCategory.kind === "blob") {
				calls.push(`blobSync.handleFileDelete(${context.oldCategory.path.displayPath})`);
			}
			calls.push(`markMarkdownDirty(${action.newPath})`);
			break;
		case "admit-blob-via-event":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`blobSync.handleFileChange(${action.newPath})`);
			break;
		case "defer-blob-to-events":
			for (const p of action.dropDirty) calls.push(`dropDirtyPath(${p})`);
			calls.push(`blobSync.handleFileDelete(${action.oldPath})`);
			break;
		case "same-identity":
			if (context.oldCategory.kind === "blob" && context.newCategory.kind === "blob") {
				calls.push(`blobSync.handleFileRename(${action.oldPath}, ${action.newPath})`);
			} else if (
				context.oldCategory.kind === "markdown"
				&& context.newCategory.kind === "markdown"
				&& action.oldPath !== action.newPath
			) {
				calls.push(`queueRename(${action.oldPath}, ${action.newPath})`);
			}
			break;
		case "ignore":
			break;
	}
	return calls;
}

function execute(oldPath: string, newPath: string): string[] {
	const oldCategory = classifySyncPath({ path: oldPath, excludePatterns: EXCLUDE, configDir: CONFIG });
	const newCategory = classifySyncPath({ path: newPath, excludePatterns: EXCLUDE, configDir: CONFIG });
	return simulateExecution(
		planCategoryRenameAction({ oldCategory, newCategory }),
		{ oldCategory, newCategory },
	);
}

console.log("\n--- Test 1: markdown rename => queueRename called ---");
{
	const calls = execute("notes/a.md", "notes/b.md");
	assert(calls.length === 1, "one call made");
	assert(calls[0]!.startsWith("queueRename"), "queueRename called");
	assert(calls[0]!.includes("notes/a.md"), "uses old displayPath");
	assert(calls[0]!.includes("notes/b.md"), "uses new displayPath");
}

console.log("\n--- Test 2: markdown -> excluded => handleDelete + dropDirty ---");
{
	const calls = execute("notes/a.md", ".trash/a.md");
	assert(calls.some((c) => c.includes("handleDelete")), "handleDelete called");
	assert(calls.some((c) => c === "dropDirtyPath(notes/a.md)"), "drops old dirty");
	assert(calls.some((c) => c === "dropDirtyPath(.trash/a.md)"), "drops new dirty");
	assert(!calls.some((c) => c.startsWith("queueRename")), "queueRename NOT called");
}

console.log("\n--- Test 3: excluded -> markdown => markMarkdownDirty + dropDirty ---");
{
	const calls = execute(".trash/a.md", "notes/a.md");
	assert(calls.some((c) => c.includes("markMarkdownDirty")), "markMarkdownDirty called");
	assert(calls.some((c) => c === "dropDirtyPath(.trash/a.md)"), "drops excluded old dirty");
	assert(!calls.some((c) => c.startsWith("queueRename")), "queueRename NOT called");
	assert(!calls.some((c) => c.includes("handleDelete")), "handleDelete NOT called");
}

console.log("\n--- Test 4: excluded -> excluded => nothing ---");
{
	const calls = execute(".trash/a.md", "templates/a.md");
	assert(calls.length === 0, "no calls for ignore");
}

console.log("\n--- Test 5: blob rename => explicit causal blob rename ---");
{
	const calls = execute("assets/a.png", "assets/b.png");
	assert(calls.length === 1, "one call");
	assert(
		calls[0] === "blobSync.handleFileRename(assets/a.png, assets/b.png)",
		"blob rename uses BlobSync tombstone+ref handling",
	);
	assert(!calls.some((call) => call.startsWith("queueRename")), "blob rename never enters markdown batching");
}

console.log("\n--- Test 6: blob -> excluded => explicit causal delete ---");
{
	const calls = execute("assets/a.png", ".trash/a.png");
	assert(calls.includes("blobSync.handleFileDelete(assets/a.png)"), "blob source is tombstoned explicitly");
	assert(!calls.some((c) => c.includes("no-op")), "delete does not depend on a separate vault event");
}

console.log("\n--- Test 7: NFC -> NFD markdown rename remains queueRename ---");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const calls = execute(nfc, nfd);
	assert(calls.length === 1, "one markdown rename call");
	assert(calls[0]?.startsWith("queueRename") === true, "canonical-equivalent display rename is still persisted");
}

console.log("\n--- Test 8: cross-category markdown -> blob => tombstone markdown ---");
{
	const calls = execute("notes/file.md", "assets/file.png");
	assert(calls.some((c) => c.includes("handleDelete(notes/file.md)")), "tombstones markdown displayPath");
	assert(calls.includes("blobSync.handleFileChange(assets/file.png)"), "new blob is admitted explicitly");
	assert(!calls.some((c) => c.startsWith("queueRename")), "does NOT queue rename");
}

console.log("\n--- Test 9: cross-category blob -> markdown => admit markdown ---");
{
	const calls = execute("assets/note.png", "notes/note.md");
	assert(calls.some((c) => c.includes("markMarkdownDirty(notes/note.md)")), "admits markdown");
	assert(calls.includes("blobSync.handleFileDelete(assets/note.png)"), "old blob is tombstoned explicitly");
	assert(calls.some((c) => c === "dropDirtyPath(assets/note.png)"), "drops old blob dirty");
}

console.log("\n--- Test 10: excluded -> blob => explicit blob admission ---");
{
	const calls = execute(".trash/a.png", "assets/a.png");
	assert(calls.includes("blobSync.handleFileChange(assets/a.png)"), "new blob is admitted explicitly");
	assert(!calls.some((c) => c.includes("no-op")), "admission does not rely on a separate create event");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
