#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHeadlessHost, buildProductPluginBundle, installVaultPlugin } from "./helpers/headless-host-vault-plugin.mjs";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-host-smoke-"));
const vaultRoot = join(root, "vault");
const dataFile = join(root, "plugin-data", "data.json");

try {
	await mkdir(vaultRoot, { recursive: true });

	console.log("\n--- headless host smoke: build plugin and runner artifacts ---");
	buildProductPluginBundle();
	buildHeadlessHost();
	await installVaultPlugin(vaultRoot);
	console.log("  PASS  build:headless:host completed");

	console.log("\n--- headless host smoke: boot real plugin through shim ---");
	const boot = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--boot-only",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
	], {
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.equal(boot.status, 0, boot.stderr || boot.stdout);
	assert.match(boot.stdout, /"kind":"booted"/);
	assert.match(boot.stdout, /"kind":"shutdown"/);
	console.log("  PASS  real plugin booted and unloaded");

	console.log("\n--- headless host smoke: configured daemon enters sync init path ---");
	await writeFile(dataFile, JSON.stringify({
		host: "http://127.0.0.1:65530",
		token: "test-token",
		vaultId: "headless-host-smoke-vault",
		deviceName: "headless-host-smoke",
		enableAttachmentSync: false,
	}, null, 2), "utf8");
	const daemon = spawn(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	daemon.stdout.setEncoding("utf8");
	daemon.stderr.setEncoding("utf8");
	daemon.stdout.on("data", (chunk) => { stdout += chunk; });
	daemon.stderr.on("data", (chunk) => { stderr += chunk; });
	await waitFor(() => stdout.includes('"kind":"booted"'), 5_000);
	await sleep(1_000);
	daemon.kill("SIGTERM");
	const close = await waitForClose(daemon, 5_000);
	assert.equal(close.code, 0, stderr || stdout);
	assert.match(stdout, /"kind":"shutdown".*"reason":"SIGTERM"/);
	assert.ok(!stderr.includes("indexedDB is not defined"), stderr);
	assert.ok(!stderr.includes("ReferenceError"), stderr);
	console.log("  PASS  configured plugin reached initSync without missing IndexedDB");
} finally {
	await rm(root, { recursive: true, force: true });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await sleep(50);
	}
	throw new Error("timed out waiting for condition");
}

function waitForClose(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("timed out waiting for child process to close"));
		}, timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}
