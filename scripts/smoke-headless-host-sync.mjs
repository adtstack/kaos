#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/**
 * The former smoke test started a second process with a copied shared secret.
 * That is deliberately no longer a valid deployment test: a second device must
 * be enrolled and explicitly approved by an Owner. This probe verifies that
 * the installed service identity can complete the real device-key challenge.
 */
async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") return printUsage();
	for (const legacy of ["token", "token-file", "token-stdin", "peer-token-file"]) {
		if (raw[legacy] !== undefined) throw new SmokeStepError("preflight:legacy-credential", `--${legacy} is no longer supported; use an approved device identity.`, { option: legacy });
	}
	if (hasLegacyEnvironment()) throw new SmokeStepError("preflight:legacy-credential", "Legacy shared credential environment variables are not permitted.", {});

	const binary = resolve(raw.binary ?? "/opt/kaos/kaos-headless-host.mjs");
	const nodeBin = raw.node ?? process.execPath;
	const vault = resolve(raw.vault ?? "/srv/kaos/vault");
	const dataFile = resolve(raw["data-file"] ?? "/var/lib/kaos-headless/data.json");
	const lockFile = resolve(raw["lock-file"] ?? "/run/kaos-headless/kaos.lock");
	const envFile = resolve(raw["env-file"] ?? "/etc/kaos/headless.env");
	const timeoutMs = positiveInt(raw["timeout-ms"], 60_000, "timeout-ms");
	const config = { ...await readEnvFile(envFile), ...await readJson(dataFile) };
	if (hasLegacyConfig(config)) throw new SmokeStepError("preflight:legacy-credential", "Legacy shared credential configuration was found. Remove it before deploying.", {});
	const host = first(raw.host, process.env.KAOS_HOST, config.KAOS_HOST, config.host);
	const vaultId = first(raw["vault-id"], process.env.KAOS_VAULT_ID, config.KAOS_VAULT_ID, config.vaultId);
	const deviceName = first(raw["device-name"], process.env.KAOS_DEVICE_NAME, config.KAOS_DEVICE_NAME, config.deviceName);
	const identityFile = first(raw["identity-file"], process.env.KAOS_IDENTITY_FILE, config.KAOS_IDENTITY_FILE, config.identityFile);
	if (!host || !vaultId || !deviceName || !identityFile) {
		throw new SmokeStepError("preflight:config", "Missing host, vault ID, device name, or protected device identity.", {
			host: Boolean(host), vaultId: Boolean(vaultId), deviceName: Boolean(deviceName), identityFile: Boolean(identityFile),
		});
	}
	await assertPath(binary, "headless binary");
	await assertPath(vault, "vault");
	await assertPath(dataFile, "data file");
	await assertPath(envFile, "environment file");
	if (raw["require-lock"] === "true") await assertLock(lockFile, { vault, dataFile });

	const verified = await run(nodeBin, ["--", binary, "device", "verify",
		"--host", host,
		"--vault-id", vaultId,
		"--device-name", deviceName,
		"--identity-file", resolve(identityFile),
		"--data-file", dataFile,
	], timeoutMs);
	const probe = parseJson(verified.stdout, "device verification output");
	if (probe.kind !== "device-verified" || typeof probe.deviceId !== "string" || (probe.role !== "owner" && probe.role !== "member")) {
		throw new SmokeStepError("device-verify", "Device verification returned an invalid result.", { stdout: trimOutput(verified.stdout), stderr: trimOutput(verified.stderr) });
	}

	console.log(JSON.stringify({
		kind: "headless-host-device-auth-smoke",
		ok: true,
		host,
		vaultId,
		deviceId: probe.deviceId,
		role: probe.role,
		identityFile: resolve(identityFile),
		lockChecked: raw["require-lock"] === "true",
		crossDeviceSync: "requires a separately enrolled and Owner-approved peer device",
	}, null, 2));
}

function parseArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") { out.help = "true"; continue; }
		if (arg === "--require-lock") { out["require-lock"] = "true"; continue; }
		if (!arg.startsWith("--")) throw new Error(`unexpected positional argument: ${arg}`);
		const keyValue = arg.slice(2);
		const equal = keyValue.indexOf("=");
		if (equal >= 0) { out[keyValue.slice(0, equal)] = keyValue.slice(equal + 1); continue; }
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`missing value for --${keyValue}`);
		out[keyValue] = value;
		index++;
	}
	return out;
}

async function readEnvFile(path) {
	try {
		const output = {};
		for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
			const equal = line.indexOf("=");
			if (equal <= 0 || line.trimStart().startsWith("#")) continue;
			output[line.slice(0, equal).trim()] = line.slice(equal + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
		}
		return output;
	} catch { return {}; }
}

async function readJson(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch { return {}; }
}

function hasLegacyEnvironment() {
	return configured(process.env.KAOS_SYNC_TOKEN) || configured(process.env.SYNC_TOKEN);
}

function hasLegacyConfig(config) {
	return configured(config.KAOS_SYNC_TOKEN) || configured(config.SYNC_TOKEN) || configured(config.token);
}

function configured(value) { return typeof value === "string" && value.trim().length > 0; }

function first(...values) {
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}

async function assertPath(path, label) {
	try { await stat(path); } catch { throw new SmokeStepError("preflight:path", `Missing ${label}: ${path}`, { path, label }); }
}

async function assertLock(path, expected) {
	if (!existsSync(path)) throw new SmokeStepError("preflight:lock", `Primary lock file is not present: ${path}`, { path });
	let lock;
	try { lock = JSON.parse(await readFile(path, "utf8")); } catch { throw new SmokeStepError("preflight:lock", `Primary lock file is not valid JSON: ${path}`, { path }); }
	if (!lock || lock.runtime !== "kaos-headless-host" || resolve(lock.vaultRoot ?? "") !== expected.vault || resolve(lock.dataFile ?? "") !== expected.dataFile) {
		throw new SmokeStepError("preflight:lock", "Primary lock does not describe this running headless host.", { path });
	}
}

function run(command, args, timeoutMs) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout = trimOutput(stdout + chunk); });
		child.stderr.on("data", (chunk) => { stderr = trimOutput(stderr + chunk); });
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new SmokeStepError("device-verify", `Device verification timed out after ${timeoutMs}ms.`, {})); }, timeoutMs);
		child.once("error", (error) => { clearTimeout(timer); reject(new SmokeStepError("device-verify", error.message, {})); });
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolveRun({ stdout, stderr });
			else reject(new SmokeStepError("device-verify", `Device verification failed (${signal ?? `exit ${code}`}).`, { stdout, stderr }));
		});
	});
}

function parseJson(text, label) {
	try { return JSON.parse(text); } catch { throw new SmokeStepError("device-verify", `Invalid ${label}.`, { stdout: trimOutput(text) }); }
}

function trimOutput(value) { return value.length > 8000 ? value.slice(-8000) : value; }
function positiveInt(value, fallback, name) {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name} must be a positive integer`);
	return number;
}

class SmokeStepError extends Error {
	constructor(stage, message, details) { super(message); this.stage = stage; this.details = details; }
}

function printUsage() {
	console.log(`Usage: node scripts/smoke-headless-host-sync.mjs [options]

Verifies that the installed headless device can complete a signed challenge.
It never accepts a shared credential or creates a copied peer identity.

Options:
  --binary <path>           Headless binary. Defaults to /opt/kaos/kaos-headless-host.mjs.
  --node <path>             Node.js binary. Defaults to the current Node.js.
  --vault <path>            Primary vault. Defaults to /srv/kaos/vault.
  --data-file <path>        Headless data.json. Defaults to /var/lib/kaos-headless/data.json.
  --lock-file <path>        Primary lock file. Defaults to /run/kaos-headless/kaos.lock.
  --env-file <path>         Environment file. Defaults to /etc/kaos/headless.env.
  --identity-file <path>    Protected service device identity. Normally read from config.
  --host <url>              Worker host override.
  --vault-id <id>           Vault ID override.
  --device-name <name>      Device name override.
  --require-lock            Require a matching running primary lock.
  --timeout-ms <ms>         Verification timeout. Defaults to 60000.
`);
}

main().catch((error) => {
	const details = error instanceof SmokeStepError ? { stage: error.stage, ...error.details } : {};
	console.error(JSON.stringify({ kind: "headless-host-device-auth-smoke", ok: false, error: error instanceof Error ? error.message : String(error), ...details }));
	process.exitCode = 1;
});
