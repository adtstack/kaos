import * as Y from "yjs";
import { gzipSync, gunzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";
import { sha256Hex } from "./hex";

export type RecoverySnapshotReason = "automatic" | "manual" | "pre-upgrade" | "pre-migration" | "pre-bulk-operation";
export type RecoveryManifestKind = "full" | "delta";
export type RecoveryStorageVersion = "v2";
export type RecoveryEntryKind =
	| "created"
	| "modified"
	| "renamed"
	| "deleted"
	| "restored"
	| "unchanged"
	| "attachment-changed";

export interface RecoveryManifestEntry {
	fileId: string;
	kind: RecoveryEntryKind;
	path: string;
	oldPath?: string;
	newPath?: string;
	contentHash?: string;
	previousContentHash?: string;
	deleted?: boolean;
	size?: number;
	mtime?: number;
	device?: string;
	baseManifestId?: string;
}

export interface RecoveryManifestIndex {
	storageVersion?: RecoveryStorageVersion;
	manifestId: string;
	vaultId: string;
	kind: RecoveryManifestKind;
	createdAt: string;
	day: string;
	reason: RecoverySnapshotReason;
	pinned: boolean;
	baseManifestId?: string;
	baseFullManifestId?: string;
	changedCount: number;
	fullFileCount: number;
	contentHashes: string[];
	stateHash: string;
	manifestHash: string;
	crdtSchemaVersion?: number;
}

export interface RecoveryManifest extends RecoveryManifestIndex {
	schemaVersion: 2;
	storageVersion: "v2";
	kind: "full";
	entries: RecoveryManifestEntry[];
}

export interface RecoverySnapshotResult {
	status: "created" | "noop" | "unavailable";
	manifestId?: string;
	reason?: string;
	index?: RecoveryManifestIndex;
}

export interface CreateRecoverySnapshotOptions {
	triggeredBy?: string;
	reason?: RecoverySnapshotReason;
	forceFull?: boolean;
	pinned?: boolean;
	now?: Date;
}

export interface RecoveryRetentionPolicy {
	keepAllMs: number;
	keepDailyMs: number;
	keepMonthlyMonths: number;
}

export interface RecoveryRetentionResult {
	kept: number;
	prunedManifests: number;
	contentDeleted: number;
	failed: number;
	errors: string[];
}

interface RecoveryStateEntry {
	fileId: string;
	path: string;
	contentHash?: string;
	deleted?: boolean;
	size?: number;
	mtime?: number;
	device?: string;
}

interface InternalStateEntry extends RecoveryStateEntry {
	content?: string;
}

interface RecoveryLatestState {
	schemaVersion: 2;
	storageVersion: "v2";
	manifestId: string;
	latestFullManifestId: string;
	latestFullCreatedAt: string;
	deltaCountSinceFull: number;
	createdAt: string;
	stateHash: string;
	entries: RecoveryStateEntry[];
}

interface FileMetaLike {
	path?: unknown;
	deleted?: unknown;
	deletedAt?: unknown;
	mtime?: unknown;
	device?: unknown;
}

interface RecoveryContentBundleIndexEntry {
	manifestId: string;
	key: string;
	hashes: string[];
}

interface RecoveryContentBundleIndex {
	schemaVersion: 1;
	updatedAt: string;
	bundles: RecoveryContentBundleIndexEntry[];
}

interface RecoveryContentBundle {
	schemaVersion: 1;
	manifestId: string;
	createdAt: string;
	contents: Record<string, string>;
}

const RECOVERY_SCHEMA_VERSION = 2;
const RECOVERY_FETCH_CONCURRENCY = 4;
const LATEST_INDEX_KEY_SUFFIX = "latest-index.json";
const LATEST_STATE_KEY_SUFFIX = "latest-state.json.gz";
const CONTENT_BUNDLE_INDEX_KEY_SUFFIX = "content-bundle-index.json";
const RECOVERY_V2_PREFIX = "v2";
const RECOVERY_LEGACY_PREFIX = "v1";
export const DEFAULT_RECOVERY_RETENTION: RecoveryRetentionPolicy = {
	keepAllMs: 30 * 24 * 60 * 60 * 1000,
	keepDailyMs: 365 * 24 * 60 * 60 * 1000,
	keepMonthlyMonths: 60,
};

const encoder = new TextEncoder();

export function recoveryManifestPrefix(vaultId: string, day: string, manifestId: string): string {
	void day;
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifests/${manifestId}`;
}

export function recoveryManifestKey(vaultId: string, day: string, manifestId: string): string {
	return `${recoveryManifestPrefix(vaultId, day, manifestId)}.json.gz`;
}

export function recoveryContentKey(vaultId: string, hash: string): string {
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/content/${hash}.md.gz`;
}

function recoveryLatestIndexKey(vaultId: string): string {
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/${LATEST_INDEX_KEY_SUFFIX}`;
}

function recoveryLatestStateKey(vaultId: string): string {
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/${LATEST_STATE_KEY_SUFFIX}`;
}

function recoveryContentBundleIndexKey(vaultId: string): string {
	return `${RECOVERY_LEGACY_PREFIX}/${vaultId}/recovery/${CONTENT_BUNDLE_INDEX_KEY_SUFFIX}`;
}

function legacyRecoveryContentKey(vaultId: string, hash: string): string {
	return `${RECOVERY_LEGACY_PREFIX}/${vaultId}/recovery/content/${hash}.md.gz`;
}

function today(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function generateRecoveryManifestId(now = new Date()): string {
	const ts = now.getTime().toString(36);
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${ts}-${rand}`;
}

function isDeletedMeta(meta: FileMetaLike | undefined): boolean {
	if (!meta) return false;
	return meta.deleted === true || (typeof meta.deletedAt === "number" && Number.isFinite(meta.deletedAt));
}

function readStoredSchemaVersion(doc: Y.Doc): number | null {
	const stored = doc.getMap("sys").get("schemaVersion");
	return typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : null;
}

function usesV2MetaPathModel(doc: Y.Doc): boolean {
	const version = readStoredSchemaVersion(doc);
	return version !== null && version >= 2;
}

function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function isYMapLike(value: unknown): value is { get(key: string): unknown } {
	return value instanceof Y.Map ||
		(typeof value === "object" &&
			value !== null &&
			typeof (value as { get?: unknown }).get === "function" &&
			typeof (value as { set?: unknown }).set === "function" &&
			typeof (value as { forEach?: unknown }).forEach === "function");
}

export function decodeRecoveryFileMeta(value: unknown): FileMetaLike | null {
	if (!value || typeof value !== "object") return null;
	if (isYMapLike(value)) {
		const path = value.get("path");
		if (typeof path !== "string" || path.length === 0) return null;
		const deleted = value.get("deleted");
		const deletedAt = value.get("deletedAt");
		const mtime = value.get("mtime");
		const device = value.get("device");
		return {
			path,
			deleted: deleted === true ? true : undefined,
			deletedAt: typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : undefined,
			mtime: typeof mtime === "number" && Number.isFinite(mtime) ? mtime : undefined,
			device: typeof device === "string" ? device : undefined,
		};
	}
	return value as FileMetaLike;
}

async function contentHash(content: string): Promise<string> {
	return sha256Hex(encoder.encode(content));
}

async function stateHash(entries: RecoveryStateEntry[]): Promise<string> {
	const stable = entries
		.map((entry) => ({
			fileId: entry.fileId,
			path: entry.path,
			contentHash: entry.contentHash ?? null,
			deleted: entry.deleted === true,
			size: entry.size ?? null,
			mtime: entry.mtime ?? null,
			device: entry.device ?? null,
		}))
		.sort((a, b) => a.fileId.localeCompare(b.fileId));
	return sha256Hex(encoder.encode(JSON.stringify(stable)));
}

async function buildRecoveryState(doc: Y.Doc): Promise<InternalStateEntry[]> {
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap<unknown>("meta");
	const pathToId = doc.getMap<string>("pathToId");
	const entriesByFileId = new Map<string, InternalStateEntry>();

	meta.forEach((raw, fileId) => {
		const decoded = decodeRecoveryFileMeta(raw);
		if (!decoded || typeof decoded.path !== "string") return;
		const path = normalizeVaultPath(decoded.path);
		if (!path) return;
		entriesByFileId.set(fileId, {
			fileId,
			path,
			deleted: isDeletedMeta(decoded) || undefined,
			mtime: typeof decoded.mtime === "number" ? decoded.mtime : undefined,
			device: typeof decoded.device === "string" ? decoded.device : undefined,
		});
	});

	if (!usesV2MetaPathModel(doc)) {
		pathToId.forEach((fileId, rawPath) => {
			const path = normalizeVaultPath(rawPath);
			if (!path) return;
			const existing = entriesByFileId.get(fileId);
			if (existing && existing.deleted) return;
			entriesByFileId.set(fileId, {
				...existing,
				fileId,
				path,
				deleted: undefined,
			});
		});
	}

	const result: InternalStateEntry[] = [];
	for (const entry of entriesByFileId.values()) {
		const text = idToText.get(entry.fileId);
		const content = text?.toJSON();
		if (typeof content === "string") {
			const hash = await contentHash(content);
			result.push({
				...entry,
				content,
				contentHash: hash,
				size: encoder.encode(content).byteLength,
			});
		} else {
			result.push(entry);
		}
	}

	result.sort((a, b) => a.fileId.localeCompare(b.fileId));
	return result;
}

function toPersistedStateEntry(entry: InternalStateEntry): RecoveryStateEntry {
	return {
		fileId: entry.fileId,
		path: entry.path,
		contentHash: entry.contentHash,
		deleted: entry.deleted,
		size: entry.size,
		mtime: entry.mtime,
		device: entry.device,
	};
}

function buildChangeEntry(
	current: InternalStateEntry,
	previous: RecoveryStateEntry | undefined,
	baseManifestId: string | undefined,
): RecoveryManifestEntry | null {
	if (!previous) {
		return {
			fileId: current.fileId,
			kind: current.deleted ? "deleted" : "created",
			path: current.path,
			contentHash: current.contentHash,
			deleted: current.deleted,
			size: current.size,
			mtime: current.mtime,
			device: current.device,
			baseManifestId,
		};
	}

	const previousDeleted = previous.deleted === true;
	const currentDeleted = current.deleted === true;
	const pathChanged = previous.path !== current.path;
	const contentChanged = previous.contentHash !== current.contentHash;

	if (previousDeleted && !currentDeleted) {
		return {
			fileId: current.fileId,
			kind: "restored",
			path: current.path,
			oldPath: previous.path,
			newPath: current.path,
			contentHash: current.contentHash,
			previousContentHash: previous.contentHash,
			deleted: current.deleted,
			size: current.size,
			mtime: current.mtime,
			device: current.device,
			baseManifestId,
		};
	}

	if (!previousDeleted && currentDeleted) {
		return {
			fileId: current.fileId,
			kind: "deleted",
			path: current.path,
			oldPath: previous.path,
			contentHash: current.contentHash ?? previous.contentHash,
			previousContentHash: previous.contentHash,
			deleted: true,
			size: current.size ?? previous.size,
			mtime: current.mtime,
			device: current.device,
			baseManifestId,
		};
	}

	if (pathChanged) {
		return {
			fileId: current.fileId,
			kind: "renamed",
			path: current.path,
			oldPath: previous.path,
			newPath: current.path,
			contentHash: current.contentHash,
			previousContentHash: previous.contentHash,
			deleted: current.deleted,
			size: current.size,
			mtime: current.mtime,
			device: current.device,
			baseManifestId,
		};
	}

	if (contentChanged) {
		return {
			fileId: current.fileId,
			kind: "modified",
			path: current.path,
			contentHash: current.contentHash,
			previousContentHash: previous.contentHash,
			deleted: current.deleted,
			size: current.size,
			mtime: current.mtime,
			device: current.device,
			baseManifestId,
		};
	}

	return null;
}

function buildDeletionEntry(
	previous: RecoveryStateEntry,
	baseManifestId: string | undefined,
): RecoveryManifestEntry {
	return {
		fileId: previous.fileId,
		kind: "deleted",
		path: previous.path,
		oldPath: previous.path,
		contentHash: previous.contentHash,
		previousContentHash: previous.contentHash,
		deleted: true,
		size: previous.size,
		mtime: previous.mtime,
		device: previous.device,
		baseManifestId,
	};
}

async function readLatestRecoveryState(vaultId: string, bucket: R2Bucket): Promise<RecoveryLatestState | null> {
	try {
		const object = await bucket.get(recoveryLatestStateKey(vaultId));
		if (!object) return null;
		const compressed = new Uint8Array(await object.arrayBuffer());
		const raw = gunzipSync(compressed);
		return JSON.parse(new TextDecoder().decode(raw)) as RecoveryLatestState;
	} catch {
		return null;
	}
}

async function readContentBundleIndex(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryContentBundleIndex | null> {
	try {
		const object = await bucket.get(recoveryContentBundleIndexKey(vaultId));
		if (!object) return null;
		const parsed = JSON.parse(await object.text()) as RecoveryContentBundleIndex;
		if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.bundles)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function getLatestRecoveryManifestIndex(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifestIndex | null> {
	try {
		const object = await bucket.get(recoveryLatestIndexKey(vaultId));
		if (!object) return null;
		return JSON.parse(await object.text()) as RecoveryManifestIndex;
	} catch {
		return null;
	}
}

async function putContentObjects(
	vaultId: string,
	bucket: R2Bucket,
	entries: InternalStateEntry[],
): Promise<string[]> {
	const unique = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.contentHash || typeof entry.content !== "string") continue;
		unique.set(entry.contentHash, entry.content);
	}

	const hashes = Array.from(unique.keys()).sort();
	await mapWithConcurrency(hashes, RECOVERY_FETCH_CONCURRENCY, async (hash) => {
		const key = recoveryContentKey(vaultId, hash);
		const existing = await bucket.head(key);
		if (existing) return;
		const content = unique.get(hash) ?? "";
		const bytes = encoder.encode(content);
		const actualHash = await sha256Hex(bytes);
		if (actualHash !== hash) {
			throw new Error(`recovery content hash mismatch for ${hash}`);
		}
		await bucket.put(key, gzipSync(bytes), {
			httpMetadata: { contentType: "application/gzip" },
		});
	});
	return hashes;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const page = await bucket.list({ prefix, limit: 1000, cursor });
		for (const object of page.objects) keys.push(object.key);
		if (!page.truncated) break;
		cursor = page.cursor;
	}
	return keys;
}

async function decodeRecoveryManifestObject(object: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<RecoveryManifest | null> {
	const compressed = new Uint8Array(await object.arrayBuffer());
	const raw = gunzipSync(compressed);
	const manifest = JSON.parse(new TextDecoder().decode(raw)) as RecoveryManifest;
	if (manifest.schemaVersion !== RECOVERY_SCHEMA_VERSION) return null;
	if (manifest.storageVersion !== "v2") return null;
	if (manifest.kind !== "full") return null;
	if (typeof manifest.manifestHash !== "string" || manifest.manifestHash.length === 0) return null;

	const expectedHash = manifest.manifestHash;
	manifest.manifestHash = "";
	const actualHash = await sha256Hex(encoder.encode(JSON.stringify(manifest)));
	manifest.manifestHash = expectedHash;
	if (actualHash !== expectedHash) return null;
	return manifest;
}

async function listAllRecoveryManifests(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifest[]> {
	const keys = await listAllKeys(bucket, `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifests/`);
	const manifestKeys = keys
		.filter((key) => key.endsWith(".json.gz"))
		.sort()
		.reverse();
	const manifests = await mapWithConcurrency(manifestKeys, RECOVERY_FETCH_CONCURRENCY, async (key) => {
		const object = await bucket.get(key);
		if (!object) return null;
		return await decodeRecoveryManifestObject(object);
	});
	return manifests.filter((manifest): manifest is RecoveryManifest => manifest !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createRecoverySnapshot(
	doc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	options: CreateRecoverySnapshotOptions = {},
): Promise<RecoverySnapshotResult> {
	const now = options.now ?? new Date();
	const createdAt = now.toISOString();
	const latestState = await readLatestRecoveryState(vaultId, bucket);
	const previousByFileId = new Map<string, RecoveryStateEntry>();
	for (const entry of latestState?.entries ?? []) previousByFileId.set(entry.fileId, entry);

	const currentState = await buildRecoveryState(doc);
	const currentByFileId = new Map<string, InternalStateEntry>();
	for (const entry of currentState) currentByFileId.set(entry.fileId, entry);

	const baseManifestId = latestState?.manifestId;
	const changes: RecoveryManifestEntry[] = [];

	for (const entry of currentState) {
		const change = buildChangeEntry(entry, previousByFileId.get(entry.fileId), baseManifestId);
		if (!change) continue;
		changes.push(change);
	}

	for (const previous of previousByFileId.values()) {
		if (currentByFileId.has(previous.fileId)) continue;
		changes.push(buildDeletionEntry(previous, baseManifestId));
	}

	if (changes.length === 0 && latestState) {
		return {
			status: "noop",
			reason: "No file-level changes since last recovery snapshot",
		};
	}

	const manifestId = generateRecoveryManifestId(now);
	const manifestKind = "full" as const;
	const persistedState = currentState.map(toPersistedStateEntry);
	const nextStateHash = await stateHash(persistedState);
	const defaultDevice = options.triggeredBy;

	const changeByFileId = new Map(changes.map((entry) => [entry.fileId, entry]));
	const manifestEntries = currentState.map<RecoveryManifestEntry>((entry) => {
		const change = changeByFileId.get(entry.fileId);
		return {
			fileId: entry.fileId,
			kind: change?.kind ?? "unchanged",
			path: entry.path,
			oldPath: change?.oldPath,
			newPath: change?.newPath,
			contentHash: entry.contentHash,
			previousContentHash: change?.previousContentHash,
			deleted: entry.deleted,
			size: entry.size,
			mtime: entry.mtime,
			device: entry.device ?? defaultDevice,
			baseManifestId,
		};
	});
	for (const change of changes) {
		if (change.kind === "deleted" && !currentByFileId.has(change.fileId)) {
			manifestEntries.push({
				...change,
				device: change.device ?? defaultDevice,
			});
		}
	}

	const contentHashes = await putContentObjects(vaultId, bucket, currentState);

	const reason = options.reason ?? "automatic";
	const pinned = options.pinned ?? (reason !== "automatic");
	const day = today(now);

	const indexBase = {
		storageVersion: "v2" as const,
		manifestId,
		vaultId,
		kind: manifestKind,
		createdAt,
		day,
		reason,
		pinned,
		baseManifestId,
		baseFullManifestId: manifestId,
		changedCount: changes.length,
		fullFileCount: currentState.length,
		contentHashes,
		stateHash: nextStateHash,
		crdtSchemaVersion: readStoredSchemaVersion(doc) ?? undefined,
	};

	const manifestWithoutHash = {
		schemaVersion: RECOVERY_SCHEMA_VERSION,
		...indexBase,
		manifestHash: "",
		entries: manifestEntries,
	} satisfies RecoveryManifest;
	const manifestBytes = encoder.encode(JSON.stringify(manifestWithoutHash));
	const manifestHash = await sha256Hex(manifestBytes);
	const manifest: RecoveryManifest = {
		...manifestWithoutHash,
		manifestHash,
	};
	const index: RecoveryManifestIndex = {
		...indexBase,
		manifestHash,
	};

	const latest: RecoveryLatestState = {
		schemaVersion: RECOVERY_SCHEMA_VERSION,
		storageVersion: "v2",
		manifestId,
		latestFullManifestId: manifestId,
		latestFullCreatedAt: createdAt,
		deltaCountSinceFull: 0,
		createdAt,
		stateHash: nextStateHash,
		entries: persistedState,
	};

	await bucket.put(recoveryManifestKey(vaultId, day, manifestId), gzipSync(encoder.encode(JSON.stringify(manifest))), {
		httpMetadata: { contentType: "application/gzip" },
	});
	await bucket.put(recoveryLatestStateKey(vaultId), gzipSync(encoder.encode(JSON.stringify(latest))), {
		httpMetadata: { contentType: "application/gzip" },
	});
	await bucket.put(recoveryLatestIndexKey(vaultId), JSON.stringify(index), {
		httpMetadata: { contentType: "application/json" },
	});

	return {
		status: "created",
		manifestId,
		index,
	};
}

export async function listRecoveryManifestIndexes(
	vaultId: string,
	bucket: R2Bucket,
	limit = 50,
): Promise<{ manifests: RecoveryManifestIndex[]; totalManifestKeys: number; limited: boolean }> {
	const keys = await listAllKeys(bucket, `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifests/`);
	const bounded = keys
		.filter((key) => key.endsWith(".json.gz"))
		.sort()
		.reverse();
	const totalManifestKeys = bounded.length;
	const fetchKeys = bounded.slice(0, Math.max(1, Math.min(limit, 200)));
	const manifests = await mapWithConcurrency(fetchKeys, RECOVERY_FETCH_CONCURRENCY, async (key): Promise<RecoveryManifestIndex | null> => {
		const object = await bucket.get(key);
		if (!object) return null;
		const manifest = await decodeRecoveryManifestObject(object);
		if (!manifest) return null;
		const index: RecoveryManifestIndex = {
			storageVersion: manifest.storageVersion,
			manifestId: manifest.manifestId,
			vaultId: manifest.vaultId,
			kind: manifest.kind,
			createdAt: manifest.createdAt,
			day: manifest.day,
			reason: manifest.reason,
			pinned: manifest.pinned,
			changedCount: manifest.changedCount,
			fullFileCount: manifest.fullFileCount,
			contentHashes: manifest.contentHashes,
			stateHash: manifest.stateHash,
			manifestHash: manifest.manifestHash,
		};
		if (manifest.baseManifestId !== undefined) index.baseManifestId = manifest.baseManifestId;
		if (manifest.baseFullManifestId !== undefined) index.baseFullManifestId = manifest.baseFullManifestId;
		if (manifest.crdtSchemaVersion !== undefined) index.crdtSchemaVersion = manifest.crdtSchemaVersion;
		return index;
	});
	return {
		manifests: manifests.filter((index): index is RecoveryManifestIndex => index !== null)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		totalManifestKeys,
		limited: totalManifestKeys > fetchKeys.length,
	};
}

export function selectRecoveryRetention(
	manifests: RecoveryManifestIndex[],
	policy: RecoveryRetentionPolicy = DEFAULT_RECOVERY_RETENTION,
	now = new Date(),
): { keep: RecoveryManifestIndex[]; prune: RecoveryManifestIndex[] } {
	if (manifests.length === 0) return { keep: [], prune: [] };
	const sorted = manifests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const latestId = sorted[0]?.manifestId;
	const monthlyCutoff = new Date(Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth() - policy.keepMonthlyMonths,
		1,
	)).getTime();
	const seenDays = new Set<string>();
	const seenMonths = new Set<string>();

	const keep: RecoveryManifestIndex[] = [];
	const prune: RecoveryManifestIndex[] = [];
	for (const manifest of sorted) {
		const createdTime = new Date(manifest.createdAt).getTime();
		const ageMs = Number.isFinite(createdTime) ? now.getTime() - createdTime : NaN;
		let shouldKeep = false;

		if (manifest.storageVersion !== "v2") {
			shouldKeep = true;
		} else if (manifest.manifestId === latestId || manifest.pinned || manifest.reason !== "automatic") {
			shouldKeep = true;
		} else if (!Number.isFinite(ageMs)) {
			shouldKeep = true;
		} else if (ageMs <= policy.keepAllMs) {
			shouldKeep = true;
		} else if (ageMs <= policy.keepDailyMs) {
			const day = manifest.day || manifest.createdAt.slice(0, 10);
			if (!seenDays.has(day)) {
				seenDays.add(day);
				shouldKeep = true;
			}
		} else if (createdTime >= monthlyCutoff) {
			const month = manifest.createdAt.slice(0, 7);
			if (!seenMonths.has(month)) {
				seenMonths.add(month);
				shouldKeep = true;
			}
		}

		if (shouldKeep) {
			keep.push(manifest);
		} else {
			prune.push(manifest);
		}
	}
	return { keep, prune };
}

export async function applyRecoveryRetention(
	vaultId: string,
	bucket: R2Bucket,
	policy: RecoveryRetentionPolicy = DEFAULT_RECOVERY_RETENTION,
	now = new Date(),
): Promise<RecoveryRetentionResult> {
	const manifests = await listAllRecoveryManifests(vaultId, bucket);
	const { keep, prune } = selectRecoveryRetention(manifests, policy, now);
	const errors: string[] = [];
	let prunedManifests = 0;
	for (const manifest of prune) {
		try {
			await bucket.delete(recoveryManifestKey(vaultId, manifest.day, manifest.manifestId));
			prunedManifests++;
		} catch (err) {
			errors.push(`${manifest.manifestId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const referencedHashes = new Set<string>();
	for (const manifest of keep) {
		for (const hash of manifest.contentHashes) referencedHashes.add(hash);
	}
	const keptManifestIds = new Set(keep.map((manifest) => manifest.manifestId));
	for (const manifest of manifests) {
		if (!keptManifestIds.has(manifest.manifestId)) continue;
		for (const entry of manifest.entries) {
			if (entry.contentHash) referencedHashes.add(entry.contentHash);
			if (entry.previousContentHash) referencedHashes.add(entry.previousContentHash);
		}
	}
	const latestState = await readLatestRecoveryState(vaultId, bucket);
	for (const entry of latestState?.entries ?? []) {
		if (entry.contentHash) referencedHashes.add(entry.contentHash);
	}

	const contentKeys = await listAllKeys(bucket, `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/content/`);
	let contentDeleted = 0;
	for (const key of contentKeys) {
		const match = /\/content\/([0-9a-f]{64})\.md\.gz$/.exec(key);
		const hash = match?.[1];
		if (!hash || referencedHashes.has(hash)) continue;
		try {
			await bucket.delete(key);
			contentDeleted++;
		} catch (err) {
			errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		kept: keep.length,
		prunedManifests,
		contentDeleted,
		failed: errors.length,
		errors,
	};
}

export async function getRecoveryManifest(
	vaultId: string,
	manifestId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifest | null> {
	if (!/^([0-9a-z]+)-([0-9a-f]{8,})$/.test(manifestId)) return null;
	const ts = Number.parseInt(manifestId.split("-")[0] ?? "", 36);
	if (!Number.isSafeInteger(ts) || ts <= 0) return null;
	const day = new Date(ts).toISOString().slice(0, 10);
	const object = await bucket.get(recoveryManifestKey(vaultId, day, manifestId));
	if (!object) return null;
	return await decodeRecoveryManifestObject(object);
}

export async function getRecoveryContent(
	vaultId: string,
	hash: string,
	bucket: R2Bucket,
): Promise<{ text: string; compressedBytes: Uint8Array } | null> {
	if (!/^[0-9a-f]{64}$/.test(hash)) return null;
	const object = await bucket.get(recoveryContentKey(vaultId, hash));
	if (object) {
		const compressed = new Uint8Array(await object.arrayBuffer());
		const raw = gunzipSync(compressed);
		const actual = await sha256Hex(raw);
		if (actual !== hash) {
			throw new Error(`recovery content hash mismatch: expected ${hash}, got ${actual}`);
		}
		return {
			text: new TextDecoder().decode(raw),
			compressedBytes: compressed,
		};
	}

	const legacyObject = await bucket.get(legacyRecoveryContentKey(vaultId, hash));
	if (legacyObject) {
		const compressed = new Uint8Array(await legacyObject.arrayBuffer());
		const raw = gunzipSync(compressed);
		const actual = await sha256Hex(raw);
		if (actual !== hash) {
			throw new Error(`legacy recovery content hash mismatch: expected ${hash}, got ${actual}`);
		}
		return {
			text: new TextDecoder().decode(raw),
			compressedBytes: compressed,
		};
	}

	const bundleIndex = await readContentBundleIndex(vaultId, bucket);
	const bundleRefs = bundleIndex?.bundles.filter((bundle) => bundle.hashes.includes(hash)) ?? [];
	for (const bundleRef of bundleRefs) {
		const bundleObject = await bucket.get(bundleRef.key);
		if (!bundleObject) continue;
		const compressedBundle = new Uint8Array(await bundleObject.arrayBuffer());
		const rawBundle = gunzipSync(compressedBundle);
		const bundle = JSON.parse(new TextDecoder().decode(rawBundle)) as RecoveryContentBundle;
		const text = bundle.contents?.[hash];
		if (typeof text !== "string") continue;
		const bytes = encoder.encode(text);
		const actual = await sha256Hex(bytes);
		if (actual !== hash) {
			throw new Error(`recovery bundled content hash mismatch: expected ${hash}, got ${actual}`);
		}
		return {
			text,
			compressedBytes: gzipSync(bytes),
		};
	}
	return null;
}
