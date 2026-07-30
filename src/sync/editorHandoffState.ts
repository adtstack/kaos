import type {
	ChangeSet,
	EditorSelection,
	EditorState,
	Text,
	Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView, TFile, TextFileView } from "obsidian";
import type * as Y from "yjs";

export type HandoffIntentState =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "persisting"; intentId: string }>
	| Readonly<{ kind: "stored"; intentId: string; recordId: string }>
	| Readonly<{ kind: "replay-pending"; intentId: string; recordId: string }>
	| Readonly<{
		kind: "replayed-awaiting-settlement";
		intentId: string;
		recordId: string;
	}>
	| Readonly<{ kind: "needs-review"; intentId: string; recordId: string }>
	| Readonly<{
		kind: "escape-pending";
		intentId: string;
		action: "copy" | "export" | "discard";
	}>
	| Readonly<{
		kind: "escaped";
		intentId: string;
		action: "copy" | "export";
		recordId: null;
	}>
	| Readonly<{ kind: "resolved"; intentId: string; recordId: string }>
	| Readonly<{ kind: "discarded"; intentId: string; recordId: string | null }>
	| Readonly<{ kind: "failed"; intentId: string; reason: string }>;

export type HandoffInputIntent = Readonly<{
	intentId: string;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	fromPath: string | null;
	fromFileId: string | null;
	targetPath: string;
	targetFile: TFile;
	bindingEpoch: number;
	inputEpoch: number;
	switchIntentSeq: number;
	inputStartSeq: number;
	inputStartedUnderSwitchSeq: number | null;
	compositionEpoch: number | null;
	selectionEpoch: number;
	sequenceBegan: "before-handoff" | "after-target-selected";
	startDocument: Text;
	startContentHash: string;
	changes: ChangeSet;
	afterContent: string;
	afterContentHash: string;
	selectionBefore: EditorSelection;
	selectionAfter: EditorSelection;
	originKind: "user" | "ime" | "editor-api";
	userEvent: "input" | "delete" | "paste" | "drop" | "other";
	capturedAt: number;
}>;

export type ManagedLeafRecovery = Readonly<{
	sessionId: string;
	handoffGeneration: number;
	recoveryOperationEpoch: number;
	intentState: Exclude<HandoffIntentState, Readonly<{ kind: "none" }>>;
	intent: HandoffInputIntent;
}>;

export type TargetReadyToken = Readonly<{
	tokenId: string;
	sessionId: string;
	authorityFreshnessHandleId: string;
	authorityFingerprint: string;
	controllerLifecycleGeneration: number;
	leafId: string;
	handoffGeneration: number;
	switchIntentSeq: number;
	targetPath: string;
	targetFile: TFile;
	targetAuthority:
		| Readonly<{ kind: "missing"; activeIdSetEpoch: number }>
		| Readonly<{
			kind: "existing";
			fileId: string;
			ytextIdentity: string;
			ytextMutationEpoch: number;
			bindPermitId: string;
		}>;
	hostLoadTokenId: string;
	hostLoadCompletedEpoch: number;
	hostLoadReceiptId: string;
	nativeHistoryEpoch: number;
	targetSelectionEpoch: number;
	targetScrollEpoch: number;
	certifiedBaseContent: string;
	certifiedBaseHash: string;
	openEditorTicketId: string;
}>;

export type HandoffReplayPlan = Readonly<{
	planId: string;
	intentId: string;
	targetReadyTokenId: string;
	authorityFreshnessHandleId: string;
	replayPermitId: string;
	switchIntentSeq: number;
	kind: "exact-replay" | "strict-nonoverlap-rebase";
	expectedTargetDocument: Text;
	expectedSelectionEpoch: number;
	expectedNativeHistoryEpoch: number;
	expectedTargetScrollEpoch: number;
	replayChanges: ChangeSet;
	mappedSelection: EditorSelection;
	mappedScrollAnchor: number | null;
}>;

export type TargetPresentationPlan = Readonly<{
	planId: string;
	hostLoadTokenId: string;
	switchIntentSeq: number;
	authorityFreshnessHandleId: string;
	expectedNativeHistoryEpoch: number;
	presentationPermitId: string;
}>;

export type MissingTargetSeedPlan = Readonly<{
	planId: string;
	targetReadyTokenId: string;
	switchIntentSeq: number;
	authorityFreshnessHandleId: string;
	seedPermitId: string;
	certifiedBaseHash: string;
}>;

export type MissingTargetSeedReceipt = Readonly<{
	receiptId: string;
	seedPlanId: string;
	seededFileId: string;
	seededYtextIdentity: string;
	seededMutationEpoch: number;
	certifiedBaseHash: string;
	replacementTargetReadyToken: TargetReadyToken & Readonly<{
		targetAuthority: Extract<
			TargetReadyToken["targetAuthority"],
			{ kind: "existing" }
		>;
	}>;
}>;

type PendingHostLoadCandidateBase = Readonly<{
	hostLoadTokenId: string;
	hostLoadCompletedEpoch: number | null;
	sourceUnloadReceiptId: string;
	switchIntentSeq: number;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	targetPathAtDispatch: string;
	cm: EditorView;
	runtimeView: TextFileView;
	startDocument: Text;
	targetDocument: Text;
	incomingContent: string;
	hostSetViewDataClear: true;
	editorRevisionBefore: number;
	nativeHistoryEpochBefore: number;
	proposedSelection: EditorSelection;
	proposedScrollAnchor: number | null;
	effectFingerprint: string;
	runtimeViewDataBefore: string;
	bindingEpoch: number;
}>;

export type PendingHostLoadCandidate = PendingHostLoadCandidateBase & (
	| Readonly<{
		applicationKind: "transaction";
		heldTransaction: Transaction;
		heldState: null;
	}>
	| Readonly<{
		applicationKind: "state";
		heldTransaction: null;
		heldState: EditorState;
	}>
);

export type HostLoadCompletionReceipt = Readonly<{
	receiptId: string;
	hostLoadTokenId: string;
	switchIntentSeq: number;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	targetPath: string;
	nativeHistoryEpoch: number;
	historyResetObserved: true;
	targetSelection: EditorSelection;
	targetSelectionEpoch: number;
	targetScrollAnchor: number | null;
	targetScrollEpoch: number;
	effectFingerprint: string;
}>;

export type TargetPresentationReceipt = Readonly<{
	receiptId: string;
	presentationPlanId: string;
	hostLoadCompletionReceipt: HostLoadCompletionReceipt;
	replacementTargetReadyToken: TargetReadyToken;
}>;

export type ManagedLeafInputStartReservation = Readonly<{
	inputStartSeq: number;
	inputStartedUnderSwitchSeq: number | null;
	inputEpoch: number;
	compositionEpoch: number | null;
	handoffGenerationAtStart: number;
	sourceAuthorityPathAtStart: string | null;
	sourceFileAtStart: TFile | null;
	sourceFileIdAtStart: string | null;
	sourceDocumentAtStart: Text | null;
	targetPathAtStart: string | null;
	targetFileAtStart: TFile | null;
}>;

export type CompletedSamePathInputReceipt = Readonly<{
	reservation: ManagedLeafInputStartReservation;
	sessionId: string;
	leafId: string;
	handoffGenerationAtCompletion: number;
	file: TFile;
	path: string;
	fileId: string | null;
	cm: EditorView;
	startDocument: Text;
	finalDocument: Text;
	editorRevision: number;
}>;

export type SettledSourceUnloadProof = Readonly<{
	receiptId: string;
	file: TFile;
	path: string;
	state: "settled";
	forcedSaveObserved: true;
}>;

export type ManagedLeafSession = Readonly<{
	sessionId: string;
	leafId: string;
	generation: number;
	eventOrderSeq: number;
	currentSwitchIntentSeq: number | null;
	nativeHistoryEpoch: number;
	completedDetachEpoch: number | null;
	activeRecoveries: readonly ManagedLeafRecovery[];
	// Task 4 calls reserveManagedLeafInputStart synchronously at beforeinput or
	// compositionstart, then echoes this immutable reservation if that native
	// sequence later becomes a quarantined handoff intent.
	pendingInputStartReservation: ManagedLeafInputStartReservation | null;
	// A stable same-path IME completion may be followed by Obsidian clearing the
	// same CodeMirror before its next host load.  This one-shot receipt retains
	// the pre-clear source lineage without treating the empty host state as
	// target authority.
	completedSamePathInput: CompletedSamePathInputReceipt | null;
	view: MarkdownView;
	displayedLineage:
		| Readonly<{ kind: "unknown" }>
		| Readonly<{
			kind: "known";
			file: TFile;
			path: string;
			fileId: string | null;
			cm: EditorView;
			document: Text;
			editorRevision: number;
		}>;
	binding:
		| Readonly<{ kind: "unbound" }>
		| Readonly<{ kind: "bound"; path: string; fileId: string; ytext: Y.Text }>;
	handoff: null | Readonly<{
		sourceAuthorityPath: string | null;
		sourceUnloadReceiptId: string | null;
		targetPath: string;
		targetFile: TFile;
		bindingEpochAfterDetach: number;
		presentation: "source" | "target-candidate" | "target-proven";
		targetReadyTokenId: string | null;
		inputGateInstalled: boolean;
		saveGuardInstalled: boolean;
		recoveryOperationEpoch: number;
		intentState: HandoffIntentState;
		recoveryTargetBindingRequest: null | Readonly<{
			recoveryOperationEpoch: number;
			intentId: string;
			recordId: string;
		}>;
		phase:
			| "awaiting-host-load"
			| "awaiting-target-ready"
			| "awaiting-recovery-commit"
			| "awaiting-replay-settlement"
			| "awaiting-recovery-decision"
			| "target-ready";
		// The reducer must retain the exact held host-load lineage until a
		// presentation receipt proves it. The public candidate/receipt types stay
		// frozen; this is the single explicit reducer-owned state extension.
		pendingHostLoadCandidate: PendingHostLoadCandidate | null;
	}>;
}>;

type CreateManagedLeafSessionInput = Readonly<{
	sessionId: string;
	leafId: string;
	view: MarkdownView;
	nativeHistoryEpoch?: number;
	displayedLineage: ManagedLeafSession["displayedLineage"];
	binding: ManagedLeafSession["binding"];
}>;

export type EditorHandoffEvent =
	| Readonly<{
		type: "target-selected";
		sessionId: string;
		expectedGeneration: number;
		targetFile: TFile;
		switchIntentSeq: number;
		sourceUnloadReceiptId: string;
	}>
	| Readonly<{
		type: "target-observed";
		sessionId: string;
		expectedGeneration: number;
		targetFile: TFile;
	}>
	| Readonly<{
		type: "detach-completed";
		sessionId: string;
		expectedGeneration: number;
		bindingEpochAfterDetach: number;
	}>
	| Readonly<{
		type: "same-path-input-completed";
		sessionId: string;
		expectedGeneration: number;
		reservation: ManagedLeafInputStartReservation;
		cm: EditorView;
		startDocument: Text;
		finalDocument: Text;
		editorRevision: number;
	}>
	| Readonly<{
		type: "host-candidate-held";
		sessionId: string;
		expectedGeneration: number;
		candidate: PendingHostLoadCandidate;
	}>
	| Readonly<{
		type: "host-preclear-candidate-held";
		sessionId: string;
		expectedGeneration: number;
		candidate: PendingHostLoadCandidate;
		completion: CompletedSamePathInputReceipt;
		sourceUnload: SettledSourceUnloadProof;
		observedNativeHistoryEpoch: number;
	}>
	| Readonly<{
		type: "target-presented";
		sessionId: string;
		expectedGeneration: number;
		receipt: TargetPresentationReceipt;
	}>
	| Readonly<{
		type: "binding-completed";
		sessionId: string;
		expectedGeneration: number;
		presentationTargetReadyTokenId: string;
		finalTargetReadyTokenId: string;
		fileId: string;
		ytext: Y.Text;
		cm?: EditorView;
		bindingEpochAfterBind: number;
	}>
	| Readonly<{
		type: "recovery-target-binding-requested";
		sessionId: string;
		expectedGeneration: number;
		recoveryOperationEpoch: number;
		intentId: string;
		recordId: string;
	}>
	| Readonly<{
		type: "intent-captured";
		sessionId: string;
		expectedGeneration: number;
		intent: HandoffInputIntent;
	}>
	| Readonly<{
		type: "recovery-operation-started";
		sessionId: string;
		expectedGeneration: number;
		operation: "persist" | "retry" | "copy" | "export" | "discard";
	}>
	| Readonly<{
		type: "intent-state-changed";
		sessionId: string;
		expectedGeneration: number;
		recoveryOperationEpoch: number;
		intentState: HandoffIntentState;
	}>
	| Readonly<{
		type: "cancelled";
		sessionId: string;
		expectedGeneration: number;
		reason: "closed" | "deleted" | "excluded" | "teardown" | "unsupported-host";
	}>;

type EditorHandoffEffectIdentity = Readonly<{
	sessionId: string;
	expectedGeneration: number;
}>;

export type EditorHandoffEffect = EditorHandoffEffectIdentity & (
	| Readonly<{ type: "cancel-pending-save" }>
	| Readonly<{ type: "block-save" }>
	| Readonly<{ type: "install-input-gate" }>
	| Readonly<{ type: "capture-authority-before-detach" }>
	| Readonly<{ type: "detach-binding" }>
	| Readonly<{ type: "request-target-presentation" }>
	| Readonly<{
		type: "persist-intent";
		intent: HandoffInputIntent;
		recoveryOperationEpoch: number;
	}>
	| Readonly<{
		type: "request-recovery-target-binding";
		recoveryOperationEpoch: number;
		intentId: string;
		recordId: string;
	}>
	| Readonly<{ type: "release-input-gate" }>
	| Readonly<{ type: "restore-save-pass-through" }>
);

export type HandoffReduction = Readonly<{
	state: ManagedLeafSession;
	effects: readonly EditorHandoffEffect[];
	accepted: boolean;
}>;

export type ManagedLeafInputStartReduction = Readonly<{
	state: ManagedLeafSession;
	inputStartSeq: number | null;
	inputStartedUnderSwitchSeq: number | null;
	accepted: boolean;
}>;

export function createManagedLeafSession(
	input: CreateManagedLeafSessionInput,
): ManagedLeafSession {
	return {
		sessionId: input.sessionId,
		leafId: input.leafId,
		generation: 0,
		eventOrderSeq: 0,
		currentSwitchIntentSeq: null,
		nativeHistoryEpoch: input.nativeHistoryEpoch ?? 0,
		completedDetachEpoch: null,
		activeRecoveries: [],
		pendingInputStartReservation: null,
		completedSamePathInput: null,
		view: input.view,
		displayedLineage: input.displayedLineage,
		binding: input.binding,
		handoff: null,
	};
}

export function reserveManagedLeafInputStart(
	state: ManagedLeafSession,
	input: Readonly<{
		sessionId: string;
		expectedGeneration: number;
		inputEpoch: number;
		compositionEpoch: number | null;
	}>,
): ManagedLeafInputStartReduction {
	if (
		input.sessionId !== state.sessionId
		|| input.expectedGeneration !== state.generation
		|| !Number.isSafeInteger(input.inputEpoch)
		|| input.inputEpoch < 0
		|| (
			input.compositionEpoch !== null
			&& (
				!Number.isSafeInteger(input.compositionEpoch)
				|| input.compositionEpoch < 0
			)
		)
	) {
		return {
			state,
			inputStartSeq: null,
			inputStartedUnderSwitchSeq: null,
			accepted: false,
		};
	}
	const inputStartSeq = state.eventOrderSeq + 1;
	const inputStartedUnderSwitchSeq = state.currentSwitchIntentSeq;
	const sourceAuthorityPathAtStart = state.handoff !== null
		? state.handoff.sourceAuthorityPath
		: state.binding.kind === "bound"
			? state.binding.path
			: state.displayedLineage.kind === "known"
				? state.displayedLineage.path
				: null;
	const sourceLineageAtStart = state.displayedLineage.kind === "known"
		? state.displayedLineage
		: null;
	return {
		state: {
			...state,
			eventOrderSeq: inputStartSeq,
			completedSamePathInput: null,
			pendingInputStartReservation: {
				inputStartSeq,
				inputStartedUnderSwitchSeq,
				inputEpoch: input.inputEpoch,
				compositionEpoch: input.compositionEpoch,
				handoffGenerationAtStart: state.generation,
				sourceAuthorityPathAtStart,
				sourceFileAtStart: sourceLineageAtStart?.file ?? null,
				sourceFileIdAtStart: sourceLineageAtStart?.fileId ?? null,
				sourceDocumentAtStart: sourceLineageAtStart?.document ?? null,
				targetPathAtStart: state.handoff?.targetPath ?? null,
				targetFileAtStart: state.handoff?.targetFile ?? null,
			},
		},
		inputStartSeq,
		inputStartedUnderSwitchSeq,
		accepted: true,
	};
}

function rejected(state: ManagedLeafSession): HandoffReduction {
	return { state, effects: [], accepted: false };
}

function effectIdentity(
	state: ManagedLeafSession,
): EditorHandoffEffectIdentity {
	return {
		sessionId: state.sessionId,
		expectedGeneration: state.generation,
	};
}

function isExactFileAuthority(
	state: ManagedLeafSession,
	targetFile: TFile,
): boolean {
	// The reducer can only recheck the retained identities available in its
	// frozen event vocabulary. The runtime must admit this event as a rename
	// shortcut only after the controller's pending-rename token is current.
	if (
		state.displayedLineage.kind !== "known"
		|| state.displayedLineage.file !== targetFile
		|| state.displayedLineage.fileId === null
		|| state.binding.kind !== "bound"
	) {
		return false;
	}
	return state.displayedLineage.fileId === state.binding.fileId;
}

function isReturnToDisplayedSource(
	state: ManagedLeafSession,
	targetFile: TFile,
): boolean {
	return state.handoff !== null
		&& state.displayedLineage.kind === "known"
		&& state.displayedLineage.file === targetFile
		&& state.displayedLineage.path === targetFile.path;
}

function isUnresolvedRecoveryTargetWake(
	state: ManagedLeafSession,
	targetFile: TFile,
): boolean {
	const handoff = state.handoff;
	const request = handoff?.recoveryTargetBindingRequest ?? null;
	const intentState = handoff?.intentState;
	if (
		handoff === null
		|| request === null
		|| targetFile !== handoff.targetFile
		|| targetFile.path !== handoff.targetPath
		|| handoff.presentation !== "target-proven"
		|| handoff.targetReadyTokenId === null
		|| !handoff.inputGateInstalled
		|| handoff.saveGuardInstalled
		|| handoff.pendingHostLoadCandidate !== null
		|| state.pendingInputStartReservation !== null
		|| state.displayedLineage.kind !== "known"
		|| state.displayedLineage.file !== handoff.targetFile
		|| state.displayedLineage.path !== handoff.targetPath
		|| state.displayedLineage.cm.state.doc !== state.displayedLineage.document
		|| (
			intentState?.kind !== "stored"
			&& intentState?.kind !== "replay-pending"
			&& intentState?.kind !== "replayed-awaiting-settlement"
		)
		|| request.recoveryOperationEpoch !== handoff.recoveryOperationEpoch
		|| request.intentId !== intentState.intentId
		|| request.recordId !== intentState.recordId
	) {
		return false;
	}
	if (state.binding.kind === "unbound") return true;
	return state.binding.path === handoff.targetPath
		&& state.displayedLineage.fileId === state.binding.fileId;
}

function reduceTargetTransition(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "target-selected" | "target-observed" }>,
): HandoffReduction {
	const selectedSwitchIntentSeq = state.eventOrderSeq + 1;
	if (
		event.type === "target-selected"
		&& (
			event.switchIntentSeq !== selectedSwitchIntentSeq
			|| event.sourceUnloadReceiptId.length === 0
		)
	) return rejected(state);
	if (isUnresolvedRecoveryTargetWake(state, event.targetFile)) {
		return rejected(state);
	}
	const observedHandoff = state.handoff;
	if (
		event.type === "target-selected"
		&& observedHandoff !== null
		&& observedHandoff.targetFile === event.targetFile
		&& observedHandoff.targetPath === event.targetFile.path
		&& observedHandoff.sourceUnloadReceiptId === null
		&& observedHandoff.presentation === "source"
		&& observedHandoff.targetReadyTokenId === null
		&& observedHandoff.pendingHostLoadCandidate === null
		&& observedHandoff.phase === "awaiting-host-load"
		&& observedHandoff.intentState.kind === "none"
		&& observedHandoff.recoveryTargetBindingRequest === null
		&& observedHandoff.bindingEpochAfterDetach >= 0
		&& state.binding.kind === "unbound"
		&& state.completedDetachEpoch === observedHandoff.bindingEpochAfterDetach
		&& state.currentSwitchIntentSeq === null
	) {
		const nextGeneration = state.generation + 1;
		const nextState: ManagedLeafSession = {
			...state,
			generation: nextGeneration,
			eventOrderSeq: event.switchIntentSeq,
			currentSwitchIntentSeq: event.switchIntentSeq,
			handoff: {
				...observedHandoff,
				sourceUnloadReceiptId: event.sourceUnloadReceiptId,
			},
		};
		return {
			state: nextState,
			effects: [{
				type: "request-target-presentation",
				...effectIdentity(nextState),
			}],
			accepted: true,
		};
	}
	if (
		observedHandoff !== null
		&& observedHandoff.targetFile === event.targetFile
		&& observedHandoff.targetPath === event.targetFile.path
	) {
		return rejected(state);
	}
	const nextSwitchIntentSeq = event.type === "target-selected"
		? selectedSwitchIntentSeq
		: null;
	const nextEventOrderSeq = event.type === "target-selected"
		? selectedSwitchIntentSeq
		: state.eventOrderSeq;
	const returnsToDisplayedSource = isReturnToDisplayedSource(state, event.targetFile);
	const exactFileAuthority = isExactFileAuthority(state, event.targetFile);
	const reservation = state.pendingInputStartReservation;
	const reservationStartedOnProvenTarget = reservation !== null
		&& state.handoff?.presentation === "target-proven"
		&& state.displayedLineage.kind === "known"
		&& reservation.sourceFileAtStart === state.displayedLineage.file
		&& reservation.sourceFileIdAtStart === state.displayedLineage.fileId
		&& reservation.sourceDocumentAtStart === state.displayedLineage.document
		&& reservation.targetPathAtStart === state.handoff.targetPath
		&& reservation.targetFileAtStart === state.handoff.targetFile;
	if (
		reservation !== null
		&& (
			returnsToDisplayedSource
			|| exactFileAuthority
			|| (state.handoff !== null && !reservationStartedOnProvenTarget)
		)
	) {
		return rejected(state);
	}

	const nextGeneration = state.generation + 1;
	if (returnsToDisplayedSource || exactFileAuthority) {
		const targetPath = event.targetFile.path;
		const displayedLineage = returnsToDisplayedSource
			? state.displayedLineage
			: state.displayedLineage.kind === "known"
			? {
				...state.displayedLineage,
				file: event.targetFile,
				path: targetPath,
			} as const
			: state.displayedLineage;
		const binding = returnsToDisplayedSource
			? state.binding
			: state.binding.kind === "bound"
			? { ...state.binding, path: targetPath } as const
			: state.binding;
		const nextState: ManagedLeafSession = {
			...state,
			generation: nextGeneration,
			eventOrderSeq: nextEventOrderSeq,
			currentSwitchIntentSeq: nextSwitchIntentSeq,
			completedSamePathInput: null,
			completedDetachEpoch: binding.kind === "unbound"
				? state.completedDetachEpoch
				: null,
			displayedLineage,
			binding,
			handoff: null,
		};
		const identity = effectIdentity(nextState);
		const effects: EditorHandoffEffect[] = [];
		if (state.handoff?.inputGateInstalled) {
			effects.push({ type: "release-input-gate", ...identity });
		}
		if (state.handoff?.saveGuardInstalled) {
			effects.push({ type: "restore-save-pass-through", ...identity });
		}
		return {
			state: nextState,
			effects,
			accepted: true,
		};
	}

	const detachAlreadyCompleted = state.binding.kind === "unbound"
		&& state.completedDetachEpoch !== null;
	const bindingEpochAfterDetach = detachAlreadyCompleted
		? state.completedDetachEpoch ?? -1
		: -1;
	const nextState: ManagedLeafSession = {
		...state,
		generation: nextGeneration,
		eventOrderSeq: nextEventOrderSeq,
		currentSwitchIntentSeq: nextSwitchIntentSeq,
		completedDetachEpoch: detachAlreadyCompleted
			? state.completedDetachEpoch
			: null,
		handoff: {
			sourceAuthorityPath: state.handoff !== null
				? state.handoff.presentation === "target-proven"
					&& state.displayedLineage.kind === "known"
					? state.displayedLineage.path
					: state.handoff.sourceAuthorityPath
				: state.binding.kind === "bound"
					? state.binding.path
					: state.displayedLineage.kind === "known"
						? state.displayedLineage.path
						: null,
			sourceUnloadReceiptId: event.type === "target-selected"
				? event.sourceUnloadReceiptId
				: null,
			targetPath: event.targetFile.path,
			targetFile: event.targetFile,
			bindingEpochAfterDetach,
			presentation: "source",
			targetReadyTokenId: null,
			inputGateInstalled: true,
			saveGuardInstalled: true,
			recoveryOperationEpoch: 0,
			intentState: { kind: "none" },
			recoveryTargetBindingRequest: null,
			phase: "awaiting-host-load",
			pendingHostLoadCandidate: null,
		},
	};
	const identity = effectIdentity(nextState);
	const effects: EditorHandoffEffect[] = [
		{ type: "cancel-pending-save", ...identity },
		{ type: "block-save", ...identity },
		{ type: "install-input-gate", ...identity },
	];
	if (detachAlreadyCompleted) {
		effects.push({ type: "request-target-presentation", ...identity });
	} else {
		effects.push(
			{ type: "capture-authority-before-detach", ...identity },
			{ type: "detach-binding", ...identity },
		);
	}
	return {
		state: nextState,
		effects,
		accepted: true,
	};
}

function reduceDetachCompleted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "detach-completed" }>,
): HandoffReduction {
	const handoff = state.handoff;
	if (
		handoff === null
		|| handoff.bindingEpochAfterDetach !== -1
		|| event.bindingEpochAfterDetach < 0
		|| (
			handoff.pendingHostLoadCandidate !== null
			&& handoff.pendingHostLoadCandidate.bindingEpoch !== event.bindingEpochAfterDetach
		)
	) {
		return rejected(state);
	}
	const nextState: ManagedLeafSession = {
		...state,
		completedDetachEpoch: event.bindingEpochAfterDetach,
		binding: { kind: "unbound" },
		handoff: {
			...handoff,
			bindingEpochAfterDetach: event.bindingEpochAfterDetach,
			phase: handoff.pendingHostLoadCandidate === null
				? "awaiting-host-load"
				: "awaiting-target-ready",
		},
	};
	return {
		state: nextState,
		effects: [{
			type: "request-target-presentation",
			...effectIdentity(nextState),
		}],
		accepted: true,
	};
}

function reduceSamePathInputCompleted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "same-path-input-completed" }>,
): HandoffReduction {
	const displayed = state.displayedLineage;
	const reservation = state.pendingInputStartReservation;
	const stableSamePathPresentation = state.handoff === null
		|| (
			state.handoff.presentation === "target-proven"
			&& !state.handoff.inputGateInstalled
			&& !state.handoff.saveGuardInstalled
			&& state.handoff.pendingHostLoadCandidate === null
		);
	const sourceHeldAfterTargetSelection = reservation !== null
		&& state.handoff !== null
		&& state.handoff.presentation === "source"
		&& state.handoff.pendingHostLoadCandidate === null
		&& state.currentSwitchIntentSeq !== null
		&& reservation.inputStartSeq + 1 === state.currentSwitchIntentSeq
		&& reservation.inputStartedUnderSwitchSeq !== state.currentSwitchIntentSeq
		&& reservation.handoffGenerationAtStart + 1 === state.generation
		&& state.handoff.sourceAuthorityPath === (
			displayed.kind === "known" ? displayed.path : null
		);
	if (
		(!stableSamePathPresentation && !sourceHeldAfterTargetSelection)
		|| displayed.kind !== "known"
		|| reservation === null
		|| reservation !== event.reservation
		|| reservation.compositionEpoch === null
		|| (
			sourceHeldAfterTargetSelection
				? reservation.handoffGenerationAtStart + 1 !== state.generation
				: reservation.handoffGenerationAtStart !== state.generation
		)
		|| reservation.sourceFileAtStart !== displayed.file
		|| reservation.sourceFileIdAtStart !== displayed.fileId
		|| reservation.sourceDocumentAtStart === null
		|| reservation.sourceDocumentAtStart !== event.startDocument
		|| (
			sourceHeldAfterTargetSelection
				? false
				: state.handoff === null
			? (
				reservation.sourceAuthorityPathAtStart !== displayed.path
				|| reservation.targetPathAtStart !== null
				|| reservation.targetFileAtStart !== null
			)
			: (
				reservation.targetPathAtStart !== state.handoff.targetPath
				|| reservation.targetFileAtStart !== state.handoff.targetFile
				|| state.handoff.targetPath !== displayed.path
				|| state.handoff.targetFile !== displayed.file
			)
		)
		|| event.cm !== displayed.cm
		|| event.finalDocument !== displayed.document
		|| event.cm.state.doc !== event.finalDocument
		|| !Number.isSafeInteger(event.editorRevision)
		|| event.editorRevision < 0
		|| event.editorRevision !== displayed.editorRevision
	) {
		return rejected(state);
	}
	const receipt: CompletedSamePathInputReceipt = {
		reservation,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGenerationAtCompletion: state.generation,
		file: displayed.file,
		path: displayed.path,
		fileId: displayed.fileId,
		cm: displayed.cm,
		startDocument: event.startDocument,
		finalDocument: event.finalDocument,
		editorRevision: event.editorRevision,
	};
	return {
		state: {
			...state,
			pendingInputStartReservation: null,
			completedSamePathInput: receipt,
		},
		effects: [],
		accepted: true,
	};
}

function isCurrentHostCandidateBase(
	state: ManagedLeafSession,
	candidate: PendingHostLoadCandidate,
	expectedNativeHistoryEpoch = state.nativeHistoryEpoch,
): boolean {
	const handoff = state.handoff;
	return handoff !== null
		&& handoff.presentation !== "target-proven"
		&& handoff.pendingHostLoadCandidate === null
		&& handoff.bindingEpochAfterDetach >= 0
		&& handoff.sourceUnloadReceiptId !== null
		&& candidate.sourceUnloadReceiptId === handoff.sourceUnloadReceiptId
		&& candidate.sessionId === state.sessionId
		&& candidate.leafId === state.leafId
		&& candidate.handoffGeneration === state.generation
		&& candidate.switchIntentSeq === state.currentSwitchIntentSeq
		&& candidate.targetPathAtDispatch === handoff.targetPath
		&& candidate.runtimeView === state.view
		&& candidate.hostLoadCompletedEpoch === null
		&& candidate.hostSetViewDataClear === true
		&& Number.isSafeInteger(candidate.editorRevisionBefore)
		&& candidate.editorRevisionBefore >= 0
		&& candidate.editorRevisionBefore < Number.MAX_SAFE_INTEGER
		&& candidate.nativeHistoryEpochBefore === expectedNativeHistoryEpoch
		&& candidate.bindingEpoch === handoff.bindingEpochAfterDetach;
}

function reduceHostCandidateHeld(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "host-candidate-held" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const candidate = event.candidate;
	if (
		!isCurrentHostCandidateBase(state, candidate)
		|| handoff === null
		|| (
			state.displayedLineage.kind === "known"
			&& (
				candidate.startDocument !== state.displayedLineage.document
				|| candidate.editorRevisionBefore
					!== state.displayedLineage.editorRevision
			)
		)
	) {
		return rejected(state);
	}
	const nextState: ManagedLeafSession = {
		...state,
		completedSamePathInput: null,
		handoff: {
			...handoff,
			presentation: "target-candidate",
			phase: "awaiting-target-ready",
			pendingHostLoadCandidate: candidate,
		},
	};
	return {
		state: nextState,
		effects: [{
			type: "request-target-presentation",
			...effectIdentity(nextState),
		}],
		accepted: true,
	};
}

function reduceHostPreclearCandidateHeld(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "host-preclear-candidate-held" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const displayed = state.displayedLineage;
	const candidate = event.candidate;
	const completion = state.completedSamePathInput;
	const sourceUnload = event.sourceUnload;
	const completionPrecededSelection = completion !== null
		&& completion.handoffGenerationAtCompletion === state.generation - 1
		&& completion.reservation.handoffGenerationAtStart
			=== completion.handoffGenerationAtCompletion;
	const completionSettledWhileSourceHeld = completion !== null
		&& completion.handoffGenerationAtCompletion === state.generation
		&& completion.reservation.handoffGenerationAtStart === state.generation - 1;
	if (
		!Number.isSafeInteger(event.observedNativeHistoryEpoch)
		|| event.observedNativeHistoryEpoch < state.nativeHistoryEpoch
		|| event.observedNativeHistoryEpoch !== candidate.nativeHistoryEpochBefore
		|| !isCurrentHostCandidateBase(
			state,
			candidate,
			event.observedNativeHistoryEpoch,
		)
		|| handoff === null
		|| handoff.presentation !== "source"
		|| handoff.phase !== "awaiting-host-load"
		|| displayed.kind !== "known"
		|| state.pendingInputStartReservation !== null
		|| completion === null
		|| event.completion !== completion
		|| completion.sessionId !== state.sessionId
		|| completion.leafId !== state.leafId
		|| (!completionPrecededSelection && !completionSettledWhileSourceHeld)
		|| completion.reservation.compositionEpoch === null
		|| completion.reservation.inputStartSeq + 1 !== state.currentSwitchIntentSeq
		|| completion.file !== displayed.file
		|| completion.path !== displayed.path
		|| completion.fileId !== displayed.fileId
		|| completion.cm !== displayed.cm
		|| completion.finalDocument !== displayed.document
		|| completion.editorRevision !== displayed.editorRevision
		|| handoff.sourceAuthorityPath !== completion.path
		|| sourceUnload.receiptId !== handoff.sourceUnloadReceiptId
		|| sourceUnload.receiptId !== candidate.sourceUnloadReceiptId
		|| sourceUnload.file !== completion.file
		|| sourceUnload.path !== completion.path
		|| sourceUnload.state !== "settled"
		|| sourceUnload.forcedSaveObserved !== true
		|| candidate.applicationKind !== "state"
		|| candidate.heldTransaction !== null
		|| candidate.heldState === null
		|| candidate.cm !== completion.cm
		|| candidate.startDocument !== candidate.cm.state.doc
		|| candidate.startDocument.length !== 0
		|| candidate.startDocument === completion.finalDocument
		|| candidate.editorRevisionBefore !== completion.editorRevision
	) {
		return rejected(state);
	}
	const nextState: ManagedLeafSession = {
		...state,
		nativeHistoryEpoch: event.observedNativeHistoryEpoch,
		completedSamePathInput: null,
		handoff: {
			...handoff,
			presentation: "target-candidate",
			phase: "awaiting-target-ready",
			pendingHostLoadCandidate: candidate,
		},
	};
	return {
		state: nextState,
		effects: [{
			type: "request-target-presentation",
			...effectIdentity(nextState),
		}],
		accepted: true,
	};
}

function intentAllowsInputGateRelease(intentState: HandoffIntentState): boolean {
	switch (intentState.kind) {
		case "none":
		case "needs-review":
		case "escaped":
		case "resolved":
		case "discarded":
			return true;
		case "persisting":
		case "stored":
		case "replay-pending":
		case "replayed-awaiting-settlement":
		case "escape-pending":
		case "failed":
			return false;
	}
}

function phaseForIntent(
	intentState: HandoffIntentState,
): NonNullable<ManagedLeafSession["handoff"]>["phase"] {
	switch (intentState.kind) {
		case "none":
		case "needs-review":
		case "escaped":
		case "resolved":
		case "discarded":
			return "target-ready";
		case "persisting":
		case "stored":
			return "awaiting-recovery-commit";
		case "replay-pending":
		case "replayed-awaiting-settlement":
			return "awaiting-replay-settlement";
		case "escape-pending":
		case "failed":
			return "awaiting-recovery-decision";
	}
}

function isCurrentPresentationReceipt(
	state: ManagedLeafSession,
	handoff: NonNullable<ManagedLeafSession["handoff"]>,
	candidate: PendingHostLoadCandidate,
	receipt: TargetPresentationReceipt,
): boolean {
	const host = receipt.hostLoadCompletionReceipt;
	const token = receipt.replacementTargetReadyToken;
	// The frozen reducer event has no presentation-plan issuance transition;
	// the controller owns that one-shot permit. Here we require an opaque plan
	// identity and CAS the complete held-candidate/receipt/token lineage.
	return receipt.receiptId.length > 0
		&& receipt.presentationPlanId.length > 0
		&& handoff.sourceUnloadReceiptId !== null
		&& candidate.sourceUnloadReceiptId === handoff.sourceUnloadReceiptId
		&& Number.isSafeInteger(candidate.editorRevisionBefore)
		&& candidate.editorRevisionBefore >= 0
		&& candidate.editorRevisionBefore < Number.MAX_SAFE_INTEGER
		&& (
			state.displayedLineage.kind !== "known"
			|| state.displayedLineage.editorRevision
				=== candidate.editorRevisionBefore
		)
		&& host.receiptId.length > 0
		&& host.hostLoadTokenId === candidate.hostLoadTokenId
		&& host.switchIntentSeq === state.currentSwitchIntentSeq
		&& host.sessionId === state.sessionId
		&& host.leafId === state.leafId
		&& host.handoffGeneration === state.generation
		&& host.targetPath === handoff.targetPath
		&& host.nativeHistoryEpoch > candidate.nativeHistoryEpochBefore
		&& host.nativeHistoryEpoch > state.nativeHistoryEpoch
		&& host.historyResetObserved === true
		&& host.targetSelection === candidate.proposedSelection
		&& host.targetScrollAnchor === candidate.proposedScrollAnchor
		&& host.effectFingerprint === candidate.effectFingerprint
		&& token.tokenId.length > 0
		&& token.sessionId === state.sessionId
		&& token.leafId === state.leafId
		&& token.handoffGeneration === state.generation
		&& token.switchIntentSeq === state.currentSwitchIntentSeq
		&& token.targetPath === handoff.targetPath
		&& token.targetFile === handoff.targetFile
		&& token.hostLoadTokenId === candidate.hostLoadTokenId
		&& token.hostLoadCompletedEpoch > 0
		&& token.hostLoadReceiptId === host.receiptId
		&& token.nativeHistoryEpoch === host.nativeHistoryEpoch
		&& token.targetSelectionEpoch === host.targetSelectionEpoch
		&& token.targetScrollEpoch === host.targetScrollEpoch
		&& token.certifiedBaseContent === candidate.incomingContent
		&& candidate.targetDocument.toString() === candidate.incomingContent;
}

function reduceTargetPresented(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "target-presented" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const candidate = handoff?.pendingHostLoadCandidate ?? null;
	if (
		handoff === null
		|| handoff.presentation !== "target-candidate"
		|| candidate === null
		|| !isCurrentPresentationReceipt(state, handoff, candidate, event.receipt)
	) {
		return rejected(state);
	}

	const token = event.receipt.replacementTargetReadyToken;
	const releaseInputGate = handoff.inputGateInstalled
		&& state.pendingInputStartReservation === null
		&& intentAllowsInputGateRelease(handoff.intentState);
	const restoreSavePassThrough = handoff.saveGuardInstalled;
	const nextState: ManagedLeafSession = {
		...state,
		nativeHistoryEpoch: token.nativeHistoryEpoch,
		completedSamePathInput: null,
		displayedLineage: {
			kind: "known",
			file: handoff.targetFile,
			path: handoff.targetPath,
			fileId: token.targetAuthority.kind === "existing"
				? token.targetAuthority.fileId
				: null,
			cm: candidate.cm,
			document: candidate.cm.state.doc,
			editorRevision: candidate.editorRevisionBefore + 1,
		},
		handoff: {
			...handoff,
			presentation: "target-proven",
			targetReadyTokenId: token.tokenId,
			inputGateInstalled: releaseInputGate ? false : handoff.inputGateInstalled,
			saveGuardInstalled: restoreSavePassThrough ? false : handoff.saveGuardInstalled,
			phase: phaseForIntent(handoff.intentState),
			pendingHostLoadCandidate: null,
		},
	};
	const identity = effectIdentity(nextState);
	const effects: EditorHandoffEffect[] = [];
	if (releaseInputGate) effects.push({ type: "release-input-gate", ...identity });
	if (restoreSavePassThrough) effects.push({ type: "restore-save-pass-through", ...identity });
	return { state: nextState, effects, accepted: true };
}

function reduceBindingCompleted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "binding-completed" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const displayed = state.displayedLineage;
	const recoveryRequest = handoff?.recoveryTargetBindingRequest ?? null;
	const recoveryIntentState =
		handoff?.intentState.kind === "stored"
		|| handoff?.intentState.kind === "replay-pending"
			? handoff.intentState
			: null;
	const exactActiveRecovery = handoff !== null
		&& recoveryRequest !== null
		&& recoveryIntentState !== null
		&& state.activeRecoveries.some((recovery) =>
			recovery.sessionId === state.sessionId
			&& recovery.handoffGeneration === state.generation
			&& recovery.recoveryOperationEpoch === handoff.recoveryOperationEpoch
			&& recovery.recoveryOperationEpoch === recoveryRequest.recoveryOperationEpoch
			&& recovery.intentState.kind === recoveryIntentState.kind
			&& recovery.intentState.intentId === recoveryIntentState.intentId
			&& recovery.intentState.recordId === recoveryIntentState.recordId
			&& recovery.intent.intentId === recoveryIntentState.intentId
			&& recovery.intent.targetPath === handoff.targetPath
			&& recovery.intent.targetFile === handoff.targetFile
		);
	if (
		handoff !== null
		&& recoveryRequest !== null
		&& recoveryIntentState !== null
		&& exactActiveRecovery
		&& recoveryRequest.recoveryOperationEpoch === handoff.recoveryOperationEpoch
		&& recoveryRequest.intentId === recoveryIntentState.intentId
		&& recoveryRequest.recordId === recoveryIntentState.recordId
		&& handoff.presentation === "target-proven"
		&& handoff.targetReadyTokenId === event.presentationTargetReadyTokenId
		&& event.presentationTargetReadyTokenId.length > 0
		&& event.finalTargetReadyTokenId.length > 0
		&& event.fileId.length > 0
		&& handoff.pendingHostLoadCandidate === null
		&& handoff.inputGateInstalled
		&& !handoff.saveGuardInstalled
		&& handoff.phase === phaseForIntent(recoveryIntentState)
		&& state.pendingInputStartReservation === null
		&& state.binding.kind === "unbound"
		&& displayed.kind === "known"
		&& displayed.file === handoff.targetFile
		&& displayed.path === handoff.targetPath
		&& displayed.cm === event.cm
		&& displayed.cm.state.doc === displayed.document
		&& event.bindingEpochAfterBind === handoff.bindingEpochAfterDetach + 1
	) {
		return {
			state: {
				...state,
				completedDetachEpoch: null,
				displayedLineage: {
					...displayed,
					fileId: event.fileId,
				},
				binding: {
					kind: "bound",
					path: handoff.targetPath,
					fileId: event.fileId,
					ytext: event.ytext,
				},
				handoff: {
					...handoff,
					targetReadyTokenId: event.finalTargetReadyTokenId,
				},
			},
			effects: [],
			accepted: true,
		};
	}
	if (
		handoff === null
		|| handoff.presentation !== "target-proven"
		|| handoff.targetReadyTokenId !== event.presentationTargetReadyTokenId
		|| event.presentationTargetReadyTokenId.length === 0
		|| event.finalTargetReadyTokenId.length === 0
		|| event.fileId.length === 0
		|| handoff.pendingHostLoadCandidate !== null
		|| handoff.inputGateInstalled
		|| handoff.saveGuardInstalled
		|| handoff.phase !== "target-ready"
		|| state.pendingInputStartReservation !== null
		|| displayed.kind !== "known"
		|| displayed.file !== handoff.targetFile
		|| displayed.path !== handoff.targetPath
		|| displayed.cm.state.doc !== displayed.document
		|| event.bindingEpochAfterBind !== handoff.bindingEpochAfterDetach + 1
	) {
		return rejected(state);
	}
	return {
		state: {
			...state,
			currentSwitchIntentSeq: null,
			completedDetachEpoch: null,
			displayedLineage: {
				...displayed,
				fileId: event.fileId,
			},
			binding: {
				kind: "bound",
				path: handoff.targetPath,
				fileId: event.fileId,
				ytext: event.ytext,
			},
			handoff: null,
		},
		effects: [],
		accepted: true,
	};
}

function reduceRecoveryTargetBindingRequested(
	state: ManagedLeafSession,
	event: Extract<
		EditorHandoffEvent,
		{ type: "recovery-target-binding-requested" }
	>,
): HandoffReduction {
	const handoff = state.handoff;
	if (
		handoff === null
		|| handoff.recoveryTargetBindingRequest !== null
		|| handoff.presentation !== "target-proven"
		|| handoff.targetReadyTokenId === null
		|| handoff.pendingHostLoadCandidate !== null
		|| !handoff.inputGateInstalled
		|| handoff.saveGuardInstalled
		|| handoff.phase !== "awaiting-recovery-commit"
		|| handoff.intentState.kind !== "stored"
		|| handoff.recoveryOperationEpoch !== event.recoveryOperationEpoch
		|| handoff.intentState.intentId !== event.intentId
		|| handoff.intentState.recordId !== event.recordId
		|| state.binding.kind !== "unbound"
		|| state.pendingInputStartReservation !== null
		|| state.displayedLineage.kind !== "known"
		|| state.displayedLineage.file !== handoff.targetFile
		|| state.displayedLineage.path !== handoff.targetPath
		|| state.displayedLineage.cm.state.doc !== state.displayedLineage.document
		|| !state.activeRecoveries.some((recovery) =>
			recovery.sessionId === state.sessionId
			&& recovery.handoffGeneration === state.generation
			&& recovery.recoveryOperationEpoch === event.recoveryOperationEpoch
			&& recovery.intentState.kind === "stored"
			&& recovery.intentState.intentId === event.intentId
			&& recovery.intentState.recordId === event.recordId
			&& recovery.intent.intentId === event.intentId
			&& recovery.intent.targetPath === handoff.targetPath
			&& recovery.intent.targetFile === handoff.targetFile
		)
	) {
		return rejected(state);
	}
	const request = {
		recoveryOperationEpoch: event.recoveryOperationEpoch,
		intentId: event.intentId,
		recordId: event.recordId,
	} as const;
	const nextState: ManagedLeafSession = {
		...state,
		handoff: {
			...handoff,
			recoveryTargetBindingRequest: request,
		},
	};
	return {
		state: nextState,
		effects: [{
			type: "request-recovery-target-binding",
			...effectIdentity(nextState),
			...request,
		}],
		accepted: true,
	};
}

function isCurrentIntent(
	state: ManagedLeafSession,
	handoff: NonNullable<ManagedLeafSession["handoff"]>,
	intent: HandoffInputIntent,
): boolean {
	const reservation = state.pendingInputStartReservation;
	const expectedFromFileId = reservation?.sourceFileIdAtStart ?? null;
	const switchIntentSeq = state.currentSwitchIntentSeq;
	const sameHandoffLineage = reservation !== null
		&& reservation.handoffGenerationAtStart === state.generation
		&& reservation.sourceAuthorityPathAtStart === handoff.sourceAuthorityPath
		&& reservation.targetPathAtStart === handoff.targetPath
		&& reservation.targetFileAtStart === handoff.targetFile;
	const previousNoHandoffLineage = reservation !== null
		&& reservation.handoffGenerationAtStart === state.generation - 1
		&& reservation.targetPathAtStart === null
		&& reservation.targetFileAtStart === null
		&& reservation.sourceAuthorityPathAtStart === handoff.sourceAuthorityPath;
	const previousProvenTargetLineage = reservation !== null
		&& reservation.handoffGenerationAtStart === state.generation - 1
		&& reservation.targetPathAtStart === handoff.sourceAuthorityPath
		&& reservation.targetFileAtStart !== null
		&& reservation.targetFileAtStart === reservation.sourceFileAtStart;
	const beganBeforeCurrentHandoff = reservation !== null
		&& switchIntentSeq !== null
		&& (previousNoHandoffLineage || previousProvenTargetLineage)
		&& intent.sequenceBegan === "before-handoff"
		&& reservation.inputStartSeq < switchIntentSeq
		&& (
			reservation.inputStartedUnderSwitchSeq === null
			|| (
				reservation.inputStartedUnderSwitchSeq < switchIntentSeq
				&& reservation.inputStartSeq > reservation.inputStartedUnderSwitchSeq
			)
		);
	const beganAfterTargetSelected = reservation !== null
		&& switchIntentSeq !== null
		&& sameHandoffLineage
		&& intent.sequenceBegan === "after-target-selected"
		&& reservation.inputStartedUnderSwitchSeq === switchIntentSeq
		&& reservation.inputStartSeq > switchIntentSeq;
	const sequenceMatches = beganBeforeCurrentHandoff || beganAfterTargetSelected;
	return intent.intentId.length > 0
		&& reservation !== null
		&& intent.sessionId === state.sessionId
		&& intent.leafId === state.leafId
		&& intent.handoffGeneration === state.generation
		&& intent.fromPath === handoff.sourceAuthorityPath
		&& intent.fromFileId === expectedFromFileId
		&& intent.targetPath === handoff.targetPath
		&& intent.targetFile === handoff.targetFile
		&& intent.bindingEpoch === handoff.bindingEpochAfterDetach
		&& intent.switchIntentSeq === state.currentSwitchIntentSeq
		&& intent.inputStartSeq === reservation.inputStartSeq
		&& intent.inputStartedUnderSwitchSeq === reservation.inputStartedUnderSwitchSeq
		&& intent.inputEpoch === reservation.inputEpoch
		&& intent.compositionEpoch === reservation.compositionEpoch
		&& sequenceMatches
		&& reservation.sourceDocumentAtStart !== null
		&& intent.startDocument === reservation.sourceDocumentAtStart;
}

function reduceIntentCaptured(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "intent-captured" }>,
): HandoffReduction {
	const handoff = state.handoff;
	if (
		handoff === null
		|| handoff.intentState.kind !== "none"
		|| !handoff.inputGateInstalled
		|| handoff.bindingEpochAfterDetach < 0
		|| !isCurrentIntent(state, handoff, event.intent)
		|| state.activeRecoveries.some((recovery) =>
			recovery.sessionId === state.sessionId
			&& recovery.handoffGeneration === state.generation
			&& recovery.intent.intentId === event.intent.intentId
		)
	) {
		return rejected(state);
	}
	const recoveryOperationEpoch = handoff.recoveryOperationEpoch + 1;
	const intentState = {
		kind: "persisting",
		intentId: event.intent.intentId,
	} as const;
	const nextState: ManagedLeafSession = {
		...state,
		pendingInputStartReservation: null,
		completedSamePathInput: null,
		activeRecoveries: [...state.activeRecoveries, {
			sessionId: state.sessionId,
			handoffGeneration: state.generation,
			recoveryOperationEpoch,
			intentState,
			intent: event.intent,
		}],
		handoff: {
			...handoff,
			recoveryOperationEpoch,
			intentState,
			phase: "awaiting-recovery-commit",
		},
	};
	return {
		state: nextState,
		effects: [{
			type: "persist-intent",
			...effectIdentity(nextState),
			intent: event.intent,
			recoveryOperationEpoch,
		}],
		accepted: true,
	};
}

function intentIdOf(intentState: HandoffIntentState): string | null {
	return intentState.kind === "none" ? null : intentState.intentId;
}

function retainsActiveRecovery(
	intentState: HandoffIntentState,
): intentState is ManagedLeafRecovery["intentState"] {
	switch (intentState.kind) {
		case "persisting":
		case "stored":
		case "replay-pending":
		case "replayed-awaiting-settlement":
		case "escape-pending":
		case "failed":
			return true;
		case "none":
		case "needs-review":
		case "escaped":
		case "resolved":
		case "discarded":
			return false;
	}
}

function activeRecoveryIndex(
	state: ManagedLeafSession,
	handoffGeneration: number,
	recoveryOperationEpoch: number,
	intentId: string,
): number {
	return state.activeRecoveries.findIndex((recovery) =>
		recovery.sessionId === state.sessionId
		&& recovery.handoffGeneration === handoffGeneration
		&& recovery.recoveryOperationEpoch === recoveryOperationEpoch
		&& recovery.intent.intentId === intentId
		&& intentIdOf(recovery.intentState) === intentId
	);
}

function transitionActiveRecovery(
	state: ManagedLeafSession,
	recoveryIndex: number,
	intentState: HandoffIntentState,
	recoveryOperationEpoch?: number,
): readonly ManagedLeafRecovery[] {
	if (!retainsActiveRecovery(intentState)) {
		return state.activeRecoveries.filter((_, index) => index !== recoveryIndex);
	}
	return state.activeRecoveries.map((recovery, index) => index === recoveryIndex
		? {
			...recovery,
			recoveryOperationEpoch:
				recoveryOperationEpoch ?? recovery.recoveryOperationEpoch,
			intentState,
		}
		: recovery);
}

function recordIdOf(intentState: HandoffIntentState): string | null {
	switch (intentState.kind) {
		case "stored":
		case "replay-pending":
		case "replayed-awaiting-settlement":
		case "needs-review":
		case "resolved":
			return intentState.recordId;
		case "discarded":
			return intentState.recordId;
		case "none":
		case "persisting":
		case "escape-pending":
		case "escaped":
		case "failed":
			return null;
	}
}

function hasValidIntentPayload(intentState: HandoffIntentState): boolean {
	if (intentState.kind === "none") return true;
	if (intentState.intentId.length === 0) return false;
	switch (intentState.kind) {
		case "stored":
		case "replay-pending":
		case "replayed-awaiting-settlement":
		case "needs-review":
		case "resolved":
			return intentState.recordId.length > 0;
		case "failed":
			return intentState.reason.length > 0;
		case "persisting":
		case "escape-pending":
		case "escaped":
		case "discarded":
			return true;
	}
}

function isLegalIntentStateChange(
	current: HandoffIntentState,
	next: HandoffIntentState,
): boolean {
	const currentIntentId = intentIdOf(current);
	if (
		currentIntentId === null
		|| intentIdOf(next) !== currentIntentId
		|| !hasValidIntentPayload(next)
	) {
		return false;
	}
	const currentRecordId = recordIdOf(current);
	const nextRecordId = recordIdOf(next);
	if (
		currentRecordId !== null
		&& nextRecordId !== null
		&& currentRecordId !== nextRecordId
	) {
		return false;
	}

	switch (current.kind) {
		case "none":
		case "escaped":
		case "resolved":
		case "discarded":
			return false;
		case "persisting":
			return next.kind === "stored" || next.kind === "failed";
		case "stored":
			return next.kind === "replay-pending"
				|| next.kind === "needs-review"
				|| next.kind === "failed";
		case "replay-pending":
			return next.kind === "replayed-awaiting-settlement"
				|| next.kind === "needs-review"
				|| next.kind === "failed";
		case "replayed-awaiting-settlement":
			return next.kind === "resolved"
				|| next.kind === "needs-review"
				|| next.kind === "failed";
		case "needs-review":
			return next.kind === "resolved" || next.kind === "discarded";
		case "failed":
			return false;
		case "escape-pending":
			if (next.kind === "failed") return true;
			if (current.action === "discard") return next.kind === "discarded";
			return next.kind === "escaped" && next.action === current.action;
	}
}

function phaseAfterIntentChange(
	handoff: NonNullable<ManagedLeafSession["handoff"]>,
	intentState: HandoffIntentState,
): NonNullable<ManagedLeafSession["handoff"]>["phase"] {
	if (handoff.presentation === "target-proven") return phaseForIntent(intentState);
	switch (intentState.kind) {
		case "persisting":
		case "stored":
			return "awaiting-recovery-commit";
		case "replay-pending":
		case "replayed-awaiting-settlement":
			return "awaiting-replay-settlement";
		case "failed":
		case "escape-pending":
		case "needs-review":
			return "awaiting-recovery-decision";
		case "none":
		case "escaped":
		case "resolved":
		case "discarded":
			return handoff.pendingHostLoadCandidate === null
				? "awaiting-host-load"
				: "awaiting-target-ready";
	}
}

function intentStateAfterRecoveryOperation(
	current: HandoffIntentState,
	operation: Extract<
		EditorHandoffEvent,
		{ type: "recovery-operation-started" }
	>["operation"],
): ManagedLeafRecovery["intentState"] | null {
	const intentId = intentIdOf(current);
	if (intentId === null || operation === "persist") return null;
	if (operation === "retry") {
		return current.kind === "failed"
			? { kind: "persisting", intentId }
			: null;
	}
	if (
		current.kind !== "persisting"
		&& current.kind !== "failed"
		&& current.kind !== "escape-pending"
	) return null;
	return {
		kind: "escape-pending",
		intentId,
		action: operation,
	};
}

function reduceRecoveryOperationStarted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "recovery-operation-started" }>,
): HandoffReduction {
	const handoff = state.handoff;
	if (handoff === null) return rejected(state);
	const intentId = intentIdOf(handoff.intentState);
	if (intentId === null) return rejected(state);
	const recoveryIndex = activeRecoveryIndex(
		state,
		state.generation,
		handoff.recoveryOperationEpoch,
		intentId,
	);
	const intentState = intentStateAfterRecoveryOperation(
		handoff.intentState,
		event.operation,
	);
	if (recoveryIndex < 0 || intentState === null) return rejected(state);
	const recoveryOperationEpoch = handoff.recoveryOperationEpoch + 1;

	const nextState: ManagedLeafSession = {
		...state,
		activeRecoveries: transitionActiveRecovery(
			state,
			recoveryIndex,
			intentState,
			recoveryOperationEpoch,
		),
		handoff: {
			...handoff,
			recoveryOperationEpoch,
			intentState,
			phase: phaseAfterIntentChange(handoff, intentState),
		},
	};
	return { state: nextState, effects: [], accepted: true };
}

function reduceIntentStateChanged(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "intent-state-changed" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const currentIntentId = handoff === null ? null : intentIdOf(handoff.intentState);
	if (
		handoff === null
		|| currentIntentId === null
		|| event.recoveryOperationEpoch !== handoff.recoveryOperationEpoch
		|| !isLegalIntentStateChange(handoff.intentState, event.intentState)
	) {
		return rejected(state);
	}
	const recoveryIndex = activeRecoveryIndex(
		state,
		state.generation,
		handoff.recoveryOperationEpoch,
		currentIntentId,
	);
	if (retainsActiveRecovery(handoff.intentState) && recoveryIndex < 0) {
		return rejected(state);
	}
	const releaseInputGate = handoff.presentation === "target-proven"
		&& handoff.inputGateInstalled
		&& intentAllowsInputGateRelease(event.intentState);
	const restoreSavePassThrough = handoff.presentation === "target-proven"
		&& handoff.saveGuardInstalled;
	const recoveryBindingIsCurrent =
		handoff.recoveryTargetBindingRequest !== null
		&& handoff.presentation === "target-proven"
		&& handoff.targetReadyTokenId !== null
		&& handoff.pendingHostLoadCandidate === null
		&& handoff.inputGateInstalled
		&& !handoff.saveGuardInstalled
		&& handoff.recoveryTargetBindingRequest.intentId === currentIntentId
		&& state.binding.kind === "bound"
		&& state.binding.path === handoff.targetPath
		&& state.displayedLineage.kind === "known"
		&& state.displayedLineage.file === handoff.targetFile
		&& state.displayedLineage.path === handoff.targetPath
		&& state.displayedLineage.fileId === state.binding.fileId
		&& state.displayedLineage.cm.state.doc === state.displayedLineage.document;
	const clearRecoveryHandoff = recoveryBindingIsCurrent
		&& releaseInputGate
		&& (
			event.intentState.kind === "needs-review"
			|| event.intentState.kind === "resolved"
			|| event.intentState.kind === "escaped"
			|| event.intentState.kind === "discarded"
		);
	const nextState: ManagedLeafSession = {
		...state,
		currentSwitchIntentSeq: clearRecoveryHandoff
			? null
			: state.currentSwitchIntentSeq,
		completedDetachEpoch: clearRecoveryHandoff
			? null
			: state.completedDetachEpoch,
		activeRecoveries: recoveryIndex < 0
			? state.activeRecoveries
			: transitionActiveRecovery(state, recoveryIndex, event.intentState),
		handoff: clearRecoveryHandoff ? null : {
			...handoff,
			intentState: event.intentState,
			inputGateInstalled: releaseInputGate ? false : handoff.inputGateInstalled,
			saveGuardInstalled: restoreSavePassThrough ? false : handoff.saveGuardInstalled,
			phase: phaseAfterIntentChange(handoff, event.intentState),
		},
	};
	const identity = effectIdentity(nextState);
	const effects: EditorHandoffEffect[] = [];
	if (releaseInputGate) effects.push({ type: "release-input-gate", ...identity });
	if (restoreSavePassThrough) effects.push({ type: "restore-save-pass-through", ...identity });
	return { state: nextState, effects, accepted: true };
}

function reduceSupersededIntentStateChanged(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "intent-state-changed" }>,
): HandoffReduction {
	const intentId = intentIdOf(event.intentState);
	if (intentId === null) return rejected(state);
	const recoveryIndex = activeRecoveryIndex(
		state,
		event.expectedGeneration,
		event.recoveryOperationEpoch,
		intentId,
	);
	const recovery = state.activeRecoveries[recoveryIndex];
	if (
		recovery === undefined
		|| !isLegalIntentStateChange(recovery.intentState, event.intentState)
	) {
		return rejected(state);
	}
	return {
		state: {
			...state,
			activeRecoveries: transitionActiveRecovery(
				state,
				recoveryIndex,
				event.intentState,
			),
		},
		effects: [],
		accepted: true,
	};
}

function reduceSupersededRecoveryOperationStarted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "recovery-operation-started" }>,
): HandoffReduction {
	const matchingRecoveryIndexes = state.activeRecoveries.flatMap((recovery, index) =>
		recovery.sessionId === state.sessionId
		&& recovery.handoffGeneration === event.expectedGeneration
			? [index]
			: []);
	if (matchingRecoveryIndexes.length !== 1) return rejected(state);
	const recoveryIndex = matchingRecoveryIndexes[0];
	if (recoveryIndex === undefined) return rejected(state);
	const recovery = state.activeRecoveries[recoveryIndex];
	if (recovery === undefined) return rejected(state);
	const intentState = intentStateAfterRecoveryOperation(
		recovery.intentState,
		event.operation,
	);
	if (intentState === null) return rejected(state);
	return {
		state: {
			...state,
			activeRecoveries: transitionActiveRecovery(
				state,
				recoveryIndex,
				intentState,
				recovery.recoveryOperationEpoch + 1,
			),
		},
		effects: [],
		accepted: true,
	};
}

function reduceCancelled(
	state: ManagedLeafSession,
): HandoffReduction {
	const handoff = state.handoff;
	if (handoff === null) return rejected(state);
	const detachStillRequired = state.binding.kind === "bound"
		|| handoff.bindingEpochAfterDetach === -1;
	const nextState: ManagedLeafSession = {
		...state,
		generation: state.generation + 1,
		pendingInputStartReservation: null,
		completedSamePathInput: null,
		completedDetachEpoch: detachStillRequired
			? null
			: state.completedDetachEpoch,
		binding: { kind: "unbound" },
		handoff: null,
	};
	const identity = effectIdentity(nextState);
	const effects: EditorHandoffEffect[] = [];
	if (detachStillRequired) {
		effects.push({ type: "detach-binding", ...identity });
	}
	if (handoff.inputGateInstalled) {
		effects.push({ type: "release-input-gate", ...identity });
	}
	if (handoff.saveGuardInstalled) {
		effects.push({ type: "restore-save-pass-through", ...identity });
	}
	return { state: nextState, effects, accepted: true };
}

export function reduceManagedLeafSession(
	state: ManagedLeafSession,
	event: EditorHandoffEvent,
): HandoffReduction {
	if (event.sessionId !== state.sessionId) return rejected(state);
	if (event.expectedGeneration !== state.generation) {
		if (event.type === "intent-state-changed") {
			return reduceSupersededIntentStateChanged(state, event);
		}
		if (event.type === "recovery-operation-started") {
			return reduceSupersededRecoveryOperationStarted(state, event);
		}
		return rejected(state);
	}

	switch (event.type) {
		case "target-selected":
		case "target-observed":
			return reduceTargetTransition(state, event);
		case "detach-completed":
			return reduceDetachCompleted(state, event);
		case "same-path-input-completed":
			return reduceSamePathInputCompleted(state, event);
		case "host-candidate-held":
			return reduceHostCandidateHeld(state, event);
		case "host-preclear-candidate-held":
			return reduceHostPreclearCandidateHeld(state, event);
		case "target-presented":
			return reduceTargetPresented(state, event);
		case "binding-completed":
			return reduceBindingCompleted(state, event);
		case "recovery-target-binding-requested":
			return reduceRecoveryTargetBindingRequested(state, event);
		case "intent-captured":
			return reduceIntentCaptured(state, event);
		case "recovery-operation-started":
			return reduceRecoveryOperationStarted(state, event);
		case "intent-state-changed":
			return reduceIntentStateChanged(state, event);
		case "cancelled":
			return reduceCancelled(state);
		default: {
			const exhaustiveEvent: never = event;
			return exhaustiveEvent;
		}
	}
}
