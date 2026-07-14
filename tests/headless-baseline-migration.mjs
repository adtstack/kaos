#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	buildHeadlessHost,
	buildProductPluginBundle,
	installVaultPlugin,
} from "./helpers/headless-host-vault-plugin.mjs";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-baseline-migration-"));
const vaultRoot = join(root, "vault");
const dataFile = join(root, "state", "data.json");
const vaultId = "baseline-migration-vault";
const validText = "alpha baseline\n";
const validHash = sha256(validText);
const invalidHash = "f".repeat(64);

try {
	await mkdir(join(vaultRoot, "notes"), { recursive: true });
	await mkdir(join(root, "state"), { recursive: true });
	await writeFile(join(vaultRoot, "notes", "valid.md"), validText, "utf8");
	await writeFile(join(vaultRoot, "notes", "invalid.md"), "current text\n", "utf8");
	await writeFile(dataFile, `${JSON.stringify({
		host: "",
		token: "",
		vaultId,
		deviceName: "migration-test",
		enableAttachmentSync: false,
		_diskIndex: {
			"notes/valid.md": { mtime: 1, size: validText.length, contentHash: validHash },
			"notes/invalid.md": { mtime: 1, size: 12, contentHash: invalidHash },
		},
		_baselineTexts: {
			[validHash]: validText,
			[invalidHash]: "does not match its key\n",
		},
	}, null, 2)}\n`, "utf8");

	console.log("\n--- headless baseline migration: build and boot real plugin ---");
	buildProductPluginBundle();
	buildHeadlessHost();
	await installVaultPlugin(vaultRoot);
	const boot = spawnSync(process.execPath, [
		"dist/kaos-headless-host.mjs",
		"--boot-only",
		"--vault",
		vaultRoot,
		"--data-file",
		dataFile,
	], { encoding: "utf8", timeout: 15_000 });
	assert.equal(boot.status, 0, boot.stderr || boot.stdout);
	console.log("  PASS  real plugin completed startup migration");

	console.log("\n--- headless baseline migration: commit marker follows verified sidecars ---");
	const migrated = JSON.parse(await readFile(dataFile, "utf8"));
	assert.equal(migrated._baselineTextStoreVersion, 1);
	assert.equal("_baselineTexts" in migrated, false);
	const sidecarRoot = join(`${dataFile}.d`, "baseline-text-v1", vaultId);
	assert.equal(await readFile(join(sidecarRoot, validHash), "utf8"), validText);
	assert.equal(existsSync(join(sidecarRoot, invalidHash)), false);
	assert.equal(migrated._diskIndex["notes/valid.md"].contentHash, validHash);
	assert.equal(migrated._diskIndex["notes/invalid.md"].contentHash, invalidHash);
	console.log("  PASS  data.json keeps hashes only and corrupt legacy bodies fail closed");
} finally {
	await rm(root, { recursive: true, force: true });
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
