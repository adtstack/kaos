import {
	MAX_BLOB_REF_PRIOR_HASHES,
	cloneBlobRef,
	isSha256Hex,
	type BlobRef,
} from "../types";
import type { BlobQueueSnapshot } from "./blobSync";
import {
	REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS,
} from "./preservedUnresolved";
import {
	isBlobSourceVersion,
	type PendingBlobIntentScope,
} from "./pendingBlobIntentJournal";

export const PERSISTED_BLOB_QUEUE_VERSION = 1;

/**
 * data.json can itself be copied between devices. A transfer queue therefore
 * carries the exact local authority scope that created it and is only a hint
 * inside that same scope.
 */
export interface PersistedBlobQueueSnapshot {
	version: typeof PERSISTED_BLOB_QUEUE_VERSION;
	scope: PendingBlobIntentScope;
	queue: BlobQueueSnapshot;
}

const PERSISTED_QUEUE_KEYS = new Set(["version", "scope", "queue"]);
const SCOPE_KEYS = new Set(["host", "vaultId", "localDeviceId"]);
const UPLOAD_KEYS = new Set([
	"path",
	"sizeBytes",
	"baseRefKnown",
	"expectedBaseRef",
	"expectedBaseSourceVersion",
	"causalBaseRef",
	"retries",
	"status",
	"readyAt",
	"attentionResolution",
	"deferredUntilSettlement",
	"needsRerun",
	"rerunResets",
]);
const DOWNLOAD_KEYS = new Set([
	"path",
	"hash",
	"sizeBytes",
	"targetRefFingerprint",
	"acceptableLocalHashes",
	"retries",
	"status",
	"readyAt",
	"needsRerun",
	"rerunResets",
]);
const REMOTE_DELETE_ATTENTION_RESOLUTION_KEYS = new Set([
	"kind",
	"expectedReason",
	"episodeId",
	"remoteDeleteFingerprint",
]);
const DOWNLOAD_CONFLICT_ATTENTION_RESOLUTION_KEYS = new Set([
	"kind",
	"expectedReason",
	"episodeId",
	"expectedLocalHash",
	"expectedRemoteHash",
	"expectedRemoteRef",
	"expectedRemoteSourceVersion",
	"artifactPath",
	"artifactMtime",
	"artifactSize",
]);
const REMOTE_DELETE_REASONS = new Set<string>(
	REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isOptionalNonNegativeSafeInteger(value: unknown): boolean {
	return value === undefined
		|| (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isBlobRef(value: unknown): value is BlobRef {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["hash", "size", "priorHashes"]))) {
		return false;
	}
	if (
		!isSha256Hex(value.hash)
		|| typeof value.size !== "number"
		|| !Number.isSafeInteger(value.size)
		|| value.size < 0
	) return false;
	if (value.priorHashes === undefined) return true;
	if (
		!Array.isArray(value.priorHashes)
		|| value.priorHashes.length > MAX_BLOB_REF_PRIOR_HASHES
	) return false;
	const seen = new Set<string>();
	for (const priorHash of value.priorHashes) {
		if (
			!isSha256Hex(priorHash)
			|| priorHash === value.hash
			|| seen.has(priorHash)
		) return false;
		seen.add(priorHash);
	}
	return true;
}

function isScope(value: unknown): value is PendingBlobIntentScope {
	if (!isRecord(value) || !hasOnlyKeys(value, SCOPE_KEYS)) return false;
	return Object.keys(value).length === SCOPE_KEYS.size
		&& typeof value.host === "string"
		&& value.host.length > 0
		&& typeof value.vaultId === "string"
		&& value.vaultId.length > 0
		&& typeof value.localDeviceId === "string"
		&& value.localDeviceId.length > 0;
}

function sameScope(
	left: PendingBlobIntentScope,
	right: PendingBlobIntentScope,
): boolean {
	return left.host === right.host
		&& left.vaultId === right.vaultId
		&& left.localDeviceId === right.localDeviceId;
}

function isAttentionResolution(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "keep-local-remote-delete") {
		return hasOnlyKeys(value, REMOTE_DELETE_ATTENTION_RESOLUTION_KEYS)
			&& Object.keys(value).length === REMOTE_DELETE_ATTENTION_RESOLUTION_KEYS.size
			&& typeof value.expectedReason === "string"
			&& REMOTE_DELETE_REASONS.has(value.expectedReason)
			&& typeof value.episodeId === "string"
			&& value.episodeId.length > 0
			&& typeof value.remoteDeleteFingerprint === "string"
			&& value.remoteDeleteFingerprint.length > 0;
	}
	if (value.kind !== "keep-local-download-conflict") return false;
	return hasOnlyKeys(value, DOWNLOAD_CONFLICT_ATTENTION_RESOLUTION_KEYS)
		&& Object.keys(value).length === DOWNLOAD_CONFLICT_ATTENTION_RESOLUTION_KEYS.size
		&& value.expectedReason === "remote-download-local-conflict"
		&& typeof value.episodeId === "string"
		&& value.episodeId.length > 0
		&& isSha256Hex(value.expectedLocalHash)
		&& isSha256Hex(value.expectedRemoteHash)
		&& isBlobRef(value.expectedRemoteRef)
		&& value.expectedRemoteRef.hash === value.expectedRemoteHash
		&& isBlobSourceVersion(value.expectedRemoteSourceVersion)
		&& typeof value.artifactPath === "string"
		&& value.artifactPath.length > 0
		&& isOptionalNonNegativeSafeInteger(value.artifactMtime)
		&& value.artifactMtime !== undefined
		&& isOptionalNonNegativeSafeInteger(value.artifactSize)
		&& value.artifactSize !== undefined;
}

function isUpload(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, UPLOAD_KEYS)) return false;
	return typeof value.path === "string"
		&& value.path.length > 0
		&& isOptionalNonNegativeSafeInteger(value.sizeBytes)
		&& (value.baseRefKnown === undefined || typeof value.baseRefKnown === "boolean")
		&& (value.expectedBaseRef === undefined || isBlobRef(value.expectedBaseRef))
		&& hasValidUploadBaseSourceVersion(value)
		&& (value.causalBaseRef === undefined || isBlobRef(value.causalBaseRef))
		&& isOptionalNonNegativeSafeInteger(value.retries)
		&& (value.status === undefined || value.status === "pending" || value.status === "processing")
		&& isOptionalNonNegativeSafeInteger(value.readyAt)
		&& (value.attentionResolution === undefined || isAttentionResolution(value.attentionResolution))
		&& (value.deferredUntilSettlement === undefined || value.deferredUntilSettlement === true)
		&& (
			value.deferredUntilSettlement !== true
			|| (
				value.baseRefKnown === false
				&& value.expectedBaseRef === undefined
				&& value.expectedBaseSourceVersion === undefined
				&& value.causalBaseRef === undefined
				&& value.attentionResolution === undefined
			)
		)
		&& (value.needsRerun === undefined || typeof value.needsRerun === "boolean")
		&& isOptionalNonNegativeSafeInteger(value.rerunResets);
}

/**
 * A persisted ordinary upload based on a live CRDT ref must retain the exact
 * Y.Map item episode that established that ref. Hash/ref equality alone cannot
 * distinguish an H1 -> delete -> H1 ABA revival after restart.
 *
 * Explicit Keep-local remote-delete resolution is different: its authority is
 * the persisted tombstone episode/fingerprint, so it deliberately has no live
 * source version. Known absence likewise has no source item to identify.
 */
export function hasValidUploadBaseSourceVersion(value: {
	baseRefKnown?: boolean;
	expectedBaseRef?: BlobRef;
	expectedBaseSourceVersion?: string;
	attentionResolution?: { kind?: unknown };
}): boolean {
	const sourceVersion = value.expectedBaseSourceVersion;
	if (sourceVersion !== undefined && !isBlobSourceVersion(sourceVersion)) return false;

	const hasLiveBase = value.baseRefKnown === true && value.expectedBaseRef !== undefined;
	const isExplicitKeepLocal = value.attentionResolution?.kind
		=== "keep-local-remote-delete";
	if (hasLiveBase && !isExplicitKeepLocal) return sourceVersion !== undefined;

	// A source version without a known live ref is orphaned proof and must not be
	// carried into importQueue as authority for a different base shape.
	return sourceVersion === undefined;
}

function isDownload(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, DOWNLOAD_KEYS)) return false;
	if (
		typeof value.path !== "string"
		|| value.path.length === 0
		|| !isSha256Hex(value.hash)
		|| !isOptionalNonNegativeSafeInteger(value.sizeBytes)
		|| (value.targetRefFingerprint !== undefined
			&& (typeof value.targetRefFingerprint !== "string"
				|| value.targetRefFingerprint.length === 0))
		|| !isOptionalNonNegativeSafeInteger(value.retries)
		|| (value.status !== undefined && value.status !== "pending" && value.status !== "processing")
		|| !isOptionalNonNegativeSafeInteger(value.readyAt)
		|| (value.needsRerun !== undefined && typeof value.needsRerun !== "boolean")
		|| !isOptionalNonNegativeSafeInteger(value.rerunResets)
	) return false;
	if (value.acceptableLocalHashes === undefined) return true;
	if (
		!Array.isArray(value.acceptableLocalHashes)
		|| value.acceptableLocalHashes.length > MAX_BLOB_REF_PRIOR_HASHES
	) return false;
	const seen = new Set<string>();
	for (const hash of value.acceptableLocalHashes) {
		if (!isSha256Hex(hash) || seen.has(hash)) return false;
		seen.add(hash);
	}
	return true;
}

function readQueue(value: unknown): BlobQueueSnapshot | null {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["uploads", "downloads"]))) {
		return null;
	}
	if (
		!Array.isArray(value.uploads)
		|| !value.uploads.every(isUpload)
		|| !Array.isArray(value.downloads)
		|| !value.downloads.every(isDownload)
	) return null;
	const queue = value as unknown as BlobQueueSnapshot;
	return {
		uploads: queue.uploads.map((entry) => ({
			...entry,
			expectedBaseRef: cloneBlobRef(entry.expectedBaseRef),
			causalBaseRef: cloneBlobRef(entry.causalBaseRef),
			attentionResolution: entry.attentionResolution
				? { ...entry.attentionResolution }
				: undefined,
		})),
		downloads: queue.downloads.map((entry) => ({
			...entry,
			acceptableLocalHashes: entry.acceptableLocalHashes
				? [...entry.acceptableLocalHashes]
				: undefined,
		})),
	};
}

export function createPersistedBlobQueueSnapshot(
	queue: BlobQueueSnapshot,
	scope: PendingBlobIntentScope,
): PersistedBlobQueueSnapshot {
	if (!isScope(scope)) {
		throw new Error("Persisted blob queue requires host, vaultId, and localDeviceId scope");
	}
	const validatedQueue = readQueue(queue);
	if (!validatedQueue) throw new Error("Cannot persist an invalid blob queue snapshot");
	return {
		version: PERSISTED_BLOB_QUEUE_VERSION,
		scope: { ...scope },
		queue: validatedQueue,
	};
}

/**
 * Return a defensive queue snapshot only for its exact originating scope.
 * Legacy unscoped values, foreign-device copies, and malformed values all
 * return null so the caller can scrub them instead of executing them.
 */
export function readPersistedBlobQueueSnapshot(
	value: unknown,
	expectedScope: PendingBlobIntentScope,
): BlobQueueSnapshot | null {
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, PERSISTED_QUEUE_KEYS)
		|| Object.keys(value).length !== PERSISTED_QUEUE_KEYS.size
		|| value.version !== PERSISTED_BLOB_QUEUE_VERSION
		|| !isScope(value.scope)
		|| !isScope(expectedScope)
		|| !sameScope(value.scope, expectedScope)
	) return null;
	return readQueue(value.queue);
}
