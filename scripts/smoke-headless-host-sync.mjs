#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

async function main() {
	const raw = parseArgs(process.argv.slice(2));
	if (raw.help === "true") {
		printUsage();
		return;
	}

	const binary = resolve(raw.binary ?? "/opt/kaos/kaos-headless-host.mjs");
	const primaryVault = resolve(raw.vault ?? "/srv/kaos/vault");
	const primaryDataFile = resolve(raw["data-file"] ?? "/var/lib/kaos-headless/data.json");
	const primaryLockFile = resolve(raw["lock-file"] ?? "/run/kaos-headless/kaos.lock");
	const envFile = resolve(raw["env-file"] ?? "/etc/kaos/headless.env");
	const timeoutMs = parsePositiveInt(raw["timeout-ms"], 60_000, "timeout-ms");
	const pollIntervalMs = parsePositiveInt(raw["poll-interval-ms"], 500, "poll-interval-ms");
	const pollQuietMs = parseNonNegativeInt(raw["poll-quiet-ms"], 100, "poll-quiet-ms");
	const keepFiles = raw["keep-files"] === "true";
	const requireLock = raw["require-lock"] === "true";
	const pluginId = raw["plugin-id"] ?? process.env.KAOS_PLUGIN_ID ?? "kaos";
	const primaryPluginDir = resolve(raw["plugin-dir"] ?? process.env.KAOS_PLUGIN_DIR ?? join(primaryVault, ".obsidian", "plugins", pluginId));

	const envConfig = await readEnvFileIfExists(envFile);
	const dataConfig = await readJsonIfExists(primaryDataFile);
	const host = readFirst(raw.host, process.env.KAOS_HOST, envConfig.KAOS_HOST, asString(dataConfig.host));
	const vaultId = readFirst(raw["vault-id"], process.env.KAOS_VAULT_ID, envConfig.KAOS_VAULT_ID, asString(dataConfig.vaultId));
	const tokenFile = raw["token-file"] ? resolve(raw["token-file"]) : await defaultTokenFile();
	const token = readFirst(
		raw.token,
		process.env.KAOS_SYNC_TOKEN,
		process.env.SYNC_TOKEN,
		envConfig.KAOS_SYNC_TOKEN,
		envConfig.SYNC_TOKEN,
		tokenFile ? await readTokenFile(tokenFile) : undefined,
		asString(dataConfig.token),
	);
	if (!host) throw new SmokeStepError("preflight:config", "Missing KAOS host. Use --host, KAOS_HOST, --env-file, or a populated --data-file.", { key: "host" });
	if (!vaultId) throw new SmokeStepError("preflight:config", "Missing KAOS vault id. Use --vault-id, KAOS_VAULT_ID, --env-file, or a populated --data-file.", { key: "vaultId" });
	if (!token) throw new SmokeStepError("preflight:config", "Missing KAOS token. Use --token, --token-file, KAOS_SYNC_TOKEN/SYNC_TOKEN, or a populated --data-file.", { key: "token" });
	const primaryLock = requireLock ? await readPrimaryLock(primaryLockFile, { primaryVault, primaryDataFile }) : null;
	await assertPath(primaryVault, "primary vault");
	await assertPath(binary, "headless binary");

	const workDir = resolve(raw["work-dir"] ?? await mkdtemp(join(tmpdir(), "kaos-headless-smoke-")));
	const peerVault = join(workDir, "peer-vault");
	assertNoVaultOverlap(primaryVault, peerVault, { workDir });
	const peerDataFile = join(workDir, "peer-data.json");
	const peerLockFile = join(workDir, "peer.lock");
	const peerTokenFile = tokenFile ?? join(workDir, "peer-token");
	const peerPluginDir = join(peerVault, ".obsidian", "plugins", pluginId);
	const children = [];
	await mkdir(peerVault, { recursive: true });
	await installPeerPlugin(primaryPluginDir, peerPluginDir);
	if (!tokenFile) {
		await writeFile(peerTokenFile, token, "utf8");
		await chmod(peerTokenFile, 0o600);
	}
	const redactor = createRedactor([token]);

	const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
	const defaultSmokeParent = raw.prefix === undefined ? "KAOS smoke" : null;
	const prefix = normalizeVaultPath(raw.prefix ?? `${defaultSmokeParent}/${safeStamp}-${process.pid}`);
	const localToPeerPath = normalizeVaultPath(`${prefix}/oracle-to-peer.md`);
	const peerToLocalPath = normalizeVaultPath(`${prefix}/peer-to-oracle.md`);
	assertVaultRelativePath(localToPeerPath);
	assertVaultRelativePath(peerToLocalPath);
	const localContent = `KAOS headless smoke local-to-peer\n${safeStamp}\n`;
	const peerContent = `KAOS headless smoke peer-to-local\n${safeStamp}\n`;

	let peer = null;
	const completedStages = [];
	const failureContext = {
		kind: "headless-host-sync-smoke",
		ok: false,
		host,
		vaultId,
		tokenConfigured: true,
		primaryVault,
		primaryDataFile,
		primaryLockFile,
		primaryLock,
		pluginId,
		primaryPluginDir,
		peerPluginDir,
		peerVault,
		paths: {
			localToPeer: localToPeerPath,
			peerToLocal: peerToLocalPath,
		},
	};
	try {
		peer = await runSmokeStage("peer-start", completedStages, { peerVault, peerDataFile, peerLockFile }, async () => startPeerHost({
			binary,
			peerVault,
			peerDataFile,
			peerLockFile,
			peerTokenFile,
			host,
			vaultId,
			pluginId,
			peerPluginDir,
			pollIntervalMs,
			pollQuietMs,
		}));
		children.push(peer.child);
		await runSmokeStage("peer-ready", completedStages, { peerVault }, async () => waitForOutput(peer, '"kind":"poller-started"', timeoutMs));

		await runSmokeStage("oracle-to-peer:write-primary", completedStages, { path: localToPeerPath }, async () => writeVaultFile(primaryVault, localToPeerPath, localContent));
		await runSmokeStage("oracle-to-peer:wait-peer", completedStages, { path: localToPeerPath }, async () => waitForFileContent(peerVault, localToPeerPath, localContent, timeoutMs));

		await runSmokeStage("peer-to-oracle:write-peer", completedStages, { path: peerToLocalPath }, async () => writeVaultFile(peerVault, peerToLocalPath, peerContent));
		await runSmokeStage("peer-to-oracle:wait-primary", completedStages, { path: peerToLocalPath }, async () => waitForFileContent(primaryVault, peerToLocalPath, peerContent, timeoutMs));

		const cleanup = [];
		if (!keepFiles) {
			await runSmokeStage("cleanup:remove-primary", completedStages, { path: localToPeerPath }, async () => rmVaultPath(primaryVault, localToPeerPath));
			await runSmokeStage("cleanup:wait-peer-missing", completedStages, { path: localToPeerPath }, async () => waitForMissing(peerVault, localToPeerPath, timeoutMs));
			cleanup.push(localToPeerPath);
			await runSmokeStage("cleanup:remove-peer", completedStages, { path: peerToLocalPath }, async () => rmVaultPath(peerVault, peerToLocalPath));
			await runSmokeStage("cleanup:wait-primary-missing", completedStages, { path: peerToLocalPath }, async () => waitForMissing(primaryVault, peerToLocalPath, timeoutMs));
			cleanup.push(peerToLocalPath);
			await runSmokeStage("cleanup:remove-primary-prefix", completedStages, { path: prefix }, async () => rmVaultPath(primaryVault, prefix, { recursive: true }));
			await runSmokeStage("cleanup:remove-peer-prefix", completedStages, { path: prefix }, async () => rmVaultPath(peerVault, prefix, { recursive: true }));
			cleanup.push(prefix);
			if (defaultSmokeParent) {
				await runSmokeStage("cleanup:prune-primary-empty-parent", completedStages, { path: defaultSmokeParent }, async () => rmEmptyVaultDir(primaryVault, defaultSmokeParent));
				await runSmokeStage("cleanup:prune-peer-empty-parent", completedStages, { path: defaultSmokeParent }, async () => rmEmptyVaultDir(peerVault, defaultSmokeParent));
				cleanup.push(defaultSmokeParent);
			}
		}

		console.log(JSON.stringify(redactObject({
			...failureContext,
			ok: true,
			completedStages,
			cleanup,
		}, redactor), null, 2));
	} catch (err) {
		const failure = describeSmokeFailure(err, peer, redactor);
		console.error(JSON.stringify(redactObject({
			...failureContext,
			ok: false,
			completedStages,
			failedStage: failure.stage,
			error: failure.message,
			failure,
		}, redactor), null, 2));
		process.exitCode = 1;
	} finally {
		for (const child of children.slice().reverse()) {
			await stopChild(child);
		}
		if (raw["work-dir"] === undefined) {
			await rm(workDir, { recursive: true, force: true });
		}
	}
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg === "--keep-files") {
			out["keep-files"] = "true";
			continue;
		}
		if (arg === "--require-lock") {
			out["require-lock"] = "true";
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

async function installPeerPlugin(primaryPluginDir, peerPluginDir) {
	await assertPath(primaryPluginDir, "primary plugin directory");
	await assertPath(join(primaryPluginDir, "manifest.json"), "primary plugin manifest");
	await assertPath(join(primaryPluginDir, "main.js"), "primary plugin main.js");
	await mkdir(peerPluginDir, { recursive: true });
	for (const file of ["manifest.json", "main.js", "telemetry.js", "styles.css"]) {
		const source = join(primaryPluginDir, file);
		if (!existsSync(source)) continue;
		await copyFile(source, join(peerPluginDir, file));
	}
}

function startPeerHost({ binary, peerVault, peerDataFile, peerLockFile, peerTokenFile, host, vaultId, pluginId, peerPluginDir, pollIntervalMs, pollQuietMs }) {
	const child = spawn(process.execPath, [
		"--",
		binary,
		"--vault",
		peerVault,
		"--data-file",
		peerDataFile,
		"--lock-file",
		peerLockFile,
		"--plugin-id",
		pluginId,
		"--plugin-dir",
		peerPluginDir,
		"--host",
		host,
		"--vault-id",
		vaultId,
		"--device-name",
		"headless-smoke-peer",
		"--token-file",
		peerTokenFile,
		"--disable-attachments",
		"--poll-interval-ms",
		String(pollIntervalMs),
		"--poll-quiet-ms",
		String(pollQuietMs),
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = { stdout: "", stderr: "", exited: false, exitCode: null, signal: null };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output.stdout = trimOutput(output.stdout + chunk); });
	child.stderr.on("data", (chunk) => { output.stderr = trimOutput(output.stderr + chunk); });
	child.once("exit", (code, signal) => {
		output.exited = true;
		output.exitCode = code;
		output.signal = signal;
	});
	return { child, output };
}

async function readEnvFileIfExists(path) {
	try {
		const text = await readFile(path, "utf8");
		const out = {};
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			const key = trimmed.slice(0, eq).trim();
			let value = trimmed.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

async function readJsonIfExists(path) {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		return typeof value === "object" && value !== null ? value : {};
	} catch {
		return {};
	}
}

async function defaultTokenFile() {
	return existsSync("/etc/kaos/sync-token") ? "/etc/kaos/sync-token" : undefined;
}

async function readTokenFile(path) {
	try {
		const token = (await readFile(path, "utf8")).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

function readFirst(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function asString(value) {
	return typeof value === "string" ? value : undefined;
}

async function readPrimaryLock(path, { primaryVault, primaryDataFile }) {
	if (!existsSync(path)) {
		throw new SmokeStepError("preflight:lock", `primary lock file is not present: ${path}`, { path });
	}
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		throw new SmokeStepError("preflight:lock", `primary lock file is not readable JSON: ${path}`, {
			path,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	const info = summarizeLockInfo(path, parsed);
	const mismatches = [];
	if (info.runtime !== "kaos-headless-host") {
		mismatches.push({ field: "runtime", expected: "kaos-headless-host", actual: info.runtime });
	}
	if (info.vaultRoot && resolve(info.vaultRoot) !== primaryVault) {
		mismatches.push({ field: "vaultRoot", expected: primaryVault, actual: info.vaultRoot });
	}
	if (info.dataFile && resolve(info.dataFile) !== primaryDataFile) {
		mismatches.push({ field: "dataFile", expected: primaryDataFile, actual: info.dataFile });
	}
	if (info.processAlive === false) {
		mismatches.push({ field: "processAlive", expected: true, actual: false });
	}
	if (mismatches.length > 0) {
		throw new SmokeStepError("preflight:lock", `primary lock file does not describe a running matching headless host: ${path}`, {
			path,
			lock: info,
			mismatches,
		});
	}
	return info;
}

function summarizeLockInfo(path, data) {
	const pid = readPositiveInteger(data?.pid);
	return {
		path,
		held: true,
		runtime: asString(data?.runtime) ?? null,
		pid,
		hostname: asString(data?.hostname) ?? null,
		startedAt: asString(data?.startedAt) ?? null,
		vaultRoot: asString(data?.vaultRoot) ?? null,
		dataFile: asString(data?.dataFile) ?? null,
		processAlive: checkProcessAlive(pid),
	};
}

function readPositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function checkProcessAlive(pid) {
	if (pid === null) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (err?.code === "ESRCH") return false;
		if (err?.code === "EPERM") return true;
		return null;
	}
}

async function assertPath(path, label) {
	if (!existsSync(path)) throw new SmokeStepError("preflight:path", `${label} does not exist: ${path}`, { label, path });
}

function normalizeVaultPath(path) {
	return path
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/$/, "");
}

async function writeVaultFile(vaultRoot, path, content) {
	const abs = vaultAbsPath(vaultRoot, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf8");
}

async function rmVaultPath(vaultRoot, path, { recursive = false } = {}) {
	const abs = vaultAbsPath(vaultRoot, path);
	await rm(abs, { force: true, recursive });
}

async function rmEmptyVaultDir(vaultRoot, path) {
	const abs = vaultAbsPath(vaultRoot, path);
	try {
		await rmdir(abs);
	} catch (err) {
		if (err && typeof err === "object" && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) {
			return;
		}
		throw err;
	}
}

async function waitForFileContent(vaultRoot, path, expected, timeoutMs) {
	const abs = vaultAbsPath(vaultRoot, path);
	await waitUntil(async () => {
		try {
			return await readFile(abs, "utf8") === expected;
		} catch {
			return false;
		}
	}, timeoutMs);
}

async function waitForMissing(vaultRoot, path, timeoutMs) {
	const abs = vaultAbsPath(vaultRoot, path);
	await waitUntil(() => !existsSync(abs), timeoutMs);
}

function vaultAbsPath(vaultRoot, path) {
	const normalized = normalizeVaultPath(path);
	assertVaultRelativePath(normalized);
	return join(vaultRoot, ...normalized.split("/"));
}

function assertVaultRelativePath(path) {
	const normalized = normalizeVaultPath(path);
	const segments = normalized.split("/");
	if (!normalized || segments.some((segment) => segment === "." || segment === "..")) {
		throw new SmokeStepError("preflight:path", `smoke path must stay inside the vault: ${path}`, { path });
	}
}

function assertNoVaultOverlap(primaryVault, peerVault, { workDir }) {
	if (!pathsOverlap(primaryVault, peerVault)) return;
	throw new SmokeStepError("preflight:path", "smoke peer vault must not overlap the primary vault", {
		primaryVault,
		peerVault,
		workDir,
	});
}

function pathsOverlap(a, b) {
	return pathCovers(a, b) || pathCovers(b, a);
}

function pathCovers(parent, child) {
	const resolvedParent = resolve(parent);
	const resolvedChild = resolve(child);
	return resolvedParent === resolvedChild || resolvedChild.startsWith(`${resolvedParent}/`);
}

async function waitForOutput(peer, needle, timeoutMs) {
	await waitUntil(() => {
		if (peer.output.stdout.includes(needle) || peer.output.stderr.includes(needle)) return true;
		if (peer.output.exited) {
			throw new Error(`peer exited before output "${needle}" appeared`);
		}
		return false;
	}, timeoutMs);
}

async function waitUntil(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
		} catch (err) {
			lastError = err;
			break;
		}
		await sleep(100);
	}
	if (lastError) throw lastError;
	throw new Error(`timed out after ${timeoutMs}ms`);
}

async function runSmokeStage(stage, completedStages, detail, fn) {
	try {
		const value = await fn();
		completedStages.push(stage);
		return value;
	} catch (err) {
		throw new SmokeStepError(stage, err instanceof Error ? err.message : String(err), detail);
	}
}

class SmokeStepError extends Error {
	constructor(stage, message, detail = null) {
		super(message);
		this.stage = stage;
		this.detail = detail;
	}
}

function describeSmokeFailure(err, peer, redactor = redactNoop) {
	if (err instanceof SmokeStepError) {
		return {
			stage: err.stage,
			message: redactor(err.message),
			detail: redactObject(err.detail, redactor),
			peer: peer ? summarizePeer(peer, redactor) : null,
		};
	}
	return {
		stage: "smoke",
		message: redactor(err instanceof Error ? err.message : String(err)),
		detail: null,
		peer: peer ? summarizePeer(peer, redactor) : null,
	};
}

function summarizePeer(peer, redactor = redactNoop) {
	return {
		exited: peer.output.exited,
		exitCode: peer.output.exitCode,
		signal: peer.output.signal,
		stdout: redactor(peer.output.stdout.trim()),
		stderr: redactor(peer.output.stderr.trim()),
	};
}

function createRedactor(secrets) {
	const values = [...new Set(secrets.filter((value) => typeof value === "string" && value.length > 0))];
	if (values.length === 0) return redactNoop;
	return (text) => values.reduce((out, secret) => out.split(secret).join("[redacted]"), String(text));
}

function redactNoop(text) {
	return String(text);
}

function redactObject(value, redactor) {
	if (typeof value === "string") return redactor(value);
	if (Array.isArray(value)) return value.map((item) => redactObject(item, redactor));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item, redactor)]));
	}
	return value;
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.killed) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		sleep(3_000).then(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}),
	]);
}

function trimOutput(text) {
	return text.length > 20_000 ? text.slice(-20_000) : text;
}

function parsePositiveInt(value, fallback, label) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer`);
	}
	return parsed;
}

function parseNonNegativeInt(value, fallback, label) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`--${label} must be a non-negative integer`);
	}
	return parsed;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
	console.log(`Usage: node scripts/smoke-headless-host-sync.mjs [options]

Options:
  --binary <path>           Installed headless host binary. Defaults to /opt/kaos/kaos-headless-host.mjs.
  --vault <path>            Primary Oracle/headless vault. Defaults to /srv/kaos/vault.
  --data-file <path>        Primary headless data.json. Defaults to /var/lib/kaos-headless/data.json.
  --lock-file <path>        Primary lock file. Defaults to /run/kaos-headless/kaos.lock.
  --env-file <path>         Environment file with KAOS_HOST, KAOS_VAULT_ID, and optional sync token.
                            Defaults to /etc/kaos/headless.env.
  --host <url>              KAOS Worker host. Overrides env/data config.
  --vault-id <id>           KAOS vault id. Overrides env/data config.
  --token-file <path>       KAOS token file. Defaults to /etc/kaos/sync-token when present.
  --token <token>           KAOS token fallback. Prefer --token-file in production.
  --plugin-id <id>          Vault plugin id/directory name. Defaults to kaos.
  --plugin-dir <path>       Primary vault plugin directory copied into the smoke peer.
  --prefix <path>           Smoke path prefix inside the vault. Defaults to KAOS smoke/<timestamp>.
  --work-dir <path>         Peer runtime workspace. Defaults to a temp directory.
  --timeout-ms <ms>         Per-step wait timeout. Defaults to 60000.
  --poll-interval-ms <ms>   Peer host poll interval. Defaults to 500.
  --poll-quiet-ms <ms>      Peer host quiet window. Defaults to 100.
  --require-lock            Fail unless the primary service lock file exists.
  --keep-files              Leave smoke files in the vault for inspection.
  --help, -h                Print this help.
`);
}

main().catch((err) => {
	const failure = describeSmokeFailure(err, null);
	console.error(JSON.stringify({
		kind: "headless-host-sync-smoke",
		ok: false,
		failedStage: failure.stage,
		error: failure.message,
		failure,
	}, null, 2));
	process.exitCode = 1;
});
