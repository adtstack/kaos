import { App, Notice, TFile, normalizePath } from "obsidian";
import { BlobSyncManager } from "../sync/blobSync";
import { DiskMirror } from "../sync/diskMirror";
import {
	diffSnapshot,
	downloadSnapshot,
	listSnapshots as fetchSnapshotList,
	getSnapshotStatus,
	requestDailySnapshot,
	requestSnapshotNow,
	requestPrune,
	restoreFromSnapshot,
	normalizeSnapshotUnchanged,
	type SnapshotIndex,
} from "../sync/snapshotClient";
import {
	cleanupFileHistoryStorage,
	downloadFileHistoryContent,
	getFileHistoryStorageStatus,
	getLiveHashForFileVersion,
	listFileHistoryManifests,
	repairFileHistoryStorage,
	requestFileHistoryPointMaybe,
	restoreRecoveryVersionToLiveDoc,
	type FileHistoryManifestIndex,
	type FileHistoryPointResult,
} from "../sync/recoverySnapshotClient";
import { VaultSync } from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext } from "../observability/traceContext";
import { formatUnknown } from "../utils/format";
import { SnapshotDiffModal, SnapshotListModal } from "./snapshotModals";
import { RecoveryHistoryModal, type RecoveryHistoryFileItem } from "./recoveryHistoryModals";
import type {
	DashboardRecentChange,
	DashboardRecentChanges,
	DashboardRecoveryStorageStatus,
	DashboardSnapshotStatus,
} from "../dashboard/dashboardTypes";
import { DashboardSnapshotCache } from "./dashboardSnapshotCache";

const RECOVERY_SNAPSHOT_PENDING_RETRY_MS = 5 * 60 * 1000;

interface SnapshotServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getVaultSync(): VaultSync | null;
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getServerSupportsSnapshots(): boolean;
	log(message: string): void;
	onEditorsNeedReconcile(reason: string): void;
}

export class SnapshotService {
	private recoverySnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private recoverySnapshotInFlight = false;
	private readonly dashboardSnapshotCache = new DashboardSnapshotCache();

	constructor(private readonly deps: SnapshotServiceDeps) {}

	async getDashboardSnapshotStatus(): Promise<DashboardSnapshotStatus> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			return { status: "unavailable", message: "Sync not initialized." };
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			return { status: "unavailable", message: "Snapshot storage is unavailable." };
		}
		if (!vaultSync.connected) {
			return { status: "offline", message: "Not connected to server." };
		}
		try {
			return await this.dashboardSnapshotCache.get("snapshot-status", async () => ({
				status: "ready",
				summary: await getSnapshotStatus(
					this.deps.getSettings(),
					this.deps.getTraceHttpContext(),
				),
			}));
		} catch (err) {
			return { status: "error", message: formatUnknown(err) };
		}
	}

	async getDashboardRecentChanges(
		manifestLimit = 8,
		changeLimit = 80,
	): Promise<DashboardRecentChanges> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			return { status: "unavailable", message: "Sync not initialized." };
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			return { status: "unavailable", message: "File history is unavailable." };
		}
		if (!vaultSync.connected) {
			return { status: "offline", message: "Not connected to server." };
		}

		try {
			return await this.dashboardSnapshotCache.get(`recent-changes:${manifestLimit}:${changeLimit}`, async () => {
				const settings = this.deps.getSettings();
				const listed = await listFileHistoryManifests(
					settings,
					this.deps.getTraceHttpContext(),
					manifestLimit,
				);
				const changes: DashboardRecentChange[] = [];
				for (const index of listed.manifests.slice(0, manifestLimit)) {
					for (const entry of index.changedEntries) {
						changes.push({
							manifestId: index.manifestId,
							snapshotKind: index.kind,
							createdAt: index.createdAt,
							fileId: entry.fileId,
							changeKind: entry.kind,
							path: entry.newPath ?? entry.path,
							oldPath: entry.oldPath ?? null,
							newPath: entry.newPath ?? null,
							device: entry.device ?? null,
							size: entry.size ?? null,
							contentHash: entry.contentHash ?? null,
						});
					}
				}
				changes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
				return {
					status: "ready",
					manifestCount: listed.manifests.length,
					limited: listed.limited,
					changes: changes.slice(0, changeLimit),
				};
			});
		} catch (err) {
			return { status: "error", message: formatUnknown(err) };
		}
	}

	async getDashboardRecoveryStorageStatus(): Promise<DashboardRecoveryStorageStatus> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			return { status: "unavailable", message: "Sync not initialized." };
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			return { status: "unavailable", message: "File history storage is unavailable." };
		}
		if (!vaultSync.connected) {
			return { status: "offline", message: "Not connected to server." };
		}
		try {
			return await this.dashboardSnapshotCache.get("recovery-storage-status", async () => ({
				status: "ready",
				report: await getFileHistoryStorageStatus(
					this.deps.getSettings(),
					this.deps.getTraceHttpContext(),
				),
			}));
		} catch (err) {
			return { status: "error", message: formatUnknown(err) };
		}
	}

	/**
	 * Request the daily snapshot from the server.
	 * Silent noop if R2 isn't configured or snapshot already taken today.
	 */
	async triggerDailySnapshot(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			return;
		}

		const settings = this.deps.getSettings();
		try {
			const result = await requestDailySnapshot(
				settings,
				settings.deviceName,
				this.deps.getTraceHttpContext(),
			);
			if (result.status === "created") {
				this.invalidateDashboardSnapshotCache();
				this.deps.log(`Daily snapshot created: ${result.snapshotId}`);
			} else if (result.status === "noop") {
				this.deps.log(`Daily snapshot: ${result.reason ?? "no changes"}`);
			} else {
				this.deps.log(`Daily snapshot: ${result.reason ?? "unavailable"}`);
			}
		} catch (err) {
			// Don't spam the user; snapshot failure is non-critical.
			if (this.logTransientSnapshotNetworkError(err, "Daily snapshot")) return;
			if (this.logSnapshotBackendAction(err, "Daily snapshots")) return;
			console.warn("[kaos] Daily snapshot failed:", err);
		}
	}

	/**
	 * Request a file history point. Silent noop when unavailable or unchanged.
	 */
	async triggerRecoverySnapshot(forceFull = false): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			return;
		}
		if (this.recoverySnapshotInFlight) {
			return;
		}
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync?.connected || !vaultSync.providerSynced) {
			return;
		}

		this.recoverySnapshotInFlight = true;
		try {
			const result = await this.requestFileHistoryPoint(forceFull);
			if (result.status === "created") {
				this.invalidateDashboardSnapshotCache();
				const changed = typeof result.index?.changedCount === "number"
					? ` (${result.index.changedCount} changed)`
					: "";
				this.deps.log(`File history point created: ${result.manifestId}${changed}`);
			} else if (result.status === "noop") {
				this.deps.log(`File history point: ${result.reason ?? "no changes"}`);
			} else if (result.status === "pending") {
				this.deps.log(this.formatPendingFileHistoryPoint(result));
				this.scheduleRecoverySnapshotRetry(forceFull);
			} else {
				this.deps.log(`File history point: ${result.reason ?? "unavailable"}`);
			}
		} catch (err) {
			if (this.logTransientSnapshotNetworkError(err, "File history point")) return;
			if (this.logSnapshotBackendAction(err, "File history")) return;
			console.warn("[kaos] File history point failed:", err);
		} finally {
			this.recoverySnapshotInFlight = false;
		}
	}

	async createFileHistoryPoint(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("File history");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot create file history point.");
			return;
		}

		new Notice("Creating file history point...");
		try {
			const result = await this.requestFileHistoryPoint(true);
			if (result.status === "created") {
				this.invalidateDashboardSnapshotCache();
				const changed = typeof result.index?.changedCount === "number"
					? `${result.index.changedCount} changed file(s)`
					: "changes recorded";
				new Notice(`File history point created: ${changed}.`);
			} else if (result.status === "noop") {
				new Notice(result.reason ?? "No file changes since the latest file history point.");
			} else if (result.status === "pending") {
				new Notice(this.formatPendingFileHistoryPoint(result));
				this.scheduleRecoverySnapshotRetry(false);
			} else {
				new Notice(`File history unavailable: ${result.reason ?? "server storage unavailable"}`);
			}
		} catch (err) {
			this.showSnapshotFailure("File history point failed", "File history", err);
		}
	}

	private async requestFileHistoryPoint(forceFull: boolean): Promise<FileHistoryPointResult> {
		const settings = this.deps.getSettings();
		return await requestFileHistoryPointMaybe(
			settings,
			settings.deviceName,
			this.deps.getTraceHttpContext(),
			forceFull,
		);
	}

	private formatPendingFileHistoryPoint(result: FileHistoryPointResult): string {
		const pending = result.pending;
		if (!pending) return result.reason ?? "File history content upload is still in progress";
		return `File history upload in progress: ${pending.uploadedContentCount}/${pending.totalContentCount} content object(s) uploaded.`;
	}

	private scheduleRecoverySnapshotRetry(forceFull: boolean): void {
		if (this.recoverySnapshotRetryTimer) return;
		this.recoverySnapshotRetryTimer = setTimeout(() => {
			this.recoverySnapshotRetryTimer = null;
			void this.triggerRecoverySnapshot(forceFull);
		}, RECOVERY_SNAPSHOT_PENDING_RETRY_MS);
	}

	async takeSnapshotNow(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("Vault snapshots");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot create vault snapshot.");
			return;
		}

		const settings = this.deps.getSettings();
		new Notice("Creating vault snapshot...");
		try {
			const result = await requestSnapshotNow(
				settings,
				settings.deviceName,
				this.deps.getTraceHttpContext(),
			);
			if (result.status === "created" && result.index) {
				this.invalidateDashboardSnapshotCache();
				// Handle both new and old server response field names
				const identical = normalizeSnapshotUnchanged(result);
				const unchangedNote = identical
					? " (note: identical to latest snapshot)"
					: "";
				new Notice(
					`Vault snapshot created: ${result.index.markdownFileCount} notes, ` +
					`${result.index.blobFileCount} attachments ` +
					`(${Math.round(result.index.crdtSizeBytes / 1024)} KB)${unchangedNote}`,
				);
			} else if (result.status === "unavailable") {
				const deploymentMessage = snapshotBackendActionMessage(result.reason ?? "", "Vault snapshots");
				new Notice(deploymentMessage ?? `Vault snapshot unavailable: ${result.reason ?? "R2 not configured"}`);
			} else {
				if (result.status === "created") {
					this.invalidateDashboardSnapshotCache();
				}
				new Notice("Vault snapshot created.");
			}
		} catch (err) {
			this.showSnapshotFailure("Vault snapshot failed", "Vault snapshots", err);
		}
	}

	/**
	 * Show a list of available vault snapshots and let the user pick one to diff/restore.
	 */
	async showSnapshotList(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("Vault snapshots");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot browse vault snapshots.");
			return;
		}

		new Notice("Loading vault snapshots...");

		try {
			const snapshots = await fetchSnapshotList(
				this.deps.getSettings(),
				this.deps.getTraceHttpContext(),
			);

			if (snapshots.length === 0) {
				new Notice("No vault snapshots found. Take a vault snapshot first.");
				return;
			}

			new SnapshotListModal(this.deps.app, snapshots, async (selected) => {
				await this.showSnapshotDiff(selected);
			}).open();
		} catch (err) {
			this.showSnapshotFailure("Failed to list vault snapshots", "Vault snapshots", err);
		}
	}

	async showRecoveryHistory(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("File history");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot browse file history.");
			return;
		}

		new Notice("Loading file history...");

		try {
			const settings = this.deps.getSettings();
			const listed = await listFileHistoryManifests(settings, this.deps.getTraceHttpContext(), 50);
			if (listed.manifests.length === 0) {
				new Notice("No file history found yet. Create a file history point after the next file change.");
				return;
			}

			const manifests: FileHistoryManifestIndex[] = listed.manifests;

			new RecoveryHistoryModal(this.deps.app, manifests, {
				downloadContent: async (hash) => await downloadFileHistoryContent(
					settings,
					hash,
					this.deps.getTraceHttpContext(),
				),
				restoreVersion: async (item) => {
					await this.restoreRecoveryHistoryItem(item);
				},
			}).open();
			void this.triggerRecoverySnapshot();
		} catch (err) {
			this.showSnapshotFailure("Failed to load file history", "File history", err);
		}
	}

	/**
	 * Run server-side retention pruning. Exposed as a user command.
	 */
	async pruneSnapshots(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("Vault snapshots");
			return;
		}
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync?.connected) {
			new Notice("Not connected to server.");
			return;
		}

		new Notice("Running vault snapshot cleanup...");
		try {
			const result = await requestPrune(
				this.deps.getSettings(),
				this.deps.getTraceHttpContext(),
			);
			if (result.pruned === 0) {
				new Notice("No vault snapshots to prune — retention policy already satisfied.");
			} else {
				new Notice(
					`Vault snapshot cleanup complete: ${result.pruned} old snapshot(s) removed, ${result.kept} retained.` +
					(result.failed > 0 ? ` (${result.failed} failed)` : ""),
				);
			}
			this.deps.log(`Vault snapshot prune: kept=${result.kept} pruned=${result.pruned} failed=${result.failed}`);
			this.invalidateDashboardSnapshotCache();
		} catch (err) {
			this.showSnapshotFailure("Vault snapshot cleanup failed", "Vault snapshots", err);
		}
	}

	async cleanupFileHistory(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("File history");
			return;
		}
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync?.connected) {
			new Notice("Not connected to server.");
			return;
		}

		new Notice("Running file history cleanup...");
		try {
			const result = await cleanupFileHistoryStorage(
				this.deps.getSettings(),
				this.deps.getTraceHttpContext(),
			);
			new Notice(
				`File history cleanup complete: ${result.prunedManifests} point(s), ` +
				`${result.contentDeleted} orphan content object(s) removed.` +
				(result.failed > 0 ? ` (${result.failed} failed)` : ""),
			);
			this.deps.log(
				`File history cleanup: kept=${result.kept} pruned=${result.prunedManifests} ` +
				`contentDeleted=${result.contentDeleted} failed=${result.failed}`,
			);
			this.invalidateDashboardSnapshotCache();
		} catch (err) {
			this.showSnapshotFailure("File history cleanup failed", "File history", err);
		}
	}

	async repairFileHistoryStorage(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			this.notifySnapshotStorageUnavailable("File history");
			return;
		}
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync?.connected) {
			new Notice("Not connected to server.");
			return;
		}

		new Notice("Checking file history storage...");
		try {
			const report = await repairFileHistoryStorage(
				this.deps.getSettings(),
				this.deps.getTraceHttpContext(),
			);
			const repaired = report.repairs.filter((repair) => repair.success).length;
			const remaining = report.issues.filter((issue) => !issue.repaired).length;
			new Notice(
				report.status === "degraded"
					? `File history storage needs attention: ${remaining} issue(s) remaining.`
					: `File history storage ${report.status}. ${repaired} repair(s) applied.`,
				8000,
			);
			this.invalidateDashboardSnapshotCache();
		} catch (err) {
			this.showSnapshotFailure("File history storage check failed", "File history", err);
		}
	}

	/**
	 * Download a snapshot, compute diff against current CRDT, and show the restore UI.
	 */
	private async showSnapshotDiff(snapshot: SnapshotIndex): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		new Notice("Downloading snapshot...");

		try {
			const snapshotDoc = await downloadSnapshot(
				this.deps.getSettings(),
				snapshot,
				this.deps.getTraceHttpContext(),
			);
			const diff = diffSnapshot(snapshotDoc, vaultSync.ydoc);

			let destroyed = false;
			const cleanup = () => {
				if (!destroyed) {
					destroyed = true;
					snapshotDoc.destroy();
				}
			};

			new SnapshotDiffModal(
				this.deps.app,
				snapshot,
				diff,
				async (markdownPaths, blobPaths) => {
					const liveVaultSync = this.deps.getVaultSync();
					if (!liveVaultSync) return;

					const backupDir = normalizePath(
						`${this.deps.app.vault.configDir}/plugins/kaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
					);
					let backedUp = 0;
					for (const path of markdownPaths) {
						try {
							const file = this.deps.app.vault.getAbstractFileByPath(path);
							if (file instanceof TFile) {
								const content = await this.deps.app.vault.read(file);
								const backupPath = `${backupDir}/${path}`;
								const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
								if (parentDir && !this.deps.app.vault.getAbstractFileByPath(parentDir)) {
									await this.deps.app.vault.createFolder(parentDir);
								}
								await this.deps.app.vault.create(backupPath, content);
								backedUp++;
							}
						} catch (err) {
							// Non-fatal: file might not exist on disk (undelete case).
							this.deps.log(`Backup skipped for "${path}": ${formatUnknown(err)}`);
						}
					}
					if (backedUp > 0) {
						this.deps.log(`Pre-restore backup: ${backedUp} files saved to ${backupDir}`);
					}

					const result = restoreFromSnapshot(snapshotDoc, liveVaultSync.ydoc, {
						markdownPaths,
						blobPaths,
						device: this.deps.getSettings().deviceName,
					});

					for (const path of markdownPaths) {
						await this.deps.getDiskMirror()?.flushWrite(path, true);
					}

					if (blobPaths.length > 0) {
						const queued = this.deps.getBlobSync()?.prioritizeDownloads(blobPaths) ?? 0;
						if (queued > 0) {
							this.deps.log(`Restore: queued ${queued} blob downloads`);
						}
					}

					this.deps.onEditorsNeedReconcile("snapshot-restore");

					const parts: string[] = [];
					if (result.markdownRestored > 0) parts.push(`${result.markdownRestored} files restored`);
					if (result.markdownUndeleted > 0) parts.push(`${result.markdownUndeleted} files undeleted`);
					if (result.blobsRestored > 0) parts.push(`${result.blobsRestored} attachments restored`);
					if (backedUp > 0) parts.push(`backup in ${backupDir}`);

					const msg = parts.length > 0
						? `Restore complete: ${parts.join(", ")}.`
						: "No changes were applied.";
					new Notice(msg, 8000);
					this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);

					cleanup();
				},
				cleanup,
			).open();
		} catch (err) {
			this.showSnapshotFailure("Failed to load snapshot", "Snapshots", err);
		}
	}

	private notifySnapshotStorageUnavailable(featureLabel: string): void {
		const message = snapshotStorageUnavailableMessage(featureLabel);
		console.warn(`[kaos] ${message}`);
		this.deps.log(message);
		new Notice(message, 12000);
	}

	private invalidateDashboardSnapshotCache(): void {
		this.dashboardSnapshotCache.invalidate();
	}

	private logSnapshotBackendAction(err: unknown, featureLabel: string): boolean {
		const message = snapshotBackendActionMessage(err, featureLabel);
		if (!message) return false;
		console.warn(`[kaos] ${message}`, err);
		this.deps.log(`${message} Raw error: ${formatUnknown(err)}`);
		return true;
	}

	private logTransientSnapshotNetworkError(err: unknown, actionLabel: string): boolean {
		if (!isTransientSnapshotNetworkError(err)) return false;
		const message = `${actionLabel} skipped: network unavailable or connection closed.`;
		console.debug(`[kaos] ${message}`);
		this.deps.log(`${message} ${formatUnknown(err)}`);
		return true;
	}

	private showSnapshotFailure(fallbackPrefix: string, featureLabel: string, err: unknown): void {
		const message = snapshotBackendActionMessage(err, featureLabel);
		if (message) {
			console.warn(`[kaos] ${message}`, err);
			this.deps.log(`${message} Raw error: ${formatUnknown(err)}`);
			new Notice(message, 12000);
			return;
		}

		console.error(`[kaos] ${fallbackPrefix}:`, err);
		new Notice(`${fallbackPrefix}: ${formatUnknown(err)}`);
	}

	private async restoreRecoveryHistoryItem(
		item: RecoveryHistoryFileItem,
	): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;
		const hash = item.entry.contentHash;
		if (!hash) {
			new Notice("This history entry has no restorable content.");
			return;
		}

		const path = item.entry.path;
		const expectedCurrentHash = await getLiveHashForFileVersion(vaultSync.ydoc, item.entry.fileId, path);
		const content = await downloadFileHistoryContent(
			this.deps.getSettings(),
			hash,
			this.deps.getTraceHttpContext(),
		);
		const currentHash = await getLiveHashForFileVersion(vaultSync.ydoc, item.entry.fileId, path);
		if (currentHash !== expectedCurrentHash) {
			new Notice("File changed while history was open. Reload file history and review again.", 8000);
			return;
		}

		const backupDir = normalizePath(
			`${this.deps.app.vault.configDir}/plugins/kaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
		);
		let backedUp = false;
		try {
			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const current = await this.deps.app.vault.read(file);
				const backupPath = `${backupDir}/${path}`;
				const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
				if (parentDir && !this.deps.app.vault.getAbstractFileByPath(parentDir)) {
					await this.deps.app.vault.createFolder(parentDir);
				}
				await this.deps.app.vault.create(backupPath, current);
				backedUp = true;
			}
		} catch (err) {
			this.deps.log(`Recovery restore backup skipped for "${path}": ${formatUnknown(err)}`);
		}

		const result = await restoreRecoveryVersionToLiveDoc(vaultSync.ydoc, {
			fileId: item.entry.fileId,
			path,
			content,
			expectedCurrentHash,
			device: this.deps.getSettings().deviceName,
		});
		if (!result.restored) {
			new Notice("File changed while history was open. Reload file history and review again.", 8000);
			return;
		}

		await this.deps.getDiskMirror()?.flushWrite(path, true);
		this.deps.onEditorsNeedReconcile("recovery-history-restore");
		new Notice(
			`Restored ${path}` + (backedUp ? ` (backup in ${backupDir})` : ""),
			8000,
		);
		this.deps.log(`Recovery history restore from ${item.manifest.manifestId}: ${path}`);
	}
}

function snapshotBackendActionMessage(err: unknown, featureLabel: string): string | null {
	const text = formatUnknown(err);
	const lower = text.toLowerCase();
	const missingEndpoint =
		text.includes("(404)") ||
		lower.includes("capabilities request failed (404)") ||
		lower.includes("not found");
	const updateRequired =
		lower.includes("update_required") ||
		lower.includes("server_update_required") ||
		lower.includes("update required");
	const objectStorageUnavailable =
		lower.includes("snapshots_unavailable") ||
		lower.includes("recovery_snapshots_unavailable") ||
		lower.includes("r2 not configured") ||
		lower.includes("r2 bucket") ||
		lower.includes("bucket not configured") ||
		lower.includes("object storage");

	if (updateRequired || missingEndpoint) {
		return `KAOS: ${featureLabel} needs a newer KAOS server. Deploy/update the Worker, then retry.`;
	}
	if (objectStorageUnavailable) {
		return snapshotStorageUnavailableMessage(featureLabel);
	}
	return null;
}

function snapshotStorageUnavailableMessage(featureLabel: string): string {
	return `KAOS: ${featureLabel} needs server object storage. Deploy/update the Worker with the KAOS_BUCKET R2 binding, then retry.`;
}

function isTransientSnapshotNetworkError(err: unknown): boolean {
	const lower = formatUnknown(err).toLowerCase();
	return lower.includes("err_internet_disconnected") ||
		lower.includes("err_connection_closed") ||
		lower.includes("err_network_changed") ||
		lower.includes("err_connection_reset") ||
		lower.includes("(502)") ||
		lower.includes("(504)") ||
		lower.includes("error code: 502") ||
		lower.includes("error code: 504") ||
		lower.includes("bad gateway") ||
		lower.includes("gateway timeout") ||
		lower.includes("networkerror") ||
		lower.includes("failed to fetch");
}
