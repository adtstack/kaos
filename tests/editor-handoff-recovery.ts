import assert from "node:assert/strict";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { TFile } from "obsidian";
import {
	ManualHandoffRecoveryCoordinator,
	type HandoffRecoveryPort,
	type HandoffRecoveryRuntimeRequest,
} from "../src/runtime/handoffRecoveryCoordinator";
import type {
	EditorHandoffEffect,
	EditorHandoffEvent,
	HandoffInputIntent,
	ManagedLeafSession,
} from "../src/sync/editorHandoffState";
import { EditorBindingManager } from "../src/sync/editorBinding";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	createStoredHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type ClearHandoffRecoveryScopeResult,
	type HandoffRecoveryApplyWitness,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryHydrationResult,
	type HandoffRecoveryRecord,
	type HandoffRecoveryScope,
	type HandoffRecoveryStatusTransition,
	type HandoffRecoveryStore,
	type PutHandoffRecoveryIntentResult,
	type ResolveHandoffRecoveryRequest,
	type ResolveHandoffRecoveryResult,
} from "../src/sync/handoffRecoveryStore";

class FakeTFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

function makeIntent(intentId = "intent-a"): HandoffInputIntent {
	const startDocument = Text.of(["alpha"]);
	return {
		intentId,
		sessionId: "boot-a",
		leafId: "leaf-a",
		handoffGeneration: 4,
		fromPath: "A.md",
		fromFileId: "file-a",
		targetPath: "B.md",
		targetFile: new FakeTFile("B.md"),
		bindingEpoch: 7,
		inputEpoch: 9,
		switchIntentSeq: 11,
		inputStartSeq: 12,
		inputStartedUnderSwitchSeq: 11,
		compositionEpoch: null,
		selectionEpoch: 3,
		sequenceBegan: "after-target-selected",
		startDocument,
		startContentHash: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
		changes: ChangeSet.of([{ from: 5, insert: "!" }], 5),
		afterContent: "alpha!",
		afterContentHash: "0f467074706d62a9d82bd6cb0acbace1f1d2c8a1cc8b94bb44bd4fb47e654d54",
		selectionBefore: EditorSelection.single(5),
		selectionAfter: EditorSelection.single(6),
		originKind: "user",
		userEvent: "input",
		capturedAt: 1_800_000_000_000,
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const SCOPE: HandoffRecoveryScope = {
	schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
	vaultId: "vault-a",
	localDeviceId: "local-device-a",
};

const EMPTY_HYDRATION: HandoffRecoveryHydrationResult = {
	status: "missing",
	active: [],
	terminal: [],
	issues: [],
	totalBytes: 0,
};

class ScriptedRecoveryStore implements HandoffRecoveryStore {
	readonly scope = SCOPE;
	putCalls: HandoffInputIntent[] = [];
	compareCalls = 0;
	applyWitnessCalls = 0;
	dispatchReceiptCalls = 0;
	resolveCalls: ResolveHandoffRecoveryRequest[] = [];
	drainCalls = 0;
	clearCalls = 0;
	lastRecord: HandoffRecoveryRecord | null = null;
	putHandler: (
		intent: HandoffInputIntent,
	) => Promise<PutHandoffRecoveryIntentResult> = async (intent) => {
		if (this.lastRecord) return { kind: "existing", record: this.lastRecord };
		const record = await createStoredHandoffRecoveryRecord(
			this.scope,
			intent,
			1_800_000_000_100,
		);
		this.lastRecord = record;
		return { kind: "stored", record };
	};
	compareHandler: (
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	) => Promise<HandoffRecoveryCasResult> = async () => {
		if (!this.lastRecord || !("body" in this.lastRecord)) return { kind: "missing" };
		const record = {
			...this.lastRecord,
			status: "needs-review",
			checksum: "b".repeat(64),
		} as ActiveHandoffRecoveryRecord;
		this.lastRecord = record;
		return { kind: "updated", record };
	};
	resolveHandler: (
		request: ResolveHandoffRecoveryRequest,
	) => Promise<ResolveHandoffRecoveryResult> = async (request) => {
		if (request.kind === "precommit-escape") {
			if (this.lastRecord) {
				return { kind: "retained", action: request.action, record: this.lastRecord };
			}
			return { kind: "escaped", action: request.action, recordId: null };
		}
		return { kind: "missing" };
	};
	hydration = EMPTY_HYDRATION;
	clearResult: ClearHandoffRecoveryScopeResult = { kind: "cleared", deletedCount: 0 };
	drainHandler: () => Promise<void> = async () => {};

	async putIntent(intent: HandoffInputIntent): Promise<PutHandoffRecoveryIntentResult> {
		this.putCalls.push(intent);
		return this.putHandler(intent);
	}

	async compareAndSetStatus(
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	): Promise<HandoffRecoveryCasResult> {
		this.compareCalls++;
		return this.compareHandler(recordId, expectedChecksum, transition);
	}

	async storeApplyWitness(
		_recordId: string,
		_expectedChecksum: string,
		_witness: HandoffRecoveryApplyWitness,
	): Promise<HandoffRecoveryCasResult> {
		this.applyWitnessCalls++;
		return { kind: "missing" };
	}

	async storeDispatchReceipt(
		_recordId: string,
		_expectedChecksum: string,
		_dispatchReceiptHash: string,
	): Promise<HandoffRecoveryCasResult> {
		this.dispatchReceiptCalls++;
		return { kind: "missing" };
	}

	async resolveRecord(
		request: ResolveHandoffRecoveryRequest,
	): Promise<ResolveHandoffRecoveryResult> {
		this.resolveCalls.push(request);
		return this.resolveHandler(request);
	}

	async hydrateScope(): Promise<HandoffRecoveryHydrationResult> {
		return this.hydration;
	}

	async clearScope(): Promise<ClearHandoffRecoveryScopeResult> {
		this.clearCalls++;
		return this.clearResult;
	}

	async drain(): Promise<void> {
		this.drainCalls++;
		await this.drainHandler();
	}
}

function makeRequest(
	intent: HandoffInputIntent,
	delivered: EditorHandoffEvent[],
	recoveryOperationEpoch = 1,
	accept: (event: Extract<EditorHandoffEvent, { type: "intent-state-changed" }>) => boolean = () => true,
): HandoffRecoveryRuntimeRequest {
	return {
		sessionId: intent.sessionId,
		expectedGeneration: intent.handoffGeneration,
		recoveryOperationEpoch,
		intent,
		deliver(event) {
			if (!accept(event)) return false;
			delivered.push(event);
			return true;
		},
	};
}

const delivered: EditorHandoffEvent[] = [];
const primaryMutations = {
	ensureFile: 0,
	ytext: 0,
	vaultCreate: 0,
	vaultModify: 0,
	requestSave: 0,
};
const request = {
	sessionId: "boot-a",
	expectedGeneration: 4,
	recoveryOperationEpoch: 1,
	intent: makeIntent(),
	deliver: (event: Extract<EditorHandoffEvent, { type: "intent-state-changed" }>) => {
		delivered.push(event);
		return true;
	},
} satisfies HandoffRecoveryRuntimeRequest;

assert.deepEqual(primaryMutations, {
	ensureFile: 0,
	ytext: 0,
	vaultCreate: 0,
	vaultModify: 0,
	requestSave: 0,
});
assert.equal(request.intent.targetPath, "B.md");
assert.equal(typeof ManualHandoffRecoveryCoordinator, "function");

console.log("\n--- Manual Handoff Recovery: verified store becomes needs-review ---");
{
	const store = new ScriptedRecoveryStore();
	const events: EditorHandoffEvent[] = [];
	let classifyCalls = 0;
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
		classifyStoredIntent: async () => {
			classifyCalls++;
			return "manual";
		},
	});
	await coordinator.persistAndClassify(makeRequest(makeIntent("manual-intent"), events));
	assert.deepEqual(
		events.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["persisting", "stored", "needs-review"],
	);
	assert.equal(classifyCalls, 1);
	assert.equal(store.compareCalls, 1);
	assert.equal(store.applyWitnessCalls, 0);
	assert.equal(store.dispatchReceiptCalls, 0);
}

console.log("\n--- Manual Handoff Recovery: duplicate existing row bypasses replay classifier ---");
{
	const store = new ScriptedRecoveryStore();
	const record = await createStoredHandoffRecoveryRecord(
		SCOPE,
		makeIntent("existing-intent"),
		1_800_000_000_100,
	);
	store.lastRecord = {
		...record,
		status: "needs-review",
		checksum: "c".repeat(64),
	};
	let classifyCalls = 0;
	const events: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
		classifyStoredIntent: async () => {
			classifyCalls++;
			return "claimed";
		},
	});
	await coordinator.persistAndClassify(makeRequest(makeIntent("existing-intent"), events));
	assert.equal(classifyCalls, 0);
	assert.equal(store.compareCalls, 0);
	assert.deepEqual(
		events.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["persisting", "needs-review", "needs-review"],
	);
}

console.log("\n--- Manual Handoff Recovery: operational failures stay content-free and gated ---");
{
	const store = new ScriptedRecoveryStore();
	store.putHandler = async () => {
		throw new DOMException("private body must not surface", "QuotaExceededError");
	};
	const events: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	await coordinator.persistAndClassify(makeRequest(makeIntent("failed-intent"), events));
	const last = events.at(-1);
	assert.equal(last?.type, "intent-state-changed");
	if (last?.type !== "intent-state-changed") throw new Error("missing failed event");
	assert.deepEqual(last.intentState, {
		kind: "failed",
		intentId: "failed-intent",
		reason: "quota-exceeded",
	});
	assert.doesNotMatch(JSON.stringify(last), /alpha|private body/i);
}

console.log("\n--- Manual Handoff Recovery: an unavailable store still permits explicit escape ---");
{
	const store = new ScriptedRecoveryStore();
	store.putHandler = async () => {
		throw new Error("IndexedDB unavailable");
	};
	const events: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const intent = makeIntent("unavailable-store-escape");
	await coordinator.persistAndClassify(makeRequest(intent, events, 1));
	assert.equal(
		events.at(-1)?.type === "intent-state-changed"
			? events.at(-1)?.intentState.kind
			: null,
		"failed",
	);
	await coordinator.copyAndContinue(
		makeRequest(intent, events, 2),
		async (text) => assert.equal(text, intent.afterContent),
	);
	const escaped = events.at(-1);
	assert.equal(escaped?.type, "intent-state-changed");
	if (escaped?.type !== "intent-state-changed") throw new Error("missing escape event");
	assert.deepEqual(escaped.intentState, {
		kind: "escaped",
		intentId: intent.intentId,
		action: "copy",
		recordId: null,
	});
	assert.equal(store.resolveCalls.length, 1);
}

console.log("\n--- Manual Handoff Recovery: copy failure does not fence or release ---");
{
	const store = new ScriptedRecoveryStore();
	const events: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	await coordinator.copyAndContinue(
		makeRequest(makeIntent("copy-failure"), events, 2),
		async () => {
			throw new Error("clipboard rejected");
		},
	);
	assert.deepEqual(
		events.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["escape-pending", "failed"],
	);
	assert.equal(store.resolveCalls.length, 0);
}

console.log("\n--- Manual Handoff Recovery: a newer escape fences a hung effect for only that intent ---");
{
	const store = new ScriptedRecoveryStore();
	const clipboard = deferred<void>();
	const events: EditorHandoffEvent[] = [];
	const intent = makeIntent("replace-hung-copy");
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const hungCopy = coordinator.copyAndContinue(
		makeRequest(intent, events, 2),
		async () => clipboard.promise,
	);
	await Promise.resolve();
	await coordinator.discardAndContinue(makeRequest(intent, events, 3));
	clipboard.resolve();
	await hungCopy;
	assert.deepEqual(
		store.resolveCalls.map((call) =>
			call.kind === "precommit-escape" ? call.action : call.kind),
		["discard"],
		"the replaced Copy cannot reach the store after the newer Discard",
	);
	assert.equal(
		events.some((event) => event.type === "intent-state-changed"
			&& event.recoveryOperationEpoch === 2
			&& event.intentState.kind === "escaped"),
		false,
	);
}

console.log("\n--- Manual Handoff Recovery: successful explicit escapes carry only the current epoch ---");
{
	const store = new ScriptedRecoveryStore();
	const pendingPut = deferred<PutHandoffRecoveryIntentResult>();
	store.putHandler = async () => pendingPut.promise;
	let currentRecoveryEpoch = 1;
	const events: EditorHandoffEvent[] = [];
	const acceptCurrentEpoch = (
		event: Extract<EditorHandoffEvent, { type: "intent-state-changed" }>,
	) => event.recoveryOperationEpoch === currentRecoveryEpoch;
	const intent = makeIntent("late-copy-intent");
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const oldPersist = coordinator.persistAndClassify(
		makeRequest(intent, events, 1, acceptCurrentEpoch),
	);
	await Promise.resolve();
	currentRecoveryEpoch = 2;
	await coordinator.copyAndContinue(
		makeRequest(intent, events, 2, acceptCurrentEpoch),
		async (text) => assert.equal(text, "alpha!"),
	);
	pendingPut.resolve({
		kind: "fenced",
		action: "copy",
		retainedRecord: null,
	});
	await oldPersist;
	assert.equal(
		events.some((event) => event.type === "intent-state-changed"
			&& event.recoveryOperationEpoch === 1
			&& (event.intentState.kind === "escaped" || event.intentState.kind === "needs-review")),
		false,
	);
	const currentLast = events.at(-1);
	assert.equal(currentLast?.type, "intent-state-changed");
	if (currentLast?.type !== "intent-state-changed") throw new Error("missing current escape");
	assert.deepEqual(currentLast.intentState, {
		kind: "escaped",
		intentId: intent.intentId,
		action: "copy",
		recordId: null,
	});
}

console.log("\n--- Manual Handoff Recovery: scope rotation suppresses late delivery ---");
{
	const store = new ScriptedRecoveryStore();
	const pendingPut = deferred<PutHandoffRecoveryIntentResult>();
	store.putHandler = async () => pendingPut.promise;
	let scopeCurrent = true;
	const events: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => scopeCurrent,
	});
	const pending = coordinator.persistAndClassify(
		makeRequest(makeIntent("rotated-intent"), events),
	);
	await Promise.resolve();
	scopeCurrent = false;
	const record = await createStoredHandoffRecoveryRecord(
		SCOPE,
		makeIntent("rotated-intent"),
		1_800_000_000_100,
	);
	pendingPut.resolve({ kind: "stored", record });
	await pending;
	assert.deepEqual(
		events.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["persisting"],
	);
}

console.log("\n--- Manual Handoff Recovery: one leaf cannot cancel another leaf's store completion ---");
{
	const store = new ScriptedRecoveryStore();
	const pendingPut = deferred<PutHandoffRecoveryIntentResult>();
	const intentA = makeIntent("concurrent-intent-a");
	const intentB: HandoffInputIntent = {
		...makeIntent("concurrent-intent-b"),
		sessionId: "boot-b",
		leafId: "leaf-b",
	};
	store.putHandler = async (intent) => {
		assert.equal(intent.intentId, intentA.intentId);
		return pendingPut.promise;
	};
	const storedB = await createStoredHandoffRecoveryRecord(
		SCOPE,
		intentB,
		1_800_000_000_100,
	);
	const manualB = {
		...storedB,
		status: "needs-review",
		checksum: "d".repeat(64),
	} as ActiveHandoffRecoveryRecord;
	store.hydration = {
		status: "loaded",
		active: [manualB],
		terminal: [],
		issues: [],
		totalBytes: 0,
	};
	const eventsA: EditorHandoffEvent[] = [];
	const eventsB: EditorHandoffEvent[] = [];
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const pendingA = coordinator.persistAndClassify(makeRequest(intentA, eventsA));
	await Promise.resolve();
	await coordinator.continueWithoutAutomaticApply(makeRequest(intentB, eventsB));
	const storedA = await createStoredHandoffRecoveryRecord(
		SCOPE,
		intentA,
		1_800_000_000_200,
	);
	store.lastRecord = storedA;
	pendingPut.resolve({ kind: "stored", record: storedA });
	await pendingA;
	assert.deepEqual(
		eventsB.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["needs-review"],
	);
	assert.deepEqual(
		eventsA.map((event) => event.type === "intent-state-changed" ? event.intentState.kind : event.type),
		["persisting", "stored", "needs-review"],
		"manual continuation in leaf B does not strand leaf A in persisting",
	);
}

console.log("\n--- Editor binding: frozen persist effect is generation and port scoped ---");
{
	const pendingPersist = deferred<void>();
	const requests: HandoffRecoveryRuntimeRequest[] = [];
	const acceptedIntentStates: unknown[] = [];
	const port: HandoffRecoveryPort = {
		persistAndClassify: async (runtimeRequest) => {
			requests.push(runtimeRequest);
			await pendingPersist.promise;
		},
		async copyAndContinue() {},
		async exportAndContinue() {},
		async discardAndContinue() {},
		async continueWithoutAutomaticApply() {},
		async retrySettlement() {},
		async hydrateScope() { return EMPTY_HYDRATION; },
		async getRecord() { throw new Error("unused"); },
		async clearCurrentScope() { return { kind: "cleared", deletedCount: 0 }; },
		async drain() {},
	};
	const manager = new EditorBindingManager(
		{} as never,
		false,
		() => true,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		port,
		{
			async writeClipboard() {},
			async chooseVerifiedExporter() { return null; },
			async confirmDiscard() { return false; },
			observeAcceptedIntentState: (observation: unknown) => {
				acceptedIntentStates.push(observation);
				throw new Error("diagnostic observer must not affect Recovery delivery");
			},
		},
	);
	const intent = makeIntent("manager-intent");
	let gateRefreshes = 0;
	const session: ManagedLeafSession = {
		sessionId: intent.sessionId,
		leafId: intent.leafId,
		generation: intent.handoffGeneration,
		eventOrderSeq: intent.switchIntentSeq,
		currentSwitchIntentSeq: intent.switchIntentSeq,
		nativeHistoryEpoch: 0,
		completedDetachEpoch: intent.bindingEpoch,
		activeRecoveries: [{
			sessionId: intent.sessionId,
			handoffGeneration: intent.handoffGeneration,
			recoveryOperationEpoch: 1,
			intentState: { kind: "persisting", intentId: intent.intentId },
			intent,
		}],
		pendingInputStartReservation: null,
		view: {
			file: intent.targetFile,
			leaf: { id: intent.leafId },
			editor: { getValue: () => "target" },
		} as never,
		displayedLineage: { kind: "unknown" },
		binding: { kind: "unbound" },
		handoff: {
			sourceAuthorityPath: intent.fromPath,
			sourceUnloadReceiptId: "source-unload:recovery:1",
			targetPath: intent.targetPath,
			targetFile: intent.targetFile,
			bindingEpochAfterDetach: intent.bindingEpoch,
			presentation: "target-proven",
			targetReadyTokenId: "target-ready",
			inputGateInstalled: true,
			saveGuardInstalled: false,
			recoveryOperationEpoch: 1,
			recoveryTargetBindingRequest: null,
			intentState: { kind: "persisting", intentId: intent.intentId },
			phase: "awaiting-recovery-commit",
			pendingHostLoadCandidate: null,
		},
	};
	const runtime = {
		session,
		hostGuard: null,
		cmGuard: { refreshGate: () => { gateRefreshes++; return true; } },
		capturedSourceAuthority: null,
		targetWorkflow: Object.freeze({ targetPath: intent.targetPath }),
	};
	let bindingAdmissionRequests = 0;
	(manager as unknown as {
		requestTargetBindingAdmission(runtime: unknown, workflow: unknown): void;
	}).requestTargetBindingAdmission = (candidateRuntime, candidateWorkflow) => {
		assert.equal(candidateRuntime, runtime);
		assert.equal(candidateWorkflow, runtime.targetWorkflow);
		bindingAdmissionRequests++;
	};
	(manager as unknown as { managedSessions: Map<string, unknown> })
		.managedSessions.set(intent.leafId, runtime);
	const effect: Extract<EditorHandoffEffect, { type: "persist-intent" }> = {
		type: "persist-intent",
		sessionId: intent.sessionId,
		expectedGeneration: intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intent,
	};
	const apply = (manager as unknown as {
		applyHandoffEffects(
			runtime: unknown,
			effects: readonly EditorHandoffEffect[],
			reason: string,
		): void;
	}).applyHandoffEffects.bind(manager);
	apply(runtime, [effect], "test");
	apply(runtime, [effect], "duplicate-test");
	assert.equal(requests.length, 1, "duplicate effect shares one live persistence operation");
	assert.equal(requests[0]?.deliver({
		type: "intent-state-changed",
		sessionId: intent.sessionId,
		expectedGeneration: intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "stored",
			intentId: intent.intentId,
			recordId: "record-manager",
		},
	}), true);
	assert.equal(runtime.session.handoff?.intentState.kind, "stored");
	assert.equal(requests[0]?.deliver({
		type: "intent-state-changed",
		sessionId: intent.sessionId,
		expectedGeneration: intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "needs-review",
			intentId: intent.intentId,
			recordId: "record-manager",
		},
	}), true);
	assert.equal(runtime.session.handoff?.inputGateInstalled, false);
	assert.equal(runtime.session.handoff?.phase, "target-ready");
	assert.deepEqual(acceptedIntentStates, [
		{
			leafId: intent.leafId,
			sessionId: intent.sessionId,
			generation: intent.handoffGeneration,
			recoveryOperationEpoch: 1,
			intentId: intent.intentId,
			fromPath: intent.fromPath,
			targetPath: intent.targetPath,
			startContentHash: intent.startContentHash,
			afterContentHash: intent.afterContentHash,
			state: "stored",
			action: null,
		},
		{
			leafId: intent.leafId,
			sessionId: intent.sessionId,
			generation: intent.handoffGeneration,
			recoveryOperationEpoch: 1,
			intentId: intent.intentId,
			fromPath: intent.fromPath,
			targetPath: intent.targetPath,
			startContentHash: intent.startContentHash,
			afterContentHash: intent.afterContentHash,
			state: "needs-review",
			action: null,
		},
	], "accepted content-free states survive observer failure in exact order");
	assert.equal(
		bindingAdmissionRequests,
		1,
		"needs-review immediately resumes target binding admission",
	);
	assert.ok(gateRefreshes > 0);
	assert.equal(manager.replaceHandoffRecoveryPort(null, 1), true);
	assert.equal(requests[0]?.deliver({
		type: "intent-state-changed",
		sessionId: intent.sessionId,
		expectedGeneration: intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intentState: {
			kind: "resolved",
			intentId: intent.intentId,
			recordId: "record-manager",
		},
	}), false, "retired port cannot deliver into the leaf");
	assert.equal(acceptedIntentStates.length, 2, "rejected stale delivery emits no receipt");
	runtime.session = {
		...runtime.session,
		handoff: runtime.session.handoff && {
			...runtime.session.handoff,
			inputGateInstalled: true,
			intentState: {
				kind: "escape-pending",
				intentId: intent.intentId,
				action: "copy",
			},
			phase: "awaiting-recovery-decision",
		},
	};
	const escapePendingModel = (manager as unknown as {
		getHandoffRecoveryGateModel(leafId: string): unknown;
	}).getHandoffRecoveryGateModel(intent.leafId);
	assert.deepEqual(escapePendingModel, {
		state: "escape-pending",
		message: "Completing the selected recovery action…",
		actions: ["copy-and-continue", "export-and-continue", "discard-and-continue"],
	});
	pendingPersist.resolve();
	await pendingPersist.promise;
}

console.log("manual handoff recovery coordinator tests passed");
