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
	isCompositionHoldActive,
	kaosYSyncAnnotation,
	planCompositionFlush,
} from "../src/sync/compositionAwareYSync";

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

console.log("\n--- Test 3b: composition pauses the push even without a remote event ---");
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
	assertEq(ytext.toString(), "seed", "composition text is not pushed while composing");
	assertEq(view.state.doc.toString(), "seed한글", "editor holds the composition text");

	// compositionend with no remote → push-only resync restores the mirror.
	view.composing = false;
	plugin.onCompositionSessionEnded("compositionend");
	assertEq(ytext.toString(), "seed한글", "final composition pushed on session end");
	assertEq(ytext.toString(), view.state.doc.toString(), "mirror restored without a hold");

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

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
