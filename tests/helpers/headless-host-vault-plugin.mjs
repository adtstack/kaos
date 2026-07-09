import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const PLUGIN_FILES = ["manifest.json", "main.js", "telemetry.js", "styles.css"];

export function buildProductPluginBundle() {
	const result = spawnSync(process.execPath, ["esbuild.config.mjs", "production"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

export function buildHeadlessHost() {
	const result = spawnSync(process.execPath, ["scripts/build-headless-host.mjs"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

export async function installVaultPlugin(vaultRoot, { pluginId = "kaos" } = {}) {
	const pluginDir = join(vaultRoot, ".obsidian", "plugins", pluginId);
	await mkdir(pluginDir, { recursive: true });
	for (const file of PLUGIN_FILES) {
		const source = resolve(file);
		assert.equal(existsSync(source), true, `${file} must be built before installing the vault plugin`);
		await copyFile(source, join(pluginDir, file));
	}
	return pluginDir;
}
