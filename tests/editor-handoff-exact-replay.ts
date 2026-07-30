import {
	ChangeSet,
	EditorSelection,
	Text,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import {
	isExactHandoffReplayOwnedSaveStart,
	isExactHandoffReplayRuntimeCacheProjection,
	isExactHandoffReplayYTextTransaction,
} from "../src/sync/editorBinding";
import {
	isExactHandoffReplayScrollDispatchPostcondition,
	planExactHandoffReplay,
	verifyFreshStoredHandoffClaim,
	type HandoffCompositionProof,
	type HandoffReplayTargetSnapshot,
	type VerifiedFreshStoredHandoffClaim,
} from "../src/sync/editorHandoffReplay";
import type { ManagedViewSaveGuard } from "../src/sync/textFileViewHandoffGuard";
import type {
	HandoffInputIntent,
	TargetReadyToken,
} from "../src/sync/editorHandoffState";
import {
	canonicalHandoffRecoveryJson,
	type ActiveHandoffRecoveryRecord,
} from "../src/sync/handoffRecoveryStore";
import {
	makeFreshStoredReplayFixture,
	makeStoredReplayFixture,
	ReplayFixtureFile,
} from "./helpers/handoff-replay-fixture";

type StoredRecord = ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
type ReplayFixture = Readonly<{
	intent: HandoffInputIntent;
	record: StoredRecord;
}>;
type ExistingTargetReadyToken = TargetReadyToken & Readonly<{
	targetAuthority: Extract<TargetReadyToken["targetAuthority"], { kind: "existing" }>;
}>;
type ExistingTargetReadyTokenOverrides =
	& Partial<Omit<TargetReadyToken, "targetAuthority">>
	& Readonly<{
		targetAuthority?: ExistingTargetReadyToken["targetAuthority"];
	}>;

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`FAIL: ${message}`);
	passed += 1;
	console.log(`PASS: ${message}`);
}

function equal<T>(actual: T, expected: T, message: string): void {
	assert(Object.is(actual, expected), message);
}

function canonicalEqual(actual: unknown, expected: unknown, message: string): void {
	equal(
		canonicalHandoffRecoveryJson(actual),
		canonicalHandoffRecoveryJson(expected),
		message,
	);
}

function assertNoReplayPlan(
	result: Awaited<ReturnType<typeof verifyFreshStoredHandoffClaim>>
		| ReturnType<typeof planExactHandoffReplay>,
	message: string,
): void {
	assert(result.kind === "manual" || result.kind === "replan", message);
	assert(!("plan" in result), `${message}: no exact plan escapes`);
	assert(
		JSON.stringify(result).includes("strict-nonoverlap-rebase") === false,
		`${message}: no strict-rebase route escapes`,
	);
}

async function requireClaim(
	fixture: ReplayFixture,
	compositionProof: HandoffCompositionProof | null = null,
): Promise<VerifiedFreshStoredHandoffClaim> {
	const result = await verifyFreshStoredHandoffClaim(
		fixture.intent,
		fixture.record,
		compositionProof,
	);
	assert(result.kind === "claimed", "fixture produces a verified fresh stored claim");
	return result.claim;
}

function makeExistingToken(
	fixture: ReplayFixture,
	overrides: ExistingTargetReadyTokenOverrides = {},
): ExistingTargetReadyToken {
	const targetAuthority: ExistingTargetReadyToken["targetAuthority"] = {
		kind: "existing",
		fileId: "file-b",
		ytextIdentity: "ytext-b",
		ytextMutationEpoch: 0,
		bindPermitId: "bind-1",
	};
	const {
		targetAuthority: targetAuthorityOverride,
		...otherOverrides
	} = overrides;
	return {
		tokenId: "target-ready-1",
		sessionId: fixture.intent.sessionId,
		authorityFreshnessHandleId: "authority-1",
		authorityFingerprint: "authority-fingerprint-1",
		controllerLifecycleGeneration: 1,
		leafId: fixture.intent.leafId,
		handoffGeneration: fixture.intent.handoffGeneration,
		switchIntentSeq: fixture.intent.switchIntentSeq,
		targetPath: fixture.intent.targetPath,
		targetFile: fixture.intent.targetFile,
		hostLoadTokenId: "host-load-1",
		hostLoadCompletedEpoch: 1,
		hostLoadReceiptId: "host-receipt-1",
		nativeHistoryEpoch: 2,
		targetSelectionEpoch: 3,
		targetScrollEpoch: 4,
		certifiedBaseContent: fixture.record.body.startContent,
		certifiedBaseHash: fixture.record.startContentHash,
		openEditorTicketId: "ticket-1",
		...otherOverrides,
		targetAuthority: targetAuthorityOverride ?? targetAuthority,
	};
}

function makeSnapshot(
	fixture: ReplayFixture,
	token: ExistingTargetReadyToken,
	overrides: Partial<HandoffReplayTargetSnapshot> = {},
): HandoffReplayTargetSnapshot {
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("content");
	ytext.insert(0, fixture.record.body.startContent);
	return {
		sessionId: fixture.intent.sessionId,
		leafId: fixture.intent.leafId,
		handoffGeneration: fixture.intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		targetReadyTokenId: token.tokenId,
		hostLoadTokenId: token.hostLoadTokenId,
		hostLoadReceiptId: token.hostLoadReceiptId,
		targetPath: fixture.intent.targetPath,
		targetFile: fixture.intent.targetFile,
		targetFileId: token.targetAuthority.fileId,
		cm: EditorView.prototype,
		ytext,
		ytextIdentity: token.targetAuthority.ytextIdentity,
		ytextMutationEpoch: token.targetAuthority.ytextMutationEpoch,
		bindingEpoch: 12,
		editorRevision: 1,
		nativeHistoryEpoch: token.nativeHistoryEpoch,
		selectionEpoch: token.targetSelectionEpoch,
		scrollEpoch: token.targetScrollEpoch,
		selection: fixture.intent.selectionBefore,
		scrollAnchor: null,
		cmDocument: Text.of(fixture.record.body.startContent.split("\n")),
		editorFacadeContent: fixture.record.body.startContent,
		runtimeCacheContent: fixture.record.body.startContent,
		ytextContent: ytext.toString(),
		...overrides,
	};
}

function makeExactPlan(
	claim: VerifiedFreshStoredHandoffClaim,
	fixture: ReplayFixture,
	token: ExistingTargetReadyToken = makeExistingToken(fixture),
	snapshot: HandoffReplayTargetSnapshot = makeSnapshot(fixture, token),
) {
	return planExactHandoffReplay(claim, token, snapshot, {
		planId: "plan-1",
		replayPermitId: "permit-1",
	});
}

console.log("\n--- exact fresh claim positives ---");
const userFixture = await makeFreshStoredReplayFixture();
const userClaim = await requireClaim(userFixture);
const userToken = makeExistingToken(userFixture);
const userSnapshot = makeSnapshot(userFixture, userToken);
const userPlan = makeExactPlan(userClaim, userFixture, userToken, userSnapshot);
assert(userPlan.kind === "planned", "exact post-switch user input plans");
equal(userPlan.plan.kind, "exact-replay", "Slice 3 returns only exact-replay");
equal(userPlan.plan.replayChanges, userClaim.changes, "plan preserves the parsed ChangeSet");
equal(userPlan.plan.mappedSelection, userClaim.selectionAfter, "successor selection is used directly");
equal(userPlan.plan.mappedScrollAnchor, null, "null scroll anchor remains null");
equal(userPlan.applyWitness.planId, "plan-1", "witness binds the exact plan");
equal(userPlan.applyWitness.kind, "exact-replay", "witness records only exact replay");
equal(userPlan.applyWitness.dispatchReceiptHash, null, "fresh witness has no dispatch receipt");
equal(
	userPlan.applyWitness.plannedResultContent,
	userFixture.record.body.afterContent,
	"witness retains the exact planned successor",
);

const imeFixture = await makeFreshStoredReplayFixture({
	originKind: "ime",
	compositionEpoch: 41,
});
const completeImeProof: HandoffCompositionProof = {
	compositionEpoch: 41,
	startedUnderSwitchSeq: imeFixture.intent.switchIntentSeq,
	firstInputSeq: imeFixture.intent.inputStartSeq,
	lastInputSeq: imeFixture.intent.inputStartSeq + 1,
	endSeq: imeFixture.intent.inputStartSeq + 2,
	completed: true,
	gapFree: true,
	finalSuccessorObserved: true,
};
const imeClaim = await requireClaim(imeFixture, completeImeProof);
assert(
	makeExactPlan(imeClaim, imeFixture).kind === "planned",
	"completed gap-free Korean IME lineage plans exactly",
);

console.log("\n--- input and composition eligibility rejects ---");
const sourceOwnedFixture = await makeFreshStoredReplayFixture({
	sequenceBegan: "before-handoff",
	inputStartSeq: 18,
	inputStartedUnderSwitchSeq: null,
});
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		sourceOwnedFixture.intent,
		sourceOwnedFixture.record,
		null,
	),
	"source-owned input remains manual",
);

const editorApiFixture = await makeFreshStoredReplayFixture({
	originKind: "editor-api",
});
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		editorApiFixture.intent,
		editorApiFixture.record,
		null,
	),
	"editor API replacement remains manual",
);

const unsupportedEventFixture = await makeFreshStoredReplayFixture({
	userEvent: "other",
});
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		unsupportedEventFixture.intent,
		unsupportedEventFixture.record,
		null,
	),
	"unsupported user event remains manual",
);

const incompleteProof: HandoffCompositionProof = {
	...completeImeProof,
	completed: false,
};
const spanningProof: HandoffCompositionProof = {
	...completeImeProof,
	startedUnderSwitchSeq: completeImeProof.startedUnderSwitchSeq - 1,
};
const gappedProof: HandoffCompositionProof = {
	...completeImeProof,
	gapFree: false,
};
const nonFinalProof: HandoffCompositionProof = {
	...completeImeProof,
	finalSuccessorObserved: false,
};
for (const [name, proof] of [
	["incomplete", incompleteProof],
	["switch-spanning", spanningProof],
	["gapped", gappedProof],
	["non-final-successor", nonFinalProof],
] as const) {
	assertNoReplayPlan(
		await verifyFreshStoredHandoffClaim(
			imeFixture.intent,
			imeFixture.record,
			proof,
		),
		`${name} IME proof remains manual`,
	);
}
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(imeFixture.intent, imeFixture.record, null),
	"missing IME suffix proof remains manual",
);
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		userFixture.record,
		{ ...completeImeProof, compositionEpoch: 42 },
	),
	"user input carrying composition proof remains manual",
);

console.log("\n--- canonical persisted proof rejects ---");
const proof = userFixture.record.body.eventProof;
const changedEventProofs: readonly [
	string,
	StoredRecord["body"]["eventProof"],
][] = [
	["proof schema version", { ...proof, proofSchemaVersion: proof.proofSchemaVersion + 1 }],
	[
		"canonical encoding version",
		{ ...proof, canonicalEncodingVersion: proof.canonicalEncodingVersion + 1 },
	],
	["session ID", { ...proof, sessionId: `${proof.sessionId}-changed` }],
	["leaf ID", { ...proof, leafId: `${proof.leafId}-changed` }],
	["handoff generation", { ...proof, handoffGeneration: proof.handoffGeneration + 1 }],
	["binding epoch", { ...proof, bindingEpoch: proof.bindingEpoch + 1 }],
	["input epoch", { ...proof, inputEpoch: proof.inputEpoch + 1 }],
	["switch sequence", { ...proof, switchIntentSeq: proof.switchIntentSeq + 1 }],
	["input start sequence", { ...proof, inputStartSeq: proof.inputStartSeq + 1 }],
	[
		"input switch ownership",
		{ ...proof, inputStartedUnderSwitchSeq: (proof.inputStartedUnderSwitchSeq ?? 0) + 1 },
	],
	["composition epoch", { ...proof, compositionEpoch: 1 }],
	["selection epoch", { ...proof, selectionEpoch: proof.selectionEpoch + 1 }],
];
for (const [name, changedProof] of changedEventProofs) {
	const changedRecord = {
		...userFixture.record,
		body: {
			...userFixture.record.body,
			eventProof: changedProof,
		},
	};
	assertNoReplayPlan(
		await verifyFreshStoredHandoffClaim(userFixture.intent, changedRecord, null),
		`changed eventProof ${name} is rejected`,
	);
}

const noncanonicalChangesRecord = {
	...userFixture.record,
	body: {
		...userFixture.record.body,
		serializedChanges: ` ${userFixture.record.body.serializedChanges}`,
	},
};
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		noncanonicalChangesRecord,
		null,
	),
	"noncanonical serialized changes are rejected",
);

const differentChanges = ChangeSet.of([{ from: 0, insert: "x" }], 4);
const changedChangesRecord = {
	...userFixture.record,
	body: {
		...userFixture.record.body,
		serializedChanges: canonicalHandoffRecoveryJson(differentChanges.toJSON()),
	},
};
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		changedChangesRecord,
		null,
	),
	"changed canonical serialized changes are rejected",
);

for (const [name, field] of [
	["selection-before", "serializedSelectionBefore"],
	["selection-after", "serializedSelectionAfter"],
] as const) {
	const changedRecord = {
		...userFixture.record,
		body: {
			...userFixture.record.body,
			[field]: canonicalHandoffRecoveryJson(EditorSelection.single(0).toJSON()),
		},
	};
	assertNoReplayPlan(
		await verifyFreshStoredHandoffClaim(userFixture.intent, changedRecord, null),
		`changed canonical ${name} is rejected`,
	);
}

const alternateFixture = await makeStoredReplayFixture({
	changes: ChangeSet.of([{ from: 4, insert: "?" }], 4),
});
const staleEnvelopeBodyRecord = {
	...alternateFixture.record,
	intentEnvelopeHash: userFixture.record.intentEnvelopeHash,
};
const staleEnvelopeBodyResult = await verifyFreshStoredHandoffClaim(
	alternateFixture.intent,
	staleEnvelopeBodyRecord,
	null,
);
assertNoReplayPlan(
	staleEnvelopeBodyResult,
	"changed body with stale intent envelope hash is rejected",
);
equal(
	staleEnvelopeBodyResult.kind === "manual" ? staleEnvelopeBodyResult.reason : null,
	"intent-envelope-hash-mismatch",
	"stale body reaches the full envelope verification",
);

const changedScopeRecord = {
	...userFixture.record,
	scope: { ...userFixture.record.scope, vaultId: "vault-b" },
};
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(userFixture.intent, changedScopeRecord, null),
	"changed envelope scope metadata is rejected",
);

const changedEnvelopeMetadata: readonly [string, ActiveHandoffRecoveryRecord][] = [
	["intent ID", { ...userFixture.record, intentId: "other-intent" }],
	["source path", { ...userFixture.record, fromPath: "other-A.md" }],
	["target path", { ...userFixture.record, targetPath: "other-B.md" }],
	["origin", { ...userFixture.record, originKind: "ime" }],
	["sequence class", { ...userFixture.record, sequenceBegan: "before-handoff" }],
	["start hash", { ...userFixture.record, startContentHash: "0".repeat(64) }],
	["result hash", { ...userFixture.record, afterContentHash: "0".repeat(64) }],
	["capture time", { ...userFixture.record, capturedAt: userFixture.record.capturedAt + 1 }],
];
for (const [name, changedRecord] of changedEnvelopeMetadata) {
	assertNoReplayPlan(
		await verifyFreshStoredHandoffClaim(userFixture.intent, changedRecord, null),
		`changed persisted envelope ${name} is rejected`,
	);
}

assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		{ ...userFixture.record, intentEnvelopeHash: "0".repeat(64) },
		null,
	),
	"changed full envelope digest is rejected",
);
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		{ ...userFixture.record, status: "needs-review" },
		null,
	),
	"non-fresh stored status cannot be claimed",
);
assertNoReplayPlan(
	await verifyFreshStoredHandoffClaim(
		userFixture.intent,
		{
			...userFixture.record,
			applyWitness: userPlan.applyWitness,
		},
		null,
	),
	"already witnessed stored row cannot be claimed",
);

console.log("\n--- exact target proof rejects ---");
const wrongFile = new ReplayFixtureFile("B.md");
assertNoReplayPlan(
	makeExactPlan(
		userClaim,
		userFixture,
		makeExistingToken(userFixture, { targetFile: wrongFile }),
		userSnapshot,
	),
	"equal-path but different target TFile identity is rejected",
);
assertNoReplayPlan(
	makeExactPlan(
		userClaim,
		userFixture,
		userToken,
		makeSnapshot(userFixture, userToken, { targetFile: wrongFile }),
	),
	"snapshot target TFile identity mismatch is rejected",
);

const baseMismatchCases: readonly [
	string,
	ExistingTargetReadyToken,
	HandoffReplayTargetSnapshot,
][] = [
	[
		"certified content",
		makeExistingToken(userFixture, { certifiedBaseContent: "other" }),
		userSnapshot,
	],
	[
		"certified hash",
		makeExistingToken(userFixture, { certifiedBaseHash: "0".repeat(64) }),
		userSnapshot,
	],
	[
		"CodeMirror document",
		userToken,
		makeSnapshot(userFixture, userToken, { cmDocument: Text.of(["other"]) }),
	],
	[
		"editor facade",
		userToken,
		makeSnapshot(userFixture, userToken, { editorFacadeContent: "other" }),
	],
	[
		"runtime cache",
		userToken,
		makeSnapshot(userFixture, userToken, { runtimeCacheContent: "other" }),
	],
	[
		"Y.Text content",
		userToken,
		makeSnapshot(userFixture, userToken, { ytextContent: "other" }),
	],
];
for (const [name, token, snapshot] of baseMismatchCases) {
	assertNoReplayPlan(
		makeExactPlan(userClaim, userFixture, token, snapshot),
		`different B base on ${name} remains manual`,
	);
}

assertNoReplayPlan(
	makeExactPlan(
		userClaim,
		userFixture,
		userToken,
		makeSnapshot(userFixture, userToken, {
			ytextMutationEpoch: userToken.targetAuthority.ytextMutationEpoch + 1,
		}),
	),
	"causally advanced Y.Text epoch remains manual",
);
for (const [name, snapshot] of [
	[
		"native history",
		makeSnapshot(userFixture, userToken, {
			nativeHistoryEpoch: userToken.nativeHistoryEpoch + 1,
		}),
	],
	[
		"selection",
		makeSnapshot(userFixture, userToken, {
			selectionEpoch: userToken.targetSelectionEpoch + 1,
		}),
	],
	[
		"scroll",
		makeSnapshot(userFixture, userToken, {
			scrollEpoch: userToken.targetScrollEpoch + 1,
		}),
	],
] as const) {
	assertNoReplayPlan(
		makeExactPlan(userClaim, userFixture, userToken, snapshot),
		`changed ${name} epoch remains manual`,
	);
}

const missingAuthorityToken: TargetReadyToken = {
	...userToken,
	targetAuthority: { kind: "missing", activeIdSetEpoch: 1 },
};
assertNoReplayPlan(
	planExactHandoffReplay(
		userClaim,
		missingAuthorityToken,
		userSnapshot,
		{ planId: "missing-authority-plan", replayPermitId: "missing-permit" },
	),
	"missing target authority remains manual",
);

for (const [name, snapshot] of [
	[
		"file ID",
		makeSnapshot(userFixture, userToken, { targetFileId: "other-file-b" }),
	],
	[
		"Y.Text identity",
		makeSnapshot(userFixture, userToken, { ytextIdentity: "other-ytext-b" }),
	],
] as const) {
	assertNoReplayPlan(
		makeExactPlan(userClaim, userFixture, userToken, snapshot),
		`changed target authority ${name} requires a replan`,
	);
}

const replanIdentityCases: readonly [
	string,
	ExistingTargetReadyToken,
	HandoffReplayTargetSnapshot,
][] = [
	[
		"token session",
		makeExistingToken(userFixture, { sessionId: "other-session" }),
		userSnapshot,
	],
	[
		"snapshot session",
		userToken,
		makeSnapshot(userFixture, userToken, { sessionId: "other-session" }),
	],
	[
		"token leaf",
		makeExistingToken(userFixture, { leafId: "other-leaf" }),
		userSnapshot,
	],
	[
		"snapshot leaf",
		userToken,
		makeSnapshot(userFixture, userToken, { leafId: "other-leaf" }),
	],
	[
		"token generation",
		makeExistingToken(userFixture, {
			handoffGeneration: userFixture.intent.handoffGeneration + 1,
		}),
		userSnapshot,
	],
	[
		"snapshot generation",
		userToken,
		makeSnapshot(userFixture, userToken, {
			handoffGeneration: userFixture.intent.handoffGeneration + 1,
		}),
	],
	[
		"switch sequence",
		makeExistingToken(userFixture, {
			switchIntentSeq: userFixture.intent.switchIntentSeq + 1,
		}),
		userSnapshot,
	],
	[
		"token path",
		makeExistingToken(userFixture, { targetPath: "C.md" }),
		userSnapshot,
	],
	[
		"snapshot path",
		userToken,
		makeSnapshot(userFixture, userToken, { targetPath: "C.md" }),
	],
	[
		"target-ready token",
		userToken,
		makeSnapshot(userFixture, userToken, {
			targetReadyTokenId: "other-target-ready",
		}),
	],
	[
		"host-load token",
		userToken,
		makeSnapshot(userFixture, userToken, { hostLoadTokenId: "other-host-load" }),
	],
	[
		"host-load receipt",
		userToken,
		makeSnapshot(userFixture, userToken, {
			hostLoadReceiptId: "other-host-receipt",
		}),
	],
];
for (const [name, token, snapshot] of replanIdentityCases) {
	assertNoReplayPlan(
		makeExactPlan(userClaim, userFixture, token, snapshot),
		`changed ${name} cannot reuse the plan`,
	);
}
const renamedTargetFixture = await makeFreshStoredReplayFixture();
const renamedTargetClaim = await requireClaim(renamedTargetFixture);
const renamedTargetToken = makeExistingToken(renamedTargetFixture);
const renamedTargetSnapshot = makeSnapshot(
	renamedTargetFixture,
	renamedTargetToken,
);
renamedTargetFixture.intent.targetFile.path = "renamed-B.md";
assertNoReplayPlan(
	makeExactPlan(
		renamedTargetClaim,
		renamedTargetFixture,
		renamedTargetToken,
		renamedTargetSnapshot,
	),
	"renamed target TFile object cannot satisfy the stale target path",
);

console.log("\n--- multiline, multi-selection, and scroll mapping ---");
const multilineStart = Text.of(["alpha", "beta", "gamma"]);
const multilineChanges = ChangeSet.of(
	[
		{ from: 5, to: 6, insert: "\n" },
		{ from: multilineStart.length, insert: "\n끝" },
	],
	multilineStart.length,
);
const multilineFixture = await makeStoredReplayFixture({
	startDocument: multilineStart,
	changes: multilineChanges,
});
const multilineClaim = await requireClaim(multilineFixture);
const multilinePlan = makeExactPlan(multilineClaim, multilineFixture);
assert(multilinePlan.kind === "planned", "multiline CodeMirror Text round-trips and plans");
equal(
	multilinePlan.plan.replayChanges.apply(multilinePlan.plan.expectedTargetDocument).toString(),
	multilineFixture.record.body.afterContent,
	"multiline replay recreates the exact successor",
);

const multiStart = Text.of(["abcdef"]);
const multiChanges = ChangeSet.of([{ from: 2, insert: "!" }], multiStart.length);
const selectionBefore = EditorSelection.create([
	EditorSelection.range(0, 1),
	EditorSelection.range(4, 6),
], 1);
const selectionAfter = selectionBefore.map(multiChanges);
const multiFixture = await makeStoredReplayFixture({
	startDocument: multiStart,
	changes: multiChanges,
	selectionBefore,
	selectionAfter,
});
const multiClaim = await requireClaim(multiFixture);
const multiPlan = makeExactPlan(multiClaim, multiFixture);
assert(multiPlan.kind === "planned", "multi-selection exact replay plans");
equal(multiPlan.plan.mappedSelection.mainIndex, 1, "nonzero mainIndex is preserved");
canonicalEqual(
	multiPlan.plan.mappedSelection.toJSON(),
	selectionAfter.toJSON(),
	"every successor selection range is preserved without double mapping",
);

const scrollSnapshot = makeSnapshot(userFixture, userToken, { scrollAnchor: 4 });
const scrollPlan = makeExactPlan(
	userClaim,
	userFixture,
	userToken,
	scrollSnapshot,
);
assert(scrollPlan.kind === "planned", "non-null scroll anchor plans");
equal(
	scrollPlan.plan.mappedScrollAnchor,
	userClaim.changes.mapPos(4, -1),
	"scroll anchor uses CodeMirror cursor association -1",
);
equal(
	scrollPlan.plan.mappedScrollAnchor,
	4,
	"insertion at the exact scroll anchor stays on the pre-insertion side",
);

equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: 7,
	afterEpoch: 7,
	mappedAnchor: 4,
	observedAnchor: 4,
}), true, "exact replay scroll postcondition accepts a stable epoch at the mapped anchor");
equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: 7,
	afterEpoch: 8,
	mappedAnchor: 4,
	observedAnchor: 4,
}), true, "one synchronous mapped-scroll event advances the replay epoch exactly once");
equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: 7,
	afterEpoch: 9,
	mappedAnchor: 4,
	observedAnchor: 4,
}), false, "two scroll events cannot inherit one replay effect's authority");
equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: 7,
	afterEpoch: 8,
	mappedAnchor: 4,
	observedAnchor: 5,
}), false, "one epoch advance at the wrong scroll anchor remains rejected");
equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: 7,
	afterEpoch: 8,
	mappedAnchor: null,
	observedAnchor: null,
}), false, "an anchorless plan cannot authorize a scroll epoch advance");
equal(isExactHandoffReplayScrollDispatchPostcondition({
	beforeEpoch: Number.MAX_SAFE_INTEGER,
	afterEpoch: Number.MAX_SAFE_INTEGER,
	mappedAnchor: 4,
	observedAnchor: 4,
}), false, "an exhausted scroll epoch cannot issue replay authority");

console.log("\n--- exact replay Y.Text transaction provenance ---");
const nestedDoc = new Y.Doc();
const nestedRoot = nestedDoc.getMap<Y.Text>("root");
const nestedTarget = new Y.Text();
const nestedSibling = new Y.Text();
nestedRoot.set("target", nestedTarget);
nestedRoot.set("sibling", nestedSibling);
const nestedOrigin = Object.freeze({ kind: "exact-replay" });
const nestedTargetTransactions: Y.Transaction[] = [];
const observeNestedTarget = (transaction: Y.Transaction): void => {
	nestedTargetTransactions.push(transaction);
};
nestedDoc.on("afterTransaction", observeNestedTarget);
nestedDoc.transact(() => nestedTarget.insert(0, "replayed"), nestedOrigin);
nestedDoc.off("afterTransaction", observeNestedTarget);
equal(nestedTargetTransactions.length, 1, "nested Y.Text fixture emits one transaction");
assert(
	nestedTargetTransactions[0]!.changedParentTypes.size > 1,
	"nested Y.Text fixture records target and ancestor observer paths",
);
equal(isExactHandoffReplayYTextTransaction({
	transactions: nestedTargetTransactions,
	expectedOrigin: nestedOrigin,
	expectedYtext: nestedTarget,
}), true, "target plus only its ancestor chain is exact replay provenance");
equal(isExactHandoffReplayYTextTransaction({
	transactions: nestedTargetTransactions,
	expectedOrigin: Object.freeze({ kind: "other" }),
	expectedYtext: nestedTarget,
}), false, "another Yjs origin cannot inherit exact replay provenance");
equal(isExactHandoffReplayYTextTransaction({
	transactions: [nestedTargetTransactions[0]!, nestedTargetTransactions[0]!],
	expectedOrigin: nestedOrigin,
	expectedYtext: nestedTarget,
}), false, "two observed Yjs transactions cannot inherit one replay permit");

const siblingTransactions: Y.Transaction[] = [];
const observeSibling = (transaction: Y.Transaction): void => {
	siblingTransactions.push(transaction);
};
nestedDoc.on("afterTransaction", observeSibling);
nestedDoc.transact(() => nestedSibling.insert(0, "sibling"), nestedOrigin);
nestedDoc.off("afterTransaction", observeSibling);
equal(isExactHandoffReplayYTextTransaction({
	transactions: siblingTransactions,
	expectedOrigin: nestedOrigin,
	expectedYtext: nestedTarget,
}), false, "a sibling-only Y.Text transaction is not target replay provenance");

const mixedTransactions: Y.Transaction[] = [];
const observeMixed = (transaction: Y.Transaction): void => {
	mixedTransactions.push(transaction);
};
nestedDoc.on("afterTransaction", observeMixed);
nestedDoc.transact(() => {
	nestedTarget.insert(nestedTarget.length, "!");
	nestedSibling.insert(nestedSibling.length, "!");
}, nestedOrigin);
nestedDoc.off("afterTransaction", observeMixed);
equal(isExactHandoffReplayYTextTransaction({
	transactions: mixedTransactions,
	expectedOrigin: nestedOrigin,
	expectedYtext: nestedTarget,
}), false, "a transaction that directly changes a sibling remains rejected");

console.log("\n--- exact replay owned-save scheduler transition ---");
const hostView = {} as ManagedViewSaveGuard["view"];
const originalRequestSave = (() => undefined) as ManagedViewSaveGuard["originalRequestSave"];
const originalSave = (async () => undefined) as ManagedViewSaveGuard["originalSave"];
const installedRequestSave = (() => undefined) as ManagedViewSaveGuard["installedRequestSave"];
const installedSave = (async () => undefined) as ManagedViewSaveGuard["installedSave"];
const hostBefore: ManagedViewSaveGuard = {
	leafId: userFixture.intent.leafId,
	view: hostView,
	originalRequestSave,
	originalSave,
	installedRequestSave,
	installedSave,
	hostCapability: "owned-scheduler-with-unload-flush",
	hostCapabilityState: "ready",
	saveEpoch: 7,
	clearLoadCapability: "observable",
	mode: { kind: "pass-through" },
	inFlight: new Map(),
	pendingTargetSave: false,
	pendingOwnedSave: null,
	sourceUnload: null,
};
const replayOwnedSaveAuthority = {
	sessionId: userFixture.intent.sessionId,
	handoffGeneration: userFixture.intent.handoffGeneration,
	targetFile: userFixture.intent.targetFile,
	targetPath: userFixture.intent.targetPath,
};
const exactOwnedSaveJob = {
	jobId: 1,
	sessionId: replayOwnedSaveAuthority.sessionId,
	generation: replayOwnedSaveAuthority.handoffGeneration,
	file: replayOwnedSaveAuthority.targetFile,
	path: replayOwnedSaveAuthority.targetPath,
	displayedPath: replayOwnedSaveAuthority.targetPath,
	saveEpoch: hostBefore.saveEpoch + 1,
};
const hostAfterExactOwnedSave: ManagedViewSaveGuard = {
	...hostBefore,
	saveEpoch: hostBefore.saveEpoch + 1,
	pendingOwnedSave: exactOwnedSaveJob,
};
equal(isExactHandoffReplayOwnedSaveStart(
	hostBefore,
	hostAfterExactOwnedSave,
	replayOwnedSaveAuthority,
), true, "exact replay accepts one newly scheduled owned save for the certified target");

for (const [name, after] of [
	["two save epochs", {
		...hostAfterExactOwnedSave,
		saveEpoch: hostBefore.saveEpoch + 2,
		pendingOwnedSave: {
			...exactOwnedSaveJob,
			saveEpoch: hostBefore.saveEpoch + 2,
		},
	}],
	["a non-positive job id", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: { ...exactOwnedSaveJob, jobId: 0 },
	}],
	["a mismatched job save epoch", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: { ...exactOwnedSaveJob, saveEpoch: hostBefore.saveEpoch },
	}],
	["another session", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: { ...exactOwnedSaveJob, sessionId: "other-session" },
	}],
	["another handoff generation", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: {
			...exactOwnedSaveJob,
			generation: exactOwnedSaveJob.generation + 1,
		},
	}],
	["another file", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: {
			...exactOwnedSaveJob,
			file: new ReplayFixtureFile("other.md"),
		},
	}],
	["another path", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: { ...exactOwnedSaveJob, path: "other.md" },
	}],
	["another displayed path", {
		...hostAfterExactOwnedSave,
		pendingOwnedSave: { ...exactOwnedSaveJob, displayedPath: "other.md" },
	}],
	["a pending target save", {
		...hostAfterExactOwnedSave,
		pendingTargetSave: true,
	}],
	["an in-flight save mutation", {
		...hostAfterExactOwnedSave,
		inFlight: new Map([[1, {
			file: replayOwnedSaveAuthority.targetFile,
			path: replayOwnedSaveAuthority.targetPath,
			startedAt: 1,
		}]]),
	}],
	["a host capability loss", {
		...hostAfterExactOwnedSave,
		hostCapabilityState: "lost" as const,
	}],
	["a host mode change", {
		...hostAfterExactOwnedSave,
		mode: { kind: "inert-pass-through" as const },
	}],
	["a wrapper replacement", {
		...hostAfterExactOwnedSave,
		installedSave: (async () => undefined) as ManagedViewSaveGuard["installedSave"],
	}],
	["a source-unload mutation", {
		...hostAfterExactOwnedSave,
		sourceUnload: {
			receiptId: "receipt-1",
			unloadId: 1,
			file: replayOwnedSaveAuthority.targetFile,
			path: replayOwnedSaveAuthority.targetPath,
			state: "settled" as const,
			forcedSaveObserved: true,
			cacheRetiredBeforeUnloadSettled: true,
		},
	}],
] satisfies readonly (readonly [string, ManagedViewSaveGuard])[]) {
	equal(isExactHandoffReplayOwnedSaveStart(
		hostBefore,
		after,
		replayOwnedSaveAuthority,
	), false, `exact replay rejects owned-save scheduling with ${name}`);
}

const pendingJobBefore: ManagedViewSaveGuard = {
	...hostBefore,
	pendingOwnedSave: {
		...exactOwnedSaveJob,
		jobId: 41,
		saveEpoch: hostBefore.saveEpoch,
	},
};
equal(isExactHandoffReplayOwnedSaveStart(
	pendingJobBefore,
	{
		...hostAfterExactOwnedSave,
		saveEpoch: hostBefore.saveEpoch + 2,
		pendingOwnedSave: {
			...exactOwnedSaveJob,
			jobId: 42,
			saveEpoch: hostBefore.saveEpoch + 2,
		},
	},
	replayOwnedSaveAuthority,
), false, "exact replay cannot replace an already pending owned save");
equal(isExactHandoffReplayOwnedSaveStart(
	{ ...hostBefore, saveEpoch: Number.MAX_SAFE_INTEGER },
	{
		...hostAfterExactOwnedSave,
		saveEpoch: Number.MAX_SAFE_INTEGER,
		pendingOwnedSave: {
			...exactOwnedSaveJob,
			saveEpoch: Number.MAX_SAFE_INTEGER,
		},
	},
	replayOwnedSaveAuthority,
), false, "an exhausted save epoch cannot authorize an owned-save transition");

const runtimeCacheProjection = {
	beforeDescriptor: {
		configurable: true,
		enumerable: true,
		value: "target base",
		writable: true,
	} satisfies PropertyDescriptor,
	afterDispatchDescriptor: {
		configurable: true,
		enumerable: true,
		value: "target base",
		writable: true,
	} satisfies PropertyDescriptor,
	expectedStartContent: "target base",
	expectedResultContent: "target base + replay",
	hostBefore,
	hostAfter: hostAfterExactOwnedSave,
	expected: replayOwnedSaveAuthority,
};
equal(
	isExactHandoffReplayRuntimeCacheProjection(runtimeCacheProjection),
	true,
	"exact replay may project only its unchanged writable host-cache preimage",
);
for (const [name, input] of [
	["an already exact result", {
		...runtimeCacheProjection,
		expectedResultContent: runtimeCacheProjection.expectedStartContent,
	}],
	["a stale pre-dispatch cache", {
		...runtimeCacheProjection,
		beforeDescriptor: {
			...runtimeCacheProjection.beforeDescriptor,
			value: "other base",
		},
	}],
	["a concurrently changed cache", {
		...runtimeCacheProjection,
		afterDispatchDescriptor: {
			...runtimeCacheProjection.afterDispatchDescriptor,
			value: "other base",
		},
	}],
	["a read-only cache", {
		...runtimeCacheProjection,
		beforeDescriptor: {
			...runtimeCacheProjection.beforeDescriptor,
			writable: false,
		},
		afterDispatchDescriptor: {
			...runtimeCacheProjection.afterDispatchDescriptor,
			writable: false,
		},
	}],
	["a changed descriptor shape", {
		...runtimeCacheProjection,
		afterDispatchDescriptor: {
			...runtimeCacheProjection.afterDispatchDescriptor,
			configurable: false,
		},
	}],
	["an accessor cache", {
		...runtimeCacheProjection,
		beforeDescriptor: {
			configurable: true,
			enumerable: true,
			get: () => "target base",
			set: () => undefined,
		},
		afterDispatchDescriptor: {
			configurable: true,
			enumerable: true,
			get: () => "target base",
			set: () => undefined,
		},
	}],
	["no exact owned-save start", {
		...runtimeCacheProjection,
		hostAfter: {
			...hostAfterExactOwnedSave,
			pendingOwnedSave: {
				...exactOwnedSaveJob,
				path: "other.md",
			},
		},
	}],
] satisfies readonly (readonly [
	string,
	Parameters<typeof isExactHandoffReplayRuntimeCacheProjection>[0],
])[]) {
	equal(
		isExactHandoffReplayRuntimeCacheProjection(input),
		false,
		`exact replay rejects runtime-cache projection with ${name}`,
	);
}

console.log(`\neditor-handoff-exact-replay: ${passed} assertions passed`);
