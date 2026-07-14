import type { DiskIndex } from "./diskIndex";

export type BaselineTextStore = Record<string, string>;
export type ConflictMergeBaseStore = Record<string, string>;

export const BASELINE_TEXT_STORE_VERSION = 1;

export interface BaselineTextRepository {
	load(hashes: Iterable<string>): Promise<BaselineTextStore>;
	save(entries: BaselineTextStore): Promise<void>;
	remove(hashes: Iterable<string>): Promise<void>;
	retain(hashes: Iterable<string>): Promise<void>;
}

export interface PersistedBaselineTextFields {
	_baselineTexts?: BaselineTextStore;
	_conflictMergeBases?: ConflictMergeBaseStore;
	_baselineTextStoreVersion?: number;
}

export function isSha256Hex(value: string): boolean {
	return /^[a-f0-9]{64}$/i.test(value);
}

export function readBaselineTextStore(value: unknown): BaselineTextStore {
	if (typeof value !== "object" || value === null) return {};
	const output: BaselineTextStore = {};
	for (const [hash, text] of Object.entries(value as Record<string, unknown>)) {
		if (isSha256Hex(hash) && typeof text === "string") {
			output[hash] = text;
		}
	}
	return output;
}

export function readConflictMergeBaseStore(value: unknown): ConflictMergeBaseStore {
	if (typeof value !== "object" || value === null) return {};
	const output: ConflictMergeBaseStore = {};
	for (const [artifactPath, hash] of Object.entries(value as Record<string, unknown>)) {
		if (artifactPath && typeof hash === "string" && isSha256Hex(hash)) {
			output[artifactPath] = hash;
		}
	}
	return output;
}

export function pruneBaselineTextStore(
	store: BaselineTextStore,
	index: DiskIndex,
	conflictMergeBases: ConflictMergeBaseStore,
): BaselineTextStore {
	const keep = new Set<string>();
	for (const entry of Object.values(index)) {
		if (entry.contentHash) keep.add(entry.contentHash);
	}
	for (const hash of Object.values(conflictMergeBases)) {
		keep.add(hash);
	}

	const output: BaselineTextStore = {};
	for (const hash of keep) {
		const text = store[hash];
		if (text !== undefined) output[hash] = text;
	}
	return output;
}

export function collectReferencedBaselineHashes(
	index: DiskIndex,
	conflictMergeBases: ConflictMergeBaseStore,
): Set<string> {
	const keep = new Set<string>();
	for (const entry of Object.values(index)) {
		if (entry.contentHash) keep.add(entry.contentHash);
	}
	for (const hash of Object.values(conflictMergeBases)) {
		keep.add(hash);
	}
	return keep;
}

/**
 * Reconcile the baseline-related portion of data.json.
 *
 * The explicit deletes are important: callers start from the previously
 * persisted object, so an omitted conditional spread would otherwise leave
 * the final non-empty baseline payload behind forever.
 */
export function applyPersistedBaselineTextFields(
	state: PersistedBaselineTextFields,
	baselineTexts: BaselineTextStore,
	conflictMergeBases: ConflictMergeBaseStore,
	externalized: boolean,
): void {
	delete state._baselineTexts;
	delete state._conflictMergeBases;
	delete state._baselineTextStoreVersion;

	if (!externalized && Object.keys(baselineTexts).length > 0) {
		state._baselineTexts = baselineTexts;
	}
	if (Object.keys(conflictMergeBases).length > 0) {
		state._conflictMergeBases = conflictMergeBases;
	}
	if (externalized) {
		state._baselineTextStoreVersion = BASELINE_TEXT_STORE_VERSION;
	}
}
