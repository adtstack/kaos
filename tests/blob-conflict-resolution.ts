import assert from "node:assert/strict";
import { TFile } from "obsidian";
import {
	BlobSyncManager,
	type BlobDownloadConflictResolutionIdentity,
	type BlobQueueSnapshot,
} from "../src/sync/blobSync";
import {
	createPersistedBlobQueueSnapshot,
	readPersistedBlobQueueSnapshot,
} from "../src/sync/persistedBlobQueue";
import type { PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";
import {
	blobRefFingerprint,
	createCausalBlobRef,
	getBlobRefPriorHashes,
	sameBlobRef,
	type BlobRef,
} from "../src/types";

function bytes(value: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(value);
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
}

function text(value: ArrayBuffer): string {
	return new TextDecoder().decode(value);
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", value);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

interface StoredFile {
	file: TFile & { path: string; stat: { mtime: number; size: number } };
	data: ArrayBuffer;
}

interface FixtureOptions {
	path?: string;
	artifactPath?: string;
	localData?: ArrayBuffer;
	remoteData?: ArrayBuffer;
	episodeId?: string;
	remoteSourceVersion?: string;
	markerLocalHash?: string | null;
	expectedLocalHash?: string | null;
}

async function makeFixture(options: FixtureOptions = {}) {
	const path = options.path ?? "assets/conflict.png";
	const artifactPath = options.artifactPath
		?? "assets/conflict (KAOS remote conflict 2026-07-20T01-02-03Z).png";
	const localData = options.localData ?? bytes("local attachment");
	const remoteData = options.remoteData ?? bytes("remote attachment");
	const episodeId = options.episodeId ?? "download-conflict-episode";
	const localHash = await sha256Hex(localData);
	const remoteHash = await sha256Hex(remoteData);
	let remoteRef: BlobRef = { hash: remoteHash, size: remoteData.byteLength };
	let remoteSourceVersion = options.remoteSourceVersion ?? "1:7";
	let sourceClock = Number(remoteSourceVersion.split(":")[1] ?? "7");
	let clock = 1;
	let setBlobRefCalls = 0;
	let uploadCalls = 0;
	let downloadCalls = 0;
	let markerChangedCalls = 0;
	let operationAuthorityCurrent = true;
	const files = new Map<string, StoredFile>();
	const trashedFiles = new Map<string, StoredFile>();
	const settledRefs: Record<string, BlobRef> = {};
	const settledSourceVersions: Record<string, string> = {};
	const settlementStages: Record<string, unknown> = {};

	const put = (candidate: string, data: ArrayBuffer) => {
		const existing = files.get(candidate);
		const file = existing?.file ?? (new TFile() as StoredFile["file"]);
		file.path = candidate;
		file.stat = { mtime: clock++, size: data.byteLength };
		files.set(candidate, { file, data });
		return file;
	};
	put(path, localData);
	put(artifactPath, remoteData);
	const trashFile = async (file: StoredFile["file"]) => {
		const oldPath = file.path;
		const stored = files.get(oldPath);
		if (!stored || stored.file !== file) throw new Error("missing source");
		files.delete(oldPath);
		file.path = `.trash/${oldPath}`;
		trashedFiles.set(file.path, stored);
	};

	const pathToBlob = new Map<string, BlobRef>([[path, remoteRef]]);
	const vaultSync = {
		pathToBlob,
		blobTombstones: new Map<string, unknown>(),
		getBlobRef: (candidate: string) =>
			candidate === path ? remoteRef : undefined,
		getBlobSourceVersion: (candidate: string) =>
			candidate === path ? remoteSourceVersion : undefined,
		isBlobTombstoned: () => false,
		setBlobRef: (
			candidate: string,
			hash: string,
			size: number,
			_mime: string,
			_device: unknown,
			guard: {
				expectedCurrentRef?: BlobRef;
				causalBaseRef?: BlobRef;
				expectedCurrentSourceVersion?: string;
			},
		) => {
			assert.equal(candidate, path);
			if (
				!sameBlobRef(remoteRef, guard.expectedCurrentRef)
				|| remoteSourceVersion !== guard.expectedCurrentSourceVersion
			) return null;
			setBlobRefCalls++;
			remoteRef = createCausalBlobRef(hash, size, guard.causalBaseRef);
			remoteSourceVersion = `1:${++sourceClock}`;
			pathToBlob.set(path, remoteRef);
			return { ref: remoteRef, sourceVersion: remoteSourceVersion };
		},
	} as any;

	const app = {
		vault: {
			configDir: ".obsidian",
			getFiles: () => Array.from(files.values(), ({ file }) => file),
			getAbstractFileByPath: (candidate: string) =>
				files.get(candidate)?.file ?? null,
			readBinary: async (file: StoredFile["file"]) => {
				const stored = files.get(file.path);
				if (!stored || stored.file !== file) {
					throw new Error(`missing file: ${file.path}`);
				}
				return stored.data;
			},
			createBinary: async (candidate: string, data: ArrayBuffer) => {
				if (files.has(candidate)) {
					const error = new Error("exists") as Error & { code?: string };
					error.code = "EEXIST";
					throw error;
				}
				return put(candidate, data);
			},
			rename: async (file: StoredFile["file"], newPath: string) => {
				const oldPath = file.path;
				const stored = files.get(oldPath);
				if (!stored || stored.file !== file) throw new Error("missing source");
				if (files.has(newPath)) {
					const error = new Error("exists") as Error & { code?: string };
					error.code = "EEXIST";
					throw error;
				}
				files.delete(oldPath);
				file.path = newPath;
				files.set(newPath, stored);
			},
			trash: trashFile,
			createFolder: async () => {},
			adapter: {
				stat: async (candidate: string) =>
					files.get(candidate)?.file.stat ?? null,
			},
		},
		fileManager: { trashFile },
	} as any;

	const marker: PreservedUnresolvedEntry = {
		path,
		kind: "blob",
		reason: "remote-download-local-conflict",
		episodeId,
		firstSeenAt: 100,
		lastSeenAt: 200,
		localHash: options.markerLocalHash === undefined
			? localHash
			: options.markerLocalHash,
		knownRemoteHash: remoteHash,
		artifactPath,
		knownRemoteRefFingerprint: blobRefFingerprint(remoteRef),
		knownRemoteSourceVersion: remoteSourceVersion,
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
		() => true,
		settledRefs,
		undefined,
		settledSourceVersions,
		settlementStages as any,
		undefined,
		undefined,
		() => operationAuthorityCurrent,
	);
	(manager as any).uploadGateOpen = true;
	(manager as any).downloadGateOpen = true;
	(manager as any).kickUploadDrain = () => {};
	(manager as any).kickDownloadDrain = () => {};
	(manager as any).blobClient = {
		exists: async () => [],
		upload: async () => { uploadCalls++; },
		download: async (hash: string) => {
			downloadCalls++;
			assert.equal(hash, remoteHash);
			return remoteData;
		},
	};

	const original = files.get(path)!.file;
	const artifact = files.get(artifactPath)!.file;
	const identity: BlobDownloadConflictResolutionIdentity = {
		episodeId,
		expectedLocalHash: Object.prototype.hasOwnProperty.call(
			options,
			"expectedLocalHash",
		)
			? options.expectedLocalHash ?? null
			: localHash,
		expectedRemoteHash: remoteHash,
		expectedRemoteRef: { ...remoteRef },
		expectedRemoteSourceVersion: remoteSourceVersion,
		artifactPath,
		originalMtime: original.stat.mtime,
		originalSize: original.stat.size,
		artifactMtime: artifact.stat.mtime,
		artifactSize: artifact.stat.size,
	};

	return {
		path,
		artifactPath,
		remoteData,
		localHash,
		remoteHash,
		identity,
		app,
		files,
		trashedFiles,
		settledRefs,
		settledSourceVersions,
		settlementStages,
		manager,
		put,
		get remoteRef() { return remoteRef; },
		get remoteSourceVersion() { return remoteSourceVersion; },
		get setBlobRefCalls() { return setBlobRefCalls; },
		get uploadCalls() { return uploadCalls; },
		get downloadCalls() { return downloadCalls; },
		get markerChangedCalls() { return markerChangedCalls; },
		revokeOperationAuthority() {
			operationAuthorityCurrent = false;
		},
		setRemoteSourceVersion(value: string) {
			remoteSourceVersion = value;
		},
		setRemoteAuthority(ref: BlobRef, sourceVersion: string) {
			remoteRef = {
				...ref,
				...(ref.priorHashes ? { priorHashes: [...ref.priorHashes] } : {}),
			};
			remoteSourceVersion = sourceVersion;
			pathToBlob.set(path, remoteRef);
		},
	};
}

console.log("\n--- Explicit blob download-conflict resolution ---");

// Keep-local is a durable, explicit upload intent. The conflict remains
// visible while pending and is retired only after the restored queue commits.
{
	const source = await makeFixture();
	let persistedQueue: BlobQueueSnapshot | null = null;
	await source.manager.keepLocalDownloadConflict(
		source.path,
		source.identity,
		async (snapshot) => { persistedQueue = snapshot; },
	);
	assert.equal(
		source.manager.isKeepLocalDownloadConflictPending(
			source.path,
			source.identity.episodeId,
		),
		true,
		"Keep local is exposed as pending after durable queue admission",
	);
	assert.equal(
		source.manager.isPreservedUnresolved(source.path),
		true,
		"pending Keep local retains the conflict marker",
	);
	assert.equal(
		source.files.has(source.artifactPath),
		true,
		"pending Keep local retains the remote conflict copy",
	);
	assert.equal(
		persistedQueue?.uploads[0]?.attentionResolution?.kind,
		"keep-local-download-conflict",
		"the queue snapshot identifies the explicit Keep local choice",
	);

	const scope = {
		host: "https://worker.example",
		vaultId: "vault",
		localDeviceId: "device-a",
	};
	const durable = createPersistedBlobQueueSnapshot(persistedQueue!, scope);
	const restoredQueue = readPersistedBlobQueueSnapshot(durable, scope);
	assert.ok(restoredQueue, "the explicit conflict intent survives persisted queue validation");

	const restored = await makeFixture();
	restored.manager.importQueue(restoredQueue!);
	const restoredItem = (restored.manager as any).uploadQueue.get(restored.path);
	assert.equal(
		restoredItem?.attentionResolution?.kind,
		"keep-local-download-conflict",
		"restart restores the explicit Keep local intent",
	);
	await (restored.manager as any).processUpload(restoredItem);

	assert.equal(restored.uploadCalls, 1, "Keep local uploads the exact local bytes");
	assert.equal(restored.setBlobRefCalls, 1, "Keep local publishes one causal blob ref");
	assert.equal(restored.remoteRef.hash, restored.localHash);
	assert.deepEqual(
		getBlobRefPriorHashes(restored.remoteRef),
		[restored.remoteHash],
		"the local winner causally succeeds the reviewed remote ref",
	);
	assert.equal(
		restored.manager.isPreservedUnresolved(restored.path),
		false,
		"the marker clears only after the upload settlement commits",
	);
	assert.equal(restored.files.has(restored.artifactPath), false);
	assert.equal(restored.files.has(restored.path), true, "the local winner stays canonical");
	assert.equal(restored.settledRefs[restored.path]?.hash, restored.localHash);
	assert.equal(restored.markerChangedCalls, 1);
}

// Keep-local queue admission is not executable until the exact snapshot is
// durably persisted and authority has been revalidated. This closes the race
// with an upload drain that was already active for another path.
{
	const fixture = await makeFixture();
	const persistenceStarted = deferred<void>();
	const allowPersistence = deferred<void>();
	const resolution = fixture.manager.keepLocalDownloadConflict(
		fixture.path,
		fixture.identity,
		async () => {
			persistenceStarted.resolve();
			await allowPersistence.promise;
		},
	);
	await persistenceStarted.promise;
	const manager = fixture.manager as any;
	assert.ok(manager.uploadQueue.has(fixture.path));
	assert.equal(
		manager.nextPendingUpload(),
		null,
		"the explicit Keep-local item cannot enter an existing drain before persistence",
	);
	assert.equal(
		manager.attentionAcceptInFlight.has(fixture.path),
		true,
		"the path admission guard remains held across durable persistence",
	);
	allowPersistence.resolve();
	await resolution;
	assert.equal(manager.attentionAcceptInFlight.has(fixture.path), false);
	assert.equal(
		manager.nextPendingUpload(),
		manager.uploadQueue.get(fixture.path),
		"the persisted item becomes executable only after authority revalidation",
	);
}

// Use-remote swaps the reviewed artifact into the canonical path without a
// CRDT write and leaves the displaced local bytes in a visible safety copy.
{
	const fixture = await makeFixture();
	const result = await fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);

	assert.ok(result.safetyCopyPath, "Use remote returns the local safety-copy path");
	assert.equal(result.artifactRemoved, true);
	assert.equal(text(fixture.files.get(fixture.path)!.data), "remote attachment");
	assert.equal(
		text(fixture.files.get(result.safetyCopyPath!)!.data),
		"local attachment",
		"the displaced local bytes remain in the visible safety copy",
	);
	assert.match(result.safetyCopyPath!, /\(KAOS local backup /);
	assert.equal(fixture.files.has(fixture.artifactPath), false);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), false);
	assert.equal(fixture.setBlobRefCalls, 0, "Use remote does not rewrite remote authority");
	assert.equal(fixture.remoteRef.hash, fixture.remoteHash);
	assert.equal(fixture.settledRefs[fixture.path]?.hash, fixture.remoteHash);
	assert.equal(
		fixture.settledSourceVersions[fixture.path],
		fixture.remoteSourceVersion,
	);
	assert.equal(fixture.markerChangedCalls, 1);
}

// The quarantine-time local hash is diagnostic only. If the local candidate
// changed before the user opened the Dashboard, both explicit choices bind to
// the fresh exact file identity and bytes reviewed at click time.
for (const choice of ["keep-local", "use-remote"] as const) {
	const fixture = await makeFixture({
		markerLocalHash: "f".repeat(64),
		expectedLocalHash: null,
	});
	if (choice === "keep-local") {
		await fixture.manager.keepLocalDownloadConflict(
			fixture.path,
			fixture.identity,
		);
		const item = (fixture.manager as any).uploadQueue.get(fixture.path);
		await (fixture.manager as any).processUpload(item);
		assert.equal(fixture.remoteRef.hash, fixture.localHash);
	} else {
		await fixture.manager.acceptRemoteDownloadConflict(
			fixture.path,
			fixture.identity,
		);
		assert.equal(text(fixture.files.get(fixture.path)!.data), "remote attachment");
	}
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		`${choice} resolves against the freshly reviewed local candidate`,
	);
}

// A crash after the durable manual stage and local backup rename leaves the
// canonical path vacant. The same explicit Use-remote choice resumes from the
// stage instead of being reclassified as a generic missing attachment.
{
	const fixture = await makeFixture();
	fixture.settlementStages[fixture.path] = {
		stageId: "manual-stage-before-restart",
		kind: "manual-download-conflict",
		ref: { ...fixture.remoteRef },
		sourceVersion: fixture.remoteSourceVersion,
		stagedAt: Date.now(),
	};
	const original = fixture.files.get(fixture.path)!.file;
	const backupPath = "assets/conflict (KAOS local backup 2026-07-20T01-02-04Z 0123456789abcdef).png";
	await fixture.app.vault.rename(original, backupPath);
	const resumedIdentity = {
		...fixture.identity,
		originalMtime: null,
		originalSize: null,
	};
	assert.equal(
		fixture.manager.isUseRemoteDownloadConflictResumePending(
			fixture.path,
			fixture.identity.episodeId,
		),
		true,
	);
	await fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		resumedIdentity,
	);
	assert.equal(text(fixture.files.get(fixture.path)!.data), "remote attachment");
	assert.equal(text(fixture.files.get(backupPath)!.data), "local attachment");
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), false);
	assert.deepEqual(fixture.settlementStages, {});
}

// A persisted Keep-local intent can finish cleanup after a crash that happened
// after the CRDT ref and durable settlement committed but before marker cleanup.
{
	const fixture = await makeFixture();
	await fixture.manager.keepLocalDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	const item = (fixture.manager as any).uploadQueue.get(fixture.path);
	const committed = (fixture.manager as any).vaultSync.setBlobRef(
		fixture.path,
		fixture.localHash,
		fixture.files.get(fixture.path)!.file.stat.size,
		"image/png",
		undefined,
		{
			expectedCurrentRef: fixture.identity.expectedRemoteRef,
			causalBaseRef: fixture.identity.expectedRemoteRef,
			expectedCurrentSourceVersion: fixture.identity.expectedRemoteSourceVersion,
		},
	);
	fixture.settledRefs[fixture.path] = committed.ref;
	fixture.settledSourceVersions[fixture.path] = committed.sourceVersion;
	await (fixture.manager as any).processUpload(item);
	assert.equal(fixture.uploadCalls, 0, "cleanup recovery does not upload the selected bytes twice");
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), false);
	assert.equal(fixture.files.has(fixture.artifactPath), false);
}

// If the remote source episode changes while settlement persistence is
// awaited, the old choice cannot clean up its marker/artifact and the newest
// authoritative ref is explicitly rescheduled after the path lock releases.
{
	const fixture = await makeFixture();
	const finalizeStarted = deferred<void>();
	const allowFinalize = deferred<void>();
	(fixture.manager as any).settlementPersistence = {
		stage: async (path: string, stage: unknown) => {
			fixture.settlementStages[path] = stage;
		},
		finalize: async (
			path: string,
			_stageId: string,
			ref: BlobRef,
			sourceVersion: string,
		) => {
			fixture.settledRefs[path] = ref;
			fixture.settledSourceVersions[path] = sourceVersion;
			delete fixture.settlementStages[path];
			finalizeStarted.resolve();
			await allowFinalize.promise;
		},
		retire: async () => {},
		abort: async (path: string) => { delete fixture.settlementStages[path]; },
	};
	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await finalizeStarted.promise;
	fixture.setRemoteSourceVersion("1:8");
	allowFinalize.resolve();
	await assert.rejects(resolution, /settlement changed/);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(
		(fixture.manager as any).downloadQueue.get(fixture.path)?.hash,
		fixture.remoteHash,
		"the same-hash new source episode is queued for authoritative review",
	);
}

// Marker retirement is durably persisted before the selected-away artifact
// is trashed, so a crash can leave only a harmless orphan artifact—not an
// Attention marker pointing at bytes that have already disappeared.
{
	const fixture = await makeFixture();
	const persistenceStarted = deferred<void>();
	const allowPersistence = deferred<void>();
	(fixture.manager as any).persistPreservedUnresolvedChanged = async () => {
		persistenceStarted.resolve();
		await allowPersistence.promise;
	};
	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await persistenceStarted.promise;
	assert.equal(
		fixture.files.has(fixture.artifactPath),
		true,
		"the remote artifact remains until marker retirement is durable",
	);
	allowPersistence.resolve();
	await resolution;
	assert.equal(fixture.files.has(fixture.artifactPath), false);
}

// If marker persistence rejects after the Keep-local ref and settlement have
// committed, retain the explicit queue intent and retry cleanup. Restoring the
// stale marker in memory here would disable both dashboard choices because the
// authoritative ref has already advanced to the local winner.
{
	const fixture = await makeFixture();
	await fixture.manager.keepLocalDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	const manager = fixture.manager as any;
	const item = manager.uploadQueue.get(fixture.path);
	item.retries = 3;
	manager.scheduleRetryKick = () => {};
	let persistenceAttempts = 0;
	manager.persistPreservedUnresolvedChanged = async () => {
		persistenceAttempts++;
		if (persistenceAttempts === 1) throw new Error("simulated marker save failure");
	};

	await manager.processUpload(item);
	assert.equal(fixture.setBlobRefCalls, 1, "the local winner ref committed before marker persistence rejected");
	assert.equal(fixture.remoteRef.hash, fixture.localHash);
	assert.equal(
		fixture.manager.isPreservedUnresolved(fixture.path),
		false,
		"the stale in-memory marker is not restored after the irreversible commit",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true, "artifact cleanup waits for durable marker retirement");
	assert.equal(manager.uploadQueue.get(fixture.path), item, "cleanup intent remains queued across persistence failure");
	assert.equal(item.attentionResolution?.kind, "keep-local-download-conflict");

	item.readyAt = 0;
	item.status = "processing";
	await manager.processUpload(item);
	assert.equal(fixture.setBlobRefCalls, 1, "cleanup retry does not publish the winner twice");
	assert.equal(persistenceAttempts, 2, "cleanup retry persists the already-resolved marker state");
	assert.equal(fixture.files.has(fixture.artifactPath), false, "artifact is removed only after persistence recovers");
	assert.equal(manager.uploadQueue.has(fixture.path), false, "completed cleanup retires the explicit queue intent");
}

// A same-ref/new-source ABA episode invalidates an already-open review. No
// filesystem mutation is authorized until the dashboard is refreshed.
{
	const fixture = await makeFixture();
	fixture.setRemoteSourceVersion("1:8");
	await assert.rejects(
		fixture.manager.acceptRemoteDownloadConflict(
			fixture.path,
			fixture.identity,
		),
		/Remote attachment changed/,
	);
	assert.equal(text(fixture.files.get(fixture.path)!.data), "local attachment");
	assert.equal(text(fixture.files.get(fixture.artifactPath)!.data), "remote attachment");
	assert.equal(
		Array.from(fixture.files.keys()).some((candidate) =>
			candidate.includes("(KAOS local backup ")
		),
		false,
		"stale source authority creates no safety copy or canonical swap",
	);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
	assert.equal(fixture.setBlobRefCalls, 0);
	assert.deepEqual(fixture.settlementStages, {});
}

// A manager that loses its captured runtime authority while persisting a
// Keep-local queue must not report success or leave a stale in-memory intent.
{
	const fixture = await makeFixture();
	const persistenceStarted = deferred<void>();
	const allowPersistence = deferred<void>();
	const resolution = fixture.manager.keepLocalDownloadConflict(
		fixture.path,
		fixture.identity,
		async () => {
			persistenceStarted.resolve();
			await allowPersistence.promise;
		},
	);
	await persistenceStarted.promise;
	fixture.revokeOperationAuthority();
	allowPersistence.resolve();
	await assert.rejects(resolution, /authority changed/);
	assert.equal(
		(fixture.manager as any).uploadQueue.has(fixture.path),
		false,
		"stale Keep-local queue admission is fenced and removed",
	);
	assert.equal(text(fixture.files.get(fixture.path)!.data), "local attachment");
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
}

// Authority can disappear after the exact local file has moved to its visible
// safety copy but before the rename promise settles. Restore the local bytes to
// the canonical path and keep the durable conflict episode unresolved.
{
	const fixture = await makeFixture();
	const renameMoved = deferred<void>();
	const allowRename = deferred<void>();
	const originalRename = fixture.app.vault.rename;
	fixture.app.vault.rename = async (file: TFile, candidate: string) => {
		await originalRename(file, candidate);
		renameMoved.resolve();
		await allowRename.promise;
	};
	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await renameMoved.promise;
	fixture.revokeOperationAuthority();
	allowRename.resolve();
	await assert.rejects(resolution, /authority changed/);
	assert.equal(
		text(fixture.files.get(fixture.path)!.data),
		"local attachment",
		"authority loss after backup rename restores the local canonical file",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
	assert.equal(
		(fixture.settlementStages[fixture.path] as { kind?: string })?.kind,
		"manual-download-conflict",
		"the stale manager does not erase its durable unresolved stage",
	);
}

// If authority/stage ownership changes while createBinary is in flight, retire
// only the exact old-manager replica, restore local, and preserve the replacement
// stage owned by the new authority.
{
	const fixture = await makeFixture();
	const remoteCreated = deferred<void>();
	const allowCreate = deferred<void>();
	const originalCreateBinary = fixture.app.vault.createBinary;
	fixture.app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		const created = await originalCreateBinary(candidate, data);
		if (candidate === fixture.path) {
			remoteCreated.resolve();
			await allowCreate.promise;
		}
		return created;
	};
	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await remoteCreated.promise;
	fixture.revokeOperationAuthority();
	fixture.settlementStages[fixture.path] = {
		stageId: "replacement-manager-stage",
		kind: "manual-download-conflict",
		ref: { ...fixture.remoteRef },
		sourceVersion: fixture.remoteSourceVersion,
		stagedAt: Date.now(),
	};
	allowCreate.resolve();
	await assert.rejects(resolution, /authority changed/);
	assert.equal(text(fixture.files.get(fixture.path)!.data), "local attachment");
	assert.equal(
		(fixture.settlementStages[fixture.path] as { stageId?: string })?.stageId,
		"replacement-manager-stage",
		"compensation never deletes a replacement manager's stage",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
}

// Finalization persistence can commit its cache mutation and then discover that
// manager authority changed. Even in this ambiguous case, compensate the old
// filesystem write and preserve the local candidate plus review artifact.
{
	const fixture = await makeFixture();
	const finalizeMutated = deferred<void>();
	const allowFinalize = deferred<void>();
	(fixture.manager as any).settlementPersistence = {
		stage: async (path: string, stage: unknown) => {
			fixture.settlementStages[path] = stage;
		},
		finalize: async (
			path: string,
			_stageId: string,
			ref: BlobRef,
			sourceVersion: string,
		) => {
			fixture.settledRefs[path] = ref;
			fixture.settledSourceVersions[path] = sourceVersion;
			delete fixture.settlementStages[path];
			finalizeMutated.resolve();
			await allowFinalize.promise;
			throw new Error("Attachment manager authority changed");
		},
		retire: async () => {},
		abort: async () => {},
	};
	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await finalizeMutated.promise;
	fixture.revokeOperationAuthority();
	allowFinalize.resolve();
	await assert.rejects(resolution, /authority changed/);
	assert.equal(
		text(fixture.files.get(fixture.path)!.data),
		"local attachment",
		"ambiguous finalization never leaves the stale remote bytes canonical",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
}

// A transient storage read failure while retiring the exact stale remote must
// not strand those bytes at the canonical path. The still-durable manual stage
// owns a bounded compensation retry under the original active transfer.
{
	const fixture = await makeFixture();
	const remoteCreated = deferred<void>();
	const allowCreateToSettle = deferred<void>();
	const originalCreateBinary = fixture.app.vault.createBinary;
	const originalReadBinary = fixture.app.vault.readBinary;
	let canonicalCreateCalls = 0;
	let compensationReadFailures = 0;
	let remoteMaterialized = false;
	const retryDelays: number[] = [];
	(fixture.manager as any).waitForAuthorityLossCompensationRetry = async (
		delayMs: number,
	) => { retryDelays.push(delayMs); };
	fixture.app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		const created = await originalCreateBinary(candidate, data);
		if (candidate === fixture.path && ++canonicalCreateCalls === 1) {
			remoteMaterialized = true;
			remoteCreated.resolve();
			await allowCreateToSettle.promise;
		}
		return created;
	};
	fixture.app.vault.readBinary = async (file: TFile) => {
		if (
			remoteMaterialized
			&& file === fixture.files.get(fixture.path)?.file
			&& compensationReadFailures === 0
		) {
			compensationReadFailures++;
			throw new Error("simulated transient compensation read failure");
		}
		return originalReadBinary(file);
	};

	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await remoteCreated.promise;
	fixture.revokeOperationAuthority();
	allowCreateToSettle.resolve();
	await assert.rejects(resolution, /authority changed/);

	assert.equal(compensationReadFailures, 1, "the exact stale remote read fails once");
	assert.deepEqual(retryDelays, [250], "authority-loss compensation retries automatically");
	assert.equal(
		text(fixture.files.get(fixture.path)!.data),
		"local attachment",
		"the retry retires stale remote bytes and restores the local canonical copy",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
	assert.equal(
		(fixture.settlementStages[fixture.path] as { kind?: string })?.kind,
		"manual-download-conflict",
		"the durable stage remains for the replacement manager",
	);
}

// A transient create failure while restoring the preserved local bytes is also
// retried. The visible backup remains the source, and every attempt uses the
// create-only/no-clobber path.
{
	const fixture = await makeFixture();
	const remoteCreated = deferred<void>();
	const allowCreateToSettle = deferred<void>();
	const originalCreateBinary = fixture.app.vault.createBinary;
	let canonicalCreateCalls = 0;
	let compensationCreateFailures = 0;
	const retryDelays: number[] = [];
	(fixture.manager as any).waitForAuthorityLossCompensationRetry = async (
		delayMs: number,
	) => { retryDelays.push(delayMs); };
	fixture.app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		if (candidate !== fixture.path) return originalCreateBinary(candidate, data);
		const call = ++canonicalCreateCalls;
		if (call === 2) {
			compensationCreateFailures++;
			throw new Error("simulated transient compensation create failure");
		}
		const created = await originalCreateBinary(candidate, data);
		if (call === 1) {
			remoteCreated.resolve();
			await allowCreateToSettle.promise;
		}
		return created;
	};

	const resolution = fixture.manager.acceptRemoteDownloadConflict(
		fixture.path,
		fixture.identity,
	);
	await remoteCreated.promise;
	fixture.revokeOperationAuthority();
	allowCreateToSettle.resolve();
	await assert.rejects(resolution, /authority changed/);

	assert.equal(compensationCreateFailures, 1, "the local restore create fails once");
	assert.equal(canonicalCreateCalls, 3, "the local canonical create is retried once");
	assert.deepEqual(retryDelays, [250], "restore failure enters bounded compensation retry");
	assert.equal(
		text(fixture.files.get(fixture.path)!.data),
		"local attachment",
		"the retry restores the preserved local bytes without clobbering",
	);
	assert.equal(fixture.files.has(fixture.artifactPath), true);
	assert.equal(fixture.manager.isPreservedUnresolved(fixture.path), true);
	assert.equal(
		(fixture.settlementStages[fixture.path] as { kind?: string })?.kind,
		"manual-download-conflict",
		"the unresolved stage remains durable across compensation retry",
	);
}

console.log("Explicit blob conflict-resolution tests passed.");
