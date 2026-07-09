import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessApp } from "../src/headless-host/core/app";
import { TFile } from "../src/headless-host/core/fileTypes";
import { bootHeadlessPlugin, unloadHeadlessPlugin } from "../src/headless-host/core/pluginHost";
import { Plugin } from "../src/headless-host/core/plugin";
import { requestUrl } from "../src/headless-host/core/requestUrl";

interface FixtureData {
	bootCount: number;
	pluginId: string;
}

class FilesystemOnlyPlugin extends Plugin {
	modifyEvents = 0;
	unloaded = false;

	async onload(): Promise<void> {
		const current = await this.loadData() as FixtureData | null;
		await this.saveData({
			bootCount: (current?.bootCount ?? 0) + 1,
			pluginId: this.manifest.id,
		});

		this.addCommand({ id: "stage2-scan", name: "Stage 2 scan" });
		this.addSettingTab({ id: "stage2-settings" });
		this.registerView("stage2-view", () => undefined);
		this.registerEditorExtension({ id: "stage2-editor-extension" });
		this.registerObsidianProtocolHandler("stage2", () => undefined);

		await this.app.vault.createFolder("Stage2");
		const file = await this.app.vault.create("Stage2/hello.md", "hello\n");
		this.registerEvent(this.app.vault.on("modify", (changed: TFile) => {
			if (changed.path === file.path) this.modifyEvents++;
		}));
		await this.app.vault.modify(file, "hello from L1\n");
		await this.app.vault.createBinary(
			"Stage2/blob.bin",
			Uint8Array.from([1, 2, 3, 5, 8]).buffer,
		);
	}

	onunload(): void {
		this.unloaded = true;
	}
}

class NamespacedDataPlugin extends Plugin {
	async onload(): Promise<void> {
		await this.saveData({ pluginId: this.manifest.id });
	}
}

class RequestAndMetadataPlugin extends Plugin {
	async onload(): Promise<void> {
		await this.app.vault.createFolder("Stage2");
		await this.app.vault.create("Stage2/target.md", "target\n");
		const linked = this.app.metadataCache.getFirstLinkpathDest("target", "Stage2/source.md");
		const response = await requestUrl("data:application/json,%7B%22ok%22%3Atrue%7D");
		await this.saveData({
			status: response.status,
			ok: (response.json as { ok?: boolean } | null)?.ok === true,
			linkedPath: linked?.path ?? null,
		});
	}
}

const root = await mkdtemp(join(tmpdir(), "kaos-headless-l1-plugin-host-"));

try {
	const vaultRoot = join(root, "vault");
	const dataFile = join(root, "state", "data.json");
	const app = new HeadlessApp({ vaultRoot, dataFile });
	const plugin = await bootHeadlessPlugin({
		app,
		manifest: {
			id: "stage2-filesystem-only",
			name: "Stage 2 Filesystem Only",
			version: "0.0.0-test",
		},
		PluginClass: FilesystemOnlyPlugin,
	});

	console.log("\n--- headless host L1 plugin host: filesystem-only plugin boot ---");
	assert.equal(app.plugins.plugins["stage2-filesystem-only"], plugin, "plugin is registered by manifest id");
	assert.equal(plugin.modifyEvents, 1, "vault events are delivered to a generic plugin");
	assert.equal(app.commands.length, 1, "command registration is captured");
	assert.equal(app.settingTabs.length, 1, "settings tab registration is captured");
	assert.equal(app.registeredViews.has("stage2-view"), true, "view registration is captured");
	assert.equal(app.editorExtensions.length, 1, "editor extension registration is captured");
	assert.equal(app.protocolHandlers.has("stage2"), true, "protocol handler registration is captured");

	const data = JSON.parse(await readFile(dataFile, "utf8")) as FixtureData;
	assert.deepEqual(data, {
		bootCount: 1,
		pluginId: "stage2-filesystem-only",
	});

	const textFile = app.vault.getAbstractFileByPath("Stage2/hello.md");
	assert.ok(textFile instanceof TFile, "created Markdown file is visible as TFile");
	assert.equal(await app.vault.read(textFile), "hello from L1\n");

	const blobFile = app.vault.getAbstractFileByPath("Stage2/blob.bin");
	assert.ok(blobFile instanceof TFile, "created binary file is visible as TFile");
	assert.deepEqual(
		Array.from(new Uint8Array(await app.vault.readBinary(blobFile))),
		[1, 2, 3, 5, 8],
	);

	await unloadHeadlessPlugin(plugin);
	assert.equal(app.plugins.enabledPlugins.has("stage2-filesystem-only"), true, "default unload does not mutate registry");
	assert.equal(plugin.unloaded, true, "plugin onunload runs through generic unload helper");
	assert.equal(app.commands.length, 0, "command registrations are removed on unload");
	assert.equal(app.settingTabs.length, 0, "setting tab registrations are removed on unload");
	assert.equal(app.registeredViews.has("stage2-view"), false, "view registrations are removed on unload");
	assert.equal(app.editorExtensions.length, 0, "editor extensions are removed on unload");
	assert.equal(app.protocolHandlers.has("stage2"), false, "protocol handlers are removed on unload");

	await app.vault.modify(textFile, "after unload\n");
	assert.equal(plugin.modifyEvents, 1, "registered vault event is removed on unload");
	console.log("  PASS  generic filesystem-only plugin boots, persists data, uses vault APIs, and unloads cleanly");

	console.log("\n--- headless host L1 plugin host: per-plugin storage namespaces ---");
	const namespacedApp = new HeadlessApp({
		vaultRoot: join(root, "namespaced-vault"),
		dataFile: join(root, "namespaced-state", "fallback.json"),
		pluginDataMode: "per-plugin-file",
		pluginDataDir: join(root, "namespaced-state"),
	});
	const pluginA = await bootHeadlessPlugin({
		app: namespacedApp,
		manifest: { id: "stage2.alpha", name: "Alpha", version: "0.0.0-test" },
		PluginClass: NamespacedDataPlugin,
	});
	const pluginB = await bootHeadlessPlugin({
		app: namespacedApp,
		manifest: { id: "stage2.beta", name: "Beta", version: "0.0.0-test" },
		PluginClass: NamespacedDataPlugin,
	});
	assert.equal(namespacedApp.plugins.getPlugin("stage2.alpha"), pluginA);
	assert.equal(namespacedApp.plugins.getPlugin("stage2.beta"), pluginB);
	assert.deepEqual(JSON.parse(await readFile(join(root, "namespaced-state", "stage2.alpha.json"), "utf8")), {
		pluginId: "stage2.alpha",
	});
	assert.deepEqual(JSON.parse(await readFile(join(root, "namespaced-state", "stage2.beta.json"), "utf8")), {
		pluginId: "stage2.beta",
	});
	await unloadHeadlessPlugin(pluginA, { app: namespacedApp, pluginId: "stage2.alpha" });
	assert.equal(namespacedApp.plugins.getPlugin("stage2.alpha"), null, "generic unload helper can unregister plugin");
	assert.equal(namespacedApp.plugins.enabledPlugins.has("stage2.alpha"), false, "unregistered plugin is no longer enabled");
	assert.equal(namespacedApp.plugins.getPlugin("stage2.beta"), pluginB, "other plugin registry entry is preserved");
	console.log("  PASS  per-plugin data files and registry unregister work without KAOS imports");

	console.log("\n--- headless host L1 plugin host: requestUrl and metadata cache surface ---");
	const surfaceApp = new HeadlessApp({
		vaultRoot: join(root, "surface-vault"),
		dataFile: join(root, "surface-state", "fallback.json"),
		pluginDataMode: "per-plugin-file",
		pluginDataDir: join(root, "surface-state"),
	});
	await bootHeadlessPlugin({
		app: surfaceApp,
		manifest: { id: "stage2.surface", name: "Surface", version: "0.0.0-test" },
		PluginClass: RequestAndMetadataPlugin,
	});
	assert.deepEqual(JSON.parse(await readFile(join(root, "surface-state", "stage2.surface.json"), "utf8")), {
		status: 200,
		ok: true,
		linkedPath: "Stage2/target.md",
	});
	console.log("  PASS  requestUrl and metadata link resolution work for filesystem-only plugins");
} finally {
	await rm(root, { recursive: true, force: true });
}
