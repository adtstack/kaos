import { App, Modal, Notice } from "obsidian";
import * as QRCode from "qrcode";

export interface PairingModalOptions {
	code: string;
	qrSecret: string;
	expiresAt: number;
	host: string;
	vaultId: string;
}

export class PairDeviceModal extends Modal {
	private qrCanvas: HTMLCanvasElement | null = null;
	private timerInterval: number | null = null;

	constructor(
		app: App,
		private readonly options: PairingModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("kaos-pair-device-modal");

		contentEl.createEl("h3", { text: "Pair another device" });
		contentEl.createEl("p", {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: "Scan the QR code with Obsidian mobile, or enter the pairing code on another PC to connect instantly.",
			cls: "kaos-modal-copy",
		});

		const deepLink = `obsidian://kaos?action=pair&host=${encodeURIComponent(this.options.host)}&vaultId=${encodeURIComponent(this.options.vaultId)}&secret=${encodeURIComponent(this.options.qrSecret)}`;

		const mainWrap = contentEl.createDiv({ cls: "kaos-pair-device-wrap" });

		// QR Code Column
		const qrSection = mainWrap.createDiv({ cls: "kaos-pair-device-qr-section" });
		const qrWrap = qrSection.createDiv({ cls: "kaos-pair-device-qr-wrap" });
		this.qrCanvas = qrWrap.createEl("canvas", { cls: "kaos-pair-device-qr-canvas" });

		void QRCode.toCanvas(this.qrCanvas, deepLink, {
			width: 200,
			margin: 1,
			errorCorrectionLevel: "M",
		}).catch(() => {
			if (this.qrCanvas) {
				this.qrCanvas.remove();
				this.qrCanvas = null;
			}
		});

		// Code Column
		const codeSection = mainWrap.createDiv({ cls: "kaos-pair-device-code-section" });
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		codeSection.createEl("div", { text: "Pairing code for PC", cls: "kaos-pair-code-label" });

		const codeBox = codeSection.createDiv({ cls: "kaos-pair-code-box" });
		codeBox.createEl("span", { text: this.options.code, cls: "kaos-pair-code-value" });

		const timerEl = codeSection.createEl("div", { cls: "kaos-pair-timer" });
		const updateTimer = () => {
			const remainingSeconds = Math.max(0, Math.floor((this.options.expiresAt - Date.now()) / 1000));
			const minutes = Math.floor(remainingSeconds / 60);
			const seconds = remainingSeconds % 60;
			timerEl.setText(`Expires in ${minutes}:${seconds < 10 ? "0" : ""}${seconds}`);
			if (remainingSeconds <= 0) {
				timerEl.setText("Pairing code expired. Close and generate a new one.");
				if (this.timerInterval !== null) {
					window.clearInterval(this.timerInterval);
					this.timerInterval = null;
				}
			}
		};
		updateTimer();
		this.timerInterval = window.setInterval(updateTimer, 1000);

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy pairing code" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.options.code).then(
				() => new Notice("Pairing code copied to clipboard."),
				() => new Notice("Failed to copy pairing code.", 6000),
			);
		});

		buttons.createEl("button", { text: "Copy desktop deep link" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(deepLink).then(
				() => new Notice("Desktop pairing link copied."),
				() => new Notice("Failed to copy link.", 6000),
			);
		});

		buttons.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
		});
	}

	onClose(): void {
		if (this.timerInterval !== null) {
			window.clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
		this.contentEl.empty();
		this.qrCanvas = null;
	}
}
