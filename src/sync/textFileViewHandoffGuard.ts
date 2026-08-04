import type { Text } from "@codemirror/state";
import type { TFile, TextFileView } from "obsidian";
import type {
	HostLoadCompletionReceipt,
	PendingHostLoadCandidate,
} from "./editorHandoffState";

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;
const EDITOR_HANDOFF_QA_ENABLED = typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
	&& __KAOS_QA_HARNESS_ENABLED__;

export type ManagedHostSwitchTicket = Readonly<{
	sessionId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	targetFile: TFile;
	sourceUnloadReceiptId: string;
}>;

/**
 * A load-entry callback may defer admission while an editor-side reservation
 * reaches a terminal boundary. A synchronous null retains the legacy
 * pass-through behavior. A deferred null is different: the host load is
 * suppressed because delegating it after an explicit deferred admission
 * failed would create an untracked file transition.
 */
export type ManagedHostSwitchTicketAdmission =
	| ManagedHostSwitchTicket
	| null
	| PromiseLike<ManagedHostSwitchTicket | null>;

/** Null means the source input gate is already closed; a promise drains one exact reservation. */
export type ManagedSourceUnloadDrainAdmission = null | PromiseLike<void>;

export type ExactHostLoadDispatchIdentity = Readonly<{
	hostLoadTokenId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	sourceUnloadReceiptId: string;
	targetPath: string;
	targetFile: TFile;
	runtimeView: TextFileView;
	incomingContent: string;
}>;

export interface TextFileViewHandoffGuardCallbacks {
	/** Runs before native unload or its forced save can observe the source editor. */
	onUnloadFileEntry(sourceFile: TFile): ManagedSourceUnloadDrainAdmission;
	onLoadFileEntry(
		targetFile: TFile,
		sourceUnloadReceiptId: string,
	): ManagedHostSwitchTicketAdmission;
	onSetViewDataEntry(input: Readonly<{
		ticket: ManagedHostSwitchTicket;
		incomingContent: string;
		clear: boolean;
	}>): string | null;
	onSetViewDataExit(input: Readonly<{
		ticket: ManagedHostSwitchTicket;
		hostLoadTokenId: string;
	}>): boolean;
	onHostLoadCandidate(candidate: PendingHostLoadCandidate): void;
	isHostLoadCandidateCurrent(candidate: PendingHostLoadCandidate): boolean;
	onHostLoadCompleted(receipt: HostLoadCompletionReceipt): void;
	onSaveSuppressed(input: Readonly<{
		sessionId: string;
		handoffGeneration: number;
		invocationFile: TFile | null;
		invocationPath: string | null;
	}>): void;
	captureSaveOwnershipContext(): ManagedSaveOwnershipContext | null;
	isSaveOwnershipContextCurrent(context: ManagedSaveOwnershipContext): boolean;
	onHostCapabilityLost(reason: string): void;
	isSessionCurrent(sessionId: string, handoffGeneration: number): boolean;
}

export type TextFileViewHostCapability =
	| "public-cancellable"
	| "owned-scheduler-with-unload-flush";

export interface TextFileViewHandoffGuardInstallOptions {
	hostApiVersion: string;
	requestSaveDelayMs?: number;
	/** Terminal bound for the exact editor-drain plus preexisting-save settlement. */
	sourceUnloadDrainDeadlineMs?: number;
}

export interface ManagedSaveOwnershipContext {
	sessionId: string;
	generation: number;
	file: TFile;
	path: string;
	displayedPath: string;
}

export type ManagedOwnedSaveJobSnapshot = Readonly<{
	jobId: number;
	sessionId: string;
	generation: number;
	file: TFile;
	path: string;
	displayedPath: string;
	saveEpoch: number;
}>;

export type ManagedSourceUnloadSnapshot = Readonly<{
	receiptId: string;
	unloadId: number;
	file: TFile;
	path: string;
	state: "saving" | "settled" | "rejected" | "atomic-window-expired";
	forcedSaveObserved: boolean;
	cacheRetiredBeforeUnloadSettled: boolean;
}>;

export type ManagedDeferredLoadAdmissionSnapshot = Readonly<{
	ownerId: number;
	pendingLoadEpoch: number;
	targetFile: TFile;
	targetPath: string;
	sourceUnloadReceiptId: string;
	sourceUnloadId: number;
	sourceFile: TFile;
	sourcePath: string;
	viewFileAtEntry: TFile | null;
	viewPathAtEntry: string | null;
}>;

export type ManagedSourceUnloadDrainSnapshot = Readonly<{
	ownerId: number;
	sourceFile: TFile;
	sourcePath: string;
	viewFileAtEntry: TFile;
	viewPathAtEntry: string;
	nativeLoadEpochAtEntry: number;
	pendingLoadEpochAtEntry: number;
	saveEpochAtEntry: number;
	preexistingSaveCount: number;
	expectedSaveEpochAfterDrain: number;
}>;

export type TextFileViewHandoffGuardInstallResult =
	| { kind: "installed"; guard: TextFileViewHandoffGuard }
	| {
		kind: "unsupported";
		reason:
			| "unsupported-host-adapter"
			| "method-not-wrappable"
			| "clear-load-not-observable";
	};

type ManagedViewSaveGuardMode =
	| Readonly<{ kind: "pass-through" }>
	| Readonly<{ kind: "inert-pass-through" }>
	| Readonly<{
		kind: "blocking-handoff";
		handoffGeneration: number;
		sourceLineagePath: string | null;
		targetPath: string;
	}>;

export type ManagedViewSaveGuard = Readonly<{
	leafId: string;
	view: TextFileView;
	originalRequestSave: TextFileView["requestSave"];
	originalSave: TextFileView["save"];
	installedRequestSave: TextFileView["requestSave"];
	installedSave: TextFileView["save"];
	hostCapability: TextFileViewHostCapability;
	hostCapabilityState: "ready" | "lost";
	saveEpoch: number;
	clearLoadCapability: "observable" | "clear-load-not-observable";
	mode: ManagedViewSaveGuardMode;
	inFlight: ReadonlyMap<number, Readonly<{
		file: TFile | null;
		path: string | null;
		startedAt: number;
	}>>;
	pendingTargetSave: boolean;
	pendingOwnedSave: ManagedOwnedSaveJobSnapshot | null;
	sourceUnload: ManagedSourceUnloadSnapshot | null;
	/** Monotonic revision for every pending host-load owner/state transition. */
	pendingLoadEpoch?: number;
	pendingDeferredLoadAdmission?: ManagedDeferredLoadAdmissionSnapshot | null;
	pendingSourceUnloadDrain?: ManagedSourceUnloadDrainSnapshot | null;
	/** Monotonic CAS revision for native load and association state. */
	nativeLoadEpoch?: number;
	/** Native host-load promises that have entered but not settled. */
	pendingNativeHostLoadCount?: number;
	/** Any active native load/association ambiguity makes normal release ineligible. */
	nativeHostLoadAmbiguous?: boolean;
	/** Monotonic revision for the retained post-presentation setViewData fence. */
	managedClearTombstoneEpoch?: number;
	/** True until the presented target enters its next exact unload or teardown. */
	managedClearTombstoneActive?: boolean;
	/** Guard-owned host lifecycle suspended until explicit safe teardown. */
	terminalHostLifecycle?: Readonly<{
		ownerId: number;
		state: "blocked";
	}> | null;
	/** True only while both installed save wrappers are the live host entry points. */
	wrappersCurrent: boolean;
	/** True only while load/unload/setViewData are the exact installed entry points. */
	loadWrappersCurrent?: boolean;
	/** Emergency ownership exists and both save entry points are synchronously blocked. */
	emergencySaveBlocked: boolean;
}>;

export interface TextFileViewEmergencySaveFence {
	readonly view: TextFileView;
	/**
	 * Reclaim writable/configurable save entry points and synchronously re-arm the block.
	 * Once wrapper drift is observed this remains false: an already-scheduled foreign
	 * save tail cannot be proven cancelled merely by restoring function identity.
	 */
	refresh(): boolean;
	/** Ownership/identity proof. Observed wrapper drift permanently taints this guard. */
	isCurrent(): boolean;
	/** Release this exact owner once. The manager calls this only after exact B or safe teardown. */
	release(): boolean;
}

export interface TextFileViewHandoffGuard {
	beginBlockingHandoff(input: Readonly<{
		handoffGeneration: number;
		sourceLineagePath: string | null;
		targetPath: string;
	}>): void;
	/** Pure exact-CAS predicate for irreversible target-presentation work. */
	isTargetPresentationReady(input: Readonly<{
		handoffGeneration: number;
		targetFile: TFile;
		certifiedContent: string;
	}>): boolean;
	markTargetProven(input: Readonly<{
		handoffGeneration: number;
		targetFile: TFile;
		certifiedContent: string;
	}>): boolean;
	/**
	 * Publish an exact completed host load as the new local editor authority.
	 * Unlike controller presentation proof, this also retires the consumed
	 * source-unload record so ordinary same-path admission can proceed behind
	 * the already-visible target.
	 */
	markTargetLocallyPresented(input: Readonly<{
		handoffGeneration: number;
		targetFile: TFile;
		certifiedContent: string;
	}>): boolean;
	reportHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean;
	reportHostLoadCompleted(receipt: HostLoadCompletionReceipt): boolean;
	isExactHostLoadDispatchActive(identity: ExactHostLoadDispatchIdentity): boolean;
	flushOwnedSave(): Promise<void>;
	cancelOwnedSave(): void;
	/** Reject one exact terminal lifecycle owner at a safe close/reopen boundary. */
	cancelTerminalHostLifecycle(reason: string): boolean;
	acquireEmergencySaveFence(): TextFileViewEmergencySaveFence;
	markInert(): void;
	restoreIfCurrent(): void;
	snapshot(): ManagedViewSaveGuard;
}

export type EditorHandoffHostQaBarrier = Readonly<{
	tryHoldHostLoad(input: Readonly<{
		stage: "load-entry" | "clear-load";
		leafId: string;
		sessionId: string;
		generation: number;
		targetPath: string;
		invocationFile: TFile | null;
		continueHostLoad(): "applied" | "rejected";
	}>): Readonly<{ settlement: Promise<"applied" | "rejected"> }> | null;
	tryHoldNativeSave(input: Readonly<{
		leafId: string;
		sessionId: string | null;
		generation: number | null;
		invocationFile: TFile | null;
		continueNativeSave(): Promise<"delegated" | "suppressed" | "rejected">;
	}>): Promise<void> | null;
	invalidateGuard(leafId: string): void;
}>;

type GuardedMethodName =
	| "onUnloadFile"
	| "onLoadFile"
	| "setViewData"
	| "requestSave"
	| "save";
type DelegationLane = GuardedMethodName | "requestSave.run" | "requestSave.flush";
type SaveDelegationLane = "requestSave" | "requestSave.run" | "requestSave.flush" | "save";
type RuntimeMethod = (this: TextFileView, ...args: unknown[]) => unknown;
type RuntimeMethodDescriptor = Omit<PropertyDescriptor, "value" | "get" | "set"> & Readonly<{
	value: RuntimeMethod;
}>;

const HOST_LOAD_SUPERSEDED = "superseded" as const;

type LocatedMethod = Readonly<{
	name: GuardedMethodName;
	descriptor: RuntimeMethodDescriptor;
	hadOwn: boolean;
}>;

type InFlightLoad = {
	id: number;
	ticket: ManagedHostSwitchTicket;
	targetPathAtEntry: string;
	ambiguous: boolean;
	clearObserved: boolean;
	superseded: boolean;
	locallyCommitted: boolean;
	localCommit: Promise<void>;
	resolveLocalCommit: () => void;
	retirement: Promise<void>;
	resolveRetirement: () => void;
	supersession: Promise<typeof HOST_LOAD_SUPERSEDED>;
	resolveSupersession: (outcome: typeof HOST_LOAD_SUPERSEDED) => void;
};

type DeferredHostLoadAdmission = {
	ownerId: number;
	epoch: number;
	targetFile: TFile;
	targetPathAtEntry: string;
	sourceRetirement: SourceUnloadRecord;
	callbacks: TextFileViewHandoffGuardCallbacks;
	viewFileAtEntry: TFile | null;
	viewPathAtEntry: string | null;
	cancelled: boolean;
	supersession: Promise<typeof HOST_LOAD_SUPERSEDED>;
	resolveSupersession: (outcome: typeof HOST_LOAD_SUPERSEDED) => void;
};

type PendingSourceUnloadDrain = {
	ownerId: number;
	sourceFile: TFile;
	sourcePathAtEntry: string;
	callbacks: TextFileViewHandoffGuardCallbacks;
	viewFileAtEntry: TFile;
	viewPathAtEntry: string;
	nativeLoadEpochAtEntry: number;
	pendingLoadEpochAtEntry: number;
	saveEpochAtEntry: number;
	preexistingSaveTails: readonly InFlightSave[];
	expectedSaveEpochAfterDrain: number;
	managedClearTombstoneEpochAtEntry: number;
	sourceUnloadAtEntry: SourceUnloadRecord | null;
	activeUnprovenTargetUnloadAtEntry: UnprovenTargetUnload | null;
	modeAtEntry: InternalMode;
	deadlineExpired: boolean;
	deadlineTimer: ReturnType<typeof setTimeout> | null;
	cancellation: Promise<never>;
	rejectCancellation: (reason: unknown) => void;
};

type InFlightSave = {
	id: number;
	file: TFile | null;
	path: string | null;
	startedAt: number;
	settlement: Promise<void>;
	resolveSettlement: () => void;
	settled: boolean;
};

type SourceUnloadRecord = {
	receiptId: string;
	unloadId: number;
	file: TFile;
	path: string;
	sourceContent: string | null;
	state: ManagedSourceUnloadSnapshot["state"];
	cleanRefresh: boolean;
	forcedSaveObserved: boolean;
	forcedSaveFile: TFile | null;
	forcedSavePath: string | null;
	forcedSaveContent: string | null;
	cacheRetiredBeforeUnloadSettled: boolean;
	inputObservedBeforeSettlement: boolean;
	consumed: boolean;
	unprovenTargetRolloverProof: UnprovenTargetRolloverProof | null;
};

type UnprovenTargetRolloverProof = Readonly<{
	ticket: ManagedHostSwitchTicket;
	candidate: PendingHostLoadCandidate;
}>;

type SourceRetirementRolloverEvidence =
	| Readonly<{ kind: "source-presentation" }>
	| Readonly<{
		kind: "held-target";
		proof: UnprovenTargetRolloverProof;
	}>;

type UnprovenTargetUnload = Readonly<{
	load: InFlightLoad | null;
	ticket: ManagedHostSwitchTicket;
	heldCandidate: PendingHostLoadCandidate | null;
	file: TFile;
	path: string;
	retiredSource: SourceUnloadRecord | null;
}>;

type HostLoadAssociation = {
	loadId: number;
	ticket: ManagedHostSwitchTicket;
	targetPathAtEntry: string;
	hostLoadTokenId: string;
	incomingContent: string;
	loadStatus: "pending" | "fulfilled" | "local-committed";
	candidate: PendingHostLoadCandidate | null;
	pendingReceipt: HostLoadCompletionReceipt | null;
	completionForwarded: boolean;
	dispatchAmbiguous: boolean;
};

type ManagedClearTombstone = Readonly<{
	targetFile: TFile;
	targetPath: string;
}>;

type BlockingState = Readonly<{
	kind: "blocking-handoff";
	handoffGeneration: number;
	sourceLineagePath: string | null;
	targetPath: string;
	ticket: ManagedHostSwitchTicket | null;
}>;

type InternalMode =
	| Readonly<{ kind: "pass-through" }>
	| Readonly<{ kind: "inert-pass-through" }>
	| BlockingState;

type CancellableFunction = RuntimeMethod & Readonly<{
	cancel: (...args: unknown[]) => unknown;
	run?: (...args: unknown[]) => unknown;
	flush?: (...args: unknown[]) => unknown;
}>;

type InstalledGuardRegistryEntry = Readonly<{
	guard: TextFileViewHandoffGuard;
	wrappers: ReadonlyMap<GuardedMethodName, RuntimeMethod>;
	delegationFrames: Map<DelegationLane, DelegationFrame[]>;
	suppressRetiredSaveTail: () => void;
}>;

type DelegationFrame = {
	state: "open" | "claimed" | "revoked";
};

type RegisteredReplacement =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "inert" }>
	| Readonly<{ kind: "tail" }>
	| Readonly<{ kind: "route"; wrapper: RuntimeMethod }>;

const installedGuards = new WeakMap<object, InstalledGuardRegistryEntry>();
const OWNED_SCHEDULER_WITH_UNLOAD_FLUSH_HOSTS = new Set(["1.8.4", "1.13.4"]);
const DEFAULT_REQUEST_SAVE_DELAY_MS = 2_000;
const DEFAULT_SOURCE_UNLOAD_DRAIN_DEADLINE_MS = 10_000;
const MAX_SOURCE_UNLOAD_RECERTIFICATION_SAVES = 3;
let nextHostGuardInstanceId = 1;
const editorHandoffHostQaBarrierByView = EDITOR_HANDOFF_QA_ENABLED
	? new WeakMap<object, EditorHandoffHostQaBarrier>()
	: null;

export function associateEditorHandoffHostQaBarrier(
	view: TextFileView,
	guard: TextFileViewHandoffGuard,
	barrier: EditorHandoffHostQaBarrier,
): void {
	if (!EDITOR_HANDOFF_QA_ENABLED) return;
	if (installedGuards.get(view)?.guard !== guard) return;
	editorHandoffHostQaBarrierByView?.set(view, barrier);
}

function isSaveDelegationLane(lane: DelegationLane): lane is SaveDelegationLane {
	return lane === "requestSave"
		|| lane === "requestSave.run"
		|| lane === "requestSave.flush"
		|| lane === "save";
}

function writeBooleanHostDirty(view: TextFileView, value: boolean): boolean {
	try {
		if (typeof Reflect.get(view, "dirty") !== "boolean") return false;
		if (!Reflect.set(view, "dirty", value)) return false;
		return Reflect.get(view, "dirty") === value;
	} catch {
		return false;
	}
}

function locateMethod(view: TextFileView, name: GuardedMethodName): LocatedMethod | null {
	let owner: object | null = view;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, name);
		if (descriptor !== undefined) {
			if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
			return {
				name,
				descriptor: descriptor as RuntimeMethodDescriptor,
				hadOwn: owner === view,
			};
		}
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return null;
}

function canInstallMethod(view: TextFileView, method: LocatedMethod): boolean {
	if (!method.hadOwn) return Object.isExtensible(view);
	return method.descriptor.configurable === true || method.descriptor.writable === true;
}

function installedDescriptor(method: LocatedMethod, wrapper: RuntimeMethod): PropertyDescriptor {
	if (method.hadOwn) return { ...method.descriptor, value: wrapper };
	return {
		configurable: true,
		enumerable: method.descriptor.enumerable ?? false,
		writable: true,
		value: wrapper,
	};
}

function isCancellable(method: RuntimeMethod): method is CancellableFunction {
	return typeof (method as RuntimeMethod & { cancel?: unknown }).cancel === "function";
}

function currentFileOf(view: TextFileView): TFile | null {
	return view.file;
}

function leafIdOf(view: TextFileView): string {
	const candidate = view as TextFileView & { leaf?: { id?: unknown } };
	return typeof candidate.leaf?.id === "string" ? candidate.leaf.id : "";
}

function publicMode(mode: InternalMode): ManagedViewSaveGuardMode {
	switch (mode.kind) {
		case "pass-through":
			return { kind: "pass-through" };
		case "inert-pass-through":
			return { kind: "inert-pass-through" };
		case "blocking-handoff":
			return {
				kind: "blocking-handoff",
				handoffGeneration: mode.handoffGeneration,
				sourceLineagePath: mode.sourceLineagePath,
				targetPath: mode.targetPath,
			};
	}
}

export function installTextFileViewHandoffGuard(
	view: TextFileView,
	callbacks: TextFileViewHandoffGuardCallbacks,
	options: TextFileViewHandoffGuardInstallOptions,
): TextFileViewHandoffGuardInstallResult {
	const existing = installedGuards.get(view);
	if (existing !== undefined) return { kind: "installed", guard: existing.guard };
	if (!OWNED_SCHEDULER_WITH_UNLOAD_FLUSH_HOSTS.has(options.hostApiVersion)) {
		return { kind: "unsupported", reason: "unsupported-host-adapter" };
	}

	const requestSave = locateMethod(view, "requestSave");
	if (requestSave === null) {
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}
	const onUnloadFile = locateMethod(view, "onUnloadFile");
	if (onUnloadFile === null || !canInstallMethod(view, onUnloadFile)) {
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}
	const hostCapability: TextFileViewHostCapability =
		isCancellable(requestSave.descriptor.value)
			? "public-cancellable"
			: "owned-scheduler-with-unload-flush";
	const requestSaveDelayMs = options.requestSaveDelayMs ?? DEFAULT_REQUEST_SAVE_DELAY_MS;
	if (!Number.isSafeInteger(requestSaveDelayMs) || requestSaveDelayMs < 0) {
		return { kind: "unsupported", reason: "unsupported-host-adapter" };
	}
	const sourceUnloadDrainDeadlineMs = options.sourceUnloadDrainDeadlineMs
		?? DEFAULT_SOURCE_UNLOAD_DRAIN_DEADLINE_MS;
	if (
		!Number.isSafeInteger(sourceUnloadDrainDeadlineMs)
		|| sourceUnloadDrainDeadlineMs < 1
	) return { kind: "unsupported", reason: "unsupported-host-adapter" };
	const methods = new Map<GuardedMethodName, LocatedMethod>();
	for (const name of [
		"onUnloadFile",
		"onLoadFile",
		"setViewData",
		"requestSave",
		"save",
	] as const) {
		const method = name === "requestSave"
			? requestSave
			: name === "onUnloadFile"
				? onUnloadFile
				: locateMethod(view, name);
		if (method === null || !canInstallMethod(view, method)) {
			return { kind: "unsupported", reason: "method-not-wrappable" };
		}
		methods.set(name, method);
	}
	const setViewData = methods.get("setViewData");
	if (setViewData === undefined || setViewData.descriptor.value.length < 2) {
		return { kind: "unsupported", reason: "clear-load-not-observable" };
	}

	const onLoadFile = methods.get("onLoadFile");
	const installedOnUnloadMethod = methods.get("onUnloadFile");
	const save = methods.get("save");
	if (installedOnUnloadMethod === undefined || onLoadFile === undefined || save === undefined) {
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}
	let initialDirty: unknown;
	try {
		initialDirty = Reflect.get(view, "dirty");
	} catch {
		return { kind: "unsupported", reason: "unsupported-host-adapter" };
	}
	if (typeof initialDirty !== "boolean" || !writeBooleanHostDirty(view, initialDirty)) {
		return { kind: "unsupported", reason: "unsupported-host-adapter" };
	}

	const originalOnUnloadFile = installedOnUnloadMethod.descriptor.value;
	const originalOnLoadFile = onLoadFile.descriptor.value;
	const originalSetViewData = setViewData.descriptor.value;
	const originalRequestSave = requestSave.descriptor.value;
	const originalCancellableRequestSave = isCancellable(originalRequestSave)
		? originalRequestSave
		: null;
	const originalSave = save.descriptor.value;
	let callbackRef: TextFileViewHandoffGuardCallbacks | null = callbacks;
	let mode: InternalMode = { kind: "pass-through" };
	let nextLoadId = 1;
	let nextSaveId = 1;
	let nextOwnedSaveJobId = 1;
	let nextSourceUnloadId = 1;
	let nextPendingLoadOwnerId = 1;
	let nextSourceUnloadDrainOwnerId = 1;
	let nextTerminalHostLifecycleOwnerId = 1;
	let pendingLoadEpoch = 0;
	let nativeLoadEpoch = 0;
	let managedClearTombstoneEpoch = 0;
	const hostGuardInstanceId = nextHostGuardInstanceId++;
	let saveEpoch = 0;
	let hostCapabilityState: "ready" | "lost" = "ready";
	let pendingOwnedSave: ManagedOwnedSaveJobSnapshot | null = null;
	let ownedSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let sourceUnload: SourceUnloadRecord | null = null;
	let sourceUnloadExpiryTimer: ReturnType<typeof setTimeout> | null = null;
	let activeUnprovenTargetUnload: UnprovenTargetUnload | null = null;
	const inFlightLoads = new Map<number, InFlightLoad>();
	const hostLoadAssociations = new Map<string, HostLoadAssociation>();
	let activeHostLoadDispatch: HostLoadAssociation | null = null;
	let managedClearTombstone: ManagedClearTombstone | null = null;
	let pendingSourceUnloadDrain: PendingSourceUnloadDrain | null = null;
	let pendingDeferredLoadAdmission: DeferredHostLoadAdmission | null = null;
	let activeNativeLoadInvocation: InFlightLoad | null = null;
	let terminalHostLifecycle: {
		ownerId: number;
		promise: Promise<void>;
		reject(reason: unknown): void;
		settled: boolean;
	} | null = null;
	const emergencySaveFenceOwners = new Set<object>();
	let emergencySaveFenceUnprovable = false;
	const inFlightSaves = new Map<number, InFlightSave>();
	const qaHeldLoadSettlements = EDITOR_HANDOFF_QA_ENABLED
		? new Map<number, Promise<"applied" | "rejected">>()
		: null;
	let latestLoad: InFlightLoad | null = null;
	let clearLoadCapability: "observable" | "clear-load-not-observable" = "observable";

	function advancePendingLoadEpoch(): void {
		if (pendingLoadEpoch < Number.MAX_SAFE_INTEGER) pendingLoadEpoch += 1;
	}

	function advanceNativeLoadEpoch(): void {
		if (nativeLoadEpoch < Number.MAX_SAFE_INTEGER) nativeLoadEpoch += 1;
	}

	function advanceManagedClearTombstoneEpoch(): void {
		if (managedClearTombstoneEpoch < Number.MAX_SAFE_INTEGER) {
			managedClearTombstoneEpoch += 1;
		}
	}

	function retainManagedClearTombstone(association: HostLoadAssociation): void {
		advanceNativeLoadEpoch();
		managedClearTombstone = Object.freeze({
			targetFile: association.ticket.targetFile,
			targetPath: association.targetPathAtEntry,
		});
		advanceManagedClearTombstoneEpoch();
	}

	function clearManagedClearTombstone(): void {
		if (managedClearTombstone === null) return;
		managedClearTombstone = null;
		advanceNativeLoadEpoch();
		advanceManagedClearTombstoneEpoch();
	}

	function nativeHostLoadIsAmbiguous(): boolean {
		return clearLoadCapability !== "observable"
			|| [...inFlightLoads.values()].some((load) => load.ambiguous)
			|| hostLoadAssociations.size > 1
			|| [...hostLoadAssociations.values()].some(
				(association) => association.dispatchAmbiguous,
			);
	}

	function exactPendingViewFile(
		targetFile: TFile,
		targetPath: string,
		viewFileAtEntry: TFile | null,
		viewPathAtEntry: string | null,
	): boolean {
		const current = currentFileOf(view);
		return targetFile.path === targetPath
			&& targetPath.length > 0
			&& current === viewFileAtEntry
			&& (current?.path ?? null) === viewPathAtEntry;
	}

	function guardedHostLoadCancellation(reason: string): Error {
		return new Error(`KAOS guarded host load cancelled: ${reason}`);
	}

	function rejectGuardedHostLoad(reason: string): Promise<never> {
		const rejected = Promise.reject(guardedHostLoadCancellation(reason));
		void rejected.catch(() => undefined);
		return rejected;
	}

	function isTicketCurrent(ticket: ManagedHostSwitchTicket): boolean {
		return callbackRef !== null
			&& callbackRef.isSessionCurrent(ticket.sessionId, ticket.handoffGeneration);
	}

	function invalidateAssociationsForLoad(loadId: number): void {
		for (const association of hostLoadAssociations.values()) {
			if (association.loadId === loadId) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				advanceNativeLoadEpoch();
			}
		}
	}

	function markLoadAmbiguous(load: InFlightLoad): void {
		if (!load.ambiguous) {
			load.ambiguous = true;
			advanceNativeLoadEpoch();
		}
		invalidateAssociationsForLoad(load.id);
		if (
			mode.kind === "blocking-handoff"
			&& mode.ticket === load.ticket
		) mode = { ...mode, ticket: null };
	}

	function supersedeManagedLoad(load: InFlightLoad): void {
		if (load.superseded) return;
		load.superseded = true;
		advanceNativeLoadEpoch();
		invalidateAssociationsForLoad(load.id);
		if (latestLoad === load) latestLoad = null;
		if (mode.kind === "blocking-handoff" && mode.ticket === load.ticket) {
			mode = { ...mode, ticket: null };
		}
		load.resolveSupersession(HOST_LOAD_SUPERSEDED);
	}

	function exactLoadForSetViewData(): InFlightLoad | null {
		if (clearLoadCapability !== "observable") return null;
		const activeLoads = activeManagedLoads();
		if (activeLoads.length !== 1) return null;
		const load = activeLoads[0];
		if (load === undefined || load.ambiguous) return null;
		if (
			inFlightLoads.size !== activeLoads.length
			&& activeNativeLoadInvocation !== load
		) return null;
		if (!load.clearObserved) {
			load.clearObserved = true;
			advanceNativeLoadEpoch();
		}
		return isTicketCurrent(load.ticket)
			&& view.file === load.ticket.targetFile
			&& view.file.path === load.targetPathAtEntry
			? load
			: null;
	}

	function exactLoadForQaHold(): InFlightLoad | null {
		const activeLoads = activeManagedLoads();
		if (
			!EDITOR_HANDOFF_QA_ENABLED
			|| clearLoadCapability !== "observable"
			|| activeLoads.length !== 1
		) return null;
		const load = activeLoads[0];
		return load !== undefined
			&& !load.ambiguous
			&& !load.clearObserved
			&& isTicketCurrent(load.ticket)
			&& view.file === load.ticket.targetFile
			&& view.file.path === load.targetPathAtEntry
			? load
			: null;
	}

	function associationIsCurrent(association: HostLoadAssociation): boolean {
		return callbackRef !== null
			&& callbackRef.isSessionCurrent(
				association.ticket.sessionId,
				association.ticket.handoffGeneration,
			)
			&& view.file === association.ticket.targetFile
			&& view.file.path === association.targetPathAtEntry;
	}

	function receiptMatchesAssociation(
		association: HostLoadAssociation,
		receipt: HostLoadCompletionReceipt,
	): boolean {
		const candidate = association.candidate;
		return candidate !== null
			&& receipt.hostLoadTokenId === association.hostLoadTokenId
			&& receipt.sessionId === association.ticket.sessionId
			&& receipt.handoffGeneration === association.ticket.handoffGeneration
			&& receipt.switchIntentSeq === association.ticket.switchIntentSeq
			&& receipt.leafId === candidate.leafId
			&& receipt.targetPath === association.targetPathAtEntry
			&& receipt.effectFingerprint === candidate.effectFingerprint;
	}

	function forwardLocallyCommittedCompletion(association: HostLoadAssociation): boolean {
		if (
			association.loadStatus !== "local-committed"
			|| association.pendingReceipt === null
			|| association.completionForwarded
			|| callbackRef === null
			|| !associationIsCurrent(association)
		) return false;
		association.completionForwarded = true;
		advanceNativeLoadEpoch();
		try {
			callbackRef.onHostLoadCompleted(association.pendingReceipt);
			return true;
		} catch {
			association.dispatchAmbiguous = true;
			advanceNativeLoadEpoch();
			return false;
		}
	}

	function settleLoad(loadId: number | null, fulfilled: boolean): void {
		if (loadId === null) return;
		if (EDITOR_HANDOFF_QA_ENABLED) {
			const heldSettlement = qaHeldLoadSettlements?.get(loadId);
			if (heldSettlement) {
				qaHeldLoadSettlements?.delete(loadId);
				void heldSettlement.then(
					(outcome) => settleLoad(loadId, fulfilled && outcome === "applied"),
					() => settleLoad(loadId, false),
				);
				return;
			}
		}
		const load = inFlightLoads.get(loadId);
		if (load === undefined) return;
		const rejectedAfterCandidate = !fulfilled
			&& [...hostLoadAssociations.values()].some(
				(association) => association.loadId === loadId
					&& association.loadStatus !== "local-committed"
					&& (association.candidate !== null || association.pendingReceipt !== null),
			);
		inFlightLoads.delete(loadId);
		advanceNativeLoadEpoch();
		if (!fulfilled && !load.superseded) markLoadAmbiguous(load);
		if (
			fulfilled
			&& !load.clearObserved
		) {
			if (load.superseded) {
				void enterHostLoadMutationTerminal(
					"superseded-host-load-tail-unobservable",
				);
			} else if (isTicketCurrent(load.ticket)) {
				void enterHostLoadMutationTerminal("host-load-clear-not-observed");
			}
		}
		for (const association of hostLoadAssociations.values()) {
			if (association.loadId !== loadId) continue;
			if (!fulfilled || load.superseded || !associationIsCurrent(association)) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				advanceNativeLoadEpoch();
				continue;
			}
			if (association.loadStatus !== "pending") continue;
			association.loadStatus = "fulfilled";
			advanceNativeLoadEpoch();
		}
		if (rejectedAfterCandidate && !load.superseded) {
			void enterHostLoadMutationTerminal("host-native-load-rejected-after-candidate");
		}
	}

	function reportSuppressed(invocationFile: TFile | null): void {
		if (mode.kind !== "blocking-handoff" || mode.ticket === null || callbackRef === null) return;
		if (!isTicketCurrent(mode.ticket)) return;
		callbackRef.onSaveSuppressed({
			sessionId: mode.ticket.sessionId,
			handoffGeneration: mode.handoffGeneration,
			invocationFile,
			invocationPath: invocationFile?.path ?? null,
		});
	}

	function terminalSaveSuppressionActive(): boolean {
		return callbackRef !== null
			&& (terminalHostLifecycle !== null || hostCapabilityState === "lost");
	}

	function clearSourceUnloadExpiry(): void {
		if (sourceUnloadExpiryTimer !== null) clearTimeout(sourceUnloadExpiryTimer);
		sourceUnloadExpiryTimer = null;
	}

	function currentViewContent(): string | null {
		try {
			const content = view.getViewData();
			return typeof content === "string" ? content : null;
		} catch {
			return null;
		}
	}

	function sourceUnloadDrainIsCurrent(owner: PendingSourceUnloadDrain): boolean {
		return pendingSourceUnloadDrain === owner
			&& callbackRef === owner.callbacks
			&& terminalHostLifecycle === null
			&& hostCapabilityState === "ready"
			&& saveWrappersCurrent()
			&& loadWrappersCurrent()
			&& currentFileOf(view) === owner.viewFileAtEntry
			&& owner.viewFileAtEntry === owner.sourceFile
			&& owner.sourceFile.path === owner.sourcePathAtEntry
			&& owner.viewPathAtEntry === owner.sourcePathAtEntry
			&& nativeLoadEpoch === owner.nativeLoadEpochAtEntry
			&& pendingLoadEpoch === owner.pendingLoadEpochAtEntry
			&& saveEpoch === owner.expectedSaveEpochAfterDrain
			&& inFlightSaves.size === 0
			&& owner.preexistingSaveTails.every((tail) =>
				tail.settled && inFlightSaves.get(tail.id) !== tail
			)
			&& managedClearTombstoneEpoch
				=== owner.managedClearTombstoneEpochAtEntry
			&& sourceUnload === owner.sourceUnloadAtEntry
			&& activeUnprovenTargetUnload
				=== owner.activeUnprovenTargetUnloadAtEntry
			&& mode === owner.modeAtEntry;
	}

	function sourceUnloadDrainObservableStateIsExact(
		owner: PendingSourceUnloadDrain,
	): boolean {
		// We intentionally do not proxy mutable host/TFile properties. A direct
		// A -> B -> A mutation with no guarded call is outside the observable host
		// boundary; every guarded save/load/set entry recertifies the exact owner.
		try {
			return pendingSourceUnloadDrain === owner
				&& callbackRef === owner.callbacks
				&& terminalHostLifecycle === null
				&& hostCapabilityState === "ready"
				&& saveWrappersCurrent()
				&& loadWrappersCurrent()
				&& currentFileOf(view) === owner.viewFileAtEntry
				&& owner.viewFileAtEntry === owner.sourceFile
				&& owner.sourceFile.path === owner.sourcePathAtEntry
				&& owner.viewPathAtEntry === owner.sourcePathAtEntry
				&& nativeLoadEpoch === owner.nativeLoadEpochAtEntry
				&& pendingLoadEpoch === owner.pendingLoadEpochAtEntry
				&& managedClearTombstoneEpoch
					=== owner.managedClearTombstoneEpochAtEntry
				&& sourceUnload === owner.sourceUnloadAtEntry
				&& activeUnprovenTargetUnload
					=== owner.activeUnprovenTargetUnloadAtEntry
				&& mode === owner.modeAtEntry;
		} catch {
			return false;
		}
	}

	function sourceUnloadDrainObservedDrift(): boolean {
		const owner = pendingSourceUnloadDrain;
		if (owner === null || sourceUnloadDrainObservableStateIsExact(owner)) return false;
		void enterHostLoadMutationTerminal("source-unload-drain-observable-drift");
		return true;
	}

	function clearSourceUnloadDrainDeadline(owner: PendingSourceUnloadDrain): void {
		if (owner.deadlineTimer !== null) clearTimeout(owner.deadlineTimer);
		owner.deadlineTimer = null;
	}

	function clearSourceUnloadDrain(owner: PendingSourceUnloadDrain): void {
		clearSourceUnloadDrainDeadline(owner);
		if (pendingSourceUnloadDrain === owner) pendingSourceUnloadDrain = null;
	}

	function armSourceUnloadDrainDeadline(owner: PendingSourceUnloadDrain): void {
		if (owner.deadlineTimer !== null || owner.deadlineExpired) return;
		owner.deadlineTimer = setTimeout(() => {
			owner.deadlineTimer = null;
			if (pendingSourceUnloadDrain !== owner || owner.deadlineExpired) return;
			owner.deadlineExpired = true;
			owner.rejectCancellation(
				guardedHostLoadCancellation("source-unload-drain-deadline-exceeded"),
			);
		}, sourceUnloadDrainDeadlineMs);
	}

	function isSourceCacheRetired(): boolean {
		const host = view as TextFileView & { lastSavedData?: unknown };
		return view.data === "" && host.lastSavedData === null;
	}

	function sourcePresentationMatchesRetirement(record: SourceUnloadRecord): boolean {
		return isSourceCacheRetired() || currentViewContent() === record.sourceContent;
	}

	function cleanRefreshPresentationIsExact(record: SourceUnloadRecord): boolean {
		if (!record.cleanRefresh || record.sourceContent === null) return false;
		try {
			const host = view as TextFileView & {
				dirty?: unknown;
				lastSavedData?: unknown;
			};
			return currentFileOf(view) === record.file
				&& record.file.path === record.path
				&& currentViewContent() === record.sourceContent
				&& view.data === record.sourceContent
				&& host.lastSavedData === record.sourceContent
				&& host.dirty === false;
		} catch {
			return false;
		}
	}

	function sourceRetirementProofIsExact(record: SourceUnloadRecord): boolean {
		if (record.sourceContent === null || record.file.path !== record.path) return false;
		if (record.cleanRefresh) {
			return !record.forcedSaveObserved
				&& record.forcedSaveFile === null
				&& record.forcedSavePath === null
				&& record.forcedSaveContent === null
				&& !record.inputObservedBeforeSettlement;
		}
		return record.forcedSaveObserved
			&& record.forcedSaveFile === record.file
			&& record.forcedSavePath === record.path
			&& record.forcedSaveContent === record.sourceContent;
	}

	function armSourceUnloadExpiry(record: SourceUnloadRecord): void {
		clearSourceUnloadExpiry();
		sourceUnloadExpiryTimer = setTimeout(() => {
			sourceUnloadExpiryTimer = null;
			if (sourceUnload !== record || record.state !== "settled" || record.consumed) return;
			record.state = "atomic-window-expired";
			record.consumed = true;
		}, 0);
	}

	function sourceUnloadBlocksOrdinarySave(invocationFile: TFile | null): boolean {
		if (pendingSourceUnloadDrain !== null) return true;
		if (activeUnprovenTargetUnload !== null) return true;
		// Host selection may already expose B or C while the editor-side admission
		// for that target is still settling. The pending epoch, rather than
		// view.file, owns this interval, so no ordinary save may cross it.
		if (pendingDeferredLoadAdmission !== null) return true;
		const record = sourceUnload;
		if (record === null) return false;
		if (record.state === "saving") return true;
		if (record.state === "settled" && !record.consumed) return true;
		return record.forcedSaveObserved
			&& invocationFile === record.file
			&& invocationFile.path === record.path
			&& isSourceCacheRetired();
	}

	function rejectSourceUnload(record: SourceUnloadRecord): void {
		if (record.state === "atomic-window-expired") return;
		record.state = "rejected";
		record.consumed = true;
		if (sourceUnload === record) clearSourceUnloadExpiry();
	}

	function activeManagedLoads(): InFlightLoad[] {
		return [...inFlightLoads.values()].filter((load) => !load.superseded);
	}

	function supersedePendingAdmission(owner: DeferredHostLoadAdmission): void {
		if (owner.cancelled) return;
		owner.cancelled = true;
		if (pendingDeferredLoadAdmission === owner) {
			pendingDeferredLoadAdmission = null;
			advancePendingLoadEpoch();
		}
		owner.resolveSupersession(HOST_LOAD_SUPERSEDED);
	}

	function rollPendingSourceRetirement(
		owner: DeferredHostLoadAdmission,
		latestTargetFile: TFile,
	): SourceUnloadRecord | null {
		const record = owner.sourceRetirement;
		const activeCallbacks = callbackRef;
		const targetPath = latestTargetFile.path;
		const exactOwnerRemains = (): boolean =>
			pendingDeferredLoadAdmission === owner
			&& !owner.cancelled
			&& owner.callbacks === activeCallbacks
			&& activeCallbacks !== null
			&& callbackRef === activeCallbacks
			&& clearLoadCapability === "observable"
			&& hostCapabilityState === "ready"
			&& terminalHostLifecycle === null
			&& sourceUnload === record
			&& retiredSourceReceiptIsExact(record)
			&& activeManagedLoads().length === 0
			&& activeUnprovenTargetUnload === null
			&& latestTargetFile.path === targetPath
			&& targetPath.length > 0;
		const sourceStillPresented = (): boolean =>
			exactOwnerRemains()
			&& sourcePresentationMatchesRetirement(record)
			&& exactOwnerRemains();
		if (!sourceStillPresented() || !sourceStillPresented()) return null;
		const unloadId = nextSourceUnloadId++;
		const rollover: SourceUnloadRecord = {
			receiptId: `source-unload:${hostGuardInstanceId}:${unloadId}`,
			unloadId,
			file: record.file,
			path: record.path,
			sourceContent: record.sourceContent,
			state: "settled",
			cleanRefresh: record.cleanRefresh,
			forcedSaveObserved: record.forcedSaveObserved,
			forcedSaveFile: record.forcedSaveFile,
			forcedSavePath: record.forcedSavePath,
			forcedSaveContent: record.forcedSaveContent,
			cacheRetiredBeforeUnloadSettled: record.cacheRetiredBeforeUnloadSettled,
			inputObservedBeforeSettlement: record.inputObservedBeforeSettlement,
			consumed: false,
			unprovenTargetRolloverProof: null,
		};
		if (!exactOwnerRemains()) return null;
		rejectSourceUnload(record);
		supersedePendingAdmission(owner);
		sourceUnload = rollover;
		armSourceUnloadExpiry(rollover);
		return rollover;
	}

	function rollConsumedSourceRetirement(
		record: SourceUnloadRecord,
		latestTargetFile: TFile,
	): SourceUnloadRecord | null {
		const previousLoad = latestLoad;
		const activeCallbacks = callbackRef;
		const targetPath = latestTargetFile.path;
		const exactOwnerRemains = (): boolean => {
			const activeLoads = activeManagedLoads();
			return previousLoad !== null
				&& activeLoads.length === 1
				&& activeLoads[0] === previousLoad
				&& !previousLoad.ambiguous
				&& previousLoad.ticket.sourceUnloadReceiptId === record.receiptId
				&& activeCallbacks !== null
				&& callbackRef === activeCallbacks
				&& clearLoadCapability === "observable"
				&& hostCapabilityState === "ready"
				&& terminalHostLifecycle === null
				&& sourceUnload === record
				&& retiredSourceReceiptIsExact(record)
				&& activeUnprovenTargetUnload === null
				&& latestTargetFile.path === targetPath
				&& targetPath.length > 0;
		};
		const captureEvidence = (): SourceRetirementRolloverEvidence | null => {
			if (!exactOwnerRemains()) return null;
			if (sourcePresentationMatchesRetirement(record)) {
				return exactOwnerRemains()
					? Object.freeze({ kind: "source-presentation" })
					: null;
			}
			if (previousLoad === null) return null;
			const candidate = exactHeldCandidateForTicket(previousLoad.ticket);
			if (candidate === null) return null;
			const proof = Object.freeze({ ticket: previousLoad.ticket, candidate });
			return exactUnprovenTargetRolloverPresentation(
				proof,
				record,
				latestTargetFile,
			) && exactOwnerRemains()
				? Object.freeze({ kind: "held-target", proof })
				: null;
		};
		const evidence = captureEvidence();
		const confirmed = captureEvidence();
		if (
			evidence === null
			|| confirmed === null
			|| evidence.kind !== confirmed.kind
			|| (
				evidence.kind === "held-target"
				&& (
					confirmed.kind !== "held-target"
					|| confirmed.proof.ticket !== evidence.proof.ticket
					|| confirmed.proof.candidate !== evidence.proof.candidate
				)
			)
			|| !exactOwnerRemains()
			|| previousLoad === null
		) return null;
		const unloadId = nextSourceUnloadId++;
		const rollover: SourceUnloadRecord = {
			receiptId: `source-unload:${hostGuardInstanceId}:${unloadId}`,
			unloadId,
			file: record.file,
			path: record.path,
			sourceContent: record.sourceContent,
			state: "settled",
			cleanRefresh: record.cleanRefresh,
			forcedSaveObserved: record.forcedSaveObserved,
			forcedSaveFile: record.forcedSaveFile,
			forcedSavePath: record.forcedSavePath,
			forcedSaveContent: record.forcedSaveContent,
			cacheRetiredBeforeUnloadSettled: record.cacheRetiredBeforeUnloadSettled,
			inputObservedBeforeSettlement: record.inputObservedBeforeSettlement,
			consumed: false,
			unprovenTargetRolloverProof: confirmed.kind === "held-target"
				? confirmed.proof
				: null,
		};
		rejectSourceUnload(record);
		supersedeManagedLoad(previousLoad);
		sourceUnload = rollover;
		armSourceUnloadExpiry(rollover);
		return rollover;
	}

	function prepareSameFileRefreshRetirement(targetFile: TFile): SourceUnloadRecord | null {
		const tombstone = managedClearTombstone;
		const activeCallbacks = callbackRef;
		const targetPath = targetFile.path;
		const exactRefreshOwner = (): boolean =>
			tombstone !== null
			&& managedClearTombstone === tombstone
			&& tombstone.targetFile === targetFile
			&& tombstone.targetPath === targetPath
			&& targetPath.length > 0
			&& currentFileOf(view) === targetFile
			&& targetFile.path === targetPath
			&& activeCallbacks !== null
			&& callbackRef === activeCallbacks
			&& hostCapabilityState === "ready"
			&& clearLoadCapability === "observable"
			&& terminalHostLifecycle === null
			&& inFlightLoads.size === 0;
		if (!exactRefreshOwner()) return null;
		const content = currentViewContent();
		if (content === null) return null;
		const cleanRefreshIsExact = (): boolean => {
			if (!exactRefreshOwner()) return false;
			try {
				const host = view as TextFileView & {
					dirty?: unknown;
					lastSavedData?: unknown;
				};
				return currentViewContent() === content
					&& view.data === content
					&& host.lastSavedData === content
					&& host.dirty === false
					&& exactRefreshOwner();
			} catch {
				return false;
			}
		};
		if (!cleanRefreshIsExact() || !cleanRefreshIsExact()) return null;
		const unloadId = nextSourceUnloadId++;
		const refresh: SourceUnloadRecord = {
			receiptId: `source-unload:${hostGuardInstanceId}:${unloadId}`,
			unloadId,
			file: targetFile,
			path: targetPath,
			sourceContent: content,
			state: "settled",
			cleanRefresh: true,
			forcedSaveObserved: false,
			forcedSaveFile: null,
			forcedSavePath: null,
			forcedSaveContent: null,
			cacheRetiredBeforeUnloadSettled: false,
			inputObservedBeforeSettlement: false,
			consumed: false,
			unprovenTargetRolloverProof: null,
		};
		if (!cleanRefreshIsExact()) return null;
		sourceUnload = refresh;
		armSourceUnloadExpiry(refresh);
		return refresh;
	}
	function sourceUnloadProofFailure(record: SourceUnloadRecord): string | null {
		if (record.cleanRefresh) return "unexpected-clean-refresh-save";
		if (record.file.path !== record.path) return "source-path-changed";
		if (record.sourceContent === null) return "source-content-unavailable";
		if (
			currentFileOf(view) !== record.file
			|| currentFileOf(view)?.path !== record.path
		) return "source-selection-changed-before-settlement";
		if (!record.forcedSaveObserved) return "forced-save-not-observed";
		if (record.forcedSaveFile !== record.file) return "forced-save-file-mismatch";
		if (record.forcedSavePath !== record.path) return "forced-save-path-mismatch";
		if (record.forcedSaveContent === null) return "forced-save-content-unavailable";
		if (record.forcedSaveContent !== record.sourceContent) return "forced-save-content-mismatch";
		if (record.inputObservedBeforeSettlement) {
			return "source-input-observed-before-settlement";
		}
		if (!sourcePresentationMatchesRetirement(record)) {
			return "source-content-changed-before-settlement";
		}
		return null;
	}

	async function settleSourceUnload(record: SourceUnloadRecord, fulfilled: boolean): Promise<void> {
		if (sourceUnload !== record || record.state !== "saving") return;
		if (!fulfilled) {
			rejectSourceUnload(record);
			return;
		}
		if (
			callbackRef !== null
			&& (!saveWrappersCurrent() || !loadWrappersCurrent())
		) {
			rejectSourceUnload(record);
			return enterHostWrapperDriftTerminal();
		}
		let proofFailure = sourceUnloadProofFailure(record);
		for (
			let attempt = 0;
			proofFailure === "source-content-changed-before-settlement"
				&& attempt < MAX_SOURCE_UNLOAD_RECERTIFICATION_SAVES;
			attempt += 1
		) {
			const refreshedContent = currentViewContent();
			if (
				currentFileOf(view) !== record.file
				|| record.file.path !== record.path
				|| refreshedContent === null
				|| refreshedContent === record.sourceContent
			) break;
			record.sourceContent = refreshedContent;
			record.forcedSaveObserved = false;
			record.forcedSaveFile = null;
			record.forcedSavePath = null;
			record.forcedSaveContent = null;
			try {
				await Promise.resolve(Reflect.apply(installedSave, view, [true]));
			} catch (error) {
				rejectSourceUnload(record);
				throw error;
			}
			if (sourceUnload !== record || record.state !== "saving") return;
			if (
				callbackRef !== null
				&& (!saveWrappersCurrent() || !loadWrappersCurrent())
			) {
				rejectSourceUnload(record);
				return enterHostWrapperDriftTerminal();
			}
			proofFailure = sourceUnloadProofFailure(record);
		}
		if (proofFailure !== null) {
			rejectSourceUnload(record);
			return enterSourceUnloadProofLostTerminal(
				`source-unload-not-provable:${proofFailure}`,
			);
		}
		if (
			callbackRef !== null
			&& (!saveWrappersCurrent() || !loadWrappersCurrent())
		) {
			rejectSourceUnload(record);
			return enterHostWrapperDriftTerminal();
		}
		record.state = "settled";
		armSourceUnloadExpiry(record);
	}

	function exactHeldCandidateForTicket(
		ticket: ManagedHostSwitchTicket,
	): PendingHostLoadCandidate | null {
		let exactAssociation: HostLoadAssociation | null = null;
		for (const association of hostLoadAssociations.values()) {
			if (association.ticket !== ticket) continue;
			if (exactAssociation !== null) return null;
			exactAssociation = association;
		}
		const association = exactAssociation;
		const candidate = association?.candidate ?? null;
		const activeCallbacks = callbackRef;
		if (
			association === null
			|| candidate === null
			|| activeCallbacks === null
			|| association.loadStatus !== "fulfilled"
			|| association.pendingReceipt !== null
			|| association.dispatchAmbiguous
			|| !associationIsCurrent(association)
			|| candidate.hostLoadCompletedEpoch !== null
			|| candidate.hostSetViewDataClear !== true
			|| candidate.sourceUnloadReceiptId !== ticket.sourceUnloadReceiptId
			|| candidate.sessionId !== ticket.sessionId
			|| candidate.handoffGeneration !== ticket.handoffGeneration
			|| candidate.switchIntentSeq !== ticket.switchIntentSeq
			|| candidate.targetPathAtDispatch !== ticket.targetFile.path
			|| candidate.runtimeView !== view
		) return null;
		let candidateCurrent = false;
		try {
			candidateCurrent = activeCallbacks.isHostLoadCandidateCurrent(candidate);
		} catch {
			candidateCurrent = false;
		}
		return candidateCurrent
			&& callbackRef === activeCallbacks
			&& hostLoadAssociations.get(candidate.hostLoadTokenId) === association
			&& association.candidate === candidate
			&& associationIsCurrent(association)
			? candidate
			: null;
	}

	function exactUnprovenTargetRolloverPresentation(
		proof: UnprovenTargetRolloverProof,
		record: SourceUnloadRecord,
		nextTargetFile: TFile | null,
	): boolean {
		const activeCallbacks = callbackRef;
		const candidate = proof.candidate;
		const ticket = proof.ticket;
		const validate = (): boolean => {
			const currentFile = currentFileOf(view);
			let cmDocument: Text;
			try {
				cmDocument = candidate.cm.state.doc;
			} catch {
				return false;
			}
			return activeCallbacks !== null
				&& callbackRef === activeCallbacks
				&& clearLoadCapability === "observable"
				&& hostCapabilityState === "ready"
				&& mode.kind === "blocking-handoff"
				&& mode.handoffGeneration === ticket.handoffGeneration
				&& mode.targetPath === ticket.targetFile.path
				&& ticket.targetFile.path.length > 0
				&& (currentFile === ticket.targetFile || currentFile === nextTargetFile)
				&& (currentFile === null || currentFile.path.length > 0)
				&& record.sourceContent !== null
				&& candidate.hostLoadCompletedEpoch === null
				&& candidate.hostSetViewDataClear === true
				&& candidate.sourceUnloadReceiptId === ticket.sourceUnloadReceiptId
				&& candidate.sessionId === ticket.sessionId
				&& candidate.handoffGeneration === ticket.handoffGeneration
				&& candidate.switchIntentSeq === ticket.switchIntentSeq
				&& candidate.targetPathAtDispatch === ticket.targetFile.path
				&& candidate.runtimeView === view
				&& (
					candidate.runtimeViewDataBefore === record.sourceContent
					|| (
						record.cacheRetiredBeforeUnloadSettled
						&& candidate.runtimeViewDataBefore === ""
					)
				)
				&& candidate.cm.state.doc === candidate.startDocument
				&& cmDocument === candidate.startDocument
				&& view.data === candidate.runtimeViewDataBefore;
		};
		if (!validate() || activeCallbacks === null) return false;
		let visibleContent: string | null = null;
		let startContent: string | null = null;
		try {
			visibleContent = currentViewContent();
			startContent = candidate.startDocument.toString();
		} catch {
			return false;
		}
		if (
			visibleContent !== candidate.incomingContent
			|| startContent !== record.sourceContent
			|| !validate()
		) return false;
		let candidateCurrent = false;
		try {
			candidateCurrent = activeCallbacks.isHostLoadCandidateCurrent(candidate);
		} catch {
			candidateCurrent = false;
		}
		return candidateCurrent && validate();
	}

	function claimSourceUnloadForLoad(targetFile: TFile): SourceUnloadRecord | null {
		const record = sourceUnload;
		const presentationCurrent = record !== null && (
			sourcePresentationMatchesRetirement(record)
			|| (
				record.unprovenTargetRolloverProof !== null
				&& exactUnprovenTargetRolloverPresentation(
					record.unprovenTargetRolloverProof,
					record,
					targetFile,
				)
			)
		);
		if (
			record === null
			|| sourceUnload !== record
			|| record.state !== "settled"
			|| record.consumed
			|| !sourceRetirementProofIsExact(record)
			|| (record.cleanRefresh && !cleanRefreshPresentationIsExact(record))
			|| !presentationCurrent
		) {
			if (record !== null && record.state !== "atomic-window-expired") {
				rejectSourceUnload(record);
			}
			return null;
		}
		record.consumed = true;
		clearSourceUnloadExpiry();
		return record;
	}

	function exactUnprovenTargetForUnload(
		sourceFile: TFile,
	): Readonly<{
		load: InFlightLoad | null;
		ticket: ManagedHostSwitchTicket;
		heldCandidate: PendingHostLoadCandidate | null;
	}> | null {
		if (
			activeUnprovenTargetUnload !== null
			|| clearLoadCapability !== "observable"
			|| currentFileOf(view) !== sourceFile
			|| sourceFile.path.length === 0
			|| mode.kind !== "blocking-handoff"
			|| mode.ticket === null
			|| mode.ticket.targetFile !== sourceFile
			|| mode.ticket.targetFile.path !== sourceFile.path
			|| mode.targetPath !== sourceFile.path
			|| mode.handoffGeneration !== mode.ticket.handoffGeneration
		) return null;
		if (inFlightLoads.size > 1) return null;
		const load = inFlightLoads.values().next().value as InFlightLoad | undefined;
		if (
			load !== undefined
			&& (
				load.ambiguous
				|| load.ticket !== mode.ticket
				|| load.ticket.targetFile !== sourceFile
				|| load.targetPathAtEntry !== sourceFile.path
			)
		) return null;
		const ticket = mode.ticket;
		const heldCandidate = exactHeldCandidateForTicket(ticket);
		if (
			currentFileOf(view) !== sourceFile
			|| mode.kind !== "blocking-handoff"
			|| mode.ticket !== ticket
			|| mode.handoffGeneration !== ticket.handoffGeneration
			|| mode.targetPath !== sourceFile.path
		) return null;
		return Object.freeze({ load: load ?? null, ticket, heldCandidate });
	}

	function retiredSourceReceiptIsExact(record: SourceUnloadRecord | null): record is SourceUnloadRecord {
		return record !== null
			&& record.state === "settled"
			&& record.consumed
			&& sourceRetirementProofIsExact(record);
	}

	function captureSourceRetirementRolloverEvidence(
		unload: UnprovenTargetUnload,
	): SourceRetirementRolloverEvidence | null {
		const record = unload.retiredSource;
		if (!retiredSourceReceiptIsExact(record)) return null;
		if (sourcePresentationMatchesRetirement(record)) {
			return Object.freeze({ kind: "source-presentation" });
		}
		const candidate = unload.heldCandidate;
		if (candidate === null) return null;
		const proof = Object.freeze({ ticket: unload.ticket, candidate });
		return exactUnprovenTargetRolloverPresentation(proof, record, null)
			? Object.freeze({ kind: "held-target", proof })
			: null;
	}

	function retireUnprovenTarget(unload: UnprovenTargetUnload): void {
		if (unload.load !== null) {
			// Keep the superseded native tail registered until its own promise settles.
			// This is the late-tail fence: C may run synchronously under its own owner,
			// while a later opaque B setViewData cannot be mistaken for C.
			supersedeManagedLoad(unload.load);
		}
		if (latestLoad?.ticket === unload.ticket) latestLoad = null;
		for (const association of hostLoadAssociations.values()) {
			if (association.ticket === unload.ticket) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				advanceNativeLoadEpoch();
			}
		}
		if (mode.kind === "blocking-handoff" && mode.ticket === unload.ticket) {
			mode = { ...mode, ticket: null };
		}
	}

	function rollSourceRetirementAcrossUnprovenTarget(
		unload: UnprovenTargetUnload,
	): boolean {
		const retiredSource = unload.retiredSource;
		const evidence = captureSourceRetirementRolloverEvidence(unload);
		if (
			activeUnprovenTargetUnload !== unload
			|| callbackRef === null
			|| hostCapabilityState !== "ready"
			|| sourceUnload !== retiredSource
			|| currentFileOf(view) !== unload.file
			|| unload.file.path !== unload.path
			|| !retiredSourceReceiptIsExact(retiredSource)
			|| evidence === null
		) return false;
		const confirmedEvidence = captureSourceRetirementRolloverEvidence(unload);
		if (
			activeUnprovenTargetUnload !== unload
			|| callbackRef === null
			|| hostCapabilityState !== "ready"
			|| sourceUnload !== retiredSource
			|| currentFileOf(view) !== unload.file
			|| unload.file.path !== unload.path
			|| confirmedEvidence === null
			|| confirmedEvidence.kind !== evidence.kind
			|| (
				evidence.kind === "held-target"
				&& (
					confirmedEvidence.kind !== "held-target"
					|| confirmedEvidence.proof.ticket !== evidence.proof.ticket
					|| confirmedEvidence.proof.candidate !== evidence.proof.candidate
				)
			)
		) return false;
		const unloadId = nextSourceUnloadId++;
		const rollover: SourceUnloadRecord = {
			receiptId: `source-unload:${hostGuardInstanceId}:${unloadId}`,
			unloadId,
			file: retiredSource.file,
			path: retiredSource.path,
			sourceContent: retiredSource.sourceContent,
			state: "settled",
			cleanRefresh: retiredSource.cleanRefresh,
			forcedSaveObserved: retiredSource.forcedSaveObserved,
			forcedSaveFile: retiredSource.forcedSaveFile,
			forcedSavePath: retiredSource.forcedSavePath,
			forcedSaveContent: retiredSource.forcedSaveContent,
			cacheRetiredBeforeUnloadSettled: retiredSource.cacheRetiredBeforeUnloadSettled,
			inputObservedBeforeSettlement: retiredSource.inputObservedBeforeSettlement,
			consumed: false,
			unprovenTargetRolloverProof: confirmedEvidence.kind === "held-target"
				? confirmedEvidence.proof
				: null,
		};
		sourceUnload = rollover;
		armSourceUnloadExpiry(rollover);
		return true;
	}

	function unloadUnprovenTarget(
		target: Readonly<{
			load: InFlightLoad | null;
			ticket: ManagedHostSwitchTicket;
			heldCandidate: PendingHostLoadCandidate | null;
		}>,
		sourceFile: TFile,
		args: unknown[],
	): Promise<void> {
		const unload: UnprovenTargetUnload = Object.freeze({
			load: target.load,
			ticket: target.ticket,
			heldCandidate: target.heldCandidate,
			file: sourceFile,
			path: sourceFile.path,
			retiredSource: sourceUnload,
		});
		activeUnprovenTargetUnload = unload;
		retireUnprovenTarget(unload);
		let result: Promise<void>;
		try {
			result = withRegisteredDelegation(
				"onUnloadFile",
				installedOnUnloadFile as RuntimeMethod,
				() => originalOnUnloadFile.apply(view, [sourceFile, ...args]) as Promise<void>,
			);
		} catch (error) {
			if (activeUnprovenTargetUnload === unload) activeUnprovenTargetUnload = null;
			throw error;
		}
		return Promise.resolve(result).then(
			() => {
				if (
					callbackRef !== null
					&& (!saveWrappersCurrent() || !loadWrappersCurrent())
				) {
					if (activeUnprovenTargetUnload === unload) activeUnprovenTargetUnload = null;
					return enterHostWrapperDriftTerminal();
				}
				const rolled = rollSourceRetirementAcrossUnprovenTarget(unload);
				if (activeUnprovenTargetUnload === unload) activeUnprovenTargetUnload = null;
				if (!rolled) {
					return enterSourceUnloadProofLostTerminal(
						"source-unload-not-provable:unproven-target-source-lineage",
					);
				}
				unload.load?.resolveRetirement();
				return undefined;
			},
			(error) => {
				if (activeUnprovenTargetUnload === unload) activeUnprovenTargetUnload = null;
				throw error;
			},
		);
	}

	const installedOnUnloadFile = function (
		this: TextFileView,
		sourceFile: TFile,
		...args: unknown[]
	): Promise<void> {
		if (callbackRef === null) {
			const replacement = registeredReplacement(
				"onUnloadFile",
				installedOnUnloadFile as RuntimeMethod,
			);
			if (replacement.kind === "route") {
				return Reflect.apply(
					replacement.wrapper,
					view,
					[sourceFile, ...args],
				) as Promise<void>;
			}
			if (replacement.kind === "inert") return Promise.resolve();
		}
		if (
			callbackRef !== null
			&& (!saveWrappersCurrent() || !loadWrappersCurrent())
		) {
			// If onLoadFile itself was displaced, returning from unload would let the
			// host continue directly into that unguarded target mutation. Enter the
			// same terminal wrapper-drift boundary before original unload or save runs,
			// and keep the host lifecycle pending until this pane is reopened.
			return enterHostWrapperDriftTerminal();
		}
		if (terminalHostLifecycle !== null) return terminalHostLifecycle.promise;
		if (pendingSourceUnloadDrain !== null) {
			return enterHostLoadMutationTerminal("source-unload-drain-reentrant");
		}
		// Retire any already-owned debounce before the drain can wait. Letting that
		// timer fire during the reservation settlement would create save-epoch drift
		// even though the save itself is suppressed.
		cancelOwnedSaveJob();
		if (originalCancellableRequestSave !== null) {
			originalCancellableRequestSave.cancel.call(originalCancellableRequestSave);
		}
		const preexistingSaveTails = Object.freeze([...inFlightSaves.values()]);
		const unprovenTargetAtEntry = preexistingSaveTails.length === 0
			? exactUnprovenTargetForUnload(sourceFile)
			: null;
		if (unprovenTargetAtEntry !== null) {
			// B has host selection identity but never acquired editor presentation or
			// binding authority. Asking the editor manager to drain B would therefore
			// reject with held-missing and strand the pane before C can enter. The host
			// guard already owns the exact B ticket and retired A receipt, so retire B
			// directly while the existing save fence keeps source bytes pinned to A.
			clearSourceUnloadExpiry();
			return unloadUnprovenTarget(unprovenTargetAtEntry, sourceFile, args);
		}
		const continueOriginalUnload = (): Promise<void> => {
		const tombstoneAtUnloadEntry = managedClearTombstone;
		if (
			tombstoneAtUnloadEntry !== null
			&& tombstoneAtUnloadEntry.targetFile === sourceFile
			&& tombstoneAtUnloadEntry.targetPath === sourceFile.path
			&& currentFileOf(view) === sourceFile
			&& managedClearTombstone === tombstoneAtUnloadEntry
		) {
			clearManagedClearTombstone();
		}
		clearSourceUnloadExpiry();
		const unprovenTarget = exactUnprovenTargetForUnload(sourceFile);
		if (unprovenTarget !== null) {
			return unloadUnprovenTarget(unprovenTarget, sourceFile, args);
		}
		if (sourceUnload !== null && sourceUnload.state === "saving") {
			rejectSourceUnload(sourceUnload);
		}
		const unloadId = nextSourceUnloadId++;
		const record: SourceUnloadRecord = {
			receiptId: `source-unload:${hostGuardInstanceId}:${unloadId}`,
			unloadId,
			file: sourceFile,
			path: sourceFile.path,
			sourceContent: sourceFile === currentFileOf(view) ? currentViewContent() : null,
			state: "saving",
			cleanRefresh: false,
			forcedSaveObserved: false,
			forcedSaveFile: null,
			forcedSavePath: null,
			forcedSaveContent: null,
			cacheRetiredBeforeUnloadSettled: false,
			inputObservedBeforeSettlement: false,
			consumed: false,
			unprovenTargetRolloverProof: null,
		};
		sourceUnload = record;
		let result: unknown;
		try {
			result = withRegisteredDelegation(
				"onUnloadFile",
				installedOnUnloadFile as RuntimeMethod,
				() => originalOnUnloadFile.apply(view, [sourceFile, ...args]),
			);
			record.cacheRetiredBeforeUnloadSettled = isSourceCacheRetired();
		} catch (error) {
			rejectSourceUnload(record);
			throw error;
		}
		if (
			result === null
			|| (
				typeof result !== "object"
				&& typeof result !== "function"
			)
		) return settleSourceUnload(record, true);
		let then: unknown;
		try {
			then = (result as { then?: unknown }).then;
		} catch (error) {
			return settleSourceUnload(record, false).then(() => {
				throw error;
			});
		}
		if (typeof then !== "function") return settleSourceUnload(record, true);
		return Promise.resolve(result).then(
			() => {
				if (sourceUnload === record && record.state === "saving") {
					record.cacheRetiredBeforeUnloadSettled =
						record.cacheRetiredBeforeUnloadSettled || isSourceCacheRetired();
				}
				return settleSourceUnload(record, true);
			},
			async (error) => {
				await settleSourceUnload(record, false);
				throw error;
			},
		);
	};
		const activeCallbacks = callbackRef;
		if (activeCallbacks === null) return continueOriginalUnload();
		const viewFileAtEntry = currentFileOf(view);
		if (
			viewFileAtEntry !== sourceFile
			|| sourceFile.path.length === 0
			|| viewFileAtEntry.path !== sourceFile.path
		) return enterHostLoadMutationTerminal("source-unload-drain-file-first");
		let rejectDrainCancellation!: (reason: unknown) => void;
		const drainCancellation = new Promise<never>((_resolve, reject) => {
			rejectDrainCancellation = reject;
		});
		void drainCancellation.catch(() => undefined);
		const drainOwner: PendingSourceUnloadDrain = {
			ownerId: nextSourceUnloadDrainOwnerId++,
			sourceFile,
			sourcePathAtEntry: sourceFile.path,
			callbacks: activeCallbacks,
			viewFileAtEntry,
			viewPathAtEntry: viewFileAtEntry.path,
			nativeLoadEpochAtEntry: nativeLoadEpoch,
			pendingLoadEpochAtEntry: pendingLoadEpoch,
			saveEpochAtEntry: saveEpoch,
			preexistingSaveTails,
			expectedSaveEpochAfterDrain: saveEpoch + preexistingSaveTails.length,
			managedClearTombstoneEpochAtEntry: managedClearTombstoneEpoch,
			sourceUnloadAtEntry: sourceUnload,
			activeUnprovenTargetUnloadAtEntry: activeUnprovenTargetUnload,
			modeAtEntry: mode,
			deadlineExpired: false,
			deadlineTimer: null,
			cancellation: drainCancellation,
			rejectCancellation: rejectDrainCancellation,
		};
		pendingSourceUnloadDrain = drainOwner;
		let drainAdmission: ManagedSourceUnloadDrainAdmission;
		try {
			drainAdmission = activeCallbacks.onUnloadFileEntry(sourceFile);
		} catch {
			clearSourceUnloadDrain(drainOwner);
			return enterHostLoadMutationTerminal("source-unload-drain-threw");
		}
		const continueAfterDrain = (): Promise<void> => {
			if (!sourceUnloadDrainIsCurrent(drainOwner)) {
				clearSourceUnloadDrain(drainOwner);
				return enterHostLoadMutationTerminal("source-unload-drain-cas-drift");
			}
			clearSourceUnloadDrain(drainOwner);
			return continueOriginalUnload();
		};
		const preexistingSaveSettlement = preexistingSaveTails.length === 0
			? null
			: Promise.all(preexistingSaveTails.map((tail) => tail.settlement)).then(
				() => undefined,
			);
		const continueAfterSettlement = (settlement: Promise<void>): Promise<void> => {
			armSourceUnloadDrainDeadline(drainOwner);
			return Promise.race([settlement, drainOwner.cancellation]).then(
				() => continueAfterDrain(),
				(error) => {
					if (pendingSourceUnloadDrain !== drainOwner && callbackRef === null) {
						throw error;
					}
					clearSourceUnloadDrain(drainOwner);
					return enterHostLoadMutationTerminal(drainOwner.deadlineExpired
						? "source-unload-drain-deadline-exceeded"
						: "source-unload-drain-rejected");
				},
			);
		};
		if (drainAdmission === null) {
			return preexistingSaveSettlement === null
				? continueAfterDrain()
				: continueAfterSettlement(preexistingSaveSettlement);
		}
		let drainThen: unknown;
		try {
			drainThen = Reflect.get(drainAdmission, "then");
		} catch {
			clearSourceUnloadDrain(drainOwner);
			return enterHostLoadMutationTerminal("source-unload-drain-unreadable");
		}
		if (typeof drainThen !== "function") {
			clearSourceUnloadDrain(drainOwner);
			return enterHostLoadMutationTerminal("source-unload-drain-not-promise");
		}
		const drainSettlement = new Promise<void>((resolve, reject) => {
			try {
				Reflect.apply(drainThen as (...args: unknown[]) => unknown, drainAdmission, [
					resolve,
					reject,
				]);
			} catch (error) {
				reject(error instanceof Error
					? error
					: guardedHostLoadCancellation("source-unload-drain-rejected"));
			}
		});
		const fullSettlement = preexistingSaveSettlement === null
			? drainSettlement
			: Promise.all([drainSettlement, preexistingSaveSettlement]).then(() => undefined);
		return continueAfterSettlement(fullSettlement);
	};

	const installedOnLoadFile = function (
		this: TextFileView,
		targetFile: TFile,
		...args: unknown[]
	): Promise<void> {
		if (callbackRef === null) {
			const replacement = registeredReplacement(
				"onLoadFile",
				installedOnLoadFile as RuntimeMethod,
			);
			if (replacement.kind === "route") {
				return Reflect.apply(replacement.wrapper, view, [targetFile, ...args]) as Promise<void>;
			}
			if (replacement.kind === "inert") return Promise.resolve();
		}
		if (
			callbackRef !== null
			&& (!saveWrappersCurrent() || !loadWrappersCurrent())
		) return enterHostWrapperDriftTerminal();
		if (terminalHostLifecycle !== null) return terminalHostLifecycle.promise;
		if (pendingSourceUnloadDrain !== null) {
			return enterHostLoadMutationTerminal("host-load-before-source-unload-drain");
		}
		const targetPathAtEntry = targetFile.path;
		const tombstoneAtEntry = managedClearTombstone;
		const priorAdmission = pendingDeferredLoadAdmission;
		let sourceRetirement: SourceUnloadRecord | null = null;
		let sameFileRefresh = false;
		if (
			priorAdmission !== null
			&& tombstoneAtEntry !== null
			&& (
				tombstoneAtEntry.targetFile !== targetFile
				|| tombstoneAtEntry.targetPath !== targetPathAtEntry
			)
		) {
			return enterHostLoadMutationTerminal("host-load-before-exact-unload");
		}
		if (priorAdmission !== null) {
			const rollover = rollPendingSourceRetirement(priorAdmission, targetFile);
			if (rollover === null) {
				return enterSourceUnloadProofLostTerminal(
					"source-unload-not-provable:pending-admission-supersession",
				);
			}
			sourceRetirement = claimSourceUnloadForLoad(targetFile);
			sameFileRefresh = tombstoneAtEntry !== null
				&& tombstoneAtEntry.targetFile === targetFile
				&& tombstoneAtEntry.targetPath === targetPathAtEntry;
		} else if (
			tombstoneAtEntry !== null
			&& tombstoneAtEntry.targetFile === targetFile
			&& tombstoneAtEntry.targetPath === targetPathAtEntry
		) {
			const refresh = prepareSameFileRefreshRetirement(targetFile);
			if (refresh === null) {
				return enterHostLoadMutationTerminal("host-refresh-owner-not-provable");
			}
			sourceRetirement = claimSourceUnloadForLoad(targetFile);
			sameFileRefresh = sourceRetirement === refresh;
		} else if (tombstoneAtEntry !== null) {
			return enterHostLoadMutationTerminal("host-load-before-exact-unload");
		} else {
			const sourceAtEntry = sourceUnload;
			if (
				sourceAtEntry !== null
				&& sourceAtEntry.state === "settled"
				&& sourceAtEntry.consumed
			) {
				const rollover = rollConsumedSourceRetirement(sourceAtEntry, targetFile);
				if (rollover !== null) sourceRetirement = claimSourceUnloadForLoad(targetFile);
			} else {
				sourceRetirement = claimSourceUnloadForLoad(targetFile);
			}
			if (sourceAtEntry !== null && sourceRetirement === null) {
				return enterSourceUnloadProofLostTerminal();
			}
		}
		if (sourceRetirement === null) {
			if (managedClearTombstone !== null) {
				return enterHostLoadMutationTerminal("host-refresh-owner-not-provable");
			}
			return withRegisteredDelegation(
				"onLoadFile",
				installedOnLoadFile as RuntimeMethod,
				() => originalOnLoadFile.apply(view, [targetFile, ...args]) as Promise<void>,
			);
		}
		if (sameFileRefresh) {
			cancelOwnedSaveJob();
			if (originalCancellableRequestSave !== null) {
				originalCancellableRequestSave.cancel.call(originalCancellableRequestSave);
			}
		}
		const activeCallbacks = callbackRef;
		if (
			activeCallbacks === null
			|| clearLoadCapability !== "observable"
			|| hostCapabilityState !== "ready"
		) {
			rejectSourceUnload(sourceRetirement);
			return enterHostLoadMutationTerminal("host-load-admission-unavailable");
		}

		const viewFileAtEntry = currentFileOf(view);
		let resolveAdmissionSupersession!: (
			outcome: typeof HOST_LOAD_SUPERSEDED,
		) => void;
		const admissionSupersession = new Promise<typeof HOST_LOAD_SUPERSEDED>((resolve) => {
			resolveAdmissionSupersession = resolve;
		});
		advancePendingLoadEpoch();
		const admissionOwner: DeferredHostLoadAdmission = {
			ownerId: nextPendingLoadOwnerId++,
			epoch: pendingLoadEpoch,
			targetFile,
			targetPathAtEntry,
			sourceRetirement,
			callbacks: activeCallbacks,
			viewFileAtEntry,
			viewPathAtEntry: viewFileAtEntry?.path ?? null,
			cancelled: false,
			supersession: admissionSupersession,
			resolveSupersession: resolveAdmissionSupersession,
		};
		pendingDeferredLoadAdmission = admissionOwner;
		let admission: ManagedHostSwitchTicketAdmission;
		try {
			admission = activeCallbacks.onLoadFileEntry(
				targetFile,
				sourceRetirement.receiptId,
			);
		} catch {
			if (pendingDeferredLoadAdmission === admissionOwner) {
				pendingDeferredLoadAdmission = null;
				advancePendingLoadEpoch();
			}
			rejectSourceUnload(sourceRetirement);
			return enterHostLoadMutationTerminal("host-load-admission-threw");
		}
		const continueWithAdmission = (
			ticket: ManagedHostSwitchTicket | null,
		): Promise<void> => {
			const admissionStillOwned = pendingDeferredLoadAdmission === admissionOwner
				&& pendingLoadEpoch === admissionOwner.epoch
				&& !admissionOwner.cancelled
				&& callbackRef === activeCallbacks;
			if (!admissionStillOwned) {
				return admissionOwner.cancelled
					? Promise.resolve()
					: enterHostLoadMutationTerminal("host-load-admission-owner-changed");
			}
			let sessionCurrent = false;
			if (ticket !== null) {
				try {
					sessionCurrent = activeCallbacks.isSessionCurrent(
						ticket.sessionId,
						ticket.handoffGeneration,
					);
				} catch {
					sessionCurrent = false;
				}
			}
			const releaseAdmissionOwner = (): void => {
				if (pendingDeferredLoadAdmission !== admissionOwner) return;
				pendingDeferredLoadAdmission = null;
				advancePendingLoadEpoch();
			};
			if (
				ticket === null
				|| callbackRef !== activeCallbacks
				|| ticket.sourceUnloadReceiptId !== sourceRetirement.receiptId
				|| ticket.targetFile !== targetFile
				|| ticket.targetFile.path !== targetPathAtEntry
				|| !exactPendingViewFile(
					targetFile,
					targetPathAtEntry,
					admissionOwner.viewFileAtEntry,
					admissionOwner.viewPathAtEntry,
				)
				|| !sessionCurrent
			) {
				releaseAdmissionOwner();
				rejectSourceUnload(sourceRetirement);
				return enterHostLoadMutationTerminal("host-load-admission-not-exact");
			}
			releaseAdmissionOwner();
			if (activeManagedLoads().length > 0) {
				rejectSourceUnload(sourceRetirement);
				return enterHostLoadMutationTerminal("host-load-supersession-not-provable");
			}
		for (const association of hostLoadAssociations.values()) {
			if (
				association.ticket.sessionId !== ticket.sessionId
				|| association.ticket.handoffGeneration !== ticket.handoffGeneration
				|| association.ticket.switchIntentSeq !== ticket.switchIntentSeq
			) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				advanceNativeLoadEpoch();
			}
		}
			let resolveSupersession!: (outcome: typeof HOST_LOAD_SUPERSEDED) => void;
			const supersession = new Promise<typeof HOST_LOAD_SUPERSEDED>((resolve) => {
				resolveSupersession = resolve;
			});
			let resolveLocalCommit!: () => void;
			const localCommit = new Promise<void>((resolve) => {
				resolveLocalCommit = resolve;
			});
			let resolveRetirement!: () => void;
			const retirement = new Promise<void>((resolve) => {
				resolveRetirement = resolve;
			});
			advanceNativeLoadEpoch();
			const load: InFlightLoad = {
			id: nextLoadId++,
			ticket,
			targetPathAtEntry,
				ambiguous: false,
				clearObserved: false,
				superseded: false,
				locallyCommitted: false,
				localCommit,
				resolveLocalCommit,
				retirement,
				resolveRetirement,
				supersession,
				resolveSupersession,
			};
		inFlightLoads.set(load.id, load);
		latestLoad = load;
		if (
			mode.kind === "blocking-handoff"
			&& mode.handoffGeneration === ticket.handoffGeneration
			&& mode.targetPath === targetPathAtEntry
		) mode = { ...mode, ticket };
		if (sameFileRefresh && managedClearTombstone === tombstoneAtEntry) {
			clearManagedClearTombstone();
		}

		const continueOriginalLoad = (): Promise<unknown> => {
			if (
				callbackRef !== activeCallbacks
				|| !saveWrappersCurrent()
				|| !loadWrappersCurrent()
			) {
				settleLoad(load.id, false);
				rejectSourceUnload(sourceRetirement);
				return enterHostWrapperDriftTerminal();
			}
			if (terminalHostLifecycle !== null || load.superseded) {
				settleLoad(load.id, false);
				return load.superseded
					? Promise.resolve()
					: terminalHostLifecycle?.promise ?? rejectGuardedHostLoad("terminal-load");
			}
			let result: unknown;
			activeNativeLoadInvocation = load;
			try {
				result = withRegisteredDelegation(
					"onLoadFile",
					installedOnLoadFile as RuntimeMethod,
					() => originalOnLoadFile.apply(view, [targetFile, ...args]),
				);
			} catch (error) {
				settleLoad(load.id, false);
				if (load.locallyCommitted) return load.localCommit;
				throw error;
			} finally {
				if (activeNativeLoadInvocation === load) activeNativeLoadInvocation = null;
			}
			const nativeResult = Promise.resolve(result);
			void nativeResult.then(
				() => settleLoad(load.id, true),
				() => settleLoad(load.id, false),
			);
			const hostVisibleNativeResult = nativeResult.catch((error) => {
				if (load.superseded) return undefined;
				throw error;
			});
			return Promise.race([
				load.localCommit,
				hostVisibleNativeResult,
				load.retirement,
			]);
		};

		if (EDITOR_HANDOFF_QA_ENABLED) {
			const barrier = editorHandoffHostQaBarrierByView?.get(view);
			let continuation: Promise<unknown> | null = null;
			let continuationFailure: Readonly<{ error: unknown }> | null = null;
			const held = barrier?.tryHoldHostLoad({
				stage: "load-entry",
				leafId: leafIdOf(view),
				sessionId: load.ticket.sessionId,
				generation: load.ticket.handoffGeneration,
				targetPath: load.targetPathAtEntry,
				invocationFile: currentFileOf(view),
				continueHostLoad: () => {
					if (
						callbackRef !== activeCallbacks
						|| inFlightLoads.get(load.id) !== load
						|| load.superseded
						|| !isTicketCurrent(load.ticket)
					) {
						settleLoad(load.id, false);
						return "rejected";
					}
					try {
						continuation = continueOriginalLoad();
						return "applied";
					} catch (error) {
						continuationFailure = Object.freeze({ error });
						return "rejected";
					}
				},
			});
			if (held) {
				const heldResult = held.settlement.then(async (outcome) => {
					if (outcome === "rejected" && continuation === null) {
						settleLoad(load.id, false);
						if (load.superseded) return;
						throw guardedHostLoadCancellation("qa-held-host-load-rejected");
					}
					if (continuationFailure !== null) throw continuationFailure.error;
					if (continuation !== null) await continuation;
				});
				return Promise.race([
					load.localCommit,
					heldResult,
					load.supersession,
				]).then(() => undefined);
			}
		}
		return continueOriginalLoad() as Promise<void>;
		};

		let admissionThen: unknown = null;
		if (
			admission !== null
			&& (typeof admission === "object" || typeof admission === "function")
		) {
			try {
				admissionThen = Reflect.get(admission, "then");
			} catch {
				if (pendingDeferredLoadAdmission === admissionOwner) {
					pendingDeferredLoadAdmission = null;
					advancePendingLoadEpoch();
				}
				rejectSourceUnload(sourceRetirement);
				return enterHostLoadMutationTerminal("host-load-admission-unreadable");
			}
		}
		if (typeof admissionThen !== "function") {
			return continueWithAdmission(admission as ManagedHostSwitchTicket | null);
		}
		const admissionSettlement = new Promise<ManagedHostSwitchTicket | null>(
			(resolve, reject) => {
				try {
					Reflect.apply(admissionThen as (...args: unknown[]) => unknown, admission, [
						resolve,
						reject,
					]);
					} catch (error) {
						reject(error instanceof Error
							? error
							: guardedHostLoadCancellation("host-load-admission-rejected"));
				}
			},
		);
		return Promise.race([
			admissionSettlement,
			admissionOwner.supersession,
		]).then(
			(ticket) => ticket === HOST_LOAD_SUPERSEDED
				? undefined
				: continueWithAdmission(ticket),
			(error) => {
				if (admissionOwner.cancelled) throw error;
				if (pendingDeferredLoadAdmission === admissionOwner) {
					pendingDeferredLoadAdmission = null;
					advancePendingLoadEpoch();
				}
				rejectSourceUnload(sourceRetirement);
				return enterHostLoadMutationTerminal("host-load-admission-rejected");
			},
		);
	};
	const installedSetViewData = function (
		this: TextFileView,
		incomingContent: string,
		clear: boolean,
		...args: unknown[]
	): void {
		if (pendingSourceUnloadDrain !== null) {
			const observedDrift = sourceUnloadDrainObservedDrift();
			void enterHostLoadMutationTerminal(observedDrift
				? "source-unload-drain-observable-drift"
				: "host-set-view-data-before-source-unload-drain");
			throw guardedHostLoadCancellation(observedDrift
				? "source-unload-drain-observable-drift"
				: "host-set-view-data-before-source-unload-drain");
		}
		if (activeHostLoadDispatch !== null && !activeHostLoadDispatch.dispatchAmbiguous) {
			activeHostLoadDispatch.dispatchAmbiguous = true;
			advanceNativeLoadEpoch();
		}
		if (callbackRef === null) {
			const replacement = registeredReplacement(
				"setViewData",
				installedSetViewData as RuntimeMethod,
			);
			if (replacement.kind === "route") {
				return Reflect.apply(
					replacement.wrapper,
					view,
					[incomingContent, clear, ...args],
				) as void;
			}
			if (replacement.kind === "inert") return undefined;
		}
		if (callbackRef !== null && terminalHostLifecycle !== null) {
			throw guardedHostLoadCancellation("terminal-host-lifecycle");
		}
		if (callbackRef !== null && managedClearTombstone !== null) {
			void enterHostLoadMutationTerminal("host-set-view-data-after-target-presentation");
			throw guardedHostLoadCancellation(
				"host-set-view-data-after-target-presentation",
			);
		}
		if (EDITOR_HANDOFF_QA_ENABLED && clear === true) {
			const load = exactLoadForQaHold();
			const barrier = editorHandoffHostQaBarrierByView?.get(view);
			if (load && barrier && !qaHeldLoadSettlements?.has(load.id)) {
				const held = barrier.tryHoldHostLoad({
					stage: "clear-load",
					leafId: leafIdOf(view),
					sessionId: load.ticket.sessionId,
					generation: load.ticket.handoffGeneration,
					targetPath: load.targetPathAtEntry,
					invocationFile: currentFileOf(view),
					continueHostLoad: () => {
						if (
							callbackRef === null
							|| inFlightLoads.get(load.id) !== load
							|| exactLoadForQaHold() !== load
						) {
							// A rejected held clear is an intercepted no-op, not an opaque
							// native tail. Retire its exact load synchronously so the queued
							// C clear cannot be made ambiguous by the barrier's microtask.
							qaHeldLoadSettlements?.delete(load.id);
							settleLoad(load.id, false);
							return "rejected";
						}
						installedSetViewData.apply(view, [incomingContent, clear, ...args]);
						return "applied";
					},
				});
				if (held) {
					qaHeldLoadSettlements?.set(load.id, held.settlement);
					return undefined;
				}
			}
		}
		let newAssociation: HostLoadAssociation | null = null;
		if (
			clear === true
			&& callbackRef !== null
			&& clearLoadCapability === "observable"
		) {
			const load = exactLoadForSetViewData();
			if (load === null) {
				const managedClearOwnerExists = inFlightLoads.size > 0
					|| hostLoadAssociations.size > 0;
				if (managedClearOwnerExists) {
					for (const pendingLoad of [...inFlightLoads.values()]) {
						markLoadAmbiguous(pendingLoad);
					}
					void enterHostLoadMutationTerminal("host-clear-load-not-authorized");
					throw guardedHostLoadCancellation("host-clear-load-not-authorized");
				}
			} else {
				let hostLoadTokenId: string | null = null;
				try {
					hostLoadTokenId = callbackRef.onSetViewDataEntry({
						ticket: load.ticket,
						incomingContent,
						clear: true,
					});
				} catch (error) {
					markLoadAmbiguous(load);
					void enterHostLoadMutationTerminal("host-clear-load-not-authorized");
					throw error;
				}
				if (
					hostLoadTokenId !== null
					&& callbackRef !== null
					&& isTicketCurrent(load.ticket)
					&& !hostLoadAssociations.has(hostLoadTokenId)
				) {
					newAssociation = {
						loadId: load.id,
						ticket: load.ticket,
						targetPathAtEntry: load.targetPathAtEntry,
						hostLoadTokenId,
						incomingContent,
						loadStatus: "pending",
						candidate: null,
						pendingReceipt: null,
						completionForwarded: false,
						dispatchAmbiguous: false,
					};
					hostLoadAssociations.set(hostLoadTokenId, newAssociation);
					advanceNativeLoadEpoch();
				} else {
					markLoadAmbiguous(load);
					void enterHostLoadMutationTerminal("host-clear-load-not-authorized");
					throw guardedHostLoadCancellation("host-clear-load-not-authorized");
				}
			}
		}
		try {
			if (newAssociation !== null) activeHostLoadDispatch = newAssociation;
			const result = withRegisteredDelegation(
				"setViewData",
				installedSetViewData as RuntimeMethod,
				() => originalSetViewData.apply(view, [incomingContent, clear, ...args]) as void,
			);
			if (
				newAssociation !== null
				&& newAssociation.candidate !== null
				&& activeHostLoadDispatch === newAssociation
				&& callbackRef !== null
				&& associationIsCurrent(newAssociation)
			) {
				let certified = false;
				try {
					certified = callbackRef.onSetViewDataExit({
						ticket: newAssociation.ticket,
						hostLoadTokenId: newAssociation.hostLoadTokenId,
					}) === true;
				} catch {
					certified = false;
				}
				if (
					!certified
					|| activeHostLoadDispatch !== newAssociation
					|| callbackRef === null
					|| !associationIsCurrent(newAssociation)
				) {
					if (!newAssociation.dispatchAmbiguous) {
						newAssociation.dispatchAmbiguous = true;
						advanceNativeLoadEpoch();
					}
				}
			}
			return result;
		} catch (error) {
			if (newAssociation !== null) {
				if (hostLoadAssociations.delete(newAssociation.hostLoadTokenId)) {
					advanceNativeLoadEpoch();
				}
			}
			throw error;
		} finally {
			if (activeHostLoadDispatch === newAssociation) activeHostLoadDispatch = null;
		}
	};

	function registeredReplacement(
		name: GuardedMethodName,
		retiredWrapper: RuntimeMethod,
		lane: DelegationLane = name,
	): RegisteredReplacement {
		const registered = installedGuards.get(view);
		if (registered === undefined) return { kind: "none" };
		const replacement = registered.wrappers.get(name);
		if (replacement === undefined || replacement === retiredWrapper) return { kind: "none" };
		const frames = registered.delegationFrames.get(lane);
		if (frames !== undefined && frames.length > 0) {
			if (isSaveDelegationLane(lane)) {
				const frame = frames.length === 1 ? frames[0] : undefined;
				if (frame?.state === "open") {
					frame.state = "claimed";
					return { kind: "tail" };
				}
				registered.suppressRetiredSaveTail();
				return { kind: "inert" };
			}
			for (let index = frames.length - 1; index >= 0; index -= 1) {
				const frame = frames[index];
				if (frame?.state !== "open") continue;
				frame.state = "claimed";
				return { kind: "tail" };
			}
			return { kind: "inert" };
		}
		return { kind: "route", wrapper: replacement };
	}

	function withRegisteredDelegation<T>(
		name: GuardedMethodName,
		wrapper: RuntimeMethod,
		delegate: () => T,
		lane: DelegationLane = name,
	): T {
		const registered = installedGuards.get(view);
		if (registered === undefined || registered.wrappers.get(name) !== wrapper) {
			return delegate();
		}
		const frame: DelegationFrame = { state: "open" };
		const frames = registered.delegationFrames.get(lane) ?? [];
		if (!registered.delegationFrames.has(lane)) {
			registered.delegationFrames.set(lane, frames);
		}
		if (frames.length > 0 && isSaveDelegationLane(lane)) {
			for (const unresolved of frames) unresolved.state = "revoked";
			frame.state = "revoked";
		}
		frames.push(frame);
		let retired = false;
		const retireFrame = (): void => {
			if (retired) return;
			retired = true;
			const index = frames.indexOf(frame);
			if (index >= 0) frames.splice(index, 1);
			if (frames.length === 0) registered.delegationFrames.delete(lane);
		};
		let result: T;
		try {
			result = delegate();
		} catch (error) {
			retireFrame();
			throw error;
		}
		if (
			(typeof result === "object" && result !== null)
			|| typeof result === "function"
		) {
			let then: unknown;
			try {
				then = (result as { then?: unknown }).then;
			} catch {
				retireFrame();
				return result;
			}
			if (typeof then === "function") {
				try {
					Reflect.apply(then, result, [retireFrame, retireFrame]);
					return result;
				} catch {
					retireFrame();
					return result;
				}
			}
		}
		retireFrame();
		return result;
	}

	function loseHostCapability(reason: string): void {
		if (hostCapabilityState === "lost") return;
		hostCapabilityState = "lost";
		saveEpoch += 1;
		if (ownedSaveTimer !== null) clearTimeout(ownedSaveTimer);
		ownedSaveTimer = null;
		pendingOwnedSave = null;
		if (sourceUnloadExpiryTimer !== null) clearTimeout(sourceUnloadExpiryTimer);
		sourceUnloadExpiryTimer = null;
		callbackRef?.onHostCapabilityLost(reason);
	}

	function cancelOwnedSaveJob(): void {
		if (ownedSaveTimer !== null) clearTimeout(ownedSaveTimer);
		ownedSaveTimer = null;
		if (pendingOwnedSave !== null) saveEpoch += 1;
		pendingOwnedSave = null;
	}

	function isOwnedSaveJobCurrent(job: ManagedOwnedSaveJobSnapshot): boolean {
		return callbackRef !== null
			&& hostCapabilityState === "ready"
			&& mode.kind !== "inert-pass-through"
			&& view.file === job.file
			&& job.file.path === job.path
			&& callbackRef.isSessionCurrent(job.sessionId, job.generation)
			&& callbackRef.isSaveOwnershipContextCurrent({
				sessionId: job.sessionId,
				generation: job.generation,
				file: job.file,
				path: job.path,
				displayedPath: job.displayedPath,
			});
	}

	function runOwnedSave(): Promise<void> {
		const job = pendingOwnedSave;
		if (job === null) return Promise.resolve();
		if (ownedSaveTimer !== null) clearTimeout(ownedSaveTimer);
		ownedSaveTimer = null;
		pendingOwnedSave = null;
		saveEpoch += 1;
		if (
			pendingSourceUnloadDrain !== null
			|| pendingDeferredLoadAdmission !== null
		) {
			reportSuppressed(currentFileOf(view));
			return Promise.resolve();
		}
		if (emergencySaveFenceOwners.size > 0) {
			callbackRef?.onSaveSuppressed({
				sessionId: job.sessionId,
				handoffGeneration: job.generation,
				invocationFile: job.file,
				invocationPath: job.path,
			});
			return Promise.resolve();
		}
		if (!isOwnedSaveJobCurrent(job)) {
			callbackRef?.onSaveSuppressed({
				sessionId: job.sessionId,
				handoffGeneration: job.generation,
				invocationFile: job.file,
				invocationPath: job.path,
			});
			return Promise.resolve();
		}
		return Reflect.apply(installedSave, view, [false]);
	}

	function scheduleOwnedSave(): void {
		if (
			emergencySaveFenceOwners.size > 0
			|| hostCapabilityState !== "ready"
			|| callbackRef === null
		) return;
		const context = callbackRef.captureSaveOwnershipContext();
		if (
			context === null
			|| context.file !== view.file
			|| context.file.path !== context.path
			|| context.displayedPath !== context.path
			|| !callbackRef.isSessionCurrent(context.sessionId, context.generation)
			|| !callbackRef.isSaveOwnershipContextCurrent(context)
		) {
			loseHostCapability("save-ownership-unavailable");
			return;
		}
		if (!writeBooleanHostDirty(view, true)) {
			loseHostCapability("save-dirty-state-unavailable");
			return;
		}
		cancelOwnedSaveJob();
		saveEpoch += 1;
		pendingOwnedSave = Object.freeze({
			jobId: nextOwnedSaveJobId++,
			sessionId: context.sessionId,
			generation: context.generation,
			file: context.file,
			path: context.path,
			displayedPath: context.displayedPath,
			saveEpoch,
		});
		ownedSaveTimer = setTimeout(() => {
			ownedSaveTimer = null;
			void runOwnedSave().catch(() => undefined);
		}, requestSaveDelayMs);
	}

	const installedRequestSave = function (this: TextFileView, ...args: unknown[]): void {
		if (pendingSourceUnloadDrain !== null) {
			sourceUnloadDrainObservedDrift();
			reportSuppressed(currentFileOf(view));
			return undefined;
		}
		if (emergencySaveFenceOwners.size > 0) {
			reportSuppressed(currentFileOf(view));
			return undefined;
		}
		if (callbackRef === null) {
			const replacement = registeredReplacement(
				"requestSave",
				installedRequestSave as RuntimeMethod,
			);
			if (replacement.kind === "route") {
				return Reflect.apply(replacement.wrapper, view, args) as void;
			}
			if (replacement.kind === "inert") return undefined;
			return Reflect.apply(originalRequestSave, view, args) as void;
		}
		if (terminalSaveSuppressionActive()) {
			reportSuppressed(currentFileOf(view));
			return undefined;
		}
		const invocationFile = currentFileOf(view);
		if (sourceUnload?.state === "saving") {
			sourceUnload.inputObservedBeforeSettlement = true;
		}
		if (
			mode.kind === "blocking-handoff"
			|| sourceUnloadBlocksOrdinarySave(invocationFile)
		) {
			reportSuppressed(invocationFile);
			return undefined;
		}
		scheduleOwnedSave();
		return undefined;
	};
	Object.defineProperty(installedRequestSave, "cancel", {
		configurable: true,
		enumerable: false,
		value: (...args: unknown[]) => {
			if (pendingSourceUnloadDrain !== null) {
				sourceUnloadDrainObservedDrift();
				return undefined;
			}
			cancelOwnedSaveJob();
			return originalCancellableRequestSave === null
				? undefined
				: Reflect.apply(
					originalCancellableRequestSave.cancel,
					originalCancellableRequestSave,
					args,
				);
		},
		writable: false,
	});
	Object.defineProperty(installedRequestSave, "flush", {
		configurable: true,
		enumerable: false,
		value: (...args: unknown[]) => {
			if (pendingSourceUnloadDrain !== null) {
				sourceUnloadDrainObservedDrift();
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			if (emergencySaveFenceOwners.size > 0) {
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			if (callbackRef === null) {
				const replacement = registeredReplacement(
					"requestSave",
					installedRequestSave as RuntimeMethod,
					"requestSave.flush",
				);
				if (replacement.kind === "route") {
					const replacementFlush = (replacement.wrapper as CancellableFunction).flush;
					return typeof replacementFlush === "function"
						? Reflect.apply(replacementFlush, replacement.wrapper, args)
						: undefined;
				}
				if (replacement.kind === "inert") return undefined;
				const originalFlush = originalCancellableRequestSave?.flush;
				return typeof originalFlush === "function"
					? Reflect.apply(originalFlush, originalCancellableRequestSave, args)
					: undefined;
			}
			if (terminalSaveSuppressionActive()) {
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			return runOwnedSave();
		},
		writable: false,
	});
	Object.defineProperty(installedRequestSave, "run", {
		configurable: true,
		enumerable: false,
		value: (...args: unknown[]) => {
			if (pendingSourceUnloadDrain !== null) {
				sourceUnloadDrainObservedDrift();
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			if (emergencySaveFenceOwners.size > 0) {
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			if (callbackRef === null) {
				const replacement = registeredReplacement(
					"requestSave",
					installedRequestSave as RuntimeMethod,
					"requestSave.run",
				);
				if (replacement.kind === "route") {
					const replacementRun = (replacement.wrapper as CancellableFunction).run;
					return typeof replacementRun === "function"
						? Reflect.apply(replacementRun, replacement.wrapper, args)
						: undefined;
				}
				if (replacement.kind === "inert") return undefined;
				const originalRun = originalCancellableRequestSave?.run;
				return typeof originalRun === "function"
					? Reflect.apply(originalRun, originalCancellableRequestSave, args)
					: undefined;
			}
			if (terminalSaveSuppressionActive()) {
				reportSuppressed(currentFileOf(view));
				return undefined;
			}
			const invocationFile = currentFileOf(view);
			if (sourceUnload?.state === "saving") {
				sourceUnload.inputObservedBeforeSettlement = true;
			}
			if (
				mode.kind === "blocking-handoff"
				|| sourceUnloadBlocksOrdinarySave(invocationFile)
			) {
				reportSuppressed(invocationFile);
				return undefined;
			}
			return runOwnedSave();
		},
		writable: false,
	});

	function executeNativeSave(
		invocationFile: TFile | null,
		args: unknown[],
		allowBlockingSourceRetirement: boolean,
	): Readonly<{
		outcome: "delegated" | "suppressed" | "rejected";
		result: Promise<void>;
	}> {
		if (emergencySaveFenceOwners.size > 0) {
			reportSuppressed(invocationFile);
			return { outcome: "suppressed", result: Promise.resolve() };
		}
		if (terminalSaveSuppressionActive()) {
			reportSuppressed(invocationFile);
			return { outcome: "suppressed", result: Promise.resolve() };
		}
		if (
			!allowBlockingSourceRetirement
			&& (
				mode.kind === "blocking-handoff"
				|| sourceUnloadBlocksOrdinarySave(invocationFile)
			)
		) {
			reportSuppressed(invocationFile);
			return { outcome: "suppressed", result: Promise.resolve() };
		}
		if (currentFileOf(view) !== invocationFile) {
			return { outcome: "rejected", result: Promise.resolve() };
		}
		const result = withRegisteredDelegation(
			"save",
			installedSave as RuntimeMethod,
			() => originalSave.apply(view, args) as Promise<void>,
		);
		return { outcome: "delegated", result };
	}

	const installedSave = function (
		this: TextFileView,
		...args: unknown[]
	): Promise<void> {
		if (pendingSourceUnloadDrain !== null) {
			sourceUnloadDrainObservedDrift();
			reportSuppressed(currentFileOf(view));
			return Promise.resolve();
		}
		if (emergencySaveFenceOwners.size > 0) {
			reportSuppressed(currentFileOf(view));
			return Promise.resolve();
		}
		if (callbackRef === null) {
			const replacement = registeredReplacement("save", installedSave as RuntimeMethod);
			if (replacement.kind === "route") {
				return Reflect.apply(replacement.wrapper, view, args) as Promise<void>;
			}
			if (replacement.kind === "inert") return Promise.resolve();
		}
		if (terminalSaveSuppressionActive()) {
			reportSuppressed(currentFileOf(view));
			return Promise.resolve();
		}
		if (pendingDeferredLoadAdmission !== null) {
			reportSuppressed(currentFileOf(view));
			return Promise.resolve();
		}
		const invocationFile = currentFileOf(view);
		saveEpoch += 1;
		let resolveSettlement!: () => void;
		const settlement = new Promise<void>((resolve) => {
			resolveSettlement = resolve;
		});
		const invocationId = nextSaveId++;
		const inFlightSave: InFlightSave = {
			id: invocationId,
			file: invocationFile,
			path: invocationFile?.path ?? null,
			startedAt: Date.now(),
			settlement,
			resolveSettlement,
			settled: false,
		};
		inFlightSaves.set(invocationId, inFlightSave);
		let settled = false;
		const noteSettlement = (): void => {
			if (settled) return;
			settled = true;
			inFlightSave.settled = true;
			if (inFlightSaves.get(invocationId) === inFlightSave) {
				inFlightSaves.delete(invocationId);
			}
			saveEpoch += 1;
			resolveSettlement();
		};
		try {
			let forcedSourceRetirement = false;
			const activeSourceUnload = sourceUnload;
			if (
				args[0] === true
				&& activeSourceUnload !== null
				&& activeSourceUnload.state === "saving"
				&& !activeSourceUnload.forcedSaveObserved
				&& invocationFile === activeSourceUnload.file
				&& invocationFile.path === activeSourceUnload.path
			) {
				const content = currentViewContent();
				if (content !== null && content === activeSourceUnload.sourceContent) {
					activeSourceUnload.forcedSaveObserved = true;
					activeSourceUnload.forcedSaveFile = invocationFile;
					activeSourceUnload.forcedSavePath = invocationFile.path;
					activeSourceUnload.forcedSaveContent = content;
					forcedSourceRetirement = true;
				}
			}
			let result: Promise<void>;
			if (EDITOR_HANDOFF_QA_ENABLED) {
				const barrier = editorHandoffHostQaBarrierByView?.get(view);
				const held = barrier?.tryHoldNativeSave({
					leafId: leafIdOf(view),
					sessionId: null,
					generation: null,
					invocationFile,
					continueNativeSave: async () => {
						const execution = executeNativeSave(
							invocationFile,
							args,
							forcedSourceRetirement,
						);
						await execution.result;
						return execution.outcome;
					},
				});
				result = held ?? executeNativeSave(
					invocationFile,
					args,
					forcedSourceRetirement,
				).result;
			} else {
				result = executeNativeSave(
					invocationFile,
					args,
					forcedSourceRetirement,
				).result;
			}
			if (
				typeof result === "object"
				&& result !== null
				&& typeof result.then === "function"
			) void result.then(noteSettlement, noteSettlement);
			else noteSettlement();
			return result;
		} catch (error) {
			noteSettlement();
			throw error;
		}
	};

	const wrappers = new Map<GuardedMethodName, RuntimeMethod>([
		["onUnloadFile", installedOnUnloadFile as RuntimeMethod],
		["onLoadFile", installedOnLoadFile as RuntimeMethod],
		["setViewData", installedSetViewData as RuntimeMethod],
		["requestSave", installedRequestSave as RuntimeMethod],
		["save", installedSave as RuntimeMethod],
	]);
	const installedNames: GuardedMethodName[] = [];
	try {
		for (const name of [
			"onUnloadFile",
			"onLoadFile",
			"setViewData",
			"requestSave",
			"save",
		] as const) {
			const method = methods.get(name);
			const wrapper = wrappers.get(name);
			if (method === undefined || wrapper === undefined) throw new TypeError(`Missing ${name} wrapper`);
			Object.defineProperty(view, name, installedDescriptor(method, wrapper));
			installedNames.push(name);
		}
	} catch {
		for (const name of installedNames.reverse()) {
			const method = methods.get(name);
			if (method === undefined) continue;
			if (method.hadOwn) Object.defineProperty(view, name, method.descriptor);
			else Reflect.deleteProperty(view, name);
		}
		return { kind: "unsupported", reason: "method-not-wrappable" };
	}

	function saveWrappersCurrent(): boolean {
		const registered = installedGuards.get(view);
		if (registered?.guard !== guard) return false;
		try {
			return Object.getOwnPropertyDescriptor(view, "requestSave")?.value
					=== installedRequestSave
				&& Object.getOwnPropertyDescriptor(view, "save")?.value === installedSave;
		} catch {
			return false;
		}
	}

	function loadWrappersCurrent(): boolean {
		const registered = installedGuards.get(view);
		if (registered?.guard !== guard) return false;
		try {
			return Object.getOwnPropertyDescriptor(view, "onUnloadFile")?.value
					=== installedOnUnloadFile
				&& Object.getOwnPropertyDescriptor(view, "onLoadFile")?.value
					=== installedOnLoadFile
				&& Object.getOwnPropertyDescriptor(view, "setViewData")?.value
					=== installedSetViewData;
		} catch {
			return false;
		}
	}

	function revokeEmergencySaveDelegations(): void {
		cancelOwnedSaveJob();
		const registered = installedGuards.get(view);
		if (registered?.guard === guard) {
			for (const lane of [
				"requestSave",
				"requestSave.run",
				"requestSave.flush",
				"save",
			] as const satisfies readonly SaveDelegationLane[]) {
				const frames = registered.delegationFrames.get(lane);
				if (frames === undefined) continue;
				for (const frame of frames) frame.state = "revoked";
			}
		}
		if (originalCancellableRequestSave !== null) {
			try {
				originalCancellableRequestSave.cancel.call(originalCancellableRequestSave);
			} catch {
				// The owned wrappers below remain the fail-closed authority.
			}
		}
	}

	function restoreEmergencySaveWrapperIdentity(): boolean {
		if (installedGuards.get(view)?.guard !== guard) return false;
		if (emergencySaveFenceOwners.size > 0 && !saveWrappersCurrent()) {
			// A displaced wrapper may already have captured `save` or scheduled a
			// timer/promise tail. Re-installing our entry points blocks future calls,
			// but it cannot prove that opaque work was cancelled. Keep this guard
			// permanently unprovable so the manager requires an explicit reopen.
			emergencySaveFenceUnprovable = true;
		}
		const changed: Array<Readonly<{
			name: "requestSave" | "save";
			previous: PropertyDescriptor | undefined;
		}>> = [];
		try {
			for (const name of ["requestSave", "save"] as const) {
				const wrapper = wrappers.get(name);
				const original = methods.get(name);
				if (wrapper === undefined || original === undefined) throw new TypeError("save wrapper missing");
				const current = Object.getOwnPropertyDescriptor(view, name);
				if (current?.value === wrapper) continue;
				if (
					current !== undefined
					&& current.configurable !== true
					&& current.writable !== true
				) throw new TypeError("save wrapper not replaceable");
				changed.push({ name, previous: current });
				Object.defineProperty(
					view,
					name,
					current === undefined
						? installedDescriptor(original, wrapper)
						: { ...current, value: wrapper },
				);
			}
		} catch {
			for (const { name, previous } of changed.reverse()) {
				try {
					if (previous === undefined) Reflect.deleteProperty(view, name);
					else Object.defineProperty(view, name, previous);
				} catch {
					// A partially hostile host remains observable as wrappersCurrent=false.
				}
			}
			return false;
		}
		return saveWrappersCurrent();
	}

	function ensureTerminalHostLifecycle(): Promise<void> {
		if (terminalHostLifecycle !== null) return terminalHostLifecycle.promise;
		let reject!: (reason: unknown) => void;
		const promise = new Promise<void>((_resolve, rejectPromise) => {
			reject = rejectPromise;
		});
		// The host may ignore the returned promise. Mark its rejection handled while
		// preserving rejection for callers that await or chain the exact promise.
		void promise.catch(() => undefined);
		terminalHostLifecycle = {
			ownerId: nextTerminalHostLifecycleOwnerId++,
			promise,
			reject,
			settled: false,
		};
		return promise;
	}

	function settleTerminalHostLifecycle(reason: string): boolean {
		const owner = terminalHostLifecycle;
		if (owner === null || owner.settled) return false;
		if (pendingSourceUnloadDrain !== null) {
			clearSourceUnloadDrainDeadline(pendingSourceUnloadDrain);
		}
		terminalHostLifecycle = null;
		owner.settled = true;
		for (const load of inFlightLoads.values()) {
			if (load.superseded) load.resolveRetirement();
		}
		owner.reject(new Error(`KAOS terminal host lifecycle cancelled: ${reason}`));
		return true;
	}

	function enterHostWrapperDriftTerminal(): Promise<void> {
		const blocked = ensureTerminalHostLifecycle();
		// A displaced wrapper may already own an opaque timer/promise tail.
		// Recapture future save entry points, permanently taint the emergency proof,
		// and reject further guarded lifecycle mutation. Load wrappers are not
		// restored because their displaced work cannot be proven cancelled.
		emergencySaveFenceUnprovable = true;
		revokeEmergencySaveDelegations();
		restoreEmergencySaveWrapperIdentity();
		loseHostCapability("host-wrapper-drift-before-host-load");
		return blocked;
	}

	function enterHostLoadMutationTerminal(reason: string): Promise<void> {
		const blocked = ensureTerminalHostLifecycle();
		if (pendingSourceUnloadDrain !== null) {
			clearSourceUnloadDrainDeadline(pendingSourceUnloadDrain);
		}
		// Once exact host-load ownership is lost, native lifecycle or save mutation
		// could relabel source bytes as the target. Fence future saves and hand the
		// lifecycle to the manager until a safe reopen cancels it.
		revokeEmergencySaveDelegations();
		restoreEmergencySaveWrapperIdentity();
		loseHostCapability(reason);
		return blocked;
	}

	function enterSourceUnloadProofLostTerminal(
		reason = "source-unload-proof-lost-before-host-load",
	): Promise<void> {
		return enterHostLoadMutationTerminal(reason);
	}

	function becomeInert(): void {
		settleTerminalHostLifecycle("guard-became-inert");
		if (EDITOR_HANDOFF_QA_ENABLED) {
			editorHandoffHostQaBarrierByView?.get(view)?.invalidateGuard(leafIdOf(view));
			editorHandoffHostQaBarrierByView?.delete(view);
		}
		if (pendingSourceUnloadDrain !== null) {
			const pending = pendingSourceUnloadDrain;
			clearSourceUnloadDrain(pending);
			pending.rejectCancellation(
				guardedHostLoadCancellation("guard-became-inert"),
			);
		}
		if (pendingDeferredLoadAdmission !== null) {
			const pending = pendingDeferredLoadAdmission;
			rejectSourceUnload(pending.sourceRetirement);
			supersedePendingAdmission(pending);
		}
		callbackRef = null;
		clearManagedClearTombstone();
		activeUnprovenTargetUnload = null;
		cancelOwnedSaveJob();
		clearSourceUnloadExpiry();
		latestLoad = null;
		if (inFlightLoads.size > 0 || hostLoadAssociations.size > 0) {
			advanceNativeLoadEpoch();
		}
		inFlightLoads.clear();
		inFlightSaves.clear();
		hostLoadAssociations.clear();
		activeHostLoadDispatch = null;
		mode = { kind: "inert-pass-through" };
	}

	function targetPresentationReady(input: Readonly<{
		handoffGeneration: number;
		targetFile: TFile;
		certifiedContent: string;
	}>): boolean {
		if (
			clearLoadCapability !== "observable"
			|| mode.kind !== "blocking-handoff"
			|| callbackRef === null
			|| mode.ticket === null
			|| !saveWrappersCurrent()
			|| !loadWrappersCurrent()
		) return false;
		const expectedMode = mode;
		const expectedTicket = mode.ticket;
		const activeCallbacks = callbackRef;
		const matchingAssociations = [...hostLoadAssociations.values()].filter(
			(association) => association.ticket === expectedTicket,
		);
		const expectedAssociation = matchingAssociations[0] ?? null;
		const exactAssociationRemains = (): boolean => {
			const currentMatchingAssociations = [...hostLoadAssociations.values()].filter(
				(association) => association.ticket === expectedTicket,
			);
			return expectedAssociation !== null
				&& currentMatchingAssociations.length === 1
				&& currentMatchingAssociations[0] === expectedAssociation
				&& hostLoadAssociations.get(expectedAssociation.hostLoadTokenId)
					=== expectedAssociation
				&& (
					expectedAssociation.loadStatus === "fulfilled"
					|| expectedAssociation.loadStatus === "local-committed"
				)
				&& expectedAssociation.incomingContent === input.certifiedContent
				&& !expectedAssociation.dispatchAmbiguous
				&& inFlightLoads.size === 0;
		};
		if (expectedMode.handoffGeneration !== input.handoffGeneration) return false;
		if (expectedMode.targetPath !== input.targetFile.path) return false;
		if (expectedTicket.handoffGeneration !== input.handoffGeneration) return false;
		if (expectedTicket.targetFile !== input.targetFile) return false;
		if (!exactAssociationRemains()) return false;
		if (!activeCallbacks.isSessionCurrent(expectedTicket.sessionId, input.handoffGeneration)) {
			return false;
		}
		if (view.file !== input.targetFile || view.file.path !== expectedMode.targetPath) return false;
		if (view.data !== input.certifiedContent) return false;
		const editorContent = view.getViewData();
		if (
			editorContent !== input.certifiedContent
			|| mode !== expectedMode
			|| callbackRef !== activeCallbacks
			|| !saveWrappersCurrent()
			|| !loadWrappersCurrent()
		) return false;
		if (!activeCallbacks.isSessionCurrent(
			expectedTicket.sessionId,
			input.handoffGeneration,
		)) return false;
		return mode === expectedMode
			&& callbackRef === activeCallbacks
			&& view.file === input.targetFile
			&& view.file.path === expectedMode.targetPath
			&& view.data === input.certifiedContent
			&& saveWrappersCurrent()
			&& loadWrappersCurrent()
			&& exactAssociationRemains();
	}

	const guard: TextFileViewHandoffGuard = {
		beginBlockingHandoff(input): void {
			if (mode.kind === "inert-pass-through") return;
			const ticket = clearLoadCapability === "observable"
				&& latestLoad !== null
				&& !latestLoad.ambiguous
				&& latestLoad.ticket.handoffGeneration === input.handoffGeneration
				&& latestLoad.targetPathAtEntry === input.targetPath
				&& isTicketCurrent(latestLoad.ticket)
				? latestLoad.ticket
				: null;
			mode = {
				kind: "blocking-handoff",
				handoffGeneration: input.handoffGeneration,
				sourceLineagePath: input.sourceLineagePath,
				targetPath: input.targetPath,
				ticket,
			};
			const registered = installedGuards.get(view);
			if (registered?.guard === guard) {
				for (const lane of [
					"requestSave",
					"requestSave.run",
					"requestSave.flush",
					"save",
				] as const satisfies readonly SaveDelegationLane[]) {
					const frames = registered.delegationFrames.get(lane);
					if (frames === undefined) continue;
					for (const frame of frames) frame.state = "revoked";
				}
			}
			cancelOwnedSaveJob();
			if (originalCancellableRequestSave !== null) {
				originalCancellableRequestSave.cancel.call(originalCancellableRequestSave);
			}
		},
		isTargetPresentationReady(input): boolean {
			return targetPresentationReady(input);
		},
		markTargetProven(input): boolean {
			if (!targetPresentationReady(input)) return false;
			if (!targetPresentationReady(input)) return false;
			if (mode.kind !== "blocking-handoff" || mode.ticket === null) return false;
			const presentationTicket = mode.ticket;
			const exactAssociations = [...hostLoadAssociations.values()].filter(
				(association) => association.ticket === presentationTicket,
			);
			const exactAssociation = exactAssociations.length === 1
				? exactAssociations[0] ?? null
				: null;
			if (
				exactAssociation === null
				|| (
					exactAssociation.loadStatus !== "fulfilled"
					&& exactAssociation.loadStatus !== "local-committed"
				)
				|| exactAssociation.dispatchAmbiguous
				|| exactAssociation.incomingContent !== input.certifiedContent
			) return false;
			retainManagedClearTombstone(exactAssociation);
			mode = { kind: "pass-through" };
			return true;
		},
		markTargetLocallyPresented(input): boolean {
			if (!targetPresentationReady(input)) return false;
			if (mode.kind !== "blocking-handoff" || mode.ticket === null) return false;
			if (callbackRef === null || sourceUnload === null) return false;
			const expectedMode = mode;
			const expectedTicket = mode.ticket;
			const expectedSourceUnload = sourceUnload;
			const activeCallbacks = callbackRef;
			const exactAssociations = [...hostLoadAssociations.values()].filter(
				(association) => association.ticket === expectedTicket,
			);
			const expectedAssociation = exactAssociations.length === 1
				? exactAssociations[0] ?? null
				: null;
			const exactLocalOwnerRemains = (): boolean =>
				expectedAssociation !== null
				&& mode === expectedMode
				&& sourceUnload === expectedSourceUnload
				&& callbackRef === activeCallbacks
				&& expectedMode.ticket === expectedTicket
				&& expectedSourceUnload.receiptId === expectedTicket.sourceUnloadReceiptId
				&& retiredSourceReceiptIsExact(expectedSourceUnload)
				&& hostLoadAssociations.get(expectedAssociation.hostLoadTokenId)
					=== expectedAssociation
				&& expectedAssociation.ticket === expectedTicket
				&& expectedAssociation.targetPathAtEntry === expectedMode.targetPath
				&& expectedAssociation.loadStatus === "local-committed"
				&& expectedAssociation.pendingReceipt !== null
				&& expectedAssociation.completionForwarded
				&& !expectedAssociation.dispatchAmbiguous
				&& expectedAssociation.incomingContent === input.certifiedContent
				&& inFlightLoads.get(expectedAssociation.loadId) === undefined
				&& inFlightLoads.size === 0;
			if (
				!exactLocalOwnerRemains()
				|| !targetPresentationReady(input)
				|| !exactLocalOwnerRemains()
				|| expectedAssociation === null
			) return false;
			clearSourceUnloadExpiry();
			if (
				latestLoad?.id === expectedAssociation.loadId
				&& latestLoad.ticket === expectedTicket
			) {
				latestLoad = null;
			}
			retainManagedClearTombstone(expectedAssociation);
			if (hostLoadAssociations.delete(expectedAssociation.hostLoadTokenId)) {
				advanceNativeLoadEpoch();
			}
			sourceUnload = null;
			mode = { kind: "pass-through" };
			return true;
		},
		reportHostLoadCandidate(candidate): boolean {
			if (clearLoadCapability !== "observable") return false;
			const association = hostLoadAssociations.get(candidate.hostLoadTokenId);
			if (association === undefined || callbackRef === null) return false;
			if (!associationIsCurrent(association)) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				advanceNativeLoadEpoch();
				return false;
			}
			if (
				association.candidate !== null
				|| candidate.hostLoadCompletedEpoch !== null
				|| candidate.sessionId !== association.ticket.sessionId
				|| candidate.handoffGeneration !== association.ticket.handoffGeneration
				|| candidate.switchIntentSeq !== association.ticket.switchIntentSeq
				|| candidate.sourceUnloadReceiptId
					!== association.ticket.sourceUnloadReceiptId
				|| candidate.targetPathAtDispatch !== association.targetPathAtEntry
				|| candidate.runtimeView !== view
				|| candidate.incomingContent !== association.incomingContent
				|| candidate.leafId !== leafIdOf(view)
			) return false;
			association.candidate = candidate;
			advanceNativeLoadEpoch();
			callbackRef.onHostLoadCandidate(candidate);
			return true;
		},
		reportHostLoadCompleted(receipt): boolean {
			if (clearLoadCapability !== "observable") return false;
			const association = hostLoadAssociations.get(receipt.hostLoadTokenId);
			const exactAssociations = association === undefined
				? []
				: [...hostLoadAssociations.values()].filter(
					(candidateAssociation) => candidateAssociation.ticket === association.ticket,
				);
			const load = association === undefined
				? null
				: inFlightLoads.get(association.loadId) ?? null;
			const exactPendingLoad = association !== undefined
				&& association.loadStatus === "pending"
				&& load !== null
				&& inFlightLoads.size === 1
				&& !load.ambiguous
				&& !load.superseded
				&& !load.locallyCommitted
				&& load.clearObserved
				&& load.ticket === association.ticket
				&& load.targetPathAtEntry === association.targetPathAtEntry;
			const exactFulfilledLoad = association !== undefined
				&& association.loadStatus === "fulfilled"
				&& load === null
				&& inFlightLoads.size === 0;
			if (
				association === undefined
				|| association.pendingReceipt !== null
				|| association.completionForwarded
				|| association.dispatchAmbiguous
				|| hostLoadAssociations.size !== 1
				|| exactAssociations.length !== 1
				|| exactAssociations[0] !== association
				|| (!exactPendingLoad && !exactFulfilledLoad)
				|| !associationIsCurrent(association)
				|| !receiptMatchesAssociation(association, receipt)
			) return false;
			association.pendingReceipt = receipt;
			association.loadStatus = "local-committed";
			if (load !== null) {
				load.locallyCommitted = true;
				inFlightLoads.delete(load.id);
				if (latestLoad === load) latestLoad = null;
				load.resolveLocalCommit();
			}
			advanceNativeLoadEpoch();
			return forwardLocallyCommittedCompletion(association);
		},
		isExactHostLoadDispatchActive(identity): boolean {
			const association = activeHostLoadDispatch;
			if (
				association === null
				|| association.dispatchAmbiguous
				|| callbackRef === null
				|| hostLoadAssociations.get(identity.hostLoadTokenId) !== association
				|| association.hostLoadTokenId !== identity.hostLoadTokenId
				|| association.ticket.sessionId !== identity.sessionId
				|| association.ticket.handoffGeneration !== identity.handoffGeneration
				|| association.ticket.switchIntentSeq !== identity.switchIntentSeq
				|| association.ticket.sourceUnloadReceiptId !== identity.sourceUnloadReceiptId
				|| association.ticket.targetFile !== identity.targetFile
				|| association.targetPathAtEntry !== identity.targetPath
				|| association.incomingContent !== identity.incomingContent
				|| identity.targetFile.path !== identity.targetPath
				|| identity.runtimeView !== view
				|| identity.leafId !== leafIdOf(view)
				|| !associationIsCurrent(association)
			) return false;
			return activeHostLoadDispatch === association
				&& !association.dispatchAmbiguous
				&& callbackRef !== null
				&& hostLoadAssociations.get(identity.hostLoadTokenId) === association
				&& view.file === identity.targetFile
				&& view.file.path === identity.targetPath;
		},
		flushOwnedSave(): Promise<void> {
			return runOwnedSave();
		},
		cancelOwnedSave(): void {
			cancelOwnedSaveJob();
		},
		cancelTerminalHostLifecycle(reason): boolean {
			return settleTerminalHostLifecycle(reason);
		},
		acquireEmergencySaveFence(): TextFileViewEmergencySaveFence {
			const owner = Object.freeze({});
			let released = false;
			emergencySaveFenceOwners.add(owner);
			const refresh = (): boolean => {
				if (released || !emergencySaveFenceOwners.has(owner)) return false;
				revokeEmergencySaveDelegations();
				const restored = restoreEmergencySaveWrapperIdentity();
				return restored && !emergencySaveFenceUnprovable;
			};
			const fence: TextFileViewEmergencySaveFence = Object.freeze({
				view,
				refresh,
				isCurrent: () => {
					if (released || !emergencySaveFenceOwners.has(owner)) return false;
					if (!saveWrappersCurrent()) emergencySaveFenceUnprovable = true;
					return !emergencySaveFenceUnprovable && saveWrappersCurrent();
				},
				release: () => {
					if (released || !emergencySaveFenceOwners.delete(owner)) return false;
					released = true;
					return true;
				},
			});
			refresh();
			return fence;
		},
		markInert(): void {
			if (emergencySaveFenceOwners.size > 0) {
				revokeEmergencySaveDelegations();
				restoreEmergencySaveWrapperIdentity();
				return;
			}
			becomeInert();
		},
		restoreIfCurrent(): void {
			if (emergencySaveFenceOwners.size > 0) {
				revokeEmergencySaveDelegations();
				restoreEmergencySaveWrapperIdentity();
				return;
			}
			becomeInert();
			for (const name of [
				"onUnloadFile",
				"onLoadFile",
				"setViewData",
				"requestSave",
				"save",
			] as const) {
				const current = Object.getOwnPropertyDescriptor(view, name);
				const wrapper = wrappers.get(name);
				if (current === undefined || current.value !== wrapper) continue;
				const original = methods.get(name);
				if (original === undefined) continue;
				if (original.hadOwn) Object.defineProperty(view, name, original.descriptor);
				else Reflect.deleteProperty(view, name);
			}
			if (installedGuards.get(view)?.guard === guard) installedGuards.delete(view);
		},
		snapshot(): ManagedViewSaveGuard {
			return {
				leafId: leafIdOf(view),
				view,
				originalRequestSave: originalRequestSave as TextFileView["requestSave"],
				originalSave: originalSave as TextFileView["save"],
				installedRequestSave: installedRequestSave as TextFileView["requestSave"],
				installedSave: installedSave as TextFileView["save"],
				hostCapability,
				hostCapabilityState,
				saveEpoch,
				clearLoadCapability,
				mode: publicMode(mode),
				inFlight: new Map(
					Array.from(inFlightSaves, ([id, entry]) => [id, {
						file: entry.file,
						path: entry.path,
						startedAt: entry.startedAt,
					}] as const),
				),
				pendingTargetSave: false,
				pendingOwnedSave: pendingOwnedSave === null
					? null
					: { ...pendingOwnedSave },
					sourceUnload: sourceUnload === null
					? null
					: {
						receiptId: sourceUnload.receiptId,
						unloadId: sourceUnload.unloadId,
						file: sourceUnload.file,
						path: sourceUnload.path,
						state: sourceUnload.state,
						forcedSaveObserved: sourceUnload.forcedSaveObserved,
							cacheRetiredBeforeUnloadSettled:
								sourceUnload.cacheRetiredBeforeUnloadSettled,
						},
					pendingLoadEpoch,
					pendingDeferredLoadAdmission: pendingDeferredLoadAdmission === null
						? null
						: {
							ownerId: pendingDeferredLoadAdmission.ownerId,
							pendingLoadEpoch,
							targetFile: pendingDeferredLoadAdmission.targetFile,
							targetPath: pendingDeferredLoadAdmission.targetPathAtEntry,
							sourceUnloadReceiptId:
								pendingDeferredLoadAdmission.sourceRetirement.receiptId,
							sourceUnloadId:
								pendingDeferredLoadAdmission.sourceRetirement.unloadId,
							sourceFile: pendingDeferredLoadAdmission.sourceRetirement.file,
							sourcePath: pendingDeferredLoadAdmission.sourceRetirement.path,
							viewFileAtEntry: pendingDeferredLoadAdmission.viewFileAtEntry,
							viewPathAtEntry: pendingDeferredLoadAdmission.viewPathAtEntry,
						},
					pendingSourceUnloadDrain: pendingSourceUnloadDrain === null
						? null
						: {
							ownerId: pendingSourceUnloadDrain.ownerId,
							sourceFile: pendingSourceUnloadDrain.sourceFile,
							sourcePath: pendingSourceUnloadDrain.sourcePathAtEntry,
							viewFileAtEntry: pendingSourceUnloadDrain.viewFileAtEntry,
							viewPathAtEntry: pendingSourceUnloadDrain.viewPathAtEntry,
							nativeLoadEpochAtEntry:
								pendingSourceUnloadDrain.nativeLoadEpochAtEntry,
							pendingLoadEpochAtEntry:
								pendingSourceUnloadDrain.pendingLoadEpochAtEntry,
							saveEpochAtEntry: pendingSourceUnloadDrain.saveEpochAtEntry,
							preexistingSaveCount:
								pendingSourceUnloadDrain.preexistingSaveTails.length,
							expectedSaveEpochAfterDrain:
								pendingSourceUnloadDrain.expectedSaveEpochAfterDrain,
						},
					nativeLoadEpoch,
					pendingNativeHostLoadCount: inFlightLoads.size,
					nativeHostLoadAmbiguous: nativeHostLoadIsAmbiguous(),
					managedClearTombstoneEpoch,
					managedClearTombstoneActive: managedClearTombstone !== null,
					terminalHostLifecycle: terminalHostLifecycle === null
						? null
						: {
							ownerId: terminalHostLifecycle.ownerId,
							state: "blocked",
						},
					wrappersCurrent: saveWrappersCurrent(),
					loadWrappersCurrent: loadWrappersCurrent(),
				emergencySaveBlocked:
					emergencySaveFenceOwners.size > 0 && saveWrappersCurrent(),
			};
		},
	};
	installedGuards.set(view, {
		guard,
		wrappers,
		delegationFrames: new Map(),
		suppressRetiredSaveTail: () => reportSuppressed(currentFileOf(view)),
	});
	return { kind: "installed", guard };
}
