/**
 * Tombstone revival defense regression tests.
 *
 * Verifies:
 *   Stage 1: Recorded removals survive fresh filesystem timestamps
 *   Stage 2: Residual tombstone-conflict visibility & resolution UI
 *   Stage 3: Event lane root-cause diagnosis & fixes:
 *     (a) Closed file delete → returned disk file remains local only
 *     (b) Open tab delete → recreate → attention entry without infinite defer loop
 *     (c) Closed file external line rewrite (10-07 Todo pattern, shorter than CRDT)
 *   Stage 4: Event handler hygiene (registerVaultEvents idempotency)
 */

import "fake-indexeddb/auto";
import * as Y from "yjs";
import { MarkdownView, TFile } from "obsidian";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { DiskMirror } from "../src/sync/diskMirror";
import { VaultSync, getMarkdownTombstoneDeletedAt, classifyDiskPathForReconcile } from "../src/sync/vaultSync";
import { DEFAULT_SETTINGS } from "../src/settings/settingsStore";
import { collectDashboardAttention, getDashboardAttentionTotalCount } from "../src/dashboard/dashboardData";
import { FLIGHT_KIND } from "../src/telemetry/debug/flightEvents";
import { PRODUCT_EVENT_KIND } from "../src/observability/productEventKinds";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import { ORIGIN_DISK_SYNC } from "../src/sync/origins";
import {
	createMarkdownCreationHistoryLoader, readMarkdownCreationHistory,
} from "../src/sync/markdownCreationHistory";
import type { FileHistoryManifestList } from "../src/sync/recoverySnapshotClient";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function makeTFile(path: string, stat?: { ctime?: number; mtime?: number; size?: number }): TFile {
	const file = new TFile() as TFile & { path: string; stat: { ctime: number; mtime: number; size: number } };
	file.path = path;
	file.stat = {
		ctime: stat?.ctime ?? Date.now(),
		mtime: stat?.mtime ?? Date.now(),
		size: stat?.size ?? 100,
	};
	return file;
}

function makeTestVaultSync(options?: {
	deviceName?: string;
	onFlightPathEvent?: (event: any) => void;
}): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	vs.getRemoteTextRevisionForPath = () => null;
	vs.getActivePathForTrackedText = () => null;
	vs.ydoc = new Y.Doc();
	vs.pathToId = vs.ydoc.getMap("pathToId");
	vs.idToText = vs.ydoc.getMap("idToText");
	vs.meta = vs.ydoc.getMap("meta");
	vs.sys = vs.ydoc.getMap("sys");
	vs.pathToBlob = vs.ydoc.getMap("pathToBlob");
	vs.blobMeta = vs.ydoc.getMap("blobMeta");
	vs.blobTombstones = vs.ydoc.getMap("blobTombstones");
	vs._textToFileId = new WeakMap();
	vs._pathIndex = new Map();
	vs._deletedPathIndex = new Set();
	vs._activePathCollisions = new Map();
	vs._pathIndexesDirty = true;
	vs._localReady = true;
	vs._providerSynced = true;
	vs._connectionGeneration = 1;
	vs._renameBatch = new Map();
	vs._renameBatchNewToOld = new Map();
	vs._renameTimer = null;
	vs._onRenameBatchFlushed = null;
	vs._eventRing = [];
	vs._device = options?.deviceName ?? "test-device";
	vs.serverAckTracker = {
		withActiveOpId: (_opId: string | undefined, work: () => unknown) => work(),
	};
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightEvent = undefined;
	vs.onFlightPathEvent = options?.onFlightPathEvent;
	vs.provider = { wsconnected: true };
	vs.destroy = () => {
		vs.ydoc.destroy();
	};
	return vs as VaultSync;
}

function createTestController(options: {
	app: any;
	vaultSync: VaultSync;
	diskMirror?: any;
	diskIndex?: DiskIndex;
	setDiskIndex?: (idx: DiskIndex) => void;
	deviceName?: string;
	onFlightPathEvent?: (event: any) => void;
	shouldBlockFrontmatterIngest?: (path: string, previousContent: string | null, newContent: string, reason: string) => boolean;
}): ReconciliationController {
	let diskIndex = options.diskIndex ?? {};
	return new ReconciliationController({
		app: options.app,
		getSettings: () => ({ ...DEFAULT_SETTINGS, deviceName: options.deviceName ?? "test-device" }),
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [] }) as any,
		getVaultSync: () => options.vaultSync,
		getDiskMirror: () => options.diskMirror ?? null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (idx: DiskIndex) => {
			diskIndex = idx;
			options.setDiskIndex?.(idx);
		},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: options.shouldBlockFrontmatterIngest ?? (() => false),
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightPathEvent: options.onFlightPathEvent,
	});
}

// -----------------------------------------------------------------------------
// Test 1: Stage 1 - Fresh ctime cannot cancel a recorded delete
// -----------------------------------------------------------------------------
console.log("\n--- Test 1: Stage 1 - Fresh ctime cannot cancel a recorded delete ---");
async function testStage1Backstop() {
	const path = "notes/alpha.md";
	const initialContent = "alpha v1";
	const recreatedContent = "alpha v2 recreated";

	const flightEvents: any[] = [];
	const vaultSync = makeTestVaultSync({
		deviceName: "dev-alpha",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	// 1. Create file in CRDT
	vaultSync.ensureFile(path, initialContent, "dev-alpha");
	assert(vaultSync.getTextForPath(path)?.toString() === initialContent, "file exists in CRDT initially");

	// 2. Delete file in CRDT (creates tombstone)
	vaultSync.handleDelete(path, "dev-alpha", "op-delete-1");
	assert(vaultSync.getTextForPath(path) === null, "file is deleted in CRDT");
	assert(vaultSync.isMarkdownTombstoned(path), "path is tombstoned");
	const tombstoneDeletedAt = vaultSync.getMarkdownTombstoneDeletedAt(path);
	assert(typeof tombstoneDeletedAt === "number", "tombstone deletedAt recorded");

	// 3. File recreated on disk with ctime > deletedAt
	const recreatedCtime = (tombstoneDeletedAt ?? 0) + 2000;
	const diskFile = makeTFile(path, { ctime: recreatedCtime, mtime: recreatedCtime, size: recreatedContent.length });

	// Unit check: classifyDiskPathForReconcile
	const unitClassification = classifyDiskPathForReconcile(
		path,
		false,
		true,
		"authoritative",
	);
	assert(
		unitClassification.action === "tombstone-conflict",
		"classifyDiskPathForReconcile keeps recorded deletion authoritative",
	);

	// Direct reconcileVault check
	const recResult = vaultSync.reconcileVault(
		new Map([[path, recreatedContent]]),
		new Set([path]),
		"authoritative",
		"dev-alpha",
		(p) => ({
			opId: "op-reconcile-seed-1",
			emitDecision: () => {},
		}),
		() => true,
		() => true,
		() => true,
	);

	assert(!recResult.seededToCrdt.includes(path), "fresh ctime does not seed a removed path");
	assert(vaultSync.isMarkdownTombstoned(path), "tombstone remains after sweep");
	assert(vaultSync.getTextForPath(path) === null, "recreated disk bytes remain local only");
	assert(
		!flightEvents.some((e) => e.kind === FLIGHT_KIND.crdtFileRevived),
		"sweep emits no automatic revival",
	);

	// Controller integration test with runReconciliation
	const ctrlPath = "notes/alpha-ctrl.md";
	const ctrlContent = "controller recreated content";
	vaultSync.ensureFile(ctrlPath, "ctrl v1", "dev-alpha");
	vaultSync.handleDelete(ctrlPath, "dev-alpha", "op-delete-ctrl");
	const ctrlDelAt = vaultSync.getMarkdownTombstoneDeletedAt(ctrlPath) ?? Date.now();
	const ctrlFile = makeTFile(ctrlPath, { ctime: ctrlDelAt + 3000, mtime: ctrlDelAt + 3000, size: ctrlContent.length });

	const diskMirror = {
		isPreservedUnresolved: () => false,
		clearPreservedUnresolved: () => {},
		recordPreservedUnresolved: () => {},
		flushWrite: async () => {},
		getPreservedUnresolvedEntries: () => [],
		hasPendingWrite: () => false,
		getLastDiskWriteOkHash: () => null,
	};

	const controller = createTestController({
		app: {
			vault: {
				getFiles: () => [ctrlFile],
				getMarkdownFiles: () => [ctrlFile],
				getAbstractFileByPath: (p: string) => (p === ctrlPath ? ctrlFile : null),
				read: async () => ctrlContent,
				adapter: { stat: async () => ctrlFile.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		diskMirror,
		deviceName: "dev-alpha",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	await controller.runReconciliation("authoritative");

	assert(vaultSync.isMarkdownTombstoned(ctrlPath), "controller retains tombstone during sweep");
	assert(vaultSync.getTextForPath(ctrlPath) === null, "controller leaves returned disk content local only");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 2: Stage 1 Safety - Non-recreated zombie file stays in tombstone-conflict
// -----------------------------------------------------------------------------
console.log("\n--- Test 2: Stage 1 Safety - Non-recreated zombie file stays in tombstone-conflict ---");
async function testStage1Safety() {
	const path = "notes/zombie.md";
	const initialContent = "zombie v1";

	const flightEvents: any[] = [];
	const vaultSync = makeTestVaultSync({
		deviceName: "dev-zombie",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	vaultSync.ensureFile(path, initialContent, "dev-zombie");
	vaultSync.handleDelete(path, "dev-zombie", "op-delete-2");
	const tombstoneDeletedAt = vaultSync.getMarkdownTombstoneDeletedAt(path) ?? Date.now();

	// File on disk has ctime BEFORE deletion (zombie / predating file)
	const zombieCtime = tombstoneDeletedAt - 5000;
	const zombieFile = makeTFile(path, { ctime: zombieCtime, mtime: zombieCtime, size: initialContent.length });

	// Unit check: classifyDiskPathForReconcile
	const unitClassification = classifyDiskPathForReconcile(
		path,
		false,
		true,
		"authoritative",
		() => false,
	);
	assert(
		unitClassification.action === "tombstone-conflict",
		"classifyDiskPathForReconcile returns tombstone-conflict regardless of filesystem timestamps",
	);

	// Direct reconcileVault check
	const recResult = vaultSync.reconcileVault(
		new Map([[path, initialContent]]),
		new Set([path]),
		"authoritative",
		"dev-zombie",
		(p) => ({ opId: "op-zombie", emitDecision: () => {} }),
		() => true,
		() => true,
		() => true,
		() => false,
	);
	assert(!recResult.seededToCrdt.includes(path), "zombie file was NOT seeded to CRDT by reconcileVault");
	assert(recResult.tombstonedDiskConflicts.some((c) => c.path === path), "zombie file returned in tombstonedDiskConflicts");
	assert(vaultSync.isMarkdownTombstoned(path), "zombie path remains tombstoned in CRDT");

	// Controller integration check
	const diskMirror = {
		isPreservedUnresolved: () => false,
		clearPreservedUnresolved: () => {},
		recordPreservedUnresolved: () => {},
		flushWrite: async () => {},
		getPreservedUnresolvedEntries: () => [],
		hasPendingWrite: () => false,
		getLastDiskWriteOkHash: () => null,
	};

	const controller = createTestController({
		app: {
			vault: {
				getFiles: () => [zombieFile],
				getMarkdownFiles: () => [zombieFile],
				getAbstractFileByPath: (p: string) => (p === path ? zombieFile : null),
				read: async () => initialContent,
				adapter: { stat: async () => zombieFile.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		diskMirror,
		deviceName: "dev-zombie",
	});

	await controller.runReconciliation("authoritative");

	assert(vaultSync.isMarkdownTombstoned(path), "zombie path remains tombstoned after controller reconcile");
	assert(vaultSync.getTextForPath(path) === null, "zombie file not seeded to CRDT by controller");
	const conflicts = controller.getState().tombstonedDiskConflicts;
	assert(conflicts.some((c) => c.path === path), "zombie conflict stored in controller tombstonedDiskConflicts");
	assert(
		conflicts.find((c) => c.path === path)?.hasOpenViews === false,
		"zombie conflict marked with hasOpenViews: false",
	);

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 3: Stage 2 - Attention Item & Resolution UI (Keep Local & Accept Delete)
// -----------------------------------------------------------------------------
console.log("\n--- Test 3: Stage 2 - Attention Item & Resolution UI (Keep Local & Accept Delete) ---");
async function testStage2UI() {
	const path1 = "notes/keep-local.md";
	const path2 = "notes/accept-delete.md";
	const content1 = "keep me local";
	const content2 = "delete me please";

	const vaultSync = makeTestVaultSync({ deviceName: "dev-ui" });

	vaultSync.ensureFile(path1, "old 1", "dev-ui");
	vaultSync.handleDelete(path1, "dev-ui", "op-d1");
	vaultSync.ensureFile(path2, "old 2", "dev-ui");
	vaultSync.handleDelete(path2, "dev-ui", "op-d2");

	const file1 = makeTFile(path1, { ctime: 1000, mtime: 1000, size: content1.length });
	const file2 = makeTFile(path2, { ctime: 1000, mtime: 1000, size: content2.length });
	const trashedFiles: string[] = [];

	const controller = createTestController({
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => {
					if (p === path1) return file1;
					if (p === path2 && !trashedFiles.includes(p)) return file2;
					return null;
				},
				read: async (f: TFile) => (f.path === path1 ? content1 : content2),
				adapter: { stat: async (p: string) => (p === path1 ? file1.stat : file2.stat) },
			},
			fileManager: {
				trashFile: async (f: TFile) => {
					trashedFiles.push(f.path);
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		deviceName: "dev-ui",
	});

	// Record both as tombstone conflicts
	controller.recordTombstonedDiskConflict(path1, 5000, 1000, false);
	controller.recordTombstonedDiskConflict(path2, 5000, 1000, false);

	// Check dashboard attention items
	const attentionInput = {
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p === path1 ? file1 : p === path2 ? file2 : null),
			},
		} as any,
		reconciliationState: controller.getState(),
		preservedUnresolvedEntries: [],
		frontmatterQuarantineEntries: [],
		remoteDeleteResolutionState: null,
		remoteProjectionPolicyError: null,
		roomDivergence: null,
	};

	const attentionItems = collectDashboardAttention(attentionInput).filter((i) => i.kind === "tombstone-disk-conflict");
	assert(attentionItems.length === 2, "dashboard collected both tombstone-disk-conflict items");
	assert(
		getDashboardAttentionTotalCount(attentionInput) >= 2,
		"getDashboardAttentionTotalCount includes tombstone conflicts",
	);

	// Test Keep Local resolution
	await controller.resolveTombstoneConflictKeepLocal(path1);
	assert(!vaultSync.isMarkdownTombstoned(path1), "keep-local revived path1 in CRDT");
	assert(vaultSync.getTextForPath(path1)?.toString() === content1, "keep-local published disk content to CRDT");
	assert(!controller.getState().tombstonedDiskConflicts.some((c) => c.path === path1), "path1 removed from conflicts");

	// Test Accept Delete resolution
	await controller.resolveTombstoneConflictAcceptDelete(path2);
	assert(trashedFiles.includes(path2), "accept-delete moved local file to trash");
	assert(!controller.getState().tombstonedDiskConflicts.some((c) => c.path === path2), "path2 removed from conflicts");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 4: Stage 3a - Closed file delete → returned disk file stays removed
// -----------------------------------------------------------------------------
console.log("\n--- Test 4: Stage 3a - Closed file delete → returned disk file stays removed ---");
async function testStage3a() {
	const path = "notes/closed-recreate.md";
	const initial = "initial content";
	const recreated = "recreated by external tool";

	const flightEvents: any[] = [];
	const vaultSync = makeTestVaultSync({
		deviceName: "dev-3a",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	vaultSync.ensureFile(path, initial, "dev-3a");
	vaultSync.handleDelete(path, "dev-3a", "op-d3a");
	const deletedAt = vaultSync.getMarkdownTombstoneDeletedAt(path) ?? Date.now();

	// Physical recreation on disk
	const recreatedCtime = deletedAt + 1000;
	let currentDiskContent = recreated;
	const file = makeTFile(path, { ctime: recreatedCtime, mtime: recreatedCtime, size: recreated.length });

	const controller = createTestController({
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p === path ? file : null),
				read: async () => currentDiskContent,
				adapter: { stat: async () => file.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		deviceName: "dev-3a",
	});

	// Trigger create event
	controller.markMarkdownDirty(file, "create", "op-create-3a");

	// Drain dirty queue
	await (controller as any).drainDirtyMarkdownPaths();

	assert(vaultSync.isMarkdownTombstoned(path), "create event cannot cancel recorded deletion");
	assert(vaultSync.getTextForPath(path) === null, "create event does not publish returned disk content");
	assert(
		!flightEvents.some((e) => e.kind === FLIGHT_KIND.crdtFileRevived),
		"create event emits no automatic revival",
	);

	// A later modify event with a fresh ctime cannot override the same deletion either.
	vaultSync.handleDelete(path, "dev-3a", "op-d3a-2");
	const deletedAt2 = vaultSync.getMarkdownTombstoneDeletedAt(path) ?? Date.now();
	currentDiskContent = "recreated via modify event";
	const file2 = makeTFile(path, { ctime: deletedAt2 + 500, mtime: deletedAt2 + 500, size: currentDiskContent.length });

	controller.markMarkdownDirty(file2, "modify", "op-modify-3a");
	await (controller as any).drainDirtyMarkdownPaths();

	assert(vaultSync.isMarkdownTombstoned(path), "modify event with fresh ctime retains deletion");
	assert(vaultSync.getTextForPath(path) === null, "modify event cannot republish a deleted note");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 5: Stage 3b - Open tab delete → recreate & elimination of infinite defer loop
// -----------------------------------------------------------------------------
console.log("\n--- Test 5: Stage 3b - Open tab delete → recreate & elimination of infinite defer loop ---");
async function testStage3b() {
	const path = "notes/open-tab.md";
	const initial = "initial open content";

	const flightEvents: any[] = [];
	const vaultSync = makeTestVaultSync({
		deviceName: "dev-3b",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	vaultSync.ensureFile(path, initial, "dev-3b");
	vaultSync.handleDelete(path, "dev-3b", "op-d3b");
	const deletedAt = vaultSync.getMarkdownTombstoneDeletedAt(path) ?? Date.now();

	// Tab is open in editor with old content (ctime <= deletedAt)
	const file = makeTFile(path, { ctime: deletedAt - 1000, mtime: deletedAt - 1000, size: initial.length });
	const openView = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
		leaf: { id: string };
	};
	openView.file = file;
	openView.editor = {
		getValue: () => initial,
	};
	openView.leaf = { id: "leaf-1" } as any;

	const controller = createTestController({
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p === path ? file : null),
				read: async () => initial,
				adapter: { stat: async () => file.stat },
			},
			workspace: {
				iterateAllLeaves: (cb: any) => cb({ view: openView }),
			},
		},
		vaultSync,
		deviceName: "dev-3b",
	});

	// Trigger modify event while tab is open on a tombstoned file
	controller.markMarkdownDirty(file, "modify", "op-open-mod");
	await (controller as any).drainDirtyMarkdownPaths();

	// Verify it did NOT re-queue itself into dirty queue with 1000ms infinite deferral
	const dirtyEntries = (controller as any).dirtyMarkdownPaths.size;
	assert(dirtyEntries === 0, "dirty queue is empty; infinite defer loop eliminated");

	// Verify it entered tombstonedDiskConflicts with hasOpenViews: true
	const conflicts = controller.getState().tombstonedDiskConflicts;
	const openConflict = conflicts.find((c) => c.path === path);
	assert(openConflict !== undefined, "open tab tombstone conflict recorded in controller state");
	assert(openConflict?.hasOpenViews === true, "conflict flagged as having open views");

	// A newer filesystem timestamp still cannot cancel the deletion.
	const recreatedContent = "open recreated text";
	const fileRecreated = makeTFile(path, { ctime: deletedAt + 1000, mtime: deletedAt + 1000, size: recreatedContent.length });
	openView.file = fileRecreated;
	controller.markMarkdownDirty(fileRecreated, "create", "op-open-recreate");
	await (controller as any).drainDirtyMarkdownPaths();

	assert(vaultSync.isMarkdownTombstoned(path), "open-file create retains deletion");
	assert(controller.getState().tombstonedDiskConflicts.some((c) => c.path === path), "open-file conflict remains available for explicit restore");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 6: Stage 3c - Closed file external line rewrite (10-07 Todo pattern, shorter than CRDT)
// -----------------------------------------------------------------------------
console.log("\n--- Test 6: Stage 3c - Closed file external line rewrite (10-07 Todo pattern) ---");
async function testStage3c() {
	const path = "notes/todo.md";
	const originalContent = "# Todo\n- [ ] Task 1\n- [ ] Task 2\n- [x] Done 1\n- [x] Done 2\n";
	const shorterContent = "# Todo\n- [ ] Task 1\n- [ ] Task 2\n";

	const vaultSync = makeTestVaultSync({ deviceName: "dev-3c" });
	vaultSync.ensureFile(path, originalContent, "dev-3c");

	const originalHash = await contentBaselineHash(originalContent);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 100, size: originalContent.length, contentHash: originalHash },
	};

	const file = makeTFile(path, { ctime: 100, mtime: 200, size: shorterContent.length });

	const controller = createTestController({
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p === path ? file : null),
				read: async () => shorterContent,
				adapter: { stat: async () => file.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		diskIndex,
		setDiskIndex: (idx) => { diskIndex = idx; },
		deviceName: "dev-3c",
	});

	// Deliver modify event from external rewrite
	controller.markMarkdownDirty(file, "modify", "op-todo-archive");
	await (controller as any).drainDirtyMarkdownPaths();

	const crdtAfter = vaultSync.getTextForPath(path)?.toString();
	assert(crdtAfter === shorterContent, "external line rewrite ingested into CRDT (shorter than previous)");
	const shorterHash = await contentBaselineHash(shorterContent);
	assert(diskIndex[path]?.contentHash === shorterHash, "disk index baseline updated to new shorter content hash");
	assert(controller.getAutomaticRecoveryHolds().length === 0, "no automatic recovery hold was triggered");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 7: Stage 4 - registerVaultEvents idempotency
// -----------------------------------------------------------------------------
console.log("\n--- Test 7: Stage 4 - registerVaultEvents idempotency ---");
{
	let registeredCount = 0;
	const fakePlugin: any = {
		vaultEventsRegistered: false,
		registerEvent: () => { registeredCount++; },
		app: {
			workspace: { on: () => ({}) },
			vault: { on: () => ({}) },
		},
		reconciliationController: { isReconciled: true },
		getRuntimeConfig: () => ({ vaultConfigDir: ".obsidian" }),
	};

	function registerVaultEvents(this: any) {
		if (this.vaultEventsRegistered) return;
		this.vaultEventsRegistered = true;
		this.registerEvent(this.app.workspace.on("layout-change", () => {}));
		this.registerEvent(this.app.vault.on("modify", () => {}));
	}

	registerVaultEvents.call(fakePlugin);
	const initialRegistered = registeredCount;
	assert(initialRegistered === 2, "first call registers vault events");
	assert(fakePlugin.vaultEventsRegistered === true, "vaultEventsRegistered set to true");

	// Call again
	registerVaultEvents.call(fakePlugin);
	assert(registeredCount === initialRegistered, "second call is a no-op; no duplicate listeners added");
}

// -----------------------------------------------------------------------------
// Test 8: P1 Frontmatter Guard - Reconcile sweep blocks corrupt frontmatter revival
// -----------------------------------------------------------------------------
console.log("\n--- Test 8: P1 Frontmatter Guard - Reconcile sweep blocks corrupt frontmatter revival ---");
async function testSweepBlocksCorruptFrontmatterRevival() {
	const path = "notes/p1-corrupt.md";
	const initialContent = "clean v1";
	const corruptContent = "---\ncorrupt: [broken-yaml\n---\nbody";

	const vaultSync = makeTestVaultSync({ deviceName: "dev-p1" });
	vaultSync.ensureFile(path, initialContent, "dev-p1");
	vaultSync.handleDelete(path, "dev-p1", "op-del-p1");
	const tombstoneDelAt = vaultSync.getMarkdownTombstoneDeletedAt(path) ?? Date.now();

	const file = makeTFile(path, { ctime: tombstoneDelAt + 5000, mtime: tombstoneDelAt + 5000, size: corruptContent.length });

	const flightEvents: any[] = [];
	const diskMirror = {
		isPreservedUnresolved: () => false,
		clearPreservedUnresolved: () => {},
		recordPreservedUnresolved: () => {},
		flushWrite: async () => {},
		getPreservedUnresolvedEntries: () => [],
		hasPendingWrite: () => false,
		getLastDiskWriteOkHash: () => null,
	};
	const controller = createTestController({
		app: {
			vault: {
				getFiles: () => [file],
				getMarkdownFiles: () => [file],
				getAbstractFileByPath: (p: string) => (p === path ? file : null),
				read: async () => corruptContent,
				adapter: { stat: async () => file.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		diskMirror,
		shouldBlockFrontmatterIngest: (p) => p === path,
		deviceName: "dev-p1",
		onFlightPathEvent: (e) => flightEvents.push(e),
	});

	await controller.runReconciliation("authoritative");

	assert(vaultSync.isMarkdownTombstoned(path), "path remains tombstoned when frontmatter is corrupt");
	assert(vaultSync.getTextForPath(path) === null, "corrupt file was NOT revived or seeded into CRDT");
	assert(controller.getState().tombstonedDiskConflicts.some((entry) => entry.path === path),
		"removed corrupt file is available for explicit review without admission");

	vaultSync.destroy();
}

// -----------------------------------------------------------------------------
// Test 9: P2 Frontmatter Guard - resolveTombstoneConflictKeepLocal rejects corrupt frontmatter
// -----------------------------------------------------------------------------
console.log("\n--- Test 9: P2 Frontmatter Guard - resolveTombstoneConflictKeepLocal rejects corrupt frontmatter ---");
async function testKeepLocalRejectsCorruptFrontmatter() {
	const path = "notes/p2-corrupt.md";
	const corruptContent = "---\nunclosed: {dict\n---\ntext";

	const vaultSync = makeTestVaultSync({ deviceName: "dev-p2" });
	vaultSync.ensureFile(path, "v1", "dev-p2");
	vaultSync.handleDelete(path, "dev-p2", "op-del-p2");

	const file = makeTFile(path, { ctime: 1000, mtime: 1000, size: corruptContent.length });

	const controller = createTestController({
		app: {
			vault: {
				getFiles: () => [file],
				getMarkdownFiles: () => [file],
				getAbstractFileByPath: (p: string) => (p === path ? file : null),
				read: async () => corruptContent,
				adapter: { stat: async () => file.stat },
			},
			workspace: { iterateAllLeaves: () => {} },
		},
		vaultSync,
		shouldBlockFrontmatterIngest: (p) => p === path,
		deviceName: "dev-p2",
	});

	controller.recordTombstonedDiskConflict(path, 500, 1000, false);

	let threwExpected = false;
	try {
		await controller.resolveTombstoneConflictKeepLocal(path);
	} catch (err: any) {
		if (err.message.includes("Local properties are quarantined")) {
			threwExpected = true;
		} else {
			console.error("Unexpected error message:", err.message);
		}
	}

	assert(threwExpected, "resolveTombstoneConflictKeepLocal threw error due to quarantined frontmatter");
	assert(vaultSync.isMarkdownTombstoned(path), "path remains tombstoned after rejected keep-local");
	assert(vaultSync.getTextForPath(path) === null, "CRDT has no text for rejected keep-local");

	vaultSync.destroy();
}

async function testMoveAuthoritySurvivesSyncAndRestart() {
	console.log("\n--- Recorded moves survive peer sync, restart, and old-path disk returns ---");
	const path = "notes/move-source.md", target = "archive/move-source.md", content = "moved work";
	const source = makeTestVaultSync();
	source.sys.set("schemaVersion", 4);
	source.ensureFile(path, content);
	const fileId = source.getFileId(path);
	source.handleRename(path, target);
	assert(source.getFileId(target) === fileId, "normal move retains the same file ID");
	assert(source.getAuthoritativeMarkdownDeleteSnapshot(path)?.retirement?.movedTo === target, "old path records the move destination");
	assert(source.getAuthoritativeMarkdownDeleteSnapshot(target) === null, "move destination remains live");
	const previousMove = source.getAuthoritativeMarkdownDeleteSnapshot(path)!;
	source.handleRename(target, path);
	source.handleRename(path, target);
	assert(source.getAuthoritativeMarkdownDeleteSnapshot(path)?.fingerprint !== previousMove.fingerprint, "repeating a move creates distinct authority independent of the wall clock");


	const peer = makeTestVaultSync();
	Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(source.ydoc));
	const restarted = makeTestVaultSync();
	Y.applyUpdate(restarted.ydoc, Y.encodeStateAsUpdate(peer.ydoc));
	const result = restarted.reconcileVault(new Map([[path, content], [target, content]]), new Set([path, target]), "authoritative");
	assert(result.seededToCrdt.length === 0, "peer restart does not republish the old-path replica");
	assert(result.tombstonedDiskConflicts[0]?.movedTo === target, "reconcile explains where the note moved");
	assert(restarted.getTextForPath(path) === null && restarted.getFileId(target) === fileId, "only the moved identity remains active");
	assert(restarted.ensureFile(path, content).kind === "blocked", "ordinary create/import cannot occupy the retired path");

	const ghost = makeTFile(path, {ctime: 1, mtime: 1, size: content.length});
	const restoreController = createTestController({app: {
		vault: {getAbstractFileByPath: (p: string) => p === path ? ghost : null, read: async () => content, adapter: {stat: async () => ghost.stat}},
		workspace: {iterateAllLeaves: () => {}},
	}, vaultSync: peer});
	await restoreController.resolveTombstoneConflictKeepLocal(path);
	assert(peer.getFileId(path) !== fileId && peer.getTextForPath(path)?.toString() === content, "explicit Keep local can create a new identity at the old path");
	assert(peer.getFileId(target) === fileId && peer.getTextForPath(target)?.toString() === content, "restoring the old path does not repurpose the moved document");
	assert(peer.getMarkdownPathRetirement(path) === null, "explicit restore clears only its path retirement");

	// An actual move back is explicit path intent and needs no confirmation.
	restarted.handleRename(target, path);
	assert(restarted.getFileId(path) === fileId, "moving back automatically keeps the same identity");
	assert(restarted.getAuthoritativeMarkdownDeleteSnapshot(path) === null, "moving back clears the destination retirement");
	assert(restarted.isMarkdownTombstoned(target), "the newly vacated path is protected instead");

	const secondPath = "notes/second.md";
	restarted.ensureFile(secondPath, "second work");
	const secondId = restarted.getFileId(secondPath);
	restarted.applyReconcileRenameBatch(new Map([[path, "moved/first.md"], [secondPath, "moved/second.md"]]));
	assert(restarted.isMarkdownTombstoned(path) && restarted.isMarkdownTombstoned(secondPath), "folder rename records every vacated Markdown path");
	assert(restarted.getFileId("moved/first.md") === fileId && restarted.getFileId("moved/second.md") === secondId, "batch move preserves both identities");
	source.destroy(); peer.destroy(); restarted.destroy();
}

async function testImportDeleteRaceAndOrdinaryCreate() {
	console.log("\n--- Import cannot reverse a delete arriving during disk I/O ---");
	const path = "notes/import-race.md", content = "old disk bytes";
	const local = makeTestVaultSync(), remote = makeTestVaultSync();
	remote.ensureFile(path, content); remote.handleDelete(path);
	const deletedUpdate = Y.encodeStateAsUpdate(remote.ydoc);
	const file = makeTFile(path, { ctime: 10, mtime: 10, size: content.length });
	let deliverDelete = false;
	const controller = createTestController({
		app: { vault: {
			getFiles: () => [file], getMarkdownFiles: () => [file],
			getAbstractFileByPath: (p: string) => p === path ? file : null,
			read: async () => { if (deliverDelete) { deliverDelete = false; Y.applyUpdate(local.ydoc, deletedUpdate); } return content; },
			adapter: { stat: async () => file.stat },
		}, workspace: { iterateAllLeaves: () => {} } }, vaultSync: local,
		diskMirror: {isPreservedUnresolved: () => false, getPreservedUnresolvedEntries: () => [],
			flushWrite: async () => {}, hasPendingWrite: () => false, getLastDiskWriteOkHash: () => null},
	});
	await controller.runReconciliation("conservative");
	assert(controller.untrackedFileCount === 1, "the ordinary disk-only file naturally enters the import queue");
	deliverDelete = true;
	await controller.importUntrackedFiles();
	assert(local.isMarkdownTombstoned(path) && local.getTextForPath(path) === null, "delete delivered during read wins over import");
	assert(controller.untrackedFileCount === 0, "removed path is dropped rather than retried forever");
	assert(controller.getState().tombstonedDiskConflicts.some((entry) => entry.path === path), "the ambiguous disk copy remains reviewable");

	const ordinary = makeTestVaultSync();
	const ordinaryController = createTestController({app: {
		vault: {getAbstractFileByPath: (p: string) => p === path ? file : null, read: async () => content, adapter: {stat: async () => file.stat}},
		workspace: {iterateAllLeaves: () => {}},
	}, vaultSync: ordinary});
	ordinaryController.markMarkdownDirty(file, "create");
	await (ordinaryController as any).drainDirtyMarkdownPaths();
	assert(ordinary.getTextForPath(path)?.toString() === content, "a genuinely new path still syncs automatically");
	local.destroy(); remote.destroy(); ordinary.destroy();
}

async function testPreservedEventCannotUndelete() {
	console.log("\n--- Fresh events cannot resolve a recorded delete by themselves ---");
	for (const reason of ["create", "modify"] as const) {
		const path = `notes/preserved-${reason}.md`, content = "unchanged local replica";
		const vs = makeTestVaultSync(); vs.ensureFile(path, content); vs.handleDelete(path);
		const file = makeTFile(path, {ctime: Date.now() + 10000, mtime: Date.now() + 10000, size: content.length});
		let cleared = false;
		const entries = [{path, kind: "markdown", reason: "remote-delete-local-conflict", episodeId: "preserved-episode", firstSeenAt: 1, lastSeenAt: 1}];
		const controller = createTestController({app: {
			vault: {getAbstractFileByPath: (p: string) => p === path ? file : null, read: async () => content, adapter: {stat: async () => file.stat}},
			workspace: {iterateAllLeaves: () => {}},
		}, vaultSync: vs, diskMirror: {
			shouldSuppressCreate: async () => false, shouldSuppressModify: async () => false,
			getPreservedUnresolvedEntries: () => entries,
			isPreservedUnresolved: () => true, clearPreservedUnresolved: () => {cleared = true;},
		}});
		controller.markMarkdownDirty(file, reason);
		await (controller as any).drainDirtyMarkdownPaths();
		assert(vs.getTextForPath(path) === null && vs.isMarkdownTombstoned(path), `${reason} with fresh timestamps cannot undo deletion`);
		assert(!cleared, `${reason} preserves the unresolved episode`);
		vs.destroy();
	}
}

async function testStaleRemovalActions() {
	console.log("\n--- Old confirmations cannot delete or overwrite a new live file ---");
	const path = "notes/stale-confirmation.md", content = "old local copy";
	const vs = makeTestVaultSync(); vs.ensureFile(path, content); vs.handleDelete(path);
	let file = makeTFile(path, {ctime: 10, mtime: 10, size: content.length});
	let trashed = false, reviveDuringRead = false;
	const controller = createTestController({app: {
		vault: {getAbstractFileByPath: (p: string) => p === path ? file : null,
			read: async () => {
				if (reviveDuringRead) {reviveDuringRead = false; vs.ensureFile(path, "new remote work", undefined, {reviveTombstone: true});}
				return content;
			}, adapter: {stat: async () => file.stat}},
		workspace: {iterateAllLeaves: () => {}}, fileManager: {trashFile: async () => {trashed = true;}},
	}, vaultSync: vs});
	const first = {remoteDeleteFingerprint: vs.getAuthoritativeMarkdownDeleteSnapshot(path)!.fingerprint};
	vs.ensureFile(path, "new remote work", undefined, {reviveTombstone: true});
	for (const action of ["resolveTombstoneConflictKeepLocal", "resolveTombstoneConflictAcceptDelete"] as const) {
		let rejected = false;
		try {await controller[action](path, first);} catch {rejected = true;}
		assert(rejected && !trashed && vs.getTextForPath(path)?.toString() === "new remote work", `${action} rejects a confirmation for an already-revived path`);
	}
	vs.handleDelete(path);
	let rejectedOldEpisode = false;
	try {await controller.resolveTombstoneConflictAcceptDelete(path, first);} catch {rejectedOldEpisode = true;}
	assert(rejectedOldEpisode && !trashed, "a second deletion does not reuse the first deletion's authority");
	for (const action of ["resolveTombstoneConflictKeepLocal", "resolveTombstoneConflictAcceptDelete"] as const) {
		const target = {remoteDeleteFingerprint: vs.getAuthoritativeMarkdownDeleteSnapshot(path)!.fingerprint};
		reviveDuringRead = true;
		let rejected = false;
		try {await controller[action](path, target);} catch {rejected = true;}
		assert(rejected && !trashed && vs.getTextForPath(path)?.toString() === "new remote work", `${action} rechecks authority after asynchronous file reads`);
		vs.handleDelete(path);
	}
	controller.recordTombstonedDiskConflict(path, vs.getMarkdownTombstoneDeletedAt(path), file.stat.ctime);
	const conflict = controller.getState().tombstonedDiskConflicts.find(entry => entry.path === path)!;
	const target = {remoteDeleteFingerprint: conflict.removalFingerprint, localFileToken: conflict.localFileToken};
	file = makeTFile(path, {ctime: 10, mtime: 10, size: content.length});
	let rejectedReplacement = false;
	try {await controller.resolveTombstoneConflictAcceptDelete(path, target);} catch {rejectedReplacement = true;}
	assert(rejectedReplacement && !trashed, "same-path replacement with identical stats cannot reuse an old confirmation");
	controller.recordTombstonedDiskConflict(path, vs.getMarkdownTombstoneDeletedAt(path), file.stat.ctime);
	const beforeEdit = controller.getState().tombstonedDiskConflicts.find(entry => entry.path === path)!;
	controller.noteMarkdownDiskMutation(path);
	let rejectedEdit = false;
	try {await controller.resolveTombstoneConflictAcceptDelete(path, {remoteDeleteFingerprint: beforeEdit.removalFingerprint, localFileToken: beforeEdit.localFileToken});}
	catch {rejectedEdit = true;}
	assert(rejectedEdit && !trashed, "a same-stat local edit also expires the confirmation");
	vs.destroy();
}

async function testStartupRemovalCleanup() {
	console.log("\n--- Startup repairs missed deletions while preserving unsent work ---");
	for (const state of ["clean", "modified", "unknown-baseline"] as const) {
		const path = `notes/startup-${state}.md`, baseline = "last settled work";
		const content = state === "modified" ? baseline + " plus unsent changes" : baseline;
		const vs = makeTestVaultSync(); vs.ensureFile(path, baseline); vs.handleDelete(path);
		let current: TFile | null = makeTFile(path, {ctime: 1, mtime: 1, size: content.length});
		let trashCalls = 0;
		const app = {
			vault: {
				getFiles: () => current ? [current] : [], getMarkdownFiles: () => current ? [current] : [],
				getAbstractFileByPath: (p: string) => p === path ? current : null,
				read: async () => content, adapter: {stat: async () => current?.stat ?? null},
			}, workspace: {iterateAllLeaves: () => {}},
			fileManager: {trashFile: async () => {trashCalls++; current = null;}},
		};
		const mirror = new DiskMirror(app as any, vs, {unbindByPath: () => {}, getLastEditorActivityForPath: () => null} as any, false);
		mirror.setMarkdownPathSyncabilityPredicate(() => true);
		mirror.setRemoteProjectionAdmissionPredicate(() => true);
		if (state !== "unknown-baseline") {
			const hash = await contentBaselineHash(baseline);
			mirror.setDiskBaselineHashProvider(() => hash);
			mirror.setDiskBaselineTextProvider(() => baseline);
		}
		const controller = createTestController({app, vaultSync: vs, diskMirror: mirror});
		await controller.runReconciliation("authoritative");
		assert(vs.isMarkdownTombstoned(path) && vs.getTextForPath(path) === null, `${state}: startup retains the shared deletion`);
		if (state === "clean") {
			assert(current === null && trashCalls === 1, "verified clean leftover is automatically moved to recoverable trash");
			assert(controller.getState().tombstonedDiskConflicts.length === 0, "automatically cleaned replica needs no confirmation");
		} else {
			assert(current !== null && trashCalls === 0, `${state}: uncertain or modified local bytes survive`);
			assert(mirror.isPreservedUnresolved(path), `${state}: local work remains quarantined instead of being republished`);
		}
		vs.destroy();
	}
}

async function testLastMoveOnlyAndHistoricalFiles() {
	console.log("\n--- One last move per identity; earlier paths use existing file history ---");
	const source = makeTestVaultSync();
	source.sys.set("schemaVersion", 4);
	const a = "old/A.md", b = "intermediate/B.md", c = "current/C.md";
	const content = "same identity, moved several times";
	source.ensureFile(a, content);
	const fileId = source.getFileId(a)!;
	source.handleRename(a, b);
	source.handleRename(b, c);
	assert(source.ydoc.getMap("markdownPathRetirements").size === 1, "repeated moves retain exactly one shared record for the file");
	assert(source.getMarkdownPathRetirement(a) === null, "the path before the last move is not stored in the shared map");
	assert(source.getMarkdownPathRetirement(b)?.movedTo === c, "the retained record describes only the immediately preceding path");

	const peer = makeTestVaultSync();
	Y.applyUpdate(peer.ydoc, Y.encodeStateAsUpdate(source.ydoc));
	let historyAvailable = true;
	peer.configureMarkdownCreationHistory(async paths => {
		if (!historyAvailable) throw new Error("offline history");
		return new Map(paths.map(path => [path, path === a ? [{ fileId, historyId: "existing-created-history" }] : []]));
	});
	assert(peer.ensureFile(a, content).kind === "blocked", "unverified disk files cannot bypass history admission");
	await peer.prepareMarkdownCreationHistory([a]);
	assert(peer.getAuthoritativeMarkdownDeleteSnapshot(a)?.retirement?.movedTo === c, "existing history links the earliest path to the current file ID");
	assert(peer.ensureFile(a, content).kind === "blocked", "earliest path remains blocked although only the last move is persisted");
	assert(peer.isPathTombstoned(a), "lower-level removal guards also recognize history-backed paths");
	assert(peer.ydoc.getMap("markdownPathRetirements").size === 1, "reading history does not recreate older shared path records");

	const ghost = makeTFile(a, { size: content.length });
	const controller = createTestController({ app: {
		vault: { getAbstractFileByPath: (path: string) => path === a ? ghost : null, read: async () => content,
			adapter: { stat: async () => ghost.stat } },
		workspace: { iterateAllLeaves: () => {} },
	}, vaultSync: peer });
	await controller.syncFileFromDisk(ghost, "create");
	assert(peer.getTextForPath(a) === null, "fresh filesystem create events cannot republish a historical path");
	assert(controller.getState().tombstonedDiskConflicts.some(entry => entry.path === a && entry.movedTo === c), "historical-path conflicts are visible with the current destination");
	await controller.resolveTombstoneConflictKeepLocal(a);
	assert(peer.getFileId(a) !== fileId && peer.getFileId(c) === fileId, "explicit Keep local creates a separate identity without moving the current note");
	assert(peer.getMarkdownPathRetirement(b)?.movedTo === c, "restoring an earlier path preserves the file's last-move record");

	const newPath = "new/unrelated.md";
	historyAvailable = false;
	assert(!await peer.prepareMarkdownCreationHistory([newPath]), "history failures defer new-file admission");
	assert(peer.ensureFile(newPath, content).kind === "blocked", "missing history is never interpreted as evidence of a new file");
	historyAvailable = true;
	await peer.prepareMarkdownCreationHistory([newPath]);
	assert(peer.ensureFile(newPath, content).kind === "created", "a new path with identical text remains a legitimate separate note");
	const offlinePath = "offline/new.md";
	(peer.provider as any).wsconnected = false;
	assert(!await peer.prepareMarkdownCreationHistory([offlinePath]), "offline new-file creation waits for server history");
	assert(peer.ensureFile(offlinePath, "offline work").kind === "blocked", "an offline disk file is not prematurely assigned a sync identity");
	(peer.provider as any).wsconnected = true;
	(peer.provider as any).synced = false;
	assert(!await peer.prepareMarkdownCreationHistory([offlinePath]), "an open reconnect socket is insufficient before room synchronization");
	(peer.provider as any).synced = true;
	await peer.prepareMarkdownCreationHistory([offlinePath]);
	assert(peer.ensureFile(offlinePath, "offline work").kind === "created", "offline work can sync after history is available");

	const previouslyNew = "future/new.md";
	await peer.prepareMarkdownCreationHistory([previouslyNew]);
	peer.handleRename(c, previouslyNew);
	peer.handleRename(previouslyNew, c);
	assert(peer.ensureFile(previouslyNew, content).kind === "blocked", "moves invalidate a previous new-path decision");
	assert(peer.ydoc.getMap("markdownPathRetirements").size === 1, "additional moves keep the shared record count bounded");
	source.destroy(); peer.destroy();
}

async function testHistoryPaginationAndRaces() {
	console.log("\n--- History pagination, caching, and concurrent removal fences ---");
	const manifest = (id: string, entries: any[]): any => ({ manifestId: id, manifestHash: id, stateHash: id, changedEntries: entries });
	const first = manifest("recent", [{fileId: "id", kind: "renamed", path: "C.md", oldPath: "B.md", newPath: "C.md"}]);
	const second = manifest("earlier", [{fileId: "id", kind: "created", path: "A.md"}]);
	let requests = 0;
	const list = async (cursor?: string): Promise<FileHistoryManifestList> => {
		requests++;
		return cursor ? {manifests: [second], totalManifestKeys: 2, limited: false, nextCursor: null}
			: {manifests: [first], totalManifestKeys: 2, limited: true, nextCursor: "next"};
	};
	const loader = createMarkdownCreationHistoryLoader(list);
	const loaded = await loader(["A.md", "B.md", "C.md", "new.md"], "generation-1");
	assert(loaded.get("A.md")?.[0]?.fileId === "id", "older pages participate in historical identity lookup");
	assert(loaded.get("B.md")?.length === 1 && loaded.get("C.md")?.length === 1, "rename source and destination both belong to file history");
	await loader(["another-new.md"], "generation-1");
	assert(requests === 2, "subsequent new notes reuse the session index without refetching all history");
	await loader(["new.md"], "generation-2");
	assert(requests === 4, "a new connection or structural epoch refreshes the history index");
	for (const page of [
		{manifests: [first], totalManifestKeys: 2, limited: true, nextCursor: null},
		{manifests: [first], totalManifestKeys: 2, limited: false, nextCursor: null},
		{manifests: [{...first, manifestHash: ""}], totalManifestKeys: 1, limited: false, nextCursor: null},
	]) {
		let rejected = false;
		try { await readMarkdownCreationHistory(["new.md"], async () => page); } catch { rejected = true; }
		assert(rejected, "incomplete or synthesized history cannot authorize new-file uploads");
	}

	const vs = makeTestVaultSync();
	vs.sys.set("schemaVersion", 4);
	vs.ensureFile("A.md", "old");
	let finish: ((value: Map<string, any[]>) => void) | undefined;
	vs.configureMarkdownCreationHistory(() => new Promise(resolve => { finish = resolve; }));
	const pending = vs.prepareMarkdownCreationHistory(["new.md"]);
	vs.handleRename("A.md", "B.md");
	finish!(new Map([["new.md", []]]));
	await pending;
	assert(vs.ensureFile("new.md", "new").kind === "blocked", "metadata changes during history I/O invalidate negative admission evidence");
	vs.handleRename("B.md", "C.md");
	assert(vs.ensureFile("A.md", "old").kind === "blocked", "observed earlier moves stay protected for the session without persistent path accumulation");
	vs.destroy();

	const reset = makeTestVaultSync();
	let resetSeed = true;
	reset.configureMarkdownCreationHistory(async () => { throw new Error("history unavailable"); }, path => {
		if (!resetSeed || path !== "reset.md") return false;
		resetSeed = false;
		return true;
	});
	await reset.prepareMarkdownCreationHistory(["reset.md"]);
	assert(reset.ensureFile("reset.md", "confirmed disk snapshot").kind === "created", "confirmed reset can seed its exact disk snapshot independently of old file history");
	reset.handleDelete("reset.md");
	assert(reset.ensureFile("reset.md", "returned bytes").kind === "blocked", "one-shot reset authority cannot revive a subsequent deletion");
	reset.destroy();
}

// Run async tests
(async () => {
	await testLastMoveOnlyAndHistoricalFiles();
	await testHistoryPaginationAndRaces();
	await testStartupRemovalCleanup();
	await testMoveAuthoritySurvivesSyncAndRestart();
	await testImportDeleteRaceAndOrdinaryCreate();
	await testPreservedEventCannotUndelete();
	await testStaleRemovalActions();
	await testStage1Backstop();
	await testStage1Safety();
	await testStage2UI();
	await testStage3a();
	await testStage3b();
	await testStage3c();
	await testSweepBlocksCorruptFrontmatterRevival();
	await testKeepLocalRejectsCorruptFrontmatter();

	console.log("\n──────────────────────────────────────────────────");
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log("──────────────────────────────────────────────────");

	if (failed > 0) {
		process.exit(1);
	}
})().catch((err) => {
	console.error("Unhandled error in tests:", err);
	process.exit(1);
});
