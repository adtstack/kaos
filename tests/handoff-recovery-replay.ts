import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import {
	ManualHandoffRecoveryCoordinator,
} from "../src/runtime/handoffRecoveryCoordinator";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import { makeStoredReplayFixture } from "./helpers/handoff-replay-fixture";

const { intent } = await makeStoredReplayFixture({
	intentOverrides: {
		intentId: `legacy-manual-only-${process.pid}-${Date.now()}`,
	},
});
const store = new IndexedDbHandoffRecoveryStore(
	{
		schemaVersion: 1,
		vaultId: "vault-a",
		localDeviceId: "local-device-a",
	},
	indexedDB,
	`kaos-handoff-manual-only-${process.pid}-${Date.now()}`,
	() => 1_800_000_000_100,
);
const stored = await store.putIntent(intent);
assert.equal(stored.kind, "stored");
const coordinator = new ManualHandoffRecoveryCoordinator({
	store,
	isScopeCurrent: () => true,
});
const hydrated = await coordinator.hydrateScope();
assert.equal(hydrated.status, "loaded");
assert.equal(hydrated.active.length, 1);
const manual = hydrated.active[0];
assert.ok(manual);
assert.equal(manual.status, "needs-review");
assert.equal(manual.intentId, intent.intentId);
assert.equal(manual.body.startContent, intent.startDocument.toString());
assert.equal(manual.body.afterContent, intent.afterContent);
assert.equal(manual.body.serializedChanges, JSON.stringify(intent.changes.toJSON()));

let exportedPayload: string | null = null;
const exact = await coordinator.getRecord(manual.recordId, manual.checksum);
exportedPayload = "body" in exact ? exact.body.afterContent : null;
assert.equal(exportedPayload, intent.afterContent);
const retained = await coordinator.hydrateScope();
assert.equal(retained.active.length, 1);
assert.equal(retained.active[0]?.status, "needs-review");
assert.equal(retained.active[0]?.body.afterContent, intent.afterContent);

console.log(
	"handoff-recovery-replay: automatic editor replay retired; legacy payload remains manual-only",
);
