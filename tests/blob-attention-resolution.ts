import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { BlobSyncManager } from "../src/sync/blobSync";
import type { PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";

function bytes(value: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(value);
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

interface StoredFile {
	file: TFile & { path: string; stat: { mtime: number; size: number } };
	data: ArrayBuffer;
}

function makeFixture(
	path = "assets/attention.png",
	content = bytes("local attachment"),
	options: { initialBlobRef?: { hash: string; size: number } } = {},
) {
	const files = new Map<string, StoredFile>();
	let clock = 1;
	let blobRef: { hash: string; size: number } | undefined = options.initialBlobRef;
	let tombstoned = blobRef === undefined;
	let setBlobRefCalls = 0;
	let deleteBlobRefCalls = 0;
	let markerChangedCalls = 0;
	let modifyCalls = 0;
	let createCalls = 0;

	const put = (candidate: string, data: ArrayBuffer) => {
		const existing = files.get(candidate);
		const file = existing?.file ?? (new TFile() as StoredFile["file"]);
		file.path = candidate;
		file.stat = { mtime: clock++, size: data.byteLength };
		files.set(candidate, { file, data });
		return file;
	};
	put(path, content);

	const app = {
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (candidate: string) =>
				files.get(candidate)?.file ?? null,
			readBinary: async (file: StoredFile["file"]) => {
				const stored = files.get(file.path);
				if (!stored) throw new Error(`missing file: ${file.path}`);
				return stored.data;
			},
			modifyBinary: async (file: StoredFile["file"], data: ArrayBuffer) => {
				modifyCalls++;
				put(file.path, data);
			},
			createBinary: async (candidate: string, data: ArrayBuffer) => {
				createCalls++;
				if (files.has(candidate)) {
					const error = new Error("exists") as Error & { code?: string };
					error.code = "EEXIST";
					throw error;
				}
				put(candidate, data);
			},
			createFolder: async () => {},
			adapter: {
				stat: async (candidate: string) =>
					files.get(candidate)?.file.stat ?? null,
			},
		},
	} as any;

	const vaultSync = {
		pathToBlob: new Map<string, { hash: string; size: number }>(),
		blobTombstones: new Map<string, unknown>(),
		isBlobTombstoned: (candidate: string) =>
			candidate === path && tombstoned,
		getBlobRef: (candidate: string) =>
			candidate === path ? blobRef : undefined,
		getAuthoritativeBlobDeleteSnapshot: (candidate: string) =>
			candidate === path && tombstoned && !blobRef
				? { fingerprint: "blob-delete-fingerprint" }
				: null,
		setBlobRef: (
			candidate: string,
			hash: string,
			size: number,
		) => {
			assert.equal(candidate, path);
			setBlobRefCalls++;
			blobRef = { hash, size };
			tombstoned = false;
		},
		deleteBlobRef: () => {
			deleteBlobRefCalls++;
			if (blobRef) {
				blobRef = undefined;
				tombstoned = true;
			}
		},
	} as any;

	const marker: PreservedUnresolvedEntry = {
		path,
		kind: "blob",
		reason: "remote-delete-missing-baseline",
		episodeId: "blob-attention-episode",
		firstSeenAt: 100,
		lastSeenAt: 200,
	};
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
		() => { markerChangedCalls++; },
	);
	// Tests drive queue items deterministically instead of starting drain loops.
	(manager as any).kickUploadDrain = () => {};
	(manager as any).kickDownloadDrain = () => {};

	return {
		path,
		content,
		files,
		manager,
		marker,
		put,
		deleteLocalFile: async (file: StoredFile["file"]) => {
			files.delete(file.path);
		},
		get tombstoned() { return tombstoned; },
		get blobRef() { return blobRef; },
		get setBlobRefCalls() { return setBlobRefCalls; },
		get deleteBlobRefCalls() { return deleteBlobRefCalls; },
		get markerChangedCalls() { return markerChangedCalls; },
		get modifyCalls() { return modifyCalls; },
		get createCalls() { return createCalls; },
		setRemoteBlobRef(ref: { hash: string; size: number } | undefined) {
			blobRef = ref;
			tombstoned = ref === undefined;
		},
	};
}

console.log("\n--- Blob Attention resolution safety ---");

// Dashboard actions are bound to both the Attention episode and exact remote
// tombstone snapshot, so an old modal cannot queue work for a newer incident.
{
	const fixture = makeFixture();
	assert.throws(
		() => fixture.manager.keepLocalRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			{
				episodeId: "stale-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
		),
		/Attention state changed/,
	);
	assert.throws(
		() => fixture.manager.keepLocalRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "stale-delete-fingerprint",
			},
		),
		/Remote deletion changed/,
	);
	assert.equal(fixture.manager.pendingUploads, 0, "stale identities queue no upload");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"stale identities retain the current marker",
	);
}

// If Keep-local committed immediately before a crash but marker persistence
// lagged, the live ref proves that stale durable Attention can be pruned.
{
	const fixture = makeFixture(
		"assets/attention.png",
		bytes("local attachment"),
		{ initialBlobRef: { hash: "already-published", size: 16 } },
	);
	await Promise.resolve();
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		"startup prunes remote-delete marker when a live ref already exists",
	);
	assert.equal(fixture.markerChangedCalls, 1, "startup pruning schedules durable marker cleanup");
}

// Keep-local remains explicitly identifiable after queue persistence, retains
// the tombstone/marker while pending, and clears both only after setBlobRef.
{
	const source = makeFixture();
	source.manager.keepLocalRemoteDeletedBlob(
		source.path,
		"remote-delete-missing-baseline",
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	const snapshot = source.manager.exportQueue();
	assert.equal(
		source.manager.isKeepLocalRemoteDeletePending(
			source.path,
			"blob-attention-episode",
		),
		true,
		"queued Keep-local is exposed as pending to the dashboard",
	);
	assert.throws(
		() => source.manager.keepLocalRemoteDeletedBlob(
			source.path,
			"remote-delete-missing-baseline",
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
		),
		/already pending/,
		"a stale dashboard cannot restart an already pending Keep-local upload",
	);
	assert.equal(source.tombstoned, true, "queued Keep-local retains tombstone");
	assert.equal(
		source.manager.isPreservedUnresolved(source.path),
		true,
		"queued Keep-local retains Attention marker",
	);
	assert.deepEqual(
		snapshot.uploads[0]?.attentionResolution,
		{
			kind: "keep-local-remote-delete",
			expectedReason: "remote-delete-missing-baseline",
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
		"queue snapshot persists explicit Keep-local intent",
	);

	const restored = makeFixture();
	restored.manager.importQueue(snapshot);
	const restoredItem = (restored.manager as any).uploadQueue.get(restored.path);
	assert.equal(
		restoredItem?.attentionResolution?.kind,
		"keep-local-remote-delete",
		"restored upload retains explicit guard bypass",
	);
	(restored.manager as any).blobClient = {
		exists: async () => [],
		upload: async () => {},
	};
	await (restored.manager as any).processUpload(restoredItem);
	assert.equal(restored.setBlobRefCalls, 1, "successful upload commits blob ref once");
	assert.equal(restored.tombstoned, false, "setBlobRef clears tombstone");
	assert.equal(
		restored.manager.isPreservedUnresolved(restored.path),
		false,
		"successful setBlobRef clears Attention marker",
	);
	assert.equal(restored.markerChangedCalls, 1, "marker persistence callback runs after commit");
}

// A permanently failed explicit Keep-local upload remains actionable.
{
	const fixture = makeFixture();
	fixture.manager.keepLocalRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	const item = (fixture.manager as any).uploadQueue.get(fixture.path);
	item.retries = 3;
	(fixture.manager as any).blobClient = {
		exists: async () => { throw new Error("permanent R2 failure"); },
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		await (fixture.manager as any).processUpload(item);
	} finally {
		console.error = originalError;
	}
	assert.equal(fixture.setBlobRefCalls, 0, "failed upload does not publish blob ref");
	assert.equal(fixture.tombstoned, true, "failed upload retains tombstone");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"permanent upload failure retains Attention marker",
	);
	assert.equal(fixture.markerChangedCalls, 0, "failure does not persist a false resolution");
}

// A persisted download is only a hint; restart must not restore bytes for a
// path that is currently tombstoned or has no matching live ref.
{
	const fixture = makeFixture();
	fixture.manager.importQueue({
		uploads: [],
		downloads: [{
			path: fixture.path,
			hash: "stale-persisted-download",
			status: "pending",
		}],
	});
	assert.equal(fixture.manager.pendingDownloads, 0, "tombstoned persisted download is discarded");
}

// Accept revalidates the episode after the asynchronous caller-owned delete.
{
	const fixture = makeFixture();
	await assert.rejects(
		fixture.manager.acceptRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			async (file) => {
				fixture.files.delete(file.path);
				const registry = (fixture.manager as any).preservedUnresolved;
				registry.resolve(fixture.path);
				registry.record({
					path: fixture.path,
					kind: "blob",
					reason: "remote-delete-missing-baseline",
					episodeId: "newer-blob-attention-episode",
					at: 300,
				});
			},
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
		),
		/Attention state changed/,
	);
	assert.equal(
		(fixture.manager as any).preservedUnresolved.get(fixture.path)?.episodeId,
		"newer-blob-attention-episode",
		"Accept completion does not clear a newer Attention episode",
	);
}

// A failed trash operation must leave the local file and marker actionable.
{
	const fixture = makeFixture();
	await assert.rejects(
		fixture.manager.acceptRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			async () => { throw new Error("trash failed"); },
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
		),
		/trash failed/,
	);
	assert.equal(fixture.files.has(fixture.path), true, "trash failure preserves the local attachment");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"trash failure preserves the Attention marker",
	);
}

// Accept durably removes fenced transfers before it invokes trash. If that
// persistence step fails, no destructive local action is authorized.
{
	const fixture = makeFixture();
	let deleteCalled = false;
	await assert.rejects(
		fixture.manager.acceptRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			async () => { deleteCalled = true; },
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
			async () => { throw new Error("queue persistence failed"); },
		),
		/queue persistence failed/,
	);
	assert.equal(deleteCalled, false, "trash is not called before the fenced queue is durable");
	assert.equal(fixture.files.has(fixture.path), true, "persistence failure leaves local bytes intact");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"persistence failure leaves the Attention marker intact",
	);
}

{
	const fixture = makeFixture();
	const order: string[] = [];
	await fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		async (file) => {
			order.push("trash");
			fixture.files.delete(file.path);
		},
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
		async (snapshot) => {
			order.push("persist-fence");
			assert.equal(snapshot.uploads.length, 0);
			assert.equal(snapshot.downloads.length, 0);
		},
	);
	assert.deepEqual(order, ["persist-fence", "trash"], "queue fence is durable before trash");
}

// The local delete event owned by Accept must not tombstone a remote revival
// that arrives while trashFile is in progress.
{
	const fixture = makeFixture();
	await assert.rejects(
		fixture.manager.acceptRemoteDeletedBlob(
			fixture.path,
			"remote-delete-missing-baseline",
			async (file) => {
				fixture.setRemoteBlobRef({ hash: "remote-revival", size: 77 });
				fixture.manager.handleFileDelete(file.path, "local-device");
				fixture.files.delete(file.path);
			},
			{
				episodeId: "blob-attention-episode",
				remoteDeleteFingerprint: "blob-delete-fingerprint",
			},
		),
		/Attention state changed/,
	);
	assert.equal(fixture.deleteBlobRefCalls, 0, "Accept-owned delete event makes no CRDT delete mutation");
	assert.equal(fixture.blobRef?.hash, "remote-revival", "concurrent remote revival remains active");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"failed stale Accept keeps its marker for a refreshed decision",
	);
}

// Accept fences an HTTP upload already in flight before it can call setBlobRef.
{
	const fixture = makeFixture();
	fixture.manager.keepLocalRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	const item = (fixture.manager as any).uploadQueue.get(fixture.path);
	const uploadStarted = deferred<void>();
	const releaseUpload = deferred<void>();
	(fixture.manager as any).blobClient = {
		exists: async () => [],
		upload: async () => {
			uploadStarted.resolve();
			await releaseUpload.promise;
		},
	};
	const processing = (fixture.manager as any).processUpload(item);
	await uploadStarted.promise;
	await fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		fixture.deleteLocalFile,
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	releaseUpload.resolve();
	await processing;
	assert.equal(fixture.setBlobRefCalls, 0, "fenced in-flight upload cannot revive remote path");
	assert.equal(fixture.files.has(fixture.path), false, "Accept deletes the local attachment");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		"Accept clears marker only after local deletion",
	);
}

// A newly observed remote tombstone itself fences work admitted before the
// delete, even when no dashboard action is involved.
{
	const fixture = makeFixture();
	fixture.manager.keepLocalRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	const manager = fixture.manager as any;
	const item = manager.uploadQueue.get(fixture.path);
	const uploadStarted = deferred<void>();
	const releaseUpload = deferred<void>();
	manager.blobClient = {
		exists: async () => [],
		upload: async () => {
			uploadStarted.resolve();
			await releaseUpload.promise;
		},
	};
	manager.inflightUploads.add(fixture.path);
	const processing = manager.processUpload(item).finally(() => {
		manager.inflightUploads.delete(fixture.path);
		manager.notifyTransferSettled(fixture.path);
	});
	await uploadStarted.promise;
	const handlingDelete = manager.handleRemoteDelete(fixture.path, null);
	releaseUpload.resolve();
	await processing;
	await handlingDelete;
	assert.equal(fixture.setBlobRefCalls, 0, "pre-delete upload cannot clear the new tombstone");
	assert.equal(fixture.tombstoned, true, "remote tombstone remains authoritative");
	assert.equal(fixture.files.has(fixture.path), true, "unknown-baseline local bytes remain preserved");
}

// Accept fences a stale download while its bytes are in flight, preventing both
// overwrite and recreation after the caller deletes the local attachment.
{
	const fixture = makeFixture();
	const remote = bytes("stale remote attachment");
	const remoteHash = await sha256Hex(remote);
	const downloadStarted = deferred<void>();
	const releaseDownload = deferred<ArrayBuffer>();
	(fixture.manager as any).blobClient = {
		download: async () => {
			downloadStarted.resolve();
			return releaseDownload.promise;
		},
	};
	const item = {
		path: fixture.path,
		hash: remoteHash,
		sizeBytes: remote.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	(fixture.manager as any).downloadQueue.set(fixture.path, item);
	const processing = (fixture.manager as any).processDownload(item);
	await downloadStarted.promise;
	await fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		fixture.deleteLocalFile,
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	releaseDownload.resolve(remote);
	await processing;
	assert.equal(fixture.modifyCalls, 0, "fenced download cannot overwrite deleted attachment");
	assert.equal(fixture.createCalls, 0, "fenced download cannot recreate deleted attachment");
	assert.equal(fixture.files.has(fixture.path), false, "deleted attachment stays absent");
}

// A newer ref received during an active download is a distinct rerun target;
// it must not mutate the hash being verified by the old byte stream.
{
	const fixture = makeFixture();
	const firstBytes = bytes("first remote version");
	const secondBytes = bytes("second remote version");
	const firstHash = await sha256Hex(firstBytes);
	const secondHash = await sha256Hex(secondBytes);
	const firstDownloadStarted = deferred<void>();
	const releaseFirstDownload = deferred<ArrayBuffer>();
	const manager = fixture.manager as any;
	manager.blobClient = {
		download: async (hash: string) => {
			if (hash === firstHash) {
				firstDownloadStarted.resolve();
				return releaseFirstDownload.promise;
			}
			assert.equal(hash, secondHash);
			return secondBytes;
		},
	};
	const item = {
		path: fixture.path,
		hash: firstHash,
		sizeBytes: firstBytes.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	manager.downloadQueue.set(fixture.path, item);
	const firstAttempt = manager.processDownload(item);
	await firstDownloadStarted.promise;
	manager.enqueueDownload(fixture.path, secondHash, secondBytes.byteLength);
	assert.equal(item.hash, firstHash, "active attempt hash remains immutable");
	assert.equal(item.nextHash, secondHash, "new ref is retained as the rerun target");
	releaseFirstDownload.resolve(firstBytes);
	await firstAttempt;
	assert.equal(item.hash, secondHash, "rerun advances to the newer hash after old bytes settle");
	assert.equal(item.status, "pending", "newer hash remains queued");
	assert.equal(
		manager.hashCache[fixture.path]?.hash,
		firstHash,
		"old bytes are cached only under their verified hash",
	);
	item.status = "processing";
	await manager.processDownload(item);
	assert.equal(
		new TextDecoder().decode(fixture.files.get(fixture.path)?.data),
		"second remote version",
		"the rerun downloads and writes the newer bytes",
	);
}

// If a download already crossed its pre-write fence, Accept waits for that
// filesystem promise and deletes its final result instead of clearing the
// marker while a late write can still recreate the attachment.
{
	const fixture = makeFixture();
	const remote = bytes("remote write already started");
	const remoteHash = await sha256Hex(remote);
	const modifyStarted = deferred<void>();
	const releaseModify = deferred<void>();
	const manager = fixture.manager as any;
	manager.blobClient = { download: async () => remote };
	manager.app.vault.modifyBinary = async (
		file: StoredFile["file"],
		data: ArrayBuffer,
	) => {
		modifyStarted.resolve();
		await releaseModify.promise;
		fixture.put(file.path, data);
	};
	const item = {
		path: fixture.path,
		hash: remoteHash,
		sizeBytes: remote.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	manager.downloadQueue.set(fixture.path, item);
	manager.inflightDownloads.add(fixture.path);
	const processing = manager.processDownload(item).finally(() => {
		manager.inflightDownloads.delete(fixture.path);
		manager.notifyTransferSettled(fixture.path);
	});
	await modifyStarted.promise;
	const accepting = fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		fixture.deleteLocalFile,
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	);
	await Promise.resolve();
	assert.equal(
		fixture.files.has(fixture.path),
		true,
		"Accept waits while the already-started write owns the path",
	);
	releaseModify.resolve();
	await processing;
	await accepting;
	assert.equal(fixture.files.has(fixture.path), false, "Accept deletes the late write result");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		"marker clears only after the write settles and deletion completes",
	);
}

// Manager teardown is an async barrier: a replacement manager cannot start
// while an old filesystem write is still capable of completing.
{
	const fixture = makeFixture();
	const remote = bytes("write settling during destroy");
	const remoteHash = await sha256Hex(remote);
	const modifyStarted = deferred<void>();
	const releaseModify = deferred<void>();
	const manager = fixture.manager as any;
	manager.blobClient = { download: async () => remote };
	manager.app.vault.modifyBinary = async (
		file: StoredFile["file"],
		data: ArrayBuffer,
	) => {
		modifyStarted.resolve();
		await releaseModify.promise;
		fixture.put(file.path, data);
	};
	const item = {
		path: fixture.path,
		hash: remoteHash,
		sizeBytes: remote.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	manager.downloadQueue.set(fixture.path, item);
	manager.inflightDownloads.add(fixture.path);
	const processing = manager.processDownload(item).finally(() => {
		manager.inflightDownloads.delete(fixture.path);
		manager.notifyTransferSettled(fixture.path);
	});
	manager.activeTransferPromises.add(processing);
	await modifyStarted.promise;
	let destroyResolved = false;
	const destroying = fixture.manager.destroy().then(() => { destroyResolved = true; });
	await Promise.resolve();
	assert.equal(destroyResolved, false, "destroy waits for the old filesystem write");
	releaseModify.resolve();
	await destroying;
	assert.equal(destroyResolved, true, "destroy resolves after the write settles");
	assert.equal(
		new TextDecoder().decode(fixture.files.get(fixture.path)?.data),
		"write settling during destroy",
		"the last old-manager write completes before teardown returns",
	);
}

console.log("PASS blob Attention resolution safety");
