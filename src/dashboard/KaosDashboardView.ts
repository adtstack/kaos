import { App, ItemView, Modal, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type {
	DashboardAttentionItem,
	DashboardConflictArtifact,
	DashboardMetric,
	DashboardRecentChange,
	KaosDashboardData,
} from "./dashboardTypes";
import { formatDashboardDeviceName } from "./deviceDisplay";
import {
	renderDiffLines as buildTextDiffLines,
	type RenderedDiffLine,
} from "../utils/textDiff";
import { ConfirmModal } from "../ui/ConfirmModal";

export const KAOS_DASHBOARD_VIEW_TYPE = "kaos-dashboard";

export interface KaosDashboardActions {
	reconnect(): void;
	forceReconcile(): void;
	importUntracked(): Promise<void>;
	takeSnapshotNow(): Promise<void>;
	showSnapshotList(): Promise<void>;
	showRecoveryHistory(): Promise<void>;
	exportDiagnostics(): void;
	exportDiagnosticsWithFilenames(): void;
}

export interface KaosDashboardViewDeps {
	collectData(): Promise<KaosDashboardData>;
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
		root.empty();
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

		this.renderActions(root, this.data);
		this.renderOverview(root, this.data.overview);
		this.renderSnapshots(root, this.data);
		this.renderConflicts(root, this.data.conflicts, this.data.settings.deviceName);
		this.renderAttention(root, this.data.attention);
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
		this.button(section, "Take snapshot", () => this.deps.actions.takeSnapshotNow(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Browse snapshots", () => this.deps.actions.showSnapshotList(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "File history", () => this.deps.actions.showRecoveryHistory(), !data.actions.syncInitialized || !data.actions.snapshotsAvailable || !data.actions.connected);
		this.button(section, "Export diagnostics", async () => this.deps.actions.exportDiagnostics());
		this.button(section, "Export with filenames", async () => this.deps.actions.exportDiagnosticsWithFilenames());
	}

	private renderOverview(root: HTMLElement, metrics: DashboardMetric[]): void {
		const section = this.section(root, "Overview");
		const grid = section.createDiv({ cls: "kaos-dashboard-metric-grid" });
		for (const metric of metrics) {
			const card = grid.createDiv({ cls: `kaos-dashboard-metric ${toneClass(metric.tone)}` });
			card.createDiv({ text: metric.label, cls: "kaos-dashboard-metric-label" });
			card.createDiv({ text: metric.value, cls: "kaos-dashboard-metric-value" });
		}
	}

	private renderSnapshots(root: HTMLElement, data: KaosDashboardData): void {
		const section = this.section(root, "Recent Changes");
		const snapshotRow = section.createDiv({ cls: "kaos-dashboard-snapshot-summary" });
		if (data.snapshotStatus.status === "ready") {
			const summary = data.snapshotStatus.summary;
			snapshotRow.createDiv({
				text: `${summary.snapshotCountLowerBound} snapshot(s), ${formatBytes(summary.estimatedStorageBytesLowerBound)} stored`,
				cls: "kaos-dashboard-strong",
			});
			snapshotRow.createDiv({
				text: summary.latestCreatedAt ? `latest ${formatDateTime(summary.latestCreatedAt)}` : "no snapshot timestamp",
				cls: "kaos-dashboard-muted",
			});
		} else {
			snapshotRow.createDiv({ text: data.snapshotStatus.message, cls: `kaos-dashboard-${data.snapshotStatus.status === "error" ? "error" : "muted"}` });
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
		for (const change of data.recentChanges.changes.slice(0, 40)) {
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
			change.snapshotKind,
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
		new ConflictDiffModal(this.app, {
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			originalText,
			artifactText,
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
		if (choice === "artifact") {
			const artifactText = await this.app.vault.cachedRead(artifactFile);
			await this.app.vault.modify(originalFile, artifactText);
		}
		await this.app.vault.delete(artifactFile);
		await this.refresh(true);
	}

	private async copyPath(path: string): Promise<void> {
		await navigator.clipboard.writeText(path);
		new Notice("Path copied.");
	}
}

type ConflictResolutionChoice = "original" | "artifact";

interface ConflictDiffModalData {
	artifactPath: string;
	originalPath: string;
	originalText: string;
	artifactText: string;
	onResolve(choice: ConflictResolutionChoice): Promise<void>;
}

class ConflictDiffModal extends Modal {
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

		const legend = contentEl.createDiv({ cls: "kaos-conflict-diff-legend" });
		legend.createEl("span", { text: "- original", cls: "kaos-conflict-diff-delete" });
		legend.createEl("span", { text: "+ artifact", cls: "kaos-conflict-diff-insert" });

		const actions = contentEl.createDiv({ cls: "modal-button-container kaos-conflict-diff-actions" });
		actions.createEl("button", { text: "Keep original" }).addEventListener("click", () => {
			this.confirmResolution("original");
		});
		actions.createEl("button", { text: "Use artifact", cls: "mod-cta" }).addEventListener("click", () => {
			this.confirmResolution("artifact");
		});
		actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());

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
		const useArtifact = choice === "artifact";
		new ConfirmModal(
			this.app,
			useArtifact ? "Use conflict artifact?" : "Keep original note?",
			useArtifact
				? `Replace "${this.data.originalPath}" with the conflict artifact content, then delete "${this.data.artifactPath}"?`
				: `Keep "${this.data.originalPath}" as-is and delete "${this.data.artifactPath}"?`,
			() => this.applyResolution(choice),
			useArtifact ? "Use artifact" : "Keep original",
			"Cancel",
		).open();
	}

	private async applyResolution(choice: ConflictResolutionChoice): Promise<void> {
		try {
			await this.data.onResolve(choice);
			new Notice(choice === "artifact" ? "Conflict resolved using artifact." : "Conflict artifact deleted.");
			this.close();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Conflict resolution failed: ${message}`, 8000);
			console.warn("[kaos] conflict resolution failed:", err);
		}
	}
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
		case "attachment-changed": return "Attachment changed";
		default: return kind;
	}
}

function changeKindClass(kind: string): string {
	return `is-change-${kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
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
