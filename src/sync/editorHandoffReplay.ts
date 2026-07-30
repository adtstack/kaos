import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFile } from "obsidian";
import type * as Y from "yjs";
import type {
	HandoffInputIntent,
	HandoffReplayPlan,
	TargetReadyToken,
} from "./editorHandoffState";
import {
	canonicalHandoffRecoveryJson,
	HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION,
	HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION,
	sha256HandoffRecoveryHex,
	type ActiveHandoffRecoveryRecord,
	type HandoffRecoveryApplyWitness,
} from "./handoffRecoveryStore";

export type HandoffCompositionProof = Readonly<{
	compositionEpoch: number;
	startedUnderSwitchSeq: number;
	firstInputSeq: number;
	lastInputSeq: number;
	endSeq: number;
	completed: boolean;
	gapFree: boolean;
	finalSuccessorObserved: boolean;
}>;

export type HandoffReplayTargetSnapshot = Readonly<{
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	recoveryOperationEpoch: number;
	targetReadyTokenId: string;
	hostLoadTokenId: string;
	hostLoadReceiptId: string;
	targetPath: string;
	targetFile: TFile;
	targetFileId: string;
	cm: EditorView;
	ytext: Y.Text;
	ytextIdentity: string;
	ytextMutationEpoch: number;
	bindingEpoch: number;
	editorRevision: number;
	nativeHistoryEpoch: number;
	selectionEpoch: number;
	scrollEpoch: number;
	selection: EditorSelection;
	scrollAnchor: number | null;
	cmDocument: Text;
	editorFacadeContent: string;
	runtimeCacheContent: string;
	ytextContent: string;
}>;

export type VerifiedFreshStoredHandoffClaim = Readonly<{
	requestIntent: HandoffInputIntent;
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
	changes: ChangeSet;
	selectionBefore: EditorSelection;
	selectionAfter: EditorSelection;
}>;

export type HandoffReplayPermit = Readonly<{
	permitId: string;
	planId: string;
	recordId: string;
	replayPendingChecksum: string;
	recoveryOperationEpoch: number;
	expectedSnapshotFingerprint: string;
}>;

export type RedeemExactHandoffReplayDispatchPermitResult =
	| Readonly<{
		kind: "accepted";
		snapshot: HandoffReplayTargetSnapshot;
		plan: HandoffReplayPlan;
		record: ActiveHandoffRecoveryRecord & Readonly<{
			status: "replay-pending";
		}>;
	}>
	| Readonly<{
		kind: "rejected";
		reason: "permit-mismatch" | "plan-already-consumed";
	}>;

export type HandoffReplaySettlementSnapshot = Readonly<{
	planId: string | null;
	sessionId: string;
	leafId: string;
	handoffGeneration: number;
	recoveryOperationEpoch: number;
	targetReadyTokenId: string;
	hostLoadTokenId: string;
	hostLoadReceiptId: string;
	targetPath: string;
	targetFile: TFile;
	targetFileId: string;
	cm: EditorView;
	ytext: Y.Text;
	ytextIdentity: string;
	ytextMutationEpoch: number;
	bindingEpoch: number;
	editorRevision: number;
	nativeHistoryEpoch: number;
	selectionEpoch: number;
	scrollEpoch: number;
	selection: EditorSelection;
	scrollAnchor: number | null;
	cmDocument: Text;
	editorFacadeContent: string;
	runtimeCacheContent: string;
	ytextContent: string;
}>;

export function isExactHandoffReplayScrollDispatchPostcondition(input: Readonly<{
	beforeEpoch: number;
	afterEpoch: number;
	mappedAnchor: number | null;
	observedAnchor: number | null;
}>): boolean {
	if (
		!Number.isSafeInteger(input.beforeEpoch)
		|| input.beforeEpoch < 0
		|| input.beforeEpoch >= Number.MAX_SAFE_INTEGER
		|| !Number.isSafeInteger(input.afterEpoch)
		|| input.afterEpoch < input.beforeEpoch
		|| input.afterEpoch > input.beforeEpoch + 1
	) return false;
	if (input.mappedAnchor === null) {
		return input.observedAnchor === null
			&& input.afterEpoch === input.beforeEpoch;
	}
	return Number.isSafeInteger(input.mappedAnchor)
		&& input.mappedAnchor >= 0
		&& input.observedAnchor === input.mappedAnchor;
}

export type HandoffReplayDispatchReceipt = Readonly<{
	receiptSchemaVersion: 1;
	planId: string;
	intentId: string;
	recordId: string;
	sessionId: string;
	handoffGeneration: number;
	recoveryOperationEpoch: number;
	switchIntentSeq: number;
	targetReadyTokenId: string;
	hostLoadTokenId: string;
	hostLoadReceiptId: string;
	targetPath: string;
	targetFileId: string;
	targetYtextIdentity: string;
	targetMutationEpochAtPlan: number;
	targetMutationEpochAfter: number;
	bindingEpochAfter: number;
	editorRevisionAfter: number;
	nativeHistoryEpochAfter: number;
	selectionEpochBefore: number;
	selectionEpochAfter: number;
	scrollEpochBefore: number;
	scrollEpochAfter: number;
	plannedStartHash: string;
	plannedResultHash: string;
	serializedMappedSelection: string;
	mappedScrollAnchor: number | null;
	appliedAt: number;
}>;

export type CreateExactHandoffReplayDispatchReceiptRequest = Readonly<{
	plan: HandoffReplayPlan;
	record: ActiveHandoffRecoveryRecord & Readonly<{
		status: "replay-pending";
	}>;
	recoveryOperationEpoch: number;
	postcondition: HandoffReplayDispatchPostcondition;
	appliedAt: number;
}>;

export type ObserveExactHandoffReplaySettlementRequest = Readonly<{
	record: ActiveHandoffRecoveryRecord & Readonly<{
		status: "replayed-awaiting-settlement";
	}>;
	mode: "live" | "hydrated";
	receipt: HandoffReplayDispatchReceipt | null;
}>;

export type ObserveExactHandoffReplaySettlementResult =
	| Readonly<{ kind: "settled" }>
	| Readonly<{
		kind: "pending";
		reason: "disk-not-yet-saved" | "disk-unstable";
	}>
	| Readonly<{
		kind: "uncertain";
		reason:
			| "witness-invalid"
			| "receipt-required"
			| "receipt-hash-mismatch"
			| "snapshot-unavailable"
			| "plan-identity-mismatch"
			| "target-identity-mismatch"
			| "ytext-epoch-mismatch"
			| "history-mismatch"
			| "selection-mismatch"
			| "scroll-mismatch"
			| "editor-content-mismatch"
			| "ytext-content-mismatch"
			| "disk-missing"
			| "disk-content-mismatch";
	}>;

export type HandoffReplayNotAppliedReason =
	| "permit-mismatch"
	| "plan-mismatch"
	| "plan-already-consumed"
	| "record-mismatch"
	| "recovery-operation-stale"
	| "recovery-state-stale"
	| "session-stale"
	| "generation-stale"
	| "target-token-stale"
	| "target-file-stale"
	| "binding-stale"
	| "editor-stale"
	| "document-stale"
	| "editor-facade-stale"
	| "runtime-cache-stale"
	| "ytext-stale"
	| "native-history-stale"
	| "selection-stale"
	| "scroll-stale"
	| "scroll-effect-unmappable"
	| "dispatch-rejected";

export type HandoffReplayUncertainReason =
	| "dispatch-threw-after-mutation"
	| "post-target-identity-mismatch"
	| "post-document-mismatch"
	| "post-editor-facade-mismatch"
	| "post-runtime-cache-mismatch"
	| "post-ytext-mismatch"
	| "post-native-history-mismatch"
	| "post-selection-mismatch"
	| "post-scroll-mismatch";

export type HandoffReplayDispatchPostcondition = Readonly<{
	planId: string;
	recordId: string;
	recoveryOperationEpoch: number;
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
}>;

export type HandoffReplayDispatchResult =
	| { kind: "applied"; postcondition: HandoffReplayDispatchPostcondition }
	| { kind: "not-applied"; reason: HandoffReplayNotAppliedReason }
	| { kind: "dispatched-uncertain"; reason: HandoffReplayUncertainReason };

export type HandoffReplayManualReason =
	| "record-not-stored"
	| "record-already-witnessed"
	| "persisted-intent-mismatch"
	| "stored-codec-invalid"
	| "stored-codec-noncanonical"
	| "stored-content-mismatch"
	| "stored-content-hash-mismatch"
	| "event-proof-version-mismatch"
	| "event-proof-mismatch"
	| "intent-envelope-hash-mismatch"
	| "unsupported-origin"
	| "unsupported-user-event"
	| "source-owned-input"
	| "switch-sequence-mismatch"
	| "user-composition-invalid"
	| "ime-composition-missing"
	| "ime-composition-mismatch"
	| "ime-composition-incomplete"
	| "ime-composition-spanning"
	| "ime-composition-gapped"
	| "ime-final-successor-unproven"
	| "target-authority-missing"
	| "target-file-identity-mismatch"
	| "target-base-mismatch"
	| "target-ytext-advanced"
	| "target-native-history-stale"
	| "target-selection-stale"
	| "target-scroll-stale";

export type HandoffReplayReplanReason =
	| "session-stale"
	| "leaf-stale"
	| "generation-stale"
	| "switch-intent-stale"
	| "target-path-stale"
	| "target-token-stale"
	| "host-load-stale"
	| "target-authority-stale";

export type VerifyFreshStoredHandoffClaimResult =
	| Readonly<{ kind: "claimed"; claim: VerifiedFreshStoredHandoffClaim }>
	| Readonly<{ kind: "manual"; reason: HandoffReplayManualReason }>
	| Readonly<{ kind: "replan"; reason: HandoffReplayReplanReason }>;

export type ExactHandoffReplayPlanIds = Readonly<{
	planId: string;
	replayPermitId: string;
}>;

export type ExactHandoffReplayPlanResult =
	| Readonly<{
		kind: "planned";
		plan: HandoffReplayPlan;
		applyWitness: HandoffRecoveryApplyWitness;
	}>
	| Readonly<{ kind: "manual"; reason: HandoffReplayManualReason }>
	| Readonly<{ kind: "replan"; reason: HandoffReplayReplanReason }>;

export type ExactHandoffReplayPlanRequest = Readonly<{
	sessionId: string;
	expectedGeneration: number;
	recoveryOperationEpoch: number;
	intent: HandoffInputIntent;
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
	targetReadyToken: TargetReadyToken;
	compositionProof: HandoffCompositionProof | null;
}>;

export type ConsumeExactHandoffReplayPermitRequest = Readonly<{
	plan: HandoffReplayPlan;
	record: ActiveHandoffRecoveryRecord & Readonly<{ status: "replay-pending" }>;
	recoveryOperationEpoch: number;
}>;

export type ConsumeExactHandoffReplayPermitResult =
	| Readonly<{ kind: "accepted"; permit: HandoffReplayPermit }>
	| Readonly<{
		kind: "rejected";
		reason:
			| "plan-unknown"
			| "plan-consumed"
			| "record-mismatch"
			| "recovery-state-stale"
			| "recovery-operation-stale"
			| "authority-stale"
			| "target-snapshot-stale";
	}>;

function manual(
	reason: HandoffReplayManualReason,
): Readonly<{ kind: "manual"; reason: HandoffReplayManualReason }> {
	return { kind: "manual", reason };
}

function replan(
	reason: HandoffReplayReplanReason,
): Readonly<{ kind: "replan"; reason: HandoffReplayReplanReason }> {
	return { kind: "replan", reason };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
	return canonicalHandoffRecoveryJson(left) === canonicalHandoffRecoveryJson(right);
}

function selectionIsWithin(
	selection: EditorSelection,
	documentLength: number,
): boolean {
	return selection.ranges.every((range) =>
		range.anchor >= 0
		&& range.anchor <= documentLength
		&& range.head >= 0
		&& range.head <= documentLength
	);
}

function isStoredRecord(
	record: ActiveHandoffRecoveryRecord,
): record is ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }> {
	return record.status === "stored";
}

export async function verifyFreshStoredHandoffClaim(
	requestIntent: HandoffInputIntent,
	record: ActiveHandoffRecoveryRecord,
	compositionProof: HandoffCompositionProof | null,
): Promise<VerifyFreshStoredHandoffClaimResult> {
	if (!isStoredRecord(record)) return manual("record-not-stored");
	if (record.applyWitness !== null) return manual("record-already-witnessed");

	if (
		record.intentId !== requestIntent.intentId
		|| record.fromPath !== requestIntent.fromPath
		|| record.targetPath !== requestIntent.targetPath
		|| record.originKind !== requestIntent.originKind
		|| record.sequenceBegan !== requestIntent.sequenceBegan
		|| record.startContentHash !== requestIntent.startContentHash
		|| record.afterContentHash !== requestIntent.afterContentHash
		|| record.capturedAt !== requestIntent.capturedAt
	) {
		return manual("persisted-intent-mismatch");
	}

	let changes: ChangeSet;
	let selectionBefore: EditorSelection;
	let selectionAfter: EditorSelection;
	let parsedChanges: unknown;
	let parsedSelectionBefore: unknown;
	let parsedSelectionAfter: unknown;
	try {
		parsedChanges = JSON.parse(record.body.serializedChanges);
		parsedSelectionBefore = JSON.parse(record.body.serializedSelectionBefore);
		parsedSelectionAfter = JSON.parse(record.body.serializedSelectionAfter);
		changes = ChangeSet.fromJSON(parsedChanges);
		selectionBefore = EditorSelection.fromJSON(parsedSelectionBefore);
		selectionAfter = EditorSelection.fromJSON(parsedSelectionAfter);
	} catch {
		return manual("stored-codec-invalid");
	}

	try {
		if (
			canonicalHandoffRecoveryJson(changes.toJSON())
				!== record.body.serializedChanges
			|| canonicalHandoffRecoveryJson(selectionBefore.toJSON())
				!== record.body.serializedSelectionBefore
			|| canonicalHandoffRecoveryJson(selectionAfter.toJSON())
				!== record.body.serializedSelectionAfter
		) {
			return manual("stored-codec-noncanonical");
		}
	} catch {
		return manual("stored-codec-invalid");
	}

	const startDocument = Text.of(record.body.startContent.split("\n"));
	let appliedContent: string;
	try {
		appliedContent = changes.apply(startDocument).toString();
	} catch {
		return manual("stored-codec-invalid");
	}
	if (
		record.body.startContent !== requestIntent.startDocument.toString()
		|| appliedContent !== record.body.afterContent
		|| record.body.afterContent !== requestIntent.afterContent
		|| !sameCanonicalValue(changes.toJSON(), requestIntent.changes.toJSON())
		|| !sameCanonicalValue(
			selectionBefore.toJSON(),
			requestIntent.selectionBefore.toJSON(),
		)
		|| !sameCanonicalValue(
			selectionAfter.toJSON(),
			requestIntent.selectionAfter.toJSON(),
		)
		|| !selectionIsWithin(selectionBefore, startDocument.length)
		|| !selectionIsWithin(selectionAfter, record.body.afterContent.length)
	) {
		return manual("stored-content-mismatch");
	}

	const [startContentHash, afterContentHash] = await Promise.all([
		sha256HandoffRecoveryHex(record.body.startContent),
		sha256HandoffRecoveryHex(record.body.afterContent),
	]);
	if (
		startContentHash !== record.startContentHash
		|| afterContentHash !== record.afterContentHash
	) {
		return manual("stored-content-hash-mismatch");
	}

	const eventProof = record.body.eventProof;
	if (
		eventProof.proofSchemaVersion !== HANDOFF_RECOVERY_PROOF_SCHEMA_VERSION
		|| eventProof.canonicalEncodingVersion
			!== HANDOFF_RECOVERY_CANONICAL_ENCODING_VERSION
	) {
		return manual("event-proof-version-mismatch");
	}
	if (
		eventProof.sessionId !== requestIntent.sessionId
		|| eventProof.leafId !== requestIntent.leafId
		|| eventProof.handoffGeneration !== requestIntent.handoffGeneration
		|| eventProof.bindingEpoch !== requestIntent.bindingEpoch
		|| eventProof.inputEpoch !== requestIntent.inputEpoch
		|| eventProof.switchIntentSeq !== requestIntent.switchIntentSeq
		|| eventProof.inputStartSeq !== requestIntent.inputStartSeq
		|| eventProof.inputStartedUnderSwitchSeq
			!== requestIntent.inputStartedUnderSwitchSeq
		|| eventProof.compositionEpoch !== requestIntent.compositionEpoch
		|| eventProof.selectionEpoch !== requestIntent.selectionEpoch
	) {
		return manual("event-proof-mismatch");
	}

	const envelope = {
		scope: record.scope,
		intentId: record.intentId,
		fromPath: record.fromPath,
		targetPath: record.targetPath,
		originKind: record.originKind,
		sequenceBegan: record.sequenceBegan,
		startContentHash: record.startContentHash,
		afterContentHash: record.afterContentHash,
		body: record.body,
		capturedAt: record.capturedAt,
	};
	const expectedEnvelopeHash = await sha256HandoffRecoveryHex(
		canonicalHandoffRecoveryJson(envelope),
	);
	if (expectedEnvelopeHash !== record.intentEnvelopeHash) {
		return manual("intent-envelope-hash-mismatch");
	}

	if (requestIntent.originKind === "editor-api") {
		return manual("unsupported-origin");
	}
	if (requestIntent.userEvent === "other") {
		return manual("unsupported-user-event");
	}
	if (requestIntent.sequenceBegan !== "after-target-selected") {
		return manual("source-owned-input");
	}
	if (
		requestIntent.inputStartedUnderSwitchSeq !== requestIntent.switchIntentSeq
		|| requestIntent.inputStartSeq <= requestIntent.switchIntentSeq
	) {
		return manual("switch-sequence-mismatch");
	}

	if (requestIntent.originKind === "user") {
		if (
			requestIntent.compositionEpoch !== null
			|| compositionProof !== null
		) {
			return manual("user-composition-invalid");
		}
	} else {
		if (requestIntent.compositionEpoch === null || compositionProof === null) {
			return manual("ime-composition-missing");
		}
		if (compositionProof.compositionEpoch !== requestIntent.compositionEpoch) {
			return manual("ime-composition-mismatch");
		}
		if (
			compositionProof.startedUnderSwitchSeq !== requestIntent.switchIntentSeq
			|| requestIntent.inputStartedUnderSwitchSeq
				!== compositionProof.startedUnderSwitchSeq
		) {
			return manual("ime-composition-spanning");
		}
		if (
			compositionProof.firstInputSeq !== requestIntent.inputStartSeq
			|| compositionProof.firstInputSeq <= requestIntent.switchIntentSeq
			|| compositionProof.lastInputSeq < compositionProof.firstInputSeq
			|| compositionProof.endSeq !== compositionProof.lastInputSeq + 1
		) {
			return manual("ime-composition-mismatch");
		}
		if (!compositionProof.completed) {
			return manual("ime-composition-incomplete");
		}
		if (!compositionProof.gapFree) {
			return manual("ime-composition-gapped");
		}
		if (!compositionProof.finalSuccessorObserved) {
			return manual("ime-final-successor-unproven");
		}
	}

	return {
		kind: "claimed",
		claim: {
			requestIntent,
			record,
			changes,
			selectionBefore,
			selectionAfter,
		},
	};
}

export function planExactHandoffReplay(
	claim: VerifiedFreshStoredHandoffClaim,
	token: TargetReadyToken,
	snapshot: HandoffReplayTargetSnapshot,
	ids: ExactHandoffReplayPlanIds,
): ExactHandoffReplayPlanResult {
	const intent = claim.requestIntent;
	if (token.sessionId !== intent.sessionId || snapshot.sessionId !== intent.sessionId) {
		return replan("session-stale");
	}
	if (token.leafId !== intent.leafId || snapshot.leafId !== intent.leafId) {
		return replan("leaf-stale");
	}
	if (
		token.handoffGeneration !== intent.handoffGeneration
		|| snapshot.handoffGeneration !== intent.handoffGeneration
	) {
		return replan("generation-stale");
	}
	if (token.switchIntentSeq !== intent.switchIntentSeq) {
		return replan("switch-intent-stale");
	}
	if (
		token.targetPath !== intent.targetPath
		|| snapshot.targetPath !== intent.targetPath
		|| claim.record.targetPath !== intent.targetPath
		|| intent.targetFile.path !== intent.targetPath
		|| token.targetFile.path !== token.targetPath
		|| snapshot.targetFile.path !== snapshot.targetPath
	) {
		return replan("target-path-stale");
	}
	if (snapshot.targetReadyTokenId !== token.tokenId) {
		return replan("target-token-stale");
	}
	if (
		intent.targetFile !== token.targetFile
		|| token.targetFile !== snapshot.targetFile
	) {
		return manual("target-file-identity-mismatch");
	}
	if (
		snapshot.hostLoadTokenId !== token.hostLoadTokenId
		|| snapshot.hostLoadReceiptId !== token.hostLoadReceiptId
	) {
		return replan("host-load-stale");
	}
	if (token.targetAuthority.kind !== "existing") {
		return manual("target-authority-missing");
	}
	if (
		snapshot.targetFileId !== token.targetAuthority.fileId
		|| snapshot.ytextIdentity !== token.targetAuthority.ytextIdentity
	) {
		return replan("target-authority-stale");
	}
	if (
		snapshot.ytextMutationEpoch !== token.targetAuthority.ytextMutationEpoch
	) {
		return manual("target-ytext-advanced");
	}

	const baseContent = claim.record.body.startContent;
	if (
		token.certifiedBaseHash !== claim.record.startContentHash
		|| token.certifiedBaseContent !== baseContent
		|| snapshot.cmDocument.toString() !== baseContent
		|| snapshot.editorFacadeContent !== baseContent
		|| snapshot.runtimeCacheContent !== baseContent
	) {
		return manual("target-base-mismatch");
	}
	if (snapshot.ytextContent !== baseContent) {
		return manual("target-ytext-advanced");
	}
	if (snapshot.nativeHistoryEpoch !== token.nativeHistoryEpoch) {
		return manual("target-native-history-stale");
	}
	if (snapshot.selectionEpoch !== token.targetSelectionEpoch) {
		return manual("target-selection-stale");
	}
	if (snapshot.scrollEpoch !== token.targetScrollEpoch) {
		return manual("target-scroll-stale");
	}

	let mappedScrollAnchor: number | null = null;
	if (snapshot.scrollAnchor !== null) {
		if (
			!Number.isSafeInteger(snapshot.scrollAnchor)
			|| snapshot.scrollAnchor < 0
			|| snapshot.scrollAnchor > snapshot.cmDocument.length
		) {
			return manual("target-scroll-stale");
		}
		try {
			mappedScrollAnchor = claim.changes.mapPos(snapshot.scrollAnchor, -1);
		} catch {
			return manual("target-scroll-stale");
		}
	}
	const mappedSelection = claim.selectionAfter;
	const plan: HandoffReplayPlan = Object.freeze({
		planId: ids.planId,
		intentId: claim.record.intentId,
		targetReadyTokenId: token.tokenId,
		authorityFreshnessHandleId: token.authorityFreshnessHandleId,
		replayPermitId: ids.replayPermitId,
		switchIntentSeq: token.switchIntentSeq,
		kind: "exact-replay",
		expectedTargetDocument: snapshot.cmDocument,
		expectedSelectionEpoch: snapshot.selectionEpoch,
		expectedNativeHistoryEpoch: snapshot.nativeHistoryEpoch,
		expectedTargetScrollEpoch: snapshot.scrollEpoch,
		replayChanges: claim.changes,
		mappedSelection,
		mappedScrollAnchor,
	});
	const applyWitness: HandoffRecoveryApplyWitness = Object.freeze({
		planId: plan.planId,
		kind: "exact-replay",
		switchIntentSeq: plan.switchIntentSeq,
		hostLoadTokenId: snapshot.hostLoadTokenId,
		targetFileId: snapshot.targetFileId,
		targetYtextIdentity: snapshot.ytextIdentity,
		targetMutationEpochAtPlan: snapshot.ytextMutationEpoch,
		nativeHistoryEpoch: snapshot.nativeHistoryEpoch,
		targetSelectionEpoch: snapshot.selectionEpoch,
		targetScrollEpoch: snapshot.scrollEpoch,
		plannedStartHash: claim.record.startContentHash,
		plannedResultContent: claim.record.body.afterContent,
		plannedResultHash: claim.record.afterContentHash,
		serializedMappedSelection: canonicalHandoffRecoveryJson(
			mappedSelection.toJSON(),
		),
		dispatchReceiptHash: null,
	});
	return Object.freeze({ kind: "planned", plan, applyWitness });
}
