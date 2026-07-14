import {
	evaluatePathBindingIntegrity,
	type PathBindingRenameEvidence,
} from "../../sync/pathBindingIntegrity";
import type { DiskIndex } from "../../sync/diskIndex";
import type { ReconcileMode } from "../../sync/vaultSync";

export interface StructuralPathHash {
	path: string;
	contentHash: string;
}

export interface StructuralRenameEvidence {
	oldPath: string;
	newPath: string;
	reason: Extract<PathBindingRenameEvidence, "explicit-rename" | "pending-rename">;
}

export interface PlannedStructuralRename {
	oldPath: string;
	newPath: string;
	contentHash: string;
	reason: StructuralRenameEvidence["reason"] | "baseline-hash-continuity";
}

export interface UnresolvedStructuralChange {
	oldPaths: string[];
	newPaths: string[];
	contentHash: string;
	reason:
		| "ambiguous-structural-rename"
		| "ambiguous-duplicate-content"
		| "count-mismatch"
		| "content-diverged-same-basename";
}

export interface NoEventStructuralPlan {
	renames: PlannedStructuralRename[];
	unresolved: UnresolvedStructuralChange[];
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash >= 0 ? path.slice(slash + 1) : path;
}

function groupByHash(paths: StructuralPathHash[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const entry of paths) {
		const bucket = groups.get(entry.contentHash) ?? [];
		bucket.push(entry.path);
		groups.set(entry.contentHash, bucket);
	}
	for (const bucket of groups.values()) {
		bucket.sort();
	}
	return groups;
}

export function planNoEventStructuralRenames(input: {
	missingCrdtPaths: StructuralPathHash[];
	extraDiskPaths: StructuralPathHash[];
	renameEvidence?: StructuralRenameEvidence[];
	mode: ReconcileMode;
	previousDiskIndex?: Readonly<DiskIndex>;
}): NoEventStructuralPlan {
	const oldByHash = groupByHash(input.missingCrdtPaths);
	const newByHash = groupByHash(input.extraDiskPaths);
	const oldByPath = new Map(input.missingCrdtPaths.map((entry) => [entry.path, entry]));
	const newByPath = new Map(input.extraDiskPaths.map((entry) => [entry.path, entry]));
	const hashes = new Set<string>([...oldByHash.keys(), ...newByHash.keys()]);
	const renames: PlannedStructuralRename[] = [];
	const unresolved: UnresolvedStructuralChange[] = [];
	const consumedOld = new Set<string>();
	const consumedNew = new Set<string>();

	for (const evidence of [...(input.renameEvidence ?? [])].sort((a, b) =>
		a.oldPath.localeCompare(b.oldPath) || a.newPath.localeCompare(b.newPath)
	)) {
		const oldEntry = oldByPath.get(evidence.oldPath);
		const newEntry = newByPath.get(evidence.newPath);
		if (!oldEntry || !newEntry) continue;
		if (consumedOld.has(evidence.oldPath) || consumedNew.has(evidence.newPath)) continue;
		renames.push({
			oldPath: evidence.oldPath,
			newPath: evidence.newPath,
			contentHash: oldEntry.contentHash === newEntry.contentHash
				? oldEntry.contentHash
				: `${oldEntry.contentHash}:${newEntry.contentHash}`,
			reason: evidence.reason,
		});
		consumedOld.add(evidence.oldPath);
		consumedNew.add(evidence.newPath);
	}

	for (const hash of [...hashes].sort()) {
		const originalOldPaths = oldByHash.get(hash) ?? [];
		const originalNewPaths = newByHash.get(hash) ?? [];
		const oldPaths = originalOldPaths.filter((path) => !consumedOld.has(path));
		const newPaths = originalNewPaths.filter((path) => !consumedNew.has(path));
		if (oldPaths.length === 0 || newPaths.length === 0) continue;

		if (oldPaths.length === 1 && newPaths.length === 1) {
			const oldPath = oldPaths[0]!;
			const newPath = newPaths[0]!;
			if (basename(oldPath) !== basename(newPath)) {
				continue;
			}
			const previousDiskIndex = input.previousDiskIndex ?? {};
			const oldBaseline = Object.prototype.hasOwnProperty.call(previousDiskIndex, oldPath)
				? previousDiskIndex[oldPath]?.contentHash
				: undefined;
			const newPathWasPreviouslyIndexed = Object.prototype.hasOwnProperty.call(
				previousDiskIndex,
				newPath,
			);
			// Hash equality proves content continuity, not file identity. Infer a
			// rename only when the authoritative snapshot, prior local baseline,
			// path history, candidate cardinality, and basename all agree.
			if (
				input.mode === "authoritative"
				&& originalOldPaths.length === 1
				&& originalNewPaths.length === 1
				&& oldBaseline === hash
				&& !newPathWasPreviouslyIndexed
			) {
				renames.push({
					oldPath,
					newPath,
					contentHash: hash,
					reason: "baseline-hash-continuity",
				});
				consumedOld.add(oldPath);
				consumedNew.add(newPath);
				continue;
			}
			const binding = evaluatePathBindingIntegrity({
				path: oldPath,
				candidatePath: newPath,
				diskHash: hash,
				crdtHash: hash,
				baselineHash: null,
				renameEvidence: "none",
			});
			unresolved.push({
				oldPaths,
				newPaths,
				contentHash: hash,
				reason: binding.status === "ambiguous-structural-rename"
					? "ambiguous-structural-rename"
					: "ambiguous-duplicate-content",
			});
			consumedOld.add(oldPath);
			consumedNew.add(newPath);
			continue;
		}

		for (const path of oldPaths) consumedOld.add(path);
		for (const path of newPaths) consumedNew.add(path);
		unresolved.push({
			oldPaths,
			newPaths,
			contentHash: hash,
			reason: oldPaths.length === newPaths.length
				? "ambiguous-duplicate-content"
				: "count-mismatch",
		});
	}

	const remainingOldByBase = new Map<string, StructuralPathHash[]>();
	const remainingNewByBase = new Map<string, StructuralPathHash[]>();
	for (const entry of input.missingCrdtPaths) {
		if (consumedOld.has(entry.path)) continue;
		const key = basename(entry.path);
		const bucket = remainingOldByBase.get(key) ?? [];
		bucket.push(entry);
		remainingOldByBase.set(key, bucket);
	}
	for (const entry of input.extraDiskPaths) {
		if (consumedNew.has(entry.path)) continue;
		const key = basename(entry.path);
		const bucket = remainingNewByBase.get(key) ?? [];
		bucket.push(entry);
		remainingNewByBase.set(key, bucket);
	}
	for (const [key, oldBucket] of remainingOldByBase) {
		const newBucket = remainingNewByBase.get(key);
		if (oldBucket.length === 1 && newBucket?.length === 1) {
			const oldEntry = oldBucket[0]!;
			const newEntry = newBucket[0]!;
			unresolved.push({
				oldPaths: [oldEntry.path],
				newPaths: [newEntry.path],
				contentHash: `${oldEntry.contentHash}:${newEntry.contentHash}`,
				reason: "content-diverged-same-basename",
			});
			consumedOld.add(oldEntry.path);
			consumedNew.add(newEntry.path);
		}
	}

	renames.sort((a, b) => a.oldPath.localeCompare(b.oldPath) || a.newPath.localeCompare(b.newPath));
	unresolved.sort((a, b) => a.contentHash.localeCompare(b.contentHash));
	return { renames, unresolved };
}
