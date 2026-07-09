#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const root = await mkdtemp(join(tmpdir(), "kaos-conflicts-"));
const vault = join(root, "vault");
const dataFile = join(root, "headless-data.json");
const pluginDataFile = join(vault, ".obsidian", "plugins", "kaos", "data.json");
const lockFile = join(root, "kaos.lock");

try {
	await mkdir(join(vault, "notes"), { recursive: true });
	await mkdir(join(vault, "assets"), { recursive: true });
	await mkdir(join(vault, ".obsidian", "plugins", "kaos"), { recursive: true });
	await writeFile(join(vault, "notes", "a.md"), "current A\nsame\n", "utf8");
	await writeFile(
		join(vault, "notes", "a (KAOS conflict - crdt from laptop 2026-06-23T14-20-40Z).md"),
		"artifact A\nsame\n",
		"utf8",
	);
	await writeFile(join(vault, "notes", "b.md"), "current B\n", "utf8");
	await writeFile(
		join(vault, "notes", "b (KAOS conflict - disk from desktop 2026-06-23T14-21-40Z) 2.md"),
		"artifact B\n",
		"utf8",
	);
	await writeFile(join(vault, "assets", "img.png"), Buffer.from("local-image"));
	await writeFile(
		join(vault, "assets", "img (KAOS remote conflict 2026-06-23T14-22-40Z).png"),
		Buffer.from("remote-image"),
	);
	await writeFile(join(vault, "deleted.md"), "keep me\n", "utf8");
	await writeFile(join(vault, "drop.md"), "delete me\n", "utf8");
	await writeJson(dataFile, {
		_preservedUnresolved: [
			preserved("deleted.md", "markdown", 10, 20),
			preserved("drop.md", "markdown", 30, 40),
		],
	});
	await writeJson(pluginDataFile, {
		_preservedUnresolved: [
			preserved("deleted.md", "markdown", 11, 21),
			preserved("drop.md", "markdown", 31, 41),
		],
	});

	let inventory = list();
	assert.equal(inventory.kind, "kaos-conflicts");
	assert.equal(inventory.count, 5);
	findItem(inventory, (item) => item.artifactPath?.includes("a (KAOS conflict"), "markdown artifact");
	findItem(inventory, (item) => item.artifactPath?.includes("img (KAOS remote conflict"), "blob artifact");
	findItem(inventory, (item) => item.type === "preserved-unresolved" && item.path === "deleted.md", "preserved entry");

	const markdown = findItem(inventory, (item) => item.artifactPath?.includes("a (KAOS conflict"), "markdown artifact");
	const diff = runOk(["conflicts", "diff", markdown.id, ...vaultArgs()]).stdout;
	assert.match(diff, /--- current:notes\/a\.md/);
	assert.match(diff, /-current A/);
	assert.match(diff, /\+artifact A/);

	const shown = JSON.parse(runOk(["conflicts", "show", markdown.id, "--json", ...vaultArgs()]).stdout);
	assert.equal(shown.path, "notes/a.md");

	runOk(["conflicts", "keep-current", markdown.id, ...vaultArgs()]);
	assert.equal(await readFile(join(vault, "notes", "a.md"), "utf8"), "current A\nsame\n");
	assert.equal(existsSync(join(vault, "notes", "a (KAOS conflict - crdt from laptop 2026-06-23T14-20-40Z).md")), false);

	inventory = list();
	const replace = findItem(inventory, (item) => item.artifactPath?.includes("b (KAOS conflict"), "replacement artifact");
	runOk(["conflicts", "keep-artifact", replace.id, ...vaultArgs()]);
	assert.equal(await readFile(join(vault, "notes", "b.md"), "utf8"), "artifact B\n");
	assert.equal(existsSync(join(vault, "notes", "b (KAOS conflict - disk from desktop 2026-06-23T14-21-40Z) 2.md")), false);

	inventory = list();
	const local = findItem(inventory, (item) => item.type === "preserved-unresolved" && item.path === "deleted.md", "keep-local entry");
	runOk(["conflicts", "keep-local", local.id, ...vaultArgs()]);
	assert.equal(await readFile(join(vault, "deleted.md"), "utf8"), "keep me\n");
	assertPreservedMissing(await readJson(dataFile), "deleted.md");
	assertPreservedMissing(await readJson(pluginDataFile), "deleted.md");

	inventory = list();
	const drop = findItem(inventory, (item) => item.type === "preserved-unresolved" && item.path === "drop.md", "accept-delete entry");
	runOk(["conflicts", "accept-delete", drop.id, ...vaultArgs()]);
	assert.equal(existsSync(join(vault, "drop.md")), false);
	assertPreservedMissing(await readJson(dataFile), "drop.md");
	assertPreservedMissing(await readJson(pluginDataFile), "drop.md");

	const backupManifests = await findFiles(join(vault, ".kaos-resolver", "backups"), "manifest.json");
	assert.ok(backupManifests.length >= 4, "mutating actions create resolver backups");
	const trashFiles = await findFiles(join(vault, ".kaos-resolver", "trash"));
	assert.ok(trashFiles.some((path) => path.endsWith("a (KAOS conflict - crdt from laptop 2026-06-23T14-20-40Z).md")));
	assert.ok(trashFiles.some((path) => path.endsWith("drop.md")));

	await writeFile(join(vault, "notes", "locked.md"), "locked current\n", "utf8");
	await writeFile(
		join(vault, "notes", "locked (KAOS conflict - editor from desktop 2026-06-23T14-23-40Z).md"),
		"locked artifact\n",
		"utf8",
	);
	await writeJson(lockFile, { pid: 1234 });
	inventory = list();
	const locked = findItem(inventory, (item) => item.path === "notes/locked.md", "locked artifact");
	const lockedResult = run(["conflicts", "keep-current", locked.id, ...vaultArgs()]);
	assert.notEqual(lockedResult.status, 0);
	assert.match(lockedResult.stderr, /headless host lock exists/);
	await rm(lockFile, { force: true });

	const uiFallback = runOk(["ui", ...vaultArgs()]);
	assert.match(uiFallback.stderr, /requires an interactive TTY/);
	assert.match(uiFallback.stdout, /Conflicts in/);

	console.log("PASS kaos conflict resolver CLI");
} finally {
	await rm(root, { recursive: true, force: true });
}

function vaultArgs() {
	return ["--vault", vault, "--data-file", dataFile, "--lock-file", lockFile];
}

function preserved(path, kind, firstSeenAt, lastSeenAt) {
	return {
		path,
		kind,
		reason: "remote-delete-missing-baseline",
		firstSeenAt,
		lastSeenAt,
		localHash: "local",
		knownRemoteHash: "remote",
	};
}

function list() {
	return JSON.parse(runOk(["conflicts", "list", "--json", ...vaultArgs()]).stdout);
}

function runOk(args) {
	const result = run(args);
	if (result.status !== 0) {
		throw new Error(`command failed: node scripts/kaosctl.mjs ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
	}
	return result;
}

function run(args) {
	return spawnSync(process.execPath, ["scripts/kaosctl.mjs", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function findItem(inventory, predicate, label) {
	const item = inventory.items.find(predicate);
	assert.ok(item, `expected ${label}`);
	return item;
}

async function writeJson(path, value) {
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function assertPreservedMissing(data, path) {
	assert.ok(
		!Array.isArray(data._preservedUnresolved) || !data._preservedUnresolved.some((entry) => entry.path === path),
		`${path} preserved-unresolved entry should be removed`,
	);
}

async function findFiles(dir, suffix = null) {
	const out = [];
	async function walk(current) {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (!suffix || child.endsWith(suffix)) {
				out.push(child);
			}
		}
	}
	await walk(dir);
	return out;
}
