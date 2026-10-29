/**
 * Diagnostic repro for the 2026-10-02 Korean-IME corruption report on 1.13.6:
 * "consonants/English fine; the moment composition combines syllables, text
 * stops being reflected properly; input seems to land below the cursor."
 *
 * Drives CompositionAwareYSyncPluginValue through the REAL Chromium/macOS-IME
 * event interleavings established from @codemirror/view dist source:
 *
 *  - Core compositionend observer runs BEFORE extension domEventHandlers and
 *    sets inputState.composing = -1 synchronously, so our handler's
 *    isComposing() is false even though the final composition text is still
 *    in observer.pendingRecords (CM6 flushes it via Promise microtask AFTER
 *    all compositionend handlers return).
 *  - For rapid IME sessions the NEXT compositionstart can run before that
 *    pending flush; inputState.composing is then 0, and the public
 *    EditorView.composing getter is `composing > 0` — i.e. FALSE until the
 *    first DOM change of the new session is applied.
 *
 * Run: node --import jiti/register tests/composition-race-repro.ts
 */
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { ySyncFacet, YSyncConfig } from "y-codemirror.next";
import {
	CompositionAwareYSyncPluginValue,
	buildCompositionAwareCollab,
	flushCompositionResidue,
	getViewUnsyncedInfo,
	isCompositionHoldActive,
	isViewConflictHoldActive,
	kaosYSyncAnnotation,
	type CompositionHoldTelemetry,
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

/**
 * Stub view faithful to CM6's composing semantics: `view.composing` (the
 * public getter) maps inputState.composing > 0. composingPhase:
 *  -1 = no session, 0 = session started, no DOM change applied yet,
 *  >=1 = DOM changes applied this session.
 */
function makeStubView(extensions: ReturnType<typeof buildCompositionAwareCollab>, initialDoc = "") {
	let state = EditorState.create({ extensions, doc: initialDoc });
	const composingLevels = new WeakMap<object, number>();
	const viewObj: {
		state: EditorState;
		_composing: number;
		dispatch: (spec: Parameters<EditorState["update"]>[0]) => void;
	} = {
		get state() {
			return state;
		},
		_composing: -1,
		dispatch(spec) {
			const tr = state.update(spec);
			state = tr.state;
			const fakeUpdate = {
				docChanged: tr.docChanged,
				transactions: [tr],
				changes: tr.changes,
				view: viewProxy,
			};
			for (const listener of updateListeners) listener(fakeUpdate);
		},
	};
	const viewProxy = new Proxy(viewObj, {
		get(target, prop, receiver) {
			if (prop === "composing") {
				return (target as unknown as { _composing: number })._composing > 0;
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as unknown as {
		state: EditorState;
		_composing: number;
		dispatch: (spec: Parameters<EditorState["update"]>[0]) => void;
		composing: boolean;
		dom: { isConnected: boolean };
	};
	(viewProxy as unknown as { dom: unknown }).dom = { isConnected: true };
	const updateListeners: Array<(update: unknown) => void> = [];
	return { view: viewProxy, addUpdateListener: (l: () => void) => updateListeners.push(l) };
}

function setup(initialDoc: string, telemetry: CompositionHoldTelemetry = {}) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	if (initialDoc) ytext.insert(0, initialDoc);
	const undoManager = new Y.UndoManager(ytext);
	const extensions = buildCompositionAwareCollab(ytext, undefined, { undoManager, telemetry });
	const harness = makeStubView(extensions, initialDoc);
	const view = harness.view;
	const plugin = new CompositionAwareYSyncPluginValue(view as never, telemetry);
	harness.addUpdateListener((update) => plugin.update(update as never));
	return { doc, ytext, undoManager, view, plugin };
}

/** Real-CM6 faithful keystroke pipeline for one IME segment. */
function imeSegment(
	ctx: ReturnType<typeof setup>,
	text: string,
	opts: {
		/** pendingRecords at compositionend (final chars not yet in state) */
		pendingFinal?: string;
		/** remote ytext write during the session */
		remoteDuring?: string;
		/** call flushCompositionResidue mid-session (binding-target probe) */
		probeMidSession?: boolean;
		/** probe fires after this many chars of the in-session text */
		probeAfterChars?: number;
	},
): void {
	const { view, plugin, doc, ytext } = ctx;
	view._composing = 0; // compositionstart
	const committed = text.slice(0, text.length - (opts.pendingFinal?.length ?? 0));
	const tail = opts.pendingFinal ?? "";
	for (const ch of committed) {
		if (opts.probeMidSession && opts.probeAfterChars !== undefined &&
			committed.indexOf(ch) === opts.probeAfterChars) {
			flushCompositionResidue(view as never, "binding-target-divergence-probe");
		}
		view._composing += 1; // applyDOMChangeInner increments before dispatch
		view.dispatch({
			changes: { from: view.state.doc.length, to: view.state.doc.length, insert: ch },
			userEvent: "input.type.compose",
		});
	}
	if (opts.probeMidSession && opts.probeAfterChars === undefined) {
		flushCompositionResidue(view as never, "binding-target-divergence-probe");
	}
	if (opts.remoteDuring) {
		doc.transact(() => ytext.insert(0, opts.remoteDuring), "remote-origin");
	}
	// compositionend: core observer sets composing = -1 BEFORE our handler.
	view._composing = -1;
	plugin.onCompositionSessionEnded("compositionend");
	// pendingRecords flush — next task's microtask (after our handler).
	for (const ch of tail) {
		view.dispatch({
			changes: { from: view.state.doc.length, to: view.state.doc.length, insert: ch },
			userEvent: "input.type.compose",
		});
	}
}

// ---------------------------------------------------------------------------
console.log("\n=== R1: rapid sessions; next compositionstart precedes pending flush ===");
{
	const ctx = setup("x");
	const expected = "x" + "ㅁㄴㅇㄹ".repeat(8);
	// Faithful racy order per keystroke boundary:
	//   compositionend(prev) [stale residue push] → compositionstart(next)
	//   [composing=0, getter false] → pendingRecords flush dispatch of prev's
	//   final char [applyDOMChangeInner bumps composing→1 BEFORE dispatch, so
	//   the push is paused]. Last session ends with a plain compositionend.
	const chars = "ㅁㄴㅇㄹ".repeat(8).split("");
	let pendingFinal: string | null = null;
	ctx.view._composing = 0;
	for (const ch of chars) {
		// next key commits the open session and starts a new one
		ctx.view._composing = -1;
		ctx.plugin.onCompositionSessionEnded("compositionend");
		ctx.view._composing = 0; // compositionstart(ch)
		if (pendingFinal !== null) {
			ctx.view._composing += 1;
			ctx.view.dispatch({
				changes: { from: ctx.view.state.doc.length, to: ctx.view.state.doc.length, insert: pendingFinal },
				userEvent: "input.type.compose",
			});
		}
		pendingFinal = ch; // preedit char still uncommitted in DOM
	}
	// final boundary: compositionend + pending flush (getter false → pushable)
	ctx.view._composing = -1;
	ctx.plugin.onCompositionSessionEnded("compositionend");
	if (pendingFinal !== null) {
		ctx.view.dispatch({
			changes: { from: ctx.view.state.doc.length, to: ctx.view.state.doc.length, insert: pendingFinal },
			userEvent: "input.type.compose",
		});
	}
	const editor = ctx.view.state.doc.toString();
	const yt = ctx.ytext.toString();
	console.log(`  editor=${JSON.stringify(editor.slice(0, 40))}...`);
	console.log(`  ytext=${JSON.stringify(yt.slice(0, 40))}...`);
	assert(editor === expected, "R1 editor keeps every consonant");
	assert(yt === expected, "R1 ytext converges (no loss)");
	assert(yt === editor, "R1 mirror holds");
	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R2: probe (binding-target-divergence) pushes preedit mid-composition, then remote + finalize ===");
{
	const ctx = setup("base|");
	// session: 하 → probe fires (preedit "하" in state, push paused) → remote → 한 (replace) → compositionend
	ctx.view._composing = 0;
	ctx.view._composing += 1;
	ctx.view.dispatch({
		changes: { from: ctx.view.state.doc.length, to: ctx.view.state.doc.length, insert: "하" },
		userEvent: "input.type.compose",
	});
	const pushedMidComposition = flushCompositionResidue(ctx.view as never, "binding-target-divergence-probe");
	console.log(`  probe pushed mid-composition: ${pushedMidComposition}, ytext=${JSON.stringify(ctx.ytext.toString())}`);
	// remote event during the session → hold
	ctx.doc.transact(() => ctx.ytext.insert(0, "R"), "remote-origin");
	// composition finalizes: 하 → 한 (in-place replace as compositionupdate)
	ctx.view.dispatch({
		changes: { from: ctx.view.state.doc.length - 1, to: ctx.view.state.doc.length, insert: "한" },
		userEvent: "input.type.compose",
	});
	ctx.view._composing = -1;
	ctx.plugin.onCompositionSessionEnded("compositionend");
	const editor = ctx.view.state.doc.toString();
	const yt = ctx.ytext.toString();
	console.log(`  editor=${JSON.stringify(editor)}`);
	console.log(`  ytext=${JSON.stringify(yt)}`);
	assert(editor === "Rbase|한", "R2 editor keeps exactly one composed syllable");
	assert(yt === "Rbase|한", "R2 ytext keeps exactly one composed syllable (no 하/한 duplication)");
	assert(yt === editor, "R2 mirror holds");
	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R3: hold (remote mid-composition) + compositionend with pending final chars ===");
{
	const ctx = setup("note:");
	// composing 한 in state, 글 still pending at compositionend
	ctx.view._composing = 0;
	ctx.view._composing += 1;
	ctx.view.dispatch({
		changes: { from: ctx.view.state.doc.length, to: ctx.view.state.doc.length, insert: "한" },
		userEvent: "input.type.compose",
	});
	// remote insert during composition → hold armed
	ctx.doc.transact(() => ctx.ytext.insert(0, "[B] "), "remote-origin");
	// compositionend fires BEFORE pendingRecords flush (final "글" not in state)
	ctx.view._composing = -1;
	ctx.plugin.onCompositionSessionEnded("compositionend");
	const midEditor = ctx.view.state.doc.toString();
	const midYtext = ctx.ytext.toString();
	console.log(`  post-flush editor=${JSON.stringify(midEditor)} ytext=${JSON.stringify(midYtext)}`);
	// CM6 pending flush now applies the final composition chars as a user txn
	ctx.view.dispatch({
		changes: { from: ctx.view.state.doc.length, to: ctx.view.state.doc.length, insert: "글" },
		userEvent: "input.type.compose",
	});
	const editor = ctx.view.state.doc.toString();
	const yt = ctx.ytext.toString();
	console.log(`  final editor=${JSON.stringify(editor)} ytext=${JSON.stringify(yt)}`);
	const count = (s: string, n: string) => s.split(n).length - 1;
	assert(count(editor, "한글") === 1 && editor.includes("[B]"), "R3 editor has the full commit + remote exactly once");
	assert(count(yt, "한글") === 1 && yt.includes("[B]"), "R3 ytext has the full commit + remote exactly once");
	assert(yt === editor, "R3 mirror holds");
	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R4: offline composition session -> reconnect merge ===");
{
	const ctx = setup("seed-line\n");
	// Disconnected offline typing: local user edits editor without Yjs push
	const conf = ctx.view.state.facet(ySyncFacet);
	ctx.view.dispatch({
		changes: { from: 10, to: 10, insert: "[local notes]" },
		annotations: kaosYSyncAnnotation.of(conf),
	});
	assert(ctx.plugin.hasUnsyncedEdits(), "R4 editor has unsynced edits while offline");
	assert(ctx.view.state.doc.toString() === "seed-line\n[local notes]", "R4 editor holds offline text");
	assert(ctx.ytext.toString() === "seed-line\n", "R4 Y.Text untouched while disconnected");

	// Remote user edits disjoint region (inserts title at index 0)
	ctx.doc.transact(() => {
		ctx.ytext.insert(0, "[Remote Title]\n");
	}, "remote-origin");

	// Remote delta arrived via _observer:
	// Local editor must NOT be clobbered with stale offsets!
	assert(ctx.view.state.doc.toString().includes("[local notes]"), "R4 editor preserves local offline text on remote arrival");

	// Convergence flush runs (e.g. reconnect or blur/boundary)
	ctx.plugin.flush("binding-boundary");
	const finalEditor = ctx.view.state.doc.toString();
	const finalYtext = ctx.ytext.toString();
	console.log(`  final editor=${JSON.stringify(finalEditor)} ytext=${JSON.stringify(finalYtext)}`);

	assert(finalEditor.includes("[Remote Title]\n"), "R4 editor has remote title");
	assert(finalEditor.includes("[local notes]"), "R4 editor has local notes");
	assert(finalYtext === finalEditor, "R4 Y.Text converged with editor without text loss");
	assert(!ctx.plugin.hasUnsyncedEdits(), "R4 mirror fully synced");
	assert(getViewUnsyncedInfo(ctx.view).conflictHold === false, "R4 non-conflict path never sets conflictHold flag");

	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R5: recovery hold fail-closed protection (no quiet overwrite) ===");
{
	let conflictReceived: { base: string; editor: string; ytext: string } | null = null;
	const ctx = setup("Original paragraph for testing.", {
		onConflict: (info) => {
			conflictReceived = info;
		},
	});

	// Local user edits entire sentence while disconnected
	const conf = ctx.view.state.facet(ySyncFacet);
	ctx.view.dispatch({
		changes: { from: 0, to: 31, insert: "Local revision of paragraph." },
		annotations: kaosYSyncAnnotation.of(conf),
	});
	assert(ctx.plugin.hasUnsyncedEdits(), "R5 local edits detected");

	// Remote user concurrently replaces the exact same sentence
	ctx.doc.transact(() => {
		ctx.ytext.delete(0, 31);
		ctx.ytext.insert(0, "Remote conflicting revision.");
	}, "remote-origin");

	// _observer attempts push-only drain, fails because edits conflict,
	// and fails closed: editor must NOT be quietly overwritten!
	const currentEditor = ctx.view.state.doc.toString();
	const currentYtext = ctx.ytext.toString();
	console.log(`  editor=${JSON.stringify(currentEditor)} ytext=${JSON.stringify(currentYtext)}`);

	assert(currentEditor === "Local revision of paragraph.", "R5 editor is NOT clobbered by remote projection");
	assert(currentYtext === "Remote conflicting revision.", "R5 Y.Text retains remote CRDT state");
	assert(conflictReceived !== null, "R5 onConflict telemetry fired");
	if (conflictReceived) {
		assert((conflictReceived as { base: string }).base === "Original paragraph for testing.", "R5 base preserved in conflict info");
		assert((conflictReceived as { editor: string }).editor === "Local revision of paragraph.", "R5 editor preserved in conflict info");
		assert((conflictReceived as { ytext: string }).ytext === "Remote conflicting revision.", "R5 remote ytext preserved in conflict info");
	}
	assert(ctx.plugin.getLastAgreedContent() === "Original paragraph for testing.", "R5 lastAgreedContent preserved as base");

	// Assert holding is armed on conflict to freeze push
	assert(isCompositionHoldActive(ctx.view), "R5 holding is armed on conflict to freeze push");
	// Conflict hold must be distinguishable so the status bar can surface it online
	assert(isViewConflictHoldActive(ctx.view), "R5 conflict hold flag is set (no cap timer variant)");
	assert(getViewUnsyncedInfo(ctx.view).conflictHold === true, "R5 unsynced info carries conflictHold=true");
	assert(getViewUnsyncedInfo(null).conflictHold === false, "R5 null view reports conflictHold=false");

	// Further user typing must NOT push to ytext (push is frozen by holding state)
	ctx.view.dispatch({
		changes: { from: 0, to: 0, insert: "More typing while conflicted. " },
	});
	assert(ctx.ytext.toString() === "Remote conflicting revision.", "R5 further editor typing does NOT corrupt ytext");

	// Flush attempt must fail-closed and refuse to overwrite
	ctx.plugin.flush("cap-timeout");
	assert(ctx.view.state.doc.toString().startsWith("More typing"), "R5 editor text preserved across flush attempt");
	assert(ctx.ytext.toString() === "Remote conflicting revision.", "R5 ytext preserved across flush attempt");
	assert(isCompositionHoldActive(ctx.view), "R5 holding remains active to protect editor");
	assert(isViewConflictHoldActive(ctx.view), "R5 conflict hold flag survives flush refusal");

	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R6: onConflict payload contract (handler copy; production wiring is covered by editor-divergence-freeze-repro Test 10) ===");
{
	let divergenceListenerFired = false;
	const unboundDivergedViews = new Map<string, { leafId: string; path: string; crdtText: string; lastObservedEditorContent: string; baseContent: string }>();
	const recoveryEvidence = new WeakMap<object, { invalidate: () => void }>();
	const listeners = new Set<(path: string) => void>();
	listeners.add((path) => {
		if (path === "test-note.md") divergenceListenerFired = true;
	});

	const mockBinding = {
		path: "test-note.md",
		invalidated: false,
	};
	recoveryEvidence.set(mockBinding, {
		invalidate() { mockBinding.invalidated = true; },
	});

	// Setup context with onConflict handler matching editorBinding.ts:4498
	const ctx = setup("Original note text.", {
		onConflict: (info) => {
			recoveryEvidence.get(mockBinding)?.invalidate();
			unboundDivergedViews.set("leaf-1", {
				leafId: "leaf-1",
				path: "test-note.md",
				crdtText: info.ytext,
				lastObservedEditorContent: info.editor,
				baseContent: info.base,
			});
			for (const listener of listeners) {
				listener("test-note.md");
			}
		},
	});

	// Local user edits while offline
	const conf = ctx.view.state.facet(ySyncFacet);
	ctx.view.dispatch({
		changes: { from: 0, to: 19, insert: "Local modified text." },
		annotations: kaosYSyncAnnotation.of(conf),
	});

	// Remote user replaces the document
	ctx.doc.transact(() => {
		ctx.ytext.delete(0, 19);
		ctx.ytext.insert(0, "Remote conflicting text.");
	}, "remote-origin");

	assert(mockBinding.invalidated, "R6 linear recovery evidence invalidated on conflict");
	assert(divergenceListenerFired, "R6 recoveryEvidenceListeners notified for path");
	const divergedEvidence = unboundDivergedViews.get("leaf-1");
	assert(divergedEvidence !== undefined, "R6 divergence evidence registered in unboundDivergedViews");
	assert(divergedEvidence?.baseContent === "Original note text.", "R6 base content forwarded accurately");
	assert(divergedEvidence?.lastObservedEditorContent === "Local modified text.", "R6 local editor content recorded");
	assert(divergedEvidence?.crdtText === "Remote conflicting text.", "R6 remote crdt text recorded");

	// Verify push freeze: subsequent keystroke must not push to ytext
	ctx.view.dispatch({
		changes: { from: 0, to: 0, insert: "Appended offline typing. " },
	});
	assert(ctx.ytext.toString() === "Remote conflicting text.", "R6 subsequent keystroke does NOT push to ytext");

	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R7: conflict arriving while a disjoint-edit hold is already armed is promoted, not silently frozen ===");
{
	const conflicts: Array<{ base: string; editor: string; ytext: string }> = [];
	const ctx = setup("line one\nline two\n", { onConflict: (info) => { conflicts.push(info); } });
	const conf = ctx.view.state.facet(ySyncFacet);
	// Unpushed local residue on line one.
	ctx.view.dispatch({
		changes: { from: 0, to: 8, insert: "LOCAL one" },
		annotations: kaosYSyncAnnotation.of(conf),
	});
	// Disjoint remote edit -> ordinary hold with cap timer (no conflict yet).
	ctx.doc.transact(() => { ctx.ytext.insert(ctx.ytext.length, "remote three\n"); }, "remote-origin");
	assert(isCompositionHoldActive(ctx.view), "R7 disjoint remote edit arms an ordinary hold");
	assert(!isViewConflictHoldActive(ctx.view), "R7 ordinary hold is not a conflict hold");
	// Overlapping remote edit while holding: observer only bumps heldEvents.
	ctx.doc.transact(() => { ctx.ytext.delete(0, 8); ctx.ytext.insert(0, "REMOTE one"); }, "remote-origin");
	assert(conflicts.length === 0, "R7 overlap under an existing hold is not yet classified");

	ctx.plugin.flush("cap-timeout");
	assert(isCompositionHoldActive(ctx.view), "R7 hold stays armed after conflicting flush");
	assert(isViewConflictHoldActive(ctx.view), "R7 flush promotes the hold to a conflict hold");
	assert(conflicts.length === 1, "R7 onConflict fired once on promotion");
	assert(conflicts[0]?.base === "line one\nline two\n", "R7 conflict carries the original 3-way base");
	assert(conflicts[0]?.editor === "LOCAL one\nline two\n", "R7 conflict carries local editor text");
	assert(conflicts[0]?.ytext === "REMOTE one\nline two\nremote three\n", "R7 conflict carries remote text");

	ctx.view.dispatch({ changes: { from: 0, to: 0, insert: ">>" } });
	assert(ctx.ytext.toString() === "REMOTE one\nline two\nremote three\n", "R7 typing after promotion is not pushed");
	ctx.plugin.flush("blur");
	assert(conflicts.length === 1, "R7 repeated flush refusals do not re-fire onConflict");

	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

// ---------------------------------------------------------------------------
console.log("\n=== R8: Korean IME composition overlapping a remote edit -> conflict hold on compositionend ===");
{
	let conflictCount = 0;
	const ctx = setup("hello world", { onConflict: () => { conflictCount++; } });
	ctx.view._composing = 1;
	// Composition pushes normally (composition alone does not pause the push).
	ctx.view.dispatch({ changes: { from: 0, to: 5, insert: "안녕" }, userEvent: "input.type.compose" });
	assert(ctx.ytext.toString() === "안녕 world", "R8 composition text pushed before the remote edit");
	// Remote edit mid-composition arms the composition hold.
	ctx.doc.transact(() => { ctx.ytext.delete(0, 2); ctx.ytext.insert(0, "REMOTE"); }, "remote-origin");
	assert(isCompositionHoldActive(ctx.view), "R8 remote edit during composition arms a hold");
	// IME rewrites the same range while frozen.
	ctx.view.dispatch({ changes: { from: 0, to: 2, insert: "반가워" }, userEvent: "input.type.compose" });
	ctx.view._composing = -1;
	ctx.plugin.onCompositionSessionEnded("compositionend");

	assert(ctx.view.state.doc.toString() === "반가워 world", "R8 local IME text is not clobbered");
	assert(ctx.ytext.toString() === "REMOTE world", "R8 remote text is not overwritten");
	assert(isViewConflictHoldActive(ctx.view), "R8 compositionend flush promotes to a conflict hold");
	assert(conflictCount === 1, "R8 onConflict fired once");
	assert(getViewUnsyncedInfo(ctx.view).conflictHold === true, "R8 unsynced info exposes the conflict hold");

	ctx.plugin.destroy();
	ctx.undoManager.destroy();
	ctx.doc.destroy();
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
