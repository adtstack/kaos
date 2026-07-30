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
	onLoadFileEntry(
		targetFile: TFile,
		sourceUnloadReceiptId: string,
	): ManagedHostSwitchTicket | null;
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
}>;

export interface TextFileViewHandoffGuard {
	beginBlockingHandoff(input: Readonly<{
		handoffGeneration: number;
		sourceLineagePath: string | null;
		targetPath: string;
	}>): void;
	markTargetProven(input: Readonly<{
		handoffGeneration: number;
		targetFile: TFile;
		certifiedContent: string;
	}>): boolean;
	reportHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean;
	reportHostLoadCompleted(receipt: HostLoadCompletionReceipt): boolean;
	isExactHostLoadDispatchActive(identity: ExactHostLoadDispatchIdentity): boolean;
	flushOwnedSave(): Promise<void>;
	cancelOwnedSave(): void;
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
};

type SourceUnloadRecord = {
	receiptId: string;
	unloadId: number;
	file: TFile;
	path: string;
	sourceContent: string | null;
	state: ManagedSourceUnloadSnapshot["state"];
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

type UnprovenTargetUnload = Readonly<{
	load: InFlightLoad | null;
	ticket: ManagedHostSwitchTicket;
	heldCandidate: PendingHostLoadCandidate | null;
	file: TFile;
	path: string;
	retiredSource: SourceUnloadRecord | null;
}>;

type LoadAmbiguityGroup = {
	id: number;
	activeLoadIds: Set<number>;
	expectedClearCount: number;
	observedClearCount: number;
};

type HostLoadAssociation = {
	loadId: number;
	ticket: ManagedHostSwitchTicket;
	targetPathAtEntry: string;
	hostLoadTokenId: string;
	incomingContent: string;
	loadStatus: "pending" | "fulfilled";
	candidate: PendingHostLoadCandidate | null;
	pendingReceipt: HostLoadCompletionReceipt | null;
	dispatchAmbiguous: boolean;
};

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
	let nextAmbiguityGroupId = 1;
	let nextSaveId = 1;
	let nextOwnedSaveJobId = 1;
	let nextSourceUnloadId = 1;
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
	const inFlightSaves = new Map<number, Readonly<{
		file: TFile | null;
		path: string | null;
		startedAt: number;
	}>>();
	const qaHeldLoadSettlements = EDITOR_HANDOFF_QA_ENABLED
		? new Map<number, Promise<"applied" | "rejected">>()
		: null;
	let latestLoad: InFlightLoad | null = null;
	let activeAmbiguityGroup: LoadAmbiguityGroup | null = null;
	let clearLoadCapability: "observable" | "clear-load-not-observable" = "observable";

	function isTicketCurrent(ticket: ManagedHostSwitchTicket): boolean {
		return callbackRef !== null
			&& callbackRef.isSessionCurrent(ticket.sessionId, ticket.handoffGeneration);
	}

	function invalidateAssociationsForLoad(loadId: number): void {
		for (const association of hostLoadAssociations.values()) {
			if (association.loadId === loadId) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
			}
		}
	}

	function markLoadAmbiguous(load: InFlightLoad): void {
		load.ambiguous = true;
		invalidateAssociationsForLoad(load.id);
		if (
			mode.kind === "blocking-handoff"
			&& mode.ticket === load.ticket
		) mode = { ...mode, ticket: null };
	}

	function loseClearLoadCapability(): void {
		if (clearLoadCapability === "clear-load-not-observable") return;
		clearLoadCapability = "clear-load-not-observable";
		latestLoad = null;
		activeAmbiguityGroup = null;
		hostLoadAssociations.clear();
		for (const load of inFlightLoads.values()) markLoadAmbiguous(load);
		if (mode.kind === "blocking-handoff") mode = { ...mode, ticket: null };
	}

	function addLoadToAmbiguityGroup(
		group: LoadAmbiguityGroup,
		load: InFlightLoad,
	): void {
		if (group.activeLoadIds.has(load.id)) return;
		group.activeLoadIds.add(load.id);
		group.expectedClearCount += 1;
		if (load.clearObserved) group.observedClearCount += 1;
		markLoadAmbiguous(load);
	}

	function ensureAmbiguityGroup(extraLoad?: InFlightLoad): LoadAmbiguityGroup {
		let group = activeAmbiguityGroup;
		if (group === null) {
			group = {
				id: nextAmbiguityGroupId++,
				activeLoadIds: new Set(),
				expectedClearCount: 0,
				observedClearCount: 0,
			};
			activeAmbiguityGroup = group;
		}
		for (const load of inFlightLoads.values()) addLoadToAmbiguityGroup(group, load);
		if (extraLoad !== undefined) addLoadToAmbiguityGroup(group, extraLoad);
		return group;
	}

	function exactLoadForSetViewData(): InFlightLoad | null {
		if (clearLoadCapability !== "observable" || inFlightLoads.size === 0) return null;
		if (
			activeAmbiguityGroup !== null
			|| inFlightLoads.size !== 1
		) {
			ensureAmbiguityGroup().observedClearCount += 1;
			return null;
		}
		const load = inFlightLoads.values().next().value as InFlightLoad | undefined;
		if (load === undefined || load.ambiguous) {
			ensureAmbiguityGroup().observedClearCount += 1;
			return null;
		}
		load.clearObserved = true;
		return isTicketCurrent(load.ticket)
			&& view.file === load.ticket.targetFile
			&& view.file.path === load.targetPathAtEntry
			? load
			: null;
	}

	function exactLoadForQaHold(): InFlightLoad | null {
		if (
			!EDITOR_HANDOFF_QA_ENABLED
			|| clearLoadCapability !== "observable"
			|| activeAmbiguityGroup !== null
			|| inFlightLoads.size !== 1
		) return null;
		const load = inFlightLoads.values().next().value as InFlightLoad | undefined;
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

	function forwardCompletionIfSettled(association: HostLoadAssociation): void {
		const receipt = association.pendingReceipt;
		if (
			association.loadStatus !== "fulfilled"
			|| receipt === null
			|| callbackRef === null
			|| !associationIsCurrent(association)
			|| !receiptMatchesAssociation(association, receipt)
		) return;
		association.pendingReceipt = null;
		hostLoadAssociations.delete(association.hostLoadTokenId);
		callbackRef.onHostLoadCompleted(receipt);
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
		inFlightLoads.delete(loadId);
		if (!fulfilled) markLoadAmbiguous(load);
		if (activeAmbiguityGroup?.activeLoadIds.has(loadId) === true) {
			const group = activeAmbiguityGroup;
			group.activeLoadIds.delete(loadId);
			if (group.activeLoadIds.size === 0) {
				activeAmbiguityGroup = null;
				if (group.observedClearCount < group.expectedClearCount) {
					loseClearLoadCapability();
				}
			}
		} else if (
			fulfilled
			&& !load.clearObserved
			&& isTicketCurrent(load.ticket)
		) {
			loseClearLoadCapability();
		}
		for (const association of hostLoadAssociations.values()) {
			if (association.loadId !== loadId) continue;
			if (!fulfilled || !associationIsCurrent(association)) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
				continue;
			}
			association.loadStatus = "fulfilled";
			forwardCompletionIfSettled(association);
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

	function isSourceCacheRetired(): boolean {
		const host = view as TextFileView & { lastSavedData?: unknown };
		return view.data === "" && host.lastSavedData === null;
	}

	function sourcePresentationMatchesRetirement(record: SourceUnloadRecord): boolean {
		return isSourceCacheRetired() || currentViewContent() === record.sourceContent;
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
		if (activeUnprovenTargetUnload !== null) return true;
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
		clearSourceUnloadExpiry();
	}

	function sourceUnloadProofFailure(record: SourceUnloadRecord): string | null {
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
			proofFailure = sourceUnloadProofFailure(record);
		}
		if (proofFailure !== null) {
			rejectSourceUnload(record);
			loseHostCapability(`source-unload-not-provable:${proofFailure}`);
			return;
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
			|| record.state !== "settled"
			|| record.consumed
			|| record.file.path !== record.path
			|| !record.forcedSaveObserved
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
			|| activeAmbiguityGroup !== null
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
			&& record.file.path === record.path
			&& record.sourceContent !== null
			&& record.forcedSaveObserved
			&& record.forcedSaveFile === record.file
			&& record.forcedSavePath === record.path
			&& record.forcedSaveContent === record.sourceContent;
	}

	type SourceRetirementRolloverEvidence =
		| Readonly<{ kind: "source-presentation" }>
		| Readonly<{
			kind: "held-target";
			proof: UnprovenTargetRolloverProof;
		}>;

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
			markLoadAmbiguous(unload.load);
			inFlightLoads.delete(unload.load.id);
		}
		if (latestLoad?.ticket === unload.ticket) latestLoad = null;
		for (const association of hostLoadAssociations.values()) {
			if (association.ticket === unload.ticket) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
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
			forcedSaveObserved: true,
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
				const rolled = rollSourceRetirementAcrossUnprovenTarget(unload);
				if (activeUnprovenTargetUnload === unload) activeUnprovenTargetUnload = null;
				if (!rolled) {
					loseHostCapability("source-unload-not-provable:unproven-target-source-lineage");
				}
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
		cancelOwnedSaveJob();
		if (originalCancellableRequestSave !== null) {
			originalCancellableRequestSave.cancel.call(originalCancellableRequestSave);
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
		const sourceRetirement = claimSourceUnloadForLoad(targetFile);
		const activeCallbacks = clearLoadCapability === "observable"
			&& sourceRetirement !== null
			? callbackRef
			: null;
		const targetPathAtEntry = targetFile.path;
		let loadId: number | null = null;
		let exactLoad: InFlightLoad | null = null;
		if (activeCallbacks !== null && sourceRetirement !== null) {
			const ticket = activeCallbacks.onLoadFileEntry(
				targetFile,
				sourceRetirement.receiptId,
			);
			if (
				ticket !== null
				&& ticket.sourceUnloadReceiptId === sourceRetirement.receiptId
				&& ticket.targetFile === targetFile
				&& ticket.targetFile.path === targetPathAtEntry
				&& activeCallbacks.isSessionCurrent(ticket.sessionId, ticket.handoffGeneration)
			) {
				for (const association of hostLoadAssociations.values()) {
					if (
						association.ticket.sessionId !== ticket.sessionId
						|| association.ticket.handoffGeneration !== ticket.handoffGeneration
						|| association.ticket.switchIntentSeq !== ticket.switchIntentSeq
					) hostLoadAssociations.delete(association.hostLoadTokenId);
				}
				loadId = nextLoadId++;
				const load: InFlightLoad = {
					id: loadId,
					ticket,
					targetPathAtEntry,
					ambiguous: false,
					clearObserved: false,
				};
				exactLoad = load;
				if (
					inFlightLoads.size > 0
					|| activeAmbiguityGroup !== null
				) ensureAmbiguityGroup(load);
				inFlightLoads.set(loadId, load);
				latestLoad = load;
				if (
					!load.ambiguous
					&& mode.kind === "blocking-handoff"
					&& mode.handoffGeneration === ticket.handoffGeneration
					&& mode.targetPath === targetPathAtEntry
				) {
					mode = { ...mode, ticket };
				}
			}
		}
		const continueOriginalLoad = (): Promise<void> => {
			try {
				const result = withRegisteredDelegation(
				"onLoadFile",
				installedOnLoadFile as RuntimeMethod,
				() => originalOnLoadFile.apply(view, [targetFile, ...args]) as Promise<void>,
				);
				if (typeof result === "object" && result !== null && typeof result.then === "function") {
					void result.then(
						() => settleLoad(loadId, true),
						() => settleLoad(loadId, false),
					);
				} else {
					settleLoad(loadId, true);
				}
				return result;
			} catch (error) {
				settleLoad(loadId, false);
				throw error;
			}
		};
		if (EDITOR_HANDOFF_QA_ENABLED && exactLoad !== null) {
			const load = exactLoad;
			const barrier = editorHandoffHostQaBarrierByView?.get(view);
			let continuation: Promise<void> | null = null;
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
						callbackRef === null
						|| inFlightLoads.get(load.id) !== load
						|| !isTicketCurrent(load.ticket)
						|| view.file !== load.ticket.targetFile
						|| view.file.path !== load.targetPathAtEntry
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
				return held.settlement.then(async (outcome) => {
					if (outcome === "rejected" && continuation === null) {
						settleLoad(load.id, false);
					}
					if (continuationFailure !== null) throw continuationFailure.error;
					if (continuation !== null) await continuation;
				});
			}
		}
		return continueOriginalLoad();
	};

	const installedSetViewData = function (
		this: TextFileView,
		incomingContent: string,
		clear: boolean,
		...args: unknown[]
	): void {
		if (activeHostLoadDispatch !== null) {
			activeHostLoadDispatch.dispatchAmbiguous = true;
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
						) return "rejected";
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
			if (load !== null) {
				const hostLoadTokenId = callbackRef.onSetViewDataEntry({
					ticket: load.ticket,
					incomingContent,
					clear: true,
				});
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
						dispatchAmbiguous: false,
					};
					hostLoadAssociations.set(hostLoadTokenId, newAssociation);
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
					newAssociation.dispatchAmbiguous = true;
				}
			}
			return result;
		} catch (error) {
			if (newAssociation !== null) {
				hostLoadAssociations.delete(newAssociation.hostLoadTokenId);
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
		if (hostCapabilityState !== "ready" || callbackRef === null) return;
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
			return runOwnedSave();
		},
		writable: false,
	});
	Object.defineProperty(installedRequestSave, "run", {
		configurable: true,
		enumerable: false,
		value: (...args: unknown[]) => {
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
		const invocationId = nextSaveId++;
		inFlightSaves.set(invocationId, {
			file: invocationFile,
			path: invocationFile?.path ?? null,
			startedAt: Date.now(),
		});
		const settle = (): void => {
			inFlightSaves.delete(invocationId);
		};
		try {
			const result = withRegisteredDelegation(
				"save",
				installedSave as RuntimeMethod,
				() => originalSave.apply(view, args) as Promise<void>,
			);
			if (typeof result === "object" && result !== null && typeof result.then === "function") {
				void result.then(settle, settle);
			} else {
				settle();
			}
			return { outcome: "delegated", result };
		} catch (error) {
			settle();
			throw error;
		}
	}

	const installedSave = function (
		this: TextFileView,
		...args: unknown[]
	): Promise<void> {
		if (callbackRef === null) {
			const replacement = registeredReplacement("save", installedSave as RuntimeMethod);
			if (replacement.kind === "route") {
				return Reflect.apply(replacement.wrapper, view, args) as Promise<void>;
			}
			if (replacement.kind === "inert") return Promise.resolve();
		}
		saveEpoch += 1;
		let settled = false;
		const noteSettlement = (): void => {
			if (settled) return;
			settled = true;
			saveEpoch += 1;
		};
		try {
			const invocationFile = currentFileOf(view);
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

	function becomeInert(): void {
		if (EDITOR_HANDOFF_QA_ENABLED) {
			editorHandoffHostQaBarrierByView?.get(view)?.invalidateGuard(leafIdOf(view));
			editorHandoffHostQaBarrierByView?.delete(view);
		}
		callbackRef = null;
		activeUnprovenTargetUnload = null;
		cancelOwnedSaveJob();
		clearSourceUnloadExpiry();
		latestLoad = null;
		activeAmbiguityGroup = null;
		inFlightLoads.clear();
		inFlightSaves.clear();
		hostLoadAssociations.clear();
		activeHostLoadDispatch = null;
		mode = { kind: "inert-pass-through" };
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
		markTargetProven(input): boolean {
			if (
				clearLoadCapability !== "observable"
				|| mode.kind !== "blocking-handoff"
				|| callbackRef === null
				|| mode.ticket === null
			) return false;
			const expectedMode = mode;
			const expectedTicket = mode.ticket;
			const activeCallbacks = callbackRef;
			if (expectedMode.handoffGeneration !== input.handoffGeneration) return false;
			if (expectedMode.targetPath !== input.targetFile.path) return false;
			if (expectedTicket.handoffGeneration !== input.handoffGeneration) return false;
			if (expectedTicket.targetFile !== input.targetFile) return false;
			if (!activeCallbacks.isSessionCurrent(expectedTicket.sessionId, input.handoffGeneration)) return false;
			if (view.file !== input.targetFile || view.file.path !== expectedMode.targetPath) return false;
			if (view.data !== input.certifiedContent) return false;
			const editorContent = view.getViewData();
			if (
				editorContent !== input.certifiedContent
				|| mode !== expectedMode
				|| callbackRef !== activeCallbacks
			) return false;
			if (!activeCallbacks.isSessionCurrent(
				expectedTicket.sessionId,
				input.handoffGeneration,
			)) return false;
			if (
				// Both host reads and the session callback are re-entrant boundaries.
				// Recheck the exact mode owner after each before releasing the gate.
				mode !== expectedMode
				|| callbackRef !== activeCallbacks
				|| view.file !== input.targetFile
				|| view.file.path !== expectedMode.targetPath
				|| view.data !== input.certifiedContent
			) return false;
			mode = { kind: "pass-through" };
			return true;
		},
		reportHostLoadCandidate(candidate): boolean {
			if (clearLoadCapability !== "observable") return false;
			const association = hostLoadAssociations.get(candidate.hostLoadTokenId);
			if (association === undefined || callbackRef === null) return false;
			if (!associationIsCurrent(association)) {
				hostLoadAssociations.delete(association.hostLoadTokenId);
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
			callbackRef.onHostLoadCandidate(candidate);
			return true;
		},
		reportHostLoadCompleted(receipt): boolean {
			if (clearLoadCapability !== "observable") return false;
			const association = hostLoadAssociations.get(receipt.hostLoadTokenId);
			if (
				association === undefined
				|| association.pendingReceipt !== null
				|| !associationIsCurrent(association)
				|| !receiptMatchesAssociation(association, receipt)
			) return false;
			association.pendingReceipt = receipt;
			forwardCompletionIfSettled(association);
			return true;
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
		markInert(): void {
			becomeInert();
		},
		restoreIfCurrent(): void {
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
					Array.from(inFlightSaves, ([id, entry]) => [id, { ...entry }] as const),
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
