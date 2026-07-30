import type { HandoffInputIntent } from "./editorHandoffState";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	assertHandoffRecoveryScope,
	assertSha256Hex,
	buildHandoffRecoveryRecordId,
	canonicalHandoffRecoveryJson,
	createStoredHandoffRecoveryRecord,
	isActiveHandoffRecoveryRecord,
	sha256HandoffRecoveryHex,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type ClearHandoffRecoveryScopeResult,
	type HandoffRecoveryApplyWitness,
	type HandoffRecoveryCasResult,
	type HandoffRecoveryHydrationIssue,
	type HandoffRecoveryHydrationResult,
	type HandoffRecoveryRecord,
	type HandoffRecoveryScope,
	type HandoffRecoveryStatusTransition,
	type HandoffRecoveryStore,
	type PutHandoffRecoveryIntentResult,
	type ResolveHandoffRecoveryRequest,
	type ResolveHandoffRecoveryResult,
	type TerminalHandoffRecoveryReceipt,
} from "./handoffRecoveryStore";

const DB_NAME = "kaos-handoff-recovery";
const DB_VERSION = 1;
const RECORD_STORE = "records";

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;
type EscapeAction = "copy" | "export" | "discard";
type RecoveryKey = [
	schemaVersion: number,
	vaultId: string,
	localDeviceId: string,
	intentId: string,
];

declare const __KAOS_QA_HARNESS_ENABLED__: boolean;

export interface IndexedDbHandoffRecoveryStoreHooks {
	beforePutBeforeStorage?(event: Readonly<{
		intentId: string;
	}>): Promise<void>;
	afterVerifiedPutBeforeFence?(event: Readonly<{
		intentId: string;
		transactionResult: "created" | "existing";
		verifiedChecksum: string;
	}>): Promise<void>;
}

const QA_STORE_HOOKS: WeakMap<object, IndexedDbHandoffRecoveryStoreHooks> | null =
	typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
	&& __KAOS_QA_HARNESS_ENABLED__
		? new WeakMap()
		: null;

export class IndexedDbHandoffRecoveryStore implements HandoffRecoveryStore {
	readonly scope: HandoffRecoveryScope;
	private readonly dbPromise: Promise<IDBDatabase>;
	private writeTail: Promise<void> = Promise.resolve();
	private scopeEpoch = 0;
	private readonly escapedIntentActions = new Map<string, EscapeAction>();
	private readonly acknowledgedRecordsByIntent = new Map<
		string,
		HandoffRecoveryRecord
	>();

	constructor(
		scope: HandoffRecoveryScope,
		factory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
		private readonly now: () => number = Date.now,
		hooks: IndexedDbHandoffRecoveryStoreHooks = {},
	) {
		assertHandoffRecoveryScope(scope);
		this.scope = Object.freeze({ ...scope });
		this.dbPromise = openHandoffRecoveryDatabase(factory, dbName);
		if (
			typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
			&& __KAOS_QA_HARNESS_ENABLED__
			&& QA_STORE_HOOKS
			&& (hooks.beforePutBeforeStorage || hooks.afterVerifiedPutBeforeFence)
		) {
			QA_STORE_HOOKS.set(this, hooks);
		}
	}

	private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writeTail.catch(() => undefined).then(work);
		this.writeTail = result.then(() => undefined, () => undefined);
		return result;
	}

	async drain(): Promise<void> {
		for (;;) {
			const observed = this.writeTail;
			await observed;
			if (observed === this.writeTail) return;
		}
	}

	async putIntent(intent: HandoffInputIntent): Promise<PutHandoffRecoveryIntentResult> {
		const callEpoch = this.scopeEpoch;
		const escaped = this.escapedIntentActions.get(intent.intentId);
		if (escaped) {
			return {
				kind: "fenced",
				action: escaped,
				retainedRecord: this.acknowledgedRecordsByIntent.get(intent.intentId) ?? null,
			};
		}
		const incoming = await createStoredHandoffRecoveryRecord(
			this.scope,
			intent,
			this.now(),
		);
		return this.enqueueWrite(async () => {
			const actionBeforeWrite = this.escapedIntentActions.get(intent.intentId);
			if (callEpoch !== this.scopeEpoch || actionBeforeWrite) {
				return {
					kind: "fenced",
					action: actionBeforeWrite ?? "discard",
					retainedRecord: this.acknowledgedRecordsByIntent.get(intent.intentId) ?? null,
				};
			}
			if (
				typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
				&& __KAOS_QA_HARNESS_ENABLED__
				&& QA_STORE_HOOKS
			) {
				await QA_STORE_HOOKS.get(this)?.beforePutBeforeStorage?.({
					intentId: incoming.intentId,
				});
			}
			const db = await this.dbPromise;
			const result = await putIntentTransaction(db, this.scope, incoming);
			const verified = await readAndValidateExactRecord(
				db,
				this.scope,
				incoming.intentId,
			);
			if (
				typeof __KAOS_QA_HARNESS_ENABLED__ !== "undefined"
				&& __KAOS_QA_HARNESS_ENABLED__
				&& QA_STORE_HOOKS
			) {
				await QA_STORE_HOOKS.get(this)?.afterVerifiedPutBeforeFence?.({
					intentId: incoming.intentId,
					transactionResult: result,
					verifiedChecksum: verified.checksum,
				});
			}
			const actionAfterWrite = this.escapedIntentActions.get(intent.intentId);
			if (callEpoch !== this.scopeEpoch || actionAfterWrite) {
				if (result === "created") {
					await deleteIntentRecordIfChecksum(
						db,
						this.scope,
						intent.intentId,
						verified.checksum,
					);
					return {
						kind: "fenced",
						action: actionAfterWrite ?? "discard",
						retainedRecord: null,
					};
				}
				this.acknowledgedRecordsByIntent.set(intent.intentId, verified);
				return {
					kind: "fenced",
					action: actionAfterWrite ?? "discard",
					retainedRecord: verified,
				};
			}
			this.acknowledgedRecordsByIntent.set(intent.intentId, verified);
			if (result === "created") {
				if (verified.checksum !== incoming.checksum) {
					throw new Error("Recovery post-write verification mismatch");
				}
				if (!isActiveHandoffRecoveryRecord(verified)) {
					throw new Error("A created Recovery record must remain active");
				}
				return { kind: "stored", record: verified };
			}
			return { kind: "existing", record: verified };
		});
	}

	async compareAndSetStatus(
		recordId: string,
		expectedChecksum: string,
		transition: HandoffRecoveryStatusTransition,
	): Promise<HandoffRecoveryCasResult> {
		return this.replaceValidatedRecord(recordId, expectedChecksum, (current) => {
			if (!isActiveHandoffRecoveryRecord(current)) return null;
			if (current.status === transition.to) return current;
			if (current.status !== transition.from) return null;
			return { ...current, status: "needs-review" };
		});
	}

	async storeApplyWitness(
		recordId: string,
		expectedChecksum: string,
		witness: HandoffRecoveryApplyWitness,
	): Promise<HandoffRecoveryCasResult> {
		if (witness.dispatchReceiptHash !== null) {
			throw new Error("A replay-pending witness cannot have a dispatch receipt");
		}
		return this.replaceValidatedRecord(recordId, expectedChecksum, (current) => {
			if (!isActiveHandoffRecoveryRecord(current) || current.status !== "stored") {
				return null;
			}
			return { ...current, status: "replay-pending", applyWitness: witness };
		});
	}

	async storeDispatchReceipt(
		recordId: string,
		expectedChecksum: string,
		dispatchReceiptHash: string,
	): Promise<HandoffRecoveryCasResult> {
		assertSha256Hex(dispatchReceiptHash, "dispatchReceiptHash");
		return this.replaceValidatedRecord(recordId, expectedChecksum, (current) => {
			if (
				!isActiveHandoffRecoveryRecord(current)
				|| current.status !== "replay-pending"
				|| current.applyWitness === null
				|| current.applyWitness.dispatchReceiptHash !== null
			) return null;
			return {
				...current,
				status: "replayed-awaiting-settlement",
				applyWitness: { ...current.applyWitness, dispatchReceiptHash },
			};
		});
	}

	async resolveRecord(
		request: ResolveHandoffRecoveryRequest,
	): Promise<ResolveHandoffRecoveryResult> {
		if (request.kind === "precommit-escape") {
			this.escapedIntentActions.set(request.intentId, request.action);
			const acknowledged = this.acknowledgedRecordsByIntent.get(request.intentId);
			if (acknowledged) {
				return { kind: "retained", action: request.action, record: acknowledged };
			}
			return { kind: "escaped", action: request.action, recordId: null };
		}
		return this.replaceValidatedRecord(
			request.recordId,
			request.expectedChecksum,
			(current) => buildTerminalReceipt(current, request),
		);
	}

	async hydrateScope(): Promise<HandoffRecoveryHydrationResult> {
		const db = await this.dbPromise;
		const rows = await readAllRows(db);
		const active: ActiveHandoffRecoveryRecord[] = [];
		const terminal: TerminalHandoffRecoveryReceipt[] = [];
		const issues: HandoffRecoveryHydrationIssue[] = [];
		let totalBytes = 0;
		let matchingRows = 0;
		for (const row of rows) {
			const key = parseRecoveryKey(row.key);
			if (
				!key
				|| key[1] !== this.scope.vaultId
				|| key[2] !== this.scope.localDeviceId
			) continue;
			matchingRows++;
			if (key[0] !== HANDOFF_RECOVERY_SCHEMA_VERSION) {
				issues.push({
					kind: "incompatible-schema",
					recordId: recoveryRecordIdFromRawRow(row.value, key),
					schemaVersion: key[0],
				});
				continue;
			}
			try {
				const record = await validateHandoffRecoveryRecord(row.value);
				assertRecordMatchesKey(record, key);
				this.acknowledgedRecordsByIntent.set(record.intentId, record);
				if (isActiveHandoffRecoveryRecord(record)) {
					active.push(record);
					totalBytes += new TextEncoder().encode(
						canonicalHandoffRecoveryJson(record),
					).byteLength;
				} else {
					terminal.push(record);
				}
			} catch {
				issues.push({
					kind: "corrupt",
					recordId: safeRecordId(row.value),
				});
			}
		}
		active.sort(compareRecoveryRecords);
		terminal.sort(compareRecoveryRecords);
		return {
			status: issues.length > 0
				? "degraded"
				: matchingRows === 0
					? "missing"
					: "loaded",
			active,
			terminal,
			issues,
			totalBytes,
		};
	}

	async clearScope(): Promise<ClearHandoffRecoveryScopeResult> {
		this.scopeEpoch += 1;
		await this.drain();
		const hydrated = await this.hydrateScope();
		const uncertain = hydrated.active.filter(
			(record) => record.status === "replayed-awaiting-settlement",
		);
		if (uncertain.length > 0) {
			return {
				kind: "blocked",
				reason: "replayed-awaiting-settlement",
				recordIds: uncertain.map((record) => record.recordId).sort(),
			};
		}
		const db = await this.dbPromise;
		const deletedCount = await deleteAllSchemaRowsForVaultDevice(
			db,
			this.scope.vaultId,
			this.scope.localDeviceId,
		);
		this.escapedIntentActions.clear();
		this.acknowledgedRecordsByIntent.clear();
		return { kind: "cleared", deletedCount };
	}

	private async replaceValidatedRecord(
		recordId: string,
		expectedChecksum: string,
		mutate: (
			current: HandoffRecoveryRecord,
		) => Omit<HandoffRecoveryRecord, "checksum"> | HandoffRecoveryRecord | null,
	): Promise<HandoffRecoveryCasResult> {
		assertSha256Hex(expectedChecksum, "expectedChecksum");
		const intentId = parseRecordIdForScope(recordId, this.scope);
		return this.enqueueWrite(async () => {
			const db = await this.dbPromise;
			const raw = await readRawRecord(db, recoveryKey(this.scope, intentId));
			if (raw === undefined) return { kind: "missing" };
			const current = await validateHandoffRecoveryRecord(raw);
			if (current.recordId !== recordId) {
				throw new Error("Recovery record ID does not match its storage key");
			}
			if (current.checksum !== expectedChecksum) {
				return {
					kind: "stale",
					actualStatus: current.status,
					actualChecksum: current.checksum,
				};
			}
			const mutation = mutate(current);
			if (mutation === null) {
				return {
					kind: "stale",
					actualStatus: current.status,
					actualChecksum: current.checksum,
				};
			}
			const successor = await checksumRecoveryRecord(mutation);
			const validated = await validateHandoffRecoveryRecord(successor);
			if (validated.intentId !== current.intentId) {
				throw new Error("Recovery CAS cannot change intent identity");
			}
			if (validated.intentEnvelopeHash !== current.intentEnvelopeHash) {
				throw new Error("Recovery CAS cannot change the intent envelope");
			}
			if (validated.checksum === current.checksum) {
				return { kind: "unchanged", record: current };
			}
			const replaced = await replaceRecordTransaction(
				db,
				recoveryKey(this.scope, intentId),
				current,
				validated,
			);
			if (!replaced) {
				const latestRaw = await readRawRecord(
					db,
					recoveryKey(this.scope, intentId),
				);
				if (latestRaw === undefined) return { kind: "missing" };
				const latest = await validateHandoffRecoveryRecord(latestRaw);
				return {
					kind: "stale",
					actualStatus: latest.status,
					actualChecksum: latest.checksum,
				};
			}
			const verified = await readAndValidateExactRecord(
				db,
				this.scope,
				intentId,
			);
			if (canonicalHandoffRecoveryJson(verified) !== canonicalHandoffRecoveryJson(validated)) {
				throw new Error("Recovery CAS post-write verification mismatch");
			}
			this.acknowledgedRecordsByIntent.set(intentId, verified);
			return { kind: "updated", record: verified };
		});
	}
}

function defaultIndexedDbFactory(): IndexedDbFactoryLike {
	if (!globalThis.indexedDB) {
		// Preserve an asynchronously failing store instance so Main can retain the
		// coordinator's storage-free explicit escape actions.
		return {
			open(): IDBOpenDBRequest {
				throw new Error("IndexedDB unavailable");
			},
		};
	}
	return globalThis.indexedDB;
}

function openHandoffRecoveryDatabase(
	factory: IndexedDbFactoryLike,
	dbName: string,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const request = factory.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
				request.result.createObjectStore(RECORD_STORE);
			}
		};
		request.onsuccess = () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			resolve(request.result);
		};
		request.onerror = () => {
			if (settled) return;
			settled = true;
			reject(request.error ?? new Error("Handoff Recovery database open failed"));
		};
		request.onblocked = () => {
			if (settled) return;
			settled = true;
			reject(new Error("Handoff Recovery database open blocked"));
		};
	});
}

function recoveryKey(scope: HandoffRecoveryScope, intentId: string): RecoveryKey {
	return [scope.schemaVersion, scope.vaultId, scope.localDeviceId, intentId];
}

async function putIntentTransaction(
	db: IDBDatabase,
	scope: HandoffRecoveryScope,
	incoming: ActiveHandoffRecoveryRecord,
): Promise<"created" | "existing"> {
	const key = recoveryKey(scope, incoming.intentId);
	const outsideRaw = await readRawRecord(db, key);
	const outside = outsideRaw === undefined
		? null
		: await validateHandoffRecoveryRecord(outsideRaw);
	if (outside && outside.intentEnvelopeHash !== incoming.intentEnvelopeHash) {
		throw new Error("Recovery intent ID already owns different content");
	}
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(RECORD_STORE, "readwrite");
		let result: "created" | "existing" | null = null;
		let localError: Error | DOMException | null = null;
		transaction.oncomplete = () => {
			if (result) resolve(result);
			else reject(localError ?? new Error("Recovery put completed without a result"));
		};
		transaction.onerror = () => {
			localError ??= transaction.error;
		};
		transaction.onabort = () => {
			reject(localError ?? transaction.error ?? new Error("Recovery put aborted"));
		};
		const store = transaction.objectStore(RECORD_STORE);
		const request = store.get(key);
		request.onerror = () => {
			localError = request.error ?? new Error("Recovery put preimage read failed");
		};
		request.onsuccess = () => {
			try {
				const current: unknown = request.result;
				if (current === undefined) {
					if (outside !== null) {
						throw new Error("Recovery record disappeared during put");
					}
					result = "created";
					store.put(incoming, key);
					return;
				}
				if (outside !== null) {
					if (
						canonicalHandoffRecoveryJson(current)
						!== canonicalHandoffRecoveryJson(outside)
					) {
						throw new Error("Recovery record changed during put");
					}
					result = "existing";
					return;
				}
				if (!hasMatchingIntentEnvelope(current, incoming.intentEnvelopeHash)) {
					throw new Error("Recovery intent ID already owns different content");
				}
				result = "existing";
			} catch (error) {
				localError = asError(error, "Recovery put classification failed");
				transaction.abort();
			}
		};
	});
}

function hasMatchingIntentEnvelope(value: unknown, intentEnvelopeHash: string): boolean {
	return value !== null
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& (value as Record<string, unknown>).intentEnvelopeHash === intentEnvelopeHash;
}

async function readAndValidateExactRecord(
	db: IDBDatabase,
	scope: HandoffRecoveryScope,
	intentId: string,
): Promise<HandoffRecoveryRecord> {
	const raw = await readRawRecord(db, recoveryKey(scope, intentId));
	if (raw === undefined) throw new Error("Recovery post-write record is missing");
	const record = await validateHandoffRecoveryRecord(raw);
	assertRecordMatchesKey(record, recoveryKey(scope, intentId));
	return record;
}

function readRawRecord(db: IDBDatabase, key: RecoveryKey): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(RECORD_STORE, "readonly");
		const request = transaction.objectStore(RECORD_STORE).get(key);
		let result: unknown;
		request.onsuccess = () => {
			result = request.result as unknown;
		};
		request.onerror = () => reject(request.error ?? new Error("Recovery read failed"));
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = () => reject(transaction.error ?? new Error("Recovery read failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("Recovery read aborted"));
	});
}

async function deleteIntentRecordIfChecksum(
	db: IDBDatabase,
	scope: HandoffRecoveryScope,
	intentId: string,
	expectedChecksum: string,
): Promise<boolean> {
	const key = recoveryKey(scope, intentId);
	const raw = await readRawRecord(db, key);
	if (raw === undefined) return false;
	const current = await validateHandoffRecoveryRecord(raw);
	if (current.checksum !== expectedChecksum) return false;
	return deleteRecordTransaction(db, key, current);
}

function deleteRecordTransaction(
	db: IDBDatabase,
	key: RecoveryKey,
	expected: HandoffRecoveryRecord,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(RECORD_STORE, "readwrite");
		let deleted = false;
		let localError: Error | DOMException | null = null;
		transaction.oncomplete = () => resolve(deleted);
		transaction.onerror = () => {
			localError ??= transaction.error;
		};
		transaction.onabort = () => {
			reject(localError ?? transaction.error ?? new Error("Recovery delete aborted"));
		};
		const store = transaction.objectStore(RECORD_STORE);
		const request = store.get(key);
		request.onerror = () => {
			localError = request.error ?? new Error("Recovery delete preimage read failed");
		};
		request.onsuccess = () => {
			try {
				if (
					canonicalHandoffRecoveryJson(request.result)
					!== canonicalHandoffRecoveryJson(expected)
				) return;
				store.delete(key);
				deleted = true;
			} catch (error) {
				localError = asError(error, "Recovery delete classification failed");
				transaction.abort();
			}
		};
	});
}

function replaceRecordTransaction(
	db: IDBDatabase,
	key: RecoveryKey,
	expected: HandoffRecoveryRecord,
	successor: HandoffRecoveryRecord,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(RECORD_STORE, "readwrite");
		let replaced = false;
		let localError: Error | DOMException | null = null;
		transaction.oncomplete = () => resolve(replaced);
		transaction.onerror = () => {
			localError ??= transaction.error;
		};
		transaction.onabort = () => {
			reject(localError ?? transaction.error ?? new Error("Recovery CAS aborted"));
		};
		const store = transaction.objectStore(RECORD_STORE);
		const request = store.get(key);
		request.onerror = () => {
			localError = request.error ?? new Error("Recovery CAS preimage read failed");
		};
		request.onsuccess = () => {
			try {
				if (
					canonicalHandoffRecoveryJson(request.result)
					!== canonicalHandoffRecoveryJson(expected)
				) return;
				store.put(successor, key);
				replaced = true;
			} catch (error) {
				localError = asError(error, "Recovery CAS classification failed");
				transaction.abort();
			}
		};
	});
}

async function checksumRecoveryRecord(
	value: Omit<HandoffRecoveryRecord, "checksum"> | HandoffRecoveryRecord,
): Promise<HandoffRecoveryRecord> {
	const record = value as unknown as Record<string, unknown>;
	const withoutChecksum: Record<string, unknown> = { ...record };
	delete withoutChecksum.checksum;
	return {
		...withoutChecksum,
		checksum: await sha256HandoffRecoveryHex(
			canonicalHandoffRecoveryJson(withoutChecksum),
		),
	} as unknown as HandoffRecoveryRecord;
}

function buildTerminalReceipt(
	current: HandoffRecoveryRecord,
	request: Extract<ResolveHandoffRecoveryRequest, { kind: "finalize-active" }>,
): Omit<TerminalHandoffRecoveryReceipt, "checksum"> | null {
	if (!isActiveHandoffRecoveryRecord(current)) return null;
	if (
		request.disposition === "settled-replay"
		&& current.status !== "replayed-awaiting-settlement"
	) return null;
	if (
		request.disposition === "manual-resolution"
		&& current.status !== "needs-review"
	) return null;
	const common = {
		recordId: current.recordId,
		intentId: current.intentId,
		intentEnvelopeHash: current.intentEnvelopeHash,
		scope: current.scope,
		fromPath: current.fromPath,
		targetPath: current.targetPath,
		startContentHash: current.startContentHash,
		afterContentHash: current.afterContentHash,
		finalizedAt: request.finalizedAt,
	};
	if (request.disposition === "discard") {
		return { ...common, status: "discarded", disposition: "discard" };
	}
	return {
		...common,
		status: "resolved",
		disposition: request.disposition,
	};
}

function parseRecordIdForScope(
	recordId: string,
	scope: HandoffRecoveryScope,
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(recordId) as unknown;
	} catch {
		throw new Error("Recovery recordId is not valid canonical JSON");
	}
	if (
		!Array.isArray(parsed)
		|| parsed.length !== 5
		|| parsed[0] !== "kaos-handoff-recovery"
		|| parsed[1] !== scope.schemaVersion
		|| parsed[2] !== scope.vaultId
		|| parsed[3] !== scope.localDeviceId
		|| typeof parsed[4] !== "string"
		|| buildHandoffRecoveryRecordId(scope, parsed[4]) !== recordId
	) {
		throw new Error("Recovery recordId is outside the current scope");
	}
	return parsed[4];
}

function parseRecoveryKey(value: IDBValidKey): RecoveryKey | null {
	if (
		!Array.isArray(value)
		|| value.length !== 4
		|| !Number.isSafeInteger(value[0])
		|| (value[0] as number) < 0
		|| typeof value[1] !== "string"
		|| typeof value[2] !== "string"
		|| typeof value[3] !== "string"
	) return null;
	return [value[0] as number, value[1], value[2], value[3]];
}

function assertRecordMatchesKey(record: HandoffRecoveryRecord, key: RecoveryKey): void {
	if (
		record.scope.schemaVersion !== key[0]
		|| record.scope.vaultId !== key[1]
		|| record.scope.localDeviceId !== key[2]
		|| record.intentId !== key[3]
		|| record.recordId !== buildHandoffRecoveryRecordId(record.scope, record.intentId)
	) {
		throw new Error("Recovery record does not match its structured storage key");
	}
}

function readAllRows(
	db: IDBDatabase,
): Promise<readonly Readonly<{ key: IDBValidKey; value: unknown }>[]> {
	return new Promise((resolve, reject) => {
		const rows: Array<Readonly<{ key: IDBValidKey; value: unknown }>> = [];
		const transaction = db.transaction(RECORD_STORE, "readonly");
		const request = transaction.objectStore(RECORD_STORE).openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			rows.push({ key: cursor.key, value: cursor.value as unknown });
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("Recovery cursor failed"));
		transaction.oncomplete = () => resolve(rows);
		transaction.onerror = () => reject(transaction.error ?? new Error("Recovery scan failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("Recovery scan aborted"));
	});
}

function deleteAllSchemaRowsForVaultDevice(
	db: IDBDatabase,
	vaultId: string,
	localDeviceId: string,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let deletedCount = 0;
		const transaction = db.transaction(RECORD_STORE, "readwrite");
		const request = transaction.objectStore(RECORD_STORE).openCursor();
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) return;
			const key = parseRecoveryKey(cursor.key);
			if (key && key[1] === vaultId && key[2] === localDeviceId) {
				cursor.delete();
				deletedCount++;
			}
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("Recovery clear cursor failed"));
		transaction.oncomplete = () => resolve(deletedCount);
		transaction.onerror = () => reject(transaction.error ?? new Error("Recovery clear failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("Recovery clear aborted"));
	});
}

function recoveryRecordIdFromRawRow(value: unknown, key: RecoveryKey): string {
	const rawId = safeRecordId(value);
	return rawId ?? canonicalHandoffRecoveryJson([
		"kaos-handoff-recovery",
		key[0],
		key[1],
		key[2],
		key[3],
	]);
}

function safeRecordId(value: unknown): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const recordId = (value as Record<string, unknown>).recordId;
	return typeof recordId === "string" && recordId.length <= 4096 ? recordId : null;
}

function compareRecoveryRecords(a: HandoffRecoveryRecord, b: HandoffRecoveryRecord): number {
	const aTime = isActiveHandoffRecoveryRecord(a) ? a.storedAt : a.finalizedAt;
	const bTime = isActiveHandoffRecoveryRecord(b) ? b.storedAt : b.finalizedAt;
	return aTime - bTime || a.recordId.localeCompare(b.recordId);
}

function asError(error: unknown, fallback: string): Error | DOMException {
	return error instanceof Error || error instanceof DOMException
		? error
		: new Error(fallback);
}
