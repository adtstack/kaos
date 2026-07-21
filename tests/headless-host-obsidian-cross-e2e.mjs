#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import rawCdpModule from "../qa/controllers/obsidian-client-raw-cdp.ts";
import {
	buildHeadlessHost,
	buildProductPluginBundle,
	installVaultPlugin,
} from "./helpers/headless-host-vault-plugin.mjs";

const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const { RawCdpObsidianClient } = rawCdpModule;

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	assert.ok(existsSync(WRANGLER_BIN), "server/node_modules/.bin/wrangler is required");
	runBuild();

	const cdpPort = parsePositiveInt(args["obsidian-port"], 9222, "obsidian-port");
	const cdpHost = args["obsidian-host"] ?? "localhost";
	const root = mkdtempSync(join(tmpdir(), "kaos-headless-obsidian-cross-"));
	const persistDir = join(root, "wrangler-state");
	const wranglerConfig = join(root, "wrangler-r2.toml");
	const headlessVault = resolve(args["headless-vault"] ?? join(root, "headless-vault"));
	const headlessData = join(root, "headless-data.json");
	const vaultId = args["vault-id"] ?? `kaos-headless-obsidian-cross-${Date.now().toString(36)}`;
	const testPrefix = normalizeTestPrefix(
		args["path-prefix"] ?? `Cross/${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
	);
	const mdSourcePath = `${testPrefix}/obsidian-to-headless.md`;
	const mdRenamedPath = `${testPrefix}/renamed-by-obsidian.md`;
	const restartPath = `${testPrefix}/after-headless-restart.md`;
	const conflictPath = `${testPrefix}/cross-conflict.md`;
	const attachmentPath = `${testPrefix}/attachments/from-obsidian.bin`;
	const useExternalWorker = typeof args.host === "string";
	if (useExternalWorker && !args.token) {
		throw new Error("--token is required when --host points at an existing Worker");
	}
	let token = args.token ?? randomBytes(32).toString("hex");
	const port = await getFreePort();
	const host = useExternalWorker ? args.host : `http://127.0.0.1:${port}`;
	const children = [];
	const keepTemp = args["keep-temp"] === "true";

	await mkdir(headlessVault, { recursive: true });
	await installVaultPlugin(headlessVault);
	let wranglerOutput = { stdout: "", stderr: "", exited: false, exitCode: null, signal: null };
	if (!useExternalWorker) {
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
				SYNC_TOKEN: token,
			},
		});
		children.push(wrangler);
		wranglerOutput = captureOutput(wrangler);
	}

	let headless = null;
	const obsidian = new RawCdpObsidianClient({ host: cdpHost, port: cdpPort, connectTimeoutMs: 15_000 });
	try {
		await waitForWorker(host, wranglerOutput);
		const capabilities = await fetchCapabilities(host);
		assert.equal(capabilities.attachments, true, "R2-enabled wrangler config should advertise attachments");
		if (!useExternalWorker) {
			token = await resolveAuthToken(host, token, process.env.KAOS_CLAIM_SECRET, vaultId);
		}

		console.log("\n--- headless x Obsidian e2e: connect to running Obsidian QA vault ---");
		await obsidian.connect();
		await obsidian.waitForQaReady(30_000);
		await configureObsidianKaos(obsidian, {
			host,
			token,
			vaultId,
			deviceName: args["obsidian-device-name"] ?? "obsidian-cross-device",
		});
		await waitForObsidianIdle(obsidian, 45_000);
		console.log("  PASS  Obsidian QA APIs ready and KAOS configured");

		await writeHeadlessData(headlessData, {
			host,
			token,
			vaultId,
			deviceName: args["headless-device-name"] ?? "headless-cross-device",
			enableAttachmentSync: true,
		});
		headless = startHeadlessHost(headlessVault, headlessData);
		children.push(headless.child);
		await headless.waitFor('"kind":"poller-started"', 25_000);
		console.log("  PASS  headless host started");

		console.log("\n--- headless x Obsidian e2e: Obsidian Markdown create reaches headless ---");
		await obsidianCreateFile(obsidian, mdSourcePath, "from Obsidian\n");
		await waitForFileContent(headlessVault, mdSourcePath, "from Obsidian\n", 45_000);
		console.log("  PASS  Markdown create synced Obsidian -> headless");

		console.log("\n--- headless x Obsidian e2e: headless Markdown modify reaches Obsidian ---");
		await writeVaultFile(headlessVault, mdSourcePath, "from headless\nsecond line\n");
		await waitForObsidianFileContent(obsidian, mdSourcePath, "from headless\nsecond line\n", 45_000);
		console.log("  PASS  Markdown modify synced headless -> Obsidian");

		console.log("\n--- headless x Obsidian e2e: Obsidian rename reaches headless ---");
		await obsidianRenameFile(obsidian, mdSourcePath, mdRenamedPath);
		await waitForFileContent(headlessVault, mdRenamedPath, "from headless\nsecond line\n", 45_000);
		await waitForMissing(headlessVault, mdSourcePath, 45_000);
		console.log("  PASS  rename synced Obsidian -> headless");

		console.log("\n--- headless x Obsidian e2e: headless clean delete reaches Obsidian ---");
		await sleep(2_000);
		await rm(join(headlessVault, ...mdRenamedPath.split("/")));
		await waitForObsidianMissing(obsidian, mdRenamedPath, 45_000);
		console.log("  PASS  clean delete synced headless -> Obsidian");

		console.log("\n--- headless x Obsidian e2e: Obsidian attachment create reaches headless ---");
		const obsBytes = Buffer.from([1, 3, 5, 7, 9, 11]);
		await obsidianCreateBinary(obsidian, attachmentPath, obsBytes);
		await waitForBinaryContent(headlessVault, attachmentPath, obsBytes, 60_000);
		console.log("  PASS  attachment create synced Obsidian -> headless");

		console.log("\n--- headless x Obsidian e2e: headless attachment modify reaches Obsidian ---");
		const headlessBytes = Buffer.from([2, 4, 6, 8, 10, 12, 14]);
		await writeVaultBinary(headlessVault, attachmentPath, headlessBytes);
		await waitForObsidianBinaryContent(obsidian, attachmentPath, headlessBytes, 60_000);
		console.log("  PASS  attachment modify synced headless -> Obsidian");

		console.log("\n--- headless x Obsidian e2e: restart keeps cross-device baseline usable ---");
		await stopChild(headless.child);
		headless = startHeadlessHost(headlessVault, headlessData);
		children.push(headless.child);
		await headless.waitFor('"kind":"poller-started"', 25_000);
		await sleep(3_000);
		await obsidianCreateFile(obsidian, restartPath, "after restart\n");
		await waitForFileContent(headlessVault, restartPath, "after restart\n", 45_000);
		console.log("  PASS  restarted headless host still syncs with Obsidian");

		console.log("\n--- headless x Obsidian e2e: offline divergence creates conflict artifact ---");
		await obsidianCreateFile(obsidian, conflictPath, "base\n");
		await waitForFileContent(headlessVault, conflictPath, "base\n", 45_000);
		await sleep(2_000);
		await stopChild(headless.child);
		await obsidianCreateFile(obsidian, conflictPath, "remote Obsidian side\n");
		await waitForObsidianIdle(obsidian, 20_000);
		await sleep(2_000);
		await writeVaultFile(headlessVault, conflictPath, "local headless side\n");
		headless = startHeadlessHost(headlessVault, headlessData);
		children.push(headless.child);
		await headless.waitFor('"kind":"poller-started"', 25_000);
		const conflictArtifact = await waitForConflictArtifact(
			headlessVault,
			conflictPath,
			["remote Obsidian side\n", "local headless side\n"],
			60_000,
		);
		assert.ok(
			conflictArtifact.path.startsWith(`${testPrefix}/cross-conflict (KAOS conflict`),
			`unexpected conflict artifact path: ${conflictArtifact.path}`,
		);
		console.log(`  PASS  cross conflict artifact created at ${conflictArtifact.path}`);
	} catch (err) {
		dumpChildOutput("wrangler", wranglerOutput);
		if (headless) dumpChildOutput("headless", headless.output);
		await dumpObsidianDebugSnapshot(obsidian);
		throw err;
	} finally {
		await obsidian.close().catch(() => undefined);
		for (const child of children.slice().reverse()) {
			await stopChild(child);
		}
		if (keepTemp) {
			console.log(`\nKept temp root: ${root}`);
		} else {
			rmSync(root, { recursive: true, force: true });
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
		if (arg === "--keep-temp") {
			out["keep-temp"] = "true";
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected positional argument: ${arg}`);
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) throw new Error(`missing value for --${key}`);
		out[key] = next;
		i++;
	}
	return out;
}

function normalizeTestPrefix(value) {
	const normalized = String(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) throw new Error("--path-prefix must not be empty");
	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`--path-prefix must be a safe vault-relative path: ${value}`);
	}
	return normalized;
}

function printUsage() {
	console.log(`Usage: node --import jiti/register tests/headless-host-obsidian-cross-e2e.mjs [options]

Requires a running Obsidian QA vault with KAOS and kaos-qa-harness enabled:
  Obsidian --remote-debugging-port=9222

Options:
  --obsidian-port <port>         CDP port. Defaults to 9222.
  --obsidian-host <host>         CDP host. Defaults to localhost.
  --headless-vault <path>        Headless replica vault. Defaults to a temp dir.
  --host <url>                   Existing Worker host. Defaults to local wrangler dev.
  --token <token>                Worker token. Defaults to a random env token.
  --vault-id <id>                Sync vault id. Defaults to a random id.
  --path-prefix <path>           Test file prefix. Defaults to a unique Cross/... prefix.
  --obsidian-device-name <name>  Defaults to obsidian-cross-device.
  --headless-device-name <name>  Defaults to headless-cross-device.
  --keep-temp                    Keep temp wrangler/headless state after the run.
`);
}

async function configureObsidianKaos(client, { host, token, vaultId, deviceName }) {
	return await client.evalRaw(`
		(async () => {
			const plugin = app.plugins?.plugins?.kaos;
			if (!plugin) throw new Error("KAOS plugin is not loaded in Obsidian");
			if (typeof plugin.updateSettings !== "function") {
				throw new Error("KAOS plugin does not expose updateSettings()");
			}
			const normalizedHost = ${JSON.stringify(host)}.replace(/\\/$/, "");
			const current = plugin.settings ?? {};
			const activeRuntime = !!plugin.vaultSync;
			const matches =
				(current.host ?? "").replace(/\\/$/, "") === normalizedHost &&
				current.token === ${JSON.stringify(token)} &&
				current.vaultId === ${JSON.stringify(vaultId)};
			if (activeRuntime) {
				if (typeof plugin.teardownSync !== "function") {
					throw new Error(
						"Obsidian KAOS already has an active sync runtime, but teardownSync() is unavailable. " +
						"Use a clean prepared QA vault or restart Obsidian."
					);
				}
				await plugin.teardownSync();
			}
			await plugin.updateSettings((settings) => {
				settings.host = normalizedHost;
				settings.token = ${JSON.stringify(token)};
				settings.vaultId = ${JSON.stringify(vaultId)};
				settings.deviceName = ${JSON.stringify(deviceName)};
				settings.enableAttachmentSync = true;
				settings.attachmentSyncExplicitlyConfigured = true;
				settings.qaDebugMode = true;
			}, "headless-cross-e2e");
			await plugin.refreshServerCapabilities?.("headless-cross-e2e");
			if (!plugin.vaultSync && typeof plugin.initSync === "function") {
				await plugin.initSync();
			}
			return {
				host: plugin.settings?.host ?? "",
				vaultId: plugin.settings?.vaultId ?? "",
				deviceName: plugin.settings?.deviceName ?? "",
				hadMatchingRuntime: activeRuntime && matches,
				hasSyncRuntime: !!plugin.vaultSync,
			};
		})()
	`);
}

async function resolveAuthToken(host, defaultEnvToken, claimSecret, vaultId) {
	const capabilities = await fetchCapabilities(host);
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	if (typeof claimSecret !== "string" || claimSecret.length < 32) {
		throw new Error("KAOS_CLAIM_SECRET is required to claim an unclaimed test Worker");
	}
	return await claimServer(host, claimSecret, vaultId);
}

async function claimServer(host, claimSecret, vaultId) {
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${host}/claim`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Origin": host,
			"X-KAOS-Claim-Proof": claimSecret,
		},
		body: JSON.stringify({ token, vaultId }),
	});
	if (!res.ok) {
		throw new Error(`claim failed (${res.status}): ${await res.text()}`);
	}
	return token;
}

async function obsidianCreateFile(client, path, content) {
	await client.evalRaw(`
		(async () => {
			await window.__KAOS_QA__.createFile(${JSON.stringify(path)}, ${JSON.stringify(content)});
			await window.__KAOS_QA__.waitForIdle(30000);
		})()
	`);
}

async function obsidianRenameFile(client, oldPath, newPath) {
	await client.evalRaw(`
		(async () => {
			await window.__KAOS_QA__.renameFile(${JSON.stringify(oldPath)}, ${JSON.stringify(newPath)});
			await window.__KAOS_QA__.waitForIdle(30000);
		})()
	`);
}

async function obsidianCreateBinary(client, path, bytes) {
	await client.evalRaw(`
		(async () => {
			const path = ${JSON.stringify(path)};
			const bytes = Uint8Array.from(${JSON.stringify([...bytes])});
			const existing = app.vault.getFileByPath(path);
			if (existing) {
				await app.vault.modifyBinary(existing, bytes.buffer);
			} else {
				const slash = path.lastIndexOf("/");
				if (slash > 0) {
					const parts = path.slice(0, slash).split("/");
					let cur = "";
					for (const part of parts) {
						cur = cur ? cur + "/" + part : part;
						if (!app.vault.getAbstractFileByPath(cur)) {
							await app.vault.createFolder(cur).catch(() => {});
						}
					}
				}
				await app.vault.createBinary(path, bytes.buffer);
			}
			await window.__KAOS_QA__.waitForIdle(30000);
		})()
	`);
}

async function waitForObsidianIdle(client, timeoutMs) {
	try {
		await client.evalRaw(`window.__KAOS_QA__.waitForIdle(${timeoutMs})`);
	} catch (err) {
		const snapshot = await readObsidianDebugSnapshot(client).catch((snapshotErr) => ({
			error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
		}));
		throw new Error(
			`Obsidian waitForIdle(${timeoutMs}) failed: ${err instanceof Error ? err.message : String(err)}\n` +
			`Debug snapshot: ${JSON.stringify(snapshot, null, 2)}`,
		);
	}
}

async function readObsidianDebugSnapshot(client) {
	return await client.evalRaw(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			const plugin = app.plugins?.plugins?.kaos;
			return {
				ready: debug ? {
					local: debug.isLocalReady(),
					providerSynced: debug.isProviderSynced(),
					providerConnected: debug.isProviderConnected(),
					reconciled: debug.isReconciled(),
					inFlight: debug.isReconcileInFlight(),
				} : null,
				settings: plugin?.settings ? {
					host: plugin.settings.host,
					tokenConfigured: !!plugin.settings.token,
					vaultId: plugin.settings.vaultId,
					deviceName: plugin.settings.deviceName,
					enableAttachmentSync: plugin.settings.enableAttachmentSync,
				} : null,
				runtime: !!plugin?.vaultSync,
				sync: plugin?.vaultSync?.getDebugSnapshot?.() ?? null,
				reconcile: plugin?.reconciliationController?.getState?.() ?? null,
				blob: plugin?.getBlobSync?.()?.getDebugSnapshot?.() ?? null,
				events: plugin?.eventRing?.slice?.(-40) ?? null,
				syncEvents: plugin?.vaultSync?.getRecentEvents?.(40) ?? null,
			};
		})()
	`);
}

async function dumpObsidianDebugSnapshot(client) {
	try {
		const snapshot = await readObsidianDebugSnapshot(client);
		console.error("\n[obsidian debug snapshot]");
		console.error(JSON.stringify(snapshot, null, 2));
	} catch (err) {
		console.error("\n[obsidian debug snapshot]");
		console.error(`unavailable: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function readObsidianFile(client, path) {
	return await client.evalRaw(`
		(async () => {
			const file = app.vault.getFileByPath(${JSON.stringify(path)});
			return file ? await app.vault.read(file) : null;
		})().catch(() => null)
	`);
}

async function readObsidianBinary(client, path) {
	const values = await client.evalRaw(`
		(async () => {
			const file = app.vault.getFileByPath(${JSON.stringify(path)});
			if (!file) return null;
			return Array.from(new Uint8Array(await app.vault.readBinary(file)));
		})().catch(() => null)
	`);
	return Array.isArray(values) ? Buffer.from(values) : null;
}

async function waitForObsidianFileContent(client, path, expected, timeoutMs) {
	await waitUntil(async () => await readObsidianFile(client, path) === expected, timeoutMs);
}

async function waitForObsidianBinaryContent(client, path, expected, timeoutMs) {
	await waitUntil(async () => {
		const actual = await readObsidianBinary(client, path);
		return actual?.equals(expected) ?? false;
	}, timeoutMs);
}

async function waitForObsidianMissing(client, path, timeoutMs) {
	await waitUntil(async () => await readObsidianFile(client, path) === null, timeoutMs);
}

function runBuild() {
	buildProductPluginBundle();
	buildHeadlessHost();
}

async function writeWranglerR2Config(path) {
	const main = resolve("server/src/index.ts").replace(/\\/g, "/");
	await writeFile(path, `name = "kaos-headless-obsidian-cross"
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
bucket_name = "kaos-headless-obsidian-cross"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultSyncServer", "ServerConfig"]
`, "utf8");
}

async function writeHeadlessData(path, { host, token, vaultId, deviceName, enableAttachmentSync }) {
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
	}, 20_000);
}

async function fetchCapabilities(host) {
	const capabilitiesRes = await fetch(`${host}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	return await capabilitiesRes.json();
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
		new Promise((resolvePromise) => child.once("exit", resolvePromise)),
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

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

function parsePositiveInt(value, fallback, label) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${label} must be a positive integer`);
	}
	return parsed;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
