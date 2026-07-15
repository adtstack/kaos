import { canonicalizeVaultPath } from "../paths/canonicalPath";
import { isSha256Hex } from "../types";
import type { BlobHashCache } from "./blobHashCache";

export const LEGACY_MISSING_BLOB_ATTENTION_REASON =
	"legacy-upgrade-missing-local-blob" as const;

export type LocalDeviceIdentityStatus = "unknown" | "existing" | "created";

/**
 * Find only legacy-known paths that disappeared on this same installation.
 *
 * The legacy hash is deliberately never returned: it is unscoped data.json
 * evidence and therefore cannot authorize a delete, rename, overwrite, or CAS.
 * A newly-created device identity ignores the cache entirely so a copied
 * data.json cannot suppress that device's first remote bootstrap.
 */
export function collectLegacyMissingBlobPaths(input: {
	identityStatus: LocalDeviceIdentityStatus;
	hashCache: BlobHashCache;
	isPathPresent(path: string): boolean;
	isPathSyncable(path: string): boolean;
}): string[] {
	if (input.identityStatus !== "existing") return [];

	const paths = new Set<string>();
	for (const [rawPath, entry] of Object.entries(input.hashCache)) {
		if (
			!entry
			|| typeof entry !== "object"
			|| !Number.isFinite(entry.mtime)
			|| !Number.isSafeInteger(entry.size)
			|| entry.size < 0
			|| !isSha256Hex(entry.hash)
		) continue;
		if (rawPath.includes("\0")) continue;
		const path = canonicalizeVaultPath(rawPath).normalizedPath;
		if (!path || path.endsWith("/")) continue;
		if (!input.isPathSyncable(path) || input.isPathPresent(path)) continue;
		paths.add(path);
	}
	return Array.from(paths).sort();
}
