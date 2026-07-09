export {
	Component,
	Plugin,
} from "./core/plugin";
export {
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
} from "./core/fileTypes";
export { requestUrl } from "./core/requestUrl";

import { createHeadlessElement } from "./core/dom";

export class Notice {
	noticeEl = createHeadlessElement("div");
	containerEl = createHeadlessElement("div");
	messageEl = createHeadlessElement("div");

	constructor(message: string | DocumentFragment, _duration?: number) {
		this.setMessage(message);
	}

	setMessage(message: string | DocumentFragment): this {
		this.messageEl.setText(String(message));
		return this;
	}

	hide(): void {}
}

export class Modal {
	app: unknown;
	scope = {};
	containerEl = createHeadlessElement("div");
	modalEl = createHeadlessElement("div");
	titleEl = createHeadlessElement("h1");
	contentEl = createHeadlessElement("div");
	shouldRestoreSelection = false;

	constructor(app?: unknown) {
		this.app = app;
	}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {}

	onClose(): void {}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		this.contentEl.setText(String(content));
		return this;
	}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl = createHeadlessElement("div");

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {}

	hide(): void {}
}

export class MarkdownView {}

export class ItemView {
	leaf: unknown;
	containerEl = createHeadlessElement("div");

	constructor(leaf?: unknown) {
		this.leaf = leaf;
	}
}

export class Setting {
	constructor(readonly containerEl: unknown) {}
	setName(): this { return this; }
	setDesc(): this { return this; }
	addText(): this { return this; }
	addTextArea(): this { return this; }
	addToggle(): this { return this; }
	addDropdown(): this { return this; }
	addButton(): this { return this; }
	addSlider(): this { return this; }
}

export function arrayBufferToHex(data: ArrayBuffer): string {
	return Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const Platform = {
	isDesktop: false,
	isMobile: false,
	isDesktopApp: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: process.platform === "darwin",
	isWin: process.platform === "win32",
	isLinux: process.platform === "linux",
	isSafari: false,
	resourcePathPrefix: "file:///",
};

export function parseYaml(): unknown {
	return null;
}

export function stringifyYaml(value: unknown): string {
	return JSON.stringify(value);
}

export function parseFrontMatterAliases(): string[] | null { return null; }
export function parseFrontMatterEntry(): unknown { return null; }
export function parseFrontMatterStringArray(): string[] | null { return null; }
export function parseFrontMatterTags(): string[] | null { return null; }

