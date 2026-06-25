#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (error) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${error instanceof Error ? error.message : String(error)}`);
		failed++;
	}
}

function runRunner(args) {
	return spawnSync(process.execPath, ["tests/run-regressions.mjs", ...args], {
		encoding: "utf8",
	});
}

test("--skip excludes matching suites from --list output", () => {
	const result = runRunner(["--skip", "witness-scenario-step", "--list"]);

	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes("tests/snapshot-r2-runner.mjs"));
	assert.ok(!result.stdout.includes("tests/witness-scenario-step.ts"));
});

test("--skip fails when no suite path matches", () => {
	const result = runRunner(["--skip", "definitely-not-a-real-suite", "--list"]);

	assert.equal(result.status, 2);
	assert.match(result.stderr, /no suite path matched --skip filter/);
});

test("--skip is repeatable", () => {
	const result = runRunner(["--skip", "witness-scenario-step", "--skip", "snapshot-r2-runner", "--list"]);

	assert.equal(result.status, 0, result.stderr);
	assert.ok(!result.stdout.includes("tests/witness-scenario-step.ts"));
	assert.ok(!result.stdout.includes("tests/snapshot-r2-runner.mjs"));
	assert.ok(result.stdout.includes("tests/run-regressions-cli.mjs"));
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
