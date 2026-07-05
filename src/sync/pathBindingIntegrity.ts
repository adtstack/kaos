export type PathBindingIntegrityStatus =
	| "ok"
	| "duplicate-active-path"
	| "file-id-path-drift"
	| "ambiguous-structural-rename"
	| "missing-baseline-risk"
	| "unknown";

export type PathBindingRenameEvidence =
	| "none"
	| "explicit-rename"
	| "pending-rename";

export interface PathBindingIntegrityInput {
	readonly path: string;
	readonly fileId?: string | null;
	readonly activeFileIdsForPath?: readonly string[];
	readonly candidatePath?: string | null;
	readonly diskHash?: string | null;
	readonly crdtHash?: string | null;
	readonly baselineHash?: string | null;
	readonly renameEvidence?: PathBindingRenameEvidence;
}

export interface PathBindingIntegrityResult {
	readonly status: PathBindingIntegrityStatus;
	readonly path: string;
	readonly fileId: string | null;
	readonly candidatePath: string | null;
	readonly activeFileIdsForPath: readonly string[];
	readonly renameEvidence: PathBindingRenameEvidence;
	readonly shouldBlockCrdtFlush: boolean;
	readonly shouldPreserve: boolean;
	readonly reason: string;
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).filter((value) => value.length > 0))].sort();
}

function hasStructuralCandidate(input: PathBindingIntegrityInput): boolean {
	return !!input.candidatePath && input.candidatePath !== input.path;
}

function result(
	input: PathBindingIntegrityInput,
	status: PathBindingIntegrityStatus,
	reason: string,
	activeFileIdsForPath: readonly string[],
): PathBindingIntegrityResult {
	const shouldPreserve =
		status === "duplicate-active-path" ||
		status === "file-id-path-drift" ||
		status === "ambiguous-structural-rename" ||
		status === "missing-baseline-risk";
	return {
		status,
		path: input.path,
		fileId: input.fileId ?? null,
		candidatePath: input.candidatePath ?? null,
		activeFileIdsForPath,
		renameEvidence: input.renameEvidence ?? "none",
		shouldBlockCrdtFlush: shouldPreserve,
		shouldPreserve,
		reason,
	};
}

export function evaluatePathBindingIntegrity(input: PathBindingIntegrityInput): PathBindingIntegrityResult {
	const activeFileIdsForPath = uniqueSorted(input.activeFileIdsForPath);
	const fileId = input.fileId ?? null;
	const renameEvidence = input.renameEvidence ?? "none";

	if (!input.path) {
		return result(input, "unknown", "missing-path", activeFileIdsForPath);
	}

	if (activeFileIdsForPath.length > 1) {
		return result(input, "duplicate-active-path", "multiple-active-file-ids-for-path", activeFileIdsForPath);
	}

	if (fileId && activeFileIdsForPath.length === 1 && activeFileIdsForPath[0] !== fileId) {
		return result(input, "file-id-path-drift", "file-id-does-not-match-active-path-index", activeFileIdsForPath);
	}

	if (
		input.baselineHash === null &&
		hasStructuralCandidate(input) &&
		typeof input.diskHash === "string" &&
		typeof input.crdtHash === "string" &&
		input.diskHash !== input.crdtHash
	) {
		return result(input, "missing-baseline-risk", "candidate-path-and-divergent-content-without-baseline", activeFileIdsForPath);
	}

	if (hasStructuralCandidate(input) && renameEvidence === "none") {
		return result(input, "ambiguous-structural-rename", "candidate-path-without-rename-evidence", activeFileIdsForPath);
	}

	if (!fileId && activeFileIdsForPath.length === 0 && !input.diskHash && !input.crdtHash) {
		return result(input, "unknown", "insufficient-binding-input", activeFileIdsForPath);
	}

	return result(input, "ok", "path-binding-ok", activeFileIdsForPath);
}
