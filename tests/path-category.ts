/**
 * Tests for path category classification and category-aware rename planning.
 *
 * Tests classifySyncPath and planCategoryRenameAction — the same functions
 * main.ts uses for rename admission.
 */

import { classifySyncPath } from "../src/paths/pathCategory";
import { planCategoryRenameAction } from "../src/sync/policy/renameAdmissionPolicy";
import type { RenameAction } from "../src/sync/policy/renameAdmissionPolicy";
import { isBlobSyncable, isMarkdownSyncable } from "../src/types";

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

const EXCLUDE = ["templates/", "archive/private/"];
const CONFIG = ".obsidian";

function classify(path: string) {
	return classifySyncPath({ path, excludePatterns: EXCLUDE, configDir: CONFIG });
}

function planRename(oldPath: string, newPath: string): RenameAction {
	return planCategoryRenameAction({
		oldCategory: classify(oldPath),
		newCategory: classify(newPath),
	});
}

// -----------------------------------------------------------------------
// Category classification tests
// -----------------------------------------------------------------------

console.log("\n--- Test 1: .md file = markdown ---");
{
	const cat = classify("notes/a.md");
	assert(cat.kind === "markdown", "notes/a.md is markdown");
	assert(cat.path.canonicalKey === "notes/a.md", "canonical key correct");
	assert(cat.path.displayPath === "notes/a.md", "displayPath preserved");
}

console.log("\n--- Test 2: .png file = blob ---");
{
	const cat = classify("assets/image.png");
	assert(cat.kind === "blob", "assets/image.png is blob");
}

console.log("\n--- Test 3: .obsidian/ path = excluded ---");
{
	const cat = classify(".obsidian/workspace.md");
	assert(cat.kind === "excluded", ".obsidian/workspace.md is excluded");
	assert(cat.kind === "excluded" && cat.reason === "excluded-by-pattern", "reason correct");
}

console.log("\n--- Test 3b: nested hidden path = excluded ---");
{
	const cat = classify("docs/sample-vault/.obsidian/plugins/example/data.json");
	assert(cat.kind === "excluded", "nested .obsidian config is excluded");
	assert(
		classify("docs/sample-vault/SYSTEM/MEDIA/.gitkeep").kind === "excluded",
		"nested hidden file is excluded",
	);
}

console.log("\n--- Test 4: .trash/ path = excluded ---");
{
	const cat = classify(".trash/deleted.md");
	assert(cat.kind === "excluded", ".trash/deleted.md is excluded");
}

console.log("\n--- Test 4b: tool, generated, and temporary paths = excluded ---");
{
	assert(classify("packages/app/node_modules/lib/index.js").kind === "excluded", "node_modules is excluded");
	assert(classify("docs/site/dist/app.js").kind === "excluded", "dist is excluded");
	assert(classify("docs/site/build/guide.md").kind === "excluded", "build is excluded");
	assert(classify("coverage/lcov.info").kind === "excluded", "coverage is excluded");
	assert(classify("notes/draft.tmp").kind === "excluded", "temporary suffix is excluded");
	assert(classify("reports/app.js.map").kind === "excluded", "source map is excluded");
	assert(classify("assets/Thumbs.db").kind === "excluded", "system metadata is excluded");
	assert(classify("assets/~$budget.xlsx").kind === "excluded", "office lock file is excluded");
}

console.log("\n--- Test 5: user-excluded prefix = excluded ---");
{
	const cat = classify("templates/daily.md");
	assert(cat.kind === "excluded", "templates/daily.md excluded by user pattern");
}

console.log("\n--- Test 6: NFD markdown classifies as markdown after canonicalization ---");
{
	const nfd = "notes/A\u0300.md";
	const cat = classify(nfd);
	assert(cat.kind === "markdown", "NFD .md path is markdown");
	assert(cat.path.canonicalKey === "notes/\u00C0.md", "canonicalKey is NFC");
	assert(cat.path.displayPath === nfd, "displayPath preserves NFD input");
}

console.log("\n--- Test 7: backslash path classifies correctly ---");
{
	const cat = classify("notes\\sub\\file.md");
	assert(cat.kind === "markdown", "backslash path is markdown");
	assert(cat.path.canonicalKey === "notes/sub/file.md", "canonicalKey normalized");
	assert(cat.path.displayPath === "notes\\sub\\file.md", "displayPath preserved");
}

console.log("\n--- Test 8: non-.md non-excluded = blob ---");
{
	assert(classify("data/file.json").kind === "blob", ".json is blob");
	assert(classify("images/photo.jpg").kind === "blob", ".jpg is blob");
}

console.log("\n--- Test 8b: KAOS conflict artifacts are excluded ---");
{
	const cat = classify("notes/a (KAOS conflict - disk from device-mqqqdqip 2026-06-23T14-20-40Z).md");
	assert(cat.kind === "excluded", "markdown conflict artifact is excluded");
}

console.log("\n--- Test 8c: Obsidian Bases use the CRDT document lane ---");
{
	const path = "BACKLOG/BACKLOG.base";
	assert(classify(path).kind === "markdown", ".base is classified as a CRDT document");
	assert(isMarkdownSyncable(path, [], CONFIG), ".base is document-syncable");
	assert(!isBlobSyncable(path, [], CONFIG), ".base is never attachment-syncable");
	assert(classify("BACKLOG/BACKLOG.base.backup").kind === "excluded", ".base.backup is excluded");
	assert(classify("BACKLOG/BACKLOG.backup").kind === "excluded", "plain .backup is excluded");
}

console.log("\n--- Test 8d: pre-upgrade Base safety artifacts stay local-only ---");
{
	const localBackup =
		"BACKLOG/BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdef).base";
	const remoteConflict =
		"BACKLOG/BACKLOG (KAOS remote conflict 2026-07-17T08-00-00Z).base";
	assert(classify(localBackup).kind === "excluded", "legacy Base local backup is excluded");
	assert(classify(remoteConflict).kind === "excluded", "legacy Base remote conflict is excluded");
	assert(!isMarkdownSyncable(localBackup, [], CONFIG), "legacy Base backup is not admitted as a document");
	assert(!isMarkdownSyncable(remoteConflict, [], CONFIG), "legacy Base conflict is not admitted as a document");
}

console.log("\n--- Test 8e: artifact-named directory descendants stay local-only ---");
{
	const backupDir =
		"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdef)";
	const markdownChild = `${backupDir}/card.md`;
	const baseChild = `${backupDir}/nested/board.base`;
	const blobChild = `${backupDir}/assets/icon.png`;
	for (const path of [markdownChild, baseChild, blobChild]) {
		const category = classify(path);
		assert(category.kind === "excluded", `backup subtree child is excluded: ${path}`);
		assert(
			category.kind === "excluded" && category.reason === "local-safety-artifact",
			`backup subtree uses the local-safety reason: ${path}`,
		);
	}
	assert(!isMarkdownSyncable(markdownChild, [], CONFIG), "backup subtree Markdown is not syncable");
	assert(!isMarkdownSyncable(baseChild, [], CONFIG), "backup subtree Base is not syncable");
	assert(!isBlobSyncable(blobChild, [], CONFIG), "backup subtree attachment is not syncable");
	assert(
		classify(
			"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdeF)/card.md",
		).kind === "markdown",
		"non-canonical backup-like directory does not overmatch",
	);
}

// -----------------------------------------------------------------------
// Rename category matrix — full 9-case matrix + same-identity
// -----------------------------------------------------------------------

console.log("\n--- Test 9: markdown -> markdown = queue-markdown-rename ---");
{
	const action = planRename("notes/a.md", "notes/b.md");
	assert(action.kind === "queue-markdown-rename", "markdown→markdown: queue-markdown-rename");
	assert(action.kind === "queue-markdown-rename" && action.oldPath === "notes/a.md", "uses displayPath for oldPath");
	assert(action.kind === "queue-markdown-rename" && action.newPath === "notes/b.md", "uses displayPath for newPath");
}

console.log("\n--- Test 10: markdown -> excluded = tombstone-markdown ---");
{
	const action = planRename("notes/a.md", ".trash/a.md");
	assert(action.kind === "tombstone-markdown", "markdown→excluded: tombstone-markdown");
	assert(action.kind === "tombstone-markdown" && action.oldPath === "notes/a.md", "tombstones displayPath");
}

console.log("\n--- Test 11: excluded -> markdown = admit-markdown ---");
{
	const action = planRename(".trash/a.md", "notes/a.md");
	assert(action.kind === "admit-markdown", "excluded→markdown: admit-markdown");
	assert(action.kind === "admit-markdown" && action.newPath === "notes/a.md", "admits displayPath");
}

console.log("\n--- Test 12: blob -> blob = queue-blob-rename ---");
{
	const action = planRename("assets/a.png", "assets/b.png");
	assert(action.kind === "queue-blob-rename", "blob→blob: queue-blob-rename");
}

console.log("\n--- Test 13: blob -> excluded = defer-blob-to-events ---");
{
	const action = planRename("assets/a.png", ".trash/a.png");
	assert(action.kind === "defer-blob-to-events", "blob→excluded: defer-blob-to-events");
}

console.log("\n--- Test 14: excluded -> blob = admit-blob-via-event ---");
{
	const action = planRename(".trash/a.png", "assets/a.png");
	assert(action.kind === "admit-blob-via-event", "excluded→blob: admit-blob-via-event");
}

console.log("\n--- Test 15: markdown -> blob = tombstone-markdown ---");
{
	const action = planRename("notes/diagram.md", "assets/diagram.png");
	assert(action.kind === "tombstone-markdown", "markdown→blob: tombstone-markdown");
}

console.log("\n--- Test 16: blob -> markdown = admit-markdown ---");
{
	const action = planRename("assets/notes.png", "notes/imported.md");
	assert(action.kind === "admit-markdown", "blob→markdown: admit-markdown");
}

console.log("\n--- Test 17: excluded -> excluded = ignore ---");
{
	const action = planRename(".trash/a.md", "templates/a.md");
	assert(action.kind === "ignore", "excluded→excluded: ignore");
}

// -----------------------------------------------------------------------
// Same-identity (NFC/NFD equivalent) = no-op
// -----------------------------------------------------------------------

console.log("\n--- Test 18: NFC -> NFD-equivalent = same-identity (no CRDT mutation) ---");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const action = planRename(nfc, nfd);
	assert(action.kind === "same-identity", "NFC→NFD: same-identity (no-op)");
	assert(action.kind === "same-identity" && action.oldPath === nfc, "preserves old displayPath");
	assert(action.kind === "same-identity" && action.newPath === nfd, "preserves new displayPath");
}

// -----------------------------------------------------------------------
// Execution paths use displayPath, not normalizedPath
// -----------------------------------------------------------------------

console.log("\n--- Test 19: backslash rename uses displayPath for execution ---");
{
	// Backslash paths should pass through to execution unchanged.
	const action = planRename("notes\\old.md", "notes\\new.md");
	assert(action.kind === "queue-markdown-rename", "backslash: queue-markdown-rename");
	assert(action.kind === "queue-markdown-rename" && action.oldPath === "notes\\old.md", "oldPath is raw displayPath");
	assert(action.kind === "queue-markdown-rename" && action.newPath === "notes\\new.md", "newPath is raw displayPath");
}

console.log("\n--- Test 20: dirty path cleanup uses displayPath ---");
{
	const action = planRename("notes/file.md", ".trash/file.md");
	assert(action.kind === "tombstone-markdown", "tombstone action");
	assert(action.kind === "tombstone-markdown" && action.dropDirty.includes("notes/file.md"), "drops old displayPath");
	assert(action.kind === "tombstone-markdown" && action.dropDirty.includes(".trash/file.md"), "drops new displayPath");
}

console.log("\n--- Test 21: Base renames stay entirely in the document lane ---");
{
	const baseToBase = planRename("BACKLOG/BACKLOG.base", "BACKLOG/Archive.base");
	assert(baseToBase.kind === "queue-markdown-rename", ".base→.base queues a document rename");
	const baseToMarkdown = planRename("BACKLOG/BACKLOG.base", "BACKLOG/Archive.md");
	assert(baseToMarkdown.kind === "queue-markdown-rename", ".base→.md stays in the same document lane");
}

console.log("\n--- Test 22: renames into artifact subtrees never admit the destination ---");
{
	const backupDir =
		"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdef)";
	const documentAction = planRename("notes/card.md", `${backupDir}/card.md`);
	assert(documentAction.kind === "tombstone-markdown", "document→backup subtree tombstones only the source");
	const blobAction = planRename("assets/icon.png", `${backupDir}/assets/icon.png`);
	assert(blobAction.kind === "defer-blob-to-events", "blob→backup subtree retires only the source blob");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
