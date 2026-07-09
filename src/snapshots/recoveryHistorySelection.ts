import type {
	FileHistoryEntry,
	FileHistoryEntryKind,
	FileHistoryManifestIndex,
} from "../sync/recoverySnapshotClient";

export interface RecoveryHistoryFileHistoryItem {
	manifest: FileHistoryManifestIndex;
	entry: FileHistoryEntry;
}

export interface RecoveryHistorySnapshot {
	manifest: FileHistoryManifestIndex;
	changedItems: RecoveryHistoryFileHistoryItem[];
}

export interface RecoveryHistoryChangeItem extends RecoveryHistoryFileHistoryItem {
	key: string;
	displayPath: string;
	occurredAt: string;
	historyCount: number;
}

export type RecoveryHistoryScope =
	| { kind: "all" }
	| { kind: "manifest"; manifestId: string };

export type RecoveryHistoryKindFilter = FileHistoryEntryKind | "all";

export interface RecoveryHistoryFeedFilters {
	scope: RecoveryHistoryScope;
	query: string;
	kindFilter: RecoveryHistoryKindFilter;
}

export interface RecoveryHistoryInitialSelection {
	initialManifestId?: string;
	initialFileId?: string;
	autoExpandDiff?: boolean;
}

export interface RecoveryHistoryResolvedSelection {
	selectedManifestId: string | null;
	selectedFileId: string | null;
	expandedDiffKey: string | null;
}

export interface RecoveryHistoryResolvedFeedState {
	scope: RecoveryHistoryScope;
	selectedChangeKey: string | null;
}

export function buildRecoverySnapshotHistories(
	manifests: FileHistoryManifestIndex[],
): RecoveryHistorySnapshot[] {
	return manifests
		.slice()
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((manifest) => ({
			manifest,
			changedItems: manifest.changedEntries.map((entry) => ({ manifest, entry })),
		}));
}

export function fileHistoryDiffKey(item: RecoveryHistoryFileHistoryItem): string {
	return `${item.manifest.manifestId}:${item.entry.fileId}`;
}

export function recoveryHistoryChangeKey(
	manifest: FileHistoryManifestIndex,
	entry: FileHistoryEntry,
	entryIndex: number,
): string {
	return `${manifest.manifestId}:${entry.fileId}:${entryIndex}`;
}

export function buildRecoveryHistoryChanges(
	manifests: FileHistoryManifestIndex[],
): RecoveryHistoryChangeItem[] {
	const historyCounts = new Map<string, number>();
	for (const manifest of manifests) {
		for (const entry of manifest.changedEntries) {
			historyCounts.set(entry.fileId, (historyCounts.get(entry.fileId) ?? 0) + 1);
		}
	}

	const changes: RecoveryHistoryChangeItem[] = [];
	const sorted = manifests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	for (const manifest of sorted) {
		for (let entryIndex = 0; entryIndex < manifest.changedEntries.length; entryIndex++) {
			const entry = manifest.changedEntries[entryIndex];
			if (!entry) continue;
			changes.push({
				key: recoveryHistoryChangeKey(manifest, entry, entryIndex),
				manifest,
				entry,
				displayPath: entry.newPath ?? entry.path,
				occurredAt: manifest.createdAt,
				historyCount: historyCounts.get(entry.fileId) ?? 1,
			});
		}
	}
	return changes;
}

export function filterRecoveryHistoryChanges(
	changes: RecoveryHistoryChangeItem[],
	filters: RecoveryHistoryFeedFilters,
): RecoveryHistoryChangeItem[] {
	const query = filters.query.trim().toLowerCase();
	return changes.filter((item) => {
		if (filters.scope.kind === "manifest" && item.manifest.manifestId !== filters.scope.manifestId) {
			return false;
		}
		if (filters.kindFilter !== "all" && item.entry.kind !== filters.kindFilter) {
			return false;
		}
		if (query.length === 0) return true;
		return searchableRecoveryHistoryText(item).includes(query);
	});
}

export function resolveVisibleRecoveryHistorySelection(
	changes: RecoveryHistoryChangeItem[],
	filters: RecoveryHistoryFeedFilters,
	selectedChangeKey: string | null,
): string | null {
	const visible = filterRecoveryHistoryChanges(changes, filters);
	if (selectedChangeKey && visible.some((item) => item.key === selectedChangeKey)) {
		return selectedChangeKey;
	}
	return visible[0]?.key ?? null;
}

export function resolveRecoveryHistoryFeedState(
	manifests: FileHistoryManifestIndex[],
	options?: RecoveryHistoryInitialSelection,
): RecoveryHistoryResolvedFeedState {
	const changes = buildRecoveryHistoryChanges(manifests);
	const allScope: RecoveryHistoryScope = { kind: "all" };
	if (!options?.initialManifestId || !options.initialFileId) {
		return {
			scope: allScope,
			selectedChangeKey: changes[0]?.key ?? null,
		};
	}

	const selected = changes.find((item) =>
		item.manifest.manifestId === options.initialManifestId &&
		item.entry.fileId === options.initialFileId);
	if (selected) {
		return {
			scope: allScope,
			selectedChangeKey: selected.key,
		};
	}

	const firstInManifest = changes.find((item) =>
		item.manifest.manifestId === options.initialManifestId);
	if (firstInManifest) {
		return {
			scope: { kind: "manifest", manifestId: firstInManifest.manifest.manifestId },
			selectedChangeKey: firstInManifest.key,
		};
	}

	return {
		scope: allScope,
		selectedChangeKey: changes[0]?.key ?? null,
	};
}

export function resolveRecoveryHistoryInitialSelection(
	manifests: FileHistoryManifestIndex[],
	options?: RecoveryHistoryInitialSelection,
): RecoveryHistoryResolvedSelection {
	const snapshots = buildRecoverySnapshotHistories(manifests);
	const defaultManifestId = snapshots[0]?.manifest.manifestId ?? null;
	if (!options?.initialManifestId || !options.initialFileId) {
		return {
			selectedManifestId: defaultManifestId,
			selectedFileId: null,
			expandedDiffKey: null,
		};
	}

	const snapshot = snapshots.find((candidate) =>
		candidate.manifest.manifestId === options.initialManifestId);
	if (!snapshot) {
		return {
			selectedManifestId: defaultManifestId,
			selectedFileId: null,
			expandedDiffKey: null,
		};
	}

	const item = snapshot.changedItems.find((candidate) =>
		candidate.entry.fileId === options.initialFileId);
	if (!item) {
		return {
			selectedManifestId: snapshot.manifest.manifestId,
			selectedFileId: null,
			expandedDiffKey: null,
		};
	}

	return {
		selectedManifestId: snapshot.manifest.manifestId,
		selectedFileId: item.entry.fileId,
		expandedDiffKey: options.autoExpandDiff === true &&
			(item.entry.previousContentHash || item.entry.contentHash)
			? fileHistoryDiffKey(item)
			: null,
	};
}

function searchableRecoveryHistoryText(item: RecoveryHistoryChangeItem): string {
	return [
		item.displayPath,
		item.entry.path,
		item.entry.oldPath ?? "",
		item.entry.newPath ?? "",
		item.entry.device ?? "",
		item.entry.kind,
	].join("\n").toLowerCase();
}
