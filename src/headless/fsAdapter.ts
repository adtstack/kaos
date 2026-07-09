import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isMarkdownSyncable } from "../types";
import { isInternalHeadlessPath, normalizeVaultPath, vaultPathToFsPath } from "./path";

export interface HeadlessFileStat {
	mtime: number;
	size: number;
}

export interface HeadlessMarkdownFile {
	path: string;
	content: string;
	stat: HeadlessFileStat;
}

export class NodeVaultFilesystem {
	constructor(
		readonly vaultRoot: string,
		private readonly options: {
			excludePatterns: string[];
			configDir?: string;
			maxFileSizeBytes: number;
			trashDir: string;
		},
	) {}

	async listMarkdownFiles(): Promise<HeadlessMarkdownFile[]> {
		const files: HeadlessMarkdownFile[] = [];
		await this.walk("", files);
		files.sort((a, b) => a.path.localeCompare(b.path));
		return files;
	}

	async readMarkdown(path: string): Promise<HeadlessMarkdownFile | null> {
		const normalized = normalizeVaultPath(path);
		if (!this.isSyncableMarkdownPath(normalized)) return null;
		const abs = vaultPathToFsPath(this.vaultRoot, normalized);
		try {
			const s = await stat(abs);
			if (!s.isFile() || s.size > this.options.maxFileSizeBytes) return null;
			return {
				path: normalized,
				content: await readFile(abs, "utf8"),
				stat: { mtime: s.mtimeMs, size: s.size },
			};
		} catch {
			return null;
		}
	}

	async writeMarkdown(path: string, content: string): Promise<HeadlessFileStat> {
		const normalized = normalizeVaultPath(path);
		const abs = vaultPathToFsPath(this.vaultRoot, normalized);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = `${abs}.kaos-headless-${process.pid}-${Date.now()}.tmp`;
		await writeFile(tmp, content, "utf8");
		await rename(tmp, abs);
		const s = await stat(abs);
		return { mtime: s.mtimeMs, size: s.size };
	}

	async moveToTrash(path: string, reason: string): Promise<string | null> {
		const normalized = normalizeVaultPath(path);
		const source = vaultPathToFsPath(this.vaultRoot, normalized);
		try {
			const s = await stat(source);
			if (!s.isFile()) return null;
		} catch {
			return null;
		}

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const target = join(
			this.options.trashDir,
			stamp,
			reason.replace(/[^a-z0-9_-]/gi, "_"),
			...normalized.split("/"),
		);
		await mkdir(dirname(target), { recursive: true });
		await rename(source, target);
		return target;
	}

	private async walk(dir: string, out: HeadlessMarkdownFile[]): Promise<void> {
		const absDir = dir ? vaultPathToFsPath(this.vaultRoot, dir) : this.vaultRoot;
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const child = normalizeVaultPath(dir ? `${dir}/${entry.name}` : entry.name);
			if (entry.isDirectory()) {
				if (this.shouldSkipDirectory(child)) continue;
				await this.walk(child, out);
				continue;
			}
			if (!entry.isFile() || !this.isSyncableMarkdownPath(child)) continue;
			const file = await this.readMarkdown(child);
			if (file) out.push(file);
		}
	}

	private shouldSkipDirectory(path: string): boolean {
		const normalized = normalizeVaultPath(path);
		return (
			normalized === this.configDir ||
			normalized.startsWith(`${this.configDir}/`) ||
			normalized === ".trash" ||
			normalized.startsWith(".trash/") ||
			isInternalHeadlessPath(normalized) ||
			this.isTrashDirectory(normalized)
		);
	}

	isSyncableMarkdownPath(path: string): boolean {
		const normalized = normalizeVaultPath(path);
		if (isInternalHeadlessPath(normalized)) return false;
		return isMarkdownSyncable(
			normalized,
			this.options.excludePatterns,
			this.configDir,
		);
	}

	private get configDir(): string {
		return normalizeVaultPath(this.options.configDir ?? ".obsidian");
	}

	private isTrashDirectory(path: string): boolean {
		const abs = resolve(vaultPathToFsPath(this.vaultRoot, path));
		const trash = resolve(this.options.trashDir);
		return abs === trash || abs.startsWith(`${trash}${sep}`);
	}
}
