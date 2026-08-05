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
		presentation: "source" | "target-candidate";
		inputGateInstalled: boolean;
		saveGuardInstalled: boolean;
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
		samePathDispatch?: Readonly<{
			batchStartDocument: Text;
			nativeHistoryEpochBefore: number;
			nativeHistoryEpochAfter: number;
		}>;
	}>
	| (
		Readonly<{
			type: "same-path-input-rejected";
			sessionId: string;
			expectedGeneration: number;
			reservation: ManagedLeafInputStartReservation;
			cm: EditorView;
			startDocument: Text;
		}>
		& (
			| Readonly<{ reason: "cancelled" }>
			| Readonly<{
				reason: "input-result-ambiguous";
				finalDocument: Text;
				editorRevision: number;
				samePathDispatch: Readonly<{
					batchStartDocument: Text;
					nativeHistoryEpochBefore: number;
					nativeHistoryEpochAfter: number;
				}>;
			}>
		)
	)
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
		type: "target-locally-presented";
		sessionId: string;
		expectedGeneration: number;
		receipt: HostLoadCompletionReceipt;
		targetFileId: string | null;
	}>
	| Readonly<{
		type: "cancelled";
		sessionId: string;
		expectedGeneration: number;
		reason: "closed" | "deleted" | "excluded" | "renamed" | "teardown" | "unsupported-host";
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
	if (state.pendingInputStartReservation !== null) {
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
		&& observedHandoff.pendingHostLoadCandidate === null
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
		return { state: nextState, effects: [], accepted: true };
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
				? state.handoff.sourceAuthorityPath
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
			inputGateInstalled: true,
			saveGuardInstalled: true,
			pendingHostLoadCandidate: null,
		},
	};
	const identity = effectIdentity(nextState);
	const effects: EditorHandoffEffect[] = [
		{ type: "cancel-pending-save", ...identity },
		{ type: "block-save", ...identity },
		{ type: "install-input-gate", ...identity },
	];
	if (!detachAlreadyCompleted) {
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
		},
	};
	return { state: nextState, effects: [], accepted: true };
}

function isStableSamePathReservation(
	state: ManagedLeafSession,
	reservation: ManagedLeafInputStartReservation,
): state is ManagedLeafSession & Readonly<{
	displayedLineage: Extract<ManagedLeafSession["displayedLineage"], { kind: "known" }>;
}> {
	const displayed = state.displayedLineage;
	if (
		displayed.kind !== "known"
		|| state.handoff !== null
		|| reservation.handoffGenerationAtStart !== state.generation
		|| reservation.sourceFileAtStart !== displayed.file
		|| reservation.sourceFileIdAtStart !== displayed.fileId
		|| reservation.sourceDocumentAtStart === null
	) return false;
	return reservation.sourceAuthorityPathAtStart === displayed.path
		&& reservation.targetPathAtStart === null
		&& reservation.targetFileAtStart === null;
}

type SamePathDispatch = NonNullable<Extract<
	EditorHandoffEvent,
	{ type: "same-path-input-completed" }
>["samePathDispatch"]>;

function isExactSamePathDispatch(
	state: ManagedLeafSession,
	displayed: Extract<ManagedLeafSession["displayedLineage"], { kind: "known" }>,
	startDocument: Text,
	finalDocument: Text,
	editorRevision: number,
	dispatch: SamePathDispatch,
): boolean {
	const revisionDelta = finalDocument === dispatch.batchStartDocument ? 0 : 1;
	return dispatch.batchStartDocument === startDocument
		&& Number.isSafeInteger(dispatch.nativeHistoryEpochBefore)
		&& Number.isSafeInteger(dispatch.nativeHistoryEpochAfter)
		&& dispatch.nativeHistoryEpochBefore >= 0
		&& (
			state.nativeHistoryEpoch === dispatch.nativeHistoryEpochBefore
			|| state.nativeHistoryEpoch === dispatch.nativeHistoryEpochAfter
		)
		&& (
			revisionDelta === 0
				? dispatch.nativeHistoryEpochAfter === dispatch.nativeHistoryEpochBefore
				: dispatch.nativeHistoryEpochAfter > dispatch.nativeHistoryEpochBefore
		)
		&& Number.isSafeInteger(editorRevision)
		&& editorRevision >= 0
		&& (
			(
				displayed.document === finalDocument
				&& displayed.editorRevision === editorRevision
			)
			|| (
				displayed.document === dispatch.batchStartDocument
				&& editorRevision === displayed.editorRevision + revisionDelta
			)
		);
}

function reduceSamePathInputCompleted(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "same-path-input-completed" }>,
): HandoffReduction {
	const reservation = state.pendingInputStartReservation;
	if (
		reservation === null
		|| reservation !== event.reservation
		|| !isStableSamePathReservation(state, reservation)
		|| reservation.sourceDocumentAtStart !== event.startDocument
		|| event.cm !== state.displayedLineage.cm
		|| event.cm.state.doc !== event.finalDocument
	) return rejected(state);

	const displayed = state.displayedLineage;
	const dispatch = event.samePathDispatch ?? null;
	const ordinary = reservation.compositionEpoch === null;
	if (
		ordinary
			? dispatch === null || !isExactSamePathDispatch(
				state,
				displayed,
				event.startDocument,
				event.finalDocument,
				event.editorRevision,
				dispatch,
			)
			: event.finalDocument !== displayed.document
				|| event.editorRevision !== displayed.editorRevision
	) return rejected(state);

	const receipt: CompletedSamePathInputReceipt | null = ordinary ? null : {
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
			nativeHistoryEpoch: ordinary && dispatch !== null
				? dispatch.nativeHistoryEpochAfter
				: state.nativeHistoryEpoch,
			displayedLineage: ordinary ? {
				...displayed,
				document: event.finalDocument,
				editorRevision: event.editorRevision,
			} : displayed,
			pendingInputStartReservation: null,
			completedSamePathInput: receipt,
		},
		effects: [],
		accepted: true,
	};
}

function reduceSamePathInputRejected(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "same-path-input-rejected" }>,
): HandoffReduction {
	const reservation = state.pendingInputStartReservation;
	if (
		reservation === null
		|| reservation !== event.reservation
		|| reservation.compositionEpoch !== null
		|| !isStableSamePathReservation(state, reservation)
		|| reservation.sourceDocumentAtStart !== event.startDocument
		|| event.cm !== state.displayedLineage.cm
	) return rejected(state);

	const displayed = state.displayedLineage;
	if (event.reason === "cancelled") {
		if (
			event.cm.state.doc !== event.startDocument
			|| displayed.document !== event.startDocument
		) return rejected(state);
		return {
			state: {
				...state,
				pendingInputStartReservation: null,
				completedSamePathInput: null,
			},
			effects: [],
			accepted: true,
		};
	}

	if (
		event.cm.state.doc !== event.finalDocument
		|| !isExactSamePathDispatch(
			state,
			displayed,
			event.startDocument,
			event.finalDocument,
			event.editorRevision,
			event.samePathDispatch,
		)
	) return rejected(state);
	return {
		state: {
			...state,
			nativeHistoryEpoch: event.samePathDispatch.nativeHistoryEpochAfter,
			displayedLineage: {
				...displayed,
				document: event.finalDocument,
				editorRevision: event.editorRevision,
			},
			pendingInputStartReservation: null,
			completedSamePathInput: null,
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
			pendingHostLoadCandidate: candidate,
		},
	};
	return { state: nextState, effects: [], accepted: true };
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
			pendingHostLoadCandidate: candidate,
		},
	};
	return { state: nextState, effects: [], accepted: true };
}

function isCurrentHostLoadCompletionReceipt(
	state: ManagedLeafSession,
	handoff: NonNullable<ManagedLeafSession["handoff"]>,
	candidate: PendingHostLoadCandidate,
	host: HostLoadCompletionReceipt,
): boolean {
	return handoff.sourceUnloadReceiptId !== null
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
		&& host.effectFingerprint === candidate.effectFingerprint;
}

function reduceTargetLocallyPresented(
	state: ManagedLeafSession,
	event: Extract<EditorHandoffEvent, { type: "target-locally-presented" }>,
): HandoffReduction {
	const handoff = state.handoff;
	const candidate = handoff?.pendingHostLoadCandidate ?? null;
	const receipt = event.receipt;
	if (
		handoff === null
		|| handoff.presentation !== "target-candidate"
		|| candidate === null
		|| state.currentSwitchIntentSeq === null
		|| state.binding.kind !== "unbound"
		|| state.completedDetachEpoch !== handoff.bindingEpochAfterDetach
		|| !handoff.inputGateInstalled
		|| !handoff.saveGuardInstalled
		|| state.pendingInputStartReservation !== null
		|| state.completedSamePathInput !== null
		|| (event.targetFileId !== null && event.targetFileId.length === 0)
		|| !isCurrentHostLoadCompletionReceipt(state, handoff, candidate, receipt)
		|| !Number.isSafeInteger(receipt.nativeHistoryEpoch)
		|| !Number.isSafeInteger(receipt.targetSelectionEpoch)
		|| receipt.targetSelectionEpoch <= 0
		|| !Number.isSafeInteger(receipt.targetScrollEpoch)
		|| receipt.targetScrollEpoch <= 0
		|| candidate.targetDocument.toString() !== candidate.incomingContent
		|| candidate.cm.state.doc.toString() !== candidate.incomingContent
	) {
		return rejected(state);
	}

	const nextState: ManagedLeafSession = {
		...state,
		currentSwitchIntentSeq: null,
		nativeHistoryEpoch: receipt.nativeHistoryEpoch,
		completedDetachEpoch: null,
		completedSamePathInput: null,
		displayedLineage: {
			kind: "known",
			file: handoff.targetFile,
			path: handoff.targetPath,
			fileId: event.targetFileId,
			cm: candidate.cm,
			document: candidate.cm.state.doc,
			editorRevision: candidate.editorRevisionBefore + 1,
		},
		binding: { kind: "unbound" },
		handoff: null,
	};
	const identity = effectIdentity(nextState);
	return {
		state: nextState,
		effects: [
			{ type: "release-input-gate", ...identity },
			{ type: "restore-save-pass-through", ...identity },
		],
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
	if (event.expectedGeneration !== state.generation) return rejected(state);

	switch (event.type) {
		case "target-selected":
		case "target-observed":
			return reduceTargetTransition(state, event);
		case "detach-completed":
			return reduceDetachCompleted(state, event);
		case "same-path-input-completed":
			return reduceSamePathInputCompleted(state, event);
		case "same-path-input-rejected":
			return reduceSamePathInputRejected(state, event);
		case "host-candidate-held":
			return reduceHostCandidateHeld(state, event);
		case "host-preclear-candidate-held":
			return reduceHostPreclearCandidateHeld(state, event);
		case "target-locally-presented":
			return reduceTargetLocallyPresented(state, event);
		case "cancelled":
			return reduceCancelled(state);
		default: {
			const exhaustiveEvent: never = event;
			return exhaustiveEvent;
		}
	}
}
