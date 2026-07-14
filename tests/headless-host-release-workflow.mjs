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
	"scripts/uninstall-headless-host.mjs",
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
for (const asset of HEADLESS_RELEASE_ASSETS) {
	assert(releaseScript.includes(asset), `release staging must include ${asset}`);
}
const publishScript = runSteps(releaseWorkflow, "publish").join("\n");
assert(publishScript.includes("gh release create"), "publish job must create a new release");
assert(publishScript.includes("--verify-tag"), "release creation must reject a missing tag");
assert(publishScript.includes(".assets[] | [.name, .digest]"), "reruns must verify existing assets");
assert(publishScript.includes("published assets are immutable"), "existing assets must not be overwritten");
assert(!publishScript.includes("--clobber"), "release assets must never be clobbered");
assert.equal(releaseWorkflow.permissions?.contents, "read", "workflow default token must be read-only");
assert.equal(releaseWorkflow.jobs.release.permissions?.contents, "read", "build job token must be read-only");
assert.equal(releaseWorkflow.jobs.publish.permissions?.contents, "write", "publish job alone may write releases");
const checkout = releaseWorkflow.jobs.release.steps.find((step) =>
	`${step?.uses ?? ""}`.startsWith("actions/checkout@"));
assert.equal(checkout?.with?.["persist-credentials"], false, "release checkout must not persist credentials");
console.log("  PASS  release workflow uploads every headless host asset");

console.log("\n--- headless host CI workflow: headless gates stay wired ---");
const ciWorkflow = await loadWorkflow(".github/workflows/ci.yml");
const ciRunSteps = runSteps(ciWorkflow, "build");
for (const command of REQUIRED_CI_RUNS) {
	assert(ciRunSteps.includes(command), `CI workflow must run: ${command}`);
}
console.log("  PASS  CI workflow runs headless build and integration gates");

console.log("\n--- public snapshot PR workflow: token and branch gates stay narrow ---");
const publicPrWorkflow = await loadWorkflow(".github/workflows/open-public-pr.yml");
assert.deepEqual(
	publicPrWorkflow.on?.push?.branches,
	["automation/public-*"],
	"public PR workflow must run only for deterministic snapshot branches",
);
assert.equal(publicPrWorkflow.permissions?.contents, "read", "public PR workflow may only read contents");
assert.equal(
	publicPrWorkflow.permissions?.["pull-requests"],
	"write",
	"public PR workflow needs pull-request write only",
);
const publicPrScript = runSteps(publicPrWorkflow, "open").join("\n");
assert.equal(
	publicPrWorkflow.jobs.open.steps[0].env?.ACTOR_ID,
	"${{ github.actor_id }}",
	"public PR workflow must bind pushes to the deploy-key registrar",
);
assert(publicPrScript.includes("show -s --format=%P"), "snapshot commit must have exactly one parent");
assert(publicPrScript.includes("BASE_PREFIX"), "branch base hash must match public main");
assert(publicPrScript.includes("TREE_PREFIX"), "branch tree hash must match the snapshot tree");
assert(publicPrScript.includes("int@kakao.com"), "snapshot author and committer email must be approved");
assert(publicPrScript.includes("gh pr create"), "public workflow must create the snapshot PR");
assert(publicPrScript.includes("--draft"), "snapshot PR must start as a draft");
assert(!publicPrScript.includes("gh pr merge"), "public workflow must never merge its own PR");
assert(!publicPrScript.includes("gh pr review"), "public workflow must never approve its own PR");
console.log("  PASS  public PR workflow validates one-parent branches and cannot merge them");

console.log("\n--- headless host package scripts: release regression includes oracle deploy ---");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageJson.scripts["test:headless-host:oracle-deploy"], "node tests/headless-host-oracle-deploy.mjs");
assert.equal(packageJson.scripts["prepare:headless-host-oracle-upload"], "node scripts/prepare-headless-host-oracle-upload.mjs");
assert.equal(packageJson.scripts["uninstall:headless-host"], "node scripts/uninstall-headless-host.mjs");
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
assert(runner.includes("tests/headless-host-uninstall.mjs"), "release regressions must include uninstall coverage");
console.log("  PASS  package and regression runner keep Oracle deploy gates reachable");

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
