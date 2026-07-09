import { HeadlessApp } from "./app";
import type { HeadlessPluginManifest } from "./plugin";

export type HeadlessPluginConstructor<T> = new (
	app: HeadlessApp,
	manifest: HeadlessPluginManifest,
) => T;

export interface BootHeadlessPluginOptions<T> {
	app: HeadlessApp;
	manifest: HeadlessPluginManifest;
	PluginClass: HeadlessPluginConstructor<T>;
	pluginId?: string;
	callOnload?: boolean;
}

export async function bootHeadlessPlugin<T extends { onload?: () => unknown }>(
	options: BootHeadlessPluginOptions<T>,
): Promise<T> {
	const plugin = new options.PluginClass(options.app, options.manifest);
	const pluginId = options.pluginId ?? options.manifest.id;
	options.app.plugins.register(pluginId, plugin);
	if (options.callOnload !== false && typeof plugin.onload === "function") {
		await plugin.onload();
	}
	return plugin;
}

export async function unloadHeadlessPlugin(
	plugin: { unload?: () => unknown; onunload?: () => unknown },
	options?: { app?: HeadlessApp; pluginId?: string },
): Promise<void> {
	if (typeof plugin.unload === "function") {
		await plugin.unload();
	} else if (typeof plugin.onunload === "function") {
		await plugin.onunload();
	}
	if (options?.app && options.pluginId) {
		options.app.plugins.unregister(options.pluginId);
	}
}
