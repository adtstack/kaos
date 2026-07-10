import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeadlessVault } from "../src/headless-host/core/vault";
import { TFile, TFolder } from "../src/headless-host/core/fileTypes";
import { isExcluded } from "../src/sync/exclude";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-host-vault-"));
const vault = new HeadlessVault({
	vaultRoot: root,
	excludedPaths: [".kaos-headless-host", "custom-state/data.json"],
});
const events: Array<{ kind: string; path: string; oldPath?: string }> = [];

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
	assert.equal(await vault.read(created), "one\n");
	assert.deepEqual(events.at(-1), { kind: "create", path: "notes/alpha.md" });

	await vault.modify(created, "two\n");
	assert.equal(await readFile(join(root, "notes", "alpha.md"), "utf8"), "two\n");
	assert.deepEqual(events.at(-1), { kind: "modify", path: "notes/alpha.md" });

	await vault.rename(created, "notes/beta.md");
	assert.equal(await readFile(join(root, "notes", "beta.md"), "utf8"), "two\n");
	assert.deepEqual(events.at(-1), { kind: "rename", path: "notes/beta.md", oldPath: "notes/alpha.md" });

	const renamed = vault.getAbstractFileByPath("notes/beta.md");
	assert.ok(renamed instanceof TFile);
	await vault.delete(renamed);
	assert.equal(await vault.adapter.exists("notes/beta.md"), false);
	assert.deepEqual(events.at(-1), { kind: "delete", path: "notes/beta.md" });
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
	console.log("  PASS  trash moves files into host-private trash");

	console.log("\n--- headless host vault adapter: binary, list, stat, and folders ---");
	const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);
	const binary = await vault.createBinary("attachments/sample.bin", bytes.buffer);
	const readBinary = new Uint8Array(await vault.readBinary(binary));
	assert.deepEqual([...readBinary], [...bytes]);
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

	console.log("\n--- headless host vault adapter: injected KAOS policy excludes tool and hidden paths ---");
	const policyRoot = join(root, "policy-vault");
	const policyVault = new HeadlessVault({
		vaultRoot: policyRoot,
		isPathExcluded: (path) => isExcluded(path, [], ".obsidian"),
	});
	await mkdir(join(policyRoot, "sample-vault", ".obsidian"), { recursive: true });
	await mkdir(join(policyRoot, "project", "node_modules", "pkg"), { recursive: true });
	await mkdir(join(policyRoot, "project", "dist"), { recursive: true });
	await mkdir(join(policyRoot, "notes"), { recursive: true });
	await writeFile(join(policyRoot, "sample-vault", ".obsidian", "workspace.json"), "{}", "utf8");
	await writeFile(join(policyRoot, "project", "node_modules", "pkg", "index.js"), "module.exports = {};", "utf8");
	await writeFile(join(policyRoot, "project", "dist", "bundle.js"), "compiled", "utf8");
	await writeFile(join(policyRoot, "notes", "draft.md.swp"), "temporary", "utf8");
	await writeFile(join(policyRoot, "notes", "kept.md"), "kept", "utf8");
	assert.deepEqual(policyVault.getFiles().map((file) => file.path), ["notes/kept.md"]);
	assert.equal(policyVault.getAbstractFileByPath("sample-vault/.obsidian/workspace.json"), null);
	assert.equal(policyVault.getAbstractFileByPath("project/node_modules/pkg/index.js"), null);
	console.log("  PASS  injected policy prevents hidden/generated paths from reaching the poller");
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
