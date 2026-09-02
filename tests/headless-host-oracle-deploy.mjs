#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-oracle-device-auth-"));

try {
	console.log("\n--- Oracle deployment rejects legacy shared credentials ---");
	for (const script of [
		"bootstrap-headless-host-oracle.mjs",
		"postflight-headless-host.mjs",
		"smoke-headless-host-sync.mjs",
		"update-headless-host-from-release.mjs",
		"run-headless-host-oracle-rehearsal.mjs",
		"run-headless-host-oracle-remote-rehearsal.mjs",
		"run-headless-host-oracle-acceptance.mjs",
		"verify-headless-host-oracle-acceptance.mjs",
	]) {
		const result = run(process.execPath, [`scripts/${script}`, "--token-file", join(root, "legacy")]);
		assert.notEqual(result.status, 0, `${script} must reject legacy token files`);
		assert.match(result.stderr, /no longer supported|Legacy shared credential/i, `${script} must explain the safe replacement`);
	}
	console.log("  PASS  every Oracle deployment entry point fails closed for a shared credential");

	console.log("\n--- Oracle bootstrap prepares an identity location without a credential ---");
	const bootstrap = run(process.execPath, [
		"scripts/bootstrap-headless-host-oracle.mjs",
		"--allow-non-root",
		"--dry-run",
		"--skip-user",
		"--host", "https://worker.example.invalid",
		"--vault-id", "oracle-vault",
		"--device-name", "oracle-headless",
		"--install-dir", join(root, "opt", "kaos"),
		"--vault", join(root, "vault"),
		"--data-dir", join(root, "state"),
		"--etc-dir", join(root, "etc"),
	]);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);
	const bootstrapPayload = JSON.parse(bootstrap.stdout);
	assert.equal(bootstrapPayload.ok, true);
	assert.match(bootstrapPayload.paths.identityFile, /device-identity\.json$/);
	assert.equal(Object.hasOwn(bootstrapPayload.paths, "tokenFile"), false);
	const dataAction = bootstrapPayload.actions.find((action) => action.name === "data-dir");
	const identityAction = bootstrapPayload.actions.find((action) => action.name === "device-identity-file");
	assert.equal(dataAction.mode, "0700");
	assert.equal(identityAction.mode, "0600");
	assert.equal(identityAction.enrollmentRequired, true);
	assert.equal(bootstrap.stdout.includes("sync-token"), false);
	console.log("  PASS  bootstrap creates only protected identity state and records an enrollment next step");

	console.log("\n--- Oracle activation requires a separate Owner approval checkpoint ---");
	const rehearsal = run(process.execPath, [
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"--phase", "activate",
		"--no-sudo",
		"--log-dir", join(root, "logs"),
	]);
	assert.notEqual(rehearsal.status, 0);
	assert.match(rehearsal.stderr, /confirm-owner-approved/);
	const remote = run(process.execPath, [
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
		"--phase", "activate",
		"--ssh-target", "opc@example.invalid",
	]);
	assert.notEqual(remote.status, 0);
	assert.match(remote.stderr, /confirm-owner-approved/);
	const acceptance = run(process.execPath, [
		"scripts/run-headless-host-oracle-acceptance.mjs",
		"--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid",
		"--vault-id", "oracle-vault",
		"--invite-file", join(root, "invite"),
	]);
	assert.notEqual(acceptance.status, 0);
	assert.match(acceptance.stderr, /must run separately/i);
	console.log("  PASS  an unattended install cannot skip the Owner approval boundary");

	console.log("\n--- protected invitation and identity configuration are enforced ---");
	const invite = join(root, "invite");
	await writeFile(invite, "one-time-invite", "utf8");
	await chmod(invite, 0o644);
	const remoteInvite = run(process.execPath, [
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
		"--phase", "install",
		"--ssh-target", "opc@example.invalid",
		"--worker-host", "https://worker.example.invalid",
		"--vault-id", "oracle-vault",
		"--invite-file", invite,
	]);
	assert.notEqual(remoteInvite.status, 0);
	assert.match(remoteInvite.stderr, /regular 0600 file/);
	await chmod(invite, 0o600);
	const example = JSON.parse(await readFile("deploy/oracle-acceptance-config.example.json", "utf8"));
	assert.equal(typeof example.inviteFile, "string");
	assert.equal(Object.hasOwn(example, "tokenFile"), false);
	const service = await readFile("deploy/kaos-headless-host.service", "utf8");
	assert.equal(service.includes("--token"), false);
	assert.match(service, /EnvironmentFile=\/etc\/kaos\/headless\.env/);
	console.log("  PASS  invitation files must be 0600 and systemd accepts no token argument");

	console.log("\n--- release instructions contain no legacy credential path ---");
	const buildScript = await readFile("scripts/build-headless-host.mjs", "utf8");
	assert.equal(/sync-token|--token(?:\s|=|-)|KAOS_SYNC_TOKEN|SYNC_TOKEN/.test(buildScript), false);
	for (const script of [
		"scripts/bootstrap-headless-host-oracle.mjs",
		"scripts/postflight-headless-host.mjs",
		"scripts/smoke-headless-host-sync.mjs",
		"scripts/update-headless-host-from-release.mjs",
		"scripts/run-headless-host-oracle-rehearsal.mjs",
		"scripts/run-headless-host-oracle-remote-rehearsal.mjs",
		"scripts/run-headless-host-oracle-acceptance.mjs",
	]) {
		const source = await readFile(script, "utf8");
		assert.equal(/\/etc\/kaos\/sync-token/.test(source), false, `${script} must not use the old system credential path`);
	}
	console.log("  PASS  release paths document device enrollment rather than a reusable server token");
} finally {
	// The system temporary directory is owned by the test runner and is cleaned
	// by its normal lifecycle; keeping it avoids a destructive recursive cleanup.
}

function run(command, args) {
	return spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
}
