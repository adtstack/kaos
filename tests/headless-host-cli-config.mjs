#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	buildHeadlessHost,
	buildProductPluginBundle,
	installVaultPlugin,
} from "./helpers/headless-host-vault-plugin.mjs";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-host-cli-"));
const vaultRoot = join(root, "vault");
const dataFile = join(root, "data", "data.json");
const doctorDataFile = join(root, "data", "doctor-data.json");
const strictDoctorDataFile = join(root, "data", "strict-doctor-data.json");
const lockDataFile = join(root, "data", "lock-data.json");
const lockFile = join(root, "locks", "host.lock");
const fatalDataFile = join(root, "data", "fatal-data.json");
const fatalLockFile = join(root, "locks", "fatal.lock");
const unloadFailureDataFile = join(root, "data", "unload-failure-data.json");
const unloadFailureLockFile = join(root, "locks", "unload-failure.lock");

try {
	await mkdir(vaultRoot, { recursive: true });
	buildProductPluginBundle();
	buildHeadlessHost();
	await installVaultPlugin(vaultRoot);

	console.log("\n--- headless host cli: flags seed plugin data and release lock ---");
	const boot = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--boot-only",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
		"--lock-file",
		lockFile,
		"--host",
		"http://127.0.0.1:9",
		"--token",
		"token-from-cli",
		"--vault-id",
		"vault-from-cli",
		"--device-name",
		"device-from-cli",
		"--disable-attachments",
	], {
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(boot.status, 0, boot.stderr || boot.stdout);
	const data = JSON.parse(await readFile(dataFile, "utf8"));
	assert.equal(data.host, "http://127.0.0.1:9");
	assert.equal(data.token, "token-from-cli");
	assert.equal(data.vaultId, "vault-from-cli");
	assert.equal(data.deviceName, "device-from-cli");
	assert.equal(data.enableAttachmentSync, false);
	assert.equal(existsSync(lockFile), false, "boot-only should release the lock file");
	console.log("  PASS  CLI flags persisted expected settings");

	console.log("\n--- headless host cli: status and dump-config redact secrets ---");
	const status = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--status",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(status.status, 0, status.stderr || status.stdout);
	const statusPayload = JSON.parse(status.stdout.trim());
	assert.equal(statusPayload.kind, "status");
	assert.equal(statusPayload.configured.tokenConfigured, true);
	assert.equal(Object.prototype.hasOwnProperty.call(statusPayload.configured, "token"), false);

	const dumpConfig = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--dump-config",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
		"--token",
		"override-token",
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(dumpConfig.status, 0, dumpConfig.stderr || dumpConfig.stdout);
	const configPayload = JSON.parse(dumpConfig.stdout.trim());
	assert.equal(configPayload.kind, "config");
	assert.equal(configPayload.configured.tokenConfigured, true);
	assert.equal(Object.prototype.hasOwnProperty.call(configPayload.configured, "token"), false);
	console.log("  PASS  status/config commands redact token material");

	console.log("\n--- headless host cli: doctor reports local readiness without leaking secrets ---");
	await writeFile(doctorDataFile, JSON.stringify({
		token: "doctor-token",
		vaultId: "doctor-vault",
		deviceName: "doctor-device",
	}, null, 2), "utf8");
	const doctor = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--doctor",
		"--vault",
		vaultRoot,
		"--data-file",
		doctorDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
	const doctorPayload = JSON.parse(doctor.stdout.trim());
	assert.equal(doctorPayload.kind, "doctor");
	assert.equal(doctorPayload.ok, true);
	assert.equal(doctorPayload.configured.tokenConfigured, true);
	assert.equal(Object.prototype.hasOwnProperty.call(doctorPayload.configured, "token"), false);
	assert.ok(doctorPayload.checks.some((check) => check.name === "worker-capabilities" && check.ok === true));
	console.log("  PASS  doctor covers local paths and redacts token material");

	console.log("\n--- headless host cli: strict doctor requires sync config without network probe ---");
	const strictMissing = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--doctor",
		"--require-sync-config",
		"--skip-worker-capabilities",
		"--vault",
		vaultRoot,
		"--data-file",
		doctorDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.notEqual(strictMissing.status, 0, "strict doctor should fail when host is missing");
	const strictMissingPayload = JSON.parse(strictMissing.stdout.trim());
	assert.equal(strictMissingPayload.ok, false);
	assert.ok(strictMissingPayload.checks.some((check) => check.name === "sync-config:host" && check.ok === false));

	await writeFile(strictDoctorDataFile, JSON.stringify({
		host: "https://worker.example.invalid",
		token: "strict-doctor-token",
		vaultId: "strict-doctor-vault",
		deviceName: "strict-doctor-device",
	}, null, 2), "utf8");
	const strictConfigured = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--doctor",
		"--require-sync-config",
		"--skip-worker-capabilities",
		"--vault",
		vaultRoot,
		"--data-file",
		strictDoctorDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(strictConfigured.status, 0, strictConfigured.stderr || strictConfigured.stdout);
	const strictConfiguredPayload = JSON.parse(strictConfigured.stdout.trim());
	assert.equal(strictConfiguredPayload.ok, true);
	assert.equal(strictConfiguredPayload.configured.tokenConfigured, true);
	assert.equal(Object.prototype.hasOwnProperty.call(strictConfiguredPayload.configured, "token"), false);
	for (const name of ["vault-root-writable", "data-dir-writable", "lock-dir-writable"]) {
		assert.ok(strictConfiguredPayload.checks.some((check) => check.name === name && check.ok), `${name} should pass`);
	}
	assert.ok(strictConfiguredPayload.checks.some((check) => check.name === "worker-capabilities" && check.detail.includes("--skip-worker-capabilities")));
	console.log("  PASS  strict doctor catches missing config and can skip network capabilities");

	console.log("\n--- headless host cli: lock prevents concurrent daemon ---");
	const first = spawn(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		lockDataFile,
		"--lock-file",
		lockFile,
		"--poll-interval-ms",
		"500",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const firstOutput = capture(first);
	await waitFor(() => firstOutput.stdout.includes('"kind":"poller-started"'), 10_000);
	assert.equal(existsSync(lockFile), true, "daemon should hold lock while running");
	const lockedStatus = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--status",
		"--vault",
		vaultRoot,
		"--data-file",
		lockDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(lockedStatus.status, 0, lockedStatus.stderr || lockedStatus.stdout);
	const lockedStatusPayload = JSON.parse(lockedStatus.stdout.trim());
	assert.equal(lockedStatusPayload.lockHeld, true);
	assert.equal(lockedStatusPayload.lock.held, true);
	assert.equal(lockedStatusPayload.lock.readable, true);
	assert.equal(lockedStatusPayload.lock.info.pid, first.pid);
	assert.equal(lockedStatusPayload.lock.info.processAlive, true);
	assert.equal(lockedStatusPayload.lock.info.vaultRoot, vaultRoot);
	assert.equal(lockedStatusPayload.lock.info.dataFile, lockDataFile);
	assert.equal(lockedStatusPayload.lock.info.runtime, "kaos-headless-host");
	assert.equal(lockedStatus.stdout.includes("token-from-cli"), false);

	const second = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--boot-only",
		"--vault",
		vaultRoot,
		"--data-file",
		lockDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.notEqual(second.status, 0, "second process should fail while lock is held");
	assert.match(second.stderr, /lock already exists/);
	first.kill("SIGTERM");
	await waitForClose(first, 10_000);
	assert.equal(existsSync(lockFile), false, "daemon should release lock on SIGTERM");
	console.log("  PASS  lock rejects concurrent host and releases on shutdown");

	console.log("\n--- headless host cli: status explains stale lock ownership ---");
	await writeFile(lockFile, JSON.stringify({
		pid: 999999,
		hostname: "stale-host",
		startedAt: "2026-07-08T00:00:00.000Z",
		runtime: "kaos-headless-host",
		vaultRoot,
		dataFile: lockDataFile,
	}, null, 2), "utf8");
	const staleStatus = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--status",
		"--vault",
		vaultRoot,
		"--data-file",
		lockDataFile,
		"--lock-file",
		lockFile,
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(staleStatus.status, 0, staleStatus.stderr || staleStatus.stdout);
	const staleStatusPayload = JSON.parse(staleStatus.stdout.trim());
	assert.equal(staleStatusPayload.lock.held, true);
	assert.equal(staleStatusPayload.lock.info.pid, 999999);
	assert.equal(staleStatusPayload.lock.info.hostname, "stale-host");
	assert.equal(staleStatusPayload.lock.info.processAlive, false);
	assert.equal(staleStatusPayload.lock.info.vaultRoot, vaultRoot);
	await rm(lockFile, { force: true });
	console.log("  PASS  status surfaces stale lock diagnostics without removing it");

	console.log("\n--- headless host cli: fatal runtime errors release lock before restart ---");
	const fatalHarness = join(root, "fatal-runtime.mjs");
	await writeFile(fatalHarness, `import { runHeadlessHostCli } from ${JSON.stringify(pathToFileURL(resolve("dist/kaos-headless-host.mjs")).href)};
setTimeout(() => { throw new Error("fatal-cleanup-test"); }, 250);
await runHeadlessHostCli();
`, "utf8");
	const fatal = spawn(process.execPath, [
		fatalHarness,
		"--vault",
		vaultRoot,
		"--data-file",
		fatalDataFile,
		"--lock-file",
		fatalLockFile,
		"--poll-interval-ms",
		"500",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const fatalOutput = capture(fatal);
	await waitFor(() => fatalOutput.stdout.includes('"kind":"poller-started"'), 10_000);
	const fatalClose = await waitForClose(fatal, 10_000);
	assert.equal(fatalClose.code, 1, fatalOutput.stderr || fatalOutput.stdout);
	assert.match(fatalOutput.stdout, /"kind":"fatal".*"reason":"uncaughtException"/);
	assert.match(fatalOutput.stdout, /"kind":"shutdown".*"reason":"uncaughtException"/);
	assert.equal(existsSync(fatalLockFile), false, "fatal shutdown should release the lock file");
	console.log("  PASS  fatal daemon errors clean up lock state for restart");

	console.log("\n--- headless host cli: unload failures still release lock on service stop ---");
	const unloadFailureHarness = join(root, "unload-failure-runtime.mjs");
	await writeFile(unloadFailureHarness, `import { runHeadlessHostCli } from ${JSON.stringify(pathToFileURL(resolve("dist/kaos-headless-host.mjs")).href)};
let keepAlive = null;
await runHeadlessHostCli(process.argv.slice(2), {
  bootPlugin: async () => ({
    app: { vault: {} },
    plugin: {
      async onunload() {
        throw new Error("unload-cleanup-test");
      },
    },
  }),
  createPoller: () => ({
    async start() {
      keepAlive = setInterval(() => {}, 1000);
    },
    stop() {
      clearInterval(keepAlive);
    },
  }),
});
`, "utf8");
	const unloadFailure = spawn(process.execPath, [
		unloadFailureHarness,
		"--vault",
		vaultRoot,
		"--data-file",
		unloadFailureDataFile,
		"--lock-file",
		unloadFailureLockFile,
		"--poll-interval-ms",
		"500",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const unloadFailureOutput = capture(unloadFailure);
	await waitFor(() => unloadFailureOutput.stdout.includes('"kind":"poller-started"'), 10_000);
	assert.equal(existsSync(unloadFailureLockFile), true, "daemon should hold lock before stop");
	unloadFailure.kill("SIGTERM");
	const unloadFailureClose = await waitForClose(unloadFailure, 10_000, unloadFailureOutput);
	assert.equal(unloadFailureClose.code, 0, unloadFailureOutput.stderr || unloadFailureOutput.stdout);
	assert.match(unloadFailureOutput.stdout, /"kind":"plugin-unload-failed".*"reason":"SIGTERM"/);
	assert.match(unloadFailureOutput.stdout, /"kind":"shutdown".*"reason":"SIGTERM"/);
	assert.equal(existsSync(unloadFailureLockFile), false, "unload failure should not leave a stale lock file");
	console.log("  PASS  unload failures cannot strand the daemon lock");
} finally {
	await rm(root, { recursive: true, force: true });
}

function capture(child) {
	const output = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output.stdout += chunk; });
	child.stderr.on("data", (chunk) => { output.stderr += chunk; });
	return output;
}

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(50);
	}
	throw new Error("timed out waiting for condition");
}

function waitForClose(child, timeoutMs, output = null) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out waiting for child close\nstdout:\n${output?.stdout ?? ""}\nstderr:\n${output?.stderr ?? ""}`));
		}, timeoutMs);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
