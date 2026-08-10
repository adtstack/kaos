import assert from "node:assert/strict";
import { planOpenExternalEdit } from "../src/runtime/reconcile/openExternalEditPlanner";
import { normalizeEditorText } from "../src/utils/editorTextNormalization";

const base = "## 업무\nbase work\n\n## 일상\nbase life\n";
const live = "## 업무\nlocal work\n\n## 일상\nbase life\n";
const external = "## 업무\nbase work\n\n## 일상\nexternal life\n";

assert.equal(normalizeEditorText("\ufeffa\r\nb\rc\n"), "a\nb\nc\n");
assert.equal(normalizeEditorText("a\nb\n"), "a\nb\n");
assert.equal(normalizeEditorText(""), "");
assert.equal(normalizeEditorText("a\r\nb\rc\n"), "a\nb\nc\n");

assert.deepEqual(planOpenExternalEdit({
	baselineText: base,
	currentText: base,
	externalText: external,
}), { kind: "apply-external", targetText: external });

assert.deepEqual(planOpenExternalEdit({
	baselineText: base,
	currentText: live,
	externalText: base,
}), { kind: "keep-current", targetText: live });

assert.deepEqual(planOpenExternalEdit({
	baselineText: base,
	currentText: live,
	externalText: external,
}), {
	kind: "apply-clean-merge",
	targetText: "## 업무\nlocal work\n\n## 일상\nexternal life\n",
});

const alreadyMerged = "## 업무\nlocal work\n\n## 일상\nexternal life\n";
assert.deepEqual(planOpenExternalEdit({
	baselineText: base,
	currentText: alreadyMerged,
	externalText: external,
}), {
	kind: "keep-current",
	targetText: alreadyMerged,
});

assert.deepEqual(planOpenExternalEdit({
	baselineText: base,
	currentText: live,
	externalText: live,
}), { kind: "already-settled", targetText: live });

const sameHunk = planOpenExternalEdit({
	baselineText: "title: base\n",
	currentText: "title: local\n",
	externalText: "title: external\n",
});
assert.deepEqual(sameHunk, {
	kind: "preserve-conflict",
	reason: "overlapping-hunks",
	hunkCount: 1,
});
assert.equal("partialMergedText" in sameHunk, false);

assert.deepEqual(planOpenExternalEdit({
	baselineText: null,
	currentText: "local\n",
	externalText: "external\n",
}), {
	kind: "preserve-conflict",
	reason: "missing-baseline",
	hunkCount: 0,
});

assert.deepEqual(planOpenExternalEdit({
	baselineText: null,
	currentText: "same\n",
	externalText: "same\n",
}), { kind: "already-settled", targetText: "same\n" });

const adjacent = planOpenExternalEdit({
	baselineText: "one\ntwo\nthree\n",
	currentText: "one\nlocal two\nthree\n",
	externalText: "one\ntwo\nexternal three\n",
});
assert.deepEqual(adjacent, {
	kind: "preserve-conflict",
	reason: "overlapping-hunks",
	hunkCount: 1,
});
assert.equal("targetText" in adjacent, false);
assert.equal("partialMergedText" in adjacent, false);

const deleteVsModify = planOpenExternalEdit({
	baselineText: "one\ntwo\nthree\n",
	currentText: "one\nthree\n",
	externalText: "one\nexternal two\nthree\n",
});
assert.deepEqual(deleteVsModify, {
	kind: "preserve-conflict",
	reason: "overlapping-hunks",
	hunkCount: 1,
});
assert.equal("targetText" in deleteVsModify, false);
assert.equal("partialMergedText" in deleteVsModify, false);

const appendBase = "# Alternating soak\n";
const appendSubset = `${appendBase}editor-01\n`;
const appendSuperset = `${appendSubset}filesystem-02\n`;
assert.deepEqual(planOpenExternalEdit({
	baselineText: appendBase,
	currentText: appendSubset,
	externalText: appendSuperset,
}), { kind: "apply-external", targetText: appendSuperset });

const staleAppendBaseline = `${appendBase}editor-01\n`;
const currentAfterManyAppends = `${staleAppendBaseline}filesystem-02\neditor-03\n`;
const externalAppendSuccessor = `${currentAfterManyAppends}filesystem-04\n`;
assert.deepEqual(planOpenExternalEdit({
	baselineText: staleAppendBaseline,
	currentText: currentAfterManyAppends,
	externalText: externalAppendSuccessor,
}), { kind: "apply-external", targetText: externalAppendSuccessor });
assert.deepEqual(planOpenExternalEdit({
	baselineText: null,
	currentText: currentAfterManyAppends,
	externalText: externalAppendSuccessor,
}), { kind: "apply-external", targetText: externalAppendSuccessor });
assert.deepEqual(planOpenExternalEdit({
	baselineText: appendBase,
	currentText: appendSuperset,
	externalText: appendSubset,
}), { kind: "keep-current", targetText: appendSuperset });

const siblingAppend = planOpenExternalEdit({
	baselineText: appendBase,
	currentText: `${appendBase}editor-only\n`,
	externalText: `${appendBase}filesystem-only\n`,
});
assert.deepEqual(siblingAppend, {
	kind: "preserve-conflict",
	reason: "overlapping-hunks",
	hunkCount: 1,
});

const repeatedLineBase = "A\n";
const repeatedLineLeft = "A\nA\n";
const repeatedLineRight = "B\nA\nA\n";
for (const [currentText, externalText] of [
	[repeatedLineLeft, repeatedLineRight],
	[repeatedLineRight, repeatedLineLeft],
] as const) {
	assert.deepEqual(planOpenExternalEdit({
		baselineText: repeatedLineBase,
		currentText,
		externalText,
	}), {
		kind: "preserve-conflict",
		reason: "overlapping-hunks",
		hunkCount: 1,
	});
}

console.log("open external edit planner: PASS");
