import {
	isSha256Hex,
	type BaselineTextRepository,
	type BaselineTextStore,
} from "./baselineTextStore";

const DB_NAME = "kaos-baseline-texts";
const DB_VERSION = 1;
const TEXT_STORE = "texts";
const WRITE_BATCH_SIZE = 64;

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;

/** Content-addressed baseline storage for the Obsidian/browser runtime. */
export class IndexedDbBaselineTextRepository implements BaselineTextRepository {
	private readonly dbPromise: Promise<IDBDatabase>;
	private readonly keyPrefix: string;

	constructor(
		scope: string,
		indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
	) {
		if (!scope) throw new Error("Baseline text scope is required");
		this.keyPrefix = `${scope}:`;
		this.dbPromise = openDatabase(indexedDbFactory, dbName);
	}

	async load(hashes: Iterable<string>): Promise<BaselineTextStore> {
		const db = await this.dbPromise;
		const requested = Array.from(new Set(hashes)).filter(isSha256Hex);
		if (requested.length === 0) return {};
		const tx = db.transaction(TEXT_STORE, "readonly");
		const store = tx.objectStore(TEXT_STORE);
		const values = await Promise.all(requested.map(async (hash) => {
			const value = await requestPromise<unknown>(store.get(this.key(hash)));
			return [hash, value] as const;
		}));
		const output: BaselineTextStore = {};
		for (const [hash, value] of values) {
			if (typeof value === "string") output[hash] = value;
		}
		return output;
	}

	async save(entries: BaselineTextStore): Promise<void> {
		const validEntries = Object.entries(entries).filter(([hash, text]) =>
			isSha256Hex(hash) && typeof text === "string");
		const db = await this.dbPromise;
		if (validEntries.length === 0) return;
		for (let offset = 0; offset < validEntries.length; offset += WRITE_BATCH_SIZE) {
			const batch = validEntries.slice(offset, offset + WRITE_BATCH_SIZE);
			await writeTransaction(db, (store) => {
				for (const [hash, text] of batch) store.put(text, this.key(hash));
			});
		}
	}

	async retain(hashes: Iterable<string>): Promise<void> {
		const keep = new Set(Array.from(hashes).filter(isSha256Hex).map((hash) => this.key(hash)));
		const db = await this.dbPromise;
		const keys = await requestPromise(db.transaction(TEXT_STORE, "readonly").objectStore(TEXT_STORE).getAllKeys());
		const stale = keys.filter((key): key is string =>
			typeof key === "string" && key.startsWith(this.keyPrefix) && !keep.has(key));
		if (stale.length === 0) return;
		for (let offset = 0; offset < stale.length; offset += WRITE_BATCH_SIZE) {
			const batch = stale.slice(offset, offset + WRITE_BATCH_SIZE);
			await writeTransaction(db, (store) => {
				for (const key of batch) store.delete(key);
			});
		}
	}

	async remove(hashes: Iterable<string>): Promise<void> {
		const keys = Array.from(new Set(hashes)).filter(isSha256Hex).map((hash) => this.key(hash));
		const db = await this.dbPromise;
		for (let offset = 0; offset < keys.length; offset += WRITE_BATCH_SIZE) {
			const batch = keys.slice(offset, offset + WRITE_BATCH_SIZE);
			await writeTransaction(db, (store) => {
				for (const key of batch) store.delete(key);
			});
		}
	}

	private key(hash: string): string {
		return `${this.keyPrefix}${hash.toLowerCase()}`;
	}
}

function openDatabase(factory: IndexedDbFactoryLike, dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(TEXT_STORE)) db.createObjectStore(TEXT_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(`Failed to open IndexedDB database "${dbName}"`));
	});
}

function writeTransaction(db: IDBDatabase, write: (store: IDBObjectStore) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(TEXT_STORE, "readwrite");
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		write(tx.objectStore(TEXT_STORE));
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
