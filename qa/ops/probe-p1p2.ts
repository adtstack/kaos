/**
 * Empirical verification of review findings P1/P2 against the branch
 * fix/sync-visibility-reconnect-hardening (commits f825095 + 479d553).
 *
 * P2: "pre-projection-drain" can never drain — inside _observer the ytext
 *     already contains the remote change, so a push-only plan (ytext === base)
 *     is impossible; local residue must NOT appear in ytext before the flush.
 * P1: after a conflicting overlap the conflict branch drops the projection and
 *     arms nothing; continued local typing then pushes at stale offsets and
 *     the unsynced-edits indicator is blind to the resulting mirror divergence.
 *
 * Run: node --import jiti/register qa/ops/probe-p1p2.ts
 */
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { ySyncFacet } from "y-codemirror.next";
import {
	CompositionAwareYSyncPluginValue,
	buildCompositionAwareCollab,
	isCompositionHoldActive,
	kaosYSyncAnnotation,
	type CompositionHoldTelemetry,
} from "../../src/sync/compositionAwareYSync";

function makeStubView(extensions: ReturnType<typeof buildCompositionAwareCollab>, initialDoc = "") {
	let state = EditorState.create({ extensions, doc: initialDoc });
	const updateListeners: Array<(update: unknown) => void> = [];
	const viewObj = {
		get state() {
			return state;
		},
		_composing: -1,
		dispatch(spec: Parameters<EditorState["update"]>[0]) {
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
		get(target: typeof viewObj, prop: string | symbol, receiver: unknown) {
			if (prop === "composing") return target._composing > 0;
			return Reflect.get(target, prop, receiver);
		},
	}) as unknown as { state: EditorState; dispatch: (spec: never) => void; composing: boolean; dom: { isConnected: boolean } };
	(viewProxy as unknown as { dom: unknown }).dom = { isConnected: true };
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
	const conf = view.state.facet(ySyncFacet);
	return { doc, ytext, undoManager, view, plugin, conf };
}

console.log("=== P2 probe: can pre-projection-drain ever push residue? ===");
{
	let holds = 0;
	const ctx = setup("seed-line\n", { onHold: () => holds++ });
	ctx.view.dispatch({
		changes: { from: 10, to: 10, insert: "[local notes]" },
		annotations: kaosYSyncAnnotation.of(ctx.conf),
	} as never);
	console.log("  residue present:", ctx.plugin.hasUnsyncedEdits());
	console.log("  ytext before remote:", JSON.stringify(ctx.ytext.toString()));
	ctx.doc.transact(() => ctx.ytext.insert(0, "[R]\n"), "remote-origin");
	const after = ctx.ytext.toString();
	console.log("  ytext after remote observer:", JSON.stringify(after));
	console.log("  drain pushed residue into ytext?:", after.includes("[local notes]"), "(false = dead branch confirmed)");
	console.log("  editor kept local text?:", ctx.view.state.doc.toString().includes("[local notes]"));
	console.log("  hold armed instead?:", isCompositionHoldActive(ctx.view), "| onHold fired:", holds);
}

console.log("\n=== P1 probe: post-conflict continued typing ===");
{
	let conflicts = 0;
	const ctx = setup("Original paragraph for testing.", { onConflict: () => conflicts++ });
	ctx.view.dispatch({
		changes: { from: 0, to: 31, insert: "Local revision of paragraph." },
		annotations: kaosYSyncAnnotation.of(ctx.conf),
	} as never);
	ctx.doc.transact(() => {
		ctx.ytext.delete(0, 31);
		ctx.ytext.insert(0, "Remote conflicting revision.");
	}, "remote-origin");
	console.log("  conflicts fired:", conflicts, "(injected telemetry — production wiring passes none)");
	console.log("  hold armed after conflict?:", isCompositionHoldActive(ctx.view), "(false = pushes continue)");
	console.log("  editor after conflict:", JSON.stringify(ctx.view.state.doc.toString()));
	console.log("  ytext after conflict:", JSON.stringify(ctx.ytext.toString()));

	// Continued local typing — plain user transaction (no self-annotation).
	ctx.view.dispatch({ changes: { from: 27, to: 27, insert: "!!" } } as never);
	const editorFinal = ctx.view.state.doc.toString();
	const ytextFinal = ctx.ytext.toString();
	console.log("  editor after typing '!!':", JSON.stringify(editorFinal));
	console.log("  ytext after typing '!!':", JSON.stringify(ytextFinal));
	console.log("  mirror equal?:", editorFinal === ytextFinal, "(false = silent divergence)");
	console.log("  unsynced indicator blind?:", !ctx.plugin.hasUnsyncedEdits(), "(true = indicator sees nothing)");
}
