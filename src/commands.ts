import { Notice, type Plugin, type TFile } from "obsidian";
import type { DiagnosticsService } from "./telemetry/diagnostics/diagnosticsService";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getDiagnosticsService(): DiagnosticsService | null;
	getSnapshotService(): SnapshotService | null;
	getActiveFile?(): TFile | null;
	getFilesNeedingAttentionText(): string;
	getUntrackedFileCount(): number;
	openDashboard(): Promise<void>;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	runReconciliation(
		mode: ReconcileMode,
		options: { forceUnhydrated?: boolean },
	): Promise<void>;
	runSyncCheck(): Promise<void>;
	runSchemaMigrationToV2(): void;
	importUntrackedFiles(): Promise<void>;
	clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined>;
	resetLocalCache(): void;
	nuclearReset(): void;
	prunePhantomRemotePaths(): Promise<void>;
	resolveSettledCollisionMarkers(): Promise<void>;
}

export function registerCommands(
	registrar: Pick<Plugin, "addCommand">,
	host: CommandsRuntimeHost,
): void {
	registrar.addCommand({
		id: "open-dashboard",
		name: "Open dashboard",
		callback: () => {
			void host.openDashboard();
		},
	});

	registrar.addCommand({
		id: "open-dashboard-from-ribbon",
		name: "Open dashboard from ribbon",
		callback: () => {
			void host.openDashboard();
		},
	});

	registrar.addCommand({
		id: "reconnect",
		name: "Reconnect to sync server",
		callback: () => {
			if (host.getVaultSync()) {
				host.getConnectionController()?.reconnect("manual-command");
				new Notice("Reconnecting...");
			}
		},
	});

	registrar.addCommand({
		id: "force-reconcile",
		name: "Force reconcile vault with sync state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			const mode = vaultSync.getSafeReconcileMode();
			void host.runReconciliation(mode);
		},
	});

	registrar.addCommand({
		id: "force-reconcile-unhydrated",
		name: "Force authoritative reconcile without the local cache gate (emergency)",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			if (vaultSync.localReady) {
				new Notice("Local cache is already loaded — running a normal authoritative reconcile.");
				void host.runReconciliation("authoritative");
				return;
			}
			new Notice(
				"KAOS: forcing an authoritative reconcile while the local cache is not loaded. " +
				"If the server is behind this device, notes may visibly revert to older server state.",
				10000,
			);
			void host.runReconciliation("authoritative", { forceUnhydrated: true });
		},
	});

	registrar.addCommand({
		id: "run-sync-check",
		name: "Run sync check",
		callback: () => {
			void host.runSyncCheck();
		},
	});

	registrar.addCommand({
		id: "debug-status",
		name: "Show sync debug info",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			new Notice(info, 10000);
			console.debug("[kaos] Debug status:\n" + info);
		},
	});

	registrar.addCommand({
		id: "copy-debug",
		name: "Copy debug info to clipboard",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			navigator.clipboard.writeText(info).then(
				() => new Notice("Debug info copied to clipboard."),
				() => new Notice("Failed to copy to clipboard. Check console.", 5000),
			);
			console.debug("[kaos] Debug info:\n" + info);
		},
	});

	registrar.addCommand({
		id: "show-recent-events",
		name: "Show recent sync events",
		callback: () => {
			const text = host.getDiagnosticsService()?.buildRecentEventsText(80) ?? "No events recorded yet.";
			new Notice("Recent sync events printed to console.", 5000);
			console.debug("[kaos] Recent sync events:\n" + text);
		},
	});

	registrar.addCommand({
		id: "show-files-needing-attention",
		name: "Show files needing attention",
		callback: () => {
			const text = host.getFilesNeedingAttentionText();
			new Notice("Files needing attention printed to console.", 7000);
			console.debug("[kaos] Files needing attention:\n" + text);
		},
	});

	registrar.addCommand({
		id: "export-diagnostics",
		name: "Export sync diagnostics (safe)",
		callback: () => {
			void host.getDiagnosticsService()?.exportDiagnostics();
		},
	});

	registrar.addCommand({
		id: "export-diagnostics-with-filenames",
		name: "Export sync diagnostics with filenames",
		callback: () => {
			void host.getDiagnosticsService()?.exportDiagnosticsWithFilenames();
		},
	});

	registrar.addCommand({
		id: "migrate-schema-v2",
		name: "Migrate sync schema to v2",
		callback: () => {
			host.runSchemaMigrationToV2();
		},
	});

	registrar.addCommand({
		id: "import-untracked",
		name: "Import untracked files now",
		callback: () => {
			if (!host.getVaultSync()) {
				new Notice("Sync not initialized");
				return;
			}
			const count = host.getUntrackedFileCount();
			if (count === 0) {
				new Notice("No untracked files to import.");
				return;
			}
			void host.importUntrackedFiles().then(() => {
				new Notice(`Imported ${count} untracked file(s).`);
			});
		},
	});

	registrar.addCommand({
		id: "clear-local-server-receipt-state",
		name: "Clear local server-receipt state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) {
				new Notice("Sync not initialized");
				return;
			}
			void host.clearLocalServerReceiptState().then(
				(result) => new Notice(
					result === "cleared_persistent"
						? "Local server-receipt state cleared."
						: result === "cleared_memory_only"
							? "Local server-receipt state cleared for this session. Persistent receipt store is unavailable."
							: "Failed to clear local server-receipt state. Check console.",
					result === "cleared_persistent" ? 4000 : 7000,
				),
				() => new Notice("Failed to clear local server-receipt state. Check console.", 5000),
			);
		},
	});

	registrar.addCommand({
		id: "reset-cache",
		name: "Reset local cache (re-sync from server)",
		callback: () => {
			host.resetLocalCache();
		},
	});

	registrar.addCommand({
		id: "snapshot-now",
		name: "Take vault snapshot now",
		callback: async () => {
			await host.getSnapshotService()?.takeSnapshotNow();
		},
	});

	registrar.addCommand({
		id: "snapshot-list",
		name: "Browse and restore vault snapshots",
		callback: async () => {
			await host.getSnapshotService()?.showSnapshotList();
		},
	});

	registrar.addCommand({
		id: "create-file-history-point",
		name: "Create file history point",
		callback: async () => {
			await host.getSnapshotService()?.createFileHistoryPoint();
		},
	});

	registrar.addCommand({
		id: "review-file-history",
		name: "Review file history",
		callback: async () => {
			await host.getSnapshotService()?.showRecoveryHistory();
		},
	});

	registrar.addCommand({
		id: "review-file-history-active-file",
		name: "Review file history for active file",
		checkCallback: (checking: boolean) => {
			const activeFile = host.getActiveFile?.();
			if (!activeFile) return false;
			if (checking) return true;
			void host.getSnapshotService()?.showFileHistoryForPath(activeFile.path);
			return true;
		},
	});

	registrar.addCommand({
		id: "reset-file-history-baseline",
		name: "Reset file history baseline",
		callback: async () => {
			await host.getSnapshotService()?.resetFileHistoryBaseline();
		},
	});

	registrar.addCommand({
		id: "snapshot-prune",
		name: "Cleanup old vault snapshots",
		callback: async () => {
			await host.getSnapshotService()?.pruneSnapshots();
		},
	});

	registrar.addCommand({
		id: "check-file-history-storage",
		name: "Check file history storage",
		callback: async () => {
			await host.getSnapshotService()?.repairFileHistoryStorage();
		},
	});

	registrar.addCommand({
		id: "cleanup-file-history",
		name: "Cleanup file history",
		callback: async () => {
			await host.getSnapshotService()?.cleanupFileHistory();
		},
	});

	registrar.addCommand({
		id: "nuclear-reset",
		name: "Nuclear reset (wipe sync state and reseed from disk)",
		callback: () => {
			host.nuclearReset();
		},
	});

	registrar.addCommand({
		id: "prune-phantom-paths",
		name: "Prune phantom remote paths (clean up deleted/moved paths on server)",
		callback: () => {
			void host.prunePhantomRemotePaths();
		},
	});

	registrar.addCommand({
		id: "resolve-settled-collision-markers",
		name: "Resolve settled move & collision markers (clear old archive attention items)",
		callback: () => {
			void host.resolveSettledCollisionMarkers();
		},
	});
}
