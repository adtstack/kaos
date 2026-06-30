import { App, Modal, Notice } from "obsidian";
import type {
	FileHistoryEntry,
	FileHistoryManifestIndex,
} from "../sync/recoverySnapshotClient";
import { renderDiffText } from "../utils/textDiff";

interface FileHistoryItem {
	manifest: FileHistoryManifestIndex;
	entry: FileHistoryEntry;
}

interface FileHistory {
	fileId: string;
	path: string;
	items: FileHistoryItem[];
}

interface SnapshotHistory {
	manifest: FileHistoryManifestIndex;
	changedItems: FileHistoryItem[];
}

interface RecoveryHistoryModalDeps {
	downloadContent(hash: string): Promise<string>;
	restoreVersion(item: FileHistoryItem): Promise<void>;
}

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
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function buildHistories(manifests: FileHistoryManifestIndex[]): FileHistory[] {
	const byFileId = new Map<string, FileHistory>();
	const sorted = manifests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	for (const manifest of sorted) {
		for (const entry of manifest.changedEntries) {
			const path = entry.newPath ?? entry.path;
			const existing = byFileId.get(entry.fileId);
			if (existing) {
				existing.items.push({ manifest, entry });
				if (manifest.createdAt >= existing.items[0]!.manifest.createdAt) {
					existing.path = path;
				}
			} else {
				byFileId.set(entry.fileId, {
					fileId: entry.fileId,
					path,
					items: [{ manifest, entry }],
				});
			}
		}
	}
	return Array.from(byFileId.values())
		.sort((a, b) => b.items[0]!.manifest.createdAt.localeCompare(a.items[0]!.manifest.createdAt));
}

export class RecoveryHistoryModal extends Modal {
	private histories: FileHistory[];
	private historiesByFileId: Map<string, FileHistory>;
	private snapshots: SnapshotHistory[];
	private selectedManifestId: string | null;
	private selected: FileHistory | null = null;
	private expandedDiffKey: string | null = null;
	private diffText: string | null = null;

	constructor(
		app: App,
		private readonly manifests: FileHistoryManifestIndex[],
		private readonly deps: RecoveryHistoryModalDeps,
	) {
		super(app);
		this.histories = buildHistories(manifests);
		this.historiesByFileId = new Map(this.histories.map((history) => [history.fileId, history]));
		this.snapshots = buildSnapshotHistories(manifests);
		this.selectedManifestId = this.snapshots[0]?.manifest.manifestId ?? null;
	}

	onOpen(): void {
		this.modalEl.addClass("recovery-history-modal-frame");
		this.render();
	}

	onClose(): void {
		this.modalEl.removeClass("recovery-history-modal-frame");
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("recovery-history-modal");
		if (this.selected) {
			this.renderDetail(contentEl, this.selected);
		} else {
			this.renderTimeline(contentEl);
		}
	}

	private renderTimeline(contentEl: HTMLElement): void {
		contentEl.createEl("h3", { text: "File history" });
		contentEl.createEl("p", {
			text: `${this.snapshots.length} point(s), ${this.histories.length} changed file(s).`,
			cls: "setting-item-description",
		});

		if (this.snapshots.length === 0) {
			contentEl.createEl("p", { text: "No file history points found yet." });
			return;
		}

		const shell = contentEl.createDiv({ cls: "recovery-history-shell" });
		const sidebar = shell.createDiv({ cls: "recovery-history-sidebar" });
		const detail = shell.createDiv({ cls: "recovery-history-main" });

		for (const snapshot of this.snapshots) {
			const selected = snapshot.manifest.manifestId === this.selectedManifestId;
			const row = sidebar.createDiv({
				cls: `recovery-history-snapshot-row${selected ? " is-selected" : ""}`,
			});
			row.createEl("div", {
				text: formatDate(snapshot.manifest.createdAt),
				cls: "recovery-history-snapshot-date",
			});
			row.createEl("div", {
				text: `${snapshot.changedItems.length} changed`,
				cls: "setting-item-description",
			});
			row.addEventListener("click", () => {
				this.selectedManifestId = snapshot.manifest.manifestId;
				this.expandedDiffKey = null;
				this.diffText = null;
				this.render();
			});
		}

		const selectedSnapshot = this.snapshots.find((snapshot) => snapshot.manifest.manifestId === this.selectedManifestId)
			?? this.snapshots[0]!;
		this.renderSnapshotDetail(detail, selectedSnapshot);
	}

	private renderSnapshotDetail(contentEl: HTMLElement, snapshot: SnapshotHistory): void {
		contentEl.createEl("h4", {
			text: formatDate(snapshot.manifest.createdAt),
			cls: "recovery-history-snapshot-heading",
		});
		contentEl.createEl("div", {
			text: `${snapshot.manifest.changedCount} changed file(s).`,
			cls: "setting-item-description",
		});

		if (snapshot.changedItems.length === 0) {
			contentEl.createEl("p", {
				text: "This file history point has no file-level changes.",
				cls: "setting-item-description",
			});
			return;
		}

		const list = contentEl.createDiv({ cls: "recovery-history-list" });
		for (const item of snapshot.changedItems) {
			const history = this.historiesByFileId.get(item.entry.fileId);
			const row = list.createDiv({ cls: "recovery-history-row" });
			row.createEl("div", {
				text: item.entry.newPath ?? item.entry.path,
				cls: "recovery-history-path",
			});
			row.createEl("div", {
				text: `${displayKind(item.entry.kind)} · ${history?.items.length ?? 1} event(s) for this file`,
				cls: "setting-item-description",
			});
			row.addEventListener("click", () => {
				this.selected = history ?? {
					fileId: item.entry.fileId,
					path: item.entry.newPath ?? item.entry.path,
					items: [item],
				};
				this.expandedDiffKey = null;
				this.diffText = null;
				this.render();
			});
		}
	}

	private renderDetail(contentEl: HTMLElement, history: FileHistory): void {
		const titleRow = contentEl.createDiv({ cls: "recovery-history-title-row" });
		titleRow.createEl("button", { text: "Back to file history" }).addEventListener("click", () => {
			this.selected = null;
			this.expandedDiffKey = null;
			this.diffText = null;
			this.render();
		});
		titleRow.createEl("h3", { text: history.path });

		for (const item of history.items) {
			const key = `${item.manifest.manifestId}:${item.entry.fileId}`;
			const row = contentEl.createDiv({ cls: "recovery-history-event" });
			row.createEl("div", {
				text: `${displayKind(item.entry.kind)} · ${formatDate(item.manifest.createdAt)}`,
				cls: "recovery-history-event-title",
			});
			const details = [
				item.entry.oldPath && item.entry.newPath ? `${item.entry.oldPath} -> ${item.entry.newPath}` : item.entry.path,
				item.entry.contentHash ? `hash ${item.entry.contentHash.slice(0, 12)}` : "",
			].filter(Boolean).join(" · ");
			row.createEl("div", { text: details, cls: "setting-item-description" });

			const actions = row.createDiv({ cls: "recovery-history-actions" });
			if (item.entry.previousContentHash || item.entry.contentHash) {
				actions.createEl("button", { text: "Diff" }).addEventListener("click", () => {
					void this.toggleDiff(key, item);
				});
			}
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

			if (this.expandedDiffKey === key && this.diffText !== null) {
				row.createEl("pre", {
					text: this.diffText,
					cls: "recovery-history-diff",
				});
			}
		}
	}

	private async toggleDiff(key: string, item: FileHistoryItem): Promise<void> {
		if (this.expandedDiffKey === key) {
			this.expandedDiffKey = null;
			this.diffText = null;
			this.render();
			return;
		}

		const previousHash = item.entry.previousContentHash;
		const currentHash = item.entry.contentHash;
		const previous = previousHash ? await this.deps.downloadContent(previousHash) : "";
		const current = currentHash ? await this.deps.downloadContent(currentHash) : "";
		this.expandedDiffKey = key;
		this.diffText = renderDiffText(previous, current);
		this.render();
	}
}

export type RecoveryHistoryFileItem = FileHistoryItem;

function buildSnapshotHistories(manifests: FileHistoryManifestIndex[]): SnapshotHistory[] {
	return manifests
		.slice()
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((manifest) => ({
			manifest,
			changedItems: manifest.changedEntries.map((entry) => ({ manifest, entry })),
		}));
}
