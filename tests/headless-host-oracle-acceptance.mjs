#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-oracle-acceptance-"));
const fakeSha = "a".repeat(64);

try {
	run(process.execPath, ["scripts/build-headless-host.mjs"]);
	const tokenFile = join(root, "sync-token");
	const secret = "acceptance-oracle-secret-token";
	await writeFile(tokenFile, `${secret}\n`, "utf8");
	const fakeSsh = join(root, "fake-ssh.mjs");
	const fakeScp = join(root, "fake-scp.mjs");
	const logPath = join(root, "calls.jsonl");
	await writeFakeCommand(fakeSsh, "ssh", logPath, secret);
	await writeFakeCommand(fakeScp, "scp", logPath, secret);
	await chmod(fakeSsh, 0o755);
	await chmod(fakeScp, 0o755);

	console.log("\n--- headless host Oracle acceptance: refuses implicit reboot ---");
	const missingConfirm = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(missingConfirm.status, 0, "acceptance must require explicit reboot confirmation");
	const missingConfirmPayload = JSON.parse(missingConfirm.stderr);
	assert.match(missingConfirmPayload.error, /--confirm-reboot is required/);
	console.log("  PASS  full acceptance requires explicit reboot confirmation");

	console.log("\n--- headless host Oracle acceptance: dry-run plans without remote side effects ---");
	const dryRun = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-dry-run-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--evidence-root",
		join(root, "dry-run-evidence"),
		"--dry-run",
	]);
	const dryRunPayload = JSON.parse(dryRun.stdout);
	assert.equal(dryRunPayload.ok, true);
	assert.equal(dryRunPayload.dryRun, true);
	assert.equal(dryRunPayload.requiresConfirmReboot, true);
	assert.equal(dryRunPayload.confirmedReboot, false);
	assert.deepEqual(dryRunPayload.phases, ["preflight", "install", "reboot", "post-reboot", "update"]);
	assert.equal(dryRunPayload.planned.length, 5);
	assert.equal(dryRunPayload.planned.find((step) => step.phase === "install").args.includes("--evidence-dir"), true);
	assert.equal(dryRunPayload.planned.find((step) => step.phase === "post-reboot").args.includes("--require-reboot-request"), true);
	assert.match(dryRunPayload.nextStep, /rerun without --dry-run/);
	assert.equal(JSON.stringify(dryRunPayload).includes(secret), false);
	assert.equal(existsSync(logPath), false, "dry-run must not invoke ssh/scp");
	assert.equal(existsSync(dryRunPayload.summaryFile), false, "dry-run must not write an acceptance summary file");
	const releaseDryRun = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-release-dir-dry-run-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--release-dir",
		root,
		"--dry-run",
	]);
	const releaseDryRunPayload = JSON.parse(releaseDryRun.stdout);
	const releaseInstallPlan = releaseDryRunPayload.planned.find((step) => step.phase === "install");
	assert.equal(releaseDryRunPayload.releaseDir, root);
	assert.equal(releaseInstallPlan.args.includes("--skip-local-prepare"), true);
	assert.equal(releaseInstallPlan.args.includes("--zip"), true);
	assert.equal(releaseInstallPlan.args.includes(join(root, "kaos-headless-host-oracle.zip")), true);
	assert.equal(releaseInstallPlan.args.includes("--checksum"), true);
	assert.equal(releaseInstallPlan.args.includes(join(root, "kaos-headless-host-oracle.zip.sha256")), true);
	assert.equal(existsSync(releaseDryRunPayload.summaryFile), false, "release-dir dry-run must not write an acceptance summary file");
	const configDir = join(root, "config");
	await mkdir(configDir, { recursive: true });
	const configFile = join(configDir, "oracle-acceptance.json");
	await writeFile(configFile, `${JSON.stringify({
		sshTarget: "opc@config.example.invalid",
		remoteDir: "kaos-config-remote",
		updateRemoteDir: "kaos-config-update",
		workerHost: "https://worker.config.example.invalid",
		vaultId: "vault-config",
		deviceName: "oracle-config-ci",
		tokenFile: "../sync-token",
		evidenceRoot: "evidence-from-config",
		releaseDir: "..",
		waitSshIntervalMs: 1,
		waitSshTimeoutMs: 5000,
		sshOption: ["StrictHostKeyChecking=accept-new"],
	}, null, 2)}\n`, "utf8");
	const configDryRun = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--config",
		configFile,
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--remote-dir",
		"kaos-cli-remote",
		"--dry-run",
	]);
	const configDryRunPayload = JSON.parse(configDryRun.stdout);
	const configInstallPlan = configDryRunPayload.planned.find((step) => step.phase === "install");
	assert.equal(configDryRunPayload.configFile, configFile);
	assert.equal(configDryRunPayload.sshTarget, "opc@config.example.invalid");
	assert.equal(configDryRunPayload.remoteDir, "kaos-cli-remote");
	assert.equal(configDryRunPayload.updateRemoteDir, "kaos-config-update");
	assert.equal(configDryRunPayload.evidenceRoot, join(configDir, "evidence-from-config"));
	assert.equal(configDryRunPayload.releaseDir, root);
	assert.equal(configInstallPlan.args.includes("--worker-host"), true);
	assert.equal(configInstallPlan.args.includes("https://worker.config.example.invalid"), true);
	assert.equal(configInstallPlan.args.includes("--vault-id"), true);
	assert.equal(configInstallPlan.args.includes("vault-config"), true);
	assert.equal(configInstallPlan.args.includes("--token-file"), true);
	assert.equal(configInstallPlan.args.includes("[token-file]"), true);
	assert.equal(configInstallPlan.args.includes("--ssh-option"), true);
	assert.equal(configInstallPlan.args.includes("StrictHostKeyChecking=accept-new"), true);
	assert.equal(configInstallPlan.args.includes(join(root, "kaos-headless-host-oracle.zip")), true);
	assert.equal(existsSync(configDryRunPayload.summaryFile), false, "config dry-run must not write an acceptance summary file");
	console.log("  PASS  dry-run shows the full acceptance plan without touching the VM");

	console.log("\n--- headless host Oracle acceptance: local validation catches config and asset drift ---");
	const callsBeforeLocalValidate = await readCalls(logPath).catch(() => []);
	const localValidate = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--validate-local",
	]);
	const localValidatePayload = JSON.parse(localValidate.stdout);
	assert.equal(localValidatePayload.kind, "headless-host-oracle-acceptance-local-validate");
	assert.equal(localValidatePayload.ok, true);
	assert.equal(localValidatePayload.requiresConfirmReboot, true);
	assert.equal(localValidatePayload.confirmedReboot, false);
	assert.ok(localValidatePayload.checks.some((check) => check.name === "file:token-file" && check.ok));
	assert.ok(localValidatePayload.checks.some((check) => check.name === "local-upload-prepare" && check.ok));
	const releaseLocalValidate = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-release-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--release-dir",
		"dist",
		"--validate-local",
	]);
	const releaseLocalValidatePayload = JSON.parse(releaseLocalValidate.stdout);
	assert.equal(releaseLocalValidatePayload.ok, true);
	assert.ok(releaseLocalValidatePayload.checks.some((check) => check.name === "release-zip:checksum" && check.ok));
	assert.ok(releaseLocalValidatePayload.checks.some((check) => check.name === "release-bundle-verify" && check.ok));
	assert.ok(releaseLocalValidatePayload.checks.some((check) => check.name === "helper:oracle-rehearsal-verifier" && check.ok));
	const selfContainedReleaseDir = join(root, "self-contained-release-dir");
	await mkdir(selfContainedReleaseDir, { recursive: true });
	for (const [source, target] of [
		["dist/kaos-headless-host-oracle.zip", "kaos-headless-host-oracle.zip"],
		["dist/kaos-headless-host-oracle.zip.sha256", "kaos-headless-host-oracle.zip.sha256"],
		["scripts/run-headless-host-oracle-acceptance.mjs", "run-headless-host-oracle-acceptance.mjs"],
		["scripts/run-headless-host-oracle-remote-rehearsal.mjs", "run-headless-host-oracle-remote-rehearsal.mjs"],
		["scripts/verify-headless-host-oracle-rehearsal.mjs", "verify-headless-host-oracle-rehearsal.mjs"],
		["scripts/verify-headless-host-bundle.mjs", "verify-headless-host-bundle.mjs"],
		["scripts/validate-headless-host-release-assets.mjs", "validate-headless-host-release-assets.mjs"],
	]) {
		await copyFile(source, join(selfContainedReleaseDir, target));
	}
	const selfContainedValidate = run(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-self-contained-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--release-dir",
		".",
		"--validate-local",
	], {
		cwd: selfContainedReleaseDir,
	});
	const selfContainedValidatePayload = JSON.parse(selfContainedValidate.stdout);
	assert.equal(selfContainedValidatePayload.ok, true);
	assert.equal(selfContainedValidatePayload.releaseDir.endsWith("/self-contained-release-dir"), true);
	assert.ok(selfContainedValidatePayload.checks.some((check) => check.name === "release-assets-validate" && check.ok));
	assert.ok(selfContainedValidatePayload.checks.some((check) => check.name === "release-bundle-verify" && check.ok));
	assert.ok(selfContainedValidatePayload.checks.some((check) => check.name === "helper:remote-rehearsal" && check.ok));
	assert.ok(selfContainedValidatePayload.checks.some((check) => check.name === "helper:oracle-rehearsal-verifier" && check.ok));
	const badBundleReleaseDir = join(root, "bad-bundle-release-dir");
	await mkdir(badBundleReleaseDir, { recursive: true });
	await copyFile(
		"scripts/run-headless-host-oracle-acceptance.mjs",
		join(badBundleReleaseDir, "run-headless-host-oracle-acceptance.mjs"),
	);
	await copyFile(
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
		join(badBundleReleaseDir, "run-headless-host-oracle-remote-rehearsal.mjs"),
	);
	await copyFile(
		"scripts/verify-headless-host-oracle-rehearsal.mjs",
		join(badBundleReleaseDir, "verify-headless-host-oracle-rehearsal.mjs"),
	);
	await copyFile(
		"scripts/verify-headless-host-bundle.mjs",
		join(badBundleReleaseDir, "verify-headless-host-bundle.mjs"),
	);
	await copyFile(
		"scripts/validate-headless-host-release-assets.mjs",
		join(badBundleReleaseDir, "validate-headless-host-release-assets.mjs"),
	);
	const badBundleZip = zipSync({
		"verify-headless-host-bundle.mjs": await readFile("scripts/verify-headless-host-bundle.mjs"),
		"kaos-headless-host-bundle-manifest.json": Buffer.from(`${JSON.stringify({
			kind: "kaos-headless-host-oracle-bundle",
			schemaVersion: 1,
			runtime: "kaos-headless-host",
			assets: { "kaos-headless-host.mjs": { sha256: fakeSha, bytes: 1 } },
		}, null, 2)}\n`),
		"kaos-headless-host-manifest.json": Buffer.from(`${JSON.stringify({
			kind: "kaos-headless-host-release-manifest",
			schemaVersion: 1,
			runtime: "kaos-headless-host",
			assets: { "kaos-headless-host.mjs": { sha256: fakeSha, bytes: 1 } },
		}, null, 2)}\n`),
		"kaos-headless-host.mjs.sha256": Buffer.from(`${fakeSha}  kaos-headless-host.mjs\n`),
	});
	await writeFile(join(badBundleReleaseDir, "kaos-headless-host-oracle.zip"), badBundleZip);
	await writeFile(
		join(badBundleReleaseDir, "kaos-headless-host-oracle.zip.sha256"),
		`${sha256Bytes(badBundleZip)}  kaos-headless-host-oracle.zip\n`,
		"utf8",
	);
	const badBundleValidate = spawnSync(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-bad-bundle-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--release-dir",
		".",
		"--validate-local",
	], {
		cwd: badBundleReleaseDir,
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(badBundleValidate.status, 0, "local validation must reject checksum-valid but bundle-invalid release zips");
	const badBundleValidatePayload = JSON.parse(badBundleValidate.stderr);
	assert.equal(badBundleValidatePayload.ok, false);
	assert.ok(badBundleValidatePayload.failedChecks.some((check) => check.name === "release-bundle-verify"));
	const missingVerifierReleaseDir = join(root, "missing-verifier-release-dir");
	await mkdir(missingVerifierReleaseDir, { recursive: true });
	await copyFile("dist/kaos-headless-host-oracle.zip", join(missingVerifierReleaseDir, "kaos-headless-host-oracle.zip"));
	await copyFile("dist/kaos-headless-host-oracle.zip.sha256", join(missingVerifierReleaseDir, "kaos-headless-host-oracle.zip.sha256"));
	await copyFile(
		"scripts/run-headless-host-oracle-acceptance.mjs",
		join(missingVerifierReleaseDir, "run-headless-host-oracle-acceptance.mjs"),
	);
	await copyFile(
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
		join(missingVerifierReleaseDir, "run-headless-host-oracle-remote-rehearsal.mjs"),
	);
	await copyFile(
		"scripts/verify-headless-host-bundle.mjs",
		join(missingVerifierReleaseDir, "verify-headless-host-bundle.mjs"),
	);
	await copyFile(
		"scripts/validate-headless-host-release-assets.mjs",
		join(missingVerifierReleaseDir, "validate-headless-host-release-assets.mjs"),
	);
	const missingVerifierValidate = spawnSync(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-missing-verifier-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--release-dir",
		".",
		"--validate-local",
	], {
		cwd: missingVerifierReleaseDir,
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(missingVerifierValidate.status, 0, "local validation must fail when release-dir mode lacks the verifier helper");
	const missingVerifierValidatePayload = JSON.parse(missingVerifierValidate.stderr);
	assert.equal(missingVerifierValidatePayload.ok, false);
	assert.ok(missingVerifierValidatePayload.failedChecks.some((check) => check.name === "helper:oracle-rehearsal-verifier"));
	const missingTokenValidate = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-missing-token-local-validate-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		join(root, "missing-token"),
		"--validate-local",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(missingTokenValidate.status, 0, "local validation must fail for a missing token file");
	const missingTokenValidatePayload = JSON.parse(missingTokenValidate.stderr);
	assert.equal(missingTokenValidatePayload.ok, false);
	assert.ok(missingTokenValidatePayload.failedChecks.some((check) => check.name === "file:token-file"));
	const placeholderConfigFile = join(configDir, "placeholder-acceptance.json");
	await writeFile(placeholderConfigFile, `${JSON.stringify({
		sshTarget: "opc@YOUR_ORACLE_VM",
		remoteDir: "kaos-headless-acceptance-YYYYMMDDTHHMMSSZ",
		workerHost: "https://YOUR_WORKER_HOST",
		vaultId: "YOUR_VAULT_ID",
		tokenFile: "../sync-token",
	}, null, 2)}\n`, "utf8");
	const placeholderValidate = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--config",
		placeholderConfigFile,
		"--validate-local",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(placeholderValidate.status, 0, "local validation must fail when example placeholders remain");
	const placeholderValidatePayload = JSON.parse(placeholderValidate.stderr);
	assert.ok(placeholderValidatePayload.failedChecks.some((check) => check.name === "value:ssh-target:not-placeholder"));
	assert.ok(placeholderValidatePayload.failedChecks.some((check) => check.name === "value:remote-dir:not-placeholder"));
	assert.ok(placeholderValidatePayload.failedChecks.some((check) => check.name === "value:worker-host:not-placeholder"));
	assert.ok(placeholderValidatePayload.failedChecks.some((check) => check.name === "value:vault-id:not-placeholder"));
	const callsAfterLocalValidate = await readCalls(logPath).catch(() => []);
	assert.equal(callsAfterLocalValidate.length, callsBeforeLocalValidate.length, "local validation must not invoke ssh/scp");
	assert.equal(existsSync(localValidatePayload.summaryFile), false, "local validation must not write an acceptance summary file");
	console.log("  PASS  local validation checks inputs without touching the VM");

	console.log("\n--- headless host Oracle acceptance: release directory drives the full flow ---");
	const selfContainedEvidenceRoot = join(root, "self-contained-evidence");
	const selfContainedAcceptance = run(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-acceptance-test",
		"--update-remote-dir",
		"kaos-self-contained-acceptance-update-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--device-name",
		"oracle-acceptance-ci",
		"--token-file",
		tokenFile,
		"--evidence-root",
		selfContainedEvidenceRoot,
		"--release-dir",
		".",
		"--wait-ssh-interval-ms",
		"1",
		"--wait-ssh-timeout-ms",
		"5000",
		"--confirm-reboot",
	], {
		cwd: selfContainedReleaseDir,
	});
	const selfContainedAcceptancePayload = JSON.parse(selfContainedAcceptance.stdout);
	assert.equal(selfContainedAcceptancePayload.kind, "headless-host-oracle-acceptance");
	assert.equal(selfContainedAcceptancePayload.ok, true);
	assert.equal(selfContainedAcceptancePayload.inProgress, false);
	assert.equal(selfContainedAcceptancePayload.releaseDir.endsWith("/self-contained-release-dir"), true);
	assert.deepEqual(selfContainedAcceptancePayload.completed.map((step) => step.phase), [
		"preflight",
		"install",
		"reboot",
		"post-reboot",
		"update",
	]);
	assert.equal(selfContainedAcceptancePayload.completed.find((step) => step.phase === "install").args[0], "run-headless-host-oracle-remote-rehearsal.mjs");
	assert.equal(selfContainedAcceptancePayload.completed.find((step) => step.phase === "install").args[0].includes("/scripts/"), false);
	assert.equal(selfContainedAcceptancePayload.completed.find((step) => step.phase === "post-reboot").payload.verifiedFetchedLogs, true);
	assert.equal(selfContainedAcceptancePayload.completed.find((step) => step.phase === "update").payload.verifiedFetchedLogs, true);
	for (const phase of ["install", "update"]) {
		const step = selfContainedAcceptancePayload.completed.find((item) => item.phase === phase);
		const releaseValidation = step.payload.completed.find((item) => item.name === "local-release-assets-validate");
		assert.equal(releaseValidation?.status, 0);
		assert.match(releaseValidation.stdout, /headless-host-release-assets-validate/);
		assert.equal(step.payload.completed.find((item) => item.name === "local-upload-prepare")?.skipped, true);
		assert.equal(step.payload.completed.some((item) => item.name === "upload-zip"), true);
	}
	assert.equal(JSON.stringify(selfContainedAcceptancePayload).includes(secret), false);
	const selfContainedSummaryPayload = JSON.parse(await readFile(selfContainedAcceptancePayload.summaryFile, "utf8"));
	assert.deepEqual(selfContainedSummaryPayload, selfContainedAcceptancePayload);
	const selfContainedVerify = run(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		selfContainedAcceptancePayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	]);
	const selfContainedVerifyPayload = JSON.parse(selfContainedVerify.stdout);
	assert.equal(selfContainedVerifyPayload.ok, true);
	console.log("  PASS  release directory can run every acceptance phase without repo-local helpers");

	console.log("\n--- headless host Oracle acceptance: release summary resumes without repeating release-dir ---");
	const selfContainedResumeEvidenceRoot = join(root, "self-contained-resume-evidence");
	const selfContainedInstallOnly = run(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-acceptance-test",
		"--update-remote-dir",
		"kaos-self-contained-resume-update-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--evidence-root",
		selfContainedResumeEvidenceRoot,
		"--release-dir",
		".",
		"--stop-after",
		"install",
	], {
		cwd: selfContainedReleaseDir,
	});
	const selfContainedInstallOnlyPayload = JSON.parse(selfContainedInstallOnly.stdout);
	assert.equal(selfContainedInstallOnlyPayload.ok, true);
	assert.equal(selfContainedInstallOnlyPayload.lastSuccessfulPhase, "install");
	assert.equal(selfContainedInstallOnlyPayload.releaseDir.endsWith("/self-contained-release-dir"), true);
	const callsBeforeSelfContainedResumeValidate = await readCalls(logPath);
	const selfContainedResumeValidate = run(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--resume-from-summary",
		selfContainedInstallOnlyPayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--validate-local",
	], {
		cwd: selfContainedReleaseDir,
	});
	const selfContainedResumeValidatePayload = JSON.parse(selfContainedResumeValidate.stdout);
	assert.equal(selfContainedResumeValidatePayload.kind, "headless-host-oracle-acceptance-local-validate");
	assert.equal(selfContainedResumeValidatePayload.ok, true);
	assert.equal(selfContainedResumeValidatePayload.releaseDir, selfContainedInstallOnlyPayload.releaseDir);
	assert.deepEqual(selfContainedResumeValidatePayload.runPhases, ["reboot", "post-reboot", "update"]);
	assert.ok(selfContainedResumeValidatePayload.checks.some((check) => check.name === "release-assets-validate" && check.ok));
	assert.ok(selfContainedResumeValidatePayload.checks.some((check) => check.name === "release-bundle-verify" && check.ok));
	const callsAfterSelfContainedResumeValidate = await readCalls(logPath);
	assert.equal(callsAfterSelfContainedResumeValidate.length, callsBeforeSelfContainedResumeValidate.length, "resume local validation must not invoke ssh/scp");
	const selfContainedResume = run(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--resume-from-summary",
		selfContainedInstallOnlyPayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--wait-ssh-interval-ms",
		"1",
		"--wait-ssh-timeout-ms",
		"5000",
		"--confirm-reboot",
	], {
		cwd: selfContainedReleaseDir,
	});
	const selfContainedResumePayload = JSON.parse(selfContainedResume.stdout);
	assert.equal(selfContainedResumePayload.ok, true);
	assert.equal(selfContainedResumePayload.resumedFromSummary, selfContainedInstallOnlyPayload.summaryFile);
	assert.equal(selfContainedResumePayload.releaseDir, selfContainedInstallOnlyPayload.releaseDir);
	assert.deepEqual(selfContainedResumePayload.runPhases, ["reboot", "post-reboot", "update"]);
	assert.deepEqual(selfContainedResumePayload.completed.map((step) => step.phase), [
		"preflight",
		"install",
		"reboot",
		"post-reboot",
		"update",
	]);
	const selfContainedResumeUpdate = selfContainedResumePayload.completed.find((step) => step.phase === "update");
	assert.equal(selfContainedResumeUpdate.args.includes("--skip-local-prepare"), true);
	assert.equal(selfContainedResumeUpdate.args.includes(join(selfContainedResumePayload.releaseDir, "kaos-headless-host-oracle.zip")), true);
	assert.equal(selfContainedResumeUpdate.args.includes(join(selfContainedResumePayload.releaseDir, "kaos-headless-host-oracle.zip.sha256")), true);
	assert.equal(selfContainedResumeUpdate.payload.completed.find((item) => item.name === "local-release-assets-validate")?.status, 0);
	const selfContainedResumeVerify = run(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		selfContainedInstallOnlyPayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	]);
	assert.equal(JSON.parse(selfContainedResumeVerify.stdout).ok, true);
	console.log("  PASS  releaseDir stored in the summary carries resumed update validation");

	console.log("\n--- headless host Oracle acceptance: rejects unsafe release-asset options early ---");
	const missingAssets = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh-target",
		"opc@example.invalid",
		"--skip-local-prepare",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(missingAssets.status, 0, "release asset mode must require explicit zip/checksum before remote work");
	assert.match(JSON.parse(missingAssets.stderr).error, /--skip-local-prepare requires explicit --zip and --checksum/);
	const sameRemoteDir = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-same-dir",
		"--update-remote-dir",
		"kaos-same-dir",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(sameRemoteDir.status, 0, "update evidence must not overwrite install/reboot evidence");
	assert.match(JSON.parse(sameRemoteDir.stderr).error, /--update-remote-dir must differ from --remote-dir/);
	const releaseDir = join(root, "minimal-release-dir");
	await mkdir(releaseDir, { recursive: true });
	await copyFile(
		"scripts/run-headless-host-oracle-acceptance.mjs",
		join(releaseDir, "run-headless-host-oracle-acceptance.mjs"),
	);
	const callsBeforeMissingPrepare = await readCalls(logPath).catch(() => []);
	const missingPrepare = spawnSync(process.execPath, [
		"run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
	], {
		cwd: releaseDir,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(missingPrepare.status, 0, "release directory acceptance must fail before remote work when local prepare helper is missing");
	assert.match(JSON.parse(missingPrepare.stderr).error, /--skip-local-prepare.*--zip.*--checksum/);
	const callsAfterMissingPrepare = await readCalls(logPath).catch(() => []);
	assert.equal(callsAfterMissingPrepare.length, callsBeforeMissingPrepare.length, "missing local prepare helper must fail before ssh/scp side effects");
	const unsafeConfigFile = join(root, "unsafe-acceptance-config.json");
	await writeFile(unsafeConfigFile, `${JSON.stringify({ confirmReboot: true }, null, 2)}\n`, "utf8");
	const unsafeConfig = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--config",
		unsafeConfigFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(unsafeConfig.status, 0, "config must not be able to hide reboot confirmation");
	assert.match(JSON.parse(unsafeConfig.stderr).error, /unsupported acceptance config key "confirmReboot"/);
	console.log("  PASS  acceptance fails fast for ambiguous release asset and update evidence options");

	console.log("\n--- headless host Oracle acceptance: runs install, reboot, post-reboot, and update ---");
	const evidenceRoot = join(root, "evidence");
	const acceptance = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-acceptance-test",
		"--update-remote-dir",
		"kaos-acceptance-update-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--device-name",
		"oracle-acceptance-ci",
		"--token-file",
		tokenFile,
		"--evidence-root",
		evidenceRoot,
		"--wait-ssh-interval-ms",
		"1",
		"--wait-ssh-timeout-ms",
		"5000",
		"--confirm-reboot",
	]);
	const payload = JSON.parse(acceptance.stdout);
	assert.equal(payload.kind, "headless-host-oracle-acceptance");
	assert.equal(payload.ok, true);
	assert.equal(payload.inProgress, false);
	assert.equal(payload.lastSuccessfulPhase, "update");
	assert.deepEqual(payload.phases, ["preflight", "install", "reboot", "post-reboot", "update"]);
	assert.equal(payload.evidenceRoot, evidenceRoot);
	assert.deepEqual(payload.evidenceDirs, {
		install: join(evidenceRoot, "install"),
		"post-reboot": join(evidenceRoot, "post-reboot"),
		update: join(evidenceRoot, "update"),
	});
	assert.equal(payload.remoteDir, "kaos-acceptance-test");
	assert.equal(payload.updateRemoteDir, "kaos-acceptance-update-test");
	assert.equal(payload.summaryFile, join(evidenceRoot, "acceptance-summary.json"));
	assert.match(payload.nextStep, /acceptance complete/);
	assert.equal(JSON.stringify(payload).includes(secret), false);
	for (const phase of payload.phases) {
		const step = payload.completed.find((item) => item.phase === phase);
		assert.ok(step, `acceptance output must include phase ${phase}`);
		assert.equal(step.status, 0);
		assert.equal(step.payload?.kind, "headless-host-oracle-remote-rehearsal");
		assert.equal(step.payload?.ok, true);
		assert.equal(step.payload?.phase, phase);
	}
	assert.equal(payload.completed.find((step) => step.phase === "install").payload.fetchLogDir, join(evidenceRoot, "install"));
	assert.equal(payload.completed.find((step) => step.phase === "post-reboot").payload.fetchLogDir, join(evidenceRoot, "post-reboot"));
	assert.equal(payload.completed.find((step) => step.phase === "update").payload.fetchLogDir, join(evidenceRoot, "update"));
	assert.equal(payload.completed.find((step) => step.phase === "post-reboot").payload.verifiedFetchedLogs, true);
	assert.equal(payload.completed.find((step) => step.phase === "update").payload.verifiedFetchedLogs, true);
	assert.equal(payload.completed.find((step) => step.phase === "post-reboot").args.includes("--require-reboot-request"), true);
	assert.equal(payload.completed.find((step) => step.phase === "post-reboot").args.includes("--wait-for-ssh"), true);
	assert.equal(payload.completed.find((step) => step.phase === "reboot").args.includes("--secret-file"), true);

	const calls = await readCalls(logPath);
	const sshScripts = calls.filter((call) => call.kind === "ssh").map((call) => call.args.at(-1));
	const phaseScripts = sshScripts.filter((script) => script.includes("--phase") || script.includes("11-reboot-request.json"));
	assert.equal(sshScripts.some((script) => script.includes("00-remote-preflight.json")), true);
	assert.equal(phaseScripts.some((script) => script.includes("--phase install")), true);
	assert.equal(phaseScripts.some((script) => script.includes("11-reboot-request.json")), true);
	assert.equal(phaseScripts.some((script) => script.includes("--phase post-reboot")), true);
	assert.equal(phaseScripts.some((script) => script.includes("--phase update")), true);
	assert.equal(calls.some((call) => call.kind === "scp" && call.args.some((arg) => arg.endsWith("kaos-acceptance-test/."))), true);
	assert.equal(calls.some((call) => call.kind === "scp" && call.args.some((arg) => arg.endsWith("kaos-acceptance-update-test/."))), true);
	const summaryPayload = JSON.parse(await readFile(payload.summaryFile, "utf8"));
	assert.deepEqual(summaryPayload, payload);
	assert.equal(JSON.stringify(summaryPayload).includes(secret), false);
	const acceptanceVerify = run(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		payload.summaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	]);
	const acceptanceVerifyPayload = JSON.parse(acceptanceVerify.stdout);
	assert.equal(acceptanceVerifyPayload.kind, "headless-host-oracle-acceptance-verify");
	assert.equal(acceptanceVerifyPayload.ok, true);
	assert.equal(acceptanceVerifyPayload.requireFull, true);
	assert.deepEqual(acceptanceVerifyPayload.phases, payload.phases);
	assert.deepEqual(acceptanceVerifyPayload.verifications.map((item) => item.phase), ["install", "post-reboot", "update"]);
	assert.equal(JSON.stringify(acceptanceVerifyPayload).includes(secret), false);
	assert.equal(acceptanceVerifyPayload.summarySecretLeakCheck.ok, true);
	const leakySummaryFile = join(root, "leaky-acceptance-summary.json");
	await writeFile(leakySummaryFile, `${JSON.stringify({ ...summaryPayload, accidentalLeak: secret }, null, 2)}\n`, "utf8");
	const leakySummaryVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		leakySummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(leakySummaryVerify.status, 0, "acceptance verifier must reject summary files that contain the sync token");
	const leakySummaryVerifyPayload = JSON.parse(leakySummaryVerify.stderr);
	assert.ok(leakySummaryVerifyPayload.failedChecks.some((check) => check.name === "summary:secret-leak"));
	assert.equal(JSON.stringify(leakySummaryVerifyPayload).includes(secret), false);
	const inProgressSummaryFile = join(root, "in-progress-acceptance-summary.json");
	await writeFile(inProgressSummaryFile, `${JSON.stringify({ ...summaryPayload, inProgress: true }, null, 2)}\n`, "utf8");
	const inProgressSummaryVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		inProgressSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(inProgressSummaryVerify.status, 0, "acceptance verifier must reject in-progress checkpoints");
	const inProgressSummaryVerifyPayload = JSON.parse(inProgressSummaryVerify.stderr);
	assert.ok(inProgressSummaryVerifyPayload.failedChecks.some((check) => check.name === "summary:not-in-progress"));
	const staleLastSuccessfulSummaryFile = join(root, "stale-last-successful-acceptance-summary.json");
	await writeFile(staleLastSuccessfulSummaryFile, `${JSON.stringify({ ...summaryPayload, lastSuccessfulPhase: "post-reboot" }, null, 2)}\n`, "utf8");
	const staleLastSuccessfulVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		staleLastSuccessfulSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(staleLastSuccessfulVerify.status, 0, "acceptance verifier must reject stale lastSuccessfulPhase values");
	const staleLastSuccessfulVerifyPayload = JSON.parse(staleLastSuccessfulVerify.stderr);
	assert.ok(staleLastSuccessfulVerifyPayload.failedChecks.some((check) => check.name === "summary:last-successful-phase"));
	const duplicateEvidenceSummaryFile = join(root, "duplicate-evidence-acceptance-summary.json");
	await writeFile(duplicateEvidenceSummaryFile, `${JSON.stringify({
		...summaryPayload,
		evidenceDirs: {
			...summaryPayload.evidenceDirs,
			update: summaryPayload.evidenceDirs.install,
		},
	}, null, 2)}\n`, "utf8");
	const duplicateEvidenceVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		duplicateEvidenceSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(duplicateEvidenceVerify.status, 0, "acceptance verifier must reject reused evidence directories");
	const duplicateEvidenceVerifyPayload = JSON.parse(duplicateEvidenceVerify.stderr);
	assert.ok(duplicateEvidenceVerifyPayload.failedChecks.some((check) => check.name === "summary:evidence-dirs-distinct"));
	const duplicateRemoteDirSummaryFile = join(root, "duplicate-remote-dir-acceptance-summary.json");
	await writeFile(duplicateRemoteDirSummaryFile, `${JSON.stringify({
		...summaryPayload,
		updateRemoteDir: summaryPayload.remoteDir,
	}, null, 2)}\n`, "utf8");
	const duplicateRemoteDirVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		duplicateRemoteDirSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(duplicateRemoteDirVerify.status, 0, "acceptance verifier must reject reused remote dirs when update is present");
	const duplicateRemoteDirVerifyPayload = JSON.parse(duplicateRemoteDirVerify.stderr);
	assert.ok(duplicateRemoteDirVerifyPayload.failedChecks.some((check) => check.name === "summary:remote-dirs-distinct"));
	const mismatchedPayloadRemoteDirFile = join(root, "mismatched-payload-remote-dir-acceptance-summary.json");
	await writeFile(mismatchedPayloadRemoteDirFile, `${JSON.stringify({
		...summaryPayload,
		completed: summaryPayload.completed.map((step) => step.phase === "update"
			? { ...step, payload: { ...step.payload, remoteDir: summaryPayload.remoteDir } }
			: step),
	}, null, 2)}\n`, "utf8");
	const mismatchedPayloadRemoteDirVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		mismatchedPayloadRemoteDirFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(mismatchedPayloadRemoteDirVerify.status, 0, "acceptance verifier must reject completed payload remoteDir drift");
	const mismatchedPayloadRemoteDirVerifyPayload = JSON.parse(mismatchedPayloadRemoteDirVerify.stderr);
	assert.ok(mismatchedPayloadRemoteDirVerifyPayload.failedChecks.some((check) => check.name === "summary:completed-payload-targets"));
	const mismatchedPayloadTargetFile = join(root, "mismatched-payload-target-acceptance-summary.json");
	await writeFile(mismatchedPayloadTargetFile, `${JSON.stringify({
		...summaryPayload,
		completed: summaryPayload.completed.map((step) => step.phase === "post-reboot"
			? { ...step, payload: { ...step.payload, sshTarget: "opc@other.example.invalid" } }
			: step),
	}, null, 2)}\n`, "utf8");
	const mismatchedPayloadTargetVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		mismatchedPayloadTargetFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(mismatchedPayloadTargetVerify.status, 0, "acceptance verifier must reject completed payload sshTarget drift");
	const mismatchedPayloadTargetVerifyPayload = JSON.parse(mismatchedPayloadTargetVerify.stderr);
	assert.ok(mismatchedPayloadTargetVerifyPayload.failedChecks.some((check) => check.name === "summary:completed-payload-targets"));
	const shuffledCompletedSummaryFile = join(root, "shuffled-completed-acceptance-summary.json");
	await writeFile(shuffledCompletedSummaryFile, `${JSON.stringify({
		...summaryPayload,
		completed: [
			summaryPayload.completed[0],
			summaryPayload.completed[2],
			summaryPayload.completed[1],
			...summaryPayload.completed.slice(3),
		],
	}, null, 2)}\n`, "utf8");
	const shuffledCompletedVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		shuffledCompletedSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(shuffledCompletedVerify.status, 0, "acceptance verifier must reject completed steps that do not match phase order");
	const shuffledCompletedVerifyPayload = JSON.parse(shuffledCompletedVerify.stderr);
	assert.ok(shuffledCompletedVerifyPayload.failedChecks.some((check) => check.name === "summary:completed-order"));
	const mismatchedCompletedPayloadFile = join(root, "mismatched-completed-payload-acceptance-summary.json");
	await writeFile(mismatchedCompletedPayloadFile, `${JSON.stringify({
		...summaryPayload,
		completed: summaryPayload.completed.map((step) => step.phase === "update"
			? { ...step, payload: { ...step.payload, phase: "install" } }
			: step),
	}, null, 2)}\n`, "utf8");
	const mismatchedCompletedPayloadVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		mismatchedCompletedPayloadFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(mismatchedCompletedPayloadVerify.status, 0, "acceptance verifier must reject completed payload phase drift");
	const mismatchedCompletedPayloadVerifyPayload = JSON.parse(mismatchedCompletedPayloadVerify.stderr);
	assert.ok(mismatchedCompletedPayloadVerifyPayload.failedChecks.some((check) => check.name === "summary:completed-payload-phase"));
	const shuffledSummaryFile = join(root, "shuffled-acceptance-summary.json");
	await writeFile(shuffledSummaryFile, `${JSON.stringify({
		...summaryPayload,
		phases: ["preflight", "install", "post-reboot", "reboot", "update"],
	}, null, 2)}\n`, "utf8");
	const shuffledSummaryVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		shuffledSummaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(shuffledSummaryVerify.status, 0, "acceptance verifier must reject shuffled phase summaries");
	const shuffledSummaryVerifyPayload = JSON.parse(shuffledSummaryVerify.stderr);
	assert.ok(shuffledSummaryVerifyPayload.failedChecks.some((check) => check.name === "summary:phase-contiguous"));
	assert.ok(shuffledSummaryVerifyPayload.failedChecks.some((check) => check.name === "summary:full-phases"));
	console.log("  PASS  acceptance wrapper drives the full verified Oracle flow");

	console.log("\n--- headless host Oracle acceptance: failed phase writes redacted summary ---");
	const failingSsh = join(root, "failing-ssh.mjs");
	await writeFailingSsh(failingSsh, logPath, secret);
	await chmod(failingSsh, 0o755);
	const failedEvidenceRoot = join(root, "failed-evidence");
	const failedAcceptance = spawnSync(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		failingSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-failed-acceptance-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--evidence-root",
		failedEvidenceRoot,
		"--stop-after",
		"install",
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(failedAcceptance.status, 0, "failed remote phase must fail acceptance");
	const failedPayload = JSON.parse(failedAcceptance.stderr);
	assert.equal(failedPayload.ok, false);
	assert.equal(failedPayload.inProgress, false);
	assert.equal(failedPayload.failedPhase, "install");
	assert.equal(failedPayload.lastSuccessfulPhase, "preflight");
	assert.match(failedPayload.nextStep, /--start-at install/);
	assert.equal(failedPayload.summaryFile, join(failedEvidenceRoot, "acceptance-summary.json"));
	const failedSummaryPayload = JSON.parse(await readFile(failedPayload.summaryFile, "utf8"));
	assert.deepEqual(failedSummaryPayload, failedPayload);
	assert.equal(JSON.stringify(failedSummaryPayload).includes(secret), false);
	assert.ok(failedSummaryPayload.completed.find((step) => step.phase === "install")?.payload?.failedStep);
	const failedSummaryVerify = spawnSync(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		failedPayload.summaryFile,
		"--secret-file",
		tokenFile,
	], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.notEqual(failedSummaryVerify.status, 0, "failed acceptance summary must not verify as successful");
	const failedSummaryVerifyPayload = JSON.parse(failedSummaryVerify.stderr);
	assert.equal(failedSummaryVerifyPayload.ok, false);
	assert.ok(failedSummaryVerifyPayload.failedChecks.some((check) => check.name === "summary:ok"));
	assert.equal(JSON.stringify(failedSummaryVerifyPayload).includes(secret), false);
	console.log("  PASS  failed acceptance persists a redacted summary for later inspection");

	console.log("\n--- headless host Oracle acceptance: can resume at post-reboot without update ---");
	const resume = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-acceptance-test",
		"--token-file",
		tokenFile,
		"--evidence-root",
		join(root, "resume-evidence"),
		"--start-at",
		"post-reboot",
		"--skip-update",
	]);
	const resumePayload = JSON.parse(resume.stdout);
	assert.equal(resumePayload.inProgress, false);
	assert.equal(resumePayload.lastSuccessfulPhase, "post-reboot");
	assert.deepEqual(resumePayload.phases, ["post-reboot"]);
	assert.equal(resumePayload.completed[0].payload.phase, "post-reboot");
	assert.equal(resumePayload.completed[0].payload.verifiedFetchedLogs, true);
	console.log("  PASS  acceptance wrapper can resume after a previously requested reboot");

	console.log("\n--- headless host Oracle acceptance: partial run points at the next phase ---");
	const installOnlyEvidence = join(root, "install-only-evidence");
	const installOnly = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--ssh-target",
		"opc@example.invalid",
		"--remote-dir",
		"kaos-install-only-test",
		"--worker-host",
		"https://worker.example.invalid",
		"--vault-id",
		"vault-acceptance",
		"--token-file",
		tokenFile,
		"--evidence-root",
		installOnlyEvidence,
		"--stop-after",
		"install",
	]);
	const installOnlyPayload = JSON.parse(installOnly.stdout);
	assert.equal(installOnlyPayload.inProgress, false);
	assert.equal(installOnlyPayload.lastSuccessfulPhase, "install");
	assert.deepEqual(installOnlyPayload.phases, ["preflight", "install"]);
	assert.deepEqual(installOnlyPayload.evidenceDirs, { install: join(installOnlyEvidence, "install") });
	assert.match(installOnlyPayload.nextStep, /--start-at reboot/);
	assert.match(installOnlyPayload.nextStep, /--confirm-reboot/);
	console.log("  PASS  partial acceptance output keeps the operator on the safe next step");

	console.log("\n--- headless host Oracle acceptance: resumes from summary into full evidence ---");
	const resumedFromSummary = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh",
		fakeSsh,
		"--scp",
		fakeScp,
		"--resume-from-summary",
		installOnlyPayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--wait-ssh-interval-ms",
		"1",
		"--wait-ssh-timeout-ms",
		"5000",
		"--confirm-reboot",
	]);
	const resumedPayload = JSON.parse(resumedFromSummary.stdout);
	assert.equal(resumedPayload.ok, true);
	assert.equal(resumedPayload.inProgress, false);
	assert.equal(resumedPayload.resumedFromSummary, installOnlyPayload.summaryFile);
	assert.equal(resumedPayload.sshTarget, "opc@example.invalid");
	assert.equal(resumedPayload.remoteDir, "kaos-install-only-test");
	assert.equal(resumedPayload.updateRemoteDir, "kaos-install-only-test-update");
	assert.equal(resumedPayload.evidenceRoot, installOnlyEvidence);
	assert.deepEqual(resumedPayload.runPhases, ["reboot", "post-reboot", "update"]);
	assert.deepEqual(resumedPayload.phases, ["preflight", "install", "reboot", "post-reboot", "update"]);
	assert.deepEqual(resumedPayload.completed.map((step) => step.phase), resumedPayload.phases);
	assert.equal(resumedPayload.completed.find((step) => step.phase === "install").payload.phase, "install");
	assert.equal(resumedPayload.completed.find((step) => step.phase === "update").payload.phase, "update");
	assert.equal(JSON.stringify(resumedPayload).includes(secret), false);
	const resumedSummaryPayload = JSON.parse(await readFile(installOnlyPayload.summaryFile, "utf8"));
	assert.deepEqual(resumedSummaryPayload, resumedPayload);
	const resumedVerify = run(process.execPath, [
		"scripts/verify-headless-host-oracle-acceptance.mjs",
		"--summary-file",
		installOnlyPayload.summaryFile,
		"--secret-file",
		tokenFile,
		"--require-full",
	]);
	const resumedVerifyPayload = JSON.parse(resumedVerify.stdout);
	assert.equal(resumedVerifyPayload.ok, true);
	assert.equal(JSON.stringify(resumedVerifyPayload).includes(secret), false);
	console.log("  PASS  summary resume preserves earlier evidence and finishes full verification");
} finally {
	await rm(root, { recursive: true, force: true });
}

async function writeFakeCommand(path, kind, logPath, secret) {
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
process.exit(0);

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
    helpers: releaseAssets()
      .filter((asset) => asset.endsWith(".mjs") && asset !== "kaos-headless-host.mjs")
      .map((asset) => ({
        target: "/opt/kaos/" + asset,
        sourceSha256: ${JSON.stringify(fakeSha)},
        installedSha256: ${JSON.stringify(fakeSha)}
      }))
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
    remoteDir: "kaos-acceptance-test",
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

async function writeFailingSsh(path, logPath, secret) {
	await writeFile(path, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ kind: "ssh", args }) + "\\n");
const script = args.at(-1) ?? "";
console.log(${JSON.stringify(secret)} + " appeared before fake install failure");
process.exit(script.includes("--phase install") ? 42 : 0);
`, "utf8");
}

async function readCalls(path) {
	const text = await readFile(path, "utf8");
	return text.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 120_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`command failed: ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	return result;
}
