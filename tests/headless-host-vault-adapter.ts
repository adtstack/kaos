import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeadlessVault, HeadlessVaultAdapter } from "../src/headless-host/core/vault";
import { TFile, TFolder } from "../src/headless-host/core/fileTypes";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-host-vault-"));
const vault = new HeadlessVault({
	vaultRoot: root,
	excludedPaths: [".kaos-headless-host", "custom-state/data.json"],
});
const events: Array<{ kind: string; path: string; oldPath?: string }> = [];

class AtomicReplacementDuringProcessAdapter extends HeadlessVaultAdapter {
	replacementIdentity: { dev: number; ino: number } | null = null;

	protected override async beforeProcessCommit(path: string): Promise<void> {
		const target = this.toFsPath(path);
		const replacement = `${target}.external-atomic-replacement`;
		await writeFile(replacement, "external-final-gap\n", { encoding: "utf8", flag: "wx" });
		await rename(replacement, target);
		const identity = await stat(target);
		this.replacementIdentity = { dev: identity.dev, ino: identity.ino };
	}
}

vault.on("create", (file: TFile) => events.push({ kind: "create", path: file.path }));
vault.on("modify", (file: TFile) => events.push({ kind: "modify", path: file.path }));
vault.on("delete", (file: TFile) => events.push({ kind: "delete", path: file.path }));
vault.on("rename", (file: TFile, oldPath: string) => events.push({ kind: "rename", path: file.path, oldPath }));

try {
	console.log("\n--- headless host vault adapter: path guard and file APIs ---");
	assert.throws(() => vault.adapter.toFsPath("../outside.md"), /escapes vault root/);
	assert.throws(() => vault.adapter.toFsPath("notes/../../outside.md"), /escapes vault root/);

	const created = await vault.create("notes/alpha.md", "one\n");
	assert.ok(created instanceof TFile);
	assert.equal(vault.getAbstractFileByPath("notes/alpha.md"), created);
	assert.equal(vault.getFiles().find((file) => file.path === "notes/alpha.md"), created);
	assert.equal(await vault.read(created), "one\n");
	assert.deepEqual(events.at(-1), { kind: "create", path: "notes/alpha.md" });

	await vault.modify(created, "two\n");
	assert.equal(vault.getAbstractFileByPath("notes/alpha.md"), created);
	assert.equal(vault.getFiles().find((file) => file.path === "notes/alpha.md"), created);
	assert.equal(await readFile(join(root, "notes", "alpha.md"), "utf8"), "two\n");
	assert.deepEqual(events.at(-1), { kind: "modify", path: "notes/alpha.md" });

	const processed = await vault.process(created, (current) => current.replace("two", "three"));
	assert.equal(processed, "three\n");
	assert.equal(vault.getAbstractFileByPath("notes/alpha.md"), created);
	assert.equal(vault.getFiles().find((file) => file.path === "notes/alpha.md"), created);
	assert.equal(await vault.read(created), "three\n");
	assert.deepEqual(events.at(-1), { kind: "modify", path: "notes/alpha.md" });

	const callbackError = new Error("abort-process");
	await assert.rejects(
		vault.process(created, () => {
			throw callbackError;
		}),
		(err) => err === callbackError,
	);
	assert.equal(await vault.read(created), "three\n");
	assert.equal(events.filter((event) => event.kind === "modify").length, 2);

	await assert.rejects(
		vault.process(created, () => {
			writeFileSync(join(root, "notes", "alpha.md"), "external-during-process\n", "utf8");
			return "must-not-overwrite-external\n";
		}),
		/changed during process/i,
	);
	assert.equal(await vault.read(created), "external-during-process\n");
	assert.equal(events.filter((event) => event.kind === "modify").length, 2);

	const finalGapAdapter = new AtomicReplacementDuringProcessAdapter(root);
	await finalGapAdapter.create("notes/process-final-gap.md", "before-final-gap\n");
	await assert.rejects(
		finalGapAdapter.process("notes/process-final-gap.md", () => "must-not-win-final-gap\n"),
		/changed during process/i,
	);
	assert.equal(
		await finalGapAdapter.read("notes/process-final-gap.md"),
		"external-final-gap\n",
	);
	const replacementIdentity = finalGapAdapter.replacementIdentity;
	assert.ok(replacementIdentity);
	const survivingIdentity = await stat(finalGapAdapter.toFsPath("notes/process-final-gap.md"));
	assert.deepEqual(
		{ dev: survivingIdentity.dev, ino: survivingIdentity.ino },
		replacementIdentity,
	);
	assert.ok(
		!(await readdir(join(root, "notes"))).some((name) => (
			name.startsWith("process-final-gap.md.kaos-headless-host-") && name.endsWith(".tmp")
		)),
	);
	await finalGapAdapter.remove("notes/process-final-gap.md");

	await vault.modify(created, "0\n");
	await Promise.all(Array.from({ length: 20 }, () => (
		vault.process(created, (current) => `${Number.parseInt(current, 10) + 1}\n`)
	)));
	assert.equal(await vault.read(created), "20\n");
	assert.equal(vault.getAbstractFileByPath("notes/alpha.md"), created);
	console.log("  PASS  process serializes transforms and preserves final-gap external replacements");

	const duplicateEventsBefore = events.length;
	await assert.rejects(vault.create("notes/alpha.md", "must-not-overwrite\n"), /exist/i);
	assert.equal(await vault.read(created), "20\n");
	assert.equal(events.length, duplicateEventsBefore);

	const racingCreates = await Promise.allSettled([
		vault.create("notes/create-race.md", "candidate-a\n"),
		vault.create("notes/create-race.md", "candidate-b\n"),
	]);
	assert.equal(racingCreates.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(racingCreates.filter((result) => result.status === "rejected").length, 1);
	assert.ok(["candidate-a\n", "candidate-b\n"].includes(
		await readFile(join(root, "notes", "create-race.md"), "utf8"),
	));
	assert.equal(
		events.filter((event) => event.kind === "create" && event.path === "notes/create-race.md").length,
		1,
	);
	const createRaceFile = vault.getAbstractFileByPath("notes/create-race.md");
	assert.ok(createRaceFile instanceof TFile);
	await vault.delete(createRaceFile);

	const adapterRacingCreates = await Promise.allSettled([
		vault.adapter.create("notes/adapter-create-race.md", "adapter-a\n"),
		vault.adapter.create("notes/adapter-create-race.md", "adapter-b\n"),
	]);
	assert.equal(adapterRacingCreates.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(adapterRacingCreates.filter((result) => result.status === "rejected").length, 1);
	assert.ok(["adapter-a\n", "adapter-b\n"].includes(
		await readFile(join(root, "notes", "adapter-create-race.md"), "utf8"),
	));
	await vault.adapter.remove("notes/adapter-create-race.md");
	console.log("  PASS  create is no-clobber for existing files and racing callers");

	console.log("\n--- headless host vault adapter: stable TFile identity epochs ---");
	const identityPath = "notes/identity-epoch.md";
	const identityAbs = join(root, "notes", "identity-epoch.md");
	const identityFile = await vault.create(identityPath, "identity-one\n");
	const identityBeforeInPlaceWrite = await stat(identityAbs);
	await writeFile(identityAbs, "identity-two\n", "utf8");
	const identityAfterInPlaceWrite = await stat(identityAbs);
	assert.deepEqual(
		{ dev: identityAfterInPlaceWrite.dev, ino: identityAfterInPlaceWrite.ino },
		{ dev: identityBeforeInPlaceWrite.dev, ino: identityBeforeInPlaceWrite.ino },
		"the test's out-of-band write must preserve the underlying file identity",
	);
	assert.equal(vault.getAbstractFileByPath(identityPath), identityFile);
	assert.equal(vault.getFiles().find((file) => file.path === identityPath), identityFile);

	const replacementPath = `${identityAbs}.replacement`;
	await writeFile(replacementPath, "identity-replaced\n", { encoding: "utf8", flag: "wx" });
	await rename(replacementPath, identityAbs);
	const replacedIdentityFile = vault.getAbstractFileByPath(identityPath);
	assert.ok(replacedIdentityFile instanceof TFile);
	assert.notEqual(replacedIdentityFile, identityFile, "an atomic path replacement starts a new TFile epoch");
	assert.equal(vault.getFiles().find((file) => file.path === identityPath), replacedIdentityFile);

	await rm(identityAbs);
	assert.ok(!vault.getFiles().some((file) => file.path === identityPath));
	await writeFile(identityAbs, "identity-recreated\n", "utf8");
	const recreatedIdentityFile = vault.getAbstractFileByPath(identityPath);
	assert.ok(recreatedIdentityFile instanceof TFile);
	assert.notEqual(
		recreatedIdentityFile,
		replacedIdentityFile,
		"a scan-observed delete followed by recreation never revives the deleted TFile",
	);
	await vault.delete(recreatedIdentityFile);
	console.log("  PASS  scans reuse live identities and replace them on atomic replace or delete/recreate ABA");

	const renameCollisionSource = await vault.create("notes/rename-source.md", "rename-source\n");
	const renameCollisionTarget = await vault.create("notes/rename-target.md", "rename-target\n");
	await assert.rejects(
		vault.rename(renameCollisionSource, renameCollisionTarget.path),
		/exist/i,
	);
	assert.equal(await vault.read(renameCollisionSource), "rename-source\n");
	assert.equal(await vault.read(renameCollisionTarget), "rename-target\n");
	await vault.delete(renameCollisionSource);
	await vault.delete(renameCollisionTarget);

	await vault.adapter.create("notes/adapter-rename-race-source.md", "adapter-rename-source\n");
	const renameCreateRace = await Promise.allSettled([
		vault.adapter.rename(
			"notes/adapter-rename-race-source.md",
			"notes/adapter-rename-race-target.md",
		),
		vault.adapter.create("notes/adapter-rename-race-target.md", "adapter-created-target\n"),
	]);
	assert.equal(renameCreateRace.filter((result) => result.status === "fulfilled").length, 1);
	const renameRaceTarget = await vault.adapter.read("notes/adapter-rename-race-target.md");
	if (renameRaceTarget === "adapter-rename-source\n") {
		assert.equal(await vault.adapter.exists("notes/adapter-rename-race-source.md"), false);
	} else {
		assert.equal(renameRaceTarget, "adapter-created-target\n");
		assert.equal(
			await vault.adapter.read("notes/adapter-rename-race-source.md"),
			"adapter-rename-source\n",
		);
	}
	await vault.adapter.remove("notes/adapter-rename-race-source.md");
	await vault.adapter.remove("notes/adapter-rename-race-target.md");
	console.log("  PASS  rename is no-clobber for existing and concurrently appearing targets");

	await vault.rename(created, "notes/beta.md");
	assert.equal(created.path, "notes/beta.md", "Obsidian-style rename updates the existing TFile object");
	assert.equal(await readFile(join(root, "notes", "beta.md"), "utf8"), "20\n");
	assert.deepEqual(events.at(-1), { kind: "rename", path: "notes/beta.md", oldPath: "notes/alpha.md" });

	const renamed = vault.getAbstractFileByPath("notes/beta.md");
	assert.ok(renamed instanceof TFile);
	assert.equal(renamed, created, "rename preserves the logical TFile identity");
	await vault.delete(renamed);
	assert.equal(await vault.adapter.exists("notes/beta.md"), false);
	assert.deepEqual(events.at(-1), { kind: "delete", path: "notes/beta.md" });
	const recreatedAfterDelete = await vault.create("notes/beta.md", "new beta epoch\n");
	assert.notEqual(recreatedAfterDelete, renamed, "Vault.delete terminates the old TFile epoch");
	await vault.delete(recreatedAfterDelete);
	console.log("  PASS  text APIs emit Obsidian-shaped vault events");

	console.log("\n--- headless host vault adapter: trash preserves removed files outside scan ---");
	const trashed = await vault.create("notes/trash-me.md", "do not lose me\n");
	events.length = 0;
	await vault.trash(trashed);
	assert.equal(await vault.adapter.exists("notes/trash-me.md"), false);
	assert.deepEqual(events, [{ kind: "delete", path: "notes/trash-me.md" }]);
	const trashCopies = await findFiles(join(root, ".trash", "kaos-headless-host"), "trash-me.md");
	assert.equal(trashCopies.length, 1);
	assert.equal(await readFile(trashCopies[0]!, "utf8"), "do not lose me\n");
	assert.ok(!vault.getFiles().some((file) => file.path.includes("trash-me.md")));
	const recreatedAfterTrash = await vault.create("notes/trash-me.md", "new trash epoch\n");
	assert.notEqual(recreatedAfterTrash, trashed, "Vault.trash terminates the old TFile epoch");
	await vault.delete(recreatedAfterTrash);
	console.log("  PASS  trash moves files into host-private trash");

	console.log("\n--- headless host vault adapter: binary, list, stat, and folders ---");
	const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);
	const binary = await vault.createBinary("attachments/sample.bin", bytes.buffer);
	const readBinary = new Uint8Array(await vault.readBinary(binary));
	assert.deepEqual([...readBinary], [...bytes]);
	await assert.rejects(
		vault.createBinary("attachments/sample.bin", Uint8Array.from([9, 9, 9]).buffer),
		/exist/i,
	);
	assert.deepEqual([...new Uint8Array(await vault.readBinary(binary))], [...bytes]);
	assert.equal((await vault.adapter.stat("attachments/sample.bin"))?.size, bytes.byteLength);
	assert.equal(await vault.adapter.exists("attachments/sample.bin"), true);
	assert.deepEqual(await vault.adapter.list("attachments"), { files: ["sample.bin"], folders: [] });
	const folder = await vault.createFolder("nested/folder");
	assert.ok(folder instanceof TFolder);
	assert.equal(await vault.adapter.exists("nested/folder"), true);
	console.log("  PASS  binary and adapter APIs round-trip through disk");

	console.log("\n--- headless host vault adapter: scan excludes host-private paths ---");
	await mkdir(join(root, ".obsidian"), { recursive: true });
	await mkdir(join(root, ".trash"), { recursive: true });
	await mkdir(join(root, ".kaos-headless-host"), { recursive: true });
	await mkdir(join(root, "custom-state"), { recursive: true });
	await writeFile(join(root, ".obsidian", "workspace.md"), "hidden", "utf8");
	await writeFile(join(root, ".trash", "deleted.md"), "hidden", "utf8");
	await writeFile(join(root, ".kaos-headless-host", "data.json"), "{}", "utf8");
	await writeFile(join(root, "custom-state", "data.json"), "{}", "utf8");
	await writeFile(join(root, "custom-state", "visible.md"), "visible", "utf8");
	await writeFile(join(root, "notes", "visible.md"), "visible", "utf8");
	await writeFile(join(root, "notes", "visible.md.kaos-headless-host-1-2.tmp"), "tmp", "utf8");

	assert.deepEqual(vault.getFiles().map((file) => file.path), [
		"attachments/sample.bin",
		"custom-state/visible.md",
		"notes/visible.md",
	]);
	assert.deepEqual(vault.getMarkdownFiles().map((file) => file.path), [
		"custom-state/visible.md",
		"notes/visible.md",
	]);
	console.log("  PASS  scans stay sorted and skip host-private files");

} finally {
	await rm(root, { recursive: true, force: true });
}

async function findFiles(root: string, basename: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(child);
			} else if (entry.isFile() && entry.name === basename) {
				out.push(child);
			}
		}
	}
	await walk(root);
	return out.sort();
}
