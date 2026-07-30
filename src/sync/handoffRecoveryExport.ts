import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { sha256HandoffRecoveryHex } from "./handoffRecoveryStore";

export type HandoffRecoveryExportResult = Readonly<{
	path: string;
	contentHash: string;
}>;

export async function exportHandoffRecoveryBody(
	app: App,
	requestedPath: string,
	content: string,
): Promise<HandoffRecoveryExportResult> {
	const trimmed = requestedPath.trim();
	if (!trimmed || trimmed.includes("\0")) {
		throw new Error("Choose a valid Recovery export path");
	}
	const withExtension = /\.(?:md|txt)$/i.test(trimmed) ? trimmed : `${trimmed}.txt`;
	const normalized = normalizePath(withExtension);
	const slash = normalized.lastIndexOf("/");
	const parentPath = slash < 0 ? "" : normalized.slice(0, slash);
	if (parentPath) {
		const parent = app.vault.getAbstractFileByPath(parentPath);
		if (!(parent instanceof TFolder)) {
			throw new Error(`Recovery export folder does not exist: ${parentPath}`);
		}
	}
	const dot = normalized.lastIndexOf(".");
	const stem = dot > slash ? normalized.slice(0, dot) : normalized;
	const extension = dot > slash ? normalized.slice(dot) : "";
	let candidate = normalized;
	for (let copy = 2; app.vault.getAbstractFileByPath(candidate) !== null; copy += 1) {
		if (copy > 1000) throw new Error("No collision-free Recovery export path is available");
		candidate = `${stem} ${copy}${extension}`;
	}
	const file = await app.vault.create(candidate, content);
	if (!(file instanceof TFile) || file.path !== candidate) {
		throw new Error("Recovery export returned an unexpected file identity");
	}
	const reread = await app.vault.read(file);
	if (reread !== content) {
		throw new Error("Recovery export verification failed");
	}
	return {
		path: candidate,
		contentHash: await sha256HandoffRecoveryHex(reread),
	};
}
