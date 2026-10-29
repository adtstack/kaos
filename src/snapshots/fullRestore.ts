import { TFile, normalizePath } from "obsidian";
import type { SnapshotDiff } from "../sync/snapshotClient";
import { captureRestoreDiskRevision, commitWithCurrentRestoreDiskAuthority, type RestoreDiskPrecondition } from "./restoreDiskSettlement";

export function fullRestorePaths(diff: SnapshotDiff) {
	const unique = (paths: string[]) => [...new Set(paths.map(normalizePath))];
	return {
		markdownPaths: unique([...diff.contentChanged, ...diff.deletedSinceSnapshot].map(entry => entry.path)),
		blobPaths: unique([...diff.blobsChanged, ...diff.blobsDeletedSinceSnapshot].map(entry => entry.path)),
		removeMarkdownPaths: unique(diff.createdSinceSnapshot),
		removeBlobPaths: unique(diff.blobsCreatedSinceSnapshot),
	};
}

/** Category membership must still match the operation the user reviewed. */
export function fullRestoreDiffIdentity(diff: SnapshotDiff): string {
	return JSON.stringify(Object.entries(fullRestorePaths(diff)).map(([kind, paths]) => [kind, paths.sort()]));
}

export function fullRestoreCounts(diff: SnapshotDiff) {
	const changed = diff.contentChanged.length + diff.blobsChanged.length;
	const deleted = diff.deletedSinceSnapshot.length + diff.blobsDeletedSinceSnapshot.length;
	const removed = diff.createdSinceSnapshot.length + diff.blobsCreatedSinceSnapshot.length;
	return { changed, deleted, removed, total: changed + deleted + removed };
}

export function requiresTypedFullRestoreConfirmation(diff: SnapshotDiff): boolean {
	const counts = fullRestoreCounts(diff);
	return counts.total > 200 || counts.removed > 50;
}

export function encodeRestoreBytes(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeRestoreBytes(hex: string): ArrayBuffer {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes.buffer;
}

export interface FullRestoreBinaryVault {
	getAbstractFileByPath(path: string): unknown;
	readBinary(file: TFile): Promise<ArrayBuffer>;
}

export function binaryRestoreAuthorityReader(vault: FullRestoreBinaryVault) {
	return {
		getAbstractFileByPath: (path: string) => vault.getAbstractFileByPath(path),
		read: async (file: TFile) => encodeRestoreBytes(await vault.readBinary(file)),
	};
}

export async function captureFullRestoreBlobDiskAuthority(vault: FullRestoreBinaryVault, paths: string[]) {
	const captured = new Map<string, RestoreDiskPrecondition>();
	for (const path of paths) {
		const file = vault.getAbstractFileByPath(path);
		if (file === null) { captured.set(path, { kind: "missing" }); continue; }
		if (!(file instanceof TFile)) throw new Error("Attachment disk authority is unavailable. Reopen the snapshot diff.");
		const revision = captureRestoreDiskRevision(file);
		const content = encodeRestoreBytes(await vault.readBinary(file));
		captured.set(path, { kind: "present", fileIdentity: file, revision, content });
	}
	const check = await commitWithCurrentRestoreDiskAuthority(binaryRestoreAuthorityReader(vault), captured, () => undefined);
	if (check.kind === "stale") throw new Error("Attachment disk changed while opening the snapshot diff. Reopen it.");
	return captured;
}
