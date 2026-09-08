#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { DaemonStatePublisher } from "../src/headless-host/kaos/daemonStatePublisher";
import { DaemonIpcServer } from "../src/headless-host/kaos/daemonIpcServer";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const root = await mkdtemp(join(tmpdir(), "kaos-obs-ipc-"));
const vault = join(root, "vault");
const dataFile = join(root, "headless-data.json");
const statusFile = join(root, "status.json");
const socketFile = join(root, "daemon.sock");
const installConfig = join(root, "install.json");

let pollerPollCount = 0;
let manualSyncCount = 0;
let resolvedConflictPath = null;
let resolvedConflictAction = null;

const fakePlugin = {
	manifest: { version: "1.13.1" },
	getHeadlessRuntimeSnapshot() {
		return {
			connection: {
				status: "connected",
				rttMs: 22,
				fatalAuthCode: null,
			},
			sync: {
				serverAppliedLocalState: true,
				lastServerReceiptEchoAt: 1700000000000,
				lastKnownServerReceiptEchoAt: 1700000000000,
				activeMarkdownPathsCount: 42,
				crdtPathCount: 42,
				reconcileInFlight: false,
				reconcilePending: false,
				schemaVersion: 1,
			},
			attachments: {
				enabled: true,
				transferStatus: "↑1/2",
				pendingUploads: 1,
				pendingDownloads: 0,
			},
			attention: {
				totalCount: 1,
				preservedUnresolved: [
					{
						kind: "markdown",
						path: "notes/sample.md",
						reason: "remote-delete-missing-baseline",
						firstSeenAt: 1690000000000,
						lastSeenAt: 1690000000100,
					},
				],
				providerExcludeError: null,
			},
		};
	},
	async triggerManualSync() {
		manualSyncCount++;
		return { ok: true, message: "Manual test sync triggered" };
	},
	async resolvePreservedUnresolvedEntry(path, action) {
		resolvedConflictPath = path;
		resolvedConflictAction = action;
	},
};

const fakePoller = {
	async pollOnce() {
		pollerPollCount++;
	},
};

async function sendIpc(request, timeoutMs = 3000) {
	return new Promise((resolve) => {
		const sock = createConnection(socketFile, () => {
			sock.write(JSON.stringify(request) + "\n");
		});
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (chunk) => {
			buf += chunk;
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				const line = buf.slice(0, idx).trim();
				sock.end();
				sock.destroy();
				try {
					resolve(JSON.parse(line));
				} catch {
					resolve(null);
				}
			}
		});
		sock.on("error", () => resolve(null));
	});
}

try {
	await mkdir(vault, { recursive: true });

	console.log("--- Headless Host Observability: DaemonStatePublisher ---");
	const publisher = new DaemonStatePublisher({
		vaultRoot: vault,
		dataFile,
		statusFile,
		socketFile,
		config: {
			host: "https://worker.example",
			vaultId: "test-vault-123",
			deviceName: "oracle-box",
			deviceId: "dev-456",
		},
		plugin: fakePlugin,
		intervalMs: 500,
	});

	await publisher.start();
	assert.ok(existsSync(statusFile), "status.json must be written after publisher start");

	const rawStatus = JSON.parse(await readFile(statusFile, "utf8"));
	assert.equal(rawStatus.daemon.alive, true);
	assert.equal(rawStatus.connection.status, "connected");
	assert.equal(rawStatus.connection.rttMs, 22);
	assert.equal(rawStatus.sync.activeMarkdownPathsCount, 42);
	assert.equal(rawStatus.attachments.transferStatus, "↑1/2");
	assert.equal(rawStatus.attention.totalCount, 1);
	assert.equal(rawStatus.attention.items[0].path, "notes/sample.md");

	console.log("  PASS DaemonStatePublisher emits live status.json snapshot");

	console.log("--- Headless Host IPC: DaemonIpcServer ---");
	const ipcServer = new DaemonIpcServer({
		socketPath: socketFile,
		publisher,
		plugin: fakePlugin,
		poller: fakePoller,
	});

	await ipcServer.start();
	assert.ok(existsSync(socketFile), "daemon.sock must exist");

	// 1. Ping
	const pingResp = await sendIpc({ command: "ping" });
	assert.equal(pingResp?.ok, true);
	assert.equal(pingResp?.result, "pong");

	// 2. Status
	const statusResp = await sendIpc({ command: "status" });
	assert.equal(statusResp?.ok, true);
	assert.equal(statusResp?.result?.connection?.rttMs, 22);

	// 3. Sync
	assert.equal(pollerPollCount, 0);
	assert.equal(manualSyncCount, 0);
	const syncResp = await sendIpc({ command: "sync" });
	assert.equal(syncResp?.ok, true);
	assert.equal(syncResp?.result?.pollerOk, true);
	assert.equal(pollerPollCount, 1);
	assert.equal(manualSyncCount, 1);

	// 4. Conflicts resolve
	const conflictResp = await sendIpc({
		command: "conflicts.resolve",
		params: { path: "notes/sample.md", action: "keep-local" },
	});
	assert.equal(conflictResp?.ok, true);
	assert.equal(resolvedConflictPath, "notes/sample.md");
	assert.equal(resolvedConflictAction, "keep-local");

	console.log("  PASS DaemonIpcServer handles ping, status, sync, and conflict resolution");

	console.log("--- Headless Host CLI: kaos status and kaos sync ---");
	await writeFile(
		installConfig,
		JSON.stringify({
			vaultRoot: vault,
			pluginDir: join(vault, ".obsidian", "plugins", "kaos"),
			paths: {
				dataFile,
				runtimeDir: root,
			},
		}),
		"utf8",
	);

	async function runCli(args, env = {}) {
		return new Promise((resolvePromise) => {
			const child = spawn(process.execPath, [join(repoRoot, "scripts", "kaosctl.mjs"), ...args], {
				env: { ...process.env, ...env },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (d) => { stdout += d; });
			child.stderr.on("data", (d) => { stderr += d; });
			child.on("close", (status) => {
				resolvePromise({ status, stdout, stderr });
			});
		});
	}

	// Test kaos status (CLI default non-TTY emits json with live data)
	const statusCli = await runCli(["status", "--config", installConfig]);
	assert.equal(statusCli.status, 0);
	const parsedStatus = JSON.parse(statusCli.stdout);
	assert.equal(parsedStatus.ok, true);
	assert.equal(parsedStatus.live?.connection?.rttMs, 22);
	assert.equal(parsedStatus.live?.connection?.status, "connected");
	assert.equal(parsedStatus.live?.sync?.activeMarkdownPathsCount, 42);
	assert.equal(parsedStatus.live?.attachments?.transferStatus, "↑1/2");
	assert.equal(parsedStatus.live?.attention?.totalCount, 1);

	// Test kaos sync CLI
	const syncCli = await runCli(["sync", "--config", installConfig], { KAOS_DEBUG_IPC: "1" });
	if (syncCli.status !== 0) {
		console.error("syncCli failed:", syncCli.stderr, syncCli.stdout);
	}
	assert.equal(syncCli.status, 0);
	assert.match(syncCli.stdout, /Sync completed successfully/);
	assert.equal(manualSyncCount, 2);

	console.log("  PASS kaosctl status and sync integrate seamlessly with live daemon");

	// Stop and cleanup
	await ipcServer.stop();
	assert.equal(existsSync(socketFile), false, "socket file should be cleaned up on stop");

	await publisher.stop("test-exit");
	const finalStatus = JSON.parse(await readFile(statusFile, "utf8"));
	assert.equal(finalStatus.daemon.alive, false);
	assert.equal(finalStatus.daemon.shutdownReason, "test-exit");

	console.log("  PASS publisher and ipcServer clean shutdown verified");
} finally {
	await new Promise((r) => setTimeout(r, 150));
	await rm(root, { recursive: true, force: true }).catch(async () => {
		await new Promise((r) => setTimeout(r, 300));
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	});
}
