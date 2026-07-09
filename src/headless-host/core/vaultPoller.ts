import { TFile } from "./fileTypes";
import type { HeadlessEventRef } from "./events";
import type { HeadlessVault } from "./vault";

interface FileSnapshot {
	file: TFile;
	mtime: number;
	size: number;
	observedAt: number;
}

export interface HeadlessVaultPollerOptions {
	intervalMs?: number;
	detectRenames?: boolean;
	quietMs?: number;
}

export class HeadlessVaultPoller {
	private snapshots = new Map<string, FileSnapshot>();
	private interval: ReturnType<typeof setInterval> | null = null;
	private eventRefs: HeadlessEventRef[] = [];
	private polling = false;

	constructor(
		private readonly vault: HeadlessVault,
		private readonly options: HeadlessVaultPollerOptions = {},
	) {}

	async initialize(): Promise<void> {
		this.snapshots = this.readSnapshot();
	}

	async start(): Promise<void> {
		await this.initialize();
		this.registerVaultEventBaselineUpdates();
		const intervalMs = Math.max(250, this.options.intervalMs ?? 1000);
		this.interval = setInterval(() => {
			void this.pollOnce();
		}, intervalMs);
	}

	stop(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		for (const ref of this.eventRefs.splice(0)) {
			ref.off();
		}
	}

	async pollOnce(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const next = this.readSnapshot();
			const created: FileSnapshot[] = [];
			const deleted: FileSnapshot[] = [];
			for (const [path, current] of next) {
				const previous = this.snapshots.get(path);
				if (!previous) {
					if (this.isCreateModifyQuiet(current)) {
						created.push(current);
					} else {
						next.delete(path);
					}
					continue;
				}
				if (previous.mtime !== current.mtime || previous.size !== current.size) {
					if (this.isCreateModifyQuiet(current)) {
						this.vault.emit("modify", current.file);
					} else {
						next.set(path, previous);
					}
				}
			}
			for (const [path, previous] of this.snapshots) {
				if (!next.has(path)) {
					if (this.isDeleteQuiet(previous)) {
						deleted.push(previous);
					} else {
						next.set(path, previous);
					}
				}
			}
			const rename = this.detectRename(created, deleted);
			if (rename) {
				this.vault.emit("rename", rename.created.file, rename.deleted.file.path);
				created.splice(created.indexOf(rename.created), 1);
				deleted.splice(deleted.indexOf(rename.deleted), 1);
			}
			for (const current of created) {
				this.vault.emit("create", current.file);
			}
			for (const previous of deleted) {
				this.vault.emit("delete", previous.file);
			}
			this.snapshots = next;
		} finally {
			this.polling = false;
		}
	}

	private detectRename(created: FileSnapshot[], deleted: FileSnapshot[]): { created: FileSnapshot; deleted: FileSnapshot } | null {
		if (this.options.detectRenames === false) return null;
		if (created.length !== 1 || deleted.length !== 1) return null;
		const createdFile = created[0];
		const deletedFile = deleted[0];
		if (!createdFile || !deletedFile) return null;
		if (createdFile.size !== deletedFile.size) return null;
		if (createdFile.mtime !== deletedFile.mtime) return null;
		return { created: createdFile, deleted: deletedFile };
	}

	private isCreateModifyQuiet(snapshot: FileSnapshot): boolean {
		const quietMs = this.options.quietMs ?? 1100;
		if (quietMs <= 0) return true;
		return Date.now() - snapshot.mtime >= quietMs;
	}

	private isDeleteQuiet(snapshot: FileSnapshot): boolean {
		const quietMs = this.options.quietMs ?? 1100;
		if (quietMs <= 0) return true;
		return Date.now() - snapshot.observedAt >= quietMs;
	}

	private readSnapshot(): Map<string, FileSnapshot> {
		const next = new Map<string, FileSnapshot>();
		for (const file of this.vault.getFiles()) {
			next.set(file.path, this.snapshotFile(file));
		}
		return next;
	}

	private snapshotFile(file: TFile): FileSnapshot {
		return {
			file,
			mtime: file.stat.mtime,
			size: file.stat.size,
			observedAt: Date.now(),
		};
	}

	private registerVaultEventBaselineUpdates(): void {
		if (this.eventRefs.length > 0) return;
		this.eventRefs.push(
			this.vault.on("create", (file) => {
				if (file instanceof TFile) this.snapshots.set(file.path, this.snapshotFile(file));
			}),
			this.vault.on("modify", (file) => {
				if (file instanceof TFile) this.snapshots.set(file.path, this.snapshotFile(file));
			}),
			this.vault.on("delete", (file) => {
				if (file instanceof TFile) this.snapshots.delete(file.path);
			}),
			this.vault.on("rename", (file, oldPath) => {
				if (typeof oldPath === "string") this.snapshots.delete(oldPath);
				if (file instanceof TFile) this.snapshots.set(file.path, this.snapshotFile(file));
			}),
		);
	}
}
