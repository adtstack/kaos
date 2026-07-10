#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-uninstall-"));
const systemctl = join(root, "fake-systemctl.mjs");
const systemctlLog = join(root, "systemctl.log");

try {
	await writeFile(systemctl, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.KAOS_TEST_SYSTEMCTL_LOG, \`${"${process.argv.slice(2).join(\" \")}\\n"}\`);
`, "utf8");
	await chmod(systemctl, 0o755);

	console.log("\n--- headless host uninstall: system scope preserves vault by default ---");
	const system = await createSystemFixture(join(root, "system"));
	const baseArgs = systemArgs(system);
	const dryRun = run("scripts/uninstall-headless-host.mjs", [...baseArgs, "--dry-run"]);
	assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
	const dryRunPayload = JSON.parse(dryRun.stdout);
	assert.equal(dryRunPayload.kind, "headless-host-uninstall");
	assert.equal(dryRunPayload.dryRun, true);
	assert.equal(existsSync(system.installDir), true);
	assert.equal(existsSync(system.vault), true);

	const missingConfirmation = run("scripts/uninstall-headless-host.mjs", baseArgs);
	assert.notEqual(missingConfirmation.status, 0, "uninstall must require explicit confirmation");
	assert.match(JSON.parse(missingConfirmation.stderr).error, /rerun with --yes/);
	assert.equal(existsSync(system.installDir), true);

	const uninstall = run("scripts/uninstall-headless-host.mjs", [...baseArgs, "--yes"]);
	assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
	const uninstallPayload = JSON.parse(uninstall.stdout);
	assert.equal(uninstallPayload.purgedVault, false);
	assert.equal(existsSync(system.installDir), false);
	assert.equal(existsSync(system.servicePath), false);
	assert.equal(existsSync(system.dataDir), false);
	assert.equal(existsSync(system.runDir), false);
	assert.equal(existsSync(system.envFile), false);
	assert.equal(existsSync(system.tokenFile), false);
	assert.equal(existsSync(system.vault), true, "vault must remain unless --purge-vault is explicit");
	let systemctlCalls = await readFile(systemctlLog, "utf8");
	assert.match(systemctlCalls, /disable --now kaos-headless-host\.service/);
	assert.match(systemctlCalls, /daemon-reload/);
	assert.match(systemctlCalls, /reset-failed kaos-headless-host\.service/);
	console.log("  PASS  system uninstall removes managed state and keeps the vault");

	console.log("\n--- headless host uninstall: vault purge is opt-in ---");
	const purge = run("scripts/uninstall-headless-host.mjs", [...baseArgs, "--yes", "--purge-vault"]);
	assert.equal(purge.status, 0, purge.stderr || purge.stdout);
	assert.equal(JSON.parse(purge.stdout).purgedVault, true);
	assert.equal(existsSync(system.vault), false);
	console.log("  PASS  explicit vault purge removes the vault");

	console.log("\n--- headless host uninstall: unsafe paths fail before service commands ---");
	const unsafe = run("scripts/uninstall-headless-host.mjs", [
		"--dry-run",
		"--install-dir",
		"/",
		"--systemctl-command",
		systemctl,
	]);
	assert.notEqual(unsafe.status, 0, "unsafe install root must be rejected");
	assert.match(JSON.parse(unsafe.stderr).error, /unsafe install-dir path/);
	systemctlCalls = await readFile(systemctlLog, "utf8");
	assert.equal(systemctlCalls.includes("--user"), false);
	console.log("  PASS  protected paths are rejected before removal begins");

	console.log("\n--- headless host uninstall: kaos command removes user install only ---");
	const user = await createUserFixture(join(root, "user"));
	const userUninstall = run("scripts/kaosctl.mjs", [
		"uninstall",
		"--yes",
		"--home",
		user.home,
		"--systemctl-command",
		systemctl,
		"--vault",
		user.vault,
	]);
	assert.equal(userUninstall.status, 0, userUninstall.stderr || userUninstall.stdout);
	const userPayload = JSON.parse(userUninstall.stdout);
	assert.equal(userPayload.scope, "user");
	assert.equal(userPayload.purgedVault, false);
	assert.equal(existsSync(user.installDir), false);
	assert.equal(existsSync(user.servicePath), false);
	assert.equal(existsSync(user.stateDir), false);
	assert.equal(existsSync(user.configDir), false);
	assert.equal(existsSync(user.binKaos), false, "managed kaos command should be removed");
	assert.equal(existsSync(user.binKaosctl), true, "unmanaged kaosctl command must be preserved");
	assert.equal(existsSync(user.vault), true, "user vault must remain without --purge-vault");
	systemctlCalls = await readFile(systemctlLog, "utf8");
	assert.match(systemctlCalls, /--user disable --now kaos-headless-host\.service/);
	console.log("  PASS  kaos uninstall removes the user service without touching its vault");
} finally {
	await rm(root, { recursive: true, force: true });
}

function run(script, args) {
	return spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, KAOS_TEST_SYSTEMCTL_LOG: systemctlLog },
	});
}

async function createSystemFixture(base) {
	const installDir = join(base, "opt", "kaos");
	const servicePath = join(base, "etc", "systemd", "system", "kaos-headless-host.service");
	const dataDir = join(base, "var", "lib", "kaos-headless");
	const runDir = join(base, "run", "kaos-headless");
	const etcDir = join(base, "etc", "kaos");
	const envFile = join(etcDir, "headless.env");
	const tokenFile = join(etcDir, "sync-token");
	const vault = join(base, "srv", "kaos", "vault");
	await Promise.all([mkdir(installDir, { recursive: true }), mkdir(dirname(servicePath), { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(runDir, { recursive: true }), mkdir(etcDir, { recursive: true }), mkdir(vault, { recursive: true })]);
	await Promise.all([
		writeFile(join(installDir, "kaos-headless-host.mjs"), "runner\n", "utf8"),
		writeFile(servicePath, "[Service]\n", "utf8"),
		writeFile(join(dataDir, "data.json"), "{}\n", "utf8"),
		writeFile(join(runDir, "kaos.lock"), "{}\n", "utf8"),
		writeFile(envFile, "KAOS_HOST=https://example.invalid\n", "utf8"),
		writeFile(tokenFile, "secret", "utf8"),
		writeFile(join(vault, "keep.md"), "keep\n", "utf8"),
	]);
	return { installDir, servicePath, dataDir, runDir, etcDir, envFile, tokenFile, vault };
}

function systemArgs(paths) {
	return [
		"--allow-non-root",
		"--systemctl-command",
		systemctl,
		"--install-dir",
		paths.installDir,
		"--service-path",
		paths.servicePath,
		"--data-dir",
		paths.dataDir,
		"--run-dir",
		paths.runDir,
		"--etc-dir",
		paths.etcDir,
		"--vault",
		paths.vault,
	];
}

async function createUserFixture(base) {
	const home = join(base, "home");
	const installDir = join(home, ".local", "lib", "kaos");
	const current = join(installDir, "current");
	const binDir = join(home, ".local", "bin");
	const binKaos = join(binDir, "kaos");
	const binKaosctl = join(binDir, "kaosctl");
	const configDir = join(home, ".config", "kaos");
	const servicePath = join(home, ".config", "systemd", "user", "kaos-headless-host.service");
	const stateDir = join(home, ".local", "state", "kaos-headless");
	const runtimeDir = join(stateDir, "run", "kaos-headless");
	const vault = join(home, "Vault");
	const externalKaosctl = join(home, "external-kaosctl");
	await Promise.all([mkdir(current, { recursive: true }), mkdir(binDir, { recursive: true }), mkdir(configDir, { recursive: true }), mkdir(dirname(servicePath), { recursive: true }), mkdir(runtimeDir, { recursive: true }), mkdir(vault, { recursive: true })]);
	await Promise.all([
		writeFile(join(current, "kaosctl.mjs"), "console.log('{}')\n", "utf8"),
		writeFile(join(current, "kaos-headless-host.mjs"), "console.log('{}')\n", "utf8"),
		writeFile(join(configDir, "headless.env"), "KAOS_HOST=https://example.invalid\n", "utf8"),
		writeFile(join(configDir, "sync-token"), "secret", "utf8"),
		writeFile(join(configDir, "install.json"), "{}\n", "utf8"),
		writeFile(servicePath, "[Service]\n", "utf8"),
		writeFile(join(stateDir, "data.json"), "{}\n", "utf8"),
		writeFile(join(runtimeDir, "kaos.lock"), "{}\n", "utf8"),
		writeFile(join(vault, "keep.md"), "keep\n", "utf8"),
		writeFile(externalKaosctl, "external\n", "utf8"),
	]);
	await symlink("../lib/kaos/current/kaosctl.mjs", binKaos);
	await symlink(externalKaosctl, binKaosctl);
	return { home, installDir, binKaos, binKaosctl, configDir, servicePath, stateDir, vault };
}
