#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";

const KIND = "headless-host-uninstall";
const SERVICE_NAME = "kaos-headless-host.service";
const BOOLEAN_FLAGS = new Set([
	"allow-non-root",
	"dry-run",
	"help",
	"purge-vault",
	"remove-group",
	"remove-user",
	"yes",
]);
const ALLOWED_OPTIONS = new Set([
	...BOOLEAN_FLAGS,
	"command-bin-dir",
	"config-dir",
	"config-home",
	"data-dir",
	"env-file",
	"etc-dir",
	"group",
	"groupdel-command",
	"home",
	"install-dir",
	"run-dir",
	"scope",
	"service-name",
	"service-path",
	"state-home",
	"systemctl-command",
	"user",
	"userdel-command",
	"vault",
]);
const PROTECTED_REMOVAL_PATHS = new Set(["/", "/bin", "/etc", "/home", "/opt", "/root", "/run", "/sbin", "/srv", "/usr", "/var"]);

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const scope = raw.scope ?? "system";
	if (scope !== "system" && scope !== "user") {
		throw new Error(`--scope must be "system" or "user", got: ${scope}`);
	}
	const dryRun = raw["dry-run"] === "true";
	if (!dryRun && raw.yes !== "true") {
		throw new Error("uninstall changes files and services; rerun with --yes, or use --dry-run to inspect the plan");
	}
	if (scope === "system" && !dryRun && raw["allow-non-root"] !== "true" && process.getuid?.() !== 0) {
		throw new Error("system uninstall must run as root. Use sudo, --dry-run, or --allow-non-root for tests.");
	}
	if (scope === "user" && (raw["remove-user"] === "true" || raw["remove-group"] === "true")) {
		throw new Error("--remove-user and --remove-group are only available with --scope system");
	}
	if (raw["remove-group"] === "true" && raw["remove-user"] !== "true") {
		throw new Error("--remove-group requires --remove-user");
	}
	if (raw["remove-user"] === "true" && raw["purge-vault"] !== "true") {
		throw new Error("--remove-user requires --purge-vault so the service account does not leave an orphaned vault");
	}

	const paths = scope === "system" ? systemPaths(raw) : userPaths(raw);
	assertRemovalPaths(paths);
	const actions = [];

	await disableService({ paths, scope, dryRun, actions });
	await removeManagedFile({ name: "service-file", path: paths.servicePath, dryRun, actions });
	await reloadServiceManager({ paths, scope, dryRun, actions });

	if (scope === "user") {
		await removeManagedCommand({ name: "kaos-command", path: paths.binKaos, installDir: paths.installDir, dryRun, actions });
		await removeManagedCommand({ name: "kaosctl-command", path: paths.binKaosctl, installDir: paths.installDir, dryRun, actions });
	}

	await removeManagedDirectory({ name: "install-dir", path: paths.installDir, dryRun, actions });
	await removeManagedDirectory({ name: "data-dir", path: paths.dataDir, dryRun, actions });
	if (paths.runDir !== paths.dataDir && !isChildPath(paths.runDir, paths.dataDir)) {
		await removeManagedDirectory({ name: "run-dir", path: paths.runDir, dryRun, actions });
	}
	await removeManagedFile({ name: "env-file", path: paths.envFile, dryRun, actions });
	await removeManagedFile({ name: "legacy-credential-file", path: paths.legacyCredentialFile, dryRun, actions });
	if (paths.installConfig) {
		await removeManagedFile({ name: "install-config", path: paths.installConfig, dryRun, actions });
	}
	await removeIfEmpty({ name: paths.configDirName, path: paths.configDir, dryRun, actions });
	if (paths.serviceDir) {
		await removeIfEmpty({ name: "service-dir", path: paths.serviceDir, dryRun, actions });
	}

	if (raw["purge-vault"] === "true") {
		if (!paths.vault) throw new Error("--purge-vault requires --vault with --scope user");
		await removeManagedDirectory({ name: "vault", path: paths.vault, dryRun, actions });
	} else {
		actions.push({ name: "vault", path: paths.vault, removed: false, preserved: true, reason: "pass --purge-vault to delete vault data" });
	}

	if (scope === "system" && raw["remove-user"] === "true") {
		await removeAccount({ name: "service-user", command: raw["userdel-command"] ?? "userdel", args: [paths.user], dryRun, actions });
		if (raw["remove-group"] === "true") {
			await removeAccount({ name: "service-group", command: raw["groupdel-command"] ?? "groupdel", args: [paths.group], dryRun, actions });
		}
	}

	await resetFailedService({ paths, scope, dryRun, actions });
	console.log(JSON.stringify({
		kind: KIND,
		ok: true,
		scope,
		dryRun,
		purgedVault: raw["purge-vault"] === "true",
		removedUser: raw["remove-user"] === "true",
		removedGroup: raw["remove-group"] === "true",
		paths: summarizePaths(paths),
		actions,
	}, null, 2));
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected positional argument: ${arg}`);
		const option = arg.slice(2);
		const equals = option.indexOf("=");
		const key = equals >= 0 ? option.slice(0, equals) : option;
		if (!ALLOWED_OPTIONS.has(key)) throw new Error(`unknown option: --${key}`);
		if (BOOLEAN_FLAGS.has(key)) {
			if (equals >= 0) throw new Error(`--${key} does not take a value`);
			out[key] = "true";
			continue;
		}
		if (equals >= 0) {
			out[key] = option.slice(equals + 1);
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
		out[key] = next;
		i++;
	}
	return out;
}

function systemPaths(raw) {
	const etcDir = resolve(raw["etc-dir"] ?? "/etc/kaos");
	const servicePath = resolve(raw["service-path"] ?? "/etc/systemd/system/kaos-headless-host.service");
	return {
		installDir: resolve(raw["install-dir"] ?? "/opt/kaos"),
		servicePath,
		serviceName: serviceName(raw["service-name"] ?? basename(servicePath)),
		systemctl: raw["systemctl-command"] ?? "systemctl",
		dataDir: resolve(raw["data-dir"] ?? "/var/lib/kaos-headless"),
		runDir: resolve(raw["run-dir"] ?? "/run/kaos-headless"),
		configDir: etcDir,
		configDirName: "etc-dir",
		serviceDir: null,
		envFile: resolve(raw["env-file"] ?? join(etcDir, "headless.env")),
		legacyCredentialFile: resolve(join(etcDir, "sync-token")),
		installConfig: null,
		vault: resolve(raw.vault ?? "/srv/kaos/vault"),
		user: raw.user ?? "kaos",
		group: raw.group ?? raw.user ?? "kaos",
		binKaos: null,
		binKaosctl: null,
	};
}

function userPaths(raw) {
	const customHome = raw.home !== undefined;
	const home = resolve(raw.home ?? homedir());
	const configHome = resolve(raw["config-home"] ?? (!customHome ? process.env.XDG_CONFIG_HOME : undefined) ?? join(home, ".config"));
	const stateHome = resolve(raw["state-home"] ?? (!customHome ? process.env.XDG_STATE_HOME : undefined) ?? join(home, ".local", "state"));
	const runtimeBase = resolve((!customHome ? process.env.XDG_RUNTIME_DIR : undefined) ?? join(stateHome, "kaos-headless", "run"));
	const configDir = resolve(raw["config-dir"] ?? join(configHome, "kaos"));
	const serviceDir = join(configHome, "systemd", "user");
	const servicePath = resolve(raw["service-path"] ?? join(serviceDir, SERVICE_NAME));
	return {
		installDir: resolve(raw["install-dir"] ?? join(home, ".local", "lib", "kaos")),
		servicePath,
		serviceName: serviceName(raw["service-name"] ?? basename(servicePath)),
		systemctl: raw["systemctl-command"] ?? "systemctl",
		dataDir: resolve(raw["data-dir"] ?? join(stateHome, "kaos-headless")),
		runDir: resolve(raw["run-dir"] ?? join(runtimeBase, "kaos-headless")),
		configDir,
		configDirName: "config-dir",
		serviceDir,
		envFile: resolve(raw["env-file"] ?? join(configDir, "headless.env")),
		legacyCredentialFile: resolve(join(configDir, "sync-token")),
		installConfig: join(configDir, "install.json"),
		vault: raw.vault ? resolve(raw.vault) : null,
		user: null,
		group: null,
		binKaos: join(resolve(raw["command-bin-dir"] ?? join(home, ".local", "bin")), "kaos"),
		binKaosctl: join(resolve(raw["command-bin-dir"] ?? join(home, ".local", "bin")), "kaosctl"),
	};
}

function assertRemovalPaths(paths) {
	for (const [name, path] of Object.entries({
		"install-dir": paths.installDir,
		"service-file": paths.servicePath,
		"data-dir": paths.dataDir,
		"run-dir": paths.runDir,
		"config-dir": paths.configDir,
		"env-file": paths.envFile,
		"legacy-credential-file": paths.legacyCredentialFile,
		"install-config": paths.installConfig,
		"service-dir": paths.serviceDir,
		"kaos-command": paths.binKaos,
		"kaosctl-command": paths.binKaosctl,
		vault: paths.vault,
	})) {
		if (path) assertSafeRemovalPath(name, path);
	}
}

function assertSafeRemovalPath(name, path) {
	if (!path.startsWith(sep) || PROTECTED_REMOVAL_PATHS.has(path)) {
		throw new Error(`refusing to remove unsafe ${name} path: ${path}`);
	}
}

async function disableService({ paths, scope, dryRun, actions }) {
	const args = [...systemctlScopeArgs(scope), "disable", "--now", paths.serviceName];
	if (dryRun) {
		actions.push(commandAction("service-disable", paths.systemctl, args, true));
		return;
	}
	const result = runCommand(paths.systemctl, args);
	actions.push(commandAction("service-disable", paths.systemctl, args, false, result));
	if (result.ok) return;
	if (result.error) throw new Error(`could not run ${paths.systemctl}: ${result.error}`);

	const activeArgs = [...systemctlScopeArgs(scope), "is-active", "--quiet", paths.serviceName];
	const active = runCommand(paths.systemctl, activeArgs);
	actions.push(commandAction("service-active-check", paths.systemctl, activeArgs, false, active));
	if (active.error) throw new Error(`could not run ${paths.systemctl}: ${active.error}`);
	if (active.ok) throw new Error(`could not stop active service ${paths.serviceName}`);
}

async function reloadServiceManager({ paths, scope, dryRun, actions }) {
	const args = [...systemctlScopeArgs(scope), "daemon-reload"];
	if (dryRun) {
		actions.push(commandAction("service-daemon-reload", paths.systemctl, args, true));
		return;
	}
	const result = runCommand(paths.systemctl, args);
	actions.push(commandAction("service-daemon-reload", paths.systemctl, args, false, result));
	if (!result.ok) throw new Error(`${paths.systemctl} daemon-reload failed: ${commandFailure(result)}`);
}

async function resetFailedService({ paths, scope, dryRun, actions }) {
	const args = [...systemctlScopeArgs(scope), "reset-failed", paths.serviceName];
	if (dryRun) {
		actions.push(commandAction("service-reset-failed", paths.systemctl, args, true));
		return;
	}
	const result = runCommand(paths.systemctl, args);
	actions.push(commandAction("service-reset-failed", paths.systemctl, args, false, result));
}

function systemctlScopeArgs(scope) {
	return scope === "user" ? ["--user"] : [];
}

function runCommand(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		ok: result.status === 0,
		status: result.status,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		error: result.error?.message ?? null,
	};
}

function commandAction(name, command, args, dryRun, result = null) {
	return {
		name,
		command,
		args,
		dryRun,
		...(result ? { ok: result.ok, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error } : {}),
	};
}

function commandFailure(result) {
	return result.stderr || result.stdout || result.error || `status ${result.status}`;
}

async function removeManagedDirectory({ name, path, dryRun, actions }) {
	const info = await lstatOrNull(path);
	if (info && !info.isDirectory()) throw new Error(`${name} is not a directory: ${path}`);
	if (!dryRun && info) await rm(path, { recursive: true, force: false });
	actions.push({ name, path, type: "directory", existed: Boolean(info), removed: Boolean(info) && !dryRun, dryRun });
}

async function removeManagedFile({ name, path, dryRun, actions }) {
	const info = await lstatOrNull(path);
	if (info?.isDirectory()) throw new Error(`${name} is a directory, refusing to remove it as a file: ${path}`);
	if (!dryRun && info) await rm(path, { force: true });
	actions.push({ name, path, type: "file", existed: Boolean(info), removed: Boolean(info) && !dryRun, dryRun });
}

async function removeIfEmpty({ name, path, dryRun, actions }) {
	const info = await lstatOrNull(path);
	if (!info) {
		actions.push({ name, path, existed: false, removed: false, dryRun });
		return;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) {
		actions.push({ name, path, existed: true, removed: false, preserved: true, reason: "not an empty directory", dryRun });
		return;
	}
	if (dryRun) {
		actions.push({ name, path, existed: true, removed: false, dryRun, condition: "only if empty" });
		return;
	}
	try {
		await rmdir(path);
		actions.push({ name, path, existed: true, removed: true, dryRun: false });
	} catch (err) {
		if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST") {
			actions.push({ name, path, existed: true, removed: false, preserved: true, reason: "directory is not empty", dryRun: false });
			return;
		}
		throw err;
	}
}

async function removeManagedCommand({ name, path, installDir, dryRun, actions }) {
	const info = await lstatOrNull(path);
	if (!info) {
		actions.push({ name, path, existed: false, removed: false, dryRun });
		return;
	}
	let managed = false;
	if (info.isSymbolicLink()) {
		const target = resolve(dirname(path), await readlink(path));
		managed = target === installDir || isChildPath(target, installDir);
	} else if (info.isFile()) {
		managed = await sameAsInstalledKaosctl(path, installDir);
	}
	if (!managed) {
		actions.push({ name, path, existed: true, removed: false, preserved: true, reason: "not managed by KAOS", dryRun });
		return;
	}
	if (!dryRun) await rm(path, { force: true });
	actions.push({ name, path, existed: true, removed: !dryRun, dryRun });
}

async function sameAsInstalledKaosctl(commandPath, installDir) {
	try {
		const [command, installed] = await Promise.all([
			readFile(commandPath),
			readFile(join(installDir, "current", "kaosctl.mjs")),
		]);
		return command.equals(installed);
	} catch {
		return false;
	}
}

async function removeAccount({ name, command, args, dryRun, actions }) {
	if (dryRun) {
		actions.push(commandAction(name, command, args, true));
		return;
	}
	const result = runCommand(command, args);
	actions.push(commandAction(name, command, args, false, result));
	if (!result.ok) throw new Error(`${name} removal failed: ${commandFailure(result)}`);
}

async function lstatOrNull(path) {
	return await lstat(path).catch((err) => {
		if (err?.code === "ENOENT") return null;
		throw err;
	});
}

function isChildPath(path, parent) {
	return path.startsWith(`${parent}${sep}`);
}

function serviceName(value) {
	if (!value || /[\s/]/.test(value)) throw new Error(`invalid systemd service name: ${value}`);
	return value;
}

function summarizePaths(paths) {
	return {
		installDir: paths.installDir,
		servicePath: paths.servicePath,
		serviceName: paths.serviceName,
		dataDir: paths.dataDir,
		runDir: paths.runDir,
		configDir: paths.configDir,
		envFile: paths.envFile,
		legacyCredentialFile: paths.legacyCredentialFile,
		installConfig: paths.installConfig,
		vault: paths.vault,
	};
}

function printUsage() {
	console.log(`Usage: node uninstall-headless-host.mjs [options]

Stops and disables the KAOS headless service, then removes its runner, service
unit, state, and sync configuration. The vault is preserved unless explicitly
purged.

Options:
  --scope <system|user>    Install type. Defaults to system.
  --yes                    Confirm file and service removal. Required except with --dry-run.
  --dry-run                Print the removal plan without changing anything.
  --purge-vault            Also remove the configured vault. Requires --vault for user scope.
  --vault <path>           Vault to preserve or purge. Defaults to /srv/kaos/vault for system scope.
  --remove-user            Remove the system service user after a vault purge.
  --remove-group           Also remove the system service group; requires --remove-user.
  --install-dir <path>     Runner/helper directory. Defaults to /opt/kaos for system scope.
  --service-path <path>    systemd unit path.
  --service-name <name>    systemd unit name. Defaults to the service path basename.
  --data-dir <path>        State directory.
  --run-dir <path>         Runtime lock directory.
  --etc-dir <path>         System configuration directory.
  --env-file <path>        Environment file.
  --user <name>            Service user for --remove-user. Defaults to kaos.
  --group <name>           Service group for --remove-group. Defaults to --user.
  --home <path>            User home for --scope user.
  --config-home <path>     XDG config home for --scope user.
  --state-home <path>      XDG state home for --scope user.
  --config-dir <path>      KAOS user configuration directory.
  --command-bin-dir <path> User command directory. Defaults to ~/.local/bin.
  --systemctl-command <path>
                          systemctl override, primarily for controlled environments.
  --allow-non-root         Permit a non-root system uninstall for tests only.
  --help, -h               Print this help.

Examples:
  sudo node /opt/kaos/uninstall-headless-host.mjs --dry-run
  sudo node /opt/kaos/uninstall-headless-host.mjs --yes
  sudo node /opt/kaos/uninstall-headless-host.mjs --yes --purge-vault --remove-user --remove-group
  kaos uninstall --yes
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: KIND,
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	process.exitCode = 1;
});
