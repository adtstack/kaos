import { App, Modal, Setting } from "obsidian";

export class RenameDeviceModal extends Modal {
	private newName: string;

	constructor(
		app: App,
		private readonly currentName: string,
		private readonly onRename: (newName: string) => Promise<void>,
	) {
		super(app);
		this.newName = currentName;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Rename device" });

		new Setting(contentEl)
			.setName("New device name")
			.setDesc("The display name shown in connected devices, cursors, and logs.")
			.addText((text) => {
				text
					.setValue(this.newName)
					.onChange((value) => {
						this.newName = value;
					});
				text.inputEl.focus();
				text.inputEl.select();
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.submit();
					}
				});
			});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

		const saveButton = buttons.createEl("button", {
			text: "Save",
			cls: "mod-cta",
		});
		saveButton.addEventListener("click", () => void this.submit());
	}

	private async submit(): Promise<void> {
		const trimmed = this.newName.trim();
		if (!trimmed) return;
		this.close();
		await this.onRename(trimmed);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
