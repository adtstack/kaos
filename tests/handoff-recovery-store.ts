import assert from "node:assert/strict";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { indexedDB } from "fake-indexeddb";
import { TFile } from "obsidian";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	buildHandoffRecoveryRecordId,
	canonicalHandoffRecoveryJson,
	createStoredHandoffRecoveryRecord,
	sha256HandoffRecoveryHex,
	sha256HandoffRecoveryHexSync,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type HandoffRecoveryApplyWitness,
	type HandoffRecoveryRecord,
	type HandoffRecoveryScope,
} from "../src/sync/handoffRecoveryStore";
import type { HandoffInputIntent } from "../src/sync/editorHandoffState";

const recoveryTestGlobal = globalThis as typeof globalThis & {
	__KAOS_QA_HARNESS_ENABLED__?: boolean;
};
recoveryTestGlobal.__KAOS_QA_HARNESS_ENABLED__ = true;
const { IndexedDbHandoffRecoveryStore } = await import(
	"../src/sync/indexedDbHandoffRecoveryStore"
);

class FakeTFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

const SCOPE: HandoffRecoveryScope = {
	schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
	vaultId: "vault-a",
	localDeviceId: "local-device-a",
};

function makeIntent(intentId = "intent-a", suffix = "!"): HandoffInputIntent {
	const startDocument = Text.of(["alpha"]);
	const afterContent = `alpha${suffix}`;
	const afterContentHashes: Readonly<Record<string, string>> = {
		"!": "0f467074706d62a9d82bd6cb0acbace1f1d2c8a1cc8b94bb44bd4fb47e654d54",
		"?": "5d8929afd98f9e81d7519c35ff8d318f011c2c52c761ccc5591dad96c72b7b24",
	};
	const afterContentHash = afterContentHashes[suffix];
	if (!afterContentHash) throw new Error(`Unsupported test suffix: ${suffix}`);
	const changes = ChangeSet.of(
		[{ from: startDocument.length, insert: suffix }],
		startDocument.length,
	);
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
		changes,
		afterContent,
		afterContentHash,
		selectionBefore: EditorSelection.single(5),
		selectionAfter: EditorSelection.single(6),
		originKind: "user",
		userEvent: "input",
		capturedAt: 1_800_000_000_000,
	};
}

assert.equal(
	buildHandoffRecoveryRecordId(SCOPE, "intent-a"),
	'["kaos-handoff-recovery",1,"vault-a","local-device-a","intent-a"]',
);
assert.equal(
	(await createStoredHandoffRecoveryRecord(
		SCOPE,
		makeIntent(),
		1_800_000_000_100,
	)).status,
	"stored",
);

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueDbName(label: string): string {
	return `kaos-handoff-recovery-${label}-${Date.now()}-${Math.random()}`;
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

async function remainsPending(promise: Promise<unknown>, timeoutMs = 10): Promise<boolean> {
	const marker = Symbol("pending");
	return await Promise.race([
		promise.then(() => false, () => false),
		new Promise<typeof marker>((resolve) => {
			setTimeout(() => resolve(marker), timeoutMs);
		}),
	]) === marker;
}

function syntheticOpenFactory(
	kind: "blocked" | "error" | "hung",
): Pick<IDBFactory, "open"> {
	return {
		open(): IDBOpenDBRequest {
			const request = {} as IDBOpenDBRequest;
			if (kind !== "hung") {
				queueMicrotask(() => {
					if (kind === "blocked") {
						request.onblocked?.call(
							request,
							new Event("blocked") as IDBVersionChangeEvent,
						);
						return;
					}
					Object.defineProperty(request, "error", {
						value: new DOMException("synthetic request error", "UnknownError"),
					});
					request.onerror?.call(request, new Event("error"));
				});
			}
			return request;
		},
	};
}

function resolvedDatabaseFactory(
	database: IDBDatabase,
): Pick<IDBFactory, "open"> {
	return {
		open(): IDBOpenDBRequest {
			const request = {} as IDBOpenDBRequest;
			Object.defineProperty(request, "result", { value: database });
			queueMicrotask(() => {
				request.onsuccess?.call(request, new Event("success"));
			});
			return request;
		},
	};
}

function databaseWithFailingWrite(
	database: IDBDatabase,
	kind: "request-error" | "transaction-abort" | "quota",
): IDBDatabase {
	return {
		objectStoreNames: database.objectStoreNames,
		close: () => database.close(),
		transaction: (
			storeNames: string | string[],
			mode?: IDBTransactionMode,
		): IDBTransaction => {
			if (mode !== "readwrite") {
				return database.transaction(storeNames, mode);
			}
			return failingWriteTransaction(kind);
		},
	} as unknown as IDBDatabase;
}

function failingWriteTransaction(
	kind: "request-error" | "transaction-abort" | "quota",
): IDBTransaction {
	type MutableTransaction = {
		error: DOMException | null;
		oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null;
		onerror: ((this: IDBTransaction, event: Event) => unknown) | null;
		onabort: ((this: IDBTransaction, event: Event) => unknown) | null;
		objectStore(name: string): IDBObjectStore;
	};
	type MutableRequest = {
		result: unknown;
		error: DOMException | null;
		onsucceed: ((this: IDBRequest, event: Event) => unknown) | null;
		onsuccess: ((this: IDBRequest, event: Event) => unknown) | null;
		onerror: ((this: IDBRequest, event: Event) => unknown) | null;
	};
	const transaction = {
		error: null,
		oncomplete: null,
		onerror: null,
		onabort: null,
		objectStore: () => objectStore,
	} as MutableTransaction;
	const abort = (error: DOMException) => {
		transaction.error = error;
		transaction.onerror?.call(transaction as unknown as IDBTransaction, new Event("error"));
		transaction.onabort?.call(transaction as unknown as IDBTransaction, new Event("abort"));
	};
	const objectStore = {
		get(): IDBRequest {
			const request = {
				result: undefined,
				error: null,
				onsucceed: null,
				onsuccess: null,
				onerror: null,
			} as MutableRequest;
			queueMicrotask(() => {
				if (kind === "request-error") {
					const error = new DOMException("synthetic request failure", "UnknownError");
					request.error = error;
					request.onerror?.call(request as unknown as IDBRequest, new Event("error"));
					abort(error);
					return;
				}
				if (kind === "transaction-abort") {
					abort(new DOMException("synthetic abort", "AbortError"));
					return;
				}
				request.onsuccess?.call(request as unknown as IDBRequest, new Event("success"));
			});
			return request as unknown as IDBRequest;
		},
		put(): IDBRequest {
			const request = {
				result: undefined,
				error: null,
				onsucceed: null,
				onsuccess: null,
				onerror: null,
			} as MutableRequest;
			queueMicrotask(() => {
				abort(new DOMException("synthetic quota", "QuotaExceededError"));
			});
			return request as unknown as IDBRequest;
		},
	} as unknown as IDBObjectStore;
	return transaction as unknown as IDBTransaction;
}

function recoveryKey(
	scope: HandoffRecoveryScope,
	intentId: string,
): [number, string, string, string] {
	return [scope.schemaVersion, scope.vaultId, scope.localDeviceId, intentId];
}

function openRawRecoveryDatabase(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName, 1);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("raw test database open failed"));
	});
}

async function putRawRecoveryRow(
	dbName: string,
	key: IDBValidKey,
	value: unknown,
): Promise<void> {
	const db = await openRawRecoveryDatabase(dbName);
	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction("records", "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("raw test write failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("raw test write aborted"));
		transaction.objectStore("records").put(value, key);
	});
	db.close();
}

async function readRawRecoveryRow(
	dbName: string,
	key: IDBValidKey,
): Promise<unknown> {
	const db = await openRawRecoveryDatabase(dbName);
	const value = await new Promise<unknown>((resolve, reject) => {
		const transaction = db.transaction("records", "readonly");
		const request = transaction.objectStore("records").get(key);
		request.onsuccess = () => resolve(request.result as unknown);
		request.onerror = () => reject(request.error ?? new Error("raw test read failed"));
	});
	db.close();
	return value;
}

function makeWitness(
	record: ActiveHandoffRecoveryRecord,
): HandoffRecoveryApplyWitness {
	return {
		planId: `plan-${record.intentId}`,
		kind: "exact-replay",
		switchIntentSeq: record.body.eventProof.switchIntentSeq,
		hostLoadTokenId: `host-${record.intentId}`,
		targetFileId: "file-b",
		targetYtextIdentity: "ytext-b",
		targetMutationEpochAtPlan: 12,
		nativeHistoryEpoch: 13,
		targetSelectionEpoch: 14,
		targetScrollEpoch: 15,
		plannedStartHash: record.startContentHash,
		plannedResultContent: record.body.afterContent,
		plannedResultHash: record.afterContentHash,
		serializedMappedSelection: record.body.serializedSelectionAfter,
		dispatchReceiptHash: null,
	};
}

async function withChecksum<T extends Record<string, unknown>>(
	value: T,
): Promise<T & { checksum: string }> {
	const { checksum: _checksum, ...withoutChecksum } = value;
	return {
		...value,
		checksum: await sha256HandoffRecoveryHex(
			canonicalHandoffRecoveryJson(withoutChecksum),
		),
	};
}

const stored = await createStoredHandoffRecoveryRecord(
	SCOPE,
	makeIntent(),
	1_800_000_000_100,
);

console.log("\n--- Handoff Recovery codec: synchronous capture digest ---");
for (const value of ["", "alpha", "한글🙂", "a".repeat(10_000)]) {
	assert.equal(
		sha256HandoffRecoveryHexSync(value),
		await sha256HandoffRecoveryHex(value),
		"synchronous capture SHA-256 matches WebCrypto over exact UTF-8 bytes",
	);
}

console.log("\n--- Handoff Recovery codec: canonical stored record ---");
assert.equal(stored.recordId, buildHandoffRecoveryRecordId(SCOPE, stored.intentId));
assert.match(stored.intentEnvelopeHash, /^[0-9a-f]{64}$/);
assert.equal(stored.applyWitness, null);
assert.equal(stored.body.afterContent, "alpha!");
assert.equal(stored.body.eventProof.switchIntentSeq, 11);
assert.deepEqual(await validateHandoffRecoveryRecord(jsonClone(stored)), stored);

console.log("\n--- Handoff Recovery codec: captured intent validation ---");
await assert.rejects(
	createStoredHandoffRecoveryRecord(
		SCOPE,
		{ ...makeIntent(), afterContent: "forged" },
		1_800_000_000_100,
	),
	/does not recreate|hash mismatch/i,
);
await assert.rejects(
	createStoredHandoffRecoveryRecord(
		{ ...SCOPE, localDeviceId: "" },
		makeIntent(),
		1_800_000_000_100,
	),
	/localDeviceId/i,
);
assert.notEqual(
	buildHandoffRecoveryRecordId({ ...SCOPE, vaultId: "a:b" }, "c"),
	buildHandoffRecoveryRecordId({ ...SCOPE, vaultId: "a" }, "b:c"),
);

console.log("\n--- Handoff Recovery codec: strict fields and canonical body ---");
await assert.rejects(
	validateHandoffRecoveryRecord({ ...jsonClone(stored), unexpected: true }),
	/unknown|field/i,
);

const nonCanonicalSelection = jsonClone(stored) as unknown as Record<string, unknown>;
const nonCanonicalBody = nonCanonicalSelection.body as Record<string, unknown>;
nonCanonicalBody.serializedSelectionBefore = JSON.stringify(
	JSON.parse(stored.body.serializedSelectionBefore),
);
if (nonCanonicalBody.serializedSelectionBefore === stored.body.serializedSelectionBefore) {
	nonCanonicalBody.serializedSelectionBefore = ` ${stored.body.serializedSelectionBefore}`;
}
await assert.rejects(
	validateHandoffRecoveryRecord(nonCanonicalSelection),
	/canonical|selection/i,
);

const nonCanonicalChanges = jsonClone(stored) as unknown as Record<string, unknown>;
const nonCanonicalChangesBody = nonCanonicalChanges.body as Record<string, unknown>;
nonCanonicalChangesBody.serializedChanges = ` ${stored.body.serializedChanges}`;
await assert.rejects(
	validateHandoffRecoveryRecord(nonCanonicalChanges),
	/canonical|serializedChanges/i,
);

const outOfRangeSelection = jsonClone(stored) as unknown as Record<string, unknown>;
const outOfRangeBody = outOfRangeSelection.body as Record<string, unknown>;
outOfRangeBody.serializedSelectionAfter = canonicalHandoffRecoveryJson({
	ranges: [{ anchor: 999, head: 999 }],
	main: 0,
});
await assert.rejects(
	validateHandoffRecoveryRecord(outOfRangeSelection),
	/selection|range/i,
);

console.log("\n--- Handoff Recovery codec: proof, hashes, and timestamps ---");
await assert.rejects(
	validateHandoffRecoveryRecord({ ...jsonClone(stored), startContentHash: "bad" }),
	/startContentHash|SHA-256/i,
);
await assert.rejects(
	validateHandoffRecoveryRecord({ ...jsonClone(stored), storedAt: -1 }),
	/storedAt|timestamp/i,
);

const incompatibleProof = jsonClone(stored) as unknown as Record<string, unknown>;
const incompatibleBody = incompatibleProof.body as Record<string, unknown>;
const incompatibleEventProof = incompatibleBody.eventProof as Record<string, unknown>;
incompatibleEventProof.proofSchemaVersion = 2;
await assert.rejects(
	validateHandoffRecoveryRecord(incompatibleProof),
	/proofSchemaVersion|proof schema/i,
);

const changedProof = jsonClone(stored) as unknown as Record<string, unknown>;
const changedProofBody = changedProof.body as Record<string, unknown>;
const changedEventProof = changedProofBody.eventProof as Record<string, unknown>;
changedEventProof.selectionEpoch = 99;
await assert.rejects(
	validateHandoffRecoveryRecord(changedProof),
	/envelope|checksum|proof/i,
);

await assert.rejects(
	validateHandoffRecoveryRecord({ ...jsonClone(stored), storedAt: stored.storedAt + 1 }),
	/checksum/i,
);

const changedBodyWithStaleChecksum = jsonClone(stored) as unknown as Record<string, unknown>;
const changedBody = changedBodyWithStaleChecksum.body as Record<string, unknown>;
changedBody.afterContent = "alpha?";
await assert.rejects(
	validateHandoffRecoveryRecord(changedBodyWithStaleChecksum),
	/successor|hash|checksum/i,
);

const incompatibleEncoding = jsonClone(stored) as unknown as Record<string, unknown>;
const incompatibleEncodingBody = incompatibleEncoding.body as Record<string, unknown>;
const incompatibleEncodingProof = incompatibleEncodingBody.eventProof as Record<string, unknown>;
incompatibleEncodingProof.canonicalEncodingVersion = 2;
await assert.rejects(
	validateHandoffRecoveryRecord(incompatibleEncoding),
	/canonicalEncodingVersion|encoding/i,
);

console.log("\n--- Handoff Recovery codec: status and witness relation ---");
const witness: HandoffRecoveryApplyWitness = {
	planId: "plan-a",
	kind: "exact-replay",
	switchIntentSeq: 11,
	hostLoadTokenId: "host-load-a",
	targetFileId: "file-b",
	targetYtextIdentity: "ytext-b",
	targetMutationEpochAtPlan: 12,
	nativeHistoryEpoch: 13,
	targetSelectionEpoch: 14,
	targetScrollEpoch: 15,
	plannedStartHash: stored.startContentHash,
	plannedResultContent: stored.body.afterContent,
	plannedResultHash: stored.afterContentHash,
	serializedMappedSelection: stored.body.serializedSelectionAfter,
	dispatchReceiptHash: null,
};
const replayPending = await withChecksum({
	...jsonClone(stored),
	status: "replay-pending",
	applyWitness: witness,
}) as unknown as ActiveHandoffRecoveryRecord;
assert.equal((await validateHandoffRecoveryRecord(replayPending)).status, "replay-pending");

const replayedAwaiting = await withChecksum({
	...jsonClone(replayPending),
	status: "replayed-awaiting-settlement",
	applyWitness: { ...witness, dispatchReceiptHash: "d".repeat(64) },
}) as unknown as ActiveHandoffRecoveryRecord;
assert.equal(
	(await validateHandoffRecoveryRecord(replayedAwaiting)).status,
	"replayed-awaiting-settlement",
);

const needsReviewWithWitness = await withChecksum({
	...jsonClone(replayedAwaiting),
	status: "needs-review",
}) as unknown as ActiveHandoffRecoveryRecord;
assert.equal(
	(await validateHandoffRecoveryRecord(needsReviewWithWitness)).status,
	"needs-review",
);

await assert.rejects(
	validateHandoffRecoveryRecord(await withChecksum({
		...jsonClone(stored),
		applyWitness: witness,
	})),
	/stored|witness/i,
);
await assert.rejects(
	validateHandoffRecoveryRecord(await withChecksum({
		...jsonClone(stored),
		status: "replayed-awaiting-settlement",
		applyWitness: witness,
	})),
	/dispatch|witness/i,
);

console.log("\n--- Handoff Recovery codec: body-free terminal receipt ---");
const terminal = await withChecksum({
	recordId: stored.recordId,
	intentId: stored.intentId,
	intentEnvelopeHash: stored.intentEnvelopeHash,
	scope: jsonClone(stored.scope),
	fromPath: stored.fromPath,
	targetPath: stored.targetPath,
	startContentHash: stored.startContentHash,
	afterContentHash: stored.afterContentHash,
	finalizedAt: 1_800_000_000_200,
	status: "resolved",
	disposition: "manual-resolution",
}) as unknown as HandoffRecoveryRecord;
assert.deepEqual(await validateHandoffRecoveryRecord(terminal), terminal);
const discarded = await withChecksum({
	recordId: stored.recordId,
	intentId: stored.intentId,
	intentEnvelopeHash: stored.intentEnvelopeHash,
	scope: jsonClone(stored.scope),
	fromPath: stored.fromPath,
	targetPath: stored.targetPath,
	startContentHash: stored.startContentHash,
	afterContentHash: stored.afterContentHash,
	finalizedAt: 1_800_000_000_201,
	status: "discarded",
	disposition: "discard",
}) as unknown as HandoffRecoveryRecord;
assert.deepEqual(await validateHandoffRecoveryRecord(discarded), discarded);
await assert.rejects(
	validateHandoffRecoveryRecord({ ...jsonClone(terminal), body: stored.body }),
	/unknown|body|field/i,
);
await assert.rejects(
	validateHandoffRecoveryRecord(await withChecksum({
		...jsonClone(discarded),
		disposition: "manual-resolution",
	})),
	/disposition|discard/i,
);

console.log("handoff recovery record contract tests passed");

console.log("\n--- Handoff Recovery IndexedDB: durable idempotent round trip ---");
{
	const dbName = uniqueDbName("round-trip");
	const store = new IndexedDbHandoffRecoveryStore(SCOPE, indexedDB, dbName);
	const first = await store.putIntent(makeIntent());
	assert.equal(first.kind, "stored");
	const second = await new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
	).putIntent(makeIntent());
	assert.equal(second.kind, "existing");
	if (first.kind !== "stored" || second.kind !== "existing") {
		throw new Error("round-trip precondition failed");
	}
	assert.equal(second.record.checksum, first.record.checksum);
	assert.equal((await store.hydrateScope()).active.length, 1);
}

console.log("\n--- Handoff Recovery IndexedDB: vault and device scope isolation ---");
{
	const dbName = uniqueDbName("scope-isolation");
	const scopes: HandoffRecoveryScope[] = [
		SCOPE,
		{ ...SCOPE, vaultId: "vault-b" },
		{ ...SCOPE, localDeviceId: "local-device-b" },
	];
	for (const [index, scope] of scopes.entries()) {
		const result = await new IndexedDbHandoffRecoveryStore(
			scope,
			indexedDB,
			dbName,
			() => 1_800_000_000_100 + index,
		).putIntent(makeIntent(`scope-intent-${index}`));
		assert.equal(result.kind, "stored");
	}
	for (const scope of scopes) {
		const hydration = await new IndexedDbHandoffRecoveryStore(
			scope,
			indexedDB,
			dbName,
		).hydrateScope();
		assert.equal(hydration.active.length, 1);
		assert.equal(hydration.issues.length, 0);
	}
}

console.log("\n--- Handoff Recovery IndexedDB: intent ID owns one immutable envelope ---");
{
	const dbName = uniqueDbName("intent-id");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	assert.equal((await store.putIntent(makeIntent("same-intent", "!"))).kind, "stored");
	await assert.rejects(
		store.putIntent(makeIntent("same-intent", "?")),
		/already owns different content/i,
	);
	const hydration = await store.hydrateScope();
	assert.equal(hydration.active.length, 1);
	assert.equal(hydration.active[0]?.body.afterContent, "alpha!");
}

console.log("\n--- Handoff Recovery IndexedDB: checksum CAS and manual classification ---");
{
	const dbName = uniqueDbName("cas");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("cas-intent"));
	assert.equal(put.kind, "stored");
	if (put.kind !== "stored") throw new Error("CAS fixture did not store");
	const stale = await store.compareAndSetStatus(
		put.record.recordId,
		"f".repeat(64),
		{ from: "stored", to: "needs-review" },
	);
	assert.equal(stale.kind, "stale");
	const updated = await store.compareAndSetStatus(
		put.record.recordId,
		put.record.checksum,
		{ from: "stored", to: "needs-review" },
	);
	assert.equal(updated.kind, "updated");
	if (updated.kind !== "updated") throw new Error("CAS update failed");
	assert.equal(updated.record.status, "needs-review");
	const unchanged = await store.compareAndSetStatus(
		put.record.recordId,
		updated.record.checksum,
		{ from: "stored", to: "needs-review" },
	);
	assert.equal(unchanged.kind, "unchanged");
}

console.log("\n--- Handoff Recovery IndexedDB: frozen replay witness transitions ---");
{
	const dbName = uniqueDbName("witness");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("witness-intent"));
	assert.equal(put.kind, "stored");
	if (put.kind !== "stored") throw new Error("witness fixture did not store");
	const pending = await store.storeApplyWitness(
		put.record.recordId,
		put.record.checksum,
		makeWitness(put.record),
	);
	assert.equal(pending.kind, "updated");
	if (pending.kind !== "updated") throw new Error("witness was not stored");
	assert.equal(pending.record.status, "replay-pending");
	const dispatched = await store.storeDispatchReceipt(
		pending.record.recordId,
		pending.record.checksum,
		"e".repeat(64),
	);
	assert.equal(dispatched.kind, "updated");
	if (dispatched.kind !== "updated") throw new Error("dispatch receipt was not stored");
	assert.equal(dispatched.record.status, "replayed-awaiting-settlement");
	const resolved = await store.resolveRecord({
		kind: "finalize-active",
		recordId: dispatched.record.recordId,
		expectedChecksum: dispatched.record.checksum,
		disposition: "settled-replay",
		finalizedAt: 1_800_000_000_200,
	});
	assert.equal(resolved.kind, "updated");
	if (resolved.kind !== "updated") throw new Error("settled replay was not finalized");
	assert.equal(resolved.record.status, "resolved");
	assert.equal("body" in resolved.record, false);
}

console.log("\n--- Handoff Recovery IndexedDB: terminal replacement and duplicate identity ---");
{
	const dbName = uniqueDbName("terminal");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("terminal-intent"));
	if (put.kind !== "stored") throw new Error("terminal fixture did not store");
	const manual = await store.compareAndSetStatus(
		put.record.recordId,
		put.record.checksum,
		{ from: "stored", to: "needs-review" },
	);
	if (manual.kind !== "updated") throw new Error("terminal fixture did not classify");
	const terminal = await store.resolveRecord({
		kind: "finalize-active",
		recordId: manual.record.recordId,
		expectedChecksum: manual.record.checksum,
		disposition: "manual-resolution",
		finalizedAt: 1_800_000_000_200,
	});
	assert.equal(terminal.kind, "updated");
	if (terminal.kind !== "updated") throw new Error("terminal fixture did not resolve");
	assert.equal("body" in terminal.record, false);
	const duplicate = await new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_900_000_000_000,
	).putIntent(makeIntent("terminal-intent"));
	assert.equal(duplicate.kind, "existing");
	if (duplicate.kind !== "existing") throw new Error("terminal duplicate was not retained");
	assert.equal(duplicate.record.status, "resolved");
	await assert.rejects(
		store.putIntent(makeIntent("terminal-intent", "?")),
		/already owns different content/i,
	);
}

console.log("\n--- Handoff Recovery IndexedDB: corrupt and incompatible rows stay visible and inert ---");
{
	const dbName = uniqueDbName("degraded-hydration");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const healthy = await store.putIntent(makeIntent("healthy-intent"));
	assert.equal(healthy.kind, "stored");
	const corrupt = jsonClone(await createStoredHandoffRecoveryRecord(
		SCOPE,
		makeIntent("corrupt-intent"),
		1_800_000_000_101,
	));
	corrupt.checksum = "0".repeat(64);
	await putRawRecoveryRow(
		dbName,
		recoveryKey(SCOPE, "corrupt-intent"),
		corrupt,
	);
	await putRawRecoveryRow(
		dbName,
		[2, SCOPE.vaultId, SCOPE.localDeviceId, "future-intent"],
		{ recordId: '["kaos-handoff-recovery",2,"vault-a","local-device-a","future-intent"]' },
	);
	await putRawRecoveryRow(
		dbName,
		[1, "foreign-vault", SCOPE.localDeviceId, "foreign-intent"],
		{ recordId: "foreign" },
	);
	const hydration = await store.hydrateScope();
	assert.equal(hydration.status, "degraded");
	assert.deepEqual(hydration.active.map((record) => record.intentId), ["healthy-intent"]);
	assert.deepEqual(
		hydration.issues.map((issue) => issue.kind).sort(),
		["corrupt", "incompatible-schema"],
	);
	assert.deepEqual(
		await readRawRecoveryRow(dbName, recoveryKey(SCOPE, "corrupt-intent")),
		corrupt,
		"hydration must not rewrite a corrupt row",
	);
}

console.log("\n--- Handoff Recovery IndexedDB: uncertain settlement blocks scoped clear ---");
{
	const dbName = uniqueDbName("clear-blocked");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("uncertain-intent"));
	if (put.kind !== "stored") throw new Error("clear fixture did not store");
	const pending = await store.storeApplyWitness(
		put.record.recordId,
		put.record.checksum,
		makeWitness(put.record),
	);
	if (pending.kind !== "updated") throw new Error("clear fixture did not pend");
	const awaiting = await store.storeDispatchReceipt(
		pending.record.recordId,
		pending.record.checksum,
		"a".repeat(64),
	);
	if (awaiting.kind !== "updated") throw new Error("clear fixture did not dispatch");
	assert.deepEqual(await store.clearScope(), {
		kind: "blocked",
		reason: "replayed-awaiting-settlement",
		recordIds: [awaiting.record.recordId],
	});
	assert.equal((await store.hydrateScope()).active.length, 1);
}

console.log("\n--- Handoff Recovery IndexedDB: clear spans schemas but not another scope ---");
{
	const dbName = uniqueDbName("clear-all-schema");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	assert.equal((await store.putIntent(makeIntent("clear-current"))).kind, "stored");
	await putRawRecoveryRow(
		dbName,
		[0, SCOPE.vaultId, SCOPE.localDeviceId, "clear-old"],
		{ recordId: "old-schema" },
	);
	await putRawRecoveryRow(
		dbName,
		[1, "other-vault", SCOPE.localDeviceId, "keep-foreign"],
		{ recordId: "foreign" },
	);
	assert.deepEqual(await store.clearScope(), { kind: "cleared", deletedCount: 2 });
	assert.equal((await store.hydrateScope()).status, "missing");
	assert.notEqual(
		await readRawRecoveryRow(
			dbName,
			[1, "other-vault", SCOPE.localDeviceId, "keep-foreign"],
		),
		undefined,
	);
}

console.log("\n--- Handoff Recovery IndexedDB: open failures remain operational errors ---");
{
	const unavailableFactory = {
		open(): IDBOpenDBRequest {
			throw new Error("IndexedDB unavailable");
		},
	};
	await assert.rejects(
		new IndexedDbHandoffRecoveryStore(
			SCOPE,
			unavailableFactory,
			uniqueDbName("unavailable"),
		).hydrateScope(),
		/IndexedDB unavailable/,
	);
	await assert.rejects(
		new IndexedDbHandoffRecoveryStore(
			SCOPE,
			syntheticOpenFactory("blocked"),
			uniqueDbName("blocked"),
		).hydrateScope(),
		/blocked/i,
	);
	await assert.rejects(
		new IndexedDbHandoffRecoveryStore(
			SCOPE,
			syntheticOpenFactory("error"),
			uniqueDbName("request-error"),
		).hydrateScope(),
		/UnknownError|request error|open failed/i,
	);
}

console.log("\n--- Handoff Recovery IndexedDB: hung open remains explicitly escapable ---");
{
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		syntheticOpenFactory("hung"),
		uniqueDbName("hung"),
		() => 1_800_000_000_100,
	);
	const pendingPut = store.putIntent(makeIntent("hung-intent"));
	assert.equal(await remainsPending(pendingPut), true);
	assert.deepEqual(await store.resolveRecord({
		kind: "precommit-escape",
		intentId: "hung-intent",
		action: "copy",
	}), {
		kind: "escaped",
		action: "copy",
		recordId: null,
	});
	assert.equal(await remainsPending(pendingPut), true);
	assert.equal(await remainsPending(store.drain()), true);
}

console.log("\n--- Handoff Recovery IndexedDB: pre-storage quota failure writes zero rows ---");
{
	const dbName = uniqueDbName("quota");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
		{
			async beforePutBeforeStorage() {
				throw new DOMException("synthetic quota", "QuotaExceededError");
			},
		},
	);
	await assert.rejects(
		store.putIntent(makeIntent("quota-intent")),
		(error: unknown) => error instanceof DOMException && error.name === "QuotaExceededError",
	);
	assert.equal((await store.hydrateScope()).status, "missing");
}

console.log("\n--- Handoff Recovery IndexedDB: request, abort, and quota failures reject ---");
{
	for (const kind of ["request-error", "transaction-abort", "quota"] as const) {
		const dbName = uniqueDbName(kind);
		await new IndexedDbHandoffRecoveryStore(SCOPE, indexedDB, dbName).hydrateScope();
		const rawDatabase = await openRawRecoveryDatabase(dbName);
		const failingStore = new IndexedDbHandoffRecoveryStore(
			SCOPE,
			resolvedDatabaseFactory(databaseWithFailingWrite(rawDatabase, kind)),
			dbName,
			() => 1_800_000_000_100,
		);
		const expectedName = kind === "request-error"
			? "UnknownError"
			: kind === "transaction-abort"
				? "AbortError"
				: "QuotaExceededError";
		await assert.rejects(
			failingStore.putIntent(makeIntent(`${kind}-intent`)),
			(error: unknown) => error instanceof DOMException && error.name === expectedName,
		);
		assert.equal(
			(await new IndexedDbHandoffRecoveryStore(
				SCOPE,
				indexedDB,
				dbName,
			).hydrateScope()).status,
			"missing",
		);
		rawDatabase.close();
	}
}

console.log("\n--- Handoff Recovery IndexedDB: post-verify escape deletes only its late-created row ---");
{
	const dbName = uniqueDbName("late-put");
	const started = deferred<void>();
	const release = deferred<void>();
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
		{
			async afterVerifiedPutBeforeFence(event) {
				assert.equal(event.intentId, "late-intent");
				assert.equal(event.transactionResult, "created");
				assert.match(event.verifiedChecksum, /^[0-9a-f]{64}$/);
				started.resolve();
				await release.promise;
			},
		},
	);
	const pendingPut = store.putIntent(makeIntent("late-intent"));
	await started.promise;
	assert.deepEqual(await store.resolveRecord({
		kind: "precommit-escape",
		intentId: "late-intent",
		action: "discard",
	}), {
		kind: "escaped",
		action: "discard",
		recordId: null,
	});
	assert.equal(await remainsPending(pendingPut), true);
	release.resolve();
	assert.deepEqual(await pendingPut, {
		kind: "fenced",
		action: "discard",
		retainedRecord: null,
	});
	await store.drain();
	assert.equal((await store.hydrateScope()).status, "missing");
}

console.log("\n--- Handoff Recovery IndexedDB: acknowledged rows survive later escape fencing ---");
{
	const dbName = uniqueDbName("retained-escape");
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("retained-intent"));
	if (put.kind !== "stored") throw new Error("retained fixture did not store");
	const escaped = await store.resolveRecord({
		kind: "precommit-escape",
		intentId: "retained-intent",
		action: "export",
	});
	assert.equal(escaped.kind, "retained");
	const fenced = await store.putIntent(makeIntent("retained-intent"));
	assert.equal(fenced.kind, "fenced");
	if (fenced.kind !== "fenced") throw new Error("retained put was not fenced");
	assert.equal(fenced.retainedRecord?.checksum, put.record.checksum);
	assert.equal((await store.hydrateScope()).active.length, 1);
}

console.log("\n--- Handoff Recovery IndexedDB: clear epoch fences an in-flight old put ---");
{
	const dbName = uniqueDbName("clear-late-put");
	const started = deferred<void>();
	const release = deferred<void>();
	const store = new IndexedDbHandoffRecoveryStore(
		SCOPE,
		indexedDB,
		dbName,
		() => 1_800_000_000_100,
		{
			async beforePutBeforeStorage() {
				started.resolve();
				await release.promise;
			},
		},
	);
	const pendingPut = store.putIntent(makeIntent("clear-late-intent"));
	await started.promise;
	const pendingClear = store.clearScope();
	assert.equal(await remainsPending(pendingClear), true);
	release.resolve();
	const fenced = await pendingPut;
	assert.equal(fenced.kind, "fenced");
	assert.deepEqual(await pendingClear, { kind: "cleared", deletedCount: 0 });
	assert.equal((await store.hydrateScope()).status, "missing");
}

console.log("handoff recovery IndexedDB state tests passed");
