import {
	Annotation,
	ChangeSet,
	Compartment,
	EditorState,
	Facet,
	Prec,
	StateEffect,
	Transaction,
	type Annotation as TransactionAnnotation,
	type EditorSelection,
	type Extension,
	type Text,
} from "@codemirror/state";
import { historyField } from "@codemirror/commands";
import { EditorView, showPanel, type Panel } from "@codemirror/view";
import type { TFile, TextFileView } from "obsidian";
import type {
	HandoffInputIntent,
	HostLoadCompletionReceipt,
	ManagedLeafSession,
	PendingHostLoadCandidate,
} from "./editorHandoffState";
import type {
	HandoffCompositionProof,
	HandoffReplayPermit,
} from "./editorHandoffReplay";

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;

export const handoffGateCompartment = new Compartment();

export const handoffGateClosedFacet = Facet.define<boolean, boolean>({
	combine: (values) => values.some(Boolean),
});

export const acceptedHostLoad = Annotation.define<Readonly<{
	hostLoadTokenId: string;
	sessionId: string;
	handoffGeneration: number;
}>>();

export const acceptedHandoffReplay = Annotation.define<Readonly<{
	permit: HandoffReplayPermit;
	frameIdentity: object;
}>>();

export type ManualHandoffInputReason =
	| "switch-spanning"
	| "composition-update-gap"
	| "missing-composition-end"
	| "unproven-final-successor";

export type RoutedHandoffInputIntent =
	| Readonly<{
		intent: HandoffInputIntent;
		disposition: "replay-candidate";
		reason: null;
	}>
	| Readonly<{
		intent: HandoffInputIntent;
		disposition: "manual-recovery";
		reason: ManualHandoffInputReason;
	}>;

export const capturedInputIntent = Annotation.define<RoutedHandoffInputIntent>();

const guardOwnedGateReconfiguration = Annotation.define<object>();

export type HandoffRecoveryGateAction =
	| "retry"
	| "continue-without-automatic-apply"
	| "retry-settlement"
	| "copy-and-continue"
	| "export-and-continue"
	| "discard-and-continue";

export type HandoffRecoveryGateModel = Readonly<{
	state:
		| "persisting"
		| "escape-pending"
		| "failed"
		| "stored"
		| "replay-pending"
		| "replayed-awaiting-settlement";
	message:
		| "Preserving interrupted input…"
		| "Completing the selected recovery action…"
		| "Interrupted input still needs a recovery choice."
		| "Waiting for a proven target before automatic apply…"
		| "Preparing one verified automatic apply…"
		| "Automatic apply is waiting for settlement verification…";
	actions: readonly HandoffRecoveryGateAction[];
}>;

export interface HandoffRecoveryGateCallbacks {
	onRetry(): void;
	onCopyAndContinue(): void;
	onExportAndContinue(): void;
	onDiscardAndContinue(): void;
	onContinueWithoutAutomaticApply(): void;
	onRetrySettlement(): void;
}

export function handoffRecoveryGateActions(
	state: HandoffRecoveryGateModel["state"],
): readonly HandoffRecoveryGateAction[] {
	switch (state) {
		case "failed":
			return ["retry", "copy-and-continue", "export-and-continue", "discard-and-continue"];
		case "persisting":
		case "escape-pending":
			return ["copy-and-continue", "export-and-continue", "discard-and-continue"];
		case "stored":
		case "replay-pending":
			return ["continue-without-automatic-apply"];
		case "replayed-awaiting-settlement":
			return ["retry-settlement", "continue-without-automatic-apply"];
	}
}

const HANDOFF_RECOVERY_ACTION_LABELS: Readonly<
	Record<HandoffRecoveryGateAction, string>
> = Object.freeze({
	"retry": "Retry",
	"copy-and-continue": "Copy and continue",
	"export-and-continue": "Export and continue",
	"discard-and-continue": "Discard and continue",
	"continue-without-automatic-apply": "Continue without automatic apply",
	"retry-settlement": "Retry settlement",
});

function invokeHandoffRecoveryGateAction(
	action: HandoffRecoveryGateAction,
	callbacks: HandoffRecoveryGateCallbacks,
): void {
	switch (action) {
		case "retry":
			callbacks.onRetry();
			return;
		case "copy-and-continue":
			callbacks.onCopyAndContinue();
			return;
		case "export-and-continue":
			callbacks.onExportAndContinue();
			return;
		case "discard-and-continue":
			callbacks.onDiscardAndContinue();
			return;
		case "continue-without-automatic-apply":
			callbacks.onContinueWithoutAutomaticApply();
			return;
		case "retry-settlement":
			callbacks.onRetrySettlement();
	}
}

function createHandoffRecoveryPanel(
	model: HandoffRecoveryGateModel,
	callbacks: HandoffRecoveryGateCallbacks | undefined,
): (view: EditorView) => Panel {
	const actions = handoffRecoveryGateActions(model.state);
	return (view) => {
		const document = view.dom.ownerDocument;
		const dom = document.createElement("div");
		dom.className = "kaos-handoff-recovery-gate";
		dom.setAttribute("role", "status");
		dom.setAttribute("aria-live", "polite");
		dom.setAttribute("aria-label", "Handoff recovery controls");
		const message = document.createElement("div");
		message.className = "kaos-handoff-recovery-gate-message";
		message.textContent = model.message;
		dom.appendChild(message);
		const controls = document.createElement("div");
		controls.className = "kaos-handoff-recovery-gate-actions";
		for (const action of actions) {
			const label = HANDOFF_RECOVERY_ACTION_LABELS[action];
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			button.setAttribute("aria-label", label);
			button.disabled = callbacks === undefined;
			if (callbacks) {
				button.addEventListener("click", () => {
					invokeHandoffRecoveryGateAction(action, callbacks);
				});
			}
			controls.appendChild(button);
		}
		dom.appendChild(controls);
		return { dom, top: true };
	};
}

function handoffRecoveryGateFingerprint(
	model: HandoffRecoveryGateModel | null,
): string {
	return model === null
		? "none"
		: `${model.state}:${model.message}:${handoffRecoveryGateActions(model.state).join(",")}`;
}

export type FinalDispatchDecision =
	| Readonly<{ kind: "forward"; transaction: Transaction }>
	| Readonly<{ kind: "hold-host-load"; candidate: PendingHostLoadCandidate }>
	| Readonly<{ kind: "capture-composition" }>
	| Readonly<{
		kind: "capture-intent";
		intent: HandoffInputIntent;
		effectOnly: Transaction;
	}>
	| Readonly<{
		kind: "reject";
		reason: "stale-generation" | "old-provider" | "ambiguous-editor-api";
		effectOnly: Transaction;
	}>;

export type ManagedLeafInputStartReservation = NonNullable<
	ManagedLeafSession["pendingInputStartReservation"]
>;

export type CodeMirrorHandoffContext =
	| Readonly<{
		kind: "same-path";
		sessionId: string;
		leafId: string;
		handoffGeneration: number;
		path: string;
	}>
	| Readonly<{
		kind: "handoff";
		sessionId: string;
		leafId: string;
		handoffGeneration: number;
		switchIntentSeq: number;
		sourceUnloadReceiptId: string;
		fromPath: string | null;
		fromFileId: string | null;
		targetPath: string;
		targetFile: TFile;
		runtimeView: TextFileView;
		bindingEpoch: number;
		editorRevisionBefore: number;
	}>;

export type CodeMirrorHandoffGuardCallbacks = Readonly<{
	getCurrentContext(): CodeMirrorHandoffContext | null;
	reserveManagedLeafInputStart(input: Readonly<{
		sessionId: string;
		expectedGeneration: number;
		inputEpoch: number;
		compositionEpoch: number | null;
	}>): ManagedLeafInputStartReservation | null;
	onHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean;
	onHostLoadCompleted(receipt: HostLoadCompletionReceipt): boolean;
	isExactHostStateReplacement(targetState: EditorState, input: ArmHostLoadInput): boolean;
	isExactHostLoadDispatchActive?(candidate: PendingHostLoadCandidate): boolean;
	onHostLoadCaptureRejected?(reason:
		| "context-mismatch"
		| "token-consumed"
		| "start-state-mismatch"
		| "not-full-replacement"
		| "native-history-reset-unproven"
		| "target-mismatch"
		| "runtime-data-mismatch"
		| "runtime-data-cas-failed"
		| "post-cas-context-mismatch"
		| "state-replacement-unproven"
		| "state-document-mismatch"
	): void;
	onInputIntent(routed: RoutedHandoffInputIntent): boolean;
	onSamePathInputCompleted?(input: Readonly<{
		reservation: ManagedLeafInputStartReservation;
		cm: EditorView;
		startDocument: Text;
		finalDocument: Text;
	}>): boolean;
	onNativeHistoryAdvanced?(input: Readonly<{
		cm: EditorView;
		startState: EditorState;
		finalState: EditorState;
		nativeHistoryEpochBefore: number;
		nativeHistoryEpochAfter: number;
	}>): void;
	onCompositionBoundary?(phase: "start" | "end"): void;
	isNativeHistoryReset(transaction: Transaction): boolean;
	observeNativeHistoryReset(view: EditorView, transaction: Transaction): boolean;
	hashContent(content: string): string;
	acceptHandoffReplayTransaction?(
		transaction: Transaction,
		boundary: "route" | "update",
	): boolean;
	getHandoffRecoveryGateModel?(): HandoffRecoveryGateModel | null;
	handoffRecoveryGateCallbacks?: HandoffRecoveryGateCallbacks;
	createId(prefix: string): string;
	now?(): number;
}>;

export type ArmHostLoadInput = Readonly<{
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
	bindingEpoch: number;
	editorRevisionBefore: number;
}>;

export type CodeMirrorHandoffGuardSnapshot = Readonly<{
	view: EditorView;
	inert: boolean;
	gateClosed: boolean;
	inputEpoch: number;
	compositionEpoch: number;
	nativeHistoryEpoch: number;
	selectionEpoch: number;
	scrollEpoch: number;
	activeComposition: null | Readonly<{
		compositionEpoch: number;
		startGeneration: number;
		updates: number;
		capturedUpdates: number;
		replayEligible: false;
	}>;
	lastComposition: null | Readonly<{
		compositionEpoch: number;
		startGeneration: number;
		endGeneration: number;
		updates: number;
		replayEligible: boolean;
	}>;
	gateFailureReason:
		| "pending-input-not-flushable"
		| "input-intent-not-acknowledged"
		| "gate-release-failed"
		| null;
	commitState: "none" | "pending" | "committing" | "committed" | "failed";
	commitFailureReason?:
		| "candidate-notification-invalid"
		| "commit-cancelled"
		| "completion-notification-invalid"
		| "pending-authority-stale"
		| "pending-held-identity-stale"
		| "pending-commit-state-stale"
		| "pending-context-stale"
		| "pending-cm-stale"
		| "pending-state-identity-stale"
		| "pending-document-identity-stale"
		| "pending-native-history-stale"
		| "pending-token-consumed"
		| "post-candidate-authority-stale"
		| "cache-authority-stale"
		| "post-cache-authority-stale"
		| "state-gate-reinstall-failed"
		| "host-apply-threw"
		| "host-apply-postconditions-failed"
		| "settlement-observation-failed"
		| null;
	gateAuthorityAdvanceFailureReason?: string | null;
	inputAuthorityAdvanceFailureReason?: string | null;
	hostPostDelegationFailureReason?: string | null;
	pendingHostLoadCandidate: PendingHostLoadCandidate | null;
}>;

export interface CodeMirrorHandoffGuard {
	/** Re-read the reducer-owned context and synchronously install/release the gate. */
	refreshGate(): boolean;
	/** Arm the exact one-shot Task 3 clear-load association before the host dispatches it. */
	armHostLoad(input: ArmHostLoadInput): boolean;
	/** Consume controller-owned opaque acceptance for the exact held candidate. */
	acceptHeldHostLoad(input: Readonly<{
		candidate: PendingHostLoadCandidate;
		presentationPlanId: string;
	}>): Promise<
		| Readonly<{ kind: "accepted"; receipt: HostLoadCompletionReceipt }>
		| Readonly<{
			kind: "pending-notification";
			notification: "candidate";
			candidate: PendingHostLoadCandidate;
		}>
		| Readonly<{
			kind: "pending-notification";
			notification: "completion";
			receipt: HostLoadCompletionReceipt;
		}>
		| Readonly<{
			kind: "rejected";
			reason: "stale-generation" | "old-provider" | "ambiguous-editor-api";
		}>
	>;
	/** Certify only the synchronous same-document tail of the exact host clear-load call. */
	certifyHostLoadPostDelegation(hostLoadTokenId: string): boolean;
	markInert(): boolean;
	restoreIfCurrent(): boolean;
	snapshot(): CodeMirrorHandoffGuardSnapshot;
}

export type CodeMirrorHandoffGuardInstallResult =
	| Readonly<{ kind: "installed"; guard: CodeMirrorHandoffGuard }>
	| Readonly<{
		kind: "unsupported";
			reason:
			| "id-factory-unavailable"
			| "dispatch-not-wrappable"
			| "destroy-not-wrappable"
			| "update-not-wrappable"
			| "set-state-not-wrappable"
			| "final-boundary-not-provable"
			| "pending-dom-input-not-capturable";
	}>;

type RuntimeMethod = (this: EditorView, ...args: unknown[]) => unknown;
type RuntimeMethodDescriptor = Omit<PropertyDescriptor, "value" | "get" | "set"> & Readonly<{
	value: RuntimeMethod;
}>;
type GuardedMethodName = "dispatch" | "update" | "dispatchTransactions" | "setState" | "destroy";
type LocatedMethod = Readonly<{
	name: GuardedMethodName;
	descriptor: RuntimeMethodDescriptor;
	hadOwn: boolean;
}>;
type RuntimeTransaction = Transaction & Readonly<{
	annotations: readonly TransactionAnnotation<unknown>[];
}>;
type RuntimeTransactionConstructor = typeof Transaction & Readonly<{
	create?: (
		startState: EditorState,
		changes: ChangeSet,
		selection: EditorSelection | undefined,
		effects: readonly StateEffect<unknown>[],
		annotations: readonly TransactionAnnotation<unknown>[],
		scrollIntoView: boolean,
	) => Transaction;
}>;
type RuntimeEditorState = EditorState & Readonly<{
	config?: Readonly<{ address?: Readonly<Record<number, number>> }>;
	values?: readonly unknown[];
}>;
type RuntimeStateField = Readonly<{ id?: number }>;
type RuntimeObserver = Readonly<{
	forceFlush: () => unknown;
	pendingRecords: () => readonly MutationRecord[];
}>;
type HandoffOriginContext = Extract<CodeMirrorHandoffContext, { kind: "handoff" }>;
type SamePathOriginContext = Extract<CodeMirrorHandoffContext, { kind: "same-path" }>;
type BeforeHandoffAssociation =
	| Readonly<{ kind: "not-applicable" }>
	| Readonly<{ kind: "unseen" }>
	| Readonly<{ kind: "candidate"; context: HandoffOriginContext }>
	| Readonly<{ kind: "associated"; context: HandoffOriginContext }>
	| Readonly<{ kind: "rejected" }>;
type InputSequence = {
	reservation: ManagedLeafInputStartReservation;
	startGeneration: number;
	compositionEpoch: number | null;
	originContext: HandoffOriginContext | null;
	samePathOriginContext: SamePathOriginContext | null;
	documentAtStart: Text;
	beforeHandoffAssociation: BeforeHandoffAssociation;
};
type CompositionSequence = {
	sequence: InputSequence;
	updates: number;
	lastCapturedUpdate: number;
	hasUpdateGap: boolean;
	authorityDrifted: boolean;
	nextProofSequence: number;
	firstCapturedInputSequence: number | null;
	lastCapturedInputSequence: number | null;
	lastProofTransaction: Transaction | null;
};
type PendingCompositionSuccessor = Readonly<{
	sequence: InputSequence;
	transaction: Transaction;
	updateAtCapture: number;
}>;
type PendingImplicitCompositionCommit = Readonly<{
	sequence: InputSequence;
	data: string;
}>;
type PendingInputDelivery = {
	routed: RoutedHandoffInputIntent;
	sequence: InputSequence;
	callbackAcknowledged: boolean;
	effectCaptured: boolean;
	effectTransaction: Transaction | null;
};
type ArmedHostLoad = Readonly<{
	input: ArmHostLoadInput;
	startState: EditorState;
	startDocument: Text;
	runtimeViewDataBefore: string;
}>;
type HeldHostLoad = Readonly<{
	candidate: PendingHostLoadCandidate;
	targetFile: TFile;
	targetPath: string;
	startStateAuthority: {
		state: EditorState;
		selectionEpoch: number;
		scrollEpoch: number;
		scrollTop: number;
		postDelegationCertified: boolean;
		presentationSettlementConsumed: boolean;
	};
}>;
type PendingCompositionNoopSettlement = Readonly<{
	held: HeldHostLoad;
	startState: EditorState;
	compositionEpoch: number | null;
	persistenceNeutralEffectConsumed: boolean;
}>;
type PreCompletionCompositionNoopSettlement = Readonly<{
	held: HeldHostLoad;
	composition: CompositionSequence;
	transaction: Transaction;
	compositionEpoch: number;
}>;
type HostLoadCommit =
	| {
		kind: "transaction";
		held: HeldHostLoad;
		acceptedTransaction: Transaction;
		startState: EditorState;
		routeSeen: boolean;
		updateSeen: boolean;
	}
	| {
		kind: "state";
		held: HeldHostLoad;
		hostState: EditorState;
		startState: EditorState;
		acceptedState: EditorState | null;
	};
type GuardOwnedGateReconfiguration = Readonly<{
	transaction: Transaction;
	effect: StateEffect<unknown>;
	nativeHistoryEpochBefore: number;
	selectionEpochBefore: number;
	scrollEpochBefore: number;
	scrollTopBefore: number;
}>;
type HostLoadNotificationPhase = "idle" | "delivering" | "failed" | "acknowledged";
type HostLoadNotificationResult = "pending" | "invalid" | "acknowledged";
type HostLoadCandidateNotification = {
	candidate: PendingHostLoadCandidate;
	phase: HostLoadNotificationPhase;
};
type PendingHostLoadCompletion = {
	held: HeldHostLoad;
	presentationPlanId: string;
	receipt: HostLoadCompletionReceipt;
	acceptedState: EditorState;
	phase: HostLoadNotificationPhase;
};
type InstalledEntry = Readonly<{
	guard: CodeMirrorHandoffGuard;
	wrappers: ReadonlyMap<GuardedMethodName, RuntimeMethod>;
}>;

const installedGuards = new WeakMap<EditorView, InstalledEntry>();
const effectIds = new WeakMap<object, number>();
const liveCompositionProofOwners = new WeakSet<object>();
const compositionProofByIntent = new WeakMap<
	HandoffInputIntent,
	Readonly<{ owner: object; proof: HandoffCompositionProof }>
>();

export function captureGuardOwnedHandoffCompositionProof(
	intent: HandoffInputIntent,
):
	| Readonly<{ kind: "ready"; proof: HandoffCompositionProof }>
	| Readonly<{ kind: "unavailable" }> {
	const entry = compositionProofByIntent.get(intent);
	return entry !== undefined && liveCompositionProofOwners.has(entry.owner)
		? frozen({ kind: "ready", proof: entry.proof })
		: frozen({ kind: "unavailable" });
}
let nextEffectId = 1;

function isExactSameSelectionHistorySettlement(transaction: Transaction): boolean {
	if (
		transaction.docChanged
		|| transaction.effects.length !== 0
		|| transaction.scrollIntoView
		|| transaction.reconfigured
		|| transaction.selection === undefined
		|| transaction.selection !== transaction.startState.selection
		|| transaction.newSelection !== transaction.startState.selection
		|| transaction.annotation(Transaction.remote) !== undefined
		|| transaction.annotation(Transaction.addToHistory) !== undefined
		|| transaction.annotation(Transaction.userEvent) !== undefined
		|| typeof transaction.annotation(Transaction.time) !== "number"
	) return false;
	const start = transaction.startState as RuntimeEditorState;
	const end = transaction.state as RuntimeEditorState;
	if (
		start.config === undefined
		|| end.config !== start.config
		|| !Array.isArray(start.values)
		|| !Array.isArray(end.values)
		|| start.values.length !== end.values.length
	) return false;
	const fieldId = (historyField as unknown as RuntimeStateField).id;
	const address = fieldId === undefined ? undefined : start.config.address?.[fieldId];
	if (
		address === undefined
		|| !Number.isSafeInteger(address)
		|| address < 0
		|| (address & 1) !== 0
	) return false;
	const historyIndex = address >> 1;
	const historyBefore = start.field(historyField, false);
	const historyAfter = end.field(historyField, false);
	if (
		historyBefore === undefined
		|| historyAfter === undefined
		|| historyBefore === historyAfter
		|| start.values[historyIndex] !== historyBefore
		|| end.values[historyIndex] !== historyAfter
	) return false;
	return start.values.every((value, index) =>
		index === historyIndex
			? value !== end.values?.[index]
			: value === end.values?.[index]);
}

function isExactTimeOnlyNoopTransaction(transaction: Transaction): boolean {
	const annotations = (transaction as RuntimeTransaction).annotations;
	const annotation = annotations[0];
	const start = transaction.startState as RuntimeEditorState;
	const end = transaction.state as RuntimeEditorState;
	return !transaction.docChanged
		&& transaction.state !== transaction.startState
		&& transaction.startState.doc === transaction.newDoc
		&& transaction.effects.length === 0
		&& !transaction.scrollIntoView
		&& !transaction.reconfigured
		&& transaction.selection === undefined
		&& transaction.newSelection === transaction.startState.selection
		&& annotations.length === 1
		&& annotation !== undefined
		&& annotation.type === Transaction.time
		&& typeof annotation.value === "number"
		&& start.config !== undefined
		&& end.config === start.config
		&& Array.isArray(start.values)
		&& Array.isArray(end.values)
		&& start.values.length === end.values.length
		&& start.values.every((value, index) => value === end.values?.[index]);
}

function isExactTimeAndVoidEffectTransaction(transaction: Transaction): boolean {
	const annotations = (transaction as RuntimeTransaction).annotations;
	const annotation = annotations[0];
	const effect = transaction.effects[0];
	const start = transaction.startState as RuntimeEditorState;
	const end = transaction.state as RuntimeEditorState;
	return !transaction.docChanged
		&& transaction.state !== transaction.startState
		&& transaction.startState.doc === transaction.newDoc
		&& transaction.effects.length === 1
		&& effect !== undefined
		&& effect.value === undefined
		&& !transaction.scrollIntoView
		&& !transaction.reconfigured
		&& transaction.selection === undefined
		&& transaction.newSelection === transaction.startState.selection
		&& annotations.length === 1
		&& annotation !== undefined
		&& annotation.type === Transaction.time
		&& typeof annotation.value === "number"
		&& start.config !== undefined
		&& end.config === start.config
		&& Array.isArray(start.values)
		&& Array.isArray(end.values)
		&& start.values.length === end.values.length
		&& start.values.every((value, index) => value === end.values?.[index]);
}

function locateMethod(view: EditorView, name: GuardedMethodName): LocatedMethod | null {
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

function canInstall(view: EditorView, method: LocatedMethod): boolean {
	return method.hadOwn
		? method.descriptor.configurable === true || method.descriptor.writable === true
		: Object.isExtensible(view);
}

function wrapperDescriptor(method: LocatedMethod, wrapper: RuntimeMethod): PropertyDescriptor {
	if (method.hadOwn) return { ...method.descriptor, value: wrapper };
	return {
		configurable: true,
		enumerable: method.descriptor.enumerable ?? false,
		writable: true,
		value: wrapper,
	};
}

function runtimeObserver(view: EditorView): RuntimeObserver | null {
	const candidate = (view as unknown as { observer?: Partial<RuntimeObserver> }).observer;
	return candidate !== undefined
		&& typeof candidate.forceFlush === "function"
		&& typeof candidate.pendingRecords === "function"
		? candidate as RuntimeObserver
		: null;
}

type RuntimeDataDescriptor = Readonly<{
	configurable: boolean;
	enumerable: boolean;
	writable: true;
	value: string;
}>;

function runtimeDataDescriptor(view: TextFileView): RuntimeDataDescriptor | null {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(view, "data");
	} catch {
		return null;
	}
	return descriptor !== undefined
		&& "value" in descriptor
		&& typeof descriptor.value === "string"
		&& descriptor.writable === true
		&& typeof descriptor.configurable === "boolean"
		&& typeof descriptor.enumerable === "boolean"
		? descriptor as RuntimeDataDescriptor
		: null;
}

function runtimeData(view: TextFileView): string | null {
	return runtimeDataDescriptor(view)?.value ?? null;
}

function compareAndSetRuntimeData(
	view: TextFileView,
	expected: string,
	replacement: string,
): boolean {
	const before = runtimeDataDescriptor(view);
	if (before === null || before.value !== expected) return false;
	try {
		Object.defineProperty(view, "data", { ...before, value: replacement });
	} catch {
		return false;
	}
	const after = runtimeDataDescriptor(view);
	return after !== null
		&& after.value === replacement
		&& after.configurable === before.configurable
		&& after.enumerable === before.enumerable
		&& after.writable === before.writable;
}

function isExactContext(
	context: CodeMirrorHandoffContext | null,
	input: ArmHostLoadInput,
): context is Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
	return context?.kind === "handoff"
		&& context.sessionId === input.sessionId
		&& context.leafId === input.leafId
		&& context.handoffGeneration === input.handoffGeneration
		&& context.switchIntentSeq === input.switchIntentSeq
		&& context.sourceUnloadReceiptId === input.sourceUnloadReceiptId
		&& context.targetPath === input.targetPath
		&& context.targetFile === input.targetFile
		&& context.runtimeView === input.runtimeView
		&& context.bindingEpoch === input.bindingEpoch
		&& context.editorRevisionBefore === input.editorRevisionBefore;
}

function isSameHandoffContext(
	context: CodeMirrorHandoffContext | null,
	expected: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>,
): context is Extract<CodeMirrorHandoffContext, { kind: "handoff" }> {
	return context?.kind === "handoff"
		&& context.sessionId === expected.sessionId
		&& context.leafId === expected.leafId
		&& context.handoffGeneration === expected.handoffGeneration
		&& context.switchIntentSeq === expected.switchIntentSeq
		&& context.sourceUnloadReceiptId === expected.sourceUnloadReceiptId
		&& context.fromPath === expected.fromPath
		&& context.fromFileId === expected.fromFileId
		&& context.targetPath === expected.targetPath
		&& context.targetFile === expected.targetFile
		&& context.runtimeView === expected.runtimeView
		&& context.bindingEpoch === expected.bindingEpoch
		&& context.editorRevisionBefore === expected.editorRevisionBefore;
}

function isSamePathContext(
	context: CodeMirrorHandoffContext | null,
	expected: SamePathOriginContext,
): context is SamePathOriginContext {
	return context?.kind === "same-path"
		&& context.sessionId === expected.sessionId
		&& context.leafId === expected.leafId
		&& context.handoffGeneration === expected.handoffGeneration
		&& context.path === expected.path;
}

function effectFingerprint(transaction: Transaction): string {
	return transaction.effects.map((effect, index) => {
		let effectId = effectIds.get(effect);
		if (effectId === undefined) {
			effectId = nextEffectId++;
			effectIds.set(effect, effectId);
		}
		return `${index}:effect-${effectId}`;
	}).join("|");
}

function runtimeViewTargets(view: TextFileView, targetFile: TFile, targetPath: string): boolean {
	return view.file === targetFile
		&& view.file.path === targetPath
		&& targetFile.path === targetPath;
}

function isExactFullReplacement(transaction: Transaction, incomingContent: string): boolean {
	if (!transaction.docChanged || transaction.newDoc.toString() !== incomingContent) return false;
	let count = 0;
	let exact = false;
	transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
		count += 1;
		exact = fromA === 0
			&& toA === transaction.startState.doc.length
			&& fromB === 0
			&& toB === incomingContent.length
			&& inserted.toString() === incomingContent;
	});
	return count === 1 && exact;
}

function userEventOf(transaction: Transaction): HandoffInputIntent["userEvent"] {
	if (transaction.isUserEvent("delete")) return "delete";
	if (transaction.isUserEvent("input.paste")) return "paste";
	if (transaction.isUserEvent("input.drop") || transaction.isUserEvent("move.drop")) return "drop";
	if (transaction.isUserEvent("input")) return "input";
	return "other";
}

function isUserDocumentTransaction(transaction: Transaction): boolean {
	return transaction.isUserEvent("input")
		|| transaction.isUserEvent("delete")
		|| transaction.isUserEvent("move")
		|| transaction.isUserEvent("undo")
		|| transaction.isUserEvent("redo");
}

function insertedContent(changes: ChangeSet): string {
	let inserted = "";
	changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
		inserted += text.toString();
	});
	return inserted;
}

function frozen<const T extends object>(value: T): Readonly<T> {
	return Object.freeze(value);
}

export function installCodeMirrorHandoffGuard(
	view: EditorView,
	callbacks: CodeMirrorHandoffGuardCallbacks,
): CodeMirrorHandoffGuardInstallResult {
	const existing = installedGuards.get(view);
	if (existing !== undefined) return frozen({ kind: "installed", guard: existing.guard });
	if (typeof callbacks.createId !== "function") {
		return frozen({ kind: "unsupported", reason: "id-factory-unavailable" });
	}

	const dispatch = locateMethod(view, "dispatch");
	if (dispatch === null || !canInstall(view, dispatch)) {
		return frozen({ kind: "unsupported", reason: "dispatch-not-wrappable" });
	}
	const update = locateMethod(view, "update");
	if (update === null || !canInstall(view, update)) {
		return frozen({ kind: "unsupported", reason: "update-not-wrappable" });
	}
	const setState = locateMethod(view, "setState");
	if (setState === null || !canInstall(view, setState)) {
		return frozen({ kind: "unsupported", reason: "set-state-not-wrappable" });
	}
	const destroy = locateMethod(view, "destroy");
	if (destroy === null || !canInstall(view, destroy)) {
		return frozen({ kind: "unsupported", reason: "destroy-not-wrappable" });
	}
	const route = locateMethod(view, "dispatchTransactions");
	const transactionCreate = (Transaction as RuntimeTransactionConstructor).create;
	if (route === null || !canInstall(view, route) || typeof transactionCreate !== "function") {
		return frozen({ kind: "unsupported", reason: "final-boundary-not-provable" });
	}
	const observer = runtimeObserver(view);
	if (observer === null) {
		return frozen({ kind: "unsupported", reason: "pending-dom-input-not-capturable" });
	}
	const supportedObserver = observer;
	const exactTransactionCreate = transactionCreate;

	const methods = new Map<GuardedMethodName, LocatedMethod>([
		["dispatch", dispatch],
		["update", update],
		["dispatchTransactions", route],
		["setState", setState],
		["destroy", destroy],
	]);
	const originalDispatch = dispatch.descriptor.value;
	const originalUpdate = update.descriptor.value;
	const originalRoute = route.descriptor.value;
	const originalSetState = setState.descriptor.value;
	const originalDestroy = destroy.descriptor.value;
	const compositionProofOwner = Object.freeze({});
	let callbackRef: CodeMirrorHandoffGuardCallbacks | null = callbacks;
	let inert = false;
	let gateClosed = false;
	let gateConfigured = handoffGateCompartment.get(view.state) !== undefined;
	let gateModelFingerprint = gateConfigured ? "uninitialized" : "none";
	let inputEpoch = 0;
	let compositionEpoch = 0;
	let nativeHistoryEpoch = 0;
	let selectionEpoch = 0;
	let scrollEpoch = 0;
	let pendingInput: InputSequence | null = null;
	let activeComposition: CompositionSequence | null = null;
	let pendingCompositionSuccessor: PendingCompositionSuccessor | null = null;
	let pendingImplicitCompositionCommit: PendingImplicitCompositionCommit | null = null;
	let pendingInputDelivery: PendingInputDelivery | null = null;
	let gateReconfigurationDepth = 0;
	const gateReconfigurationLedger: GuardOwnedGateReconfiguration[] = [];
	let lastComposition: CodeMirrorHandoffGuardSnapshot["lastComposition"] = null;
	let armedHostLoad: ArmedHostLoad | null = null;
	let heldHostLoad: HeldHostLoad | null = null;
	let pendingCompositionNoopSettlement: PendingCompositionNoopSettlement | null = null;
	let preCompletionCompositionNoopSettlement: PreCompletionCompositionNoopSettlement | null = null;
	let hostLoadCandidateNotification: HostLoadCandidateNotification | null = null;
	let pendingHostLoadCompletion: PendingHostLoadCompletion | null = null;
	let commitState: CodeMirrorHandoffGuardSnapshot["commitState"] = "none";
	let commitFailureReason: CodeMirrorHandoffGuardSnapshot["commitFailureReason"] = null;
	let gateAuthorityAdvanceFailureReason: string | null = null;
	let inputAuthorityAdvanceFailureReason: string | null = null;
	let hostPostDelegationFailureReason: string | null = null;
	let activeCommit: HostLoadCommit | null = null;
	let gateFailureReason: CodeMirrorHandoffGuardSnapshot["gateFailureReason"] = null;
	let nativeInputDispatchSerial = 0;
	let lastNativeInputTransaction: Transaction | null = null;
	let originalUpdateDepth = 0;
	const consumedHostLoadTokens = new Set<string>();
	const observedHostPresentationSettlements = new WeakSet<Transaction>();
	const observedCompositionNoopSettlements = new WeakMap<
		Transaction,
		PendingCompositionNoopSettlement
	>();
	const observedPersistenceNeutralSettlements = new WeakMap<
		Transaction,
		PendingCompositionNoopSettlement
	>();
	function clearCompositionNoopSettlements(held?: HeldHostLoad): void {
		if (held === undefined || pendingCompositionNoopSettlement?.held === held) {
			pendingCompositionNoopSettlement = null;
		}
		if (held === undefined || preCompletionCompositionNoopSettlement?.held === held) {
			preCompletionCompositionNoopSettlement = null;
		}
	}
	const hostPresentationSettlementObserver = EditorView.updateListener.of((update) => {
		preCompletionCompositionNoopSettlement = null;
		const preCompletion = activeComposition;
		const preCompletionHeld = heldHostLoad;
		const preCompletionAuthority = preCompletionHeld?.startStateAuthority ?? null;
		const preCompletionCandidate = preCompletionHeld?.candidate ?? null;
		if (
			update.view === view
			&& preCompletion !== null
			&& preCompletionHeld !== null
			&& preCompletionAuthority !== null
			&& preCompletionCandidate !== null
			&& preCompletion.sequence.compositionEpoch !== null
			&& pendingInput === preCompletion.sequence
			&& pendingInputDelivery === null
			&& pendingCompositionSuccessor?.sequence === preCompletion.sequence
			&& pendingCompositionSuccessor.updateAtCapture === preCompletion.updates
			&& preCompletion.lastCapturedUpdate === preCompletion.updates
			&& commitState === "pending"
			&& preCompletionCandidate.applicationKind === "state"
			&& preCompletionAuthority.postDelegationCertified
			&& !update.focusChanged
			&& !update.selectionSet
			&& !update.viewportChanged
			&& !update.viewportMoved
			&& !update.heightChanged
			&& !update.geometryChanged
			&& !update.docChanged
			&& update.transactions.length === 1
		) {
			const transaction = update.transactions[0];
			if (
				transaction !== undefined
				&& transaction.startState === preCompletionAuthority.state
				&& transaction.startState === update.startState
				&& transaction.state === update.state
				&& transaction.state === view.state
				&& isExactTimeOnlyNoopTransaction(transaction)
				&& transaction.startState.doc === preCompletionCandidate.startDocument
				&& preCompletionCandidate.nativeHistoryEpochBefore === nativeHistoryEpoch
				&& preCompletionAuthority.selectionEpoch === selectionEpoch
				&& preCompletionAuthority.scrollEpoch === scrollEpoch
				&& preCompletionAuthority.scrollTop === view.scrollDOM.scrollTop
				&& !consumedHostLoadTokens.has(preCompletionCandidate.hostLoadTokenId)
				&& exactHeldTarget(preCompletionHeld)
				&& runtimeData(preCompletionCandidate.runtimeView)
					=== preCompletionCandidate.runtimeViewDataBefore
			) {
				preCompletionCompositionNoopSettlement = frozen({
					held: preCompletionHeld,
					composition: preCompletion,
					transaction,
					compositionEpoch: preCompletion.sequence.compositionEpoch,
				});
			}
		}
		const pendingNoop = pendingCompositionNoopSettlement;
		if (update.view === view && pendingNoop !== null) {
			const transaction = update.transactions[0];
			const gateEffect = transaction?.effects[0];
			const gateEffectValue = gateEffect?.value as Readonly<{
				compartment?: unknown;
			}> | undefined;
			const exactGuardOwnedGateTail = transaction !== undefined
				&& update.transactions.length === 1
				&& transaction.startState === pendingNoop.startState
				&& transaction.startState === update.startState
				&& transaction.state === update.state
				&& transaction.state === view.state
				&& !update.focusChanged
				&& !update.selectionSet
				&& !update.viewportChanged
				&& !update.viewportMoved
				&& !update.heightChanged
				&& !update.geometryChanged
				&& !update.docChanged
				&& transaction.effects.length === 1
				&& gateEffectValue?.compartment === handoffGateCompartment
				&& transaction.annotation(guardOwnedGateReconfiguration)
					=== compositionProofOwner;
			const exactTransactionFreeMeasurementTail =
				update.transactions.length === 0
				&& update.startState === pendingNoop.startState
				&& update.state === pendingNoop.startState
				&& view.state === pendingNoop.startState
				&& !update.focusChanged
				&& !update.selectionSet
				&& !update.viewportMoved
				&& !update.docChanged;
			pendingCompositionNoopSettlement =
				exactGuardOwnedGateTail || exactTransactionFreeMeasurementTail
					? pendingNoop
					: null;
		}
		const noopHeld = heldHostLoad;
		const noopAuthority = noopHeld?.startStateAuthority ?? null;
		const noopCandidate = noopHeld?.candidate ?? null;
		if (
			update.view === view
			&& pendingNoop !== null
			&& noopHeld !== null
			&& noopHeld === pendingNoop.held
			&& noopAuthority !== null
			&& noopCandidate !== null
			&& commitState === "pending"
			&& noopAuthority.postDelegationCertified
			&& noopAuthority.state === pendingNoop.startState
			&& activeComposition === null
			&& pendingInput === null
			&& pendingInputDelivery === null
			&& (
				pendingNoop.compositionEpoch === null
				|| (
					lastComposition?.compositionEpoch === pendingNoop.compositionEpoch
					&& lastComposition.replayEligible
				)
			)
			&& !update.focusChanged
			&& !update.selectionSet
			&& !update.viewportChanged
			&& !update.viewportMoved
			&& !update.heightChanged
			&& !update.geometryChanged
			&& !update.docChanged
			&& update.transactions.length === 1
		) {
			const transaction = update.transactions[0];
			if (
				transaction !== undefined
				&& transaction.startState === pendingNoop.startState
				&& transaction.startState === update.startState
				&& transaction.state === update.state
				&& transaction.state === view.state
				&& transaction.startState.doc === noopCandidate.startDocument
				&& noopCandidate.nativeHistoryEpochBefore === nativeHistoryEpoch
				&& noopAuthority.selectionEpoch === selectionEpoch
				&& noopAuthority.scrollEpoch === scrollEpoch
				&& noopAuthority.scrollTop === view.scrollDOM.scrollTop
				&& !consumedHostLoadTokens.has(noopCandidate.hostLoadTokenId)
				&& exactHeldTarget(noopHeld)
				&& runtimeData(noopCandidate.runtimeView) === noopCandidate.runtimeViewDataBefore
			) {
				if (isExactTimeOnlyNoopTransaction(transaction)) {
					observedCompositionNoopSettlements.set(transaction, pendingNoop);
				} else if (
					!pendingNoop.persistenceNeutralEffectConsumed
					&& isExactTimeAndVoidEffectTransaction(transaction)
				) {
					observedPersistenceNeutralSettlements.set(transaction, pendingNoop);
				}
			}
		}
		const authority = heldHostLoad?.startStateAuthority ?? null;
		if (
			update.view !== view
			|| authority === null
			|| !authority.postDelegationCertified
			|| authority.presentationSettlementConsumed
			|| !update.selectionSet
			|| update.focusChanged
			|| update.docChanged
			|| update.viewportChanged
			|| update.viewportMoved
			|| update.heightChanged
			|| update.geometryChanged
			|| update.transactions.length !== 1
		) return;
		const transaction = update.transactions[0];
		if (
			transaction !== undefined
			&& transaction.startState === update.startState
			&& transaction.state === update.state
			&& isExactSameSelectionHistorySettlement(transaction)
		) observedHostPresentationSettlements.add(transaction);
	});
	let listenersInstalled = true;

	function nextId(prefix: string): string {
		if (callbackRef === null) throw new Error("CodeMirror handoff guard is inert");
		return callbackRef.createId(prefix);
	}

	function annotationsOf(transaction: Transaction): readonly TransactionAnnotation<unknown>[] | null {
		const annotations = (transaction as RuntimeTransaction).annotations;
		return Array.isArray(annotations) ? annotations : null;
	}

	function createRawTransaction(input: Readonly<{
		startState: EditorState;
		changes: ChangeSet;
		selection: EditorSelection | undefined;
		effects: readonly StateEffect<unknown>[];
		annotations: readonly TransactionAnnotation<unknown>[];
		scrollIntoView: boolean;
	}>): Transaction | null {
		try {
			return exactTransactionCreate(
				input.startState,
				input.changes,
				input.selection,
				input.effects,
				input.annotations,
				input.scrollIntoView,
			);
		} catch {
			return null;
		}
	}

	function effectOnly(startState: EditorState, annotation?: TransactionAnnotation<unknown>): Transaction {
		const created = createRawTransaction({
			startState,
			changes: ChangeSet.empty(startState.doc.length),
			selection: undefined,
			effects: [],
			annotations: annotation === undefined ? [] : [annotation],
			scrollIntoView: false,
		});
		if (created === null || created.docChanged) {
			throw new TypeError("CodeMirror exact effect-only transaction capability unavailable");
		}
		return created;
	}

	function currentContext(): CodeMirrorHandoffContext | null {
		return callbackRef?.getCurrentContext() ?? null;
	}

	function startInputSequence(composition: number | null): void {
		const context = currentContext();
		if (context === null) {
			pendingInput = null;
			return;
		}
		inputEpoch += 1;
		const reservation = callbackRef?.reserveManagedLeafInputStart({
			sessionId: context.sessionId,
			expectedGeneration: context.handoffGeneration,
			inputEpoch,
			compositionEpoch: composition,
		}) ?? null;
		if (
			reservation === null
			|| reservation.inputEpoch !== inputEpoch
			|| reservation.compositionEpoch !== composition
		) {
			pendingInput = null;
			return;
		}
		const originContext = context.kind === "handoff"
			&& reservation.inputStartSeq > context.switchIntentSeq
			&& reservation.inputStartedUnderSwitchSeq === context.switchIntentSeq
			? frozen({ ...context })
			: null;
		const samePathOriginContext = context.kind === "same-path"
			? frozen({ ...context })
			: null;
		pendingInput = {
			reservation,
			startGeneration: context.handoffGeneration,
			compositionEpoch: composition,
			originContext,
			samePathOriginContext,
			documentAtStart: view.state.doc,
			beforeHandoffAssociation: samePathOriginContext === null
				? frozen({ kind: "not-applicable" })
				: frozen({ kind: "unseen" }),
		};
	}

	function isExactBeforeHandoffCandidate(
		sequence: InputSequence,
		context: HandoffOriginContext,
	): boolean {
		const samePath = sequence.samePathOriginContext;
		const reservation = sequence.reservation;
		return samePath !== null
			&& reservation.handoffGenerationAtStart === samePath.handoffGeneration
			&& reservation.handoffGenerationAtStart === sequence.startGeneration
			&& reservation.sourceAuthorityPathAtStart === samePath.path
			&& reservation.sourceFileAtStart !== null
			&& reservation.sourceFileAtStart.path === samePath.path
			&& reservation.sourceFileIdAtStart !== null
			&& reservation.sourceFileIdAtStart.length > 0
			&& reservation.sourceDocumentAtStart === sequence.documentAtStart
			&& reservation.targetPathAtStart === null
			&& reservation.targetFileAtStart === null
			&& reservation.inputEpoch >= 0
			&& reservation.compositionEpoch === sequence.compositionEpoch
			&& (
				reservation.inputStartedUnderSwitchSeq === null
				|| reservation.inputStartedUnderSwitchSeq < reservation.inputStartSeq
			)
			&& context.sessionId === samePath.sessionId
			&& context.leafId === samePath.leafId
			&& context.handoffGeneration === reservation.handoffGenerationAtStart + 1
			&& context.fromPath === reservation.sourceAuthorityPathAtStart
			&& context.fromFileId === reservation.sourceFileIdAtStart
			&& context.switchIntentSeq === reservation.inputStartSeq + 1
			&& context.targetFile.path === context.targetPath
			&& runtimeViewTargets(context.runtimeView, context.targetFile, context.targetPath);
	}

	function observeBeforeHandoffContext(
		sequence: InputSequence,
		context: CodeMirrorHandoffContext | null,
	): void {
		if (
			sequence.beforeHandoffAssociation.kind !== "unseen"
			|| context?.kind !== "handoff"
		) return;
		sequence.beforeHandoffAssociation = isExactBeforeHandoffCandidate(sequence, context)
			? frozen({ kind: "candidate", context: frozen({ ...context }) })
			: frozen({ kind: "rejected" });
	}

	function finalizeBeforeHandoffAssociation(
		sequence: InputSequence,
		transaction: Transaction,
	): void {
		const association = sequence.beforeHandoffAssociation;
		if (association.kind !== "candidate") return;
		sequence.beforeHandoffAssociation = sequence.reservation.sourceDocumentAtStart === transaction.startState.doc
			&& sequence.documentAtStart === transaction.startState.doc
			? frozen({ kind: "associated", context: association.context })
			: frozen({ kind: "rejected" });
	}

	function inputHandoffAuthority(sequence: InputSequence): HandoffOriginContext | null {
		if (sequence.originContext !== null) return sequence.originContext;
		return sequence.beforeHandoffAssociation.kind === "associated"
			? sequence.beforeHandoffAssociation.context
			: null;
	}

	function routedInput(
		intent: HandoffInputIntent,
		reason: ManualHandoffInputReason | null,
	): RoutedHandoffInputIntent {
		return reason === null
			? frozen({ intent, disposition: "replay-candidate", reason: null })
			: frozen({ intent, disposition: "manual-recovery", reason });
	}

	function bindCompletedCompositionProof(
		completed: CompositionSequence,
		intent: HandoffInputIntent,
		input: Readonly<{
			gapFree: boolean;
			finalSuccessorObserved: boolean;
			contextCurrent: boolean;
		}>,
	): void {
		const firstInputSeq = completed.firstCapturedInputSequence;
		const lastInputSeq = completed.lastCapturedInputSequence;
		const startedUnderSwitchSeq =
			completed.sequence.reservation.inputStartedUnderSwitchSeq;
		if (
			intent.compositionEpoch === null
			|| startedUnderSwitchSeq === null
			|| firstInputSeq === null
			|| lastInputSeq === null
			|| !input.gapFree
			|| !input.finalSuccessorObserved
			|| !input.contextCurrent
			|| completed.authorityDrifted
		) return;
		const endSeq = completed.nextProofSequence;
		completed.nextProofSequence += 1;
		const proof: HandoffCompositionProof = Object.freeze({
			compositionEpoch: intent.compositionEpoch,
			startedUnderSwitchSeq,
			firstInputSeq,
			lastInputSeq,
			endSeq,
			completed: true,
			gapFree: true,
			finalSuccessorObserved: true,
		});
		compositionProofByIntent.set(intent, Object.freeze({
			owner: compositionProofOwner,
			proof,
		}));
	}

	function finalizeInputDelivery(delivery: PendingInputDelivery): boolean {
		if (
			pendingInputDelivery !== delivery
			|| !delivery.callbackAcknowledged
			|| !delivery.effectCaptured
		) return false;
		pendingInputDelivery = null;
		if (pendingInput === delivery.sequence) pendingInput = null;
		if (activeComposition?.sequence === delivery.sequence) activeComposition = null;
		if (pendingCompositionSuccessor?.sequence === delivery.sequence) {
			pendingCompositionSuccessor = null;
		}
		if (pendingImplicitCompositionCommit?.sequence === delivery.sequence) {
			pendingImplicitCompositionCommit = null;
		}
		if (gateFailureReason === "input-intent-not-acknowledged") gateFailureReason = null;
		return true;
	}

	function stageInputDelivery(
		routed: RoutedHandoffInputIntent,
		sequence: InputSequence,
		startState: EditorState,
	): PendingInputDelivery | null {
		if (pendingInputDelivery !== null) {
			return pendingInputDelivery.sequence === sequence ? pendingInputDelivery : null;
		}
		const delivery: PendingInputDelivery = {
			routed,
			sequence,
			callbackAcknowledged: false,
			effectCaptured: false,
			effectTransaction: null,
		};
		try {
			delivery.effectTransaction = effectOnly(
				startState,
				capturedInputIntent.of(routed) as TransactionAnnotation<unknown>,
			);
		} catch {
			gateFailureReason = "pending-input-not-flushable";
			return null;
		}
		pendingInputDelivery = delivery;
		return delivery;
	}

	function acknowledgeInputDelivery(delivery: PendingInputDelivery): boolean {
		if (delivery.callbackAcknowledged) return true;
		try {
			delivery.callbackAcknowledged = callbackRef?.onInputIntent(delivery.routed) === true;
		} catch {
			delivery.callbackAcknowledged = false;
		}
		if (!delivery.callbackAcknowledged) {
			gateFailureReason = "input-intent-not-acknowledged";
		}
		return delivery.callbackAcknowledged;
	}

	function markInputEffectCaptured(transaction: Transaction): void {
		const delivery = pendingInputDelivery;
		if (delivery === null || delivery.effectTransaction !== transaction) return;
		const held = heldHostLoad;
		inputAuthorityAdvanceFailureReason = held === null
			? "held-missing"
			: commitState !== "pending"
				? "commit-state"
				: held.startStateAuthority.state !== transaction.startState
					? "start-state-identity"
					: !exactHeldTarget(held)
						? "context-lineage"
						: transaction.annotation(capturedInputIntent) !== delivery.routed
							? "annotation-identity"
							: transaction.docChanged
								? "document-changed"
								: transaction.effects.length !== 0
									? "effect-count"
									: transaction.startState.doc !== held.candidate.startDocument
										? "start-document-identity"
										: transaction.newDoc !== held.candidate.startDocument
											? "new-document-identity"
											: !transaction.startState.selection.eq(transaction.newSelection)
												? "selection"
												: transaction.scrollIntoView
													? "scroll-into-view"
													: held.candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
														? "native-history-epoch"
														: null;
		if (inputAuthorityAdvanceFailureReason === null && held !== null) {
			held.startStateAuthority.state = transaction.state;
		}
		delivery.effectCaptured = true;
		delivery.effectTransaction = null;
		finalizeInputDelivery(delivery);
	}

	function markGuardOwnedGateReconfiguration(transaction: Transaction): void {
		if (gateReconfigurationLedger.length === 0) return;
		if (!gateReconfigurationLedger.some((entry) => entry.transaction === transaction)) {
			gateAuthorityAdvanceFailureReason = "transaction-identity";
			if (pendingCompositionNoopSettlement?.startState === transaction.startState) {
				pendingCompositionNoopSettlement = null;
			}
			return;
		}
		const held = heldHostLoad;
		const pendingRebase = pendingCompositionNoopSettlement;
		let failure: string | null = held === null
			? "held-missing"
			: commitState !== "pending"
				? "commit-state"
				: null;
		let expectedStartState = held?.startStateAuthority.state ?? null;
		if (failure === null && held !== null) {
			for (const reconfiguration of gateReconfigurationLedger) {
				const candidate = reconfiguration.transaction;
				failure = candidate.startState !== expectedStartState
					? "start-state-identity"
					: candidate.annotation(guardOwnedGateReconfiguration)
						!== compositionProofOwner
						? "annotation-identity"
						: candidate.effects.length !== 1
							? "effect-count"
							: candidate.effects[0] !== reconfiguration.effect
								? "effect-identity"
								: candidate.docChanged
									? "document-changed"
									: candidate.startState.doc !== held.candidate.startDocument
										? "start-document-identity"
										: candidate.newDoc !== held.candidate.startDocument
											? "new-document-identity"
											: candidate.startState.selection !== candidate.newSelection
												? "selection-identity"
												: candidate.scrollIntoView
													? "scroll-into-view"
													: nativeHistoryEpoch
														!== reconfiguration.nativeHistoryEpochBefore
														? "native-history-epoch"
														: selectionEpoch !== reconfiguration.selectionEpochBefore
															? "selection-epoch"
															: scrollEpoch !== reconfiguration.scrollEpochBefore
																? "scroll-epoch"
																: view.scrollDOM.scrollTop !== reconfiguration.scrollTopBefore
																	? "scroll-top"
																	: null;
				if (failure !== null) break;
				expectedStartState = candidate.state;
			}
		}
		if (failure === null && expectedStartState !== view.state) {
			failure = "final-state-identity";
		}
		if (failure === null && held !== null && !exactHeldTarget(held)) {
			failure = "context-lineage";
		}
		if (
			failure === null
			&& held !== null
			&& runtimeData(held.candidate.runtimeView)
				!== held.candidate.runtimeViewDataBefore
		) {
			failure = "runtime-data";
		}
		gateAuthorityAdvanceFailureReason = failure;
		if (failure !== null || held === null || expectedStartState === null) {
			if (pendingCompositionNoopSettlement === pendingRebase) {
				pendingCompositionNoopSettlement = null;
			}
			return;
		}
		const canRebasePendingNoop = pendingRebase !== null
			&& pendingCompositionNoopSettlement === pendingRebase
			&& pendingRebase.held === held
			&& pendingRebase.startState === held.startStateAuthority.state;
		held.startStateAuthority.state = expectedStartState;
		gateReconfigurationLedger.splice(0, gateReconfigurationLedger.length);
		if (canRebasePendingNoop) {
			pendingCompositionNoopSettlement = frozen({
				...pendingRebase,
				startState: expectedStartState,
			});
		} else if (pendingCompositionNoopSettlement === pendingRebase) {
			pendingCompositionNoopSettlement = null;
		}
	}

	function markObservedHostPresentationSettlement(transaction: Transaction): void {
		if (!observedHostPresentationSettlements.delete(transaction)) return;
		const held = heldHostLoad;
		const candidate = held?.candidate ?? null;
		const authority = held?.startStateAuthority ?? null;
		if (
			held === null
			|| candidate === null
			|| authority === null
			|| commitState !== "pending"
			|| candidate.applicationKind !== "state"
			|| !authority.postDelegationCertified
			|| authority.presentationSettlementConsumed
			|| authority.state !== transaction.startState
			|| transaction.state !== view.state
			|| !isExactSameSelectionHistorySettlement(transaction)
			|| transaction.startState.doc !== candidate.startDocument
			|| transaction.newDoc !== candidate.startDocument
			|| transaction.annotation(capturedInputIntent) !== undefined
			|| transaction.annotation(guardOwnedGateReconfiguration) !== undefined
			|| transaction.annotation(acceptedHostLoad) !== undefined
			|| transaction.annotation(acceptedHandoffReplay) !== undefined
			|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
			|| consumedHostLoadTokens.has(candidate.hostLoadTokenId)
			|| !exactHeldTarget(held)
			|| runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore
		) return;
		authority.presentationSettlementConsumed = true;
		authority.state = transaction.state;
	}

	function markObservedCompositionNoopSettlement(transaction: Transaction): void {
		const pending = observedCompositionNoopSettlements.get(transaction);
		if (pending === undefined) return;
		observedCompositionNoopSettlements.delete(transaction);
		const held = heldHostLoad;
		const candidate = held?.candidate ?? null;
		const authority = held?.startStateAuthority ?? null;
		if (
			held === null
			|| held !== pending.held
			|| candidate === null
			|| authority === null
			|| commitState !== "pending"
			|| candidate.applicationKind !== "state"
			|| !authority.postDelegationCertified
			|| authority.state !== pending.startState
			|| transaction.startState !== pending.startState
			|| transaction.state !== view.state
			|| !isExactTimeOnlyNoopTransaction(transaction)
			|| transaction.startState.doc !== candidate.startDocument
			|| transaction.newDoc !== candidate.startDocument
			|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
			|| authority.selectionEpoch !== selectionEpoch
			|| authority.scrollEpoch !== scrollEpoch
			|| authority.scrollTop !== view.scrollDOM.scrollTop
			|| consumedHostLoadTokens.has(candidate.hostLoadTokenId)
			|| !exactHeldTarget(held)
			|| runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore
		) return;
		authority.state = transaction.state;
	}

	function markObservedPersistenceNeutralSettlement(transaction: Transaction): void {
		const pending = observedPersistenceNeutralSettlements.get(transaction);
		if (pending === undefined) return;
		observedPersistenceNeutralSettlements.delete(transaction);
		const held = heldHostLoad;
		const candidate = held?.candidate ?? null;
		const authority = held?.startStateAuthority ?? null;
		if (
			held === null
			|| held !== pending.held
			|| pending.persistenceNeutralEffectConsumed
			|| candidate === null
			|| authority === null
			|| commitState !== "pending"
			|| candidate.applicationKind !== "state"
			|| !authority.postDelegationCertified
			|| authority.state !== pending.startState
			|| transaction.startState !== pending.startState
			|| transaction.state !== view.state
			|| !isExactTimeAndVoidEffectTransaction(transaction)
			|| transaction.startState.doc !== candidate.startDocument
			|| transaction.newDoc !== candidate.startDocument
			|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
			|| authority.selectionEpoch !== selectionEpoch
			|| authority.scrollEpoch !== scrollEpoch
			|| authority.scrollTop !== view.scrollDOM.scrollTop
			|| consumedHostLoadTokens.has(candidate.hostLoadTokenId)
			|| !exactHeldTarget(held)
			|| runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore
			|| (
				pending.compositionEpoch !== null
				&& (
					lastComposition?.compositionEpoch !== pending.compositionEpoch
					|| !lastComposition.replayEligible
				)
			)
		) return;
		authority.state = transaction.state;
		pendingCompositionNoopSettlement = frozen({
			held,
			startState: transaction.state,
			compositionEpoch: pending.compositionEpoch,
			persistenceNeutralEffectConsumed: true,
		});
	}

	function adoptPreCompletionCompositionNoopSettlement(
		completed: CompositionSequence,
	): boolean {
		const observed = preCompletionCompositionNoopSettlement;
		preCompletionCompositionNoopSettlement = null;
		const held = heldHostLoad;
		const candidate = held?.candidate ?? null;
		const authority = held?.startStateAuthority ?? null;
		const transaction = observed?.transaction ?? null;
		const originContext = inputHandoffAuthority(completed.sequence);
		if (
			observed === null
			|| observed.composition !== completed
			|| observed.compositionEpoch !== completed.sequence.compositionEpoch
			|| transaction === null
			|| held === null
			|| held !== observed.held
			|| candidate === null
			|| authority === null
			|| commitState !== "pending"
			|| candidate.applicationKind !== "state"
			|| !authority.postDelegationCertified
			|| authority.state !== transaction.startState
			|| transaction.state !== view.state
			|| !isExactTimeOnlyNoopTransaction(transaction)
			|| transaction.startState.doc !== candidate.startDocument
			|| transaction.newDoc !== candidate.startDocument
			|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
			|| authority.selectionEpoch !== selectionEpoch
			|| authority.scrollEpoch !== scrollEpoch
			|| authority.scrollTop !== view.scrollDOM.scrollTop
			|| consumedHostLoadTokens.has(candidate.hostLoadTokenId)
			|| !exactHeldTarget(held)
			|| runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore
			|| activeComposition !== completed
			|| pendingInput !== completed.sequence
			|| pendingInputDelivery !== null
			|| originContext === null
			|| !isSameHandoffContext(currentContext(), originContext)
			|| lastComposition?.compositionEpoch !== observed.compositionEpoch
			|| !lastComposition.replayEligible
		) return false;
		authority.state = transaction.state;
		return true;
	}

	function armCompletedCompositionNoopSettlement(completed: CompositionSequence): void {
		const composition = lastComposition;
		const held = heldHostLoad;
		const completedEpoch = completed.sequence.compositionEpoch;
		if (
			completedEpoch === null
			|| composition === null
			|| composition.compositionEpoch !== completedEpoch
			|| !composition.replayEligible
			|| activeComposition !== null
			|| pendingInput !== null
			|| pendingInputDelivery !== null
			|| held === null
		) return;
		const candidate = held.candidate;
		const authority = held.startStateAuthority;
		if (
			commitState !== "pending"
			|| candidate.applicationKind !== "state"
			|| !authority.postDelegationCertified
			|| authority.state !== view.state
			|| inputAuthorityAdvanceFailureReason !== null
			|| candidate.startDocument !== view.state.doc
			|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
			|| authority.selectionEpoch !== selectionEpoch
			|| authority.scrollEpoch !== scrollEpoch
			|| authority.scrollTop !== view.scrollDOM.scrollTop
			|| consumedHostLoadTokens.has(candidate.hostLoadTokenId)
			|| !exactHeldTarget(held)
			|| runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore
		) return;
		const pending = frozen({
			held,
			startState: view.state,
			compositionEpoch: completedEpoch,
			persistenceNeutralEffectConsumed: false,
		});
		pendingCompositionNoopSettlement = pending;
	}

	function deliverPendingInput(delivery: PendingInputDelivery): boolean {
		acknowledgeInputDelivery(delivery);
		if (!delivery.effectCaptured) {
			if (
				delivery.effectTransaction === null
				|| delivery.effectTransaction.startState !== view.state
			) {
				try {
					delivery.effectTransaction = effectOnly(
						view.state,
						capturedInputIntent.of(delivery.routed) as TransactionAnnotation<unknown>,
					);
				} catch {
					gateFailureReason = "pending-input-not-flushable";
					return false;
				}
			}
			const effectTransaction = delivery.effectTransaction;
			try {
				view.dispatch(effectTransaction);
			} catch {
				if (!delivery.effectCaptured) delivery.effectTransaction = null;
			}
			if (!delivery.effectCaptured) {
				gateFailureReason = "pending-input-not-flushable";
				return false;
			}
		}
		return finalizeInputDelivery(delivery)
			|| (delivery.callbackAcknowledged && delivery.effectCaptured);
	}

	function settleStableSamePathComposition(
		completed: CompositionSequence,
		flushed: boolean,
		successor: PendingCompositionSuccessor | null,
		certifyNativeCompletion: boolean,
	): boolean {
		const sequence = completed.sequence;
		const samePathOrigin = sequence.samePathOriginContext;
		const context = currentContext();
		const completesOnOriginalSamePath = samePathOrigin !== null
			&& sequence.beforeHandoffAssociation.kind === "unseen"
			&& isSamePathContext(context, samePathOrigin);
		const completesOnHeldSourceAfterSelection = context?.kind === "handoff"
			&& (
				sequence.beforeHandoffAssociation.kind === "unseen"
				|| sequence.beforeHandoffAssociation.kind === "candidate"
			)
			&& isExactBeforeHandoffCandidate(sequence, context);
		if (
			inputHandoffAuthority(sequence) !== null
			|| samePathOrigin === null
			|| !flushed
			|| successor !== null
			|| (!completesOnOriginalSamePath && !completesOnHeldSourceAfterSelection)
		) return false;
		if (certifyNativeCompletion && callbackRef?.onSamePathInputCompleted) {
			let acknowledged = false;
			try {
				acknowledged = callbackRef.onSamePathInputCompleted({
					reservation: sequence.reservation,
					cm: view,
					startDocument: sequence.documentAtStart,
					finalDocument: view.state.doc,
				});
			} catch {
				acknowledged = false;
			}
			const completionContext = currentContext();
			const completionStillOnHeldSource = completesOnHeldSourceAfterSelection
				&& completionContext?.kind === "handoff"
				&& isExactBeforeHandoffCandidate(sequence, completionContext);
			if (
				!acknowledged
				|| (
					!isSamePathContext(completionContext, samePathOrigin)
					&& !completionStillOnHeldSource
				)
			) {
				gateFailureReason = "pending-input-not-flushable";
				return false;
			}
		}
		lastComposition = frozen({
			compositionEpoch: sequence.compositionEpoch ?? compositionEpoch,
			startGeneration: sequence.startGeneration,
			endGeneration: context.handoffGeneration,
			updates: completed.updates,
			replayEligible: false,
		});
		activeComposition = null;
		pendingCompositionSuccessor = null;
		if (pendingImplicitCompositionCommit?.sequence === sequence) {
			pendingImplicitCompositionCommit = null;
		}
		if (pendingInput === sequence) pendingInput = null;
		gateFailureReason = null;
		callbackRef?.onCompositionBoundary?.("end");
		return true;
	}

	function routeMissingCompositionEnd(): boolean {
		if (pendingInputDelivery !== null) return deliverPendingInput(pendingInputDelivery);
		const completed = activeComposition;
		if (completed === null) return true;
		const flushed = flushPendingDom();
		const successor = pendingCompositionSuccessor;
		if (settleStableSamePathComposition(completed, flushed, successor, false)) return true;
		const authority = inputHandoffAuthority(completed.sequence);
		if (
			!flushed
			|| successor === null
			|| successor.sequence !== completed.sequence
			|| authority === null
		) {
			gateFailureReason = "pending-input-not-flushable";
			return false;
		}
		const intent = buildInputIntent(successor.transaction, completed.sequence);
		if (intent === null) {
			gateFailureReason = "pending-input-not-flushable";
			return false;
		}
		lastComposition = frozen({
			compositionEpoch: completed.sequence.compositionEpoch ?? compositionEpoch,
			startGeneration: completed.sequence.startGeneration,
			endGeneration: currentContext()?.handoffGeneration ?? -1,
			updates: completed.updates,
			replayEligible: false,
		});
		const delivery = stageInputDelivery(
			routedInput(intent, "missing-composition-end"),
			completed.sequence,
			view.state,
		);
		return delivery !== null && deliverPendingInput(delivery);
	}

	function preventUnroutableNativeInput(event: Event): void {
		if (event.cancelable) event.preventDefault();
		event.stopImmediatePropagation();
	}

	const beforeInputListener = (event: InputEvent): void => {
		if (inert) return;
		if (activeComposition !== null) {
			if (
				event.isComposing === false
				&& event.inputType === "insertText"
				&& typeof event.data === "string"
			) {
				pendingImplicitCompositionCommit = frozen({
					sequence: activeComposition.sequence,
					data: event.data,
				});
			}
			return;
		}
		if (pendingInputDelivery !== null && !deliverPendingInput(pendingInputDelivery)) {
			preventUnroutableNativeInput(event);
			return;
		}
		startInputSequence(null);
	};
	const compositionStartListener = (event: CompositionEvent): void => {
		if (inert) return;
		if (!routeMissingCompositionEnd()) {
			preventUnroutableNativeInput(event);
			return;
		}
		pendingImplicitCompositionCommit = null;
		compositionEpoch += 1;
		startInputSequence(compositionEpoch);
		if (pendingInput !== null) {
				activeComposition = {
					sequence: pendingInput,
					updates: 0,
					lastCapturedUpdate: 0,
					hasUpdateGap: false,
					authorityDrifted: pendingInput.originContext === null,
					nextProofSequence: pendingInput.reservation.inputStartSeq,
					firstCapturedInputSequence: null,
					lastCapturedInputSequence: null,
					lastProofTransaction: null,
			};
		}
		callbackRef?.onCompositionBoundary?.("start");
	};
	const compositionUpdateListener = (): void => {
		if (activeComposition === null) return;
		if (
			activeComposition.updates > 0
			&& activeComposition.lastCapturedUpdate !== activeComposition.updates
		) activeComposition.hasUpdateGap = true;
		activeComposition.updates += 1;
	};
	function completeActiveComposition(
		completed: CompositionSequence,
		finalData: string,
	): void {
		if (activeComposition !== completed) return;
		if (pendingImplicitCompositionCommit?.sequence === completed.sequence) {
			pendingImplicitCompositionCommit = null;
		}
		if (pendingInputDelivery !== null) {
			if (
				pendingInputDelivery.sequence !== completed.sequence
				|| !deliverPendingInput(pendingInputDelivery)
			) {
				gateFailureReason = pendingInputDelivery.callbackAcknowledged === false
					? "input-intent-not-acknowledged"
					: "pending-input-not-flushable";
			}
			return;
		}
		const flushed = flushPendingDom();
		const successor = pendingCompositionSuccessor;
		const context = currentContext();
		const sequence = completed.sequence;
		const originContext = inputHandoffAuthority(sequence);
		const endGeneration = context?.handoffGeneration ?? -1;
		if (settleStableSamePathComposition(completed, flushed, successor, true)) return;
		if (
			successor === null
			|| successor.sequence !== sequence
			|| originContext === null
		) {
			lastComposition = frozen({
				compositionEpoch: sequence.compositionEpoch ?? compositionEpoch,
				startGeneration: sequence.startGeneration,
				endGeneration,
				updates: completed.updates,
				replayEligible: false,
			});
			gateFailureReason = "pending-input-not-flushable";
			return;
		}
		const updateGap = completed.hasUpdateGap
			|| completed.lastCapturedUpdate !== completed.updates
			|| successor.updateAtCapture !== completed.updates;
		const switchSpanning = completed.authorityDrifted
			|| !isSameHandoffContext(context, originContext)
			|| sequence.startGeneration !== originContext.handoffGeneration
			|| sequence.reservation.inputStartSeq <= originContext.switchIntentSeq
			|| sequence.reservation.inputStartedUnderSwitchSeq !== originContext.switchIntentSeq;
		const finalSuccessorProven = flushed
			&& completed.updates > 0
			&& insertedContent(successor.transaction.changes) === finalData;
		const reason: ManualHandoffInputReason | null = updateGap
			? "composition-update-gap"
			: switchSpanning
				? "switch-spanning"
				: !finalSuccessorProven
					? "unproven-final-successor"
					: null;
		const replayEligible = reason === null;
		lastComposition = frozen({
			compositionEpoch: sequence.compositionEpoch ?? compositionEpoch,
			startGeneration: sequence.startGeneration,
			endGeneration,
			updates: completed.updates,
			replayEligible,
		});
		const intent = buildInputIntent(successor.transaction, sequence);
		if (intent === null) {
			gateFailureReason = "pending-input-not-flushable";
			return;
		}
		bindCompletedCompositionProof(completed, intent, {
			gapFree: !updateGap,
			finalSuccessorObserved: finalSuccessorProven,
			contextCurrent: !switchSpanning,
		});
		const preCompletionNoopAdopted = replayEligible
			&& adoptPreCompletionCompositionNoopSettlement(completed);
		if (!replayEligible) preCompletionCompositionNoopSettlement = null;
		const delivery = stageInputDelivery(
			routedInput(intent, reason),
			sequence,
			view.state,
		);
		const delivered = delivery !== null && deliverPendingInput(delivery);
		if (!delivered) {
			gateFailureReason = delivery?.callbackAcknowledged === false
				? "input-intent-not-acknowledged"
				: "pending-input-not-flushable";
		} else if (replayEligible && !preCompletionNoopAdopted) {
			armCompletedCompositionNoopSettlement(completed);
		}
	}
	const compositionEndListener = (event: CompositionEvent): void => {
		const completed = activeComposition;
		if (completed === null) return;
		completeActiveComposition(completed, event.data);
	};
	const scrollListener = (): void => {
		if (!inert) scrollEpoch += 1;
	};

	function installListeners(): void {
		view.contentDOM.addEventListener("beforeinput", beforeInputListener, true);
		view.contentDOM.addEventListener("compositionstart", compositionStartListener, true);
		view.contentDOM.addEventListener("compositionupdate", compositionUpdateListener, true);
		view.contentDOM.addEventListener("compositionend", compositionEndListener, true);
		view.scrollDOM.addEventListener("scroll", scrollListener, true);
	}

	function removeListeners(): void {
		if (!listenersInstalled) return;
		listenersInstalled = false;
		view.contentDOM.removeEventListener("beforeinput", beforeInputListener, true);
		view.contentDOM.removeEventListener("compositionstart", compositionStartListener, true);
		view.contentDOM.removeEventListener("compositionupdate", compositionUpdateListener, true);
		view.contentDOM.removeEventListener("compositionend", compositionEndListener, true);
		view.scrollDOM.removeEventListener("scroll", scrollListener, true);
	}

	function buildInputIntent(
		transaction: Transaction,
		sequence: InputSequence | null = pendingInput,
	): HandoffInputIntent | null {
		const activeCallbacks = callbackRef;
		const context = sequence === null ? null : inputHandoffAuthority(sequence);
		if (sequence === null || context === null || activeCallbacks === null) return null;
		const reservation = sequence.reservation;
		const beforeHandoff = sequence.originContext === null
			&& sequence.beforeHandoffAssociation.kind === "associated";
		let startDocument = transaction.startState.doc;
		if (beforeHandoff) {
			const reservedDocument = reservation.sourceDocumentAtStart;
			if (reservedDocument === null || reservedDocument !== transaction.startState.doc) return null;
			startDocument = reservedDocument;
		}
		const afterContent = transaction.newDoc.toString();
		const sequenceBegan = beforeHandoff
			? "before-handoff"
			: reservation.inputStartSeq > context.switchIntentSeq
				&& reservation.inputStartedUnderSwitchSeq === context.switchIntentSeq
				? "after-target-selected"
				: "before-handoff";
		return frozen({
			intentId: nextId("handoff-intent"),
			sessionId: context.sessionId,
			leafId: context.leafId,
			handoffGeneration: context.handoffGeneration,
			fromPath: beforeHandoff ? reservation.sourceAuthorityPathAtStart : context.fromPath,
			fromFileId: beforeHandoff ? reservation.sourceFileIdAtStart : context.fromFileId,
			targetPath: context.targetPath,
			targetFile: context.targetFile,
			bindingEpoch: context.bindingEpoch,
			inputEpoch: reservation.inputEpoch,
			switchIntentSeq: context.switchIntentSeq,
			inputStartSeq: reservation.inputStartSeq,
			inputStartedUnderSwitchSeq: reservation.inputStartedUnderSwitchSeq,
			compositionEpoch: sequence.compositionEpoch,
			selectionEpoch,
			sequenceBegan,
			startDocument,
			startContentHash: activeCallbacks.hashContent(startDocument.toString()),
			changes: transaction.changes,
			afterContent,
			afterContentHash: activeCallbacks.hashContent(afterContent),
			selectionBefore: transaction.startState.selection,
			selectionAfter: transaction.newSelection,
			originKind: sequence.compositionEpoch === null ? "user" : "ime",
			userEvent: userEventOf(transaction),
			capturedAt: activeCallbacks.now?.() ?? Date.now(),
		});
	}

	function exactHeldTarget(held: HeldHostLoad): boolean {
		const context = currentContext();
		const candidate = held.candidate;
		return context?.kind === "handoff"
			&& context.sessionId === candidate.sessionId
			&& context.leafId === candidate.leafId
			&& context.handoffGeneration === candidate.handoffGeneration
			&& context.switchIntentSeq === candidate.switchIntentSeq
			&& context.targetPath === held.targetPath
			&& context.targetFile === held.targetFile
			&& context.runtimeView === candidate.runtimeView
			&& context.bindingEpoch === candidate.bindingEpoch
			&& runtimeViewTargets(candidate.runtimeView, held.targetFile, held.targetPath);
	}

	function exactPendingHeldAuthority(held: HeldHostLoad): boolean {
		const candidate = held.candidate;
		return heldHostLoad === held
			&& commitState === "pending"
			&& exactHeldTarget(held)
			&& candidate.cm === view
			&& held.startStateAuthority.state === view.state
			&& candidate.startDocument === view.state.doc
			&& candidate.nativeHistoryEpochBefore === nativeHistoryEpoch
			&& !consumedHostLoadTokens.has(candidate.hostLoadTokenId);
	}

	function explainPendingAuthorityStale(
		held: HeldHostLoad,
	): NonNullable<CodeMirrorHandoffGuardSnapshot["commitFailureReason"]> {
		const candidate = held.candidate;
		if (heldHostLoad !== held) return "pending-held-identity-stale";
		if (commitState !== "pending") return "pending-commit-state-stale";
		if (!exactHeldTarget(held)) return "pending-context-stale";
		if (candidate.cm !== view) return "pending-cm-stale";
		if (held.startStateAuthority.state !== view.state) {
			return "pending-state-identity-stale";
		}
		if (candidate.startDocument !== view.state.doc) {
			return "pending-document-identity-stale";
		}
		if (candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch) {
			return "pending-native-history-stale";
		}
		if (consumedHostLoadTokens.has(candidate.hostLoadTokenId)) {
			return "pending-token-consumed";
		}
		return "pending-authority-stale";
	}

	function exactPendingHeld(held: HeldHostLoad): boolean {
		return exactPendingHeldAuthority(held)
			&& runtimeData(held.candidate.runtimeView) === held.candidate.runtimeViewDataBefore;
	}

	function targetScopedRuntimeDataCas(
		held: HeldHostLoad,
		expected: string,
		replacement: string,
	): boolean {
		if (!exactHeldTarget(held)) return false;
		if (!compareAndSetRuntimeData(held.candidate.runtimeView, expected, replacement)) return false;
		return exactHeldTarget(held)
			&& runtimeData(held.candidate.runtimeView) === replacement;
	}

	function makeHeldHostLoad(
		transaction: Transaction,
		context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>,
	): HeldHostLoad | null {
		const armed = armedHostLoad;
		if (armed === null) return null;
		const reject = (reason: Parameters<NonNullable<
			CodeMirrorHandoffGuardCallbacks["onHostLoadCaptureRejected"]
		>>[0]): null => {
			callbackRef?.onHostLoadCaptureRejected?.(reason);
			return null;
		};
		if (!isExactContext(context, armed.input)) return reject("context-mismatch");
		if (consumedHostLoadTokens.has(armed.input.hostLoadTokenId)) return reject("token-consumed");
		if (
			transaction.startState !== armed.startState
			|| transaction.startState.doc !== armed.startDocument
		) return reject("start-state-mismatch");
		if (!isExactFullReplacement(transaction, armed.input.incomingContent)) {
			return reject("not-full-replacement");
		}
		if (callbackRef?.isNativeHistoryReset(transaction) !== true) {
			return reject("native-history-reset-unproven");
		}
		if (!runtimeViewTargets(
			armed.input.runtimeView,
			armed.input.targetFile,
			armed.input.targetPath,
		)) return reject("target-mismatch");
		if (runtimeData(armed.input.runtimeView) !== armed.input.incomingContent) {
			return reject("runtime-data-mismatch");
		}
		if (!compareAndSetRuntimeData(
			armed.input.runtimeView,
			armed.input.incomingContent,
			armed.runtimeViewDataBefore,
		)) return reject("runtime-data-cas-failed");
		if (
			!isExactContext(currentContext(), armed.input)
			|| !runtimeViewTargets(
			armed.input.runtimeView,
			armed.input.targetFile,
			armed.input.targetPath,
			)
		) return reject("post-cas-context-mismatch");
		const candidate = frozen({
			hostLoadTokenId: armed.input.hostLoadTokenId,
			hostLoadCompletedEpoch: null,
			sourceUnloadReceiptId: armed.input.sourceUnloadReceiptId,
			switchIntentSeq: armed.input.switchIntentSeq,
			sessionId: armed.input.sessionId,
			leafId: armed.input.leafId,
			handoffGeneration: armed.input.handoffGeneration,
			targetPathAtDispatch: armed.input.targetPath,
			cm: view,
			runtimeView: armed.input.runtimeView,
			startDocument: armed.startDocument,
			targetDocument: transaction.newDoc,
			incomingContent: armed.input.incomingContent,
			applicationKind: "transaction" as const,
			heldTransaction: transaction,
			heldState: null,
			hostSetViewDataClear: true,
			editorRevisionBefore: armed.input.editorRevisionBefore,
			nativeHistoryEpochBefore: nativeHistoryEpoch,
			proposedSelection: transaction.newSelection,
			proposedScrollAnchor: transaction.scrollIntoView
				? transaction.newSelection.main.head
				: null,
			effectFingerprint: effectFingerprint(transaction),
			runtimeViewDataBefore: armed.runtimeViewDataBefore,
			bindingEpoch: armed.input.bindingEpoch,
		});
		return frozen({
			candidate,
			targetFile: armed.input.targetFile,
			targetPath: armed.input.targetPath,
			startStateAuthority: {
				state: transaction.startState,
				selectionEpoch,
				scrollEpoch,
				scrollTop: view.scrollDOM.scrollTop,
				postDelegationCertified: false,
				presentationSettlementConsumed: false,
			},
		});
	}

	function makeHeldHostState(
		targetState: EditorState,
		context: Extract<CodeMirrorHandoffContext, { kind: "handoff" }>,
	): HeldHostLoad | null {
		const armed = armedHostLoad;
		if (armed === null) return null;
		const reject = (reason: Parameters<NonNullable<
			CodeMirrorHandoffGuardCallbacks["onHostLoadCaptureRejected"]
		>>[0]): null => {
			callbackRef?.onHostLoadCaptureRejected?.(reason);
			return null;
		};
		if (!isExactContext(context, armed.input)) return reject("context-mismatch");
		if (consumedHostLoadTokens.has(armed.input.hostLoadTokenId)) return reject("token-consumed");
		if (
			view.state !== armed.startState
			|| view.state.doc !== armed.startDocument
			|| targetState === armed.startState
		) return reject("start-state-mismatch");
		if (targetState.doc.toString() !== armed.input.incomingContent) {
			return reject("state-document-mismatch");
		}
		let exactHostReplacement = false;
		try {
			exactHostReplacement = callbackRef?.isExactHostStateReplacement(
				targetState,
				armed.input,
			) === true;
		} catch {
			exactHostReplacement = false;
		}
		if (!exactHostReplacement) return reject("state-replacement-unproven");
		if (!runtimeViewTargets(
			armed.input.runtimeView,
			armed.input.targetFile,
			armed.input.targetPath,
		)) return reject("target-mismatch");
		if (runtimeData(armed.input.runtimeView) !== armed.input.incomingContent) {
			return reject("runtime-data-mismatch");
		}
		if (!compareAndSetRuntimeData(
			armed.input.runtimeView,
			armed.input.incomingContent,
			armed.runtimeViewDataBefore,
		)) return reject("runtime-data-cas-failed");
		if (
			view.state !== armed.startState
			|| view.state.doc !== armed.startDocument
			|| !isExactContext(currentContext(), armed.input)
			|| !runtimeViewTargets(
				armed.input.runtimeView,
				armed.input.targetFile,
				armed.input.targetPath,
			)
		) return reject("post-cas-context-mismatch");
		const candidate = frozen({
			hostLoadTokenId: armed.input.hostLoadTokenId,
			hostLoadCompletedEpoch: null,
			sourceUnloadReceiptId: armed.input.sourceUnloadReceiptId,
			switchIntentSeq: armed.input.switchIntentSeq,
			sessionId: armed.input.sessionId,
			leafId: armed.input.leafId,
			handoffGeneration: armed.input.handoffGeneration,
			targetPathAtDispatch: armed.input.targetPath,
			cm: view,
			runtimeView: armed.input.runtimeView,
			startDocument: armed.startDocument,
			targetDocument: targetState.doc,
			incomingContent: armed.input.incomingContent,
			applicationKind: "state" as const,
			heldTransaction: null,
			heldState: targetState,
			hostSetViewDataClear: true as const,
			editorRevisionBefore: armed.input.editorRevisionBefore,
			nativeHistoryEpochBefore: nativeHistoryEpoch,
			proposedSelection: targetState.selection,
			proposedScrollAnchor: null,
			effectFingerprint: `state-effect-${nextEffectId++}`,
			runtimeViewDataBefore: armed.runtimeViewDataBefore,
			bindingEpoch: armed.input.bindingEpoch,
		});
		return frozen({
			candidate,
			targetFile: armed.input.targetFile,
			targetPath: armed.input.targetPath,
			startStateAuthority: {
				state: armed.startState,
				selectionEpoch,
				scrollEpoch,
				scrollTop: view.scrollDOM.scrollTop,
				postDelegationCertified: false,
				presentationSettlementConsumed: false,
			},
		});
	}

	function publishHeldHostLoad(held: HeldHostLoad): void {
		clearCompositionNoopSettlements();
		heldHostLoad = held;
		commitState = "pending";
		commitFailureReason = null;
		armedHostLoad = null;
		hostLoadCandidateNotification = {
			candidate: held.candidate,
			phase: "idle",
		};
		if (notifyHostLoadCandidate(held) === "invalid") {
			failCommit(held, "candidate-notification-invalid");
		}
	}

	function notifyHostLoadCandidate(held: HeldHostLoad): HostLoadNotificationResult {
		const notification = hostLoadCandidateNotification;
		if (notification === null || notification.candidate !== held.candidate) return "invalid";
		if (notification.phase === "acknowledged") return "acknowledged";
		if (notification.phase === "delivering") return "pending";
		if (!exactPendingHeld(held)) return "invalid";
		notification.phase = "delivering";
		let acknowledged = false;
		try {
			acknowledged = callbackRef?.onHostLoadCandidate(held.candidate) === true;
		} catch {
			acknowledged = false;
		}
		if (
			hostLoadCandidateNotification !== notification
			|| !exactPendingHeld(held)
		) {
			if (hostLoadCandidateNotification === notification) notification.phase = "failed";
			return "invalid";
		}
		notification.phase = acknowledged ? "acknowledged" : "failed";
		return acknowledged ? "acknowledged" : "pending";
	}

	function exactPendingHostLoadCompletion(pending: PendingHostLoadCompletion): boolean {
		const candidate = pending.held.candidate;
		return pendingHostLoadCompletion === pending
			&& heldHostLoad === pending.held
			&& commitState === "committed"
			&& exactHeldTarget(pending.held)
			&& view.state === pending.acceptedState
			&& view.state.doc.toString() === candidate.incomingContent
			&& view.state.selection.eq(pending.receipt.targetSelection)
			&& runtimeData(candidate.runtimeView) === candidate.incomingContent
			&& nativeHistoryEpoch === pending.receipt.nativeHistoryEpoch;
	}

	function notifyHostLoadCompletion(pending: PendingHostLoadCompletion): HostLoadNotificationResult {
		if (pending.phase === "acknowledged") return "acknowledged";
		if (pending.phase === "delivering") return "pending";
		if (!exactPendingHostLoadCompletion(pending)) return "invalid";
		pending.phase = "delivering";
		let acknowledged = false;
		try {
			acknowledged = callbackRef?.onHostLoadCompleted(pending.receipt) === true;
		} catch {
			acknowledged = false;
		}
		if (!exactPendingHostLoadCompletion(pending)) {
			if (pendingHostLoadCompletion === pending) pending.phase = "failed";
			return "invalid";
		}
		pending.phase = acknowledged ? "acknowledged" : "failed";
		return acknowledged ? "acknowledged" : "pending";
	}

	function commitBoundaryDecision(
		transaction: Transaction,
		boundary: "route" | "update",
	): FinalDispatchDecision | null {
		const commit = activeCommit;
		if (
			commitState !== "committing"
			|| commit === null
			|| commit.kind !== "transaction"
			|| transaction !== commit.acceptedTransaction
		) return null;
		const candidate = commit.held.candidate;
		const exact = heldHostLoad === commit.held
			&& exactHeldTarget(commit.held)
			&& view.state === commit.startState
			&& transaction.startState === commit.startState
			&& candidate.nativeHistoryEpochBefore === nativeHistoryEpoch
			&& runtimeData(candidate.runtimeView) === candidate.incomingContent;
		if (!exact) {
			return frozen({
				kind: "reject",
				reason: "stale-generation",
				effectOnly: effectOnly(view.state),
			});
		}
		if (boundary === "route") {
			if (commit.routeSeen) {
				return frozen({
					kind: "reject",
					reason: "ambiguous-editor-api",
					effectOnly: effectOnly(view.state),
				});
			}
			commit.routeSeen = true;
		} else {
			if (!commit.routeSeen || commit.updateSeen) {
				return frozen({
					kind: "reject",
					reason: "ambiguous-editor-api",
					effectOnly: effectOnly(view.state),
				});
			}
			commit.updateSeen = true;
		}
		return frozen({ kind: "forward", transaction });
	}

	function captureActiveCompositionTransaction(
		transaction: Transaction,
		context: CodeMirrorHandoffContext | null,
	): boolean {
		const completed = activeComposition;
		if (
			!isUserDocumentTransaction(transaction)
			|| completed === null
			|| pendingInput !== completed.sequence
			|| completed.sequence.compositionEpoch === null
		) return false;
		observeBeforeHandoffContext(completed.sequence, context);
		finalizeBeforeHandoffAssociation(completed.sequence, transaction);
		const authority = inputHandoffAuthority(completed.sequence);
		if (authority === null) return false;

		nativeInputDispatchSerial += 1;
		lastNativeInputTransaction = transaction;
		completed.lastCapturedUpdate = completed.updates;
		if (completed.lastProofTransaction !== transaction) {
			const capturedSequence = completed.nextProofSequence;
			completed.nextProofSequence += 1;
			completed.firstCapturedInputSequence ??= capturedSequence;
			completed.lastCapturedInputSequence = capturedSequence;
			completed.lastProofTransaction = transaction;
		}
		if (!isSameHandoffContext(context, authority)) {
			completed.authorityDrifted = true;
		}
		pendingCompositionSuccessor = frozen({
			sequence: completed.sequence,
			transaction,
			updateAtCapture: completed.updates,
		});
		const implicitCommit = pendingImplicitCompositionCommit;
		if (
			implicitCommit !== null
			&& implicitCommit.sequence === completed.sequence
			&& insertedContent(transaction.changes) === implicitCommit.data
		) {
			queueMicrotask(() => {
				if (
					activeComposition === completed
					&& pendingImplicitCompositionCommit === implicitCommit
					&& pendingCompositionSuccessor?.transaction === transaction
				) {
					completeActiveComposition(completed, implicitCommit.data);
				}
			});
		}
		return true;
	}

	function decide(
		transaction: Transaction,
		boundary: "route" | "update",
	): FinalDispatchDecision {
		const commitDecision = commitBoundaryDecision(transaction, boundary);
		if (commitDecision !== null) return commitDecision;
		if (
			transaction.docChanged
			&& callbackRef?.acceptHandoffReplayTransaction?.(
				transaction,
				boundary,
			) === true
		) {
			return frozen({ kind: "forward", transaction });
		}
		const context = currentContext();
		if (!transaction.docChanged) return frozen({ kind: "forward", transaction });
		const userDocumentTransaction = isUserDocumentTransaction(transaction);
		if (userDocumentTransaction && pendingInputDelivery !== null) {
			return frozen({
				kind: "reject",
				reason: "ambiguous-editor-api",
				effectOnly: effectOnly(transaction.startState),
			});
		}
		if (captureActiveCompositionTransaction(transaction, context)) {
			return frozen({ kind: "capture-composition" });
		}
		if (userDocumentTransaction) {
			nativeInputDispatchSerial += 1;
			lastNativeInputTransaction = transaction;
		}
		if (pendingInput !== null) {
			observeBeforeHandoffContext(pendingInput, context);
			if (userDocumentTransaction) {
				finalizeBeforeHandoffAssociation(pendingInput, transaction);
			}
		}
		if (context?.kind === "same-path") return frozen({ kind: "forward", transaction });
		if (context === null) {
			return frozen({
				kind: "reject",
				reason: "ambiguous-editor-api",
				effectOnly: effectOnly(transaction.startState),
			});
		}
		const held = makeHeldHostLoad(transaction, context);
		if (held !== null) {
			publishHeldHostLoad(held);
			return frozen({ kind: "hold-host-load", candidate: held.candidate });
		}
		if (userDocumentTransaction) {
			const intent = buildInputIntent(transaction);
			if (intent !== null) {
				const routeReason: ManualHandoffInputReason | null = intent.sequenceBegan === "after-target-selected"
					&& pendingInput !== null
					&& pendingInput.originContext !== null
					&& isSameHandoffContext(context, pendingInput.originContext)
					? null
					: "switch-spanning";
				const delivery = stageInputDelivery(
					routedInput(intent, routeReason),
					pendingInput as InputSequence,
					transaction.startState,
				);
				if (delivery === null || delivery.effectTransaction === null) {
					return frozen({
						kind: "reject",
						reason: "ambiguous-editor-api",
						effectOnly: effectOnly(transaction.startState),
					});
				}
				acknowledgeInputDelivery(delivery);
				return frozen({
					kind: "capture-intent",
					intent,
					effectOnly: delivery.effectTransaction,
				});
			}
		}
		return frozen({
			kind: "reject",
			reason: transaction.annotation(Transaction.remote) === true ? "old-provider" : "ambiguous-editor-api",
			effectOnly: effectOnly(transaction.startState),
		});
	}

	function guardedTransactions(
		transactions: readonly Transaction[],
		apply: (safe: readonly Transaction[]) => unknown,
		accountEpochs: boolean,
		boundary: "route" | "update",
	): unknown {
		if (inert || callbackRef === null) return apply(transactions);
		const safe: Transaction[] = [];
		let expectedState = view.state;
		for (const transaction of transactions) {
			if (transaction.startState !== expectedState) {
				safe.push(effectOnly(expectedState));
				break;
			}
			const decision = decide(transaction, boundary);
			switch (decision.kind) {
				case "forward":
					safe.push(decision.transaction);
					expectedState = decision.transaction.state;
					continue;
				case "capture-intent":
				case "reject":
					safe.push(decision.effectOnly);
					break;
				case "capture-composition":
				case "hold-host-load":
					break;
			}
			break;
		}
		if (safe.length === 0) return undefined;
		const stateBefore = view.state;
		const selectionBefore = stateBefore.selection;
		const scrollBefore = view.scrollDOM.scrollTop;
		const nativeHistoryEpochBefore = nativeHistoryEpoch;
		const result = apply(safe);
		if (boundary === "update") {
			for (const transaction of safe) {
					markInputEffectCaptured(transaction);
					markGuardOwnedGateReconfiguration(transaction);
					markObservedHostPresentationSettlement(transaction);
					markObservedCompositionNoopSettlement(transaction);
					markObservedPersistenceNeutralSettlement(transaction);
				}
		}
		if (accountEpochs) {
			for (const transaction of safe) {
				if (transaction.docChanged) nativeHistoryEpoch += 1;
			}
			if (!selectionBefore.eq(view.state.selection)) selectionEpoch += 1;
			if (scrollBefore !== view.scrollDOM.scrollTop) scrollEpoch += 1;
			if (nativeHistoryEpoch !== nativeHistoryEpochBefore) {
				try {
					callbackRef?.onNativeHistoryAdvanced?.({
						cm: view,
						startState: stateBefore,
						finalState: view.state,
						nativeHistoryEpochBefore,
						nativeHistoryEpochAfter: nativeHistoryEpoch,
					});
				} catch {
					// A failed observer cannot cancel already-accepted editor input.
				}
			}
		}
		return result;
	}

	const installedDispatch = function (this: EditorView, ...args: unknown[]): unknown {
		return Reflect.apply(originalDispatch, view, args);
	};
	const installedRoute = function (
		this: EditorView,
		transactions: readonly Transaction[],
		target: EditorView,
	): unknown {
		return guardedTransactions(
			transactions,
			(safe) => Reflect.apply(originalRoute, view, [safe, target === view ? target : view]),
			false,
			"route",
		);
	};
	const applyOriginalUpdate = (safe: readonly Transaction[]): unknown => {
		originalUpdateDepth += 1;
		try {
			return Reflect.apply(originalUpdate, view, [safe]);
		} finally {
			originalUpdateDepth -= 1;
		}
	};
	const installedUpdate = function (
		this: EditorView,
		transactions: readonly Transaction[],
	): unknown {
		return guardedTransactions(
			transactions,
			applyOriginalUpdate,
			true,
			"update",
		);
	};
	const installedSetState = function (this: EditorView, ...args: unknown[]): unknown {
		if (inert || callbackRef === null || originalUpdateDepth > 0) {
			return Reflect.apply(originalSetState, view, args);
		}
		const targetState = args.length === 1
			&& typeof args[0] === "object"
			&& args[0] !== null
			&& typeof (args[0] as { doc?: { toString?: unknown } }).doc?.toString === "function"
			&& typeof (args[0] as { selection?: { eq?: unknown } }).selection?.eq === "function"
				? args[0] as EditorState
				: null;
		if (targetState === null) return undefined;
		const context = currentContext();
		if (context?.kind === "handoff") {
			const held = makeHeldHostState(targetState, context);
			if (held !== null) publishHeldHostLoad(held);
			return undefined;
		}
		if (context === null || !flushPendingDom()) return undefined;
		const stateBefore = view.state;
		const selectionBefore = stateBefore.selection;
		const scrollBefore = view.scrollDOM.scrollTop;
		const result = Reflect.apply(originalSetState, view, [targetState]);
		const nativeHistoryEpochBefore = nativeHistoryEpoch;
		nativeHistoryEpoch += 1;
		if (!selectionBefore.eq(view.state.selection)) selectionEpoch += 1;
		if (scrollBefore !== view.scrollDOM.scrollTop) scrollEpoch += 1;
		gateConfigured = handoffGateCompartment.get(view.state) !== undefined;
		gateClosed = view.state.facet(handoffGateClosedFacet);
		gateModelFingerprint = "uninitialized";
		configureGate(false);
		try {
			callbackRef?.onNativeHistoryAdvanced?.({
				cm: view,
				startState: stateBefore,
				finalState: view.state,
				nativeHistoryEpochBefore,
				nativeHistoryEpochAfter: nativeHistoryEpoch,
			});
		} catch {
			// A failed observer cannot cancel an already-applied stable state.
		}
		return result;
	};
	const installedDestroy = function (this: EditorView, ...args: unknown[]): unknown {
		teardownDestroyedGuard();
		return Reflect.apply(originalDestroy, view, args);
	};
	const wrappers = new Map<GuardedMethodName, RuntimeMethod>([
		["dispatch", installedDispatch],
		["dispatchTransactions", installedRoute as RuntimeMethod],
		["update", installedUpdate as RuntimeMethod],
		["setState", installedSetState],
		["destroy", installedDestroy],
	]);

	function flushPendingDom(): boolean {
		try {
			const pendingRecords = supportedObserver.pendingRecords.call(supportedObserver);
			const pendingContentMutation = pendingRecords.some(
				(record) => record.type === "characterData" || record.type === "childList",
			);
			const renderedLines = pendingContentMutation
				? Array.from(view.contentDOM.querySelectorAll<HTMLElement>(":scope > .cm-line"))
				: [];
			const renderedViewportMatchesState = renderedLines.length > 0
				&& renderedLines.map((line) => line.textContent ?? "").join("\n")
					=== view.state.doc.sliceString(view.viewport.from, view.viewport.to);
			const serialBefore = nativeInputDispatchSerial;
			const transactionBefore = lastNativeInputTransaction;
			supportedObserver.forceFlush.call(supportedObserver);
			if (
				pendingContentMutation
				&& !renderedViewportMatchesState
				&& (
					nativeInputDispatchSerial === serialBefore
					|| lastNativeInputTransaction === null
					|| lastNativeInputTransaction === transactionBefore
				)
			) {
				gateFailureReason = "pending-input-not-flushable";
				return false;
			}
			if (
				pendingInputDelivery !== null
				&& !deliverPendingInput(pendingInputDelivery)
			) return false;
			gateFailureReason = null;
			return true;
		} catch {
			gateFailureReason = "pending-input-not-flushable";
			return false;
		}
	}

	function configureGate(closed: boolean): boolean {
		if (!flushPendingDom()) return false;
		const recoveryModel = closed
			? callbackRef?.getHandoffRecoveryGateModel?.() ?? null
			: null;
		const modelFingerprint = handoffRecoveryGateFingerprint(recoveryModel);
		if (
			gateConfigured
			&& gateClosed === closed
			&& view.state.facet(handoffGateClosedFacet) === closed
			&& gateModelFingerprint === modelFingerprint
		) return true;
		const extensions: Extension[] = [
			handoffGateClosedFacet.of(closed),
			hostPresentationSettlementObserver,
		];
		if (closed) {
			extensions.push(Prec.lowest(EditorView.inputHandler.of((target, _from, _to, _text, insert) => {
				if (
					target !== view
					|| inert
					|| callbackRef === null
					|| !gateClosed
				) return false;
				if (pendingInput === null && activeComposition === null) {
					startInputSequence(null);
				}
				try {
					const transaction = insert();
					if (
						pendingInputDelivery === null
						&& captureActiveCompositionTransaction(
							transaction,
							currentContext(),
						)
					) {
						return true;
					}
					target.dispatch(transaction);
				} catch {
					gateFailureReason = "pending-input-not-flushable";
				}
				return true;
			})));
		}
		if (recoveryModel !== null) {
			extensions.push(showPanel.of(createHandoffRecoveryPanel(
				recoveryModel,
				callbackRef?.handoffRecoveryGateCallbacks,
			)));
		}
		const extension: Extension = extensions;
		const effect = gateConfigured
			? handoffGateCompartment.reconfigure(extension)
			: StateEffect.appendConfig.of(handoffGateCompartment.of(extension));
		let transaction: Transaction;
		try {
			transaction = view.state.update({
				effects: effect,
				annotations: guardOwnedGateReconfiguration.of(
					compositionProofOwner,
				),
				filter: false,
			});
		} catch {
			gateFailureReason = "gate-release-failed";
			return false;
		}
		const reconfiguration: GuardOwnedGateReconfiguration = frozen({
			transaction,
			effect,
			nativeHistoryEpochBefore: nativeHistoryEpoch,
			selectionEpochBefore: selectionEpoch,
			scrollEpochBefore: scrollEpoch,
			scrollTopBefore: view.scrollDOM.scrollTop,
		});
		if (gateReconfigurationDepth === 0) {
			gateReconfigurationLedger.splice(0, gateReconfigurationLedger.length);
			gateAuthorityAdvanceFailureReason = null;
		}
		gateReconfigurationDepth += 1;
		gateReconfigurationLedger.push(reconfiguration);
		try {
			view.dispatch(transaction);
			markGuardOwnedGateReconfiguration(transaction);
			gateConfigured = true;
			gateClosed = closed;
			gateModelFingerprint = modelFingerprint;
			const configured = view.state.facet(handoffGateClosedFacet) === closed;
			if (!configured) gateFailureReason = "gate-release-failed";
			return configured;
		} catch {
			gateFailureReason = "gate-release-failed";
			return false;
		} finally {
			gateReconfigurationDepth -= 1;
			if (gateReconfigurationDepth === 0) {
				gateReconfigurationLedger.splice(0, gateReconfigurationLedger.length);
			}
		}
	}

	function rollbackInstalled(installedNames: readonly GuardedMethodName[]): void {
		for (const name of [...installedNames].reverse()) {
			const method = methods.get(name);
			if (method === undefined) continue;
			if (method.hadOwn) Object.defineProperty(view, name, method.descriptor);
			else Reflect.deleteProperty(view, name);
		}
		removeListeners();
	}

	installListeners();
	const installedNames: GuardedMethodName[] = [];
	try {
		for (const name of ["update", "dispatchTransactions", "dispatch", "setState", "destroy"] as const) {
			const method = methods.get(name);
			const wrapper = wrappers.get(name);
			if (method === undefined || wrapper === undefined) throw new TypeError(`Missing ${name} wrapper`);
			Object.defineProperty(view, name, wrapperDescriptor(method, wrapper));
			installedNames.push(name);
		}
	} catch {
		rollbackInstalled(installedNames);
		return frozen({ kind: "unsupported", reason: "final-boundary-not-provable" });
	}

	type HostLoadSettlementObservation = Readonly<{
		valid: boolean;
		state: EditorState;
		selection: EditorSelection;
		viewportFrom: number;
		scrollTop: number;
		scrollEpoch: number;
		historyResetObserved: boolean;
	}>;
	type PendingCommitSettlement = {
		commit: HostLoadCommit;
		settled: boolean;
		resolve(observation: HostLoadSettlementObservation): void;
	};
	let pendingCommitSettlement: PendingCommitSettlement | null = null;

	function acceptedPostconditions(commit: HostLoadCommit): boolean {
		const candidate = commit.held.candidate;
		const common = heldHostLoad === commit.held
			&& exactHeldTarget(commit.held)
			&& view.state.doc.toString() === candidate.incomingContent
			&& view.state.selection.eq(candidate.proposedSelection)
			&& runtimeData(candidate.runtimeView) === candidate.incomingContent
			&& nativeHistoryEpoch === candidate.nativeHistoryEpochBefore + 1;
		if (!common) return false;
		return commit.kind === "transaction"
			? candidate.applicationKind === "transaction"
				&& commit.routeSeen
				&& commit.updateSeen
				&& view.state === commit.acceptedTransaction.state
			: candidate.applicationKind === "state"
				&& candidate.heldState === commit.hostState
				&& view.state.doc === candidate.targetDocument
				&& commit.acceptedState !== null
				&& view.state === commit.acceptedState
				&& view.state.facet(handoffGateClosedFacet)
				&& gateClosed
				&& handoffGateCompartment.get(view.state) !== undefined;
	}

	function failCommit(
		held: HeldHostLoad,
		reason: NonNullable<CodeMirrorHandoffGuardSnapshot["commitFailureReason"]>,
	): void {
		consumedHostLoadTokens.add(held.candidate.hostLoadTokenId);
		clearCompositionNoopSettlements(held);
		if (heldHostLoad === held) heldHostLoad = null;
		if (hostLoadCandidateNotification?.candidate === held.candidate) hostLoadCandidateNotification = null;
		if (pendingHostLoadCompletion?.held === held) pendingHostLoadCompletion = null;
		activeCommit = null;
		commitState = "failed";
		commitFailureReason = reason;
	}

	function retryCommitIfUnchanged(commit: HostLoadCommit): boolean {
		const candidate = commit.held.candidate;
		if (
			view.state !== commit.startState
			|| nativeHistoryEpoch !== candidate.nativeHistoryEpochBefore
			|| !exactHeldTarget(commit.held)
			|| runtimeData(candidate.runtimeView) !== candidate.incomingContent
		) return false;
		if (!targetScopedRuntimeDataCas(
			commit.held,
			candidate.incomingContent,
			candidate.runtimeViewDataBefore,
		)) return false;
		activeCommit = null;
		commitState = "pending";
		return exactPendingHeld(commit.held);
	}

	function invalidCommitObservation(): HostLoadSettlementObservation {
		return frozen({
			valid: false,
			state: view.state,
			selection: view.state.selection,
			viewportFrom: view.viewport.from,
			scrollTop: view.scrollDOM.scrollTop,
			scrollEpoch,
			historyResetObserved: false,
		});
	}

	function settleCommitObservation(
		pending: PendingCommitSettlement,
		observation: HostLoadSettlementObservation,
	): void {
		if (pending.settled) return;
		pending.settled = true;
		if (pendingCommitSettlement === pending) pendingCommitSettlement = null;
		pending.resolve(observation);
	}

	function cancelActiveCommitSettlement(): void {
		const commit = activeCommit;
		if (commitState === "committing" && commit !== null) {
			failCommit(commit.held, "commit-cancelled");
		}
		const pending = pendingCommitSettlement;
		if (pending !== null) settleCommitObservation(pending, invalidCommitObservation());
	}

	function restoreOwnedWrappers(): void {
		for (const name of ["dispatch", "dispatchTransactions", "update", "setState", "destroy"] as const) {
			const current = Object.getOwnPropertyDescriptor(view, name);
			const wrapper = wrappers.get(name);
			const original = methods.get(name);
			if (current?.value !== wrapper || original === undefined) continue;
			if (original.hadOwn) Object.defineProperty(view, name, original.descriptor);
			else Reflect.deleteProperty(view, name);
		}
	}

	function teardownDestroyedGuard(): void {
		cancelActiveCommitSettlement();
		inert = true;
		callbackRef = null;
		armedHostLoad = null;
		clearCompositionNoopSettlements();
		heldHostLoad = null;
		hostLoadCandidateNotification = null;
		pendingHostLoadCompletion = null;
		pendingInput = null;
		activeComposition = null;
		pendingCompositionSuccessor = null;
		pendingImplicitCompositionCommit = null;
		pendingInputDelivery = null;
		liveCompositionProofOwners.delete(compositionProofOwner);
		removeListeners();
		restoreOwnedWrappers();
		installedGuards.delete(view);
	}

	function observeCommitSettlement(commit: HostLoadCommit): Promise<HostLoadSettlementObservation> {
		return new Promise((resolve) => {
			const pending: PendingCommitSettlement = {
				commit,
				settled: false,
				resolve,
			};
			pendingCommitSettlement = pending;
			try {
				view.requestMeasure({
					key: commit,
					read(target): HostLoadSettlementObservation {
						let historyResetObserved = commit.kind === "state";
						if (commit.kind === "transaction") {
							try {
								historyResetObserved = callbackRef?.observeNativeHistoryReset(
									target,
									commit.acceptedTransaction,
								) === true;
							} catch {
								historyResetObserved = false;
							}
						}
						const selectionHead = target.state.selection.main.head;
						const requestedSelectionVisible = commit.kind === "state"
							|| !commit.acceptedTransaction.scrollIntoView
							|| (selectionHead >= target.viewport.from && selectionHead <= target.viewport.to);
						return frozen({
							valid: target === view
								&& acceptedPostconditions(commit)
								&& requestedSelectionVisible
								&& historyResetObserved,
							state: target.state,
							selection: target.state.selection,
							viewportFrom: target.viewport.from,
							scrollTop: target.scrollDOM.scrollTop,
							scrollEpoch,
							historyResetObserved,
						});
					},
					write(observation, target): void {
						settleCommitObservation(pending, frozen({
							...observation,
							valid: observation.valid
								&& target === view
								&& target.state === observation.state
								&& scrollEpoch === observation.scrollEpoch
								&& acceptedPostconditions(commit),
						}));
					},
				});
			} catch {
				settleCommitObservation(pending, invalidCommitObservation());
			}
		});
	}

	const guard: CodeMirrorHandoffGuard = {
		refreshGate(): boolean {
			if (inert || callbackRef === null) return false;
			if (pendingInputDelivery !== null && !deliverPendingInput(pendingInputDelivery)) return false;
			const context = currentContext();
			if (pendingInput !== null) observeBeforeHandoffContext(pendingInput, context);
			const closed = context === null || context.kind === "handoff";
			if (!configureGate(closed)) return false;
			if (context?.kind !== "handoff") {
				armedHostLoad = null;
				if (commitState !== "committing") {
					clearCompositionNoopSettlements();
					heldHostLoad = null;
					hostLoadCandidateNotification = null;
					pendingHostLoadCompletion = null;
					commitState = "none";
				}
			} else {
				if (armedHostLoad !== null && !isExactContext(context, armedHostLoad.input)) {
					armedHostLoad = null;
				}
				if (heldHostLoad !== null && !exactHeldTarget(heldHostLoad)) {
					if (commitState !== "committing") commitState = "none";
					clearCompositionNoopSettlements(heldHostLoad);
					heldHostLoad = null;
					hostLoadCandidateNotification = null;
					pendingHostLoadCompletion = null;
				}
			}
			return true;
		},
		armHostLoad(input): boolean {
			if (
				inert
				|| callbackRef === null
				|| consumedHostLoadTokens.has(input.hostLoadTokenId)
				|| commitState === "committing"
			) return false;
			const context = currentContext();
			const data = runtimeData(input.runtimeView);
			if (
				input.hostLoadTokenId.length === 0
				|| input.sourceUnloadReceiptId.length === 0
				|| !Number.isSafeInteger(input.editorRevisionBefore)
				|| input.editorRevisionBefore < 0
				|| input.editorRevisionBefore >= Number.MAX_SAFE_INTEGER
				|| !isExactContext(context, input)
				|| data === null
				|| !runtimeViewTargets(input.runtimeView, input.targetFile, input.targetPath)
				|| heldHostLoad !== null
				|| armedHostLoad !== null
			) return false;
			commitState = "none";
			commitFailureReason = null;
			inputAuthorityAdvanceFailureReason = null;
			hostPostDelegationFailureReason = null;
			hostLoadCandidateNotification = null;
			pendingHostLoadCompletion = null;
			armedHostLoad = frozen({
				input: frozen({ ...input }),
				startState: view.state,
				startDocument: view.state.doc,
				runtimeViewDataBefore: data,
			});
			return true;
		},
		certifyHostLoadPostDelegation(hostLoadTokenId): boolean {
			const held = heldHostLoad;
			const activeCallbacks = callbackRef;
			const candidate = held?.candidate ?? null;
			const authority = held?.startStateAuthority ?? null;
			const hostScrollTop = view.scrollDOM.scrollTop;
			const targetState = candidate?.applicationKind === "state"
				? candidate.heldState
				: candidate?.heldTransaction?.state ?? null;
			const validate = (requireExactScrollTop: boolean): string | null => {
				if (inert) return "inert";
				if (activeCallbacks === null || callbackRef !== activeCallbacks) {
					return "callbacks-stale";
				}
				if (hostLoadTokenId.length === 0) return "token-missing";
				if (held === null || candidate === null || authority === null) {
					return "held-missing";
				}
				if (heldHostLoad !== held) return "held-identity";
				if (commitState !== "pending") return "commit-state";
				if (candidate.hostLoadTokenId !== hostLoadTokenId) return "token-identity";
				if (candidate.hostSetViewDataClear !== true) return "clear-load";
				if (candidate.hostLoadCompletedEpoch !== null) return "already-completed";
				if (authority.postDelegationCertified) return "already-certified";
				if (candidate.cm !== view) return "cm-identity";
				if (!exactHeldTarget(held)) return "context-lineage";
				if (authority.state.doc !== candidate.startDocument) {
					return "authority-document-identity";
				}
				if (view.state.doc !== candidate.startDocument) {
					return "live-document-identity";
				}
				if (targetState === view.state) return "held-target-already-applied";
				if (!authority.state.selection.eq(view.state.selection)) return "selection";
				if (candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch) {
					return "native-history-epoch";
				}
				if (authority.selectionEpoch !== selectionEpoch) return "selection-epoch";
				if (authority.scrollEpoch !== scrollEpoch) return "scroll-epoch";
				if (requireExactScrollTop && authority.scrollTop !== view.scrollDOM.scrollTop) {
					return "scroll-top";
				}
				if (runtimeData(candidate.runtimeView) !== candidate.runtimeViewDataBefore) {
					return "runtime-data";
				}
				if (consumedHostLoadTokens.has(hostLoadTokenId)) return "token-consumed";
				return null;
			};
			hostPostDelegationFailureReason = validate(false);
			if (
				hostPostDelegationFailureReason !== null
				|| held === null
				|| candidate === null
				|| authority === null
				|| activeCallbacks === null
			) return false;
			let exactDispatchActive = false;
			try {
				exactDispatchActive = activeCallbacks.isExactHostLoadDispatchActive?.(
					candidate,
				) === true;
			} catch {
				exactDispatchActive = false;
			}
			if (!exactDispatchActive) {
				hostPostDelegationFailureReason = "dispatch-certificate";
				return false;
			}
			hostPostDelegationFailureReason = validate(false);
			if (hostPostDelegationFailureReason !== null) return false;
			if (view.scrollDOM.scrollTop !== hostScrollTop) {
				hostPostDelegationFailureReason = "scroll-top";
				return false;
			}
			if (authority.scrollTop !== hostScrollTop) {
				if (candidate.applicationKind !== "state") {
					hostPostDelegationFailureReason = "scroll-top";
					return false;
				}
				// Obsidian 1.8.4 resets scrollTop after its exact synchronous
				// state replacement. The held document is still the source here;
				// adopt only that host-owned tail while every epoch and identity
				// certificate above remains exact.
				authority.scrollTop = hostScrollTop;
			}
			hostPostDelegationFailureReason = validate(true);
			if (hostPostDelegationFailureReason !== null) return false;
			authority.state = view.state;
			authority.postDelegationCertified = true;
			authority.presentationSettlementConsumed = false;
			// Obsidian may emit one state-identity-only Transaction.time update
			// after its certified state replacement. The first subsequent update
			// spends this token; the observer adopts it only when every document,
			// selection, config, effect, epoch, and host identity remains exact.
			if (candidate.applicationKind === "state") {
				pendingCompositionNoopSettlement = frozen({
					held,
					startState: view.state,
					compositionEpoch: null,
					persistenceNeutralEffectConsumed: false,
				});
			}
			return true;
		},
		async acceptHeldHostLoad(input) {
			const held = heldHostLoad;
			if (
				!inert
				&& callbackRef !== null
				&& input.presentationPlanId.length > 0
				&& commitState === "committed"
			) {
				const pending = pendingHostLoadCompletion;
				if (
					pending === null
					|| held === null
					|| pending.held !== held
					|| input.candidate !== held.candidate
					|| input.presentationPlanId !== pending.presentationPlanId
					|| !exactPendingHostLoadCompletion(pending)
				) return frozen({ kind: "rejected", reason: "stale-generation" });
				const notification = notifyHostLoadCompletion(pending);
				if (notification === "invalid") {
					failCommit(held, "completion-notification-invalid");
					return frozen({ kind: "rejected", reason: "stale-generation" });
				}
				if (notification === "pending") {
					return frozen({
						kind: "pending-notification",
						notification: "completion",
						receipt: pending.receipt,
					});
				}
				pendingHostLoadCompletion = null;
				clearCompositionNoopSettlements(held);
				heldHostLoad = null;
				hostLoadCandidateNotification = null;
				return frozen({ kind: "accepted", receipt: pending.receipt });
			}
			if (
				inert
				|| callbackRef === null
				|| input.presentationPlanId.length === 0
				|| held === null
				|| input.candidate !== held.candidate
				|| commitState !== "pending"
			) return frozen({ kind: "rejected", reason: "stale-generation" });
			const candidate = held.candidate;
			if (!exactPendingHeld(held)) {
				const authorityCurrent = exactPendingHeldAuthority(held);
				if (!authorityCurrent) failCommit(held, explainPendingAuthorityStale(held));
				return frozen({
					kind: "rejected",
					reason: authorityCurrent ? "ambiguous-editor-api" : "stale-generation",
				});
			}
			const candidateNotification = notifyHostLoadCandidate(held);
			if (candidateNotification === "invalid") {
				failCommit(held, "candidate-notification-invalid");
				return frozen({ kind: "rejected", reason: "stale-generation" });
			}
			if (candidateNotification === "pending") {
				return frozen({
					kind: "pending-notification",
					notification: "candidate",
					candidate: held.candidate,
				});
			}
			if (!exactPendingHeld(held)) {
				failCommit(held, "post-candidate-authority-stale");
				return frozen({ kind: "rejected", reason: "stale-generation" });
			}
			let acceptedTransaction: Transaction | null = null;
			if (candidate.applicationKind === "transaction") {
				const activeCallbacks = callbackRef;
				const annotations = annotationsOf(candidate.heldTransaction);
				if (
					annotations === null
					|| candidate.heldTransaction.newDoc !== candidate.targetDocument
					|| activeCallbacks.isNativeHistoryReset(candidate.heldTransaction) !== true
				) return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
				const acceptedAnnotation = acceptedHostLoad.of(frozen({
					hostLoadTokenId: candidate.hostLoadTokenId,
					sessionId: candidate.sessionId,
					handoffGeneration: candidate.handoffGeneration,
				}));
				acceptedTransaction = createRawTransaction({
					startState: held.startStateAuthority.state,
					changes: candidate.heldTransaction.changes,
					selection: candidate.heldTransaction.selection,
					effects: candidate.heldTransaction.effects,
					annotations: [...annotations, acceptedAnnotation as TransactionAnnotation<unknown>],
					scrollIntoView: candidate.heldTransaction.scrollIntoView,
				});
				if (
					acceptedTransaction === null
					|| acceptedTransaction.changes !== candidate.heldTransaction.changes
					|| acceptedTransaction.selection !== candidate.heldTransaction.selection
					|| acceptedTransaction.effects !== candidate.heldTransaction.effects
					|| acceptedTransaction.scrollIntoView !== candidate.heldTransaction.scrollIntoView
				) return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
			} else if (
				candidate.heldState.doc !== candidate.targetDocument
				|| candidate.heldState.selection !== candidate.proposedSelection
			) {
				return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
			}
			if (!targetScopedRuntimeDataCas(
				held,
				candidate.runtimeViewDataBefore,
				candidate.incomingContent,
			)) {
				if (!exactPendingHeld(held) && !exactPendingHeldAuthority(held)) {
					failCommit(held, "cache-authority-stale");
				}
				return frozen({ kind: "rejected", reason: "stale-generation" });
			}
			if (
				!exactHeldTarget(held)
				|| held.startStateAuthority.state !== view.state
				|| candidate.startDocument !== view.state.doc
				|| candidate.nativeHistoryEpochBefore !== nativeHistoryEpoch
				|| runtimeData(candidate.runtimeView) !== candidate.incomingContent
			) {
				const editorUnchanged = held.startStateAuthority.state === view.state
					&& candidate.startDocument === view.state.doc
					&& candidate.nativeHistoryEpochBefore === nativeHistoryEpoch;
				const rolledBack = targetScopedRuntimeDataCas(
					held,
					candidate.incomingContent,
					candidate.runtimeViewDataBefore,
				);
				if (!editorUnchanged || !rolledBack) {
					failCommit(held, "post-cache-authority-stale");
				}
				return frozen({ kind: "rejected", reason: "stale-generation" });
			}
			const commit: HostLoadCommit = candidate.applicationKind === "transaction"
				? {
					kind: "transaction",
					held,
					acceptedTransaction: acceptedTransaction as Transaction,
					startState: view.state,
					routeSeen: false,
					updateSeen: false,
				}
				: {
					kind: "state",
					held,
					hostState: candidate.heldState,
					startState: view.state,
					acceptedState: null,
				};
			activeCommit = commit;
			commitState = "committing";
			try {
				if (commit.kind === "transaction") {
					view.dispatch(commit.acceptedTransaction);
				} else {
					Reflect.apply(originalSetState, view, [commit.hostState]);
					nativeHistoryEpoch += 1;
					gateConfigured = handoffGateCompartment.get(view.state) !== undefined;
					gateClosed = view.state.facet(handoffGateClosedFacet);
					gateModelFingerprint = "uninitialized";
					const gateReinstalled = configureGate(true);
					commit.acceptedState = view.state;
					if (!gateReinstalled) {
						failCommit(held, "state-gate-reinstall-failed");
						return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
					}
				}
			} catch {
				if (!retryCommitIfUnchanged(commit)) failCommit(held, "host-apply-threw");
				return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
			}
			if (!acceptedPostconditions(commit)) {
				if (commit.kind === "state" || !retryCommitIfUnchanged(commit)) {
					failCommit(held, "host-apply-postconditions-failed");
				}
				return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
			}
			const observation = await observeCommitSettlement(commit);
			if (
				!observation.valid
				|| !observation.historyResetObserved
				|| observation.state !== view.state
				|| !observation.selection.eq(candidate.proposedSelection)
				|| observation.viewportFrom !== view.viewport.from
				|| observation.scrollTop !== view.scrollDOM.scrollTop
				|| observation.scrollEpoch !== scrollEpoch
				|| !acceptedPostconditions(commit)
			) {
				failCommit(held, "settlement-observation-failed");
				return frozen({ kind: "rejected", reason: "ambiguous-editor-api" });
			}
			selectionEpoch += 1;
			scrollEpoch += 1;
			consumedHostLoadTokens.add(candidate.hostLoadTokenId);
			activeCommit = null;
			commitState = "committed";
			const receipt = frozen({
				receiptId: nextId("host-load-receipt"),
				hostLoadTokenId: candidate.hostLoadTokenId,
				switchIntentSeq: candidate.switchIntentSeq,
				sessionId: candidate.sessionId,
				leafId: candidate.leafId,
				handoffGeneration: candidate.handoffGeneration,
				targetPath: held.targetPath,
				nativeHistoryEpoch,
				historyResetObserved: true as const,
				targetSelection: observation.selection,
				targetSelectionEpoch: selectionEpoch,
				targetScrollAnchor: candidate.proposedScrollAnchor,
				targetScrollEpoch: scrollEpoch,
				effectFingerprint: candidate.effectFingerprint,
			});
			const pending: PendingHostLoadCompletion = {
				held,
				presentationPlanId: input.presentationPlanId,
				receipt,
				acceptedState: view.state,
				phase: "idle",
			};
			pendingHostLoadCompletion = pending;
			const completionNotification = notifyHostLoadCompletion(pending);
			if (completionNotification === "invalid") {
				failCommit(held, "completion-notification-invalid");
				return frozen({ kind: "rejected", reason: "stale-generation" });
			}
			if (completionNotification === "pending") {
				return frozen({
					kind: "pending-notification",
					notification: "completion",
					receipt,
				});
			}
			pendingHostLoadCompletion = null;
			clearCompositionNoopSettlements(held);
			heldHostLoad = null;
			hostLoadCandidateNotification = null;
			return frozen({ kind: "accepted", receipt });
		},
		markInert(): boolean {
			if (inert) return true;
			if (commitState === "committing") {
				cancelActiveCommitSettlement();
				if (commitState === "committing") {
					gateFailureReason = "gate-release-failed";
					return false;
				}
			}
			if (!routeMissingCompositionEnd()) return false;
			if (!configureGate(false)) return false;
			inert = true;
			callbackRef = null;
			armedHostLoad = null;
			clearCompositionNoopSettlements();
			heldHostLoad = null;
			hostLoadCandidateNotification = null;
			pendingHostLoadCompletion = null;
			pendingInput = null;
			activeComposition = null;
			pendingCompositionSuccessor = null;
			pendingImplicitCompositionCommit = null;
			pendingInputDelivery = null;
			liveCompositionProofOwners.delete(compositionProofOwner);
			removeListeners();
			return true;
		},
		restoreIfCurrent(): boolean {
			if (installedGuards.get(view)?.guard !== guard) return false;
			if (!this.markInert()) return false;
			restoreOwnedWrappers();
			installedGuards.delete(view);
			return true;
		},
		snapshot(): CodeMirrorHandoffGuardSnapshot {
			// Keep the build define at the branch site. Esbuild deliberately does
			// not propagate a module-level `const false` into object literals, which
			// would leave these QA-only property names in the production bundle.
			const qaFailureDetails = (
				typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
				&& __KAOS_QA_HARNESS_ENABLED__
			)
				? {
					commitFailureReason,
					gateAuthorityAdvanceFailureReason,
					inputAuthorityAdvanceFailureReason,
					hostPostDelegationFailureReason,
				}
				: {};
			return frozen({
				view,
				inert,
				gateClosed,
				inputEpoch,
				compositionEpoch,
				nativeHistoryEpoch,
				selectionEpoch,
				scrollEpoch,
				activeComposition: activeComposition === null ? null : frozen({
					compositionEpoch: activeComposition.sequence.compositionEpoch ?? compositionEpoch,
					startGeneration: activeComposition.sequence.startGeneration,
					updates: activeComposition.updates,
					capturedUpdates: activeComposition.lastCapturedUpdate,
					replayEligible: false as const,
				}),
				lastComposition,
				gateFailureReason,
				commitState,
				...qaFailureDetails,
				pendingHostLoadCandidate: heldHostLoad?.candidate ?? null,
			});
		},
	};

	liveCompositionProofOwners.add(compositionProofOwner);
	if (!guard.refreshGate()) {
		liveCompositionProofOwners.delete(compositionProofOwner);
		rollbackInstalled(installedNames);
		return frozen({ kind: "unsupported", reason: "pending-dom-input-not-capturable" });
	}
	installedGuards.set(view, frozen({ guard, wrappers }));
	return frozen({ kind: "installed", guard });
}
