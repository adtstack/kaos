#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ZIP = "dist/kaos-headless-host-oracle.zip";
const DEFAULT_INSTALL_DIR = "/opt/kaos";
const DEFAULT_REMOTE_DIR = `kaos-headless-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
let failureContext = {};
let failureEvidenceFetch = null;

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}
	for (const legacy of ["token", "token-file", "secret-file"]) {
		if (raw[legacy] !== undefined) throw new Error(`--${legacy} is no longer supported; the remote flow uses a one-time invite file and an approved device identity.`);
	}

	const phase = raw.phase ?? "install";
	const sshTarget = raw["ssh-target"] ?? raw.target;
	if (!sshTarget) throw new Error("--ssh-target is required.");
	if (!["preflight", "install", "activate", "update", "reboot", "post-reboot"].includes(phase)) {
		throw new Error(`unsupported --phase: ${phase}`);
	}
	const fetchLogDirRaw = raw["fetch-log-dir"] ?? raw["evidence-dir"] ?? null;
	const verifyFetchedLogs = raw["verify-fetched-logs"] === "true" || Boolean(raw["evidence-dir"] && phase !== "preflight");
	if (raw["verify-fetched-logs"] === "true" && !fetchLogDirRaw) {
		throw new Error("--verify-fetched-logs requires --fetch-log-dir or --evidence-dir.");
	}
	if (verifyFetchedLogs && phase === "preflight") {
		throw new Error("--verify-fetched-logs is not supported during preflight phase.");
	}
	if (phase === "reboot" && fetchLogDirRaw) {
		throw new Error("--fetch-log-dir/--evidence-dir is not supported during reboot phase; use post-reboot with --wait-for-ssh to fetch evidence.");
	}
	if (raw["require-reboot-request"] === "true" && phase !== "post-reboot") {
		throw new Error("--require-reboot-request is only supported during post-reboot phase verification.");
	}

	const sshCommand = raw.ssh ?? "ssh";
	const scpCommand = raw.scp ?? "scp";
	const sshArgs = buildSshArgs(raw);
	const scpArgs = buildScpArgs(raw);
	const remoteDir = raw["remote-dir"] ?? DEFAULT_REMOTE_DIR;
	assertSafeRemotePath(remoteDir, "--remote-dir");
	if (raw["skip-local-prepare"] === "true" && (!raw.zip || !raw.checksum)) {
		throw new Error("--skip-local-prepare requires explicit --zip and --checksum paths.");
	}
	const zipPath = resolve(raw.zip ?? DEFAULT_ZIP);
	const checksumPath = resolve(raw.checksum ?? `${zipPath}.sha256`);
	const inviteFile = raw["invite-file"] ? resolve(raw["invite-file"]) : null;
	const redactor = createRedactor([]);
	failureContext = {
		phase,
		sshTarget,
		remoteDir,
		...(fetchLogDirRaw ? { fetchLogDir: resolve(fetchLogDirRaw) } : {}),
	};
	if (fetchLogDirRaw) {
		failureEvidenceFetch = {
			command: scpCommand,
			extraArgs: scpArgs,
			sshTarget,
			remoteDir,
			localLogDir: resolve(fetchLogDirRaw),
			redactor,
		};
	}
	const completed = [];
	let fetchedLogDir = null;

	if (raw["wait-for-ssh"] === "true") {
		await waitForSsh({
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			raw,
			completed,
			redactor,
		});
	}

	if (phase === "preflight") {
		runSsh({
			name: "remote-preflight",
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			remoteScript: preflightRemoteScript(remoteDir),
			completed,
			redactor,
		});
	} else if (phase === "install" || phase === "update") {
		if (phase === "install") {
			if (!raw["worker-host"]) throw new Error("--worker-host is required during install phase.");
			if (!raw["vault-id"]) throw new Error("--vault-id is required during install phase.");
			if (!inviteFile) throw new Error("--invite-file is required during install phase.");
			await assertPrivateInputFile(inviteFile, "invite file");
		}

		await runLocalPrepare(raw, completed, redactor);
		if (raw["skip-remote-preflight"] === "true") {
			runSsh({
				name: "remote-mkdir",
				command: sshCommand,
				extraArgs: sshArgs,
				target: sshTarget,
				remoteScript: `set -euo pipefail\nmkdir -p ${shellQuote(remoteDir)}\nchmod 700 ${shellQuote(remoteDir)}`,
				completed,
				redactor,
			});
		} else {
			runSsh({
				name: "remote-preflight",
				command: sshCommand,
				extraArgs: sshArgs,
				target: sshTarget,
				remoteScript: preflightRemoteScript(remoteDir),
				completed,
				redactor,
			});
		}
		runScp({
			name: "upload-zip",
			command: scpCommand,
			extraArgs: scpArgs,
			source: zipPath,
			destination: remoteTarget(sshTarget, `${remoteDir}/kaos-headless-host-oracle.zip`),
			completed,
			redactor,
		});
		runScp({
			name: "upload-checksum",
			command: scpCommand,
			extraArgs: scpArgs,
			source: checksumPath,
			destination: remoteTarget(sshTarget, `${remoteDir}/kaos-headless-host-oracle.zip.sha256`),
			completed,
			redactor,
		});
		if (phase === "install") {
			runScp({
				name: "upload-enrollment-invite",
				command: scpCommand,
				extraArgs: scpArgs,
				source: inviteFile,
				destination: remoteTarget(sshTarget, `${remoteDir}/enroll.invite`),
				completed,
				redactor,
			});
		}
		runSsh({
			name: phase === "install" ? "remote-install-rehearsal" : "remote-update-rehearsal",
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			remoteScript: phase === "install" ? installRemoteScript(raw, remoteDir) : updateRemoteScript(raw, remoteDir),
			completed,
			redactor,
			timeout: Number(raw.timeout ?? 900_000),
		});
	} else if (phase === "activate") {
		if (raw["confirm-owner-approved"] !== "true") throw new Error("--confirm-owner-approved is required after the Owner has approved the enrolled device.");
		runSsh({
			name: "remote-activate-approved-device",
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			remoteScript: activateRemoteScript(raw, remoteDir),
			completed,
			redactor,
			timeout: Number(raw.timeout ?? 900_000),
		});
	} else if (phase === "reboot") {
		runSsh({
			name: "remote-reboot-request",
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			remoteScript: rebootRemoteScript(remoteDir),
			completed,
			redactor,
		});
	} else {
		runSsh({
			name: "remote-post-reboot-rehearsal",
			command: sshCommand,
			extraArgs: sshArgs,
			target: sshTarget,
			remoteScript: postRebootRemoteScript(raw, remoteDir),
			completed,
			redactor,
			timeout: Number(raw.timeout ?? 900_000),
		});
	}

	if (fetchLogDirRaw) {
		const localLogDir = resolve(fetchLogDirRaw);
		fetchedLogDir = localLogDir;
		failureContext = { ...failureContext, fetchLogDir: localLogDir };
		await mkdir(localLogDir, { recursive: true });
		runScp({
			name: "fetch-rehearsal-logs",
			command: scpCommand,
			extraArgs: scpArgs,
			recursive: true,
			source: remoteTarget(sshTarget, `${remoteDir}/.`),
			destination: localLogDir,
			completed,
			redactor,
		});
	}
	if (verifyFetchedLogs) {
		runLocalVerifier({
			logDir: fetchedLogDir,
			mode: verifierModeForPhase(phase),
			requireRebootRequest: raw["require-reboot-request"] === "true",
			completed,
			redactor,
		});
	}

	console.log(JSON.stringify({
		kind: "headless-host-oracle-remote-rehearsal",
		ok: true,
		phase,
		sshTarget,
		remoteDir,
		fetchLogDir: fetchedLogDir,
		verifiedFetchedLogs: verifyFetchedLogs,
		completed,
		nextStep: phase === "install"
			? "Compare the displayed device fingerprint in the Owner UI, approve it, then rerun with --phase activate --confirm-owner-approved."
			: phase === "activate"
				? `approved device activated; reboot ${sshTarget}, then rerun with --phase post-reboot --wait-for-ssh --remote-dir ${remoteDir}`
			: phase === "update"
				? "update phase complete; fetched logs are update-verifiable with --mode update"
				: phase === "reboot"
					? `reboot requested; rerun with --phase post-reboot --wait-for-ssh --remote-dir ${remoteDir}`
				: phase === "preflight"
					? `remote preflight passed; rerun with --phase install --remote-dir ${remoteDir}`
					: "verify fetched logs with npm run verify:headless-host-oracle-rehearsal",
	}, null, 2));
}

function verifierModeForPhase(phase) {
	if (phase === "install") return "install";
	if (phase === "update") return "update";
	return "full";
}

function runLocalVerifier({ logDir, mode, requireRebootRequest, completed, redactor }) {
	const verifier = resolveLocalHelper("verify-headless-host-oracle-rehearsal.mjs");
	const args = [
		verifier,
		"--log-dir",
		logDir,
	];
	if (mode && mode !== "full") {
		args.push("--mode", mode);
	}
	if (requireRebootRequest) {
		if (mode && mode !== "full") {
			throw new Error("--require-reboot-request is only supported for post-reboot/full verification.");
		}
		args.push("--require-reboot-request");
	}
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 120_000,
	});
	const displayArgs = [
		verifier,
		"--log-dir",
		logDir,
		...(mode && mode !== "full" ? ["--mode", mode] : []),
		...(requireRebootRequest ? ["--require-reboot-request"] : []),
	];
	recordStep({
		name: "verify-fetched-logs",
		command: process.execPath,
		args,
		displayArgs,
		result,
		completed,
		redactor,
	});
}

async function runLocalPrepare(raw, completed, redactor) {
	if (raw["skip-local-prepare"] === "true") {
		const validator = resolveLocalHelper("validate-headless-host-release-assets.mjs");
		const args = [
			validator,
			"--zip",
			resolve(raw.zip),
			"--checksum",
			resolve(raw.checksum),
		];
		const result = spawnSync(process.execPath, args, {
			encoding: "utf8",
			timeout: 120_000,
		});
		recordStep({ name: "local-release-assets-validate", command: process.execPath, args, result, completed, redactor });
		completed.push({
			name: "local-upload-prepare",
			skipped: true,
			reason: "explicit --skip-local-prepare after local release asset validation",
		});
		return;
	}
	const prepare = resolveLocalHelper("prepare-headless-host-oracle-upload.mjs");
	const args = [
		prepare,
		"--zip",
		resolve(raw.zip ?? DEFAULT_ZIP),
		"--checksum",
		resolve(raw.checksum ?? `${resolve(raw.zip ?? DEFAULT_ZIP)}.sha256`),
	];
	const target = raw["ssh-target"] ?? raw.target;
	if (target) {
		args.push("--target", remoteTarget(target, raw["remote-dir"] ?? DEFAULT_REMOTE_DIR));
	}
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 120_000,
	});
	recordStep({ name: "local-upload-prepare", command: process.execPath, args, result, completed, redactor });
}

function installRemoteScript(raw, remoteDir) {
	const runnerArgs = [
		"node",
		"\"$BUNDLE_DIR/run-headless-host-oracle-rehearsal.mjs\"",
		"--phase",
		"install",
		"--bundle-dir",
		"\"$BUNDLE_DIR\"",
		"--host",
		shellQuote(raw["worker-host"]),
		"--vault-id",
		shellQuote(raw["vault-id"]),
		"--device-name",
		shellQuote(raw["device-name"] ?? "oracle-headless"),
		"--invite-file",
		"\"$INVITE_FILE\"",
		"--log-dir",
		"\"$REMOTE_DIR\"",
	];
	pushOptionalRunnerArgs(runnerArgs, raw, [
		"install-dir",
		"service-path",
		"metadata-path",
		"device-identity-file",
		"postflight-smoke-work-dir",
		"node",
	]);
	const parts = [
		"set -euo pipefail",
		`cd ${shellQuote(remoteDir)}`,
		"REMOTE_DIR=\"$(pwd)\"",
		"BUNDLE_DIR=\"$REMOTE_DIR/kaos-headless-host-oracle\"",
		"INVITE_FILE=\"$REMOTE_DIR/enroll.invite\"",
		"trap 'rm -f \"$INVITE_FILE\"' EXIT",
		"chmod 600 \"$INVITE_FILE\"",
		"sha256sum -c kaos-headless-host-oracle.zip.sha256 | tee \"$REMOTE_DIR/01-zip-sha256.txt\"",
		"rm -rf \"$BUNDLE_DIR\"",
		"unzip -q kaos-headless-host-oracle.zip -d \"$BUNDLE_DIR\"",
		runnerArgs.join(" "),
	];
	return parts.join("\n");
}

function activateRemoteScript(raw, remoteDir) {
	const installDir = raw["install-dir"] ?? DEFAULT_INSTALL_DIR;
	const installedRunner = raw["installed-runner"] ?? `${installDir}/run-headless-host-oracle-rehearsal.mjs`;
	const runnerArgs = [
		"node", "\"$INSTALLED_RUNNER\"", "--phase", "activate", "--confirm-owner-approved", "--log-dir", "\"$REMOTE_DIR\"",
	];
	pushOptionalRunnerArgs(runnerArgs, raw, [
		"install-dir", "service-path", "installed-update-wrapper", "postflight-smoke-work-dir", "device-identity-file",
	]);
	return [
		"set -euo pipefail",
		`cd ${shellQuote(remoteDir)}`,
		"REMOTE_DIR=\"$(pwd)\"",
		`INSTALLED_RUNNER=${shellQuote(installedRunner)}`,
		"test -r \"$INSTALLED_RUNNER\"",
		runnerArgs.join(" "),
	].join("\n");
}

function preflightRemoteScript(remoteDir) {
	return [
		"set -euo pipefail",
		`REMOTE_DIR=${shellQuote(remoteDir)}`,
		"mkdir -p \"$REMOTE_DIR\"",
		"chmod 700 \"$REMOTE_DIR\"",
		"test -d \"$REMOTE_DIR\"",
		"test -w \"$REMOTE_DIR\"",
		"NODE_PATH=$(command -v node)",
		"NODE_VERSION=$(\"$NODE_PATH\" --version)",
		"\"$NODE_PATH\" -e 'const major = Number(process.versions.node.split(\".\")[0]); if (major < 20) { console.error(`Node.js 20+ required, got ${process.version}`); process.exit(1); }'",
		"UNZIP_PATH=$(command -v unzip)",
		"SHA256SUM_PATH=$(command -v sha256sum)",
		"SUDO_PATH=$(command -v sudo)",
		"SYSTEMCTL_PATH=$(command -v systemctl)",
		"sudo -n true",
		"systemctl --version >/dev/null",
		"export REMOTE_DIR NODE_PATH NODE_VERSION UNZIP_PATH SHA256SUM_PATH SUDO_PATH SYSTEMCTL_PATH",
		"\"$NODE_PATH\" - <<'NODE'",
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const payload = {",
		"  kind: 'headless-host-oracle-remote-preflight',",
		"  ok: true,",
		"  remoteDir: process.env.REMOTE_DIR,",
		"  nodePath: process.env.NODE_PATH,",
		"  nodeVersion: process.env.NODE_VERSION,",
		"  unzipPath: process.env.UNZIP_PATH,",
		"  sha256sumPath: process.env.SHA256SUM_PATH,",
		"  sudoPath: process.env.SUDO_PATH,",
		"  systemctlPath: process.env.SYSTEMCTL_PATH,",
		"  sudoNonInteractive: true",
		"};",
		"const outfile = path.join(process.env.REMOTE_DIR, '00-remote-preflight.json');",
		"fs.writeFileSync(outfile, `${JSON.stringify(payload, null, 2)}\\n`);",
		"console.log(JSON.stringify(payload, null, 2));",
		"NODE",
	].join("\n");
}

function updateRemoteScript(raw, remoteDir) {
	const runnerArgs = [
		"node",
		"\"$BUNDLE_DIR/run-headless-host-oracle-rehearsal.mjs\"",
		"--phase",
		"update",
		"--bundle-dir",
		"\"$BUNDLE_DIR\"",
		"--log-dir",
		"\"$REMOTE_DIR\"",
	];
	pushOptionalRunnerArgs(runnerArgs, raw, [
		"install-dir",
		"service-path",
		"metadata-path",
		"postflight-smoke-work-dir",
		"device-identity-file",
		"node",
	]);
	return [
		"set -euo pipefail",
		`cd ${shellQuote(remoteDir)}`,
		"REMOTE_DIR=\"$(pwd)\"",
		"BUNDLE_DIR=\"$REMOTE_DIR/kaos-headless-host-oracle\"",
		"sha256sum -c kaos-headless-host-oracle.zip.sha256 | tee \"$REMOTE_DIR/01-zip-sha256.txt\"",
		"rm -rf \"$BUNDLE_DIR\"",
		"unzip -q kaos-headless-host-oracle.zip -d \"$BUNDLE_DIR\"",
		runnerArgs.join(" "),
	].join("\n");
}

function postRebootRemoteScript(raw, remoteDir) {
	const installDir = raw["install-dir"] ?? DEFAULT_INSTALL_DIR;
	const installedRunner = raw["installed-runner"] ?? `${installDir}/run-headless-host-oracle-rehearsal.mjs`;
	const runnerArgs = [
		"node",
		"\"$INSTALLED_RUNNER\"",
		"--phase",
		"post-reboot",
		"--log-dir",
		"\"$REMOTE_DIR\"",
	];
	pushOptionalRunnerArgs(runnerArgs, raw, [
		"install-dir",
		"service-path",
		"installed-update-wrapper",
		"smoke-script",
		"service",
		"journal-since",
		"postflight-smoke-work-dir",
		"vault",
		"data-file",
		"lock-file",
		"env-file",
		"device-identity-file",
		"smoke-work-dir",
	]);
	return [
		"set -euo pipefail",
		`REMOTE_DIR=${shellQuote(remoteDir)}`,
		`INSTALLED_RUNNER=${shellQuote(installedRunner)}`,
		"test -r \"$INSTALLED_RUNNER\"",
		runnerArgs.join(" "),
	].join("\n");
}

function rebootRemoteScript(remoteDir) {
	return [
		"set -euo pipefail",
		`REMOTE_DIR=${shellQuote(remoteDir)}`,
		"mkdir -p \"$REMOTE_DIR\"",
		"chmod 700 \"$REMOTE_DIR\"",
		"NODE_PATH=$(command -v node)",
		"SYSTEMCTL_PATH=$(command -v systemctl)",
		"SUDO_PATH=$(command -v sudo)",
		"sudo -n true",
		"export REMOTE_DIR NODE_PATH SYSTEMCTL_PATH SUDO_PATH",
		"\"$NODE_PATH\" - <<'NODE'",
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const payload = {",
		"  kind: 'headless-host-oracle-remote-reboot-request',",
		"  ok: true,",
		"  remoteDir: process.env.REMOTE_DIR,",
		"  requestedAt: new Date().toISOString(),",
		"  sudoPath: process.env.SUDO_PATH,",
		"  systemctlPath: process.env.SYSTEMCTL_PATH",
		"};",
		"fs.writeFileSync(path.join(process.env.REMOTE_DIR, '11-reboot-request.json'), `${JSON.stringify(payload, null, 2)}\\n`);",
		"console.log(JSON.stringify(payload, null, 2));",
		"NODE",
		"nohup sh -c 'sleep 1; sudo -n systemctl reboot --no-wall' >/dev/null 2>&1 &",
	].join("\n");
}

function pushOptionalRunnerArgs(parts, raw, names) {
	for (const name of names) {
		if (raw[name] === undefined) continue;
		parts.push(`--${name}`, shellQuote(raw[name]));
	}
}

function runSsh({ name, command, extraArgs = [], target, remoteScript, completed, redactor, timeout = 120_000 }) {
	const args = [...extraArgs, target, remoteScript];
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout,
	});
	recordStep({
		name,
		command,
		args,
		displayArgs: [...extraArgs, target, `[remote-script:${name}]`],
		detail: {
			remoteScriptLines: remoteScript.split(/\r?\n/).length,
		},
		result,
		completed,
		redactor,
	});
}

function runScp({ name, command, extraArgs = [], source, destination, completed, redactor, recursive = false }) {
	const args = [...extraArgs, ...(recursive ? ["-r"] : []), source, destination];
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 300_000,
	});
	const displayArgs = name === "upload-enrollment-invite"
		? [...extraArgs, ...(recursive ? ["-r"] : []), "[invite-file]", destination]
		: args;
	recordStep({ name, command, args, displayArgs, result, completed, redactor });
}

async function waitForSsh({ command, extraArgs = [], target, raw, completed, redactor }) {
	const timeoutMs = parsePositiveInt(raw["wait-ssh-timeout-ms"], 300_000, "wait-ssh-timeout-ms");
	const intervalMs = parsePositiveInt(raw["wait-ssh-interval-ms"], 5_000, "wait-ssh-interval-ms");
	const connectTimeoutSec = parsePositiveInt(raw["wait-ssh-connect-timeout-sec"], 5, "wait-ssh-connect-timeout-sec");
	const startedAt = Date.now();
	let attempts = 0;
	let lastResult = null;
	const waitArgs = [
		...extraArgs,
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${connectTimeoutSec}`,
		target,
		"true",
	];
	while (Date.now() - startedAt <= timeoutMs) {
		attempts++;
		lastResult = spawnSync(command, waitArgs, {
			encoding: "utf8",
			timeout: Math.max(1_000, (connectTimeoutSec + 2) * 1_000),
		});
		if (lastResult.status === 0) {
			completed.push({
				name: "wait-for-ssh",
				command,
				args: redactArgs(waitArgs),
				attempts,
				elapsedMs: Date.now() - startedAt,
				status: lastResult.status,
				signal: lastResult.signal,
				stdout: trimOutput(redactor(lastResult.stdout ?? "")),
				stderr: trimOutput(redactor(lastResult.stderr ?? "")),
			});
			return;
		}
		await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
	}
	const step = {
		name: "wait-for-ssh",
		command,
		args: redactArgs(waitArgs),
		attempts,
		elapsedMs: Date.now() - startedAt,
		status: lastResult?.status ?? null,
		signal: lastResult?.signal ?? null,
		stdout: trimOutput(redactor(lastResult?.stdout ?? "")),
		stderr: trimOutput(redactor(lastResult?.stderr ?? "")),
		error: `SSH did not become ready within ${timeoutMs}ms`,
	};
	completed.push(step);
	console.error(JSON.stringify({
		kind: "headless-host-oracle-remote-rehearsal",
		ok: false,
		...failureContext,
		failedStep: "wait-for-ssh",
		step,
	}, null, 2));
	process.exit(1);
}

function recordStep({ name, command, args, displayArgs, detail, result, completed, redactor }) {
	const stdout = redactor(result.stdout ?? "");
	const stderr = redactor(result.stderr ?? "");
	const step = {
		name,
		command,
		args: redactArgs(displayArgs ?? args),
		...(detail ?? {}),
		status: result.status,
		signal: result.signal,
		stdout: trimOutput(stdout),
		stderr: trimOutput(stderr),
	};
	completed.push(step);
	if (result.status !== 0) {
		console.error(JSON.stringify({
			kind: "headless-host-oracle-remote-rehearsal",
			ok: false,
			...failureContext,
			failedStep: name,
			step,
			...bestEffortFailureEvidence(name),
		}, null, 2));
		process.exit(1);
	}
}

function bestEffortFailureEvidence(failedStep) {
	if (!failureEvidenceFetch || !failedStep.startsWith("remote-") || failedStep === "remote-preflight") return {};
	const { command, extraArgs = [], sshTarget, remoteDir, localLogDir, redactor } = failureEvidenceFetch;
	mkdirSync(localLogDir, { recursive: true });
	const args = [...extraArgs, "-r", remoteTarget(sshTarget, `${remoteDir}/.`), localLogDir];
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 300_000,
	});
	return {
		failureEvidenceFetch: {
			ok: result.status === 0,
			command,
			args: redactArgs(args),
			status: result.status,
			signal: result.signal,
			stdout: trimOutput(redactor(result.stdout ?? "")),
			stderr: trimOutput(redactor(result.stderr ?? "")),
			destination: localLogDir,
		},
	};
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--verify-fetched-logs") {
			out["verify-fetched-logs"] = "true";
			continue;
		}
		if (arg === "--skip-remote-preflight") {
			out["skip-remote-preflight"] = "true";
			continue;
		}
		if (arg === "--skip-local-prepare") {
			out["skip-local-prepare"] = "true";
			continue;
		}
		if (arg === "--wait-for-ssh") {
			out["wait-for-ssh"] = "true";
			continue;
		}
		if (arg === "--require-reboot-request" || arg === "--confirm-owner-approved") {
			out[arg.slice(2)] = "true";
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`unexpected positional argument: ${arg}`);
		}
		const withoutPrefix = arg.slice(2);
		const eq = withoutPrefix.indexOf("=");
		if (eq >= 0) {
			setArg(out, withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			throw new Error(`missing value for --${withoutPrefix}`);
		}
		setArg(out, withoutPrefix, next);
		i++;
	}
	return out;
}

function setArg(out, name, value) {
	if (name === "ssh-option") {
		out[name] = [...asArray(out[name]), value];
		return;
	}
	out[name] = value;
}

function buildSshArgs(raw) {
	const args = [];
	if (raw["identity-file"]) args.push("-i", resolve(raw["identity-file"]));
	if (raw["ssh-port"]) args.push("-p", normalizePort(raw["ssh-port"]));
	for (const option of asArray(raw["ssh-option"])) {
		args.push("-o", normalizeSshOption(option));
	}
	return args;
}

function resolveLocalHelper(name) {
	for (const candidate of [
		join("scripts", name),
		name,
		join(SCRIPT_DIR, name),
		join(SCRIPT_DIR, "scripts", name),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`required local helper not found: ${name}. Run from the repo root or from a release asset directory containing the Oracle helpers.`);
}

function buildScpArgs(raw) {
	const args = [];
	if (raw["identity-file"]) args.push("-i", resolve(raw["identity-file"]));
	if (raw["ssh-port"]) args.push("-P", normalizePort(raw["ssh-port"]));
	for (const option of asArray(raw["ssh-option"])) {
		args.push("-o", normalizeSshOption(option));
	}
	return args;
}

function asArray(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function normalizeSshOption(value) {
	assertSingleLineValue(value, "--ssh-option");
	if (value.length === 0) throw new Error("--ssh-option must not be empty.");
	return value;
}

function normalizePort(value) {
	if (!/^\d+$/.test(String(value))) throw new Error(`--ssh-port must be a numeric TCP port: ${value}`);
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`--ssh-port must be between 1 and 65535: ${value}`);
	}
	return String(port);
}

function parsePositiveInt(value, fallback, label) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer.`);
	}
	return parsed;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function remoteTarget(target, path) {
	assertSafeRemotePath(path, "remote path");
	return `${target}:${path}`;
}

function assertSafeRemotePath(path, label) {
	if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
		throw new Error(`${label} must be a non-empty single-line path.`);
	}
	if (!/^[A-Za-z0-9_@%+=:,./~-]+$/.test(path)) {
		throw new Error(`${label} contains unsupported shell characters: ${path}`);
	}
	if (path.split("/").some((part) => part === "..")) {
		throw new Error(`${label} must not contain .. path segments.`);
	}
}

function shellQuote(value) {
	assertSingleLineValue(value, "shell argument");
	return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, "'\\''")}'`;
}

function assertSingleLineValue(value, label) {
	if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
		throw new Error(`${label} must be a single-line string.`);
	}
}

function createRedactor(secrets) {
	const needles = secrets
		.flatMap((secret) => typeof secret === "string" ? [secret, secret.trim()] : [])
		.filter((secret) => secret.length >= 3);
	return (text) => {
		let out = text;
		for (const secret of needles) {
			out = out.split(secret).join("[redacted]");
		}
		return out;
	};
}

async function assertPrivateInputFile(path, label) {
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
		throw new Error(`${label} must be a regular 0600 file: ${path}`);
	}
}

function redactArgs(args) {
	const redacted = [];
	for (let index = 0; index < args.length; index++) {
		redacted.push(args[index]);
		if (args[index] === "--invite-file" && index + 1 < args.length) {
			redacted.push("[invite-file]");
			index++;
		}
	}
	return redacted;
}

function trimOutput(text) {
	const trimmed = text.trim();
	return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

function printUsage() {
	console.log(`Usage: node scripts/run-headless-host-oracle-remote-rehearsal.mjs [options]

Options:
  --phase <preflight|install|activate|update|reboot|post-reboot>
      Remote rehearsal phase. Defaults to install.
  --ssh-target <user@host>
      SSH target for the Oracle VM. Required.
  --identity-file <path>
      Optional SSH private key path. Passed to ssh/scp as -i.
  --ssh-port <port>
      Optional SSH port. Passed to ssh as -p and scp as -P.
  --ssh-option <name=value>
      Optional OpenSSH option passed to both ssh and scp as -o. May be repeated
      for options such as StrictHostKeyChecking=accept-new or
      UserKnownHostsFile=./oracle-known-hosts.
  --remote-dir <path>
      Remote rehearsal directory. Defaults to a timestamped directory under
      the remote user's home directory.
  --zip <path>
      Local Oracle bundle zip. Defaults to dist/kaos-headless-host-oracle.zip.
  --checksum <path>
      Local Oracle bundle checksum. Defaults to <zip>.sha256.
  --worker-host <url>
      KAOS Worker host. Required for install phase.
  --vault-id <id>
      KAOS vault id. Required for install phase.
  --device-name <name>
      Headless device name. Defaults to oracle-headless.
	--invite-file <path>
	  One-time 0600 Owner invitation for the first install. It is uploaded only
	  for enrollment and removed on the remote host immediately afterward.
	--device-identity-file <path>
	  Remote service identity path. Defaults to /var/lib/kaos-headless/device-identity.json.
	--confirm-owner-approved
	  Required for phase=activate after the Owner has compared and approved the
	  pending device fingerprint in the KAOS UI.
  --install-dir <path>
      Optional remote install directory forwarded to the VM runner.
      The post-reboot phase also uses <install-dir>/run-headless-host-oracle-rehearsal.mjs
      as its default installed runner.
  --installed-runner <path>
      Optional installed post-reboot runner path. Defaults to
      <install-dir>/run-headless-host-oracle-rehearsal.mjs.
  --service-path <path>
      Optional remote systemd service path forwarded to the VM runner.
  --metadata-path <path>
      Optional remote install metadata path forwarded during install/update.
  --postflight-smoke-work-dir <path>
      Optional remote postflight smoke work directory.
  --service <name>
      Optional systemd service name for post-reboot evidence capture.
  --journal-since <value>
      Optional journalctl --since value for post-reboot evidence capture.
  --smoke-work-dir <path>
      Optional standalone smoke work directory for post-reboot evidence.
  --fetch-log-dir <path>
      Fetch remote rehearsal evidence into this local directory after the phase.
  --evidence-dir <path>
      Fetch remote evidence into this local directory and run the phase-specific
      verifier automatically. install uses --mode install, update uses
      --mode update, and post-reboot uses full verification.
  --verify-fetched-logs
      After --fetch-log-dir, run the local rehearsal verifier against the
      fetched evidence. install uses --mode install, update uses --mode update,
      and post-reboot uses full verification.
  --skip-remote-preflight
      Skip automatic remote preflight before install/update. The standalone
      preflight phase is unaffected.
  --skip-local-prepare
      Skip the repo-local upload prepare gate. Use only when running from
      trusted release assets with explicit --zip and --checksum paths; the VM
      still verifies sha256 and the unpacked bundle before installing.
  --wait-for-ssh
      Before running the phase, poll ssh until the VM accepts a simple
      non-interactive command. Useful after reboot before post-reboot evidence.
  --require-reboot-request
      When verifying fetched post-reboot logs, require 11-reboot-request.json
      from a prior --phase reboot run.
  --wait-ssh-timeout-ms <ms>
      Total wait-for-ssh timeout. Defaults to 300000.
  --wait-ssh-interval-ms <ms>
      Delay between wait-for-ssh attempts. Defaults to 5000.
  --wait-ssh-connect-timeout-sec <seconds>
      OpenSSH ConnectTimeout used by wait-for-ssh attempts. Defaults to 5.
  --ssh <path>
      SSH executable. Defaults to ssh.
  --scp <path>
      SCP executable. Defaults to scp.
  --timeout <ms>
      Remote rehearsal command timeout. Defaults to 900000.
  --help, -h
      Print this help.

Typical flow:
  npm run run:headless-host-oracle-remote-rehearsal -- \\
    --phase preflight \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir kaos-headless-rehearsal-YYYYMMDDTHHMMSSZ

  npm run run:headless-host-oracle-remote-rehearsal -- \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir kaos-headless-rehearsal-YYYYMMDDTHHMMSSZ \\
    --worker-host https://YOUR_WORKER_HOST \\
    --vault-id YOUR_VAULT_ID \\
		--invite-file /secure/local/path/to/device-enroll.invite \\
    --evidence-dir ./oracle-install-logs

  ssh opc@YOUR_ORACLE_VM sudo reboot
  # Or keep the reboot request inside the structured remote rehearsal flow:
  npm run run:headless-host-oracle-remote-rehearsal -- \\
		--phase activate \\
		--confirm-owner-approved \\
		--ssh-target opc@YOUR_ORACLE_VM \\
		--remote-dir kaos-headless-rehearsal-YYYYMMDDTHHMMSSZ

	# Only after activation succeeds, request reboot and collect post-reboot evidence.
  npm run run:headless-host-oracle-remote-rehearsal -- \\
    --phase reboot \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir kaos-headless-rehearsal-YYYYMMDDTHHMMSSZ

  npm run run:headless-host-oracle-remote-rehearsal -- \\
    --phase update \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir kaos-headless-update-YYYYMMDDTHHMMSSZ \\
    --evidence-dir ./oracle-update-logs

  npm run run:headless-host-oracle-remote-rehearsal -- \\
    --phase post-reboot \\
    --ssh-target opc@YOUR_ORACLE_VM \\
    --remote-dir <directory printed by the install phase> \\
    --wait-for-ssh \\
    --require-reboot-request \\
    --evidence-dir ./oracle-rehearsal-logs
`);
}

main().catch((err) => {
	console.error(JSON.stringify({
		kind: "headless-host-oracle-remote-rehearsal",
		ok: false,
		...failureContext,
		failedStep: "fatal",
		error: err instanceof Error ? err.message : String(err),
	}, null, 2));
	process.exitCode = 1;
});
