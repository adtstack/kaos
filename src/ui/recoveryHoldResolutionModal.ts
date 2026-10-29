import { type App, Modal, Notice } from "obsidian";
import { renderDiffText } from "../utils/textDiff";
import { ConfirmModal } from "./ConfirmModal";

export interface RecoveryHoldSummary {
	path: string;
	detail: string;
	episode: number;
}

export interface RecoveryHoldVersions {
	local: string | null;
	remote: string | null;
	base?: string | null;
}

export interface RecoveryHoldResolutionResult {
	ok: boolean;
	reason?: string;
}

export interface RecoveryHoldResolutionHost {
	getRecoveryHolds(): ReadonlyArray<RecoveryHoldSummary>;
	loadRecoveryHoldVersions(path: string): Promise<RecoveryHoldVersions>;
	resolveRecoveryHold(
		path: string,
		choice: "keep-local" | "keep-remote",
	): Promise<RecoveryHoldResolutionResult>;
}

/**
 * Lists paused automatic recoveries (local vs remote split-brain holds) and
 * lets the user pick a version per path. The controller applies the choice
 * through the ordinary reconciliation drain; this modal never writes content
 * itself.
 */
export class RecoveryHoldResolutionModal extends Modal {
	constructor(
		app: App,
		private readonly host: RecoveryHoldResolutionHost,
	) {
		super(app);
	}

	onOpen(): void {
		this.renderList();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderList(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Paused sync recoveries" });

		const holds = this.host.getRecoveryHolds();
		if (holds.length === 0) {
			contentEl.createEl("p", {
				text: "No files have paused automatic recovery right now.",
			});
			return;
		}

		contentEl.createEl("p", {
			text: "Local and remote versions were both retained for these notes. " +
				"Review the versions and choose one; the losing side is audited server-side before it is replaced.",
		});

		for (const hold of holds) {
			const row = contentEl.createDiv({ cls: "kaos-recovery-hold-row" });
			const info = row.createDiv();
			info.createEl("div", { text: hold.path, cls: "kaos-recovery-hold-path" });
			info.createEl("div", {
				text: `automatic recovery paused — ${hold.detail}`,
				cls: "kaos-recovery-hold-detail",
			});
			const actions = row.createDiv({ cls: "kaos-recovery-hold-actions" });
			actions.createEl("button", { text: "Review versions" }).addEventListener(
				"click",
				() => void this.renderDetail(hold),
			);
		}
	}

	private async renderDetail(hold: RecoveryHoldSummary): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: hold.path });
		contentEl.createEl("p", {
			text: `Automatic recovery is paused (${hold.detail}). The diff below shows the remote version → the local version.`,
		});

		let versions: RecoveryHoldVersions;
		try {
			versions = await this.host.loadRecoveryHoldVersions(hold.path);
		} catch (err) {
			new Notice(`KAOS: failed to load versions for "${hold.path}": ${String(err)}`);
			this.renderList();
			return;
		}

		if (versions.base != null) {
			contentEl.createEl("div", {
				text: `agreed base: ${versions.base.length} chars`,
				cls: "kaos-recovery-hold-detail",
			});
		}
		contentEl.createEl("div", {
			text: versions.local == null
				? "local version: unavailable"
				: `local version: ${versions.local.length} chars`,
			cls: "kaos-recovery-hold-detail",
		});
		contentEl.createEl("div", {
			text: versions.remote == null
				? "remote version: unavailable"
				: `remote version: ${versions.remote.length} chars`,
			cls: "kaos-recovery-hold-detail",
		});

		if (versions.local == null || versions.remote == null) {
			contentEl.createEl("p", {
				text: "One side could not be read. Close and retry, or inspect the file manually.",
			});
		} else {
			const diff = contentEl.createEl("pre", {
				cls: "kaos-recovery-hold-diff",
			});
			diff.setText(
				renderDiffText(versions.remote, versions.local, { maxSegments: 16 }),
			);
		}

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.createEl("button", { text: "Back" }).addEventListener(
			"click",
			() => this.renderList(),
		);
		buttonRow.createEl("button", { text: "Keep local version" }).addEventListener(
			"click",
			() => this.confirmChoice(hold, "keep-local"),
		);
		buttonRow.createEl("button", { text: "Keep remote version" }).addEventListener(
			"click",
			() => this.confirmChoice(hold, "keep-remote"),
		);
	}

	private confirmChoice(
		hold: RecoveryHoldSummary,
		choice: "keep-local" | "keep-remote",
	): void {
		const keepingLocal = choice === "keep-local";
		new ConfirmModal(
			this.app,
			keepingLocal ? "Keep the local version?" : "Keep the remote version?",
			keepingLocal
				? `The local text of "${hold.path}" replaces the synced version on this and every other device. The remote text is audited before it is replaced.`
				: `The synced version replaces the local text of "${hold.path}" in the open editor and on disk. The local text is audited before it is replaced.`,
			async () => {
				const result = await this.host.resolveRecoveryHold(hold.path, choice);
				if (!result.ok) {
					new Notice(
						`KAOS: could not resolve "${hold.path}" (${result.reason ?? "unknown"}). Try again in a moment.`,
					);
					return;
				}
				new Notice(
					`KAOS: applying the ${keepingLocal ? "local" : "remote"} version of "${hold.path}".`,
				);
				this.renderList();
			},
			keepingLocal ? "Keep local" : "Keep remote",
		).open();
	}
}
