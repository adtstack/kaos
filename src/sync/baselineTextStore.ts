import type { DiskIndex } from "./diskIndex";

export type BaselineTextStore = Record<string, string>;
export type ConflictMergeBaseStore = Record<string, string>;

function isSha256Hex(value: string): boolean {
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
