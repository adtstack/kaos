import assert from "node:assert/strict";
import type { ChangeSet, EditorSelection, Text, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView, TFile, TextFileView } from "obsidian";
import type * as Y from "yjs";
import {
	createManagedLeafSession,
	reduceManagedLeafSession,
	reserveManagedLeafInputStart,
	type EditorHandoffEvent,
	type HandoffInputIntent,
	type HandoffIntentState,
	type ManagedLeafSession,
	type PendingHostLoadCandidate,
	type TargetPresentationReceipt,
} from "../src/sync/editorHandoffState";

function fakeFile(path: string): TFile {
	return { path } as TFile;
}

function fakeText(value: string): Text {
	return {
		length: value.length,
		toString: () => value,
	} as unknown as Text;
}

function createBoundSession(input?: Readonly<{
	sessionId?: string;
	file?: TFile;
	path?: string;
}>): ManagedLeafSession {
	const file = input?.file ?? fakeFile(input?.path ?? "A.md");
	const path = input?.path ?? file.path;
	const document = fakeText(`content:${path}`);
	const cm = {
		name: `cm:${path}`,
		state: { doc: document },
	} as unknown as EditorView;
	const ytext = { name: `ytext:${path}` } as unknown as Y.Text;
	return createManagedLeafSession({
		sessionId: input?.sessionId ?? "boot-a",
		leafId: "leaf-a",
		view: { file } as unknown as MarkdownView,
		nativeHistoryEpoch: 3,
		displayedLineage: {
			kind: "known",
			file,
			path,
			fileId: "file-a",
			cm,
			document,
			editorRevision: 7,
		},
		binding: {
			kind: "bound",
			path,
			fileId: "file-a",
			ytext,
		},
	});
}

function assertRejectedSame(
	state: ManagedLeafSession,
	event: EditorHandoffEvent,
	label: string,
): void {
	const reduction = reduceManagedLeafSession(state, event);
	assert.equal(reduction.accepted, false, `${label}: rejected`);
	assert.equal(reduction.state, state, `${label}: retains exact state object`);
	assert.deepEqual(reduction.effects, [], `${label}: emits no effects`);
}

function fakeSelection(name: string): EditorSelection {
	return { name } as unknown as EditorSelection;
}

function makeCandidate(
	state: ManagedLeafSession,
	overrides?: Partial<PendingHostLoadCandidate>,
): PendingHostLoadCandidate {
	assert.notEqual(state.handoff, null);
	const targetDocument = fakeText(`content:${state.handoff?.targetPath}`);
	const targetCm = {
		name: `cm:${state.handoff?.targetPath}:successor`,
		state: { doc: targetDocument },
	} as unknown as EditorView;
	return {
		hostLoadTokenId: `host-load:${state.handoff?.targetPath}`,
		hostLoadCompletedEpoch: null,
		sourceUnloadReceiptId: state.handoff?.sourceUnloadReceiptId ?? "",
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		targetPathAtDispatch: state.handoff?.targetPath ?? "",
		cm: targetCm,
		runtimeView: state.view as unknown as TextFileView,
		startDocument: state.displayedLineage.kind === "known"
			? state.displayedLineage.document
			: fakeText("unknown"),
		targetDocument,
		incomingContent: targetDocument.toString(),
		applicationKind: "transaction",
		heldTransaction: { newDoc: targetDocument } as unknown as Transaction,
		heldState: null,
		hostSetViewDataClear: true,
		editorRevisionBefore: state.displayedLineage.kind === "known"
			? state.displayedLineage.editorRevision
			: 4,
		nativeHistoryEpochBefore: state.nativeHistoryEpoch,
		proposedSelection: fakeSelection("target-selection"),
		proposedScrollAnchor: 23,
		effectFingerprint: "host-effect:b",
		runtimeViewDataBefore: state.displayedLineage.kind === "known"
			? state.displayedLineage.document.toString()
			: "",
		bindingEpoch: state.handoff?.bindingEpochAfterDetach ?? -1,
		...overrides,
	};
}

function makePresentationReceipt(
	state: ManagedLeafSession,
	candidate: PendingHostLoadCandidate,
	overrides?: Readonly<{
		host?: Partial<TargetPresentationReceipt["hostLoadCompletionReceipt"]>;
		token?: Partial<TargetPresentationReceipt["replacementTargetReadyToken"]>;
	}>,
): TargetPresentationReceipt {
	assert.notEqual(state.handoff, null);
	const host = {
		receiptId: `host-receipt:${state.handoff?.targetPath}`,
		hostLoadTokenId: candidate.hostLoadTokenId,
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		targetPath: state.handoff?.targetPath ?? "",
		nativeHistoryEpoch: state.nativeHistoryEpoch + 1,
		historyResetObserved: true as const,
		targetSelection: candidate.proposedSelection,
		targetSelectionEpoch: 11,
		targetScrollAnchor: candidate.proposedScrollAnchor,
		targetScrollEpoch: 12,
		effectFingerprint: candidate.effectFingerprint,
		...overrides?.host,
	};
	const token = {
		tokenId: `target-ready:${state.handoff?.targetPath}`,
		sessionId: state.sessionId,
		authorityFreshnessHandleId: "freshness:b",
		authorityFingerprint: "authority:b",
		controllerLifecycleGeneration: 1,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		targetPath: state.handoff?.targetPath ?? "",
		targetFile: state.handoff?.targetFile as TFile,
		targetAuthority: {
			kind: "existing" as const,
			fileId: "file-b",
			ytextIdentity: "ytext:b",
			ytextMutationEpoch: 5,
			bindPermitId: "bind:b",
		},
		hostLoadTokenId: candidate.hostLoadTokenId,
		hostLoadCompletedEpoch: 1,
		hostLoadReceiptId: host.receiptId,
		nativeHistoryEpoch: host.nativeHistoryEpoch,
		targetSelectionEpoch: host.targetSelectionEpoch,
		targetScrollEpoch: host.targetScrollEpoch,
		certifiedBaseContent: candidate.incomingContent,
		certifiedBaseHash: "hash:b",
		openEditorTicketId: "open-editor:b",
		...overrides?.token,
	};
	return {
		receiptId: `presentation-receipt:${state.handoff?.targetPath}`,
		presentationPlanId: `presentation-plan:${state.handoff?.targetPath}`,
		hostLoadCompletionReceipt: host,
		replacementTargetReadyToken: token,
	};
}

function makeIntent(
	state: ManagedLeafSession,
	overrides?: Partial<HandoffInputIntent>,
): HandoffInputIntent {
	assert.notEqual(state.handoff, null);
	const reservation = state.pendingInputStartReservation;
	return {
		intentId: `intent:${state.handoff?.targetPath}`,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		fromPath: state.handoff?.sourceAuthorityPath ?? null,
		fromFileId: reservation?.sourceFileIdAtStart
			?? (state.displayedLineage.kind === "known"
				? state.displayedLineage.fileId
				: null),
		targetPath: state.handoff?.targetPath ?? "",
		targetFile: state.handoff?.targetFile as TFile,
		bindingEpoch: state.handoff?.bindingEpochAfterDetach ?? -1,
		inputEpoch: reservation?.inputEpoch ?? -1,
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		inputStartSeq: reservation?.inputStartSeq ?? -1,
		inputStartedUnderSwitchSeq: reservation?.inputStartedUnderSwitchSeq ?? null,
		compositionEpoch: reservation?.compositionEpoch ?? null,
		selectionEpoch: 4,
		sequenceBegan: reservation?.inputStartedUnderSwitchSeq === state.currentSwitchIntentSeq
			? "after-target-selected"
			: "before-handoff",
		startDocument: reservation?.sourceDocumentAtStart
			?? (state.displayedLineage.kind === "known"
				? state.displayedLineage.document
				: fakeText("unknown")),
		startContentHash: "hash:start",
		changes: { name: "changes" } as unknown as ChangeSet,
		afterContent: "quarantined input",
		afterContentHash: "hash:after",
		selectionBefore: fakeSelection("before-input"),
		selectionAfter: fakeSelection("after-input"),
		originKind: "user",
		userEvent: "input",
		capturedAt: 101,
		...overrides,
	};
}

function reserveInput(
	state: ManagedLeafSession,
	inputEpoch = 2,
	compositionEpoch: number | null = null,
): ReturnType<typeof reserveManagedLeafInputStart> {
	const reservation = reserveManagedLeafInputStart(state, {
		sessionId: state.sessionId,
		expectedGeneration: state.generation,
		inputEpoch,
		compositionEpoch,
	});
	assert.equal(reservation.accepted, true);
	return reservation;
}

const managed = createBoundSession();

assert.equal(managed.sessionId, "boot-a");
assert.equal(managed.leafId, "leaf-a");
assert.equal(managed.generation, 0);
assert.equal(managed.eventOrderSeq, 0);
assert.equal(managed.currentSwitchIntentSeq, null);
assert.equal(managed.nativeHistoryEpoch, 3);
assert.equal(managed.completedDetachEpoch, null);
assert.equal(managed.displayedLineage.kind, "known");
assert.equal(managed.binding.kind, "bound");
assert.equal(managed.handoff, null);
assert.equal(managed.pendingInputStartReservation, null);

const reservedInitialInput = reserveManagedLeafInputStart(managed, {
	sessionId: managed.sessionId,
	expectedGeneration: 0,
	inputEpoch: 1,
	compositionEpoch: null,
});
assert.equal(reservedInitialInput.accepted, true);
assert.equal(reservedInitialInput.inputStartSeq, 1);
assert.equal(reservedInitialInput.inputStartedUnderSwitchSeq, null);
assert.equal(reservedInitialInput.state.eventOrderSeq, 1);
assert.deepEqual(reservedInitialInput.state.pendingInputStartReservation, {
	inputStartSeq: 1,
	inputStartedUnderSwitchSeq: null,
	inputEpoch: 1,
	compositionEpoch: null,
	handoffGenerationAtStart: 0,
	sourceAuthorityPathAtStart: "A.md",
	sourceFileAtStart: managed.displayedLineage.kind === "known"
		? managed.displayedLineage.file
		: null,
	sourceFileIdAtStart: "file-a",
	sourceDocumentAtStart: managed.displayedLineage.kind === "known"
		? managed.displayedLineage.document
		: null,
	targetPathAtStart: null,
	targetFileAtStart: null,
});
assert.equal(managed.eventOrderSeq, 0);

const staleInputReservation = reserveManagedLeafInputStart(managed, {
	sessionId: "different-boot",
	expectedGeneration: 0,
	inputEpoch: 1,
	compositionEpoch: null,
});
assert.equal(staleInputReservation.accepted, false);
assert.equal(staleInputReservation.state, managed);
assert.equal(staleInputReservation.inputStartSeq, null);

// A stable same-path IME completion consumes its exact input reservation and
// leaves a reducer-owned receipt.  The receipt is the only provenance that can
// later certify Obsidian's same-CodeMirror empty pre-clear before a host load.
const completedImeStart = reserveInput(managed, 11, 4);
const completedImeReservation = completedImeStart.state.pendingInputStartReservation;
assert.notEqual(completedImeReservation, null);
const completedImeDocument = fakeText("content:A.md + completed IME");
const completedImeCm = completedImeStart.state.displayedLineage.kind === "known"
	? completedImeStart.state.displayedLineage.cm
	: null;
assert.notEqual(completedImeCm, null);
(completedImeCm as unknown as { state: { doc: Text } }).state = {
	doc: completedImeDocument,
};
const completedImeState: ManagedLeafSession = {
	...completedImeStart.state,
	displayedLineage: completedImeStart.state.displayedLineage.kind === "known"
		? {
			...completedImeStart.state.displayedLineage,
			document: completedImeDocument,
			editorRevision: 8,
		}
		: completedImeStart.state.displayedLineage,
};
const completedIme = reduceManagedLeafSession(completedImeState, {
	type: "same-path-input-completed",
	sessionId: completedImeState.sessionId,
	expectedGeneration: completedImeState.generation,
	reservation: completedImeReservation!,
	cm: completedImeCm!,
	startDocument: completedImeReservation!.sourceDocumentAtStart!,
	finalDocument: completedImeDocument,
	editorRevision: 8,
});
assert.equal(completedIme.accepted, true);
assert.equal(completedIme.state.pendingInputStartReservation, null);
assert.equal(completedIme.state.completedSamePathInput?.reservation, completedImeReservation);
assert.equal(completedIme.state.completedSamePathInput?.finalDocument, completedImeDocument);
assert.equal(completedIme.state.completedSamePathInput?.editorRevision, 8);
assert.deepEqual(completedIme.effects, []);

for (const [label, event] of [
	["different reservation", {
		type: "same-path-input-completed",
		reservation: { ...completedImeReservation! },
	}],
	["different cm", {
		type: "same-path-input-completed",
		cm: { state: { doc: completedImeDocument } } as unknown as EditorView,
	}],
	["different final document", {
		type: "same-path-input-completed",
		finalDocument: fakeText(completedImeDocument.toString()),
	}],
	["stale editor revision", {
		type: "same-path-input-completed",
		editorRevision: 7,
	}],
] as const) {
	assertRejectedSame(completedImeState, {
		type: "same-path-input-completed",
		sessionId: completedImeState.sessionId,
		expectedGeneration: completedImeState.generation,
		reservation: completedImeReservation!,
		cm: completedImeCm!,
		startDocument: completedImeReservation!.sourceDocumentAtStart!,
		finalDocument: completedImeDocument,
		editorRevision: 8,
		...event,
	}, label);
}

// A composition that began on the proven source may finish after the user has
// selected the target, while the reducer still presents that exact source.
// Preserve the completion receipt so an ensuing empty host pre-clear can be
// certified after the forced source unload settles.
const spanningCompletionBase = createBoundSession({ sessionId: "boot-spanning-completion" });
const spanningCompletionStart = reserveInput(spanningCompletionBase, 21, 9);
const spanningCompletionReservation = spanningCompletionStart.state.pendingInputStartReservation;
assert.notEqual(spanningCompletionReservation, null);
const spanningCompletionTarget = fakeFile("B-spanning-completion.md");
const spanningCompletionSelected = reduceManagedLeafSession(spanningCompletionStart.state, {
	type: "target-selected",
	sessionId: spanningCompletionStart.state.sessionId,
	expectedGeneration: spanningCompletionStart.state.generation,
	targetFile: spanningCompletionTarget,
	switchIntentSeq: spanningCompletionStart.state.eventOrderSeq + 1,
	sourceUnloadReceiptId: "source-unload:spanning-completion",
});
assert.equal(spanningCompletionSelected.accepted, true);
assert.equal(spanningCompletionSelected.state.handoff?.presentation, "source");
const spanningCompletionDocument = fakeText("content:A.md + spanning completion");
const spanningCompletionCm = spanningCompletionSelected.state.displayedLineage.kind === "known"
	? spanningCompletionSelected.state.displayedLineage.cm
	: null;
assert.notEqual(spanningCompletionCm, null);
(spanningCompletionCm as unknown as { state: { doc: Text } }).state = {
	doc: spanningCompletionDocument,
};
const spanningCompletionSourceState: ManagedLeafSession = {
	...spanningCompletionSelected.state,
	displayedLineage: spanningCompletionSelected.state.displayedLineage.kind === "known"
		? {
			...spanningCompletionSelected.state.displayedLineage,
			document: spanningCompletionDocument,
			editorRevision: 8,
		}
		: spanningCompletionSelected.state.displayedLineage,
};
const spanningCompletion = reduceManagedLeafSession(spanningCompletionSourceState, {
	type: "same-path-input-completed",
	sessionId: spanningCompletionSourceState.sessionId,
	expectedGeneration: spanningCompletionSourceState.generation,
	reservation: spanningCompletionReservation!,
	cm: spanningCompletionCm!,
	startDocument: spanningCompletionReservation!.sourceDocumentAtStart!,
	finalDocument: spanningCompletionDocument,
	editorRevision: 8,
});
assert.equal(spanningCompletion.accepted, true);
assert.equal(
	spanningCompletion.state.completedSamePathInput?.handoffGenerationAtCompletion,
	spanningCompletionSourceState.generation,
);
assert.equal(
	spanningCompletion.state.completedSamePathInput?.reservation.handoffGenerationAtStart,
	spanningCompletionSourceState.generation - 1,
);
const spanningCompletionDetached = reduceManagedLeafSession(spanningCompletion.state, {
	type: "detach-completed",
	sessionId: spanningCompletion.state.sessionId,
	expectedGeneration: spanningCompletion.state.generation,
	bindingEpochAfterDetach: 10,
});
assert.equal(spanningCompletionDetached.accepted, true);
const spanningPreclearReducerState: ManagedLeafSession = {
	...spanningCompletionDetached.state,
	nativeHistoryEpoch: 0,
};
const spanningPreclearDocument = fakeText("");
(spanningCompletionCm as unknown as { state: { doc: Text } }).state = {
	doc: spanningPreclearDocument,
};
const spanningPreclearTargetDocument = fakeText("content:B-spanning-completion.md");
const spanningPreclearTargetState = {
	doc: spanningPreclearTargetDocument,
	selection: fakeSelection("spanning-preclear-target-selection"),
} as unknown as import("@codemirror/state").EditorState;
const spanningPreclearCandidate = {
	...makeCandidate(spanningPreclearReducerState),
	cm: spanningCompletionCm,
	startDocument: spanningPreclearDocument,
	targetDocument: spanningPreclearTargetDocument,
	incomingContent: spanningPreclearTargetDocument.toString(),
	applicationKind: "state" as const,
	heldTransaction: null,
	heldState: spanningPreclearTargetState,
	editorRevisionBefore: 8,
	proposedSelection: spanningPreclearTargetState.selection,
	proposedScrollAnchor: null,
	nativeHistoryEpochBefore: 3,
} as PendingHostLoadCandidate;
const spanningCompletionSourceFile = spanningPreclearReducerState.displayedLineage.kind === "known"
	? spanningPreclearReducerState.displayedLineage.file
	: null;
assert.notEqual(spanningCompletionSourceFile, null);
const spanningCertifiedPreclear = reduceManagedLeafSession(spanningPreclearReducerState, {
	type: "host-preclear-candidate-held",
	sessionId: spanningPreclearReducerState.sessionId,
	expectedGeneration: spanningPreclearReducerState.generation,
	candidate: spanningPreclearCandidate,
	completion: spanningPreclearReducerState.completedSamePathInput!,
	observedNativeHistoryEpoch: 3,
	sourceUnload: {
		receiptId: "source-unload:spanning-completion",
		file: spanningCompletionSourceFile!,
		path: "A.md",
		state: "settled",
		forcedSaveObserved: true,
	},
} as EditorHandoffEvent);
assert.equal(spanningCertifiedPreclear.accepted, true);
assert.equal(spanningCertifiedPreclear.state.nativeHistoryEpoch, 3);

const supersedingInput = reserveInput(completedIme.state, 12, null);
assert.equal(supersedingInput.state.completedSamePathInput, null);

const completedImeTargetFile = fakeFile("B-after-ime.md");
const selectedAfterCompletedIme = reduceManagedLeafSession(completedIme.state, {
	type: "target-selected",
	sessionId: completedIme.state.sessionId,
	expectedGeneration: completedIme.state.generation,
	targetFile: completedImeTargetFile,
	switchIntentSeq: completedIme.state.eventOrderSeq + 1,
	sourceUnloadReceiptId: "source-unload:completed-ime",
});
assert.equal(selectedAfterCompletedIme.accepted, true);
assert.equal(
	selectedAfterCompletedIme.state.completedSamePathInput,
	completedIme.state.completedSamePathInput,
);
const detachedAfterCompletedIme = reduceManagedLeafSession(selectedAfterCompletedIme.state, {
	type: "detach-completed",
	sessionId: selectedAfterCompletedIme.state.sessionId,
	expectedGeneration: selectedAfterCompletedIme.state.generation,
	bindingEpochAfterDetach: 9,
});
assert.equal(detachedAfterCompletedIme.accepted, true);

const preclearDocument = fakeText("");
(completedImeCm as unknown as { state: { doc: Text } }).state = { doc: preclearDocument };
const preclearTargetDocument = fakeText("content:B-after-ime.md");
const preclearTargetState = {
	doc: preclearTargetDocument,
	selection: fakeSelection("preclear-target-selection"),
} as unknown as import("@codemirror/state").EditorState;
const preclearCandidate = {
	...makeCandidate(detachedAfterCompletedIme.state),
	cm: completedImeCm,
	startDocument: preclearDocument,
	targetDocument: preclearTargetDocument,
	incomingContent: preclearTargetDocument.toString(),
	applicationKind: "state" as const,
	heldTransaction: null,
	heldState: preclearTargetState,
	editorRevisionBefore: 8,
	proposedSelection: preclearTargetState.selection,
	proposedScrollAnchor: null,
	runtimeViewDataBefore: "stale pre-IME host cache",
} as PendingHostLoadCandidate;
const completedImeSourceFile = completedIme.state.displayedLineage.kind === "known"
	? completedIme.state.displayedLineage.file
	: null;
assert.notEqual(completedImeSourceFile, null);
const certifiedPreclear = reduceManagedLeafSession(detachedAfterCompletedIme.state, {
	type: "host-preclear-candidate-held",
	sessionId: detachedAfterCompletedIme.state.sessionId,
	expectedGeneration: detachedAfterCompletedIme.state.generation,
	candidate: preclearCandidate,
	completion: detachedAfterCompletedIme.state.completedSamePathInput!,
	observedNativeHistoryEpoch: preclearCandidate.nativeHistoryEpochBefore,
	sourceUnload: {
		receiptId: "source-unload:completed-ime",
		file: completedImeSourceFile!,
		path: "A.md",
		state: "settled",
		forcedSaveObserved: true,
	},
});
assert.equal(certifiedPreclear.accepted, true);
assert.equal(certifiedPreclear.state.completedSamePathInput, null);
assert.equal(certifiedPreclear.state.handoff?.pendingHostLoadCandidate, preclearCandidate);
assert.equal(certifiedPreclear.state.handoff?.presentation, "target-candidate");
assert.deepEqual(
	certifiedPreclear.effects.map((effect) => effect.type),
	["request-target-presentation"],
);

for (const [label, candidate, proof] of [
	["pre-clear must be empty", {
		...preclearCandidate,
		startDocument: completedImeDocument,
	}, {}],
	["pre-clear must retain the same CodeMirror", {
		...preclearCandidate,
		cm: { state: { doc: preclearDocument } } as unknown as EditorView,
	}, {}],
	["pre-clear completion receipt is one-shot exact identity", preclearCandidate, {
		completion: { ...detachedAfterCompletedIme.state.completedSamePathInput! },
	}],
	["pre-clear source unload must be settled", preclearCandidate, {
		sourceUnload: { state: "saving" },
	}],
	["pre-clear source unload must observe forced save", preclearCandidate, {
		sourceUnload: { forcedSaveObserved: false },
	}],
	["pre-clear source receipt must match handoff", preclearCandidate, {
		sourceUnload: { receiptId: "source-unload:stale" },
	}],
] as const) {
	const sourceUnload = {
		receiptId: "source-unload:completed-ime",
		file: completedImeSourceFile!,
		path: "A.md",
		state: "settled",
		forcedSaveObserved: true,
		...proof.sourceUnload,
	};
	assertRejectedSame(detachedAfterCompletedIme.state, {
		type: "host-preclear-candidate-held",
		sessionId: detachedAfterCompletedIme.state.sessionId,
		expectedGeneration: detachedAfterCompletedIme.state.generation,
		candidate: candidate as PendingHostLoadCandidate,
		completion: proof.completion
			?? detachedAfterCompletedIme.state.completedSamePathInput!,
		observedNativeHistoryEpoch: (candidate as PendingHostLoadCandidate).nativeHistoryEpochBefore,
		sourceUnload,
	} as EditorHandoffEvent, label);
}

assertRejectedSame(detachedAfterCompletedIme.state, {
	type: "host-preclear-candidate-held",
	sessionId: detachedAfterCompletedIme.state.sessionId,
	expectedGeneration: detachedAfterCompletedIme.state.generation,
	candidate: preclearCandidate,
	completion: detachedAfterCompletedIme.state.completedSamePathInput!,
	observedNativeHistoryEpoch: preclearCandidate.nativeHistoryEpochBefore - 1,
	sourceUnload: {
		receiptId: "source-unload:completed-ime",
		file: completedImeSourceFile!,
		path: "A.md",
		state: "settled",
		forcedSaveObserved: true,
	},
}, "pre-clear native-history proof must equal the exact guard candidate epoch");

assertRejectedSame(managed, {
	type: "target-selected",
	sessionId: "different-boot",
	expectedGeneration: 0,
	targetFile: fakeFile("B.md"),
	switchIntentSeq: 1,
	sourceUnloadReceiptId: "source-unload:test",
}, "boot-session ABA");

const fileB = fakeFile("B.md");

const observedB = reduceManagedLeafSession(managed, {
	type: "target-observed",
	sessionId: managed.sessionId,
	expectedGeneration: managed.generation,
	targetFile: fileB,
});
assert.equal(observedB.accepted, true);
assert.equal(observedB.state.currentSwitchIntentSeq, null);
assert.equal(observedB.state.handoff?.sourceUnloadReceiptId, null);
const detachedObservedB = reduceManagedLeafSession(observedB.state, {
	type: "detach-completed",
	sessionId: observedB.state.sessionId,
	expectedGeneration: observedB.state.generation,
	bindingEpochAfterDetach: 4,
});
assert.equal(detachedObservedB.accepted, true);
const observedGapInput = reserveInput(detachedObservedB.state, 41, 17);
const observedGapReservation = observedGapInput.state.pendingInputStartReservation;
assert.notEqual(observedGapReservation, null);
const promotedB = reduceManagedLeafSession(observedGapInput.state, {
	type: "target-selected",
	sessionId: observedGapInput.state.sessionId,
	expectedGeneration: observedGapInput.state.generation,
	targetFile: fileB,
	switchIntentSeq: observedGapInput.state.eventOrderSeq + 1,
	sourceUnloadReceiptId: "source-unload:observed-then-selected",
});
assert.equal(promotedB.accepted, true, "exact host selection promotes the observed target");
assert.equal(promotedB.state.generation, observedGapInput.state.generation + 1);
assert.equal(promotedB.state.eventOrderSeq, 2);
assert.equal(promotedB.state.currentSwitchIntentSeq, 2);
assert.equal(
	promotedB.state.pendingInputStartReservation,
	observedGapReservation,
	"promotion preserves input that started during the observed-only gap",
);
assert.equal(
	promotedB.state.handoff?.sourceUnloadReceiptId,
	"source-unload:observed-then-selected",
);
assert.equal(promotedB.state.handoff?.targetFile, fileB);
assert.equal(promotedB.state.handoff?.bindingEpochAfterDetach, 4);
assert.deepEqual(
	promotedB.effects.map((effect) => effect.type),
	["request-target-presentation"],
);
assert.equal(promotedB.effects[0]?.expectedGeneration, promotedB.state.generation);

const sourceUnloadReceiptId = "source-unload:boot-a:1";
const started = reduceManagedLeafSession(managed, {
	type: "target-selected",
	sessionId: managed.sessionId,
	expectedGeneration: 0,
	targetFile: fileB,
	switchIntentSeq: 1,
	sourceUnloadReceiptId,
});
assert.equal(started.accepted, true);
assert.equal(started.state.generation, 1);
assert.equal(started.state.eventOrderSeq, 1);
assert.equal(started.state.currentSwitchIntentSeq, 1);
assert.equal(started.state.displayedLineage, managed.displayedLineage);
assert.equal(started.state.binding, managed.binding);
assert.equal(started.state.handoff?.sourceAuthorityPath, "A.md");
assert.equal(started.state.handoff?.sourceUnloadReceiptId, sourceUnloadReceiptId);
assert.equal(started.state.handoff?.targetPath, "B.md");
assert.equal(started.state.handoff?.targetFile, fileB);
assert.equal(started.state.handoff?.bindingEpochAfterDetach, -1);
assert.equal(started.state.completedDetachEpoch, null);
assert.equal(started.state.handoff?.presentation, "source");
assert.equal(started.state.handoff?.targetReadyTokenId, null);
assert.equal(started.state.handoff?.inputGateInstalled, true);
assert.equal(started.state.handoff?.saveGuardInstalled, true);
assert.equal(started.state.handoff?.recoveryOperationEpoch, 0);
assert.equal(started.state.handoff?.intentState.kind, "none");
assert.equal(started.state.handoff?.phase, "awaiting-host-load");
assert.equal(started.state.handoff?.pendingHostLoadCandidate, null);
assert.deepEqual(
	started.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"capture-authority-before-detach",
		"detach-binding",
	],
);
for (const effect of started.effects) {
	assert.equal(effect.sessionId, "boot-a");
	assert.equal(effect.expectedGeneration, 1);
}

assertRejectedSame(started.state, {
	type: "target-selected",
	sessionId: started.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileB,
	switchIntentSeq: 1,
	sourceUnloadReceiptId: "source-unload:test",
}, "duplicate switch callback");

const returnedToSource = reduceManagedLeafSession(started.state, {
	type: "target-selected",
	sessionId: started.state.sessionId,
	expectedGeneration: 1,
	targetFile: managed.displayedLineage.kind === "known"
		? managed.displayedLineage.file
		: fakeFile("A.md"),
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(returnedToSource.accepted, true);
assert.equal(returnedToSource.state.generation, 2);
assert.equal(returnedToSource.state.handoff, null);
assert.equal(returnedToSource.state.completedDetachEpoch, null);
assert.equal(returnedToSource.state.displayedLineage, managed.displayedLineage);
assert.equal(returnedToSource.state.binding, managed.binding);
assert.deepEqual(
	returnedToSource.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

const renamedFile = fakeFile("A.md");
const beforeRename = createBoundSession({ file: renamedFile });
(renamedFile as unknown as { path: string }).path = "Renamed-A.md";
const renamed = reduceManagedLeafSession(beforeRename, {
	type: "target-selected",
	sessionId: beforeRename.sessionId,
	expectedGeneration: 0,
	targetFile: renamedFile,
	switchIntentSeq: 1,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(renamed.accepted, true);
assert.equal(renamed.state.generation, 1);
assert.equal(renamed.state.currentSwitchIntentSeq, 1);
assert.equal(renamed.state.handoff, null);
assert.deepEqual(renamed.effects, []);
assert.equal(renamed.state.displayedLineage.kind, "known");
if (renamed.state.displayedLineage.kind === "known") {
	assert.equal(renamed.state.displayedLineage.file, renamedFile);
	assert.equal(renamed.state.displayedLineage.path, "Renamed-A.md");
	assert.equal(renamed.state.displayedLineage.fileId, "file-a");
	assert.equal(renamed.state.displayedLineage.cm, beforeRename.displayedLineage.kind === "known"
		? beforeRename.displayedLineage.cm
		: null);
}
assert.equal(renamed.state.binding.kind, "bound");
if (renamed.state.binding.kind === "bound") {
	assert.equal(renamed.state.binding.path, "Renamed-A.md");
	assert.equal(renamed.state.binding.fileId, "file-a");
	assert.equal(renamed.state.binding.ytext, beforeRename.binding.kind === "bound"
		? beforeRename.binding.ytext
		: null);
}

const unboundRenameFile = fakeFile("Unbound-A.md");
const unboundRenameBase = createManagedLeafSession({
	sessionId: "boot-unbound",
	leafId: "leaf-unbound",
	view: { file: unboundRenameFile } as unknown as MarkdownView,
	displayedLineage: {
		kind: "known",
		file: unboundRenameFile,
		path: "Unbound-A.md",
		fileId: "file-unbound",
		cm: { name: "cm-unbound" } as unknown as EditorView,
		document: fakeText("unbound"),
		editorRevision: 1,
	},
	binding: { kind: "unbound" },
});
(unboundRenameFile as unknown as { path: string }).path = "Unbound-Renamed.md";
const unprovenRename = reduceManagedLeafSession(unboundRenameBase, {
	type: "target-selected",
	sessionId: unboundRenameBase.sessionId,
	expectedGeneration: 0,
	targetFile: unboundRenameFile,
	switchIntentSeq: 1,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(unprovenRename.accepted, true);
assert.notEqual(unprovenRename.state.handoff, null);
assert.deepEqual(
	unprovenRename.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"capture-authority-before-detach",
		"detach-binding",
	],
);

const detached = reduceManagedLeafSession(started.state, {
	type: "detach-completed",
	sessionId: started.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 8,
});
assert.equal(detached.accepted, true);
assert.equal(detached.state.generation, 1);
assert.equal(detached.state.eventOrderSeq, 1);
assert.deepEqual(detached.state.binding, { kind: "unbound" });
assert.equal(detached.state.displayedLineage, managed.displayedLineage);
assert.equal(detached.state.handoff?.sourceAuthorityPath, "A.md");
assert.equal(detached.state.handoff?.bindingEpochAfterDetach, 8);
assert.equal(detached.state.completedDetachEpoch, 8);
assert.equal(detached.state.handoff?.phase, "awaiting-host-load");
assert.deepEqual(detached.effects.map((effect) => effect.type), ["request-target-presentation"]);
assert.equal(detached.effects[0]?.sessionId, "boot-a");
assert.equal(detached.effects[0]?.expectedGeneration, 1);

const returnedAfterDetach = reduceManagedLeafSession(detached.state, {
	type: "target-selected",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	targetFile: managed.displayedLineage.kind === "known"
		? managed.displayedLineage.file
		: fakeFile("A.md"),
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(returnedAfterDetach.accepted, true);
assert.equal(returnedAfterDetach.state.generation, 2);
assert.equal(returnedAfterDetach.state.displayedLineage, managed.displayedLineage);
assert.deepEqual(returnedAfterDetach.state.binding, { kind: "unbound" });
assert.equal(returnedAfterDetach.state.handoff, null);
assert.equal(returnedAfterDetach.state.completedDetachEpoch, 8);
assert.deepEqual(
	returnedAfterDetach.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);
assertRejectedSame(returnedAfterDetach.state, {
	type: "target-selected",
	sessionId: returnedAfterDetach.state.sessionId,
	expectedGeneration: 1,
	targetFile: fakeFile("C.md"),
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
}, "return-to-source detach lineage keeps generation CAS");
const fileCAfterReturn = fakeFile("C.md");
const selectedCAfterReturn = reduceManagedLeafSession(returnedAfterDetach.state, {
	type: "target-selected",
	sessionId: returnedAfterDetach.state.sessionId,
	expectedGeneration: 2,
	targetFile: fileCAfterReturn,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(selectedCAfterReturn.accepted, true);
assert.equal(selectedCAfterReturn.state.completedDetachEpoch, 8);
assert.equal(selectedCAfterReturn.state.handoff?.bindingEpochAfterDetach, 8);
assert.deepEqual(
	selectedCAfterReturn.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"request-target-presentation",
	],
);
assertRejectedSame(selectedCAfterReturn.state, {
	type: "detach-completed",
	sessionId: selectedCAfterReturn.state.sessionId,
	expectedGeneration: 3,
	bindingEpochAfterDetach: 8,
}, "return-to-source detach is reused exactly once");

const reboundAfterReturn: ManagedLeafSession = {
	...returnedAfterDetach.state,
	binding: managed.binding,
};
const selectedCAfterRebind = reduceManagedLeafSession(reboundAfterReturn, {
	type: "target-selected",
	sessionId: reboundAfterReturn.sessionId,
	expectedGeneration: 2,
	targetFile: fakeFile("C-after-rebind.md"),
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(selectedCAfterRebind.accepted, true);
assert.equal(selectedCAfterRebind.state.completedDetachEpoch, null);
assert.equal(selectedCAfterRebind.state.handoff?.bindingEpochAfterDetach, -1);
assert.deepEqual(
	selectedCAfterRebind.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"capture-authority-before-detach",
		"detach-binding",
	],
);
assertRejectedSame(returnedAfterDetach.state, {
	type: "detach-completed",
	sessionId: returnedAfterDetach.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 9,
}, "returned source rejects stale B detach");

assertRejectedSame(detached.state, {
	type: "detach-completed",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 8,
}, "duplicate detach callback");

const fileC = fakeFile("C.md");
const superseded = reduceManagedLeafSession(started.state, {
	type: "target-selected",
	sessionId: started.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(superseded.accepted, true);
assert.equal(superseded.state.generation, 2);
assert.equal(superseded.state.eventOrderSeq, 2);
assert.equal(superseded.state.currentSwitchIntentSeq, 2);
assert.equal(superseded.state.displayedLineage, managed.displayedLineage);
assert.equal(superseded.state.binding, managed.binding);
assert.equal(superseded.state.handoff?.sourceAuthorityPath, "A.md");
assert.equal(superseded.state.handoff?.targetPath, "C.md");
assert.equal(superseded.state.handoff?.targetFile, fileC);
assert.equal(superseded.state.handoff?.pendingHostLoadCandidate, null);

const explicitUnknownSource: ManagedLeafSession = {
	...started.state,
	handoff: started.state.handoff === null
		? null
		: { ...started.state.handoff, sourceAuthorityPath: null },
};
const unknownSourceSuperseded = reduceManagedLeafSession(explicitUnknownSource, {
	type: "target-selected",
	sessionId: explicitUnknownSource.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(unknownSourceSuperseded.accepted, true);
assert.equal(unknownSourceSuperseded.state.handoff?.sourceAuthorityPath, null);

assertRejectedSame(superseded.state, {
	type: "detach-completed",
	sessionId: managed.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 8,
}, "literal stale B detach after C supersession");

const supersededAfterDetach = reduceManagedLeafSession(detached.state, {
	type: "target-selected",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(supersededAfterDetach.accepted, true);
assert.deepEqual(supersededAfterDetach.state.binding, { kind: "unbound" });
assert.equal(supersededAfterDetach.state.displayedLineage, managed.displayedLineage);
assert.equal(supersededAfterDetach.state.handoff?.sourceAuthorityPath, "A.md");
assert.equal(supersededAfterDetach.state.handoff?.bindingEpochAfterDetach, 8);
assert.deepEqual(
	supersededAfterDetach.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"request-target-presentation",
	],
);
assertRejectedSame(supersededAfterDetach.state, {
	type: "detach-completed",
	sessionId: supersededAfterDetach.state.sessionId,
	expectedGeneration: 2,
	bindingEpochAfterDetach: 8,
}, "supersession carries completed detach exactly once");

const inputDuringUnprovenB = reserveInput(started.state, 12);
assert.equal(
	inputDuringUnprovenB.state.pendingInputStartReservation?.handoffGenerationAtStart,
	1,
);
assert.equal(
	inputDuringUnprovenB.state.pendingInputStartReservation?.sourceAuthorityPathAtStart,
	"A.md",
);
assert.equal(inputDuringUnprovenB.state.pendingInputStartReservation?.targetPathAtStart, "B.md");
assert.equal(inputDuringUnprovenB.state.pendingInputStartReservation?.targetFileAtStart, fileB);
const supersededAfterUnprovenInput = reduceManagedLeafSession(inputDuringUnprovenB.state, {
	type: "target-selected",
	sessionId: inputDuringUnprovenB.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(supersededAfterUnprovenInput.accepted, false);
assert.equal(supersededAfterUnprovenInput.state, inputDuringUnprovenB.state);
assert.deepEqual(supersededAfterUnprovenInput.effects, []);
assert.equal(supersededAfterUnprovenInput.state.generation, 1);
assert.equal(supersededAfterUnprovenInput.state.eventOrderSeq, 2);
const detachedAfterUnprovenInput = reduceManagedLeafSession(
	inputDuringUnprovenB.state,
	{
		type: "detach-completed",
		sessionId: inputDuringUnprovenB.state.sessionId,
		expectedGeneration: 1,
		bindingEpochAfterDetach: 10,
	},
);
assert.equal(detachedAfterUnprovenInput.accepted, true);
const exactUnprovenChanges = { name: "exact-unproven-a-to-b" } as unknown as ChangeSet;
const exactUnprovenIntent = makeIntent(detachedAfterUnprovenInput.state, {
	intentId: "intent:must-remain-a-to-b",
	changes: exactUnprovenChanges,
	afterContent: "exact A to B quarantined successor",
	afterContentHash: "hash:exact-a-to-b",
});
const capturedBeforeCSupersession = reduceManagedLeafSession(detachedAfterUnprovenInput.state, {
	type: "intent-captured",
	sessionId: detachedAfterUnprovenInput.state.sessionId,
	expectedGeneration: 1,
	intent: exactUnprovenIntent,
});
assert.equal(capturedBeforeCSupersession.accepted, true);
assert.equal(capturedBeforeCSupersession.effects[0]?.type, "persist-intent");
if (capturedBeforeCSupersession.effects[0]?.type === "persist-intent") {
	assert.equal(capturedBeforeCSupersession.effects[0].intent, exactUnprovenIntent);
	assert.equal(capturedBeforeCSupersession.effects[0].intent.changes, exactUnprovenChanges);
	assert.equal(
		capturedBeforeCSupersession.effects[0].intent.afterContent,
		"exact A to B quarantined successor",
	);
}
const retriedCSupersession = reduceManagedLeafSession(capturedBeforeCSupersession.state, {
	type: "target-selected",
	sessionId: capturedBeforeCSupersession.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(retriedCSupersession.accepted, true);
assert.equal(retriedCSupersession.state.generation, 2);
assert.equal(retriedCSupersession.state.eventOrderSeq, 3);
assert.equal(retriedCSupersession.state.pendingInputStartReservation, null);
assert.equal(retriedCSupersession.state.handoff?.targetPath, "C.md");
assert.deepEqual(retriedCSupersession.state.handoff?.intentState, { kind: "none" });
assert.equal(retriedCSupersession.state.activeRecoveries[0]?.intent, exactUnprovenIntent);
assert.equal(retriedCSupersession.state.activeRecoveries[0]?.intent.targetPath, "B.md");
assert.equal(retriedCSupersession.state.activeRecoveries[0]?.intent.targetFile, fileB);
const currentCAfterRetry = retriedCSupersession.state.handoff;
const storedAfterCSupersession = reduceManagedLeafSession(retriedCSupersession.state, {
	type: "intent-state-changed",
	sessionId: retriedCSupersession.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "stored",
		intentId: exactUnprovenIntent.intentId,
		recordId: "record:exact-a-to-b",
	},
});
assert.equal(storedAfterCSupersession.accepted, true);
assert.equal(storedAfterCSupersession.state.handoff, currentCAfterRetry);
const reviewAfterCSupersession = reduceManagedLeafSession(storedAfterCSupersession.state, {
	type: "intent-state-changed",
	sessionId: storedAfterCSupersession.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "needs-review",
		intentId: exactUnprovenIntent.intentId,
		recordId: "record:exact-a-to-b",
	},
});
assert.equal(reviewAfterCSupersession.accepted, true);
assert.equal(reviewAfterCSupersession.state.handoff, currentCAfterRetry);
assert.deepEqual(reviewAfterCSupersession.state.activeRecoveries, []);
const candidateC = makeCandidate(reviewAfterCSupersession.state);
const heldC = reduceManagedLeafSession(reviewAfterCSupersession.state, {
	type: "host-candidate-held",
	sessionId: reviewAfterCSupersession.state.sessionId,
	expectedGeneration: 2,
	candidate: candidateC,
});
assert.equal(heldC.accepted, true);
const presentedC = reduceManagedLeafSession(heldC.state, {
	type: "target-presented",
	sessionId: heldC.state.sessionId,
	expectedGeneration: 2,
	receipt: makePresentationReceipt(heldC.state, candidateC),
});
assert.equal(presentedC.accepted, true);
assert.equal(presentedC.state.handoff?.inputGateInstalled, false);
assert.deepEqual(
	presentedC.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

assertRejectedSame(started.state, {
	type: "detach-completed",
	sessionId: started.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: -1,
}, "invalid detach epoch");

const candidateB = makeCandidate(detached.state);
const held = reduceManagedLeafSession(detached.state, {
	type: "host-candidate-held",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	candidate: candidateB,
});
assert.equal(held.accepted, true);
assert.equal(held.state.eventOrderSeq, 1);
assert.equal(held.state.handoff?.presentation, "target-candidate");
assert.equal(held.state.handoff?.phase, "awaiting-target-ready");
assert.equal(held.state.handoff?.pendingHostLoadCandidate, candidateB);
assert.deepEqual(held.effects.map((effect) => effect.type), ["request-target-presentation"]);

const returnedWithCandidate = reduceManagedLeafSession(held.state, {
	type: "target-selected",
	sessionId: held.state.sessionId,
	expectedGeneration: 1,
	targetFile: managed.displayedLineage.kind === "known"
		? managed.displayedLineage.file
		: fakeFile("A.md"),
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(returnedWithCandidate.accepted, true);
assert.equal(returnedWithCandidate.state.displayedLineage, managed.displayedLineage);
assert.deepEqual(returnedWithCandidate.state.binding, { kind: "unbound" });
assert.equal(returnedWithCandidate.state.handoff, null);
assert.deepEqual(
	returnedWithCandidate.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);
assertRejectedSame(returnedWithCandidate.state, {
	type: "host-candidate-held",
	sessionId: returnedWithCandidate.state.sessionId,
	expectedGeneration: 1,
	candidate: candidateB,
}, "returned source rejects stale B candidate");

assertRejectedSame(held.state, {
	type: "host-candidate-held",
	sessionId: held.state.sessionId,
	expectedGeneration: 1,
	candidate: candidateB,
}, "duplicate host candidate");

for (const [label, candidate] of [
	["candidate session", makeCandidate(detached.state, { sessionId: "other-boot" })],
	["candidate leaf", makeCandidate(detached.state, { leafId: "other-leaf" })],
	["candidate generation", makeCandidate(detached.state, { handoffGeneration: 2 })],
	["candidate switch", makeCandidate(detached.state, { switchIntentSeq: 2 })],
	["candidate source unload", makeCandidate(detached.state, {
		sourceUnloadReceiptId: "source-unload:wrong",
	})],
	["candidate path", makeCandidate(detached.state, { targetPathAtDispatch: "C.md" })],
	["candidate binding epoch", makeCandidate(detached.state, { bindingEpoch: 9 })],
	["candidate editor revision", makeCandidate(detached.state, { editorRevisionBefore: 8 })],
	["already completed candidate", makeCandidate(detached.state, { hostLoadCompletedEpoch: 1 })],
] as const) {
	assertRejectedSame(detached.state, {
		type: "host-candidate-held",
		sessionId: detached.state.sessionId,
		expectedGeneration: 1,
		candidate,
	}, label);
}

assertRejectedSame(superseded.state, {
	type: "host-candidate-held",
	sessionId: superseded.state.sessionId,
	expectedGeneration: 2,
	candidate: candidateB,
}, "current C rejects stale B candidate payload");

const validPresentation = makePresentationReceipt(held.state, candidateB);
const reservedSpanningPresentation = reserveInput(held.state, 14, 5);
assert.equal(reservedSpanningPresentation.state.displayedLineage.kind, "known");
assert.equal(
	reservedSpanningPresentation.state.pendingInputStartReservation?.sourceFileAtStart,
	managed.displayedLineage.kind === "known" ? managed.displayedLineage.file : null,
);
assert.equal(
	reservedSpanningPresentation.state.pendingInputStartReservation?.sourceFileIdAtStart,
	"file-a",
);
assert.equal(
	reservedSpanningPresentation.state.pendingInputStartReservation?.sourceDocumentAtStart,
	managed.displayedLineage.kind === "known" ? managed.displayedLineage.document : null,
);
const spanningPresentationIntent = makeIntent(reservedSpanningPresentation.state, {
	intentId: "intent:spanning-presentation",
	originKind: "ime",
});
const presentedBeforeSpanningCapture = reduceManagedLeafSession(
	reservedSpanningPresentation.state,
	{
		type: "target-presented",
		sessionId: reservedSpanningPresentation.state.sessionId,
		expectedGeneration: 1,
		receipt: validPresentation,
	},
);
assert.equal(presentedBeforeSpanningCapture.accepted, true);
assert.equal(presentedBeforeSpanningCapture.state.handoff?.inputGateInstalled, true);
assert.equal(
	presentedBeforeSpanningCapture.state.pendingInputStartReservation,
	reservedSpanningPresentation.state.pendingInputStartReservation,
);
assert.deepEqual(
	presentedBeforeSpanningCapture.effects.map((effect) => effect.type),
	["restore-save-pass-through"],
);
const capturedAfterSpanningPresentation = reduceManagedLeafSession(
	presentedBeforeSpanningCapture.state,
	{
		type: "intent-captured",
		sessionId: presentedBeforeSpanningCapture.state.sessionId,
		expectedGeneration: 1,
		intent: spanningPresentationIntent,
	},
);
assert.equal(capturedAfterSpanningPresentation.accepted, true);
assert.deepEqual(capturedAfterSpanningPresentation.state.handoff?.intentState, {
	kind: "persisting",
	intentId: spanningPresentationIntent.intentId,
});
assert.equal(capturedAfterSpanningPresentation.effects[0]?.type, "persist-intent");
if (capturedAfterSpanningPresentation.effects[0]?.type === "persist-intent") {
	assert.equal(capturedAfterSpanningPresentation.effects[0].intent, spanningPresentationIntent);
	assert.equal(capturedAfterSpanningPresentation.effects[0].intent.compositionEpoch, 5);
	assert.equal(
		capturedAfterSpanningPresentation.effects[0].intent.startDocument,
		managed.displayedLineage.kind === "known" ? managed.displayedLineage.document : null,
	);
}
assertRejectedSame(returnedWithCandidate.state, {
	type: "target-presented",
	sessionId: returnedWithCandidate.state.sessionId,
	expectedGeneration: 2,
	receipt: validPresentation,
}, "returned source rejects stale B presentation payload");
assertRejectedSame(superseded.state, {
	type: "target-presented",
	sessionId: superseded.state.sessionId,
	expectedGeneration: 2,
	receipt: validPresentation,
}, "current C rejects stale B presentation completion");
for (const [label, receipt] of [
	["receipt host token", makePresentationReceipt(held.state, candidateB, {
		host: { hostLoadTokenId: "different-host-load" },
	})],
	["receipt host path", makePresentationReceipt(held.state, candidateB, {
		host: { targetPath: "C.md" },
	})],
	["receipt fingerprint", makePresentationReceipt(held.state, candidateB, {
		host: { effectFingerprint: "different-effect" },
	})],
	["token TFile identity", makePresentationReceipt(held.state, candidateB, {
		token: { targetFile: fakeFile("B.md") },
	})],
	["token host receipt", makePresentationReceipt(held.state, candidateB, {
		token: { hostLoadReceiptId: "different-receipt" },
	})],
	["token native history", makePresentationReceipt(held.state, candidateB, {
		token: { nativeHistoryEpoch: 99 },
	})],
	["token base", makePresentationReceipt(held.state, candidateB, {
		token: { certifiedBaseContent: "different-content" },
	})],
] as const) {
	assertRejectedSame(held.state, {
		type: "target-presented",
		sessionId: held.state.sessionId,
		expectedGeneration: 1,
		receipt,
	}, label);
}

const inconsistentCandidate = makeCandidate(detached.state, {
	hostLoadTokenId: "host-load:inconsistent-document",
	targetDocument: fakeText("transaction result differs from certified base"),
});
const inconsistentHeld = reduceManagedLeafSession(detached.state, {
	type: "host-candidate-held",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	candidate: inconsistentCandidate,
});
assert.equal(inconsistentHeld.accepted, true);
assertRejectedSame(inconsistentHeld.state, {
	type: "target-presented",
	sessionId: inconsistentHeld.state.sessionId,
	expectedGeneration: 1,
	receipt: makePresentationReceipt(inconsistentHeld.state, inconsistentCandidate),
}, "transaction result must equal certified target base");

const presented = reduceManagedLeafSession(held.state, {
	type: "target-presented",
	sessionId: held.state.sessionId,
	expectedGeneration: 1,
	receipt: validPresentation,
});
assert.equal(presented.accepted, true);
assert.equal(presented.state.eventOrderSeq, 1);
assert.equal(presented.state.nativeHistoryEpoch, 4);
assert.equal(presented.state.binding.kind, "unbound");
assert.equal(presented.state.displayedLineage.kind, "known");
if (presented.state.displayedLineage.kind === "known") {
	assert.equal(presented.state.displayedLineage.file, fileB);
	assert.equal(presented.state.displayedLineage.path, "B.md");
	assert.equal(presented.state.displayedLineage.fileId, "file-b");
	assert.equal(presented.state.displayedLineage.cm, candidateB.cm);
	assert.equal(presented.state.displayedLineage.document, candidateB.cm.state.doc);
	assert.equal(presented.state.displayedLineage.editorRevision, 8);
}

const firstFile = fakeFile("First.md");
const firstUnknown = createManagedLeafSession({
	sessionId: "boot-first",
	leafId: "leaf-first",
	view: { file: firstFile } as unknown as MarkdownView,
	displayedLineage: { kind: "unknown" },
	binding: { kind: "unbound" },
});
const firstSelected = reduceManagedLeafSession(firstUnknown, {
	type: "target-selected",
	sessionId: firstUnknown.sessionId,
	expectedGeneration: 0,
	targetFile: firstFile,
	switchIntentSeq: 1,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(firstSelected.accepted, true);
const firstDetached = reduceManagedLeafSession(firstSelected.state, {
	type: "detach-completed",
	sessionId: firstSelected.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 0,
});
assert.equal(firstDetached.accepted, true);
const firstCandidate = makeCandidate(firstDetached.state, {
	editorRevisionBefore: 4,
});
const firstHeld = reduceManagedLeafSession(firstDetached.state, {
	type: "host-candidate-held",
	sessionId: firstDetached.state.sessionId,
	expectedGeneration: 1,
	candidate: firstCandidate,
});
assert.equal(firstHeld.accepted, true);
const firstPresented = reduceManagedLeafSession(firstHeld.state, {
	type: "target-presented",
	sessionId: firstHeld.state.sessionId,
	expectedGeneration: 1,
	receipt: makePresentationReceipt(firstHeld.state, firstCandidate),
});
assert.equal(firstPresented.accepted, true);
assert.equal(firstPresented.state.displayedLineage.kind, "known");
if (firstPresented.state.displayedLineage.kind === "known") {
	assert.equal(
		firstPresented.state.displayedLineage.editorRevision,
		5,
		"unknown first presentation advances from the exact captured CM revision",
	);
}
assert.equal(presented.state.handoff?.presentation, "target-proven");
assert.equal(presented.state.handoff?.targetReadyTokenId, "target-ready:B.md");
assert.equal(presented.state.handoff?.pendingHostLoadCandidate, null);
assert.equal(presented.state.handoff?.inputGateInstalled, false);
assert.equal(presented.state.handoff?.saveGuardInstalled, false);
assert.equal(presented.state.handoff?.phase, "target-ready");
assert.deepEqual(
	presented.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

assertRejectedSame(presented.state, {
	type: "target-presented",
	sessionId: presented.state.sessionId,
	expectedGeneration: 1,
	receipt: validPresentation,
}, "duplicate presentation receipt");

const boundTargetYText = { name: "ytext:B.md" } as unknown as Y.Text;
const bindingCompleted = reduceManagedLeafSession(presented.state, {
	type: "binding-completed",
	sessionId: presented.state.sessionId,
	expectedGeneration: 1,
	presentationTargetReadyTokenId: "target-ready:B.md",
	finalTargetReadyTokenId: "target-ready:B.md:refreshed",
	fileId: "file-b",
	ytext: boundTargetYText,
	bindingEpochAfterBind: (presented.state.handoff?.bindingEpochAfterDetach ?? -1) + 1,
});
assert.equal(bindingCompleted.accepted, true);
assert.equal(bindingCompleted.state.handoff, null);
assert.equal(bindingCompleted.state.currentSwitchIntentSeq, null);
assert.equal(bindingCompleted.state.completedDetachEpoch, null);
assert.deepEqual(bindingCompleted.state.binding, {
	kind: "bound",
	path: "B.md",
	fileId: "file-b",
	ytext: boundTargetYText,
});
assertRejectedSame(presented.state, {
	type: "binding-completed",
	sessionId: presented.state.sessionId,
	expectedGeneration: 1,
	presentationTargetReadyTokenId: "stale-target-ready",
	finalTargetReadyTokenId: "target-ready:B.md:refreshed",
	fileId: "file-b",
	ytext: boundTargetYText,
	bindingEpochAfterBind: (presented.state.handoff?.bindingEpochAfterDetach ?? -1) + 1,
}, "binding completion requires the presented token lineage");

const advancedAfterPresentation = reduceManagedLeafSession(presented.state, {
	type: "target-selected",
	sessionId: presented.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(advancedAfterPresentation.accepted, true);
assert.equal(advancedAfterPresentation.state.generation, 2);
assert.equal(advancedAfterPresentation.state.eventOrderSeq, 2);
assert.equal(advancedAfterPresentation.state.currentSwitchIntentSeq, 2);
assert.equal(advancedAfterPresentation.state.displayedLineage, presented.state.displayedLineage);
assert.equal(advancedAfterPresentation.state.handoff?.sourceAuthorityPath, "B.md");
assert.equal(advancedAfterPresentation.state.handoff?.targetPath, "C.md");

const reservedOnProvenB = reserveInput(presented.state, 7);
const reaffirmedBWhileReserved = reduceManagedLeafSession(reservedOnProvenB.state, {
	type: "target-selected",
	sessionId: reservedOnProvenB.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileB,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(reaffirmedBWhileReserved.accepted, false);
assert.equal(reaffirmedBWhileReserved.state, reservedOnProvenB.state);
assert.deepEqual(reaffirmedBWhileReserved.effects, []);
assert.equal(reaffirmedBWhileReserved.state.generation, 1);
assert.equal(reaffirmedBWhileReserved.state.eventOrderSeq, 2);
const advancedWithPriorInput = reduceManagedLeafSession(reservedOnProvenB.state, {
	type: "target-selected",
	sessionId: reservedOnProvenB.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(advancedWithPriorInput.accepted, true);
assert.equal(advancedWithPriorInput.state.handoff?.bindingEpochAfterDetach, 8);
assertRejectedSame(advancedWithPriorInput.state, {
	type: "detach-completed",
	sessionId: advancedWithPriorInput.state.sessionId,
	expectedGeneration: 2,
	bindingEpochAfterDetach: 8,
}, "proven B to C reuses completed detach epoch");
const detachedAfterPresentation = advancedWithPriorInput;
const priorSwitchIntent = makeIntent(detachedAfterPresentation.state, {
	intentId: "intent:began-on-proven-b",
});
const candidateCBeforePriorInputCapture = makeCandidate(detachedAfterPresentation.state);
const heldCBeforePriorInputCapture = reduceManagedLeafSession(detachedAfterPresentation.state, {
	type: "host-candidate-held",
	sessionId: detachedAfterPresentation.state.sessionId,
	expectedGeneration: 2,
	candidate: candidateCBeforePriorInputCapture,
});
assert.equal(heldCBeforePriorInputCapture.accepted, true);
const presentedCBeforePriorInputCapture = reduceManagedLeafSession(
	heldCBeforePriorInputCapture.state,
	{
		type: "target-presented",
		sessionId: heldCBeforePriorInputCapture.state.sessionId,
		expectedGeneration: 2,
		receipt: makePresentationReceipt(
			heldCBeforePriorInputCapture.state,
			candidateCBeforePriorInputCapture,
		),
	},
);
assert.equal(presentedCBeforePriorInputCapture.accepted, true);
assert.equal(presentedCBeforePriorInputCapture.state.handoff?.inputGateInstalled, true);
assert.equal(
	presentedCBeforePriorInputCapture.state.pendingInputStartReservation,
	detachedAfterPresentation.state.pendingInputStartReservation,
);
assert.equal(presentedCBeforePriorInputCapture.state.displayedLineage.kind, "known");
if (presentedCBeforePriorInputCapture.state.displayedLineage.kind === "known") {
	assert.equal(presentedCBeforePriorInputCapture.state.displayedLineage.file, fileC);
}
const capturedPriorSwitchIntent = reduceManagedLeafSession(presentedCBeforePriorInputCapture.state, {
	type: "intent-captured",
	sessionId: presentedCBeforePriorInputCapture.state.sessionId,
	expectedGeneration: 2,
	intent: priorSwitchIntent,
});
assert.equal(capturedPriorSwitchIntent.accepted, true);
assert.equal(capturedPriorSwitchIntent.state.activeRecoveries[0]?.intent, priorSwitchIntent);
assert.equal(capturedPriorSwitchIntent.state.activeRecoveries[0]?.intent.fromPath, "B.md");
assert.equal(capturedPriorSwitchIntent.state.activeRecoveries[0]?.intent.targetPath, "C.md");
assert.equal(
	capturedPriorSwitchIntent.state.activeRecoveries[0]?.intent.startDocument,
	presented.state.displayedLineage.kind === "known"
		? presented.state.displayedLineage.document
		: null,
);
assert.equal(
	capturedPriorSwitchIntent.state.handoff?.intentState.kind,
	"persisting",
);

const reservedDetached = reserveInput(detached.state);
const fileA = managed.displayedLineage.kind === "known"
	? managed.displayedLineage.file
	: fakeFile("A.md");
const returnToSourceWhileReserved = reduceManagedLeafSession(reservedDetached.state, {
	type: "target-selected",
	sessionId: reservedDetached.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileA,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(returnToSourceWhileReserved.accepted, false);
assert.equal(returnToSourceWhileReserved.state, reservedDetached.state);
assert.deepEqual(returnToSourceWhileReserved.effects, []);
assert.equal(returnToSourceWhileReserved.state.generation, 1);
assert.equal(returnToSourceWhileReserved.state.eventOrderSeq, 2);
const returnToSourceChanges = { name: "exact-return-a-to-b" } as unknown as ChangeSet;
const returnToSourceIntent = makeIntent(reservedDetached.state, {
	intentId: "intent:return-must-remain-a-to-b",
	changes: returnToSourceChanges,
	afterContent: "exact return-to-source quarantined successor",
	afterContentHash: "hash:return-a-to-b",
});
const capturedBeforeReturnToSource = reduceManagedLeafSession(reservedDetached.state, {
	type: "intent-captured",
	sessionId: reservedDetached.state.sessionId,
	expectedGeneration: 1,
	intent: returnToSourceIntent,
});
assert.equal(capturedBeforeReturnToSource.accepted, true);
assert.equal(capturedBeforeReturnToSource.state.activeRecoveries[0]?.intent, returnToSourceIntent);
assert.equal(capturedBeforeReturnToSource.state.activeRecoveries[0]?.intent.changes, returnToSourceChanges);
assert.equal(capturedBeforeReturnToSource.state.activeRecoveries[0]?.intent.targetPath, "B.md");
const storedBeforeReturnToSource = reduceManagedLeafSession(capturedBeforeReturnToSource.state, {
	type: "intent-state-changed",
	sessionId: capturedBeforeReturnToSource.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "stored",
		intentId: returnToSourceIntent.intentId,
		recordId: "record:return-a-to-b",
	},
});
assert.equal(storedBeforeReturnToSource.accepted, true);
const reviewedBeforeReturnToSource = reduceManagedLeafSession(storedBeforeReturnToSource.state, {
	type: "intent-state-changed",
	sessionId: storedBeforeReturnToSource.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "needs-review",
		intentId: returnToSourceIntent.intentId,
		recordId: "record:return-a-to-b",
	},
});
assert.equal(reviewedBeforeReturnToSource.accepted, true);
assert.deepEqual(reviewedBeforeReturnToSource.state.activeRecoveries, []);
const retriedReturnToSource = reduceManagedLeafSession(reviewedBeforeReturnToSource.state, {
	type: "target-selected",
	sessionId: reviewedBeforeReturnToSource.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileA,
	switchIntentSeq: 3,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(retriedReturnToSource.accepted, true);
assert.equal(retriedReturnToSource.state.generation, 2);
assert.equal(retriedReturnToSource.state.eventOrderSeq, 3);
assert.equal(retriedReturnToSource.state.pendingInputStartReservation, null);
assert.equal(retriedReturnToSource.state.handoff, null);
assert.deepEqual(
	retriedReturnToSource.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

assertRejectedSame(managed, {
	type: "intent-captured",
	sessionId: managed.sessionId,
	expectedGeneration: 0,
	intent: makeIntent(reservedDetached.state),
}, "intent without handoff");

for (const [label, intent] of [
	["intent session", makeIntent(reservedDetached.state, { sessionId: "other-boot" })],
	["intent leaf", makeIntent(reservedDetached.state, { leafId: "other-leaf" })],
	["intent generation", makeIntent(reservedDetached.state, { handoffGeneration: 2 })],
	["intent switch", makeIntent(reservedDetached.state, { switchIntentSeq: 2 })],
	["intent target path", makeIntent(reservedDetached.state, { targetPath: "C.md" })],
	["intent target file", makeIntent(reservedDetached.state, { targetFile: fakeFile("B.md") })],
	["intent binding epoch", makeIntent(reservedDetached.state, { bindingEpoch: 9 })],
	["intent start lineage", makeIntent(reservedDetached.state, { startDocument: fakeText("different") })],
	["intent derived sequence", makeIntent(reservedDetached.state, {
		inputStartedUnderSwitchSeq: null,
		sequenceBegan: "after-target-selected",
	})],
	["intent event order", makeIntent(reservedDetached.state, {
		inputStartSeq: 999,
	})],
] as const) {
	assertRejectedSame(reservedDetached.state, {
		type: "intent-captured",
		sessionId: reservedDetached.state.sessionId,
		expectedGeneration: 1,
		intent,
	}, label);
}

assertRejectedSame(detached.state, {
	type: "intent-captured",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	intent: makeIntent(detached.state, {
		inputEpoch: 2,
		inputStartSeq: 2,
		inputStartedUnderSwitchSeq: 1,
		sequenceBegan: "after-target-selected",
	}),
}, "fabricated unreserved input order");

const beforeHandoffReservation = reserveInput(managed, 3);
const selectedAfterInputStart = reduceManagedLeafSession(beforeHandoffReservation.state, {
	type: "target-selected",
	sessionId: beforeHandoffReservation.state.sessionId,
	expectedGeneration: 0,
	targetFile: fileB,
	switchIntentSeq: 2,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(selectedAfterInputStart.accepted, true);
const detachedAfterInputStart = reduceManagedLeafSession(selectedAfterInputStart.state, {
	type: "detach-completed",
	sessionId: selectedAfterInputStart.state.sessionId,
	expectedGeneration: 1,
	bindingEpochAfterDetach: 8,
});
assert.equal(detachedAfterInputStart.accepted, true);
const beforeHandoffIntent = makeIntent(detachedAfterInputStart.state, {
	intentId: "intent:before-handoff",
});
const capturedBeforeHandoff = reduceManagedLeafSession(detachedAfterInputStart.state, {
	type: "intent-captured",
	sessionId: detachedAfterInputStart.state.sessionId,
	expectedGeneration: 1,
	intent: beforeHandoffIntent,
});
assert.equal(capturedBeforeHandoff.accepted, true);

const intentB = makeIntent(reservedDetached.state);
const captured = reduceManagedLeafSession(reservedDetached.state, {
	type: "intent-captured",
	sessionId: reservedDetached.state.sessionId,
	expectedGeneration: 1,
	intent: intentB,
});
assert.equal(captured.accepted, true);
assert.equal(captured.state.eventOrderSeq, 2);
assert.equal(captured.state.pendingInputStartReservation, null);
assert.equal(captured.state.handoff?.recoveryOperationEpoch, 1);
assert.deepEqual(captured.state.handoff?.intentState, {
	kind: "persisting",
	intentId: intentB.intentId,
});
assert.deepEqual(captured.state.activeRecoveries, [{
	sessionId: captured.state.sessionId,
	handoffGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "persisting", intentId: intentB.intentId },
	intent: intentB,
}]);
assert.equal(captured.state.handoff?.phase, "awaiting-recovery-commit");
assert.equal(captured.effects.length, 1);
assert.equal(captured.effects[0]?.type, "persist-intent");
if (captured.effects[0]?.type === "persist-intent") {
	assert.equal(captured.effects[0].intent, intentB);
	assert.equal(captured.effects[0].recoveryOperationEpoch, 1);
	assert.equal(captured.effects[0].sessionId, "boot-a");
	assert.equal(captured.effects[0].expectedGeneration, 1);
}

assertRejectedSame(captured.state, {
	type: "intent-captured",
	sessionId: captured.state.sessionId,
	expectedGeneration: 1,
	intent: intentB,
}, "duplicate intent capture");

assertRejectedSame(captured.state, {
	type: "intent-state-changed",
	sessionId: captured.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 0,
	intentState: { kind: "stored", intentId: intentB.intentId, recordId: "record-b" },
}, "older persistence completion");
assertRejectedSame(captured.state, {
	type: "intent-state-changed",
	sessionId: captured.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "stored", intentId: intentB.intentId, recordId: "record-b" },
}, "future persistence completion");
assertRejectedSame(captured.state, {
	type: "recovery-operation-started",
	sessionId: captured.state.sessionId,
	expectedGeneration: 1,
	operation: "persist",
}, "intent capture already started persistence");

const failed = reduceManagedLeafSession(captured.state, {
	type: "intent-state-changed",
	sessionId: captured.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "failed", intentId: intentB.intentId, reason: "write-failed" },
});
assert.equal(failed.accepted, true);
assert.equal(failed.state.handoff?.intentState.kind, "failed");

const retry = reduceManagedLeafSession(failed.state, {
	type: "recovery-operation-started",
	sessionId: failed.state.sessionId,
	expectedGeneration: 1,
	operation: "retry",
});
assert.equal(retry.accepted, true);
assert.equal(retry.state.handoff?.recoveryOperationEpoch, 2);
assert.deepEqual(retry.state.handoff?.intentState, {
	kind: "persisting",
	intentId: intentB.intentId,
});
assert.deepEqual(retry.effects, []);

for (const operation of ["copy", "export", "discard"] as const) {
	const escapeFromHungStore = reduceManagedLeafSession(captured.state, {
		type: "recovery-operation-started",
		sessionId: captured.state.sessionId,
		expectedGeneration: 1,
		operation,
	});
	assert.equal(escapeFromHungStore.accepted, true, `${operation}: hung store escape accepted`);
	assert.equal(escapeFromHungStore.state.handoff?.recoveryOperationEpoch, 2);
	assert.deepEqual(escapeFromHungStore.state.handoff?.intentState, {
		kind: "escape-pending",
		intentId: intentB.intentId,
		action: operation,
	});
	assertRejectedSame(escapeFromHungStore.state, {
		type: "intent-state-changed",
		sessionId: escapeFromHungStore.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: 1,
		intentState: { kind: "stored", intentId: intentB.intentId, recordId: "late-record" },
	}, `${operation}: late hung-store completion is fenced`);
	const completedEscape = reduceManagedLeafSession(escapeFromHungStore.state, {
		type: "intent-state-changed",
		sessionId: escapeFromHungStore.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: 2,
		intentState: operation === "discard"
			? { kind: "discarded", intentId: intentB.intentId, recordId: null }
			: { kind: "escaped", intentId: intentB.intentId, action: operation, recordId: null },
	});
	assert.equal(completedEscape.accepted, true, `${operation}: matching escape completion accepted`);
}

const copy = reduceManagedLeafSession(failed.state, {
	type: "recovery-operation-started",
	sessionId: failed.state.sessionId,
	expectedGeneration: 1,
	operation: "copy",
});
assert.equal(copy.accepted, true);
assert.equal(copy.state.handoff?.recoveryOperationEpoch, 2);
assert.deepEqual(copy.state.handoff?.intentState, {
	kind: "escape-pending",
	intentId: intentB.intentId,
	action: "copy",
});

for (const replacement of ["copy", "export", "discard"] as const) {
	const replacedPendingEscape = reduceManagedLeafSession(copy.state, {
		type: "recovery-operation-started",
		sessionId: copy.state.sessionId,
		expectedGeneration: 1,
		operation: replacement,
	});
	assert.equal(
		replacedPendingEscape.accepted,
		true,
		`escape-pending remains operable through ${replacement}`,
	);
	assert.equal(replacedPendingEscape.state.handoff?.recoveryOperationEpoch, 3);
	assert.deepEqual(replacedPendingEscape.state.handoff?.intentState, {
		kind: "escape-pending",
		intentId: intentB.intentId,
		action: replacement,
	});
}

assertRejectedSame(copy.state, {
	type: "intent-state-changed",
	sessionId: copy.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "stored", intentId: intentB.intentId, recordId: "record-b" },
}, "retry completion reordered behind copy");
assertRejectedSame(copy.state, {
	type: "intent-state-changed",
	sessionId: copy.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: {
		kind: "escaped",
		intentId: intentB.intentId,
		action: "export",
		recordId: null,
	},
}, "mismatched escape action");
assertRejectedSame(copy.state, {
	type: "intent-state-changed",
	sessionId: copy.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "discarded", intentId: intentB.intentId, recordId: null },
}, "copy cannot complete as discard");
assertRejectedSame(copy.state, {
	type: "intent-state-changed",
	sessionId: copy.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "resolved", intentId: intentB.intentId, recordId: "record-b" },
}, "copy cannot complete as resolution");

const escaped = reduceManagedLeafSession(copy.state, {
	type: "intent-state-changed",
	sessionId: copy.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: {
		kind: "escaped",
		intentId: intentB.intentId,
		action: "copy",
		recordId: null,
	},
});
assert.equal(escaped.accepted, true);
assert.equal(escaped.state.handoff?.intentState.kind, "escaped");
assert.equal(escaped.state.handoff?.inputGateInstalled, true);
assert.deepEqual(escaped.effects, []);

assertRejectedSame(escaped.state, {
	type: "intent-state-changed",
	sessionId: escaped.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "needs-review", intentId: intentB.intentId, recordId: "record-b" },
}, "terminal escape cannot regress");
assertRejectedSame(escaped.state, {
	type: "recovery-operation-started",
	sessionId: escaped.state.sessionId,
	expectedGeneration: 1,
	operation: "retry",
}, "terminal escape cannot restart");

const exportStarted = reduceManagedLeafSession(failed.state, {
	type: "recovery-operation-started",
	sessionId: failed.state.sessionId,
	expectedGeneration: 1,
	operation: "export",
});
assert.equal(exportStarted.accepted, true);
assert.deepEqual(exportStarted.state.handoff?.intentState, {
	kind: "escape-pending",
	intentId: intentB.intentId,
	action: "export",
});
const exported = reduceManagedLeafSession(exportStarted.state, {
	type: "intent-state-changed",
	sessionId: exportStarted.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: {
		kind: "escaped",
		intentId: intentB.intentId,
		action: "export",
		recordId: null,
	},
});
assert.equal(exported.accepted, true);
assert.equal(exported.state.handoff?.intentState.kind, "escaped");

const reservedForStored = reserveInput(detached.state, 8);
const capturedForStored = reduceManagedLeafSession(reservedForStored.state, {
	type: "intent-captured",
	sessionId: reservedForStored.state.sessionId,
	expectedGeneration: 1,
	intent: makeIntent(reservedForStored.state, { intentId: "intent:stored" }),
});
assert.equal(capturedForStored.accepted, true);
const stored = reduceManagedLeafSession(capturedForStored.state, {
	type: "intent-state-changed",
	sessionId: capturedForStored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "stored", intentId: "intent:stored", recordId: "record-stored" },
});
assert.equal(stored.accepted, true);
const needsReview = reduceManagedLeafSession(stored.state, {
	type: "intent-state-changed",
	sessionId: stored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "needs-review", intentId: "intent:stored", recordId: "record-stored" },
});
assert.equal(needsReview.accepted, true);
assert.deepEqual(needsReview.effects, []);
assert.deepEqual(needsReview.state.activeRecoveries, []);

const replayPending = reduceManagedLeafSession(stored.state, {
	type: "intent-state-changed",
	sessionId: stored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "replay-pending",
		intentId: "intent:stored",
		recordId: "record-stored",
	},
});
assert.equal(replayPending.accepted, true);
const replayedAwaitingSettlement = reduceManagedLeafSession(replayPending.state, {
	type: "intent-state-changed",
	sessionId: replayPending.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "replayed-awaiting-settlement",
		intentId: "intent:stored",
		recordId: "record-stored",
	},
});
assert.equal(replayedAwaitingSettlement.accepted, true);

const failedForStored = reduceManagedLeafSession(capturedForStored.state, {
	type: "intent-state-changed",
	sessionId: capturedForStored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "failed", intentId: "intent:stored", reason: "write-failed" },
});
assert.equal(failedForStored.accepted, true);

const transitionCandidates: readonly HandoffIntentState[] = [
	{ kind: "persisting", intentId: "intent:stored" },
	{ kind: "stored", intentId: "intent:stored", recordId: "record-stored" },
	{ kind: "replay-pending", intentId: "intent:stored", recordId: "record-stored" },
	{
		kind: "replayed-awaiting-settlement",
		intentId: "intent:stored",
		recordId: "record-stored",
	},
	{ kind: "needs-review", intentId: "intent:stored", recordId: "record-stored" },
	{ kind: "escape-pending", intentId: "intent:stored", action: "copy" },
	{ kind: "escaped", intentId: "intent:stored", action: "copy", recordId: null },
	{ kind: "resolved", intentId: "intent:stored", recordId: "record-stored" },
	{ kind: "discarded", intentId: "intent:stored", recordId: "record-stored" },
	{ kind: "failed", intentId: "intent:stored", reason: "operation-failed" },
];
const legalTransitionKinds = new Map<string, ReadonlySet<HandoffIntentState["kind"]>>([
	["persisting", new Set(["stored", "failed"])],
	["stored", new Set(["replay-pending", "needs-review", "failed"])],
	["replay-pending", new Set(["replayed-awaiting-settlement", "needs-review", "failed"])],
	["replayed-awaiting-settlement", new Set(["resolved", "needs-review", "failed"])],
	["needs-review", new Set(["resolved", "discarded"])],
	["failed", new Set()],
]);
for (const [sourceKind, sourceState] of [
	["persisting", capturedForStored.state],
	["stored", stored.state],
	["replay-pending", replayPending.state],
	["replayed-awaiting-settlement", replayedAwaitingSettlement.state],
	["needs-review", needsReview.state],
	["failed", failedForStored.state],
] as const) {
	for (const intentState of transitionCandidates) {
		const transition = reduceManagedLeafSession(sourceState, {
			type: "intent-state-changed",
			sessionId: sourceState.sessionId,
			expectedGeneration: sourceState.generation,
			recoveryOperationEpoch: sourceState.handoff?.recoveryOperationEpoch ?? -1,
			intentState,
		});
		const expectedAccepted = legalTransitionKinds.get(sourceKind)?.has(intentState.kind)
			?? false;
		assert.equal(
			transition.accepted,
			expectedAccepted,
			`${sourceKind} -> ${intentState.kind}`,
		);
		if (!expectedAccepted) {
			assert.equal(transition.state, sourceState, `${sourceKind} -> ${intentState.kind}: same state`);
			assert.deepEqual(transition.effects, [], `${sourceKind} -> ${intentState.kind}: no effects`);
		}
	}
}

for (const [sourceKind, sourceState] of [
	["stored", stored.state],
	["replay-pending", replayPending.state],
	["replayed-awaiting-settlement", replayedAwaitingSettlement.state],
	["needs-review", needsReview.state],
] as const) {
	for (const operation of ["copy", "export", "discard"] as const) {
		assertRejectedSame(sourceState, {
			type: "recovery-operation-started",
			sessionId: sourceState.sessionId,
			expectedGeneration: sourceState.generation,
			operation,
		}, `${sourceKind} cannot start non-durable ${operation} escape`);
	}
}

assertRejectedSame(needsReview.state, {
	type: "recovery-operation-started",
	sessionId: needsReview.state.sessionId,
	expectedGeneration: 1,
	operation: "discard",
}, "review discard is a state completion, not an escape start");

const discard = reduceManagedLeafSession(failed.state, {
	type: "recovery-operation-started",
	sessionId: failed.state.sessionId,
	expectedGeneration: 1,
	operation: "discard",
});
assert.equal(discard.accepted, true);
assert.equal(discard.state.handoff?.recoveryOperationEpoch, 2);
assert.deepEqual(discard.state.handoff?.intentState, {
	kind: "escape-pending",
	intentId: intentB.intentId,
	action: "discard",
});
assertRejectedSame(discard.state, {
	type: "intent-state-changed",
	sessionId: discard.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "failed", intentId: intentB.intentId, reason: "stale-failure" },
}, "review completion reordered behind discard");
assertRejectedSame(discard.state, {
	type: "intent-state-changed",
	sessionId: discard.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: {
		kind: "escaped",
		intentId: intentB.intentId,
		action: "copy",
		recordId: null,
	},
}, "discard cannot complete as escape");
assertRejectedSame(discard.state, {
	type: "intent-state-changed",
	sessionId: discard.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "resolved", intentId: intentB.intentId, recordId: "record-b" },
}, "discard cannot complete as resolution");
const discarded = reduceManagedLeafSession(discard.state, {
	type: "intent-state-changed",
	sessionId: discard.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "discarded", intentId: intentB.intentId, recordId: null },
});
assert.equal(discarded.accepted, true);
assert.equal(discarded.state.handoff?.intentState.kind, "discarded");
assert.deepEqual(discarded.state.activeRecoveries, []);

const resolvedAfterReplay = reduceManagedLeafSession(replayedAwaitingSettlement.state, {
	type: "intent-state-changed",
	sessionId: replayedAwaitingSettlement.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: {
		kind: "resolved",
		intentId: "intent:stored",
		recordId: "record-stored",
	},
});
assert.equal(resolvedAfterReplay.accepted, true);
assert.deepEqual(resolvedAfterReplay.state.activeRecoveries, []);

for (const recoveryRace of [
	{
		label: "persisting epoch 1",
		state: captured.state,
		epoch: 1,
		next: { kind: "stored", intentId: intentB.intentId, recordId: "race-record" },
		terminal: false,
	},
	{
		label: "retried persisting epoch 2",
		state: retry.state,
		epoch: 2,
		next: { kind: "stored", intentId: intentB.intentId, recordId: "race-record" },
		terminal: false,
	},
	{
		label: "stored",
		state: stored.state,
		epoch: 1,
		next: {
			kind: "needs-review",
			intentId: "intent:stored",
			recordId: "record-stored",
		},
		terminal: true,
	},
	{
		label: "replay pending",
		state: replayPending.state,
		epoch: 1,
		next: {
			kind: "replayed-awaiting-settlement",
			intentId: "intent:stored",
			recordId: "record-stored",
		},
		terminal: false,
	},
	{
		label: "replayed awaiting settlement",
		state: replayedAwaitingSettlement.state,
		epoch: 1,
		next: {
			kind: "resolved",
			intentId: "intent:stored",
			recordId: "record-stored",
		},
		terminal: true,
	},
	{
		label: "copy escape pending epoch 2",
		state: copy.state,
		epoch: 2,
		next: {
			kind: "escaped",
			intentId: intentB.intentId,
			action: "copy",
			recordId: null,
		},
		terminal: true,
	},
] as const) {
	const recoveryBeforeSupersession = recoveryRace.state.activeRecoveries[0];
	assert.notEqual(recoveryBeforeSupersession, undefined, `${recoveryRace.label}: active before C`);
	const selectedCWithRecovery = reduceManagedLeafSession(recoveryRace.state, {
		type: "target-selected",
		sessionId: recoveryRace.state.sessionId,
		expectedGeneration: 1,
		targetFile: fileC,
		switchIntentSeq: recoveryRace.state.eventOrderSeq + 1,
		sourceUnloadReceiptId: "source-unload:test",
	});
	assert.equal(selectedCWithRecovery.accepted, true, `${recoveryRace.label}: B to C accepted`);
	assert.equal(selectedCWithRecovery.state.activeRecoveries.length, 1);
	assert.equal(
		selectedCWithRecovery.state.activeRecoveries[0],
		recoveryBeforeSupersession,
		`${recoveryRace.label}: immutable A to B recovery retained`,
	);
	assert.equal(selectedCWithRecovery.state.activeRecoveries[0]?.sessionId, "boot-a");
	assert.equal(selectedCWithRecovery.state.activeRecoveries[0]?.handoffGeneration, 1);
	assert.equal(selectedCWithRecovery.state.activeRecoveries[0]?.intent, recoveryBeforeSupersession?.intent);
	assert.equal(selectedCWithRecovery.state.handoff?.targetPath, "C.md");
	assert.deepEqual(selectedCWithRecovery.state.handoff?.intentState, { kind: "none" });
	assert.equal(selectedCWithRecovery.state.handoff?.recoveryOperationEpoch, 0);
	const currentCHandoff = selectedCWithRecovery.state.handoff;
	const currentCDisplay = selectedCWithRecovery.state.displayedLineage;
	const currentCBinding = selectedCWithRecovery.state.binding;
	assertRejectedSame(selectedCWithRecovery.state, {
		type: "intent-state-changed",
		sessionId: selectedCWithRecovery.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: recoveryRace.epoch + 1,
		intentState: recoveryRace.next,
	}, `${recoveryRace.label}: wrong old recovery epoch`);
	const oldRecoveryCompleted = reduceManagedLeafSession(selectedCWithRecovery.state, {
		type: "intent-state-changed",
		sessionId: selectedCWithRecovery.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: recoveryRace.epoch,
		intentState: recoveryRace.next,
	});
	assert.equal(oldRecoveryCompleted.accepted, true, `${recoveryRace.label}: old completion accepted`);
	assert.deepEqual(oldRecoveryCompleted.effects, [], `${recoveryRace.label}: no current effects`);
	assert.equal(oldRecoveryCompleted.state.handoff, currentCHandoff);
	assert.equal(oldRecoveryCompleted.state.displayedLineage, currentCDisplay);
	assert.equal(oldRecoveryCompleted.state.binding, currentCBinding);
	assert.equal(
		oldRecoveryCompleted.state.activeRecoveries.length,
		recoveryRace.terminal ? 0 : 1,
		`${recoveryRace.label}: terminal cleanup`,
	);
	if (!recoveryRace.terminal) {
		assert.deepEqual(oldRecoveryCompleted.state.activeRecoveries[0]?.intentState, recoveryRace.next);
		assert.equal(
			oldRecoveryCompleted.state.activeRecoveries[0]?.recoveryOperationEpoch,
			recoveryRace.epoch,
		);
	}
}

const selectedCAfterFailedRecovery = reduceManagedLeafSession(failed.state, {
	type: "target-selected",
	sessionId: failed.state.sessionId,
	expectedGeneration: 1,
	targetFile: fileC,
	switchIntentSeq: failed.state.eventOrderSeq + 1,
	sourceUnloadReceiptId: "source-unload:test",
});
assert.equal(selectedCAfterFailedRecovery.accepted, true);
const cHandoffBeforeOldRetry = selectedCAfterFailedRecovery.state.handoff;
const oldRetryAfterSupersession = reduceManagedLeafSession(selectedCAfterFailedRecovery.state, {
	type: "recovery-operation-started",
	sessionId: selectedCAfterFailedRecovery.state.sessionId,
	expectedGeneration: 1,
	operation: "retry",
});
assert.equal(oldRetryAfterSupersession.accepted, true);
assert.equal(oldRetryAfterSupersession.state.handoff, cHandoffBeforeOldRetry);
assert.deepEqual(oldRetryAfterSupersession.effects, []);
assert.deepEqual(oldRetryAfterSupersession.state.activeRecoveries[0]?.intentState, {
	kind: "persisting",
	intentId: intentB.intentId,
});
assert.equal(oldRetryAfterSupersession.state.activeRecoveries[0]?.recoveryOperationEpoch, 2);
assertRejectedSame(oldRetryAfterSupersession.state, {
	type: "intent-state-changed",
	sessionId: oldRetryAfterSupersession.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "stored", intentId: intentB.intentId, recordId: "stale-record" },
}, "B retry epoch fences stale completion after C supersession");
const oldRetryStored = reduceManagedLeafSession(oldRetryAfterSupersession.state, {
	type: "intent-state-changed",
	sessionId: oldRetryAfterSupersession.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 2,
	intentState: { kind: "stored", intentId: intentB.intentId, recordId: "retry-record" },
});
assert.equal(oldRetryStored.accepted, true);
assert.equal(oldRetryStored.state.handoff, cHandoffBeforeOldRetry);
assert.deepEqual(oldRetryStored.effects, []);

const reservedWhileHeld = reserveInput(held.state, 9, 4);
const intentWhileHeld = makeIntent(reservedWhileHeld.state, { intentId: "intent:held" });
const capturedWhileHeld = reduceManagedLeafSession(reservedWhileHeld.state, {
	type: "intent-captured",
	sessionId: reservedWhileHeld.state.sessionId,
	expectedGeneration: 1,
	intent: intentWhileHeld,
});
assert.equal(capturedWhileHeld.accepted, true);
const presentedWhilePersisting = reduceManagedLeafSession(capturedWhileHeld.state, {
	type: "target-presented",
	sessionId: capturedWhileHeld.state.sessionId,
	expectedGeneration: 1,
	receipt: validPresentation,
});
assert.equal(presentedWhilePersisting.accepted, true);
assert.equal(presentedWhilePersisting.state.handoff?.inputGateInstalled, true);
assert.equal(presentedWhilePersisting.state.handoff?.saveGuardInstalled, false);
assert.deepEqual(
	presentedWhilePersisting.effects.map((effect) => effect.type),
	["restore-save-pass-through"],
);
const heldStored = reduceManagedLeafSession(presentedWhilePersisting.state, {
	type: "intent-state-changed",
	sessionId: presentedWhilePersisting.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "stored", intentId: "intent:held", recordId: "record-held" },
});
assert.equal(heldStored.accepted, true);
assert.deepEqual(heldStored.effects, []);
function withRecoveryHandoff(
	state: ManagedLeafSession,
	overrides: Partial<NonNullable<ManagedLeafSession["handoff"]>>,
): ManagedLeafSession {
	const handoff = state.handoff;
	if (handoff === null) throw new Error("expected recovery handoff");
	return {
		...state,
		handoff: {
			...handoff,
			...overrides,
		},
	};
}

const recoveryTargetBindingRequest = {
	type: "recovery-target-binding-requested",
	sessionId: heldStored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentId: "intent:held",
	recordId: "record-held",
} as const satisfies EditorHandoffEvent;
assertRejectedSame(heldStored.state, {
	...recoveryTargetBindingRequest,
	expectedGeneration: 0,
}, "recovery binding request generation");
assertRejectedSame(heldStored.state, {
	...recoveryTargetBindingRequest,
	recoveryOperationEpoch: 2,
}, "recovery binding request operation epoch");
assertRejectedSame(heldStored.state, {
	...recoveryTargetBindingRequest,
	intentId: "intent:other",
}, "recovery binding request intent");
assertRejectedSame(heldStored.state, {
	...recoveryTargetBindingRequest,
	recordId: "record-other",
}, "recovery binding request record");
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { phase: "awaiting-replay-settlement" }),
	recoveryTargetBindingRequest,
	"recovery binding request phase",
);
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { inputGateInstalled: false }),
	recoveryTargetBindingRequest,
	"recovery binding request gate",
);
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { saveGuardInstalled: true }),
	recoveryTargetBindingRequest,
	"recovery binding request save guard",
);
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { presentation: "target-candidate" }),
	recoveryTargetBindingRequest,
	"recovery binding request presentation",
);
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { targetReadyTokenId: null }),
	recoveryTargetBindingRequest,
	"recovery binding request target token",
);
assertRejectedSame(
	withRecoveryHandoff(heldStored.state, { pendingHostLoadCandidate: candidateB }),
	recoveryTargetBindingRequest,
	"recovery binding request pending candidate",
);
assertRejectedSame(
	reserveInput(heldStored.state, 10).state,
	recoveryTargetBindingRequest,
	"recovery binding request pending input reservation",
);
assertRejectedSame(
	{
		...heldStored.state,
		binding: createBoundSession({ file: fileB, path: "B.md" }).binding,
	},
	recoveryTargetBindingRequest,
	"recovery binding request existing binding",
);
assertRejectedSame(
	{
		...heldStored.state,
		activeRecoveries: [],
	},
	recoveryTargetBindingRequest,
	"recovery binding request missing active recovery",
);
assertRejectedSame(
	{
		...heldStored.state,
		displayedLineage: heldStored.state.displayedLineage.kind === "known"
			? {
				...heldStored.state.displayedLineage,
				path: "not-B.md",
			}
			: heldStored.state.displayedLineage,
	},
	recoveryTargetBindingRequest,
	"recovery binding request displayed target path",
);

const recoveryBindingRequested = reduceManagedLeafSession(
	heldStored.state,
	recoveryTargetBindingRequest,
);
assert.equal(recoveryBindingRequested.accepted, true);
assert.deepEqual(
	recoveryBindingRequested.state.handoff?.recoveryTargetBindingRequest,
	{
		recoveryOperationEpoch: 1,
		intentId: "intent:held",
		recordId: "record-held",
	},
);
assert.deepEqual(
	recoveryBindingRequested.effects,
	[{
		type: "request-recovery-target-binding",
		sessionId: heldStored.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: 1,
		intentId: "intent:held",
		recordId: "record-held",
	}],
);
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryTargetBindingRequest,
}, "duplicate recovery binding request");
const recoveryBoundYText = { name: "recovery-ytext:B.md" } as unknown as Y.Text;
const recoveryBindingCompletion = {
	type: "binding-completed",
	sessionId: recoveryBindingRequested.state.sessionId,
	expectedGeneration: 1,
	presentationTargetReadyTokenId: "target-ready:B.md",
	finalTargetReadyTokenId: "target-ready:B.md:recovery-bound",
	fileId: "file-b",
	ytext: recoveryBoundYText,
	cm: candidateB.cm,
	bindingEpochAfterBind:
		(recoveryBindingRequested.state.handoff?.bindingEpochAfterDetach ?? -1) + 1,
} as const satisfies EditorHandoffEvent;
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryBindingCompletion,
	expectedGeneration: 0,
}, "recovery binding completion generation");
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryBindingCompletion,
	presentationTargetReadyTokenId: "target-ready:stale",
}, "recovery binding completion presentation token");
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryBindingCompletion,
	finalTargetReadyTokenId: "",
}, "recovery binding completion final token");
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryBindingCompletion,
	cm: { name: "cm:foreign" } as unknown as EditorView,
}, "recovery binding completion CodeMirror");
assertRejectedSame(recoveryBindingRequested.state, {
	...recoveryBindingCompletion,
	bindingEpochAfterBind: recoveryBindingCompletion.bindingEpochAfterBind + 1,
}, "recovery binding completion epoch");
assertRejectedSame(
	withRecoveryHandoff(recoveryBindingRequested.state, {
		phase: "awaiting-replay-settlement",
	}),
	recoveryBindingCompletion,
	"recovery binding completion phase",
);
assertRejectedSame(
	withRecoveryHandoff(recoveryBindingRequested.state, {
		inputGateInstalled: false,
	}),
	recoveryBindingCompletion,
	"recovery binding completion gate",
);
assertRejectedSame(
	withRecoveryHandoff(recoveryBindingRequested.state, {
		recoveryOperationEpoch: 2,
	}),
	recoveryBindingCompletion,
	"recovery binding completion operation epoch",
);
assertRejectedSame(
	withRecoveryHandoff(recoveryBindingRequested.state, {
		intentState: {
			kind: "stored",
			intentId: "intent:other",
			recordId: "record-held",
		},
	}),
	recoveryBindingCompletion,
	"recovery binding completion intent",
);
assertRejectedSame(
	withRecoveryHandoff(recoveryBindingRequested.state, {
		intentState: {
			kind: "stored",
			intentId: "intent:held",
			recordId: "record-other",
		},
	}),
	recoveryBindingCompletion,
	"recovery binding completion record",
);
assertRejectedSame(
	{
		...recoveryBindingRequested.state,
		activeRecoveries: [],
	},
	recoveryBindingCompletion,
	"recovery binding completion missing active recovery",
);

for (const [label, recoveryWakeState] of [
	["requested", recoveryBindingRequested.state],
] as const) {
	assertRejectedSame(recoveryWakeState, {
		type: "target-observed",
		sessionId: recoveryWakeState.sessionId,
		expectedGeneration: recoveryWakeState.generation,
		targetFile: fileB,
	}, `${label} recovery same-target observed wake`);
	assertRejectedSame(recoveryWakeState, {
		type: "target-selected",
		sessionId: recoveryWakeState.sessionId,
		expectedGeneration: recoveryWakeState.generation,
		targetFile: fileB,
		switchIntentSeq: recoveryWakeState.eventOrderSeq + 1,
		sourceUnloadReceiptId: "source-unload:test",
	}, `${label} recovery same-target selected wake`);
}

const recoveryBindingCompleted = reduceManagedLeafSession(
	recoveryBindingRequested.state,
	recoveryBindingCompletion,
);
assert.equal(recoveryBindingCompleted.accepted, true);
assert.deepEqual(recoveryBindingCompleted.effects, []);
assert.equal(recoveryBindingCompleted.state.handoff?.inputGateInstalled, true);
assert.equal(
	recoveryBindingCompleted.state.handoff?.phase,
	recoveryBindingRequested.state.handoff?.phase,
);
assert.equal(
	recoveryBindingCompleted.state.handoff?.targetReadyTokenId,
	"target-ready:B.md:recovery-bound",
);
assert.deepEqual(
	recoveryBindingCompleted.state.handoff?.recoveryTargetBindingRequest,
	recoveryBindingRequested.state.handoff?.recoveryTargetBindingRequest,
);
assert.equal(recoveryBindingCompleted.state.currentSwitchIntentSeq, 1);
assert.equal(
	recoveryBindingCompleted.state.activeRecoveries,
	recoveryBindingRequested.state.activeRecoveries,
);
assert.deepEqual(recoveryBindingCompleted.state.binding, {
	kind: "bound",
	path: "B.md",
	fileId: "file-b",
	ytext: recoveryBoundYText,
});
assertRejectedSame(
	recoveryBindingCompleted.state,
	recoveryBindingCompletion,
	"duplicate recovery binding completion",
);
for (const event of [
	{
		type: "target-observed",
		sessionId: recoveryBindingCompleted.state.sessionId,
		expectedGeneration: recoveryBindingCompleted.state.generation,
		targetFile: fileB,
	},
	{
		type: "target-selected",
		sessionId: recoveryBindingCompleted.state.sessionId,
		expectedGeneration: recoveryBindingCompleted.state.generation,
		targetFile: fileB,
		switchIntentSeq: recoveryBindingCompleted.state.eventOrderSeq + 1,
		sourceUnloadReceiptId: "source-unload:test",
	},
] as const satisfies readonly EditorHandoffEvent[]) {
	assertRejectedSame(
		recoveryBindingCompleted.state,
		event,
		`bound recovery same-target ${event.type} wake`,
	);
}
const recoverySupersededByC = reduceManagedLeafSession(
	recoveryBindingCompleted.state,
	{
		type: "target-selected",
		sessionId: recoveryBindingCompleted.state.sessionId,
		expectedGeneration: recoveryBindingCompleted.state.generation,
		targetFile: fileC,
		switchIntentSeq: recoveryBindingCompleted.state.eventOrderSeq + 1,
		sourceUnloadReceiptId: "source-unload:test",
	},
);
assert.equal(recoverySupersededByC.accepted, true);
assert.equal(recoverySupersededByC.state.generation, 2);
assert.equal(recoverySupersededByC.state.handoff?.targetFile, fileC);
assert.equal(recoverySupersededByC.state.activeRecoveries[0]?.intent.intentId, "intent:held");

const replayPendingBeforeBinding = reduceManagedLeafSession(
	recoveryBindingRequested.state,
	{
		type: "intent-state-changed",
		sessionId: recoveryBindingRequested.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "replay-pending",
			intentId: "intent:held",
			recordId: "record-held",
		},
	},
);
assert.equal(replayPendingBeforeBinding.accepted, true);
const replayPendingBindingCompleted = reduceManagedLeafSession(
	replayPendingBeforeBinding.state,
	recoveryBindingCompletion,
);
assert.equal(replayPendingBindingCompleted.accepted, true);
assert.equal(
	replayPendingBindingCompleted.state.handoff?.phase,
	"awaiting-replay-settlement",
);
assert.equal(
	replayPendingBindingCompleted.state.handoff?.recoveryTargetBindingRequest,
	recoveryBindingRequested.state.handoff?.recoveryTargetBindingRequest,
);
assert.equal(
	replayPendingBindingCompleted.state.activeRecoveries,
	replayPendingBeforeBinding.state.activeRecoveries,
);
assert.deepEqual(replayPendingBindingCompleted.effects, []);

const recoveryReplayPending = reduceManagedLeafSession(
	recoveryBindingCompleted.state,
	{
		type: "intent-state-changed",
		sessionId: recoveryBindingCompleted.state.sessionId,
		expectedGeneration: 1,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "replay-pending",
			intentId: "intent:held",
			recordId: "record-held",
		},
	},
);
assert.equal(recoveryReplayPending.accepted, true);
assert.deepEqual(
	recoveryReplayPending.state.handoff?.recoveryTargetBindingRequest,
	recoveryBindingCompleted.state.handoff?.recoveryTargetBindingRequest,
);
assert.equal(
	recoveryReplayPending.state.binding,
	recoveryBindingCompleted.state.binding,
);
const recoveryReview = reduceManagedLeafSession(recoveryBindingCompleted.state, {
	type: "intent-state-changed",
	sessionId: recoveryBindingCompleted.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "needs-review", intentId: "intent:held", recordId: "record-held" },
});
assert.equal(recoveryReview.accepted, true);
assert.equal(recoveryReview.state.handoff, null);
assert.equal(recoveryReview.state.currentSwitchIntentSeq, null);
assert.equal(recoveryReview.state.binding, recoveryBindingCompleted.state.binding);
assert.deepEqual(recoveryReview.state.activeRecoveries, []);
assert.deepEqual(
	recoveryReview.effects,
	[{
		type: "release-input-gate",
		sessionId: recoveryBindingCompleted.state.sessionId,
		expectedGeneration: recoveryBindingCompleted.state.generation,
	}],
);
assertRejectedSame(recoveryReview.state, {
	type: "intent-state-changed",
	sessionId: recoveryReview.state.sessionId,
	expectedGeneration: recoveryReview.state.generation,
	recoveryOperationEpoch: 1,
	intentState: { kind: "needs-review", intentId: "intent:held", recordId: "record-held" },
}, "terminal recovery review cannot release the gate twice");

const recoveryAwaitingSettlement = reduceManagedLeafSession(
	recoveryReplayPending.state,
	{
		type: "intent-state-changed",
		sessionId: recoveryReplayPending.state.sessionId,
		expectedGeneration: recoveryReplayPending.state.generation,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "replayed-awaiting-settlement",
			intentId: "intent:held",
			recordId: "record-held",
		},
	},
);
assert.equal(recoveryAwaitingSettlement.accepted, true);
assert.equal(
	recoveryAwaitingSettlement.state.handoff?.recoveryTargetBindingRequest,
	recoveryBindingCompleted.state.handoff?.recoveryTargetBindingRequest,
);
const recoveryResolved = reduceManagedLeafSession(
	recoveryAwaitingSettlement.state,
	{
		type: "intent-state-changed",
		sessionId: recoveryAwaitingSettlement.state.sessionId,
		expectedGeneration: recoveryAwaitingSettlement.state.generation,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "resolved",
			intentId: "intent:held",
			recordId: "record-held",
		},
	},
);
assert.equal(recoveryResolved.accepted, true);
assert.equal(recoveryResolved.state.handoff, null);
assert.equal(recoveryResolved.state.currentSwitchIntentSeq, null);
assert.equal(recoveryResolved.state.binding, recoveryBindingCompleted.state.binding);
assert.deepEqual(recoveryResolved.state.activeRecoveries, []);
assert.deepEqual(
	recoveryResolved.effects.map((effect) => effect.type),
	["release-input-gate"],
);

for (const terminalEscape of [
	{
		action: "copy",
		intentState: {
			kind: "escaped",
			intentId: "intent:held",
			action: "copy",
			recordId: null,
		},
	},
	{
		action: "discard",
		intentState: {
			kind: "discarded",
			intentId: "intent:held",
			recordId: null,
		},
	},
] as const) {
	const activeRecovery = recoveryBindingCompleted.state.activeRecoveries[0];
	assert.notEqual(activeRecovery, undefined);
	const escapePendingState: ManagedLeafSession = {
		...recoveryBindingCompleted.state,
		activeRecoveries: [{
			...activeRecovery!,
			recoveryOperationEpoch: 2,
			intentState: {
				kind: "escape-pending",
				intentId: "intent:held",
				action: terminalEscape.action,
			},
		}],
		handoff: recoveryBindingCompleted.state.handoff === null
			? null
			: {
				...recoveryBindingCompleted.state.handoff,
				recoveryOperationEpoch: 2,
				intentState: {
					kind: "escape-pending",
					intentId: "intent:held",
					action: terminalEscape.action,
				},
				phase: "awaiting-recovery-decision",
			},
	};
	const terminal = reduceManagedLeafSession(escapePendingState, {
		type: "intent-state-changed",
		sessionId: escapePendingState.sessionId,
		expectedGeneration: escapePendingState.generation,
		recoveryOperationEpoch: 2,
		intentState: terminalEscape.intentState,
	});
	assert.equal(terminal.accepted, true, `${terminalEscape.action}: terminal accepted`);
	assert.equal(terminal.state.handoff, null, `${terminalEscape.action}: handoff cleared`);
	assert.equal(
		terminal.state.currentSwitchIntentSeq,
		null,
		`${terminalEscape.action}: switch cleared`,
	);
	assert.equal(
		terminal.state.binding,
		recoveryBindingCompleted.state.binding,
		`${terminalEscape.action}: binding preserved`,
	);
	assert.deepEqual(terminal.state.activeRecoveries, []);
	assert.deepEqual(
		terminal.effects.map((effect) => effect.type),
		["release-input-gate"],
		`${terminalEscape.action}: gate released exactly once`,
	);
}

const heldReview = reduceManagedLeafSession(heldStored.state, {
	type: "intent-state-changed",
	sessionId: heldStored.state.sessionId,
	expectedGeneration: 1,
	recoveryOperationEpoch: 1,
	intentState: { kind: "needs-review", intentId: "intent:held", recordId: "record-held" },
});
assert.equal(heldReview.accepted, true);
assert.equal(heldReview.state.handoff?.inputGateInstalled, false);
assert.equal(
	heldReview.state.handoff?.phase,
	"target-ready",
	"a target-proven manual row releases binding admission as well as editor input",
);
assert.deepEqual(heldReview.effects.map((effect) => effect.type), ["release-input-gate"]);

for (const reason of ["closed", "deleted", "excluded", "teardown", "unsupported-host"] as const) {
	const cancelBase = reduceManagedLeafSession(createBoundSession(), {
		type: "target-selected",
		sessionId: "boot-a",
		expectedGeneration: 0,
		targetFile: fakeFile(`cancel-${reason}.md`),
		switchIntentSeq: 1,
		sourceUnloadReceiptId: "source-unload:test",
	});
	assert.equal(cancelBase.accepted, true);
	const cancelled = reduceManagedLeafSession(cancelBase.state, {
		type: "cancelled",
		sessionId: cancelBase.state.sessionId,
		expectedGeneration: 1,
		reason,
	});
	assert.equal(cancelled.accepted, true, `${reason}: accepted`);
	assert.equal(cancelled.state.generation, 2, `${reason}: advances generation`);
	assert.equal(cancelled.state.eventOrderSeq, 1, `${reason}: preserves native event order`);
	assert.equal(cancelled.state.currentSwitchIntentSeq, 1, `${reason}: retains switch sequence`);
	assert.equal(cancelled.state.displayedLineage, cancelBase.state.displayedLineage);
	assert.deepEqual(cancelled.state.binding, { kind: "unbound" });
	assert.equal(cancelled.state.handoff, null);
	assert.deepEqual(
		cancelled.effects.map((effect) => effect.type),
		["detach-binding", "release-input-gate", "restore-save-pass-through"],
	);
	for (const effect of cancelled.effects) {
		assert.equal(effect.sessionId, "boot-a");
		assert.equal(effect.expectedGeneration, 2);
	}
	assertRejectedSame(cancelled.state, {
		type: "cancelled",
		sessionId: cancelled.state.sessionId,
		expectedGeneration: 2,
		reason,
	}, `${reason}: duplicate cancellation`);
	assertRejectedSame(cancelled.state, {
		type: "detach-completed",
		sessionId: cancelled.state.sessionId,
		expectedGeneration: 1,
		bindingEpochAfterDetach: 9,
	}, `${reason}: stale completion after cancellation`);
}

const cancelledAfterDetach = reduceManagedLeafSession(detached.state, {
	type: "cancelled",
	sessionId: detached.state.sessionId,
	expectedGeneration: 1,
	reason: "teardown",
});
assert.equal(cancelledAfterDetach.accepted, true);
assert.deepEqual(
	cancelledAfterDetach.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

const reservedBeforeCancellation = reserveInput(started.state, 10);
const cancelledWithReservation = reduceManagedLeafSession(reservedBeforeCancellation.state, {
	type: "cancelled",
	sessionId: reservedBeforeCancellation.state.sessionId,
	expectedGeneration: 1,
	reason: "closed",
});
assert.equal(cancelledWithReservation.accepted, true);
assert.equal(cancelledWithReservation.state.pendingInputStartReservation, null);

const settledCancellation = reduceManagedLeafSession(presented.state, {
	type: "cancelled",
	sessionId: presented.state.sessionId,
	expectedGeneration: 1,
	reason: "closed",
});
assert.equal(settledCancellation.accepted, true);
assert.equal(settledCancellation.state.handoff, null);
assert.deepEqual(settledCancellation.effects, []);

assertRejectedSame(renamed.state, {
	type: "cancelled",
	sessionId: renamed.state.sessionId,
	expectedGeneration: 1,
	reason: "unsupported-host",
}, "rename-only session has no handoff to cancel");

console.log("editor handoff state regressions passed");
