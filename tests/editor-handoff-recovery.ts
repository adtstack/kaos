import assert from "node:assert/strict";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { TFile } from "obsidian";
import { ManualHandoffRecoveryCoordinator } from "../src/runtime/handoffRecoveryCoordinator";
import type { HandoffInputIntent } from "../src/sync/editorHandoffState";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	canonicalHandoffRecoveryJson,
	createStoredHandoffRecoveryRecord,
	sha256HandoffRecoveryHex,
	validateHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
	type HandoffRecoveryScope,
	type HandoffRecoveryStatusTransition,
	type HandoffRecoveryStore,
} from "../src/sync/handoffRecoveryStore";

class FakeTFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

const SCOPE: HandoffRecoveryScope = {
	schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
	vaultId: "vault-a",
	localDeviceId: "local-device-a",
};

function makeIntent(intentId: string): HandoffInputIntent {
	const startDocument = Text.of(["alpha"]);
	return {
		intentId,
		sessionId: "boot-a",
		leafId: "leaf-a",
		handoffGeneration: 4,
		fromPath: "A.md",
		fromFileId: "file-a",
		targetPath: "B.md",
		targetFile: new FakeTFile("B.md"),
		bindingEpoch: 7,
		inputEpoch: 9,
		switchIntentSeq: 11,
		inputStartSeq: 12,
		inputStartedUnderSwitchSeq: 11,
		compositionEpoch: null,
		selectionEpoch: 3,
		sequenceBegan: "after-target-selected",
		startDocument,
		startContentHash:
			"8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
		changes: ChangeSet.of([{ from: 5, insert: "!" }], 5),
		afterContent: "alpha!",
		afterContentHash:
			"0f467074706d62a9d82bd6cb0acbace1f1d2c8a1cc8b94bb44bd4fb47e654d54",
		selectionBefore: EditorSelection.single(5),
		selectionAfter: EditorSelection.single(6),
		originKind: "user",
		userEvent: "input",
		capturedAt: 1_800_000_000_000,
	};
}

async function withStatus(
	record: ActiveHandoffRecoveryRecord,
	status: ActiveHandoffRecoveryRecord["status"],
): Promise<ActiveHandoffRecoveryRecord> {
	const { checksum: _checksum, ...rest } = record;
	const withoutChecksum = { ...rest, status };
	return {
		...withoutChecksum,
		checksum: await sha256HandoffRecoveryHex(
			canonicalHandoffRecoveryJson(withoutChecksum),
		),
	};
}

function recoveryStore(initial: ActiveHandoffRecoveryRecord): Readonly<{
	store: HandoffRecoveryStore;
	transitions: Array<Readonly<{
		recordId: string;
		expectedChecksum: string;
		transition: HandoffRecoveryStatusTransition;
	}>>;
	active: () => ActiveHandoffRecoveryRecord;
}> {
	let active = initial;
	const transitions: Array<Readonly<{
		recordId: string;
		expectedChecksum: string;
		transition: HandoffRecoveryStatusTransition;
	}>> = [];
	const store: HandoffRecoveryStore = {
		scope: SCOPE,
		async putIntent() {
			throw new Error("runtime persistence is retired");
		},
		async compareAndSetStatus(recordId, expectedChecksum, transition) {
			transitions.push({ recordId, expectedChecksum, transition });
			if (
				recordId !== active.recordId
				|| expectedChecksum !== active.checksum
				|| transition.from !== active.status
				|| transition.to !== "needs-review"
			) {
				return {
					kind: "stale",
					actualStatus: active.status,
					actualChecksum: active.checksum,
				};
			}
			active = await withStatus(active, "needs-review");
			return { kind: "updated", record: active };
		},
		async storeApplyWitness() {
			throw new Error("automatic apply witness is retired");
		},
		async storeDispatchReceipt() {
			throw new Error("automatic dispatch receipt is retired");
		},
		async resolveRecord() {
			throw new Error("hydrate never resolves or discards a record");
		},
		async hydrateScope() {
			return {
				status: "loaded" as const,
				active: [active],
				terminal: [],
				issues: [],
				totalBytes: active.body.startContent.length + active.body.afterContent.length,
			};
		},
		async clearScope() {
			return { kind: "cleared" as const, deletedCount: 1 };
		},
		async drain() {},
	};
	return { store, transitions, active: () => active };
}

console.log("\n--- Manual Handoff Recovery: automatic runtime API is absent ---");
{
	const prototype = ManualHandoffRecoveryCoordinator.prototype as unknown as
		Record<string, unknown>;
	for (const retired of [
		"persistAndClassify",
		"copyAndContinue",
		"exportAndContinue",
		"discardAndContinue",
		"continueWithoutAutomaticApply",
		"retrySettlement",
	] as const) {
		assert.equal(retired in prototype, false, `${retired} is not a runtime API`);
	}
	for (const retained of [
		"collectDashboardHandoffRecovery",
		"resolveManually",
		"discardRecord",
		"hydrateScope",
		"getRecord",
		"clearCurrentScope",
		"drain",
	] as const) {
		assert.equal(typeof prototype[retained], "function", `${retained} remains available`);
	}
}

console.log("\n--- Manual Handoff Recovery: every legacy active status becomes needs-review ---");
for (const status of [
	"stored",
	"replay-pending",
	"replayed-awaiting-settlement",
] as const) {
	const stored = await createStoredHandoffRecoveryRecord(
		SCOPE,
		makeIntent(`legacy-${status}`),
		1_800_000_000_100,
	);
	const legacy = await withStatus(stored, status);
	const scripted = recoveryStore(legacy);
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store: scripted.store,
		isScopeCurrent: () => true,
	});
	const hydrated = await coordinator.hydrateScope();
	assert.equal(hydrated.active.length, 1);
	const manual = hydrated.active[0];
	assert.ok(manual);
	assert.equal(manual.status, "needs-review");
	assert.equal(manual.recordId, legacy.recordId);
	assert.equal(manual.intentEnvelopeHash, legacy.intentEnvelopeHash);
	assert.deepEqual(manual.body, legacy.body);
	assert.equal(manual.applyWitness, legacy.applyWitness);
	assert.equal(
		await validateHandoffRecoveryRecord(manual),
		manual,
		"demoted row keeps a valid checksum over the unchanged payload",
	);
	assert.deepEqual(scripted.transitions, [{
		recordId: legacy.recordId,
		expectedChecksum: legacy.checksum,
		transition: { from: status, to: "needs-review" },
	}]);
	assert.equal(scripted.active(), manual);
}

console.log("manual handoff recovery coordinator tests passed");
