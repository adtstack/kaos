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
	onConflict?: (info: {
		base: string;
		editor: string;
		ytext: string;
	}) => void;
}

export type CompositionFlushReason =
	| "compositionend"
	| "compositionend-lag"
	| "blur"
	| "destroy"
	| "cap-timeout"
	| "binding-boundary"
	| "binding-target-divergence-probe";

export type CompositionFlushPlan =
	| { kind: "no-op" }
	| { kind: "push-only"; mergedText: string }
	| { kind: "projection-only"; mergedText: string }
	| { kind: "merge"; mergedText: string; hasConflict?: boolean };

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
	const merge = mergeConcurrentEdits(base, editor, ytext);
	return {
		kind: "merge",
		mergedText: merge.mergedText,
		hasConflict: merge.hadConflictingOverlap,
	};
}

/**
 * Compute the CodeMirror changes required to transform `from` into `to` via fast-diff.
 * Pure function: op === 0 advances pos; op === -1 adds deletion and advances pos;
 * op === 1 adds insertion without advancing pos (since inserted text does not consume
 * characters from the original document).
 */
export function computeContentDiffChanges(
	from: string,
	to: string,
): Array<{ from: number; to: number; insert: string }> {
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
		}
	}
	return changes;
}

interface CompositionHoldState {
	holding: boolean;
	/**
	 * True while the hold was armed by the stale-projection-guard conflict
	 * branch (no cap timer; push stays frozen until recovery resolution).
	 * Cleared when the hold is released by a successful flush.
	 */
	conflictHold: boolean;
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

/**
 * Flush any unpushed local composition residue from the editor into Y.Text.
 * Safe to call at binding boundaries; no-op if holding a remote projection
 * or if editor and Y.Text are already identical.
 * Returns true if a diff was pushed to Y.Text.
 */
export function flushCompositionResidue(
	view: EditorView | null | undefined,
	reason: CompositionFlushReason = "binding-boundary",
): boolean {
	if (!view) return false;
	const plugin = pluginByView.get(view);
	if (!plugin) return false;
	return plugin.flushResidualComposition(reason);
}

/**
 * Returns true if the given EditorView has unpushed local edits that differ
 * from lastAgreedContent.
 */
export function hasViewUnsyncedEdits(view: EditorView | null | undefined): boolean {
	if (!view) return false;
	const plugin = pluginByView.get(view);
	if (!plugin) return false;
	return plugin.hasUnsyncedEdits();
}

/**
 * Returns unsynced edit details for the given EditorView, including whether
 * the view is frozen by a conflict hold (stale-projection guard).
 */
export function getViewUnsyncedInfo(
	view: EditorView | null | undefined,
): { hasUnsynced: boolean; charDelta: number; conflictHold: boolean } {
	if (!view) return { hasUnsynced: false, charDelta: 0, conflictHold: false };
	const plugin = pluginByView.get(view);
	if (!plugin) return { hasUnsynced: false, charDelta: 0, conflictHold: false };
	return plugin.getUnsyncedDelta();
}

/**
 * Returns true while the view's push is frozen by a conflict hold awaiting
 * recovery resolution.
 */
export function isViewConflictHoldActive(view: EditorView | null | undefined): boolean {
	if (!view) return false;
	return holdStates.get(view)?.conflictHold === true;
}

/**
 * Returns the last agreed content snapshot for the given EditorView.
 */
export function getViewLastAgreedContent(view: EditorView | null | undefined): string | null {
	if (!view) return null;
	const plugin = pluginByView.get(view);
	if (!plugin) return null;
	return plugin.getLastAgreedContent();
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
		conflictHold: false,
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

		let attached = false;
		try {
			attached = this.view.dom.isConnected;
		} catch {
			attached = false;
		}
		if (!attached) {
			return;
		}

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

		if (this.hasUnsyncedEdits()) {
			// Stale projection guard: local editor has diverged from lastAgreedContent
			// (unpushed edits or offline typing). Applying remote delta directly
			// with stale offsets could corrupt local text or CRDT.
			const base = this.lastAgreedContent ?? this.view.state.doc.toString();
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			const ytextText = this._ytext.toString();
			const editorText = this.view.state.doc.toString();
			const plan = planCompositionFlush(base, editorText, ytextText);

			if (plan.kind === "merge" && plan.hasConflict) {
				// Conflicting overlap: Fail-closed.
				// 1. Arm hold without cap timer so subsequent keystrokes in update()
				// are frozen and cannot push stale offsets to ytext.
				this.state.baseText = base;
				this.state.holding = true;
				this.state.conflictHold = true;
				this.clearCapTimer();
				// 2. Fire onConflict callback so binding layer can register divergence.
				this.telemetry.onConflict?.({
					base,
					editor: editorText,
					ytext: ytextText,
				});
				return;
			}

			// Non-conflicting / disjoint merge: arm hold so subsequent flush (or reconnect boundary) converges both sides.
			if (!this.state.holding) {
				this.state.baseText = base;
				this.state.holding = true;
				this.armCapTimer();
				this.telemetry.onHold?.({
					heldEvents: this.state.heldEvents,
					baseLength: base.length,
				});
			}
			this.state.heldEvents += 1;
			return;
		}

		this.dispatchProjection(event.delta as YTextDeltaOp[]);
	};

	/**
	 * Returns the content snapshot both sides last agreed on.
	 */
	getLastAgreedContent(): string | null {
		return this.lastAgreedContent;
	}

	constructor(view: EditorView, telemetry: CompositionHoldTelemetry = {}) {
		this.view = view;
		this.conf = view.state.facet(ySyncFacet);
		this.telemetry = telemetry;
		this._ytext = this.conf.ytext as Y.Text;
		this._ytext.observe(this._observer);
		this.lastAgreedContent = view.state.doc.toString();
		holdStates.set(view, this.state);
		pluginByView.set(view, this);
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
	 * Returns true if the editor document has unpushed local edits (editor-to-CRDT residue)
	 * that differ from lastAgreedContent.
	 */
	hasUnsyncedEdits(): boolean {
		if (this.lastAgreedContent === null) return false;
		return this.view.state.doc.toString() !== this.lastAgreedContent;
	}

	/**
	 * Returns unsynced status details (editor-to-CRDT residue): hasUnsynced boolean
	 * and character delta (editor.length - lastAgreedContent.length).
	 */
	getUnsyncedDelta(): { hasUnsynced: boolean; charDelta: number; conflictHold: boolean } {
		const base = this.lastAgreedContent;
		if (base === null) return { hasUnsynced: false, charDelta: 0, conflictHold: this.state.conflictHold };
		const doc = this.view.state.doc.toString();
		if (doc === base) {
			return { hasUnsynced: false, charDelta: 0, conflictHold: this.state.conflictHold };
		}
		return { hasUnsynced: true, charDelta: doc.length - base.length, conflictHold: this.state.conflictHold };
	}

	/**
	 * Synchronously flush local editor content to Y.Text when no remote projection
	 * hold is active. Used at composition end, view teardown, and binding boundaries.
	 *
	 * Uses planCompositionFlush (3-way plan):
	 * - if CRDT advanced remotely while editor was stale (projection-only): returns false,
	 *   refusing to overwrite CRDT with stale editor content.
	 * - if concurrent edits occurred (merge): returns false, because this method cannot
	 *   dispatch content diffs to the editor view synchronously; divergence/reconciliation
	 *   must resolve concurrent conflicts.
	 * - if base is missing (null): fails closed (returns false) to prevent stale overwrite.
	 * - only if editor has unpushed local composition edits while remote is unchanged (push-only):
	 *   pushes editorText to ytext and returns true.
	 */
	flushResidualComposition(reason: CompositionFlushReason): boolean {
		if (this.state.holding) return false;
		const editorText = this.view.state.doc.toString();
		// eslint-disable-next-line @typescript-eslint/no-base-to-string -- yjs typings omit Y.Text#toString; the runtime implementation is real
		const ytextText = this._ytext.toString();
		if (editorText === ytextText) return false;

		// Fail-closed: without a known base, we cannot distinguish local composition
		// residue from a stale editor overwriting an advanced CRDT.
		if (!this.lastAgreedContent) {
			return false;
		}

		const base = this.lastAgreedContent;
		const plan = planCompositionFlush(base, editorText, ytextText);
		// Only push when remote has not changed (push-only).
		// If remote also changed (merge) or advanced alone (projection-only),
		// flushResidualComposition cannot update the editor view synchronously,
		// so we fail-closed and leave divergence/reconciliation to handle it.
		if (plan.kind !== "push-only") {
			return false;
		}

		applyDiffToYText(this._ytext, ytextText, plan.mergedText, this.conf);
		this.lastAgreedContent = plan.mergedText;
		this.telemetry.onFlush?.({
			reason,
			kind: plan.kind,
			heldEvents: 0,
			baseLength: base.length,
			editorLength: editorText.length,
			ytextLength: ytextText.length,
			mergedLength: plan.mergedText.length,
		});
		return true;
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
			this.flushResidualComposition(reason);
			return;
		}
		// When CM6's observer has not processed compositionend yet (isComposing() still true),
		// queue a microtask so it runs immediately after CM6 clears inputState.composing
		// and flushes DOM mutations.
		queueMicrotask(() => {
			let attached = false;
			try {
				attached = this.view.dom.isConnected;
			} catch {
				attached = false;
			}
			if (!attached) return;
			if (this.isComposing()) return;
			if (this.state.holding) {
				this.flush(reason);
			} else {
				this.flushResidualComposition(reason === "compositionend" ? "compositionend-lag" : reason);
			}
		});
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
		const editorText = this.view.state.doc.toString();
		// eslint-disable-next-line @typescript-eslint/no-base-to-string -- yjs typings omit Y.Text#toString; the runtime implementation is real
		const ytextText = this._ytext.toString();
		const plan = planCompositionFlush(base, editorText, ytextText);

		if (plan.kind === "merge" && plan.hasConflict) {
			// Fail-closed: Never auto-merge or overwrite when conflicting overlap exists.
			// Keep holding active so editor push remains frozen until recovery resolution.
			this.clearCapTimer();
			// A hold armed earlier (IME composition, or a disjoint remote edit
			// with a cap timer) never passed through the observer's conflict
			// branch: later remote events only bump heldEvents. Promote it to a
			// conflict hold here so the freeze is visible and reported exactly
			// once, instead of leaving push frozen with no divergence evidence.
			if (!this.state.conflictHold) {
				this.state.conflictHold = true;
				this.telemetry.onConflict?.({
					base,
					editor: editorText,
					ytext: ytextText,
				});
			}
			return;
		}

		this.state.holding = false;
		this.state.conflictHold = false;
		this.state.baseText = null;
		this.clearCapTimer();
		const heldEvents = this.state.heldEvents;
		this.state.heldEvents = 0;

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
		const changes = computeContentDiffChanges(from, to);
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
	 *
	 * Composition alone must NOT pause the push. The stock plugin pushes
	 * every composition update, keeping editor==ytext through the IME
	 * session; deferring the push to compositionend relies on that event
	 * arriving with the composing flag already down, which CM6 guarantees
	 * only on the classic DOM path — under EditContext (modern
	 * Electron/Obsidian) the flag can stay up across chained sessions and
	 * every deferred flush bails on isComposing(), stranding the whole
	 * composed run outside Y.Text until some other lane repairs the mirror.
	 * Remote events during composition still arm the hold, which is the
	 * only state where the push must pause.
	 */
	update(update: ViewUpdate): void {
		const first = update.transactions[0];
		if (
			!update.docChanged ||
			(first !== undefined && first.annotation(kaosYSyncAnnotation) === this.conf)
		) {
			return;
		}
		if (this.state.holding) return;
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
		if (this.state.holding) {
			this.flush("destroy");
		} else {
			this.flushResidualComposition("destroy");
		}
		this._ytext.unobserve(this._observer);
		holdStates.delete(this.view);
		pluginByView.delete(this.view);
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
