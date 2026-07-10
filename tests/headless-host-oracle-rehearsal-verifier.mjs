#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-oracle-rehearsal-verify-"));
const secret = "oracle-rehearsal-secret-token";
const secretFile = join(root, "sync-token");
const fakeSha = "a".repeat(64);

try {
	await writeFile(secretFile, `${secret}\n`, "utf8");

	console.log("\n--- headless host Oracle rehearsal verifier: accepts complete evidence ---");
	const goodLogDir = join(root, "good");
	await writeGoodEvidence(goodLogDir);
	const good = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		goodLogDir,
		"--secret-file",
		secretFile,
	]);
	const goodPayload = JSON.parse(good.stdout);
	assert.equal(goodPayload.kind, "headless-host-oracle-rehearsal-verify");
	assert.equal(goodPayload.ok, true);
	assert.equal(goodPayload.secretLeakCheck.ok, true);
	assert.ok(goodPayload.checks.some((check) => check.name === "post-reboot:verify-running" && check.ok));
	assert.ok(goodPayload.checks.some((check) => check.name === "operational-smoke:peer-to-oracle:wait-primary" && check.ok));
	assert.ok(goodPayload.checks.some((check) => check.name === "systemd-status:active" && check.ok));
	assert.ok(goodPayload.checks.some((check) => check.name === "journalctl:evidence" && check.ok));
	assert.equal(goodPayload.requireRebootRequest, false);
	console.log("  PASS  complete rehearsal evidence verifies cleanly");

	console.log("\n--- headless host Oracle rehearsal verifier: can require reboot request evidence ---");
	const rebootRequestDir = join(root, "reboot-request");
	await writeGoodEvidence(rebootRequestDir);
	await writeRebootRequestEvidence(rebootRequestDir);
	const rebootRequest = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		rebootRequestDir,
		"--secret-file",
		secretFile,
		"--require-reboot-request",
	]);
	const rebootRequestPayload = JSON.parse(rebootRequest.stdout);
	assert.equal(rebootRequestPayload.ok, true);
	assert.equal(rebootRequestPayload.requireRebootRequest, true);
	assert.ok(rebootRequestPayload.requiredFiles.includes("11-reboot-request.json"));
	assert.ok(rebootRequestPayload.checks.some((check) => check.name === "reboot-request:shape" && check.ok));
	assert.ok(rebootRequestPayload.checks.some((check) => check.name === "reboot-request:timestamp" && check.ok));
	assert.ok(rebootRequestPayload.checks.some((check) => check.name === "reboot-request:post-reboot-after-request" && check.ok));
	console.log("  PASS  reboot request evidence can be required for structured remote runs");

	console.log("\n--- headless host Oracle rehearsal verifier: rejects missing required reboot request ---");
	const missingRebootRequestDir = join(root, "missing-reboot-request");
	await writeGoodEvidence(missingRebootRequestDir);
	const missingRebootRequest = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		missingRebootRequestDir,
		"--secret-file",
		secretFile,
		"--require-reboot-request",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(missingRebootRequest.status, 0, "missing required reboot request should fail verification");
	const missingRebootRequestPayload = JSON.parse(missingRebootRequest.stderr);
	assert.ok(missingRebootRequestPayload.failedChecks.some((check) => check.name === "file:11-reboot-request.json"));
	console.log("  PASS  required reboot request evidence fails closed when missing");

	console.log("\n--- headless host Oracle rehearsal verifier: rejects post-reboot before reboot request ---");
	const staleRebootRequestDir = join(root, "stale-reboot-request");
	await writeGoodEvidence(staleRebootRequestDir);
	await writeRebootRequestEvidence(staleRebootRequestDir, { requestedAt: "2026-07-09T01:00:00.000Z" });
	const stalePostReboot = JSON.parse(await readFile(join(staleRebootRequestDir, "07-post-reboot-verify-running.json"), "utf8"));
	stalePostReboot.verifiedAt = "2026-07-09T00:00:00.000Z";
	await writeJson(join(staleRebootRequestDir, "07-post-reboot-verify-running.json"), stalePostReboot);
	const staleRebootRequest = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		staleRebootRequestDir,
		"--secret-file",
		secretFile,
		"--require-reboot-request",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(staleRebootRequest.status, 0, "post-reboot before reboot request should fail verification");
	const staleRebootRequestPayload = JSON.parse(staleRebootRequest.stderr);
	assert.ok(staleRebootRequestPayload.failedChecks.some((check) => check.name === "reboot-request:post-reboot-after-request"));
	console.log("  PASS  reboot request ordering fails closed when timestamps contradict");

	console.log("\n--- headless host Oracle rehearsal verifier: accepts install evidence before reboot ---");
	const installDir = join(root, "install");
	await writeGoodEvidence(installDir);
	await rm(join(installDir, "07-post-reboot-verify-running.json"), { force: true });
	await rm(join(installDir, "08-operational-smoke.json"), { force: true });
	const install = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--mode",
		"install",
		"--log-dir",
		installDir,
		"--secret-file",
		secretFile,
	]);
	const installPayload = JSON.parse(install.stdout);
	assert.equal(installPayload.ok, true);
	assert.equal(installPayload.mode, "install");
	assert.deepEqual(installPayload.requiredFiles, [
		"01-zip-sha256.txt",
		"02-bundle-verify.json",
		"03-bootstrap.json",
		"04-secret-permissions.txt",
		"05-install-postflight.json",
		"06-install-metadata.json",
	]);
	assert.ok(installPayload.checks.some((check) => check.name === "bootstrap" && check.ok));
	assert.equal(installPayload.checks.some((check) => check.name === "post-reboot:verify-running"), false);
	console.log("  PASS  install evidence verifies before reboot-only files exist");

	console.log("\n--- headless host Oracle rehearsal verifier: accepts update-only evidence ---");
	const updateDir = join(root, "update");
	await writeGoodEvidence(updateDir);
	await rm(join(updateDir, "03-bootstrap.json"), { force: true });
	await rm(join(updateDir, "07-post-reboot-verify-running.json"), { force: true });
	await rm(join(updateDir, "08-operational-smoke.json"), { force: true });
	const update = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--mode",
		"update",
		"--log-dir",
		updateDir,
		"--secret-file",
		secretFile,
	]);
	const updatePayload = JSON.parse(update.stdout);
	assert.equal(updatePayload.ok, true);
	assert.equal(updatePayload.mode, "update");
	assert.deepEqual(updatePayload.requiredFiles, [
		"01-zip-sha256.txt",
		"02-bundle-verify.json",
		"04-secret-permissions.txt",
		"05-install-postflight.json",
		"06-install-metadata.json",
	]);
	assert.equal(updatePayload.checks.some((check) => check.name === "bootstrap"), false);
	console.log("  PASS  update-only evidence verifies without bootstrap or reboot files");

	console.log("\n--- headless host Oracle rehearsal verifier: rejects weak update metadata ---");
	const weakUpdateDir = join(root, "weak-update");
	await writeGoodEvidence(weakUpdateDir);
	await rm(join(weakUpdateDir, "03-bootstrap.json"), { force: true });
	await rm(join(weakUpdateDir, "07-post-reboot-verify-running.json"), { force: true });
	await rm(join(weakUpdateDir, "08-operational-smoke.json"), { force: true });
	const weakMetadata = JSON.parse(await readFile(join(weakUpdateDir, "06-install-metadata.json"), "utf8"));
	weakMetadata.downloaded = weakMetadata.downloaded.filter((item) => item.asset !== "postflight-headless-host.mjs");
	await writeJson(join(weakUpdateDir, "06-install-metadata.json"), weakMetadata);
	const weakUpdate = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--mode",
		"update",
		"--log-dir",
		weakUpdateDir,
		"--secret-file",
		secretFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(weakUpdate.status, 0, "weak update metadata should fail verification");
	const weakUpdatePayload = JSON.parse(weakUpdate.stderr);
	assert.ok(weakUpdatePayload.failedChecks.some((check) => check.name === "install-metadata:downloaded-assets"));
	console.log("  PASS  update verifier requires release asset metadata");

	console.log("\n--- headless host Oracle rehearsal verifier: rejects missing post-reboot smoke ---");
	const badPostRebootDir = join(root, "bad-post-reboot");
	await writeGoodEvidence(badPostRebootDir);
	const postReboot = JSON.parse(await readFile(join(badPostRebootDir, "07-post-reboot-verify-running.json"), "utf8"));
	postReboot.postflight.smoke.ok = false;
	await writeJson(join(badPostRebootDir, "07-post-reboot-verify-running.json"), postReboot);
	const badPostReboot = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		badPostRebootDir,
		"--secret-file",
		secretFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(badPostReboot.status, 0, "post-reboot smoke failure should fail rehearsal verification");
	const badPostRebootPayload = JSON.parse(badPostReboot.stderr);
	assert.equal(badPostRebootPayload.ok, false);
	assert.ok(badPostRebootPayload.failedChecks.some((check) => check.name === "post-reboot:smoke"));
	console.log("  PASS  verifier fails closed when post-reboot smoke evidence is weak");

	console.log("\n--- headless host Oracle rehearsal verifier: reports secret leakage without echoing the secret ---");
	const leakyDir = join(root, "leaky");
	await writeGoodEvidence(leakyDir);
	await writeFile(join(leakyDir, "journal.txt"), `leaked ${secret}\n`, "utf8");
	const leaky = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		leakyDir,
		"--secret-file",
		secretFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(leaky.status, 0, "secret leakage should fail rehearsal verification");
	assert.equal(leaky.stderr.includes(secret), false, "verifier output must not echo leaked secret material");
	const leakyPayload = JSON.parse(leaky.stderr);
	assert.equal(leakyPayload.secretLeakCheck.ok, false);
	assert.deepEqual(leakyPayload.secretLeakCheck.leakedFiles, ["journal.txt"]);
	console.log("  PASS  verifier catches secret leakage without reprinting it");
} finally {
	await rm(root, { recursive: true, force: true });
}

async function writeGoodEvidence(dir) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "01-zip-sha256.txt"), "kaos-headless-host-oracle.zip: OK\n", "utf8");
	await writeJson(join(dir, "02-bundle-verify.json"), {
		kind: "headless-host-bundle-verify",
		ok: true,
		checked: [{ asset: "kaos-headless-host.mjs", ok: true }],
		releaseChecks: [{ asset: "verify-headless-host-bundle.mjs", ok: true }],
		checksumCheck: { ok: true },
	});
	await writeJson(join(dir, "03-bootstrap.json"), {
		kind: "headless-host-oracle-bootstrap",
		ok: true,
	});
	await writeFile(join(dir, "04-secret-permissions.txt"), [
		"root:kaos 640 /etc/kaos/headless.env",
		"root:kaos 640 /etc/kaos/sync-token",
		"",
	].join("\n"), "utf8");
	await writeJson(join(dir, "05-install-postflight.json"), {
		kind: "headless-host-release-update",
		ok: true,
		bundleVerification: { ok: true },
		install: { ok: true },
		postflight: {
			ok: true,
			readiness: { mode: "full" },
			smoke: { ok: true },
		},
		serviceEnable: { ok: true },
	});
	await writeJson(join(dir, "06-install-metadata.json"), {
		kind: "headless-host-release-install",
		downloaded: releaseDownloaded(),
		manifest: releaseManifest(),
		bundleVerification: { ok: true },
		install: { ok: true, sha256: fakeSha },
		helpers: [
			{
				target: "/opt/kaos/postflight-headless-host.mjs",
				sourceSha256: fakeSha,
				installedSha256: fakeSha,
			},
		],
	});
	await writeJson(join(dir, "07-post-reboot-verify-running.json"), {
		kind: "headless-host-release-update",
		ok: true,
		mode: "postflight-only",
		postflightOnly: true,
		verifiedAt: "2026-07-09T00:05:00.000Z",
		postflight: {
			ok: true,
			readiness: {
				mode: "verify-running",
				bootServiceEnabled: true,
			},
			smoke: { ok: true },
		},
	});
	await writeJson(join(dir, "08-operational-smoke.json"), {
		kind: "headless-host-sync-smoke",
		ok: true,
		completedStages: [
			"peer-start",
			"peer-ready",
			"oracle-to-peer:wait-peer",
			"peer-to-oracle:wait-primary",
		],
	});
	await writeFile(join(dir, "09-systemctl-status.txt"), [
		"* kaos-headless-host.service - KAOS Headless Host",
		"     Loaded: loaded (/etc/systemd/system/kaos-headless-host.service; enabled)",
		"     Active: active (running) since Thu 2026-07-09 00:00:00 UTC",
		"",
	].join("\n"), "utf8");
	await writeFile(join(dir, "10-journalctl.txt"), [
		"Jul 09 00:00:00 oracle kaos-headless-host[100]: ready",
		"",
	].join("\n"), "utf8");
}

async function writeRebootRequestEvidence(dir, overrides = {}) {
	await writeJson(join(dir, "11-reboot-request.json"), {
		kind: "headless-host-oracle-remote-reboot-request",
		ok: true,
		remoteDir: "kaos-headless-rehearsal-test",
		requestedAt: "2026-07-09T00:00:00.000Z",
		sudoPath: "/usr/bin/sudo",
		systemctlPath: "/usr/bin/systemctl",
		...overrides,
	});
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function releaseAssets() {
	return [
		"kaos-headless-host.mjs",
		"kaos-headless-host.mjs.sha256",
		"kaos-headless-host.service",
		"oracle-acceptance-config.example.json",
		"install-headless-host.mjs",
		"bootstrap-headless-host-oracle.mjs",
		"uninstall-headless-host.mjs",
		"update-headless-host-from-release.mjs",
		"verify-headless-host-bundle.mjs",
		"validate-headless-host-release-assets.mjs",
		"run-headless-host-oracle-rehearsal.mjs",
		"run-headless-host-oracle-remote-rehearsal.mjs",
		"run-headless-host-oracle-acceptance.mjs",
		"verify-headless-host-oracle-acceptance.mjs",
		"verify-headless-host-oracle-rehearsal.mjs",
		"smoke-headless-host-sync.mjs",
		"postflight-headless-host.mjs",
		"rollback-headless-host.mjs",
	];
}

function releaseDownloaded() {
	return ["kaos-headless-host-manifest.json", ...releaseAssets()].map((asset) => ({ asset, sha256: fakeSha }));
}

function releaseManifest() {
	return {
		kind: "kaos-headless-host-release-manifest",
		schemaVersion: 1,
		assets: Object.fromEntries(releaseAssets().map((asset) => [asset, { sha256: fakeSha, bytes: 1 }])),
	};
}

function run(args) {
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}
