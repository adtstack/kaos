import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
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
	captureBlobRestoreAuthority,
	captureMarkdownRestoreAuthority,
	isBlobRestoreAuthorityCurrent,
	isMarkdownRestoreAuthorityCurrent,
	type SnapshotIndex,
} from "../sync/snapshotClient";
import {
	cleanupFileHistoryStorage,
	downloadFileHistoryContent,
	getFileHistoryStorageStatus,
	getLiveContentForFileVersion,
	listFileHistoryManifests,
	repairFileHistoryStorage,
	requestFileHistoryPointMaybe,
	restoreRecoveryVersionToLiveDoc,
	sha256Hex,
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
	DashboardFileHistoryAttempt,
	DashboardRecentChange,
	DashboardRecentChanges,
	DashboardRecoveryStorageStatus,
	DashboardRecoveryHistoryTarget,
	DashboardSnapshotStatus,
} from "../dashboard/dashboardTypes";
import { DashboardSnapshotCache } from "./dashboardSnapshotCache";
import {
	captureRestoreDiskRevision,
	commitWithCurrentRestoreDiskAuthority,
	findIncoherentMarkdownRestoreReviewPaths,
	quarantineUnsettledMarkdownRestore,
	settleRestoredMarkdownPath,
	type RestoreDiskPrecondition,
	type RestoreDiskSettlement,
} from "./restoreDiskSettlement";

const RECOVERY_SNAPSHOT_PENDING_RETRY_MS = 5 * 60 * 1000;
const RECOVERY_HISTORY_RECENT_POINT_LIMIT = 10;

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

interface RestoreEditorAuthorityEntry {
	view: MarkdownView;
	file: TFile;
	content: string;
}

export class SnapshotService {
	private recoverySnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private recoverySnapshotInFlight = false;
	private readonly dashboardSnapshotCache = new DashboardSnapshotCache();
	private lastFileHistoryAttempt: DashboardFileHistoryAttempt | null = null;

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
			return {
				status: "unavailable",
				message: "Sync not initialized.",
				lastAttempt: this.getDashboardFileHistoryAttempt(),
			};
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			return {
				status: "unavailable",
				message: "File history is unavailable.",
				lastAttempt: this.getDashboardFileHistoryAttempt(),
			};
		}
		if (!vaultSync.connected) {
			return {
				status: "offline",
				message: "Not connected to server.",
				lastAttempt: this.getDashboardFileHistoryAttempt(),
			};
		}

		try {
			const cached = await this.dashboardSnapshotCache.get(`recent-changes:${manifestLimit}:${changeLimit}`, async () => {
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
							previousContentHash: entry.previousContentHash ?? null,
						});
					}
				}
				changes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
				return {
					status: "ready" as const,
					manifestCount: listed.manifests.length,
					limited: listed.limited,
					latestCreatedAt: listed.manifests[0]?.createdAt ?? null,
					changes: changes.slice(0, changeLimit),
				};
			});
			return {
				...cached,
				lastAttempt: this.getDashboardFileHistoryAttempt(),
			};
		} catch (err) {
			return {
				status: "error",
				message: formatUnknown(err),
				lastAttempt: this.getDashboardFileHistoryAttempt(),
			};
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
		try {
			const result = await requestFileHistoryPointMaybe(
				settings,
				settings.deviceName,
				this.deps.getTraceHttpContext(),
				forceFull,
			);
			this.recordFileHistoryAttempt(forceFull, result);
			return result;
		} catch (err) {
			this.recordFileHistoryAttempt(forceFull, {
				status: "unavailable",
				reason: formatUnknown(err),
			});
			throw err;
		}
	}

	private recordFileHistoryAttempt(
		forceFull: boolean,
		result: FileHistoryPointResult,
	): void {
		this.lastFileHistoryAttempt = {
			attemptedAt: new Date().toISOString(),
			status: result.status,
			manifestId: result.manifestId ?? null,
			reason: result.reason ?? null,
			changedCount: result.index?.changedCount ?? null,
			forceFull,
			pending: result.pending
				? {
					uploadedContentCount: result.pending.uploadedContentCount,
					totalContentCount: result.pending.totalContentCount,
					remainingContentCount: result.pending.remainingContentCount,
				}
				: null,
		};
	}

	private getDashboardFileHistoryAttempt(): DashboardFileHistoryAttempt | null {
		if (!this.lastFileHistoryAttempt) return null;
		return {
			...this.lastFileHistoryAttempt,
			pending: this.lastFileHistoryAttempt.pending
				? { ...this.lastFileHistoryAttempt.pending }
				: null,
		};
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

	async showRecoveryHistory(target?: DashboardRecoveryHistoryTarget): Promise<void> {
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
			const listed = await listFileHistoryManifests(
				settings,
				this.deps.getTraceHttpContext(),
				RECOVERY_HISTORY_RECENT_POINT_LIMIT,
			);
			if (listed.manifests.length === 0) {
				new Notice("No file history found yet. Create a file history point after the next file change.");
				return;
			}

			const manifests: FileHistoryManifestIndex[] = listed.manifests;

			new RecoveryHistoryModal(
				this.deps.app,
				manifests,
				{
					downloadContent: async (hash) => await downloadFileHistoryContent(
						settings,
						hash,
						this.deps.getTraceHttpContext(),
					),
					restoreVersion: async (item) => {
						await this.restoreRecoveryHistoryItem(item);
					},
					loadMoreHistory: async (cursor) => await listFileHistoryManifests(
						settings,
						this.deps.getTraceHttpContext(),
						RECOVERY_HISTORY_RECENT_POINT_LIMIT,
						cursor,
					),
				},
				target
					? {
						initialManifestId: target.initialManifestId,
						initialFileId: target.initialFileId,
						autoExpandDiff: target.autoExpandDiff,
					}
					: undefined,
				listed.nextCursor,
			).open();
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
	 * Capture and back up the disk state the user is about to replace. The
	 * captured bytes later become the compare-and-swap precondition for the
	 * explicit restore write.
	 */
	private async prepareMarkdownRestore(
		paths: string[],
		backupDir: string,
		reviewedPreconditions?: ReadonlyMap<string, RestoreDiskPrecondition>,
	): Promise<{
		preconditions: Map<string, RestoreDiskPrecondition>;
		backedUp: number;
	}> {
		const preconditions = new Map<string, RestoreDiskPrecondition>();
		let backedUp = 0;

		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			const reviewed = reviewedPreconditions?.get(path);
			if (reviewedPreconditions && !reviewed) {
				throw new Error(`Restore not started: disk authority for "${path}" was not reviewed.`);
			}
			if (reviewed) {
				preconditions.set(path, reviewed);
				if (reviewed.kind === "missing") continue;
				await this.writeMarkdownRestoreBackup(path, reviewed.content, backupDir);
				backedUp++;
				continue;
			}
			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!file) {
				preconditions.set(path, { kind: "missing" });
				continue;
			}
			if (!(file instanceof TFile)) {
				throw new Error(`Restore not started: "${path}" is not a file.`);
			}

			const revision = captureRestoreDiskRevision(file);
			let current: string;
			try {
				current = await this.deps.app.vault.read(file);
			} catch (err) {
				throw new Error(
					`Restore not started: could not read "${path}" for its safety backup (${formatUnknown(err)}).`,
				);
			}

			await this.writeMarkdownRestoreBackup(path, current, backupDir);

			preconditions.set(path, {
				kind: "present",
				content: current,
				fileIdentity: file,
				revision,
			});
			backedUp++;
		}

		return { preconditions, backedUp };
	}

	private async writeMarkdownRestoreBackup(
		path: string,
		content: string,
		backupDir: string,
	): Promise<void> {
		const backupPath = normalizePath(`${backupDir}/${path}`);
		const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
		try {
			if (parentDir && !this.deps.app.vault.getAbstractFileByPath(parentDir)) {
				await this.deps.app.vault.createFolder(parentDir);
			}
			await this.deps.app.vault.create(backupPath, content);
		} catch (err) {
			throw new Error(
				`Restore not started: could not back up "${path}" (${formatUnknown(err)}).`,
			);
		}
	}

	/** Capture exact disk authority for the state rendered in the snapshot diff. */
	private async captureMarkdownRestoreDiskAuthority(
		paths: readonly string[],
	): Promise<Map<string, RestoreDiskPrecondition>> {
		const captured = new Map<string, RestoreDiskPrecondition>();
		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			if (captured.has(path)) continue;
			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (file === null) {
				captured.set(path, { kind: "missing" });
				continue;
			}
			if (!(file instanceof TFile)) {
				throw new Error(`Snapshot diff not opened: "${path}" is not a file.`);
			}
			const revision = captureRestoreDiskRevision(file);
			let content: string;
			try {
				content = await this.deps.app.vault.read(file);
			} catch (err) {
				throw new Error(
					`Snapshot diff not opened: could not read "${path}" (${formatUnknown(err)}).`,
				);
			}
			if (
				file.path !== path
				|| this.deps.app.vault.getAbstractFileByPath(path) !== file
			) {
				throw new Error(`Snapshot diff not opened: disk authority changed for "${path}".`);
			}
			captured.set(path, {
				kind: "present",
				content,
				fileIdentity: file,
				revision,
			});
		}

		const finalCheck = await commitWithCurrentRestoreDiskAuthority(
			this.deps.app.vault,
			captured,
			() => undefined,
		);
		if (finalCheck.kind === "stale") {
			throw new Error(
				`Snapshot diff not opened because disk authority changed: ${finalCheck.paths.join(", ")}.`,
			);
		}
		return captured;
	}

	private getOpenMarkdownViewsForRestorePath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		const activeView = (this.deps.app.workspace as {
			getActiveViewOfType?: <T>(type: abstract new (...args: never[]) => T) => T | null;
		}).getActiveViewOfType?.(MarkdownView) ?? null;
		if (activeView?.file?.path === path) views.push(activeView);

		const workspace = this.deps.app.workspace as {
			iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
		};
		workspace.iterateAllLeaves?.((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file?.path === path
				&& !views.includes(leaf.view)
			) {
				views.push(leaf.view);
			}
		});
		return views;
	}

	/**
	 * Capture exact open-editor identities and bytes before asynchronous backup
	 * work. The returned fence also rejects newly opened/closed/replaced views.
	 */
	private captureOpenEditorRestoreAuthority(
		paths: readonly string[],
	): Map<string, RestoreEditorAuthorityEntry[]> {
		const captured = new Map<string, RestoreEditorAuthorityEntry[]>();
		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			if (captured.has(path)) continue;
			const entries: RestoreEditorAuthorityEntry[] = [];
			for (const view of this.getOpenMarkdownViewsForRestorePath(path)) {
				if (!view.file) {
					throw new Error(`Restore not started: editor authority for "${path}" is unavailable.`);
				}
				let content: string;
				try {
					content = view.editor.getValue();
				} catch (err) {
					throw new Error(
						`Restore not started: could not read the open editor for "${path}" (${formatUnknown(err)}).`,
					);
				}
				entries.push({ view, file: view.file, content });
			}
			captured.set(path, entries);
		}
		return captured;
	}

	private isOpenEditorRestoreAuthorityCurrent(
		captured: ReadonlyMap<string, readonly RestoreEditorAuthorityEntry[]>,
	): boolean {
		for (const [path, expectedEntries] of captured) {
			const currentViews = this.getOpenMarkdownViewsForRestorePath(path);
			if (currentViews.length !== expectedEntries.length) return false;
			for (const expected of expectedEntries) {
				if (!currentViews.includes(expected.view)) return false;
				if (expected.view.file !== expected.file || expected.file.path !== path) return false;
				try {
					if (expected.view.editor.getValue() !== expected.content) return false;
				} catch {
					return false;
				}
			}
		}
		return true;
	}

	private captureOpenEditorRestoreFence(paths: readonly string[]): () => boolean {
		const captured = this.captureOpenEditorRestoreAuthority(paths);
		return () => this.isOpenEditorRestoreAuthorityCurrent(captured);
	}

	private selectRestoreAuthority<T>(
		captured: ReadonlyMap<string, T>,
		paths: readonly string[],
	): Map<string, T> {
		const selected = new Map<string, T>();
		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			if (selected.has(path)) continue;
			const authority = captured.get(path);
			if (authority !== undefined) selected.set(path, authority);
		}
		return selected;
	}

	private captureRestoredMarkdownContents(
		vaultSync: VaultSync,
		paths: string[],
	): Map<string, string> {
		const contents = new Map<string, string>();
		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			const restoredText = vaultSync.getTextForPath(path);
			if (restoredText) contents.set(path, restoredText.toJSON());
		}
		return contents;
	}

	private async settleMarkdownRestores(
		paths: string[],
		preconditions: Map<string, RestoreDiskPrecondition>,
		restoredContents: Map<string, string>,
		diskMirror: DiskMirror | null,
	): Promise<Array<{ path: string; detail: string }>> {
		const failures: Array<{ path: string; detail: string }> = [];

		for (const requestedPath of paths) {
			const path = normalizePath(requestedPath);
			const precondition = preconditions.get(path);
			const restoredContent = restoredContents.get(path);
			if (!precondition || restoredContent === undefined) {
				const detail = !precondition
					? "missing pre-restore disk snapshot"
					: "restored CRDT text is unavailable";
				failures.push({ path, detail });
				quarantineUnsettledMarkdownRestore(diskMirror, path);
				this.deps.log(`Restore disk settlement incomplete for "${path}": ${detail}`);
				continue;
			}

			const settlement = await settleRestoredMarkdownPath(
				diskMirror,
				path,
				precondition,
				restoredContent,
			);
			if (settlement.kind === "settled") continue;

			const detail = this.describeRestoreDiskSettlement(settlement);
			failures.push({ path, detail });
			this.deps.log(`Restore disk settlement incomplete for "${path}": ${detail}`);
		}

		return failures;
	}

	private describeRestoreDiskSettlement(
		settlement: Extract<RestoreDiskSettlement, { kind: "not-settled" }>,
	): string {
		const result = settlement.result;
		let resultDetail = "no-result";
		if (result?.kind === "deferred") resultDetail = `deferred:${result.reason}`;
		else if (result?.kind === "blocked") resultDetail = `blocked:${result.reason}`;
		else if (result?.kind === "failed") resultDetail = `failed:${result.error}`;
		else if (result) resultDetail = result.kind;
		return [settlement.reason, resultDetail, settlement.error]
			.filter((part): part is string => !!part)
			.join(", ");
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
			const initialDiff = diffSnapshot(snapshotDoc, vaultSync.ydoc);

			let destroyed = false;
			const cleanup = () => {
				if (!destroyed) {
					destroyed = true;
					snapshotDoc.destroy();
				}
			};
			const reviewedMarkdownPaths = [
				...initialDiff.deletedSinceSnapshot.map(({ path }) => path),
				...initialDiff.contentChanged.map(({ path }) => path),
			];
			const reviewedBlobPaths = [
				...initialDiff.blobsDeletedSinceSnapshot.map(({ path }) => path),
				...initialDiff.blobsChanged.map(({ path }) => path),
			];
			let reviewedDiskAuthority: Map<string, RestoreDiskPrecondition>;
			let reviewedBlobAuthority: ReturnType<typeof captureBlobRestoreAuthority>;
			let reviewedMarkdownAuthority: ReturnType<typeof captureMarkdownRestoreAuthority>;
			let reviewedOpenEditorAuthority: Map<string, RestoreEditorAuthorityEntry[]>;
			try {
				reviewedBlobAuthority = captureBlobRestoreAuthority(
					vaultSync.ydoc,
					reviewedBlobPaths,
				);
				reviewedMarkdownAuthority = captureMarkdownRestoreAuthority(
					vaultSync.ydoc,
					reviewedMarkdownPaths,
				);
				reviewedOpenEditorAuthority = this.captureOpenEditorRestoreAuthority(
					reviewedMarkdownPaths,
				);
				reviewedDiskAuthority = await this.captureMarkdownRestoreDiskAuthority(
					reviewedMarkdownPaths,
				);
				if (
					this.deps.getVaultSync() !== vaultSync
					|| !isBlobRestoreAuthorityCurrent(vaultSync.ydoc, reviewedBlobAuthority)
					|| !isMarkdownRestoreAuthorityCurrent(vaultSync.ydoc, reviewedMarkdownAuthority)
					|| !this.isOpenEditorRestoreAuthorityCurrent(reviewedOpenEditorAuthority)
				) {
					throw new Error("Live authority changed while the snapshot diff was opening. Reload it and review again.");
				}
			} catch (err) {
				cleanup();
				throw err;
			}
			// Disk capture above yields to the event loop. Recompute the actual UI
			// diff only after every captured authority has passed its final check,
			// then reject any newly selectable path that was not part of that exact
			// capture. No await exists between this recomputation and modal creation.
			const diff = diffSnapshot(snapshotDoc, vaultSync.ydoc);
			const finalSelectableMarkdownPaths = [
				...diff.deletedSinceSnapshot.map(({ path }) => normalizePath(path)),
				...diff.contentChanged.map(({ path }) => normalizePath(path)),
			];
			const finalSelectableBlobPaths = [
				...diff.blobsDeletedSinceSnapshot.map(({ path }) => normalizePath(path)),
				...diff.blobsChanged.map(({ path }) => normalizePath(path)),
			];
			if (
				finalSelectableMarkdownPaths.some((path) =>
					!reviewedMarkdownAuthority.has(path)
					|| !reviewedOpenEditorAuthority.has(path)
					|| !reviewedDiskAuthority.has(path)
				)
				|| finalSelectableBlobPaths.some((path) => !reviewedBlobAuthority.has(path))
			) {
				cleanup();
				throw new Error("Live state changed while the snapshot diff was opening. Reload it and review again.");
			}
			const incoherentMarkdownPaths = findIncoherentMarkdownRestoreReviewPaths(
				finalSelectableMarkdownPaths,
				reviewedMarkdownAuthority,
				reviewedDiskAuthority,
				reviewedOpenEditorAuthority,
			);
			if (incoherentMarkdownPaths.length > 0) {
				cleanup();
				throw new Error(
					"Snapshot diff not opened because its CRDT view does not match "
					+ `the current disk/open-editor authority: ${incoherentMarkdownPaths.join(", ")}. `
					+ "Let sync settle or resolve the visible divergence, then reload the snapshot.",
				);
			}

			new SnapshotDiffModal(
				this.deps.app,
				snapshot,
				diff,
				async (markdownPaths, blobPaths) => {
					const liveVaultSync = this.deps.getVaultSync();
					if (!liveVaultSync || liveVaultSync !== vaultSync) {
						new Notice("Restore not started: sync is no longer initialized.", 8000);
						cleanup();
						return;
					}

					try {
						const normalizedMarkdownPaths = [...new Set(markdownPaths.map(normalizePath))];
						const normalizedBlobPaths = [...new Set(blobPaths.map(normalizePath))];
						const restoreDiskMirror = normalizedMarkdownPaths.length > 0
							? this.deps.getDiskMirror()
							: null;
						if (normalizedMarkdownPaths.length > 0 && !restoreDiskMirror) {
							new Notice(
								"Restore not started: the disk writer is unavailable. Reconnect sync and retry.",
								8000,
							);
							return;
						}
						const expectedBlobAuthority = this.selectRestoreAuthority(
							reviewedBlobAuthority,
							blobPaths,
						);
						const expectedMarkdownAuthority = this.selectRestoreAuthority(
							reviewedMarkdownAuthority,
							markdownPaths,
						);
						const expectedOpenEditorAuthority = this.selectRestoreAuthority(
							reviewedOpenEditorAuthority,
							markdownPaths,
						);
						const expectedDiskAuthority = this.selectRestoreAuthority(
							reviewedDiskAuthority,
							markdownPaths,
						);
						if (
							expectedBlobAuthority.size !== normalizedBlobPaths.length
							|| expectedMarkdownAuthority.size !== normalizedMarkdownPaths.length
							|| expectedOpenEditorAuthority.size !== normalizedMarkdownPaths.length
							|| expectedDiskAuthority.size !== normalizedMarkdownPaths.length
						) {
							throw new Error("Restore selection no longer matches the reviewed snapshot diff.");
						}
						const isOpenEditorAuthorityCurrent = () =>
							this.isOpenEditorRestoreAuthorityCurrent(expectedOpenEditorAuthority);
						const diskReviewCheck = await commitWithCurrentRestoreDiskAuthority(
							this.deps.app.vault,
							expectedDiskAuthority,
							() => undefined,
						);
						if (diskReviewCheck.kind === "stale") {
							const changedPaths = diskReviewCheck.paths.join(", ");
							new Notice(
								`Restore was not applied because disk changed after the diff was shown: ${changedPaths}. ` +
								"Reload the snapshot diff and review again.",
								12000,
							);
							return;
						}
						if (
							this.deps.getVaultSync() !== liveVaultSync
							|| !isBlobRestoreAuthorityCurrent(liveVaultSync.ydoc, expectedBlobAuthority)
							|| !isMarkdownRestoreAuthorityCurrent(liveVaultSync.ydoc, expectedMarkdownAuthority)
							|| !isOpenEditorAuthorityCurrent()
						) {
							new Notice(
								"Restore was not applied because live file/editor/attachment authority changed after the diff was shown. Reload it and review again.",
								12000,
							);
							return;
						}
						const backupDir = normalizePath(
							`${this.deps.app.vault.configDir}/plugins/kaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
						);
						const preparation = await this.prepareMarkdownRestore(
							markdownPaths,
							backupDir,
							expectedDiskAuthority,
						);
						if (preparation.backedUp > 0) {
							this.deps.log(
								`Pre-restore backup: ${preparation.backedUp} files saved to ${backupDir}`,
							);
						}

						const restoreAttempt = await commitWithCurrentRestoreDiskAuthority(
							this.deps.app.vault,
							preparation.preconditions,
							(isDiskIdentityCurrent) => restoreFromSnapshot(
								snapshotDoc,
								liveVaultSync.ydoc,
								{
									markdownPaths,
									blobPaths,
									device: this.deps.getSettings().deviceName,
									expectedBlobAuthority,
									expectedMarkdownAuthority,
									canCommitMarkdownRestore: () =>
										this.deps.getVaultSync() === liveVaultSync
										&& (
											normalizedMarkdownPaths.length === 0
											|| this.deps.getDiskMirror() === restoreDiskMirror
										)
										&& isBlobRestoreAuthorityCurrent(
											liveVaultSync.ydoc,
											expectedBlobAuthority,
										)
										&& isMarkdownRestoreAuthorityCurrent(
											liveVaultSync.ydoc,
											expectedMarkdownAuthority,
										)
										&& isOpenEditorAuthorityCurrent(),
									isMarkdownRestoreDiskAuthorityCurrent: isDiskIdentityCurrent,
								},
							),
						);
						if (restoreAttempt.kind === "stale") {
							const changedPaths = restoreAttempt.paths.join(", ");
							const message =
								`Restore was not applied because disk authority changed after backup: ${changedPaths}. `
								+ "Reload the snapshot diff and review again.";
							this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${message}`);
							new Notice(message, 12000);
							return;
						}
						const result = restoreAttempt.value;
						if (result.markdownRejected.length > 0) {
							const detail = result.markdownRejected
								.map(({ path, reason }) => `${path} (${reason})`)
								.join(", ");
							const message =
								`Restore was not applied because live file/editor/disk authority changed: ${detail}. ` +
								"Reload the snapshot diff and review again.";
							this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${message}`);
							new Notice(message, 12000);
							return;
						}
						if (result.blobRejected.length > 0) {
							const detail = result.blobRejected
								.map(({ path, reason }) => `${path} (${reason})`)
								.join(", ");
							const message =
								`Restore was not applied because live attachment authority changed: ${detail}. ` +
								"Reload the snapshot diff and review again.";
							this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${message}`);
							new Notice(message, 12000);
							return;
						}
						const restoredContents = this.captureRestoredMarkdownContents(
							liveVaultSync,
							markdownPaths,
						);
						const diskFailures = await this.settleMarkdownRestores(
							markdownPaths,
							preparation.preconditions,
							restoredContents,
							restoreDiskMirror,
						);

						if (blobPaths.length > 0) {
							const queued = this.deps.getBlobSync()?.prioritizeDownloads(blobPaths) ?? 0;
							if (queued > 0) {
								this.deps.log(`Restore: queued ${queued} blob downloads`);
							}
						}

						this.deps.onEditorsNeedReconcile("snapshot-restore");

						if (diskFailures.length > 0) {
							const failedPaths = diskFailures.map(({ path }) => path).join(", ");
							const msg =
								`Restore changed the synced state, but disk settlement was not verified for ` +
								`${diskFailures.length} file(s): ${failedPaths}. ` +
								"The restore is not complete; review the preserved disk files and retry.";
							new Notice(msg, 12000);
							this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);
							return;
						}

						const parts: string[] = [];
						if (result.markdownRestored > 0) parts.push(`${result.markdownRestored} files restored`);
						if (result.markdownUndeleted > 0) parts.push(`${result.markdownUndeleted} files undeleted`);
						if (result.blobsRestored > 0) parts.push(`${result.blobsRestored} attachments restored`);
						if (preparation.backedUp > 0) parts.push(`backup in ${backupDir}`);

						const msg = parts.length > 0
							? `Restore complete: ${parts.join(", ")}.`
							: "No changes were applied.";
						new Notice(msg, 8000);
						this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);
					} catch (err) {
						const msg = `Restore failed: ${formatUnknown(err)}`;
						console.error(`[kaos] ${msg}`, err);
						this.deps.log(msg);
						new Notice(msg, 12000);
					} finally {
						cleanup();
					}
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
		const restoreDiskMirror = this.deps.getDiskMirror();
		if (!restoreDiskMirror) {
			new Notice(
				"History restore not started: the disk writer is unavailable. Reconnect sync and retry.",
				8000,
			);
			return;
		}
		const hash = item.entry.contentHash;
		if (!hash) {
			new Notice("This history entry has no restorable content.");
			return;
		}

		const path = item.entry.path;
		const expectedMarkdownAuthority = captureMarkdownRestoreAuthority(vaultSync.ydoc, [path]);
		const isOpenEditorAuthorityCurrent = this.captureOpenEditorRestoreFence([path]);
		const expectedCurrentContent = getLiveContentForFileVersion(
			vaultSync.ydoc,
			item.entry.fileId,
			path,
		);
		const expectedCurrentHash = expectedCurrentContent === null
			? null
			: await sha256Hex(expectedCurrentContent);
		const content = await downloadFileHistoryContent(
			this.deps.getSettings(),
			hash,
			this.deps.getTraceHttpContext(),
		);
		const currentContent = getLiveContentForFileVersion(vaultSync.ydoc, item.entry.fileId, path);
		if (currentContent !== expectedCurrentContent) {
			new Notice("File changed while history was open. Reload file history and review again.", 8000);
			return;
		}

		const backupDir = normalizePath(
			`${this.deps.app.vault.configDir}/plugins/kaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
		);
		const preparation = await this.prepareMarkdownRestore([path], backupDir);

		const restoreAttempt = await commitWithCurrentRestoreDiskAuthority(
			this.deps.app.vault,
			preparation.preconditions,
			(isDiskIdentityCurrent) => restoreRecoveryVersionToLiveDoc(vaultSync.ydoc, {
				fileId: item.entry.fileId,
				path,
				content,
				expectedCurrentHash,
				expectedCurrentContent,
				device: this.deps.getSettings().deviceName,
				canCommitRestore: () =>
					this.deps.getVaultSync() === vaultSync
						&& this.deps.getDiskMirror() === restoreDiskMirror
						&& isMarkdownRestoreAuthorityCurrent(vaultSync.ydoc, expectedMarkdownAuthority)
						&& isOpenEditorAuthorityCurrent(),
				isDiskRestoreAuthorityCurrent: isDiskIdentityCurrent,
			}),
		);
		if (restoreAttempt.kind === "stale") {
			new Notice(
				"The disk file changed after its safety backup. Reload file history and review again.",
				8000,
			);
			return;
		}
		const result = await restoreAttempt.value;
		if (!result.restored) {
			new Notice(
				result.reason === "file-identity-moved"
					? "The file was renamed or its identity moved. Restore it from its current path instead."
					: "File changed while history was open. Reload file history and review again.",
				8000,
			);
			return;
		}

		const restoredContents = new Map([[normalizePath(path), content]]);
		const diskFailures = await this.settleMarkdownRestores(
			[path],
			preparation.preconditions,
			restoredContents,
			restoreDiskMirror,
		);
		this.deps.onEditorsNeedReconcile("recovery-history-restore");
		if (diskFailures.length > 0) {
			const detail = diskFailures[0]?.detail ?? "unknown disk settlement failure";
			const message =
				`The history version changed the synced state for ${path}, but its disk write ` +
				`was not safely verified (${detail}). Review the preserved disk file and retry.`;
			this.deps.log(`Recovery history restore incomplete from ${item.manifest.manifestId}: ${message}`);
			throw new Error(message);
		}
		new Notice(
			`Restored ${path}` + (preparation.backedUp > 0 ? ` (backup in ${backupDir})` : ""),
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
