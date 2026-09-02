#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-acceptance-device-auth-"));
try {
	console.log("\n--- Oracle acceptance: installation and Owner approval stay separate ---");
	const legacy = run(["scripts/run-headless-host-oracle-acceptance.mjs", "--token-file", "/tmp/legacy"]);
	assert.notEqual(legacy.status, 0);
	assert.match(legacy.stderr, /no longer supported/);

	const noInvite = run([
		"scripts/run-headless-host-oracle-acceptance.mjs", "--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid", "--vault-id", "vault_12345678",
		"--start-at", "install", "--stop-after", "install", "--dry-run",
	]);
	assert.notEqual(noInvite.status, 0);
	assert.match(noInvite.stderr, /invite-file/);

	const invite = join(root, "invite");
	await writeFile(invite, "one-time-invite", "utf8");
	await chmod(invite, 0o600);
	const combined = run([
		"scripts/run-headless-host-oracle-acceptance.mjs", "--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid", "--vault-id", "vault_12345678", "--invite-file", invite, "--dry-run",
	]);
	assert.notEqual(combined.status, 0);
	assert.match(combined.stderr, /must run separately/);

	const noApproval = run([
		"scripts/run-headless-host-oracle-acceptance.mjs", "--ssh-target", "opc@example.invalid",
		"--start-at", "activate", "--stop-after", "activate",
	]);
	assert.notEqual(noApproval.status, 0);
	assert.match(noApproval.stderr, /confirm-owner-approved/);
	console.log("  PASS  the acceptance wrapper cannot progress from enrollment to service activation unattended");
} finally {
	await rm(root, { recursive: true, force: true });
}

function run(args) {
	return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
}
