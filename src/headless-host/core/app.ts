import { dirname, resolve } from "node:path";
import { HeadlessFileManager } from "./fileManager";
import { HeadlessMetadataCache } from "./metadataCache";
import { HeadlessPluginRegistry } from "./pluginRegistry";
import { HeadlessPluginStorage } from "./pluginStorage";
import { HeadlessVault } from "./vault";
import { HeadlessWorkspace } from "./workspace";

export type HeadlessPluginDataMode = "single-file" | "per-plugin-file";

export interface HeadlessAppOptions {
	vaultRoot: string;
	dataFile: string;
	pluginDataDir?: string;
	pluginDataMode?: HeadlessPluginDataMode;
	configDir?: string;
	excludedPaths?: string[];
}

export class HeadlessApp {
	readonly vault: HeadlessVault;
	readonly workspace = new HeadlessWorkspace();
	readonly metadataCache: HeadlessMetadataCache;
	readonly fileManager: HeadlessFileManager;
	readonly pluginStorage: HeadlessPluginStorage;
	readonly plugins = new HeadlessPluginRegistry();
	readonly registeredViews = new Map<string, unknown>();
	readonly protocolHandlers = new Map<string, unknown>();
	readonly editorExtensions: unknown[] = [];
	settingTabs: unknown[] = [];
	commands: unknown[] = [];
	private readonly pluginStorageById = new Map<string, HeadlessPluginStorage>();
	private readonly pluginDataDir: string;
	private readonly pluginDataMode: HeadlessPluginDataMode;

	constructor(options: HeadlessAppOptions) {
		this.vault = new HeadlessVault({
			vaultRoot: options.vaultRoot,
			configDir: options.configDir,
			excludedPaths: options.excludedPaths,
		});
		this.metadataCache = new HeadlessMetadataCache(this.vault);
		this.fileManager = new HeadlessFileManager(this.vault);
		this.pluginStorage = new HeadlessPluginStorage(options.dataFile);
		this.pluginDataMode = options.pluginDataMode ?? "single-file";
		this.pluginDataDir = resolve(options.pluginDataDir ?? dirname(options.dataFile));
	}

	pluginStorageFor(pluginId: string): HeadlessPluginStorage {
		if (this.pluginDataMode === "single-file") {
			return this.pluginStorage;
		}
		const storage = this.pluginStorageById.get(pluginId);
		if (storage) return storage;
		const next = new HeadlessPluginStorage(resolve(this.pluginDataDir, `${safePluginDataName(pluginId)}.json`));
		this.pluginStorageById.set(pluginId, next);
		return next;
	}
}

function safePluginDataName(pluginId: string): string {
	const safe = pluginId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	if (!safe) throw new Error(`Invalid plugin id for headless storage: ${pluginId}`);
	return safe;
}
