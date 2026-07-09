#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-oracle-remote-"));
const fakeSha = "a".repeat(64);

run(process.execPath, ["scripts/build-headless-host.mjs"]);
const tokenFile = join(root, "sync-token");
const secret = "remote-oracle-secret-token";
await writeFile(tokenFile, `${secret}\n`, "utf8");
const identityFile = join(root, "oracle-ssh-key");
await writeFile(identityFile, "fake private key\n", "utf8");
const fakeSsh = join(root, "fake-ssh.mjs");
const fakeScp = join(root, "fake-scp.mjs");
const logPath = join(root, "calls.jsonl");
await writeFakeCommand(fakeSsh, "ssh", logPath, secret);
await writeFakeCommand(fakeScp, "scp", logPath, secret);
await chmod(fakeSsh, 0o755);
await chmod(fakeScp, 0o755);
const builtZip = join(process.cwd(), "dist/kaos-headless-host-oracle.zip");
const builtChecksum = join(process.cwd(), "dist/kaos-headless-host-oracle.zip.sha256");

console.log("\n--- headless host Oracle remote rehearsal: preflight checks VM readiness ---");
const preflight = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"preflight",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-remote-test",
]);
const preflightPayload = JSON.parse(preflight.stdout);
assert.equal(preflightPayload.ok, true);
assert.equal(preflightPayload.phase, "preflight");
assert.equal(preflightPayload.completed.some((step) => step.name === "remote-preflight"), true);
assert.equal(preflightPayload.completed.some((step) => step.name.startsWith("upload-")), false);
assert.match(preflightPayload.nextStep, /--phase install/);
const preflightCalls = await readCalls(logPath);
const preflightScript = preflightCalls.find((call) => call.kind === "ssh").args.at(-1);
assert.match(preflightScript, /command -v node/);
assert.match(preflightScript, /Node\.js 20\+/);
assert.match(preflightScript, /command -v unzip/);
assert.match(preflightScript, /command -v sha256sum/);
assert.match(preflightScript, /sudo -n true/);
assert.match(preflightScript, /systemctl --version/);
assert.match(preflightScript, /00-remote-preflight\.json/);
console.log("  PASS  remote preflight checks Node, system tools, sudo, and log directory");

console.log("\n--- headless host Oracle remote rehearsal: install phase orchestrates upload and remote runner ---");
const install = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-remote-test",
	"--identity-file",
	identityFile,
	"--ssh-port",
	"2222",
	"--ssh-option",
	"StrictHostKeyChecking=accept-new",
	"--ssh-option",
	`UserKnownHostsFile=${join(root, "known_hosts")}`,
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--device-name",
	"oracle-ci",
	"--token-file",
	tokenFile,
]);
const installPayload = JSON.parse(install.stdout);
assert.equal(installPayload.kind, "headless-host-oracle-remote-rehearsal");
assert.equal(installPayload.ok, true);
assert.equal(installPayload.phase, "install");
assert.equal(installPayload.remoteDir, "kaos-remote-test");
assert.equal(installPayload.completed.some((step) => step.name === "local-upload-prepare"), true);
assert.equal(installPayload.completed.some((step) => step.name === "remote-preflight"), true);
assert.equal(installPayload.completed.some((step) => step.name === "upload-token"), true);
assert.equal(installPayload.completed.some((step) => step.stdout.includes("[redacted]")), true);
assert.equal(JSON.stringify(installPayload).includes(secret), false);
const remoteInstallStep = installPayload.completed.find((step) => step.name === "remote-install-rehearsal");
assert.deepEqual(remoteInstallStep.args, [
	"-i",
	identityFile,
	"-p",
	"2222",
	"-o",
	"StrictHostKeyChecking=accept-new",
	"-o",
	`UserKnownHostsFile=${join(root, "known_hosts")}`,
	"opc@example.invalid",
	"[remote-script:remote-install-rehearsal]",
]);
assert.equal(JSON.stringify(remoteInstallStep).includes("run-headless-host-oracle-rehearsal.mjs"), false);
assert.equal(JSON.stringify(installPayload.completed.find((step) => step.name === "upload-token")).includes(tokenFile), false);
const installCalls = await readCalls(logPath);
assert.equal(installCalls.filter((call) => call.kind === "scp").length, 3);
const installOptionSshCalls = installCalls.filter((call) => call.kind === "ssh" && call.args.includes(identityFile));
assert.equal(installOptionSshCalls.length, 2);
assert.equal(installOptionSshCalls.every((call) => call.args[0] === "-i" && call.args[1] === identityFile && call.args[2] === "-p" && call.args[3] === "2222"), true);
assert.equal(installOptionSshCalls.every((call) => call.args.includes("StrictHostKeyChecking=accept-new") && call.args.includes(`UserKnownHostsFile=${join(root, "known_hosts")}`)), true);
const installScpCalls = installCalls.filter((call) => call.kind === "scp");
assert.equal(installScpCalls.every((call) => call.args[0] === "-i" && call.args[1] === identityFile && call.args[2] === "-P" && call.args[3] === "2222"), true);
assert.equal(installScpCalls.every((call) => call.args.includes("StrictHostKeyChecking=accept-new") && call.args.includes(`UserKnownHostsFile=${join(root, "known_hosts")}`)), true);
const installSshScripts = installCalls.filter((call) => call.kind === "ssh").map((call) => call.args.at(-1)).join("\n---\n");
assert.match(installSshScripts, /sha256sum -c kaos-headless-host-oracle\.zip\.sha256/);
assert.match(installSshScripts, /run-headless-host-oracle-rehearsal\.mjs/);
assert.match(installSshScripts, /--phase install/);
assert.match(installSshScripts, /--host https:\/\/worker\.example\.invalid/);
assert.match(installSshScripts, /--vault-id vault-remote/);
assert.match(installSshScripts, /trap 'rm -f "\$TOKEN_FILE"' EXIT/);
assert.match(installPayload.nextStep, /--phase post-reboot/);
assert.match(installPayload.nextStep, /--wait-for-ssh/);
console.log("  PASS  remote install phase is reproducible and redacts token material");

console.log("\n--- headless host Oracle remote rehearsal: reboot phase requests structured reboot ---");
const reboot = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"reboot",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-reboot-test",
	"--secret-file",
	tokenFile,
]);
const rebootPayload = JSON.parse(reboot.stdout);
assert.equal(rebootPayload.ok, true);
assert.equal(rebootPayload.phase, "reboot");
assert.equal(rebootPayload.completed.some((step) => step.name === "remote-reboot-request"), true);
assert.equal(rebootPayload.completed.some((step) => step.name.startsWith("upload-")), false);
assert.match(rebootPayload.nextStep, /--phase post-reboot/);
assert.match(rebootPayload.nextStep, /--wait-for-ssh/);
assert.equal(JSON.stringify(rebootPayload).includes(secret), false);
const rebootCalls = await readCalls(logPath);
const rebootScript = rebootCalls.filter((call) => call.kind === "ssh").map((call) => call.args.at(-1)).find((script) => script.includes("11-reboot-request.json"));
assert.match(rebootScript, /headless-host-oracle-remote-reboot-request/);
assert.match(rebootScript, /sudo -n true/);
assert.match(rebootScript, /systemctl reboot --no-wall/);
console.log("  PASS  reboot phase records a reboot request and points to post-reboot wait");

console.log("\n--- headless host Oracle remote rehearsal: reboot phase refuses evidence fetch ---");
const rebootFetch = spawnSync(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"reboot",
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-reboot-fetch-test",
	"--evidence-dir",
	join(root, "reboot-fetch"),
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(rebootFetch.status, 0, "reboot phase must not fetch evidence while the VM is going down");
const rebootFetchPayload = JSON.parse(rebootFetch.stderr);
assert.equal(rebootFetchPayload.failedStep, "fatal");
assert.match(rebootFetchPayload.error, /not supported during reboot phase/);
console.log("  PASS  reboot phase keeps evidence fetch in the post-reboot phase");

console.log("\n--- headless host Oracle remote rehearsal: release asset mode can skip local prepare ---");
const releaseMode = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-release-asset-test",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--token-file",
	tokenFile,
	"--zip",
	builtZip,
	"--checksum",
	builtChecksum,
	"--skip-local-prepare",
]);
const releaseModePayload = JSON.parse(releaseMode.stdout);
assert.equal(releaseModePayload.ok, true);
const releaseModeValidation = releaseModePayload.completed.find((step) => step.name === "local-release-assets-validate");
assert.equal(releaseModeValidation?.status, 0);
assert.match(releaseModeValidation.stdout, /headless-host-release-assets-validate/);
assert.equal(releaseModePayload.completed.find((step) => step.name === "local-upload-prepare")?.skipped, true);
assert.equal(releaseModePayload.completed.some((step) => step.name === "upload-zip"), true);
assert.equal(releaseModePayload.completed.some((step) => step.name === "remote-install-rehearsal"), true);
console.log("  PASS  release asset mode skips repo-local prepare but still uploads and runs install");

console.log("\n--- headless host Oracle remote rehearsal: release directory resolves adjacent verifier ---");
const releaseAssetDir = join(root, "release-assets");
await mkdir(releaseAssetDir, { recursive: true });
await copyFile("scripts/run-headless-host-oracle-remote-rehearsal.mjs", join(releaseAssetDir, "run-headless-host-oracle-remote-rehearsal.mjs"));
await copyFile("scripts/verify-headless-host-oracle-rehearsal.mjs", join(releaseAssetDir, "verify-headless-host-oracle-rehearsal.mjs"));
await copyFile("scripts/verify-headless-host-bundle.mjs", join(releaseAssetDir, "verify-headless-host-bundle.mjs"));
await copyFile("scripts/validate-headless-host-release-assets.mjs", join(releaseAssetDir, "validate-headless-host-release-assets.mjs"));
const releaseDirFetch = join(root, "release-dir-fetched");
const releaseDirRun = run(process.execPath, [
	"run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-release-dir-test",
	"--zip",
	builtZip,
	"--checksum",
	builtChecksum,
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--token-file",
	tokenFile,
	"--skip-local-prepare",
	"--evidence-dir",
	releaseDirFetch,
], {
	cwd: releaseAssetDir,
});
const releaseDirPayload = JSON.parse(releaseDirRun.stdout);
assert.equal(releaseDirPayload.ok, true);
const releaseDirValidation = releaseDirPayload.completed.find((step) => step.name === "local-release-assets-validate");
assert.equal(releaseDirValidation?.status, 0);
assert.match(releaseDirValidation.stdout, /headless-host-release-assets-validate/);
assert.equal(releaseDirPayload.completed.find((step) => step.name === "local-upload-prepare")?.skipped, true);
const releaseDirVerify = releaseDirPayload.completed.find((step) => step.name === "verify-fetched-logs");
assert.ok(releaseDirVerify.args[0].endsWith("verify-headless-host-oracle-rehearsal.mjs"));
assert.equal(releaseDirVerify.args[0].includes("/scripts/"), false);
console.log("  PASS  release directory mode finds adjacent verifier without repo scripts/");

console.log("\n--- headless host Oracle remote rehearsal: install evidence verifies before reboot ---");
const installFetchDir = join(root, "install-fetched");
const installEvidence = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-install-evidence-test",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--device-name",
	"oracle-ci",
	"--token-file",
	tokenFile,
	"--evidence-dir",
	installFetchDir,
]);
const installEvidencePayload = JSON.parse(installEvidence.stdout);
assert.equal(installEvidencePayload.ok, true);
assert.equal(installEvidencePayload.phase, "install");
assert.equal(installEvidencePayload.fetchLogDir, installFetchDir);
assert.equal(installEvidencePayload.verifiedFetchedLogs, true);
assert.equal(installEvidencePayload.completed.some((step) => step.name === "fetch-rehearsal-logs"), true);
const verifyInstallStep = installEvidencePayload.completed.find((step) => step.name === "verify-fetched-logs");
assert.deepEqual(verifyInstallStep.args, [
	"scripts/verify-headless-host-oracle-rehearsal.mjs",
	"--log-dir",
	installFetchDir,
	"--mode",
	"install",
	"--secret-file",
	"[secret-file]",
]);
console.log("  PASS  remote install evidence uses install-mode verification");

console.log("\n--- headless host Oracle remote rehearsal: update phase reuses installed config ---");
const updateFetchDir = join(root, "update-fetched");
const update = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"update",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-update-test",
	"--install-dir",
	"/opt/custom-kaos",
	"--service-path",
	"/etc/systemd/system/custom-kaos.service",
	"--evidence-dir",
	updateFetchDir,
]);
const updatePayload = JSON.parse(update.stdout);
assert.equal(updatePayload.ok, true);
assert.equal(updatePayload.phase, "update");
assert.equal(updatePayload.verifiedFetchedLogs, true);
assert.equal(updatePayload.completed.some((step) => step.name === "remote-preflight"), true);
assert.equal(updatePayload.completed.some((step) => step.name === "upload-token"), false);
assert.equal(updatePayload.completed.some((step) => step.name === "remote-update-rehearsal"), true);
const verifyUpdateStep = updatePayload.completed.find((step) => step.name === "verify-fetched-logs");
assert.deepEqual(verifyUpdateStep.args, [
	"scripts/verify-headless-host-oracle-rehearsal.mjs",
	"--log-dir",
	updateFetchDir,
	"--mode",
	"update",
]);
const updateCalls = await readCalls(logPath);
const updateScript = updateCalls.filter((call) => call.kind === "ssh").map((call) => call.args.at(-1)).find((script) => script.includes("--phase update"));
assert.match(updateScript, /run-headless-host-oracle-rehearsal\.mjs/);
assert.match(updateScript, /--phase update/);
assert.match(updateScript, /--install-dir \/opt\/custom-kaos/);
assert.match(updateScript, /--service-path \/etc\/systemd\/system\/custom-kaos\.service/);
assert.equal(updateScript.includes("--host"), false);
assert.equal(updateCalls.filter((call) => call.kind === "scp" && call.args.some((arg) => arg.includes("kaos-update-test"))).length >= 3, true);
console.log("  PASS  remote update phase reuses existing VM sync config and verifies update evidence");

console.log("\n--- headless host Oracle remote rehearsal: post-reboot phase fetches evidence ---");
const fetchDir = join(root, "fetched");
const postReboot = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"post-reboot",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-remote-test",
	"--service",
	"custom-kaos",
	"--journal-since",
	"2 hours ago",
	"--smoke-work-dir",
	"/var/lib/custom-kaos/smoke-work",
	"--fetch-log-dir",
	fetchDir,
	"--verify-fetched-logs",
	"--require-reboot-request",
	"--secret-file",
	tokenFile,
]);
const postPayload = JSON.parse(postReboot.stdout);
assert.equal(postPayload.ok, true);
assert.equal(postPayload.phase, "post-reboot");
assert.equal(postPayload.fetchLogDir, fetchDir);
assert.equal(postPayload.verifiedFetchedLogs, true);
assert.equal(postPayload.completed.some((step) => step.name === "remote-post-reboot-rehearsal"), true);
assert.equal(postPayload.completed.some((step) => step.name === "fetch-rehearsal-logs"), true);
const verifyFetchedStep = postPayload.completed.find((step) => step.name === "verify-fetched-logs");
assert.ok(verifyFetchedStep);
assert.deepEqual(verifyFetchedStep.args, [
	"scripts/verify-headless-host-oracle-rehearsal.mjs",
	"--log-dir",
	fetchDir,
	"--require-reboot-request",
	"--secret-file",
	"[secret-file]",
]);
assert.match(verifyFetchedStep.stdout, /headless-host-oracle-rehearsal-verify/);
const postCalls = await readCalls(logPath);
const postScript = postCalls.filter((call) => call.kind === "ssh").at(-1).args.at(-1);
assert.match(postScript, /--phase post-reboot/);
assert.match(postScript, /--log-dir "\$REMOTE_DIR"/);
assert.match(postScript, /INSTALLED_RUNNER=\/opt\/kaos\/run-headless-host-oracle-rehearsal\.mjs/);
assert.match(postScript, /test -r "\$INSTALLED_RUNNER"/);
assert.match(postScript, /node "\$INSTALLED_RUNNER"/);
assert.match(postScript, /--service custom-kaos/);
assert.match(postScript, /--journal-since '2 hours ago'/);
assert.match(postScript, /--smoke-work-dir \/var\/lib\/custom-kaos\/smoke-work/);
assert.equal(postCalls.some((call) => call.kind === "scp" && call.args.includes("-r")), true);
assert.equal(postCalls.some((call) => call.kind === "scp" && call.args.some((arg) => arg.endsWith("kaos-remote-test/."))), true);
console.log("  PASS  remote post-reboot phase runs verifier path and verifies fetched evidence");

console.log("\n--- headless host Oracle remote rehearsal: post-reboot can wait for SSH readiness ---");
const flakyWaitSsh = join(root, "flaky-wait-ssh.mjs");
const waitLogPath = join(root, "wait-calls.jsonl");
const waitStatePath = join(root, "wait-state.txt");
await writeFile(flakyWaitSsh, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(waitLogPath)}, JSON.stringify({ kind: "ssh", args }) + "\\n");
const script = args.at(-1) ?? "";
let attempts = 0;
try { attempts = Number(readFileSync(${JSON.stringify(waitStatePath)}, "utf8")) || 0; } catch {}
attempts += 1;
writeFileSync(${JSON.stringify(waitStatePath)}, String(attempts));
console.log(${JSON.stringify(secret)} + " appeared during wait");
process.exit(script === "true" && attempts < 3 ? 255 : 0);
`, "utf8");
await chmod(flakyWaitSsh, 0o755);
const waitPostReboot = run(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--phase",
	"post-reboot",
	"--ssh",
	flakyWaitSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-wait-test",
	"--wait-for-ssh",
	"--wait-ssh-interval-ms",
	"1",
	"--wait-ssh-timeout-ms",
	"5000",
	"--wait-ssh-connect-timeout-sec",
	"1",
	"--secret-file",
	tokenFile,
]);
const waitPayload = JSON.parse(waitPostReboot.stdout);
assert.equal(waitPayload.ok, true);
const waitStep = waitPayload.completed.find((step) => step.name === "wait-for-ssh");
assert.equal(waitStep?.attempts, 3);
assert.equal(JSON.stringify(waitStep).includes(secret), false);
assert.equal(waitPayload.completed.some((step) => step.name === "remote-post-reboot-rehearsal"), true);
const waitCalls = await readCalls(waitLogPath);
assert.equal(waitCalls.filter((call) => call.args.at(-1) === "true").length, 3);
assert.equal(waitCalls.some((call) => call.args.includes("BatchMode=yes") && call.args.includes("ConnectTimeout=1")), true);
assert.equal(waitCalls.some((call) => String(call.args.at(-1)).includes("--phase post-reboot")), true);
console.log("  PASS  post-reboot waits for SSH readiness before running evidence capture");

console.log("\n--- headless host Oracle remote rehearsal: failed remote phase still fetches evidence ---");
const conditionalSsh = join(root, "conditional-ssh.mjs");
await writeFile(conditionalSsh, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: "ssh", args }) + "\\n");
const script = args.at(-1) ?? "";
console.log(${JSON.stringify(secret)} + " appeared before remote install failed");
process.exit(script.includes("--phase install") ? 42 : 0);
`, "utf8");
await chmod(conditionalSsh, 0o755);
const failedInstallFetchDir = join(root, "failed-install-fetched");
const failedInstall = spawnSync(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	conditionalSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-failed-install-test",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--token-file",
	tokenFile,
	"--evidence-dir",
	failedInstallFetchDir,
], {
	encoding: "utf8",
	timeout: 120_000,
});
assert.notEqual(failedInstall.status, 0, "failed remote install must fail the wrapper");
assert.equal(failedInstall.stderr.includes(secret), false, "failed wrapper output must redact token material");
const failedInstallPayload = JSON.parse(failedInstall.stderr);
assert.equal(failedInstallPayload.failedStep, "remote-install-rehearsal");
assert.equal(failedInstallPayload.phase, "install");
assert.equal(failedInstallPayload.remoteDir, "kaos-failed-install-test");
assert.equal(failedInstallPayload.fetchLogDir, failedInstallFetchDir);
assert.equal(failedInstallPayload.failureEvidenceFetch.ok, true);
assert.equal(failedInstallPayload.failureEvidenceFetch.destination, failedInstallFetchDir);
assert.equal(JSON.parse(await readFile(join(failedInstallFetchDir, "05-install-postflight.json"), "utf8")).postflight.smoke.ok, true);
console.log("  PASS  failed remote install fetches evidence before returning failure");

console.log("\n--- headless host Oracle remote rehearsal: requires token for install ---");
const missingToken = spawnSync(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh-target",
	"opc@example.invalid",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(missingToken.status, 0, "install phase must require a token file");
const missingPayload = JSON.parse(missingToken.stderr);
assert.equal(missingPayload.kind, "headless-host-oracle-remote-rehearsal");
assert.equal(missingPayload.ok, false);
assert.equal(missingPayload.failedStep, "fatal");
assert.match(missingPayload.error, /--token-file is required/);
console.log("  PASS  remote install phase fails closed without token input");

console.log("\n--- headless host Oracle remote rehearsal: release asset mode requires explicit bundle paths ---");
const implicitSkipPrepare = spawnSync(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	fakeSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-release-implicit-test",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--token-file",
	tokenFile,
	"--skip-local-prepare",
], {
	encoding: "utf8",
	timeout: 30_000,
});
assert.notEqual(implicitSkipPrepare.status, 0, "skip-local-prepare must require explicit zip/checksum");
const implicitSkipPreparePayload = JSON.parse(implicitSkipPrepare.stderr);
assert.equal(implicitSkipPreparePayload.failedStep, "fatal");
assert.match(implicitSkipPreparePayload.error, /explicit --zip and --checksum/);
console.log("  PASS  release asset mode refuses implicit dist bundle paths");

console.log("\n--- headless host Oracle remote rehearsal: ssh failures keep scripts out of diagnostics ---");
const failingSsh = join(root, "failing-ssh.mjs");
const failLogPath = join(root, "fail-calls.jsonl");
await writeFakeCommand(failingSsh, "ssh", failLogPath, secret, { exitStatus: 42 });
await chmod(failingSsh, 0o755);
const sshFailure = spawnSync(process.execPath, [
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"--ssh",
	failingSsh,
	"--scp",
	fakeScp,
	"--ssh-target",
	"opc@example.invalid",
	"--remote-dir",
	"kaos-remote-test",
	"--worker-host",
	"https://worker.example.invalid",
	"--vault-id",
	"vault-remote",
	"--token-file",
	tokenFile,
], {
	encoding: "utf8",
	timeout: 120_000,
});
assert.notEqual(sshFailure.status, 0, "ssh failure must fail the remote rehearsal");
const sshFailurePayload = JSON.parse(sshFailure.stderr);
assert.equal(sshFailurePayload.failedStep, "remote-preflight");
assert.deepEqual(sshFailurePayload.step.args, ["opc@example.invalid", "[remote-script:remote-preflight]"]);
assert.equal(JSON.stringify(sshFailurePayload).includes("mkdir -p"), false);
assert.equal(JSON.stringify(sshFailurePayload).includes(secret), false);
assert.match(sshFailurePayload.step.stdout, /\[redacted\]/);
console.log("  PASS  ssh failure diagnostics stay concise and redact token material");

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

async function writeFakeCommand(path, kind, logPath, secret, { exitStatus = 0 } = {}) {
	await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, args }) + "\\n");
if (${JSON.stringify(kind === "scp")} && args.includes("-r")) {
  const dest = args.at(-1);
  mkdirSync(dest, { recursive: true });
  writeRehearsalEvidence(dest);
}
console.log(${JSON.stringify(secret)} + " appeared in fake " + ${JSON.stringify(kind)} + " output");
process.exit(${JSON.stringify(exitStatus)});

function writeRehearsalEvidence(dir) {
  writeFileSync(join(dir, "01-zip-sha256.txt"), "kaos-headless-host-oracle.zip: OK\\n");
  writeFileSync(join(dir, "02-bundle-verify.json"), JSON.stringify({
    kind: "headless-host-bundle-verify",
    ok: true,
    checked: [{ asset: "kaos-headless-host.mjs", ok: true }],
    releaseChecks: [{ asset: "kaos-headless-host.mjs", ok: true }],
    checksumCheck: { ok: true }
  }));
  writeFileSync(join(dir, "03-bootstrap.json"), JSON.stringify({ kind: "headless-host-oracle-bootstrap", ok: true }));
  writeFileSync(join(dir, "04-secret-permissions.txt"), "root:kaos 640 /etc/kaos/headless.env\\nroot:kaos 640 /etc/kaos/sync-token\\n");
  writeFileSync(join(dir, "05-install-postflight.json"), JSON.stringify({
    kind: "headless-host-release-update",
    ok: true,
    bundleVerification: { ok: true },
    install: { ok: true },
    postflight: { ok: true, readiness: { mode: "full" }, smoke: { ok: true } },
    serviceEnable: { ok: true }
  }));
  writeFileSync(join(dir, "06-install-metadata.json"), JSON.stringify({
    kind: "headless-host-release-install",
    downloaded: releaseDownloaded(),
    manifest: releaseManifest(),
    bundleVerification: { ok: true },
    install: { ok: true, sha256: ${JSON.stringify(fakeSha)} },
    helpers: [{ target: "/opt/kaos/postflight-headless-host.mjs", sourceSha256: ${JSON.stringify(fakeSha)}, installedSha256: ${JSON.stringify(fakeSha)} }]
  }));
  writeFileSync(join(dir, "07-post-reboot-verify-running.json"), JSON.stringify({
    kind: "headless-host-release-update",
    ok: true,
    mode: "postflight-only",
    postflightOnly: true,
    verifiedAt: "2026-07-09T00:05:00.000Z",
    postflight: {
      ok: true,
      readiness: { mode: "verify-running", bootServiceEnabled: true },
      smoke: { ok: true }
    }
  }));
  writeFileSync(join(dir, "08-operational-smoke.json"), JSON.stringify({
    kind: "headless-host-sync-smoke",
    ok: true,
    completedStages: ["oracle-to-peer:wait-peer", "peer-to-oracle:wait-primary"]
  }));
  writeFileSync(join(dir, "09-systemctl-status.txt"), [
    "* kaos-headless-host.service - KAOS Headless Host",
    "     Loaded: loaded (/etc/systemd/system/kaos-headless-host.service; enabled)",
    "     Active: active (running) since Thu 2026-07-09 00:00:00 UTC",
    ""
  ].join("\\n"));
  writeFileSync(join(dir, "10-journalctl.txt"), [
    "Jul 09 00:00:00 oracle kaos-headless-host[100]: ready",
    ""
  ].join("\\n"));
  writeFileSync(join(dir, "11-reboot-request.json"), JSON.stringify({
    kind: "headless-host-oracle-remote-reboot-request",
    ok: true,
    remoteDir: "kaos-remote-test",
    requestedAt: "2026-07-09T00:00:00.000Z",
    sudoPath: "/usr/bin/sudo",
    systemctlPath: "/usr/bin/systemctl"
  }));
}

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
`, "utf8");
}

async function readCalls(path) {
	const text = await readFile(path, "utf8");
	return text.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}
