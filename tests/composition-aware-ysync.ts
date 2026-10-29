/**
 * Unit tests for the composition-aware ySync replacement.
 *
 * Covers the pure flush planner, the extension bundle shape (stock ySync
 * removed, our facet wins), and the plugin value's hold/pause/flush state
 * machine driven with real EditorState + stub views (the same pattern as
 * tests/editor-binding-recent-activity.ts — no DOM, no Obsidian).
 *
 * Obsidian dependency: tests/mocks/obsidian.ts via JITI_ALIAS. Runs under
 * node --import jiti/register.
 */
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { ySync, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import {
	CompositionAwareYSyncPluginValue,
	buildCompositionAwareCollab,
	computeContentDiffChanges,
	flushCompositionResidue,
	getViewLastAgreedContent,
	getViewUnsyncedInfo,
	hasViewUnsyncedEdits,
	isCompositionHoldActive,
	kaosYSyncAnnotation,
	planCompositionFlush,
} from "../src/sync/compositionAwareYSync";
import { VaultSync } from "../src/sync/vaultSync";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	assert(
		Object.is(actual, expected),
		`${msg}${actual === expected ? "" : ` (expected=${String(expected)} actual=${String(actual)})`}`,
	);
}

// ---------------------------------------------------------------------------
// 1. planCompositionFlush decision table
// ---------------------------------------------------------------------------

console.log("\n--- Test 1: planCompositionFlush decision table ---");
{
	// editor == ytext (nothing diverged) → no-op
	assertEq(
		planCompositionFlush("ab", "ab", "ab").kind,
		"no-op",
		"identical contents → no-op",
	);
	// Diverged but converged to the same text → no-op
	assertEq(
		planCompositionFlush("ab", "ab1", "ab1").kind,
		"no-op",
		"converged contents → no-op",
	);

	// ytext unchanged, editor has composition text → push-only
	const pushOnly = planCompositionFlush("base", "base한글", "base");
	assertEq(pushOnly.kind, "push-only", "composition only → push-only");
	assertEq(
		pushOnly.kind === "push-only" ? pushOnly.mergedText : null,
		"base한글",
		"push-only merged text is the editor content",
	);

	// editor unchanged, ytext has the remote change → projection-only
	const projOnly = planCompositionFlush("base", "base", "baseX");
	assertEq(projOnly.kind, "projection-only", "remote only → projection-only");
	assertEq(
		projOnly.kind === "projection-only" ? projOnly.mergedText : null,
		"baseX",
		"projection-only merged text is the ytext content",
	);

	// Both sides changed at disjoint offsets → merge preserves both
	const merged = planCompositionFlush("hello world", "헬lo world", "hello 월드");
	assertEq(merged.kind, "merge", "disjoint concurrent edits → merge");
	if (merged.kind === "merge") {
		assert(merged.mergedText.includes("헬lo"), "merge keeps local edit");
		assert(merged.mergedText.includes("월드"), "merge keeps remote edit");
	}

	// Overlapping same-region edits: ours (the live editor) wins, deterministic
	const overlap = planCompositionFlush("aaaa", "bb", "cc");
	assertEq(overlap.kind, "merge", "overlap → merge kind");
	if (overlap.kind === "merge") {
		assertEq(overlap.mergedText, "bb", "overlap resolves to the editor side (documented rule)");
	}
}

// ---------------------------------------------------------------------------
// 2. Bundle shape: stock ySync stripped, our facet wins
// ---------------------------------------------------------------------------

console.log("\n--- Test 2: bundle shape ---");
{
	const ytext = new Y.Doc().getText("content");
	const undoManager = new Y.UndoManager(ytext);
	const bundle = buildCompositionAwareCollab(ytext, undefined, { undoManager });
	assert(
		!bundle.some((extension) => extension === ySync),
		"stock ySync ViewPlugin is removed from the bundle",
	);
	assert(bundle.length > 0, "bundle is non-empty");

	const state = EditorState.create({ extensions: bundle });
	const conf = state.facet(ySyncFacet);
	assert(conf instanceof YSyncConfig, "facet resolves to a YSyncConfig");
	assert(
		conf.ytext === ytext,
		"facet config is ours and points at the same ytext",
	);
	undoManager.destroy();
}

// ---------------------------------------------------------------------------
// 3. Hold state machine with real EditorState + stub view
// ---------------------------------------------------------------------------

/**
 * Minimal EditorView stand-in: dispatch records transactions onto a live
 * state and drives registered update listeners (the plugin's update()),
 * mimicking the ViewPlugin lifecycle without a DOM. Access the document via
 * view.state — never destructure `state` (the getter snapshots).
 */
function makeStubView(
	extensions: ReturnType<typeof buildCompositionAwareCollab>,
	initialDoc = "",
) {
	let state = EditorState.create({ extensions, doc: initialDoc });
	const dispatched: Array<{ doc: string; annotated: boolean }> = [];
	const updateListeners: Array<(update: unknown) => void> = [];
	const view = {
		get state() {
			return state;
		},
		composing: false,
		dom: { isConnected: true },
		dispatch(spec: Parameters<EditorState["update"]>[0]) {
			const tr = state.update(spec);
			const docChanged = tr.docChanged;
			state = tr.state;
			dispatched.push({
				doc: state.doc.toString(),
				annotated: tr.annotation(kaosYSyncAnnotation) !== undefined,
			});
			const fakeUpdate = {
				docChanged,
				transactions: [tr],
				changes: tr.changes,
				view,
			};
			for (const listener of updateListeners) listener(fakeUpdate);
		},
	};
	return {
		view,
		dispatched,
		addUpdateListener(listener: (update: unknown) => void): void {
			updateListeners.push(listener);
		},
	};
}

console.log("\n--- Test 3: hold pauses push, flush converges ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "seed");
	const undoManager = new Y.UndoManager(ytext);

	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"seed",
	);
	const view = harness.view;
	const dispatched = harness.dispatched;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Local typing is pushed synchronously (mirror holds pre-hold).
	view.dispatch({ changes: { from: 4, to: 4, insert: "!" } });
	assertEq(ytext.toString(), "seed!", "pre-hold push keeps ytext in sync");
	const pushedAfterLocal = dispatched.length;

	// Enter composition and receive a remote event mid-composition.
	view.composing = true;
	doc.transact(() => ytext.insert(0, "R:"), "remote-origin");
	assertEq(
		ytext.toString(),
		"R:seed!",
		"remote change applied to ytext (CRDT unaffected)",
	);
	assertEq(dispatched.length, pushedAfterLocal, "projection withheld during composition");
	assert(isCompositionHoldActive(view as never), "hold state is visible via isCompositionHoldActive");

	// Composition text typed while holding — must NOT reach ytext.
	view.dispatch({ changes: { from: 5, to: 5, insert: "한" } });
	assertEq(view.state.doc.toString(), "seed!한", "editor doc is base + composition");
	assertEq(ytext.toString(), "R:seed!", "push paused during hold — ytext untouched by composition");

	// Composition ends → flush merges both sides.
	view.composing = false;
	plugin.flush("compositionend");
	assertEq(
		ytext.toString(),
		"R:seed!한",
		"flush merges remote prefix and local composition into ytext",
	);
	assertEq(
		view.state.doc.toString(),
		"R:seed!한",
		"flush converges the editor to the merged content",
	);
	assert(!isCompositionHoldActive(view as never), "hold cleared after flush");
	const lastDispatch = dispatched[dispatched.length - 1];
	assertEq(lastDispatch?.annotated, true, "flush editor transaction carries the sync annotation");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror restored (ytext == editor)");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 3b: composition text pushes live while composing (stock parity) ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "seed");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"seed",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	view.composing = true;
	view.dispatch({ changes: { from: 4, to: 4, insert: "한글" } });
	assertEq(ytext.toString(), "seed한글", "composition text is pushed live while composing");
	assertEq(view.state.doc.toString(), "seed한글", "editor holds the composition text");

	// compositionend with no remote → nothing left to flush, no duplication.
	view.composing = false;
	plugin.onCompositionSessionEnded("compositionend");
	assertEq(ytext.toString(), "seed한글", "compositionend does not duplicate the pushed text");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror stays current without a hold");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 3c: remote insert at the same offset keeps the composition run intact ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "x");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"x",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Compose a multi-character run (push paused), then a remote insert lands
	// at the exact same offset.
	view.composing = true;
	view.dispatch({ changes: { from: 1, to: 1, insert: "한글" } });
	doc.transact(() => ytext.insert(1, "[R]"), "remote-origin");
	view.composing = false;
	plugin.flush("compositionend");

	const merged = view.state.doc.toString();
	assertEq(merged, ytext.toString(), "mirror converged");
	assert(
		merged.includes("한글"),
		"the composition run survives intact (no per-character split)",
	);
	assert(merged.includes("[R]"), "the remote insert survives");
	assertEq(
		merged === "x한글[R]" || merged === "x[R]한글",
		true,
		"same-offset concurrent inserts keep whole-run ordering (deterministic)",
	);

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 4: hold cap timer force-flushes ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "v");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"v",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	view.composing = true;
	doc.transact(() => ytext.insert(1, "-remote"), "remote-origin");
	// Never end the composition; the cap must converge anyway.
	plugin.flush("cap-timeout");
	assertEq(view.state.doc.toString(), "v-remote", "cap flush projects the remote change");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror restored by cap flush");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 5: no hold → projection dispatches immediately (stock parity) ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "abc");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"abc",
	);
	const view = harness.view;
	const dispatched = harness.dispatched;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));
	view.composing = false;

	doc.transact(() => ytext.insert(3, "def"), "remote-origin");
	assertEq(view.state.doc.toString(), "abcdef", "non-composition remote applies immediately");
	assertEq(dispatched.length, 1, "exactly one projection dispatch");
	assertEq(dispatched[0]?.annotated, true, "projection carries sync annotation");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror holds");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 6: compositionend flag lag must not duplicate already-pushed text ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "base");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"base",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// User types in composition — pushed live under the current contract.
	view.composing = true;
	view.dispatch({ changes: { from: 4, to: 4, insert: "한글" } });
	assertEq(ytext.toString(), "base한글", "pushed live while composing");

	// compositionend fires while view.composing is STILL true (lag)
	plugin.onCompositionSessionEnded("compositionend");

	// CM6 observer clears composing flag in the same event turn
	view.composing = false;

	// Microtask runs
	await Promise.resolve();

	assertEq(ytext.toString(), "base한글", "lag flush does not duplicate the composition text");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror current after lag");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 7: destroy with a live-pushed mirror is a no-op ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "note");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"note",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// User types in composition, then immediately closes the tab (destroy)
	view.composing = true;
	view.dispatch({ changes: { from: 4, to: 4, insert: "끝" } });
	assertEq(ytext.toString(), "note끝", "composition text already pushed live");

	plugin.destroy();
	assertEq(ytext.toString(), "note끝", "destroy leaves the live-pushed mirror untouched");

	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 8: flushCompositionResidue heals batch-dropped edits at a binding boundary ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "start");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"start",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Live typing pushes through the normal path.
	view.composing = true;
	view.dispatch({ changes: { from: 5, to: 5, insert: "작업" } });
	assertEq(ytext.toString(), "start작업", "live typing pushes immediately");

	// A coalesced update whose first transaction is plugin-annotated drops
	// the later user edit from the push (the y-sync batched-update quirk):
	// the editor runs ahead while ytext and lastAgreed stay behind.
	const conf = view.state.facet(ySyncFacet);
	view.dispatch({
		changes: { from: 7, to: 7, insert: "잔여" },
		annotations: kaosYSyncAnnotation.of(conf),
		userEvent: "input.type.compose",
	});
	assertEq(view.state.doc.toString(), "start작업잔여", "editor carried the batch-dropped edit");
	assertEq(ytext.toString(), "start작업", "dropped edit is unpushed residue");

	// Call flushCompositionResidue (as resolveBindingTarget would do)
	const flushed = flushCompositionResidue(view as never, "binding-probe");
	assertEq(flushed, true, "flushCompositionResidue reports success");
	assertEq(ytext.toString(), "start작업잔여", "ytext brought in sync with editor");

	// Second call is no-op
	const secondFlushed = flushCompositionResidue(view as never, "binding-probe");
	assertEq(secondFlushed, false, "redundant flush is no-op");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 9: destroy does not overwrite advanced CRDT when the editor only holds residue ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "base-doc");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"base-doc",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Batch-dropped local edit leaves unpushed residue in the editor.
	const conf = view.state.facet(ySyncFacet);
	view.dispatch({
		changes: { from: 8, to: 8, insert: "-local" },
		annotations: kaosYSyncAnnotation.of(conf),
	});

	// Simulate detached view during teardown: DOM is disconnected so projections are skipped
	view.dom.isConnected = false;

	// Remote edit advances ytext while editor stayed at base-doc-local
	doc.transact(() => {
		ytext.insert(8, "-remote");
	}, "remote-origin");

	assertEq(view.state.doc.toString(), "base-doc-local", "editor remains at base+residue because view was detached");
	assertEq(ytext.toString(), "base-doc-remote", "CRDT advanced remotely");

	// View is destroyed with residue present: the merge-shaped plan must NOT
	// be force-pushed over the remote-advanced CRDT.
	plugin.destroy();
	assertEq(
		ytext.toString(),
		"base-doc-remote",
		"destroy refuses merge-shaped push and preserves the remote edit",
	);

	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 10: flushCompositionResidue refuses to push when concurrent edits occurred (merge) ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "base-doc");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"base-doc",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Batch-dropped local edit leaves unpushed residue in the editor.
	const conf = view.state.facet(ySyncFacet);
	view.dispatch({
		changes: { from: 8, to: 8, insert: "-local" },
		annotations: kaosYSyncAnnotation.of(conf),
	});

	// Disconnect DOM so remote projection does not dispatch into editor
	view.dom.isConnected = false;

	// Remote edit happens concurrently
	doc.transact(() => {
		ytext.insert(0, "remote-");
	}, "remote-origin");

	assertEq(view.state.doc.toString(), "base-doc-local", "editor doc has local edits");
	assertEq(ytext.toString(), "remote-base-doc", "ytext has remote edits");

	// Probe should refuse to push because plan is merge
	const flushed = flushCompositionResidue(view as never, "binding-probe");
	assertEq(flushed, false, "flushCompositionResidue rejects merge plan");
	assertEq(ytext.toString(), "remote-base-doc", "ytext is not corrupted by half-applied merge");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 11: flushCompositionResidue fails closed if lastAgreedContent is missing ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "base-doc");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"base-doc",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Batch-dropped local edit leaves unpushed residue in the editor.
	const conf = view.state.facet(ySyncFacet);
	view.dispatch({
		changes: { from: 8, to: 8, insert: "-local" },
		annotations: kaosYSyncAnnotation.of(conf),
	});

	// Clear lastAgreedContent to simulate missing baseline
	(plugin as unknown as { lastAgreedContent: string | null }).lastAgreedContent = null;

	const flushed = flushCompositionResidue(view as never, "binding-probe");
	assertEq(flushed, false, "flushCompositionResidue fails closed when base is missing");
	assertEq(ytext.toString(), "base-doc", "ytext untouched");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}


console.log("\n--- Test 12: compositionend flag lag must not strand composition text ---");
{
	// Real-world IME failure mode (2026-10-02 report): chained composition
	// sessions where every compositionend is observed while the composing
	// flag is still up (CM6 EditContext ordering), so each queued flush
	// microtask bails on isComposing() and the session's text is never
	// pushed. The run then ends with a plain (non-composition) keystroke
	// whose push runs against a stale Y.Text.
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "AB");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"AB",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	const syllables = ["한", "글", "입", "력"];
	view.composing = true;
	for (const s of syllables) {
		view.dispatch({
			changes: { from: view.state.doc.length, to: view.state.doc.length, insert: s },
			userEvent: "input.type.compose",
		});
		// compositionend observed while the flag never dropped; the queued
		// microtask will bail because composing is still true.
		plugin.onCompositionSessionEnded("compositionend");
	}
	// Composition run ends; the user presses space — a plain input txn that
	// update() must push without the mirror being stale.
	view.composing = false;
	let pushThrew: unknown = null;
	try {
		view.dispatch({
			changes: { from: view.state.doc.length, to: view.state.doc.length, insert: " " },
			userEvent: "input.type",
		});
	} catch (err) {
		pushThrew = err;
	}
	// Assertions run synchronously, before any stray microtask can repair.
	assert(pushThrew === null, "plain keystroke after a composition run must not throw on push");
	assertEq(
		ytext.toString() === view.state.doc.toString(),
		true,
		"mirror holds through chained composition + plain keystroke",
	);
	assert(
		ytext.toString().includes("한글입력"),
		"the composed run reaches Y.Text",
	);

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 13: computeContentDiffChanges handles non-final insertions without RangeError ---");
{
	// Test cases where insertion is followed by other changes (e.g. [+1, 0, -1] and [0, +1, -1])
	const testPairs = [
		// [+1, 0, -1]: insert at start, keep middle, delete end
		{ from: "world", to: "hello worl", desc: "[+1, 0, -1] insert at start then delete at end" },
		// [0, +1, -1]: keep start, insert middle, delete end
		{ from: "abc def", to: "abc XYZ de", desc: "[0, +1, -1] keep start, insert middle, delete end" },
		// Interleaved insertions and deletions across document
		{ from: "The quick brown fox jumps over the lazy dog", to: "A fast brown fox leaped over a dog", desc: "interleaved edits" },
		// Pure deletion followed by insertion
		{ from: "hello world", to: "world peace", desc: "delete prefix then insert suffix" },
		// Korean text editing with multiple non-final insertions and deletions
		{ from: "오랜만에 해선이를 보니까 참 반갑다", to: "오랜만에 옛 친구를 보니까 참 반갑다는 생각", desc: "Korean non-final edit sequence" },
	];

	for (const { from, to, desc } of testPairs) {
		const changes = computeContentDiffChanges(from, to);
		// Verify changes apply to a real EditorState without RangeError
		let state = EditorState.create({ doc: from });
		let threw = false;
		try {
			state = state.update({ changes }).state;
		} catch (e) {
			threw = true;
			console.error(`Threw RangeError for ${desc}:`, e);
		}
		assert(!threw, `applying changes for ${desc} does not throw RangeError`);
		assertEq(state.doc.toString(), to, `changes transform "${from}" into "${to}" accurately`);
	}
}

console.log("\n--- Test 14: unsynced edits visibility detects content differences ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "baseline");
	const undoManager = new Y.UndoManager(ytext);
	const harness = makeStubView(
		buildCompositionAwareCollab(ytext, undefined, { undoManager }),
		"baseline",
	);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never);
	harness.addUpdateListener((update) => plugin.update(update as never));

	// Initially in sync
	assertEq(plugin.hasUnsyncedEdits(), false, "fresh plugin has no unsynced edits");
	assertEq(plugin.getUnsyncedDelta().hasUnsynced, false, "delta reports no unsynced edits");
	assertEq(hasViewUnsyncedEdits(view as never), false, "hasViewUnsyncedEdits returns false");
	assertEq(getViewUnsyncedInfo(view as never).hasUnsynced, false, "getViewUnsyncedInfo returns false");

	// Simulate offline / unsynced edits by detaching view or pausing push,
	// or setting a different lastAgreedContent to simulate diverged local doc
	// Case A: Length changes (+5 chars)
	view.dispatch({ changes: { from: 8, to: 8, insert: "+more" } });
	// Under normal connected conditions, live typing pushes and advances lastAgreedContent
	assertEq(plugin.hasUnsyncedEdits(), false, "live typing when connected keeps agreed content synced");

	// Now simulate disconnection / unpushed residue (e.g. batch drop or offline hold)
	// by modifying the editor doc without updating ytext / lastAgreedContent:
	const conf = view.state.facet(ySyncFacet);
	view.dispatch({
		changes: { from: 13, to: 13, insert: "!" },
		annotations: kaosYSyncAnnotation.of(conf), // drops push from update()
	});
	assertEq(plugin.hasUnsyncedEdits(), true, "unpushed residue detected by hasUnsyncedEdits");
	const info1 = plugin.getUnsyncedDelta();
	assertEq(info1.hasUnsynced, true, "getUnsyncedDelta hasUnsynced is true");
	assertEq(info1.charDelta, 1, "charDelta accurately reflects +1 char");

	// Case B: Zero-length content change (replacement with identical length: "!" -> "?")
	view.dispatch({
		changes: { from: 13, to: 14, insert: "?" },
		annotations: kaosYSyncAnnotation.of(conf),
	});
	const info2 = plugin.getUnsyncedDelta();
	assertEq(info2.hasUnsynced, true, "zero-length diff (13 -> 14 replaced with 1 char) hasUnsynced is still true");
	assertEq(info2.charDelta, 1, "charDelta is still 1 compared to baseline");

	// Null view / unbound view safety check
	assertEq(hasViewUnsyncedEdits(null), false, "null view returns false");
	assertEq(getViewUnsyncedInfo(null).hasUnsynced, false, "null view returns hasUnsynced false");
	assertEq(getViewLastAgreedContent(null), null, "null view returns null last agreed content");

	plugin.destroy();
	undoManager.destroy();
	doc.destroy();
}

console.log("\n--- Test 15: Stage 3 Y.Doc map churn suppression on periodic reconcile ---");
{
	const doc = new Y.Doc();
	const sys = doc.getMap("sys");
	let updateCount = 0;
	doc.on("update", () => {
		updateCount++;
	});

	// Use real VaultSync prototype methods
	const vs = {
		sys,
		storedSchemaVersion: null,
		log: () => {},
	};
	Object.defineProperty(vs, "isInitialized", Object.getOwnPropertyDescriptor(VaultSync.prototype, "isInitialized")!);

	assertEq((vs as unknown as VaultSync).isInitialized, false, "initially not initialized");
	assertEq(updateCount, 0, "zero updates emitted before first call");

	// First call sets initialized
	VaultSync.prototype.markInitialized.call(vs);
	assertEq((vs as unknown as VaultSync).isInitialized, true, "marked initialized on first call");
	const initialUpdates = updateCount;
	assert(initialUpdates > 0, "updates emitted for initial sentinel setup");

	// Second consecutive call (asserting idempotency directly)
	VaultSync.prototype.markInitialized.call(vs);
	assertEq(updateCount, initialUpdates, "second call emits zero additional updates (idempotent)");

	// Simulate 50 consecutive 10-second reconcile passes while offline
	for (let i = 0; i < 50; i++) {
		VaultSync.prototype.markInitialized.call(vs);
	}

	// Must NOT emit any further updates!
	assertEq(updateCount, initialUpdates, "50 subsequent reconcile calls emit zero additional updates (churn suppressed)");
	assertEq((vs as unknown as VaultSync).isInitialized, true, "state remains initialized");
	doc.destroy();
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
