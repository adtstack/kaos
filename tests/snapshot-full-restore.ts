import assert from "node:assert/strict";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { SnapshotService } from "../src/snapshots/snapshotService";
import { DiskMirror } from "../src/sync/diskMirror";
import { evaluateSafetyBrake } from "../src/runtime/reconcile/safetyBrakePolicy";
import { diffSnapshot } from "../src/sync/snapshotClient";
import { fullRestoreCounts, requiresTypedFullRestoreConfirmation } from "../src/snapshots/fullRestore";

function fixture(mode: string) {
	const snapshot = new Y.Doc(); const live = new Y.Doc();
	function seed(doc: Y.Doc, path: string, content: string) {
		const text = new Y.Text(); text.insert(0, content);
		doc.getMap("pathToId").set(path, path); doc.getMap("idToText").set(path, text);
		doc.getMap("meta").set(path, { path });
	}
	seed(snapshot, "changed.md", "snapshot"); seed(snapshot, "deleted.md", "undeleted");
	seed(live, "changed.md", "changed"); seed(live, "created.md", "created");
	live.getMap("pathToBlob").set("created.png", { hash: "new", size: 3 });
	const files = new Map<string, TFile>(); const disk = new Map<string, string>([["changed.md", "changed"], ["created.md", "created"]]);
	for (const path of [...disk.keys(), "created.png"]) files.set(path, Object.assign(new TFile(), { path, stat: { ctime: 1, mtime: 1, size: 7 } }));
	const backups = new Map<string, string | ArrayBuffer>(); const events: string[] = []; const quarantine: string[] = [];
	const vs = { ydoc: live, connected: true, getTextForPath: (path: string) => {
		const id = live.getMap<string>("pathToId").get(path);
		return id ? live.getMap<Y.Text>("idToText").get(id) ?? null : null;
	} };
	const mirror = {
		prepareRemovalProjection: (path: string) => events.push(`suppress:${path}`),
		flushWrite: async (path: string) => {
			const content = vs.getTextForPath(path)!.toString(); disk.set(path, content);
			if (mode === "settlement-race") disk.set("created.md", "new local bytes during settlement");
			if (mode === "revival-race") live.getMap("meta").set("created.md", { path: "created.md" });
			return { kind: "written", path, content, baselineRecorded: true };
		},
		recordPreservedUnresolved: (path: string, reason: string) => quarantine.push(`${path}:${reason}`),
		isPreservedUnresolved: () => false,
	};
	let binaryBytes = new Uint8Array([1, 2, 3]).buffer;
	if (mode === "scale") {
		for (let i = 0; i < 2000; i++) {
			const path = `scale-${i}.md`; seed(snapshot, path, "old"); seed(live, path, "changed");
			disk.set(path, "changed");
			files.set(path, Object.assign(new TFile(), { path, stat: { ctime: 1, mtime: 1, size: 7 } }));
		}
	}
	const app = {
		vault: {
			adapter: {
				exists: async (path: string) => backups.has(path),
				mkdir: async (path: string) => { backups.set(path, "directory"); },
				write: async (path: string, content: string) => { if (mode === "backup-failure") throw new Error("disk full"); backups.set(path, content); },
				writeBinary: async (path: string, content: ArrayBuffer) => { backups.set(path, content); },
			},
			configDir: ".obsidian", getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			read: async (file: TFile) => disk.get(file.path)!,
			readBinary: async () => binaryBytes,
			createFolder: async () => {},
			create: async (path: string, content: string) => { if (mode === "backup-failure") throw new Error("disk full"); backups.set(path, content); },
			createBinary: async (path: string, content: ArrayBuffer) => { backups.set(path, content); },
			trash: async (file: TFile) => {
				events.push(`trash:${file.path}`);
				if (mode === "trash-failure") throw new Error("trash failed");
				files.delete(file.path); disk.delete(file.path);
			},
		}, fileManager: { trashFile: (file: TFile) => app.vault.trash(file) }, workspace: { iterateAllLeaves: () => {} },
	};
	const service = new SnapshotService({
		app: app as never, getSettings: () => ({ host: "http://test.invalid", vaultId: "test", authorizationHeader: async () => "Bearer test", deviceName: "test" }) as never,
		getTraceHttpContext: () => undefined, getVaultSync: () => vs as never,
		getDiskMirror: () => mirror as never, getBlobSync: () => null,
		getEditorBindings: () => ({ unbindByPath: (path: string) => events.push(`unbind:${path}`) }) as never,
		getServerSupportsSnapshots: () => mode !== "offline", log: () => {},
		removeDiskIndexEntry: async (path: string) => { events.push(`index:${path}`); },
		onEditorsNeedReconcile: reason => events.push(reason),
		recordFlightEvent: event => { events.push(event.kind); assert(!JSON.stringify(event.data).includes("created.md")); },
	});
	(globalThis as Record<string, unknown>).__KAOS_TEST_REQUEST_URL__ = () => {
		events.push("snapshot");
		if (mode === "snapshot-failure") return { status: 500, text: "R2 failure" };
		if (mode === "mid-snapshot-race") disk.set("created.md", "new local bytes");
		return { status: 200, json: { status: mode === "unconfirmed" ? "noop" : "created", index: { snapshotId: "safety" } } };
	};
	return { snapshot, live, service, disk, files, backups, events, quarantine, mutateBinary: () => { binaryBytes = new Uint8Array([9, 8, 7]).buffer; } };
}

for (const mode of ["happy", "snapshot-failure", "offline", "disk-race", "new-path", "mid-snapshot-race", "backup-failure", "trash-failure", "settlement-race", "revival-race", "binary-race", "unconfirmed"]) {
	const fx = fixture(mode);
	const review = await fx.service["captureFullRestoreReview"](fx.snapshot, fx.service["deps"].getVaultSync()!);
	if (mode === "binary-race") fx.mutateBinary();
	if (mode === "disk-race") fx.disk.set("created.md", "new local bytes");
	if (mode === "new-path") fx.live.getMap("pathToBlob").set("extra.png", { hash: "extra", size: 1 });
	const before = Y.encodeStateAsUpdate(fx.live);
	let rejected = false;
	try { await fx.service.restoreEntireVaultFromSnapshot(fx.snapshot, review); } catch { rejected = true; }
	if (mode === "happy") {
		assert(!rejected); assert.equal(fx.disk.get("changed.md"), "snapshot");
		assert.equal(fx.disk.get("deleted.md"), "undeleted"); assert(!fx.files.has("created.md"));
		assert.equal(fx.live.getMap<{ deleted: boolean }>("meta").get("created.md")?.deleted, true);
		assert(!fx.live.getMap("pathToBlob").has("created.png"));
		assert([...fx.backups.entries()].some(([path, text]) => path.endsWith("/created.md") && text === "created"));
		assert([...fx.backups.entries()].some(([path, text]) => path.endsWith("/changed.md") && text === "changed"));
		assert([...fx.backups.keys()].some(path => path.endsWith("/created.png")));
		assert(fx.events.indexOf("snapshot") < fx.events.indexOf("trash:created.md"));
		assert(fx.events.indexOf("suppress:created.md") < fx.events.indexOf("trash:created.md"));
		assert(fx.events.indexOf("unbind:created.md") < fx.events.indexOf("trash:created.md"));
		assert(fx.events.includes("recovery.restore.full.completed"));
	} else if (["trash-failure", "settlement-race", "revival-race"].includes(mode)) {
		assert(rejected); assert(fx.quarantine.includes("created.md:restore-disk-settlement-failed"));
		assert(fx.files.has("created.md")); assert(fx.events.includes("recovery.restore.full.failed"));
	} else {
		assert(rejected, `${mode} aborts`); assert(Buffer.from(before).equals(Buffer.from(Y.encodeStateAsUpdate(fx.live))), `${mode}: zero CRDT mutation`);
		assert(!fx.events.some(event => event.startsWith("trash:")), `${mode}: no deletion`);
	}
	fx.snapshot.destroy(); fx.live.destroy();
	console.log(`PASS full restore ${mode}`);
}

{
	const fx = fixture("scale"); const started = performance.now();
	const review = await fx.service["captureFullRestoreReview"](fx.snapshot, fx.service["deps"].getVaultSync()!);
	assert.equal(review.disk.size, 2003);
	console.log(`PASS synthetic 2000-file review capture: ${(performance.now() - started).toFixed(0)} ms`);
	fx.snapshot.destroy(); fx.live.destroy();
}
for (const [destructiveCount, localFileCount, triggered] of [[21, 80, true], [20, 40, false], [21, 84, false], [500, 2000, false], [501, 2000, true]] as const) {
	assert.equal(evaluateSafetyBrake({ destructiveCount, localFileCount }).triggered, triggered);
	assert.equal(evaluateSafetyBrake({ destructiveCount, localFileCount }).triggered, triggered, "manual retry retains the same brake policy");
}
console.log("PASS reconnect and manual-retry bulk restore brake thresholds");

// The public removal wrapper invokes only the existing private primitives.
const mirror = Object.create(DiskMirror.prototype);
const calls: string[] = [];
mirror.suppressDelete = (path: string) => calls.push(`suppress:${path}`);
mirror.unobserveText = (path: string) => calls.push(`unobserve:${path}`);
mirror.prepareRemovalProjection("created.md");
assert.deepEqual(calls, ["suppress:created.md", "unobserve:created.md"]);
console.log("PASS removal projection wrapper");
