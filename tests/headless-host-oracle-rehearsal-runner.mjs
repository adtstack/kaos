#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

console.log("\n--- Oracle local rehearsal: credential and approval boundaries ---");

const legacy = run(["scripts/run-headless-host-oracle-rehearsal.mjs", "--token-file", "/tmp/legacy"]);
assert.notEqual(legacy.status, 0);
assert.match(legacy.stderr, /no longer supported/);

const noInvite = run([
	"scripts/run-headless-host-oracle-rehearsal.mjs", "--phase", "install", "--no-sudo",
	"--host", "https://worker.example.invalid", "--vault-id", "vault_12345678", "--log-dir", "/tmp/kaos-rehearsal-boundary",
]);
assert.notEqual(noInvite.status, 0);
assert.match(noInvite.stderr, /invite-file/);

const noApproval = run(["scripts/run-headless-host-oracle-rehearsal.mjs", "--phase", "activate", "--no-sudo", "--log-dir", "/tmp/kaos-rehearsal-boundary"]);
assert.notEqual(noApproval.status, 0);
assert.match(noApproval.stderr, /confirm-owner-approved/);

const help = run(["scripts/run-headless-host-oracle-rehearsal.mjs", "--help"]);
assert.equal(help.status, 0);
assert.match(help.stdout, /--invite-file/);
assert.match(help.stdout, /--confirm-owner-approved/);
assert.equal(help.stdout.includes("--token-file"), false);

console.log("  PASS  local rehearsal requires a protected invitation and an explicit Owner approval checkpoint");

function run(args) {
	return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
}
