import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import type { HandoffReplayClassificationQaObservation } from "../src/runtime/handoffReplayQaObserver";
import {
	ManualHandoffRecoveryCoordinator,
	type HandoffRecoveryRuntimeRequest,
} from "../src/runtime/handoffRecoveryCoordinator";
import type { EditorBindingManager } from "../src/sync/editorBinding";
import type {
	EditorHandoffEvent,
	HandoffReplayPlan,
	TargetReadyToken,
} from "../src/sync/editorHandoffState";
import type {
	ConsumeExactHandoffReplayPermitRequest,
	CreateExactHandoffReplayDispatchReceiptRequest,
	ExactHandoffReplayPlanRequest,
	HandoffReplayDispatchReceipt,
	ObserveExactHandoffReplaySettlementRequest,
	ObserveExactHandoffReplaySettlementResult,
} from "../src/sync/editorHandoffReplay";
import {
	canonicalHandoffRecoveryJson,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type ClearHandoffRecoveryScopeResult,
	type HandoffRecoveryApplyWitness,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryHydrationResult,
	type HandoffRecoveryScope,
	type HandoffRecoveryStatusTransition,
	type HandoffRecoveryStore,
	type PutHandoffRecoveryIntentResult,
	type ResolveHandoffRecoveryRequest,
	type ResolveHandoffRecoveryResult,
} from "../src/sync/handoffRecoveryStore";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import {
	makeStoredReplayFixture,
} from "./helpers/handoff-replay-fixture";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	value: true,
	configurable: true,
});
const { HandoffReplayCoordinator } = await import(
	"../src/runtime/handoffReplayCoordinator"
);
const { associateHandoffReplayClassificationObserverForQa } = await import(
	"../src/runtime/handoffReplayQaObserver"
);

type Fault =
	| "none"
	| "witness-before"
	| "witness-after"
	| "witness-wrong-result"
	| "witness-missing"
	| "receipt-after"
	| "resolve-after"
	| "cas-before"
	| "cas-after";

let fixtureSequence = 0;

class RecordingStore implements HandoffRecoveryStore {
	readonly scope: HandoffRecoveryScope;
	fault: Fault = "none";
	afterNextHydrate: (() => Promise<void>) | null = null;

	constructor(
		private readonly inner: IndexedDbHandoffRecoveryStore,
		private readonly calls: string[],
	) {
		this.scope = inner.scope;
	}

	async putIntent(intent: Parameters<HandoffRecoveryStore["putIntent"]>[0]): Promise<PutHandoffRecoveryIntentResult> {
		this.calls.push("store:put");
		return this.inner.putIntent(intent);
	}

	async compareAndSetStatus(
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	): Promise<HandoffRecoveryCasResult> {
		this.calls.push(`store:cas:${transition.from}->${transition.to}`);
		if (this.fault === "cas-before") throw new Error("before cas");
		const result = await this.inner.compareAndSetStatus(
			recordId,
			expectedChecksum,
			transition,
		);
		if (this.fault === "cas-after") throw new Error("after cas");
		return result;
	}

	async storeApplyWitness(
		recordId: string,
		expectedChecksum: string,
		witness: HandoffRecoveryApplyWitness,
	): Promise<HandoffRecoveryCasResult> {
		this.calls.push("store:witness");
		if (this.fault === "witness-before") throw new Error("before witness");
		if (this.fault === "witness-missing") {
			await this.inner.clearScope();
			return { kind: "missing" };
		}
		if (this.fault === "witness-wrong-result") {
			const current = (await this.inner.hydrateScope()).active[0];
			return current ? { kind: "unchanged", record: current } : { kind: "missing" };
		}
		const result = await this.inner.storeApplyWitness(recordId, expectedChecksum, witness);
		if (this.fault === "witness-after") throw new Error("after witness");
		return result;
	}

	async storeDispatchReceipt(
		recordId: string,
		expectedChecksum: string,
		dispatchReceiptHash: string,
	): Promise<HandoffRecoveryCasResult> {
		this.calls.push("store:receipt");
		const result = await this.inner.storeDispatchReceipt(
			recordId,
			expectedChecksum,
			dispatchReceiptHash,
		);
		if (this.fault === "receipt-after") throw new Error("after receipt");
		return result;
	}

	async resolveRecord(request: ResolveHandoffRecoveryRequest): Promise<ResolveHandoffRecoveryResult> {
		this.calls.push(request.kind === "finalize-active" ? "store:resolve" : "store:escape");
		const result = await this.inner.resolveRecord(request);
		if (request.kind === "finalize-active" && this.fault === "resolve-after") {
			throw new Error("after resolve");
		}
		return result;
	}

	async hydrateScope(): Promise<HandoffRecoveryHydrationResult> {
		this.calls.push("store:hydrate");
		const result = await this.inner.hydrateScope();
		const afterHydrate = this.afterNextHydrate;
		this.afterNextHydrate = null;
		if (afterHydrate) await afterHydrate();
		return result;
	}

	async clearScope(): Promise<ClearHandoffRecoveryScopeResult> {
		this.calls.push("store:clear");
		return this.inner.clearScope();
	}

	async drain(): Promise<void> {
		this.calls.push("store:drain");
		await this.inner.drain();
	}
}

function deferred(): Readonly<{
	promise: Promise<void>;
	resolve(): void;
}> {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

class RecordingController {
	dispatchReceiptCount = 0;
	invalidations = 0;
	observations: ObserveExactHandoffReplaySettlementResult[] = [{ kind: "settled" }];

	constructor(
		private readonly token: TargetReadyToken,
		private readonly calls: string[],
	) {}

	async requestExactHandoffReplayPlan(request: ExactHandoffReplayPlanRequest) {
		this.calls.push("controller:plan");
		const plan: HandoffReplayPlan = Object.freeze({
			planId: `plan:${request.record.recordId}`,
			intentId: request.intent.intentId,
			targetReadyTokenId: request.targetReadyToken.tokenId,
			authorityFreshnessHandleId:
				request.targetReadyToken.authorityFreshnessHandleId,
			replayPermitId: `permit:${request.record.recordId}`,
			switchIntentSeq: request.intent.switchIntentSeq,
			kind: "exact-replay",
			expectedTargetDocument: request.intent.startDocument,
			expectedSelectionEpoch: request.targetReadyToken.targetSelectionEpoch,
			expectedNativeHistoryEpoch: request.targetReadyToken.nativeHistoryEpoch,
			expectedTargetScrollEpoch: request.targetReadyToken.targetScrollEpoch,
			replayChanges: request.intent.changes,
			mappedSelection: request.intent.selectionAfter,
			mappedScrollAnchor: null,
		});
		const applyWitness: HandoffRecoveryApplyWitness = Object.freeze({
			planId: plan.planId,
			kind: "exact-replay",
			switchIntentSeq: request.intent.switchIntentSeq,
			hostLoadTokenId: request.targetReadyToken.hostLoadTokenId,
			targetFileId: request.targetReadyToken.targetAuthority.kind === "existing"
				? request.targetReadyToken.targetAuthority.fileId
				: "missing-file",
			targetYtextIdentity: request.targetReadyToken.targetAuthority.kind === "existing"
				? request.targetReadyToken.targetAuthority.ytextIdentity
				: "missing-ytext",
			targetMutationEpochAtPlan:
				request.targetReadyToken.targetAuthority.ytextMutationEpoch,
			nativeHistoryEpoch: request.targetReadyToken.nativeHistoryEpoch,
			targetSelectionEpoch: request.targetReadyToken.targetSelectionEpoch,
			targetScrollEpoch: request.targetReadyToken.targetScrollEpoch,
			plannedStartHash: request.record.startContentHash,
			plannedResultContent: request.record.body.afterContent,
			plannedResultHash: request.record.afterContentHash,
			serializedMappedSelection: canonicalHandoffRecoveryJson(
				request.intent.selectionAfter.toJSON(),
			),
			dispatchReceiptHash: null,
		});
		return { kind: "planned" as const, plan, applyWitness };
	}

	consumeExactHandoffReplayPermit(request: ConsumeExactHandoffReplayPermitRequest) {
		this.calls.push("controller:permit");
		return {
			kind: "accepted" as const,
			permit: Object.freeze({
				permitId: request.plan.replayPermitId,
				planId: request.plan.planId,
				recordId: request.record.recordId,
				replayPendingChecksum: request.record.checksum,
				recoveryOperationEpoch: request.recoveryOperationEpoch,
				expectedSnapshotFingerprint: "snapshot-1",
			}),
		};
	}

	createExactHandoffReplayDispatchReceipt(
		request: CreateExactHandoffReplayDispatchReceiptRequest,
	): HandoffReplayDispatchReceipt {
		this.calls.push("controller:receipt");
		this.dispatchReceiptCount += 1;
		const witness = request.record.applyWitness!;
		return Object.freeze({
			receiptSchemaVersion: 1,
			planId: request.plan.planId,
			intentId: request.record.intentId,
			recordId: request.record.recordId,
			sessionId: request.record.body.eventProof.sessionId,
			handoffGeneration: request.record.body.eventProof.handoffGeneration,
			recoveryOperationEpoch: request.recoveryOperationEpoch,
			switchIntentSeq: request.plan.switchIntentSeq,
			targetReadyTokenId: this.token.tokenId,
			hostLoadTokenId: this.token.hostLoadTokenId,
			hostLoadReceiptId: this.token.hostLoadReceiptId,
			targetPath: request.record.targetPath,
			targetFileId: witness.targetFileId,
			targetYtextIdentity: witness.targetYtextIdentity,
			targetMutationEpochAtPlan: witness.targetMutationEpochAtPlan,
			targetMutationEpochAfter: request.postcondition.ytextMutationEpoch,
			bindingEpochAfter: request.postcondition.bindingEpoch,
			editorRevisionAfter: request.postcondition.editorRevision,
			nativeHistoryEpochAfter: request.postcondition.nativeHistoryEpoch,
			selectionEpochBefore: witness.targetSelectionEpoch,
			selectionEpochAfter: request.postcondition.selectionEpoch,
			scrollEpochBefore: witness.targetScrollEpoch,
			scrollEpochAfter: request.postcondition.scrollEpoch,
			plannedStartHash: witness.plannedStartHash,
			plannedResultHash: witness.plannedResultHash,
			serializedMappedSelection: witness.serializedMappedSelection,
			mappedScrollAnchor: request.postcondition.scrollAnchor,
			appliedAt: request.appliedAt,
		});
	}

	async observeExactHandoffReplaySettlement(
		_request: ObserveExactHandoffReplaySettlementRequest,
	): Promise<ObserveExactHandoffReplaySettlementResult> {
		this.calls.push("controller:observe");
		return this.observations.shift() ?? { kind: "pending", reason: "disk-not-yet-saved" };
	}

	invalidateExactHandoffReplayForRecoveryClear(): void {
		this.calls.push("controller:invalidate");
		this.invalidations += 1;
	}

	invalidateExactHandoffReplayForRecord(recordId: string): void {
		this.calls.push(`controller:invalidate:${recordId}`);
		this.invalidations += 1;
	}
}

class RecordingBindings {
	currentToken: TargetReadyToken | null;
	dispatches = 0;

	constructor(
		token: TargetReadyToken | null,
		private readonly calls: string[],
	) {
		this.currentToken = token;
	}

	captureHandoffCompositionProof() {
		this.calls.push("bindings:composition");
		return { kind: "not-ime" as const };
	}

	captureCurrentTargetReadyToken(
		_request: Parameters<EditorBindingManager["captureCurrentTargetReadyToken"]>[0],
	) {
		this.calls.push("bindings:target-ready");
		return this.currentToken;
	}

	applyExactHandoffReplay(
		request: Parameters<EditorBindingManager["applyExactHandoffReplay"]>[0],
	) {
		this.calls.push("bindings:dispatch");
		this.dispatches += 1;
		const authority = this.currentToken?.targetAuthority;
		assert(authority?.kind === "existing");
		return {
			kind: "applied" as const,
			postcondition: Object.freeze({
				planId: request.plan.planId,
				recordId: request.record.recordId,
				recoveryOperationEpoch: request.recoveryOperationEpoch,
				targetFileId: authority.fileId,
				ytextIdentity: authority.ytextIdentity,
				ytextMutationEpoch: authority.ytextMutationEpoch + 1,
				bindingEpoch: 12,
				editorRevision: 2,
				nativeHistoryEpoch: this.currentToken!.nativeHistoryEpoch + 1,
				selectionEpoch: this.currentToken!.targetSelectionEpoch + 1,
				scrollEpoch: this.currentToken!.targetScrollEpoch,
				selection: request.plan.mappedSelection,
				scrollAnchor: request.plan.mappedScrollAnchor,
			}),
		};
	}
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(options: Readonly<{
	targetReady?: boolean;
	fault?: Fault;
	observations?: ObserveExactHandoffReplaySettlementResult[];
	accept?: (event: EditorHandoffEvent) => boolean;
	validateRecord?: typeof validateHandoffRecoveryRecord;
	intentOverrides?: Parameters<typeof makeStoredReplayFixture>[0]["intentOverrides"];
	classificationObserverThrows?: boolean;
}> = {}) {
	fixtureSequence += 1;
	const codec = await makeStoredReplayFixture({
		intentOverrides: {
			intentId: `intent-${fixtureSequence}`,
			sessionId: `session-${fixtureSequence}`,
			...options.intentOverrides,
		},
	});
	const calls: string[] = [];
	const classifications: HandoffReplayClassificationQaObservation[] = [];
	const token: TargetReadyToken = Object.freeze({
		tokenId: `target-ready-${fixtureSequence}`,
		sessionId: codec.intent.sessionId,
		authorityFreshnessHandleId: `fresh-${fixtureSequence}`,
		authorityFingerprint: `fingerprint-${fixtureSequence}`,
		controllerLifecycleGeneration: 1,
		leafId: codec.intent.leafId,
		handoffGeneration: codec.intent.handoffGeneration,
		switchIntentSeq: codec.intent.switchIntentSeq,
		targetPath: codec.intent.targetPath,
		targetFile: codec.intent.targetFile,
		targetAuthority: Object.freeze({
			kind: "existing" as const,
			fileId: "file-b",
			ytextIdentity: `ytext-${fixtureSequence}`,
			ytextMutationEpoch: 0,
			bindPermitId: `bind-${fixtureSequence}`,
		}),
		hostLoadTokenId: `host-${fixtureSequence}`,
		hostLoadCompletedEpoch: 1,
		hostLoadReceiptId: `host-receipt-${fixtureSequence}`,
		nativeHistoryEpoch: 2,
		targetSelectionEpoch: 3,
		targetScrollEpoch: 4,
		certifiedBaseContent: codec.record.body.startContent,
		certifiedBaseHash: codec.record.startContentHash,
		openEditorTicketId: `ticket-${fixtureSequence}`,
	});
	const scope = codec.record.scope;
	const inner = new IndexedDbHandoffRecoveryStore(
		scope,
		indexedDB,
		`handoff-replay-coordinator-${fixtureSequence}`,
		() => 1_800_000_000_100 + fixtureSequence,
	);
	const store = new RecordingStore(inner, calls);
	store.fault = options.fault ?? "none";
	const controller = new RecordingController(token, calls);
	if (options.observations) controller.observations = [...options.observations];
	const bindings = new RecordingBindings(options.targetReady === false ? null : token, calls);
	let scopeCurrent = true;
	const replay = new HandoffReplayCoordinator({
		store,
		controller,
		editorBindings: bindings,
		now: () => 1_800_000_001_000 + fixtureSequence,
		validateRecord: options.validateRecord,
		isScopeCurrent: () => scopeCurrent,
	});
	associateHandoffReplayClassificationObserverForQa(replay, (observation) => {
			classifications.push(observation);
			if (options.classificationObserverThrows) {
				throw new Error("QA observer failure");
			}
	});
	const manual = new ManualHandoffRecoveryCoordinator({
		store,
		now: () => 1_800_000_001_000 + fixtureSequence,
		isScopeCurrent: () => scopeCurrent,
		classifyStoredIntent: replay.classifyStoredIntent,
		observeAwaitingSettlement: replay.observeHydratedAwaitingSettlement,
		replayActions: {
			continueWithoutAutomaticApply: (request, recordId, isActionCurrent) =>
				replay.continueWithoutAutomaticApply(
					request,
					recordId,
					isActionCurrent,
				),
			retrySettlement: (recordId) => replay.retrySettlement(recordId),
		},
		clearHooks: {
			invalidateReplayAuthorityBeforeClear: () => replay.invalidateForRecoveryClear(),
			drainAndDemoteReplayRowsBeforeClear: () =>
				replay.drainAndDemoteForRecoveryClear(),
		},
	});
	const events: EditorHandoffEvent[] = [];
	const request: HandoffRecoveryRuntimeRequest = {
		sessionId: codec.intent.sessionId,
		expectedGeneration: codec.intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intent: codec.intent,
		deliver(event) {
			calls.push(`deliver:${event.type === "intent-state-changed"
				? event.intentState.kind
				: event.type}`);
			if (options.accept && !options.accept(event)) return false;
			events.push(event);
			return true;
		},
	};
	return {
		codec,
		token,
		calls,
		store,
		controller,
		bindings,
		replay,
		manual,
		request,
		events,
		classifications,
		setScopeCurrent(value: boolean) { scopeCurrent = value; },
	};
}

async function persisted(fixture: Fixture): Promise<ActiveHandoffRecoveryRecord | null> {
	const hydration = await fixture.store.hydrateScope();
	return hydration.active[0] ?? null;
}

async function runSuccess(fixture: Fixture): Promise<void> {
	await fixture.manual.persistAndClassify(fixture.request);
	if (fixture.bindings.currentToken) {
		fixture.replay.notifyTargetReady(fixture.bindings.currentToken);
	}
	await fixture.replay.drain();
}

console.log("\n--- content-free classification QA receipt ---");
{
	const fixture = await createFixture();
	await runSuccess(fixture);
	assert.deepEqual(fixture.classifications, [{
		sequence: 1,
		outcome: "claimed",
		reason: "claimed-binding-requested",
		recordId: fixture.codec.record.recordId,
		intentId: fixture.codec.intent.intentId,
		sessionId: fixture.codec.intent.sessionId,
		expectedGeneration: fixture.codec.intent.handoffGeneration,
	}]);
}

console.log("\n--- verifier manual reason remains exact and content-free ---");
{
	const fixture = await createFixture({
		intentOverrides: { userEvent: "other" },
	});
	await runSuccess(fixture);
	assert.deepEqual(fixture.classifications, [{
		sequence: 1,
		outcome: "manual",
		reason: "verify-manual:unsupported-user-event",
		recordId: fixture.codec.record.recordId,
		intentId: fixture.codec.intent.intentId,
		sessionId: fixture.codec.intent.sessionId,
		expectedGeneration: fixture.codec.intent.handoffGeneration,
	}]);
	assert.equal(
		JSON.stringify(fixture.classifications).includes(fixture.codec.intent.afterContent),
		false,
	);
}

console.log("\n--- QA classification observer cannot affect replay authority ---");
{
	const fixture = await createFixture({ classificationObserverThrows: true });
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 1);
	assert.equal(fixture.classifications[0]?.outcome, "claimed");
	assert.equal((await fixture.store.hydrateScope()).terminal[0]?.status, "resolved");
}

console.log("\n--- exact live replay sequence ---");
{
	const fixture = await createFixture();
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 1);
	assert.deepEqual(
		fixture.calls.filter((call) =>
			call !== "store:put"
			&& call !== "deliver:persisting"
			&& call !== "deliver:stored"
			&& call !== "store:drain"),
		[
			"bindings:composition",
			"bindings:target-ready",
			"bindings:target-ready",
			"deliver:recovery-target-binding-requested",
			"controller:plan",
			"store:witness",
			"deliver:replay-pending",
			"controller:permit",
			"bindings:dispatch",
			"controller:receipt",
			"store:receipt",
			"deliver:replayed-awaiting-settlement",
			"controller:observe",
			"store:resolve",
			"deliver:resolved",
		],
	);
	assert.equal(fixture.events.at(-1)?.type, "intent-state-changed");
	assert.deepEqual(
		fixture.events.find((event) => event.type === "recovery-target-binding-requested"),
		{
			type: "recovery-target-binding-requested",
			sessionId: fixture.request.sessionId,
			expectedGeneration: fixture.request.expectedGeneration,
			recoveryOperationEpoch: fixture.request.recoveryOperationEpoch,
			intentId: fixture.codec.intent.intentId,
			recordId: fixture.codec.record.recordId,
		},
	);
	assert.equal(
		fixture.events.at(-1)?.type === "intent-state-changed"
			? fixture.events.at(-1)!.intentState.kind
			: null,
		"resolved",
	);
}

console.log("\n--- target-ready and duplicate wake serialization ---");
{
	const fixture = await createFixture({ targetReady: false });
	await fixture.manual.persistAndClassify(fixture.request);
	await fixture.replay.drain();
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal((await persisted(fixture))?.status, "stored");
	assert.equal(
		fixture.calls.includes("deliver:recovery-target-binding-requested"),
		false,
	);
	assert.equal(
		fixture.classifications[0]?.reason,
		"claimed-awaiting-presentation",
	);
	fixture.bindings.currentToken = fixture.token;
	fixture.replay.notifyTargetPresentationReady(fixture.token);
	fixture.replay.notifyTargetPresentationReady(fixture.token);
	await fixture.replay.drain();
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal(
		fixture.calls.filter((call) =>
			call === "deliver:recovery-target-binding-requested").length,
		1,
	);
	fixture.replay.notifyTargetReady(fixture.token);
	fixture.replay.notifyTargetReady(fixture.token);
	await fixture.replay.drain();
	assert.equal(fixture.bindings.dispatches, 1);
}

console.log("\n--- proven target reducer rejection demotes instead of waiting ---");
{
	const fixture = await createFixture({
		accept: (event) => event.type !== "recovery-target-binding-requested",
	});
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal((await persisted(fixture))?.status, "needs-review");
	assert.equal(fixture.classifications[0]?.outcome, "manual");
	assert.equal(fixture.classifications[0]?.reason, "binding-request-rejected");
}

console.log("\n--- rejected reducer delivery consumes no permit ---");
{
	const fixture = await createFixture({
		accept: (event) => event.type !== "intent-state-changed"
			|| event.intentState.kind !== "replay-pending",
	});
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal(fixture.calls.includes("controller:permit"), false);
	assert.equal((await persisted(fixture))?.status, "needs-review");
}

console.log("\n--- mutate-then-throw convergence ---");
for (const fault of ["witness-after", "receipt-after", "resolve-after"] as const) {
	const fixture = await createFixture({ fault });
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 1, `${fault} dispatch count`);
	const hydration = await fixture.store.hydrateScope();
	assert.equal(hydration.active.length, 0, `${fault} has no active record`);
	assert.equal(hydration.terminal[0]?.status, "resolved", `${fault} converges terminal`);
}

console.log("\n--- precommit witness failure stays manual and never dispatches ---");
for (const fault of ["witness-before", "witness-wrong-result"] as const) {
	const fixture = await createFixture({ fault });
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal((await persisted(fixture))?.status, "needs-review");
}

console.log("\n--- ambiguous manual CAS converges without redispatch ---");
for (const fault of ["cas-before", "cas-after"] as const) {
	const fixture = await createFixture({
		fault,
		accept: (event) => event.type !== "intent-state-changed"
			|| event.intentState.kind !== "replay-pending",
	});
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 0, `${fault} dispatch count`);
	const active = await persisted(fixture);
	assert.equal(
		active?.status,
		fault === "cas-after" ? "needs-review" : "replay-pending",
	);
}

console.log("\n--- pending settlement wakes exactly once ---");
{
	const fixture = await createFixture({
		observations: [
			{ kind: "pending", reason: "disk-not-yet-saved" },
			{ kind: "settled" },
		],
	});
	await runSuccess(fixture);
	assert.equal((await persisted(fixture))?.status, "replayed-awaiting-settlement");
	fixture.replay.notifySettlementMayHaveAdvanced(fixture.codec.intent.targetPath);
	fixture.replay.notifySettlementMayHaveAdvanced(fixture.codec.intent.targetPath);
	await fixture.replay.drain();
	assert.equal(fixture.bindings.dispatches, 1);
	const hydration = await fixture.store.hydrateScope();
	assert.equal(hydration.terminal[0]?.status, "resolved");
}

console.log("\n--- Clear fences terminal delivery during async validation ---");
{
	const validationEntered = deferred();
	const releaseValidation = deferred();
	let pauseTerminalValidation = false;
	const fixture = await createFixture({
		observations: [
			{ kind: "pending", reason: "disk-not-yet-saved" },
			{ kind: "settled" },
		],
		validateRecord: async (record) => {
			if (
				pauseTerminalValidation
				&& typeof record === "object"
				&& record !== null
				&& "status" in record
				&& record.status === "resolved"
			) {
				validationEntered.resolve();
				await releaseValidation.promise;
			}
			return validateHandoffRecoveryRecord(record);
		},
	});
	await runSuccess(fixture);
	assert.equal((await persisted(fixture))?.status, "replayed-awaiting-settlement");
	fixture.events.length = 0;
	pauseTerminalValidation = true;
	fixture.replay.notifySettlementMayHaveAdvanced(fixture.codec.intent.targetPath);
	await validationEntered.promise;
	const clear = fixture.manual.clearCurrentScope();
	releaseValidation.resolve();
	await clear;
	assert.equal(
		fixture.events.some((event) =>
			event.type === "intent-state-changed"
			&& event.intentState.kind === "resolved"),
		false,
	);
}

console.log("\n--- missing durable row exposes a content-free failed gate ---");
{
	const fixture = await createFixture({ fault: "witness-missing" });
	await runSuccess(fixture);
	assert.equal(fixture.bindings.dispatches, 0);
	const last = fixture.events.at(-1);
	assert.equal(last?.type, "intent-state-changed");
	if (last?.type !== "intent-state-changed") throw new Error("missing failed event");
	assert.deepEqual(last.intentState, {
		kind: "failed",
		intentId: fixture.codec.intent.intentId,
		reason: "recovery-store-missing",
	});
	assert.equal(JSON.stringify(last).includes(fixture.codec.intent.afterContent), false);
}

console.log("\n--- reentrant Clear retires permit before dispatch ---");
{
	let fixture!: Fixture;
	fixture = await createFixture({
		accept: (event) => {
			if (
				event.type === "intent-state-changed"
				&& event.intentState.kind === "replay-pending"
			) fixture.replay.invalidateForRecoveryClear();
			return true;
		},
	});
	await fixture.manual.persistAndClassify(fixture.request);
	fixture.replay.notifyTargetReady(fixture.token);
	await fixture.replay.drainAndDemoteForRecoveryClear();
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal(fixture.calls.includes("controller:permit"), false);
	assert.equal((await persisted(fixture))?.status, "needs-review");
}

console.log("\n--- explicit manual choice is executable without target readiness ---");
{
	const fixture = await createFixture({ targetReady: false });
	await fixture.manual.persistAndClassify(fixture.request);
	fixture.calls.length = 0;
	await fixture.manual.continueWithoutAutomaticApply(fixture.request);
	await fixture.replay.drain();
	assert.equal(fixture.controller.invalidations, 1);
	assert.equal(fixture.calls.includes("controller:invalidate"), false);
	assert.equal(
		fixture.calls.includes(`controller:invalidate:${fixture.codec.record.recordId}`),
		true,
	);
	assert.equal(fixture.calls[0], `controller:invalidate:${fixture.codec.record.recordId}`);
	assert.equal(fixture.calls[1], "store:hydrate");
	assert.equal(fixture.bindings.dispatches, 0);
	assert.equal((await persisted(fixture))?.status, "needs-review");
}

console.log("\n--- Clear drains and fences a delegated manual continuation ---");
{
	const fixture = await createFixture({ targetReady: false });
	await fixture.manual.persistAndClassify(fixture.request);
	fixture.calls.length = 0;
	fixture.events.length = 0;
	const entered = deferred();
	const release = deferred();
	fixture.store.afterNextHydrate = async () => {
		entered.resolve();
		await release.promise;
	};
	const continuation = fixture.manual.continueWithoutAutomaticApply(fixture.request);
	await entered.promise;
	let clearSettled = false;
	const clear = fixture.manual.clearCurrentScope().then((result) => {
		clearSettled = true;
		return result;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(clearSettled, false);
	assert.equal(fixture.calls.includes("store:clear"), false);
	release.resolve();
	await Promise.all([continuation, clear]);
	const clearIndex = fixture.calls.lastIndexOf("store:clear");
	assert.notEqual(clearIndex, -1);
	assert.deepEqual(
		fixture.calls.slice(clearIndex + 1).filter((call) => call.startsWith("deliver:")),
		[],
	);
	assert.equal(fixture.events.length, 0);
}

console.log("\n--- a newer manual action fences delegated continuation delivery ---");
{
	const fixture = await createFixture({ targetReady: false });
	await fixture.manual.persistAndClassify(fixture.request);
	fixture.events.length = 0;
	const entered = deferred();
	const release = deferred();
	fixture.store.afterNextHydrate = async () => {
		entered.resolve();
		await release.promise;
	};
	const continuation = fixture.manual.continueWithoutAutomaticApply(fixture.request);
	await entered.promise;
	await fixture.manual.discardAndContinue(fixture.request);
	release.resolve();
	await continuation;
	assert.deepEqual(
		fixture.events
			.filter((event) => event.type === "intent-state-changed")
			.map((event) => event.intentState.kind),
		["discarded"],
	);
}

console.log("\n--- hydration observes awaiting rows but cannot dispatch ---");
{
	const live = await createFixture({
		observations: [{ kind: "pending", reason: "disk-not-yet-saved" }],
	});
	await runSuccess(live);
	assert.equal((await persisted(live))?.status, "replayed-awaiting-settlement");
	const restartedController = new RecordingController(live.token, live.calls);
	restartedController.observations = [{ kind: "settled" }];
	const restartedBindings = new RecordingBindings(live.token, live.calls);
	const restarted = new HandoffReplayCoordinator({
		store: live.store,
		controller: restartedController,
		editorBindings: restartedBindings,
		isScopeCurrent: () => true,
	});
	const hydrationCoordinator = new ManualHandoffRecoveryCoordinator({
		store: live.store,
		isScopeCurrent: () => true,
		observeAwaitingSettlement: restarted.observeHydratedAwaitingSettlement,
	});
	await hydrationCoordinator.hydrateScope();
	assert.equal(restartedBindings.dispatches, 0);
	assert.equal(live.bindings.dispatches, 1);
	const hydration = await live.store.hydrateScope();
	assert.equal(hydration.terminal[0]?.status, "resolved");
}

console.log("handoff replay coordinator regressions passed");
