import {
	Annotation,
	Compartment,
	EditorState,
	Transaction,
	type Extension,
	type TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { Notice, type MarkdownView } from "obsidian";
import type { VaultSync } from "./vaultSync";
import { applyDiffToYText } from "./diff";
import type { TraceRecord } from "../observability/traceContext";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_EDITOR_AUTHORITY_SHIELD,
	ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT,
	ORIGIN_EDITOR_HEALTH_HEAL,
} from "./origins";
import {
	buildActiveFileAwareness,
	buildTypingAwareness,
	collectActiveRemoteTypers,
	formatRemoteTypers,
	KAOS_ACTIVE_FILE_AWARENESS_FIELD,
	KAOS_TYPING_AWARENESS_FIELD,
	type RemoteTypingPeer,
} from "./remoteTypingGuard";
import { normalizeEditorText } from "../utils/editorTextNormalization";

/**
 * Manages per-editor CM6 bindings via yCollab.
 *
 * Strategy:
 *   - One global Compartment registered via registerEditorExtension.
 *   - When a MarkdownView is opened/focused, we reconfigure that
 *     editor's compartment to yCollab(ytext, awareness, {undoManager}).
 *   - When the view is closed or switches files, reconfigure to empty.
 */

/**
 * Freshly reconfigured editors can briefly report no ySyncFacet even though
 * the compartment update is still settling into the live view state.
 */
const BASE_BINDING_SETTLE_WINDOW_MS = 750;
const FAST_SWITCH_BINDING_SETTLE_WINDOW_MS = 1600;
const FAST_SWITCH_WINDOW_MS = 2000;
const POST_BIND_HEALTH_GRACE_MS = 100;
const LIVE_UPDATE_HEALTH_RETRY_DELAY_MS = 120;
const RECENT_EDITOR_REPAIR_DEFER_MS = 1200;
const RECENT_EDITOR_PATCH_SHIELD_MS = 5000;
const EXTERNAL_DISK_RELOAD_CORRELATION_MS = 5000;
const TYPING_AWARENESS_MIN_INTERVAL_MS = 750;
const CONCURRENT_TYPING_NOTICE_COOLDOWN_MS = 8_000;
const EDITOR_AUTHORITY_SHIELD_ORIGINS = new Set<string>([
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
]);
const CM_RESOLVE_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000, 1500, 2000] as const;
const CM_RESOLVE_DELAYED_ATTEMPT = 5;
const CM_RESOLVE_IDLE_RETRY_DELAY_MS = 5000;

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	view: MarkdownView;
	path: string;
	undoManager: Y.UndoManager;
	ytext: Y.Text;
	cm: EditorView;
	cmId: string;
	fileId?: string;
	lastBoundAt: string;
	lastBoundAtMs: number;
	lastEditorChangeAtMs: number;
	lastEditorDocChangeAtMs: number | null;
	settleWindowMs: number;
}

export interface BindingDebugInfo {
	leafId: string;
	path: string;
	fileId?: string;
	storedCmId: string;
	liveCmId: string | null;
	cmMatches: boolean;
	lastBoundAt: string;
}

export interface CollabDebugInfo {
	leafId: string;
	path: string;
	cmId: string | null;
	hasSyncFacet: boolean;
	awarenessMatchesProvider: boolean | null;
	yTextMatchesExpected: boolean | null;
	undoManagerMatchesFacet: boolean | null;
	facetFileId: string | null;
	expectedFileId: string | null;
	facetTextLength: number | null;
	cmDocLength: number | null;
}

export interface BindingHealthStatus {
	bound: boolean;
	healthy: boolean;
	settling: boolean;
	issues: string[];
}

interface BindingHealthCheck {
	healthy: boolean;
	settling: boolean;
	issues: string[];
	deferredIssues: string[];
}

interface BindingTarget {
	ytext: Y.Text;
	fileId?: string;
}

interface PendingYTextPatch {
	origin: unknown;
	path: string;
	leafId: string;
	at: number;
	revision: number;
}

export interface ExternalDiskMutationNotice {
	path: string;
	ctime: number | null;
	mtime: number | null;
	size: number | null;
	/** Monotonic event identity from the owning plugin runtime. */
	sequence: number;
	/** Wall-clock time at which the vault event itself was observed. */
	observedAt: number;
	/** Exact raw text read while the event's TFile identity/stat remained current. */
	content: string | null;
	/**
	 * Primitive snapshot of every open editor at event admission. It is retained
	 * as immutable event metadata, but never proves that one distinct disk
	 * revision supersedes or was adopted by another. Distinct raw candidates are
	 * preserved independently unless a candidate-specific durable receipt exists.
	 */
	editorAuthorityLineage?: ExternalDiskMutationEditorAuthorityLineage | null;
}

export interface ExternalDiskMutationEditorAuthorityLineageView {
	readonly viewId: string;
	readonly leafId: string;
	readonly cmId: string;
	readonly bindingEpoch: number;
	readonly editorRevision: number;
	readonly editorAuthorityRevision: number;
	readonly editorContent: string;
}

export interface ExternalDiskMutationEditorAuthorityLineage {
	readonly path: string;
	readonly views: readonly ExternalDiskMutationEditorAuthorityLineageView[];
}

export type InterceptedExternalDiskMutation = Readonly<
	Omit<ExternalDiskMutationNotice, "content"> & { content: string }
>;

interface PendingExternalDiskMutation extends ExternalDiskMutationNotice {
	at: number;
	consumedLeafIds: Set<string>;
	retireScheduled: boolean;
	/** Raw candidate was already emitted while an early host projection was held. */
	candidateDeliveredFromEarlyHostProjection: boolean;
}

interface HeldExternalDiskHostProjection {
	beforeContent: string;
	hostMergedContent: string;
	externalLogicalContent: string;
}

interface ExternalDiskHostViewSnapshot {
	binding: EditorBinding;
	view: MarkdownView;
	cm: EditorView;
	bindingEpoch: number;
	editorAuthorityRevision: number;
	yTextMutationRevision: number;
	lastSavedData: string | null;
	heldProjection: HeldExternalDiskHostProjection | null;
}

interface PendingExternalDiskMutationStart {
	path: string;
	sequence: number;
	at: number;
	views: Map<string, ExternalDiskHostViewSnapshot>;
}

interface ExternalDiskHostProjectionProof {
	start: PendingExternalDiskMutationStart;
	snapshot: ExternalDiskHostViewSnapshot;
	runtimeView: MarkdownView & { data?: unknown; lastSavedData?: unknown };
	externalLogicalContent: string;
}

interface RecentEditorOriginChange {
	path: string;
	leafId: string;
	binding: EditorBinding;
	cm: EditorView;
	ytext: Y.Text;
	bindingEpoch: number;
	expectedEditorRevision: number;
	expectedYTextMutationRevision: number;
	expectedYTextOrigin: unknown;
	observedDiskCtime: number | null;
	observedDiskMtime: number | null;
	observedDiskSize: number | null;
	observedDiskSequence: number;
	beforeContent: string;
	afterContent: string;
	at: number;
}

type EditorAuthorityTransactionSource =
	| "user"
	| "editor-api"
	| "external-reload-correction";

interface EditorAuthorityTransactionProvenance {
	content: string;
	source: EditorAuthorityTransactionSource;
}

interface ExternalReloadFilterBypass {
	path: string;
	leafId: string;
	bindingEpoch: number;
	beforeContent: string;
	externalContent: string;
}

interface PendingExternalDiskHostProjectionFence {
	path: string;
	leafId: string;
	binding: EditorBinding;
	cm: EditorView;
	bindingEpoch: number;
	sequence: number;
	beforeContent: string;
	hostMergedContent: string;
}

/**
 * An annotation, rather than Transaction object identity, survives every
 * CodeMirror transaction filter/extender rewrite and is still present when the
 * final ViewUpdate is delivered.
 */
const EDITOR_AUTHORITY_TRANSACTION =
	Annotation.define<EditorAuthorityTransactionProvenance>();

/**
 * `filter: false` deliberately bypasses transaction filters. The extender still
 * runs, so mark an exact external reload for a post-update compare-and-revert.
 */
const EXTERNAL_RELOAD_FILTER_BYPASS = Annotation.define<ExternalReloadFilterBypass>();

export type OpenEditorMutationInvalidReason =
	| "path-changed"
	| "view-set-changed"
	| "view-replaced"
	| "cm-changed"
	| "binding-epoch-changed"
	| "editor-document-changed"
	| "editor-revision-changed"
	| "editor-read-failed";

export interface OpenEditorMutationViewTicket {
	readonly view: MarkdownView;
	readonly viewId: string;
	readonly leafId: string;
	readonly cm: EditorView | null;
	readonly cmId: string | null;
	readonly bindingEpoch: number;
	readonly editorRevision: number;
	/**
	 * Advances only when this editor is the source of the document change.
	 * Provider/Y.Text patches still advance editorRevision, but not this value.
	 */
	readonly editorAuthorityRevision: number;
	/** Exact document produced by the latest editor-origin transaction. */
	readonly editorAuthorityContent: string | null;
	readonly editorDocument: unknown;
	readonly editorContent: string | null;
}

export interface OpenEditorMutationTicket {
	readonly path: string;
	readonly views: readonly OpenEditorMutationViewTicket[];
}

export type OpenEditorMutationTicketValidation =
	| { current: true }
	| {
		current: false;
		reason: OpenEditorMutationInvalidReason;
		leafId?: string;
	};

/**
 * Harness-only gate for pausing editor<->CRDT propagation on specific paths.
 * Supplied by the QA harness via the EditorBindingManager constructor.
 * Absent in production. Default: all paths are unpaused.
 *
 * The gate owns the mutable paused-path set. The EditorBindingManager
 * only reads from it (isPaused) — it does not mutate it.
 *
 * The harness must call reconfigureBindingForPath after mutating the set
 * so that the CodeMirror compartment is updated.
 */
export interface BindingPropagationGate {
	/** Returns true if propagation for this path is currently paused. */
	isPaused(path: string): boolean;
	/**
	 * Called by EditorBindingManager to expose a reconfigure hook for
	 * the harness. The harness calls reconfigure(path, deviceName) after
	 * pausing or resuming to apply the CM extension change.
	 */
	registerReconfigureHook(
		fn: (path: string, deviceName: string, action: "pause" | "resume") => void,
	): void;
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();
	private knownCmViews = new Set<EditorView>();
	private cmIds = new WeakMap<EditorView, string>();
	private cmToLeafId = new WeakMap<EditorView, string>();
	private cmCounter = 0;
	private viewIds = new WeakMap<MarkdownView, string>();
	private viewCounter = 0;
	private pendingHealthChecks = new Map<string, ReturnType<typeof setTimeout>>();
	private healthWorkInFlight = new Set<string>();
	private lastDeviceName = "unknown";
	private cmDegradedWarned = false;
	private cmResolveAttempts = new Map<string, number>();
	private cmResolveDelayedLogged = new Set<string>();
	private pendingCmResolveRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingYTextPatches = new WeakMap<Y.Text, PendingYTextPatch>();
	private yTextMutationRevisionByText = new WeakMap<Y.Text, number>();
	private lastYTextMutationTransactionByText = new WeakMap<Y.Text, Y.Transaction>();
	private editorAuthorityShieldLeafIds = new Set<string>();
	private lastEditorDocChangeAtByPath = new Map<string, number>();
	private lastUserDocChangeAtByCm = new WeakMap<EditorView, number>();
	private editorRevisionByCm = new WeakMap<EditorView, number>();
	private editorAuthorityRevisionByCm = new WeakMap<EditorView, number>();
	private editorAuthorityContentByCm = new WeakMap<EditorView, string>();
	private bindingEpochByLeafId = new Map<string, number>();
	private pendingReplacementCmToLeafId = new WeakMap<EditorView, string>();
	private lastTypingAwarenessAtByLeaf = new Map<string, number>();
	private concurrentTypingNoticeAtByPath = new Map<string, number>();
	private pendingExternalDiskMutations = new Map<string, PendingExternalDiskMutation>();
	private pendingExternalDiskMutationStarts = new Map<string, PendingExternalDiskMutationStart>();
	private pendingExternalDiskHostProjectionFences =
		new WeakMap<EditorState, PendingExternalDiskHostProjectionFence>();
	private recentEditorOriginChanges = new Map<string, RecentEditorOriginChange>();
	private lastExternalDiskMutationSequenceByPath = new Map<string, number>();
	private observedExternalDiskMutationSequenceByPath = new Map<string, number>();
	private readonly debug: boolean;

	constructor(
		private vaultSync: VaultSync,
		debug: boolean,
		private readonly isMarkdownPathSyncable: (path: string) => boolean,
		private trace?: TraceRecord,
		private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void,
		private readonly bindingPropagationGate?: BindingPropagationGate,
		private readonly isRemoteTypingGuardEnabled: () => boolean = () => true,
		private readonly onExternalDiskReloadIntercepted?: (
			candidate: InterceptedExternalDiskMutation,
		) => void,
		private readonly isExternalDiskReloadGuardEnabled: () => boolean = () => true,
	) {
		this.debug = debug;
		// Register the reconfigure hook so the harness can trigger CM extension
		// changes after mutating the paused-path set.
		bindingPropagationGate?.registerReconfigureHook((path, deviceName, action) => {
			for (const [leafId, binding] of this.bindings) {
				if (binding.path !== path) continue;
				if (action === "pause") {
					try {
						binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
					} catch {
						// view may be destroyed
					}
				} else {
					// Resume: re-apply yCollab via repair.
					this.repair(binding.view, deviceName, "harness-resume-binding-propagation");
				}
				void leafId;
			}
		});
	}

	separateUndoCaptureForPath(path: string): number {
		let separated = 0;
		for (const binding of this.bindings.values()) {
			if (binding.path !== path || binding.view.file?.path !== path) continue;
			binding.undoManager.stopCapturing();
			separated++;
		}
		return separated;
	}

	/**
	 * Returns the base extension to register globally.
	 * Starts as empty; reconfigured per-editor when a note is opened.
	 */
	getBaseExtension(): Extension {
		const registerKnownCmView = this.registerKnownCmView.bind(this);
		const handleLiveEditorUpdate = this.handleLiveEditorUpdate.bind(this);
		const unregisterKnownCmView = this.unregisterKnownCmView.bind(this);
		const filterRiskyNonUserPatch = this.filterRiskyNonUserPatch.bind(this);
		const annotateEditorDocumentOrigin = this.annotateEditorDocumentOrigin.bind(this);
		const fenceStaleUserBinding = this.fenceStaleUserBinding.bind(this);
		return [
			this.compartment.of([]),
			// Guard y-codemirror document patches that would replay a local repair
			// over an actively edited note. The actual local-edit tracking lives
			// in the ViewPlugin below; this filter runs before the patch reaches
			// the editor document.
			EditorState.transactionFilter.of(filterRiskyNonUserPatch),
			// Extenders run after every transaction filter and even when a caller uses
			// `filter: false`, so provenance attached here reaches the final update.
			EditorState.transactionExtender.of(annotateEditorDocumentOrigin),
			EditorState.transactionExtender.of(fenceStaleUserBinding),
			ViewPlugin.fromClass(
				class {
					constructor(readonly view: EditorView) {
						registerKnownCmView(view);
					}

					update(update: ViewUpdate): void {
						handleLiveEditorUpdate(update);
					}

					destroy(): void {
						unregisterKnownCmView(this.view);
					}
				},
			),
		];
	}

	/**
	 * Record event order synchronously, before the exact-content read starts.
	 * The transaction filter can then distinguish an event that preceded an
	 * editor/API transaction even when both share the same millisecond timestamp.
	 */
	beginExternalDiskMutation(path: string, sequence: number): void {
		const previous = this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (sequence <= previous) return;
		this.observedExternalDiskMutationSequenceByPath.set(path, sequence);
		if (!this.isExternalDiskReloadGuardEnabled()) {
			this.pendingExternalDiskMutationStarts.delete(path);
			return;
		}
		const views = new Map<string, ExternalDiskHostViewSnapshot>();
		for (const [leafId, binding] of this.bindings) {
			if (binding.path !== path || binding.view.file?.path !== path) continue;
			const runtimeView = binding.view as MarkdownView & { lastSavedData?: unknown };
			views.set(leafId, {
				binding,
				view: binding.view,
				cm: binding.cm,
				bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
				editorAuthorityRevision:
					this.editorAuthorityRevisionByCm.get(binding.cm) ?? 0,
				yTextMutationRevision:
					this.yTextMutationRevisionByText.get(binding.ytext) ?? 0,
				lastSavedData:
					typeof runtimeView.lastSavedData === "string"
						? runtimeView.lastSavedData
						: null,
				heldProjection: null,
			});
		}
		if (views.size === 0) {
			this.pendingExternalDiskMutationStarts.delete(path);
			return;
		}
		this.pendingExternalDiskMutationStarts.set(path, {
			path,
			sequence,
			at: Date.now(),
			views,
		});
	}

	/**
	 * Correlate an unsuppressed vault.modify event with a CodeMirror document
	 * replacement caused by Obsidian reloading bytes written by another app.
	 *
	 * The normal ordering is disk event first, editor reload second; the
	 * transaction filter consumes the marker before y-codemirror can copy the
	 * replacement into Y.Text. Some hosts deliver the editor update first. For
	 * that ordering we revert only when the event's exact raw content matches
	 * the editor replacement and either event order or a high-resolution mtime
	 * proves the disk write preceded it. Every captured editor/Y.Text identity,
	 * content, epoch, and revision must still match before rollback.
	 */
	noteExternalDiskMutation(notice: ExternalDiskMutationNotice): void {
		if (!this.isExternalDiskReloadGuardEnabled()) {
			this.invalidateExternalDiskReloadCorrelation(notice.path, notice.sequence);
			return;
		}
		const hasLiveBinding = Array.from(this.bindings.values()).some(
			(binding) =>
				binding.path === notice.path &&
				binding.view.file?.path === notice.path,
		);
		if (!hasLiveBinding) {
			this.invalidateExternalDiskReloadCorrelation(notice.path, notice.sequence);
			return;
		}
		const previousSequence =
			this.lastExternalDiskMutationSequenceByPath.get(notice.path) ?? 0;
		if (notice.sequence <= previousSequence) {
			// Async reads may finish out of order. Never replace a newer exact
			// marker with an older revision; preserve the older proven bytes instead.
			if (notice.content !== null) {
				this.notifyExternalDiskReloadIntercepted(notice);
			}
			this.trace?.("editor", "external-disk-reload-guard-stale-event", {
				path: notice.path,
				sequence: notice.sequence,
				currentSequence: previousSequence,
				contentPreserved: notice.content !== null,
			});
			return;
		}
		this.lastExternalDiskMutationSequenceByPath.set(notice.path, notice.sequence);
		const now = Date.now();
		const candidate = this.getFreshRecentEditorOriginChange(notice.path, now);
		const normalizedDiskContent = notice.content === null
			? null
			: normalizeEditorText(notice.content);
		if (this.promoteHeldExternalDiskHostProjection(notice, normalizedDiskContent, now)) {
			return;
		}
		const candidateContentMatches =
			candidate !== null &&
			normalizedDiskContent !== null &&
			candidate.afterContent === normalizedDiskContent;
		const exactDiskRevisionMatches =
			candidate !== null &&
			candidate.observedDiskMtime !== null &&
			candidate.observedDiskSize !== null &&
			typeof notice.mtime === "number" &&
			Number.isFinite(notice.mtime) &&
			typeof notice.size === "number" &&
			Number.isFinite(notice.size) &&
			notice.mtime === candidate.observedDiskMtime &&
			notice.size === candidate.observedDiskSize &&
			(
				candidate.observedDiskCtime === null ||
				notice.ctime === null ||
				notice.ctime === candidate.observedDiskCtime
			);
		const eventObservedBeforeEditorChange =
			candidate !== null && candidate.observedDiskSequence >= notice.sequence;
		const highResolutionMtimeProvesDiskFirst =
			exactDiskRevisionMatches &&
			notice.mtime !== null &&
			notice.mtime > 0 &&
			notice.mtime % 1000 !== 0 &&
			notice.mtime < candidate.at &&
			candidate.at - notice.mtime <= EXTERNAL_DISK_RELOAD_CORRELATION_MS;
		const diskMutationPredatesEditorChange =
			candidateContentMatches &&
			(eventObservedBeforeEditorChange || highResolutionMtimeProvesDiskFirst);

		if (candidate && diskMutationPredatesEditorChange) {
			this.recentEditorOriginChanges.delete(notice.path);
			this.notifyExternalDiskReloadIntercepted(notice);
			if (this.isRecentEditorOriginChangeCurrent(candidate)) {
				applyDiffToYText(
					candidate.ytext,
					candidate.afterContent,
					candidate.beforeContent,
					ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT,
				);
				this.trace?.("editor", "external-disk-editor-reload-reverted", {
					path: notice.path,
					leafId: candidate.leafId,
					cmId: candidate.binding.cmId,
					beforeLength: candidate.beforeContent.length,
					externalLength: candidate.afterContent.length,
					eventObservedAt: notice.observedAt,
					diskMtime: notice.mtime,
					diskSize: notice.size,
					editorChangeAt: candidate.at,
				});
			} else {
				this.trace?.("editor", "external-disk-editor-reload-revert-skipped", {
					path: notice.path,
					reason: "exact-state-changed",
					externalCandidatePreserved: true,
					diskMtime: notice.mtime,
					editorChangeAt: candidate.at,
				});
			}
			return;
		} else if (candidate && candidateContentMatches && exactDiskRevisionMatches) {
			// Exact bytes/revision are known, but a coarse or non-monotonic clock
			// cannot safely distinguish an editor API change from an editor-first
			// disk reload. Keep a current editor/API result. If another authority has
			// already replaced it, preserve the exact disk candidate without rollback.
			this.recentEditorOriginChanges.delete(notice.path);
			const candidateStillCurrent = this.isRecentEditorOriginChangeCurrent(candidate);
			if (!candidateStillCurrent) {
				this.notifyExternalDiskReloadIntercepted(notice);
			}
			this.trace?.("editor", "external-disk-editor-reload-ambiguous-preserved", {
				path: notice.path,
				leafId: candidate.leafId,
				cmId: candidate.binding.cmId,
				diskMtime: notice.mtime,
				diskSize: notice.size,
				editorChangeAt: candidate.at,
				externalCandidatePreserved: !candidateStillCurrent,
			});
			return;
		} else if (
			candidate &&
			candidateContentMatches &&
			candidate.observedDiskSequence < notice.sequence
		) {
			// A programmatic editor/API change is followed by Obsidian's normal
			// autosave modify event. Without proof that this disk revision was
			// already visible before the editor transaction, do not arm a marker
			// that could cancel the plugin's next non-user edit.
			this.recentEditorOriginChanges.delete(notice.path);
			this.trace?.("editor", "editor-origin-autosave-observed", {
				path: notice.path,
				leafId: candidate.leafId,
				cmId: candidate.binding.cmId,
				diskMtime: notice.mtime,
				diskSize: notice.size,
				editorChangeAt: candidate.at,
				exactDiskRevisionMatches,
			});
			return;
		}
		if (notice.content === null) {
			this.trace?.("editor", "external-disk-reload-guard-proof-unavailable", {
				path: notice.path,
				ctime: notice.ctime,
				mtime: notice.mtime,
				size: notice.size,
			});
			return;
		}

		this.rememberPendingExternalDiskMutation({
			...notice,
			at: now,
			consumedLeafIds: new Set<string>(),
			retireScheduled: false,
			candidateDeliveredFromEarlyHostProjection: false,
		});
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;

		if (!this.canBindPath(view, "bind")) return;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		const cm = this.getCmView(view);
		if (!cm) {
			// A file switch may leave the previous CM connected while the new CM is
			// still mounting. Detach the old yCollab immediately; retry will bind the
			// new editor once its document agrees with the MarkdownView facade.
			if (existing && existing.path !== file.path) {
				this.unbind(view);
			}
			this.log(`bind: waiting for Obsidian editor view for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, "bind");
			return;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;
		const cmId = this.getCmId(cm);
		this.carryCmActivityToPath(cm, file.path);
		const rapidSwitch =
			!!existing
			&& existing.path !== file.path
			&& Date.now() - existing.lastBoundAtMs <= FAST_SWITCH_WINDOW_MS;

		if (existing && existing.path === file.path && existing.cm === cm) {
			const health = this.inspectBindingHealth(view, existing);
			if (health.healthy) {
				if (health.settling) {
					const deferred = health.deferredIssues.join(",");
					this.log(
						`bind: waiting for "${file.path}" to settle ` +
						`(leaf=${leafId}, cm=${cmId}, deferred=${deferred})`,
					);
					return;
				}

				this.log(`bind: already bound "${file.path}" (leaf=${leafId}, cm=${cmId})`);
				return;
			}

			const reason = health.issues.join(",") || "unknown";
			this.log(
				`bind: repairing unhealthy binding "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}, issues=${reason})`,
			);
			if (this.deferRepairForRecentEditorActivity(
				leafId,
				existing,
				`bind-health:${reason}`,
				health.issues,
			)) {
				return;
			}
			if (this.repair(view, deviceName, `bind-health:${reason}`)) {
				return;
			}

			this.log(
				`bind: repair failed for "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}) — falling back to rebind`,
			);
		}

		if (existing && existing.path === file.path && existing.cm !== cm) {
			this.log(
				`bind: editor view changed for "${file.path}" ` +
				`(leaf=${leafId}, stored=${existing.cmId}, live=${cmId})`,
			);
			if (this.deferRepairForRecentEditorActivity(
				leafId,
				existing,
				"bind-target-changed:cm-changed",
				["cm-changed"],
			)) {
				this.pendingReplacementCmToLeafId.set(cm, leafId);
				return;
			}
		}

		// Unbind previous if switching files in the same leaf
		if (existing) {
			this.unbind(view);
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			"bind",
		);
		if (!target) return;

		this.applyBinding({
			action: "bind",
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			rapidSwitch,
		});
	}

	repair(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!this.canBindPath(view, `repair:${reason}`)) return false;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`repair: waiting for Obsidian editor view for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, `repair:${reason}`);
			return true;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;

		const existing = this.bindings.get(leafId);
		if (!existing) {
			this.log(
				`repair: no tracked binding for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason})`,
			);
			this.bind(view, deviceName);
			const rebound = this.bindings.get(leafId);
			return rebound?.path === file.path && rebound.cm === cm;
		}

		if (existing.path !== file.path || existing.cm !== cm) {
			const targetChangedIssues = [
				...(existing.path !== file.path ? ["path-changed"] : []),
				...(existing.cm !== cm ? ["cm-changed"] : []),
			];
			this.log(
				`repair: binding target changed for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason}) — forcing rebind`,
			);
			if (existing.path === file.path && this.deferRepairForRecentEditorActivity(
				leafId,
				existing,
				`repair-target-changed:${reason}`,
				targetChangedIssues,
			)) {
				this.pendingReplacementCmToLeafId.set(cm, leafId);
				return true;
			}
			this.rebind(view, deviceName, reason);
			return true;
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`repair:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		return this.applyBinding({
			action: "repair",
			deviceName,
			view,
			cm,
			cmId: this.getCmId(cm),
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			existing,
			reason,
		});
	}

	heal(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!this.canBindPath(view, `heal:${reason}`)) return false;

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`heal:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		const currentContent = view.editor.getValue();
		const crdtContent = target.ytext.toJSON();
		const diffApplied = crdtContent !== currentContent;
		if (diffApplied) {
			this.log(
				`heal: applying local editor content to "${file.path}" ` +
				`(${crdtContent.length} -> ${currentContent.length} chars, reason=${reason})`,
			);
			applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL);
		}

		// Emit editor.heal.applied unconditionally on heal() entry so that
		// "no editor.heal.applied event" means "heal() was not invoked",
		// not "heal() was invoked but happened to be a no-op". The
		// diffApplied flag distinguishes the two cases.
		this.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.editorHealApplied,
			severity: "info",
			scope: "file",
			source: "editorBinding",
			layer: "editor",
			path: file.path,
			data: {
				reason,
				crdtLength: crdtContent.length,
				editorLength: currentContent.length,
				crdtMatchesEditorBefore: !diffApplied,
				diffApplied,
			},
		});

		return this.repair(view, deviceName, reason);
	}

	rebind(view: MarkdownView, deviceName: string, reason: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;
		if (!this.canBindPath(view, `rebind:${reason}`)) return;
		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, `rebind:${reason}`);
			return;
		}

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		if (existing && this.deferRepairForRecentEditorActivity(
			leafId,
			existing,
			`rebind:${reason}`,
			["rebind-requested"],
		)) {
			return;
		}
		this.log(`rebind: forcing "${file.path}" (leaf=${leafId}, reason=${reason})`);
		this.unbind(view);
		this.bind(view, deviceName);
	}

	/**
	 * Unbind a MarkdownView's editor (clear yCollab extension).
	 */
	unbind(view: MarkdownView): void {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";

		const binding = this.bindings.get(leafId);
		if (!binding) return;

		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		binding.undoManager.destroy();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);
		this.bumpBindingEpoch(leafId);
		if (!Array.from(this.bindings.values()).some((item) => item.path === binding.path)) {
			this.invalidateExternalDiskReloadCorrelation(binding.path);
		}

		try {
			binding.cm.dispatch({
				effects: this.compartment.reconfigure([]),
			});
		} catch {
			// View may already be destroyed
		}

		this.clearLocalCursor("unbind");
		this.clearLocalPresence("unbind");

		this.log(`unbind: unbound "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`);
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const [leafId, binding] of this.bindings) {
			this.clearScheduledHealthCheck(leafId);
			this.clearCmResolveRetry(leafId);
			this.healthWorkInFlight.delete(leafId);
			this.cmToLeafId.delete(binding.cm);
			this.bumpBindingEpoch(leafId);
			binding.undoManager.destroy();
			this.log(`unbindAll: destroyed binding for "${binding.path}"`);
		}
		this.bindings.clear();
		this.pendingExternalDiskMutations.clear();
		this.pendingExternalDiskMutationStarts.clear();
		this.recentEditorOriginChanges.clear();
		this.lastExternalDiskMutationSequenceByPath.clear();
		this.observedExternalDiskMutationSequenceByPath.clear();
		this.clearLocalPresence("unbind-all");
	}

	/**
	 * Unbind any editors that are bound to the given path.
	 * Called when a file is deleted (locally or remotely).
	 */
	unbindByPath(path: string): void {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path === path) {
				this.clearScheduledHealthCheck(leafId);
				this.clearCmResolveRetry(leafId);
				this.healthWorkInFlight.delete(leafId);
				binding.undoManager.destroy();
				try {
					binding.cm.dispatch({
						effects: this.compartment.reconfigure([]),
					});
				} catch {
					// View may already be destroyed
				}
				this.cmToLeafId.delete(binding.cm);
				this.bindings.delete(leafId);
				this.bumpBindingEpoch(leafId);
				this.lastTypingAwarenessAtByLeaf.delete(leafId);
				this.lastEditorDocChangeAtByPath.delete(path);
				this.log(`unbindByPath: unbound "${path}" (leaf=${leafId})`);
				// Don't break — a path could theoretically be open in multiple leaves
			}
		}
		this.invalidateExternalDiskReloadCorrelation(path);
	}

	/**
	 * Check if a path is currently bound to an active editor.
	 */
	isBound(path: string): boolean {
		for (const binding of this.bindings.values()) {
			if (binding.path === path) return true;
		}
		return false;
	}

	/**
	 * Update binding metadata after a batch rename. If any bound editor's
	 * tracked path was renamed, update the tracking. The yCollab binding
	 * itself doesn't need to change (stable file IDs), but our bookkeeping does.
	 */
	updatePathsAfterRename(renames: Map<string, string>): void {
		for (const [leafId, binding] of this.bindings) {
			const newPath = renames.get(binding.path);
			if (newPath) {
				const previousPath = binding.path;
				this.log(`updatePaths: "${binding.path}" -> "${newPath}" (leaf=${leafId})`);
				const lastDocChange = this.lastEditorDocChangeAtByPath.get(binding.path);
				if (lastDocChange != null) {
					this.lastEditorDocChangeAtByPath.set(newPath, lastDocChange);
					this.lastEditorDocChangeAtByPath.delete(binding.path);
				}
				binding.path = newPath;
				this.invalidateExternalDiskReloadCorrelation(previousPath);
				this.bumpBindingEpoch(leafId);
				this.publishLocalActiveFile(binding);
			}
		}
	}

	getBindingDebugInfoForView(view: MarkdownView): BindingDebugInfo | null {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) return null;

		const liveCm = this.getCmView(view);
		const liveCmId = liveCm ? this.getCmId(liveCm) : null;
		return {
			leafId,
			path: binding.path,
			fileId: binding.fileId,
			storedCmId: binding.cmId,
			liveCmId,
			cmMatches: liveCm === binding.cm,
			lastBoundAt: binding.lastBoundAt,
		};
	}

	getBindingDebugInfo(path: string): BindingDebugInfo | null {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path !== path) continue;
			return {
				leafId,
				path: binding.path,
				fileId: binding.fileId,
				storedCmId: binding.cmId,
				liveCmId: binding.cmId,
				cmMatches: true,
				lastBoundAt: binding.lastBoundAt,
			};
		}
		return null;
	}

	getBindingHealthForView(view: MarkdownView): BindingHealthStatus {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) {
			return {
				bound: false,
				healthy: false,
				settling: false,
				issues: ["missing-binding"],
			};
		}

		const health = this.inspectBindingHealth(view, binding);
		return {
			bound: true,
			healthy: health.healthy,
			settling: health.settling,
			issues: health.issues,
		};
	}

	auditBindings(source: string): number {
		let triggered = 0;
		const snapshot = Array.from(this.bindings.entries());
		for (const [leafId, binding] of snapshot) {
			if (this.bindings.get(leafId) !== binding) continue;
			if (this.healthWorkInFlight.has(leafId)) continue;
			if (!this.isMarkdownPathSyncable(binding.path)) {
				triggered += 1;
				this.skipExcludedBinding(binding.view, binding.path, `audit:${source}`);
				continue;
			}

			const health = this.inspectBindingHealth(binding.view, binding);
			if (health.healthy || health.settling) continue;
			if (!this.isAuditActionable(binding.view, health.issues)) continue;

			triggered += 1;
			this.maybeHealBinding(leafId, binding, source);
		}
		return triggered;
	}

	getLastEditorActivityForPath(path: string): number | null {
		let latest: number | null = this.lastEditorDocChangeAtByPath.get(path) ?? null;
		for (const binding of this.bindings.values()) {
			if (binding.path !== path) continue;
			const lastDocChange = binding.lastEditorDocChangeAtMs;
			if (lastDocChange == null) continue;
			if (latest == null || lastDocChange > latest) {
				latest = lastDocChange;
			}
		}
		return latest;
	}

	/**
	 * Capture only immutable editor lineage. Live MarkdownView/EditorView objects
	 * must never escape into an asynchronous disk candidate.
	 */
	captureExternalDiskMutationEditorAuthorityLineage(
		path: string,
		views: readonly MarkdownView[],
	): ExternalDiskMutationEditorAuthorityLineage | null {
		if (views.length === 0) return null;
		const ticket = this.captureOpenEditorMutationTicket(path, views);
		const seenLeafIds = new Set<string>();
		const snapshots: ExternalDiskMutationEditorAuthorityLineageView[] = [];
		for (const snapshot of ticket.views) {
			if (
				snapshot.view.file?.path !== path ||
				snapshot.cm === null ||
				snapshot.cmId === null ||
				snapshot.editorContent === null ||
				seenLeafIds.has(snapshot.leafId)
			) {
				return null;
			}
			seenLeafIds.add(snapshot.leafId);
			snapshots.push(Object.freeze({
				viewId: snapshot.viewId,
				leafId: snapshot.leafId,
				cmId: snapshot.cmId,
				bindingEpoch: snapshot.bindingEpoch,
				editorRevision: snapshot.editorRevision,
				editorAuthorityRevision: snapshot.editorAuthorityRevision,
				editorContent: snapshot.editorContent,
			}));
		}
		if (snapshots.length !== views.length) return null;
		snapshots.sort((left, right) => left.leafId.localeCompare(right.leafId));
		return Object.freeze({
			path,
			views: Object.freeze(snapshots),
		});
	}

	/**
	 * Capture an optimistic-concurrency ticket for every visible editor of a
	 * path. The ticket deliberately includes editors that have not completed a
	 * Yjs binding yet, so input during the file-open transition is still part of
	 * the mutation boundary.
	 */
	captureOpenEditorMutationTicket(
		path: string,
		views: readonly MarkdownView[],
	): OpenEditorMutationTicket {
		return {
			path,
			views: views.map((view) => {
				const leafId =
					(view.leaf as unknown as { id?: string }).id ?? view.file?.path ?? path;
				const cm = this.getCmView(view);
				if (cm) {
					this.carryCmActivityToPath(cm, path);
				}
				let editorContent: string | null = null;
				try {
					editorContent = view.editor.getValue();
				} catch {
					// A ticket without a readable editor cannot authorize a later write.
				}
					return {
						view,
						viewId: this.getViewId(view),
						leafId,
					cm,
					cmId: cm ? this.getCmId(cm) : null,
					bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
					editorRevision: cm ? (this.editorRevisionByCm.get(cm) ?? 0) : 0,
					editorAuthorityRevision:
						cm ? (this.editorAuthorityRevisionByCm.get(cm) ?? 0) : 0,
					editorAuthorityContent:
						cm ? (this.editorAuthorityContentByCm.get(cm) ?? null) : null,
					editorDocument: cm?.state.doc ?? null,
					editorContent,
				};
			}),
		};
	}

	validateOpenEditorMutationTicket(
		ticket: OpenEditorMutationTicket,
		views: readonly MarkdownView[],
	): OpenEditorMutationTicketValidation {
		if (views.length !== ticket.views.length) {
			return { current: false, reason: "view-set-changed" };
		}

		const currentByLeafId = new Map<string, MarkdownView>();
		for (const view of views) {
			const leafId =
				(view.leaf as unknown as { id?: string }).id ?? view.file?.path ?? ticket.path;
			if (currentByLeafId.has(leafId)) {
				return { current: false, reason: "view-set-changed", leafId };
			}
			currentByLeafId.set(leafId, view);
		}

		for (const snapshot of ticket.views) {
			const view = currentByLeafId.get(snapshot.leafId);
			if (!view || view !== snapshot.view) {
				return { current: false, reason: "view-replaced", leafId: snapshot.leafId };
			}
			if (view.file?.path !== ticket.path) {
				return { current: false, reason: "path-changed", leafId: snapshot.leafId };
			}

			const cm = this.getCmView(view);
			if (cm !== snapshot.cm) {
				return { current: false, reason: "cm-changed", leafId: snapshot.leafId };
			}
			if ((this.bindingEpochByLeafId.get(snapshot.leafId) ?? 0) !== snapshot.bindingEpoch) {
				return {
					current: false,
					reason: "binding-epoch-changed",
					leafId: snapshot.leafId,
				};
			}
			if (cm && cm.state.doc !== snapshot.editorDocument) {
				return {
					current: false,
					reason: "editor-document-changed",
					leafId: snapshot.leafId,
				};
			}
			if (cm && (this.editorRevisionByCm.get(cm) ?? 0) !== snapshot.editorRevision) {
				return {
					current: false,
					reason: "editor-revision-changed",
					leafId: snapshot.leafId,
				};
			}

			let editorContent: string;
			try {
				editorContent = view.editor.getValue();
			} catch {
				return { current: false, reason: "editor-read-failed", leafId: snapshot.leafId };
			}
			if (snapshot.editorContent === null) {
				return { current: false, reason: "editor-read-failed", leafId: snapshot.leafId };
			}
			if (editorContent !== snapshot.editorContent) {
				return {
					current: false,
					reason: "editor-document-changed",
					leafId: snapshot.leafId,
				};
			}
		}

		return { current: true };
	}

	getCollabDebugInfoForView(view: MarkdownView): CollabDebugInfo | null {
		const file = view.file;
		if (!file) return null;

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			return {
				leafId,
				path: file.path,
				cmId: null,
				hasSyncFacet: false,
				awarenessMatchesProvider: null,
				yTextMatchesExpected: null,
				undoManagerMatchesFacet: null,
				facetFileId: null,
				expectedFileId: this.vaultSync.getFileId(file.path) ?? null,
				facetTextLength: null,
				cmDocLength: null,
			};
		}

		type SyncFacetLike = {
			ytext?: Y.Text;
			awareness?: unknown;
			undoManager?: Y.UndoManager;
		} | undefined;

		let syncFacet: SyncFacetLike;
		try {
			syncFacet = cm.state.facet(ySyncFacet) as SyncFacetLike;
		} catch {
			syncFacet = undefined;
		}

		const binding = this.bindings.get(leafId);
		const expectedText = this.vaultSync.getTextForPath(file.path);
		const expectedFileId =
			this.vaultSync.getFileId(file.path)
			?? (expectedText ? this.vaultSync.getFileIdForText(expectedText) : undefined)
			?? null;
		const facetText = syncFacet?.ytext ?? null;
		const facetFileId =
			facetText instanceof Y.Text
				? (this.vaultSync.getFileIdForText(facetText) ?? null)
				: null;

		const facetUndoManager =
			syncFacet && "undoManager" in syncFacet
				? (syncFacet.undoManager ?? null)
				: null;

		return {
			leafId,
			path: file.path,
			cmId: this.getCmId(cm),
			hasSyncFacet: !!syncFacet,
			awarenessMatchesProvider: syncFacet
				? syncFacet.awareness === this.vaultSync.provider.awareness
				: null,
			yTextMatchesExpected: syncFacet
				? (expectedText ? syncFacet.ytext === expectedText : false)
				: null,
			undoManagerMatchesFacet: syncFacet
				? ("undoManager" in syncFacet
					? (binding ? facetUndoManager === binding.undoManager : null)
					: null)
				: null,
			facetFileId,
			expectedFileId,
			facetTextLength:
				facetText instanceof Y.Text
						? facetText.toJSON().length
						: null,
			cmDocLength: cm.state.doc.length,
		};
	}

	clearLocalCursor(reason: string): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField("cursor", null);
			this.trace?.("editor", "cursor-cleared", { reason });
		} catch {
			// Provider may be disconnected
		}
	}

	clearLocalPresence(reason: string): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField(KAOS_ACTIVE_FILE_AWARENESS_FIELD, null);
			this.vaultSync.provider.awareness.setLocalStateField(KAOS_TYPING_AWARENESS_FIELD, null);
			this.trace?.("editor", "presence-cleared", { reason });
		} catch {
			// Provider may be disconnected
		}
	}

	private publishLocalActiveFile(binding: EditorBinding, at = Date.now()): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField(
				KAOS_ACTIVE_FILE_AWARENESS_FIELD,
				buildActiveFileAwareness(binding.path, this.lastDeviceName, at),
			);
		} catch {
			// Provider may be disconnected
		}
	}

	private publishLocalTypingActivity(
		leafId: string,
		binding: EditorBinding,
		at = Date.now(),
	): void {
		const lastPublishedAt = this.lastTypingAwarenessAtByLeaf.get(leafId) ?? 0;
		if (at - lastPublishedAt < TYPING_AWARENESS_MIN_INTERVAL_MS) {
			return;
		}

		this.lastTypingAwarenessAtByLeaf.set(leafId, at);
		try {
			this.vaultSync.provider.awareness.setLocalStateField(
				KAOS_ACTIVE_FILE_AWARENESS_FIELD,
				buildActiveFileAwareness(binding.path, this.lastDeviceName, at),
			);
			this.vaultSync.provider.awareness.setLocalStateField(
				KAOS_TYPING_AWARENESS_FIELD,
				buildTypingAwareness(binding.path, this.lastDeviceName, at),
			);
			this.trace?.("editor", "typing-awareness-published", {
				path: binding.path,
				leafId,
			});
		} catch {
			// Provider may be disconnected
		}
	}

	private getActiveRemoteTypersForPath(path: string, now = Date.now()): RemoteTypingPeer[] {
		if (!this.isRemoteTypingGuardEnabled()) {
			return [];
		}

		try {
			const awareness = this.vaultSync.provider.awareness;
			return collectActiveRemoteTypers(
				awareness.getStates(),
				typeof awareness.clientID === "number" ? awareness.clientID : null,
				path,
				now,
			);
		} catch {
			return [];
		}
	}

	private warnConcurrentTyping(path: string, remoteTypers: RemoteTypingPeer[], now = Date.now()): void {
		const lastShownAt = this.concurrentTypingNoticeAtByPath.get(path) ?? 0;
		if (now - lastShownAt < CONCURRENT_TYPING_NOTICE_COOLDOWN_MS) {
			return;
		}

		this.concurrentTypingNoticeAtByPath.set(path, now);
		const noteName = path.split("/").pop() ?? path;
		new Notice(
			`KAOS: ${formatRemoteTypers(remoteTypers)} also recently typed in "${noteName}". Your edits remain enabled.`,
			8000,
		);
		this.trace?.("editor", "concurrent-typing-warning", {
			path,
			remoteTypers: remoteTypers.map((peer) => ({
				clientId: peer.clientId,
				deviceName: peer.deviceName,
				ageMs: now - peer.at,
			})),
		});
	}

	/**
	 * Get the CM6 EditorView from a MarkdownView.
	 * Resolution is based on DOM containment over a set of known CM6 views
	 * registered by our global ViewPlugin. This avoids private Obsidian APIs.
	 */
	private getCmView(view: MarkdownView): EditorView | null {
		const container = view.containerEl;
		if (!container) return null;

		const leafId =
			(view.leaf as unknown as { id?: string }).id ?? view.file?.path ?? null;
		let editorContent: string;
		try {
			editorContent = view.editor.getValue();
		} catch {
			this.trace?.("editor", "cm-resolution-editor-read-failed", {
				leafId: leafId ?? "unknown",
				path: view.file?.path ?? null,
			});
			return null;
		}

		const matches: EditorView[] = [];
		const stale: EditorView[] = [];
		for (const cm of this.knownCmViews) {
			if (!cm.dom.isConnected) {
				stale.push(cm);
				continue;
			}
			if (container.contains(cm.dom)) {
				matches.push(cm);
			}
		}
		for (const cm of stale) {
			this.knownCmViews.delete(cm);
			this.cmToLeafId.delete(cm);
		}

		if (matches.length === 0) return null;

		// During a same-leaf file switch Obsidian can briefly keep both the old
		// and new CodeMirror DOM trees connected. Never trust the stored binding
		// merely because its DOM is still contained by the MarkdownView. The CM
		// document must agree with the public editor facade for the current file.
		const currentDocumentMatches = matches.filter((cm) => {
			try {
				return cm.state.doc.toString() === editorContent;
			} catch {
				return false;
			}
		});
		if (currentDocumentMatches.length === 0) {
			this.trace?.("editor", "cm-resolution-document-mismatch", {
				leafId: leafId ?? "unknown",
				path: view.file?.path ?? null,
				editorLength: editorContent.length,
				matches: matches.map((cm) => this.getCmId(cm)),
			});
			return null;
		}

		const focused = currentDocumentMatches.filter((cm) => {
			const activeElement = cm.dom.ownerDocument?.activeElement ?? null;
			return cm.hasFocus || (activeElement ? cm.dom.contains(activeElement) : false);
		});
		if (focused.length === 1) return focused[0]!;
		if (currentDocumentMatches.length === 1) return currentDocumentMatches[0]!;

		const ids = currentDocumentMatches.map((cm) => this.getCmId(cm));
		this.trace?.("editor", "cm-resolution-ambiguous", {
			leafId: leafId ?? "unknown",
			path: view.file?.path ?? null,
			matches: ids,
		});
		this.log(
			`getCmView: ambiguous CM6 match for "${view.file?.path ?? "(unknown)"}" ` +
			`(leaf=${leafId ?? "unknown"}, matches=${ids.join(",")})`,
		);

		return null;
	}

	private warnCmDegraded(
		leafId: string,
		path: string | null,
		source: string,
		attempts: number,
	): void {
		if (this.cmDegradedWarned) return;
		this.cmDegradedWarned = true;
		new Notice(
			"KAOS: Live editing is still reconnecting for this note. " +
			"Background sync is still running; try focusing the editor or reopening the note if cursors do not appear.",
			10000,
		);
		console.warn(
			"[kaos] Live editor binding is still waiting for a CodeMirror 6 EditorView; background sync continues.",
		);
		this.trace?.("editor", "cm-resolution-notice-shown", {
			leafId,
			path,
			source,
			attempts,
		});
	}

	private getCmId(cm: EditorView): string {
		const existing = this.cmIds.get(cm);
		if (existing) return existing;
		const cmId = `cm-${++this.cmCounter}`;
		this.cmIds.set(cm, cmId);
		return cmId;
	}

	private getViewId(view: MarkdownView): string {
		const existing = this.viewIds.get(view);
		if (existing) return existing;
		const viewId = `view-${++this.viewCounter}`;
		this.viewIds.set(view, viewId);
		return viewId;
	}

	private registerKnownCmView(cm: EditorView): void {
		this.knownCmViews.add(cm);
	}

	private unregisterKnownCmView(cm: EditorView): void {
		this.knownCmViews.delete(cm);
		this.cmToLeafId.delete(cm);
		this.pendingReplacementCmToLeafId.delete(cm);
	}

	private inspectBindingHealth(
		view: MarkdownView,
		binding: EditorBinding,
	): BindingHealthCheck {
		if (this.bindingPropagationGate?.isPaused(binding.path)) {
			// Harness gate: treat as healthy so we don't auto-heal/rebind mid-scenario.
			return { healthy: true, settling: false, issues: [], deferredIssues: [] };
		}
		const issues: string[] = [];
		const deferredIssues: string[] = [];
		const file = view.file;
		const liveCm = this.getCmView(view);
		const collab = this.getCollabDebugInfoForView(view);
		const withinSettleWindow =
			Date.now() - binding.lastBoundAtMs < binding.settleWindowMs;

		if (!file) {
			issues.push("missing-file");
		} else if (binding.path !== file.path) {
			issues.push("path-changed");
		}

		if (!liveCm) {
			issues.push("missing-cm");
		} else if (liveCm !== binding.cm) {
			issues.push("cm-changed");
		}

		if (!collab) {
			issues.push("missing-collab-info");
		} else {
			if (!collab.hasSyncFacet) {
				if (withinSettleWindow) {
					deferredIssues.push("missing-sync-facet");
				} else {
					issues.push("missing-sync-facet");
				}
			}
			if (collab.awarenessMatchesProvider === false) {
				issues.push("awareness-mismatch");
			}
			if (collab.yTextMatchesExpected === false) {
				issues.push("ytext-mismatch");
			}
		}

		return {
			healthy: issues.length === 0,
			settling: issues.length === 0 && deferredIssues.length > 0,
			issues,
			deferredIssues,
		};
	}

	private filterRiskyNonUserPatch(transaction: Transaction): Transaction | TransactionSpec | readonly TransactionSpec[] {
		if (!transaction.docChanged) {
			return transaction;
		}

		if (this.isUserTransaction(transaction)) {
			const match = this.findBindingForState(transaction.startState);
			if (!match) return transaction;
			if (match.binding.view.file?.path !== match.binding.path) {
				// The transaction extender below detaches the stale yCollab
				// compartment in the same transaction. Do not evaluate remote
				// typing awareness against the previous file.
				return transaction;
			}

			const remoteTypers = this.getActiveRemoteTypersForPath(match.binding.path);
			if (remoteTypers.length === 0) return transaction;

			// Awareness is advisory only. Cancelling a CodeMirror user transaction
			// here loses normal and IME/composition input and can look exactly like
			// a rollback. Yjs remains responsible for merging concurrent edits.
			this.warnConcurrentTyping(match.binding.path, remoteTypers);
			return transaction;
		}

		const match = this.findBindingForState(transaction.startState);
		if (!match) return transaction;
		const { leafId, binding } = match;
		if (binding.view.file?.path !== binding.path) {
			// A late Yjs/provider projection can be built from A's yCollab state after
			// the host has already reused the MarkdownView for B. Cancel that document
			// change and remove the stale compartment in the same transaction. A fresh
			// bind is attempted only after the host callback has settled.
			return this.detachStaleBinding(
				leafId,
				binding,
				"non-user-projection",
			);
		}
		if (this.editorAuthorityShieldLeafIds.has(leafId)) {
			return { effects: this.compartment.reconfigure([]) };
		}

		const editorContent = transaction.startState.doc.toString();
		const incomingContent = transaction.newDoc.toString();
		const currentYTextContent = binding.ytext.toJSON();
		const externalReloadGuardEnabled = this.isExternalDiskReloadGuardEnabled();
		if (!externalReloadGuardEnabled) {
			this.invalidateExternalDiskReloadCorrelation(binding.path);
		}
		const pendingDiskMutation = externalReloadGuardEnabled
			? this.getFreshPendingExternalDiskMutation(binding.path)
			: null;
		const pendingPatch = this.pendingYTextPatches.get(binding.ytext);
		const validPendingPatch =
			pendingPatch &&
			pendingPatch.path === binding.path &&
			pendingPatch.leafId === leafId &&
			Date.now() - pendingPatch.at <= 1000
				? pendingPatch
				: null;
		if (currentYTextContent === incomingContent) {
			// Y.Text changed first: this is a normal Yjs/provider/local-repair patch,
			// not an Obsidian disk reload originating in the editor document.
			this.recentEditorOriginChanges.delete(binding.path);
		} else if (
			pendingDiskMutation &&
			pendingDiskMutation.content !== null &&
			!pendingDiskMutation.consumedLeafIds.has(leafId) &&
			incomingContent === normalizeEditorText(pendingDiskMutation.content)
		) {
			// The external disk event is stronger evidence than a transient
			// editor/Y.Text mismatch. This also covers a provider advance landing
			// between the disk event and Obsidian's editor reload.
			this.recentEditorOriginChanges.delete(binding.path);
			this.consumePendingExternalDiskMutation(pendingDiskMutation, leafId);
			this.notifyPendingExternalDiskReloadIntercepted(pendingDiskMutation);
			this.trace?.("editor", "external-disk-editor-reload-blocked", {
				path: binding.path,
				leafId,
				cmId: binding.cmId,
				editorLength: editorContent.length,
				externalLength: incomingContent.length,
				diskMtime: pendingDiskMutation.mtime,
				diskSize: pendingDiskMutation.size,
				correlationAgeMs: Date.now() - pendingDiskMutation.at,
			});
			return [];
		} else if (
			pendingDiskMutation &&
			pendingDiskMutation.content !== null &&
			!pendingDiskMutation.consumedLeafIds.has(leafId) &&
			transaction.annotation(Transaction.userEvent) === "set" &&
			this.prepareExternalDiskHostProjection({
				leafId,
				binding,
				currentText: editorContent,
				incomingText: incomingContent,
				candidate: pendingDiskMutation,
			})
		) {
			// Obsidian may 3-way merge a dirty TextFileView with bytes read from
			// disk, then dispatch the merged document as a CM-first `set`. Letting
			// that transaction through would bypass KAOS's baseline/conflict and
			// frontmatter policy and would put an external delta in both local undo
			// managers. Cancel only when the same event/binding lineage and the
			// TextFileView's before/after disk snapshots prove this is the host reload,
			// not an unrelated editor API call. The reconciliation controller alone
			// chooses and applies any resulting plan Y.Text-first.
			this.recentEditorOriginChanges.delete(binding.path);
			this.consumePendingExternalDiskMutation(pendingDiskMutation, leafId);
			this.notifyPendingExternalDiskReloadIntercepted(pendingDiskMutation);
			this.trace?.("editor", "external-disk-editor-host-merge-blocked", {
				path: binding.path,
				leafId,
				cmId: binding.cmId,
				sequence: pendingDiskMutation.sequence,
				currentLength: editorContent.length,
				incomingLength: incomingContent.length,
				externalLength: pendingDiskMutation.content?.length ?? 0,
			});
			const fence: PendingExternalDiskHostProjectionFence = {
				path: binding.path,
				leafId,
				binding,
				cm: binding.cm,
				bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
				sequence: pendingDiskMutation.sequence,
				beforeContent: editorContent,
				hostMergedContent: incomingContent,
			};
			this.rememberExternalDiskHostProjectionFence(transaction.startState, fence);
			return [];
		} else if (
			pendingDiskMutation === null &&
			transaction.annotation(Transaction.userEvent) === "set"
		) {
			const heldSequence = this.prepareHeldExternalDiskHostProjection({
				leafId,
				binding,
				currentText: editorContent,
				incomingText: incomingContent,
			});
			if (heldSequence !== null) {
				// The event ordering and TextFileView transition prove host provenance,
				// but the owning runtime has not completed its stable raw read. Hold the
				// projection without inventing a candidate or making a merge decision.
				this.recentEditorOriginChanges.delete(binding.path);
				const fence: PendingExternalDiskHostProjectionFence = {
					path: binding.path,
					leafId,
					binding,
					cm: binding.cm,
					bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
					sequence: heldSequence,
					beforeContent: editorContent,
					hostMergedContent: incomingContent,
				};
				this.trace?.("editor", "external-disk-editor-host-merge-held", {
					path: binding.path,
					leafId,
					cmId: binding.cmId,
					sequence: heldSequence,
					currentLength: editorContent.length,
					incomingLength: incomingContent.length,
				});
				this.rememberExternalDiskHostProjectionFence(transaction.startState, fence);
				return [];
			}
			if (currentYTextContent === editorContent) {
				this.captureRecentEditorOriginChange(
					leafId,
					binding,
					editorContent,
					incomingContent,
					transaction.startState,
				);
			}
		} else if (currentYTextContent === editorContent) {
			// A non-user CodeMirror/API edit starts in the editor and is then copied
			// into Y.Text by y-codemirror. It is a real successor of the visible
			// document even though it deliberately does not count as user activity.
			this.captureRecentEditorOriginChange(
				leafId,
				binding,
				editorContent,
				incomingContent,
				transaction.startState,
			);
		}
		if (!this.shouldShieldYTextPatch({
			origin: validPendingPatch?.origin ?? null,
			editorContent,
			incomingContent,
		})) {
			return transaction;
		}
		if (!this.hasRecentUserDocumentEdit(binding, RECENT_EDITOR_PATCH_SHIELD_MS)) {
			return transaction;
		}
		this.activateEditorAuthorityShield(
			leafId,
			binding,
			editorContent,
			incomingContent,
			validPendingPatch?.origin ?? null,
		);
		return { effects: this.compartment.reconfigure([]) };
	}

	private prepareExternalDiskHostProjection(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
		candidate: PendingExternalDiskMutation;
	}): boolean {
		const proof = this.resolveExternalDiskHostProjectionProof(input);
		if (
			!proof ||
			proof.start.sequence !== input.candidate.sequence ||
			input.candidate.content === null ||
			proof.externalLogicalContent !== normalizeEditorText(input.candidate.content)
		) {
			return false;
		}
		return this.restoreExternalDiskHostViewCache(
			proof,
			input.currentText,
			input.incomingText,
			input.candidate.sequence,
			true,
		);
	}

	private prepareHeldExternalDiskHostProjection(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
	}): number | null {
		const proof = this.resolveExternalDiskHostProjectionProof(input);
		// Before the stable raw read completes, only an observed transition from a
		// concrete lastSavedData baseline is strong enough to hold a host `set`.
		if (!proof || proof.snapshot.lastSavedData === null) return null;
		proof.snapshot.heldProjection = {
			beforeContent: input.currentText,
			hostMergedContent: input.incomingText,
			externalLogicalContent: proof.externalLogicalContent,
		};
		if (!this.restoreExternalDiskHostViewCache(
			proof,
			input.currentText,
			input.incomingText,
			proof.start.sequence,
			false,
		)) {
			proof.snapshot.heldProjection = null;
			return null;
		}
		return proof.start.sequence;
	}

	private resolveExternalDiskHostProjectionProof(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
	}): ExternalDiskHostProjectionProof | null {
		const start = this.pendingExternalDiskMutationStarts.get(input.binding.path);
		if (!start || Date.now() - start.at > EXTERNAL_DISK_RELOAD_CORRELATION_MS) {
			if (start) {
				this.pendingExternalDiskMutationStarts.delete(input.binding.path);
			}
			return null;
		}
		const snapshot = start.views.get(input.leafId);
		const currentEditorAuthorityRevision =
			this.editorAuthorityRevisionByCm.get(input.binding.cm) ?? 0;
		if (
			!snapshot ||
			snapshot.binding !== input.binding ||
			snapshot.view !== input.binding.view ||
			snapshot.cm !== input.binding.cm ||
			(this.bindingEpochByLeafId.get(input.leafId) ?? 0) !== snapshot.bindingEpoch ||
			input.binding.view.file?.path !== input.binding.path ||
			(
				currentEditorAuthorityRevision !== snapshot.editorAuthorityRevision &&
				!this.isExactExternalDiskHostSuccessorPreimage(
					input.binding,
					input.currentText,
					snapshot.editorAuthorityRevision,
					currentEditorAuthorityRevision,
					snapshot.yTextMutationRevision,
				)
			)
		) {
			return null;
		}
		const runtimeView = input.binding.view as MarkdownView & {
			data?: unknown;
			lastSavedData?: unknown;
		};
		if (runtimeView.data !== input.incomingText) return null;
		if (typeof runtimeView.lastSavedData !== "string") return null;
		const externalLogicalContent = normalizeEditorText(runtimeView.lastSavedData);
		if (
			snapshot.lastSavedData !== null &&
			normalizeEditorText(snapshot.lastSavedData) === externalLogicalContent
		) {
			return null;
		}
		return { start, snapshot, runtimeView, externalLogicalContent };
	}

	private isExactExternalDiskHostSuccessorPreimage(
		binding: EditorBinding,
		currentText: string,
		snapshotEditorAuthorityRevision: number,
		currentEditorAuthorityRevision: number,
		snapshotYTextMutationRevision: number,
	): boolean {
		if (currentEditorAuthorityRevision <= snapshotEditorAuthorityRevision) {
			return false;
		}
		try {
			if (!(
				binding.cm.state.doc.toString() === currentText &&
				binding.view.editor.getValue() === currentText
			)) {
				return false;
			}
		} catch {
			// Any unreadable or replaced surface is newer uncertainty. Do not rebase
			// the event-time host proof onto it.
			return false;
		}
		if (this.editorAuthorityContentByCm.get(binding.cm) === currentText) {
			return true;
		}
		return this.isExactYTextFirstExternalDiskHostSuccessorPreimage(
			binding,
			currentText,
			snapshotYTextMutationRevision,
		);
	}

	private isExactYTextFirstExternalDiskHostSuccessorPreimage(
		binding: EditorBinding,
		currentText: string,
		snapshotYTextMutationRevision: number,
	): boolean {
		const currentYText = this.vaultSync.getTextForPath(binding.path);
		if (currentYText !== binding.ytext || currentYText.toJSON() !== currentText) {
			return false;
		}
		const currentYTextMutationRevision =
			this.yTextMutationRevisionByText.get(currentYText) ?? 0;
		const latestYTextPatch = this.pendingYTextPatches.get(currentYText);
		if (
			currentYTextMutationRevision <= snapshotYTextMutationRevision ||
			!latestYTextPatch ||
			latestYTextPatch.path !== binding.path ||
			latestYTextPatch.revision !== currentYTextMutationRevision
		) {
			return false;
		}
		let currentYSyncOrigin: unknown;
		try {
			currentYSyncOrigin = binding.cm.state.facet(ySyncFacet);
		} catch {
			return false;
		}
		return (
			currentYSyncOrigin !== null &&
			currentYSyncOrigin !== undefined &&
			latestYTextPatch.origin !== currentYSyncOrigin
		);
	}

	private restoreExternalDiskHostViewCache(
		proof: ExternalDiskHostProjectionProof,
		currentText: string,
		incomingText: string,
		sequence: number,
		retireSnapshot: boolean,
	): boolean {
		try {
			if (proof.runtimeView.data !== incomingText) return false;
			// TextFileView stores the host-merged candidate before dispatching the
			// editor transaction. Restore that cache under the same exact CAS as the
			// cancelled CM patch so autosave cannot publish an unreviewed host merge
			// while the reconciliation controller is deciding the external candidate.
			proof.runtimeView.data = currentText;
			if (proof.runtimeView.data !== currentText) return false;
			if (retireSnapshot) {
				for (const [leafId, candidate] of proof.start.views) {
					if (candidate !== proof.snapshot) continue;
					proof.start.views.delete(leafId);
					break;
				}
				if (proof.start.views.size === 0) {
					this.pendingExternalDiskMutationStarts.delete(proof.start.path);
				}
			}
			return true;
		} catch (error) {
			this.trace?.("editor", "external-disk-editor-host-merge-proof-failed", {
				path: proof.start.path,
				sequence,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Attach final document provenance after all transaction filters have run.
	 * This is intentionally an extender: CodeMirror preserves its annotation
	 * across later extenders and invokes it for `filter: false` transactions.
	 */
	private annotateEditorDocumentOrigin(
		transaction: Transaction,
	): Pick<TransactionSpec, "annotations" | "effects"> | null {
		const match = this.findBindingForState(transaction.startState);
		const editorContent = transaction.startState.doc.toString();
		const hostProjectionFence = match
			? this.getExternalDiskHostProjectionFence(
				transaction,
				match.leafId,
				match.binding,
				editorContent,
			)
			: null;
		if (!transaction.docChanged) {
			if (hostProjectionFence && match) {
				// A later filter in this same state.update pipeline may still recreate
				// document changes. Keep the start-state keyed fence until its queued
				// microtask; a separate dispatch starts from the distinct result state.
				this.trace?.("editor", "external-disk-editor-host-merge-fence-completed", {
					path: match.binding.path,
					leafId: match.leafId,
					cmId: match.binding.cmId,
					sequence: hostProjectionFence.sequence,
					reason: "pipeline-completed-without-document-change",
				});
			}
			return null;
		}

		const incomingContent = transaction.newDoc.toString();
		const existingExternalReloadBypass = transaction.annotation(
			EXTERNAL_RELOAD_FILTER_BYPASS,
		);
		if (existingExternalReloadBypass) {
			return this.buildExternalReloadBypassSpec(existingExternalReloadBypass);
		}
		if (hostProjectionFence && match) {
			const { leafId, binding } = match;
			this.trace?.("editor", "external-disk-editor-host-merge-filter-bypassed", {
				path: binding.path,
				leafId,
				cmId: binding.cmId,
				sequence: hostProjectionFence.sequence,
				contentTransformed:
					hostProjectionFence.hostMergedContent !== incomingContent,
				userRelabeled: this.isUserTransaction(transaction),
			});
			return this.buildExternalReloadBypassSpec({
				path: binding.path,
				leafId,
				bindingEpoch: hostProjectionFence.bindingEpoch,
				beforeContent: editorContent,
				externalContent: incomingContent,
			});
		}
		if (this.isUserTransaction(transaction)) {
			return {
				annotations: EDITOR_AUTHORITY_TRANSACTION.of({
					content: incomingContent,
					source: "user",
				}),
			};
		}
		if (!match) return null;
		const { leafId, binding } = match;
		if (this.editorAuthorityShieldLeafIds.has(leafId)) return null;
		const currentYTextContent = binding.ytext.toJSON();
		const pendingPatch = this.pendingYTextPatches.get(binding.ytext);
		const validPendingPatch =
			pendingPatch &&
			pendingPatch.path === binding.path &&
			pendingPatch.leafId === leafId &&
			Date.now() - pendingPatch.at <= 1000
				? pendingPatch
				: null;

		if (currentYTextContent === incomingContent) {
			// Y.Text-first projections are collaboration/reconciliation state, not
			// user edits. y-codemirror already excludes their transaction origins
			// from its Y.UndoManager; mirror that invariant in Obsidian's native
			// CodeMirror history so Editor.undo cannot erase a remote or external
			// merge before reaching the user's own last edit.
			const undoTransparent = Transaction.addToHistory.of(false);
			if (validPendingPatch?.origin !== ORIGIN_EDITOR_EXTERNAL_RELOAD_REJECT) {
				return { annotations: undoTransparent };
			}
			return {
				annotations: [
					undoTransparent,
					EDITOR_AUTHORITY_TRANSACTION.of({
						content: incomingContent,
						source: "external-reload-correction",
					}),
				],
			};
		}

		const externalReloadGuardEnabled = this.isExternalDiskReloadGuardEnabled();
		if (!externalReloadGuardEnabled) {
			this.invalidateExternalDiskReloadCorrelation(binding.path);
		}
		const pendingDiskMutation = externalReloadGuardEnabled
			? this.getFreshPendingExternalDiskMutation(binding.path)
			: null;
		if (
			pendingDiskMutation &&
			pendingDiskMutation.content !== null &&
			incomingContent === normalizeEditorText(pendingDiskMutation.content)
		) {
			// A document-changing transaction reaching the extender proves that the
			// regular filter was bypassed (`filter: false`) or rewritten later. Preserve
			// the exact external bytes, then restore the previous editor document with a
			// post-update compare-and-revert.
			this.recentEditorOriginChanges.delete(binding.path);
			const alreadyConsumed = pendingDiskMutation.consumedLeafIds.has(leafId);
			this.consumePendingExternalDiskMutation(pendingDiskMutation, leafId);
			if (!alreadyConsumed) {
				this.notifyPendingExternalDiskReloadIntercepted(pendingDiskMutation);
			}
			this.trace?.("editor", "external-disk-editor-reload-filter-bypassed", {
				path: binding.path,
				leafId,
				cmId: binding.cmId,
				sequence: pendingDiskMutation.sequence,
			});
			return this.buildExternalReloadBypassSpec({
				path: binding.path,
				leafId,
				bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
				beforeContent: editorContent,
				externalContent: incomingContent,
			});
		}
		if (
			pendingDiskMutation &&
			pendingDiskMutation.content !== null &&
			!pendingDiskMutation.consumedLeafIds.has(leafId) &&
			transaction.annotation(Transaction.userEvent) === "set" &&
			this.prepareExternalDiskHostProjection({
				leafId,
				binding,
				currentText: editorContent,
				incomingText: incomingContent,
				candidate: pendingDiskMutation,
			})
		) {
			// `filter: false` skips the regular provenance gate. Re-run only the
			// exact host lineage proof here, then schedule the same post-update CAS
			// rollback used for an exact external replacement.
			this.recentEditorOriginChanges.delete(binding.path);
			this.consumePendingExternalDiskMutation(pendingDiskMutation, leafId);
			this.notifyPendingExternalDiskReloadIntercepted(pendingDiskMutation);
			this.trace?.("editor", "external-disk-editor-host-merge-filter-bypassed", {
				path: binding.path,
				leafId,
				cmId: binding.cmId,
				sequence: pendingDiskMutation.sequence,
			});
			return this.buildExternalReloadBypassSpec({
				path: binding.path,
				leafId,
				bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
				beforeContent: editorContent,
				externalContent: incomingContent,
			});
		}

		if (currentYTextContent !== editorContent) return null;
		this.captureRecentEditorOriginChange(
			leafId,
			binding,
			editorContent,
			incomingContent,
			transaction.startState,
		);
		return {
			annotations: EDITOR_AUTHORITY_TRANSACTION.of({
				content: incomingContent,
				source: "editor-api",
			}),
		};
	}

	private buildExternalReloadBypassSpec(
		bypass: ExternalReloadFilterBypass,
	): Pick<TransactionSpec, "annotations" | "effects"> {
		// `filter: false` skips transaction filters, and a later filter may recreate
		// a blocked change. Detach y-codemirror in this same final transaction so its
		// ViewPlugin cannot turn the proven host projection into a CM-first Y.Text
		// mutation. The post-update CAS restores CM from current CRDT authority and
		// reattaches the binding.
		return {
			annotations: [
				EXTERNAL_RELOAD_FILTER_BYPASS.of(bypass),
				Transaction.addToHistory.of(false),
			],
			effects: this.compartment.reconfigure([]),
		};
	}

	private buildGuardedCollabExtension(
		leafId: string,
		binding: EditorBinding,
	): Extension {
		if (this.bindingPropagationGate?.isPaused(binding.path)) return [];
		return [
			this.createYTextOriginCaptureExtension(
				binding.ytext,
				binding.path,
				leafId,
			),
			yCollab(binding.ytext, this.vaultSync.provider.awareness, {
				undoManager: binding.undoManager,
			}),
		];
	}

	private rememberExternalDiskHostProjectionFence(
		startState: EditorState,
		fence: PendingExternalDiskHostProjectionFence,
	): void {
		this.pendingExternalDiskHostProjectionFences.set(startState, fence);
		queueMicrotask(() => {
			if (this.pendingExternalDiskHostProjectionFences.get(startState) === fence) {
				this.pendingExternalDiskHostProjectionFences.delete(startState);
			}
		});
	}

	private getExternalDiskHostProjectionFence(
		transaction: Transaction,
		leafId: string,
		binding: EditorBinding,
		beforeContent: string,
	): PendingExternalDiskHostProjectionFence | null {
		const fence = this.pendingExternalDiskHostProjectionFences.get(
			transaction.startState,
		);
		if (!fence) return null;
		const current =
			fence.path === binding.path &&
			fence.leafId === leafId &&
			fence.binding === binding &&
			fence.cm === binding.cm &&
			fence.bindingEpoch === (this.bindingEpochByLeafId.get(leafId) ?? 0) &&
			binding.view.file?.path === binding.path &&
			fence.beforeContent === beforeContent;
		if (!current || transaction.docChanged) {
			this.pendingExternalDiskHostProjectionFences.delete(transaction.startState);
		}
		return current ? fence : null;
	}

	private captureRecentEditorOriginChange(
		leafId: string,
		binding: EditorBinding,
		beforeContent: string,
		afterContent: string,
		startState: EditorState,
	): void {
		const fileStat = binding.view.file?.stat;
		let expectedYTextOrigin: unknown = null;
		try {
			expectedYTextOrigin = startState.facet(ySyncFacet) ?? null;
		} catch {
			// Missing facet provenance fails the late rollback CAS closed.
		}
		this.rememberRecentEditorOriginChange({
			path: binding.path,
			leafId,
			binding,
			cm: binding.cm,
			ytext: binding.ytext,
			bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
			expectedEditorRevision: (this.editorRevisionByCm.get(binding.cm) ?? 0) + 1,
			expectedYTextMutationRevision:
				(this.yTextMutationRevisionByText.get(binding.ytext) ?? 0) + 1,
			expectedYTextOrigin,
			observedDiskMtime:
				typeof fileStat?.mtime === "number" && Number.isFinite(fileStat.mtime)
					? fileStat.mtime
					: null,
			observedDiskCtime:
				typeof fileStat?.ctime === "number" && Number.isFinite(fileStat.ctime)
					? fileStat.ctime
					: null,
			observedDiskSize:
				typeof fileStat?.size === "number" && Number.isFinite(fileStat.size)
					? fileStat.size
					: null,
			observedDiskSequence:
				this.observedExternalDiskMutationSequenceByPath.get(binding.path) ?? 0,
			beforeContent,
			afterContent,
			at: Date.now(),
		});
	}

	private promoteHeldExternalDiskHostProjection(
		notice: ExternalDiskMutationNotice,
		normalizedDiskContent: string | null,
		now: number,
	): boolean {
		const start = this.pendingExternalDiskMutationStarts.get(notice.path);
		if (
			!start ||
			start.sequence !== notice.sequence ||
			now - start.at > EXTERNAL_DISK_RELOAD_CORRELATION_MS
		) {
			return false;
		}

		const matchedLeafIds = new Set<string>();
		let heldCount = 0;
		for (const [leafId, snapshot] of start.views) {
			const held = snapshot.heldProjection;
			if (!held) continue;
			heldCount++;
			snapshot.heldProjection = null;
			if (
				normalizedDiskContent !== null &&
				held.externalLogicalContent === normalizedDiskContent
			) {
				matchedLeafIds.add(leafId);
				start.views.delete(leafId);
			}
		}
		if (heldCount === 0) return false;
		if (start.views.size === 0) {
			this.pendingExternalDiskMutationStarts.delete(notice.path);
		}
		if (matchedLeafIds.size === 0 || notice.content === null) {
			this.trace?.("editor", "external-disk-editor-host-merge-held-proof-mismatch", {
				path: notice.path,
				sequence: notice.sequence,
				heldCount,
				rawContentAvailable: notice.content !== null,
			});
			return false;
		}

		const marker: PendingExternalDiskMutation = {
			...notice,
			at: now,
			consumedLeafIds: matchedLeafIds,
			retireScheduled: false,
			candidateDeliveredFromEarlyHostProjection: true,
		};
		this.recentEditorOriginChanges.delete(notice.path);
		this.notifyExternalDiskReloadIntercepted(notice);
		this.rememberPendingExternalDiskMutation(marker);
		this.trace?.("editor", "external-disk-editor-host-merge-held-proven", {
			path: notice.path,
			sequence: notice.sequence,
			heldLeafCount: matchedLeafIds.size,
		});
		return true;
	}

	private rememberPendingExternalDiskMutation(marker: PendingExternalDiskMutation): void {
		this.pendingExternalDiskMutations.set(marker.path, marker);
		setTimeout(() => {
			if (this.pendingExternalDiskMutations.get(marker.path) === marker) {
				this.pendingExternalDiskMutations.delete(marker.path);
			}
		}, EXTERNAL_DISK_RELOAD_CORRELATION_MS);
	}

	private getFreshPendingExternalDiskMutation(path: string): PendingExternalDiskMutation | null {
		const marker = this.pendingExternalDiskMutations.get(path);
		if (!marker) return null;
		if (Date.now() - marker.at <= EXTERNAL_DISK_RELOAD_CORRELATION_MS) {
			return marker;
		}
		this.pendingExternalDiskMutations.delete(path);
		return null;
	}

	private consumePendingExternalDiskMutation(
		marker: PendingExternalDiskMutation,
		leafId: string,
	): void {
		const start = this.pendingExternalDiskMutationStarts.get(marker.path);
		if (start?.sequence === marker.sequence) {
			start.views.delete(leafId);
			if (start.views.size === 0) {
				this.pendingExternalDiskMutationStarts.delete(marker.path);
			}
		}
		marker.consumedLeafIds.add(leafId);
		if (marker.retireScheduled) return;
		const allLiveBindingsConsumed = () => Array.from(this.bindings.entries())
			.filter(([, binding]) =>
				binding.path === marker.path && binding.view.file?.path === marker.path
			)
			.every(([candidateLeafId]) => marker.consumedLeafIds.has(candidateLeafId));
		if (!allLiveBindingsConsumed()) return;

		// Keep the marker through the remainder of transaction construction. A
		// later filter may recreate changes after our filter returned [], and the
		// final extender must still recognize that exact external document.
		marker.retireScheduled = true;
		queueMicrotask(() => {
			if (this.pendingExternalDiskMutations.get(marker.path) !== marker) return;
			if (allLiveBindingsConsumed()) {
				this.pendingExternalDiskMutations.delete(marker.path);
			} else {
				marker.retireScheduled = false;
			}
		});
	}

	private rememberRecentEditorOriginChange(candidate: RecentEditorOriginChange): void {
		this.recentEditorOriginChanges.set(candidate.path, candidate);
		setTimeout(() => {
			if (this.recentEditorOriginChanges.get(candidate.path) === candidate) {
				this.recentEditorOriginChanges.delete(candidate.path);
			}
		}, EXTERNAL_DISK_RELOAD_CORRELATION_MS);
	}

	private getFreshRecentEditorOriginChange(
		path: string,
		now: number,
	): RecentEditorOriginChange | null {
		const candidate = this.recentEditorOriginChanges.get(path);
		if (!candidate) return null;
		if (now - candidate.at <= EXTERNAL_DISK_RELOAD_CORRELATION_MS) {
			return candidate;
		}
		this.recentEditorOriginChanges.delete(path);
		return null;
	}

	private isRecentEditorOriginChangeCurrent(candidate: RecentEditorOriginChange): boolean {
		if (this.bindings.get(candidate.leafId) !== candidate.binding) return false;
		if (candidate.binding.view.file?.path !== candidate.path) return false;
		if (candidate.binding.cm !== candidate.cm) return false;
		if ((this.bindingEpochByLeafId.get(candidate.leafId) ?? 0) !== candidate.bindingEpoch) {
			return false;
		}
		if ((this.editorRevisionByCm.get(candidate.cm) ?? 0) !== candidate.expectedEditorRevision) {
			return false;
		}
		const latestYTextPatch = this.pendingYTextPatches.get(candidate.ytext);
		if (
			candidate.expectedYTextOrigin === null ||
			(this.yTextMutationRevisionByText.get(candidate.ytext) ?? 0) !==
				candidate.expectedYTextMutationRevision ||
			!latestYTextPatch ||
			latestYTextPatch.path !== candidate.path ||
			latestYTextPatch.revision !== candidate.expectedYTextMutationRevision ||
			latestYTextPatch.origin !== candidate.expectedYTextOrigin ||
			latestYTextPatch.at < candidate.at
		) {
			return false;
		}
		if (candidate.cm.state.doc.toString() !== candidate.afterContent) return false;
		if (this.vaultSync.getTextForPath(candidate.path) !== candidate.ytext) return false;
		if (candidate.ytext.toJSON() !== candidate.afterContent) return false;
		try {
			return candidate.binding.view.editor.getValue() === candidate.afterContent;
		} catch {
			return false;
		}
	}

	private clearExternalDiskReloadCorrelation(path: string): void {
		this.pendingExternalDiskMutations.delete(path);
		this.pendingExternalDiskMutationStarts.delete(path);
		this.recentEditorOriginChanges.delete(path);
	}

	private invalidateExternalDiskReloadCorrelation(
		path: string,
		throughSequence = this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0,
	): void {
		this.clearExternalDiskReloadCorrelation(path);
		const previous = this.lastExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (throughSequence > previous) {
			// A proof started for an earlier binding/runtime lifetime must not arm a
			// later editor if its asynchronous read finishes after the transition.
			this.lastExternalDiskMutationSequenceByPath.set(path, throughSequence);
		}
	}

	private notifyExternalDiskReloadIntercepted(notice: ExternalDiskMutationNotice): void {
		if (notice.content === null) return;
		const candidate: InterceptedExternalDiskMutation = Object.freeze({
			path: notice.path,
			ctime: notice.ctime,
			mtime: notice.mtime,
			size: notice.size,
			sequence: notice.sequence,
			observedAt: notice.observedAt,
			content: notice.content,
			editorAuthorityLineage: notice.editorAuthorityLineage ?? null,
		});
		try {
			this.onExternalDiskReloadIntercepted?.(candidate);
		} catch (error) {
			this.trace?.("editor", "external-disk-candidate-callback-failed", {
				path: notice.path,
				sequence: notice.sequence,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private notifyPendingExternalDiskReloadIntercepted(
		marker: PendingExternalDiskMutation,
	): void {
		if (marker.candidateDeliveredFromEarlyHostProjection) return;
		this.notifyExternalDiskReloadIntercepted(marker);
	}

	private fenceStaleUserBinding(transaction: Transaction): TransactionSpec | null {
		if (!transaction.docChanged || !this.isUserTransaction(transaction)) {
			return null;
		}
		const match = this.findBindingForState(transaction.startState);
		if (!match) return null;
		const { leafId, binding } = match;
		const currentPath = binding.view.file?.path ?? null;
		if (currentPath === binding.path) return null;
		return this.detachStaleBinding(leafId, binding, "user-input");
	}

	private detachStaleBinding(
		leafId: string,
		binding: EditorBinding,
		source: "user-input" | "non-user-projection",
	): TransactionSpec {
		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);
		this.pendingReplacementCmToLeafId.delete(binding.cm);
		this.bumpBindingEpoch(leafId);
		this.trace?.("editor", "stale-binding-detached-before-editor-transaction", {
			leafId,
			boundPath: binding.path,
			currentPath: binding.view.file?.path ?? null,
			cmId: binding.cmId,
			source,
		});

		queueMicrotask(() => {
			binding.undoManager.destroy();
			this.bind(binding.view, this.lastDeviceName);
		});
		return { effects: this.compartment.reconfigure([]) };
	}

	private hasRecentUserDocumentEdit(binding: EditorBinding, windowMs: number): boolean {
		const lastDocChangeAt = binding.lastEditorDocChangeAtMs;
		return lastDocChangeAt != null && Date.now() - lastDocChangeAt < windowMs;
	}

	private recordYTextPatch(
		ytext: Y.Text,
		path: string,
		leafId: string,
		transaction: Y.Transaction,
	): void {
		let revision = this.yTextMutationRevisionByText.get(ytext) ?? 0;
		if (this.lastYTextMutationTransactionByText.get(ytext) !== transaction) {
			revision += 1;
			this.yTextMutationRevisionByText.set(ytext, revision);
			this.lastYTextMutationTransactionByText.set(ytext, transaction);
		}
		this.pendingYTextPatches.set(ytext, {
			origin: transaction.origin,
			path,
			leafId,
			at: Date.now(),
			revision,
		});
	}

	private createYTextOriginCaptureExtension(
		ytext: Y.Text,
		path: string,
		leafId: string,
	): Extension {
		const recordPatch = this.recordYTextPatch.bind(this);
		return ViewPlugin.fromClass(
			class {
				private readonly handler = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
					recordPatch(ytext, path, leafId, transaction);
				};

				constructor() {
					ytext.observe(this.handler);
				}

				destroy(): void {
					ytext.unobserve(this.handler);
				}
			},
		);
	}

	private shouldShieldYTextPatch(input: {
		origin: unknown;
		editorContent: string;
		incomingContent: string;
	}): boolean {
		// Only a freshly captured, named local repair may be fenced. Provider
		// objects, y-codemirror objects, null/missing origins, and stale captures
		// must flow through so the shield cannot turn a legitimate remote Yjs
		// update into a whole-document editor writeback.
		if (
			typeof input.origin !== "string" ||
			!EDITOR_AUTHORITY_SHIELD_ORIGINS.has(input.origin)
		) {
			return false;
		}
		if (
			input.origin === ORIGIN_EDITOR_HEALTH_HEAL ||
			input.origin === ORIGIN_EDITOR_AUTHORITY_SHIELD
		) {
			return false;
		}

		return !this.incomingContentPreservesEditorContent(
			input.editorContent,
			input.incomingContent,
		);
	}

	private incomingContentPreservesEditorContent(
		editorContent: string,
		incomingContent: string,
	): boolean {
		if (editorContent.length > incomingContent.length) return false;
		let editorIndex = 0;
		for (let incomingIndex = 0; incomingIndex < incomingContent.length; incomingIndex++) {
			if (incomingContent[incomingIndex] === editorContent[editorIndex]) {
				editorIndex++;
				if (editorIndex === editorContent.length) return true;
			}
		}
		return editorIndex === editorContent.length;
	}

	private isUserTransaction(transaction: Transaction): boolean {
		return (
			transaction.annotation(Transaction.userEvent) !== undefined &&
			(
				transaction.isUserEvent("input") ||
				transaction.isUserEvent("delete") ||
				transaction.isUserEvent("move") ||
				transaction.isUserEvent("undo") ||
				transaction.isUserEvent("redo")
			)
		);
	}

	private activateEditorAuthorityShield(
		leafId: string,
		binding: EditorBinding,
		editorContent: string,
		incomingContent: string,
		blockedOrigin: unknown,
	): void {
		if (this.bindings.get(leafId) !== binding) return;
		this.editorAuthorityShieldLeafIds.add(leafId);
		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);
		this.bumpBindingEpoch(leafId);
		this.trace?.("editor", "editor-authority-shield-activated", {
			leafId,
			path: binding.path,
			cmId: binding.cmId,
			origin: typeof blockedOrigin === "string" ? blockedOrigin : null,
			editorLength: editorContent.length,
			incomingLength: incomingContent.length,
			idleMs: binding.lastEditorDocChangeAtMs == null
				? null
				: Date.now() - binding.lastEditorDocChangeAtMs,
		});
		const expectedYText = binding.ytext;
		const expectedYTextContent = expectedYText.toJSON();

		queueMicrotask(() => {
			this.editorAuthorityShieldLeafIds.delete(leafId);
			binding.undoManager.destroy();
			this.applyEditorAuthorityAfterShield(
				binding,
				editorContent,
				incomingContent,
				expectedYText,
				expectedYTextContent,
				blockedOrigin,
			);
		});
	}

	private applyEditorAuthorityAfterShield(
		binding: EditorBinding,
		fallbackEditorContent: string,
		expectedIncomingContent: string,
		expectedYText: Y.Text,
		expectedYTextContent: string,
		blockedOrigin: unknown,
	): void {
		const file = binding.view.file;
		if (!file || file.path !== binding.path) return;
		const currentYText = this.vaultSync.getTextForPath(binding.path);
		if (
			currentYText !== expectedYText
			|| expectedYTextContent !== expectedIncomingContent
			|| expectedYText.toJSON() !== expectedYTextContent
		) {
			// The shield detached y-codemirror before scheduling this microtask.
			// A provider advance or same-bytes Y.Text identity replacement in that
			// gap is newer authority; writing the captured editor wholesale would
			// roll it back. Re-evaluate binding only and leave CRDT untouched.
			this.trace?.("editor", "editor-authority-shield-stale-snapshot", {
				path: binding.path,
				yTextIdentityCurrent: currentYText === expectedYText,
				yTextContentCurrent: expectedYText.toJSON() === expectedYTextContent,
				incomingMatchedCapturedCrdt: expectedYTextContent === expectedIncomingContent,
			});
			this.bind(binding.view, this.lastDeviceName);
			return;
		}

		let editorContent = fallbackEditorContent;
		try {
			editorContent = binding.view.editor.getValue();
		} catch {
			// Fall back to the transaction start document captured before the
			// blocked patch. That is still the last known editor authority.
		}

		const crdtContent = currentYText.toJSON();
		if (crdtContent !== editorContent) {
			applyDiffToYText(currentYText, crdtContent, editorContent, ORIGIN_EDITOR_AUTHORITY_SHIELD);
			this.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.editorAuthorityShieldApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path: binding.path,
				data: {
					reason: "editor-authority-shield",
					crdtLength: crdtContent.length,
					editorLength: editorContent.length,
					crdtMatchesEditorBefore: false,
					diffApplied: true,
					blockedOrigin: typeof blockedOrigin === "string" ? blockedOrigin : null,
				},
			});
		}

		this.bind(binding.view, this.lastDeviceName);
	}

	private handleLiveEditorUpdate(update: ViewUpdate): void {
		const userDocumentEdit = this.isUserDocumentEdit(update);
		let editorAuthorityAdvanceCount = 0;
		let latestEditorAuthorityContent: string | null = null;
		const externalReloadBypasses: ExternalReloadFilterBypass[] = [];
		for (const transaction of update.transactions) {
			if (!transaction.docChanged) continue;
			const bypass = this.getExternalReloadFilterBypass(transaction);
			if (bypass) {
				// Same-pipeline external provenance outranks annotations a later filter
				// may have added, including a synthetic userEvent label.
				externalReloadBypasses.push(bypass);
				continue;
			}
			if (this.isUserTransaction(transaction)) {
				editorAuthorityAdvanceCount += 1;
				const annotated = transaction.annotation(EDITOR_AUTHORITY_TRANSACTION);
				try {
					latestEditorAuthorityContent = annotated?.content
						?? transaction.newDoc.toString();
				} catch {
					// Synthetic harness transactions may omit newDoc. A missing exact
					// snapshot fails closed below without changing activity detection.
					latestEditorAuthorityContent = null;
				}
				continue;
			}

			const provenance = transaction.annotation(EDITOR_AUTHORITY_TRANSACTION);
			if (
				provenance &&
				typeof provenance.content === "string"
			) {
				editorAuthorityAdvanceCount += 1;
				latestEditorAuthorityContent = provenance.content;
			}
		}
		if (update.docChanged) {
			this.editorRevisionByCm.set(
				update.view,
				(this.editorRevisionByCm.get(update.view) ?? 0) + 1,
			);
		}
		if (editorAuthorityAdvanceCount > 0) {
			this.editorAuthorityRevisionByCm.set(
				update.view,
				(this.editorAuthorityRevisionByCm.get(update.view) ?? 0) +
					editorAuthorityAdvanceCount,
			);
			if (latestEditorAuthorityContent !== null) {
				this.editorAuthorityContentByCm.set(
					update.view,
					latestEditorAuthorityContent,
				);
			} else {
				// A missing exact successor snapshot must fail closed in reconciliation.
				this.editorAuthorityContentByCm.delete(update.view);
			}
		}
		if (userDocumentEdit) {
			this.lastUserDocChangeAtByCm.set(update.view, Date.now());
		}

		const match = this.findBindingForCm(update.view);
		if (!match) return;
		if (userDocumentEdit) {
			match.binding.lastEditorChangeAtMs =
				this.lastUserDocChangeAtByCm.get(update.view) ?? Date.now();
			match.binding.lastEditorDocChangeAtMs = match.binding.lastEditorChangeAtMs;
			this.lastEditorDocChangeAtByPath.set(
				match.binding.path,
				match.binding.lastEditorDocChangeAtMs,
			);
			this.publishLocalTypingActivity(match.leafId, match.binding, match.binding.lastEditorDocChangeAtMs);
		}
		for (const bypass of externalReloadBypasses) {
			this.deferExternalReloadFilterBypassRollback(update.view, bypass);
		}
		this.maybeHealBinding(match.leafId, match.binding, "live-update");
	}

	private deferExternalReloadFilterBypassRollback(
		cm: EditorView,
		bypass: ExternalReloadFilterBypass,
	): void {
		queueMicrotask(() => {
			const match = this.findBindingForCm(cm);
			if (
				!match ||
				match.leafId !== bypass.leafId ||
				match.binding.path !== bypass.path ||
				match.binding.view.file?.path !== bypass.path ||
				(this.bindingEpochByLeafId.get(match.leafId) ?? 0) !== bypass.bindingEpoch
			) {
				this.trace?.("editor", "external-disk-editor-reload-bypass-revert-skipped", {
					path: bypass.path,
					reason: "binding-lineage-changed",
				});
				return;
			}

			const { binding } = match;
			const currentYText = this.vaultSync.getTextForPath(bypass.path);
			let currentEditorContent: string | null = null;
			try {
				currentEditorContent = binding.view.editor.getValue();
			} catch {
				// An unreadable or replaced editor is newer uncertainty; leave it alone.
			}
			if (currentYText !== binding.ytext) {
				this.trace?.("editor", "external-disk-editor-reload-bypass-revert-skipped", {
					path: bypass.path,
					reason: "crdt-identity-changed",
				});
				return;
			}
			if (
				currentEditorContent !== bypass.externalContent ||
				cm.state.doc.toString() !== bypass.externalContent
			) {
				// A newer editor state won the CAS. It may now differ from Y.Text, so
				// direct reattachment would bypass canApplyBindingToEditor's equality
				// invariant. Keep both authorities untouched and detached; the guarded
				// health path will re-evaluate the current state from scratch.
				this.scheduleHealthCheck(
					match.leafId,
					LIVE_UPDATE_HEALTH_RETRY_DELAY_MS,
					"external-reload-bypass-divergent",
				);
				this.trace?.("editor", "external-disk-editor-reload-bypass-revert-skipped", {
					path: bypass.path,
					reason: "exact-editor-state-changed",
					bindingRestored: false,
					recoveryScheduled: true,
				});
				return;
			}

			// Detaching y-codemirror in the bypass transaction is the CRDT mutation
			// fence. Never roll Y.Text back to a captured snapshot here: a provider may
			// have legitimately advanced it, including to the same bytes as the disk
			// candidate. Project only the current Y.Text value into CM.
			const authoritativeContent = currentYText.toJSON();
			cm.dispatch({
				changes: {
					from: 0,
					to: cm.state.doc.length,
					insert: authoritativeContent,
				},
				annotations: [
					EDITOR_AUTHORITY_TRANSACTION.of({
						content: authoritativeContent,
						source: "external-reload-correction",
					}),
					Transaction.addToHistory.of(false),
				],
				effects: this.compartment.reconfigure(
					this.buildGuardedCollabExtension(match.leafId, binding),
				),
			});

			this.trace?.("editor", "external-disk-editor-reload-bypass-reverted", {
				path: bypass.path,
				leafId: bypass.leafId,
				beforeLength: bypass.beforeContent.length,
				externalLength: bypass.externalContent.length,
			});
		});
	}

	private carryCmActivityToPath(cm: EditorView, path: string): void {
		const lastUserDocChangeAt = this.lastUserDocChangeAtByCm.get(cm);
		if (lastUserDocChangeAt == null) return;
		const previous = this.lastEditorDocChangeAtByPath.get(path) ?? 0;
		if (lastUserDocChangeAt > previous) {
			this.lastEditorDocChangeAtByPath.set(path, lastUserDocChangeAt);
		}
	}

	private bumpBindingEpoch(leafId: string): number {
		const next = (this.bindingEpochByLeafId.get(leafId) ?? 0) + 1;
		this.bindingEpochByLeafId.set(leafId, next);
		return next;
	}

	private isUserDocumentEdit(update: ViewUpdate): boolean {
		if (!update.docChanged) return false;
		return update.transactions.some((transaction) =>
			transaction.docChanged &&
			this.getExternalReloadFilterBypass(transaction) === null &&
			this.isUserTransaction(transaction),
		);
	}

	private getExternalReloadFilterBypass(
		transaction: Transaction,
	): ExternalReloadFilterBypass | null {
		const bypass = transaction.annotation(EXTERNAL_RELOAD_FILTER_BYPASS);
		return (
			bypass &&
			typeof bypass.path === "string" &&
			typeof bypass.leafId === "string"
		) ? bypass : null;
	}

	private maybeHealBinding(
		leafId: string,
		binding: EditorBinding,
		source: string,
	): void {
		if (this.healthWorkInFlight.has(leafId)) return;
		if (this.bindings.get(leafId) !== binding) return;
		if (this.bindingPropagationGate?.isPaused(binding.path)) return;

		const health = this.inspectBindingHealth(binding.view, binding);
		if (health.healthy || health.settling) return;
		if (source === "live-update") {
			this.scheduleHealthCheck(leafId, LIVE_UPDATE_HEALTH_RETRY_DELAY_MS, "live-update-deferred");
			return;
		}
		if (this.deferRepairForRecentEditorActivity(leafId, binding, source, health.issues)) {
			return;
		}
		const onlyMissingSyncFacet =
			health.issues.length === 1 && health.issues[0] === "missing-sync-facet";
		if (onlyMissingSyncFacet && source !== "retry-health-check") {
			const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
			this.trace?.("editor", "binding-health-missing-sync-facet-deferred", {
				...traceDetails,
				action: "deferred",
			});
			const retryDelayMs = binding.settleWindowMs + POST_BIND_HEALTH_GRACE_MS;
			this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
			return;
		}

		const issues = health.issues.join(",") || "unknown";
		const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
		this.healthWorkInFlight.add(leafId);
		this.trace?.("editor", "binding-health-failed", traceDetails);
		this.log(
			`binding-health-failed: "${binding.path}" ` +
			`(leaf=${leafId}, cm=${binding.cmId}, source=${source}, issues=${issues})`,
		);

		try {
			const repaired = this.repair(
				binding.view,
				this.lastDeviceName,
				`${source}:${issues}`,
			);
			if (!repaired) {
				this.rebind(binding.view, this.lastDeviceName, `${source}:${issues}`);
			}
			const latestBinding = this.bindings.get(leafId);
			const tombstoned = this.isHardTombstonedPath(binding.path);
			const postView = latestBinding?.view ?? binding.view;
			const postHealth = latestBinding
				? this.inspectBindingHealth(postView, latestBinding)
				: null;
			const restored =
				tombstoned
				|| (!!postHealth && (postHealth.healthy || postHealth.settling));
			if (!restored) {
				this.trace?.("editor", "binding-health-retry-scheduled", {
					...traceDetails,
					action: "retry-scheduled",
					post: this.getCollabDebugInfoForView(postView),
					postIssues: postHealth?.issues ?? ["missing-binding"],
				});
				const retryDelayMs =
					(latestBinding?.settleWindowMs ?? BASE_BINDING_SETTLE_WINDOW_MS)
					+ POST_BIND_HEALTH_GRACE_MS;
				this.scheduleHealthCheck(leafId, retryDelayMs, "retry-health-check");
				return;
			}
			this.trace?.("editor", "binding-health-restored", {
				...traceDetails,
				action: tombstoned
					? "unbound-tombstone"
					: (postHealth?.settling
						? "settling"
						: (repaired
							? (!latestBinding
								? "unbound"
								: (latestBinding.path === binding.path
									&& latestBinding.fileId === binding.fileId
									? "repair-only"
									: "rebound-target"))
							: "rebind")),
				postIssues: postHealth?.issues ?? [],
				post: this.getCollabDebugInfoForView(postView),
			});
		} finally {
			this.healthWorkInFlight.delete(leafId);
		}
	}

	private scheduleCmResolveRetry(
		view: MarkdownView,
		deviceName: string,
		leafId: string,
		source: string,
	): void {
		if (this.pendingCmResolveRetries.has(leafId)) {
			return;
		}

		const attempts = (this.cmResolveAttempts.get(leafId) ?? 0) + 1;
		this.cmResolveAttempts.set(leafId, attempts);

		const path = view.file?.path ?? null;
		const retryDelay = CM_RESOLVE_RETRY_DELAYS_MS[attempts - 1];

		if (attempts === 1) {
			this.trace?.("editor", "cm-resolution-pending", {
				leafId,
				path,
				source,
				attempts,
			});
		}

		if (
			attempts >= CM_RESOLVE_DELAYED_ATTEMPT
			&& !this.cmResolveDelayedLogged.has(leafId)
		) {
			this.cmResolveDelayedLogged.add(leafId);
			this.log(
				`live binding waiting for Obsidian editor view ` +
				`("${path ?? "(unknown)"}", leaf=${leafId}, source=${source}, attempts=${attempts})`,
			);
			this.trace?.("editor", "cm-resolution-delayed", {
				leafId,
				path,
				source,
				attempts,
			});
		}

		if (retryDelay === undefined) {
			this.warnCmDegraded(leafId, path, source, attempts);
			this.trace?.("editor", "cm-resolution-degraded", {
				leafId,
				path,
				source,
				attempts,
			});
			const timer = setTimeout(() => {
				this.pendingCmResolveRetries.delete(leafId);
				this.bind(view, deviceName);
			}, CM_RESOLVE_IDLE_RETRY_DELAY_MS);
			this.pendingCmResolveRetries.set(leafId, timer);
			return;
		}

		const timer = setTimeout(() => {
			this.pendingCmResolveRetries.delete(leafId);
			this.bind(view, deviceName);
		}, retryDelay);
		this.pendingCmResolveRetries.set(leafId, timer);
	}

	private recentEditorRepairDelayMs(binding: EditorBinding): number {
		if (binding.lastEditorDocChangeAtMs == null) return 0;
		const elapsedMs = Date.now() - binding.lastEditorDocChangeAtMs;
		if (elapsedMs >= RECENT_EDITOR_REPAIR_DEFER_MS) return 0;
		return RECENT_EDITOR_REPAIR_DEFER_MS - elapsedMs + LIVE_UPDATE_HEALTH_RETRY_DELAY_MS;
	}

	private deferRepairForRecentEditorActivity(
		leafId: string,
		binding: EditorBinding,
		source: string,
		issues: string[],
	): boolean {
		const recentEditorRepairDelayMs = this.recentEditorRepairDelayMs(binding);
		if (recentEditorRepairDelayMs <= 0) return false;

		const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, issues);
		this.trace?.("editor", "binding-health-repair-deferred-recent-editor-activity", {
			...traceDetails,
			action: "deferred",
			delayMs: recentEditorRepairDelayMs,
		});
		this.scheduleHealthCheck(
			leafId,
			recentEditorRepairDelayMs,
			"recent-editor-activity-deferred",
		);
		return true;
	}

	private clearCmResolveRetry(leafId: string): void {
		const timer = this.pendingCmResolveRetries.get(leafId);
		if (timer) {
			clearTimeout(timer);
			this.pendingCmResolveRetries.delete(leafId);
		}
		this.cmResolveAttempts.delete(leafId);
		this.cmResolveDelayedLogged.delete(leafId);
	}

	private scheduleHealthCheck(
		leafId: string,
		delayMs: number,
		source: string,
	): void {
		this.clearScheduledHealthCheck(leafId);
		const timer = setTimeout(() => {
			this.pendingHealthChecks.delete(leafId);
			const binding = this.bindings.get(leafId);
			if (!binding) return;
			this.maybeHealBinding(leafId, binding, source);
		}, delayMs);
		this.pendingHealthChecks.set(leafId, timer);
	}

	private schedulePostBindHealthCheck(leafId: string, settleWindowMs: number): void {
		this.scheduleHealthCheck(
			leafId,
			settleWindowMs + POST_BIND_HEALTH_GRACE_MS,
			"post-bind-health",
		);
	}

	private clearScheduledHealthCheck(leafId: string): void {
		const timer = this.pendingHealthChecks.get(leafId);
		if (timer) {
			clearTimeout(timer);
			this.pendingHealthChecks.delete(leafId);
		}
	}

	private applyBinding(options: {
		action: "bind" | "repair";
		deviceName: string;
		view: MarkdownView;
		cm: EditorView;
		cmId: string;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		fileId?: string;
		existing?: EditorBinding;
		reason?: string;
		rapidSwitch?: boolean;
	}): boolean {
		const {
			action,
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath,
			ytext,
			fileId,
			existing,
			reason,
			rapidSwitch: rapidSwitchHint,
		} = options;

		if (!this.canApplyBindingToEditor({
			action,
			view,
			leafId,
			filePath,
			ytext,
			cm,
			reason,
		})) {
			return false;
		}

		const undoManager = new Y.UndoManager(ytext);

		this.vaultSync.provider.awareness.setLocalStateField("user", {
			name: deviceName,
			// TODO: configurable color
			color: "#30bced",
			colorLight: "#30bced33",
		});

		const collabExtension = yCollab(ytext, this.vaultSync.provider.awareness, {
			undoManager,
		});
		const guardedCollabExtension = [
			this.createYTextOriginCaptureExtension(ytext, filePath, leafId),
			collabExtension,
		];

		try {
			cm.dispatch({
				effects: this.compartment.reconfigure(guardedCollabExtension),
			});
		} catch (err) {
			undoManager.destroy();
			this.log(
				`${action}: failed "${filePath}" ` +
				`(leaf=${leafId}, cm=${cmId}, reason=${reason ?? "n/a"}): ${String(err)}`,
			);
			return false;
		}

		existing?.undoManager.destroy();
		if (existing) {
			this.cmToLeafId.delete(existing.cm);
		}
		this.pendingReplacementCmToLeafId.delete(cm);
		const boundAtMs = Date.now();
		const rapidSwitch = rapidSwitchHint ?? (
			!!existing
			&& existing.path !== filePath
			&& boundAtMs - existing.lastBoundAtMs <= FAST_SWITCH_WINDOW_MS
		);
		const settleWindowMs = rapidSwitch
			? FAST_SWITCH_BINDING_SETTLE_WINDOW_MS
			: BASE_BINDING_SETTLE_WINDOW_MS;
		const carryExistingActivity = existing?.path === filePath;
		const existingLastDocChangeAtMs = carryExistingActivity
			? (existing.lastEditorDocChangeAtMs ?? null)
			: null;
		const cachedLastDocChangeAtMs =
			this.lastEditorDocChangeAtByPath.get(filePath) ?? null;
		const cmLastDocChangeAtMs = this.lastUserDocChangeAtByCm.get(cm) ?? null;
		const lastEditorDocChangeAtMs =
			[existingLastDocChangeAtMs, cachedLastDocChangeAtMs, cmLastDocChangeAtMs]
				.filter((value): value is number => value != null)
				.reduce<number | null>(
					(latest, value) => latest == null ? value : Math.max(latest, value),
					null,
				);
		const lastEditorChangeAtMs = Math.max(
			boundAtMs,
			carryExistingActivity ? existing.lastEditorChangeAtMs : 0,
			lastEditorDocChangeAtMs ?? 0,
		);
		if (lastEditorDocChangeAtMs != null) {
			this.lastEditorDocChangeAtByPath.set(filePath, lastEditorDocChangeAtMs);
		}

		this.bumpBindingEpoch(leafId);
		this.bindings.set(leafId, {
			view,
			path: filePath,
			undoManager,
			ytext,
			cm,
			cmId,
			fileId,
			lastBoundAt: new Date(boundAtMs).toISOString(),
			lastBoundAtMs: boundAtMs,
			lastEditorChangeAtMs,
			lastEditorDocChangeAtMs,
			settleWindowMs,
		});
		const binding = this.bindings.get(leafId);
		if (binding) {
			this.publishLocalActiveFile(binding);
		}
		this.cmToLeafId.set(cm, leafId);
		this.schedulePostBindHealthCheck(leafId, settleWindowMs);
		this.trace?.("editor", "binding-applied", {
			action,
			leafId,
			path: filePath,
			cmId,
			fileId: fileId ?? null,
			reason: reason ?? null,
			settleWindowMs,
			rapidSwitch,
		});

		// Emit editor.repair.applied only for successful repair-action applications.
		if (action === "repair") {
			this.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path: filePath,
				data: {
					leafId,
					cmId,
					reason: reason ?? null,
					rapidSwitch,
				},
			});
		}

		const result = action === "repair" ? "repaired" : "bound";
		const reasonSuffix = reason ? `, reason=${reason}` : "";
		const settleSuffix = rapidSwitch
			? `, settleWindowMs=${settleWindowMs}, rapidSwitch=true`
			: `, settleWindowMs=${settleWindowMs}`;
		this.log(
			`${action}: ${result} "${filePath}" ` +
			`(leaf=${leafId}, cm=${cmId}${fileId ? `, fileId=${fileId}` : ""}${reasonSuffix}${settleSuffix})`,
		);
		return true;
	}

	private canApplyBindingToEditor(input: {
		action: "bind" | "repair";
		view: MarkdownView;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		cm: EditorView;
		reason?: string;
	}): boolean {
		if (input.view.file?.path !== input.filePath) {
			this.trace?.("editor", "binding-apply-view-path-changed", {
				action: input.action,
				path: input.filePath,
				currentPath: input.view.file?.path ?? null,
				reason: input.reason ?? null,
				leafId: input.leafId,
			});
			return false;
		}

		let editorContent: string;
		try {
			editorContent = input.view.editor.getValue();
		} catch {
			this.trace?.("editor", "binding-apply-editor-read-failed", {
				action: input.action,
				path: input.filePath,
				reason: input.reason ?? null,
				leafId: input.leafId,
			});
			return false;
		}

		let cmContent: string;
		try {
			if (
				!input.cm.dom.isConnected
				|| !input.view.containerEl.contains(input.cm.dom)
			) {
				this.trace?.("editor", "binding-apply-cm-detached", {
					action: input.action,
					path: input.filePath,
					reason: input.reason ?? null,
					leafId: input.leafId,
				});
				return false;
			}
			cmContent = input.cm.state.doc.toString();
		} catch {
			this.trace?.("editor", "binding-apply-cm-read-failed", {
				action: input.action,
				path: input.filePath,
				reason: input.reason ?? null,
				leafId: input.leafId,
			});
			return false;
		}
		if (cmContent !== editorContent) {
			this.trace?.("editor", "binding-apply-cm-diverged", {
				action: input.action,
				path: input.filePath,
				reason: input.reason ?? null,
				leafId: input.leafId,
				editorLength: editorContent.length,
				cmLength: cmContent.length,
			});
			this.log(
				`${input.action}: skipped binding for "${input.filePath}" ` +
				"because selected CodeMirror does not match the current editor",
			);
			return false;
		}
		const resolvedCm = this.getCmView(input.view);
		if (resolvedCm !== input.cm) {
			this.trace?.("editor", "binding-apply-cm-not-current", {
				action: input.action,
				path: input.filePath,
				reason: input.reason ?? null,
				leafId: input.leafId,
				selectedCmId: this.getCmId(input.cm),
				resolvedCmId: resolvedCm ? this.getCmId(resolvedCm) : null,
			});
			this.log(
				`${input.action}: skipped binding for "${input.filePath}" ` +
				"because selected CodeMirror is no longer current",
			);
			return false;
		}

		const crdtContent = input.ytext.toJSON();
		if (cmContent === crdtContent) {
			return true;
		}

		this.trace?.("editor", "binding-apply-editor-diverged", {
			action: input.action,
			path: input.filePath,
			reason: input.reason ?? null,
			leafId: input.leafId,
			editorLength: editorContent.length,
			crdtLength: crdtContent.length,
		});
		this.log(
			`${input.action}: skipped binding for "${input.filePath}" ` +
			`because open editor differs from CRDT (reason=${input.reason ?? "n/a"})`,
		);
		return false;
	}

	private log(msg: string): void {
		this.trace?.("editor", msg);
		if (this.debug) {
			console.debug(`[kaos:editor] ${msg}`);
		}
	}

	private findBindingForCm(cm: EditorView): { leafId: string; binding: EditorBinding } | null {
		const leafId = this.cmToLeafId.get(cm);
		if (leafId) {
			const binding = this.bindings.get(leafId);
			if (binding && binding.cm === cm) {
				return { leafId, binding };
			}
		}

		const pendingLeafId = this.pendingReplacementCmToLeafId.get(cm);
		if (pendingLeafId) {
			const binding = this.bindings.get(pendingLeafId);
			if (binding && this.isPendingReplacementCmForBinding(cm, binding)) {
				return { leafId: pendingLeafId, binding };
			}
			this.pendingReplacementCmToLeafId.delete(cm);
		}

		for (const [fallbackLeafId, binding] of this.bindings) {
			if (binding.cm === cm) {
				this.cmToLeafId.set(cm, fallbackLeafId);
				return { leafId: fallbackLeafId, binding };
			}
		}

		return null;
	}

	private isPendingReplacementCmForBinding(cm: EditorView, binding: EditorBinding): boolean {
		const file = binding.view.file;
		if (!file || file.path !== binding.path) return false;
		if (!cm.dom.isConnected) return false;
		return binding.view.containerEl.contains(cm.dom);
	}

	private findBindingForState(state: EditorState): { leafId: string; binding: EditorBinding } | null {
		for (const [leafId, binding] of this.bindings) {
			if (binding.cm.state === state) {
				return { leafId, binding };
			}
		}
		for (const cm of this.knownCmViews) {
			if (cm.state !== state) continue;
			return this.findBindingForCm(cm);
		}

		// CodeMirror may build a transaction from an intermediate state while the
		// EditorView still exposes the batch's predecessor state. State identity is
		// therefore not a stable view identifier inside transaction filters and
		// extenders. The ySync facet configuration is stable across those states and
		// unique per yCollab binding, so use its identity as the lineage fallback.
		let stateSyncFacet: unknown;
		try {
			stateSyncFacet = state.facet(ySyncFacet);
		} catch {
			stateSyncFacet = undefined;
		}
		if (stateSyncFacet) {
			for (const [leafId, binding] of this.bindings) {
				let bindingSyncFacet: unknown;
				try {
					bindingSyncFacet = binding.cm.state.facet(ySyncFacet);
				} catch {
					bindingSyncFacet = undefined;
				}
				if (bindingSyncFacet === stateSyncFacet) {
					return { leafId, binding };
				}
			}
		}
		return null;
	}

	private resolveBindingTarget(
		view: MarkdownView,
		_deviceName: string,
		reason: string,
	): BindingTarget | null {
		const file = view.file;
		if (!file) return null;
		if (!this.isMarkdownPathSyncable(file.path)) {
			this.skipExcludedBinding(view, file.path, `resolve:${reason}`);
			return null;
		}

		const existingText = this.vaultSync.getTextForPath(file.path);
		if (existingText) {
			let currentContent: string;
			try {
				currentContent = view.editor.getValue();
			} catch {
				this.trace?.("editor", "binding-target-editor-read-failed", {
					path: file.path,
					reason,
					leafId:
						(view.leaf as unknown as { id: string }).id ?? file.path,
				});
				return null;
			}
			const crdtContent = existingText.toJSON();
			if (currentContent !== crdtContent) {
				this.trace?.("editor", "binding-target-editor-diverged", {
					path: file.path,
					reason,
					leafId:
						(view.leaf as unknown as { id: string }).id ?? file.path,
					editorLength: currentContent.length,
					crdtLength: crdtContent.length,
				});
				this.log(
					`resolveBindingTarget: skipped binding for "${file.path}" ` +
					`because open editor differs from CRDT (reason=${reason})`,
				);
				return null;
			}
			return {
				ytext: existingText,
				fileId:
					this.vaultSync.getFileId(file.path)
					?? this.vaultSync.getFileIdForText(existingText),
			};
		}

		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, reason);
			return null;
		}

		this.log(
			`resolveBindingTarget: waiting for controller admission for "${file.path}" (reason=${reason})`,
		);
		this.trace?.("editor", "missing-target-awaiting-controller", {
			path: file.path,
			reason,
			leafId:
				(view.leaf as unknown as { id: string }).id ?? file.path,
		});
		return null;
	}

	private canBindPath(view: MarkdownView, reason: string): boolean {
		const path = view.file?.path;
		if (!path) return false;
		if (this.isMarkdownPathSyncable(path)) return true;
		this.skipExcludedBinding(view, path, reason);
		return false;
	}

	private skipExcludedBinding(view: MarkdownView, path: string, reason: string): void {
		const leafId = (view.leaf as unknown as { id: string }).id ?? path;
		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		this.unbind(view);
		this.trace?.("editor", "binding-skipped-excluded-path", {
			leafId,
			path,
			reason,
		});
		this.log(`binding skipped for excluded path "${path}" (reason=${reason})`);
	}

	private isHardTombstonedPath(path: string): boolean {
		return (
			!this.vaultSync.getTextForPath(path)
			&& !this.vaultSync.isPendingRenameTarget(path)
			&& this.vaultSync.isMarkdownTombstoned(path)
		);
	}

	private handleTombstonedBinding(view: MarkdownView, reason: string): void {
		const file = view.file;
		if (!file) return;

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		this.trace?.("editor", "binding-blocked-tombstone", {
			path: file.path,
			leafId,
			reason,
			hadBinding: !!existing,
			pendingRenameTarget: this.vaultSync.isPendingRenameTarget(file.path),
		});
		this.log(
			`binding blocked by tombstone for "${file.path}" ` +
			`(leaf=${leafId}, reason=${reason})`,
		);
		if (existing) {
			this.unbind(view);
		}
	}

	private buildHealthTraceDetails(
		leafId: string,
		binding: EditorBinding,
		source: string,
		issues: string[],
	): Record<string, unknown> {
		const activeLeaf =
			(binding.view.leaf as unknown as { workspace?: { activeLeaf?: unknown } })
				.workspace?.activeLeaf;
		return {
			leafId,
			path: binding.path,
			cmId: binding.cmId,
			source,
			issues,
			binding: this.getBindingDebugInfoForView(binding.view),
			collab: this.getCollabDebugInfoForView(binding.view),
			isActiveLeaf: binding.view.leaf === activeLeaf,
			documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
		};
	}

	private isAuditActionable(view: MarkdownView, issues: string[]): boolean {
		const file = view.file;
		if (!file) {
			return false;
		}

		const activeLeaf =
			(view.leaf as unknown as { workspace?: { activeLeaf?: unknown } }).workspace?.activeLeaf;
		const isActiveLeaf = view.leaf === activeLeaf;
		if (isActiveLeaf) {
			return true;
		}

		return issues.some(
			(issue) =>
				issue !== "missing-file"
				&& issue !== "missing-collab-info",
		);
	}
}
