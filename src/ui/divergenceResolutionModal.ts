import { type App, Modal, Notice } from "obsidian";
import { renderDiffText } from "../utils/textDiff";
import { normalizeEditorText } from "../utils/editorTextNormalization";
import { ConfirmModal } from "./ConfirmModal";

export interface DivergenceVersions {
	local: string | null;
	remote: string | null;
	base?: string | null;
}

export interface DivergenceResolutionResult {
	ok: boolean;
	conflictPath?: string;
	reason?: string;
}

export interface DivergenceResolutionHost {
	loadDivergenceVersions(path: string): Promise<DivergenceVersions>;
	resolveAlreadyConverged(path: string): Promise<DivergenceResolutionResult>;
	resolveKeepRemote(path: string): Promise<DivergenceResolutionResult>;
	resolveKeepLocal(path: string, localContent: string): Promise<DivergenceResolutionResult>;
	resolveKeepBoth(path: string, localContent: string): Promise<DivergenceResolutionResult>;
}

export class DivergenceResolutionModal extends Modal {
	constructor(
		app: App,
		private readonly path: string,
		private readonly host: DivergenceResolutionHost,
	) {
		super(app);
	}

	onOpen(): void {
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		const noteName = this.path.split("/").pop() ?? this.path;
		contentEl.createEl("h3", { text: `Resolve divergence: ${noteName}` });

		let versions: DivergenceVersions;
		try {
			versions = await this.host.loadDivergenceVersions(this.path);
		} catch (err) {
			contentEl.createEl("p", {
				text: `Could not load versions for "${this.path}": ${String(err)}`,
				cls: "mod-warning",
			});
			return;
		}

		const localText = versions.local;
		const remoteText = versions.remote;

		if (localText == null || remoteText == null) {
			contentEl.createEl("p", {
				text: "One of the versions could not be loaded. Please ensure the note is accessible and try again.",
			});
			return;
		}

		if (
			localText === remoteText
			|| normalizeEditorText(localText) === normalizeEditorText(remoteText)
		) {
			let resumed = false;
			try {
				const result = await this.host.resolveAlreadyConverged(this.path);
				resumed = result.ok;
			} catch {
				resumed = false;
			}
			contentEl.createEl("p", {
				text: resumed
					? "The local note and the synced server version are already identical, so sync has been resumed for this note."
					: "The local note and the synced server version are already identical, but sync could not be revalidated automatically. Close and reopen the note, or try again.",
			});
			const closeBtn = contentEl.createEl("button", { text: "Close" });
			closeBtn.addEventListener("click", () => this.close());
			return;
		}

		contentEl.createEl("p", {
			text: "This note has diverged: your local copy differs from the synced server version. " +
				"Review the diff below (remote → local) and choose how to proceed:",
		});

		const metaRow = contentEl.createDiv({ cls: "kaos-divergence-modal-meta" });
		metaRow.createEl("span", { text: `Local copy: ${localText.length.toLocaleString()} chars` });
		metaRow.createEl("span", { text: `Synced copy: ${remoteText.length.toLocaleString()} chars` });
		if (versions.base != null) {
			metaRow.createEl("span", { text: `Base: ${versions.base.length.toLocaleString()} chars` });
		}

		const diffEl = contentEl.createEl("pre", { cls: "kaos-divergence-modal-diff" });
		diffEl.setText(renderDiffText(remoteText, localText, { maxSegments: 32 }));

		const buttonRow = contentEl.createDiv({ cls: "kaos-divergence-modal-buttons modal-button-container" });

		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const keepRemoteBtn = buttonRow.createEl("button", {
			text: "Keep synced version",
			cls: "mod-cta",
		});
		keepRemoteBtn.addEventListener("click", () => this.confirmChoice("keep-remote", localText));

		const keepBothBtn = buttonRow.createEl("button", {
			text: "Keep both (save copy)",
		});
		keepBothBtn.addEventListener("click", () => this.confirmChoice("keep-both", localText));

		const keepLocalBtn = buttonRow.createEl("button", {
			text: "Keep local version",
		});
		keepLocalBtn.addEventListener("click", () => this.confirmChoice("keep-local", localText));
	}

	private confirmChoice(
		choice: "keep-remote" | "keep-local" | "keep-both",
		localContent: string,
	): void {
		const noteName = this.path.split("/").pop() ?? this.path;
		let title = "";
		let message = "";
		let confirmText = "";
		let confirmClass = "";

		if (choice === "keep-remote") {
			title = "Keep synced version?";
			message = `The synced version from the server will replace your local copy of "${noteName}". Your current local text will be safely backed up in recovery history.`;
			confirmText = "Keep synced version";
			confirmClass = "mod-cta";
		} else if (choice === "keep-local") {
			title = "Keep local version?";
			message = `Your local copy will overwrite the synced version on the server. The previous server version is recorded in recovery history.`;
			confirmText = "Overwrite server with local";
			confirmClass = "mod-warning";
		} else {
			title = "Save local copy as new file?";
			message = `Your local edits will be saved as a separate conflict note, and "${noteName}" will be updated to the synced version. Both versions will be preserved.`;
			confirmText = "Save copy & sync";
			confirmClass = "mod-cta";
		}

		new ConfirmModal(
			this.app,
			title,
			message,
			async () => {
				this.close();
				let effectiveLocal = localContent;
				try {
					const latest = await this.host.loadDivergenceVersions(this.path);
					if (latest.local != null) {
						effectiveLocal = latest.local;
					}
				} catch {
					// Fall back to captured content
				}

				let result: DivergenceResolutionResult;
				if (choice === "keep-remote") {
					result = await this.host.resolveKeepRemote(this.path);
				} else if (choice === "keep-local") {
					result = await this.host.resolveKeepLocal(this.path, effectiveLocal);
				} else {
					result = await this.host.resolveKeepBoth(this.path, effectiveLocal);
				}

				if (!result.ok) {
					new Notice(`KAOS: could not resolve "${noteName}" (${result.reason ?? "unknown"}).`, 8000);
					return;
				}

				if (choice === "keep-remote") {
					new Notice(`KAOS: updated "${noteName}" to synced version. (Local backup preserved)`, 7000);
				} else if (choice === "keep-local") {
					new Notice(`KAOS: applied local version of "${noteName}" to sync server.`, 7000);
				} else {
					const conflictName = result.conflictPath?.split("/").pop() ?? "copy";
					new Notice(`KAOS: saved local copy as "${conflictName}". Original note updated to synced version.`, 9000);
				}
			},
			confirmText,
			"Cancel",
			undefined,
			confirmClass,
		).open();
	}
}
