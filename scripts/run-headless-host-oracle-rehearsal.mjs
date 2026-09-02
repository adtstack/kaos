#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEFAULT_INSTALL_DIR = "/opt/kaos";
const DEFAULT_SERVICE_PATH = "/etc/systemd/system/kaos-headless-host.service";
const DEFAULT_VAULT = "/srv/kaos/vault";
const DEFAULT_DATA_FILE = "/var/lib/kaos-headless/data.json";
const DEFAULT_LOCK_FILE = "/run/kaos-headless/kaos.lock";
const DEFAULT_ENV_FILE = "/etc/kaos/headless.env";
const DEFAULT_IDENTITY_FILE = "/var/lib/kaos-headless/device-identity.json";
const DEFAULT_SMOKE_WORK_DIR = "/var/lib/kaos-headless/smoke-work";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "token-destination-file"]) {
		if (raw[legacy] !== undefined) throw new Error(`--${legacy} is no longer supported; use a one-time invite file and an approved device identity.`);
	}

	const phase = raw.phase ?? "install";
	const logDir = resolve(raw["log-dir"] ?? join(homedir(), `kaos-headless-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`));
	const redactor = createRedactor([]);
	await mkdir(logDir, { recursive: true });

	const completed = [];
	if (phase === "install") {
		await runInstallPhase(raw, logDir, redactor, completed);
	} else if (phase === "update") {
		await runInstallPhase({ ...raw, "skip-bootstrap": "true" }, logDir, redactor, completed);
	} else if (phase === "activate") {
		await runActivatePhase(raw, logDir, redactor, completed);
	} else if (phase === "post-reboot") {
		await runPostRebootPhase(raw, logDir, redactor, completed);
	} else {
		throw new Error(`unsupported --phase: ${phase}`);
	}

	console.log(JSON.stringify({
		kind: "headless-host-oracle-rehearsal-runner",
		ok: true,
		phase,
		logDir,
		completed,
	}, null, 2));
}

async function runInstallPhase(raw, logDir, redactor, completed) {
	const bundleDir = resolve(raw["bundle-dir"] ?? ".");
	const installDir = resolve(raw["install-dir"] ?? DEFAULT_INSTALL_DIR);
	const servicePath = resolve(raw["service-path"] ?? DEFAULT_SERVICE_PATH);
	const metadataPath = resolve(raw["metadata-path"] ?? join(installDir, ".kaos-headless-install.json"));
	const identityFile = resolve(raw["device-identity-file"] ?? DEFAULT_IDENTITY_FILE);
	const inviteFile = raw["invite-file"] ? resolve(raw["invite-file"]) : null;
	if (raw["skip-bootstrap"] !== "true") {
		if (!raw.host) throw new Error("--host is required during install phase unless --skip-bootstrap is used.");
		if (!raw["vault-id"]) throw new Error("--vault-id is required during install phase unless --skip-bootstrap is used.");
		if (!inviteFile) throw new Error("--invite-file is required during the first install so the service can create a pending device request.");
		await assertPrivateInputFile(inviteFile, "invite file");
	}

	await runStep({
		name: "bundle-verify",
		outfile: join(logDir, "02-bundle-verify.json"),
		command: process.execPath,
		args: ["--", join(bundleDir, "verify-headless-host-bundle.mjs"), "--bundle-dir", bundleDir],
		redactor,
		completed,
	});

	if (raw["skip-bootstrap"] !== "true") {
		await runStep({
			name: "bootstrap",
			outfile: join(logDir, "03-bootstrap.json"),
			command: commandWithSudo(raw, process.execPath)[0],
			args: [
				...commandWithSudo(raw, process.execPath).slice(1),
				"--",
				join(bundleDir, "bootstrap-headless-host-oracle.mjs"),
				"--host",
				raw.host,
				"--vault-id",
				raw["vault-id"],
				"--device-name",
				raw["device-name"] ?? "oracle-headless",
				"--identity-file",
				identityFile,
			],
			redactor,
			completed,
		});
	}

	await runStep({
		name: "configuration-permissions",
		outfile: join(logDir, "04-configuration-permissions.txt"),
		command: commandWithSudo(raw, raw["stat-command"] ?? "stat")[0],
		args: [
			...commandWithSudo(raw, raw["stat-command"] ?? "stat").slice(1),
			"-c",
			"%U:%G %a %n",
			raw["env-file"] ?? DEFAULT_ENV_FILE,
			dirname(identityFile),
		],
		redactor,
		completed,
	});

	const updateArgs = [
		join(bundleDir, "update-headless-host-from-release.mjs"),
		"--bundle-dir",
		bundleDir,
		"--install-dir",
		installDir,
		"--service-path",
		servicePath,
		"--service-node",
		raw.node ?? process.execPath,
		"--metadata-path",
		metadataPath,
	];
	if (raw["skip-bootstrap"] === "true") {
		updateArgs.push(
			"--postflight",
			"--postflight-identity-file",
			identityFile,
			"--postflight-smoke-work-dir",
			raw["postflight-smoke-work-dir"] ?? DEFAULT_SMOKE_WORK_DIR,
			"--rollback-on-postflight-failure",
			"--enable-service",
		);
	}
	await runStep({
		name: raw["skip-bootstrap"] === "true" ? "update-postflight" : "install-files",
		outfile: join(logDir, "05-install-files.json"),
		command: commandWithSudo(raw, process.execPath)[0],
		args: [...commandWithSudo(raw, process.execPath).slice(1), "--", ...updateArgs],
		redactor,
		completed,
	});
	if (raw["skip-bootstrap"] !== "true" && inviteFile) {
		const stagedInvite = join(dirname(identityFile), "enroll.invite");
		const serviceUser = raw["service-user"] ?? "kaos";
		const serviceGroup = raw["service-group"] ?? serviceUser;
		await runStep({
			name: "stage-enrollment-invite",
			outfile: join(logDir, "06-stage-enrollment-invite.json"),
			command: commandWithSudo(raw, raw["install-command"] ?? "install")[0],
			args: [...commandWithSudo(raw, raw["install-command"] ?? "install").slice(1), "-o", serviceUser, "-g", serviceGroup, "-m", "0600", inviteFile, stagedInvite],
			redactor,
			completed,
		});
		try {
			await runStep({
				name: "device-enrollment-request",
				outfile: join(logDir, "07-device-enrollment-request.json"),
				command: commandAsServiceUser(raw, raw.node ?? process.execPath, serviceUser)[0],
				args: [
					...commandAsServiceUser(raw, raw.node ?? process.execPath, serviceUser).slice(1), "--", join(installDir, "kaos-headless-host.mjs"), "device", "enroll",
					"--host", raw.host, "--vault-id", raw["vault-id"], "--device-name", raw["device-name"] ?? "oracle-headless",
					"--identity-file", identityFile, "--invite-file", stagedInvite, "--data-file", raw["data-file"] ?? DEFAULT_DATA_FILE,
				],
				redactor,
				completed,
			});
		} finally {
			await removeStagedInvite(raw, stagedInvite);
		}
	}

	await runStep({
		name: "install-metadata",
		outfile: join(logDir, "08-install-metadata.json"),
		command: commandWithSudo(raw, raw["cat-command"] ?? "cat")[0],
		args: [...commandWithSudo(raw, raw["cat-command"] ?? "cat").slice(1), metadataPath],
		redactor,
		completed,
	});
}

async function runActivatePhase(raw, logDir, redactor, completed) {
	if (raw["confirm-owner-approved"] !== "true") {
		throw new Error("--confirm-owner-approved is required after an Owner has compared and approved the pending device fingerprint.");
	}
	const installDir = resolve(raw["install-dir"] ?? DEFAULT_INSTALL_DIR);
	const servicePath = resolve(raw["service-path"] ?? DEFAULT_SERVICE_PATH);
	const identityFile = resolve(raw["device-identity-file"] ?? DEFAULT_IDENTITY_FILE);
	await runStep({
		name: "activate-approved-device",
		outfile: join(logDir, "08-activate-approved-device.json"),
		command: commandWithSudo(raw, process.execPath)[0],
		args: [
			...commandWithSudo(raw, process.execPath).slice(1), "--", raw["installed-update-wrapper"] ?? join(installDir, "update-headless-host-from-release.mjs"),
			"--postflight-only", "--install-dir", installDir, "--service-path", servicePath,
			"--postflight-identity-file", identityFile,
			"--postflight-smoke-work-dir", raw["postflight-smoke-work-dir"] ?? DEFAULT_SMOKE_WORK_DIR,
		],
		redactor,
		completed,
	});
}

async function runPostRebootPhase(raw, logDir, redactor, completed) {
	const installDir = resolve(raw["install-dir"] ?? DEFAULT_INSTALL_DIR);
	const servicePath = resolve(raw["service-path"] ?? DEFAULT_SERVICE_PATH);
	const updateWrapper = resolve(raw["installed-update-wrapper"] ?? join(installDir, "update-headless-host-from-release.mjs"));
	const smokeScript = resolve(raw["smoke-script"] ?? join(installDir, "smoke-headless-host-sync.mjs"));
	const binary = resolve(raw.binary ?? join(installDir, "kaos-headless-host.mjs"));
	const service = raw.service ?? inferServiceName(servicePath) ?? "kaos-headless-host";

	await runStep({
		name: "post-reboot-verify-running",
		outfile: join(logDir, "07-post-reboot-verify-running.json"),
		command: commandWithSudo(raw, process.execPath)[0],
		args: [
			...commandWithSudo(raw, process.execPath).slice(1),
			"--",
			updateWrapper,
			"--postflight-only",
			"--install-dir",
			installDir,
			"--service-path",
			servicePath,
			"--postflight-verify-running",
			"--postflight-smoke-work-dir",
			raw["postflight-smoke-work-dir"] ?? DEFAULT_SMOKE_WORK_DIR,
		],
		redactor,
		completed,
	});

	const smokeCommand = smokeCommandWithUser(raw, process.execPath);
	await runStep({
		name: "operational-smoke",
		outfile: join(logDir, "08-operational-smoke.json"),
		command: smokeCommand[0],
		args: [
			...smokeCommand.slice(1),
			"--",
			smokeScript,
			"--binary",
			binary,
			"--vault",
			resolve(raw.vault ?? DEFAULT_VAULT),
			"--data-file",
			resolve(raw["data-file"] ?? DEFAULT_DATA_FILE),
			"--lock-file",
			resolve(raw["lock-file"] ?? DEFAULT_LOCK_FILE),
			"--env-file",
			resolve(raw["env-file"] ?? DEFAULT_ENV_FILE),
			"--identity-file",
			resolve(raw["device-identity-file"] ?? DEFAULT_IDENTITY_FILE),
			"--require-lock",
		],
		redactor,
		completed,
	});

	await runStep({
		name: "systemctl-status",
		outfile: join(logDir, "09-systemctl-status.txt"),
		command: commandWithSudo(raw, raw["systemctl-command"] ?? "systemctl")[0],
		args: [
			...commandWithSudo(raw, raw["systemctl-command"] ?? "systemctl").slice(1),
			"status",
			service,
			"--no-pager",
		],
		redactor,
		completed,
	});

	await runStep({
		name: "journalctl",
		outfile: join(logDir, "10-journalctl.txt"),
		command: commandWithSudo(raw, raw["journalctl-command"] ?? "journalctl")[0],
		args: [
			...commandWithSudo(raw, raw["journalctl-command"] ?? "journalctl").slice(1),
			"-u",
			service,
			"--since",
			raw["journal-since"] ?? "30 minutes ago",
			"--no-pager",
		],
		redactor,
		completed,
	});
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		for (const flag of ["confirm-owner-approved", "no-sudo", "no-smoke-user", "skip-bootstrap"]) {
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

async function runStep({ name, outfile, command, args, input, redactor, completed }) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		input,
		timeout: 600_000,
	});
	const stdout = redactor(result.stdout ?? "");
	const stderr = redactor(result.stderr ?? "");
	const selectedOutput = selectStepOutput(stdout, stderr);
	await mkdir(dirname(outfile), { recursive: true });
	await writeFile(outfile, selectedOutput, "utf8");
	await chmod(outfile, 0o600).catch(() => undefined);
	const detail = {
		name,
		outfile,
		command,
		args: redactArgs(args),
		status: result.status,
		signal: result.signal,
		stdout: trimOutput(stdout),
		stderr: trimOutput(stderr),
	};
	if (result.error) {
		throw new RehearsalRunnerError(name, `failed to start ${name}: ${result.error.message}`, detail);
	}
	if (result.status !== 0) {
		throw new RehearsalRunnerError(name, `${name} failed`, detail);
	}
	completed.push(detail);
}

function selectStepOutput(stdout, stderr) {
	if (parseJsonPayload(stdout)) return stdout;
	if (parseJsonPayload(stderr)) return stderr;
	return stdout.trim() ? stdout : stderr;
}

function parseJsonPayload(text) {
	const trimmed = String(text ?? "").trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function trimOutput(text) {
	const value = String(text ?? "").trim();
	return value.length > 8000 ? `${value.slice(0, 8000)}...[truncated]` : value;
}

function commandWithSudo(raw, command) {
	if (raw["no-sudo"] === "true") return [command];
	return [raw["sudo-command"] ?? "sudo", "-n", command];
}

function commandAsServiceUser(raw, command, user) {
	if (raw["no-sudo"] === "true") return [command];
	return [raw["sudo-command"] ?? "sudo", "-n", "-u", user, command];
}

function smokeCommandWithUser(raw, command) {
	if (raw["no-smoke-user"] === "true") return [command];
	if (raw["no-sudo"] === "true") return [command];
	return [raw["sudo-command"] ?? "sudo", "-n", "-u", raw["smoke-user"] ?? "kaos", command];
}

function inferServiceName(servicePath) {
	const name = servicePath.split(/[\\/]/).pop() ?? "";
	return name.endsWith(".service") ? name.slice(0, -".service".length) : null;
}

async function assertPrivateInputFile(path, label) {
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
		throw new Error(`${label} must be a regular 0600 file: ${path}`);
	}
}

async function removeStagedInvite(raw, path) {
	const command = commandWithSudo(raw, raw["rm-command"] ?? "rm");
	const result = spawnSync(command[0], [...command.slice(1), "-f", path], { encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0) throw new Error(`failed to remove consumed enrollment invite: ${path}`);
}

function createRedactor(secrets) {
	const values = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))];
	if (values.length === 0) return (text) => String(text);
	return (text) => values.reduce((out, secret) => out.split(secret).join("[redacted]"), String(text));
}

function redactArgs(args) {
	const redacted = [];
	for (let i = 0; i < args.length; i++) {
		redacted.push(args[i]);
		if (args[i] === "--invite-file" && i + 1 < args.length) {
			redacted.push("[redacted]");
			i++;
		}
	}
	return redacted;
}

class RehearsalRunnerError extends Error {
	constructor(step, message, detail) {
		super(message);
		this.step = step;
		this.detail = detail;
	}
}

function printUsage() {
	console.log(`Usage: node scripts/run-headless-host-oracle-rehearsal.mjs [options]

Options:
  --phase <name>                 install, activate, update, or post-reboot. Defaults to install.
  --log-dir <path>               Rehearsal evidence directory.
  --bundle-dir <path>            Unpacked kaos-headless-host-oracle.zip directory.
                                 Defaults to the current directory.
  --host <url>                   KAOS Worker host for bootstrap.
  --vault-id <id>                KAOS vault id for bootstrap.
  --device-name <name>           Device name. Defaults to oracle-headless.
  --invite-file <path>           One-time 0600 enrollment invitation for first install only.
  --device-identity-file <path>  Service identity path. Defaults to /var/lib/kaos-headless/device-identity.json.
  --confirm-owner-approved        Required for phase=activate after Owner approval.
  --install-dir <path>           Install dir. Defaults to /opt/kaos.
  --service-path <path>          systemd service path.
  --metadata-path <path>         Install metadata path. Defaults below --install-dir.
  --postflight-smoke-work-dir <path>
                                 Smoke work dir used by postflight.
  --installed-update-wrapper <path>
                                 Update wrapper used in post-reboot phase.
  --smoke-script <path>          Smoke helper used in post-reboot phase.
  --service <name>               systemd service name for post-reboot evidence.
                                 Defaults to the service file basename.
  --systemctl-command <path>     systemctl command override. Defaults to systemctl.
  --journalctl-command <path>    journalctl command override. Defaults to journalctl.
  --journal-since <value>        journalctl --since value. Defaults to "30 minutes ago".
  --smoke-work-dir <path>        Standalone smoke work dir.
  --smoke-user <user>            User for standalone smoke. Defaults to kaos.
  --no-smoke-user                Run standalone smoke as the current user.
  --skip-bootstrap               Skip bootstrap in install phase. The update phase always skips bootstrap.
  --no-sudo                      Run commands without sudo. Intended for tests.
  --sudo-command <path>          sudo command override. sudo is invoked with
                                 -n so automation fails fast instead of waiting
                                 for a password prompt.
  --stat-command <path>          stat command override. Defaults to stat.
	--install-command <path>       install command override for staging the one-time invite.
	--rm-command <path>            rm command override for removing the consumed invite.
  --node <path>                  Node path installed into the service.
  --help, -h                     Print this help.
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-rehearsal-runner",
		ok: false,
		error: err instanceof Error ? err.message : String(err),
		...(err instanceof RehearsalRunnerError ? { failedStep: err.step, detail: err.detail } : {}),
	}, null, 2));
	process.exitCode = 1;
});
