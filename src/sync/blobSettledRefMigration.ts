import { canonicalizeVaultPath } from "../paths/canonicalPath";
import { isSha256Hex } from "../types";
import type { BlobHashCache } from "./blobHashCache";

export const LEGACY_MISSING_BLOB_ATTENTION_REASON =
	"legacy-upgrade-missing-local-blob" as const;

export type LocalDeviceIdentityStatus = "unknown" | "existing" | "created";

export interface BlobSettlementOwnershipState<TRef, TSourceVersion, TStage> {
	cache: Record<string, TRef>;
	sourceVersions: Record<string, TSourceVersion>;
	stages: Record<string, TStage>;
	legacyMissingPaths: readonly string[];
}

/**
 * Remove durable attachment-lane state for paths that are now owned by a
 * document lane (for example, `.base` after the Bases migration).
 *
 * The caller supplies the current blob ownership predicate so this migration
 * also retires newly excluded local-safety artifact subtrees. Returning fresh
 * objects keeps a loaded IndexedDB snapshot immutable until the scrubbed state
 * has been durably persisted by the caller.
 */
export function scrubBlobSettlementDocumentOwnership<
	TRef,
	TSourceVersion,
	TStage,
>(input: BlobSettlementOwnershipState<TRef, TSourceVersion, TStage> & {
	isPathBlobSyncable(path: string): boolean;
}): BlobSettlementOwnershipState<TRef, TSourceVersion, TStage> & {
	changed: boolean;
} {
	const cache: Record<string, TRef> = {};
	const sourceVersions: Record<string, TSourceVersion> = {};
	const stages: Record<string, TStage> = {};
	let changed = false;

	const copyOwned = <T>(
		source: Record<string, T>,
		target: Record<string, T>,
	): void => {
		for (const [path, value] of Object.entries(source)) {
			if (!input.isPathBlobSyncable(path)) {
				changed = true;
				continue;
			}
			target[path] = value;
		}
	};

	copyOwned(input.cache, cache);
	copyOwned(input.sourceVersions, sourceVersions);
	copyOwned(input.stages, stages);

	const legacyMissingPaths = input.legacyMissingPaths.filter((path) => {
		const keep = input.isPathBlobSyncable(path);
		if (!keep) changed = true;
		return keep;
	});

	return {
		cache,
		sourceVersions,
		stages,
		legacyMissingPaths,
		changed,
	};
}

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
