import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbBaselineTextRepository } from "../src/sync/indexedDbBaselineTextRepository";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const dbName = `kaos-baseline-test-${Date.now()}-${Math.random()}`;
const first = new IndexedDbBaselineTextRepository("vault-a", indexedDB, dbName);
const sameScope = new IndexedDbBaselineTextRepository("vault-a", indexedDB, dbName);
const otherScope = new IndexedDbBaselineTextRepository("vault-b", indexedDB, dbName);

console.log("\n--- IndexedDB baseline repository: save/load and scope isolation ---");
await first.save({ [HASH_A]: "alpha\n", [HASH_B]: "beta\n" });
assert.deepEqual(await sameScope.load([HASH_A, HASH_B]), {
	[HASH_A]: "alpha\n",
	[HASH_B]: "beta\n",
});
assert.deepEqual(await otherScope.load([HASH_A, HASH_B]), {});
console.log("  PASS  content-addressed texts survive repository instances without crossing vault scopes");

console.log("\n--- IndexedDB baseline repository: retain garbage collection ---");
await first.retain([HASH_B]);
assert.deepEqual(await first.load([HASH_A, HASH_B]), { [HASH_B]: "beta\n" });
await otherScope.save({ [HASH_A]: "other vault\n" });
await first.remove([HASH_B]);
assert.deepEqual(await first.load([HASH_B]), {});
assert.deepEqual(await otherScope.load([HASH_A]), { [HASH_A]: "other vault\n" });
console.log("  PASS  full and targeted garbage collection stay inside the active scope");
