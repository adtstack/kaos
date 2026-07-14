#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	buildHeadlessHost,
	buildProductPluginBundle,
	installVaultPlugin,
} from "./helpers/headless-host-vault-plugin.mjs";

const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const CI_TIMEOUT_SCALE = process.env.CI === "true" ? 2 : 1;

function e2eTimeout(ms) {
	return ms * CI_TIMEOUT_SCALE;
}

async function main() {
	assert.ok(existsSync(WRANGLER_BIN), "server/node_modules/.bin/wrangler is required");
	runBuild();
	await runNoR2GracefulSmoke();
	await runOperationalSmokeScript();

	const port = await getFreePort();
	const host = `http://127.0.0.1:${port}`;
	const vaultId = `kaos-headless-host-e2e-${Date.now().toString(36)}`;
	const root = mkdtempSync(join(tmpdir(), "kaos-headless-host-worker-"));
	const persistDir = join(root, "wrangler-state");
	const wranglerConfig = join(root, "wrangler-r2.toml");
	const vaultA = join(root, "vault-a");
	const vaultB = join(root, "vault-b");
	const dataA = join(root, "data-a.json");
	const dataB = join(root, "data-b.json");
	const envToken = randomBytes(32).toString("hex");
	const children = [];

	await mkdir(vaultA, { recursive: true });
	await mkdir(vaultB, { recursive: true });
	await installVaultPlugin(vaultA);
	await installVaultPlugin(vaultB);
	await writeWranglerR2Config(wranglerConfig);

	const wrangler = spawn(WRANGLER_BIN, [
		"dev",
		"--config",
		wranglerConfig,
		"--ip",
		"127.0.0.1",
		"--port",
		String(port),
		"--local-protocol",
		"http",
		"--persist-to",
		persistDir,
		"--log-level",
		"error",
	], {
		cwd: resolve("server"),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			SYNC_TOKEN: envToken,
		},
	});
	children.push(wrangler);
	const wranglerOutput = captureOutput(wrangler);

	let hostA = null;
	let hostB = null;
	try {
		await waitForWorker(host, wranglerOutput);
		const capabilities = await fetchCapabilities(host);
		assert.equal(capabilities.attachments, true, "R2-enabled wrangler config should advertise attachments");
		const token = await resolveAuthToken(host, envToken);
		await writeHeadlessData(dataA, {
			host,
			token,
			vaultId,
			deviceName: "headless-host-e2e-a",
		});
		await writeHeadlessData(dataB, {
			host,
			token,
			vaultId,
			deviceName: "headless-host-e2e-b",
		});

		console.log("\n--- headless host worker e2e: start two real plugin hosts ---");
		hostA = startHeadlessHost(vaultA, dataA);
		hostB = startHeadlessHost(vaultB, dataB);
		children.push(hostA.child, hostB.child);
		await Promise.all([
			hostA.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
			hostB.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
		]);
		console.log("  PASS  both headless hosts started");

		console.log("\n--- headless host worker e2e: A create materializes on B ---");
		await writeVaultFile(vaultA, "notes/shared.md", "hello from A\n");
		await waitForFileContent(vaultB, "notes/shared.md", "hello from A\n", e2eTimeout(30_000));
		console.log("  PASS  create synced A -> B");

		console.log("\n--- headless host worker e2e: B modify materializes on A ---");
		await writeVaultFile(vaultB, "notes/shared.md", "hello from B\nsecond line\n");
		await waitForFileContent(vaultA, "notes/shared.md", "hello from B\nsecond line\n", e2eTimeout(30_000));
		console.log("  PASS  modify synced B -> A");

		console.log("\n--- headless host worker e2e: B rename materializes on A ---");
		await rename(join(vaultB, "notes", "shared.md"), join(vaultB, "notes", "renamed.md"));
		await waitForFileContent(vaultA, "notes/renamed.md", "hello from B\nsecond line\n", e2eTimeout(30_000));
		await waitForMissing(vaultA, "notes/shared.md", e2eTimeout(30_000));
		console.log("  PASS  rename synced B -> A");

		console.log("\n--- headless host worker e2e: A delete removes clean copy on B ---");
		await rm(join(vaultA, "notes", "renamed.md"));
		await waitForMissing(vaultB, "notes/renamed.md", e2eTimeout(30_000));
		console.log("  PASS  delete synced A -> B");

		console.log("\n--- headless host worker e2e: restart keeps Markdown baseline usable ---");
		await writeVaultFile(vaultA, "notes/restart.md", "before restart\n");
		await waitForFileContent(vaultB, "notes/restart.md", "before restart\n", e2eTimeout(30_000));
		await stopChild(hostA.child);
		await stopChild(hostB.child);
		hostA = startHeadlessHost(vaultA, dataA);
		hostB = startHeadlessHost(vaultB, dataB);
		children.push(hostA.child, hostB.child);
		await Promise.all([
			hostA.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
			hostB.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
		]);
		await sleep(3_000);
		await writeVaultFile(vaultB, "notes/restart.md", "after restart\n");
		await waitForFileContent(vaultA, "notes/restart.md", "after restart\n", e2eTimeout(30_000));
		console.log("  PASS  restarted hosts continue syncing Markdown");

		console.log("\n--- headless host worker e2e: offline divergence creates conflict artifact ---");
		await writeVaultFile(vaultA, "notes/conflict.md", "conflict base\n");
		await waitForFileContent(vaultB, "notes/conflict.md", "conflict base\n", e2eTimeout(30_000));
		await sleep(2_000);
		await stopChild(hostB.child);
		await writeVaultFile(vaultA, "notes/conflict.md", "remote side\n");
		await sleep(2_000);
		await writeVaultFile(vaultB, "notes/conflict.md", "local side\n");
		hostB = startHeadlessHost(vaultB, dataB);
		children.push(hostB.child);
		await hostB.waitFor('"kind":"poller-started"', e2eTimeout(25_000));
		const conflictArtifact = await waitForConflictArtifact(vaultB, "notes/conflict.md", ["remote side\n", "local side\n"], e2eTimeout(45_000));
		assert.match(conflictArtifact.path, /notes\/conflict \(KAOS conflict/);
		console.log(`  PASS  conflict artifact created at ${conflictArtifact.path}`);

		console.log("\n--- headless host worker e2e: A attachment uploads to R2 and downloads on B ---");
		const aBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
		await writeVaultBinary(vaultA, "attachments/sample.bin", aBytes);
		await waitForBinaryContent(vaultB, "attachments/sample.bin", aBytes, e2eTimeout(45_000));
		console.log("  PASS  attachment upload/download synced A -> B");

		console.log("\n--- headless host worker e2e: B attachment modify downloads on A ---");
		const bBytes = Buffer.from([9, 8, 7, 6, 5, 4]);
		await writeVaultBinary(vaultB, "attachments/sample.bin", bBytes);
		await waitForBinaryContent(vaultA, "attachments/sample.bin", bBytes, e2eTimeout(45_000));
		console.log("  PASS  attachment modify synced B -> A");

		console.log("\n--- headless host worker e2e: A attachment delete removes clean copy on B ---");
		await rm(join(vaultA, "attachments", "sample.bin"));
		await waitForMissing(vaultB, "attachments/sample.bin", e2eTimeout(45_000));
		console.log("  PASS  attachment delete synced A -> B");
	} catch (err) {
		dumpChildOutput("wrangler", wranglerOutput);
		if (hostA) dumpChildOutput("headless A", hostA.output);
		if (hostB) dumpChildOutput("headless B", hostB.output);
		throw err;
	} finally {
		for (const child of children.slice().reverse()) {
			await stopChild(child);
		}
		rmSync(root, { recursive: true, force: true });
	}
}

async function runNoR2GracefulSmoke() {
	const port = await getFreePort();
	const host = `http://127.0.0.1:${port}`;
	const vaultId = `kaos-headless-host-no-r2-${Date.now().toString(36)}`;
	const root = mkdtempSync(join(tmpdir(), "kaos-headless-host-no-r2-"));
	const persistDir = join(root, "wrangler-state");
	const vaultA = join(root, "vault-a");
	const vaultB = join(root, "vault-b");
	const dataA = join(root, "data-a.json");
	const dataB = join(root, "data-b.json");
	const envToken = randomBytes(32).toString("hex");
	const children = [];

	await mkdir(vaultA, { recursive: true });
	await mkdir(vaultB, { recursive: true });
	await installVaultPlugin(vaultA);
	await installVaultPlugin(vaultB);
	const wrangler = spawn(WRANGLER_BIN, [
		"dev",
		"--ip",
		"127.0.0.1",
		"--port",
		String(port),
		"--local-protocol",
		"http",
		"--persist-to",
		persistDir,
		"--log-level",
		"error",
	], {
		cwd: resolve("server"),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			SYNC_TOKEN: envToken,
		},
	});
	children.push(wrangler);
	const wranglerOutput = captureOutput(wrangler);
	let hostA = null;
	let hostB = null;
	try {
		await waitForWorker(host, wranglerOutput);
		const capabilities = await fetchCapabilities(host);
		assert.equal(capabilities.attachments, false, "default wrangler config should not advertise attachments");
		const token = await resolveAuthToken(host, envToken);
		await writeHeadlessData(dataA, {
			host,
			token,
			vaultId,
			deviceName: "headless-host-no-r2-a",
			enableAttachmentSync: false,
		});
		await writeHeadlessData(dataB, {
			host,
			token,
			vaultId,
			deviceName: "headless-host-no-r2-b",
			enableAttachmentSync: false,
		});

		console.log("\n--- headless host worker e2e: no-R2 Worker still syncs Markdown ---");
		hostA = startHeadlessHost(vaultA, dataA);
		hostB = startHeadlessHost(vaultB, dataB);
		children.push(hostA.child, hostB.child);
		await Promise.all([
			hostA.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
			hostB.waitFor('"kind":"poller-started"', e2eTimeout(25_000)),
		]);
		await writeVaultFile(vaultA, "notes/no-r2.md", "markdown without R2\n");
		await waitForFileContent(vaultB, "notes/no-r2.md", "markdown without R2\n", e2eTimeout(30_000));
		console.log("  PASS  no-R2 graceful Markdown sync works with attachments disabled");
	} catch (err) {
		dumpChildOutput("no-R2 wrangler", wranglerOutput);
		if (hostA) dumpChildOutput("no-R2 headless A", hostA.output);
		if (hostB) dumpChildOutput("no-R2 headless B", hostB.output);
		throw err;
	} finally {
		for (const child of children.slice().reverse()) {
			await stopChild(child);
		}
		rmSync(root, { recursive: true, force: true });
	}
}

async function runOperationalSmokeScript() {
	const port = await getFreePort();
	const host = `http://127.0.0.1:${port}`;
	const vaultId = `kaos-headless-host-smoke-script-${Date.now().toString(36)}`;
	const root = mkdtempSync(join(tmpdir(), "kaos-headless-host-smoke-script-"));
	const persistDir = join(root, "wrangler-state");
	const primaryVault = join(root, "primary-vault");
	const primaryData = join(root, "primary-data.json");
	const tokenFile = join(root, "sync-token");
	const envFile = join(root, "headless.env");
	const envToken = randomBytes(32).toString("hex");
	const children = [];

	await mkdir(primaryVault, { recursive: true });
	await installVaultPlugin(primaryVault);
	await writeFile(tokenFile, envToken, "utf8");
	const wrangler = spawn(WRANGLER_BIN, [
		"dev",
		"--ip",
		"127.0.0.1",
		"--port",
		String(port),
		"--local-protocol",
		"http",
		"--persist-to",
		persistDir,
		"--log-level",
		"error",
	], {
		cwd: resolve("server"),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
			CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			SYNC_TOKEN: envToken,
		},
	});
	children.push(wrangler);
	const wranglerOutput = captureOutput(wrangler);
	let primary = null;
	try {
		await waitForWorker(host, wranglerOutput);
		const token = await resolveAuthToken(host, envToken);
		await writeFile(tokenFile, token, "utf8");
		await writeFile(envFile, `KAOS_HOST=${host}
KAOS_VAULT_ID=${vaultId}
KAOS_DEVICE_NAME=headless-host-smoke-script-primary
KAOS_ENABLE_ATTACHMENT_SYNC=false
`, "utf8");
		await writeHeadlessData(primaryData, {
			host,
			token,
			vaultId,
			deviceName: "headless-host-smoke-script-primary",
			enableAttachmentSync: false,
		});
		console.log("\n--- headless host worker e2e: operational smoke script checks running primary ---");
		primary = startHeadlessHost(primaryVault, primaryData);
		children.push(primary.child);
		await primary.waitFor('"kind":"poller-started"', e2eTimeout(25_000));
		const smoke = spawnSync(process.execPath, [
			"scripts/smoke-headless-host-sync.mjs",
			"--binary",
			"dist/kaos-headless-host.mjs",
			"--vault",
			primaryVault,
			"--data-file",
			primaryData,
			"--lock-file",
			`${primaryData}.lock`,
			"--env-file",
			envFile,
			"--token-file",
			tokenFile,
			"--timeout-ms",
			String(e2eTimeout(30_000)),
			"--require-lock",
		], {
			encoding: "utf8",
			env: withoutKaosEnv(process.env),
			timeout: e2eTimeout(60_000),
		});
		assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
		assert.equal(smoke.stdout.includes(token), false, "smoke output should not leak token material");
		const payload = JSON.parse(smoke.stdout);
		assert.equal(payload.kind, "headless-host-sync-smoke");
		assert.equal(payload.ok, true);
		assert.equal(payload.tokenConfigured, true);
		assert.equal(payload.cleanup.length, 4);
		assert.equal(payload.completedStages.includes("cleanup:remove-primary-prefix"), true);
		assert.equal(payload.completedStages.includes("cleanup:prune-primary-empty-parent"), true);
		assert.equal(existsSync(join(primaryVault, "KAOS smoke")), false, "smoke cleanup should not leave its default folder in the primary vault");
		console.log("  PASS  operational smoke script verified primary <-> peer Markdown sync");
	} catch (err) {
		dumpChildOutput("smoke-script wrangler", wranglerOutput);
		if (primary) dumpChildOutput("smoke-script primary", primary.output);
		throw err;
	} finally {
		for (const child of children.slice().reverse()) {
			await stopChild(child);
		}
		rmSync(root, { recursive: true, force: true });
	}
}

async function writeWranglerR2Config(path) {
	const main = resolve("server/src/index.ts").replace(/\\/g, "/");
	await writeFile(path, `name = "kaos-headless-host-e2e"
main = "${main}"
compatibility_date = "2026-03-02"

[limits]
cpu_ms = 300000
subrequests = 25000

[[durable_objects.bindings]]
name = "KAOS_SYNC"
class_name = "VaultSyncServer"

[[durable_objects.bindings]]
name = "KAOS_CONFIG"
class_name = "ServerConfig"

[[r2_buckets]]
binding = "KAOS_BUCKET"
bucket_name = "kaos-headless-host-e2e"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultSyncServer", "ServerConfig"]
`, "utf8");
}

function runBuild() {
	buildProductPluginBundle();
	buildHeadlessHost();
}

async function writeHeadlessData(path, { host, token, vaultId, deviceName, enableAttachmentSync = true }) {
	await writeFile(path, JSON.stringify({
		host,
		token,
		vaultId,
		deviceName,
		debug: false,
		enableAttachmentSync,
		attachmentSyncExplicitlyConfigured: true,
	}, null, 2), "utf8");
}

function startHeadlessHost(vaultRoot, dataFile) {
	const child = spawn(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
		"--poll-interval-ms",
		"250",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = captureOutput(child);
	return {
		child,
		output,
		waitFor: (needle, timeoutMs) => waitForOutput(child, output, needle, timeoutMs),
	};
}

function captureOutput(child) {
	const output = { stdout: "", stderr: "", exited: false, exitCode: null, signal: null };
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		output.stdout = trimOutput(output.stdout + chunk);
	});
	child.stderr?.on("data", (chunk) => {
		output.stderr = trimOutput(output.stderr + chunk);
	});
	child.once("exit", (code, signal) => {
		output.exited = true;
		output.exitCode = code;
		output.signal = signal;
	});
	return output;
}

function trimOutput(text) {
	return text.length > 20_000 ? text.slice(-20_000) : text;
}

async function waitForOutput(child, output, needle, timeoutMs) {
	await waitUntil(() => {
		if (output.stdout.includes(needle) || output.stderr.includes(needle)) return true;
		if (output.exited) {
			throw new Error(`process exited before output "${needle}" appeared`);
		}
		return false;
	}, timeoutMs);
}

async function waitForWorker(host, output) {
	await waitUntil(async () => {
		if (output.exited) throw new Error("wrangler exited before accepting requests");
		try {
			const res = await fetch(`${host}/api/capabilities`);
			return res.status > 0;
		} catch {
			return false;
		}
	}, e2eTimeout(20_000));
}

async function resolveAuthToken(host, defaultEnvToken) {
	const capabilities = await fetchCapabilities(host);
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	return await claimServer(host);
}

async function fetchCapabilities(host) {
	const capabilitiesRes = await fetch(`${host}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	return await capabilitiesRes.json();
}

async function claimServer(host) {
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${host}/claim`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ token }),
	});
	if (!res.ok) {
		throw new Error(`claim failed (${res.status}): ${await res.text()}`);
	}
	return token;
}

async function writeVaultFile(vaultRoot, path, content) {
	const abs = join(vaultRoot, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf8");
}

async function writeVaultBinary(vaultRoot, path, content) {
	const abs = join(vaultRoot, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content);
}

async function waitForFileContent(vaultRoot, path, expected, timeoutMs) {
	const abs = join(vaultRoot, path);
	await waitUntil(async () => {
		try {
			return await readFile(abs, "utf8") === expected;
		} catch {
			return false;
		}
	}, timeoutMs);
}

async function waitForBinaryContent(vaultRoot, path, expected, timeoutMs) {
	const abs = join(vaultRoot, path);
	await waitUntil(async () => {
		try {
			return (await readFile(abs)).equals(expected);
		} catch {
			return false;
		}
	}, timeoutMs);
}

async function waitForMissing(vaultRoot, path, timeoutMs) {
	const abs = join(vaultRoot, path);
	await waitUntil(async () => !existsSync(abs), timeoutMs);
}

async function waitForConflictArtifact(vaultRoot, originalPath, allowedContents, timeoutMs) {
	let latest = [];
	await waitUntil(async () => {
		latest = await findConflictArtifacts(vaultRoot, originalPath);
		for (const artifact of latest) {
			if (allowedContents.includes(artifact.content)) return true;
		}
		return false;
	}, timeoutMs);
	const match = latest.find((artifact) => allowedContents.includes(artifact.content));
	if (!match) throw new Error(`conflict artifact existed but content did not match expected variants: ${JSON.stringify(latest)}`);
	return match;
}

async function findConflictArtifacts(vaultRoot, originalPath) {
	const normalizedOriginal = originalPath.replace(/\\/g, "/");
	const slash = normalizedOriginal.lastIndexOf("/");
	const dir = slash >= 0 ? normalizedOriginal.slice(0, slash) : "";
	const name = slash >= 0 ? normalizedOriginal.slice(slash + 1) : normalizedOriginal;
	const base = name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
	const root = dir ? join(vaultRoot, dir) : vaultRoot;
	const out = [];
	async function walk(absDir, relDir) {
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(absDir, entry.name);
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(abs, rel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.startsWith(`${base} (KAOS conflict`) || !entry.name.endsWith(".md")) continue;
			out.push({
				path: dir ? `${dir}/${rel}` : rel,
				content: await readFile(abs, "utf8"),
			});
		}
	}
	await walk(root, "");
	return out.sort((a, b) => a.path.localeCompare(b.path));
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

function dumpChildOutput(label, output) {
	console.error(`\n[${label} stdout]`);
	console.error(output.stdout.trim() || "(empty)");
	console.error(`\n[${label} stderr]`);
	console.error(output.stderr.trim() || "(empty)");
}

function withoutKaosEnv(env) {
	const next = { ...env };
	delete next.KAOS_HOST;
	delete next.KAOS_VAULT_ID;
	delete next.KAOS_DEVICE_NAME;
	delete next.KAOS_SYNC_TOKEN;
	delete next.SYNC_TOKEN;
	return next;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
	return new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.on("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => rejectPromise(new Error("failed to allocate a port")));
				return;
			}
			const port = address.port;
			server.close(() => resolvePromise(port));
		});
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
