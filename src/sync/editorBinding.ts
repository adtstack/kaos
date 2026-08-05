import {
	Annotation,
	Compartment,
	EditorSelection,
	EditorState,
	Transaction,
	type Extension,
	type StateEffect,
	type Text,
	type TransactionSpec,
} from "@codemirror/state";
import {
	isolateHistory,
} from "@codemirror/commands";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { apiVersion, Notice, type MarkdownView, type TFile, type TextFileView } from "obsidian";
import type { VaultSync } from "./vaultSync";
import { applyDiffToYText, applyExactDiffToYText } from "./diff";
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
	ORIGIN_SAME_PATH_ADOPTION,
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
import {
	createManagedLeafSession,
	reduceManagedLeafSession,
	reserveManagedLeafInputStart,
	type EditorHandoffEffect,
	type HostLoadCompletionReceipt,
	type ManagedLeafInputStartReservation,
	type ManagedLeafSession,
	type MissingTargetSeedPlan,
	type PendingHostLoadCandidate,
} from "./editorHandoffState";
import {
	associateEditorHandoffHostQaBarrier,
	installTextFileViewHandoffGuard,
	type EditorHandoffHostQaBarrier,
	type ManagedSourceUnloadSnapshot,
	type ManagedDeferredLoadAdmissionSnapshot,
	type ManagedHostSwitchTicket,
	type ManagedViewSaveGuard,
	type TextFileViewEmergencySaveFence,
	type TextFileViewHandoffGuard,
} from "./textFileViewHandoffGuard";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffHostOperationDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
} from "../runtime/engineControlPort";
import {
	installCodeMirrorHandoffGuard,
	type CodeMirrorHandoffContext,
	type CodeMirrorHandoffGuard,
	type CodeMirrorHandoffGuardSnapshot,
	type TargetSelectionFenceToken,
} from "./codeMirrorHandoffGuard";
import { isMarkdownEditorView } from "../runtime/markdownEditorView";
import {
	createPathEditorAuthorityPort,
	type EditorAuthorityLease,
	type PathEditorAuthority,
	type PathEditorAuthorityPort,
	type PathEditorAuthoritySource,
} from "./pathEditorAuthority";
import type {
	AuthorityFreshnessContext,
	BindPermitContext,
	MissingTargetSeedResult,
	OpenPathAdmissionRequest,
	OpenPathAdmissionResult,
} from "../runtime/editorAuthorityAdmission";
import {
	NO_SAME_PATH_ADOPTION,
	type SamePathAdoptionBindContext,
	type SamePathAdoptionBindPermit,
	type SamePathAdoptionBindReceipt,
	type SamePathAdoptionConflictReceipt,
	type SamePathAdoptionMutationContext,
	type SamePathAdoptionMutationPermit,
	type SamePathAdoptionPostMutationProof,
	type SamePathAdoptionProposal,
	type SamePathAdoptionRequest,
	type SamePathAdoptionRequestResult,
	type SamePathAdoptionState,
} from "./samePathAdoption";
import { buildSamePathAdoptionChangeSet } from "../runtime/reconcile/samePathAdoptionPlanner";
import { sha256HandoffRecoveryHexSync } from "./handoffRecoveryStore";

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;
declare const samePathExternalCandidateProjectionProofBrand: unique symbol;
const EDITOR_HANDOFF_QA_ENABLED = typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
	&& __KAOS_QA_HARNESS_ENABLED__;
let editorHandoffHostApiVersionOverrideForQa: string | null = null;

export function setEditorHandoffHostApiVersionOverrideForQa(
	version: string | null,
): void {
	if (!EDITOR_HANDOFF_QA_ENABLED) {
		throw new Error("editor handoff host-version override is QA-only");
	}
	if (version !== null && (version.length === 0 || version.length > 32)) {
		throw new Error("Choose a bounded host API version override");
	}
	editorHandoffHostApiVersionOverrideForQa = version;
}

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
const EXTERNAL_DISK_CANDIDATE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 5000] as const;
const EXTERNAL_DISK_CANDIDATE_DISPOSITION_TTL_MS = 15_000;
const EXTERNAL_DISK_CANDIDATE_DISPOSITION_PER_PATH_LIMIT = 64;
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
const UNMANAGE_RETRY_DELAYS_MS = [120, 250, 500, 1000, 2000, 5000] as const;
const SAME_PATH_ADOPTION_RETRY_DELAYS_MS = [120, 250, 500, 1000, 2000, 5000] as const;
const STRUCTURAL_SOURCE_CLOSE_SETTLEMENT_MS = 50;

function sameCompositionSnapshot(
	left: CodeMirrorHandoffGuardSnapshot["activeComposition"]
		| CodeMirrorHandoffGuardSnapshot["lastComposition"],
	right: CodeMirrorHandoffGuardSnapshot["activeComposition"]
		| CodeMirrorHandoffGuardSnapshot["lastComposition"],
): boolean {
	if (left === null || right === null) return left === right;
	return left.compositionEpoch === right.compositionEpoch
		&& left.startGeneration === right.startGeneration
		&& left.updates === right.updates
		&& (("capturedUpdates" in left) === ("capturedUpdates" in right))
		&& (
			!("capturedUpdates" in left)
			|| ("capturedUpdates" in right && left.capturedUpdates === right.capturedUpdates)
		)
		&& left.replayEligible === right.replayEligible
		&& (
			("endGeneration" in left) === ("endGeneration" in right)
			&& (
				!("endGeneration" in left)
				|| (
				"endGeneration" in right
				&& left.endGeneration === right.endGeneration
				)
			)
		);
}

function sameCodeMirrorGuardSnapshot(
	left: CodeMirrorHandoffGuardSnapshot | null,
	right: CodeMirrorHandoffGuardSnapshot | null,
): boolean {
	if (left === null || right === null) return left === right;
	return left.view === right.view
		&& left.inert === right.inert
		&& left.gateClosed === right.gateClosed
		&& left.sourceUnloadDrain?.ownerId === right.sourceUnloadDrain?.ownerId
		&& left.sourceUnloadDrain?.reservation === right.sourceUnloadDrain?.reservation
		&& left.targetSelectionFence === right.targetSelectionFence
		&& left.inputEpoch === right.inputEpoch
		&& left.compositionEpoch === right.compositionEpoch
		&& left.nativeHistoryEpoch === right.nativeHistoryEpoch
		&& left.selectionEpoch === right.selectionEpoch
		&& left.scrollEpoch === right.scrollEpoch
		&& sameCompositionSnapshot(
			left.activeComposition,
			right.activeComposition,
		)
		&& sameCompositionSnapshot(left.lastComposition, right.lastComposition)
		&& left.gateFailureReason === right.gateFailureReason
		&& left.commitState === right.commitState
		&& left.pendingHostLoadCandidate === right.pendingHostLoadCandidate;
}

function sameHostGuardMode(
	left: ManagedViewSaveGuard["mode"],
	right: ManagedViewSaveGuard["mode"],
): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind !== "blocking-handoff"
		|| (
			right.kind === "blocking-handoff"
			&& left.handoffGeneration === right.handoffGeneration
			&& left.sourceLineagePath === right.sourceLineagePath
			&& left.targetPath === right.targetPath
		);
}

function sameDeferredLoadAdmissionSnapshot(
	left: ManagedViewSaveGuard["pendingDeferredLoadAdmission"],
	right: ManagedViewSaveGuard["pendingDeferredLoadAdmission"],
): boolean {
	const a = left ?? null;
	const b = right ?? null;
	if (a === null || b === null) return a === b;
	return a.ownerId === b.ownerId
		&& a.pendingLoadEpoch === b.pendingLoadEpoch
		&& a.targetFile === b.targetFile
		&& a.targetPath === b.targetPath
		&& a.sourceUnloadReceiptId === b.sourceUnloadReceiptId
		&& a.sourceUnloadId === b.sourceUnloadId
		&& a.sourceFile === b.sourceFile
		&& a.sourcePath === b.sourcePath
		&& a.viewFileAtEntry === b.viewFileAtEntry
		&& a.viewPathAtEntry === b.viewPathAtEntry;
}

function sameSourceUnloadDrainSnapshot(
	left: ManagedViewSaveGuard["pendingSourceUnloadDrain"],
	right: ManagedViewSaveGuard["pendingSourceUnloadDrain"],
): boolean {
	const a = left ?? null;
	const b = right ?? null;
	if (a === null || b === null) return a === b;
	return a.ownerId === b.ownerId
		&& a.sourceFile === b.sourceFile
		&& a.sourcePath === b.sourcePath
		&& a.viewFileAtEntry === b.viewFileAtEntry
		&& a.viewPathAtEntry === b.viewPathAtEntry
		&& a.nativeLoadEpochAtEntry === b.nativeLoadEpochAtEntry
		&& a.pendingLoadEpochAtEntry === b.pendingLoadEpochAtEntry
		&& a.saveEpochAtEntry === b.saveEpochAtEntry;
}

function hasNoPendingHostLoadOwner(snapshot: ManagedViewSaveGuard): boolean {
	return snapshot.pendingDeferredLoadAdmission == null;
}

function hasExactHostGuardWrappers(snapshot: ManagedViewSaveGuard): boolean {
	return snapshot.wrappersCurrent && snapshot.loadWrappersCurrent !== false;
}

function sameHostGuardSnapshot(
	left: ManagedViewSaveGuard | null,
	right: ManagedViewSaveGuard | null,
): boolean {
	if (left === null || right === null) return left === right;
	if (
		left.leafId !== right.leafId
		|| left.view !== right.view
		|| left.originalRequestSave !== right.originalRequestSave
		|| left.originalSave !== right.originalSave
		|| left.installedRequestSave !== right.installedRequestSave
		|| left.installedSave !== right.installedSave
		|| left.hostCapability !== right.hostCapability
		|| left.hostCapabilityState !== right.hostCapabilityState
		|| left.saveEpoch !== right.saveEpoch
		|| left.clearLoadCapability !== right.clearLoadCapability
		|| (left.pendingLoadEpoch ?? 0) !== (right.pendingLoadEpoch ?? 0)
		|| (left.nativeLoadEpoch ?? 0) !== (right.nativeLoadEpoch ?? 0)
		|| (left.pendingNativeHostLoadCount ?? 0)
			!== (right.pendingNativeHostLoadCount ?? 0)
		|| (left.nativeHostLoadAmbiguous ?? false)
			!== (right.nativeHostLoadAmbiguous ?? false)
		|| (left.managedClearTombstoneEpoch ?? 0)
			!== (right.managedClearTombstoneEpoch ?? 0)
		|| (left.managedClearTombstoneActive ?? false)
			!== (right.managedClearTombstoneActive ?? false)
		|| left.wrappersCurrent !== right.wrappersCurrent
		|| (left.loadWrappersCurrent ?? true) !== (right.loadWrappersCurrent ?? true)
		|| left.emergencySaveBlocked !== right.emergencySaveBlocked
		|| !sameHostGuardMode(left.mode, right.mode)
		|| left.pendingTargetSave !== right.pendingTargetSave
		|| left.pendingOwnedSave?.jobId !== right.pendingOwnedSave?.jobId
		|| left.pendingOwnedSave?.sessionId !== right.pendingOwnedSave?.sessionId
		|| left.pendingOwnedSave?.generation !== right.pendingOwnedSave?.generation
		|| left.pendingOwnedSave?.file !== right.pendingOwnedSave?.file
		|| left.pendingOwnedSave?.path !== right.pendingOwnedSave?.path
		|| left.pendingOwnedSave?.displayedPath !== right.pendingOwnedSave?.displayedPath
		|| left.pendingOwnedSave?.saveEpoch !== right.pendingOwnedSave?.saveEpoch
		|| left.sourceUnload?.receiptId !== right.sourceUnload?.receiptId
		|| left.sourceUnload?.unloadId !== right.sourceUnload?.unloadId
		|| left.sourceUnload?.file !== right.sourceUnload?.file
		|| left.sourceUnload?.path !== right.sourceUnload?.path
		|| left.sourceUnload?.state !== right.sourceUnload?.state
		|| left.sourceUnload?.forcedSaveObserved !== right.sourceUnload?.forcedSaveObserved
		|| left.sourceUnload?.cacheRetiredBeforeUnloadSettled
			!== right.sourceUnload?.cacheRetiredBeforeUnloadSettled
		|| !sameDeferredLoadAdmissionSnapshot(
			left.pendingDeferredLoadAdmission,
			right.pendingDeferredLoadAdmission,
		)
		|| !sameSourceUnloadDrainSnapshot(
			left.pendingSourceUnloadDrain,
			right.pendingSourceUnloadDrain,
		)
		|| left.terminalHostLifecycle?.ownerId !== right.terminalHostLifecycle?.ownerId
		|| left.terminalHostLifecycle?.state !== right.terminalHostLifecycle?.state
		|| left.inFlight.size !== right.inFlight.size
	) return false;
	for (const [id, entry] of left.inFlight) {
		const other = right.inFlight.get(id);
		if (
			other === undefined
			|| entry.file !== other.file
			|| entry.path !== other.path
			|| entry.startedAt !== other.startedAt
		) return false;
	}
	return true;
}

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	view: MarkdownView;
	file: TFile;
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
	authorityYtextMutationEpochAtBind?: number;
	localYtextMutationRevisionAtBind?: number;
}

type ActiveSamePathAdoptionDispatchFrame = {
	readonly frameIdentity: object;
	readonly proposal: SamePathAdoptionProposal;
	readonly runtime: ManagedLeafRuntime;
	readonly cm: EditorView;
	readonly startState: EditorState;
	transaction: Transaction | null;
	updateSeen: boolean;
};

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

interface ExistingBindingTarget {
	kind: "existing-target";
	ytext: Y.Text;
	fileId?: string;
	lease: EditorAuthorityLease;
}

interface MissingBindingTarget {
	kind: "missing-target";
	targetFile: TFile;
	targetPath: string;
}

type BindingTargetResolution = ExistingBindingTarget | MissingBindingTarget;

export type OpenPathAdmissionWakeRequest = Readonly<{
	bootSessionId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number | null;
	targetFile: TFile;
	targetPath: string;
}>;

export interface EditorAuthorityControllerPort {
	requestOpenPathAdmission(request: OpenPathAdmissionRequest): Promise<OpenPathAdmissionResult>;
	seedMissingTarget(plan: MissingTargetSeedPlan): Promise<MissingTargetSeedResult>;
	isAuthorityFreshnessCurrent(
		handleId: string,
		context: AuthorityFreshnessContext,
	): boolean;
	consumeBindPermit(permitId: string, context: BindPermitContext): boolean;
	requestSamePathAdoption?(
		request: SamePathAdoptionRequest,
	): Promise<SamePathAdoptionRequestResult>;
	consumeSamePathAdoptionMutationPermit?(
		permit: SamePathAdoptionMutationPermit,
		context: SamePathAdoptionMutationContext,
	): boolean;
	consumeSamePathAdoptionBindPermit?(
		permit: SamePathAdoptionBindPermit,
		context: SamePathAdoptionBindContext,
	): boolean;
	noteSamePathAdoptionBound?(receipt: SamePathAdoptionBindReceipt): void;
}

export interface EditorHandoffRecoveryActionHost {
	chooseVerifiedExporter(): Promise<((text: string) => Promise<void>) | null>;
}

type ManagedTransitionContainer = Readonly<{
	contains?(node: unknown): boolean;
	getAttribute?(name: string): string | null;
	setAttribute?(name: string, value: string): void;
	removeAttribute?(name: string): void;
}> & Record<PropertyKey, unknown>;

type ManagedTransitionInputFence = {
	readonly ownerId: string;
	readonly view: MarkdownView;
	readonly container: ManagedTransitionContainer;
	previousInert: unknown;
	hadOwnInert: boolean;
	previousInertAttribute: string | null;
	readonly cmGuard: CodeMirrorHandoffGuard;
	targetSelectionToken: TargetSelectionFenceToken | null;
	targetFile: TFile;
	targetPath: string;
	sessionId: string;
	handoffGeneration: number;
	switchIntentSeq: number | null;
	state: "preselection" | "handoff" | "reopen-required";
};

type ManagedHostLoadAdmissionAttempt = Readonly<{
	readonly runtime: ManagedLeafRuntime;
	readonly admission: ManagedDeferredLoadAdmissionSnapshot;
	readonly targetFile: TFile;
	readonly targetPath: string;
	readonly sourceUnloadReceiptId: string;
	readonly sourceSession: ManagedLeafSession;
	readonly sourceBinding: EditorBinding | undefined;
	readonly sourceBindingEpoch: number;
	readonly authorityEpoch: number;
}>;

type ManagedTargetMarkReleaseProof = Readonly<{
	runtime: ManagedLeafRuntime;
	sourceSession: ManagedLeafSession;
	candidate: PendingHostLoadCandidate;
	hostGuard: TextFileViewHandoffGuard;
	targetFile: TFile;
	targetPath: string;
}>;

type ObservedFileMismatchTerminalOwner = Readonly<{
	sessionId: string;
	generation: number;
	sourceFile: TFile;
	sourcePath: string;
	targetFile: TFile;
	targetPath: string;
}>;

type ManagedSourceUnloadDrainOwner = {
	readonly ownerId: string;
	readonly runtime: ManagedLeafRuntime;
	readonly sourceSession: ManagedLeafSession;
	readonly sourceFile: TFile;
	readonly sourcePath: string;
	readonly sourceBinding: EditorBinding | undefined;
	readonly sourceBindingEpoch: number;
	readonly cmGuard: CodeMirrorHandoffGuard;
	readonly reservation: ManagedLeafInputStartReservation | null;
	readonly promise: Promise<void>;
	state: "draining" | "fenced" | "terminal" | "transferred";
	targetSelectionToken: TargetSelectionFenceToken | null;
	structuralEditorOnlyCompletion: boolean;
	settlementQueued: boolean;
	settled: boolean;
	readonly resolve: () => void;
	readonly reject: (reason: Error) => void;
};

type PendingStructuralSourceCloseSettlement = {
	readonly runtime: ManagedLeafRuntime;
	readonly owner: ManagedSourceUnloadDrainOwner;
	readonly reason: string;
	readonly recoveryContent: string;
	readonly exactRecovery: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	settling: boolean;
};

type ManagedLeafRuntime = {
	session: ManagedLeafSession;
	hostGuard: TextFileViewHandoffGuard | null;
	emergencySaveFence: TextFileViewEmergencySaveFence | null;
	cmGuard: CodeMirrorHandoffGuard | null;
	capturedSourceAuthority: PathEditorAuthority | null;
	transitionInputFence: ManagedTransitionInputFence | null;
	sourceUnloadDrain: ManagedSourceUnloadDrainOwner | null;
	adoption: SamePathAdoptionState;
};

type ManagedContinuationTicket = Readonly<{
	bootSessionId: string;
	sessionId: string;
	handoffGeneration: number;
	view: MarkdownView;
	targetFile: TFile;
	targetPath: string;
	cm: EditorView | null;
	bindingEpoch: number;
}>;

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
}

export type InterceptedExternalDiskMutation = Readonly<
	Omit<ExternalDiskMutationNotice, "content"> & { content: string }
>;

export type ExternalDiskMutationCompletionDisposition =
	| "controller-owned"
	| "terminal-no-candidate";

type ExternalDiskMutationProvenance = "external" | "self-write";

interface PendingExternalDiskMutation extends ExternalDiskMutationNotice {
	/** Exact fingerprint disposition for this event revision. */
	provenance: ExternalDiskMutationProvenance;
	at: number;
	consumedLeafIds: Set<string>;
	/**
	 * Exact binding lifetimes that were already present, and still correlated,
	 * when this event's raw read completed. A leaf ID alone is not authority: a
	 * pane may close and reopen under the same ID while another pane keeps this
	 * path-scoped marker alive. `null` is retained only for direct/legacy notices
	 * that did not pass through beginExternalDiskMutation.
	 */
	eligibleOwners: Map<string, PendingExternalDiskMutationOwner> | null;
	retireScheduled: boolean;
	candidatePublished: boolean;
}

interface PendingExternalDiskMutationOwner {
	continuation: ManagedContinuationTicket;
	binding: EditorBinding;
	bindingEpoch: number;
}

interface PendingExternalDiskCandidateDeliveryRetry {
	readonly candidate: InterceptedExternalDiskMutation;
	retryAttempt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

interface ExternalDiskCandidateDispositionEntry {
	readonly sequence: number;
	timer: ReturnType<typeof setTimeout> | null;
}

type ExternalDiskCandidateDispositionLedger =
	Map<string, Map<number, ExternalDiskCandidateDispositionEntry>>;

type ExternalDiskCandidateDeliveryAttempt =
	| "delivered"
	| "already-resolved"
	| "callback-unavailable"
	| "claim-busy"
	| "callback-failed";

type ExternalDiskCandidateDeliveryDisposition =
	| "delivered"
	| "retained-for-retry"
	| "callback-unavailable";

interface HeldExternalDiskHostProjection {
	beforeContent: string;
	hostMergedContent: string;
	externalLogicalContent: string;
}

interface ExternalDiskHostViewSnapshot {
	continuation: ManagedContinuationTicket;
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

interface ExternalDiskHostSnapshotProof {
	start: PendingExternalDiskMutationStart;
	snapshot: ExternalDiskHostViewSnapshot;
	runtimeView: MarkdownView & { data?: unknown; lastSavedData?: unknown };
}

interface ExternalDiskHostSaveFenceLease {
	runtime: ManagedLeafRuntime;
	fence: TextFileViewEmergencySaveFence;
	acquiredForProjection: boolean;
}

interface RecentEditorOriginChange {
	continuation: ManagedContinuationTicket;
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
	| "external-reload-correction"
	| "same-path-adoption";

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

const SAME_PATH_ADOPTION_TRANSACTION = Annotation.define<Readonly<{
	proposal: SamePathAdoptionProposal;
	frameIdentity: object;
}>>();

/**
 * `filter: false` deliberately bypasses transaction filters. The extender still
 * runs, so mark an exact external reload for a post-update compare-and-revert.
 */
const EXTERNAL_RELOAD_FILTER_BYPASS = Annotation.define<ExternalReloadFilterBypass>();

export type OpenEditorMutationInvalidReason =
	| "boot-session-changed"
	| "authority-epoch-changed"
	| "handoff-generation-changed"
	| "displayed-lineage-changed"
	| "target-file-changed"
	| "switch-intent-changed"
	| "native-history-epoch-changed"
	| "selection-epoch-changed"
	| "scroll-epoch-changed"
	| "path-changed"
	| "view-set-changed"
	| "view-replaced"
	| "view-id-changed"
	| "cm-changed"
	| "cm-id-changed"
	| "binding-epoch-changed"
	| "editor-document-changed"
	| "editor-revision-changed"
	| "editor-authority-revision-changed"
	| "editor-authority-content-changed"
	| "editor-read-failed";

export interface OpenEditorMutationViewTicket {
	readonly bootSessionId: string;
	readonly sessionId: string;
	readonly handoffGeneration: number;
	readonly displayedFile: TFile | null;
	readonly displayedPath: string | null;
	readonly targetFile: TFile;
	readonly stableTargetIdentityProven: boolean;
	readonly switchIntentSeq: number | null;
	readonly nativeHistoryEpoch: number;
	readonly selectionEpoch: number;
	readonly scrollEpoch: number;
	/** Legacy controller evidence; the manager no longer publishes target-proven. */
	readonly handoffPresentation: "stable" | "source" | "target-candidate" | "target-proven";
	/** Compatibility-only evidence. Automatic recovery phases are never emitted. */
	readonly handoffPhase: string | null;
	/** Compatibility-only evidence. Switch input is never persisted by the manager. */
	readonly intentStateKind: string | null;
	readonly pendingHostLoadTokenId: string | null;
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

/**
 * Exact, read-only evidence for the one projection-hold exception owned by the
 * reconciliation controller.  The controller still owns external-candidate
 * identity and disk CAS; the binding manager proves only that the hold is a
 * same-path required retry over the exact visible bytes, not a handoff,
 * conflict, awaiting-disk, or in-flight adoption proposal.
 */
export interface SamePathExternalCandidateProjectionProofInput {
	readonly path: string;
	readonly file: TFile;
	readonly content: string;
	readonly openEditorTicket: OpenEditorMutationTicket;
	readonly editorAuthorityLease: EditorAuthorityLease;
}

export type SamePathExternalCandidateProjectionProof = Readonly<
	SamePathExternalCandidateProjectionProofInput & {
		readonly [samePathExternalCandidateProjectionProofBrand]: true;
	}
>;

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

type EditorHandoffHostQaBarrierState = EditorHandoffHostQaBarrier & Readonly<{
	holdNextHostLoad(path: string, stage?: "load-entry" | "clear-load"): void;
	releaseHeldHostLoad(): void;
	holdNextNativeSave(path: string): void;
	releaseHeldNativeSave(): void;
	recordInterceptedExternalDiskMutation(receipt: NonNullable<
		EditorHandoffDebugSnapshot["lastInterceptedExternalDiskMutation"]
	>): void;
	snapshot(): EditorHandoffDebugSnapshot;
}>;

const editorHandoffHostQaBarriers = EDITOR_HANDOFF_QA_ENABLED
	? new WeakMap<EditorBindingManager, EditorHandoffHostQaBarrierState>()
	: null;

function createEditorHandoffHostQaBarrierState(
	manager: EditorBindingManager,
): EditorHandoffHostQaBarrierState {
	type HeldHostLoad = Readonly<{
		leafId: string;
		continueHostLoad(): "applied" | "rejected";
		resolve(outcome: "applied" | "rejected"): void;
	}>;
	type HeldNativeSave = Readonly<{
		leafId: string;
		continueNativeSave(): Promise<"delegated" | "suppressed" | "rejected">;
		resolve(): void;
		reject(reason: unknown): void;
	}>;
	let armedHostLoad: Readonly<{
		path: string;
		stage: "load-entry" | "clear-load";
	}> | null = null;
	let armedNativeSavePath: string | null = null;
	let hostLoadSnapshot: EditorHandoffHostOperationDebugSnapshot | null = null;
	let nativeSaveSnapshot: EditorHandoffHostOperationDebugSnapshot | null = null;
	let heldHostLoad: HeldHostLoad | null = null;
	let heldNativeSave: HeldNativeSave | null = null;
	let lastInterceptedExternalDiskMutation: EditorHandoffDebugSnapshot[
		"lastInterceptedExternalDiskMutation"
	] = null;

	const currentIdentity = (leafId: string): Readonly<{
		sessionId: string | null;
		generation: number | null;
	}> => {
		const internals = manager as unknown as {
			managedSessions: Map<string, ManagedLeafRuntime>;
		};
		const session = internals.managedSessions.get(leafId)?.session;
		return {
			sessionId: session?.sessionId ?? null,
			generation: session?.generation ?? null,
		};
	};

	const operation = (
		kind: "host-load" | "native-save",
		state: EditorHandoffHostOperationDebugSnapshot["state"],
		path: string,
		leafId: string | null,
		sessionId: string | null,
		generation: number | null,
		invocationPath: string | null,
		outcome: EditorHandoffHostOperationDebugSnapshot["outcome"],
	): EditorHandoffHostOperationDebugSnapshot => Object.freeze({
		kind,
		state,
		path,
		leafId,
		sessionId,
		generation,
		invocationPath,
		outcome,
	});

	const snapshotLeaves = (): EditorHandoffDebugSnapshot["leaves"] => {
		const internals = manager as unknown as {
			managedSessions: Map<string, ManagedLeafRuntime>;
			bindings: Map<string, EditorBinding>;
			cmIds: WeakMap<EditorView, string>;
		};
		return Array.from(internals.managedSessions.values(), (runtime) => {
			const session = runtime.session;
			const handoff = session.handoff;
			const binding = internals.bindings.get(session.leafId) ?? null;
			const guardSnapshot = runtime.cmGuard?.snapshot() ?? null;
			const hostSnapshot = runtime.hostGuard?.snapshot() ?? null;
			const cm = guardSnapshot?.view ?? binding?.cm ?? null;
			const cmId = cm ? internals.cmIds.get(cm) ?? binding?.cmId ?? null : null;
			const viewData = (session.view as MarkdownView & { data?: unknown }).data;
			const leafContainer = (session.view.leaf as unknown as {
				containerEl?: { classList?: { contains(name: string): boolean } };
			}).containerEl;
			const adoption = runtime.adoption;
			const adoptionSnapshot: EditorHandoffManagedLeafDebugSnapshot["adoption"] =
				adoption.kind === "none"
					? Object.freeze({ kind: "none" })
					: adoption.kind === "capturing" || adoption.kind === "planning"
						? Object.freeze({
							kind: adoption.kind,
							adoptionId: adoption.adoptionId,
							requestId: adoption.requestId,
							path: adoption.path,
							planKind: adoption.proposal?.plan.kind ?? null,
							startEditorRevision: adoption.startEditorRevision,
							latestEditorRevision: adoption.latestEditorRevision,
							editorTransactionSeq: adoption.editorTransactionSeq,
							bindingEpoch: adoption.bindingEpoch,
							nativeHistoryEpoch: adoption.nativeHistoryEpoch,
							inputEpoch: adoption.inputEpoch,
							compositionEpoch: adoption.compositionEpoch,
							activeCompositionEpoch: adoption.activeCompositionEpoch,
							selectionEpoch: adoption.selectionEpoch,
							scrollEpoch: adoption.scrollEpoch,
							hostSaveEpoch: adoption.hostSaveEpoch,
						})
						: adoption.kind === "awaiting-disk"
							? Object.freeze({
								kind: adoption.kind,
								adoptionId: adoption.adoptionId,
								proposalId: adoption.proposalId,
								path: adoption.path,
							})
							: adoption.kind === "conflict"
								? Object.freeze({
								kind: adoption.kind,
								adoptionId: adoption.adoptionId,
								path: adoption.path,
								status: adoption.status,
								retryable: adoption.retryable,
								mergeMode: adoption.mergeMode,
								baseRetained: adoption.baseHash !== null,
								crdtArtifactPath: adoption.crdtArtifactPath,
								editorArtifactPaths: Object.freeze([
									...adoption.editorArtifactPaths,
								]),
								failureReason: adoption.failureReason,
								})
								: Object.freeze({ kind: "none" });
			const qaFailureDetails = (
				typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
				&& __KAOS_QA_HARNESS_ENABLED__
			)
				? Object.freeze({
					commitFailureReason: guardSnapshot?.commitFailureReason ?? null,
					gateAuthorityAdvanceFailureReason:
						guardSnapshot?.gateAuthorityAdvanceFailureReason ?? null,
					inputAuthorityAdvanceFailureReason:
						guardSnapshot?.inputAuthorityAdvanceFailureReason ?? null,
					hostPostDelegationFailureReason:
						guardSnapshot?.hostPostDelegationFailureReason ?? null,
				})
				: Object.freeze({});
			return Object.freeze({
				managed: true as const,
				active: leafContainer?.classList?.contains("mod-active") === true,
				leafId: session.leafId,
				sessionId: session.sessionId,
				generation: session.generation,
				viewPath: session.view.file?.path ?? null,
				displayedPath: session.displayedLineage.kind === "known"
					? session.displayedLineage.path
					: null,
				bindingPath: binding?.path ?? null,
				cmId,
				presentation: handoff?.presentation ?? "none",
				phase: "stable",
				recoveryOperationEpoch: null,
				inputGateInstalled: handoff?.inputGateInstalled ?? false,
				saveGuardInstalled: handoff?.saveGuardInstalled ?? false,
				hostCapability: hostSnapshot?.hostCapability ?? null,
				hostCapabilityState: hostSnapshot?.hostCapabilityState ?? null,
				clearLoadCapability: hostSnapshot?.clearLoadCapability ?? null,
				hostSaveEpoch: hostSnapshot?.saveEpoch ?? null,
				adoption: adoptionSnapshot,
				sourceUnload: hostSnapshot?.sourceUnload
					? Object.freeze({
						receiptId: hostSnapshot.sourceUnload.receiptId,
						path: hostSnapshot.sourceUnload.path,
						state: hostSnapshot.sourceUnload.state,
						forcedSaveObserved: hostSnapshot.sourceUnload.forcedSaveObserved,
						cacheRetiredBeforeUnloadSettled:
							hostSnapshot.sourceUnload.cacheRetiredBeforeUnloadSettled,
					})
					: null,
				gateClosed: guardSnapshot?.gateClosed ?? false,
				gateFailureReason: guardSnapshot?.gateFailureReason ?? null,
				commitState: guardSnapshot?.commitState ?? "none",
				...qaFailureDetails,
				inputEpoch: guardSnapshot?.inputEpoch ?? null,
				compositionEpoch: guardSnapshot?.compositionEpoch ?? null,
				compositionActive: guardSnapshot?.activeComposition != null,
				compositionOwnerCmId: guardSnapshot?.activeComposition ? cmId : null,
				activeCompositionUpdates: guardSnapshot?.activeComposition?.updates ?? null,
				activeCompositionCapturedUpdates:
					guardSnapshot?.activeComposition?.capturedUpdates ?? null,
				lastComposition: guardSnapshot?.lastComposition
					? Object.freeze({ ...guardSnapshot.lastComposition })
					: null,
				intent: null,
				nativeHistoryEpoch: guardSnapshot?.nativeHistoryEpoch ?? null,
				selectionEpoch: guardSnapshot?.selectionEpoch ?? null,
				scrollEpoch: guardSnapshot?.scrollEpoch ?? null,
				editorLength: cm?.state.doc.length ?? null,
				hostDataLength: typeof viewData === "string" ? viewData.length : null,
			});
		}).sort((left, right) => left.leafId.localeCompare(right.leafId));
	};

	const barrier: EditorHandoffHostQaBarrierState = {
		holdNextHostLoad(path, stage = "load-entry"): void {
			if (!path || armedHostLoad !== null || heldHostLoad) {
				throw new Error("host-load hold is unavailable");
			}
			armedHostLoad = Object.freeze({ path, stage });
			hostLoadSnapshot = operation(
				"host-load", "armed", path, null, null, null, null, "pending",
			);
		},

		releaseHeldHostLoad(): void {
			const held = heldHostLoad;
			const current = hostLoadSnapshot;
			if (!held || !current || current.state !== "held") {
				throw new Error("no held host load");
			}
			heldHostLoad = null;
			let outcome: "applied" | "rejected" = "rejected";
			try {
				outcome = held.continueHostLoad();
			} finally {
				hostLoadSnapshot = operation(
					"host-load",
					outcome === "applied" ? "released" : "rejected",
					current.path,
					current.leafId,
					current.sessionId,
					current.generation,
					current.invocationPath,
					outcome,
				);
				held.resolve(outcome);
			}
		},

		holdNextNativeSave(path): void {
			if (!path || armedNativeSavePath !== null || heldNativeSave) {
				throw new Error("native-save hold is unavailable");
			}
			armedNativeSavePath = path;
			nativeSaveSnapshot = operation(
				"native-save", "armed", path, null, null, null, path, "pending",
			);
		},

		releaseHeldNativeSave(): void {
			const held = heldNativeSave;
			const current = nativeSaveSnapshot;
			if (!held || !current || current.state !== "held") {
				throw new Error("no held native save");
			}
			heldNativeSave = null;
			void held.continueNativeSave().then(
				(outcome) => {
					nativeSaveSnapshot = operation(
						"native-save",
						outcome === "rejected" ? "rejected" : "released",
						current.path,
						current.leafId,
						current.sessionId,
						current.generation,
						current.invocationPath,
						outcome,
					);
					held.resolve();
				},
				(error) => {
					nativeSaveSnapshot = operation(
						"native-save", "rejected", current.path, current.leafId,
						current.sessionId, current.generation, current.invocationPath, "rejected",
					);
					held.reject(error);
				},
			);
		},

		tryHoldHostLoad(input) {
			const armed = armedHostLoad;
			if (
				armed?.path !== input.targetPath
				|| armed.stage !== input.stage
				|| heldHostLoad
			) return null;
			armedHostLoad = null;
			let resolve!: (outcome: "applied" | "rejected") => void;
			const settlement = new Promise<"applied" | "rejected">((resolvePromise) => {
				resolve = resolvePromise;
			});
			heldHostLoad = {
				leafId: input.leafId,
				continueHostLoad: input.continueHostLoad,
				resolve,
			};
			hostLoadSnapshot = operation(
				"host-load", "held", input.targetPath, input.leafId, input.sessionId,
				input.generation, input.invocationFile?.path ?? null, "pending",
			);
			return Object.freeze({ settlement });
		},

		tryHoldNativeSave(input): Promise<void> | null {
			const invocationPath = input.invocationFile?.path ?? null;
			if (armedNativeSavePath !== invocationPath || heldNativeSave) return null;
			armedNativeSavePath = null;
			const identity = currentIdentity(input.leafId);
			let resolve!: () => void;
			let reject!: (reason: unknown) => void;
			const heldPromise = new Promise<void>((resolvePromise, rejectPromise) => {
				resolve = resolvePromise;
				reject = rejectPromise;
			});
			heldNativeSave = {
				leafId: input.leafId,
				continueNativeSave: input.continueNativeSave,
				resolve,
				reject,
			};
			nativeSaveSnapshot = operation(
				"native-save", "held", invocationPath ?? "", input.leafId,
				input.sessionId ?? identity.sessionId,
				input.generation ?? identity.generation,
				invocationPath,
				"pending",
			);
			return heldPromise;
		},

		invalidateGuard(leafId): void {
			if (heldHostLoad?.leafId === leafId && hostLoadSnapshot) {
				const held = heldHostLoad;
				const current = hostLoadSnapshot;
				heldHostLoad = null;
				hostLoadSnapshot = operation(
					"host-load", "rejected", current.path, current.leafId,
					current.sessionId, current.generation, current.invocationPath, "rejected",
				);
				held.resolve("rejected");
			}
			if (heldNativeSave?.leafId === leafId && nativeSaveSnapshot) {
				const held = heldNativeSave;
				const current = nativeSaveSnapshot;
				heldNativeSave = null;
				nativeSaveSnapshot = operation(
					"native-save", "rejected", current.path, current.leafId,
					current.sessionId, current.generation, current.invocationPath, "rejected",
				);
				held.resolve();
			}
		},

		recordInterceptedExternalDiskMutation(receipt): void {
			lastInterceptedExternalDiskMutation = Object.freeze({ ...receipt });
		},

		snapshot(): EditorHandoffDebugSnapshot {
			return Object.freeze({
				hostLoad: hostLoadSnapshot,
				nativeSave: nativeSaveSnapshot,
				lastInterceptedExternalDiskMutation,
				leaves: Object.freeze(snapshotLeaves()),
			});
		},
	};
	return barrier;
}

export function installEditorHandoffHostQaBarrier(manager: EditorBindingManager): void {
	if (!EDITOR_HANDOFF_QA_ENABLED || editorHandoffHostQaBarriers?.has(manager)) return;
	editorHandoffHostQaBarriers?.set(manager, createEditorHandoffHostQaBarrierState(manager));
}

function requireEditorHandoffHostQaBarrier(
	manager: EditorBindingManager,
): EditorHandoffHostQaBarrierState {
	const barrier = editorHandoffHostQaBarriers?.get(manager);
	if (!EDITOR_HANDOFF_QA_ENABLED || !barrier) {
		throw new Error("editor handoff QA barrier is unavailable");
	}
	return barrier;
}

export function holdNextEditorHostLoadForQa(
	manager: EditorBindingManager,
	path: string,
	stage: "load-entry" | "clear-load" = "load-entry",
): void {
	requireEditorHandoffHostQaBarrier(manager).holdNextHostLoad(path, stage);
}

export function releaseHeldEditorHostLoadForQa(manager: EditorBindingManager): void {
	requireEditorHandoffHostQaBarrier(manager).releaseHeldHostLoad();
}

export function holdNextEditorNativeSaveForQa(
	manager: EditorBindingManager,
	path: string,
): void {
	requireEditorHandoffHostQaBarrier(manager).holdNextNativeSave(path);
}

export function releaseHeldEditorNativeSaveForQa(manager: EditorBindingManager): void {
	requireEditorHandoffHostQaBarrier(manager).releaseHeldNativeSave();
}

export function getEditorHandoffQaDebugSnapshot(
	manager: EditorBindingManager,
): EditorHandoffDebugSnapshot {
	return requireEditorHandoffHostQaBarrier(manager).snapshot();
}

export type EditorBindingCryptoSource = Readonly<{
	randomUUID?: () => string;
	getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}>;

export function createEditorBindingBootSessionId(
	cryptoSource: EditorBindingCryptoSource | null | undefined = globalThis.crypto,
): string {
	if (cryptoSource !== null && cryptoSource !== undefined) {
		try {
			const value = cryptoSource.randomUUID?.();
			if (
				typeof value === "string"
				&& /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
			) return value.toLowerCase();
		} catch {
			// Fall through to getRandomValues while cryptographic randomness remains available.
		}
		if (typeof cryptoSource.getRandomValues === "function") {
			const bytes = new Uint8Array(16);
			try {
				cryptoSource.getRandomValues(bytes);
				bytes[6] = (bytes[6]! & 0x0f) | 0x40;
				bytes[8] = (bytes[8]! & 0x3f) | 0x80;
				const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
				return [
					hex.slice(0, 4).join(""),
					hex.slice(4, 6).join(""),
					hex.slice(6, 8).join(""),
					hex.slice(8, 10).join(""),
					hex.slice(10, 16).join(""),
				].join("-");
			} catch {
				// The caller receives one stable fail-closed error below.
			}
		}
	}
	throw new Error("Secure editor binding boot-session ID is unavailable");
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();
	private readonly bootSessionId = createEditorBindingBootSessionId();
	private managedSessionCounter = 0;
	private managedAuthorityRequestCounter = 0;
	private managedSessions = new Map<string, ManagedLeafRuntime>();
	private pendingAdmissionByLeafId = new Map<string, OpenPathAdmissionWakeRequest>();
	private authorityEpoch = 0;
	private authorityEpochExhausted = false;
	private asyncAuthorityOpen = true;
	private readonly pathEditorAuthorityPort: PathEditorAuthorityPort;
	private destroyedUndoManagers = new WeakSet<Y.UndoManager>();
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
	private pendingUnmanageRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingStructuralSourceCloseSettlements =
		new Map<string, PendingStructuralSourceCloseSettlement>();
	private unmanageRetryAttempts = new Map<string, number>();
	private localTargetPresentationIdByCandidate =
		new WeakMap<PendingHostLoadCandidate, string>();
	private terminalVisibleContentExportByRuntime =
		new WeakMap<ManagedLeafRuntime, string>();
	private observedFileMismatchTerminalByRuntime =
		new WeakMap<ManagedLeafRuntime, ObservedFileMismatchTerminalOwner>();
	private pendingYTextPatches = new WeakMap<Y.Text, PendingYTextPatch>();
	private yTextMutationRevisionByText = new WeakMap<Y.Text, number>();
	private lastYTextMutationTransactionByText = new WeakMap<Y.Text, Y.Transaction>();
	private editorAuthorityShieldLeafIds = new Set<string>();
	private editorAuthorityShieldContinuations = new Map<string, ManagedContinuationTicket>();
	private lastEditorDocChangeAtByPath = new Map<string, number>();
	private lastUserDocChangeAtByCm = new WeakMap<EditorView, number>();
	private editorRevisionByCm = new WeakMap<EditorView, number>();
	private samePathAdoptionTransactionSeqByCm = new WeakMap<EditorView, number>();
	private samePathAdoptionRefreshScheduled = new Set<string>();
	private pendingSamePathAdoptionRetries =
		new Map<string, ReturnType<typeof setTimeout>>();
	private samePathAdoptionRetryAttempts = new Map<string, number>();
	private samePathAdoptionRequiredPathByLeafId = new Map<string, string>();
	private activeSamePathExternalCandidateProjectionProofByPath =
		new Map<string, SamePathExternalCandidateProjectionProof>();
	private samePathExternalCandidateProjectionProofOwners = new WeakMap<
		SamePathExternalCandidateProjectionProof,
		ReadonlyMap<string, ManagedLeafRuntime>
	>();
	private editorAuthorityRevisionByCm = new WeakMap<EditorView, number>();
	private editorAuthorityContentByCm = new WeakMap<EditorView, string>();
	private bindingPublicationOwnerByCm = new WeakMap<EditorView, object>();
	private bindingEpochByLeafId = new Map<string, number>();
	private activeSamePathAdoptionDispatchFrame: ActiveSamePathAdoptionDispatchFrame | null = null;
	private samePathAdoptionPostMutationProofs =
		new WeakSet<SamePathAdoptionPostMutationProof>();
	private pendingReplacementCmToLeafId = new WeakMap<EditorView, string>();
	private lastTypingAwarenessAtByLeaf = new Map<string, number>();
	private concurrentTypingNoticeAtByPath = new Map<string, number>();
	private pendingExternalDiskMutations = new Map<string, PendingExternalDiskMutation>();
	private pendingExternalDiskMutationStarts = new Map<string, PendingExternalDiskMutationStart>();
	private pendingExternalDiskCorrelationTimers = new Set<ReturnType<typeof setTimeout>>();
	private pendingExternalDiskCandidateDeliveryRetries =
		new Map<string, Map<number, PendingExternalDiskCandidateDeliveryRetry>>();
	private deliveredExternalDiskCandidateSequencesByPath: ExternalDiskCandidateDispositionLedger =
		new Map();
	private selfWriteExternalDiskMutationSequencesByPath: ExternalDiskCandidateDispositionLedger =
		new Map();
	private activeSelfWriteExternalDiskMutationSequencesByPath = new Map<string, Set<number>>();
	private pendingExternalDiskHostProjectionFences =
		new WeakMap<EditorState, PendingExternalDiskHostProjectionFence>();
	/**
	 * Callback delivery is claimed before invoking controller code. The short
	 * in-flight claim is separate from the durable delivered/self disposition and
	 * the replaceable path marker, so callback reentry cannot duplicate delivery.
	 */
	private claimedExternalDiskCandidateSequencesByPath = new Map<string, Set<number>>();
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
		private readonly requestOpenPathAdmissionCallback?: (
			request: OpenPathAdmissionWakeRequest,
		) => void,
		private readonly editorAuthorityControllerPort?: EditorAuthorityControllerPort,
		private readonly handoffRecoveryActionHost?: EditorHandoffRecoveryActionHost,
	) {
		this.debug = debug;
		const authoritySource: PathEditorAuthoritySource = {
			readAuthorityEpoch: () => this.readAuthorityEpoch(),
			captureManagedPanes: () => this.captureAuthorityManagedPanes(),
			captureOpenFileViews: (path) => this.captureAuthorityOpenFileViews(path),
		};
		this.pathEditorAuthorityPort = createPathEditorAuthorityPort(authoritySource);
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

	private createManagedAuthorityRequestId(kind: string): string {
		this.managedAuthorityRequestCounter += 1;
		return `${this.bootSessionId}:${kind}:${this.managedAuthorityRequestCounter}`;
	}

	private readAuthorityEpoch(): number {
		return this.authorityEpoch;
	}

	private advanceAuthorityEpoch(): void {
		if (this.authorityEpochExhausted) return;
		if (this.authorityEpoch >= Number.MAX_SAFE_INTEGER) {
			this.authorityEpochExhausted = true;
			return;
		}
		this.authorityEpoch += 1;
	}

	private captureAuthorityManagedPanes(): ReturnType<PathEditorAuthoritySource["captureManagedPanes"]> {
		if (this.authorityEpochExhausted) throw new Error("Editor authority epoch exhausted");
		return Array.from(this.managedSessions.values(), (runtime) => {
			const session = runtime.session;
			const currentCm = this.getCmView(session.view);
			let read: { kind: "ok"; content: string } | { kind: "failed" };
			try {
				const editorContent = session.view.editor.getValue();
				const cmContent = currentCm?.state.doc.toString() ?? null;
				read = currentCm !== null
					&& this.isManagedBoundaryLive(runtime, currentCm)
					&& cmContent === editorContent
					? { kind: "ok", content: editorContent }
					: { kind: "failed" };
			} catch {
				read = { kind: "failed" };
			}
			return {
				session,
				currentCm,
				bindingEpoch: this.bindingEpochByLeafId.get(session.leafId) ?? 0,
				editorRevision: currentCm ? (this.editorRevisionByCm.get(currentCm) ?? 0) : 0,
				read,
			};
		});
	}

	private captureAuthorityOpenFileViews(path: string): readonly unknown[] {
		if (this.authorityEpochExhausted) throw new Error("Editor authority epoch exhausted");
		const views: unknown[] = [];
		const seen = new Set<unknown>();
		const add = (view: unknown): void => {
			if (seen.has(view)) return;
			if (!isMarkdownEditorView(view)) return;
			const filePath = (view as { file?: { path?: unknown } } | null)?.file?.path;
			if (filePath !== path) return;
			seen.add(view);
			views.push(view);
		};
		let iteratedWorkspace = false;
		for (const runtime of this.managedSessions.values()) {
			const workspace = (runtime.session.view as unknown as {
				app?: {
					workspace?: {
						iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
					};
				};
			}).app?.workspace;
			if (typeof workspace?.iterateAllLeaves !== "function") continue;
			iteratedWorkspace = true;
			workspace.iterateAllLeaves((leaf) => add(leaf.view));
			break;
		}
		if (!iteratedWorkspace) {
			for (const runtime of this.managedSessions.values()) add(runtime.session.view);
		}
		return views;
	}

	private captureOpenViewsForAdmission(path: string): MarkdownView[] {
		return this.captureAuthorityOpenFileViews(path).filter(
			(view): view is MarkdownView =>
				(view as MarkdownView | null)?.file?.path === path,
		);
	}

	capturePathEditorAuthority(path: string): PathEditorAuthority {
		return this.pathEditorAuthorityPort.capturePathEditorAuthority(path);
	}

	isPathEditorAuthorityLeaseCurrent(lease: EditorAuthorityLease): boolean {
		return this.pathEditorAuthorityPort.isLeaseCurrent(lease);
	}

	isSamePathAdoptionRequestCurrent(request: SamePathAdoptionRequest): boolean {
		if (
			!this.asyncAuthorityOpen
			|| (
				request.editorAuthority.kind !== "proven-single"
				&& !(
					request.editorAuthority.kind === "blocked"
					&& request.editorAuthority.reason === "multiple"
				)
			)
		) {
			return false;
		}
		const runtime = this.managedSessions.get(request.leafId);
		const session = runtime?.session;
		const adoption = runtime?.adoption;
		if (
			!runtime
			|| !session
			|| !adoption
			|| (adoption.kind !== "capturing" && adoption.kind !== "planning")
			|| adoption.adoptionId !== request.adoptionId
			|| adoption.requestId !== request.requestId
			|| session.sessionId !== request.sessionId
			|| session.generation !== request.generation
			|| session.leafId !== request.leafId
			|| session.view !== adoption.view
			|| session.view.file !== request.file
			|| request.file.path !== request.path
			|| session.handoff !== null
			|| session.binding.kind !== "unbound"
			|| session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== request.file
			|| session.displayedLineage.path !== request.path
			|| session.displayedLineage.cm !== request.cm
			|| session.displayedLineage.document !== request.startDocument
			|| adoption.view !== session.view
			|| adoption.file !== request.file
			|| adoption.path !== request.path
			|| adoption.cm !== request.cm
			|| adoption.startDocument !== request.startDocument
			|| adoption.startEditorRevision !== request.editorRevision
			|| adoption.latestEditorRevision !== request.editorRevision
			|| adoption.editorTransactionSeq !== request.editorTransactionSeq
			|| adoption.bindingEpoch !== request.bindingEpoch
			|| adoption.nativeHistoryEpoch !== request.nativeHistoryEpoch
			|| adoption.inputEpoch !== request.inputEpoch
			|| adoption.compositionEpoch !== request.compositionEpoch
			|| adoption.activeCompositionEpoch !== request.activeCompositionEpoch
			|| adoption.selectionEpoch !== request.selectionEpoch
			|| adoption.scrollEpoch !== request.scrollEpoch
			|| adoption.hostCapability !== request.hostCapability
			|| adoption.hostSaveEpoch !== request.hostSaveEpoch
			|| request.activeCompositionEpoch !== null
			|| this.getCmView(session.view) !== request.cm
			|| request.cm.state.doc !== request.startDocument
			|| (this.editorRevisionByCm.get(request.cm) ?? 0) !== request.editorRevision
			|| (this.samePathAdoptionTransactionSeqByCm.get(request.cm) ?? 0)
				!== request.editorTransactionSeq
			|| (this.bindingEpochByLeafId.get(request.leafId) ?? 0) !== request.bindingEpoch
			|| this.vaultSync.getTextForPath(request.path) !== request.ytext
			|| (
				request.ytext !== null
				&& (
					this.vaultSync.getFileIdForText(request.ytext)
					?? this.vaultSync.getFileId(request.path)
					?? null
				) !== request.fileId
			)
		) return false;
		const openViews = this.captureOpenViewsForAdmission(request.path);
		const ticketValidation = this.validateOpenEditorMutationTicket(
			request.openEditorTicket,
			openViews,
		);
		if (!ticketValidation.current) return false;
		const host = runtime.hostGuard?.snapshot() ?? null;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		if (
			host === null
			|| host.hostCapabilityState !== "ready"
			|| host.hostCapability !== request.hostCapability
			|| host.saveEpoch !== request.hostSaveEpoch
			|| host.mode.kind !== "pass-through"
			|| host.sourceUnload !== null
			|| !hasExactHostGuardWrappers(host)
			|| !hasNoPendingHostLoadOwner(host)
			|| guard === null
			|| guard.view !== request.cm
			|| guard.inert
			|| guard.gateClosed
			|| guard.pendingHostLoadCandidate !== null
			|| guard.inputEpoch !== request.inputEpoch
			|| guard.compositionEpoch !== request.compositionEpoch
			|| (guard.activeComposition?.compositionEpoch ?? null)
				!== request.activeCompositionEpoch
			|| guard.nativeHistoryEpoch !== request.nativeHistoryEpoch
			|| guard.selectionEpoch !== request.selectionEpoch
			|| guard.scrollEpoch !== request.scrollEpoch
		) return false;
		const authority = this.capturePathEditorAuthority(request.path);
		if (request.editorAuthority.kind === "proven-single") {
			return authority.kind === "proven-single"
				&& authority.content === request.editorAuthority.content
				&& authority.lease === request.editorAuthority.lease
				&& this.isPathEditorAuthorityLeaseCurrent(request.editorAuthority.lease);
		}
		return authority.kind === "blocked" && authority.reason === "multiple";
	}

	isSamePathAdoptionBindContextCurrent(
		context: SamePathAdoptionBindContext,
	): boolean {
		const { proposal, request, postMutation: post } = context;
		if (
			!this.asyncAuthorityOpen
			|| context.kind !== "bind"
			|| proposal.request !== request
			|| proposal.plan.kind === "preserve-conflict"
			|| proposal.plan.targetText !== post.targetText
			|| !this.samePathAdoptionPostMutationProofs.has(post)
			|| post.activeCompositionEpoch !== null
			|| post.cm !== request.cm
			|| post.editorDocument !== request.cm.state.doc
			|| post.editorDocument.toString() !== post.targetText
			|| post.ytextIdentity !== proposal.ytextIdentity
		) return false;
		const runtime = this.managedSessions.get(request.leafId);
		const session = runtime?.session;
		if (
			!runtime
			|| !session
			|| runtime.adoption.kind !== "planning"
			|| runtime.adoption.adoptionId !== request.adoptionId
			|| runtime.adoption.requestId !== request.requestId
			|| runtime.adoption.proposal !== proposal
			|| session.sessionId !== request.sessionId
			|| session.generation !== request.generation
			|| session.view !== runtime.adoption.view
			|| session.view.file !== request.file
			|| request.file.path !== request.path
			|| session.handoff !== null
			|| session.binding.kind !== "unbound"
			|| this.bindings.has(request.leafId)
			|| session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== request.file
			|| session.displayedLineage.path !== request.path
			|| session.displayedLineage.cm !== request.cm
			|| session.displayedLineage.document !== post.editorDocument
			|| this.getCmView(session.view) !== request.cm
			|| request.cm.state.doc !== post.editorDocument
			|| request.cm.state.doc.toString() !== post.targetText
			|| this.vaultSync.getTextForPath(request.path) !== proposal.ytext
			|| proposal.ytext.toJSON() !== post.targetText
			|| (
				this.vaultSync.getFileIdForText(proposal.ytext)
				?? this.vaultSync.getFileId(request.path)
				?? null
			) !== proposal.fileId
			|| (this.editorRevisionByCm.get(request.cm) ?? 0) !== post.editorRevision
			|| (this.samePathAdoptionTransactionSeqByCm.get(request.cm) ?? 0)
				!== post.editorTransactionSeq
			|| (this.bindingEpochByLeafId.get(request.leafId) ?? 0) !== post.bindingEpoch
		) return false;

		const host = runtime.hostGuard?.snapshot() ?? null;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		if (
			host === null
			|| host.hostCapabilityState !== "ready"
			|| host.hostCapability !== post.hostCapability
			|| host.saveEpoch !== post.hostSaveEpoch
			|| host.mode.kind !== "pass-through"
			|| host.sourceUnload !== null
			|| !hasExactHostGuardWrappers(host)
			|| !hasNoPendingHostLoadOwner(host)
			|| guard === null
			|| guard.view !== request.cm
			|| guard.inert
			|| guard.gateClosed
			|| guard.pendingHostLoadCandidate !== null
			|| guard.nativeHistoryEpoch !== post.nativeHistoryEpoch
			|| guard.inputEpoch !== post.inputEpoch
			|| guard.compositionEpoch !== post.compositionEpoch
			|| (guard.activeComposition?.compositionEpoch ?? null)
				!== post.activeCompositionEpoch
			|| guard.selectionEpoch !== post.selectionEpoch
			|| guard.scrollEpoch !== post.scrollEpoch
		) return false;
		let editorContent: string;
		let hostContent: string;
		try {
			editorContent = session.view.editor.getValue();
			hostContent = (session.view as unknown as TextFileView).getViewData();
		} catch {
			return false;
		}
		if (editorContent !== post.targetText || hostContent !== post.targetText) return false;
		const openViews = this.captureOpenViewsForAdmission(request.path);
		const ticketValidation = this.validateOpenEditorMutationTicket(
			post.openEditorTicket,
			openViews,
		);
		if (
			!ticketValidation.current
			|| openViews.length !== post.openEditorTicket.views.length
		) return false;
		for (const ticket of post.openEditorTicket.views) {
			const candidateRuntime = this.managedSessions.get(ticket.leafId);
			const candidateSession = candidateRuntime?.session;
			const candidateHost = candidateRuntime?.hostGuard?.snapshot() ?? null;
			const candidateGuard = candidateRuntime?.cmGuard?.snapshot() ?? null;
			const exactBoundPeer = this.isExactAlreadySettledBoundPeer(
				ticket,
				proposal,
				post.targetText,
			);
			if (
				ticket.cm === null
				|| !candidateRuntime
				|| !candidateSession
				|| candidateSession.view !== ticket.view
				|| candidateSession.view.file !== request.file
				|| candidateSession.handoff !== null
				|| (
					!exactBoundPeer
					&& (
						candidateSession.binding.kind !== "unbound"
						|| this.bindings.has(ticket.leafId)
					)
				)
				|| candidateSession.displayedLineage.kind !== "known"
				|| candidateSession.displayedLineage.file !== request.file
				|| candidateSession.displayedLineage.path !== request.path
				|| candidateSession.displayedLineage.cm !== ticket.cm
				|| candidateSession.displayedLineage.document !== ticket.editorDocument
				|| ticket.cm.state.doc.toString() !== post.targetText
				|| ticket.editorContent !== post.targetText
				|| candidateHost === null
				|| candidateHost.hostCapabilityState !== "ready"
				|| candidateHost.mode.kind !== "pass-through"
				|| candidateHost.sourceUnload !== null
				|| !hasExactHostGuardWrappers(candidateHost)
				|| !hasNoPendingHostLoadOwner(candidateHost)
				|| candidateGuard === null
				|| candidateGuard.view !== ticket.cm
				|| candidateGuard.inert
				|| candidateGuard.gateClosed
				|| candidateGuard.pendingHostLoadCandidate !== null
				|| candidateGuard.activeComposition !== null
			) return false;
			try {
				if (
					candidateSession.view.editor.getValue() !== post.targetText
					|| (candidateSession.view as unknown as TextFileView).getViewData()
						!== post.targetText
				) return false;
			} catch {
				return false;
			}
		}
		const authority = this.capturePathEditorAuthority(request.path);
		return post.editorAuthority.kind === "proven-single"
			&& authority.kind === "proven-single"
			&& authority.content === post.targetText
			&& authority.lease === post.editorAuthority.lease
			&& this.isPathEditorAuthorityLeaseCurrent(post.editorAuthority.lease);
	}

	isSamePathAdoptionProjectionHeld(path: string): boolean {
		for (const requiredPath of this.samePathAdoptionRequiredPathByLeafId.values()) {
			if (requiredPath === path) return true;
		}
		for (const runtime of this.managedSessions.values()) {
			if (
				runtime.adoption.kind !== "none"
				&& runtime.adoption.path === path
			) return true;
		}
		return false;
	}

	captureSamePathExternalCandidateProjectionProof(
		input: SamePathExternalCandidateProjectionProofInput,
	): SamePathExternalCandidateProjectionProof | null {
		if (this.activeSamePathExternalCandidateProjectionProofByPath.has(input.path)) {
			return null;
		}
		const owners = new Map<string, ManagedLeafRuntime>();
		for (const [leafId, requiredPath] of this.samePathAdoptionRequiredPathByLeafId) {
			if (requiredPath !== input.path) continue;
			const runtime = this.managedSessions.get(leafId);
			if (!runtime) return null;
			owners.set(leafId, runtime);
		}
		if (owners.size === 0) return null;
		const proof = Object.freeze({ ...input }) as SamePathExternalCandidateProjectionProof;
		this.samePathExternalCandidateProjectionProofOwners.set(proof, owners);
		this.activeSamePathExternalCandidateProjectionProofByPath.set(input.path, proof);
		let current = false;
		try {
			current = this.isSamePathExternalCandidateProjectionProofCurrent(proof);
		} catch {
			// A host/workspace callback may throw while the proof is validated.
			// Roll back both registries before failing closed so an exception can
			// never leave adoption permanently blocked by an orphaned proof.
		}
		if (!current) {
			this.releaseSamePathExternalCandidateProjectionProof(proof);
			return null;
		}
		return proof;
	}

	isSamePathExternalCandidateProjectionProofCurrent(
		proof: SamePathExternalCandidateProjectionProof,
	): boolean {
		const capturedOwners =
			this.samePathExternalCandidateProjectionProofOwners.get(proof) ?? null;
		if (
			!this.asyncAuthorityOpen
			|| capturedOwners === null
			|| this.activeSamePathExternalCandidateProjectionProofByPath.get(proof.path)
				!== proof
			|| proof.path.length === 0
			|| proof.file.path !== proof.path
			|| proof.openEditorTicket.path !== proof.path
			|| proof.openEditorTicket.views.length === 0
		) return false;

		const requiredLeafIds: string[] = [];
		for (const [leafId, requiredPath] of this.samePathAdoptionRequiredPathByLeafId) {
			if (requiredPath === proof.path) requiredLeafIds.push(leafId);
		}
		if (
			requiredLeafIds.length === 0
			|| requiredLeafIds.length !== capturedOwners.size
			|| requiredLeafIds.some((leafId) =>
				this.managedSessions.get(leafId) !== capturedOwners.get(leafId)
			)
		) return false;

		// A required retry marker is the only hold subtype this proof may cross.
		// Conflict, awaiting-disk, capturing, and planning identities remain held.
		for (const runtime of this.managedSessions.values()) {
			if (
				runtime.adoption.kind !== "none"
				&& runtime.adoption.path === proof.path
			) return false;
		}

		const openViews = this.captureOpenViewsForAdmission(proof.path);
		if (
			openViews.length !== proof.openEditorTicket.views.length
			|| !this.validateOpenEditorMutationTicket(
				proof.openEditorTicket,
				openViews,
				{ ignoreSelectionAndScroll: true },
			).current
		) return false;

		const ticketByLeafId = new Map(
			proof.openEditorTicket.views.map((ticket) => [ticket.leafId, ticket] as const),
		);
		if (requiredLeafIds.some((leafId) => !ticketByLeafId.has(leafId))) return false;

		for (const ticket of proof.openEditorTicket.views) {
			const runtime = this.managedSessions.get(ticket.leafId);
			const session = runtime?.session;
			const cm = ticket.cm;
			const host = runtime?.hostGuard?.snapshot() ?? null;
			const guard = runtime?.cmGuard?.snapshot() ?? null;
			const requiredOwner = capturedOwners.get(ticket.leafId) === runtime;
			const exactBoundPeer = !requiredOwner
				&& this.isExactBoundPeerForSamePathExternalCandidateProjection(
					ticket,
					proof,
				);
			if (
				!runtime
				|| !session
				|| cm === null
				|| ticket.targetFile !== proof.file
				|| !ticket.stableTargetIdentityProven
				|| ticket.editorDocument !== cm.state.doc
				|| cm.state.doc.toString() !== proof.content
				|| ticket.editorContent !== proof.content
				|| session.view !== ticket.view
				|| session.view.file !== proof.file
				|| session.handoff !== null
				|| (
					!exactBoundPeer
					&& (
						session.binding.kind !== "unbound"
						|| this.bindings.has(ticket.leafId)
					)
				)
				|| session.displayedLineage.kind !== "known"
				|| session.displayedLineage.file !== proof.file
				|| session.displayedLineage.path !== proof.path
				|| session.displayedLineage.cm !== cm
				|| session.displayedLineage.document !== ticket.editorDocument
				|| runtime.adoption.kind !== "none"
				|| runtime.sourceUnloadDrain !== null
				|| host === null
				|| host.view !== (session.view as unknown as TextFileView)
				|| host.clearLoadCapability !== "observable"
				|| host.hostCapabilityState !== "ready"
				|| host.mode.kind !== "pass-through"
				|| host.sourceUnload !== null
				|| (host.pendingSourceUnloadDrain ?? null) !== null
				|| !hasExactHostGuardWrappers(host)
				|| !hasNoPendingHostLoadOwner(host)
				|| guard === null
				|| guard.view !== cm
				|| guard.inert
				|| guard.gateClosed
				|| guard.pendingHostLoadCandidate !== null
				|| guard.activeComposition !== null
			) return false;
			try {
				if (
					session.view.editor.getValue() !== proof.content
					|| (session.view as unknown as TextFileView).getViewData()
						!== proof.content
				) return false;
			} catch {
				return false;
			}
		}

		const authority = this.capturePathEditorAuthority(proof.path);
		return authority.kind === "proven-single"
			&& authority.content === proof.content
			&& authority.lease === proof.editorAuthorityLease
			&& this.isPathEditorAuthorityLeaseCurrent(proof.editorAuthorityLease)
			&& requiredLeafIds.every((leafId) =>
				this.samePathAdoptionRequiredPathByLeafId.get(leafId) === proof.path
			);
	}

	private isExactBoundPeerForSamePathExternalCandidateProjection(
		ticket: OpenEditorMutationTicket["views"][number],
		proof: SamePathExternalCandidateProjectionProof,
	): boolean {
		if (ticket.cm === null) return false;
		const runtime = this.managedSessions.get(ticket.leafId);
		const session = runtime?.session;
		const binding = this.bindings.get(ticket.leafId);
		const displayed = session?.displayedLineage;
		const expectedYText = this.vaultSync.getTextForPath(proof.path);
		const expectedFileId = expectedYText
			? (
				this.vaultSync.getFileIdForText(expectedYText)
				?? this.vaultSync.getFileId(proof.path)
				?? null
			)
			: null;
		return !!runtime
			&& !!session
			&& !!binding
			&& expectedYText !== null
			&& expectedFileId !== null
			&& expectedYText.toJSON() === proof.content
			&& runtime.adoption.kind === "none"
			&& session.view === ticket.view
			&& session.view.file === proof.file
			&& session.handoff === null
			&& session.binding.kind === "bound"
			&& session.binding.path === proof.path
			&& session.binding.fileId === expectedFileId
			&& session.binding.ytext === expectedYText
			&& displayed?.kind === "known"
			&& displayed.file === proof.file
			&& displayed.path === proof.path
			&& displayed.cm === ticket.cm
			&& displayed.document === ticket.editorDocument
			&& binding.view === ticket.view
			&& binding.file === proof.file
			&& binding.path === proof.path
			&& binding.fileId === expectedFileId
			&& binding.ytext === expectedYText
			&& binding.cm === ticket.cm
			&& this.getCmView(ticket.view) === ticket.cm
			&& ticket.cm.state.doc === ticket.editorDocument
			&& ticket.cm.state.doc.toString() === proof.content
			&& ticket.editorContent === proof.content;
	}

	releaseSamePathExternalCandidateProjectionProof(
		proof: SamePathExternalCandidateProjectionProof,
	): void {
		if (
			this.activeSamePathExternalCandidateProjectionProofByPath.get(proof.path)
			=== proof
		) {
			this.activeSamePathExternalCandidateProjectionProofByPath.delete(proof.path);
		}
		this.samePathExternalCandidateProjectionProofOwners.delete(proof);
	}

	private isSamePathAdoptionReplanHeld(path: string): boolean {
		for (const requiredPath of this.samePathAdoptionRequiredPathByLeafId.values()) {
			if (requiredPath === path) return true;
		}
		for (const runtime of this.managedSessions.values()) {
			if (
				runtime.adoption.kind !== "none"
				&& runtime.adoption.kind !== "awaiting-disk"
				&& runtime.adoption.path === path
			) return true;
		}
		return false;
	}

	isSamePathAdoptionDiskSettlementCurrent(
		receipt: SamePathAdoptionBindReceipt,
	): boolean {
		if (!this.asyncAuthorityOpen) return false;
		for (const [leafId, runtime] of this.managedSessions) {
			const adoption = runtime.adoption;
			if (
				adoption.kind !== "awaiting-disk"
				|| adoption.bindReceipt !== receipt
				|| adoption.adoptionId !== receipt.adoptionId
				|| adoption.proposalId !== receipt.proposalId
				|| adoption.path !== receipt.path
				|| adoption.file !== receipt.file
				|| adoption.fileId !== receipt.fileId
				|| adoption.ytext !== receipt.ytext
				|| adoption.targetText !== receipt.targetText
			) continue;
			const session = runtime.session;
			const binding = this.bindings.get(leafId);
			const displayed = session.displayedLineage;
			const liveCm = this.getCmView(session.view);
			const authorityAtBind = binding?.authorityYtextMutationEpochAtBind;
			const localAtBind = binding?.localYtextMutationRevisionAtBind;
			const localRevision = binding
				? (this.yTextMutationRevisionByText.get(binding.ytext) ?? 0)
				: -1;
			const currentMutationEpoch = authorityAtBind !== undefined
				&& localAtBind !== undefined
				&& localRevision >= localAtBind
				? authorityAtBind + (localRevision - localAtBind)
				: -1;
			if (
				session.view.file !== receipt.file
				|| receipt.file.path !== receipt.path
				|| session.handoff !== null
				|| session.binding.kind !== "bound"
				|| session.binding.path !== receipt.path
				|| session.binding.fileId !== receipt.fileId
				|| session.binding.ytext !== receipt.ytext
				|| !binding
				|| displayed.kind !== "known"
				|| displayed.file !== receipt.file
				|| displayed.path !== receipt.path
				|| displayed.fileId !== receipt.fileId
				|| binding.view !== session.view
				|| binding.file !== receipt.file
				|| binding.path !== receipt.path
				|| binding.fileId !== receipt.fileId
				|| binding.ytext !== receipt.ytext
				|| liveCm !== binding.cm
				|| displayed.cm !== binding.cm
				|| displayed.document !== binding.cm.state.doc
				|| displayed.editorRevision
					!== (this.editorRevisionByCm.get(binding.cm) ?? 0)
				|| !this.isManagedBoundaryLive(runtime, binding.cm)
				|| currentMutationEpoch !== receipt.ytextMutationEpoch
				|| binding.cm.state.doc.toString() !== receipt.targetText
				|| receipt.ytext.toJSON() !== receipt.targetText
				|| this.vaultSync.getTextForPath(receipt.path) !== receipt.ytext
			) return false;
			return true;
		}
		return false;
	}

	completeSamePathAdoptionDiskSettlement(
		receipt: SamePathAdoptionBindReceipt,
		settledContent: string,
	): boolean {
		if (
			settledContent !== receipt.targetText
			|| !this.isSamePathAdoptionDiskSettlementCurrent(receipt)
		) return false;
		for (const runtime of this.managedSessions.values()) {
			if (
				runtime.adoption.kind === "awaiting-disk"
				&& runtime.adoption.bindReceipt === receipt
			) {
				this.advanceAuthorityEpoch();
				runtime.adoption = NO_SAME_PATH_ADOPTION;
				this.trace?.("editor", "same-path-adoption-disk-settled", {
					path: receipt.path,
					adoptionId: receipt.adoptionId,
					proposalId: receipt.proposalId,
				});
				return true;
			}
		}
		return false;
	}

	invalidateSamePathAdoptionDiskSettlement(
		receipt: SamePathAdoptionBindReceipt,
		reason: string,
	): boolean {
		for (const [leafId, runtime] of this.managedSessions) {
			if (
				runtime.adoption.kind !== "awaiting-disk"
				|| runtime.adoption.bindReceipt !== receipt
			) continue;
			const binding = this.bindings.get(leafId);
			if (
				binding
				&& binding.view === runtime.session.view
				&& binding.file === receipt.file
				&& binding.path === receipt.path
				&& binding.ytext === receipt.ytext
			) {
				this.detachBinding(
					binding.view,
					`same-path-adoption-disk-invalidated:${reason}`,
					false,
				);
			} else {
				this.advanceAuthorityEpoch();
				runtime.adoption = NO_SAME_PATH_ADOPTION;
			}
			this.samePathAdoptionRequiredPathByLeafId.set(leafId, receipt.path);
			const current = this.managedSessions.get(leafId);
			if (current) {
				this.scheduleSamePathAdoptionRefresh(
					current,
					`disk-settlement-invalidated:${reason}`,
				);
			}
			this.trace?.("editor", "same-path-adoption-disk-invalidated", {
				path: receipt.path,
				adoptionId: receipt.adoptionId,
				proposalId: receipt.proposalId,
				reason,
			});
			return true;
		}
		return false;
	}

	getManagedSession(view: MarkdownView): ManagedLeafSession | null {
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		return runtime?.session.view === view ? runtime.session : null;
	}

	getPendingHostLoadCandidate(view: MarkdownView): PendingHostLoadCandidate | null {
		return this.getManagedSession(view)?.handoff?.pendingHostLoadCandidate ?? null;
	}

	getBinding(view: MarkdownView): EditorBinding | null {
		return this.bindings.get(this.getLeafId(view)) ?? null;
	}

	private getLeafId(view: MarkdownView): string {
		return (view.leaf as unknown as { id?: string }).id ?? view.file?.path ?? "unknown";
	}

	private isManagedBoundaryLive(
		runtime: ManagedLeafRuntime,
		expectedCm: EditorView,
	): boolean {
		try {
			const host = runtime.hostGuard?.snapshot();
			const cm = runtime.cmGuard?.snapshot();
			return host?.view === (runtime.session.view as unknown as TextFileView)
				&& host.clearLoadCapability === "observable"
				&& host.hostCapabilityState === "ready"
				&& hasExactHostGuardWrappers(host)
				&& host.mode.kind !== "inert-pass-through"
				&& cm?.view === expectedCm
				&& cm.inert === false;
		} catch {
			return false;
		}
	}

	private isManagedTransitionBoundaryLive(runtime: ManagedLeafRuntime): boolean {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		const targetFile = session.view.file;
		if (
			targetFile === null
			|| displayed.kind !== "known"
			|| (
				targetFile === displayed.file
				&& targetFile.path === displayed.path
			)
		) return false;
		try {
			const host = runtime.hostGuard?.snapshot() ?? null;
			const cm = runtime.cmGuard?.snapshot() ?? null;
			if (
					host?.view !== (session.view as unknown as TextFileView)
					|| host.clearLoadCapability !== "observable"
					|| host.hostCapabilityState !== "ready"
					|| !hasExactHostGuardWrappers(host)
					|| host.mode.kind === "inert-pass-through"
				|| cm?.view !== displayed.cm
				|| cm.inert
			) return false;
			const binding = this.bindings.get(session.leafId);
			const exactSourceBinding = binding !== undefined
				&& binding.view === session.view
				&& binding.file === displayed.file
				&& binding.path === displayed.path
				&& binding.cm === displayed.cm
				&& session.binding.kind === "bound"
				&& session.binding.path === displayed.path
				&& session.binding.ytext === binding.ytext;
			const exactDetachedHandoff = binding === undefined
				&& session.binding.kind === "unbound"
				&& session.handoff?.targetFile === targetFile
				&& session.handoff.targetPath === targetFile.path;
			return exactSourceBinding || exactDetachedHandoff;
		} catch {
			return false;
		}
	}

	private requireManagedBoundary(view: MarkdownView, reason: string): boolean {
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		const cm = this.getCmView(view);
		if (
			runtime?.session.view === view
			&& cm !== null
			&& this.isManagedBoundaryLive(runtime, cm)
		) return true;
		if (
			runtime?.session.view === view
			&& cm === null
			&& this.isManagedTransitionBoundaryLive(runtime)
		) {
			this.trace?.("editor", "managed-transition-boundary-retained", {
				leafId,
				reason,
				displayedPath: runtime.session.displayedLineage.kind === "known"
					? runtime.session.displayedLineage.path
					: null,
				targetPath: view.file?.path ?? null,
				handoffPath: runtime.session.handoff?.targetPath ?? null,
			});
			return true;
		}
		this.trace?.("editor", "managed-boundary-unsupported", {
			leafId,
			reason,
			hostGuardInstalled: runtime?.hostGuard != null,
			cmGuardInstalled: runtime?.cmGuard != null,
			cmResolved: cm !== null,
		});
		this.cancelManagedHandoffAndUnmanage(
			view,
			`unsupported-boundary:${reason}`,
			"unsupported-host",
		);
		return false;
	}

	manageView(view: MarkdownView): ManagedLeafSession {
		const leafId = this.getLeafId(view);
		let runtime = this.managedSessions.get(leafId);
		if (runtime && runtime.session.view !== view) {
			if (!this.unmanageView(runtime.session.view, "replaced")) {
				return runtime.session;
			}
			runtime = undefined;
		}
		if (!runtime) {
			const binding = this.bindings.get(leafId);
			const resolvedCm = this.getCmView(view);
			const currentCm = binding && binding.path !== view.file?.path
				? binding.cm
				: resolvedCm ?? binding?.cm ?? null;
			const displayedFile = binding?.file
				?? (binding?.path === view.file?.path ? view.file : null);
			const displayedPath = binding?.path ?? displayedFile?.path ?? null;
			const displayedFileId = binding?.fileId
				?? (displayedPath ? this.vaultSync.getFileId(displayedPath) : undefined)
				?? null;
			const displayedLineage = displayedFile && displayedPath && currentCm
				? {
					kind: "known" as const,
					file: displayedFile,
					path: displayedPath,
					fileId: displayedFileId,
					cm: currentCm,
					document: currentCm.state.doc,
					editorRevision: this.editorRevisionByCm.get(currentCm) ?? 0,
				}
				: { kind: "unknown" as const };
			const session = createManagedLeafSession({
				sessionId: `${this.bootSessionId}:${leafId}:${++this.managedSessionCounter}`,
				leafId,
				view,
				displayedLineage,
				binding: binding && binding.fileId
					? { kind: "bound", path: binding.path, fileId: binding.fileId, ytext: binding.ytext }
					: { kind: "unbound" },
			});
				runtime = {
				session,
				hostGuard: null,
				emergencySaveFence: null,
				cmGuard: null,
				capturedSourceAuthority: null,
					transitionInputFence: null,
					sourceUnloadDrain: null,
					adoption: NO_SAME_PATH_ADOPTION,
			};
			this.advanceAuthorityEpoch();
			this.managedSessions.set(leafId, runtime);
		}
		this.installManagedHostGuard(runtime);
		const currentCm = this.getCmView(view);
		if (currentCm) {
			this.cmToLeafId.set(currentCm, leafId);
			this.installManagedCmGuard(runtime, currentCm);
			this.admitStableInitialSamePathPresentation(runtime, currentCm);
			if (this.managedSessions.get(leafId) === runtime) {
				this.admitStableSamePathCmReplacement(runtime, currentCm);
			}
		}
		return runtime.session;
	}

	private admitStableInitialSamePathPresentation(
		runtime: ManagedLeafRuntime,
		cm: EditorView,
	): void {
		const session = runtime.session;
		const file = session.view.file;
		if (
			file === null
			|| session.displayedLineage.kind !== "unknown"
			|| session.handoff !== null
			|| session.binding.kind !== "unbound"
			|| this.bindings.has(session.leafId)
			|| !this.isManagedBoundaryLive(runtime, cm)
		) return;
		const hostBefore = runtime.hostGuard?.snapshot() ?? null;
		const guardBefore = runtime.cmGuard?.snapshot() ?? null;
		if (
			hostBefore === null
			|| guardBefore === null
			|| hostBefore.view !== (session.view as unknown as TextFileView)
			|| hostBefore.hostCapabilityState !== "ready"
			|| hostBefore.mode.kind === "blocking-handoff"
			|| hostBefore.mode.kind === "inert-pass-through"
				|| hostBefore.pendingTargetSave
				|| hostBefore.sourceUnload !== null
				|| !hasExactHostGuardWrappers(hostBefore)
				|| !hasNoPendingHostLoadOwner(hostBefore)
				|| guardBefore.view !== cm
			|| guardBefore.inert
			|| guardBefore.pendingHostLoadCandidate !== null
		) return;
		const document = cm.state.doc;
		let editorContent: string;
		let hostContent: string;
		try {
			editorContent = session.view.editor.getValue();
			hostContent = (session.view as unknown as TextFileView).getViewData();
		} catch {
			return;
		}
		const hostAfter = runtime.hostGuard?.snapshot() ?? null;
		const guardAfter = runtime.cmGuard?.snapshot() ?? null;
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| session.view.file !== file
			|| file.path.length === 0
			|| this.getCmView(session.view) !== cm
			|| cm.state.doc !== document
			|| editorContent !== document.toString()
			|| hostContent !== editorContent
			|| !sameHostGuardSnapshot(hostBefore, hostAfter)
			|| !sameCodeMirrorGuardSnapshot(guardBefore, guardAfter)
			|| this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
		) return;
		const editorRevision = this.editorRevisionByCm.get(cm) ?? 0;
		this.editorAuthorityRevisionByCm.set(cm, editorRevision);
		this.editorAuthorityContentByCm.set(cm, editorContent);
		this.advanceAuthorityEpoch();
		const admittedSession: ManagedLeafSession = {
			...session,
			displayedLineage: {
				kind: "known",
				file,
				path: file.path,
				fileId: this.vaultSync.getFileId(file.path) ?? null,
				cm,
				document,
				editorRevision,
			},
		};
		runtime.session = admittedSession;
		if (runtime.cmGuard?.refreshGate() !== true) {
			this.trace?.("editor", "initial-same-path-gate-release-failed", {
				leafId: session.leafId,
				path: file.path,
			});
			this.cancelManagedHandoffAndUnmanage(
				session.view,
				"initial-same-path-gate-release-failed",
				"unsupported-host",
			);
			return;
		}
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== admittedSession
		) return;
		this.trace?.("editor", "initial-same-path-presentation-admitted", {
			leafId: session.leafId,
			path: file.path,
		});
	}

	private admitStableSamePathCmReplacement(
		runtime: ManagedLeafRuntime,
		cm: EditorView,
	): void {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		const binding = this.bindings.get(session.leafId);
		if (
			session.handoff !== null
			|| displayed.kind !== "known"
			|| displayed.cm === cm
			|| session.view.file !== displayed.file
			|| displayed.file.path !== displayed.path
			|| session.binding.kind !== "bound"
			|| !binding
			|| binding.view !== session.view
			|| binding.file !== displayed.file
			|| binding.path !== displayed.path
			|| binding.ytext !== session.binding.ytext
			|| !this.isManagedBoundaryLive(runtime, cm)
		) return;
		let editorContent: string;
		try {
			editorContent = session.view.editor.getValue();
		} catch {
			return;
		}
		if (
			cm.state.doc.toString() !== editorContent
			|| binding.ytext.toJSON() !== editorContent
		) return;
		this.advanceAuthorityEpoch();
		runtime.session = {
			...session,
			displayedLineage: {
				...displayed,
				cm,
				document: cm.state.doc,
				editorRevision: this.editorRevisionByCm.get(cm) ?? 0,
			},
		};
	}

	unmanageView(view: MarkdownView, reason: string, scheduleRetry = true): boolean {
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		if (!runtime || runtime.session.view !== view) return true;
		if (runtime.emergencySaveFence !== null) {
			const protectedNow = this.ensureEmergencyHostSaveFence(
				runtime,
				`unmanage-blocked:${reason}`,
			);
			this.trace?.("editor", "managed-view-emergency-save-fence-retained", {
				leafId,
				reason,
				protected: protectedNow,
			});
			try {
				new Notice(
					protectedNow
						? "This pane still contains an unresolved note switch. Native saving remains blocked; complete the recovery export action before reopening it."
						: "This pane has an unresolved note switch and its native save wrappers drifted. Do not continue editing; restore the recovery controls, export the blocked text, then reopen the pane.",
					10_000,
				);
			} catch {
				// Runtime ownership remains retained even if the warning surface fails.
			}
			return false;
		}
		if (runtime.transitionInputFence !== null) {
			runtime.transitionInputFence.state = "reopen-required";
			try {
				new Notice(
					"This pane still owns an unresolved note transition. Close and reopen the pane before continuing.",
					10_000,
				);
			} catch {
				// The exact container and CM owners remain fail-closed.
			}
			return false;
		}
		if (runtime.cmGuard && !runtime.cmGuard.markInert()) {
			const snapshot = runtime.cmGuard.snapshot();
			this.trace?.("editor", "managed-view-invalidation-deferred", {
				leafId,
				reason,
				gateClosed: snapshot.gateClosed,
				gateFailureReason: snapshot.gateFailureReason,
				commitState: snapshot.commitState,
			});
			if (scheduleRetry && !this.pendingUnmanageRetries.has(leafId)) {
				const attempt = (this.unmanageRetryAttempts.get(leafId) ?? 0) + 1;
				this.unmanageRetryAttempts.set(leafId, attempt);
				if (attempt > UNMANAGE_RETRY_DELAYS_MS.length) {
					this.trace?.("editor", "managed-view-invalidation-exhausted", {
						leafId,
						reason,
						gateFailureReason: snapshot.gateFailureReason,
						commitState: snapshot.commitState,
					});
					try {
						new Notice(
							"The editor input boundary could not be released safely. Keep the pane open, complete the recovery export action, then reopen it.",
							10_000,
						);
					} catch {
						// The still-live managed guard remains the authoritative safety boundary.
					}
					return false;
				}
				const delayMs = UNMANAGE_RETRY_DELAYS_MS[
					Math.min(attempt - 1, UNMANAGE_RETRY_DELAYS_MS.length - 1)
				]!;
				const timer = setTimeout(() => {
					if (this.pendingUnmanageRetries.get(leafId) !== timer) return;
					this.pendingUnmanageRetries.delete(leafId);
					const current = this.managedSessions.get(leafId);
					if (current !== runtime || current.session.view !== view) return;
					this.unmanageView(view, `${reason}:retry`, true);
				}, delayMs);
				this.pendingUnmanageRetries.set(leafId, timer);
			}
			return false;
		}
		const retry = this.pendingUnmanageRetries.get(leafId);
		if (retry) clearTimeout(retry);
		this.pendingUnmanageRetries.delete(leafId);
		this.unmanageRetryAttempts.delete(leafId);
		const adoptionRetry = this.pendingSamePathAdoptionRetries.get(leafId);
		if (adoptionRetry) clearTimeout(adoptionRetry);
		this.pendingSamePathAdoptionRetries.delete(leafId);
		this.samePathAdoptionRetryAttempts.delete(leafId);
		this.samePathAdoptionRefreshScheduled.delete(leafId);
		this.samePathAdoptionRequiredPathByLeafId.delete(leafId);
		this.advanceAuthorityEpoch();
		runtime.cmGuard?.restoreIfCurrent();
		runtime.hostGuard?.restoreIfCurrent();
		runtime.cmGuard = null;
		runtime.hostGuard = null;
		runtime.adoption = NO_SAME_PATH_ADOPTION;
		const currentCm = this.getCmView(view);
		if (currentCm && this.cmToLeafId.get(currentCm) === leafId) {
			this.cmToLeafId.delete(currentCm);
		}
		this.managedSessions.delete(leafId);
		this.pendingAdmissionByLeafId.delete(leafId);
		this.trace?.("editor", "managed-view-invalidated", { leafId, reason });
		return true;
	}

	reconcileManagedWorkspaceViews(
		workspaceViews: readonly MarkdownView[],
		reason: string,
	): number {
		const exactWorkspaceViews = new Set<MarkdownView>(workspaceViews);
		let revoked = 0;
		for (const runtime of Array.from(this.managedSessions.values())) {
			const view = runtime.session.view;
			if (exactWorkspaceViews.has(view)) {
				this.cancelPendingStructuralSourceCloseSettlement(
					runtime.session.leafId,
					runtime,
				);
				continue;
			}
			const leafId = runtime.session.leafId;
			if (this.managedSessions.get(leafId) !== runtime) continue;
			const sourceOwner = runtime.sourceUnloadDrain;
			if (
				sourceOwner !== null
				&& this.scheduleStructuralSourceCloseSettlement(
					runtime,
					sourceOwner,
					`workspace-view-removed:${reason}`,
				)
			) continue;
			this.teardownSourceUnloadDrain(
				runtime,
				`workspace-view-removed:${reason}`,
			);
			// Workspace absence is the explicit safe teardown boundary: the host can
			// no longer autosave this detached view after its emergency owner releases.
			const emergencyReleased = this.releaseEmergencyHostSaveFence(
				runtime,
				`workspace-view-removed:${reason}`,
				true,
			);
			if (emergencyReleased) {
				runtime.hostGuard?.cancelTerminalHostLifecycle?.(
					`workspace-view-removed:${reason}`,
				);
			}
			if (emergencyReleased) {
				this.tombstoneDetachedTransitionBoundary(
					runtime,
					`workspace-view-removed:${reason}`,
				);
			}
			this.cancelManagedHandoffAndUnmanage(
				view,
				`workspace-view-removed:${reason}`,
				"closed",
			);
			if (this.managedSessions.get(leafId) !== runtime) revoked += 1;
		}
		if (revoked > 0) {
			this.trace?.("editor", "managed-workspace-views-revoked", {
				reason,
				count: revoked,
			});
		}
		return revoked;
	}

	private exactPendingHostLoadAdmission(
		runtime: ManagedLeafRuntime,
		targetFile: TFile,
		targetPath: string,
		sourceUnloadReceiptId: string,
	): ManagedDeferredLoadAdmissionSnapshot | null {
		const guard = runtime.hostGuard;
		if (guard === null) return null;
		let first: ManagedViewSaveGuard;
		let second: ManagedViewSaveGuard;
		try {
			first = guard.snapshot();
			second = guard.snapshot();
		} catch {
			return null;
		}
		const owner = second.pendingDeferredLoadAdmission ?? null;
		if (
			this.managedSessions.get(runtime.session.leafId) !== runtime
			|| runtime.hostGuard !== guard
			|| !sameHostGuardSnapshot(first, second)
			|| !hasExactHostGuardWrappers(second)
			|| owner === null
			|| owner.targetFile !== targetFile
			|| owner.targetPath !== targetPath
			|| owner.sourceUnloadReceiptId !== sourceUnloadReceiptId
			|| owner.viewFileAtEntry !== runtime.session.view.file
			|| owner.viewPathAtEntry !== runtime.session.view.file?.path
			|| owner.pendingLoadEpoch !== (second.pendingLoadEpoch ?? 0)
		) return null;
		return owner;
	}

	private tryAdmitPendingHostLoad(
		request: ManagedHostLoadAdmissionAttempt,
	): ManagedHostSwitchTicket | null {
		const runtime = request.runtime;
		if (
			this.managedSessions.get(runtime.session.leafId) !== runtime
			|| runtime.session !== request.sourceSession
			|| this.bindings.get(runtime.session.leafId) !== request.sourceBinding
			|| (this.bindingEpochByLeafId.get(runtime.session.leafId) ?? 0)
				!== request.sourceBindingEpoch
			|| this.readAuthorityEpoch() !== request.authorityEpoch
		) return null;
		const owner = this.exactPendingHostLoadAdmission(
			runtime,
			request.targetFile,
			request.targetPath,
			request.sourceUnloadReceiptId,
		);
		if (
			owner === null
			|| !sameDeferredLoadAdmissionSnapshot(owner, request.admission)
			|| this.managedSessions.get(runtime.session.leafId) !== runtime
			|| runtime.session !== request.sourceSession
			|| this.bindings.get(runtime.session.leafId) !== request.sourceBinding
			|| (this.bindingEpochByLeafId.get(runtime.session.leafId) ?? 0)
				!== request.sourceBindingEpoch
			|| this.readAuthorityEpoch() !== request.authorityEpoch
			|| runtime.session.view.file !== request.admission.viewFileAtEntry
			|| runtime.session.view.file?.path !== request.admission.viewPathAtEntry
		) return null;
		if (!this.beginPathHandoff(
			runtime.session.view,
			request.targetFile,
			"host-load-entry",
			"selected",
			request.sourceUnloadReceiptId,
			owner,
		)) return null;
		const currentRuntime = this.managedSessions.get(runtime.session.leafId);
		const current = currentRuntime?.session;
		const finalOwner = currentRuntime === runtime
			? this.exactPendingHostLoadAdmission(
				runtime,
				request.targetFile,
				request.targetPath,
				request.sourceUnloadReceiptId,
			)
			: null;
		if (
			currentRuntime !== runtime
			|| finalOwner === null
			|| !sameDeferredLoadAdmissionSnapshot(finalOwner, request.admission)
			|| !current?.handoff
			|| current.handoff.targetFile !== request.targetFile
			|| current.handoff.targetPath !== request.targetPath
			|| current.handoff.sourceUnloadReceiptId !== request.sourceUnloadReceiptId
			|| current.currentSwitchIntentSeq === null
			|| runtime.transitionInputFence?.targetFile !== request.targetFile
			|| runtime.transitionInputFence.targetPath !== request.targetPath
			|| runtime.transitionInputFence.state !== "handoff"
		) {
			return null;
		}
		let finalHost: ManagedViewSaveGuard | null = null;
		try {
			finalHost = runtime.hostGuard?.snapshot() ?? null;
		} catch {
			finalHost = null;
		}
		if (
			finalHost === null
			|| !hasExactHostGuardWrappers(finalHost)
			|| !sameDeferredLoadAdmissionSnapshot(
				finalHost.pendingDeferredLoadAdmission,
				request.admission,
			)
			|| (finalHost.pendingLoadEpoch ?? 0) !== request.admission.pendingLoadEpoch
		) {
			return null;
		}
		return Object.freeze({
			sessionId: current.sessionId,
			handoffGeneration: current.generation,
			switchIntentSeq: current.currentSwitchIntentSeq,
			targetFile: request.targetFile,
			sourceUnloadReceiptId: request.sourceUnloadReceiptId,
		});
	}

	private createSourceUnloadDrainOwner(
		runtime: ManagedLeafRuntime,
		sourceFile: TFile,
		reservation: ManagedLeafInputStartReservation | null,
	): ManagedSourceUnloadDrainOwner | null {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		const cmGuard = runtime.cmGuard;
		const sourceBinding = this.bindings.get(session.leafId);
		let cmSnapshot: CodeMirrorHandoffGuardSnapshot;
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(session.leafId) !== runtime
			|| session.view.file !== sourceFile
			|| sourceFile.path.length === 0
			|| displayed.kind !== "known"
			|| displayed.file !== sourceFile
			|| displayed.path !== sourceFile.path
			|| cmGuard === null
			|| runtime.sourceUnloadDrain !== null
			|| runtime.transitionInputFence !== null
			|| session.handoff !== null
		) return null;
		try {
			cmSnapshot = cmGuard.snapshot();
		} catch {
			return null;
		}
		if (
			cmSnapshot.view !== displayed.cm
			|| cmSnapshot.inert
			|| cmSnapshot.targetSelectionFence !== null
			|| cmSnapshot.sourceUnloadDrain !== null
			|| this.getCmView(session.view) !== displayed.cm
			|| displayed.document !== displayed.cm.state.doc
			|| (
				reservation === null
				? session.pendingInputStartReservation !== null
				: (
					session.pendingInputStartReservation !== reservation
					|| reservation.sourceFileAtStart !== sourceFile
					|| reservation.sourceAuthorityPathAtStart !== displayed.path
					|| reservation.sourceDocumentAtStart !== displayed.document
					|| reservation.targetFileAtStart !== null
					|| reservation.targetPathAtStart !== null
				)
			)
		) return null;
		let resolve!: () => void;
		let reject!: (reason: Error) => void;
		const promise = new Promise<void>((accept, decline) => {
			resolve = accept;
			reject = decline;
		});
		// The TextFileView wrapper consumes this promise immediately. Marking it
		// handled here also keeps a synchronous terminal classification from
		// surfacing as an unrelated unhandled-rejection warning.
		void promise.catch(() => undefined);
		return {
			ownerId: this.createManagedAuthorityRequestId("source-unload-drain"),
			runtime,
			sourceSession: session,
			sourceFile,
			sourcePath: sourceFile.path,
			sourceBinding,
			sourceBindingEpoch: this.bindingEpochByLeafId.get(session.leafId) ?? 0,
			cmGuard,
			reservation,
			promise,
			state: "draining",
			targetSelectionToken: null,
			structuralEditorOnlyCompletion: false,
			settlementQueued: false,
			settled: false,
			resolve,
			reject,
		};
	}

	private sourceUnloadDrainSourceCurrent(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
	): boolean {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		try {
			return this.sourceUnloadDrainOwnerCurrent(runtime, owner)
				&& displayed.kind === "known"
				&& displayed.cm === owner.cmGuard.snapshot().view
				&& displayed.document === displayed.cm.state.doc
				&& this.getCmView(session.view) === displayed.cm;
		} catch {
			return false;
		}
	}

	private sourceUnloadDrainOwnerCurrent(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
	): boolean {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		return this.asyncAuthorityOpen
			&& this.managedSessions.get(session.leafId) === runtime
			&& runtime.sourceUnloadDrain === owner
			&& owner.runtime === runtime
			&& runtime.cmGuard === owner.cmGuard
			&& owner.sourceSession.sessionId === session.sessionId
			&& owner.sourceSession.generation === session.generation
			&& owner.sourceFile.path === owner.sourcePath
			&& session.view.file === owner.sourceFile
			&& displayed.kind === "known"
			&& displayed.file === owner.sourceFile
			&& displayed.path === owner.sourcePath
			&& this.bindings.get(session.leafId) === owner.sourceBinding
			&& (this.bindingEpochByLeafId.get(session.leafId) ?? 0)
				=== owner.sourceBindingEpoch;
	}

	private terminalizeSourceUnloadDrain(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
		reason: string,
		deferVisibleExport = false,
	): void {
		if (runtime.sourceUnloadDrain !== owner || owner.state === "transferred") return;
		owner.state = "terminal";
		if (owner.targetSelectionToken !== null) {
			let tokenCurrent = false;
			try {
				tokenCurrent = owner.cmGuard.isTargetSelectionFenceCurrent(
					owner.targetSelectionToken,
				);
			} catch {
				tokenCurrent = false;
			}
			if (!tokenCurrent) owner.targetSelectionToken = null;
		}
		if (owner.targetSelectionToken === null) {
			try {
				owner.targetSelectionToken = owner.cmGuard
					.forceTargetSelectionFenceForTerminal(owner.ownerId);
			} catch {
				owner.targetSelectionToken = null;
			}
		}
		this.ensureEmergencyHostSaveFence(runtime, `source-unload-drain:${reason}`);
		const visible = deferVisibleExport || owner.structuralEditorOnlyCompletion
			? null
			: this.captureStableVisibleManagedContent(runtime);
		if (visible !== null) {
			const pendingClose = this.pendingStructuralSourceCloseSettlements.get(
				runtime.session.leafId,
			);
			if (
				pendingClose?.runtime === runtime
				&& pendingClose.owner === owner
			) {
				this.settleStructuralSourceClose(
					pendingClose,
					visible,
					true,
					`input-completed:${reason}`,
				);
			} else {
				this.offerTerminalVisibleContentExport(
					runtime,
					visible,
					`source-unload-drain:${reason}`,
				);
			}
		}
		if (!owner.settled) {
			owner.settled = true;
			owner.reject(new Error(`source-unload-drain:${reason}`));
		}
		this.trace?.("editor", "source-unload-drain-terminal", {
			leafId: runtime.session.leafId,
			path: owner.sourcePath,
			reason,
		});
	}

	private beginSourceUnloadDrain(
		runtime: ManagedLeafRuntime,
		sourceFile: TFile,
	): null | PromiseLike<void> {
		const reservation = runtime.session.pendingInputStartReservation;
		const owner = this.createSourceUnloadDrainOwner(runtime, sourceFile, reservation);
		if (owner === null) {
			const rejected = Promise.reject(new Error("source-unload-drain-boundary-unprovable"));
			void rejected.catch(() => undefined);
			return rejected;
		}
		runtime.sourceUnloadDrain = owner;
		if (reservation === null) {
			let token: TargetSelectionFenceToken | null = null;
			try {
				token = owner.cmGuard.prepareTargetSelectionFence(owner.ownerId);
			} catch {
				token = null;
			}
			if (
				token === null
				|| !this.sourceUnloadDrainOwnerCurrent(runtime, owner)
				|| !owner.cmGuard.isTargetSelectionFenceCurrent(token)
			) {
				this.terminalizeSourceUnloadDrain(runtime, owner, "immediate-fence-unprovable");
				return owner.promise;
			}
			owner.targetSelectionToken = token;
			owner.state = "fenced";
			owner.settled = true;
			owner.resolve();
			return null;
		}
		let draining = false;
		try {
			draining = owner.cmGuard.beginSourceUnloadDrain(owner.ownerId, reservation);
		} catch {
			draining = false;
		}
		if (!draining || !this.sourceUnloadDrainSourceCurrent(runtime, owner)) {
			this.terminalizeSourceUnloadDrain(runtime, owner, "reservation-drain-unprovable");
		}
		return owner.promise;
	}

	private queueSourceUnloadDrainSettlement(
		runtime: ManagedLeafRuntime,
		reservation: ManagedLeafInputStartReservation,
		outcome: "completed" | "cancelled" | "ambiguous",
	): void {
		const owner = runtime.sourceUnloadDrain;
		if (
			owner === null
			|| owner.reservation !== reservation
			|| owner.state !== "draining"
			|| owner.settlementQueued
		) return;
		if (outcome === "ambiguous") {
			this.terminalizeSourceUnloadDrain(runtime, owner, "input-result-ambiguous");
			return;
		}
		owner.settlementQueued = true;
		queueMicrotask(() => {
			if (
				owner.state !== "draining"
				|| owner.settled
				|| runtime.session.pendingInputStartReservation !== null
			) {
				this.terminalizeSourceUnloadDrain(runtime, owner, "settlement-cas-drift");
				return;
			}
			let token: TargetSelectionFenceToken | null = null;
			try {
				token = owner.cmGuard.prepareTargetSelectionFence(
					owner.ownerId,
					reservation,
				);
			} catch {
				token = null;
			}
			const sourceCurrent = token !== null
				&& this.sourceUnloadDrainOwnerCurrent(runtime, owner);
			const tokenCurrent = token !== null
				&& owner.cmGuard.isTargetSelectionFenceCurrent(token);
			if (token === null || !sourceCurrent || !tokenCurrent) {
				const session = runtime.session;
				const displayed = session.displayedLineage;
				let guardViewCurrent = false;
				try {
					guardViewCurrent = displayed.kind === "known"
						&& displayed.cm === owner.cmGuard.snapshot().view;
				} catch {
					guardViewCurrent = false;
				}
				this.trace?.("editor", "source-unload-drain-fence-cas-rejected", {
					leafId: runtime.session.leafId,
					path: owner.sourcePath,
					tokenCreated: token !== null,
					sourceCurrent,
					tokenCurrent,
					managerCurrent: this.managedSessions.get(session.leafId) === runtime,
					ownerCurrent: runtime.sourceUnloadDrain === owner,
					sessionCurrent: owner.sourceSession.sessionId === session.sessionId
						&& owner.sourceSession.generation === session.generation,
					filePathCurrent: owner.sourceFile.path === owner.sourcePath,
					viewFileCurrent: session.view.file === owner.sourceFile,
					displayedFileCurrent: displayed.kind === "known"
						&& displayed.file === owner.sourceFile
						&& displayed.path === owner.sourcePath,
					guardViewCurrent,
					documentCurrent: displayed.kind === "known"
						&& displayed.document === displayed.cm.state.doc,
					runtimeCmCurrent: displayed.kind === "known"
						&& this.getCmView(session.view) === displayed.cm,
					bindingCurrent: this.bindings.get(session.leafId) === owner.sourceBinding,
					bindingEpochCurrent: (this.bindingEpochByLeafId.get(session.leafId) ?? 0)
						=== owner.sourceBindingEpoch,
				});
				this.terminalizeSourceUnloadDrain(runtime, owner, "settled-fence-unprovable");
				return;
			}
			owner.targetSelectionToken = token;
			owner.state = "fenced";
			owner.settled = true;
			owner.resolve();
			this.trace?.("editor", "source-unload-drain-settled", {
				leafId: runtime.session.leafId,
				path: owner.sourcePath,
				outcome,
			});
		});
	}

	private installManagedHostGuard(runtime: ManagedLeafRuntime): boolean {
		if (runtime.hostGuard) {
			const snapshot = runtime.hostGuard.snapshot();
			if (snapshot.mode.kind !== "inert-pass-through") {
				let emergencyCurrent = true;
				if (runtime.emergencySaveFence !== null) {
					try {
						emergencyCurrent = runtime.emergencySaveFence.isCurrent();
					} catch {
						emergencyCurrent = false;
					}
				}
				if (hasExactHostGuardWrappers(snapshot) && emergencyCurrent) return true;
				this.ensureEmergencyHostSaveFence(runtime, "managed-save-wrapper-drift");
				runtime.cmGuard?.refreshGate();
				this.trace?.("editor", "managed-save-wrapper-drift-terminal", {
					leafId: runtime.session.leafId,
					wrappersCurrent: snapshot.wrappersCurrent,
				});
				try {
					new Notice(
						"Kaos detected a replaced native save boundary. Future saves are blocked, but an earlier opaque save tail cannot be cancelled; complete the recovery export action and reopen this pane.",
						10_000,
					);
				} catch {
					// The retained runtime and recaptured wrappers remain authoritative.
				}
				return false;
			}
			runtime.hostGuard.restoreIfCurrent();
			runtime.hostGuard = null;
		}
			const view = runtime.session.view as unknown as TextFileView;
			const result = installTextFileViewHandoffGuard(view, {
				onUnloadFileEntry: (sourceFile) =>
					this.beginSourceUnloadDrain(runtime, sourceFile),
				onLoadFileEntry: (targetFile, sourceUnloadReceiptId) => {
					const rejectAdmission = (reason: string) => {
						const drain = runtime.sourceUnloadDrain;
						if (drain !== null) {
							this.terminalizeSourceUnloadDrain(runtime, drain, reason);
						} else {
							this.ensureEmergencyHostSaveFence(
								runtime,
								`host-load-entry:${reason}`,
							);
						}
						const rejected = Promise.reject<ManagedHostSwitchTicket | null>(
							new Error(`host-load-entry:${reason}`),
						);
						void rejected.catch(() => undefined);
						return rejected;
					};
					const admission = this.exactPendingHostLoadAdmission(
						runtime,
						targetFile,
						targetFile.path,
						sourceUnloadReceiptId,
					);
					if (admission === null) return rejectAdmission("owner-unprovable");
					const leafId = runtime.session.leafId;
					const sourceSession = runtime.session;
					const base = {
						runtime,
						admission,
						targetFile,
						targetPath: targetFile.path,
						sourceUnloadReceiptId,
						sourceSession,
						sourceBinding: this.bindings.get(leafId),
						sourceBindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
						authorityEpoch: this.readAuthorityEpoch(),
					} as const;
					const synchronousProbe: ManagedHostLoadAdmissionAttempt = {
						...base,
					};
					const ticket = this.tryAdmitPendingHostLoad(synchronousProbe);
					if (ticket !== null) return ticket;
					return rejectAdmission("selected-fence-cas-rejected");
				},
			onSetViewDataEntry: ({ ticket, incomingContent, clear }) => {
				if (!this.isManagedSessionCurrent(ticket.sessionId, ticket.handoffGeneration)) {
					this.trace?.("editor", "host-clear-load-arm-rejected", {
						leafId: runtime.session.leafId,
						reason: "session-not-current",
					});
					return null;
				}
				const current = this.managedSessions.get(runtime.session.leafId);
				const handoff = current?.session.handoff;
				const cmGuard = current?.cmGuard;
				if (
					current !== runtime
					|| clear !== true
					|| handoff == null
					|| handoff.targetFile !== ticket.targetFile
					|| handoff.targetPath !== ticket.targetFile.path
					|| handoff.sourceUnloadReceiptId !== ticket.sourceUnloadReceiptId
					|| current.session.currentSwitchIntentSeq !== ticket.switchIntentSeq
					|| handoff.bindingEpochAfterDetach < 0
					|| cmGuard == null
				) {
					this.trace?.("editor", "host-clear-load-arm-rejected", {
						leafId: runtime.session.leafId,
						reason: current !== runtime
							? "runtime-replaced"
							: clear !== true
								? "clear-not-true"
								: handoff == null
									? "handoff-missing"
									: handoff.targetFile !== ticket.targetFile
										|| handoff.targetPath !== ticket.targetFile.path
										? "target-mismatch"
										: handoff.sourceUnloadReceiptId !== ticket.sourceUnloadReceiptId
											? "source-receipt-mismatch"
											: current.session.currentSwitchIntentSeq !== ticket.switchIntentSeq
												? "switch-sequence-mismatch"
												: handoff.bindingEpochAfterDetach < 0
													? "binding-not-detached"
													: "cm-guard-missing",
					});
					return null;
				}
				const cm = cmGuard.snapshot().view;
				const stateBeforeHostClear = cm.state;
				const hostLoadTokenId = this.createManagedAuthorityRequestId("host-load");
				const armed = cmGuard.armHostLoad({
					hostLoadTokenId,
					sourceUnloadReceiptId: ticket.sourceUnloadReceiptId,
					sessionId: ticket.sessionId,
					leafId: current.session.leafId,
					handoffGeneration: ticket.handoffGeneration,
					switchIntentSeq: ticket.switchIntentSeq,
					targetPath: handoff.targetPath,
					targetFile: handoff.targetFile,
					runtimeView: current.session.view as unknown as TextFileView,
					incomingContent,
					bindingEpoch: handoff.bindingEpochAfterDetach,
					editorRevisionBefore:
						this.editorRevisionByCm.get(cm) ?? 0,
				});
				this.trace?.("editor", armed
					? "host-clear-load-armed"
					: "host-clear-load-arm-rejected", {
					leafId: runtime.session.leafId,
					reason: armed ? "exact" : "cm-guard-rejected",
				});
				if (armed) {
					queueMicrotask(() => {
						const liveCm = this.getCmView(runtime.session.view);
						this.trace?.("editor", "host-clear-load-post-delegation", {
							leafId: runtime.session.leafId,
							liveCmResolved: liveCm !== null,
							liveCmMatchesGuard: liveCm === cm,
							stateIdentityChanged: cm.state !== stateBeforeHostClear,
							documentIdentityChanged: cm.state.doc !== stateBeforeHostClear.doc,
							liveDocumentMatchesIncoming:
								cm.state.doc.toString() === incomingContent,
							liveDocumentLength: liveCm?.state.doc.length ?? null,
							guardDocumentLength: cm.state.doc.length,
							incomingLength: incomingContent.length,
						});
					});
				}
				return armed ? hostLoadTokenId : null;
			},
			onSetViewDataExit: ({ ticket, hostLoadTokenId }) => {
				const current = this.managedSessions.get(runtime.session.leafId);
				const handoff = current?.session.handoff;
				if (
					current !== runtime
					|| handoff == null
					|| current.session.sessionId !== ticket.sessionId
					|| current.session.generation !== ticket.handoffGeneration
					|| current.session.currentSwitchIntentSeq !== ticket.switchIntentSeq
					|| handoff.sourceUnloadReceiptId !== ticket.sourceUnloadReceiptId
					|| handoff.targetFile !== ticket.targetFile
					|| handoff.targetPath !== ticket.targetFile.path
					|| current.cmGuard == null
				) return false;
				const certified = current.cmGuard.certifyHostLoadPostDelegation(
					hostLoadTokenId,
				);
				const failureReason = (
					typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
					&& __KAOS_QA_HARNESS_ENABLED__
				)
					? current.cmGuard.snapshot().hostPostDelegationFailureReason ?? null
					: null;
				this.trace?.("editor", certified
					? "host-clear-load-post-delegation-certified"
					: "host-clear-load-post-delegation-rejected", {
					leafId: current.session.leafId,
					reason: failureReason,
				});
				if (certified) this.presentLocalTargetOnce(current);
				return certified;
			},
			onHostLoadCandidate: (candidate) =>
				this.isHostLoadCandidateCurrent(candidate),
			isHostLoadCandidateCurrent: (candidate) =>
				this.isHostLoadCandidateCurrent(candidate),
			onHostLoadCompleted: (receipt) => {
				const finalize = (): void => {
					if (this.managedSessions.get(runtime.session.leafId) !== runtime) return;
					this.handleLocalTargetPresentationCompletion(runtime, receipt);
				};
				// Receipt publication is re-entrant from the CM guard. Let its exact
				// post-notification checks finish before publishing B authority. The
				// local commit starts in setViewData's certified synchronous tail, so
				// this microtask is queued before the host load promise is exposed.
				queueMicrotask(finalize);
			},
			onSaveSuppressed: (input) => {
				this.trace?.("editor", "managed-save-suppressed", input);
			},
			captureSaveOwnershipContext: () => {
				const current = this.managedSessions.get(runtime.session.leafId);
				const session = current?.session;
				const displayed = session?.displayedLineage;
				const file = session?.view.file ?? null;
				if (
					current !== runtime
					|| session === undefined
					|| displayed?.kind !== "known"
					|| file === null
					|| displayed.file !== file
					|| displayed.path !== file.path
				) return null;
				return {
					sessionId: session.sessionId,
					generation: session.generation,
					file,
					path: file.path,
					displayedPath: displayed.path,
				};
			},
			isSaveOwnershipContextCurrent: (context) => {
				const current = this.managedSessions.get(runtime.session.leafId);
				const session = current?.session;
				const displayed = session?.displayedLineage;
				return current === runtime
					&& session !== undefined
					&& session.sessionId === context.sessionId
					&& session.generation === context.generation
					&& session.view.file === context.file
					&& context.file.path === context.path
					&& displayed?.kind === "known"
					&& displayed.file === context.file
					&& displayed.path === context.displayedPath
					&& context.displayedPath === context.path;
			},
			onHostCapabilityLost: (reason) => {
				this.advanceAuthorityEpoch();
				const handoffAtLoss = runtime.session.handoff;
				if (
					handoffAtLoss !== null
					|| reason === "host-wrapper-drift-before-host-load"
					|| reason === "source-unload-proof-lost-before-host-load"
					|| reason.startsWith("source-unload-")
				) {
					this.ensureEmergencyHostSaveFence(
						runtime,
						`host-capability-lost:${reason}`,
					);
				}
				this.trace?.("editor", "managed-host-capability-lost", {
					leafId: runtime.session.leafId,
					reason,
				});
				queueMicrotask(() => {
					const current = this.managedSessions.get(runtime.session.leafId);
					if (current !== runtime) return;
					const structuralSourceOwner = current.sourceUnloadDrain;
					if (
						structuralSourceOwner?.state === "terminal"
						&& structuralSourceOwner.structuralEditorOnlyCompletion
					) {
						// The exact native successor or bounded close recovery owns these
						// bytes now. Generic host-capability recovery must not offer the old
						// visible document first and consume the one explicit exporter prompt.
						this.ensureEmergencyHostSaveFence(
							current,
							`host-capability-lost:${reason}:structural-source-close`,
						);
						this.trace?.("editor", "source-unload-drain-host-recovery-deferred", {
							leafId: current.session.leafId,
							path: structuralSourceOwner.sourcePath,
							reason,
						});
						return;
					}
					const handoff = runtime.session.handoff;
					const candidate = handoff?.pendingHostLoadCandidate ?? null;
					if (handoff !== null) {
						// A certified candidate can exist only behind this exact host
						// wrapper. Capability loss must not restore that wrapper and open
						// an A-to-B autosave lane while any handoff remains unresolved.
						runtime.hostGuard?.beginBlockingHandoff({
							handoffGeneration: runtime.session.generation,
							sourceLineagePath: handoff.sourceAuthorityPath,
							targetPath: handoff.targetPath,
						});
						const protectedNow = this.ensureEmergencyHostSaveFence(
							runtime,
							`host-capability-lost:${reason}:terminal`,
						);
						if (
							candidate !== null
							&& handoff.presentation === "target-candidate"
						) {
							this.handleFailedTargetPresentation(
								runtime,
								candidate,
								`host-capability-lost:${reason}`,
							);
						} else {
							const visibleContent = this.captureStableVisibleManagedContent(runtime);
							if (visibleContent !== null) {
								this.offerTerminalVisibleContentExport(
									runtime,
									visibleContent,
									`host-capability-lost:${reason}`,
								);
								return;
							}
							try {
								new Notice(
									protectedNow
										? "KAOS lost the native save capability during a note switch. Saving and input are blocked; close and reopen this pane."
										: "KAOS lost the native save capability during a note switch and could not prove both save entry points. Keep this pane open and do not continue editing until recovery controls are available.",
									10_000,
								);
							} catch {
								// The retained runtime and emergency wrapper are authoritative.
							}
						}
						return;
					}
					let terminalLifecycle = false;
					try {
						terminalLifecycle = runtime.hostGuard?.snapshot().terminalHostLifecycle != null;
					} catch {
						terminalLifecycle = true;
					}
					if (
						reason === "host-wrapper-drift-before-host-load"
						|| reason === "source-unload-proof-lost-before-host-load"
						|| reason.startsWith("source-unload-")
						|| terminalLifecycle
					) {
						const protectedNow = this.ensureEmergencyHostSaveFence(
							runtime,
							`host-capability-lost:${reason}:terminal-lifecycle`,
						);
						const displayed = runtime.session.displayedLineage;
						const terminalTarget = runtime.session.view.file
							?? (displayed.kind === "known" ? displayed.file : null);
						if (terminalTarget !== null && runtime.transitionInputFence === null) {
							const transition = this.acquireTransitionInputFence(
								runtime,
								terminalTarget,
								terminalTarget.path,
								runtime.session,
								true,
							);
							if (transition !== null) transition.fence.state = "reopen-required";
						}
						const visibleContent = this.captureStableVisibleManagedContent(runtime);
						if (visibleContent !== null) {
							this.offerTerminalVisibleContentExport(
								runtime,
								visibleContent,
								`host-capability-lost:${reason}:terminal-lifecycle`,
							);
							return;
						}
						try {
							new Notice(
								protectedNow
									? "KAOS blocked this note switch before the target load. Input and saving are blocked; close and reopen this pane."
									: "KAOS could not prove a save boundary before the target load. Keep this pane open and do not continue editing until recovery controls are available.",
								10_000,
							);
						} catch {
							// The terminal managed boundary remains retained.
						}
						return;
					}
					this.cancelManagedHandoffAndUnmanage(
						runtime.session.view,
						`host-capability-lost:${reason}`,
						"unsupported-host",
					);
				});
			},
			isSessionCurrent: (sessionId, generation) =>
				this.isManagedSessionCurrent(sessionId, generation),
		}, {
			hostApiVersion: EDITOR_HANDOFF_QA_ENABLED
				? editorHandoffHostApiVersionOverrideForQa ?? apiVersion
				: apiVersion,
		});
		if (result.kind === "installed") {
			this.advanceAuthorityEpoch();
			runtime.hostGuard = result.guard;
			if (EDITOR_HANDOFF_QA_ENABLED) {
				const barrier = editorHandoffHostQaBarriers?.get(this);
				if (barrier) {
					associateEditorHandoffHostQaBarrier(view, result.guard, barrier);
				}
			}
			return result.guard.snapshot().mode.kind !== "inert-pass-through";
		} else {
			this.trace?.("editor", "managed-host-guard-unsupported", {
				leafId: runtime.session.leafId,
				reason: result.reason,
			});
			return false;
		}
	}

	private ensureEmergencyHostSaveFence(
		runtime: ManagedLeafRuntime,
		reason: string,
	): boolean {
		const guard = runtime.hostGuard;
		if (
			guard === null
			|| this.managedSessions.get(runtime.session.leafId) !== runtime
		) return false;
		let fence = runtime.emergencySaveFence;
		if (fence === null || fence.view !== runtime.session.view) {
			try {
				fence = guard.acquireEmergencySaveFence();
				runtime.emergencySaveFence = fence;
			} catch {
				fence = null;
			}
		}
		let ready = false;
		try {
			ready = fence !== null && fence.refresh() && fence.isCurrent();
		} catch {
			ready = false;
		}
		this.trace?.("editor", ready
			? "managed-emergency-save-fence-retained"
			: "managed-emergency-save-fence-unavailable", {
			leafId: runtime.session.leafId,
			reason,
		});
		return ready;
	}

	private releaseEmergencyHostSaveFence(
		runtime: ManagedLeafRuntime,
		reason: string,
		safeBoundary = false,
		markProof: ManagedTargetMarkReleaseProof | null = null,
	): boolean {
		const fence = runtime.emergencySaveFence;
		if (fence === null) return true;
		if (safeBoundary) {
			let released = false;
			try {
				released = fence.release();
			} catch {
				released = false;
			}
			if (released && runtime.emergencySaveFence === fence) {
				runtime.emergencySaveFence = null;
			}
			this.trace?.("editor", released
				? "managed-emergency-save-fence-released"
				: "managed-emergency-save-fence-release-rejected", {
				leafId: runtime.session.leafId,
				reason,
				current: false,
			});
			return released;
		}

		const session = runtime.session;
		const handoff = session.handoff;
		const guard = runtime.hostGuard;
		const cmGuard = runtime.cmGuard;
		const candidate = handoff?.pendingHostLoadCandidate ?? null;
		const authorityEpoch = this.readAuthorityEpoch();
		if (
			handoff === null
			|| candidate === null
			|| guard === null
			|| this.managedSessions.get(session.leafId) !== runtime
			|| session.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
			|| fence.view !== (session.view as unknown as TextFileView)
		) return false;
		const exactMarkProof = markProof !== null
			&& markProof.runtime === runtime
			&& markProof.sourceSession === session
			&& markProof.candidate === candidate
			&& markProof.hostGuard === guard
			&& markProof.targetFile === handoff.targetFile
			&& markProof.targetPath === handoff.targetPath
			&& this.getCmView(session.view) === candidate.cm;
		if (markProof !== null && !exactMarkProof) return false;
		let nativeTargetReady = exactMarkProof;
		if (!nativeTargetReady) {
			try {
				nativeTargetReady = guard.isTargetPresentationReady({
					handoffGeneration: session.generation,
					targetFile: handoff.targetFile,
					certifiedContent: candidate.incomingContent,
				});
			} catch {
				nativeTargetReady = false;
			}
		}
		if (!nativeTargetReady) return false;
		let before: ManagedViewSaveGuard;
		let cmBefore: CodeMirrorHandoffGuardSnapshot | null;
		let current = false;
		try {
			before = guard.snapshot();
			cmBefore = cmGuard?.snapshot() ?? null;
			current = fence.isCurrent();
		} catch {
			return false;
		}
		if (
			!current
			|| cmBefore === null
			|| this.getCmView(session.view) !== cmBefore.view
			|| before.view !== (session.view as unknown as TextFileView)
			|| !hasExactHostGuardWrappers(before)
			|| !before.emergencySaveBlocked
			|| before.hostCapabilityState !== "ready"
			|| before.inFlight.size !== 0
			|| before.pendingOwnedSave !== null
			|| before.pendingTargetSave
			|| !hasNoPendingHostLoadOwner(before)
		) return false;
		let stableBefore: ManagedViewSaveGuard;
		let stableCmBefore: CodeMirrorHandoffGuardSnapshot | null;
		try {
			stableBefore = guard.snapshot();
			stableCmBefore = cmGuard?.snapshot() ?? null;
		} catch {
			return false;
		}
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| runtime.hostGuard !== guard
			|| runtime.cmGuard !== cmGuard
			|| runtime.emergencySaveFence !== fence
			|| session.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
			|| stableCmBefore === null
			|| this.getCmView(session.view) !== stableCmBefore.view
			|| this.readAuthorityEpoch() !== authorityEpoch
			|| !sameHostGuardSnapshot(before, stableBefore)
			|| !sameCodeMirrorGuardSnapshot(cmBefore, stableCmBefore)
		) return false;
		let released = false;
		try {
			released = fence.release();
		} catch {
			released = false;
		}
		let post: ManagedViewSaveGuard | null = null;
		let postCm: CodeMirrorHandoffGuardSnapshot | null = null;
		try {
			post = guard.snapshot();
			postCm = cmGuard?.snapshot() ?? null;
		} catch {
			post = null;
		}
		const postStable = released
			&& post !== null
			&& this.managedSessions.get(session.leafId) === runtime
			&& runtime.session === session
			&& runtime.hostGuard === guard
			&& runtime.cmGuard === cmGuard
			&& runtime.emergencySaveFence === fence
			&& session.view.file === handoff.targetFile
			&& handoff.targetFile.path === handoff.targetPath
			&& postCm !== null
			&& this.getCmView(session.view) === postCm.view
			&& this.readAuthorityEpoch() === authorityEpoch
			&& !post.emergencySaveBlocked
			&& sameHostGuardSnapshot(stableBefore, {
				...post,
				emergencySaveBlocked: stableBefore.emergencySaveBlocked,
			})
			&& sameCodeMirrorGuardSnapshot(stableCmBefore, postCm);
		if (postStable) runtime.emergencySaveFence = null;
		else if (released) {
			// The owner was consumed while a re-entrant callback changed authority.
			// Re-arm a fresh exact owner before returning failure to the caller.
			try {
				const replacement = guard.acquireEmergencySaveFence();
				runtime.emergencySaveFence = replacement;
				replacement.refresh();
			} catch {
				// The caller retains the terminal input boundary and explicit reopen path.
			}
			runtime.cmGuard?.refreshGate();
		}
		this.trace?.("editor", released
			&& postStable
			? "managed-emergency-save-fence-released"
			: "managed-emergency-save-fence-release-rejected", {
			leafId: runtime.session.leafId,
			reason,
			current,
		});
		return postStable;
	}

	private transitionContainer(view: MarkdownView): ManagedTransitionContainer | null {
		const container = (view as MarkdownView & Readonly<{
			containerEl?: ManagedTransitionContainer;
		}>).containerEl;
		return typeof container === "object" && container !== null ? container : null;
	}

	private isTransitionContainerOwned(fence: ManagedTransitionInputFence): boolean {
		try {
			if (
				this.transitionContainer(fence.view) !== fence.container
				|| Reflect.get(fence.container, "inert") !== true
			) return false;
			const getAttribute = fence.container.getAttribute;
			const setAttribute = fence.container.setAttribute;
			return typeof getAttribute !== "function"
				|| typeof setAttribute !== "function"
				|| Reflect.apply(getAttribute, fence.container, ["inert"]) === "";
		} catch {
			return false;
		}
	}

	private restoreTransitionContainer(
		fence: ManagedTransitionInputFence,
		force = false,
	): boolean {
		try {
			const currentContainer = this.transitionContainer(fence.view);
			if (!force && currentContainer !== fence.container) return false;
			if (!force && !this.isTransitionContainerOwned(fence)) return false;
			if (fence.hadOwnInert) {
				if (!Reflect.set(fence.container, "inert", fence.previousInert)) return false;
			} else if (!Reflect.deleteProperty(fence.container, "inert")) {
				return false;
			}
			const getAttribute = fence.container.getAttribute;
			const setAttribute = fence.container.setAttribute;
			const removeAttribute = fence.container.removeAttribute;
			if (typeof getAttribute === "function") {
				const current = Reflect.apply(getAttribute, fence.container, ["inert"]);
				if (force || current === "") {
					if (
						fence.previousInertAttribute === null
						&& typeof removeAttribute === "function"
					) Reflect.apply(removeAttribute, fence.container, ["inert"]);
					else if (
						fence.previousInertAttribute !== null
						&& typeof setAttribute === "function"
					) {
						Reflect.apply(setAttribute, fence.container, [
							"inert",
							fence.previousInertAttribute,
						]);
					}
				}
			}
			const inertRestored = Object.prototype.hasOwnProperty.call(
				fence.container,
				"inert",
			) === fence.hadOwnInert
				&& Object.is(Reflect.get(fence.container, "inert"), fence.previousInert);
			let attributeRestored = true;
			if (typeof getAttribute === "function") {
				attributeRestored = Reflect.apply(
					getAttribute,
					fence.container,
					["inert"],
				) === fence.previousInertAttribute;
			}
			return inertRestored && attributeRestored;
		} catch {
			return false;
		}
	}

	private acquireTransitionInputFence(
		runtime: ManagedLeafRuntime,
		targetFile: TFile,
		targetPath: string,
		nextSession: ManagedLeafSession,
		terminal = false,
		preownedTargetSelectionToken: TargetSelectionFenceToken | null = null,
	): Readonly<{
		fence: ManagedTransitionInputFence;
		newlyAcquired: boolean;
		tokenPreowned: boolean;
		previousTargetFile: TFile;
		previousTargetPath: string;
		previousSessionId: string;
		previousGeneration: number;
		previousSwitchIntentSeq: number | null;
		previousState: ManagedTransitionInputFence["state"];
	}> | null {
		const existing = runtime.transitionInputFence;
		if (existing !== null) {
			let guardSnapshot: CodeMirrorHandoffGuardSnapshot;
			try {
				guardSnapshot = existing.cmGuard.snapshot();
			} catch {
				existing.state = "reopen-required";
				return null;
			}
			if (
				existing.view !== runtime.session.view
				|| !this.isTransitionContainerOwned(existing)
				|| runtime.cmGuard !== existing.cmGuard
				|| guardSnapshot.inert
				|| !guardSnapshot.gateClosed
				|| existing.state !== "handoff"
				|| existing.targetSelectionToken !== null
				|| guardSnapshot.targetSelectionFence !== null
			) {
				existing.state = "reopen-required";
				return null;
			}
			const previous = {
				fence: existing,
				newlyAcquired: false,
				tokenPreowned: false,
				previousTargetFile: existing.targetFile,
				previousTargetPath: existing.targetPath,
				previousSessionId: existing.sessionId,
				previousGeneration: existing.handoffGeneration,
				previousSwitchIntentSeq: existing.switchIntentSeq,
				previousState: existing.state,
			} as const;
			existing.targetFile = targetFile;
			existing.targetPath = targetPath;
			existing.sessionId = nextSession.sessionId;
			existing.handoffGeneration = nextSession.generation;
			existing.switchIntentSeq = nextSession.currentSwitchIntentSeq;
			existing.state = "handoff";
			return previous;
		}

		const cmGuard = runtime.cmGuard;
		const sourceSession = runtime.session;
		const sourceAuthorityEpoch = this.readAuthorityEpoch();
		const container = this.transitionContainer(sourceSession.view);
		if (cmGuard === null || container === null) return null;
		let hadOwnInert: boolean;
		let previousInert: unknown;
		let previousInertAttribute: string | null = null;
		let getAttribute: ManagedTransitionContainer["getAttribute"];
		let setAttribute: ManagedTransitionContainer["setAttribute"];
		try {
			hadOwnInert = Object.prototype.hasOwnProperty.call(container, "inert");
			previousInert = Reflect.get(container, "inert");
			getAttribute = container.getAttribute;
			setAttribute = container.setAttribute;
			if (typeof getAttribute === "function") {
				previousInertAttribute = Reflect.apply(getAttribute, container, ["inert"]);
			}
		} catch {
			return null;
		}
		if (
			this.managedSessions.get(sourceSession.leafId) !== runtime
			|| runtime.session !== sourceSession
			|| runtime.cmGuard !== cmGuard
			|| runtime.transitionInputFence !== null
			|| this.transitionContainer(sourceSession.view) !== container
			|| this.readAuthorityEpoch() !== sourceAuthorityEpoch
		) return null;
		const ownerId = this.createManagedAuthorityRequestId("target-selection-fence");
		const token = preownedTargetSelectionToken
			?? (cmGuard.prepareTargetSelectionFence(ownerId)
				?? (terminal
					? cmGuard.forceTargetSelectionFenceForTerminal(ownerId)
					: null));
		if (token === null) return null;
		if (
			preownedTargetSelectionToken !== null
			&& !cmGuard.isTargetSelectionFenceCurrent(preownedTargetSelectionToken)
		) return null;
		const fence: ManagedTransitionInputFence = {
			ownerId,
			view: sourceSession.view,
			container,
			previousInert,
			hadOwnInert,
			previousInertAttribute,
			cmGuard,
			targetSelectionToken: token,
			targetFile,
			targetPath,
			sessionId: nextSession.sessionId,
			handoffGeneration: nextSession.generation,
			switchIntentSeq: nextSession.currentSwitchIntentSeq,
			state: "preselection",
		};
		// Publish ownership before the container mutation.  Any exception or
		// re-entrant epoch drift still leaves an explicit reopen owner behind.
		runtime.transitionInputFence = fence;
		try {
			if (
				this.managedSessions.get(sourceSession.leafId) !== runtime
				|| runtime.session !== sourceSession
				|| runtime.cmGuard !== cmGuard
				|| runtime.transitionInputFence !== fence
				|| this.transitionContainer(sourceSession.view) !== container
				|| this.readAuthorityEpoch() !== sourceAuthorityEpoch
				|| !cmGuard.isTargetSelectionFenceCurrent(token)
				|| Object.prototype.hasOwnProperty.call(container, "inert") !== hadOwnInert
				|| !Object.is(Reflect.get(container, "inert"), previousInert)
				|| container.getAttribute !== getAttribute
				|| container.setAttribute !== setAttribute
				|| (
					typeof getAttribute === "function"
					&& Reflect.apply(getAttribute, container, ["inert"])
						!== previousInertAttribute
				)
			) throw new Error("transition-owner-stale-before-inert");
			if (!Reflect.set(container, "inert", true)) throw new Error("inert-set-rejected");
			if (runtime.transitionInputFence !== fence) {
				throw new Error("transition-owner-revoked-during-inert-set");
			}
			if (typeof setAttribute === "function") {
				Reflect.apply(setAttribute, container, ["inert", ""]);
			}
			if (runtime.transitionInputFence !== fence) {
				throw new Error("transition-owner-revoked-during-inert-attribute");
			}
			if (!this.isTransitionContainerOwned(fence)) {
				throw new Error("inert-not-owned");
			}
			return {
				fence,
				newlyAcquired: true,
				tokenPreowned: preownedTargetSelectionToken !== null,
				previousTargetFile: targetFile,
				previousTargetPath: targetPath,
				previousSessionId: nextSession.sessionId,
				previousGeneration: nextSession.generation,
				previousSwitchIntentSeq: nextSession.currentSwitchIntentSeq,
				previousState: "preselection" as const,
			};
		} catch {
			if (preownedTargetSelectionToken !== null) {
				const restored = this.restoreTransitionContainer(fence, true);
				if (runtime.transitionInputFence === fence) {
					if (restored) runtime.transitionInputFence = null;
					else fence.state = "reopen-required";
				}
				return null;
			}
			// Exact source release is attempted only while the token still proves the
			// unchanged source.  A failed release deliberately leaves CM fail-closed.
			let released = false;
			try {
				released = cmGuard.releaseTargetSelectionFence(token);
			} catch {
				released = false;
			}
			const restored = this.restoreTransitionContainer(fence, true);
			if (runtime.transitionInputFence === fence) {
				if (released && restored) runtime.transitionInputFence = null;
				else fence.state = "reopen-required";
			}
			return null;
		}
	}

	private abortTransitionInputFence(
		runtime: ManagedLeafRuntime,
		acquisition: NonNullable<ReturnType<EditorBindingManager["acquireTransitionInputFence"]>>,
	): void {
		const fence = acquisition.fence;
		if (runtime.transitionInputFence !== fence) return;
		if (!acquisition.newlyAcquired) {
			fence.targetFile = acquisition.previousTargetFile;
			fence.targetPath = acquisition.previousTargetPath;
			fence.sessionId = acquisition.previousSessionId;
			fence.handoffGeneration = acquisition.previousGeneration;
			fence.switchIntentSeq = acquisition.previousSwitchIntentSeq;
			fence.state = acquisition.previousState;
			return;
		}
		if (acquisition.tokenPreowned) {
			fence.state = "reopen-required";
			return;
		}
		const token = fence.targetSelectionToken;
		let released = false;
		try {
			released = token !== null
				&& fence.cmGuard.releaseTargetSelectionFence(token);
		} catch {
			released = false;
		}
		if (released && this.restoreTransitionContainer(fence)) {
			runtime.transitionInputFence = null;
			return;
		}
		fence.state = "reopen-required";
	}

	private transferTransitionInputFence(
		runtime: ManagedLeafRuntime,
		fence: ManagedTransitionInputFence,
	): boolean {
		if (runtime.transitionInputFence !== fence) return false;
		const token = fence.targetSelectionToken;
		if (token !== null) {
			let transferred = false;
			try {
				transferred = fence.cmGuard.transferTargetSelectionFence(token);
			} catch {
				transferred = false;
			}
			if (!transferred) {
				fence.state = "reopen-required";
				return false;
			}
			fence.targetSelectionToken = null;
		}
		fence.state = "handoff";
		return true;
	}

	private releaseTransitionInputFence(
		runtime: ManagedLeafRuntime,
		targetFile: TFile,
		targetPath: string,
		reason: string,
		force = false,
	): boolean {
		const fence = runtime.transitionInputFence;
		if (fence === null) return true;
		let cmSnapshot: CodeMirrorHandoffGuardSnapshot | null = null;
		let hostSnapshot: ManagedViewSaveGuard | null = null;
		try {
			cmSnapshot = runtime.cmGuard?.snapshot() ?? null;
			hostSnapshot = runtime.hostGuard?.snapshot() ?? null;
		} catch {
			// The force teardown path below does not need live wrapper snapshots.
		}
		const exactTarget = fence.view.file === targetFile
			&& targetFile.path === targetPath
			&& fence.targetFile === targetFile
			&& fence.targetPath === targetPath;
		const safe = force || (
			exactTarget
			&& runtime.emergencySaveFence === null
			&& runtime.cmGuard === fence.cmGuard
			&& cmSnapshot?.inert === false
			&& cmSnapshot.gateClosed === false
			&& cmSnapshot.targetSelectionFence === null
			&& hostSnapshot !== null
			&& hasExactHostGuardWrappers(hostSnapshot)
			&& hasNoPendingHostLoadOwner(hostSnapshot)
			&& hostSnapshot.mode.kind === "pass-through"
			&& !hostSnapshot.emergencySaveBlocked
		);
		if (force && fence.targetSelectionToken !== null) {
			let tokenReleased = false;
			try {
				tokenReleased = fence.cmGuard.releaseTargetSelectionFenceForTeardown(
					fence.targetSelectionToken,
				);
			} catch {
				tokenReleased = false;
			}
			if (!tokenReleased) return false;
			fence.targetSelectionToken = null;
		}
		if (!safe || !this.restoreTransitionContainer(fence, force)) {
			fence.state = "reopen-required";
			this.trace?.("editor", "managed-transition-input-fence-release-rejected", {
				leafId: runtime.session.leafId,
				path: targetPath,
				reason,
			});
			return false;
		}
		runtime.transitionInputFence = null;
		this.trace?.("editor", "managed-transition-input-fence-released", {
			leafId: runtime.session.leafId,
			path: targetPath,
			reason,
		});
		return true;
	}

	private tombstoneDetachedTransitionBoundary(
		runtime: ManagedLeafRuntime,
		reason: string,
	): void {
		const fence = runtime.transitionInputFence;
		try {
			runtime.cmGuard?.markDetachedInertForTeardown();
		} catch {
			// Workspace absence, not a live-view mutation, is the authority to tombstone.
		}
		if (fence !== null) {
			fence.targetSelectionToken = null;
			this.restoreTransitionContainer(fence, true);
			runtime.transitionInputFence = null;
		}
		this.trace?.("editor", "managed-detached-transition-boundary-tombstoned", {
			leafId: runtime.session.leafId,
			reason,
			hadTransitionFence: fence !== null,
		});
	}

	private teardownSourceUnloadDrain(
		runtime: ManagedLeafRuntime,
		reason: string,
	): boolean {
		const owner = runtime.sourceUnloadDrain;
		if (owner === null) return true;
		this.cancelPendingStructuralSourceCloseSettlement(
			runtime.session.leafId,
			runtime,
		);
		let released = owner.targetSelectionToken === null;
		if (owner.targetSelectionToken !== null) {
			try {
				released = owner.cmGuard.releaseTargetSelectionFenceForTeardown(
					owner.targetSelectionToken,
				);
			} catch {
				released = false;
			}
		}
		if (!released) {
			this.trace?.("editor", "source-unload-drain-teardown-rejected", {
				leafId: runtime.session.leafId,
				path: owner.sourcePath,
				reason,
			});
			return false;
		}
		owner.targetSelectionToken = null;
		owner.state = "terminal";
		if (!owner.settled) {
			owner.settled = true;
			owner.reject(new Error(`source-unload-drain-teardown:${reason}`));
		}
		runtime.sourceUnloadDrain = null;
		this.trace?.("editor", "source-unload-drain-torn-down", {
			leafId: runtime.session.leafId,
			path: owner.sourcePath,
			reason,
		});
		return true;
	}

	private isolateStructuralSourceDrainEditorOnlyCompletion(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
		reason: string,
	): boolean {
		const reservation = owner.reservation;
		const binding = owner.sourceBinding;
		if (
			reservation === null
			|| binding === undefined
			|| owner.structuralEditorOnlyCompletion
			|| runtime.sourceUnloadDrain !== owner
			|| owner.state !== "terminal"
			|| this.bindings.get(runtime.session.leafId) !== binding
			|| (this.bindingEpochByLeafId.get(runtime.session.leafId) ?? 0)
				!== owner.sourceBindingEpoch
			|| binding.cm.state.doc !== reservation.sourceDocumentAtStart
		) return false;
		let before: CodeMirrorHandoffGuardSnapshot;
		try {
			before = owner.cmGuard.snapshot();
		} catch {
			return false;
		}
		if (
			before.inert
			|| before.view !== binding.cm
			|| before.sourceUnloadDrain?.ownerId !== owner.ownerId
			|| before.sourceUnloadDrain.reservation !== reservation
			|| before.targetSelectionFence !== null
		) return false;
		try {
			binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
		} catch {
			return false;
		}
		let syncFacet: unknown = null;
		let after: CodeMirrorHandoffGuardSnapshot;
		try {
			syncFacet = binding.cm.state.facet(ySyncFacet);
			after = owner.cmGuard.snapshot();
		} catch {
			return false;
		}
		const isolationPreconditions = this.managedSessions.get(runtime.session.leafId) === runtime
			&& runtime.sourceUnloadDrain === owner
			&& owner.state === "terminal"
			&& this.bindings.get(runtime.session.leafId) === binding
			&& (this.bindingEpochByLeafId.get(runtime.session.leafId) ?? 0)
				=== owner.sourceBindingEpoch
			&& binding.cm.state.doc === reservation.sourceDocumentAtStart
			&& syncFacet == null
			&& !after.inert
			&& after.sourceUnloadDrain?.ownerId === owner.ownerId
			&& after.sourceUnloadDrain.reservation === reservation
			&& after.targetSelectionFence === null;
		let isolated = false;
		if (isolationPreconditions) {
			try {
				isolated = owner.cmGuard.certifyStructuralSourceDrainEditorOnlyCompletion(
					owner.ownerId,
					reservation,
				);
			} catch {
				isolated = false;
			}
		}
		owner.structuralEditorOnlyCompletion = isolated;
		this.trace?.("editor", isolated
			? "source-unload-drain-structural-editor-only"
			: "source-unload-drain-structural-isolation-failed", {
			leafId: runtime.session.leafId,
			path: owner.sourcePath,
			reason,
		});
		return isolated;
	}

	private retainSourceUnloadDrainAcrossStructuralMutation(
		runtime: ManagedLeafRuntime,
		reason: string,
	): boolean {
		const owner = runtime.sourceUnloadDrain;
		// A fenced owner has no unresolved predecessor input and its native unload
		// promise has already settled, so the existing structural teardown remains
		// safe. Draining and terminal owners still own visible source bytes and can be
		// reclaimed only by exact workspace close or plugin teardown.
		if (owner === null || (owner.state !== "draining" && owner.state !== "terminal")) {
			return false;
		}
		this.clearScheduledHealthCheck(runtime.session.leafId);
		const mayFinishStructurally = owner.reservation !== null;
		this.terminalizeSourceUnloadDrain(runtime, owner, reason, mayFinishStructurally);
		if (owner.reservation !== null) {
			const isolated = owner.structuralEditorOnlyCompletion
				|| this.isolateStructuralSourceDrainEditorOnlyCompletion(runtime, owner, reason);
			if (!isolated) {
				const visible = this.captureStableVisibleManagedContent(runtime);
				if (visible !== null) {
					this.offerTerminalVisibleContentExport(
						runtime,
						visible,
						`source-unload-drain:${reason}:isolation-failed`,
					);
				}
			}
		}
		this.trace?.("editor", "source-unload-drain-structural-owner-retained", {
			leafId: runtime.session.leafId,
			path: owner.sourcePath,
			reason,
		});
		return true;
	}

	private cancelPendingStructuralSourceCloseSettlement(
		leafId: string,
		runtime?: ManagedLeafRuntime,
	): void {
		const pending = this.pendingStructuralSourceCloseSettlements.get(leafId);
		if (!pending || (runtime !== undefined && pending.runtime !== runtime)) return;
		if (pending.timer !== null) clearTimeout(pending.timer);
		this.pendingStructuralSourceCloseSettlements.delete(leafId);
	}

	private structuralSourceCloseRecovery(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
	): Readonly<{ content: string; exact: boolean }> {
		const reservation = owner.reservation;
		let exact: string | null = null;
		if (reservation !== null) {
			try {
				exact = owner.cmGuard.captureStructuralSourceDrainRecoveryContent(
					owner.ownerId,
					reservation,
				);
			} catch {
				exact = null;
			}
		}
		if (exact !== null) return Object.freeze({ content: exact, exact: true });
		const visible = this.captureStableVisibleManagedContent(runtime)
			?? reservation?.sourceDocumentAtStart?.toString()
			?? owner.sourceBinding?.cm.state.doc.toString()
			?? "";
		const artifact = [
			"KAOS structural input recovery artifact",
			"",
			"The already-started input could not be materialized exactly before the pane closed.",
			"No replay or source-file write was attempted. The last verified visible source text follows.",
			"",
			visible,
		].join("\n");
		return Object.freeze({ content: artifact, exact: false });
	}

	private scheduleStructuralSourceCloseSettlement(
		runtime: ManagedLeafRuntime,
		owner: ManagedSourceUnloadDrainOwner,
		reason: string,
	): boolean {
		const leafId = runtime.session.leafId;
		if (
			this.managedSessions.get(leafId) !== runtime
			|| runtime.sourceUnloadDrain !== owner
			|| owner.state !== "terminal"
			|| !owner.structuralEditorOnlyCompletion
			|| owner.reservation === null
		) return false;
		const existing = this.pendingStructuralSourceCloseSettlements.get(leafId);
		if (existing !== undefined) {
			return existing.runtime === runtime && existing.owner === owner;
		}
		const recovery = this.structuralSourceCloseRecovery(runtime, owner);
		const pending: PendingStructuralSourceCloseSettlement = {
			runtime,
			owner,
			reason,
			recoveryContent: recovery.content,
			exactRecovery: recovery.exact,
			timer: null,
			settling: false,
		};
		pending.timer = setTimeout(() => {
			if (this.pendingStructuralSourceCloseSettlements.get(leafId) !== pending) return;
			this.settleStructuralSourceClose(
				pending,
				pending.recoveryContent,
				pending.exactRecovery,
				"bounded-expiry",
			);
		}, STRUCTURAL_SOURCE_CLOSE_SETTLEMENT_MS);
		this.pendingStructuralSourceCloseSettlements.set(leafId, pending);
		this.trace?.("editor", "source-unload-drain-workspace-close-bounded", {
			leafId,
			path: owner.sourcePath,
			reason,
			exactRecovery: recovery.exact,
			settlementMs: STRUCTURAL_SOURCE_CLOSE_SETTLEMENT_MS,
		});
		return true;
	}

	private settleStructuralSourceClose(
		pending: PendingStructuralSourceCloseSettlement,
		content: string,
		exactRecovery: boolean,
		reason: string,
	): void {
		const runtime = pending.runtime;
		const owner = pending.owner;
		const leafId = runtime.session.leafId;
		if (
			pending.settling
			|| this.pendingStructuralSourceCloseSettlements.get(leafId) !== pending
			|| this.managedSessions.get(leafId) !== runtime
			|| runtime.sourceUnloadDrain !== owner
		) return;
		pending.settling = true;
		if (pending.timer !== null) {
			clearTimeout(pending.timer);
			pending.timer = null;
		}
		this.terminalVisibleContentExportByRuntime.set(runtime, content);
		const actionHost = this.handoffRecoveryActionHost;
		void (async () => {
			let exported = false;
			try {
				const exportVerified = await actionHost?.chooseVerifiedExporter() ?? null;
				if (
					exportVerified !== null
					&& this.pendingStructuralSourceCloseSettlements.get(leafId) === pending
					&& this.managedSessions.get(leafId) === runtime
					&& runtime.sourceUnloadDrain === owner
				) {
					await exportVerified(content);
					exported = true;
				}
			} catch {
				exported = false;
			}
			if (
				this.pendingStructuralSourceCloseSettlements.get(leafId) !== pending
				|| this.managedSessions.get(leafId) !== runtime
				|| runtime.sourceUnloadDrain !== owner
			) return;
			if (!exported) {
				pending.settling = false;
				this.terminalVisibleContentExportByRuntime.delete(runtime);
				this.trace?.("editor", "source-unload-drain-workspace-close-export-required", {
					leafId,
					path: owner.sourcePath,
					reason,
					exactRecovery,
					contentHash: sha256HandoffRecoveryHexSync(content),
				});
				try {
					new Notice(
						"The closed pane still owns verified recovery text. Use the command palette action named “retry blocked handoff recovery export” before KAOS can release it.",
						10_000,
					);
				} catch {
					// The exact pending close owner retains the bytes for a later user action.
				}
				return;
			}
			this.trace?.("editor", "source-unload-drain-workspace-close-exported", {
				leafId,
				path: owner.sourcePath,
				reason,
				exactRecovery,
				contentHash: sha256HandoffRecoveryHexSync(content),
			});
			this.pendingStructuralSourceCloseSettlements.delete(leafId);
			this.teardownSourceUnloadDrain(
				runtime,
				`workspace-close-bounded:${reason}`,
			);
			const emergencyReleased = this.releaseEmergencyHostSaveFence(
				runtime,
				`workspace-close-bounded:${reason}`,
				true,
			);
			if (emergencyReleased) {
				runtime.hostGuard?.cancelTerminalHostLifecycle?.(
					`workspace-close-bounded:${reason}`,
				);
				this.tombstoneDetachedTransitionBoundary(
					runtime,
					`workspace-close-bounded:${reason}`,
				);
			}
			this.cancelManagedHandoffAndUnmanage(
				runtime.session.view,
				`workspace-close-bounded:${reason}`,
				"closed",
			);
		})();
	}

	/**
	 * Explicit user action for retrying a cancelled/failed closed-pane export.
	 * Timed first attempts and concurrent exporter prompts are never duplicated.
	 */
	retryPendingStructuralSourceCloseExport(): number {
		for (const [leafId, pending] of this.pendingStructuralSourceCloseSettlements) {
			const runtime = pending.runtime;
			const owner = pending.owner;
			if (
				pending.timer !== null
				|| pending.settling
				|| this.pendingStructuralSourceCloseSettlements.get(leafId) !== pending
				|| runtime.session.leafId !== leafId
				|| this.managedSessions.get(leafId) !== runtime
				|| runtime.sourceUnloadDrain !== owner
				|| owner.state !== "terminal"
				|| !owner.structuralEditorOnlyCompletion
				|| owner.reservation === null
			) continue;
			this.settleStructuralSourceClose(
				pending,
				pending.recoveryContent,
				pending.exactRecovery,
				"explicit-user-retry",
			);
			// One command invocation owns at most one file-picker/modal. Additional
			// pending panes remain ordered in the map for later explicit commands.
			return 1;
		}
		return 0;
	}

	private blocksSourceUnloadBindingReentry(runtime: ManagedLeafRuntime | undefined): boolean {
		const owner = runtime?.sourceUnloadDrain ?? null;
		if (
			!runtime
			|| owner === null
			|| (owner.state !== "draining" && owner.state !== "terminal")
		) return false;
		if (owner.state === "terminal") {
			this.terminalizeSourceUnloadDrain(runtime, owner, "terminal-reentry");
		}
		return true;
	}

	private hasActiveSourceUnloadDrain(runtime: ManagedLeafRuntime | undefined): boolean {
		const state = runtime?.sourceUnloadDrain?.state;
		return state === "draining" || state === "terminal";
	}

	private retainManagedTargetCompletionFence(
		runtime: ManagedLeafRuntime,
		reason: string,
		candidate: PendingHostLoadCandidate | null = null,
	): void {
		const session = runtime.session;
		const handoff = session.handoff;
		const displayed = session.displayedLineage;
		const candidateTargetFile = candidate !== null
			&& candidate.runtimeView === session.view
			&& session.view.file?.path === candidate.targetPathAtDispatch
				? session.view.file
				: null;
		const targetFile = candidateTargetFile
			?? handoff?.targetFile
			?? runtime.transitionInputFence?.targetFile
			?? (displayed.kind === "known" ? displayed.file : null)
			?? null;
		const targetPath = candidate?.targetPathAtDispatch
			?? handoff?.targetPath
			?? runtime.transitionInputFence?.targetPath
			?? (displayed.kind === "known" ? displayed.path : null)
			?? null;
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| targetFile === null
			|| targetPath === null
			|| session.view.file !== targetFile
			|| targetFile.path !== targetPath
		) return;
		if (runtime.transitionInputFence !== null) {
			runtime.transitionInputFence.state = "reopen-required";
		}
		try {
			runtime.hostGuard?.beginBlockingHandoff({
				handoffGeneration: session.generation,
				sourceLineagePath: handoff?.sourceAuthorityPath ?? null,
				targetPath,
			});
		} catch {
			// The emergency owner below remains the independent native-save boundary.
		}
		const saveFenceReady = this.ensureEmergencyHostSaveFence(
			runtime,
			`${reason}:terminal`,
		);
		let inputFenceReady = false;
		try {
			const cmGuard = runtime.cmGuard;
			const targetSelectionToken = runtime.transitionInputFence
				?.targetSelectionToken ?? null;
			const terminalSelectionFenceCurrent = cmGuard !== null
				&& targetSelectionToken !== null
				&& cmGuard.isTargetSelectionFenceCurrent(targetSelectionToken);
			inputFenceReady = cmGuard !== null
				&& (terminalSelectionFenceCurrent || cmGuard.refreshGate())
				&& cmGuard.snapshot().gateClosed;
		} catch {
			inputFenceReady = false;
		}
		this.trace?.("editor", "managed-target-completion-retained", {
			leafId: session.leafId,
			path: targetPath,
			reason,
			saveFenceReady,
			inputFenceReady,
		});
		try {
			new Notice(
				"The selected note is preserved behind a blocked transition boundary. Use the recovery export action if offered, then close and reopen this pane. No automatic replay or rollback was attempted.",
				10_000,
			);
		} catch {
			// The retained managed guards remain authoritative without the warning UI.
		}
	}

	private terminalizeManagedTargetCompletion(
		runtime: ManagedLeafRuntime,
		candidate: PendingHostLoadCandidate,
		reason: string,
		visibleContent: string | null = null,
	): void {
		if (runtime.transitionInputFence !== null) {
			runtime.transitionInputFence.state = "reopen-required";
		}
		this.retainManagedTargetCompletionFence(runtime, reason, candidate);
		const stableContent = visibleContent
			?? this.captureStableVisibleManagedContent(runtime);
		if (
			stableContent !== null
			&& stableContent !== candidate.incomingContent
		) {
			this.offerTerminalVisibleContentExport(runtime, stableContent, reason);
		}
	}

	private installManagedCmGuard(runtime: ManagedLeafRuntime, cm: EditorView): boolean {
		const installed = runtime.cmGuard?.snapshot();
		if (installed?.view === cm && !installed.inert) return true;
		if (installed?.inert) {
			runtime.cmGuard?.restoreIfCurrent();
			runtime.cmGuard = null;
		}
		if (runtime.cmGuard && !runtime.cmGuard.markInert()) {
			this.trace?.("editor", "managed-cm-guard-replacement-deferred", {
				leafId: runtime.session.leafId,
			});
			return false;
		}
		if (runtime.cmGuard) {
			runtime.cmGuard.restoreIfCurrent();
			runtime.cmGuard = null;
		}
		const result = installCodeMirrorHandoffGuard(cm, {
			createId: (prefix) => this.createManagedAuthorityRequestId(prefix),
			getCurrentContext: () => this.getCodeMirrorHandoffContext(runtime.session.leafId),
			reserveManagedLeafInputStart: (input) => {
				const current = this.managedSessions.get(runtime.session.leafId);
				if (!current) return null;
				const reduction = reserveManagedLeafInputStart(current.session, input);
				if (!reduction.accepted || reduction.inputStartSeq === null) return null;
				this.advanceAuthorityEpoch();
				current.session = reduction.state;
				return reduction.state.pendingInputStartReservation;
			},
			onHostLoadCandidate: (candidate) => this.acceptHostLoadCandidate(candidate),
				onHostLoadCompleted: (receipt) =>
					runtime.hostGuard?.reportHostLoadCompleted(receipt) === true,
			isExactHostStateReplacement: (targetState, input) =>
				targetState.doc.toString() === input.incomingContent
					&& runtime.hostGuard?.isExactHostLoadDispatchActive(input) === true,
			isExactHostLoadDispatchActive: (candidate) => {
				const current = this.managedSessions.get(candidate.leafId);
				const handoff = current?.session.handoff;
				if (
					current !== runtime
					|| handoff == null
					|| current.session.sessionId !== candidate.sessionId
					|| current.session.generation !== candidate.handoffGeneration
					|| current.session.currentSwitchIntentSeq !== candidate.switchIntentSeq
					|| handoff.sourceUnloadReceiptId !== candidate.sourceUnloadReceiptId
					|| handoff.targetPath !== candidate.targetPathAtDispatch
					|| candidate.runtimeView !== current.session.view
					|| current.hostGuard == null
				) return false;
				return current.hostGuard.isExactHostLoadDispatchActive({
					hostLoadTokenId: candidate.hostLoadTokenId,
					sessionId: candidate.sessionId,
					leafId: candidate.leafId,
					handoffGeneration: candidate.handoffGeneration,
					switchIntentSeq: candidate.switchIntentSeq,
					sourceUnloadReceiptId: candidate.sourceUnloadReceiptId,
					targetPath: candidate.targetPathAtDispatch,
					targetFile: handoff.targetFile,
					runtimeView: current.session.view as unknown as TextFileView,
					incomingContent: candidate.incomingContent,
				});
			},
				onHostLoadCaptureRejected: (reason) => {
				this.trace?.("editor", "host-clear-load-capture-rejected", {
					leafId: runtime.session.leafId,
					reason,
				});
			},
			onUnresolvedInputTerminal: ({ reservation, reason }) => {
				const current = this.managedSessions.get(runtime.session.leafId);
				const owner = current?.sourceUnloadDrain ?? null;
				if (
					current !== runtime
					|| owner === null
					|| owner.reservation !== reservation
				) return false;
				this.terminalizeSourceUnloadDrain(runtime, owner, reason);
				return true;
			},
			onSamePathInputCompleted: (completion) =>
				this.acceptSamePathInputCompletion(runtime, completion),
			onSamePathInputRejected: (rejection) =>
				this.acceptSamePathInputRejection(runtime, rejection),
			onNativeHistoryAdvanced: (advance) =>
				this.acceptStableNativeHistoryAdvance(advance),
			onCompositionBoundary: (phase) => {
				const current = this.managedSessions.get(runtime.session.leafId);
				if (current !== runtime) return;
				if (
					phase === "start"
					&& (
						current.adoption.kind === "capturing"
						|| current.adoption.kind === "planning"
					)
				) {
					const guard = current.cmGuard?.snapshot() ?? null;
					current.adoption = Object.freeze({
						...current.adoption,
						kind: "capturing",
						requestId: null,
						proposal: null,
						latestEditorRevision:
							this.editorRevisionByCm.get(current.adoption.cm) ?? 0,
						editorTransactionSeq:
							this.samePathAdoptionTransactionSeqByCm.get(
								current.adoption.cm,
							) ?? 0,
						compositionEpoch:
							guard?.compositionEpoch ?? current.adoption.compositionEpoch,
						activeCompositionEpoch:
							guard?.activeComposition?.compositionEpoch ?? null,
					});
					this.advanceAuthorityEpoch();
				}
				if (phase === "end") {
					if (
						current.adoption.kind === "capturing"
						|| current.adoption.kind === "planning"
					) {
						current.adoption = NO_SAME_PATH_ADOPTION;
						this.advanceAuthorityEpoch();
					}
					if (
						current.sourceUnloadDrain?.state === "terminal"
						&& current.sourceUnloadDrain.structuralEditorOnlyCompletion
					) {
						// Structural completion has no same-path target left to adopt. A
						// composition-end refresh would treat the deliberate target-less
						// quarantine as ordinary context loss and release its save owner.
						return;
					}
					this.scheduleSamePathAdoptionRefresh(current, "composition-end");
				}
			},
			isNativeHistoryReset: (transaction) => {
				const direct = transaction.annotation(Transaction.addToHistory) === false;
				if (!direct) {
					const annotations = (
						transaction as Transaction & Readonly<{
							annotations?: readonly Readonly<{ value?: unknown }>[];
						}>
					).annotations;
					this.trace?.("editor", "native-history-reset-unrecognized", {
						leafId: runtime.session.leafId,
						annotationCount: annotations?.length ?? -1,
						falseAnnotationCount:
							annotations?.filter((annotation) => annotation.value === false).length ?? -1,
						effectCount: transaction.effects.length,
					});
				}
				return direct;
			},
			observeNativeHistoryReset: (_view, transaction) => {
				if (transaction.annotation(Transaction.addToHistory) !== false) return false;
				const current = this.managedSessions.get(runtime.session.leafId);
				return !!current
					&& current === runtime
					&& current.session.sessionId === runtime.session.sessionId
					&& current.session.generation === runtime.session.generation;
			},
		});
		if (result.kind === "installed") {
			this.advanceAuthorityEpoch();
			runtime.cmGuard = result.guard;
			return !result.guard.snapshot().inert;
		} else {
			this.trace?.("editor", "managed-cm-guard-unsupported", {
				leafId: runtime.session.leafId,
				reason: result.reason,
			});
			return false;
		}
	}

	private getCodeMirrorHandoffContext(leafId: string): CodeMirrorHandoffContext | null {
		const runtime = this.managedSessions.get(leafId);
		const session = runtime?.session;
		if (!runtime || !session) return null;
		if (runtime.emergencySaveFence !== null) {
			try {
				if (!runtime.emergencySaveFence.isCurrent()) return null;
			} catch {
				return null;
			}
		}
		if (session.handoff) {
			const currentCm = this.getCmView(session.view);
			if (
				currentCm === null
				|| session.view.file !== session.handoff.targetFile
				|| session.handoff.targetFile.path !== session.handoff.targetPath
			) return null;
			return {
				kind: "handoff",
				sessionId: session.sessionId,
				leafId: session.leafId,
				handoffGeneration: session.generation,
				switchIntentSeq: session.currentSwitchIntentSeq ?? -1,
				sourceUnloadReceiptId: session.handoff.sourceUnloadReceiptId ?? "",
				fromPath: session.handoff.sourceAuthorityPath,
				fromFileId: session.displayedLineage.kind === "known"
					? session.displayedLineage.fileId
					: null,
				targetPath: session.handoff.targetPath,
				targetFile: session.handoff.targetFile,
				runtimeView: session.view as unknown as TextFileView,
				bindingEpoch: session.handoff.bindingEpochAfterDetach,
				editorRevisionBefore: this.editorRevisionByCm.get(currentCm) ?? 0,
				inputPolicy: "reject-before-target",
			};
		}
		if (session.displayedLineage.kind !== "known") return null;
		if (
			session.view.file !== session.displayedLineage.file
			|| session.displayedLineage.file.path !== session.displayedLineage.path
		) return null;
		return {
			kind: "same-path",
			sessionId: session.sessionId,
			leafId: session.leafId,
			handoffGeneration: session.generation,
			path: session.displayedLineage.path,
		};
	}

	private isManagedSessionCurrent(sessionId: string, generation: number): boolean {
		if (!this.asyncAuthorityOpen) return false;
		for (const runtime of this.managedSessions.values()) {
			if (runtime.session.sessionId !== sessionId) continue;
			return runtime.session.generation === generation;
		}
		return false;
	}

	private captureManagedContinuation(view: MarkdownView): ManagedContinuationTicket | null {
		const targetFile = view.file;
		const session = this.getManagedSession(view);
		if (!targetFile || !session) return null;
		return Object.freeze({
			bootSessionId: this.bootSessionId,
			sessionId: session.sessionId,
			handoffGeneration: session.generation,
			view,
			targetFile,
			targetPath: targetFile.path,
			cm: this.getCmView(view),
			bindingEpoch: this.bindingEpochByLeafId.get(session.leafId) ?? 0,
		});
	}

	/**
	 * Capture a continuation from an already-proven binding without consulting
	 * the host editor facade again. External-host projection and provenance
	 * filters can run while Obsidian's public editor cache is intentionally one
	 * projection behind CodeMirror; the binding/session/TFile identities are the
	 * authority fence for those lanes.
	 */
	private captureManagedBindingContinuation(
		binding: EditorBinding,
	): ManagedContinuationTicket | null {
		const leafId = this.getLeafId(binding.view);
		const runtime = this.managedSessions.get(leafId);
		const session = runtime?.session;
		const displayed = session?.displayedLineage;
		if (
			!runtime
			|| !session
			|| session.view !== binding.view
			|| session.handoff !== null
			|| displayed?.kind !== "known"
			|| displayed.file !== binding.file
			|| displayed.path !== binding.path
			|| displayed.cm !== binding.cm
			|| session.binding.kind !== "bound"
			|| session.binding.path !== binding.path
			|| session.binding.ytext !== binding.ytext
			|| this.bindings.get(leafId) !== binding
			|| binding.view.file !== binding.file
			|| binding.file.path !== binding.path
		) return null;
		return Object.freeze({
			bootSessionId: this.bootSessionId,
			sessionId: session.sessionId,
			handoffGeneration: session.generation,
			view: binding.view,
			targetFile: binding.file,
			targetPath: binding.path,
			cm: binding.cm,
			bindingEpoch: this.bindingEpochByLeafId.get(leafId) ?? 0,
		});
	}

	private isManagedBindingContinuationCurrent(
		ticket: ManagedContinuationTicket,
		binding: EditorBinding,
	): boolean {
		if (ticket.bootSessionId !== this.bootSessionId) return false;
		const leafId = this.getLeafId(binding.view);
		const runtime = this.managedSessions.get(leafId);
		const session = runtime?.session;
		const displayed = session?.displayedLineage;
		return !!runtime
			&& !!session
			&& session.view === ticket.view
			&& session.view === binding.view
			&& session.sessionId === ticket.sessionId
			&& session.generation === ticket.handoffGeneration
			&& session.handoff === null
			&& displayed?.kind === "known"
			&& displayed.file === binding.file
			&& displayed.path === binding.path
			&& displayed.cm === binding.cm
			&& session.binding.kind === "bound"
			&& session.binding.path === binding.path
			&& session.binding.ytext === binding.ytext
			&& this.bindings.get(leafId) === binding
			&& ticket.view === binding.view
			&& ticket.targetFile === binding.file
			&& ticket.targetPath === binding.path
			&& ticket.cm === binding.cm
			&& binding.view.file === binding.file
			&& binding.file.path === binding.path
			&& (this.bindingEpochByLeafId.get(leafId) ?? 0) === ticket.bindingEpoch;
	}

	private isManagedContinuationCurrent(
		ticket: ManagedContinuationTicket,
		options: Readonly<{ allowCmResolution?: boolean }> = {},
	): boolean {
		if (ticket.bootSessionId !== this.bootSessionId) return false;
		const session = this.getManagedSession(ticket.view);
		if (
			!session
			|| session.sessionId !== ticket.sessionId
			|| session.generation !== ticket.handoffGeneration
			|| ticket.view.file !== ticket.targetFile
			|| ticket.targetFile.path !== ticket.targetPath
		) return false;
		const currentCm = this.getCmView(ticket.view);
		if (
			!(options.allowCmResolution === true && ticket.cm === null)
			&& currentCm !== ticket.cm
		) return false;
		const finalRuntime = this.managedSessions.get(session.leafId);
		return !!finalRuntime
			&& finalRuntime.session.view === ticket.view
			&& finalRuntime.session.sessionId === ticket.sessionId
			&& finalRuntime.session.generation === ticket.handoffGeneration
			&& ticket.view.file === ticket.targetFile
			&& ticket.targetFile.path === ticket.targetPath
			&& (this.bindingEpochByLeafId.get(session.leafId) ?? 0) === ticket.bindingEpoch;
	}

	private acceptSamePathInputCompletion(
		runtime: ManagedLeafRuntime,
		completion: Readonly<{
			reservation: ManagedLeafInputStartReservation;
			cm: EditorView;
			startDocument: Text;
			finalDocument: Text;
			samePathDispatch?: Readonly<{
				batchStartDocument: Text;
				nativeHistoryEpochBefore: number;
				nativeHistoryEpochAfter: number;
			}>;
		}>,
	): boolean {
		const current = this.managedSessions.get(runtime.session.leafId);
		if (current !== runtime || !this.asyncAuthorityOpen) return false;
		const structuralOwner = current.sourceUnloadDrain;
		const completesStructuralEditorOnly = structuralOwner !== null
			&& structuralOwner.state === "terminal"
			&& structuralOwner.structuralEditorOnlyCompletion
			&& structuralOwner.reservation === completion.reservation;
		const editorRevision = this.editorRevisionByCm.get(completion.cm) ?? 0;
		const reduction = reduceManagedLeafSession(current.session, {
			type: "same-path-input-completed",
			sessionId: current.session.sessionId,
			expectedGeneration: current.session.generation,
			...completion,
			editorRevision,
		});
		if (!reduction.accepted) return false;
		this.advanceAuthorityEpoch();
		current.session = reduction.state;
		this.queueSourceUnloadDrainSettlement(
			current,
			completion.reservation,
			"completed",
		);
		this.queueObservedFileMismatchTerminalAfterInputSettlement(
			current,
			"same-path-input-completed",
		);
		if (completesStructuralEditorOnly && structuralOwner !== null) {
			queueMicrotask(() => {
				if (
					this.managedSessions.get(current.session.leafId) !== current
					|| current.sourceUnloadDrain !== structuralOwner
					|| structuralOwner.state !== "terminal"
				) return;
				structuralOwner.structuralEditorOnlyCompletion = false;
				this.terminalizeSourceUnloadDrain(
					current,
					structuralOwner,
					"structural-editor-only-input-completed",
				);
			});
		}
		return true;
	}

	private acceptSamePathInputRejection(
		runtime: ManagedLeafRuntime,
		rejection:
			| Readonly<{
				reservation: ManagedLeafInputStartReservation;
				cm: EditorView;
				startDocument: Text;
				reason: "cancelled";
			}>
			| Readonly<{
				reservation: ManagedLeafInputStartReservation;
				cm: EditorView;
				startDocument: Text;
				finalDocument: Text;
				reason: "input-result-ambiguous";
				samePathDispatch: Readonly<{
					batchStartDocument: Text;
					nativeHistoryEpochBefore: number;
					nativeHistoryEpochAfter: number;
				}>;
			}>,
	): boolean {
		const current = this.managedSessions.get(runtime.session.leafId);
		if (current !== runtime || !this.asyncAuthorityOpen) return false;
		const structuralOwner = current.sourceUnloadDrain;
		const rejectsStructuralEditorOnly = structuralOwner !== null
			&& structuralOwner.state === "terminal"
			&& structuralOwner.structuralEditorOnlyCompletion
			&& structuralOwner.reservation === rejection.reservation;
		const reduction = rejection.reason === "input-result-ambiguous"
			? reduceManagedLeafSession(current.session, {
				type: "same-path-input-rejected",
				sessionId: current.session.sessionId,
				expectedGeneration: current.session.generation,
				...rejection,
				editorRevision: this.editorRevisionByCm.get(rejection.cm) ?? 0,
			})
			: reduceManagedLeafSession(current.session, {
				type: "same-path-input-rejected",
				sessionId: current.session.sessionId,
				expectedGeneration: current.session.generation,
				...rejection,
			});
		if (!reduction.accepted) return false;
		this.advanceAuthorityEpoch();
		current.session = reduction.state;
		this.queueSourceUnloadDrainSettlement(
			current,
			rejection.reservation,
			rejection.reason === "cancelled" ? "cancelled" : "ambiguous",
		);
		const committedSession = current.session;
		queueMicrotask(() => {
			try {
				this.trace?.("editor", "same-path-input-rejected", {
					leafId: committedSession.leafId,
					path: committedSession.displayedLineage.kind === "known"
						? committedSession.displayedLineage.path
						: null,
					reason: rejection.reason,
				});
			} catch {
				// Diagnostics cannot split the reducer and guard acknowledgement.
			}
			if (rejection.reason === "input-result-ambiguous") {
				try {
					new Notice(
						"The previous note changed while input was being resolved. Nothing was replayed; export if needed, then reopen this pane.",
						8000,
					);
				} catch {
					// UI feedback is best-effort after the terminal reducer commit.
				}
			}
		});
		this.queueObservedFileMismatchTerminalAfterInputSettlement(
			current,
			`same-path-input-rejected:${rejection.reason}`,
		);
		if (rejectsStructuralEditorOnly && structuralOwner !== null) {
			queueMicrotask(() => {
				if (
					this.managedSessions.get(current.session.leafId) !== current
					|| current.sourceUnloadDrain !== structuralOwner
					|| structuralOwner.state !== "terminal"
				) return;
				structuralOwner.structuralEditorOnlyCompletion = false;
				this.terminalizeSourceUnloadDrain(
					current,
					structuralOwner,
					`structural-editor-only-input-${rejection.reason}`,
				);
			});
		}
		return true;
	}

	private queueObservedFileMismatchTerminalAfterInputSettlement(
		runtime: ManagedLeafRuntime,
		reason: string,
	): void {
		if (!this.observedFileMismatchTerminalByRuntime.has(runtime)) return;
		queueMicrotask(() => {
			const current = this.managedSessions.get(runtime.session.leafId);
			const targetFile = current?.session.view.file ?? null;
			if (
				!this.asyncAuthorityOpen
				|| current !== runtime
				|| targetFile === null
			) return;
			this.enterObservedFileMismatchTerminal(runtime, targetFile, reason);
		});
	}
	private acceptStableNativeHistoryAdvance(input: Readonly<{
		cm: EditorView;
		startState: EditorState;
		finalState: EditorState;
		nativeHistoryEpochBefore: number;
		nativeHistoryEpochAfter: number;
	}>): boolean {
		if (
			!this.asyncAuthorityOpen
			|| !Number.isSafeInteger(input.nativeHistoryEpochBefore)
			|| !Number.isSafeInteger(input.nativeHistoryEpochAfter)
			|| input.nativeHistoryEpochBefore < 0
			|| input.nativeHistoryEpochAfter <= input.nativeHistoryEpochBefore
			|| input.startState === input.finalState
			|| input.finalState !== input.cm.state
		) return false;
		const leafId = this.cmToLeafId.get(input.cm);
		const runtime = leafId ? this.managedSessions.get(leafId) : undefined;
		const session = runtime?.session;
		const displayed = session?.displayedLineage;
		const guard = runtime?.cmGuard?.snapshot() ?? null;
		if (
			!leafId
			|| !runtime
			|| !session
			|| session.leafId !== leafId
			|| session.handoff !== null
			|| session.nativeHistoryEpoch !== input.nativeHistoryEpochBefore
			|| displayed?.kind !== "known"
			|| displayed.cm !== input.cm
			|| displayed.document !== input.finalState.doc
			|| displayed.editorRevision
				!== (this.editorRevisionByCm.get(input.cm) ?? 0)
			|| session.view.file !== displayed.file
			|| displayed.file.path !== displayed.path
			|| this.getCmView(session.view) !== input.cm
			|| guard === null
			|| guard.view !== input.cm
			|| guard.inert
			|| guard.nativeHistoryEpoch !== input.nativeHistoryEpochAfter
		) return false;
		this.advanceAuthorityEpoch();
		runtime.session = {
			...session,
			nativeHistoryEpoch: input.nativeHistoryEpochAfter,
		};
		return true;
	}

	private reduceCertifiedHostPreclearCandidate(
		runtime: ManagedLeafRuntime,
		candidate: PendingHostLoadCandidate,
	): ReturnType<typeof reduceManagedLeafSession> | null {
		const session = runtime.session;
		const handoff = session.handoff;
		const displayed = session.displayedLineage;
		const completion = session.completedSamePathInput;
		const cmSnapshot = runtime.cmGuard?.snapshot() ?? null;
		const sourceUnload = runtime.hostGuard?.snapshot().sourceUnload ?? null;
		const liveRuntimeData = (
			candidate.runtimeView as TextFileView & Readonly<{ data?: unknown }>
		).data;
		if (
			handoff === null
			|| displayed.kind !== "known"
			|| completion === null
			|| candidate.applicationKind !== "state"
			|| candidate.cm !== displayed.cm
			|| candidate.cm !== completion.cm
			|| cmSnapshot?.view !== candidate.cm
			|| cmSnapshot.inert
			|| cmSnapshot.nativeHistoryEpoch !== candidate.nativeHistoryEpochBefore
			|| candidate.startDocument !== candidate.cm.state.doc
			|| candidate.startDocument.length !== 0
			|| candidate.editorRevisionBefore !== completion.editorRevision
			|| (this.editorRevisionByCm.get(candidate.cm) ?? 0)
				!== completion.editorRevision
			|| liveRuntimeData !== candidate.runtimeViewDataBefore
			|| session.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
			|| sourceUnload === null
			|| sourceUnload.receiptId !== handoff.sourceUnloadReceiptId
			|| sourceUnload.file !== completion.file
			|| sourceUnload.path !== completion.path
			|| sourceUnload.state !== "settled"
			|| sourceUnload.forcedSaveObserved !== true
		) return null;
		return reduceManagedLeafSession(session, {
			type: "host-preclear-candidate-held",
			sessionId: candidate.sessionId,
			expectedGeneration: candidate.handoffGeneration,
			candidate,
			completion,
			observedNativeHistoryEpoch: cmSnapshot.nativeHistoryEpoch,
			sourceUnload: {
				receiptId: sourceUnload.receiptId,
				file: sourceUnload.file,
				path: sourceUnload.path,
				state: "settled",
				forcedSaveObserved: true,
			},
		});
	}

	private acceptHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean {
		const runtime = this.managedSessions.get(candidate.leafId);
		if (!runtime || !this.asyncAuthorityOpen) return false;
		let reduction = reduceManagedLeafSession(runtime.session, {
			type: "host-candidate-held",
			sessionId: candidate.sessionId,
			expectedGeneration: candidate.handoffGeneration,
			candidate,
		});
		let effectReason = "host-candidate-held";
		if (!reduction.accepted) {
			const preclear = this.reduceCertifiedHostPreclearCandidate(runtime, candidate);
			if (preclear !== null) {
				reduction = preclear;
				effectReason = "host-preclear-candidate-held";
			}
		}
		if (!reduction.accepted) return false;
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		if (runtime.hostGuard?.reportHostLoadCandidate(candidate) !== true) {
			this.trace?.("editor", "host-load-candidate-association-failed", {
				leafId: candidate.leafId,
				generation: candidate.handoffGeneration,
				targetPath: candidate.targetPathAtDispatch,
			});
			return false;
		}
		this.applyHandoffEffects(runtime, reduction.effects, effectReason);
		return true;
	}

	private presentLocalTargetOnce(runtime: ManagedLeafRuntime): void {
		const session = runtime.session;
		const handoff = session.handoff;
		const candidate = handoff?.pendingHostLoadCandidate ?? null;
		const guard = runtime.cmGuard;
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(session.leafId) !== runtime
			|| handoff === null
			|| candidate === null
			|| guard === null
			|| handoff.presentation !== "target-candidate"
			|| session.currentSwitchIntentSeq === null
			|| session.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
		) return;

		if (!guard.refreshGate()) {
			this.handleFailedTargetPresentation(
				runtime,
				candidate,
				"local-input-boundary-refresh-rejected",
			);
			return;
		}

		const refreshedSession = runtime.session;
		const refreshedHandoff = refreshedSession.handoff;
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| refreshedSession.sessionId !== session.sessionId
			|| refreshedSession.generation !== session.generation
			|| refreshedHandoff === null
			|| refreshedHandoff.pendingHostLoadCandidate !== candidate
			|| refreshedHandoff.presentation !== "target-candidate"
			|| refreshedSession.view.file !== refreshedHandoff.targetFile
			|| refreshedHandoff.targetFile.path !== refreshedHandoff.targetPath
		) return;

		let snapshot: CodeMirrorHandoffGuardSnapshot;
		try {
			snapshot = guard.snapshot();
		} catch {
			this.handleFailedTargetPresentation(
				runtime,
				candidate,
				"local-input-boundary-snapshot-rejected",
			);
			return;
		}
		if (
			runtime.cmGuard !== guard
			|| snapshot.inert
			|| snapshot.view !== candidate.cm
			|| this.getCmView(refreshedSession.view) !== candidate.cm
		) {
			this.handleFailedTargetPresentation(
				runtime,
				candidate,
				"local-provider-boundary-stale",
			);
			return;
		}
		if (
			snapshot.activeComposition !== null
			|| refreshedSession.pendingInputStartReservation !== null
		) {
			this.handleFailedTargetPresentation(
				runtime,
				candidate,
				"local-input-boundary-active",
			);
			return;
		}
		let localPresentationId = this.localTargetPresentationIdByCandidate.get(candidate);
		if (localPresentationId === undefined) {
			localPresentationId = this.createManagedAuthorityRequestId(
				"local-target-presentation",
			);
			this.localTargetPresentationIdByCandidate.set(candidate, localPresentationId);
		}
		const result = guard.presentHeldHostLoadLocally({
			candidate,
			localPresentationId,
		});
		this.trace?.("editor", "local-target-presentation-attempted", {
			leafId: refreshedSession.leafId,
			path: refreshedHandoff.targetPath,
			kind: result.kind,
			reason: result.kind === "rejected"
				? result.reason
				: result.kind === "pending-notification"
					? result.notification
					: null,
		});
		if (result.kind === "accepted" || result.kind === "pending-notification") return;
		this.handleFailedTargetPresentation(
			runtime,
			candidate,
			`local-host-load-${result.reason}`,
		);
	}

	private captureStableVisibleManagedContent(
		runtime: ManagedLeafRuntime,
	): string | null {
		const read = () => {
			const session = runtime.session;
			const cm = this.getCmView(session.view);
			if (cm === null) return null;
			const state = cm.state;
			const document = state.doc;
			const editor = session.view.editor;
			// eslint-disable-next-line @typescript-eslint/unbound-method
			const editorGetValue = editor.getValue;
			const hostView = session.view as unknown as TextFileView;
			// eslint-disable-next-line @typescript-eslint/unbound-method
			const getViewData = hostView.getViewData;
			let editorContent: string;
			let hostContent: string;
			let rawData: unknown;
			try {
				editorContent = Reflect.apply(editorGetValue, editor, []);
				hostContent = Reflect.apply(getViewData, hostView, []);
				rawData = (hostView as TextFileView & Readonly<{ data?: unknown }>).data;
			} catch {
				return null;
			}
			if (
				this.managedSessions.get(session.leafId) !== runtime
				|| runtime.session !== session
				|| this.getCmView(session.view) !== cm
				|| cm.state !== state
				|| state.doc !== document
				|| session.view.editor !== editor
				|| editor.getValue !== editorGetValue
				|| hostView.getViewData !== getViewData
			) return null;
			const content = document.toString();
			return content === editorContent
				&& content === hostContent
				&& content === rawData
					? { session, cm, state, document, editor, editorGetValue, getViewData, content }
					: null;
		};
		const first = read();
		const second = read();
		return first !== null
			&& second !== null
			&& first.session === second.session
			&& first.cm === second.cm
			&& first.state === second.state
			&& first.document === second.document
			&& first.editor === second.editor
			&& first.editorGetValue === second.editorGetValue
			&& first.getViewData === second.getViewData
			&& first.content === second.content
				? second.content
				: null;
	}

	private offerTerminalVisibleContentExport(
		runtime: ManagedLeafRuntime,
		content: string,
		reason: string,
	): void {
		const leafId = runtime.session.leafId;
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(leafId) !== runtime
		) return;
		if (this.terminalVisibleContentExportByRuntime.get(runtime) === content) return;
		this.terminalVisibleContentExportByRuntime.set(runtime, content);
		this.trace?.("editor", "terminal-visible-content-export-offered", {
			leafId,
			reason,
		});
		const actionHost = this.handoffRecoveryActionHost;
		if (!actionHost) {
			try {
				new Notice(
					"The pane is blocked with unsaved switch-time text, but the recovery export action is unavailable. Keep the pane open and restore KAOS recovery controls before closing it.",
					10_000,
				);
			} catch {
				// The retained input/save owners remain authoritative.
			}
			return;
		}
		try {
			new Notice(
				"The pane is blocked with unsaved switch-time text. Complete the recovery export prompt before reopening it.",
				10_000,
			);
		} catch {
			// The global exporter remains usable without a Notice.
		}
		void actionHost.chooseVerifiedExporter().then(async (exportVerified) => {
			if (
				!this.asyncAuthorityOpen
				|| this.managedSessions.get(leafId) !== runtime
				|| this.handoffRecoveryActionHost !== actionHost
				|| this.terminalVisibleContentExportByRuntime.get(runtime) !== content
			) return;
			if (exportVerified === null) {
				if (this.terminalVisibleContentExportByRuntime.get(runtime) === content) {
					this.terminalVisibleContentExportByRuntime.delete(runtime);
				}
				try {
					new Notice(
						"Export was cancelled. The pane remains blocked; use the recovery export action again before closing it.",
						10_000,
					);
				} catch {
					// The retained owner keeps the bytes stable for a later export action.
				}
				return;
			}
			await exportVerified(content);
			if (
				!this.asyncAuthorityOpen
				|| this.managedSessions.get(leafId) !== runtime
				|| this.handoffRecoveryActionHost !== actionHost
			) return;
			try {
				new Notice(
					"A verified export of the blocked pane text was saved. You can now close and reopen the pane.",
					10_000,
				);
			} catch {
				// The verified external artifact is authoritative.
			}
		}).catch(() => {
			if (this.terminalVisibleContentExportByRuntime.get(runtime) === content) {
				this.terminalVisibleContentExportByRuntime.delete(runtime);
			}
			this.trace?.("editor", "terminal-visible-content-export-failed", {
				leafId,
				reason,
			});
			try {
				new Notice(
					"The verified export failed. The pane remains blocked; restore the recovery controls and try the export again before closing it.",
					10_000,
				);
			} catch {
				// The retained owner preserves the content independently of the warning.
			}
		});
	}

	private classifyFailedTargetSurface(
		runtime: ManagedLeafRuntime,
		candidate: PendingHostLoadCandidate,
	): Readonly<{
		kind:
			| "exact-target"
			| "exact-target-pending"
			| "exact-source"
			| "mixed-or-unknown";
		visibleContent: string | null;
	}> {
		const session = runtime.session;
		const handoff = session.handoff;
		const guard = runtime.cmGuard;
		const hostGuard = runtime.hostGuard;
		const fence = runtime.transitionInputFence;
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| handoff?.pendingHostLoadCandidate !== candidate
			|| session.view !== candidate.runtimeView
			|| session.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== candidate.targetPathAtDispatch
			|| this.getCmView(session.view) !== candidate.cm
			|| guard === null
			|| hostGuard === null
			|| fence === null
			|| fence.targetFile !== handoff.targetFile
			|| fence.targetPath !== handoff.targetPath
			|| !this.isTransitionContainerOwned(fence)
		) return { kind: "mixed-or-unknown", visibleContent: null };
		const read = () => {
			const state = candidate.cm.state;
			const document = state.doc;
			const editor = session.view.editor;
			// eslint-disable-next-line @typescript-eslint/unbound-method
			const editorGetValue = editor.getValue;
			// eslint-disable-next-line @typescript-eslint/unbound-method
			const getViewData = candidate.runtimeView.getViewData;
			let editorContent: string;
			let hostContent: string;
			let dataContent: unknown;
			let cmSnapshot: CodeMirrorHandoffGuardSnapshot;
			let hostSnapshot: ManagedViewSaveGuard;
			let emergencyCurrent = false;
			let targetPresentationReady = false;
			try {
				editorContent = Reflect.apply(editorGetValue, editor, []);
				hostContent = Reflect.apply(getViewData, candidate.runtimeView, []);
				dataContent = (candidate.runtimeView as TextFileView & Readonly<{
					data?: unknown;
				}>).data;
				cmSnapshot = guard.snapshot();
				hostSnapshot = hostGuard.snapshot();
				emergencyCurrent = runtime.emergencySaveFence?.isCurrent() === true;
				targetPresentationReady = hostGuard.isTargetPresentationReady({
					handoffGeneration: candidate.handoffGeneration,
					targetFile: handoff.targetFile,
					certifiedContent: candidate.incomingContent,
				});
			} catch {
				return null;
			}
			if (
				this.managedSessions.get(session.leafId) !== runtime
				|| runtime.session !== session
				|| runtime.cmGuard !== guard
				|| runtime.hostGuard !== hostGuard
				|| runtime.transitionInputFence !== fence
				|| this.getCmView(session.view) !== candidate.cm
				|| candidate.cm.state !== state
				|| state.doc !== document
				|| session.view.editor !== editor
				|| editor.getValue !== editorGetValue
				|| candidate.runtimeView.getViewData !== getViewData
				|| cmSnapshot.view !== candidate.cm
				|| cmSnapshot.inert
				|| !cmSnapshot.gateClosed
				|| cmSnapshot.commitState !== "failed"
				|| !hasExactHostGuardWrappers(hostSnapshot)
				|| !hasNoPendingHostLoadOwner(hostSnapshot)
				|| !hostSnapshot.emergencySaveBlocked
				|| !emergencyCurrent
			) return null;
			return {
				state,
				document,
				editor,
				editorGetValue,
				getViewData,
				documentContent: document.toString(),
				editorContent,
				hostContent,
				dataContent,
				targetPresentationReady,
				cmSnapshot,
				hostSnapshot,
			};
		};
		const first = read();
		const second = read();
		if (
			first === null
			|| second === null
			|| first.state !== second.state
			|| first.document !== second.document
			|| first.editor !== second.editor
			|| first.editorGetValue !== second.editorGetValue
			|| first.getViewData !== second.getViewData
			|| first.documentContent !== second.documentContent
			|| first.editorContent !== second.editorContent
			|| first.hostContent !== second.hostContent
			|| first.dataContent !== second.dataContent
			|| first.targetPresentationReady !== second.targetPresentationReady
			|| !sameCodeMirrorGuardSnapshot(first.cmSnapshot, second.cmSnapshot)
			|| !sameHostGuardSnapshot(first.hostSnapshot, second.hostSnapshot)
		) return { kind: "mixed-or-unknown", visibleContent: null };
		const exactTarget = second.documentContent === candidate.incomingContent
			&& second.editorContent === candidate.incomingContent
			&& second.hostContent === candidate.incomingContent
			&& second.dataContent === candidate.incomingContent;
		if (exactTarget) {
			return {
				kind: second.targetPresentationReady
					? "exact-target"
					: "exact-target-pending",
				visibleContent: candidate.incomingContent,
			};
		}
		const sourceContent = candidate.startDocument.toString();
		const exactSource = second.documentContent === sourceContent
			&& second.editorContent === sourceContent
			&& second.hostContent === candidate.runtimeViewDataBefore
			&& second.dataContent === candidate.runtimeViewDataBefore;
		return exactSource
			? { kind: "exact-source", visibleContent: sourceContent }
			: {
				kind: "mixed-or-unknown",
				visibleContent: second.documentContent === second.editorContent
					? second.documentContent
					: null,
			};
	}

	private handleFailedTargetPresentation(
		runtime: ManagedLeafRuntime,
		candidate: PendingHostLoadCandidate,
		reason: string,
	): void {
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(runtime.session.leafId) !== runtime
			|| runtime.session.handoff?.pendingHostLoadCandidate !== candidate
		) return;
		this.ensureEmergencyHostSaveFence(runtime, `failed-target:${reason}`);
		const surface = this.classifyFailedTargetSurface(runtime, candidate);
		this.terminalizeManagedTargetCompletion(
			runtime,
			candidate,
			`failed-target-${surface.kind}:${reason}`,
			surface.visibleContent,
		);
	}

	private handleLocalTargetPresentationCompletion(
		runtime: ManagedLeafRuntime,
		receipt: HostLoadCompletionReceipt,
	): void {
		const sourceSession = runtime.session;
		const handoff = sourceSession.handoff;
		const candidate = handoff?.pendingHostLoadCandidate ?? null;
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(sourceSession.leafId) !== runtime
			|| handoff === null
			|| candidate === null
			|| handoff.presentation !== "target-candidate"
			|| sourceSession.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
			|| !this.isHostLoadCompletionCurrent(receipt)
			|| receipt.targetPath !== handoff.targetPath
		) return;
		if (!this.advanceSettledHostStateRevision(candidate)) {
			this.trace?.("editor", "local-target-presentation-revision-rejected", {
				leafId: sourceSession.leafId,
				path: handoff.targetPath,
			});
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-state-revision-rejected",
			);
			return;
		}
		const targetText = this.vaultSync.getTextForPath(handoff.targetPath);
		const pathFileId = this.vaultSync.getFileId(handoff.targetPath) ?? null;
		const textFileId = targetText === null
			? null
			: this.vaultSync.getFileIdForText(targetText) ?? null;
		const targetFileId = targetText === null
			? pathFileId
			: pathFileId !== null && pathFileId === textFileId
				? pathFileId
				: null;
		const reduction = reduceManagedLeafSession(sourceSession, {
			type: "target-locally-presented",
			sessionId: sourceSession.sessionId,
			expectedGeneration: sourceSession.generation,
			receipt,
			targetFileId,
		});
		if (!reduction.accepted) {
			this.trace?.("editor", "local-target-presentation-reducer-rejected", {
				leafId: sourceSession.leafId,
				path: handoff.targetPath,
			});
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-reducer-rejected",
			);
			return;
		}
		if (
			this.managedSessions.get(sourceSession.leafId) !== runtime
			|| runtime.session !== sourceSession
			|| sourceSession.handoff?.pendingHostLoadCandidate !== candidate
			|| sourceSession.view.file !== handoff.targetFile
			|| handoff.targetFile.path !== handoff.targetPath
			|| this.getCmView(sourceSession.view) !== candidate.cm
			|| candidate.cm.state.doc.toString() !== candidate.incomingContent
		) {
			if (this.managedSessions.get(sourceSession.leafId) === runtime) {
				this.terminalizeManagedTargetCompletion(
					runtime,
					candidate,
					"local-target-pre-mark-cas-drift",
				);
			}
			return;
		}
		const mappedLeafId = this.cmToLeafId.get(candidate.cm);
		if (mappedLeafId !== undefined && mappedLeafId !== sourceSession.leafId) {
			this.trace?.("editor", "local-target-presentation-cm-owned-elsewhere", {
				leafId: sourceSession.leafId,
				path: handoff.targetPath,
				mappedLeafId,
			});
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-cm-owned-elsewhere",
			);
			return;
		}
		const hostGuard = runtime.hostGuard;
		const cmGuard = runtime.cmGuard;
		const emergencyFence = runtime.emergencySaveFence;
		const authorityEpoch = this.readAuthorityEpoch();
		let hostBefore: ManagedViewSaveGuard | null = null;
		let cmBefore: CodeMirrorHandoffGuardSnapshot | null = null;
		try {
			hostBefore = hostGuard?.snapshot() ?? null;
			cmBefore = cmGuard?.snapshot() ?? null;
		} catch {
			hostBefore = null;
		}
		let marked = false;
		if (
			hostGuard === null
			|| hostBefore === null
			|| cmGuard === null
			|| cmBefore === null
			|| cmBefore.view !== candidate.cm
			|| this.getCmView(sourceSession.view) !== candidate.cm
			|| !hasExactHostGuardWrappers(hostBefore)
			|| !hasNoPendingHostLoadOwner(hostBefore)
		) {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-pre-mark-boundary-rejected",
			);
			return;
		}
		try {
			marked = hostGuard.markTargetLocallyPresented({
				handoffGeneration: sourceSession.generation,
				targetFile: handoff.targetFile,
				certifiedContent: candidate.incomingContent,
			});
		} catch {
			marked = false;
		}
		if (!marked) {
			this.trace?.("editor", "local-target-presentation-host-rejected", {
				leafId: sourceSession.leafId,
				path: handoff.targetPath,
			});
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-host-mark-rejected",
			);
			return;
		}
		let hostContent: string | null = null;
		let hostAfter: ManagedViewSaveGuard | null = null;
		let cmAfter: CodeMirrorHandoffGuardSnapshot | null = null;
		try {
			hostContent = candidate.runtimeView.getViewData();
			hostAfter = hostGuard.snapshot();
			cmAfter = cmGuard?.snapshot() ?? null;
		} catch {
			hostAfter = null;
		}
		const postMarkCurrent = this.managedSessions.get(sourceSession.leafId) === runtime
			&& runtime.session === sourceSession
			&& runtime.hostGuard === hostGuard
			&& runtime.cmGuard === cmGuard
			&& runtime.emergencySaveFence === emergencyFence
			&& sourceSession.handoff === handoff
			&& handoff.pendingHostLoadCandidate === candidate
			&& sourceSession.view.file === handoff.targetFile
			&& handoff.targetFile.path === handoff.targetPath
			&& this.getCmView(sourceSession.view) === candidate.cm
			&& candidate.cm.state.doc.toString() === candidate.incomingContent
			&& hostContent === candidate.incomingContent
			&& hostAfter !== null
			&& hasExactHostGuardWrappers(hostAfter)
			&& hasNoPendingHostLoadOwner(hostAfter)
			&& (hostAfter.pendingLoadEpoch ?? 0) === (hostBefore.pendingLoadEpoch ?? 0)
			&& hostAfter.mode.kind === "pass-through"
			&& hostAfter.hostCapabilityState === "ready"
			&& sameCodeMirrorGuardSnapshot(cmBefore, cmAfter)
			&& this.readAuthorityEpoch() === authorityEpoch;
		if (!postMarkCurrent) {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-post-mark-drift",
			);
			return;
		}
		const markProof = Object.freeze({
			runtime,
			sourceSession,
			candidate,
			hostGuard,
			targetFile: handoff.targetFile,
			targetPath: handoff.targetPath,
		}) satisfies ManagedTargetMarkReleaseProof;
		if (!this.releaseEmergencyHostSaveFence(
			runtime,
			"target-locally-presented",
			false,
			markProof,
		)) {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-emergency-release-rejected",
			);
			return;
		}
		this.pendingAdmissionByLeafId.delete(sourceSession.leafId);
		this.advanceAuthorityEpoch();
		const targetEditorRevision =
			this.editorRevisionByCm.get(candidate.cm) ?? 0;
		this.editorAuthorityRevisionByCm.set(
			candidate.cm,
			targetEditorRevision,
		);
		this.editorAuthorityContentByCm.set(
			candidate.cm,
			candidate.incomingContent,
		);
		this.cmToLeafId.set(candidate.cm, sourceSession.leafId);
		runtime.session = reduction.state;
		runtime.capturedSourceAuthority = null;
		runtime.adoption = NO_SAME_PATH_ADOPTION;
		try {
			this.applyHandoffEffects(
				runtime,
				reduction.effects,
				"target-locally-presented",
			);
		} catch {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-publication-effect-failed",
			);
			return;
		}
		if (
			runtime.cmGuard?.snapshot().gateClosed !== false
			|| this.getCodeMirrorHandoffContext(reduction.state.leafId)?.kind !== "same-path"
		) {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-final-boundary-rejected",
			);
			return;
		}
		if (!this.releaseTransitionInputFence(
			runtime,
			handoff.targetFile,
			handoff.targetPath,
			"target-locally-presented",
		)) {
			this.terminalizeManagedTargetCompletion(
				runtime,
				candidate,
				"local-target-transition-release-rejected",
			);
			return;
		}
		if (this.editorAuthorityControllerPort?.requestSamePathAdoption) {
			this.samePathAdoptionRequiredPathByLeafId.set(
				reduction.state.leafId,
				handoff.targetPath,
			);
		}
		this.trace?.("editor", "local-target-presentation-published", {
			leafId: reduction.state.leafId,
			path: handoff.targetPath,
		});

		// B is already the stable local editor authority. Sync admission now runs
		// through the ordinary same-path contract and may retry indefinitely
		// without rolling the editor back to A or capturing transition input.
		this.scheduleSamePathAdoptionRefresh(runtime, "target-locally-presented");
	}

	private isHostLoadCandidateCurrent(candidate: PendingHostLoadCandidate): boolean {
		const session = this.managedSessions.get(candidate.leafId)?.session;
		return this.asyncAuthorityOpen
			&& !!session
			&& session.sessionId === candidate.sessionId
			&& session.generation === candidate.handoffGeneration
			&& session.handoff?.sourceUnloadReceiptId === candidate.sourceUnloadReceiptId
			&& session.handoff?.pendingHostLoadCandidate === candidate;
	}

	private isHostLoadCompletionCurrent(receipt: HostLoadCompletionReceipt): boolean {
		const session = this.managedSessions.get(receipt.leafId)?.session;
		const candidate = session?.handoff?.pendingHostLoadCandidate;
		return !!session
			&& session.sessionId === receipt.sessionId
			&& session.generation === receipt.handoffGeneration
			&& session.handoff?.sourceUnloadReceiptId === candidate?.sourceUnloadReceiptId
			&& candidate?.hostLoadTokenId === receipt.hostLoadTokenId;
	}

	private advanceSettledHostStateRevision(
		candidate: PendingHostLoadCandidate,
	): boolean {
		if (candidate.applicationKind !== "state") return true;
		const observedRevision = this.editorRevisionByCm.get(candidate.cm) ?? 0;
		const expectedRevision = candidate.editorRevisionBefore + 1;
		if (observedRevision === expectedRevision) return true;
		if (
			observedRevision !== candidate.editorRevisionBefore
			|| this.authorityEpochExhausted
			|| this.authorityEpoch >= Number.MAX_SAFE_INTEGER
		) return false;
		this.advanceAuthorityEpoch();
		this.editorRevisionByCm.set(candidate.cm, expectedRevision);
		this.samePathAdoptionTransactionSeqByCm.set(
			candidate.cm,
			(this.samePathAdoptionTransactionSeqByCm.get(candidate.cm) ?? 0) + 1,
		);
		return true;
	}

	beginPathHandoff(
		view: MarkdownView,
		targetFile: TFile,
		reason: string,
		provenance: "observed" | "selected" = "observed",
		sourceUnloadReceiptId: string | null = null,
		expectedAdmissionOwner: ManagedDeferredLoadAdmissionSnapshot | null = null,
	): boolean {
		this.manageView(view);
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		if (!runtime || runtime.session.view !== view) return false;
		if (!this.requireManagedBoundary(view, `handoff:${reason}`)) return false;
		if (this.observedFileMismatchTerminalByRuntime.has(runtime)) {
			this.enterObservedFileMismatchTerminal(runtime, targetFile, reason);
			return false;
		}
		const existing = this.bindings.get(leafId);
		const displayed = runtime.session.displayedLineage;
		if (
			provenance === "observed"
			&& view.file === targetFile
			&& displayed.kind === "known"
			&& (
				displayed.file !== targetFile
				|| displayed.path !== targetFile.path
			)
		) {
			this.enterObservedFileMismatchTerminal(runtime, targetFile, reason);
			return false;
		}
		if (
			runtime.session.handoff === null
			&& displayed.kind === "known"
			&& displayed.file === targetFile
			&& displayed.path !== targetFile.path
		) {
			// An in-place TFile path mutation is not itself rename authority. Only
			// updatePathsAfterRename, after controller proof, may translate this
			// lineage without a detach/admission cycle.
			this.trace?.("editor", "handoff-waiting-for-rename-proof", {
				leafId,
				fromPath: displayed.path,
				targetPath: targetFile.path,
				reason,
			});
			return false;
		}
		if (
			existing?.path === targetFile.path
			&& runtime.session.handoff === null
			&& runtime.session.displayedLineage.kind === "known"
			&& runtime.session.displayedLineage.file === targetFile
		) return false;
		if (
			runtime.session.handoff?.targetFile === targetFile
			&& runtime.session.handoff.targetPath === targetFile.path
		) {
			const handoff = runtime.session.handoff;
			if (provenance !== "selected") {
				this.resolveBindingTarget(view, this.lastDeviceName, `handoff:${reason}`);
				return true;
			}
			if (sourceUnloadReceiptId === null) return false;
			if (handoff.sourceUnloadReceiptId !== null) {
				if (
					handoff.sourceUnloadReceiptId !== sourceUnloadReceiptId
					|| runtime.session.currentSwitchIntentSeq === null
				) return false;
				this.resolveBindingTarget(view, this.lastDeviceName, `handoff:${reason}`);
				return true;
			}
		}
		if (provenance === "selected" && sourceUnloadReceiptId === null) return false;
		const reduction = reduceManagedLeafSession(
			runtime.session,
			provenance === "selected"
				? {
					type: "target-selected",
					sessionId: runtime.session.sessionId,
					expectedGeneration: runtime.session.generation,
					targetFile,
					switchIntentSeq: runtime.session.eventOrderSeq + 1,
					sourceUnloadReceiptId: sourceUnloadReceiptId as string,
				}
				: {
					type: "target-observed",
					sessionId: runtime.session.sessionId,
					expectedGeneration: runtime.session.generation,
					targetFile,
				},
		);
		if (!reduction.accepted) return false;
		const sourceSession = runtime.session;
		const sourceBinding = existing;
		const sourceBindingEpoch = this.bindingEpochByLeafId.get(leafId) ?? 0;
		const sourceViewFile = view.file;
		const sourceViewPath = sourceViewFile?.path ?? null;
		const targetPath = targetFile.path;
		const sourceAuthorityEpoch = this.readAuthorityEpoch();
		const sourceHostGuard = runtime.hostGuard;
		const sourceCmGuard = runtime.cmGuard;
		if (sourceHostGuard === null || sourceCmGuard === null) return false;
		const admissionCurrent = (snapshot: ManagedViewSaveGuard): boolean => {
			if (expectedAdmissionOwner === null) return hasNoPendingHostLoadOwner(snapshot);
			return sameDeferredLoadAdmissionSnapshot(
				snapshot.pendingDeferredLoadAdmission,
				expectedAdmissionOwner,
			)
				&& expectedAdmissionOwner.targetFile === targetFile
				&& expectedAdmissionOwner.targetPath === targetPath
				&& expectedAdmissionOwner.sourceUnloadReceiptId === sourceUnloadReceiptId
				&& sourceViewFile === expectedAdmissionOwner.viewFileAtEntry
				&& sourceViewPath === expectedAdmissionOwner.viewPathAtEntry;
		};
		let hostAtEntry: ManagedViewSaveGuard;
		let cmAtEntry: CodeMirrorHandoffGuardSnapshot;
		try {
			hostAtEntry = sourceHostGuard.snapshot();
			cmAtEntry = sourceCmGuard.snapshot();
		} catch {
			return false;
		}
		if (
			!hasExactHostGuardWrappers(hostAtEntry)
			|| !admissionCurrent(hostAtEntry)
			|| hostAtEntry.mode.kind === "inert-pass-through"
			|| cmAtEntry.inert
			|| cmAtEntry.view !== this.getCmView(view)
			|| this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== sourceSession
			|| runtime.hostGuard !== sourceHostGuard
			|| runtime.cmGuard !== sourceCmGuard
			|| this.bindings.get(leafId) !== sourceBinding
			|| (this.bindingEpochByLeafId.get(leafId) ?? 0) !== sourceBindingEpoch
			|| this.readAuthorityEpoch() !== sourceAuthorityEpoch
		) return false;
		const sourceDrainOwner = runtime.sourceUnloadDrain;
		const preownedTargetSelectionToken = provenance === "selected"
			&& sourceDrainOwner !== null
			&& sourceDrainOwner.state === "fenced"
			&& sourceDrainOwner.settled
			&& displayed.kind === "known"
			&& sourceDrainOwner.sourceFile === displayed.file
			&& sourceDrainOwner.sourcePath === displayed.path
			&& sourceDrainOwner.sourceSession.sessionId === sourceSession.sessionId
			&& sourceDrainOwner.sourceSession.generation === sourceSession.generation
			&& sourceDrainOwner.cmGuard === sourceCmGuard
			&& sourceDrainOwner.targetSelectionToken !== null
			&& sourceCmGuard.isTargetSelectionFenceCurrent(
				sourceDrainOwner.targetSelectionToken,
			)
				? sourceDrainOwner.targetSelectionToken
				: null;
		const existingTransitionFence = runtime.transitionInputFence;
		const reusableSupersessionFence = provenance === "selected"
			&& expectedAdmissionOwner !== null
			&& sourceDrainOwner === null
			&& sourceSession.handoff !== null
			&& sourceSession.binding.kind === "unbound"
			&& existingTransitionFence !== null
			&& existingTransitionFence.view === view
			&& existingTransitionFence.cmGuard === sourceCmGuard
			&& existingTransitionFence.targetFile === sourceSession.handoff.targetFile
			&& existingTransitionFence.targetPath === sourceSession.handoff.targetPath
			&& existingTransitionFence.sessionId === sourceSession.sessionId
			&& existingTransitionFence.handoffGeneration === sourceSession.generation
			&& existingTransitionFence.switchIntentSeq === sourceSession.currentSwitchIntentSeq
			&& existingTransitionFence.state === "handoff"
			&& existingTransitionFence.targetSelectionToken === null
			&& cmAtEntry.gateClosed
			&& cmAtEntry.targetSelectionFence === null
			&& this.isTransitionContainerOwned(existingTransitionFence)
				? existingTransitionFence
				: null;
		if (
			(provenance === "selected" && sourceDrainOwner !== null)
			&& preownedTargetSelectionToken === null
		) {
			return false;
		}
		if (
			expectedAdmissionOwner !== null
			&& preownedTargetSelectionToken === null
			&& reusableSupersessionFence === null
		) {
			return false;
		}
		const transition = this.acquireTransitionInputFence(
			runtime,
			targetFile,
			targetPath,
			reduction.state,
			false,
			preownedTargetSelectionToken,
		);
		if (transition === null) {
			this.trace?.("editor", "target-selection-fence-acquire-rejected", {
				leafId,
				path: targetPath,
				reason,
			});
			return false;
		}
		let hostBeforeCapture: ManagedViewSaveGuard;
		let cmBeforeCapture: CodeMirrorHandoffGuardSnapshot;
		try {
			hostBeforeCapture = sourceHostGuard.snapshot();
			cmBeforeCapture = sourceCmGuard.snapshot();
		} catch {
			this.abortTransitionInputFence(runtime, transition);
			return false;
		}
		const transitionCurrent = (): boolean => {
			const fence = transition.fence;
			const token = fence.targetSelectionToken;
			return runtime.transitionInputFence === fence
				&& fence.view === view
				&& fence.container === this.transitionContainer(view)
				&& Reflect.get(fence.container, "inert") === true
				&& fence.cmGuard === sourceCmGuard
				&& fence.targetFile === targetFile
				&& fence.targetPath === targetPath
				&& fence.sessionId === reduction.state.sessionId
				&& fence.handoffGeneration === reduction.state.generation
				&& fence.switchIntentSeq === reduction.state.currentSwitchIntentSeq
				&& (token === null || sourceCmGuard.isTargetSelectionFenceCurrent(token));
		};
		if (
			this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== sourceSession
			|| runtime.hostGuard !== sourceHostGuard
			|| runtime.cmGuard !== sourceCmGuard
			|| this.bindings.get(leafId) !== sourceBinding
			|| (this.bindingEpochByLeafId.get(leafId) ?? 0) !== sourceBindingEpoch
			|| view.file !== sourceViewFile
			|| sourceViewFile?.path !== sourceViewPath
			|| targetFile.path !== targetPath
			|| this.readAuthorityEpoch() !== sourceAuthorityEpoch
			|| !hasExactHostGuardWrappers(hostBeforeCapture)
			|| !admissionCurrent(hostBeforeCapture)
			|| !transitionCurrent()
		) {
			this.trace?.("editor", "target-selection-fence-pre-capture-cas-rejected", {
				leafId,
				path: targetPath,
				reason,
			});
			this.abortTransitionInputFence(runtime, transition);
			return false;
		}
		const captureEffect = reduction.effects.some(
			(effect) => effect.type === "capture-authority-before-detach",
		);
		const sourceAuthorityPath = reduction.state.handoff?.sourceAuthorityPath ?? null;
		const sourceAuthorityBeforeTransition = captureEffect && sourceAuthorityPath !== null
			? this.capturePathEditorAuthority(sourceAuthorityPath)
			: null;
		let hostAfterCapture: ManagedViewSaveGuard;
		let cmAfterCapture: CodeMirrorHandoffGuardSnapshot;
		try {
			hostAfterCapture = sourceHostGuard.snapshot();
			cmAfterCapture = sourceCmGuard.snapshot();
		} catch {
			this.abortTransitionInputFence(runtime, transition);
			return false;
		}
		// Authority capture reads host/editor state and may synchronously re-enter
		// plugin callbacks. Publish only after every runtime, wrapper, pending owner,
		// editor epoch, and target-less fence identity survives an exact second CAS.
		if (
			this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== sourceSession
			|| runtime.hostGuard !== sourceHostGuard
			|| runtime.cmGuard !== sourceCmGuard
			|| this.bindings.get(leafId) !== sourceBinding
			|| (this.bindingEpochByLeafId.get(leafId) ?? 0) !== sourceBindingEpoch
			|| view.file !== sourceViewFile
			|| sourceViewFile?.path !== sourceViewPath
			|| targetFile.path !== targetPath
			|| this.readAuthorityEpoch() !== sourceAuthorityEpoch
			|| !sameHostGuardSnapshot(hostBeforeCapture, hostAfterCapture)
			|| !sameCodeMirrorGuardSnapshot(cmBeforeCapture, cmAfterCapture)
			|| !hasExactHostGuardWrappers(hostAfterCapture)
			|| !admissionCurrent(hostAfterCapture)
			|| !transitionCurrent()
		) {
			this.trace?.("editor", "target-selection-fence-post-capture-cas-rejected", {
				leafId,
				path: targetPath,
				reason,
			});
			this.abortTransitionInputFence(runtime, transition);
			return false;
		}
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		if (!this.transferTransitionInputFence(runtime, transition.fence)) {
			this.retainManagedTargetCompletionFence(
				runtime,
				"target-selection-fence-transfer-rejected",
			);
			return false;
		}
		if (
			sourceDrainOwner !== null
			&& preownedTargetSelectionToken !== null
			&& runtime.sourceUnloadDrain === sourceDrainOwner
		) {
			sourceDrainOwner.targetSelectionToken = null;
			sourceDrainOwner.state = "transferred";
			runtime.sourceUnloadDrain = null;
		}
		runtime.adoption = NO_SAME_PATH_ADOPTION;
		const expectedGeneration = reduction.state.generation;
		this.applyHandoffEffects(
			runtime,
			reduction.effects,
			reason,
			sourceAuthorityBeforeTransition,
		);
		const current = this.managedSessions.get(leafId);
		const hostViewFileIsCurrent = provenance === "selected"
			? view.file === sourceViewFile
				&& (sourceViewFile === null || sourceViewFile.path === sourceViewPath)
			: view.file === targetFile;
		if (
			current !== runtime
			|| current.session.view !== view
			|| current.session.generation !== expectedGeneration
			|| current.session.handoff?.targetFile !== targetFile
			|| current.session.handoff.targetPath !== targetFile.path
			|| current.transitionInputFence !== transition.fence
			|| transition.fence.state !== "handoff"
			|| transition.fence.container !== this.transitionContainer(view)
			|| Reflect.get(transition.fence.container, "inert") !== true
			|| !hostViewFileIsCurrent
			|| targetFile.path !== current.session.handoff.targetPath
		) return false;
		this.resolveBindingTarget(view, this.lastDeviceName, `handoff:${reason}`);
		return true;
	}

	private ensureManagedTargetSelected(
		view: MarkdownView,
		targetFile: TFile,
		reason: string,
	): boolean {
		const session = this.getManagedSession(view) ?? this.manageView(view);
		const runtime = this.managedSessions.get(session.leafId);
		if (
			runtime !== undefined
			&& this.observedFileMismatchTerminalByRuntime.has(runtime)
		) {
			this.enterObservedFileMismatchTerminal(runtime, targetFile, reason);
			return false;
		}
		if (this.isManagedTargetSelected(session, targetFile)) return true;
		const exactSourceUnloadReceiptId = runtime
			? this.captureExactSourceUnloadReceipt(runtime, session, targetFile)
			: null;
		if (
			runtime !== undefined
			&& exactSourceUnloadReceiptId === null
			&& session.displayedLineage.kind === "known"
			&& (
				session.displayedLineage.file !== targetFile
				|| session.displayedLineage.path !== targetFile.path
			)
		) {
			this.enterObservedFileMismatchTerminal(runtime, targetFile, reason);
			return false;
		}
		if (exactSourceUnloadReceiptId === null) {
			return this.beginPathHandoff(view, targetFile, reason);
		}
		if (
			this.beginPathHandoff(
				view,
				targetFile,
				reason,
				"selected",
				exactSourceUnloadReceiptId,
			)
		) return true;
		const currentRuntime = this.managedSessions.get(session.leafId);
		if (currentRuntime !== undefined) {
			this.enterObservedFileMismatchTerminal(
				currentRuntime,
				targetFile,
				`${reason}:selected-boundary-rejected`,
			);
		}
		return false;
	}

	private enterObservedFileMismatchTerminal(
		runtime: ManagedLeafRuntime,
		targetFile: TFile,
		reason: string,
	): void {
		const session = runtime.session;
		const displayed = session.displayedLineage;
		const view = session.view;
		const hostGuard = runtime.hostGuard;
		const cmGuard = runtime.cmGuard;
		const targetPath = targetFile.path;
		if (
			!this.asyncAuthorityOpen
			|| this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| view.file !== targetFile
			|| targetPath.length === 0
			|| displayed.kind !== "known"
			|| (
				displayed.file === targetFile
				&& displayed.path === targetPath
			)
		) return;
		const previousOwner = this.observedFileMismatchTerminalByRuntime.get(runtime);
		const owner: ObservedFileMismatchTerminalOwner = Object.freeze({
			sessionId: previousOwner?.sessionId ?? session.sessionId,
			generation: previousOwner?.generation ?? session.generation,
			sourceFile: previousOwner?.sourceFile ?? displayed.file,
			sourcePath: previousOwner?.sourcePath ?? displayed.path,
			targetFile,
			targetPath,
		});
		this.observedFileMismatchTerminalByRuntime.set(runtime, owner);
		if (hostGuard === null || cmGuard === null) {
			this.trace?.("editor", "observed-file-mismatch-boundary-unavailable", {
				leafId: session.leafId,
				sourcePath: displayed.path,
				targetPath,
				reason,
			});
			try {
				new Notice(
					`The pane points to "${targetPath}", but its visible editor still belongs to "${displayed.path}" and a terminal editor boundary is unavailable. Do not edit or save this pane; close and reopen it. No target load or replay was attempted.`,
					10_000,
				);
			} catch {
				// The persistent owner still rejects every later automatic handoff attempt.
			}
			return;
		}
		try {
			hostGuard.beginBlockingHandoff({
				handoffGeneration: session.generation,
				sourceLineagePath: displayed.path,
				targetPath,
			});
		} catch {
			// The independent emergency owner below is still attempted synchronously.
		}
		const saveFenceReady = this.ensureEmergencyHostSaveFence(
			runtime,
			`observed-file-mismatch:${reason}`,
		);
		if (!saveFenceReady) {
			this.trace?.("editor", "observed-file-mismatch-save-boundary-lost", {
				leafId: session.leafId,
				sourcePath: displayed.path,
				targetPath,
				reason,
			});
			try {
				new Notice(
					`The pane points to "${targetPath}", but its visible editor still belongs to "${displayed.path}" and the native save boundary could not be proven. Do not edit this pane; close and reopen it. No target load or replay was attempted.`,
					10_000,
				);
			} catch {
				// Wrapper drift remains a hard terminal even without the warning surface.
			}
			return;
		}
		if (runtime.transitionInputFence?.state === "reopen-required") {
			runtime.transitionInputFence.targetFile = targetFile;
			runtime.transitionInputFence.targetPath = targetPath;
			runtime.transitionInputFence.sessionId = session.sessionId;
			runtime.transitionInputFence.handoffGeneration = session.generation;
			runtime.transitionInputFence.switchIntentSeq = session.currentSwitchIntentSeq;
			const visible = this.captureStableVisibleManagedContent(runtime);
			if (visible !== null) {
				this.offerTerminalVisibleContentExport(
					runtime,
					visible,
					`observed-file-mismatch-reopen-required:${reason}`,
				);
			}
			return;
		}
		if (session.handoff !== null) {
			if (runtime.transitionInputFence !== null) {
				runtime.transitionInputFence.state = "reopen-required";
			}
			this.retainManagedTargetCompletionFence(
				runtime,
				`observed-file-mismatch-existing-handoff:${reason}`,
			);
			return;
		}
		const transition = this.acquireTransitionInputFence(
			runtime,
			targetFile,
			targetPath,
			session,
			true,
		);
		if (transition === null) {
			let pendingInput = false;
			try {
				const snapshot = cmGuard.snapshot();
				pendingInput = snapshot.activeComposition !== null
					|| snapshot.commitState === "pending"
					|| session.pendingInputStartReservation !== null;
			} catch {
				pendingInput = false;
			}
			this.trace?.("editor", "observed-file-mismatch-input-boundary-pending", {
				leafId: session.leafId,
				sourcePath: displayed.path,
				targetPath,
				reason,
				pendingInput,
			});
			try {
				new Notice(
					pendingInput
						? `The pane changed to "${targetPath}" while an input sequence for "${displayed.path}" was still settling. Native saving is blocked; finish that sequence, then use recovery export and reopen the pane.`
						: `The pane points to "${targetPath}", but its visible editor still belongs to "${displayed.path}". Native saving is blocked, but the input boundary could not be proven; close and reopen the pane.`,
					10_000,
				);
			} catch {
				// The host save owner remains the synchronous safety boundary.
			}
			return;
		}
		// This is a terminal, ownerless observation rather than an authorized
		// source-to-target handoff. Keep the target-less selection token owned by
		// the source guard; transferring it would reopen the gate because no
		// handoff context exists to take over input ownership.
		transition.fence.state = "reopen-required";
		const binding = this.bindings.get(session.leafId);
		const authorityEpoch = this.readAuthorityEpoch();
		let sourceContent: string | null = null;
		let editorContent: string | null = null;
		let hostContent: string | null = null;
		let rawData: unknown = null;
		let cmBefore: CodeMirrorHandoffGuardSnapshot | null = null;
		let hostBefore: ManagedViewSaveGuard | null = null;
		let emergencyCurrent = false;
		try {
			sourceContent = displayed.cm.state.doc.toString();
			editorContent = view.editor.getValue();
			hostContent = (view as unknown as TextFileView).getViewData();
			rawData = (view as unknown as TextFileView & Readonly<{ data?: unknown }>).data;
			cmBefore = cmGuard.snapshot();
			hostBefore = hostGuard.snapshot();
			emergencyCurrent = runtime.emergencySaveFence?.isCurrent() === true;
		} catch {
			sourceContent = null;
		}
		const exactSource = binding !== undefined
			&& owner.sessionId === session.sessionId
			&& owner.generation === session.generation
			&& owner.sourceFile === displayed.file
			&& owner.sourcePath === displayed.path
			&& owner.targetFile === targetFile
			&& owner.targetPath === targetPath
			&& binding.view === view
			&& binding.file === displayed.file
			&& binding.path === displayed.path
			&& binding.cm === displayed.cm
			&& session.binding.kind === "bound"
			&& session.binding.path === displayed.path
			&& session.binding.ytext === binding.ytext
			&& this.getCmView(view) === displayed.cm
			&& displayed.document === displayed.cm.state.doc
			&& sourceContent !== null
			&& editorContent === sourceContent
			&& binding.ytext.toJSON() === sourceContent
			&& hostContent === sourceContent
			&& rawData === sourceContent
			&& cmBefore?.view === displayed.cm
			&& cmBefore.inert === false
			&& cmBefore.gateClosed
			&& cmBefore.activeComposition === null
			&& cmBefore.commitState === "none"
			&& cmBefore.pendingHostLoadCandidate === null
			&& hostBefore !== null
			&& hasExactHostGuardWrappers(hostBefore)
			&& hostBefore.emergencySaveBlocked
			&& emergencyCurrent
			&& runtime.transitionInputFence === transition.fence
			&& this.isTransitionContainerOwned(transition.fence);
		let secondSourceContent: string | null = null;
		let secondEditorContent: string | null = null;
		let secondHostContent: string | null = null;
		let secondRawData: unknown = null;
		let cmAfter: CodeMirrorHandoffGuardSnapshot | null = null;
		let hostAfter: ManagedViewSaveGuard | null = null;
		let secondEmergencyCurrent = false;
		try {
			secondSourceContent = displayed.cm.state.doc.toString();
			secondEditorContent = view.editor.getValue();
			secondHostContent = (view as unknown as TextFileView).getViewData();
			secondRawData = (view as unknown as TextFileView & Readonly<{
				data?: unknown;
			}>).data;
			cmAfter = cmGuard.snapshot();
			hostAfter = hostGuard.snapshot();
			secondEmergencyCurrent = runtime.emergencySaveFence?.isCurrent() === true;
		} catch {
			secondSourceContent = null;
		}
		const exactStableSource = exactSource
			&& this.managedSessions.get(session.leafId) === runtime
			&& this.observedFileMismatchTerminalByRuntime.get(runtime) === owner
			&& runtime.session === session
			&& this.bindings.get(session.leafId) === binding
			&& runtime.hostGuard === hostGuard
			&& runtime.cmGuard === cmGuard
			&& runtime.transitionInputFence === transition.fence
			&& this.getCmView(view) === displayed.cm
			&& displayed.cm.state.doc === displayed.document
			&& sourceContent === secondSourceContent
			&& editorContent === secondEditorContent
			&& hostContent === secondHostContent
			&& rawData === secondRawData
			&& cmBefore !== null
			&& cmAfter !== null
			&& sameCodeMirrorGuardSnapshot(cmBefore, cmAfter)
			&& hostBefore !== null
			&& hostAfter !== null
			&& sameHostGuardSnapshot(hostBefore, hostAfter)
			&& secondEmergencyCurrent
			&& this.readAuthorityEpoch() === authorityEpoch
			&& this.isTransitionContainerOwned(transition.fence);
		const stableSourceContent = exactStableSource ? sourceContent : null;
		if (stableSourceContent === null) {
			this.retainManagedTargetCompletionFence(
				runtime,
				`observed-file-mismatch-source-unprovable:${reason}`,
			);
			const visible = this.captureStableVisibleManagedContent(runtime);
			if (visible !== null) {
				this.offerTerminalVisibleContentExport(
					runtime,
					visible,
					`observed-file-mismatch-source-unprovable:${reason}`,
				);
			}
			return;
		}
		runtime.capturedSourceAuthority = { kind: "blocked", reason: "transitioning" };
		const detachedEpoch = this.detachBinding(
			view,
			"observed-file-mismatch-terminal",
			true,
		);
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| runtime.transitionInputFence !== transition.fence
			|| !this.isTransitionContainerOwned(transition.fence)
		) return;
		this.advanceAuthorityEpoch();
		runtime.session = {
			...session,
			binding: { kind: "unbound" },
			completedDetachEpoch: detachedEpoch,
		};
		this.offerTerminalVisibleContentExport(
			runtime,
			stableSourceContent,
			`observed-file-mismatch:${reason}`,
		);
		this.trace?.("editor", "observed-file-mismatch-terminal", {
			leafId: session.leafId,
			sourcePath: displayed.path,
			targetPath,
			reason,
		});
		try {
			new Notice(
				`The pane points to "${targetPath}", but the blocked visible bytes belong to "${displayed.path}". KAOS detached the source sync binding without loading the target. Complete the recovery export, then close and reopen this pane.`,
				10_000,
			);
		} catch {
			// The verified exporter and retained fences remain authoritative.
		}
	}

	private captureExactSourceUnloadReceipt(
		runtime: ManagedLeafRuntime,
		session: ManagedLeafSession,
		targetFile: TFile,
	): string | null {
		const displayed = session.displayedLineage;
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| session.view.file !== targetFile
			|| displayed.kind !== "known"
			|| (
				displayed.file === targetFile
				&& displayed.path === targetFile.path
			)
		) return null;
		let sourceUnload: ManagedSourceUnloadSnapshot | null;
		try {
			sourceUnload = runtime.hostGuard?.snapshot().sourceUnload ?? null;
		} catch {
			return null;
		}
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| session.view.file !== targetFile
			|| targetFile.path.length === 0
			|| sourceUnload === null
			|| sourceUnload.receiptId.length === 0
			|| sourceUnload.file !== displayed.file
			|| sourceUnload.path !== displayed.path
		) return null;
		return sourceUnload.receiptId;
	}

	private isManagedTargetSelected(session: ManagedLeafSession, targetFile: TFile): boolean {
		if (session.handoff) {
			return session.handoff.targetFile === targetFile
				&& session.handoff.targetPath === targetFile.path;
		}
		return session.displayedLineage.kind === "known"
			&& session.displayedLineage.file === targetFile
			&& session.displayedLineage.path === targetFile.path;
	}

	private applyHandoffEffects(
		runtime: ManagedLeafRuntime,
		effects: readonly EditorHandoffEffect[],
		reason: string,
		sourceAuthorityBeforeTransition: PathEditorAuthority | null = null,
	): void {
		for (const effect of effects) {
			if (
				this.managedSessions.get(runtime.session.leafId) !== runtime
				||
				runtime.session.sessionId !== effect.sessionId
				|| runtime.session.generation !== effect.expectedGeneration
			) return;
			this.trace?.("editor", "handoff-effect-applied", {
				leafId: runtime.session.leafId,
				reason,
				effect: effect.type,
				generation: effect.expectedGeneration,
			});
			switch (effect.type) {
				case "cancel-pending-save": {
					const requestSave = (runtime.session.view as unknown as {
						requestSave?: { cancel?: () => unknown };
					}).requestSave;
					try {
						requestSave?.cancel?.();
					} catch {
						// Blocking still proceeds; the installed save guard revokes in-flight lanes.
					}
					break;
				}
				case "block-save": {
					const handoff = runtime.session.handoff;
					if (handoff) {
						runtime.hostGuard?.beginBlockingHandoff({
							handoffGeneration: runtime.session.generation,
							sourceLineagePath: handoff.sourceAuthorityPath,
							targetPath: handoff.targetPath,
						});
					}
					break;
				}
				case "install-input-gate":
					runtime.cmGuard?.refreshGate();
					break;
				case "capture-authority-before-detach": {
					const sourcePath = runtime.session.handoff?.sourceAuthorityPath;
					runtime.capturedSourceAuthority = sourcePath
						? sourceAuthorityBeforeTransition
							?? { kind: "blocked", reason: "transitioning" }
						: { kind: "none" };
					break;
				}
				case "detach-binding": {
					const epoch = this.detachBinding(runtime.session.view, "handoff", true);
					const detached = reduceManagedLeafSession(runtime.session, {
						type: "detach-completed",
						sessionId: runtime.session.sessionId,
						expectedGeneration: runtime.session.generation,
						bindingEpochAfterDetach: epoch,
					});
					if (detached.accepted) {
						this.advanceAuthorityEpoch();
						runtime.session = detached.state;
					}
					break;
				}
				case "release-input-gate":
					runtime.cmGuard?.refreshGate();
					break;
				case "restore-save-pass-through":
					break;
			}
		}
	}

	separateUndoCaptureForPath(path: string): number {
		let separated = 0;
		for (const binding of this.bindings.values()) {
			if (
				binding.path !== path
				|| binding.view.file !== binding.file
				|| binding.file.path !== path
			) continue;
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
		if (!this.asyncAuthorityOpen) return;
		const previous = this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (sequence <= previous) return;
		this.observedExternalDiskMutationSequenceByPath.set(path, sequence);
		if (!this.isExternalDiskReloadGuardEnabled()) {
			this.pendingExternalDiskMutationStarts.delete(path);
			return;
		}
		const views = new Map<string, ExternalDiskHostViewSnapshot>();
		for (const [leafId, binding] of this.bindings) {
			if (
				binding.path !== path
				|| binding.view.file !== binding.file
				|| binding.file.path !== path
			) continue;
			this.manageView(binding.view);
			const continuation = this.captureManagedBindingContinuation(binding);
			if (
				!continuation
				|| continuation.targetFile !== binding.file
				|| continuation.targetPath !== path
				|| continuation.cm !== binding.cm
			) continue;
			const runtimeView = binding.view as MarkdownView & { lastSavedData?: unknown };
			views.set(leafId, {
				continuation,
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
		// Keep an empty start snapshot as positive proof that no editor binding owned
		// this path when the event began. A target can become bound while the exact
		// raw read is in flight; that later binding must not be retroactively armed
		// with an event it never observed at start.
		this.pendingExternalDiskMutationStarts.set(path, {
			path,
			sequence,
			at: Date.now(),
			views,
		});
	}

	/**
	 * Complete the exact observed revision as a KAOS self-write. The raw bytes are
	 * retained as a short-lived negative-provenance marker: a host reload that was
	 * already queued for K0 must still be rejected if the editor advanced to K1,
	 * but self bytes are never handed to the external-reconciliation callback.
	 */
	noteSelfWriteExternalDiskMutation(notice: ExternalDiskMutationNotice): void {
		if (!this.asyncAuthorityOpen) return;
		const ownsActiveDisposition = this.activateSelfWriteExternalDiskMutation(
			notice.path,
			notice.sequence,
		);
		try {
			this.noteSelfWriteExternalDiskMutationWhileActive(notice);
		} finally {
			this.releaseActiveSelfWriteExternalDiskMutation(
				notice.path,
				notice.sequence,
				ownsActiveDisposition,
			);
		}
	}

	private noteSelfWriteExternalDiskMutationWhileActive(
		notice: ExternalDiskMutationNotice,
	): void {
		this.rememberExternalDiskCandidateDisposition(
			this.selfWriteExternalDiskMutationSequencesByPath,
			notice.path,
			notice.sequence,
		);
		this.clearExternalDiskCandidateDeliveryRetry(notice.path, notice.sequence);
		if (!this.isExternalDiskReloadGuardEnabled() || notice.content === null) {
			this.retireExternalDiskReloadCorrelationThrough(notice.path, notice.sequence);
			return;
		}
		// The bounded negative-provenance ledger is installed before any
		// owner/sequence branch so synchronous generic-completion reentry cannot
		// publish known self-written bytes as an external candidate.
		const previousSequence =
			this.lastExternalDiskMutationSequenceByPath.get(notice.path) ?? 0;
		const currentMarker = this.pendingExternalDiskMutations.get(notice.path);
		if (
			notice.sequence < previousSequence
			|| (
				notice.sequence === previousSequence
				&& currentMarker?.sequence === notice.sequence
				&& currentMarker.provenance === "self-write"
			)
		) {
			// Sequence-scoped retirement cannot erase a newer start/marker. Equal
			// completion is an idempotent callback/probe retry.
			if (notice.sequence < previousSequence) {
				this.retireExternalDiskReloadCorrelationThrough(notice.path, notice.sequence);
			}
			return;
		}

		const start = this.pendingExternalDiskMutationStarts.get(notice.path);
		if (!start || start.sequence !== notice.sequence) {
			this.retireExternalDiskReloadCorrelationThrough(notice.path, notice.sequence);
			return;
		}
		let eligibleOwners = this.resolveExternalDiskMutationStartOwners(notice);
		if (eligibleOwners === null || eligibleOwners.size === 0) {
			this.retireExternalDiskReloadCorrelationThrough(notice.path, notice.sequence);
			return;
		}

		// Publish the newer sequence before invoking an older external callback. A
		// re-entrant callback can observe, but cannot recursively complete or erase,
		// the self-write that is currently being classified.
		this.lastExternalDiskMutationSequenceByPath.set(notice.path, notice.sequence);
		if (!this.preserveSupersededExternalDiskMarker(notice.path, notice.sequence)) {
			return;
		}
		eligibleOwners = this.resolveExternalDiskMutationStartOwners(notice);
		if (eligibleOwners === null || eligibleOwners.size === 0) {
			this.retireExternalDiskReloadCorrelationThrough(notice.path, notice.sequence);
			return;
		}

		const now = Date.now();
		const normalizedDiskContent = normalizeEditorText(notice.content);
		if (this.promoteHeldExternalDiskHostProjection(
			notice,
			normalizedDiskContent,
			now,
			eligibleOwners,
			"self-write",
		)) {
			return;
		}
		this.rememberPendingExternalDiskMutation({
			...notice,
			provenance: "self-write",
			at: now,
			consumedLeafIds: new Set<string>(),
			eligibleOwners,
			retireScheduled: false,
			candidatePublished: false,
		});
		this.trace?.("editor", "self-write-host-reload-marker-armed", {
			path: notice.path,
			sequence: notice.sequence,
			ownerCount: eligibleOwners.size,
		});
	}

	/**
	 * Resolve the bindings that still have the exact identity captured when this
	 * event began. `null` means no begin record exists (legacy/direct caller), an
	 * empty set means a begin record exists but no current binding is correlated.
	 */
	private resolveExternalDiskMutationStartOwners(
		notice: ExternalDiskMutationNotice,
	): Map<string, PendingExternalDiskMutationOwner> | null {
		const latestObservedSequence =
			this.observedExternalDiskMutationSequenceByPath.get(notice.path) ?? 0;
		if (latestObservedSequence < notice.sequence) return null;
		const start = this.pendingExternalDiskMutationStarts.get(notice.path);
		if (!start || start.sequence !== notice.sequence) {
			return new Map<string, PendingExternalDiskMutationOwner>();
		}
		const owners = new Map<string, PendingExternalDiskMutationOwner>();
		for (const [leafId, snapshot] of start.views) {
			if (
				this.bindings.get(leafId) === snapshot.binding
				&& (this.bindingEpochByLeafId.get(leafId) ?? 0) === snapshot.bindingEpoch
				&& snapshot.binding.path === notice.path
				&& snapshot.binding.file.path === notice.path
				&& snapshot.binding.view.file === snapshot.binding.file
				&& this.isManagedBindingContinuationCurrent(
					snapshot.continuation,
					snapshot.binding,
				)
			) {
				owners.set(leafId, Object.freeze({
					continuation: snapshot.continuation,
					binding: snapshot.binding,
					bindingEpoch: snapshot.bindingEpoch,
				}));
			}
		}
		return owners;
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
	noteExternalDiskMutation(
		notice: ExternalDiskMutationNotice,
	): ExternalDiskMutationCompletionDisposition {
		if (!this.asyncAuthorityOpen) return "terminal-no-candidate";
		if (!this.isExternalDiskReloadGuardEnabled()) {
			this.invalidateExternalDiskReloadCorrelation(notice.path, notice.sequence);
			return notice.content === null ? "controller-owned" : "terminal-no-candidate";
		}
		const hasLiveBinding = Array.from(this.bindings.values()).some(
			(binding) =>
				binding.path === notice.path
				&& binding.view.file === binding.file
				&& binding.file.path === notice.path,
		);
		const eligibleOwners = this.resolveExternalDiskMutationStartOwners(notice);
		if (!hasLiveBinding) {
			// The exact read may finish after a managed source was detached or before
			// its selected target was bound. The editor guard no longer owns a surface
			// in that case, but the path-scoped reconciliation controller must still
			// own the proven disk revision. Never arm a later editor with this marker.
			if (notice.content !== null) {
				this.deliverExternalDiskReloadOrRetain(notice);
			}
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return "controller-owned";
		}
		const previousSequence =
			this.lastExternalDiskMutationSequenceByPath.get(notice.path) ?? 0;
		if (notice.sequence <= previousSequence) {
			// Async reads may finish out of order. Never replace a newer exact
			// marker with an older revision; preserve the older proven bytes instead.
			const currentMarker = this.pendingExternalDiskMutations.get(notice.path);
			const knownSelfWrite = this.hasSelfWriteExternalDiskMutationDisposition(
				notice.path,
				notice.sequence,
			);
			if (
				notice.sequence === previousSequence
				&& currentMarker?.sequence === notice.sequence
			) {
				if (currentMarker.provenance === "external") {
					this.notifyPendingExternalDiskReloadIntercepted(currentMarker);
				}
				if (!knownSelfWrite) {
					this.retireExternalDiskMutationStartThrough(
						notice.path,
						notice.sequence,
					);
				}
			} else if (
				notice.content !== null
				&& !knownSelfWrite
			) {
				this.deliverExternalDiskReloadOrRetain(notice);
				this.retireExternalDiskReloadCorrelationThrough(
					notice.path,
					notice.sequence,
				);
			} else if (!knownSelfWrite) {
				this.retireExternalDiskMutationStartThrough(
					notice.path,
					notice.sequence,
				);
			}
			this.trace?.("editor", "external-disk-reload-guard-stale-event", {
				path: notice.path,
				sequence: notice.sequence,
				currentSequence: previousSequence,
				contentPreserved: notice.content !== null,
			});
			return "controller-owned";
		}
		if (eligibleOwners !== null && eligibleOwners.size === 0) {
			// beginExternalDiskMutation observed this exact event, but none of its
			// event-time binding identities still owns the path. A binding that appeared
			// during the async raw read has no authority to consume this revision as a
			// host reload marker; reconciliation owns it durably instead.
			if (notice.content !== null) {
				this.deliverExternalDiskReloadOrRetain(notice);
			}
			this.trace?.("editor", "external-disk-reload-start-owner-changed", {
				path: notice.path,
				sequence: notice.sequence,
				contentPreserved: notice.content !== null,
			});
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return "controller-owned";
		}
		this.lastExternalDiskMutationSequenceByPath.set(notice.path, notice.sequence);
		if (!this.preserveSupersededExternalDiskMarker(notice.path, notice.sequence)) {
			return "controller-owned";
		}
		const now = Date.now();
		const candidate = this.getFreshRecentEditorOriginChange(notice.path, now);
		const normalizedDiskContent = notice.content === null
			? null
			: normalizeEditorText(notice.content);
		if (this.promoteHeldExternalDiskHostProjection(
			notice,
			normalizedDiskContent,
			now,
			eligibleOwners,
			"external",
		)) {
			return "controller-owned";
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
			this.deliverExternalDiskReloadOrRetain(notice);
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
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return "controller-owned";
		} else if (candidate && candidateContentMatches && exactDiskRevisionMatches) {
			// Exact bytes/revision are known, but a coarse or non-monotonic clock
			// cannot safely distinguish an editor API change from an editor-first
			// disk reload. Keep a current editor/API result. If another authority has
			// already replaced it, preserve the exact disk candidate without rollback.
			this.recentEditorOriginChanges.delete(notice.path);
			const candidateStillCurrent = this.isRecentEditorOriginChangeCurrent(candidate);
			if (!candidateStillCurrent) {
				this.deliverExternalDiskReloadOrRetain(notice);
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
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return candidateStillCurrent
				? "terminal-no-candidate"
				: "controller-owned";
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
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return "terminal-no-candidate";
		}
		if (notice.content === null) {
			this.trace?.("editor", "external-disk-reload-guard-proof-unavailable", {
				path: notice.path,
				ctime: notice.ctime,
				mtime: notice.mtime,
				size: notice.size,
			});
			this.retireExternalDiskReloadCorrelationThrough(
				notice.path,
				notice.sequence,
			);
			return "controller-owned";
		}

		this.rememberPendingExternalDiskMutation({
			...notice,
			provenance: "external",
			at: now,
			consumedLeafIds: new Set<string>(),
			eligibleOwners,
			retireScheduled: false,
			candidatePublished: false,
		});
		return "controller-owned";
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		this.lastDeviceName = deviceName;
		this.manageView(view);
		const managedLeafId = this.getLeafId(view);
		const managedRuntime = this.managedSessions.get(managedLeafId);
		if (this.blocksSourceUnloadBindingReentry(managedRuntime)) {
			this.trace?.("editor", "source-unload-drain-bind-reentry-blocked", {
				leafId: managedLeafId,
				path: managedRuntime?.sourceUnloadDrain?.sourcePath ?? null,
				viewCurrent: managedRuntime?.session.view === view,
			});
			return;
		}
		const file = view.file;
		if (!file) return;
		if (!this.requireManagedBoundary(view, "bind")) return;

		if (!this.ensureManagedTargetSelected(view, file, "bind")) return;
		if (!this.canBindPath(view, "bind")) return;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		if (existing && existing.path !== file.path) {
			this.beginPathHandoff(view, file, "bind");
			return;
		}
		const cm = this.getCmView(view);
		if (!cm) {
			// A file switch may leave the previous CM connected while the new CM is
			// still mounting. Detach the old yCollab immediately; retry will bind the
			// new editor once its document agrees with the MarkdownView facade.
			this.log(`bind: waiting for Obsidian editor view for "${file.path}"`);
			this.scheduleCmResolveRetry(view, deviceName, leafId, "bind");
			return;
		}
		this.clearCmResolveRetry(leafId);
		this.cmDegradedWarned = false;
		const cmId = this.getCmId(cm);
		if (this.isTargetPresentationProven(view, file, cm)) {
			this.carryCmActivityToPath(cm, file.path);
		}
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
		if (!target || target.kind === "missing-target") {
			return;
		}

		this.applyBinding({
			action: "bind",
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			file,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			authorityLease: target.lease,
			rapidSwitch,
		});
	}

	repair(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		this.manageView(view);
		const managedRuntime = this.managedSessions.get(this.getLeafId(view));
		if (this.blocksSourceUnloadBindingReentry(managedRuntime)) {
			this.trace?.("editor", "source-unload-drain-repair-reentry-blocked", {
				leafId: this.getLeafId(view),
				path: managedRuntime?.sourceUnloadDrain?.sourcePath ?? null,
				reason,
			});
			return true;
		}
		const file = view.file;
		if (!file) return false;
		if (!this.requireManagedBoundary(view, `repair:${reason}`)) return false;
		if (!this.ensureManagedTargetSelected(view, file, `repair:${reason}`)) return false;
		if (!this.canBindPath(view, `repair:${reason}`)) return false;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existingBeforeCm = this.bindings.get(leafId);
		if (existingBeforeCm && existingBeforeCm.path !== file.path) {
			this.beginPathHandoff(view, file, `repair:${reason}`);
			return true;
		}
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
		if (!target || target.kind === "missing-target") {
			return this.isHardTombstonedPath(file.path);
		}

		return this.applyBinding({
			action: "repair",
			deviceName,
			view,
			cm,
			cmId: this.getCmId(cm),
			leafId,
			file,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			authorityLease: target.lease,
			existing,
			reason,
		});
	}

	heal(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		this.manageView(view);
		const managedRuntime = this.managedSessions.get(this.getLeafId(view));
		if (this.blocksSourceUnloadBindingReentry(managedRuntime)) {
			this.trace?.("editor", "source-unload-drain-heal-reentry-blocked", {
				leafId: this.getLeafId(view),
				path: managedRuntime?.sourceUnloadDrain?.sourcePath ?? null,
				reason,
			});
			return true;
		}
		const file = view.file;
		if (!file) return false;
		if (!this.requireManagedBoundary(view, `heal:${reason}`)) return false;
		if (!this.ensureManagedTargetSelected(view, file, `heal:${reason}`)) return false;
		if (!this.canBindPath(view, `heal:${reason}`)) return false;
		const existing = this.bindings.get(this.getLeafId(view));
		if (existing && existing.path !== file.path) {
			this.beginPathHandoff(view, file, `heal:${reason}`);
			return true;
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`heal:${reason}`,
		);
		if (!target || target.kind === "missing-target") {
			return this.isHardTombstonedPath(file.path);
		}

		return this.repair(view, deviceName, reason);
	}

	rebind(view: MarkdownView, deviceName: string, reason: string): void {
		this.lastDeviceName = deviceName;
		this.manageView(view);
		const managedRuntime = this.managedSessions.get(this.getLeafId(view));
		if (this.blocksSourceUnloadBindingReentry(managedRuntime)) {
			this.trace?.("editor", "source-unload-drain-rebind-reentry-blocked", {
				leafId: this.getLeafId(view),
				path: managedRuntime?.sourceUnloadDrain?.sourcePath ?? null,
				reason,
			});
			return;
		}
		const file = view.file;
		if (!file) return;
		if (!this.requireManagedBoundary(view, `rebind:${reason}`)) return;
		if (!this.ensureManagedTargetSelected(view, file, `rebind:${reason}`)) return;
		if (!this.canBindPath(view, `rebind:${reason}`)) return;
		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, `rebind:${reason}`);
			return;
		}

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		if (existing && existing.path !== file.path) {
			this.beginPathHandoff(view, file, `rebind:${reason}`);
			return;
		}
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
		const runtime = this.managedSessions.get(this.getLeafId(view));
		if (runtime?.session.view === view) {
			if (this.retainSourceUnloadDrainAcrossStructuralMutation(runtime, "unbind")) {
				return;
			}
			this.teardownSourceUnloadDrain(runtime, "unbind");
		}
		this.detachBinding(view, "unbind", false);
	}

	excludeView(view: MarkdownView, reason: string): void {
		this.manageView(view);
		this.skipExcludedBinding(view, view.file?.path ?? "(unknown)", reason);
	}

	private destroyUndoManagerOnce(undoManager: Y.UndoManager): void {
		if (this.destroyedUndoManagers.has(undoManager)) return;
		this.destroyedUndoManagers.add(undoManager);
		undoManager.destroy();
	}

	private cleanupOwnedBindingPublication(cm: EditorView, owner: object): void {
		if (this.bindingPublicationOwnerByCm.get(cm) !== owner) return;
		try {
			cm.dispatch({ effects: this.compartment.reconfigure([]) });
		} catch {
			// A destroyed/replaced view already removed this attempted publication.
		}
		if (this.bindingPublicationOwnerByCm.get(cm) === owner) {
			this.bindingPublicationOwnerByCm.delete(cm);
		}
	}

	private detachBinding(
		view: MarkdownView,
		reason: string,
		preserveManagedHandoff: boolean,
	): number {
		const leafId = this.getLeafId(view);
		const binding = this.bindings.get(leafId);
		if (!binding) return this.bindingEpochByLeafId.get(leafId) ?? 0;

		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		this.advanceAuthorityEpoch();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);
		this.pendingReplacementCmToLeafId.delete(binding.cm);
		const bindingEpoch = this.bumpBindingEpoch(leafId);
		this.destroyUndoManagerOnce(binding.undoManager);
		if (!Array.from(this.bindings.values()).some((item) => item.path === binding.path)) {
			this.invalidateExternalDiskReloadCorrelation(binding.path);
		}

		try {
			binding.cm.dispatch({ effects: this.compartment.reconfigure([]) });
		} catch {
			// View may already be destroyed.
		}
		this.bindingPublicationOwnerByCm.delete(binding.cm);

		if (!preserveManagedHandoff) {
			const runtime = this.managedSessions.get(leafId);
			if (runtime?.session.view === view) {
				this.advanceAuthorityEpoch();
				runtime.adoption = NO_SAME_PATH_ADOPTION;
				runtime.session = {
					...runtime.session,
					generation: runtime.session.generation + 1,
					binding: { kind: "unbound" },
					handoff: null,
					completedDetachEpoch: bindingEpoch,
				};
			}
		}
		this.clearLocalCursor(reason);
		this.clearLocalPresence(reason);
		this.log(`${reason}: unbound "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`);
		return bindingEpoch;
	}

	/**
	 * Enter every currently owned host-save job in the same turn that begins
	 * teardown. The caller must revoke async authority immediately after this
	 * method returns, then await the returned drain before destroying disk or
	 * persistence state.
	 */
	beginOwnedSaveDrainForTeardown(): Promise<void> {
		const drains: Promise<void>[] = [];
		let synchronousFailures = 0;
		for (const runtime of this.managedSessions.values()) {
			const guard = runtime.hostGuard;
			if (guard === null) continue;
			try {
				drains.push(guard.flushOwnedSave());
			} catch {
				synchronousFailures += 1;
			}
		}
		return Promise.allSettled(drains).then((results) => {
			const failureCount = synchronousFailures
				+ results.filter((result) => result.status === "rejected").length;
			if (failureCount === 0) return;
			this.trace?.("editor", "teardown-owned-save-drain-failed", {
				failureCount,
			});
		});
	}

	/**
	 * Synchronously revoke every async host/admission continuation before teardown
	 * performs any awaited disk or persistence work.
	 */
	revokeAsyncAuthority(): void {
		if (!this.asyncAuthorityOpen) return;
		this.asyncAuthorityOpen = false;
		this.advanceAuthorityEpoch();
		for (const runtime of this.managedSessions.values()) {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			runtime.session = {
				...runtime.session,
				generation: runtime.session.generation + 1,
				currentSwitchIntentSeq: null,
				pendingInputStartReservation: null,
				handoff: null,
			};
			runtime.hostGuard?.markInert();
			runtime.cmGuard?.markInert();
		}
		this.samePathAdoptionRequiredPathByLeafId.clear();
		this.activeSamePathExternalCandidateProjectionProofByPath.clear();
		for (const timer of this.pendingHealthChecks.values()) clearTimeout(timer);
		this.pendingHealthChecks.clear();
		for (const timer of this.pendingCmResolveRetries.values()) clearTimeout(timer);
		this.pendingCmResolveRetries.clear();
		for (const timer of this.pendingUnmanageRetries.values()) clearTimeout(timer);
		this.pendingUnmanageRetries.clear();
		for (const pending of this.pendingStructuralSourceCloseSettlements.values()) {
			if (pending.timer !== null) clearTimeout(pending.timer);
		}
		this.pendingStructuralSourceCloseSettlements.clear();
		this.unmanageRetryAttempts.clear();
		this.cmResolveAttempts.clear();
		this.cmResolveDelayedLogged.clear();
		this.pendingAdmissionByLeafId.clear();
		for (const timer of this.pendingSamePathAdoptionRetries.values()) {
			clearTimeout(timer);
		}
		this.pendingSamePathAdoptionRetries.clear();
		this.samePathAdoptionRetryAttempts.clear();
		this.samePathAdoptionRefreshScheduled.clear();
		this.editorAuthorityShieldContinuations.clear();
		this.clearExternalDiskCorrelationTimers();
		this.clearAllExternalDiskCandidateDeliveryRetries();
		this.clearExternalDiskCandidateDispositionLedger(
			this.deliveredExternalDiskCandidateSequencesByPath,
		);
		this.clearExternalDiskCandidateDispositionLedger(
			this.selfWriteExternalDiskMutationSequencesByPath,
		);
		this.activeSelfWriteExternalDiskMutationSequencesByPath.clear();
		// Plugin teardown revokes the reconciliation controller before this manager.
		// No pending raw marker can be transferred after that boundary; cancel every
		// editor-side owner and timer without invoking the now-revoked callback.
		this.pendingExternalDiskMutations.clear();
		this.pendingExternalDiskMutationStarts.clear();
		this.pendingExternalDiskHostProjectionFences = new WeakMap<
			EditorState,
			PendingExternalDiskHostProjectionFence
		>();
		this.claimedExternalDiskCandidateSequencesByPath.clear();
		this.recentEditorOriginChanges.clear();
		this.lastExternalDiskMutationSequenceByPath.clear();
		this.observedExternalDiskMutationSequenceByPath.clear();
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		const teardownReleaseAttempts = new Set<ManagedLeafRuntime>();
		const restoreExactTeardownHostBoundary = (
			runtime: ManagedLeafRuntime,
			view: MarkdownView,
		): void => {
			if (
				teardownReleaseAttempts.has(runtime)
				|| runtime.session.view !== view
				|| this.managedSessions.get(runtime.session.leafId) !== runtime
			) return;
			teardownReleaseAttempts.add(runtime);
			// Plugin teardown is an explicit final boundary. Release immediately
			// before restoring the host wrapper in this same synchronous turn;
			// revokeAsyncAuthority deliberately keeps this owner across all awaited
			// teardown drains. CM teardown may still remain blocked by an unresolved
			// orphan input, but it must never strand the native save wrapper.
			const released = this.releaseEmergencyHostSaveFence(
				runtime,
				"unbind-all:teardown",
				true,
			);
			if (!released) return;
			runtime.hostGuard?.cancelTerminalHostLifecycle?.(
				"unbind-all:teardown",
			);
			const transitionFence = runtime.transitionInputFence;
			if (transitionFence !== null) {
				this.releaseTransitionInputFence(
					runtime,
					transitionFence.targetFile,
					transitionFence.targetPath,
					"unbind-all:teardown",
					true,
				);
			}
			const hostGuard = runtime.hostGuard;
			if (hostGuard !== null) {
				hostGuard.markInert();
				hostGuard.restoreIfCurrent();
				if (
					this.managedSessions.get(runtime.session.leafId) === runtime
					&& runtime.session.view === view
					&& runtime.hostGuard === hostGuard
				) runtime.hostGuard = null;
			}
		};
		for (const binding of Array.from(this.bindings.values())) {
			const runtime = this.managedSessions.get(this.getLeafId(binding.view));
			if (runtime?.session.view === binding.view) {
				restoreExactTeardownHostBoundary(runtime, binding.view);
				this.cancelManagedHandoffAndUnmanage(
					binding.view,
					"unbind-all",
					"teardown",
				);
			} else {
				this.detachBinding(binding.view, "unbind-all", false);
			}
		}
		for (const runtime of Array.from(this.managedSessions.values())) {
			this.teardownSourceUnloadDrain(runtime, "unbind-all");
			restoreExactTeardownHostBoundary(runtime, runtime.session.view);
			this.unmanageView(runtime.session.view, "unbind-all", true);
		}
		for (const marker of Array.from(this.pendingExternalDiskMutations.values())) {
			if (this.notifyPendingExternalDiskReloadIntercepted(marker)) {
				this.retireExternalDiskReloadCorrelationThrough(
					marker.path,
					marker.sequence,
				);
			}
		}
		this.pendingExternalDiskMutationStarts.clear();
		this.clearExternalDiskCorrelationTimers();
		this.clearAllExternalDiskCandidateDeliveryRetries();
		this.claimedExternalDiskCandidateSequencesByPath.clear();
		this.clearExternalDiskCandidateDispositionLedger(
			this.deliveredExternalDiskCandidateSequencesByPath,
		);
		this.clearExternalDiskCandidateDispositionLedger(
			this.selfWriteExternalDiskMutationSequencesByPath,
		);
		this.activeSelfWriteExternalDiskMutationSequencesByPath.clear();
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
		const cancelledViews = new Set<MarkdownView>();
		for (const [leafId, binding] of Array.from(this.bindings.entries())) {
			if (binding.path === path) {
				const runtime = this.managedSessions.get(leafId);
				if (runtime?.session.view === binding.view) {
					if (this.retainSourceUnloadDrainAcrossStructuralMutation(
						runtime,
						"unbind-by-path",
					)) {
						cancelledViews.add(binding.view);
						this.lastTypingAwarenessAtByLeaf.delete(leafId);
						this.lastEditorDocChangeAtByPath.delete(path);
						this.log(`unbindByPath: retained terminal source "${path}" (leaf=${leafId})`);
						continue;
					}
					this.teardownSourceUnloadDrain(runtime, "unbind-by-path");
				}
				this.cancelManagedHandoffAndUnmanage(
					binding.view,
					"unbind-by-path",
					"deleted",
				);
				cancelledViews.add(binding.view);
				this.lastTypingAwarenessAtByLeaf.delete(leafId);
				this.lastEditorDocChangeAtByPath.delete(path);
				this.log(`unbindByPath: unbound "${path}" (leaf=${leafId})`);
				// Don't break — a path could theoretically be open in multiple leaves
			}
		}
		for (const runtime of Array.from(this.managedSessions.values())) {
			const view = runtime.session.view;
			if (
				cancelledViews.has(view)
				|| !this.managedRuntimeNamesPath(runtime, path)
				) continue;
			const leafId = runtime.session.leafId;
			if (this.retainSourceUnloadDrainAcrossStructuralMutation(
				runtime,
				"unbind-managed-path",
			)) {
				this.lastTypingAwarenessAtByLeaf.delete(leafId);
				this.lastEditorDocChangeAtByPath.delete(path);
				this.log(`unbindByPath: retained managed terminal source "${path}" (leaf=${leafId})`);
				continue;
			}
			this.teardownSourceUnloadDrain(runtime, "unbind-managed-path");
			this.cancelManagedHandoffAndUnmanage(
				view,
				"unbind-managed-path",
				"deleted",
			);
			this.lastTypingAwarenessAtByLeaf.delete(leafId);
			this.lastEditorDocChangeAtByPath.delete(path);
			this.log(`unbindByPath: revoked managed path "${path}" (leaf=${leafId})`);
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
	 * Whether a managed editor lifetime still names this path as a displayed,
	 * source-unload, or selected-target lineage. External disk observation uses
	 * this broader boundary than `isBound`: handoff deliberately detaches A before
	 * B can be attached, but neither path may lose exact filesystem revisions in
	 * that interval.
	 */
	tracksExternalDiskMutationPath(path: string): boolean {
		if (this.isBound(path)) return true;
		for (const runtime of this.managedSessions.values()) {
			if (this.managedRuntimeNamesPath(runtime, path)) return true;
		}
		return false;
	}

	private managedRuntimeNamesPath(runtime: ManagedLeafRuntime, path: string): boolean {
		const session = runtime.session;
		return (
			// `view.file` is selection provenance only. Including it here makes the
			// ownerless A-to-B seam observable to the disk reader; it does not admit the
			// still-visible editor document as B authority.
			session.view.file?.path === path
			|| (session.displayedLineage.kind === "known"
				&& session.displayedLineage.path === path)
			|| (session.binding.kind === "bound" && session.binding.path === path)
			|| session.handoff?.sourceAuthorityPath === path
			|| session.handoff?.targetPath === path
			|| runtime.sourceUnloadDrain?.sourcePath === path
			|| runtime.transitionInputFence?.targetPath === path
		);
	}

	/**
	 * Update binding metadata after a batch rename. If any bound editor's
	 * tracked path was renamed, update the tracking. The yCollab binding
	 * itself doesn't need to change (stable file IDs), but our bookkeeping does.
	 */
	updatePathsAfterRename(renames: Map<string, string>): void {
		const structurallyRetainedRuntimes = new Set<ManagedLeafRuntime>();
		for (const [leafId, binding] of this.bindings) {
			const newPath = renames.get(binding.path);
			if (newPath) {
				const previousPath = binding.path;
				this.manageView(binding.view);
				const runtime = this.managedSessions.get(leafId);
				if (
					runtime?.session.view === binding.view
					&& this.retainSourceUnloadDrainAcrossStructuralMutation(
						runtime,
						`bound-path-renamed:${previousPath}->${newPath}`,
					)
				) {
					structurallyRetainedRuntimes.add(runtime);
					this.invalidateExternalDiskReloadCorrelation(previousPath);
					continue;
				}
				const session = runtime?.session;
				const displayed = session?.displayedLineage;
					const exactRename = !!runtime
					&& session?.view === binding.view
					&& session.handoff === null
					&& displayed?.kind === "known"
					&& displayed.file === binding.file
					&& displayed.path === previousPath
					&& binding.view.file === binding.file
					&& binding.file.path === newPath
					&& session.binding.kind === "bound"
					&& session.binding.path === previousPath
						&& session.binding.fileId === binding.fileId
						&& session.binding.ytext === binding.ytext;
					const settledSourceOwner = runtime?.sourceUnloadDrain ?? null;
					if (exactRename && settledSourceOwner?.state === "fenced") {
						const exactSettledSource = settledSourceOwner.sourceFile === binding.file
							&& settledSourceOwner.sourcePath === previousPath;
						const released = exactSettledSource
							&& this.teardownSourceUnloadDrain(
								runtime,
								`bound-path-renamed-settled:${previousPath}->${newPath}`,
							);
						if (!released) {
							this.terminalizeSourceUnloadDrain(
								runtime,
								settledSourceOwner,
								"bound-path-renamed-settled-release-unprovable",
							);
							structurallyRetainedRuntimes.add(runtime);
							this.invalidateExternalDiskReloadCorrelation(previousPath);
							continue;
						}
					}
					const translated = exactRename && session
					? reduceManagedLeafSession(session, {
						type: "target-observed",
						sessionId: session.sessionId,
						expectedGeneration: session.generation,
						targetFile: binding.file,
					})
					: null;
				const exactTranslation = !!runtime
					&& !!translated?.accepted
					&& translated.effects.length === 0;
				this.log(`updatePaths: "${binding.path}" -> "${newPath}" (leaf=${leafId})`);
				if (!exactTranslation) {
					this.trace?.("editor", "rename-binding-identity-unproven", {
						leafId,
						previousPath,
						newPath,
					});
					this.invalidateExternalDiskReloadCorrelation(previousPath);
					const targetFile = binding.view.file;
					if (
						!targetFile
						|| targetFile.path !== newPath
						|| !this.beginPathHandoff(binding.view, targetFile, "rename-unproven")
					) {
						this.detachBinding(binding.view, "rename-unproven", false);
					}
					continue;
				}
				if (
					runtime.adoption.kind === "awaiting-disk"
					&& runtime.adoption.path === previousPath
					&& runtime.adoption.file === binding.file
					&& runtime.adoption.fileId === binding.fileId
					&& runtime.adoption.ytext === binding.ytext
				) {
					this.advanceAuthorityEpoch();
					runtime.session = translated.state;
					this.detachBinding(
						binding.view,
						"same-path-adoption-exact-rename-replan",
						false,
					);
					this.samePathAdoptionRequiredPathByLeafId.set(leafId, newPath);
					this.scheduleSamePathAdoptionRefresh(
						runtime,
						"same-path-adoption-exact-rename",
					);
					this.trace?.("editor", "same-path-adoption-exact-rename-replan", {
						leafId,
						previousPath,
						newPath,
					});
					continue;
				}
				const lastDocChange = this.lastEditorDocChangeAtByPath.get(binding.path);
				if (lastDocChange != null) {
					this.lastEditorDocChangeAtByPath.set(newPath, lastDocChange);
					this.lastEditorDocChangeAtByPath.delete(binding.path);
				}
				this.advanceAuthorityEpoch();
				binding.path = newPath;
				runtime.session = translated.state;
				this.pendingAdmissionByLeafId.delete(leafId);
				this.invalidateExternalDiskReloadCorrelation(previousPath);
				this.bumpBindingEpoch(leafId);
				this.publishLocalActiveFile(binding);
			}
		}
		// A source drain may still own bound A while the host has selected target B.
		// In that seam `binding.path` is A, so a B rename never enters the bound loop;
		// the reducer also cannot publish a B handoff before the A input settles. Scan
		// every managed runtime once for either the old path or the already-mutated
		// target identity and retain the active source owner before unbound cleanup.
		for (const runtime of Array.from(this.managedSessions.values())) {
			if (structurallyRetainedRuntimes.has(runtime)) continue;
			const renamedPath = Array.from(renames.entries()).find(([oldPath, newPath]) =>
				this.managedRuntimeNamesPath(runtime, oldPath)
				|| runtime.session.view.file?.path === newPath
				|| (
					runtime.sourceUnloadDrain?.sourcePath === oldPath
					&& runtime.sourceUnloadDrain.sourceFile.path === newPath
				)
			);
			if (!renamedPath) continue;
			const [oldPath, newPath] = renamedPath;
			if (!this.retainSourceUnloadDrainAcrossStructuralMutation(
				runtime,
				`managed-path-renamed:${oldPath}->${newPath}`,
			)) continue;
			structurallyRetainedRuntimes.add(runtime);
			this.invalidateExternalDiskReloadCorrelation(oldPath);
			this.trace?.("editor", "managed-source-drain-rename-retained", {
				leafId: runtime.session.leafId,
				oldPath,
				newPath,
			});
		}
		for (const runtime of Array.from(this.managedSessions.values())) {
			if (structurallyRetainedRuntimes.has(runtime)) continue;
			if (runtime.session.binding.kind !== "unbound") continue;
			const renamedPath = Array.from(renames.entries()).find(([oldPath]) =>
				this.managedRuntimeNamesPath(runtime, oldPath)
			);
			if (!renamedPath) continue;
			const [oldPath, newPath] = renamedPath;
			const leafId = runtime.session.leafId;
			if (this.retainSourceUnloadDrainAcrossStructuralMutation(
				runtime,
				`unbound-path-renamed:${oldPath}->${newPath}`,
			)) {
				this.invalidateExternalDiskReloadCorrelation(oldPath);
				this.trace?.("editor", "unbound-source-drain-rename-retained", {
					leafId,
					oldPath,
					newPath,
				});
				continue;
			}
			this.teardownSourceUnloadDrain(runtime, "unbound-path-renamed");
			this.cancelManagedHandoffAndUnmanage(
				runtime.session.view,
				`unbound-path-renamed:${oldPath}->${newPath}`,
				"renamed",
			);
			this.invalidateExternalDiskReloadCorrelation(oldPath);
			this.trace?.("editor", "unbound-handoff-rename-invalidated", {
				leafId,
				oldPath,
				newPath,
			});
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
			const runtime = this.managedSessions.get(leafId);
			if (this.blocksSourceUnloadBindingReentry(runtime)) {
				this.trace?.("editor", "source-unload-drain-audit-reentry-blocked", {
					leafId,
					path: runtime?.sourceUnloadDrain?.sourcePath ?? null,
					source,
				});
				continue;
			}
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
				const targetFile = view.file;
				if (!targetFile) throw new Error("Open editor ticket requires an exact TFile");
				const session = this.manageView(view);
				const leafId =
					(view.leaf as unknown as { id?: string }).id ?? targetFile.path ?? path;
				const cm = this.getCmView(view);
				if (cm && this.isTargetPresentationProven(view, targetFile, cm)) {
					this.carryCmActivityToPath(cm, path);
				}
				const runtime = this.managedSessions.get(leafId);
				const guardSnapshot = runtime?.cmGuard?.snapshot() ?? null;
				const displayed = session.displayedLineage.kind === "known"
					? session.displayedLineage
					: null;
				const handoff = session.handoff;
				const managedBoundaryProven = runtime !== undefined
					&& cm !== null
					&& this.isManagedBoundaryLive(runtime, cm);
				const stableTargetIdentityProven = managedBoundaryProven && (handoff !== null
					? handoff.targetFile === targetFile && handoff.targetPath === targetFile.path
					: displayed?.file === targetFile && displayed.path === targetFile.path);
				let editorContent: string | null = null;
				try {
					editorContent = view.editor.getValue();
				} catch {
					// A ticket without a readable editor cannot authorize a later write.
				}
				return {
					bootSessionId: this.bootSessionId,
					sessionId: session.sessionId,
					handoffGeneration: session.generation,
					displayedFile: displayed?.file ?? null,
					displayedPath: displayed?.path ?? null,
					targetFile,
					stableTargetIdentityProven,
					switchIntentSeq: session.currentSwitchIntentSeq,
					nativeHistoryEpoch: session.nativeHistoryEpoch,
					selectionEpoch: guardSnapshot?.selectionEpoch ?? 0,
					scrollEpoch: guardSnapshot?.scrollEpoch ?? 0,
					handoffPresentation: handoff?.presentation ?? "stable",
					handoffPhase: null,
					intentStateKind: null,
					pendingHostLoadTokenId:
						handoff?.pendingHostLoadCandidate?.hostLoadTokenId ?? null,
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
		options: { ignoreSelectionAndScroll?: boolean } = {},
	): OpenEditorMutationTicketValidation {
		const validationAuthorityEpoch = this.readAuthorityEpoch();
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
			if (snapshot.bootSessionId !== this.bootSessionId) {
				return { current: false, reason: "boot-session-changed", leafId: snapshot.leafId };
			}
			const view = currentByLeafId.get(snapshot.leafId);
			if (!view || view !== snapshot.view) {
				return { current: false, reason: "view-replaced", leafId: snapshot.leafId };
			}
			if (this.getViewId(view) !== snapshot.viewId) {
				return { current: false, reason: "view-id-changed", leafId: snapshot.leafId };
			}
			const session = this.getManagedSession(view);
			if (
				!session
				|| session.sessionId !== snapshot.sessionId
				|| session.generation !== snapshot.handoffGeneration
			) {
				return {
					current: false,
					reason: "handoff-generation-changed",
					leafId: snapshot.leafId,
				};
			}
			if (view.file !== snapshot.targetFile) {
				return { current: false, reason: "target-file-changed", leafId: snapshot.leafId };
			}
			if (snapshot.targetFile.path !== ticket.path) {
				return { current: false, reason: "path-changed", leafId: snapshot.leafId };
			}
			if (
				snapshot.displayedFile !== null
				&& snapshot.displayedFile.path !== snapshot.displayedPath
			) {
				return { current: false, reason: "displayed-lineage-changed", leafId: snapshot.leafId };
			}
			const displayed = session.displayedLineage.kind === "known"
				? session.displayedLineage
				: null;
			const validationRuntime = this.managedSessions.get(snapshot.leafId);
			if (
				validationRuntime !== undefined
				&& this.observedFileMismatchTerminalByRuntime.has(validationRuntime)
			) {
				return {
					current: false,
					reason: "handoff-generation-changed",
					leafId: snapshot.leafId,
				};
			}
			const stableTargetIdentityProven = snapshot.cm !== null
				&& validationRuntime !== undefined
				&& this.isManagedBoundaryLive(validationRuntime, snapshot.cm)
				&& (session.handoff !== null
				? session.handoff.targetFile === snapshot.targetFile
					&& session.handoff.targetPath === ticket.path
				: displayed?.file === snapshot.targetFile
					&& displayed.path === ticket.path);
			if (!snapshot.stableTargetIdentityProven || !stableTargetIdentityProven) {
				return { current: false, reason: "displayed-lineage-changed", leafId: snapshot.leafId };
			}
			if (
				(displayed?.file ?? null) !== snapshot.displayedFile
				|| (displayed?.path ?? null) !== snapshot.displayedPath
			) {
				return { current: false, reason: "displayed-lineage-changed", leafId: snapshot.leafId };
			}
			if (session.currentSwitchIntentSeq !== snapshot.switchIntentSeq) {
				return { current: false, reason: "switch-intent-changed", leafId: snapshot.leafId };
			}
			if (session.nativeHistoryEpoch !== snapshot.nativeHistoryEpoch) {
				return { current: false, reason: "native-history-epoch-changed", leafId: snapshot.leafId };
			}
			const handoff = session.handoff;
			if (
				(handoff?.presentation ?? "stable") !== snapshot.handoffPresentation
				|| (handoff?.pendingHostLoadCandidate?.hostLoadTokenId ?? null)
					!== snapshot.pendingHostLoadTokenId
			) {
				return { current: false, reason: "handoff-generation-changed", leafId: snapshot.leafId };
			}
			if (
				handoff !== null
				&& (
					handoff.targetFile !== snapshot.targetFile
					|| handoff.targetPath !== ticket.path
				)
			) {
				return { current: false, reason: "target-file-changed", leafId: snapshot.leafId };
			}
			const cm = this.getCmView(view);
			if (cm !== snapshot.cm) {
				return { current: false, reason: "cm-changed", leafId: snapshot.leafId };
			}
			if ((cm ? this.getCmId(cm) : null) !== snapshot.cmId) {
				return { current: false, reason: "cm-id-changed", leafId: snapshot.leafId };
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
			if (
				cm
				&& (this.editorAuthorityRevisionByCm.get(cm) ?? 0)
					!== snapshot.editorAuthorityRevision
			) {
				return {
					current: false,
					reason: "editor-authority-revision-changed",
					leafId: snapshot.leafId,
				};
			}
			if (
				cm
				&& (this.editorAuthorityContentByCm.get(cm) ?? null)
					!== snapshot.editorAuthorityContent
			) {
				return {
					current: false,
					reason: "editor-authority-content-changed",
					leafId: snapshot.leafId,
				};
			}
			const guardSnapshot = this.managedSessions.get(snapshot.leafId)?.cmGuard?.snapshot() ?? null;
			if (
				!options.ignoreSelectionAndScroll
				&& (guardSnapshot?.selectionEpoch ?? 0) !== snapshot.selectionEpoch
			) {
				return { current: false, reason: "selection-epoch-changed", leafId: snapshot.leafId };
			}
			if (
				!options.ignoreSelectionAndScroll
				&& (guardSnapshot?.scrollEpoch ?? 0) !== snapshot.scrollEpoch
			) {
				return { current: false, reason: "scroll-epoch-changed", leafId: snapshot.leafId };
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
			if (this.readAuthorityEpoch() !== validationAuthorityEpoch) {
				return { current: false, reason: "authority-epoch-changed", leafId: snapshot.leafId };
			}

			// `getValue()` is a host callback and may synchronously switch the leaf.
			// Finish with a read-free identity/value CAS so that callback re-entry
			// cannot make a stale ticket current again.
			const finalRuntime = this.managedSessions.get(snapshot.leafId);
			const finalSession = finalRuntime?.session;
			if (
				snapshot.bootSessionId !== this.bootSessionId
				|| !finalSession
				|| finalSession.view !== view
				|| finalSession.sessionId !== snapshot.sessionId
				|| finalSession.generation !== snapshot.handoffGeneration
			) {
				return { current: false, reason: "handoff-generation-changed", leafId: snapshot.leafId };
			}
			if (view.file !== snapshot.targetFile || snapshot.targetFile.path !== ticket.path) {
				return { current: false, reason: "target-file-changed", leafId: snapshot.leafId };
			}
			const finalDisplayed = finalSession.displayedLineage.kind === "known"
				? finalSession.displayedLineage
				: null;
			const finalTargetIdentityProven = snapshot.cm !== null
				&& finalRuntime !== undefined
				&& this.isManagedBoundaryLive(finalRuntime, snapshot.cm)
				&& (finalSession.handoff !== null
				? finalSession.handoff.targetFile === snapshot.targetFile
					&& finalSession.handoff.targetPath === ticket.path
				: finalDisplayed?.file === snapshot.targetFile
					&& finalDisplayed.path === ticket.path);
			if (
				!snapshot.stableTargetIdentityProven
				|| !finalTargetIdentityProven
				||
				(finalDisplayed?.file ?? null) !== snapshot.displayedFile
				|| (finalDisplayed?.path ?? null) !== snapshot.displayedPath
				|| (
					snapshot.displayedFile !== null
					&& snapshot.displayedFile.path !== snapshot.displayedPath
				)
			) {
				return { current: false, reason: "displayed-lineage-changed", leafId: snapshot.leafId };
			}
			const finalHandoff = finalSession.handoff;
			if (
				finalSession.currentSwitchIntentSeq !== snapshot.switchIntentSeq
				|| finalSession.nativeHistoryEpoch !== snapshot.nativeHistoryEpoch
				|| (finalHandoff?.presentation ?? "stable") !== snapshot.handoffPresentation
				|| (finalHandoff?.pendingHostLoadCandidate?.hostLoadTokenId ?? null)
					!== snapshot.pendingHostLoadTokenId
				|| (
					finalHandoff !== null
					&& (
						finalHandoff.targetFile !== snapshot.targetFile
						|| finalHandoff.targetPath !== ticket.path
					)
				)
			) {
				return { current: false, reason: "handoff-generation-changed", leafId: snapshot.leafId };
			}
			const finalCm = snapshot.cm;
			if ((finalCm ? this.getCmId(finalCm) : null) !== snapshot.cmId) {
				return { current: false, reason: "cm-id-changed", leafId: snapshot.leafId };
			}
			if ((this.bindingEpochByLeafId.get(snapshot.leafId) ?? 0) !== snapshot.bindingEpoch) {
				return { current: false, reason: "binding-epoch-changed", leafId: snapshot.leafId };
			}
			if (finalCm && finalCm.state.doc !== snapshot.editorDocument) {
				return { current: false, reason: "editor-document-changed", leafId: snapshot.leafId };
			}
			if (finalCm && (this.editorRevisionByCm.get(finalCm) ?? 0) !== snapshot.editorRevision) {
				return { current: false, reason: "editor-revision-changed", leafId: snapshot.leafId };
			}
			if (
				finalCm
				&& (this.editorAuthorityRevisionByCm.get(finalCm) ?? 0)
					!== snapshot.editorAuthorityRevision
			) {
				return { current: false, reason: "editor-authority-revision-changed", leafId: snapshot.leafId };
			}
			if (
				finalCm
				&& (this.editorAuthorityContentByCm.get(finalCm) ?? null)
					!== snapshot.editorAuthorityContent
			) {
				return { current: false, reason: "editor-authority-content-changed", leafId: snapshot.leafId };
			}
			const finalGuard = this.managedSessions.get(snapshot.leafId)?.cmGuard?.snapshot() ?? null;
			if (
				!options.ignoreSelectionAndScroll
				&& (finalGuard?.selectionEpoch ?? 0) !== snapshot.selectionEpoch
			) {
				return { current: false, reason: "selection-epoch-changed", leafId: snapshot.leafId };
			}
			if (
				!options.ignoreSelectionAndScroll
				&& (finalGuard?.scrollEpoch ?? 0) !== snapshot.scrollEpoch
			) {
				return { current: false, reason: "scroll-epoch-changed", leafId: snapshot.leafId };
			}
			if (
				this.readAuthorityEpoch() !== validationAuthorityEpoch
				|| this.managedSessions.get(snapshot.leafId) !== finalRuntime
			) {
				return { current: false, reason: "authority-epoch-changed", leafId: snapshot.leafId };
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
		const file = view.file;
		if (!file || file !== binding.file || file.path !== binding.path) {
			return {
				healthy: false,
				settling: false,
				issues: [
					!file
						? "missing-file"
						: (file !== binding.file ? "file-identity-changed" : "path-changed"),
				],
				deferredIssues: [],
			};
		}
		if (this.bindingPropagationGate?.isPaused(binding.path)) {
			// Harness gate: treat as healthy so we don't auto-heal/rebind mid-scenario.
			return { healthy: true, settling: false, issues: [], deferredIssues: [] };
		}
		const issues: string[] = [];
		const deferredIssues: string[] = [];
		const liveCm = this.getCmView(view);
		const collab = this.getCollabDebugInfoForView(view);
		const withinSettleWindow =
			Date.now() - binding.lastBoundAtMs < binding.settleWindowMs;

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
			if (
				match.binding.view.file !== match.binding.file
				|| match.binding.file.path !== match.binding.path
			) {
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
		const targetFile = binding.view.file;
		if (targetFile !== binding.file || binding.file.path !== binding.path) {
			if (targetFile) {
				this.beginPathHandoff(binding.view, targetFile, "stale-non-user");
			}
			this.trace?.("editor", "stale-binding-non-user-patch-blocked", {
				leafId,
				boundPath: binding.path,
				currentPath: targetFile?.path ?? null,
				fileIdentityChanged: targetFile !== binding.file,
			});
			return [];
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
			this.isPendingExternalDiskMutationEligibleForBinding(
				pendingDiskMutation,
				leafId,
				binding,
			) &&
			!pendingDiskMutation.consumedLeafIds.has(leafId) &&
			incomingContent === normalizeEditorText(pendingDiskMutation.content)
		) {
			// The external disk event is stronger evidence than a transient
			// editor/Y.Text mismatch. This also covers a provider advance landing
			// between the disk event and Obsidian's editor reload.
			this.rejectPendingExternalDiskProjection({
				leafId,
				binding,
				currentText: editorContent,
				incomingText: incomingContent,
				candidate: pendingDiskMutation,
				proof: this.resolveExternalDiskHostSnapshotProof({
					leafId,
					binding,
					currentText: editorContent,
					incomingText: incomingContent,
				}),
				lane: "transaction-filter-exact",
			});
			this.recentEditorOriginChanges.delete(binding.path);
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
			this.isPendingExternalDiskMutationEligibleForBinding(
				pendingDiskMutation,
				leafId,
				binding,
			) &&
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
		return this.rejectPendingExternalDiskProjection({
			...input,
			proof,
			lane: "host-projection",
		});
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
		const lease = this.acquireExternalDiskHostSaveFence(input.leafId, proof);
		const restored = lease !== null && this.restoreExternalDiskHostViewCache(
			proof,
			input.leafId,
			input.currentText,
			input.incomingText,
			proof.start.sequence,
			false,
			lease,
		);
		if (restored && lease) {
			this.releaseExternalDiskHostSaveFence(lease, "held-host-cache-restored");
		}
		// Once event-time host provenance is proven, cache setter failure cannot turn
		// the projection back into an ordinary plugin edit. Keep the held raw-proof
		// correlation and the emergency save owner fail-closed.
		return proof.start.sequence;
	}

	private rejectPendingExternalDiskProjection(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
		candidate: PendingExternalDiskMutation;
		proof: ExternalDiskHostSnapshotProof | null;
		lane: string;
	}): boolean {
		const lease = input.proof
			? this.acquireExternalDiskHostSaveFence(input.leafId, input.proof)
			: null;
		const consumed = this.consumePendingExternalDiskMutation(
			input.candidate,
			input.leafId,
			input.binding,
			input.lane,
		);
		if (!consumed) {
			// The projection was already proven against this event-time owner. Never
			// admit it merely because a fence acquisition or callback re-entered lifecycle.
			return true;
		}
		// Candidate/self-write disposition is finalized before touching TextFileView
		// cache. Callback reentry and callback failure are both exactly-once.
		if (!this.notifyPendingExternalDiskReloadIntercepted(input.candidate)) {
			input.candidate.retireScheduled = false;
			return true;
		}
		if (!input.proof || !lease) return true;
		const restored = this.restoreExternalDiskHostViewCache(
			input.proof,
			input.leafId,
			input.currentText,
			input.incomingText,
			input.candidate.sequence,
			true,
			lease,
		);
		if (restored) {
			this.releaseExternalDiskHostSaveFence(lease, "external-host-cache-restored");
		}
		return true;
	}

	private resolveExternalDiskHostProjectionProof(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
	}): ExternalDiskHostProjectionProof | null {
		const snapshotProof = this.resolveExternalDiskHostSnapshotProof(input);
		if (!snapshotProof) return null;
		const { start, snapshot, runtimeView } = snapshotProof;
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

	private resolveExternalDiskHostSnapshotProof(input: {
		leafId: string;
		binding: EditorBinding;
		currentText: string;
		incomingText: string;
	}): ExternalDiskHostSnapshotProof | null {
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
			!this.isManagedBindingContinuationCurrent(snapshot.continuation, snapshot.binding) ||
			snapshot.binding !== input.binding ||
			snapshot.view !== input.binding.view ||
			snapshot.cm !== input.binding.cm ||
			(this.bindingEpochByLeafId.get(input.leafId) ?? 0) !== snapshot.bindingEpoch ||
			input.binding.view.file !== snapshot.continuation.targetFile ||
			input.binding.view.file !== input.binding.file ||
			input.binding.file.path !== input.binding.path ||
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
		try {
			if (runtimeView.data !== input.incomingText) return null;
		} catch {
			return null;
		}
		return { start, snapshot, runtimeView };
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

	private acquireExternalDiskHostSaveFence(
		leafId: string,
		proof: ExternalDiskHostSnapshotProof,
	): ExternalDiskHostSaveFenceLease | null {
		const runtime = this.managedSessions.get(leafId);
		if (
			!runtime ||
			runtime.session.view !== proof.snapshot.view ||
			proof.snapshot.binding.view !== runtime.session.view
		) return null;
		const previousFence = runtime.emergencySaveFence;
		if (!this.ensureEmergencyHostSaveFence(runtime, "external-host-cache-projection")) {
			return null;
		}
		const fence = runtime.emergencySaveFence;
		if (!fence) return null;
		return {
			runtime,
			fence,
			acquiredForProjection: previousFence === null,
		};
	}

	private releaseExternalDiskHostSaveFence(
		lease: ExternalDiskHostSaveFenceLease,
		reason: string,
	): void {
		if (!lease.acquiredForProjection) return;
		if (
			this.managedSessions.get(lease.runtime.session.leafId) !== lease.runtime ||
			lease.runtime.emergencySaveFence !== lease.fence
		) return;
		this.releaseEmergencyHostSaveFence(lease.runtime, reason, true);
	}

	private restoreExternalDiskHostViewCache(
		proof: ExternalDiskHostSnapshotProof,
		leafId: string,
		currentText: string,
		incomingText: string,
		sequence: number,
		retireSnapshot: boolean,
		lease: ExternalDiskHostSaveFenceLease,
	): boolean {
		try {
			if (
				this.managedSessions.get(leafId) !== lease.runtime ||
				lease.runtime.emergencySaveFence !== lease.fence ||
				!lease.fence.isCurrent() ||
				this.bindings.get(leafId) !== proof.snapshot.binding ||
				(this.bindingEpochByLeafId.get(leafId) ?? 0) !== proof.snapshot.bindingEpoch
			) return false;
			if (!this.isManagedBindingContinuationCurrent(
				proof.snapshot.continuation,
				proof.snapshot.binding,
			)) return false;
			if (proof.runtimeView.data !== incomingText) return false;
			// TextFileView stores the host-merged candidate before dispatching the
			// editor transaction. Restore that cache under the same exact CAS as the
			// cancelled CM patch so autosave cannot publish an unreviewed host merge
			// while the reconciliation controller is deciding the external candidate.
			if (!this.isManagedBindingContinuationCurrent(
				proof.snapshot.continuation,
				proof.snapshot.binding,
			)) return false;
			this.advanceAuthorityEpoch();
			proof.runtimeView.data = currentText;
			if (proof.runtimeView.data !== currentText) return false;
			if (
				this.managedSessions.get(leafId) !== lease.runtime ||
				lease.runtime.emergencySaveFence !== lease.fence ||
				!lease.fence.isCurrent() ||
				this.bindings.get(leafId) !== proof.snapshot.binding ||
				(this.bindingEpochByLeafId.get(leafId) ?? 0) !== proof.snapshot.bindingEpoch ||
				!this.isManagedBindingContinuationCurrent(
					proof.snapshot.continuation,
					proof.snapshot.binding,
				)
			) return false;
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
			this.isPendingExternalDiskMutationEligibleForBinding(
				pendingDiskMutation,
				leafId,
				binding,
			) &&
			incomingContent === normalizeEditorText(pendingDiskMutation.content)
		) {
			// A document-changing transaction reaching the extender proves that the
			// regular filter was bypassed (`filter: false`) or rewritten later. Preserve
			// the exact external bytes, then restore the previous editor document with a
			// post-update compare-and-revert.
			this.rejectPendingExternalDiskProjection({
				leafId,
				binding,
				currentText: editorContent,
				incomingText: incomingContent,
				candidate: pendingDiskMutation,
				proof: this.resolveExternalDiskHostSnapshotProof({
					leafId,
					binding,
					currentText: editorContent,
					incomingText: incomingContent,
				}),
				lane: "transaction-extender-exact",
			});
			this.recentEditorOriginChanges.delete(binding.path);
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
			this.isPendingExternalDiskMutationEligibleForBinding(
				pendingDiskMutation,
				leafId,
				binding,
			) &&
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
		if (!this.asyncAuthorityOpen) return;
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
			binding.view.file === binding.file &&
			binding.file.path === binding.path &&
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
		if (!this.asyncAuthorityOpen) return;
		this.manageView(binding.view);
		const continuation = this.captureManagedBindingContinuation(binding);
		if (
			!continuation
			|| continuation.targetFile !== binding.file
			|| continuation.targetPath !== binding.path
			|| continuation.cm !== binding.cm
		) return;
		const fileStat = binding.view.file?.stat;
		let expectedYTextOrigin: unknown = null;
		try {
			expectedYTextOrigin = startState.facet(ySyncFacet) ?? null;
		} catch {
			// Missing facet provenance fails the late rollback CAS closed.
		}
		this.rememberRecentEditorOriginChange({
			continuation,
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
		eligibleOwners: Map<string, PendingExternalDiskMutationOwner> | null,
		provenance: ExternalDiskMutationProvenance,
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
		const matchedOwners = new Map<string, PendingExternalDiskMutationOwner>();
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
				matchedOwners.set(leafId, Object.freeze({
					continuation: snapshot.continuation,
					binding: snapshot.binding,
					bindingEpoch: snapshot.bindingEpoch,
				}));
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
			provenance,
			at: now,
			consumedLeafIds: matchedLeafIds,
			eligibleOwners: eligibleOwners ?? matchedOwners,
			retireScheduled: false,
			candidatePublished: false,
		};
		this.recentEditorOriginChanges.delete(notice.path);
		if (provenance === "external") {
			marker.candidatePublished =
				this.deliverExternalDiskReloadOrRetain(notice) === "delivered";
		}
		this.rememberPendingExternalDiskMutation(marker);
		this.trace?.("editor", provenance === "external"
			? "external-disk-editor-host-merge-held-proven"
			: "self-write-editor-host-merge-held-proven", {
			path: notice.path,
			sequence: notice.sequence,
			heldLeafCount: matchedLeafIds.size,
		});
		return true;
	}

	private preserveSupersededExternalDiskMarker(path: string, sequence: number): boolean {
		const previous = this.pendingExternalDiskMutations.get(path);
		if (!previous || previous.sequence >= sequence) return true;
		if (previous.provenance === "external") {
			if (!this.notifyPendingExternalDiskReloadIntercepted(previous)) return false;
		}
		this.retireExternalDiskReloadCorrelationThrough(path, previous.sequence);
		this.trace?.("editor", "external-disk-marker-superseded", {
			path,
			previousSequence: previous.sequence,
			sequence,
			previousProvenance: previous.provenance,
		});
		return true;
	}

	private scheduleExternalDiskCorrelationTimer(
		callback: () => void,
		delay: number,
	): ReturnType<typeof setTimeout> | null {
		if (!this.asyncAuthorityOpen) return null;
		let timer: ReturnType<typeof setTimeout>;
		timer = setTimeout(() => {
			this.pendingExternalDiskCorrelationTimers.delete(timer);
			if (!this.asyncAuthorityOpen) return;
			callback();
		}, delay);
		this.pendingExternalDiskCorrelationTimers.add(timer);
		(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
		return timer;
	}

	private clearExternalDiskCorrelationTimers(): void {
		for (const timer of this.pendingExternalDiskCorrelationTimers) {
			clearTimeout(timer);
		}
		this.pendingExternalDiskCorrelationTimers.clear();
	}

	private rememberPendingExternalDiskMutation(marker: PendingExternalDiskMutation): void {
		if (!this.asyncAuthorityOpen) return;
		this.pendingExternalDiskMutations.set(marker.path, marker);
		this.scheduleExternalDiskCorrelationTimer(() => {
			if (this.pendingExternalDiskMutations.get(marker.path) === marker) {
				if (!this.notifyPendingExternalDiskReloadIntercepted(marker)) return;
				this.retireExternalDiskReloadCorrelationThrough(
					marker.path,
					marker.sequence,
				);
			}
		}, EXTERNAL_DISK_RELOAD_CORRELATION_MS);
	}

	private getFreshPendingExternalDiskMutation(path: string): PendingExternalDiskMutation | null {
		const marker = this.pendingExternalDiskMutations.get(path);
		if (!marker) return null;
		if (Date.now() - marker.at <= EXTERNAL_DISK_RELOAD_CORRELATION_MS) {
			return marker;
		}
		if (!this.notifyPendingExternalDiskReloadIntercepted(marker)) return marker;
		this.retireExternalDiskReloadCorrelationThrough(path, marker.sequence);
		return null;
	}

	private isPendingExternalDiskMutationEligibleForBinding(
		marker: PendingExternalDiskMutation,
		leafId: string,
		binding: EditorBinding,
	): boolean {
		if (marker.eligibleOwners === null) return true;
		const owner = marker.eligibleOwners.get(leafId);
		return !!owner
			&& owner.binding === binding
			&& this.bindings.get(leafId) === binding
			&& (this.bindingEpochByLeafId.get(leafId) ?? 0) === owner.bindingEpoch
			&& binding.path === marker.path
			&& binding.file.path === marker.path
			&& binding.view.file === binding.file
			&& this.isManagedBindingContinuationCurrent(owner.continuation, binding);
	}

	private preserveOrphanedExternalDiskMutationAfterOwnerChange(
		marker: PendingExternalDiskMutation,
	): void {
		if (marker.eligibleOwners === null) return;
		const hasCurrentUnconsumedOwner = Array.from(marker.eligibleOwners.entries()).some(
			([leafId]) => {
				if (marker.consumedLeafIds.has(leafId)) return false;
				const currentBinding = this.bindings.get(leafId);
				return !!currentBinding
					&& this.isPendingExternalDiskMutationEligibleForBinding(
						marker,
						leafId,
						currentBinding,
					);
			},
		);
		if (hasCurrentUnconsumedOwner) return;

		// A cache setter/getter can synchronously close the sole pane while the exact
		// host projection is being rejected. If no original owner remains and no pane
		// already delivered these bytes, hand the exact raw revision to the controller
		// before sequence-scoped retirement. Never let a successor binding consume it.
		const alreadyDelivered = marker.provenance === "self-write"
			|| marker.candidatePublished;
		if (!this.notifyPendingExternalDiskReloadIntercepted(marker)) return;
		this.retireExternalDiskReloadCorrelationThrough(marker.path, marker.sequence);
		this.trace?.("editor", "external-disk-reload-orphaned-owner-preserved", {
			path: marker.path,
			sequence: marker.sequence,
			alreadyDelivered,
		});
	}

	private consumePendingExternalDiskMutation(
		marker: PendingExternalDiskMutation,
		leafId: string,
		binding: EditorBinding,
		lane: string,
	): boolean {
		// Revalidate at the final consumption boundary. Host/cache inspection can
		// synchronously re-enter pane lifecycle code after the earlier filter check.
		if (!this.isPendingExternalDiskMutationEligibleForBinding(marker, leafId, binding)) {
			this.trace?.("editor", "external-disk-reload-consume-owner-changed", {
				path: marker.path,
				leafId,
				sequence: marker.sequence,
				lane,
				bindingCurrent: this.bindings.get(leafId) === binding,
			});
			this.preserveOrphanedExternalDiskMutationAfterOwnerChange(marker);
			return false;
		}
		const start = this.pendingExternalDiskMutationStarts.get(marker.path);
		if (start?.sequence === marker.sequence) {
			start.views.delete(leafId);
			if (start.views.size === 0) {
				this.pendingExternalDiskMutationStarts.delete(marker.path);
			}
		}
		marker.consumedLeafIds.add(leafId);
		if (marker.retireScheduled) return true;
		const allLiveBindingsConsumed = () => Array.from(this.bindings.entries())
			.filter(([, binding]) =>
				binding.path === marker.path
					&& binding.view.file === binding.file
					&& binding.file.path === marker.path
			)
			.filter(([candidateLeafId, candidateBinding]) =>
				this.isPendingExternalDiskMutationEligibleForBinding(
					marker,
					candidateLeafId,
					candidateBinding,
				)
			)
			.every(([candidateLeafId]) => marker.consumedLeafIds.has(candidateLeafId));
		if (!allLiveBindingsConsumed()) return true;

		// Keep the marker through the remainder of transaction construction. A
		// later filter may recreate changes after our filter returned [], and the
		// final extender must still recognize that exact external document.
		marker.retireScheduled = true;
		queueMicrotask(() => {
			if (this.pendingExternalDiskMutations.get(marker.path) !== marker) return;
			if (marker.retireScheduled && allLiveBindingsConsumed()) {
				this.pendingExternalDiskMutations.delete(marker.path);
			} else {
				marker.retireScheduled = false;
			}
		});
		return true;
	}

	private rememberRecentEditorOriginChange(candidate: RecentEditorOriginChange): void {
		if (!this.asyncAuthorityOpen) return;
		this.recentEditorOriginChanges.set(candidate.path, candidate);
		this.scheduleExternalDiskCorrelationTimer(() => {
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
		const validationAuthorityEpoch = this.readAuthorityEpoch();
		if (!this.isManagedBindingContinuationCurrent(candidate.continuation, candidate.binding)) {
			return false;
		}
		if (this.bindings.get(candidate.leafId) !== candidate.binding) return false;
		if (candidate.binding.view.file !== candidate.continuation.targetFile) return false;
		if (candidate.binding.view.file !== candidate.binding.file) return false;
		if (candidate.binding.file.path !== candidate.path) return false;
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
		let editorContent: string;
		try {
			editorContent = candidate.binding.view.editor.getValue();
		} catch {
			return false;
		}
		if (editorContent !== candidate.afterContent) return false;
		// `getValue()` can synchronously re-enter the handoff/provider lanes.
		// Finish with manager-owned identity and revision checks before the caller
		// is allowed to roll the rejected external bytes out of Y.Text.
		return this.readAuthorityEpoch() === validationAuthorityEpoch
			&& this.isManagedBindingContinuationCurrent(candidate.continuation, candidate.binding)
			&& this.bindings.get(candidate.leafId) === candidate.binding
			&& candidate.binding.view.file === candidate.binding.file
			&& candidate.binding.file.path === candidate.path
			&& (this.bindingEpochByLeafId.get(candidate.leafId) ?? 0) === candidate.bindingEpoch
			&& (this.editorRevisionByCm.get(candidate.cm) ?? 0) === candidate.expectedEditorRevision
			&& this.vaultSync.getTextForPath(candidate.path) === candidate.ytext
			&& candidate.ytext.toJSON() === candidate.afterContent;
	}

	private clearExternalDiskReloadCorrelation(
		path: string,
		throughSequence = this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0,
	): boolean {
		if (!this.asyncAuthorityOpen) return true;
		// Candidate delivery may synchronously re-enter begin/completion for a newer
		// event on this path. Capture every exact owner before the callback and clear
		// it only if both identity and sequence are still the ones being invalidated.
		const pending = this.pendingExternalDiskMutations.get(path);
		const start = this.pendingExternalDiskMutationStarts.get(path);
		const recentEditorChange = this.recentEditorOriginChanges.get(path);
		if (pending && pending.sequence <= throughSequence) {
			this.notifyPendingExternalDiskReloadIntercepted(pending);
		}
		if (
			pending
			&& pending.sequence <= throughSequence
			&& this.pendingExternalDiskMutations.get(path) === pending
		) {
			this.pendingExternalDiskMutations.delete(path);
		}
		if (
			start
			&& start.sequence <= throughSequence
			&& this.pendingExternalDiskMutationStarts.get(path) === start
		) {
			this.pendingExternalDiskMutationStarts.delete(path);
		}
		if (
			recentEditorChange
			&& recentEditorChange.observedDiskSequence <= throughSequence
			&& this.recentEditorOriginChanges.get(path) === recentEditorChange
		) {
			this.recentEditorOriginChanges.delete(path);
		}
		return true;
	}

	private retireExternalDiskMutationStartThrough(
		path: string,
		throughSequence: number,
	): void {
		if (!this.asyncAuthorityOpen) return;
		const start = this.pendingExternalDiskMutationStarts.get(path);
		if (start && start.sequence <= throughSequence) {
			this.pendingExternalDiskMutationStarts.delete(path);
		}
	}

	/**
	 * Retire one completed exact notice without erasing a newer in-flight event on
	 * the same path. Lifecycle invalidation remains path-wide; async read
	 * completion is sequence-scoped.
	 */
	private retireExternalDiskReloadCorrelationThrough(
		path: string,
		throughSequence: number,
	): void {
		if (!this.asyncAuthorityOpen) return;
		const pending = this.pendingExternalDiskMutations.get(path);
		if (pending && pending.sequence <= throughSequence) {
			this.pendingExternalDiskMutations.delete(path);
		}
		const start = this.pendingExternalDiskMutationStarts.get(path);
		if (start && start.sequence <= throughSequence) {
			this.pendingExternalDiskMutationStarts.delete(path);
		}
		const recentEditorChange = this.recentEditorOriginChanges.get(path);
		const latestObservedSequence =
			this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (
			recentEditorChange
			&& latestObservedSequence <= throughSequence
			&& recentEditorChange.observedDiskSequence <= throughSequence
		) {
			this.recentEditorOriginChanges.delete(path);
		}
		const previous = this.lastExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (throughSequence > previous) {
			this.lastExternalDiskMutationSequenceByPath.set(path, throughSequence);
		}
	}

	private invalidateExternalDiskReloadCorrelation(
		path: string,
		throughSequence = this.observedExternalDiskMutationSequenceByPath.get(path) ?? 0,
	): void {
		if (!this.asyncAuthorityOpen) return;
		if (!this.clearExternalDiskReloadCorrelation(path, throughSequence)) return;
		const previous = this.lastExternalDiskMutationSequenceByPath.get(path) ?? 0;
		if (throughSequence > previous) {
			// A proof started for an earlier binding/runtime lifetime must not arm a
			// later editor if its asynchronous read finishes after the transition.
			this.lastExternalDiskMutationSequenceByPath.set(path, throughSequence);
		}
	}

	private attemptExternalDiskReloadDelivery(
		notice: ExternalDiskMutationNotice,
	): ExternalDiskCandidateDeliveryAttempt {
		if (!this.asyncAuthorityOpen || notice.content === null) {
			return "callback-unavailable";
		}
		if (
			this.hasSelfWriteExternalDiskMutationDisposition(
				notice.path,
				notice.sequence,
			)
			|| this.hasExternalDiskCandidateDisposition(
				this.deliveredExternalDiskCandidateSequencesByPath,
				notice.path,
				notice.sequence,
			)
		) return "already-resolved";
		const callback = this.onExternalDiskReloadIntercepted;
		if (!callback) return "callback-unavailable";
		if (!this.claimExternalDiskCandidate(notice.path, notice.sequence)) {
			return "claim-busy";
		}
		const candidate: InterceptedExternalDiskMutation = Object.freeze({
			path: notice.path,
			ctime: notice.ctime,
			mtime: notice.mtime,
			size: notice.size,
			sequence: notice.sequence,
			observedAt: notice.observedAt,
			content: notice.content,
		});
		try {
			callback(candidate);
		} catch (error) {
			this.releaseExternalDiskCandidateClaim(notice.path, notice.sequence);
			this.trace?.("editor", "external-disk-candidate-callback-failed", {
				path: notice.path,
				sequence: notice.sequence,
				error: error instanceof Error ? error.message : String(error),
			});
			return "callback-failed";
		}
		this.rememberExternalDiskCandidateDisposition(
			this.deliveredExternalDiskCandidateSequencesByPath,
			notice.path,
			notice.sequence,
		);
		// Callback reentry may have observed the in-flight claim and installed an
		// exact retry. The outer success is authoritative and cancels that retry.
		this.clearExternalDiskCandidateDeliveryRetry(notice.path, notice.sequence);
		this.releaseExternalDiskCandidateClaim(notice.path, notice.sequence);
		if (
			typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
			&& __KAOS_QA_HARNESS_ENABLED__
		) {
			editorHandoffHostQaBarriers?.get(this)?.recordInterceptedExternalDiskMutation(
				Object.freeze({
					path: notice.path,
					sequence: notice.sequence,
					observedAt: notice.observedAt,
					contentHash: sha256HandoffRecoveryHexSync(notice.content),
				}),
			);
		}
		return "delivered";
	}

	private deliverExternalDiskReloadOrRetain(
		notice: ExternalDiskMutationNotice,
	): ExternalDiskCandidateDeliveryDisposition {
		// Once callback failure transfers the raw revision here, that first frozen
		// candidate remains the exact retry payload even if a malformed duplicate
		// completion later reuses the sequence with different fields.
		const retainedCandidate = this.pendingExternalDiskCandidateDeliveryRetries
			.get(notice.path)?.get(notice.sequence)?.candidate;
		const exactNotice = retainedCandidate ?? notice;
		const attempt = this.attemptExternalDiskReloadDelivery(exactNotice);
		if (attempt === "delivered" || attempt === "already-resolved") {
			this.clearExternalDiskCandidateDeliveryRetry(notice.path, notice.sequence);
			return "delivered";
		}
		if (attempt === "callback-unavailable") {
			// There is no downstream owner in this manager configuration. In
			// particular, do not create an unbounded retry timer that can never fire.
			return "callback-unavailable";
		}
		return this.rememberExternalDiskCandidateDeliveryRetry(exactNotice)
			? "retained-for-retry"
			: "callback-unavailable";
	}

	private rememberExternalDiskCandidateDeliveryRetry(
		notice: ExternalDiskMutationNotice,
	): boolean {
		if (
			!this.asyncAuthorityOpen
			|| notice.content === null
			|| !this.onExternalDiskReloadIntercepted
			|| this.hasSelfWriteExternalDiskMutationDisposition(
				notice.path,
				notice.sequence,
			)
			|| this.hasExternalDiskCandidateDisposition(
				this.deliveredExternalDiskCandidateSequencesByPath,
				notice.path,
				notice.sequence,
			)
		) return false;
		let retries = this.pendingExternalDiskCandidateDeliveryRetries.get(notice.path);
		if (!retries) {
			retries = new Map<number, PendingExternalDiskCandidateDeliveryRetry>();
			this.pendingExternalDiskCandidateDeliveryRetries.set(notice.path, retries);
		}
		let retry = retries.get(notice.sequence);
		if (!retry) {
			retry = {
				candidate: Object.freeze({
					path: notice.path,
					ctime: notice.ctime,
					mtime: notice.mtime,
					size: notice.size,
					sequence: notice.sequence,
					observedAt: notice.observedAt,
					content: notice.content,
				}),
				retryAttempt: 0,
				timer: null,
			};
			retries.set(notice.sequence, retry);
		}
		this.scheduleExternalDiskCandidateDeliveryRetry(retry);
		return retry.timer !== null;
	}

	private scheduleExternalDiskCandidateDeliveryRetry(
		retry: PendingExternalDiskCandidateDeliveryRetry,
	): void {
		if (retry.timer !== null || !this.asyncAuthorityOpen) return;
		const delay = EXTERNAL_DISK_CANDIDATE_RETRY_DELAYS_MS[
			Math.min(
				retry.retryAttempt,
				EXTERNAL_DISK_CANDIDATE_RETRY_DELAYS_MS.length - 1,
			)
		];
		const timer = setTimeout(() => {
			const retries = this.pendingExternalDiskCandidateDeliveryRetries.get(
				retry.candidate.path,
			);
			if (
				retries?.get(retry.candidate.sequence) !== retry
				|| retry.timer !== timer
			) return;
			retry.timer = null;
			this.retryExternalDiskCandidateDelivery(
				retry.candidate.path,
				retry.candidate.sequence,
			);
		}, delay);
		retry.timer = timer;
		(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	}

	private retryExternalDiskCandidateDelivery(path: string, sequence: number): void {
		const retry = this.pendingExternalDiskCandidateDeliveryRetries
			.get(path)?.get(sequence);
		if (!retry || !this.asyncAuthorityOpen) return;
		if (retry.timer !== null) {
			clearTimeout(retry.timer);
			retry.timer = null;
		}
		retry.retryAttempt += 1;
		const disposition = this.deliverExternalDiskReloadOrRetain(retry.candidate);
		if (disposition === "callback-unavailable") {
			this.clearExternalDiskCandidateDeliveryRetry(path, sequence);
		}
	}

	private clearExternalDiskCandidateDeliveryRetry(path: string, sequence: number): void {
		const retries = this.pendingExternalDiskCandidateDeliveryRetries.get(path);
		const retry = retries?.get(sequence);
		if (!retries || !retry) return;
		if (retry.timer !== null) clearTimeout(retry.timer);
		retries.delete(sequence);
		if (retries.size === 0) {
			this.pendingExternalDiskCandidateDeliveryRetries.delete(path);
		}
	}

	private clearAllExternalDiskCandidateDeliveryRetries(): void {
		for (const retries of this.pendingExternalDiskCandidateDeliveryRetries.values()) {
			for (const retry of retries.values()) {
				if (retry.timer !== null) clearTimeout(retry.timer);
			}
		}
		this.pendingExternalDiskCandidateDeliveryRetries.clear();
	}

	private rememberExternalDiskCandidateDisposition(
		dispositions: ExternalDiskCandidateDispositionLedger,
		path: string,
		sequence: number,
	): void {
		if (!this.asyncAuthorityOpen) return;
		let entries = dispositions.get(path);
		if (!entries) {
			entries = new Map<number, ExternalDiskCandidateDispositionEntry>();
			dispositions.set(path, entries);
		}
		if (entries.has(sequence)) return;
		const entry: ExternalDiskCandidateDispositionEntry = {
			sequence,
			timer: null,
		};
		entries.set(sequence, entry);
		while (entries.size > EXTERNAL_DISK_CANDIDATE_DISPOSITION_PER_PATH_LIMIT) {
			const oldest = entries.values().next().value as
				| ExternalDiskCandidateDispositionEntry
				| undefined;
			if (!oldest) break;
			if (oldest.timer !== null) clearTimeout(oldest.timer);
			entries.delete(oldest.sequence);
		}
		const timer = setTimeout(() => {
			const currentEntries = dispositions.get(path);
			if (currentEntries?.get(sequence) !== entry || entry.timer !== timer) return;
			currentEntries.delete(sequence);
			if (currentEntries.size === 0) dispositions.delete(path);
		}, EXTERNAL_DISK_CANDIDATE_DISPOSITION_TTL_MS);
		entry.timer = timer;
		(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	}

	private hasExternalDiskCandidateDisposition(
		dispositions: ExternalDiskCandidateDispositionLedger,
		path: string,
		sequence: number,
	): boolean {
		return dispositions.get(path)?.has(sequence) ?? false;
	}

	private activateSelfWriteExternalDiskMutation(path: string, sequence: number): boolean {
		let sequences = this.activeSelfWriteExternalDiskMutationSequencesByPath.get(path);
		if (!sequences) {
			sequences = new Set<number>();
			this.activeSelfWriteExternalDiskMutationSequencesByPath.set(path, sequences);
		}
		if (sequences.has(sequence)) return false;
		sequences.add(sequence);
		return true;
	}

	private releaseActiveSelfWriteExternalDiskMutation(
		path: string,
		sequence: number,
		ownsDisposition: boolean,
	): void {
		if (!ownsDisposition) return;
		const sequences = this.activeSelfWriteExternalDiskMutationSequencesByPath.get(path);
		if (!sequences) return;
		sequences.delete(sequence);
		if (sequences.size === 0) {
			this.activeSelfWriteExternalDiskMutationSequencesByPath.delete(path);
		}
	}

	private hasSelfWriteExternalDiskMutationDisposition(
		path: string,
		sequence: number,
	): boolean {
		return this.activeSelfWriteExternalDiskMutationSequencesByPath
			.get(path)?.has(sequence) === true
			|| this.hasExternalDiskCandidateDisposition(
				this.selfWriteExternalDiskMutationSequencesByPath,
				path,
				sequence,
			);
	}

	private clearExternalDiskCandidateDispositionLedger(
		dispositions: ExternalDiskCandidateDispositionLedger,
	): void {
		for (const entries of dispositions.values()) {
			for (const entry of entries.values()) {
				if (entry.timer !== null) clearTimeout(entry.timer);
			}
		}
		dispositions.clear();
	}

	private claimExternalDiskCandidate(path: string, sequence: number): boolean {
		let sequences = this.claimedExternalDiskCandidateSequencesByPath.get(path);
		if (!sequences) {
			sequences = new Set<number>();
			this.claimedExternalDiskCandidateSequencesByPath.set(path, sequences);
		}
		if (sequences.has(sequence)) return false;
		sequences.add(sequence);
		return true;
	}

	private releaseExternalDiskCandidateClaim(path: string, sequence: number): void {
		const sequences = this.claimedExternalDiskCandidateSequencesByPath.get(path);
		if (!sequences) return;
		sequences.delete(sequence);
		if (sequences.size === 0) {
			this.claimedExternalDiskCandidateSequencesByPath.delete(path);
		}
	}

	private notifyPendingExternalDiskReloadIntercepted(
		marker: PendingExternalDiskMutation,
	): boolean {
		if (marker.provenance === "self-write") return true;
		if (marker.candidatePublished) return true;
		const disposition = this.deliverExternalDiskReloadOrRetain(marker);
		if (disposition === "delivered") marker.candidatePublished = true;
		// A failed immediate callback is an admitted exact retry owner. The path
		// marker can now retire or be replaced without losing its raw revision.
		return true;
	}

	private fenceStaleUserBinding(transaction: Transaction): TransactionSpec | null {
		if (!transaction.docChanged || !this.isUserTransaction(transaction)) {
			return null;
		}
		const match = this.findBindingForState(transaction.startState);
		if (!match) return null;
		const { leafId, binding } = match;
		const targetFile = binding.view.file;
		const currentPath = targetFile?.path ?? null;
		if (targetFile === binding.file && binding.file.path === binding.path) return null;
		if (targetFile) this.beginPathHandoff(binding.view, targetFile, "stale-user");
		this.trace?.("editor", "stale-binding-detached-before-user-input", {
			leafId,
			boundPath: binding.path,
			currentPath,
			cmId: binding.cmId,
		});

		return { effects: this.compartment.reconfigure([]) };
	}

	private hasRecentUserDocumentEdit(binding: EditorBinding, windowMs: number): boolean {
		const lastDocChangeAt = binding.lastEditorDocChangeAtMs;
		return lastDocChangeAt != null && Date.now() - lastDocChangeAt < windowMs;
	}

	private recordYTextPatch(
		ytext: Y.Text,
		_installedPath: string,
		leafId: string,
		transaction: Y.Transaction,
	): void {
		const direct = this.bindings.get(leafId);
		const exactBindings = direct?.ytext === ytext
			? [direct]
			: Array.from(this.bindings.values()).filter((candidate) =>
				candidate.ytext === ytext
				&& candidate.view.file === candidate.file
				&& candidate.file.path === candidate.path
			);
		const binding = exactBindings[0];
		if (
			!binding
			|| binding.ytext !== ytext
			|| binding.view.file !== binding.file
			|| binding.file.path !== binding.path
			|| exactBindings.some((candidate) => candidate.path !== binding.path)
		) return;
		this.advanceAuthorityEpoch();
		let revision = this.yTextMutationRevisionByText.get(ytext) ?? 0;
		if (this.lastYTextMutationTransactionByText.get(ytext) !== transaction) {
			revision += 1;
			this.yTextMutationRevisionByText.set(ytext, revision);
			this.lastYTextMutationTransactionByText.set(ytext, transaction);
		}
		this.pendingYTextPatches.set(ytext, {
			origin: transaction.origin,
			path: binding.path,
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
		this.manageView(binding.view);
		if (this.bindings.get(leafId) !== binding) return;
		this.advanceAuthorityEpoch();
		this.editorAuthorityShieldLeafIds.add(leafId);
		this.clearScheduledHealthCheck(leafId);
		this.clearCmResolveRetry(leafId);
		this.healthWorkInFlight.delete(leafId);
		this.advanceAuthorityEpoch();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);
		this.pendingReplacementCmToLeafId.delete(binding.cm);
		const bindingEpoch = this.bumpBindingEpoch(leafId);
		this.destroyUndoManagerOnce(binding.undoManager);
		const runtime = this.managedSessions.get(leafId);
		if (runtime?.session.view === binding.view) {
			this.advanceAuthorityEpoch();
			runtime.session = {
				...runtime.session,
				generation: runtime.session.generation + 1,
				binding: { kind: "unbound" },
				handoff: null,
				completedDetachEpoch: bindingEpoch,
			};
		}
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
		const continuation = this.captureManagedContinuation(binding.view);
		if (!continuation) {
			this.editorAuthorityShieldLeafIds.delete(leafId);
			return;
		}
		this.editorAuthorityShieldContinuations.set(leafId, continuation);

		queueMicrotask(() => {
			if (this.editorAuthorityShieldContinuations.get(leafId) !== continuation) return;
			this.editorAuthorityShieldContinuations.delete(leafId);
			this.editorAuthorityShieldLeafIds.delete(leafId);
			if (!this.isManagedContinuationCurrent(continuation)) return;
			this.applyEditorAuthorityAfterShield(
				binding,
				editorContent,
				incomingContent,
				expectedYText,
				expectedYTextContent,
				blockedOrigin,
				continuation,
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
		continuation: ManagedContinuationTicket,
	): void {
		if (!this.isManagedContinuationCurrent(continuation)) return;
		const file = binding.view.file;
		if (
			!file
			|| file !== continuation.targetFile
			|| file !== binding.file
			|| file.path !== continuation.targetPath
			|| file.path !== binding.path
		) return;
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
			if (!this.isManagedContinuationCurrent(continuation)) return;
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
			const authority = this.capturePathEditorAuthority(binding.path);
			if (
				authority.kind !== "proven-single"
				|| authority.content !== editorContent
				|| !this.isManagedContinuationCurrent(continuation)
				|| !this.isPathEditorAuthorityLeaseCurrent(authority.lease)
			) return;
			this.advanceAuthorityEpoch();
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

		if (!this.isManagedContinuationCurrent(continuation)) return;
		this.bind(binding.view, this.lastDeviceName);
	}

	private handleLiveEditorUpdate(update: ViewUpdate): void {
		if (update.docChanged) {
			const leafId = this.cmToLeafId.get(update.view);
			void leafId;
		}
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
			this.advanceAuthorityEpoch();
			this.editorRevisionByCm.set(
				update.view,
				(this.editorRevisionByCm.get(update.view) ?? 0) + 1,
			);
			const adoptionTransactionAdvance = Math.max(
				1,
				update.transactions.filter((transaction) => transaction.docChanged).length,
			);
			this.samePathAdoptionTransactionSeqByCm.set(
				update.view,
				(this.samePathAdoptionTransactionSeqByCm.get(update.view) ?? 0)
					+ adoptionTransactionAdvance,
			);
			const leafId = this.cmToLeafId.get(update.view);
			const runtime = leafId ? this.managedSessions.get(leafId) : undefined;
			const adoptionFrame = this.activeSamePathAdoptionDispatchFrame;
			const changedTransactions = update.transactions.filter(
				(transaction) => transaction.docChanged,
			);
			const acceptedAdoptionProjection = !!runtime
				&& adoptionFrame !== null
				&& adoptionFrame.runtime === runtime
				&& adoptionFrame.cm === update.view
				&& changedTransactions.length === 1
				&& changedTransactions[0]?.startState === adoptionFrame.startState
				&& changedTransactions[0]?.annotation(SAME_PATH_ADOPTION_TRANSACTION)
					?.proposal === adoptionFrame.proposal
				&& changedTransactions[0]?.annotation(SAME_PATH_ADOPTION_TRANSACTION)
					?.frameIdentity === adoptionFrame.frameIdentity;
			if (acceptedAdoptionProjection && adoptionFrame) {
				adoptionFrame.updateSeen = true;
			}
			if (
				runtime
				&& runtime.adoption.kind === "conflict"
				&& !acceptedAdoptionProjection
			) {
				this.invalidateSamePathAdoptionConflict(
					runtime.adoption.adoptionId,
					runtime.adoption.path,
					"editor-document-advanced-after-conflict",
				);
			}
			if (
				runtime
				&& (
					runtime.adoption.kind === "capturing"
					|| runtime.adoption.kind === "planning"
				)
				&& !acceptedAdoptionProjection
			) {
				// Keep the path fenced continuously while the newer editor document
				// replaces an in-flight adoption request. Clearing `adoption` before
				// the queued bind/replan otherwise opens a one-microtask window where
				// disk/native-save reconciliation can publish Local over a proven
				// Remote. The explicit required-path hold transfers ownership to the
				// replacement plan and is cleared only by exact adoption settlement or
				// managed-view teardown.
				this.samePathAdoptionRequiredPathByLeafId.set(
					runtime.session.leafId,
					runtime.adoption.path,
				);
				runtime.adoption = NO_SAME_PATH_ADOPTION;
				this.scheduleSamePathAdoptionRefresh(runtime, "editor-document-advanced");
			}
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
		if (update.docChanged) {
			const leafId = this.cmToLeafId.get(update.view);
			const runtime = leafId ? this.managedSessions.get(leafId) : undefined;
			const displayed = runtime?.session.displayedLineage;
			if (
				runtime
				&& displayed?.kind === "known"
				&& displayed.cm === update.view
				&& runtime.session.handoff === null
			) {
				this.advanceAuthorityEpoch();
				runtime.session = {
					...runtime.session,
					displayedLineage: {
						...displayed,
						document: update.state?.doc ?? update.view.state.doc,
						editorRevision: this.editorRevisionByCm.get(update.view) ?? 0,
					},
				};
			}
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
		const continuationBinding = this.findBindingForCm(cm)?.binding;
		if (continuationBinding) this.manageView(continuationBinding.view);
		const continuation = continuationBinding
			? this.captureManagedBindingContinuation(continuationBinding)
			: null;
		queueMicrotask(() => {
			if (
				!continuation
				|| !continuationBinding
				|| !this.isManagedBindingContinuationCurrent(continuation, continuationBinding)
			) {
				return;
			}
			const match = this.findBindingForCm(cm);
			if (
				!match ||
				match.leafId !== bypass.leafId ||
				match.binding.path !== bypass.path ||
				match.binding.view.file !== match.binding.file ||
				match.binding.file.path !== bypass.path ||
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
			if (!this.isManagedBindingContinuationCurrent(continuation, binding)) return;
			const finalMatch = this.findBindingForCm(cm);
			if (
				!finalMatch
				|| finalMatch.leafId !== match.leafId
				|| finalMatch.binding !== binding
				|| finalMatch.binding.view.file !== continuation.targetFile
				|| finalMatch.binding.view.file.path !== continuation.targetPath
				|| (this.bindingEpochByLeafId.get(match.leafId) ?? 0) !== bypass.bindingEpoch
			) return;
			this.advanceAuthorityEpoch();
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

	private isTargetPresentationProven(
		view: MarkdownView,
		file: TFile,
		cm: EditorView,
	): boolean {
		const session = this.getManagedSession(view);
		if (
			!session
			|| session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== file
			|| session.displayedLineage.path !== file.path
			|| session.displayedLineage.cm !== cm
			|| session.displayedLineage.document !== cm.state.doc
		) return false;
		return session.handoff === null;
	}

	private bumpBindingEpoch(leafId: string): number {
		this.advanceAuthorityEpoch();
		const next = (this.bindingEpochByLeafId.get(leafId) ?? 0) + 1;
		this.bindingEpochByLeafId.set(leafId, next);
		return next;
	}

	private isUserDocumentEdit(update: ViewUpdate): boolean {
		if (!update.docChanged) return false;
		return update.transactions.some((transaction) =>
			transaction.docChanged &&
			this.getExternalReloadFilterBypass(transaction) === null &&
			this.isUserTransaction(transaction) &&
			transaction.annotation(Transaction.userEvent)
				!== "input.handoff-replay",
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
		if (this.hasActiveSourceUnloadDrain(this.managedSessions.get(leafId))) return;
		const currentFile = binding.view.file;
		if (
			currentFile
			&& (currentFile !== binding.file || currentFile.path !== binding.path)
		) {
			this.beginPathHandoff(binding.view, currentFile, `health:${source}`);
			return;
		}
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
		const continuation = this.captureManagedContinuation(view);
		if (!continuation) return;
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
				if (this.pendingCmResolveRetries.get(leafId) !== timer) return;
				this.pendingCmResolveRetries.delete(leafId);
				if (!this.isManagedContinuationCurrent(continuation, { allowCmResolution: true })) {
					return;
				}
				this.bind(view, deviceName);
			}, CM_RESOLVE_IDLE_RETRY_DELAY_MS);
			this.pendingCmResolveRetries.set(leafId, timer);
			return;
		}

		const timer = setTimeout(() => {
			if (this.pendingCmResolveRetries.get(leafId) !== timer) return;
			this.pendingCmResolveRetries.delete(leafId);
			if (!this.isManagedContinuationCurrent(continuation, { allowCmResolution: true })) {
				return;
			}
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
		const runtime = this.managedSessions.get(leafId);
		if (this.hasActiveSourceUnloadDrain(runtime)) return;
		const continuation = runtime
			? this.captureManagedContinuation(runtime.session.view)
			: null;
		if (!continuation) return;
		const timer = setTimeout(() => {
			if (this.pendingHealthChecks.get(leafId) !== timer) return;
			this.pendingHealthChecks.delete(leafId);
			if (!this.isManagedContinuationCurrent(continuation)) return;
			if (this.hasActiveSourceUnloadDrain(this.managedSessions.get(leafId))) return;
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
		file?: TFile;
		filePath: string;
		ytext: Y.Text;
		fileId?: string;
		authorityLease?: EditorAuthorityLease;
		samePathAdoptionYtextMutationEpochAtBind?: number;
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
			file,
			filePath,
			ytext,
			fileId,
			authorityLease,
			samePathAdoptionYtextMutationEpochAtBind,
			existing,
			reason,
			rapidSwitch: rapidSwitchHint,
		} = options;
		const bindingFile = file ?? view.file;
		if (!bindingFile || bindingFile.path !== filePath) return false;
		if (
			samePathAdoptionYtextMutationEpochAtBind !== undefined
			&& (
				!Number.isSafeInteger(samePathAdoptionYtextMutationEpochAtBind)
				|| samePathAdoptionYtextMutationEpochAtBind < 0
			)
		) return false;
		this.manageView(view);
		if (!this.requireManagedBoundary(view, `${action}:${reason ?? "apply"}`)) return false;
		let exactLease = authorityLease;
		if (!exactLease) {
			const authority = this.capturePathEditorAuthority(filePath);
			if (authority.kind !== "proven-single" || authority.content !== ytext.toJSON()) {
				return false;
			}
			exactLease = authority.lease;
		}
		if (
			exactLease !== undefined
			&& !this.isPathEditorAuthorityLeaseCurrent(exactLease)
		) return false;

		if (!this.canApplyBindingToEditor({
			action,
			view,
			file: bindingFile,
			leafId,
			filePath,
			ytext,
			cm,
			reason,
		})) {
			return false;
		}

		const undoManager = new Y.UndoManager(ytext);
		const collabExtension = yCollab(ytext, this.vaultSync.provider.awareness, {
			undoManager,
		});
		const guardedCollabExtension = [
			this.createYTextOriginCaptureExtension(ytext, filePath, leafId),
			collabExtension,
		];
		const continuation = this.captureManagedContinuation(view);
		if (
			!continuation
			|| continuation.targetFile !== bindingFile
			|| continuation.targetPath !== filePath
			|| continuation.cm !== cm
			|| !this.isManagedContinuationCurrent(continuation)
		) {
			undoManager.destroy();
			return false;
		}

		this.vaultSync.provider.awareness.setLocalStateField("user", {
			name: deviceName,
			// TODO: configurable color
			color: "#30bced",
			colorLight: "#30bced33",
		});

		if (
			!this.isManagedContinuationCurrent(continuation)
			|| view.file !== bindingFile
			|| bindingFile.path !== filePath
			|| this.getCmView(view) !== cm
			|| this.vaultSync.getTextForPath(filePath) !== ytext
			|| !this.canApplyBindingToEditor({
				action,
				view,
				file: bindingFile,
				leafId,
				filePath,
				ytext,
				cm,
				reason,
			})
			|| (
				exactLease !== undefined
				&& !this.isPathEditorAuthorityLeaseCurrent(exactLease)
			)
		) {
			undoManager.destroy();
			return false;
		}

		const publicationOwner = Object.freeze({
			leafId,
			filePath,
			cmId,
		});
		this.bindingPublicationOwnerByCm.set(cm, publicationOwner);
		let authorityYtextMutationEpochAtBind: number | undefined;
		let localYtextMutationRevisionAtBind: number | undefined;
		if (samePathAdoptionYtextMutationEpochAtBind !== undefined) {
			authorityYtextMutationEpochAtBind =
				samePathAdoptionYtextMutationEpochAtBind;
			localYtextMutationRevisionAtBind =
				this.yTextMutationRevisionByText.get(ytext) ?? 0;
		}
		try {
			this.advanceAuthorityEpoch();
			cm.dispatch({
				effects: this.compartment.reconfigure(guardedCollabExtension),
			});
		} catch (err) {
			if (this.bindingPublicationOwnerByCm.get(cm) === publicationOwner) {
				this.bindingPublicationOwnerByCm.delete(cm);
			}
			undoManager.destroy();
			this.log(
				`${action}: failed "${filePath}" ` +
				`(leaf=${leafId}, cm=${cmId}, reason=${reason ?? "n/a"}): ${String(err)}`,
			);
			return false;
		}
		const postDispatchContentCurrent = this.canApplyBindingToEditor({
			action,
			view,
			file: bindingFile,
			leafId,
			filePath,
			ytext,
			cm,
			reason,
		});
		const postDispatchIdentityCurrent =
			view.file === bindingFile
			&& bindingFile.path === filePath
			&& this.getCmView(view) === cm
			&& this.vaultSync.getTextForPath(filePath) === ytext
			&& this.bindings.get(leafId) === existing;
		const postDispatchContinuationCurrent =
			postDispatchContentCurrent
			&& postDispatchIdentityCurrent
			&& this.isManagedContinuationCurrent(continuation);
		if (
			!postDispatchContinuationCurrent
		) {
			this.destroyUndoManagerOnce(undoManager);
			this.cleanupOwnedBindingPublication(cm, publicationOwner);
			return false;
		}

		if (existing) this.destroyUndoManagerOnce(existing.undoManager);
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
		const prePublicationContentCurrent = this.canApplyBindingToEditor({
			action,
			view,
			file: bindingFile,
			leafId,
			filePath,
			ytext,
			cm,
			reason,
		});
		const prePublicationCurrent = prePublicationContentCurrent
			&& this.bindings.get(leafId) === existing
			&& view.file === bindingFile
			&& bindingFile.path === filePath
			&& this.vaultSync.getTextForPath(filePath) === ytext
			&& this.isManagedContinuationCurrent(continuation);
		if (!prePublicationCurrent) {
			if (
				existing
				&& this.bindings.get(leafId) === existing
				&& this.bindingPublicationOwnerByCm.get(cm) === publicationOwner
			) {
				this.detachBinding(view, "binding-prepublication-invalidated", false);
			}
			this.destroyUndoManagerOnce(undoManager);
			this.cleanupOwnedBindingPublication(cm, publicationOwner);
			return false;
		}

		this.advanceAuthorityEpoch();
		this.bumpBindingEpoch(leafId);
		this.bindings.set(leafId, {
			view,
			file: bindingFile,
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
			authorityYtextMutationEpochAtBind,
			localYtextMutationRevisionAtBind,
		});
		const runtime = this.managedSessions.get(leafId);
		if (runtime?.session.view === view) {
			const currentHandoff = runtime.session.handoff;
			if (currentHandoff === null) {
				this.advanceAuthorityEpoch();
				runtime.session = {
					...runtime.session,
					displayedLineage: {
						kind: "known",
						file: bindingFile,
						path: filePath,
						fileId: fileId ?? null,
						cm,
						document: cm.state.doc,
						editorRevision: this.editorRevisionByCm.get(cm) ?? 0,
					},
					binding: fileId
						? { kind: "bound", path: filePath, fileId, ytext }
						: { kind: "unbound" },
				};
			}
		}
		const binding = this.bindings.get(leafId);
		if (!binding) return false;
		this.cmToLeafId.set(cm, leafId);
		this.publishLocalActiveFile(binding);
		const publicationRuntime = this.managedSessions.get(leafId);
		const publicationDisplayed = publicationRuntime?.session.displayedLineage;
		const publicationCurrent = this.canApplyBindingToEditor({
			action,
			view,
			file: bindingFile,
			leafId,
			filePath,
			ytext,
			cm,
			reason,
		})
			&& this.bindings.get(leafId) === binding
			&& view.file === bindingFile
			&& bindingFile.path === filePath
			&& this.vaultSync.getTextForPath(filePath) === ytext
			&& publicationRuntime?.session.view === view
			&& publicationRuntime.session.sessionId === continuation.sessionId
			&& publicationRuntime.session.generation === continuation.handoffGeneration
			&& publicationDisplayed?.kind === "known"
			&& publicationDisplayed.file === bindingFile
			&& publicationDisplayed.path === filePath
			&& publicationDisplayed.cm === cm;
		if (!publicationCurrent) {
			if (
				this.bindings.get(leafId) === binding
				&& this.bindingPublicationOwnerByCm.get(cm) === publicationOwner
			) {
				this.detachBinding(view, "binding-publication-reentered", false);
			}
			return false;
		}
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
		this.scheduleUnboundSamePathPeers(filePath, leafId);
		return true;
	}

	private scheduleUnboundSamePathPeers(path: string, boundLeafId: string): void {
		for (const [leafId, runtime] of this.managedSessions) {
			if (
				leafId === boundLeafId
				|| runtime.session.view.file?.path !== path
				|| runtime.session.binding.kind !== "unbound"
				|| runtime.adoption.kind !== "none"
				|| this.bindings.has(leafId)
			) continue;
			this.scheduleSamePathAdoptionRefresh(runtime, "same-path-peer-bound");
		}
	}

	private canApplyBindingToEditor(input: {
		action: "bind" | "repair";
		view: MarkdownView;
		file: TFile;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		cm: EditorView;
		reason?: string;
	}): boolean {
		if (
			input.view.file !== input.file
			|| input.file.path !== input.filePath
		) {
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
		if (!file || file !== binding.file || file.path !== binding.path) return false;
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

	private scheduleSamePathAdoptionRefresh(
		runtime: ManagedLeafRuntime,
		reason: string,
	): void {
		const leafId = runtime.session.leafId;
		if (this.samePathAdoptionRefreshScheduled.has(leafId)) return;
		const pendingRetry = this.pendingSamePathAdoptionRetries.get(leafId);
		if (pendingRetry) clearTimeout(pendingRetry);
		this.pendingSamePathAdoptionRetries.delete(leafId);
		this.samePathAdoptionRefreshScheduled.add(leafId);
		queueMicrotask(() => {
			this.samePathAdoptionRefreshScheduled.delete(leafId);
			if (
				!this.asyncAuthorityOpen
				|| this.managedSessions.get(leafId) !== runtime
				|| runtime.session.view.file === null
			) return;
			this.bind(runtime.session.view, this.lastDeviceName);
			this.trace?.("editor", "same-path-adoption-refreshed", {
				leafId,
				path: runtime.session.view.file?.path ?? null,
				reason,
			});
			const requiredPath =
				this.samePathAdoptionRequiredPathByLeafId.get(leafId) ?? null;
			const retryScopeActive = requiredPath !== null
				&& runtime.session.view.file?.path === requiredPath
				&& runtime.session.binding.kind === "unbound"
				&& !this.bindings.has(leafId);
			if (!retryScopeActive) {
				this.samePathAdoptionRetryAttempts.delete(leafId);
				return;
			}
			if (runtime.adoption.kind === "none") {
				this.scheduleSamePathAdoptionRetry(runtime, requiredPath, reason);
			}
		});
	}

	private scheduleSamePathAdoptionRetry(
		runtime: ManagedLeafRuntime,
		requiredPath: string,
		reason: string,
	): void {
		const leafId = runtime.session.leafId;
		if (this.pendingSamePathAdoptionRetries.has(leafId)) return;
		const attempt = (this.samePathAdoptionRetryAttempts.get(leafId) ?? 0) + 1;
		this.samePathAdoptionRetryAttempts.set(leafId, attempt);
		const delayMs = SAME_PATH_ADOPTION_RETRY_DELAYS_MS[
			Math.min(attempt - 1, SAME_PATH_ADOPTION_RETRY_DELAYS_MS.length - 1)
		];
		const timer = setTimeout(() => {
			if (this.pendingSamePathAdoptionRetries.get(leafId) !== timer) return;
			this.pendingSamePathAdoptionRetries.delete(leafId);
			const current = this.managedSessions.get(leafId);
			if (
				current !== runtime
				|| !this.asyncAuthorityOpen
				|| this.samePathAdoptionRequiredPathByLeafId.get(leafId) !== requiredPath
			) return;
			this.scheduleSamePathAdoptionRefresh(
				runtime,
				`${reason}:required-retry`,
			);
		}, delayMs);
		this.pendingSamePathAdoptionRetries.set(leafId, timer);
		this.trace?.("editor", "same-path-adoption-retry-scheduled", {
			leafId,
			path: requiredPath,
			reason,
			attempt,
			delayMs,
		});
	}

	private publishSamePathAdoptionConflict(
		request: SamePathAdoptionRequest,
		receipt: SamePathAdoptionConflictReceipt,
	): void {
		for (const ticketView of request.openEditorTicket.views) {
			const runtime = this.managedSessions.get(ticketView.leafId);
			if (
				!runtime
				|| runtime.session.view !== ticketView.view
				|| runtime.session.sessionId !== ticketView.sessionId
				|| runtime.session.generation !== ticketView.handoffGeneration
				|| runtime.session.view.file !== ticketView.targetFile
				|| ticketView.targetFile.path !== request.path
			) continue;
			const editorArtifact = receipt.editorArtifacts.find((artifact) =>
				artifact.leafIds.includes(ticketView.leafId)
			) ?? null;
			runtime.adoption = Object.freeze({
				kind: "conflict",
				adoptionId: receipt.adoptionId,
				path: receipt.path,
				status: receipt.status,
				retryable: receipt.retryable,
				mergeMode: receipt.mergeMode,
				baseHash: receipt.baseHash,
				crdtArtifactPath: receipt.crdtArtifactPath,
				editorArtifactPath: editorArtifact?.path ?? null,
				editorArtifactPaths: receipt.editorArtifactPaths,
				failureReason: receipt.failureReason,
				remoteText: request.ytext?.toJSON() ?? "",
			});
		}
	}

	private invalidateSamePathAdoptionConflict(
		adoptionId: string,
		path: string,
		reason: string,
	): void {
		for (const runtime of this.managedSessions.values()) {
			if (
				runtime.adoption.kind !== "conflict"
				|| runtime.adoption.adoptionId !== adoptionId
				|| runtime.adoption.path !== path
			) continue;
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			this.scheduleSamePathAdoptionRefresh(runtime, reason);
		}
	}

	private abandonSamePathAdoption(
		proposal: SamePathAdoptionProposal,
		reason: string,
		partialCommit: boolean,
	): void {
		if (
			partialCommit
			|| reason === "bind-permit-rejected"
			|| reason === "pre-bind-runtime-stale"
			|| reason === "binding-publication-failed"
			|| reason === "post-bind-identity-failed"
		) {
			this.samePathAdoptionRequiredPathByLeafId.set(
				proposal.request.leafId,
				proposal.path,
			);
		}
		const runtime = this.managedSessions.get(proposal.request.leafId);
		if (
			runtime
			&& runtime.adoption.kind === "planning"
			&& runtime.adoption.proposal === proposal
			&& runtime.adoption.adoptionId === proposal.adoptionId
		) {
			this.advanceAuthorityEpoch();
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			this.scheduleSamePathAdoptionRefresh(runtime, reason);
		}
		this.trace?.(
			"editor",
			partialCommit ? "partial-adoption-commit" : "same-path-adoption-replan",
			{
				leafId: proposal.request.leafId,
				path: proposal.path,
				proposalId: proposal.proposalId,
				reason,
			},
		);
	}

	private isExactAlreadySettledBoundPeer(
		ticket: OpenEditorMutationTicket["views"][number],
		proposal: SamePathAdoptionProposal,
		targetText: string,
	): boolean {
		if (
			proposal.plan.kind !== "already-settled"
			|| ticket.leafId === proposal.request.leafId
			|| ticket.cm === null
		) return false;
		const runtime = this.managedSessions.get(ticket.leafId);
		const session = runtime?.session;
		const binding = this.bindings.get(ticket.leafId);
		const displayed = session?.displayedLineage;
		return !!runtime
			&& !!session
			&& !!binding
			&& runtime.adoption.kind === "none"
			&& session.view === ticket.view
			&& session.view.file === proposal.file
			&& session.handoff === null
			&& session.binding.kind === "bound"
			&& session.binding.path === proposal.path
			&& session.binding.fileId === proposal.fileId
			&& session.binding.ytext === proposal.ytext
			&& displayed?.kind === "known"
			&& displayed.file === proposal.file
			&& displayed.path === proposal.path
			&& displayed.cm === ticket.cm
			&& displayed.document === ticket.editorDocument
			&& binding.view === ticket.view
			&& binding.file === proposal.file
			&& binding.path === proposal.path
			&& binding.fileId === proposal.fileId
			&& binding.ytext === proposal.ytext
			&& binding.cm === ticket.cm
			&& this.getCmView(ticket.view) === ticket.cm
			&& ticket.cm.state.doc === ticket.editorDocument
			&& ticket.cm.state.doc.toString() === targetText
			&& ticket.editorContent === targetText;
	}

	private captureSamePathAdoptionPostMutationProof(
		proposal: SamePathAdoptionProposal,
		targetText: string,
		ytextMutationEpoch: number,
	): SamePathAdoptionPostMutationProof | null {
		const request = proposal.request;
		const runtime = this.managedSessions.get(request.leafId);
		let session = runtime?.session;
		if (
			!runtime
			|| !session
			|| runtime.adoption.kind !== "planning"
			|| runtime.adoption.proposal !== proposal
			|| runtime.adoption.adoptionId !== request.adoptionId
			|| runtime.adoption.requestId !== request.requestId
			|| session.sessionId !== request.sessionId
			|| session.generation !== request.generation
			|| session.view !== runtime.adoption.view
			|| session.view.file !== request.file
			|| session.handoff !== null
			|| session.binding.kind !== "unbound"
			|| this.bindings.has(request.leafId)
			|| this.getCmView(session.view) !== request.cm
			|| request.cm.state.doc.toString() !== targetText
			|| proposal.ytext.toJSON() !== targetText
			|| this.vaultSync.getTextForPath(request.path) !== proposal.ytext
		) return null;

		const host = runtime.hostGuard?.snapshot() ?? null;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		if (
			host === null
			|| host.hostCapabilityState !== "ready"
			|| host.hostCapability !== proposal.hostCapability
			|| host.saveEpoch !== proposal.hostSaveEpoch
			|| host.mode.kind !== "pass-through"
			|| host.sourceUnload !== null
			|| !hasExactHostGuardWrappers(host)
			|| !hasNoPendingHostLoadOwner(host)
			|| guard === null
			|| guard.view !== request.cm
			|| guard.inert
			|| guard.gateClosed
			|| guard.pendingHostLoadCandidate !== null
			|| guard.activeComposition !== null
		) return null;

		if (session.nativeHistoryEpoch !== guard.nativeHistoryEpoch) {
			this.advanceAuthorityEpoch();
			runtime.session = {
				...session,
				nativeHistoryEpoch: guard.nativeHistoryEpoch,
			};
			session = runtime.session;
		}
		const document = request.cm.state.doc;
		if (
			session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== request.file
			|| session.displayedLineage.path !== request.path
			|| session.displayedLineage.cm !== request.cm
			|| session.displayedLineage.document !== document
		) return null;
		let editorContent: string;
		let hostContent: string;
		try {
			editorContent = session.view.editor.getValue();
			hostContent = (session.view as unknown as TextFileView).getViewData();
		} catch {
			return null;
		}
		if (editorContent !== targetText || hostContent !== targetText) return null;

		const openViews = this.captureOpenViewsForAdmission(request.path);
		if (
			openViews.length !== request.openEditorTicket.views.length
			|| !openViews.includes(session.view)
		) return null;
		let openEditorTicket: OpenEditorMutationTicket;
		try {
			openEditorTicket = this.captureOpenEditorMutationTicket(
				request.path,
				openViews,
			);
		} catch {
			return null;
		}
		if (!this.validateOpenEditorMutationTicket(openEditorTicket, openViews).current) {
			return null;
		}
		for (const ticket of openEditorTicket.views) {
			const candidateRuntime = this.managedSessions.get(ticket.leafId);
			const candidateSession = candidateRuntime?.session;
			const candidateHost = candidateRuntime?.hostGuard?.snapshot() ?? null;
			const candidateGuard = candidateRuntime?.cmGuard?.snapshot() ?? null;
			const exactBoundPeer = this.isExactAlreadySettledBoundPeer(
				ticket,
				proposal,
				targetText,
			);
			if (
				ticket.cm === null
				|| !candidateRuntime
				|| !candidateSession
				|| candidateSession.view !== ticket.view
				|| candidateSession.view.file !== request.file
				|| candidateSession.handoff !== null
				|| (
					!exactBoundPeer
					&& (
						candidateSession.binding.kind !== "unbound"
						|| this.bindings.has(ticket.leafId)
					)
				)
				|| candidateSession.displayedLineage.kind !== "known"
				|| candidateSession.displayedLineage.file !== request.file
				|| candidateSession.displayedLineage.path !== request.path
				|| candidateSession.displayedLineage.cm !== ticket.cm
				|| candidateSession.displayedLineage.document !== ticket.editorDocument
				|| ticket.cm.state.doc.toString() !== targetText
				|| ticket.editorContent !== targetText
				|| candidateHost === null
				|| candidateHost.hostCapabilityState !== "ready"
					|| candidateHost.mode.kind !== "pass-through"
					|| candidateHost.sourceUnload !== null
					|| !hasExactHostGuardWrappers(candidateHost)
					|| !hasNoPendingHostLoadOwner(candidateHost)
				|| candidateGuard === null
				|| candidateGuard.view !== ticket.cm
				|| candidateGuard.inert
				|| candidateGuard.gateClosed
				|| candidateGuard.pendingHostLoadCandidate !== null
				|| candidateGuard.activeComposition !== null
			) return null;
			let candidateEditorContent: string;
			let candidateHostContent: string;
			try {
				candidateEditorContent = candidateSession.view.editor.getValue();
				candidateHostContent = (candidateSession.view as unknown as TextFileView)
					.getViewData();
			} catch {
				return null;
			}
			if (
				candidateEditorContent !== targetText
				|| candidateHostContent !== targetText
			) return null;
		}
		const editorAuthority = this.capturePathEditorAuthority(request.path);
		if (
			editorAuthority.kind !== "proven-single"
			|| editorAuthority.content !== targetText
			|| !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
		) return null;
		const primary = openEditorTicket.views.find(
			(candidate) => candidate.leafId === request.leafId,
		);
		const editorRevision = this.editorRevisionByCm.get(request.cm) ?? 0;
		const editorTransactionSeq =
			this.samePathAdoptionTransactionSeqByCm.get(request.cm) ?? 0;
		const bindingEpoch = this.bindingEpochByLeafId.get(request.leafId) ?? 0;
		if (
			primary?.cm !== request.cm
			|| primary.editorDocument !== document
			|| primary.editorContent !== targetText
			|| primary.nativeHistoryEpoch !== guard.nativeHistoryEpoch
			|| primary.selectionEpoch !== guard.selectionEpoch
			|| primary.scrollEpoch !== guard.scrollEpoch
			|| primary.editorRevision !== editorRevision
			|| primary.bindingEpoch !== bindingEpoch
		) return null;

		const proof: SamePathAdoptionPostMutationProof = Object.freeze({
			targetText,
			openEditorTicket,
			editorAuthority,
			hostCapability: host.hostCapability,
			hostSaveEpoch: host.saveEpoch,
			cm: request.cm,
			editorDocument: document,
			editorRevision,
			editorTransactionSeq,
			bindingEpoch,
			nativeHistoryEpoch: guard.nativeHistoryEpoch,
			inputEpoch: guard.inputEpoch,
			compositionEpoch: guard.compositionEpoch,
			activeCompositionEpoch: null,
			selectionEpoch: guard.selectionEpoch,
			scrollEpoch: guard.scrollEpoch,
			ytextIdentity: proposal.ytextIdentity,
			ytextMutationEpoch,
		});
		this.samePathAdoptionPostMutationProofs.add(proof);
		return proof;
	}

	private commitSamePathAdoption(
		proposal: SamePathAdoptionProposal,
		reason: string,
	): void {
		const port = this.editorAuthorityControllerPort;
		const request = proposal.request;
		if (
			proposal.plan.kind === "preserve-conflict"
			|| !port?.consumeSamePathAdoptionMutationPermit
			|| !port.consumeSamePathAdoptionBindPermit
			|| !this.isSamePathAdoptionRequestCurrent(request)
		) {
			this.abandonSamePathAdoption(proposal, "pre-mutation-stale", false);
			return;
		}
		const targetText = proposal.plan.targetText;
		const cm = request.cm;
		if (proposal.ytext.toJSON() !== proposal.remoteText) {
			this.abandonSamePathAdoption(proposal, "pre-mutation-content-stale", false);
			return;
		}

		const changes = buildSamePathAdoptionChangeSet(
			proposal.localText,
			targetText,
		);
		const projections: Array<Readonly<{
			ticket: OpenEditorMutationTicket["views"][number];
			runtime: ManagedLeafRuntime;
			cm: EditorView;
			startState: EditorState;
			mappedSelection: EditorSelection;
			expectedMappedScrollAnchor: number | null;
			frameIdentity: object;
			transaction: Transaction | null;
		}>> = [];
		try {
			for (const ticket of request.openEditorTicket.views) {
				const projectionCm = ticket.cm;
				const runtime = this.managedSessions.get(ticket.leafId);
				const session = runtime?.session;
				const host = runtime?.hostGuard?.snapshot() ?? null;
				const guard = runtime?.cmGuard?.snapshot() ?? null;
				const exactBoundPeer = this.isExactAlreadySettledBoundPeer(
					ticket,
					proposal,
					targetText,
				);
				if (
					projectionCm === null
					|| !runtime
					|| !session
					|| session.view !== ticket.view
					|| session.view.file !== request.file
					|| session.handoff !== null
					|| (
						!exactBoundPeer
						&& (
							session.binding.kind !== "unbound"
							|| this.bindings.has(ticket.leafId)
						)
					)
					|| session.displayedLineage.kind !== "known"
					|| session.displayedLineage.file !== request.file
					|| session.displayedLineage.path !== request.path
					|| session.displayedLineage.cm !== projectionCm
					|| session.displayedLineage.document !== ticket.editorDocument
					|| this.getCmView(session.view) !== projectionCm
					|| projectionCm.state.doc !== ticket.editorDocument
					|| projectionCm.state.doc.toString() !== proposal.localText
					|| (
						ticket.leafId !== request.leafId
						&& runtime.adoption.kind !== "none"
					)
					|| host === null
					|| host.hostCapabilityState !== "ready"
						|| host.mode.kind !== "pass-through"
						|| host.sourceUnload !== null
						|| !hasExactHostGuardWrappers(host)
						|| !hasNoPendingHostLoadOwner(host)
					|| guard === null
					|| guard.view !== projectionCm
					|| guard.inert
					|| guard.gateClosed
					|| guard.pendingHostLoadCandidate !== null
					|| guard.activeComposition !== null
					|| guard.nativeHistoryEpoch !== ticket.nativeHistoryEpoch
					|| guard.selectionEpoch !== ticket.selectionEpoch
					|| guard.scrollEpoch !== ticket.scrollEpoch
				) {
					this.abandonSamePathAdoption(
						proposal,
						"multi-pane-pre-mutation-stale",
						false,
					);
					return;
				}
				let editorContent: string;
				let hostContent: string;
				try {
					editorContent = session.view.editor.getValue();
					hostContent = (session.view as unknown as TextFileView).getViewData();
				} catch {
					this.abandonSamePathAdoption(
						proposal,
						"multi-pane-pre-mutation-read-failed",
						false,
					);
					return;
				}
				if (editorContent !== proposal.localText || hostContent !== proposal.localText) {
					this.abandonSamePathAdoption(
						proposal,
						"multi-pane-pre-mutation-content-stale",
						false,
					);
					return;
				}

				const startState = projectionCm.state;
				const mappedSelection = startState.selection.map(changes);
				const frameIdentity = Object.freeze({});
				let expectedMappedScrollAnchor: number | null = null;
				let transaction: Transaction | null = null;
				if (!changes.empty) {
					const scrollSnapshot = projectionCm.scrollSnapshot();
					expectedMappedScrollAnchor = changes.mapPos(
						scrollSnapshot.value.range.head,
						-1,
					);
					const mappedScrollEffect: StateEffect<unknown> | null =
						scrollSnapshot.map(changes) ?? null;
					if (mappedScrollEffect === null) {
						this.abandonSamePathAdoption(
							proposal,
							"scroll-effect-unmappable",
							false,
						);
						return;
					}
					transaction = startState.update({
						changes,
						selection: mappedSelection,
						effects: mappedScrollEffect,
						annotations: [
							Transaction.addToHistory.of(false),
							isolateHistory.of("full"),
							EDITOR_AUTHORITY_TRANSACTION.of({
								content: targetText,
								source: "same-path-adoption",
							}),
							SAME_PATH_ADOPTION_TRANSACTION.of({
								proposal,
								frameIdentity,
							}),
						],
					});
					if (
						transaction.changes !== changes
						|| transaction.newDoc.toString() !== targetText
						|| !transaction.newSelection.eq(mappedSelection)
						|| transaction.effects.length !== 1
						|| transaction.effects[0] !== mappedScrollEffect
						|| transaction.annotation(Transaction.addToHistory) !== false
						|| transaction.annotation(isolateHistory) !== "full"
					) {
						this.abandonSamePathAdoption(
							proposal,
							"transaction-rewritten",
							false,
						);
						return;
					}
				}
				projections.push(Object.freeze({
					ticket,
					runtime,
					cm: projectionCm,
					startState,
					mappedSelection,
					expectedMappedScrollAnchor,
					frameIdentity,
					transaction,
				}));
			}
		} catch {
			this.abandonSamePathAdoption(proposal, "transaction-construction-failed", false);
			return;
		}
		if (
			!this.isSamePathAdoptionRequestCurrent(request)
			|| projections.length !== request.openEditorTicket.views.length
			|| projections.some((projection) =>
				projection.cm.state !== projection.startState)
			|| proposal.ytext.toJSON() !== proposal.remoteText
		) {
			this.abandonSamePathAdoption(proposal, "pre-permit-stale", false);
			return;
		}
		const mutationContext: SamePathAdoptionMutationContext = Object.freeze({
			kind: "mutation",
			proposal,
			request,
		});
		if (!port.consumeSamePathAdoptionMutationPermit(
			proposal.mutationPermit,
			mutationContext,
		)) {
			this.abandonSamePathAdoption(proposal, "mutation-permit-rejected", false);
			return;
		}

		let ytextMutated = false;
		let editorMutated = false;
		try {
			const yResult = applyExactDiffToYText(
				proposal.ytext,
				proposal.remoteText,
				targetText,
				ORIGIN_SAME_PATH_ADOPTION,
			);
			if (yResult.kind === "stale-base") {
				this.abandonSamePathAdoption(proposal, "ytext-stale", false);
				return;
			}
			ytextMutated = yResult.kind === "applied";
			if (yResult.kind === "postcondition-failed") {
				this.abandonSamePathAdoption(proposal, "ytext-postcondition-failed", true);
				return;
			}
		} catch {
			this.abandonSamePathAdoption(
				proposal,
				"ytext-mutation-failed",
				proposal.ytext.toJSON() !== proposal.remoteText,
			);
			return;
		}

		for (const projection of projections) {
			const transaction = projection.transaction;
			if (transaction === null) continue;
			if (
				projection.cm.state !== projection.startState
				|| this.managedSessions.get(projection.ticket.leafId) !== projection.runtime
				|| this.activeSamePathAdoptionDispatchFrame !== null
				|| proposal.ytext.toJSON() !== targetText
			) {
				this.abandonSamePathAdoption(
					proposal,
					"pre-editor-dispatch-stale",
					ytextMutated || editorMutated,
				);
				return;
			}
			const frame: ActiveSamePathAdoptionDispatchFrame = {
				frameIdentity: projection.frameIdentity,
				proposal,
				runtime: projection.runtime,
				cm: projection.cm,
				startState: projection.startState,
				transaction,
				updateSeen: false,
			};
			this.activeSamePathAdoptionDispatchFrame = frame;
			try {
				projection.cm.dispatch(transaction);
				editorMutated = editorMutated
					|| projection.cm.state.doc !== projection.startState.doc;
			} catch {
				this.abandonSamePathAdoption(
					proposal,
					"editor-dispatch-failed",
					ytextMutated
						|| editorMutated
						|| projection.cm.state.doc !== projection.startState.doc,
				);
				return;
			} finally {
				if (this.activeSamePathAdoptionDispatchFrame === frame) {
					this.activeSamePathAdoptionDispatchFrame = null;
				}
			}
			if (!frame.updateSeen) {
				this.abandonSamePathAdoption(
					proposal,
					"editor-update-unobserved",
					ytextMutated || editorMutated,
				);
				return;
			}
		}

		if (proposal.ytext.toJSON() !== targetText) {
			this.abandonSamePathAdoption(
				proposal,
				"post-mutation-mismatch",
				ytextMutated || editorMutated,
			);
			return;
		}
		for (const projection of projections) {
			if (
				projection.cm.state.doc.toString() !== targetText
				|| !projection.cm.state.selection.eq(projection.mappedSelection)
			) {
				this.abandonSamePathAdoption(
					proposal,
					"post-mutation-mismatch",
					ytextMutated || editorMutated,
				);
				return;
			}
			if (projection.expectedMappedScrollAnchor === null) continue;
			let actualScrollAnchor: number | null = null;
			try {
				actualScrollAnchor = projection.cm.scrollSnapshot().value.range.head;
			} catch {
				// Exact postcondition below fails closed.
			}
			if (actualScrollAnchor !== projection.expectedMappedScrollAnchor) {
				this.abandonSamePathAdoption(
					proposal,
					"post-scroll-mismatch",
					ytextMutated || editorMutated,
				);
				return;
			}
		}
		const postYTextMutationEpoch = proposal.ytextMutationEpoch
			+ (ytextMutated ? 1 : 0);
		const postMutation = this.captureSamePathAdoptionPostMutationProof(
			proposal,
			targetText,
			postYTextMutationEpoch,
		);
		if (!postMutation) {
			this.abandonSamePathAdoption(
				proposal,
				"post-mutation-proof-failed",
				ytextMutated || editorMutated,
			);
			return;
		}
		const bindContext: SamePathAdoptionBindContext = Object.freeze({
			kind: "bind",
			proposal,
			request,
			postMutation,
		});
		if (!port.consumeSamePathAdoptionBindPermit(proposal.bindPermit, bindContext)) {
			this.abandonSamePathAdoption(
				proposal,
				"bind-permit-rejected",
				ytextMutated || editorMutated,
			);
			return;
		}
		const commitRuntime = this.managedSessions.get(request.leafId);
		if (!commitRuntime || commitRuntime.session.view.file !== request.file) {
			this.abandonSamePathAdoption(
				proposal,
				"pre-bind-runtime-stale",
				ytextMutated || editorMutated,
			);
			return;
		}
		const bound = this.applyBinding({
			action: "bind",
			deviceName: this.lastDeviceName,
			view: commitRuntime.session.view,
			cm,
			cmId: this.getCmId(cm),
			leafId: request.leafId,
			file: request.file,
			filePath: request.path,
			ytext: proposal.ytext,
			fileId: proposal.fileId,
			samePathAdoptionYtextMutationEpochAtBind:
				postMutation.ytextMutationEpoch,
			authorityLease: postMutation.editorAuthority.kind === "proven-single"
				? postMutation.editorAuthority.lease
				: undefined,
			reason: `same-path-adoption:${reason}`,
		});
		if (!bound) {
			this.abandonSamePathAdoption(
				proposal,
				"binding-publication-failed",
				ytextMutated || editorMutated,
			);
			return;
		}
		const receipt: SamePathAdoptionBindReceipt = Object.freeze({
			receiptId: this.createManagedAuthorityRequestId("same-path-adoption-bound"),
			proposalId: proposal.proposalId,
			adoptionId: proposal.adoptionId,
			path: proposal.path,
			file: proposal.file,
			fileId: proposal.fileId,
			ytext: proposal.ytext,
			ytextIdentity: postMutation.ytextIdentity,
			ytextMutationEpoch: postMutation.ytextMutationEpoch,
			targetText,
		});
		const settledRuntime = this.managedSessions.get(request.leafId);
		const binding = this.bindings.get(request.leafId);
		if (
			!settledRuntime
			|| !binding
			|| binding.view !== settledRuntime.session.view
			|| binding.file !== proposal.file
			|| binding.path !== proposal.path
			|| binding.ytext !== proposal.ytext
		) {
			this.abandonSamePathAdoption(
				proposal,
				"post-bind-identity-failed",
				true,
			);
			return;
		}
		this.advanceAuthorityEpoch();
		this.samePathAdoptionRequiredPathByLeafId.delete(request.leafId);
		const adoptionRetry = this.pendingSamePathAdoptionRetries.get(request.leafId);
		if (adoptionRetry) clearTimeout(adoptionRetry);
		this.pendingSamePathAdoptionRetries.delete(request.leafId);
		this.samePathAdoptionRetryAttempts.delete(request.leafId);
		settledRuntime.adoption = Object.freeze({
			kind: "awaiting-disk",
			adoptionId: proposal.adoptionId,
			proposalId: proposal.proposalId,
			path: proposal.path,
			file: proposal.file,
			fileId: proposal.fileId,
			ytext: proposal.ytext,
			targetText,
			bindReceipt: receipt,
		});
		for (const ticket of postMutation.openEditorTicket.views) {
			if (ticket.leafId === request.leafId) continue;
			const paneRuntime = this.managedSessions.get(ticket.leafId);
			if (
				paneRuntime
				&& paneRuntime.session.view === ticket.view
				&& paneRuntime.session.view.file === proposal.file
				&& paneRuntime.session.binding.kind === "unbound"
				&& paneRuntime.adoption.kind === "none"
			) {
				// The accepted composite projection supersedes any pre-commit
				// coordinator hand-off marker for this exact peer. Leaving it in
				// place would route equal target bytes through another adoption
				// plan instead of the ordinary existing-target bind.
				this.samePathAdoptionRequiredPathByLeafId.delete(ticket.leafId);
				const pendingRetry = this.pendingSamePathAdoptionRetries.get(
					ticket.leafId,
				);
				if (pendingRetry) clearTimeout(pendingRetry);
				this.pendingSamePathAdoptionRetries.delete(ticket.leafId);
				this.samePathAdoptionRetryAttempts.delete(ticket.leafId);
				this.scheduleSamePathAdoptionRefresh(
					paneRuntime,
					"multi-pane-adoption-settled",
				);
			}
		}
		port.noteSamePathAdoptionBound?.(receipt);
		this.trace?.("editor", "same-path-adoption-bound", {
			leafId: request.leafId,
			path: proposal.path,
			proposalId: proposal.proposalId,
			planKind: proposal.plan.kind,
		});
	}

	private beginSamePathAdoption(
		view: MarkdownView,
		file: TFile,
		ytext: Y.Text | null,
		reason: string,
	): boolean {
		const port = this.editorAuthorityControllerPort;
		if (!port?.requestSamePathAdoption || !this.asyncAuthorityOpen) return false;
		if (this.activeSamePathExternalCandidateProjectionProofByPath.has(file.path)) {
			this.trace?.("editor", "same-path-adoption-deferred-for-external-candidate", {
				path: file.path,
				reason,
			});
			return true;
		}
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		const session = runtime?.session;
		const cm = this.getCmView(view);
		if (
			!runtime
			|| !session
			|| session.view !== view
			|| session.view.file !== file
			|| file.path.length === 0
			|| session.handoff !== null
			|| session.binding.kind !== "unbound"
			|| session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== file
			|| session.displayedLineage.path !== file.path
			|| cm === null
			|| session.displayedLineage.cm !== cm
			|| !this.isManagedBoundaryLive(runtime, cm)
		) return false;
		const host = runtime.hostGuard?.snapshot() ?? null;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		if (
			host === null
			|| guard === null
				|| host.hostCapabilityState !== "ready"
				|| host.mode.kind !== "pass-through"
				|| host.sourceUnload !== null
				|| !hasExactHostGuardWrappers(host)
				|| !hasNoPendingHostLoadOwner(host)
				|| guard.view !== cm
			|| guard.inert
			|| guard.gateClosed
			|| guard.pendingHostLoadCandidate !== null
			|| guard.nativeHistoryEpoch !== session.nativeHistoryEpoch
		) return false;
		if (guard.activeComposition !== null) {
			return false;
		}
		const startDocument = cm.state.doc;
		const editorRevision = this.editorRevisionByCm.get(cm) ?? 0;
		const editorTransactionSeq =
			this.samePathAdoptionTransactionSeqByCm.get(cm) ?? 0;
		const bindingEpoch = this.bindingEpochByLeafId.get(leafId) ?? 0;
		const retained = runtime.adoption;
		if (
			retained.kind === "conflict"
			&& retained.path === file.path
			&& retained.status === "preserved"
			&& ytext !== null
			&& ytext.toJSON() === retained.remoteText
		) return true;
		if (retained.kind === "conflict") {
			this.invalidateSamePathAdoptionConflict(
				retained.adoptionId,
				retained.path,
				"same-path-conflict-authority-changed",
			);
		}
		if (
			(retained.kind === "capturing" || retained.kind === "planning")
			&& retained.sessionId === session.sessionId
			&& retained.generation === session.generation
			&& retained.view === view
			&& retained.file === file
			&& retained.path === file.path
			&& retained.cm === cm
			&& retained.startDocument === startDocument
			&& retained.latestEditorRevision === editorRevision
			&& retained.editorTransactionSeq === editorTransactionSeq
			&& retained.bindingEpoch === bindingEpoch
			&& retained.nativeHistoryEpoch === guard.nativeHistoryEpoch
			&& retained.inputEpoch === guard.inputEpoch
			&& retained.compositionEpoch === guard.compositionEpoch
			&& retained.activeCompositionEpoch === null
			&& retained.selectionEpoch === guard.selectionEpoch
			&& retained.scrollEpoch === guard.scrollEpoch
			&& retained.hostCapability === host.hostCapability
			&& retained.hostSaveEpoch === host.saveEpoch
		) return true;

		const adoptionId = this.createManagedAuthorityRequestId("same-path-adoption");
		runtime.adoption = Object.freeze({
			kind: "capturing",
			adoptionId,
			requestId: null,
			sessionId: session.sessionId,
			generation: session.generation,
			view,
			file,
			path: file.path,
			cm,
			startDocument,
			startEditorRevision: editorRevision,
			latestEditorRevision: editorRevision,
			editorTransactionSeq,
			bindingEpoch,
			nativeHistoryEpoch: guard.nativeHistoryEpoch,
			inputEpoch: guard.inputEpoch,
			compositionEpoch: guard.compositionEpoch,
			activeCompositionEpoch: null,
			selectionEpoch: guard.selectionEpoch,
			scrollEpoch: guard.scrollEpoch,
			hostCapability: host.hostCapability,
			hostSaveEpoch: host.saveEpoch,
			proposal: null,
		});

		const openViews = this.captureOpenViewsForAdmission(file.path);
		if (openViews.length === 0 || !openViews.includes(view)) {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			return false;
		}
		let openEditorTicket: OpenEditorMutationTicket;
		try {
			openEditorTicket = this.captureOpenEditorMutationTicket(file.path, openViews);
		} catch {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			return false;
		}
		const coordinator = [...openEditorTicket.views]
			.sort((left, right) => left.leafId.localeCompare(right.leafId))[0];
		if (!coordinator) {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			return false;
		}
		if (coordinator.leafId !== leafId) {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			const coordinatorRuntime = this.managedSessions.get(coordinator.leafId);
			if (coordinatorRuntime) {
				this.samePathAdoptionRequiredPathByLeafId.set(
					coordinator.leafId,
					file.path,
				);
				this.scheduleSamePathAdoptionRefresh(
					coordinatorRuntime,
					"multi-pane-adoption-coordinator",
				);
			}
			return true;
		}
		const editorAuthority = this.capturePathEditorAuthority(file.path);
		const fileId = ytext === null
			? null
			: this.vaultSync.getFileIdForText(ytext)
				?? this.vaultSync.getFileId(file.path)
				?? null;
		const currentHost = runtime.hostGuard?.snapshot() ?? null;
		const currentGuard = runtime.cmGuard?.snapshot() ?? null;
		const primary = openEditorTicket.views.find((candidate) => candidate.leafId === leafId);
		if (
			this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== session
			|| runtime.adoption.kind !== "capturing"
			|| runtime.adoption.adoptionId !== adoptionId
			|| view.file !== file
			|| file.path !== runtime.adoption.path
			|| cm.state.doc !== startDocument
			|| currentHost === null
			|| currentGuard === null
			|| !sameHostGuardSnapshot(host, currentHost)
			|| !sameCodeMirrorGuardSnapshot(guard, currentGuard)
			|| (
				editorAuthority.kind !== "proven-single"
				&& !(
					editorAuthority.kind === "blocked"
					&& editorAuthority.reason === "multiple"
				)
			)
			|| (
				editorAuthority.kind === "proven-single"
				&& (
					editorAuthority.content !== startDocument.toString()
					|| !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
				)
			)
			|| (ytext !== null && fileId === null)
			|| this.vaultSync.getTextForPath(file.path) !== ytext
			|| primary?.cm !== cm
			|| primary.editorDocument !== startDocument
			|| primary.editorContent !== startDocument.toString()
		) {
			runtime.adoption = NO_SAME_PATH_ADOPTION;
			return false;
		}
		const requestId = this.createManagedAuthorityRequestId("same-path-adoption-request");
		const request: SamePathAdoptionRequest = Object.freeze({
			requestId,
			adoptionId,
			sessionId: session.sessionId,
			leafId,
			generation: session.generation,
			path: file.path,
			file,
			fileId,
			ytext,
			openEditorTicket,
			editorAuthority,
			hostCapability: host.hostCapability,
			hostSaveEpoch: host.saveEpoch,
			cm,
			startDocument,
			editorRevision,
			editorTransactionSeq,
			bindingEpoch,
			nativeHistoryEpoch: guard.nativeHistoryEpoch,
			inputEpoch: guard.inputEpoch,
			compositionEpoch: guard.compositionEpoch,
			activeCompositionEpoch: null,
			selectionEpoch: guard.selectionEpoch,
			scrollEpoch: guard.scrollEpoch,
		});
		runtime.adoption = Object.freeze({
			...runtime.adoption,
			kind: "planning",
			requestId,
		});
		let planning: Promise<SamePathAdoptionRequestResult>;
		try {
			planning = port.requestSamePathAdoption(request);
		} catch {
			if (runtime.adoption.requestId === requestId) {
				runtime.adoption = NO_SAME_PATH_ADOPTION;
			}
			return false;
		}
		void planning.then(
			(result) => {
				const current = this.managedSessions.get(leafId);
				if (
					current !== runtime
					|| current.adoption.kind !== "planning"
					|| current.adoption.adoptionId !== adoptionId
					|| current.adoption.requestId !== requestId
				) return;
				if (!this.isSamePathAdoptionRequestCurrent(request)) {
					this.advanceAuthorityEpoch();
					current.adoption = NO_SAME_PATH_ADOPTION;
					this.samePathAdoptionRequiredPathByLeafId.set(leafId, file.path);
					this.scheduleSamePathAdoptionRetry(
						current,
						file.path,
						"stale-planning-response",
					);
					return;
				}
				if (result.kind === "planned") {
					current.adoption = Object.freeze({
						...current.adoption,
						proposal: result.proposal,
					});
					this.trace?.("editor", "same-path-adoption-planned", {
						leafId,
						path: file.path,
						reason,
						planKind: result.proposal.plan.kind,
					});
					if (result.proposal.plan.kind !== "preserve-conflict") {
						this.commitSamePathAdoption(result.proposal, reason);
					}
					return;
				}
				if (
					result.kind === "conflict-preserved"
					|| result.kind === "conflict-preservation-failed"
				) {
					this.publishSamePathAdoptionConflict(request, result.receipt);
					this.trace?.(
						"editor",
						result.kind === "conflict-preserved"
							? "same-path-adoption-conflict-preserved"
							: "same-path-adoption-conflict-preservation-failed",
						{
							leafId,
							path: file.path,
							reason,
							status: result.receipt.status,
							mergeMode: result.receipt.mergeMode,
							crdtArtifactPath: result.receipt.crdtArtifactPath,
							editorArtifactCount: result.receipt.editorArtifacts.length,
						},
					);
					return;
				}
				current.adoption = NO_SAME_PATH_ADOPTION;
				this.samePathAdoptionRequiredPathByLeafId.set(leafId, file.path);
				this.scheduleSamePathAdoptionRetry(
					current,
					file.path,
					result.kind === "seeded-replan"
						? "seeded-remote-replan"
						: "controller-replan",
				);
			},
			() => {
				const current = this.managedSessions.get(leafId);
				if (
					current === runtime
					&& current.adoption.kind === "planning"
					&& current.adoption.adoptionId === adoptionId
					&& current.adoption.requestId === requestId
				) {
					this.advanceAuthorityEpoch();
					current.adoption = NO_SAME_PATH_ADOPTION;
					this.samePathAdoptionRequiredPathByLeafId.set(leafId, file.path);
					this.scheduleSamePathAdoptionRetry(
						current,
						file.path,
						"planning-request-rejected",
					);
				}
			},
		);
		return true;
	}

	private coordinateInitialMultiPaneExistingTarget(
		view: MarkdownView,
		file: TFile,
		crdtContent: string,
	): "allow" | "defer" | "adopt" {
		for (const binding of this.bindings.values()) {
			if (binding.path === file.path) return "allow";
		}
		const openViews = this.captureOpenViewsForAdmission(file.path);
		if (openViews.length <= 1) return "allow";

		let ticket: OpenEditorMutationTicket;
		try {
			ticket = this.captureOpenEditorMutationTicket(file.path, openViews);
		} catch {
			return "defer";
		}
		if (!this.validateOpenEditorMutationTicket(ticket, openViews).current) {
			return "defer";
		}
		const coordinator = [...ticket.views]
			.sort((left, right) => left.leafId.localeCompare(right.leafId))[0];
		if (!coordinator) return "defer";
		const allUnboundAndExact = ticket.views.every((candidate) => {
			const runtime = this.managedSessions.get(candidate.leafId);
			return candidate.cm !== null
				&& candidate.stableTargetIdentityProven
				&& candidate.editorDocument === candidate.cm.state.doc
				&& candidate.cm.state.doc.toString() === crdtContent
				&& candidate.editorContent === crdtContent
				&& runtime?.session.view === candidate.view
				&& runtime.session.binding.kind === "unbound"
				&& runtime.session.handoff === null
				&& !this.bindings.has(candidate.leafId);
		});
		const leafId = this.getLeafId(view);
		const coordinatorRuntime = this.managedSessions.get(coordinator.leafId);
		if (!allUnboundAndExact) {
			this.samePathAdoptionRequiredPathByLeafId.set(
				coordinator.leafId,
				file.path,
			);
		}
		if (coordinator.leafId !== leafId) {
			if (coordinatorRuntime) {
				this.scheduleSamePathAdoptionRefresh(
					coordinatorRuntime,
					allUnboundAndExact
						? "multi-pane-initial-bind-coordinator"
						: "multi-pane-initial-adoption-coordinator",
				);
			}
			return "defer";
		}
		return allUnboundAndExact ? "allow" : "adopt";
	}

	private resolveBindingTarget(
		view: MarkdownView,
		_deviceName: string,
		reason: string,
	): BindingTargetResolution | null {
		const file = view.file;
		if (!file) return null;
		const session = this.getManagedSession(view);
		if (!session || !this.isManagedTargetSelected(session, file)) return null;
		if (!this.isMarkdownPathSyncable(file.path)) {
			this.skipExcludedBinding(view, file.path, `resolve:${reason}`);
			return null;
		}
		const displayed = session.displayedLineage;
		const samePathReplacementAwaitingAdmission =
			session.handoff !== null
			&& displayed.kind === "known"
			&& displayed.path === file.path
			&& displayed.file !== file;
		if (samePathReplacementAwaitingAdmission) {
			this.trace?.("editor", "same-path-file-replacement-awaiting-controller", {
				path: file.path,
				leafId: this.getLeafId(view),
				reason,
			});
		}

		const existingText = samePathReplacementAwaitingAdmission
			? null
			: this.vaultSync.getTextForPath(file.path);
		if (existingText) {
			this.pendingAdmissionByLeafId.delete(this.getLeafId(view));
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
			const runtime = this.managedSessions.get(this.getLeafId(view));
			if (
				currentContent === crdtContent
				&& this.isSamePathAdoptionReplanHeld(file.path)
			) {
				this.beginSamePathAdoption(
					view,
					file,
					existingText,
					`${reason}:required-replan`,
				);
				return null;
			}
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
				this.beginSamePathAdoption(view, file, existingText, reason);
				return null;
			}
			const multiPaneCoordination = this.coordinateInitialMultiPaneExistingTarget(
				view,
				file,
				crdtContent,
			);
			if (multiPaneCoordination === "defer") return null;
			if (multiPaneCoordination === "adopt") {
				this.beginSamePathAdoption(
					view,
					file,
					existingText,
					`${reason}:multi-pane-initial-adoption`,
				);
				return null;
			}
			if (
				runtime
				&& (
					runtime.adoption.kind === "capturing"
					|| runtime.adoption.kind === "planning"
				)
			) {
				runtime.adoption = NO_SAME_PATH_ADOPTION;
				this.advanceAuthorityEpoch();
			}
			const authority = this.capturePathEditorAuthority(file.path);
			if (
				authority.kind !== "proven-single"
				|| authority.content !== currentContent
				|| !this.isPathEditorAuthorityLeaseCurrent(authority.lease)
			) {
				this.trace?.("editor", "binding-target-authority-blocked", {
					path: file.path,
					reason,
					leafId: this.getLeafId(view),
					authority: authority.kind,
				});
				return null;
			}
			return {
				kind: "existing-target",
				ytext: existingText,
				fileId:
					this.vaultSync.getFileId(file.path)
					?? this.vaultSync.getFileIdForText(existingText),
				lease: authority.lease,
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
		if (!this.beginSamePathAdoption(view, file, null, reason)) {
			this.requestOpenPathAdmission(view, file, reason);
		}
		return Object.freeze({
			kind: "missing-target",
			targetFile: file,
			targetPath: file.path,
		});
	}

	private requestOpenPathAdmission(
		view: MarkdownView,
		targetFile: TFile,
		reason: string,
	): void {
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		if (!runtime || runtime.session.view !== view) return;
		const session = runtime.session;
		if (
			view.file !== targetFile
			|| !this.isManagedTargetSelected(session, targetFile)
		) return;
		const request: OpenPathAdmissionWakeRequest = Object.freeze({
			bootSessionId: this.bootSessionId,
			sessionId: session.sessionId,
			leafId,
			handoffGeneration: session.generation,
			switchIntentSeq: session.currentSwitchIntentSeq,
			targetFile,
			targetPath: targetFile.path,
		});
		const previous = this.pendingAdmissionByLeafId.get(leafId);
		if (
			previous?.bootSessionId === request.bootSessionId
			&& previous.sessionId === request.sessionId
			&& previous.handoffGeneration === request.handoffGeneration
			&& previous.switchIntentSeq === request.switchIntentSeq
			&& previous.targetFile === request.targetFile
			&& previous.targetPath === request.targetPath
		) return;
		this.pendingAdmissionByLeafId.set(leafId, request);
		try {
			this.requestOpenPathAdmissionCallback?.(request);
		} catch (error) {
			this.trace?.("editor", "open-path-admission-request-failed", {
				leafId,
				path: targetFile.path,
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
		this.cancelManagedHandoffAndUnmanage(view, `excluded:${reason}`, "excluded");
		this.trace?.("editor", "binding-skipped-excluded-path", {
			leafId,
			path,
			reason,
		});
		this.log(`binding skipped for excluded path "${path}" (reason=${reason})`);
	}

	private cancelManagedHandoffAndUnmanage(
		view: MarkdownView,
		reason: string,
		cancelReason: "deleted" | "closed" | "excluded" | "renamed" | "teardown" | "unsupported-host",
		scheduleRetry = true,
	): void {
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		const retainedHandoff = runtime?.session.view === view
			? runtime.session.handoff
			: null;
		if (runtime?.session.view === view && runtime.session.handoff !== null) {
			const cancelled = reduceManagedLeafSession(runtime.session, {
					type: "cancelled",
					sessionId: runtime.session.sessionId,
					expectedGeneration: runtime.session.generation,
					reason: cancelReason,
			});
			if (cancelled.accepted) {
				this.advanceAuthorityEpoch();
				runtime.session = cancelled.state;
				this.applyHandoffEffects(runtime, cancelled.effects, reason);
			}
		}
		if (
			runtime?.session.view === view
			&& runtime.session.handoff === null
			&& retainedHandoff !== null
			&& runtime.transitionInputFence !== null
		) {
			this.releaseTransitionInputFence(
				runtime,
				retainedHandoff.targetFile,
				retainedHandoff.targetPath,
				`${reason}:cancelled`,
				true,
			);
		}
		this.detachBinding(view, reason, false);
		if (!this.unmanageView(view, reason, scheduleRetry) && runtime && retainedHandoff) {
			// CodeMirror still owns an unflushable composition/commit. Keep the host
			// save block owned by the retained runtime until the bounded retry can
			// inert the CM guard safely.
			runtime.hostGuard?.beginBlockingHandoff({
				handoffGeneration: runtime.session.generation,
				sourceLineagePath: retainedHandoff.sourceAuthorityPath,
				targetPath: retainedHandoff.targetPath,
			});
			this.trace?.("editor", "managed-view-host-block-retained", {
				leafId,
				reason,
			});
		}
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
		this.cancelManagedHandoffAndUnmanage(view, `tombstone:${reason}`, "deleted");
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
