import { App, ItemView, Modal, Notice, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import type {
	DashboardAttentionItem,
	DashboardConflictArtifact,
	DashboardMetric,
	DashboardRecentChange,
	DashboardRecoveryStorageStatus,
	DashboardTone,
	KaosDashboardData,
} from "./dashboardTypes";
import {
	resolveKaosDashboardMode,
	selectMobileOverviewMetrics,
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

export const KAOS_DASHBOARD_VIEW_TYPE = "kaos-dashboard";

export interface KaosDashboardActions {
	reconnect(): void;
	forceReconcile(): void;
	importUntracked(): Promise<void>;
	takeSnapshotNow(): Promise<void>;
	showSnapshotList(): Promise<void>;
	createFileHistoryPoint(): Promise<void>;
	showRecoveryHistory(): Promise<void>;
	exportDiagnostics(): void;
	exportDiagnosticsWithFilenames(): void;
}

export interface KaosDashboardViewDeps {
	collectData(): Promise<KaosDashboardData>;
	getBaselineText?(contentHash: string): string | null;
	getConflictMergeBaseHash?(artifactPath: string): string | null;
	clearConflictMergeBase?(artifactPath: string): void;
	actions: KaosDashboardActions;
}

export class KaosDashboardView extends ItemView {
	private data: KaosDashboardData | null = null;
	private loading = false;
	private error: string | null = null;
	private refreshTimer: number | null = null;

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
		this.renderHeader(root, mode);
		if (!this.data && this.loading) {
			root.createDiv({ text: "Loading...", cls: "kaos-dashboard-muted" });
			return;
		}
		if (!this.data && this.error) {
			root.createDiv({ text: this.error, cls: "kaos-dashboard-error" });
			return;
		}
		if (!this.data) return;

		if (mode === "phone") {
			this.renderPhoneDashboard(root, this.data);
			return;
		}

		this.renderActions(root, this.data);
		this.renderOverview(root, this.data.overview);
		this.renderSnapshots(root, this.data);
		this.renderConflicts(root, this.data.conflicts, this.data.settings.deviceName);
		this.renderAttention(root, this.data.attention);
	}

	private getDashboardMode(): KaosDashboardMode {
		return resolveKaosDashboardMode(Platform);
	}

	private renderHeader(root: HTMLElement, mode: KaosDashboardMode): void {
		const header = root.createDiv({ cls: "kaos-dashboard-header" });
		header.createEl("h2", { text: mode === "phone" ? "Mobile dashboard" : "Dashboard" });
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

	private renderPhoneDashboard(root: HTMLElement, data: KaosDashboardData): void {
		this.renderMobileSummary(root, data);
		this.renderMobileActions(root, data);
		if (data.attention.length > 0) {
			this.renderAttention(root, data.attention);
		}
		if (data.conflicts.length > 0) {
			this.renderConflicts(root, data.conflicts, data.settings.deviceName);
		}
		this.renderSnapshots(root, data, 10);
		this.renderMobileOverview(root, selectMobileOverviewMetrics(data.overview));
	}

	private renderMobileSummary(root: HTMLElement, data: KaosDashboardData): void {
		const status = data.overview.find((metric) => metric.label === "Status");
		const connection = data.overview.find((metric) => metric.label === "Connection");
		const recentValue = data.recentChanges.status === "ready"
			? String(data.recentChanges.changes.length)
			: data.recentChanges.status;
		const metrics: DashboardMetric[] = [
			{ label: "Status", value: status?.value ?? "unknown", tone: status?.tone },
			{ label: "Connection", value: connection?.value ?? "unknown", tone: connection?.tone },
			{ label: "Attention", value: String(data.attention.length), tone: data.attention.length > 0 ? "warn" : "ok" },
			{ label: "Conflicts", value: String(data.conflicts.length), tone: data.conflicts.length > 0 ? "error" : "ok" },
			{ label: "Recent changes", value: recentValue, tone: data.recentChanges.status === "error" ? "error" : undefined },
			{
				label: "Vault snapshots",
				value: data.snapshotStatus.status === "ready"
					? String(data.snapshotStatus.summary.snapshotCountLowerBound)
					: data.snapshotStatus.status,
				tone: data.snapshotStatus.status === "error" ? "error" : undefined,
			},
		];
		this.renderMetricGrid(root, metrics, "kaos-dashboard-mobile-summary");
	}

	private renderActions(root: HTMLElement, data: KaosDashboardData): void {
		const section = root.createDiv({ cls: "kaos-dashboard-actionbar" });
		this.button(section, "Refresh", () => this.refresh());
		this.button(section, "Reconnect", async () => this.deps.actions.reconnect(), !data.actions.syncInitialized);
		this.button(section, "Force reconcile", async () => this.deps.actions.forceReconcile(), !data.actions.syncInitialized);
		this.button(
			section,
			`Import untracked${data.actions.untrackedFileCount > 0 ? ` (${data.actions.untrackedFileCount})` : ""}`,
			() => this.deps.actions.importUntracked(),
			!data.actions.syncInitialized || data.actions.untrackedFileCount === 0,
		);
		this.button(section, "Take vault snapshot", () => this.deps.actions.takeSnapshotNow(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Browse vault snapshots", () => this.deps.actions.showSnapshotList(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Create file history point", () => this.deps.actions.createFileHistoryPoint(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Review file history", () => this.deps.actions.showRecoveryHistory(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Export diagnostics", async () => this.deps.actions.exportDiagnostics());
		this.button(section, "Export with filenames", async () => this.deps.actions.exportDiagnosticsWithFilenames());
	}

	private renderMobileActions(root: HTMLElement, data: KaosDashboardData): void {
		const section = root.createDiv({ cls: "kaos-dashboard-actionbar kaos-dashboard-mobile-actionbar" });
		this.button(section, "Refresh", () => this.refresh());
		this.button(section, "Reconnect", async () => this.deps.actions.reconnect(), !data.actions.syncInitialized);
		this.button(section, "Reconcile", async () => this.deps.actions.forceReconcile(), !data.actions.syncInitialized);
		this.button(
			section,
			`Import${data.actions.untrackedFileCount > 0 ? ` (${data.actions.untrackedFileCount})` : ""}`,
			() => this.deps.actions.importUntracked(),
			!data.actions.syncInitialized || data.actions.untrackedFileCount === 0,
		);
		this.button(section, "Vault snapshot", () => this.deps.actions.takeSnapshotNow(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);

		const details = root.createEl("details", { cls: "kaos-dashboard-mobile-more-actions" });
		details.createEl("summary", { text: "More actions" });
		const more = details.createDiv({ cls: "kaos-dashboard-row-actions" });
		this.button(more, "Browse vault snapshots", () => this.deps.actions.showSnapshotList(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(more, "Create file history point", () => this.deps.actions.createFileHistoryPoint(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(more, "Review file history", () => this.deps.actions.showRecoveryHistory(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(more, "Export diagnostics", async () => this.deps.actions.exportDiagnostics());
		this.button(more, "Export with filenames", async () => this.deps.actions.exportDiagnosticsWithFilenames());
	}

	private renderOverview(root: HTMLElement, metrics: DashboardMetric[]): void {
		const section = this.section(root, "Overview");
		this.renderMetricGrid(section, metrics);
	}

	private renderMobileOverview(root: HTMLElement, metrics: DashboardMetric[]): void {
		const section = this.section(root, "Sync Detail");
		this.renderMetricGrid(section, metrics);
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

	private renderSnapshots(root: HTMLElement, data: KaosDashboardData, changeLimit = 40): void {
		const section = this.section(root, "Recent Changes");
		const snapshotRow = section.createDiv({ cls: "kaos-dashboard-snapshot-summary" });
		if (data.snapshotStatus.status === "ready") {
			const summary = data.snapshotStatus.summary;
			snapshotRow.createDiv({
				text: `${summary.snapshotCountLowerBound} vault snapshot(s), ${formatBytes(summary.estimatedStorageBytesLowerBound)} stored`,
				cls: "kaos-dashboard-strong",
			});
			snapshotRow.createDiv({
				text: summary.latestCreatedAt ? `latest ${formatDateTime(summary.latestCreatedAt)}` : "no vault snapshot timestamp",
				cls: "kaos-dashboard-muted",
			});
		} else {
			snapshotRow.createDiv({ text: data.snapshotStatus.message, cls: `kaos-dashboard-${data.snapshotStatus.status === "error" ? "error" : "muted"}` });
		}
		const storage = recoveryStorageDisplay(data.recoveryStorageStatus);
		const storageRow = section.createDiv({ cls: "kaos-dashboard-snapshot-summary" });
		storageRow.createDiv({
			text: `File history storage: ${storage.label}`,
			cls: `kaos-dashboard-strong ${toneClass(storage.tone)}`,
		});
		if (storage.detail) {
			storageRow.createDiv({
				text: storage.detail,
				cls: storage.tone === "error" ? "kaos-dashboard-error" : "kaos-dashboard-muted",
			});
		}

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

	private renderRecentChange(parent: HTMLElement, change: DashboardRecentChange, currentDeviceName: string): void {
		const row = parent.createDiv({ cls: "kaos-dashboard-row" });
		const eventLine = row.createDiv({
			cls: `kaos-dashboard-event-line ${changeKindClass(change.changeKind)}`,
		});
		eventLine.createEl("span", {
			text: displayChangeKind(change.changeKind),
			cls: "kaos-dashboard-event-badge",
		});
		eventLine.createEl("span", {
			text: formatDateTime(change.createdAt),
			cls: "kaos-dashboard-event-time",
		});
		row.createDiv({ text: change.path, cls: "kaos-dashboard-path kaos-dashboard-recent-path" });
		const details = [
			change.oldPath && change.newPath ? `${change.oldPath} -> ${change.newPath}` : "",
			"file history",
			change.size !== null ? formatBytes(change.size) : "",
		].filter(Boolean).join(" · ");
		if (details) {
			row.createDiv({ text: details, cls: "kaos-dashboard-muted" });
		}
		if (change.device) {
			row.createDiv({
				text: formatDashboardDeviceName(change.device, currentDeviceName),
				cls: "kaos-dashboard-device-line",
			});
		}
	}

	private renderConflicts(root: HTMLElement, conflicts: DashboardConflictArtifact[], currentDeviceName: string): void {
		const section = this.section(root, `Conflicts (${conflicts.length})`);
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
			this.button(actions, "View diff", () => this.openConflictDiff(artifact), artifact.kind !== "markdown" || !artifact.originalExists);
			this.button(actions, "Open artifact", () => this.openPath(artifact.artifactPath));
			this.button(actions, "Open original", () => this.openPath(artifact.inferredOriginalPath), !artifact.originalExists);
			this.button(actions, "Copy path", () => this.copyPath(artifact.artifactPath));
		}
	}

	private renderAttention(root: HTMLElement, items: DashboardAttentionItem[]): void {
		const section = this.section(root, `Attention (${items.length})`);
		if (items.length === 0) {
			section.createDiv({ text: "No files currently need attention.", cls: "kaos-dashboard-muted" });
			return;
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const item of items) {
			const row = list.createDiv({ cls: `kaos-dashboard-row ${toneClass(item.tone)}` });
			row.createDiv({ text: item.path ?? item.title, cls: "kaos-dashboard-path" });
			row.createDiv({ text: `${item.title} · ${item.detail}`, cls: "kaos-dashboard-muted" });
			if (item.lastSeenAt) {
				row.createDiv({ text: `last ${formatDateTime(item.lastSeenAt)}`, cls: "kaos-dashboard-muted" });
			}
		}
	}

	private section(root: HTMLElement, title: string): HTMLElement {
		const section = root.createDiv({ cls: "kaos-dashboard-section" });
		section.createEl("h3", { text: title });
		return section;
	}

	private button(
		parent: HTMLElement,
		label: string,
		action: () => void | Promise<void>,
		disabled = false,
	): HTMLButtonElement {
		const button = parent.createEl("button", { text: label });
		button.disabled = disabled;
		button.addEventListener("click", () => {
			if (button.disabled) return;
			button.disabled = true;
			Promise.resolve(action())
				.then(() => this.refresh(true))
				.catch((err) => {
					new Notice(`${label} failed. Check console.`, 5000);
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
			new Notice("Diff is available for Markdown conflict notes.");
			return;
		}
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			new Notice("Both the conflict note and original note are required for diff.", 5000);
			return;
		}
		const [originalText, artifactText] = await Promise.all([
			this.app.vault.cachedRead(originalFile),
			this.app.vault.cachedRead(artifactFile),
		]);
		const baseHash = this.deps.getConflictMergeBaseHash?.(artifact.artifactPath) ?? null;
		const baseText = baseHash ? this.deps.getBaselineText?.(baseHash) ?? null : null;
		new ConflictDiffModal(this.app, {
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			originalText,
			artifactText,
			baseHash,
			baseText,
			onResolve: (choice) => this.resolveConflictArtifact(artifact, choice),
		}).open();
	}

	private async resolveConflictArtifact(
		artifact: DashboardConflictArtifact,
		choice: ConflictResolutionChoice,
	): Promise<void> {
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			throw new Error("Both the conflict note and original note are required.");
		}
		if (choice.kind === "artifact") {
			const artifactText = await this.app.vault.cachedRead(artifactFile);
			await this.app.vault.modify(originalFile, artifactText);
		} else if (choice.kind === "merged") {
			await this.app.vault.modify(originalFile, choice.mergedText);
		}
		await this.app.vault.delete(artifactFile);
		this.deps.clearConflictMergeBase?.(artifact.artifactPath);
		await this.refresh(true);
	}

	private async copyPath(path: string): Promise<void> {
		await navigator.clipboard.writeText(path);
		new Notice("Path copied.");
	}
}

type ConflictResolutionChoice =
	| { kind: "original" }
	| { kind: "artifact" }
	| { kind: "merged"; mergedText: string };

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
		actions.createEl("button", { text: "Keep original" }).addEventListener("click", () => {
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
			useMerged ? "Apply merged result?" : useArtifact ? "Use conflict artifact?" : "Keep original note?",
			useMerged
				? `Replace "${this.data.originalPath}" with the merged result, then delete "${this.data.artifactPath}"?`
				: useArtifact
				? `Replace "${this.data.originalPath}" with the conflict artifact content, then delete "${this.data.artifactPath}"?`
				: `Keep "${this.data.originalPath}" as-is and delete "${this.data.artifactPath}"?`,
			() => this.applyResolution(choice),
			useMerged ? "Apply merged" : useArtifact ? "Use artifact" : "Keep original",
			"Cancel",
		).open();
	}

	private async applyResolution(choice: ConflictResolutionChoice): Promise<void> {
		try {
			await this.data.onResolve(choice);
			new Notice(
				choice.kind === "merged"
					? "Conflict resolved using merged result."
					: choice.kind === "artifact"
						? "Conflict resolved using artifact."
						: "Conflict artifact deleted.",
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
