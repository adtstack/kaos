import assert from "node:assert/strict";
import type {
	EditorSelection,
	EditorState,
	Text,
	Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView, TFile, TextFileView } from "obsidian";
import type * as Y from "yjs";
import {
	createManagedLeafSession,
	reduceManagedLeafSession,
	reserveManagedLeafInputStart,
	type EditorHandoffEvent,
	type HostLoadCompletionReceipt,
	type ManagedLeafSession,
	type PendingHostLoadCandidate,
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

function fakeSelection(name: string): EditorSelection {
	return { name } as unknown as EditorSelection;
}

function setDocument(cm: EditorView, document: Text): void {
	(cm as unknown as { state: { doc: Text } }).state = { doc: document };
}

function createBoundSession(sessionId = "boot-a"): ManagedLeafSession {
	const file = fakeFile("A.md");
	const document = fakeText("content:A.md");
	const cm = {
		name: "cm:A.md",
		state: { doc: document },
	} as unknown as EditorView;
	return createManagedLeafSession({
		sessionId,
		leafId: "leaf-a",
		view: { file } as unknown as MarkdownView,
		nativeHistoryEpoch: 3,
		displayedLineage: {
			kind: "known",
			file,
			path: file.path,
			fileId: "file-a",
			cm,
			document,
			editorRevision: 7,
		},
		binding: {
			kind: "bound",
			path: file.path,
			fileId: "file-a",
			ytext: { name: "ytext:A.md" } as unknown as Y.Text,
		},
	});
}

function reserveInput(
	state: ManagedLeafSession,
	inputEpoch: number,
	compositionEpoch: number | null,
): ReturnType<typeof reserveManagedLeafInputStart> {
	const reduction = reserveManagedLeafInputStart(state, {
		sessionId: state.sessionId,
		expectedGeneration: state.generation,
		inputEpoch,
		compositionEpoch,
	});
	assert.equal(reduction.accepted, true);
	assert.notEqual(reduction.state.pendingInputStartReservation, null);
	return reduction;
}

function selectEvent(
	state: ManagedLeafSession,
	targetFile: TFile,
	sourceUnloadReceiptId: string,
): Extract<EditorHandoffEvent, { type: "target-selected" }> {
	return {
		type: "target-selected",
		sessionId: state.sessionId,
		expectedGeneration: state.generation,
		targetFile,
		switchIntentSeq: state.eventOrderSeq + 1,
		sourceUnloadReceiptId,
	};
}

function assertRejectedSame(
	state: ManagedLeafSession,
	event: EditorHandoffEvent,
	label: string,
): void {
	const reduction = reduceManagedLeafSession(state, event);
	assert.equal(reduction.accepted, false, label + ": rejected");
	assert.equal(reduction.state, state, label + ": exact state retained");
	assert.deepEqual(reduction.effects, [], label + ": no effects");
}

function makeCandidate(
	state: ManagedLeafSession,
	overrides: Partial<PendingHostLoadCandidate> = {},
): PendingHostLoadCandidate {
	const handoff = state.handoff;
	assert.notEqual(handoff, null);
	const targetDocument = fakeText("content:" + handoff?.targetPath);
	const cm = {
		name: "cm:" + handoff?.targetPath,
		state: { doc: targetDocument },
	} as unknown as EditorView;
	return {
		hostLoadTokenId: "host-load:" + handoff?.targetPath,
		hostLoadCompletedEpoch: null,
		sourceUnloadReceiptId: handoff?.sourceUnloadReceiptId ?? "",
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		targetPathAtDispatch: handoff?.targetPath ?? "",
		cm,
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
			: 0,
		nativeHistoryEpochBefore: state.nativeHistoryEpoch,
		proposedSelection: fakeSelection("target-selection"),
		proposedScrollAnchor: 23,
		effectFingerprint: "host-effect:" + handoff?.targetPath,
		runtimeViewDataBefore: state.displayedLineage.kind === "known"
			? state.displayedLineage.document.toString()
			: "",
		bindingEpoch: handoff?.bindingEpochAfterDetach ?? -1,
		...overrides,
	} as PendingHostLoadCandidate;
}

function makeHostReceipt(
	state: ManagedLeafSession,
	candidate: PendingHostLoadCandidate,
	overrides: Partial<HostLoadCompletionReceipt> = {},
): HostLoadCompletionReceipt {
	const handoff = state.handoff;
	assert.notEqual(handoff, null);
	return {
		receiptId: "host-receipt:" + handoff?.targetPath,
		hostLoadTokenId: candidate.hostLoadTokenId,
		switchIntentSeq: state.currentSwitchIntentSeq ?? -1,
		sessionId: state.sessionId,
		leafId: state.leafId,
		handoffGeneration: state.generation,
		targetPath: handoff?.targetPath ?? "",
		nativeHistoryEpoch: state.nativeHistoryEpoch + 1,
		historyResetObserved: true,
		targetSelection: candidate.proposedSelection,
		targetSelectionEpoch: 11,
		targetScrollAnchor: candidate.proposedScrollAnchor,
		targetScrollEpoch: 12,
		effectFingerprint: candidate.effectFingerprint,
		...overrides,
	};
}

const managed = createBoundSession();
assert.equal(managed.generation, 0);
assert.equal(managed.eventOrderSeq, 0);
assert.equal(managed.currentSwitchIntentSeq, null);
assert.equal(managed.handoff, null);
assert.equal(managed.pendingInputStartReservation, null);
assert.equal("activeRecoveries" in managed, false);

const staleReservation = reserveManagedLeafInputStart(managed, {
	sessionId: "stale-session",
	expectedGeneration: managed.generation,
	inputEpoch: 1,
	compositionEpoch: null,
});
assert.equal(staleReservation.accepted, false);
assert.equal(staleReservation.state, managed);

// Ordinary input owns the transition boundary. Selected and observed targets are
// inert until the exact same-path transaction has settled.
const ordinaryStart = reserveInput(managed, 10, null);
const ordinaryReservation = ordinaryStart.state.pendingInputStartReservation!;
const fileB = fakeFile("B.md");
const selectBWhileOrdinary = selectEvent(
	ordinaryStart.state,
	fileB,
	"source-unload:ordinary",
);
assertRejectedSame(
	ordinaryStart.state,
	selectBWhileOrdinary,
	"selected B while ordinary input is live",
);
assertRejectedSame(ordinaryStart.state, {
	type: "target-observed",
	sessionId: ordinaryStart.state.sessionId,
	expectedGeneration: ordinaryStart.state.generation,
	targetFile: fileB,
}, "observed B while ordinary input is live");
assert.equal(ordinaryStart.state.generation, managed.generation);
assert.equal(ordinaryStart.state.handoff, null);

const ordinaryCm = ordinaryStart.state.displayedLineage.kind === "known"
	? ordinaryStart.state.displayedLineage.cm
	: null;
assert.notEqual(ordinaryCm, null);
const ordinaryFinal = fakeText("content:A.md+x");
setDocument(ordinaryCm!, ordinaryFinal);
const ordinaryCompleted = reduceManagedLeafSession(ordinaryStart.state, {
	type: "same-path-input-completed",
	sessionId: ordinaryStart.state.sessionId,
	expectedGeneration: ordinaryStart.state.generation,
	reservation: ordinaryReservation,
	cm: ordinaryCm!,
	startDocument: ordinaryReservation.sourceDocumentAtStart!,
	finalDocument: ordinaryFinal,
	editorRevision: 8,
	samePathDispatch: {
		batchStartDocument: ordinaryReservation.sourceDocumentAtStart!,
		nativeHistoryEpochBefore: ordinaryStart.state.nativeHistoryEpoch,
		nativeHistoryEpochAfter: ordinaryStart.state.nativeHistoryEpoch + 1,
	},
});
assert.equal(ordinaryCompleted.accepted, true);
assert.equal(ordinaryCompleted.state.pendingInputStartReservation, null);
assert.equal(ordinaryCompleted.state.completedSamePathInput, null);
assert.equal(ordinaryCompleted.state.nativeHistoryEpoch, 4);
assert.equal(
	ordinaryCompleted.state.displayedLineage.kind === "known"
		? ordinaryCompleted.state.displayedLineage.document
		: null,
	ordinaryFinal,
);
assert.deepEqual(ordinaryCompleted.effects, []);

const selectedAfterOrdinary = reduceManagedLeafSession(
	ordinaryCompleted.state,
	selectBWhileOrdinary,
);
assert.equal(selectedAfterOrdinary.accepted, true);
assert.equal(
	selectedAfterOrdinary.state.generation,
	ordinaryCompleted.state.generation + 1,
);
assert.equal(selectedAfterOrdinary.state.handoff?.targetFile, fileB);
assert.deepEqual(
	selectedAfterOrdinary.effects.map((effect) => effect.type),
	[
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"capture-authority-before-detach",
		"detach-binding",
	],
);

// Exact cancellation retires only the reservation. The same target transition
// is then admitted without a persistence or replay effect.
const cancelledBase = createBoundSession("boot-cancelled-input");
const cancelledStart = reserveInput(cancelledBase, 11, null);
const cancelledReservation = cancelledStart.state.pendingInputStartReservation!;
const cancelledCm = cancelledStart.state.displayedLineage.kind === "known"
	? cancelledStart.state.displayedLineage.cm
	: null;
assert.notEqual(cancelledCm, null);
const selectAfterCancellation = selectEvent(
	cancelledStart.state,
	fakeFile("B-after-cancel.md"),
	"source-unload:cancelled-input",
);
assertRejectedSame(
	cancelledStart.state,
	selectAfterCancellation,
	"selected target before cancellation settles",
);
const inputCancelled = reduceManagedLeafSession(cancelledStart.state, {
	type: "same-path-input-rejected",
	sessionId: cancelledStart.state.sessionId,
	expectedGeneration: cancelledStart.state.generation,
	reservation: cancelledReservation,
	cm: cancelledCm!,
	startDocument: cancelledReservation.sourceDocumentAtStart!,
	reason: "cancelled",
});
assert.equal(inputCancelled.accepted, true);
assert.equal(inputCancelled.state.pendingInputStartReservation, null);
assert.deepEqual(inputCancelled.effects, []);
assert.equal(
	reduceManagedLeafSession(inputCancelled.state, selectAfterCancellation).accepted,
	true,
);

// An ambiguous visible A result is retained in the lineage for the manager's
// manual export/reopen terminal. The reducer creates no replay or persistence.
const ambiguousBase = createBoundSession("boot-ambiguous-input");
const ambiguousStart = reserveInput(ambiguousBase, 12, null);
const ambiguousReservation = ambiguousStart.state.pendingInputStartReservation!;
const ambiguousCm = ambiguousStart.state.displayedLineage.kind === "known"
	? ambiguousStart.state.displayedLineage.cm
	: null;
assert.notEqual(ambiguousCm, null);
const ambiguousFinal = fakeText("content:A.md+ambiguous");
setDocument(ambiguousCm!, ambiguousFinal);
const ambiguous = reduceManagedLeafSession(ambiguousStart.state, {
	type: "same-path-input-rejected",
	sessionId: ambiguousStart.state.sessionId,
	expectedGeneration: ambiguousStart.state.generation,
	reservation: ambiguousReservation,
	cm: ambiguousCm!,
	startDocument: ambiguousReservation.sourceDocumentAtStart!,
	reason: "input-result-ambiguous",
	finalDocument: ambiguousFinal,
	editorRevision: 8,
	samePathDispatch: {
		batchStartDocument: ambiguousReservation.sourceDocumentAtStart!,
		nativeHistoryEpochBefore: ambiguousStart.state.nativeHistoryEpoch,
		nativeHistoryEpochAfter: ambiguousStart.state.nativeHistoryEpoch + 2,
	},
});
assert.equal(ambiguous.accepted, true);
assert.equal(ambiguous.state.pendingInputStartReservation, null);
assert.equal(ambiguous.state.handoff, null);
assert.equal(ambiguous.state.nativeHistoryEpoch, 5);
assert.deepEqual(ambiguous.effects, []);
assert.equal("activeRecoveries" in ambiguous.state, false);

// An exact IME completion follows the same transition boundary and retains only
// the one-shot pre-clear receipt needed by the native host load.
const imeBase = createBoundSession("boot-ime");
const imeStart = reserveInput(imeBase, 13, 4);
const imeReservation = imeStart.state.pendingInputStartReservation!;
const imeCm = imeStart.state.displayedLineage.kind === "known"
	? imeStart.state.displayedLineage.cm
	: null;
assert.notEqual(imeCm, null);
const imeTarget = fakeFile("B-after-ime.md");
const selectAfterIme = selectEvent(
	imeStart.state,
	imeTarget,
	"source-unload:ime",
);
assertRejectedSame(imeStart.state, selectAfterIme, "selected B while IME is live");
const imeFinal = fakeText("content:A.md+IME");
setDocument(imeCm!, imeFinal);
const imeSettledState: ManagedLeafSession = {
	...imeStart.state,
	displayedLineage: imeStart.state.displayedLineage.kind === "known"
		? {
			...imeStart.state.displayedLineage,
			document: imeFinal,
			editorRevision: 8,
		}
		: imeStart.state.displayedLineage,
};
const imeCompleted = reduceManagedLeafSession(imeSettledState, {
	type: "same-path-input-completed",
	sessionId: imeSettledState.sessionId,
	expectedGeneration: imeSettledState.generation,
	reservation: imeReservation,
	cm: imeCm!,
	startDocument: imeReservation.sourceDocumentAtStart!,
	finalDocument: imeFinal,
	editorRevision: 8,
});
assert.equal(imeCompleted.accepted, true);
assert.equal(imeCompleted.state.pendingInputStartReservation, null);
assert.equal(imeCompleted.state.completedSamePathInput?.reservation, imeReservation);
assert.deepEqual(imeCompleted.effects, []);

const selectedImeTarget = reduceManagedLeafSession(
	imeCompleted.state,
	selectAfterIme,
);
assert.equal(selectedImeTarget.accepted, true);
assert.equal(
	selectedImeTarget.state.completedSamePathInput,
	imeCompleted.state.completedSamePathInput,
);
const detachedImeTarget = reduceManagedLeafSession(selectedImeTarget.state, {
	type: "detach-completed",
	sessionId: selectedImeTarget.state.sessionId,
	expectedGeneration: selectedImeTarget.state.generation,
	bindingEpochAfterDetach: 9,
});
assert.equal(detachedImeTarget.accepted, true);
assert.deepEqual(detachedImeTarget.effects, []);

// The native pre-clear path accepts only the exact settled A receipt and then
// commits B locally. There is no controller presentation request in either step.
const preclearDocument = fakeText("");
setDocument(imeCm!, preclearDocument);
const preclearTargetDocument = fakeText("content:B-after-ime.md");
const preclearTargetState = {
	doc: preclearTargetDocument,
	selection: fakeSelection("preclear-selection"),
} as unknown as EditorState;
const preclearCandidate = makeCandidate(detachedImeTarget.state, {
	cm: imeCm!,
	startDocument: preclearDocument,
	targetDocument: preclearTargetDocument,
	incomingContent: preclearTargetDocument.toString(),
	applicationKind: "state",
	heldTransaction: null,
	heldState: preclearTargetState,
	editorRevisionBefore: 8,
	nativeHistoryEpochBefore: detachedImeTarget.state.nativeHistoryEpoch,
	proposedSelection: preclearTargetState.selection,
	proposedScrollAnchor: null,
});
const preclearHeld = reduceManagedLeafSession(detachedImeTarget.state, {
	type: "host-preclear-candidate-held",
	sessionId: detachedImeTarget.state.sessionId,
	expectedGeneration: detachedImeTarget.state.generation,
	candidate: preclearCandidate,
	completion: detachedImeTarget.state.completedSamePathInput!,
	observedNativeHistoryEpoch: preclearCandidate.nativeHistoryEpochBefore,
	sourceUnload: {
		receiptId: "source-unload:ime",
		file: imeReservation.sourceFileAtStart!,
		path: "A.md",
		state: "settled",
		forcedSaveObserved: true,
	},
});
assert.equal(preclearHeld.accepted, true);
assert.equal(preclearHeld.state.handoff?.presentation, "target-candidate");
assert.deepEqual(preclearHeld.effects, []);
setDocument(imeCm!, preclearTargetDocument);
const preclearReceipt = makeHostReceipt(preclearHeld.state, preclearCandidate);
const preclearPresented = reduceManagedLeafSession(preclearHeld.state, {
	type: "target-locally-presented",
	sessionId: preclearHeld.state.sessionId,
	expectedGeneration: preclearHeld.state.generation,
	receipt: preclearReceipt,
	targetFileId: null,
});
assert.equal(preclearPresented.accepted, true);
assert.equal(preclearPresented.state.handoff, null);
assert.equal(
	preclearPresented.state.displayedLineage.kind === "known"
		? preclearPresented.state.displayedLineage.document
		: null,
	preclearTargetDocument,
);
assert.deepEqual(
	preclearPresented.effects.map((effect) => effect.type),
	["release-input-gate", "restore-save-pass-through"],
);

// The ordinary native B path is candidate -> local presentation, with no
// controller plan, recovery state, persistence, or replay.
const nativeBase = createBoundSession("boot-native-b");
const nativeTarget = fakeFile("B-native.md");
const nativeSelected = reduceManagedLeafSession(
	nativeBase,
	selectEvent(nativeBase, nativeTarget, "source-unload:native-b"),
);
assert.equal(nativeSelected.accepted, true);
const nativeDetached = reduceManagedLeafSession(nativeSelected.state, {
	type: "detach-completed",
	sessionId: nativeSelected.state.sessionId,
	expectedGeneration: nativeSelected.state.generation,
	bindingEpochAfterDetach: 8,
});
assert.equal(nativeDetached.accepted, true);
assert.deepEqual(nativeDetached.effects, []);
const nativeCandidate = makeCandidate(nativeDetached.state);
const nativeHeld = reduceManagedLeafSession(nativeDetached.state, {
	type: "host-candidate-held",
	sessionId: nativeDetached.state.sessionId,
	expectedGeneration: nativeDetached.state.generation,
	candidate: nativeCandidate,
});
assert.equal(nativeHeld.accepted, true);
assert.equal(nativeHeld.state.handoff?.presentation, "target-candidate");
assert.deepEqual(nativeHeld.effects, []);
const nativeReceipt = makeHostReceipt(nativeHeld.state, nativeCandidate);
const nativePresented = reduceManagedLeafSession(nativeHeld.state, {
	type: "target-locally-presented",
	sessionId: nativeHeld.state.sessionId,
	expectedGeneration: nativeHeld.state.generation,
	receipt: nativeReceipt,
	targetFileId: "file-b",
});
assert.equal(nativePresented.accepted, true);
assert.equal(nativePresented.state.handoff, null);
assert.equal(nativePresented.state.currentSwitchIntentSeq, null);
assert.deepEqual(nativePresented.state.binding, { kind: "unbound" });
assert.equal(nativePresented.state.displayedLineage.kind, "known");
if (nativePresented.state.displayedLineage.kind === "known") {
	assert.equal(nativePresented.state.displayedLineage.file, nativeTarget);
	assert.equal(nativePresented.state.displayedLineage.path, nativeTarget.path);
	assert.equal(nativePresented.state.displayedLineage.fileId, "file-b");
	assert.equal(nativePresented.state.displayedLineage.document, nativeCandidate.cm.state.doc);
}
assertRejectedSame(nativePresented.state, {
	type: "target-locally-presented",
	sessionId: nativePresented.state.sessionId,
	expectedGeneration: nativePresented.state.generation,
	receipt: nativeReceipt,
	targetFileId: "file-b",
}, "duplicate local B receipt");

// An unresolved B never owns the displayed lineage. B -> C supersession retains
// A as source, rejects late B candidates, and creates no recovery state.
const supersedeBase = createBoundSession("boot-supersede");
const supersedeB = reduceManagedLeafSession(
	supersedeBase,
	selectEvent(supersedeBase, fakeFile("B-unresolved.md"), "source-unload:b"),
);
const supersedeBDetached = reduceManagedLeafSession(supersedeB.state, {
	type: "detach-completed",
	sessionId: supersedeB.state.sessionId,
	expectedGeneration: supersedeB.state.generation,
	bindingEpochAfterDetach: 8,
});
const staleBCandidate = makeCandidate(supersedeBDetached.state);
const supersedeCFile = fakeFile("C-latest.md");
const supersedeC = reduceManagedLeafSession(
	supersedeBDetached.state,
	selectEvent(supersedeBDetached.state, supersedeCFile, "source-unload:c"),
);
assert.equal(supersedeC.accepted, true);
assert.equal(supersedeC.state.handoff?.targetFile, supersedeCFile);
assert.equal(supersedeC.state.handoff?.sourceAuthorityPath, "A.md");
assert.equal("activeRecoveries" in supersedeC.state, false);
assertRejectedSame(supersedeC.state, {
	type: "host-candidate-held",
	sessionId: supersedeC.state.sessionId,
	expectedGeneration: supersedeC.state.generation,
	candidate: staleBCandidate,
}, "late B candidate after C supersession");

// Closing an unresolved transition releases both fences and detaches exactly
// once when the old binding still exists.
const closeBase = createBoundSession("boot-close");
const closeSelected = reduceManagedLeafSession(
	closeBase,
	selectEvent(closeBase, fakeFile("B-close.md"), "source-unload:close"),
);
const closed = reduceManagedLeafSession(closeSelected.state, {
	type: "cancelled",
	sessionId: closeSelected.state.sessionId,
	expectedGeneration: closeSelected.state.generation,
	reason: "closed",
});
assert.equal(closed.accepted, true);
assert.equal(closed.state.handoff, null);
assert.equal(closed.state.generation, closeSelected.state.generation + 1);
assert.deepEqual(
	closed.effects.map((effect) => effect.type),
	["detach-binding", "release-input-gate", "restore-save-pass-through"],
);

console.log("editor handoff state regressions passed");
