import { canonicalizeVaultPath } from "../paths/canonicalPath";
import {
	MAX_BLOB_REF_PRIOR_HASHES,
	isSha256Hex,
	type BlobRef,
} from "../types";
import { isBlobSourceVersion } from "./pendingBlobIntentJournal";
import type {
	BlobSettlementStage,
	BlobSettlementStageCache,
	BlobSettledRefCache,
	BlobSettledSourceVersionCache,
} from "./blobSync";

const DB_NAME = "kaos-blob-settled-refs";
const DB_VERSION = 1;
const SETTLED_REF_STORE = "settledRefCaches";
const PERSISTED_SCHEMA = 3;
const PREVIOUS_PERSISTED_SCHEMA = 2;
const LEGACY_PERSISTED_SCHEMA = 1;

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;

export interface BlobSettledRefScope {
	host: string;
	vaultId: string;
	localDeviceId: string;
}

export interface BlobSettledRefLoadResult {
	cache: BlobSettledRefCache;
	sourceVersions: BlobSettledSourceVersionCache;
	stages: BlobSettlementStageCache;
	status: "missing" | "loaded" | "corrupt";
	migrationStatus: "uninitialized" | "initialized";
	legacyMissingPaths: string[];
}

export interface BlobSettledRefSaveOptions {
	legacyMissingPaths: readonly string[];
	sourceVersions?: BlobSettledSourceVersionCache;
	stages?: BlobSettlementStageCache;
}

/** @deprecated Use BlobSettledRefSaveOptions. */
export type BlobSettledRefMigrationState = BlobSettledRefSaveOptions;

interface PersistedBlobSettledRefEntry {
	path: string;
	ref: BlobRef;
	sourceVersion?: string;
}

type PersistedBlobSettlementStageEntry = BlobSettlementStage & { path: string };

interface PersistedBlobSettledRefCache {
	schema: typeof PERSISTED_SCHEMA;
	scope: BlobSettledRefScope;
	entries: PersistedBlobSettledRefEntry[];
	stages: PersistedBlobSettlementStageEntry[];
	migration: {
		status: "initialized";
		legacyMissingPaths: string[];
	};
}

/**
 * Device-local causal authority for attachment refs that are known to match
 * the bytes on disk.
 *
 * The exact host/vault/device tuple owns one IndexedDB record. This cache must
 * never be serialized through externally-synced plugin settings: a foreign or
 * stale settled ref could otherwise authorize a destructive remote overwrite.
 */
export class IndexedDbBlobSettledRefStore {
	private readonly dbPromise: Promise<IDBDatabase>;
	private readonly key: string;
	private readonly scope: BlobSettledRefScope;

	constructor(
		scope: BlobSettledRefScope,
		indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
	) {
		assertValidScope(scope);
		this.scope = { ...scope };
		this.key = buildBlobSettledRefStoreKey(scope);
		this.dbPromise = openDatabase(indexedDbFactory, dbName);
	}

	/**
	 * Load a defensive, normalized cache copy.
	 *
	 * Missing, corrupt, or foreign-scope payloads fail closed to an empty cache.
	 * Operational IndexedDB failures reject and must be handled as unavailable
	 * authority by the caller.
	 */
	async load(): Promise<BlobSettledRefCache> {
		return (await this.loadWithStatus()).cache;
	}

	/**
	 * Load the cache while preserving whether an empty result means "never
	 * persisted" or "persisted authority was corrupt". Callers must keep blob
	 * upload and download authority closed for `corrupt`; treating it as a fresh
	 * device could resurrect a remotely preserved attachment.
	 */
	async loadWithStatus(): Promise<BlobSettledRefLoadResult> {
		const db = await this.dbPromise;
		const raw = await readValue(db, this.key);
		return readPersistedCache(raw, this.scope);
	}

	/**
	 * Atomically replace this exact scope's cache.
	 *
	 * Invalid input rejects before IndexedDB is changed; entries are never
	 * partially filtered because silently losing causal authority is unsafe.
	 */
	async save(
		cache: BlobSettledRefCache,
		options: BlobSettledRefSaveOptions = { legacyMissingPaths: [] },
	): Promise<void> {
		const normalizedEntries = normalizeCache(cache);
		if (!normalizedEntries) throw new Error("Invalid blob settled ref cache");
		const sourceVersions = normalizeSourceVersions(
			options.sourceVersions ?? {},
			new Set(normalizedEntries.map(({ path }) => path)),
		);
		if (!sourceVersions) throw new Error("Invalid blob settled source versions");
		const stages = normalizeStageCache(options.stages ?? {});
		if (!stages) throw new Error("Invalid blob settlement stages");
		const legacyMissingPaths = normalizePathList(options.legacyMissingPaths);
		if (!legacyMissingPaths) {
			throw new Error("Invalid legacy missing attachment quarantine");
		}
		const entries = normalizedEntries.map((entry) => {
			const sourceVersion = sourceVersions.get(entry.path);
			return sourceVersion === undefined
				? entry
				: { ...entry, sourceVersion };
		});
		const payload: PersistedBlobSettledRefCache = {
			schema: PERSISTED_SCHEMA,
			scope: { ...this.scope },
			entries,
			stages,
			migration: {
				status: "initialized",
				legacyMissingPaths,
			},
		};
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.put(payload, this.key);
		});
	}

	/** Remove only this exact host/vault/device record. */
	async clear(): Promise<void> {
		const db = await this.dbPromise;
		await writeTransaction(db, (store) => {
			store.delete(this.key);
		});
	}
}

export function buildBlobSettledRefStoreKey(scope: BlobSettledRefScope): string {
	assertValidScope(scope);
	return `kaos-blob-settled-v1:${JSON.stringify([
		scope.host,
		scope.vaultId,
		scope.localDeviceId,
	])}`;
}

function readPersistedCache(
	raw: unknown,
	expectedScope: BlobSettledRefScope,
): BlobSettledRefLoadResult {
	if (raw === undefined) return emptyLoadResult("missing", "uninitialized");
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return emptyLoadResult("corrupt", "uninitialized");
	}
	const candidate = raw as Record<string, unknown>;
	if (
		candidate.schema !== PERSISTED_SCHEMA
		&& candidate.schema !== PREVIOUS_PERSISTED_SCHEMA
		&& candidate.schema !== LEGACY_PERSISTED_SCHEMA
	) return emptyLoadResult("corrupt", "uninitialized");
	if (
		candidate.schema === PERSISTED_SCHEMA
		&& !hasOnlyKeys(candidate, ["schema", "scope", "entries", "stages", "migration"])
	) return emptyLoadResult("corrupt", "uninitialized");
	if (
		candidate.schema === PERSISTED_SCHEMA
		&& (
			!candidate.scope
			|| typeof candidate.scope !== "object"
			|| Array.isArray(candidate.scope)
			|| !hasOnlyKeys(
				candidate.scope as Record<string, unknown>,
				["host", "vaultId", "localDeviceId"],
			)
		)
	) return emptyLoadResult("corrupt", "uninitialized");
	if (!scopeMatches(candidate.scope, expectedScope)) {
		return emptyLoadResult("corrupt", "uninitialized");
	}
	if (!Array.isArray(candidate.entries)) {
		return emptyLoadResult("corrupt", "uninitialized");
	}

	const normalized = normalizeEntries(
		candidate.entries,
		candidate.schema === PERSISTED_SCHEMA,
	);
	if (!normalized) return emptyLoadResult("corrupt", "uninitialized");
	if (candidate.schema === LEGACY_PERSISTED_SCHEMA) {
		return {
			cache: cacheFromEntries(normalized),
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "uninitialized",
			legacyMissingPaths: [],
		};
	}
	if (!candidate.migration || typeof candidate.migration !== "object") {
		return emptyLoadResult("corrupt", "uninitialized");
	}
	const migration = candidate.migration as Record<string, unknown>;
	if (
		(candidate.schema === PERSISTED_SCHEMA
			&& !hasOnlyKeys(migration, ["status", "legacyMissingPaths"]))
		||
		migration.status !== "initialized"
		|| !Array.isArray(migration.legacyMissingPaths)
	) return emptyLoadResult("corrupt", "uninitialized");
	const legacyMissingPaths = normalizePathList(migration.legacyMissingPaths);
	if (!legacyMissingPaths) return emptyLoadResult("corrupt", "uninitialized");
	if (candidate.schema === PREVIOUS_PERSISTED_SCHEMA) {
		return {
			cache: cacheFromEntries(normalized),
			sourceVersions: {},
			stages: {},
			status: "loaded",
			migrationStatus: "initialized",
			legacyMissingPaths,
		};
	}
	if (!Array.isArray(candidate.stages)) {
		return emptyLoadResult("corrupt", "uninitialized");
	}
	const stages = normalizeStageEntries(candidate.stages);
	if (!stages) return emptyLoadResult("corrupt", "uninitialized");
	return {
		cache: cacheFromEntries(normalized),
		sourceVersions: sourceVersionsFromEntries(normalized),
		stages: stageCacheFromEntries(stages),
		status: "loaded",
		migrationStatus: "initialized",
		legacyMissingPaths,
	};
}

function emptyLoadResult(
	status: "missing" | "corrupt",
	migrationStatus: "uninitialized",
): BlobSettledRefLoadResult {
	return {
		cache: {},
		sourceVersions: {},
		stages: {},
		status,
		migrationStatus,
		legacyMissingPaths: [],
	};
}

function normalizeCache(cache: BlobSettledRefCache): PersistedBlobSettledRefEntry[] | null {
	if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
	return normalizeEntries(Object.entries(cache).map(([path, ref]) => ({ path, ref })));
}

function normalizeSourceVersions(
	value: BlobSettledSourceVersionCache,
	settledPaths: ReadonlySet<string>,
): Map<string, string> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const normalized = new Map<string, string>();
	for (const [candidatePath, sourceVersion] of Object.entries(value)) {
		const path = normalizeSettledRefPath(candidatePath);
		if (
			!path
			|| normalized.has(path)
			|| !settledPaths.has(path)
			|| !isBlobSourceVersion(sourceVersion)
		) return null;
		normalized.set(path, sourceVersion);
	}
	return normalized;
}

function normalizeStageCache(
	value: BlobSettlementStageCache,
): PersistedBlobSettlementStageEntry[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return normalizeStageEntries(
		Object.entries(value).map(([path, stage]) => ({ path, ...stage })),
	);
}

function normalizeStageEntries(
	entries: unknown[],
): PersistedBlobSettlementStageEntry[] | null {
	const normalized: PersistedBlobSettlementStageEntry[] = [];
	const seenPaths = new Set<string>();
	for (const value of entries) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const candidate = value as Record<string, unknown>;
		if (!hasOnlyKeys(candidate, [
			"path",
			"stageId",
			"kind",
			"ref",
			"sourceVersion",
			"stagedAt",
		])) return null;
		if (typeof candidate.path !== "string") return null;
		const path = normalizeSettledRefPath(candidate.path);
		const kind = candidate.kind;
		const ref = candidate.ref === undefined
			? undefined
			: normalizeBlobRef(candidate.ref);
		const sourceVersion = candidate.sourceVersion === undefined
			? undefined
			: isBlobSourceVersion(candidate.sourceVersion)
				? candidate.sourceVersion
				: null;
		if (
			!path
			|| seenPaths.has(path)
			|| !isValidStageId(candidate.stageId)
			|| !isSettlementStageKind(kind)
			|| (candidate.ref !== undefined && !ref)
			|| (kind !== "retire" && !ref)
			|| sourceVersion === null
			|| !isValidTimestamp(candidate.stagedAt)
		) return null;
		seenPaths.add(path);
		normalized.push({
			path,
			stageId: candidate.stageId,
			kind,
			...(ref ? { ref } : {}),
			...(sourceVersion !== undefined && { sourceVersion }),
			stagedAt: candidate.stagedAt,
		} as PersistedBlobSettlementStageEntry);
	}
	return normalized;
}

function isValidStageId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 256
		&& value.trim() === value
		&& Array.from(value).every((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
		});
}

function isSettlementStageKind(
	value: unknown,
): value is BlobSettlementStage["kind"] {
	return value === "download"
		|| value === "upload"
		|| value === "equality"
		|| value === "rename"
		|| value === "retire";
}

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0;
}

function normalizeEntries(
	entries: unknown[],
	strictSchema3 = false,
): PersistedBlobSettledRefEntry[] | null {
	const normalized: PersistedBlobSettledRefEntry[] = [];
	const seenPaths = new Set<string>();
	for (const value of entries) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const candidate = value as Record<string, unknown>;
		if (
			strictSchema3
			&& !hasOnlyKeys(candidate, ["path", "ref", "sourceVersion"])
		) return null;
		if (typeof candidate.path !== "string") return null;
		const path = normalizeSettledRefPath(candidate.path);
		const ref = normalizeBlobRef(candidate.ref);
		if (!path || !ref || seenPaths.has(path)) return null;
		const sourceVersion = strictSchema3 && candidate.sourceVersion !== undefined
			? isBlobSourceVersion(candidate.sourceVersion)
				? candidate.sourceVersion
				: null
			: undefined;
		if (sourceVersion === null) return null;
		seenPaths.add(path);
		normalized.push(sourceVersion === undefined
			? { path, ref }
			: { path, ref, sourceVersion });
	}
	return normalized;
}

function normalizeSettledRefPath(path: string): string | null {
	if (path.includes("\0")) return null;
	const normalized = canonicalizeVaultPath(path).normalizedPath;
	if (!normalized || normalized.endsWith("/")) return null;
	return normalized;
}

function normalizePathList(paths: readonly unknown[]): string[] | null {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of paths) {
		if (typeof value !== "string") return null;
		const path = normalizeSettledRefPath(value);
		if (!path || seen.has(path)) return null;
		seen.add(path);
		normalized.push(path);
	}
	return normalized.sort();
}

function normalizeBlobRef(value: unknown): BlobRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (!Object.keys(candidate).every((key) =>
		key === "hash" || key === "size" || key === "priorHashes")) return null;
	if (!isSha256Hex(candidate.hash)) return null;
	if (
		typeof candidate.size !== "number"
		|| !Number.isSafeInteger(candidate.size)
		|| candidate.size < 0
	) return null;

	if (candidate.priorHashes === undefined) {
		return { hash: candidate.hash, size: candidate.size };
	}
	if (
		!Array.isArray(candidate.priorHashes)
		|| candidate.priorHashes.length > MAX_BLOB_REF_PRIOR_HASHES
	) return null;
	const priorHashes: string[] = [];
	for (const hash of candidate.priorHashes) {
		if (
			!isSha256Hex(hash)
			|| hash === candidate.hash
			|| priorHashes.includes(hash)
		) return null;
		priorHashes.push(hash);
	}
	return priorHashes.length > 0
		? { hash: candidate.hash, size: candidate.size, priorHashes }
		: { hash: candidate.hash, size: candidate.size };
}

function cacheFromEntries(entries: PersistedBlobSettledRefEntry[]): BlobSettledRefCache {
	return Object.fromEntries(entries.map(({ path, ref }) => [
		path,
		cloneNormalizedBlobRef(ref),
	]));
}

function sourceVersionsFromEntries(
	entries: PersistedBlobSettledRefEntry[],
): BlobSettledSourceVersionCache {
	return Object.fromEntries(entries.flatMap(({ path, sourceVersion }) =>
		sourceVersion === undefined ? [] : [[path, sourceVersion]],
	));
}

function stageCacheFromEntries(
	entries: PersistedBlobSettlementStageEntry[],
): BlobSettlementStageCache {
	return Object.fromEntries(entries.map(({ path, ...stage }) => [
		path,
		{
			...stage,
			...(stage.ref ? { ref: cloneNormalizedBlobRef(stage.ref) } : {}),
		} as BlobSettlementStage,
	]));
}

function cloneNormalizedBlobRef(ref: BlobRef): BlobRef {
	return ref.priorHashes
		? { hash: ref.hash, size: ref.size, priorHashes: [...ref.priorHashes] }
		: { hash: ref.hash, size: ref.size };
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	const allowed = new Set(allowedKeys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function scopeMatches(value: unknown, expected: BlobSettledRefScope): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.host === expected.host
		&& candidate.vaultId === expected.vaultId
		&& candidate.localDeviceId === expected.localDeviceId;
}

function assertValidScope(scope: BlobSettledRefScope): void {
	if (
		!scope
		|| typeof scope.host !== "string"
		|| scope.host.length === 0
		|| typeof scope.vaultId !== "string"
		|| scope.vaultId.length === 0
		|| typeof scope.localDeviceId !== "string"
		|| scope.localDeviceId.length === 0
	) {
		throw new Error("Blob settled ref scope requires host, vaultId, and localDeviceId");
	}
}

function openDatabase(factory: IndexedDbFactoryLike, dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(dbName, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SETTLED_REF_STORE)) {
				db.createObjectStore(SETTLED_REF_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(
			request.error ?? new Error(`Failed to open IndexedDB database "${dbName}"`),
		);
		request.onblocked = () => reject(
			new Error(`Opening IndexedDB database "${dbName}" was blocked`),
		);
	});
}

function readValue(db: IDBDatabase, key: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(SETTLED_REF_STORE, "readonly");
		let value: unknown;
		transaction.oncomplete = () => resolve(value);
		transaction.onerror = () => reject(
			transaction.error ?? new Error("IndexedDB transaction failed"),
		);
		transaction.onabort = () => reject(
			transaction.error ?? new Error("IndexedDB transaction aborted"),
		);
		const request = transaction.objectStore(SETTLED_REF_STORE).get(key);
		request.onsuccess = () => {
			value = request.result;
		};
		request.onerror = () => reject(
			request.error ?? new Error("IndexedDB request failed"),
		);
	});
}

function writeTransaction(
	db: IDBDatabase,
	write: (store: IDBObjectStore) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(SETTLED_REF_STORE, "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(
			transaction.error ?? new Error("IndexedDB transaction failed"),
		);
		transaction.onabort = () => reject(
			transaction.error ?? new Error("IndexedDB transaction aborted"),
		);
		try {
			write(transaction.objectStore(SETTLED_REF_STORE));
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// Preserve the original operational error.
			}
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function defaultIndexedDbFactory(): IDBFactory {
	if (!globalThis.indexedDB) throw new Error("IndexedDB is not available");
	return globalThis.indexedDB;
}
