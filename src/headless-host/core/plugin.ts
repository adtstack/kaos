import { createHeadlessElement } from "./dom";
import type { HeadlessEventRef } from "./events";

type Cleanup = () => unknown;

export class Component {
	private readonly cleanups: Cleanup[] = [];
	private readonly children: Component[] = [];

	load(): void {
		this.onload();
	}

	onload(): void {}

	unload(): void {
		for (const child of [...this.children].reverse()) {
			child.unload();
		}
		for (const cleanup of [...this.cleanups].reverse()) {
			cleanup();
		}
		this.cleanups.length = 0;
		this.onunload();
	}

	onunload(): void {}

	addChild<T extends Component>(component: T): T {
		this.children.push(component);
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
		component.unload();
		return component;
	}

	register(cleanup: Cleanup): void {
		this.cleanups.push(cleanup);
	}

	registerEvent(eventRef: HeadlessEventRef): void {
		this.register(() => eventRef.off());
	}

	registerDomEvent(): void {
		// UI events do not fire in the headless host.
	}

	registerInterval(id: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
		this.register(() => clearInterval(id));
		return id;
	}
}

export interface HeadlessPluginManifest {
	id: string;
	name: string;
	version: string;
	dir?: string;
	minAppVersion?: string;
	author?: string;
	description?: string;
}

export class Plugin extends Component {
	app: any;
	manifest: HeadlessPluginManifest;

	constructor(app: any, manifest: HeadlessPluginManifest) {
		super();
		this.app = app;
		this.manifest = manifest;
	}

	async loadData(): Promise<unknown> {
		return await this.app.pluginStorageFor(this.manifest.id).load();
	}

	async saveData(data: unknown): Promise<void> {
		await this.app.pluginStorageFor(this.manifest.id).save(data);
	}

	addRibbonIcon(): any {
		return createHeadlessElement("button");
	}

	addStatusBarItem(): any {
		return createHeadlessElement("span");
	}

	addCommand(command: unknown): unknown {
		this.app.commands.push(command);
		this.register(() => {
			this.app.commands = this.app.commands.filter((registered: unknown) => registered !== command);
		});
		return command;
	}

	removeCommand(commandId: string): void {
		this.app.commands = this.app.commands.filter((command: { id?: string }) => command.id !== commandId);
	}

	addSettingTab(settingTab: unknown): void {
		this.app.settingTabs.push(settingTab);
		this.register(() => {
			this.app.settingTabs = this.app.settingTabs.filter((registered: unknown) => registered !== settingTab);
		});
	}

	registerView(type: string, viewCreator: unknown): void {
		this.app.registeredViews.set(type, viewCreator);
		this.register(() => {
			if (this.app.registeredViews.get(type) === viewCreator) {
				this.app.registeredViews.delete(type);
			}
		});
	}

	registerHoverLinkSource(): void {}

	registerExtensions(): void {}

	registerMarkdownPostProcessor(postProcessor: unknown): unknown {
		return postProcessor;
	}

	registerMarkdownCodeBlockProcessor(_language: string, handler: unknown): unknown {
		return handler;
	}

	registerEditorExtension(extension: unknown): void {
		this.app.editorExtensions.push(extension);
		this.register(() => {
			this.app.editorExtensions = this.app.editorExtensions.filter((registered: unknown) => registered !== extension);
		});
	}

	registerObsidianProtocolHandler(action: string, handler: unknown): void {
		this.app.protocolHandlers.set(action, handler);
		this.register(() => {
			if (this.app.protocolHandlers.get(action) === handler) {
				this.app.protocolHandlers.delete(action);
			}
		});
	}

	registerEditorSuggest(): void {}
}
