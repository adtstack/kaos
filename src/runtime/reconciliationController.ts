import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import type { BlobSyncManager } from "../sync/blobSync";
import type {
	DiskMirror,
	DiskFileRevision,
	DiskWriteAuthorityPhase,
	DiskWriteResult,
	PreservedUnresolvedRedirectResult,
	RemoteProjectionAdmissionLease,
} from "../sync/diskMirror";
import {
	type DiskIndex,
	collectFileStats,
	contentBaselineHash,
	contentFingerprint,
	filterChangedFiles,
	updateIndex,
} from "../sync/diskIndex";
import type { ReconcileMode, VaultSync } from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { RuntimeConfig } from "./runtimeConfig";
import type {
	EditorBindingManager,
	ExternalDiskMutationEditorAuthorityLineage,
	InterceptedExternalDiskMutation,
	OpenEditorMutationTicket,
} from "../sync/editorBinding";
import type {
	ProductFlightEventInput,
	ProductFlightPathEventInput,
} from "../observability/traceSink";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
// Types only — no FLIGHT_KIND enum import.
import type {
	FrontmatterIngestBlockBranch,
	RecoverySkippedFrontmatterData,
} from "../observability/recoveryEventTypes";
import {
	applyExactDiffToYText,
	applyDiffToYText,
	applyDiffToYTextWithPostcondition,
	type DiffPostconditionResult,
	type ExactDiffResult,
} from "../sync/diff";
import { yTextToString } from "../utils/format";
import { mergeTexts3 } from "../utils/threeWayMerge";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
} from "../sync/origins";
import { planClosedFileReconcile } from "./reconcile/closedFilePlanner";
import {
	planOpenBoundFileReconcile,
	type OpenBoundEditorAuthority,
	type OpenBoundFileReconcileAction,
} from "./reconcile/openBoundFilePlanner";
import { planOpenExternalEdit } from "./reconcile/openExternalEditPlanner";
import { planBaselineAdvancement, type BaselineActionKind } from "./reconcile/baselineAdvancementPolicy";
import { evaluateSafetyBrake } from "./reconcile/safetyBrakePolicy";
import {
	computeRecoveryFingerprint,
	evaluateFingerprintQuarantine,
	findOldestFingerprintEntry,
	FINGERPRINT_MAP_MAX_SIZE,
	type FingerprintEntry,
} from "./reconcile/fingerprintQuarantinePolicy";
import {
	evaluateAmplificationQuarantine,
	findOldestAmplificationEntry,
	AMPLIFICATION_WINDOW_MS,
	type AmplificationEntry,
} from "./reconcile/amplificationQuarantinePolicy";
import {
	planNoEventStructuralRenames,
	type UnresolvedStructuralChange,
} from "./reconcile/noEventStructuralPlanner";
import { evaluatePathBindingIntegrity } from "../sync/pathBindingIntegrity";
import { isCrdtDocumentPath } from "../paths/crdtDocumentPath";
import { getOpenFileViewsForPath } from "../utils/openFileViews";
import {
	getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
	type RemoteDeletePreservedUnresolvedReason,
} from "../sync/preservedUnresolved";
import { normalizeEditorText } from "../utils/editorTextNormalization";

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;

export interface ReconciliationStats {
	at: string;
	mode: ReconcileMode;
	plannedCreates: number;
	plannedUpdates: number;
	flushedCreates: number;
	flushedUpdates: number;
	safetyBrakeTriggered: boolean;
	safetyBrakeReason: string | null;
}

export interface ReconciliationState {
	reconciled: boolean;
	reconcileInFlight: boolean;
	reconcilePending: boolean;
	lastReconcileStats: ReconciliationStats | null;
	lastReconciledGeneration: number;
	untrackedFileCount: number;
	blockedDivergenceCount: number;
	lastBlockedDivergenceAt: string | null;
	/** Safe sample of blocked paths: extensions + fingerprint hashes (no raw filenames). */
	blockedDivergenceSample: Array<{ ext: string; hash: string }>;
	unresolvedStructuralChangeCount: number;
	/** Number of logical structural conflicts, independent of old/new path cardinality. */
	unresolvedStructuralChangeGroupCount: number;
	/** Complete path set used to suppress duplicate durable path-collision rows. */
	unresolvedStructuralChangePaths: string[];
	unresolvedStructuralChangeSample: Array<{
		oldPaths: string[];
		newPaths: string[];
		reason: UnresolvedStructuralChange["reason"];
		contentHashPrefix: string;
	}>;
}

import { type DiskIngestPort } from "./engineControlPort";

export type MarkdownDirtyReason = "create" | "modify";

interface MarkdownDirtyEntry {
	reason: MarkdownDirtyReason;
	primaryOpId?: string;
	coalescedOpIds: string[];
	retryCount: number;
	notBeforeMs?: number;
	/** Per-path ingest generation captured when the disk event was admitted. */
	generation?: number;
	/**
	 * Attention episode that already existed when the real vault event arrived.
	 * Internal retries retain this token; they must never acquire a newer token
	 * merely because an older event happened to drain after quarantine began.
	 */
	preservedUnresolvedEpisodeIdAtAdmission?: string;
}

export type StableMarkdownReadResult =
	| { kind: "ready"; file: TFile; content: string; stat: { mtime: number; size: number } | null }
	| { kind: "missing" }
	| { kind: "unstable" };

type ExternalCandidatePreservationResult =
	| { kind: "preserved" }
	| { kind: "invalidated" };

interface ActiveMarkdownIngest {
	path: string;
	entry: MarkdownDirtyEntry;
	redirectedTo: string | null;
	generation: number;
	diskRevision: number;
}

export interface MarkdownRemoteDeleteResolutionLease {
	readonly path: string;
	readonly operation: "accept-remote-delete";
	readonly generation: number;
}

/**
 * Immutable identity of the Attention episode shown to the user. Callers that
 * render `firstSeenAt`/`lastSeenAt` should pass it back so an old dashboard
 * action cannot resolve a replacement incident with the same path/reason.
 */
export interface MarkdownRemoteDeleteEntryIdentity {
	reason: RemoteDeletePreservedUnresolvedReason;
	episodeId: string;
	remoteDeleteFingerprint?: string;
	localFile?: {
		kind: "file" | "missing" | "other";
		mtime: number | null;
		size: number | null;
	};
}

export interface MarkdownConflictEntryIdentity {
	reason: PreservedUnresolvedReason;
	episodeId: string;
	localFile?: {
		kind: "file" | "missing" | "other";
		mtime: number | null;
		size: number | null;
	};
}

type InternalMarkdownResolutionLease = MarkdownRemoteDeleteResolutionLease | {
	readonly path: string;
	readonly operation: "keep-local";
	readonly generation: number;
};

type OpenEditorAuthority =
	| { kind: "none" }
	| { kind: "single"; content: string }
	| { kind: "multiple" }
	| { kind: "read-failed" };

/**
 * Exact visible-editor snapshots captured when startup reconciliation has to
 * yield to an editor that is still settling.  Keeping only the path is not
 * enough: after close/autosave the disk may contain E while Y.Text still
 * contains C, and a path-only marker cannot tell which side is the user's
 * visible work.
 */
interface DeferredVisibleEditorAuthority {
	editorContents: string[];
	readComplete: boolean;
	capturedDiskContent: string | null;
	capturedCrdtContent: string | null;
	capturedDiskRevision: number;
	capturedEditorActivity: number | null;
	capturedEditorTicket: VisibleAuthorityLineageTicket | null;
	capturedAt: number;
}

interface StartupOpenFileAuthoritySnapshot {
	path: string;
	file: TFile | null;
	diskStat: {
		ctime: number | null;
		mtime: number | null;
		size: number | null;
	} | null;
	baselineHash: string | null;
	baselineRevision: number;
	lifecycleGeneration: number;
	expectedYText: ReturnType<VaultSync["getTextForPath"]>;
	expectedCrdtContent: string;
	editorTicket: OpenEditorMutationTicket | null;
	diskRevision: number;
	visibleAuthorityMarker: DeferredVisibleEditorAuthority | null;
	interceptedCandidate: InterceptedExternalDiskMutation | null;
	candidateIdentityEpoch: number;
	attentionGeneration: number;
	syncScopeGeneration: number;
}

type VisibleAuthorityTicketProgressKind =
	| "successor"
	| "not-successor"
	| "unavailable"
	| "incompatible";

interface VisibleAuthorityLineageViewTicket {
	viewId: string;
	leafId: string;
	cmId: string | null;
	bindingEpoch: number;
	editorRevision: number;
	editorAuthorityRevision: number;
	editorAuthorityContent: string | null;
	editorContent: string | null;
}

interface VisibleAuthorityLineageTicket {
	path: string;
	views: VisibleAuthorityLineageViewTicket[];
}

interface VisibleAuthorityTicketProgress {
	kind: VisibleAuthorityTicketProgressKind;
	/** Exact local editor-origin snapshots observed between both tickets. */
	advancedEditorContents: string[];
	/** A complete same-lineage local advance supersedes one older exact snapshot. */
	supersedesPreviousSingle: boolean;
	/** Same complete CM lineage proves every editor-authority revision is unchanged. */
	provenNoEditorAuthorityAdvance: boolean;
}

type DeferredVisibleAuthorityDecision =
	| { kind: "none" }
	| { kind: "settled"; content: string }
	| { kind: "disk-wins"; content: string }
	| { kind: "crdt-wins"; content: string }
	| { kind: "unresolved"; marker: DeferredVisibleEditorAuthority };

type OpenEditorSettleReason =
	| "recent-editor-activity"
	| "recent-remote-update"
	| "editor-ahead-without-activity-timestamp";

type BoundFileSyncGapOutcome =
	| { kind: "not-handled" }
	| {
		kind: "handled";
		settlement?: {
			content: string;
			expectedYText: ReturnType<VaultSync["getTextForPath"]>;
			expectedCrdtContent: string | null;
			expectedEditorTicket?: OpenEditorMutationTicket;
			expectedOpenEditorContent: string;
		};
	}
	| { kind: "deferred"; deferUntil: number; reason: string }
	| {
		kind: "flush-crdt-to-disk";
		provisionalBaseline?: boolean;
		reason: string;
		authorityLease: OpenFlushAuthorityLease;
	};

/**
 * Controller-owned authority for one open-file Y.Text -> disk flush.
 *
 * DiskMirror deliberately receives only the synchronous predicate plus the
 * file CAS fields. It remains a filesystem bridge and never learns merge or
 * editor policy semantics.
 */
interface OpenFlushAuthorityLease {
	readonly path: string;
	readonly stage: string;
	readonly expectedDiskFile: TFile;
	readonly expectedDiskStat: { ctime: number | null; mtime: number | null; size: number | null };
	readonly expectedDiskFileRevision?: DiskFileRevision;
	readonly expectedDiskEventRevision: number;
	readonly expectedBaselineHash: string | null;
	readonly expectedBaselineRevision: number;
	readonly expectedLifecycleGeneration: number;
	readonly expectedYText: ReturnType<VaultSync["getTextForPath"]>;
	readonly expectedCrdtContent: string | null;
	readonly expectedEditorTicket: OpenEditorMutationTicket | null;
	readonly expectedVisibleAuthorityMarker: DeferredVisibleEditorAuthority | null;
	readonly expectedInterceptedCandidate: InterceptedExternalDiskMutation | null;
	readonly expectedCandidateIdentityEpoch: number;
	readonly shouldAbort: () => boolean;
}

type OpenExternalTraceMessage =
	| "open-external-candidate-captured"
	| "open-external-recent-typing-deferred"
	| "open-external-clean-merge-applied"
	| "open-external-overlapping-hunk-discarded"
	| "open-external-frontmatter-blocked"
	| "open-external-disk-settled"
	| "open-external-baseline-advanced";

type OpenExternalTraceReason =
	| "intercepted-external-disk-mutation"
	| "recent-editor-activity"
	| "recent-editor-activity-local-only"
	| "apply-external"
	| "apply-clean-merge"
	| "overlapping-hunks"
	| "bound-file-open-safe-external-merge"
	| "already-settled"
	| "open-external-representation-normalized"
	| "open-external-current-only"
	| "open-external-overlapping-hunks"
	| "open-external-missing-baseline";

interface OpenExternalTraceDetails extends Record<string, unknown> {
	path: string;
	reason: OpenExternalTraceReason;
	sequence?: number;
	contentLength?: number;
	diskLength?: number;
	currentLength?: number | null;
	targetLength?: number;
	hunkCount?: number;
	deferMs?: number;
	artifactCreated?: boolean;
	contentHashPrefix?: string | null;
}

type OpenEditorDiskMutationCommit<T> =
	| { kind: "committed"; value: T }
	| { kind: "stale" };

type ClosedFileReconcileMutationCommit<T> =
	| { kind: "committed"; value: T }
	| { kind: "stale" };

interface ReconciliationControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getRuntimeConfig(): RuntimeConfig;
	getVaultSync(): VaultSync | null;
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getEditorBindings(): EditorBindingManager | null;
	getDiskIndex(): DiskIndex;
	setDiskIndex(index: DiskIndex): void;
	getBaselineText?(contentHash: string): Promise<string | null> | string | null;
	recordBaselineText?(contentHash: string, text: string): void;
	isMarkdownPathSyncable(path: string): boolean;
	/** Provider-generation admission for CRDT-to-disk projection only. */
	isRemoteProjectionAllowed?(path: string): boolean;
	getMarkdownAttentionGeneration?(): number;
	getMarkdownSyncScopeGeneration?(): number;
	/** True only for built-in system/generated paths, never a user preference. */
	shouldTombstoneIntrinsicMarkdownPath?(path: string): boolean;
	/** True only for built-in system/generated paths, never a user preference. */
	shouldTombstoneIntrinsicBlobPath?(path: string): boolean;
	shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean;
	refreshServerCapabilities(reason: string): Promise<void>;
	validateOpenEditorBindings(reason: string): void;
	replayPendingBlobIntents?(reason: string): Promise<void> | void;
	onReconciled(reason: string): void;
	onBlobReconciled?(mode: ReconcileMode, vaultSync: VaultSync): void;
	recordFlightEvent?(event: ProductFlightEventInput): void;
	recordFlightPathEvent?(event: ProductFlightPathEventInput): void;
	readStableMarkdownFile?(
		path: string,
		reason: MarkdownDirtyReason,
	): Promise<StableMarkdownReadResult>;
	/**
	 * Read the current physical Markdown text without relying on Obsidian's
	 * event-indexed document projection. Production supplies an adapter-backed
	 * reader; lightweight tests may omit it and retain Vault.read semantics.
	 */
	readFreshMarkdownFile?(file: TFile): Promise<string>;
	getAwaitingFirstProviderSyncAfterStartup(): boolean;
	setAwaitingFirstProviderSyncAfterStartup(value: boolean): void;
	saveDiskIndex(): Promise<void>;
	refreshStatusBar(): void;
	/**
	 * Returns the Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Used by planClosedFileReconcile to detect disk edits made while KAOS
	 * was inactive (missing-baseline tie-breaking). Returns 0 if never saved.
	 * Naming: getLastDiskIndexPersistedAt — this is the last save, not last
	 * plugin activity; conflating them creates false certainty.
	 */
	getLastSaveDiskIndexAt?(): number;
	trace(source: string, msg: string, details?: Record<string, unknown>): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
	/**
	 * Phase 2 (Requirement 10): Compute a witness-domain recoveryStateHash for content.
	 * Called when emitting recovery.decision events while a flight trace is active.
	 * Returns null if no trace is active or hash computation fails.
	 */
	computeRecoveryStateHash?(path: string, content: string): Promise<string | null>;
	/** True only while the explicit QA disk-ingest control is suspended. */
	isDiskIngestSuspendedForQa?(): boolean;
	/**
	 * Optional: harness registration hook for disk-ingest control.
	 * Called once during reconciliation setup. The callback receives a
	 * control port that the QA harness can store and call to trigger
	 * syncFileFromDisk deterministically, bypassing the dirty-queue pipeline.
	 * Must not be wired in production main.ts.
	 */
	registerDiskIngestPort?(port: DiskIngestPort): void;
	/**
	 * Optional: durable audit sink for discarded markdown revisions. With
	 * conflict-artifact preservation abolished, every losing revision is
	 * reported here (path identity already hashed) instead of being written
	 * to a `(KAOS conflict ...)` file. Absent in tests unless a capture stub
	 * is wired.
	 */
	recordDiscardedRevision?(path: string, contentHash: string, reason: string): void;
}

const RECONCILE_COOLDOWN_MS = 10_000;
const MARKDOWN_DIRTY_SETTLE_MS = 350;
const MARKDOWN_STABLE_READ_MAX_RETRIES = 3;
const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
/**
 * Idle window for the bound-file-local-only-divergence branch.
 *
 * Distinct from OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS (1200ms, used only by
 * the crdtOnly branch). The localOnly branch is the typing-cadence amplifier
 * shape — Obsidian autosave landing keystrokes faster than the y-codemirror
 * plumbing propagates them into Y.Text. Quenching that loop requires a
 * window longer than a typical human typing burst; 3000ms is conservative.
 */
const OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS = 3000;
const BOUND_RECOVERY_LOCK_MS = 1500;
const TRACE_PATH_SAMPLE_LIMIT = 50;

function tracePathList(prefix: string, paths: string[]): Record<string, unknown> {
	return {
		[`${prefix}PathCount`]: paths.length,
		[`${prefix}PathSample`]: paths.slice(0, TRACE_PATH_SAMPLE_LIMIT),
		[`${prefix}PathsTruncated`]: paths.length > TRACE_PATH_SAMPLE_LIMIT,
	};
}

/**
 * Closed-shape result of the binding-health predicate. `reasons` is empty
 * when `healthy === true`. The same shape is recorded in trace events so
 * future RCAs can read why the controller chose to repair (or not).
 */
interface BindingHealthResult {
	healthy: boolean;
	reasons: string[];
}

/**
 * Inspect captured binding/collab debug info and decide whether the
 * editor binding is actually broken. The localOnly recovery branch uses
 * this to skip `editorBindings.repair()` when the binding looks fine —
 * unconditional reconfigure on every recovery cycle was a contributor to
 * the typing-cadence amplifier loop.
 *
 * Healthy when ALL of:
 *   - `binding.cmMatches !== false` (the EditorView is the one we tracked)
 *   - `collab.hasSyncFacet !== false` (yCollab compartment is attached)
 *   - `collab.yTextMatchesExpected !== false` (facet points at our ytext)
 *   - `collab.awarenessMatchesProvider !== false` (awareness wired)
 *
 * Null values are treated as "not signal" — they neither confirm nor
 * deny health. They do not flip the verdict.
 *
 * If `binding` or `collab` themselves are null we fall back to "unhealthy"
 * because we have no evidence the binding is wired at all.
 */
function classifyBindingHealth(
	binding: { cmMatches: boolean | null; leafId?: string | null } | null | undefined,
	collab: {
		hasSyncFacet: boolean;
		yTextMatchesExpected: boolean | null;
		awarenessMatchesProvider: boolean | null;
	} | null | undefined,
): BindingHealthResult {
	const reasons: string[] = [];
	if (binding == null) reasons.push("missing-binding-info");
	if (collab == null) reasons.push("missing-collab-info");
	if (binding && binding.cmMatches === false) reasons.push("cm-mismatch");
	if (collab && collab.hasSyncFacet === false) reasons.push("missing-sync-facet");
	if (collab && collab.yTextMatchesExpected === false) reasons.push("ytext-mismatch");
	if (collab && collab.awarenessMatchesProvider === false) reasons.push("awareness-mismatch");
	return { healthy: reasons.length === 0, reasons };
}

function isMissingFileReadError(err: unknown): boolean {
	const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
	if (!e) return false;
	if (e.code === "ENOENT" || e.name === "NotFoundError") return true;
	if (typeof e.message !== "string") return false;
	return e.message.includes("ENOENT") || e.message.includes("no such file or directory");
}

function traceRecoveryPostcondition(
	trace: ReconciliationControllerDeps["trace"],
	recordFlightPathEvent: ReconciliationControllerDeps["recordFlightPathEvent"],
	path: string,
	reason: string,
	origin: string,
	expectedLength: number,
	result: DiffPostconditionResult,
): void {
	trace("recovery", "recovery-postcondition-observed", {
		path,
		reason,
		origin,
		expectedLength,
		actualLength: result.finalLength,
		matchesExpected: result.finalMatchesExpected,
		matchesAfterDiff: result.matchesAfterDiff,
		diffSkippedDueToStaleBase: result.diffSkippedDueToStaleBase,
		enforced: true,
		forceReplaceApplied: result.forceReplaceApplied,
	});
	if (result.forceReplaceApplied) {
		trace("recovery", "recovery-force-replace-applied", {
			path,
			reason,
			origin,
			expectedLength,
			actualLength: result.finalLength,
			finalMatchesExpected: result.finalMatchesExpected,
			diffSkippedDueToStaleBase: result.diffSkippedDueToStaleBase,
		});
	}
	if (!result.finalMatchesExpected) {
		trace("recovery", "recovery-postcondition-failed", {
			path,
			reason,
			origin,
			expectedLength,
			actualLength: result.finalLength,
		});
		// Also emit via typed FlightSink so the analyzer can detect it
		recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryPostconditionFailed,
			severity: "error",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				origin,
				expectedLength,
				actualLength: result.finalLength,
				forceReplaceApplied: result.forceReplaceApplied,
			},
		});
	}
}

export class ReconciliationController {
	private reconciled = false;
	private reconcileInFlight = false;
	private reconcilePending = false;
	private untrackedFiles: string[] = [];
	private lastReconciledGeneration = 0;
	private lastReconcileTime = 0;
	private reconcileCooldownTimer: ReturnType<typeof setTimeout> | null = null;
	private lastReconcileStats: ReconciliationStats | null = null;
	private dirtyMarkdownPaths = new Map<string, MarkdownDirtyEntry>();
	private activeMarkdownIngests = new Map<string, ActiveMarkdownIngest>();
	/**
	 * Monotonic per-path fence. A remote-delete resolution increments the
	 * generation so dirty work admitted before that decision cannot publish
	 * after the user has acted on the Attention row.
	 */
	private markdownIngestGenerations = new Map<string, number>();
	/** Monotonic vault-event revision, separate from Attention ownership epochs. */
	private markdownDiskRevisions = new Map<string, number>();
	/** Orders verified baseline publishers so an older reconcile cannot win ABA. */
	private diskBaselineRevisions = new Map<string, number>();
	/** Exact live editor authority that must survive an open -> closed race. */
	private visibleAuthorityDeferredPaths = new Map<string, DeferredVisibleEditorAuthority>();
	/**
	 * Exact open-file flush leases currently inside DiskMirror. This registry
	 * scopes marker identity preservation to the active flush window; it never
	 * attributes an event by timing or relaxes editor/CRDT/baseline authority.
	 */
	private activeOpenFlushAuthorityLeases =
		new Map<string, Set<OpenFlushAuthorityLease>>();
	/** Exact raw intercepted disk revisions awaiting safe open-file reconciliation. */
	private interceptedExternalDiskMutations = new Map<string, InterceptedExternalDiskMutation>();
	/** FIFO revisions that must reach the discard audit before retirement. */
	private pendingSupersededExternalDiskMutations =
		new Map<string, InterceptedExternalDiskMutation[]>();
	/** At most one superseded-candidate drain may run for a path. */
	private supersededExternalPreservationByPath =
		new Map<string, Promise<ExternalCandidatePreservationResult>>();
	/** Monotonic path-identity fence for intercepted external disk candidates. */
	private externalCandidateIdentityEpochs = new Map<string, number>();
	/** Invalidates fire-and-forget preservation work across reset/reinitialization. */
	private lifecycleGeneration = 0;
	/** At most one Keep/Accept resolution may own a Markdown path. */
	private markdownRemoteDeleteResolutions = new Map<string, InternalMarkdownResolutionLease>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();
	private recoveryFingerprints = new Map<string, FingerprintEntry>();
	/**
	 * Per-path amplification history for the monotonic-growth quarantine.
	 * Independent of `recoveryFingerprints` — fingerprint quarantine catches
	 * "same diff repeating," this catches "growing diff repeating."
	 */
	private amplificationHistory = new Map<string, AmplificationEntry[]>();
	private blockedDivergenceCount = 0;
	private lastBlockedDivergenceAt: string | null = null;
	private blockedDivergenceSample: Array<{ ext: string; hash: string }> = [];
	private unresolvedStructuralChanges: UnresolvedStructuralChange[] = [];
	private readonly diagnosticPathSalt =
		Math.random().toString(36).slice(2) + Date.now().toString(36);
	/** Amplification-quarantine notice throttle. */
	private lastAmplificationNoticeAt = 0;
	private amplificationNoticeSuppressionCount = 0;
	private static readonly AMPLIFICATION_NOTICE_COOLDOWN_MS = 60_000;

	constructor(private readonly deps: ReconciliationControllerDeps) {
		// If a QA harness is attached, register the disk-ingest control port now.
		// In normal production, registerDiskIngestHarnessPort is absent.
		deps.registerDiskIngestPort?.({
			ingestDiskFileNow: async (path, reason) => {
				if (
					__KAOS_QA_HARNESS_ENABLED__ &&
					this.deps.isDiskIngestSuspendedForQa?.() === true
				) {
					this.deps.trace("qa", "disk-ingest-suspended", {
						path,
						reason: "qa-disk-ingest-suspended",
					});
					return;
				}
				const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
				if (!(abstractFile instanceof TFile)) {
					throw new Error(`ingestDiskFileNow: not a file: ${path}`);
				}
				const entry: MarkdownDirtyEntry = {
					reason,
					primaryOpId: undefined,
					coalescedOpIds: [],
					retryCount: 0,
					generation: this.getMarkdownIngestGeneration(path),
				};
				const active = this.beginActiveMarkdownIngest(path, entry);
				try {
					await this.syncFileFromDisk(abstractFile, entry, active);
				} finally {
					this.finishActiveMarkdownIngest(active);
				}
			},
		});
	}

	get isReconciled(): boolean {
		return this.reconciled;
	}

	get isReconcileInFlight(): boolean {
		return this.reconcileInFlight;
	}

	get pending(): boolean {
		return this.reconcilePending;
	}

	get lastGeneration(): number {
		return this.lastReconciledGeneration;
	}

	set lastGeneration(value: number) {
		this.lastReconciledGeneration = value;
	}

	get untrackedFileCount(): number {
		return this.untrackedFiles.length;
	}

	getState(): ReconciliationState {
		return {
			reconciled: this.reconciled,
			reconcileInFlight: this.reconcileInFlight,
			reconcilePending: this.reconcilePending,
			lastReconcileStats: this.lastReconcileStats,
			lastReconciledGeneration: this.lastReconciledGeneration,
			untrackedFileCount: this.untrackedFiles.length,
			blockedDivergenceCount: this.blockedDivergenceCount,
			lastBlockedDivergenceAt: this.lastBlockedDivergenceAt,
			blockedDivergenceSample: this.blockedDivergenceSample,
			unresolvedStructuralChangeCount: this.unresolvedStructuralChanges.reduce(
				(total, change) => total + change.oldPaths.length + change.newPaths.length,
				0,
			),
			unresolvedStructuralChangeGroupCount: this.unresolvedStructuralChanges.length,
			unresolvedStructuralChangePaths: Array.from(new Set(
				this.unresolvedStructuralChanges.flatMap((change) => [
					...change.oldPaths,
					...change.newPaths,
				]),
			)),
			unresolvedStructuralChangeSample: this.unresolvedStructuralChanges.slice(0, 10).map((change) => ({
				oldPaths: change.oldPaths.slice(0, 5),
				newPaths: change.newPaths.slice(0, 5),
				reason: change.reason,
				contentHashPrefix: change.contentHash.slice(0, 12),
			})),
		};
	}

	markPending(): void {
		this.reconcilePending = true;
	}

	/**
	 * Synchronously invalidate every async authority snapshot owned by this
	 * controller. Teardown calls this before any awaited cleanup; it deliberately
	 * performs no I/O, scheduling, or state cleanup of its own.
	 */
	revokeAsyncAuthority(): void {
		this.lifecycleGeneration += 1;
	}

	reset(): void {
		this.revokeAsyncAuthority();
		if (this.reconcileCooldownTimer) {
			clearTimeout(this.reconcileCooldownTimer);
			this.reconcileCooldownTimer = null;
		}
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
			this.markdownDrainTimer = null;
		}
		this.reconciled = false;
		this.reconcileInFlight = false;
		this.reconcilePending = false;
		this.untrackedFiles = [];
		this.lastReconciledGeneration = 0;
		this.lastReconcileTime = 0;
		this.lastReconcileStats = null;
		this.dirtyMarkdownPaths.clear();
		for (const active of this.activeMarkdownIngests.values()) {
			this.bumpMarkdownIngestGeneration(active.path);
		}
		this.activeMarkdownIngests.clear();
		this.markdownRemoteDeleteResolutions.clear();
		this.markdownDiskRevisions.clear();
		this.visibleAuthorityDeferredPaths.clear();
		this.activeOpenFlushAuthorityLeases.clear();
		this.interceptedExternalDiskMutations.clear();
		this.pendingSupersededExternalDiskMutations.clear();
		this.supersededExternalPreservationByPath.clear();
		// lifecycleGeneration advances before epochs reset, so old async work cannot
		// become current again when a cleared path starts at epoch zero.
		this.externalCandidateIdentityEpochs.clear();
		this.markdownDrainPromise = null;
		this.lastMarkdownDirtyAt = 0;
		this.recoveryFingerprints.clear();
		this.amplificationHistory.clear();
		this.blockedDivergenceCount = 0;
		this.lastBlockedDivergenceAt = null;
		this.blockedDivergenceSample = [];
		this.unresolvedStructuralChanges = [];
		this.lastAmplificationNoticeAt = 0;
		this.amplificationNoticeSuppressionCount = 0;
		this.boundRecoveryLocks.clear();
	}

	/**
	 * Lightweight authoritative reconcile after a reconnection.
	 * Fresh disk read catches drift during disconnect.
	 */
	async runReconnectReconciliation(generation: number): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		this.deps.log(`Running reconnect reconciliation (gen ${generation})`);
		await this.deps.refreshServerCapabilities("provider-sync");
		this.deps.validateOpenEditorBindings(`reconnect-pre:${generation}`);

		// Untracked files are never auto-imported during reconnect. The list may
		// come from a conservative pre-sync scan and can be stale relative to a
		// provider tombstone; automatic revive here could resurrect a remote delete.
		// Explicit user import remains available after authoritative reconcile.

		await this.runReconciliation("authoritative");
		this.lastReconciledGeneration = generation;
		this.deps.setAwaitingFirstProviderSyncAfterStartup(false);
		this.deps.onReconciled(`reconnect-post:${generation}`);

		if (this.reconcilePending && !this.reconcileCooldownTimer) {
			this.reconcilePending = false;
			const nextVaultSync = this.deps.getVaultSync();
			if (nextVaultSync && nextVaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(nextVaultSync.connectionGeneration);
			} else {
				void this.runReconciliation(this.getSafeReconcileMode("authoritative"));
			}
		}
	}

	private isDiskWriteSettled(
		result: DiskWriteResult | undefined,
	): result is Extract<DiskWriteResult, { kind: "written" | "unchanged" }> {
		return result?.kind === "written" || result?.kind === "unchanged";
	}

	private traceDiskWriteNotSettled(
		path: string,
		result: DiskWriteResult | undefined,
		reason: string,
	): void {
		this.deps.trace("reconcile", "disk-write-not-settled", {
			path,
			reason,
			resultKind: result?.kind ?? "missing-disk-mirror",
			resultReason: result && "reason" in result ? result.reason : null,
			error: result?.kind === "failed" ? result.error : null,
		});
	}

	private requestReconciliationFollowup(path: string, reason: string): void {
		this.reconcilePending = true;
		this.deps.trace("reconcile", "reconcile-followup-requested", {
			path,
			reason,
		});
		if (!this.reconcileInFlight) {
			this.schedulePendingReconciliation(this.getSafeReconcileMode("authoritative"));
		}
	}

	private requestFollowupForUnsettledDiskWrite(
		path: string,
		result: DiskWriteResult | undefined,
		reason: string,
	): void {
		if (
			result?.kind === "deferred" &&
			(result.reason === "disk-changed-during-write" ||
				result.reason === "crdt-changed-during-write" ||
				result.reason === "authority-stale" ||
				result.reason === "open-editor-mismatch" ||
				result.reason === "active-editor-unflushed" ||
				result.reason === "recent-editor-activity")
		) {
			this.requestReconciliationFollowup(path, `${reason}:${result.reason}`);
		}
	}

	private schedulePendingReconciliation(fallbackMode: ReconcileMode): void {
		if (!this.reconcilePending || this.reconcileCooldownTimer) return;

		const elapsed = Date.now() - this.lastReconcileTime;
		const delay = Math.max(0, RECONCILE_COOLDOWN_MS - elapsed);
		this.reconcileCooldownTimer = setTimeout(() => {
			this.reconcileCooldownTimer = null;
			if (!this.reconcilePending) return;
			this.reconcilePending = false;
			const nextMode = this.getSafeReconcileMode(fallbackMode);
			void this.runReconciliation(nextMode);
		}, delay);
		(this.reconcileCooldownTimer as unknown as { unref?: () => void }).unref?.();
	}

	private getSafeReconcileMode(fallbackMode: ReconcileMode): ReconcileMode {
		const vaultSync = this.deps.getVaultSync();
		const getter = (
			vaultSync as unknown as { getSafeReconcileMode?: () => ReconcileMode } | null
		)?.getSafeReconcileMode;
		return typeof getter === "function"
			? getter.call(vaultSync)
			: fallbackMode;
	}

	private getPreservedUnresolvedMarkdownEntries(): PreservedUnresolvedEntry[] {
		const diskMirror = this.deps.getDiskMirror() as
			| (DiskMirror & { getPreservedUnresolvedEntries?: () => PreservedUnresolvedEntry[] })
			| null;
		return diskMirror?.getPreservedUnresolvedEntries?.()
			.filter((entry) => entry.kind === "markdown") ?? [];
	}

	private isMarkdownPreservedUnresolved(path: string): boolean {
		const diskMirror = this.deps.getDiskMirror() as
			| (DiskMirror & { isPreservedUnresolved?: (candidatePath: string) => boolean })
			| null;
		return diskMirror?.isPreservedUnresolved?.(path) ??
			this.getPreservedUnresolvedMarkdownEntries().some((entry) => entry.path === path);
	}

	/**
	 * Compare-and-commit fence for closed-file disk→CRDT decisions.
	 *
	 * Hashing, baseline lookup, and conflict-artifact creation all yield back to
	 * the event loop. A provider update or a new disk save can therefore make a
	 * previously valid authority decision stale. Re-read disk last, then verify
	 * the Y.Text identity and content synchronously; no event can interleave
	 * between the successful check and the caller's immediate Y.Text mutation.
	 */
	private async commitClosedFileReconcileMutation<T>(input: {
		path: string;
		file: TFile | null;
		expectedYText: ReturnType<VaultSync["getTextForPath"]>;
		expectedDiskContent: string;
		expectedCrdtContent: string | null;
		expectedDiskRevision: number;
		expectedPreservedUnresolvedEpisodeId?: string;
		stage: string;
		commit: () => T;
	}): Promise<ClosedFileReconcileMutationCommit<T>> {
		let currentDiskContent: string | null = null;
		let diskReadFailed = false;
		let diskIdentityChanged = false;
		const expectedStat = input.file
			? {
				mtime: typeof input.file.stat?.mtime === "number" ? input.file.stat.mtime : null,
				size: typeof input.file.stat?.size === "number" ? input.file.stat.size : null,
			}
			: null;
		if (
			!input.file ||
			input.file.path !== input.path ||
			this.deps.app.vault.getAbstractFileByPath(input.path) !== input.file
		) {
			diskReadFailed = true;
			diskIdentityChanged = input.file !== null;
		} else {
			try {
				currentDiskContent = await this.readFreshMarkdownFile(input.file);
				if (
					input.file.path !== input.path ||
					this.deps.app.vault.getAbstractFileByPath(input.path) !== input.file
				) {
					diskIdentityChanged = true;
				}
			} catch {
				diskReadFailed = true;
			}
		}

		const currentOpenViews = this.getOpenMarkdownViewsForPath(input.path);
		const isNowBound = this.deps.getEditorBindings()?.isBound(input.path) ?? false;
		const currentDiskRevision = this.getMarkdownDiskRevision(input.path);
		const diskStatChanged = !!input.file && !!expectedStat && (
			(typeof input.file.stat?.mtime === "number" ? input.file.stat.mtime : null) !== expectedStat.mtime
			|| (typeof input.file.stat?.size === "number" ? input.file.stat.size : null) !== expectedStat.size
		);
		const currentYText = this.deps.getVaultSync()?.getTextForPath(input.path) ?? null;
		const currentCrdtContent = yTextToString(currentYText);
		const preservedEntry = this.getPreservedUnresolvedMarkdownEntries()
			.find((entry) => entry.path === input.path);
		const preservedUnresolvedMismatch = input.expectedPreservedUnresolvedEpisodeId
			? !preservedEntry ||
				getPreservedUnresolvedEpisodeId(preservedEntry) !==
					input.expectedPreservedUnresolvedEpisodeId
			: preservedEntry !== undefined;
		const reason = currentDiskRevision !== input.expectedDiskRevision
			? "disk-event-generation-changed"
			: diskStatChanged
				? "disk-stat-changed"
				: diskIdentityChanged
					? "disk-file-identity-changed"
					: diskReadFailed
						? "disk-read-failed"
						: currentDiskContent !== input.expectedDiskContent
							? "disk-content-changed"
							: currentOpenViews.length > 0
								? "file-opened-during-decision"
								: isNowBound
									? "file-bound-during-decision"
									: currentYText !== input.expectedYText
										? "crdt-text-replaced"
										: currentCrdtContent !== input.expectedCrdtContent
											? "crdt-content-changed"
											: preservedUnresolvedMismatch
												? "preserved-unresolved"
												: null;
		if (reason === null) {
			// Invoke the mutation before this async function resolves. Returning a
			// boolean and mutating after `await` leaves a microtask seam where a
			// provider update can advance the exact Y.Text (or replace it with an
			// equal-value instance) and then be overwritten by the stale decision.
			return { kind: "committed", value: input.commit() };
		}

		this.deps.trace("reconcile", "closed-file-mutation-ticket-stale", {
			path: input.path,
			stage: input.stage,
			reason,
			expectedDiskLength: input.expectedDiskContent.length,
			currentDiskLength: currentDiskContent?.length ?? null,
			expectedDiskRevision: input.expectedDiskRevision,
			currentDiskRevision,
			expectedDiskMtime: expectedStat?.mtime ?? null,
			currentDiskMtime: typeof input.file?.stat?.mtime === "number"
				? input.file.stat.mtime
				: null,
			expectedCrdtLength: input.expectedCrdtContent?.length ?? null,
			currentCrdtLength: currentCrdtContent?.length ?? null,
			openViewCount: currentOpenViews.length,
			isBound: isNowBound,
		});
		return { kind: "stale" };
	}

	/**
	 * Record a discarded markdown revision without creating a conflict
	 * artifact file. With preservation abolished, the losing revision is
	 * reported through the local trace and the durable server audit sink;
	 * recovery is left to the CRDT journal/snapshots, the disk-index
	 * baseline, and git. `contentHash` may be supplied when the caller
	 * already computed it (avoids a redundant sha256).
	 */
	private async recordDiscardedRevision(
		path: string,
		content: string,
		reason: string,
		contentHash?: string,
	): Promise<void> {
		let resolvedHash = contentHash ?? null;
		if (resolvedHash === null) {
			try {
				resolvedHash = await contentBaselineHash(content);
			} catch {
				resolvedHash = null;
			}
		}
		this.deps.trace("conflict", "revision-discarded", {
			path,
			reason,
			contentLength: content.length,
			contentHash: resolvedHash?.slice(0, 16) ?? null,
			contentFingerprint: contentFingerprint(content),
		});
		this.deps.recordDiscardedRevision?.(
			path,
			resolvedHash ?? contentFingerprint(content),
			reason,
		);
	}

	/**
	 * Record that a stale closed-file decision superseded a disk snapshot.
	 * The stale CAS means the decision is retried with a fresh read, so the
	 * bytes are still on disk; the trace/audit record keeps the event
	 * observable without an artifact file.
	 */
	private async preserveStaleClosedFileDiskSnapshot(
		path: string,
		diskContent: string,
		stage: string,
	): Promise<void> {
		await this.recordDiscardedRevision(
			path,
			diskContent,
			`stale-${stage}`,
		);
		this.deps.trace("conflict", "closed-file-stale-decision-recorded", {
			path,
			stage,
			diskLength: diskContent.length,
		});
	}

	private async applyNoEventStructuralPrepass(input: {
		vaultSync: VaultSync;
		diskFiles: Map<string, string>;
		diskPresentPaths: Set<string>;
		previousDiskIndex: Readonly<DiskIndex>;
	}): Promise<{
		blockedOldPaths: Set<string>;
		blockedNewPaths: Set<string>;
		renamedCount: number;
		unresolvedCount: number;
	}> {
		const { vaultSync, diskFiles, diskPresentPaths, previousDiskIndex } = input;
		const activePaths = vaultSync.getActiveMarkdownPaths()
			.filter((path) => this.deps.isMarkdownPathSyncable(path));
		const missingCrdtPaths = activePaths.filter((path) => !diskPresentPaths.has(path));
		const extraDiskPaths = [...diskPresentPaths].filter((path) =>
			!vaultSync.getTextForPath(path) && !vaultSync.isMarkdownTombstoned(path)
		);

		if (missingCrdtPaths.length === 0 || extraDiskPaths.length === 0) {
			this.unresolvedStructuralChanges = [];
			return {
				blockedOldPaths: new Set(),
				blockedNewPaths: new Set(),
				renamedCount: 0,
				unresolvedCount: 0,
			};
		}

		const missingWithHashes: Array<{ path: string; contentHash: string }> = [];
		for (const path of missingCrdtPaths) {
			const ytext = vaultSync.getTextForPath(path);
			if (!ytext) continue;
			const content = yTextToString(ytext) ?? "";
			missingWithHashes.push({
				path,
				contentHash: await contentBaselineHash(content),
			});
		}

		const extraWithHashes: Array<{ path: string; contentHash: string }> = [];
		for (const path of extraDiskPaths) {
			const content = diskFiles.get(path);
			if (content === undefined) continue;
			extraWithHashes.push({
				path,
				contentHash: await contentBaselineHash(content),
			});
		}

		const getPendingRenameOldPathForTarget =
			(vaultSync as { getPendingRenameOldPathForTarget?: (path: string) => string | undefined })
				.getPendingRenameOldPathForTarget;
		const structuralPlan = planNoEventStructuralRenames({
			missingCrdtPaths: missingWithHashes,
			extraDiskPaths: extraWithHashes,
			mode: "authoritative",
			previousDiskIndex,
			renameEvidence: extraDiskPaths.flatMap((newPath) => {
				const oldPath = getPendingRenameOldPathForTarget?.call(vaultSync, newPath);
				if (!oldPath || !missingCrdtPaths.includes(oldPath)) return [];
				return [{ oldPath, newPath, reason: "pending-rename" as const }];
			}),
		});

		// Even a one-to-one equal hash proves only content continuity, not file
		// identity.  The old YAOS boundary did not infer identity moves from a
		// later scan, and doing so after async hashing can steal a newly created
		// target path.  Convert every inferred rename into observation-only
		// unresolved state; explicit live rename events still use the normal
		// rename pipeline.
		const observedUnresolved: UnresolvedStructuralChange[] = [
			...structuralPlan.unresolved,
			...structuralPlan.renames.map((rename) => ({
				oldPaths: [rename.oldPath],
				newPaths: [rename.newPath],
				contentHash: rename.contentHash,
				reason: "ambiguous-structural-rename" as const,
			})),
		];

		this.unresolvedStructuralChanges = observedUnresolved;
		const diskMirror = this.deps.getDiskMirror();
		for (const change of observedUnresolved) {
			// This is a durable quarantine, not merely a one-pass exclusion. Without
			// it updateIndex intentionally drops the old baseline and a later provider
			// transaction can recreate oldPath while the independently moved newPath
			// still holds the user's bytes.
			for (const affectedPath of [...change.oldPaths, ...change.newPaths]) {
				diskMirror?.recordPreservedUnresolved?.(affectedPath, "path-collision");
			}
			const path = change.newPaths[0] ?? change.oldPaths[0] ?? "(unknown)";
			this.deps.recordFlightPathEvent?.({
				priority: "critical",
				kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
				severity: "warn",
				scope: "file",
				source: "reconciliationController",
				layer: "reconcile",
				path,
				data: {
					decision: "unresolved-ambiguous-structural-change",
					reason: change.reason,
					oldPaths: change.oldPaths,
					newPaths: change.newPaths,
					conflictRisk: "high",
					identityAmbiguous: true,
					contentHash: change.contentHash,
					bindingStatus:
						change.reason === "ambiguous-structural-rename"
							? "ambiguous-structural-rename"
							: "unknown",
					renameEvidence: "none",
				},
			});
			this.deps.trace("reconcile", "reconcile-structural-change-unresolved", {
				reason: change.reason,
				oldPaths: change.oldPaths,
				newPaths: change.newPaths,
				contentHashPrefix: change.contentHash.slice(0, 12),
			});
		}

		return {
			blockedOldPaths: new Set(observedUnresolved.flatMap((change) => change.oldPaths)),
			blockedNewPaths: new Set(observedUnresolved.flatMap((change) => change.newPaths)),
			renamedCount: 0,
			unresolvedCount: observedUnresolved.reduce(
				(total, change) => total + change.oldPaths.length + change.newPaths.length,
				0,
			),
		};
	}

	async runReconciliation(mode: ReconcileMode): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync || !diskMirror) return;
		if (this.reconcileInFlight) {
			this.reconcilePending = true;
			this.deps.log("Reconciliation already in flight — queued");
			return;
		}

		const now = Date.now();
		const elapsed = now - this.lastReconcileTime;
		if (this.lastReconcileTime > 0 && elapsed < RECONCILE_COOLDOWN_MS) {
			const delay = RECONCILE_COOLDOWN_MS - elapsed;
			this.deps.log(`Reconcile cooldown: ${delay}ms remaining, scheduling delayed run`);
			this.reconcilePending = true;
			if (!this.reconcileCooldownTimer) {
				this.reconcileCooldownTimer = setTimeout(() => {
					this.reconcileCooldownTimer = null;
					if (this.reconcilePending) {
						this.reconcilePending = false;
						const nextMode = this.getSafeReconcileMode(mode);
						void this.runReconciliation(nextMode);
					}
				}, delay);
				(this.reconcileCooldownTimer as unknown as { unref?: () => void }).unref?.();
			}
			return;
		}

		this.reconcileInFlight = true;

		try {
			this.deps.recordFlightEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.reconcileStart,
				severity: "info",
				scope: "vault",
				source: "reconciliationController",
				layer: "reconcile",
				data: {
					mode,
					crdtPathCount: vaultSync.getActiveMarkdownPaths().length,
					connected: vaultSync.connected,
					providerSynced: vaultSync.providerSynced,
				},
			});
			const runtimeConfig = this.deps.getRuntimeConfig();
			const baselineRevisionsAtStart = new Map(this.diskBaselineRevisions);
			// Only clean remote references after full provider sync. A stale local
			// cache must never make a deletion decision. This is intentionally
			// limited to intrinsic system/generated paths; user exclude patterns
			// continue to mean "do not sync", not "delete remotely".
			if (
				mode === "authoritative" &&
				vaultSync.providerSynced &&
				this.deps.shouldTombstoneIntrinsicMarkdownPath &&
				this.deps.shouldTombstoneIntrinsicBlobPath
			) {
				const cleanup = vaultSync.tombstoneIntrinsicExcludedEntries(
					(path) => this.deps.shouldTombstoneIntrinsicMarkdownPath!(path),
					(path) => this.deps.shouldTombstoneIntrinsicBlobPath!(path),
					this.deps.getSettings().deviceName,
				);
				if (cleanup.markdownPaths.length > 0 || cleanup.blobPaths.length > 0) {
					this.deps.log(
						`reconcile: tombstoned ${cleanup.markdownPaths.length} intrinsic markdown and ` +
						`${cleanup.blobPaths.length} intrinsic blob paths from remote sync`,
					);
				}
			}
			const diskFiles = new Map<string, string>();
			const diskSnapshotRevisions = new Map<string, number>();
			const diskPresentPaths = new Set<string>();
			const vault = this.deps.app.vault;
			const allDocumentFiles = (
				typeof vault.getFiles === "function"
					? vault.getFiles()
					: vault.getMarkdownFiles()
			).filter((file) => isCrdtDocumentPath(file.path));
			let excludedCount = 0;
			let oversizedCount = 0;
			let skippedByIndex = 0;

			const eligibleFiles: TFile[] = [];
			for (const file of allDocumentFiles) {
				if (!this.deps.isMarkdownPathSyncable(file.path)) {
					excludedCount++;
					continue;
				}
				eligibleFiles.push(file);
				diskPresentPaths.add(file.path);
			}
			const eligibleFileByPath = new Map(eligibleFiles.map((file) => [file.path, file]));

			let changed: TFile[] = [];
			let unchanged: TFile[] = [];
			let allStats: Map<string, { mtime: number; size: number }> = new Map();
			const dropMissingAfterScan = (path: string) => {
				diskFiles.delete(path);
				diskSnapshotRevisions.delete(path);
				diskPresentPaths.delete(path);
				allStats.delete(path);
			};
			if (mode === "authoritative") {
				changed = eligibleFiles;
				allStats = await collectFileStats(this.deps.app, eligibleFiles);
				skippedByIndex = 0;
			} else {
				const indexResult = await filterChangedFiles(
					this.deps.app,
					eligibleFiles,
					this.deps.getDiskIndex(),
				);
				changed = indexResult.changed;
				unchanged = indexResult.unchanged;
				allStats = indexResult.allStats;
				skippedByIndex = unchanged.length;
			}

			for (const file of unchanged) {
				const existingText = vaultSync.getTextForPath(file.path);
				if (existingText) {
					continue;
				}
				try {
					const content = await this.readFreshMarkdownFile(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						continue;
					}
					diskFiles.set(file.path, content);
					diskSnapshotRevisions.set(file.path, this.getMarkdownDiskRevision(file.path));
				} catch (err) {
					if (isMissingFileReadError(err)) {
						dropMissingAfterScan(file.path);
						continue;
					}
					console.error(`[kaos] Failed to read "${file.path}":`, err);
				}
			}

			for (const file of changed) {
				try {
					const content = await this.readFreshMarkdownFile(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						this.deps.log(`reconcile: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
						continue;
					}
					diskFiles.set(file.path, content);
					diskSnapshotRevisions.set(file.path, this.getMarkdownDiskRevision(file.path));
				} catch (err) {
					if (isMissingFileReadError(err)) {
						dropMissingAfterScan(file.path);
						continue;
					}
					console.error(`[kaos] Failed to read "${file.path}" during reconciliation:`, err);
				}
			}

			if (excludedCount > 0) {
				this.deps.log(`reconcile: excluded ${excludedCount} files by pattern`);
			}
			if (oversizedCount > 0) {
				this.deps.log(`reconcile: skipped ${oversizedCount} oversized files`);
				new Notice(`KAOS: skipped ${oversizedCount} files exceeding ${runtimeConfig.maxFileSizeKB} KB size limit.`);
			}
			if (skippedByIndex > 0) {
				this.deps.log(`reconcile: ${skippedByIndex} files unchanged (stat match), ${changed.length} changed`);
			}

			this.deps.log(
				`Reconciling [${mode}]: diskPresent=${diskPresentPaths.size}, ` +
				`diskLoaded=${diskFiles.size} (${changed.length} read) vs ` +
				`${vaultSync.getActiveMarkdownPaths().length} CRDT paths`,
			);
			this.deps.trace("reconcile", "reconcile-scan-complete", {
				mode,
				diskPresentCount: diskPresentPaths.size,
				diskLoadedCount: diskFiles.size,
				changedCount: changed.length,
				unchangedCount: unchanged.length,
				skippedByIndex,
				excludedCount,
				oversizedCount,
				crdtPathCount: vaultSync.getActiveMarkdownPaths().length,
			});

			// An intercepted open-file revision may be older than the stable bytes
			// observed by this full scan. Preserve that exact revision before the
			// snapshot enters VaultSync's synchronous classification lanes.
			for (const [path, content] of Array.from(diskFiles.entries())) {
				const hasCandidateState =
					this.interceptedExternalDiskMutations.has(path) ||
					this.pendingSupersededExternalDiskMutations.has(path);
				const openViews = this.getOpenMarkdownViewsForPath(path);
				if (!hasCandidateState || openViews.length === 0) {
					continue;
				}
				const file = eligibleFileByPath.get(path) ?? null;
				const recoverableCandidate = file
					? await this.findRecoverableExternalAppendOverRecentSelfWrite({
						file,
						physicalDiskContent: content,
						existingText: vaultSync.getTextForPath(path),
						openViews,
					})
					: null;
				if (recoverableCandidate) {
					// A full reconcile must not preserve the exact append as
					// "superseded" while the already-queued path-scoped ingest is
					// waiting for its editor-idle fence. Exclude only this path from
					// the current synchronous snapshot; the dirty lane revalidates all
					// authority and physical CAS proofs before applying anything.
					diskFiles.delete(path);
					diskSnapshotRevisions.delete(path);
					this.queueDirtyMarkdownPath(path, "modify");
					this.traceRecoverableExternalAppend(
						"open-external-append-recovery-deferred-to-dirty-ingest",
						recoverableCandidate,
						content,
						openViews.length,
					);
					continue;
				}
				const candidateAdmission = await this.admitStableExternalDiskMutation(path, content);
				if (candidateAdmission.kind === "preserved") continue;

				diskFiles.delete(path);
				diskSnapshotRevisions.delete(path);
				this.requestReconciliationFollowup(path, "external-candidate-admission-invalidated");
				this.deps.trace("reconcile", "external-candidate-admission-deferred", {
					path,
					stage: "full-reconcile-open-file",
					reason: "external-candidate-admission-invalidated",
				});
			}

			// No-event rename inference is observation-only. It may conservatively
			// block an old/new pair for this pass, but it never mutates CRDT identity.
			// Explicit vault/provider rename events retain their normal path.
			const structuralPrepass = mode === "authoritative"
				? await this.applyNoEventStructuralPrepass({
					vaultSync,
					diskFiles,
					diskPresentPaths,
					previousDiskIndex: this.deps.getDiskIndex(),
				})
				: {
					blockedOldPaths: new Set<string>(),
					blockedNewPaths: new Set<string>(),
					renamedCount: 0,
					unresolvedCount: 0,
				};
			const reconcileDiskPresentPaths = new Set(diskPresentPaths);
			for (const path of structuralPrepass.blockedOldPaths) {
				reconcileDiskPresentPaths.add(path);
			}
			for (const path of structuralPrepass.blockedNewPaths) {
				reconcileDiskPresentPaths.delete(path);
			}
			if (structuralPrepass.renamedCount > 0 || structuralPrepass.unresolvedCount > 0) {
				this.deps.trace("reconcile", "reconcile-structural-prepass-complete", {
					mode,
					renamedCount: structuralPrepass.renamedCount,
					unresolvedCount: structuralPrepass.unresolvedCount,
				});
			}

			// Disk-only paths are mutated inside VaultSync.reconcileVault
			// synchronously. Refresh them after every async prepass, then pair the
			// snapshot with a vault-event revision checked immediately before
			// ensureFile. This prevents an early scan value from being seeded after
			// a startup save/delete that occurred while reconciliation was waiting.
			for (const [path] of diskFiles) {
				if (vaultSync.getTextForPath(path)) continue;
				const file = eligibleFileByPath.get(path) ?? null;
				if (!file) continue;
				try {
					const revisionBeforeRead = this.getMarkdownDiskRevision(path);
					if (
						file.path !== path ||
						this.deps.app.vault.getAbstractFileByPath(path) !== file
					) {
						diskFiles.delete(path);
						this.requestReconciliationFollowup(path, "disk-only-seed-file-identity-changed");
						continue;
					}
					const refreshedContent = await this.readFreshMarkdownFile(file);
					if (
						this.getMarkdownDiskRevision(path) !== revisionBeforeRead ||
						file.path !== path ||
						this.deps.app.vault.getAbstractFileByPath(path) !== file
					) {
						diskFiles.delete(path);
						this.requestReconciliationFollowup(path, "disk-only-seed-changed-during-refresh");
						continue;
					}
					if (
						runtimeConfig.maxFileSizeBytes > 0 &&
						refreshedContent.length > runtimeConfig.maxFileSizeBytes
					) {
						diskFiles.delete(path);
						continue;
					}
					diskFiles.set(path, refreshedContent);
					diskSnapshotRevisions.set(path, this.getMarkdownDiskRevision(path));
				} catch (err) {
					if (isMissingFileReadError(err)) {
						dropMissingAfterScan(path);
					}
				}
			}

			// A disk-only document is about to cross the only reconciliation path
			// that can create a brand-new Y.Text without first passing through the
			// normal vault-event ingest pipeline.  Apply the same path-aware
			// document guard here, after the final disk refresh and immediately
			// before reconcileVault's synchronous seed loop.  In particular, a
			// partially-written or malformed `.base` file must remain local instead
			// of becoming the shared CRDT authority.
			for (const [path, content] of diskFiles) {
				if (
					vaultSync.getTextForPath(path) ||
					vaultSync.isMarkdownTombstoned(path)
				) {
					continue;
				}
				if (!this.deps.shouldBlockFrontmatterIngest(
					path,
					null,
					content,
					"reconcile-disk-to-crdt-seed",
				)) {
					continue;
				}

				diskFiles.delete(path);
				diskSnapshotRevisions.delete(path);
				this.recordFrontmatterIngestBlocked(path, false, "disk-to-crdt-seed");
				this.deps.trace("reconcile", "document-admission-blocked", {
					path,
					stage: "reconcile-disk-to-crdt-seed",
				});
				this.deps.log(
					`reconcile: document guard kept unsafe disk-only file local: "${path}"`,
				);
				this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
			}

			const result = vaultSync.reconcileVault(
				diskFiles,
				reconcileDiskPresentPaths,
				mode,
				this.deps.getSettings().deviceName,
				/**
				 * Architectural decision: Option (b) — opId-factory callback.
				 * For every authoritative-lane `seed-to-crdt` decision, mint a
				 * shared `opId` and fire `reconcile.file.decision` BEFORE the
				 * CRDT mutation. `vaultSync.reconcileVault` then threads the
				 * same opId into `ensureFile`, so the resulting
				 * `crdt.file.created` envelope carries it. The post-loop
				 * `seededToCrdt` iterator below performs only the
				 * `settledHashes` baseline bookkeeping for these paths — the
				 * decision emission has already happened here.
				 */
				(path) => {
					const opId = `op-reconcile-seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
					return {
						opId,
						emitDecision: () => {
							this.deps.recordFlightPathEvent?.({
								priority: "important",
								kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
								severity: "info",
								scope: "file",
								source: "reconciliationController",
								layer: "reconcile",
								path,
								opId,
								data: {
									decision: "seed-disk-to-crdt",
									reason: "disk-file-not-in-crdt",
									conflictRisk: "none",
								},
							});
						},
					};
				},
				(path) =>
					this.deps.isMarkdownPathSyncable(path) &&
					!this.isMarkdownPreservedUnresolved(path),
				(path, content) => {
					const file = eligibleFileByPath.get(path) ?? null;
					const snapshotCurrent =
						diskFiles.get(path) === content &&
						(diskSnapshotRevisions.get(path) ?? -1) === this.getMarkdownDiskRevision(path) &&
						file !== null &&
						file.path === path &&
						this.deps.app.vault.getAbstractFileByPath(path) === file &&
						vaultSync.getTextForPath(path) === null &&
						this.getOpenMarkdownViewsForPath(path).length === 0;
					if (!snapshotCurrent) {
						this.requestReconciliationFollowup(path, "disk-only-seed-snapshot-stale");
					}
					return snapshotCurrent;
				},
				(path) => this.deps.isRemoteProjectionAllowed?.(path) ?? true,
			);

			let flushedCreates = 0;
			let flushedUpdates = 0;
			let safetyBrakeTriggered = false;
			let safetyBrakeReason: string | null = null;
			const interceptedCandidatesToClearAfterIndexSave =
				new Set<InterceptedExternalDiskMutation>();

			// Evaluate safety brake using pure policy function.
			const safetyBrakeDecision = evaluateSafetyBrake({
				destructiveCount: result.updatedOnDisk.length,
				localFileCount: diskPresentPaths.size,
			});
			if (safetyBrakeDecision.triggered) {
				safetyBrakeTriggered = true;
				safetyBrakeReason = safetyBrakeDecision.reason;
				this.deps.log(`Reconcile safety brake: ${safetyBrakeReason}.`);
				console.error(`[kaos] Reconcile safety brake: ${safetyBrakeReason}.`);
				new Notice(
					`KAOS: Reconcile safety brake — ${safetyBrakeReason}. ` +
					`Additive creates will continue. Export diagnostics and inspect logs.`,
				);
				this.deps.trace("reconcile", "reconcile-safety-brake-blocked", {
					mode,
					destructiveCount: result.updatedOnDisk.length,
					destructiveRatio: safetyBrakeDecision.destructiveRatio,
					localFileCount: diskPresentPaths.size,
					reason: safetyBrakeReason,
					...tracePathList("affected", result.updatedOnDisk),
				});
			}

			// Emit reconcile.file.decision for tombstoned and untracked paths
			// (diagnostic only — no side effects, safe outside safetyBrake guard).
			for (const conflict of result.tombstonedDiskConflicts ?? []) {
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "reconcile",
					path: conflict.path,
					data: {
						decision: "skip-tombstoned",
						reason: conflict.reason,
						action: conflict.action,
						conflictRisk: "tombstone-disk-conflict",
					},
				});
			}
			for (const path of result.pathBindingConflicts ?? []) {
				const getActiveFileIdsForPath =
					(vaultSync as { getActiveFileIdsForPath?: (path: string) => string[] })
						.getActiveFileIdsForPath;
				this.deps.recordFlightPathEvent?.({
					priority: "critical",
					kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
					severity: "warn",
					scope: "file",
					source: "reconciliationController",
					layer: "reconcile",
					path,
					data: {
						decision: "block-path-binding-conflict",
						reason: "duplicate-active-path",
						conflictRisk: "high",
						bindingStatus: "duplicate-active-path",
						activeFileIdsForPath: getActiveFileIdsForPath?.call(vaultSync, path) ?? [],
					},
				});
			}
			for (const path of result.untracked) {
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "reconcile",
					path,
					data: {
						decision: "skip-untracked",
						reason: "conservative-mode-no-auto-seed",
						conflictRisk: "none",
					},
				});
			}
			if (!safetyBrakeTriggered) {
				// Content hashes for files settled cleanly this reconcile.
				// Stored in the disk index as the three-way baseline for the
				// next startup reconcile (after plugin disable/re-enable).
				const settledHashes = new Map<string, string>();
				const settledBaselineTexts = new Map<string, string>();
				const recordSettledBaseline = (path: string, hash: string, text: string) => {
					settledHashes.set(path, hash);
					settledBaselineTexts.set(hash, text);
					this.clearDeferredVisibleAuthorityIfSettled(path, text);
				};

				// Track paths that need CRDT→disk flush, along with the semantic reason.
				// This preserves the action kind so planBaselineAdvancement gets the
				// correct input, not a flattened "defer-to-crdt-flush" for everything.
				const updatesToFlush: Array<{
					path: string;
					baselineActionKind: BaselineActionKind;
					expectedDiskContent: string;
					remoteProjectionAdmission: RemoteProjectionAdmissionLease;
				}> = [];
				const deferredOpenEditorIndexPaths = new Set<string>();
				const staleClosedDecisionIndexPaths = new Set<string>();
				const projectionBlockedMissingDiskIndexPaths = new Set<string>();
				const actionPaths = new Set<string>([
					...result.createdOnDisk,
					...result.seededToCrdt,
					...result.updatedOnDisk,
				]);
				for (const path of result.createdOnDisk) {
					// VaultSync filters these already, but keep the controller boundary
					// closed as well: stale CRDT entries for excluded paths must never
					// reach DiskMirror, even if a future reconcile implementation changes.
					if (!this.deps.isMarkdownPathSyncable(path)) {
						continue;
					}
					if (!(this.deps.isRemoteProjectionAllowed?.(path) ?? true)) {
						projectionBlockedMissingDiskIndexPaths.add(path);
						continue;
					}
					const remoteProjectionAdmission =
						this.captureRemoteProjectionAdmission(diskMirror, [path]);
					if (!remoteProjectionAdmission) {
						projectionBlockedMissingDiskIndexPaths.add(path);
						continue;
					}
					this.deps.recordFlightPathEvent?.({
						priority: "important",
						kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "reconcile",
						path,
						data: {
							decision: "write-crdt-to-disk",
							reason: "crdt-file-missing-on-disk",
							conflictRisk: "none",
						},
					});
					const writeResult = await diskMirror.flushWrite(path, false, {
						requireRemoteProjectionAdmission: true,
						remoteProjectionAdmission,
					});
					if (!this.isDiskWriteSettled(writeResult)) {
						projectionBlockedMissingDiskIndexPaths.add(path);
						this.traceDiskWriteNotSettled(path, writeResult, "crdt-file-missing-on-disk");
						this.requestFollowupForUnsettledDiskWrite(
							path,
							writeResult,
							"crdt-file-missing-on-disk",
						);
						continue;
					}
					if (writeResult.kind === "written") {
						flushedCreates++;
					}
					// DiskMirror returns the exact snapshot that reached disk. Y.Text may
					// already have advanced again while its result/hash was being prepared.
					recordSettledBaseline(path, writeResult.contentHash, writeResult.content);
				}
				for (const path of result.seededToCrdt) {
					// Spec R2 / Option (b): the `reconcile.file.decision`
					// emission for seeded paths is now produced by the
					// admission-opId factory passed into `reconcileVault`
					// above (BEFORE the `ensureFile` call) so the decision
					// envelope shares an `opId` with the resulting
					// `crdt.file.created`. This loop handles only the
					// settled-baseline bookkeeping.
					// Record settled baseline hash: disk content was the authority
					const diskContent = diskFiles.get(path);
					if (diskContent !== undefined) {
						const diskHash = await contentBaselineHash(diskContent);
						const baselineAction = planBaselineAdvancement({
							actionKind: "disk-seeded-to-crdt",
							diskHash,
							crdtHash: null,
							previousBaselineHash: null,
						});
						if (baselineAction.kind === "advance") {
							recordSettledBaseline(path, baselineAction.hash, diskContent);
						}
					}
				}
				for (const [path, diskContent] of diskFiles) {
					if (this.isMarkdownPreservedUnresolved(path)) {
						if (await this.tryHealFencedConflictWinnerFlush(path, diskContent)) {
							continue;
						}
						deferredOpenEditorIndexPaths.add(path);
						this.deps.trace("reconcile", "reconcile-skipped-preserved-unresolved", {
							path,
							stage: "equal-baseline-observation",
						});
						continue;
					}
					if (actionPaths.has(path)) {
						continue;
					}
					const ytext = vaultSync.getTextForPath(path);
					if (!ytext) {
						continue;
					}
					const crdtContent = yTextToString(ytext) ?? "";
					if (crdtContent !== diskContent) {
						continue;
					}
					const visibleDecision = this.decideDeferredVisibleAuthority(
						path,
						diskContent,
						crdtContent,
					);
					if (visibleDecision.kind === "unresolved") {
						await this.preserveUnresolvedVisibleAuthority(
							path,
							visibleDecision.marker,
							diskContent,
							crdtContent,
							"closed-equal-non-editor",
						);
						deferredOpenEditorIndexPaths.add(path);
						this.requestReconciliationFollowup(
							path,
							"visible-authority-not-present-after-close",
						);
						continue;
					}
					const contentHash = await contentBaselineHash(diskContent);
					const baselineAction = planBaselineAdvancement({
						actionKind: "no-op",
						diskHash: contentHash,
						crdtHash: contentHash,
						previousBaselineHash: this.deps.getDiskIndex()[path]?.contentHash ?? null,
					});
					if (baselineAction.kind === "advance") {
						recordSettledBaseline(path, baselineAction.hash, diskContent);
					}
				}
				for (const path of result.updatedOnDisk) {
					if (this.isMarkdownPreservedUnresolved(path)) {
						const healDiskContent = diskFiles.get(path);
						if (
							healDiskContent !== undefined &&
							await this.tryHealFencedConflictWinnerFlush(path, healDiskContent)
						) {
							continue;
						}
						deferredOpenEditorIndexPaths.add(path);
						this.deps.trace("reconcile", "reconcile-skipped-preserved-unresolved", {
							path,
							stage: "updated-on-disk",
						});
						continue;
					}
					const diskContent = diskFiles.get(path);
					const ytext = vaultSync.getTextForPath(path);
					const openViews = this.getOpenMarkdownViewsForPath(path);
					const isOpenOrBound =
						(this.deps.getEditorBindings()?.isBound(path) ?? false) ||
						openViews.length > 0;
					if (
						mode === "authoritative" &&
						isOpenOrBound &&
						diskContent !== undefined &&
						ytext &&
						openViews.length > 0
					) {
						const crdtContent = yTextToString(ytext) ?? "";
						const openFile = eligibleFileByPath.get(path) ?? null;
						if (!openFile) {
							deferredOpenEditorIndexPaths.add(path);
							this.requestReconciliationFollowup(path, "open-file-missing-before-replan");
							continue;
						}
						let latestOpenDiskContent: string;
						try {
							latestOpenDiskContent = await this.readFreshMarkdownFile(openFile);
						} catch {
							deferredOpenEditorIndexPaths.add(path);
							this.requestReconciliationFollowup(path, "open-file-reread-failed");
							continue;
						}
						if (latestOpenDiskContent !== diskContent) {
							deferredOpenEditorIndexPaths.add(path);
							this.requestReconciliationFollowup(path, "open-file-disk-advanced-after-scan");
							continue;
						}
						const interceptedCandidate = this.getMatchingInterceptedExternalDiskMutation(
							path,
							diskContent,
						);
						const editorSettleDefer =
							await this.getOpenEditorReconcileSettleDefer({
								path,
								diskContent,
								crdtContent,
								openViews,
							});
						if (editorSettleDefer !== null) {
							this.deferOpenFileReconcileForEditorSettle({
								path,
								diskContent,
								crdtContent,
								openViews,
								...editorSettleDefer,
							});
							if (!editorSettleDefer.retainSettledDiskIndex) {
								deferredOpenEditorIndexPaths.add(path);
							}
							continue;
						}

						const handledOpenDivergence = await this.handleOpenFileReconcileDivergence(
							path,
							diskContent,
							ytext,
							openViews,
							eligibleFileByPath.get(path) ?? null,
						);
						const currentOpenYText = vaultSync.getTextForPath(path);
						const openSettlement = currentOpenYText
							? this.captureBoundFileSettlement(
								path,
								diskContent,
								currentOpenYText,
								openViews,
							)
							: undefined;
						if (openSettlement !== undefined) {
							const baselineSettled = await this.updateDiskIndexForPath(
								path,
								openSettlement.content,
								allStats.get(path) ?? null,
								{
									expectedDiskFile: openFile,
									expectedYText: openSettlement.expectedYText,
									expectedCrdtContent: openSettlement.expectedCrdtContent,
									expectedEditorTicket: openSettlement.expectedEditorTicket,
									expectedOpenEditorContent: openSettlement.expectedOpenEditorContent,
								},
							);
							if (!baselineSettled) {
								deferredOpenEditorIndexPaths.add(path);
								this.requestReconciliationFollowup(
									path,
									"open-file-reconcile-settlement-stale",
								);
								continue;
							}
							if (interceptedCandidate) {
								const contentHashPrefix =
									this.deps.getDiskIndex()[path]?.contentHash?.slice(0, 12) ?? null;
								this.traceOpenExternalEvent("open-external-disk-settled", {
									path,
									reason: "already-settled",
									contentLength: openSettlement.content.length,
									contentHashPrefix,
								});
								this.traceOpenExternalEvent("open-external-baseline-advanced", {
									path,
									reason: "already-settled",
									contentLength: openSettlement.content.length,
									contentHashPrefix,
								});
							}
							this.resolveConvergedVisibleAuthority(path);
							if (interceptedCandidate) {
								interceptedCandidatesToClearAfterIndexSave.add(interceptedCandidate);
							}
							continue;
						}
						// Re-plan unresolved open state through the open-bound authority
						// planner directly. A generic dirty import would discard the captured
						// B/L/D authority relationship and could apply stale disk content.
						const liveFile = openFile;
						const currentYText = vaultSync.getTextForPath(path);
						if (!liveFile || !currentYText) {
							deferredOpenEditorIndexPaths.add(path);
							this.requestReconciliationFollowup(path, "open-file-reconcile-state-transition");
							continue;
						}
						const openReplan = await this.handleBoundFileSyncGap(
							liveFile,
							diskContent,
							currentYText,
							this.getOpenMarkdownViewsForPath(path),
							"modify",
							allStats.get(path) ?? null,
							() =>
								(diskSnapshotRevisions.get(path) ?? -1) !==
								this.getMarkdownDiskRevision(path),
						);
						if (openReplan.kind === "handled") {
							if (openReplan.settlement !== undefined) {
								const baselineSettled = await this.updateDiskIndexForPath(
									path,
									openReplan.settlement.content,
									allStats.get(path) ?? null,
									{
										expectedDiskFile: liveFile,
										expectedYText: openReplan.settlement.expectedYText,
										expectedCrdtContent: openReplan.settlement.expectedCrdtContent,
										expectedEditorTicket: openReplan.settlement.expectedEditorTicket,
										expectedOpenEditorContent: openReplan.settlement.expectedOpenEditorContent,
									},
								);
								if (!baselineSettled) {
									deferredOpenEditorIndexPaths.add(path);
									this.requestReconciliationFollowup(
										path,
										"open-bound-replan-settlement-stale",
									);
									continue;
								}
								if (interceptedCandidate) {
									const contentHashPrefix =
										this.deps.getDiskIndex()[path]?.contentHash?.slice(0, 12) ?? null;
									this.traceOpenExternalEvent("open-external-disk-settled", {
										path,
										reason: "already-settled",
										contentLength: openReplan.settlement.content.length,
										contentHashPrefix,
									});
									this.traceOpenExternalEvent("open-external-baseline-advanced", {
										path,
										reason: "already-settled",
										contentLength: openReplan.settlement.content.length,
										contentHashPrefix,
									});
								}
								if (interceptedCandidate) {
									interceptedCandidatesToClearAfterIndexSave.add(interceptedCandidate);
								}
							} else {
								deferredOpenEditorIndexPaths.add(path);
								this.requestReconciliationFollowup(
									path,
									handledOpenDivergence
										? "open-file-reconcile-convergence-unsettled"
										: "open-bound-replan-unsettled",
								);
							}
							continue;
						}
						if (openReplan.kind === "deferred") {
							deferredOpenEditorIndexPaths.add(path);
							this.requestReconciliationFollowup(path, `open-bound-replan:${openReplan.reason}`);
							continue;
						}
						if (openReplan.kind === "flush-crdt-to-disk") {
							const openExternalTraceReason =
								this.getOpenExternalSettlementTraceReason(openReplan.reason);
							const writeResult = await this.flushWithOpenAuthorityLease(
								diskMirror,
								path,
								diskContent,
								openReplan.authorityLease,
							);
							if (this.isDiskWriteSettled(writeResult)) {
								if (writeResult.kind === "written") flushedUpdates++;
								if (openExternalTraceReason !== null) {
									this.traceOpenExternalEvent("open-external-disk-settled", {
										path,
										reason: openExternalTraceReason,
										contentLength: writeResult.content.length,
										contentHashPrefix: writeResult.contentHash.slice(0, 12),
									});
								}
								recordSettledBaseline(path, writeResult.contentHash, writeResult.content);
								if (openExternalTraceReason !== null) {
									this.traceOpenExternalEvent("open-external-baseline-advanced", {
										path,
										reason: openExternalTraceReason,
										contentLength: writeResult.content.length,
										contentHashPrefix: writeResult.contentHash.slice(0, 12),
									});
								}
								if (interceptedCandidate) {
									interceptedCandidatesToClearAfterIndexSave.add(interceptedCandidate);
								}
							} else {
								if (openReplan.reason !== "bound-file-disk-at-baseline") {
									deferredOpenEditorIndexPaths.add(path);
								}
								this.traceDiskWriteNotSettled(path, writeResult, openReplan.reason);
								this.requestFollowupForUnsettledDiskWrite(path, writeResult, openReplan.reason);
								if (openReplan.provisionalBaseline) {
									diskMirror.recordPreservedUnresolved(
										path,
										"conflict-winner-flush-deferred",
									);
								}
							}
							continue;
						}
						deferredOpenEditorIndexPaths.add(path);
						this.requestReconciliationFollowup(path, "open-bound-replan-view-closed");
						continue;
					}
					if (
						mode === "authoritative" &&
						!isOpenOrBound &&
						diskContent !== undefined &&
						ytext
					) {
						const crdtContent = yTextToString(ytext) ?? "";
						// SHA-256 hashes for three-way authority decision.
						const diskHash = await contentBaselineHash(diskContent);
						const crdtHash = await contentBaselineHash(crdtContent);
						const baselineHash = this.deps.getDiskIndex()[path]?.contentHash ?? null;
						const diskMtimeRaw = allStats.get(path)?.mtime;
						const getFileIdForText =
							(vaultSync as { getFileIdForText?: (text: typeof ytext) => string | undefined })
								.getFileIdForText;
						const getFileId =
							(vaultSync as { getFileId?: (path: string) => string | undefined })
								.getFileId;
						const fileId =
							getFileIdForText?.call(vaultSync, ytext) ??
							getFileId?.call(vaultSync, path) ??
							null;
						const bindingInput = {
							path,
							fileId,
							diskHash,
							crdtHash,
							baselineHash,
							renameEvidence: "none",
						} as const;
						const getPathBindingIntegrity =
							(vaultSync as {
								getPathBindingIntegrity?: (input: typeof bindingInput) => ReturnType<typeof evaluatePathBindingIntegrity>;
							}).getPathBindingIntegrity;
						const bindingIntegrity = getPathBindingIntegrity
							? getPathBindingIntegrity.call(vaultSync, bindingInput)
							: evaluatePathBindingIntegrity({
								...bindingInput,
								activeFileIdsForPath: fileId ? [fileId] : [],
							});
						const rawLastSave = this.deps.getLastSaveDiskIndexAt?.();
						const now = Date.now();
						const lastDiskIndexPersistedAt =
							typeof rawLastSave === "number" &&
							Number.isFinite(rawLastSave) &&
							rawLastSave > 0 &&
							rawLastSave <= now
								? rawLastSave
								: undefined;

						// Use pure planner for the decision.
						let action = planClosedFileReconcile({
							path,
							mode,
							isOpenOrBound,
							diskHash,
							crdtHash,
							baselineHash,
							diskMtime: diskMtimeRaw,
							lastDiskIndexPersistedAt,
							hasPendingLocalCreate: this.hasPendingLocalCreate(path),
							pathBindingStatus: bindingIntegrity.status,
							pathBindingReason: bindingIntegrity.reason,
						});
						const visibleDecision = this.decideDeferredVisibleAuthority(
							path,
							diskContent,
							crdtContent,
						);
						if (visibleDecision.kind === "unresolved") {
							await this.preserveUnresolvedVisibleAuthority(
								path,
								visibleDecision.marker,
								diskContent,
								crdtContent,
								"closed-divergence",
							);
							staleClosedDecisionIndexPaths.add(path);
							this.requestReconciliationFollowup(
								path,
								"visible-authority-unmatched-after-close",
							);
							continue;
						}
						if (visibleDecision.kind === "disk-wins") {
							action = {
								kind: "create-conflict-artifact",
								path,
								reason: "visible-authority-deferred-across-close",
								winner: "disk",
								preserveSide: "crdt",
							};
						}
						if (visibleDecision.kind === "crdt-wins") {
							action = {
								kind: "create-conflict-artifact",
								path,
								reason: "visible-authority-deferred-across-close",
								winner: "crdt",
								preserveSide: "disk",
							};
						}

						// Emit flight event for the decision.
						this.deps.recordFlightPathEvent?.({
							priority: action.kind === "create-conflict-artifact" ? "critical" : "important",
							kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
							severity: "info",
							scope: "file",
							source: "reconciliationController",
							layer: "reconcile",
							path,
							data: {
								decision: action.kind,
								reason: action.reason,
								winner: action.kind === "create-conflict-artifact" ? action.winner : null,
								fileId,
								diskLength: diskContent.length,
								crdtLength: crdtContent.length,
								diskHash,
								crdtHash,
								baselineHash,
								bindingStatus: bindingIntegrity.status,
								bindingReason: bindingIntegrity.reason,
								activeFileIdsForPath: bindingIntegrity.activeFileIdsForPath,
								candidatePath: bindingIntegrity.candidatePath,
								renameEvidence: bindingIntegrity.renameEvidence,
								diskChangedSinceBaseline: baselineHash !== null ? diskHash !== baselineHash : null,
								conflictRisk:
									action.kind === "create-conflict-artifact"
										? action.reason === "path-binding-integrity"
											? "high"
											: action.reason === "both-changed"
											? "high"
											: "ambiguous"
										: "none",
								...(action.kind === "create-conflict-artifact" && action.reason === "missing-baseline" && {
									missingBaselinePolicy: action.missingBaselinePolicy ?? null,
									diskMtime: diskMtimeRaw ?? null,
									lastDiskIndexPersistedAt: lastDiskIndexPersistedAt ?? null,
									mtimeEvidence: diskMtimeRaw !== undefined && lastDiskIndexPersistedAt !== undefined,
								}),
							},
						});

						// Execute the planned action.
						if (action.kind === "create-conflict-artifact") {
							if (action.reason === "both-changed" && baselineHash !== null) {
								const baseText = await this.deps.getBaselineText?.(baselineHash) ?? null;
								const mergeResult = mergeTexts3(baseText, diskContent, crdtContent);
								if (mergeResult.kind === "clean-merge") {
									const mergeCommit = await this.commitClosedFileReconcileMutation({
										path,
										file: eligibleFileByPath.get(path) ?? null,
										expectedYText: ytext,
										expectedDiskContent: diskContent,
										expectedCrdtContent: crdtContent,
										expectedDiskRevision: diskSnapshotRevisions.get(path) ?? -1,
										stage: "closed-file-3way-auto-merge",
										commit: () => {
											applyDiffToYTextWithPostcondition(
												ytext,
												crdtContent,
												mergeResult.mergedText,
												ORIGIN_DISK_SYNC_RECOVER_BOUND,
											);
										},
									});
									if (mergeCommit.kind === "stale") {
										staleClosedDecisionIndexPaths.add(path);
										this.requestReconciliationFollowup(
											path,
											"closed-file-3way-auto-merge-stale",
										);
										await this.preserveStaleClosedFileDiskSnapshot(
											path,
											diskContent,
											"closed-file-3way-auto-merge",
										);
										continue;
									}
										const remoteProjectionAdmission =
											this.captureRemoteProjectionAdmission(
												diskMirror,
												[path],
											);
										if (!remoteProjectionAdmission) {
											staleClosedDecisionIndexPaths.add(path);
											this.requestReconciliationFollowup(
												path,
												"closed-file-3way-auto-merge-policy-held",
											);
											continue;
										}
										const writeResult = await diskMirror.flushWrite(path, true, {
											requireRemoteProjectionAdmission: true,
											remoteProjectionAdmission,
											expectedDiskContent: diskContent,
										});
									if (!this.isDiskWriteSettled(writeResult)) {
										staleClosedDecisionIndexPaths.add(path);
										this.traceDiskWriteNotSettled(path, writeResult, "closed-file-3way-auto-merged");
										this.requestFollowupForUnsettledDiskWrite(
											path,
											writeResult,
											"closed-file-3way-auto-merged",
										);
										continue;
									}
									if (writeResult.kind === "written") {
										flushedUpdates++;
									}
									recordSettledBaseline(
										path,
										writeResult.contentHash,
										writeResult.content,
									);
									this.deps.trace("reconcile", "closed-file-3way-auto-merged", {
										path,
										baselineHash,
										diskLength: diskContent.length,
										crdtLength: crdtContent.length,
										mergedLength: mergeResult.mergedText.length,
									});
									continue;
								}
								if (mergeResult.kind === "conflict") {
									this.deps.trace("conflict", "closed-file-manual-merge-required", {
										path,
										baselineHash,
										hunkCount: mergeResult.hunks.length,
										diskLength: diskContent.length,
										crdtLength: crdtContent.length,
									});
								}
							}
							const preservedContent = action.preserveSide === "disk" ? diskContent : crdtContent;
							await this.recordDiscardedRevision(
								path,
								preservedContent,
								`closed-file-${action.reason}`,
								action.preserveSide === "disk" ? diskHash : crdtHash,
							);
							if (action.winner === "disk") {
								const diskWinnerCommit = await this.commitClosedFileReconcileMutation({
									path,
									file: eligibleFileByPath.get(path) ?? null,
									expectedYText: ytext,
									expectedDiskContent: diskContent,
									expectedCrdtContent: crdtContent,
									expectedDiskRevision: diskSnapshotRevisions.get(path) ?? -1,
									stage: "closed-file-conflict-disk-wins",
									commit: () => {
										applyDiffToYTextWithPostcondition(
											ytext,
											crdtContent,
											diskContent,
											ORIGIN_DISK_SYNC_RECOVER_BOUND,
										);
										recordSettledBaseline(path, diskHash, diskContent);
									},
								});
								if (diskWinnerCommit.kind === "stale") {
									staleClosedDecisionIndexPaths.add(path);
									this.requestReconciliationFollowup(
										path,
										"closed-file-conflict-disk-wins-stale",
									);
									await this.preserveStaleClosedFileDiskSnapshot(
										path,
										diskContent,
										"closed-file-conflict-disk-wins",
									);
									continue;
								}
								} else {
									const remoteProjectionAdmission =
										this.captureRemoteProjectionAdmission(
											diskMirror,
											[path],
										);
									if (remoteProjectionAdmission) {
										updatesToFlush.push({
											path,
											baselineActionKind: "conflict-crdt-wins",
											expectedDiskContent: diskContent,
											remoteProjectionAdmission,
										});
									} else {
										staleClosedDecisionIndexPaths.add(path);
										this.requestReconciliationFollowup(
											path,
											"closed-file-conflict-crdt-wins-policy-held",
										);
									}
								}
							this.deps.trace("conflict", "closed-file-conflict-discarded", {
								path,
								reason: action.reason,
								winner: action.winner,
								preservedSide: action.preserveSide,
								diskLength: diskContent.length,
								crdtLength: crdtContent.length,
							});
							if (action.winner === "disk") {
								flushedUpdates++;
							}
							continue;
						}
						if (action.kind === "import-disk-to-crdt") {
							const importCommit = await this.commitClosedFileReconcileMutation({
								path,
								file: eligibleFileByPath.get(path) ?? null,
								expectedYText: ytext,
								expectedDiskContent: diskContent,
								expectedCrdtContent: crdtContent,
								expectedDiskRevision: diskSnapshotRevisions.get(path) ?? -1,
								stage: "closed-file-import-disk",
								commit: () => {
									applyDiffToYTextWithPostcondition(
										ytext,
										crdtContent,
										diskContent,
										ORIGIN_DISK_SYNC_RECOVER_BOUND,
									);
									const baselineAction = planBaselineAdvancement({
										actionKind: "import-disk-to-crdt",
										diskHash,
										crdtHash,
										previousBaselineHash: baselineHash,
									});
									if (baselineAction.kind === "advance") {
										recordSettledBaseline(path, baselineAction.hash, diskContent);
									}
								},
							});
							if (importCommit.kind === "stale") {
								staleClosedDecisionIndexPaths.add(path);
							this.requestReconciliationFollowup(
								path,
								"closed-file-import-disk-stale",
							);
							await this.preserveStaleClosedFileDiskSnapshot(
									path,
									diskContent,
									"closed-file-import-disk",
								);
								continue;
							}
							this.deps.trace("reconcile", "closed-file-disk-wins-clean", {
								path,
								reason: action.reason,
								diskLength: diskContent.length,
								crdtLength: crdtContent.length,
							});
							flushedUpdates++;
							continue;
						}
						// action.kind === "apply-remote-to-disk", "no-op", or "defer-to-crdt-flush":
						// CRDT wins or nothing to do. Fall through to flush.
						// Preserve the semantic action kind for baseline advancement.
						const remoteProjectionAdmission =
							this.captureRemoteProjectionAdmission(
								diskMirror,
								[path],
							);
						if (!remoteProjectionAdmission) {
							staleClosedDecisionIndexPaths.add(path);
							this.requestReconciliationFollowup(
								path,
								"closed-file-projection-policy-held",
							);
							continue;
						}
						updatesToFlush.push({
							path,
							baselineActionKind: action.kind,
							expectedDiskContent: diskContent,
							remoteProjectionAdmission,
						});
					}
				}
				for (const {
					path,
					baselineActionKind,
					expectedDiskContent,
					remoteProjectionAdmission,
				} of updatesToFlush) {
					const provisionalConflictWinner =
						baselineActionKind === "conflict-crdt-wins" ||
						baselineActionKind === "conflict-disk-wins";
					const writeResult = await diskMirror.flushWrite(path, false, {
						requireRemoteProjectionAdmission: true,
						remoteProjectionAdmission,
						recordBaseline: true,
						expectedDiskContent,
					});
					if (!this.isDiskWriteSettled(writeResult)) {
						staleClosedDecisionIndexPaths.add(path);
						this.traceDiskWriteNotSettled(path, writeResult, baselineActionKind);
						this.requestFollowupForUnsettledDiskWrite(
							path,
							writeResult,
							baselineActionKind,
						);
						if (provisionalConflictWinner) {
							diskMirror.recordPreservedUnresolved(
								path,
								"conflict-winner-flush-deferred",
							);
						}
						continue;
					}
					if (writeResult.kind === "written") {
						flushedUpdates++;
					}
					// Never re-read live Y.Text here: it may be C2 while DiskMirror
					// successfully committed C1. The baseline must describe C1.
					recordSettledBaseline(path, writeResult.contentHash, writeResult.content);
				}

				// Pass settled hashes to disk index so they survive plugin reload
				// and serve as the three-way baseline next startup reconcile.
				const blockedIndexPathsInner = Array.from(new Set([
					...deferredOpenEditorIndexPaths,
					...staleClosedDecisionIndexPaths,
					...projectionBlockedMissingDiskIndexPaths,
					...this.getPreservedUnresolvedMarkdownEntries()
						.map((entry) => entry.path),
				]));
				this.blockedDivergenceCount = 0;
				// Do NOT clear lastBlockedDivergenceAt — it serves as "last seen"
				// historical marker. Do NOT clear sample — remains available as
				// "last blocked sample" even when count resets.
				if (blockedIndexPathsInner.length > 0) {
					this.deps.trace("reconcile", "reconcile-disk-index-advance-deferred-open-editor", {
						mode,
						blockedCount: blockedIndexPathsInner.length,
						...tracePathList("blocked", blockedIndexPathsInner),
					});
				}
				if (staleClosedDecisionIndexPaths.size > 0) {
					this.deps.trace("reconcile", "reconcile-disk-index-advance-deferred-stale-decision", {
						mode,
						blockedCount: staleClosedDecisionIndexPaths.size,
						...tracePathList("blocked", Array.from(staleClosedDecisionIndexPaths)),
					});
				}
				const indexBeforeCommit = this.deps.getDiskIndex();
				const nextDiskIndex = updateIndex(indexBeforeCommit, allStats, {
					excludePaths: blockedIndexPathsInner,
					settledHashes,
				});
				for (const path of projectionBlockedMissingDiskIndexPaths) {
					const previousEntry = indexBeforeCommit[path];
					if (previousEntry) {
						// Missing disk plus an older clean baseline represents a possible
						// local deletion. Holding provider projection must not erase that
						// evidence, or a later open gate could treat the path as a fresh
						// remote create and resurrect it.
						nextDiskIndex[path] = { ...previousEntry };
					}
				}
				const newerVerifiedBaselinePaths: string[] = [];
				for (const [path, currentEntry] of Object.entries(indexBeforeCommit)) {
					const currentHash = currentEntry.contentHash;
					if (!currentHash) continue;
					const plannedHash = settledHashes.get(path);
					const expectedRevision = baselineRevisionsAtStart.get(path) ?? 0;
					const currentRevision = this.diskBaselineRevisions.get(path) ?? 0;
					const baselineAdvancedPastScan = currentRevision !== expectedRevision;
					const newlyCreatedSettledPath =
						plannedHash === currentHash && !allStats.has(path);
					if (!baselineAdvancedPastScan && !newlyCreatedSettledPath) continue;
					// DiskMirror publishes only atomic/verified write settlements. Never
					// let an older reconcile-local C1 overwrite a callback's newer C2, and
					// keep newly created paths that were absent from the initial stat scan.
					nextDiskIndex[path] = { ...currentEntry };
					newerVerifiedBaselinePaths.push(path);
				}
				if (newerVerifiedBaselinePaths.length > 0) {
					this.deps.trace("reconcile", "reconcile-newer-baseline-preserved", {
						count: newerVerifiedBaselinePaths.length,
						...tracePathList("preserved", newerVerifiedBaselinePaths),
					});
				}
				this.deps.setDiskIndex(nextDiskIndex);
				for (const [hash, text] of settledBaselineTexts) {
					this.deps.recordBaselineText?.(hash, text);
				}
			} else {
				// Safety brake triggered: exclude all planned updates from index.
				const blockedIndexPaths = result.updatedOnDisk;
				this.blockedDivergenceCount = blockedIndexPaths.length;
				this.lastBlockedDivergenceAt = new Date().toISOString();
				this.blockedDivergenceSample = blockedIndexPaths.slice(0, 10).map((p) => {
					const dot = p.lastIndexOf(".");
					const ext = dot >= 0 ? p.slice(dot) : "(none)";
					return { ext, hash: contentFingerprint(`${this.diagnosticPathSalt}:${p}`) };
				});
				this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats, {
					excludePaths: blockedIndexPaths,
				}));
				this.deps.trace("reconcile", "reconcile-disk-index-advance-blocked", {
					mode,
					blockedCount: blockedIndexPaths.length,
					...tracePathList("blocked", blockedIndexPaths),
				});
			}

			this.lastReconcileStats = {
				at: new Date().toISOString(),
				mode,
				plannedCreates: result.createdOnDisk.length,
				plannedUpdates: result.updatedOnDisk.length,
				flushedCreates,
				flushedUpdates,
				safetyBrakeTriggered,
				safetyBrakeReason,
			};
			this.deps.trace("reconcile", "reconcile-authority-summary", {
				mode,
				seededToCrdtCount: result.seededToCrdt.length,
				createdOnDiskCount: result.createdOnDisk.length,
				updatedOnDiskCount: result.updatedOnDisk.length,
				flushedCreates,
				flushedUpdates,
				untrackedCount: result.untracked.length,
				tombstoneSkippedCount: result.skipped,
				safetyBrakeTriggered,
				safetyBrakeReason,
				...tracePathList("created", result.createdOnDisk),
				...tracePathList("blockedUpdate", safetyBrakeTriggered ? result.updatedOnDisk : []),
			});

			this.untrackedFiles = result.untracked;
			await this.deps.saveDiskIndex();
			if (!safetyBrakeTriggered) {
				for (const candidate of interceptedCandidatesToClearAfterIndexSave) {
					this.clearInterceptedExternalDiskMutation(candidate);
				}
			}
			// Local attachment delete/rename events can arrive while provider sync
			// or startup reconciliation is still pending. Commit their durable,
			// disk-verified intent before declaring reconciliation complete and
			// before blob reconcile is allowed to queue a stale remote download.
			await this.deps.replayPendingBlobIntents?.(`reconcile-${mode}`);
			this.reconciled = true;

			const integrity = vaultSync.runIntegrityChecks();
			if (integrity.duplicateIds > 0 || integrity.orphansCleaned > 0 || integrity.duplicateActivePaths > 0) {
				this.deps.log(
					`Integrity: ${integrity.duplicateIds} duplicate IDs fixed, ` +
					`${integrity.orphansCleaned} orphans cleaned, ` +
					`${integrity.duplicateActivePaths} active path collisions preserved`,
				);
			}

			this.deps.log(
				`Reconciliation [${mode}] complete: ` +
				`${result.seededToCrdt.length} seeded, ` +
				`creates planned/flushed=${result.createdOnDisk.length}/${flushedCreates}, ` +
				`updates planned/flushed=${result.updatedOnDisk.length}/${flushedUpdates}, ` +
				`${result.untracked.length} untracked, ` +
				`${result.skipped} tombstoned` +
				(safetyBrakeTriggered ? ", safety-brake=on" : ", safety-brake=off"),
			);

			this.deps.recordFlightEvent?.({
				priority: safetyBrakeTriggered ? "critical" : "important",
				kind: safetyBrakeTriggered ? PRODUCT_EVENT_KIND.reconcileSafetyBrakeTriggered : PRODUCT_EVENT_KIND.reconcileComplete,
				severity: safetyBrakeTriggered ? "warn" : "info",
				scope: "vault",
				source: "reconciliationController",
				layer: "reconcile",
				data: {
					mode,
					seededToCrdt: result.seededToCrdt.length,
					createdOnDisk: result.createdOnDisk.length,
					updatedOnDisk: result.updatedOnDisk.length,
					flushedCreates,
					flushedUpdates,
					untracked: result.untracked.length,
					tombstonedSkipped: result.skipped,
					safetyBrakeTriggered,
					safetyBrakeReason,
				},
			});

			const blobSync = this.deps.getBlobSync();
			if (blobSync) {
				const blobResult = blobSync.reconcile(
					mode,
					runtimeConfig.excludePatterns,
				);
				this.deps.log(
					`Blob reconciliation [${mode}]: ` +
					`${blobResult.uploadQueued} uploads, ` +
					`${blobResult.downloadQueued} downloads, ` +
					`${blobResult.skipped} skipped`,
				);
				this.deps.onBlobReconciled?.(mode, vaultSync);
			}
			this.deps.onReconciled(`reconcile-${mode}`);
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
			this.deps.scheduleTraceStateSnapshot(`reconcile-${mode}`);
			this.schedulePendingReconciliation(mode);
		}
	}

	async importUntrackedFiles(): Promise<void> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		const toImport = [...this.untrackedFiles];
		this.untrackedFiles = [];
		let imported = 0;

		for (const path of toImport) {
			if (vaultSync.getTextForPath(path)) {
				this.deps.log(`importUntracked: "${path}" now in CRDT, skipping`);
				continue;
			}

			// Guard: do NOT auto-revive paths that were preserved during a
			// remote-delete with unknown baseline. These files sit on disk to
			// avoid data loss, but auto-importing them would resurrect the
			// tombstoned entry — exactly the zombie-file bug we fixed.
			if (this.isMarkdownPreservedUnresolved(path)) {
				this.deps.log(`importUntracked: "${path}" is preserved-unresolved remote delete, skipping auto-revive`);
				this.deps.trace("reconcile", "import-untracked-skipped-preserved-unresolved", {
					path,
				});
				continue;
			}

			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.readFreshMarkdownFile(file);
				if (this.deps.shouldBlockFrontmatterIngest(
					path,
					null,
					content,
					"import-untracked-disk-to-crdt-seed",
				)) {
					// Keep the path in the untracked queue so a corrected local file can
					// be retried without ever admitting this unsafe snapshot.
					this.untrackedFiles.push(path);
					this.recordFrontmatterIngestBlocked(path, false, "disk-to-crdt-seed");
					this.deps.trace("reconcile", "document-admission-blocked", {
						path,
						stage: "import-untracked-disk-to-crdt-seed",
					});
					this.deps.log(
						`importUntracked: document guard kept unsafe file local: "${path}"`,
					);
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					continue;
				}
				// Mint a per-path `op-import-untracked-*` opId BEFORE the CRDT
				// mutation so the resulting `crdt.file.created` envelope is
				// causally linkable to this admission attempt.
				const opId = `op-import-untracked-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				// Untracked files exist on disk but have no CRDT entry. If the
				// path is tombstoned, the user explicitly placed the file after
				// deletion — that is a deliberate revive, not a stale ghost.
				const result = vaultSync.ensureFile(
					path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: true,
						reviveReason: "import-untracked-local-file",
						opId,
					},
				);
				switch (result.kind) {
					case "created":
						imported++;
						break;
					case "existing":
						this.deps.log(`importUntracked: "${path}" became active before import settled`);
						break;
					case "replan":
						this.untrackedFiles.push(path);
						this.deps.log(`importUntracked: "${path}" active set changed, queued for retry`);
						break;
					case "blocked":
						this.untrackedFiles.push(path);
						this.deps.log(`importUntracked: "${path}" blocked (${result.reason}), preserving local state`);
						break;
					default:
						assertNever(result);
				}
			} catch (err) {
				console.error(`[kaos] importUntracked failed for "${path}":`, err);
			}
		}

		if (!vaultSync.isInitialized) {
			vaultSync.markInitialized();
		}

		this.deps.refreshStatusBar();
		this.deps.log(`Imported ${imported} previously untracked files`);

		if (imported > 0) {
			new Notice(`KAOS: imported ${imported} files after server sync.`);
		}
	}

	private mergeDirtyMarkdownPath(
		path: string,
		incoming: MarkdownDirtyEntry,
	): void {
		if (this.isMarkdownResolutionActive(path)) return;
		const generation = this.getMarkdownIngestGeneration(path);
		if (incoming.generation !== undefined && incoming.generation !== generation) return;
		incoming = { ...incoming, generation };
		const storedPrevious = this.dirtyMarkdownPaths.get(path);
		const previous = storedPrevious?.generation === undefined
			|| storedPrevious.generation === generation
			? storedPrevious
			: undefined;
		if (!previous) {
			this.dirtyMarkdownPaths.set(path, incoming);
			return;
		}

		const mergedReason = previous.reason === "create" || incoming.reason === "create" ? "create" : "modify";
		const coalescedOpIds = Array.from(new Set([
			...previous.coalescedOpIds,
			...incoming.coalescedOpIds,
		]));
		this.dirtyMarkdownPaths.set(path, {
			reason: mergedReason,
			primaryOpId: previous.primaryOpId ?? incoming.primaryOpId,
			coalescedOpIds,
			retryCount: Math.min(previous.retryCount, incoming.retryCount),
			generation,
			preservedUnresolvedEpisodeIdAtAdmission:
				incoming.preservedUnresolvedEpisodeIdAtAdmission ??
				previous.preservedUnresolvedEpisodeIdAtAdmission,
			notBeforeMs: mergedReason === "create"
				? undefined
				: Math.max(previous.notBeforeMs ?? 0, incoming.notBeforeMs ?? 0) || undefined,
		});
	}

	private getRecentEditorDirtyDeferUntil(
		path: string,
		reason: MarkdownDirtyReason,
		now = Date.now(),
	): number | null {
		if (reason !== "modify") return null;
		const editorBindings = this.deps.getEditorBindings();
		const lastEditorActivity = editorBindings?.getLastEditorActivityForPath(path) ?? null;
		if (lastEditorActivity === null) return null;

		const isOpenOrBound =
			(editorBindings?.isBound(path) ?? false) || this.getOpenMarkdownViewsForPath(path).length > 0;
		if (!isOpenOrBound) return null;

		const deferUntil = lastEditorActivity + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
		return deferUntil > now ? deferUntil : null;
	}

	private queueDirtyMarkdownPath(
		path: string,
		reason: MarkdownDirtyReason,
		opId?: string,
		coalescedOpIds: string[] = opId ? [opId] : [],
		retryCount = 0,
		preservedUnresolvedEpisodeIdAtAdmission?: string,
	): void {
		if (this.isMarkdownResolutionActive(path)) {
			this.deps.trace("reconcile", "markdown-dirty-dropped-during-resolution", {
				path,
				reason,
			});
			return;
		}
		const now = Date.now();
		const currentPreservedEntry = retryCount === 0
			? this.getPreservedUnresolvedMarkdownEntries()
				.find((entry) => entry.path === path)
			: undefined;
		const notBeforeMs = this.getRecentEditorDirtyDeferUntil(path, reason, now) ?? undefined;
		this.mergeDirtyMarkdownPath(path, {
			reason,
			primaryOpId: opId,
			coalescedOpIds: Array.from(new Set(coalescedOpIds)),
			retryCount,
			generation: this.getMarkdownIngestGeneration(path),
			preservedUnresolvedEpisodeIdAtAdmission:
				preservedUnresolvedEpisodeIdAtAdmission ??
				(currentPreservedEntry
					? getPreservedUnresolvedEpisodeId(currentPreservedEntry)
					: undefined),
			notBeforeMs,
		});
		this.lastMarkdownDirtyAt = now;
		this.scheduleMarkdownDrain();
	}

	markMarkdownDirty(file: TFile, reason: MarkdownDirtyReason, opId?: string): void {
		// A create at an old path starts a new path-identity episode. Never let
		// an editor snapshot captured for the previous occupant authorize it.
		if (reason === "create") {
			this.visibleAuthorityDeferredPaths.delete(file.path);
			this.invalidateExternalCandidateIdentity(file.path);
		}
		const preserveActiveFlushMarker =
			reason === "modify" && this.canPreserveMarkerForActiveOpenFlush(file.path);
		// Every new vault event invalidates any older async stable-read/recovery
		// ticket for this path before the replacement work is queued.
		this.noteMarkdownDiskMutation(file.path);
		if (preserveActiveFlushMarker) {
			this.deps.trace("reconcile", "open-flush-active-marker-preserved", {
				path: file.path,
				reason,
				diskRevision: this.getMarkdownDiskRevision(file.path),
			});
		} else {
			this.captureVisibleAuthorityAtDirtyAdmission(file.path, reason);
		}
		this.queueDirtyMarkdownPath(file.path, reason, opId);
	}

	noteInterceptedExternalDiskMutation(candidate: InterceptedExternalDiskMutation): void {
		const current = this.interceptedExternalDiskMutations.get(candidate.path);
		if (current?.sequence === candidate.sequence) {
			if (current.content !== candidate.content) {
				// A sequence is an event identity, so different bytes for the same
				// identity are an impossible state. Preserve the incoming version
				// instead of silently choosing one side.
				void this.enqueueSupersededExternalDiskMutation(candidate);
			} else {
				void this.startSupersededExternalPreservationDrain(candidate.path);
			}
			return;
		}
		if (current && current.sequence > candidate.sequence) {
			if (current.content !== candidate.content) {
				void this.enqueueSupersededExternalDiskMutation(candidate);
			}
			return;
		}
		if (
			current &&
			candidate.sequence > current.sequence &&
			current.content !== candidate.content
		) {
			// Event order, elapsed time, and editor snapshots cannot prove that
			// the newer disk bytes causally include the older version. Preserve
			// every distinct superseded state until a candidate-specific durable
			// adoption receipt exists.
			void this.enqueueSupersededExternalDiskMutation(current);
		}
		this.interceptedExternalDiskMutations.set(candidate.path, candidate);
		this.traceOpenExternalEvent("open-external-candidate-captured", {
			path: candidate.path,
			reason: "intercepted-external-disk-mutation",
			sequence: candidate.sequence,
			contentLength: candidate.content.length,
		});
		this.queueDirtyMarkdownPath(candidate.path, "modify");
	}

	private sameExternalEditorAuthorityLineageForAppendRecovery(
		older: ExternalDiskMutationEditorAuthorityLineage,
		newer: ExternalDiskMutationEditorAuthorityLineage,
	): boolean {
		if (
			older.path !== newer.path ||
			older.views.length === 0 ||
			older.views.length !== newer.views.length
		) {
			return false;
		}
		const olderByLeafId = new Map(
			older.views.map((view) => [view.leafId, view] as const),
		);
		if (olderByLeafId.size !== older.views.length) return false;
		const seenNewerLeafIds = new Set<string>();
		for (const view of newer.views) {
			if (seenNewerLeafIds.has(view.leafId)) return false;
			seenNewerLeafIds.add(view.leafId);
			const previous = olderByLeafId.get(view.leafId);
			if (
				!previous ||
				previous.viewId !== view.viewId ||
				previous.cmId !== view.cmId ||
				previous.bindingEpoch !== view.bindingEpoch ||
				previous.editorAuthorityRevision !== view.editorAuthorityRevision ||
				previous.editorContent !== view.editorContent
			) {
				return false;
			}
		}
		return true;
	}

	private isSameExternalCandidate(
		left: InterceptedExternalDiskMutation,
		right: InterceptedExternalDiskMutation,
	): boolean {
		return left.sequence === right.sequence && left.content === right.content;
	}

	private externalCandidateMatchesStableDisk(
		candidateContent: string,
		stableDiskContent: string,
	): boolean {
		return candidateContent === stableDiskContent ||
			normalizeEditorText(candidateContent) === normalizeEditorText(stableDiskContent);
	}

	/**
	 * Recover an exact external append after Obsidian has written the unchanged
	 * editor authority back over it.
	 *
	 * This is intentionally narrower than a generic "prefer the older event"
	 * rule. The physical bytes must match a recent KAOS write fingerprint, every
	 * open editor and Y.Text must still expose those same bytes, and the captured
	 * user-authority lineage must be unchanged. Only then can an intercepted
	 * strict append successor be replayed without discarding any later user edit.
	 */
	private async findRecoverableExternalAppendOverRecentSelfWrite(input: {
		file: TFile;
		physicalDiskContent: string;
		existingText: ReturnType<VaultSync["getTextForPath"]>;
		openViews: MarkdownView[];
	}): Promise<InterceptedExternalDiskMutation | null> {
		const path = input.file.path;
		if (input.openViews.length === 0) return null;
		const editorBindings = this.deps.getEditorBindings();
		if (
			!editorBindings ||
			typeof editorBindings.captureExternalDiskMutationEditorAuthorityLineage !== "function"
		) {
			return null;
		}

		const crdtContent = yTextToString(input.existingText);
		const editorAuthority = this.getOpenEditorAuthority(input.openViews);
		const physicalLogical = normalizeEditorText(input.physicalDiskContent);
		if (
			crdtContent === null ||
			editorAuthority.kind !== "single" ||
			normalizeEditorText(crdtContent) !== physicalLogical ||
			normalizeEditorText(editorAuthority.content) !== physicalLogical
		) {
			return null;
		}

		const lifecycleGeneration = this.lifecycleGeneration;
		const candidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(path);
		const maxCandidateProofAttempts = 3;
		for (let attempt = 1; attempt <= maxCandidateProofAttempts; attempt += 1) {
			if (
				lifecycleGeneration !== this.lifecycleGeneration ||
				candidateIdentityEpoch !== this.getExternalCandidateIdentityEpoch(path) ||
				this.pendingSupersededExternalDiskMutations.has(path)
			) {
				return null;
			}

			const candidate = this.interceptedExternalDiskMutations.get(path) ?? null;
			const capturedLineage = candidate?.editorAuthorityLineage ?? null;
			if (
				!candidate ||
				!capturedLineage ||
				this.externalCandidateMatchesStableDisk(
					candidate.content,
					input.physicalDiskContent,
				)
			) {
				return null;
			}

			const candidateLogical = normalizeEditorText(candidate.content);
			if (
				candidateLogical === physicalLogical ||
				!candidateLogical.startsWith(physicalLogical)
			) {
				return null;
			}

			const currentLineage =
				editorBindings.captureExternalDiskMutationEditorAuthorityLineage(
					path,
					input.openViews,
				);
			if (
				!currentLineage ||
				!this.sameExternalEditorAuthorityLineageForAppendRecovery(
					capturedLineage,
					currentLineage,
				)
			) {
				return null;
			}

			let physicalIsRecentSelfWrite = false;
			try {
				physicalIsRecentSelfWrite =
					await this.deps.getDiskMirror()?.matchesRecentWriteFingerprint(input.file) === true;
			} catch {
				physicalIsRecentSelfWrite = false;
			}
			if (!physicalIsRecentSelfWrite) return null;
			if (
				lifecycleGeneration !== this.lifecycleGeneration ||
				candidateIdentityEpoch !== this.getExternalCandidateIdentityEpoch(path) ||
				this.pendingSupersededExternalDiskMutations.has(path)
			) {
				return null;
			}

			const latestCandidate = this.interceptedExternalDiskMutations.get(path) ?? null;
			if (latestCandidate !== candidate) {
				this.deps.trace("reconcile", "open-external-append-recovery-proof-restarted", {
					path,
					attempt,
					previousSequence: candidate.sequence,
					currentSequence: latestCandidate?.sequence ?? null,
				});
				continue;
			}

			const postProofLineage =
				editorBindings.captureExternalDiskMutationEditorAuthorityLineage(
					path,
					input.openViews,
				);
			if (
				!postProofLineage ||
				!this.sameExternalEditorAuthorityLineageForAppendRecovery(
					currentLineage,
					postProofLineage,
				)
			) {
				return null;
			}

			return candidate;
		}

		return null;
	}

	private traceRecoverableExternalAppend(
		message:
			| "open-external-append-recovered-over-self-write"
			| "open-external-append-recovery-deferred-to-dirty-ingest",
		candidate: InterceptedExternalDiskMutation,
		physicalDiskContent: string,
		openViewCount: number,
	): void {
		this.deps.trace("reconcile", message, {
			path: candidate.path,
			sequence: candidate.sequence,
			physicalLength: physicalDiskContent.length,
			candidateLength: candidate.content.length,
			openViewCount,
		});
	}

	private enqueueSupersededExternalDiskMutation(
		candidate: InterceptedExternalDiskMutation,
	): Promise<ExternalCandidatePreservationResult> {
		const pending = this.pendingSupersededExternalDiskMutations.get(candidate.path) ?? [];
		if (!pending.some((queued) => this.isSameExternalCandidate(queued, candidate))) {
			pending.push(candidate);
			this.pendingSupersededExternalDiskMutations.set(candidate.path, pending);
		}
		return this.startSupersededExternalPreservationDrain(candidate.path);
	}

	private startSupersededExternalPreservationDrain(
		path: string,
	): Promise<ExternalCandidatePreservationResult> {
		const existing = this.supersededExternalPreservationByPath.get(path);
		if (existing) {
			// A candidate from a replacement path identity may arrive while stale work
			// is still unwinding. Chain its drain rather than racing the old writer.
			return existing.then((result) => {
				if (!this.pendingSupersededExternalDiskMutations.has(path)) {
					return result;
				}
				return this.startSupersededExternalPreservationDrain(path);
			});
		}

		const lifecycleGeneration = this.lifecycleGeneration;
		const pathIdentityEpoch = this.getExternalCandidateIdentityEpoch(path);
		const drain = this.drainSupersededExternalDiskMutations(
			path,
			lifecycleGeneration,
			pathIdentityEpoch,
		);
		this.supersededExternalPreservationByPath.set(path, drain);
		const clearIfCurrent = () => {
			if (this.supersededExternalPreservationByPath.get(path) === drain) {
				this.supersededExternalPreservationByPath.delete(path);
			}
		};
		void drain.then(clearIfCurrent, clearIfCurrent);
		return drain;
	}

	private async drainSupersededExternalDiskMutations(
		path: string,
		lifecycleGeneration: number,
		pathIdentityEpoch: number,
	): Promise<ExternalCandidatePreservationResult> {
		const isCurrent = () =>
			lifecycleGeneration === this.lifecycleGeneration &&
			pathIdentityEpoch === this.getExternalCandidateIdentityEpoch(path) &&
			this.deps.isMarkdownPathSyncable(path);
		if (!isCurrent()) return { kind: "invalidated" };

		while (isCurrent()) {
			const pending = this.pendingSupersededExternalDiskMutations.get(path);
			const candidate = pending?.[0];
			if (!pending || !candidate) return { kind: "preserved" };

			// With conflict-artifact preservation abolished, every distinct
			// superseded disk revision is recorded (trace + durable server
			// audit) instead of written to a `(KAOS conflict ...)` file. The
			// bytes may be genuinely unrecoverable elsewhere (already
			// overwritten on disk, never ingested into CRDT), so the audit
			// record is the only trace of what was lost.
			const candidateHash = await contentBaselineHash(candidate.content);
			if (!isCurrent()) return { kind: "invalidated" };
			if (
				this.retirePendingSupersededCandidate(path, pending, candidate) ===
				"invalidated"
			) {
				return { kind: "invalidated" };
			}
			// One provably redundant class is not even audited: bytes that
			// hash to the durable disk-index contentHash are the baseline and
			// nothing was lost.
			const durableBaselineHash =
				this.deps.getDiskIndex()[candidate.path]?.contentHash ?? null;
			if (durableBaselineHash === null || candidateHash !== durableBaselineHash) {
				await this.recordDiscardedRevision(
					candidate.path,
					candidate.content,
					"superseded-external-revision",
					candidateHash,
				);
			} else {
				this.deps.trace(
					"conflict",
					"superseded-external-revision-baseline-skipped",
					{
						path: candidate.path,
						sequence: candidate.sequence,
						contentLength: candidate.content.length,
						baselineHashPrefix: durableBaselineHash.slice(0, 12),
					},
				);
			}
		}
		return { kind: "invalidated" };
	}

	/**
	 * Remove one exact pending superseded candidate from its per-path FIFO,
	 * deleting the FIFO entry once it is empty. Returns "invalidated" when a
	 * concurrent drain replaced the FIFO identity and the caller must abandon
	 * this pass.
	 */
	private retirePendingSupersededCandidate(
		path: string,
		pending: InterceptedExternalDiskMutation[],
		candidate: InterceptedExternalDiskMutation,
	): "retired" | "invalidated" {
		if (this.pendingSupersededExternalDiskMutations.get(path) !== pending) {
			return "invalidated";
		}
		const currentIndex = pending.findIndex((queued) =>
			this.isSameExternalCandidate(queued, candidate)
		);
		if (currentIndex >= 0) pending.splice(currentIndex, 1);
		if (pending.length === 0) {
			this.pendingSupersededExternalDiskMutations.delete(path);
		}
		return "retired";
	}

	private hasPendingSupersededExternalDiskMutation(
		candidate: InterceptedExternalDiskMutation,
	): boolean {
		return this.pendingSupersededExternalDiskMutations.get(candidate.path)
			?.some((queued) => this.isSameExternalCandidate(queued, candidate)) ?? false;
	}

	/**
	 * Fence a stable disk snapshot behind every exact intercepted revision that
	 * would otherwise be lost. This helper mutates neither primary authority nor
	 * baseline; callers may process the stable snapshot only after `preserved`.
	 */
	private async admitStableExternalDiskMutation(
		path: string,
		stableDiskContent: string,
	): Promise<ExternalCandidatePreservationResult> {
		const lifecycleGeneration = this.lifecycleGeneration;
		const pathIdentityEpoch = this.getExternalCandidateIdentityEpoch(path);
		const isCurrent = () =>
			lifecycleGeneration === this.lifecycleGeneration &&
			pathIdentityEpoch === this.getExternalCandidateIdentityEpoch(path) &&
			this.deps.isMarkdownPathSyncable(path);
		if (!isCurrent()) return { kind: "invalidated" };

		const latestBeforePendingDrain = this.interceptedExternalDiskMutations.get(path) ?? null;
		const latestWasPendingMismatch = latestBeforePendingDrain !== null &&
			!this.externalCandidateMatchesStableDisk(
				latestBeforePendingDrain.content,
				stableDiskContent,
			) &&
			this.hasPendingSupersededExternalDiskMutation(latestBeforePendingDrain);
		if (this.pendingSupersededExternalDiskMutations.has(path)) {
			const pendingResult = await this.startSupersededExternalPreservationDrain(path);
			if (pendingResult.kind !== "preserved") return pendingResult;
			if (!isCurrent()) return { kind: "invalidated" };
			if (latestWasPendingMismatch) {
				if (
					latestBeforePendingDrain === null ||
					this.interceptedExternalDiskMutations.get(path) !== latestBeforePendingDrain
				) {
					return { kind: "invalidated" };
				}
				this.interceptedExternalDiskMutations.delete(path);
			}
		}

		const latest = this.interceptedExternalDiskMutations.get(path) ?? null;
		if (
			!latest ||
			this.externalCandidateMatchesStableDisk(latest.content, stableDiskContent)
		) {
			return { kind: "preserved" };
		}

		const preservationResult = await this.enqueueSupersededExternalDiskMutation(latest);
		if (preservationResult.kind !== "preserved") return preservationResult;
		if (!isCurrent()) return { kind: "invalidated" };
		if (this.interceptedExternalDiskMutations.get(path) !== latest) {
			return { kind: "invalidated" };
		}
		this.interceptedExternalDiskMutations.delete(path);
		return { kind: "preserved" };
	}

	private getExternalCandidateIdentityEpoch(path: string): number {
		return this.externalCandidateIdentityEpochs.get(path) ?? 0;
	}

	private invalidateExternalCandidateIdentity(path: string): void {
		// Fence in-flight candidate work before clearing its state, so a stale
		// pass cannot republish a superseded candidate after invalidation.
		this.externalCandidateIdentityEpochs.set(
			path,
			this.getExternalCandidateIdentityEpoch(path) + 1,
		);
		this.interceptedExternalDiskMutations.delete(path);
		this.pendingSupersededExternalDiskMutations.delete(path);
	}

	private getMatchingInterceptedExternalDiskMutation(
		path: string,
		diskContent: string,
	): InterceptedExternalDiskMutation | null {
		const candidate = this.interceptedExternalDiskMutations.get(path) ?? null;
		return candidate && this.externalCandidateMatchesStableDisk(candidate.content, diskContent)
			? candidate
			: null;
	}

	private clearInterceptedExternalDiskMutation(
		candidate: InterceptedExternalDiskMutation | null,
	): void {
		if (!candidate) return;
		if (this.interceptedExternalDiskMutations.get(candidate.path) === candidate) {
			this.interceptedExternalDiskMutations.delete(candidate.path);
		}
	}

	private captureVisibleAuthorityAtDirtyAdmission(
		path: string,
		reason: MarkdownDirtyReason,
	): void {
		const openViews = this.getOpenMarkdownViewsForPath(path);
		if (openViews.length === 0) return;

		let readComplete = true;
		const currentContents: string[] = [];
		for (const view of openViews) {
			try {
				currentContents.push(view.editor.getValue());
			} catch {
				readComplete = false;
			}
		}
		const currentEditorContents = Array.from(new Set(currentContents));
		const currentReadComplete =
			readComplete && currentContents.length === openViews.length;
		const editorBindings = this.deps.getEditorBindings();
		const currentEditorActivity =
			editorBindings?.getLastEditorActivityForPath?.(path) ?? null;
		const currentEditorTicket = this.compactVisibleAuthorityTicket(
			editorBindings?.captureOpenEditorMutationTicket?.(path, openViews) ?? null,
		);
		const previous = this.visibleAuthorityDeferredPaths.get(path);
		const editorActivityAdvanced =
			currentEditorActivity !== null &&
			(
				previous?.capturedEditorActivity === null ||
				previous?.capturedEditorActivity === undefined ||
				currentEditorActivity > previous.capturedEditorActivity
			);
		const ticketProgress: VisibleAuthorityTicketProgress = previous
			? this.classifyVisibleAuthorityTicketProgress(
				previous.capturedEditorTicket,
				currentEditorTicket,
				currentEditorContents,
				currentReadComplete,
			)
			: {
				kind: "unavailable",
				advancedEditorContents: [],
				supersedesPreviousSingle: false,
				provenNoEditorAuthorityAdvance: false,
			};
		const currentCrdtContent = yTextToString(
			this.deps.getVaultSync()?.getTextForPath(path),
		);
		const crdtAliasProjectionAdopted = this.canRecaptureCrdtAliasProjection({
			previous,
			progress: ticketProgress,
			currentEditorContents,
			currentReadComplete,
			currentCrdtContent,
		});
		const recaptureIsAuthoritative =
			currentReadComplete &&
			(
				!previous ||
				ticketProgress.kind === "successor" ||
				crdtAliasProjectionAdopted ||
				(ticketProgress.kind === "unavailable" && editorActivityAdvanced)
			);
		const editorContents = recaptureIsAuthoritative
			? currentEditorContents
			: Array.from(new Set([
				...this.getRetainedVisibleAuthorityContents(previous, ticketProgress),
				...ticketProgress.advancedEditorContents,
				...currentEditorContents,
			]));
		this.visibleAuthorityDeferredPaths.set(path, {
			editorContents,
			readComplete:
				currentReadComplete &&
				(recaptureIsAuthoritative || editorContents.length === 1),
			capturedDiskContent: previous?.capturedDiskContent ?? null,
			capturedCrdtContent: currentCrdtContent,
			capturedDiskRevision: this.getMarkdownDiskRevision(path),
			capturedEditorActivity: currentEditorActivity,
			capturedEditorTicket: currentEditorTicket,
			capturedAt: Date.now(),
		});
		this.deps.trace("reconcile", "visible-editor-authority-captured-at-dirty-admission", {
			path,
			reason,
			openViewCount: openViews.length,
			readComplete: currentReadComplete,
			editorCandidateCount: editorContents.length,
			ticketProgress: ticketProgress.kind,
			advancedEditorCandidateCount: ticketProgress.advancedEditorContents.length,
			recaptureIsAuthoritative,
			crdtAliasProjectionAdopted,
			crdtLength: currentCrdtContent?.length ?? null,
			diskRevision: this.getMarkdownDiskRevision(path),
		});
	}

	noteMarkdownDiskMutation(path: string): void {
		this.markdownDiskRevisions.set(path, this.getMarkdownDiskRevision(path) + 1);
		if (this.reconcileInFlight) {
			this.reconcilePending = true;
			this.deps.trace("reconcile", "reconcile-invalidated-by-disk-event", { path });
		}
	}

	noteDiskBaselineSettlement(path: string, settledContent?: string): void {
		this.diskBaselineRevisions.set(
			path,
			(this.diskBaselineRevisions.get(path) ?? 0) + 1,
		);
		if (settledContent !== undefined) {
			this.clearDeferredVisibleAuthorityIfSettled(path, settledContent);
		}
	}

	private getMarkdownDiskRevision(path: string): number {
		return this.markdownDiskRevisions.get(path) ?? 0;
	}

	private getMarkdownIngestGeneration(path: string): number {
		return this.markdownIngestGenerations.get(path) ?? 0;
	}

	private bumpMarkdownIngestGeneration(path: string): number {
		const next = this.getMarkdownIngestGeneration(path) + 1;
		this.markdownIngestGenerations.set(path, next);
		return next;
	}

	private isMarkdownResolutionActive(path: string): boolean {
		return this.markdownRemoteDeleteResolutions.has(path);
	}

	private acquireMarkdownRemoteDeleteResolution(
		path: string,
		operation: InternalMarkdownResolutionLease["operation"],
	): InternalMarkdownResolutionLease {
		if (this.markdownRemoteDeleteResolutions.has(path)) {
			throw new Error(`Another Attention action is already running for "${path}".`);
		}

		const generation = this.bumpMarkdownIngestGeneration(path);
		const lease = Object.freeze({ path, operation, generation }) as InternalMarkdownResolutionLease;
		this.markdownRemoteDeleteResolutions.set(path, lease);
		const droppedQueued = this.dirtyMarkdownPaths.delete(path);
		this.invalidateExternalCandidateIdentity(path);
		this.deps.trace("reconcile", "markdown-remote-delete-resolution-began", {
			path,
			operation,
			generation,
			droppedQueued,
			activeIngestInvalidated: Array.from(this.activeMarkdownIngests.values())
				.some((active) => active.path === path),
		});
		return lease;
	}

	private releaseMarkdownRemoteDeleteResolution(
		lease: InternalMarkdownResolutionLease,
	): void {
		if (this.markdownRemoteDeleteResolutions.get(lease.path) !== lease) return;
		this.markdownRemoteDeleteResolutions.delete(lease.path);
		this.deps.trace("reconcile", "markdown-remote-delete-resolution-finished", {
			path: lease.path,
			operation: lease.operation,
			generation: lease.generation,
		});
	}

	/** Release an Accept lease in the caller's `finally` block. */
	finishRemoteDeletedMarkdownResolution(
		lease: MarkdownRemoteDeleteResolutionLease,
	): void {
		this.releaseMarkdownRemoteDeleteResolution(lease);
	}

	private findRemoteDeletedMarkdownEntry(
		path: string,
		expectedReason: RemoteDeletePreservedUnresolvedReason,
		expectedEpisode?: MarkdownRemoteDeleteEntryIdentity,
	): PreservedUnresolvedEntry {
		const diskMirror = this.deps.getDiskMirror();
		if (!diskMirror) throw new Error("Sync is not initialized.");
		const entry = diskMirror.getPreservedUnresolvedEntries()
			.find((candidate) => candidate.path === path && candidate.kind === "markdown");
		if (!entry) {
			throw new Error(`Attention entry is no longer active for "${path}".`);
		}
		if (
			entry.reason !== expectedReason
			|| !isRemoteDeletePreservedUnresolvedEntry(entry)
		) {
			throw new Error(`Attention state changed for "${path}". Refresh the dashboard.`);
		}
		if (expectedEpisode && !this.isSameMarkdownRemoteDeleteEntry(entry, expectedEpisode)) {
			throw new Error(`Attention state changed for "${path}". Refresh the dashboard.`);
		}
		return { ...entry };
	}

	private isSameMarkdownRemoteDeleteEntry(
		current: PreservedUnresolvedEntry,
		expected: MarkdownRemoteDeleteEntryIdentity,
	): boolean {
		return current.reason === expected.reason
			&& getPreservedUnresolvedEpisodeId(current) === expected.episodeId;
	}

	private assertSameRemoteDeletedMarkdownEntry(
		path: string,
		expected: PreservedUnresolvedEntry,
	): void {
		const current = this.deps.getDiskMirror()?.getPreservedUnresolvedEntries()
			.find((candidate) => candidate.path === path && candidate.kind === "markdown");
		if (
			!current
			|| !isRemoteDeletePreservedUnresolvedEntry(current)
			|| current.reason !== expected.reason
			|| getPreservedUnresolvedEpisodeId(current)
				!== getPreservedUnresolvedEpisodeId(expected)
		) {
			throw new Error(`Attention state changed for "${path}". Refresh the dashboard.`);
		}
	}

	private assertAuthoritativeMarkdownRemoteDelete(
		path: string,
		expectedFingerprint?: string,
	): void {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) throw new Error("Sync is not initialized.");
		if (expectedFingerprint !== undefined) {
			const snapshot = vaultSync.getAuthoritativeMarkdownDeleteSnapshot?.(path);
			if (!snapshot || snapshot.fingerprint !== expectedFingerprint) {
				throw new Error(`Remote deletion changed for "${path}". Refresh the dashboard.`);
			}
			return;
		}
		const activeFileIds = vaultSync.getActiveFileIdsForPath?.(path)
			?? (vaultSync.getTextForPath(path) ? ["active"] : []);
		// `isPathTombstoned` is the authoritative deleted-path index. The
		// isMarkdownTombstoned fallback keeps lightweight legacy harnesses usable;
		// production VaultSync always supplies isPathTombstoned.
		const deletedPath = typeof vaultSync.isPathTombstoned === "function"
			? vaultSync.isPathTombstoned(path)
			: vaultSync.isMarkdownTombstoned(path);
		if (
			!deletedPath
			|| activeFileIds.length > 0
			|| vaultSync.getTextForPath(path) !== null
		) {
			throw new Error(`Remote deletion is no longer active for "${path}". Refresh the dashboard.`);
		}
	}

	private assertEditorMatchesStableMarkdown(path: string, diskContent: string): void {
		const editorAuthority = this.getOpenEditorAuthority(
			this.getOpenMarkdownViewsForPath(path),
		);
		if (editorAuthority.kind === "multiple") {
			throw new Error(`Multiple open editors disagree for "${path}". Close duplicates and try again.`);
		}
		if (editorAuthority.kind === "read-failed") {
			throw new Error(`Could not read the open editor for "${path}". Close it and try again.`);
		}
		if (
			editorAuthority.kind === "single"
			&& editorAuthority.content !== diskContent
		) {
			throw new Error(`The open editor has unsaved changes for "${path}". Wait for Obsidian to save, then try again.`);
		}
	}

	/**
	 * Destructive Attention actions cannot inspect unsaved state owned by a
	 * non-Markdown file view (notably an open Obsidian Base). Keep the existing
	 * Attention entry actionable and require the user to close that view before
	 * granting or consuming delete authority.
	 */
	assertNoOpaqueOpenFileViewForRemoteDelete(path: string): void {
		const markdownViews = this.getOpenMarkdownViewsForPath(path);
		const hasOpaqueView = getOpenFileViewsForPath(
			this.deps.app.workspace as Parameters<typeof getOpenFileViewsForPath>[0],
			path,
			markdownViews,
		).some((view) => !(view instanceof MarkdownView));
		if (hasOpaqueView) {
			throw new Error(
				`The file view for "${path}" is still open. Close it before accepting the remote delete.`,
			);
		}
	}

	private assertExpectedMarkdownLocalFile(
		path: string,
		expected: MarkdownRemoteDeleteEntryIdentity["localFile"],
		actual: TFile | null,
		stat?: { mtime: number; size: number } | null,
	): void {
		if (!expected) return;
		if (expected.kind === "other") {
			throw new Error(`Attention path is no longer a file: ${path}`);
		}
		if (expected.kind === "missing") {
			if (actual === null) return;
			throw new Error(`Local file changed since the dashboard was opened: ${path}`);
		}
		if (actual === null) {
			throw new Error(`Local file changed since the dashboard was opened: ${path}`);
		}
		const actualStat = stat ?? actual.stat;
		if (
			actualStat.mtime !== expected.mtime
			|| actualStat.size !== expected.size
		) {
			throw new Error(`Local file changed since the dashboard was opened: ${path}`);
		}
	}

	/**
	 * Fence an Accept action before main.ts trashes the local file. The caller
	 * must hold the returned lease across trash + marker persistence and release
	 * it with finishRemoteDeletedMarkdownResolution() in a finally block.
	 */
	async beginAcceptRemoteDeletedMarkdown(
		path: string,
		expectedReason: RemoteDeletePreservedUnresolvedReason,
		expectedEpisode?: MarkdownRemoteDeleteEntryIdentity,
	): Promise<MarkdownRemoteDeleteResolutionLease> {
		if (!this.deps.isMarkdownPathSyncable(path)) {
			throw new Error(`File is no longer in sync scope: ${path}`);
		}
		const capturedEntry = this.findRemoteDeletedMarkdownEntry(
			path,
			expectedReason,
			expectedEpisode,
		);
		this.assertAuthoritativeMarkdownRemoteDelete(
			path,
			expectedEpisode?.remoteDeleteFingerprint,
		);

		const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
		if (abstractFile && !(abstractFile instanceof TFile)) {
			throw new Error(`Attention path is not a file: ${path}`);
		}
		this.assertExpectedMarkdownLocalFile(
			path,
			expectedEpisode?.localFile,
			abstractFile instanceof TFile ? abstractFile : null,
		);
		this.assertNoOpaqueOpenFileViewForRemoteDelete(path);
		const lease = this.acquireMarkdownRemoteDeleteResolution(
			path,
			"accept-remote-delete",
		) as MarkdownRemoteDeleteResolutionLease;
		try {
			if (abstractFile instanceof TFile) {
				const stableRead = await this.readStableMarkdownFile(path, "modify", abstractFile);
				if (stableRead.kind === "unstable") {
					throw new Error(`Local file is still changing: ${path}. Wait a moment and try again.`);
				}
				if (stableRead.kind === "ready") {
					if (stableRead.file.path !== path) {
						throw new Error(`Local file changed path while resolving Attention: ${path}`);
					}
					this.assertEditorMatchesStableMarkdown(path, stableRead.content);
					this.assertExpectedMarkdownLocalFile(
						path,
						expectedEpisode?.localFile,
						stableRead.file,
						stableRead.stat,
					);
				} else if (this.getOpenMarkdownViewsForPath(path).length > 0) {
					throw new Error(`The open editor may contain unsaved changes for "${path}". Close it and try again.`);
				}
			} else if (this.getOpenMarkdownViewsForPath(path).length > 0) {
				throw new Error(`The open editor may contain unsaved changes for "${path}". Close it and try again.`);
			}

			// This is intentionally the final check after every await and before
			// returning authority to call trashFile().
			this.assertNoOpaqueOpenFileViewForRemoteDelete(path);
			this.assertSameRemoteDeletedMarkdownEntry(path, capturedEntry);
			this.assertAuthoritativeMarkdownRemoteDelete(
				path,
				expectedEpisode?.remoteDeleteFingerprint,
			);
			if (this.markdownRemoteDeleteResolutions.get(path) !== lease) {
				throw new Error(`Attention action expired for "${path}". Try again.`);
			}
			return lease;
		} catch (err) {
			this.releaseMarkdownRemoteDeleteResolution(lease);
			throw err;
		}
	}

	async keepLocalRemoteDeletedMarkdown(
		path: string,
		expectedReason: RemoteDeletePreservedUnresolvedReason,
		expectedEpisode?: MarkdownRemoteDeleteEntryIdentity,
	): Promise<void> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const vaultSync = this.deps.getVaultSync();
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync || !diskMirror) {
			throw new Error("Sync is not initialized.");
		}
		if (!this.deps.isMarkdownPathSyncable(path)) {
			throw new Error(`File is no longer in sync scope: ${path}`);
		}

		const entry = this.findRemoteDeletedMarkdownEntry(path, expectedReason, expectedEpisode);
		this.assertAuthoritativeMarkdownRemoteDelete(
			path,
			expectedEpisode?.remoteDeleteFingerprint,
		);

		const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) {
			throw new Error(`Local file not found: ${path}`);
		}
		this.assertExpectedMarkdownLocalFile(
			path,
			expectedEpisode?.localFile,
			abstractFile,
		);
		const lease = this.acquireMarkdownRemoteDeleteResolution(path, "keep-local");
		try {
			this.assertSameRemoteDeletedMarkdownEntry(path, entry);
			this.assertAuthoritativeMarkdownRemoteDelete(
				path,
				expectedEpisode?.remoteDeleteFingerprint,
			);
			const stableRead = await this.readStableMarkdownFile(path, "modify", abstractFile);
			if (stableRead.kind === "missing") {
				throw new Error(`Local file not found: ${path}`);
			}
			if (stableRead.kind === "unstable") {
				throw new Error(`Local file is still changing: ${path}. Wait a moment and try again.`);
			}
			if (stableRead.file.path !== path) {
				throw new Error(`Local file changed path while resolving Attention: ${path}`);
			}
			this.assertExpectedMarkdownLocalFile(
				path,
				expectedEpisode?.localFile,
				stableRead.file,
				stableRead.stat,
			);
			const runtimeConfig = this.deps.getRuntimeConfig();
			if (
				runtimeConfig.maxFileSizeBytes > 0
				&& stableRead.content.length > runtimeConfig.maxFileSizeBytes
			) {
				throw new Error(`File exceeds the configured size limit: ${path}`);
			}

			this.assertEditorMatchesStableMarkdown(path, stableRead.content);

			const previousText = vaultSync.getTextForPath(path);
			const previousContent = previousText ? yTextToString(previousText) ?? "" : null;
			if (this.deps.shouldBlockFrontmatterIngest(
				path,
				previousContent,
				stableRead.content,
				"dashboard-keep-local",
			)) {
				throw new Error(`Local properties are quarantined for "${path}". Review them before keeping this file.`);
			}

			// Final episode + CRDT-state fence after stable-read await and all
			// synchronous policy hooks, immediately before ensureFile mutates Yjs.
			this.assertSameRemoteDeletedMarkdownEntry(path, entry);
			this.assertAuthoritativeMarkdownRemoteDelete(
				path,
				expectedEpisode?.remoteDeleteFingerprint,
			);
			if (this.markdownRemoteDeleteResolutions.get(path) !== lease) {
				throw new Error(`Attention action expired for "${path}". Try again.`);
			}

			const opId = `op-attention-keep-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			let resolvedText: ReturnType<VaultSync["getTextForPath"]> = null;
			const result = vaultSync.serverAckTracker.withActiveOpId(opId, () => {
				const ensureResult = vaultSync.ensureFile(
					path,
					stableRead.content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: true,
						reviveReason: "dashboard-keep-local",
						opId,
					},
				);
				switch (ensureResult.kind) {
					case "created":
					case "existing":
						resolvedText = ensureResult.ytext;
						return applyDiffToYTextWithPostcondition(
							ensureResult.ytext,
							yTextToString(ensureResult.ytext) ?? "",
							stableRead.content,
							ORIGIN_DISK_SYNC,
						);
					case "replan":
						this.deps.log(`keepLocal: "${path}" active set changed, preserving Attention`);
						return null;
					case "blocked":
						this.deps.log(`keepLocal: "${path}" blocked (${ensureResult.reason}), preserving Attention`);
						return null;
					default:
						return assertNever(ensureResult);
				}
			});
			if (!result?.finalMatchesExpected || !resolvedText) {
				throw new Error(`Failed to publish the local content for "${path}".`);
			}

			const baselineSettled = await this.updateDiskIndexForPath(
				path,
				stableRead.content,
				stableRead.stat,
				{
					expectedPreservedUnresolvedEpisodeId: getPreservedUnresolvedEpisodeId(entry),
					expectedDiskFile: stableRead.file,
					expectedYText: resolvedText,
					expectedCrdtContent: stableRead.content,
				},
			);
			if (!baselineSettled) {
				throw new Error(`Local state changed before the baseline settled for "${path}".`);
			}

			let finalDiskContent: string;
			try {
				finalDiskContent = await this.readFreshMarkdownFile(stableRead.file);
			} catch {
				throw new Error(`Local file changed before Attention could be cleared: ${path}`);
			}
			// Do not clear a replacement Attention episode, TFile identity, or CRDT
			// authority that arrived while hashing/persisting the baseline.
			this.assertSameRemoteDeletedMarkdownEntry(path, entry);
			if (
				this.markdownRemoteDeleteResolutions.get(path) !== lease
				|| stableRead.file.path !== path
				|| this.deps.app.vault.getAbstractFileByPath(path) !== stableRead.file
				|| finalDiskContent !== stableRead.content
				|| vaultSync.getTextForPath(path) !== resolvedText
				|| yTextToString(resolvedText) !== stableRead.content
			) {
				throw new Error(`Local state changed before Attention could be cleared: ${path}`);
			}
			diskMirror.clearPreservedUnresolved(path);
			this.deps.onReconciled("dashboard-keep-local");
			this.deps.trace("reconcile", "preserved-unresolved-kept-local", {
				path,
				reason: entry.reason,
				opId,
			});
			this.deps.refreshStatusBar();
		} finally {
			this.releaseMarkdownRemoteDeleteResolution(lease);
		}
	}

	async resolveMarkdownConflictAttention(
		path: string,
		choice: "keep-local" | "use-remote",
		expectedEpisode?: MarkdownConflictEntryIdentity,
	): Promise<void> {
		const normalizedPath = normalizePath(path);
		const vaultSync = this.deps.getVaultSync();
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync || !diskMirror) {
			throw new Error("Sync is not initialized.");
		}
		if (!this.deps.isMarkdownPathSyncable(normalizedPath)) {
			throw new Error(`File is no longer in sync scope: ${normalizedPath}`);
		}

		const entry = this.getPreservedUnresolvedMarkdownEntries()
			.find((candidate) => normalizePath(candidate.path) === normalizedPath);
		if (
			!entry
			|| (expectedEpisode?.episodeId !== undefined && getPreservedUnresolvedEpisodeId(entry) !== expectedEpisode.episodeId)
			|| (expectedEpisode?.reason !== undefined && entry.reason !== expectedEpisode.reason)
		) {
			throw new Error(`Attention state changed for "${normalizedPath}". Refresh the dashboard.`);
		}

		const expectedEpisodeId = getPreservedUnresolvedEpisodeId(entry);
		const episodeIsCurrent = (): boolean => {
			const current = this.getPreservedUnresolvedMarkdownEntries()
				.find((candidate) => normalizePath(candidate.path) === normalizedPath);
			return !!current && getPreservedUnresolvedEpisodeId(current) === expectedEpisodeId;
		};

		if (choice === "keep-local") {
			const abstractFile = this.deps.app.vault.getAbstractFileByPath(normalizedPath);
			if (!(abstractFile instanceof TFile)) {
				throw new Error(`Local file not found: ${normalizedPath}`);
			}
			const stableRead = await this.readStableMarkdownFile(normalizedPath, "modify", abstractFile);
			if (stableRead.kind === "missing") {
				throw new Error(`Local file not found: ${normalizedPath}`);
			}
			if (stableRead.kind === "unstable") {
				throw new Error(`Local file is still changing: ${normalizedPath}. Wait a moment and try again.`);
			}
			if (stableRead.file.path !== normalizedPath) {
				throw new Error(`Local file changed path while resolving Attention: ${normalizedPath}`);
			}

			const runtimeConfig = this.deps.getRuntimeConfig();
			if (
				runtimeConfig.maxFileSizeBytes > 0
				&& stableRead.content.length > runtimeConfig.maxFileSizeBytes
			) {
				throw new Error(`File exceeds the configured size limit: ${normalizedPath}`);
			}

			this.assertEditorMatchesStableMarkdown(normalizedPath, stableRead.content);

			const previousText = vaultSync.getTextForPath(normalizedPath);
			const previousContent = previousText ? yTextToString(previousText) ?? "" : null;
			if (this.deps.shouldBlockFrontmatterIngest(
				normalizedPath,
				previousContent,
				stableRead.content,
				"dashboard-conflict-keep-local",
			)) {
				throw new Error(`Local properties are quarantined for "${normalizedPath}". Review them before keeping this file.`);
			}

			if (!episodeIsCurrent()) {
				throw new Error(`Attention state changed for "${normalizedPath}". Refresh the dashboard.`);
			}

			const opId = `op-conflict-keep-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			let resolvedText: ReturnType<VaultSync["getTextForPath"]> = null;
			const result = vaultSync.serverAckTracker.withActiveOpId(opId, () => {
				const ensureResult = vaultSync.ensureFile(
					normalizedPath,
					stableRead.content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: true,
						reviveReason: "dashboard-conflict-keep-local",
						opId,
					},
				);
				switch (ensureResult.kind) {
					case "created":
					case "existing":
						resolvedText = ensureResult.ytext;
						return applyDiffToYTextWithPostcondition(
							ensureResult.ytext,
							yTextToString(ensureResult.ytext) ?? "",
							stableRead.content,
							ORIGIN_DISK_SYNC,
						);
					case "replan":
					case "blocked":
						return null;
					default:
						return null;
				}
			});
			if (!result?.finalMatchesExpected || !resolvedText) {
				throw new Error(`Failed to publish the local content for "${normalizedPath}".`);
			}

			if (previousContent && previousContent !== stableRead.content) {
				await this.recordDiscardedRevision(
					normalizedPath,
					previousContent,
					"manual-conflict-keep-local",
				);
			}

			const baselineSettled = await this.updateDiskIndexForPath(
				normalizedPath,
				stableRead.content,
				stableRead.stat,
				{
					expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
					expectedDiskFile: stableRead.file,
					expectedYText: resolvedText,
					expectedCrdtContent: stableRead.content,
				},
			);
			if (!baselineSettled) {
				throw new Error(`Local state changed before the baseline settled for "${normalizedPath}".`);
			}

			let finalDiskContent: string;
			try {
				finalDiskContent = await this.readFreshMarkdownFile(stableRead.file);
			} catch {
				throw new Error(`Local file changed before Attention could be cleared: ${normalizedPath}`);
			}
			if (
				!episodeIsCurrent()
				|| stableRead.file.path !== normalizedPath
				|| this.deps.app.vault.getAbstractFileByPath(normalizedPath) !== stableRead.file
				|| finalDiskContent !== stableRead.content
				|| vaultSync.getTextForPath(normalizedPath) !== resolvedText
				|| yTextToString(resolvedText) !== stableRead.content
			) {
				throw new Error(`Local state changed before Attention could be cleared: ${normalizedPath}`);
			}

			diskMirror.clearPreservedUnresolved(normalizedPath);
			this.deps.onReconciled("dashboard-conflict-keep-local");
			this.deps.trace("reconcile", "markdown-conflict-resolved-manual-keep-local", {
				path: normalizedPath,
				reason: entry.reason,
				episodeId: expectedEpisodeId,
				opId,
			});
			this.deps.refreshStatusBar();
		} else if (choice === "use-remote") {
			const existingText = vaultSync.getTextForPath(normalizedPath);
			if (!existingText) {
				throw new Error(`Remote content does not exist for "${normalizedPath}".`);
			}
			const crdtContent = yTextToString(existingText);
			if (crdtContent === null) {
				throw new Error(`Remote content is empty or tombstoned for "${normalizedPath}".`);
			}

			const file = this.deps.app.vault.getAbstractFileByPath(normalizedPath);
			const diskContent = file instanceof TFile
				? await this.readFreshMarkdownFile(file)
				: "";

			if (diskContent && diskContent !== crdtContent) {
				await this.recordDiscardedRevision(
					normalizedPath,
					diskContent,
					"manual-conflict-use-remote",
				);
			}

			const admission = this.captureRemoteProjectionAdmission(diskMirror, [normalizedPath]);
			if (!admission) {
				throw new Error(`Cannot project remote content for "${normalizedPath}": projection paused.`);
			}

			const writeResult = await diskMirror.flushWrite(normalizedPath, false, {
				requireRemoteProjectionAdmission: true,
				remoteProjectionAdmission: admission,
				recordBaseline: true,
				...(file instanceof TFile
					? { expectedDiskContent: diskContent }
					: { allowCreateIfMissing: true }),
				expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
			});
			if (!this.isDiskWriteSettled(writeResult)) {
				this.traceDiskWriteNotSettled(normalizedPath, writeResult, "manual-conflict-use-remote");
				throw new Error(`Failed to write remote content to disk for "${normalizedPath}".`);
			}

			const currentFile = this.deps.app.vault.getAbstractFileByPath(normalizedPath);
			if (currentFile instanceof TFile) {
				const baselineSettled = await this.updateDiskIndexForPath(
					normalizedPath,
					writeResult.content,
					currentFile.stat,
					{
						expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
						expectedDiskFile: currentFile,
					},
				);
				if (!baselineSettled || !episodeIsCurrent()) {
					throw new Error(`Local state changed before Attention could be cleared: ${normalizedPath}`);
				}
			}

			diskMirror.clearPreservedUnresolved(normalizedPath);
			this.deps.onReconciled("dashboard-conflict-use-remote");
			this.deps.trace("reconcile", "markdown-conflict-resolved-manual-use-remote", {
				path: normalizedPath,
				reason: entry.reason,
				episodeId: expectedEpisodeId,
				contentLength: writeResult.content.length,
			});
			this.deps.refreshStatusBar();
		}
	}

	private hasPendingLocalCreate(path: string): boolean {
		if (this.dirtyMarkdownPaths.get(path)?.reason === "create") {
			return true;
		}
		const active = this.activeMarkdownIngests.get(path);
		if (active?.entry.reason === "create") {
			return true;
		}
		for (const ingest of this.activeMarkdownIngests.values()) {
			if (ingest.redirectedTo === path && ingest.entry.reason === "create") {
				return true;
			}
		}
		return false;
	}

	private mergeDirtyEntryIntoPath(path: string, entry: MarkdownDirtyEntry): void {
		this.mergeDirtyMarkdownPath(path, {
			...entry,
			coalescedOpIds: Array.from(new Set(entry.coalescedOpIds)),
		});
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
	}

	private beginActiveMarkdownIngest(path: string, entry: MarkdownDirtyEntry): ActiveMarkdownIngest {
		const active: ActiveMarkdownIngest = {
			path,
			entry,
			redirectedTo: null,
			generation: entry.generation ?? this.getMarkdownIngestGeneration(path),
			diskRevision: this.getMarkdownDiskRevision(path),
		};
		this.activeMarkdownIngests.set(path, active);
		return active;
	}

	private finishActiveMarkdownIngest(active: ActiveMarkdownIngest): void {
		if (this.activeMarkdownIngests.get(active.path) === active) {
			this.activeMarkdownIngests.delete(active.path);
		}
	}

	private shouldAbortActiveMarkdownIngest(active?: ActiveMarkdownIngest): boolean {
		if (!active) return false;
		return !!active.redirectedTo
			|| this.isMarkdownResolutionActive(active.path)
			|| active.generation !== this.getMarkdownIngestGeneration(active.path)
			|| active.diskRevision !== this.getMarkdownDiskRevision(active.path);
	}

	private requeueUnstableMarkdownIngest(
		path: string,
		entry: MarkdownDirtyEntry,
	): void {
		const nextRetry = entry.retryCount + 1;
		if (nextRetry > MARKDOWN_STABLE_READ_MAX_RETRIES) {
			this.deps.log(
				`syncFileFromDisk: skipping "${path}" ` +
				`(stable read did not settle after ${MARKDOWN_STABLE_READ_MAX_RETRIES} retries)`,
			);
			this.deps.trace("reconcile", "markdown-stable-read-abandoned", {
				path,
				reason: entry.reason,
				retryCount: entry.retryCount,
			});
			return;
		}

		this.deps.log(
			`syncFileFromDisk: deferring "${path}" ` +
			`(stable read unavailable, retry ${nextRetry}/${MARKDOWN_STABLE_READ_MAX_RETRIES})`,
		);
		this.deps.trace("reconcile", "markdown-stable-read-retry", {
			path,
			reason: entry.reason,
			retryCount: nextRetry,
		});
		this.queueDirtyMarkdownPath(
			path,
			entry.reason,
			entry.primaryOpId,
			entry.coalescedOpIds,
			nextRetry,
			entry.preservedUnresolvedEpisodeIdAtAdmission,
		);
	}

	/**
	 * Default for tests and lightweight harnesses that do not provide the
	 * production stat/read/stat stable snapshot implementation.
	 */
	private async readStableMarkdownFile(
		path: string,
		reason: MarkdownDirtyReason,
		fallbackFile?: TFile,
	): Promise<StableMarkdownReadResult> {
		if (this.deps.readStableMarkdownFile) {
			return this.deps.readStableMarkdownFile(path, reason);
		}

		const getAbstractFileByPath = (this.deps.app.vault as unknown as {
			getAbstractFileByPath?: (path: string) => unknown;
		}).getAbstractFileByPath;
		const abstractFile = getAbstractFileByPath?.call(this.deps.app.vault, path) ?? fallbackFile;
		if (!(abstractFile instanceof TFile)) {
			return { kind: "missing" };
		}
		const content = await this.readFreshMarkdownFile(abstractFile);
		let stat: { mtime: number; size: number } | null = null;
		try {
			const raw = await this.deps.app.vault.adapter.stat(path);
			stat = raw ? { mtime: raw.mtime, size: raw.size } : null;
		} catch {
			stat = null;
		}
		return { kind: "ready", file: abstractFile, content, stat };
	}

	private readFreshMarkdownFile(file: TFile): Promise<string> {
		return this.deps.readFreshMarkdownFile?.(file) ?? this.deps.app.vault.read(file);
	}

	/**
	 * Redirect any pending dirty entry (create or modify) from oldPath to newPath.
	 *
	 * Called by the rename batch flush callback for every rename in the batch,
	 * regardless of whether the CRDT rename succeeded.
	 *
	 * Two cases:
	 *
	 * Case A — pre-CRDT race (no fileId, rename dropped):
	 *   A pending create for oldPath is redirected to newPath. syncFileFromDisk
	 *   will run ensureFile at newPath, seeding the CRDT entry there.
	 *
	 * Case B — normal rename (fileId existed, CRDT rename succeeded):
	 *   A pending modify for oldPath is redirected to newPath. Without this,
	 *   processDirtyMarkdownPath(oldPath) would find the file gone and skip,
	 *   leaving the CRDT at the pre-modify content even though disk has the
	 *   updated content at newPath.
	 *
	 * Safety:
	 *   - For creates: only redirect if reason === "create" (pre-CRDT race path).
	 *   - For modifies: redirect regardless — a modify at a renamed-away path
	 *     always needs to be re-evaluated at the new path.
	 *   - If newPath is already dirty, merge (never overwrite), preserving
	 *     "create" priority and coalescing op IDs.
	 *   - If no entry exists for oldPath, this is a no-op.
	 */
	redirectPendingDirtyPath(
		oldPath: string,
		newPath: string,
	): PreservedUnresolvedRedirectResult {
		this.invalidateExternalCandidateIdentity(oldPath);
		this.invalidateExternalCandidateIdentity(newPath);
		// Attention ownership follows the filesystem identity. This is deliberately
		// invoked even when no dirty ingest is queued: local rename callbacks are the
		// authoritative opportunity to move a path-scoped unresolved episode.
		// Lightweight harnesses may provide only part of DiskMirror's surface.
		const unresolvedRedirect =
			this.deps.getDiskMirror()?.redirectPreservedUnresolved?.(oldPath, newPath)
			?? { kind: "missing" as const };
		const entry = this.dirtyMarkdownPaths.get(oldPath);
		let redirected = false;
		const deferredAuthority = this.visibleAuthorityDeferredPaths.get(oldPath);
		if (deferredAuthority) {
			this.visibleAuthorityDeferredPaths.delete(oldPath);
			const existingTargetAuthority = this.visibleAuthorityDeferredPaths.get(newPath);
			if (existingTargetAuthority) {
				const editorContents = Array.from(new Set([
					...existingTargetAuthority.editorContents,
					...deferredAuthority.editorContents,
				]));
				this.visibleAuthorityDeferredPaths.set(newPath, {
					...existingTargetAuthority,
					editorContents,
					readComplete:
						existingTargetAuthority.readComplete &&
						deferredAuthority.readComplete &&
						editorContents.length === 1,
					capturedDiskRevision: this.getMarkdownDiskRevision(newPath),
					capturedEditorTicket: null,
					capturedAt: Math.max(
						existingTargetAuthority.capturedAt,
						deferredAuthority.capturedAt,
					),
				});
			} else {
				this.visibleAuthorityDeferredPaths.set(newPath, {
					...deferredAuthority,
					capturedDiskRevision: this.getMarkdownDiskRevision(newPath),
					capturedEditorTicket: null,
				});
			}
			redirected = true;
		}
		if (entry) {
			this.dirtyMarkdownPaths.delete(oldPath);
			this.mergeDirtyEntryIntoPath(newPath, {
				...entry,
				generation: this.getMarkdownIngestGeneration(newPath),
			});
			redirected = true;
		}

		const active = this.activeMarkdownIngests.get(oldPath);
		if (active) {
			active.redirectedTo = newPath;
			this.mergeDirtyEntryIntoPath(newPath, {
				...active.entry,
				generation: this.getMarkdownIngestGeneration(newPath),
			});
			redirected = true;
		}

		if (!redirected) return unresolvedRedirect;

		const label = entry?.reason === "create" || active?.entry.reason === "create"
			? "race recovery"
			: "modify redirect";
		this.deps.log(`redirectPendingDirtyPath: "${oldPath}" -> "${newPath}" (${label})`);
		return unresolvedRedirect;
	}

	/** @deprecated Use redirectPendingDirtyPath. Kept for compatibility during transition. */
	redirectPendingCreate(oldPath: string, newPath: string): void {
		this.redirectPendingDirtyPath(oldPath, newPath);
	}

	/**
	 * Drop a pending dirty entry for path without redirecting.
	 *
	 * Called after an excluded-path tombstone is applied — the dirty entry was
	 * redirected to an excluded path by redirectPendingDirtyPath, but that path
	 * must not be synced. Dropping it prevents the drain from attempting
	 * syncFileFromDisk at an excluded path (which would be a no-op anyway,
	 * but is noisy and unnecessary).
	 */
	dropDirtyPath(path: string): void {
		this.visibleAuthorityDeferredPaths.delete(path);
		this.invalidateExternalCandidateIdentity(path);
		if (this.dirtyMarkdownPaths.delete(path)) {
			this.deps.log(`dropDirtyPath: dropped excluded dirty entry for "${path}"`);
		}
	}

	private scheduleMarkdownDrain(): void {
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
		}
		const delay = this.getNextMarkdownDrainDelayMs();
		this.markdownDrainTimer = setTimeout(() => {
			this.markdownDrainTimer = null;
			const nextDelay = this.getNextMarkdownDrainDelayMs();
			if (nextDelay > 0) {
				this.scheduleMarkdownDrain();
				return;
			}
			this.kickMarkdownDrain();
		}, delay);
	}

	private getNextMarkdownDrainDelayMs(now = Date.now()): number {
		const elapsed = now - this.lastMarkdownDirtyAt;
		const settleDelay = Math.max(0, MARKDOWN_DIRTY_SETTLE_MS - elapsed);
		if (settleDelay > 0) return settleDelay;

		let earliestDeferred: number | null = null;
		let hasReadyEntry = false;
		for (const entry of this.dirtyMarkdownPaths.values()) {
			if (entry.notBeforeMs !== undefined && entry.notBeforeMs > now) {
				earliestDeferred = Math.min(earliestDeferred ?? entry.notBeforeMs, entry.notBeforeMs);
			} else {
				hasReadyEntry = true;
			}
		}
		if (hasReadyEntry || earliestDeferred === null) return 0;
		return Math.max(0, earliestDeferred - now);
	}

	private kickMarkdownDrain(): void {
		if (this.markdownDrainPromise) return;
		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.catch((err) => {
				console.error("[kaos] markdown drain failed:", err);
			})
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					this.scheduleMarkdownDrain();
				}
			});
	}

	private async drainDirtyMarkdownPaths(): Promise<void> {
		if (this.dirtyMarkdownPaths.size === 0) return;
		const now = Date.now();
		const batch: Array<[string, MarkdownDirtyEntry]> = [];
		for (const [path, entry] of this.dirtyMarkdownPaths.entries()) {
			const latestDeferUntil = this.getRecentEditorDirtyDeferUntil(path, entry.reason, now);
			if (latestDeferUntil !== null) {
				entry.notBeforeMs = Math.max(entry.notBeforeMs ?? 0, latestDeferUntil);
			}
			if (entry.notBeforeMs !== undefined && entry.notBeforeMs > now) continue;
			batch.push([path, entry]);
		}
		if (batch.length === 0) return;
		for (const [path] of batch) {
			this.dirtyMarkdownPaths.delete(path);
		}

		for (const [path, entry] of batch) {
			await this.processDirtyMarkdownPath(path, entry);
		}
	}

	private async processDirtyMarkdownPath(
		path: string,
		entry: MarkdownDirtyEntry,
	): Promise<void> {
		if (
			__KAOS_QA_HARNESS_ENABLED__ &&
			this.deps.isDiskIngestSuspendedForQa?.() === true
		) {
			this.deps.trace("qa", "disk-ingest-suspended", {
				path,
				reason: "qa-disk-ingest-suspended",
			});
			return;
		}
		if (
			this.isMarkdownResolutionActive(path)
			|| (
				entry.generation !== undefined
				&& entry.generation !== this.getMarkdownIngestGeneration(path)
			)
		) {
			this.deps.trace("reconcile", "markdown-ingest-cancelled-by-resolution", {
				path,
				reason: entry.reason,
				phase: "before-start",
			});
			return;
		}
		const active = this.beginActiveMarkdownIngest(path, entry);
		try {
			if (this.shouldAbortActiveMarkdownIngest(active)) return;
			const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(abstractFile instanceof TFile)) {
				this.deps.log(`Markdown ${entry.reason}: "${path}" no longer exists, skipping`);
				return;
			}

			const diskMirror = this.deps.getDiskMirror();
			const vaultSync = this.deps.getVaultSync();
			if (entry.reason === "create") {
				if (await diskMirror?.shouldSuppressCreate(abstractFile)) {
					this.deps.log(`Suppressed create event for "${path}"`);
					return;
				}

				if (vaultSync?.isPendingRenameTarget(path)) {
					this.deps.log(`Create: "${path}" is a pending rename target, skipping import`);
					return;
				}
			} else {
				if (await diskMirror?.shouldSuppressModify(abstractFile)) {
					this.deps.log(`Suppressed modify event for "${path}"`);
					return;
				}
			}

			if (this.shouldAbortActiveMarkdownIngest(active)) return;
			await this.syncFileFromDisk(abstractFile, entry, active);
		} finally {
			this.finishActiveMarkdownIngest(active);
		}
	}

	private async syncFileFromDisk(
		file: TFile,
		entryOrReason: MarkdownDirtyEntry | MarkdownDirtyReason = "modify",
		active?: ActiveMarkdownIngest,
	): Promise<void> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const entry: MarkdownDirtyEntry = typeof entryOrReason === "string"
			? {
				reason: entryOrReason,
				primaryOpId: undefined,
				coalescedOpIds: [],
				retryCount: 0,
				generation: this.getMarkdownIngestGeneration(file.path),
			}
			: entryOrReason;
		const sourceReason = entry.reason;
		const opId = entry.primaryOpId;
		const coalescedOpIds = entry.coalescedOpIds;
		const originalPath = file.path;
		const vaultSync = this.deps.getVaultSync();
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (!vaultSync) return;
		if (!this.deps.isMarkdownPathSyncable(originalPath)) return;
		if (this.shouldAbortActiveMarkdownIngest(active)) return;

		try {
			const stableRead = await this.readStableMarkdownFile(originalPath, sourceReason, file);
			if (this.shouldAbortActiveMarkdownIngest(active)) return;
			if (stableRead.kind === "missing") {
				this.deps.log(`syncFileFromDisk: skipping "${originalPath}" (file missing after stable-read wait)`);
				this.deps.trace("reconcile", "markdown-stable-read-missing", {
					path: originalPath,
					reason: sourceReason,
				});
				return;
			}
			if (stableRead.kind === "unstable") {
				this.requeueUnstableMarkdownIngest(originalPath, entry);
				return;
			}

			file = stableRead.file;
			const path = file.path;
			const physicalDiskContent = stableRead.content;
			const stableDiskRevision = this.getMarkdownDiskRevision(path);
			if (!this.deps.isMarkdownPathSyncable(path)) return;
			const editorBindings = this.deps.getEditorBindings();
			const wasBound = editorBindings?.isBound(path) ?? false;
			const openViews = this.getOpenMarkdownViewsForPath(path);
			const isOpenInEditor = openViews.length > 0;
			if (wasBound && !isOpenInEditor) {
				this.deps.trace("trace", "stale-bound-path-without-open-view", {
					path,
				});
				editorBindings?.unbindByPath(path);
				this.deps.log(`syncFileFromDisk: cleared stale bound state for "${path}" (no live view)`);
			}
			// Keep the recovery proof completely off the ordinary ingest path. Apart
			// from avoiding an unnecessary Y.Text lookup, this preserves the single
			// authority snapshot used by normal conflict planning when no intercepted
			// external revision exists.
			const recoveredExternalCandidate = this.interceptedExternalDiskMutations.has(path)
				? await this.findRecoverableExternalAppendOverRecentSelfWrite({
					file,
					physicalDiskContent,
					existingText: vaultSync.getTextForPath(path),
					openViews,
				})
				: null;
			if (recoveredExternalCandidate) {
				this.traceRecoverableExternalAppend(
					"open-external-append-recovered-over-self-write",
					recoveredExternalCandidate,
					physicalDiskContent,
					openViews.length,
				);
			}
			const content = recoveredExternalCandidate?.content ?? physicalDiskContent;

			const externalCandidateAdmission = recoveredExternalCandidate
				? { kind: "preserved" as const }
				: await this.admitStableExternalDiskMutation(path, content);
			if (this.shouldAbortActiveMarkdownIngest(active)) return;
			if (externalCandidateAdmission.kind === "invalidated") {
				this.deps.trace("reconcile", "external-candidate-admission-invalidated", {
					path,
					stage: "dirty-ingest",
				});
				return;
			}

			const diskMirror = this.deps.getDiskMirror();
			const preservedEntry = this.getPreservedUnresolvedMarkdownEntries()
				.find((candidate) => candidate.path === path);
			if (preservedEntry) {
				const currentEpisodeId = getPreservedUnresolvedEpisodeId(preservedEntry);
				const admittedEpisodeId = entry.preservedUnresolvedEpisodeIdAtAdmission;
				const canTreatAsFreshLocalResolution =
					admittedEpisodeId !== undefined && admittedEpisodeId === currentEpisodeId;
				if (
					!canTreatAsFreshLocalResolution ||
					isOpenInEditor ||
					preservedEntry.reason === "path-collision" ||
					preservedEntry.reason === "unknown"
				) {
					this.deps.trace("reconcile", "markdown-dirty-preserved-unresolved-deferred", {
						path,
						reason: preservedEntry.reason,
						currentEpisodeId,
						admittedEpisodeId: admittedEpisodeId ?? null,
						isOpenInEditor,
					});
					return;
				}
				if (
					runtimeConfig.maxFileSizeBytes > 0 &&
					content.length > runtimeConfig.maxFileSizeBytes
				) {
					this.deps.log(
						`syncFileFromDisk: keeping Attention for "${path}" ` +
						`(${Math.round(content.length / 1024)} KB exceeds limit)`,
					);
					return;
				}
				await this.resolvePreservedUnresolvedFromFreshDiskEvent({
					file,
					path,
					content,
					stat: stableRead.stat,
					diskRevision: stableDiskRevision,
					entry: preservedEntry,
					sourceReason,
					opId,
					coalescedOpIds,
					active,
				});
				return;
			}
			if (this.shouldAbortActiveMarkdownIngest(active)) return;

			if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
				this.deps.log(`syncFileFromDisk: skipping "${path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = vaultSync.getTextForPath(path);
			const existingCrdtContent = existingText ? existingText.toJSON() : null;

			const openEditorMismatchDeferUntil = this.getOpenEditorDiskMismatchDeferUntil({
				path,
				sourceReason,
				cameFromDirtyQueue: typeof entryOrReason !== "string",
				diskContent: content,
				crdtContent: existingCrdtContent,
				openViews,
			});
			if (openEditorMismatchDeferUntil !== null) {
				this.deps.log(
					`syncFileFromDisk: deferring "${path}" ` +
					"(open editor is ahead of disk and CRDT; waiting for autosave/binding to settle)",
				);
				this.deps.trace("reconcile", "open-editor-disk-mismatch-deferred", {
					path,
					reason: sourceReason,
					notBeforeMs: openEditorMismatchDeferUntil,
					diskLength: content.length,
					crdtLength: existingCrdtContent?.length ?? null,
					openViewCount: openViews.length,
				});
				this.mergeDirtyEntryIntoPath(path, {
					...entry,
					notBeforeMs: Math.max(entry.notBeforeMs ?? 0, openEditorMismatchDeferUntil),
				});
				return;
			}

			// A live editor is authoritative even during the short interval where
			// its y-codemirror binding is missing or being repaired. Routing only
			// `wasBound` views through the open-file planner let the generic disk
			// importer overwrite the visible editor during that transition.
			if (isOpenInEditor) {
				const interceptedCandidate = this.getMatchingInterceptedExternalDiskMutation(
					path,
					content,
				);
				const boundOutcome = await this.handleBoundFileSyncGap(
					file,
					content,
					existingText,
					openViews,
					sourceReason,
					stableRead.stat,
					() => this.shouldAbortActiveMarkdownIngest(active),
					physicalDiskContent,
				);
				if (this.shouldAbortActiveMarkdownIngest(active)) return;
				if (boundOutcome.kind === "handled") {
					if (boundOutcome.settlement !== undefined) {
						const baselineSettled = await this.updateDiskIndexForPath(
							path,
							boundOutcome.settlement.content,
							stableRead.stat,
							{
								expectedDiskFile: file,
								expectedYText: boundOutcome.settlement.expectedYText,
								expectedCrdtContent: boundOutcome.settlement.expectedCrdtContent,
								expectedEditorTicket: boundOutcome.settlement.expectedEditorTicket,
								expectedOpenEditorContent: boundOutcome.settlement.expectedOpenEditorContent,
							},
						);
						if (baselineSettled) {
							if (interceptedCandidate) {
								const contentHashPrefix =
									this.deps.getDiskIndex()[path]?.contentHash?.slice(0, 12) ?? null;
								this.traceOpenExternalEvent("open-external-disk-settled", {
									path,
									reason: "already-settled",
									contentLength: boundOutcome.settlement.content.length,
									contentHashPrefix,
								});
								this.traceOpenExternalEvent("open-external-baseline-advanced", {
									path,
									reason: "already-settled",
									contentLength: boundOutcome.settlement.content.length,
									contentHashPrefix,
								});
							}
							this.clearInterceptedExternalDiskMutation(interceptedCandidate);
						} else {
							this.mergeDirtyEntryIntoPath(path, {
								...entry,
								notBeforeMs: Math.max(
									entry.notBeforeMs ?? 0,
									Date.now() + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
								),
							});
						}
					}
					return;
				}
				if (boundOutcome.kind === "deferred") {
					this.mergeDirtyEntryIntoPath(path, {
						...entry,
						notBeforeMs: Math.max(entry.notBeforeMs ?? 0, boundOutcome.deferUntil),
					});
					return;
				}
				if (boundOutcome.kind === "flush-crdt-to-disk") {
					const openExternalTraceReason =
						this.getOpenExternalSettlementTraceReason(boundOutcome.reason);
					// DiskMirror's atomic result is now the settlement proof even for a
					// conflict winner; publish it durably instead of leaving a provisional
					// baseline that can block the next remote update.
					const writeResult = await this.flushWithOpenAuthorityLease(
						diskMirror,
						path,
						physicalDiskContent,
						boundOutcome.authorityLease,
					);
					if (!this.isDiskWriteSettled(writeResult)) {
						this.traceDiskWriteNotSettled(path, writeResult, boundOutcome.reason);
						this.requestFollowupForUnsettledDiskWrite(
							path,
							writeResult,
							boundOutcome.reason,
						);
						if (writeResult?.kind === "deferred") {
							this.mergeDirtyEntryIntoPath(path, {
								...entry,
								notBeforeMs: Date.now() + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
							});
						}
						if (boundOutcome.provisionalBaseline) {
							diskMirror?.recordPreservedUnresolved(
								path,
								"conflict-winner-flush-deferred",
							);
						}
					} else {
						if (openExternalTraceReason !== null) {
							this.traceOpenExternalEvent("open-external-disk-settled", {
								path,
								reason: openExternalTraceReason,
								contentLength: writeResult.content.length,
								contentHashPrefix: writeResult.contentHash.slice(0, 12),
							});
						}
						// Even provisional conflict winners are settled once DiskMirror's
						// compare-and-swap succeeds. Record the exact committed snapshot,
						// never a later live Y.Text value.
						const baselineSettled = await this.updateDiskIndexForPath(
							path,
							writeResult.content,
						);
						if (baselineSettled) {
							if (openExternalTraceReason !== null) {
								this.traceOpenExternalEvent("open-external-baseline-advanced", {
									path,
									reason: openExternalTraceReason,
									contentLength: writeResult.content.length,
									contentHashPrefix: writeResult.contentHash.slice(0, 12),
								});
							}
							this.clearInterceptedExternalDiskMutation(interceptedCandidate);
						}
					}
					return;
				}
			}

			if (existingText) {
				const crdtContent = existingText.toJSON();
				const visibleDecision = this.decideDeferredVisibleAuthority(
					path,
					content,
					crdtContent,
				);
				if (visibleDecision.kind === "unresolved") {
					await this.preserveUnresolvedVisibleAuthority(
						path,
						visibleDecision.marker,
						content,
						crdtContent,
						"closed-dirty",
					);
					this.requestReconciliationFollowup(path, "closed-dirty-visible-authority-unmatched");
					return;
				}
				if (visibleDecision.kind === "disk-wins") {
					await this.recordDiscardedRevision(
						path,
						crdtContent,
						"closed-dirty-visible-authority-disk-wins",
					);
					const diskWinnerCommit = await this.commitClosedFileReconcileMutation({
						path,
						file,
						expectedYText: existingText,
						expectedDiskContent: content,
						expectedCrdtContent: crdtContent,
						expectedDiskRevision: stableDiskRevision,
						stage: "closed-dirty-visible-authority-disk-wins",
						commit: () => applyDiffToYTextWithPostcondition(
							existingText,
							crdtContent,
							content,
							ORIGIN_DISK_SYNC_RECOVER_BOUND,
						),
					});
					if (diskWinnerCommit.kind === "stale") {
						this.requestReconciliationFollowup(path, "closed-dirty-visible-authority-stale");
						return;
					}
					const baselineSettled = await this.updateDiskIndexForPath(
						path,
						content,
						stableRead.stat,
						{
							expectedDiskFile: file,
							expectedYText: existingText,
							expectedCrdtContent: content,
						},
					);
					if (!baselineSettled) {
						this.requestReconciliationFollowup(
							path,
							"closed-dirty-visible-authority-baseline-stale",
						);
					}
					return;
				}
				if (visibleDecision.kind === "crdt-wins") {
					await this.recordDiscardedRevision(
						path,
						content,
						"closed-dirty-visible-authority-crdt-wins",
					);
					const crdtWinnerAdmission = await this.commitClosedFileReconcileMutation({
						path,
						file,
						expectedYText: existingText,
						expectedDiskContent: content,
						expectedCrdtContent: crdtContent,
						expectedDiskRevision: stableDiskRevision,
						stage: "closed-dirty-visible-authority-crdt-wins",
						commit: () => undefined,
					});
					if (crdtWinnerAdmission.kind === "stale") {
						this.requestReconciliationFollowup(path, "closed-dirty-visible-authority-stale");
						return;
					}
					const remoteProjectionAdmission = diskMirror
						? this.captureRemoteProjectionAdmission(diskMirror, [path])
						: null;
					const writeResult = diskMirror && remoteProjectionAdmission
						? await diskMirror.flushWrite(path, true, {
							requireRemoteProjectionAdmission: true,
							remoteProjectionAdmission,
							recordBaseline: true,
							expectedDiskContent: content,
						})
						: {
							kind: "deferred" as const,
							path,
							reason: "remote-projection-not-ready" as const,
						};
					if (this.isDiskWriteSettled(writeResult)) {
						await this.updateDiskIndexForPath(path, writeResult.content);
					} else {
						this.traceDiskWriteNotSettled(
							path,
							writeResult,
							"closed-dirty-visible-authority-crdt-wins",
						);
						this.requestFollowupForUnsettledDiskWrite(
							path,
							writeResult,
							"closed-dirty-visible-authority-crdt-wins",
						);
					}
					return;
				}
				if (crdtContent === content) {
					// The dirty event may have been queued while the editor was open but
					// drained only after close. Equality still proves the autosaved local
					// edit is the new clean baseline; returning without it leaves the old
					// baseline and can block or reverse the next remote update.
					await this.updateDiskIndexForPath(path, content, stableRead.stat);
					// recovery.skipped: CRDT and disk already agree (unbound second-pass no-op).
					this.deps.recordFlightPathEvent?.({
						priority: "verbose",
						kind: PRODUCT_EVENT_KIND.recoverySkipped,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "recovery",
						path,
						data: {
							reason: "crdt-current-no-op",
							wasBound: false,
						},
					});
					return;
				}

				// A queued open-file event may drain only after the note closes. Never
				// turn that timing change into an unconditional disk→CRDT import. Use
				// the durable three-way baseline: only a disk-only change is importable;
				// a CRDT-only change writes back with CAS, while missing/both-changed
				// evidence is handed to the full conflict-preserving planner.
				const baselineHash = this.deps.getDiskIndex()[path]?.contentHash ?? null;
				const diskHash = await contentBaselineHash(content);
				const crdtHash = await contentBaselineHash(crdtContent);
				const diskChanged = baselineHash === null ? true : diskHash !== baselineHash;
				const crdtChanged = baselineHash === null ? false : crdtHash !== baselineHash;
				if (baselineHash !== null && !diskChanged && crdtChanged) {
					const remoteProjectionAdmission = diskMirror
						? this.captureRemoteProjectionAdmission(diskMirror, [path])
						: null;
					const writeResult = diskMirror && remoteProjectionAdmission
						? await diskMirror.flushWrite(path, true, {
							requireRemoteProjectionAdmission: true,
							remoteProjectionAdmission,
							recordBaseline: true,
							expectedDiskContent: content,
						})
						: {
							kind: "deferred" as const,
							path,
							reason: "remote-projection-not-ready" as const,
						};
					if (this.isDiskWriteSettled(writeResult)) {
						await this.updateDiskIndexForPath(path, writeResult.content);
					} else {
						this.traceDiskWriteNotSettled(path, writeResult, "closed-dirty-crdt-wins");
						this.requestFollowupForUnsettledDiskWrite(
							path,
							writeResult,
							"closed-dirty-crdt-wins",
						);
					}
					return;
				}
				if (baselineHash !== null && diskChanged && crdtChanged) {
					this.requestReconciliationFollowup(path, "closed-dirty-both-changed");
					return;
				}
				if (baselineHash !== null && !diskChanged && !crdtChanged) {
					// Hash equality with a text mismatch is practically impossible; refuse
					// mutation if it ever occurs rather than trusting a contradictory state.
					this.requestReconciliationFollowup(path, "closed-dirty-hash-contradiction");
					return;
				}
				// diskChanged && !crdtChanged: disk is the sole changed side and the
				// existing guarded import below is safe to execute.
				if (
					vaultSync.getTextForPath(path) !== existingText ||
					existingText.toJSON() !== crdtContent
				) {
					this.requestReconciliationFollowup(path, "closed-dirty-crdt-advanced-before-import");
					return;
				}
				if (this.deps.shouldBlockFrontmatterIngest(
					path,
					crdtContent,
					content,
					"disk-to-crdt",
				)) {
					this.recordFrontmatterIngestBlocked(path, false, "disk-to-crdt-existing");
					await this.updateDiskIndexForPath(path, undefined, stableRead.stat);
					return;
				}

				this.deps.log(
					`syncFileFromDisk: applying diff to "${path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				if (this.shouldAbortActiveMarkdownIngest(active)) return;
				const importCommit = await this.commitClosedFileReconcileMutation({
					path,
					file,
					expectedYText: existingText,
					expectedDiskContent: content,
					expectedCrdtContent: crdtContent,
					expectedDiskRevision: stableDiskRevision,
					stage: "open-unbound-disk-to-crdt",
					commit: () => vaultSync.serverAckTracker.withActiveOpId(opId, () => {
						applyDiffToYText(existingText, crdtContent, content, ORIGIN_DISK_SYNC);
					}),
				});
				if (importCommit.kind === "stale") {
					this.requestReconciliationFollowup(
						path,
						"closed-dirty-disk-import-stale",
					);
					return;
				}
				// Emit crdt.file.updated with the same opId that triggered this disk→CRDT write.
				const fileId = vaultSync.getFileIdForText(existingText) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.crdtFileUpdated,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "crdt",
					path,
					opId,
					data: {
						fileId,
						originKind: "disk-sync",
						...(coalescedOpIds && coalescedOpIds.length > 1 ? { coalescedOpIds } : {}),
					},
				});
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					this.recordFrontmatterIngestBlocked(path, false, "disk-to-crdt-seed");
					await this.updateDiskIndexForPath(path, undefined, stableRead.stat);
					return;
				}
				if (this.shouldAbortActiveMarkdownIngest(active)) return;
				const seedCommit = await this.commitClosedFileReconcileMutation({
					path,
					file,
					expectedYText: null,
					expectedDiskContent: content,
					expectedCrdtContent: null,
					expectedDiskRevision: stableDiskRevision,
					stage: "open-unbound-disk-seed",
					commit: () => vaultSync.serverAckTracker.withActiveOpId(opId, () =>
						vaultSync.ensureFile(
							path,
							content,
							this.deps.getSettings().deviceName,
							{
								reviveTombstone: sourceReason === "create",
								reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
								opId,
							},
						),
					),
				});
				if (seedCommit.kind === "stale") {
					this.requestReconciliationFollowup(
						path,
						"closed-dirty-disk-seed-stale",
					);
					return;
				}
				switch (seedCommit.value.kind) {
					case "created":
					case "existing":
						if (yTextToString(seedCommit.value.ytext) !== content) {
							this.requestReconciliationFollowup(
								path,
								"closed-dirty-disk-seed-content-changed",
							);
							return;
						}
						break;
					case "replan":
						this.requestReconciliationFollowup(path, "closed-dirty-disk-seed-replan");
						return;
					case "blocked":
						this.requestReconciliationFollowup(
							path,
							`closed-dirty-disk-seed-blocked-${seedCommit.value.reason}`,
						);
						return;
					default:
						assertNever(seedCommit.value);
				}
			}

			const settledYText = vaultSync.getTextForPath(path);
			const baselineSettled = await this.updateDiskIndexForPath(
				path,
				content,
				stableRead.stat,
				{
					expectedDiskFile: file,
					expectedYText: settledYText,
					expectedCrdtContent: content,
				},
			);
			if (!baselineSettled) {
				this.requestReconciliationFollowup(
					path,
					"closed-dirty-disk-import-baseline-stale",
				);
			}
		} catch (err) {
			console.error(`[kaos] syncFileFromDisk failed for "${originalPath}":`, err);
		}
	}

	/**
	 * Resolve an Attention episode only from a real vault event that was admitted
	 * after that exact episode already existed. The event is merely evidence of
	 * user intent; the marker is cleared only after loser preservation, exact
	 * disk/Y.Text CAS, postcondition, and durable baseline settlement all succeed.
	 */
	private async resolvePreservedUnresolvedFromFreshDiskEvent(input: {
		file: TFile;
		path: string;
		content: string;
		stat: { mtime: number; size: number } | null;
		diskRevision: number;
		entry: PreservedUnresolvedEntry;
		sourceReason: MarkdownDirtyReason;
		opId?: string;
		coalescedOpIds: string[];
		active?: ActiveMarkdownIngest;
	}): Promise<void> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const {
			file,
			path,
			content,
			stat,
			diskRevision,
			entry,
			sourceReason,
			opId,
			coalescedOpIds,
			active,
		} = input;
		const diskMirror = this.deps.getDiskMirror();
		const vaultSync = this.deps.getVaultSync();
		if (!diskMirror || !vaultSync) return;

		const expectedEpisodeId = getPreservedUnresolvedEpisodeId(entry);
		const episodeIsCurrent = (): boolean => {
			const current = this.getPreservedUnresolvedMarkdownEntries()
				.find((candidate) => candidate.path === path);
			return !!current && getPreservedUnresolvedEpisodeId(current) === expectedEpisodeId;
		};
		if (!episodeIsCurrent() || this.shouldAbortActiveMarkdownIngest(active)) return;

		const existingText = vaultSync.getTextForPath(path);
		const existingCrdtContent = yTextToString(existingText);
		if (!existingText && !isRemoteDeletePreservedUnresolvedEntry(entry)) {
			// A generic structural/path episode cannot authorize a new CRDT identity.
			this.deps.trace("reconcile", "preserved-unresolved-local-resolution-deferred", {
				path,
				reason: entry.reason,
				stage: "missing-active-ytext",
			});
			return;
		}

		if (this.deps.shouldBlockFrontmatterIngest(
			path,
			existingCrdtContent,
			content,
			existingText ? "disk-to-crdt" : "disk-to-crdt-seed",
		)) {
			this.recordFrontmatterIngestBlocked(
				path,
				false,
				existingText ? "disk-to-crdt-existing" : "disk-to-crdt-seed",
			);
			return;
		}

		if (existingText && existingCrdtContent !== content) {
			// A fresh disk event is evidence of local intent for the disk side,
			// not proof that the CRDT side is stale. When a durable baseline
			// exists, a CRDT side that diverged from it can carry edits that
			// were never flushed to disk (the path is fenced, so reconcile
			// skips it) — remote-device typing or pre-close local work.
			// Silently discarding that side is the open-editor data-loss shape,
			// so such an episode stays fenced for the operator instead.
			// With no baseline there is no divergence evidence to protect and
			// the fresh disk event remains the newest known intent.
			const baselineHash = this.deps.getDiskIndex()[path]?.contentHash ?? null;
			const crdtHash = existingCrdtContent === null
				? null
				: await contentBaselineHash(existingCrdtContent);
			if (baselineHash !== null && crdtHash !== baselineHash) {
				this.deps.trace("reconcile", "preserved-unresolved-local-resolution-crdt-diverged", {
					path,
					reason: entry.reason,
					episodeId: expectedEpisodeId,
					baselineHashPrefix: baselineHash.slice(0, 12),
					crdtHashPrefix: crdtHash?.slice(0, 12) ?? null,
				});
				return;
			}
			await this.recordDiscardedRevision(
				path,
				existingCrdtContent ?? "",
				"preserved-unresolved-fresh-local-event",
			);
		}

		if (!episodeIsCurrent() || this.shouldAbortActiveMarkdownIngest(active)) return;
		const mutationAttempt = await this.commitClosedFileReconcileMutation({
			path,
			file,
			expectedYText: existingText,
			expectedDiskContent: content,
			expectedCrdtContent: existingCrdtContent,
			expectedDiskRevision: diskRevision,
			expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
			stage: "preserved-unresolved-fresh-local-event",
			commit: () => {
				let finalText = existingText;
				let finalMatchesExpected = existingCrdtContent === content;
				if (existingText) {
					const result = vaultSync.serverAckTracker.withActiveOpId(opId, () =>
						applyDiffToYTextWithPostcondition(
							existingText,
							existingCrdtContent ?? "",
							content,
							ORIGIN_DISK_SYNC,
						),
					);
					finalMatchesExpected = result.finalMatchesExpected;
				} else {
					const ensureResult = vaultSync.serverAckTracker.withActiveOpId(opId, () =>
						vaultSync.ensureFile(
							path,
							content,
							this.deps.getSettings().deviceName,
							{
								reviveTombstone: true,
								reviveReason: sourceReason === "create"
									? "local-create-event"
									: "local-modify-after-attention",
								opId,
							},
						),
					);
					switch (ensureResult.kind) {
						case "created":
						case "existing":
							finalText = ensureResult.ytext;
							finalMatchesExpected = yTextToString(finalText) === content;
							break;
						case "replan":
							finalText = null;
							finalMatchesExpected = false;
							break;
						case "blocked":
							this.deps.log(
								`preservedUnresolved: "${path}" admission blocked (${ensureResult.reason})`,
							);
							finalText = null;
							finalMatchesExpected = false;
							break;
						default:
							assertNever(ensureResult);
					}
				}
				return { finalText, finalMatchesExpected };
			},
		});
		if (mutationAttempt.kind === "stale") return;
		const { finalText, finalMatchesExpected } = mutationAttempt.value;
		if (!finalText || !finalMatchesExpected || !episodeIsCurrent()) return;

		const baselineSettled = await this.updateDiskIndexForPath(path, content, stat, {
			expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
			expectedDiskFile: file,
			expectedYText: finalText,
			expectedCrdtContent: content,
		});
		if (!baselineSettled || !episodeIsCurrent()) return;

		let finalDiskContent: string;
		try {
			finalDiskContent = await this.readFreshMarkdownFile(file);
		} catch {
			return;
		}
		if (
			file.path !== path ||
			this.deps.app.vault.getAbstractFileByPath(path) !== file ||
			finalDiskContent !== content ||
			vaultSync.getTextForPath(path) !== finalText ||
			yTextToString(finalText) !== content ||
			!episodeIsCurrent()
		) {
			return;
		}

		// No await between the episode equality check and resolution: a replacement
		// episode cannot interleave on the JavaScript event loop.
		diskMirror.clearPreservedUnresolved(path);
		this.deps.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.crdtFileUpdated,
			severity: "info",
			scope: "file",
			source: "reconciliationController",
			layer: "crdt",
			path,
			opId,
			data: {
				originKind: "disk-sync-attention-resolution",
				...(coalescedOpIds.length > 1 ? { coalescedOpIds } : {}),
			},
		});
		this.deps.trace("reconcile", "preserved-unresolved-resolved-by-fresh-local-event", {
			path,
			reason: entry.reason,
			episodeId: expectedEpisodeId,
			contentLength: content.length,
		});
	}

	/**
	 * Reconcile-time heal pass for fenced conflict-winner-flush-deferred
	 * episodes on closed files.
	 *
	 * Such an episode records that a conflict winner was chosen but its commit
	 * never settled (typically an open editor or a CAS race at decision time).
	 * Reconcile otherwise skips the path forever, so later disk writes never
	 * reach the CRDT and later CRDT edits never reach disk — the frozen
	 * divergence shows up on other devices as missing or stubbed-out content.
	 *
	 * Only provably lossless cases heal here, each requiring one side to still
	 * match the durable baseline exactly:
	 *  - both sides now equal → divergence vanished: settle and clear.
	 *  - CRDT still at baseline → the disk side is newer: route through the
	 *    guarded fresh-event resolver (its own CAS chain commits).
	 *  - disk still at baseline → the deferred CRDT-wins winner flush can be
	 *    completed without losing anything.
	 * Anything else (both sides moved, missing baseline, tombstoned CRDT,
	 * open editor) keeps the episode fenced for the operator.
	 *
	 * Returns true only when the episode was actually cleared.
	 */
	private async tryHealFencedConflictWinnerFlush(
		path: string,
		diskContent: string,
	): Promise<boolean> {
		const diskMirror = this.deps.getDiskMirror();
		const vaultSync = this.deps.getVaultSync();
		if (!diskMirror || !vaultSync) return false;
		const entry = this.getPreservedUnresolvedMarkdownEntries()
			.find((candidate) => candidate.path === path);
		if (!entry || entry.reason !== "conflict-winner-flush-deferred") return false;

		if (this.getOpenMarkdownViewsForPath(path).length > 0) return false;
		if (this.deps.getEditorBindings()?.isBound(path) ?? false) return false;

		const runtimeConfig = this.deps.getRuntimeConfig();
		if (
			runtimeConfig.maxFileSizeBytes > 0 &&
			diskContent.length > runtimeConfig.maxFileSizeBytes
		) {
			return false;
		}

		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;

		const expectedEpisodeId = getPreservedUnresolvedEpisodeId(entry);
		const episodeIsCurrent = (): boolean => {
			const current = this.getPreservedUnresolvedMarkdownEntries()
				.find((candidate) => candidate.path === path);
			return !!current && getPreservedUnresolvedEpisodeId(current) === expectedEpisodeId;
		};

		const existingText = vaultSync.getTextForPath(path);
		if (!existingText) return false;
		const existingCrdtContent = yTextToString(existingText);

		if (existingCrdtContent === diskContent) {
			const baselineSettled = await this.updateDiskIndexForPath(
				path,
				diskContent,
				file.stat,
				{
					expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
					expectedDiskFile: file,
					expectedYText: existingText,
					expectedCrdtContent: diskContent,
				},
			);
			if (!baselineSettled || !episodeIsCurrent()) return false;
			diskMirror.clearPreservedUnresolved(path);
			this.deps.trace("reconcile", "fenced-conflict-winner-healed-equal", {
				path,
				episodeId: expectedEpisodeId,
				contentLength: diskContent.length,
			});
			return true;
		}

		const baselineHash = this.deps.getDiskIndex()[path]?.contentHash ?? null;
		const crdtHash = existingCrdtContent === null
			? null
			: await contentBaselineHash(existingCrdtContent);
		const diskHash = await contentBaselineHash(diskContent);

		if (baselineHash !== null && crdtHash === baselineHash) {
			await this.resolvePreservedUnresolvedFromFreshDiskEvent({
				file,
				path,
				content: diskContent,
				stat: file.stat,
				diskRevision: this.getMarkdownDiskRevision(path),
				entry,
				sourceReason: "modify",
				opId: undefined,
				coalescedOpIds: [],
			});
			return !this.isMarkdownPreservedUnresolved(path);
		}

		if (baselineHash !== null && diskHash === baselineHash) {
			const admission = this.captureRemoteProjectionAdmission(diskMirror, [path]);
			if (!admission) {
				this.deps.trace("reconcile", "fenced-conflict-winner-heal-held", {
					path,
					stage: "projection-admission",
				});
				return false;
			}
			const writeResult = await diskMirror.flushWrite(path, false, {
				requireRemoteProjectionAdmission: true,
				remoteProjectionAdmission: admission,
				recordBaseline: true,
				expectedDiskContent: diskContent,
				expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
			});
			if (!this.isDiskWriteSettled(writeResult)) {
				this.traceDiskWriteNotSettled(path, writeResult, "fenced-conflict-winner-heal");
				this.requestFollowupForUnsettledDiskWrite(path, writeResult, "fenced-conflict-winner-heal");
				return false;
			}
			// The settled write result is the ground truth even when live
			// Y.Text advanced during the write (the closed-file flush loop
			// records the committed snapshot, never the later live text). A
			// racing CRDT advance then flows through the normal lane next
			// pass instead of being re-fenced here.
			const baselineSettled = await this.updateDiskIndexForPath(
				path,
				writeResult.content,
				file.stat,
				{
					expectedPreservedUnresolvedEpisodeId: expectedEpisodeId,
					expectedDiskFile: file,
				},
			);
			if (!baselineSettled || !episodeIsCurrent()) return false;
			diskMirror.clearPreservedUnresolved(path);
			this.deps.trace("reconcile", "fenced-conflict-winner-healed-flush", {
				path,
				episodeId: expectedEpisodeId,
				contentLength: writeResult.content.length,
				contentHashPrefix: writeResult.contentHash.slice(0, 12),
			});
			return true;
		}

		this.deps.trace("reconcile", "fenced-conflict-winner-kept-ambiguous", {
			path,
			episodeId: expectedEpisodeId,
			baselineHashPrefix: baselineHash?.slice(0, 12) ?? null,
			crdtHashPrefix: crdtHash?.slice(0, 12) ?? null,
			diskHashPrefix: diskHash.slice(0, 12),
		});
		return false;
	}

	private getOpenMarkdownViewsForPath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		const activeView = (this.deps.app.workspace as {
			getActiveViewOfType?: <T>(type: abstract new (...args: never[]) => T) => T | null;
		}).getActiveViewOfType?.(MarkdownView) ?? null;
		if (activeView?.file?.path === path) {
			views.push(activeView);
		}

		const workspace = this.deps.app.workspace as {
			iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
		};
		workspace.iterateAllLeaves?.((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file?.path === path
				&& !views.includes(leaf.view)
			) {
				views.push(leaf.view);
			}
		});
		return views;
	}

	private captureOpenEditorMutationTicket(
		path: string,
		openViews: readonly MarkdownView[],
	): OpenEditorMutationTicket | null {
		if (openViews.length === 0) return null;
		const editorBindings = this.deps.getEditorBindings();
		return editorBindings?.captureOpenEditorMutationTicket?.(path, openViews) ?? null;
	}

	/**
	 * Deferred markers can outlive an editor tab. Retain only stable primitive
	 * lineage fields so a marker never keeps MarkdownView, EditorView, DOM, or a
	 * CodeMirror document tree alive after that tab closes.
	 */
	private compactVisibleAuthorityTicket(
		ticket: OpenEditorMutationTicket | null,
	): VisibleAuthorityLineageTicket | null {
		if (!ticket) return null;
		return {
			path: ticket.path,
			views: ticket.views.map((snapshot) => ({
				viewId: snapshot.viewId,
				leafId: snapshot.leafId,
				cmId: snapshot.cmId,
				bindingEpoch: snapshot.bindingEpoch,
				editorRevision: snapshot.editorRevision,
				editorAuthorityRevision: snapshot.editorAuthorityRevision,
				editorAuthorityContent: snapshot.editorAuthorityContent,
				editorContent: snapshot.editorContent,
			})),
		};
	}

	/**
	 * Decide whether a fresh visible document is a genuine successor produced
	 * by the same editor lineage. General CodeMirror revisions are insufficient:
	 * provider/Y.Text patches advance them too. The authority revision advances
	 * only for user or programmatic editor-origin transactions.
	 */
	private classifyVisibleAuthorityTicketProgress(
		previous: VisibleAuthorityLineageTicket | null,
		current: VisibleAuthorityLineageTicket | null,
		currentEditorContents: readonly string[],
		currentReadComplete: boolean,
	): VisibleAuthorityTicketProgress {
		const result = (
			kind: VisibleAuthorityTicketProgressKind,
			advancedEditorContents: Iterable<string> = [],
			supersedesPreviousSingle = false,
			provenNoEditorAuthorityAdvance = false,
		): VisibleAuthorityTicketProgress => ({
			kind,
			advancedEditorContents: Array.from(new Set(advancedEditorContents)),
			supersedesPreviousSingle,
			provenNoEditorAuthorityAdvance,
		});
		if (!previous || !current) return result("unavailable");
		if (
			!currentReadComplete ||
			currentEditorContents.length !== 1 ||
			previous.path !== current.path ||
			previous.views.length !== current.views.length
		) {
			return result("incompatible");
		}

		const currentAuthority = currentEditorContents[0]!;
		const previousByLeafId = new Map(
			previous.views.map((snapshot) => [snapshot.leafId, snapshot] as const),
		);
		if (previousByLeafId.size !== previous.views.length) return result("incompatible");

		let authorityRevisionAdvanced = false;
		let authorityContentMatchesCurrent = true;
		let cmLineageUnavailable = false;
		const advancedEditorContents = new Set<string>();
		for (const snapshot of current.views) {
			const earlier = previousByLeafId.get(snapshot.leafId);
			if (
				!earlier ||
				earlier.viewId !== snapshot.viewId ||
				earlier.bindingEpoch !== snapshot.bindingEpoch
			) {
				return result("incompatible");
			}
			const snapshotCmLineageUnavailable =
				earlier.cmId === null || snapshot.cmId === null;
			if (snapshotCmLineageUnavailable) {
				cmLineageUnavailable = true;
			} else if (earlier.cmId !== snapshot.cmId) {
				return result("incompatible");
			}
			if (snapshot.editorContent !== currentAuthority) {
				return result("incompatible");
			}
			if (snapshotCmLineageUnavailable) {
				// Revision zero is only a placeholder when CM resolution fails. Do not
				// mistake it for a lineage rollback and disable the activity fallback.
				continue;
			}
			if (
				typeof earlier.editorAuthorityRevision !== "number" ||
				typeof snapshot.editorAuthorityRevision !== "number"
			) {
				return result("unavailable", advancedEditorContents);
			}
			if (
				snapshot.editorRevision < earlier.editorRevision ||
				snapshot.editorAuthorityRevision < earlier.editorAuthorityRevision
			) {
				return result("incompatible");
			}
			if (snapshot.editorAuthorityRevision > earlier.editorAuthorityRevision) {
				authorityRevisionAdvanced = true;
				if (snapshot.editorAuthorityContent !== null) {
					advancedEditorContents.add(snapshot.editorAuthorityContent);
				}
				if (snapshot.editorAuthorityContent !== currentAuthority) {
					// A local edit occurred, but a later provider patch is what is now
					// visible. Return its exact ticket snapshot so callers preserve B in
					// A -> B(local) -> C(provider), rather than retaining only A and C.
					authorityContentMatchesCurrent = false;
				}
			}
		}

		if (!authorityContentMatchesCurrent) {
			return result(
				"not-successor",
				advancedEditorContents,
				!cmLineageUnavailable && advancedEditorContents.size > 0,
			);
		}
		if (cmLineageUnavailable) {
			// Same view/binding lineage with a temporarily unresolved CM may still use
			// the path-scoped user-activity fallback. A replaced view was rejected above.
			return result("unavailable", advancedEditorContents);
		}
		return result(
			authorityRevisionAdvanced ? "successor" : "not-successor",
			advancedEditorContents,
			authorityRevisionAdvanced && advancedEditorContents.size > 0,
			!authorityRevisionAdvanced,
		);
	}

	private getRetainedVisibleAuthorityContents(
		marker: DeferredVisibleEditorAuthority | undefined,
		progress: VisibleAuthorityTicketProgress,
	): string[] {
		if (!marker) return [];
		if (
			progress.supersedesPreviousSingle &&
			marker.readComplete &&
			marker.editorContents.length === 1
		) {
			return [];
		}
		return marker.editorContents;
	}

	/**
	 * A complete single editor snapshot that already matched Y.Text when it was
	 * captured is not a fourth authority. It is only a visible alias of the CRDT
	 * bytes. The marker still matters until re-plan because its lineage ticket can
	 * reveal an editor-origin transaction that happened after dirty admission.
	 */
	private isCapturedCrdtAlias(
		marker: DeferredVisibleEditorAuthority,
	): boolean {
		return (
			marker.readComplete &&
			marker.editorContents.length === 1 &&
			marker.capturedCrdtContent !== null &&
			marker.editorContents[0] === marker.capturedCrdtContent
		);
	}

	/**
	 * Consecutive Vault writes can project a new Y.Text value into the same open
	 * editor before the first dirty event drains. Replace the older CRDT alias
	 * instead of accumulating both projections as independent editor candidates.
	 * Exact editor-origin snapshots reported between the tickets still veto this.
	 */
	private canRecaptureCrdtAliasProjection(input: {
		previous: DeferredVisibleEditorAuthority | undefined;
		progress: VisibleAuthorityTicketProgress;
		currentEditorContents: readonly string[];
		currentReadComplete: boolean;
		currentCrdtContent: string | null;
	}): boolean {
		return (
			input.previous !== undefined &&
			this.isCapturedCrdtAlias(input.previous) &&
			input.currentReadComplete &&
			input.currentEditorContents.length === 1 &&
			input.currentCrdtContent !== null &&
			input.currentEditorContents[0] === input.currentCrdtContent &&
			input.progress.advancedEditorContents.length === 0 &&
			input.progress.provenNoEditorAuthorityAdvance
		);
	}

	private retireCapturedCrdtAlias(
		path: string,
		marker: DeferredVisibleEditorAuthority,
		stage: string,
	): void {
		if (this.visibleAuthorityDeferredPaths.get(path) !== marker) return;
		this.visibleAuthorityDeferredPaths.delete(path);
		this.deps.trace("reconcile", "visible-editor-crdt-alias-retired", {
			path,
			stage,
			capturedLength: marker.capturedCrdtContent?.length ?? null,
		});
	}

	private canCommitOpenEditorMutation(input: {
		path: string;
		ticket: OpenEditorMutationTicket | null;
		expectedYText: ReturnType<VaultSync["getTextForPath"]>;
		expectedCrdtContent: string | null;
		stage: string;
	}): boolean {
		const editorBindings = this.deps.getEditorBindings();
		const currentViews = this.getOpenMarkdownViewsForPath(input.path);
		const validation = input.ticket
			? editorBindings?.validateOpenEditorMutationTicket?.(
				input.ticket,
				currentViews,
			) ?? {
				current: false as const,
				reason: "binding-manager-unavailable",
				leafId: undefined,
			}
			: {
				current: true as const,
				reason: "no-ticket",
				leafId: undefined,
			};
		const currentYText = this.deps.getVaultSync()?.getTextForPath(input.path) ?? null;
		const currentCrdtContent = yTextToString(currentYText);
		const crdtIdentityCurrent = currentYText === input.expectedYText;
		const crdtCurrent = currentCrdtContent === input.expectedCrdtContent;
		const validationReason = validation.current === false
			? validation.reason
			: "no-ticket";
		const validationLeafId = validation.current === false
			? (validation.leafId ?? null)
			: null;
		if (validation.current && crdtIdentityCurrent && crdtCurrent) {
			return true;
		}

		this.deps.trace("recovery", "open-editor-mutation-ticket-stale", {
			path: input.path,
			stage: input.stage,
			reason: !crdtIdentityCurrent
				? "crdt-text-replaced"
				: (!crdtCurrent
					? "crdt-content-changed"
					: validationReason),
			leafId: validationLeafId,
			expectedCrdtLength: input.expectedCrdtContent?.length ?? null,
			currentCrdtLength: currentCrdtContent?.length ?? null,
			openViewCount: currentViews.length,
		});
		return false;
	}

	/**
	 * Startup authorities not already covered by commitOpenEditorDiskMutation's
	 * exact file/disk/baseline/lifecycle/candidate/Y.Text/editor checks. The
	 * monotonic generations detect Attention and sync-scope ABA, while the live
	 * predicate rejects a path that is currently outside the effective scope.
	 */
	private getStartupOpenFileSupplementalStaleReason(
		snapshot: StartupOpenFileAuthoritySnapshot,
	): string | null {
		if (
			(this.deps.getMarkdownAttentionGeneration?.() ?? 0) !== snapshot.attentionGeneration
		) return "attention-generation-changed";
		if (
			(this.deps.getMarkdownSyncScopeGeneration?.() ?? 0) !== snapshot.syncScopeGeneration
		) return "sync-scope-generation-changed";
		if (!this.deps.isMarkdownPathSyncable(snapshot.path)) return "path-not-syncable";
		return null;
	}

	/**
	 * Final async compare-and-commit fence for every open-file CRDT mutation.
	 *
	 * Planning hashes, recovery-state hashes, and conflict artifacts all await.
	 * Re-read the captured TFile last, then validate file identity, disk bytes,
	 * Y.Text identity/content, editor revision, Attention marker, and disk event
	 * revision synchronously. Invoke the supplied mutation callback in that same
	 * microtask, before this Promise resolves, so a queued provider transaction
	 * cannot enter between final validation and the CRDT commit.
	 */
	private async commitOpenEditorDiskMutation<T>(input: {
		path: string;
		file: TFile | null;
		expectedDiskContent: string;
		expectedDiskStat?: {
			ctime?: number | null;
			mtime: number | null;
			size: number | null;
		} | null;
		expectedBaselineHash?: string | null;
		expectedBaselineRevision?: number;
		expectedLifecycleGeneration?: number;
		expectedYText: ReturnType<VaultSync["getTextForPath"]>;
		expectedCrdtContent: string | null;
		ticket: OpenEditorMutationTicket | null;
		expectedDiskRevision: number;
		expectedVisibleAuthorityMarker: DeferredVisibleEditorAuthority | null;
		expectedInterceptedCandidate?: InterceptedExternalDiskMutation | null;
		expectedCandidateIdentityEpoch?: number;
		shouldAbort?: () => boolean;
		additionalAuthorityStaleReason?: () => string | null;
		stage: string;
		commit: () => T;
	}): Promise<OpenEditorDiskMutationCommit<T>> {
		const expectedFile = input.file;
		const expectedStat = input.expectedDiskStat !== undefined
			? input.expectedDiskStat
			: expectedFile
			? {
				ctime: typeof expectedFile.stat?.ctime === "number" ? expectedFile.stat.ctime : null,
				mtime: typeof expectedFile.stat?.mtime === "number" ? expectedFile.stat.mtime : null,
				size: typeof expectedFile.stat?.size === "number" ? expectedFile.stat.size : null,
			}
			: null;
		let currentDiskContent: string | null = null;
		let diskReadFailed = false;
		let diskIdentityChanged = false;
		if (
			!expectedFile ||
			expectedFile.path !== input.path ||
			this.deps.app.vault.getAbstractFileByPath(input.path) !== expectedFile
		) {
			diskIdentityChanged = true;
		} else {
			try {
				currentDiskContent = await this.readFreshMarkdownFile(expectedFile);
			} catch {
				diskReadFailed = true;
			}
			if (
				expectedFile.path !== input.path ||
				this.deps.app.vault.getAbstractFileByPath(input.path) !== expectedFile
			) {
				diskIdentityChanged = true;
			}
		}

		const reject = (
			reason: string,
			details: Record<string, unknown> = {},
		): OpenEditorDiskMutationCommit<T> => {
			this.deps.trace("recovery", "open-editor-mutation-ticket-stale", {
				path: input.path,
				stage: input.stage,
				reason,
				expectedDiskLength: input.expectedDiskContent.length,
				currentDiskLength: currentDiskContent?.length ?? null,
				...details,
			});
			return { kind: "stale" };
		};

		const callerAborted = input.shouldAbort?.() ?? false;
		const additionalAuthorityStaleReason =
			input.additionalAuthorityStaleReason?.() ?? null;
		const currentDiskRevision = this.getMarkdownDiskRevision(input.path);
		const currentBaselineHash = this.deps.getDiskIndex()[input.path]?.contentHash ?? null;
		const currentBaselineRevision = this.diskBaselineRevisions.get(input.path) ?? 0;
		const currentLifecycleGeneration = this.lifecycleGeneration;
		const currentVisibleAuthorityMarker =
			this.visibleAuthorityDeferredPaths.get(input.path) ?? null;
		const preservedUnresolved = this.isMarkdownPreservedUnresolved(input.path);
		const diskStatChanged = !!expectedFile && !!expectedStat && (
			(expectedStat.ctime !== undefined &&
				(typeof expectedFile.stat?.ctime === "number" ? expectedFile.stat.ctime : null) !== expectedStat.ctime)
			|| (typeof expectedFile.stat?.mtime === "number" ? expectedFile.stat.mtime : null) !== expectedStat.mtime
			|| (typeof expectedFile.stat?.size === "number" ? expectedFile.stat.size : null) !== expectedStat.size
		);
		const currentInterceptedCandidate =
			this.interceptedExternalDiskMutations.get(input.path) ?? null;
		const currentCandidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(input.path);
		let reason: string | null = null;
		if (diskStatChanged) reason = "disk-stat-changed";
		else if (diskIdentityChanged) reason = "disk-file-identity-changed";
		else if (diskReadFailed) reason = "disk-read-failed";
		else if (currentDiskContent !== input.expectedDiskContent) reason = "disk-content-changed";
		else if (
			input.expectedBaselineHash !== undefined &&
			currentBaselineHash !== input.expectedBaselineHash
		) reason = "baseline-hash-changed";
		else if (
			input.expectedBaselineRevision !== undefined &&
			currentBaselineRevision !== input.expectedBaselineRevision
		) reason = "baseline-revision-changed";
		else if (
			input.expectedLifecycleGeneration !== undefined &&
			currentLifecycleGeneration !== input.expectedLifecycleGeneration
		) reason = "lifecycle-generation-changed";
		else if (currentDiskRevision !== input.expectedDiskRevision) {
			reason = "disk-event-generation-changed";
		} else if (currentVisibleAuthorityMarker !== input.expectedVisibleAuthorityMarker) {
			reason = "visible-authority-marker-changed";
		} else if (
			input.expectedInterceptedCandidate !== undefined &&
			currentInterceptedCandidate !== input.expectedInterceptedCandidate
		) reason = "external-candidate-changed";
		else if (
			input.expectedCandidateIdentityEpoch !== undefined &&
			currentCandidateIdentityEpoch !== input.expectedCandidateIdentityEpoch
		) reason = "external-candidate-identity-changed";
		else if (preservedUnresolved) reason = "preserved-unresolved";
		else if (callerAborted) reason = "caller-aborted";
		else if (additionalAuthorityStaleReason !== null) {
			reason = additionalAuthorityStaleReason;
		}
		if (reason !== null) {
			return reject(reason, {
				expectedDiskRevision: input.expectedDiskRevision,
				currentDiskRevision,
			});
		}

		if (!this.canCommitOpenEditorMutation({
			path: input.path,
			ticket: input.ticket,
			expectedYText: input.expectedYText,
			expectedCrdtContent: input.expectedCrdtContent,
			stage: input.stage,
		})) {
			return { kind: "stale" };
		}

		// Ticket validation and dependency callbacks above are synchronous but may
		// themselves touch controller state. Recheck every non-byte fence and the
		// exact Y.Text immediately before invoking the mutation callback. No Promise
		// is resolved between this check and the CRDT transaction.
		const finalCallerAborted = input.shouldAbort?.() ?? false;
		const finalAdditionalAuthorityStaleReason =
			input.additionalAuthorityStaleReason?.() ?? null;
		const finalPreservedUnresolved = this.isMarkdownPreservedUnresolved(input.path);
		const finalYText = this.deps.getVaultSync()?.getTextForPath(input.path) ?? null;
		const finalCrdtContent = yTextToString(finalYText);
		const finalDiskRevision = this.getMarkdownDiskRevision(input.path);
		const finalBaselineHash = this.deps.getDiskIndex()[input.path]?.contentHash ?? null;
		const finalBaselineRevision = this.diskBaselineRevisions.get(input.path) ?? 0;
		const finalLifecycleGeneration = this.lifecycleGeneration;
		const finalVisibleAuthorityMarker =
			this.visibleAuthorityDeferredPaths.get(input.path) ?? null;
		const finalInterceptedCandidate =
			this.interceptedExternalDiskMutations.get(input.path) ?? null;
		const finalCandidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(input.path);
		const finalDiskStatChanged = !!expectedFile && !!expectedStat && (
			(expectedStat.ctime !== undefined &&
				(typeof expectedFile.stat?.ctime === "number" ? expectedFile.stat.ctime : null) !== expectedStat.ctime)
			|| (typeof expectedFile.stat?.mtime === "number" ? expectedFile.stat.mtime : null) !== expectedStat.mtime
			|| (typeof expectedFile.stat?.size === "number" ? expectedFile.stat.size : null) !== expectedStat.size
		);
		let finalReason: string | null = null;
		if (finalDiskStatChanged) finalReason = "disk-stat-changed";
		else if (
			!expectedFile ||
			expectedFile.path !== input.path ||
			this.deps.app.vault.getAbstractFileByPath(input.path) !== expectedFile
		) finalReason = "disk-file-identity-changed";
		else if (
			input.expectedBaselineHash !== undefined &&
			finalBaselineHash !== input.expectedBaselineHash
		) finalReason = "baseline-hash-changed";
		else if (
			input.expectedBaselineRevision !== undefined &&
			finalBaselineRevision !== input.expectedBaselineRevision
		) finalReason = "baseline-revision-changed";
		else if (
			input.expectedLifecycleGeneration !== undefined &&
			finalLifecycleGeneration !== input.expectedLifecycleGeneration
		) finalReason = "lifecycle-generation-changed";
		else if (finalDiskRevision !== input.expectedDiskRevision) {
			finalReason = "disk-event-generation-changed";
		} else if (finalVisibleAuthorityMarker !== input.expectedVisibleAuthorityMarker) {
			finalReason = "visible-authority-marker-changed";
		} else if (
			input.expectedInterceptedCandidate !== undefined &&
			finalInterceptedCandidate !== input.expectedInterceptedCandidate
		) finalReason = "external-candidate-changed";
		else if (
			input.expectedCandidateIdentityEpoch !== undefined &&
			finalCandidateIdentityEpoch !== input.expectedCandidateIdentityEpoch
		) finalReason = "external-candidate-identity-changed";
		else if (finalPreservedUnresolved) finalReason = "preserved-unresolved";
		else if (finalYText !== input.expectedYText) finalReason = "crdt-text-replaced";
		else if (finalCrdtContent !== input.expectedCrdtContent) finalReason = "crdt-content-changed";
		else if (finalCallerAborted) finalReason = "caller-aborted";
		else if (finalAdditionalAuthorityStaleReason !== null) {
			finalReason = finalAdditionalAuthorityStaleReason;
		}
		if (finalReason !== null) {
			return reject(finalReason, {
				expectedDiskRevision: input.expectedDiskRevision,
				currentDiskRevision: finalDiskRevision,
				expectedCrdtLength: input.expectedCrdtContent?.length ?? null,
				currentCrdtLength: finalCrdtContent?.length ?? null,
			});
		}

		return { kind: "committed", value: input.commit() };
	}

	private canPreserveMarkerForActiveOpenFlush(path: string): boolean {
		const leases = this.activeOpenFlushAuthorityLeases.get(path);
		if (!leases || leases.size === 0) return false;
		const currentMarker = this.visibleAuthorityDeferredPaths.get(path) ?? null;
		// Use the post-commit view of the lease: a vault.modify callback observes
		// the write's new stat/disk-event epoch, but every non-disk authority fence
		// must still be exact. An unrelated pre-commit event is rejected by the
		// normal disk epoch/CAS; a post-commit disk change is rejected by DiskMirror's
		// exact committed-file readback.
		for (const lease of leases) {
			if (lease.expectedVisibleAuthorityMarker !== currentMarker) continue;
			if (this.isOpenFlushAuthorityLeaseCurrent(lease, "after-commit")) return true;
		}
		return false;
	}

	private async withActiveOpenFlushAuthorityLease(
		lease: OpenFlushAuthorityLease,
		flush: () => Promise<DiskWriteResult | undefined> | DiskWriteResult | undefined,
	): Promise<DiskWriteResult | undefined> {
		let leases = this.activeOpenFlushAuthorityLeases.get(lease.path);
		if (!leases) {
			leases = new Set<OpenFlushAuthorityLease>();
			this.activeOpenFlushAuthorityLeases.set(lease.path, leases);
		}
		leases.add(lease);
		try {
			return await flush();
		} finally {
			leases.delete(lease);
			if (
				leases.size === 0 &&
				this.activeOpenFlushAuthorityLeases.get(lease.path) === leases
			) {
				this.activeOpenFlushAuthorityLeases.delete(lease.path);
			}
		}
	}

	private flushWithOpenAuthorityLease(
		diskMirror: DiskMirror | null | undefined,
		path: string,
		expectedDiskContent: string,
		lease: OpenFlushAuthorityLease,
	): Promise<DiskWriteResult | undefined> {
		if (!diskMirror) return Promise.resolve(undefined);
		const remoteProjectionAdmission =
			this.captureRemoteProjectionAdmission(diskMirror, [path]);
		if (!remoteProjectionAdmission) {
			return Promise.resolve({
				kind: "deferred",
				path,
				reason: "remote-projection-not-ready",
			});
		}
		return this.withActiveOpenFlushAuthorityLease(
			lease,
			() => diskMirror.flushWrite(path, true, {
				requireRemoteProjectionAdmission: true,
				remoteProjectionAdmission,
				recordBaseline: true,
				expectedDiskContent,
				expectedDiskFile: lease.expectedDiskFile,
				expectedDiskRevision: lease.expectedDiskFileRevision,
				isAuthorityCurrent: (phase) =>
					this.isOpenFlushAuthorityLeaseCurrent(lease, phase),
			}),
		);
	}

	private captureRemoteProjectionAdmission(
		diskMirror: DiskMirror,
		paths: readonly string[],
	): RemoteProjectionAdmissionLease | null {
		const capture = (
			diskMirror as DiskMirror & {
				captureRemoteProjectionAdmission?: (
					candidates: readonly string[],
				) => RemoteProjectionAdmissionLease | null;
			}
		).captureRemoteProjectionAdmission;
		if (typeof capture === "function") {
			return capture.call(diskMirror, paths);
		}
		if (!paths.every((path) => this.deps.isRemoteProjectionAllowed?.(path) ?? true)) {
			return null;
		}
		return {
			isCurrent: () =>
				paths.every((path) => this.deps.isRemoteProjectionAllowed?.(path) ?? true),
		};
	}

	private isOpenFlushAuthorityLeaseCurrent(
		lease: OpenFlushAuthorityLease,
		phase: DiskWriteAuthorityPhase,
	): boolean {
		const currentFile = this.deps.app.vault.getAbstractFileByPath(lease.path);
		const exactFileCurrent =
			currentFile === lease.expectedDiskFile && lease.expectedDiskFile.path === lease.path;
		const requirePreCommitDiskEpoch = phase === "before-commit";
		const stat = lease.expectedDiskFile.stat;
		const diskStatCurrent = !requirePreCommitDiskEpoch || (
			(typeof stat?.ctime === "number" ? stat.ctime : null) === lease.expectedDiskStat.ctime
			&& (typeof stat?.mtime === "number" ? stat.mtime : null) === lease.expectedDiskStat.mtime
			&& (typeof stat?.size === "number" ? stat.size : null) === lease.expectedDiskStat.size
		);
		const currentBaselineHash = this.deps.getDiskIndex()[lease.path]?.contentHash ?? null;
		const currentBaselineRevision = this.diskBaselineRevisions.get(lease.path) ?? 0;
		const currentYText = this.deps.getVaultSync()?.getTextForPath(lease.path) ?? null;
		const currentCrdtContent = yTextToString(currentYText);
		const currentViews = this.getOpenMarkdownViewsForPath(lease.path);
		const editorValidation = lease.expectedEditorTicket
			? this.deps.getEditorBindings()?.validateOpenEditorMutationTicket?.(
				lease.expectedEditorTicket,
				currentViews,
			) ?? {
				current: false as const,
				reason: "binding-manager-unavailable" as const,
			}
			: {
				current: false as const,
				reason: "ticket-unavailable" as const,
			};
		const currentVisibleAuthorityMarker =
			this.visibleAuthorityDeferredPaths.get(lease.path) ?? null;
		const currentInterceptedCandidate =
			this.interceptedExternalDiskMutations.get(lease.path) ?? null;
		const currentCandidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(lease.path);
		const callerAborted = requirePreCommitDiskEpoch && lease.shouldAbort();
		const currentDiskEventRevision = this.getMarkdownDiskRevision(lease.path);
		let reason: string | null = null;
		if (!exactFileCurrent) reason = "disk-file-identity-changed";
		else if (!diskStatCurrent) reason = "disk-stat-changed";
		else if (
			requirePreCommitDiskEpoch &&
			currentDiskEventRevision !== lease.expectedDiskEventRevision
		) reason = "disk-event-generation-changed";
		else if (currentBaselineHash !== lease.expectedBaselineHash) reason = "baseline-hash-changed";
		else if (currentBaselineRevision !== lease.expectedBaselineRevision) {
			reason = "baseline-revision-changed";
		} else if (this.lifecycleGeneration !== lease.expectedLifecycleGeneration) {
			reason = "lifecycle-generation-changed";
		} else if (currentVisibleAuthorityMarker !== lease.expectedVisibleAuthorityMarker) {
			reason = "visible-authority-marker-changed";
		} else if (currentInterceptedCandidate !== lease.expectedInterceptedCandidate) {
			reason = "external-candidate-changed";
		} else if (currentCandidateIdentityEpoch !== lease.expectedCandidateIdentityEpoch) {
			reason = "external-candidate-identity-changed";
		} else if (this.isMarkdownPreservedUnresolved(lease.path)) {
			reason = "preserved-unresolved";
		} else if (currentYText !== lease.expectedYText) reason = "crdt-text-replaced";
		else if (currentCrdtContent !== lease.expectedCrdtContent) reason = "crdt-content-changed";
		else if (!editorValidation.current) reason = `editor-${editorValidation.reason}`;
		else if (callerAborted) reason = "caller-aborted";
		if (reason === null) return true;

		this.deps.trace("reconcile", "open-flush-authority-stale", {
			path: lease.path,
			stage: lease.stage,
			phase,
			reason,
			expectedDiskEventRevision: lease.expectedDiskEventRevision,
			currentDiskEventRevision,
			openViewCount: currentViews.length,
		});
		return false;
	}

	private deferStaleOpenEditorMutation(stage: string): BoundFileSyncGapOutcome {
		this.deps.trace(
			"reconcile",
			stage.startsWith("open-external-")
				? "open-external-stale-replan"
				: "open-editor-stale-replan",
			{
				reason: stage,
				deferMs: OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
			},
		);
		return {
			kind: "deferred",
			deferUntil: Date.now() + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
			reason: `stale-open-editor-mutation-ticket:${stage}`,
		};
	}

	private traceOpenExternalEvent(
		message: OpenExternalTraceMessage,
		details: OpenExternalTraceDetails,
	): void {
		this.deps.trace("reconcile", message, details);
	}

	private getOpenExternalSettlementTraceReason(
		reason: string,
	): OpenExternalTraceReason | null {
		switch (reason) {
			case "apply-external":
			case "apply-clean-merge":
			case "open-external-representation-normalized":
			case "open-external-current-only":
			case "open-external-overlapping-hunks":
			case "open-external-missing-baseline":
				return reason;
			default:
				return null;
		}
	}

	private getOpenEditorAuthority(openViews: MarkdownView[]): OpenEditorAuthority {
		if (openViews.length === 0) return { kind: "none" };

		const contents: string[] = [];
		for (const view of openViews) {
			try {
				contents.push(view.editor.getValue());
			} catch {
				return { kind: "read-failed" };
			}
		}

		const distinct = [...new Set(contents)];
		if (distinct.length === 0) return { kind: "none" };
		if (distinct.length > 1) return { kind: "multiple" };
		return { kind: "single", content: distinct[0]! };
	}

	private captureBoundFileSettlement(
		path: string,
		diskContent: string,
		expectedYText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[],
	): Extract<BoundFileSyncGapOutcome, { kind: "handled" }>["settlement"] {
		const currentYText = this.deps.getVaultSync()?.getTextForPath(path) ?? null;
		if (currentYText !== expectedYText) return undefined;
		const currentCrdtContent = yTextToString(currentYText);
		if (currentCrdtContent === null) return undefined;
		const editorAuthority = this.getOpenEditorAuthority(openViews);
		if (editorAuthority.kind !== "single") return undefined;

		const normalizedTarget = normalizeEditorText(diskContent);
		if (
			normalizeEditorText(currentCrdtContent) !== normalizedTarget ||
			normalizeEditorText(editorAuthority.content) !== normalizedTarget
		) {
			return undefined;
		}
		// Disk/Y.Text equality is only a snapshot. Carry the exact live editor
		// lineage so the final post-read baseline commit cannot cross a later
		// editor revision, rebind, or pane-set change.
		const expectedEditorTicket = this.captureOpenEditorMutationTicket(path, openViews);
		if (
			expectedEditorTicket !== null &&
			!this.canCommitOpenEditorMutation({
				path,
				ticket: expectedEditorTicket,
				expectedYText: currentYText,
				expectedCrdtContent: currentCrdtContent,
				stage: "bound-file-settlement-capture",
			})
		) {
			return undefined;
		}

		return {
			content: diskContent,
			expectedYText: currentYText,
			expectedCrdtContent: currentCrdtContent,
			...(expectedEditorTicket ? { expectedEditorTicket } : {}),
			expectedOpenEditorContent: editorAuthority.content,
		};
	}

	private decideDeferredVisibleAuthority(
		path: string,
		diskContent: string,
		crdtContent: string,
	): DeferredVisibleAuthorityDecision {
		const marker = this.visibleAuthorityDeferredPaths.get(path);
		if (!marker) return { kind: "none" };

		// Multiple divergent editor panes (or an unreadable pane) do not provide
		// one safe automatic winner.  Preserve all readable snapshots instead.
		if (!marker.readComplete || marker.editorContents.length !== 1) {
			return { kind: "unresolved", marker };
		}

		const content = marker.editorContents[0]!;
		const diskMatches = diskContent === content;
		const crdtMatches = crdtContent === content;
		if (diskMatches && crdtMatches) return { kind: "settled", content };
		if (diskMatches) return { kind: "disk-wins", content };
		if (crdtMatches) return { kind: "crdt-wins", content };
		return { kind: "unresolved", marker };
	}

	private clearDeferredVisibleAuthorityIfSettled(path: string, content: string): void {
		const marker = this.visibleAuthorityDeferredPaths.get(path);
		if (
			marker?.readComplete &&
			marker.editorContents.length === 1 &&
			marker.editorContents[0] === content
		) {
			this.visibleAuthorityDeferredPaths.delete(path);
		}
	}

	/**
	 * All live authorities were compared synchronously by the caller and now
	 * expose the same bytes. Retire a stale multi-editor capture and only the
	 * matching provisional flush warning; stronger preservation failures remain.
	 */
	private resolveConvergedVisibleAuthority(path: string): void {
		const marker = this.visibleAuthorityDeferredPaths.get(path);
		if (!marker) return;
		this.visibleAuthorityDeferredPaths.delete(path);

		const diskMirror = this.deps.getDiskMirror();
		const attention = diskMirror?.getPreservedUnresolvedEntries()
			.find((entry) => entry.path === path);
		if (attention?.reason === "conflict-winner-flush-deferred") {
			diskMirror?.clearPreservedUnresolved(path);
		}
		this.deps.trace("reconcile", "visible-editor-authority-converged", {
			path,
			capturedReadComplete: marker.readComplete,
			capturedEditorCandidateCount: marker.editorContents.length,
			clearedAttention: attention?.reason === "conflict-winner-flush-deferred",
		});
	}

	/**
	 * Handle an unresolved visible-editor authority (multiple panes, an
	 * editor read failure, or no readable pane) without preserving anything.
	 *
	 * With conflict-artifact preservation abolished, no file is written and
	 * no limbo episode is recorded: every competing state is still alive in
	 * the editor(s), the CRDT, or on disk, so the correct action is to do
	 * nothing and let the next vault event re-evaluate. The trace keeps the
	 * deferral observable.
	 */
	private async preserveUnresolvedVisibleAuthority(
		path: string,
		marker: DeferredVisibleEditorAuthority,
		diskContent: string,
		crdtContent: string,
		stage: string,
	): Promise<void> {
		this.deps.trace("conflict", "visible-authority-unresolved-deferred", {
			path,
			stage,
			readComplete: marker.readComplete,
			editorCandidateCount: marker.editorContents.length,
			capturedDiskRevision: marker.capturedDiskRevision,
			currentDiskRevision: this.getMarkdownDiskRevision(path),
			diskLength: diskContent.length,
			crdtLength: crdtContent.length,
		});
	}

	private getOpenEditorDiskMismatchDeferUntil(input: {
		path: string;
		sourceReason: MarkdownDirtyReason;
		cameFromDirtyQueue: boolean;
		diskContent: string;
		crdtContent: string | null;
		openViews: MarkdownView[];
		now?: number;
	}): number | null {
		if (input.openViews.length === 0) return null;

		const authority = this.getOpenEditorAuthority(input.openViews);
		if (authority.kind === "none") return null;

		const now = input.now ?? Date.now();
		if (authority.kind === "multiple" || authority.kind === "read-failed") {
			return now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
		}
		if (input.sourceReason === "create") {
			return authority.content === input.diskContent
				? null
				: now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
		}
		if (!input.cameFromDirtyQueue) return null;

		if (authority.content === input.diskContent) return null;
		if (input.crdtContent !== null && authority.content === input.crdtContent) return null;
		return now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
	}

	private async getOpenEditorReconcileSettleDefer(
		input: {
			path: string;
			diskContent: string;
			crdtContent: string;
			openViews: MarkdownView[];
		},
		now = Date.now(),
	): Promise<{
		reason: OpenEditorSettleReason;
		lastEditorActivity: number | null;
		lastRemoteUpdate: number | null;
		idleMs: number | null;
		deferUntil: number;
		captureVisibleAuthority: boolean;
		retainSettledDiskIndex: boolean;
	} | null> {
		const editorBindings = this.deps.getEditorBindings() as
			| { getLastEditorActivityForPath?: (path: string) => number | null }
			| null;
		const lastEditorActivity =
			editorBindings?.getLastEditorActivityForPath?.(input.path) ?? null;
		if (lastEditorActivity !== null) {
			const deferUntil = lastEditorActivity + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
			if (deferUntil > now) {
				return {
					reason: "recent-editor-activity",
					lastEditorActivity,
					lastRemoteUpdate: null,
					idleMs: Math.max(0, now - lastEditorActivity),
					deferUntil,
					captureVisibleAuthority: true,
					retainSettledDiskIndex: false,
				};
			}
		}

		const authority = this.getOpenEditorAuthority(input.openViews);
		const vaultSync = this.deps.getVaultSync();
		const lastRemoteUpdate = vaultSync?.lastRemoteUpdateAt ?? null;
		if (
			lastRemoteUpdate !== null &&
			Number.isFinite(lastRemoteUpdate) &&
			lastRemoteUpdate <= now
		) {
			const deferUntil = lastRemoteUpdate + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
			if (deferUntil > now) {
				let diskIsDurableBaseline = false;
				const baselineHash = this.deps.getDiskIndex()[input.path]?.contentHash ?? null;
				if (baselineHash !== null) {
					const diskHash = await contentBaselineHash(input.diskContent);
					diskIsDurableBaseline = diskHash === baselineHash;
				}

				// A just-arrived provider transaction can update Y.Text before the
				// y-codemirror patch and Obsidian autosave have reached the visible
				// editor/disk.  When E=D=baseline, that visible C1 is a stale render,
				// not new local authority.  Deferring it as a durable editor candidate
				// would later quarantine the expected C1 -> C2 editor patch.
				const captureVisibleAuthority = !(
					authority.kind === "single" &&
					(
						authority.content === input.crdtContent ||
						(
							authority.content === input.diskContent &&
							diskIsDurableBaseline
						)
					)
				);
				return {
					reason: "recent-remote-update",
					lastEditorActivity: null,
					lastRemoteUpdate,
					idleMs: Math.max(0, now - lastRemoteUpdate),
					deferUntil,
					captureVisibleAuthority,
					retainSettledDiskIndex:
						!captureVisibleAuthority && diskIsDurableBaseline,
				};
			}
		}

		if (authority.kind !== "single") return null;
		if (authority.content === input.diskContent) return null;
		if (authority.content === input.crdtContent) return null;

		// Startup can receive provider state before the CM6 binding has begun
		// tracking user edits. If the live editor is already ahead of both disk
		// and CRDT, treat it as an unsettled typing/autosave boundary once
		// before preserving artifacts.
		return {
			reason: "editor-ahead-without-activity-timestamp",
			lastEditorActivity: null,
			lastRemoteUpdate: null,
			idleMs: null,
			deferUntil: now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
			captureVisibleAuthority: true,
			retainSettledDiskIndex: false,
		};
	}

	private deferOpenFileReconcileForEditorSettle(input: {
		path: string;
		diskContent: string;
		crdtContent: string;
		openViews: MarkdownView[];
		reason: OpenEditorSettleReason;
		lastEditorActivity: number | null;
		lastRemoteUpdate: number | null;
		idleMs: number | null;
		deferUntil: number;
		captureVisibleAuthority: boolean;
		retainSettledDiskIndex: boolean;
	}): void {
		let readComplete = true;
		const capturedEditorContents: string[] = [];
		const editorStates = input.openViews.map((view) => {
			let editorContent: string | null = null;
			try {
				editorContent = view.editor.getValue();
			} catch {
				readComplete = false;
				editorContent = null;
			}
			if (editorContent !== null) capturedEditorContents.push(editorContent);
			return {
				editorLength: editorContent?.length ?? null,
				editorMatchesDisk: editorContent === input.diskContent,
				editorMatchesCrdt: editorContent === input.crdtContent,
			};
		});

		this.deps.log(
			`reconcile: deferring "${input.path}" ` +
			`(open editor is still settling; reason=${input.reason})`,
		);
		this.deps.trace("reconcile", "open-file-reconcile-deferred-editor-settle", {
			path: input.path,
			reason: input.reason,
			idleMs: input.idleMs,
			lastEditorActivity: input.lastEditorActivity,
			lastRemoteUpdate: input.lastRemoteUpdate,
			notBeforeMs: input.deferUntil,
			captureVisibleAuthority: input.captureVisibleAuthority,
			retainSettledDiskIndex: input.retainSettledDiskIndex,
			openViewCount: input.openViews.length,
			diskLength: input.diskContent.length,
			crdtLength: input.crdtContent.length,
			editorStates,
		});
		if (!input.captureVisibleAuthority) {
			this.requestReconciliationFollowup(input.path, `open-editor-settle:${input.reason}`);
			return;
		}
		const previous = this.visibleAuthorityDeferredPaths.get(input.path);
		const currentEditorContents = Array.from(new Set(capturedEditorContents));
		const currentReadComplete =
			readComplete && capturedEditorContents.length === input.openViews.length;
		const currentEditorTicket = this.compactVisibleAuthorityTicket(
			this.captureOpenEditorMutationTicket(
				input.path,
				input.openViews,
			),
		);
		const editorActivityAdvanced =
			input.lastEditorActivity !== null &&
			(
				previous?.capturedEditorActivity === null ||
				previous?.capturedEditorActivity === undefined ||
				input.lastEditorActivity > previous.capturedEditorActivity
			);
		const ticketProgress: VisibleAuthorityTicketProgress = previous
			? this.classifyVisibleAuthorityTicketProgress(
				previous.capturedEditorTicket,
				currentEditorTicket,
				currentEditorContents,
				currentReadComplete,
			)
			: {
				kind: "unavailable",
				advancedEditorContents: [],
				supersedesPreviousSingle: false,
				provenNoEditorAuthorityAdvance: false,
			};
		const crdtAliasProjectionAdopted = this.canRecaptureCrdtAliasProjection({
			previous,
			progress: ticketProgress,
			currentEditorContents,
			currentReadComplete,
			currentCrdtContent: input.crdtContent,
		});
		const recaptureIsAuthoritative =
			currentReadComplete &&
			(
				!previous ||
				ticketProgress.kind === "successor" ||
				crdtAliasProjectionAdopted ||
				(ticketProgress.kind === "unavailable" && editorActivityAdvanced)
			);
		const editorContents = recaptureIsAuthoritative
			? currentEditorContents
			: Array.from(new Set([
				...this.getRetainedVisibleAuthorityContents(previous, ticketProgress),
				...ticketProgress.advancedEditorContents,
				...currentEditorContents,
			]));
		this.visibleAuthorityDeferredPaths.set(input.path, {
			editorContents,
			readComplete:
				currentReadComplete &&
				(recaptureIsAuthoritative || editorContents.length === 1),
			capturedDiskContent: input.diskContent,
			capturedCrdtContent: input.crdtContent,
			capturedDiskRevision: this.getMarkdownDiskRevision(input.path),
			capturedEditorActivity: input.lastEditorActivity,
			capturedEditorTicket: currentEditorTicket,
			capturedAt: Date.now(),
		});
		this.deps.trace("reconcile", "visible-editor-authority-recaptured-at-settle", {
			path: input.path,
			ticketProgress: ticketProgress.kind,
			advancedEditorCandidateCount: ticketProgress.advancedEditorContents.length,
			recaptureIsAuthoritative,
			crdtAliasProjectionAdopted,
			editorCandidateCount: editorContents.length,
		});
		this.requestReconciliationFollowup(input.path, `open-editor-settle:${input.reason}`);
	}

	private async handleOpenFileReconcileDivergence(
		path: string,
		diskContent: string,
		ytext: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[],
		file: TFile | null,
	): Promise<boolean> {
		if (!ytext) return false;
		// This startup shortcut can await hashing and conflict-artifact writes.
		// Capture every non-editor authority before the first await so a later
		// baseline settlement, lifecycle change, or same-TFile disk epoch cannot
		// authorize an obsolete editor snapshot.
		const baselineAuthority = {
			hash: this.deps.getDiskIndex()[path]?.contentHash ?? null,
			revision: this.diskBaselineRevisions.get(path) ?? 0,
		};
		const lifecycleGeneration = this.lifecycleGeneration;
		const diskFileStat = file
			? {
				ctime: typeof file.stat?.ctime === "number" ? file.stat.ctime : null,
				mtime: typeof file.stat?.mtime === "number" ? file.stat.mtime : null,
				size: typeof file.stat?.size === "number" ? file.stat.size : null,
			}
			: null;
		const crdtContent = yTextToString(ytext) ?? "";
		const mutationTicket = this.captureOpenEditorMutationTicket(path, openViews);
		const visibleAuthorityTicket = this.compactVisibleAuthorityTicket(mutationTicket);
		const diskMutationRevision = this.getMarkdownDiskRevision(path);
		const interceptedCandidate =
			this.interceptedExternalDiskMutations.get(path) ?? null;
		const candidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(path);
		const attentionGeneration = this.deps.getMarkdownAttentionGeneration?.() ?? 0;
		const syncScopeGeneration = this.deps.getMarkdownSyncScopeGeneration?.() ?? 0;
		let visibleAuthorityMarker = this.visibleAuthorityDeferredPaths.get(path) ?? null;
		const viewStates: Array<{ view: MarkdownView; editorContent: string }> = [];
		let editorReadFailed = false;
		for (const view of openViews) {
			try {
				viewStates.push({ view, editorContent: view.editor.getValue() });
			} catch {
				editorReadFailed = true;
			}
		}
		const distinctEditorContents = [...new Set(viewStates.map((state) => state.editorContent))];
		if (editorReadFailed || distinctEditorContents.length !== 1) {
			this.deps.trace("conflict", "open-file-reconcile-multiple-editor-authorities", {
				path,
				editorViewCount: openViews.length,
				distinctEditorContentCount: distinctEditorContents.length,
				editorReadFailed,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
			});
			return false;
		}

		const editorAuthority = distinctEditorContents[0]!;
		const lastEditorActivity = this.deps.getEditorBindings()
			?.getLastEditorActivityForPath?.(path) ?? null;
		if (visibleAuthorityMarker) {
			const ticketProgress = this.classifyVisibleAuthorityTicketProgress(
				visibleAuthorityMarker.capturedEditorTicket,
				visibleAuthorityTicket,
				distinctEditorContents,
				true,
			);
			if (ticketProgress.kind === "successor") {
				visibleAuthorityMarker = {
					editorContents: [editorAuthority],
					readComplete: true,
					capturedDiskContent: diskContent,
					capturedCrdtContent: crdtContent,
					capturedDiskRevision: this.getMarkdownDiskRevision(path),
					capturedEditorActivity: lastEditorActivity,
					capturedEditorTicket: visibleAuthorityTicket,
					capturedAt: Date.now(),
				};
				this.visibleAuthorityDeferredPaths.set(path, visibleAuthorityMarker);
				this.deps.trace("reconcile", "visible-editor-authority-successor-accepted", {
					path,
					stage: "open-file-reconcile-divergence",
					editorLength: editorAuthority.length,
				});
			} else if (ticketProgress.advancedEditorContents.length > 0) {
				const editorContents = Array.from(new Set([
					...this.getRetainedVisibleAuthorityContents(
						visibleAuthorityMarker,
						ticketProgress,
					),
					...ticketProgress.advancedEditorContents,
					editorAuthority,
				]));
				visibleAuthorityMarker = {
					...visibleAuthorityMarker,
					editorContents,
					readComplete: editorContents.length === 1,
					capturedDiskContent: diskContent,
					capturedCrdtContent: crdtContent,
					capturedDiskRevision: this.getMarkdownDiskRevision(path),
					capturedEditorActivity: lastEditorActivity,
					capturedEditorTicket: visibleAuthorityTicket,
					capturedAt: Date.now(),
				};
				this.visibleAuthorityDeferredPaths.set(path, visibleAuthorityMarker);
				this.deps.trace("reconcile", "visible-editor-authority-intervening-local-preserved", {
					path,
					stage: "open-file-reconcile-divergence",
					ticketProgress: ticketProgress.kind,
					editorCandidateCount: editorContents.length,
				});
			}
		}
		if (editorAuthority === crdtContent) {
			return false;
		}
		const startupAuthoritySnapshot: StartupOpenFileAuthoritySnapshot = Object.freeze({
			path,
			file,
			diskStat: diskFileStat,
			baselineHash: baselineAuthority.hash,
			baselineRevision: baselineAuthority.revision,
			lifecycleGeneration,
			expectedYText: ytext,
			expectedCrdtContent: crdtContent,
			editorTicket: mutationTicket,
			diskRevision: diskMutationRevision,
			visibleAuthorityMarker,
			interceptedCandidate,
			candidateIdentityEpoch,
			attentionGeneration,
			syncScopeGeneration,
		});
		const getStartupSupplementalStaleReason = () =>
			this.getStartupOpenFileSupplementalStaleReason(startupAuthoritySnapshot);
		const queueStartupReplan = () => {
			this.mergeDirtyEntryIntoPath(path, {
				reason: "modify",
				primaryOpId: undefined,
				coalescedOpIds: [],
				retryCount: 0,
				notBeforeMs: Date.now() + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
			});
		};

		// Do not let this legacy startup shortcut pre-empt the three-way open-file
		// planner.  In the provider patch window E=D=C1 while CRDT already holds
		// C2.  If the durable baseline is C1, CRDT is the only changed side; using
		// the still-visible C1 as an "editor winner" would undo the remote update.
		const diskHash = await contentBaselineHash(diskContent);
		const crdtHash = await contentBaselineHash(crdtContent);
		const baselineHash = baselineAuthority.hash;
		const editorMatchesDisk = editorAuthority === diskContent;
		const editorMatchesCrdt = editorAuthority === crdtContent;
		const preflightAction = planOpenBoundFileReconcile({
			diskHash,
			crdtHash,
			baselineHash,
			editorAuthority: {
				kind: "single",
				relation: editorMatchesDisk && editorMatchesCrdt
					? "both"
					: (editorMatchesDisk
						? "disk"
						: (editorMatchesCrdt ? "crdt" : "distinct")),
			},
			hasRecentEditorActivity:
				lastEditorActivity !== null &&
				(Date.now() - lastEditorActivity) < OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
		});
		if (preflightAction.kind === "apply-crdt-to-disk") {
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "reconcile",
				path,
				data: {
					decision: "keep-crdt-authority",
					reason: preflightAction.reason,
					conflictRisk: "none",
					editorMatchesDisk,
					diskMatchesBaseline: baselineHash !== null && diskHash === baselineHash,
				},
			});
			this.deps.trace("reconcile", "open-file-editor-writeback-skipped-crdt-authoritative", {
				path,
				reason: preflightAction.reason,
				baselineHash,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
				editorLength: editorAuthority.length,
			});
			return false;
		}

		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "reconcile",
			path,
			data: {
				decision: "open-editor-wins",
				reason: "open-file-editor-diverged-from-crdt",
				conflictRisk: "ambiguous",
				editorLength: editorAuthority.length,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
				editorMatchesDisk: editorAuthority === diskContent,
				editorMatchesCrdt: false,
			},
		});

		await this.recordDiscardedRevision(
			path,
			crdtContent,
			"open-file-reconcile-editor-wins",
		);
		if (diskContent !== editorAuthority && diskContent !== crdtContent) {
			await this.recordDiscardedRevision(
				path,
				diskContent,
				"open-file-reconcile-editor-wins-disk",
			);
		}

		const convergenceAttempt = await this.commitOpenEditorDiskMutation({
			path,
			file,
			expectedDiskContent: diskContent,
			expectedDiskStat: diskFileStat,
			expectedBaselineHash: baselineAuthority.hash,
			expectedBaselineRevision: baselineAuthority.revision,
			expectedLifecycleGeneration: lifecycleGeneration,
			ticket: mutationTicket,
			expectedYText: ytext,
			expectedCrdtContent: crdtContent,
			expectedDiskRevision: diskMutationRevision,
			expectedVisibleAuthorityMarker: visibleAuthorityMarker,
			expectedInterceptedCandidate: interceptedCandidate,
			expectedCandidateIdentityEpoch: candidateIdentityEpoch,
			additionalAuthorityStaleReason: getStartupSupplementalStaleReason,
			stage: "startup-open-editor-convergence",
			commit: () => {
				const result = applyDiffToYTextWithPostcondition(
					ytext,
					crdtContent,
					editorAuthority,
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
				);
				return result.finalMatchesExpected;
			},
		});
		if (convergenceAttempt.kind === "stale") {
			queueStartupReplan();
			return true;
		}
		const convergenceApplied = convergenceAttempt.value;
		this.deps.trace("conflict", "open-file-reconcile-editor-wins", {
			path,
			filePath: file?.path ?? null,
			editorViewCount: openViews.length,
			editorLength: editorAuthority.length,
			diskLength: diskContent.length,
			crdtLength: crdtContent.length,
			convergenceApplied,
		});
		return true;
	}

		private async preserveOpenBoundPlannerConflict(input: {
			file: TFile;
			diskContent: string;
			crdtContent: string;
			expectedYText: NonNullable<ReturnType<VaultSync["getTextForPath"]>>;
			targetContent?: string;
			commitTarget?: (
				commit: () => boolean,
			) => Promise<OpenEditorDiskMutationCommit<boolean>>;
			reason: string;
			preserveDisk: boolean;
			preserveCrdt: boolean;
			editorViewCount: number;
			distinctEditorContentCount: number;
			chosenSource: "disk" | "crdt" | "editor";
		}): Promise<boolean> {
			const {
				file,
				diskContent,
				crdtContent,
				expectedYText,
				targetContent,
				commitTarget,
				reason,
				preserveDisk,
				preserveCrdt,
				editorViewCount,
				distinctEditorContentCount,
				chosenSource,
			} = input;
			let convergenceApplied = false;

			// With preservation abolished, the losing sides are recorded
			// (trace + durable server audit) instead of written as artifacts.
			if (preserveCrdt && crdtContent !== targetContent) {
				await this.recordDiscardedRevision(
					file.path,
					crdtContent,
					reason,
				);
			}
			if (
				preserveDisk &&
				diskContent !== targetContent &&
				diskContent !== crdtContent
			) {
				await this.recordDiscardedRevision(
					file.path,
					diskContent,
					`${reason}-disk`,
				);
			}

			if (targetContent !== undefined) {
				if (!commitTarget) {
					return false;
				}
				const convergenceAttempt = await commitTarget(() => {
					const result = applyDiffToYTextWithPostcondition(
						expectedYText,
						crdtContent,
						targetContent,
						ORIGIN_DISK_SYNC_RECOVER_BOUND,
					);
					return result.finalMatchesExpected;
				});
				if (convergenceAttempt.kind === "stale") return false;
				convergenceApplied = convergenceAttempt.value;
			}

			this.deps.trace("conflict", "conflict-revision-discarded", {
				path: file.path,
				reason,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
				editorViewCount,
				distinctEditorContentCount,
				chosenSource,
				convergenceApplied,
			});
			return true;
		}

	private async handleBoundFileSyncGap(
		file: TFile,
		content: string,
		existingText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[] = this.getOpenMarkdownViewsForPath(file.path),
		sourceReason: "create" | "modify" = "modify",
		stableStat?: { mtime: number; size: number } | null,
		shouldAbort: () => boolean = () => false,
		physicalDiskContent: string = content,
	): Promise<BoundFileSyncGapOutcome> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		if (shouldAbort()) return { kind: "handled" };
		const editorBindings = this.deps.getEditorBindings();
		const vaultSync = this.deps.getVaultSync();
		const now = Date.now();
		const lockUntil = this.boundRecoveryLocks.get(file.path) ?? 0;
		if (lockUntil > now) {
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, recovery lock)`);
			this.deps.trace("recovery", "recovery-postcondition-skipped", {
				path: file.path,
				reason: "recovery-lock-active",
				lockRemainingMs: lockUntil - now,
			});
			// recovery.skipped: bound recovery lock active.
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: PRODUCT_EVENT_KIND.recoverySkipped,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "recovery-lock-active",
					lockRemainingMs: lockUntil - now,
				},
			});
			// Pauses (or quenched cycles) reset the amplification detector.
			this.amplificationHistory.delete(file.path);
			return { kind: "handled" };
		}
		if (lockUntil > 0) {
			this.boundRecoveryLocks.delete(file.path);
		}

		if (openViews.length === 0) {
			this.deps.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			editorBindings?.unbindByPath(file.path);
			this.deps.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			return { kind: "not-handled" };
		}

		const crdtContent = yTextToString(existingText);
		const mutationTicket = this.captureOpenEditorMutationTicket(file.path, openViews);
		const visibleAuthorityTicket = this.compactVisibleAuthorityTicket(mutationTicket);
		const diskMutationRevision = this.getMarkdownDiskRevision(file.path);
		const lifecycleGeneration = this.lifecycleGeneration;
		const baselineAuthority = {
			hash: this.deps.getDiskIndex()[file.path]?.contentHash ?? null,
			revision: this.diskBaselineRevisions.get(file.path) ?? 0,
		};
		const interceptedCandidate =
			this.interceptedExternalDiskMutations.get(file.path) ?? null;
		const candidateIdentityEpoch = this.getExternalCandidateIdentityEpoch(file.path);
		const diskFileStat =
			typeof file.stat?.mtime === "number" || typeof file.stat?.size === "number"
				? {
					ctime: typeof file.stat?.ctime === "number" ? file.stat.ctime : null,
					mtime: typeof file.stat?.mtime === "number" ? file.stat.mtime : 0,
					size: typeof file.stat?.size === "number" ? file.stat.size : physicalDiskContent.length,
				}
				: null;
		const diskFileRevision =
			typeof file.stat?.ctime === "number" &&
			typeof file.stat?.mtime === "number" &&
			typeof file.stat?.size === "number"
				? {
					ctime: file.stat.ctime,
					mtime: file.stat.mtime,
					size: file.stat.size,
				}
				: undefined;
		let visibleAuthorityMarker = this.visibleAuthorityDeferredPaths.get(file.path) ?? null;
		let mutationTicketStale = false;
		const commitMutation = async <T>(
			stage: string,
			expectedCrdtContent: string | null,
			commit: () => T,
			expectedBaseline?: {
				hash: string | null;
				revision: number;
			},
			ticket: OpenEditorMutationTicket | null = mutationTicket,
		): Promise<OpenEditorDiskMutationCommit<T>> => {
			const attempt = await this.commitOpenEditorDiskMutation({
				path: file.path,
				file,
				expectedDiskContent: physicalDiskContent,
				expectedDiskStat: diskFileStat,
				expectedBaselineHash: expectedBaseline?.hash,
				expectedBaselineRevision: expectedBaseline?.revision,
				expectedLifecycleGeneration: lifecycleGeneration,
				ticket,
				expectedYText: existingText,
				expectedCrdtContent,
				expectedDiskRevision: diskMutationRevision,
				expectedVisibleAuthorityMarker: visibleAuthorityMarker,
				expectedInterceptedCandidate: interceptedCandidate,
				expectedCandidateIdentityEpoch: candidateIdentityEpoch,
				shouldAbort,
				stage,
				commit,
			});
			mutationTicketStale ||= attempt.kind === "stale";
			return attempt;
		};
		const admitOpenFlush = async (input: {
			stage: string;
			reason: string;
			expectedCrdtContent: string | null;
			provisionalBaseline?: boolean;
			ticket?: OpenEditorMutationTicket | null;
			publishVisibleAuthorityContent?: string;
		}): Promise<BoundFileSyncGapOutcome> => {
			const ticket = input.ticket === undefined ? mutationTicket : input.ticket;
			const attempt = await commitMutation(
				input.stage,
				input.expectedCrdtContent,
				() => {
					if (input.publishVisibleAuthorityContent !== undefined) {
						const currentAuthority = this.getOpenEditorAuthority(openViews);
						const compactTicket = this.compactVisibleAuthorityTicket(ticket);
						if (
							!ticket ||
							!compactTicket ||
							currentAuthority.kind !== "single" ||
							currentAuthority.content !== input.publishVisibleAuthorityContent
						) {
							return null;
						}
						const targetMarker: DeferredVisibleEditorAuthority = {
							editorContents: [input.publishVisibleAuthorityContent],
							readComplete: true,
							capturedDiskContent: physicalDiskContent,
							capturedCrdtContent: input.expectedCrdtContent,
							capturedDiskRevision: this.getMarkdownDiskRevision(file.path),
							capturedEditorActivity:
								editorBindings?.getLastEditorActivityForPath(file.path) ?? null,
							capturedEditorTicket: compactTicket,
							capturedAt: Date.now(),
						};
						this.visibleAuthorityDeferredPaths.set(file.path, targetMarker);
						visibleAuthorityMarker = targetMarker;
						this.deps.trace("reconcile", "open-external-target-authority-recaptured", {
							path: file.path,
							stage: input.stage,
							targetLength: input.publishVisibleAuthorityContent.length,
						});
					}
					return Object.freeze<OpenFlushAuthorityLease>({
						path: file.path,
						stage: input.stage,
						expectedDiskFile: file,
						expectedDiskStat: diskFileStat ?? {
							ctime: null,
							mtime: null,
							size: null,
						},
						expectedDiskFileRevision: diskFileRevision,
						expectedDiskEventRevision: diskMutationRevision,
						expectedBaselineHash: baselineAuthority.hash,
						expectedBaselineRevision: baselineAuthority.revision,
						expectedLifecycleGeneration: lifecycleGeneration,
						expectedYText: existingText,
						expectedCrdtContent: input.expectedCrdtContent,
						expectedEditorTicket: ticket,
						expectedVisibleAuthorityMarker: visibleAuthorityMarker,
						expectedInterceptedCandidate: interceptedCandidate,
						expectedCandidateIdentityEpoch: candidateIdentityEpoch,
						shouldAbort,
					});
				},
				baselineAuthority,
				ticket,
			);
			if (attempt.kind === "stale" || attempt.value === null) {
				return this.deferStaleOpenEditorMutation(input.stage);
			}
			return {
				kind: "flush-crdt-to-disk",
				reason: input.reason,
				provisionalBaseline: input.provisionalBaseline,
				authorityLease: attempt.value,
			};
		};
		let deferredVisibleAuthority = this.visibleAuthorityDeferredPaths.get(file.path);
		if (deferredVisibleAuthority) {
			const currentAuthority = this.getOpenEditorAuthority(openViews);
			const currentEditorContents = currentAuthority.kind === "single"
				? [currentAuthority.content]
				: [];
			const currentEditorActivity =
				editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
			const ticketProgress = this.classifyVisibleAuthorityTicketProgress(
				deferredVisibleAuthority.capturedEditorTicket,
				visibleAuthorityTicket,
				currentEditorContents,
				currentAuthority.kind === "single",
			);
			const editorActivityAdvanced =
				currentEditorActivity !== null &&
				(
					deferredVisibleAuthority.capturedEditorActivity === null ||
					currentEditorActivity > deferredVisibleAuthority.capturedEditorActivity
				);
			if (
				currentAuthority.kind === "single" &&
				(
					ticketProgress.kind === "successor" ||
					(ticketProgress.kind === "unavailable" && editorActivityAdvanced)
				)
			) {
				const successorMarker: DeferredVisibleEditorAuthority = {
					editorContents: [currentAuthority.content],
					readComplete: true,
					capturedDiskContent: physicalDiskContent,
					capturedCrdtContent: crdtContent,
					capturedDiskRevision: this.getMarkdownDiskRevision(file.path),
					capturedEditorActivity: currentEditorActivity,
					capturedEditorTicket: visibleAuthorityTicket,
					capturedAt: Date.now(),
				};
				this.visibleAuthorityDeferredPaths.set(file.path, successorMarker);
				visibleAuthorityMarker = successorMarker;
				deferredVisibleAuthority = successorMarker;
				this.deps.trace("reconcile", "visible-editor-authority-successor-accepted", {
					path: file.path,
					stage: "bound-file-sync-gap",
					ticketProgress: ticketProgress.kind,
					editorActivityAdvanced,
					editorLength: currentAuthority.content.length,
				});
			}
			const hasDistinctInterveningEditorAuthority =
				ticketProgress.advancedEditorContents.some(
					(candidate) => !deferredVisibleAuthority!.editorContents.includes(candidate),
				);
			const capturedCrdtAliasCanRetire =
				currentAuthority.kind === "single" &&
				this.isCapturedCrdtAlias(deferredVisibleAuthority) &&
				!hasDistinctInterveningEditorAuthority &&
				ticketProgress.provenNoEditorAuthorityAdvance;
			if (capturedCrdtAliasCanRetire) {
				this.retireCapturedCrdtAlias(
					file.path,
					deferredVisibleAuthority,
					"bound-file-sync-gap",
				);
				visibleAuthorityMarker = null;
				deferredVisibleAuthority = undefined;
			} else {
				const exactCapturedAuthorityStillVisible =
					deferredVisibleAuthority.readComplete &&
					deferredVisibleAuthority.editorContents.length === 1 &&
					currentAuthority.kind === "single" &&
					currentAuthority.content === deferredVisibleAuthority.editorContents[0] &&
					!hasDistinctInterveningEditorAuthority;
				if (!exactCapturedAuthorityStillVisible) {
					const combinedMarker: DeferredVisibleEditorAuthority = {
						...deferredVisibleAuthority,
						editorContents: Array.from(new Set([
							...this.getRetainedVisibleAuthorityContents(
								deferredVisibleAuthority,
								ticketProgress,
							),
							...ticketProgress.advancedEditorContents,
							...currentEditorContents,
						])),
						readComplete: false,
						capturedDiskContent: physicalDiskContent,
						capturedCrdtContent: crdtContent,
						capturedDiskRevision: this.getMarkdownDiskRevision(file.path),
						capturedEditorActivity: currentEditorActivity,
						capturedEditorTicket: visibleAuthorityTicket,
						capturedAt: Date.now(),
					};
					this.visibleAuthorityDeferredPaths.set(file.path, combinedMarker);
					await this.preserveUnresolvedVisibleAuthority(
						file.path,
						combinedMarker,
						content,
						crdtContent ?? "",
						"open-captured-authority-changed-without-settlement",
					);
					this.deps.trace("conflict", "open-captured-editor-authority-preserved", {
						path: file.path,
						currentAuthorityKind: currentAuthority.kind,
						capturedEditorCandidateCount: deferredVisibleAuthority.editorContents.length,
						combinedEditorCandidateCount: combinedMarker.editorContents.length,
					});
					return { kind: "handled" };
				}
			}
		}
		if (crdtContent === content) {
			this.boundRecoveryLocks.delete(file.path);
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, crdt-current)`);
			// recovery.skipped: CRDT and disk already agree (bound second-pass no-op).
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: PRODUCT_EVENT_KIND.recoverySkipped,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "crdt-current-no-op",
					wasBound: true,
				},
			});
			// Convergence reached: amplification detector is reset.
			this.amplificationHistory.delete(file.path);
			return {
				kind: "handled",
				settlement: this.captureBoundFileSettlement(
					file.path,
					content,
					existingText,
					openViews,
				),
			};
		}

		let editorReadFailed = false;
		const viewStates = openViews.map((view) => {
			let editorContent: string | null = null;
			try {
				editorContent = view.editor.getValue();
			} catch {
				editorReadFailed = true;
			}
			const binding = editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = editorBindings?.getCollabDebugInfoForView(view) ?? null;
			return {
				view,
				editorContent,
				editorMatchesDisk: editorContent === content,
				editorMatchesCrdt: crdtContent != null && editorContent === crdtContent,
				binding,
				collab,
			};
		});
		const distinctEditorContentsForPlanner = [...new Set(
			viewStates
				.map((state) => state.editorContent)
				.filter((editorContent): editorContent is string => editorContent !== null),
		)];
		let plannerEditorAuthority: OpenBoundEditorAuthority;
		if (editorReadFailed) {
			plannerEditorAuthority = { kind: "read-failed" };
		} else if (distinctEditorContentsForPlanner.length === 0) {
			plannerEditorAuthority = { kind: "none" };
		} else if (distinctEditorContentsForPlanner.length > 1) {
			plannerEditorAuthority = { kind: "multiple" };
		} else {
			const editorContent = distinctEditorContentsForPlanner[0]!;
			const editorMatchesDisk = editorContent === content;
			const editorMatchesCrdt = crdtContent != null && editorContent === crdtContent;
			plannerEditorAuthority = {
				kind: "single",
				relation: editorMatchesDisk && editorMatchesCrdt
					? "both"
					: (editorMatchesDisk
						? "disk"
						: (editorMatchesCrdt ? "crdt" : "distinct")),
			};
		}
		const lastEditorActivityForPlanner =
			editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
		const hasRecentEditorActivityForPlanner =
			lastEditorActivityForPlanner != null &&
			(now - lastEditorActivityForPlanner) < OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
		const canPlanOpenExternalEdit =
			sourceReason === "modify" &&
			existingText !== null &&
			crdtContent !== null &&
			plannerEditorAuthority.kind === "single" &&
			plannerEditorAuthority.relation === "crdt" &&
			!hasRecentEditorActivityForPlanner;
		if (
			canPlanOpenExternalEdit &&
			existingText !== null &&
			crdtContent !== null
		) {
			const baselineHash = baselineAuthority.hash;
			const baselineRevision = baselineAuthority.revision;
			const baselineText = baselineHash === null
				? null
				: await this.deps.getBaselineText?.(baselineHash) ?? null;
			const externalPlan = planOpenExternalEdit({
				baselineText: baselineText === null ? null : normalizeEditorText(baselineText),
				currentText: normalizeEditorText(crdtContent),
				externalText: normalizeEditorText(content),
			});
			this.deps.trace("reconcile", "open-external-edit-planned", {
				path: file.path,
				kind: externalPlan.kind,
				reason: externalPlan.kind,
				baselineHashPrefix: baselineHash?.slice(0, 12) ?? null,
				rawDiskLength: content.length,
				currentLength: crdtContent.length,
			});

			switch (externalPlan.kind) {
				case "already-settled":
					if (content === externalPlan.targetText) {
						return {
							kind: "handled",
							settlement: this.captureBoundFileSettlement(
								file.path,
								externalPlan.targetText,
								existingText,
								openViews,
							),
						};
					}
					return admitOpenFlush({
						stage: "open-external-representation-normalized",
						reason: "open-external-representation-normalized",
						expectedCrdtContent: crdtContent,
					});
				case "keep-current":
					return admitOpenFlush({
						stage: "open-external-current-only",
						reason: "open-external-current-only",
						expectedCrdtContent: crdtContent,
					});
				case "apply-external":
				case "apply-clean-merge": {
					type FrontmatterAwareMergeResult =
						| { kind: "blocked" }
						| {
							kind: "guard-failed";
							errorCategory: "exception" | "non-error-throw";
						}
						| {
							kind: "observability-failed";
							errorCategory: "exception" | "non-error-throw";
						}
						| { kind: "diff"; result: ExactDiffResult };
					let mergeAttempt: OpenEditorDiskMutationCommit<FrontmatterAwareMergeResult>;
					try {
						mergeAttempt = await commitMutation(
							"open-external-clean-merge",
							crdtContent,
							() => {
								let blocked: boolean;
								try {
									blocked = this.deps.shouldBlockFrontmatterIngest(
										file.path,
										crdtContent,
										externalPlan.targetText,
										"bound-file-open-safe-external-merge",
									);
								} catch (error) {
									return {
										kind: "guard-failed" as const,
										errorCategory: error instanceof Error
											? "exception" as const
											: "non-error-throw" as const,
									};
								}
								if (blocked) {
									try {
										this.traceOpenExternalEvent("open-external-frontmatter-blocked", {
											path: file.path,
											reason: "bound-file-open-safe-external-merge",
											diskLength: content.length,
											currentLength: crdtContent.length,
											targetLength: externalPlan.targetText.length,
										});
										this.recordFrontmatterIngestBlocked(
											file.path,
											true,
											"bound-file-open-safe-external-merge",
										);
										this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
										return { kind: "blocked" as const };
									} catch (error) {
										return {
											kind: "observability-failed" as const,
											errorCategory: error instanceof Error
												? "exception" as const
												: "non-error-throw" as const,
										};
									}
								}
								editorBindings?.separateUndoCaptureForPath(file.path);
								try {
									return {
										kind: "diff" as const,
										result: applyExactDiffToYText(
											existingText,
											crdtContent,
											externalPlan.targetText,
											ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
										),
									};
								} finally {
									editorBindings?.separateUndoCaptureForPath(file.path);
								}
							},
							{ hash: baselineHash, revision: baselineRevision },
						);
					} catch (error) {
						const reason = "open-external-targeted-diff-failed";
						this.deps.getDiskMirror()?.recordPreservedUnresolved?.(
							file.path,
							reason,
						);
						this.deps.trace("reconcile", "open-external-targeted-diff-failed", {
							path: file.path,
							reason,
							errorCategory: error instanceof Error ? "exception" : "non-error-throw",
						});
						return { kind: "handled" };
					}
					if (mergeAttempt.kind === "stale") {
						return this.deferStaleOpenEditorMutation("open-external-clean-merge");
					}
					if (mergeAttempt.value.kind === "guard-failed") {
						this.deps.trace("reconcile", "open-external-frontmatter-guard-failed", {
							path: file.path,
							reason: "bound-file-open-safe-external-merge",
							errorCategory: mergeAttempt.value.errorCategory,
						});
						return this.deferStaleOpenEditorMutation(
							"open-external-frontmatter-guard-failed",
						);
					}
					if (mergeAttempt.value.kind === "observability-failed") {
						try {
							this.deps.trace(
								"reconcile",
								"open-external-frontmatter-observability-failed",
								{
									path: file.path,
									reason: "bound-file-open-safe-external-merge",
									errorCategory: mergeAttempt.value.errorCategory,
								},
							);
						} catch {
							// Observability failure must not escape into the mutation path.
						}
						return this.deferStaleOpenEditorMutation(
							"open-external-frontmatter-observability-failed",
						);
					}
					if (mergeAttempt.value.kind === "blocked") {
						return { kind: "handled" };
					}
					switch (mergeAttempt.value.result.kind) {
						case "stale-base":
							return this.deferStaleOpenEditorMutation("open-external-clean-merge");
						case "postcondition-failed":
							this.deps.getDiskMirror()?.recordPreservedUnresolved?.(
								file.path,
								"open-external-targeted-diff-failed",
							);
							return { kind: "handled" };
						case "unchanged":
						case "applied":
							this.traceOpenExternalEvent("open-external-clean-merge-applied", {
								path: file.path,
								reason: externalPlan.kind,
								diskLength: content.length,
								currentLength: crdtContent.length,
								targetLength: externalPlan.targetText.length,
							});
							return admitOpenFlush({
								stage: "open-external-clean-merge-flush",
								reason: externalPlan.kind,
								expectedCrdtContent: externalPlan.targetText,
								ticket: this.captureOpenEditorMutationTicket(file.path, openViews),
								publishVisibleAuthorityContent: externalPlan.targetText,
							});
						}
					throw new Error("unreachable open-external exact diff result");
				}
				case "preserve-conflict": {
					const artifactContent =
						interceptedCandidate &&
						this.externalCandidateMatchesStableDisk(
							interceptedCandidate.content,
							content,
						)
							? interceptedCandidate.content
							: content;
					await this.recordDiscardedRevision(
						file.path,
						artifactContent,
						`open-external-${externalPlan.reason}`,
					);
					const conflictAdmission = await commitMutation(
						"open-external-conflict-settlement",
						crdtContent,
						() => undefined,
						{ hash: baselineHash, revision: baselineRevision },
					);
					if (conflictAdmission.kind === "stale") {
						return this.deferStaleOpenEditorMutation(
							"open-external-conflict-settlement",
						);
					}
					if (externalPlan.reason === "overlapping-hunks") {
						this.traceOpenExternalEvent("open-external-overlapping-hunk-discarded", {
							path: file.path,
							reason: "overlapping-hunks",
							diskLength: content.length,
							currentLength: crdtContent.length,
							hunkCount: externalPlan.hunkCount,
						});
					}
					return admitOpenFlush({
						stage: "open-external-conflict-flush",
						provisionalBaseline: true,
						reason: `open-external-${externalPlan.reason}`,
						expectedCrdtContent: crdtContent,
					});
				}
			}
		}
		let openBoundAction: OpenBoundFileReconcileAction | null = null;
		if (existingText && crdtContent != null) {
			const diskHash = await contentBaselineHash(content);
			const crdtHash = await contentBaselineHash(crdtContent);
			const baselineHash = baselineAuthority.hash;
			const rawLastSave = this.deps.getLastSaveDiskIndexAt?.();
			const lastDiskIndexPersistedAt =
				typeof rawLastSave === "number" &&
				Number.isFinite(rawLastSave) &&
				rawLastSave > 0 &&
				rawLastSave <= now
					? rawLastSave
					: undefined;
			openBoundAction = planOpenBoundFileReconcile({
				diskHash,
				crdtHash,
				baselineHash,
				editorAuthority: plannerEditorAuthority,
				hasRecentEditorActivity: hasRecentEditorActivityForPlanner,
				diskMtime: stableStat?.mtime,
				lastDiskIndexPersistedAt,
			});
			this.deps.trace("reconcile", "bound-file-open-planner-decision", {
				path: file.path,
				action: openBoundAction.kind,
				reason: openBoundAction.reason,
				diskLength: content.length,
				crdtLength: crdtContent.length,
				baselineHash,
				editorAuthority: plannerEditorAuthority,
				hasRecentEditorActivity: hasRecentEditorActivityForPlanner,
				diskMtime: stableStat?.mtime ?? null,
				lastDiskIndexPersistedAt: lastDiskIndexPersistedAt ?? null,
			});
		}
		const localOnlyViews = viewStates.filter(
			(state) => state.editorMatchesDisk && !state.editorMatchesCrdt,
		);
		const crdtOnlyViews = viewStates.filter(
			(state) => state.editorMatchesCrdt && !state.editorMatchesDisk,
		);
		let plannerConflictPreserved = false;
		let settlementYText = existingText;
		if (
			plannerEditorAuthority.kind === "multiple" ||
			plannerEditorAuthority.kind === "read-failed" ||
			plannerEditorAuthority.kind === "none"
		) {
			const marker: DeferredVisibleEditorAuthority = {
				editorContents: distinctEditorContentsForPlanner,
				readComplete: !editorReadFailed,
				capturedDiskContent: physicalDiskContent,
				capturedCrdtContent: crdtContent,
				capturedDiskRevision: this.getMarkdownDiskRevision(file.path),
				capturedEditorActivity: lastEditorActivityForPlanner,
				capturedEditorTicket: visibleAuthorityTicket,
				capturedAt: Date.now(),
			};
			this.visibleAuthorityDeferredPaths.set(file.path, marker);
			await this.preserveUnresolvedVisibleAuthority(
				file.path,
				marker,
				content,
				crdtContent ?? "",
				`open-${plannerEditorAuthority.kind}`,
			);
			this.deps.trace("conflict", "open-multiple-editor-authority-failed-closed", {
				path: file.path,
				reason: openBoundAction?.reason ?? plannerEditorAuthority.kind,
				openViewCount: viewStates.length,
				editorCandidateCount: distinctEditorContentsForPlanner.length,
				diskLength: content.length,
				crdtLength: crdtContent?.length ?? null,
			});
			this.deps.scheduleTraceStateSnapshot("open-multiple-editor-authority-unresolved");
			return { kind: "handled" };
		}
		if (
			openBoundAction?.kind === "defer-recent-editor" &&
			localOnlyViews.length === 0 &&
			crdtOnlyViews.length === 0
		) {
			const deferUntil =
				(lastEditorActivityForPlanner ?? Date.now()) + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
			const idleMs = lastEditorActivityForPlanner == null
				? null
				: Math.max(0, Date.now() - lastEditorActivityForPlanner);
			this.deps.log(
				`syncFileFromDisk: deferring "${file.path}" ` +
				`(editor-bound recent typing${idleMs == null ? "" : ` ${idleMs}ms ago`})`,
			);
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: PRODUCT_EVENT_KIND.recoverySkipped,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "recent-editor-activity-local-only",
					idleMs,
				},
			});
			this.traceOpenExternalEvent("open-external-recent-typing-deferred", {
				path: file.path,
				reason: "recent-editor-activity-local-only",
				diskLength: content.length,
				currentLength: crdtContent?.length ?? null,
				deferMs: Math.max(0, deferUntil - Date.now()),
			});
			this.amplificationHistory.delete(file.path);
			return {
				kind: "deferred",
				deferUntil,
				reason: "recent-editor-activity-local-only",
			};
		}

		if (localOnlyViews.length > 0) {
			this.deps.trace("trace", "bound-file-local-only-divergence", {
				path: file.path,
				diskLength: content.length,
				crdtLength: crdtContent?.length ?? null,
				viewCount: localOnlyViews.length,
				views: localOnlyViews.map((state) => ({
					leafId: state.binding?.leafId ?? null,
					storedCmId: state.binding?.storedCmId ?? null,
					liveCmId: state.binding?.liveCmId ?? null,
					cmMatches: state.binding?.cmMatches ?? null,
					hasSyncFacet: state.collab?.hasSyncFacet ?? null,
					awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
					yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
					undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
					facetFileId: state.collab?.facetFileId ?? null,
					expectedFileId: state.collab?.expectedFileId ?? null,
				})),
			});

			if (existingText && openBoundAction?.kind === "apply-crdt-to-disk") {
				if (openBoundAction.preserveDisk) {
					const preserved = await this.preserveOpenBoundPlannerConflict({
						file,
						diskContent: content,
						crdtContent: crdtContent ?? "",
						expectedYText: existingText,
						targetContent: undefined,
						reason: `bound-file-${openBoundAction.reason}`,
						preserveDisk: true,
						preserveCrdt: false,
						editorViewCount: viewStates.length,
						distinctEditorContentCount: distinctEditorContentsForPlanner.length,
						chosenSource: "crdt",
					});
					if (!preserved) {
						return { kind: "handled" };
					}
					plannerConflictPreserved = true;
				}
				this.deps.scheduleTraceStateSnapshot("bound-file-open-planner-crdt-wins");
				return admitOpenFlush({
					stage: "bound-file-local-only-planner-crdt-flush",
					provisionalBaseline: plannerConflictPreserved,
					reason: `bound-file-${openBoundAction.reason}`,
					expectedCrdtContent: crdtContent,
				});
			}

			if (existingText && openBoundAction?.kind === "editor-wins-preserve") {
				const editorAuthority =
					distinctEditorContentsForPlanner.length === 1
						? distinctEditorContentsForPlanner[0]!
						: null;
				if (editorAuthority === null) {
					return { kind: "handled" };
				}
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
					expectedYText: existingText,
					targetContent: editorAuthority,
					commitTarget: (commit) => commitMutation(
						"open-bound-planner-editor-wins",
						crdtContent,
						commit,
					),
					reason: `bound-file-${openBoundAction.reason}`,
					preserveDisk: !!openBoundAction.preserveDisk,
					preserveCrdt: !!openBoundAction.preserveCrdt,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "editor",
				});
				if (!preserved) {
					if (mutationTicketStale) {
						return this.deferStaleOpenEditorMutation("open-bound-planner-editor-wins");
					}
					return { kind: "handled" };
				}
				this.deps.scheduleTraceStateSnapshot("bound-file-open-planner-editor-wins");
				return { kind: "handled" };
			}

			if (existingText && openBoundAction?.kind === "import-disk-to-crdt" && openBoundAction.preserveCrdt) {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
					expectedYText: existingText,
					targetContent: undefined,
					reason: `bound-file-${openBoundAction.reason}`,
					preserveDisk: false,
					preserveCrdt: true,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "disk",
				});
				if (!preserved) {
					return { kind: "handled" };
				}
				plannerConflictPreserved = true;
			}

			if (existingText) {
				// Localized idle guard: defer recovery if the user just typed.
				// The localOnly branch is the typing-cadence amplifier shape:
				// editor matches disk but CRDT trails, repeatedly, because
				// Obsidian autosave lands keystrokes faster than the
				// y-codemirror.next plumbing propagates them into Y.Text.
				// Quenching that loop requires a window longer than a typical
				// human typing burst.
				const lastEditorActivityLocalOnly =
					editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
				if (
					lastEditorActivityLocalOnly !== null
					&& (Date.now() - lastEditorActivityLocalOnly) < OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS
				) {
					const idleMs = Date.now() - lastEditorActivityLocalOnly;
					this.deps.log(
						`syncFileFromDisk: deferring "${file.path}" ` +
						`(editor-bound local-only, recent typing ${idleMs}ms ago)`,
					);
					this.deps.recordFlightPathEvent?.({
						priority: "verbose",
						kind: PRODUCT_EVENT_KIND.recoverySkipped,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "recovery",
						path: file.path,
						data: {
							reason: "recent-editor-activity-local-only",
							idleMs,
						},
						});
						this.traceOpenExternalEvent("open-external-recent-typing-deferred", {
							path: file.path,
							reason: "recent-editor-activity-local-only",
							diskLength: content.length,
							currentLength: crdtContent?.length ?? null,
							deferMs: Math.max(
								0,
								lastEditorActivityLocalOnly + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS - Date.now(),
							),
						});
						// Pauses reset the amplification detector. See spec R3.8.
						this.amplificationHistory.delete(file.path);
						return {
							kind: "deferred",
							deferUntil: lastEditorActivityLocalOnly + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
							reason: "recent-editor-activity-local-only",
						};
					}

				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-local-only-divergence",
					)) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-divergence");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return { kind: "handled" };
					}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound local-only divergence: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				this.deps.trace("trace", "bound-file-recovery-source-selected", {
					path: file.path,
					reason: "bound-file-local-only-divergence",
					chosenSource: "disk",
					action: "applied-repair-only",
					editorLengths: localOnlyViews.map((state) => state.editorContent?.length ?? 0),
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
				});
			// recovery.decision: emit before quarantine check so even quarantined cases are visible
			const _rsh1 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
			// Snapshot binding health across all localOnly views. Surfaces in
			// the trace why we may or may not also call repair() on the views
			// after the diff applies. See spec R7.
			const _localOnlyHealth = localOnlyViews.map((state) => ({
				leafId: state.binding?.leafId ?? null,
				...classifyBindingHealth(state.binding, state.collab),
			}));
			const _localOnlyAnyUnhealthy = _localOnlyHealth.some((h) => !h.healthy);
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-local-only-divergence",
					signature: computeRecoveryFingerprint("bound-file-local-only-divergence", crdtContent ?? "", content),
					action: "apply-diff",
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
					// Branch predicates — makes traces self-documenting
					editorEqualsDisk: localOnlyViews.length > 0,
					editorEqualsCrdt: false,
					diskFingerprintPrefix: contentFingerprint(content).slice(0, 8),
					crdtFingerprintPrefix: crdtContent ? contentFingerprint(crdtContent).slice(0, 8) : null,
					// Binding-health diagnostic surface (Reviewer item 2/3): lets
					// future RCAs see why repair was or wasn't called per view
					// without grepping the source.
					bindingHealth: _localOnlyHealth,
					anyBindingUnhealthy: _localOnlyAnyUnhealthy,
					...(_rsh1 ? { recoveryStateHash: _rsh1 } : {}),
				},
			});
				// Monotonic-growth amplification quarantine: independent of
				// fingerprint identity. Catches typing-cadence loops where every
				// cycle has a different (prevLen, nextLen) but the lengths grow
				// along the same axis.
				if (this.shouldQuarantineAmplification(
					file.path,
					"bound-file-local-only-divergence",
					crdtContent?.length ?? 0,
					content.length,
				)) {
					return { kind: "handled" };
				}
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-divergence",
					crdtContent ?? "",
					content,
				)) {
					return { kind: "handled" };
				}
				if (shouldAbort()) return { kind: "handled" };
				// recovery.apply.start: before the actual diff application
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-divergence",
						origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
						diskLength: content.length,
						crdtLength: crdtContent?.length ?? null,
					},
				});
				const recoveryAttempt = await commitMutation(
					"bound-file-local-only-divergence",
					crdtContent,
					() => applyDiffToYTextWithPostcondition(
						existingText,
						crdtContent ?? "",
						content,
						ORIGIN_DISK_SYNC_RECOVER_BOUND,
					),
				);
				if (recoveryAttempt.kind === "stale") {
					return this.deferStaleOpenEditorMutation("bound-file-local-only-divergence");
				}
				const recoveryResult = recoveryAttempt.value;
			traceRecoveryPostcondition(
				(source, msg, details) => this.deps.trace(source, msg, details),
				(event) => this.deps.recordFlightPathEvent?.(event),
				file.path,
				"bound-file-local-only-divergence",
				ORIGIN_DISK_SYNC_RECOVER_BOUND,
				content.length,
				recoveryResult,
			);
				this.deps.recordFlightPathEvent?.({
					priority: recoveryResult.forceReplaceApplied ? "critical" : "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyDone,
					severity: recoveryResult.finalMatchesExpected ? "info" : "warn",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-divergence",
						origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
						expectedLength: content.length,
						actualLength: recoveryResult.finalLength,
						matchesExpected: recoveryResult.finalMatchesExpected,
						forceReplaceApplied: recoveryResult.forceReplaceApplied,
					},
				});
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-local-only-seed",
					)) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-seed");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return { kind: "handled" };
					}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				const _rsh2 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-seed",
						signature: computeRecoveryFingerprint("bound-file-local-only-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
						...(_rsh2 ? { recoveryStateHash: _rsh2 } : {}),
					},
				});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-seed",
					"",
					content,
				)) {
					return { kind: "handled" };
				}
				if (shouldAbort()) return { kind: "handled" };
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: { reason: "bound-file-local-only-seed", action: "seed-crdt-from-disk", diskLength: content.length },
				});
				const seedAttempt = await commitMutation(
					"bound-file-local-only-seed",
					null,
					() => vaultSync?.ensureFile(
						file.path,
						content,
						this.deps.getSettings().deviceName,
						{
							reviveTombstone: sourceReason === "create",
							reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
						},
					),
				);
				if (seedAttempt.kind === "stale") {
					return this.deferStaleOpenEditorMutation("bound-file-local-only-seed");
				}
				const ensureResult = seedAttempt.value;
				if (!ensureResult) {
					return this.deferStaleOpenEditorMutation("bound-file-local-only-seed");
				}
				let seededText: NonNullable<ReturnType<VaultSync["getTextForPath"]>>;
				switch (ensureResult.kind) {
					case "created":
					case "existing":
						seededText = ensureResult.ytext;
						break;
					case "replan":
						return this.deferStaleOpenEditorMutation("bound-file-local-only-seed-replan");
					case "blocked":
						this.deps.log(
							`syncFileFromDisk: controller admission blocked for "${file.path}" (${ensureResult.reason})`,
						);
						return this.deferStaleOpenEditorMutation("bound-file-local-only-seed-blocked");
					default:
						assertNever(ensureResult);
				}
				const currentSeededText = vaultSync?.getTextForPath(file.path) ?? null;
				const recoveredContent = yTextToString(currentSeededText);
				const seedSettled =
					seededText !== null &&
					currentSeededText === seededText &&
					recoveredContent === content;
				this.deps.trace("recovery", "recovery-postcondition-observed", {
					path: file.path,
					reason: "bound-file-local-only-seed",
					origin: "ensureFile",
					expectedLength: content.length,
					actualLength: recoveredContent?.length ?? null,
					matchesExpected: seedSettled,
					matchesAfterDiff: seedSettled,
					enforced: true,
					forceReplaceApplied: false,
				});
				if (!seedSettled) {
					return this.deferStaleOpenEditorMutation("bound-file-local-only-seed");
				}
				settlementYText = seededText;
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);

			// Binding-health-conditional repair.
			//
			// The original code reconfigured the CodeMirror compartment via
			// editorBindings.repair() on EVERY localOnly recovery cycle, even
			// when the binding was healthy. Each reconfigure adds jitter to
			// the editor↔ytext propagation and contributed to the typing-
			// cadence amplifier loop captured in the 2026-05-27 iPad trace.
			//
			// New rule: only repair when the captured binding/collab debug
			// info shows actual unhealth. A healthy binding does NOT need
			// to be reconfigured just because content recovery happened.
			//
			// Two operations are now distinct:
			//   - content recovery (always run when the predicate is met)
			//   - editor binding repair (run only when health markers fail)
			for (const state of localOnlyViews) {
				const health = classifyBindingHealth(state.binding, state.collab);
				if (health.healthy) {
					this.deps.trace("recovery", "binding-healthy-skipped-repair", {
						path: file.path,
						leafId: state.binding?.leafId ?? null,
						cmMatches: state.binding?.cmMatches ?? null,
						hasSyncFacet: state.collab?.hasSyncFacet ?? null,
						yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
					});
					continue;
				}
				this.deps.trace("recovery", "binding-unhealthy-repairing", {
					path: file.path,
					leafId: state.binding?.leafId ?? null,
					reasons: health.reasons,
				});
				const repaired = editorBindings?.repair(
					state.view,
					this.deps.getSettings().deviceName,
					"bound-file-local-only-divergence",
				) ?? false;
				if (!repaired) {
					editorBindings?.rebind(
						state.view,
						this.deps.getSettings().deviceName,
						"bound-file-local-only-divergence",
					);
				}
				}

			this.deps.scheduleTraceStateSnapshot("bound-file-desync-recovery");
			return {
				kind: "handled",
				settlement: !plannerConflictPreserved
					? this.captureBoundFileSettlement(
						file.path,
						content,
						settlementYText,
						openViews,
					)
					: undefined,
			};
		}

		if (crdtOnlyViews.length > 0) {
			// `crdtOnlyViews` is derived from editor===CRDT, so this branch must
			// always retain one exact live Y.Text authority. If that classification
			// invariant is ever violated, fail closed and let a fresh plan reclassify
			// the replicas; never manufacture a replacement CRDT authority here.
			if (existingText === null || crdtContent === null) {
				this.deps.trace("recovery", "bound-file-crdt-only-invariant-violated", {
					path: file.path,
					reason: "missing-live-crdt-authority",
				});
				return this.deferStaleOpenEditorMutation(
					"bound-file-crdt-only-missing-authority",
				);
			}
			if (
				existingText &&
				openBoundAction?.kind === "import-disk-to-crdt" &&
				this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
				)
			) {
				// The frontmatter guard is a stronger, user-visible pause than the
				// normal visible-editor conflict policy. Keep both replicas untouched
				// and retain its established recovery.skipped diagnostic contract.
				this.recordFrontmatterIngestBlocked(
					file.path,
					true,
					"bound-file-open-idle-disk-recovery",
				);
				this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
				return { kind: "handled" };
			}
			if (existingText && openBoundAction?.kind === "import-disk-to-crdt") {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
					expectedYText: existingText,
					targetContent: undefined,
					reason: "bound-file-visible-editor-authority",
					preserveDisk: true,
					preserveCrdt: false,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "crdt",
				});
				if (!preserved) return { kind: "handled" };
				this.deps.scheduleTraceStateSnapshot("bound-file-visible-editor-authority");
				return admitOpenFlush({
					stage: "bound-file-visible-editor-authority-flush",
					provisionalBaseline: true,
					reason: "bound-file-visible-editor-authority",
					expectedCrdtContent: crdtContent,
				});
			}
			if (existingText && openBoundAction?.kind === "apply-crdt-to-disk") {
				if (openBoundAction.preserveDisk) {
					const preserved = await this.preserveOpenBoundPlannerConflict({
						file,
						diskContent: content,
						crdtContent: crdtContent ?? "",
						expectedYText: existingText,
						targetContent: undefined,
						reason: `bound-file-${openBoundAction.reason}`,
						preserveDisk: true,
						preserveCrdt: false,
						editorViewCount: viewStates.length,
						distinctEditorContentCount: distinctEditorContentsForPlanner.length,
						chosenSource: "crdt",
					});
					if (!preserved) {
						return { kind: "handled" };
					}
					plannerConflictPreserved = true;
				}
				this.deps.scheduleTraceStateSnapshot("bound-file-open-planner-crdt-wins");
				return admitOpenFlush({
					stage: "bound-file-crdt-only-planner-crdt-flush",
					provisionalBaseline: plannerConflictPreserved,
					reason: `bound-file-${openBoundAction.reason}`,
					expectedCrdtContent: crdtContent,
				});
			}

			if (existingText && openBoundAction?.kind === "editor-wins-preserve") {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
					expectedYText: existingText,
					targetContent: undefined,
					reason: `bound-file-${openBoundAction.reason}`,
					preserveDisk: !!openBoundAction.preserveDisk,
					preserveCrdt: !!openBoundAction.preserveCrdt,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "crdt",
				});
				if (!preserved) {
					return { kind: "handled" };
				}
				plannerConflictPreserved = true;
				this.deps.scheduleTraceStateSnapshot("bound-file-open-planner-editor-crdt-wins");
				return admitOpenFlush({
					stage: "bound-file-crdt-only-editor-winner-flush",
					provisionalBaseline: true,
					reason: `bound-file-${openBoundAction.reason}`,
					expectedCrdtContent: crdtContent,
				});
			}

			if (existingText && openBoundAction?.kind === "import-disk-to-crdt" && openBoundAction.preserveCrdt) {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
					expectedYText: existingText,
					targetContent: undefined,
					reason: `bound-file-${openBoundAction.reason}`,
					preserveDisk: false,
					preserveCrdt: true,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "disk",
				});
				if (!preserved) {
					return { kind: "handled" };
				}
				plannerConflictPreserved = true;
			}

			const lastEditorActivity = editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
			const hasRecentEditorActivity = lastEditorActivity != null
				&& (Date.now() - lastEditorActivity) < OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS;
			if (hasRecentEditorActivity) {
				this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, disk lag)`);
				// recovery.skipped: crdtOnly branch idle-grace bail.
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: PRODUCT_EVENT_KIND.recoverySkipped,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
						path: file.path,
						data: {
							reason: "recent-editor-activity",
							idleMs: Date.now() - lastEditorActivity,
					},
					});
					this.traceOpenExternalEvent("open-external-recent-typing-deferred", {
						path: file.path,
						reason: "recent-editor-activity",
						diskLength: content.length,
						currentLength: crdtContent?.length ?? null,
						deferMs: Math.max(
							0,
							lastEditorActivity + OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS - Date.now(),
						),
					});
					return {
						kind: "deferred",
						deferUntil: lastEditorActivity + OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS,
						reason: "recent-editor-activity",
					};
				}

			// bound-file-open-idle-disk-recovery is abolished: an open editor
			// that agrees with CRDT is never rewritten from a disk snapshot —
			// that application is exactly the "text jumped back a few seconds"
			// symptom. The disk change stays in the dirty lane and is ingested
			// by the open-external-edit merge lane once the editor has been
			// idle long enough (>= 3s), or by the closed-dirty lane after the
			// note closes.
			this.deps.trace("reconcile", "open-file-disk-change-deferred", {
				path: file.path,
				reason: "open-editor-authority-preserved",
				diskLength: content.length,
				crdtLength: crdtContent?.length ?? null,
				idleMs: lastEditorActivity === null
					? null
					: Math.max(0, Date.now() - lastEditorActivity),
			});
			return {
				kind: "deferred",
				deferUntil: Date.now() + OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS,
				reason: "open-editor-authority-preserved",
			};
		}

		this.deps.trace("trace", "bound-file-ambiguous-divergence", {
			path: file.path,
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			views: viewStates.map((state) => ({
				leafId: state.binding?.leafId ?? null,
				storedCmId: state.binding?.storedCmId ?? null,
				liveCmId: state.binding?.liveCmId ?? null,
				cmMatches: state.binding?.cmMatches ?? null,
				editorMatchesDisk: state.editorMatchesDisk,
				editorMatchesCrdt: state.editorMatchesCrdt,
				hasSyncFacet: state.collab?.hasSyncFacet ?? null,
				awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
				yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
				undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
				facetFileId: state.collab?.facetFileId ?? null,
				expectedFileId: state.collab?.expectedFileId ?? null,
			})),
		});
		const distinctEditorContents = [...new Set(viewStates.map((state) => state.editorContent))];
		const editorAuthority: string | null = distinctEditorContents.length === 1
			? distinctEditorContents[0]!
			: null;

		// With conflict-artifact preservation abolished, the losing sides of an
		// ambiguous divergence are recorded (trace + durable server audit)
		// instead of written as artifacts. crdtContent remains recoverable from
		// the CRDT journal/snapshots; diskContent stays on disk until the
		// convergence flush below.
		if (crdtContent != null) {
			await this.recordDiscardedRevision(
				file.path,
				crdtContent,
				"bound-file-ambiguous-divergence",
			);
			if (
				editorAuthority !== null &&
				content !== editorAuthority &&
				content !== crdtContent
			) {
				await this.recordDiscardedRevision(
					file.path,
					content,
					"bound-file-ambiguous-divergence-disk",
				);
			}
		}

		// Converge the original path's CRDT to the visible editor content so
		// the same ambiguity does not re-trigger on the next reconcile.
		let convergenceApplied = false;
		let convergenceStale = false;
		if (editorAuthority !== null && existingText) {
			const convergenceAttempt = await commitMutation(
				"bound-file-ambiguous-convergence",
				crdtContent,
				() => {
					const result = applyDiffToYTextWithPostcondition(
						existingText,
						crdtContent ?? "",
						editorAuthority,
						ORIGIN_DISK_SYNC_RECOVER_BOUND,
					);
					return result.finalMatchesExpected;
				},
			);
			if (convergenceAttempt.kind === "stale") {
				convergenceStale = true;
			} else {
				convergenceApplied = convergenceAttempt.value;
			}
		}

		this.deps.trace("conflict", "conflict-revision-discarded", {
			path: file.path,
			reason: "bound-file-ambiguous-divergence",
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			editorViewCount: viewStates.length,
			distinctEditorContentCount: distinctEditorContents.length,
			chosenSource: editorAuthority === null ? "none-multiple-editor-contents" : "editor",
			convergenceApplied,
		});
		this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.deps.scheduleTraceStateSnapshot("bound-file-ambiguous");
		if (convergenceStale) {
			return this.deferStaleOpenEditorMutation("bound-file-ambiguous-convergence");
		}
		return { kind: "handled" };
	}

	/**
	 * Single private helper that owns every `recovery.skipped` emission
	 * with `data.reason === "frontmatter-ingest-blocked"`.
	 *
	 * Invoked from every `shouldBlockFrontmatterIngest` branch that would
	 * otherwise mutate Y.Text. The `branch` parameter describes the semantic
	 * admission lane; startup reconciliation and untracked import reuse
	 * `disk-to-crdt-seed` because they are alternate entry points to the same
	 * seed operation. New semantic lanes require extending the closed
	 * `FrontmatterIngestBlockBranch` union.
	 *
	 * The pre-existing `scheduleTraceStateSnapshot("frontmatter-ingest-blocked")`
	 * calls in the four bound branches are intentionally retained as a
	 * legacy diagnostic channel; this helper is additive.
	 */
	private recordFrontmatterIngestBlocked(
		path: string,
		wasBound: boolean,
		branch: FrontmatterIngestBlockBranch,
	): void {
		const data: RecoverySkippedFrontmatterData = {
			reason: "frontmatter-ingest-blocked",
			wasBound,
			branch,
		};
		this.deps.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.recoverySkipped,
			severity: "info",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data,
		});
	}

	private shouldQuarantineRepeatedRecovery(
		path: string,
		reason: string,
		previousContent: string,
		nextContent: string,
	): boolean {
		const fingerprint = computeRecoveryFingerprint(reason, previousContent, nextContent);
		const now = Date.now();
		const previous = this.recoveryFingerprints.get(path);

		// Evaluate using pure policy function.
		const decision = evaluateFingerprintQuarantine({
			fingerprint,
			now,
			previous,
		});

		// Update state (side effect kept in controller).
		this.recoveryFingerprints.set(path, decision.newEntry);

		// Cap map size: evict oldest entries when exceeded.
		if (this.recoveryFingerprints.size > FINGERPRINT_MAP_MAX_SIZE) {
			const oldestPath = findOldestFingerprintEntry(this.recoveryFingerprints);
			if (oldestPath) this.recoveryFingerprints.delete(oldestPath);
		}

		if (!decision.quarantined) return false;

		const count = decision.newEntry.count;
		this.deps.trace("recovery", "recovery-quarantined", {
			path,
			reason,
			repeatCount: count,
			signature: fingerprint,
			previousLength: previousContent.length,
			nextLength: nextContent.length,
			previousHashPrefix: contentFingerprint(previousContent),
			nextHashPrefix: contentFingerprint(nextContent),
		});
		this.deps.log(
			`syncFileFromDisk: quarantined repeated recovery for "${path}" ` +
			`(${reason}, ${count} attempts)`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryQuarantined,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				repeatCount: count,
				signature: fingerprint,
				reason,
				previousLength: previousContent.length,
				nextLength: nextContent.length,
			},
		});
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryLoopDetected,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				repeatCount: count,
				signature: fingerprint,
				reason,
			},
		});
		this.deps.scheduleTraceStateSnapshot("recovery-quarantined");
		return true;
	}

	/**
	 * Monotonic-growth amplification quarantine.
	 *
	 * Independent of fingerprint identity. Catches loops where every cycle
	 * has a different `(prevLen, nextLen)` fingerprint but the lengths grow
	 * along the same axis — the typing-cadence amplifier shape captured in a
	 * real mobile reproduction trace whose identifiers are intentionally omitted.
	 */
	private shouldQuarantineAmplification(
		path: string,
		reason: string,
		prevLen: number,
		nextLen: number,
	): boolean {
		const now = Date.now();
		const existing = this.amplificationHistory.get(path) ?? [];

		// Evaluate using pure policy function.
		const decision = evaluateAmplificationQuarantine({
			prevLen,
			nextLen,
			now,
			history: existing,
		});

		if (!decision.quarantined) {
			// Update state (side effect kept in controller).
			this.amplificationHistory.set(path, decision.newHistory);

			// Cap global map size — share the same limit as recoveryFingerprints
			// so a single tunable governs both detectors' memory footprint.
			if (this.amplificationHistory.size > FINGERPRINT_MAP_MAX_SIZE) {
				const oldestPath = findOldestAmplificationEntry(
					this.amplificationHistory,
					path, // exclude current path from eviction
				);
				if (oldestPath) {
					this.amplificationHistory.delete(oldestPath);
				}
			}

			return false;
		}

		// Quarantine triggered — emit side effects.
		const { triggerSlice, consistentDelta, firstPrevLen, lastNextLen } = decision;

		this.deps.trace("recovery", "recovery-amplification-quarantined", {
			path,
			reason,
			entries: triggerSlice.length,
			windowMs: AMPLIFICATION_WINDOW_MS,
			firstPrevLen,
			lastNextLen,
			consistentDelta,
		});
		this.deps.log(
			`syncFileFromDisk: amplification-quarantined "${path}" ` +
			`(${reason}, ${triggerSlice.length} cycles, ${firstPrevLen} -> ${lastNextLen}, ` +
			`consistentDelta=${consistentDelta})`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryAmplificationQuarantined,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				entries: triggerSlice.length,
				windowMs: AMPLIFICATION_WINDOW_MS,
				firstPrevLen,
				lastNextLen,
				consistentDelta,
			},
		});
		// Also emit recovery.loop.detected so existing loop-detection consumers
		// see this case. See spec R3.5.
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryLoopDetected,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				detector: "amplification",
				entries: triggerSlice.length,
			},
		});
		this.deps.scheduleTraceStateSnapshot("recovery-amplification-quarantined");
		// User-visible notice. Throttled and silent on every cycle in
		// production, but the user gets at least one warning per minute
		// when amplification quarantine is firing — better than a silent
		// quarantine.
		const fileName = path.split("/").pop() ?? path;
		this.showAmplificationNotice(
			`Recovery loop detected for "${fileName}" — paused content recovery. ` +
			`Try closing and reopening the note, or wait for sync to settle.`,
		);
		// Drop the path's history so subsequent recoveries are evaluated
		// against a fresh window (the path has been quarantined; analyzer
		// or user intervention will resolve the divergence).
		this.amplificationHistory.delete(path);
		return true;
	}

	private async updateDiskIndexForPath(
		path: string,
		settledContent?: string,
		stableStat?: { mtime: number; size: number } | null,
		options: {
			expectedPreservedUnresolvedEpisodeId?: string;
			expectedDiskFile?: TFile;
			expectedYText?: ReturnType<VaultSync["getTextForPath"]>;
			expectedCrdtContent?: string | null;
			expectedEditorTicket?: OpenEditorMutationTicket;
			expectedOpenEditorContent?: string;
		} = {},
	): Promise<boolean> {
		const startingContentHash = this.deps.getDiskIndex()[path]?.contentHash;
		const startingBaselineRevision = this.diskBaselineRevisions.get(path) ?? 0;
		try {
			const stat = stableStat ?? await this.deps.app.vault.adapter.stat(path);
			if (stat) {
				const settledHash = settledContent !== undefined
					? await contentBaselineHash(settledContent)
					: undefined;
				if (settledContent !== undefined && settledHash !== undefined) {
					const currentFile = this.deps.app.vault.getAbstractFileByPath(path);
					if (!(currentFile instanceof TFile)) {
						this.deps.trace("reconcile", "disk-index-settlement-stale", {
							path,
							reason: "file-missing-before-baseline-commit",
						});
						return false;
					}
					const currentDiskContent = await this.readFreshMarkdownFile(currentFile);
					const fileIdentityCurrent =
						currentFile.path === path &&
						this.deps.app.vault.getAbstractFileByPath(path) === currentFile &&
						(options.expectedDiskFile === undefined || currentFile === options.expectedDiskFile);
					const currentYText = this.deps.getVaultSync()?.getTextForPath(path) ?? null;
					const crdtAuthorityCurrent = options.expectedYText === undefined || (
						currentYText === options.expectedYText &&
						yTextToString(currentYText) === options.expectedCrdtContent
					);
					const preservedEntry = this.getPreservedUnresolvedMarkdownEntries()
						.find((entry) => entry.path === path);
					const preservedStateCurrent = options.expectedPreservedUnresolvedEpisodeId
						? !!preservedEntry &&
							getPreservedUnresolvedEpisodeId(preservedEntry) ===
								options.expectedPreservedUnresolvedEpisodeId
						: preservedEntry === undefined;
					const currentContentHash = this.deps.getDiskIndex()[path]?.contentHash;
					const currentBaselineRevision = this.diskBaselineRevisions.get(path) ?? 0;
					const editorTicketValidation = options.expectedEditorTicket === undefined
						? { current: true as const }
						: this.deps.getEditorBindings()?.validateOpenEditorMutationTicket?.(
							options.expectedEditorTicket,
							this.getOpenMarkdownViewsForPath(path),
						) ?? {
							current: false as const,
							reason: "binding-manager-unavailable" as const,
						};
					const currentEditorAuthority = options.expectedOpenEditorContent === undefined
						? null
						: this.getOpenEditorAuthority(this.getOpenMarkdownViewsForPath(path));
					const editorContentCurrent = options.expectedOpenEditorContent === undefined || (
						currentEditorAuthority?.kind === "single" &&
						currentEditorAuthority.content === options.expectedOpenEditorContent
					);
					if (
						!fileIdentityCurrent ||
						!editorTicketValidation.current ||
						!editorContentCurrent ||
						!crdtAuthorityCurrent ||
						!preservedStateCurrent ||
						currentDiskContent !== settledContent ||
						currentBaselineRevision !== startingBaselineRevision ||
						(
							currentContentHash !== startingContentHash &&
							currentContentHash !== settledHash
						)
					) {
						this.deps.trace("reconcile", "disk-index-settlement-stale", {
							path,
							reason: !fileIdentityCurrent
								? "file-identity-changed"
								: !editorTicketValidation.current
									? "editor-authority-changed"
									: !editorContentCurrent
										? "editor-content-changed"
										: !crdtAuthorityCurrent
											? "crdt-authority-changed"
											: !preservedStateCurrent
												? "preserved-unresolved-changed"
												: currentDiskContent !== settledContent
													? "disk-content-advanced"
													: "newer-baseline-already-recorded",
							...(!editorTicketValidation.current && {
								editorReason: editorTicketValidation.reason,
							}),
							expectedLength: settledContent.length,
							currentDiskLength: currentDiskContent.length,
						});
						return false;
					}
				}
				const existing = this.deps.getDiskIndex()[path];
				const nextEntry: import("../sync/diskIndex").DiskIndexEntry = {
					mtime: stat.mtime,
					size: stat.size,
					// Advance the baseline hash if settled content is provided.
					// This covers disk→CRDT imports (external edits while KAOS is running).
					contentHash: settledHash ?? existing?.contentHash,
				};
				if (nextEntry.contentHash === undefined) {
					delete nextEntry.contentHash;
				}
				if (settledHash !== undefined && settledContent !== undefined) {
					this.deps.recordBaselineText?.(settledHash, settledContent);
					this.noteDiskBaselineSettlement(path);
				}
				this.deps.setDiskIndex({
					...this.deps.getDiskIndex(),
					[path]: nextEntry,
				});
				if (settledHash !== undefined && settledContent !== undefined) {
					this.clearDeferredVisibleAuthorityIfSettled(path, settledContent);
				}
				// Live dirty-ingest settlements do not pass through the full reconcile
				// save at the end. Persist before returning so a crash/reload cannot
				// resurrect the previous baseline.
				await this.deps.saveDiskIndex();
				return true;
			}
			return false;
		} catch (err) {
			this.deps.trace("reconcile", "disk-index-settlement-failed", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/**
	 * Show an amplification-quarantine notice with rate-limiting. Independent
	 * from any conflict surface — an amplification quarantine paused
	 * content recovery on a file that looked like it was looping.
	 *
	 * One notice per AMPLIFICATION_NOTICE_COOLDOWN_MS window; suppressed
	 * fires are counted and reported in the next notice.
	 */
	private showAmplificationNotice(message: string): void {
		const now = Date.now();
		if (now - this.lastAmplificationNoticeAt < ReconciliationController.AMPLIFICATION_NOTICE_COOLDOWN_MS) {
			this.amplificationNoticeSuppressionCount++;
			return;
		}
		const suppressed = this.amplificationNoticeSuppressionCount;
		this.amplificationNoticeSuppressionCount = 0;
		this.lastAmplificationNoticeAt = now;
		const suffix = suppressed > 0
			? ` (and ${suppressed} other quarantine${suppressed > 1 ? "s" : ""} in the last 60s)`
			: "";
		new Notice(`KAOS: ${message}${suffix}`, 12000);
	}
}
