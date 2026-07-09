import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { HeadlessApp } from "../core/app";
import type { Plugin } from "../core/plugin";
import { bootHeadlessPlugin, type HeadlessPluginConstructor } from "../core/pluginHost";
import * as codeMirrorStateShim from "../codeMirrorStateShim";
import * as codeMirrorViewShim from "../codeMirrorViewShim";
import * as obsidianShim from "../obsidianShim";
import { installHeadlessHostPolyfills } from "../polyfills";

export interface BootKaosHeadlessPluginOptions {
	vaultRoot: string;
	dataFile: string;
	pluginId?: string;
	pluginDir?: string;
}

export async function bootKaosHeadlessPlugin(options: BootKaosHeadlessPluginOptions): Promise<{
	app: HeadlessApp;
	plugin: Plugin;
}> {
	installHeadlessHostPolyfills();
	await mkdir(options.vaultRoot, { recursive: true });
	await mkdir(dirname(options.dataFile), { recursive: true });
	const vaultRoot = resolve(options.vaultRoot);
	const pluginId = options.pluginId ?? "kaos";
	const pluginDir = resolve(options.pluginDir ?? join(vaultRoot, ".obsidian", "plugins", pluginId));
	const pluginVaultDir = vaultRelativePluginDir(vaultRoot, pluginDir);
	const manifest = await readPluginManifest(pluginDir);
	const PluginClass = await loadPluginMain(join(pluginDir, "main.js"));
	const app = new HeadlessApp({
		vaultRoot,
		dataFile: resolve(options.dataFile),
		excludedPaths: dataFileExclusionPaths(options.vaultRoot, options.dataFile),
	});
	const pluginManifest = {
		...manifest,
		dir: pluginVaultDir,
	};
	const plugin = await bootHeadlessPlugin({
		app,
		manifest: pluginManifest,
		PluginClass,
		pluginId: manifest.id,
	});
	return { app, plugin };
}

function dataFileExclusionPaths(vaultRoot: string, dataFile: string): string[] {
	const vault = resolve(vaultRoot);
	const data = resolve(dataFile);
	const rel = relative(vault, data);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(vault, rel) !== data) {
		return [".kaos-headless-host"];
	}
	const normalized = rel.split(sep).join("/");
	const parent = dirname(normalized).split(sep).join("/");
	const hiddenParent = parent && parent !== "." && parent.split("/").some((part) => part.startsWith("."))
		? parent
		: "";
	return [".kaos-headless-host", normalized, hiddenParent].filter((path, index, all) => path && all.indexOf(path) === index);
}

async function readPluginManifest(pluginDir: string): Promise<{
	id: string;
	name: string;
	version: string;
	minAppVersion?: string;
	author?: string;
	description?: string;
}> {
	const manifestPath = join(pluginDir, "manifest.json");
	let manifest: {
		id?: unknown;
		name?: unknown;
		version?: unknown;
		minAppVersion?: unknown;
		author?: unknown;
		description?: unknown;
	};
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
	} catch (err) {
		throw new Error(
			`KAOS plugin manifest is not readable at ${manifestPath}. Install the Obsidian plugin into the vault before starting headless. ${errorMessage(err)}`,
		);
	}
	if (typeof manifest.id !== "string" || manifest.id.length === 0) {
		throw new Error(`KAOS plugin manifest at ${manifestPath} is missing a valid id.`);
	}
	if (typeof manifest.name !== "string" || manifest.name.length === 0) {
		throw new Error(`KAOS plugin manifest at ${manifestPath} is missing a valid name.`);
	}
	if (typeof manifest.version !== "string" || manifest.version.length === 0) {
		throw new Error(`KAOS plugin manifest at ${manifestPath} is missing a valid version.`);
	}
	return manifest as {
		id: string;
		name: string;
		version: string;
		minAppVersion?: string;
		author?: string;
		description?: string;
	};
}

async function loadPluginMain(pluginMainPath: string): Promise<HeadlessPluginConstructor<Plugin>> {
	try {
		await access(pluginMainPath, constants.R_OK);
	} catch (err) {
		throw new Error(
			`KAOS plugin main.js is not readable at ${pluginMainPath}. Install the Obsidian plugin into the vault before starting headless. ${errorMessage(err)}`,
		);
	}
	const source = await readFile(pluginMainPath, "utf8");
	const pluginModule = new NodeModule(pluginMainPath);
	pluginModule.filename = pluginMainPath;
	pluginModule.paths = NodeModule._nodeModulePaths(dirname(pluginMainPath));
	const originalRequire = pluginModule.require.bind(pluginModule);
	pluginModule.require = ((request: string) => {
		if (request === "obsidian") return obsidianShim;
		if (request === "@codemirror/state") return codeMirrorStateShim;
		if (request === "@codemirror/view") return codeMirrorViewShim;
		if (request === "electron") return electronShim;
		try {
			return originalRequire(request);
		} catch (err) {
			throw new Error(
				`Failed to load dependency "${request}" while loading vault plugin ${pluginMainPath}: ${errorMessage(err)}`,
			);
		}
	}) as NodeJS.Require;
	try {
		pluginModule._compile(source, pluginMainPath);
	} catch (err) {
		throw new Error(`Failed to evaluate vault plugin ${pluginMainPath}: ${errorMessage(err)}`);
	}
	const exported = pluginModule.exports?.default ?? pluginModule.exports;
	if (typeof exported !== "function") {
		throw new Error(`Vault plugin ${pluginMainPath} did not export a plugin constructor.`);
	}
	return exported as HeadlessPluginConstructor<Plugin>;
}

function vaultRelativePluginDir(vaultRoot: string, pluginDir: string): string {
	const vault = resolve(vaultRoot);
	const plugin = resolve(pluginDir);
	const rel = relative(vault, plugin);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(vault, rel) !== plugin) {
		throw new Error(`KAOS headless plugin directory must be inside the vault: ${pluginDir}`);
	}
	return rel.split(sep).join("/");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const nodeRequire = createRequire(import.meta.url);
const NodeModule = nodeRequire("node:module") as {
	new (id: string): {
		filename: string;
		paths: string[];
		exports: any;
		require: NodeJS.Require;
		_compile(source: string, filename: string): void;
	};
	_nodeModulePaths(path: string): string[];
};

const electronShim = Object.freeze({});
