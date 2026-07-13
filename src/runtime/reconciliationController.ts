import { App, MarkdownView, Notice, TFile } from "obsidian";
import type { BlobSyncManager } from "../sync/blobSync";
import type { DiskMirror, DiskWriteResult } from "../sync/diskMirror";
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
import type { EditorBindingManager } from "../sync/editorBinding";
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
	applyDiffToYText,
	applyDiffToYTextWithPostcondition,
	forceReplaceYText,
	type DiffPostconditionResult,
} from "../sync/diff";
import { decideExternalEditImport } from "../sync/externalEditPolicy";
import { yTextToString } from "../utils/format";
import { mergeTexts3 } from "../utils/threeWayMerge";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
} from "../sync/origins";
import { planClosedFileReconcile } from "./reconcile/closedFilePlanner";
import {
	planOpenBoundFileReconcile,
	type OpenBoundEditorAuthority,
	type OpenBoundFileReconcileAction,
} from "./reconcile/openBoundFilePlanner";
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
import {
	buildMarkdownConflictArtifactCopyPath,
	buildMarkdownConflictArtifactPath,
	isMarkdownConflictArtifactForOriginalPath,
} from "../paths/conflictArtifactPath";
import {
	getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	type PreservedUnresolvedEntry,
	type RemoteDeletePreservedUnresolvedReason,
} from "../sync/preservedUnresolved";

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
}

export type StableMarkdownReadResult =
	| { kind: "ready"; file: TFile; content: string; stat: { mtime: number; size: number } | null }
	| { kind: "missing" }
	| { kind: "unstable" };

interface ActiveMarkdownIngest {
	path: string;
	entry: MarkdownDirtyEntry;
	redirectedTo: string | null;
	generation: number;
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

type BoundFileSyncGapOutcome =
	| { kind: "not-handled" }
	| { kind: "handled"; settledContent?: string }
	| { kind: "deferred"; deferUntil: number; reason: string }
	| { kind: "flush-crdt-to-disk"; provisionalBaseline?: boolean; reason: string };

interface MarkdownConflictArtifactResult {
	path: string;
	created: boolean;
}

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
	getBaselineText?(contentHash: string): string | null;
	recordBaselineText?(contentHash: string, text: string): void;
	recordConflictMergeBase?(artifactPath: string, baseHash: string): void;
	isMarkdownPathSyncable(path: string): boolean;
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
	onReconciled(reason: string): void;
	recordFlightEvent?(event: ProductFlightEventInput): void;
	recordFlightPathEvent?(event: ProductFlightPathEventInput): void;
	readStableMarkdownFile?(
		path: string,
		reason: MarkdownDirtyReason,
	): Promise<StableMarkdownReadResult>;
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
	/**
	 * Optional: override the external edit policy used inside syncFileFromDisk.
	 * Absent in production. Supplied by the QA harness to set a transient
	 * in-memory override without persisting or pushing settings metadata.
	 * When present, this callback is called with the runtime policy and may
	 * return a different value; returning null/undefined falls back to the
	 * runtime policy.
	 */
	getEffectiveExternalEditPolicy?(runtimePolicy: import("../settings").ExternalEditPolicy): import("../settings").ExternalEditPolicy | null | undefined;
	/**
	 * Optional: harness registration hook for disk-ingest control.
	 * Called once during reconciliation setup. The callback receives a
	 * control port that the QA harness can store and call to trigger
	 * syncFileFromDisk deterministically, bypassing the dirty-queue pipeline.
	 * Must not be wired in production main.ts.
	 */
	registerDiskIngestPort?(port: DiskIngestPort): void;
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
 *
 * See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R2.
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
 *
 * See spec:
 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
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
	/** At most one Keep/Accept resolution may own a Markdown path. */
	private markdownRemoteDeleteResolutions = new Map<string, InternalMarkdownResolutionLease>();
	private closedOnlyDeferredImports = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();
	private recoveryFingerprints = new Map<string, FingerprintEntry>();
	/**
	 * Per-path amplification history for the monotonic-growth quarantine.
	 * Independent of `recoveryFingerprints` — fingerprint quarantine catches
	 * "same diff repeating," this catches "growing diff repeating." See spec:
	 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
	 */
	private amplificationHistory = new Map<string, AmplificationEntry[]>();
	private lastConflictFingerprints = new Map<string, string>();
	private blockedDivergenceCount = 0;
	private lastBlockedDivergenceAt: string | null = null;
	private blockedDivergenceSample: Array<{ ext: string; hash: string }> = [];
	private unresolvedStructuralChanges: UnresolvedStructuralChange[] = [];
	private readonly diagnosticPathSalt =
		Math.random().toString(36).slice(2) + Date.now().toString(36);
	/** Conflict notice throttle: suppress repeat notices within window. */
	private lastConflictNoticeAt = 0;
	private conflictNoticeSuppressionCount = 0;
	private static readonly CONFLICT_NOTICE_COOLDOWN_MS = 30_000;
	/** Amplification-quarantine notice throttle. Independent from conflict notices. */
	private lastAmplificationNoticeAt = 0;
	private amplificationNoticeSuppressionCount = 0;
	private static readonly AMPLIFICATION_NOTICE_COOLDOWN_MS = 60_000;

	constructor(private readonly deps: ReconciliationControllerDeps) {
		// If a QA harness is attached, register the disk-ingest control port now.
		// In normal production, registerDiskIngestHarnessPort is absent.
		deps.registerDiskIngestPort?.({
			ingestDiskFileNow: async (path, reason) => {
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

	reset(): void {
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
		this.closedOnlyDeferredImports.clear();
		this.markdownDrainPromise = null;
		this.lastMarkdownDirtyAt = 0;
		this.recoveryFingerprints.clear();
		this.amplificationHistory.clear();
		this.lastConflictFingerprints.clear();
		this.blockedDivergenceCount = 0;
		this.lastBlockedDivergenceAt = null;
		this.blockedDivergenceSample = [];
		this.unresolvedStructuralChanges = [];
		this.lastConflictNoticeAt = 0;
		this.conflictNoticeSuppressionCount = 0;
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

		if (this.untrackedFiles.length > 0) {
			await this.importUntrackedFiles();
		}

		await this.runReconciliation("authoritative");
		this.lastReconciledGeneration = generation;
		this.deps.setAwaitingFirstProviderSyncAfterStartup(false);
		this.deps.onReconciled(`reconnect-post:${generation}`);

		if (this.reconcilePending) {
			this.reconcilePending = false;
			const nextVaultSync = this.deps.getVaultSync();
			if (nextVaultSync && nextVaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(nextVaultSync.connectionGeneration);
			}
		}
	}

	private isDiskWriteSettled(result: DiskWriteResult | undefined): boolean {
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

	private async applyNoEventStructuralPrepass(input: {
		vaultSync: VaultSync;
		diskFiles: Map<string, string>;
		diskPresentPaths: Set<string>;
		deviceName: string;
	}): Promise<{
		blockedOldPaths: Set<string>;
		blockedNewPaths: Set<string>;
		renamedCount: number;
		unresolvedCount: number;
	}> {
		const { vaultSync, diskFiles, diskPresentPaths, deviceName } = input;
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
			renameEvidence: extraDiskPaths.flatMap((newPath) => {
				const oldPath = getPendingRenameOldPathForTarget?.call(vaultSync, newPath);
				if (!oldPath || !missingCrdtPaths.includes(oldPath)) return [];
				return [{ oldPath, newPath, reason: "pending-rename" as const }];
			}),
		});

		const renameBatch = new Map<string, string>();
		for (const rename of structuralPlan.renames) {
			const opId = `op-reconcile-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.reconcileFileDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "reconcile",
				path: rename.newPath,
				opId,
				data: {
					decision: "rename-crdt-path-to-disk",
					reason: rename.reason,
					oldPath: rename.oldPath,
					newPath: rename.newPath,
					conflictRisk: "none",
					identityAmbiguous: false,
					contentHash: rename.contentHash,
					bindingStatus: "ok",
					renameEvidence: rename.reason,
				},
			});
			renameBatch.set(rename.oldPath, rename.newPath);
		}
		if (renameBatch.size > 0) {
			vaultSync.applyReconcileRenameBatch(renameBatch, deviceName);
		}

		this.unresolvedStructuralChanges = structuralPlan.unresolved;
		for (const change of structuralPlan.unresolved) {
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
			blockedOldPaths: new Set(structuralPlan.unresolved.flatMap((change) => change.oldPaths)),
			blockedNewPaths: new Set(structuralPlan.unresolved.flatMap((change) => change.newPaths)),
			renamedCount: structuralPlan.renames.length,
			unresolvedCount: structuralPlan.unresolved.reduce(
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
						const nextMode = this.deps.getVaultSync()?.getSafeReconcileMode() ?? mode;
						void this.runReconciliation(nextMode);
					}
				}, delay);
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
			const diskPresentPaths = new Set<string>();
			const allMdFiles = this.deps.app.vault.getMarkdownFiles();
			let excludedCount = 0;
			let oversizedCount = 0;
			let skippedByIndex = 0;

			const eligibleFiles: TFile[] = [];
			for (const file of allMdFiles) {
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
					const content = await this.deps.app.vault.read(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						continue;
					}
					diskFiles.set(file.path, content);
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
					const content = await this.deps.app.vault.read(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						this.deps.log(`reconcile: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
						continue;
					}
					diskFiles.set(file.path, content);
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

			const structuralPrepass = mode === "authoritative"
				? await this.applyNoEventStructuralPrepass({
					vaultSync,
					diskFiles,
					diskPresentPaths,
					deviceName: this.deps.getSettings().deviceName,
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

			const result = vaultSync.reconcileVault(
				diskFiles,
				reconcileDiskPresentPaths,
				mode,
				this.deps.getSettings().deviceName,
				/**
				 * Spec: .kiro/specs/no-event-reconcile-admission/requirements.md R2.
				 *
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
				(path) => this.deps.isMarkdownPathSyncable(path),
			);

			let flushedCreates = 0;
			let flushedUpdates = 0;
			let safetyBrakeTriggered = false;
			let safetyBrakeReason: string | null = null;

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
				};

				// Track paths that need CRDT→disk flush, along with the semantic reason.
				// This preserves the action kind so planBaselineAdvancement gets the
				// correct input, not a flattened "defer-to-crdt-flush" for everything.
				const updatesToFlush: Array<{ path: string; baselineActionKind: BaselineActionKind }> = [];
				const deferredOpenEditorIndexPaths = new Set<string>();
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
					const writeResult = await diskMirror.flushWrite(path);
					if (!this.isDiskWriteSettled(writeResult)) {
						this.traceDiskWriteNotSettled(path, writeResult, "crdt-file-missing-on-disk");
						continue;
					}
					if (writeResult.kind === "written") {
						flushedCreates++;
					}
					// Record settled baseline hash: CRDT content was written to disk
					const ytext = vaultSync.getTextForPath(path);
					if (ytext) {
						const crdtContent = yTextToString(ytext) ?? "";
						const crdtHash = await contentBaselineHash(crdtContent);
						const baselineAction = planBaselineAdvancement({
							actionKind: "crdt-created-on-disk",
							diskHash: null,
							crdtHash,
							previousBaselineHash: null,
						});
						if (baselineAction.kind === "advance") {
							recordSettledBaseline(path, baselineAction.hash, crdtContent);
						}
					}
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
						const editorSettleDefer =
							this.getOpenEditorReconcileSettleDefer({
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
							deferredOpenEditorIndexPaths.add(path);
							continue;
						}

						const handledOpenDivergence = await this.handleOpenFileReconcileDivergence(
							path,
							diskContent,
							ytext,
							openViews,
							eligibleFileByPath.get(path) ?? null,
						);
						if (handledOpenDivergence) {
							continue;
						}
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
						const action = planClosedFileReconcile({
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
								const baseText = this.deps.getBaselineText?.(baselineHash) ?? null;
								const mergeResult = mergeTexts3(baseText, diskContent, crdtContent);
								if (mergeResult.kind === "clean-merge") {
									forceReplaceYText(ytext, mergeResult.mergedText, ORIGIN_DISK_SYNC_RECOVER_BOUND);
									const writeResult = await diskMirror.flushWrite(path, true);
									if (!this.isDiskWriteSettled(writeResult)) {
										this.traceDiskWriteNotSettled(path, writeResult, "closed-file-3way-auto-merged");
										continue;
									}
									if (writeResult.kind === "written") {
										flushedUpdates++;
									}
									const mergedHash = await contentBaselineHash(mergeResult.mergedText);
									recordSettledBaseline(path, mergedHash, mergeResult.mergedText);
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
							try {
								const preservedContent = action.preserveSide === "disk" ? diskContent : crdtContent;
								const conflictArtifact = await this.createMarkdownConflictArtifact(
									path,
									preservedContent,
									`closed-file-${action.reason}`,
									action.preserveSide,
								);
								const conflictPath = conflictArtifact.path;
								if (baselineHash !== null) {
									this.deps.recordConflictMergeBase?.(conflictPath, baselineHash);
								}
								if (action.winner === "disk") {
									forceReplaceYText(ytext, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
									const baselineAction = planBaselineAdvancement({
										actionKind: "conflict-disk-wins",
										diskHash,
										crdtHash,
										previousBaselineHash: baselineHash,
									});
									if (baselineAction.kind === "advance") {
										recordSettledBaseline(path, baselineAction.hash, diskContent);
									}
								} else {
									updatesToFlush.push({ path, baselineActionKind: "conflict-crdt-wins" });
								}
								this.deps.trace("conflict", "closed-file-conflict-preserved", {
									path,
									conflictPath,
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
							} catch (err) {
								diskMirror.recordPreservedUnresolved(
									path,
									"conflict-artifact-write-failed",
								);
								this.deps.trace("conflict", "closed-file-conflict-preserve-failed", {
									path,
									reason: action.reason,
									error: err instanceof Error ? err.message : String(err),
								});
								// Baseline advancement: defer on artifact creation failure
								// (planBaselineAdvancement would return defer, but we skip calling it
								// since we're not setting any hash anyway - the path is dropped)
								continue;
							}
						}
						if (action.kind === "import-disk-to-crdt") {
							forceReplaceYText(ytext, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
							const baselineAction = planBaselineAdvancement({
								actionKind: "import-disk-to-crdt",
								diskHash,
								crdtHash,
								previousBaselineHash: baselineHash,
							});
							if (baselineAction.kind === "advance") {
								recordSettledBaseline(path, baselineAction.hash, diskContent);
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
						updatesToFlush.push({ path, baselineActionKind: action.kind });
					}
				}
				for (const { path, baselineActionKind } of updatesToFlush) {
					const provisionalConflictWinner =
						baselineActionKind === "conflict-crdt-wins" ||
						baselineActionKind === "conflict-disk-wins";
					const writeResult = await diskMirror.flushWrite(path, false, {
						recordBaseline: !provisionalConflictWinner,
					});
					if (!this.isDiskWriteSettled(writeResult)) {
						this.traceDiskWriteNotSettled(path, writeResult, baselineActionKind);
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
					// Record settled baseline hash: CRDT content was written to disk
					const ytext = vaultSync.getTextForPath(path);
					if (ytext) {
						const crdtContent = yTextToString(ytext) ?? "";
						const crdtHash = await contentBaselineHash(crdtContent);
						// Use the preserved action kind for accurate baseline advancement.
						const baselineAction = planBaselineAdvancement({
							actionKind: baselineActionKind,
							diskHash: null,
							crdtHash,
							previousBaselineHash: null,
						});
						if (baselineAction.kind === "advance") {
							recordSettledBaseline(path, baselineAction.hash, crdtContent);
						}
					}
				}

				// Pass settled hashes to disk index so they survive plugin reload
				// and serve as the three-way baseline next startup reconcile.
				const blockedIndexPathsInner = Array.from(deferredOpenEditorIndexPaths);
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
				this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats, {
					excludePaths: blockedIndexPathsInner,
					settledHashes,
				}));
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
			}
			this.deps.onReconciled(`reconcile-${mode}`);
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
			this.deps.scheduleTraceStateSnapshot(`reconcile-${mode}`);
		}
	}

	async importUntrackedFiles(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		const diskMirror = this.deps.getDiskMirror();
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
			if (diskMirror?.isPreservedUnresolved(path)) {
				this.deps.log(`importUntracked: "${path}" is preserved-unresolved remote delete, skipping auto-revive`);
				this.deps.trace("reconcile", "import-untracked-skipped-preserved-unresolved", {
					path,
				});
				continue;
			}

			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.deps.app.vault.read(file);
				// Spec: .kiro/specs/no-event-reconcile-admission/requirements.md R2.7.
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
				if (result) {
					imported++;
				} else {
					this.deps.log(`importUntracked: "${path}" could not be imported (ensureFile returned null)`);
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
	): void {
		if (this.isMarkdownResolutionActive(path)) {
			this.deps.trace("reconcile", "markdown-dirty-dropped-during-resolution", {
				path,
				reason,
			});
			return;
		}
		const now = Date.now();
		const notBeforeMs = this.getRecentEditorDirtyDeferUntil(path, reason, now) ?? undefined;
		this.mergeDirtyMarkdownPath(path, {
			reason,
			primaryOpId: opId,
			coalescedOpIds: Array.from(new Set(coalescedOpIds)),
			retryCount,
			generation: this.getMarkdownIngestGeneration(path),
			notBeforeMs,
		});
		this.lastMarkdownDirtyAt = now;
		this.scheduleMarkdownDrain();
	}

	markMarkdownDirty(file: TFile, reason: MarkdownDirtyReason, opId?: string): void {
		this.queueDirtyMarkdownPath(file.path, reason, opId);
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
			const result = vaultSync.serverAckTracker.withActiveOpId(opId, () => {
				const ytext = vaultSync.ensureFile(
					path,
					stableRead.content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: true,
						reviveReason: "dashboard-keep-local",
						opId,
					},
				);
				if (!ytext) return null;
				return applyDiffToYTextWithPostcondition(
					ytext,
					yTextToString(ytext) ?? "",
					stableRead.content,
					ORIGIN_DISK_SYNC,
				);
			});
			if (!result?.finalMatchesExpected) {
				throw new Error(`Failed to publish the local content for "${path}".`);
			}

			await this.updateDiskIndexForPath(path, stableRead.content, stableRead.stat);
			// Do not clear a replacement Attention episode that arrived while the
			// disk-index hash was being computed.
			this.assertSameRemoteDeletedMarkdownEntry(path, entry);
			diskMirror.clearPreservedUnresolved(path);
			await this.deps.saveDiskIndex();
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
			|| active.generation !== this.getMarkdownIngestGeneration(active.path);
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
		const content = await this.deps.app.vault.read(abstractFile);
		let stat: { mtime: number; size: number } | null = null;
		try {
			const raw = await this.deps.app.vault.adapter.stat(path);
			stat = raw ? { mtime: raw.mtime, size: raw.size } : null;
		} catch {
			stat = null;
		}
		return { kind: "ready", file: abstractFile, content, stat };
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
	redirectPendingDirtyPath(oldPath: string, newPath: string): void {
		const entry = this.dirtyMarkdownPaths.get(oldPath);
		let redirected = false;
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

		if (!redirected) return;

		const label = entry?.reason === "create" || active?.entry.reason === "create"
			? "race recovery"
			: "modify redirect";
		this.deps.log(`redirectPendingDirtyPath: "${oldPath}" -> "${newPath}" (${label})`);
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
		if (this.dirtyMarkdownPaths.delete(path)) {
			this.deps.log(`dropDirtyPath: dropped excluded dirty entry for "${path}"`);
		}
	}

	maybeImportDeferredClosedOnlyPath(path: string, reason: string): void {
		if (!this.reconciled) return;
		if (this.deps.getRuntimeConfig().externalEditPolicy !== "closed-only") return;
		if (!this.deps.isMarkdownPathSyncable(path)) return;
		if (this.closedOnlyDeferredImports.has(path)) return;
		if (this.getOpenMarkdownViewsForPath(path).length > 0) return;
		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		this.closedOnlyDeferredImports.add(path);
		this.deps.trace("trace", "closed-only-deferred-import-queued", {
			path,
			reason,
		});

		const deferredOpId = `op-deferred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		void this.processDirtyMarkdownPath(path, {
			reason: "modify",
			primaryOpId: deferredOpId,
			coalescedOpIds: [deferredOpId],
			retryCount: 0,
		})
			.catch((err) => {
				console.error(`[kaos] closed-only deferred import failed for "${path}" (${reason}):`, err);
			})
			.finally(() => {
				this.closedOnlyDeferredImports.delete(path);
			});
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
			const content = stableRead.content;
			if (!this.deps.isMarkdownPathSyncable(path)) return;

			const editorBindings = this.deps.getEditorBindings();
			let wasBound = editorBindings?.isBound(path) ?? false;
			const openViews = this.getOpenMarkdownViewsForPath(path);
			const isOpenInEditor = openViews.length > 0;
			if (wasBound && !isOpenInEditor) {
				this.deps.trace("trace", "stale-bound-path-without-open-view", {
					path,
				});
				editorBindings?.unbindByPath(path);
				this.deps.log(`syncFileFromDisk: cleared stale bound state for "${path}" (no live view)`);
				wasBound = false;
			}

			const effectivePolicy =
				this.deps.getEffectiveExternalEditPolicy?.(runtimeConfig.externalEditPolicy)
				?? runtimeConfig.externalEditPolicy;
			const policyDecision = decideExternalEditImport(effectivePolicy, isOpenInEditor);
			if (!policyDecision.allowImport) {
				const reason = policyDecision.reason === "policy-never"
					? "external edit policy: never"
					: "external edit policy: closed-only (file is open; deferred)";
				this.deps.log(`syncFileFromDisk: skipping "${path}" (${reason})`);
				if (policyDecision.reason === "policy-never") {
					await this.updateDiskIndexForPath(path, undefined, stableRead.stat);
				}
				return;
			}
			if (this.shouldAbortActiveMarkdownIngest(active)) return;

			// If the user modifies or creates a file that was previously
			// preserved-unresolved, that is intentional user action. Clear the
			// guard only after the file is stable and policy allows import.
			const diskMirror = this.deps.getDiskMirror();
			if (diskMirror?.isPreservedUnresolved(path)) {
				diskMirror.clearPreservedUnresolved(path);
			}

			if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
				this.deps.log(`syncFileFromDisk: skipping "${path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = vaultSync.getTextForPath(path);
			const existingCrdtContent = existingText ? existingText.toJSON() : null;

			const openEditorMismatchDeferUntil = this.getOpenEditorDiskMismatchDeferUntil({
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

			if (wasBound && isOpenInEditor) {
				const boundOutcome = await this.handleBoundFileSyncGap(
					file,
					content,
					existingText,
					openViews,
					sourceReason,
					stableRead.stat,
					() => this.shouldAbortActiveMarkdownIngest(active),
				);
				if (this.shouldAbortActiveMarkdownIngest(active)) return;
				if (boundOutcome.kind === "handled") {
					if (boundOutcome.settledContent !== undefined) {
						await this.updateDiskIndexForPath(path, boundOutcome.settledContent, stableRead.stat);
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
					const writeResult = await diskMirror?.flushWrite(path, true, {
						recordBaseline: !boundOutcome.provisionalBaseline,
					});
					if (!this.isDiskWriteSettled(writeResult)) {
						this.traceDiskWriteNotSettled(path, writeResult, boundOutcome.reason);
						if (boundOutcome.provisionalBaseline) {
							diskMirror?.recordPreservedUnresolved(
								path,
								"conflict-winner-flush-deferred",
							);
						}
					}
					return;
				}
			}

			if (existingText) {
				const crdtContent = existingText.toJSON();
				if (crdtContent === content) {
					// recovery.skipped: CRDT and disk already agree (unbound second-pass no-op).
					// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.1
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
				vaultSync.serverAckTracker.withActiveOpId(opId, () => {
					applyDiffToYText(existingText, crdtContent, content, ORIGIN_DISK_SYNC);
				});
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
				vaultSync.serverAckTracker.withActiveOpId(opId, () => {
					vaultSync.ensureFile(
						path,
						content,
						this.deps.getSettings().deviceName,
						{
							reviveTombstone: sourceReason === "create",
							reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
							opId,
						},
					);
				});
			}

			await this.updateDiskIndexForPath(path, content, stableRead.stat);
		} catch (err) {
			console.error(`[kaos] syncFileFromDisk failed for "${originalPath}":`, err);
		}
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

	private getOpenEditorDiskMismatchDeferUntil(input: {
		sourceReason: MarkdownDirtyReason;
		cameFromDirtyQueue: boolean;
		diskContent: string;
		crdtContent: string | null;
		openViews: MarkdownView[];
		now?: number;
	}): number | null {
		if (input.sourceReason !== "modify") return null;
		if (!input.cameFromDirtyQueue) return null;
		if (input.openViews.length === 0) return null;

		const authority = this.getOpenEditorAuthority(input.openViews);
		if (authority.kind === "none") return null;

		const now = input.now ?? Date.now();
		if (authority.kind === "multiple" || authority.kind === "read-failed") {
			return now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
		}

		if (authority.content === input.diskContent) return null;
		if (input.crdtContent !== null && authority.content === input.crdtContent) return null;
		return now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
	}

	private getOpenEditorReconcileSettleDefer(
		input: {
			path: string;
			diskContent: string;
			crdtContent: string;
			openViews: MarkdownView[];
		},
		now = Date.now(),
	): {
		reason: "recent-editor-activity" | "editor-ahead-without-activity-timestamp";
		lastEditorActivity: number | null;
		idleMs: number | null;
		deferUntil: number;
	} | null {
		const editorBindings = this.deps.getEditorBindings() as
			| { getLastEditorActivityForPath?: (path: string) => number | null }
			| null;
		const lastEditorActivity =
			editorBindings?.getLastEditorActivityForPath?.(input.path) ?? null;
		if (lastEditorActivity !== null) {
			const deferUntil = lastEditorActivity + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS;
			if (deferUntil <= now) return null;

			return {
				reason: "recent-editor-activity",
				lastEditorActivity,
				idleMs: Math.max(0, now - lastEditorActivity),
				deferUntil,
			};
		}

		const authority = this.getOpenEditorAuthority(input.openViews);
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
			idleMs: null,
			deferUntil: now + OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS,
		};
	}

	private deferOpenFileReconcileForEditorSettle(input: {
		path: string;
		diskContent: string;
		crdtContent: string;
		openViews: MarkdownView[];
		reason: "recent-editor-activity" | "editor-ahead-without-activity-timestamp";
		lastEditorActivity: number | null;
		idleMs: number | null;
		deferUntil: number;
	}): void {
		const editorStates = input.openViews.map((view) => {
			let editorContent: string | null = null;
			try {
				editorContent = view.editor.getValue();
			} catch {
				editorContent = null;
			}
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
			notBeforeMs: input.deferUntil,
			openViewCount: input.openViews.length,
			diskLength: input.diskContent.length,
			crdtLength: input.crdtContent.length,
			editorStates,
		});
		this.mergeDirtyEntryIntoPath(input.path, {
			reason: "modify",
			primaryOpId: undefined,
			coalescedOpIds: [],
			retryCount: 0,
			notBeforeMs: input.deferUntil,
		});
	}

	private async handleOpenFileReconcileDivergence(
		path: string,
		diskContent: string,
		ytext: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[],
		file: TFile | null,
	): Promise<boolean> {
		if (!ytext) return false;
		const crdtContent = yTextToString(ytext) ?? "";
		const viewStates = openViews.map((view) => ({
			view,
			editorContent: view.editor.getValue(),
		}));
		const distinctEditorContents = [...new Set(viewStates.map((state) => state.editorContent))];
		if (distinctEditorContents.length !== 1) {
			this.deps.trace("conflict", "open-file-reconcile-multiple-editor-authorities", {
				path,
				editorViewCount: openViews.length,
				distinctEditorContentCount: distinctEditorContents.length,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
			});
			return false;
		}

		const editorAuthority = distinctEditorContents[0]!;
		if (editorAuthority === crdtContent) {
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

		let crdtConflictPath: string | null = null;
		let diskConflictPath: string | null = null;
		let conflictArtifactCreated = false;
		try {
			const crdtConflict = await this.createMarkdownConflictArtifact(
				path,
				crdtContent,
				"open-file-reconcile-editor-wins",
				"crdt",
			);
			crdtConflictPath = crdtConflict.path;
			conflictArtifactCreated ||= crdtConflict.created;
			if (diskContent !== editorAuthority && diskContent !== crdtContent) {
				const diskConflict = await this.createMarkdownConflictArtifact(
					path,
					diskContent,
					"open-file-reconcile-editor-wins",
					"disk",
				);
				diskConflictPath = diskConflict.path;
				conflictArtifactCreated ||= diskConflict.created;
			}
		} catch (err) {
			this.deps.trace("conflict", "open-file-reconcile-preserve-failed", {
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}

		forceReplaceYText(ytext, editorAuthority, ORIGIN_DISK_SYNC_RECOVER_BOUND);
		const convergenceApplied = yTextToString(ytext) === editorAuthority;
		this.deps.trace("conflict", "open-file-reconcile-editor-wins", {
			path,
			filePath: file?.path ?? null,
			crdtConflictPath,
			diskConflictPath,
			editorViewCount: openViews.length,
			editorLength: editorAuthority.length,
			diskLength: diskContent.length,
			crdtLength: crdtContent.length,
			convergenceApplied,
			conflictArtifactCreated,
		});
		if (conflictArtifactCreated) {
			this.showConflictNotice(
				`Conflict detected for "${path.split("/").pop()}" — ` +
				`competing version preserved as conflict note.`,
			);
		}
		return true;
	}

	private async preserveOpenBoundPlannerConflict(input: {
		file: TFile;
		diskContent: string;
		crdtContent: string;
		targetContent?: string;
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
			targetContent,
			reason,
			preserveDisk,
			preserveCrdt,
			editorViewCount,
			distinctEditorContentCount,
			chosenSource,
		} = input;
		let crdtConflictPath: string | null = null;
		let diskConflictPath: string | null = null;
		let conflictError: string | null = null;
		let convergenceApplied = false;
		let conflictArtifactCreated = false;

		try {
			if (preserveCrdt && crdtContent !== targetContent) {
				const crdtConflict = await this.createMarkdownConflictArtifact(
					file.path,
					crdtContent,
					reason,
					"crdt",
				);
				crdtConflictPath = crdtConflict.path;
				conflictArtifactCreated ||= crdtConflict.created;
			}
			if (
				preserveDisk &&
				diskContent !== targetContent &&
				diskContent !== crdtContent
			) {
				const diskConflict = await this.createMarkdownConflictArtifact(
					file.path,
					diskContent,
					reason,
					"disk",
				);
				diskConflictPath = diskConflict.path;
				conflictArtifactCreated ||= diskConflict.created;
			}
		} catch (err) {
			conflictError = err instanceof Error ? err.message : String(err);
			this.deps.getDiskMirror()?.recordPreservedUnresolved?.(
				file.path,
				"conflict-artifact-write-failed",
			);
			this.deps.trace("conflict", "conflict-artifact-needed", {
				path: file.path,
				conflictPath: crdtConflictPath,
				diskConflictPath,
				reason,
				diskLength: diskContent.length,
				crdtLength: crdtContent.length,
				editorViewCount,
				distinctEditorContentCount,
				chosenSource,
				conflictArtifactCreated,
				convergenceApplied: false,
				error: conflictError,
			});
			return false;
		}

		if (targetContent !== undefined) {
			const existingText = this.deps.getVaultSync()?.getTextForPath(file.path);
			if (existingText) {
				forceReplaceYText(existingText, targetContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
				convergenceApplied = yTextToString(existingText) === targetContent;
			}
		}

		this.deps.trace("conflict", "conflict-artifact-needed", {
			path: file.path,
			conflictPath: crdtConflictPath,
			diskConflictPath,
			reason,
			diskLength: diskContent.length,
			crdtLength: crdtContent.length,
			editorViewCount,
			distinctEditorContentCount,
			chosenSource,
			conflictArtifactCreated,
			convergenceApplied,
			error: conflictError,
		});
		if (conflictArtifactCreated) {
			this.showConflictNotice(
				`Conflict detected for "${file.path.split("/").pop()}" — ` +
				`competing version preserved as conflict note.`,
			);
		}
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
	): Promise<BoundFileSyncGapOutcome> {
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
			// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.2
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
			// See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.8.
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
		if (crdtContent === content) {
			this.boundRecoveryLocks.delete(file.path);
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, crdt-current)`);
			// recovery.skipped: CRDT and disk already agree (bound second-pass no-op).
			// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.1
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
			// See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.8.
			this.amplificationHistory.delete(file.path);
			return { kind: "handled", settledContent: content };
		}

		const viewStates = openViews.map((view) => {
			const editorContent = view.editor.getValue();
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
		const distinctEditorContentsForPlanner = [...new Set(viewStates.map((state) => state.editorContent))];
		let plannerEditorAuthority: OpenBoundEditorAuthority;
		if (distinctEditorContentsForPlanner.length === 0) {
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
		let openBoundAction: OpenBoundFileReconcileAction | null = null;
		if (existingText && crdtContent != null) {
			const diskHash = await contentBaselineHash(content);
			const crdtHash = await contentBaselineHash(crdtContent);
			const baselineHash = this.deps.getDiskIndex()[file.path]?.contentHash ?? null;
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
				return {
					kind: "flush-crdt-to-disk",
					provisionalBaseline: plannerConflictPreserved,
					reason: `bound-file-${openBoundAction.reason}`,
				};
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
					targetContent: editorAuthority,
					reason: `bound-file-${openBoundAction.reason}`,
					preserveDisk: !!openBoundAction.preserveDisk,
					preserveCrdt: !!openBoundAction.preserveCrdt,
					editorViewCount: viewStates.length,
					distinctEditorContentCount: distinctEditorContentsForPlanner.length,
					chosenSource: "editor",
				});
				if (!preserved) {
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
				//
				// See spec:
				// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R2.
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
					editorLengths: localOnlyViews.map((state) => state.editorContent.length),
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
				// along the same axis. See spec:
				// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
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
				if (shouldAbort()) return { kind: "handled" };
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
				);
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
				if (shouldAbort()) return { kind: "handled" };
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
				const recoveredContent = yTextToString(vaultSync?.getTextForPath(file.path));
				this.deps.trace("recovery", "recovery-postcondition-observed", {
					path: file.path,
					reason: "bound-file-local-only-seed",
					origin: "ensureFile",
					expectedLength: content.length,
					actualLength: recoveredContent?.length ?? null,
					matchesExpected: recoveredContent === content,
					matchesAfterDiff: recoveredContent === content,
					enforced: false,
					forceReplaceApplied: false,
				});
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
			//
			// See spec:
			// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
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
				settledContent: !plannerConflictPreserved &&
					yTextToString(vaultSync?.getTextForPath(file.path)) === content
					? content
					: undefined,
			};
		}

		if (crdtOnlyViews.length > 0) {
			if (existingText && openBoundAction?.kind === "apply-crdt-to-disk") {
				if (openBoundAction.preserveDisk) {
					const preserved = await this.preserveOpenBoundPlannerConflict({
						file,
						diskContent: content,
						crdtContent: crdtContent ?? "",
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
				return {
					kind: "flush-crdt-to-disk",
					provisionalBaseline: plannerConflictPreserved,
					reason: `bound-file-${openBoundAction.reason}`,
				};
			}

			if (existingText && openBoundAction?.kind === "editor-wins-preserve") {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
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
				return {
					kind: "flush-crdt-to-disk",
					provisionalBaseline: true,
					reason: `bound-file-${openBoundAction.reason}`,
				};
			}

			if (existingText && openBoundAction?.kind === "import-disk-to-crdt" && openBoundAction.preserveCrdt) {
				const preserved = await this.preserveOpenBoundPlannerConflict({
					file,
					diskContent: content,
					crdtContent: crdtContent ?? "",
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
				// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.3
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
					return {
						kind: "deferred",
						deferUntil: lastEditorActivity + OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS,
						reason: "recent-editor-activity",
					};
				}

			if (existingText) {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
					)) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-disk-recovery");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return { kind: "handled" };
					}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
			const _rsh3 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-open-idle-disk-recovery",
					signature: computeRecoveryFingerprint("bound-file-open-idle-disk-recovery", crdtContent ?? "", content),
					action: "apply-diff",
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
					// Branch predicates
					editorEqualsDisk: false,
					editorEqualsCrdt: crdtOnlyViews.length > 0,
					diskFingerprintPrefix: contentFingerprint(content).slice(0, 8),
					crdtFingerprintPrefix: crdtContent ? contentFingerprint(crdtContent).slice(0, 8) : null,
					...(_rsh3 ? { recoveryStateHash: _rsh3 } : {}),
				},
			});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-open-idle-disk-recovery",
					crdtContent ?? "",
					content,
					)) {
						return { kind: "handled" };
					}
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-disk-recovery",
						origin: ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
						diskLength: content.length,
						crdtLength: crdtContent?.length ?? null,
					},
				});
				if (shouldAbort()) return { kind: "handled" };
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				);
			traceRecoveryPostcondition(
				(source, msg, details) => this.deps.trace(source, msg, details),
				(event) => this.deps.recordFlightPathEvent?.(event),
				file.path,
				"bound-file-open-idle-disk-recovery",
				ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
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
						reason: "bound-file-open-idle-disk-recovery",
						origin: ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
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
					"bound-file-open-idle-seed",
					)) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-seed");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return { kind: "handled" };
					}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
				const _rsh4 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-seed",
						signature: computeRecoveryFingerprint("bound-file-open-idle-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
						...(_rsh4 ? { recoveryStateHash: _rsh4 } : {}),
					},
				});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-open-idle-seed",
					"",
					content,
					)) {
						return { kind: "handled" };
					}
				if (shouldAbort()) return { kind: "handled" };
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
				const recoveredContent = yTextToString(vaultSync?.getTextForPath(file.path));
				this.deps.trace("recovery", "recovery-postcondition-observed", {
					path: file.path,
					reason: "bound-file-open-idle-seed",
					origin: "ensureFile",
					expectedLength: content.length,
					actualLength: recoveredContent?.length ?? null,
					matchesExpected: recoveredContent === content,
					matchesAfterDiff: recoveredContent === content,
					enforced: false,
					forceReplaceApplied: false,
				});
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);
			this.deps.scheduleTraceStateSnapshot("bound-file-open-idle-disk-recovery");
			return {
				kind: "handled",
				settledContent: !plannerConflictPreserved &&
					yTextToString(vaultSync?.getTextForPath(file.path)) === content
					? content
					: undefined,
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
		if (editorAuthority === null) {
			this.deps.getDiskMirror()?.recordPreservedUnresolved(
				file.path,
				"multiple-editor-authorities",
			);
		}
		let conflictPath: string | null = null;
		let diskConflictPath: string | null = null;
		let conflictError: string | null = null;
		let conflictSkippedDedupe = false;
		let conflictDedupeScope: "session" | "artifact" | null = null;
		let conflictArtifactCreated = false;
		if (crdtContent != null) {
			// Dedupe: if the same ambiguous fingerprint was already turned into
			// a conflict artifact, do not create another one. This prevents
			// infinite conflict artifact spam when convergence fails.
			// Include editor hash to catch cases where editor content differs
			// from disk between attempts (editor is the local authority being
			// applied during convergence). Use sorted distinct hashes of ALL
			// open views, not just the first — multiple panes may have different
			// unsaved content.
			const editorHashes = [...new Set(
				viewStates.map((s) => contentFingerprint(s.editorContent)),
			)].sort();
			const editorFp = editorHashes.length > 0
				? editorHashes.join("+")
				: "no-editor";
			const conflictFingerprint = `${contentFingerprint(crdtContent)}\x00${contentFingerprint(content)}\x00${editorFp}`;
			const previousConflictFingerprint = this.lastConflictFingerprints.get(file.path);
			if (previousConflictFingerprint === conflictFingerprint) {
				conflictSkippedDedupe = true;
				conflictDedupeScope = "session";
			} else {
				try {
					const needsDiskConflictArtifact =
						editorAuthority !== null &&
						content !== editorAuthority &&
						content !== crdtContent;
					const existingCrdtConflictPath = await this.findExistingMarkdownConflictArtifact(
						file.path,
						crdtContent,
						"crdt",
					);
					const existingDiskConflictPath = needsDiskConflictArtifact
						? await this.findExistingMarkdownConflictArtifact(file.path, content, "disk")
						: null;
					if (
						existingCrdtConflictPath !== null &&
						(!needsDiskConflictArtifact || existingDiskConflictPath !== null)
					) {
						conflictPath = existingCrdtConflictPath;
						diskConflictPath = existingDiskConflictPath;
						conflictSkippedDedupe = true;
						conflictDedupeScope = "artifact";
					} else {
						if (existingCrdtConflictPath !== null) {
							conflictPath = existingCrdtConflictPath;
						} else {
							const crdtConflict = await this.createMarkdownConflictArtifact(
								file.path,
								crdtContent,
								"bound-file-ambiguous-divergence",
								"crdt",
							);
							conflictPath = crdtConflict.path;
							conflictArtifactCreated ||= crdtConflict.created;
						}
						if (needsDiskConflictArtifact) {
							if (existingDiskConflictPath !== null) {
								diskConflictPath = existingDiskConflictPath;
							} else {
								const diskConflict = await this.createMarkdownConflictArtifact(
									file.path,
									content,
									"bound-file-ambiguous-divergence",
									"disk",
								);
								diskConflictPath = diskConflict.path;
								conflictArtifactCreated ||= diskConflict.created;
							}
						}
					}
					if (conflictArtifactCreated) {
						// Notify the user only when this pass creates a new
						// preserved artifact. Existing artifacts are durable
						// duplicate markers across restart and should not
						// re-notify as a fresh conflict.
						this.showConflictNotice(
							`Conflict detected for "${file.path.split("/").pop()}" — ` +
							`competing version preserved as conflict note.`,
						);
					}
					this.lastConflictFingerprints.set(file.path, conflictFingerprint);
				} catch (err) {
					conflictError = err instanceof Error ? err.message : String(err);
				}
			}
		}

		// After preserving competing versions as conflict artifacts, converge
		// the original path's CRDT to the visible editor content. This
		// prevents the same ambiguity from re-triggering on the next reconcile
		// and creating infinite conflict copies.
		//
		// Also attempt convergence when dedupe skipped artifact creation —
		// the earlier artifact already preserved the losing side; retry
		// convergence so the path can become stable.
		let convergenceApplied = false;
		if ((conflictPath !== null || conflictSkippedDedupe) && editorAuthority !== null) {
			const existingText = vaultSync?.getTextForPath(file.path);
			if (existingText) {
				forceReplaceYText(existingText, editorAuthority, ORIGIN_DISK_SYNC_RECOVER_BOUND);
				convergenceApplied = yTextToString(existingText) === editorAuthority;
				if (convergenceApplied) {
					// Convergence succeeded — the original path now matches disk.
					// Clear the conflict fingerprint so a genuinely new divergence
					// (different content) can still create a fresh artifact.
					this.lastConflictFingerprints.delete(file.path);
				}
			}
		}

		this.deps.trace("conflict", "conflict-artifact-needed", {
			path: file.path,
			conflictPath,
			diskConflictPath,
			reason: "bound-file-ambiguous-divergence",
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			editorViewCount: viewStates.length,
			distinctEditorContentCount: distinctEditorContents.length,
			chosenSource: editorAuthority === null ? "none-multiple-editor-contents" : "editor",
			conflictArtifactCreated,
			conflictSkippedDedupe,
			conflictDedupeScope,
			convergenceApplied,
			error: conflictError,
		});
		this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.deps.scheduleTraceStateSnapshot("bound-file-ambiguous");
		return { kind: "handled" };
	}

	/**
	 * Single private helper that owns every `recovery.skipped` emission
	 * with `data.reason === "frontmatter-ingest-blocked"`.
	 *
	 * Invoked from each of the six `shouldBlockFrontmatterIngest` block
	 * branches (two in `syncFileFromDisk` for the unbound disk→CRDT
	 * branches, four in `handleBoundFileSyncGap` for the bound recovery
	 * branches). The `branch` parameter is a closed-enum literal covering
	 * the six call sites; new emission sites are not permitted without
	 * extending the `FrontmatterIngestBlockBranch` union.
	 *
	 * The pre-existing `scheduleTraceStateSnapshot("frontmatter-ingest-blocked")`
	 * calls in the four bound branches are intentionally retained as a
	 * legacy diagnostic channel; this helper is additive.
	 *
	 * See spec: .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
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
	 * along the same axis — the typing-cadence amplifier shape captured in
	 * the 2026-05-27 iPad trace at pathId p:redacted.
	 *
	 * See spec:
	 *   .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
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

	private async createMarkdownConflictArtifact(
		path: string,
		content: string,
		reason: string,
		source?: "crdt" | "disk" | "editor",
	): Promise<MarkdownConflictArtifactResult> {
		const existing = await this.findExistingMarkdownConflictArtifact(path, content, source);
		if (existing !== null) {
			this.deps.trace("conflict", "conflict-artifact-deduped", {
				path,
				conflictPath: existing,
				reason,
				source: source ?? null,
				contentFingerprint: contentFingerprint(content),
			});
			return { path: existing, created: false };
		}

		const basePath = buildMarkdownConflictArtifactPath(path, {
			deviceName: this.deps.getSettings().deviceName,
			source,
		});
		for (let i = 0; i < 100; i++) {
			const candidate = buildMarkdownConflictArtifactCopyPath(basePath, i + 1);
			if (this.deps.app.vault.getAbstractFileByPath(candidate)) continue;
			await this.deps.getDiskMirror()?.suppressLocalCreate(candidate, content);
			await this.deps.app.vault.create(candidate, content);
			this.deps.trace("conflict", "conflict-artifact-created", {
				path,
				conflictPath: candidate,
				reason,
				source: source ?? null,
				contentLength: content.length,
			});
			return { path: candidate, created: true };
		}
		throw new Error(`could not create conflict artifact for ${path}`);
	}

	private async findExistingMarkdownConflictArtifact(
		path: string,
		content: string,
		source?: "crdt" | "disk" | "editor",
	): Promise<string | null> {
		const vault = this.deps.app.vault;
		if (typeof vault.getMarkdownFiles !== "function") return null;

		const targetFingerprint = contentFingerprint(content);
		for (const file of vault.getMarkdownFiles()) {
			if (!isMarkdownConflictArtifactForOriginalPath(file.path, path, source)) continue;
			try {
				const existingContent = await this.deps.app.vault.read(file);
				if (contentFingerprint(existingContent) === targetFingerprint && existingContent === content) {
					return file.path;
				}
			} catch {
				// If an existing candidate cannot be read, keep looking. The
				// create path below still preserves the competing version.
			}
		}
		return null;
	}

	private async updateDiskIndexForPath(
		path: string,
		settledContent?: string,
		stableStat?: { mtime: number; size: number } | null,
	): Promise<void> {
		try {
			const stat = stableStat ?? await this.deps.app.vault.adapter.stat(path);
			if (stat) {
				const existing = this.deps.getDiskIndex()[path];
				const settledHash = settledContent !== undefined
					? await contentBaselineHash(settledContent)
					: undefined;
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
				}
				this.deps.setDiskIndex({
					...this.deps.getDiskIndex(),
					[path]: nextEntry,
				});
			}
		} catch {
			// Stat failed, index will be stale for this path.
		}
	}

	/**
	 * Show a conflict notice with rate-limiting. Only one notice per
	 * CONFLICT_NOTICE_COOLDOWN_MS window; suppressed conflicts are
	 * counted and mentioned in the next notice.
	 */
	private showConflictNotice(message: string): void {
		const now = Date.now();
		if (now - this.lastConflictNoticeAt < ReconciliationController.CONFLICT_NOTICE_COOLDOWN_MS) {
			this.conflictNoticeSuppressionCount++;
			return;
		}
		const suppressed = this.conflictNoticeSuppressionCount;
		this.conflictNoticeSuppressionCount = 0;
		this.lastConflictNoticeAt = now;
		const suffix = suppressed > 0
			? ` (and ${suppressed} other conflict${suppressed > 1 ? "s" : ""} in the last 30s)`
			: "";
		new Notice(`KAOS: ${message}${suffix}`, 10000);
	}

	/**
	 * Show an amplification-quarantine notice with rate-limiting. Independent
	 * from showConflictNotice — these two surfaces are different: a conflict
	 * preserved a competing version, an amplification quarantine paused
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
