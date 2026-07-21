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
	options: {
		initialBlobRef?: { hash: string; size: number };
		attachmentConcurrency?: number;
	} = {},
) {
	const files = new Map<string, StoredFile>();
	let clock = 1;
	let blobSourceClock = 1;
	let blobRef: { hash: string; size: number } | undefined = options.initialBlobRef;
	let blobSourceVersion = blobRef ? `1:${blobSourceClock++}` : undefined;
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
				return put(candidate, data);
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
		getBlobSourceVersion: (candidate: string) =>
			candidate === path && blobRef && !tombstoned
				? blobSourceVersion
				: undefined,
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
			blobSourceVersion = `1:${blobSourceClock++}`;
			tombstoned = false;
		},
		deleteBlobRef: () => {
			deleteBlobRefCalls++;
			if (blobRef) {
				blobRef = undefined;
				blobSourceVersion = undefined;
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
			attachmentConcurrency: options.attachmentConcurrency ?? 1,
			debug: false,
		},
		{},
		undefined,
		[marker],
		() => { markerChangedCalls++; },
	);
	// Tests drive queue items deterministically instead of starting drain loops.
	(manager as any).uploadGateOpen = true;
	(manager as any).downloadGateOpen = true;
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
			blobSourceVersion = ref ? `1:${blobSourceClock++}` : undefined;
			tombstoned = ref === undefined;
		},
	};
}

console.log("\n--- Blob Attention resolution safety ---");

// The engine has its own final guard even when an older host bypasses
// SettingsStore and constructs it with a corrupt zero concurrency value.
{
	const fixture = makeFixture(
		"assets/concurrency.png",
		bytes("local attachment"),
		{ attachmentConcurrency: 0 },
	);
	assert.equal(
		(fixture.manager as any).maxConcurrency,
		1,
		"zero transfer concurrency is clamped before either drain can run",
	);
}

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

// setBlobRef can synchronously notify observers. A replacement Attention
// occurrence installed re-entrantly must not be cleared by the older
// Keep-local commit that happened to share the same path.
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
	const originalSetBlobRef = manager.vaultSync.setBlobRef.bind(manager.vaultSync);
	manager.vaultSync.setBlobRef = (...args: unknown[]) => {
		originalSetBlobRef(...args);
		manager.preservedUnresolved.record({
			path: fixture.path,
			kind: "blob",
			reason: "remote-delete-missing-baseline",
			episodeId: "newer-blob-attention-episode",
		});
	};
	manager.blobClient = {
		exists: async () => [],
		upload: async () => {},
	};

	await manager.processUpload(item);
	const currentEntry = fixture.manager.getPreservedUnresolvedEntries()
		.find((entry) => entry.path === fixture.path);
	assert.equal(fixture.setBlobRefCalls, 1, "Keep-local publishes the verified ref once");
	assert.equal(
		currentEntry?.episodeId,
		"newer-blob-attention-episode",
		"re-entrant replacement Attention episode is not cleared by the older commit",
	);
	assert.equal(
		fixture.markerChangedCalls,
		0,
		"older Keep-local commit does not persist a false resolution for the replacement episode",
	);
}

// A transient failure cycle retains the explicit Keep-local upload as durable,
// automatically retryable intent instead of silently deleting the queue item.
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
	let retryDelay = 0;
	(fixture.manager as any).scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	(fixture.manager as any).blobClient = {
		exists: async () => {
			throw Object.assign(new Error("transient R2 failure"), { status: 503 });
		},
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
		(fixture.manager as any).uploadQueue.get(fixture.path),
		item,
		"transient retry exhaustion retains the exact durable queue item",
	);
	assert.equal(item.retries, 0, "the next bounded retry cycle starts fresh");
	assert.ok(item.readyAt > Date.now(), "the next retry cycle is backoff-delayed");
	assert.ok(retryDelay > 0, "automatic recovery schedules a future drain");
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"permanent upload failure retains Attention marker",
	);
	assert.equal(fixture.markerChangedCalls, 0, "failure does not persist a false resolution");
}

// Explicit non-transient HTTP 4xx responses remain terminal and do not loop.
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
		exists: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); },
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		await (fixture.manager as any).processUpload(item);
	} finally {
		console.error = originalError;
	}
	assert.equal(
		(fixture.manager as any).uploadQueue.has(fixture.path),
		false,
		"terminal HTTP failure retires the transfer queue item",
	);
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		true,
		"terminal Keep-local failure leaves Attention available for an explicit retry",
	);
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
	assert.equal(
		fixture.manager.isAcceptingRemoteDelete(fixture.path),
		false,
		"Accept ownership is inactive before the Dashboard action begins",
	);
	await fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		async (file) => {
			assert.equal(
				fixture.manager.isAcceptingRemoteDelete(file.path),
				true,
				"the exact caller-owned trash event is identifiable while Accept runs",
			);
			assert.equal(
				fixture.manager.isAcceptingRemoteDelete("assets/unrelated.png"),
				false,
				"Accept ownership never suppresses an unrelated local delete",
			);
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
	assert.equal(
		fixture.manager.isAcceptingRemoteDelete(fixture.path),
		false,
		"Accept ownership retires after the Dashboard action settles",
	);
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
// it must not mutate the hash being verified by the old byte stream. Neither
// attempt may overwrite an existing local attachment. Once H2 is authoritative,
// H1 must leave no disk artifact; only H2 may be preserved as the candidate.
{
	const fixture = makeFixture();
	const firstBytes = bytes("first remote version");
	const secondBytes = bytes("second remote version");
	const initialLocalHash = await sha256Hex(fixture.content);
	const firstHash = await sha256Hex(firstBytes);
	const secondHash = await sha256Hex(secondBytes);
	fixture.setRemoteBlobRef({ hash: firstHash, size: firstBytes.byteLength });
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
	fixture.setRemoteBlobRef({ hash: secondHash, size: secondBytes.byteLength });
	manager.enqueueDownload(fixture.path, secondHash, secondBytes.byteLength);
	assert.equal(item.hash, firstHash, "active attempt hash remains immutable");
	assert.equal(item.nextHash, secondHash, "new ref is retained as the rerun target");
	releaseFirstDownload.resolve(firstBytes);
	await firstAttempt;
	assert.equal(item.hash, secondHash, "rerun advances to the newer hash after old bytes settle");
	assert.equal(item.status, "pending", "newer hash remains queued");
	assert.equal(
		manager.hashCache[fixture.path]?.hash,
		initialLocalHash,
		"the target cache remains tied to the verified local attachment",
	);
	assert.equal(
		new TextDecoder().decode(fixture.files.get(fixture.path)?.data),
		"local attachment",
		"the superseded first attempt does not overwrite the local attachment",
	);
	assert.equal(
		Array.from(fixture.files.keys()).filter((path) =>
			path.includes("KAOS remote conflict")
		).length,
		0,
		"superseded H1 leaves no conflict artifact",
	);
	item.status = "processing";
	await manager.processDownload(item);
	assert.equal(
		new TextDecoder().decode(fixture.files.get(fixture.path)?.data),
		"local attachment",
		"the rerun also leaves the local attachment untouched",
	);
	const conflictContents = Array.from(fixture.files.entries())
		.filter(([path]) => path.includes("KAOS remote conflict"))
		.map(([, stored]) => new TextDecoder().decode(stored.data));
	assert.deepEqual(
		new Set(conflictContents),
		new Set(["second remote version"]),
		"only the authoritative H2 candidate is preserved",
	);
}

// If a conflict-artifact write already crossed its pre-write fence, Accept
// waits for that filesystem promise before deleting the original attachment
// and clearing the marker.
{
	const fixture = makeFixture();
	const remote = bytes("remote write already started");
	const remoteHash = await sha256Hex(remote);
	const artifactStarted = deferred<void>();
	const releaseArtifact = deferred<void>();
	const manager = fixture.manager as any;
	fixture.setRemoteBlobRef({ hash: remoteHash, size: remote.byteLength });
	manager.blobClient = { download: async () => remote };
	const createBinary = manager.app.vault.createBinary;
	manager.app.vault.createBinary = async (
		candidate: string,
		data: ArrayBuffer,
	) => {
		if (candidate.includes("KAOS remote conflict")) {
			artifactStarted.resolve();
			await releaseArtifact.promise;
		}
		return createBinary(candidate, data);
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
	await artifactStarted.promise;
	fixture.setRemoteBlobRef(undefined);
	let acceptingResolved = false;
	const accepting = fixture.manager.acceptRemoteDeletedBlob(
		fixture.path,
		"remote-delete-missing-baseline",
		fixture.deleteLocalFile,
		{
			episodeId: "blob-attention-episode",
			remoteDeleteFingerprint: "blob-delete-fingerprint",
		},
	).then(() => { acceptingResolved = true; });
	await Promise.resolve();
	assert.equal(acceptingResolved, false, "Accept waits for the artifact write");
	assert.equal(
		fixture.files.has(fixture.path),
		true,
		"Accept preserves the original while the artifact write is pending",
	);
	releaseArtifact.resolve();
	await processing;
	await accepting;
	assert.equal(fixture.files.has(fixture.path), false, "Accept deletes the original after the write settles");
	const conflict = Array.from(fixture.files.entries()).find(
		([path]) => path.includes("KAOS remote conflict"),
	);
	assert.equal(
		new TextDecoder().decode(conflict?.[1].data),
		"remote write already started",
		"the in-flight remote candidate remains preserved as an artifact",
	);
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		"marker clears only after the write settles and deletion completes",
	);
}

// Manager teardown is an async barrier: a replacement manager cannot start
// while an old conflict-artifact write is still capable of completing.
{
	const fixture = makeFixture();
	const remote = bytes("write settling during destroy");
	const remoteHash = await sha256Hex(remote);
	const artifactStarted = deferred<void>();
	const releaseArtifact = deferred<void>();
	const manager = fixture.manager as any;
	fixture.setRemoteBlobRef({ hash: remoteHash, size: remote.byteLength });
	manager.blobClient = { download: async () => remote };
	const createBinary = manager.app.vault.createBinary;
	manager.app.vault.createBinary = async (
		candidate: string,
		data: ArrayBuffer,
	) => {
		if (candidate.includes("KAOS remote conflict")) {
			artifactStarted.resolve();
			await releaseArtifact.promise;
		}
		return createBinary(candidate, data);
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
	await artifactStarted.promise;
	let destroyResolved = false;
	const destroying = fixture.manager.destroy().then(() => { destroyResolved = true; });
	await Promise.resolve();
	assert.equal(destroyResolved, false, "destroy waits for the old filesystem write");
	releaseArtifact.resolve();
	await destroying;
	assert.equal(destroyResolved, true, "destroy resolves after the write settles");
	assert.equal(
		new TextDecoder().decode(fixture.files.get(fixture.path)?.data),
		"local attachment",
		"the old manager never overwrites the local attachment",
	);
	const conflict = Array.from(fixture.files.entries()).find(
		([path]) => path.includes("KAOS remote conflict"),
	);
	assert.equal(
		new TextDecoder().decode(conflict?.[1].data),
		"write settling during destroy",
		"the last old-manager artifact write completes before teardown returns",
	);
}

// A mobile/storage read rejection is not a file-change epoch. It must consume
// the bounded retry budget and then sleep instead of resetting into a tight
// immediate rerun loop.
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
	item.retries = 3;
	item.status = "processing";
	let retryDelay = 0;
	manager.scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	manager.app.vault.readBinary = async () => {
		throw new Error("mobile storage temporarily unavailable");
	};
	await manager.processUpload(item);
	assert.equal(manager.uploadQueue.get(fixture.path), item, "transient read failure retains the exact upload intent");
	assert.equal(item.retries, 0, "transient read starts a fresh bounded retry cycle");
	assert.ok(item.readyAt > Date.now(), "transient read retry is delayed instead of immediately drained");
	assert.ok(retryDelay > 0, "transient read schedules an automatic recovery timer");
}

console.log("PASS blob Attention resolution safety");
