import { readdirSync, statSync, type Dirent } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { HeadlessEventEmitter } from "./events";
import { normalizePath, parentFolderForPath, TFile, TFolder, type HeadlessFileStats } from "./fileTypes";

export interface HeadlessVaultOptions {
	vaultRoot: string;
	configDir?: string;
	trashDir?: string;
	name?: string;
	excludedPaths?: string[];
}

export class HeadlessVault extends HeadlessEventEmitter {
	readonly adapter: HeadlessVaultAdapter;
	readonly configDir: string;
	private readonly name: string;
	private readonly trashDir: string;
	private readonly excludedPaths: string[];

	constructor(options: HeadlessVaultOptions) {
		super();
		this.adapter = new HeadlessVaultAdapter(options.vaultRoot);
		this.configDir = options.configDir ?? ".obsidian";
		this.name = options.name ?? "Headless Vault";
		this.trashDir = normalizePath(options.trashDir ?? ".trash");
		this.excludedPaths = [
			this.configDir,
			this.trashDir,
			...(options.excludedPaths ?? []),
		].map((path) => normalizePath(path)).filter(Boolean);
	}

	getName(): string {
		return this.name;
	}

	async cachedRead(file: TFile): Promise<string> {
		return await this.read(file);
	}

	async read(file: TFile): Promise<string> {
		return await this.adapter.read(file.path);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		return await this.adapter.readBinary(file.path);
	}

	async modify(file: TFile, content: string): Promise<void> {
		await this.adapter.write(file.path, content);
		this.emit("modify", await this.getFile(file.path));
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		await this.adapter.writeBinary(file.path, data);
		this.emit("modify", await this.getFile(file.path));
	}

	async create(path: string, content: string): Promise<TFile> {
		await this.adapter.write(path, content);
		const file = await this.getFile(path);
		this.emit("create", file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		await this.adapter.writeBinary(path, data);
		const file = await this.getFile(path);
		this.emit("create", file);
		return file;
	}

	async createFolder(path: string): Promise<TFolder> {
		await this.adapter.mkdir(path);
		return new TFolder(normalizePath(path));
	}

	async delete(file: TFile): Promise<void> {
		await this.adapter.remove(file.path);
		this.emit("delete", file);
	}

	async trash(file: TFile): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const trashPath = normalizePath(`${this.trashDir}/kaos-headless-host/${stamp}/${file.path}`);
		await this.adapter.rename(file.path, trashPath);
		this.emit("delete", file);
	}

	async rename(file: TFile, newPath: string): Promise<void> {
		const oldPath = file.path;
		await this.adapter.rename(oldPath, newPath);
		const renamed = await this.getFile(newPath);
		this.emit("rename", renamed, oldPath);
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		const normalized = normalizePath(path);
		const abs = this.adapter.toFsPath(normalized);
		try {
			const s = statSync(abs);
			if (s.isDirectory()) return new TFolder(normalized);
			if (!s.isFile()) return null;
			return this.fileFromStat(normalized, {
				ctime: s.ctimeMs,
				mtime: s.mtimeMs,
				size: s.size,
			});
		} catch {
			return null;
		}
	}

	getFiles(): TFile[] {
		const out: TFile[] = [];
		const walk = (dir: string) => {
			const absDir = dir ? this.adapter.toFsPath(dir) : this.adapter.vaultRoot;
			let entries: Dirent[];
			try {
				entries = readdirSync(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = normalizePath(dir ? `${dir}/${entry.name}` : entry.name);
				if (this.isExcludedPath(rel)) continue;
				if (entry.isDirectory()) {
					walk(rel);
					continue;
				}
				if (!entry.isFile()) continue;
				const s = statSync(this.adapter.toFsPath(rel));
				out.push(this.fileFromStat(rel, { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }));
			}
		};
		walk("");
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((file) => file.extension === "md");
	}

	private async getFile(path: string): Promise<TFile> {
		const s = await this.adapter.stat(path);
		if (!s) throw new Error(`File not found: ${path}`);
		return this.fileFromStat(path, { ctime: s.ctime, mtime: s.mtime, size: s.size });
	}

	private fileFromStat(path: string, statValue: HeadlessFileStats): TFile {
		const file = new TFile(normalizePath(path), statValue, parentFolderForPath(path));
		file.vault = this;
		return file;
	}

	private isExcludedPath(path: string): boolean {
		const normalized = normalizePath(path);
		if (isInternalTempFile(normalized)) return true;
		return this.excludedPaths.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
	}
}

export class HeadlessVaultAdapter {
	readonly vaultRoot: string;
	readonly basePath: string;

	constructor(vaultRoot: string) {
		this.vaultRoot = resolve(vaultRoot);
		this.basePath = this.vaultRoot;
	}

	toFsPath(vaultPath: string): string {
		const normalized = normalizePath(vaultPath);
		const target = resolve(this.vaultRoot, ...normalized.split("/").filter(Boolean));
		if (target !== this.vaultRoot && !target.startsWith(`${this.vaultRoot}${sep}`)) {
			throw new Error(`Path escapes vault root: ${vaultPath}`);
		}
		return target;
	}

	async read(path: string): Promise<string> {
		return await readFile(this.toFsPath(path), "utf8");
	}

	async write(path: string, content: string): Promise<void> {
		const abs = this.toFsPath(path);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = `${abs}.kaos-headless-host-${process.pid}-${Date.now()}.tmp`;
		await writeFile(tmp, content, "utf8");
		await rename(tmp, abs);
	}

	async append(path: string, content: string): Promise<void> {
		const abs = this.toFsPath(path);
		await mkdir(dirname(abs), { recursive: true });
		await appendFile(abs, content, "utf8");
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const buffer = await readFile(this.toFsPath(path));
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const abs = this.toFsPath(path);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = `${abs}.kaos-headless-host-${process.pid}-${Date.now()}.tmp`;
		await writeFile(tmp, Buffer.from(data));
		await rename(tmp, abs);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await stat(this.toFsPath(path));
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<HeadlessFileStats | null> {
		try {
			const s = await stat(this.toFsPath(path));
			return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
		} catch {
			return null;
		}
	}

	async mkdir(path: string): Promise<void> {
		await mkdir(this.toFsPath(path), { recursive: true });
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const entries = await readdir(this.toFsPath(path), { withFileTypes: true });
		return {
			files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
			folders: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
		};
	}

	async remove(path: string): Promise<void> {
		await rm(this.toFsPath(path), { force: true, recursive: true });
	}

	async rmdir(path: string, recursive = false): Promise<void> {
		if (recursive) {
			await rm(this.toFsPath(path), { force: true, recursive: true });
			return;
		}
		await rmdir(this.toFsPath(path));
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldAbs = this.toFsPath(oldPath);
		const newAbs = this.toFsPath(newPath);
		await mkdir(dirname(newAbs), { recursive: true });
		await rename(oldAbs, newAbs);
	}
}

function isInternalTempFile(path: string): boolean {
	return path.includes(".kaos-headless-host-") && path.endsWith(".tmp");
}
