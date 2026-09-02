#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "token-stdin", "skip-token", "force-token"]) {
		if (raw[legacy] !== undefined) {
			throw new Error(`--${legacy} is no longer supported. Enroll a protected device identity after installing the host.`);
		}
	}

	const dryRun = raw["dry-run"] === "true";
	const allowNonRoot = raw["allow-non-root"] === "true";
	if (!dryRun && !allowNonRoot && process.getuid?.() !== 0) {
		throw new Error("Oracle bootstrap must run as root. Use --dry-run to inspect or --allow-non-root for tests.");
	}

	const user = raw.user ?? "kaos";
	const group = raw.group ?? user;
	const home = resolve(raw.home ?? "/opt/kaos");
	const shell = raw.shell ?? "/sbin/nologin";
	const installDir = resolve(raw["install-dir"] ?? home);
	const vault = resolve(raw.vault ?? "/srv/kaos/vault");
	const dataDir = resolve(raw["data-dir"] ?? "/var/lib/kaos-headless");
	const etcDir = resolve(raw["etc-dir"] ?? "/etc/kaos");
	const envFile = resolve(raw["env-file"] ?? `${etcDir}/headless.env`);
	const identityFile = resolve(raw["identity-file"] ?? `${dataDir}/device-identity.json`);
	if (dirname(identityFile) !== dataDir) {
		throw new Error("--identity-file must be directly inside --data-dir so its parent can be protected for the service account.");
	}
	const commands = {
		id: raw["id-command"] ?? "id",
		getent: raw["getent-command"] ?? "getent",
		groupadd: raw["groupadd-command"] ?? "groupadd",
		useradd: raw["useradd-command"] ?? "useradd",
		chown: raw["chown-command"] ?? "chown",
	};
	const actions = [];

	if (raw["skip-user"] !== "true") {
		ensureGroup({ group, commands, dryRun, actions });
		ensureUser({ user, group, home, shell, commands, dryRun, actions });
	}

	await ensureDirectory({ name: "install-dir", path: installDir, mode: 0o755, owner: "root:root", commands, dryRun, actions });
	await ensureDirectory({ name: "vault", path: vault, mode: 0o755, owner: `${user}:${group}`, commands, dryRun, actions });
	await ensureDirectory({ name: "data-dir", path: dataDir, mode: 0o700, owner: `${user}:${group}`, commands, dryRun, actions });
	await ensureDirectory({ name: "etc-dir", path: etcDir, mode: 0o755, owner: "root:root", commands, dryRun, actions });

	if (raw["skip-env"] !== "true") {
		await ensureEnvFile({
			path: envFile,
			host: raw.host,
			vaultId: raw["vault-id"],
			deviceName: raw["device-name"] ?? "server-headless",
			identityFile,
			attachmentSync: raw["enable-attachments"] === "true" ? "true" : "false",
			force: raw["force-env"] === "true",
			owner: `root:${group}`,
			commands,
			dryRun,
			actions,
		});
	}
	await describeIdentityFile({ path: identityFile, owner: `${user}:${group}`, dryRun, actions });

	console.log(JSON.stringify({
		kind: "headless-host-oracle-bootstrap",
		ok: true,
		dryRun,
		user,
		group,
		paths: {
			installDir,
			vault,
			dataDir,
			etcDir,
			envFile,
			identityFile,
		},
		nextStep: "Run device enroll as the service account with a one-time invite file, then approve its displayed fingerprint as an Owner before starting sync.",
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
		for (const flag of [
			"dry-run",
			"allow-non-root",
			"skip-user",
			"skip-env",
			"force-env",
			"enable-attachments",
		]) {
			if (arg === `--${flag}`) {
				out[flag] = "true";
				continue;
			}
		}
		if (Object.prototype.hasOwnProperty.call(out, arg.slice(2)) && arg.startsWith("--")) {
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

function ensureGroup({ group, commands, dryRun, actions }) {
	if (dryRun) {
		actions.push({ name: "group", group, dryRun: true });
		return;
	}
	const existing = runCheck(commands.getent, ["group", group]);
	if (existing.ok) {
		actions.push({ name: "group", group, exists: true });
		return;
	}
	runRequired("groupadd", commands.groupadd, ["--system", group], actions);
}

function ensureUser({ user, group, home, shell, commands, dryRun, actions }) {
	if (dryRun) {
		actions.push({ name: "user", user, group, home, shell, dryRun: true });
		return;
	}
	const existing = runCheck(commands.id, ["-u", user]);
	if (existing.ok) {
		actions.push({ name: "user", user, exists: true });
		return;
	}
	runRequired("useradd", commands.useradd, ["--system", "--home-dir", home, "--shell", shell, "--gid", group, user], actions);
}

async function ensureDirectory({ name, path, mode, owner, commands, dryRun, actions }) {
	const existed = existsSync(path);
	if (!dryRun) {
		await mkdir(path, { recursive: true });
		await chmod(path, mode);
		runRequired(`chown:${name}`, commands.chown, [owner, path], actions);
	}
	actions.push({
		name,
		path,
		owner,
		mode: modeString(mode),
		existed,
		created: !existed,
		dryRun,
	});
}

async function ensureEnvFile({ path, host, vaultId, deviceName, identityFile, attachmentSync, force, owner, commands, dryRun, actions }) {
	const existed = existsSync(path);
	const shouldWrite = force || !existed;
	if (shouldWrite && (!host || !vaultId) && !dryRun) {
		throw new Error("--host and --vault-id are required when writing headless.env");
	}
	if (!dryRun) {
		await mkdir(dirname(path), { recursive: true });
		if (shouldWrite) {
			await writeFile(path, [
				`KAOS_HOST=${host}`,
				`KAOS_VAULT_ID=${vaultId}`,
				`KAOS_DEVICE_NAME=${deviceName}`,
				`KAOS_IDENTITY_FILE=${identityFile}`,
				`KAOS_ENABLE_ATTACHMENT_SYNC=${attachmentSync}`,
				"",
			].join("\n"), "utf8");
		}
		await chmod(path, 0o640);
		runRequired("chown:env-file", commands.chown, [owner, path], actions);
	}
	actions.push({
		name: "env-file",
		path,
		owner,
		mode: "0640",
		written: shouldWrite,
		preserved: existed && !force,
		dryRun,
	});
}

async function describeIdentityFile({ path, owner, dryRun, actions }) {
	actions.push({
		name: "device-identity-file",
		path,
		owner,
		mode: "0600",
		exists: existsSync(path),
		enrollmentRequired: !existsSync(path),
		dryRun,
	});
}

function runCheck(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		ok: result.status === 0,
		status: result.status,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		error: result.error?.message,
	};
}

function runRequired(name, command, args, actions) {
	const result = runCheck(command, args);
	const action = {
		name,
		command,
		args,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		ok: result.ok,
	};
	actions.push(action);
	if (!result.ok) {
		throw new Error(`${name} failed: ${result.stderr || result.stdout || result.error || `status ${result.status}`}`);
	}
	return action;
}

function modeString(mode) {
	return `0${mode.toString(8).padStart(3, "0")}`;
}

function printUsage() {
	console.log(`Usage: node scripts/bootstrap-headless-host-oracle.mjs [options]

Options:
  --host <url>              KAOS Worker host written to /etc/kaos/headless.env.
  --vault-id <id>           KAOS vault id written to /etc/kaos/headless.env.
  --device-name <name>      Device name. Defaults to server-headless.
  --identity-file <path>    Device identity location. Defaults to <data-dir>/device-identity.json.
  --enable-attachments      Set KAOS_ENABLE_ATTACHMENT_SYNC=true. Defaults false.
  --user <name>             Service user. Defaults to kaos.
  --group <name>            Service group. Defaults to --user.
  --home <path>             Service home and default install dir. Defaults to /opt/kaos.
  --shell <path>            Service shell. Defaults to /sbin/nologin.
  --install-dir <path>      Install directory. Defaults to /opt/kaos.
  --vault <path>            Vault directory. Defaults to /srv/kaos/vault.
  --data-dir <path>         Private service data directory. Defaults to /var/lib/kaos-headless.
  --etc-dir <path>          Config directory. Defaults to /etc/kaos.
  --env-file <path>         Env file. Defaults to /etc/kaos/headless.env.
  --force-env               Rewrite env file if it already exists.
  --skip-user               Do not create/check service user or group.
  --skip-env                Do not write/chmod/chown env file.
  --dry-run                 Print planned actions without writing.
  --allow-non-root          Allow writes as non-root. Intended for tests.
  --id-command <path>       id command override for tests.
  --getent-command <path>   getent command override for tests.
  --groupadd-command <path> groupadd command override for tests.
  --useradd-command <path>  useradd command override for tests.
  --chown-command <path>    chown command override for tests.
  --help, -h                Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-bootstrap",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	process.exitCode = 1;
});
