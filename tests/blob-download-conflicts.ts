import { TFile } from "obsidian";
import { BlobSyncManager, type BlobQueueSnapshot } from "../src/sync/blobSync";
import { AttachmentOrchestrator } from "../src/runtime/attachmentOrchestrator";
import {
	createCausalBlobRef,
	getBlobRefPriorHashes,
	type BlobRef,
} from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function bytes(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function text(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(buffer);
}

function normalizedHashes(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((hash): hash is string => typeof hash === "string"))]
		.sort();
}

function hasExactlyHashes(value: unknown, expected: string[]): boolean {
	const actual = normalizedHashes(value);
	const normalizedExpected = [...new Set(expected)].sort();
	return actual.length === normalizedExpected.length
		&& actual.every((hash, index) => hash === normalizedExpected[index]);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
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

function makeHarness(
	isBlobPathSyncable: (path: string) => boolean = () => true,
	settledRefs: Record<string, BlobRef> = {},
) {
	let clock = 1;
	let sourceClock = 1;
	let modifyCalls = 0;
	const files = new Map<string, StoredFile>();
	const trashedFiles = new Map<string, StoredFile>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	const sourceVersionByRef = new WeakMap<object, string>();
	const settledSourceVersions: Record<string, string> = {};
	for (const [path, ref] of Object.entries(settledRefs)) {
		const sourceVersion = `1:${sourceClock++}`;
		sourceVersionByRef.set(ref, sourceVersion);
		settledSourceVersions[path] = sourceVersion;
	}
	const defaultBlobRefs = new Map<string, BlobRef>(Object.entries(settledRefs));

	const decorateVaultSync = (candidate: any): any => {
		const vaultSync = candidate ?? {};
		if (typeof vaultSync.getBlobSourceVersion !== "function") {
			vaultSync.getBlobSourceVersion = (path: string) => {
				const ref = typeof vaultSync.getBlobRef === "function"
					? vaultSync.getBlobRef(path)
					: vaultSync.pathToBlob?.get?.(path);
				if (!ref || vaultSync.isBlobTombstoned?.(path)) return undefined;
				let sourceVersion = sourceVersionByRef.get(ref);
				if (!sourceVersion) {
					sourceVersion = `1:${sourceClock++}`;
					sourceVersionByRef.set(ref, sourceVersion);
				}
				return sourceVersion;
			};
		}
		return vaultSync;
	};
	const defaultVaultSync = decorateVaultSync({
		getBlobRef: (path: string) => defaultBlobRefs.get(path),
		isBlobTombstoned: () => false,
		pathToBlob: defaultBlobRefs,
	});

	function put(path: string, data: ArrayBuffer): StoredFile {
		const existing = files.get(path);
		const file = existing?.file ?? (new TFile() as TFile & {
			path: string;
			stat: { mtime: number; size: number };
		});
		file.path = path;
		file.stat = { mtime: clock++, size: data.byteLength };
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	}

	function replace(path: string, data: ArrayBuffer): StoredFile {
		const file = new TFile() as TFile & {
			path: string;
			stat: { mtime: number; size: number };
		};
		file.path = path;
		file.stat = { mtime: clock++, size: data.byteLength };
		const stored = { file, data };
		files.set(path, stored);
		return stored;
	}

	const app = {
		vault: {
			getFiles: () => Array.from(files.values(), ({ file }) => file),
			getAbstractFileByPath: (path: string) => files.get(path)?.file ?? null,
			readBinary: async (file: TFile & { path: string }) => {
				const stored = files.get(file.path);
				if (!stored) throw new Error("missing file");
				return stored.data;
			},
			modifyBinary: async (file: TFile & { path: string }, data: ArrayBuffer) => {
				modifyCalls++;
				put(file.path, data);
			},
			createBinary: async (path: string, data: ArrayBuffer) => {
				if (files.has(path)) {
					const error = new Error("exists") as Error & { code?: string };
					error.code = "EEXIST";
					throw error;
				}
				return put(path, data).file;
			},
			rename: async (file: TFile & { path: string }, newPath: string) => {
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
			trash: async (file: TFile & { path: string }) => {
				const oldPath = file.path;
				const stored = files.get(oldPath);
				if (!stored || stored.file !== file) throw new Error("missing source");
				files.delete(oldPath);
				const trashPath = `.trash/${oldPath}`;
				file.path = trashPath;
				trashedFiles.set(trashPath, stored);
			},
			createFolder: async () => {},
			adapter: {
				stat: async (path: string) => files.get(path)?.file.stat ?? null,
			},
			configDir: ".obsidian",
		},
	} as any;

	const manager = new BlobSyncManager(
		app,
		defaultVaultSync as any,
		{
			host: "https://worker.example",
			token: "token",
			vaultId: "vault",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
		(source, msg, details) => traces.push({ source, msg, details }),
		[],
		undefined,
		isBlobPathSyncable,
		settledRefs,
		undefined,
		settledSourceVersions,
	);
	let activeVaultSync = defaultVaultSync;
	Object.defineProperty(manager as any, "vaultSync", {
		configurable: true,
		get: () => activeVaultSync,
		set: (next) => { activeVaultSync = decorateVaultSync(next); },
	});
	(manager as any).__defaultBlobRefs = defaultBlobRefs;
	// This fixture represents a manager whose startup authority gate is open.
	// Dedicated startup-gate regressions intentionally construct a closed one.
	(manager as any).uploadGateOpen = true;
	(manager as any).downloadGateOpen = true;

	return {
		app,
		manager,
		files,
		trashedFiles,
		put,
		replace,
		traces,
		getModifyCalls: () => modifyCalls,
	};
}

async function runDownload(
	manager: BlobSyncManager,
	path: string,
	data: ArrayBuffer,
	onDownload?: () => void,
	acceptableLocalHashes?: string | string[],
): Promise<string> {
	const hash = await sha256Hex(data);
	const defaultBlobRefs = (manager as any).__defaultBlobRefs as
		| Map<string, BlobRef>
		| undefined;
	if (defaultBlobRefs && (manager as any).vaultSync.pathToBlob === defaultBlobRefs) {
		const priorHashes = normalizedHashes(acceptableLocalHashes);
		defaultBlobRefs.set(path, priorHashes.length > 0
			? { hash, size: data.byteLength, priorHashes }
			: { hash, size: data.byteLength });
	}
	(manager as any).blobClient = {
		download: async () => {
			onDownload?.();
			return data;
		},
	};
	(manager as any).enqueueDownload(
		path,
		hash,
		data.byteLength,
		0,
		normalizedHashes(acceptableLocalHashes),
	);
	const item = (manager as any).downloadQueue.get(path);
	item.status = "processing";
	await (manager as any).processDownload(item);
	return hash;
}

async function runQueuedDownloadAttempt(
	manager: BlobSyncManager,
	path: string,
): Promise<void> {
	const item = (manager as any).downloadQueue.get(path);
	if (!item) throw new Error(`No queued download for "${path}"`);
	item.readyAt = 0;
	item.status = "processing";
	await (manager as any).processDownload(item);
}

function findVisibleLocalBackupPath(
	files: Map<string, StoredFile>,
	targetPath?: string,
): string | undefined {
	const targetName = targetPath?.split("/").pop()?.replace(/\.[^/.]+$/, "");
	return Array.from(files.keys()).find((candidate) => {
		if (!candidate.includes("(KAOS local backup ")) return false;
		if (targetName && !candidate.split("/").pop()?.startsWith(`${targetName} (`)) {
			return false;
		}
		return / \(KAOS local backup \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z [0-9a-f]{16}\)(?:\.[^/.]+)?$/.test(candidate);
	});
}

function installRemoteDeleteAuthority(
	manager: BlobSyncManager,
	path: string,
	deletedRef: BlobRef | undefined,
	fingerprint = `delete:${path}:${deletedRef?.hash ?? "legacy"}`,
): void {
	(manager as any).vaultSync = {
		getAuthoritativeBlobDeleteSnapshot: (candidate: string) =>
			candidate === path ? { fingerprint, deletedRef } : null,
		getBlobRef: () => undefined,
		isBlobTombstoned: (candidate: string) => candidate === path,
		pathToBlob: new Map(),
		blobTombstones: new Map([[path, true]]),
	};
}

console.log("\n--- Test 1: a local edit during download defers the old disk epoch and then converges ---");
{
	const { manager, files, put, traces, getModifyCalls } = makeHarness();
	const localOld = bytes("local-old");
	const localOldHash = await sha256Hex(localOld);
	put("img.png", localOld);
	let changed = false;
	await runDownload(manager, "img.png", bytes("remote"), () => {
		if (!changed) {
			changed = true;
			put("img.png", bytes("local-new"));
		}
	}, localOldHash);

	assert(text(files.get("img.png")!.data) === "local-new", "the first attempt never overwrites a changed local epoch");
	assert((manager as any).downloadQueue.get("img.png")?.status === "pending", "the changed epoch remains queued for retry");
	assert(
		traces.some((event) => event.msg === "authoritative-remote-retry"),
		"the exact local-epoch retry is traced",
	);

	await runQueuedDownloadAttempt(manager, "img.png");
	const backup = findVisibleLocalBackupPath(files, "img.png");
	assert(text(files.get("img.png")!.data) === "remote", "a fresh attempt installs the authoritative remote bytes");
	assert(backup ? text(files.get(backup)!.data) === "local-new" : false, "the exact local edit remains in a safety backup");
	assert(!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")), "no remote conflict artifact is created");
	assert(getModifyCalls() === 0, "hash-to-commit local edit race never reaches modifyBinary");
	assert(!manager.isPreservedUnresolved("img.png"), "automatic convergence creates no durable Attention marker");
}

console.log("\n--- Test 1b: same-bytes TFile ABA retries before authoritative replacement ---");
{
	const { app, manager, files, put, replace, getModifyCalls } = makeHarness();
	const local = bytes("same local bytes");
	const localHash = await sha256Hex(local);
	put("img.png", local);
	const originalReadBinary = app.vault.readBinary;
	let replaced = false;
	app.vault.readBinary = async (file: TFile & { path: string }) => {
		const data = await originalReadBinary(file);
		if (file.path === "img.png" && !replaced) {
			replaced = true;
			replace("img.png", local);
		}
		return data;
	};

	await runDownload(
		manager,
		"img.png",
		bytes("remote candidate"),
		undefined,
		localHash,
	);

	assert(replaced, "test replaces the target TFile while its original bytes are hashed");
	assert(text(files.get("img.png")!.data) === "same local bytes", "the ABA replacement remains untouched in the stale attempt");
	assert((manager as any).downloadQueue.get("img.png")?.status === "pending", "identity ABA is retried with a fresh disk epoch");
	await runQueuedDownloadAttempt(manager, "img.png");
	const backup = findVisibleLocalBackupPath(files, "img.png");
	assert(text(files.get("img.png")!.data) === "remote candidate", "the fresh attempt installs the authoritative remote bytes");
	assert(backup ? text(files.get(backup)!.data) === "same local bytes" : false, "the ABA local bytes remain in a safety backup");
	assert(!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")), "identity ABA creates no conflict artifact");
	assert(getModifyCalls() === 0, "same-bytes TFile ABA never reaches modifyBinary");
	assert(!manager.isPreservedUnresolved("img.png"), "identity ABA creates no Attention marker");
}

console.log("\n--- Test 2: stable differing attachment yields to the authoritative remote ref ---");
{
	const { manager, files, put, traces, getModifyCalls } = makeHarness();
	put("img.png", bytes("local-old"));
	await runDownload(manager, "img.png", bytes("remote"));

	const backup = findVisibleLocalBackupPath(files, "img.png");
	assert(text(files.get("img.png")!.data) === "remote", "stable divergence installs the authoritative remote bytes");
	assert(backup ? text(files.get(backup)!.data) === "local-old" : false, "the independent local bytes remain in a safety backup");
	assert(!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")), "stable divergence creates no remote conflict artifact");
	assert(getModifyCalls() === 0, "existing-file download never calls modifyBinary");
	assert(!manager.isPreservedUnresolved("img.png"), "stable divergence creates no durable Attention marker");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "authoritative-remote-wins"
		),
		"the authoritative remote decision is traced",
	);
	const debug = manager.getDebugSnapshot();
	assert(debug.blobConflictArtifacts === 0, "automatic remote resolution does not increment true conflicts");
	assert(debug.blobSafetyBackups === 1, "automatic remote resolution records one safety backup");
}

console.log("\n--- Test 2b: exact existing remote hash settles without a write ---");
{
	const { manager, files, put, getModifyCalls } = makeHarness();
	const remote = bytes("already remote");
	let downloads = 0;
	put("img.png", remote);
	await runDownload(manager, "img.png", remote, () => { downloads++; });

	assert(downloads === 0, "exact existing bytes settle before a redundant network download");
	assert(getModifyCalls() === 0, "exact existing bytes require no modifyBinary call");
	assert(
		!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")),
		"exact equality creates no conflict artifact",
	);
	assert(!manager.isPreservedUnresolved("img.png"), "exact equality creates no Attention marker");
}

console.log("\n--- Test 2c: repeated remote candidate settles without duplicate backups ---");
{
	const { manager, files, put } = makeHarness();
	put("img.png", bytes("local stays"));
	const remote = bytes("same remote candidate");
	await runDownload(manager, "img.png", remote);
	await runDownload(manager, "img.png", remote);

	const conflicts = Array.from(files.keys()).filter((path) => path.includes("KAOS remote conflict"));
	assert(conflicts.length === 0, "identical repeated remote bytes create no conflict artifact");
	assert(text(files.get("img.png")!.data) === "same remote candidate", "the authoritative remote remains canonical");
	assert(findVisibleLocalBackupPath(files, "img.png") !== undefined, "the original local candidate has one visible backup");
	assert(manager.getDebugSnapshot().blobSafetyBackups === 1, "the equality rerun creates no duplicate safety backup");
	assert(!manager.isPreservedUnresolved("img.png"), "repeated settlement creates no Attention condition");
}

console.log("\n--- Test 2c.1: hash-equal upload reconciliation completes progress ---");
{
	const path = "already-settled.png";
	const data = bytes("already settled bytes");
	const hash = await sha256Hex(data);
	const ref: BlobRef = { hash, size: data.byteLength };
	const { manager, put } = makeHarness(undefined, { [path]: ref });
	put(path, data);
	(manager as any)._completedUploads = 0;
	(manager as any)._totalUploadsThisCycle = 1;
	(manager as any).enqueueUpload(path, 0, data.byteLength);
	const item = (manager as any).uploadQueue.get(path);
	item.status = "processing";

	await (manager as any).processUpload(item);

	assert(manager.pendingUploads === 0, "hash-equal upload leaves no queued work");
	assert(manager.transferStatus === null, "hash-equal upload advances progress to an idle state");
	(manager as any)._completedUploads = 68;
	(manager as any)._totalUploadsThisCycle = 94;
	assert(
		manager.transferStatus === null,
		"an idle queue never displays a stale partial cycle after terminal skips",
	);
	await manager.destroy();
}

console.log("\n--- Test 2c.2: a marker without a materialized artifact cannot block repair ---");
{
	const path = "missing-conflict-artifact.png";
	const local = bytes("local candidate");
	const remote = bytes("remote candidate");
	const localHash = await sha256Hex(local);
	const remoteHash = await sha256Hex(remote);
	const { manager, put } = makeHarness();
	put(path, local);
	const refs = (manager as any).__defaultBlobRefs as Map<string, BlobRef>;
	refs.set(path, { hash: remoteHash, size: remote.byteLength });
	(manager as any).quarantineDownloadConflict(path, localHash, remoteHash, null);
	(manager as any).downloadGateOpen = false;
	const scheduled = (manager as any).scheduleDownload(
		path,
		remoteHash,
		remote.byteLength,
	);
	assert(scheduled === true, "an artifact-less marker allows the authoritative candidate to be materialized again");
	assert((manager as any).downloadQueue.has(path), "repair remains queued instead of leaving Attention without a choice");
}

console.log("\n--- Test 2d: exact prior-ref provenance admits a clean H1 -> H2 update ---");
{
	const path = "proven-clean.png";
	const h1 = bytes("clean H1");
	const h2 = bytes("remote H2");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const { manager, files, put, getModifyCalls } = makeHarness(
		undefined,
		{ [path]: h1Ref },
	);
	put(path, h1);
	(manager as any).vaultSync = {
		getBlobRef: () => h2Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h2Ref]]),
	};

	await runDownload(manager, path, h2, undefined, getBlobRefPriorHashes(h2Ref));

	assert(text(files.get(path)!.data) === "remote H2", "the exact proven H1 replica advances to H2");
	assert(getModifyCalls() === 0, "a clean provenance-backed update never clobbers with modifyBinary");
	assert(
		!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")),
		"a clean provenance-backed update creates no conflict artifact",
	);
	assert(!manager.isPreservedUnresolved(path), "a clean provenance-backed update creates no Attention marker");
	const debug = manager.getDebugSnapshot();
	assert(debug.blobConflictArtifacts === 0, "a clean remote advance does not increment the true conflict count");
	assert(debug.blobSafetyBackups === 1, "a clean remote advance records one rollback safety copy");
}

console.log("\n--- Test 2e: a different local hash uses authoritative-remote policy ---");
{
	const path = "provenance-mismatch.png";
	const h1 = bytes("expected H1");
	const h1Hash = await sha256Hex(h1);
	const local = bytes("independent local edit");
	const h2 = bytes("remote H2");
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const { manager, files, put, getModifyCalls } = makeHarness(
		undefined,
		{ [path]: h1Ref },
	);
	put(path, local);
	(manager as any).vaultSync = {
		getBlobRef: () => h2Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h2Ref]]),
	};

	await runDownload(manager, path, h2, undefined, getBlobRefPriorHashes(h2Ref));

	const backup = findVisibleLocalBackupPath(files, path);
	assert(text(files.get(path)!.data) === "remote H2", "the live remote ref becomes canonical despite unrelated local provenance");
	assert(backup ? text(files.get(backup)!.data) === "independent local edit" : false, "the independent local edit remains in a safety backup");
	assert(!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")), "no remote conflict artifact is created");
	assert(getModifyCalls() === 0, "provenance mismatch never reaches modifyBinary");
	assert(!manager.isPreservedUnresolved(path), "provenance mismatch is automatically settled");
	const debug = manager.getDebugSnapshot();
	assert(debug.blobConflictArtifacts === 0, "authoritative remote convergence increments no true conflicts");
	assert(debug.blobSafetyBackups === 1, "authoritative remote convergence records one safety copy");
}

console.log("\n--- Test 2f: H1 -> H2 -> H3 supersede accepts either contiguous disk state ---");
{
	const h1 = bytes("chain H1");
	const h2 = bytes("chain H2");
	const h3 = bytes("chain H3");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h3Hash = await sha256Hex(h3);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const h3Ref = createCausalBlobRef(h3Hash, h3.byteLength, h2Ref);

	for (const diskState of [
		{ label: "H1 not yet advanced", data: h1, settledRef: h1Ref },
		{ label: "H2 already advanced", data: h2, settledRef: h2Ref },
	]) {
		const path = `contiguous-${diskState.label.startsWith("H1") ? "h1" : "h2"}.png`;
		const { manager, files, put, getModifyCalls } = makeHarness(
			undefined,
			{ [path]: diskState.settledRef },
		);
		put(path, diskState.data);
		let currentRef: BlobRef = h2Ref;
		(manager as any).vaultSync = {
			getBlobRef: () => currentRef,
			isBlobTombstoned: () => false,
			pathToBlob: new Map([[path, h3Ref]]),
		};
		(manager as any).kickDownloadDrain = () => {};
		(manager as any).enqueueDownload(
			path,
			h2Hash,
			h2.byteLength,
			0,
			getBlobRefPriorHashes(h2Ref),
		);
		const item: any = (manager as any).downloadQueue.get(path);
		item.status = "processing";

		// The H3 ref is self-contained: it carries both H2 and H1 even when the H2
		// transfer is superseded before this device settles it to disk.
		currentRef = h3Ref;
		(manager as any).enqueueDownload(
			path,
			h3Hash,
			h3.byteLength,
			0,
			getBlobRefPriorHashes(h3Ref),
		);
		assert(item.nextHash === h3Hash, `${diskState.label}: H3 becomes the immutable rerun target`);
		assert(
			hasExactlyHashes(item.nextAcceptableLocalHashes, [h1Hash, h2Hash]),
			`${diskState.label}: supersede carries both contiguous H1 and H2 provenance`,
		);

		(manager as any).prepareDownloadRerun(item);
		assert(
			hasExactlyHashes(item.acceptableLocalHashes, [h1Hash, h2Hash]),
			`${diskState.label}: rerun promotes the complete provenance set`,
		);
		(manager as any).blobClient = { download: async () => h3 };
		item.status = "processing";
		await (manager as any).processDownload(item);

		assert(text(files.get(path)!.data) === "chain H3", `${diskState.label}: clean contiguous state advances to H3`);
		assert(getModifyCalls() === 0, `${diskState.label}: H3 never clobbers with modifyBinary`);
		assert(
			!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")),
			`${diskState.label}: contiguous provenance creates no conflict artifact`,
		);
	}
}

console.log("\n--- Test 2g: discontinuous provenance still converges to the live remote ref ---");
{
	const path = "broken-lineage.png";
	const h1 = bytes("lineage H1");
	const h2 = bytes("lineage H2");
	const h3 = bytes("lineage H3");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h3Hash = await sha256Hex(h3);
	const unrelatedHash = await sha256Hex(bytes("unrelated predecessor"));
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const brokenH3Ref: BlobRef = {
		hash: h3Hash,
		size: h3.byteLength,
		priorHashes: [unrelatedHash],
	};
	const { manager, files, put, getModifyCalls } = makeHarness(
		undefined,
		{ [path]: h1Ref },
	);
	put(path, h1);
	let currentRef: BlobRef = h2Ref;
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, brokenH3Ref]]),
	};
	(manager as any).kickDownloadDrain = () => {};
	(manager as any).enqueueDownload(
		path,
		h2Hash,
		h2.byteLength,
		0,
		getBlobRefPriorHashes(h2Ref),
	);
	const item: any = (manager as any).downloadQueue.get(path);
	item.status = "processing";

	currentRef = brokenH3Ref;
	(manager as any).enqueueDownload(
		path,
		h3Hash,
		h3.byteLength,
		0,
		getBlobRefPriorHashes(brokenH3Ref),
	);
	assert(
		!normalizedHashes(item.nextAcceptableLocalHashes).includes(h1Hash)
			&& !normalizedHashes(item.nextAcceptableLocalHashes).includes(h2Hash),
		"a non-H2 predecessor does not carry the trusted H1 -> H2 chain into H3",
	);
	(manager as any).prepareDownloadRerun(item);
	assert(
		!normalizedHashes(item.acceptableLocalHashes).includes(h1Hash)
			&& !normalizedHashes(item.acceptableLocalHashes).includes(h2Hash),
		"the discontinuous rerun promotes no stale trusted predecessor",
	);
	(manager as any).blobClient = { download: async () => h3 };
	item.status = "processing";
	await (manager as any).processDownload(item);

	const backup = findVisibleLocalBackupPath(files, path);
	assert(text(files.get(path)!.data) === "lineage H3", "discontinuous lineage does not override live remote authority");
	assert(getModifyCalls() === 0, "discontinuous lineage never reaches modifyBinary");
	assert(!manager.isPreservedUnresolved(path), "discontinuous lineage creates no durable Attention");
	assert(backup ? text(files.get(backup)!.data) === "lineage H1" : false, "the local H1 candidate remains in a safety backup");
	assert(!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")), "no remote conflict artifact is emitted");
}

console.log("\n--- Test 2h: queue export/import preserves effective provenance ---");
{
	const path = "persisted-lineage.png";
	const h1 = bytes("persist H1");
	const h2 = bytes("persist H2");
	const h3 = bytes("persist H3");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h3Hash = await sha256Hex(h3);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const h3Ref = createCausalBlobRef(h3Hash, h3.byteLength, h2Ref);
	let currentRef: BlobRef = h2Ref;
	const { manager } = makeHarness(undefined, { [path]: h1Ref });
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h3Ref]]),
	};
	(manager as any).kickDownloadDrain = () => {};
	(manager as any).enqueueDownload(
		path,
		h2Hash,
		h2.byteLength,
		0,
		getBlobRefPriorHashes(h2Ref),
	);
	const queued: any = (manager as any).downloadQueue.get(path);
	queued.status = "processing";
	currentRef = h3Ref;
	(manager as any).enqueueDownload(
		path,
		h3Hash,
		h3.byteLength,
		0,
		getBlobRefPriorHashes(h3Ref),
	);

	const exported: any = (manager as any).exportQueue();
	const persisted = exported.downloads.find((entry: any) => entry.path === path);
	assert(persisted?.hash === h3Hash, "queue export persists the latest H3 target");
	assert(
		hasExactlyHashes(persisted?.acceptableLocalHashes, [h1Hash, h2Hash]),
		"queue export persists both effective contiguous predecessor hashes",
	);

	const { manager: restoredManager } = makeHarness(undefined, { [path]: h1Ref });
	(restoredManager as any).vaultSync = {
		getBlobRef: () => h3Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h3Ref]]),
	};
	restoredManager.closeDownloadGate("inspect-imported-queue");
	(restoredManager as any).importQueue(exported);
	const restored: any = (restoredManager as any).downloadQueue.get(path);
	assert(restored?.hash === h3Hash && restored?.status === "pending", "queue import restores H3 as pending");
	assert(
		hasExactlyHashes(restored?.acceptableLocalHashes, [h1Hash, h2Hash]),
		"queue import restores the exact effective provenance set",
	);

	const unrelatedHash = await sha256Hex(bytes("persisted unrelated"));
	const intersectionPath = "persisted-intersection.png";
	const { manager: intersectionManager } = makeHarness();
	(intersectionManager as any).vaultSync = {
		getBlobRef: () => h3Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[intersectionPath, h3Ref]]),
	};
	intersectionManager.closeDownloadGate("inspect-imported-intersection");
	(intersectionManager as any).importQueue({
		uploads: [],
		downloads: [{
			path: intersectionPath,
			hash: h3Hash,
			sizeBytes: h3.byteLength,
			acceptableLocalHashes: [h1Hash, unrelatedHash],
		}],
	});
	const intersected: any = (intersectionManager as any).downloadQueue.get(intersectionPath);
	assert(
		hasExactlyHashes(intersected?.acceptableLocalHashes, [h1Hash]),
		"queue import intersects persisted authority with the current ref lineage",
	);
}

console.log("\n--- Test 2i: causal refs retain sequential history without merging offline forks ---");
{
	const h1Hash = await sha256Hex(bytes("causal H1"));
	const h2Hash = await sha256Hex(bytes("causal H2"));
	const h3Hash = await sha256Hex(bytes("causal H3"));
	const haHash = await sha256Hex(bytes("offline fork A"));
	const hbHash = await sha256Hex(bytes("offline fork B"));
	const h1Ref: BlobRef = { hash: h1Hash, size: 1 };
	const h2Ref = createCausalBlobRef(h2Hash, 2, h1Ref);
	const h3Ref = createCausalBlobRef(h3Hash, 3, h2Ref);
	const haRef = createCausalBlobRef(haHash, 4, h1Ref);
	const hbRef = createCausalBlobRef(hbHash, 5, h1Ref);

	assert(hasExactlyHashes(getBlobRefPriorHashes(h2Ref), [h1Hash]), "H2 carries H1 as its causal predecessor");
	assert(
		hasExactlyHashes(getBlobRefPriorHashes(h3Ref), [h2Hash, h1Hash]),
		"H3 carries the complete bounded H2 -> H1 sequence",
	);
	assert(
		getBlobRefPriorHashes(haRef).includes(h1Hash)
			&& !getBlobRefPriorHashes(haRef).includes(hbHash),
		"offline fork A contains its base but never invents fork B",
	);
	assert(
		getBlobRefPriorHashes(hbRef).includes(h1Hash)
			&& !getBlobRefPriorHashes(hbRef).includes(haHash),
		"offline fork B contains its base but never invents fork A",
	);
}

console.log("\n--- Test 2j: same target hash with changed lineage rejects the stale download commit ---");
{
	const path = "same-hash-new-lineage.png";
	const h1 = bytes("same-hash H1");
	const h2 = bytes("same-hash H2");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const forkHash = await sha256Hex(bytes("new causal fork"));
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const originalTarget = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const replacementTarget: BlobRef = {
		hash: h2Hash,
		size: h2.byteLength,
		priorHashes: [forkHash],
	};
	const { manager, files, put, getModifyCalls } = makeHarness(
		undefined,
		{ [path]: h1Ref },
	);
	put(path, h1);
	let currentRef = originalTarget;
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, replacementTarget]]),
	};

	await runDownload(
		manager,
		path,
		h2,
		() => { currentRef = replacementTarget; },
		getBlobRefPriorHashes(originalTarget),
	);

	assert(text(files.get(path)!.data) === "same-hash H1", "changed same-hash lineage leaves the local target untouched");
	assert(getModifyCalls() === 0, "changed same-hash lineage rejects the stale target write");
	assert(
		!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")),
		"a superseded same-hash attempt retires without publishing a stale artifact",
	);
}

console.log("\n--- Test 2k: malformed lineage grants no causal trust but remote authority still converges ---");
{
	const h1 = bytes("bounded H1");
	const h2 = bytes("bounded H2");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const oversized = [h1Hash];
	for (let index = 0; index < 16; index++) {
		oversized.push(await sha256Hex(bytes(`excess lineage ${index}`)));
	}

	for (const variant of [
		{ label: "malformed", priorHashes: ["not-a-sha256-hash"] },
		{ label: "17-entry", priorHashes: oversized },
	]) {
		const path = `fail-closed-${variant.label}.png`;
		const targetRef: BlobRef = {
			hash: h2Hash,
			size: h2.byteLength,
			priorHashes: variant.priorHashes,
		};
		const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
		const { manager, files, put, getModifyCalls } = makeHarness(
			undefined,
			{ [path]: h1Ref },
		);
		put(path, h1);
		(manager as any).vaultSync = {
			getBlobRef: () => targetRef,
			isBlobTombstoned: () => false,
			pathToBlob: new Map([[path, targetRef]]),
		};

		await runDownload(manager, path, h2, undefined, variant.priorHashes);

		const backup = findVisibleLocalBackupPath(files, path);
		assert(text(files.get(path)!.data) === "bounded H2", `${variant.label}: the live remote ref becomes canonical`);
		assert(getModifyCalls() === 0, `${variant.label}: invalid lineage grants no causal overwrite shortcut`);
		assert(backup ? text(files.get(backup)!.data) === "bounded H1" : false, `${variant.label}: local bytes remain in a safety backup`);
		assert(!manager.isPreservedUnresolved(path), `${variant.label}: automatic convergence records no Attention`);
	}
}

console.log("\n--- Test 2l: upload rejects a current ref that diverged from the settled base ---");
{
	const path = "upload-diverged-base.png";
	const base = bytes("upload base H1");
	const remote = bytes("remote fork HA");
	const local = bytes("local fork HB");
	const baseHash = await sha256Hex(base);
	const remoteHash = await sha256Hex(remote);
	const baseRef: BlobRef = { hash: baseHash, size: base.byteLength };
	const remoteRef = createCausalBlobRef(remoteHash, remote.byteLength, baseRef);
	const { manager, files, put } = makeHarness(undefined, { [path]: baseRef });
	put(path, local);
	let setBlobRefCalls = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		setBlobRef: () => { setBlobRefCalls++; },
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).kickUploadDrain = () => {};
	(manager as any).kickDownloadDrain = () => {};
	(manager as any).enqueueUpload(path, 0, local.byteLength);
	const uploadItem: any = (manager as any).uploadQueue.get(path);
	uploadItem.status = "processing";
	await (manager as any).processUpload(uploadItem);

	assert(setBlobRefCalls === 0, "a local fork never publishes over a ref that diverged from its settled base");
	const downloadItem: any = (manager as any).downloadQueue.get(path);
	assert(downloadItem?.hash === remoteHash, "stale upload authority schedules the authoritative remote ref");
	(manager as any).blobClient = { download: async () => remote };
	downloadItem.status = "processing";
	await (manager as any).processDownload(downloadItem);
	const backup = findVisibleLocalBackupPath(files, path);
	assert(text(files.get(path)!.data) === "remote fork HA", "stale upload recovery installs the authoritative remote ref");
	assert(backup ? text(files.get(backup)!.data) === "local fork HB" : false, "stale local upload bytes remain in a safety backup");
	assert(!manager.isPreservedUnresolved(path), "stale upload recovery converges without Attention");
}

console.log("\n--- Test 2m: upload succeeds only against its exact settled base ref ---");
{
	const path = "upload-settled-base.png";
	const h1 = bytes("guarded upload H1");
	const h2 = bytes("guarded upload H2");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const settledRefs: Record<string, BlobRef> = { [path]: h1Ref };
	const { manager, put } = makeHarness(undefined, settledRefs);
	put(path, h2);
	let currentRef: BlobRef = h1Ref;
	let setBlobRefCalls = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		setBlobRef: (
			_path: string,
			hash: string,
			size: number,
			_mime: string,
			_device: unknown,
			guard: { expectedCurrentRef?: BlobRef; causalBaseRef?: BlobRef },
		) => {
			if (JSON.stringify(guard.expectedCurrentRef) !== JSON.stringify(currentRef)) return null;
			setBlobRefCalls++;
			currentRef = createCausalBlobRef(hash, size, guard.causalBaseRef);
			return currentRef;
		},
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h1Ref]]),
	};
	(manager as any).blobClient = {
		exists: async (hashes: string[]) => hashes,
		upload: async () => { throw new Error("deduplicated guarded upload should not PUT"); },
	};
	(manager as any).kickUploadDrain = () => {};
	(manager as any).enqueueUpload(path, 0, h2.byteLength);
	const item: any = (manager as any).uploadQueue.get(path);
	item.status = "processing";
	await (manager as any).processUpload(item);

	assert(setBlobRefCalls === 1, "the exact current==settled base admits one guarded setBlobRef");
	assert(currentRef.hash === h2Hash, "guarded upload publishes the local H2 hash");
	assert(
		hasExactlyHashes(getBlobRefPriorHashes(currentRef), [h1Hash]),
		"guarded upload mints H2 with only its settled H1 causal base",
	);
	assert(
		settledRefs[path]?.hash === h2Hash,
		"successful guarded upload advances the durable settled ref",
	);
}

console.log("\n--- Test 2n: a local historical revert yields to the live remote ref with a backup ---");
{
	const path = "intentional-local-revert.png";
	const h1 = bytes("historical H1 restored intentionally by the user");
	const h2 = bytes("last KAOS-settled H2");
	const h3 = bytes("authoritative remote H3");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h3Hash = await sha256Hex(h3);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const h3Ref = createCausalBlobRef(h3Hash, h3.byteLength, h2Ref);
	const settledRefs: Record<string, BlobRef> = { [path]: h2Ref };
	const { manager, files, put, getModifyCalls } = makeHarness(
		undefined,
		settledRefs,
	);
	// Disk intentionally moved backward after KAOS last settled H2. H1 remains
	// in H3's history, but history membership alone is not overwrite authority.
	put(path, h1);
	(manager as any).vaultSync = {
		getBlobRef: () => h3Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h3Ref]]),
	};

	assert(
		hasExactlyHashes(getBlobRefPriorHashes(h3Ref), [h2Hash, h1Hash]),
		"test authority carries both H2 and historical H1 in the H3 lineage",
	);
	await runDownload(
		manager,
		path,
		h3,
		undefined,
		getBlobRefPriorHashes(h3Ref),
	);

	const backup = findVisibleLocalBackupPath(files, path);
	assert(
		text(files.get(path)!.data) === text(h3),
		"the authoritative remote H3 becomes canonical",
	);
	assert(
		backup ? text(files.get(backup)!.data) === text(h1) : false,
		"the intentional local H1 revert remains in a safety backup",
	);
	assert(!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")), "authoritative H3 creates no conflict artifact");
	assert(getModifyCalls() === 0, "the reverted disk epoch is never overwritten with modifyBinary");
	assert(!manager.isPreservedUnresolved(path), "the H1/H3 divergence is settled without Attention");
	assert(
		settledRefs[path]?.hash === h3Hash,
		"authoritative convergence advances the durable settlement proof to H3",
	);
}

console.log("\n--- Test 2o: a missing settled replica is never recreated by a fresh download ---");
for (const remoteState of ["same", "advanced"] as const) {
	const path = `offline-${remoteState}-delete.png`;
	const h1 = bytes(`settled H1 for ${remoteState}`);
	const h2 = bytes(`remote H2 for ${remoteState}`);
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const remoteRef = remoteState === "same"
		? h1Ref
		: createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const remoteBytes = remoteState === "same" ? h1 : h2;
	const settledRefs: Record<string, BlobRef> = { [path]: h1Ref };
	const { manager, files, traces } = makeHarness(undefined, settledRefs);
	let networkDownloads = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).blobClient = {
		download: async () => {
			networkDownloads++;
			return remoteBytes;
		},
	};
	(manager as any).enqueueDownload(
		path,
		remoteRef.hash,
		remoteRef.size,
		0,
		getBlobRefPriorHashes(remoteRef),
	);
	const item: any = (manager as any).downloadQueue.get(path);
	item.status = "processing";
	await (manager as any).processDownload(item);

	assert(networkDownloads === 0, `${remoteState}: missing settled path performs no network download`);
	assert(!files.has(path), `${remoteState}: missing settled path is not recreated`);
	assert(!(manager as any).downloadQueue.has(path), `${remoteState}: blocked download item is discarded`);
	assert(settledRefs[path]?.hash === h1Hash, `${remoteState}: causal settlement remains intact for intent replay`);
	assert(
		traces.some((event) =>
			event.msg === "download-deferred-missing-settled-replica"
			&& event.details?.path === path
		),
		`${remoteState}: missing-settled final admission fence is traced`,
	);
	await manager.destroy();
}

console.log("\n--- Test 2p: imported and prefetched queues cannot bypass the missing-settled fence ---");
for (const source of ["imported", "prefetch"] as const) {
	const path = `${source}-offline-delete.png`;
	const remote = bytes(`${source} remote bytes`);
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	const settledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { manager, files } = makeHarness(undefined, settledRefs);
	let networkDownloads = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).blobClient = {
		download: async () => {
			networkDownloads++;
			return remote;
		},
	};

	if (source === "imported") {
		manager.closeDownloadGate("inspect-imported-offline-delete");
		manager.importQueue({
			uploads: [],
			downloads: [{ path, hash: remoteHash, sizeBytes: remote.byteLength }],
		});
		(manager as any).downloadGateOpen = true;
	} else {
		// Prevent the public prefetch API from starting its drain before the test
		// can inspect and execute the exact queued item deterministically.
		(manager as any).downloadDraining = true;
		assert(manager.prioritizeDownloads([path]) === 1, "prefetch queues the remote candidate");
		(manager as any).downloadDraining = false;
	}

	const item: any = (manager as any).downloadQueue.get(path);
	assert(!!item, `${source}: candidate reaches the shared download queue`);
	item.status = "processing";
	await (manager as any).processDownload(item);
	assert(networkDownloads === 0, `${source}: shared final fence runs before network I/O`);
	assert(!files.has(path), `${source}: shared final fence prevents canonical recreation`);
	assert(settledRefs[path]?.hash === remoteHash, `${source}: settled proof is retained`);
	await manager.destroy();
}

console.log("\n--- Test 2q: a non-file occupant with a settled ref also blocks download creation ---");
{
	const path = "offline-delete-path-collision.png";
	const remote = bytes("remote path collision bytes");
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	const settledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { app, manager, files, traces } = makeHarness(undefined, settledRefs);
	const originalGetAbstractFileByPath = app.vault.getAbstractFileByPath;
	app.vault.getAbstractFileByPath = (candidate: string) =>
		candidate === path ? { path: candidate } : originalGetAbstractFileByPath(candidate);
	let networkDownloads = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).blobClient = {
		download: async () => {
			networkDownloads++;
			return remote;
		},
	};
	(manager as any).enqueueDownload(path, remoteHash, remote.byteLength, 0, []);
	const item: any = (manager as any).downloadQueue.get(path);
	item.status = "processing";
	await (manager as any).processDownload(item);

	assert(networkDownloads === 0, "non-file settled occupant blocks network I/O");
	assert(!files.has(path), "non-file settled occupant is never replaced by a file");
	assert(
		traces.some((event) =>
			event.msg === "download-deferred-missing-settled-replica"
			&& event.details?.occupantKind === "non-file"
		),
		"non-file settled occupant is traced distinctly",
	);
	await manager.destroy();
}

console.log("\n--- Test 2r: a new device without a settlement may still download a missing remote file ---");
{
	const path = "new-device-remote.png";
	const remote = bytes("new device remote bytes");
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	const { manager, files } = makeHarness();
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	await runDownload(manager, path, remote);
	assert(text(files.get(path)!.data) === text(remote), "missing path without a settlement downloads normally");
	await manager.destroy();
}

console.log("\n--- Test 2s: reconcile distinguishes physical presence from transfer eligibility ---");
{
	const path = "oversized-existing.png";
	const local = bytes("physically present but over the configured transfer limit");
	const remote = bytes("remote should not be scheduled over the existing path");
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	const { app, manager, put } = makeHarness();
	const stored = put(path, local);
	app.vault.getFiles = () => [stored.file];
	(manager as any).maxSize = 1;
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	manager.closeDownloadGate("inspect-oversized-presence");
	const result = manager.reconcile("authoritative", []);
	assert(result.downloadQueued === 0, "oversized existing TFile is not classified as disk-missing");
	assert(manager.pendingDownloads === 0, "oversized existing TFile queues no remote create");
	await manager.destroy();
}

console.log("\n--- Test 2t: reconcile defers a missing settled path but admits first-time remote paths ---");
for (const hasSettlement of [true, false]) {
	const path = hasSettlement ? "reconcile-offline-delete.png" : "reconcile-first-download.png";
	const remote = bytes(`reconcile remote ${hasSettlement}`);
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	const settledRefs: Record<string, BlobRef> = hasSettlement ? { [path]: remoteRef } : {};
	const { app, manager, traces } = makeHarness(undefined, settledRefs);
	app.vault.getFiles = () => [];
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	manager.closeDownloadGate("inspect-reconcile-missing-path");
	const result = manager.reconcile("authoritative", []);
	assert(
		result.downloadQueued === (hasSettlement ? 0 : 1),
		hasSettlement
			? "reconcile does not queue an offline-deleted settled path"
			: "reconcile queues a first-time remote path without local settlement",
	);
	assert(
		hasSettlement === traces.some((event) =>
			event.msg === "reconcile-download-deferred-missing-settled-replica"
		),
		`${hasSettlement ? "settled" : "first-time"}: reconcile defer trace matches policy`,
	);
	await manager.destroy();
}

console.log("\n--- Test 3: create race mismatch converges through a local safety backup ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const originalCreateBinary = app.vault.createBinary;
	let raced = false;
	app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
		if (path === "img.png" && !raced) {
			raced = true;
			put(path, bytes("local-race"));
			const error = new Error("exists") as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		return originalCreateBinary(path, data);
	};

	await runDownload(manager, "img.png", bytes("remote"));

	const backup = findVisibleLocalBackupPath(files, "img.png");
	assert(text(files.get("img.png")!.data) === "remote", "create-race converges to the authoritative remote bytes");
	assert(backup ? text(files.get(backup)!.data) === "local-race" : false, "create-race local bytes remain in a safety backup");
	assert(!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")), "create-race emits no conflict artifact");
	assert(!manager.isPreservedUnresolved("img.png"), "create-race emits no Attention marker");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "authoritative-remote-wins"
		),
		"create-race authoritative resolution is traced",
	);
}

console.log("\n--- Test 4: create race same hash is skipped ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const remote = bytes("remote");
	const originalCreateBinary = app.vault.createBinary;
	let raced = false;
	app.vault.createBinary = async (path: string, data: ArrayBuffer) => {
		if (path === "img.png" && !raced) {
			raced = true;
			put(path, remote);
			const error = new Error("exists") as Error & { code?: string };
			error.code = "EEXIST";
			throw error;
		}
		return originalCreateBinary(path, data);
	};

	await runDownload(manager, "img.png", remote);

	const conflict = Array.from(files.keys()).find((path) => path.includes("KAOS remote conflict"));
	assert(text(files.get("img.png")!.data) === "remote", "matching create-race attachment remains in place");
	assert(!conflict, "matching create-race does not create conflict artifact");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision" &&
			event.details?.action === "skip-create-race-match"
		),
		"matching create-race skip is traced",
	);
}

console.log("\n--- Test 4b: superseded missing-target download writes only the latest ref ---");
{
	const { manager, files } = makeHarness();
	const first = bytes("remote H1");
	const second = bytes("remote H2");
	const firstHash = await sha256Hex(first);
	const secondHash = await sha256Hex(second);
	let remoteRef = { hash: firstHash, size: first.byteLength };
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map(),
	};
	(manager as any).kickDownloadDrain = () => {};
	const firstStarted = deferred<void>();
	const releaseFirst = deferred<ArrayBuffer>();
	(manager as any).blobClient = {
		download: async (hash: string) => {
			if (hash === firstHash) {
				firstStarted.resolve();
				return releaseFirst.promise;
			}
			assert(hash === secondHash, "rerun requests the authoritative H2 hash");
			return second;
		},
	};
	const item = {
		path: "latest-only.png",
		hash: firstHash,
		sizeBytes: first.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	(manager as any).downloadQueue.set(item.path, item);
	const firstAttempt = (manager as any).processDownload(item);
	await firstStarted.promise;
	remoteRef = { hash: secondHash, size: second.byteLength };
	(manager as any).enqueueDownload(item.path, secondHash, second.byteLength);
	releaseFirst.resolve(first);
	await firstAttempt;

	assert(!files.has(item.path), "superseded H1 creates no target file");
	assert(
		!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")),
		"superseded H1 creates no conflict artifact",
	);
	assert(item.hash === secondHash && item.status === "pending", "H2 remains as the runnable attempt");
	item.status = "processing";
	await (manager as any).processDownload(item);
	assert(text(files.get(item.path)!.data) === "remote H2", "the missing target is created directly from H2");
	assert(
		!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")),
		"latest-only creation needs no conflict artifact",
	);
}

console.log("\n--- Test 4c: H2 arriving inside createBinary retires operation-owned H1 ---");
{
	const { app, manager, files } = makeHarness();
	const path = "create-await-race.png";
	const first = bytes("create H1");
	const second = bytes("create H2");
	const firstHash = await sha256Hex(first);
	const secondHash = await sha256Hex(second);
	let remoteRef = { hash: firstHash, size: first.byteLength };
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map(),
	};
	(manager as any).kickDownloadDrain = () => {};
	const createStarted = deferred<void>();
	const releaseCreate = deferred<void>();
	const originalCreateBinary = app.vault.createBinary;
	let blocked = false;
	app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		if (candidate === path && !blocked) {
			blocked = true;
			createStarted.resolve();
			await releaseCreate.promise;
		}
		return originalCreateBinary(candidate, data);
	};
	(manager as any).blobClient = {
		download: async (hash: string) => hash === firstHash ? first : second,
	};
	const item = {
		path,
		hash: firstHash,
		sizeBytes: first.byteLength,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		generation: 0,
		rerunResets: 0,
	};
	(manager as any).downloadQueue.set(path, item);
	const firstAttempt = (manager as any).processDownload(item);
	await createStarted.promise;
	remoteRef = { hash: secondHash, size: second.byteLength };
	(manager as any).enqueueDownload(path, secondHash, second.byteLength);
	releaseCreate.resolve();
	await firstAttempt;

	const backupPath = findVisibleLocalBackupPath(files, path);
	assert(!files.has(path), "operation-owned H1 leaves the canonical path before H2 runs");
	assert(
		!!backupPath && text(files.get(backupPath)!.data) === "create H1",
		"operation-owned H1 remains visible in a UUID local safety backup",
	);
	assert(item.hash === secondHash && item.status === "pending", "H2 survives the post-create cleanup fence");
	item.status = "processing";
	await (manager as any).processDownload(item);
	assert(text(files.get(path)!.data) === "create H2", "the final target contains only H2");
	if (backupPath) {
		manager.handleFileChange(files.get(backupPath)!.file);
	}
	assert(
		!(manager as any).uploadQueue.has(backupPath),
		"the superseded H1 local safety backup is never uploaded",
	);
	assert(
		!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")),
		"the create-await race leaves no stale conflict artifact",
	);
}

console.log("\n--- Test 4d: sourceVersion ABA restores local bytes and retries the new episode ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const path = "source-version-aba.png";
	const local = bytes("local before source ABA");
	const remote = bytes("remote with stable hash");
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	let sourceVersion = "1:episode-a";
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		getBlobSourceVersion: () => sourceVersion,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).kickDownloadDrain = () => {};
	put(path, local);
	const originalRename = app.vault.rename;
	let changedEpisode = false;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		await originalRename(file, newPath);
		if (!changedEpisode) {
			changedEpisode = true;
			sourceVersion = "1:episode-b";
		}
	};

	await runDownload(manager, path, remote);
	const firstBackup = findVisibleLocalBackupPath(files, path);
	assert(changedEpisode, "the test replaces the sourceVersion episode during the no-clobber swap");
	assert(text(files.get(path)!.data) === text(local), "the stale episode restores the exact local bytes to canonical path");
	assert(firstBackup ? text(files.get(firstBackup)!.data) === text(local) : false, "the safety backup remains visible after restoration");
	assert((manager as any).downloadQueue.get(path)?.status === "pending", "the same-hash new source episode remains queued");
	assert(!manager.isPreservedUnresolved(path), "sourceVersion ABA creates no Attention marker");
	assert(!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")), "sourceVersion ABA creates no conflict artifact");

	await runQueuedDownloadAttempt(manager, path);
	assert(text(files.get(path)!.data) === text(remote), "the retry installs bytes owned by the current source episode");
	assert(
		traces.some((event) =>
			event.msg === "download-overwrite-decision"
			&& event.details?.action === "authoritative-remote-wins"
		),
		"the current source episode records an authoritative remote win",
	);
}

console.log("\n--- Test 4d.1: same-ref source episode queues a rerun after stage creation ---");
{
	const { manager, files, put, traces } = makeHarness();
	const path = "same-ref-source-episode.png";
	const local = bytes("local before same-ref episode change");
	const remote = bytes("remote bytes with a stable hash");
	const remoteHash = await sha256Hex(remote);
	const remoteRef: BlobRef = { hash: remoteHash, size: remote.byteLength };
	let sourceVersion = "1:episode-a";
	(manager as any).vaultSync = {
		getBlobRef: () => remoteRef,
		getBlobSourceVersion: () => sourceVersion,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, remoteRef]]),
	};
	(manager as any).kickDownloadDrain = () => {};
	put(path, local);

	const originalPrepareSettlementStage =
		(manager as any).prepareSettlementStage.bind(manager);
	let changedEpisode = false;
	(manager as any).prepareSettlementStage = async (...args: any[]) => {
		const stage = await originalPrepareSettlementStage(...args);
		if (!changedEpisode && args[1] === "download") {
			changedEpisode = true;
			sourceVersion = "1:episode-b";
			assert(
				(manager as any).scheduleDownload(path, remoteHash, remote.byteLength),
				"the same-ref new source episode is accepted while the old stage exists",
			);
		}
		return stage;
	};

	await runDownload(manager, path, remote);
	assert(changedEpisode, "the test replaces the source episode after stage creation");
	assert(
		(manager as any).downloadQueue.get(path)?.status === "pending",
		"the same-hash new source episode remains queued",
	);
	assert(
		!(manager as any).settlementStages[path],
		"the superseded settlement stage is aborted before the rerun",
	);
	assert(
		text(files.get(path)!.data) === text(local),
		"the superseded episode does not overwrite the local bytes",
	);
	assert(
		traces.some((event) => event.msg === "download-same-ref-source-episode-rerun"),
		"the same-ref source episode rerun is traced",
	);

	await runQueuedDownloadAttempt(manager, path);
	assert(
		text(files.get(path)!.data) === text(remote),
		"the rerun settles the current source episode",
	);
}

console.log("\n--- Test 4e: superseded-download backup ticket cannot borrow a post-hash disk epoch ---");
for (const replacementMode of ["same-file", "tfile-aba"] as const) {
	const { app, manager, files, put, replace } = makeHarness();
	const path = `download-backup-ticket-${replacementMode}.png`;
	const first = bytes(`H1-${replacementMode}`);
	const second = bytes(`local-H2-${replacementMode}`);
	const firstHash = await sha256Hex(first);
	const initial = put(path, first);
	let renameCalls = 0;
	const originalRename = app.vault.rename;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		renameCalls++;
		await originalRename(file, newPath);
	};

	const originalReadAndHash = (manager as any).readAndHashExactExistingFile.bind(manager);
	let armPostResolutionRace = true;
	(manager as any).readAndHashExactExistingFile = async (...args: unknown[]) => {
		const snapshot = await originalReadAndHash(...args);
		if (armPostResolutionRace) {
			armPostResolutionRace = false;
			queueMicrotask(() => {
				if (replacementMode === "same-file") put(path, second);
				else replace(path, second);
			});
		}
		return snapshot;
	};

	const retired = await (manager as any).trashExactDownloadedReplica(
		initial.file,
		path,
		firstHash,
	);
	assert(!retired, `${replacementMode}: stale H1 cleanup refuses the newer disk epoch`);
	assert(renameCalls === 1, `${replacementMode}: the exact old H1 epoch moves once to a visible backup`);
	assert(
		text(files.get(path)!.data) === text(second),
		`${replacementMode}: post-hash local bytes remain intact`,
	);
	const backupPath = findVisibleLocalBackupPath(files, path);
	assert(
		!!backupPath && text(files.get(backupPath)!.data) === text(first),
		`${replacementMode}: the exact old H1 bytes remain visible beside the newer canonical epoch`,
	);
}

console.log("\n--- Test 4e.1: replacement failure restores canonical local bytes before retry ---");
{
	const { app, manager, files, put } = makeHarness();
	const path = "authoritative-replacement-retry.png";
	const local = bytes("local survives failed replacement");
	const remote = bytes("remote after retry");
	put(path, local);
	const originalCreateBinary = app.vault.createBinary;
	let failedRemoteCreate = false;
	app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		if (candidate === path && !failedRemoteCreate) {
			failedRemoteCreate = true;
			const error = new Error("temporary storage failure") as Error & { code?: string };
			error.code = "EIO";
			throw error;
		}
		return originalCreateBinary(candidate, data);
	};

	await runDownload(manager, path, remote);
	const firstBackup = findVisibleLocalBackupPath(files, path);
	assert(failedRemoteCreate, "the authoritative remote create fails after the local backup move");
	assert(text(files.get(path)!.data) === text(local), "the exact local bytes are restored to canonical path");
	assert(firstBackup ? text(files.get(firstBackup)!.data) === text(local) : false, "the first safety backup remains visible after restoration");
	assert((manager as any).downloadQueue.get(path)?.status === "pending", "replacement failure retains retry intent");
	assert(!manager.isPreservedUnresolved(path), "replacement failure creates no Attention marker");
	assert(!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")), "replacement failure creates no conflict artifact");

	await runQueuedDownloadAttempt(manager, path);
	assert(text(files.get(path)!.data) === text(remote), "the next attempt installs the authoritative remote bytes");
}

console.log("\n--- Test 4f: same-TFile writes survive a clean remote overwrite in a visible local backup ---");
{
	const path = "same-tfile-overwrite.png";
	const h1 = bytes("clean overwrite H1");
	const h2 = bytes("authoritative overwrite H2");
	const duringWrite = bytes("external write while rename promise is pending");
	const lateWrite = bytes("external write long after overwrite settlement");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const { app, manager, files, put } = makeHarness(undefined, { [path]: h1Ref });
	const original = put(path, h1);
	(manager as any).vaultSync = {
		getBlobRef: () => h2Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h2Ref]]),
	};
	const renameStarted = deferred<string>();
	const releaseRename = deferred<void>();
	const originalRename = app.vault.rename;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		await originalRename(file, newPath);
		renameStarted.resolve(newPath);
		await releaseRename.promise;
	};

	const downloading = runDownload(
		manager,
		path,
		h2,
		undefined,
		getBlobRefPriorHashes(h2Ref),
	);
	const backupPath = await renameStarted.promise;
	put(backupPath, duringWrite);
	releaseRename.resolve();
	await downloading;

	assert(
		files.get(backupPath)?.file === original.file,
		"the exact predecessor TFile is moved to the UUID local safety backup",
	);
	assert(text(files.get(path)!.data) === text(h2), "the canonical target advances to authoritative H2");
	assert(
		text(files.get(backupPath)!.data) === text(duringWrite),
		"a same-TFile write during the overwrite remains visible in the local backup",
	);
	assert(
		manager.consumeRemoteOverwriteBackupRename(original.file, path),
		"the operation-owned rename event is consumed without treating the backup as a user rename",
	);

	put(backupPath, lateWrite);
	manager.handleFileChange(original.file);
	assert(
		text(files.get(backupPath)!.data) === text(lateWrite),
		"a same-TFile write long after settlement remains visible at the backup path",
	);
	assert(
		!(manager as any).uploadQueue.has(backupPath) && manager.pendingUploads === 0,
		"the UUID local safety backup is permanently excluded from blob upload",
	);
}

// ── Test 5: clean remote delete keeps a visible local safety backup ──────

console.log("\n--- Test 5: clean remote delete moves the exact TFile to a visible UUID backup ---");
{
	const path = "attachment.png";
	const clean = bytes("clean deleted replica");
	const duringWrite = bytes("external write during delete rename");
	const lateWrite = bytes("external write long after delete settlement");
	const cleanHash = await sha256Hex(clean);
	const deletedRef: BlobRef = { hash: cleanHash, size: clean.byteLength };
	const { app, manager, files, put, traces } = makeHarness();
	const original = put(path, clean);
	installRemoteDeleteAuthority(manager, path, deletedRef);
	let hardDeleteCalls = 0;
	(app as any).vault.delete = async () => { hardDeleteCalls++; };
	const originalRename = app.vault.rename;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		await originalRename(file, newPath);
		// Model an editor that still owns the same TFile/file descriptor and writes
		// after KAOS has moved it, but before the rename promise settles.
		put(newPath, duringWrite);
	};

	await (manager as any).handleRemoteDelete(path);
	const backupPath = findVisibleLocalBackupPath(files, path);

	assert(!files.has(path), "the canonical path is absent after the authoritative delete");
	assert(!!backupPath, "the deleted replica remains visible at a UUID KAOS local backup path");
	assert(
		!!backupPath && files.get(backupPath)?.file === original.file,
		"remote delete moves the exact original TFile instead of destroying it",
	);
	assert(
		!!backupPath && text(files.get(backupPath)!.data) === text(duringWrite),
		"a same-TFile write during delete settlement remains visible in the backup",
	);
	assert(hardDeleteCalls === 0, "automatic remote delete never calls hard delete");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-applied"
			&& event.details?.deleteMode === "visible-local-backup"
			&& event.details?.backupPath === backupPath
		),
		"remote delete traces the visible local backup path",
	);

	if (backupPath) {
		assert(
			manager.consumeRemoteOverwriteBackupRename(original.file, path),
			"the operation-owned delete rename event is consumed exactly once",
		);
		put(backupPath, lateWrite);
		manager.handleFileChange(original.file);
		assert(
			text(files.get(backupPath)!.data) === text(lateWrite),
			"a same-TFile write long after delete settlement remains visible",
		);
	}
	assert(
		!backupPath || !(manager as any).uploadQueue.has(backupPath),
		"the remote-delete local safety backup is never uploaded",
	);
	const debug = manager.getDebugSnapshot();
	assert(debug.blobConflictArtifacts === 0, "a clean remote delete does not increment the true conflict count");
	assert(debug.blobSafetyBackups === 1, "a clean remote delete records one rollback safety copy");
}

console.log("\n--- Test 5b: prior Attention clears only after the visible backup rename settles ---");
{
	const path = "attention-delete.png";
	const clean = bytes("clean local data");
	const cleanHash = await sha256Hex(clean);
	const deletedRef: BlobRef = { hash: cleanHash, size: clean.byteLength };
	const { app, manager, files, put } = makeHarness();
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, deletedRef);
	manager.recordPreservedUnresolved(path, "remote-delete-missing-baseline");
	const originalRename = app.vault.rename;
	let markerPresentInsideRename = false;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		markerPresentInsideRename = manager.isPreservedUnresolved(path);
		await originalRename(file, newPath);
	};

	await (manager as any).handleRemoteDelete(path);

	assert(markerPresentInsideRename, "the prior marker remains while the no-clobber rename is dispatched");
	assert(!files.has(path), "successful backup settlement leaves the canonical path absent");
	assert(!!findVisibleLocalBackupPath(files, path), "successful delete retains its visible safety backup");
	assert(!manager.isPreservedUnresolved(path), "the exact prior marker clears only after backup settlement");
}

console.log("\n--- Test 5c: H1 delete handler cannot borrow a newer T2 episode ---");
{
	const { app, manager, files, put, traces } = makeHarness();
	const path = "episode-fence.png";
	const h1 = bytes("local H1");
	const localH1 = put(path, h1);
	const hashH1 = await sha256Hex(localH1.data);
	const deletedRef: BlobRef = { hash: hashH1, size: h1.byteLength };
	let fingerprint = "delete-T1";
	(manager as any).vaultSync = {
		getAuthoritativeBlobDeleteSnapshot: () => ({ fingerprint, deletedRef }),
		getBlobRef: () => undefined,
		isBlobTombstoned: () => true,
		pathToBlob: new Map(),
		blobTombstones: new Map(),
	};
	let renameCalls = 0;
	const originalRename = app.vault.rename;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		renameCalls++;
		await originalRename(file, newPath);
	};
	const runtime = manager as any;
	runtime.inflightDownloads.add(path);
	const deletingT1 = runtime.handleRemoteDelete(path);
	// The first handler has captured {H1,T1} and is now waiting. Simulate a
	// revival to H2 followed by a distinct T2 delete before that wait settles.
	fingerprint = "delete-T2";
	runtime.inflightDownloads.delete(path);
	runtime.notifyTransferSettled(path);
	await deletingT1;

	assert(renameCalls === 0, "the H1 handler does not move local H1 under T2 authority");
	assert(files.has(path), "local H1 remains canonical when the delete episode changes while waiting");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-resolution-stale" &&
			event.details?.reason === "delete-episode-changed-while-waiting-for-transfers"
		),
		"episode mismatch is traced before any filesystem rename",
	);
}

console.log("\n--- Test 5d: stale delete preserves both a same-path replacement and old-TFile backup ---");
{
	const { app, manager, files, put, replace } = makeHarness();
	const path = "delete-aba.png";
	const oldBytes = bytes("old clean bytes");
	const original = put(path, oldBytes);
	const knownHash = await sha256Hex(original.data);
	installRemoteDeleteAuthority(
		manager,
		path,
		{ hash: knownHash, size: oldBytes.byteLength },
		"delete-T1",
	);
	(manager as any).kickUploadDrain = () => {};
	let replacement: StoredFile | undefined;
	const originalRename = app.vault.rename;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		await originalRename(file, newPath);
		replacement = replace(path, bytes("new winner"));
		manager.admitReplacementAfterStaleDelete(replacement.file);
	};

	await (manager as any).handleRemoteDelete(path);
	const backupPath = findVisibleLocalBackupPath(files, path);
	assert(files.get(path)?.file === replacement?.file, "the same-path replacement remains the canonical winner");
	assert(
		!!backupPath && files.get(backupPath)?.file === original.file,
		"the superseded delete epoch remains visible as the old-TFile backup",
	);
	assert(manager.pendingUploads === 1, "the same-path replacement receives a fresh upload admission");
	assert(
		!backupPath || !(manager as any).uploadQueue.has(backupPath),
		"the old-TFile local backup is never admitted for upload",
	);
	await manager.destroy();
}

// ── Test 6: remote delete preserves when safety rename is unavailable ───────

console.log("\n--- Test 6: clean remote delete preserves canonical file when rename is unavailable ---");
{
	const path = "attachment2.png";
	const clean = bytes("local data 2");
	const cleanHash = await sha256Hex(clean);
	const { app, manager, files, put, traces } = makeHarness();
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, { hash: cleanHash, size: clean.byteLength });
	(app as any).vault.rename = undefined;
	let hardDeleteCalls = 0;
	(app as any).vault.delete = async () => { hardDeleteCalls++; };

	await (manager as any).handleRemoteDelete(path);

	assert(hardDeleteCalls === 0, "rename-unavailable delete never falls back to hard delete");
	assert(files.has(path), "rename-unavailable delete preserves the canonical original");
	assert(manager.isPreservedUnresolved(path), "rename-unavailable delete records Attention");
	assert(
		traces.some((event) => event.msg === "remote-delete-backup-failed"),
		"rename-unavailable delete traces visible-backup failure",
	);
}

// ── Test 7: remote delete preserves when safety rename rejects ───────────

console.log("\n--- Test 7: clean remote delete preserves canonical file when rename rejects ---");
{
	const path = "attachment3.png";
	const clean = bytes("local data 3");
	const cleanHash = await sha256Hex(clean);
	const { app, manager, files, put, traces } = makeHarness();
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, { hash: cleanHash, size: clean.byteLength });
	app.vault.rename = async () => { throw new Error("rename not supported"); };
	let hardDeleteCalls = 0;
	(app as any).vault.delete = async () => { hardDeleteCalls++; };

	await (manager as any).handleRemoteDelete(path);

	assert(hardDeleteCalls === 0, "rename rejection never falls back to hard delete");
	assert(files.has(path), "rename rejection preserves the original attachment");
	assert(manager.isPreservedUnresolved(path), "rename rejection records durable Attention");
	assert(
		traces.some((event) => event.msg === "remote-delete-backup-failed"),
		"rename rejection traces visible-backup failure",
	);
}

// ── Test 8: operation-owned rename event is consumed ───────────────────

console.log("\n--- Test 8: clean remote delete consumes its operation-owned rename event ---");
{
	const path = "rename-event.png";
	const clean = bytes("rename me safely");
	const cleanHash = await sha256Hex(clean);
	const { app, manager, files, put } = makeHarness();
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, { hash: cleanHash, size: clean.byteLength });
	const originalRename = app.vault.rename;
	let renameConsumed = false;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		await originalRename(file, newPath);
		renameConsumed = manager.consumeRemoteOverwriteBackupRename(file, path);
	};

	await (manager as any).handleRemoteDelete(path);

	assert(renameConsumed, "the exact operation-owned old-path rename event is consumed");
	assert(!files.has(path), "consuming the rename event does not recreate the canonical target");
	assert(!!findVisibleLocalBackupPath(files, path), "the consumed rename still leaves a visible local backup");
}

// ── Test 9: blob remote delete preserves locally modified file ──────────────

console.log("\n--- Test 9: blob remote delete preserves an independent local fork ---");
{
	const path = "locally-modified.png";
	const remoteBase = bytes("remote version before delete");
	const localFork = bytes("independent local version");
	const remoteHash = await sha256Hex(remoteBase);
	const { app, manager, files, put, traces } = makeHarness();
	put(path, localFork);
	installRemoteDeleteAuthority(manager, path, { hash: remoteHash, size: remoteBase.byteLength });
	app.vault.rename = async () => { throw new Error("should not move a local fork"); };

	await (manager as any).handleRemoteDelete(path);

	assert(text(files.get(path)!.data) === text(localFork), "the independent local fork remains canonical");
	assert(!findVisibleLocalBackupPath(files, path), "a local conflict is not mislabeled as a clean-delete backup");
	assert(manager.isPreservedUnresolved(path), "the local fork records durable Attention");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved"
			&& event.details?.reason === "remote-delete-local-conflict"
		),
		"blob remote delete traces the causal local-conflict reason",
	);
}

// ── Test 10: deleted ref lineage admits a clean settled predecessor ─────────

console.log("\n--- Test 10: remote delete admits an exact settled predecessor covered by deletedRef ---");
{
	const path = "settled-predecessor.png";
	const h1 = bytes("settled H1");
	const h2 = bytes("remote H2 before delete");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const deletedRef = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const { manager, files, put, traces } = makeHarness(undefined, { [path]: h1Ref });
	put(path, h1);
	installRemoteDeleteAuthority(manager, path, deletedRef);

	await (manager as any).handleRemoteDelete(path);

	const backupPath = findVisibleLocalBackupPath(files, path);
	assert(!files.has(path), "covered settled predecessor leaves the canonical path absent");
	assert(
		!!backupPath && text(files.get(backupPath)!.data) === text(h1),
		"covered settled predecessor remains visible in its local safety backup",
	);
	assert(
		traces.some((event) => event.msg === "remote-delete-applied"),
		"covered settled predecessor records an applied remote delete",
	);
}

// ── Test 11: legacy delete authority without deletedRef fails closed ──────────

console.log("\n--- Test 11: blob remote delete preserves when deletedRef is missing ---");
{
	const path = "no-baseline.png";
	const local = bytes("mystery content");
	const { app, manager, files, put, traces } = makeHarness();
	put(path, local);
	installRemoteDeleteAuthority(manager, path, undefined, "legacy-delete-no-ref");
	app.vault.rename = async () => { throw new Error("should not move without deletedRef authority"); };

	await (manager as any).handleRemoteDelete(path);

	assert(text(files.get(path)!.data) === text(local), "file remains canonical without deletedRef authority");
	assert(manager.isPreservedUnresolved(path), "missing deletedRef records durable Attention");
	assert(
		traces.some((event) =>
			event.msg === "remote-delete-conflict-preserved"
			&& event.details?.reason === "remote-delete-missing-baseline"
		),
		"blob remote delete traces missing-baseline preservation",
	);
}

console.log("\n--- Test 11b: ref-less retirement permanently fences legacy absence ---");
{
	const path = "legacy-missing-delete.png";
	const { manager, files } = makeHarness();
	installRemoteDeleteAuthority(manager, path, undefined, "legacy-delete-missing-disk");

	await (manager as any).handleRemoteDelete(path);
	const stage = (manager as any).settlementStages[path];
	assert(
		stage?.kind === "retire" && stage.ref === undefined,
		"missing legacy tombstone leaves a permanent ref-less retire fence",
	);

	const revived = bytes("rolled-back remote bytes");
	const revivedHash = await sha256Hex(revived);
	const revivedRef: BlobRef = { hash: revivedHash, size: revived.byteLength };
	let downloads = 0;
	(manager as any).vaultSync = {
		getBlobRef: () => revivedRef,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, revivedRef]]),
	};
	(manager as any).blobClient = {
		download: async () => { downloads++; return revived; },
	};
	manager.reconcile("authoritative", []);
	await Promise.resolve();
	assert(downloads === 0, "snapshot rollback cannot download through a ref-less retire fence");
	assert(!files.has(path), "snapshot rollback cannot recreate the retired path");
}

console.log("\n--- Test 11b.1: absent-path retirement persistence failure remains retryable ---");
{
	const path = "legacy-missing-delete-retry.png";
	const { manager } = makeHarness();
	installRemoteDeleteAuthority(manager, path, undefined, "legacy-delete-retry");
	(manager as any).settlementPersistence = {
		stage: async () => { throw new Error("simulated settlement persistence failure"); },
		finalize: async () => undefined,
		retire: async () => undefined,
		abort: async () => undefined,
	};

	let rejected = false;
	try {
		await (manager as any).handleRemoteDelete(path);
	} catch {
		rejected = true;
	}
	assert(rejected, "absent-path retirement reports durable persistence failure");
	assert(
		!(manager as any).remoteDeleteInFlight.has(path),
		"failed absent-path retirement releases its in-flight episode",
	);

	(manager as any).settlementPersistence = undefined;
	await (manager as any).handleRemoteDelete(path);
	assert(
		(manager as any).settlementStages[path]?.kind === "retire",
		"the same tombstone can retry and establish permanent absence provenance",
	);
}

console.log("\n--- Test 11c: explicit legacy delete persists retirement before trash ---");
{
	const path = "legacy-explicit-delete.png";
	const { manager, files, put } = makeHarness();
	put(path, bytes("local legacy file"));
	installRemoteDeleteAuthority(manager, path, undefined, "legacy-explicit-delete");
	manager.recordPreservedUnresolved(path, "remote-delete-missing-baseline");

	let deleteCalls = 0;
	(manager as any).settlementPersistence = {
		stage: async () => { throw new Error("durable stage unavailable"); },
		finalize: async () => undefined,
		retire: async () => undefined,
		abort: async () => undefined,
	};
	let rejected = false;
	try {
		await manager.acceptRemoteDeletedBlob(
			path,
			"remote-delete-missing-baseline",
			async () => { deleteCalls++; files.delete(path); },
		);
	} catch {
		rejected = true;
	}
	assert(rejected, "explicit delete fails closed when retirement cannot be persisted");
	assert(deleteCalls === 0, "local trash is never called before durable retirement");
	assert(files.has(path), "the local file remains when retirement persistence fails");
	assert(manager.isPreservedUnresolved(path), "Attention remains after rejected explicit delete");

	(manager as any).settlementPersistence = undefined;
	await manager.acceptRemoteDeletedBlob(
		path,
		"remote-delete-missing-baseline",
		async () => {
			const staged = (manager as any).settlementStages[path];
			assert(
				staged?.kind === "retire" && staged.ref === undefined,
				"ref-less retirement is durable in memory before local trash starts",
			);
			deleteCalls++;
			files.delete(path);
		},
	);
	assert(!files.has(path), "explicitly accepted legacy deletion removes the canonical file");
	assert(!manager.isPreservedUnresolved(path), "Attention clears only after retirement finalizes");
	assert(
		(manager as any).settlementStages[path]?.kind === "retire",
		"explicit legacy deletion retains permanent absence provenance",
	);
}

// ── Test 12: rerunResets cap prevents infinite retry loops ───────────────────

console.log("\n--- Test 12: rerunResets cap triggers permanent failure ---");
{
	const { manager, traces } = makeHarness();

	// Craft a download item that has exhausted retries AND rerunResets
	const item = {
		path: "capped.png",
		hash: "abc123",
		sizeBytes: 100,
		status: "processing" as const,
		retries: 4, // > MAX_RETRIES (3)
		readyAt: 0,
		needsRerun: true,
		rerunResets: 5, // = MAX_RERUN_RESETS (5)
	};

	// Mock blobClient to throw
	(manager as any).blobClient = {
		download: async () => { throw new Error("always fails"); },
	};

	await (manager as any).processDownload(item);

	// Item should be permanently failed — not restarted
	assert(
		!((manager as any).downloadQueue as Map<string, unknown>).has("capped.png"),
		"capped item removed from queue (permanent failure)",
	);
	assert(
		traces.some((event) =>
			event.msg === "download-permanently-failed" &&
			event.details?.path === "capped.png"
		),
		"permanent failure trace emitted for capped item",
	);
	assert(
		(manager as any)._permanentDownloadFailures === 1,
		"permanent download failure counter incremented",
	);
}

// ── Test 13: rerunResets < cap allows fresh restart ─────────────────────────

console.log("\n--- Test 13: rerunResets below cap allows fresh restart ---");
{
	const { manager, traces } = makeHarness();
	manager.closeDownloadGate("inspect-retry-reset");

	const item = {
		path: "restartable.png",
		hash: "def456",
		sizeBytes: 200,
		status: "processing" as const,
		retries: 4, // > MAX_RETRIES
		readyAt: 0,
		needsRerun: true,
		rerunResets: 3, // < MAX_RERUN_RESETS (5)
	};

	(manager as any).blobClient = {
		download: async () => { throw new Error("temporary"); },
	};

	// Put item in queue so processDownload can find it
	(manager as any).downloadQueue.set("restartable.png", item);

	await (manager as any).processDownload(item);

	// Item should be restarted, not permanently failed
	assert(
		((manager as any).downloadQueue as Map<string, any>).has("restartable.png"),
		"restartable item still in queue after rerun reset",
	);
	assert(item.retries === 0, "retries reset to 0 after rerun");
	assert(item.rerunResets === 4, "rerunResets incremented");
	assert(item.status === "pending", "status reset to pending");
	assert(
		(manager as any)._permanentDownloadFailures === 0,
		"no permanent failure for restartable item",
	);
}

// ── Test 14: debug snapshot exposes permanent failure counters ───────────────

console.log("\n--- Test 14: debug snapshot includes permanent failure counters ---");
{
	const { manager } = makeHarness();

	const snapshot = (manager as any).getDebugSnapshot();
	assert(
		"permanentUploadFailures" in snapshot,
		"debug snapshot has permanentUploadFailures",
	);
	assert(
		"permanentDownloadFailures" in snapshot,
		"debug snapshot has permanentDownloadFailures",
	);
	assert(
		"blobConflictArtifacts" in snapshot,
		"debug snapshot has blobConflictArtifacts",
	);
	assert(
		"blobSafetyBackups" in snapshot,
		"debug snapshot has blobSafetyBackups",
	);
	assert(
		snapshot.permanentUploadFailures === 0,
		"initial permanent upload failures is 0",
	);
	assert(
		snapshot.permanentDownloadFailures === 0,
		"initial permanent download failures is 0",
	);
}

// ── Test 14b: excluded persisted blob transfers are never restored ─────────

console.log("\n--- Test 14b: excluded persisted blob transfers are skipped ---");
{
	const { manager } = makeHarness((path) => !path.includes("/.obsidian/"));
	(manager as any).importQueue({
		uploads: [{ path: "docs/sample-vault/.obsidian/workspace.json" }],
		downloads: [{
			path: "docs/sample-vault/.obsidian/workspace.json",
			hash: "a".repeat(64),
		}],
	});
	const snapshot = (manager as any).getDebugSnapshot();
	assert(snapshot.pendingUploads === 0, "excluded upload is not restored");
	assert(snapshot.pendingDownloads === 0, "excluded download is not restored");
}

// ── Test 15: destroy() during in-flight transfer does not resurrect queue state ──

console.log("\n--- Test 15: destroy during in-flight does not resurrect ---");
{
	const { manager, files, put, traces } = makeHarness();
	put("inflight.png", bytes("data"));
	const remoteData = bytes("remote");
	const remoteHash = await sha256Hex(remoteData);

	let resolveDownload: (() => void) | null = null;
	const downloadPromise = new Promise<void>((resolve) => {
		resolveDownload = resolve;
	});

	(manager as any).blobClient = {
		download: async () => {
			// download started — destroy while in flight
			await manager.destroy();
			await downloadPromise; // wait until test signals
			return remoteData;
		},
	};

	const item = {
		path: "inflight.png",
		hash: remoteHash,
		sizeBytes: 6,
		status: "processing" as const,
		retries: 0,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	(manager as any).downloadQueue.set("inflight.png", item);

	// Start processing — it will call blobClient.download which destroys mid-flight
	const processPromise = (manager as any).processDownload(item);

	// Let the download resolve after destroy
	resolveDownload!();
	await processPromise;

	// After destroy + download resolving, queue should remain empty
	assert(
		(manager as any).downloadQueue.size === 0,
		"download queue empty after destroy (not resurrected)",
	);
	assert(
		(manager as any).uploadQueue.size === 0,
		"upload queue empty after destroy",
	);
	assert(
		(manager as any).inflightDownloads.size === 0,
		"inflight tracking cleared by destroy",
	);

	// Clear any deferred queue work that may have been scheduled after the
	// in-flight operation resolved.
	await manager.destroy();
}

console.log("\n--- Test 15b: disconnect authority revocation fences an in-flight download ---");
{
	const { manager, files } = makeHarness();
	const path = "late-authority.png";
	const remoteData = bytes("stale remote candidate");
	const remoteHash = await sha256Hex(remoteData);
	const started = deferred<void>();
	const response = deferred<ArrayBuffer>();

	(manager as any).blobClient = {
		download: async () => {
			started.resolve();
			return response.promise;
		},
	};
	(manager as any).enqueueDownload(path, remoteHash, remoteData.byteLength, 0, []);
	const item = (manager as any).downloadQueue.get(path);
	item.status = "processing";
	const processing = (manager as any).processDownload(item);
	await started.promise;

	manager.closeDownloadGate("test-provider-disconnect");
	response.resolve(remoteData);
	await processing;

	assert(
		!files.has(path),
		"a response verified after download authority revocation never creates the canonical path",
	);
	assert(
		(manager as any).downloadQueue.size === 0,
		"the stale in-flight target is discarded and must be replanned after authoritative reconcile",
	);
}

console.log("\n--- Test 15b.1: retirement compensates a no-clobber create already in flight ---");
{
	const path = "retiring-overwrite.png";
	const h1 = bytes("settled local H1");
	const h2 = bytes("remote H2 created before retirement");
	const h1Hash = await sha256Hex(h1);
	const h2Hash = await sha256Hex(h2);
	const h1Ref: BlobRef = { hash: h1Hash, size: h1.byteLength };
	const h2Ref = createCausalBlobRef(h2Hash, h2.byteLength, h1Ref);
	const { app, manager, files, put } = makeHarness(undefined, { [path]: h1Ref });
	put(path, h1);
	(manager as any).vaultSync = {
		getBlobRef: () => h2Ref,
		isBlobTombstoned: () => false,
		pathToBlob: new Map([[path, h2Ref]]),
	};
	(manager as any).blobClient = { download: async () => h2 };

	const canonicalCreateStarted = deferred<void>();
	const releaseCanonicalCreate = deferred<void>();
	const originalCreateBinary = app.vault.createBinary;
	let delayFirstCanonicalCreate = true;
	app.vault.createBinary = async (candidate: string, data: ArrayBuffer) => {
		const created = await originalCreateBinary(candidate, data);
		if (candidate === path && delayFirstCanonicalCreate) {
			delayFirstCanonicalCreate = false;
			canonicalCreateStarted.resolve();
			await releaseCanonicalCreate.promise;
		}
		return created;
	};

	manager.closeDownloadGate("stage-retirement-race");
	(manager as any).enqueueDownload(
		path,
		h2Hash,
		h2.byteLength,
		0,
		getBlobRefPriorHashes(h2Ref),
	);
	manager.openDownloadGate("start-retirement-race");
	await canonicalCreateStarted.promise;
	assert(
		manager.isPathOperationInFlight(path),
		"the vacancy scanner sees the no-clobber replacement as operation-owned",
	);

	let destroySettled = false;
	const destroying = manager.destroy().then(() => { destroySettled = true; });
	await Promise.resolve();
	assert(
		!destroySettled,
		"manager retirement waits for the already-dispatched canonical create",
	);
	releaseCanonicalCreate.resolve();
	await destroying;

	assert(
		text(files.get(path)!.data) === text(h1),
		"retirement restores the clean H1 predecessor instead of leaving stale H2 canonical",
	);
	const backupContents = Array.from(files.entries())
		.filter(([candidate]) => candidate.includes("(KAOS local backup "))
		.map(([, stored]) => text(stored.data));
	assert(
		backupContents.includes(text(h1)) && backupContents.includes(text(h2)),
		"both the predecessor and retired remote candidate remain visible in UUID backups",
	);
	assert(
		!manager.isPathOperationInFlight(path),
		"operation ownership retires only after compensation settles",
	);
}

console.log("\n--- Test 15c: destroy waits for observer-owned remote delete work ---");
{
	const { app, manager, files, put } = makeHarness();
	const path = "remote-delete-during-stop.png";
	const clean = bytes("clean remote replica");
	const cleanHash = await sha256Hex(clean);
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, {
		hash: cleanHash,
		size: clean.byteLength,
	});

	const renameStarted = deferred<void>();
	const allowRename = deferred<void>();
	const originalRename = app.vault.rename;
	let ticketConsumed = false;
	app.vault.rename = async (file: TFile & { path: string }, newPath: string) => {
		renameStarted.resolve();
		await allowRename.promise;
		await originalRename(file, newPath);
		// Simulate the synchronous Obsidian rename event while the manager is in
		// its retiring lifecycle but before the observer-owned task resolves.
		ticketConsumed = manager.consumeRemoteOverwriteBackupRename(file, path);
	};

	(manager as any).scheduleRemoteDelete(path);
	await renameStarted.promise;
	assert(
		manager.isPathOperationInFlight(path),
		"the vacancy scanner sees observer-owned remote delete work in flight",
	);
	let destroySettled = false;
	const destroying = manager.destroy().then(() => {
		destroySettled = true;
	});
	await Promise.resolve();
	assert(
		!destroySettled,
		"destroy remains pending while an operation-owned backup rename is unresolved",
	);

	allowRename.resolve();
	await destroying;
	assert(ticketConsumed, "the exact backup rename ticket remains consumable until the task settles");
	assert(
		files.has(path),
		"authority revocation during the rename restores a no-clobber canonical copy",
	);
	assert(
		(manager as any).activeRemoteDeletePromises.size === 0,
		"observer-owned remote delete tasks are drained before manager cleanup completes",
	);
}

console.log("\n--- Test 15c.1: stale cached tombstones wait for provider authority ---");
{
	const { manager, files, put } = makeHarness();
	const path = "stale-idb-tombstone.png";
	const clean = bytes("local canonical survives stale IDB");
	const cleanHash = await sha256Hex(clean);
	put(path, clean);
	installRemoteDeleteAuthority(manager, path, {
		hash: cleanHash,
		size: clean.byteLength,
	}, "stale-idb-delete");

	manager.closeDownloadGate("provider-not-yet-synced");
	(manager as any).scheduleRemoteDelete(path);
	await Promise.resolve();
	assert(
		files.has(path) && !findVisibleLocalBackupPath(files, path),
		"a tombstone seen only in local IDB cannot move the canonical file",
	);
	assert(
		(manager as any).deferredRemoteDeletePaths.has(path),
		"the path is deferred for authoritative provider re-evaluation",
	);

	// The provider's authoritative room revived the path before its first sync.
	(manager as any).vaultSync.getAuthoritativeBlobDeleteSnapshot = () => null;
	manager.openDownloadGate("provider-authoritative-reconcile");
	await Promise.resolve();
	await Promise.resolve();
	assert(
		files.has(path) && !findVisibleLocalBackupPath(files, path),
		"opening the gate rechecks current CRDT authority and drops the stale delete",
	);
}

console.log("\n--- Test 15d: orchestrator gates both directions on provider authority ---");
{
	let uploadOpen = false;
	let downloadOpen = false;
	let uploadCloseCount = 0;
	let downloadCloseCount = 0;
	const fakeManager = {
		get isUploadGateOpen() { return uploadOpen; },
		get isDownloadGateOpen() { return downloadOpen; },
		pendingUploads: 0,
		pendingDownloads: 0,
		openUploadGate: () => { uploadOpen = true; },
		openDownloadGate: () => { downloadOpen = true; },
		closeUploadGate: () => { uploadOpen = false; uploadCloseCount++; },
		closeDownloadGate: () => { downloadOpen = false; downloadCloseCount++; },
	} as unknown as BlobSyncManager;
	const orchestrator = new AttachmentOrchestrator({
		app: {
			workspace: {
				layoutReady: true,
				onLayoutReady: () => undefined,
			},
		} as any,
		getVaultSync: () => null,
		getRuntimeConfig: () => ({}) as any,
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getBlobSettledRefs: () => ({}),
		getBlobSettledSourceVersions: () => ({}),
		getBlobSettlementStages: () => ({}),
		captureBlobRuntimeAuthority: () => ({ identity: "test", epoch: 1 }),
		isBlobRuntimeAuthorityCurrent: () => true,
		isUploadAuthoritySourceReady: () => true,
		onBlobSettledRefsChanged: () => undefined,
		stageBlobSettlement: async () => undefined,
		finalizeBlobSettlement: async () => undefined,
		retireBlobSettlement: async () => undefined,
		abortBlobSettlementStage: async () => undefined,
		getExcludePatterns: () => [],
		persistBlobQueue: async () => undefined,
		clearPersistedBlobQueue: async () => undefined,
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => undefined,
		hasPendingBlobIntentForPath: () => false,
		replayPendingBlobIntents: async () => undefined,
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		refreshStatusBar: () => undefined,
		log: () => undefined,
	} as any);
	(orchestrator as any).blobSync = fakeManager;
	(orchestrator as any).blobRuntimeAuthorities.set(fakeManager, {
		scope: { host: "test", vaultId: "test", localDeviceId: "test" },
		vaultSync: {},
		token: { identity: "test", epoch: 1 },
	});

	orchestrator.markStartupReady("test-startup");
	assert(!uploadOpen && !downloadOpen, "startup/layout readiness alone opens neither transfer gate");
	orchestrator.markUploadAuthorityReady("test-provider-sync");
	assert(uploadOpen && downloadOpen, "authoritative provider reconcile opens both transfer gates");
	orchestrator.revokeUploadAuthority("test-provider-disconnect");
	assert(
		!uploadOpen && !downloadOpen && uploadCloseCount === 1 && downloadCloseCount === 1,
		"provider disconnect revokes both upload and download authority",
	);

	(orchestrator as any).blobSync = null;
	const retiredFile = new TFile();
	const retiring = {
		consumeRemoteOverwriteBackupRename: (file: TFile, oldPath: string) =>
			file === retiredFile && oldPath === "retiring.png",
	} as BlobSyncManager;
	(orchestrator as any).retiringBlobSyncs.add(retiring);
	assert(
		orchestrator.consumeRemoteOverwriteBackupRename(retiredFile, "retiring.png"),
		"operation-owned rename tickets remain visible through a retiring manager",
	);
}

console.log("\n--- Test 15d.1: stop retirement blocks refresh until persistence and cleanup drain ---");
{
	const persistGate = deferred<void>();
	const destroyGate = deferred<void>();
	const retiredScope = {
		host: "https://old.example.test",
		vaultId: "old-vault",
		localDeviceId: "device-a",
	};
	let persistedRetirementScope: typeof retiredScope | null = null;
	let persistedRetirementSnapshot: BlobQueueSnapshot | null = null;
	let destroyStarted = 0;
	let replacementStarts = 0;
	const fakeManager = {
		get isUploadGateOpen() { return true; },
		get isDownloadGateOpen() { return true; },
		closeUploadGate: () => undefined,
		closeDownloadGate: () => undefined,
		exportQueue: () => ({
			uploads: [{
				path: "assets/deferred-at-stop.png",
				baseRefKnown: false,
				deferredUntilSettlement: true as const,
			}],
			downloads: [],
		}),
		destroy: async () => {
			destroyStarted++;
			await destroyGate.promise;
		},
	} as unknown as BlobSyncManager;
	const orchestrator = new AttachmentOrchestrator({
		app: {
			workspace: {
				layoutReady: true,
				onLayoutReady: () => undefined,
			},
		} as any,
		getVaultSync: () => ({}) as any,
		getRuntimeConfig: () => ({ enableAttachmentSync: true }) as any,
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getBlobSettledRefs: () => ({}),
		getBlobSettledSourceVersions: () => ({}),
		getBlobSettlementStages: () => ({}),
		captureBlobRuntimeAuthority: () => ({ identity: "test", epoch: 1 }),
		isBlobRuntimeAuthorityCurrent: () => true,
		isUploadAuthoritySourceReady: () => true,
		onBlobSettledRefsChanged: () => undefined,
		stageBlobSettlement: async () => undefined,
		finalizeBlobSettlement: async () => undefined,
		retireBlobSettlement: async () => undefined,
		abortBlobSettlementStage: async () => undefined,
		getExcludePatterns: () => [],
		getBlobQueuePersistenceScope: () => ({ ...retiredScope }),
		persistBlobQueue: async (snapshot: BlobQueueSnapshot, scope: typeof retiredScope) => {
			persistedRetirementSnapshot = snapshot;
			persistedRetirementScope = { ...scope };
			await persistGate.promise;
		},
		clearPersistedBlobQueue: async () => undefined,
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => undefined,
		hasPendingBlobIntentForPath: () => false,
		replayPendingBlobIntents: async () => undefined,
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		refreshStatusBar: () => undefined,
		log: () => undefined,
	} as any);
	(orchestrator as any).blobSync = fakeManager;
	(orchestrator as any).blobQueuePersistenceScopes.set(fakeManager, { ...retiredScope });
	(orchestrator as any).blobRuntimeAuthorities.set(fakeManager, {
		scope: { ...retiredScope },
		vaultSync: {},
		token: { identity: "test", epoch: 1 },
	});
	(orchestrator as any).start = () => { replacementStarts++; };

	const stopping = orchestrator.stop("idb-degraded-test");
	await Promise.resolve();
	assert(destroyStarted === 1, "retirement marks the old manager destroyed before queue persistence waits");
	assert(
		JSON.stringify(persistedRetirementScope) === JSON.stringify(retiredScope),
		"retirement persists with the manager's captured authority scope",
	);
	assert(
		persistedRetirementSnapshot?.uploads[0]?.deferredUntilSettlement === true,
		"retirement persists a settlement-deferred local edit before manager destroy",
	);
	const refreshing = orchestrator.refresh("capability-race-test");
	await Promise.resolve();
	assert(replacementStarts === 0, "refresh cannot start a replacement while queue persistence is pending");
	persistGate.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert(replacementStarts === 0, "refresh still waits for in-flight manager cleanup after persistence");
	destroyGate.resolve();
	await Promise.all([stopping, refreshing]);
	assert(replacementStarts === 1, "refresh starts exactly one replacement after full retirement");
	assert(
		(orchestrator as any).retiringBlobSyncs.size === 0
			&& (orchestrator as any).retiringBlobSyncTasks.size === 0,
		"retirement registries are empty before replacement authority can proceed",
	);
}

console.log("\n--- Test 15d.1a: setup-link scope changes cannot relabel a retiring queue ---");
{
	const oldScope = {
		host: "https://old.example.test",
		vaultId: "old-vault",
		localDeviceId: "device-a",
	};
	const newScope = {
		host: "https://new.example.test",
		vaultId: "new-vault",
		localDeviceId: "device-a",
	};
	let currentScope = { ...oldScope };
	let runtimeConfig = {
		enableAttachmentSync: true,
		host: oldScope.host,
		token: "token",
		vaultId: oldScope.vaultId,
		maxAttachmentSizeKB: 1024,
		attachmentConcurrency: 1,
		debug: false,
	};
	const persistedScopes: Array<typeof oldScope> = [];
	const observedMap = {
		observe: () => undefined,
		unobserve: () => undefined,
		get: () => undefined,
	};
	const app = {
		workspace: {
			layoutReady: true,
			onLayoutReady: () => undefined,
		},
		vault: {
			configDir: ".obsidian",
			getFiles: () => [],
			getAbstractFileByPath: () => null,
			adapter: { stat: async () => null },
		},
	} as any;
	const vaultSync = {
		pathToBlob: observedMap,
		blobTombstones: observedMap,
		getBlobRef: () => undefined,
		isBlobTombstoned: () => false,
	} as any;
	const orchestrator = new AttachmentOrchestrator({
		app,
		getVaultSync: () => vaultSync,
		getRuntimeConfig: () => runtimeConfig as any,
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getBlobSettledRefs: () => ({}),
		getBlobSettledSourceVersions: () => ({}),
		getBlobSettlementStages: () => ({}),
		captureBlobRuntimeAuthority: () => ({ identity: "test", epoch: 1 }),
		isBlobRuntimeAuthorityCurrent: () => true,
		isUploadAuthoritySourceReady: () => false,
		onBlobSettledRefsChanged: () => undefined,
		stageBlobSettlement: async () => undefined,
		finalizeBlobSettlement: async () => undefined,
		retireBlobSettlement: async () => undefined,
		abortBlobSettlementStage: async () => undefined,
		getExcludePatterns: () => [],
		getBlobQueuePersistenceScope: () => ({ ...currentScope }),
		persistBlobQueue: async (_snapshot, scope) => {
			persistedScopes.push({ ...scope });
		},
		clearPersistedBlobQueue: async () => undefined,
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => undefined,
		hasPendingBlobIntentForPath: () => false,
		replayPendingBlobIntents: async () => undefined,
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		refreshStatusBar: () => undefined,
		log: () => undefined,
	} as any);
	orchestrator.start("old-scope", false);
	const oldManager = orchestrator.manager!;
	(oldManager as any).exportQueue = () => ({
		uploads: [{ path: "assets/from-old-vault.png" }],
		downloads: [],
	});

	// Setup-link writes new settings before initSync retires the old manager.
	currentScope = { ...newScope };
	runtimeConfig = {
		...runtimeConfig,
		host: newScope.host,
		vaultId: newScope.vaultId,
	};
	await orchestrator.stop("setup-link-host-vault-change");
	assert(
		JSON.stringify(persistedScopes) === JSON.stringify([oldScope]),
		"old manager queue keeps its original host/vault/device scope after settings change",
	);

	await orchestrator.refresh("setup-link-restart");
	const replacement = orchestrator.manager;
	assert(
		replacement !== null
			&& replacement !== oldManager
			&& JSON.stringify(orchestrator.getQueuePersistenceScope(replacement))
				=== JSON.stringify(newScope),
		"refresh captures the new scope only for the replacement manager",
	);
	await orchestrator.destroy();
}

console.log("\n--- Test 15d.2: destroy joins a fire-and-forget stop retirement ---");
{
	const destroyGate = deferred<void>();
	let managerDestroyCalls = 0;
	let orchestratorDestroyed = false;
	const fakeManager = {
		closeUploadGate: () => undefined,
		closeDownloadGate: () => undefined,
		exportQueue: () => ({ uploads: [], downloads: [] }),
		destroy: async () => {
			managerDestroyCalls++;
			await destroyGate.promise;
		},
	} as unknown as BlobSyncManager;
	const orchestrator = new AttachmentOrchestrator({
		app: {
			workspace: {
				layoutReady: true,
				onLayoutReady: () => undefined,
			},
		} as any,
		getVaultSync: () => ({}) as any,
		getRuntimeConfig: () => ({ enableAttachmentSync: true }) as any,
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getBlobSettledRefs: () => ({}),
		getBlobSettledSourceVersions: () => ({}),
		getBlobSettlementStages: () => ({}),
		captureBlobRuntimeAuthority: () => ({ identity: "test", epoch: 1 }),
		isBlobRuntimeAuthorityCurrent: () => true,
		isUploadAuthoritySourceReady: () => true,
		onBlobSettledRefsChanged: () => undefined,
		stageBlobSettlement: async () => undefined,
		finalizeBlobSettlement: async () => undefined,
		retireBlobSettlement: async () => undefined,
		abortBlobSettlementStage: async () => undefined,
		getExcludePatterns: () => [],
		persistBlobQueue: async () => undefined,
		clearPersistedBlobQueue: async () => undefined,
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => undefined,
		hasPendingBlobIntentForPath: () => false,
		replayPendingBlobIntents: async () => undefined,
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		refreshStatusBar: () => undefined,
		log: () => undefined,
	} as any);
	(orchestrator as any).blobSync = fakeManager;
	const stopping = orchestrator.stop("fire-and-forget-test");
	const destroying = orchestrator.destroy().then(() => { orchestratorDestroyed = true; });
	await Promise.resolve();
	assert(managerDestroyCalls === 1, "concurrent stop/destroy retires the manager exactly once");
	assert(!orchestratorDestroyed, "orchestrator destroy waits for the already-retiring manager");
	destroyGate.resolve();
	await Promise.all([stopping, destroying]);
	assert(orchestratorDestroyed, "orchestrator destroy completes only after old manager cleanup");
}

console.log("\n--- Test 15d.3: pre-layout authority reruns replay + inventory before gates open ---");
{
	let layoutCallback: (() => void) | undefined;
	let uploadOpen = false;
	let downloadOpen = false;
	const order: string[] = [];
	const reconciled = deferred<void>();
	const fakeManager = {
		get isUploadGateOpen() { return uploadOpen; },
		get isDownloadGateOpen() { return downloadOpen; },
		pendingUploads: 0,
		pendingDownloads: 0,
		setInventoryGateReady: (ready: boolean) => {
			if (ready) order.push("inventory-ready");
		},
		reconcile: () => {
			order.push("reconcile");
			reconciled.resolve();
			return { uploadQueued: 0, downloadQueued: 0, skipped: 0 };
		},
		openUploadGate: () => { order.push("upload-open"); uploadOpen = true; },
		openDownloadGate: () => { order.push("download-open"); downloadOpen = true; },
		closeUploadGate: () => { uploadOpen = false; },
		closeDownloadGate: () => { downloadOpen = false; },
	} as unknown as BlobSyncManager;
	const orchestrator = new AttachmentOrchestrator({
		app: {
			workspace: {
				layoutReady: false,
				onLayoutReady: (callback: () => void) => { layoutCallback = callback; },
			},
		} as any,
		getVaultSync: () => null,
		getRuntimeConfig: () => ({}) as any,
		getServerSupportsAttachments: () => true,
		getTraceHttpContext: () => undefined,
		getBlobHashCache: () => ({}),
		getBlobSettledRefs: () => ({}),
		getBlobSettledSourceVersions: () => ({}),
		getBlobSettlementStages: () => ({}),
		captureBlobRuntimeAuthority: () => ({ identity: "test", epoch: 1 }),
		isBlobRuntimeAuthorityCurrent: () => true,
		isUploadAuthoritySourceReady: () => true,
		onBlobSettledRefsChanged: () => undefined,
		stageBlobSettlement: async () => undefined,
		finalizeBlobSettlement: async () => undefined,
		retireBlobSettlement: async () => undefined,
		abortBlobSettlementStage: async () => undefined,
		getExcludePatterns: () => [],
		persistBlobQueue: async () => undefined,
		clearPersistedBlobQueue: async () => undefined,
		getPreservedUnresolvedEntries: () => [],
		onPreservedUnresolvedChanged: () => undefined,
		hasPendingBlobIntentForPath: () => false,
		replayPendingBlobIntents: async () => { order.push("replay"); },
		trace: () => undefined,
		scheduleTraceStateSnapshot: () => undefined,
		refreshStatusBar: () => undefined,
		log: () => undefined,
	} as any);
	(orchestrator as any).blobSync = fakeManager;
	(orchestrator as any).blobRuntimeAuthorities.set(fakeManager, {
		scope: { host: "test", vaultId: "test", localDeviceId: "test" },
		vaultSync: {},
		token: { identity: "test", epoch: 1 },
	});

	orchestrator.markStartupReady("pre-layout-startup");
	orchestrator.markUploadAuthorityReady("pre-layout-authoritative-pass");
	assert(
		order.length === 0 && !uploadOpen && !downloadOpen,
		"pre-layout authority performs no inventory and opens neither transfer gate",
	);
	layoutCallback?.();
	await reconciled.promise;
	await Promise.resolve();
	assert(
		order.slice(0, 3).join(",") === "inventory-ready,replay,reconcile",
		"layout readiness opens inventory, then replays journal before authoritative scan",
	);
	assert(
		uploadOpen && downloadOpen
			&& order.indexOf("upload-open") > order.indexOf("reconcile")
			&& order.indexOf("download-open") > order.indexOf("reconcile"),
		"both transfer gates open only after the post-layout authority barrier",
	);
}

console.log("\n--- Test 15d.4: manager inventory itself is a pre-layout no-op ---");
{
	const { manager, put } = makeHarness();
	put("pre-layout-local.png", bytes("local file not yet safe to inventory"));
	(manager as any).vaultSync = {
		getBlobRef: () => undefined,
		isBlobTombstoned: () => false,
		pathToBlob: new Map(),
	};
	manager.closeUploadGate("pre-layout-test");
	manager.setInventoryGateReady(false, "pre-layout-test");
	const deferredResult = manager.reconcile("authoritative", []);
	assert(
		deferredResult.uploadQueued === 0 && manager.pendingUploads === 0,
		"pre-layout reconcile neither scans nor queues a provisional local upload",
	);
	manager.setInventoryGateReady(true, "layout-ready-test");
	const readyResult = manager.reconcile("authoritative", []);
	assert(
		readyResult.uploadQueued === 1 && manager.pendingUploads === 1,
		"the same file is inventoried only after layout authority is explicit",
	);
	await manager.destroy();
}

// ── Test 16: kickUploadDrain does not start duplicate drain loops ────────────

console.log("\n--- Test 16: concurrent kickUploadDrain does not duplicate drain ---");
{
	const { manager, put, traces } = makeHarness();

	// Force uploadDraining = true to simulate active drain
	(manager as any).uploadDraining = true;

	let drainCalled = false;
	const originalDrain = (manager as any).drainUploads.bind(manager);
	(manager as any).drainUploads = async () => {
		drainCalled = true;
		return originalDrain();
	};

	// Kick should be a no-op when already draining
	(manager as any).kickUploadDrain();

	assert(!drainCalled, "drainUploads NOT called when uploadDraining is true");

	// Reset and verify it would call if not draining
	(manager as any).uploadDraining = false;
	(manager as any).kickUploadDrain();

	// drainUploads should have been called (though it exits immediately with empty queue)
	assert(drainCalled, "drainUploads called when uploadDraining is false");
}

// ── Test 17: importQueue with rerunResets near cap ──────────────────────────

console.log("\n--- Test 17: importQueue preserves rerunResets near cap ---");
{
	const { manager } = makeHarness();
	(manager as any).__defaultBlobRefs.set("at-cap.png", { hash: "xyz", size: 200 });

	// Prevent drain from starting during import (we just want to check state)
	(manager as any).uploadDraining = true;
	(manager as any).downloadDraining = true;

	const snapshot = {
		uploads: [
			{ path: "near-cap.png", sizeBytes: 100, retries: 2, status: "pending" as const, readyAt: 0, needsRerun: true, rerunResets: 4 },
		],
		downloads: [
			{ path: "at-cap.png", hash: "xyz", sizeBytes: 200, retries: 3, status: "processing" as const, readyAt: 999, needsRerun: true, rerunResets: 5 },
		],
	};

	(manager as any).importQueue(snapshot);

	const uploadItem = (manager as any).uploadQueue.get("near-cap.png");
	assert(uploadItem !== undefined, "near-cap upload item imported");
	assert(uploadItem.rerunResets === 4, "rerunResets preserved at 4 (near cap)");
	assert(uploadItem.needsRerun === true, "needsRerun preserved");
	assert(uploadItem.status === "pending", "status normalized to pending on import");
	assert(uploadItem.readyAt === 0, "readyAt reset to 0 on import");

	const downloadItem = (manager as any).downloadQueue.get("at-cap.png");
	assert(downloadItem !== undefined, "at-cap download item imported");
	assert(downloadItem.rerunResets === 5, "rerunResets preserved at 5 (at cap)");
	assert(downloadItem.needsRerun === true, "needsRerun preserved for download");
	assert(downloadItem.status === "pending", "download status normalized to pending");
}

// ── Test 18: deferred authoritative retry does not cache unapplied bytes ────

console.log("\n--- Test 18: deferred authoritative retry does not pollute target hash cache ---");
{
	const { manager, files, put, traces } = makeHarness();
	const existing = put("target.png", bytes("local version"));

	// Seed hash cache for target with known value
	const originalHash = "original-target-hash";
	(manager as any).hashCache["target.png"] = {
		mtime: existing.file.stat.mtime,
		size: existing.file.stat.size,
		hash: originalHash,
	};

	// Simulate a local edit after the initial exact disk snapshot.
	const remoteData = bytes("remote version");
	const remoteHash = await sha256Hex(remoteData);
	(manager as any).__defaultBlobRefs.set("target.png", {
		hash: remoteHash,
		size: remoteData.byteLength,
	});
	(manager as any).blobClient = {
		download: async () => {
			put("target.png", bytes("local changed during download"));
			return remoteData;
		},
	};

	const item = {
		path: "target.png",
		hash: remoteHash,
		sizeBytes: remoteData.byteLength,
		status: "processing" as const,
		retries: 0,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};

	// Put a different cached hash; the exact read must still control the decision.
	const stat = existing.file.stat;
	(manager as any).hashCache["target.png"] = {
		mtime: stat.mtime,
		size: stat.size,
		hash: "different-from-remote",
	};

	await (manager as any).processDownload(item);

	// Verify target hash cache was NOT updated to remote hash
	const targetEntry = (manager as any).hashCache["target.png"];
	assert(
		targetEntry?.hash !== remoteHash,
		"target hash cache is not updated to unapplied remote bytes",
	);
	assert(
		typeof targetEntry?.hash === "string" && targetEntry.hash.length > 0,
		"target hash cache keeps a local-file hash after the deferred attempt",
	);
	assert(item.status === "pending", "the changed disk epoch remains queued for a fresh attempt");
	assert(!Array.from(files.keys()).some((path) => path.includes("KAOS remote conflict")), "the deferred attempt emits no conflict artifact");
	assert(traces.some((event) => event.msg === "authoritative-remote-retry"), "the deferred attempt records its retry reason");

	await manager.destroy();
}

console.log("\n--- Test 19: Multi-pass: unknown-baseline preserved blob is NOT re-uploaded by reconcile scan ---");
{
	// This is the critical system-level test for blob paths.
	// Scenario:
	// 1. Local blob file exists (image.png).
	// 2. A legacy remote tombstone arrives without self-contained deletedRef.
	// 3. Handler preserves file as unresolved, does NOT clear tombstone.
	// 4. reconcile() runs (next pass) — sees local file + tombstoned path.
	// 5. Assert: file is NOT queued for upload, tombstone is NOT cleared.
	// 6. A later watcher modify event still cannot clear remote-delete Attention;
	//    resolving that tombstone requires an explicit dashboard action.

	const { manager, put, traces } = makeHarness();

	// Set up: local file exists
	put("attachments/preserved.png", bytes("local image data"));

	// Simulate: the vaultSync has this path tombstoned
	const vaultSync = {
		pathToBlob: new Map(),
		getAuthoritativeBlobDeleteSnapshot: (path: string) =>
			path === "attachments/preserved.png"
				? { fingerprint: "legacy-delete-without-ref" }
				: null,
		isBlobTombstoned: (path: string) => path === "attachments/preserved.png",
		blobTombstones: new Map([["attachments/preserved.png", true]]),
		getBlobRef: () => undefined,
		setBlobRef: () => { throw new Error("setBlobRef should not be called"); },
		deleteBlobRef: () => {},
	};
	(manager as any).vaultSync = vaultSync;

	// Step 2–3: legacy tombstone with no deletedRef baseline.
	await (manager as any).handleRemoteDelete("attachments/preserved.png");

	// Verify: path is in preservedUnresolvedPaths
	assert(
		(manager as any).preservedUnresolvedPaths.has("attachments/preserved.png"),
		"blob path recorded as preserved-unresolved after unknown-baseline remote-delete",
	);

	// Verify: tombstone was NOT cleared
	assert(
		vaultSync.blobTombstones.has("attachments/preserved.png"),
		"blob tombstone remains after preserve-unresolved",
	);

	// Step 4: Run reconcile scan
	// Add vault.getFiles() to return the local file
	const localFile = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	localFile.path = "attachments/preserved.png";
	(localFile as any).stat = { mtime: 5, size: 16 };
	(manager as any).app = {
		vault: {
			getFiles: () => [localFile],
			getAbstractFileByPath: () => localFile,
			configDir: ".obsidian",
		},
	};

	const result = manager.reconcile("authoritative", []);

	// Step 5: Assert file was NOT queued for upload
	assert(
		result.uploadQueued === 0,
		"preserved-unresolved blob NOT queued for upload by reconcile",
	);
	assert(
		result.skipped >= 1,
		"preserved-unresolved blob counted as skipped",
	);
	assert(
		!(manager as any).uploadQueue.has("attachments/preserved.png"),
		"upload queue does NOT contain preserved-unresolved path",
	);

	// Verify tombstone still present
	assert(
		vaultSync.blobTombstones.has("attachments/preserved.png"),
		"blob tombstone still present after reconcile",
	);

	// Step 6: A watcher modify event cannot implicitly resolve remote-delete
	// authority; only explicit dashboard Keep-local/Accept-remote may do that.
	(manager as any).preservedUnresolvedPaths.add("attachments/preserved.png"); // re-add for clarity
	const fakeFile = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	fakeFile.path = "attachments/preserved.png";
	(fakeFile as any).stat = { mtime: 10, size: 20 };

	// Suppress the debounce timer to avoid async issues
	manager.handleFileChange(fakeFile);
	assert(
		(manager as any).preservedUnresolvedPaths.has("attachments/preserved.png"),
		"remote-delete Attention survives an ordinary watcher modify event",
	);

	await manager.destroy();
}

console.log("\n--- Test 20: Multi-pass: stat-failure during blob remote-delete becomes preserve-unresolved ---");
{
	const { manager, put, traces } = makeHarness();
	const path = "attachments/stat-fails.png";
	const data = bytes("file data");
	const hash = await sha256Hex(data);
	put(path, data);
	installRemoteDeleteAuthority(manager, path, { hash, size: data.byteLength });

	// Override stat to throw
	(manager as any).app.vault.adapter.stat = async () => { throw new Error("EBUSY"); };

	await (manager as any).handleRemoteDelete(path);

	// File should NOT be deleted (check that delete was not called)
	const deleteTrace = traces.find((t) => t.msg === "remote-delete-applied");
	assert(!deleteTrace, "file NOT deleted when stat fails");

	// Should be preserved-unresolved
	const preserveTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "remote-delete-conflict-preserved" && t.details?.reason === "stat-failed-cannot-verify",
	);
	assert(!!preserveTrace, "preserve trace emitted with stat-failed reason");
	assert(
		(manager as any).preservedUnresolvedPaths.has(path),
		"blob path recorded as preserved-unresolved after stat failure",
	);
}

console.log("\n--- Test 21: processUpload skips preserved-unresolved paths (queue snapshot resurrection guard) ---");
{
	const { manager, put, traces } = makeHarness();

	put("attachments/zombie.png", bytes("zombie data"));

	// Mark path as preserved-unresolved (simulates prior remote-delete with unknown baseline)
	(manager as any).preservedUnresolvedPaths.add("attachments/zombie.png");

	// Simulate a stale queue entry that slipped through (e.g., from importQueue)
	const item = {
		path: "attachments/zombie.png",
		sizeBytes: 11,
		retries: 0,
		status: "processing" as const,
		readyAt: 0,
		needsRerun: false,
		rerunResets: 0,
	};
	(manager as any).uploadQueue.set("attachments/zombie.png", item);

	// Process the upload — should be blocked by the guard
	await (manager as any).processUpload(item);

	// Upload should have been removed from queue without uploading
	assert(
		!(manager as any).uploadQueue.has("attachments/zombie.png"),
		"stale upload removed from queue",
	);
	const skipTrace = traces.find(
		(t) => t.source === "blob" && t.msg === "upload-skipped-preserved-unresolved",
	);
	assert(!!skipTrace, "trace emitted for skipped preserved-unresolved upload");
}

console.log("\n--- Test 22: upload commit rejects same-TFile mutation and TFile ABA ---");
for (const replacementMode of ["same-file", "tfile-aba"] as const) {
	const { manager, put, replace } = makeHarness();
	const path = `upload-${replacementMode}.png`;
	const first = bytes(`C1-${replacementMode}`);
	const second = bytes(`C2-${replacementMode}`);
	const firstHash = await sha256Hex(first);
	const secondHash = await sha256Hex(second);
	put(path, first);
	let currentRef: { hash: string; size: number } | undefined;
	const committed: Array<{ hash: string; size: number }> = [];
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		setBlobRef: (_path: string, hash: string, size: number) => {
			committed.push({ hash, size });
			currentRef = { hash, size };
		},
		isBlobTombstoned: () => false,
		pathToBlob: new Map(),
	};
	(manager as any).kickUploadDrain = () => {};
	const firstUploadStarted = deferred<void>();
	const releaseFirstUpload = deferred<void>();
	(manager as any).blobClient = {
		exists: async () => [],
		upload: async (hash: string) => {
			if (hash === firstHash) {
				firstUploadStarted.resolve();
				await releaseFirstUpload.promise;
				return;
			}
			assert(hash === secondHash, `${replacementMode}: rerun uploads C2`);
		},
	};
	(manager as any).enqueueUpload(path, 0, first.byteLength);
	const item = (manager as any).uploadQueue.get(path);
	item.status = "processing";
	const firstAttempt = (manager as any).processUpload(item);
	await firstUploadStarted.promise;
	if (replacementMode === "same-file") put(path, second);
	else replace(path, second);
	(manager as any).enqueueUpload(path, 0, second.byteLength);
	releaseFirstUpload.resolve();
	await firstAttempt;

	assert(committed.length === 0, `${replacementMode}: stale C1 ref is never published`);
	assert(item.status === "pending", `${replacementMode}: C2 remains queued after stale settlement`);
	item.status = "processing";
	await (manager as any).processUpload(item);
	assert(
		committed.length === 1 && committed[0]?.hash === secondHash,
		`${replacementMode}: only the fresh C2 ref is published`,
	);
	assert(
		committed[0]?.size === second.byteLength,
		`${replacementMode}: C2 commit uses the freshly verified size`,
	);
}

console.log("\n--- Test 23: promise-reaction edits before settled-base publication fail closed ---");
for (const replacementMode of ["same-file", "tfile-aba"] as const) {
	const { manager, files, put, replace } = makeHarness();
	const path = `upload-microtask-${replacementMode}.png`;
	const first = bytes(`C1-${replacementMode}`);
	const second = bytes(`C2-${replacementMode}`);
	const firstHash = await sha256Hex(first);
	const initial = put(path, first);
	(manager as any).hashCache[path] = {
		mtime: initial.file.stat.mtime,
		size: initial.file.stat.size,
		hash: firstHash,
	};

	let currentRef: { hash: string; size: number } | undefined;
	const commits: Array<{ hash: string; diskContent: string }> = [];
	(manager as any).vaultSync = {
		getBlobRef: () => currentRef,
		setBlobRef: (_path: string, hash: string, size: number) => {
			commits.push({
				hash,
				diskContent: text(files.get(path)!.data),
			});
			currentRef = { hash, size };
		},
		isBlobTombstoned: () => false,
		pathToBlob: new Map(),
	};
	(manager as any).blobClient = {
		exists: async (hashes: string[]) => hashes,
		upload: async () => { throw new Error("deduplicated upload should not PUT"); },
	};
	(manager as any).kickUploadDrain = () => {};
	// This test manually owns the authoritative recovery attempt below.
	// Keep the background drain from racing that exact queue item on Node 20 CI.
	(manager as any).kickDownloadDrain = () => {};
	(manager as any).enqueueUpload(path, 0, first.byteLength);
	const item = (manager as any).uploadQueue.get(path);
	item.status = "processing";

	const originalReadAndHash = (manager as any).readAndHashExactExistingFile.bind(manager);
	let armPostResolutionRace = true;
	(manager as any).readAndHashExactExistingFile = async (...args: unknown[]) => {
		const snapshot = await originalReadAndHash(...args);
		if (armPostResolutionRace) {
			armPostResolutionRace = false;
			queueMicrotask(() => {
				if (replacementMode === "same-file") put(path, second);
				else replace(path, second);
				// Model the vault change event that advances the in-flight queue item.
				(manager as any).enqueueUpload(path, 0, second.byteLength);
			});
		}
		return snapshot;
	};

	await (manager as any).processUpload(item);
	assert(
		commits.length === 1
			&& commits[0]?.hash === firstHash
			&& commits[0]?.diskContent === text(first),
		`${replacementMode}: H1 commits only while the exact C1 disk epoch is current`,
	);
	assert(
		item.status === "pending" && item.needsRerun === false,
		`${replacementMode}: post-commit C2 queue advance is retained as a rerun`,
	);

	(manager as any).readAndHashExactExistingFile = originalReadAndHash;
	item.status = "processing";
	await (manager as any).processUpload(item);
	assert(
		commits.length === 1,
		`${replacementMode}: C2 captured before H1 settlement is never auto-published`,
	);
	const recovery: any = (manager as any).downloadQueue.get(path);
	assert(
		recovery?.hash === firstHash,
		`${replacementMode}: unknown C2 base schedules the authoritative H1 recovery`,
	);
	(manager as any).blobClient = { download: async () => first };
	recovery.status = "processing";
	await (manager as any).processDownload(recovery);
	assert(
		text(files.get(path)!.data) === text(first),
		`${replacementMode}: stale upload recovery installs authoritative H1`,
	);
	const backup = findVisibleLocalBackupPath(files, path);
	assert(
		backup ? text(files.get(backup)!.data) === text(second) : false,
		`${replacementMode}: stale C2 remains in a local safety backup`,
	);
	assert(
		!manager.isPreservedUnresolved(path),
		`${replacementMode}: recovery converges without durable Attention`,
	);
	assert(
		!Array.from(files.keys()).some((candidate) => candidate.includes("KAOS remote conflict")),
		`${replacementMode}: recovery creates no remote conflict artifact`,
	);
}

// ── Test 24: excluded remote tombstones do not delete local tool files ──────

console.log("\n--- Test 24: excluded remote delete leaves local tool file untouched ---");
{
	const { app, manager, files, put } = makeHarness(
		(path) => !path.includes("/node_modules/"),
	);
	put("tools/node_modules/cache.bin", bytes("local tool cache"));
	const deletedPaths: string[] = [];
	(app as any).vault.delete = async (file: TFile & { path: string }) => {
		deletedPaths.push(file.path);
		files.delete(file.path);
	};

	await (manager as any).handleRemoteDelete("tools/node_modules/cache.bin", "known-hash");

	assert(files.has("tools/node_modules/cache.bin"), "excluded tool file is preserved locally");
	assert(deletedPaths.length === 0, "excluded remote delete does not call vault.delete");
}

// ── Test 25: transient HTTP exhaustion remains durably retryable ───────────

console.log("\n--- Test 25: transient download failure retains automatic recovery intent ---");
{
	const { manager } = makeHarness();
	const path = "assets/transient-download.png";
	const data = bytes("eventually available");
	const hash = await sha256Hex(data);
	(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
	(manager as any).enqueueDownload(path, hash, data.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.retries = 3;
	item.status = "processing";
	let retryDelay = 0;
	(manager as any).scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	(manager as any).blobClient = {
		download: async () => {
			throw Object.assign(new Error("temporary 503/network failure"), { status: 503 });
		},
	};
	await (manager as any).processDownload(item);
	assert(
		(manager as any).downloadQueue.get(path) === item,
		"transient retry exhaustion retains the download queue item",
	);
	assert(item.retries === 0, "the next retry cycle receives a fresh bounded budget");
	assert(item.readyAt > Date.now() && retryDelay > 0, "automatic recovery is delayed with backoff");
}

// ── Test 26: terminal HTTP errors do not retry forever ─────────────────────

console.log("\n--- Test 26: terminal download HTTP error retires queue item ---");
{
	const { manager } = makeHarness();
	const path = "assets/forbidden-download.png";
	const data = bytes("forbidden");
	const hash = await sha256Hex(data);
	(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
	(manager as any).enqueueDownload(path, hash, data.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.retries = 3;
	item.status = "processing";
	(manager as any).blobClient = {
		download: async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); },
	};
	const originalError = console.error;
	console.error = () => {};
	try {
		await (manager as any).processDownload(item);
	} finally {
		console.error = originalError;
	}
	assert(!(manager as any).downloadQueue.has(path), "terminal 4xx response retires the download item");
}

// Exercise the real BlobHttpClient -> Obsidian requestUrl boundary. Obsidian's
// default is throw=true for 400+, so this seam rejects unless production passes
// throw:false and classifies the returned status itself.
console.log("\n--- Test 27: BlobHttpClient preserves HTTP status classification ---");
{
	const requestOptions: Array<{ throw?: boolean }> = [];
	(globalThis as {
		__KAOS_TEST_REQUEST_URL__?: (request: unknown) => Promise<unknown>;
	}).__KAOS_TEST_REQUEST_URL__ = async (request) => {
		const options = request as { throw?: boolean };
		requestOptions.push(options);
		if (options.throw !== false) throw new Error("Obsidian default HTTP rejection");
		return {
			status: 403,
			text: "forbidden",
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			headers: {},
		};
	};
	try {
		const { manager } = makeHarness();
		const path = "assets/real-client-forbidden.png";
		const data = bytes("forbidden");
		const hash = await sha256Hex(data);
		(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
		(manager as any).enqueueDownload(path, hash, data.byteLength);
		const item = (manager as any).downloadQueue.get(path);
		item.retries = 3;
		item.status = "processing";
		const originalError = console.error;
		console.error = () => {};
		try {
			await (manager as any).processDownload(item);
		} finally {
			console.error = originalError;
		}
		assert(requestOptions.length === 1, "real blob client performs one HTTP request");
		assert(requestOptions[0]?.throw === false, "real blob client disables Obsidian's implicit HTTP throw");
		assert(!(manager as any).downloadQueue.has(path), "real-client 403 remains terminal instead of entering a retry loop");
	} finally {
		delete (globalThis as { __KAOS_TEST_REQUEST_URL__?: unknown }).__KAOS_TEST_REQUEST_URL__;
	}
}

// A local filesystem outage is transient just like a network outage. After a
// bounded retry cycle, retain the exact remote intent instead of dropping it as
// a permanent download failure.
console.log("\n--- Test 28: transient createBinary failure retains recovery intent ---");
{
	const { app, manager } = makeHarness();
	const path = "assets/transient-create.png";
	const data = bytes("downloaded while storage is unavailable");
	const hash = await sha256Hex(data);
	(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
	(manager as any).enqueueDownload(path, hash, data.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.retries = 3;
	item.status = "processing";
	let retryDelay = 0;
	let createCalls = 0;
	(manager as any).scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	(manager as any).blobClient = { download: async () => data };
	app.vault.createBinary = async () => {
		createCalls++;
		throw new Error("temporary filesystem busy");
	};

	await (manager as any).processDownload(item);
	assert(createCalls === 1, "the storage write is attempted once in the exhausted cycle");
	assert(
		(manager as any).downloadQueue.get(path) === item,
		"transient createBinary exhaustion retains the download queue item",
	);
	assert(item.retries === 0, "transient storage failure starts a fresh bounded retry cycle");
	assert(item.readyAt > Date.now() && retryDelay > 0, "storage recovery is delayed with backoff");
	assert(
		!(manager as any).settlementStages[path],
		"the failed pre-create settlement stage is safely aborted before retry",
	);
}

// The file can be present even though the first post-create verification read
// failed. The durable stage must be resumable instead of becoming a permanent
// blocker that also suppresses future local uploads.
console.log("\n--- Test 29: post-create read failure resumes durable settlement ---");
{
	const settledRefs: Record<string, BlobRef> = {};
	const { app, manager, files } = makeHarness(() => true, settledRefs);
	const path = "assets/post-create-read-retry.png";
	const data = bytes("created before the first verification read fails");
	const hash = await sha256Hex(data);
	(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
	(manager as any).enqueueDownload(path, hash, data.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.retries = 3;
	item.status = "processing";
	(manager as any).blobClient = { download: async () => data };
	let retryDelay = 0;
	(manager as any).scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	const originalReadBinary = app.vault.readBinary;
	let targetReads = 0;
	let createCalls = 0;
	const originalCreateBinary = app.vault.createBinary;
	app.vault.createBinary = async (candidate: string, candidateData: ArrayBuffer) => {
		createCalls++;
		return await originalCreateBinary(candidate, candidateData);
	};
	app.vault.readBinary = async (file: TFile & { path: string }) => {
		if (file.path === path && targetReads++ === 0) {
			throw new Error("temporary post-create read failure");
		}
		return await originalReadBinary(file);
	};

	await (manager as any).processDownload(item);
	assert(files.has(path), "createBinary materializes the exact target before verification fails");
	assert(
		(manager as any).settlementStages[path]?.kind === "download",
		"the durable download stage remains available for exact resumption",
	);
	assert((manager as any).downloadQueue.get(path) === item, "the retry intent remains queued");
	assert(
		item.retries === 0 && item.readyAt > Date.now() && retryDelay > 0,
		"post-create read exhaustion starts another bounded recovery cycle",
	);

	item.readyAt = 0;
	item.status = "processing";
	await (manager as any).processDownload(item);
	assert(createCalls === 1, "resumption verifies the existing target without creating it twice");
	assert(!(manager as any).settlementStages[path], "the resumed exact stage finalizes");
	assert(!(manager as any).downloadQueue.has(path), "successful resumption retires the queue item");
	assert(settledRefs[path]?.hash === hash, "resumption records the exact authoritative settlement");
}

// A finalization call may reject before committing anything. Retrying must use
// the still-owned stage and exact disk bytes rather than discarding the queue.
console.log("\n--- Test 30: post-create finalize failure resumes durable settlement ---");
{
	const settledRefs: Record<string, BlobRef> = {};
	const { app, manager } = makeHarness(() => true, settledRefs);
	const path = "assets/post-create-finalize-retry.png";
	const data = bytes("created before settlement persistence rejects");
	const hash = await sha256Hex(data);
	(manager as any).__defaultBlobRefs.set(path, { hash, size: data.byteLength });
	(manager as any).enqueueDownload(path, hash, data.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.retries = 3;
	item.status = "processing";
	(manager as any).blobClient = { download: async () => data };
	let retryDelay = 0;
	(manager as any).scheduleRetryKick = (delay: number) => { retryDelay = delay; };
	let createCalls = 0;
	const originalCreateBinary = app.vault.createBinary;
	app.vault.createBinary = async (candidate: string, candidateData: ArrayBuffer) => {
		createCalls++;
		return await originalCreateBinary(candidate, candidateData);
	};
	let failSettlement = true;
	(manager as any).settlementPersistence = {
		stage: async (candidate: string, stage: unknown) => {
			(manager as any).settlementStages[candidate] = stage;
		},
		finalize: async (
			candidate: string,
			_stageId: string,
			ref: BlobRef,
		) => {
			if (failSettlement) {
				failSettlement = false;
				throw new Error("temporary settlement persistence failure");
			}
			settledRefs[candidate] = { ...ref };
			delete (manager as any).settlementStages[candidate];
		},
		retire: async () => {},
		abort: async (candidate: string) => {
			delete (manager as any).settlementStages[candidate];
		},
	};

	await (manager as any).processDownload(item);
	assert(
		(manager as any).settlementStages[path]?.kind === "download",
		"a rejected finalize retains its exact durable stage",
	);
	assert((manager as any).downloadQueue.get(path) === item, "finalize rejection retains retry intent");
	assert(
		item.retries === 0 && item.readyAt > Date.now() && retryDelay > 0,
		"settlement persistence exhaustion starts another bounded recovery cycle",
	);

	item.readyAt = 0;
	item.status = "processing";
	await (manager as any).processDownload(item);
	assert(createCalls === 1, "finalize resumption does not rewrite the canonical target");
	assert(!(manager as any).settlementStages[path], "the retried finalization clears its stage");
	assert(!(manager as any).downloadQueue.has(path), "the settled retry retires its queue item");
	assert(settledRefs[path]?.hash === hash, "the retried finalization records settlement");
}

// The downloaded bytes are visible before durable settlement persistence has
// necessarily returned. A user or headless filesystem watcher may modify that
// exact path in the meantime. The event is a real local intent and must be
// admitted once the download stage retires instead of disappearing forever.
console.log("\n--- Test 31: a local edit during download finalization is admitted afterward ---");
{
	const settledRefs: Record<string, BlobRef> = {};
	const { manager, put } = makeHarness(() => true, settledRefs);
	const path = "assets/edit-during-download-finalize.png";
	const remoteData = bytes("remote bytes are already visible");
	const localData = bytes("local edit while settlement persists");
	const remoteHash = await sha256Hex(remoteData);
	(manager as any).__defaultBlobRefs.set(path, {
		hash: remoteHash,
		size: remoteData.byteLength,
	});
	(manager as any).enqueueDownload(path, remoteHash, remoteData.byteLength);
	const item = (manager as any).downloadQueue.get(path);
	item.status = "processing";
	(manager as any).blobClient = { download: async () => remoteData };
	(manager as any).kickUploadDrain = () => {};

	const finalizeStarted = deferred<void>();
	const allowFinalize = deferred<void>();
	(manager as any).settlementPersistence = {
		stage: async (candidate: string, stage: unknown) => {
			(manager as any).settlementStages[candidate] = stage;
		},
		finalize: async (
			candidate: string,
			_stageId: string,
			ref: BlobRef,
			sourceVersion: string,
		) => {
			finalizeStarted.resolve();
			await allowFinalize.promise;
			settledRefs[candidate] = { ...ref };
			(manager as any).settledSourceVersions[candidate] = sourceVersion;
			delete (manager as any).settlementStages[candidate];
		},
		retire: async () => {},
		abort: async (candidate: string) => {
			delete (manager as any).settlementStages[candidate];
		},
	};

	const download = (manager as any).processDownload(item);
	await finalizeStarted.promise;
	const edited = put(path, localData);
	(manager as any).enqueueUpload(path, 0, edited.file.stat.size);
	assert(
		!(manager as any).uploadQueue.has(path),
		"the local edit waits while the exact download stage still owns settlement",
	);
	const retirementSnapshot = manager.exportQueue();
	const deferredMarker = retirementSnapshot.uploads.find(
		(entry) => entry.path === path,
	);
	assert(
		deferredMarker?.deferredUntilSettlement === true,
		"manager retirement exports the settlement-deferred local intent",
	);
	assert(
		deferredMarker?.baseRefKnown === false
			&& deferredMarker.expectedBaseRef === undefined,
		"the durable marker borrows no causal base before settlement",
	);

	allowFinalize.resolve();
	await download;
	const queued = (manager as any).uploadQueue.get(path);
	assert(!!queued, "the deferred local edit is admitted after download settlement");
	assert(
		queued?.expectedBaseRef?.hash === remoteHash,
		"the deferred upload uses the finalized remote ref as its causal base",
	);
	await manager.destroy();
}

// Exact-existing downloads use an equality stage rather than a download stage.
// The same defer-and-recapture contract must survive a manager restart there too.
console.log("\n--- Test 32: equality-stage local edit survives queue export/import ---");
{
	const path = "assets/equality-stage-edit.png";
	const remoteData = bytes("remote equality base");
	const localData = bytes("local successor during equality settlement");
	const remoteHash = await sha256Hex(remoteData);
	const remoteRef: BlobRef = { hash: remoteHash, size: remoteData.byteLength };
	const settledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { manager, put } = makeHarness(() => true, settledRefs);
	put(path, localData);
	(manager as any).kickUploadDrain = () => {};
	const sourceVersion = (manager as any).vaultSync.getBlobSourceVersion(path);
	const equalityStage = {
		stageId: "equality-stage-before-restart",
		kind: "equality",
		ref: { ...remoteRef },
		sourceVersion,
		stagedAt: Date.now(),
	};
	(manager as any).settlementStages[path] = equalityStage;
	(manager as any).enqueueUpload(path, 0, localData.byteLength);
	assert(
		(manager as any).deferredUploadsAfterSettlement.has(path),
		"download-owned equality settlement defers the local edit",
	);
	const snapshot = manager.exportQueue();
	assert(
		snapshot.uploads.some(
			(entry) => entry.path === path && entry.deferredUntilSettlement === true,
		),
		"equality-stage deferred intent is durable in the queue snapshot",
	);

	const restoredSettledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { manager: restored, put: restoredPut } = makeHarness(
		() => true,
		restoredSettledRefs,
	);
	restoredPut(path, localData);
	(restored as any).kickUploadDrain = () => {};
	const restoredSourceVersion = (restored as any).vaultSync.getBlobSourceVersion(path);
	const restoredStage = {
		...equalityStage,
		sourceVersion: restoredSourceVersion,
	};
	(restored as any).settlementStages[path] = restoredStage;
	restored.importQueue(snapshot);
	assert(
		(restored as any).deferredUploadsAfterSettlement.has(path)
			&& !(restored as any).uploadQueue.has(path),
		"restart retains the marker without uploading through the unresolved stage",
	);
	await (restored as any).finalizeSettlementStage(
		path,
		restoredStage,
		remoteRef,
		restoredSourceVersion,
	);
	const restoredUpload = (restored as any).uploadQueue.get(path);
	assert(
		!!restoredUpload,
		"finalizing the restored equality stage admits the local successor",
	);
	assert(
		restoredUpload?.expectedBaseRef?.hash === remoteHash,
		"the restored successor captures the finalized equality ref as its base",
	);
	await Promise.all([manager.destroy(), restored.destroy()]);
}

// The public vault-event path waits in uploadDebounce before enqueueUpload(). A
// retirement snapshot taken in that window must still preserve the edit as a
// settlement-deferred intent rather than serializing an ordinary unknown-base
// upload that importQueue will discard behind the active stage.
console.log("\n--- Test 33: debounced local edit exports as settlement-deferred intent ---");
{
	const path = "assets/debounced-edit-during-download.png";
	const remoteData = bytes("remote base before debounced edit");
	const localData = bytes("local edit still inside debounce");
	const remoteHash = await sha256Hex(remoteData);
	const remoteRef: BlobRef = { hash: remoteHash, size: remoteData.byteLength };
	const settledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { manager, put } = makeHarness(() => true, settledRefs);
	const edited = put(path, localData);
	(manager as any).kickUploadDrain = () => {};
	const sourceVersion = (manager as any).vaultSync.getBlobSourceVersion(path);
	const downloadStage = {
		stageId: "download-stage-before-debounce-fires",
		kind: "download",
		ref: { ...remoteRef },
		sourceVersion,
		stagedAt: Date.now(),
	};

	manager.handleFileChange(edited.file);
	// The remote stage can begin after the watcher scheduled its debounce but
	// before either the timer or manager-retirement snapshot runs.
	(manager as any).settlementStages[path] = downloadStage;
	const snapshot = manager.exportQueue();
	const pathUploads = snapshot.uploads.filter((entry) => entry.path === path);
	assert(
		pathUploads.length === 1
			&& pathUploads[0]?.deferredUntilSettlement === true,
		"retirement before debounce fires exports exactly one deferred marker",
	);
	assert(
		pathUploads[0]?.baseRefKnown === false
			&& pathUploads[0]?.expectedBaseRef === undefined
			&& pathUploads[0]?.expectedBaseSourceVersion === undefined,
		"the debounced marker borrows no settlement-owned causal authority",
	);

	const restoredSettledRefs: Record<string, BlobRef> = { [path]: remoteRef };
	const { manager: restored, put: restoredPut } = makeHarness(
		() => true,
		restoredSettledRefs,
	);
	restoredPut(path, localData);
	(restored as any).kickUploadDrain = () => {};
	const restoredSourceVersion = (restored as any).vaultSync.getBlobSourceVersion(path);
	const restoredStage = {
		...downloadStage,
		sourceVersion: restoredSourceVersion,
	};
	(restored as any).settlementStages[path] = restoredStage;
	restored.importQueue(snapshot);
	assert(
		(restored as any).deferredUploadsAfterSettlement.has(path)
			&& !(restored as any).uploadQueue.has(path),
		"restart holds the debounced edit behind the restored download stage",
	);
	await (restored as any).finalizeSettlementStage(
		path,
		restoredStage,
		remoteRef,
		restoredSourceVersion,
	);
	const restoredUpload = (restored as any).uploadQueue.get(path);
	assert(
		restoredUpload?.expectedBaseRef?.hash === remoteHash,
		"the resumed debounced edit captures the finalized remote base",
	);
	await Promise.all([manager.destroy(), restored.destroy()]);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
