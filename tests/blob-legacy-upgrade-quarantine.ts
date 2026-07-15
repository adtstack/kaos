import assert from "node:assert/strict";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { BlobSyncManager } from "../src/sync/blobSync";
import type { PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";
import type { BlobRef } from "../src/types";

const path = "assets/deleted-while-plugin-off.png";
const ref: BlobRef = { hash: "a".repeat(64), size: 42 };
const doc = new Y.Doc();
const pathToBlob = doc.getMap<BlobRef>("pathToBlob");
const blobTombstones = doc.getMap<unknown>("blobTombstones");
const providerOrigin = {};

function getMapSourceVersion<T>(map: Y.Map<T>, key: string): string | undefined {
	if (!map.has(key)) return undefined;
	const item = (map as unknown as {
		_map?: Map<string, { id?: { client?: unknown; clock?: unknown } }>;
	})._map?.get(key);
	const client = item?.id?.client;
	const clock = item?.id?.clock;
	return Number.isSafeInteger(client)
		&& typeof client === "number"
		&& client >= 0
		&& Number.isSafeInteger(clock)
		&& typeof clock === "number"
		&& clock >= 0
		? `${client}:${clock}`
		: undefined;
}

const marker: PreservedUnresolvedEntry = {
	path,
	kind: "blob",
	reason: "legacy-upgrade-missing-local-blob",
	episodeId: "legacy-upgrade-episode",
	firstSeenAt: 100,
	lastSeenAt: 100,
};
let markerChanges = 0;

const app = {
	vault: {
		configDir: ".obsidian",
		getFiles: () => [],
		getAbstractFileByPath: () => null,
	},
} as any;
const vaultSync = {
	pathToBlob,
	blobTombstones,
	provider: providerOrigin,
	isBlobTombstoned: (candidate: string) => blobTombstones.has(candidate),
	getBlobRef: (candidate: string) => pathToBlob.get(candidate),
	getBlobSourceVersion: (candidate: string) =>
		getMapSourceVersion(pathToBlob, candidate),
} as any;
const manager = new BlobSyncManager(
	app,
	vaultSync,
	{
		host: "https://worker.example",
		token: "token",
		vaultId: "vault",
		maxAttachmentSizeKB: 1024,
		attachmentConcurrency: 1,
		debug: false,
	},
	{},
	undefined,
	[marker],
	() => { markerChanges++; },
);
(manager as any).kickDownloadDrain = () => {};

console.log("\n--- Blob v4 legacy-missing upgrade quarantine ---");

manager.startObservers();
doc.transact(() => pathToBlob.set(path, ref), providerOrigin);
assert.equal(
	manager.exportQueue().downloads.length,
	0,
	"remote observer cannot recreate a legacy-known missing local path",
);

assert.deepEqual(
	manager.reconcile("authoritative", []),
	{ uploadQueued: 0, downloadQueued: 0, skipped: 1 },
	"authoritative reconcile keeps the missing path quarantined",
);
assert.equal(
	manager.prioritizeDownloads([path]),
	0,
	"open-note prioritization cannot bypass the upgrade quarantine",
);
assert.equal(manager.exportQueue().downloads.length, 0);

assert.throws(
	() => manager.acceptLegacyMissingRemoteBlob(
		path,
		"legacy-upgrade-episode",
		{ ...ref, hash: "b".repeat(64) },
	),
	/Remote attachment changed/,
	"a stale Dashboard ref cannot release a newer remote generation",
);
assert.equal(manager.isPreservedUnresolved(path), true);

manager.acceptLegacyMissingRemoteBlob(path, "legacy-upgrade-episode", ref);
assert.equal(
	manager.exportQueue().downloads.length,
	1,
	"explicit acceptance queues only the exact live remote ref",
);
assert.equal(manager.exportQueue().downloads[0]?.hash, ref.hash);
assert.equal(manager.isPreservedUnresolved(path), false);
assert.equal(markerChanges, 1, "explicit acceptance clears the visible Attention episode");

await manager.destroy();

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

async function makePresentRecoveryFixture(localText: string, remoteText: string) {
	const localBytes = new TextEncoder().encode(localText);
	const remoteBytes = new TextEncoder().encode(remoteText);
	const remoteRef: BlobRef = {
		hash: await sha256Hex(remoteBytes.buffer),
		size: remoteBytes.byteLength,
	};
	const recoveryDoc = new Y.Doc();
	const recoveryRefs = recoveryDoc.getMap<BlobRef>("pathToBlob");
	recoveryRefs.set(path, remoteRef);
	const file = new TFile() as TFile & {
		path: string;
		stat: { mtime: number; size: number };
	};
	file.path = path;
	file.stat = { mtime: 123, size: localBytes.byteLength };
	const settledCallbacks: Array<{ path?: string; ref?: BlobRef }> = [];
	const recoveryManager = new BlobSyncManager(
		{
			vault: {
				configDir: ".obsidian",
				getFiles: () => [file],
				getAbstractFileByPath: (candidate: string) =>
					candidate === path ? file : null,
				readBinary: async () => localBytes.buffer,
			},
		} as any,
		{
			pathToBlob: recoveryRefs,
			blobTombstones: recoveryDoc.getMap("blobTombstones"),
			isBlobTombstoned: () => false,
			getBlobRef: (candidate: string) => recoveryRefs.get(candidate),
			getBlobSourceVersion: (candidate: string) =>
				getMapSourceVersion(recoveryRefs, candidate),
		} as any,
		{
			host: "https://worker.example",
			token: "token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		undefined,
		[marker],
		undefined,
		undefined,
		{ [path]: remoteRef },
		(candidate, settledRef) => settledCallbacks.push({
			path: candidate,
			ref: settledRef,
		}),
	);
	return { recoveryManager, settledCallbacks, remoteRef };
}

const exactRecovery = await makePresentRecoveryFixture("downloaded bytes", "downloaded bytes");
exactRecovery.recoveryManager.reconcile("authoritative", []);
await Promise.all(Array.from(
	(exactRecovery.recoveryManager as any).activeTransferPromises as Set<Promise<void>>,
));
assert.equal(
	exactRecovery.recoveryManager.isPreservedUnresolved(path),
	false,
	"restart settles a crash-completed download only after fresh exact disk hashing",
);
assert.deepEqual(
	exactRecovery.settledCallbacks,
	[{ path, ref: exactRecovery.remoteRef }],
	"even a pre-existing settled H1 emits an exact-path fresh-settlement callback",
);
await exactRecovery.recoveryManager.destroy();

const changedRecovery = await makePresentRecoveryFixture("different local bytes", "remote bytes");
changedRecovery.recoveryManager.reconcile("authoritative", []);
await Promise.all(Array.from(
	(changedRecovery.recoveryManager as any).activeTransferPromises as Set<Promise<void>>,
));
assert.equal(
	changedRecovery.recoveryManager.isPreservedUnresolved(path),
	true,
	"different crash-recovery bytes remain fail-closed in Attention",
);
assert.equal(
	changedRecovery.settledCallbacks.length,
	0,
	"a stale loaded settled ref alone cannot release migration quarantine",
);
await changedRecovery.recoveryManager.destroy();

console.log("PASS blob v4 legacy-missing upgrade quarantine\n");
