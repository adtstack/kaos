import type { BlobHashCache } from "./blobHashCache";
import type { DiskIndex } from "./diskIndex";
import type { PreservedUnresolvedEntry } from "./preservedUnresolved";

const DB_NAME = "kaos-aux-state";
const DB_VERSION = 1;
const AUX_STORE = "aux";
const RECORD_KEY = "aux";

/**
 * Bump when the snapshot shape changes; gates data.json key stripping.
 * v3: DiskIndexEntry gained the optional per-file `settledAtMs` timestamp —
 * older snapshots load unchanged (the field is simply absent).
 */
export const AUX_STATE_STORE_VERSION = 3;

/**
 * Lowest data.json marker that already externalized aux state to the
 * IndexedDB store. Recognition must be a floor, not exact equality: a device
 * marked v2 (legacy keys already stripped) must still read as externalized
 * after the code bumps to v3 — otherwise the boot path briefly treats it as
 * un-externalized and could re-embed device-local fs facts into data.json.
 * Shape-only bumps never lower this floor.
 */
export const AUX_STATE_EXTERNALIZED_MIN_VERSION = 2;

/** One vault-scoped record: the disk index, blob hash cache, and preserved unresolved entries. */
export interface AuxStateSnapshot {
	diskIndex: DiskIndex;
	blobHashCache: BlobHashCache;
	preservedUnresolved?: PreservedUnresolvedEntry[];
	savedAt: number;
}

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;

/**
 * Pure: read a persisted data.json state and decide the aux-state migration
 * input. Externalized (marker present) means the IndexedDB store owns the
 * state and any legacy keys must be ignored — data.json may have been copied
 * from another device, and filesystem facts are device-local.
 */
export function readAuxStateMigrationInput(persisted: {
	_auxStateStoreVersion?: number;
	_diskIndex?: unknown;
	_blobHashCache?: unknown;
	_preservedUnresolved?: unknown;
}): {
	externalized: boolean;
	legacyDiskIndex: DiskIndex | null;
	legacyBlobHashCache: BlobHashCache | null;
	legacyPreservedUnresolved: PreservedUnresolvedEntry[] | null;
} {
	if (
		typeof persisted._auxStateStoreVersion === "number"
		&& persisted._auxStateStoreVersion >= AUX_STATE_EXTERNALIZED_MIN_VERSION
	) {
		return {
			externalized: true,
			legacyDiskIndex: null,
			legacyBlobHashCache: null,
			legacyPreservedUnresolved: null,
		};
	}
	const diskIndex = asPlainRecord(persisted._diskIndex);
	const blobHashCache = asPlainRecord(persisted._blobHashCache);
	const preservedUnresolved = Array.isArray(persisted._preservedUnresolved)
		? (persisted._preservedUnresolved as PreservedUnresolvedEntry[])
		: null;
	return {
		externalized: false,
		legacyDiskIndex: diskIndex && Object.keys(diskIndex).length > 0
			? diskIndex as DiskIndex
			: null,
		legacyBlobHashCache: blobHashCache && Object.keys(blobHashCache).length > 0
			? blobHashCache as BlobHashCache
			: null,
		legacyPreservedUnresolved: preservedUnresolved && preservedUnresolved.length > 0
			? preservedUnresolved
			: null,
	};
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Vault-scoped IndexedDB home for device-local caches that must never travel
 * through data.json (the file users copy between devices when setting up
 * mobile). Holds the disk index ({mtime,size,contentHash} per path — pure
 * filesystem facts) and the blob hash cache (recompute-avoidance cache).
 *
 * Scoping follows the IndexedDbBaselineTextRepository precedent: one database
 * per concern, `<vaultId>:` key prefix, injectable factory for tests. A room
 * transition therefore reads a different record without any migration, and a
 * fresh record starts empty.
 */
export class IndexedDbAuxStateStore {
	private readonly dbPromise: Promise<IDBDatabase>;
	private readonly recordKey: string;

	constructor(
		scope: string,
		indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
	) {
		if (!scope) throw new Error("Aux state scope is required");
		this.recordKey = `${scope}:${RECORD_KEY}`;
		this.dbPromise = openDatabase(indexedDbFactory, dbName);
	}

	async load(): Promise<AuxStateSnapshot | null> {
		const db = await this.dbPromise;
		const value = await requestPromise<unknown>(
			db.transaction(AUX_STORE, "readonly").objectStore(AUX_STORE).get(this.recordKey),
		);
		if (!isAuxStateSnapshot(value)) return null;
		return value;
	}

	async save(snapshot: AuxStateSnapshot): Promise<void> {
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.put(snapshot, this.recordKey);
		});
	}

	async clear(): Promise<void> {
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.delete(this.recordKey);
		});
	}
}

function isAuxStateSnapshot(value: unknown): value is AuxStateSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<AuxStateSnapshot>;
	return typeof candidate.savedAt === "number"
		&& typeof candidate.diskIndex === "object" && candidate.diskIndex !== null
		&& typeof candidate.blobHashCache === "object" && candidate.blobHashCache !== null
		&& (candidate.preservedUnresolved === undefined || Array.isArray(candidate.preservedUnresolved));
}

function openDatabase(factory: IndexedDbFactoryLike, dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(AUX_STORE)) db.createObjectStore(AUX_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(`Failed to open IndexedDB database "${dbName}"`));
	});
}

function writeTransaction(db: IDBDatabase, write: (store: IDBObjectStore) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(AUX_STORE, "readwrite");
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		write(tx.objectStore(AUX_STORE));
	});
}

function requestPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function defaultIndexedDbFactory(): IDBFactory {
	if (!globalThis.indexedDB) throw new Error("IndexedDB is not available");
	return globalThis.indexedDB;
}
