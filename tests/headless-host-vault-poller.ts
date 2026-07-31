import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeadlessVaultPoller } from "../src/headless-host/core/vaultPoller";
import { HeadlessVault } from "../src/headless-host/core/vault";

const root = await mkdtemp(join(tmpdir(), "kaos-headless-host-poller-"));
const vault = new HeadlessVault({ vaultRoot: root });
const poller = new HeadlessVaultPoller(vault, { intervalMs: 250, quietMs: 0 });
const events: Array<{ kind: string; path: string; oldPath?: string }> = [];

vault.on("create", (file: { path: string }) => events.push({ kind: "create", path: file.path }));
vault.on("modify", (file: { path: string }) => events.push({ kind: "modify", path: file.path }));
vault.on("delete", (file: { path: string }) => events.push({ kind: "delete", path: file.path }));
vault.on("rename", (file: { path: string }, oldPath: string) => events.push({ kind: "rename", path: file.path, oldPath }));

try {
	console.log("\n--- headless host vault poller: external create/modify/delete events ---");
	await mkdir(join(root, "notes"), { recursive: true });
	await writeFile(join(root, "notes", "existing.md"), "existing", "utf8");
	await poller.initialize();
	assert.deepEqual(events, [], "initial scan should only establish a baseline");

	await writeFile(join(root, "notes", "new.md"), "new", "utf8");
	await poller.pollOnce();
	assert.deepEqual(events, [{ kind: "create", path: "notes/new.md" }]);

	await sleep(5);
	await writeFile(join(root, "notes", "new.md"), "new content", "utf8");
	await poller.pollOnce();
	assert.deepEqual(events.at(-1), { kind: "modify", path: "notes/new.md" });

	await unlink(join(root, "notes", "new.md"));
	await poller.pollOnce();
	assert.deepEqual(events.at(-1), { kind: "delete", path: "notes/new.md" });
	console.log("  PASS  poller emits vault-compatible events");

	console.log("\n--- headless host vault poller: simple rename emits rename event ---");
	events.length = 0;
	await writeFile(join(root, "notes", "rename-source.md"), "same", "utf8");
	await poller.pollOnce();
	events.length = 0;
	await rename(join(root, "notes", "rename-source.md"), join(root, "notes", "rename-target.md"));
	await poller.pollOnce();
	assert.deepEqual(events, [{ kind: "rename", path: "notes/rename-target.md", oldPath: "notes/rename-source.md" }]);
	console.log("  PASS  poller emits rename for conservative one-to-one rename");

	console.log("\n--- headless host vault poller: vault writes refresh poll baseline ---");
	events.length = 0;
	const livePoller = new HeadlessVaultPoller(vault, { intervalMs: 60_000, quietMs: 0 });
	await livePoller.start();
	try {
		const remoteFile = await vault.create("notes/remote.md", "remote");
		await vault.rename(remoteFile, "notes/remote-renamed.md");
		events.length = 0;
		await unlink(join(root, "notes", "remote-renamed.md"));
		await livePoller.pollOnce();
		assert.deepEqual(events, [{ kind: "delete", path: "notes/remote-renamed.md" }]);
		console.log("  PASS  poller baseline follows vault-originated rename");
	} finally {
		livePoller.stop();
	}

	console.log("\n--- headless host vault poller: external write during Vault create remains observable ---");
	const raceRoot = await mkdtemp(join(tmpdir(), "kaos-headless-host-create-race-"));
	const raceVault = new HeadlessVault({ vaultRoot: raceRoot });
	const racePoller = new HeadlessVaultPoller(raceVault, {
		intervalMs: 60_000,
		quietMs: 0,
	});
	const raceEvents: Array<{ kind: string; path: string }> = [];
	racyVaultOnCreateAndModify(raceVault, raceEvents);
	await racePoller.start();
	try {
		const path = "attachments/create-race.bin";
		const adapter = raceVault.adapter as unknown as {
			linkPreparedFile(source: string, target: string): Promise<void>;
		};
		const originalLinkPreparedFile = adapter.linkPreparedFile.bind(raceVault.adapter);
		adapter.linkPreparedFile = async (source, target) => {
			await originalLinkPreparedFile(source, target);
			// Model an out-of-band writer that reacts to the linked destination before
			// the adapter can return and HeadlessVault can publish its create event.
			await writeFile(target, Buffer.from([9, 8, 7]));
		};
		await raceVault.createBinary(path, new Uint8Array([0, 1, 2, 3, 4]).buffer);
		raceEvents.length = 0;
		await racePoller.pollOnce();
		assert.deepEqual(
			raceEvents,
			[{ kind: "modify", path }],
			"the poll baseline retains the Vault-owned revision instead of swallowing the external overwrite",
		);
		console.log("  PASS  pre-event external overwrite is emitted as a later modify");
	} finally {
		racePoller.stop();
		await rm(raceRoot, { recursive: true, force: true });
	}
} finally {
	poller.stop();
	await rm(root, { recursive: true, force: true });
}

function racyVaultOnCreateAndModify(
	vault: HeadlessVault,
	events: Array<{ kind: string; path: string }>,
): void {
	vault.on("create", (file: { path: string }) => {
		events.push({ kind: "create", path: file.path });
	});
	vault.on("modify", (file: { path: string }) => {
		events.push({ kind: "modify", path: file.path });
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
