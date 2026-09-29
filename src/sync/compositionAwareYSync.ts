/**
 * Composition-aware replacement for y-codemirror.next's ySync plugin.
 *
 * The stock plugin projects remote Y.Text deltas into CodeMirror the instant
 * they arrive, with no composition guard. A projection that lands while an
 * IME composition is active rewrites the document under the composition and
 * CM6 restarts the composition session — the user sees just-typed characters
 * vanish or duplicate ("입력 중이던 글씨가 꼬이는").
 *
 * Strategy (CRDT-safe by construction — this never decides which concurrent
 * edit wins, it only schedules when the local editor displays remote work):
 *
 *   - HOLD: when a remote event arrives while composing, skip the projection
 *     dispatch AND pause the CM→Y push. Pausing the push is the essential
 *     half: the stock push maps editor-absolute offsets onto Y.Text indices
 *     under the editor==ytext mirror assumption, so withholding projections
 *     while still pushing would land local typing at pre-remote offsets and
 *     transpose characters in the SHARED document. With the push paused,
 *     neither side is ever written at a stale position, so no offset
 *     remapping is needed at all.
 *   - FLUSH: on compositionend / blur / unbind / a hard cap, converge both
 *     sides with a character-granularity three-way merge
 *     (mergeConcurrentEdits: base = pre-remote agreed content, ours = the
 *     live editor, theirs = ytext including the remote change). ytext is
 *     written first (self-origin, never re-projected), then the editor
 *     receives one diff transaction — that order makes the existing
 *     transaction filters classify the flush as a normal Yjs patch.
 *
 * Integration is surgical: yCollab()'s extension bundle keeps everything
 * (remote cursors, undo manager) except the stock ySync ViewPlugin, which is
 * removed by identity and replaced here. The lib's ySyncFacet is reused with
 * our own YSyncConfig so the lib's remaining plugins and KAOS's guards all
 * observe one consistent config (facet combine is last-wins).
 *
 * The lib's ySyncAnnotation is not exported by the package (the exports map
 * blocks subpath imports), so this module defines its own annotation
 * identity. The only in-lib consumer of the lib annotation is the undo
 * plugin's selection bookkeeping, which treats an unannotated transaction as
 * an ordinary selection change — harmless.
 */
import { Annotation, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySync, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import * as Y from "yjs";
import diff from "fast-diff";
import { applyDiffToYText, mergeConcurrentEdits } from "./diff";

/**
 * Absolute cap on a hold. Must stay under the DiskMirror open-write idle
 * (1500ms) and the open-file reconcile idle (3000ms) so no other lane ever
 * observes the bounded editor≠ytext window; it also bounds the damage of a
 * composition session that never fires compositionend (app backgrounded
 * mid-IME). A single unbroken composition longer than this cap is rare; on
 * expiry the flush may still land mid-composition — accepted residual risk.
 */
const COMPOSITION_HOLD_CAP_MS = 2500;

/** Annotation marking transactions this plugin originated (push or flush). */
export const kaosYSyncAnnotation = Annotation.define<unknown>();

export interface CompositionHoldTelemetry {
	onHold?: (info: {
		heldEvents: number;
		baseLength: number;
	}) => void;
	onFlush?: (info: {
		reason: CompositionFlushReason;
		kind: CompositionFlushPlan["kind"];
		heldEvents: number;
		baseLength: number;
		editorLength: number;
		ytextLength: number;
		mergedLength: number | null;
	}) => void;
}

export type CompositionFlushReason =
	| "compositionend"
	| "blur"
	| "destroy"
	| "cap-timeout";

export type CompositionFlushPlan =
	| { kind: "no-op" }
	| { kind: "push-only"; mergedText: string }
	| { kind: "projection-only"; mergedText: string }
	| { kind: "merge"; mergedText: string };

/**
 * Decide how to converge editor and ytext after a hold. Pure — no Yjs, no
 * CodeMirror, no I/O. `base` is the content both sides agreed on when the
 * hold started (the pre-remote editor document), `editor` is the live local
 * composition result, `ytext` includes the held remote change(s).
 */
export function planCompositionFlush(
	base: string,
	editor: string,
	ytext: string,
): CompositionFlushPlan {
	if (editor === ytext) return { kind: "no-op" };
	if (ytext === base) return { kind: "push-only", mergedText: editor };
	if (editor === base) return { kind: "projection-only", mergedText: ytext };
	return { kind: "merge", mergedText: mergeConcurrentEdits(base, editor, ytext).mergedText };
}

interface CompositionHoldState {
	holding: boolean;
	heldEvents: number;
	baseText: string | null;
}

const holdStates = new WeakMap<EditorView, CompositionHoldState>();
const pluginByView = new WeakMap<EditorView, CompositionAwareYSyncPluginValue>();

/** True while the composition-aware sync is withholding a projection. */
export function isCompositionHoldActive(view: EditorView | null | undefined): boolean {
	if (!view) return false;
	return holdStates.get(view)?.holding === true;
}

interface YTextDeltaOp {
	insert?: unknown;
	delete?: number;
	retain?: number;
}

export class CompositionAwareYSyncPluginValue {
	readonly view: EditorView;
	readonly conf: YSyncConfig;
	private readonly telemetry: CompositionHoldTelemetry;
	private readonly state: CompositionHoldState = {
		holding: false,
		heldEvents: 0,
		baseText: null,
	};
	private readonly _ytext: Y.Text;
	private capTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Content both sides last agreed on (after every push, projection, or
	 * flush). While a composition pauses the push, the editor runs ahead of
	 * ytext, so a hold starting mid-composition cannot derive the merge base
	 * from either side directly — this cache is that base.
	 */
	private lastAgreedContent: string | null = null;

	private readonly _observer = (event: Y.YTextEvent, tr: Y.Transaction): void => {
		if (tr.origin === this.conf) return;
		if (this.shouldHold()) {
			if (!this.state.holding) {
				// The merge base is the content both sides last agreed on. With
				// the composition push-pause this can lag the editor (mid-
				// composition text) — using the live editor document here would
				// split composition runs across the remote insert; the cache
				// keeps them one coherent "ours" hunk in the 3-way merge.
				this.state.baseText = this.lastAgreedContent ?? this.view.state.doc.toString();
				this.state.holding = true;
				this.armCapTimer();
				this.telemetry.onHold?.({
					heldEvents: this.state.heldEvents,
					baseLength: this.state.baseText.length,
				});
			}
			this.state.heldEvents += 1;
			return;
		}
		this.dispatchProjection(event.delta as YTextDeltaOp[]);
	};

	constructor(view: EditorView, telemetry: CompositionHoldTelemetry = {}) {
		this.view = view;
		this.conf = view.state.facet(ySyncFacet);
		this.telemetry = telemetry;
		this._ytext = this.conf.ytext as Y.Text;
		this._ytext.observe(this._observer);
		this.lastAgreedContent = view.state.doc.toString();
		holdStates.set(view, this.state);
	}

	private shouldHold(): boolean {
		if (this.state.holding) return true;
		return this.isComposing();
	}

	private isComposing(): boolean {
		try {
			return this.view.composing === true;
		} catch {
			return false;
		}
	}

	/**
	 * compositionend/blur entry: flush an active hold, or — when the
	 * composition push-pause left unpushed local text with no remote event —
	 * push the final composition so the mirror is restored immediately.
	 */
	onCompositionSessionEnded(reason: CompositionFlushReason): void {
		if (this.state.holding) {
			this.flush(reason);
			return;
		}
		if (!this.isComposing()) {
			const editorText = this.view.state.doc.toString();
			// eslint-disable-next-line @typescript-eslint/no-base-to-string -- yjs typings omit Y.Text#toString; the runtime implementation is real
			const ytextText = this._ytext.toString();
			if (editorText !== ytextText) {
				applyDiffToYText(this._ytext, ytextText, editorText, this.conf);
				this.lastAgreedContent = editorText;
			}
		}
	}

	private armCapTimer(): void {
		if (this.capTimer != null) return;
		this.capTimer = setTimeout(() => {
			this.capTimer = null;
			if (this.state.holding) this.flush("cap-timeout");
		}, COMPOSITION_HOLD_CAP_MS);
	}

	private clearCapTimer(): void {
		if (this.capTimer != null) {
			clearTimeout(this.capTimer);
			this.capTimer = null;
		}
	}

	/**
	 * Converge editor and ytext. ytext is written first (self-origin, so the
	 * observer never re-projects it); the editor then receives one diff
	 * transaction annotated as a sync patch so downstream filters classify it
	 * as a normal Yjs projection.
	 */
	flush(reason: CompositionFlushReason): void {
		if (!this.state.holding) return;
		const base = this.state.baseText ?? this.view.state.doc.toString();
		this.state.holding = false;
		this.state.baseText = null;
		this.clearCapTimer();
		const heldEvents = this.state.heldEvents;
		this.state.heldEvents = 0;

		const editorText = this.view.state.doc.toString();
		// eslint-disable-next-line @typescript-eslint/no-base-to-string -- yjs typings omit Y.Text#toString; the runtime implementation is real
		const ytextText = this._ytext.toString();
		const plan = planCompositionFlush(base, editorText, ytextText);

		if (plan.kind !== "no-op" && plan.mergedText !== ytextText) {
			applyDiffToYText(this._ytext, ytextText, plan.mergedText, this.conf);
		}
		if (plan.kind !== "no-op" && plan.mergedText !== editorText) {
			this.dispatchContentDiff(editorText, plan.mergedText);
		}
		if (plan.kind !== "no-op") this.lastAgreedContent = plan.mergedText;
		this.telemetry.onFlush?.({
			reason,
			kind: plan.kind,
			heldEvents,
			baseLength: base.length,
			editorLength: editorText.length,
			ytextLength: ytextText.length,
			mergedLength: plan.kind === "no-op" ? null : plan.mergedText.length,
		});
	}

	/** Stock lib projection path: delta → absolute-position changes. */
	private dispatchProjection(delta: YTextDeltaOp[]): void {
		const changes: Array<{ from: number; to: number; insert: string }> = [];
		let pos = 0;
		for (const d of delta) {
			if (typeof d.insert === "string") {
				changes.push({ from: pos, to: pos, insert: d.insert });
			} else if (typeof d.delete === "number") {
				changes.push({ from: pos, to: pos + d.delete, insert: "" });
				pos += d.delete;
			} else if (typeof d.retain === "number") {
				pos += d.retain;
			}
		}
		if (changes.length > 0) {
			this.dispatchChanges(changes);
		}
	}

	/** One transaction taking the editor from `from` to `to` by minimal diff. */
	private dispatchContentDiff(from: string, to: string): void {
		const changes: Array<{ from: number; to: number; insert: string }> = [];
		let pos = 0;
		for (const [op, text] of diff(from, to)) {
			if (op === 0) {
				pos += text.length;
			} else if (op === -1) {
				changes.push({ from: pos, to: pos + text.length, insert: "" });
				pos += text.length;
			} else {
				changes.push({ from: pos, to: pos, insert: text });
				pos += text.length;
			}
		}
		if (changes.length > 0) {
			this.dispatchChanges(changes);
		}
	}

	private dispatchChanges(changes: Array<{ from: number; to: number; insert: string }>): void {
		let attached = false;
		try {
			attached = this.view.dom.isConnected;
		} catch {
			attached = false;
		}
		if (!attached) {
			// The view is being torn down (rebind/unbind); writing to it now
			// would dispatch on a dead surface. The ytext side already carries
			// the merge; the next bind's mirror check resyncs the editor.
			return;
		}
		this.view.dispatch({
			changes,
			annotations: kaosYSyncAnnotation.of(this.conf),
		});
		this.lastAgreedContent = this.view.state.doc.toString();
	}

	/**
	 * CM→Y push. Guard mirrors the stock plugin (including its batched-update
	 * quirk, which KAOS's resyncDroppedBatchEdits compensates) plus the hold
	 * pause: during a hold the editor's positions describe a document ytext
	 * has not agreed to, so pushing would write stale offsets.
	 */
	update(update: ViewUpdate): void {
		const first = update.transactions[0];
		if (
			!update.docChanged ||
			(first !== undefined && first.annotation(kaosYSyncAnnotation) === this.conf)
		) {
			return;
		}
		if (this.state.holding || this.isComposing()) return;
		const ytext = this._ytext;
		ytext.doc?.transact(() => {
			let adj = 0;
			update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
				const insertText = insert.sliceString(0, insert.length, "\n");
				if (fromA !== toA) {
					ytext.delete(fromA + adj, toA - fromA);
				}
				if (insertText.length > 0) {
					ytext.insert(fromA + adj, insertText);
				}
				adj += insertText.length - (toA - fromA);
			});
		}, this.conf);
		this.lastAgreedContent = this.view.state.doc.toString();
	}

	destroy(): void {
		this.flush("destroy");
		this._ytext.unobserve(this._observer);
		holdStates.delete(this.view);
		this.clearCapTimer();
	}
}

/**
 * Build the full collab bundle: everything yCollab() provides (remote
 * cursors, undo manager, facet wiring) with the stock ySync ViewPlugin
 * swapped for the composition-aware variant.
 */
export function buildCompositionAwareCollab(
	ytext: Y.Text,
	awareness: unknown,
	options: {
		undoManager: Y.UndoManager;
		telemetry?: CompositionHoldTelemetry;
	},
): Extension[] {
	const libExtensions = yCollab(ytext, awareness, {
		undoManager: options.undoManager,
	}) as Extension[];
	const stripped = libExtensions.filter((extension: Extension) => extension !== ySync);
	const telemetry = options.telemetry ?? {};
	return [
		...stripped,
		ySyncFacet.of(new YSyncConfig(ytext, awareness)),
		EditorView.domEventHandlers({
			compositionend: (_event, view) => {
				pluginByView.get(view)?.onCompositionSessionEnded("compositionend");
				return false;
			},
			blur: (_event, view) => {
				pluginByView.get(view)?.onCompositionSessionEnded("blur");
				return false;
			},
		}),
		ViewPlugin.fromClass(
			class extends CompositionAwareYSyncPluginValue {
				constructor(view: EditorView) {
					super(view, telemetry);
					pluginByView.set(view, this);
				}

				override destroy(): void {
					pluginByView.delete(this.view);
					super.destroy();
				}
			},
		),
	];
}
