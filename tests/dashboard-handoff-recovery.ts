import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { indexedDB } from "fake-indexeddb";
import { TFile } from "obsidian";
import {
	buildKaosDashboardData,
	getDashboardAttentionTotalCount,
} from "../src/dashboard/dashboardData";
import type {
	DashboardHandoffRecovery,
	KaosDashboardCollectorInput,
} from "../src/dashboard/dashboardTypes";
import { ManualHandoffRecoveryCoordinator } from "../src/runtime/handoffRecoveryCoordinator";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	type HandoffRecoveryScope,
} from "../src/sync/handoffRecoveryStore";
import type { HandoffInputIntent } from "../src/sync/editorHandoffState";

const handoffRecovery: DashboardHandoffRecovery = {
	status: "ready",
	activeCount: 1,
	terminalCount: 0,
	totalBytes: 128,
	issues: [],
	items: [{
		recordId: '["kaos-handoff-recovery",1,"vault-a","device-a","intent-a"]',
		intentId: "intent-a",
		expectedChecksum: "a".repeat(64),
		fromPath: "A.md",
		targetPath: "B.md",
		originKind: "user",
		sequenceBegan: "after-target-selected",
		status: "needs-review",
		capturedAt: 100,
		storedAt: 200,
		startContentHash: "b".repeat(64),
		afterContentHash: "c".repeat(64),
		startLength: 5,
		afterLength: 6,
	}],
};

const baseInput = {
	app: {
		vault: {
			getFiles: () => [],
			getAbstractFileByPath: () => null,
		},
	},
	generatedAt: "2026-07-28T00:00:00.000Z",
	settings: {
		deviceName: "device-a",
		vaultId: "vault-a",
		attachmentSyncEnabled: false,
	},
	syncStatusLabel: "connected",
	connectionLabel: "online",
	connectionTone: "ok",
	reconciliationState: {
		reconciled: true,
		reconcileInFlight: false,
		reconcilePending: false,
		lastReconcileStats: null,
		lastReconciledGeneration: 1,
		untrackedFileCount: 0,
		blockedDivergenceCount: 0,
		lastBlockedDivergenceAt: null,
		blockedDivergenceSample: [],
		unresolvedStructuralChangeCount: 0,
		unresolvedStructuralChangeGroupCount: 0,
		unresolvedStructuralChangePaths: [],
		unresolvedStructuralChangeSample: [],
	},
	vaultSync: null,
	diskMirror: null,
	blobSync: null,
	preservedUnresolvedEntries: [],
	frontmatterQuarantineEntries: [],
	diskIndex: {},
	snapshotStatus: { status: "unavailable", message: "unavailable" },
	recoveryStorageStatus: { status: "unavailable", message: "unavailable" },
	recentChanges: {
		status: "unavailable",
		message: "unavailable",
		lastAttempt: null,
	},
	openFileCount: 0,
	snapshotsAvailable: false,
} as unknown as KaosDashboardCollectorInput;

const beforeAttention = getDashboardAttentionTotalCount(baseInput);
const data = buildKaosDashboardData({
	...baseInput,
	handoffRecovery,
});
assert.equal(data.handoffRecovery.activeCount, 1);
assert.equal(data.attentionTotalCount, beforeAttention);
assert.equal(data.attention.some((item) => item.path === "B.md"), false);
assert.doesNotMatch(
	JSON.stringify(data.handoffRecovery),
	/"(?:startContent|afterContent|serializedChanges|serializedSelection[^"]*)":/,
);

class FakeTFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

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
		startContentHash: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
		changes: ChangeSet.of([{ from: 5, insert: "!" }], 5),
		afterContent: "alpha!",
		afterContentHash: "0f467074706d62a9d82bd6cb0acbace1f1d2c8a1cc8b94bb44bd4fb47e654d54",
		selectionBefore: EditorSelection.single(5),
		selectionAfter: EditorSelection.single(6),
		originKind: "user",
		userEvent: "input",
		capturedAt: 1_800_000_000_000,
	};
}

console.log("\n--- Dashboard Handoff Recovery: summaries stay content-free until explicit load ---");
{
	const scope: HandoffRecoveryScope = {
		schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
		vaultId: "dashboard-vault",
		localDeviceId: "dashboard-device",
	};
	const store = new IndexedDbHandoffRecoveryStore(
		scope,
		indexedDB,
		`kaos-dashboard-handoff-${Date.now()}-${Math.random()}`,
		() => 1_800_000_000_100,
	);
	const put = await store.putIntent(makeIntent("dashboard-intent"));
	assert.equal(put.kind, "stored");
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
	});
	const snapshot = await coordinator.collectDashboardHandoffRecovery();
	assert.equal(snapshot.activeCount, 1);
	assert.equal(snapshot.items.length, 1);
	assert.equal(snapshot.items[0]?.status, "needs-review");
	assert.doesNotMatch(
		JSON.stringify(snapshot),
		/alpha|"(?:startContent|afterContent|serializedChanges|serializedSelection[^"]*)":/,
	);
	const item = snapshot.items[0];
	if (!item) throw new Error("missing dashboard Recovery item");
	const loaded = await coordinator.getRecord(item.recordId, item.expectedChecksum);
	assert.equal("body" in loaded, true, "body is loaded only by the explicit record action");
	const receipt = await coordinator.resolveManually(item.recordId, item.expectedChecksum);
	assert.equal(receipt.status, "resolved");
	assert.equal("body" in receipt, false);
	const afterResolve = await coordinator.collectDashboardHandoffRecovery();
	assert.equal(afterResolve.activeCount, 0);
	assert.equal(afterResolve.terminalCount, 1);
	const discardPut = await store.putIntent(makeIntent("dashboard-discard"));
	assert.equal(discardPut.kind, "stored");
	const beforeDiscard = await coordinator.collectDashboardHandoffRecovery();
	const discardItem = beforeDiscard.items.find(
		(candidate) => candidate.intentId === "dashboard-discard",
	);
	if (!discardItem) throw new Error("missing discard dashboard item");
	const discarded = await coordinator.discardRecord(
		discardItem.recordId,
		discardItem.expectedChecksum,
	);
	assert.equal(discarded.status, "discarded");
	assert.equal("body" in discarded, false);
	const cleared = await coordinator.clearCurrentScope();
	assert.equal(cleared.kind, "cleared");
	const afterClear = await coordinator.collectDashboardHandoffRecovery();
	assert.equal(afterClear.activeCount, 0);
	assert.equal(afterClear.terminalCount, 0);
}

const mainSource = readFileSync("src/main.ts", "utf8");
function sliceBetween(start: string, end: string): string {
	const from = mainSource.indexOf(start);
	const to = mainSource.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing dashboard action source: ${start}`);
	return mainSource.slice(from, to);
}
for (const source of [
	sliceBetween("private async copyHandoffRecoveryRecord(", "private async exportHandoffRecoveryRecord("),
	sliceBetween("private async exportHandoffRecoveryRecord(", "private async resolveHandoffRecoveryRecord("),
]) {
	assert.doesNotMatch(source, /resolveManually|discardRecord|resolveRecord|clearCurrentScope/);
}
assert.match(
	sliceBetween("private async resolveHandoffRecoveryRecord(", "private async discardHandoffRecoveryRecord("),
	/resolveManually/,
);
assert.match(
	sliceBetween("private async discardHandoffRecoveryRecord(", "private async clearHandoffRecoveryScope("),
	/discardRecord/,
);

console.log("dashboard handoff recovery tests passed");
