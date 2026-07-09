import { App, Modal, Notice } from "obsidian";
import type {
	FileHistoryEntry,
	FileHistoryManifestIndex,
} from "../sync/recoverySnapshotClient";
import {
	renderDiffLines,
	type RenderedDiffLine,
} from "../utils/textDiff";
import {
	buildRecoveryHistoryChanges,
	buildRecoverySnapshotHistories,
	filterRecoveryHistoryChanges,
	resolveRecoveryHistoryFeedState,
	resolveVisibleRecoveryHistorySelection,
	type RecoveryHistoryChangeItem,
	type RecoveryHistoryFileHistoryItem as FileHistoryItem,
	type RecoveryHistoryInitialSelection,
	type RecoveryHistoryKindFilter,
	type RecoveryHistoryScope,
	type RecoveryHistorySnapshot as SnapshotHistory,
} from "./recoveryHistorySelection";

interface RecoveryHistoryModalDeps {
	downloadContent(hash: string): Promise<string>;
	restoreVersion(item: FileHistoryItem): Promise<void>;
}

const KIND_FILTERS: Array<RecoveryHistoryKindFilter> = [
	"all",
	"created",
	"modified",
	"renamed",
	"deleted",
	"restored",
];

function displayKind(kind: FileHistoryEntry["kind"]): string {
	switch (kind) {
		case "created": return "Created";
		case "modified": return "Modified";
		case "renamed": return "Renamed";
		case "deleted": return "Deleted";
		case "restored": return "Restored";
	}
}

function formatDate(iso: string): string {
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

function sameScope(left: RecoveryHistoryScope, right: RecoveryHistoryScope): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "all") return true;
	return right.kind === "manifest" && left.manifestId === right.manifestId;
}

export class RecoveryHistoryModal extends Modal {
	private readonly snapshots: SnapshotHistory[];
	private readonly changes: RecoveryHistoryChangeItem[];
	private readonly changeByKey: Map<string, RecoveryHistoryChangeItem>;
	private historyScope: RecoveryHistoryScope;
	private query = "";
	private kindFilter: RecoveryHistoryKindFilter = "all";
	private selectedChangeKey: string | null;
	private diffKey: string | null = null;
	private diffLines: RenderedDiffLine[] | null = null;
	private diffError: string | null = null;
	private diffLoadSeq = 0;
	private readonly contentCache = new Map<string, Promise<string>>();
	private railEl: HTMLElement | null = null;
	private feedEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly manifests: FileHistoryManifestIndex[],
		private readonly deps: RecoveryHistoryModalDeps,
		options: RecoveryHistoryInitialSelection = {},
	) {
		super(app);
		this.snapshots = buildRecoverySnapshotHistories(manifests);
		this.changes = buildRecoveryHistoryChanges(manifests);
		this.changeByKey = new Map(this.changes.map((item) => [item.key, item]));
		const initial = resolveRecoveryHistoryFeedState(manifests, options);
		this.historyScope = initial.scope;
		this.selectedChangeKey = initial.selectedChangeKey;
	}

	onOpen(): void {
		this.modalEl.addClass("recovery-history-modal-frame");
		this.normalizeSelectedChange();
		this.render();
		void this.loadSelectedDiff();
	}

	onClose(): void {
		this.modalEl.removeClass("recovery-history-modal-frame");
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("recovery-history-modal");
		this.renderHeader(contentEl);

		if (this.changes.length === 0) {
			contentEl.createEl("p", { text: "No file history points found yet." });
			return;
		}

		const shell = contentEl.createDiv({ cls: "recovery-history-shell" });
		this.railEl = shell.createDiv({ cls: "recovery-history-sidebar" });
		this.feedEl = shell.createDiv({ cls: "recovery-history-feed" });
		this.previewEl = shell.createDiv({ cls: "recovery-history-preview" });
		this.renderResults();
	}

	private renderHeader(contentEl: HTMLElement): void {
		const header = contentEl.createDiv({ cls: "recovery-history-header" });
		const title = header.createDiv({ cls: "recovery-history-heading" });
		title.createEl("h3", { text: "File history" });
		title.createDiv({
			text: `${this.snapshots.length} point(s), ${this.changes.length} changed file event(s).`,
			cls: "setting-item-description",
		});

		const controls = header.createDiv({ cls: "recovery-history-controls" });
		const search = controls.createEl("input", {
			type: "search",
			placeholder: "Search paths",
			cls: "recovery-history-search",
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.renderResultsAndLoadDiff();
		});

		const select = controls.createEl("select", { cls: "recovery-history-kind-filter" });
		for (const filter of KIND_FILTERS) {
			const option = select.createEl("option", {
				text: filter === "all" ? "All types" : displayKind(filter),
			});
			option.value = filter;
			option.selected = filter === this.kindFilter;
		}
		select.addEventListener("change", () => {
			this.kindFilter = normalizeKindFilter(select.value);
			this.renderResultsAndLoadDiff();
		});
	}

	private renderResultsAndLoadDiff(): void {
		const previous = this.selectedChangeKey;
		this.normalizeSelectedChange();
		if (previous !== this.selectedChangeKey) {
			this.resetDiffState();
		}
		this.renderResults();
		void this.loadSelectedDiff();
	}

	private renderResults(): void {
		if (!this.railEl || !this.feedEl || !this.previewEl) return;
		this.railEl.empty();
		this.feedEl.empty();
		this.previewEl.empty();
		this.renderScopeRail(this.railEl);
		const visible = this.visibleChanges();
		this.renderFeed(this.feedEl, visible);
		this.renderPreview(this.previewEl, this.selectedChange());
	}

	private renderPreviewOnly(): void {
		if (!this.previewEl) return;
		this.previewEl.empty();
		this.renderPreview(this.previewEl, this.selectedChange());
	}

	private renderScopeRail(parent: HTMLElement): void {
		this.renderScopeRow(parent, {
			label: "All changes",
			detail: `${this.changes.length} changed`,
			scope: { kind: "all" },
		});

		for (const snapshot of this.snapshots) {
			this.renderScopeRow(parent, {
				label: formatDate(snapshot.manifest.createdAt),
				detail: `${snapshot.changedItems.length} changed`,
				scope: { kind: "manifest", manifestId: snapshot.manifest.manifestId },
			});
		}
	}

	private renderScopeRow(
		parent: HTMLElement,
		options: {
			label: string;
			detail: string;
			scope: RecoveryHistoryScope;
		},
	): void {
		const selected = sameScope(this.historyScope, options.scope);
		const row = parent.createDiv({
			cls: `recovery-history-snapshot-row${selected ? " is-selected" : ""}`,
		});
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.createEl("div", {
			text: options.label,
			cls: "recovery-history-snapshot-date",
		});
		row.createEl("div", {
			text: options.detail,
			cls: "setting-item-description",
		});
		this.onActivate(row, () => {
			this.historyScope = options.scope;
			this.renderResultsAndLoadDiff();
		});
	}

	private renderFeed(parent: HTMLElement, changes: RecoveryHistoryChangeItem[]): void {
		const header = parent.createDiv({ cls: "recovery-history-feed-header" });
		header.createDiv({
			text: `${changes.length} visible change(s)`,
			cls: "recovery-history-feed-count",
		});

		if (changes.length === 0) {
			parent.createDiv({
				text: "No changes match the current filters.",
				cls: "setting-item-description recovery-history-empty",
			});
			return;
		}

		const list = parent.createDiv({ cls: "recovery-history-list" });
		for (const item of changes) {
			this.renderChangeRow(list, item);
		}
	}

	private renderChangeRow(parent: HTMLElement, item: RecoveryHistoryChangeItem): void {
		const selected = item.key === this.selectedChangeKey;
		const row = parent.createDiv({
			cls: `recovery-history-row${selected ? " is-selected" : ""}`,
		});
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.setAttr("aria-label", `Show diff for ${item.displayPath}`);

		const eventLine = row.createDiv({ cls: "recovery-history-event-line" });
		eventLine.createEl("span", {
			text: displayKind(item.entry.kind),
			cls: `recovery-history-event-badge is-${item.entry.kind}`,
		});
		eventLine.createEl("span", {
			text: formatDate(item.occurredAt),
			cls: "recovery-history-event-time",
		});
		row.createEl("div", {
			text: item.displayPath,
			cls: "recovery-history-path",
		});
		const detail = this.changeDetailParts(item).join(" · ");
		if (detail.length > 0) {
			row.createEl("div", {
				text: detail,
				cls: "setting-item-description",
			});
		}

		this.onActivate(row, () => {
			if (this.selectedChangeKey === item.key) return;
			this.selectedChangeKey = item.key;
			this.resetDiffState();
			this.renderResults();
			void this.loadSelectedDiff();
		});
	}

	private renderPreview(parent: HTMLElement, item: RecoveryHistoryChangeItem | null): void {
		if (!item) {
			parent.createDiv({
				text: "No change selected.",
				cls: "setting-item-description recovery-history-empty",
			});
			return;
		}

		const heading = parent.createDiv({ cls: "recovery-history-preview-heading" });
		heading.createEl("div", {
			text: displayKind(item.entry.kind),
			cls: `recovery-history-event-badge is-${item.entry.kind}`,
		});
		heading.createEl("h4", { text: item.displayPath });
		heading.createDiv({
			text: formatDate(item.occurredAt),
			cls: "setting-item-description",
		});

		const meta = this.changeDetailParts(item);
		if (meta.length > 0) {
			parent.createDiv({
				text: meta.join(" · "),
				cls: "setting-item-description recovery-history-preview-meta",
			});
		}

		const actions = parent.createDiv({ cls: "recovery-history-actions" });
		if (item.entry.contentHash) {
			actions.createEl("button", {
				text: "Restore this version",
				cls: "mod-cta",
			}).addEventListener("click", () => {
				void this.deps.restoreVersion(item).then(
					() => this.close(),
					(err) => new Notice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, 8000),
				);
			});
		}

		if (!hasTextVersions(item)) {
			parent.createDiv({
				text: textUnavailableMessage(item),
				cls: "setting-item-description recovery-history-diff-status",
			});
			return;
		}

		if (this.diffKey !== item.key || (this.diffLines === null && this.diffError === null)) {
			parent.createDiv({
				text: "Loading diff...",
				cls: "setting-item-description recovery-history-diff-status",
			});
			return;
		}

		if (this.diffError) {
			parent.createDiv({
				text: this.diffError,
				cls: "setting-item-description recovery-history-diff-status is-error",
			});
			return;
		}

		this.renderDiff(parent, item, this.diffLines ?? []);
	}

	private async loadSelectedDiff(): Promise<void> {
		const item = this.selectedChange();
		if (!item) return;
		const key = item.key;
		if (this.diffKey === key && (this.diffLines !== null || this.diffError !== null)) {
			return;
		}

		this.diffKey = key;
		this.diffLines = null;
		this.diffError = null;
		this.renderPreviewOnly();

		if (!hasTextVersions(item)) {
			this.diffLines = [];
			this.renderPreviewOnly();
			return;
		}

		const seq = ++this.diffLoadSeq;
		try {
			const previousHash = item.entry.previousContentHash;
			const currentHash = item.entry.contentHash;
			const previous = previousHash ? await this.downloadCached(previousHash) : "";
			const current = currentHash ? await this.downloadCached(currentHash) : "";
			if (seq !== this.diffLoadSeq || this.selectedChangeKey !== key) return;
			this.diffLines = renderDiffLines(previous, current, {
				contextLines: 0,
				maxSegments: 80,
				maxLinesPerSegment: 12,
			});
			this.diffError = null;
		} catch (err) {
			if (seq !== this.diffLoadSeq || this.selectedChangeKey !== key) return;
			this.diffLines = null;
			this.diffError = `Diff failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		this.renderPreviewOnly();
	}

	private downloadCached(hash: string): Promise<string> {
		const existing = this.contentCache.get(hash);
		if (existing) return existing;
		const promise = this.deps.downloadContent(hash).catch((err) => {
			this.contentCache.delete(hash);
			throw err;
		});
		this.contentCache.set(hash, promise);
		return promise;
	}

	private renderDiff(parent: HTMLElement, item: RecoveryHistoryChangeItem, lines: RenderedDiffLine[]): void {
		const root = parent.createDiv({ cls: "recovery-history-diff" });
		const status = diffStatusMessage(item);
		if (status) {
			root.createDiv({
				text: status,
				cls: "setting-item-description recovery-history-diff-status",
			});
		}

		const legend = root.createDiv({ cls: "recovery-history-diff-legend" });
		legend.createEl("span", { text: "- before", cls: "recovery-history-diff-delete" });
		legend.createEl("span", { text: "+ after", cls: "recovery-history-diff-insert" });

		const body = root.createDiv({ cls: "recovery-history-diff-body" });
		if (lines.length === 0) {
			body.createDiv({
				text: "No textual diff.",
				cls: "recovery-history-diff-line is-context",
			});
			return;
		}

		for (const line of lines) {
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const cls = line.kind === "delete"
				? "recovery-history-diff-line is-delete"
				: line.kind === "insert"
					? "recovery-history-diff-line is-insert"
					: line.kind === "context"
						? "recovery-history-diff-line is-context"
						: "recovery-history-diff-line";
			body.createDiv({ text: `${prefix}${line.text}` || " ", cls });
		}
	}

	private visibleChanges(): RecoveryHistoryChangeItem[] {
		return filterRecoveryHistoryChanges(this.changes, {
			scope: this.historyScope,
			query: this.query,
			kindFilter: this.kindFilter,
		});
	}

	private normalizeSelectedChange(): void {
		this.selectedChangeKey = resolveVisibleRecoveryHistorySelection(
			this.changes,
			{
				scope: this.historyScope,
				query: this.query,
				kindFilter: this.kindFilter,
			},
			this.selectedChangeKey,
		);
	}

	private selectedChange(): RecoveryHistoryChangeItem | null {
		if (!this.selectedChangeKey) return null;
		return this.changeByKey.get(this.selectedChangeKey) ?? null;
	}

	private resetDiffState(): void {
		this.diffKey = null;
		this.diffLines = null;
		this.diffError = null;
		this.diffLoadSeq++;
	}

	private changeDetailParts(item: RecoveryHistoryChangeItem): string[] {
		return [
			item.entry.oldPath && item.entry.newPath ? `${item.entry.oldPath} -> ${item.entry.newPath}` : "",
			item.entry.device ?? "",
			item.entry.size !== undefined ? formatBytes(item.entry.size) : "",
			`${item.historyCount} event(s) for this file`,
		].filter(Boolean);
	}

	private onActivate(el: HTMLElement, handler: () => void): void {
		el.addEventListener("click", handler);
		el.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			handler();
		});
	}
}

function normalizeKindFilter(value: string): RecoveryHistoryKindFilter {
	return KIND_FILTERS.includes(value as RecoveryHistoryKindFilter)
		? value as RecoveryHistoryKindFilter
		: "all";
}

function hasTextVersions(item: RecoveryHistoryChangeItem): boolean {
	return Boolean(item.entry.previousContentHash || item.entry.contentHash);
}

function textUnavailableMessage(item: RecoveryHistoryChangeItem): string {
	if (item.entry.oldPath && item.entry.newPath) {
		return "Path changed only. No text diff was captured for this history entry.";
	}
	return "No text content was captured for this history entry.";
}

function diffStatusMessage(item: RecoveryHistoryChangeItem): string | null {
	if (!item.entry.previousContentHash && item.entry.contentHash) {
		return "Created content. The file version appears as additions.";
	}
	if (item.entry.previousContentHash && !item.entry.contentHash) {
		return "Deleted content. The previous file version appears as removals.";
	}
	if (item.entry.previousContentHash && item.entry.contentHash && item.entry.previousContentHash === item.entry.contentHash) {
		return "Content hash did not change.";
	}
	return null;
}

export type RecoveryHistoryFileItem = FileHistoryItem;
