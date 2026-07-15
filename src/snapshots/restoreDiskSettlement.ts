import { normalizePath, type TFile } from "obsidian";
import type {
	DiskFileRevision,
	DiskWriteOptions,
	DiskWriteResult,
} from "../sync/diskMirror";
import type { PreservedUnresolvedReason } from "../sync/preservedUnresolved";

export type RestoreDiskRevision = DiskFileRevision;

export type RestoreDiskPrecondition =
	| {
		kind: "present";
		content: string;
		fileIdentity: TFile;
		revision: RestoreDiskRevision;
	}
	| { kind: "missing" };

export const RESTORE_DISK_SETTLEMENT_FAILURE_REASON =
	"restore-disk-settlement-failed" as const satisfies PreservedUnresolvedReason;

export type RestoreDiskSettlement =
	| {
		kind: "settled";
		result: Extract<DiskWriteResult, { kind: "written" | "unchanged" }>;
	}
	| {
		kind: "not-settled";
		reason:
			| "disk-mirror-unavailable"
			| "flush-not-settled"
			| "settled-content-mismatch"
			| "baseline-not-recorded"
			| "flush-threw";
		result: DiskWriteResult | null;
		error?: string;
	};

export interface RestoreDiskWriter {
	flushWrite(
		path: string,
		force?: boolean,
		options?: DiskWriteOptions,
	): Promise<DiskWriteResult>;
	/** Durable fail-closed marker used when an explicit restore cannot settle. */
	recordPreservedUnresolved?(
		path: string,
		reason: PreservedUnresolvedReason,
	): void;
	isPreservedUnresolved?(path: string): boolean;
}

export interface RestoreDiskAuthorityReader {
	getAbstractFileByPath(path: string): unknown;
	read(file: TFile): Promise<string>;
}

export interface RestoreReviewMarkdownAuthority {
	fileId: string | null;
	content: string | null;
}

export interface RestoreReviewEditorAuthority {
	file: TFile;
	content: string;
}

export type RestoreDiskAuthorityCommit<T> =
	| { kind: "committed"; value: T }
	| { kind: "stale"; paths: string[] };

export function captureRestoreDiskRevision(file: TFile): RestoreDiskRevision {
	return {
		ctime: file.stat.ctime,
		mtime: file.stat.mtime,
		size: file.stat.size,
	};
}

function isRestoreDiskRevisionCurrent(
	file: TFile,
	expected: RestoreDiskRevision,
): boolean {
	return file.stat.ctime === expected.ctime
		&& file.stat.mtime === expected.mtime
		&& file.stat.size === expected.size;
}

/**
 * Return selectable Markdown paths whose diff-time CRDT value was not also
 * the exact visible disk/editor value. A restore UI built only from the Y.Doc
 * must not authorize replacing newer disk-only or editor-only work that the
 * user was never shown.
 */
export function findIncoherentMarkdownRestoreReviewPaths(
	paths: readonly string[],
	markdownAuthority: ReadonlyMap<string, RestoreReviewMarkdownAuthority>,
	diskAuthority: ReadonlyMap<string, RestoreDiskPrecondition>,
	editorAuthority: ReadonlyMap<string, readonly RestoreReviewEditorAuthority[]>,
): string[] {
	const incoherent: string[] = [];
	const seen = new Set<string>();
	for (const requestedPath of paths) {
		const path = normalizePath(requestedPath);
		if (seen.has(path)) continue;
		seen.add(path);
		const markdown = markdownAuthority.get(path);
		const disk = diskAuthority.get(path);
		const editors = editorAuthority.get(path);
		if (!markdown || !disk || !editors) {
			incoherent.push(path);
			continue;
		}

		if (markdown.fileId === null) {
			if (
				markdown.content !== null
				|| disk.kind !== "missing"
				|| editors.length !== 0
			) {
				incoherent.push(path);
			}
			continue;
		}

		if (
			markdown.content === null
			|| disk.kind !== "present"
			|| disk.content !== markdown.content
			|| editors.some((entry) => (
				entry.content !== markdown.content
				|| entry.file !== disk.fileIdentity
			))
		) {
			incoherent.push(path);
		}
	}
	return incoherent;
}

function isRestoreDiskIdentityCurrent(
	vault: RestoreDiskAuthorityReader,
	path: string,
	precondition: RestoreDiskPrecondition,
): boolean {
	try {
		const current = vault.getAbstractFileByPath(path);
		if (precondition.kind === "missing") return current === null;
		return current === precondition.fileIdentity
			&& precondition.fileIdentity.path === path
			&& isRestoreDiskRevisionCurrent(
				precondition.fileIdentity,
				precondition.revision,
			);
	} catch {
		return false;
	}
}

/**
 * Validate every reviewed disk byte snapshot before invoking a synchronous
 * CRDT restore. There is no await between the final all-path identity/revision
 * check and `commit`, so plugin/event-loop writes cannot enter that boundary.
 *
 * The supplied identity fence is intended for the restore's own final
 * `canCommit` callback. It closes an exact TFile/missing-path replacement gap
 * after CRDT/editor validation and immediately before the Y.Doc transaction.
 */
export async function commitWithCurrentRestoreDiskAuthority<T>(
	vault: RestoreDiskAuthorityReader,
	preconditions: ReadonlyMap<string, RestoreDiskPrecondition>,
	commit: (isDiskIdentityCurrent: () => boolean) => T,
): Promise<RestoreDiskAuthorityCommit<T>> {
	const entries = [...preconditions.entries()];
	const byteChecks = await Promise.all(entries.map(async ([path, precondition]) => {
		if (!isRestoreDiskIdentityCurrent(vault, path, precondition)) return false;
		if (precondition.kind === "missing") return true;
		try {
			const current = await vault.read(precondition.fileIdentity);
			return current === precondition.content
				&& isRestoreDiskIdentityCurrent(vault, path, precondition);
		} catch {
			return false;
		}
	}));

	const stalePaths = entries
		.filter(([path, precondition], index) => (
			byteChecks[index] !== true
			|| !isRestoreDiskIdentityCurrent(vault, path, precondition)
		))
		.map(([path]) => path);
	if (stalePaths.length > 0) return { kind: "stale", paths: stalePaths };

	const isDiskIdentityCurrent = () => entries.every(([path, precondition]) =>
		isRestoreDiskIdentityCurrent(vault, path, precondition));
	return { kind: "committed", value: commit(isDiskIdentityCurrent) };
}

export function quarantineUnsettledMarkdownRestore(
	diskMirror: RestoreDiskWriter | null,
	path: string,
): void {
	if (!diskMirror?.recordPreservedUnresolved) return;
	try {
		if (diskMirror.isPreservedUnresolved?.(path)) return;
		diskMirror.recordPreservedUnresolved(
		path,
		RESTORE_DISK_SETTLEMENT_FAILURE_REASON,
		);
	} catch {
		// Preserve the original settlement result. Production DiskMirror's marker
		// is synchronous; a defensive writer implementation must not turn the
		// explicit incomplete result into an unhandled exception.
	}
}

function notSettledRestore(
	diskMirror: RestoreDiskWriter | null,
	path: string,
	settlement: Extract<RestoreDiskSettlement, { kind: "not-settled" }>,
): RestoreDiskSettlement {
	quarantineUnsettledMarkdownRestore(diskMirror, path);
	return settlement;
}

/**
 * Commit an explicit snapshot/history restore to disk with the disk state the
 * user reviewed as a compare-and-swap precondition.
 *
 * The CRDT restore happens before this call. A non-settled result therefore
 * means "the synced state changed, but disk was deliberately left alone" and
 * must never be reported as a completed restore.
 */
export async function settleRestoredMarkdownPath(
	diskMirror: RestoreDiskWriter | null,
	path: string,
	precondition: RestoreDiskPrecondition,
	expectedRestoredContent: string,
): Promise<RestoreDiskSettlement> {
	if (!diskMirror) {
		return notSettledRestore(diskMirror, path, {
			kind: "not-settled",
			reason: "disk-mirror-unavailable",
			result: null,
		});
	}

	const options: DiskWriteOptions = {
		recordBaseline: true,
	};
	if (precondition.kind === "present") {
		options.expectedDiskContent = precondition.content;
		options.expectedDiskFile = precondition.fileIdentity;
		options.expectedDiskRevision = precondition.revision;
	} else {
		// DiskMirror defines this as a combined expected-missing CAS + one-shot
		// create authority. If a local file appeared since preparation, it defers.
		options.allowCreateIfMissing = true;
	}

	let result: DiskWriteResult;
	try {
		result = await diskMirror.flushWrite(path, true, options);
	} catch (err) {
		return notSettledRestore(diskMirror, path, {
			kind: "not-settled",
			reason: "flush-threw",
			result: null,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	if (result.kind !== "written" && result.kind !== "unchanged") {
		return notSettledRestore(diskMirror, path, {
			kind: "not-settled",
			reason: "flush-not-settled",
			result,
		});
	}
	if (result.content !== expectedRestoredContent) {
		return notSettledRestore(diskMirror, path, {
			kind: "not-settled",
			reason: "settled-content-mismatch",
			result,
		});
	}
	if (result.kind === "written" && !result.baselineRecorded) {
		return notSettledRestore(diskMirror, path, {
			kind: "not-settled",
			reason: "baseline-not-recorded",
			result,
		});
	}

	return { kind: "settled", result };
}
