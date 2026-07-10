import assert from "node:assert/strict";
import type { FileHistoryEntry, FileHistoryManifestIndex } from "../src/sync/recoverySnapshotClient";
import {
	buildRecoveryHistoryChanges,
	filterRecoveryHistoryChanges,
	resolveRecoveryHistoryFeedState,
	resolveVisibleRecoveryHistorySelection,
	type RecoveryHistoryFeedFilters,
} from "../src/snapshots/recoveryHistorySelection";

function manifest(
	manifestId: string,
	createdAt: string,
	changedEntries: FileHistoryEntry[],
): FileHistoryManifestIndex {
	return {
		storageVersion: "v2",
		manifestId,
		vaultId: "vault-1",
		kind: "file-history",
		createdAt,
		day: createdAt.slice(0, 10),
		reason: "automatic",
		pinned: false,
		changedCount: changedEntries.length,
		contentHashes: changedEntries
			.map((entry) => entry.contentHash)
			.filter((hash): hash is string => typeof hash === "string"),
		changedEntries,
		stateHash: `${manifestId}-state`,
		manifestHash: `${manifestId}-manifest`,
	};
}

const manifests = [
	manifest("m1", "2026-06-24T01:00:00Z", [
		{
			fileId: "f1",
			kind: "modified",
			path: "notes/a.md",
			contentHash: "h1",
			previousContentHash: "h0",
		},
		{
			fileId: "f2",
			kind: "deleted",
			path: "archive/old.md",
			previousContentHash: "old",
		},
	]),
	manifest("m2", "2026-06-25T01:00:00Z", [
		{
			fileId: "f3",
			kind: "created",
			path: "notes/new.md",
			contentHash: "new",
			device: "Laptop",
			size: 512,
		},
		{
			fileId: "f1",
			kind: "renamed",
			path: "notes/a.md",
			oldPath: "notes/a.md",
			newPath: "notes/a-renamed.md",
			contentHash: "h2",
			previousContentHash: "h1",
		},
	]),
];

console.log("\n--- Test 1: recovery history changes flatten newest-first ---");
{
	const changes = buildRecoveryHistoryChanges(manifests);
	assert.deepEqual(
		changes.map((item) => item.key),
		["m2:f3:0", "m2:f1:1", "m1:f1:0", "m1:f2:1"],
	);
	assert.equal(changes[1]?.displayPath, "notes/a-renamed.md");
	assert.equal(changes[1]?.historyCount, 2);
}

console.log("\n--- Test 2: recovery history feed target selects dashboard change ---");
{
	const initial = resolveRecoveryHistoryFeedState(manifests);
	assert.deepEqual(initial.scope, { kind: "manifest", manifestId: "m2" });
	assert.equal(initial.selectedChangeKey, "m2:f3:0");

	const resolved = resolveRecoveryHistoryFeedState(manifests, {
		initialManifestId: "m2",
		initialFileId: "f1",
		autoExpandDiff: true,
	});
	assert.deepEqual(resolved.scope, { kind: "manifest", manifestId: "m2" });
	assert.equal(resolved.selectedChangeKey, "m2:f1:1");

	const fallback = resolveRecoveryHistoryFeedState(manifests, {
		initialManifestId: "m2",
		initialFileId: "missing",
		autoExpandDiff: true,
	});
	assert.deepEqual(fallback.scope, { kind: "manifest", manifestId: "m2" });
	assert.equal(fallback.selectedChangeKey, "m2:f3:0");
}

console.log("\n--- Test 3: recovery history feed filters by scope, kind, and path ---");
{
	const changes = buildRecoveryHistoryChanges(manifests);
	const filters: RecoveryHistoryFeedFilters = {
		scope: { kind: "manifest", manifestId: "m2" },
		query: "renamed",
		kindFilter: "renamed",
	};
	assert.deepEqual(
		filterRecoveryHistoryChanges(changes, filters).map((item) => item.key),
		["m2:f1:1"],
	);
}

console.log("\n--- Test 4: recovery history selection falls back to first visible change ---");
{
	const changes = buildRecoveryHistoryChanges(manifests);
	const selected = resolveVisibleRecoveryHistorySelection(
		changes,
		{
			scope: { kind: "manifest", manifestId: "m1" },
			query: "",
			kindFilter: "deleted",
		},
		"m2:f3:0",
	);
	assert.equal(selected, "m1:f2:1");
}
