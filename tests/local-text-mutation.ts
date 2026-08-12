import assert from "node:assert/strict";
import * as Y from "yjs";

import { applyLocalTextMutation } from "../src/runtime/localTextMutation";
import { ORIGIN_LOCAL_TEXT_MUTATION, isLocalStringOrigin } from "../src/sync/origins";

// Minimal fake deps around a real Y.Text. `scheduled` captures scheduleWrite
// calls so tests can assert flush behaviour without a DiskMirror.
function makeDeps(ytext: Y.Text | null) {
	const scheduled: string[] = [];
	return {
		scheduled,
		deps: {
			getTextForPath: () => ytext,
			scheduleWrite: (path: string) => {
				scheduled.push(path);
			},
		},
	};
}

// 1. The new origin is classified as local so DiskMirror observers skip the
//    auto-flush (the caller flushes explicitly via scheduleWrite).
assert.equal(isLocalStringOrigin(ORIGIN_LOCAL_TEXT_MUTATION), true);

// 2. Applies the next text via a targeted diff under our origin, and schedules
//    exactly one flush.
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "## 일상\n- base\n");
	const seenOrigins: unknown[] = [];
	ytext.observe((_event, txn) => {
		seenOrigins.push(txn.origin);
	});

	const { scheduled, deps } = makeDeps(ytext);
	const res = applyLocalTextMutation(deps, "note.md", (cur) => `${cur}- area-stack: 집\n`);

	assert.equal(res.applied, true);
	assert.equal(res.postcondition?.finalMatchesExpected, true);
	assert.equal(res.postcondition?.forceReplaceApplied, false);
	assert.equal(ytext.toJSON(), "## 일상\n- base\n- area-stack: 집\n");
	assert.deepEqual(scheduled, ["note.md"]); // scheduled once
	assert.deepEqual(seenOrigins, [ORIGIN_LOCAL_TEXT_MUTATION]); // tagged with our origin
}

// 3. No-op when the mutator returns the same text: no diff, no flush.
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "hello");
	const { scheduled, deps } = makeDeps(ytext);
	const res = applyLocalTextMutation(deps, "note.md", (cur) => cur);

	assert.equal(res.applied, false);
	assert.equal(res.postcondition, null);
	assert.deepEqual(scheduled, []);
	assert.equal(ytext.toJSON(), "hello");
}

// 4. The mutator receives the CURRENT (fresh) CRDT text, reflecting prior
//    independent edits (e.g. user typing) — never a stale snapshot.
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "D0");
	// an independent change lands before the call
	ytext.insert(ytext.length, " (typed)");

	const { deps } = makeDeps(ytext);
	let observed: string | null = null;
	applyLocalTextMutation(deps, "note.md", (cur) => {
		observed = cur;
		return `${cur} +tool`;
	});

	assert.equal(observed, "D0 (typed)"); // fresh read, not stale "D0"
	assert.equal(ytext.toJSON(), "D0 (typed) +tool");
}

// 5. Successive tool writes (the D1 → D2 → D3 scenario) advance the CRDT
//    monotonically and each real mutation schedules a flush; a no-op step
//    (D3 === D2) schedules nothing. No conflict artifacts are produced because
//    these never become external disk revisions.
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "D0");
	const { scheduled, deps } = makeDeps(ytext);

	applyLocalTextMutation(deps, "note.md", (c) => `${c} body`); // D1
	applyLocalTextMutation(deps, "note.md", (c) => `${c} area-stack`); // D2
	applyLocalTextMutation(deps, "note.md", (c) => c); // D3 === D2 (domain-stack no-op)

	assert.equal(ytext.toJSON(), "D0 body area-stack");
	assert.equal(scheduled.length, 2); // D1 and D2 scheduled; D3 no-op did not
}

// 6. Untracked path (no Y.Text) throws a clear precondition violation rather
//    than silently no-op'ing or creating state.
{
	const { deps } = makeDeps(null);
	assert.throws(
		() => applyLocalTextMutation(deps, "ghost.md", (c) => `${c}x`),
		/not tracked by CRDT/,
	);
}

console.log("local-text-mutation: PASS");
