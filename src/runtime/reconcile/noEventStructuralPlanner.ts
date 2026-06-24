export interface StructuralPathHash {
	path: string;
	contentHash: string;
}

export interface PlannedStructuralRename {
	oldPath: string;
	newPath: string;
	contentHash: string;
	reason: "unique-content-hash" | "unique-basename-with-duplicate-content";
}

export interface UnresolvedStructuralChange {
	oldPaths: string[];
	newPaths: string[];
	contentHash: string;
	reason: "ambiguous-duplicate-content" | "count-mismatch" | "content-diverged-same-basename";
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

function uniqueBasenameMatches(oldPaths: string[], newPaths: string[]): PlannedStructuralRename[] {
	const oldByBase = new Map<string, string[]>();
	const newByBase = new Map<string, string[]>();
	for (const path of oldPaths) {
		const key = basename(path);
		const bucket = oldByBase.get(key) ?? [];
		bucket.push(path);
		oldByBase.set(key, bucket);
	}
	for (const path of newPaths) {
		const key = basename(path);
		const bucket = newByBase.get(key) ?? [];
		bucket.push(path);
		newByBase.set(key, bucket);
	}

	const matches: PlannedStructuralRename[] = [];
	for (const [key, oldBucket] of oldByBase) {
		const newBucket = newByBase.get(key);
		if (oldBucket.length === 1 && newBucket?.length === 1) {
			const oldPath = oldBucket[0]!;
			const newPath = newBucket[0]!;
			matches.push({
				oldPath,
				newPath,
				contentHash: "",
				reason: "unique-basename-with-duplicate-content",
			});
		}
	}
	matches.sort((a, b) => a.oldPath.localeCompare(b.oldPath) || a.newPath.localeCompare(b.newPath));
	return matches;
}

export function planNoEventStructuralRenames(input: {
	missingCrdtPaths: StructuralPathHash[];
	extraDiskPaths: StructuralPathHash[];
}): NoEventStructuralPlan {
	const oldByHash = groupByHash(input.missingCrdtPaths);
	const newByHash = groupByHash(input.extraDiskPaths);
	const hashes = new Set<string>([...oldByHash.keys(), ...newByHash.keys()]);
	const renames: PlannedStructuralRename[] = [];
	const unresolved: UnresolvedStructuralChange[] = [];
	const consumedOld = new Set<string>();
	const consumedNew = new Set<string>();

	for (const hash of [...hashes].sort()) {
		const oldPaths = oldByHash.get(hash) ?? [];
		const newPaths = newByHash.get(hash) ?? [];
		if (oldPaths.length === 0 || newPaths.length === 0) continue;

		if (oldPaths.length === 1 && newPaths.length === 1) {
			const oldPath = oldPaths[0]!;
			const newPath = newPaths[0]!;
			renames.push({
				oldPath,
				newPath,
				contentHash: hash,
				reason: "unique-content-hash",
			});
			consumedOld.add(oldPath);
			consumedNew.add(newPath);
			continue;
		}

		const basenameMatches = uniqueBasenameMatches(oldPaths, newPaths).map((match) => ({
			...match,
			contentHash: hash,
		}));
		renames.push(...basenameMatches);

		const matchedOld = new Set(basenameMatches.map((match) => match.oldPath));
		const matchedNew = new Set(basenameMatches.map((match) => match.newPath));
		for (const path of matchedOld) consumedOld.add(path);
		for (const path of matchedNew) consumedNew.add(path);
		const remainingOld = oldPaths.filter((path) => !matchedOld.has(path));
		const remainingNew = newPaths.filter((path) => !matchedNew.has(path));

		if (remainingOld.length > 0 || remainingNew.length > 0) {
			for (const path of remainingOld) consumedOld.add(path);
			for (const path of remainingNew) consumedNew.add(path);
			unresolved.push({
				oldPaths: remainingOld,
				newPaths: remainingNew,
				contentHash: hash,
				reason: remainingOld.length === remainingNew.length
					? "ambiguous-duplicate-content"
					: "count-mismatch",
			});
		}
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
