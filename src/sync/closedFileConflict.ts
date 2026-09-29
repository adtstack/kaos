export type ClosedFileConflictDecision =
	| { kind: "no-op" }
	| { kind: "apply-remote-to-disk"; reason: "disk-at-baseline" | "self-mirror-lag" }
	| { kind: "import-disk-to-crdt"; reason: "crdt-at-baseline" }
	| {
		kind: "preserve-conflict";
		reason: "both-changed" | "missing-baseline";
		winner: "disk" | "crdt";
		preserveCrdt?: true;
		preserveDisk?: true;
	};

export interface ClosedFileConflictInput {
	baselineHash: string | null;
	diskHash: string;
	crdtHash: string;
	/**
	 * Strict proof that the disk bytes are KAOS's own mirror output: the
	 * caller compared the current disk hash against the content hash of the
	 * last successful DiskMirror flushWrite for this path. Such a disk copy
	 * is a (possibly lagging) projection of the CRDT, never an independent
	 * editor, so it must not win a both-changed tie-break or a
	 * missing-baseline mtime tie-break — importing it could only delete
	 * fresher remote CRDT content (the multi-device live-typing rollback).
	 * Optional — when absent/false, behavior is unchanged.
	 */
	diskChangeIsSelfMirror?: boolean;
	/**
	 * mtime (Unix ms) of the disk file at reconciliation time.
	 * Used together with lastDiskIndexPersistedAt to detect "edited while
	 * KAOS was inactive" in the missing-baseline path.
	 * Optional — when absent, mtime evidence is not used.
	 */
	diskMtime?: number;
	/**
	 * Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Persisted in data.json as _lastDiskIndexPersistedAt.
	 * Semantics: "last time KAOS durably persisted disk-index baselines."
	 * This is a GLOBAL heuristic — not per-file. It can produce false negatives
	 * when an unrelated file triggers a save after the target file was modified
	 * because the target file can then appear older than the persisted index.
	 * Optional — when absent, mtime evidence is not used unless
	 * lastFileSettledAtMs is present.
	 */
	lastDiskIndexPersistedAt?: number;
	/**
	 * Unix ms timestamp of the last durable settlement of THIS file's content
	 * hash (DiskIndexEntry.settledAtMs). Strictly better evidence than the
	 * global timestamp for the missing-baseline tie-break: an unrelated
	 * file's index save can no longer mask this file's offline edit. When
	 * present (with diskMtime), it replaces the global comparison. Entries
	 * written before the field existed have no value and fall back to the
	 * global timestamp.
	 */
	lastFileSettledAtMs?: number;
}

/**
 * Why the disk was chosen as the missing-baseline winner.
 * Present in reconcile.file.decision.data when reason === "missing-baseline"
 * and diskMtime evidence was available.
 */
export type MissingBaselineWinnerPolicy =
	| "disk-mtime-after-last-file-settlement" // diskMtime > lastFileSettledAtMs (per-file)
	| "disk-mtime-after-last-index-save"  // diskMtime > lastDiskIndexPersistedAt (global fallback)
	| "crdt-default-no-evidence"          // no mtime evidence, safe distributed default
	| "crdt-default-disk-not-newer";      // evidence present but disk not newer than last save

export function decideClosedFileConflict(
	input: ClosedFileConflictInput,
): ClosedFileConflictDecision & { _missingBaselinePolicy?: MissingBaselineWinnerPolicy } {
	const { baselineHash, diskHash, crdtHash, diskChangeIsSelfMirror, diskMtime, lastDiskIndexPersistedAt, lastFileSettledAtMs } = input;
	if (diskHash === crdtHash) return { kind: "no-op" };

	if (diskChangeIsSelfMirror === true) {
		// The disk copy is provably our own mirror output (hash-equal to the
		// last successful flushWrite). It carries no independent edit intent,
		// so regardless of baseline state the CRDT side wins and the mirror
		// catches up via the normal apply-remote-to-disk flush. This must run
		// before the missing-baseline mtime path too: a self-written mtime is
		// an echo of our own write, not evidence of an offline external edit.
		return { kind: "apply-remote-to-disk", reason: "self-mirror-lag" };
	}

	if (baselineHash === null) {
		// No persisted baseline — unknown who changed what.
		//
		// Use mtime evidence to break the tie. Heuristic:
		//   If the disk file's mtime is strictly AFTER the last time KAOS
		//   durably settled THIS file (per-file settledAtMs), or — for entries
		//   predating that field — after the last global disk-index save, the
		//   file was likely edited while KAOS was inactive/killed/suspended.
		//   Disk wins the main file; CRDT remote content is preserved as a
		//   conflict artifact.
		//
		//   This addresses Issue #22-B ("I turned KAOS off, edited my note,
		//   turned it back on, and lost my edits" — the cold-relaunch / process-
		//   killed variant where no baseline was persisted before death).
		//
		// Known limits of this heuristic (documented, not hidden):
		//   - Per-file evidence (settledAtMs) is exact for this file; the
		//     GLOBAL fallback timestamp can still be masked by an unrelated
		//     file triggering a save AFTER the target file's mtime, making
		//     disk look "not newer" so CRDT wins despite a local edit. New
		//     settlements always stamp the per-file field, so the fallback
		//     shrinks to legacy entries over time.
		//   - mtime coarseness: filesystems with 1-second precision, external
		//     editors that preserve mtime, or iCloud/Android document providers
		//     may produce unexpected mtime values.
		//   - When no evidence input is present, falls back to CRDT wins
		//     (safe default).
		//
		const hasPerFileEvidence =
			diskMtime !== undefined &&
			lastFileSettledAtMs !== undefined;
		if (hasPerFileEvidence) {
			return diskMtime > lastFileSettledAtMs
				? {
					kind: "preserve-conflict",
					reason: "missing-baseline",
					winner: "disk",
					preserveCrdt: true,
					_missingBaselinePolicy: "disk-mtime-after-last-file-settlement",
				}
				: {
					kind: "preserve-conflict",
					reason: "missing-baseline",
					winner: "crdt",
					preserveDisk: true,
					_missingBaselinePolicy: "crdt-default-disk-not-newer",
				};
		}
		const hasMtimeEvidence =
			diskMtime !== undefined &&
			lastDiskIndexPersistedAt !== undefined;
		const diskNewerThanLastSave =
			hasMtimeEvidence && diskMtime > lastDiskIndexPersistedAt;

		if (diskNewerThanLastSave) {
			return {
				kind: "preserve-conflict",
				reason: "missing-baseline",
				winner: "disk",
				preserveCrdt: true,
				_missingBaselinePolicy: "disk-mtime-after-last-index-save",
			};
		}
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			winner: "crdt",
			preserveDisk: true,
			_missingBaselinePolicy: hasMtimeEvidence
				? "crdt-default-disk-not-newer"
				: "crdt-default-no-evidence",
		};
	}

	if (diskHash === baselineHash && crdtHash !== baselineHash) {
		return { kind: "apply-remote-to-disk", reason: "disk-at-baseline" };
	}
	if (crdtHash === baselineHash && diskHash !== baselineHash) {
		return { kind: "import-disk-to-crdt", reason: "crdt-at-baseline" };
	}
	return {
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	};
}
