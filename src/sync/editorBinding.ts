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
	historyField,
	isolateHistory,
	redoDepth,
	undoDepth,
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
	type HandoffIntentState,
	type HandoffInputIntent,
	type HandoffReplayPlan,
	type HostLoadCompletionReceipt,
	type ManagedLeafInputStartReservation,
	type ManagedLeafSession,
	type MissingTargetSeedPlan,
	type PendingHostLoadCandidate,
	type TargetPresentationPlan,
	type TargetPresentationReceipt,
	type TargetReadyToken,
} from "./editorHandoffState";
import {
	associateEditorHandoffHostQaBarrier,
	installTextFileViewHandoffGuard,
	type EditorHandoffHostQaBarrier,
	type ManagedSourceUnloadSnapshot,
	type ManagedViewSaveGuard,
	type TextFileViewHandoffGuard,
} from "./textFileViewHandoffGuard";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffHostOperationDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
} from "../runtime/engineControlPort";
import {
	captureGuardOwnedHandoffCompositionProof,
	acceptedHandoffReplay,
	handoffRecoveryGateActions,
	installCodeMirrorHandoffGuard,
	type CodeMirrorHandoffContext,
	type CodeMirrorHandoffGuard,
	type CodeMirrorHandoffGuardSnapshot,
	type HandoffRecoveryGateModel,
} from "./codeMirrorHandoffGuard";
import {
	isExactHandoffReplayScrollDispatchPostcondition,
	type HandoffCompositionProof,
	type HandoffReplayDispatchResult,
	type HandoffReplayNotAppliedReason,
	type HandoffReplayPermit,
	type HandoffReplaySettlementSnapshot,
	type HandoffReplayTargetSnapshot,
	type RedeemExactHandoffReplayDispatchPermitResult,
} from "./editorHandoffReplay";
import {
	canonicalHandoffRecoveryJson,
	sha256HandoffRecoveryHexSync,
	type ActiveHandoffRecoveryRecord,
} from "./handoffRecoveryStore";
import type {
	HandoffRecoveryPort,
	HandoffRecoveryRuntimeRequest,
} from "../runtime/handoffRecoveryCoordinator";
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
	HandoffReplayRecoveryAdmissionEvidence,
	HandoffReplayRecoveryClaim,
	HandoffReplayRecoveryOpenEditorMutationTicket,
	MissingTargetSeedResult,
	OpenPathAdmissionRequest,
	OpenPathAdmissionResult,
	TargetPresentationPermitContext,
	TargetPresentationRequest,
	TargetPresentationRequestResult,
	TargetPresentationResult,
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

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;
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
const TYPING_AWARENESS_MIN_INTERVAL_MS = 750;
const CONCURRENT_TYPING_NOTICE_COOLDOWN_MS = 8_000;
// One accepted replay advances the Y.Text mutation fence, the CodeMirror
// document fence, and the displayed-lineage fence exactly once each.
const HANDOFF_REPLAY_AUTHORITY_EPOCH_ADVANCE = 3;
const EDITOR_AUTHORITY_SHIELD_ORIGINS = new Set<string>([
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
]);
const CM_RESOLVE_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000, 1500, 2000] as const;
const CM_RESOLVE_DELAYED_ATTEMPT = 5;
const CM_RESOLVE_IDLE_RETRY_DELAY_MS = 5000;
const TARGET_PRESENTATION_RETRY_DELAYS_MS = [120, 250, 500, 1000, 2000, 5000] as const;
const TARGET_BIND_RETRY_DELAYS_MS = [120, 250, 500, 1000, 2000, 5000] as const;
const SAME_PATH_ADOPTION_RETRY_DELAYS_MS = [120, 250, 500, 1000, 2000, 5000] as const;

function sameScrollSnapshot(
	left: ReturnType<EditorView["scrollSnapshot"]>,
	right: ReturnType<EditorView["scrollSnapshot"]>,
): boolean {
	return left.value.range.eq(right.value.range, true)
		&& left.value.y === right.value.y
		&& left.value.x === right.value.x
		&& left.value.yMargin === right.value.yMargin
		&& left.value.xMargin === right.value.xMargin
		&& left.value.isSnapshot === right.value.isSnapshot;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sameOwnPropertyDescriptor(
	left: PropertyDescriptor | undefined,
	right: PropertyDescriptor | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (
		left.configurable !== right.configurable
		|| left.enumerable !== right.enumerable
		|| ("value" in left) !== ("value" in right)
	) return false;
	if ("value" in left && "value" in right) {
		return left.value === right.value && left.writable === right.writable;
	}
	return left.get === right.get && left.set === right.set;
}

function sameOwnPropertyDescriptorShape(
	left: PropertyDescriptor | undefined,
	right: PropertyDescriptor | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (
		left.configurable !== right.configurable
		|| left.enumerable !== right.enumerable
		|| ("value" in left) !== ("value" in right)
	) return false;
	if ("value" in left && "value" in right) {
		return left.writable === right.writable;
	}
	return left.get === right.get && left.set === right.set;
}

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

export function isExactHandoffReplayOwnedSaveStart(
	before: ManagedViewSaveGuard | null,
	after: ManagedViewSaveGuard | null,
	expected: Pick<
		HandoffReplayTargetSnapshot,
		"sessionId" | "handoffGeneration" | "targetFile" | "targetPath"
	>,
): boolean {
	if (
		before === null
		|| after === null
		|| before.pendingOwnedSave !== null
		|| after.pendingOwnedSave === null
		|| !Number.isSafeInteger(before.saveEpoch)
		|| before.saveEpoch < 0
		|| before.saveEpoch >= Number.MAX_SAFE_INTEGER
		|| after.saveEpoch !== before.saveEpoch + 1
		|| expected.sessionId.length === 0
		|| !Number.isSafeInteger(expected.handoffGeneration)
		|| expected.handoffGeneration < 0
		|| expected.targetPath.length === 0
		|| expected.targetFile.path !== expected.targetPath
	) return false;

	const job = after.pendingOwnedSave;
	if (
		!Number.isSafeInteger(job.jobId)
		|| job.jobId <= 0
		|| job.sessionId !== expected.sessionId
		|| job.generation !== expected.handoffGeneration
		|| job.file !== expected.targetFile
		|| job.path !== expected.targetPath
		|| job.displayedPath !== expected.targetPath
		|| job.saveEpoch !== after.saveEpoch
	) return false;

	return sameHostGuardSnapshot(before, {
		...after,
		saveEpoch: before.saveEpoch,
		pendingOwnedSave: null,
	});
}

export function isExactHandoffReplayRuntimeCacheProjection(input: Readonly<{
	beforeDescriptor: PropertyDescriptor | undefined;
	afterDispatchDescriptor: PropertyDescriptor | undefined;
	expectedStartContent: string;
	expectedResultContent: string;
	hostBefore: ManagedViewSaveGuard | null;
	hostAfter: ManagedViewSaveGuard | null;
	expected: Pick<
		HandoffReplayTargetSnapshot,
		"sessionId" | "handoffGeneration" | "targetFile" | "targetPath"
	>;
}>): boolean {
	const { beforeDescriptor, afterDispatchDescriptor } = input;
	return input.expectedStartContent !== input.expectedResultContent
		&& beforeDescriptor !== undefined
		&& afterDispatchDescriptor !== undefined
		&& "value" in beforeDescriptor
		&& "value" in afterDispatchDescriptor
		&& beforeDescriptor.writable === true
		&& typeof beforeDescriptor.value === "string"
		&& beforeDescriptor.value === input.expectedStartContent
		&& afterDispatchDescriptor.value === input.expectedStartContent
		&& sameOwnPropertyDescriptor(
			beforeDescriptor,
			afterDispatchDescriptor,
		)
		&& isExactHandoffReplayOwnedSaveStart(
			input.hostBefore,
			input.hostAfter,
			input.expected,
		);
}

export function isExactHandoffReplayYTextTransaction(input: Readonly<{
	transactions: readonly Y.Transaction[];
	expectedOrigin: unknown;
	expectedYtext: Y.Text;
}>): boolean {
	const transaction = input.transactions[0] ?? null;
	if (
		transaction === null
		|| input.transactions.length !== 1
		|| input.expectedYtext.doc === null
		|| transaction.doc !== input.expectedYtext.doc
		|| transaction.origin !== input.expectedOrigin
		|| transaction.changed.size !== 1
		|| !transaction.changed.has(input.expectedYtext)
		|| !transaction.changedParentTypes.has(input.expectedYtext)
	) return false;

	const allowedParentTypes = new Set<unknown>();
	let current: unknown = input.expectedYtext;
	while (current !== null) {
		if (
			typeof current !== "object"
			|| allowedParentTypes.has(current)
			|| allowedParentTypes.size >= 64
		) return false;
		allowedParentTypes.add(current);
		try {
			current = Reflect.get(current, "parent");
		} catch {
			return false;
		}
	}
	for (const parentType of transaction.changedParentTypes.keys()) {
		if (!allowedParentTypes.has(parentType)) return false;
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

type ActiveHandoffReplayDispatchFrame = {
	readonly frameIdentity: object;
	readonly permit: HandoffReplayPermit;
	readonly plan: HandoffReplayPlan;
	readonly record: ActiveHandoffRecoveryRecord & Readonly<{
		status: "replay-pending";
	}>;
	readonly recoveryOperationEpoch: number;
	readonly expectedSnapshot: HandoffReplayTargetSnapshot;
	readonly runtime: ManagedLeafRuntime;
	readonly session: ManagedLeafSession;
	readonly handoff: NonNullable<ManagedLeafSession["handoff"]>;
	readonly workflow: ManagedTargetWorkflow;
	readonly binding: EditorBinding;
	readonly targetReadyToken: TargetReadyToken;
	readonly hostLoadReceipt: HostLoadCompletionReceipt;
	readonly cm: EditorView;
	readonly startState: EditorState;
	readonly mappedScrollEffect: StateEffect<unknown>;
	transaction: Transaction | null;
	routeSeen: boolean;
	updateSeen: boolean;
};

type ActiveSamePathAdoptionDispatchFrame = {
	readonly frameIdentity: object;
	readonly proposal: SamePathAdoptionProposal;
	readonly runtime: ManagedLeafRuntime;
	readonly cm: EditorView;
	readonly startState: EditorState;
	transaction: Transaction | null;
	updateSeen: boolean;
};

type HandoffReplaySnapshotPrivateAuthority = Readonly<{
	binding: EditorBinding;
	targetReadyToken: TargetReadyToken;
	hostLoadReceipt: HostLoadCompletionReceipt;
	nativeHistoryState: unknown;
	undoDepth: number;
	redoDepth: number;
	scrollSnapshot: ReturnType<EditorView["scrollSnapshot"]>;
}>;

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
	requestTargetPresentation(
		request: TargetPresentationRequest,
	): Promise<TargetPresentationRequestResult>;
	consumeTargetPresentationPermit(
		permitId: string,
		context: TargetPresentationPermitContext,
	): boolean;
	completeTargetPresentation(
		receipt: HostLoadCompletionReceipt,
	): Promise<TargetPresentationResult>;
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
	redeemExactHandoffReplayDispatchPermit(
		permit: HandoffReplayPermit,
	): RedeemExactHandoffReplayDispatchPermitResult;
}

export type EditorHandoffAcceptedIntentStateObservation = Readonly<{
	leafId: string;
	sessionId: string;
	generation: number;
	recoveryOperationEpoch: number;
	intentId: string;
	fromPath: string | null;
	targetPath: string;
	startContentHash: string;
	afterContentHash: string;
	state: Exclude<HandoffIntentState["kind"], "none">;
	action: "copy" | "export" | "discard" | null;
}>;

export interface EditorHandoffRecoveryActionHost {
	writeClipboard(text: string): Promise<void>;
	chooseVerifiedExporter(): Promise<((text: string) => Promise<void>) | null>;
	confirmDiscard(): Promise<boolean>;
	/** Content-free diagnostic receipt; failures must never affect Recovery. */
	observeAcceptedIntentState?(
		observation: EditorHandoffAcceptedIntentStateObservation,
	): void;
}

export type HandoffReplaySnapshotRequest = Readonly<{
	sessionId: string;
	expectedGeneration: number;
	recoveryOperationEpoch: number;
	recoveryClaim: Readonly<{
		intentId: string;
		recordId: string;
	}>;
	targetReadyToken: TargetReadyToken;
}>;

export type HandoffReplaySnapshotResult =
	| Readonly<{ kind: "ready"; snapshot: HandoffReplayTargetSnapshot }>
	| Readonly<{
		kind: "not-ready";
		reason:
			| "session-stale"
			| "generation-stale"
			| "target-token-stale"
			| "target-not-proven"
			| "binding-missing"
			| "target-identity-stale"
			| "editor-identity-stale";
	}>;

export type HandoffReplaySettlementSnapshotRequest = Readonly<{
	targetPath: string;
	planId: string;
	mode: "live" | "hydrated";
}>;

export type HandoffReplaySettlementSnapshotResult =
	| Readonly<{
		kind: "ready";
		snapshot: HandoffReplaySettlementSnapshot;
	}>
	| Readonly<{
		kind: "unavailable";
		reason:
			| "target-not-open"
			| "target-not-proven"
			| "binding-missing"
			| "editor-identity-stale";
	}>;

export type HandoffCompositionProofCaptureResult =
	| Readonly<{ kind: "not-ime" }>
	| Readonly<{ kind: "ready"; proof: HandoffCompositionProof }>
	| Readonly<{ kind: "unavailable" }>;

type ManagedTargetWorkflow = {
	readonly sessionId: string;
	readonly handoffGeneration: number;
	readonly switchIntentSeq: number;
	readonly targetFile: TFile;
	readonly targetPath: string;
	readonly candidate: PendingHostLoadCandidate;
	readonly openEditorTicket: OpenEditorMutationTicket;
	presentationPlan: TargetPresentationPlan | null;
	presentationRequestInFlight: boolean;
	presentationPermitConsumed: boolean;
	presentationCommitInFlight: boolean;
	presentationCompletionInFlight: boolean;
	hostCompletionReceipt: HostLoadCompletionReceipt | null;
	targetPresentationReceipt: TargetPresentationReceipt | null;
	targetReadyToken: TargetReadyToken | null;
	openAdmissionInFlight: boolean;
};

type ManagedLeafRuntime = {
	session: ManagedLeafSession;
	hostGuard: TextFileViewHandoffGuard | null;
	cmGuard: CodeMirrorHandoffGuard | null;
	capturedSourceAuthority: PathEditorAuthority | null;
	targetWorkflow: ManagedTargetWorkflow | null;
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
	readonly handoffPresentation: "stable" | "source" | "target-candidate" | "target-proven";
	readonly handoffPhase: NonNullable<ManagedLeafSession["handoff"]>["phase"] | null;
	readonly intentStateKind: NonNullable<ManagedLeafSession["handoff"]>["intentState"]["kind"] | null;
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
	readonly handoffReplayRecovery?: HandoffReplayRecoveryAdmissionEvidence;
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

type EditorHandoffHostQaBarrierState = EditorHandoffHostQaBarrier & Readonly<{
	holdNextHostLoad(path: string, stage?: "load-entry" | "clear-load"): void;
	releaseHeldHostLoad(): void;
	holdNextNativeSave(path: string): void;
	releaseHeldNativeSave(): void;
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
			const latestRecovery = [...session.activeRecoveries]
				.reverse()
				.find((recovery) => recovery.handoffGeneration === session.generation) ?? null;
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
				phase: handoff?.phase ?? "stable",
				recoveryOperationEpoch: handoff?.recoveryOperationEpoch ?? null,
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
				intent: latestRecovery ? Object.freeze({
					intentId: latestRecovery.intent.intentId,
					state: latestRecovery.intentState.kind,
					fromPath: latestRecovery.intent.fromPath,
					targetPath: latestRecovery.intent.targetPath,
					handoffGeneration: latestRecovery.intent.handoffGeneration,
					switchIntentSeq: latestRecovery.intent.switchIntentSeq,
					inputStartSeq: latestRecovery.intent.inputStartSeq,
					inputStartedUnderSwitchSeq: latestRecovery.intent.inputStartedUnderSwitchSeq,
					inputEpoch: latestRecovery.intent.inputEpoch,
					compositionEpoch: latestRecovery.intent.compositionEpoch,
					sequenceBegan: latestRecovery.intent.sequenceBegan,
					originKind: latestRecovery.intent.originKind,
					userEvent: latestRecovery.intent.userEvent,
					startContentHash: latestRecovery.intent.startContentHash,
					afterContentHash: latestRecovery.intent.afterContentHash,
				}) : null,
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
			if (
				armedHostLoad?.path !== input.targetPath
				|| armedHostLoad.stage !== input.stage
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

		snapshot(): EditorHandoffDebugSnapshot {
			return Object.freeze({
				hostLoad: hostLoadSnapshot,
				nativeSave: nativeSaveSnapshot,
				leaves: Object.freeze(snapshotLeaves()),
				qaReplayObservation: Object.freeze({
					phase: "none",
					planCount: 0,
					witnessStoredCount: 0,
					permitConsumedCount: 0,
					dispatchAttemptCount: 0,
					dispatchAppliedCount: 0,
					dispatchUncertainCount: 0,
					settlementObservationCount: 0,
					lastOutcome: null,
					lastClassification: null,
					selectionNonEmpty: false,
					mappedScrollAnchor: null,
					liveScrollAnchor: null,
				}),
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
	private handoffRecoveryPort: HandoffRecoveryPort | null;
	private handoffRecoveryPortActivationEpoch = 0;
	private handoffRecoveryEffectsInFlight = new Set<string>();
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
	private pendingTargetPresentationRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private targetPresentationRetryAttempts = new Map<string, number>();
	private pendingTargetBindingRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private targetBindingRetryAttempts = new Map<string, number>();
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
	private editorAuthorityRevisionByCm = new WeakMap<EditorView, number>();
	private editorAuthorityContentByCm = new WeakMap<EditorView, string>();
	private bindingPublicationOwnerByCm = new WeakMap<EditorView, object>();
	private bindingEpochByLeafId = new Map<string, number>();
	private activeHandoffReplayDispatchFrame: ActiveHandoffReplayDispatchFrame | null = null;
	private activeSamePathAdoptionDispatchFrame: ActiveSamePathAdoptionDispatchFrame | null = null;
	private samePathAdoptionPostMutationProofs =
		new WeakSet<SamePathAdoptionPostMutationProof>();
	private consumedHandoffReplayPlans = new WeakSet<HandoffReplayPlan>();
	private lastSuccessfullyAppliedHandoffReplayByLeafId = new Map<string, Readonly<{
		planId: string;
		binding: EditorBinding;
		targetFile: TFile;
		cm: EditorView;
		ytext: Y.Text;
		targetFileId: string;
		ytextIdentity: string;
		ytextMutationEpoch: number;
		bindingEpoch: number;
		editorRevision: number;
		nativeHistoryEpoch: number;
		selectionEpoch: number;
		scrollEpoch: number;
		selection: EditorSelection;
		scrollAnchor: number | null;
	}>>();
	private handoffReplayPrivateAuthorityBySnapshot =
		new WeakMap<HandoffReplayTargetSnapshot, HandoffReplaySnapshotPrivateAuthority>();
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
		private readonly requestOpenPathAdmissionCallback?: (
			request: OpenPathAdmissionWakeRequest,
		) => void,
		private readonly editorAuthorityControllerPort?: EditorAuthorityControllerPort,
		handoffRecoveryPort: HandoffRecoveryPort | null = null,
		private readonly handoffRecoveryActionHost?: EditorHandoffRecoveryActionHost,
		private readonly onHandoffTargetReady?: (token: TargetReadyToken) => void,
		private readonly onHandoffSettlementMayHaveAdvanced?: (targetPath: string) => void,
		private readonly onHandoffTargetPresentationReady?: (
			token: TargetReadyToken,
		) => void,
	) {
		this.debug = debug;
		this.handoffRecoveryPort = handoffRecoveryPort;
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

	replaceHandoffRecoveryPort(
		port: HandoffRecoveryPort | null,
		activationEpoch: number,
	): boolean {
		if (
			!Number.isSafeInteger(activationEpoch)
			|| activationEpoch < 0
			|| activationEpoch < this.handoffRecoveryPortActivationEpoch
		) return false;
		if (activationEpoch > this.handoffRecoveryPortActivationEpoch) {
			this.handoffRecoveryPort = null;
			this.handoffRecoveryPortActivationEpoch = activationEpoch;
		}
		this.handoffRecoveryPort = port;
		return true;
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

	captureHandoffCompositionProof(
		intent: HandoffInputIntent,
	): HandoffCompositionProofCaptureResult {
		const runtime = this.managedSessions.get(intent.leafId);
		const session = runtime?.session;
		const recovery = session?.activeRecoveries.find((candidate) =>
			candidate.intent === intent
			&& candidate.sessionId === intent.sessionId
			&& candidate.handoffGeneration === intent.handoffGeneration
			&& candidate.intent.switchIntentSeq === intent.switchIntentSeq
			&& candidate.intent.inputStartSeq === intent.inputStartSeq
		) ?? null;
		if (
			!runtime
			|| !session
			|| session.sessionId !== intent.sessionId
			|| session.generation !== intent.handoffGeneration
			|| recovery === null
		) return Object.freeze({ kind: "unavailable" });
		if (intent.compositionEpoch === null) {
			return Object.freeze({ kind: "not-ime" });
		}
		return captureGuardOwnedHandoffCompositionProof(intent);
	}

	captureCurrentTargetReadyToken(request: Readonly<{
		sessionId: string;
		expectedGeneration: number;
		targetPath: string;
		targetFile: TFile;
	}>): TargetReadyToken | null {
		for (const runtime of this.managedSessions.values()) {
			const session = runtime.session;
			const handoff = session.handoff;
			const workflow = runtime.targetWorkflow;
			const token = workflow?.targetReadyToken ?? null;
			const receipt = workflow?.targetPresentationReceipt ?? null;
			if (
				session.sessionId !== request.sessionId
				|| session.generation !== request.expectedGeneration
				|| !handoff
				|| handoff.presentation !== "target-proven"
				|| handoff.targetPath !== request.targetPath
				|| handoff.targetFile !== request.targetFile
				|| !workflow
				|| workflow.sessionId !== request.sessionId
				|| workflow.handoffGeneration !== request.expectedGeneration
				|| workflow.targetPath !== request.targetPath
				|| workflow.targetFile !== request.targetFile
				|| !token
				|| !receipt
				|| token.sessionId !== request.sessionId
				|| token.handoffGeneration !== request.expectedGeneration
				|| token.targetPath !== request.targetPath
				|| token.targetFile !== request.targetFile
				|| token.hostLoadReceiptId
					!== receipt.hostLoadCompletionReceipt.receiptId
				|| token.hostLoadTokenId
					!== receipt.hostLoadCompletionReceipt.hostLoadTokenId
				|| handoff.targetReadyTokenId !== token.tokenId
			) continue;
			return token;
		}
		return null;
	}

	captureHandoffReplayTargetSnapshot(
		request: HandoffReplaySnapshotRequest,
	): HandoffReplaySnapshotResult {
		let runtime: ManagedLeafRuntime | null = null;
		for (const candidate of this.managedSessions.values()) {
			if (candidate.session.sessionId === request.sessionId) {
				runtime = candidate;
				break;
			}
		}
		if (!runtime) {
			return Object.freeze({ kind: "not-ready", reason: "session-stale" });
		}
		const session = runtime.session;
		if (session.generation !== request.expectedGeneration) {
			return Object.freeze({ kind: "not-ready", reason: "generation-stale" });
		}
		const handoff = session.handoff;
		const recoveryRequest = handoff?.recoveryTargetBindingRequest ?? null;
		const recoveryIntent = handoff?.intentState.kind === "stored"
			|| handoff?.intentState.kind === "replay-pending"
			? handoff.intentState
			: null;
		if (
			!handoff
			|| handoff.presentation !== "target-proven"
			|| recoveryRequest === null
			|| recoveryIntent === null
			|| recoveryRequest.recoveryOperationEpoch
				!== request.recoveryOperationEpoch
			|| recoveryRequest.intentId !== request.recoveryClaim.intentId
			|| recoveryRequest.recordId !== request.recoveryClaim.recordId
			|| recoveryRequest.intentId !== recoveryIntent.intentId
			|| recoveryRequest.recordId !== recoveryIntent.recordId
			|| !handoff.inputGateInstalled
			|| handoff.saveGuardInstalled
			|| (
				recoveryIntent.kind === "stored"
					? handoff.phase !== "awaiting-recovery-commit"
					: handoff.phase !== "awaiting-replay-settlement"
			)
			|| handoff.recoveryOperationEpoch !== request.recoveryOperationEpoch
		) {
			return Object.freeze({ kind: "not-ready", reason: "target-not-proven" });
		}
		const token = this.captureCurrentTargetReadyToken({
			sessionId: request.sessionId,
			expectedGeneration: request.expectedGeneration,
			targetPath: request.targetReadyToken.targetPath,
			targetFile: request.targetReadyToken.targetFile,
		});
		if (token !== request.targetReadyToken) {
			return Object.freeze({ kind: "not-ready", reason: "target-token-stale" });
		}
		const authority = token.targetAuthority;
		const workflow = runtime.targetWorkflow;
		const presentationReceipt = workflow?.targetPresentationReceipt ?? null;
		const hostReceipt = presentationReceipt?.hostLoadCompletionReceipt ?? null;
		if (
			authority.kind !== "existing"
			|| !workflow
			|| !presentationReceipt
			|| !hostReceipt
			|| workflow.targetReadyToken !== token
			|| handoff.targetFile !== token.targetFile
			|| handoff.targetPath !== token.targetPath
			|| session.view.file !== token.targetFile
		) {
			return Object.freeze({ kind: "not-ready", reason: "target-identity-stale" });
		}
		const binding = this.bindings.get(session.leafId);
		if (!binding) {
			return Object.freeze({ kind: "not-ready", reason: "binding-missing" });
		}
		const displayed = session.displayedLineage;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		const cm = binding.cm;
		if (
			displayed.kind !== "known"
			|| displayed.file !== token.targetFile
			|| displayed.path !== token.targetPath
			|| displayed.cm !== cm
			|| displayed.document !== cm.state.doc
			|| binding.view !== session.view
			|| binding.file !== token.targetFile
			|| binding.path !== token.targetPath
			|| binding.fileId !== authority.fileId
			|| session.binding.kind !== "bound"
			|| session.binding.path !== token.targetPath
			|| session.binding.fileId !== authority.fileId
			|| session.binding.ytext !== binding.ytext
			|| this.vaultSync.getTextForPath(token.targetPath) !== binding.ytext
			|| this.vaultSync.getFileId(token.targetPath) !== authority.fileId
			|| this.vaultSync.getFileIdForText(binding.ytext) !== authority.fileId
			|| this.getCmView(session.view) !== cm
			|| guard?.view !== cm
			|| guard.inert
			|| !guard.gateClosed
		) {
			return Object.freeze({ kind: "not-ready", reason: "target-identity-stale" });
		}
		const cmState = cm.state;
		const cmDocument = cmState.doc;
		const cmSelection = cmState.selection;
		const bindingEpoch = this.bindingEpochByLeafId.get(session.leafId) ?? 0;
		const captureAuthorityEpoch = this.readAuthorityEpoch();
		let editorFacadeContent: string;
		let runtimeCacheContent: string;
		try {
			editorFacadeContent = session.view.editor.getValue();
			const runtimeView = session.view as unknown as TextFileView;
			const descriptor = Object.getOwnPropertyDescriptor(runtimeView, "data");
			if (
				descriptor === undefined
				|| !("value" in descriptor)
				|| typeof descriptor.value !== "string"
			) {
				return Object.freeze({
					kind: "not-ready",
					reason: "editor-identity-stale",
				});
			}
			runtimeCacheContent = descriptor.value;
		} catch {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		const editorRevision = this.editorRevisionByCm.get(cm) ?? 0;
		const localYtextMutationRevision =
			this.yTextMutationRevisionByText.get(binding.ytext) ?? 0;
		const authorityYtextMutationEpochAtBind =
			binding.authorityYtextMutationEpochAtBind;
		const localYtextMutationRevisionAtBind =
			binding.localYtextMutationRevisionAtBind;
		if (
			authorityYtextMutationEpochAtBind === undefined
			|| localYtextMutationRevisionAtBind === undefined
			|| localYtextMutationRevision < localYtextMutationRevisionAtBind
		) {
			return Object.freeze({ kind: "not-ready", reason: "target-identity-stale" });
		}
		const ytextMutationEpoch =
			authorityYtextMutationEpochAtBind
			+ (localYtextMutationRevision - localYtextMutationRevisionAtBind);
		if (!Number.isSafeInteger(ytextMutationEpoch) || ytextMutationEpoch < 0) {
			return Object.freeze({ kind: "not-ready", reason: "target-identity-stale" });
		}
		let scrollSnapshot: ReturnType<EditorView["scrollSnapshot"]>;
		try {
			scrollSnapshot = cm.scrollSnapshot();
		} catch {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		if (
			displayed.editorRevision !== editorRevision
			|| !cmSelection.eq(hostReceipt.targetSelection)
		) {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		const ytextContent = binding.ytext.toJSON();
		const finalGuard = runtime.cmGuard?.snapshot() ?? null;
		const finalDataDescriptor = Object.getOwnPropertyDescriptor(
			session.view as unknown as TextFileView,
			"data",
		);
		if (
			this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| runtime.targetWorkflow !== workflow
			|| workflow.targetReadyToken !== token
			|| workflow.targetPresentationReceipt !== presentationReceipt
			|| presentationReceipt.hostLoadCompletionReceipt !== hostReceipt
			|| session.handoff !== handoff
			|| session.displayedLineage !== displayed
			|| this.bindings.get(session.leafId) !== binding
			|| binding.view !== session.view
			|| binding.file !== token.targetFile
			|| binding.path !== token.targetPath
			|| binding.fileId !== authority.fileId
			|| binding.cm !== cm
			|| binding.ytext !== session.binding.ytext
			|| session.view.file !== token.targetFile
			|| token.targetFile.path !== token.targetPath
			|| !this.knownCmViews.has(cm)
			|| !cm.dom.isConnected
			|| !session.view.containerEl.contains(cm.dom)
			|| this.cmToLeafId.get(cm) !== session.leafId
			|| cm.state !== cmState
			|| cm.state.doc !== cmDocument
			|| !cm.state.selection.eq(cmSelection)
			|| displayed.document !== cmDocument
			|| displayed.cm !== cm
			|| displayed.editorRevision !== editorRevision
			|| (this.bindingEpochByLeafId.get(session.leafId) ?? 0)
				!== bindingEpoch
			|| (this.editorRevisionByCm.get(cm) ?? 0) !== editorRevision
			|| (this.yTextMutationRevisionByText.get(binding.ytext) ?? 0)
				!== localYtextMutationRevision
			|| binding.ytext.toJSON() !== ytextContent
			|| this.vaultSync.getTextForPath(token.targetPath) !== binding.ytext
			|| this.vaultSync.getFileId(token.targetPath) !== authority.fileId
			|| this.vaultSync.getFileIdForText(binding.ytext) !== authority.fileId
			|| finalGuard === null
			|| finalGuard.view !== guard.view
			|| finalGuard.inert !== guard.inert
			|| finalGuard.gateClosed !== guard.gateClosed
			|| finalGuard.inputEpoch !== guard.inputEpoch
			|| finalGuard.compositionEpoch !== guard.compositionEpoch
			|| finalGuard.nativeHistoryEpoch !== guard.nativeHistoryEpoch
			|| finalGuard.selectionEpoch !== guard.selectionEpoch
			|| finalGuard.scrollEpoch !== guard.scrollEpoch
			|| finalGuard.commitState !== guard.commitState
			|| finalGuard.pendingHostLoadCandidate !== guard.pendingHostLoadCandidate
			|| finalDataDescriptor === undefined
			|| !("value" in finalDataDescriptor)
			|| finalDataDescriptor.value !== runtimeCacheContent
			|| this.readAuthorityEpoch() !== captureAuthorityEpoch
		) {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		let finalScrollSnapshot: ReturnType<EditorView["scrollSnapshot"]>;
		try {
			finalScrollSnapshot = cm.scrollSnapshot();
		} catch {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		const postScrollGuard = runtime.cmGuard?.snapshot() ?? null;
		const postScrollDataDescriptor = Object.getOwnPropertyDescriptor(
			session.view as unknown as TextFileView,
			"data",
		);
		if (
			!sameScrollSnapshot(scrollSnapshot, finalScrollSnapshot)
			|| this.readAuthorityEpoch() !== captureAuthorityEpoch
			|| this.managedSessions.get(session.leafId) !== runtime
			|| runtime.session !== session
			|| runtime.targetWorkflow !== workflow
			|| workflow.targetReadyToken !== token
			|| workflow.targetPresentationReceipt !== presentationReceipt
			|| session.handoff !== handoff
			|| session.displayedLineage !== displayed
			|| this.bindings.get(session.leafId) !== binding
			|| cm.state !== cmState
			|| cm.state.doc !== cmDocument
			|| !cm.state.selection.eq(cmSelection)
			|| (this.bindingEpochByLeafId.get(session.leafId) ?? 0)
				!== bindingEpoch
			|| (this.editorRevisionByCm.get(cm) ?? 0) !== editorRevision
			|| (this.yTextMutationRevisionByText.get(binding.ytext) ?? 0)
				!== localYtextMutationRevision
			|| binding.ytext.toJSON() !== ytextContent
			|| postScrollGuard === null
			|| postScrollGuard.view !== finalGuard.view
			|| postScrollGuard.inert !== finalGuard.inert
			|| postScrollGuard.gateClosed !== finalGuard.gateClosed
			|| postScrollGuard.inputEpoch !== finalGuard.inputEpoch
			|| postScrollGuard.compositionEpoch !== finalGuard.compositionEpoch
			|| postScrollGuard.nativeHistoryEpoch !== finalGuard.nativeHistoryEpoch
			|| postScrollGuard.selectionEpoch !== finalGuard.selectionEpoch
			|| postScrollGuard.scrollEpoch !== finalGuard.scrollEpoch
			|| postScrollGuard.commitState !== finalGuard.commitState
			|| postScrollGuard.pendingHostLoadCandidate
				!== finalGuard.pendingHostLoadCandidate
			|| postScrollDataDescriptor === undefined
			|| !("value" in postScrollDataDescriptor)
			|| postScrollDataDescriptor.value !== runtimeCacheContent
		) {
			return Object.freeze({ kind: "not-ready", reason: "editor-identity-stale" });
		}
		const snapshot: HandoffReplayTargetSnapshot = Object.freeze({
				sessionId: session.sessionId,
				leafId: session.leafId,
				handoffGeneration: session.generation,
				recoveryOperationEpoch: request.recoveryOperationEpoch,
				targetReadyTokenId: token.tokenId,
				hostLoadTokenId: token.hostLoadTokenId,
				hostLoadReceiptId: token.hostLoadReceiptId,
				targetPath: token.targetPath,
				targetFile: token.targetFile,
				targetFileId: authority.fileId,
				cm,
				ytext: binding.ytext,
				ytextIdentity: authority.ytextIdentity,
				ytextMutationEpoch,
				bindingEpoch,
				editorRevision,
				nativeHistoryEpoch: guard.nativeHistoryEpoch,
				selectionEpoch: guard.selectionEpoch,
				scrollEpoch: guard.scrollEpoch,
				selection: cmSelection,
				scrollAnchor: scrollSnapshot.value.range.head,
				cmDocument,
				editorFacadeContent,
				runtimeCacheContent,
				ytextContent,
			});
		this.handoffReplayPrivateAuthorityBySnapshot.set(snapshot, Object.freeze({
			binding,
			targetReadyToken: token,
			hostLoadReceipt: hostReceipt,
			nativeHistoryState: cm.state.field(historyField, false),
			undoDepth: undoDepth(cm.state),
			redoDepth: redoDepth(cm.state),
			scrollSnapshot,
		}));
		return Object.freeze({
			kind: "ready",
			snapshot,
		});
	}

	captureHandoffReplaySettlementSnapshot(
		request: HandoffReplaySettlementSnapshotRequest,
	): HandoffReplaySettlementSnapshotResult {
		const candidates = Array.from(this.bindings.entries()).filter(
			([, binding]) => binding.path === request.targetPath,
		);
		if (candidates.length === 0) {
			const targetOpen = Array.from(this.managedSessions.values()).some(
				(runtime) => runtime.session.view.file?.path === request.targetPath,
			);
			return Object.freeze({
				kind: "unavailable",
				reason: targetOpen ? "binding-missing" : "target-not-open",
			});
		}
		if (candidates.length !== 1) {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}
		const [leafId, binding] = candidates[0]!;
		const runtime = this.managedSessions.get(leafId) ?? null;
		const session = runtime?.session ?? null;
		const handoff = session?.handoff ?? null;
		const workflow = runtime?.targetWorkflow ?? null;
		const presentationReceipt = workflow?.targetPresentationReceipt ?? null;
		const hostReceipt = presentationReceipt?.hostLoadCompletionReceipt ?? null;
		const token = workflow?.targetReadyToken ?? null;
		if (
			runtime === null
			|| session === null
			|| handoff === null
			|| handoff.presentation !== "target-proven"
			|| handoff.phase !== "awaiting-replay-settlement"
			|| handoff.intentState.kind !== "replayed-awaiting-settlement"
			|| handoff.targetPath !== request.targetPath
			|| workflow === null
			|| presentationReceipt === null
			|| hostReceipt === null
			|| token === null
			|| token.targetAuthority.kind !== "existing"
		) {
			return Object.freeze({
				kind: "unavailable",
				reason: "target-not-proven",
			});
		}
		const authority = token.targetAuthority;
		const displayed = session.displayedLineage;
		const guard = runtime.cmGuard?.snapshot() ?? null;
		const cm = binding.cm;
		if (
			displayed.kind !== "known"
			|| displayed.file !== binding.file
			|| displayed.path !== request.targetPath
			|| displayed.cm !== cm
			|| displayed.document !== cm.state.doc
			|| binding.view !== session.view
			|| binding.file !== handoff.targetFile
			|| binding.file !== token.targetFile
			|| binding.file.path !== request.targetPath
			|| binding.fileId !== authority.fileId
			|| session.view.file !== binding.file
			|| session.binding.kind !== "bound"
			|| session.binding.path !== request.targetPath
			|| session.binding.fileId !== authority.fileId
			|| session.binding.ytext !== binding.ytext
			|| workflow.targetReadyToken !== token
			|| workflow.targetPath !== request.targetPath
			|| workflow.targetFile !== binding.file
			|| token.targetPath !== request.targetPath
			|| token.hostLoadTokenId !== hostReceipt.hostLoadTokenId
			|| token.hostLoadReceiptId !== hostReceipt.receiptId
			|| this.vaultSync.getTextForPath(request.targetPath) !== binding.ytext
			|| this.vaultSync.getFileId(request.targetPath) !== authority.fileId
			|| this.vaultSync.getFileIdForText(binding.ytext) !== authority.fileId
			|| this.getCmView(session.view) !== cm
			|| !this.knownCmViews.has(cm)
			|| this.cmToLeafId.get(cm) !== leafId
			|| !cm.dom.isConnected
			|| !session.view.containerEl.contains(cm.dom)
			|| guard?.view !== cm
			|| guard.inert
			|| !guard.gateClosed
		) {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}

		const captureAuthorityEpoch = this.readAuthorityEpoch();
		const cmState = cm.state;
		const cmDocument = cmState.doc;
		const selection = cmState.selection;
		const bindingEpoch = this.bindingEpochByLeafId.get(leafId) ?? 0;
		const editorRevision = this.editorRevisionByCm.get(cm) ?? 0;
		const localYtextRevision =
			this.yTextMutationRevisionByText.get(binding.ytext) ?? 0;
		const authorityAtBind = binding.authorityYtextMutationEpochAtBind;
		const localAtBind = binding.localYtextMutationRevisionAtBind;
		if (
			authorityAtBind === undefined
			|| localAtBind === undefined
			|| localYtextRevision < localAtBind
		) {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}
		const ytextMutationEpoch =
			authorityAtBind + (localYtextRevision - localAtBind);
		if (!Number.isSafeInteger(ytextMutationEpoch) || ytextMutationEpoch < 0) {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}

		let editorFacadeContent: string;
		let runtimeCacheContent: string;
		let scrollSnapshot: ReturnType<EditorView["scrollSnapshot"]>;
		try {
			editorFacadeContent = session.view.editor.getValue();
			const descriptor = Object.getOwnPropertyDescriptor(
				session.view as unknown as TextFileView,
				"data",
			);
			if (
				descriptor === undefined
				|| !("value" in descriptor)
				|| typeof descriptor.value !== "string"
			) {
				return Object.freeze({
					kind: "unavailable",
					reason: "editor-identity-stale",
				});
			}
			runtimeCacheContent = descriptor.value;
			scrollSnapshot = cm.scrollSnapshot();
		} catch {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}
		const ytextContent = binding.ytext.toJSON();
		const finalGuard = runtime.cmGuard?.snapshot() ?? null;
		let finalScrollSnapshot: ReturnType<EditorView["scrollSnapshot"]>;
		try {
			finalScrollSnapshot = cm.scrollSnapshot();
		} catch {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}
		const finalDescriptor = Object.getOwnPropertyDescriptor(
			session.view as unknown as TextFileView,
			"data",
		);
		if (
			this.readAuthorityEpoch() !== captureAuthorityEpoch
			|| this.bindings.get(leafId) !== binding
			|| this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== session
			|| runtime.targetWorkflow !== workflow
			|| session.handoff !== handoff
			|| workflow.targetReadyToken !== token
			|| workflow.targetPresentationReceipt !== presentationReceipt
			|| presentationReceipt.hostLoadCompletionReceipt !== hostReceipt
			|| binding.view !== session.view
			|| binding.file !== token.targetFile
			|| binding.path !== request.targetPath
			|| binding.fileId !== authority.fileId
			|| binding.cm !== cm
			|| binding.ytext !== session.binding.ytext
			|| session.view.file !== token.targetFile
			|| token.targetFile.path !== request.targetPath
			|| cm.state !== cmState
			|| cm.state.doc !== cmDocument
			|| !cm.state.selection.eq(selection)
			|| displayed.document !== cmDocument
			|| displayed.editorRevision !== editorRevision
			|| (this.bindingEpochByLeafId.get(leafId) ?? 0) !== bindingEpoch
			|| (this.editorRevisionByCm.get(cm) ?? 0) !== editorRevision
			|| (this.yTextMutationRevisionByText.get(binding.ytext) ?? 0)
				!== localYtextRevision
			|| binding.ytext.toJSON() !== ytextContent
			|| this.vaultSync.getTextForPath(request.targetPath) !== binding.ytext
			|| this.vaultSync.getFileId(request.targetPath) !== authority.fileId
			|| this.vaultSync.getFileIdForText(binding.ytext) !== authority.fileId
			|| finalGuard === null
			|| finalGuard.view !== guard.view
			|| finalGuard.inert !== guard.inert
			|| finalGuard.gateClosed !== guard.gateClosed
			|| finalGuard.nativeHistoryEpoch !== guard.nativeHistoryEpoch
			|| finalGuard.selectionEpoch !== guard.selectionEpoch
			|| finalGuard.scrollEpoch !== guard.scrollEpoch
			|| !sameScrollSnapshot(scrollSnapshot, finalScrollSnapshot)
			|| finalDescriptor === undefined
			|| !("value" in finalDescriptor)
			|| finalDescriptor.value !== runtimeCacheContent
		) {
			return Object.freeze({
				kind: "unavailable",
				reason: "editor-identity-stale",
			});
		}

		const applied = this.lastSuccessfullyAppliedHandoffReplayByLeafId.get(leafId);
		const appliedPlanId = applied
			&& applied.planId === request.planId
			&& applied.binding === binding
			&& applied.targetFile === binding.file
			&& applied.cm === cm
			&& applied.ytext === binding.ytext
			&& applied.targetFileId === authority.fileId
			&& applied.ytextIdentity === authority.ytextIdentity
			&& applied.ytextMutationEpoch === ytextMutationEpoch
			&& applied.bindingEpoch === bindingEpoch
			&& applied.editorRevision === editorRevision
			&& applied.nativeHistoryEpoch === guard.nativeHistoryEpoch
			&& applied.selectionEpoch === guard.selectionEpoch
			&& applied.scrollEpoch === guard.scrollEpoch
			&& applied.selection.eq(selection)
			&& applied.scrollAnchor === scrollSnapshot.value.range.head
				? applied.planId
				: null;
		return Object.freeze({
			kind: "ready",
			snapshot: Object.freeze({
				planId: appliedPlanId,
				sessionId: session.sessionId,
				leafId: session.leafId,
				handoffGeneration: session.generation,
				recoveryOperationEpoch: handoff.recoveryOperationEpoch,
				targetReadyTokenId: token.tokenId,
				hostLoadTokenId: token.hostLoadTokenId,
				hostLoadReceiptId: token.hostLoadReceiptId,
				targetPath: request.targetPath,
				targetFile: binding.file,
				targetFileId: authority.fileId,
				cm,
				ytext: binding.ytext,
				ytextIdentity: authority.ytextIdentity,
				ytextMutationEpoch,
				bindingEpoch,
				editorRevision,
				nativeHistoryEpoch: guard.nativeHistoryEpoch,
				selectionEpoch: guard.selectionEpoch,
				scrollEpoch: guard.scrollEpoch,
				selection,
				scrollAnchor: scrollSnapshot.value.range.head,
				cmDocument,
				editorFacadeContent,
				runtimeCacheContent,
				ytextContent,
			}),
		});
	}

	clearHandoffReplaySettlementProofs(): void {
		this.lastSuccessfullyAppliedHandoffReplayByLeafId.clear();
	}

	private classifyHandoffReplaySnapshotDrift(
		expected: HandoffReplayTargetSnapshot,
		expectedPrivate: HandoffReplaySnapshotPrivateAuthority,
		actual: HandoffReplayTargetSnapshot,
	): HandoffReplayNotAppliedReason | null {
		const actualPrivate =
			this.handoffReplayPrivateAuthorityBySnapshot.get(actual);
		if (!actualPrivate || actualPrivate.binding !== expectedPrivate.binding) {
			return "binding-stale";
		}
		if (
			actual.sessionId !== expected.sessionId
			|| actual.leafId !== expected.leafId
		) return "session-stale";
		if (actual.handoffGeneration !== expected.handoffGeneration) {
			return "generation-stale";
		}
		if (actual.recoveryOperationEpoch !== expected.recoveryOperationEpoch) {
			return "recovery-operation-stale";
		}
		if (
			actual.targetReadyTokenId !== expected.targetReadyTokenId
			|| actualPrivate.targetReadyToken !== expectedPrivate.targetReadyToken
		) return "target-token-stale";
		if (
			actual.targetPath !== expected.targetPath
			|| actual.targetFile !== expected.targetFile
			|| actual.targetFileId !== expected.targetFileId
			|| actual.hostLoadTokenId !== expected.hostLoadTokenId
			|| actual.hostLoadReceiptId !== expected.hostLoadReceiptId
		) return "target-file-stale";
		if (
			actual.bindingEpoch !== expected.bindingEpoch
			|| actual.ytext !== expected.ytext
			|| actual.ytextIdentity !== expected.ytextIdentity
		) return "binding-stale";
		if (
			actual.cm !== expected.cm
			|| actual.editorRevision !== expected.editorRevision
		) return "editor-stale";
		if (
			actual.cmDocument !== expected.cmDocument
			|| actual.cmDocument.toString() !== expected.cmDocument.toString()
		) return "document-stale";
		if (actual.editorFacadeContent !== expected.editorFacadeContent) {
			return "editor-facade-stale";
		}
		if (actual.runtimeCacheContent !== expected.runtimeCacheContent) {
			return "runtime-cache-stale";
		}
		if (
			actual.ytextMutationEpoch !== expected.ytextMutationEpoch
			|| actual.ytextContent !== expected.ytextContent
		) return "ytext-stale";
		if (
			actual.nativeHistoryEpoch !== expected.nativeHistoryEpoch
			|| actualPrivate.nativeHistoryState !== expectedPrivate.nativeHistoryState
			|| actualPrivate.undoDepth !== expectedPrivate.undoDepth
			|| actualPrivate.redoDepth !== expectedPrivate.redoDepth
		) return "native-history-stale";
		if (
			actual.selectionEpoch !== expected.selectionEpoch
			|| !actual.selection.eq(expected.selection)
		) return "selection-stale";
		if (
			actual.scrollEpoch !== expected.scrollEpoch
			|| actual.scrollAnchor !== expected.scrollAnchor
			|| !sameScrollSnapshot(
				actualPrivate.scrollSnapshot,
				expectedPrivate.scrollSnapshot,
			)
		) return "scroll-stale";
		return null;
	}

	private handoffReplayNotReadyReason(
		reason: Exclude<
			HandoffReplaySnapshotResult,
			Readonly<{ kind: "ready" }>
		>["reason"],
	): HandoffReplayNotAppliedReason {
		return reason === "session-stale"
			? "session-stale"
			: reason === "generation-stale"
				? "generation-stale"
				: reason === "target-token-stale"
					? "target-token-stale"
					: reason === "target-not-proven"
						? "recovery-state-stale"
						: reason === "binding-missing"
							? "binding-stale"
							: reason === "target-identity-stale"
								? "target-file-stale"
								: "editor-stale";
	}

	applyExactHandoffReplay(request: Readonly<{
		plan: HandoffReplayPlan;
		permit: HandoffReplayPermit;
		record: ActiveHandoffRecoveryRecord & Readonly<{ status: "replay-pending" }>;
		recoveryOperationEpoch: number;
	}>): HandoffReplayDispatchResult {
		if (
			typeof request !== "object"
			|| request === null
			|| typeof request.plan !== "object"
			|| request.plan === null
			|| typeof request.permit !== "object"
			|| request.permit === null
		) {
			return { kind: "not-applied", reason: "permit-mismatch" };
		}
		const { plan, permit, record, recoveryOperationEpoch } = request;
		if (this.consumedHandoffReplayPlans.has(plan)) {
			return { kind: "not-applied", reason: "plan-already-consumed" };
		}
		const controller = this.editorAuthorityControllerPort;
		if (!controller) {
			return { kind: "not-applied", reason: "permit-mismatch" };
		}
		const redeemed = controller.redeemExactHandoffReplayDispatchPermit(permit);
		if (redeemed.kind === "rejected") {
			return { kind: "not-applied", reason: redeemed.reason };
		}
		this.consumedHandoffReplayPlans.add(plan);
		const expected = redeemed.snapshot;
		const privateAuthority =
			this.handoffReplayPrivateAuthorityBySnapshot.get(expected);
		if (!privateAuthority) {
			return { kind: "not-applied", reason: "permit-mismatch" };
		}
		if (redeemed.plan !== plan) {
			return { kind: "not-applied", reason: "plan-mismatch" };
		}
		if (redeemed.record !== record) {
			return { kind: "not-applied", reason: "record-mismatch" };
		}
		if (
			permit.planId !== plan.planId
			|| permit.permitId !== plan.replayPermitId
			|| plan.targetReadyTokenId !== expected.targetReadyTokenId
			|| plan.expectedTargetDocument !== expected.cmDocument
			|| plan.expectedSelectionEpoch !== expected.selectionEpoch
			|| plan.expectedNativeHistoryEpoch !== expected.nativeHistoryEpoch
			|| plan.expectedTargetScrollEpoch !== expected.scrollEpoch
			|| plan.switchIntentSeq !== privateAuthority.targetReadyToken.switchIntentSeq
		) {
			return { kind: "not-applied", reason: "plan-mismatch" };
		}
		let recomputedStartHash: string;
		try {
			recomputedStartHash = sha256HandoffRecoveryHexSync(
				expected.cmDocument.toString(),
			);
		} catch {
			return { kind: "not-applied", reason: "record-mismatch" };
		}
		if (
			record.status !== "replay-pending"
			|| permit.recordId !== record.recordId
			|| permit.replayPendingChecksum !== record.checksum
			|| permit.recordId.length === 0
			|| record.intentId !== plan.intentId
			|| record.targetPath !== expected.targetPath
			|| record.applyWitness === null
			|| record.applyWitness.planId !== plan.planId
			|| record.applyWitness.kind !== plan.kind
			|| record.applyWitness.switchIntentSeq !== plan.switchIntentSeq
			|| record.applyWitness.hostLoadTokenId !== expected.hostLoadTokenId
			|| record.applyWitness.targetFileId !== expected.targetFileId
			|| record.applyWitness.targetYtextIdentity !== expected.ytextIdentity
			|| record.applyWitness.targetMutationEpochAtPlan
				!== expected.ytextMutationEpoch
			|| record.applyWitness.nativeHistoryEpoch !== expected.nativeHistoryEpoch
			|| record.applyWitness.targetSelectionEpoch !== expected.selectionEpoch
			|| record.applyWitness.targetScrollEpoch !== expected.scrollEpoch
			|| record.body.startContent !== expected.cmDocument.toString()
			|| record.startContentHash !== recomputedStartHash
			|| record.applyWitness.plannedStartHash !== recomputedStartHash
			|| record.applyWitness.plannedResultContent !== record.body.afterContent
			|| record.applyWitness.plannedResultHash !== record.afterContentHash
			|| record.applyWitness.serializedMappedSelection
				!== canonicalHandoffRecoveryJson(plan.mappedSelection.toJSON())
			|| record.applyWitness.dispatchReceiptHash !== null
		) {
			return { kind: "not-applied", reason: "record-mismatch" };
		}
		let validatedRecordCanonical: string;
		try {
			validatedRecordCanonical = canonicalHandoffRecoveryJson(record);
		} catch {
			return { kind: "not-applied", reason: "record-mismatch" };
		}
		if (
			!Number.isSafeInteger(recoveryOperationEpoch)
			|| recoveryOperationEpoch < 0
			|| permit.recoveryOperationEpoch !== recoveryOperationEpoch
			|| expected.recoveryOperationEpoch !== recoveryOperationEpoch
		) {
			return { kind: "not-applied", reason: "recovery-operation-stale" };
		}
		let expectedResultContent: string;
		let expectedMappedScrollAnchor: number | null;
		try {
			expectedResultContent =
				plan.replayChanges.apply(expected.cmDocument).toString();
			expectedMappedScrollAnchor = expected.scrollAnchor === null
				? null
				: plan.replayChanges.mapPos(expected.scrollAnchor, -1);
		} catch {
			return { kind: "not-applied", reason: "plan-mismatch" };
		}
		if (
			expectedResultContent !== record.body.afterContent
			|| expectedMappedScrollAnchor !== plan.mappedScrollAnchor
		) {
			return { kind: "not-applied", reason: "plan-mismatch" };
		}
		const current = this.captureHandoffReplayTargetSnapshot({
			sessionId: expected.sessionId,
			expectedGeneration: expected.handoffGeneration,
			recoveryOperationEpoch,
			recoveryClaim: Object.freeze({
				intentId: record.intentId,
				recordId: record.recordId,
			}),
			targetReadyToken: privateAuthority.targetReadyToken,
		});
		if (current.kind !== "ready") {
			return {
				kind: "not-applied",
				reason: this.handoffReplayNotReadyReason(current.reason),
			};
		}
		const actual = current.snapshot;
		const driftReason = this.classifyHandoffReplaySnapshotDrift(
			expected,
			privateAuthority,
			actual,
		);
		if (driftReason !== null) {
			return { kind: "not-applied", reason: driftReason };
		}

		const mappedScrollEffect =
			privateAuthority.scrollSnapshot.map(plan.replayChanges);
		if (
			mappedScrollEffect === undefined
			|| (
				plan.mappedScrollAnchor !== null
				&& mappedScrollEffect.value.range.head
					!== plan.mappedScrollAnchor
			)
		) {
			return { kind: "not-applied", reason: "scroll-effect-unmappable" };
		}
		if (this.activeHandoffReplayDispatchFrame !== null) {
			this.trace?.("editor", "handoff-replay-dispatch-rejected", {
				stage: "active-frame",
			});
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		const frameIdentity = Object.freeze({});
		let transaction: Transaction;
		try {
			transaction = actual.cm.state.update({
				changes: plan.replayChanges,
				selection: plan.mappedSelection,
				effects: mappedScrollEffect,
				annotations: [
					Transaction.addToHistory.of(true),
					Transaction.userEvent.of("input.handoff-replay"),
					isolateHistory.of("full"),
					acceptedHandoffReplay.of({
						permit,
						frameIdentity,
					}),
				],
			});
		} catch (error) {
			this.trace?.("editor", "handoff-replay-dispatch-rejected", {
				stage: "transaction-construction",
				errorKind: error instanceof Error
					? "error"
					: error === null
						? "null"
						: typeof error,
			});
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		const postConstruction = this.captureHandoffReplayTargetSnapshot({
			sessionId: expected.sessionId,
			expectedGeneration: expected.handoffGeneration,
			recoveryOperationEpoch,
			recoveryClaim: Object.freeze({
				intentId: record.intentId,
				recordId: record.recordId,
			}),
			targetReadyToken: privateAuthority.targetReadyToken,
		});
		if (postConstruction.kind !== "ready") {
			return {
				kind: "not-applied",
				reason: this.handoffReplayNotReadyReason(postConstruction.reason),
			};
		}
		const constructionDrift = this.classifyHandoffReplaySnapshotDrift(
			expected,
			privateAuthority,
			postConstruction.snapshot,
		);
		if (constructionDrift !== null) {
			return { kind: "not-applied", reason: constructionDrift };
		}
		const dispatchRuntime = this.managedSessions.get(expected.leafId);
		const dispatchSession = dispatchRuntime?.session;
		const dispatchHandoff = dispatchSession?.handoff ?? null;
		const dispatchWorkflow = dispatchRuntime?.targetWorkflow ?? null;
		if (
			!dispatchRuntime
			|| !dispatchSession
			|| !dispatchHandoff
			|| !dispatchWorkflow
			|| dispatchSession.sessionId !== expected.sessionId
			|| dispatchSession.generation !== expected.handoffGeneration
			|| dispatchWorkflow.targetReadyToken
				!== privateAuthority.targetReadyToken
			|| dispatchWorkflow.targetPresentationReceipt
				?.hostLoadCompletionReceipt !== privateAuthority.hostLoadReceipt
			|| this.bindings.get(expected.leafId) !== privateAuthority.binding
			|| actual.cm.state !== transaction.startState
		) {
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		const frame: ActiveHandoffReplayDispatchFrame = {
			frameIdentity,
			permit,
			plan,
			record,
			recoveryOperationEpoch,
			expectedSnapshot: expected,
			runtime: dispatchRuntime,
			session: dispatchSession,
			handoff: dispatchHandoff,
			workflow: dispatchWorkflow,
			binding: privateAuthority.binding,
			targetReadyToken: privateAuthority.targetReadyToken,
			hostLoadReceipt: privateAuthority.hostLoadReceipt,
			cm: actual.cm,
			startState: actual.cm.state,
			mappedScrollEffect,
			transaction,
			routeSeen: false,
			updateSeen: false,
		};
		const captureDispatchMutationCensus = () => {
			try {
				const binding = this.bindings.get(expected.leafId) ?? null;
				const runtime = this.managedSessions.get(expected.leafId) ?? null;
				const session = runtime?.session ?? null;
				const handoff = session?.handoff ?? null;
				const workflow = runtime?.targetWorkflow ?? null;
				const presentationReceipt =
					workflow?.targetPresentationReceipt ?? null;
				const targetReadyToken = workflow?.targetReadyToken ?? null;
				const targetAuthority = targetReadyToken?.targetAuthority ?? null;
				const displayed = session?.displayedLineage ?? null;
				const view = privateAuthority.binding.view;
				const editorFacade = view.editor;
				const undoManager = privateAuthority.binding.undoManager;
				const dataDescriptor = Object.getOwnPropertyDescriptor(
					view as unknown as TextFileView,
					"data",
				);
				const cmState = actual.cm.state;
				const ydoc = expected.ytext.doc;
				return Object.freeze({
					authorityEpoch: this.readAuthorityEpoch(),
					authorityEpochExhausted: this.authorityEpochExhausted,
					asyncAuthorityOpen: this.asyncAuthorityOpen,
					binding,
					bindingEpoch:
						this.bindingEpochByLeafId.get(expected.leafId) ?? 0,
					bindingView: binding?.view ?? null,
					bindingFile: binding?.file ?? null,
					bindingPath: binding?.path ?? null,
					bindingFileId: binding?.fileId ?? null,
					bindingCm: binding?.cm ?? null,
					bindingYtext: binding?.ytext ?? null,
					bindingUndoManager: binding?.undoManager ?? null,
					bindingCmId: binding?.cmId ?? null,
					bindingLastBoundAt: binding?.lastBoundAt ?? null,
					bindingLastBoundAtMs: binding?.lastBoundAtMs ?? null,
					bindingLastEditorChangeAtMs:
						binding?.lastEditorChangeAtMs ?? null,
					bindingLastEditorDocChangeAtMs:
						binding?.lastEditorDocChangeAtMs ?? null,
					bindingSettleWindowMs: binding?.settleWindowMs ?? null,
					bindingAuthorityYtextMutationEpochAtBind:
						binding?.authorityYtextMutationEpochAtBind ?? null,
					bindingLocalYtextMutationRevisionAtBind:
						binding?.localYtextMutationRevisionAtBind ?? null,
					lastEditorDocChangeAtForPath:
						this.lastEditorDocChangeAtByPath.get(expected.targetPath)
							?? null,
					lastUserDocChangeAtForCm:
						this.lastUserDocChangeAtByCm.get(actual.cm) ?? null,
					lastTypingAwarenessAtForLeaf:
						this.lastTypingAwarenessAtByLeaf.get(expected.leafId)
							?? null,
					runtime,
					hostGuard: runtime?.hostGuard ?? null,
					hostGuardSnapshot:
						runtime?.hostGuard?.snapshot() ?? null,
					cmGuard: runtime?.cmGuard ?? null,
					capturedSourceAuthority:
						runtime?.capturedSourceAuthority ?? null,
					capturedSourceAuthorityKind:
						runtime?.capturedSourceAuthority?.kind ?? null,
					capturedSourceAuthorityContent:
						runtime?.capturedSourceAuthority?.kind === "proven-single"
							? runtime.capturedSourceAuthority.content
							: null,
					capturedSourceAuthorityLease:
						runtime?.capturedSourceAuthority?.kind === "proven-single"
							? runtime.capturedSourceAuthority.lease
							: null,
					capturedSourceAuthorityLeaseId:
						runtime?.capturedSourceAuthority?.kind === "proven-single"
							? runtime.capturedSourceAuthority.lease.leaseId
							: null,
					capturedSourceAuthorityReason:
						runtime?.capturedSourceAuthority?.kind === "blocked"
							? runtime.capturedSourceAuthority.reason
							: null,
					session,
					sessionId: session?.sessionId ?? null,
					sessionLeafId: session?.leafId ?? null,
					sessionGeneration: session?.generation ?? null,
					sessionEventOrderSeq: session?.eventOrderSeq ?? null,
					sessionSwitchIntentSeq:
						session?.currentSwitchIntentSeq ?? null,
					sessionNativeHistoryEpoch:
						session?.nativeHistoryEpoch ?? null,
					sessionCompletedDetachEpoch:
						session?.completedDetachEpoch ?? null,
					sessionActiveRecoveries:
						session?.activeRecoveries ?? null,
					sessionPendingInputStartReservation:
						session?.pendingInputStartReservation ?? null,
					handoff,
					handoffSourceAuthorityPath:
						handoff?.sourceAuthorityPath ?? null,
					handoffTargetPath: handoff?.targetPath ?? null,
					handoffTargetFile: handoff?.targetFile ?? null,
					handoffBindingEpochAfterDetach:
						handoff?.bindingEpochAfterDetach ?? null,
					handoffPresentation: handoff?.presentation ?? null,
					handoffTargetReadyTokenId:
						handoff?.targetReadyTokenId ?? null,
					handoffInputGateInstalled:
						handoff?.inputGateInstalled ?? null,
					handoffSaveGuardInstalled:
						handoff?.saveGuardInstalled ?? null,
					handoffRecoveryOperationEpoch:
						handoff?.recoveryOperationEpoch ?? null,
					handoffIntentState:
						handoff?.intentState ?? null,
					handoffPhase: handoff?.phase ?? null,
					handoffPendingHostLoadCandidate:
						handoff?.pendingHostLoadCandidate ?? null,
					handoffRecoveryTargetBindingRequest:
						handoff?.recoveryTargetBindingRequest ?? null,
					workflow,
					workflowSessionId: workflow?.sessionId ?? null,
					workflowGeneration:
						workflow?.handoffGeneration ?? null,
					workflowSwitchIntentSeq:
						workflow?.switchIntentSeq ?? null,
					workflowTargetFile: workflow?.targetFile ?? null,
					workflowTargetPath: workflow?.targetPath ?? null,
					workflowCandidate: workflow?.candidate ?? null,
					workflowOpenEditorTicket:
						workflow?.openEditorTicket ?? null,
					workflowPresentationPlan:
						workflow?.presentationPlan ?? null,
					workflowPresentationRequestInFlight:
						workflow?.presentationRequestInFlight ?? null,
					workflowPresentationPermitConsumed:
						workflow?.presentationPermitConsumed ?? null,
					workflowPresentationCommitInFlight:
						workflow?.presentationCommitInFlight ?? null,
					workflowPresentationCompletionInFlight:
						workflow?.presentationCompletionInFlight ?? null,
					workflowHostCompletionReceipt:
						workflow?.hostCompletionReceipt ?? null,
					workflowOpenAdmissionInFlight:
						workflow?.openAdmissionInFlight ?? null,
					presentationReceipt,
					hostLoadReceipt:
						presentationReceipt?.hostLoadCompletionReceipt ?? null,
					targetReadyToken,
					targetAuthority,
					targetTokenId: targetReadyToken?.tokenId ?? null,
					targetTokenPath: targetReadyToken?.targetPath ?? null,
					targetTokenFile: targetReadyToken?.targetFile ?? null,
					targetTokenMutationEpoch: targetAuthority?.kind === "existing"
						? targetAuthority.ytextMutationEpoch
						: null,
					sessionView: session?.view ?? null,
					sessionViewFile: session?.view.file ?? null,
					sessionBinding: session?.binding ?? null,
					sessionBindingKind: session?.binding.kind ?? null,
					sessionBindingPath: session?.binding.kind === "bound"
						? session.binding.path
						: null,
					sessionBindingFileId: session?.binding.kind === "bound"
						? session.binding.fileId
						: null,
					sessionBindingYtext: session?.binding.kind === "bound"
						? session.binding.ytext
						: null,
					displayed,
					displayedKind: displayed?.kind ?? null,
					displayedFile: displayed?.kind === "known"
						? displayed.file
						: null,
					displayedPath: displayed?.kind === "known"
						? displayed.path
						: null,
					displayedFileId: displayed?.kind === "known"
						? displayed.fileId
						: null,
					displayedCm: displayed?.kind === "known"
						? displayed.cm
						: null,
					displayedDocument: displayed?.kind === "known"
						? displayed.document
						: null,
					displayedEditorRevision: displayed?.kind === "known"
						? displayed.editorRevision
						: null,
					view,
					viewFile: view.file,
					editorFacade,
					editorFacadeGetValue: Reflect.get(editorFacade, "getValue"),
					editorFacadeContent: editorFacade.getValue(),
					dataDescriptor,
					cm: actual.cm,
					cmState,
					cmDocument: cmState.doc,
					cmDocumentContent: cmState.doc.toString(),
					cmSelection: cmState.selection,
					historyState: cmState.field(historyField, false),
					undoDepth: undoDepth(cmState),
					redoDepth: redoDepth(cmState),
					undoManager,
					undoManagerLastChange: undoManager.lastChange,
					undoManagerUndoing: undoManager.undoing,
					undoManagerRedoing: undoManager.redoing,
					undoManagerCurrentStackItem:
						undoManager.currStackItem,
					undoManagerUndoStack: undoManager.undoStack,
					undoManagerRedoStack: undoManager.redoStack,
					undoManagerUndoStackLength:
						undoManager.undoStack.length,
					undoManagerRedoStackLength:
						undoManager.redoStack.length,
					undoManagerUndoStackTop:
						undoManager.undoStack.at(-1) ?? null,
					undoManagerRedoStackTop:
						undoManager.redoStack.at(-1) ?? null,
					scrollSnapshot: actual.cm.scrollSnapshot(),
					scrollTop: actual.cm.scrollDOM.scrollTop,
					scrollLeft: actual.cm.scrollDOM.scrollLeft,
					editorRevision:
						this.editorRevisionByCm.get(actual.cm) ?? 0,
					editorAuthorityRevision:
						this.editorAuthorityRevisionByCm.get(actual.cm) ?? 0,
					editorAuthorityContent:
						this.editorAuthorityContentByCm.get(actual.cm) ?? null,
					ytextContent: expected.ytext.toJSON(),
					ytextMutationRevision:
						this.yTextMutationRevisionByText.get(expected.ytext) ?? 0,
					ydoc,
					ydocStateVector: ydoc === null
						? null
						: Y.encodeStateVector(ydoc),
					vaultText: this.vaultSync.getTextForPath(expected.targetPath),
					vaultFileId: this.vaultSync.getFileId(expected.targetPath),
					vaultTextFileId:
						this.vaultSync.getFileIdForText(expected.ytext),
					knownCm: this.knownCmViews.has(actual.cm),
					cmLeafId: this.cmToLeafId.get(actual.cm) ?? null,
					cmContained: view.containerEl.contains(actual.cm.dom),
					guard: runtime?.cmGuard?.snapshot() ?? null,
					recordCanonical: canonicalHandoffRecoveryJson(record),
				});
			} catch {
				return null;
			}
		};
		type DispatchMutationCensus = NonNullable<
			ReturnType<typeof captureDispatchMutationCensus>
		>;
		const dispatchCensusChanged = (
			before: DispatchMutationCensus,
			after: DispatchMutationCensus | null,
		): boolean => after === null
			|| before.authorityEpoch !== after.authorityEpoch
			|| before.authorityEpochExhausted
				!== after.authorityEpochExhausted
			|| before.asyncAuthorityOpen !== after.asyncAuthorityOpen
			|| before.binding !== after.binding
			|| before.bindingEpoch !== after.bindingEpoch
			|| before.bindingView !== after.bindingView
			|| before.bindingFile !== after.bindingFile
			|| before.bindingPath !== after.bindingPath
			|| before.bindingFileId !== after.bindingFileId
			|| before.bindingCm !== after.bindingCm
			|| before.bindingYtext !== after.bindingYtext
			|| before.bindingUndoManager !== after.bindingUndoManager
			|| before.bindingCmId !== after.bindingCmId
			|| before.bindingLastBoundAt !== after.bindingLastBoundAt
			|| before.bindingLastBoundAtMs !== after.bindingLastBoundAtMs
			|| before.bindingLastEditorChangeAtMs
				!== after.bindingLastEditorChangeAtMs
			|| before.bindingLastEditorDocChangeAtMs
				!== after.bindingLastEditorDocChangeAtMs
			|| before.bindingSettleWindowMs !== after.bindingSettleWindowMs
			|| before.bindingAuthorityYtextMutationEpochAtBind
				!== after.bindingAuthorityYtextMutationEpochAtBind
			|| before.bindingLocalYtextMutationRevisionAtBind
				!== after.bindingLocalYtextMutationRevisionAtBind
			|| before.lastEditorDocChangeAtForPath
				!== after.lastEditorDocChangeAtForPath
			|| before.lastUserDocChangeAtForCm
				!== after.lastUserDocChangeAtForCm
			|| before.lastTypingAwarenessAtForLeaf
				!== after.lastTypingAwarenessAtForLeaf
			|| before.runtime !== after.runtime
			|| before.hostGuard !== after.hostGuard
			|| !sameHostGuardSnapshot(
				before.hostGuardSnapshot,
				after.hostGuardSnapshot,
			)
			|| before.cmGuard !== after.cmGuard
			|| before.capturedSourceAuthority
				!== after.capturedSourceAuthority
			|| before.capturedSourceAuthorityKind
				!== after.capturedSourceAuthorityKind
			|| before.capturedSourceAuthorityContent
				!== after.capturedSourceAuthorityContent
			|| before.capturedSourceAuthorityLease
				!== after.capturedSourceAuthorityLease
			|| before.capturedSourceAuthorityLeaseId
				!== after.capturedSourceAuthorityLeaseId
			|| before.capturedSourceAuthorityReason
				!== after.capturedSourceAuthorityReason
			|| before.session !== after.session
			|| before.sessionId !== after.sessionId
			|| before.sessionLeafId !== after.sessionLeafId
			|| before.sessionGeneration !== after.sessionGeneration
			|| before.sessionEventOrderSeq !== after.sessionEventOrderSeq
			|| before.sessionSwitchIntentSeq !== after.sessionSwitchIntentSeq
			|| before.sessionNativeHistoryEpoch
				!== after.sessionNativeHistoryEpoch
			|| before.sessionCompletedDetachEpoch
				!== after.sessionCompletedDetachEpoch
			|| before.sessionActiveRecoveries
				!== after.sessionActiveRecoveries
			|| before.sessionPendingInputStartReservation
				!== after.sessionPendingInputStartReservation
			|| before.handoff !== after.handoff
			|| before.handoffSourceAuthorityPath
				!== after.handoffSourceAuthorityPath
			|| before.handoffTargetPath !== after.handoffTargetPath
			|| before.handoffTargetFile !== after.handoffTargetFile
			|| before.handoffBindingEpochAfterDetach
				!== after.handoffBindingEpochAfterDetach
			|| before.handoffPresentation !== after.handoffPresentation
			|| before.handoffTargetReadyTokenId
				!== after.handoffTargetReadyTokenId
			|| before.handoffInputGateInstalled
				!== after.handoffInputGateInstalled
			|| before.handoffSaveGuardInstalled
				!== after.handoffSaveGuardInstalled
			|| before.handoffRecoveryOperationEpoch
				!== after.handoffRecoveryOperationEpoch
			|| before.handoffIntentState !== after.handoffIntentState
			|| before.handoffPhase !== after.handoffPhase
			|| before.handoffPendingHostLoadCandidate
				!== after.handoffPendingHostLoadCandidate
			|| before.handoffRecoveryTargetBindingRequest
				!== after.handoffRecoveryTargetBindingRequest
			|| before.workflow !== after.workflow
			|| before.workflowSessionId !== after.workflowSessionId
			|| before.workflowGeneration !== after.workflowGeneration
			|| before.workflowSwitchIntentSeq
				!== after.workflowSwitchIntentSeq
			|| before.workflowTargetFile !== after.workflowTargetFile
			|| before.workflowTargetPath !== after.workflowTargetPath
			|| before.workflowCandidate !== after.workflowCandidate
			|| before.workflowOpenEditorTicket
				!== after.workflowOpenEditorTicket
			|| before.workflowPresentationPlan
				!== after.workflowPresentationPlan
			|| before.workflowPresentationRequestInFlight
				!== after.workflowPresentationRequestInFlight
			|| before.workflowPresentationPermitConsumed
				!== after.workflowPresentationPermitConsumed
			|| before.workflowPresentationCommitInFlight
				!== after.workflowPresentationCommitInFlight
			|| before.workflowPresentationCompletionInFlight
				!== after.workflowPresentationCompletionInFlight
			|| before.workflowHostCompletionReceipt
				!== after.workflowHostCompletionReceipt
			|| before.workflowOpenAdmissionInFlight
				!== after.workflowOpenAdmissionInFlight
			|| before.presentationReceipt !== after.presentationReceipt
			|| before.hostLoadReceipt !== after.hostLoadReceipt
			|| before.targetReadyToken !== after.targetReadyToken
			|| before.targetAuthority !== after.targetAuthority
			|| before.targetTokenId !== after.targetTokenId
			|| before.targetTokenPath !== after.targetTokenPath
			|| before.targetTokenFile !== after.targetTokenFile
			|| before.targetTokenMutationEpoch !== after.targetTokenMutationEpoch
			|| before.sessionView !== after.sessionView
			|| before.sessionViewFile !== after.sessionViewFile
			|| before.sessionBinding !== after.sessionBinding
			|| before.sessionBindingKind !== after.sessionBindingKind
			|| before.sessionBindingPath !== after.sessionBindingPath
			|| before.sessionBindingFileId !== after.sessionBindingFileId
			|| before.sessionBindingYtext !== after.sessionBindingYtext
			|| before.displayed !== after.displayed
			|| before.displayedKind !== after.displayedKind
			|| before.displayedFile !== after.displayedFile
			|| before.displayedPath !== after.displayedPath
			|| before.displayedFileId !== after.displayedFileId
			|| before.displayedCm !== after.displayedCm
			|| before.displayedDocument !== after.displayedDocument
			|| before.displayedEditorRevision
				!== after.displayedEditorRevision
			|| before.view !== after.view
			|| before.viewFile !== after.viewFile
			|| before.editorFacade !== after.editorFacade
			|| before.editorFacadeGetValue !== after.editorFacadeGetValue
			|| before.editorFacadeContent !== after.editorFacadeContent
			|| !sameOwnPropertyDescriptor(
				before.dataDescriptor,
				after.dataDescriptor,
			)
			|| before.cm !== after.cm
			|| before.cmState !== after.cmState
			|| before.cmDocument !== after.cmDocument
			|| before.cmDocumentContent !== after.cmDocumentContent
			|| before.cmSelection !== after.cmSelection
			|| !before.cmSelection.eq(after.cmSelection)
			|| before.historyState !== after.historyState
			|| before.undoDepth !== after.undoDepth
			|| before.redoDepth !== after.redoDepth
			|| before.undoManager !== after.undoManager
			|| before.undoManagerLastChange
				!== after.undoManagerLastChange
			|| before.undoManagerUndoing !== after.undoManagerUndoing
			|| before.undoManagerRedoing !== after.undoManagerRedoing
			|| before.undoManagerCurrentStackItem
				!== after.undoManagerCurrentStackItem
			|| before.undoManagerUndoStack
				!== after.undoManagerUndoStack
			|| before.undoManagerRedoStack
				!== after.undoManagerRedoStack
			|| before.undoManagerUndoStackLength
				!== after.undoManagerUndoStackLength
			|| before.undoManagerRedoStackLength
				!== after.undoManagerRedoStackLength
			|| before.undoManagerUndoStackTop
				!== after.undoManagerUndoStackTop
			|| before.undoManagerRedoStackTop
				!== after.undoManagerRedoStackTop
			|| !sameScrollSnapshot(
				before.scrollSnapshot,
				after.scrollSnapshot,
			)
			|| before.scrollTop !== after.scrollTop
			|| before.scrollLeft !== after.scrollLeft
			|| before.editorRevision !== after.editorRevision
			|| before.editorAuthorityRevision !== after.editorAuthorityRevision
			|| before.editorAuthorityContent !== after.editorAuthorityContent
			|| before.ytextContent !== after.ytextContent
			|| before.ytextMutationRevision !== after.ytextMutationRevision
			|| before.ydoc !== after.ydoc
			|| !sameBytes(before.ydocStateVector, after.ydocStateVector)
			|| before.vaultText !== after.vaultText
			|| before.vaultFileId !== after.vaultFileId
			|| before.vaultTextFileId !== after.vaultTextFileId
			|| before.knownCm !== after.knownCm
			|| before.cmLeafId !== after.cmLeafId
			|| before.cmContained !== after.cmContained
			|| !sameCodeMirrorGuardSnapshot(before.guard, after.guard)
			|| before.recordCanonical !== after.recordCanonical;
		const hasUnexpectedReplayMutation = (
			before: DispatchMutationCensus,
			after: DispatchMutationCensus | null,
		): boolean => after === null
			|| before.authorityEpochExhausted
			|| after.authorityEpochExhausted
			|| after.authorityEpoch
				!== before.authorityEpoch
					+ HANDOFF_REPLAY_AUTHORITY_EPOCH_ADVANCE
			|| before.asyncAuthorityOpen !== after.asyncAuthorityOpen
			|| before.binding !== after.binding
			|| before.bindingEpoch !== after.bindingEpoch
			|| before.bindingView !== after.bindingView
			|| before.bindingFile !== after.bindingFile
			|| before.bindingPath !== after.bindingPath
			|| before.bindingFileId !== after.bindingFileId
			|| before.bindingCm !== after.bindingCm
			|| before.bindingYtext !== after.bindingYtext
			|| before.bindingUndoManager !== after.bindingUndoManager
			|| before.bindingCmId !== after.bindingCmId
			|| before.bindingLastBoundAt !== after.bindingLastBoundAt
			|| before.bindingLastBoundAtMs !== after.bindingLastBoundAtMs
			|| before.bindingLastEditorChangeAtMs
				!== after.bindingLastEditorChangeAtMs
			|| before.bindingLastEditorDocChangeAtMs
				!== after.bindingLastEditorDocChangeAtMs
			|| before.bindingSettleWindowMs !== after.bindingSettleWindowMs
			|| before.bindingAuthorityYtextMutationEpochAtBind
				!== after.bindingAuthorityYtextMutationEpochAtBind
			|| before.bindingLocalYtextMutationRevisionAtBind
				!== after.bindingLocalYtextMutationRevisionAtBind
			|| before.lastEditorDocChangeAtForPath
				!== after.lastEditorDocChangeAtForPath
			|| before.lastUserDocChangeAtForCm
				!== after.lastUserDocChangeAtForCm
			|| before.lastTypingAwarenessAtForLeaf
				!== after.lastTypingAwarenessAtForLeaf
			|| before.runtime !== after.runtime
			|| before.hostGuard !== after.hostGuard
			|| (
				!sameHostGuardSnapshot(
					before.hostGuardSnapshot,
					after.hostGuardSnapshot,
				)
				&& !isExactHandoffReplayOwnedSaveStart(
					before.hostGuardSnapshot,
					after.hostGuardSnapshot,
					expected,
				)
			)
			|| before.cmGuard !== after.cmGuard
			|| before.capturedSourceAuthority
				!== after.capturedSourceAuthority
			|| before.capturedSourceAuthorityKind
				!== after.capturedSourceAuthorityKind
			|| before.capturedSourceAuthorityContent
				!== after.capturedSourceAuthorityContent
			|| before.capturedSourceAuthorityLease
				!== after.capturedSourceAuthorityLease
			|| before.capturedSourceAuthorityLeaseId
				!== after.capturedSourceAuthorityLeaseId
			|| before.capturedSourceAuthorityReason
				!== after.capturedSourceAuthorityReason
			|| before.sessionId !== after.sessionId
			|| before.sessionLeafId !== after.sessionLeafId
			|| before.sessionGeneration !== after.sessionGeneration
			|| before.sessionEventOrderSeq !== after.sessionEventOrderSeq
			|| before.sessionSwitchIntentSeq !== after.sessionSwitchIntentSeq
			|| before.sessionNativeHistoryEpoch
				!== after.sessionNativeHistoryEpoch
			|| before.sessionCompletedDetachEpoch
				!== after.sessionCompletedDetachEpoch
			|| before.sessionActiveRecoveries
				!== after.sessionActiveRecoveries
			|| before.sessionPendingInputStartReservation
				!== after.sessionPendingInputStartReservation
			|| before.handoff !== after.handoff
			|| before.handoffSourceAuthorityPath
				!== after.handoffSourceAuthorityPath
			|| before.handoffTargetPath !== after.handoffTargetPath
			|| before.handoffTargetFile !== after.handoffTargetFile
			|| before.handoffBindingEpochAfterDetach
				!== after.handoffBindingEpochAfterDetach
			|| before.handoffPresentation !== after.handoffPresentation
			|| before.handoffTargetReadyTokenId
				!== after.handoffTargetReadyTokenId
			|| before.handoffInputGateInstalled
				!== after.handoffInputGateInstalled
			|| before.handoffSaveGuardInstalled
				!== after.handoffSaveGuardInstalled
			|| before.handoffRecoveryOperationEpoch
				!== after.handoffRecoveryOperationEpoch
			|| before.handoffIntentState !== after.handoffIntentState
			|| before.handoffPhase !== after.handoffPhase
			|| before.handoffPendingHostLoadCandidate
				!== after.handoffPendingHostLoadCandidate
			|| before.handoffRecoveryTargetBindingRequest
				!== after.handoffRecoveryTargetBindingRequest
			|| before.workflow !== after.workflow
			|| before.workflowSessionId !== after.workflowSessionId
			|| before.workflowGeneration !== after.workflowGeneration
			|| before.workflowSwitchIntentSeq
				!== after.workflowSwitchIntentSeq
			|| before.workflowTargetFile !== after.workflowTargetFile
			|| before.workflowTargetPath !== after.workflowTargetPath
			|| before.workflowCandidate !== after.workflowCandidate
			|| before.workflowOpenEditorTicket
				!== after.workflowOpenEditorTicket
			|| before.workflowPresentationPlan
				!== after.workflowPresentationPlan
			|| before.workflowPresentationRequestInFlight
				!== after.workflowPresentationRequestInFlight
			|| before.workflowPresentationPermitConsumed
				!== after.workflowPresentationPermitConsumed
			|| before.workflowPresentationCommitInFlight
				!== after.workflowPresentationCommitInFlight
			|| before.workflowPresentationCompletionInFlight
				!== after.workflowPresentationCompletionInFlight
			|| before.workflowHostCompletionReceipt
				!== after.workflowHostCompletionReceipt
			|| before.workflowOpenAdmissionInFlight
				!== after.workflowOpenAdmissionInFlight
			|| before.presentationReceipt !== after.presentationReceipt
			|| before.hostLoadReceipt !== after.hostLoadReceipt
			|| before.targetReadyToken !== after.targetReadyToken
			|| before.targetAuthority !== after.targetAuthority
			|| before.targetTokenId !== after.targetTokenId
			|| before.targetTokenPath !== after.targetTokenPath
			|| before.targetTokenFile !== after.targetTokenFile
			|| before.targetTokenMutationEpoch !== after.targetTokenMutationEpoch
			|| before.sessionView !== after.sessionView
			|| before.sessionViewFile !== after.sessionViewFile
			|| before.sessionBinding !== after.sessionBinding
			|| before.sessionBindingKind !== after.sessionBindingKind
			|| before.sessionBindingPath !== after.sessionBindingPath
			|| before.sessionBindingFileId !== after.sessionBindingFileId
			|| before.sessionBindingYtext !== after.sessionBindingYtext
			|| before.displayedKind !== after.displayedKind
			|| before.displayedFile !== after.displayedFile
			|| before.displayedPath !== after.displayedPath
			|| before.displayedFileId !== after.displayedFileId
			|| before.displayedCm !== after.displayedCm
			|| before.view !== after.view
			|| before.viewFile !== after.viewFile
			|| before.editorFacade !== after.editorFacade
			|| before.editorFacadeGetValue !== after.editorFacadeGetValue
			|| !sameOwnPropertyDescriptorShape(
				before.dataDescriptor,
				after.dataDescriptor,
			)
			|| before.cm !== after.cm
			|| before.undoManager !== after.undoManager
			|| before.undoManagerUndoStack !== after.undoManagerUndoStack
			|| before.undoManagerRedoStack !== after.undoManagerRedoStack
			|| before.ydoc !== after.ydoc
			|| before.vaultText !== after.vaultText
			|| before.vaultFileId !== after.vaultFileId
			|| before.vaultTextFileId !== after.vaultTextFileId
			|| before.knownCm !== after.knownCm
			|| before.cmLeafId !== after.cmLeafId
			|| before.cmContained !== after.cmContained
			|| before.recordCanonical !== after.recordCanonical
			|| before.guard === null
			|| after.guard === null
			|| before.guard.view !== after.guard.view
			|| before.guard.inert !== after.guard.inert
			|| before.guard.gateClosed !== after.guard.gateClosed
			|| before.guard.inputEpoch !== after.guard.inputEpoch
			|| before.guard.compositionEpoch !== after.guard.compositionEpoch
			|| !sameCompositionSnapshot(
				before.guard.activeComposition,
				after.guard.activeComposition,
			)
			|| !sameCompositionSnapshot(
				before.guard.lastComposition,
				after.guard.lastComposition,
			)
			|| before.guard.gateFailureReason
				!== after.guard.gateFailureReason
			|| before.guard.commitState !== after.guard.commitState
			|| before.guard.pendingHostLoadCandidate
				!== after.guard.pendingHostLoadCandidate;
		const beforeDispatch = captureDispatchMutationCensus();
		if (
			beforeDispatch === null
			|| beforeDispatch.recordCanonical !== validatedRecordCanonical
			|| beforeDispatch.authorityEpochExhausted
			|| beforeDispatch.authorityEpoch
				> Number.MAX_SAFE_INTEGER
					- HANDOFF_REPLAY_AUTHORITY_EPOCH_ADVANCE
			|| !this.isHandoffReplayDispatchFrameAuthorityCurrent(frame)
		) {
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		const beforeYTextMutationRevision =
			beforeDispatch.ytextMutationRevision;
		const replayYdoc = expected.ytext.doc;
		const replayYTransactions: Y.Transaction[] = [];
		const expectedYSyncOrigin = frame.startState.facet(ySyncFacet);
		const observeReplayYTransaction = (transaction: Y.Transaction): void => {
			replayYTransactions.push(transaction);
		};
		if (replayYdoc === null || expectedYSyncOrigin === undefined) {
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		try {
			replayYdoc.on("afterTransaction", observeReplayYTransaction);
		} catch {
			return { kind: "not-applied", reason: "dispatch-rejected" };
		}
		let dispatchError: unknown = null;
		this.activeHandoffReplayDispatchFrame = frame;
		try {
			privateAuthority.binding.undoManager.stopCapturing();
			actual.cm.dispatch(transaction);
		} catch (error) {
			dispatchError = error;
		} finally {
			try {
				privateAuthority.binding.undoManager.stopCapturing();
			} catch (error) {
				dispatchError ??= error;
			}
			try {
				replayYdoc.off("afterTransaction", observeReplayYTransaction);
			} catch (error) {
				dispatchError ??= error;
			}
			if (this.activeHandoffReplayDispatchFrame === frame) {
				this.activeHandoffReplayDispatchFrame = null;
			}
		}

		const afterDispatch = captureDispatchMutationCensus();
		const postBinding = afterDispatch?.binding ?? null;
		const postRuntime = afterDispatch?.runtime ?? null;
		const postGuard = afterDispatch?.guard ?? null;
		const postYTextMutationRevision =
			afterDispatch?.ytextMutationRevision ?? Number.NaN;
		const anyMutation = dispatchCensusChanged(
			beforeDispatch,
			afterDispatch,
		);
		if (dispatchError !== null) {
			this.trace?.("editor", "handoff-replay-dispatch-rejected", {
				stage: "dispatch-threw",
				mutated: anyMutation,
				errorKind: dispatchError instanceof Error
					? "error"
					: dispatchError === null
						? "null"
						: typeof dispatchError,
			});
			return anyMutation
				? {
					kind: "dispatched-uncertain",
					reason: "dispatch-threw-after-mutation",
				}
				: { kind: "not-applied", reason: "dispatch-rejected" };
		}
		if (!frame.routeSeen || !frame.updateSeen) {
			this.trace?.("editor", "handoff-replay-dispatch-rejected", {
				stage: "guard-boundary",
				routeSeen: frame.routeSeen,
				updateSeen: frame.updateSeen,
				mutated: anyMutation,
			});
			if (!anyMutation) {
				return { kind: "not-applied", reason: "dispatch-rejected" };
			}
			return {
				kind: "dispatched-uncertain",
				reason: "post-document-mismatch",
			};
		}
		if (hasUnexpectedReplayMutation(beforeDispatch, afterDispatch)) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-target-identity-mismatch",
			};
		}
		const postHandoff = postRuntime?.session.handoff ?? null;
		if (
			postBinding !== privateAuthority.binding
			|| postRuntime === null
			|| postRuntime.session.sessionId !== expected.sessionId
			|| postRuntime.session.generation !== expected.handoffGeneration
			|| postRuntime.session.view !== privateAuthority.binding.view
			|| postRuntime.session.binding.kind !== "bound"
			|| postRuntime.session.binding.path !== expected.targetPath
			|| postRuntime.session.binding.fileId !== expected.targetFileId
			|| postRuntime.session.binding.ytext !== expected.ytext
			|| postHandoff === null
			|| postHandoff.presentation !== "target-proven"
			|| postHandoff.recoveryOperationEpoch
				!== expected.recoveryOperationEpoch
			|| postHandoff.targetReadyTokenId !== expected.targetReadyTokenId
			|| postHandoff.intentState.kind !== "replay-pending"
			|| postHandoff.intentState.intentId !== record.intentId
			|| postHandoff.intentState.recordId !== record.recordId
			|| postHandoff.recoveryTargetBindingRequest
				?.recoveryOperationEpoch !== recoveryOperationEpoch
			|| postHandoff.recoveryTargetBindingRequest?.intentId
				!== record.intentId
			|| postHandoff.recoveryTargetBindingRequest?.recordId
				!== record.recordId
			|| privateAuthority.binding.file !== expected.targetFile
			|| privateAuthority.binding.path !== expected.targetPath
			|| privateAuthority.binding.cm !== expected.cm
			|| privateAuthority.binding.ytext !== expected.ytext
			|| this.vaultSync.getTextForPath(expected.targetPath)
				!== expected.ytext
			|| this.vaultSync.getFileId(expected.targetPath)
				!== expected.targetFileId
			|| this.vaultSync.getFileIdForText(expected.ytext)
				!== expected.targetFileId
		) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-target-identity-mismatch",
			};
		}
		if (
			actual.cm.state !== transaction.state
			|| actual.cm.state.doc !== transaction.newDoc
			|| actual.cm.state.doc.toString() !== expectedResultContent
			|| (this.editorRevisionByCm.get(actual.cm) ?? 0)
				!== expected.editorRevision + 1
			|| afterDispatch === null
			|| afterDispatch.editorAuthorityRevision
				!== beforeDispatch.editorAuthorityRevision + 1
			|| afterDispatch.editorAuthorityContent !== expectedResultContent
			|| afterDispatch.displayedDocument !== transaction.newDoc
			|| afterDispatch.displayedEditorRevision
				!== expected.editorRevision + 1
		) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-document-mismatch",
			};
		}
		if (afterDispatch.editorFacadeContent !== expectedResultContent) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-editor-facade-mismatch",
			};
		}
		const runtimeCacheAlreadyExact =
			afterDispatch.dataDescriptor !== undefined
			&& "value" in afterDispatch.dataDescriptor
			&& afterDispatch.dataDescriptor.value === expectedResultContent;
		const expectedLocalYTextMutationRevision =
			beforeYTextMutationRevision + 1;
		const postYTextMutationEpoch =
			expected.ytextMutationEpoch + 1;
		const replayYTextWasOnlyChangedType =
			isExactHandoffReplayYTextTransaction({
				transactions: replayYTransactions,
				expectedOrigin: expectedYSyncOrigin,
				expectedYtext: expected.ytext,
			});
		if (
			expected.ytext.toJSON() !== expectedResultContent
			|| postYTextMutationRevision
				!== expectedLocalYTextMutationRevision
			|| !replayYTextWasOnlyChangedType
		) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-ytext-mismatch",
			};
		}
		if (
			postGuard === null
			|| afterDispatch === null
			|| postGuard.nativeHistoryEpoch !== expected.nativeHistoryEpoch + 1
			|| actual.cm.state.field(historyField, false)
				=== privateAuthority.nativeHistoryState
			|| undoDepth(actual.cm.state) !== privateAuthority.undoDepth + 1
			|| redoDepth(actual.cm.state) !== 0
			|| afterDispatch.undoManager !== beforeDispatch.undoManager
			|| afterDispatch.undoManagerUndoStack
				!== beforeDispatch.undoManagerUndoStack
			|| afterDispatch.undoManagerRedoStack
				!== beforeDispatch.undoManagerRedoStack
			|| afterDispatch.undoManagerUndoStackLength
				!== beforeDispatch.undoManagerUndoStackLength + 1
			|| afterDispatch.undoManagerUndoStackTop === null
			|| afterDispatch.undoManagerUndoStackTop
				=== beforeDispatch.undoManagerUndoStackTop
			|| afterDispatch.undoManagerRedoStackLength !== 0
			|| afterDispatch.undoManagerRedoStackTop !== null
			|| afterDispatch.undoManagerLastChange !== 0
			|| afterDispatch.undoManagerUndoing
			|| afterDispatch.undoManagerRedoing
			|| afterDispatch.undoManagerCurrentStackItem !== null
		) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-native-history-mismatch",
			};
		}
		const expectedSelectionEpoch = expected.selectionEpoch
			+ (expected.selection.eq(plan.mappedSelection) ? 0 : 1);
		if (
			!actual.cm.state.selection.eq(plan.mappedSelection)
			|| postGuard.selectionEpoch !== expectedSelectionEpoch
		) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-selection-mismatch",
			};
		}
		let postScrollAnchor: number | null = null;
		try {
			postScrollAnchor = actual.cm.scrollSnapshot().value.range.head;
		} catch {
			// Leave null so the exact postcondition fails closed.
		}
		if (!isExactHandoffReplayScrollDispatchPostcondition({
			beforeEpoch: expected.scrollEpoch,
			afterEpoch: postGuard.scrollEpoch,
			mappedAnchor: plan.mappedScrollAnchor,
			observedAnchor: postScrollAnchor,
		})) {
			return {
				kind: "dispatched-uncertain",
				reason: "post-scroll-mismatch",
			};
		}
		if (!runtimeCacheAlreadyExact) {
			const beforeProjection = captureDispatchMutationCensus();
			if (
				beforeProjection === null
				|| dispatchCensusChanged(afterDispatch, beforeProjection)
				|| beforeProjection.authorityEpochExhausted
				|| beforeProjection.authorityEpoch >= Number.MAX_SAFE_INTEGER
				|| !isExactHandoffReplayRuntimeCacheProjection({
					beforeDescriptor: beforeDispatch.dataDescriptor,
					afterDispatchDescriptor: beforeProjection.dataDescriptor,
					expectedStartContent: expected.runtimeCacheContent,
					expectedResultContent,
					hostBefore: beforeDispatch.hostGuardSnapshot,
					hostAfter: beforeProjection.hostGuardSnapshot,
					expected,
				})
			) {
				return {
					kind: "dispatched-uncertain",
					reason: "post-runtime-cache-mismatch",
				};
			}

			const runtimeView = privateAuthority.binding.view as unknown as TextFileView;
			let projected = false;
			try {
				projected = Reflect.set(
					runtimeView,
					"data",
					expectedResultContent,
					runtimeView,
				);
			} catch {
				// The replay already mutated the document. Any host-cache trap is
				// therefore uncertain and must not be retried automatically.
			}
			if (!projected) {
				return {
					kind: "dispatched-uncertain",
					reason: "post-runtime-cache-mismatch",
				};
			}
			this.advanceAuthorityEpoch();
			const afterProjection = captureDispatchMutationCensus();
			const projectedDescriptor = afterProjection?.dataDescriptor;
			const normalizedAfterProjection = afterProjection === null
				? null
				: {
					...afterProjection,
					authorityEpoch: beforeProjection.authorityEpoch,
					dataDescriptor: beforeProjection.dataDescriptor,
				};
			if (
				afterProjection === null
				|| normalizedAfterProjection === null
				|| afterProjection.authorityEpoch
					!== beforeProjection.authorityEpoch + 1
				|| afterProjection.authorityEpochExhausted
				|| projectedDescriptor === undefined
				|| !("value" in projectedDescriptor)
				|| projectedDescriptor.value !== expectedResultContent
				|| !sameOwnPropertyDescriptorShape(
					beforeProjection.dataDescriptor,
					projectedDescriptor,
				)
				|| dispatchCensusChanged(
					beforeProjection,
					normalizedAfterProjection,
				)
			) {
				return {
					kind: "dispatched-uncertain",
					reason: "post-runtime-cache-mismatch",
				};
			}
		}
		this.lastSuccessfullyAppliedHandoffReplayByLeafId.set(
			expected.leafId,
			Object.freeze({
				planId: plan.planId,
				binding: privateAuthority.binding,
				targetFile: expected.targetFile,
				cm: expected.cm,
				ytext: expected.ytext,
				targetFileId: expected.targetFileId,
				ytextIdentity: expected.ytextIdentity,
				ytextMutationEpoch: postYTextMutationEpoch,
				bindingEpoch: expected.bindingEpoch,
				editorRevision: expected.editorRevision + 1,
				nativeHistoryEpoch: expected.nativeHistoryEpoch + 1,
				selectionEpoch: expectedSelectionEpoch,
				scrollEpoch: postGuard.scrollEpoch,
				selection: actual.cm.state.selection,
				scrollAnchor: postScrollAnchor,
			}),
		);
		return {
			kind: "applied",
			postcondition: Object.freeze({
				planId: plan.planId,
				recordId: record.recordId,
				recoveryOperationEpoch,
				targetFileId: expected.targetFileId,
				ytextIdentity: expected.ytextIdentity,
				ytextMutationEpoch: postYTextMutationEpoch,
				bindingEpoch: expected.bindingEpoch,
				editorRevision: expected.editorRevision + 1,
				nativeHistoryEpoch: expected.nativeHistoryEpoch + 1,
				selectionEpoch: expectedSelectionEpoch,
				scrollEpoch: postGuard.scrollEpoch,
				selection: actual.cm.state.selection,
				scrollAnchor: postScrollAnchor,
			}),
		};
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
				cmGuard: null,
				capturedSourceAuthority: null,
				targetWorkflow: null,
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
		this.clearTargetPresentationRetry(leafId);
		this.clearTargetBindingRetry(leafId);
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
				const timer = setTimeout(() => {
					if (this.pendingUnmanageRetries.get(leafId) !== timer) return;
					this.pendingUnmanageRetries.delete(leafId);
					const current = this.managedSessions.get(leafId);
					if (current !== runtime || current.session.view !== view) return;
					this.unmanageView(view, `${reason}:retry`, true);
				}, LIVE_UPDATE_HEALTH_RETRY_DELAY_MS);
				this.pendingUnmanageRetries.set(leafId, timer);
			}
			return false;
		}
		const retry = this.pendingUnmanageRetries.get(leafId);
		if (retry) clearTimeout(retry);
		this.pendingUnmanageRetries.delete(leafId);
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
		runtime.targetWorkflow = null;
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
			if (exactWorkspaceViews.has(view)) continue;
			const leafId = runtime.session.leafId;
			if (this.managedSessions.get(leafId) !== runtime) continue;
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

	private installManagedHostGuard(runtime: ManagedLeafRuntime): boolean {
		if (runtime.hostGuard) {
			const snapshot = runtime.hostGuard.snapshot();
			if (snapshot.mode.kind !== "inert-pass-through") return true;
			runtime.hostGuard.restoreIfCurrent();
			runtime.hostGuard = null;
		}
		const view = runtime.session.view as unknown as TextFileView;
		const result = installTextFileViewHandoffGuard(view, {
			onLoadFileEntry: (targetFile, sourceUnloadReceiptId) => {
				if (!this.beginPathHandoff(
					runtime.session.view,
					targetFile,
					"host-load-entry",
					"selected",
					sourceUnloadReceiptId,
				)) {
					return null;
				}
				const current = this.managedSessions.get(runtime.session.leafId)?.session;
				if (!current?.handoff || current.handoff.targetFile !== targetFile) return null;
				return {
					sessionId: current.sessionId,
					handoffGeneration: current.generation,
					switchIntentSeq: current.currentSwitchIntentSeq ?? -1,
					targetFile,
					sourceUnloadReceiptId,
				};
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
				return certified;
			},
			onHostLoadCandidate: (candidate) => {
				this.isHostLoadCandidateCurrent(candidate);
			},
			isHostLoadCandidateCurrent: (candidate) =>
				this.isHostLoadCandidateCurrent(candidate),
			onHostLoadCompleted: (receipt) => {
				this.handleSettledHostLoadCompletion(runtime, receipt);
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
				this.trace?.("editor", "managed-host-capability-lost", {
					leafId: runtime.session.leafId,
					reason,
				});
				queueMicrotask(() => {
					const current = this.managedSessions.get(runtime.session.leafId);
					if (current !== runtime) return;
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
			onInputIntent: ({ intent }) => {
				const current = this.managedSessions.get(intent.leafId);
				if (!current) return false;
				const reduction = reduceManagedLeafSession(current.session, {
					type: "intent-captured",
					sessionId: intent.sessionId,
					expectedGeneration: intent.handoffGeneration,
					intent,
				});
				if (!reduction.accepted) return false;
				this.advanceAuthorityEpoch();
				current.session = reduction.state;
				this.applyHandoffEffects(current, reduction.effects, "input-intent-captured");
				return true;
			},
			onSamePathInputCompleted: (completion) =>
				this.acceptSamePathInputCompletion(runtime, completion),
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
			hashContent: (content) => this.hashManagedContent(content),
			acceptHandoffReplayTransaction: (transaction, boundary) =>
				this.acceptHandoffReplayTransaction(transaction, boundary),
			getHandoffRecoveryGateModel: () =>
				this.getHandoffRecoveryGateModel(runtime.session.leafId),
			handoffRecoveryGateCallbacks: {
				onRetry: () => this.startHandoffRecoveryRetry(runtime.session.leafId),
				onCopyAndContinue: () => this.startHandoffRecoveryCopy(runtime.session.leafId),
				onExportAndContinue: () => this.startHandoffRecoveryExport(runtime.session.leafId),
				onDiscardAndContinue: () => this.startHandoffRecoveryDiscard(runtime.session.leafId),
				onContinueWithoutAutomaticApply: () =>
					this.continueHandoffRecoveryManually(runtime.session.leafId),
				onRetrySettlement: () => this.retryHandoffRecoverySettlement(runtime.session.leafId),
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

	private getHandoffRecoveryGateModel(
		leafId: string,
	): HandoffRecoveryGateModel | null {
		const intentState = this.managedSessions.get(leafId)?.session.handoff?.intentState;
		if (!intentState) return null;
		let state: HandoffRecoveryGateModel["state"];
		let message: HandoffRecoveryGateModel["message"];
		switch (intentState.kind) {
			case "persisting":
				state = "persisting";
				message = "Preserving interrupted input…";
				break;
			case "failed":
				state = "failed";
				message = "Interrupted input still needs a recovery choice.";
				break;
			case "stored":
				state = "stored";
				message = "Waiting for a proven target before automatic apply…";
				break;
			case "replay-pending":
				state = "replay-pending";
				message = "Preparing one verified automatic apply…";
				break;
			case "replayed-awaiting-settlement":
				state = "replayed-awaiting-settlement";
				message = "Automatic apply is waiting for settlement verification…";
				break;
			case "escape-pending":
				state = "escape-pending";
				message = "Completing the selected recovery action…";
				break;
			case "none":
			case "needs-review":
			case "escaped":
			case "resolved":
			case "discarded":
				return null;
		}
		return {
			state,
			message,
			actions: handoffRecoveryGateActions(state),
		};
	}

	private buildHandoffRecoveryRequest(
		leafId: string,
		effect: Extract<EditorHandoffEffect, { type: "persist-intent" }>,
		expectedPort: HandoffRecoveryPort | null = this.handoffRecoveryPort,
	): HandoffRecoveryRuntimeRequest | null {
		const runtime = this.managedSessions.get(leafId);
		const handoff = runtime?.session.handoff;
		if (
			!runtime
			|| runtime.session.sessionId !== effect.sessionId
			|| runtime.session.generation !== effect.expectedGeneration
			|| handoff?.recoveryOperationEpoch !== effect.recoveryOperationEpoch
		) return null;
		const recovery = runtime.session.activeRecoveries.find((candidate) =>
			candidate.sessionId === effect.sessionId
			&& candidate.handoffGeneration === effect.expectedGeneration
			&& candidate.recoveryOperationEpoch === effect.recoveryOperationEpoch
			&& candidate.intent === effect.intent
		);
		if (!recovery) return null;
		const activationEpoch = this.handoffRecoveryPortActivationEpoch;
		return {
			sessionId: effect.sessionId,
			expectedGeneration: effect.expectedGeneration,
			recoveryOperationEpoch: effect.recoveryOperationEpoch,
			intent: effect.intent,
			deliver: (event) => {
				if (
					this.handoffRecoveryPortActivationEpoch !== activationEpoch
					|| this.handoffRecoveryPort !== expectedPort
				) return false;
				if (event.type === "intent-state-changed") {
					return this.deliverHandoffRecoveryIntentState(leafId, event);
				}
				const current = this.managedSessions.get(leafId);
				if (!current) return false;
				const reduction = reduceManagedLeafSession(current.session, event);
				if (!reduction.accepted) return false;
				this.advanceAuthorityEpoch();
				current.session = reduction.state;
				this.applyHandoffEffects(
					current,
					reduction.effects,
					"recovery-target-binding-requested",
				);
				return true;
			},
		};
	}

	private buildCurrentHandoffRecoveryRequest(
		leafId: string,
		expectedPort: HandoffRecoveryPort | null = this.handoffRecoveryPort,
	): HandoffRecoveryRuntimeRequest | null {
		const runtime = this.managedSessions.get(leafId);
		const handoff = runtime?.session.handoff;
		if (!runtime || !handoff || handoff.intentState.kind === "none") return null;
		const intentId = handoff.intentState.intentId;
		const recovery = runtime.session.activeRecoveries.find((candidate) =>
			candidate.sessionId === runtime.session.sessionId
			&& candidate.handoffGeneration === runtime.session.generation
			&& candidate.recoveryOperationEpoch === handoff.recoveryOperationEpoch
			&& candidate.intent.intentId === intentId
		);
		if (!recovery) return null;
		return this.buildHandoffRecoveryRequest(leafId, {
			type: "persist-intent",
			sessionId: runtime.session.sessionId,
			expectedGeneration: runtime.session.generation,
			recoveryOperationEpoch: handoff.recoveryOperationEpoch,
			intent: recovery.intent,
		}, expectedPort);
	}

	private deliverHandoffRecoveryIntentState(
		leafId: string,
		event: Extract<
			Parameters<HandoffRecoveryRuntimeRequest["deliver"]>[0],
			{ type: "intent-state-changed" }
		>,
	): boolean {
		const runtime = this.managedSessions.get(leafId);
		if (!runtime) return false;
		const observedIntentState = event.intentState;
		const observedRecovery = observedIntentState.kind === "none"
			? null
			: runtime.session.activeRecoveries.find((candidate) =>
				candidate.sessionId === event.sessionId
				&& candidate.handoffGeneration === event.expectedGeneration
				&& candidate.recoveryOperationEpoch === event.recoveryOperationEpoch
				&& candidate.intent.intentId === observedIntentState.intentId
			) ?? null;
		const recoveryWorkflow =
			runtime.session.handoff?.recoveryTargetBindingRequest
				? runtime.targetWorkflow
				: null;
		const reduction = reduceManagedLeafSession(runtime.session, event);
		if (!reduction.accepted) return false;
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		if (observedRecovery && observedIntentState.kind !== "none") {
			const action = observedIntentState.kind === "escape-pending"
				|| observedIntentState.kind === "escaped"
				? observedIntentState.action
				: observedIntentState.kind === "discarded"
					? "discard" as const
					: null;
			try {
				this.handoffRecoveryActionHost?.observeAcceptedIntentState?.(Object.freeze({
					leafId,
					sessionId: event.sessionId,
					generation: event.expectedGeneration,
					recoveryOperationEpoch: event.recoveryOperationEpoch,
					intentId: observedRecovery.intent.intentId,
					fromPath: observedRecovery.intent.fromPath,
					targetPath: observedRecovery.intent.targetPath,
					startContentHash: observedRecovery.intent.startContentHash,
					afterContentHash: observedRecovery.intent.afterContentHash,
					state: observedIntentState.kind,
					action,
				}));
			} catch {
				// Diagnostic observation is deliberately non-authoritative.
			}
		}
		this.applyHandoffEffects(runtime, reduction.effects, "handoff-recovery-state");
		if (recoveryWorkflow && runtime.session.handoff === null) {
			this.clearTargetPresentationRetry(leafId);
			this.clearTargetBindingRetry(leafId);
			runtime.targetWorkflow = null;
		}
		runtime.cmGuard?.refreshGate();
		const workflow = runtime.targetWorkflow;
		if (
			workflow
			&& runtime.session.handoff?.presentation === "target-proven"
			&& runtime.session.handoff.phase === "target-ready"
		) this.requestTargetBindingAdmission(runtime, workflow);
		return true;
	}

	private beginHandoffRecoveryOperation(
		leafId: string,
		operation: "retry" | "copy" | "export" | "discard",
	): Readonly<{
		port: HandoffRecoveryPort;
		request: HandoffRecoveryRuntimeRequest;
	}> | null {
		const runtime = this.managedSessions.get(leafId);
		const port = this.handoffRecoveryPort;
		if (!runtime) return null;
		const reduction = reduceManagedLeafSession(runtime.session, {
			type: "recovery-operation-started",
			sessionId: runtime.session.sessionId,
			expectedGeneration: runtime.session.generation,
			operation,
		});
		if (!reduction.accepted) return null;
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		this.applyHandoffEffects(runtime, reduction.effects, `handoff-recovery-${operation}`);
		runtime.cmGuard?.refreshGate();
		const request = this.buildCurrentHandoffRecoveryRequest(leafId, port);
		if (!request) return null;
		if (!port) {
			this.deliverHandoffRecoveryIntentState(leafId, {
				type: "intent-state-changed",
				sessionId: request.sessionId,
				expectedGeneration: request.expectedGeneration,
				recoveryOperationEpoch: request.recoveryOperationEpoch,
				intentState: {
					kind: "failed",
					intentId: request.intent.intentId,
					reason: "recovery-store-unavailable",
				},
			});
			return null;
		}
		return { port, request };
	}

	private startHandoffRecoveryRetry(leafId: string): void {
		const operation = this.beginHandoffRecoveryOperation(leafId, "retry");
		if (!operation) return;
		void operation.port.persistAndClassify(operation.request).catch(() => {
			operation.request.deliver({
				type: "intent-state-changed",
				sessionId: operation.request.sessionId,
				expectedGeneration: operation.request.expectedGeneration,
				recoveryOperationEpoch: operation.request.recoveryOperationEpoch,
				intentState: {
					kind: "failed",
					intentId: operation.request.intent.intentId,
					reason: "recovery-runtime-failed",
				},
			});
		});
	}

	private startHandoffRecoveryCopy(leafId: string): void {
		const operation = this.beginHandoffRecoveryOperation(leafId, "copy");
		if (!operation) return;
		void operation.port.copyAndContinue(
			operation.request,
			this.handoffRecoveryActionHost?.writeClipboard
				? (text) => this.handoffRecoveryActionHost!.writeClipboard(text)
				: async () => { throw new Error("Recovery clipboard is unavailable"); },
		).catch(() => {
			operation.request.deliver({
				type: "intent-state-changed",
				sessionId: operation.request.sessionId,
				expectedGeneration: operation.request.expectedGeneration,
				recoveryOperationEpoch: operation.request.recoveryOperationEpoch,
				intentState: {
					kind: "failed",
					intentId: operation.request.intent.intentId,
					reason: "recovery-runtime-failed",
				},
			});
		});
	}

	private startHandoffRecoveryExport(leafId: string): void {
		const actionHost = this.handoffRecoveryActionHost;
		if (!actionHost) return;
		void actionHost.chooseVerifiedExporter().then((exportVerified) => {
			if (!exportVerified) return;
			const operation = this.beginHandoffRecoveryOperation(leafId, "export");
			if (!operation) return;
			void operation.port.exportAndContinue(operation.request, exportVerified).catch(() => {
				operation.request.deliver({
					type: "intent-state-changed",
					sessionId: operation.request.sessionId,
					expectedGeneration: operation.request.expectedGeneration,
					recoveryOperationEpoch: operation.request.recoveryOperationEpoch,
					intentState: {
						kind: "failed",
						intentId: operation.request.intent.intentId,
						reason: "recovery-runtime-failed",
					},
				});
			});
		}).catch(() => undefined);
	}

	private startHandoffRecoveryDiscard(leafId: string): void {
		const actionHost = this.handoffRecoveryActionHost;
		if (!actionHost) return;
		void actionHost.confirmDiscard().then((confirmed) => {
			if (!confirmed) return;
			const operation = this.beginHandoffRecoveryOperation(leafId, "discard");
			if (!operation) return;
			void operation.port.discardAndContinue(operation.request).catch(() => {
				operation.request.deliver({
					type: "intent-state-changed",
					sessionId: operation.request.sessionId,
					expectedGeneration: operation.request.expectedGeneration,
					recoveryOperationEpoch: operation.request.recoveryOperationEpoch,
					intentState: {
						kind: "failed",
						intentId: operation.request.intent.intentId,
						reason: "recovery-runtime-failed",
					},
				});
			});
		}).catch(() => undefined);
	}

	private continueHandoffRecoveryManually(leafId: string): void {
		const port = this.handoffRecoveryPort;
		const request = this.buildCurrentHandoffRecoveryRequest(leafId, port);
		if (!port || !request) return;
		void port.continueWithoutAutomaticApply(request).catch(() => undefined);
	}

	private retryHandoffRecoverySettlement(leafId: string): void {
		const port = this.handoffRecoveryPort;
		const request = this.buildCurrentHandoffRecoveryRequest(leafId, port);
		if (!port || !request) return;
		void port.retrySettlement(request).catch(() => undefined);
	}

	private hashManagedContent(content: string): string {
		return sha256HandoffRecoveryHexSync(content);
	}

	private getCodeMirrorHandoffContext(leafId: string): CodeMirrorHandoffContext | null {
		const session = this.managedSessions.get(leafId)?.session;
		if (!session) return null;
		if (session.handoff) {
			const currentCm = this.getCmView(session.view);
			if (
				currentCm === null
				|| session.view.file !== session.handoff.targetFile
				|| session.handoff.targetFile.path !== session.handoff.targetPath
			) return null;
			if (
				session.handoff.presentation === "target-proven"
				&& session.handoff.inputGateInstalled === false
				&& session.displayedLineage.kind === "known"
				&& session.displayedLineage.file === session.handoff.targetFile
				&& session.displayedLineage.path === session.handoff.targetPath
			) {
				return {
					kind: "same-path",
					sessionId: session.sessionId,
					leafId: session.leafId,
					handoffGeneration: session.generation,
					path: session.handoff.targetPath,
				};
			}
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

	private acceptHandoffReplayTransaction(
		transaction: Transaction,
		boundary: "route" | "update",
	): boolean {
		const frame = this.activeHandoffReplayDispatchFrame;
		const annotation = transaction.annotation(acceptedHandoffReplay);
		if (frame === null) {
			this.trace?.("editor", "handoff-replay-transaction-rejected", {
				boundary,
				activeFrame: false,
			});
			return false;
		}
		const checks = {
			authorityCurrent:
				this.isHandoffReplayDispatchFrameAuthorityCurrent(frame),
			transactionIdentity: frame.transaction === transaction,
			startStateCurrent: frame.cm.state === frame.startState,
			startStateIdentity: transaction.startState === frame.startState,
			changesIdentity: transaction.changes === frame.plan.replayChanges,
			selectionExact:
				transaction.newSelection.eq(frame.plan.mappedSelection),
			addToHistory:
				transaction.annotation(Transaction.addToHistory) === true,
			userEvent:
				transaction.annotation(Transaction.userEvent)
					=== "input.handoff-replay",
			historyIsolation: transaction.annotation(isolateHistory) === "full",
			permitIdentity: annotation?.permit === frame.permit,
			frameIdentity:
				annotation?.frameIdentity === frame.frameIdentity,
			scrollEffectIdentity:
				transaction.effects.length === 1
				&& transaction.effects[0] === frame.mappedScrollEffect,
		};
		if (
			Object.values(checks).some((accepted) => !accepted)
		) {
			this.trace?.("editor", "handoff-replay-transaction-rejected", {
				boundary,
				...checks,
			});
			return false;
		}
		if (boundary === "route") {
			if (frame.routeSeen || frame.updateSeen) return false;
			frame.routeSeen = true;
			return true;
		}
		if (!frame.routeSeen || frame.updateSeen) return false;
		frame.updateSeen = true;
		return true;
	}

	private isHandoffReplayDispatchFrameAuthorityCurrent(
		frame: ActiveHandoffReplayDispatchFrame,
	): boolean {
		const expected = frame.expectedSnapshot;
		const runtime = this.managedSessions.get(expected.leafId);
		const session = runtime?.session ?? null;
		const handoff = session?.handoff ?? null;
		const workflow = runtime?.targetWorkflow ?? null;
		const displayed = session?.displayedLineage ?? null;
		const binding = this.bindings.get(expected.leafId) ?? null;
		const guard = runtime?.cmGuard?.snapshot() ?? null;
		const localYtextRevision =
			this.yTextMutationRevisionByText.get(expected.ytext) ?? 0;
		const authorityAtBind = frame.binding.authorityYtextMutationEpochAtBind;
		const localAtBind = frame.binding.localYtextMutationRevisionAtBind;
		const runtimeDataDescriptor = Object.getOwnPropertyDescriptor(
			frame.binding.view as unknown as TextFileView,
			"data",
		);
		const currentYtextEpoch =
			authorityAtBind === undefined
				|| localAtBind === undefined
				|| localYtextRevision < localAtBind
				? null
				: authorityAtBind + (localYtextRevision - localAtBind);
		return this.asyncAuthorityOpen
			&& runtime === frame.runtime
			&& session === frame.session
			&& handoff === frame.handoff
			&& workflow === frame.workflow
			&& binding === frame.binding
			&& session !== null
			&& handoff !== null
			&& workflow !== null
			&& displayed?.kind === "known"
			&& session.sessionId === expected.sessionId
			&& session.leafId === expected.leafId
			&& session.generation === expected.handoffGeneration
			&& session.view === frame.binding.view
			&& session.view.file === expected.targetFile
			&& expected.targetFile.path === expected.targetPath
			&& session.binding.kind === "bound"
			&& session.binding.path === expected.targetPath
			&& session.binding.fileId === expected.targetFileId
			&& session.binding.ytext === expected.ytext
			&& session.nativeHistoryEpoch === expected.nativeHistoryEpoch
			&& displayed.file === expected.targetFile
			&& displayed.path === expected.targetPath
			&& displayed.fileId === expected.targetFileId
			&& displayed.cm === expected.cm
			&& displayed.document === expected.cmDocument
			&& displayed.editorRevision === expected.editorRevision
			&& handoff.presentation === "target-proven"
			&& handoff.targetFile === expected.targetFile
			&& handoff.targetPath === expected.targetPath
			&& handoff.targetReadyTokenId === expected.targetReadyTokenId
			&& handoff.inputGateInstalled
			&& !handoff.saveGuardInstalled
			&& handoff.pendingHostLoadCandidate === null
			&& handoff.phase === "awaiting-replay-settlement"
			&& handoff.recoveryOperationEpoch === frame.recoveryOperationEpoch
			&& handoff.intentState.kind === "replay-pending"
			&& handoff.intentState.intentId === frame.record.intentId
			&& handoff.intentState.recordId === frame.record.recordId
			&& handoff.recoveryTargetBindingRequest?.recoveryOperationEpoch
				=== frame.recoveryOperationEpoch
			&& handoff.recoveryTargetBindingRequest.intentId
				=== frame.record.intentId
			&& handoff.recoveryTargetBindingRequest.recordId
				=== frame.record.recordId
			&& workflow.sessionId === expected.sessionId
			&& workflow.handoffGeneration === expected.handoffGeneration
			&& workflow.targetFile === expected.targetFile
			&& workflow.targetPath === expected.targetPath
			&& workflow.targetReadyToken === frame.targetReadyToken
			&& workflow.targetPresentationReceipt
				?.hostLoadCompletionReceipt === frame.hostLoadReceipt
			&& frame.targetReadyToken.tokenId === expected.targetReadyTokenId
			&& frame.targetReadyToken.targetFile === expected.targetFile
			&& frame.targetReadyToken.targetPath === expected.targetPath
			&& frame.targetReadyToken.targetAuthority.kind === "existing"
			&& frame.targetReadyToken.targetAuthority.fileId
				=== expected.targetFileId
			&& frame.targetReadyToken.targetAuthority.ytextIdentity
				=== expected.ytextIdentity
			&& frame.binding.file === expected.targetFile
			&& frame.binding.path === expected.targetPath
			&& frame.binding.fileId === expected.targetFileId
			&& frame.binding.cm === expected.cm
			&& frame.binding.ytext === expected.ytext
			&& frame.record.status === "replay-pending"
			&& frame.record.recordId === frame.permit.recordId
			&& frame.record.checksum === frame.permit.replayPendingChecksum
			&& frame.record.intentId === frame.plan.intentId
			&& frame.record.targetPath === expected.targetPath
			&& frame.record.applyWitness?.planId === frame.plan.planId
			&& frame.record.applyWitness.kind === frame.plan.kind
			&& frame.record.applyWitness.dispatchReceiptHash === null
			&& frame.permit.planId === frame.plan.planId
			&& frame.permit.permitId === frame.plan.replayPermitId
			&& frame.permit.recoveryOperationEpoch
				=== frame.recoveryOperationEpoch
			&& this.knownCmViews.has(expected.cm)
			&& this.cmToLeafId.get(expected.cm) === expected.leafId
			&& expected.cm.dom.isConnected
			&& session.view.containerEl.contains(expected.cm.dom)
			&& expected.cm.state === frame.startState
			&& expected.cm.state.doc === expected.cmDocument
			&& expected.cm.state.selection.eq(expected.selection)
			&& (this.bindingEpochByLeafId.get(expected.leafId) ?? 0)
				=== expected.bindingEpoch
			&& (this.editorRevisionByCm.get(expected.cm) ?? 0)
				=== expected.editorRevision
			&& currentYtextEpoch === expected.ytextMutationEpoch
			&& expected.ytext.toJSON() === expected.ytextContent
			&& runtimeDataDescriptor !== undefined
			&& "value" in runtimeDataDescriptor
			&& runtimeDataDescriptor.value === expected.runtimeCacheContent
			&& this.vaultSync.getTextForPath(expected.targetPath) === expected.ytext
			&& this.vaultSync.getFileId(expected.targetPath)
				=== expected.targetFileId
			&& this.vaultSync.getFileIdForText(expected.ytext)
				=== expected.targetFileId
			&& guard?.view === expected.cm
			&& !guard.inert
			&& guard.gateClosed
			&& guard.nativeHistoryEpoch === expected.nativeHistoryEpoch
			&& guard.selectionEpoch === expected.selectionEpoch
			&& guard.scrollEpoch === expected.scrollEpoch;
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
		}>,
	): boolean {
		const current = this.managedSessions.get(runtime.session.leafId);
		if (current !== runtime || !this.asyncAuthorityOpen) return false;
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
		return true;
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

	private isManagedTargetWorkflowCurrent(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
	): boolean {
		const handoff = runtime.session.handoff;
		return this.asyncAuthorityOpen
			&& this.managedSessions.get(runtime.session.leafId) === runtime
			&& runtime.targetWorkflow === workflow
			&& runtime.session.sessionId === workflow.sessionId
			&& runtime.session.generation === workflow.handoffGeneration
			&& runtime.session.currentSwitchIntentSeq === workflow.switchIntentSeq
			&& runtime.session.view.file === workflow.targetFile
			&& workflow.targetFile.path === workflow.targetPath
			&& handoff !== null
			&& handoff.targetFile === workflow.targetFile
			&& handoff.targetPath === workflow.targetPath
			&& handoff.sourceUnloadReceiptId !== null
			&& handoff.sourceUnloadReceiptId === workflow.candidate.sourceUnloadReceiptId;
	}

	private captureOpenViewsForAdmission(path: string): MarkdownView[] {
		return this.captureAuthorityOpenFileViews(path).filter((view): view is MarkdownView => {
			return (view as MarkdownView | null)?.file?.path === path;
		});
	}

	private beginTargetPresentation(runtime: ManagedLeafRuntime): void {
		const port = this.editorAuthorityControllerPort;
		const handoff = runtime.session.handoff;
		const candidate = handoff?.pendingHostLoadCandidate ?? null;
		if (
			!this.asyncAuthorityOpen
			|| !port
			|| !handoff
			|| !candidate
			|| handoff.presentation !== "target-candidate"
			|| runtime.session.currentSwitchIntentSeq === null
		) return;
		const retained = runtime.targetWorkflow;
		if (
			retained
			&& retained.candidate === candidate
			&& this.isManagedTargetWorkflowCurrent(runtime, retained)
		) return;
		const openViews = this.captureOpenViewsForAdmission(handoff.targetPath);
		if (openViews.length === 0) {
			this.trace?.("editor", "target-presentation-start-deferred", {
				leafId: runtime.session.leafId,
				path: handoff.targetPath,
				reason: "target-view-not-enumerated",
				viewPath: runtime.session.view.file?.path ?? null,
			});
			return;
		}
		let openEditorTicket: OpenEditorMutationTicket;
		try {
			openEditorTicket = this.captureOpenEditorMutationTicket(
				handoff.targetPath,
				openViews,
			);
		} catch (error) {
			this.trace?.("editor", "target-presentation-start-deferred", {
				leafId: runtime.session.leafId,
				path: handoff.targetPath,
				reason: "ticket-capture-failed",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const workflow: ManagedTargetWorkflow = {
			sessionId: runtime.session.sessionId,
			handoffGeneration: runtime.session.generation,
			switchIntentSeq: runtime.session.currentSwitchIntentSeq,
			targetFile: handoff.targetFile,
			targetPath: handoff.targetPath,
			candidate,
			openEditorTicket,
			presentationPlan: null,
			presentationRequestInFlight: false,
			presentationPermitConsumed: false,
			presentationCommitInFlight: false,
			presentationCompletionInFlight: false,
			hostCompletionReceipt: null,
			targetPresentationReceipt: null,
			targetReadyToken: null,
			openAdmissionInFlight: false,
		};
		this.clearTargetPresentationRetry(runtime.session.leafId, false);
		this.clearTargetBindingRetry(runtime.session.leafId);
		runtime.targetWorkflow = workflow;
		const request: TargetPresentationRequest = Object.freeze({
			requestId: this.createManagedAuthorityRequestId("target-presentation"),
			sessionId: workflow.sessionId,
			leafId: runtime.session.leafId,
			handoffGeneration: workflow.handoffGeneration,
			switchIntentSeq: workflow.switchIntentSeq,
			targetPath: workflow.targetPath,
			targetFile: workflow.targetFile,
			candidate,
			openEditorTicket,
		});
		void this.runTargetPresentationRequest(runtime, workflow, request);
	}

	private async runTargetPresentationRequest(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		request: TargetPresentationRequest,
	): Promise<void> {
		const port = this.editorAuthorityControllerPort;
		if (!port || workflow.presentationRequestInFlight) return;
		workflow.presentationRequestInFlight = true;
		const requestedAt = Date.now();
		let result: TargetPresentationRequestResult;
		try {
			result = await port.requestTargetPresentation(request);
		} catch (error) {
			workflow.presentationRequestInFlight = false;
			this.trace?.("editor", "target-presentation-request-failed", {
				leafId: request.leafId,
				path: request.targetPath,
				error: error instanceof Error ? error.message : String(error),
			});
			this.scheduleTargetPresentationReplan(runtime, workflow, "request-failed");
			return;
		}
		workflow.presentationRequestInFlight = false;
		const workflowCurrent = this.isManagedTargetWorkflowCurrent(runtime, workflow);
		this.trace?.("editor", "target-presentation-request-settled", {
			leafId: request.leafId,
			path: request.targetPath,
			kind: result.kind,
			reason: result.kind === "planned" ? null : result.reason,
			workflowCurrent,
			durationMs: Date.now() - requestedAt,
		});
		if (!workflowCurrent) return;
		if (result.kind !== "planned") {
			this.trace?.("editor", "target-presentation-deferred", {
				leafId: request.leafId,
				path: request.targetPath,
				kind: result.kind,
				reason: result.reason,
			});
			this.scheduleTargetPresentationReplan(
				runtime,
				workflow,
				`request-${result.kind}-${result.reason}`,
			);
			return;
		}
		const plan = result.plan;
		if (
			plan.hostLoadTokenId !== workflow.candidate.hostLoadTokenId
			|| plan.switchIntentSeq !== workflow.switchIntentSeq
			|| plan.expectedNativeHistoryEpoch
				!== workflow.candidate.nativeHistoryEpochBefore
		) {
			this.scheduleTargetPresentationReplan(runtime, workflow, "plan-lineage-mismatch");
			return;
		}
		workflow.presentationPlan = plan;
		const guard = runtime.cmGuard;
		if (!guard) {
			this.scheduleTargetPresentationReplan(runtime, workflow, "guard-missing");
			return;
		}
		const permitContext: TargetPresentationPermitContext = Object.freeze({
			presentationPlanId: plan.planId,
			authorityFreshnessHandleId: plan.authorityFreshnessHandleId,
			sessionId: workflow.sessionId,
			leafId: runtime.session.leafId,
			handoffGeneration: workflow.handoffGeneration,
			switchIntentSeq: workflow.switchIntentSeq,
			targetPath: workflow.targetPath,
			targetFile: workflow.targetFile,
			hostLoadTokenId: workflow.candidate.hostLoadTokenId,
			candidate: workflow.candidate,
			openEditorTicket: workflow.openEditorTicket,
		});
		if (!port.consumeTargetPresentationPermit(plan.presentationPermitId, permitContext)) {
			this.scheduleTargetPresentationReplan(runtime, workflow, "permit-stale");
			return;
		}
		workflow.presentationPermitConsumed = true;
		if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
		this.clearTargetPresentationRetry(runtime.session.leafId);
		void this.applyTargetPresentationPlan(runtime, workflow);
	}

	private async applyTargetPresentationPlan(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
	): Promise<void> {
		const plan = workflow.presentationPlan;
		const guard = runtime.cmGuard;
		if (
			!plan
			|| !guard
			|| !workflow.presentationPermitConsumed
			|| workflow.presentationCommitInFlight
			|| !this.isManagedTargetWorkflowCurrent(runtime, workflow)
		) return;
		workflow.presentationCommitInFlight = true;
		let accepted: Awaited<ReturnType<CodeMirrorHandoffGuard["acceptHeldHostLoad"]>>;
		try {
			accepted = await guard.acceptHeldHostLoad({
				candidate: workflow.candidate,
				presentationPlanId: plan.planId,
			});
		} catch (error) {
			workflow.presentationCommitInFlight = false;
			this.trace?.("editor", "target-presentation-host-load-failed", {
				leafId: runtime.session.leafId,
				path: workflow.targetPath,
				error: error instanceof Error ? error.message : String(error),
			});
			this.scheduleTargetPresentationCommitRetry(runtime, workflow, "host-load-failed");
			return;
		}
		workflow.presentationCommitInFlight = false;
		if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
		if (accepted.kind === "accepted") {
			this.handleSettledHostLoadCompletion(runtime, accepted.receipt);
			return;
		}
		if (accepted.kind === "pending-notification") {
			this.scheduleTargetPresentationCommitRetry(
				runtime,
				workflow,
				`pending-${accepted.notification}`,
			);
			return;
		}
		if (accepted.kind === "rejected") {
			const commitSnapshot = guard.snapshot();
			const qaFailureDetails = (
				typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
				&& __KAOS_QA_HARNESS_ENABLED__
			)
				? {
					commitFailureReason: commitSnapshot.commitFailureReason ?? null,
					gateAuthorityAdvanceFailureReason:
						commitSnapshot.gateAuthorityAdvanceFailureReason ?? null,
					inputAuthorityAdvanceFailureReason:
						commitSnapshot.inputAuthorityAdvanceFailureReason ?? null,
					hostPostDelegationFailureReason:
						commitSnapshot.hostPostDelegationFailureReason ?? null,
				}
				: {};
			this.trace?.("editor", "target-presentation-host-load-rejected", {
				leafId: runtime.session.leafId,
				path: workflow.targetPath,
				reason: accepted.reason,
				...qaFailureDetails,
			});
			const commitState = commitSnapshot.commitState;
			if (commitState === "pending" || commitState === "committed") {
				this.scheduleTargetPresentationCommitRetry(
					runtime,
					workflow,
					`host-load-${accepted.reason}`,
				);
			}
		}
	}

	private handleSettledHostLoadCompletion(
		runtime: ManagedLeafRuntime,
		receipt: HostLoadCompletionReceipt,
	): void {
		const workflow = runtime.targetWorkflow;
		if (
			!workflow
			|| !workflow.presentationPlan
			|| !this.isManagedTargetWorkflowCurrent(runtime, workflow)
			|| !this.isHostLoadCompletionCurrent(receipt)
			|| receipt.hostLoadTokenId !== workflow.candidate.hostLoadTokenId
			|| receipt.switchIntentSeq !== workflow.switchIntentSeq
			|| receipt.targetPath !== workflow.targetPath
		) return;
		if (workflow.hostCompletionReceipt === receipt) return;
		if (workflow.hostCompletionReceipt !== null) return;
		if (!this.advanceSettledHostStateRevision(workflow.candidate)) {
			this.trace?.("editor", "target-presentation-state-revision-rejected", {
				leafId: runtime.session.leafId,
				path: workflow.targetPath,
				applicationKind: workflow.candidate.applicationKind,
				observedEditorRevision:
					this.editorRevisionByCm.get(workflow.candidate.cm) ?? 0,
				expectedEditorRevision:
					workflow.candidate.editorRevisionBefore + 1,
			});
			return;
		}
		this.clearTargetPresentationRetry(runtime.session.leafId);
		workflow.hostCompletionReceipt = receipt;
		void this.finishTargetPresentation(runtime, workflow, receipt);
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

	private async finishTargetPresentation(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		hostReceipt: HostLoadCompletionReceipt,
	): Promise<void> {
		const port = this.editorAuthorityControllerPort;
		const plan = workflow.presentationPlan;
		if (!port || !plan || workflow.presentationCompletionInFlight) return;
		workflow.presentationCompletionInFlight = true;
		let result: TargetPresentationResult;
		try {
			result = await port.completeTargetPresentation(hostReceipt);
		} catch (error) {
			workflow.presentationCompletionInFlight = false;
			this.trace?.("editor", "target-presentation-completion-failed", {
				leafId: runtime.session.leafId,
				path: workflow.targetPath,
				error: error instanceof Error ? error.message : String(error),
			});
			this.scheduleTargetPresentationCompletionRetry(
				runtime,
				workflow,
				hostReceipt,
				"completion-failed",
			);
			return;
		}
		workflow.presentationCompletionInFlight = false;
		if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
		if (result.kind !== "accepted") {
			this.scheduleTargetPresentationCompletionRetry(
				runtime,
				workflow,
				hostReceipt,
				`completion-${result.reason}`,
			);
			return;
		}
		const receipt = result.receipt;
		if (
			receipt.presentationPlanId !== plan.planId
			|| receipt.hostLoadCompletionReceipt !== hostReceipt
			|| receipt.replacementTargetReadyToken.targetFile !== workflow.targetFile
			|| receipt.replacementTargetReadyToken.targetPath !== workflow.targetPath
		) {
			this.scheduleTargetPresentationCompletionRetry(
				runtime,
				workflow,
				hostReceipt,
				"completion-lineage-mismatch",
			);
			return;
		}
		const reduction = reduceManagedLeafSession(runtime.session, {
			type: "target-presented",
			sessionId: workflow.sessionId,
			expectedGeneration: workflow.handoffGeneration,
			receipt,
		});
		if (!reduction.accepted) {
			this.scheduleTargetPresentationCompletionRetry(
				runtime,
				workflow,
				hostReceipt,
				"completion-reducer-rejected",
			);
			return;
		}
		if (runtime.hostGuard?.markTargetProven({
			handoffGeneration: workflow.handoffGeneration,
			targetFile: workflow.targetFile,
			certifiedContent: receipt.replacementTargetReadyToken.certifiedBaseContent,
		}) !== true) {
			this.scheduleTargetPresentationCompletionRetry(
				runtime,
				workflow,
				hostReceipt,
				"completion-host-guard-rejected",
			);
			return;
		}
		this.clearTargetPresentationRetry(runtime.session.leafId);
		workflow.targetPresentationReceipt = receipt;
		workflow.targetReadyToken = receipt.replacementTargetReadyToken;
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		this.applyHandoffEffects(runtime, reduction.effects, "target-presented");
		this.onHandoffTargetPresentationReady?.(
			receipt.replacementTargetReadyToken,
		);
		this.requestTargetBindingAdmission(runtime, workflow);
	}

	private clearTargetPresentationRetry(leafId: string, resetAttempts = true): void {
		const timer = this.pendingTargetPresentationRetries.get(leafId);
		if (timer) clearTimeout(timer);
		this.pendingTargetPresentationRetries.delete(leafId);
		if (resetAttempts) this.targetPresentationRetryAttempts.delete(leafId);
	}

	private scheduleTargetPresentationRetry(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		reason: string,
		retry: () => void,
	): void {
		const leafId = runtime.session.leafId;
		if (
			!this.isManagedTargetWorkflowCurrent(runtime, workflow)
			|| runtime.session.handoff?.presentation !== "target-candidate"
			|| this.pendingTargetPresentationRetries.has(leafId)
		) return;
		const attempt = (this.targetPresentationRetryAttempts.get(leafId) ?? 0) + 1;
		this.targetPresentationRetryAttempts.set(leafId, attempt);
		const delayMs = TARGET_PRESENTATION_RETRY_DELAYS_MS[
			Math.min(attempt - 1, TARGET_PRESENTATION_RETRY_DELAYS_MS.length - 1)
		]!;
		const timer = setTimeout(() => {
			if (this.pendingTargetPresentationRetries.get(leafId) !== timer) return;
			this.pendingTargetPresentationRetries.delete(leafId);
			if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) {
				this.targetPresentationRetryAttempts.delete(leafId);
				return;
			}
			retry();
		}, delayMs);
		this.pendingTargetPresentationRetries.set(leafId, timer);
		this.trace?.("editor", "target-presentation-fresh-evaluation-scheduled", {
			leafId,
			path: workflow.targetPath,
			reason,
			attempt,
			delayMs,
		});
	}

	private scheduleTargetPresentationReplan(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		reason: string,
	): void {
		if (workflow.presentationPermitConsumed) return;
		this.scheduleTargetPresentationRetry(runtime, workflow, reason, () => {
			if (
				workflow.presentationPermitConsumed
				|| runtime.targetWorkflow !== workflow
			) return;
			runtime.targetWorkflow = null;
			this.beginTargetPresentation(runtime);
		});
	}

	private scheduleTargetPresentationCommitRetry(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		reason: string,
	): void {
		this.scheduleTargetPresentationRetry(runtime, workflow, reason, () => {
			void this.applyTargetPresentationPlan(runtime, workflow);
		});
	}

	private scheduleTargetPresentationCompletionRetry(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		hostReceipt: HostLoadCompletionReceipt,
		reason: string,
	): void {
		this.scheduleTargetPresentationRetry(runtime, workflow, reason, () => {
			void this.finishTargetPresentation(runtime, workflow, hostReceipt);
		});
	}

	private clearTargetBindingRetry(leafId: string, resetAttempts = true): void {
		const timer = this.pendingTargetBindingRetries.get(leafId);
		if (timer) clearTimeout(timer);
		this.pendingTargetBindingRetries.delete(leafId);
		if (resetAttempts) this.targetBindingRetryAttempts.delete(leafId);
	}

	private captureRecoveryTargetBindingRequest(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
	): NonNullable<ManagedLeafSession["handoff"]>["recoveryTargetBindingRequest"] {
		const session = runtime.session;
		const handoff = session.handoff;
		const request = handoff?.recoveryTargetBindingRequest ?? null;
		const intentState = handoff?.intentState;
		if (
			!request
			|| !intentState
			|| (
				intentState.kind !== "stored"
				&& intentState.kind !== "replay-pending"
			)
			|| !this.isManagedTargetWorkflowCurrent(runtime, workflow)
			|| handoff.presentation !== "target-proven"
			|| handoff.pendingHostLoadCandidate !== null
			|| !handoff.inputGateInstalled
			|| handoff.saveGuardInstalled
			|| (
				intentState.kind === "stored"
					? handoff.phase !== "awaiting-recovery-commit"
					: handoff.phase !== "awaiting-replay-settlement"
			)
			|| request.recoveryOperationEpoch !== handoff.recoveryOperationEpoch
			|| request.intentId !== intentState.intentId
			|| request.recordId !== intentState.recordId
			|| session.binding.kind !== "unbound"
			|| session.pendingInputStartReservation !== null
			|| session.displayedLineage.kind !== "known"
			|| session.displayedLineage.file !== handoff.targetFile
			|| session.displayedLineage.path !== handoff.targetPath
			|| session.displayedLineage.cm.state.doc
				!== session.displayedLineage.document
			|| !session.activeRecoveries.some((recovery) =>
				recovery.sessionId === session.sessionId
				&& recovery.handoffGeneration === session.generation
				&& recovery.recoveryOperationEpoch === request.recoveryOperationEpoch
				&& recovery.intentState.kind === intentState.kind
				&& recovery.intentState.intentId === request.intentId
				&& recovery.intentState.recordId === request.recordId
				&& recovery.intent.intentId === request.intentId
				&& recovery.intent.targetPath === workflow.targetPath
				&& recovery.intent.targetFile === workflow.targetFile
			)
		) return null;
		return request;
	}

	private isNormalTargetBindingReady(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
	): boolean {
		const handoff = runtime.session.handoff;
		return this.isManagedTargetWorkflowCurrent(runtime, workflow)
			&& handoff?.presentation === "target-proven"
			&& handoff.phase === "target-ready"
			&& !handoff.inputGateInstalled
			&& !handoff.saveGuardInstalled
			&& runtime.session.pendingInputStartReservation === null;
	}

	private scheduleTargetBindingRetry(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		reason: string,
	): void {
		const leafId = runtime.session.leafId;
		const recoveryRequest =
			this.captureRecoveryTargetBindingRequest(runtime, workflow);
		if (
			(!this.isNormalTargetBindingReady(runtime, workflow) && !recoveryRequest)
			|| this.pendingTargetBindingRetries.has(leafId)
		) return;
		workflow.targetReadyToken = null;
		const attempt = (this.targetBindingRetryAttempts.get(leafId) ?? 0) + 1;
		this.targetBindingRetryAttempts.set(leafId, attempt);
		const delayMs = TARGET_BIND_RETRY_DELAYS_MS[
			Math.min(attempt - 1, TARGET_BIND_RETRY_DELAYS_MS.length - 1)
		]!;
		const timer = setTimeout(() => {
			if (this.pendingTargetBindingRetries.get(leafId) !== timer) return;
			this.pendingTargetBindingRetries.delete(leafId);
			if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) {
				this.targetBindingRetryAttempts.delete(leafId);
				return;
			}
			this.requestTargetBindingAdmission(runtime, workflow);
		}, delayMs);
		this.pendingTargetBindingRetries.set(leafId, timer);
		this.trace?.("editor", "target-binding-fresh-evaluation-scheduled", {
			leafId,
			path: workflow.targetPath,
			reason,
			attempt,
			delayMs,
		});
	}

	private requestTargetBindingAdmission(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
	): void {
		const port = this.editorAuthorityControllerPort;
		const recoveryRequest =
			this.captureRecoveryTargetBindingRequest(runtime, workflow);
		if (
			!port
			|| workflow.openAdmissionInFlight
			|| !workflow.targetPresentationReceipt
			|| (
				!this.isNormalTargetBindingReady(runtime, workflow)
				&& !recoveryRequest
			)
		) return;
		this.clearTargetBindingRetry(runtime.session.leafId, false);
		const openViews = this.captureOpenViewsForAdmission(workflow.targetPath);
		if (openViews.length === 0) {
			this.scheduleTargetBindingRetry(runtime, workflow, "open-view-missing");
			return;
		}
		let openEditorTicket: OpenEditorMutationTicket;
		try {
			openEditorTicket = this.captureOpenEditorMutationTicket(
				workflow.targetPath,
				openViews,
			);
		} catch {
			this.scheduleTargetBindingRetry(runtime, workflow, "ticket-capture-failed");
			return;
		}
		const requestId =
			this.createManagedAuthorityRequestId("open-path-admission");
		let request: OpenPathAdmissionRequest;
		if (recoveryRequest) {
			const recoveryClaim: HandoffReplayRecoveryClaim = Object.freeze({
				recoveryOperationEpoch:
					recoveryRequest.recoveryOperationEpoch,
				intentId: recoveryRequest.intentId,
				recordId: recoveryRequest.recordId,
			});
			if (!this.isHandoffReplayRecoveryOpenEditorMutationTicket(
				openEditorTicket,
				recoveryClaim,
			)) {
				this.scheduleTargetBindingRetry(
					runtime,
					workflow,
					"recovery-ticket-capture-failed",
				);
				return;
			}
			request = Object.freeze({
				requestId,
				reason: "handoff-replay-target-bind",
				recoveryClaim,
				sessionId: workflow.sessionId,
				leafId: runtime.session.leafId,
				handoffGeneration: workflow.handoffGeneration,
				switchIntentSeq: workflow.switchIntentSeq,
				targetPath: workflow.targetPath,
				targetFile: workflow.targetFile,
				presentation: "target-proven",
				hostLoadTokenId: null,
				openEditorTicket,
			});
		} else {
			request = Object.freeze({
				requestId,
				reason: "open-editor-missing-target",
				sessionId: workflow.sessionId,
				leafId: runtime.session.leafId,
				handoffGeneration: workflow.handoffGeneration,
				switchIntentSeq: workflow.switchIntentSeq,
				targetPath: workflow.targetPath,
				targetFile: workflow.targetFile,
				presentation: "target-proven",
				hostLoadTokenId: null,
				openEditorTicket,
			});
		}
		workflow.openAdmissionInFlight = true;
		void this.runTargetBindingAdmission(runtime, workflow, request);
	}

	private async runTargetBindingAdmission(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		request: OpenPathAdmissionRequest,
	): Promise<void> {
		const port = this.editorAuthorityControllerPort;
		if (!port) return;
		let result: OpenPathAdmissionResult;
		try {
			result = await port.requestOpenPathAdmission(request);
		} catch (error) {
			if (this.isManagedTargetWorkflowCurrent(runtime, workflow)) {
				workflow.openAdmissionInFlight = false;
				this.scheduleTargetBindingRetry(runtime, workflow, "admission-request-failed");
			}
			this.trace?.("editor", "open-path-admission-failed", {
				leafId: request.leafId,
				path: request.targetPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
		let token: TargetReadyToken | null = null;
		if (result.kind === "existing") {
			token = result.targetReadyToken;
		} else if (result.kind === "seed-required") {
			let seeded: MissingTargetSeedResult;
			try {
				seeded = await port.seedMissingTarget(result.plan);
			} catch {
				if (this.isManagedTargetWorkflowCurrent(runtime, workflow)) {
					workflow.openAdmissionInFlight = false;
					this.scheduleTargetBindingRetry(runtime, workflow, "target-seed-failed");
				}
				return;
			}
			if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
			if (seeded.kind === "seeded") {
				token = seeded.receipt.replacementTargetReadyToken;
			}
		}
		if (!token) {
			workflow.openAdmissionInFlight = false;
			this.scheduleTargetBindingRetry(runtime, workflow, `admission-${result.kind}`);
			return;
		}
		workflow.openAdmissionInFlight = false;
		workflow.targetReadyToken = token;
		this.bindManagedTargetReady(runtime, workflow, token);
	}

	private bindManagedTargetReady(
		runtime: ManagedLeafRuntime,
		workflow: ManagedTargetWorkflow,
		token: TargetReadyToken,
	): void {
		if (!this.isManagedTargetWorkflowCurrent(runtime, workflow)) return;
		if (
			token.targetAuthority.kind !== "existing"
			|| token.sessionId !== workflow.sessionId
			|| token.leafId !== runtime.session.leafId
			|| token.handoffGeneration !== workflow.handoffGeneration
			|| token.switchIntentSeq !== workflow.switchIntentSeq
			|| token.targetFile !== workflow.targetFile
			|| token.targetPath !== workflow.targetPath
		) {
			this.scheduleTargetBindingRetry(runtime, workflow, "target-token-lineage-mismatch");
			return;
		}
		const cm = this.getCmView(runtime.session.view);
		const ytext = this.vaultSync.getTextForPath(workflow.targetPath);
		if (!cm || !ytext) {
			this.scheduleTargetBindingRetry(runtime, workflow, "target-runtime-authority-missing");
			return;
		}
		const bound = this.applyBinding({
			action: "bind",
			deviceName: this.lastDeviceName,
			view: runtime.session.view,
			cm,
			cmId: this.getCmId(cm),
			leafId: runtime.session.leafId,
			file: workflow.targetFile,
			filePath: workflow.targetPath,
			ytext,
			fileId: token.targetAuthority.fileId,
			targetReadyToken: token,
			targetPresentationReceipt: workflow.targetPresentationReceipt ?? undefined,
			reason: "target-ready-token",
			rapidSwitch: true,
		});
		if (bound && runtime.targetWorkflow === workflow) {
			this.clearTargetPresentationRetry(runtime.session.leafId);
			this.clearTargetBindingRetry(runtime.session.leafId);
			if (runtime.session.handoff?.recoveryTargetBindingRequest == null) {
				runtime.targetWorkflow = null;
			}
			this.pendingAdmissionByLeafId.delete(runtime.session.leafId);
			const current = this.captureCurrentTargetReadyToken({
				sessionId: token.sessionId,
				expectedGeneration: token.handoffGeneration,
				targetPath: token.targetPath,
				targetFile: token.targetFile,
			});
			if (current === token) this.onHandoffTargetReady?.(token);
		} else if (runtime.targetWorkflow === workflow) {
			this.scheduleTargetBindingRetry(runtime, workflow, "final-bind-cas-stale");
		}
	}

	beginPathHandoff(
		view: MarkdownView,
		targetFile: TFile,
		reason: string,
		provenance: "observed" | "selected" = "observed",
		sourceUnloadReceiptId: string | null = null,
	): boolean {
		this.manageView(view);
		const leafId = this.getLeafId(view);
		const runtime = this.managedSessions.get(leafId);
		if (!runtime || runtime.session.view !== view) return false;
		if (!this.requireManagedBoundary(view, `handoff:${reason}`)) return false;
		const existing = this.bindings.get(leafId);
		const displayed = runtime.session.displayedLineage;
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
		const sourceBindingEpoch = this.bindingEpochByLeafId.get(leafId) ?? 0;
		const sourceViewFile = view.file;
		const sourceViewPath = sourceViewFile?.path ?? null;
		const targetPath = targetFile.path;
		const captureEffect = reduction.effects.some(
			(effect) => effect.type === "capture-authority-before-detach",
		);
		const sourceAuthorityPath = reduction.state.handoff?.sourceAuthorityPath ?? null;
		const sourceAuthorityBeforeTransition = captureEffect && sourceAuthorityPath !== null
			? this.capturePathEditorAuthority(sourceAuthorityPath)
			: null;
		// Authority capture reads host/editor state and may synchronously re-enter
		// plugin callbacks. Never publish a reducer result computed from a session
		// that changed during that read.
		if (
			this.managedSessions.get(leafId) !== runtime
			|| runtime.session !== sourceSession
			|| this.bindings.get(leafId) !== existing
			|| (this.bindingEpochByLeafId.get(leafId) ?? 0) !== sourceBindingEpoch
			|| view.file !== sourceViewFile
			|| sourceViewFile?.path !== sourceViewPath
			|| targetFile.path !== targetPath
		) return false;
		this.advanceAuthorityEpoch();
		runtime.session = reduction.state;
		this.lastSuccessfullyAppliedHandoffReplayByLeafId.delete(leafId);
		this.clearTargetPresentationRetry(leafId);
		this.clearTargetBindingRetry(leafId);
		runtime.targetWorkflow = null;
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
		if (this.isManagedTargetSelected(session, targetFile)) return true;
		const runtime = this.managedSessions.get(session.leafId);
		const exactSourceUnloadReceiptId = runtime
			? this.captureExactSourceUnloadReceipt(runtime, session, targetFile)
			: null;
		return exactSourceUnloadReceiptId === null
			? this.beginPathHandoff(view, targetFile, reason)
			: this.beginPathHandoff(
				view,
				targetFile,
				reason,
				"selected",
				exactSourceUnloadReceiptId,
			);
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
				|| (effect.type === "persist-intent"
					&& runtime.session.handoff?.recoveryOperationEpoch
						!== effect.recoveryOperationEpoch)
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
				case "request-target-presentation": {
					const leafId = runtime.session.leafId;
					const sessionId = effect.sessionId;
					const handoffGeneration = effect.expectedGeneration;
					// The exact host candidate is published from inside TextFileView's
					// synchronous setViewData(clear=true) dispatch. Admission must observe
					// the settled host facade, never the re-entrant mid-dispatch projection.
					queueMicrotask(() => {
						const current = this.managedSessions.get(leafId);
						if (
							current !== runtime
							|| runtime.session.sessionId !== sessionId
							|| runtime.session.generation !== handoffGeneration
						) {
							this.trace?.("editor", "target-presentation-start-deferred", {
								leafId,
								path: runtime.session.handoff?.targetPath ?? null,
								reason: "scheduled-context-stale",
								sameRuntime: current === runtime,
								sameSession: runtime.session.sessionId === sessionId,
								sameGeneration: runtime.session.generation === handoffGeneration,
							});
							return;
						}
						this.beginTargetPresentation(runtime);
					});
					break;
				}
				case "request-recovery-target-binding": {
					const workflow = runtime.targetWorkflow;
					const recoveryRequest = workflow
						? this.captureRecoveryTargetBindingRequest(runtime, workflow)
						: null;
					if (
						workflow
						&& recoveryRequest
						&& recoveryRequest.recoveryOperationEpoch
							=== effect.recoveryOperationEpoch
						&& recoveryRequest.intentId === effect.intentId
						&& recoveryRequest.recordId === effect.recordId
					) {
						this.requestTargetBindingAdmission(runtime, workflow);
					}
					break;
				}
				case "release-input-gate":
					runtime.cmGuard?.refreshGate();
					break;
				case "restore-save-pass-through":
					break;
				case "persist-intent": {
					const port = this.handoffRecoveryPort;
					const request = this.buildHandoffRecoveryRequest(
						runtime.session.leafId,
						effect,
						port,
					);
					if (!request) {
						this.deliverHandoffRecoveryIntentState(runtime.session.leafId, {
							type: "intent-state-changed",
							sessionId: effect.sessionId,
							expectedGeneration: effect.expectedGeneration,
							recoveryOperationEpoch: effect.recoveryOperationEpoch,
							intentState: {
								kind: "failed",
								intentId: effect.intent.intentId,
								reason: "recovery-session-unavailable",
							},
						});
						break;
					}
					if (!port) {
						request.deliver({
							type: "intent-state-changed",
							sessionId: request.sessionId,
							expectedGeneration: request.expectedGeneration,
							recoveryOperationEpoch: request.recoveryOperationEpoch,
							intentState: {
								kind: "failed",
								intentId: request.intent.intentId,
								reason: "recovery-store-unavailable",
							},
						});
						break;
					}
					const effectKey = JSON.stringify([
						effect.sessionId,
						effect.expectedGeneration,
						effect.recoveryOperationEpoch,
						effect.intent.intentId,
						this.handoffRecoveryPortActivationEpoch,
					]);
					if (this.handoffRecoveryEffectsInFlight.has(effectKey)) break;
					this.handoffRecoveryEffectsInFlight.add(effectKey);
					void port.persistAndClassify(request).catch(() => {
						request.deliver({
							type: "intent-state-changed",
							sessionId: request.sessionId,
							expectedGeneration: request.expectedGeneration,
							recoveryOperationEpoch: request.recoveryOperationEpoch,
							intentState: {
								kind: "failed",
								intentId: request.intent.intentId,
								reason: "recovery-runtime-failed",
							},
						});
					}).finally(() => {
						this.handoffRecoveryEffectsInFlight.delete(effectKey);
					});
					break;
				}
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
		this.onHandoffSettlementMayHaveAdvanced?.(path);
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
				binding.path === notice.path
				&& binding.view.file === binding.file
				&& binding.file.path === notice.path,
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
		this.manageView(view);
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
			runtime.targetWorkflow = null;
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
		for (const timer of this.pendingHealthChecks.values()) clearTimeout(timer);
		this.pendingHealthChecks.clear();
		for (const timer of this.pendingCmResolveRetries.values()) clearTimeout(timer);
		this.pendingCmResolveRetries.clear();
		for (const timer of this.pendingTargetPresentationRetries.values()) clearTimeout(timer);
		this.pendingTargetPresentationRetries.clear();
		this.targetPresentationRetryAttempts.clear();
		for (const timer of this.pendingTargetBindingRetries.values()) clearTimeout(timer);
		this.pendingTargetBindingRetries.clear();
		this.targetBindingRetryAttempts.clear();
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
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const binding of Array.from(this.bindings.values())) {
			const runtime = this.managedSessions.get(this.getLeafId(binding.view));
			if (runtime?.session.view === binding.view) {
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
			this.unmanageView(runtime.session.view, "unbind-all", true);
		}
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
		for (const [leafId, binding] of Array.from(this.bindings.entries())) {
			if (binding.path === path) {
				this.cancelManagedHandoffAndUnmanage(
					binding.view,
					"unbind-by-path",
					"deleted",
				);
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
				this.manageView(binding.view);
				const runtime = this.managedSessions.get(leafId);
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
	 * Capture an optimistic-concurrency ticket for every visible editor of a
	 * path. The ticket deliberately includes editors that have not completed a
	 * Yjs binding yet, so input during the file-open transition is still part of
	 * the mutation boundary.
	 */
	private captureHandoffReplayRecoveryAdmissionEvidence(
		session: ManagedLeafSession,
		leafId: string,
	): HandoffReplayRecoveryAdmissionEvidence | null {
		const handoff = session.handoff;
		const request = handoff?.recoveryTargetBindingRequest ?? null;
		const intentState = handoff?.intentState;
		const runtime = this.managedSessions.get(leafId);
		const guard = runtime?.cmGuard?.snapshot() ?? null;
		if (
			!handoff
			|| !request
			|| !intentState
			|| runtime?.session !== session
			|| guard === null
			|| guard.inert
			|| !guard.gateClosed
			|| (
				intentState.kind !== "stored"
				&& intentState.kind !== "replay-pending"
			)
			|| request.recoveryOperationEpoch !== handoff.recoveryOperationEpoch
			|| request.intentId !== intentState.intentId
			|| request.recordId !== intentState.recordId
			|| handoff.presentation !== "target-proven"
			|| handoff.pendingHostLoadCandidate !== null
			|| !handoff.inputGateInstalled
			|| handoff.saveGuardInstalled
			|| (
				intentState.kind === "stored"
					? handoff.phase !== "awaiting-recovery-commit"
					: handoff.phase !== "awaiting-replay-settlement"
			)
		) return null;
		const recoveryClaim = Object.freeze({ ...request });
		const bindingEpoch = this.bindingEpochByLeafId.get(leafId) ?? 0;
		const binding = session.binding.kind === "bound"
			? Object.freeze({
				kind: "bound" as const,
				path: session.binding.path,
				fileId: session.binding.fileId,
				ytext: session.binding.ytext,
				bindingEpoch,
			})
			: Object.freeze({
				kind: "unbound" as const,
				bindingEpoch,
			});
		return Object.freeze({
			purpose: "handoff-replay-target-bind",
			recoveryClaim,
			recoveryTargetBindingRequest: recoveryClaim,
			inputGateInstalled: handoff.inputGateInstalled,
			saveGuardInstalled: handoff.saveGuardInstalled,
			pendingHostLoadCandidate: null,
			intentState: Object.freeze({
				kind: intentState.kind,
				intentId: intentState.intentId,
				recordId: intentState.recordId,
			}),
			binding,
		});
	}

	private sameHandoffReplayRecoveryAdmissionEvidence(
		left: HandoffReplayRecoveryAdmissionEvidence | undefined,
		right: HandoffReplayRecoveryAdmissionEvidence | null,
	): boolean {
		if (!left || !right) return left === undefined && right === null;
		const leftBinding = left.binding;
		const rightBinding = right.binding;
		return left.purpose === right.purpose
			&& left.recoveryClaim.recoveryOperationEpoch
				=== right.recoveryClaim.recoveryOperationEpoch
			&& left.recoveryClaim.intentId === right.recoveryClaim.intentId
			&& left.recoveryClaim.recordId === right.recoveryClaim.recordId
			&& left.recoveryTargetBindingRequest?.recoveryOperationEpoch
				=== right.recoveryTargetBindingRequest?.recoveryOperationEpoch
			&& left.recoveryTargetBindingRequest?.intentId
				=== right.recoveryTargetBindingRequest?.intentId
			&& left.recoveryTargetBindingRequest?.recordId
				=== right.recoveryTargetBindingRequest?.recordId
			&& left.inputGateInstalled === right.inputGateInstalled
			&& left.saveGuardInstalled === right.saveGuardInstalled
			&& left.pendingHostLoadCandidate === right.pendingHostLoadCandidate
			&& left.intentState.kind === right.intentState.kind
			&& left.intentState.intentId === right.intentState.intentId
			&& left.intentState.recordId === right.intentState.recordId
			&& leftBinding.kind === rightBinding.kind
			&& leftBinding.bindingEpoch === rightBinding.bindingEpoch
			&& (
				leftBinding.kind === "unbound"
				|| (
					rightBinding.kind === "bound"
					&& leftBinding.path === rightBinding.path
					&& leftBinding.fileId === rightBinding.fileId
					&& leftBinding.ytext === rightBinding.ytext
				)
			);
	}

	private isHandoffReplayRecoveryOpenEditorMutationTicket(
		ticket: OpenEditorMutationTicket,
		claim: HandoffReplayRecoveryClaim,
	): ticket is HandoffReplayRecoveryOpenEditorMutationTicket {
		if (ticket.views.length !== 1) return false;
		const evidence = ticket.views[0]?.handoffReplayRecovery;
		return evidence?.purpose === "handoff-replay-target-bind"
			&& evidence.recoveryClaim.recoveryOperationEpoch
				=== claim.recoveryOperationEpoch
			&& evidence.recoveryClaim.intentId === claim.intentId
			&& evidence.recoveryClaim.recordId === claim.recordId
			&& evidence.recoveryTargetBindingRequest?.recoveryOperationEpoch
				=== claim.recoveryOperationEpoch
			&& evidence.recoveryTargetBindingRequest?.intentId === claim.intentId
			&& evidence.recoveryTargetBindingRequest?.recordId === claim.recordId
			&& evidence.binding.kind === "unbound";
	}

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
				const handoffReplayRecovery =
					this.captureHandoffReplayRecoveryAdmissionEvidence(
						session,
						leafId,
					);
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
					handoffPhase: handoff?.phase ?? null,
					intentStateKind: handoff?.intentState.kind ?? null,
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
					...(handoffReplayRecovery
						? { handoffReplayRecovery }
						: {}),
				};
			}),
		};
	}

	validateOpenEditorMutationTicket(
		ticket: OpenEditorMutationTicket,
		views: readonly MarkdownView[],
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
				|| (handoff?.phase ?? null) !== snapshot.handoffPhase
				|| (handoff?.intentState.kind ?? null) !== snapshot.intentStateKind
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
			if (!this.sameHandoffReplayRecoveryAdmissionEvidence(
				snapshot.handoffReplayRecovery,
				this.captureHandoffReplayRecoveryAdmissionEvidence(
					session,
					snapshot.leafId,
				),
			)) {
				return {
					current: false,
					reason: "handoff-generation-changed",
					leafId: snapshot.leafId,
				};
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
			if ((guardSnapshot?.selectionEpoch ?? 0) !== snapshot.selectionEpoch) {
				return { current: false, reason: "selection-epoch-changed", leafId: snapshot.leafId };
			}
			if ((guardSnapshot?.scrollEpoch ?? 0) !== snapshot.scrollEpoch) {
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
				|| (finalHandoff?.phase ?? null) !== snapshot.handoffPhase
				|| (finalHandoff?.intentState.kind ?? null) !== snapshot.intentStateKind
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
			if ((finalGuard?.selectionEpoch ?? 0) !== snapshot.selectionEpoch) {
				return { current: false, reason: "selection-epoch-changed", leafId: snapshot.leafId };
			}
			if ((finalGuard?.scrollEpoch ?? 0) !== snapshot.scrollEpoch) {
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
				binding.path === marker.path
				&& binding.view.file === binding.file
				&& binding.file.path === marker.path
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
			if (leafId) {
				this.lastSuccessfullyAppliedHandoffReplayByLeafId.delete(leafId);
			}
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
				&& (
					runtime.session.handoff === null
					|| runtime.session.handoff.presentation === "target-proven"
				)
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
		return session.handoff === null
			|| (
				session.handoff.presentation === "target-proven"
				&& session.handoff.targetFile === file
				&& session.handoff.targetPath === file.path
			);
	}

	private bumpBindingEpoch(leafId: string): number {
		this.advanceAuthorityEpoch();
		this.lastSuccessfullyAppliedHandoffReplayByLeafId.delete(leafId);
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
		const continuation = runtime
			? this.captureManagedContinuation(runtime.session.view)
			: null;
		if (!continuation) return;
		const timer = setTimeout(() => {
			if (this.pendingHealthChecks.get(leafId) !== timer) return;
			this.pendingHealthChecks.delete(leafId);
			if (!this.isManagedContinuationCurrent(continuation)) return;
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

	private captureTargetReadyBindContext(input: Readonly<{
		view: MarkdownView;
		file: TFile;
		filePath: string;
		leafId: string;
		cm: EditorView;
		ytext: Y.Text;
		fileId: string | undefined;
		token: TargetReadyToken;
		presentationReceipt: TargetPresentationReceipt;
	}>): Readonly<{
		freshness: AuthorityFreshnessContext;
		bind: BindPermitContext;
	}> | null {
		const {
			view,
			file,
			filePath,
			leafId,
			cm,
			ytext,
			fileId,
			token,
			presentationReceipt,
		} = input;
		const authority = token.targetAuthority;
		if (authority.kind !== "existing" || !fileId) return null;
		const runtime = this.managedSessions.get(leafId);
		const session = runtime?.session;
		const handoff = session?.handoff;
		const workflow = runtime?.targetWorkflow;
		const displayed = session?.displayedLineage;
		const hostReceipt = presentationReceipt.hostLoadCompletionReceipt;
		const guard = runtime?.cmGuard?.snapshot() ?? null;
		const recoveryRequest = runtime && workflow
			? this.captureRecoveryTargetBindingRequest(runtime, workflow)
			: null;
		const normalBindingReady = !!runtime
			&& !!workflow
			&& this.isNormalTargetBindingReady(runtime, workflow);
		const sessionIdentityCurrent = this.asyncAuthorityOpen
			&& !!runtime
			&& !!session
			&& session.view === view
			&& session.sessionId === token.sessionId
			&& session.leafId === token.leafId
			&& session.generation === token.handoffGeneration
			&& session.currentSwitchIntentSeq === token.switchIntentSeq
			&& view.file === file
			&& file === token.targetFile
			&& file.path === filePath
			&& token.targetPath === filePath;
		const handoffStateCurrent = !!handoff
			&& handoff.presentation === "target-proven"
			&& handoff.targetFile === file
			&& handoff.targetPath === filePath
			&& handoff.targetReadyTokenId
				=== presentationReceipt.replacementTargetReadyToken.tokenId
			&& handoff.pendingHostLoadCandidate === null
			&& (normalBindingReady || recoveryRequest !== null)
			&& session?.pendingInputStartReservation === null;
		const workflowCurrent = !!workflow
			&& workflow.targetPresentationReceipt === presentationReceipt
			&& workflow.targetReadyToken === token;
		const displayedEditorCurrent = displayed?.kind === "known"
			&& displayed.file === file
			&& displayed.path === filePath
			&& displayed.cm === cm
			&& displayed.document === cm.state.doc
			&& displayed.editorRevision === (this.editorRevisionByCm.get(cm) ?? 0)
			&& this.getCmView(view) === cm
			&& cm.dom.isConnected
			&& view.containerEl.contains(cm.dom);
		const activeAuthorityCurrent =
			this.vaultSync.getTextForPath(filePath) === ytext
			&& this.vaultSync.getFileId(filePath) === fileId
			&& this.vaultSync.getFileIdForText(ytext) === fileId
			&& authority.fileId === fileId
			&& authority.ytextIdentity.length > 0
			&& Number.isSafeInteger(authority.ytextMutationEpoch)
			&& authority.ytextMutationEpoch >= 0
			&& authority.bindPermitId.length > 0
			&& token.authorityFreshnessHandleId.length > 0;
		const tokenReceiptCurrent =
			token.hostLoadTokenId === hostReceipt.hostLoadTokenId
			&& token.hostLoadReceiptId === hostReceipt.receiptId
			&& token.hostLoadCompletedEpoch === hostReceipt.nativeHistoryEpoch
			&& token.nativeHistoryEpoch === hostReceipt.nativeHistoryEpoch
			&& token.targetSelectionEpoch === hostReceipt.targetSelectionEpoch
			&& token.targetScrollEpoch === hostReceipt.targetScrollEpoch
			&& token.certifiedBaseContent === cm.state.doc.toString()
			&& token.certifiedBaseContent === ytext.toJSON();
		const editorEpochsCurrent = session?.nativeHistoryEpoch === token.nativeHistoryEpoch
			&& guard?.view === cm
			&& !guard.inert
			&& guard.nativeHistoryEpoch === token.nativeHistoryEpoch
			&& guard.selectionEpoch === token.targetSelectionEpoch
			&& guard.scrollEpoch === token.targetScrollEpoch
			&& cm.state.selection.eq(hostReceipt.targetSelection)
			&& (this.bindingEpochByLeafId.get(leafId) ?? 0)
				=== handoff?.bindingEpochAfterDetach;
		if (
			!sessionIdentityCurrent
			|| !handoffStateCurrent
			|| !workflowCurrent
			|| !displayedEditorCurrent
			|| !activeAuthorityCurrent
			|| !tokenReceiptCurrent
			|| !editorEpochsCurrent
		) {
			this.trace?.("editor", "target-ready-bind-context-stale", {
				leafId,
				path: filePath,
				sessionIdentityCurrent,
				handoffStateCurrent,
				workflowCurrent,
				displayedEditorCurrent,
				displayedKnown: displayed?.kind === "known",
				displayedFileCurrent:
					displayed?.kind === "known" && displayed.file === file,
				displayedPathCurrent:
					displayed?.kind === "known" && displayed.path === filePath,
				displayedCmCurrent:
					displayed?.kind === "known" && displayed.cm === cm,
				displayedDocumentCurrent:
					displayed?.kind === "known" && displayed.document === cm.state.doc,
				displayedRevisionCurrent:
					displayed?.kind === "known"
					&& displayed.editorRevision
						=== (this.editorRevisionByCm.get(cm) ?? 0),
				resolvedCmCurrent: this.getCmView(view) === cm,
				cmConnected: cm.dom.isConnected,
				cmContained: view.containerEl.contains(cm.dom),
				activeAuthorityCurrent,
				tokenReceiptCurrent,
				editorEpochsCurrent,
			});
			return null;
		}
		let editorContent: string;
		let hostData: string;
		try {
			editorContent = view.editor.getValue();
			hostData = (view as unknown as TextFileView).getViewData();
		} catch {
			return null;
		}
		if (
			editorContent !== token.certifiedBaseContent
			|| hostData !== token.certifiedBaseContent
			|| (view as unknown as TextFileView).data !== token.certifiedBaseContent
		) return null;
		const freshness: AuthorityFreshnessContext = Object.freeze({
			sessionId: session.sessionId,
			leafId,
			handoffGeneration: session.generation,
			targetReadyTokenId: token.tokenId,
			targetFile: file,
			hostLoadReceiptId: hostReceipt.receiptId,
			cm,
			editorRevision: displayed.editorRevision,
			nativeHistoryEpoch: session.nativeHistoryEpoch,
			selectionEpoch: guard.selectionEpoch,
			scrollEpoch: guard.scrollEpoch,
		});
		return Object.freeze({
			freshness,
			bind: Object.freeze({
				...freshness,
				fileId,
				ytext,
				ytextIdentity: authority.ytextIdentity,
				ytextMutationEpoch: authority.ytextMutationEpoch,
				bindingEpoch: handoff.bindingEpochAfterDetach,
			}),
		});
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
		targetReadyToken?: TargetReadyToken;
		targetPresentationReceipt?: TargetPresentationReceipt;
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
			targetReadyToken,
			targetPresentationReceipt,
			existing,
			reason,
			rapidSwitch: rapidSwitchHint,
		} = options;
		const bindingFile = file ?? view.file;
		if (!bindingFile || bindingFile.path !== filePath) return false;
		if ((targetReadyToken === undefined) !== (targetPresentationReceipt === undefined)) {
			return false;
		}
		if (
			targetReadyToken !== undefined
			&& samePathAdoptionYtextMutationEpochAtBind !== undefined
		) return false;
		if (
			samePathAdoptionYtextMutationEpochAtBind !== undefined
			&& (
				!Number.isSafeInteger(samePathAdoptionYtextMutationEpochAtBind)
				|| samePathAdoptionYtextMutationEpochAtBind < 0
			)
		) return false;
		if (targetReadyToken && !this.editorAuthorityControllerPort) return false;
		this.manageView(view);
		if (!this.requireManagedBoundary(view, `${action}:${reason ?? "apply"}`)) return false;
		let exactLease = authorityLease;
		if (!targetReadyToken && !exactLease) {
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
		if (targetReadyToken && targetPresentationReceipt) {
			const port = this.editorAuthorityControllerPort;
			const initialContext = this.captureTargetReadyBindContext({
				view,
				file: bindingFile,
				filePath,
				leafId,
				cm,
				ytext,
				fileId,
				token: targetReadyToken,
				presentationReceipt: targetPresentationReceipt,
			});
			if (
				!port
				|| !initialContext
				|| !port.isAuthorityFreshnessCurrent(
					targetReadyToken.authorityFreshnessHandleId,
					initialContext.freshness,
				)
			) {
				this.bindingPublicationOwnerByCm.delete(cm);
				undoManager.destroy();
				return false;
			}
			const authority = targetReadyToken.targetAuthority;
			if (
				authority.kind !== "existing"
			) {
				this.bindingPublicationOwnerByCm.delete(cm);
				undoManager.destroy();
				return false;
			}
			authorityYtextMutationEpochAtBind = authority.ytextMutationEpoch;
			localYtextMutationRevisionAtBind =
				this.yTextMutationRevisionByText.get(ytext) ?? 0;
			const finalContext = this.captureTargetReadyBindContext({
				view,
				file: bindingFile,
				filePath,
				leafId,
				cm,
				ytext,
				fileId,
				token: targetReadyToken,
				presentationReceipt: targetPresentationReceipt,
			});
			if (
				!finalContext
				|| targetReadyToken.targetAuthority.kind !== "existing"
				|| !port.consumeBindPermit(
					targetReadyToken.targetAuthority.bindPermitId,
					finalContext.bind,
				)
			) {
				this.bindingPublicationOwnerByCm.delete(cm);
				undoManager.destroy();
				return false;
			}
		} else if (samePathAdoptionYtextMutationEpochAtBind !== undefined) {
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
		const bindingEpochAfterBind = this.bumpBindingEpoch(leafId);
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
			if (targetReadyToken && targetPresentationReceipt && fileId) {
				const completed = reduceManagedLeafSession(runtime.session, {
					type: "binding-completed",
					sessionId: targetReadyToken.sessionId,
					expectedGeneration: targetReadyToken.handoffGeneration,
					presentationTargetReadyTokenId:
						targetPresentationReceipt.replacementTargetReadyToken.tokenId,
					finalTargetReadyTokenId: targetReadyToken.tokenId,
					fileId,
					ytext,
					cm,
					bindingEpochAfterBind,
				});
				if (!completed.accepted) {
					this.detachBinding(view, "target-binding-reducer-rejected", false);
					return false;
				}
				this.advanceAuthorityEpoch();
				runtime.session = completed.state;
			} else if (currentHandoff === null || currentHandoff.presentation === "target-proven") {
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
			const retryRequired = requiredPath !== null
				&& runtime.session.view.file?.path === requiredPath
				&& runtime.session.binding.kind === "unbound"
				&& runtime.adoption.kind === "none"
				&& !this.bindings.has(leafId);
			if (!retryRequired) {
				this.samePathAdoptionRetryAttempts.delete(leafId);
				return;
			}
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
					|| this.samePathAdoptionRequiredPathByLeafId.get(leafId)
						!== requiredPath
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
					this.scheduleSamePathAdoptionRefresh(
						current,
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
				this.scheduleSamePathAdoptionRefresh(
					current,
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
					this.scheduleSamePathAdoptionRefresh(
						current,
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
		if (
			this.editorAuthorityControllerPort
			&& session.handoff?.presentation === "target-proven"
		) {
			const runtime = this.managedSessions.get(session.leafId);
			const workflow = runtime?.targetWorkflow;
			if (runtime && workflow) this.requestTargetBindingAdmission(runtime, workflow);
			return Object.freeze({
				kind: "missing-target",
				targetFile: file,
				targetPath: file.path,
			});
		}
		if (!this.isMarkdownPathSyncable(file.path)) {
			this.skipExcludedBinding(view, file.path, `resolve:${reason}`);
			return null;
		}
		const displayed = session.displayedLineage;
		const samePathReplacementAwaitingAdmission =
			session.handoff !== null
			&& displayed.kind === "known"
			&& displayed.path === file.path
			&& displayed.file !== file
			&& session.handoff.presentation !== "target-proven";
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
		cancelReason: "deleted" | "closed" | "excluded" | "teardown" | "unsupported-host",
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
