import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { TFile, TFolder } from "obsidian";
import { exportHandoffRecoveryBody } from "../src/sync/handoffRecoveryExport";
import { ManualHandoffRecoveryCoordinator } from "../src/runtime/handoffRecoveryCoordinator";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import type { HandoffInputIntent } from "../src/sync/editorHandoffState";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	buildHandoffRecoveryScopeKey,
	canonicalHandoffRecoveryJson,
	createStoredHandoffRecoveryRecord,
	sha256HandoffRecoveryHex,
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
	type TerminalHandoffRecoveryReceipt,
} from "../src/sync/handoffRecoveryStore";

const mainSource = readFileSync("src/main.ts", "utf8");
assert.match(mainSource, /getOrCreateLocalDeviceIdentity/);
assert.match(mainSource, /initializeHandoffRecovery/);
assert.match(mainSource, /hydrateScope\(\)/);
assert.match(mainSource, /drain\(\)/);
assert.doesNotMatch(mainSource, /_handoffRecovery(?:Body|Records|Journal)/);
void exportHandoffRecoveryBody;

function sourceBetween(start: string, end: string): string {
	const startIndex = mainSource.indexOf(start);
	const endIndex = mainSource.indexOf(end, startIndex + start.length);
	assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
	assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
	return mainSource.slice(startIndex, endIndex);
}

const scopeRotationSource = sourceBetween(
	"private rotateHandoffRecoveryScope(",
	"private async initializeHandoffRecovery(",
);
const scopeInitializationSource = sourceBetween(
	"private async initializeHandoffRecovery(",
	"private applyRuntimeSettings(",
);
assert.doesNotMatch(scopeRotationSource, /host|deviceName/);
assert.ok(
	scopeRotationSource.indexOf("++this.handoffRecoveryActivationEpoch")
		< scopeRotationSource.indexOf("initializeHandoffRecovery("),
	"scope epoch advances before asynchronous manual hydration starts",
);
assert.doesNotMatch(
	scopeRotationSource,
	/replaceHandoffRecoveryPort/,
	"scope rotation has no editor recovery/replay port",
);
assert.match(
	scopeRotationSource,
	/requestedScopeKey !== null[\s\S]*handoffRecoveryCoordinator !== null/,
	"a same-scope cold-start retry is skipped only after the manual coordinator exists",
);
assert.doesNotMatch(
	scopeInitializationSource,
	/HandoffReplayCoordinator|classifyStoredIntent|replayActions|observeAwaitingSettlement/,
	"scope activation cannot wire persisted rows back into automatic editor replay",
);
assert.match(
	sourceBetween("private applyRuntimeSettings(", "private buildEffectiveRuntimeConfig("),
	/rotateHandoffRecoveryScope\(reason\)/,
);
assert.doesNotMatch(
	scopeInitializationSource,
	/replaceHandoffRecoveryPort/,
	"hydration never attaches stored rows to the editor",
);
assert.doesNotMatch(
	sourceBetween("// 2. EditorBindingManager", "// 3. Global CM6 extension"),
	/handoffRecoveryCoordinator|HandoffReplayCoordinator/,
	"manager construction has no recovery apply or replay port",
);
assert.match(
	sourceBetween("// 2. EditorBindingManager", "// 3. Global CM6 extension"),
	/this\.rotateHandoffRecoveryScope\("editor-bindings-ready"\)/,
	"cold start explicitly retries manual Recovery activation after editor startup",
);
for (const source of [
	sourceBetween("private async teardownSync(", "private resetLocalCache("),
	sourceBetween("private resetLocalCache(", "private nuclearReset("),
	sourceBetween("private nuclearReset(", "private startSnapshotMaintenanceTimers("),
	sourceBetween("onunload()", "private createBaselineTextRepository("),
]) {
	assert.doesNotMatch(source, /clearCurrentScope|handoffRecoveryStore\??\.clear|delete.*handoff/i);
}

class FakeFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

class FakeFolder extends TFolder {
	constructor(readonly path: string) {
		super();
	}
}

const RECOVERY_SCOPE: HandoffRecoveryScope = {
	schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
	vaultId: "vault-a",
	localDeviceId: "device-a",
};

function makeIntent(intentId: string): HandoffInputIntent {
	const startDocument = Text.of(["alpha"]);
	return {
		intentId,
		sessionId: "boot-a",
		leafId: "leaf-a",
		handoffGeneration: 4,
		fromPath: "A.md",
		fromFileId: "file-a",
		targetPath: "B.md",
		targetFile: new FakeFile("B.md"),
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

async function withRecoveryChecksum<T extends HandoffRecoveryRecord>(
	record: T,
): Promise<T> {
	const { checksum: _checksum, ...withoutChecksum } = record;
	return {
		...withoutChecksum,
		checksum: await sha256HandoffRecoveryHex(
			canonicalHandoffRecoveryJson(withoutChecksum),
		),
	} as T;
}

function recoveryPayload(
	record: ActiveHandoffRecoveryRecord,
): Omit<ActiveHandoffRecoveryRecord, "status" | "checksum"> {
	const { status: _status, checksum: _checksum, ...payload } = record;
	return payload;
}

function makeApplyWitness(
	record: ActiveHandoffRecoveryRecord,
	dispatchReceiptHash: string | null,
): HandoffRecoveryApplyWitness {
	return {
		planId: `plan:${record.recordId}`,
		kind: "exact-replay",
		switchIntentSeq: record.body.eventProof.switchIntentSeq,
		hostLoadTokenId: "host-load-1",
		targetFileId: "file-b",
		targetYtextIdentity: "ytext-b",
		targetMutationEpochAtPlan: 0,
		nativeHistoryEpoch: 1,
		targetSelectionEpoch: 1,
		targetScrollEpoch: 1,
		plannedStartHash: record.startContentHash,
		plannedResultContent: record.body.afterContent,
		plannedResultHash: record.afterContentHash,
		serializedMappedSelection: record.body.serializedSelectionAfter,
		dispatchReceiptHash,
	};
}

async function makeAwaitingRecord(
	intentId: string,
): Promise<ActiveHandoffRecoveryRecord & Readonly<{
	status: "replayed-awaiting-settlement";
}>> {
	const stored = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent(intentId),
		1_800_000_000_100,
	);
	return withRecoveryChecksum({
		...stored,
		status: "replayed-awaiting-settlement",
		applyWitness: makeApplyWitness(stored, "9".repeat(64)),
	} as ActiveHandoffRecoveryRecord & Readonly<{
		status: "replayed-awaiting-settlement";
	}>);
}

class HydrationStore implements HandoffRecoveryStore {
	readonly scope = RECOVERY_SCOPE;
	readonly active = new Map<string, ActiveHandoffRecoveryRecord>();
	readonly terminal = new Map<string, TerminalHandoffRecoveryReceipt>();
	compareCalls = 0;
	resolveCalls = 0;
	hydrateCalls = 0;
	applyWitnessCalls = 0;
	dispatchReceiptCalls = 0;
	compareFault: "none" | "before-once" | "after-once" = "none";
	resolveFault: "none" | "before-once" | "after-once" = "none";

	constructor(input: Readonly<{
		active: readonly ActiveHandoffRecoveryRecord[];
		terminal: readonly TerminalHandoffRecoveryReceipt[];
	}>) {
		for (const record of input.active) this.active.set(record.recordId, record);
		for (const record of input.terminal) this.terminal.set(record.recordId, record);
	}

	async putIntent(): Promise<PutHandoffRecoveryIntentResult> {
		throw new Error("unused");
	}

	async compareAndSetStatus(
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	): Promise<HandoffRecoveryCasResult> {
		this.compareCalls++;
		if (this.compareFault === "before-once") {
			this.compareFault = "none";
			throw new Error("compare before commit");
		}
		const current = this.active.get(recordId);
		if (!current) return { kind: "missing" };
		if (current.checksum !== expectedChecksum || current.status !== transition.from) {
			return {
				kind: "stale",
				actualStatus: current.status,
				actualChecksum: current.checksum,
			};
		}
		const record = await withRecoveryChecksum({
			...current,
			status: "needs-review",
		} as ActiveHandoffRecoveryRecord);
		this.active.set(recordId, record);
		if (this.compareFault === "after-once") {
			this.compareFault = "none";
			throw new Error("compare after commit");
		}
		return { kind: "updated", record };
	}

	async storeApplyWitness(
		_recordId: string,
		_expectedChecksum: string,
		_witness: HandoffRecoveryApplyWitness,
	): Promise<HandoffRecoveryCasResult> {
		this.applyWitnessCalls++;
		return { kind: "missing" };
	}

	async storeDispatchReceipt(): Promise<HandoffRecoveryCasResult> {
		this.dispatchReceiptCalls++;
		return { kind: "missing" };
	}

	async resolveRecord(
		request: ResolveHandoffRecoveryRequest,
	): Promise<ResolveHandoffRecoveryResult> {
		this.resolveCalls++;
		if (request.kind !== "finalize-active") return { kind: "missing" };
		if (this.resolveFault === "before-once") {
			this.resolveFault = "none";
			throw new Error("resolve before commit");
		}
		const current = this.active.get(request.recordId);
		if (!current) return { kind: "missing" };
		if (current.checksum !== request.expectedChecksum) {
			return {
				kind: "stale",
				actualStatus: current.status,
				actualChecksum: current.checksum,
			};
		}
		const terminal = await withRecoveryChecksum({
			recordId: current.recordId,
			intentId: current.intentId,
			intentEnvelopeHash: current.intentEnvelopeHash,
			scope: current.scope,
			fromPath: current.fromPath,
			targetPath: current.targetPath,
			startContentHash: current.startContentHash,
			afterContentHash: current.afterContentHash,
			checksum: current.checksum,
			finalizedAt: request.finalizedAt,
			status: request.disposition === "discard" ? "discarded" : "resolved",
			disposition: request.disposition,
		} as TerminalHandoffRecoveryReceipt);
		this.active.delete(request.recordId);
		this.terminal.set(request.recordId, terminal);
		if (this.resolveFault === "after-once") {
			this.resolveFault = "none";
			throw new Error("resolve after commit");
		}
		return { kind: "updated", record: terminal };
	}

	async hydrateScope(): Promise<HandoffRecoveryHydrationResult> {
		this.hydrateCalls++;
		return {
			status: "loaded",
			active: [...this.active.values()],
			terminal: [...this.terminal.values()],
			issues: [],
			totalBytes: 512,
		};
	}

	async clearScope(): Promise<ClearHandoffRecoveryScopeResult> {
		return { kind: "cleared", deletedCount: 0 };
	}

	async drain(): Promise<void> {}
}

console.log("\n--- Handoff Recovery lifecycle: hydrated CAS converges before/after throws ---");
{
	for (const fault of ["before-once", "after-once"] as const) {
		const awaiting = await makeAwaitingRecord(`restart-cas-${fault}`);
		const store = new HydrationStore({ active: [awaiting], terminal: [] });
		store.compareFault = fault;
		const coordinator = new ManualHandoffRecoveryCoordinator({
			store,
			isScopeCurrent: () => true,
		});
		const hydration = await coordinator.hydrateScope();
		assert.equal(hydration.active[0]?.status, "needs-review");
		assert.equal(store.compareCalls, fault === "before-once" ? 2 : 1);
		assert.ok(store.hydrateCalls >= 3, "ambiguous CAS performs an exact reread");
	}
}

console.log("\n--- Handoff Recovery lifecycle: hydration never auto-finalizes settlement ---");
{
	for (const fault of ["before-once", "after-once"] as const) {
		const awaiting = await makeAwaitingRecord(`restart-resolve-${fault}`);
		const store = new HydrationStore({ active: [awaiting], terminal: [] });
		store.resolveFault = fault;
		const coordinator = new ManualHandoffRecoveryCoordinator({
			store,
			isScopeCurrent: () => true,
		});
		const hydration = await coordinator.hydrateScope();
		assert.equal(store.resolveCalls, 0, "hydration has no automatic settlement finalize path");
		assert.equal(hydration.active[0]?.status, "needs-review");
		assert.equal(hydration.terminal.length, 0);
	}
}

function fakeApp(input?: Readonly<{
	existing?: readonly string[];
	folders?: readonly string[];
	createResultPath?: string;
	reread?: string;
	createError?: Error;
	readError?: Error;
}>) {
	const files = new Map<string, TFile>();
	const folders = new Map<string, TFolder>();
	for (const path of input?.existing ?? []) files.set(path, new FakeFile(path));
	for (const path of input?.folders ?? []) folders.set(path, new FakeFolder(path));
	const creates: Readonly<{ path: string; content: string }>[] = [];
	return {
		creates,
		app: {
			vault: {
				getAbstractFileByPath(path: string) {
					return files.get(path) ?? folders.get(path) ?? null;
				},
				async create(path: string, content: string) {
					if (input?.createError) throw input.createError;
					(creates as { path: string; content: string }[]).push({ path, content });
					const file = new FakeFile(input?.createResultPath ?? path);
					files.set(file.path, file);
					return file;
				},
				async read() {
					if (input?.readError) throw input.readError;
					return input?.reread ?? creates.at(-1)?.content ?? "";
				},
			},
		} as never,
	};
}

console.log("\n--- Handoff Recovery lifecycle: export is explicit and verified ---");
{
	const fixture = fakeApp({
		existing: ["Exports/name.txt"],
		folders: ["Exports"],
	});
	assert.equal(fixture.creates.length, 0);
	const result = await exportHandoffRecoveryBody(
		fixture.app,
		"Exports/name.txt",
		"captured successor",
	);
	assert.deepEqual(fixture.creates, [{
		path: "Exports/name 2.txt",
		content: "captured successor",
	}]);
	assert.equal(result.path, "Exports/name 2.txt");
	assert.equal(
		result.contentHash,
		"4ef6d782975f1ccf0e9a28b8c7acf307c89c04de6448e4e9a7248327c9d65645",
	);
}

console.log("\n--- Handoff Recovery lifecycle: unsafe exports fail before authority changes ---");
{
	const missingParent = fakeApp();
	await assert.rejects(
		exportHandoffRecoveryBody(missingParent.app, "Missing/name", "body"),
		/folder does not exist/,
	);
	assert.equal(missingParent.creates.length, 0);

	const wrongIdentity = fakeApp({ createResultPath: "other.txt" });
	await assert.rejects(
		exportHandoffRecoveryBody(wrongIdentity.app, "name.txt", "body"),
		/unexpected file identity/,
	);

	const wrongReread = fakeApp({ reread: "different" });
	await assert.rejects(
		exportHandoffRecoveryBody(wrongReread.app, "name.txt", "body"),
		/verification failed/,
	);

	const createFailure = fakeApp({ createError: new Error("create failed") });
	await assert.rejects(
		exportHandoffRecoveryBody(createFailure.app, "name.txt", "body"),
		/create failed/,
	);
	const readFailure = fakeApp({ readError: new Error("read failed") });
	await assert.rejects(
		exportHandoffRecoveryBody(readFailure.app, "name.txt", "body"),
		/read failed/,
	);
}

console.log("\n--- Handoff Recovery lifecycle: restart hydration is manual-only ---");
{
	const stored = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent("restart-stored"),
		1_800_000_000_100,
	);
	const replayPendingBase = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent("restart-replay-pending"),
		1_800_000_000_101,
	);
	const awaitingBase = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent("restart-awaiting"),
		1_800_000_000_102,
	);
	const manualBase = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent("restart-manual"),
		1_800_000_000_103,
	);
	const terminalBase = await createStoredHandoffRecoveryRecord(
		RECOVERY_SCOPE,
		makeIntent("restart-terminal"),
		1_800_000_000_104,
	);
	const strictReplayPending = await withRecoveryChecksum({
		...replayPendingBase,
		status: "replay-pending",
		applyWitness: {
			...makeApplyWitness(replayPendingBase, null),
			kind: "strict-nonoverlap-rebase" as const,
		},
	} as ActiveHandoffRecoveryRecord);
	const strictAwaiting = await withRecoveryChecksum({
		...awaitingBase,
		status: "replayed-awaiting-settlement",
		applyWitness: {
			...makeApplyWitness(awaitingBase, "9".repeat(64)),
			kind: "strict-nonoverlap-rebase" as const,
		},
	} as ActiveHandoffRecoveryRecord);
	const strictReplayPendingPayloadSnapshot = structuredClone(
		recoveryPayload(strictReplayPending),
	);
	const strictAwaitingPayloadSnapshot = structuredClone(
		recoveryPayload(strictAwaiting),
	);
	const manual = await withRecoveryChecksum({
		...manualBase,
		status: "needs-review",
	} as ActiveHandoffRecoveryRecord);
	const terminal = await withRecoveryChecksum({
		recordId: terminalBase.recordId,
		intentId: terminalBase.intentId,
		intentEnvelopeHash: terminalBase.intentEnvelopeHash,
		scope: terminalBase.scope,
		fromPath: terminalBase.fromPath,
		targetPath: terminalBase.targetPath,
		startContentHash: terminalBase.startContentHash,
		afterContentHash: terminalBase.afterContentHash,
		checksum: terminalBase.checksum,
		finalizedAt: 1_800_000_000_200,
		status: "resolved",
		disposition: "manual-resolution",
	} as TerminalHandoffRecoveryReceipt);
	const store = new HydrationStore({
		active: [stored, strictReplayPending, strictAwaiting, manual],
		terminal: [terminal],
	});
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const hydration = await coordinator.hydrateScope();
	assert.deepEqual(
		hydration.active.map((record) => record.status),
		["needs-review", "needs-review", "needs-review", "needs-review"],
	);
	const demotedStrictReplayPending = hydration.active.find(
		(record) => record.recordId === strictReplayPending.recordId,
	);
	assert.ok(demotedStrictReplayPending, "strict replay-pending row remains visible");
	assert.equal(demotedStrictReplayPending.status, "needs-review");
	assert.deepEqual(
		recoveryPayload(demotedStrictReplayPending),
		strictReplayPendingPayloadSnapshot,
	);
	const demotedStrictAwaiting = hydration.active.find(
		(record) => record.recordId === strictAwaiting.recordId,
	);
	assert.ok(demotedStrictAwaiting, "strict awaiting-settlement row remains visible");
	assert.equal(demotedStrictAwaiting.status, "needs-review");
	assert.deepEqual(
		recoveryPayload(demotedStrictAwaiting),
		strictAwaitingPayloadSnapshot,
	);
	assert.equal(store.compareCalls, 3);
	assert.equal(store.resolveCalls, 0);
	assert.equal(store.applyWitnessCalls, 0);
	assert.equal(store.dispatchReceiptCalls, 0);
	assert.equal(hydration.terminal.length, 1);
	assert.equal("body" in (hydration.terminal[0] as HandoffRecoveryRecord), false);

	const beforeExport = store.active.size;
	const explicitExport = fakeApp();
	await exportHandoffRecoveryBody(explicitExport.app, "manual-copy.txt", "alpha!");
	assert.equal(store.active.size, beforeExport, "explicit export does not resolve a stored row");
}

console.log("\n--- Handoff Recovery lifecycle: scope identity excludes server host ---");
{
	const key = buildHandoffRecoveryScopeKey(RECOVERY_SCOPE);
	assert.equal(
		key,
		'["kaos-handoff-recovery-scope",1,"vault-a","device-a"]',
	);
	assert.notEqual(key, buildHandoffRecoveryScopeKey({
		...RECOVERY_SCOPE,
		vaultId: "vault-b",
	}));
	assert.notEqual(key, buildHandoffRecoveryScopeKey({
		...RECOVERY_SCOPE,
		localDeviceId: "device-b",
	}));
}

console.log("\n--- Handoff Recovery lifecycle: missing IndexedDB rejects asynchronously ---");
{
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	try {
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			writable: true,
			value: undefined,
		});
		let store: IndexedDbHandoffRecoveryStore | null = null;
		assert.doesNotThrow(() => {
			store = new IndexedDbHandoffRecoveryStore(RECOVERY_SCOPE);
		});
		await assert.rejects(store!.hydrateScope(), /IndexedDB unavailable/);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
		else Reflect.deleteProperty(globalThis, "indexedDB");
	}
}

console.log("handoff recovery lifecycle tests passed");
