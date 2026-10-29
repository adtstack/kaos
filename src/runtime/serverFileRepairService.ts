import * as Y from "yjs";
import { TFile, type App } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { VaultSync } from "../sync/vaultSync";
import type { BlobSyncManager } from "../sync/blobSync";
import { ServerFileClient, type ServerFileVersion } from "../sync/serverFileClient";
import { getOpenFileViewsForPath } from "../utils/openFileViews";
import { sameBlobRef, type BlobRef, type FileMeta } from "../types";
import { createNestedActiveMeta, decodeFileMeta, isFileMetaDeletedValue } from "../sync/fileMeta";
import { ORIGIN_RESTORE } from "../sync/origins";

type Journal = { protocol: 1; path: string; scope: string; resumeSync: boolean; originalHash?: string; phase: "prepared" | "commit-pending" | "projecting" | "complete" };
type Pane = { view: unknown; read: () => string; content: string };

async function digest(data: ArrayBuffer): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function scope(settings: VaultSyncSettings, localDeviceId: string | null): Promise<string> {
	if (!localDeviceId) throw new Error("Device-local identity is unavailable. Server file repair remains paused.");
	return digest(new TextEncoder().encode(JSON.stringify([settings.host.replace(/\/$/, ""), settings.vaultId, localDeviceId])).buffer as ArrayBuffer);
}
function root(app: App): string { return `${app.vault.configDir}/plugins/kaos/restore-backups/server-file-repair`; }
async function journals(app: App, settings: VaultSyncSettings, localDeviceId: string | null): Promise<Array<{ file: string; entry: Journal }>> {
	const base = root(app);
	if (!await app.vault.adapter.exists(base)) return [];
	const expectedScope = await scope(settings, localDeviceId);
	const result: Array<{ file: string; entry: Journal }> = [];
	for (const folder of (await app.vault.adapter.list(base)).folders) {
		const file = `${folder}/record.json`;
		if (!await app.vault.adapter.exists(file)) continue;
		const entry = JSON.parse(await app.vault.adapter.read(file)) as Journal;
		if (entry.protocol !== 1 || typeof entry.path !== "string" || entry.path.startsWith("/")
			|| entry.path.length > 4096 || entry.path.includes("\\") || [...entry.path].some((character) => character.charCodeAt(0) < 32)
			|| typeof entry.scope !== "string" || typeof entry.resumeSync !== "boolean"
			|| entry.path.split("/").some((part) => !part || part === "." || part === "..")
			|| !["prepared", "commit-pending", "projecting", "complete"].includes(entry.phase)) throw new Error("Invalid server repair journal. Inspect restore-backups before starting sync.");
		if (entry.scope === expectedScope) result.push({ file, entry });
	}
	return result;
}

export async function readPendingServerRepairPaths(app: App, settings: VaultSyncSettings, localDeviceId: string | null): Promise<string[]> {
	const pending = (await journals(app, settings, localDeviceId)).filter(({ entry }) => entry.phase === "commit-pending" || entry.phase === "projecting");
	for (const { file, entry } of pending) {
		// A crash between the Blob backup rename and creation can leave a vacancy.
		// Restore ONLY into an absent path so the regular file command remains usable.
		if (!entry.path.startsWith(`${app.vault.configDir}/`) && app.vault.getAbstractFileByPath(entry.path) === null
			&& !await app.vault.adapter.exists(entry.path)) {
			const data = await app.vault.adapter.readBinary(`${file.substring(0, file.lastIndexOf("/"))}/original.bin`);
			if (!entry.originalHash || await digest(data) !== entry.originalHash) throw new Error("Interrupted repair backup could not be verified.");
			if (app.vault.getAbstractFileByPath(entry.path) === null && !await app.vault.adapter.exists(entry.path)) await app.vault.createBinary(entry.path, data);
		}
	}
	return pending.map(({ entry }) => entry.path);
}

function getStoredSchemaVersion(doc: Y.Doc): number | null {
	const stored = doc.getMap("sys").get("schemaVersion");
	if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 0) return null;
	return stored;
}

function usesV2MetaPathModel(doc: Y.Doc): boolean {
	const version = getStoredSchemaVersion(doc);
	return version !== null && version >= 2;
}

function usesNestedMetaModel(doc: Y.Doc): boolean {
	const version = getStoredSchemaVersion(doc);
	return version !== null && version >= 3;
}

function applyLightweightTextRestore(
	liveDoc: Y.Doc,
	path: string,
	fileId: string,
	content: string,
	device: string | null,
): void {
	const liveUsesV2 = usesV2MetaPathModel(liveDoc);
	const liveUsesNestedMeta = usesNestedMetaModel(liveDoc);
	liveDoc.transact(() => {
		const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
		const livePathToId = liveDoc.getMap<string>("pathToId");
		const liveMeta = liveDoc.getMap<unknown>("meta");
		let liveText = liveIdToText.get(fileId);
		if (!liveText) {
			liveText = new Y.Text();
			liveIdToText.set(fileId, liveText);
		}
		if (liveText.toJSON() !== content) {
			liveText.delete(0, liveText.length);
			if (content.length > 0) {
				liveText.insert(0, content);
			}
		}
		if (!liveUsesV2) {
			livePathToId.set(path, fileId);
		}
		const staleTombstones: string[] = [];
		liveMeta.forEach((entry, id) => {
			const decoded = decodeFileMeta(entry);
			if (id !== fileId && decoded?.path === path && isFileMetaDeletedValue(entry)) {
				staleTombstones.push(id);
			}
		});
		for (const staleId of staleTombstones) {
			liveMeta.delete(staleId);
		}
		liveMeta.set(
			fileId,
			liveUsesNestedMeta
				? createNestedActiveMeta(path, Date.now(), device ?? undefined)
				: ({
					path,
					deleted: undefined,
					deletedAt: undefined,
					mtime: Date.now(),
					device: device ?? undefined,
				} satisfies FileMeta),
		);
	}, ORIGIN_RESTORE);
}

function applyLightweightBlobRestore(
	liveDoc: Y.Doc,
	path: string,
	ref: BlobRef,
): void {
	liveDoc.transact(() => {
		liveDoc.getMap("pathToBlob").set(path, ref);
	}, ORIGIN_RESTORE);
}

interface RepairDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getVaultSync(): VaultSync | null;
	getBlobSync(): BlobSyncManager | null;
	getLocalDeviceId(): string | null;
	isPathSyncable(path: string): boolean;
	resumeSync?(): void;
	setPending(path: string, pending: boolean): void;
	setProjecting(path: string, projecting: boolean): void;
	projectText(path: string, file: TFile, diskContent: string, serverContent: string, isCurrent: () => boolean): Promise<{ ok: boolean; reason?: string }>;
}

/** Single-file recovery without requiring a working WebSocket sync session. */
export class ServerFileRepairService {
	constructor(private readonly deps: RepairDeps) {}
	async execute(version: ServerFileVersion, file: TFile): Promise<string> {
		const { app } = this.deps;
		const sync = this.deps.getVaultSync();
		if (!sync) throw new Error("Sync is not initialized yet.");
		if (version.kind !== "text" && version.kind !== "blob") throw new Error(`Server file is ${version.kind}.`);
		const settings = { ...this.deps.getSettings() };
		const localDeviceId = this.deps.getLocalDeviceId();
		const journalScope = await scope(settings, localDeviceId);
		if (sync.sys.get("schemaVersion") !== version.schema) throw new Error("Local and server document schemas differ.");
		const path = version.path;
		if (!this.deps.isPathSyncable(path)) throw new Error("File is excluded from sync.");
		const views = getOpenFileViewsForPath(app.workspace, path);
		if (version.kind === "blob" && views.length > 0) throw new Error("Close this attachment or canvas before restoring it, then run Restore from server again.");
		const panes: Pane[] = [];
		for (const view of views) {
			const editor = (view as { editor?: { getValue(): string } }).editor;
			if (editor) panes.push({ view, read: () => editor.getValue(), content: editor.getValue() });
			else if (version.kind === "text") throw new Error("Close this file view before restoring it so its unsaved contents can be protected.");
		}
		const localText = sync.getTextForPath(path);
		const localContent = localText?.toJSON() ?? null;
		const stat = { mtime: file.stat.mtime, size: file.stat.size };
		const assertRuntime = () => {
			const currentSettings = this.deps.getSettings();
			if (this.deps.getVaultSync() !== sync || currentSettings.host !== settings.host || currentSettings.vaultId !== settings.vaultId
				|| this.deps.getLocalDeviceId() !== localDeviceId || !this.deps.isPathSyncable(path)) throw new Error("Sync runtime or file scope changed during repair.");
		};
		const assertCandidate = () => {
			assertRuntime();
			if (app.vault.getAbstractFileByPath(path) !== file || file.path !== path
				|| file.stat.mtime !== stat.mtime || file.stat.size !== stat.size
				|| sync.getTextForPath(path) !== localText || (localText?.toJSON() ?? null) !== localContent
				|| panes.some((pane) => pane.read() !== pane.content)
				|| getOpenFileViewsForPath(app.workspace, path).some((view) => !views.includes(view))) throw new Error("Local file or editor changed during repair. Retry after editing has stopped.");
		};
		const id = `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
		const directory = `${root(app)}/${id}`;
		const ensureDirectory = async (dir: string): Promise<void> => {
			if (await app.vault.adapter.exists(dir)) return;
			const parent = dir.substring(0, dir.lastIndexOf("/"));
			if (parent) await ensureDirectory(parent);
			if (!await app.vault.adapter.exists(dir)) await app.vault.adapter.mkdir(dir);
		};
		const earlier = await journals(app, settings, localDeviceId);
		const reconnect = sync.connectionWanted || sync.provider.shouldConnect
			|| earlier.some(({ entry }) => entry.path === path && entry.phase !== "complete" && entry.resumeSync);
		const record: Journal = { protocol: 1, path, scope: journalScope, resumeSync: reconnect, phase: "prepared" };
		const persist = async (phase: Journal["phase"]): Promise<void> => {
			record.phase = phase;
			await app.vault.adapter.write(`${directory}/record.json`, JSON.stringify(record));
		};
		// Pause both socket and broadcast-channel exchange before capturing pending updates.
		sync.provider.disconnect();
		let mayHaveCommitted = false;
		let completed = false;
		try {
			assertCandidate();
			const original = await app.vault.readBinary(file);
			const originalHash = await digest(original);
			record.originalHash = originalHash;
			assertCandidate();
			await ensureDirectory(directory);
			await app.vault.adapter.writeBinary(`${directory}/original.bin`, original);
			await app.vault.adapter.writeBinary(`${directory}/local-crdt.bin`, Y.encodeStateAsUpdate(sync.ydoc).buffer as ArrayBuffer);
			await app.vault.adapter.write(`${directory}/server.json`, JSON.stringify(version));
			await app.vault.adapter.write(`${directory}/local-text.json`, JSON.stringify({ crdt: localContent, editors: panes.map((pane) => pane.content) }));
			if (await digest(await app.vault.adapter.readBinary(`${directory}/original.bin`)) !== originalHash) throw new Error("Safety backup verification failed.");
			await persist("prepared");
			const applyLightweight = async () => {
				assertCandidate();
				if (version.kind === "text") {
					applyLightweightTextRestore(sync.ydoc, path, version.fileId, version.content, this.deps.getLocalDeviceId());
				} else if (version.kind === "blob") {
					applyLightweightBlobRestore(sync.ydoc, path, version.ref);
				}
				await app.vault.adapter.writeBinary(`${directory}/server-crdt.bin`, Y.encodeStateAsUpdate(sync.ydoc).buffer as ArrayBuffer);
				if ((version.kind === "text" && sync.getTextForPath(path)?.toJSON() !== version.content)
					|| (version.kind === "blob" && !sameBlobRef(sync.getBlobRef(path), version.ref))) {
					throw new Error("Server content did not settle in the local sync state.");
				}
				await persist("projecting");
			};
			const commitRemote = async () => {
				assertCandidate();
				if (await digest(await app.vault.readBinary(file)) !== originalHash) throw new Error("Local file changed before repair.");
				await persist("commit-pending");
				this.deps.setPending(path, true);
				assertCandidate();
				mayHaveCommitted = true;
				if (version.oversized) {
					await applyLightweight();
					return;
				}
				try {
					const update = await new ServerFileClient(settings).commit(version, sync.ydoc);
					assertCandidate();
					if (await digest(await app.vault.readBinary(file)) !== originalHash) throw new Error("Local file changed while the server was repairing it.");
					assertCandidate();
					await app.vault.adapter.writeBinary(`${directory}/server-crdt.bin`, update.buffer as ArrayBuffer);
					assertCandidate();
					// Target projection is locked; unrelated remote changes retain normal origin handling.
					Y.applyUpdate(sync.ydoc, update, sync.provider);
					if ((version.kind === "text" && sync.getTextForPath(path)?.toJSON() !== version.content)
						|| (version.kind === "blob" && !sameBlobRef(sync.getBlobRef(path), version.ref))) throw new Error("Server content did not settle in the local sync state.");
					await persist("projecting");
				} catch (commitError: unknown) {
					const message = commitError instanceof Error ? commitError.message : String(commitError);
					if (message.includes("413") || message.includes("exceeds the server file repair limit")) {
						await applyLightweight();
						return;
					}
					throw commitError;
				}
			};
			if (version.kind === "blob") {
				const blobSync = this.deps.getBlobSync();
				if (!blobSync) throw new Error("Attachment sync is not initialized.");
				await blobSync.repairFileFromServer(path, version.ref, commitRemote, () => {
					try { assertRuntime(); return getOpenFileViewsForPath(app.workspace, path).length === 0; } catch { return false; }
				});
			} else {
				await commitRemote();
				this.deps.setProjecting(path, true);
				try {
					const result = await this.deps.projectText(path, file, new TextDecoder().decode(original), version.content,
						() => { try { assertRuntime(); return true; } catch { return false; } });
					if (!result.ok) throw new Error(`Text repair did not settle (${result.reason ?? "unknown"}).`);
				} finally { this.deps.setProjecting(path, false); }
				if (await app.vault.read(file) !== version.content || sync.getTextForPath(path)?.toJSON() !== version.content
					|| panes.some((pane) => pane.read() !== version.content)) throw new Error("Restored text or open editor does not match the server version.");
			}
			assertRuntime();
			const final = await new ServerFileClient(settings).inspect(path);
			if (final.kind !== version.kind || (version.kind === "text" && (final.kind !== "text" || final.fileId !== version.fileId || final.content !== version.content))
				|| (version.kind === "blob" && (final.kind !== "blob" || !sameBlobRef(final.ref, version.ref)))) throw new Error("Server file changed during repair. Keep the safety backup and review again.");
			const installed = app.vault.getAbstractFileByPath(path);
			if (!(installed instanceof TFile)) throw new Error("Restored file is missing.");
			const installedHash = await digest(await app.vault.readBinary(installed));
			const expectedHash = version.kind === "blob" ? version.ref.hash
				: await digest(new TextEncoder().encode(version.content).buffer as ArrayBuffer);
			if (installedHash !== expectedHash || (version.kind === "text" && panes.some((pane) => pane.read() !== version.content))) throw new Error("Restored file changed before repair completed.");
			const installedStat = { mtime: installed.stat.mtime, size: installed.stat.size };
			const assertInstalled = () => {
				assertRuntime();
				if (app.vault.getAbstractFileByPath(path) !== installed || installed.path !== path
					|| installed.stat.mtime !== installedStat.mtime || installed.stat.size !== installedStat.size
					|| (version.kind === "text" && (sync.getTextForPath(path)?.toJSON() !== version.content || panes.some((pane) => pane.read() !== version.content)))
					|| (version.kind === "blob" && (!sameBlobRef(sync.getBlobRef(path), version.ref) || getOpenFileViewsForPath(app.workspace, path).length > 0))) throw new Error("Restored file changed before repair completed.");
			};
			assertInstalled();
			// Complete older interrupted attempts only after the new repair has verified the file.
			for (const old of await journals(app, settings, localDeviceId)) {
				if (old.entry.path === path && old.file !== `${directory}/record.json`) {
					await app.vault.adapter.write(old.file, JSON.stringify({ ...old.entry, phase: "complete" }));
				}
			}
			await persist("complete");
			assertInstalled();
			this.deps.setPending(path, false);
			completed = true;
			return directory;
		} catch (error) {
			if (mayHaveCommitted) {
				this.deps.setPending(path, true);
				await persist("projecting");
			}
			throw new Error(`${error instanceof Error ? error.message : String(error)}${mayHaveCommitted ? ` Sync remains paused until an explicit repair retry completes. Backup: ${directory}` : ""}`);
		} finally {
			this.deps.setProjecting(path, false);
			if (this.deps.getVaultSync() === sync && reconnect && (!mayHaveCommitted || completed)) {
				if (this.deps.resumeSync) this.deps.resumeSync();
				else void sync.provider.connect().catch(() => undefined);
			}
		}
	}
}
