import type {
	FileHistoryEntry,
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
