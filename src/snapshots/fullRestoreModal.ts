import { App, Modal, Notice } from "obsidian";
import type { SnapshotDiff } from "../sync/snapshotClient";
import { fullRestoreCounts, requiresTypedFullRestoreConfirmation } from "./fullRestore";
import { formatUnknown } from "../utils/format";

export class FullVaultRestoreConfirmModal extends Modal {
	constructor(app: App, private readonly diff: SnapshotDiff, private readonly onConfirm: () => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("kaos-full-restore-confirm");
		this.contentEl.createEl("h3", { text: "Restore entire vault to this snapshot?" });
		const counts = fullRestoreCounts(this.diff);
		const table = this.contentEl.createEl("table");
		for (const [label, count] of [["Changed files to restore", counts.changed], ["Deleted files to undelete", counts.deleted], ["Created files to remove", counts.removed]] as const) {
			const row = table.createEl("tr");
			row.createEl("th", { text: label }); row.createEl("td", { text: String(count) });
		}
		this.contentEl.createEl("p", { text: "An automatic pre-restore snapshot and local file backups are required. If the safety snapshot or backups fail, the restore will stop." });
		this.contentEl.createEl("p", { text: "Markdown notes created since this snapshot will move to Obsidian trash after backup. Created attachments will be preserved as visible (KAOS local backup ...) files. Changes sync to other devices." });
		const typed = requiresTypedFullRestoreConfirmation(this.diff);
		let input: HTMLInputElement | null = null;
		if (typed) {
			const label = this.contentEl.createEl("label", { text: "Type restore to confirm this large operation." });
			input = label.createEl("input", { type: "text", placeholder: "restore" });
			input.setAttribute("aria-label", "Type restore to confirm");
			input.autocomplete = "off";
		}
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", { text: "Restore entire vault", cls: "mod-cta" });
		confirm.disabled = typed;
		input?.addEventListener("input", () => { confirm.disabled = input?.value !== "restore"; });
		let submitted = false;
		confirm.addEventListener("click", () => {
			if (submitted || confirm.disabled || (typed && input?.value !== "restore")) return;
			submitted = true;
			confirm.disabled = true;
			this.close();
			Promise.resolve().then(() => this.onConfirm()).catch(err => {
				new Notice(`Full restore failed: ${formatUnknown(err)}`, 12000);
			});
		});
		input?.focus();
	}

	onClose(): void { this.contentEl.empty(); }
}
