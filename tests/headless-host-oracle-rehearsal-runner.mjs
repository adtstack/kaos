#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-oracle-rehearsal-runner-"));
const secret = "runner-secret-token";
const fakeSha = "a".repeat(64);

try {
	console.log("\n--- headless host Oracle rehearsal runner: failure evidence prefers redacted JSON ---");
	const failingBundleDir = join(root, "failing-bundle");
	const failingLogDir = join(root, "failing-logs");
	const failingTokenFile = join(root, "failing-token");
	await mkdir(failingBundleDir, { recursive: true });
	await writeFile(failingTokenFile, `${secret}\n`, "utf8");
	await writeExecutable(join(failingBundleDir, "verify-headless-host-bundle.mjs"), `#!/usr/bin/env node
console.log("non-json warning before failure");
console.error(JSON.stringify({
  kind: "headless-host-bundle-verify",
  ok: false,
  failedStage: "asset-integrity",
  error: "saw ${secret}"
}));
process.exit(5);
`);
	const failing = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"--phase",
		"install",
		"--bundle-dir",
		failingBundleDir,
		"--log-dir",
		failingLogDir,
		"--host",
		"https://runner.example.invalid",
		"--vault-id",
		"runner-vault",
		"--token-file",
		failingTokenFile,
		"--no-sudo",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(failing.status, 0, "runner should fail when bundle verification fails");
	assert.equal(failing.stderr.includes(secret), false, "runner failure JSON must redact token material");
	const failingPayload = JSON.parse(failing.stderr);
	assert.equal(failingPayload.failedStep, "bundle-verify");
	assert.equal(failingPayload.detail.stderr.includes("[redacted]"), true);
	const failingEvidence = await readFile(join(failingLogDir, "02-bundle-verify.json"), "utf8");
	assert.equal(failingEvidence.includes(secret), false, "failed evidence file must redact token material");
	assert.equal(JSON.parse(failingEvidence).error, "saw [redacted]");
	console.log("  PASS  failed runner steps keep redacted JSON diagnostics");

	console.log("\n--- headless host Oracle rehearsal runner: install phase captures evidence ---");
	const bundleDir = join(root, "bundle");
	const logDir = join(root, "logs");
	const installDir = join(root, "opt", "kaos");
	const metadataPath = join(installDir, ".kaos-headless-install.json");
	const tokenFile = join(root, "sync-token");
	await mkdir(bundleDir, { recursive: true });
	await mkdir(installDir, { recursive: true });
	await writeFile(tokenFile, `${secret}\n`, "utf8");
	await writeFakeBundleScripts(bundleDir, metadataPath, secret);
	const fakeStat = join(root, "fake-stat.cjs");
	await writeExecutable(fakeStat, `#!/usr/bin/env node
console.log("root:kaos 640 /etc/kaos/headless.env");
console.log("root:kaos 640 /etc/kaos/sync-token");
`);
	const fakeSystemctl = join(root, "fake-systemctl.cjs");
	await writeExecutable(fakeSystemctl, `#!/usr/bin/env node
console.log("* kaos-headless-host.service - KAOS Headless Host");
console.log("     Loaded: loaded (/etc/systemd/system/kaos-headless-host.service; enabled)");
console.log("     Active: active (running) since Thu 2026-07-09 00:00:00 UTC");
console.log("diagnostic token should redact: ${secret}");
`);
	const fakeJournalctl = join(root, "fake-journalctl.cjs");
	await writeExecutable(fakeJournalctl, `#!/usr/bin/env node
console.log("Jul 09 00:00:00 oracle kaos-headless-host[100]: ready");
console.log("journal token should redact: ${secret}");
`);
	const fakeSudoLog = join(root, "fake-sudo.jsonl");
	const fakeSudo = join(root, "fake-sudo.cjs");
	await writeExecutable(fakeSudo, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(fakeSudoLog)}, JSON.stringify(args) + "\\n");
if (args[0] !== "-n") {
  console.error("sudo must be non-interactive");
  process.exit(42);
}
let rest = args.slice(1);
if (rest[0] === "-u") rest = rest.slice(2);
const child = spawnSync(rest[0], rest.slice(1), { encoding: "utf8" });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);
`);
	const install = run([
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"--phase",
		"install",
		"--bundle-dir",
		bundleDir,
		"--log-dir",
		logDir,
		"--host",
		"https://runner.example.invalid",
		"--vault-id",
		"runner-vault",
		"--device-name",
		"runner-device",
		"--token-file",
		tokenFile,
		"--install-dir",
		installDir,
		"--service-path",
		join(root, "kaos-headless-host.service"),
		"--metadata-path",
		metadataPath,
		"--stat-command",
		fakeStat,
		"--no-sudo",
		"--node",
		process.execPath,
	]);
	const installPayload = JSON.parse(install.stdout);
	assert.equal(installPayload.ok, true);
	assert.equal(installPayload.phase, "install");
	for (const file of ["02-bundle-verify.json", "03-bootstrap.json", "04-secret-permissions.txt", "05-install-postflight.json", "06-install-metadata.json"]) {
		assert.equal((await readFile(join(logDir, file), "utf8")).includes(secret), false, `${file} must not leak token material`);
	}
	assert.equal(JSON.parse(await readFile(join(logDir, "05-install-postflight.json"), "utf8")).postflight.smoke.ok, true);
	assert.equal(JSON.parse(await readFile(join(logDir, "06-install-metadata.json"), "utf8")).bundleVerification.ok, true);
	console.log("  PASS  install phase writes verifier-compatible evidence without leaking token");

	console.log("\n--- headless host Oracle rehearsal runner: update phase skips bootstrap and captures postflight ---");
	const updateLogDir = join(root, "update-logs");
	const update = run([
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"--phase",
		"update",
		"--bundle-dir",
		bundleDir,
		"--log-dir",
		updateLogDir,
		"--install-dir",
		installDir,
		"--service-path",
		join(root, "kaos-headless-host.service"),
		"--metadata-path",
		metadataPath,
		"--stat-command",
		fakeStat,
		"--no-sudo",
		"--node",
		process.execPath,
	]);
	const updatePayload = JSON.parse(update.stdout);
	assert.equal(updatePayload.ok, true);
	assert.equal(updatePayload.phase, "update");
	assert.equal(updatePayload.completed.some((step) => step.name === "bootstrap"), false);
	assert.equal(JSON.parse(await readFile(join(updateLogDir, "05-install-postflight.json"), "utf8")).postflight.smoke.ok, true);
	await writeFile(join(updateLogDir, "01-zip-sha256.txt"), "kaos-headless-host-oracle.zip: OK\n", "utf8");
	const verifyUpdate = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--mode",
		"update",
		"--log-dir",
		updateLogDir,
		"--secret-file",
		tokenFile,
	]);
	assert.equal(JSON.parse(verifyUpdate.stdout).ok, true);
	console.log("  PASS  update phase writes update-verifiable evidence without bootstrap");

	console.log("\n--- headless host Oracle rehearsal runner: post-reboot phase captures running smoke ---");
	const postReboot = run([
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"--phase",
		"post-reboot",
		"--log-dir",
		logDir,
		"--install-dir",
		installDir,
		"--service-path",
		join(root, "kaos-headless-host.service"),
		"--installed-update-wrapper",
		join(bundleDir, "installed-update-wrapper.mjs"),
		"--smoke-script",
		join(bundleDir, "smoke-headless-host-sync.mjs"),
		"--token-file",
		tokenFile,
		"--sudo-command",
		fakeSudo,
		"--systemctl-command",
		fakeSystemctl,
		"--journalctl-command",
		fakeJournalctl,
	]);
	const postRebootPayload = JSON.parse(postReboot.stdout);
	assert.equal(postRebootPayload.ok, true);
	assert.equal(postRebootPayload.phase, "post-reboot");
	assert.equal(JSON.parse(await readFile(join(logDir, "07-post-reboot-verify-running.json"), "utf8")).postflight.readiness.mode, "verify-running");
	assert.equal(JSON.parse(await readFile(join(logDir, "08-operational-smoke.json"), "utf8")).completedStages.includes("peer-to-oracle:wait-primary"), true);
	assert.equal((await readFile(join(logDir, "09-systemctl-status.txt"), "utf8")).includes(secret), false);
	assert.equal((await readFile(join(logDir, "10-journalctl.txt"), "utf8")).includes(secret), false);
	const sudoCalls = (await readFile(fakeSudoLog, "utf8")).trim().split(/\n/).map((line) => JSON.parse(line));
	assert.ok(sudoCalls.every((args) => args[0] === "-n"), "runner sudo calls must be non-interactive");
	assert.ok(sudoCalls.some((args) => args[1] === "-u" && args[2] === "kaos"), "standalone smoke should still run through sudo -u kaos");
	console.log("  PASS  post-reboot phase writes verify-running and operational smoke evidence");

	console.log("\n--- headless host Oracle rehearsal runner: output works with rehearsal verifier ---");
	await writeFile(join(logDir, "01-zip-sha256.txt"), "kaos-headless-host-oracle.zip: OK\n", "utf8");
	const verify = run([
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		"--log-dir",
		logDir,
		"--secret-file",
		tokenFile,
	]);
	const verifyPayload = JSON.parse(verify.stdout);
	assert.equal(verifyPayload.ok, true);
	assert.equal(verifyPayload.secretLeakCheck.ok, true);
	console.log("  PASS  runner evidence passes the rehearsal verifier");
} finally {
	await rm(root, { recursive: true, force: true });
}

async function writeFakeBundleScripts(bundleDir, metadataPath, secret) {
	await writeExecutable(join(bundleDir, "verify-headless-host-bundle.mjs"), `#!/usr/bin/env node
console.log(JSON.stringify({
  kind: "headless-host-bundle-verify",
  ok: true,
  checked: [{ asset: "kaos-headless-host.mjs", ok: true }],
  releaseChecks: [{ asset: "run-headless-host-oracle-rehearsal.mjs", ok: true }],
  checksumCheck: { ok: true }
}));
`);
	await writeExecutable(join(bundleDir, "bootstrap-headless-host-oracle.mjs"), `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (!input.includes(${JSON.stringify(secret)})) process.exit(3);
  console.log(JSON.stringify({ kind: "headless-host-oracle-bootstrap", ok: true }));
});
`);
	await writeExecutable(join(bundleDir, "update-headless-host-from-release.mjs"), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(${JSON.stringify(metadataPath)}), { recursive: true });
writeFileSync(${JSON.stringify(metadataPath)}, JSON.stringify({
  kind: "headless-host-release-install",
  downloaded: releaseDownloaded(),
  manifest: releaseManifest(),
  bundleVerification: { ok: true },
  install: { ok: true, sha256: ${JSON.stringify(fakeSha)} },
  helpers: [{ target: "/opt/kaos/postflight-headless-host.mjs", sourceSha256: ${JSON.stringify(fakeSha)}, installedSha256: ${JSON.stringify(fakeSha)} }]
}, null, 2));
console.log(JSON.stringify({
  kind: "headless-host-release-update",
  ok: true,
  bundleVerification: { ok: true },
  install: { ok: true },
  postflight: { ok: true, readiness: { mode: "full" }, smoke: { ok: true } },
  serviceEnable: { ok: true }
}));

function releaseAssets() {
  return [
    "kaos-headless-host.mjs",
    "kaos-headless-host.mjs.sha256",
    "kaos-headless-host.service",
    "oracle-acceptance-config.example.json",
    "install-headless-host.mjs",
    "bootstrap-headless-host-oracle.mjs",
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
  return ["kaos-headless-host-manifest.json", ...releaseAssets()].map((asset) => ({ asset, sha256: ${JSON.stringify(fakeSha)} }));
}

function releaseManifest() {
  return {
    kind: "kaos-headless-host-release-manifest",
    schemaVersion: 1,
    assets: Object.fromEntries(releaseAssets().map((asset) => [asset, { sha256: ${JSON.stringify(fakeSha)}, bytes: 1 }]))
  };
}
`);
	await writeExecutable(join(bundleDir, "installed-update-wrapper.mjs"), `#!/usr/bin/env node
console.log(JSON.stringify({
  kind: "headless-host-release-update",
  ok: true,
  mode: "postflight-only",
  postflightOnly: true,
  postflight: {
    ok: true,
    readiness: { mode: "verify-running", bootServiceEnabled: true },
    smoke: { ok: true }
  }
}));
`);
	await writeExecutable(join(bundleDir, "smoke-headless-host-sync.mjs"), `#!/usr/bin/env node
console.log(JSON.stringify({
  kind: "headless-host-sync-smoke",
  ok: true,
  completedStages: ["peer-start", "peer-ready", "oracle-to-peer:wait-peer", "peer-to-oracle:wait-primary"]
}));
`);
}

async function writeExecutable(path, content) {
	await writeFile(path, content, "utf8");
	await chmod(path, 0o755);
}

function run(args) {
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}
