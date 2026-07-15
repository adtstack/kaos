import {
	PendingBlobIntentJournal,
	type PendingBlobIntent,
	type PendingBlobIntentScope,
} from "./pendingBlobIntentJournal";

const DB_NAME = "kaos-pending-blob-intents";
const DB_VERSION = 1;
const INTENT_STORE = "intentJournals";
const PERSISTED_SCHEMA = 1;

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;

interface PersistedPendingBlobIntentJournal {
	schema: typeof PERSISTED_SCHEMA;
	scope: PendingBlobIntentScope;
	entries: PendingBlobIntent[];
}

export interface PendingBlobIntentLoadResult {
	entries: PendingBlobIntent[];
	status: "missing" | "loaded" | "corrupt";
}

/**
 * Device-local durability for blob delete/rename authority.
 *
 * One record is stored for each exact host/vault/device tuple. Keeping these
 * records in IndexedDB prevents externally-synced plugin settings from
 * overwriting another device's unacknowledged causal intent journal.
 */
export class IndexedDbPendingBlobIntentStore {
	private readonly dbPromise: Promise<IDBDatabase>;
	private readonly key: string;
	private readonly scope: PendingBlobIntentScope;

	constructor(
		scope: PendingBlobIntentScope,
		indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
	) {
		assertValidScope(scope);
		this.scope = { ...scope };
		this.key = buildPendingBlobIntentStoreKey(scope);
		this.dbPromise = openDatabase(indexedDbFactory, dbName);
	}

	/** Invalid, corrupt, or foreign-scope records fail closed; I/O errors reject. */
	async load(): Promise<PendingBlobIntent[]> {
		return (await this.loadWithStatus()).entries;
	}

	/** Distinguish a fresh scope from lost/corrupt mutation authority. */
	async loadWithStatus(): Promise<PendingBlobIntentLoadResult> {
		const db = await this.dbPromise;
		const raw = await requestPromise<unknown>(
			db.transaction(INTENT_STORE, "readonly").objectStore(INTENT_STORE).get(this.key),
		);
		return readPersistedJournal(raw, this.scope);
	}

	/** Persist only entries belonging to this store's exact scope. */
	async save(entries: Iterable<PendingBlobIntent>): Promise<void> {
		const candidates = Array.from(entries);
		const journal = new PendingBlobIntentJournal(candidates);
		if (journal.getEntries().length !== candidates.length) {
			throw new Error("Invalid pending blob intent journal");
		}
		const scopedEntries = journal.getEntries(this.scope);
		const payload: PersistedPendingBlobIntentJournal = {
			schema: PERSISTED_SCHEMA,
			scope: { ...this.scope },
			entries: scopedEntries,
		};
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.put(payload, this.key);
		});
	}

	/** Remove only this store's exact scope record. */
	async clear(): Promise<void> {
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.delete(this.key);
		});
	}
}

export function buildPendingBlobIntentStoreKey(scope: PendingBlobIntentScope): string {
	assertValidScope(scope);
	return `kaos-blob-intent-v1:${JSON.stringify([
		scope.host,
		scope.vaultId,
		scope.localDeviceId,
	])}`;
}

function readPersistedJournal(
	raw: unknown,
	expectedScope: PendingBlobIntentScope,
): PendingBlobIntentLoadResult {
	if (raw === undefined) return { entries: [], status: "missing" };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { entries: [], status: "corrupt" };
	}
	const candidate = raw as Record<string, unknown>;
	if (candidate.schema !== PERSISTED_SCHEMA) return { entries: [], status: "corrupt" };
	if (!scopeMatches(candidate.scope, expectedScope)) return { entries: [], status: "corrupt" };
	if (!Array.isArray(candidate.entries)) return { entries: [], status: "corrupt" };

	const journal = new PendingBlobIntentJournal(candidate.entries);
	const entries = journal.getEntries(expectedScope);
	// Reject the whole record when any entry is malformed or belongs to another
	// scope. Partial recovery could silently discard an outstanding mutation.
	return entries.length === candidate.entries.length
		? { entries, status: "loaded" }
		: { entries: [], status: "corrupt" };
}

function scopeMatches(value: unknown, expected: PendingBlobIntentScope): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.host === expected.host
		&& candidate.vaultId === expected.vaultId
		&& candidate.localDeviceId === expected.localDeviceId;
}

function assertValidScope(scope: PendingBlobIntentScope): void {
	if (
		!scope
		|| typeof scope.host !== "string"
		|| scope.host.length === 0
		|| typeof scope.vaultId !== "string"
		|| scope.vaultId.length === 0
		|| typeof scope.localDeviceId !== "string"
		|| scope.localDeviceId.length === 0
	) {
		throw new Error("Pending blob intent scope requires host, vaultId, and localDeviceId");
	}
}

function openDatabase(factory: IndexedDbFactoryLike, dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(INTENT_STORE)) db.createObjectStore(INTENT_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(
			request.error ?? new Error(`Failed to open IndexedDB database "${dbName}"`),
		);
	});
}

function writeTransaction(db: IDBDatabase, write: (store: IDBObjectStore) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(INTENT_STORE, "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(
			transaction.error ?? new Error("IndexedDB transaction failed"),
		);
		transaction.onabort = () => reject(
			transaction.error ?? new Error("IndexedDB transaction aborted"),
		);
		write(transaction.objectStore(INTENT_STORE));
	});
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function defaultIndexedDbFactory(): IDBFactory {
	if (!globalThis.indexedDB) throw new Error("IndexedDB is not available");
	return globalThis.indexedDB;
}
