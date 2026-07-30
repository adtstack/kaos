import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import {
	buildSamePathAdoptionChangeSet,
	planSamePathAdoption,
} from "../src/runtime/reconcile/samePathAdoptionPlanner";
import { normalizeEditorText } from "../src/utils/editorTextNormalization";

const base = "## work\nbase work\n\n## life\nbase life\n";
const local = "## work\nlocal work\n\n## life\nbase life\n";
const remote = "## work\nbase work\n\n## life\nremote life\n";

assert.deepEqual(planSamePathAdoption({
	baselineText: null,
	localText: "same\n",
	remoteText: "same\n",
}), { kind: "already-settled", targetText: "same\n" });

assert.deepEqual(planSamePathAdoption({
	baselineText: base,
	localText: local,
	remoteText: base,
}), { kind: "apply-local", targetText: local });

assert.deepEqual(planSamePathAdoption({
	baselineText: base,
	localText: base,
	remoteText: remote,
}), { kind: "apply-remote", targetText: remote });

assert.deepEqual(planSamePathAdoption({
	baselineText: base,
	localText: local,
	remoteText: remote,
}), {
	kind: "apply-clean-merge",
	targetText: "## work\nlocal work\n\n## life\nremote life\n",
});

assert.deepEqual(planSamePathAdoption({
	baselineText: null,
	localText: "local\n",
	remoteText: "remote\n",
}), {
	kind: "preserve-conflict",
	reason: "missing-baseline",
	hunkCount: 0,
});

const overlapping = planSamePathAdoption({
	baselineText: "title: base\n",
	localText: "title: local\n",
	remoteText: "title: remote\n",
});
assert.deepEqual(overlapping, {
	kind: "preserve-conflict",
	reason: "conflicting-hunks",
	hunkCount: 1,
});
assert.equal("targetText" in overlapping, false);
assert.equal("partialMergedText" in overlapping, false);

assert.deepEqual(planSamePathAdoption({
	baselineText: "one\ntwo\nthree\n",
	localText: "one\nlocal two\nthree\n",
	remoteText: "one\ntwo\nremote three\n",
}), {
	kind: "preserve-conflict",
	reason: "conflicting-hunks",
	hunkCount: 1,
});

const repeatedBase = "A\n";
const repeatedLocal = "A\nA\n";
const repeatedRemote = "B\nA\nA\n";
for (const [localText, remoteText] of [
	[repeatedLocal, repeatedRemote],
	[repeatedRemote, repeatedLocal],
] as const) {
	assert.deepEqual(planSamePathAdoption({
		baselineText: repeatedBase,
		localText,
		remoteText,
	}), {
		kind: "preserve-conflict",
		reason: "conflicting-hunks",
		hunkCount: 1,
	});
}

const appendBase = "# soak\n";
const appendSubset = `${appendBase}local-01\n`;
const appendSuperset = `${appendSubset}remote-02\n`;
assert.deepEqual(planSamePathAdoption({
	baselineText: appendBase,
	localText: appendSuperset,
	remoteText: appendSubset,
}), { kind: "apply-local", targetText: appendSuperset });
assert.deepEqual(planSamePathAdoption({
	baselineText: appendBase,
	localText: appendSubset,
	remoteText: appendSuperset,
}), { kind: "apply-remote", targetText: appendSuperset });

const normalizedBase = normalizeEditorText("\ufeffbase\r\n");
const normalizedLocal = normalizeEditorText("\ufefflocal\r\n");
assert.deepEqual(planSamePathAdoption({
	baselineText: normalizedBase,
	localText: normalizedLocal,
	remoteText: normalizedBase,
}), { kind: "apply-local", targetText: "local\n" });

const unchanged = buildSamePathAdoptionChangeSet("same", "same");
assert.equal(unchanged.empty, true);
assert.equal(unchanged.apply(Text.of(["same"])).toString(), "same");

const before = "alpha beta gamma";
const after = "alpha BETA gamma!";
const changes = buildSamePathAdoptionChangeSet(before, after);
assert.equal(changes.apply(Text.of([before])).toString(), after);
const touched: Array<readonly [number, number, string]> = [];
changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
	touched.push([fromA, toA, inserted.toString()]);
});
assert.deepEqual(touched, [
	[6, 10, "BETA"],
	[16, 16, "!"],
]);

console.log("same path adoption planner: PASS");
