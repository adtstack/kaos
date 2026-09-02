#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-oracle-rehearsal-verify-"));
const fakeSha = "a".repeat(64);

try {
	console.log("\n--- Oracle rehearsal verifier: validates approved-device evidence ---");
	const full = join(root, "full");
	await writeEvidence(full, { activation: true, postReboot: true });
	const verified = run(["scripts/verify-headless-host-oracle-rehearsal.mjs", "--log-dir", full, "--require-reboot-request"]);
	const verifiedPayload = JSON.parse(verified.stdout);
	assert.equal(verifiedPayload.ok, true);
	assert.equal(verifiedPayload.legacyCredentialCheck.ok, true);
	assert.ok(verifiedPayload.checks.some((check) => check.name === "device-enrollment-request" && check.ok));
	assert.ok(verifiedPayload.checks.some((check) => check.name === "approved-device-activation" && check.ok));
	assert.ok(verifiedPayload.checks.some((check) => check.name === "operational-smoke:device" && check.ok));
	assert.ok(verifiedPayload.checks.some((check) => check.name === "reboot-request:post-reboot-after-request" && check.ok));
	console.log("  PASS  first install, Owner activation, and signed-device smoke evidence all verify");

	console.log("\n--- Oracle rehearsal verifier: install evidence stops before approval ---");
	const install = join(root, "install");
	await writeEvidence(install, { activation: false, postReboot: false });
	const installResult = run(["scripts/verify-headless-host-oracle-rehearsal.mjs", "--mode", "install", "--log-dir", install]);
	const installPayload = JSON.parse(installResult.stdout);
	assert.equal(installPayload.ok, true);
	assert.equal(installPayload.requiredFiles.includes("08-activate-approved-device.json"), false);
	assert.ok(installPayload.checks.some((check) => check.name === "device-enrollment-request" && check.ok));
	console.log("  PASS  pre-approval install evidence is accepted only in install mode");

	console.log("\n--- Oracle rehearsal verifier: missing Owner activation fails closed ---");
	const missingActivation = join(root, "missing-activation");
	await writeEvidence(missingActivation, { activation: false, postReboot: true });
	const missing = spawnSync(process.execPath, ["scripts/verify-headless-host-oracle-rehearsal.mjs", "--log-dir", missingActivation], { encoding: "utf8", timeout: 30_000 });
	assert.notEqual(missing.status, 0);
	const missingPayload = JSON.parse(missing.stderr);
	assert.ok(missingPayload.failedChecks.some((check) => check.name === "file:08-activate-approved-device.json"));
	console.log("  PASS  a service cannot reach full deployment verification without Owner approval evidence");

	console.log("\n--- Oracle rehearsal verifier: legacy credential traces fail closed ---");
	const legacy = join(root, "legacy");
	await writeEvidence(legacy, { activation: true, postReboot: true });
	await writeFile(join(legacy, "unexpected.log"), "KAOS_SYNC_TOKEN=bad\n", "utf8");
	const legacyResult = spawnSync(process.execPath, ["scripts/verify-headless-host-oracle-rehearsal.mjs", "--log-dir", legacy], { encoding: "utf8", timeout: 30_000 });
	assert.notEqual(legacyResult.status, 0);
	const legacyPayload = JSON.parse(legacyResult.stderr);
	assert.deepEqual(legacyPayload.legacyCredentialCheck.legacyFiles, ["unexpected.log"]);
	console.log("  PASS  evidence containing a legacy credential path is rejected");
} finally {
	await rm(root, { recursive: true, force: true });
}

async function writeEvidence(dir, { activation, postReboot }) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "01-zip-sha256.txt"), "kaos-headless-host-oracle.zip: OK\n", "utf8");
	await writeJson(join(dir, "02-bundle-verify.json"), {
		kind: "headless-host-bundle-verify", ok: true,
		checked: [{ asset: "kaos-headless-host.mjs", ok: true }],
		releaseChecks: [{ asset: "verify-headless-host-bundle.mjs", ok: true }], checksumCheck: { ok: true },
	});
	await writeJson(join(dir, "03-bootstrap.json"), { kind: "headless-host-oracle-bootstrap", ok: true });
	await writeFile(join(dir, "04-configuration-permissions.txt"), [
		"root:kaos 640 /etc/kaos/headless.env",
		"kaos:kaos 700 /var/lib/kaos-headless",
		"",
	].join("\n"), "utf8");
	await writeJson(join(dir, "05-install-files.json"), {
		kind: "headless-host-release-update", ok: true, bundleVerification: { ok: true }, install: { ok: true },
	});
	await writeJson(join(dir, "07-device-enrollment-request.json"), { kind: "device-enrollment", status: "pending", deviceId: "device_1234567890" });
	await writeJson(join(dir, "08-install-metadata.json"), installMetadata());
	if (!activation) return;
	await writeJson(join(dir, "08-activate-approved-device.json"), {
		kind: "headless-host-release-update", ok: true, mode: "postflight-only", postflightOnly: true,
		postflight: { ok: true, readiness: { mode: "full" }, smoke: { ok: true } },
	});
	if (!postReboot) return;
	await writeJson(join(dir, "07-post-reboot-verify-running.json"), {
		kind: "headless-host-release-update", ok: true, mode: "postflight-only", postflightOnly: true,
		verifiedAt: "2026-07-09T00:05:00.000Z",
		postflight: { ok: true, readiness: { mode: "verify-running", bootServiceEnabled: true }, smoke: { ok: true } },
	});
	await writeJson(join(dir, "08-operational-smoke.json"), {
		kind: "headless-host-device-auth-smoke", ok: true, deviceId: "device_1234567890", role: "member",
	});
	await writeFile(join(dir, "09-systemctl-status.txt"), "* kaos-headless-host.service\n Active: active (running)\n", "utf8");
	await writeFile(join(dir, "10-journalctl.txt"), "service ready\n", "utf8");
	await writeJson(join(dir, "11-reboot-request.json"), {
		kind: "headless-host-oracle-remote-reboot-request", ok: true, remoteDir: "remote", requestedAt: "2026-07-09T00:00:00.000Z", systemctlPath: "/usr/bin/systemctl",
	});
}

function installMetadata() {
	const assets = [
		"kaos-headless-host.mjs", "kaos-headless-host.mjs.sha256", "kaos-headless-host.service", "oracle-acceptance-config.example.json",
		"install-headless-host.mjs", "bootstrap-headless-host-oracle.mjs", "uninstall-headless-host.mjs", "update-headless-host-from-release.mjs",
		"verify-headless-host-bundle.mjs", "validate-headless-host-release-assets.mjs", "run-headless-host-oracle-rehearsal.mjs",
		"run-headless-host-oracle-remote-rehearsal.mjs", "run-headless-host-oracle-acceptance.mjs", "verify-headless-host-oracle-acceptance.mjs",
		"verify-headless-host-oracle-rehearsal.mjs", "smoke-headless-host-sync.mjs", "postflight-headless-host.mjs", "rollback-headless-host.mjs",
	];
	return {
		kind: "headless-host-release-install",
		downloaded: ["kaos-headless-host-manifest.json", ...assets].map((asset) => ({ asset, sha256: fakeSha })),
		manifest: { kind: "kaos-headless-host-release-manifest", schemaVersion: 1, assets: Object.fromEntries(assets.map((asset) => [asset, { sha256: fakeSha, bytes: 1 }])) },
		bundleVerification: { ok: true }, install: { ok: true, sha256: fakeSha },
		helpers: [{ target: "/opt/kaos/postflight-headless-host.mjs", sourceSha256: fakeSha, installedSha256: fakeSha }],
	};
}

async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function run(args) {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}
