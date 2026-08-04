import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { indexedDB } from "fake-indexeddb";
import { TFile } from "obsidian";
import { buildKaosDashboardData } from "../src/dashboard/dashboardData";
import type {
	DashboardHandoffRecovery,
	KaosDashboardCollectorInput,
} from "../src/dashboard/dashboardTypes";
import { ManualHandoffRecoveryCoordinator } from "../src/runtime/handoffRecoveryCoordinator";
import { exportHandoffRecoveryBody } from "../src/sync/handoffRecoveryExport";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import { PreservedUnresolvedRegistry } from "../src/sync/preservedUnresolved";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	hashHandoffRecoveryDispatchReceipt,
	type HandoffRecoveryScope,
} from "../src/sync/handoffRecoveryStore";
import type { HandoffInputIntent } from "../src/sync/editorHandoffState";

const main = readFileSync("src/main.ts", "utf8");
const storeSource = readFileSync("src/sync/indexedDbHandoffRecoveryStore.ts", "utf8");
const coordinatorSource = readFileSync("src/runtime/handoffRecoveryCoordinator.ts", "utf8");
const binding = readFileSync("src/sync/editorBinding.ts", "utf8");

function sliceBetween(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0, `missing start marker: ${start}`);
	assert.ok(to > from, `missing end marker: ${end}`);
	return source.slice(from, to);
}

console.log("\n--- Handoff Recovery boundaries: persisted/plugin authorities stay separate ---");
const persistedState = sliceBetween(
	main,
	"type PersistedPluginState",
	"export default class",
);
assert.doesNotMatch(persistedState, /handoffRecovery|HandoffRecovery/);

const refreshPersisted = sliceBetween(
	main,
	"private refreshPersistedState(",
	"private collectPreservedUnresolvedEntries(",
);
assert.doesNotMatch(
	refreshPersisted,
	/handoffRecovery|serializedChanges|serializedSelection|afterContent/,
);

assert.doesNotMatch(
	storeSource,
	/from\s+["']obsidian["']|\.vault\.|data\.json|PreservedUnresolved|Attention/,
);
assert.doesNotMatch(
	coordinatorSource,
	/ensureFile|Y\.Text|vault\.create|vault\.modify|recordPreservedUnresolved|storeDispatchReceipt/,
);

assert.doesNotMatch(
	binding,
	/case "persist-intent"|case "request-recovery-target-binding"/,
	"ordinary editor handoff has no persistence or recovery-binding effect lane",
);

console.log("\n--- Handoff Recovery boundaries: production activation is manual-only ---");
const recoveryActivation = sliceBetween(
	main,
	"private async initializeHandoffRecovery(",
	"private applyRuntimeSettings(",
);
assert.doesNotMatch(
	recoveryActivation,
	/HandoffReplayCoordinator|classifyStoredIntent|replayActions|observeAwaitingSettlement/,
);

class FakeTFile extends TFile {
	constructor(readonly path: string) {
		super();
	}
}

class FakeVault {
	private readonly files = new Map<string, { file: FakeTFile; content: string }>();

	constructor(initial: Readonly<Record<string, string>>) {
		for (const [path, content] of Object.entries(initial)) {
			this.files.set(path, { file: new FakeTFile(path), content });
		}
	}

	getFiles(): FakeTFile[] {
		return [...this.files.values()].map(({ file }) => file);
	}

	getAbstractFileByPath(path: string): FakeTFile | null {
		return this.files.get(path)?.file ?? null;
	}

	async create(path: string, content: string): Promise<FakeTFile> {
		if (this.files.has(path)) throw new Error(`duplicate fake vault path: ${path}`);
		const file = new FakeTFile(path);
		this.files.set(path, { file, content });
		return file;
	}

	async read(file: FakeTFile): Promise<string> {
		const stored = this.files.get(file.path);
		if (!stored || stored.file !== file) throw new Error("unknown fake vault file");
		return stored.content;
	}

	body(path: string): string {
		const stored = this.files.get(path);
		if (!stored) throw new Error(`missing fake vault path: ${path}`);
		return stored.content;
	}
}

function makeIntent(intentId: string): HandoffInputIntent {
	const startDocument = Text.of(["alpha"]);
	return {
		intentId,
		sessionId: "boundary-session",
		leafId: "boundary-leaf",
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

const emptyRecovery: DashboardHandoffRecovery = {
	status: "ready",
	activeCount: 0,
	terminalCount: 0,
	totalBytes: 0,
	issues: [],
	items: [],
};

function dashboardInput(
	app: unknown,
	handoffRecovery: DashboardHandoffRecovery,
): KaosDashboardCollectorInput {
	return {
		app,
		generatedAt: "2026-07-28T00:00:00.000Z",
		settings: {
			deviceName: "boundary-device",
			vaultId: "boundary-vault",
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
		handoffRecovery,
		recentChanges: {
			status: "unavailable",
			message: "unavailable",
			lastAttempt: null,
		},
		openFileCount: 0,
		snapshotsAvailable: false,
	} as unknown as KaosDashboardCollectorInput;
}

console.log("\n--- Handoff Recovery boundaries: one row mutates no primary authority ---");
{
	const vault = new FakeVault({ "A.md": "alpha", "B.md": "bravo" });
	const app = { vault };
	const registry = new PreservedUnresolvedRegistry([{
		path: "existing.md",
		kind: "markdown",
		reason: "unknown",
		episodeId: "existing-episode",
		firstSeenAt: 10,
		lastSeenAt: 20,
	}]);
	const yText = { value: "shared-alpha" };
	const initial = {
		a: vault.body("A.md"),
		b: vault.body("B.md"),
		yText: yText.value,
		fileCount: vault.getFiles().length,
		registry: registry.getEntries(),
	};
	const before = buildKaosDashboardData(dashboardInput(app, emptyRecovery));

	const scope: HandoffRecoveryScope = {
		schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
		vaultId: "boundary-vault",
		localDeviceId: "boundary-device",
	};
	const recoveryStore = new IndexedDbHandoffRecoveryStore(
		scope,
		indexedDB,
		`kaos-handoff-boundary-${Date.now()}-${Math.random()}`,
		() => 1_800_000_000_100,
	);
	const put = await recoveryStore.putIntent(makeIntent("boundary-intent"));
	assert.equal(put.kind, "stored");
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store: recoveryStore,
		isScopeCurrent: () => true,
	});
	const recovery = await coordinator.collectDashboardHandoffRecovery();
	assert.equal(recovery.activeCount, 1);
	const after = buildKaosDashboardData(dashboardInput(app, recovery));

	assert.equal(after.attentionTotalCount, before.attentionTotalCount);
	assert.deepEqual(after.attention, before.attention);
	assert.deepEqual(after.conflicts, before.conflicts);
	assert.deepEqual(registry.getEntries(), initial.registry);
	assert.equal(vault.body("A.md"), initial.a);
	assert.equal(vault.body("B.md"), initial.b);
	assert.equal(yText.value, initial.yText);
	assert.equal(vault.getFiles().length, initial.fileCount);

	const exportResult = await exportHandoffRecoveryBody(
		app as never,
		"Handoff Recovery Export.md",
		"alpha!",
	);
	assert.equal(exportResult.path, "Handoff Recovery Export.md");
	assert.equal(vault.getFiles().length, initial.fileCount + 1);
	assert.equal(vault.body(exportResult.path), "alpha!");
}

console.log("handoff recovery boundary tests passed");

console.log("\n--- Handoff Recovery boundaries: dispatch receipt hashes are canonical only ---");
{
	const left = await hashHandoffRecoveryDispatchReceipt({
		generation: 4,
		accepted: true,
		path: "B.md",
		witness: null,
	});
	const reordered = await hashHandoffRecoveryDispatchReceipt({
		witness: null,
		path: "B.md",
		accepted: true,
		generation: 4,
	});
	const different = await hashHandoffRecoveryDispatchReceipt({
		generation: 5,
		accepted: true,
		path: "B.md",
		witness: null,
	});
	assert.match(left, /^[0-9a-f]{64}$/);
	assert.equal(reordered, left);
	assert.notEqual(different, left);
}
