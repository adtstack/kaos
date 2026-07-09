import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { HeadlessVaultDoc } from "./doc";
import { NodeVaultFilesystem, type HeadlessMarkdownFile } from "./fsAdapter";
import { sha256Hex } from "./hash";
import { normalizeVaultPath } from "./path";
import type { HeadlessState, HeadlessPathState } from "./stateStore";

export interface HeadlessReconcileStats {
	localCreated: number;
	localModified: number;
	localDeleted: number;
	remoteCreated: number;
	remoteModified: number;
	remoteDeleted: number;
	remoteRenamed: number;
	conflicts: number;
	preservedDeletes: number;
	preservedRenames: number;
	skippedTombstones: number;
}

export type HeadlessLogEvent =
	| { kind: "local-created"; path: string }
	| { kind: "local-modified"; path: string }
	| { kind: "local-deleted"; path: string }
	| { kind: "remote-created"; path: string }
	| { kind: "remote-modified"; path: string }
	| { kind: "remote-deleted"; path: string; trashPath: string | null }
	| { kind: "remote-renamed"; path: string; oldPath: string; trashPath: string | null }
	| { kind: "conflict-artifact"; path: string; artifactPath: string; source: "disk" | "crdt" }
	| { kind: "preserved-remote-delete"; path: string }
	| { kind: "preserved-remote-rename"; path: string; oldPath: string }
	| { kind: "skipped-tombstone"; path: string };

export class HeadlessReconciler {
	constructor(
		private readonly deps: {
			fs: NodeVaultFilesystem;
			doc: HeadlessVaultDoc;
			deviceName: string;
			log?: (event: HeadlessLogEvent) => void;
		},
	) {}

	async reconcileOnce(state: HeadlessState): Promise<{ state: HeadlessState; stats: HeadlessReconcileStats }> {
		const nextState: HeadlessState = {
			...state,
			paths: { ...state.paths },
			lastReconcileAt: Date.now(),
		};
		const stats = emptyStats();

		let localFiles = await this.deps.fs.listMarkdownFiles();
		let localByPath = new Map(localFiles.map((file) => [file.path, file]));

		await this.applyRemoteRenames(localByPath, nextState, stats);
		localFiles = await this.deps.fs.listMarkdownFiles();
		localByPath = new Map(localFiles.map((file) => [file.path, file]));
		await this.ingestLocalFiles(localFiles, nextState, stats);
		await this.ingestLocalDeletes(localByPath, nextState, stats);
		await this.materializeRemoteFiles(nextState, stats);
		await this.applyRemoteDeletes(localByPath, nextState, stats);

		return { state: nextState, stats };
	}

	private async ingestLocalFiles(
		files: HeadlessMarkdownFile[],
		state: HeadlessState,
		stats: HeadlessReconcileStats,
	): Promise<void> {
		const tombstones = this.deps.doc.getTombstones();
		for (const file of files) {
			const path = normalizeVaultPath(file.path);
			if (!this.deps.fs.isSyncableMarkdownPath(path)) continue;
			if (this.isSuppressedRemoteRename(path, state)) continue;
			const diskHash = sha256Hex(file.content);
			const entry = this.deps.doc.getActiveEntry(path);
			const stateEntry = state.paths[path];

			if (!entry) {
				if (tombstones.has(path)) {
					stats.skippedTombstones++;
					this.deps.log?.({ kind: "skipped-tombstone", path });
					continue;
				}
				const created = this.deps.doc.ensureMarkdownFile(path, file.content, this.deps.deviceName, {
					reviveTombstone: false,
				});
				if (created) {
					stats.localCreated++;
					this.recordCleanState(state, file, sha256Hex(created.content), created.fileId);
					this.deps.log?.({ kind: "local-created", path });
				}
				continue;
			}

			const crdtHash = sha256Hex(entry.content);
			if (diskHash === crdtHash) {
				this.recordCleanState(state, file, crdtHash, entry.fileId);
				continue;
			}

			if (stateEntry && stateEntry.contentHash === diskHash) {
				// Disk has not changed since the last clean baseline. The remote
				// materialization pass will write CRDT content to disk.
				continue;
			}

			if (stateEntry && stateEntry.crdtHash === crdtHash) {
				this.deps.doc.replaceMarkdownContent(path, file.content, this.deps.deviceName);
				stats.localModified++;
				this.recordCleanState(state, file, diskHash, entry.fileId);
				this.deps.log?.({ kind: "local-modified", path });
				continue;
			}

			// Missing baseline or both changed. Prefer CRDT when there is no
			// baseline evidence; prefer disk when we know both sides changed.
			if (!stateEntry) {
				const artifactPath = await this.writeConflictArtifact(path, file.content, "disk");
				stats.conflicts++;
				this.deps.log?.({ kind: "conflict-artifact", path, artifactPath, source: "disk" });
				continue;
			}

			const artifactPath = await this.writeConflictArtifact(path, entry.content, "crdt");
			this.deps.doc.replaceMarkdownContent(path, file.content, this.deps.deviceName);
			stats.conflicts++;
			stats.localModified++;
			this.recordCleanState(state, file, diskHash, entry.fileId);
			this.deps.log?.({ kind: "conflict-artifact", path, artifactPath, source: "crdt" });
			this.deps.log?.({ kind: "local-modified", path });
		}
	}

	private async ingestLocalDeletes(
		localByPath: Map<string, HeadlessMarkdownFile>,
		state: HeadlessState,
		stats: HeadlessReconcileStats,
	): Promise<void> {
		const active = this.deps.doc.getActiveMarkdownEntries();
		for (const [path, stateEntry] of Object.entries(state.paths)) {
			if (!this.deps.fs.isSyncableMarkdownPath(path)) continue;
			if (stateEntry.renamedTo && !localByPath.has(path)) {
				delete state.paths[path];
				continue;
			}
			if (localByPath.has(path)) continue;
			const entry = active.get(path);
			if (!entry) continue;
			const crdtHash = sha256Hex(entry.content);
			if (stateEntry.crdtHash !== crdtHash) {
				const artifactPath = await this.writeConflictArtifact(path, entry.content, "crdt");
				stats.conflicts++;
				this.deps.log?.({ kind: "conflict-artifact", path, artifactPath, source: "crdt" });
			}
			if (this.deps.doc.tombstoneMarkdown(path, this.deps.deviceName)) {
				delete state.paths[path];
				stats.localDeleted++;
				this.deps.log?.({ kind: "local-deleted", path });
			}
		}
	}

	private async materializeRemoteFiles(
		state: HeadlessState,
		stats: HeadlessReconcileStats,
	): Promise<void> {
		const active = this.deps.doc.getActiveMarkdownEntries();
		for (const [path, entry] of active) {
			if (!this.deps.fs.isSyncableMarkdownPath(path)) continue;
			const crdtHash = sha256Hex(entry.content);
			const disk = await this.deps.fs.readMarkdown(path);
			if (!disk) {
				const stat = await this.deps.fs.writeMarkdown(path, entry.content);
				this.recordState(state, path, crdtHash, crdtHash, stat.mtime, stat.size, entry.fileId);
				stats.remoteCreated++;
				this.deps.log?.({ kind: "remote-created", path });
				continue;
			}

			const diskHash = sha256Hex(disk.content);
			if (diskHash === crdtHash) {
				this.recordCleanState(state, disk, crdtHash, entry.fileId);
				continue;
			}

			const stateEntry = state.paths[path];
			if (stateEntry && stateEntry.contentHash !== diskHash) {
				const artifactPath = await this.writeConflictArtifact(path, disk.content, "disk");
				stats.conflicts++;
				this.deps.log?.({ kind: "conflict-artifact", path, artifactPath, source: "disk" });
			}

			const stat = await this.deps.fs.writeMarkdown(path, entry.content);
			this.recordState(state, path, crdtHash, crdtHash, stat.mtime, stat.size, entry.fileId);
			stats.remoteModified++;
			this.deps.log?.({ kind: "remote-modified", path });
		}
	}

	private async applyRemoteRenames(
		localByPath: Map<string, HeadlessMarkdownFile>,
		state: HeadlessState,
		stats: HeadlessReconcileStats,
	): Promise<void> {
		const activeByFileId = new Map<string, { path: string; content: string; fileId: string }>();
		this.deps.doc.getActiveMarkdownEntries().forEach((entry) => {
			activeByFileId.set(entry.fileId, {
				path: entry.path,
				content: entry.content,
				fileId: entry.fileId,
			});
		});

		for (const [oldPath, stateEntry] of Object.entries(state.paths)) {
			if (!stateEntry.fileId) continue;
			const entry = activeByFileId.get(stateEntry.fileId);
			if (!entry || entry.path === oldPath) continue;
			if (!this.deps.fs.isSyncableMarkdownPath(oldPath) || !this.deps.fs.isSyncableMarkdownPath(entry.path)) {
				continue;
			}

			const oldLocal = localByPath.get(oldPath) ?? await this.deps.fs.readMarkdown(oldPath);
			const newLocal = localByPath.get(entry.path) ?? await this.deps.fs.readMarkdown(entry.path);
			const crdtHash = sha256Hex(entry.content);

			if (!newLocal) {
				const stat = await this.deps.fs.writeMarkdown(entry.path, entry.content);
				this.recordState(state, entry.path, crdtHash, crdtHash, stat.mtime, stat.size, entry.fileId);
				stats.remoteCreated++;
				this.deps.log?.({ kind: "remote-created", path: entry.path });
			}

			if (!oldLocal) {
				delete state.paths[oldPath];
				continue;
			}

			if (stateEntry.renamedTo === entry.path) {
				continue;
			}

			const oldDiskHash = sha256Hex(oldLocal.content);
			if (oldDiskHash !== stateEntry.contentHash) {
				state.paths[oldPath] = {
					...stateEntry,
					contentHash: oldDiskHash,
					mtime: oldLocal.stat.mtime,
					size: oldLocal.stat.size,
					updatedAt: Date.now(),
					renamedTo: entry.path,
				};
				stats.preservedRenames++;
				this.deps.log?.({ kind: "preserved-remote-rename", path: entry.path, oldPath });
				continue;
			}

			const trashPath = await this.deps.fs.moveToTrash(oldPath, "remote-rename");
			delete state.paths[oldPath];
			stats.remoteRenamed++;
			this.deps.log?.({ kind: "remote-renamed", path: entry.path, oldPath, trashPath });
		}
	}

	private async applyRemoteDeletes(
		localByPath: Map<string, HeadlessMarkdownFile>,
		state: HeadlessState,
		stats: HeadlessReconcileStats,
	): Promise<void> {
		const active = this.deps.doc.getActiveMarkdownEntries();
		const tombstones = this.deps.doc.getTombstones();

		for (const [path, stateEntry] of Object.entries(state.paths)) {
			if (!this.deps.fs.isSyncableMarkdownPath(path)) continue;
			if (active.has(path) || !tombstones.has(path)) continue;
			const local = localByPath.get(path) ?? await this.deps.fs.readMarkdown(path);
			if (!local) {
				delete state.paths[path];
				continue;
			}
			const diskHash = sha256Hex(local.content);
			if (diskHash !== stateEntry.contentHash) {
				stats.preservedDeletes++;
				this.deps.log?.({ kind: "preserved-remote-delete", path });
				continue;
			}
			const trashPath = await this.deps.fs.moveToTrash(path, "remote-delete");
			delete state.paths[path];
			stats.remoteDeleted++;
			this.deps.log?.({ kind: "remote-deleted", path, trashPath });
		}
	}

	private async writeConflictArtifact(
		path: string,
		content: string,
		source: "disk" | "crdt",
	): Promise<string> {
		const normalized = normalizeVaultPath(path);
		const dir = dirname(normalized);
		const file = basename(normalized, ".md");
		const stamp = new Date().toISOString().replace(/:/g, "-");
		const nonce = randomBytes(4).toString("hex");
		const safeDevice = this.deps.deviceName.replace(/[\\/:\0]/g, "_");
		const name = `${file} (KAOS conflict - ${source} from ${safeDevice} ${stamp} ${nonce}).md`;
		const artifactPath = normalizeVaultPath(dir === "." ? name : `${dir}/${name}`);
		await this.deps.fs.writeMarkdown(artifactPath, content);
		return artifactPath;
	}

	private isSuppressedRemoteRename(path: string, state: HeadlessState): boolean {
		const entry = state.paths[normalizeVaultPath(path)];
		if (!entry?.renamedTo) return false;
		return this.deps.doc.getActiveEntry(entry.renamedTo) !== null;
	}

	private recordCleanState(
		state: HeadlessState,
		file: HeadlessMarkdownFile,
		crdtHash: string,
		fileId?: string,
	): void {
		const diskHash = sha256Hex(file.content);
		this.recordState(state, file.path, diskHash, crdtHash, file.stat.mtime, file.stat.size, fileId);
	}

	private recordState(
		state: HeadlessState,
		path: string,
		contentHash: string,
		crdtHash: string,
		mtime: number,
		size: number,
		fileId?: string,
	): void {
		const normalized = normalizeVaultPath(path);
		const entry: HeadlessPathState = {
			...(fileId ? { fileId } : {}),
			contentHash,
			crdtHash,
			mtime,
			size,
			updatedAt: Date.now(),
		};
		state.paths[normalized] = entry;
	}
}

function emptyStats(): HeadlessReconcileStats {
	return {
		localCreated: 0,
		localModified: 0,
		localDeleted: 0,
		remoteCreated: 0,
		remoteModified: 0,
		remoteDeleted: 0,
		remoteRenamed: 0,
		conflicts: 0,
		preservedDeletes: 0,
		preservedRenames: 0,
		skippedTombstones: 0,
	};
}
