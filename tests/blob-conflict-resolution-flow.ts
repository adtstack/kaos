import assert from "node:assert/strict";
import {
	assertBlobConflictResolutionAdmission,
	executeBlobConflictResolution,
} from "../src/runtime/blobConflictResolutionFlow";
import type { BlobQueueSnapshot } from "../src/sync/blobSync";

const remoteRef = { hash: "a".repeat(64), size: 10 };
const identity = {
	episodeId: "episode-1",
	expectedLocalHash: "b".repeat(64),
	expectedRemoteHash: remoteRef.hash,
	expectedRemoteRef: remoteRef,
	expectedRemoteSourceVersion: "1:7",
	artifactPath: "assets/file (KAOS remote conflict).png",
	originalMtime: 1,
	originalSize: 10,
	artifactMtime: 2,
	artifactSize: 10,
};
const admission = (overrides: Record<string, unknown> = {}) => ({
	path: "assets/file.png",
	choice: "keep-local" as const,
	authorityReady: true,
	expectedRemoteRef: remoteRef,
	expectedRemoteSourceVersion: "1:7",
	currentRemoteRef: remoteRef,
	currentRemoteSourceVersion: "1:7",
	artifactIsExactFile: true,
	originalIsExactFile: true,
	canResumeRemoteVacancy: false,
	hasPendingLocalMutation: false,
	queueAuthorityAvailable: true,
	...overrides,
});

console.log("\n--- Dashboard blob-conflict app flow ---");

assert.doesNotThrow(() => assertBlobConflictResolutionAdmission(admission()));
assert.throws(
	() => assertBlobConflictResolutionAdmission(admission({ authorityReady: false })),
	/authority is still initializing/,
);
assert.throws(
	() => assertBlobConflictResolutionAdmission(admission({ currentRemoteSourceVersion: "1:8" })),
	/Remote attachment changed/,
);
assert.throws(
	() => assertBlobConflictResolutionAdmission(admission({ hasPendingLocalMutation: true })),
	/Another local attachment mutation/,
);
assert.throws(
	() => assertBlobConflictResolutionAdmission(admission({ originalIsExactFile: false })),
	/current local attachment is missing/,
);

const queue: BlobQueueSnapshot = { uploads: [], downloads: [] };
{
	const order: string[] = [];
	const result = await executeBlobConflictResolution({
		path: "assets/file.png",
		choice: "keep-local",
		identity,
		keepLocal: async (_path, _identity, persistQueue) => {
			order.push("engine");
			await persistQueue(queue);
		},
		useRemote: async () => { throw new Error("wrong branch"); },
		persistKeepLocalQueue: async () => { order.push("queue"); },
		persistUseRemoteQueue: async () => { order.push("wrong-queue"); },
		persistPluginState: async () => { order.push("plugin-state"); },
	});
	assert.deepEqual(order, ["engine", "queue", "plugin-state"]);
	assert.equal(result.status, "pending");
}

{
	const order: string[] = [];
	await assert.rejects(
		executeBlobConflictResolution({
			path: "assets/file.png",
			choice: "keep-local",
			identity,
			keepLocal: async (_path, _identity, persistQueue) => {
				order.push("engine");
				await persistQueue(queue);
			},
			useRemote: async () => { throw new Error("wrong branch"); },
			persistKeepLocalQueue: async () => {
				order.push("queue-rejected");
				throw new Error("queue persistence failed");
			},
			persistUseRemoteQueue: async () => {},
			persistPluginState: async () => { order.push("plugin-state"); },
		}),
		/queue persistence failed/,
	);
	assert.deepEqual(
		order,
		["engine", "queue-rejected"],
		"a failed durable queue admission never publishes a misleading completed plugin state",
	);
}

{
	const order: string[] = [];
	const result = await executeBlobConflictResolution({
		path: "assets/file.png",
		choice: "use-remote-copy",
		identity,
		keepLocal: async () => { throw new Error("wrong branch"); },
		useRemote: async (_path, _identity, persistQueue) => {
			order.push("engine");
			await persistQueue(queue);
			return { safetyCopyPath: "assets/local backup.png", artifactRemoved: true };
		},
		persistKeepLocalQueue: async () => { order.push("wrong-queue"); },
		persistUseRemoteQueue: async () => { order.push("queue"); },
		persistPluginState: async () => { order.push("plugin-state"); },
	});
	assert.deepEqual(order, ["engine", "queue", "plugin-state"]);
	assert.deepEqual(result, {
		status: "completed",
		safetyCopyPath: "assets/local backup.png",
		artifactRemoved: true,
	});
}

console.log("PASS Dashboard blob-conflict app flow");
