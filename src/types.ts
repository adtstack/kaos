/**
 * Shared type definitions for the vault CRDT sync plugin.
 */

import { isExcluded } from "./sync/exclude";
import {
	isBlobConflictArtifactPath,
	isMarkdownConflictArtifactPath,
} from "./paths/conflictArtifactPath";

// -------------------------------------------------------------------
// Markdown CRDT types
// -------------------------------------------------------------------

/** Metadata stored per file ID in the CRDT meta map. */
export interface FileMeta {
	/** Vault-relative path (normalized). */
	path: string;
	/** v2 tombstone timestamp (ms since epoch). */
	deletedAt?: number;
	/** Legacy v1 soft-delete flag (kept for migration compatibility). */
	deleted?: boolean;
	/** Last-modified timestamp (ms since epoch). Informational only. */
	mtime?: number;
	/** Device that last modified this entry. */
	device?: string;
}

// -------------------------------------------------------------------
// Blob / attachment types
// -------------------------------------------------------------------

/**
 * Reference stored in pathToBlob map: vault-relative path -> blob info.
 * This is what gets synced via CRDT so other devices know which blob
 * belongs to which path.
 */
export interface BlobRef {
	/** SHA-256 hex hash of the file content. */
	hash: string;
	/** File size in bytes (denormalized for quick checks without HEAD). */
	size: number;
	/**
	 * Bounded, newest-first causal predecessors of this exact ref. A receiver
	 * may replace an existing attachment only when its disk hash appears here.
	 * Legacy refs omit this field and therefore remain fail-closed for
	 * destructive existing-file updates.
	 */
	priorHashes?: string[];
}

export const MAX_BLOB_REF_PRIOR_HASHES = 16;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/** Return a validated, deduplicated copy of a ref's bounded causal lineage. */
export function getBlobRefPriorHashes(ref: BlobRef | undefined): string[] {
	if (!Array.isArray(ref?.priorHashes)) return [];
	if (
		ref.priorHashes.length > MAX_BLOB_REF_PRIOR_HASHES
		|| ref.priorHashes.some((hash) => !isSha256Hex(hash))
	) return [];
	return Array.from(new Set(ref.priorHashes));
}

/**
 * Mint a ref whose overwrite authority follows the publisher's current view.
 * `inheritedPriorHashes` is used by snapshot restore to retain the snapshot
 * ref's older history after the current live ref has been prepended.
 */
export function createCausalBlobRef(
	hash: string,
	size: number,
	previous: BlobRef | undefined,
	inheritedPriorHashes: readonly string[] = [],
): BlobRef {
	const candidates = [
		...(previous ? [previous.hash, ...getBlobRefPriorHashes(previous)] : []),
		...inheritedPriorHashes,
	];
	const priorHashes: string[] = [];
	for (const candidate of candidates) {
		if (
			!isSha256Hex(candidate)
			|| candidate === hash
			|| priorHashes.includes(candidate)
		) continue;
		priorHashes.push(candidate);
		if (priorHashes.length === MAX_BLOB_REF_PRIOR_HASHES) break;
	}
	return priorHashes.length > 0 ? { hash, size, priorHashes } : { hash, size };
}

export function cloneBlobRef(ref: BlobRef | undefined): BlobRef | undefined {
	if (!ref) return undefined;
	const priorHashes = getBlobRefPriorHashes(ref);
	return priorHashes.length > 0
		? { hash: ref.hash, size: ref.size, priorHashes }
		: { hash: ref.hash, size: ref.size };
}

export function sameBlobRef(
	left: BlobRef | undefined,
	right: BlobRef | undefined,
): boolean {
	if (left === undefined) return right === undefined;
	if (right === undefined || left.hash !== right.hash || left.size !== right.size) {
		return false;
	}
	const leftPriorHashes = getBlobRefPriorHashes(left);
	const rightPriorHashes = getBlobRefPriorHashes(right);
	return leftPriorHashes.length === rightPriorHashes.length
		&& leftPriorHashes.every((hash, index) => hash === rightPriorHashes[index]);
}

export function blobRefFingerprint(ref: BlobRef | undefined): string {
	return ref
		? JSON.stringify([ref.hash, ref.size, getBlobRefPriorHashes(ref)])
		: "absent";
}

/**
 * Metadata for a content-addressed blob in R2.
 * Stored in blobMeta map: sha256 hex -> metadata.
 */
export interface BlobMeta {
	/** File size in bytes. */
	size: number;
	/** MIME type (e.g. "image/png"). */
	mime: string;
	/** Timestamp when first uploaded (ms since epoch). */
	createdAt: number;
	/** Device that first uploaded this blob. */
	device?: string;
}

/**
 * Tombstone for a deleted blob path. Prevents resurrection when a
 * device comes online with a stale disk state.
 * Stored in blobTombstones map: vault-relative path -> tombstone.
 */
export interface BlobTombstone {
	/** Timestamp when deleted (ms since epoch). */
	deletedAt: number;
	/** Device that performed the delete. */
	device?: string;
	/** Exact ref the deleting device observed; omitted by legacy clients. */
	deletedRef?: BlobRef;
}

// -------------------------------------------------------------------
// Origins
// -------------------------------------------------------------------

/** Origin string used for Yjs transactions initiated by this plugin. */
export const ORIGIN_LOCAL = "vault-crdt-local";
// Canonical declaration lives in src/sync/origins.ts — re-exported here for
// legacy importers. New code should import directly from origins.ts.
export { ORIGIN_SEED } from "./sync/origins";

// -------------------------------------------------------------------
// File classification
// -------------------------------------------------------------------

/**
 * Check if a vault-relative path is a markdown file eligible for CRDT sync.
 * Single choke point for all ".md" checks in the codebase.
 */
export function isMarkdownSyncable(path: string, excludePatterns: string[], configDir: string): boolean {
	if (!path.endsWith(".md")) return false;
	if (isMarkdownConflictArtifactPath(path)) return false;
	return !isExcluded(path, excludePatterns, configDir);
}

/**
 * Check if a vault-relative path is a non-markdown file eligible for
 * blob/attachment sync. Excludes the config directory, .trash/, user patterns,
 * and markdown files (handled by the CRDT text pipeline).
 */
export function isBlobSyncable(path: string, excludePatterns: string[], configDir: string): boolean {
	if (path.endsWith(".md")) return false;
	if (isBlobConflictArtifactPath(path)) return false;
	return !isExcluded(path, excludePatterns, configDir);
}
