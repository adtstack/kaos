#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-oracle-upload-"));

console.log("\n--- headless host Oracle upload prepare: validates built bundle ---");
run(process.execPath, ["scripts/build-headless-host.mjs"]);
const extractDir = join(root, "extract");
const prepared = run(process.execPath, [
	"scripts/prepare-headless-host-oracle-upload.mjs",
	"--work-dir",
	extractDir,
	"--target",
	"opc@example.invalid:/home/opc/kaos",
]);
const preparedPayload = JSON.parse(prepared.stdout);
assert.equal(preparedPayload.kind, "headless-host-oracle-upload-prepare");
assert.equal(preparedPayload.ok, true);
assert.equal(preparedPayload.zipSha256, await readChecksum("dist/kaos-headless-host-oracle.zip.sha256"));
assert.equal(preparedPayload.bundleVerification.ok, true);
assert.equal(preparedPayload.workDir, extractDir);
const releaseAssetsValidate = run(process.execPath, [
	"scripts/validate-headless-host-release-assets.mjs",
	"--zip",
	"dist/kaos-headless-host-oracle.zip",
	"--checksum",
	"dist/kaos-headless-host-oracle.zip.sha256",
]);
const releaseAssetsValidatePayload = JSON.parse(releaseAssetsValidate.stdout);
assert.equal(releaseAssetsValidatePayload.kind, "headless-host-release-assets-validate");
assert.equal(releaseAssetsValidatePayload.ok, true);
const releaseBundleVerifyCheck = releaseAssetsValidatePayload.checks.find((check) => check.name === "release-bundle-verify");
assert.equal(releaseBundleVerifyCheck?.ok, true);
assert.equal(releaseBundleVerifyCheck.payload.kind, "headless-host-bundle-verify");
assert.equal(typeof releaseBundleVerifyCheck.payload.checkedCount, "number");
assert.equal(Array.isArray(releaseBundleVerifyCheck.payload.checked), false);
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "run-headless-host-oracle-rehearsal.mjs"));
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "run-headless-host-oracle-remote-rehearsal.mjs"));
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "run-headless-host-oracle-acceptance.mjs"));
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "verify-headless-host-oracle-acceptance.mjs"));
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "verify-headless-host-oracle-rehearsal.mjs"));
assert.ok(preparedPayload.entries.some((entry) => entry.entry === "oracle-acceptance-config.example.json"));
assert.match(preparedPayload.uploadCommand, /scp .*kaos-headless-host-oracle\.zip .*kaos-headless-host-oracle\.zip\.sha256 opc@example\.invalid:\/home\/opc\/kaos/);
assert.equal((await stat(join(extractDir, "verify-headless-host-bundle.mjs"))).isFile(), true);
assert.equal((await stat(join(extractDir, "validate-headless-host-release-assets.mjs"))).isFile(), true);
console.log("  PASS  upload prepare gate verifies the real Oracle bundle");

console.log("\n--- headless host Oracle upload prepare: rejects checksum drift ---");
const badChecksum = join(root, "bad.sha256");
await writeFile(badChecksum, `${"0".repeat(64)}  kaos-headless-host-oracle.zip\n`, "utf8");
const checksumDrift = spawnSync(process.execPath, [
	"scripts/prepare-headless-host-oracle-upload.mjs",
	"--zip",
	"dist/kaos-headless-host-oracle.zip",
	"--checksum",
	badChecksum,
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(checksumDrift.status, 0, "checksum drift must fail the upload gate");
const checksumPayload = JSON.parse(checksumDrift.stderr);
assert.equal(checksumPayload.kind, "headless-host-oracle-upload-prepare");
assert.equal(checksumPayload.ok, false);
assert.equal(checksumPayload.failedStage, "zip-checksum");
const releaseChecksumDrift = spawnSync(process.execPath, [
	"scripts/validate-headless-host-release-assets.mjs",
	"--zip",
	"dist/kaos-headless-host-oracle.zip",
	"--checksum",
	badChecksum,
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(releaseChecksumDrift.status, 0, "release asset validator must fail on checksum drift");
const releaseChecksumPayload = JSON.parse(releaseChecksumDrift.stderr);
assert.equal(releaseChecksumPayload.kind, "headless-host-release-assets-validate");
assert.equal(releaseChecksumPayload.ok, false);
assert.ok(releaseChecksumPayload.failedChecks.some((check) => check.name === "release-zip:checksum"));
console.log("  PASS  checksum drift fails closed before extraction");

console.log("\n--- headless host Oracle upload prepare: rejects unsafe zip entries ---");
const unsafeDir = join(root, "unsafe");
await mkdir(unsafeDir, { recursive: true });
const unsafeZip = join(unsafeDir, "kaos-headless-host-oracle.zip");
const unsafeBytes = zipSync({
	"../escape.mjs": Buffer.from("escape\n", "utf8"),
});
await writeFile(unsafeZip, unsafeBytes);
await writeFile(`${unsafeZip}.sha256`, `${sha256Bytes(unsafeBytes)}  kaos-headless-host-oracle.zip\n`, "utf8");
const unsafe = spawnSync(process.execPath, [
	"scripts/prepare-headless-host-oracle-upload.mjs",
	"--zip",
	unsafeZip,
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(unsafe.status, 0, "unsafe zip entries must fail the upload gate");
const unsafePayload = JSON.parse(unsafe.stderr);
assert.equal(unsafePayload.kind, "headless-host-oracle-upload-prepare");
assert.equal(unsafePayload.ok, false);
assert.equal(unsafePayload.failedStage, "zip-entry");
const unsafeValidator = spawnSync(process.execPath, [
	"scripts/validate-headless-host-release-assets.mjs",
	"--zip",
	unsafeZip,
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(unsafeValidator.status, 0, "release asset validator must fail unsafe zip entries");
const unsafeValidatorPayload = JSON.parse(unsafeValidator.stderr);
assert.equal(unsafeValidatorPayload.kind, "headless-host-release-assets-validate");
assert.equal(unsafeValidatorPayload.ok, false);
assert.ok(unsafeValidatorPayload.failedChecks.some((check) => check.name === "release-bundle-verify"));
const missingVerifier = spawnSync(process.execPath, [
	"scripts/validate-headless-host-release-assets.mjs",
	"--zip",
	"dist/kaos-headless-host-oracle.zip",
	"--checksum",
	"dist/kaos-headless-host-oracle.zip.sha256",
	"--bundle-verifier",
	join(root, "missing-verify-headless-host-bundle.mjs"),
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(missingVerifier.status, 0, "release asset validator must require a bundle verifier helper");
const missingVerifierPayload = JSON.parse(missingVerifier.stderr);
assert.equal(missingVerifierPayload.kind, "headless-host-release-assets-validate");
assert.equal(missingVerifierPayload.ok, false);
assert.ok(missingVerifierPayload.failedChecks.some((check) => check.name === "release-bundle-verify"));
console.log("  PASS  unsafe zip contents are rejected before writing files");

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: 120_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error([
			`${cmd} ${args.join(" ")} failed with ${result.status}`,
			result.stdout,
			result.stderr,
		].filter(Boolean).join("\n"));
	}
	return result;
}

async function readChecksum(path) {
	const text = await readFile(path, "utf8");
	const match = text.match(/[a-fA-F0-9]{64}/);
	if (!match) throw new Error(`${path} does not contain a sha256 digest`);
	return match[0].toLowerCase();
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
