#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { buildProductPluginBundle, installVaultPlugin } from "./helpers/headless-host-vault-plugin.mjs";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-oracle-deploy-"));
const installDir = join(root, "opt", "kaos");
const servicePath = join(root, "etc", "systemd", "system", "kaos-headless-host.service");
const metadataPath = join(root, "var", "lib", "kaos-headless", "install.json");
const installedBinary = join(installDir, "kaos-headless-host.mjs");
const children = [];
const workspaceTempDirs = [];
const helperNames = [
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
const fullReleaseDownloadCount = 4 + helperNames.length;
const rollbackWithServiceArtifactCount = helperNames.length + 3;
let oracleBundle;

try {
	console.log("\n--- headless host oracle deploy: build release artifact ---");
	buildProductPluginBundle();
	run(process.execPath, ["scripts/build-headless-host.mjs"]);
	const builtManifest = JSON.parse(await readFile("dist/kaos-headless-host-manifest.json", "utf8"));
	assert.equal(builtManifest.kind, "kaos-headless-host-release-manifest");
	assert.equal(builtManifest.assets["kaos-headless-host.mjs"].sha256, await readChecksum("dist/kaos-headless-host.mjs.sha256"));
	assert.ok(builtManifest.assets["update-headless-host-from-release.mjs"].sha256);
	assert.ok(builtManifest.assets["validate-headless-host-release-assets.mjs"].sha256);
	const oracleBundleBytes = await readFile("dist/kaos-headless-host-oracle.zip");
	assert.equal(sha256Bytes(oracleBundleBytes), await readChecksum("dist/kaos-headless-host-oracle.zip.sha256"));
	oracleBundle = unzipSync(oracleBundleBytes);
	for (const entry of [
		"kaos-headless-host.mjs",
		"kaos-headless-host.mjs.sha256",
		"kaos-headless-host-manifest.json",
		"kaos-headless-host.service",
		"oracle-acceptance-config.example.json",
		"bootstrap-headless-host-oracle.mjs",
		"install-headless-host.mjs",
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
		"README-headless-host.txt",
		"kaos-headless-host-bundle-manifest.json",
	]) {
		assert.ok(oracleBundle[entry], `Oracle bundle must contain ${entry}`);
	}
	const oracleBundleManifest = JSON.parse(strFromU8(oracleBundle["kaos-headless-host-bundle-manifest.json"]));
	assert.equal(oracleBundleManifest.kind, "kaos-headless-host-oracle-bundle");
	assert.equal(oracleBundleManifest.assets["kaos-headless-host.mjs"].sha256, builtManifest.assets["kaos-headless-host.mjs"].sha256);
	assert.ok(builtManifest.assets["bootstrap-headless-host-oracle.mjs"].sha256);
	assert.ok(builtManifest.assets["oracle-acceptance-config.example.json"].sha256);
	assert.ok(builtManifest.assets["verify-headless-host-bundle.mjs"].sha256);
	assert.ok(builtManifest.assets["run-headless-host-oracle-rehearsal.mjs"].sha256);
	assert.ok(builtManifest.assets["run-headless-host-oracle-remote-rehearsal.mjs"].sha256);
	assert.ok(builtManifest.assets["run-headless-host-oracle-acceptance.mjs"].sha256);
	assert.ok(builtManifest.assets["verify-headless-host-oracle-acceptance.mjs"].sha256);
	assert.ok(builtManifest.assets["verify-headless-host-oracle-rehearsal.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["bootstrap-headless-host-oracle.mjs"]), oracleBundleManifest.assets["bootstrap-headless-host-oracle.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["oracle-acceptance-config.example.json"]), oracleBundleManifest.assets["oracle-acceptance-config.example.json"].sha256);
	assert.equal(sha256Bytes(oracleBundle["verify-headless-host-bundle.mjs"]), oracleBundleManifest.assets["verify-headless-host-bundle.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["validate-headless-host-release-assets.mjs"]), oracleBundleManifest.assets["validate-headless-host-release-assets.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["run-headless-host-oracle-rehearsal.mjs"]), oracleBundleManifest.assets["run-headless-host-oracle-rehearsal.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["run-headless-host-oracle-remote-rehearsal.mjs"]), oracleBundleManifest.assets["run-headless-host-oracle-remote-rehearsal.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["run-headless-host-oracle-acceptance.mjs"]), oracleBundleManifest.assets["run-headless-host-oracle-acceptance.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["verify-headless-host-oracle-acceptance.mjs"]), oracleBundleManifest.assets["verify-headless-host-oracle-acceptance.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["verify-headless-host-oracle-rehearsal.mjs"]), oracleBundleManifest.assets["verify-headless-host-oracle-rehearsal.mjs"].sha256);
	assert.equal(sha256Bytes(oracleBundle["postflight-headless-host.mjs"]), oracleBundleManifest.assets["postflight-headless-host.mjs"].sha256);
	const oracleReadme = strFromU8(oracleBundle["README-headless-host.txt"]);
	const oracleAcceptanceConfig = JSON.parse(strFromU8(oracleBundle["oracle-acceptance-config.example.json"]));
	assert.equal(oracleAcceptanceConfig.releaseDir, ".");
	assert.equal(oracleAcceptanceConfig.deviceName, "oracle-headless");
	assert.equal(oracleAcceptanceConfig.tokenFile.includes("YOUR_SYNC_TOKEN"), false);
	assert.match(oracleReadme, /--bundle-dir \./);
	assert.match(oracleReadme, /bootstrap-headless-host-oracle\.mjs/);
	assert.match(oracleReadme, /root:kaos/);
	assert.match(oracleReadme, /chmod 0640/);
	assert.match(oracleReadme, /--rollback-on-postflight-failure/);
	assert.match(oracleReadme, /--enable-service/);
	assert.match(oracleReadme, /is-enabled --quiet/);
	assert.match(oracleReadme, /--postflight-smoke-work-dir/);
	assert.match(oracleReadme, /outside the primary vault/);
	assert.match(oracleReadme, /--postflight-check-only/);
	assert.match(oracleReadme, /--check-only/);
	assert.match(oracleReadme, /--postflight-only/);
	assert.match(oracleReadme, /--postflight-verify-running/);
	assert.match(oracleReadme, /--verify-running/);
	assert.match(oracleReadme, /--require-lock/);
	assert.match(oracleReadme, /same vault\/data file/);
	assert.match(oracleReadme, /\/usr\/bin\/node -- \/opt\/kaos\/kaos-headless-host\.mjs/);
	assert.match(oracleReadme, /--service-node/);
	assert.match(oracleReadme, /oracle-acceptance-config\.example\.json/);
	assert.match(oracleReadme, /acceptance-config\.json/);
	assert.match(oracleReadme, /--validate-local/);
	assert.match(oracleReadme, /verify-headless-host-bundle\.mjs/);
	assert.match(oracleReadme, /validate-headless-host-release-assets\.mjs/);
	assert.match(oracleReadme, /run-headless-host-oracle-rehearsal\.mjs/);
	assert.match(oracleReadme, /--phase post-reboot/);
	assert.match(oracleReadme, /ExecStart\/ExecStartPre/);
	assert.match(oracleReadme, /WorkingDirectory\/ReadWritePaths/);
	assert.match(oracleReadme, /--no-helper-scripts/);
	assert.match(oracleReadme, /next to\s+the running update wrapper/);
	console.log("  PASS  release artifact built");

	console.log("\n--- headless host oracle deploy: bootstrap helper prepares Oracle config safely ---");
	const bootstrapRoot = join(root, "bootstrap");
	const bootstrapBin = join(bootstrapRoot, "bin");
	const bootstrapInstallDir = join(bootstrapRoot, "opt", "kaos");
	const bootstrapVault = join(bootstrapRoot, "srv", "kaos", "vault");
	const bootstrapDataDir = join(bootstrapRoot, "var", "lib", "kaos-headless");
	const bootstrapEtc = join(bootstrapRoot, "etc", "kaos");
	const bootstrapCommandLog = join(bootstrapRoot, "commands.log");
	await mkdir(bootstrapBin, { recursive: true });
	await writeFile(join(bootstrapBin, "fake-getent.cjs"), fakeCommandScript(bootstrapCommandLog, "missing"), "utf8");
	await writeFile(join(bootstrapBin, "fake-id.cjs"), fakeCommandScript(bootstrapCommandLog, "missing"), "utf8");
	await writeFile(join(bootstrapBin, "fake-groupadd.cjs"), fakeCommandScript(bootstrapCommandLog, "ok"), "utf8");
	await writeFile(join(bootstrapBin, "fake-useradd.cjs"), fakeCommandScript(bootstrapCommandLog, "ok"), "utf8");
	await writeFile(join(bootstrapBin, "fake-chown.cjs"), fakeCommandScript(bootstrapCommandLog, "ok"), "utf8");
	for (const fake of ["fake-getent.cjs", "fake-id.cjs", "fake-groupadd.cjs", "fake-useradd.cjs", "fake-chown.cjs"]) {
		await chmod(join(bootstrapBin, fake), 0o755);
	}
	const bootstrap = run(process.execPath, [
		"scripts/bootstrap-headless-host-oracle.mjs",
		"--allow-non-root",
		"--host",
		"https://bootstrap.example.invalid",
		"--vault-id",
		"bootstrap-vault",
		"--device-name",
		"bootstrap-device",
		"--token-stdin",
		"--home",
		bootstrapInstallDir,
		"--install-dir",
		bootstrapInstallDir,
		"--vault",
		bootstrapVault,
		"--data-dir",
		bootstrapDataDir,
		"--etc-dir",
		bootstrapEtc,
		"--getent-command",
		join(bootstrapBin, "fake-getent.cjs"),
		"--id-command",
		join(bootstrapBin, "fake-id.cjs"),
		"--groupadd-command",
		join(bootstrapBin, "fake-groupadd.cjs"),
		"--useradd-command",
		join(bootstrapBin, "fake-useradd.cjs"),
		"--chown-command",
		join(bootstrapBin, "fake-chown.cjs"),
	], {
		input: "bootstrap-secret-token\n",
	});
	const bootstrapPayload = JSON.parse(bootstrap.stdout);
	assert.equal(bootstrapPayload.kind, "headless-host-oracle-bootstrap");
	assert.equal(bootstrapPayload.ok, true);
	assert.equal(bootstrapPayload.user, "kaos");
	assert.equal(bootstrapPayload.group, "kaos");
	assert.equal((await stat(bootstrapInstallDir)).mode & 0o777, 0o755);
	assert.equal((await stat(bootstrapVault)).mode & 0o777, 0o755);
	assert.equal((await stat(bootstrapDataDir)).mode & 0o777, 0o755);
	assert.equal((await stat(join(bootstrapEtc, "headless.env"))).mode & 0o777, 0o640);
	assert.equal((await stat(join(bootstrapEtc, "sync-token"))).mode & 0o777, 0o640);
	const bootstrapEnv = await readFile(join(bootstrapEtc, "headless.env"), "utf8");
	assert.match(bootstrapEnv, /KAOS_HOST=https:\/\/bootstrap\.example\.invalid/);
	assert.match(bootstrapEnv, /KAOS_VAULT_ID=bootstrap-vault/);
	assert.match(bootstrapEnv, /KAOS_DEVICE_NAME=bootstrap-device/);
	assert.match(bootstrapEnv, /KAOS_ENABLE_ATTACHMENT_SYNC=false/);
	assert.equal(await readFile(join(bootstrapEtc, "sync-token"), "utf8"), "bootstrap-secret-token");
	assert.equal(bootstrap.stdout.includes("bootstrap-secret-token"), false, "bootstrap output should not leak token material");
	const bootstrapCommands = (await readFile(bootstrapCommandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(bootstrapCommands.some((entry) => entry.name === "fake-groupadd.cjs" && entry.args.includes("kaos")));
	assert.ok(bootstrapCommands.some((entry) => entry.name === "fake-useradd.cjs" && entry.args.includes("--gid") && entry.args.includes("kaos")));
	assert.ok(bootstrapCommands.some((entry) => entry.name === "fake-chown.cjs" && entry.args[0] === "root:kaos" && entry.args[1] === join(bootstrapEtc, "sync-token")));
	assert.ok(bootstrapCommands.some((entry) => entry.name === "fake-chown.cjs" && entry.args[0] === "kaos:kaos" && entry.args[1] === bootstrapVault));
	const bootstrapPreserve = run(process.execPath, [
		"scripts/bootstrap-headless-host-oracle.mjs",
		"--allow-non-root",
		"--skip-user",
		"--token",
		"different-secret-token",
		"--install-dir",
		bootstrapInstallDir,
		"--vault",
		bootstrapVault,
		"--data-dir",
		bootstrapDataDir,
		"--etc-dir",
		bootstrapEtc,
		"--chown-command",
		join(bootstrapBin, "fake-chown.cjs"),
	]);
	const bootstrapPreservePayload = JSON.parse(bootstrapPreserve.stdout);
	assert.ok(bootstrapPreservePayload.actions.some((action) => action.name === "token-file" && action.preserved));
	assert.equal(await readFile(join(bootstrapEtc, "sync-token"), "utf8"), "bootstrap-secret-token");
	assert.equal(bootstrapPreserve.stdout.includes("different-secret-token"), false, "preserve run should not leak token material");
	console.log("  PASS  bootstrap helper creates safe Oracle paths and preserves existing secrets");

	console.log("\n--- headless host oracle deploy: install verifies checksum and copies service ---");
	const install = run(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		"dist/kaos-headless-host.mjs.sha256",
		"--install-dir",
		installDir,
		"--service-source",
		"deploy/kaos-headless-host.service",
		"--service-path",
		servicePath,
		"--metadata-path",
		metadataPath,
	]);
	const installPayload = JSON.parse(install.stdout);
	assert.equal(installPayload.kind, "headless-host-install");
	assert.equal(installPayload.ok, true);
	assert.equal(existsSync(installedBinary), true, "binary should be installed");
	assert.equal(existsSync(servicePath), true, "service template should be installed");
	assert.equal((await stat(installedBinary)).mode & 0o777, 0o755);
	assert.equal((await stat(servicePath)).mode & 0o777, 0o644);
	assert.equal(await sha256File(installedBinary), await readChecksum("dist/kaos-headless-host.mjs.sha256"));
	const service = await readFile(servicePath, "utf8");
	assert.match(service, /EnvironmentFile=\/etc\/kaos\/headless\.env/);
	assert.match(service, /WorkingDirectory=\/opt\/kaos/);
	assert.match(service, /ExecStartPre=\/usr\/bin\/node -- \/opt\/kaos\/kaos-headless-host\.mjs --doctor --require-sync-config --skip-worker-capabilities/);
	assert.match(service, /--token-file \/etc\/kaos\/sync-token/);
	assert.match(service, /Restart=on-failure/);
	assert.match(service, /RestartSec=5/);
	assert.match(service, /RuntimeDirectory=kaos-headless/);
	assert.match(service, /StateDirectory=kaos-headless/);
	assert.match(service, /ProtectSystem=strict/);
	assert.match(service, /ReadWritePaths=\/srv\/kaos\/vault \/var\/lib\/kaos-headless \/run\/kaos-headless/);
	console.log("  PASS  install path matches Oracle/systemd layout");

	console.log("\n--- headless host oracle deploy: install can rewrite service Node path ---");
	const nodeRewriteInstallDir = join(root, "opt", "kaos-node-rewrite");
	const nodeRewriteServicePath = join(root, "etc", "systemd", "system", "kaos-headless-host-node-rewrite.service");
	const nodeRewriteMetadataPath = join(root, "var", "lib", "kaos-headless", "node-rewrite-install.json");
	const customServiceNode = join(root, "custom", "bin", "node");
	const nodeRewrite = run(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		"dist/kaos-headless-host.mjs.sha256",
		"--install-dir",
		nodeRewriteInstallDir,
		"--service-source",
		"deploy/kaos-headless-host.service",
		"--service-path",
		nodeRewriteServicePath,
		"--service-node",
		customServiceNode,
		"--metadata-path",
		nodeRewriteMetadataPath,
	]);
	const nodeRewritePayload = JSON.parse(nodeRewrite.stdout);
	assert.equal(nodeRewritePayload.serviceNode, customServiceNode);
	assert.equal(nodeRewritePayload.service.serviceNode, customServiceNode);
	const nodeRewriteService = await readFile(nodeRewriteServicePath, "utf8");
	assert.match(nodeRewriteService, new RegExp(`ExecStartPre=${escapeRegExp(customServiceNode)} -- /opt/kaos/kaos-headless-host\\.mjs`));
	assert.match(nodeRewriteService, new RegExp(`ExecStart=${escapeRegExp(customServiceNode)} -- /opt/kaos/kaos-headless-host\\.mjs`));
	assert.equal(nodeRewriteService.includes("/usr/bin/node --"), false);
	console.log("  PASS  install can target a non-default Node binary in systemd service");

	console.log("\n--- headless host oracle deploy: install rejects unsupported service Node rewrite ---");
	const badNodeRewriteInstallDir = join(root, "opt", "kaos-bad-node-rewrite");
	const badNodeRewriteServiceSource = join(root, "bad-node-rewrite.service");
	const badNodeRewriteServicePath = join(root, "etc", "systemd", "system", "kaos-headless-host-bad-node-rewrite.service");
	await writeFile(badNodeRewriteServiceSource, `[Service]
ExecStart=/usr/bin/node /opt/kaos/kaos-headless-host.mjs --vault /srv/kaos/vault
`, "utf8");
	const badNodeRewrite = spawnSync(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		"dist/kaos-headless-host.mjs.sha256",
		"--install-dir",
		badNodeRewriteInstallDir,
		"--service-source",
		badNodeRewriteServiceSource,
		"--service-path",
		badNodeRewriteServicePath,
		"--service-node",
		join(root, "bad-node-rewrite", "bin", "node"),
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(badNodeRewrite.status, 0, "unsupported service template should fail before leaving a partial install");
	const badNodeRewritePayload = JSON.parse(badNodeRewrite.stderr.trim());
	assert.equal(badNodeRewritePayload.kind, "headless-host-install");
	assert.equal(badNodeRewritePayload.ok, false);
	assert.match(badNodeRewritePayload.error, /unsupported ExecStart command form/);
	assert.equal(existsSync(join(badNodeRewriteInstallDir, "kaos-headless-host.mjs")), false);
	assert.equal(existsSync(badNodeRewriteServicePath), false);
	console.log("  PASS  unsupported service Node rewrite fails closed and rolls back");

	console.log("\n--- headless host oracle deploy: Oracle zip installs offline through update wrapper ---");
	const bundleDir = join(root, "release", "oracle-bundle");
	await mkdir(bundleDir, { recursive: true });
	for (const [name, bytes] of Object.entries(oracleBundle)) {
		await writeFile(join(bundleDir, name), bytes);
	}
	const bundleInstallDir = join(root, "opt", "kaos-bundle");
	const bundleWorkDir = join(root, "oracle-bundle-work");
	const bundleServicePath = join(root, "etc", "systemd", "system", "kaos-headless-host-bundle.service");
	const bundleMetadataPath = join(root, "oracle-bundle-metadata.json");
	const bundleServiceNode = join(root, "bundle", "bin", "node");
	const bundleVerify = run(process.execPath, [
		join(bundleDir, "verify-headless-host-bundle.mjs"),
		"--bundle-dir",
		bundleDir,
	]);
	const bundleVerifyPayload = JSON.parse(bundleVerify.stdout);
	assert.equal(bundleVerifyPayload.kind, "headless-host-bundle-verify");
	assert.equal(bundleVerifyPayload.ok, true);
	assert.ok(bundleVerifyPayload.checked.some((asset) => asset.asset === "kaos-headless-host.mjs" && asset.ok));
	assert.ok(bundleVerifyPayload.releaseChecks.some((asset) => asset.asset === "verify-headless-host-bundle.mjs" && asset.ok));
	assert.ok(bundleVerifyPayload.releaseChecks.some((asset) => asset.asset === "validate-headless-host-release-assets.mjs" && asset.ok));
	assert.equal(bundleVerifyPayload.checksumCheck.ok, true);
	const tamperedBundleDir = join(root, "release", "oracle-bundle-tampered");
	await mkdir(tamperedBundleDir, { recursive: true });
	for (const [name, bytes] of Object.entries(oracleBundle)) {
		await writeFile(join(tamperedBundleDir, name), bytes);
	}
	await writeFile(join(tamperedBundleDir, "postflight-headless-host.mjs"), "tampered postflight helper\n", "utf8");
	const tamperedBundleVerify = spawnSync(process.execPath, [
		join(tamperedBundleDir, "verify-headless-host-bundle.mjs"),
		"--bundle-dir",
		tamperedBundleDir,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(tamperedBundleVerify.status, 0, "tampered Oracle bundle helper should fail bundle verification");
	const tamperedBundleVerifyPayload = JSON.parse(tamperedBundleVerify.stderr.trim());
	assert.equal(tamperedBundleVerifyPayload.kind, "headless-host-bundle-verify");
	assert.equal(tamperedBundleVerifyPayload.ok, false);
	assert.equal(tamperedBundleVerifyPayload.failedStage, "asset-integrity");
	assert.ok(tamperedBundleVerifyPayload.failures.some((failure) => failure.asset === "postflight-headless-host.mjs"));
	const tamperedBundleInstallDir = join(root, "opt", "kaos-bundle-tampered");
	const tamperedBundleWorkDir = join(root, "oracle-bundle-tampered-work");
	const tamperedBundleInstall = spawnSync(process.execPath, [
		join(tamperedBundleDir, "update-headless-host-from-release.mjs"),
		"--bundle-dir",
		tamperedBundleDir,
		"--work-dir",
		tamperedBundleWorkDir,
		"--install-dir",
		tamperedBundleInstallDir,
		"--no-service",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(tamperedBundleInstall.status, 0, "tampered Oracle bundle should fail automatic verification before install");
	const tamperedBundleInstallPayload = JSON.parse(tamperedBundleInstall.stderr.trim());
	assert.equal(tamperedBundleInstallPayload.kind, "headless-host-release-update");
	assert.equal(tamperedBundleInstallPayload.ok, false);
	assert.match(tamperedBundleInstallPayload.error, /bundle verification failed/);
	assert.equal(tamperedBundleInstallPayload.bundleVerification.failedStage, "asset-integrity");
	assert.ok(tamperedBundleInstallPayload.bundleVerification.failures.some((failure) => failure.asset === "postflight-headless-host.mjs"));
	assert.equal(existsSync(join(tamperedBundleInstallDir, "kaos-headless-host.mjs")), false);
	const bundleInstall = run(process.execPath, [
		join(bundleDir, "update-headless-host-from-release.mjs"),
		"--bundle-dir",
		bundleDir,
		"--work-dir",
		bundleWorkDir,
		"--install-dir",
		bundleInstallDir,
		"--service-path",
		bundleServicePath,
		"--service-node",
		bundleServiceNode,
		"--metadata-path",
		bundleMetadataPath,
	]);
	const bundleInstallPayload = JSON.parse(bundleInstall.stdout);
	assert.equal(bundleInstallPayload.kind, "headless-host-release-update");
	assert.equal(bundleInstallPayload.ok, true);
	assert.match(bundleInstallPayload.baseUrl, /^file:\/\//);
	assert.equal(bundleInstallPayload.bundleVerification.ok, true);
	assert.equal(bundleInstallPayload.bundleVerification.kind, "headless-host-bundle-verify");
	assert.equal(bundleInstallPayload.downloaded.length, fullReleaseDownloadCount);
	assert.equal(bundleInstallPayload.helpers.length, helperNames.length);
	assert.equal(bundleInstallPayload.install.serviceNode, bundleServiceNode);
	assert.equal(await sha256File(join(bundleInstallDir, "kaos-headless-host.mjs")), await readChecksum(join(bundleDir, "kaos-headless-host.mjs.sha256")));
	assert.equal((await stat(bundleServicePath)).mode & 0o777, 0o644);
	const bundleService = await readFile(bundleServicePath, "utf8");
	assert.match(bundleService, new RegExp(`ExecStartPre=${escapeRegExp(bundleServiceNode)} -- /opt/kaos/kaos-headless-host\\.mjs`));
	assert.match(bundleService, new RegExp(`ExecStart=${escapeRegExp(bundleServiceNode)} -- /opt/kaos/kaos-headless-host\\.mjs`));
	for (const helper of helperNames) {
		assert.equal(existsSync(join(bundleInstallDir, helper)), true, `${helper} should be installed from the Oracle bundle`);
		assert.equal((await stat(join(bundleInstallDir, helper))).mode & 0o777, 0o755);
	}
	const bundleMetadata = JSON.parse(await readFile(bundleMetadataPath, "utf8"));
	assert.equal(bundleMetadata.kind, "headless-host-release-install");
	assert.equal(bundleMetadata.bundleVerification.ok, true);
	assert.equal(bundleMetadata.install.serviceNode, bundleServiceNode);
	assert.equal(bundleMetadata.helpers.length, helperNames.length);
	console.log("  PASS  single Oracle zip contains a working offline install/update set");

	console.log("\n--- headless host oracle deploy: installed binary reads systemd-style env safely ---");
	const vaultRoot = join(root, "srv", "kaos", "vault");
	const dataDir = join(root, "var", "lib", "kaos-headless");
	const lockDir = join(root, "run", "kaos-headless");
	await mkdir(vaultRoot, { recursive: true });
	await installVaultPlugin(vaultRoot);
	await mkdir(dataDir, { recursive: true });
	await mkdir(lockDir, { recursive: true });
	const status = run(process.execPath, [
		installedBinary,
		"--status",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "data.json"),
		"--lock-file",
		join(lockDir, "kaos.lock"),
	], {
		env: {
			...process.env,
			KAOS_HOST: "https://oracle.example.invalid",
			KAOS_VAULT_ID: "oracle-vault",
			KAOS_DEVICE_NAME: "oracle-headless",
			KAOS_SYNC_TOKEN: "oracle-secret-token",
		},
	});
	const statusPayload = JSON.parse(status.stdout);
	assert.equal(statusPayload.kind, "status");
	assert.equal(statusPayload.configured.host, "https://oracle.example.invalid");
	assert.equal(statusPayload.configured.vaultId, "oracle-vault");
	assert.equal(statusPayload.configured.deviceName, "oracle-headless");
	assert.equal(statusPayload.configured.tokenConfigured, true);
	assert.equal(Object.prototype.hasOwnProperty.call(statusPayload.configured, "token"), false);
	console.log("  PASS  env contract works without leaking token material");

	console.log("\n--- headless host oracle deploy: doctor verifies local paths without network dependency ---");
	const doctor = run(process.execPath, [
		installedBinary,
		"--doctor",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "doctor-data.json"),
		"--lock-file",
		join(lockDir, "kaos.lock"),
	]);
	const doctorPayload = JSON.parse(doctor.stdout);
	assert.equal(doctorPayload.kind, "doctor");
	assert.equal(doctorPayload.ok, true);
	assert.ok(doctorPayload.checks.some((check) => check.name === "vault-root-readable" && check.ok));
	assert.ok(doctorPayload.checks.some((check) => check.name === "data-dir-readable" && check.ok));
	assert.ok(doctorPayload.checks.some((check) => check.name === "lock-dir-readable" && check.ok));
	assert.ok(doctorPayload.checks.some((check) => check.name === "worker-capabilities" && check.ok));
	console.log("  PASS  doctor can be used as a local pre-flight gate");

	console.log("\n--- headless host oracle deploy: update preserves previous binary backup ---");
	const oldBinary = "#!/usr/bin/env node\nconsole.log('previous oracle install');\n";
	await writeFile(installedBinary, oldBinary, "utf8");
	await chmod(installedBinary, 0o755);
	run(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		"dist/kaos-headless-host.mjs.sha256",
		"--install-dir",
		installDir,
		"--metadata-path",
		metadataPath,
	]);
	assert.equal(await readFile(`${installedBinary}.previous`, "utf8"), oldBinary);
	assert.equal(existsSync(`${metadataPath}.previous`), true, "metadata backup should be kept for rollback");
	assert.equal(await sha256File(installedBinary), await readChecksum("dist/kaos-headless-host.mjs.sha256"));
	console.log("  PASS  update installs only after checksum verification and keeps rollback backup");

	console.log("\n--- headless host oracle deploy: checksum mismatch does not replace current binary ---");
	const beforeBadUpdate = await readFile(installedBinary);
	const badChecksum = join(root, "bad.sha256");
	await writeFile(badChecksum, `${"0".repeat(64)}  kaos-headless-host.mjs\n`, "utf8");
	const bad = spawnSync(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		badChecksum,
		"--install-dir",
		installDir,
	], {
		encoding: "utf8",
	});
	assert.notEqual(bad.status, 0, "bad checksum should fail");
	assert.deepEqual(await readFile(installedBinary), beforeBadUpdate);
	console.log("  PASS  rejected update leaves installed binary untouched");

	console.log("\n--- headless host oracle deploy: install failure restores already installed binary ---");
	const installFailDir = join(root, "install-fail-opt", "kaos");
	const installFailBinary = join(installFailDir, "kaos-headless-host.mjs");
	const installFailServiceParent = join(root, "install-fail-etc", "systemd-file");
	const installFailServicePath = join(installFailServiceParent, "kaos-headless-host.service");
	const oldInstallFailBinary = "#!/usr/bin/env node\nconsole.log('old install fail binary');\n";
	await mkdir(installFailDir, { recursive: true });
	await mkdir(join(root, "install-fail-etc"), { recursive: true });
	await writeFile(installFailBinary, oldInstallFailBinary, "utf8");
	await chmod(installFailBinary, 0o755);
	await writeFile(installFailServiceParent, "not a directory\n", "utf8");
	const installFail = spawnSync(process.execPath, [
		"scripts/install-headless-host.mjs",
		"--source",
		"dist/kaos-headless-host.mjs",
		"--checksum",
		"dist/kaos-headless-host.mjs.sha256",
		"--install-dir",
		installFailDir,
		"--service-source",
		"deploy/kaos-headless-host.service",
		"--service-path",
		installFailServicePath,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(installFail.status, 0, "service install failure should fail the installer");
	const installFailPayload = JSON.parse(installFail.stderr.trim());
	assert.equal(installFailPayload.kind, "headless-host-install");
	assert.equal(installFailPayload.ok, false);
	assert.match(installFailPayload.error, /install failed after rolling back 1 file/);
	assert.equal(await readFile(installFailBinary, "utf8"), oldInstallFailBinary);
	console.log("  PASS  failed install does not leave binary half-updated");

	console.log("\n--- headless host oracle deploy: release updater downloads assets and installs ---");
	const releaseDir = join(root, "release-assets");
	const updateWorkDir = join(root, "release-update-work");
	const updateInstallDir = join(root, "release-update-opt", "kaos");
	const updateServicePath = join(root, "release-update-etc", "systemd", "system", "kaos-headless-host.service");
	const updateMetadataPath = join(root, "release-update-metadata.json");
	const downloadedInstallerMarker = join(root, "downloaded-installer-used.txt");
	await mkdir(releaseDir, { recursive: true });
	await copyFile("dist/kaos-headless-host.mjs", join(releaseDir, "kaos-headless-host.mjs"));
	await copyFile("dist/kaos-headless-host.mjs.sha256", join(releaseDir, "kaos-headless-host.mjs.sha256"));
	await copyFile("deploy/kaos-headless-host.service", join(releaseDir, "kaos-headless-host.service"));
	await copyFile("scripts/bootstrap-headless-host-oracle.mjs", join(releaseDir, "bootstrap-headless-host-oracle.mjs"));
	await writeFile(join(releaseDir, "install-headless-host.mjs"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.env.KAOS_DOWNLOADED_INSTALLER_MARKER) {
	writeFileSync(process.env.KAOS_DOWNLOADED_INSTALLER_MARKER, "used\\n");
}
const result = spawnSync(process.execPath, [${JSON.stringify(join(process.cwd(), "scripts", "install-headless-host.mjs"))}, ...process.argv.slice(2)], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
`, "utf8");
	await chmod(join(releaseDir, "install-headless-host.mjs"), 0o755);
	await copyFile("scripts/update-headless-host-from-release.mjs", join(releaseDir, "update-headless-host-from-release.mjs"));
	await copyFile("scripts/verify-headless-host-bundle.mjs", join(releaseDir, "verify-headless-host-bundle.mjs"));
	await copyFile("scripts/validate-headless-host-release-assets.mjs", join(releaseDir, "validate-headless-host-release-assets.mjs"));
	await copyFile("scripts/run-headless-host-oracle-rehearsal.mjs", join(releaseDir, "run-headless-host-oracle-rehearsal.mjs"));
	await copyFile("scripts/run-headless-host-oracle-remote-rehearsal.mjs", join(releaseDir, "run-headless-host-oracle-remote-rehearsal.mjs"));
	await copyFile("scripts/run-headless-host-oracle-acceptance.mjs", join(releaseDir, "run-headless-host-oracle-acceptance.mjs"));
	await copyFile("scripts/verify-headless-host-oracle-acceptance.mjs", join(releaseDir, "verify-headless-host-oracle-acceptance.mjs"));
	await copyFile("scripts/verify-headless-host-oracle-rehearsal.mjs", join(releaseDir, "verify-headless-host-oracle-rehearsal.mjs"));
	await copyFile("scripts/smoke-headless-host-sync.mjs", join(releaseDir, "smoke-headless-host-sync.mjs"));
	await copyFile("scripts/postflight-headless-host.mjs", join(releaseDir, "postflight-headless-host.mjs"));
	await copyFile("scripts/rollback-headless-host.mjs", join(releaseDir, "rollback-headless-host.mjs"));
	await writeHeadlessManifest(releaseDir);
	const update = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		updateWorkDir,
		"--install-dir",
		updateInstallDir,
		"--service-path",
		updateServicePath,
		"--metadata-path",
		updateMetadataPath,
	], {
		env: {
			...process.env,
			KAOS_DOWNLOADED_INSTALLER_MARKER: downloadedInstallerMarker,
		},
	});
	const updatePayload = JSON.parse(update.stdout);
	assert.equal(updatePayload.kind, "headless-host-release-update");
	assert.equal(updatePayload.ok, true);
	assert.equal(updatePayload.downloaded.length, fullReleaseDownloadCount);
	assert.equal(updatePayload.downloaded.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)), true);
	assert.equal(updatePayload.manifest.kind, "kaos-headless-host-release-manifest");
	assert.equal(updatePayload.helpers.length, helperNames.length);
	assert.equal(updatePayload.metadataPath, updateMetadataPath);
	assert.equal(await readFile(downloadedInstallerMarker, "utf8"), "used\n");
	assert.equal(updatePayload.installer, join(updateWorkDir, "install-headless-host.mjs"));
	assert.equal(await sha256File(join(updateInstallDir, "kaos-headless-host.mjs")), await readChecksum("dist/kaos-headless-host.mjs.sha256"));
	assert.equal(existsSync(updateServicePath), true, "release updater should install service template");
	for (const helper of helperNames) {
		const helperPath = join(updateInstallDir, helper);
		assert.equal(existsSync(helperPath), true, `${helper} should be installed`);
		assert.equal((await stat(helperPath)).mode & 0o777, 0o755);
		const helperPayload = updatePayload.helpers.find((item) => item.target === helperPath);
		assert.ok(helperPayload, `${helper} should be listed in helper metadata`);
		assert.equal(helperPayload.sourceSha256, await sha256File(join(releaseDir, helper)));
		assert.equal(helperPayload.installedSha256, await sha256File(helperPath));
	}
	const updateMetadata = JSON.parse(await readFile(updateMetadataPath, "utf8"));
	assert.equal(updateMetadata.kind, "headless-host-release-install");
	assert.equal(updateMetadata.install.sha256, await readChecksum("dist/kaos-headless-host.mjs.sha256"));
	assert.equal(updateMetadata.installer, join(updateWorkDir, "install-headless-host.mjs"));
	assert.equal(updateMetadata.downloaded.length, fullReleaseDownloadCount);
	assert.equal(updateMetadata.manifest.assets["install-headless-host.mjs"].sha256, await sha256File(join(releaseDir, "install-headless-host.mjs")));
	assert.equal(updateMetadata.helpers.length, helperNames.length);
	console.log("  PASS  release updater can fetch release assets and delegate verified install");

	console.log("\n--- headless host oracle deploy: release updater can run successful postflight ---");
	const postflightUpdateInstallDir = join(root, "release-postflight-opt", "kaos");
	const postflightUpdateWorkDir = join(root, "release-postflight-work");
	const postflightUpdateServicePath = join(root, "release-postflight-etc", "systemd", "system", "kaos-headless-host.service");
	const postflightUpdateVault = join(root, "release-postflight-srv", "kaos", "vault");
	const postflightUpdateDataDir = join(root, "release-postflight-var", "lib", "kaos-headless");
	const postflightUpdateLockDir = join(root, "release-postflight-run", "kaos-headless");
	const postflightUpdateEtc = join(root, "release-postflight-etc", "kaos");
	const postflightUpdateEnvFile = join(postflightUpdateEtc, "headless.env");
	const postflightUpdateTokenFile = join(postflightUpdateEtc, "sync-token");
	const postflightUpdateSystemctl = join(root, "release-postflight-systemctl.cjs");
	const postflightUpdateSystemctlLog = join(root, "release-postflight-systemctl.log");
	const postflightUpdateSmoke = join(root, "release-postflight-smoke.cjs");
	const postflightUpdateSmokeLog = join(root, "release-postflight-smoke.log");
	const postflightUpdateSmokeWorkDir = join(root, "release-postflight-smoke-work");
	const postflightUpdateRunuser = join(root, "release-postflight-runuser.cjs");
	const postflightUpdateRunuserLog = join(root, "release-postflight-runuser.log");
	await mkdir(postflightUpdateVault, { recursive: true });
	await installVaultPlugin(postflightUpdateVault);
	await mkdir(postflightUpdateDataDir, { recursive: true });
	await mkdir(postflightUpdateLockDir, { recursive: true });
	await mkdir(postflightUpdateEtc, { recursive: true });
	await mkdir(postflightUpdateSmokeWorkDir, { recursive: true });
	await writeFile(postflightUpdateEnvFile, `KAOS_HOST=https://release-postflight.example.invalid
KAOS_VAULT_ID=release-postflight-vault
KAOS_DEVICE_NAME=release-postflight-device
`, "utf8");
	await chmod(postflightUpdateEnvFile, 0o640);
	await writeFile(postflightUpdateTokenFile, "release-postflight-token", "utf8");
	await chmod(postflightUpdateTokenFile, 0o640);
	await writeFile(postflightUpdateSystemctl, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.KAOS_RELEASE_POSTFLIGHT_SYSTEMCTL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`, "utf8");
	await writeFile(postflightUpdateSmoke, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.KAOS_RELEASE_POSTFLIGHT_SMOKE_LOG, JSON.stringify(process.argv.slice(2)));
if (!process.argv.includes("--require-lock")) process.exit(3);
console.log(JSON.stringify({
  kind: "headless-host-sync-smoke",
  ok: true,
  tokenConfigured: true,
  via: "release-update-postflight-smoke"
}));
`, "utf8");
	await writeFile(postflightUpdateRunuser, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.KAOS_RELEASE_POSTFLIGHT_RUNUSER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`, "utf8");
	await chmod(postflightUpdateSystemctl, 0o755);
	await chmod(postflightUpdateSmoke, 0o755);
	await chmod(postflightUpdateRunuser, 0o755);
	const postflightUpdate = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		postflightUpdateWorkDir,
		"--install-dir",
		postflightUpdateInstallDir,
		"--service-path",
		postflightUpdateServicePath,
		"--postflight",
		"--enable-service",
		"--postflight-vault",
		postflightUpdateVault,
		"--postflight-data-file",
		join(postflightUpdateDataDir, "data.json"),
		"--postflight-lock-file",
		join(postflightUpdateLockDir, "kaos.lock"),
		"--postflight-env-file",
		postflightUpdateEnvFile,
		"--postflight-token-file",
		postflightUpdateTokenFile,
		"--postflight-systemctl",
		postflightUpdateSystemctl,
		"--postflight-node",
		process.execPath,
		"--postflight-runuser",
		postflightUpdateRunuser,
		"--postflight-service",
		"kaos-release-postflight",
		"--postflight-smoke-script",
		postflightUpdateSmoke,
		"--postflight-smoke-work-dir",
		postflightUpdateSmokeWorkDir,
		"--postflight-skip-service-file-check",
		"--postflight-require-service-access-check",
		"--postflight-no-smoke-user",
	], {
		env: {
			...process.env,
			KAOS_RELEASE_POSTFLIGHT_SYSTEMCTL_LOG: postflightUpdateSystemctlLog,
			KAOS_RELEASE_POSTFLIGHT_SMOKE_LOG: postflightUpdateSmokeLog,
			KAOS_RELEASE_POSTFLIGHT_RUNUSER_LOG: postflightUpdateRunuserLog,
		},
	});
	const postflightUpdatePayload = JSON.parse(postflightUpdate.stdout);
	assert.equal(postflightUpdatePayload.kind, "headless-host-release-update");
	assert.equal(postflightUpdatePayload.ok, true);
	assert.equal(postflightUpdatePayload.postflight.kind, "headless-host-postflight");
	assert.equal(postflightUpdatePayload.postflight.ok, true);
	assert.equal(postflightUpdatePayload.postflight.binary, join(postflightUpdateInstallDir, "kaos-headless-host.mjs"));
	assert.equal(postflightUpdatePayload.postflight.smokeWorkDir, postflightUpdateSmokeWorkDir);
	assert.equal(postflightUpdatePayload.postflight.metadataChecks.ok, true);
	assert.ok(postflightUpdatePayload.postflight.metadataChecks.checks.some((check) => check.name === "metadata-binary-sha256" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.metadataChecks.checks.some((check) => check.name === "metadata-helper-postflight-headless-host.mjs-sha256" && check.ok));
	assert.equal(postflightUpdatePayload.postflight.serviceAccessChecks.ok, true);
	assert.equal(postflightUpdatePayload.postflight.serviceAccessChecks.required, true);
	assert.equal(postflightUpdatePayload.postflight.serviceAccessChecks.serviceGroup, "kaos");
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-working-dir-searchable" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-node-executable" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-smoke-script-readable" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-smoke-work-dir-outside-vault" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-smoke-work-dir-writable" && check.ok));
	assert.ok(postflightUpdatePayload.postflight.serviceAccessChecks.checks.some((check) => check.name === "service-token-readable" && check.ok));
	assert.equal(postflightUpdatePayload.postflight.smoke.via, "release-update-postflight-smoke");
	assert.equal(postflightUpdatePayload.postflight.smokeUser, null);
	assert.equal(postflightUpdatePayload.postflight.readiness.mode, "full");
	assert.equal(postflightUpdatePayload.postflight.readiness.liveServiceVerified, true);
	assert.equal(postflightUpdatePayload.postflight.readiness.syncSmokeVerified, true);
	assert.equal(postflightUpdatePayload.postflight.readiness.preRestartReady, true);
	assert.equal(postflightUpdatePayload.serviceEnable.ok, true);
	assert.equal(postflightUpdatePayload.serviceEnable.service, "kaos-release-postflight");
	assert.deepEqual(postflightUpdatePayload.serviceEnable.commands.map((command) => command.args), [
		["enable", "kaos-release-postflight"],
		["is-enabled", "--quiet", "kaos-release-postflight"],
	]);
	for (const name of ["metadata", "service-access", "secret-files", "node-version", "doctor"]) {
		assert.ok(postflightUpdatePayload.postflight.readiness.completed.includes(name), `readiness should complete ${name}`);
	}
	assert.deepEqual((await readFile(postflightUpdateSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["daemon-reload"],
		["restart", "kaos-release-postflight"],
		["is-active", "--quiet", "kaos-release-postflight"],
		["enable", "kaos-release-postflight"],
		["is-enabled", "--quiet", "kaos-release-postflight"],
	]);
	const postflightSmokeArgs = JSON.parse(await readFile(postflightUpdateSmokeLog, "utf8"));
	assert.equal(postflightSmokeArgs.includes("--require-lock"), true);
	assert.equal(postflightSmokeArgs.includes(join(postflightUpdateInstallDir, "kaos-headless-host.mjs")), true);
	assert.equal(postflightSmokeArgs.includes("--work-dir"), true);
	assert.equal(postflightSmokeArgs.includes(postflightUpdateSmokeWorkDir), true);
	const postflightAccessArgs = (await readFile(postflightUpdateRunuserLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(postflightAccessArgs.some((args) => args[0] === "-u" && args[1] === "kaos" && args[2] === "-g" && args[3] === "kaos" && args.includes("test") && args.includes(postflightUpdateTokenFile)));
	assert.equal(postflightUpdate.stdout.includes("release-postflight-token"), false, "successful guarded update should not leak token material");
	console.log("  PASS  release updater emits successful postflight and smoke diagnostics");

	console.log("\n--- headless host oracle deploy: release updater reports service enable failure ---");
	const enableFailInstallDir = join(root, "release-enable-fail-opt", "kaos");
	const enableFailWorkDir = join(root, "release-enable-fail-work");
	const enableFailServicePath = join(root, "release-enable-fail-etc", "systemd", "system", "kaos-headless-host.service");
	const enableFailSystemctl = join(root, "release-enable-fail-systemctl.cjs");
	await writeFile(enableFailSystemctl, `#!/usr/bin/env node
process.stderr.write("intentional enable failure");
process.exit(7);
`, "utf8");
	await chmod(enableFailSystemctl, 0o755);
	const enableFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		enableFailWorkDir,
		"--install-dir",
		enableFailInstallDir,
		"--service-path",
		enableFailServicePath,
		"--enable-service",
		"--postflight-systemctl",
		enableFailSystemctl,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(enableFail.status, 0, "service enable failure should fail the release update command");
	const enableFailPayload = JSON.parse(enableFail.stderr.trim());
	assert.equal(enableFailPayload.kind, "headless-host-release-update");
	assert.equal(enableFailPayload.ok, false);
	assert.match(enableFailPayload.error, /service enable failed/);
	assert.equal(enableFailPayload.serviceEnable.stage, "enable-service");
	assert.deepEqual(enableFailPayload.serviceEnable.args, ["enable", "kaos-headless-host"]);
	assert.equal(enableFailPayload.serviceEnable.status, 7);
	assert.match(enableFailPayload.serviceEnable.stderr, /intentional enable failure/);
	assert.equal(existsSync(join(enableFailInstallDir, "kaos-headless-host.mjs")), true, "enable failure happens after install");
	console.log("  PASS  release updater makes reboot enable failures explicit");

	console.log("\n--- headless host oracle deploy: release updater verifies service enabled state ---");
	const isEnabledFailInstallDir = join(root, "release-is-enabled-fail-opt", "kaos");
	const isEnabledFailWorkDir = join(root, "release-is-enabled-fail-work");
	const isEnabledFailServicePath = join(root, "release-is-enabled-fail-etc", "systemd", "system", "kaos-headless-host.service");
	const isEnabledFailSystemctl = join(root, "release-is-enabled-fail-systemctl.cjs");
	await writeFile(isEnabledFailSystemctl, `#!/usr/bin/env node
if (process.argv[2] === "is-enabled") {
  process.stderr.write("intentional is-enabled failure");
  process.exit(8);
}
process.exit(0);
`, "utf8");
	await chmod(isEnabledFailSystemctl, 0o755);
	const isEnabledFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		isEnabledFailWorkDir,
		"--install-dir",
		isEnabledFailInstallDir,
		"--service-path",
		isEnabledFailServicePath,
		"--enable-service",
		"--postflight-systemctl",
		isEnabledFailSystemctl,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(isEnabledFail.status, 0, "is-enabled failure should fail the release update command");
	const isEnabledFailPayload = JSON.parse(isEnabledFail.stderr.trim());
	assert.equal(isEnabledFailPayload.kind, "headless-host-release-update");
	assert.equal(isEnabledFailPayload.ok, false);
	assert.equal(isEnabledFailPayload.serviceEnable.stage, "verify-service-enabled");
	assert.deepEqual(isEnabledFailPayload.serviceEnable.args, ["is-enabled", "--quiet", "kaos-headless-host"]);
	assert.equal(isEnabledFailPayload.serviceEnable.status, 8);
	assert.equal(isEnabledFailPayload.serviceEnable.completed.length, 1);
	assert.deepEqual(isEnabledFailPayload.serviceEnable.completed[0].args, ["enable", "kaos-headless-host"]);
	console.log("  PASS  release updater confirms boot registration after enable");

	console.log("\n--- headless host oracle deploy: release updater can run check-only postflight ---");
	const checkOnlyUpdateInstallDir = join(root, "release-check-only-opt", "kaos");
	const checkOnlyUpdateWorkDir = join(root, "release-check-only-work");
	const checkOnlyUpdateServicePath = join(root, "release-check-only-etc", "systemd", "system", "kaos-headless-host.service");
	const checkOnlyUpdateVault = join(root, "release-check-only-srv", "kaos", "vault");
	const checkOnlyUpdateDataDir = join(root, "release-check-only-var", "lib", "kaos-headless");
	const checkOnlyUpdateLockDir = join(root, "release-check-only-run", "kaos-headless");
	const checkOnlyUpdateEtc = join(root, "release-check-only-etc", "kaos");
	const checkOnlyUpdateEnvFile = join(checkOnlyUpdateEtc, "headless.env");
	const checkOnlyUpdateTokenFile = join(checkOnlyUpdateEtc, "sync-token");
	const checkOnlyUpdateSystemctl = join(root, "release-check-only-systemctl.cjs");
	const checkOnlyUpdateSystemctlLog = join(root, "release-check-only-systemctl.log");
	await mkdir(checkOnlyUpdateVault, { recursive: true });
	await installVaultPlugin(checkOnlyUpdateVault);
	await mkdir(checkOnlyUpdateDataDir, { recursive: true });
	await mkdir(checkOnlyUpdateLockDir, { recursive: true });
	await mkdir(checkOnlyUpdateEtc, { recursive: true });
	await writeFile(checkOnlyUpdateEnvFile, `KAOS_HOST=https://release-check-only.example.invalid
KAOS_VAULT_ID=release-check-only-vault
KAOS_DEVICE_NAME=release-check-only-device
`, "utf8");
	await chmod(checkOnlyUpdateEnvFile, 0o640);
	await writeFile(checkOnlyUpdateTokenFile, "release-check-only-token", "utf8");
	await chmod(checkOnlyUpdateTokenFile, 0o640);
	await writeFile(checkOnlyUpdateSystemctl, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.KAOS_RELEASE_CHECK_ONLY_SYSTEMCTL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`, "utf8");
	await chmod(checkOnlyUpdateSystemctl, 0o755);
	const checkOnlyUpdate = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		checkOnlyUpdateWorkDir,
		"--install-dir",
		checkOnlyUpdateInstallDir,
		"--service-path",
		checkOnlyUpdateServicePath,
		"--postflight",
		"--postflight-check-only",
		"--postflight-vault",
		checkOnlyUpdateVault,
		"--postflight-data-file",
		join(checkOnlyUpdateDataDir, "data.json"),
		"--postflight-lock-file",
		join(checkOnlyUpdateLockDir, "kaos.lock"),
		"--postflight-env-file",
		checkOnlyUpdateEnvFile,
		"--postflight-token-file",
		checkOnlyUpdateTokenFile,
		"--postflight-systemctl",
		checkOnlyUpdateSystemctl,
		"--postflight-node",
		process.execPath,
		"--postflight-service",
		"kaos-release-check-only",
		"--postflight-skip-service-file-check",
	], {
		env: {
			...process.env,
			KAOS_RELEASE_CHECK_ONLY_SYSTEMCTL_LOG: checkOnlyUpdateSystemctlLog,
		},
	});
	const checkOnlyUpdatePayload = JSON.parse(checkOnlyUpdate.stdout);
	assert.equal(checkOnlyUpdatePayload.ok, true);
	assert.equal(checkOnlyUpdatePayload.postflight.checkOnly, true);
	assert.equal(checkOnlyUpdatePayload.postflight.readiness.mode, "check-only");
	assert.equal(checkOnlyUpdatePayload.postflight.readiness.preRestartReady, true);
	assert.equal(checkOnlyUpdatePayload.postflight.readiness.liveServiceVerified, false);
	assert.equal(checkOnlyUpdatePayload.postflight.readiness.syncSmokeVerified, false);
	assert.equal(checkOnlyUpdatePayload.postflight.systemctl.length, 0);
	assert.equal(checkOnlyUpdatePayload.postflight.smoke, null);
	assert.equal(existsSync(checkOnlyUpdateSystemctlLog), false, "update wrapper check-only postflight should not call systemctl");
	assert.equal(checkOnlyUpdate.stdout.includes("release-check-only-token"), false, "check-only update should not leak token material");
	console.log("  PASS  release updater forwards postflight check-only mode");

	console.log("\n--- headless host oracle deploy: release updater can verify a running postflight service ---");
	const verifyRunningUpdateInstallDir = join(root, "release-verify-running-opt", "kaos");
	const verifyRunningUpdateWorkDir = join(root, "release-verify-running-work");
	const verifyRunningUpdateServicePath = join(root, "release-verify-running-etc", "systemd", "system", "kaos-headless-host.service");
	const verifyRunningUpdateVault = join(root, "release-verify-running-srv", "kaos", "vault");
	const verifyRunningUpdateDataDir = join(root, "release-verify-running-var", "lib", "kaos-headless");
	const verifyRunningUpdateLockDir = join(root, "release-verify-running-run", "kaos-headless");
	const verifyRunningUpdateEtc = join(root, "release-verify-running-etc", "kaos");
	const verifyRunningUpdateEnvFile = join(verifyRunningUpdateEtc, "headless.env");
	const verifyRunningUpdateTokenFile = join(verifyRunningUpdateEtc, "sync-token");
	const verifyRunningUpdateSystemctl = join(root, "release-verify-running-systemctl.cjs");
	const verifyRunningUpdateSystemctlLog = join(root, "release-verify-running-systemctl.log");
	const verifyRunningUpdateSmoke = join(root, "release-verify-running-smoke.cjs");
	const verifyRunningUpdateSmokeLog = join(root, "release-verify-running-smoke.log");
	const verifyRunningUpdateSmokeWorkDir = join(root, "release-verify-running-smoke-work");
	await mkdir(verifyRunningUpdateVault, { recursive: true });
	await installVaultPlugin(verifyRunningUpdateVault);
	await mkdir(verifyRunningUpdateDataDir, { recursive: true });
	await mkdir(verifyRunningUpdateLockDir, { recursive: true });
	await mkdir(verifyRunningUpdateEtc, { recursive: true });
	await mkdir(verifyRunningUpdateSmokeWorkDir, { recursive: true });
	await writeFile(verifyRunningUpdateEnvFile, `KAOS_HOST=https://release-verify-running.example.invalid
KAOS_VAULT_ID=release-verify-running-vault
KAOS_DEVICE_NAME=release-verify-running-device
`, "utf8");
	await chmod(verifyRunningUpdateEnvFile, 0o640);
	await writeFile(verifyRunningUpdateTokenFile, "release-verify-running-token", "utf8");
	await chmod(verifyRunningUpdateTokenFile, 0o640);
	await writeFile(verifyRunningUpdateSystemctl, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.KAOS_RELEASE_VERIFY_RUNNING_SYSTEMCTL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`, "utf8");
	await writeFile(verifyRunningUpdateSmoke, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.KAOS_RELEASE_VERIFY_RUNNING_SMOKE_LOG, JSON.stringify(process.argv.slice(2)));
if (!process.argv.includes("--require-lock")) process.exit(3);
console.log(JSON.stringify({
  kind: "headless-host-sync-smoke",
  ok: true,
  tokenConfigured: true,
  via: "release-verify-running-smoke"
}));
`, "utf8");
	await chmod(verifyRunningUpdateSystemctl, 0o755);
	await chmod(verifyRunningUpdateSmoke, 0o755);
	const verifyRunningUpdate = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		verifyRunningUpdateWorkDir,
		"--install-dir",
		verifyRunningUpdateInstallDir,
		"--service-path",
		verifyRunningUpdateServicePath,
		"--postflight",
		"--postflight-verify-running",
		"--postflight-vault",
		verifyRunningUpdateVault,
		"--postflight-data-file",
		join(verifyRunningUpdateDataDir, "data.json"),
		"--postflight-lock-file",
		join(verifyRunningUpdateLockDir, "kaos.lock"),
		"--postflight-env-file",
		verifyRunningUpdateEnvFile,
		"--postflight-token-file",
		verifyRunningUpdateTokenFile,
		"--postflight-systemctl",
		verifyRunningUpdateSystemctl,
		"--postflight-node",
		process.execPath,
		"--postflight-service",
		"kaos-release-verify-running",
		"--postflight-smoke-script",
		verifyRunningUpdateSmoke,
		"--postflight-smoke-work-dir",
		verifyRunningUpdateSmokeWorkDir,
		"--postflight-skip-service-file-check",
		"--postflight-no-smoke-user",
	], {
		env: {
			...process.env,
			KAOS_RELEASE_VERIFY_RUNNING_SYSTEMCTL_LOG: verifyRunningUpdateSystemctlLog,
			KAOS_RELEASE_VERIFY_RUNNING_SMOKE_LOG: verifyRunningUpdateSmokeLog,
		},
	});
	const verifyRunningUpdatePayload = JSON.parse(verifyRunningUpdate.stdout);
	assert.equal(verifyRunningUpdatePayload.ok, true);
	assert.equal(verifyRunningUpdatePayload.postflight.verifyRunning, true);
	assert.equal(verifyRunningUpdatePayload.postflight.readiness.mode, "verify-running");
	assert.equal(verifyRunningUpdatePayload.postflight.readiness.bootServiceEnabled, true);
	assert.equal(verifyRunningUpdatePayload.postflight.readiness.liveServiceVerified, true);
	assert.equal(verifyRunningUpdatePayload.postflight.readiness.syncSmokeVerified, true);
	assert.equal(verifyRunningUpdatePayload.postflight.smoke.via, "release-verify-running-smoke");
	assert.deepEqual((await readFile(verifyRunningUpdateSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["is-enabled", "--quiet", "kaos-release-verify-running"],
		["is-active", "--quiet", "kaos-release-verify-running"],
	]);
	const verifyRunningUpdateSmokeArgs = JSON.parse(await readFile(verifyRunningUpdateSmokeLog, "utf8"));
	assert.equal(verifyRunningUpdateSmokeArgs.includes("--work-dir"), true);
	assert.equal(verifyRunningUpdateSmokeArgs.includes(verifyRunningUpdateSmokeWorkDir), true);
	assert.equal(verifyRunningUpdate.stdout.includes("release-verify-running-token"), false, "verify-running update should not leak token material");
	console.log("  PASS  release updater forwards postflight verify-running mode");

	console.log("\n--- headless host oracle deploy: release updater can run postflight-only verification ---");
	const postflightOnlySystemctlLog = join(root, "release-postflight-only-systemctl.log");
	const postflightOnlySmokeLog = join(root, "release-postflight-only-smoke.log");
	const postflightOnly = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--postflight-only",
		"--install-dir",
		verifyRunningUpdateInstallDir,
		"--service-path",
		verifyRunningUpdateServicePath,
		"--postflight-verify-running",
		"--postflight-vault",
		verifyRunningUpdateVault,
		"--postflight-data-file",
		join(verifyRunningUpdateDataDir, "data.json"),
		"--postflight-lock-file",
		join(verifyRunningUpdateLockDir, "kaos.lock"),
		"--postflight-env-file",
		verifyRunningUpdateEnvFile,
		"--postflight-token-file",
		verifyRunningUpdateTokenFile,
		"--postflight-systemctl",
		verifyRunningUpdateSystemctl,
		"--postflight-node",
		process.execPath,
		"--postflight-service",
		"kaos-release-verify-running",
		"--postflight-smoke-script",
		verifyRunningUpdateSmoke,
		"--postflight-smoke-work-dir",
		verifyRunningUpdateSmokeWorkDir,
		"--postflight-skip-service-file-check",
		"--postflight-no-smoke-user",
	], {
		env: {
			...process.env,
			KAOS_RELEASE_VERIFY_RUNNING_SYSTEMCTL_LOG: postflightOnlySystemctlLog,
			KAOS_RELEASE_VERIFY_RUNNING_SMOKE_LOG: postflightOnlySmokeLog,
		},
	});
	const postflightOnlyPayload = JSON.parse(postflightOnly.stdout);
	assert.equal(postflightOnlyPayload.ok, true);
	assert.equal(postflightOnlyPayload.mode, "postflight-only");
	assert.equal(postflightOnlyPayload.postflightOnly, true);
	assert.equal(Object.hasOwn(postflightOnlyPayload, "install"), false);
	assert.equal(Object.hasOwn(postflightOnlyPayload, "downloaded"), false);
	assert.equal(existsSync(join(verifyRunningUpdateInstallDir, "kaos-headless-host.mjs.previous")), false, "postflight-only should not reinstall the binary");
	assert.equal(postflightOnlyPayload.postflight.readiness.mode, "verify-running");
	assert.equal(postflightOnlyPayload.postflight.readiness.bootServiceEnabled, true);
	assert.deepEqual((await readFile(postflightOnlySystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["is-enabled", "--quiet", "kaos-release-verify-running"],
		["is-active", "--quiet", "kaos-release-verify-running"],
	]);
	assert.equal(postflightOnly.stdout.includes("release-verify-running-token"), false, "postflight-only should not leak token material");
	console.log("  PASS  postflight-only verifies installed service without reinstalling");

	console.log("\n--- headless host oracle deploy: postflight-only rejects release/update options ---");
	const postflightOnlyWithRelease = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--postflight-only",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--install-dir",
		verifyRunningUpdateInstallDir,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(postflightOnlyWithRelease.status, 0, "postflight-only should reject release source options");
	const postflightOnlyWithReleasePayload = JSON.parse(postflightOnlyWithRelease.stderr.trim());
	assert.equal(postflightOnlyWithReleasePayload.kind, "headless-host-release-update");
	assert.equal(postflightOnlyWithReleasePayload.ok, false);
	assert.match(postflightOnlyWithReleasePayload.error, /--postflight-only cannot be combined/);
	assert.match(postflightOnlyWithReleasePayload.error, /--base-url/);
	console.log("  PASS  postflight-only fails closed when update options are mixed in");

	console.log("\n--- headless host oracle deploy: postflight-only preserves failed postflight diagnostics ---");
	const postflightOnlyFailureScript = join(root, "release-postflight-only-fail.cjs");
	await writeFile(postflightOnlyFailureScript, `#!/usr/bin/env node
console.error(JSON.stringify({
  kind: "headless-host-postflight",
  ok: false,
  failedStage: "verify-running",
  error: "postflight-only saw release-verify-running-token"
}));
process.exit(6);
`, "utf8");
	await chmod(postflightOnlyFailureScript, 0o755);
	const postflightOnlyFailure = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--postflight-only",
		"--install-dir",
		verifyRunningUpdateInstallDir,
		"--service-path",
		verifyRunningUpdateServicePath,
		"--postflight-script",
		postflightOnlyFailureScript,
		"--postflight-env-file",
		verifyRunningUpdateEnvFile,
		"--postflight-token-file",
		verifyRunningUpdateTokenFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(postflightOnlyFailure.status, 0, "postflight-only should fail when its postflight child fails");
	assert.equal(postflightOnlyFailure.stderr.includes("release-verify-running-token"), false, "postflight-only failure should redact token material");
	const postflightOnlyFailurePayload = JSON.parse(postflightOnlyFailure.stderr.trim());
	assert.equal(postflightOnlyFailurePayload.kind, "headless-host-release-update");
	assert.equal(postflightOnlyFailurePayload.ok, false);
	assert.equal(postflightOnlyFailurePayload.mode, "postflight-only");
	assert.equal(postflightOnlyFailurePayload.postflightOnly, true);
	assert.match(postflightOnlyFailurePayload.error, /postflight-only verification failed/);
	assert.equal(postflightOnlyFailurePayload.postflight.failedStage, "verify-running");
	assert.equal(postflightOnlyFailurePayload.postflight.error, "postflight-only saw [redacted]");
	console.log("  PASS  postflight-only keeps structured failed postflight diagnostics");

	console.log("\n--- headless host oracle deploy: release updater can run no-helper check-only postflight ---");
	const noHelperCheckInstallDir = join(root, "release-no-helper-check-opt", "kaos");
	const noHelperCheckWorkDir = join(root, "release-no-helper-check-work");
	const noHelperCheckVault = join(root, "release-no-helper-check-srv", "kaos", "vault");
	const noHelperCheckDataDir = join(root, "release-no-helper-check-var", "lib", "kaos-headless");
	const noHelperCheckLockDir = join(root, "release-no-helper-check-run", "kaos-headless");
	const noHelperCheckEtc = join(root, "release-no-helper-check-etc", "kaos");
	const noHelperCheckEnvFile = join(noHelperCheckEtc, "headless.env");
	const noHelperCheckTokenFile = join(noHelperCheckEtc, "sync-token");
	await mkdir(noHelperCheckVault, { recursive: true });
	await installVaultPlugin(noHelperCheckVault);
	await mkdir(noHelperCheckDataDir, { recursive: true });
	await mkdir(noHelperCheckLockDir, { recursive: true });
	await mkdir(noHelperCheckEtc, { recursive: true });
	await writeFile(noHelperCheckEnvFile, `KAOS_HOST=https://release-no-helper-check.example.invalid
KAOS_VAULT_ID=release-no-helper-check-vault
KAOS_DEVICE_NAME=release-no-helper-check-device
`, "utf8");
	await chmod(noHelperCheckEnvFile, 0o640);
	await writeFile(noHelperCheckTokenFile, "release-no-helper-check-token", "utf8");
	await chmod(noHelperCheckTokenFile, 0o640);
	const noHelperCheck = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		noHelperCheckWorkDir,
		"--install-dir",
		noHelperCheckInstallDir,
		"--no-service",
		"--no-helper-scripts",
		"--postflight",
		"--postflight-check-only",
		"--postflight-vault",
		noHelperCheckVault,
		"--postflight-data-file",
		join(noHelperCheckDataDir, "data.json"),
		"--postflight-lock-file",
		join(noHelperCheckLockDir, "kaos.lock"),
		"--postflight-env-file",
		noHelperCheckEnvFile,
		"--postflight-token-file",
		noHelperCheckTokenFile,
		"--postflight-skip-service-identity-check",
		"--postflight-skip-service-access-check",
	], {
		env: process.env,
	});
	const noHelperCheckPayload = JSON.parse(noHelperCheck.stdout);
	assert.equal(noHelperCheckPayload.ok, true);
	assert.equal(noHelperCheckPayload.helpers.length, 0);
	assert.equal(noHelperCheckPayload.postflight.checkOnly, true);
	assert.equal(noHelperCheckPayload.postflight.metadataChecks.ok, true);
	for (const helper of helperNames) {
		assert.equal(existsSync(join(noHelperCheckInstallDir, helper)), false, `${helper} should not be installed when --no-helper-scripts is set`);
	}
	console.log("  PASS  no-helper update uses wrapper-adjacent postflight helper");

	console.log("\n--- headless host oracle deploy: release updater redacts child postflight failures ---");
	const leakyUpdateInstallDir = join(root, "release-leaky-postflight-opt", "kaos");
	const leakyUpdateWorkDir = join(root, "release-leaky-postflight-work");
	const leakyUpdateEtc = join(root, "release-leaky-postflight-etc", "kaos");
	const leakyUpdateEnvFile = join(leakyUpdateEtc, "headless.env");
	const leakyUpdateTokenFile = join(leakyUpdateEtc, "sync-token");
	const leakyUpdatePostflight = join(root, "release-leaky-postflight.cjs");
	const leakyUpdateSecret = "release-wrapper-postflight-token";
	const leakyUpdateEnvSecret = "release-wrapper-env-token";
	await mkdir(leakyUpdateEtc, { recursive: true });
	await writeFile(leakyUpdateEnvFile, `KAOS_HOST=https://release-leaky-postflight.example.invalid
KAOS_VAULT_ID=release-leaky-postflight-vault
KAOS_DEVICE_NAME=release-leaky-postflight-device
SYNC_TOKEN=${leakyUpdateEnvSecret}
`, "utf8");
	await chmod(leakyUpdateEnvFile, 0o640);
	await writeFile(leakyUpdateTokenFile, leakyUpdateSecret, "utf8");
	await chmod(leakyUpdateTokenFile, 0o640);
	await writeFile(leakyUpdatePostflight, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeSync(1, "stdout ${leakyUpdateSecret} ${leakyUpdateEnvSecret}\\n");
fs.writeSync(2, "stderr ${leakyUpdateSecret} ${leakyUpdateEnvSecret}\\n");
process.exit(9);
`, "utf8");
	await chmod(leakyUpdatePostflight, 0o755);
	const leakyPostflightUpdate = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		leakyUpdateWorkDir,
		"--install-dir",
		leakyUpdateInstallDir,
		"--no-service",
		"--postflight",
		"--postflight-script",
		leakyUpdatePostflight,
		"--postflight-env-file",
		leakyUpdateEnvFile,
		"--postflight-token-file",
		leakyUpdateTokenFile,
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(leakyPostflightUpdate.status, 0, "leaky postflight should fail the release update");
	assert.equal(leakyPostflightUpdate.stderr.includes(leakyUpdateSecret), false, "release update failure should redact child stdout/stderr token material");
	assert.equal(leakyPostflightUpdate.stderr.includes(leakyUpdateEnvSecret), false, "release update failure should redact env-file token material");
	const leakyPostflightPayload = JSON.parse(leakyPostflightUpdate.stderr.trim());
	assert.equal(leakyPostflightPayload.kind, "headless-host-release-update");
	assert.equal(leakyPostflightPayload.ok, false);
	assert.equal(leakyPostflightPayload.postflight.stdout, "stdout [redacted] [redacted]");
	assert.equal(leakyPostflightPayload.postflight.stderr, "stderr [redacted] [redacted]");
	console.log("  PASS  release updater redacts custom postflight stdout/stderr failures");

	console.log("\n--- headless host oracle deploy: release manifest mismatch rejects downloaded installer ---");
	const manifestMismatchDir = join(root, "release-manifest-mismatch-assets");
	const manifestMismatchWorkDir = join(root, "release-manifest-mismatch-work");
	const manifestMismatchInstallDir = join(root, "release-manifest-mismatch-opt", "kaos");
	const manifestMismatchMarker = join(root, "release-manifest-mismatch-installer-used.txt");
	await mkdir(manifestMismatchDir, { recursive: true });
	for (const asset of ["kaos-headless-host.mjs", "kaos-headless-host.mjs.sha256", "kaos-headless-host.service", "kaos-headless-host-manifest.json", ...helperNames]) {
		await copyFile(join(releaseDir, asset), join(manifestMismatchDir, asset));
	}
	await writeFile(join(manifestMismatchDir, "install-headless-host.mjs"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.KAOS_TAMPERED_INSTALLER_MARKER) {
	writeFileSync(process.env.KAOS_TAMPERED_INSTALLER_MARKER, "used\\n");
}
process.exit(0);
`, "utf8");
	await chmod(join(manifestMismatchDir, "install-headless-host.mjs"), 0o755);
	const manifestMismatch = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${manifestMismatchDir}/`).href,
		"--work-dir",
		manifestMismatchWorkDir,
		"--install-dir",
		manifestMismatchInstallDir,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_TAMPERED_INSTALLER_MARKER: manifestMismatchMarker,
		},
	});
	assert.notEqual(manifestMismatch.status, 0, "manifest mismatch should fail before installer execution");
	const manifestMismatchPayload = JSON.parse(manifestMismatch.stderr.trim());
	assert.equal(manifestMismatchPayload.kind, "headless-host-release-update");
	assert.equal(manifestMismatchPayload.ok, false);
	assert.match(manifestMismatchPayload.error, /sha256 mismatch.*install-headless-host\.mjs/);
	assert.equal(existsSync(manifestMismatchMarker), false, "tampered installer should not execute");
	assert.equal(existsSync(join(manifestMismatchInstallDir, "kaos-headless-host.mjs")), false);
	console.log("  PASS  manifest verification rejects tampered release helpers before execution");

	console.log("\n--- headless host oracle deploy: helper install failure restores earlier helpers ---");
	const helperFailInstallDir = join(root, "release-helper-fail-opt", "kaos");
	const helperFailWorkDir = join(root, "release-helper-fail-work");
	await mkdir(helperFailInstallDir, { recursive: true });
	for (const helper of helperNames) {
		await writeFile(join(helperFailInstallDir, helper), `old ${helper}\n`, "utf8");
		await chmod(join(helperFailInstallDir, helper), 0o755);
	}
	await mkdir(`${join(helperFailInstallDir, "bootstrap-headless-host-oracle.mjs")}.previous`, { recursive: true });
	const helperFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		helperFailWorkDir,
		"--install-dir",
		helperFailInstallDir,
		"--no-service",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(helperFail.status, 0, "helper install should fail when an existing backup path is a directory");
	const helperFailPayload = JSON.parse(helperFail.stderr.trim());
	assert.equal(helperFailPayload.kind, "headless-host-release-update");
	assert.equal(helperFailPayload.ok, false);
	assert.match(helperFailPayload.error, /helper install failed after rolling back 1 helper/);
	assert.equal(await readFile(join(helperFailInstallDir, "bootstrap-headless-host-oracle.mjs"), "utf8"), "old bootstrap-headless-host-oracle.mjs\n");
	assert.equal(await readFile(join(helperFailInstallDir, "install-headless-host.mjs"), "utf8"), "old install-headless-host.mjs\n");
	assert.equal(await readFile(join(helperFailInstallDir, "update-headless-host-from-release.mjs"), "utf8"), "old update-headless-host-from-release.mjs\n");
	assert.equal(existsSync(join(helperFailInstallDir, "kaos-headless-host.mjs")), false, "binary should not be installed when helper staging fails");
	console.log("  PASS  failed helper batch does not leave earlier helpers half-updated");

	console.log("\n--- headless host oracle deploy: installer failure after helper staging rolls helpers back ---");
	const installerFailReleaseDir = join(root, "release-installer-fail-assets");
	const installerFailInstallDir = join(root, "release-installer-fail-opt", "kaos");
	const installerFailWorkDir = join(root, "release-installer-fail-work");
	await mkdir(installerFailReleaseDir, { recursive: true });
	await copyFile("dist/kaos-headless-host.mjs", join(installerFailReleaseDir, "kaos-headless-host.mjs"));
	await copyFile("dist/kaos-headless-host.mjs.sha256", join(installerFailReleaseDir, "kaos-headless-host.mjs.sha256"));
	await copyFile("deploy/kaos-headless-host.service", join(installerFailReleaseDir, "kaos-headless-host.service"));
	await writeFile(join(installerFailReleaseDir, "install-headless-host.mjs"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.includes("--dry-run")) {
	const result = spawnSync(process.execPath, [${JSON.stringify(join(process.cwd(), "scripts", "install-headless-host.mjs"))}, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}
process.stderr.write("intentional installer failure after helper staging");
process.exit(9);
`, "utf8");
	await chmod(join(installerFailReleaseDir, "install-headless-host.mjs"), 0o755);
	for (const helper of helperNames.filter((helper) => helper !== "install-headless-host.mjs")) {
		await copyFile(join("scripts", helper), join(installerFailReleaseDir, helper));
	}
	await writeHeadlessManifest(installerFailReleaseDir);
	const installerFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${installerFailReleaseDir}/`).href,
		"--work-dir",
		installerFailWorkDir,
		"--install-dir",
		installerFailInstallDir,
		"--no-service",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(installerFail.status, 0, "installer failure should fail the release update");
	const installerFailPayload = JSON.parse(installerFail.stderr.trim());
	assert.equal(installerFailPayload.kind, "headless-host-release-update");
	assert.equal(installerFailPayload.ok, false);
	assert.match(installerFailPayload.error, new RegExp(`rolled back ${helperNames.length} helper`));
	assert.equal(existsSync(join(installerFailInstallDir, "kaos-headless-host.mjs")), false);
	for (const helper of helperNames) {
		assert.equal(existsSync(join(installerFailInstallDir, helper)), false, `${helper} should be removed after rollback`);
	}
	console.log("  PASS  failed installer does not leave newly staged helpers active");

	console.log("\n--- headless host oracle deploy: release metadata write failure rolls back install ---");
	const metadataFailReleaseDir = join(root, "release-metadata-fail-assets");
	const metadataFailInstallDir = join(root, "release-metadata-fail-opt", "kaos");
	const metadataFailWorkDir = join(root, "release-metadata-fail-work");
	const metadataFailServicePath = join(root, "release-metadata-fail-etc", "systemd", "system", "kaos-headless-host.service");
	const metadataFailPath = join(root, "release-metadata-fail-metadata.json");
	await mkdir(metadataFailReleaseDir, { recursive: true });
	await mkdir(metadataFailInstallDir, { recursive: true });
	await mkdir(join(root, "release-metadata-fail-etc", "systemd", "system"), { recursive: true });
	await copyFile("dist/kaos-headless-host.mjs", join(metadataFailReleaseDir, "kaos-headless-host.mjs"));
	await copyFile("dist/kaos-headless-host.mjs.sha256", join(metadataFailReleaseDir, "kaos-headless-host.mjs.sha256"));
	await copyFile("deploy/kaos-headless-host.service", join(metadataFailReleaseDir, "kaos-headless-host.service"));
	await writeFile(join(metadataFailInstallDir, "kaos-headless-host.mjs"), "old metadata-fail binary\n", "utf8");
	await chmod(join(metadataFailInstallDir, "kaos-headless-host.mjs"), 0o755);
	await writeFile(metadataFailServicePath, "old metadata-fail service\n", "utf8");
	await chmod(metadataFailServicePath, 0o644);
	await writeFile(metadataFailPath, "old metadata-fail metadata\n", "utf8");
	for (const helper of helperNames) {
		await writeFile(join(metadataFailInstallDir, helper), `old metadata-fail ${helper}\n`, "utf8");
		await chmod(join(metadataFailInstallDir, helper), 0o755);
	}
	await writeFile(join(metadataFailReleaseDir, "install-headless-host.mjs"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["--", ${JSON.stringify(join(process.cwd(), "scripts", "install-headless-host.mjs"))}, ...args], {
	encoding: "utf8",
	env: process.env,
});
if (result.status !== 0) {
	process.stdout.write(result.stdout || "");
	process.stderr.write(result.stderr || "");
	process.exit(result.status ?? 1);
}
if (!args.includes("--dry-run")) {
	const metadataIndex = args.indexOf("--metadata-path");
	const installDirIndex = args.indexOf("--install-dir");
	const metadataPath = metadataIndex >= 0 ? args[metadataIndex + 1] : join(args[installDirIndex + 1], ".kaos-headless-install.json");
	rmSync(metadataPath, { recursive: true, force: true });
	mkdirSync(metadataPath, { recursive: true });
}
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(0);
`, "utf8");
	await chmod(join(metadataFailReleaseDir, "install-headless-host.mjs"), 0o755);
	for (const helper of helperNames.filter((helper) => helper !== "install-headless-host.mjs")) {
		await copyFile(join("scripts", helper), join(metadataFailReleaseDir, helper));
	}
	await writeHeadlessManifest(metadataFailReleaseDir);
	const metadataFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${metadataFailReleaseDir}/`).href,
		"--work-dir",
		metadataFailWorkDir,
		"--install-dir",
		metadataFailInstallDir,
		"--service-path",
		metadataFailServicePath,
		"--metadata-path",
		metadataFailPath,
		"--rollback-stamp",
		"metadata-fail-test",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(metadataFail.status, 0, "release metadata write failure should fail the update");
	const metadataFailPayload = JSON.parse(metadataFail.stderr.trim());
	assert.equal(metadataFailPayload.kind, "headless-host-release-update");
	assert.equal(metadataFailPayload.ok, false);
	assert.equal(metadataFailPayload.rolledBack, true);
	assert.match(metadataFailPayload.error, /release metadata write failed/);
	assert.equal(metadataFailPayload.rollback.ok, true);
	assert.equal(metadataFailPayload.rollbackSummary.restoredCount, rollbackWithServiceArtifactCount);
	assert.equal(await readFile(join(metadataFailInstallDir, "kaos-headless-host.mjs"), "utf8"), "old metadata-fail binary\n");
	assert.equal(await readFile(metadataFailServicePath, "utf8"), "old metadata-fail service\n");
	assert.equal(await readFile(metadataFailPath, "utf8"), "old metadata-fail metadata\n");
	for (const helper of helperNames) {
		assert.equal(await readFile(join(metadataFailInstallDir, helper), "utf8"), `old metadata-fail ${helper}\n`);
	}
	assert.equal(existsSync(`${metadataFailPath}.failed-metadata-fail-test`), true, "failed metadata directory should be preserved for inspection");
	console.log("  PASS  release metadata write failure restores previous install artifacts");

	console.log("\n--- headless host oracle deploy: no-helper metadata failure uses wrapper rollback ---");
	const noHelperMetadataInstallDir = join(root, "release-no-helper-metadata-fail-opt", "kaos");
	const noHelperMetadataWorkDir = join(root, "release-no-helper-metadata-fail-work");
	const noHelperMetadataPath = join(root, "release-no-helper-metadata-fail.json");
	const noHelperMetadataInstaller = join(root, "release-no-helper-metadata-installer.mjs");
	await mkdir(noHelperMetadataInstallDir, { recursive: true });
	await writeFile(join(noHelperMetadataInstallDir, "kaos-headless-host.mjs"), "old no-helper metadata binary\n", "utf8");
	await chmod(join(noHelperMetadataInstallDir, "kaos-headless-host.mjs"), 0o755);
	await writeFile(noHelperMetadataPath, "old no-helper metadata\n", "utf8");
	await writeFile(noHelperMetadataInstaller, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["--", ${JSON.stringify(join(process.cwd(), "scripts", "install-headless-host.mjs"))}, ...args], {
	encoding: "utf8",
	env: process.env,
});
if (result.status !== 0) {
	process.stdout.write(result.stdout || "");
	process.stderr.write(result.stderr || "");
	process.exit(result.status ?? 1);
}
if (!args.includes("--dry-run")) {
	const metadataIndex = args.indexOf("--metadata-path");
	const installDirIndex = args.indexOf("--install-dir");
	const metadataPath = metadataIndex >= 0 ? args[metadataIndex + 1] : join(args[installDirIndex + 1], ".kaos-headless-install.json");
	rmSync(metadataPath, { recursive: true, force: true });
	mkdirSync(metadataPath, { recursive: true });
}
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(0);
`, "utf8");
	await chmod(noHelperMetadataInstaller, 0o755);
	const noHelperMetadataFail = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		noHelperMetadataWorkDir,
		"--install-dir",
		noHelperMetadataInstallDir,
		"--metadata-path",
		noHelperMetadataPath,
		"--installer",
		noHelperMetadataInstaller,
		"--no-service",
		"--no-helper-scripts",
		"--rollback-stamp",
		"no-helper-metadata-fail-test",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(noHelperMetadataFail.status, 0, "no-helper metadata failure should fail the update");
	const noHelperMetadataPayload = JSON.parse(noHelperMetadataFail.stderr.trim());
	assert.equal(noHelperMetadataPayload.kind, "headless-host-release-update");
	assert.equal(noHelperMetadataPayload.ok, false);
	assert.equal(noHelperMetadataPayload.rolledBack, true);
	assert.equal(noHelperMetadataPayload.rollback.ok, true);
	assert.equal(noHelperMetadataPayload.rollbackSummary.restoredCount, 2);
	assert.equal(await readFile(join(noHelperMetadataInstallDir, "kaos-headless-host.mjs"), "utf8"), "old no-helper metadata binary\n");
	assert.equal(await readFile(noHelperMetadataPath, "utf8"), "old no-helper metadata\n");
	assert.equal(existsSync(join(noHelperMetadataInstallDir, "rollback-headless-host.mjs")), false, "rollback helper should not be installed in no-helper mode");
	console.log("  PASS  no-helper metadata failure falls back to wrapper-adjacent rollback helper");

	console.log("\n--- headless host oracle deploy: release updater dry-run does not replace files ---");
	const dryRunInstallDir = join(root, "release-dry-run-opt", "kaos");
	const dryRunServicePath = join(root, "release-dry-run-etc", "systemd", "system", "kaos-headless-host.service");
	const dryRun = run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		join(root, "release-dry-run-work"),
		"--install-dir",
		dryRunInstallDir,
		"--service-path",
		dryRunServicePath,
		"--dry-run",
	]);
	const dryRunPayload = JSON.parse(dryRun.stdout);
	assert.equal(dryRunPayload.kind, "headless-host-release-update");
	assert.equal(dryRunPayload.install.dryRun, true);
	assert.equal(dryRunPayload.install.binary.installed, false);
	assert.equal(dryRunPayload.helpers.every((helper) => helper.installed === false), true);
	assert.equal(existsSync(join(dryRunInstallDir, "kaos-headless-host.mjs")), false);
	assert.equal(existsSync(dryRunServicePath), false);
	assert.equal(existsSync(join(dryRunInstallDir, "smoke-headless-host-sync.mjs")), false);
	console.log("  PASS  dry-run verifies release assets without replacing files");

	console.log("\n--- headless host oracle deploy: rollback restores previous install artifacts ---");
	const rollbackDir = join(root, "rollback-opt", "kaos");
	const rollbackServicePath = join(root, "rollback-etc", "systemd", "system", "kaos-headless-host.service");
	const rollbackMetadataPath = join(rollbackDir, ".kaos-headless-install.json");
	await mkdir(rollbackDir, { recursive: true });
	await mkdir(join(root, "rollback-etc", "systemd", "system"), { recursive: true });
	const rollbackFiles = [
		[join(rollbackDir, "kaos-headless-host.mjs"), "failed binary\n", "previous binary\n", 0o755],
		[rollbackServicePath, "failed service\n", "previous service\n", 0o644],
		[rollbackMetadataPath, "{\"release\":\"failed\"}\n", "{\"release\":\"previous\"}\n", 0o644],
		...helperNames.map((helper) => [
			join(rollbackDir, helper),
			`failed ${helper}\n`,
			`previous ${helper}\n`,
			0o755,
		]),
	];
	for (const [path, current, previous, mode] of rollbackFiles) {
		await writeFile(path, current, "utf8");
		await writeFile(`${path}.previous`, previous, "utf8");
		await chmod(path, mode);
		await chmod(`${path}.previous`, mode);
	}
	const rollbackDryRun = run(process.execPath, [
		"scripts/rollback-headless-host.mjs",
		"--install-dir",
		rollbackDir,
		"--service-path",
		rollbackServicePath,
		"--metadata-path",
		rollbackMetadataPath,
		"--rollback-stamp",
		"dry",
		"--dry-run",
	]);
	const rollbackDryRunPayload = JSON.parse(rollbackDryRun.stdout);
	assert.equal(rollbackDryRunPayload.kind, "headless-host-rollback");
	assert.equal(rollbackDryRunPayload.dryRun, true);
	assert.equal(rollbackDryRunPayload.restored.every((entry) => entry.restored === false), true);
	assert.equal(await readFile(join(rollbackDir, "kaos-headless-host.mjs"), "utf8"), "failed binary\n");
	const rollback = run(process.execPath, [
		"scripts/rollback-headless-host.mjs",
		"--install-dir",
		rollbackDir,
		"--service-path",
		rollbackServicePath,
		"--metadata-path",
		rollbackMetadataPath,
		"--rollback-stamp",
		"test",
	]);
	const rollbackPayload = JSON.parse(rollback.stdout);
	assert.equal(rollbackPayload.kind, "headless-host-rollback");
	assert.equal(rollbackPayload.ok, true);
	assert.equal(rollbackPayload.restored.length, rollbackWithServiceArtifactCount);
	assert.equal(await readFile(join(rollbackDir, "kaos-headless-host.mjs"), "utf8"), "previous binary\n");
	assert.equal(await readFile(`${join(rollbackDir, "kaos-headless-host.mjs")}.previous`, "utf8"), "previous binary\n");
	assert.equal(await readFile(`${join(rollbackDir, "kaos-headless-host.mjs")}.failed-test`, "utf8"), "failed binary\n");
	assert.equal(await readFile(rollbackServicePath, "utf8"), "previous service\n");
	assert.equal(await readFile(rollbackMetadataPath, "utf8"), "{\"release\":\"previous\"}\n");
	assert.equal(await readFile(`${rollbackMetadataPath}.failed-test`, "utf8"), "{\"release\":\"failed\"}\n");
	assert.equal(await readFile(join(rollbackDir, "bootstrap-headless-host-oracle.mjs"), "utf8"), "previous bootstrap-headless-host-oracle.mjs\n");
	assert.equal(await readFile(join(rollbackDir, "verify-headless-host-bundle.mjs"), "utf8"), "previous verify-headless-host-bundle.mjs\n");
	assert.equal((await stat(join(rollbackDir, "rollback-headless-host.mjs"))).mode & 0o777, 0o755);
	console.log("  PASS  rollback restores .previous while preserving failed artifacts");

	console.log("\n--- headless host oracle deploy: postflight runs strict doctor and systemctl in order ---");
	const postflightRoot = join(root, "postflight");
	const postflightVault = join(postflightRoot, "srv", "kaos", "vault");
	const postflightDataDir = join(postflightRoot, "var", "lib", "kaos-headless");
	const postflightLockDir = join(postflightRoot, "run", "kaos-headless");
	const postflightEtc = join(postflightRoot, "etc", "kaos");
	const postflightSystemctl = join(postflightRoot, "fake-systemctl.cjs");
	const postflightSystemctlLog = join(postflightRoot, "systemctl.log");
	const postflightNode = join(postflightRoot, "fake-node.cjs");
	const postflightNodeLog = join(postflightRoot, "node.log");
	const postflightServiceFile = join(postflightRoot, "kaos-headless-host.service");
	const postflightEnvFile = join(postflightEtc, "headless.env");
	const postflightTokenFile = join(postflightEtc, "sync-token");
	await mkdir(postflightVault, { recursive: true });
	await installVaultPlugin(postflightVault);
	await mkdir(postflightDataDir, { recursive: true });
	await mkdir(postflightLockDir, { recursive: true });
	await mkdir(postflightEtc, { recursive: true });
await writeFile(postflightEnvFile, `KAOS_HOST=https://postflight.example.invalid
KAOS_VAULT_ID=postflight-vault
KAOS_DEVICE_NAME=postflight-device
`, "utf8");
	await chmod(postflightEnvFile, 0o640);
	await writeFile(postflightTokenFile, "postflight-token", "utf8");
	await chmod(postflightTokenFile, 0o640);
	await writeFile(postflightSystemctl, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.KAOS_FAKE_SYSTEMCTL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`, "utf8");
	await writeFile(postflightNode, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(process.env.KAOS_FAKE_NODE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const result = spawnSync(process.execPath, process.argv.slice(2), {
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`, "utf8");
const postflightBinary = join(process.cwd(), "dist", "kaos-headless-host.mjs");
	const postflightWorkingDirectory = join(process.cwd(), "dist");
	await writeFile(postflightServiceFile, `[Service]
User=kaos-test-user
WorkingDirectory=${postflightWorkingDirectory}
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	await chmod(postflightSystemctl, 0o755);
	await chmod(postflightNode, 0o755);
	const postflight = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	const postflightPayload = JSON.parse(postflight.stdout);
	assert.equal(postflightPayload.kind, "headless-host-postflight");
	assert.equal(postflightPayload.ok, true);
	assert.equal(postflightPayload.nodeBin, postflightNode);
	assert.equal(postflightPayload.serviceUser, "kaos-test-user");
	assert.match(postflightPayload.nodeVersion, /^v\d+\./);
	assert.equal(postflightPayload.minNodeMajor, 20);
	assert.equal(postflightPayload.nodeVersionCheck.ok, true);
	assert.equal(postflightPayload.serviceIdentityChecks.ok, true);
	assert.equal(postflightPayload.secretFileChecks.ok, true);
	assert.equal(postflightPayload.secretFileChecks.envFile.mode, "0640");
	assert.equal(postflightPayload.secretFileChecks.envFile.containsToken, false);
	assert.equal(postflightPayload.secretFileChecks.tokenFile.mode, "0640");
	assert.equal(postflightPayload.serviceFileChecks.ok, true);
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "service-user-non-root" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "working-directory" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "restart-on-failure" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "restart-sec-positive" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "exec-start-node-argument-separator" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "exec-start-pre-node-argument-separator" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "exec-start-vault" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "exec-start-pre-require-sync-config" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "protect-system-strict" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "protect-home-vault-access" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "runtime-directory-lock-dir" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "state-directory-data-dir" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "read-write-paths-vault" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "read-write-paths-data-dir" && check.ok));
	assert.ok(postflightPayload.serviceFileChecks.checks.some((check) => check.name === "read-write-paths-lock-dir" && check.ok));
	assert.equal(postflightPayload.doctor.ok, true);
	assert.equal(postflightPayload.readiness.mode, "no-smoke");
	assert.equal(postflightPayload.readiness.preRestartReady, true);
	assert.equal(postflightPayload.readiness.liveServiceVerified, true);
	assert.equal(postflightPayload.readiness.syncSmokeVerified, false);
	for (const name of ["service-identity", "secret-files", "node-version", "service-file", "doctor"]) {
		assert.ok(postflightPayload.readiness.completed.includes(name), `readiness should complete ${name}`);
	}
	assert.ok(postflightPayload.readiness.skipped.includes("smoke"));
	for (const name of ["vault-root-writable", "data-dir-writable", "lock-dir-writable"]) {
		assert.ok(postflightPayload.doctor.checks.some((check) => check.name === name && check.ok), `${name} should pass`);
	}
	assert.equal(postflightPayload.smoke, null);
	assert.deepEqual((await readFile(postflightSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["daemon-reload"],
		["restart", "kaos-test"],
		["is-active", "--quiet", "kaos-test"],
	]);
	const postflightNodeArgs = (await readFile(postflightNodeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(postflightNodeArgs[0], ["--version"]);
	assert.equal(postflightNodeArgs[1][0], "--");
	assert.equal(postflightNodeArgs[1][1], join(process.cwd(), "dist", "kaos-headless-host.mjs"));
	assert.equal(postflightNodeArgs[1].includes("--doctor"), true);
	assert.equal(postflight.stdout.includes("postflight-token"), false, "postflight output should not leak token material");
	console.log("  PASS  postflight wraps doctor, restart, and active checks");

	console.log("\n--- headless host oracle deploy: postflight verifies running service without restart ---");
	const verifyRunningSystemctlLog = join(postflightRoot, "systemctl-verify-running.log");
	const verifyRunningSmoke = join(postflightRoot, "verify-running-smoke.cjs");
	const verifyRunningSmokeLog = join(postflightRoot, "verify-running-smoke.log");
	await writeFile(verifyRunningSmoke, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.KAOS_VERIFY_RUNNING_SMOKE_LOG, JSON.stringify(process.argv.slice(2)));
if (!process.argv.includes("--require-lock")) process.exit(3);
console.log(JSON.stringify({
  kind: "headless-host-sync-smoke",
  ok: true,
  tokenConfigured: true,
  via: "verify-running-smoke"
}));
`, "utf8");
	await chmod(verifyRunningSmoke, 0o755);
	const verifyRunning = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--smoke-script",
		verifyRunningSmoke,
		"--verify-running",
		"--no-smoke-user",
	], {
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: verifyRunningSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
			KAOS_VERIFY_RUNNING_SMOKE_LOG: verifyRunningSmokeLog,
		},
	});
	const verifyRunningPayload = JSON.parse(verifyRunning.stdout);
	assert.equal(verifyRunningPayload.ok, true);
	assert.equal(verifyRunningPayload.verifyRunning, true);
	assert.equal(verifyRunningPayload.readiness.mode, "verify-running");
	assert.equal(verifyRunningPayload.bootServiceEnabled.status, 0);
	assert.equal(verifyRunningPayload.readiness.bootServiceEnabled, true);
	assert.equal(verifyRunningPayload.readiness.liveServiceVerified, true);
	assert.equal(verifyRunningPayload.readiness.syncSmokeVerified, true);
	assert.equal(verifyRunningPayload.smoke.via, "verify-running-smoke");
	assert.deepEqual((await readFile(verifyRunningSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["is-enabled", "--quiet", "kaos-test"],
		["is-active", "--quiet", "kaos-test"],
	]);
	const verifyRunningSmokeArgs = JSON.parse(await readFile(verifyRunningSmokeLog, "utf8"));
	assert.equal(verifyRunningSmokeArgs.includes("--require-lock"), true);
	assert.equal(verifyRunningSmokeArgs.includes("dist/kaos-headless-host.mjs") || verifyRunningSmokeArgs.includes(join(process.cwd(), "dist", "kaos-headless-host.mjs")), true);
	console.log("  PASS  postflight can verify booted service without masking it via restart");

	console.log("\n--- headless host oracle deploy: postflight check-only avoids service restart ---");
	const checkOnlySystemctlLog = join(postflightRoot, "systemctl-check-only.log");
	const checkOnly = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--check-only",
	], {
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: checkOnlySystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	const checkOnlyPayload = JSON.parse(checkOnly.stdout);
	assert.equal(checkOnlyPayload.ok, true);
	assert.equal(checkOnlyPayload.checkOnly, true);
	assert.equal(checkOnlyPayload.systemctl.length, 0);
	assert.equal(checkOnlyPayload.smoke, null);
	assert.equal(checkOnlyPayload.doctor.ok, true);
	assert.equal(checkOnlyPayload.readiness.mode, "check-only");
	assert.equal(checkOnlyPayload.readiness.preRestartReady, true);
	assert.equal(checkOnlyPayload.readiness.liveServiceVerified, false);
	assert.equal(checkOnlyPayload.readiness.syncSmokeVerified, false);
	assert.ok(checkOnlyPayload.readiness.completed.includes("service-file"));
	assert.ok(checkOnlyPayload.readiness.completed.includes("doctor"));
	assert.ok(checkOnlyPayload.readiness.skipped.includes("systemctl"));
	assert.ok(checkOnlyPayload.readiness.skipped.includes("smoke"));
	assert.equal(existsSync(checkOnlySystemctlLog), false, "check-only should not call systemctl");
	console.log("  PASS  check-only verifies state without restart or smoke");

	console.log("\n--- headless host oracle deploy: postflight rejects missing service users ---");
	const missingUserServiceFile = join(postflightRoot, "missing-user.service");
	await writeFile(missingUserServiceFile, `[Service]
User=kaos-user-that-should-not-exist
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const missingUserPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		missingUserServiceFile,
		"--check-only",
		"--require-service-identity-check",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(missingUserPostflight.status, 0, "postflight should reject missing service users before restart");
	const missingUserPayload = JSON.parse(missingUserPostflight.stderr);
	assert.equal(missingUserPayload.failedStage, "service-identity");
	assert.ok(missingUserPayload.failure.detail.checks.some((check) => check.name === "service-user-exists" && !check.ok));
	console.log("  PASS  postflight catches missing service users before restart");

	console.log("\n--- headless host oracle deploy: postflight infers service name from service file ---");
	const inferredServiceFile = join(postflightRoot, "kaos-inferred.service");
	const inferredSystemctlLog = join(postflightRoot, "systemctl-inferred.log");
	await writeFile(inferredServiceFile, `[Service]
User=kaos-test-user
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const inferredPostflight = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		inferredServiceFile,
		"--skip-smoke",
	], {
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: inferredSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	const inferredPostflightPayload = JSON.parse(inferredPostflight.stdout);
	assert.equal(inferredPostflightPayload.service, "kaos-inferred");
	assert.deepEqual((await readFile(inferredSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["daemon-reload"],
		["restart", "kaos-inferred"],
		["is-active", "--quiet", "kaos-inferred"],
	]);
	console.log("  PASS  postflight restarts the service named by --service-file");

	console.log("\n--- headless host oracle deploy: postflight rejects unsupported Node versions ---");
	const oldNode = join(postflightRoot, "old-node.cjs");
	await writeFile(oldNode, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "--version") {
  console.log("v18.19.0");
  process.exit(0);
}
const result = spawnSync(process.execPath, process.argv.slice(2), {
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`, "utf8");
	await chmod(oldNode, 0o755);
	const oldNodePostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--node",
		oldNode,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-file-check",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(oldNodePostflight.status, 0, "postflight should reject Node versions below the default minimum");
	const oldNodePayload = JSON.parse(oldNodePostflight.stderr);
	assert.equal(oldNodePayload.failedStage, "node-version");
	assert.equal(oldNodePayload.failure.detail.minMajor, 20);
	assert.equal(oldNodePayload.failure.detail.major, 18);
	assert.equal(oldNodePayload.failure.detail.ok, false);
	console.log("  PASS  postflight rejects unsupported Node before restart");

	console.log("\n--- headless host oracle deploy: postflight prepares systemd-managed directories ---");
	const managedRoot = join(root, "postflight-managed-dirs");
	const managedVault = join(managedRoot, "srv", "kaos", "vault");
	const managedDataDir = join(managedRoot, "var", "lib", "kaos-headless");
	const managedLockDir = join(managedRoot, "run", "kaos-headless");
	const managedEtc = join(managedRoot, "etc", "kaos");
	const managedSystemctl = join(managedRoot, "fake-systemctl.cjs");
	const managedServiceFile = join(managedRoot, "kaos-headless-host.service");
	const managedEnvFile = join(managedEtc, "headless.env");
	const managedTokenFile = join(managedEtc, "sync-token");
	await mkdir(managedVault, { recursive: true });
	await installVaultPlugin(managedVault);
	await mkdir(managedEtc, { recursive: true });
	await writeFile(managedEnvFile, `KAOS_HOST=https://managed-dirs.example.invalid
KAOS_VAULT_ID=managed-dirs-vault
KAOS_DEVICE_NAME=managed-dirs-device
`, "utf8");
	await chmod(managedEnvFile, 0o640);
	await writeFile(managedTokenFile, "managed-dirs-token", "utf8");
	await chmod(managedTokenFile, 0o640);
	await writeFile(managedSystemctl, `#!/usr/bin/env node
process.exit(0);
`, "utf8");
	await chmod(managedSystemctl, 0o755);
	await writeFile(managedServiceFile, `[Service]
User=kaos-managed-user
Group=kaos-managed-group
EnvironmentFile=${managedEnvFile}
ExecStartPre=${process.execPath} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${managedVault} \\
  --data-file ${join(managedDataDir, "data.json")} \\
  --lock-file ${join(managedLockDir, "kaos.lock")} \\
  --token-file ${managedTokenFile}
ExecStart=${process.execPath} -- ${postflightBinary} \\
  --vault ${managedVault} \\
  --data-file ${join(managedDataDir, "data.json")} \\
  --lock-file ${join(managedLockDir, "kaos.lock")} \\
  --token-file ${managedTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${managedLockDir}
StateDirectory=${managedDataDir}
ProtectSystem=strict
ReadWritePaths=${managedVault} ${managedDataDir} ${managedLockDir}
`, "utf8");
	const managedPostflight = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		managedVault,
		"--data-file",
		join(managedDataDir, "data.json"),
		"--lock-file",
		join(managedLockDir, "kaos.lock"),
		"--env-file",
		managedEnvFile,
		"--token-file",
		managedTokenFile,
		"--systemctl",
		managedSystemctl,
		"--service-file",
		managedServiceFile,
		"--service",
		"kaos-managed-dirs",
		"--skip-smoke",
	]);
	const managedPostflightPayload = JSON.parse(managedPostflight.stdout);
	assert.equal(managedPostflightPayload.ok, true);
	assert.equal(managedPostflightPayload.serviceGroup, "kaos-managed-group");
	assert.equal(existsSync(managedDataDir), true, "postflight should prepare the state directory before doctor");
	assert.equal(existsSync(managedLockDir), true, "postflight should prepare the runtime directory before doctor");
	assert.ok(managedPostflightPayload.managedDirectoryPreparation.entries.some((entry) => entry.name === "data-dir" && entry.created));
	assert.ok(managedPostflightPayload.managedDirectoryPreparation.entries.some((entry) => entry.name === "lock-dir" && entry.created));
	assert.equal(managedPostflightPayload.doctor.ok, true);
	console.log("  PASS  postflight prepares missing RuntimeDirectory/StateDirectory targets");

	console.log("\n--- headless host oracle deploy: postflight rejects install metadata drift ---");
	const driftMetadataPath = join(postflightRoot, "kaos-headless-install-drift.json");
	await writeFile(driftMetadataPath, `${JSON.stringify({
		runtime: "kaos-headless-host",
		installedAt: new Date(0).toISOString(),
		sha256: "0".repeat(64),
		binaryPath: postflightBinary,
		servicePath: postflightServiceFile,
	}, null, 2)}\n`, "utf8");
	const metadataDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--metadata-path",
		driftMetadataPath,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(metadataDriftPostflight.status, 0, "postflight should reject mismatched install metadata");
	const metadataDriftPayload = JSON.parse(metadataDriftPostflight.stderr);
	assert.equal(metadataDriftPayload.failedStage, "metadata");
	assert.ok(metadataDriftPayload.failure.detail.checks.some((check) => check.name === "metadata-binary-sha256" && !check.ok));
	console.log("  PASS  postflight catches install metadata drift before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service file path drift ---");
	const driftServiceFile = join(postflightRoot, "kaos-headless-host-drift.service");
	await writeFile(driftServiceFile, `[Service]
User=kaos-test-user
EnvironmentFile=${postflightEnvFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${join(postflightRoot, "wrong-vault")} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${join(postflightRoot, "wrong-vault")} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const driftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		driftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(driftPostflight.status, 0, "postflight should fail when service file points at a different vault");
	const driftPostflightPayload = JSON.parse(driftPostflight.stderr);
	assert.equal(driftPostflightPayload.kind, "headless-host-postflight");
	assert.equal(driftPostflightPayload.failedStage, "service-file");
	assert.equal(driftPostflightPayload.failure.detail.ok, false);
	assert.ok(driftPostflightPayload.failure.detail.checks.some((check) => check.name === "exec-start-vault" && !check.ok));
	console.log("  PASS  postflight catches service file drift before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects working directory drift ---");
	const workingDirDriftServiceFile = join(postflightRoot, "kaos-headless-host-working-dir-drift.service");
	await writeFile(workingDirDriftServiceFile, `[Service]
User=kaos-test-user
WorkingDirectory=${join(postflightRoot, "wrong-working-directory")}
EnvironmentFile=${postflightEnvFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const workingDirDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		workingDirDriftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(workingDirDriftPostflight.status, 0, "postflight should fail when WorkingDirectory points elsewhere");
	const workingDirDriftPayload = JSON.parse(workingDirDriftPostflight.stderr);
	assert.equal(workingDirDriftPayload.failedStage, "service-file");
	assert.ok(workingDirDriftPayload.failure.detail.checks.some((check) => check.name === "working-directory" && !check.ok));
	console.log("  PASS  postflight catches WorkingDirectory drift before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects ProtectHome blocking vault ---");
	const protectedHomeVault = join(process.cwd(), `.tmp-kaos-protect-home-vault-${Date.now()}`);
	workspaceTempDirs.push(protectedHomeVault);
	await mkdir(protectedHomeVault, { recursive: true });
	const protectHomeDriftServiceFile = join(postflightRoot, "kaos-headless-host-protect-home-drift.service");
	await writeFile(protectHomeDriftServiceFile, `[Service]
User=kaos-test-user
WorkingDirectory=${postflightWorkingDirectory}
EnvironmentFile=${postflightEnvFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${protectedHomeVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${protectedHomeVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${protectedHomeVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const protectHomeDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		protectedHomeVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		protectHomeDriftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
		"--skip-service-identity-check",
		"--skip-service-access-check",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
			KAOS_POSTFLIGHT_PROTECT_HOME_ROOTS: protectedHomeVault,
		},
	});
	assert.notEqual(protectHomeDriftPostflight.status, 0, "postflight should fail when ProtectHome blocks the configured vault");
	const protectHomeDriftPayload = JSON.parse(protectHomeDriftPostflight.stderr);
	assert.equal(protectHomeDriftPayload.failedStage, "service-file");
	assert.ok(protectHomeDriftPayload.failure.detail.checks.some((check) => check.name === "protect-home-vault-access" && !check.ok));
	console.log("  PASS  postflight catches ProtectHome blocking vault before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects runtime directory drift ---");
	const runtimeDriftServiceFile = join(postflightRoot, "kaos-headless-host-runtime-drift.service");
	await writeFile(runtimeDriftServiceFile, `[Service]
User=kaos-test-user
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${join(postflightRoot, "wrong-run")}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const runtimeDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		runtimeDriftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(runtimeDriftPostflight.status, 0, "postflight should reject mismatched RuntimeDirectory");
	const runtimeDriftPayload = JSON.parse(runtimeDriftPostflight.stderr);
	assert.equal(runtimeDriftPayload.failedStage, "service-file");
	assert.ok(runtimeDriftPayload.failure.detail.checks.some((check) => check.name === "runtime-directory-lock-dir" && !check.ok));
	console.log("  PASS  postflight catches RuntimeDirectory drift before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects state directory drift ---");
	const stateDriftServiceFile = join(postflightRoot, "kaos-headless-host-state-drift.service");
	await writeFile(stateDriftServiceFile, `[Service]
User=kaos-test-user
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${join(postflightRoot, "wrong-state")}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const stateDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		stateDriftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(stateDriftPostflight.status, 0, "postflight should reject mismatched StateDirectory");
	const stateDriftPayload = JSON.parse(stateDriftPostflight.stderr);
	assert.equal(stateDriftPayload.failedStage, "service-file");
	assert.ok(stateDriftPayload.failure.detail.checks.some((check) => check.name === "state-directory-data-dir" && !check.ok));
	console.log("  PASS  postflight catches StateDirectory drift before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects missing restart policy ---");
	const restartDriftServiceFile = join(postflightRoot, "kaos-headless-host-restart-drift.service");
	await writeFile(restartDriftServiceFile, `[Service]
User=kaos-test-user
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const restartDriftPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		restartDriftServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(restartDriftPostflight.status, 0, "postflight should reject service files without restart policy");
	const restartDriftPayload = JSON.parse(restartDriftPostflight.stderr);
	assert.equal(restartDriftPayload.failedStage, "service-file");
	assert.ok(restartDriftPayload.failure.detail.checks.some((check) => check.name === "restart-on-failure" && !check.ok));
	assert.ok(restartDriftPayload.failure.detail.checks.some((check) => check.name === "restart-sec-positive" && !check.ok));
	console.log("  PASS  postflight catches missing systemd restart policy before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects root service user ---");
	const rootUserServiceFile = join(postflightRoot, "kaos-headless-host-root-user.service");
	await writeFile(rootUserServiceFile, `[Service]
User=root
EnvironmentFile=${postflightEnvFile}
ExecStartPre=${postflightNode} -- ${postflightBinary} --doctor --require-sync-config --skip-worker-capabilities \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
ExecStart=${postflightNode} -- ${postflightBinary} \\
  --vault ${postflightVault} \\
  --data-file ${join(postflightDataDir, "data.json")} \\
  --lock-file ${join(postflightLockDir, "kaos.lock")} \\
  --token-file ${postflightTokenFile}
Restart=on-failure
RestartSec=5
RuntimeDirectory=${postflightLockDir}
StateDirectory=${postflightDataDir}
ProtectSystem=strict
ReadWritePaths=${postflightVault} ${postflightDataDir} ${postflightLockDir}
`, "utf8");
	const rootUserPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		rootUserServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(rootUserPostflight.status, 0, "postflight should reject a root service user");
	const rootUserPostflightPayload = JSON.parse(rootUserPostflight.stderr);
	assert.equal(rootUserPostflightPayload.failedStage, "service-file");
	assert.ok(rootUserPostflightPayload.failure.detail.checks.some((check) => check.name === "service-user-non-root" && !check.ok));
	console.log("  PASS  postflight rejects root-owned service execution before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects broad token permissions ---");
	const weakTokenFile = join(postflightEtc, "weak-sync-token");
	await writeFile(weakTokenFile, "postflight-token", "utf8");
	await chmod(weakTokenFile, 0o644);
	const weakTokenPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		weakTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(weakTokenPostflight.status, 0, "postflight should reject world-readable token files");
	const weakTokenPayload = JSON.parse(weakTokenPostflight.stderr);
	assert.equal(weakTokenPayload.failedStage, "preflight:token-file-permissions");
	assert.equal(weakTokenPayload.failure.detail.tokenFile.mode, "0644");
	assert.ok(weakTokenPayload.failure.detail.checks.some((check) => check.name === "token-file-not-world-accessible" && !check.ok));
	assert.equal(weakTokenPostflight.stderr.includes("postflight-token"), false, "weak token failure should not leak token material");
	console.log("  PASS  postflight rejects broad token file permissions before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects world-readable env token ---");
	const weakEnvFile = join(postflightEtc, "weak-headless.env");
	await writeFile(weakEnvFile, `KAOS_HOST=https://postflight.example.invalid
KAOS_VAULT_ID=postflight-vault
KAOS_DEVICE_NAME=postflight-device
KAOS_SYNC_TOKEN=inline-secret-value
`, "utf8");
	await chmod(weakEnvFile, 0o644);
	const weakEnvPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		weakEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		postflightSystemctl,
		"--service-file",
		postflightServiceFile,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_SYSTEMCTL_LOG: postflightSystemctlLog,
			KAOS_FAKE_NODE_LOG: postflightNodeLog,
		},
	});
	assert.notEqual(weakEnvPostflight.status, 0, "postflight should reject world-readable env files that contain tokens");
	const weakEnvPayload = JSON.parse(weakEnvPostflight.stderr);
	assert.equal(weakEnvPayload.failedStage, "preflight:env-file-permissions");
	assert.equal(weakEnvPayload.failure.detail.envFile.mode, "0644");
	assert.equal(weakEnvPayload.failure.detail.envFile.containsToken, true);
	assert.ok(weakEnvPayload.failure.detail.checks.some((check) => check.name === "env-file-token-not-world-accessible" && !check.ok));
	assert.equal(weakEnvPostflight.stderr.includes("inline-secret-value"), false, "weak env failure should not leak env token material");
	console.log("  PASS  postflight rejects env files that expose inline token values");

	console.log("\n--- headless host oracle deploy: postflight rejects service user secret access gaps ---");
	const fakeAccessRunuser = join(postflightRoot, "fake-runuser-deny-access.cjs");
	const fakeAccessRunuserLog = join(postflightRoot, "runuser-access.log");
	await writeFile(fakeAccessRunuser, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KAOS_FAKE_ACCESS_RUNUSER_LOG, JSON.stringify(args) + "\\n");
const sep = args.indexOf("--");
if (sep < 0) process.exit(2);
const command = args.slice(sep + 1);
const deniedFlag = process.env.KAOS_DENIED_SERVICE_ACCESS_FLAG;
if (command[0] === "test" && command[2] === process.env.KAOS_DENIED_SERVICE_ACCESS_PATH && (!deniedFlag || command[1] === deniedFlag)) {
  process.stderr.write("permission denied by fake runuser");
  process.exit(13);
}
process.exit(0);
`, "utf8");
	await chmod(fakeAccessRunuser, 0o755);
	const unreadableTokenPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: postflightTokenFile,
		},
	});
	assert.notEqual(unreadableTokenPostflight.status, 0, "postflight should reject token paths the service user cannot read");
	const unreadableTokenPayload = JSON.parse(unreadableTokenPostflight.stderr);
	assert.equal(unreadableTokenPayload.failedStage, "service-access");
	assert.equal(unreadableTokenPayload.failure.detail.ok, false);
	assert.equal(unreadableTokenPayload.failure.detail.serviceUser, "kaos-test-user");
	assert.ok(unreadableTokenPayload.failure.detail.checks.some((check) => check.name === "service-token-readable" && !check.ok));
	assert.equal(unreadableTokenPostflight.stderr.includes("postflight-token"), false, "service access failure should not leak token material");
	const fakeAccessArgs = (await readFile(fakeAccessRunuserLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(fakeAccessArgs.some((args) => args[0] === "-u" && args[1] === "kaos-test-user" && args.includes("test") && args.includes(postflightTokenFile)));
	console.log("  PASS  postflight catches service-user unreadable token files before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user data file access gaps ---");
	const existingDataFile = join(postflightDataDir, "existing-data.json");
	await writeFile(existingDataFile, "{}\n", "utf8");
	const inaccessibleDataFilePostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		existingDataFile,
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-identity-check",
		"--skip-service-file-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: existingDataFile,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-w",
		},
	});
	assert.notEqual(inaccessibleDataFilePostflight.status, 0, "postflight should reject existing data files the service user cannot write");
	const inaccessibleDataFilePayload = JSON.parse(inaccessibleDataFilePostflight.stderr);
	assert.equal(inaccessibleDataFilePayload.failedStage, "service-access");
	assert.ok(inaccessibleDataFilePayload.failure.detail.checks.some((check) => check.name === "service-data-file-writable" && !check.ok));
	console.log("  PASS  postflight catches service-user unwritable data files before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user lock file access gaps ---");
	const existingLockFile = join(postflightLockDir, "existing.lock");
	await writeFile(existingLockFile, "{}\n", "utf8");
	const inaccessibleLockFilePostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		existingLockFile,
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-identity-check",
		"--skip-service-file-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: existingLockFile,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-w",
		},
	});
	assert.notEqual(inaccessibleLockFilePostflight.status, 0, "postflight should reject existing lock files the service user cannot write");
	const inaccessibleLockFilePayload = JSON.parse(inaccessibleLockFilePostflight.stderr);
	assert.equal(inaccessibleLockFilePayload.failedStage, "service-access");
	assert.ok(inaccessibleLockFilePayload.failure.detail.checks.some((check) => check.name === "service-lock-file-writable" && !check.ok));
	console.log("  PASS  postflight catches service-user unwritable lock files before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user smoke helper access gaps ---");
	const unreadableSmokeScript = join(postflightRoot, "unreadable-smoke.cjs");
	await writeFile(unreadableSmokeScript, `#!/usr/bin/env node
console.log(JSON.stringify({ kind: "headless-host-sync-smoke", ok: true }));
`, "utf8");
	await chmod(unreadableSmokeScript, 0o755);
	const inaccessibleSmokeScriptPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--smoke-script",
		unreadableSmokeScript,
		"--skip-systemctl",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: unreadableSmokeScript,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-r",
		},
	});
	assert.notEqual(inaccessibleSmokeScriptPostflight.status, 0, "postflight should reject smoke helpers the service user cannot read");
	const inaccessibleSmokeScriptPayload = JSON.parse(inaccessibleSmokeScriptPostflight.stderr);
	assert.equal(inaccessibleSmokeScriptPayload.failedStage, "service-access");
	assert.ok(inaccessibleSmokeScriptPayload.failure.detail.checks.some((check) => check.name === "service-smoke-script-readable" && !check.ok));
	console.log("  PASS  postflight catches service-user unreadable smoke helper before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user smoke temp access gaps ---");
	const inaccessibleSmokeTempPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--smoke-script",
		unreadableSmokeScript,
		"--skip-systemctl",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: tmpdir(),
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-w",
		},
	});
	assert.notEqual(inaccessibleSmokeTempPostflight.status, 0, "postflight should reject smoke temp directories the service user cannot write");
	const inaccessibleSmokeTempPayload = JSON.parse(inaccessibleSmokeTempPostflight.stderr);
	assert.equal(inaccessibleSmokeTempPayload.failedStage, "service-access");
	assert.ok(inaccessibleSmokeTempPayload.failure.detail.checks.some((check) => check.name === "service-smoke-temp-dir-writable" && !check.ok));
	console.log("  PASS  postflight catches service-user unwritable smoke temp directory before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user smoke work dir access gaps ---");
	const smokeWorkParent = join(postflightRoot, "custom-smoke-work-parent");
	const customSmokeWorkDir = join(smokeWorkParent, "peer-work");
	await mkdir(smokeWorkParent, { recursive: true });
	const inaccessibleSmokeWorkDirPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--smoke-script",
		unreadableSmokeScript,
		"--smoke-work-dir",
		customSmokeWorkDir,
		"--skip-systemctl",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: smokeWorkParent,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-w",
		},
	});
	assert.notEqual(inaccessibleSmokeWorkDirPostflight.status, 0, "postflight should reject smoke work dirs the service user cannot create");
	const inaccessibleSmokeWorkDirPayload = JSON.parse(inaccessibleSmokeWorkDirPostflight.stderr);
	assert.equal(inaccessibleSmokeWorkDirPayload.failedStage, "service-access");
	assert.equal(inaccessibleSmokeWorkDirPayload.smokeWorkDir, customSmokeWorkDir);
	assert.ok(inaccessibleSmokeWorkDirPayload.failure.detail.checks.some((check) => check.name === "service-smoke-work-dir-writable" && !check.ok));
	console.log("  PASS  postflight catches service-user unwritable smoke work directory before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects smoke work dir inside primary vault ---");
	const nestedSmokeWorkDir = join(postflightVault, "nested-smoke-work");
	const nestedSmokeWorkDirPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--smoke-script",
		unreadableSmokeScript,
		"--smoke-work-dir",
		nestedSmokeWorkDir,
		"--skip-systemctl",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
		},
	});
	assert.notEqual(nestedSmokeWorkDirPostflight.status, 0, "postflight should reject smoke work dirs inside the primary vault");
	const nestedSmokeWorkDirPayload = JSON.parse(nestedSmokeWorkDirPostflight.stderr);
	assert.equal(nestedSmokeWorkDirPayload.failedStage, "service-access");
	assert.ok(nestedSmokeWorkDirPayload.failure.detail.checks.some((check) => check.name === "service-smoke-work-dir-outside-vault" && !check.ok));
	console.log("  PASS  postflight catches smoke work directory overlap before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user working directory access gaps ---");
	const inaccessibleWorkingDirPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: postflightWorkingDirectory,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-x",
		},
	});
	assert.notEqual(inaccessibleWorkingDirPostflight.status, 0, "postflight should reject working directories the service user cannot enter");
	const inaccessibleWorkingDirPayload = JSON.parse(inaccessibleWorkingDirPostflight.stderr);
	assert.equal(inaccessibleWorkingDirPayload.failedStage, "service-access");
	assert.ok(inaccessibleWorkingDirPayload.failure.detail.checks.some((check) => check.name === "service-working-dir-searchable" && !check.ok));
	console.log("  PASS  postflight catches service-user inaccessible working directory before restart");

	console.log("\n--- headless host oracle deploy: postflight rejects service user Node access gaps ---");
	const inaccessibleNodePostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--service-file",
		postflightServiceFile,
		"--check-only",
		"--skip-service-identity-check",
		"--require-service-access-check",
		"--runuser",
		fakeAccessRunuser,
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_FAKE_ACCESS_RUNUSER_LOG: fakeAccessRunuserLog,
			KAOS_DENIED_SERVICE_ACCESS_PATH: postflightNode,
			KAOS_DENIED_SERVICE_ACCESS_FLAG: "-x",
		},
	});
	assert.notEqual(inaccessibleNodePostflight.status, 0, "postflight should reject Node paths the service user cannot execute");
	const inaccessibleNodePayload = JSON.parse(inaccessibleNodePostflight.stderr);
	assert.equal(inaccessibleNodePayload.failedStage, "service-access");
	assert.ok(inaccessibleNodePayload.failure.detail.checks.some((check) => check.name === "service-node-executable" && !check.ok));
	console.log("  PASS  postflight catches service-user non-executable Node before restart");

	console.log("\n--- headless host oracle deploy: postflight failure reports completed stages ---");
	const failingSystemctl = join(postflightRoot, "fake-systemctl-fail.cjs");
	await writeFile(failingSystemctl, `#!/usr/bin/env node
if (process.argv[2] === "restart") {
	process.stderr.write("restart failed for test postflight-token");
	process.exit(7);
}
process.exit(0);
`, "utf8");
	await chmod(failingSystemctl, 0o755);
	const failedPostflight = spawnSync(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--systemctl",
		failingSystemctl,
		"--service",
		"kaos-test",
		"--skip-smoke",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.notEqual(failedPostflight.status, 0, "postflight should fail when restart fails");
	const failedPostflightPayload = JSON.parse(failedPostflight.stderr);
	assert.equal(failedPostflightPayload.kind, "headless-host-postflight");
	assert.equal(failedPostflightPayload.ok, false);
	assert.equal(failedPostflightPayload.failedStage, "systemctl restart kaos-test");
	assert.equal(failedPostflightPayload.doctor.ok, true);
	assert.equal(failedPostflightPayload.systemctl.length, 1);
	assert.equal(failedPostflightPayload.failure.detail.status, 7);
	assert.equal(failedPostflightPayload.failure.detail.stderr, "restart failed for test [redacted]");
	assert.equal(failedPostflight.stderr.includes("postflight-token"), false, "failure output should not leak token material");
	console.log("  PASS  failed postflight keeps structured stage diagnostics");

	console.log("\n--- headless host oracle deploy: release update rolls back when postflight fails ---");
	const guardedInstallDir = join(root, "guarded-update-opt", "kaos");
	const guardedServicePath = join(root, "guarded-update-etc", "systemd", "system", "kaos-headless-host.service");
	const guardedMetadataPath = join(root, "guarded-update-metadata.json");
	const guardedVault = join(root, "guarded-update-srv", "kaos", "vault");
	const guardedDataDir = join(root, "guarded-update-var", "lib", "kaos-headless");
	const guardedLockDir = join(root, "guarded-update-run", "kaos-headless");
	const guardedEtc = join(root, "guarded-update-etc", "kaos");
	const guardedEnvFile = join(guardedEtc, "headless.env");
	const guardedTokenFile = join(guardedEtc, "sync-token");
	const guardedSystemctl = join(root, "guarded-update-systemctl.cjs");
	const guardedSystemctlState = join(root, "guarded-update-systemctl-state.json");
	const guardedSystemctlLog = join(root, "guarded-update-systemctl.log");
	await mkdir(guardedInstallDir, { recursive: true });
	await mkdir(join(root, "guarded-update-etc", "systemd", "system"), { recursive: true });
	await mkdir(guardedVault, { recursive: true });
	await installVaultPlugin(guardedVault);
	await mkdir(guardedDataDir, { recursive: true });
	await mkdir(guardedLockDir, { recursive: true });
	await mkdir(guardedEtc, { recursive: true });
	const guardedOldBinary = `#!/usr/bin/env node
if (process.argv.includes("--doctor")) {
	console.log(JSON.stringify({
		kind: "doctor",
		ok: true,
		checks: [{ name: "old-guarded-doctor", ok: true }]
	}));
} else {
	console.log("old guarded binary");
}
`;
	const guardedOldService = "old guarded service\n";
	const guardedOldMetadata = "{\"release\":\"old guarded\"}\n";
	await writeFile(join(guardedInstallDir, "kaos-headless-host.mjs"), guardedOldBinary, "utf8");
	await chmod(join(guardedInstallDir, "kaos-headless-host.mjs"), 0o755);
	await writeFile(guardedServicePath, guardedOldService, "utf8");
	await chmod(guardedServicePath, 0o644);
	await writeFile(guardedMetadataPath, guardedOldMetadata, "utf8");
	const guardedOldHelpers = new Map();
	for (const helper of helperNames) {
		const oldHelper = await readFile(join("scripts", helper), "utf8");
		guardedOldHelpers.set(helper, oldHelper);
		await writeFile(join(guardedInstallDir, helper), oldHelper, "utf8");
		await chmod(join(guardedInstallDir, helper), 0o755);
	}
await writeFile(guardedEnvFile, `KAOS_HOST=https://guarded-update.example.invalid
KAOS_VAULT_ID=guarded-update-vault
KAOS_DEVICE_NAME=guarded-update-device
`, "utf8");
	await chmod(guardedEnvFile, 0o640);
	await writeFile(guardedTokenFile, "guarded-postflight-token", "utf8");
	await chmod(guardedTokenFile, 0o640);
	await writeFile(guardedSystemctl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KAOS_GUARDED_SYSTEMCTL_LOG, JSON.stringify(args) + "\\n");
let state = { restarts: 0 };
try {
	state = JSON.parse(fs.readFileSync(process.env.KAOS_GUARDED_SYSTEMCTL_STATE, "utf8"));
} catch {}
if (args[0] === "restart") {
	state.restarts += 1;
	fs.writeFileSync(process.env.KAOS_GUARDED_SYSTEMCTL_STATE, JSON.stringify(state));
}
if (args[0] === "restart" && state.restarts === 1) {
	process.stderr.write("guarded restart failed guarded-postflight-token");
	process.exit(8);
}
process.exit(0);
`, "utf8");
	await chmod(guardedSystemctl, 0o755);
	const guardedUpdate = spawnSync(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		join(root, "guarded-update-work"),
		"--install-dir",
		guardedInstallDir,
		"--service-path",
		guardedServicePath,
		"--metadata-path",
		guardedMetadataPath,
		"--postflight",
		"--rollback-on-postflight-failure",
		"--postflight-vault",
		guardedVault,
		"--postflight-data-file",
		join(guardedDataDir, "data.json"),
		"--postflight-lock-file",
		join(guardedLockDir, "kaos.lock"),
		"--postflight-env-file",
		guardedEnvFile,
		"--postflight-token-file",
		guardedTokenFile,
		"--postflight-systemctl",
		guardedSystemctl,
		"--postflight-node",
		process.execPath,
		"--postflight-service",
		"kaos-guarded",
		"--postflight-skip-smoke",
		"--postflight-skip-service-file-check",
		"--rollback-stamp",
		"postflight-test",
	], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			KAOS_GUARDED_SYSTEMCTL_STATE: guardedSystemctlState,
			KAOS_GUARDED_SYSTEMCTL_LOG: guardedSystemctlLog,
		},
	});
	assert.notEqual(guardedUpdate.status, 0, "postflight failure should fail the guarded update");
	const guardedUpdatePayload = JSON.parse(guardedUpdate.stderr);
	assert.equal(guardedUpdatePayload.kind, "headless-host-release-update");
	assert.equal(guardedUpdatePayload.ok, false);
	assert.equal(guardedUpdatePayload.rolledBack, true);
	assert.equal(guardedUpdatePayload.recoveryVerified, true);
	assert.equal(guardedUpdatePayload.rollback.ok, true);
	assert.equal(guardedUpdatePayload.rollbackSummary.restoredCount, rollbackWithServiceArtifactCount);
	assert.equal(guardedUpdatePayload.rollbackSummary.failedCount, 0);
	assert.ok(guardedUpdatePayload.rollbackSummary.failedArtifacts.some((entry) => entry.kind === "binary" && entry.failedPath.endsWith(".failed-postflight-test")));
	assert.ok(guardedUpdatePayload.rollbackSummary.failedArtifacts.some((entry) => entry.kind === "service" && entry.failedPath.endsWith(".failed-postflight-test")));
	assert.ok(guardedUpdatePayload.rollbackSummary.failedArtifacts.some((entry) => entry.kind === "metadata" && entry.failedPath.endsWith(".failed-postflight-test")));
	assert.equal(guardedUpdatePayload.rollbackPostflight.ok, true);
	assert.equal(guardedUpdatePayload.rollbackPostflight.doctor.checks[0]?.name, "old-guarded-doctor");
	assert.equal(guardedUpdatePayload.postflight.failedStage, "systemctl restart kaos-guarded");
	assert.equal(guardedUpdatePayload.postflight.failure.detail.stderr, "guarded restart failed [redacted]");
	assert.equal(guardedUpdate.stderr.includes("guarded-postflight-token"), false, "guarded update failure should not leak token material");
	assert.deepEqual((await readFile(guardedSystemctlLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [
		["daemon-reload"],
		["restart", "kaos-guarded"],
		["daemon-reload"],
		["restart", "kaos-guarded"],
		["is-active", "--quiet", "kaos-guarded"],
	]);
	assert.equal(await readFile(join(guardedInstallDir, "kaos-headless-host.mjs"), "utf8"), guardedOldBinary);
	assert.equal(await readFile(guardedServicePath, "utf8"), guardedOldService);
	assert.equal(await readFile(guardedMetadataPath, "utf8"), guardedOldMetadata);
	for (const helper of helperNames) {
		assert.equal(await readFile(join(guardedInstallDir, helper), "utf8"), guardedOldHelpers.get(helper));
	}
	assert.equal(existsSync(`${join(guardedInstallDir, "kaos-headless-host.mjs")}.failed-postflight-test`), true);
	console.log("  PASS  guarded update restores previous artifacts and verifies recovery after postflight failure");

	console.log("\n--- headless host oracle deploy: postflight can run smoke as service user ---");
	const fakeRunuser = join(postflightRoot, "fake-runuser.cjs");
	const fakeRunuserLog = join(postflightRoot, "runuser.log");
	const fakeSmoke = join(postflightRoot, "fake-smoke.cjs");
	const serviceUserSmokeFile = join(postflightRoot, "kaos-headless-host-service-user.service");
	await writeFile(fakeRunuser, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(process.env.KAOS_FAKE_RUNUSER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const sep = process.argv.indexOf("--");
if (sep < 0) process.exit(2);
const result = spawnSync(process.argv[sep + 1], process.argv.slice(sep + 2), {
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`, "utf8");
	await writeFile(fakeSmoke, `#!/usr/bin/env node
if (!process.argv.includes("--require-lock")) process.exit(3);
console.log(JSON.stringify({
  kind: "headless-host-sync-smoke",
  ok: true,
  tokenConfigured: true,
  via: "fake-smoke"
}));
`, "utf8");
	await chmod(fakeRunuser, 0o755);
	await chmod(fakeSmoke, 0o755);
	await writeFile(serviceUserSmokeFile, `[Service]
User=kaos-service-user
Group=kaos-service-group
`, "utf8");
	const postflightSmokeUser = run(process.execPath, [
		"scripts/postflight-headless-host.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		postflightVault,
		"--data-file",
		join(postflightDataDir, "data.json"),
		"--lock-file",
		join(postflightLockDir, "kaos.lock"),
		"--env-file",
		postflightEnvFile,
		"--token-file",
		postflightTokenFile,
		"--skip-systemctl",
		"--skip-service-file-check",
		"--service-file",
		serviceUserSmokeFile,
		"--smoke-script",
		fakeSmoke,
		"--runuser",
		fakeRunuser,
	], {
		env: {
			...process.env,
			KAOS_FAKE_RUNUSER_LOG: fakeRunuserLog,
		},
	});
	const postflightSmokeUserPayload = JSON.parse(postflightSmokeUser.stdout);
	assert.equal(postflightSmokeUserPayload.kind, "headless-host-postflight");
	assert.equal(postflightSmokeUserPayload.ok, true);
	assert.equal(postflightSmokeUserPayload.serviceUser, "kaos-service-user");
	assert.equal(postflightSmokeUserPayload.serviceGroup, "kaos-service-group");
	assert.equal(postflightSmokeUserPayload.smokeUser, "kaos-service-user");
	assert.equal(postflightSmokeUserPayload.smokeGroup, "kaos-service-group");
	assert.equal(postflightSmokeUserPayload.smoke.via, "fake-smoke");
	const runuserArgs = JSON.parse((await readFile(fakeRunuserLog, "utf8")).trim());
	assert.equal(runuserArgs[0], "-u");
	assert.equal(runuserArgs[1], "kaos-service-user");
	assert.equal(runuserArgs[2], "-g");
	assert.equal(runuserArgs[3], "kaos-service-group");
	assert.equal(runuserArgs[4], "--");
	assert.equal(runuserArgs[6], "--");
	assert.equal(runuserArgs.includes(fakeSmoke), true);
	assert.equal(runuserArgs.includes("--require-lock"), true);
	console.log("  PASS  postflight delegates smoke to the configured service user");

	console.log("\n--- headless host oracle deploy: smoke script rejects vault path traversal ---");
	const smokeTraversal = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-data.json"),
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--prefix",
		"../outside",
	], {
		encoding: "utf8",
	});
	assert.notEqual(smokeTraversal.status, 0, "path traversal prefix should fail");
	assert.match(smokeTraversal.stderr, /smoke path must stay inside the vault/);
	const smokeTraversalPayload = JSON.parse(smokeTraversal.stderr);
	assert.equal(smokeTraversalPayload.failedStage, "preflight:path");
	console.log("  PASS  smoke paths are constrained to the primary vault");

	console.log("\n--- headless host oracle deploy: smoke script rejects peer work dir inside primary vault ---");
	const smokeWorkDirOverlap = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-data.json"),
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--work-dir",
		join(vaultRoot, "nested-smoke-work"),
	], {
		encoding: "utf8",
	});
	assert.notEqual(smokeWorkDirOverlap.status, 0, "smoke work dir inside the primary vault should fail");
	const smokeWorkDirOverlapPayload = JSON.parse(smokeWorkDirOverlap.stderr);
	assert.equal(smokeWorkDirOverlapPayload.failedStage, "preflight:path");
	assert.match(smokeWorkDirOverlapPayload.error, /must not overlap the primary vault/);
	console.log("  PASS  smoke peer workspace is constrained outside the primary vault");

	console.log("\n--- headless host oracle deploy: smoke script reads env-file token fallback ---");
	const smokeEnvTokenFile = join(root, "smoke-env-token.env");
	await writeFile(smokeEnvTokenFile, `KAOS_HOST=http://127.0.0.1:9
KAOS_VAULT_ID=smoke-env-token-vault
SYNC_TOKEN=smoke-env-token-secret
`, "utf8");
	await chmod(smokeEnvTokenFile, 0o640);
	const smokeEnvToken = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-env-token-data.json"),
		"--env-file",
		smokeEnvTokenFile,
		"--prefix",
		"../outside",
	], {
		encoding: "utf8",
	});
	assert.notEqual(smokeEnvToken.status, 0, "env-file token fallback run should reach path validation");
	const smokeEnvTokenPayload = JSON.parse(smokeEnvToken.stderr);
	assert.equal(smokeEnvTokenPayload.kind, "headless-host-sync-smoke");
	assert.equal(smokeEnvTokenPayload.failedStage, "preflight:path");
	assert.equal(smokeEnvToken.stderr.includes("smoke-env-token-secret"), false, "env-file token fallback failure should not leak token material");
	console.log("  PASS  smoke script can use env-file sync token without leaking it");

	console.log("\n--- headless host oracle deploy: smoke preflight reports missing primary lock ---");
	const smokeMissingLock = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-missing-lock-data.json"),
		"--lock-file",
		join(lockDir, "missing-smoke.lock"),
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--require-lock",
	], {
		encoding: "utf8",
	});
	assert.notEqual(smokeMissingLock.status, 0, "missing primary lock should fail preflight");
	const smokeMissingLockPayload = JSON.parse(smokeMissingLock.stderr);
	assert.equal(smokeMissingLockPayload.kind, "headless-host-sync-smoke");
	assert.equal(smokeMissingLockPayload.ok, false);
	assert.equal(smokeMissingLockPayload.failedStage, "preflight:lock");
	assert.match(smokeMissingLockPayload.failure.detail.path, /missing-smoke\.lock$/);
	assert.equal(smokeMissingLock.stderr.includes("smoke-token"), false, "smoke preflight failure should not leak token material");
	console.log("  PASS  smoke preflight reports lock readiness as structured JSON");

	console.log("\n--- headless host oracle deploy: smoke preflight rejects stale or mismatched primary locks ---");
	const staleSmokeLock = join(lockDir, "stale-smoke.lock");
	await writeFile(staleSmokeLock, JSON.stringify({
		runtime: "kaos-headless-host",
		pid: 999999,
		hostname: "stale-smoke-host",
		startedAt: "2026-07-08T00:00:00.000Z",
		vaultRoot,
		dataFile: join(dataDir, "smoke-stale-lock-data.json"),
	}, null, 2), "utf8");
	const staleSmokeLockResult = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-stale-lock-data.json"),
		"--lock-file",
		staleSmokeLock,
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--require-lock",
	], {
		encoding: "utf8",
	});
	assert.notEqual(staleSmokeLockResult.status, 0, "stale primary lock should fail preflight");
	const staleSmokeLockPayload = JSON.parse(staleSmokeLockResult.stderr);
	assert.equal(staleSmokeLockPayload.failedStage, "preflight:lock");
	assert.equal(staleSmokeLockPayload.failure.detail.lock.processAlive, false);
	assert.ok(staleSmokeLockPayload.failure.detail.mismatches.some((entry) => entry.field === "processAlive"));

	const mismatchedSmokeLock = join(lockDir, "mismatched-smoke.lock");
	await writeFile(mismatchedSmokeLock, JSON.stringify({
		runtime: "kaos-headless-host",
		pid: process.pid,
		hostname: "mismatched-smoke-host",
		startedAt: "2026-07-08T00:00:00.000Z",
		vaultRoot: join(root, "wrong-smoke-vault"),
		dataFile: join(dataDir, "smoke-mismatched-lock-data.json"),
	}, null, 2), "utf8");
	const mismatchedSmokeLockResult = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		"dist/kaos-headless-host.mjs",
		"--vault",
		vaultRoot,
		"--data-file",
		join(dataDir, "smoke-mismatched-lock-data.json"),
		"--lock-file",
		mismatchedSmokeLock,
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--require-lock",
	], {
		encoding: "utf8",
	});
	assert.notEqual(mismatchedSmokeLockResult.status, 0, "mismatched primary lock should fail preflight");
	const mismatchedSmokeLockPayload = JSON.parse(mismatchedSmokeLockResult.stderr);
	assert.equal(mismatchedSmokeLockPayload.failedStage, "preflight:lock");
	assert.ok(mismatchedSmokeLockPayload.failure.detail.mismatches.some((entry) => entry.field === "vaultRoot"));
	assert.equal(mismatchedSmokeLockResult.stderr.includes("smoke-token"), false, "lock mismatch failure should not leak token material");
	console.log("  PASS  smoke preflight validates primary lock ownership");

	console.log("\n--- headless host oracle deploy: smoke failure reports failed stage and peer output ---");
	const failingSmokePeer = join(root, "failing-smoke-peer.cjs");
	const smokeFailureVault = join(root, "smoke-failure-vault");
	await mkdir(smokeFailureVault, { recursive: true });
	await installVaultPlugin(smokeFailureVault);
	await writeFile(failingSmokePeer, `#!/usr/bin/env node
process.stderr.write("peer boot failed for smoke test smoke-token\\n");
process.exit(11);
`, "utf8");
	await chmod(failingSmokePeer, 0o755);
	const smokeFailure = spawnSync(process.execPath, [
		"scripts/smoke-headless-host-sync.mjs",
		"--binary",
		failingSmokePeer,
		"--vault",
		smokeFailureVault,
		"--data-file",
		join(dataDir, "smoke-failure-data.json"),
		"--host",
		"http://127.0.0.1:9",
		"--vault-id",
		"smoke-vault",
		"--token",
		"smoke-token",
		"--prefix",
		"KAOS smoke failure",
		"--timeout-ms",
		"1000",
	], {
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.notEqual(smokeFailure.status, 0, "smoke should fail when the peer exits before boot");
	const smokeFailurePayload = JSON.parse(smokeFailure.stderr);
	assert.equal(smokeFailurePayload.kind, "headless-host-sync-smoke");
	assert.equal(smokeFailurePayload.ok, false);
	assert.equal(smokeFailurePayload.failedStage, "peer-ready");
	assert.deepEqual(smokeFailurePayload.completedStages, ["peer-start"]);
	assert.equal(smokeFailurePayload.failure.peer.exitCode, 11);
	assert.match(smokeFailurePayload.failure.peer.stderr, /peer boot failed.*\[redacted\]/);
	assert.equal(smokeFailure.stderr.includes("smoke-token"), false, "smoke failure should not leak token material");
	console.log("  PASS  failed smoke keeps structured stage diagnostics");

	console.log("\n--- headless host oracle deploy: running daemon survives staged update and restarts ---");
	const liveInstallDir = join(root, "live-opt", "kaos");
	const liveServicePath = join(root, "live-etc", "systemd", "system", "kaos-headless-host.service");
	const liveVaultRoot = join(root, "live-srv", "kaos", "vault");
	const liveDataDir = join(root, "live-var", "lib", "kaos-headless");
	const liveLockDir = join(root, "live-run", "kaos-headless");
	const liveTokenPath = join(root, "live-etc", "kaos", "sync-token");
	await mkdir(liveVaultRoot, { recursive: true });
	await installVaultPlugin(liveVaultRoot);
	await mkdir(liveDataDir, { recursive: true });
	await mkdir(liveLockDir, { recursive: true });
	await mkdir(join(root, "live-etc", "kaos"), { recursive: true });
	await writeFile(liveTokenPath, "live-update-token", "utf8");
	run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		join(root, "live-release-work-initial"),
		"--install-dir",
		liveInstallDir,
		"--service-path",
		liveServicePath,
	]);
	const liveBinary = join(liveInstallDir, "kaos-headless-host.mjs");
	const liveDataFile = join(liveDataDir, "data.json");
	const liveLockFile = join(liveLockDir, "kaos.lock");
	const firstDaemon = startDaemon(liveBinary, liveVaultRoot, liveDataFile, liveLockFile, liveTokenPath);
	await waitFor(() => firstDaemon.output.stdout.includes('"kind":"poller-started"'), 15_000);
	assert.equal(existsSync(liveLockFile), true, "running daemon should hold the lock");
	run(process.execPath, [
		"scripts/update-headless-host-from-release.mjs",
		"--base-url",
		pathToFileURL(`${releaseDir}/`).href,
		"--work-dir",
		join(root, "live-release-work-update"),
		"--install-dir",
		liveInstallDir,
		"--service-path",
		liveServicePath,
	]);
	assert.equal(firstDaemon.child.exitCode, null, "staged install should not terminate the running daemon");
	firstDaemon.child.kill("SIGTERM");
	const firstClose = await waitForClose(firstDaemon.child, 15_000);
	assert.equal(firstClose.code, 0, firstDaemon.output.stderr || firstDaemon.output.stdout);
	assert.equal(existsSync(liveLockFile), false, "daemon should release lock before restart");
	const restartedDaemon = startDaemon(liveBinary, liveVaultRoot, liveDataFile, liveLockFile, liveTokenPath);
	await waitFor(() => restartedDaemon.output.stdout.includes('"kind":"poller-started"'), 15_000);
	restartedDaemon.child.kill("SIGTERM");
	const restartedClose = await waitForClose(restartedDaemon.child, 15_000);
	assert.equal(restartedClose.code, 0, restartedDaemon.output.stderr || restartedDaemon.output.stdout);
	console.log("  PASS  staged update keeps running daemon alive and restart boots the installed binary");
} finally {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	await rm(root, { recursive: true, force: true });
	for (const dir of workspaceTempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
}

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: 30_000,
		...options,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}

async function readChecksum(path) {
	const text = await readFile(path, "utf8");
	const match = text.match(/[a-fA-F0-9]{64}/);
	assert.ok(match, `missing checksum in ${path}`);
	return match[0].toLowerCase();
}

async function sha256File(path) {
	const bytes = await readFile(path);
	return sha256Bytes(bytes);
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fakeCommandScript(logPath, mode) {
	return `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  name: require("node:path").basename(process.argv[1]),
  args: process.argv.slice(2)
}) + "\\n");
process.exit(${mode === "missing" ? 1 : 0});
`;
}

async function writeHeadlessManifest(dir) {
	const assets = {};
	for (const asset of [
		"kaos-headless-host.mjs",
		"kaos-headless-host.mjs.sha256",
		"kaos-headless-host.service",
		...helperNames,
	]) {
		const bytes = await readFile(join(dir, asset));
		assets[asset] = {
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
		};
	}
	await writeFile(join(dir, "kaos-headless-host-manifest.json"), `${JSON.stringify({
		kind: "kaos-headless-host-release-manifest",
		schemaVersion: 1,
		runtime: "kaos-headless-host",
		assets,
	}, null, 2)}\n`, "utf8");
}

function startDaemon(binary, vaultRoot, dataFile, lockFile, tokenPath) {
	const child = spawn(process.execPath, [
		binary,
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
		"--lock-file",
		lockFile,
		"--token-file",
		tokenPath,
		"--poll-interval-ms",
		"500",
		"--poll-quiet-ms",
		"50",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	const output = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output.stdout += chunk; });
	child.stderr.on("data", (chunk) => { output.stderr += chunk; });
	return { child, output };
}

async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
