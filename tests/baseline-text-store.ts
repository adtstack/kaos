import assert from "node:assert/strict";
import {
	BASELINE_TEXT_STORE_VERSION,
	applyPersistedBaselineTextFields,
	collectReferencedBaselineHashes,
	pruneBaselineTextStore,
	type PersistedBaselineTextFields,
} from "../src/sync/baselineTextStore";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

console.log("\n--- baseline text store: reference pruning ---");
{
	const index = {
		"notes/a.md": { mtime: 1, size: 1, contentHash: HASH_A },
	};
	const conflictBases = { "notes/a.conflict.md": HASH_B };
	assert.deepEqual(
		pruneBaselineTextStore({ [HASH_A]: "a", [HASH_B]: "b", ["c".repeat(64)]: "stale" }, index, conflictBases),
		{ [HASH_A]: "a", [HASH_B]: "b" },
	);
	assert.deepEqual([...collectReferencedBaselineHashes(index, conflictBases)].sort(), [HASH_A, HASH_B]);
	console.log("  PASS  only live disk-index and conflict bases are retained");
}

console.log("\n--- baseline text store: empty cleanup removes stale persisted fields ---");
{
	const state: PersistedBaselineTextFields = {
		_baselineTexts: { [HASH_A]: "old" },
		_conflictMergeBases: { "old.conflict.md": HASH_A },
		_baselineTextStoreVersion: BASELINE_TEXT_STORE_VERSION,
	};
	applyPersistedBaselineTextFields(state, {}, {}, false);
	assert.deepEqual(state, {});
	console.log("  PASS  the final legacy baseline payload can shrink to zero");
}

console.log("\n--- baseline text store: externalized state keeps metadata only ---");
{
	const state: PersistedBaselineTextFields = { _baselineTexts: { [HASH_A]: "legacy" } };
	applyPersistedBaselineTextFields(
		state,
		{ [HASH_A]: "body must stay external" },
		{ "notes/a.conflict.md": HASH_A },
		true,
	);
	assert.deepEqual(state, {
		_conflictMergeBases: { "notes/a.conflict.md": HASH_A },
		_baselineTextStoreVersion: BASELINE_TEXT_STORE_VERSION,
	});
	console.log("  PASS  data.json contains the store marker and merge-base hashes, not note bodies");
}

console.log("\n--- baseline text store: unavailable external store preserves legacy fallback ---");
{
	const state: PersistedBaselineTextFields = {};
	applyPersistedBaselineTextFields(state, { [HASH_A]: "legacy fallback" }, {}, false);
	assert.deepEqual(state, { _baselineTexts: { [HASH_A]: "legacy fallback" } });
	console.log("  PASS  pre-migration failures retain the crash-safe legacy copy");
}
