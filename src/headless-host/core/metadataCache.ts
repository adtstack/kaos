import { HeadlessEventEmitter } from "./events";
import { normalizePath, TFile } from "./fileTypes";
import type { HeadlessVault } from "./vault";

export class HeadlessMetadataCache extends HeadlessEventEmitter {
	constructor(private readonly vault?: HeadlessVault) {
		super();
	}

	getFileCache(): null {
		return null;
	}

	getFirstLinkpathDest(linkpath: string, sourcePath = ""): TFile | null {
		if (!this.vault) return null;
		const candidates = this.linkpathCandidates(linkpath, sourcePath);
		for (const candidate of candidates) {
			const file = this.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile) return file;
		}
		return null;
	}

	private linkpathCandidates(linkpath: string, sourcePath: string): string[] {
		const raw = linkpath.split("#")[0]?.split("|")[0]?.trim() ?? "";
		if (!raw) return [];
		const normalized = normalizePath(raw);
		const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
		const candidates = [normalized, withExtension];
		const sourceDir = normalizePath(sourcePath).split("/").slice(0, -1).join("/");
		if (sourceDir) {
			candidates.push(normalizePath(`${sourceDir}/${normalized}`));
			candidates.push(normalizePath(`${sourceDir}/${withExtension}`));
		}
		return Array.from(new Set(candidates));
	}
}
