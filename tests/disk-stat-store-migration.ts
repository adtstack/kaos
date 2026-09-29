import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import {
	AUX_STATE_STORE_VERSION,
	IndexedDbAuxStateStore,
	readAuxStateMigrationInput,
	type AuxStateSnapshot,
} from "../src/sync/indexedDbAuxStateStore";

const dbName = `kaos-aux-state-test-${Date.now()}-${Math.random()}`;

console.log("\n--- Aux state store: save/load/clear and vault-scope isolation ---");
{
	const vaultA = new IndexedDbAuxStateStore("vault-a", indexedDB, dbName);
	const vaultA2 = new IndexedDbAuxStateStore("vault-a", indexedDB, dbName);
	const vaultB = new IndexedDbAuxStateStore("vault-b", indexedDB, dbName);

	const snapshot: AuxStateSnapshot = {
		diskIndex: { "note.md": { mtime: 1, size: 2, contentHash: "a".repeat(64) } },
		blobHashCache: { "img.png": { mtime: 3, size: 4, hash: "b".repeat(64) } },
		preservedUnresolved: [{ path: "note.md", kind: "markdown", reason: "path-collision", firstSeenAt: 10, lastSeenAt: 20 }],
		savedAt: 123,
	};
	await vaultA.save(snapshot);

	assert.deepEqual(
		await vaultA2.load(),
		snapshot,
		"a record survives store instances within the same vault scope",
	);
	assert.deepEqual(
		await vaultB.load(),
		null,
		"a different vault scope reads nothing — room transitions start empty",
	);

	await vaultA.clear();
	assert.deepEqual(await vaultA2.load(), null, "clear removes only this scope's record");
	await vaultB.save({ ...snapshot, savedAt: 456 });
	assert.deepEqual(await vaultA2.load(), null, "clearing scope A leaves scope B untouched");
}

console.log("\n--- Migration input: externalized marker wins over legacy keys ---");
{
	const externalized = readAuxStateMigrationInput({
		_auxStateStoreVersion: AUX_STATE_STORE_VERSION,
		_diskIndex: { "copied.md": { mtime: 9, size: 9 } },
		_blobHashCache: { "copied.png": { mtime: 9, size: 9, hash: "c".repeat(64) } },
		_preservedUnresolved: [{ path: "copied.md", kind: "markdown", reason: "path-collision", firstSeenAt: 1, lastSeenAt: 2 }],
	});
	assert.equal(externalized.externalized, true, "marker marks externalization");
	assert.equal(externalized.legacyDiskIndex, null, "legacy disk index keys are ignored when externalized");
	assert.equal(externalized.legacyBlobHashCache, null, "legacy blob cache keys are ignored when externalized");
	assert.equal(externalized.legacyPreservedUnresolved, null, "legacy preserved unresolved keys are ignored when externalized");
}

console.log("\n--- Migration input: externalization recognition is a version floor, not exact equality ---");
{
	// A device marked by the PREVIOUS shape version already stripped its
	// legacy keys; a shape-only bump must not misread it as un-externalized
	// (that would re-embed device-local fs facts into data.json).
	if (AUX_STATE_STORE_VERSION < 2) {
		assert.fail("AUX_STATE_STORE_VERSION must stay >= 2 for the floor test");
	}
	const previousVersion = readAuxStateMigrationInput({
		_auxStateStoreVersion: AUX_STATE_STORE_VERSION - 1,
		_diskIndex: { "v2-device.md": { mtime: 9, size: 9 } },
		_blobHashCache: {},
		_preservedUnresolved: [],
	});
	assert.equal(previousVersion.externalized, true, "previous marker version is still externalized");
	assert.equal(previousVersion.legacyDiskIndex, null, "v2 device's absent legacy keys stay ignored");

	// Below the floor the legacy path applies (pre-externalization markers).
	const preExternalized = readAuxStateMigrationInput({
		_auxStateStoreVersion: 1,
		_diskIndex: { "old.md": { mtime: 1, size: 1 } },
	});
	assert.equal(preExternalized.externalized, false, "marker below the floor is not externalized");
	assert.deepEqual(
		preExternalized.legacyDiskIndex,
		{ "old.md": { mtime: 1, size: 1 } },
		"legacy keys are surfaced below the floor",
	);
}

console.log("\n--- Migration input: legacy keys are surfaced pre-marker ---");
{
	const legacy = readAuxStateMigrationInput({
		_diskIndex: { "note.md": { mtime: 1, size: 2, contentHash: "d".repeat(64) } },
		_blobHashCache: { "img.png": { mtime: 3, size: 4, hash: "e".repeat(64) } },
		_preservedUnresolved: [{ path: "note.md", kind: "markdown", reason: "path-collision", firstSeenAt: 1, lastSeenAt: 2 }],
	});
	assert.equal(legacy.externalized, false, "no marker means legacy residency");
	assert.deepEqual(
		legacy.legacyDiskIndex,
		{ "note.md": { mtime: 1, size: 2, contentHash: "d".repeat(64) } },
		"legacy disk index is returned for migration",
	);
	assert.deepEqual(
		legacy.legacyBlobHashCache,
		{ "img.png": { mtime: 3, size: 4, hash: "e".repeat(64) } },
		"legacy blob cache is returned for migration",
	);
	assert.deepEqual(
		legacy.legacyPreservedUnresolved,
		[{ path: "note.md", kind: "markdown", reason: "path-collision", firstSeenAt: 1, lastSeenAt: 2 }],
		"legacy preserved unresolved is returned for migration",
	);
}

console.log("\n--- Migration input: empty/new installs need no migration ---");
{
	const fresh = readAuxStateMigrationInput({});
	assert.equal(fresh.externalized, false, "fresh install is not yet externalized");
	assert.equal(fresh.legacyDiskIndex, null, "no legacy disk index");
	assert.equal(fresh.legacyBlobHashCache, null, "no legacy blob cache");
	assert.equal(fresh.legacyPreservedUnresolved, null, "no legacy preserved unresolved");

	const emptyKeys = readAuxStateMigrationInput({ _diskIndex: {}, _blobHashCache: {}, _preservedUnresolved: [] });
	assert.equal(emptyKeys.legacyDiskIndex, null, "empty legacy keys are treated as absent");
	assert.equal(emptyKeys.legacyBlobHashCache, null, "empty legacy cache is treated as absent");
	assert.equal(emptyKeys.legacyPreservedUnresolved, null, "empty preserved unresolved is treated as absent");
}

console.log("\n--- Migration input: malformed values are ignored ---");
{
	const malformed = readAuxStateMigrationInput({
		_diskIndex: "not-an-object",
		_blobHashCache: [1, 2, 3],
		_preservedUnresolved: "not-an-array",
	});
	assert.equal(malformed.legacyDiskIndex, null, "non-object disk index is ignored");
	assert.equal(malformed.legacyBlobHashCache, null, "array blob cache is ignored");
	assert.equal(malformed.legacyPreservedUnresolved, null, "non-array preserved unresolved is ignored");
}

console.log("\n--- Store rejects an empty scope ---");
{
	assert.throws(
		() => new IndexedDbAuxStateStore("", indexedDB, dbName),
		/required/i,
		"empty vaultId scope is rejected at construction",
	);
}

console.log("\n--- Results ---");
console.log("all aux state migration checks passed");
