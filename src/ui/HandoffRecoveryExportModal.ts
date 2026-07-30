import { type App, Modal } from "obsidian";

export function requestHandoffRecoveryExportPath(
	app: App,
	suggestedPath: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		new HandoffRecoveryExportModal(app, suggestedPath, resolve).open();
	});
}

class HandoffRecoveryExportModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly suggestedPath: string,
		private readonly resolvePath: (path: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: "Export handoff recovery" });
		this.contentEl.createEl("p", {
			text: "Choose a Markdown or text path. The exported file becomes an ordinary vault file and follows that destination's sync policy.",
		});
		const input = this.contentEl.createEl("input");
		input.type = "text";
		input.value = this.suggestedPath;
		input.addClass("kaos-handoff-recovery-export-path");
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
		const confirm = buttons.createEl("button", { text: "Export" });
		confirm.addClass("mod-cta");
		confirm.addEventListener("click", () => {
			const path = input.value.trim();
			if (!path) return;
			this.settled = true;
			this.resolvePath(path);
			this.close();
		});
		input.focus();
		input.select();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.resolvePath(null);
	}
}
