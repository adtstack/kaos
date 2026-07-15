import type { TFile, Vault } from "obsidian";

export type ConflictResolutionChoice =
	| { kind: "original" }
	| { kind: "artifact" }
	| { kind: "merged"; mergedText: string };

interface FileFingerprint {
	ctime: number;
	mtime: number;
	size: number;
}

export interface ConflictResolutionSnapshot {
	originalPath: string;
	artifactPath: string;
	originalFile: TFile;
	artifactFile: TFile;
	originalText: string;
	artifactText: string;
	originalFingerprint: FileFingerprint;
	artifactFingerprint: FileFingerprint;
}

type ConflictResolutionVault = Pick<
	Vault,
	"getAbstractFileByPath" | "read" | "process"
>;

/**
 * Raised when either side no longer matches the exact files shown in the diff.
 * The caller should leave the conflict artifact visible and ask the user to
 * reopen the diff instead of applying a decision made from stale content.
 */
export class StaleConflictResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleConflictResolutionError";
	}
}

export function captureConflictResolutionSnapshot(input: {
	originalPath: string;
	artifactPath: string;
	originalFile: TFile;
	artifactFile: TFile;
	originalText: string;
	artifactText: string;
}): ConflictResolutionSnapshot {
	return {
		...input,
		originalFingerprint: fingerprint(input.originalFile),
		artifactFingerprint: fingerprint(input.artifactFile),
	};
}

/**
 * Resolve a Markdown conflict only if both files still match the snapshots
 * shown to the user. The original update is a Vault.process CAS. Because the
 * vault has no cross-file transaction, both sides are validated again after
 * that CAS. A failed post-commit validation is reported without a compensating
 * write: bytes alone cannot prove that the current original is still the write
 * from this operation (a same-content ABA may have occurred). Obsidian also
 * does not expose an identity-aware conditional delete, so the artifact is
 * deliberately retained after success.
 */
export async function resolveConflictArtifactWithCas(
	vault: ConflictResolutionVault,
	snapshot: ConflictResolutionSnapshot,
	choice: ConflictResolutionChoice,
): Promise<void> {
	await validateUnchangedSnapshot(vault, snapshot);

	const replacement = choice.kind === "artifact"
		? snapshot.artifactText
		: choice.kind === "merged"
			? choice.mergedText
			: snapshot.originalText;
	const changedOriginal = replacement !== snapshot.originalText;

	if (changedOriginal) {
		requireSameFile(vault, snapshot.originalPath, snapshot.originalFile, "original note");
		requireSameFile(vault, snapshot.artifactPath, snapshot.artifactFile, "conflict artifact");
		const written = await vault.process(snapshot.originalFile, (current) => {
			if (current !== snapshot.originalText) {
				throw stale("The original note changed after the diff was opened");
			}
			return replacement;
		});
		if (written !== replacement) {
			throw new Error("The original note did not settle to the selected conflict resolution; the artifact was kept.");
		}
	}

	await validatePostCommitState(vault, snapshot, replacement, !changedOriginal);

	// A final identity check cannot make a later path-based Vault.delete atomic.
	// Keep the validated artifact as a safety copy; the user may delete it
	// manually after reviewing the applied resolution.
}

async function validateUnchangedSnapshot(
	vault: ConflictResolutionVault,
	snapshot: ConflictResolutionSnapshot,
): Promise<void> {
	assertSnapshotFile(vault, snapshot.originalPath, snapshot.originalFile, snapshot.originalFingerprint, "original note");
	assertSnapshotFile(vault, snapshot.artifactPath, snapshot.artifactFile, snapshot.artifactFingerprint, "conflict artifact");
	const [originalText, artifactText] = await Promise.all([
		vault.read(snapshot.originalFile),
		vault.read(snapshot.artifactFile),
	]);
	assertSnapshotFile(vault, snapshot.originalPath, snapshot.originalFile, snapshot.originalFingerprint, "original note");
	assertSnapshotFile(vault, snapshot.artifactPath, snapshot.artifactFile, snapshot.artifactFingerprint, "conflict artifact");
	if (originalText !== snapshot.originalText) {
		throw stale("The original note changed after the diff was opened");
	}
	if (artifactText !== snapshot.artifactText) {
		throw stale("The conflict artifact changed after the diff was opened");
	}
}

async function validatePostCommitState(
	vault: ConflictResolutionVault,
	snapshot: ConflictResolutionSnapshot,
	replacement: string,
	requireOriginalSnapshot: boolean,
): Promise<void> {
	if (requireOriginalSnapshot) {
		assertSnapshotFile(vault, snapshot.originalPath, snapshot.originalFile, snapshot.originalFingerprint, "original note");
	} else {
		requireSameFile(vault, snapshot.originalPath, snapshot.originalFile, "original note");
	}
	assertSnapshotFile(vault, snapshot.artifactPath, snapshot.artifactFile, snapshot.artifactFingerprint, "conflict artifact");
	const [originalText, artifactText] = await Promise.all([
		vault.read(snapshot.originalFile),
		vault.read(snapshot.artifactFile),
	]);
	if (requireOriginalSnapshot) {
		assertSnapshotFile(vault, snapshot.originalPath, snapshot.originalFile, snapshot.originalFingerprint, "original note");
	} else {
		requireSameFile(vault, snapshot.originalPath, snapshot.originalFile, "original note");
	}
	assertSnapshotFile(vault, snapshot.artifactPath, snapshot.artifactFile, snapshot.artifactFingerprint, "conflict artifact");
	if (originalText !== replacement) {
		throw stale("The original note changed while the resolution was being applied");
	}
	if (artifactText !== snapshot.artifactText) {
		throw stale("The conflict artifact changed while the resolution was being applied");
	}
}

function assertSnapshotFile(
	vault: ConflictResolutionVault,
	path: string,
	expectedFile: TFile,
	expectedFingerprint: FileFingerprint,
	label: string,
): void {
	requireSameFile(vault, path, expectedFile, label);
	if (!sameFingerprint(fingerprint(expectedFile), expectedFingerprint)) {
		throw stale(`The ${label} changed after the diff was opened`);
	}
}

function requireSameFile(
	vault: ConflictResolutionVault,
	path: string,
	expectedFile: TFile,
	label: string,
): TFile {
	if (vault.getAbstractFileByPath(path) !== expectedFile) {
		throw stale(`The ${label} was moved, deleted, or replaced after the diff was opened`);
	}
	return expectedFile;
}

function fingerprint(file: TFile): FileFingerprint {
	return {
		ctime: file.stat.ctime,
		mtime: file.stat.mtime,
		size: file.stat.size,
	};
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
	return left.ctime === right.ctime
		&& left.mtime === right.mtime
		&& left.size === right.size;
}

function stale(message: string): StaleConflictResolutionError {
	return new StaleConflictResolutionError(`${message}. Reopen the diff and try again; the conflict artifact was kept.`);
}
