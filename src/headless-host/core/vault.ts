import { readdirSync, statSync, type Dirent } from "node:fs";
import { appendFile, link, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { HeadlessEventEmitter } from "./events";
import { normalizePath, parentFolderForPath, TFile, TFolder, type HeadlessFileStats } from "./fileTypes";

let nextAdapterTemporaryNamespace = 0;

interface ObservedHeadlessFileStats extends HeadlessFileStats {
	dev: number;
	ino: number;
}

interface CachedHeadlessFile {
	file: TFile;
	dev: number;
	ino: number;
}

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
	/**
	 * Serialize mutations that target the same vault path.
	 *
	 * Obsidian's Vault.process contract serializes read/transform/write calls made
	 * through the Vault. The adapter additionally guards against path replacement
	 * by out-of-band writers, but no userspace lock can make arbitrary external
	 * filesystem writers participate in this lock.
	 */
	private readonly pathMutationLocks = new Map<string, Promise<unknown>>();
	/**
	 * Obsidian keeps a TFile object stable for the lifetime of a logical file.
	 *
	 * The filesystem identity is kept separately from TFile.stat because the
	 * latter mirrors Obsidian's public shape. A missing observation or a dev/ino
	 * change starts a new object epoch, while Vault-owned atomic writes explicitly
	 * let the current object adopt the replacement inode.
	 */
	private readonly fileCache = new Map<string, CachedHeadlessFile>();

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
		await this.runPathMutationLocked(file.path, async () => {
			await this.adapter.write(file.path, content);
			this.emit("modify", this.refreshFileAfterVaultMutation(file, file.path));
		});
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		await this.runPathMutationLocked(file.path, async () => {
			await this.adapter.writeBinary(file.path, data);
			this.emit("modify", this.refreshFileAfterVaultMutation(file, file.path));
		});
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		return await this.runPathMutationLocked(file.path, async () => {
			const next = await this.adapter.process(file.path, fn);
			this.emit("modify", this.refreshFileAfterVaultMutation(file, file.path));
			return next;
		});
	}

	async create(path: string, content: string): Promise<TFile> {
		return await this.runPathMutationLocked(path, async () => {
			await this.adapter.create(path, content);
			this.fileCache.delete(normalizePath(path));
			const file = await this.getFile(path);
			this.emit("create", file);
			return file;
		});
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		return await this.runPathMutationLocked(path, async () => {
			await this.adapter.createBinary(path, data);
			this.fileCache.delete(normalizePath(path));
			const file = await this.getFile(path);
			this.emit("create", file);
			return file;
		});
	}

	async createFolder(path: string): Promise<TFolder> {
		await this.adapter.mkdir(path);
		return new TFolder(normalizePath(path));
	}

	async delete(file: TFile): Promise<void> {
		await this.runPathMutationLocked(file.path, async () => {
			await this.adapter.remove(file.path);
			this.fileCache.delete(normalizePath(file.path));
			this.emit("delete", file);
		});
	}

	async trash(file: TFile): Promise<void> {
		await this.runPathMutationLocked(file.path, async () => {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const trashPath = normalizePath(`${this.trashDir}/kaos-headless-host/${stamp}/${file.path}`);
			await this.adapter.rename(file.path, trashPath);
			this.fileCache.delete(normalizePath(file.path));
			this.emit("delete", file);
		});
	}

	async rename(file: TFile, newPath: string): Promise<void> {
		const oldPath = file.path;
		await this.runPathMutationsLocked([oldPath, newPath], async () => {
			await this.adapter.rename(oldPath, newPath);
			// Obsidian mutates the existing TFile on a Vault.rename. Keeping that
			// contract ensures references held by editors and CAS callers follow the
			// file, while oldPath remains available separately in the rename event.
			const renamed = this.refreshFileAfterVaultMutation(file, newPath, oldPath);
			this.emit("rename", renamed, oldPath);
		});
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		const normalized = normalizePath(path);
		const abs = this.adapter.toFsPath(normalized);
		try {
			const s = statSync(abs);
			if (s.isDirectory()) {
				this.fileCache.delete(normalized);
				return new TFolder(normalized);
			}
			if (!s.isFile()) {
				this.fileCache.delete(normalized);
				return null;
			}
			return this.fileFromStat(normalized, {
				ctime: s.ctimeMs,
				mtime: s.mtimeMs,
				size: s.size,
				dev: s.dev,
				ino: s.ino,
			});
		} catch {
			// Observing a missing path terminates the cached object epoch. Even if
			// the filesystem later reuses the same inode number, a recreation gets a
			// fresh TFile identity instead of reviving a deleted object.
			this.fileCache.delete(normalized);
			return null;
		}
	}

	getFiles(): TFile[] {
		const out: TFile[] = [];
		const observedPaths = new Set<string>();
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
				observedPaths.add(rel);
				out.push(this.fileFromStat(rel, {
					ctime: s.ctimeMs,
					mtime: s.mtimeMs,
					size: s.size,
					dev: s.dev,
					ino: s.ino,
				}));
			}
		};
		walk("");
		for (const path of this.fileCache.keys()) {
			if (!observedPaths.has(path)) this.fileCache.delete(path);
		}
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((file) => file.extension === "md");
	}

	private async getFile(path: string): Promise<TFile> {
		const file = this.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
		return file;
	}

	private fileFromStat(path: string, statValue: ObservedHeadlessFileStats): TFile {
		const normalized = normalizePath(path);
		const cached = this.fileCache.get(normalized);
		if (cached && cached.dev === statValue.dev && cached.ino === statValue.ino) {
			this.updateFile(cached.file, normalized, statValue);
			return cached.file;
		}

		const file = new TFile(normalized, publicFileStats(statValue), parentFolderForPath(normalized));
		file.vault = this;
		this.fileCache.set(normalized, { file, dev: statValue.dev, ino: statValue.ino });
		return file;
	}

	private refreshFileAfterVaultMutation(file: TFile, path: string, oldPath?: string): TFile {
		const normalized = normalizePath(path);
		const s = statSync(this.adapter.toFsPath(normalized));
		if (!s.isFile()) throw new Error(`File not found: ${normalized}`);
		if (oldPath !== undefined) this.fileCache.delete(normalizePath(oldPath));
		this.fileCache.delete(normalized);
		const observed: ObservedHeadlessFileStats = {
			ctime: s.ctimeMs,
			mtime: s.mtimeMs,
			size: s.size,
			dev: s.dev,
			ino: s.ino,
		};
		this.updateFile(file, normalized, observed);
		this.fileCache.set(normalized, { file, dev: observed.dev, ino: observed.ino });
		return file;
	}

	private updateFile(file: TFile, path: string, statValue: ObservedHeadlessFileStats): void {
		const snapshot = new TFile(path, publicFileStats(statValue), parentFolderForPath(path));
		file.path = snapshot.path;
		file.name = snapshot.name;
		file.parent = snapshot.parent;
		file.stat = snapshot.stat;
		file.basename = snapshot.basename;
		file.extension = snapshot.extension;
		file.vault = this;
	}

	private isExcludedPath(path: string): boolean {
		const normalized = normalizePath(path);
		if (isInternalTempFile(normalized)) return true;
		return this.excludedPaths.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
	}

	private runPathMutationLocked<T>(path: string, work: () => Promise<T>): Promise<T> {
		const normalized = normalizePath(path);
		const previous = this.pathMutationLocks.get(normalized) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<T>;
		tracked = next.finally(() => {
			if (this.pathMutationLocks.get(normalized) === tracked) {
				this.pathMutationLocks.delete(normalized);
			}
		});
		this.pathMutationLocks.set(normalized, tracked);
		return tracked;
	}

	private runPathMutationsLocked<T>(paths: string[], work: () => Promise<T>): Promise<T> {
		const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)))].sort();
		const acquire = (index: number): Promise<T> => {
			const path = normalizedPaths[index];
			if (path === undefined) return work();
			return this.runPathMutationLocked(path, () => acquire(index + 1));
		};
		return acquire(0);
	}
}

export class HeadlessVaultAdapter {
	readonly vaultRoot: string;
	readonly basePath: string;
	private readonly temporaryFileNamespace =
		`${process.pid}-${Date.now()}-${nextAdapterTemporaryNamespace++}`;
	private temporaryFileSequence = 0;

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
		const tmp = this.nextTemporaryPath(abs);
		try {
			await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
			await rename(tmp, abs);
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => undefined);
			throw err;
		}
	}

	async create(path: string, content: string): Promise<void> {
		const abs = this.toFsPath(path);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = this.nextTemporaryPath(abs);
		try {
			await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
			// Linking a fully-written inode makes the destination appear atomically.
			// link(2) also fails with EEXIST, so a racing or pre-existing local
			// file is never replaced.
			await link(tmp, abs);
		} finally {
			await rm(tmp, { force: true }).catch(() => undefined);
		}
	}

	async process(path: string, fn: (data: string) => string): Promise<string> {
		const abs = this.toFsPath(path);
		// Keep the source inode alive until the commit finishes. Besides binding the
		// transform to a concrete file, this prevents inode-number reuse from hiding
		// a remove/recreate ABA while we compare dev+ino below.
		const source = await open(abs, "r");
		const tmp = this.nextTemporaryPath(abs);
		const displaced = this.nextTemporaryPath(abs);
		let displacedExists = false;
		let cleanupDisplaced = false;
		try {
			const sourceIdentity = await source.stat();
			const current = await source.readFile({ encoding: "utf8" });
			// Keep the callback synchronous, matching Obsidian's Vault.process API.
			// If it throws (for example, DiskMirror's stale-snapshot sentinel), no
			// temporary file is written and the original error identity propagates.
			const next = fn(current);
			await writeFile(tmp, next, { encoding: "utf8", flag: "wx" });

			// Refuse both in-place content changes and atomic remove/recreate changes.
			// Stat on both sides of the read ensures the comparison itself did not
			// straddle a path replacement.
			const beforeLatest = await stat(abs);
			const latest = await readFile(abs, "utf8");
			const afterLatest = await stat(abs);
			if (
				!sameFileIdentity(sourceIdentity, beforeLatest) ||
				!sameFileIdentity(sourceIdentity, afterLatest) ||
				latest !== current
			) {
				throw processChangedError(path);
			}

			// This protected seam is also the deterministic fault-injection point for
			// the final compare -> commit gap. Correctness must not depend on it being
			// empty: an external atomic replacement here is moved aside, recognized by
			// its inode, and restored without being overwritten.
			await this.beforeProcessCommit(path);
			await rename(abs, displaced);
			displacedExists = true;

			try {
				const beforeDisplaced = await stat(displaced);
				const displacedContent = await readFile(displaced, "utf8");
				const afterDisplaced = await stat(displaced);
				if (
					!sameFileIdentity(sourceIdentity, beforeDisplaced) ||
					!sameFileIdentity(sourceIdentity, afterDisplaced) ||
					displacedContent !== current
				) {
					throw processChangedError(path);
				}

				// The path is deliberately empty after the guarded move. link(2) is the
				// conditional commit: if an external writer acquires the name first,
				// EEXIST preserves that writer instead of replacing it.
				await link(tmp, abs);
				cleanupDisplaced = true;
				return next;
			} catch (err) {
				try {
					await link(displaced, abs);
					cleanupDisplaced = true;
				} catch (restoreErr) {
					if (hasErrorCode(restoreErr, "EEXIST")) {
						// A later external writer already owns the destination. It wins, and
						// the displaced pre-commit file can be retired safely.
						cleanupDisplaced = true;
					} else {
						// Do not remove the guard when restoration itself fails. This is a
						// crash/error recovery copy, not a claim of transactionality across
						// arbitrary filesystem failures.
						throw new Error(
							`Process failed; displaced file retained at ${displaced}: ${String(restoreErr)}`,
						);
					}
				}
				if (hasErrorCode(err, "EEXIST")) throw processChangedError(path);
				throw err;
			}
		} finally {
			await source.close().catch(() => undefined);
			await rm(tmp, { force: true }).catch(() => undefined);
			if (displacedExists && cleanupDisplaced) {
				await rm(displaced, { force: true }).catch(() => undefined);
			}
		}
	}

	protected beforeProcessCommit(_path: string): Promise<void> {
		return Promise.resolve();
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
		const tmp = this.nextTemporaryPath(abs);
		try {
			await writeFile(tmp, Buffer.from(data), { flag: "wx" });
			await rename(tmp, abs);
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => undefined);
			throw err;
		}
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<void> {
		const abs = this.toFsPath(path);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = this.nextTemporaryPath(abs);
		try {
			await writeFile(tmp, Buffer.from(data), { flag: "wx" });
			await link(tmp, abs);
		} finally {
			await rm(tmp, { force: true }).catch(() => undefined);
		}
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
		if (oldAbs === newAbs) return;
		await mkdir(dirname(newAbs), { recursive: true });
		// POSIX rename(2) replaces an existing destination. Obsidian's file
		// manager treats a rename collision as an error, and DiskMirror relies on
		// that no-clobber contract to preserve independent local target work. A
		// hard-link commit provides an atomic EEXIST check; remove the source only
		// after the destination name has been acquired successfully.
		await link(oldAbs, newAbs);
		try {
			await rm(oldAbs);
		} catch (err) {
			// Roll back the new name if retiring the source failed. The source inode
			// remains authoritative and no caller observes a successful rename.
			await rm(newAbs, { force: true }).catch(() => undefined);
			throw err;
		}
	}

	private nextTemporaryPath(abs: string): string {
		const sequence = this.temporaryFileSequence++;
		return `${abs}.kaos-headless-host-${this.temporaryFileNamespace}-${sequence}.tmp`;
	}
}

function isInternalTempFile(path: string): boolean {
	return path.includes(".kaos-headless-host-") && path.endsWith(".tmp");
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function publicFileStats(statValue: HeadlessFileStats): HeadlessFileStats {
	return {
		ctime: statValue.ctime,
		mtime: statValue.mtime,
		size: statValue.size,
	};
}

function processChangedError(path: string): Error {
	return new Error(`File changed during process: ${normalizePath(path)}`);
}

function hasErrorCode(err: unknown, code: string): boolean {
	if (typeof err !== "object" || err === null || !("code" in err)) return false;
	return (err as { code?: unknown }).code === code;
}
