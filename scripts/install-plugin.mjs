#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const releaseFiles = ["manifest.json", "main.js", "telemetry.js", "styles.css"];

// Load .env and .env.local if present
function loadEnvFileSafe(filePath) {
	if (!existsSync(filePath)) return;
	try {
		if (typeof process.loadEnvFile === "function") {
			process.loadEnvFile(filePath);
			return;
		}
	} catch {
		// fallback to manual parsing if process.loadEnvFile fails
	}

	try {
		const content = readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx <= 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			let val = trimmed.slice(eqIdx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			if (key && !(key in process.env)) {
				process.env[key] = val;
			}
		}
	} catch {
		// ignore read errors
	}
}

loadEnvFileSafe(join(rootDir, ".env"));
loadEnvFileSafe(join(rootDir, ".env.local"));

function usage() {
	console.log(`Usage:
  npm run deploy
  npm run deploy -- --vault /path/to/vault
  npm run install:plugin -- --plugin-dir /path/to/vault/.obsidian/plugins/kaos

Options:
  --vault <path>        Obsidian vault root. Installs to <vault>/<config-dir>/plugins/<plugin-id>.
  --config-dir <name>   Obsidian config directory name (default: .obsidian or OBSIDIAN_CONFIG_DIR).
  --plugins-dir <path>  Obsidian plugins directory. Installs to <plugins-dir>/<plugin-id>.
  --plugin-dir <path>   Exact plugin directory to install into.
  --no-build            Copy existing root bundle files without running npm run build.
  --no-enable           Install files without adding the plugin to community-plugins.json.
  --dry-run             Print the target and files without writing.
  --help                Show this help.

Environment (via .env or shell):
  OBSIDIAN_VAULT_PATH   Obsidian vault root directory (recommended).
  OBSIDIAN_VAULT        Same as OBSIDIAN_VAULT_PATH.
  OBSIDIAN_CONFIG_DIR   Obsidian config folder name (default: .obsidian).
  OBSIDIAN_PLUGINS_DIR  Same as --plugins-dir.
  KAOS_PLUGIN_DIR       Same as --plugin-dir.
`);
}

function readOption(args, index, name) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value.`);
	}
	return value;
}

function parseArgs(args) {
	const parsed = {
		vault: process.env.OBSIDIAN_VAULT_PATH || process.env.OBSIDIAN_VAULT || null,
		configDirName: process.env.OBSIDIAN_CONFIG_DIR || ".obsidian",
		pluginsDir: process.env.OBSIDIAN_PLUGINS_DIR || null,
		pluginDir: process.env.KAOS_PLUGIN_DIR || null,
		build: true,
		enable: true,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--vault":
				parsed.vault = readOption(args, index, arg);
				index++;
				break;
			case "--config-dir":
				parsed.configDirName = readOption(args, index, arg);
				index++;
				break;
			case "--plugins-dir":
				parsed.pluginsDir = readOption(args, index, arg);
				index++;
				break;
			case "--plugin-dir":
				parsed.pluginDir = readOption(args, index, arg);
				index++;
				break;
			case "--no-build":
				parsed.build = false;
				break;
			case "--no-enable":
				parsed.enable = false;
				break;
			case "--dry-run":
				parsed.dryRun = true;
				break;
			case "--help":
			case "-h":
				usage();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	return parsed;
}

function assertDirectory(path, label) {
	if (!existsSync(path)) {
		throw new Error(`${label} does not exist: ${path}`);
	}
	const stat = statSync(path);
	if (!stat.isDirectory()) {
		throw new Error(`${label} is not a directory: ${path}`);
	}
}

function inferConfigDirFromPluginsDir(pluginsDir) {
	const configDir = dirname(resolve(pluginsDir));
	if (basename(configDir).startsWith(".")) {
		return configDir;
	}
	return null;
}

function inferConfigDirFromPluginDir(pluginDir) {
	const pluginsDir = dirname(resolve(pluginDir));
	if (basename(pluginsDir) !== "plugins") {
		return null;
	}
	return inferConfigDirFromPluginsDir(pluginsDir);
}

function resolveTarget(options, pluginId) {
	const explicitTargets = [options.pluginDir, options.pluginsDir, options.vault].filter(Boolean);
	if (explicitTargets.length === 0) {
		throw new Error(
			`No Obsidian vault path provided.

To configure your vault:
  1. Create a .env file (or copy from .env.example):
     cp .env.example .env
  2. Set your vault path in .env:
     OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault
  3. Run:
     npm run deploy

Alternatively, specify directly via CLI:
  npm run deploy -- --vault /path/to/your/obsidian/vault`,
		);
	}

	if (options.pluginDir) {
		const targetDir = resolve(options.pluginDir);
		return {
			targetDir,
			configDir: inferConfigDirFromPluginDir(targetDir),
		};
	}
	if (options.pluginsDir) {
		const pluginsDir = resolve(options.pluginsDir);
		assertDirectory(pluginsDir, "Plugins directory");
		return {
			targetDir: resolve(pluginsDir, pluginId),
			configDir: inferConfigDirFromPluginsDir(pluginsDir),
		};
	}

	const vaultDir = resolve(options.vault);
	assertDirectory(vaultDir, "Vault directory");
	const configDirName = options.configDirName || ".obsidian";
	return {
		targetDir: resolve(vaultDir, configDirName, "plugins", pluginId),
		configDir: resolve(vaultDir, configDirName),
	};
}

function runBuild() {
	console.log("Building KAOS plugin...");
	execFileSync("npm", ["run", "build"], {
		cwd: rootDir,
		stdio: "inherit",
	});
}

function copyReleaseFiles(targetDir, dryRun) {
	for (const file of releaseFiles) {
		const source = join(rootDir, file);
		if (!existsSync(source)) {
			throw new Error(`Release file is missing: ${source}`);
		}
		const destination = join(targetDir, file);
		if (dryRun) {
			console.log(`[dry-run] ${source} -> ${destination}`);
		} else {
			copyFileSync(source, destination);
			console.log(`Copied ${file}`);
		}
	}
}

function readEnabledPlugins(communityPluginsFile) {
	if (!existsSync(communityPluginsFile)) {
		return [];
	}

	const parsed = JSON.parse(readFileSync(communityPluginsFile, "utf8"));
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(`${communityPluginsFile} must contain a JSON array of plugin IDs.`);
	}
	return parsed;
}

function enablePlugin(configDir, pluginId, dryRun) {
	if (!configDir) {
		console.warn("Skipped enabling plugin: could not infer an Obsidian config directory from the target.");
		console.warn("Pass --vault or a path under .obsidian/plugins to enable automatically.");
		return;
	}

	const communityPluginsFile = join(configDir, "community-plugins.json");
	const enabledPlugins = readEnabledPlugins(communityPluginsFile);
	if (enabledPlugins.includes(pluginId)) {
		console.log(`${pluginId} is already enabled in community-plugins.json.`);
		return;
	}

	if (dryRun) {
		console.log(`[dry-run] Add ${pluginId} to ${communityPluginsFile}`);
		return;
	}

	mkdirSync(configDir, { recursive: true });
	enabledPlugins.push(pluginId);
	writeFileSync(communityPluginsFile, `${JSON.stringify(enabledPlugins, null, 2)}\n`);
	console.log(`Enabled ${pluginId} in community-plugins.json.`);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const manifest = JSON.parse(readFileSync(join(rootDir, "manifest.json"), "utf8"));
	if (!manifest.id) {
		throw new Error("manifest.json is missing an Obsidian plugin id.");
	}

	const { targetDir, configDir } = resolveTarget(options, manifest.id);
	console.log(`Install target: ${targetDir}`);
	if (options.enable) {
		console.log(configDir ? `Obsidian config: ${configDir}` : "Obsidian config: unknown");
	}

	if (options.dryRun) {
		copyReleaseFiles(targetDir, true);
		if (options.enable) {
			enablePlugin(configDir, manifest.id, true);
		}
		return;
	}

	if (options.build) {
		runBuild();
	}

	mkdirSync(targetDir, { recursive: true });
	copyReleaseFiles(targetDir, false);
	if (options.enable) {
		enablePlugin(configDir, manifest.id, false);
	}
	console.log(`\nSuccessfully deployed ${manifest.name ?? manifest.id} v${manifest.version ?? ""} into Obsidian!`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("");
	usage();
	process.exit(1);
}
