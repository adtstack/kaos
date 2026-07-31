import assert from "node:assert/strict";
import { BlobSyncManager, type BlobQueueSnapshot } from "../src/sync/blobSync";
import {
	createPersistedBlobQueueSnapshot,
	readPersistedBlobQueueSnapshot,
} from "../src/sync/persistedBlobQueue";
import type { PendingBlobIntentScope } from "../src/sync/pendingBlobIntentJournal";
import type { BlobRef } from "../src/types";

const SCOPE: PendingBlobIntentScope = {
	host: "https://sync.example.test",
	vaultId: "vault-a",
	localDeviceId: "device-a",
};
const LIVE_REF: BlobRef = { hash: "a".repeat(64), size: 17 };
const SOURCE_VERSION = "17:23";

function jsonValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function liveBaseUpload(
	overrides: Partial<BlobQueueSnapshot["uploads"][number]> = {},
): BlobQueueSnapshot["uploads"][number] {
	return {
		path: "assets/live-base.png",
		baseRefKnown: true,
		expectedBaseRef: LIVE_REF,
		causalBaseRef: LIVE_REF,
		expectedBaseSourceVersion: SOURCE_VERSION,
		status: "processing",
		...overrides,
	};
}

function makeManager(): BlobSyncManager {
	const manager = new BlobSyncManager(
		{
			vault: {
				configDir: ".obsidian",
				getFiles: () => [],
				getAbstractFileByPath: () => null,
			},
		} as never,
		{
			getBlobRef: () => LIVE_REF,
		} as never,
		{
			host: "https://worker.example.test",
			token: "token",
			vaultId: "vault-a",
			maxAttachmentSizeKB: 1024,
			attachmentConcurrency: 1,
			debug: false,
		},
		{},
	);
	// Keep import deterministic; the test inspects the queue rather than running
	// a transfer against the intentionally minimal VaultSync double.
	(manager as unknown as { uploadDraining: boolean }).uploadDraining = true;
	return manager;
}

console.log("\n--- Persisted blob queue: exact live-base source version ---");
{
	const queue: BlobQueueSnapshot = {
		uploads: [liveBaseUpload()],
		downloads: [],
	};
	const persisted = createPersistedBlobQueueSnapshot(queue, SCOPE);
	const restored = readPersistedBlobQueueSnapshot(persisted, SCOPE);
	assert.equal(
		restored?.uploads[0]?.expectedBaseSourceVersion,
		SOURCE_VERSION,
		"the exact Y.Map item source version survives persistence",
	);
	assert.deepEqual(
		jsonValue(restored),
		jsonValue(queue),
		"the complete live-base upload round-trips",
	);
}

console.log("\n--- Persisted blob queue: legacy or malformed live-base proof fails closed ---");
{
	const valid = createPersistedBlobQueueSnapshot({
		uploads: [liveBaseUpload()],
		downloads: [],
	}, SCOPE);
	const legacy = structuredClone(valid) as unknown as {
		queue: { uploads: Array<Record<string, unknown>> };
	};
	delete legacy.queue.uploads[0]?.expectedBaseSourceVersion;
	assert.equal(
		readPersistedBlobQueueSnapshot(legacy, SCOPE),
		null,
		"a legacy live-base upload without source version is scrubbed",
	);
	assert.throws(
		() => createPersistedBlobQueueSnapshot({
			uploads: [liveBaseUpload({ expectedBaseSourceVersion: undefined })],
			downloads: [],
		}, SCOPE),
		/invalid blob queue snapshot/i,
		"new persistence cannot emit a live-base upload without source version",
	);

	for (const malformed of ["client:clock", "1:-1", "", "9007199254740992:1"]) {
		const payload = structuredClone(valid) as unknown as {
			queue: { uploads: Array<Record<string, unknown>> };
		};
		payload.queue.uploads[0]!.expectedBaseSourceVersion = malformed;
		assert.equal(
			readPersistedBlobQueueSnapshot(payload, SCOPE),
			null,
			`malformed source version ${JSON.stringify(malformed)} is rejected`,
		);
	}
}

console.log("\n--- Persisted blob queue: absence and delete-resolution authority need no live version ---");
{
	const knownAbsent: BlobQueueSnapshot = {
		uploads: [{
			path: "assets/new-local.png",
			baseRefKnown: true,
		}],
		downloads: [],
	};
	assert.deepEqual(
		jsonValue(readPersistedBlobQueueSnapshot(
			createPersistedBlobQueueSnapshot(knownAbsent, SCOPE),
			SCOPE,
		)),
		jsonValue(knownAbsent),
		"known absence has no live source item to version",
	);

	const keepLocal: BlobQueueSnapshot = {
		uploads: [{
			path: "assets/keep-local.png",
			baseRefKnown: true,
			causalBaseRef: LIVE_REF,
			attentionResolution: {
				kind: "keep-local-remote-delete",
				expectedReason: "remote-delete-missing-baseline",
				episodeId: "delete-episode-a",
				remoteDeleteFingerprint: "delete-fingerprint-a",
			},
		}],
		downloads: [],
	};
	assert.deepEqual(
		jsonValue(readPersistedBlobQueueSnapshot(
			createPersistedBlobQueueSnapshot(keepLocal, SCOPE),
			SCOPE,
		)),
		jsonValue(keepLocal),
		"Keep-local retains its tombstone episode authority without a live source version",
	);
}

console.log("\n--- Persisted blob queue: settlement-deferred intent has no borrowed base ---");
{
	const deferred: BlobQueueSnapshot = {
		uploads: [{
			path: "assets/deferred-during-settlement.png",
			sizeBytes: 23,
			baseRefKnown: false,
			status: "pending",
			deferredUntilSettlement: true,
		}],
		downloads: [],
	};
	assert.deepEqual(
		jsonValue(readPersistedBlobQueueSnapshot(
			createPersistedBlobQueueSnapshot(deferred, SCOPE),
			SCOPE,
		)),
		jsonValue(deferred),
		"the exact deferred marker survives durable queue persistence",
	);
	assert.throws(
		() => createPersistedBlobQueueSnapshot({
			uploads: [{
				...deferred.uploads[0]!,
				baseRefKnown: true,
				expectedBaseRef: LIVE_REF,
				expectedBaseSourceVersion: SOURCE_VERSION,
			}],
			downloads: [],
		}, SCOPE),
		/invalid blob queue snapshot/i,
		"a deferred marker cannot smuggle pre-settlement live-ref authority",
	);
}

console.log("\n--- Blob queue import: direct legacy live-base snapshots fail closed ---");
{
	const legacyManager = makeManager();
	legacyManager.importQueue({
		uploads: [liveBaseUpload({ expectedBaseSourceVersion: undefined })],
		downloads: [],
	});
	assert.equal(
		(legacyManager as unknown as { uploadQueue: Map<string, unknown> }).uploadQueue.size,
		0,
		"direct import skips a legacy live-base upload instead of deferring rejection to transfer time",
	);

	const currentManager = makeManager();
	currentManager.importQueue({
		uploads: [liveBaseUpload()],
		downloads: [],
	});
	const restored = (
		currentManager as unknown as { uploadQueue: Map<string, { expectedBaseSourceVersion?: string }> }
	).uploadQueue.get("assets/live-base.png");
	assert.equal(
		restored?.expectedBaseSourceVersion,
		SOURCE_VERSION,
		"direct import preserves the exact live-base source version",
	);
	assert.equal(
		currentManager.exportQueue().uploads[0]?.expectedBaseSourceVersion,
		SOURCE_VERSION,
		"a restored item re-exports the same source version",
	);

	const malformedManager = makeManager();
	malformedManager.importQueue({
		uploads: [liveBaseUpload({ expectedBaseSourceVersion: "client:clock" })],
		downloads: [],
	});
	assert.equal(
		(malformedManager as unknown as { uploadQueue: Map<string, unknown> }).uploadQueue.size,
		0,
		"direct import skips a malformed source-version proof",
	);
}

console.log("\nPersisted blob queue source-version tests passed.");
