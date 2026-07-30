import { App, ItemView, Modal, Notice, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import type {
	DashboardAttentionItem,
	DashboardBlobConflictResolutionChoice,
	DashboardBlobConflictResolutionResult,
	DashboardBlobConflictResolutionTarget,
	DashboardConflictArtifact,
	DashboardHandoffRecovery,
	DashboardHandoffRecoveryItem,
	DashboardMetric,
	DashboardRecentChange,
	DashboardRecentChanges,
	DashboardFileHistoryAttempt,
	DashboardLegacyMissingBlobResolution,
	DashboardLegacyMissingBlobResolutionChoice,
	DashboardLegacyMissingBlobResolutionTarget,
	DashboardRemoteDeleteResolution,
	DashboardRemoteDeleteResolutionChoice,
	DashboardRemoteDeleteResolutionResult,
	DashboardRemoteDeleteResolutionTarget,
	DashboardRecoveryHistoryTarget,
	DashboardRecoveryStorageStatus,
	DashboardTone,
	KaosDashboardData,
} from "./dashboardTypes";
import type {
	ActiveHandoffRecoveryRecord,
	ClearHandoffRecoveryScopeResult,
} from "../sync/handoffRecoveryStore";
import {
	deriveDashboardHealth,
	resolveKaosDashboardMode,
	type KaosDashboardMode,
} from "./dashboardLayout";
import { formatDashboardDeviceName } from "./deviceDisplay";
import {
	renderDiffLines as buildTextDiffLines,
	type RenderedDiffLine,
} from "../utils/textDiff";
import {
	mergeTexts3,
	type ThreeWayMergeConflictHunk,
	type ThreeWayMergeSegment,
} from "../utils/threeWayMerge";
import { ConfirmModal } from "../ui/ConfirmModal";
import { requestHandoffRecoveryExportPath } from "../ui/HandoffRecoveryExportModal";
import {
	captureConflictResolutionSnapshot,
	resolveConflictArtifactWithCas,
	type ConflictResolutionChoice,
	type ConflictResolutionSnapshot,
} from "./conflictResolution";

export const KAOS_DASHBOARD_VIEW_TYPE = "kaos-dashboard";

export interface KaosDashboardActions {
	reconnect(): void;
	forceReconcile(): void;
	importUntracked(): Promise<void>;
	takeSnapshotNow(): Promise<void>;
	showSnapshotList(): Promise<void>;
	createFileHistoryPoint(): Promise<void>;
	showRecoveryHistory(target?: DashboardRecoveryHistoryTarget): Promise<void>;
	exportDiagnostics(): void;
	exportDiagnosticsWithFilenames(): void;
	resolveRemoteDeleteAttention(
		target: DashboardRemoteDeleteResolutionTarget,
		choice: DashboardRemoteDeleteResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult>;
	resolveLegacyMissingBlobAttention(
		target: DashboardLegacyMissingBlobResolutionTarget,
		choice: DashboardLegacyMissingBlobResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult>;
	resolveBlobConflict(
		target: DashboardBlobConflictResolutionTarget,
		choice: DashboardBlobConflictResolutionChoice,
	): Promise<DashboardBlobConflictResolutionResult>;
	loadHandoffRecovery(
		recordId: string,
		expectedChecksum: string,
	): Promise<ActiveHandoffRecoveryRecord>;
	copyHandoffRecovery(recordId: string, expectedChecksum: string): Promise<void>;
	exportHandoffRecovery(
		recordId: string,
		expectedChecksum: string,
		requestedPath: string,
	): Promise<{ path: string }>;
	resolveHandoffRecovery(recordId: string, expectedChecksum: string): Promise<void>;
	discardHandoffRecovery(recordId: string, expectedChecksum: string): Promise<void>;
	clearHandoffRecoveryScope(): Promise<ClearHandoffRecoveryScopeResult>;
}

export interface KaosDashboardViewDeps {
	collectData(): Promise<KaosDashboardData>;
	getBaselineText?(contentHash: string): Promise<string | null> | string | null;
	getConflictMergeBaseHash?(artifactPath: string): string | null;
	clearConflictMergeBase?(artifactPath: string): void;
	actions: KaosDashboardActions;
}

export class KaosDashboardView extends ItemView {
	private data: KaosDashboardData | null = null;
	private loading = false;
	private error: string | null = null;
	private refreshTimer: number | null = null;
	private readonly pendingAttentionEpisodes = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: KaosDashboardViewDeps,
	) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return KAOS_DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Dashboard";
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("kaos-dashboard");
		this.addAction("refresh-cw", "Refresh dashboard", () => {
			void this.refresh();
		});
		await this.refresh();
		this.refreshTimer = window.setInterval(() => {
			void this.refresh(true);
		}, 30_000);
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.removeClass("kaos-dashboard");
		this.contentEl.classList.remove("is-phone-dashboard");
		this.contentEl.empty();
	}

	private async refresh(silent = false): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error = null;
		this.render();
		try {
			this.data = await this.deps.collectData();
		} catch (err) {
			this.error = formatUnknown(err);
			if (!silent) new Notice("Dashboard failed to refresh. Check console.", 5000);
			console.warn("[kaos] dashboard refresh failed:", err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private render(): void {
		const root = this.contentEl;
		const mode = this.getDashboardMode();
		root.empty();
		root.classList.toggle("is-phone-dashboard", mode === "phone");
		this.renderHeader(root);
		if (!this.data && this.loading) {
			root.createDiv({ text: "Loading...", cls: "kaos-dashboard-muted" });
			return;
		}
		if (!this.data && this.error) {
			root.createDiv({ text: this.error, cls: "kaos-dashboard-error" });
			return;
		}
		if (!this.data) return;

		this.renderHealthSummary(root, this.data);
		if (this.data.attentionTotalCount > 0) {
			this.renderAttention(root, this.data.attention, this.data.attentionTotalCount);
		}
		if (this.data.conflicts.length > 0) {
			this.renderConflicts(root, this.data.conflicts, this.data.settings.deviceName);
		}
		if (
			this.data.handoffRecovery.activeCount > 0
			|| this.data.handoffRecovery.terminalCount > 0
			|| this.data.handoffRecovery.issues.length > 0
		) {
			this.renderHandoffRecovery(root, this.data.handoffRecovery);
		}
		this.renderRecentActivity(root, this.data, mode === "phone" ? 10 : 40);
		this.renderRecovery(root, this.data);
		if (this.data.blobSafetyCopies.length > 0) {
			this.renderBlobSafetyCopies(root, this.data.blobSafetyCopies);
		}
		this.renderOperations(root, this.data);
		this.renderAdvanced(root, this.data.overview);
	}

	private getDashboardMode(): KaosDashboardMode {
		return resolveKaosDashboardMode(Platform);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "kaos-dashboard-header" });
		header.createEl("h2", { text: "Dashboard" });
		const meta = header.createDiv({ cls: "kaos-dashboard-muted" });
		if (this.data) {
			const deviceName = formatDashboardDeviceName(
				this.data.settings.deviceName,
				this.data.settings.deviceName,
			);
			meta.setText(`${formatDateTime(this.data.generatedAt)} · ${deviceName}`);
			if (this.loading) meta.appendText(" · refreshing");
		} else if (this.loading) {
			meta.setText("Loading...");
		}
		if (this.error) {
			header.createDiv({ text: this.error, cls: "kaos-dashboard-error" });
		}
	}

	private renderHealthSummary(root: HTMLElement, data: KaosDashboardData): void {
		const health = deriveDashboardHealth(data);
		const status = data.overview.find((metric) => metric.label === "Status");
		const connection = data.overview.find((metric) => metric.label === "Connection");
		const hero = root.createDiv({
			cls: `kaos-dashboard-health ${toneClass(health.tone)}`,
		});
		hero.setAttr("role", "status");
		hero.setAttr("aria-live", "polite");
		const layout = hero.createDiv({ cls: "kaos-dashboard-health-layout" });
		const copy = layout.createDiv({ cls: "kaos-dashboard-health-copy" });
		const label = copy.createDiv({ cls: "kaos-dashboard-health-label" });
		label.createSpan({ cls: "kaos-dashboard-health-dot" });
		label.createSpan({ text: health.label });
		copy.createEl("h3", { text: health.headline });
		copy.createDiv({ text: health.detail, cls: "kaos-dashboard-health-detail" });
		const actions = layout.createDiv({ cls: "kaos-dashboard-health-actions" });
		this.button(
			actions,
			this.loading ? "Refreshing…" : "Refresh",
			() => this.refresh(),
			this.loading,
			this.loading ? "Refresh is already running." : undefined,
			false,
		);

		const facts = hero.createDiv({ cls: "kaos-dashboard-health-facts" });
		this.renderHealthFact(facts, "Status", status?.value ?? "unknown", status?.tone);
		this.renderHealthFact(facts, "Connection", connection?.value ?? "unknown", connection?.tone);
		this.renderHealthFact(
			facts,
			"Attention",
			String(data.attentionTotalCount),
			data.attentionTotalCount > 0 ? "warn" : "ok",
		);
		this.renderHealthFact(
			facts,
			"Conflicts",
			String(data.conflicts.length),
			data.conflicts.length > 0 ? "error" : "ok",
		);
	}

	private renderHealthFact(
		parent: HTMLElement,
		label: string,
		value: string,
		tone?: DashboardTone,
	): void {
		const fact = parent.createDiv({ cls: `kaos-dashboard-health-fact ${toneClass(tone)}` });
		fact.createSpan({ text: label, cls: "kaos-dashboard-health-fact-label" });
		fact.createSpan({ text: value, cls: "kaos-dashboard-health-fact-value" });
	}

	private renderOperations(root: HTMLElement, data: KaosDashboardData): void {
		const body = this.disclosure(
			root,
			"Operations",
			"Sync, recovery, and maintenance actions",
			"kaos-dashboard-operations",
		);
		const syncActions = this.actionGroup(body, "Sync operations");
		this.button(syncActions, "Reconnect", async () => this.deps.actions.reconnect(), !data.actions.syncInitialized);
		this.button(syncActions, "Force reconcile", async () => this.deps.actions.forceReconcile(), !data.actions.syncInitialized);
		this.button(
			syncActions,
			`Import untracked${data.actions.untrackedFileCount > 0 ? ` (${data.actions.untrackedFileCount})` : ""}`,
			() => this.deps.actions.importUntracked(),
			!data.actions.syncInitialized || data.actions.untrackedFileCount === 0,
		);

		const recoveryActions = this.actionGroup(body, "Recovery operations");
		const recoveryDisabled = !data.actions.syncInitialized
			|| !data.actions.snapshotsAvailable
			|| !data.actions.connected;
		this.button(recoveryActions, "Take vault snapshot", () => this.deps.actions.takeSnapshotNow(), recoveryDisabled);
		this.button(recoveryActions, "Browse vault snapshots", () => this.deps.actions.showSnapshotList(), recoveryDisabled);
		this.button(recoveryActions, "Create file history point", () => this.deps.actions.createFileHistoryPoint(), recoveryDisabled);
		this.button(recoveryActions, "Review file history", () => this.deps.actions.showRecoveryHistory(), recoveryDisabled);
	}

	private renderAdvanced(root: HTMLElement, metrics: DashboardMetric[]): void {
		const body = this.disclosure(
			root,
			"Advanced diagnostics",
			`${metrics.length} detailed sync metrics`,
			"kaos-dashboard-advanced",
		);
		this.renderMetricGrid(body, metrics);
		const exports = this.actionGroup(body, "Diagnostic exports");
		this.button(exports, "Export diagnostics", async () => this.deps.actions.exportDiagnostics());
		this.button(exports, "Export with filenames", async () => this.deps.actions.exportDiagnosticsWithFilenames());
	}

	private disclosure(
		root: HTMLElement,
		title: string,
		detail: string,
		extraClass: string,
	): HTMLElement {
		const details = root.createEl("details", {
			cls: `kaos-dashboard-disclosure ${extraClass}`,
		});
		const summary = details.createEl("summary", { cls: "kaos-dashboard-disclosure-summary" });
		const copy = summary.createSpan({ cls: "kaos-dashboard-disclosure-copy" });
		copy.createSpan({ text: title, cls: "kaos-dashboard-disclosure-title" });
		copy.createSpan({ text: detail, cls: "kaos-dashboard-disclosure-detail" });
		return details.createDiv({ cls: "kaos-dashboard-disclosure-body" });
	}

	private actionGroup(root: HTMLElement, title: string): HTMLElement {
		const group = root.createDiv({ cls: "kaos-dashboard-action-group" });
		group.createEl("h4", { text: title });
		return group.createDiv({ cls: "kaos-dashboard-row-actions" });
	}

	private renderMetricGrid(root: HTMLElement, metrics: DashboardMetric[], extraClass = ""): void {
		const grid = root.createDiv({
			cls: ["kaos-dashboard-metric-grid", extraClass].filter(Boolean).join(" "),
		});
		for (const metric of metrics) {
			const card = grid.createDiv({ cls: `kaos-dashboard-metric ${toneClass(metric.tone)}` });
			card.createDiv({ text: metric.label, cls: "kaos-dashboard-metric-label" });
			card.createDiv({ text: metric.value, cls: "kaos-dashboard-metric-value" });
		}
	}

	private renderRecentActivity(root: HTMLElement, data: KaosDashboardData, changeLimit: number): void {
		const section = this.section(root, "Recent activity", "kaos-dashboard-activity-section");
		if (data.recentChanges.status !== "ready") {
			section.createDiv({ text: data.recentChanges.message, cls: `kaos-dashboard-${data.recentChanges.status === "error" ? "error" : "muted"}` });
			return;
		}
		if (data.recentChanges.changes.length === 0) {
			section.createDiv({ text: "No recent file changes.", cls: "kaos-dashboard-muted" });
			return;
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const change of data.recentChanges.changes.slice(0, changeLimit)) {
			this.renderRecentChange(list, change, data.settings.deviceName);
		}
	}

	private renderHandoffRecovery(
		root: HTMLElement,
		recovery: DashboardHandoffRecovery,
	): void {
		const section = this.section(
			root,
			`Handoff Recovery (${recovery.activeCount})`,
			"kaos-dashboard-handoff-recovery-section",
		);
		section.createDiv({
			text: "Device-local interrupted input. These items are separate from Attention and do not block sync.",
			cls: "kaos-dashboard-muted kaos-dashboard-section-copy",
		});
		if (recovery.issues.length > 0) {
			section.createDiv({
				text: `${recovery.issues.length} Recovery storage issue(s) need review.`,
				cls: "kaos-dashboard-error",
			});
		}
		if (recovery.terminalCount > 0) {
			section.createDiv({
				text: `${recovery.terminalCount} content-free completion receipt(s) retained.`,
				cls: "kaos-dashboard-muted",
			});
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const item of recovery.items) {
			const row = list.createDiv({
				cls: "kaos-dashboard-row kaos-dashboard-handoff-recovery-row",
			});
			row.createDiv({
				text: `${item.fromPath ?? "Unknown source"} → ${item.targetPath}`,
				cls: "kaos-dashboard-path",
			});
			row.createDiv({
				text: `${item.originKind} · ${item.afterLength} characters · ${formatDateTime(new Date(item.storedAt).toISOString())}`,
				cls: "kaos-dashboard-muted",
			});
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			this.button(
				actions,
				"Compare / apply manually",
				() => this.openHandoffRecoveryCompare(item),
			);
			if (item.fromPath) {
				const fromPath = item.fromPath;
				this.button(actions, "Open A", () => this.openPath(fromPath));
			}
			this.button(
				actions,
				"Copy",
				() => this.deps.actions.copyHandoffRecovery(
					item.recordId,
					item.expectedChecksum,
				),
			);
			this.button(actions, "Export", () => this.exportHandoffRecovery(item));
			this.button(
				actions,
				"Resolve",
				() => this.confirmResolveHandoffRecovery(item),
			);
			const discard = this.button(
				actions,
				"Discard",
				() => this.confirmDiscardHandoffRecovery(item),
			);
			discard.addClass("mod-warning");
		}
		if (recovery.activeCount > 0 || recovery.terminalCount > 0 || recovery.issues.length > 0) {
			const scopeActions = section.createDiv({ cls: "kaos-dashboard-row-actions" });
			const clear = this.button(
				scopeActions,
				"Clear device-local Recovery",
				() => this.confirmClearHandoffRecovery(),
			);
			clear.addClass("mod-warning");
		}
	}

	private async openHandoffRecoveryCompare(
		item: DashboardHandoffRecoveryItem,
	): Promise<void> {
		const record = await this.deps.actions.loadHandoffRecovery(
			item.recordId,
			item.expectedChecksum,
		);
		if (record.recordId !== item.recordId || record.checksum !== item.expectedChecksum) {
			throw new Error("Handoff Recovery record changed before comparison");
		}
		new HandoffRecoveryCompareModal(this.app, {
			record,
			onCopy: () => this.deps.actions.copyHandoffRecovery(
				item.recordId,
				item.expectedChecksum,
			),
		}).open();
	}

	private async exportHandoffRecovery(item: DashboardHandoffRecoveryItem): Promise<void> {
		const path = await requestHandoffRecoveryExportPath(
			this.app,
			`Handoff Recovery ${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
		);
		if (path === null) return;
		const result = await this.deps.actions.exportHandoffRecovery(
			item.recordId,
			item.expectedChecksum,
			path,
		);
		new Notice(`Recovery exported to ${result.path}.`);
	}

	private confirmResolveHandoffRecovery(
		item: DashboardHandoffRecoveryItem,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				"Resolve handoff Recovery",
				"Confirm that manual handling is complete. The stored body will be removed and a content-free receipt retained.",
				async () => {
					try {
						await this.deps.actions.resolveHandoffRecovery(
							item.recordId,
							item.expectedChecksum,
						);
						new Notice("Handoff recovery resolved.");
						resolve();
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				},
				"Resolve",
				"Cancel",
				resolve,
				"mod-cta",
			).open();
		});
	}

	private confirmDiscardHandoffRecovery(
		item: DashboardHandoffRecoveryItem,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				"Discard handoff Recovery",
				"Remove this stored body without modifying either note? This cannot be undone.",
				async () => {
					try {
						await this.deps.actions.discardHandoffRecovery(
							item.recordId,
							item.expectedChecksum,
						);
						new Notice("Handoff recovery discarded.");
						resolve();
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				},
				"Discard",
				"Cancel",
				resolve,
			).open();
		});
	}

	private confirmClearHandoffRecovery(): Promise<void> {
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				"Clear device-local Recovery",
				`Delete active bodies and receipts for vault ${this.data?.settings.vaultId ?? "unknown"} on this device? Other vault/device scopes are not changed.`,
				async () => {
					try {
						const result = await this.deps.actions.clearHandoffRecoveryScope();
						if (result.kind === "blocked") {
							new Notice("Recovery clear is waiting for settlement review.", 7000);
						} else {
							new Notice(`Cleared ${result.deletedCount} Recovery record(s).`);
						}
						resolve();
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				},
				"Clear",
				"Cancel",
				resolve,
			).open();
		});
	}

	private renderRecovery(root: HTMLElement, data: KaosDashboardData): void {
		const section = this.section(root, "Recovery", "kaos-dashboard-recovery-section");
		section.createDiv({
			text: "File history and vault snapshots provide separate recovery points.",
			cls: "kaos-dashboard-muted kaos-dashboard-section-copy",
		});
		const grid = section.createDiv({ cls: "kaos-dashboard-recovery-grid" });
		const snapshotRow = grid.createDiv({ cls: "kaos-dashboard-recovery-card" });
		snapshotRow.createDiv({ text: "Vault snapshots", cls: "kaos-dashboard-recovery-label" });
		if (data.snapshotStatus.status === "ready") {
			const summary = data.snapshotStatus.summary;
			snapshotRow.createDiv({
				text: `${summary.snapshotCountLowerBound} vault snapshot(s), ${formatBytes(summary.estimatedStorageBytesLowerBound)} stored`,
				cls: "kaos-dashboard-strong kaos-dashboard-recovery-value",
			});
			snapshotRow.createDiv({
				text: summary.latestCreatedAt ? `latest ${formatDateTime(summary.latestCreatedAt)}` : "no vault snapshot timestamp",
				cls: "kaos-dashboard-muted",
			});
		} else {
			snapshotRow.createDiv({ text: data.snapshotStatus.message, cls: `kaos-dashboard-${data.snapshotStatus.status === "error" ? "error" : "muted"}` });
		}

		const historyRow = grid.createDiv({ cls: "kaos-dashboard-recovery-card" });
		historyRow.createDiv({ text: "File history", cls: "kaos-dashboard-recovery-label" });
		this.renderFileHistoryState(historyRow, data.recentChanges);

		const storage = recoveryStorageDisplay(data.recoveryStorageStatus);
		const storageRow = grid.createDiv({ cls: `kaos-dashboard-recovery-card ${toneClass(storage.tone)}` });
		storageRow.createDiv({ text: "Recovery storage", cls: "kaos-dashboard-recovery-label" });
		storageRow.createDiv({
			text: storage.label,
			cls: "kaos-dashboard-strong kaos-dashboard-recovery-value",
		});
		if (storage.detail) {
			storageRow.createDiv({
				text: storage.detail,
				cls: storage.tone === "error" ? "kaos-dashboard-error" : "kaos-dashboard-muted",
			});
		}
	}

	private renderFileHistoryState(section: HTMLElement, recentChanges: DashboardRecentChanges): void {
		const row = section.createDiv({ cls: "kaos-dashboard-snapshot-summary" });
		if (recentChanges.status === "ready") {
			row.createDiv({
				text: recentChanges.latestCreatedAt
					? `Latest file history point: ${formatDateTime(recentChanges.latestCreatedAt)}`
					: "Latest file history point: none",
				cls: "kaos-dashboard-strong",
			});
		}
		if (recentChanges.lastAttempt) {
			row.createDiv({
				text: formatFileHistoryAttempt(recentChanges.lastAttempt),
				cls: `kaos-dashboard-muted ${toneClass(fileHistoryAttemptTone(recentChanges.lastAttempt))}`,
			});
		}
		if (recentChanges.status !== "ready" && !recentChanges.lastAttempt) {
			row.createDiv({
				text: "Latest file history point: unavailable",
				cls: "kaos-dashboard-muted",
			});
		}
	}

	private renderRecentChange(parent: HTMLElement, change: DashboardRecentChange, currentDeviceName: string): void {
		const row = parent.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-recent-row" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.setAttr("aria-label", `Review file history for ${change.path}`);
		row.addEventListener("click", () => {
			void this.openRecentChangeHistory(change);
		});
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void this.openRecentChangeHistory(change);
		});
		const mainLine = row.createDiv({
			cls: `kaos-dashboard-recent-main ${changeKindClass(change.changeKind)}`,
		});
		mainLine.createEl("span", {
			text: displayChangeKind(change.changeKind),
			cls: "kaos-dashboard-event-badge",
		});
		mainLine.createEl("span", {
			text: change.oldPath && change.newPath
				? `${change.oldPath} → ${change.newPath}`
				: change.path,
			cls: "kaos-dashboard-path kaos-dashboard-recent-path",
		});
		const actions = mainLine.createDiv({ cls: "kaos-dashboard-recent-actions" });
		actions.addEventListener("click", (event) => event.stopPropagation());
		this.button(actions, "Open", () => this.openPath(change.path));
		const metadata = [
			formatDateTime(change.createdAt),
			change.size !== null ? formatBytes(change.size) : "",
			change.device ? formatDashboardDeviceName(change.device, currentDeviceName) : "",
		].filter(Boolean).join(" · ");
		row.createDiv({ text: metadata, cls: "kaos-dashboard-muted kaos-dashboard-recent-meta" });
	}

	private async openRecentChangeHistory(change: DashboardRecentChange): Promise<void> {
		await this.deps.actions.showRecoveryHistory({
			initialManifestId: change.manifestId,
			initialFileId: change.fileId,
			autoExpandDiff: Boolean(change.contentHash || change.previousContentHash),
		});
	}

	private renderConflicts(root: HTMLElement, conflicts: DashboardConflictArtifact[], currentDeviceName: string): void {
		const section = this.section(root, `Conflicts (${conflicts.length})`, "kaos-dashboard-callout is-error");
		if (conflicts.length === 0) {
			section.createDiv({ text: "No conflict artifacts found.", cls: "kaos-dashboard-muted" });
			return;
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const artifact of conflicts) {
			const row = list.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-conflict-row" });
			row.createDiv({ text: artifact.inferredOriginalPath, cls: "kaos-dashboard-path" });
			const details = [
				artifact.kind,
				artifact.source ?? "unknown side",
				formatDateTime(artifact.timestamp),
				artifact.originalExists ? "original exists" : "original missing",
				artifact.originalPathConfidence === "possibly-truncated" ? "path may be truncated" : "",
				artifact.artifactIndexed ? "indexed" : "local-only",
			].filter(Boolean).join(" · ");
			row.createDiv({ text: details, cls: "kaos-dashboard-muted" });
			if (artifact.deviceName) {
				row.createDiv({
					text: formatDashboardDeviceName(artifact.deviceName, currentDeviceName),
					cls: "kaos-dashboard-device-line",
				});
			}
			row.createDiv({ text: artifact.artifactPath, cls: "kaos-dashboard-subpath" });
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			if (artifact.kind === "markdown") {
				this.button(
					actions,
					"Use artifact",
					() => this.confirmDashboardConflictResolution(artifact, { kind: "artifact" }),
					!artifact.originalExists,
				);
				this.button(
					actions,
					"Use original",
					() => this.confirmDashboardConflictResolution(artifact, { kind: "original" }),
					!artifact.originalExists,
				);
			} else {
				const resolution = artifact.blobResolution;
				const target = resolution ? {
					...resolution,
					path: artifact.inferredOriginalPath,
					artifactPath: artifact.artifactPath,
				} satisfies DashboardBlobConflictResolutionTarget : null;
				const unavailableReason = resolution === null
					? "No exact active conflict episode is available for this copy."
					: null;
				this.button(
					actions,
					"Keep local original",
					() => {
						if (!target) throw new Error("The active attachment conflict is unavailable.");
						return this.confirmBlobConflictResolution(target, "keep-local");
					},
					target === null || !resolution?.canKeepLocal,
					resolution?.keepLocalUnavailableReason ?? unavailableReason ?? undefined,
				);
				this.button(
					actions,
					"Use remote copy",
					() => {
						if (!target) throw new Error("The active attachment conflict is unavailable.");
						return this.confirmBlobConflictResolution(target, "use-remote-copy");
					},
					target === null || !resolution?.canUseRemoteCopy,
					resolution?.useRemoteCopyUnavailableReason ?? unavailableReason ?? undefined,
				);
				const keepLocalReason = resolution?.canKeepLocal === false
					? resolution.keepLocalUnavailableReason
					: null;
				const useRemoteReason = resolution?.canUseRemoteCopy === false
					? resolution.useRemoteCopyUnavailableReason
					: null;
				if (unavailableReason) {
					row.createDiv({
						text: unavailableReason,
						cls: "kaos-dashboard-muted",
					});
				} else if (keepLocalReason && keepLocalReason === useRemoteReason) {
					row.createDiv({
						text: `Resolution unavailable: ${keepLocalReason}`,
						cls: "kaos-dashboard-muted",
					});
				} else {
					if (keepLocalReason) {
						row.createDiv({
							text: `Keep local unavailable: ${keepLocalReason}`,
							cls: "kaos-dashboard-muted",
						});
					}
					if (useRemoteReason) {
						row.createDiv({
							text: `Use remote copy unavailable: ${useRemoteReason}`,
							cls: "kaos-dashboard-muted",
						});
					}
				}
			}
			this.button(actions, "View diff", () => this.openConflictDiff(artifact), artifact.kind !== "markdown" || !artifact.originalExists);
			this.button(actions, "Open artifact", () => this.openPath(artifact.artifactPath));
			this.button(actions, "Open original", () => this.openPath(artifact.inferredOriginalPath), !artifact.originalExists);
		}
	}

	private renderBlobSafetyCopies(
		root: HTMLElement,
		copies: DashboardConflictArtifact[],
	): void {
		const section = this.section(root, `Attachment safety copies (${copies.length})`, "kaos-dashboard-callout is-muted");
		section.createDiv({
			text: "These local-only rollback copies come from safe attachment replacement or remote deletion. They are not sync conflicts; review them before deleting them manually.",
			cls: "kaos-dashboard-muted",
		});
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const copy of copies) {
			const originalPathCertain = copy.originalPathConfidence !== "possibly-truncated";
			const row = list.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-conflict-row" });
			row.createDiv({ text: copy.artifactPath, cls: "kaos-dashboard-path" });
			row.createDiv({
				text: [
					"local rollback copy",
					formatDateTime(copy.timestamp),
					originalPathCertain
						? copy.originalExists ? "current attachment exists" : "current attachment missing"
						: "current path may be truncated",
					"local-only",
				].join(" · "),
				cls: "kaos-dashboard-muted",
			});
			row.createDiv({
				text: `${originalPathCertain ? "Current path" : "Possible current path"}: ${copy.inferredOriginalPath}`,
				cls: "kaos-dashboard-subpath",
			});
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			this.button(actions, "Open copy", () => this.openPath(copy.artifactPath));
			this.button(
				actions,
				"Open current",
				() => this.openPath(copy.inferredOriginalPath),
				!originalPathCertain || !copy.originalExists,
				!originalPathCertain
					? "The original basename was truncated; locate the current attachment manually."
					: undefined,
			);
			this.button(actions, "Copy path", () => this.copyPath(copy.artifactPath));
		}
	}

	private renderAttention(
		root: HTMLElement,
		items: DashboardAttentionItem[],
		totalCount: number,
	): void {
		const attentionTone = items.some((item) => item.tone === "error") ? "error" : "warn";
		const section = this.section(root, `Attention (${totalCount})`, `kaos-dashboard-callout is-${attentionTone}`);
		if (totalCount === 0) {
			section.createDiv({ text: "No files currently need attention.", cls: "kaos-dashboard-muted" });
			return;
		}
		if (items.length < totalCount) {
			section.createDiv({
				text: `Showing ${items.length} representative row(s) for ${totalCount} attention item(s).`,
				cls: "kaos-dashboard-muted",
			});
		}
		section.createDiv({
			text: "Remote deletions can be resolved here. Other attention types show the safest available next step.",
			cls: "kaos-dashboard-muted kaos-dashboard-attention-help",
		});
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const item of items) {
			const row = list.createDiv({ cls: `kaos-dashboard-row ${toneClass(item.tone)}` });
			row.createDiv({ text: item.path ?? item.title, cls: "kaos-dashboard-path" });
			if (item.structuralChange) {
				this.renderStructuralChangeDetail(row, item.structuralChange);
			} else {
				row.createDiv({ text: `${item.title} · ${item.detail}`, cls: "kaos-dashboard-muted" });
			}
			if (item.lastSeenAt) {
				row.createDiv({ text: `last ${formatDateTime(item.lastSeenAt)}`, cls: "kaos-dashboard-muted" });
			}
			const path = item.path;
			if (path) {
				const actions = row.createDiv({ cls: "kaos-dashboard-row-actions kaos-dashboard-attention-actions" });
				this.button(actions, "Open file", () => this.openPath(path));
				this.button(actions, "Copy path", () => this.copyPath(path));
				const resolution = item.resolution;
				if (resolution?.kind === "remote-delete") {
					const actionPending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					const pending = actionPending || resolution.keepLocalPending;
					this.button(
						actions,
						resolution.keepLocalPending
							? "Publishing local file…"
							: actionPending ? "Resolving…" : "Keep local file",
						() => this.confirmRemoteDeleteResolution(
							path,
							resolution,
							"keep-local",
						),
						pending || !resolution.canKeepLocal,
						resolution.keepLocalUnavailableReason ?? undefined,
					);
					const acceptDeleteButton = this.button(
						actions,
						"Accept remote delete",
						() => this.confirmRemoteDeleteResolution(
							path,
							resolution,
							"accept-remote-delete",
						),
						pending || !resolution.canAcceptRemoteDelete,
						resolution.acceptRemoteDeleteUnavailableReason ?? undefined,
					);
					acceptDeleteButton.classList.add("mod-warning");
				} else if (resolution?.kind === "legacy-missing-blob") {
					const pending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					this.button(
						actions,
						pending ? "Resolving…" : "Download remote file",
						() => this.confirmLegacyMissingBlobResolution(
							path,
							resolution,
							"download-remote",
						),
						pending || !resolution.canDownloadRemote,
						resolution.unavailableReason
							?? (resolution.remoteRef === null
								? "The remote attachment no longer exists."
								: undefined),
					);
					const keepAbsentButton = this.button(
						actions,
						"Keep local absence",
						() => this.confirmLegacyMissingBlobResolution(
							path,
							resolution,
							"keep-local-absent",
						),
						pending || !resolution.canKeepLocalAbsent,
						resolution.unavailableReason ?? undefined,
					);
					keepAbsentButton.classList.add("mod-warning");
				} else {
					this.button(
						actions,
						"Manual review required",
						async () => undefined,
						true,
						this.getManualAttentionReason(item),
					);
				}
			} else {
				const actions = row.createDiv({ cls: "kaos-dashboard-row-actions kaos-dashboard-attention-actions" });
				this.button(
					actions,
					"Run reconcile again",
					async () => this.deps.actions.forceReconcile(),
				);
				this.button(
					actions,
					"No direct file action",
					async () => undefined,
					true,
					"This attention item describes a structural or vault-wide condition, not one file.",
				);
			}
		}
	}

	private renderStructuralChangeDetail(
		row: HTMLElement,
		change: NonNullable<DashboardAttentionItem["structuralChange"]>,
	): void {
		const fields = row.createDiv({ cls: "kaos-dashboard-structural-fields" });
		this.renderStructuralChangeField(fields, "Old", change.oldPaths.join(", ") || "(none)");
		this.renderStructuralChangeField(fields, "New", change.newPaths.join(", ") || "(none)");
		this.renderStructuralChangeField(fields, "Hash", change.contentHashPrefix);
	}

	private renderStructuralChangeField(parent: HTMLElement, label: string, value: string): void {
		const field = parent.createDiv({ cls: "kaos-dashboard-structural-field" });
		field.createSpan({ text: `${label}:`, cls: "kaos-dashboard-structural-label" });
		field.createSpan({ text: value, cls: "kaos-dashboard-muted" });
	}

	private getManualAttentionReason(item: DashboardAttentionItem): string {
		switch (item.kind) {
			case "frontmatter-quarantine":
				return "KAOS blocked unsafe frontmatter. Inspect and correct the file before reconciling again.";
			case "preserved-unresolved":
				return "This is not an authoritative remote deletion, so deleting or overwriting the file automatically would be unsafe.";
			case "structural-change":
			case "blocked-divergence":
				return "This condition must be reviewed and reconciled before KAOS can choose a safe file operation.";
			case "remote-projection-policy":
				return "Correct the shared exclude policy; local and editor changes remain active while remote projection is paused.";
		}
	}

	private confirmRemoteDeleteResolution(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
		choice: DashboardRemoteDeleteResolutionChoice,
	): Promise<void> {
		const keepingLocal = choice === "keep-local";
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepingLocal ? "Keep local file?" : "Accept remote delete?",
				keepingLocal
					? `Revive "${path}" and publish this local ${resolution.fileKind} to synced devices? The remote deletion will be ignored.`
					: `Delete the local copy of "${path}" using Obsidian's configured delete behavior? The remote deletion will be kept.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveRemoteDeleteAttention(
							{ path, ...resolution },
							choice,
						);
						if (result.status === "pending") {
							this.markAttentionEpisodePending(path, resolution);
							new Notice(result.message, 7000);
						} else {
							new Notice(
								keepingLocal
									? `Local file kept: ${path}`
									: `Remote deletion accepted: ${path}`,
							);
							this.removeResolvedAttentionEpisode(path, resolution);
						}
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				keepingLocal ? "Keep local file" : "Accept remote delete",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				keepingLocal ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private confirmLegacyMissingBlobResolution(
		path: string,
		resolution: DashboardLegacyMissingBlobResolution,
		choice: DashboardLegacyMissingBlobResolutionChoice,
	): Promise<void> {
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		const downloading = choice === "download-remote";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				downloading ? "Download remote attachment?" : "Keep the local deletion?",
				downloading
					? `Restore "${path}" from the exact remote version currently shown?`
					: `Keep "${path}" absent and delete only the exact remote version currently shown? Other devices will observe the deletion.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveLegacyMissingBlobAttention(
							{ path, ...resolution },
							choice,
						);
						new Notice(result.status === "pending"
							? result.message
							: downloading
								? `Remote attachment queued: ${path}`
								: `Local absence kept: ${path}`,
							7_000,
						);
						this.removeResolvedLegacyMissingEpisode(path, resolution);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				downloading ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private removeResolvedLegacyMissingEpisode(
		path: string,
		resolution: DashboardLegacyMissingBlobResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "legacy-missing-blob") {
				return true;
			}
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private removeResolvedAttentionEpisode(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "remote-delete") return true;
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private markAttentionEpisodePending(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
	): void {
		if (!this.data) return;
		this.data = {
			...this.data,
			attention: this.data.attention.map((item) => {
				if (
					item.path !== path
					|| item.resolution?.kind !== "remote-delete"
					|| item.resolution.episodeId !== resolution.episodeId
				) return item;
				return {
					...item,
					resolution: {
						...item.resolution,
						keepLocalPending: true,
						canKeepLocal: false,
						canAcceptRemoteDelete: false,
						keepLocalUnavailableReason: "The local attachment is still being published.",
						acceptRemoteDeleteUnavailableReason: "Wait for the pending Keep local upload to finish.",
					},
				};
			}),
		};
	}

	private section(root: HTMLElement, title: string, extraClass = ""): HTMLElement {
		const section = root.createDiv({
			cls: ["kaos-dashboard-section", extraClass].filter(Boolean).join(" "),
		});
		section.createEl("h3", { text: title });
		return section;
	}

	private button(
		parent: HTMLElement,
		label: string,
		action: () => void | Promise<void>,
		disabled = false,
		disabledReason?: string,
		refreshAfterAction = true,
	): HTMLButtonElement {
		const button = parent.createEl("button", { text: label });
		button.disabled = disabled;
		if (disabled && disabledReason) {
			button.title = disabledReason;
			button.setAttribute("aria-label", `${label}: ${disabledReason}`);
		}
		button.addEventListener("click", () => {
			if (button.disabled) return;
			button.disabled = true;
			Promise.resolve(action())
				.then(() => refreshAfterAction ? this.refresh(true) : undefined)
				.catch((err) => {
					new Notice(`${label} failed: ${formatUnknown(err)}`, 7000);
					console.warn(`[kaos] dashboard action failed: ${label}`, err);
				})
				.finally(() => {
					button.disabled = disabled;
				});
		});
		return button;
	}

	private async openPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${path}`, 5000);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async openConflictDiff(artifact: DashboardConflictArtifact): Promise<void> {
		if (artifact.kind !== "markdown") {
			new Notice("Diff is available for text-document conflict artifacts.");
			return;
		}
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			new Notice("Both the conflict artifact and original document are required for diff.", 5000);
			return;
		}
		const [originalText, artifactText] = await Promise.all([
			this.app.vault.read(originalFile),
			this.app.vault.read(artifactFile),
		]);
		const resolutionSnapshot = captureConflictResolutionSnapshot({
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			artifactFile,
			originalFile,
			artifactText,
			originalText,
		});
		const baseHash = this.deps.getConflictMergeBaseHash?.(artifact.artifactPath) ?? null;
		const baseText = baseHash ? await this.deps.getBaselineText?.(baseHash) ?? null : null;
		new ConflictDiffModal(this.app, {
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			originalText,
			artifactText,
			baseHash,
			baseText,
			onResolve: (choice) => this.resolveConflictArtifact(resolutionSnapshot, choice),
		}).open();
	}

	private async resolveConflictArtifact(
		snapshot: ConflictResolutionSnapshot,
		choice: ConflictResolutionChoice,
	): Promise<void> {
		await resolveConflictArtifactWithCas(this.app.vault, snapshot, choice);
		this.deps.clearConflictMergeBase?.(snapshot.artifactPath);
		await this.refresh(true);
	}

	private confirmDashboardConflictResolution(
		artifact: DashboardConflictArtifact,
		choice: Extract<ConflictResolutionChoice, { kind: "original" | "artifact" }>,
	): Promise<void> {
		const useArtifact = choice.kind === "artifact";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				useArtifact ? "Use conflict artifact?" : "Use original document?",
				useArtifact
					? `Replace "${artifact.inferredOriginalPath}" with the conflict artifact content and move the conflict artifact to trash?`
					: `Keep "${artifact.inferredOriginalPath}" as the selected version and move the conflict artifact to trash?`,
				async () => {
					try {
						await this.resolveConflictArtifactFromDashboard(artifact, choice);
						new Notice(
							useArtifact
								? "Conflict resolved using artifact. Conflict artifact moved to trash."
								: "Original selected. Conflict artifact moved to trash.",
						);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				},
				useArtifact ? "Use artifact" : "Use original",
				"Cancel",
				resolve,
				"mod-cta",
			).open();
		});
	}

	private confirmBlobConflictResolution(
		target: DashboardBlobConflictResolutionTarget,
		choice: DashboardBlobConflictResolutionChoice,
	): Promise<void> {
		const keepLocal = choice === "keep-local";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepLocal ? "Keep local attachment?" : "Use remote attachment copy?",
				keepLocal
					? `Publish the current local attachment at "${target.path}" as the selected version? The remote conflict copy remains recoverable until the upload settles.`
					: `Replace "${target.path}" with the reviewed remote copy? If the current local attachment differs, KAOS will preserve it as a local rollback safety copy.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveBlobConflict(target, choice);
						const message = result.status === "pending"
							? result.message
							: keepLocal
								? "Local attachment selected. Publishing is complete."
								: [
									"Remote attachment copy selected.",
									result.safetyCopyPath
										? `The previous local version was preserved at "${result.safetyCopyPath}".`
										: "No additional local safety copy was needed.",
									result.artifactRemoved
										? ""
										: "The reviewed conflict copy could not be moved to trash; review it manually.",
								].filter(Boolean).join(" ");
						new Notice(message, result.status === "completed" && !result.artifactRemoved ? 9000 : 6000);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				},
				keepLocal ? "Keep local original" : "Use remote copy",
				"Cancel",
				resolve,
				"mod-cta",
			).open();
		});
	}

	private async resolveConflictArtifactFromDashboard(
		artifact: DashboardConflictArtifact,
		choice: Extract<ConflictResolutionChoice, { kind: "original" | "artifact" }>,
	): Promise<void> {
		if (artifact.kind !== "markdown" || !artifact.originalExists) {
			throw new Error("Both text documents must exist before choosing a conflict version.");
		}
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			throw new Error("Both the conflict artifact and original document are required before choosing a version.");
		}
		const [originalText, artifactText] = await Promise.all([
			this.app.vault.read(originalFile),
			this.app.vault.read(artifactFile),
		]);
		await this.resolveConflictArtifact(
			captureConflictResolutionSnapshot({
				artifactPath: artifact.artifactPath,
				originalPath: artifact.inferredOriginalPath,
				artifactFile,
				originalFile,
				artifactText,
				originalText,
			}),
			choice,
		);
	}

	private async copyPath(path: string): Promise<void> {
		await navigator.clipboard.writeText(path);
		new Notice("Path copied.");
	}
}

interface HandoffRecoveryCompareModalData {
	record: ActiveHandoffRecoveryRecord;
	onCopy(): Promise<void>;
}

class HandoffRecoveryCompareModal extends Modal {
	constructor(
		app: App,
		private readonly data: HandoffRecoveryCompareModalData,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("kaos-handoff-recovery-compare-modal");
		this.contentEl.createEl("h3", { text: "Handoff recovery comparison" });
		this.contentEl.createDiv({
			text: `${this.data.record.fromPath ?? "Unknown source"} → ${this.data.record.targetPath}`,
			cls: "kaos-dashboard-path",
		});
		this.contentEl.createDiv({
			text: "Slice 2 never applies this content automatically. Review the captured change, then handle it manually in the appropriate note.",
			cls: "kaos-dashboard-muted kaos-dashboard-section-copy",
		});
		const actions = this.contentEl.createDiv({
			cls: "modal-button-container kaos-conflict-diff-actions",
		});
		const copy = actions.createEl("button", { text: "Copy successor" });
		copy.addEventListener("click", () => {
			copy.disabled = true;
			void this.data.onCopy()
				.then(() => new Notice("Recovery successor copied."))
				.catch((error) => {
					new Notice(`Recovery copy failed: ${formatUnknown(error)}`, 7000);
				})
				.finally(() => { copy.disabled = false; });
		});
		actions.createEl("button", { text: "Close" }).addEventListener("click", () => {
			this.close();
		});
		const legend = this.contentEl.createDiv({ cls: "kaos-conflict-diff-legend" });
		legend.createEl("span", { text: "- captured start", cls: "kaos-conflict-diff-delete" });
		legend.createEl("span", { text: "+ captured successor", cls: "kaos-conflict-diff-insert" });
		const diffBody = this.contentEl.createDiv({ cls: "kaos-conflict-diff-body" });
		this.renderDiffLines(
			diffBody,
			buildTextDiffLines(
				this.data.record.body.startContent,
				this.data.record.body.afterContent,
				{ maxSegments: 80, maxLinesPerSegment: 20, contextLines: 15 },
			),
		);
	}

	onClose(): void {
		this.contentEl.removeClass("kaos-handoff-recovery-compare-modal");
		this.contentEl.empty();
	}

	private renderDiffLines(parent: HTMLElement, lines: RenderedDiffLine[]): void {
		for (const line of lines) {
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const cls = line.kind === "delete"
				? "kaos-conflict-diff-line is-delete"
				: line.kind === "insert"
					? "kaos-conflict-diff-line is-insert"
					: line.kind === "context"
						? "kaos-conflict-diff-line is-context"
						: "kaos-conflict-diff-line";
			parent.createDiv({ text: `${prefix}${line.text}` || " ", cls });
		}
	}
}

interface ConflictDiffModalData {
	artifactPath: string;
	originalPath: string;
	originalText: string;
	artifactText: string;
	baseHash: string | null;
	baseText: string | null;
	onResolve(choice: ConflictResolutionChoice): Promise<void>;
}

interface ManualMergeModel {
	mode: "clean" | "three-way" | "two-way";
	hunks: ThreeWayMergeConflictHunk[];
	segments: ThreeWayMergeSegment[];
	cleanText?: string;
}

class ConflictDiffModal extends Modal {
	private mergeModel: ManualMergeModel | null = null;
	private hunkEdits = new Map<number, string>();
	private previewEl: HTMLTextAreaElement | null = null;

	constructor(
		app: App,
		private readonly data: ConflictDiffModalData,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("kaos-conflict-diff-modal-frame");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("kaos-conflict-diff-modal");
		contentEl.createEl("h3", { text: "Conflict diff" });

		const pathGrid = contentEl.createDiv({ cls: "kaos-conflict-diff-paths" });
		this.renderPath(pathGrid, "Original", this.data.originalPath);
		this.renderPath(pathGrid, "Conflict artifact", this.data.artifactPath);
		this.renderPath(pathGrid, "Base", this.data.baseHash ? `available (${this.data.baseHash.slice(0, 12)})` : "not available");

		const actions = contentEl.createDiv({ cls: "modal-button-container kaos-conflict-diff-actions" });
		actions.createEl("button", { text: "Use original" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "original" });
		});
		actions.createEl("button", { text: "Use artifact", cls: "mod-cta" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "artifact" });
		});
		actions.createEl("button", { text: "Apply merged", cls: "mod-cta" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "merged", mergedText: this.currentMergedText() });
		});
		actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());

		this.renderManualMerge(contentEl);

		contentEl.createEl("h4", { text: "Original vs artifact diff", cls: "kaos-conflict-diff-heading" });
		const legend = contentEl.createDiv({ cls: "kaos-conflict-diff-legend" });
		legend.createEl("span", { text: "- original", cls: "kaos-conflict-diff-delete" });
		legend.createEl("span", { text: "+ artifact", cls: "kaos-conflict-diff-insert" });

		const diffBody = contentEl.createDiv({ cls: "kaos-conflict-diff-body" });
		this.renderDiffLines(
			diffBody,
			buildTextDiffLines(this.data.originalText, this.data.artifactText, {
				maxSegments: 80,
				maxLinesPerSegment: 20,
				contextLines: 15,
			}),
		);
	}

	onClose(): void {
		this.modalEl.removeClass("kaos-conflict-diff-modal-frame");
		this.contentEl.empty();
	}

	private renderPath(parent: HTMLElement, label: string, path: string): void {
		const item = parent.createDiv({ cls: "kaos-conflict-diff-path-item" });
		item.createDiv({ text: label, cls: "kaos-conflict-diff-path-label" });
		item.createDiv({ text: path, cls: "kaos-conflict-diff-path-value" });
	}

	private renderManualMerge(parent: HTMLElement): void {
		this.mergeModel = this.buildMergeModel();
		this.hunkEdits.clear();
		const root = parent.createDiv({ cls: "kaos-conflict-merge" });
		root.createEl("h4", { text: this.mergeModel.mode === "two-way" ? "Manual merge" : "3-way merge" });

		if (this.mergeModel.hunks.length > 0) {
			for (const hunk of this.mergeModel.hunks) {
				this.hunkEdits.set(hunk.index, hunk.leftText);
				this.renderMergeHunk(root, hunk, this.mergeModel.mode);
			}
		}

		const previewWrap = root.createDiv({ cls: "kaos-conflict-merge-preview" });
		previewWrap.createDiv({ text: "Merged", cls: "kaos-conflict-diff-path-label" });
		this.previewEl = previewWrap.createEl("textarea", {
			cls: "kaos-conflict-merge-preview-text",
		});
		this.previewEl.readOnly = true;
		this.updateMergePreview();
	}

	private buildMergeModel(): ManualMergeModel {
		if (this.data.baseText !== null) {
			const result = mergeTexts3(this.data.baseText, this.data.originalText, this.data.artifactText);
			if (result.kind === "clean-merge") {
				return {
					mode: "clean",
					hunks: [],
					segments: [{ kind: "text", text: result.mergedText }],
					cleanText: result.mergedText,
				};
			}
			if (result.kind === "conflict") {
				return {
					mode: "three-way",
					hunks: result.hunks,
					segments: result.segments,
				};
			}
		}

		const fallbackHunk: ThreeWayMergeConflictHunk = {
			index: 0,
			baseStart: 0,
			baseEnd: 0,
			baseText: "",
			leftText: this.data.originalText,
			rightText: this.data.artifactText,
		};
		return {
			mode: "two-way",
			hunks: [fallbackHunk],
			segments: [{ kind: "conflict", hunkIndex: 0 }],
		};
	}

	private renderMergeHunk(parent: HTMLElement, hunk: ThreeWayMergeConflictHunk, mode: ManualMergeModel["mode"]): void {
		const item = parent.createDiv({ cls: "kaos-conflict-merge-hunk" });
		item.createDiv({
			text: `Hunk ${hunk.index + 1}`,
			cls: "kaos-conflict-merge-hunk-title",
		});

		const paneGrid = item.createDiv({ cls: "kaos-conflict-merge-pane-grid" });
		this.renderMergeSourcePane(paneGrid, "Base", hunk.baseText, {
			kind: "base",
			baseText: hunk.baseText,
			diffAgainstBase: false,
			unavailable: mode === "two-way",
		});
		this.renderMergeSourcePane(paneGrid, "Original", hunk.leftText, {
			kind: "original",
			baseText: hunk.baseText,
			diffAgainstBase: mode !== "two-way",
			unavailable: false,
		});
		this.renderMergeSourcePane(paneGrid, "Artifact", hunk.rightText, {
			kind: "artifact",
			baseText: hunk.baseText,
			diffAgainstBase: mode !== "two-way",
			unavailable: false,
		});

		const buttons = item.createDiv({ cls: "kaos-conflict-merge-hunk-actions" });
		const editor = item.createDiv({ cls: "kaos-conflict-merge-editor" });
		editor.createDiv({ text: "Merged", cls: "kaos-conflict-diff-path-label" });
		const textarea = editor.createEl("textarea", { cls: "kaos-conflict-merge-hunk-text" });
		textarea.value = hunk.leftText;
		textarea.addEventListener("input", () => {
			this.hunkEdits.set(hunk.index, textarea.value);
			this.updateMergePreview();
		});
		const setText = (text: string) => {
			textarea.value = text;
			this.hunkEdits.set(hunk.index, text);
			this.updateMergePreview();
		};
		buttons.createEl("button", { text: "Use original" }).addEventListener("click", () => setText(hunk.leftText));
		buttons.createEl("button", { text: "Use artifact" }).addEventListener("click", () => setText(hunk.rightText));
		buttons.createEl("button", { text: "Use both" }).addEventListener("click", () => setText(combineBoth(hunk.leftText, hunk.rightText)));
		buttons.createEl("button", { text: "Edit merged" }).addEventListener("click", () => textarea.focus());
	}

	private renderMergeSourcePane(
		parent: HTMLElement,
		label: string,
		text: string,
		options: {
			kind: "base" | "original" | "artifact";
			baseText: string;
			diffAgainstBase: boolean;
			unavailable: boolean;
		},
	): void {
		const pane = parent.createDiv({ cls: `kaos-conflict-merge-pane is-${options.kind}` });
		pane.createDiv({ text: label, cls: "kaos-conflict-merge-pane-label" });
		const body = pane.createDiv({ cls: "kaos-conflict-merge-pane-body" });
		if (options.unavailable) {
			this.renderMergeEmptyText(body, "Base not available");
			return;
		}
		if (options.kind === "base") {
			this.renderMergePlainText(body, text, "Empty base");
			return;
		}
		if (!options.diffAgainstBase) {
			this.renderMergePlainText(body, text, `Empty ${label.toLowerCase()}`);
			return;
		}
		this.renderMergeVariantDiff(body, options.baseText, text, options.kind);
	}

	private renderMergeVariantDiff(
		parent: HTMLElement,
		baseText: string,
		variantText: string,
		kind: "original" | "artifact",
	): void {
		const lines = buildTextDiffLines(baseText, variantText, {
			maxSegments: 200,
			maxLinesPerSegment: 200,
		});
		if (lines.length === 0) {
			this.renderMergeEmptyText(parent, "No changes");
			return;
		}
		for (const line of lines) {
			const changed = line.kind !== "equal" && line.kind !== "context";
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const text = line.text.length === 0 ? prefix : `${prefix}${line.text}`;
			const cls = [
				"kaos-conflict-merge-pane-line",
				changed ? `is-${kind}-change` : "",
				line.kind === "context" ? "is-context" : "",
			].filter(Boolean).join(" ");
			parent.createDiv({ text, cls });
		}
	}

	private renderMergePlainText(parent: HTMLElement, text: string, emptyText: string): void {
		const lines = splitDisplayLines(text);
		if (lines.length === 0) {
			this.renderMergeEmptyText(parent, emptyText);
			return;
		}
		for (const line of lines) {
			parent.createDiv({
				text: line.length === 0 ? "  " : `  ${line}`,
				cls: "kaos-conflict-merge-pane-line",
			});
		}
	}

	private renderMergeEmptyText(parent: HTMLElement, text: string): void {
		parent.createDiv({ text, cls: "kaos-conflict-merge-pane-empty" });
	}

	private currentMergedText(): string {
		const model = this.mergeModel ?? this.buildMergeModel();
		if (model.cleanText !== undefined) return model.cleanText;
		return model.segments.map((segment) => {
			if (segment.kind === "text") return segment.text;
			return this.hunkEdits.get(segment.hunkIndex) ?? "";
		}).join("");
	}

	private updateMergePreview(): void {
		if (!this.previewEl) return;
		this.previewEl.value = this.currentMergedText();
	}

	private renderDiffLines(parent: HTMLElement, lines: RenderedDiffLine[]): void {
		for (const line of lines) {
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const cls = line.kind === "delete"
				? "kaos-conflict-diff-line is-delete"
				: line.kind === "insert"
					? "kaos-conflict-diff-line is-insert"
					: line.kind === "context"
						? "kaos-conflict-diff-line is-context"
						: "kaos-conflict-diff-line";
			parent.createDiv({ text: `${prefix}${line.text}` || " ", cls });
		}
	}

	private confirmResolution(choice: ConflictResolutionChoice): void {
		const useArtifact = choice.kind === "artifact";
		const useMerged = choice.kind === "merged";
		new ConfirmModal(
			this.app,
			useMerged ? "Apply merged result?" : useArtifact ? "Use conflict artifact?" : "Use original note?",
			useMerged
				? `Replace "${this.data.originalPath}" with the merged result and move "${this.data.artifactPath}" to trash?`
				: useArtifact
				? `Replace "${this.data.originalPath}" with the conflict artifact content and move "${this.data.artifactPath}" to trash?`
				: `Keep "${this.data.originalPath}" as-is and move "${this.data.artifactPath}" to trash?`,
			() => this.applyResolution(choice),
			useMerged ? "Apply merged" : useArtifact ? "Use artifact" : "Use original",
			"Cancel",
		).open();
	}

	private async applyResolution(choice: ConflictResolutionChoice): Promise<void> {
		try {
			await this.data.onResolve(choice);
			new Notice(
				choice.kind === "merged"
					? "Conflict resolved using merged result. Conflict artifact moved to trash."
					: choice.kind === "artifact"
						? "Conflict resolved using artifact. Conflict artifact moved to trash."
						: "Original selected. Conflict artifact moved to trash.",
			);
			this.close();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Conflict resolution failed: ${message}`, 8000);
			console.warn("[kaos] conflict resolution failed:", err);
		}
	}
}

function combineBoth(left: string, right: string): string {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	if (left.endsWith("\n") || right.startsWith("\n")) return left + right;
	return `${left}\n${right}`;
}

function splitDisplayLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function toneClass(tone: string | undefined): string {
	return tone ? `is-${tone}` : "";
}

function displayChangeKind(kind: string): string {
	switch (kind) {
		case "created": return "Created";
		case "modified": return "Modified";
		case "renamed": return "Renamed";
		case "deleted": return "Deleted";
		case "restored": return "Restored";
		default: return kind;
	}
}

function changeKindClass(kind: string): string {
	return `is-change-${kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
}

function recoveryStorageDisplay(status: DashboardRecoveryStorageStatus): { label: string; tone: DashboardTone; detail: string } {
	if (status.status !== "ready") {
		return {
			label: "Unknown",
			tone: status.status === "error" ? "error" : "muted",
			detail: status.message,
		};
	}
	const report = status.report;
	switch (report.status) {
		case "healthy":
		case "empty":
			return {
				label: "Healthy",
				tone: "ok",
				detail: `${report.manifestCountLowerBound} manifest(s) checked`,
			};
		case "repaired":
			return {
				label: "Repaired",
				tone: "warn",
				detail: `${report.repairs.filter((repair) => repair.success).length} repair(s) applied`,
			};
		case "degraded":
			return {
				label: "Needs attention",
				tone: "error",
				detail: `${report.issues.filter((issue) => !issue.repaired).length} issue(s) remaining`,
			};
		case "unavailable":
			return {
				label: "Unknown",
				tone: "muted",
				detail: report.issues[0]?.message ?? "File history storage is unavailable.",
			};
	}
}

function fileHistoryAttemptTone(attempt: DashboardFileHistoryAttempt): DashboardTone {
	switch (attempt.status) {
		case "created":
			return "ok";
		case "pending":
			return "busy";
		case "unavailable":
			return "warn";
		case "noop":
			return "muted";
	}
}

function formatFileHistoryAttempt(attempt: DashboardFileHistoryAttempt): string {
	const detail = attempt.pending
		? `upload ${attempt.pending.uploadedContentCount}/${attempt.pending.totalContentCount} content object(s)`
		: attempt.changedCount !== null
			? `${attempt.changedCount} changed file(s)`
			: attempt.reason ?? "";
	const mode = attempt.forceFull ? "full scan" : "incremental";
	return [
		`Last attempt: ${attempt.status}`,
		detail,
		mode,
		formatDateTime(attempt.attemptedAt),
	].filter(Boolean).join(" - ");
}

function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUnknown(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function attentionEpisodeKey(
	path: string,
	resolution: Pick<DashboardRemoteDeleteResolution, "fileKind" | "episodeId">,
): string {
	return `${resolution.fileKind}:${path}:${resolution.episodeId}`;
}
