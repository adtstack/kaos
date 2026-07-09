#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

const HEADLESS_RELEASE_ASSETS = [
	"dist/kaos-headless-host.mjs",
	"dist/kaos-headless-host.mjs.sha256",
	"dist/kaos-headless-host-manifest.json",
	"dist/kaosctl.mjs",
	"dist/kaosctl.mjs.sha256",
	"dist/kaos-headless-user-manifest.json",
	"dist/kaos-headless-user.zip",
	"dist/kaos-headless-user.zip.sha256",
	"dist/kaos-plugin.zip",
	"dist/kaos-plugin.zip.sha256",
	"dist/kaos-headless-host-oracle.zip",
	"dist/kaos-headless-host-oracle.zip.sha256",
	"deploy/kaos-headless-host.service",
	"deploy/kaos-headless-host.user.service",
	"deploy/oracle-acceptance-config.example.json",
	"scripts/install.sh",
	"scripts/bootstrap-headless-host-oracle.mjs",
	"scripts/install-headless-host.mjs",
	"scripts/update-headless-host-from-release.mjs",
	"scripts/verify-headless-host-bundle.mjs",
	"scripts/validate-headless-host-release-assets.mjs",
	"scripts/run-headless-host-oracle-rehearsal.mjs",
	"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
	"scripts/run-headless-host-oracle-acceptance.mjs",
	"scripts/verify-headless-host-oracle-acceptance.mjs",
	"scripts/verify-headless-host-oracle-rehearsal.mjs",
	"scripts/smoke-headless-host-sync.mjs",
	"scripts/postflight-headless-host.mjs",
	"scripts/rollback-headless-host.mjs",
];

const REQUIRED_RELEASE_RUNS = [
	"npm run build:headless:host",
	"npm run prepare:headless-host-oracle-upload",
	"npm run test:ci:release",
	"npm run test:integration:headless-host",
];

const REQUIRED_CI_RUNS = [
	"npm run build:headless:host",
	"npm run prepare:headless-host-oracle-upload",
	"npm run test:ci:release",
	"npm run test:integration:headless-host",
];

console.log("\n--- headless host release workflow: assets and gates stay wired ---");
const releaseWorkflow = await loadWorkflow(".github/workflows/release.yml");
const releaseRunSteps = runSteps(releaseWorkflow, "release");
for (const command of REQUIRED_RELEASE_RUNS) {
	assert(releaseRunSteps.includes(command), `release workflow must run: ${command}`);
}
const releaseScript = releaseRunSteps.join("\n");
const uploadArgs = extractGhReleaseArgs(releaseScript, "gh release upload");
const createArgs = extractGhReleaseArgs(releaseScript, "gh release create");
for (const asset of HEADLESS_RELEASE_ASSETS) {
	assert(uploadArgs.includes(asset), `gh release upload must include ${asset}`);
	assert(createArgs.includes(asset), `gh release create must include ${asset}`);
}
console.log("  PASS  release workflow uploads every headless host asset");

console.log("\n--- headless host CI workflow: headless gates stay wired ---");
const ciWorkflow = await loadWorkflow(".github/workflows/ci.yml");
const ciRunSteps = runSteps(ciWorkflow, "build");
for (const command of REQUIRED_CI_RUNS) {
	assert(ciRunSteps.includes(command), `CI workflow must run: ${command}`);
}
console.log("  PASS  CI workflow runs headless build and integration gates");

console.log("\n--- headless host package scripts: release regression includes oracle deploy ---");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageJson.scripts["test:headless-host:oracle-deploy"], "node tests/headless-host-oracle-deploy.mjs");
assert.equal(packageJson.scripts["prepare:headless-host-oracle-upload"], "node scripts/prepare-headless-host-oracle-upload.mjs");
assert.equal(packageJson.scripts["verify:headless-host-bundle"], "node scripts/prepare-headless-host-oracle-upload.mjs");
assert.equal(packageJson.scripts["run:headless-host-oracle-rehearsal"], "node scripts/run-headless-host-oracle-rehearsal.mjs");
assert.equal(packageJson.scripts["run:headless-host-oracle-remote-rehearsal"], "node scripts/run-headless-host-oracle-remote-rehearsal.mjs");
assert.equal(packageJson.scripts["run:headless-host-oracle-acceptance"], "node scripts/run-headless-host-oracle-acceptance.mjs");
assert.equal(packageJson.scripts["verify:headless-host-oracle-acceptance"], "node scripts/verify-headless-host-oracle-acceptance.mjs");
assert.equal(packageJson.scripts["verify:headless-host-oracle-rehearsal"], "node scripts/verify-headless-host-oracle-rehearsal.mjs");
const runner = await readFile("tests/run-regressions.mjs", "utf8");
assert(runner.includes("tests/headless-host-oracle-deploy.mjs"), "release regressions must include oracle deploy simulation");
assert(runner.includes("tests/headless-host-oracle-upload-prepare.mjs"), "release regressions must include Oracle upload prepare coverage");
assert(runner.includes("tests/headless-host-oracle-rehearsal-runner.mjs"), "release regressions must include Oracle rehearsal runner coverage");
assert(runner.includes("tests/headless-host-oracle-remote-rehearsal.mjs"), "release regressions must include Oracle remote rehearsal coverage");
assert(runner.includes("tests/headless-host-oracle-acceptance.mjs"), "release regressions must include Oracle acceptance coverage");
assert(runner.includes("tests/headless-host-oracle-rehearsal-verifier.mjs"), "release regressions must include Oracle rehearsal verifier coverage");
assert(runner.includes("tests/headless-host-release-workflow.mjs"), "release regressions must include workflow asset guard");
assert(runner.includes("tests/headless-host-user-install.mjs"), "release regressions must include user install/update coverage");
console.log("  PASS  package and regression runner keep Oracle deploy gates reachable");

console.log("\n--- headless host Oracle rehearsal docs: real VM gate stays explicit ---");
const operationsDoc = await readFile("engineering/headless-host-operations.md", "utf8");
const rehearsalDoc = await readFile("engineering/headless-host-oracle-rehearsal.md", "utf8");
assert(operationsDoc.includes("engineering/headless-host-oracle-rehearsal.md"), "operations doc must point to the Oracle rehearsal checklist");
for (const required of [
	"sha256sum -c kaos-headless-host-oracle.zip.sha256",
	"npm run prepare:headless-host-oracle-upload",
	"node verify-headless-host-bundle.mjs --bundle-dir .",
	"validate-headless-host-release-assets.mjs",
	"--token-stdin",
	"bundleVerification.ok: true",
	"--postflight-verify-running",
	"--require-lock",
	"08-operational-smoke.json",
	"09-systemctl-status.txt",
	"10-journalctl.txt",
	"node \"$KAOS_REHEARSAL_LOG_DIR/bundle/kaos-headless-host-oracle/run-headless-host-oracle-rehearsal.mjs\"",
	"npm run run:headless-host-oracle-remote-rehearsal",
	"run-headless-host-oracle-acceptance.mjs",
	"verify-headless-host-oracle-acceptance.mjs",
	"oracle-acceptance-config.example.json",
	"oracle-acceptance.json",
	"--config ./oracle-acceptance.json",
	"--validate-local",
	"--resume-from-summary",
	"--release-dir .",
	"--confirm-reboot",
	"--dry-run",
	"--evidence-root",
	"--summary-file",
	"--skip-local-prepare",
	"--zip ./kaos-headless-host-oracle.zip",
	"--checksum ./kaos-headless-host-oracle.zip.sha256",
	"acceptance-summary.json",
	"--require-full",
	"--start-at",
	"--phase preflight",
	"00-remote-preflight.json",
	"sudo -n",
	"--identity-file",
	"--ssh-port",
	"--ssh-option",
	"--skip-remote-preflight",
	"--skip-local-prepare",
	"--installed-runner",
	"--wait-for-ssh",
	"--wait-ssh-timeout-ms",
	"--require-reboot-request",
	"--phase reboot",
	"11-reboot-request.json",
	"verifiedAt",
	"post-reboot verification happened after the recorded reboot request",
	"--evidence-dir",
	"--service-path",
	"--journal-since",
	"sudo node /opt/kaos/run-headless-host-oracle-rehearsal.mjs",
	"--phase update",
	"--mode install",
	"--mode update",
	"--verify-fetched-logs",
	"[remote-script:<step>]",
	"failureEvidenceFetch",
	"failedStep",
	"[redacted]",
	"npm run verify:headless-host-oracle-rehearsal",
	"failedChecks",
]) {
	assert(rehearsalDoc.includes(required), `Oracle rehearsal checklist must include: ${required}`);
}
console.log("  PASS  Oracle rehearsal checklist preserves post-reboot and sync evidence gates");

async function loadWorkflow(path) {
	const parsed = yaml.load(await readFile(path, "utf8"));
	assert(parsed && typeof parsed === "object", `${path} must parse as a YAML object`);
	return parsed;
}

function runSteps(workflow, jobName) {
	const steps = workflow.jobs?.[jobName]?.steps;
	assert(Array.isArray(steps), `workflow job ${jobName} must have steps`);
	return steps
		.map((step) => typeof step?.run === "string" ? step.run.trim() : null)
		.filter(Boolean);
}

function extractGhReleaseArgs(script, commandPrefix) {
	const lines = script.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim().startsWith(commandPrefix));
	assert(start >= 0, `release script must contain ${commandPrefix}`);
	const args = [];
	for (let i = start + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed) continue;
		args.push(trimmed.replace(/\\$/, "").trim());
		if (!trimmed.endsWith("\\")) break;
	}
	return args;
}
