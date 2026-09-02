#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-remote-rehearsal-"));
try {
	console.log("\n--- Oracle remote rehearsal: does not transport a shared credential ---");
	const legacy = run(["scripts/run-headless-host-oracle-remote-rehearsal.mjs", "--token-file", "/tmp/legacy"]);
	assert.notEqual(legacy.status, 0);
	assert.match(legacy.stderr, /no longer supported/);

	const noInvite = run([
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs", "--phase", "install", "--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid", "--vault-id", "vault_12345678",
	]);
	assert.notEqual(noInvite.status, 0);
	assert.match(noInvite.stderr, /invite-file/);

	const noApproval = run([
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs", "--phase", "activate", "--ssh-target", "opc@example.invalid",
	]);
	assert.notEqual(noApproval.status, 0);
	assert.match(noApproval.stderr, /confirm-owner-approved/);

	const invite = join(root, "invite");
	await writeFile(invite, "one-time-invite", "utf8");
	await chmod(invite, 0o644);
	const looseInvite = run([
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs", "--phase", "install", "--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid", "--vault-id", "vault_12345678", "--invite-file", invite,
	]);
	assert.notEqual(looseInvite.status, 0);
	assert.match(looseInvite.stderr, /regular 0600 file/);
	console.log("  PASS  remote install accepts only a one-time 0600 invite and cannot auto-activate it");
} finally {
	await rm(root, { recursive: true, force: true });
}

function run(args) {
	return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
}
