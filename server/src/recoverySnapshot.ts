import * as Y from "yjs";
import { gzipSync, gunzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";
import { sha256Hex } from "./hex";

export type FileHistoryReason = "automatic" | "manual" | "pre-upgrade" | "pre-migration" | "pre-bulk-operation";
export type FileHistoryManifestKind = "file-history";
export type FileHistoryStorageVersion = "v2";
export type FileHistoryEntryKind =
	| "created"
	| "modified"
	| "renamed"
	| "deleted"
	| "restored";

export interface FileHistoryEntry {
	fileId: string;
	kind: FileHistoryEntryKind;
	path: string;
	oldPath?: string;
	newPath?: string;
	contentHash?: string;
	previousContentHash?: string;
	deleted?: boolean;
	size?: number;
	mtime?: number;
	device?: string;
}

export interface FileHistoryManifestIndex {
	storageVersion: FileHistoryStorageVersion;
	manifestId: string;
	vaultId: string;
	kind: FileHistoryManifestKind;
	createdAt: string;
	day: string;
	reason: FileHistoryReason;
	pinned: boolean;
	changedCount: number;
	contentHashes: string[];
	changedEntries: FileHistoryEntry[];
	stateHash: string;
	manifestHash: string;
	crdtSchemaVersion?: number;
}

export interface FileHistoryManifest extends FileHistoryManifestIndex {
	schemaVersion: 3;
	storageVersion: "v2";
	kind: "file-history";
}

export interface FileHistoryPointProgress {
	uploadedContentCount: number;
	totalContentCount: number;
	remainingContentCount: number;
}

export interface FileHistoryPendingUpload {
	manifestId: string;
	createdAt: string;
	day: string;
	stateHash: string;
	previousStateHash?: string;
	uploadedContentCount: number;
}

export interface FileHistoryPointResult {
	status: "created" | "noop" | "unavailable" | "pending";
	manifestId?: string;
	reason?: string;
	index?: FileHistoryManifestIndex;
	pending?: FileHistoryPointProgress;
	pendingUpload?: FileHistoryPendingUpload;
}

export interface CreateFileHistoryPointOptions {
	triggeredBy?: string;
	reason?: FileHistoryReason;
	forceFull?: boolean;
	pinned?: boolean;
	now?: Date;
	contentUploadLimit?: number;
	pendingUpload?: FileHistoryPendingUpload | null;
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

export type RecoveryStorageAuditStatus = "healthy" | "repaired" | "degraded" | "empty" | "unavailable";
export type RecoveryStorageIssueSeverity = "warn" | "error";

export interface RecoveryStorageIssue {
	kind: string;
	severity: RecoveryStorageIssueSeverity;
	message: string;
	manifestId?: string;
	objectKey?: string;
	repairable: boolean;
	repaired: boolean;
}

export interface RecoveryStorageRepair {
	kind: string;
	message: string;
	manifestId?: string;
	objectKey?: string;
	success: boolean;
}

export interface RecoveryStorageAuditReport {
	status: RecoveryStorageAuditStatus;
	checkedAt: string;
	latestManifestId: string | null;
	latestIndexManifestId: string | null;
	latestStateManifestId: string | null;
	manifestCount: number;
	manifestCountLowerBound: number;
	checkedManifestCount: number;
	issues: RecoveryStorageIssue[];
	repairs: RecoveryStorageRepair[];
	contentCheckLimited: boolean;
}

export interface RecoveryStorageAuditOptions {
	repair?: boolean;
	manifestCheckLimit?: number;
	contentCheckLimit?: number;
	now?: Date;
}

export type RecoverySnapshotReason = FileHistoryReason;
export type RecoveryManifestKind = FileHistoryManifestKind;
export type RecoveryStorageVersion = FileHistoryStorageVersion;
export type RecoveryEntryKind = FileHistoryEntryKind;
export type RecoveryManifestEntry = FileHistoryEntry;
export type RecoveryManifestIndex = FileHistoryManifestIndex;
export type RecoveryManifest = FileHistoryManifest;
export type RecoverySnapshotResult = FileHistoryPointResult;
export type CreateRecoverySnapshotOptions = CreateFileHistoryPointOptions;

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
	schemaVersion: 3;
	storageVersion: "v2";
	manifestId: string;
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

const RECOVERY_SCHEMA_VERSION = 3;
const RECOVERY_FETCH_CONCURRENCY = 4;
const DEFAULT_RECOVERY_AUDIT_MANIFEST_LIMIT = 20;
const DEFAULT_RECOVERY_AUDIT_CONTENT_LIMIT = 200;
const LATEST_INDEX_KEY_SUFFIX = "latest-index.json";
const LATEST_STATE_KEY_SUFFIX = "latest-state.json.gz";
const RECOVERY_V2_PREFIX = "v2";
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

function recoveryManifestIndexKey(vaultId: string, manifestId: string): string {
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifest-indexes/${manifestId}.json`;
}

function recoveryLatestStateKey(vaultId: string): string {
	return `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/${LATEST_STATE_KEY_SUFFIX}`;
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

function createdAtFromRecoveryManifestId(manifestId: string): string | null {
	const match = /^([0-9a-z]+)-([0-9a-f]{8,})$/.exec(manifestId);
	if (!match) return null;
	const ts = Number.parseInt(match[1] ?? "", 36);
	if (!Number.isSafeInteger(ts) || ts <= 0) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

function manifestIdFromRecoveryManifestKey(vaultId: string, key: string): string | null {
	const prefix = `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifests/`;
	const suffix = ".json.gz";
	if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
	const manifestId = key.slice(prefix.length, -suffix.length);
	return createdAtFromRecoveryManifestId(manifestId) ? manifestId : null;
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
		};
	}

	if (!previousDeleted && currentDeleted) {
		return {
			fileId: current.fileId,
			kind: "deleted",
			path: current.path,
			oldPath: previous.path,
			previousContentHash: previous.contentHash,
			deleted: true,
			size: current.size ?? previous.size,
			mtime: current.mtime,
			device: current.device,
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
		};
	}

	return null;
}

function buildDeletionEntry(previous: RecoveryStateEntry): RecoveryManifestEntry {
	return {
		fileId: previous.fileId,
		kind: "deleted",
		path: previous.path,
		oldPath: previous.path,
		previousContentHash: previous.contentHash,
		deleted: true,
		size: previous.size,
		mtime: previous.mtime,
		device: previous.device,
	};
}

async function readLatestRecoveryState(vaultId: string, bucket: R2Bucket): Promise<RecoveryLatestState | null> {
	return (await readLatestRecoveryStateRaw(vaultId, bucket)).state;
}

async function writeLatestRecoveryState(
	vaultId: string,
	bucket: R2Bucket,
	latest: RecoveryLatestState,
): Promise<void> {
	await bucket.put(recoveryLatestStateKey(vaultId), gzipSync(encoder.encode(JSON.stringify(latest))), {
		httpMetadata: { contentType: "application/gzip" },
	});
}

function isRecoveryLatestState(value: unknown): value is RecoveryLatestState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RecoveryLatestState>;
	return candidate.schemaVersion === RECOVERY_SCHEMA_VERSION &&
		candidate.storageVersion === "v2" &&
		typeof candidate.manifestId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.stateHash === "string" &&
		Array.isArray(candidate.entries) &&
		candidate.entries.every((entry) => {
			if (typeof entry !== "object" || entry === null) return false;
			const stateEntry = entry as Partial<RecoveryStateEntry>;
			return typeof stateEntry.fileId === "string" &&
				typeof stateEntry.path === "string" &&
				(stateEntry.contentHash === undefined || typeof stateEntry.contentHash === "string") &&
				(stateEntry.deleted === undefined || typeof stateEntry.deleted === "boolean") &&
				(stateEntry.size === undefined || typeof stateEntry.size === "number") &&
				(stateEntry.mtime === undefined || typeof stateEntry.mtime === "number") &&
				(stateEntry.device === undefined || typeof stateEntry.device === "string");
		});
}

async function readLatestRecoveryStateRaw(
	vaultId: string,
	bucket: R2Bucket,
): Promise<{ exists: boolean; state: RecoveryLatestState | null; error?: string }> {
	try {
		const object = await bucket.get(recoveryLatestStateKey(vaultId));
		if (!object) return { exists: false, state: null };
		const compressed = new Uint8Array(await object.arrayBuffer());
		const raw = gunzipSync(compressed);
		const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
		if (!isRecoveryLatestState(parsed)) {
			return { exists: true, state: null, error: "invalid latest-state shape" };
		}
		return { exists: true, state: parsed };
	} catch (err) {
		return {
			exists: true,
			state: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function readLatestRecoveryStateWithFallback(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryLatestState | null> {
	return await readLatestRecoveryState(vaultId, bucket);
}

export async function getLatestRecoveryManifestIndex(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifestIndex | null> {
	return (await readLatestRecoveryManifestIndexRaw(vaultId, bucket)).index;
}

async function readLatestRecoveryManifestIndexRaw(
	vaultId: string,
	bucket: R2Bucket,
): Promise<{ exists: boolean; index: RecoveryManifestIndex | null; error?: string }> {
	try {
		const object = await bucket.get(recoveryLatestIndexKey(vaultId));
		if (!object) return { exists: false, index: null };
		const parsed = JSON.parse(await object.text()) as unknown;
		if (!isRecoveryManifestIndex(parsed)) {
			return { exists: true, index: null, error: "invalid latest-index shape" };
		}
		if (parsed.vaultId !== vaultId) {
			return { exists: true, index: null, error: "latest-index vault mismatch" };
		}
		return { exists: true, index: parsed };
	} catch (err) {
		return {
			exists: true,
			index: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

interface PutContentObjectsResult {
	contentHashes: string[];
	uploadedContentCount: number;
	nextUploadedContentCount: number;
	complete: boolean;
}

async function putContentObjects(
	vaultId: string,
	bucket: R2Bucket,
	entries: InternalStateEntry[],
	options: {
		uploadedContentCount?: number;
		limit?: number;
	} = {},
): Promise<PutContentObjectsResult> {
	const unique = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.contentHash || typeof entry.content !== "string") continue;
		unique.set(entry.contentHash, entry.content);
	}

	const hashes = Array.from(unique.keys()).sort();
	const uploadedContentCount = Math.max(
		0,
		Math.min(Math.floor(options.uploadedContentCount ?? 0), hashes.length),
	);
	const uploadLimit = options.limit === undefined
		? hashes.length - uploadedContentCount
		: Math.max(1, Math.floor(options.limit));
	const nextUploadedContentCount = Math.min(hashes.length, uploadedContentCount + uploadLimit);
	const hashesToUpload = hashes.slice(uploadedContentCount, nextUploadedContentCount);

	await mapWithConcurrency(hashesToUpload, RECOVERY_FETCH_CONCURRENCY, async (hash) => {
		const key = recoveryContentKey(vaultId, hash);
		const content = unique.get(hash) ?? "";
		const bytes = encoder.encode(content);
		const actualHash = await sha256Hex(bytes);
		if (actualHash !== hash) {
			throw new Error(`recovery content hash mismatch for ${hash}`);
		}
		// Content keys are content-addressed, so rewriting an existing hash is
		// idempotent and cheaper than spending one R2 request per file on head().
		await bucket.put(key, gzipSync(bytes), {
			httpMetadata: { contentType: "application/gzip" },
		});
	});
	return {
		contentHashes: hashes,
		uploadedContentCount,
		nextUploadedContentCount,
		complete: nextUploadedContentCount >= hashes.length,
	};
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

async function listRecoveryManifestIds(vaultId: string, bucket: R2Bucket): Promise<string[]> {
	const keys = await listAllKeys(bucket, `${RECOVERY_V2_PREFIX}/${vaultId}/recovery/manifests/`);
	return keys
		.map((key) => manifestIdFromRecoveryManifestKey(vaultId, key))
		.filter((manifestId): manifestId is string => manifestId !== null)
		.sort()
		.reverse();
}

async function decodeRecoveryManifestObject(object: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<RecoveryManifest | null> {
	const compressed = new Uint8Array(await object.arrayBuffer());
	const raw = gunzipSync(compressed);
	const manifest = JSON.parse(new TextDecoder().decode(raw)) as RecoveryManifest;
	if (manifest.schemaVersion !== RECOVERY_SCHEMA_VERSION) return null;
	if (manifest.storageVersion !== "v2") return null;
	if (manifest.kind !== "file-history") return null;
	if (!Array.isArray(manifest.changedEntries) || !manifest.changedEntries.every(isFileHistoryEntry)) return null;
	if (typeof manifest.manifestHash !== "string" || manifest.manifestHash.length === 0) return null;

	const expectedHash = manifest.manifestHash;
	manifest.manifestHash = "";
	const actualHash = await sha256Hex(encoder.encode(JSON.stringify(manifest)));
	manifest.manifestHash = expectedHash;
	if (actualHash !== expectedHash) return null;
	return manifest;
}

function recoveryManifestIndexFromManifest(manifest: RecoveryManifest): RecoveryManifestIndex {
	return {
		storageVersion: manifest.storageVersion,
		manifestId: manifest.manifestId,
		vaultId: manifest.vaultId,
		kind: manifest.kind,
		createdAt: manifest.createdAt,
		day: manifest.day,
		reason: manifest.reason,
		pinned: manifest.pinned,
		changedCount: manifest.changedCount,
		contentHashes: manifest.contentHashes,
		changedEntries: manifest.changedEntries,
		stateHash: manifest.stateHash,
		manifestHash: manifest.manifestHash,
		crdtSchemaVersion: manifest.crdtSchemaVersion,
	};
}

function recoveryManifestIndexesMatch(
	actual: RecoveryManifestIndex,
	expected: RecoveryManifestIndex,
): boolean {
	return actual.storageVersion === expected.storageVersion &&
		actual.manifestId === expected.manifestId &&
		actual.vaultId === expected.vaultId &&
		actual.kind === expected.kind &&
		actual.createdAt === expected.createdAt &&
		actual.day === expected.day &&
		actual.reason === expected.reason &&
		actual.pinned === expected.pinned &&
		actual.changedCount === expected.changedCount &&
		actual.stateHash === expected.stateHash &&
		actual.manifestHash === expected.manifestHash &&
		actual.crdtSchemaVersion === expected.crdtSchemaVersion &&
		actual.contentHashes.length === expected.contentHashes.length &&
		actual.contentHashes.every((hash, index) => hash === expected.contentHashes[index]) &&
		JSON.stringify(actual.changedEntries) === JSON.stringify(expected.changedEntries);
}

function isFileHistoryEntry(value: unknown): value is FileHistoryEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<FileHistoryEntry>;
	return typeof candidate.fileId === "string" &&
		(candidate.kind === "created" ||
			candidate.kind === "modified" ||
			candidate.kind === "renamed" ||
			candidate.kind === "deleted" ||
			candidate.kind === "restored") &&
		typeof candidate.path === "string" &&
		(candidate.oldPath === undefined || typeof candidate.oldPath === "string") &&
		(candidate.newPath === undefined || typeof candidate.newPath === "string") &&
		(candidate.contentHash === undefined || typeof candidate.contentHash === "string") &&
		(candidate.previousContentHash === undefined || typeof candidate.previousContentHash === "string") &&
		(candidate.deleted === undefined || typeof candidate.deleted === "boolean") &&
		(candidate.size === undefined || typeof candidate.size === "number") &&
		(candidate.mtime === undefined || typeof candidate.mtime === "number") &&
		(candidate.device === undefined || typeof candidate.device === "string");
}

function isRecoveryManifestIndex(value: unknown): value is RecoveryManifestIndex {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RecoveryManifestIndex>;
	return candidate.storageVersion === "v2" &&
		typeof candidate.manifestId === "string" &&
		typeof candidate.vaultId === "string" &&
		candidate.kind === "file-history" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.day === "string" &&
		(candidate.reason === "automatic" ||
			candidate.reason === "manual" ||
			candidate.reason === "pre-upgrade" ||
			candidate.reason === "pre-migration" ||
			candidate.reason === "pre-bulk-operation") &&
		typeof candidate.pinned === "boolean" &&
		typeof candidate.changedCount === "number" &&
		Array.isArray(candidate.contentHashes) &&
		candidate.contentHashes.every((hash) => typeof hash === "string") &&
		Array.isArray(candidate.changedEntries) &&
		candidate.changedEntries.every(isFileHistoryEntry) &&
		typeof candidate.stateHash === "string" &&
		typeof candidate.manifestHash === "string" &&
		(candidate.crdtSchemaVersion === undefined || typeof candidate.crdtSchemaVersion === "number");
}

async function readRecoveryManifestIndex(
	vaultId: string,
	manifestId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifestIndex | null> {
	return (await readRecoveryManifestIndexRaw(vaultId, manifestId, bucket)).index;
}

async function readRecoveryManifestIndexRaw(
	vaultId: string,
	manifestId: string,
	bucket: R2Bucket,
): Promise<{ exists: boolean; index: RecoveryManifestIndex | null; error?: string }> {
	try {
		const object = await bucket.get(recoveryManifestIndexKey(vaultId, manifestId));
		if (!object) return { exists: false, index: null };
		const parsed = JSON.parse(await object.text()) as unknown;
		if (!isRecoveryManifestIndex(parsed)) {
			return { exists: true, index: null, error: "invalid manifest-index shape" };
		}
		if (parsed.vaultId !== vaultId || parsed.manifestId !== manifestId) {
			return { exists: true, index: null, error: "manifest-index identity mismatch" };
		}
		return { exists: true, index: parsed };
	} catch (err) {
		return {
			exists: true,
			index: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function synthesizeRecoveryManifestIndex(
	vaultId: string,
	manifestId: string,
): RecoveryManifestIndex | null {
	const createdAt = createdAtFromRecoveryManifestId(manifestId);
	if (!createdAt) return null;
	return {
		storageVersion: "v2",
		manifestId,
		vaultId,
		kind: "file-history",
		createdAt,
		day: createdAt.slice(0, 10),
		reason: "automatic",
		pinned: false,
		changedCount: 0,
		contentHashes: [],
		changedEntries: [],
		stateHash: "",
		manifestHash: "",
	};
}

async function listAllRecoveryManifestIndexes(
	vaultId: string,
	bucket: R2Bucket,
): Promise<RecoveryManifestIndex[]> {
	const manifestIds = await listRecoveryManifestIds(vaultId, bucket);
	const indexes = await mapWithConcurrency(manifestIds, RECOVERY_FETCH_CONCURRENCY, async (manifestId) => {
		return await readRecoveryManifestIndex(vaultId, manifestId, bucket)
			?? synthesizeRecoveryManifestIndex(vaultId, manifestId);
	});
	return indexes.filter((index): index is RecoveryManifestIndex => index !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function readRecoveryManifestRaw(
	vaultId: string,
	manifestId: string,
	bucket: R2Bucket,
): Promise<{ exists: boolean; manifest: RecoveryManifest | null; error?: string }> {
	if (!/^([0-9a-z]+)-([0-9a-f]{8,})$/.test(manifestId)) {
		return { exists: false, manifest: null, error: "invalid manifest id" };
	}
	const createdAt = createdAtFromRecoveryManifestId(manifestId);
	if (!createdAt) return { exists: false, manifest: null, error: "invalid manifest timestamp" };
	const day = createdAt.slice(0, 10);
	try {
		const object = await bucket.get(recoveryManifestKey(vaultId, day, manifestId));
		if (!object) return { exists: false, manifest: null };
		const manifest = await decodeRecoveryManifestObject(object);
		if (!manifest) return { exists: true, manifest: null, error: "manifest decode or hash validation failed" };
		return { exists: true, manifest };
	} catch (err) {
		return {
			exists: true,
			manifest: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function auditRecoveryStorage(
	vaultId: string,
	bucket: R2Bucket,
	options: RecoveryStorageAuditOptions = {},
): Promise<RecoveryStorageAuditReport> {
	const repairEnabled = options.repair === true;
	const manifestCheckLimit = Math.max(
		0,
		Math.min(options.manifestCheckLimit ?? DEFAULT_RECOVERY_AUDIT_MANIFEST_LIMIT, 200),
	);
	const contentCheckLimit = Math.max(
		0,
		Math.min(options.contentCheckLimit ?? DEFAULT_RECOVERY_AUDIT_CONTENT_LIMIT, 1000),
	);
	const checkedAt = (options.now ?? new Date()).toISOString();
	const issues: RecoveryStorageIssue[] = [];
	const repairs: RecoveryStorageRepair[] = [];
	let contentCheckLimited = false;
	let manifestIds: string[];

	const reportBase = {
		checkedAt,
		latestManifestId: null,
		latestIndexManifestId: null,
		latestStateManifestId: null,
		manifestCount: 0,
		manifestCountLowerBound: 0,
		checkedManifestCount: 0,
		issues,
		repairs,
		contentCheckLimited,
	} satisfies Omit<RecoveryStorageAuditReport, "status">;

	try {
		manifestIds = await listRecoveryManifestIds(vaultId, bucket);
	} catch (err) {
		issues.push({
			kind: "storage-list-failed",
			severity: "error",
			message: err instanceof Error ? err.message : String(err),
			repairable: false,
			repaired: false,
		});
		return {
			...reportBase,
			status: "unavailable",
			issues,
		};
	}

	function addIssue(input: Omit<RecoveryStorageIssue, "repaired">): RecoveryStorageIssue {
		const issue: RecoveryStorageIssue = { ...input, repaired: false };
		issues.push(issue);
		return issue;
	}

	async function repairIssue(
		issue: RecoveryStorageIssue,
		message: string,
		action: () => Promise<void>,
	): Promise<void> {
		if (!repairEnabled || !issue.repairable) return;
		try {
			await action();
			issue.repaired = true;
			repairs.push({
				kind: issue.kind,
				message,
				manifestId: issue.manifestId,
				objectKey: issue.objectKey,
				success: true,
			});
		} catch (err) {
			repairs.push({
				kind: issue.kind,
				message: err instanceof Error ? err.message : String(err),
				manifestId: issue.manifestId,
				objectKey: issue.objectKey,
				success: false,
			});
		}
	}

	const latestIndex = await readLatestRecoveryManifestIndexRaw(vaultId, bucket);
	const latestState = await readLatestRecoveryStateRaw(vaultId, bucket);
	const checkedManifestIds = manifestIds.slice(0, manifestCheckLimit);
	const checkedManifests: RecoveryManifest[] = [];
	let latestManifest: RecoveryManifest | null = null;
	let newestManifestUnreadable = false;

	for (const manifestId of checkedManifestIds) {
		const raw = await readRecoveryManifestRaw(vaultId, manifestId, bucket);
		if (!raw.manifest) {
			if (manifestId === manifestIds[0]) newestManifestUnreadable = true;
			addIssue({
				kind: raw.exists ? "manifest-corrupt" : "manifest-missing",
				severity: "error",
				message: raw.error ?? "manifest object is missing or unreadable",
				manifestId,
				objectKey: recoveryManifestKey(vaultId, createdAtFromRecoveryManifestId(manifestId)?.slice(0, 10) ?? "", manifestId),
				repairable: false,
			});
			continue;
		}
		checkedManifests.push(raw.manifest);
		latestManifest ??= raw.manifest;
	}

	const canRepairLatestDerived = latestManifest !== null && !newestManifestUnreadable && latestManifest.manifestId === manifestIds[0];
	let latestIndexManifestId = latestIndex.index?.manifestId ?? null;
	let latestStateManifestId = latestState.state?.manifestId ?? null;
	const latestManifestId = latestManifest?.manifestId ?? latestIndex.index?.manifestId ?? manifestIds[0] ?? null;

	if (manifestIds.length === 0) {
		if (latestIndex.exists) {
			addIssue({
				kind: "latest-index-orphaned",
				severity: "error",
				message: "latest-index exists but no file history manifests exist",
				objectKey: recoveryLatestIndexKey(vaultId),
				repairable: false,
			});
		}
		if (latestState.exists) {
			addIssue({
				kind: "latest-state-orphaned",
				severity: "error",
				message: "latest-state exists but no file history manifests exist",
				objectKey: recoveryLatestStateKey(vaultId),
				repairable: false,
			});
		}
		const hasUnrepairedIssue = issues.some((issue) => !issue.repaired);
		return {
			status: hasUnrepairedIssue ? "degraded" : "empty",
			checkedAt,
			latestManifestId: null,
			latestIndexManifestId,
			latestStateManifestId,
			manifestCount: 0,
			manifestCountLowerBound: 0,
			checkedManifestCount: 0,
			issues,
			repairs,
			contentCheckLimited: false,
		};
	}

	{
		const newestManifestId = manifestIds[0];
		const expectedLatestIndex = latestManifest ? recoveryManifestIndexFromManifest(latestManifest) : null;
		let latestIndexIssue: RecoveryStorageIssue | null = null;
		if (!latestIndex.exists) {
			latestIndexIssue = addIssue({
				kind: "latest-index-missing",
				severity: "error",
				message: "latest-index is missing",
				manifestId: newestManifestId,
				objectKey: recoveryLatestIndexKey(vaultId),
				repairable: canRepairLatestDerived,
			});
		} else if (!latestIndex.index) {
			latestIndexIssue = addIssue({
				kind: "latest-index-invalid",
				severity: "error",
				message: latestIndex.error ?? "latest-index is invalid",
				manifestId: newestManifestId,
				objectKey: recoveryLatestIndexKey(vaultId),
				repairable: canRepairLatestDerived,
			});
		} else if (
			latestIndex.index.manifestId !== newestManifestId ||
			(expectedLatestIndex && !recoveryManifestIndexesMatch(latestIndex.index, expectedLatestIndex))
		) {
			latestIndexIssue = addIssue({
				kind: latestIndex.index.manifestId === newestManifestId ? "latest-index-stale" : "latest-index-points-to-old-manifest",
				severity: "error",
				message: "latest-index does not match the latest valid file history manifest",
				manifestId: newestManifestId,
				objectKey: recoveryLatestIndexKey(vaultId),
				repairable: canRepairLatestDerived,
			});
		}
		if (latestIndexIssue && expectedLatestIndex) {
			await repairIssue(latestIndexIssue, "latest-index rebuilt from latest file history manifest", async () => {
				await bucket.put(recoveryLatestIndexKey(vaultId), JSON.stringify(expectedLatestIndex), {
					httpMetadata: { contentType: "application/json" },
				});
			});
			if (latestIndexIssue.repaired) latestIndexManifestId = newestManifestId ?? null;
		}

		let latestStateIssue: RecoveryStorageIssue | null = null;
		if (!latestState.exists) {
			latestStateIssue = addIssue({
				kind: "latest-state-missing",
				severity: "error",
				message: "latest-state is missing",
				manifestId: newestManifestId,
				objectKey: recoveryLatestStateKey(vaultId),
				repairable: false,
			});
		} else if (!latestState.state) {
			latestStateIssue = addIssue({
				kind: "latest-state-corrupt",
				severity: "error",
				message: latestState.error ?? "latest-state is unreadable",
				manifestId: newestManifestId,
				objectKey: recoveryLatestStateKey(vaultId),
				repairable: false,
			});
		} else if (latestState.state.manifestId !== newestManifestId) {
			latestStateIssue = addIssue({
				kind: "latest-state-stale",
				severity: "error",
				message: "latest-state points to an older file history manifest",
				manifestId: newestManifestId,
				objectKey: recoveryLatestStateKey(vaultId),
				repairable: false,
			});
		} else if (latestState.state.stateHash !== (expectedLatestIndex?.stateHash ?? latestIndex.index?.stateHash)) {
			latestStateIssue = addIssue({
				kind: "latest-state-hash-mismatch",
				severity: "error",
				message: "latest-state stateHash does not match the latest file history index",
				manifestId: newestManifestId,
				objectKey: recoveryLatestStateKey(vaultId),
				repairable: false,
			});
		}
		void latestStateIssue;
	}

	for (const manifest of checkedManifests) {
		const expected = recoveryManifestIndexFromManifest(manifest);
		const manifestIndex = await readRecoveryManifestIndexRaw(vaultId, manifest.manifestId, bucket);
		let manifestIndexIssue: RecoveryStorageIssue | null = null;
		if (!manifestIndex.exists) {
			manifestIndexIssue = addIssue({
				kind: "manifest-index-missing",
				severity: "warn",
				message: "manifest-index is missing",
				manifestId: manifest.manifestId,
				objectKey: recoveryManifestIndexKey(vaultId, manifest.manifestId),
				repairable: true,
			});
		} else if (!manifestIndex.index) {
			manifestIndexIssue = addIssue({
				kind: "manifest-index-invalid",
				severity: "warn",
				message: manifestIndex.error ?? "manifest-index is invalid",
				manifestId: manifest.manifestId,
				objectKey: recoveryManifestIndexKey(vaultId, manifest.manifestId),
				repairable: true,
			});
		} else if (!recoveryManifestIndexesMatch(manifestIndex.index, expected)) {
			manifestIndexIssue = addIssue({
				kind: "manifest-index-stale",
				severity: "warn",
				message: "manifest-index does not match its file history manifest",
				manifestId: manifest.manifestId,
				objectKey: recoveryManifestIndexKey(vaultId, manifest.manifestId),
				repairable: true,
			});
		}
		if (manifestIndexIssue) {
			await repairIssue(manifestIndexIssue, "manifest-index rebuilt from file history manifest", async () => {
				await bucket.put(recoveryManifestIndexKey(vaultId, manifest.manifestId), JSON.stringify(expected), {
					httpMetadata: { contentType: "application/json" },
				});
			});
		}
	}

	const contentHashes = new Set<string>();
	for (const manifest of checkedManifests) {
		for (const hash of manifest.contentHashes) contentHashes.add(hash);
		for (const entry of manifest.changedEntries) {
			if (entry.contentHash) contentHashes.add(entry.contentHash);
			if (entry.previousContentHash) contentHashes.add(entry.previousContentHash);
		}
	}
	const contentHashesToCheck = Array.from(contentHashes).filter((hash) => /^[0-9a-f]{64}$/.test(hash));
	if (contentHashesToCheck.length > contentCheckLimit) {
		contentCheckLimited = true;
	}
	for (const hash of contentHashesToCheck.slice(0, contentCheckLimit)) {
		const key = recoveryContentKey(vaultId, hash);
		const object = await bucket.head(key);
		if (!object) {
			addIssue({
				kind: "content-missing",
				severity: "error",
				message: "recovery content object is missing",
				objectKey: key,
				repairable: false,
			});
		}
	}

	const hasUnrepairedIssue = issues.some((issue) => !issue.repaired);
	const hasSuccessfulRepair = repairs.some((repair) => repair.success);
	const status: RecoveryStorageAuditStatus = hasUnrepairedIssue
		? "degraded"
		: hasSuccessfulRepair
			? "repaired"
			: "healthy";
	return {
		status,
		checkedAt,
		latestManifestId,
		latestIndexManifestId,
		latestStateManifestId,
		manifestCount: manifestIds.length,
		manifestCountLowerBound: manifestIds.length,
		checkedManifestCount: checkedManifests.length,
		issues,
		repairs,
		contentCheckLimited,
	};
}

export async function createRecoverySnapshot(
	doc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	options: CreateRecoverySnapshotOptions = {},
): Promise<RecoverySnapshotResult> {
	const now = options.now ?? new Date();
	const latestState = await readLatestRecoveryStateWithFallback(vaultId, bucket);
	const previousByFileId = new Map<string, RecoveryStateEntry>();
	for (const entry of latestState?.entries ?? []) previousByFileId.set(entry.fileId, entry);

	const currentState = await buildRecoveryState(doc);
	const currentByFileId = new Map<string, InternalStateEntry>();
	for (const entry of currentState) currentByFileId.set(entry.fileId, entry);

	const changes: RecoveryManifestEntry[] = [];

	for (const entry of currentState) {
		const change = buildChangeEntry(entry, previousByFileId.get(entry.fileId));
		if (!change) continue;
		changes.push(change);
	}

	for (const previous of previousByFileId.values()) {
		if (currentByFileId.has(previous.fileId)) continue;
		changes.push(buildDeletionEntry(previous));
	}

	if (changes.length === 0 && latestState) {
		return {
			status: "noop",
			reason: "No file-level changes since last file history point",
		};
	}

	const persistedState = currentState.map(toPersistedStateEntry);
	const nextStateHash = await stateHash(persistedState);
	const previousStateHash = latestState?.stateHash ?? null;
	const pendingUpload = options.pendingUpload;
	const canContinuePending = pendingUpload !== null &&
		pendingUpload !== undefined &&
		pendingUpload.stateHash === nextStateHash &&
		(pendingUpload.previousStateHash ?? null) === previousStateHash;
	const manifestId = canContinuePending ? pendingUpload.manifestId : generateRecoveryManifestId(now);
	const createdAt = canContinuePending ? pendingUpload.createdAt : now.toISOString();
	const day = canContinuePending ? pendingUpload.day : today(now);
	const defaultDevice = options.triggeredBy;
	const changedEntries = changes.map((change) => ({
		...change,
		device: change.device ?? defaultDevice,
	}));
	const changedCurrentEntries = changedEntries
		.filter((entry) => entry.kind !== "deleted" && entry.contentHash)
		.map((entry) => currentByFileId.get(entry.fileId))
		.filter((entry): entry is InternalStateEntry => !!entry && typeof entry.content === "string");
	const contentResult = await putContentObjects(vaultId, bucket, changedCurrentEntries, {
		uploadedContentCount: canContinuePending ? pendingUpload.uploadedContentCount : 0,
		limit: options.contentUploadLimit,
	});
	const contentHashes = contentResult.contentHashes;

	if (!contentResult.complete) {
		return {
			status: "pending",
			manifestId,
			reason: "File history content upload is still in progress",
			pending: {
				uploadedContentCount: contentResult.nextUploadedContentCount,
				totalContentCount: contentHashes.length,
				remainingContentCount: contentHashes.length - contentResult.nextUploadedContentCount,
			},
			pendingUpload: {
				manifestId,
				createdAt,
				day,
				stateHash: nextStateHash,
				previousStateHash: previousStateHash ?? undefined,
				uploadedContentCount: contentResult.nextUploadedContentCount,
			},
		};
	}

	const reason = options.reason ?? "automatic";
	const pinned = options.pinned ?? (reason !== "automatic");

	const indexBase = {
		storageVersion: "v2" as const,
		manifestId,
		vaultId,
		kind: "file-history" as const,
		createdAt,
		day,
		reason,
		pinned,
		changedCount: changes.length,
		contentHashes,
		changedEntries,
		stateHash: nextStateHash,
		crdtSchemaVersion: readStoredSchemaVersion(doc) ?? undefined,
	};

	const manifestWithoutHash = {
		schemaVersion: RECOVERY_SCHEMA_VERSION,
		...indexBase,
		manifestHash: "",
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
		createdAt,
		stateHash: nextStateHash,
		entries: persistedState,
	};

	await bucket.put(recoveryManifestKey(vaultId, day, manifestId), gzipSync(encoder.encode(JSON.stringify(manifest))), {
		httpMetadata: { contentType: "application/gzip" },
	});
	await bucket.put(recoveryManifestIndexKey(vaultId, manifestId), JSON.stringify(index), {
		httpMetadata: { contentType: "application/json" },
	});
	await writeLatestRecoveryState(vaultId, bucket, latest);
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
	const boundedManifestIds = await listRecoveryManifestIds(vaultId, bucket);
	const totalManifestKeys = boundedManifestIds.length;
	const fetchManifestIds = boundedManifestIds.slice(0, Math.max(1, Math.min(limit, 200)));
	const manifests = await mapWithConcurrency(fetchManifestIds, RECOVERY_FETCH_CONCURRENCY, async (manifestId): Promise<RecoveryManifestIndex | null> => {
		return await readRecoveryManifestIndex(vaultId, manifestId, bucket)
			?? synthesizeRecoveryManifestIndex(vaultId, manifestId);
	});
	return {
		manifests: manifests.filter((index): index is RecoveryManifestIndex => index !== null)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		totalManifestKeys,
		limited: totalManifestKeys > fetchManifestIds.length,
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
	const manifests = await listAllRecoveryManifestIndexes(vaultId, bucket);
	const { keep, prune } = selectRecoveryRetention(manifests, policy, now);
	const keepWithReferenceData = await mapWithConcurrency(keep, RECOVERY_FETCH_CONCURRENCY, async (manifest) => {
		if (manifest.manifestHash) return manifest;
		const raw = await readRecoveryManifestRaw(vaultId, manifest.manifestId, bucket);
		return raw.manifest ? recoveryManifestIndexFromManifest(raw.manifest) : manifest;
	});
	const errors: string[] = [];
	let prunedManifests = 0;
	for (const manifest of prune) {
		try {
			await bucket.delete([
				recoveryManifestKey(vaultId, manifest.day, manifest.manifestId),
				recoveryManifestIndexKey(vaultId, manifest.manifestId),
			]);
			prunedManifests++;
		} catch (err) {
			errors.push(`${manifest.manifestId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const referencedHashes = new Set<string>();
	for (const manifest of keepWithReferenceData) {
		for (const hash of manifest.contentHashes) referencedHashes.add(hash);
	}
	const keptManifestIds = new Set(keep.map((manifest) => manifest.manifestId));
	for (const manifest of keepWithReferenceData) {
		if (!keptManifestIds.has(manifest.manifestId)) continue;
		for (const entry of manifest.changedEntries) {
			if (entry.contentHash) referencedHashes.add(entry.contentHash);
			if (entry.previousContentHash) referencedHashes.add(entry.previousContentHash);
		}
	}
	const latestState = await readLatestRecoveryStateWithFallback(vaultId, bucket);
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
	return null;
}
