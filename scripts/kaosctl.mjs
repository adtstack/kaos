#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants, openSync, closeSync } from "node:fs";
import { hostname, homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import readline from "node:readline/promises";
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
	if (command === "status") {
		await printStatus(parseArgs(args));
		return;
	}
	if (command === "doctor") {
		await runDoctorCommand(parseArgs(args));
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--startup") {
			out.startup = "true";
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
			await installPluginZip(pluginZip, pluginDir);
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
		const currentVersion = await readCurrentVersion(paths).catch(() => asNonEmptyString(config.version) ?? "0.0.0");
		if (compareVersions(latestVersion, currentVersion) <= 0) {
			console.log(JSON.stringify({
				kind: "kaos-user-update",
				ok: true,
				updated: false,
				currentVersion,
				latestVersion,
			}, null, 2));
			return;
		}

		const workDir = resolve(raw["work-dir"] ?? await mkdtemp(join(tmpdir(), "kaos-user-update-")));
		const userZip = await obtainReleaseAsset({ manifest, baseUrl: releaseBaseUrl, asset: USER_ZIP, workDir });
		const previousCurrent = await resolveCurrentSymlink(paths).catch(() => null);
		let installedReleaseDir = null;
		try {
			installedReleaseDir = await installUserRelease({ userZip, version: latestVersion, paths });
			await verifyInstalledHeadless({ paths, config, releaseDir: installedReleaseDir });
			await linkKaosCommands(paths);
			await writeJsonAtomic(configPath, {
				...config,
				version: latestVersion,
				updatedAt: new Date().toISOString(),
			}, 0o600);
		} catch (err) {
			await restoreCurrentSymlink(paths, previousCurrent).catch(() => undefined);
			throw err;
		}

		console.log(JSON.stringify({
			kind: "kaos-user-update",
			ok: true,
			updated: true,
			previousVersion: currentVersion,
			version: latestVersion,
			releaseDir: installedReleaseDir,
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
	await mkdir(pluginDir, { recursive: true });
	const entries = unzipSync(await readFile(pluginZip));
	for (const file of PLUGIN_FILES) {
		const bytes = entries[file];
		if (!bytes) throw new Error(`plugin zip is missing ${file}`);
		await writeFile(join(pluginDir, file), bytes);
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
  kaos status
  kaos doctor

Install is always interactive. Update is non-interactive and is used by the
user systemd service during startup.
`);
}

main().catch((err) => {
	console.error(errorMessage(err));
	process.exitCode = 1;
});
