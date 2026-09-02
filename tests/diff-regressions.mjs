import { readFileSync } from "node:fs";
import { YSyncConfig } from "y-codemirror.next";
import * as Y from "yjs";

const diffModule = await import("../src/sync/diff.ts");
const {
	applyDiffToYText,
	applyDiffToYTextWithPostcondition,
	applyExactDiffToYText,
	forceReplaceYText,
} = diffModule.default;
const originsModule = await import("../src/sync/origins.ts");
const { ORIGIN_OPEN_EXTERNAL_EDIT_MERGE } = originsModule.default;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function applyAndCapture(oldText, newText, origin = "test-diff") {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, oldText);

	let delta = null;
	ytext.observe((event) => {
		delta = event.delta;
	});

	applyDiffToYText(ytext, oldText, newText, origin);

	return {
		doc,
		ytext,
		delta,
		value: ytext.toString(),
	};
}

console.log("\n--- Test 1: no-op diff is a no-op ---");
{
	const oldText = "line 1\nline 2\n";
	const { value, delta, doc } = applyAndCapture(oldText, oldText);
	assert(value === oldText, "content unchanged after no-op");
	assert(delta === null, "no transaction emitted for no-op");
	doc.destroy();
}

console.log("\n--- Test 2: small mid-document edit patches correctly ---");
{
	const oldText = "alpha\nbeta\ngamma\n";
	const newText = "alpha\nbeta updated\ngamma\n";
	const { value, delta, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "small edit produces exact final content");
	assert(Array.isArray(delta) && delta.length > 0, "small edit emits a delta");
	assert(
		delta?.some((part) => typeof part.retain === "number"),
		"small edit keeps stable surrounding content",
	);
	doc.destroy();
}

console.log("\n--- Test 3: far-apart edits stay localized on a large document ---");
{
	const lines = [];
	for (let i = 0; i < 5000; i++) {
		lines.push(`line ${String(i).padStart(4, "0")}: original content`);
	}
	const oldText = `${lines.join("\n")}\n`;

	const updated = [...lines];
	updated[49] = "line 0049: corrected intro typo";
	updated[4949] = "line 4949: appended outro paragraph";
	const newText = `${updated.join("\n")}\n`;

	const { value, delta, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "large document edit produces exact final content");
	assert(Array.isArray(delta) && delta.length >= 5, "large document delta stays segmented");
	assert(
		delta?.some((part) => typeof part.retain === "number" && part.retain > 0),
		"large document preserves unchanged anchors",
	);
	const deleted = (delta ?? []).reduce(
		(sum, part) => sum + (typeof part.delete === "number" ? part.delete : 0),
		0,
	);
	assert(deleted < oldText.length / 4, "large document does not replace a huge chunk");
	doc.destroy();
}

console.log("\n--- Test 4: line endings and trailing newline changes are preserved ---");
{
	const oldText = "first line\nsecond line";
	const newText = "first line\nsecond line\nthird line\n";
	const { value, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "trailing newline changes are preserved exactly");
	doc.destroy();
}

console.log("\n--- Test 5: inline task priority icon change keeps adjacent line boundary ---");
{
	const oldText = "- [ ] 🔺 task item\nnext line\n";
	const newText = "- [ ] 🔹 task item\nnext line\n";
	const { value, doc } = applyAndCapture(oldText, newText, "disk-sync-task-priority");
	assert(value === newText, "priority icon swap keeps newline boundary intact");
	assert(
		value.includes("task item\nnext line"),
		"priority icon swap does not merge task line with the next line",
	);
	doc.destroy();
}

console.log("\n--- Test 6: stale-base disk patch does not duplicate task icons or merge lines ---");
{
	const oldText = "- [ ] 🔺 task item\nnext line\n";
	const remoteText = "- [ ] 🔺 task item\nnext line changed remotely\n";
	const diskPluginText = "- [ ] 🔹 task item\nnext line\n";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, oldText);

	applyDiffToYText(ytext, oldText, remoteText, "remote");
	applyDiffToYText(ytext, oldText, diskPluginText, "disk-sync");

	const merged = ytext.toString();
	assert(
		merged.includes("- [ ] 🔹 task item\n"),
		"stale-base patch keeps one task line with the updated icon",
	);
	assert(
		merged.includes("next line changed remotely\n"),
		"stale-base patch preserves remote adjacent-line content",
	);
	assert(
		!merged.includes("🔹🔹"),
		"stale-base patch does not duplicate inline task icons",
	);
	doc.destroy();
}

console.log("\n--- Test 7: recovery postcondition preserves concurrent typing on stale base ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const staleBase = "prefix\nabc\nsuffix\n";
	const current = "prefix\nabcX\nsuffix\n";
	const expected = "prefix\nabcY\nsuffix\n";
	ytext.insert(0, current);

	const result = applyDiffToYTextWithPostcondition(
		ytext,
		staleBase,
		expected,
		"disk-sync-recover-bound",
	);

	assert(
		ytext.toString() === "prefix\nabcXY\nsuffix\n",
		"same-point insertions from typing and recovery are both preserved (no loss)",
	);
	assert(result.diffSkippedDueToStaleBase, "stale caller base is detected");
	assert(!result.forceReplaceApplied, "stale base does not force a whole-document replacement");
	assert(
		!result.finalMatchesExpected,
		"overlapping recovery target reports a failed postcondition so callers re-plan",
	);
	doc.destroy();
}

console.log("\n--- Test 7b: stale-base recovery merges disjoint concurrent edits ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const staleBase = "alpha\nbeta\n";
	const current = "alpha typed\nbeta\n";
	const expected = "alpha\nbeta\ngamma\n";
	ytext.insert(0, current);

	const result = applyDiffToYTextWithPostcondition(
		ytext,
		staleBase,
		expected,
		"disk-sync-recover-bound",
	);

	assert(
		ytext.toString() === "alpha typed\nbeta\ngamma\n",
		"disjoint typing and recovery changes are both preserved",
	);
	assert(result.diffSkippedDueToStaleBase, "stale caller base is detected");
	assert(!result.forceReplaceApplied, "no whole-document replacement for disjoint changes");
	assert(!result.finalMatchesExpected, "merged result differs from the stale target by design");
	doc.destroy();
}

console.log("\n--- Test 8: forceReplaceYText replaces the whole Y.Text exactly ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "old content");

	forceReplaceYText(ytext, "new", "disk-sync-open-idle-recover");

	assert(ytext.toString() === "new", "forceReplaceYText replaces old content exactly");
	doc.destroy();
}

console.log("\n--- Test 9: reconciliation cannot bypass targeted diff recovery ---");
{
	const reconciliationSource = readFileSync(
		new URL("../src/runtime/reconciliationController.ts", import.meta.url),
		"utf8",
	);
	assert(
		!reconciliationSource.includes("forceReplaceYText("),
		"reconciliation never invokes whole-document replacement directly",
	);
}

console.log("\n--- Test 10: exact diff preserves a relative anchor in unchanged text ---");
{
	assert(
		typeof applyExactDiffToYText === "function",
		"applyExactDiffToYText is exported",
	);
	if (typeof applyExactDiffToYText === "function") {
		const doc = new Y.Doc();
		const ytext = doc.getText("content");
		const oldText = "before\nanchor\nafter\n";
		const newText = "external before\nanchor\nafter\n";
		ytext.insert(0, oldText);
		const relativeAnchor = Y.createRelativePositionFromTypeIndex(
			ytext,
			"before\n".length,
		);

		const result = applyExactDiffToYText(
			ytext,
			oldText,
			newText,
			ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
		);
		const absoluteAnchor = Y.createAbsolutePositionFromRelativePosition(
			relativeAnchor,
			doc,
		);

		assert(result.kind === "applied", "exact diff reports applied");
		assert(ytext.toString() === newText, "exact diff lands the requested text");
		assert(
			absoluteAnchor?.type === ytext
				&& absoluteAnchor.index === "external before\n".length,
			"relative anchor still points to the anchor line",
		);
		doc.destroy();
	}
}

console.log("\n--- Test 11: exact diff rejects a stale expected base without mutation ---");
{
	if (typeof applyExactDiffToYText === "function") {
		const doc = new Y.Doc();
		const ytext = doc.getText("content");
		const actual = "current collaborator text\n";
		const target = "external target text\n";
		ytext.insert(0, actual);

		const result = applyExactDiffToYText(
			ytext,
			"stale expected base\n",
			target,
			ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
		);

		assert(
			JSON.stringify(result) === JSON.stringify({ kind: "stale-base", currentText: actual }),
			"stale base returns the exact stale-base result",
		);
		assert(ytext.toString() === actual, "stale base leaves current text untouched");
		assert(!ytext.toString().includes(target), "stale base does not add target content");
		doc.destroy();
	}
}

console.log("\n--- Test 12: user undo excludes the external merge origin ---");
{
	if (
		typeof applyExactDiffToYText === "function"
		&& typeof ORIGIN_OPEN_EXTERNAL_EDIT_MERGE === "string"
	) {
		const doc = new Y.Doc();
		const ytext = doc.getText("content");
		ytext.insert(0, "base\n");
		const undoManager = new Y.UndoManager(ytext);
		const editorOrigin = new YSyncConfig(ytext, null);
		// y-codemirror registers its YSyncConfig instance as the tracked user-edit
		// origin on the binding's UndoManager.
		undoManager.addTrackedOrigin(editorOrigin);

		doc.transact(() => ytext.insert(0, "user-one "), editorOrigin);
		undoManager.stopCapturing();
		const beforeExternalMerge = ytext.toString();
		const externalResult = applyExactDiffToYText(
			ytext,
			beforeExternalMerge,
			"user-one external base\n",
			ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
		);
		doc.transact(() => ytext.insert(ytext.length, "user-two\n"), editorOrigin);

		assert(externalResult.kind === "applied", "external merge is applied exactly");
		assert(
			!undoManager.trackedOrigins.has(ORIGIN_OPEN_EXTERNAL_EDIT_MERGE),
			"external merge origin is not tracked by the user UndoManager",
		);
		undoManager.undo();
		assert(
			ytext.toString() === "user-one external base\n",
			"first undo removes only the later user insert",
		);
		undoManager.undo();
		assert(
			ytext.toString() === "external base\n",
			"second undo removes only the earlier user insert and keeps external text",
		);

		undoManager.destroy();
		editorOrigin.undoManager.destroy();
		doc.destroy();
	}
}

console.log("\n--- Test 13: exact diff unchanged result emits no Yjs update ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const unchanged = "already exact\n";
	ytext.insert(0, unchanged);
	const stateVectorBefore = Y.encodeStateVector(doc);
	let updateCount = 0;
	const countUpdate = () => {
		updateCount++;
	};
	doc.on("update", countUpdate);

	const result = applyExactDiffToYText(
		ytext,
		unchanged,
		unchanged,
		ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
	);
	const stateVectorAfter = Y.encodeStateVector(doc);
	doc.off("update", countUpdate);

	assert(
		JSON.stringify(result) === JSON.stringify({ kind: "unchanged" }),
		"unchanged text returns the exact unchanged result",
	);
	assert(updateCount === 0, "unchanged text emits no Yjs update");
	assert(
		Buffer.from(stateVectorAfter).equals(Buffer.from(stateVectorBefore)),
		"unchanged text leaves the Yjs state vector untouched",
	);
	assert(ytext.toString() === unchanged, "unchanged text preserves content exactly");
	doc.destroy();
}

console.log("\n--- Test 14: exact diff reports synchronous postcondition interference ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const oldText = "base\n";
	const newText = "external base\n";
	const interferedText = "external base\nintervening collaborator text\n";
	ytext.insert(0, oldText);
	let armed = true;
	let interferenceCount = 0;
	const interfereOnce = (_event, transaction) => {
		if (!armed || transaction.origin !== ORIGIN_OPEN_EXTERNAL_EDIT_MERGE) return;
		armed = false;
		interferenceCount++;
		ytext.insert(ytext.length, "intervening collaborator text\n");
	};
	ytext.observe(interfereOnce);

	const result = applyExactDiffToYText(
		ytext,
		oldText,
		newText,
		ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
	);
	ytext.unobserve(interfereOnce);

	assert(interferenceCount === 1, "one-shot observer interferes exactly once");
	assert(
		JSON.stringify(result) === JSON.stringify({
			kind: "postcondition-failed",
			currentText: interferedText,
		}),
		"interference returns the exact postcondition-failed result",
	);
	assert(
		ytext.toString() === interferedText,
		"exact diff does not force-replace intervening content",
	);
	doc.destroy();
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
