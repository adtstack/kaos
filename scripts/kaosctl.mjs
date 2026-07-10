#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants, openSync, closeSync } from "node:fs";
import { hostname, homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { unzipSync } from "fflate";

const DEFAULT_REPO = "adtstack/kaos";
const DEFAULT_SERVICE_NAME = "kaos-headless-host.service";
const USER_MANIFEST = "kaos-headless-user-manifest.json";
const USER_ZIP = "kaos-headless-user.zip";
const PLUGIN_ZIP = "kaos-plugin.zip";
const RUNNER = "kaos-headless-host.mjs";
const KAOSCTL = "kaosctl.mjs";
const VERSION_FILE = "VERSION";
const PLUGIN_FILES = ["manifest.json", "main.js", "telemetry.js", "styles.css"];
const RESOLVER_DIR = ".kaos-resolver";
const MARKDOWN_CONFLICT_ARTIFACT_NAME_RE =
	/^(.+) \(KAOS conflict(?: - (crdt|disk|editor))? from (.+) (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\)(?: (\d+))?(\.md)$/;
const BLOB_CONFLICT_ARTIFACT_NAME_RE =
	/^(.+) \(KAOS remote conflict (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\)(?: (\d+))?(\.[^/.]+)?$/;

async function main() {
	const [command = "help", ...args] = process.argv.slice(2);
	if (command === "help" || command === "--help" || command === "-h") {
		printUsage();
		return;
	}
	if (command === "install") {
		await installInteractive(parseArgs(args));
		return;
	}
	if (command === "update") {
		await updateNonInteractive(parseArgs(args));
		return;
	}
	if (command === "uninstall") {
		await uninstallUserHeadless(args);
		return;
	}
	if (command === "status") {
		await printStatus(parseArgs(args));
		return;
	}
	if (command === "doctor") {
		await runDoctorCommand(parseArgs(args));
		return;
	}
	if (command === "conflicts") {
		await runConflictsCommand(args);
		return;
	}
	if (command === "ui") {
		await runConflictUi(parseArgs(args));
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (["--startup", "--json", "--full", "--force"].includes(arg)) {
			out[arg.slice(2)] = "true";
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected positional argument: ${arg}`);
		}
		const withoutPrefix = arg.slice(2);
		const eq = withoutPrefix.indexOf("=");
		if (eq >= 0) {
			out[withoutPrefix.slice(0, eq)] = withoutPrefix.slice(eq + 1);
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			throw new Error(`missing value for --${withoutPrefix}`);
		}
		out[withoutPrefix] = next;
		i++;
	}
	return out;
}

async function uninstallUserHeadless(args) {
	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		return;
	}
	if (args.some((arg) => ["--scope", "--remove-user", "--remove-group"].includes(arg.split("=", 1)[0]))) {
		throw new Error("kaos uninstall only supports the user installation; run uninstall-headless-host.mjs directly for a system installation");
	}
	const helper = fileURLToPath(new URL("./uninstall-headless-host.mjs", import.meta.url));
	const result = spawnSync(process.execPath, ["--", helper, "--scope", "user", ...args], {
		encoding: "utf8",
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
	}
}

async function installInteractive(raw) {
	if (raw.help === "true") {
		printUsage();
		return;
	}
	const paths = defaultUserPaths();
	await assertCommandPathReusable(paths.binKaos, {
		commandName: "kaos",
		installRoot: paths.installRoot,
	});
	const tty = await openTty();
	try {
		const releaseBaseUrl = raw["release-base-url"] ?? process.env.KAOS_RELEASE_BASE_URL ?? githubReleaseBaseUrl();
		const releaseManifest = raw["release-manifest"]
			? await readJsonFile(resolve(raw["release-manifest"]))
			: await fetchJson(assetUrl(releaseBaseUrl, USER_MANIFEST));
		assertUserReleaseManifest(releaseManifest);
		const version = readManifestVersion(releaseManifest);
		const workDir = await mkdtemp(join(tmpdir(), "kaos-user-install-"));
		const userZip = await obtainReleaseAsset({
			manifest: releaseManifest,
			baseUrl: releaseBaseUrl,
			asset: USER_ZIP,
			workDir,
		});
		let installedPluginDuringInstall = false;

		writeTty(tty, "\nKAOS headless interactive installer\n\n");
		assertNodeVersion();
		const vaultRoot = await promptVaultRoot(tty);
		const pluginDir = join(vaultRoot, ".obsidian", "plugins", "kaos");
		const pluginState = await inspectVaultPlugin(pluginDir);
		const pluginData = pluginState.data ?? {};
		writeTty(tty, pluginState.found
			? `Found KAOS plugin in vault: ${pluginDir}\n`
			: `KAOS plugin is not installed in this vault: ${pluginDir}\n`);
		if (pluginState.manifest?.version) {
			writeTty(tty, `Vault plugin version: ${pluginState.manifest.version}\n`);
		}
		if (pluginState.dataPath) {
			writeTty(tty, "Found KAOS plugin data.json; seeding headless config from it.\n");
		}

		if (!pluginState.usable) {
			const installPlugin = await promptYesNo(tty, "Install the KAOS plugin into this vault now?", true);
			if (!installPlugin) {
				throw new Error("KAOS plugin is required in the vault before headless can run.");
			}
			const pluginZip = await obtainReleaseAsset({
				manifest: releaseManifest,
				baseUrl: releaseBaseUrl,
				asset: PLUGIN_ZIP,
				workDir,
			});
			const pluginInstall = await installPluginZip(pluginZip, pluginDir);
			await finalizePluginInstall(pluginInstall);
			await enableVaultPlugin(vaultRoot, "kaos");
			installedPluginDuringInstall = true;
			writeTty(tty, "Installed KAOS plugin into the vault.\n");
		}

		const host = await promptText(tty, "Worker host", asNonEmptyString(pluginData.host));
		const vaultId = await promptText(tty, "Vault id", asNonEmptyString(pluginData.vaultId));
		const token = asNonEmptyString(pluginData.token) ?? await promptSecret(tty, "Sync token");
		const defaultDevice = `${sanitizeDeviceName(hostname())}-headless`;
		const deviceName = await promptText(tty, "Headless device name", defaultDevice);
		const enableAttachmentSync = readBoolean(pluginData.enableAttachmentSync) ?? await promptYesNo(tty, "Enable attachment sync?", true);

		writeTty(tty, "\nInstall summary\n");
		writeTty(tty, `  Version: ${version}\n`);
		writeTty(tty, `  Vault: ${vaultRoot}\n`);
		writeTty(tty, `  Plugin: ${pluginDir}\n`);
		writeTty(tty, `  Host: ${host}\n`);
		writeTty(tty, `  Vault id: ${vaultId}\n`);
		writeTty(tty, `  Token: configured\n`);
		writeTty(tty, `  Device: ${deviceName}\n`);
		writeTty(tty, `  Install dir: ${paths.installRoot}\n`);
		writeTty(tty, `  Command: ${paths.binKaos}\n`);
		const proceed = await promptYesNo(tty, "Continue?", true);
		if (!proceed) throw new Error("install cancelled");

		await installUserRelease({ userZip, version, paths });
		if (installedPluginDuringInstall) {
			await enableVaultPlugin(vaultRoot, "kaos");
		}
		await writeHeadlessConfig({
			paths,
			vaultRoot,
			pluginDir,
			host,
			vaultId,
			token,
			deviceName,
			enableAttachmentSync,
			releaseBaseUrl,
			version,
		});
		await writeUserService({ paths, vaultRoot, pluginDir });
		await linkKaosCommands(paths);

		writeTty(tty, "\nKAOS headless installed.\n");
		writeTty(tty, `Service file: ${paths.serviceFile}\n`);
		writeTty(tty, `Run: systemctl --user daemon-reload\n`);
		writeTty(tty, `Run: systemctl --user enable --now kaos-headless-host\n`);
		if (!pathListIncludes(paths.binDir)) {
			writeTty(tty, `Add ${paths.binDir} to PATH if the kaos command is not found in a new shell.\n`);
		}
		if (await commandExists("systemctl")) {
			const enableNow = await promptYesNo(tty, "Start and enable the user service now?", true);
			if (enableNow) {
				runChecked("systemctl", ["--user", "daemon-reload"]);
				runChecked("systemctl", ["--user", "enable", "--now", "kaos-headless-host"]);
				writeTty(tty, "Started kaos-headless-host user service.\n");
			}
		}
		const linger = await promptYesNo(tty, "Show command for reboot start without login?", false);
		if (linger) {
			writeTty(tty, `Run once if desired: sudo loginctl enable-linger ${process.env.USER ?? "$USER"}\n`);
		}
	} finally {
		await tty.close();
	}
}

async function updateNonInteractive(raw) {
	const startup = raw.startup === "true";
	try {
		const configPath = resolve(raw.config ?? defaultUserPaths().installConfig);
		const config = await readJsonFile(configPath);
		const paths = pathsFromConfig(config);
		const releaseBaseUrl = asNonEmptyString(config.releaseBaseUrl) ?? githubReleaseBaseUrl();
		const manifest = await fetchJson(assetUrl(releaseBaseUrl, USER_MANIFEST));
		assertUserReleaseManifest(manifest);
		const latestVersion = readManifestVersion(manifest);
		const latestPluginVersion = readManifestPluginVersion(manifest);
		const currentVersion = await readCurrentVersion(paths).catch(() => asNonEmptyString(config.version) ?? "0.0.0");
		const pluginState = await inspectVaultPlugin(config.pluginDir);
		const installedPluginVersion = asNonEmptyString(pluginState.manifest?.version);
		const pluginNeedsUpdate = !pluginState.usable
			|| !installedPluginVersion
			|| compareVersions(latestPluginVersion, installedPluginVersion) > 0;
		const releaseNeedsUpdate = compareVersions(latestVersion, currentVersion) > 0;
		if (!releaseNeedsUpdate && !pluginNeedsUpdate) {
			console.log(JSON.stringify({
				kind: "kaos-user-update",
				ok: true,
				updated: false,
				currentVersion,
				latestVersion,
				pluginVersion: installedPluginVersion,
				latestPluginVersion,
			}, null, 2));
			return;
		}

		const workDir = resolve(raw["work-dir"] ?? await mkdtemp(join(tmpdir(), "kaos-user-update-")));
		const userZip = releaseNeedsUpdate
			? await obtainReleaseAsset({ manifest, baseUrl: releaseBaseUrl, asset: USER_ZIP, workDir })
			: null;
		const pluginZip = pluginNeedsUpdate
			? await obtainReleaseAsset({ manifest, baseUrl: releaseBaseUrl, asset: PLUGIN_ZIP, workDir })
			: null;
		const previousCurrent = await resolveCurrentSymlink(paths).catch(() => null);
		let installedReleaseDir = null;
		let pluginInstall = null;
		try {
			if (pluginZip) {
				pluginInstall = await installPluginZip(pluginZip, config.pluginDir);
			}
			if (userZip) {
				installedReleaseDir = await installUserRelease({ userZip, version: latestVersion, paths });
				await verifyInstalledHeadless({ paths, config, releaseDir: installedReleaseDir });
				await linkKaosCommands(paths);
			}
			await writeJsonAtomic(configPath, {
				...config,
				version: releaseNeedsUpdate ? latestVersion : currentVersion,
				pluginVersion: pluginNeedsUpdate ? latestPluginVersion : installedPluginVersion,
				updatedAt: new Date().toISOString(),
			}, 0o600);
			if (pluginInstall) await finalizePluginInstall(pluginInstall);
		} catch (err) {
			if (releaseNeedsUpdate) {
				await restoreCurrentSymlink(paths, previousCurrent).catch(() => undefined);
			}
			if (pluginInstall) await rollbackPluginInstall(pluginInstall).catch(() => undefined);
			throw err;
		}

		console.log(JSON.stringify({
			kind: "kaos-user-update",
			ok: true,
			updated: true,
			previousVersion: currentVersion,
			version: releaseNeedsUpdate ? latestVersion : currentVersion,
			releaseDir: installedReleaseDir,
			pluginUpdated: pluginNeedsUpdate,
			pluginVersion: latestPluginVersion,
		}, null, 2));
	} catch (err) {
		if (startup) {
			console.error(JSON.stringify({
				kind: "kaos-user-update",
				ok: false,
				startup: true,
				error: errorMessage(err),
				action: "continuing with installed version",
			}));
			return;
		}
		throw err;
	}
}

async function printStatus(raw) {
	const config = await readJsonFile(resolve(raw.config ?? defaultUserPaths().installConfig));
	const paths = pathsFromConfig(config);
	const currentVersion = await readCurrentVersion(paths).catch(() => "unknown");
	let latestVersion = null;
	try {
		const releaseBaseUrl = asNonEmptyString(config.releaseBaseUrl) ?? githubReleaseBaseUrl();
		const manifest = await fetchJson(assetUrl(releaseBaseUrl, USER_MANIFEST));
		assertUserReleaseManifest(manifest);
		latestVersion = readManifestVersion(manifest);
	} catch {
		latestVersion = null;
	}
	console.log(JSON.stringify({
		kind: "kaos-user-status",
		ok: true,
		currentVersion,
		latestVersion,
		updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : null,
		vaultRoot: config.vaultRoot,
		pluginDir: config.pluginDir,
		serviceFile: paths.serviceFile,
	}, null, 2));
}

async function runDoctorCommand(raw) {
	const config = await readJsonFile(resolve(raw.config ?? defaultUserPaths().installConfig));
	const paths = pathsFromConfig(config);
	const result = runNodeJson(join(paths.currentLink, RUNNER), doctorArgs({ config, paths }));
	console.log(JSON.stringify(result, null, 2));
}

async function runConflictsCommand(argv) {
	const [subcommand = "list", ...rest] = argv;
	if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		printConflictsUsage();
		return;
	}
	const { id, raw } = parseSubcommandArgs(rest);
	if (raw.help === "true") {
		printConflictsUsage();
		return;
	}
	if (subcommand === "list") {
		const inventory = await scanConflictInventory(raw);
		if (raw.json === "true") {
			console.log(JSON.stringify(inventory, null, 2));
		} else {
			printConflictList(inventory);
		}
		return;
	}
	if (subcommand === "show") {
		const item = await requireConflictItem(raw, id);
		printConflictDetail(item, { json: raw.json === "true" });
		return;
	}
	if (subcommand === "diff") {
		const { context, item } = await requireConflictItemWithContext(raw, id);
		console.log(await renderConflictDiff(context, item, { full: raw.full === "true" }));
		return;
	}
	if (["keep-current", "keep-artifact", "keep-local", "accept-delete"].includes(subcommand)) {
		const result = await applyConflictAction(raw, id, subcommand);
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	throw new Error(`unknown conflicts command: ${subcommand}`);
}

function parseSubcommandArgs(argv) {
	let id = null;
	let rest = argv;
	if (rest[0] && !rest[0].startsWith("--")) {
		id = rest[0];
		rest = rest.slice(1);
	}
	return { id, raw: parseArgs(rest) };
}

async function runConflictUi(raw) {
	if (raw.help === "true") {
		printUsage();
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("kaos ui requires an interactive TTY; showing read-only conflict list instead.");
		printConflictList(await scanConflictInventory(raw));
		return;
	}

	const context = await resolveConflictContext(raw);
	let readOnly = false;
	let stoppedService = false;
	const lock = await readResolverLock(context);
	if (lock.held) {
		const stop = await promptStdYesNo(
			`Headless host lock exists at ${lock.path}. Stop the user service before resolving conflicts?`,
			false,
		);
		if (stop) {
			try {
				runChecked("systemctl", ["--user", "stop", "kaos-headless-host"]);
				stoppedService = true;
			} catch (err) {
				readOnly = true;
				console.error(`Failed to stop kaos-headless-host: ${errorMessage(err)}`);
				console.error("Continuing in read-only mode.");
			}
		} else {
			readOnly = true;
		}
	}

	let inventory = await scanConflictInventory({ ...raw, _context: context });
	let selected = 0;
	let message = "Close Obsidian for this vault before applying changes. Press q to quit.";
	let mode = "list";
	let detailText = "";
	emitKeypressEvents(process.stdin);
	const keyReader = createKeyReader(process.stdin);
	process.stdin.setRawMode?.(true);
	let uiError = null;
	try {
		while (true) {
			renderConflictUi({ inventory, selected, message, mode, detailText, readOnly });
			const key = await keyReader.read();
			const name = key?.name;
			const item = inventory.items[selected] ?? null;
			if (name === "q" || (key?.ctrl && name === "c")) break;
			if (name === "j" || name === "down") {
				selected = moveConflictSelection(inventory, selected, 1);
				mode = "list";
				continue;
			}
			if (name === "k" || name === "up") {
				selected = moveConflictSelection(inventory, selected, -1);
				mode = "list";
				continue;
			}
			if (!item) {
				message = "No conflicts found.";
				continue;
			}
			if (name === "return") {
				mode = "detail";
				detailText = formatConflictDetail(item);
				continue;
			}
			if (name === "d") {
				mode = "detail";
				detailText = await renderConflictDiff(context, item, { full: false });
				continue;
			}
			if (name === "b") {
				message = `Backups: ${join(context.vaultRoot, RESOLVER_DIR, "backups")}`;
				continue;
			}
			const action = resolveUiAction(item, key);
			if (!action) continue;
			if (readOnly) {
				message = "Read-only mode: stop headless-host before applying changes.";
				continue;
			}
			try {
				const result = await applyConflictAction({ ...raw, _context: context }, item.id, action);
				message = `${action} applied. Backup: ${result.backupDir}`;
				inventory = await scanConflictInventory({ ...raw, _context: context });
				selected = Math.min(selected, Math.max(0, inventory.items.length - 1));
				mode = "list";
			} catch (err) {
				message = errorMessage(err);
			}
		}
	} catch (err) {
		uiError = err;
	} finally {
		keyReader.close();
		process.stdin.setRawMode?.(false);
		process.stdout.write("\x1b[?25h\x1b[0m\n");
	}
	try {
		if (!uiError && stoppedService) {
			const start = await promptStdYesNo("Start kaos-headless-host user service again?", true);
			if (start) {
				try {
					runChecked("systemctl", ["--user", "start", "kaos-headless-host"]);
				} catch (err) {
					console.error(`Failed to start kaos-headless-host: ${errorMessage(err)}`);
				}
			}
		}
	} finally {
		process.stdin.pause();
	}
	if (uiError) throw uiError;
}

async function scanConflictInventory(raw = {}) {
	const context = raw._context ?? await resolveConflictContext(raw);
	const items = [
		...await scanConflictArtifacts(context),
		...await scanPreservedUnresolved(context),
	].sort(compareConflictItems);
	for (let i = 0; i < items.length; i++) {
		items[i].id = `C${String(i + 1).padStart(3, "0")}`;
	}
	return {
		kind: "kaos-conflicts",
		ok: true,
		vaultRoot: context.vaultRoot,
		count: items.length,
		items,
	};
}

async function resolveConflictContext(raw) {
	if (raw._context) return raw._context;
	const defaults = defaultUserPaths();
	const explicitConfig = asNonEmptyString(raw.config);
	const configPath = explicitConfig ? resolveUserPath(explicitConfig) : defaults.installConfig;
	const config = explicitConfig
		? await readJsonFile(configPath)
		: raw.vault
			? null
			: await readJsonIfExists(configPath);
	const paths = isRecord(config) ? pathsFromConfig(config) : defaults;
	const rawVaultRoot = asNonEmptyString(raw.vault) ?? asNonEmptyString(config?.vaultRoot);
	if (!rawVaultRoot) {
		throw new Error("Choose a vault with --vault or install KAOS headless first.");
	}
	const vaultRoot = resolveUserPath(rawVaultRoot);
	const vaultInfo = await lstatOrNull(vaultRoot);
	if (!vaultInfo?.isDirectory()) {
		throw new Error(`vault does not exist or is not a directory: ${vaultRoot}`);
	}
	const pluginDir = resolveUserPath(raw["plugin-dir"] ?? config?.pluginDir ?? join(vaultRoot, ".obsidian", "plugins", "kaos"));
	const dataFiles = uniquePaths([
		raw["data-file"] ? resolveUserPath(raw["data-file"]) : (config ? paths.dataFile : null),
		join(pluginDir, "data.json"),
	]);
	return {
		vaultRoot,
		pluginDir,
		dataFiles,
		lockFile: raw["lock-file"] ? resolveUserPath(raw["lock-file"]) : (config ? paths.lockFile : null),
		resolverDir: join(vaultRoot, RESOLVER_DIR),
	};
}

async function scanConflictArtifacts(context) {
	const files = await walkVaultFiles(context.vaultRoot);
	const items = [];
	for (const path of files) {
		const parsed = parseConflictArtifactPath(path);
		if (!parsed) continue;
		const currentExists = await pathExists(vaultPath(context, parsed.inferredOriginalPath));
		items.push({
			id: null,
			type: `${parsed.kind}-artifact`,
			kind: parsed.kind,
			path: parsed.inferredOriginalPath,
			currentPath: parsed.inferredOriginalPath,
			artifactPath: parsed.artifactPath,
			source: parsed.source,
			deviceName: parsed.deviceName,
			timestamp: parsed.timestamp,
			copyIndex: parsed.copyIndex,
			originalPathConfidence: parsed.originalPathConfidence,
			currentExists,
			artifactExists: true,
			current: await describeVaultFile(context, parsed.inferredOriginalPath),
			artifact: await describeVaultFile(context, parsed.artifactPath),
		});
	}
	return items;
}

async function scanPreservedUnresolved(context) {
	const merged = new Map();
	for (const dataFile of context.dataFiles) {
		const data = await readJsonIfExists(dataFile);
		if (!isRecord(data) || !Array.isArray(data._preservedUnresolved)) continue;
		for (const rawEntry of data._preservedUnresolved) {
			if (!isRecord(rawEntry)) continue;
			const path = normalizeVaultPath(rawEntry.path);
			const kind = rawEntry.kind === "blob" ? "blob" : rawEntry.kind === "markdown" ? "markdown" : null;
			if (!path || !kind) continue;
			const key = `${kind}:${path}`;
			const previous = merged.get(key);
			const firstSeenAt = toNumber(rawEntry.firstSeenAt) ?? previous?.firstSeenAt ?? Date.now();
			const lastSeenAt = Math.max(toNumber(rawEntry.lastSeenAt) ?? 0, previous?.lastSeenAt ?? 0, firstSeenAt);
			merged.set(key, {
				id: null,
				type: "preserved-unresolved",
				kind,
				path,
				currentPath: path,
				reason: asNonEmptyString(rawEntry.reason) ?? previous?.reason ?? "unknown",
				firstSeenAt,
				lastSeenAt,
				currentExists: await pathExists(vaultPath(context, path)),
				current: await describeVaultFile(context, path),
				dataSources: uniquePaths([...(previous?.dataSources ?? []), dataFile]),
			});
		}
	}
	return Array.from(merged.values());
}

async function walkVaultFiles(vaultRoot) {
	const out = [];
	async function walk(relDir) {
		const absDir = relDir ? vaultPath({ vaultRoot }, relDir) : vaultRoot;
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const rel = normalizeVaultPath(relDir ? `${relDir}/${entry.name}` : entry.name);
			if (isResolverExcludedPath(rel)) continue;
			if (entry.isDirectory()) {
				await walk(rel);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	}
	await walk("");
	return out;
}

function isResolverExcludedPath(path) {
	const first = normalizeVaultPath(path).split("/")[0];
	return [".obsidian", ".trash", ".kaos-headless-host", RESOLVER_DIR].includes(first);
}

async function describeVaultFile(context, path) {
	const abs = vaultPath(context, path);
	const info = await lstatOrNull(abs);
	if (!info || !info.isFile()) return { exists: false };
	return {
		exists: true,
		size: info.size,
		mtimeMs: Math.trunc(info.mtimeMs),
		sha256: await sha256File(abs).catch(() => null),
	};
}

function compareConflictItems(a, b) {
	const at = itemSortTime(a);
	const bt = itemSortTime(b);
	if (at !== bt) return bt - at;
	return `${a.type}:${a.path}:${a.artifactPath ?? ""}`.localeCompare(`${b.type}:${b.path}:${b.artifactPath ?? ""}`);
}

function itemSortTime(item) {
	if (typeof item.lastSeenAt === "number") return item.lastSeenAt;
	const parsed = Date.parse(item.timestamp ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

async function requireConflictItem(raw, id) {
	return (await requireConflictItemWithContext(raw, id)).item;
}

async function requireConflictItemWithContext(raw, id) {
	if (!id) throw new Error("conflict id is required");
	const context = raw._context ?? await resolveConflictContext(raw);
	const inventory = await scanConflictInventory({ ...raw, _context: context });
	const item = inventory.items.find((candidate) => candidate.id === id);
	if (!item) throw new Error(`conflict not found: ${id}`);
	return { context, item };
}

function printConflictList(inventory) {
	if (inventory.items.length === 0) {
		console.log(`No conflicts found in ${inventory.vaultRoot}.`);
		return;
	}
	console.log(`Conflicts in ${inventory.vaultRoot}`);
	for (const item of inventory.items) {
		console.log(`${item.id}  ${formatConflictSummary(item)}`);
	}
}

function printConflictDetail(item, { json }) {
	if (json) {
		console.log(JSON.stringify(item, null, 2));
	} else {
		console.log(formatConflictDetail(item));
	}
}

function formatConflictSummary(item) {
	if (item.type === "preserved-unresolved") {
		return `${item.kind} preserved-unresolved  ${item.path}  (${item.reason})`;
	}
	const current = item.currentExists ? "current" : "current-missing";
	return `${item.kind} artifact  ${item.path}  <- ${item.artifactPath}  [${item.source ?? "unknown"}, ${current}]`;
}

function formatConflictDetail(item) {
	const lines = [
		`${item.id} ${formatConflictSummary(item)}`,
		`type: ${item.type}`,
		`path: ${item.path}`,
	];
	if (item.artifactPath) lines.push(`artifact: ${item.artifactPath}`);
	if (item.source) lines.push(`source: ${item.source}`);
	if (item.deviceName) lines.push(`device: ${item.deviceName}`);
	if (item.timestamp) lines.push(`timestamp: ${item.timestamp}`);
	if (item.reason) lines.push(`reason: ${item.reason}`);
	if (item.originalPathConfidence) lines.push(`original confidence: ${item.originalPathConfidence}`);
	if (item.current) lines.push(`current: ${formatFileDescription(item.current)}`);
	if (item.artifact) lines.push(`artifact: ${formatFileDescription(item.artifact)}`);
	if (item.dataSources?.length) lines.push(`data sources: ${item.dataSources.join(", ")}`);
	return lines.join("\n");
}

function formatFileDescription(info) {
	if (!info?.exists) return "missing";
	return `${info.size} bytes, sha256 ${String(info.sha256 ?? "").slice(0, 12) || "unknown"}`;
}

async function renderConflictDiff(context, item, { full }) {
	if (item.type === "preserved-unresolved") {
		return [
			formatConflictDetail(item),
			"",
			"Preserved unresolved entries have no artifact diff.",
			"Use keep-local to keep the file or accept-delete to move it aside and accept the remote delete.",
		].join("\n");
	}
	const currentAbs = vaultPath(context, item.currentPath);
	const artifactAbs = vaultPath(context, item.artifactPath);
	if (item.kind !== "markdown") {
		return [
			formatConflictDetail(item),
			"",
			"Binary/blob conflict: content diff is not shown.",
			`current:  ${item.currentPath}  ${formatFileDescription(await describeVaultFile(context, item.currentPath))}`,
			`artifact: ${item.artifactPath}  ${formatFileDescription(await describeVaultFile(context, item.artifactPath))}`,
		].join("\n");
	}
	const currentText = await readFile(currentAbs, "utf8").catch(() => "");
	const artifactText = await readFile(artifactAbs, "utf8");
	return renderLineDiff(currentText, artifactText, {
		leftLabel: `current:${item.currentPath}`,
		rightLabel: `artifact:${item.artifactPath}`,
		full,
	});
}

function renderLineDiff(left, right, { leftLabel, rightLabel, full }) {
	if (left === right) return `No textual differences.\n--- ${leftLabel}\n+++ ${rightLabel}`;
	const leftLines = left.split(/\r?\n/);
	const rightLines = right.split(/\r?\n/);
	let prefix = 0;
	while (prefix < leftLines.length && prefix < rightLines.length && leftLines[prefix] === rightLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix + prefix < leftLines.length &&
		suffix + prefix < rightLines.length &&
		leftLines[leftLines.length - 1 - suffix] === rightLines[rightLines.length - 1 - suffix]
	) {
		suffix++;
	}
	const context = 3;
	const leftStart = full ? 0 : Math.max(0, prefix - context);
	const rightStart = full ? 0 : Math.max(0, prefix - context);
	const leftEnd = full ? leftLines.length : Math.min(leftLines.length, leftLines.length - suffix + context);
	const rightEnd = full ? rightLines.length : Math.min(rightLines.length, rightLines.length - suffix + context);
	const out = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
	for (let i = leftStart; i < prefix; i++) out.push(` ${leftLines[i] ?? ""}`);
	let changed = 0;
	for (let i = prefix; i < leftLines.length - suffix; i++) {
		if (!full && changed >= 400) {
			out.push("... diff truncated; rerun with --full for complete output");
			break;
		}
		out.push(`-${leftLines[i] ?? ""}`);
		changed++;
	}
	changed = 0;
	for (let i = prefix; i < rightLines.length - suffix; i++) {
		if (!full && changed >= 400) break;
		out.push(`+${rightLines[i] ?? ""}`);
		changed++;
	}
	for (let i = leftLines.length - suffix; i < leftEnd; i++) out.push(` ${leftLines[i] ?? ""}`);
	if (!full && (leftStart > 0 || rightStart > 0)) out.splice(2, 0, "... unchanged prefix omitted");
	if (!full && (leftEnd < leftLines.length || rightEnd < rightLines.length)) out.push("... unchanged suffix omitted");
	return out.join("\n");
}

async function applyConflictAction(raw, id, action) {
	const { context, item } = await requireConflictItemWithContext(raw, id);
	await assertNoHeadlessLock(context);
	if (item.type === "preserved-unresolved") {
		if (!["keep-local", "accept-delete"].includes(action)) {
			throw new Error(`${action} is only valid for conflict artifacts`);
		}
	} else if (!["keep-current", "keep-artifact"].includes(action)) {
		throw new Error(`${action} is only valid for preserved-unresolved entries`);
	}
	if (item.originalPathConfidence === "possibly-truncated" && action === "keep-artifact" && raw.force !== "true") {
		throw new Error("refusing to replace current path for possibly-truncated artifact; inspect manually or pass --force");
	}
	const workspace = await createResolutionWorkspace(context, item, action);
	if (action === "keep-current") {
		if (!item.currentExists) throw new Error("current file is missing; cannot keep current");
		await moveVaultFileToTrash(context, item.artifactPath, workspace.trashDir);
	} else if (action === "keep-artifact") {
		await copyVaultFile(context, item.artifactPath, item.currentPath);
		await moveVaultFileToTrash(context, item.artifactPath, workspace.trashDir);
	} else if (action === "keep-local") {
		await removePreservedUnresolvedEntries(context, item);
	} else if (action === "accept-delete") {
		if (item.currentExists) await moveVaultFileToTrash(context, item.currentPath, workspace.trashDir);
		await removePreservedUnresolvedEntries(context, item);
	}
	return {
		kind: "kaos-conflict-resolution",
		ok: true,
		action,
		id,
		path: item.path,
		backupDir: workspace.backupDir,
		trashDir: workspace.trashDir,
	};
}

async function assertNoHeadlessLock(context) {
	const lock = await readResolverLock(context);
	if (lock.held) {
		throw new Error(`headless host lock exists at ${lock.path}; stop kaos-headless-host before resolving conflicts`);
	}
}

async function readResolverLock(context) {
	if (!context.lockFile) return { held: false, path: null, data: null };
	const text = await readFile(context.lockFile, "utf8").catch((err) => {
		if (err?.code === "ENOENT") return null;
		throw err;
	});
	if (text === null) return { held: false, path: context.lockFile, data: null };
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	return { held: true, path: context.lockFile, data };
}

async function createResolutionWorkspace(context, item, action) {
	const stamp = formatResolverStamp(new Date());
	const name = `${stamp}-${item.id}-${action}`;
	const backupDir = join(context.resolverDir, "backups", name);
	const trashDir = join(context.resolverDir, "trash", name);
	await mkdir(backupDir, { recursive: true });
	await mkdir(trashDir, { recursive: true });
	const manifest = {
		kind: "kaos-conflict-resolution-backup",
		action,
		createdAt: new Date().toISOString(),
		item,
		files: [],
		dataFiles: [],
	};
	if (item.currentPath) await backupVaultFile(context, item.currentPath, backupDir, "current", manifest);
	if (item.artifactPath) await backupVaultFile(context, item.artifactPath, backupDir, "artifact", manifest);
	for (const dataFile of context.dataFiles) {
		await backupDataFile(dataFile, backupDir, manifest);
	}
	await writeJsonAtomic(join(backupDir, "manifest.json"), manifest, 0o600);
	return { backupDir, trashDir };
}

async function backupVaultFile(context, relPath, backupDir, label, manifest) {
	const source = vaultPath(context, relPath);
	const info = await lstatOrNull(source);
	if (!info || !info.isFile()) {
		manifest.files.push({ label, path: relPath, exists: false });
		return;
	}
	const target = safeJoin(join(backupDir, label), relPath);
	await mkdir(dirname(target), { recursive: true });
	await copyFile(source, target);
	manifest.files.push({ label, path: relPath, backupPath: target, exists: true });
}

async function backupDataFile(dataFile, backupDir, manifest) {
	const info = await lstatOrNull(dataFile);
	if (!info || !info.isFile()) {
		manifest.dataFiles.push({ path: dataFile, exists: false });
		return;
	}
	const target = join(backupDir, "data", `data-${manifest.dataFiles.length + 1}.json`);
	await mkdir(dirname(target), { recursive: true });
	await copyFile(dataFile, target);
	manifest.dataFiles.push({ path: dataFile, backupPath: target, exists: true });
}

async function copyVaultFile(context, fromRel, toRel) {
	const source = vaultPath(context, fromRel);
	const target = vaultPath(context, toRel);
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
	await copyFile(source, temp);
	await rename(temp, target);
}

async function moveVaultFileToTrash(context, relPath, trashDir) {
	const source = vaultPath(context, relPath);
	const target = safeJoin(trashDir, relPath);
	await mkdir(dirname(target), { recursive: true });
	try {
		await rename(source, target);
	} catch (err) {
		if (err?.code !== "EXDEV") throw err;
		await copyFile(source, target);
		await rm(source, { force: true });
	}
}

async function removePreservedUnresolvedEntries(context, item) {
	let changedAny = false;
	for (const dataFile of context.dataFiles) {
		const data = await readJsonIfExists(dataFile);
		if (!isRecord(data) || !Array.isArray(data._preservedUnresolved)) continue;
		const before = data._preservedUnresolved.length;
		data._preservedUnresolved = data._preservedUnresolved.filter((entry) => {
			if (!isRecord(entry)) return true;
			return !(normalizeVaultPath(entry.path) === item.path && entry.kind === item.kind);
		});
		if (data._preservedUnresolved.length === 0) delete data._preservedUnresolved;
		if ((data._preservedUnresolved?.length ?? 0) !== before) {
			await writeJsonAtomic(dataFile, data, 0o600);
			changedAny = true;
		}
	}
	if (!changedAny) throw new Error(`preserved-unresolved entry already resolved: ${item.path}`);
}

function parseConflictArtifactPath(path) {
	return parseMarkdownConflictArtifactPath(path) ?? parseBlobConflictArtifactPath(path);
}

function parseMarkdownConflictArtifactPath(path) {
	const normalized = normalizeVaultPath(path);
	const { dir, name } = splitVaultPath(normalized);
	const match = MARKDOWN_CONFLICT_ARTIFACT_NAME_RE.exec(name);
	if (!match) return null;
	const base = match[1];
	const source = match[2];
	const device = match[3];
	const stamp = match[4];
	const ext = match[6];
	if (!base || !ext || !device || !stamp) return null;
	return {
		kind: "markdown",
		artifactPath: normalized,
		inferredOriginalPath: `${dir}${base}${ext}`,
		originalPathConfidence: base.length >= 100 ? "possibly-truncated" : "candidate",
		source: ["crdt", "disk", "editor"].includes(source) ? source : null,
		deviceName: device,
		timestamp: stampToIso(stamp),
		copyIndex: parseCopyIndex(match[5]),
	};
}

function parseBlobConflictArtifactPath(path) {
	const normalized = normalizeVaultPath(path);
	const { dir, name } = splitVaultPath(normalized);
	const match = BLOB_CONFLICT_ARTIFACT_NAME_RE.exec(name);
	if (!match) return null;
	const base = match[1];
	const stamp = match[2];
	if (!base || !stamp) return null;
	const ext = match[4] ?? "";
	return {
		kind: "blob",
		artifactPath: normalized,
		inferredOriginalPath: `${dir}${base}${ext}`,
		originalPathConfidence: base.length >= 180 ? "possibly-truncated" : "candidate",
		source: "remote",
		deviceName: null,
		timestamp: stampToIso(stamp),
		copyIndex: parseCopyIndex(match[3]),
	};
}

function splitVaultPath(path) {
	const slash = path.lastIndexOf("/");
	return {
		dir: slash >= 0 ? path.slice(0, slash + 1) : "",
		name: slash >= 0 ? path.slice(slash + 1) : path,
	};
}

function stampToIso(stamp) {
	return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
}

function parseCopyIndex(value) {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeVaultPath(path) {
	if (typeof path !== "string") return "";
	return path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}

function vaultPath(context, relPath) {
	const normalized = normalizeVaultPath(relPath);
	if (!normalized || normalized.startsWith("../") || normalized === "..") {
		throw new Error(`invalid vault path: ${relPath}`);
	}
	const target = resolve(context.vaultRoot, ...normalized.split("/"));
	const root = resolve(context.vaultRoot);
	if (target !== root && !target.startsWith(`${root}${sep}`)) {
		throw new Error(`path escapes vault root: ${relPath}`);
	}
	return target;
}

function formatResolverStamp(date) {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function toNumber(value) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function uniquePaths(paths) {
	return Array.from(new Set(paths.filter((path) => typeof path === "string" && path.length > 0)));
}

function resolveUserPath(path) {
	return resolve(String(path).replace(/^~(?=$|\/)/, homedir()));
}

function renderConflictUi({ inventory, selected, message, mode, detailText, readOnly }) {
	process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
	process.stdout.write(`KAOS conflict resolver${readOnly ? " (read-only)" : ""}\n`);
	process.stdout.write(`${message}\n\n`);
	if (inventory.items.length === 0) {
		process.stdout.write("No conflicts found.\n\nq quit\n");
		return;
	}
	for (let i = 0; i < inventory.items.length; i++) {
		const prefix = i === selected ? ">" : " ";
		process.stdout.write(`${prefix} ${inventory.items[i].id} ${formatConflictSummary(inventory.items[i])}\n`);
	}
	process.stdout.write("\nKeys: j/k move  enter detail  d diff  1 keep-current/keep-local  2 keep-artifact  x accept-delete  b backups  q quit\n\n");
	if (mode === "detail") {
		process.stdout.write(detailText);
		process.stdout.write("\n");
	}
}

function createKeyReader(input) {
	const queue = [];
	const waiters = [];
	const onKey = (_str, key) => {
		const waiter = waiters.shift();
		if (waiter) {
			waiter(key);
		} else {
			queue.push(key);
		}
	};
	input.on("keypress", onKey);
	return {
		read() {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise((resolvePromise) => waiters.push(resolvePromise));
		},
		close() {
			input.off("keypress", onKey);
			while (waiters.length > 0) {
				waiters.shift()?.(null);
			}
		},
	};
}

function moveConflictSelection(inventory, selected, delta) {
	if (inventory.items.length === 0) return 0;
	return Math.max(0, Math.min(inventory.items.length - 1, selected + delta));
}

function resolveUiAction(item, key) {
	if (!key) return null;
	if (item.type === "preserved-unresolved") {
		if (key.sequence === "1") return "keep-local";
		if (key.name === "x") return "accept-delete";
		return null;
	}
	if (key.sequence === "1") return "keep-current";
	if (key.sequence === "2") return "keep-artifact";
	return null;
}

async function promptStdYesNo(label, defaultYes) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const suffix = defaultYes ? " [Y/n]" : " [y/N]";
		const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
		if (!answer) return defaultYes;
		return ["y", "yes"].includes(answer);
	} finally {
		rl.close();
	}
}

function defaultUserPaths() {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const stateHome = process.env.XDG_STATE_HOME || join(home, ".local", "state");
	const runtimeBase = process.env.XDG_RUNTIME_DIR || join(stateHome, "kaos-headless", "run");
	const installRoot = join(home, ".local", "lib", "kaos");
	return {
		home,
		installRoot,
		releasesDir: join(installRoot, "releases"),
		currentLink: join(installRoot, "current"),
		binDir: join(home, ".local", "bin"),
		binKaos: join(home, ".local", "bin", "kaos"),
		binKaosctl: join(home, ".local", "bin", "kaosctl"),
		configDir: join(configHome, "kaos"),
		installConfig: join(configHome, "kaos", "install.json"),
		envFile: join(configHome, "kaos", "headless.env"),
		tokenFile: join(configHome, "kaos", "sync-token"),
		serviceDir: join(configHome, "systemd", "user"),
		serviceFile: join(configHome, "systemd", "user", DEFAULT_SERVICE_NAME),
		stateDir: join(stateHome, "kaos-headless"),
		dataFile: join(stateHome, "kaos-headless", "data.json"),
		runtimeDir: join(runtimeBase, "kaos-headless"),
		lockFile: join(runtimeBase, "kaos-headless", "kaos.lock"),
	};
}

function pathsFromConfig(config) {
	const defaults = defaultUserPaths();
	return {
		...defaults,
		...(isRecord(config.paths) ? config.paths : {}),
	};
}

async function promptVaultRoot(tty) {
	while (true) {
		const value = await promptText(tty, "Vault path", "");
		const vault = resolve(value.replace(/^~(?=$|\/)/, homedir()));
		if (!await pathExists(vault)) {
			writeTty(tty, `Vault does not exist: ${vault}\n`);
			continue;
		}
		if (!await pathExists(join(vault, ".obsidian"))) {
			const ok = await promptYesNo(tty, "This path has no .obsidian directory. Use it anyway?", false);
			if (!ok) continue;
		}
		return vault;
	}
}

async function inspectVaultPlugin(pluginDir) {
	const manifestPath = join(pluginDir, "manifest.json");
	const mainPath = join(pluginDir, "main.js");
	const dataPath = join(pluginDir, "data.json");
	const manifest = await readJsonIfExists(manifestPath);
	const data = await readJsonIfExists(dataPath);
	const manifestOk = isRecord(manifest) && asNonEmptyString(manifest.id) === "kaos";
	const mainOk = await pathExists(mainPath);
	return {
		found: await pathExists(pluginDir),
		usable: manifestOk && mainOk,
		manifest: isRecord(manifest) ? manifest : null,
		data: isRecord(data) ? data : null,
		dataPath: isRecord(data) ? dataPath : null,
	};
}

async function installUserRelease({ userZip, version, paths }) {
	const releaseDir = join(paths.releasesDir, version);
	await rm(releaseDir, { recursive: true, force: true });
	await mkdir(releaseDir, { recursive: true });
	await extractZipFile(userZip, releaseDir);
	await writeFile(join(releaseDir, VERSION_FILE), `${version}\n`, "utf8");
	await chmod(join(releaseDir, RUNNER), 0o755).catch(() => undefined);
	await chmod(join(releaseDir, KAOSCTL), 0o755).catch(() => undefined);
	await switchCurrent(paths.currentLink, releaseDir);
	return releaseDir;
}

async function installPluginZip(pluginZip, pluginDir) {
	const entries = unzipSync(await readFile(pluginZip));
	for (const file of PLUGIN_FILES) {
		if (!entries[file]) throw new Error(`plugin zip is missing ${file}`);
	}
	await mkdir(pluginDir, { recursive: true });
	const transactionId = `${process.pid}-${Date.now()}`;
	const installed = [];
	const staged = [];
	try {
		for (const file of PLUGIN_FILES) {
			const target = join(pluginDir, file);
			const tempPath = join(pluginDir, `.${file}.kaos-update-${transactionId}.tmp`);
			const backupPath = join(pluginDir, `.${file}.kaos-update-${transactionId}.previous`);
			await rm(tempPath, { force: true });
			await rm(backupPath, { force: true });
			await writeFile(tempPath, entries[file]);
			staged.push(tempPath);
			installed.push({ file, target, tempPath, backupPath, existed: await pathExists(target) });
		}
		for (const entry of installed) {
			if (entry.existed) await rename(entry.target, entry.backupPath);
			await rename(entry.tempPath, entry.target);
		}
		return { pluginDir, entries: installed };
	} catch (err) {
		await rollbackPluginInstall({ pluginDir, entries: installed }).catch(() => undefined);
		await Promise.all(staged.map((path) => rm(path, { force: true }).catch(() => undefined)));
		throw err;
	}
}

async function rollbackPluginInstall(pluginInstall) {
	for (const entry of [...pluginInstall.entries].reverse()) {
		await rm(entry.tempPath, { force: true }).catch(() => undefined);
		if (entry.existed) {
			if (await pathExists(entry.backupPath)) {
				await rm(entry.target, { force: true });
				await rename(entry.backupPath, entry.target);
			}
		} else {
			await rm(entry.target, { force: true });
		}
	}
}

async function finalizePluginInstall(pluginInstall) {
	await Promise.all(pluginInstall.entries.map((entry) => rm(entry.backupPath, { force: true }).catch(() => undefined)));
	for (const entry of pluginInstall.entries) {
		await rm(entry.tempPath, { force: true }).catch(() => undefined);
	}
}

async function enableVaultPlugin(vaultRoot, pluginId) {
	const configDir = join(vaultRoot, ".obsidian");
	const communityPlugins = join(configDir, "community-plugins.json");
	const existing = await readJsonIfExists(communityPlugins);
	const enabled = Array.isArray(existing) && existing.every((item) => typeof item === "string") ? existing : [];
	if (enabled.includes(pluginId)) return;
	await mkdir(configDir, { recursive: true });
	await writeFile(communityPlugins, `${JSON.stringify([...enabled, pluginId], null, 2)}\n`, "utf8");
}

async function writeHeadlessConfig({ paths, vaultRoot, pluginDir, host, vaultId, token, deviceName, enableAttachmentSync, releaseBaseUrl, version }) {
	await mkdir(paths.configDir, { recursive: true });
	await mkdir(paths.stateDir, { recursive: true });
	await mkdir(paths.runtimeDir, { recursive: true });
	await writeFile(paths.envFile, [
		`KAOS_HOST=${shellEnvValue(host)}`,
		`KAOS_VAULT_ID=${shellEnvValue(vaultId)}`,
		`KAOS_DEVICE_NAME=${shellEnvValue(deviceName)}`,
		`KAOS_ENABLE_ATTACHMENT_SYNC=${enableAttachmentSync ? "true" : "false"}`,
		"",
	].join("\n"), { encoding: "utf8", mode: 0o600 });
	await writeFile(paths.tokenFile, token, { encoding: "utf8", mode: 0o600 });
	await chmod(paths.tokenFile, 0o600).catch(() => undefined);
	await writeJsonAtomic(paths.dataFile, {
		host,
		token,
		vaultId,
		deviceName,
		enableAttachmentSync,
		attachmentSyncExplicitlyConfigured: true,
	}, 0o600);
	await writeJsonAtomic(paths.installConfig, {
		kind: "kaos-headless-user-install",
		version,
		installedAt: new Date().toISOString(),
		releaseBaseUrl,
		vaultRoot,
		pluginDir,
		paths,
	}, 0o600);
}

async function writeUserService({ paths, vaultRoot, pluginDir }) {
	await mkdir(paths.serviceDir, { recursive: true });
	const nodeBin = process.execPath;
	const content = `[Unit]
Description=KAOS headless host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${systemdQuote(paths.envFile)}
ExecStartPre=${systemdQuote(nodeBin)} -- ${systemdQuote(paths.binKaos)} update --startup --config ${systemdQuote(paths.installConfig)}
ExecStart=${systemdQuote(nodeBin)} -- ${systemdQuote(join(paths.currentLink, RUNNER))} --vault ${systemdQuote(vaultRoot)} --data-file ${systemdQuote(paths.dataFile)} --lock-file ${systemdQuote(paths.lockFile)} --token-file ${systemdQuote(paths.tokenFile)} --plugin-dir ${systemdQuote(pluginDir)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
	await writeFile(paths.serviceFile, content, "utf8");
}

async function linkKaosCommands(paths) {
	await mkdir(paths.binDir, { recursive: true });
	const target = join(paths.currentLink, KAOSCTL);
	await linkCommand(paths.binKaos, target, { commandName: "kaos", protectExistingFile: true });
	await linkCommand(paths.binKaosctl, target, { commandName: "kaosctl", protectExistingFile: false });
}

async function linkCommand(commandPath, target, { commandName, protectExistingFile }) {
	if (protectExistingFile) {
		await assertCommandPathReusable(commandPath, {
			commandName,
			installRoot: dirname(dirname(target)),
		});
	}
	const info = await lstatOrNull(commandPath);
	if (info) {
		await rm(commandPath, { force: true });
	}
	try {
		await symlink(target, commandPath);
	} catch {
		await copyFile(target, commandPath);
		await chmod(commandPath, 0o755).catch(() => undefined);
	}
}

async function assertCommandPathReusable(commandPath, { commandName, installRoot }) {
	const info = await lstatOrNull(commandPath);
	if (!info) return;
	if (!info.isSymbolicLink()) {
		throw new Error(`refusing to replace existing ${commandName} command: ${commandPath}`);
	}
	const link = await readlink(commandPath);
	const resolvedLink = resolve(dirname(commandPath), link);
	const root = resolve(installRoot);
	if (resolvedLink !== root && !resolvedLink.startsWith(`${root}${sep}`)) {
		throw new Error(`refusing to replace existing ${commandName} symlink outside KAOS install: ${commandPath} -> ${link}`);
	}
}

async function lstatOrNull(path) {
	return await lstat(path).catch((err) => {
		if (err?.code === "ENOENT") return null;
		throw err;
	});
}

async function verifyInstalledHeadless({ paths, config, releaseDir }) {
	const binary = join(releaseDir, RUNNER);
	const result = runNodeJson(binary, doctorArgs({ config, paths }));
	if (!result.ok) {
		throw new Error(`updated headless doctor failed: ${JSON.stringify(result)}`);
	}
}

function doctorArgs({ config, paths }) {
	return [
		"--doctor",
		"--require-sync-config",
		"--skip-worker-capabilities",
		"--vault",
		config.vaultRoot,
		"--data-file",
		paths.dataFile,
		"--lock-file",
		paths.lockFile,
		"--token-file",
		paths.tokenFile,
		"--plugin-dir",
		config.pluginDir,
	];
}

async function readCurrentVersion(paths) {
	const version = (await readFile(join(paths.currentLink, VERSION_FILE), "utf8")).trim();
	if (!version) throw new Error("current VERSION is empty");
	return version;
}

async function resolveCurrentSymlink(paths) {
	const info = await lstat(paths.currentLink);
	if (info.isSymbolicLink()) {
		const link = await readlink(paths.currentLink);
		return resolve(dirname(paths.currentLink), link);
	}
	return paths.currentLink;
}

async function restoreCurrentSymlink(paths, previousCurrent) {
	if (!previousCurrent) return;
	await switchCurrent(paths.currentLink, previousCurrent);
}

async function switchCurrent(currentLink, releaseDir) {
	await mkdir(dirname(currentLink), { recursive: true });
	const tempLink = `${currentLink}.next-${process.pid}-${Date.now()}`;
	await rm(tempLink, { force: true }).catch(() => undefined);
	await symlink(releaseDir, tempLink);
	try {
		await rename(tempLink, currentLink);
	} catch (err) {
		if (err?.code !== "EEXIST" && err?.code !== "ENOTEMPTY") throw err;
		await rm(currentLink, { recursive: true, force: true });
		await rename(tempLink, currentLink);
	}
}

async function obtainReleaseAsset({ manifest, baseUrl, asset, workDir }) {
	const expected = readManifestAsset(manifest, asset);
	const target = join(workDir, asset);
	await download(assetUrl(baseUrl, asset), target);
	const actual = await sha256File(target);
	if (actual !== expected.sha256) {
		throw new Error(`checksum mismatch for ${asset}: expected ${expected.sha256}, got ${actual}`);
	}
	return target;
}

function readManifestAsset(manifest, asset) {
	const entry = manifest?.assets?.[asset];
	if (!entry || typeof entry.sha256 !== "string") {
		throw new Error(`release manifest is missing asset ${asset}`);
	}
	return entry;
}

function assertUserReleaseManifest(manifest) {
	if (manifest?.kind !== "kaos-headless-user-release-manifest" || manifest?.schemaVersion !== 1) {
		throw new Error("release manifest is not a KAOS headless user manifest");
	}
}

function readManifestVersion(manifest) {
	const version = asNonEmptyString(manifest?.version);
	if (!version) throw new Error("release manifest is missing version");
	return version;
}

function readManifestPluginVersion(manifest) {
	const version = asNonEmptyString(manifest?.pluginVersion);
	if (!version) throw new Error("release manifest is missing pluginVersion");
	return version;
}

async function fetchJson(url) {
	if (url.protocol === "file:") {
		return JSON.parse(await readFile(fileURLToPath(url), "utf8"));
	}
	const res = await fetch(url);
	if (!res.ok) throw new Error(`failed to fetch ${url.href}: HTTP ${res.status}`);
	return await res.json();
}

async function download(url, target) {
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
	try {
		if (url.protocol === "file:") {
			await copyFile(fileURLToPath(url), temp);
		} else {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await writeFile(temp, new Uint8Array(await res.arrayBuffer()));
		}
		await rename(temp, target);
	} catch (err) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw new Error(`failed to download ${url.href}: ${errorMessage(err)}`);
	}
}

async function extractZipFile(zipPath, targetDir) {
	const entries = unzipSync(await readFile(zipPath));
	for (const [name, bytes] of Object.entries(entries)) {
		const target = safeJoin(targetDir, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
}

function safeJoin(root, entry) {
	const normalized = entry.split("/").filter(Boolean);
	const target = resolve(root, ...normalized);
	const base = resolve(root);
	if (target !== base && !target.startsWith(`${base}${sep}`)) {
		throw new Error(`zip entry escapes target directory: ${entry}`);
	}
	return target;
}

async function readJsonFile(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function writeJsonAtomic(path, value, mode = 0o600) {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
	await chmod(temp, mode).catch(() => undefined);
	await rename(temp, path);
}

async function pathExists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function sha256File(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runNodeJson(script, args) {
	const result = spawnSync(process.execPath, ["--", script, ...args], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `command failed: ${script}`);
	}
	return JSON.parse(result.stdout.trim());
}

function runChecked(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
	}
}

async function commandExists(command) {
	const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
	return result.status === 0;
}

function pathListIncludes(dir) {
	const wanted = resolve(dir);
	return (process.env.PATH ?? "")
		.split(":")
		.some((entry) => entry && resolve(entry) === wanted);
}

function githubReleaseBaseUrl() {
	const repo = process.env.KAOS_RELEASE_REPO ?? DEFAULT_REPO;
	const tag = process.env.KAOS_RELEASE_TAG ?? "latest";
	if (tag === "latest") return `https://github.com/${repo}/releases/latest/download`;
	return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
}

function assetUrl(baseUrl, asset) {
	return new URL(asset, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function compareVersions(a, b) {
	const aa = String(a).replace(/^v/, "").split(/[.-]/);
	const bb = String(b).replace(/^v/, "").split(/[.-]/);
	const len = Math.max(aa.length, bb.length);
	for (let i = 0; i < len; i++) {
		const av = Number.parseInt(aa[i] ?? "0", 10);
		const bv = Number.parseInt(bb[i] ?? "0", 10);
		if (Number.isFinite(av) && Number.isFinite(bv) && av !== bv) return av > bv ? 1 : -1;
		const as = aa[i] ?? "";
		const bs = bb[i] ?? "";
		if (as !== bs) return as > bs ? 1 : -1;
	}
	return 0;
}

function assertNodeVersion() {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (!Number.isFinite(major) || major < 20) {
		throw new Error(`Node.js 20 or newer is required. Current: ${process.version}`);
	}
}

function sanitizeDeviceName(value) {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "kaos";
}

function asNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value) {
	return typeof value === "boolean" ? value : null;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellEnvValue(value) {
	const clean = String(value).replace(/\r?\n/g, "");
	if (/[\s"'\\$`]/.test(clean)) {
		return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
	}
	return clean;
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function systemdQuote(value) {
	return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}

async function openTty() {
	const input = createReadStream("/dev/tty");
	const output = createWriteStream("/dev/tty");
	const rl = readline.createInterface({ input, output });
	return {
		rl,
		input,
		output,
		write: (text) => output.write(text),
		close: async () => {
			rl.close();
			input.close();
			output.end();
		},
	};
}

function writeTty(tty, text) {
	tty.write(text);
}

async function promptText(tty, label, defaultValue) {
	const suffix = defaultValue ? ` [${defaultValue}]` : "";
	while (true) {
		const value = (await tty.rl.question(`${label}${suffix}: `)).trim();
		const next = value || defaultValue;
		if (next) return next;
		writeTty(tty, `${label} is required.\n`);
	}
}

async function promptYesNo(tty, label, defaultYes) {
	const suffix = defaultYes ? " [Y/n]" : " [y/N]";
	while (true) {
		const value = (await tty.rl.question(`${label}${suffix}: `)).trim().toLowerCase();
		if (!value) return defaultYes;
		if (["y", "yes"].includes(value)) return true;
		if (["n", "no"].includes(value)) return false;
		writeTty(tty, "Please answer y or n.\n");
	}
}

async function promptSecret(tty, label) {
	while (true) {
		const fd = openSync("/dev/tty", "r+");
		try {
			spawnSync("stty", ["-echo"], { stdio: [fd, fd, fd] });
			const value = await tty.rl.question(`${label}: `);
			writeTty(tty, "\n");
			if (value.trim()) return value.trim();
			writeTty(tty, `${label} is required.\n`);
		} finally {
			spawnSync("stty", ["echo"], { stdio: [fd, fd, fd] });
			closeSync(fd);
		}
	}
}

function printUsage() {
	console.log(`Usage:
  kaos install
  kaos update [--startup]
  kaos uninstall [--dry-run] [--yes] [--purge-vault --vault <path>]
  kaos status
  kaos doctor
  kaos ui [--vault <path>]
  kaos conflicts <command> [options]

Install is always interactive. Update is non-interactive and is used by the
user systemd service during startup.
`);
}

function printConflictsUsage() {
	console.log(`Usage:
  kaos conflicts list [--json] [--vault <path>]
  kaos conflicts show <id> [--json] [--vault <path>]
  kaos conflicts diff <id> [--full] [--vault <path>]
  kaos conflicts keep-current <id> [--vault <path>]
  kaos conflicts keep-artifact <id> [--force] [--vault <path>]
  kaos conflicts keep-local <id> [--vault <path>]
  kaos conflicts accept-delete <id> [--vault <path>]

Options:
  --vault <path>       Override the installed vault path.
  --data-file <path>   Add/override the headless data file for preserved entries.
  --plugin-dir <path>  Override the vault plugin directory.
  --lock-file <path>   Override the headless-host lock path.
`);
}

main().catch((err) => {
	console.error(errorMessage(err));
	process.exitCode = 1;
});
