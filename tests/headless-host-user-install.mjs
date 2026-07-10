#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { buildHeadlessHost, buildProductPluginBundle, installVaultPlugin } from "./helpers/headless-host-vault-plugin.mjs";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-user-install-"));

try {
	console.log("\n--- headless host user install: build user release assets ---");
	buildProductPluginBundle();
	buildHeadlessHost();

	const headlessVersion = JSON.parse(await readFile("headless-host.version.json", "utf8")).version;
	const pluginVersion = JSON.parse(await readFile("manifest.json", "utf8")).version;
	const releaseManifest = JSON.parse(await readFile("dist/kaos-headless-user-manifest.json", "utf8"));
	assert.equal(releaseManifest.kind, "kaos-headless-user-release-manifest");
	assert.equal(releaseManifest.schemaVersion, 1);
	assert.equal(releaseManifest.version, headlessVersion);
	assert.equal(releaseManifest.pluginVersion, pluginVersion);
	const hostManifest = JSON.parse(await readFile("dist/kaos-headless-host-manifest.json", "utf8"));
	assert.equal(hostManifest.version, headlessVersion);
	assert.equal(hostManifest.pluginVersion, pluginVersion);
	for (const asset of ["kaosctl.mjs", "kaos-headless-user.zip", "kaos-plugin.zip"]) {
		assert.equal(releaseManifest.assets[asset].sha256, sha256Bytes(await readFile(`dist/${asset}`)));
		assert.equal(releaseManifest.assets[asset].bytes, (await readFile(`dist/${asset}`)).length);
	}
	const userBundle = unzipSync(await readFile("dist/kaos-headless-user.zip"));
	for (const entry of [
		"kaos-headless-host.mjs",
		"kaosctl.mjs",
		"uninstall-headless-host.mjs",
		"kaos-plugin.zip",
		"kaos-headless-host.user.service",
		"VERSION",
		"README-headless-user.txt",
		"kaos-headless-user-bundle-manifest.json",
	]) {
		assert.ok(userBundle[entry], `user bundle must contain ${entry}`);
	}
	const userBundleManifest = JSON.parse(strFromU8(userBundle["kaos-headless-user-bundle-manifest.json"]));
	assert.equal(userBundleManifest.kind, "kaos-headless-user-bundle");
	assert.equal(userBundleManifest.version, releaseManifest.version);
	assert.equal(userBundleManifest.pluginVersion, pluginVersion);
	assert.equal(userBundleManifest.assets["kaosctl.mjs"].sha256, releaseManifest.assets["kaosctl.mjs"].sha256);
	assert.equal(strFromU8(userBundle.VERSION).trim(), headlessVersion);
	const pluginBundle = unzipSync(userBundle["kaos-plugin.zip"]);
	for (const entry of ["manifest.json", "main.js", "telemetry.js", "styles.css"]) {
		assert.ok(pluginBundle[entry], `plugin bundle must contain ${entry}`);
	}
	console.log("  PASS  user release assets are complete and checksummed");

	console.log("\n--- headless host user install: non-interactive update applies release and preserves vault plugin ---");
	const home = join(root, "home");
	const vaultRoot = join(home, "Vault");
	const installRoot = join(home, ".local", "lib", "kaos");
	const releasesDir = join(installRoot, "releases");
	const currentLink = join(installRoot, "current");
	const oldRelease = join(releasesDir, "0.0.0");
	const configDir = join(home, ".config", "kaos");
	const stateDir = join(home, ".local", "state", "kaos-headless");
	const runtimeDir = join(stateDir, "run", "kaos-headless");
	const serviceDir = join(home, ".config", "systemd", "user");
	const binDir = join(home, ".local", "bin");
	await mkdir(oldRelease, { recursive: true });
	await mkdir(runtimeDir, { recursive: true });
	await mkdir(configDir, { recursive: true });
	await mkdir(serviceDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(join(vaultRoot, ".obsidian"), { recursive: true });
	await writeFile(join(oldRelease, "VERSION"), "0.0.0\n", "utf8");
	await writeFile(join(oldRelease, "kaos-headless-host.mjs"), "console.log('{}')\n", "utf8");
	await writeFile(join(oldRelease, "kaosctl.mjs"), "console.log('{}')\n", "utf8");
	await chmod(join(oldRelease, "kaosctl.mjs"), 0o755);
	symlinkSync(oldRelease, currentLink);

	const pluginDir = await installVaultPlugin(vaultRoot);
	const localPluginManifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
	localPluginManifest.version = "0.0.0-local";
	await writeFile(join(pluginDir, "manifest.json"), `${JSON.stringify(localPluginManifest, null, 2)}\n`, "utf8");
	await writeFile(join(pluginDir, "data.json"), `${JSON.stringify({
		host: "https://worker.example.invalid",
		token: "secret-token",
		vaultId: "vault-user",
		deviceName: "desktop",
		enableAttachmentSync: true,
	}, null, 2)}\n`, "utf8");
	const paths = {
		home,
		installRoot,
		releasesDir,
		currentLink,
		binDir,
		binKaos: join(binDir, "kaos"),
		binKaosctl: join(binDir, "kaosctl"),
		configDir,
		installConfig: join(configDir, "install.json"),
		envFile: join(configDir, "headless.env"),
		tokenFile: join(configDir, "sync-token"),
		serviceDir,
		serviceFile: join(serviceDir, "kaos-headless-host.service"),
		stateDir,
		dataFile: join(stateDir, "data.json"),
		runtimeDir,
		lockFile: join(runtimeDir, "kaos.lock"),
	};
	await writeFile(paths.tokenFile, "secret-token", "utf8");
	await writeFile(paths.dataFile, `${JSON.stringify({
		host: "https://worker.example.invalid",
		token: "secret-token",
		vaultId: "vault-user",
		deviceName: "desktop-headless",
		enableAttachmentSync: true,
	}, null, 2)}\n`, "utf8");
	await writeFile(paths.installConfig, `${JSON.stringify({
		kind: "kaos-headless-user-install",
		version: "0.0.0",
		releaseBaseUrl: pathToFileURL(`${resolve("dist")}/`).href,
		vaultRoot,
		pluginDir,
		paths,
	}, null, 2)}\n`, "utf8");

	const update = spawnSync(process.execPath, ["dist/kaosctl.mjs", "update", "--config", paths.installConfig], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});
	assert.equal(update.status, 0, update.stderr || update.stdout);
	const updatePayload = JSON.parse(update.stdout);
	assert.equal(updatePayload.ok, true);
	assert.equal(updatePayload.updated, true);
	assert.equal(updatePayload.previousVersion, "0.0.0");
	assert.equal(updatePayload.version, releaseManifest.version);
	assert.equal((await readFile(join(currentLink, "VERSION"), "utf8")).trim(), releaseManifest.version);
	assert.equal(JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8")).version, "0.0.0-local");
	const updatedConfig = JSON.parse(await readFile(paths.installConfig, "utf8"));
	assert.equal(updatedConfig.version, releaseManifest.version);
	const status = spawnSync(paths.binKaos, ["status", "--config", paths.installConfig], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});
	assert.equal(status.status, 0, status.stderr || status.stdout);
	assert.equal(JSON.parse(status.stdout).currentVersion, releaseManifest.version);
	console.log("  PASS  kaos update installs the user release without overwriting the vault plugin");

	console.log("\n--- headless host user install: startup update is failure-tolerant ---");
	const badConfig = join(configDir, "bad-install.json");
	await writeFile(badConfig, `${JSON.stringify({
		kind: "kaos-headless-user-install",
		version: releaseManifest.version,
		releaseBaseUrl: pathToFileURL(join(root, "missing-release") + "/").href,
		vaultRoot,
		pluginDir,
		paths,
	}, null, 2)}\n`, "utf8");
	const startup = spawnSync(process.execPath, ["dist/kaosctl.mjs", "update", "--startup", "--config", badConfig], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
	});
	assert.equal(startup.status, 0, startup.stderr || startup.stdout);
	assert.match(startup.stderr, /continuing with installed version/);
	console.log("  PASS  startup update logs and continues on release fetch failure");

	console.log("\n--- headless host user install: bootstrap remains interactive by policy ---");
	const installScript = await readFile("scripts/install.sh", "utf8");
	assert.match(installScript, /requires a TTY/);
	assert.match(installScript, /kaosctl\.mjs/);
	assert.match(installScript, / install --release-base-url /);
	assert.match(await readFile("deploy/kaos-headless-host.user.service", "utf8"), /\.local\/bin\/kaos update --startup/);
	console.log("  PASS  install.sh delegates to the interactive installer and exposes kaos");

	console.log("\n--- headless host user install: kaos command collision fails before partial install ---");
	const collisionHome = join(root, "collision-home");
	const collisionBin = join(collisionHome, ".local", "bin");
	const collisionInstallRoot = join(collisionHome, ".local", "lib", "kaos");
	await mkdir(collisionBin, { recursive: true });
	await writeFile(join(collisionBin, "kaos"), "#!/bin/sh\nexit 0\n", "utf8");
	const collisionInstall = spawnSync(process.execPath, ["dist/kaosctl.mjs", "install", "--release-base-url", pathToFileURL(`${resolve("dist")}/`).href], {
		encoding: "utf8",
		env: { ...process.env, HOME: collisionHome },
		input: "",
	});
	assert.notEqual(collisionInstall.status, 0);
	assert.match(collisionInstall.stderr, /refusing to replace existing kaos command/);
	await rm(join(collisionBin, "kaos"), { force: true });
	await symlink(join(collisionInstallRoot, "current", "kaosctl.mjs"), join(collisionBin, "kaos"));
	const reusableInstall = spawnSync(process.execPath, ["dist/kaosctl.mjs", "install", "--release-base-url", pathToFileURL(`${resolve("dist")}/`).href], {
		encoding: "utf8",
		env: { ...process.env, HOME: collisionHome },
		input: "",
	});
	assert.notEqual(reusableInstall.status, 0);
	assert.doesNotMatch(reusableInstall.stderr, /refusing to replace existing kaos command/);
	console.log("  PASS  installer protects unrelated kaos commands while allowing KAOS symlinks");
} finally {
	await rm(root, { recursive: true, force: true });
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
