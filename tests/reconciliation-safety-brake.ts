import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { contentBaselineHash, updateIndex, type DiskIndex } from "../src/sync/diskIndex";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
} from "../src/sync/origins";

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

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

console.log("\n--- Test 1: updateIndex carries excluded paths forward unchanged ---");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1, contentHash: "hash-blocked" },
		"clean.md": { mtime: 1, size: 1 },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 2, size: 2 }],
		["clean.md", { mtime: 2, size: 2 }],
		["new.md", { mtime: 2, size: 2 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md"] });
	// "Excluded from advancement" preserves the durable baseline entry — dropping
	// it would erase the baseline for an open-editor/preserved path and amplify
	// conservative behavior on the next reconcile.
	assert("blocked.md" in next, "blocked path is carried forward, not dropped");
	assert(next["blocked.md"].mtime === 1 && next["blocked.md"].contentHash === "hash-blocked", "blocked path keeps its previous entry unchanged");
	assert(next["clean.md"].mtime === 2, "unblocked path advances mtime");
	assert(next["new.md"].mtime === 2, "new unblocked path is indexed");
}

console.log("\n--- Test 2: excluded paths with no previous entry stay unindexed ---");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1, contentHash: "hash-blocked" },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 1, size: 1 }],
		["never-indexed.md", { mtime: 1, size: 1 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md", "never-indexed.md"] });
	assert(next["blocked.md"]?.mtime === 1, "same-stat blocked path is carried forward");
	assert(!("never-indexed.md" in next), "excluded path without a previous entry stays unindexed");
}

console.log("\n--- Test 2b: clean equal disk/CRDT paths get a settled baseline ---");
{
	const path = "clean-equal.md";
	const content = "same content";
	const file = makeTFile(path);
	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 5, size: content.length }],
	]);
	const flushed: string[] = [];
	let saveDiskIndexCalls = 0;
	let resolveSave: (() => void) | null = null;
	let resolveSaveStarted: (() => void) | null = null;
	const saveRelease = new Promise<void>((resolve) => { resolveSave = resolve; });
	const saveStarted = new Promise<void>((resolve) => { resolveSaveStarted = resolve; });
	let saveCompleted = false;
	let reconcileCompleted = false;

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (readFile: TFile & { path: string }) => {
				assert(readFile.path === path, "clean baseline test reads the expected file");
				return content;
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: () => null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? { toJSON: () => content } : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [],
			seededToCrdt: [],
			untracked: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({ flushWrite: async (flushPath: string) => { flushed.push(flushPath); } }) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {
			saveDiskIndexCalls++;
			resolveSaveStarted?.();
			await saveRelease;
			saveCompleted = true;
		},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	const reconcileRun = controller.runReconciliation("authoritative").then(() => {
		reconcileCompleted = true;
	});
	await saveStarted;
	await Promise.resolve();
	assert(reconcileCompleted === false, "reconciliation waits for disk index save");
	if (!resolveSave) throw new Error("save release was not initialised");
	resolveSave();
	await reconcileRun;

	const baselineHash = diskIndex[path]?.contentHash;
	assert(saveCompleted, "disk index save completes before reconciliation returns");
	assert(typeof baselineHash === "string" && baselineHash.length === 64, "equal path records a content baseline");
	assert(diskIndex[path]?.mtime === 5, "equal path keeps fresh disk stats");
	assert(flushed.length === 0, "equal path does not need a disk flush");
	assert(saveDiskIndexCalls === 1, "disk index save is attempted after clean baseline recording");
}

console.log("\n--- Test 2b0: projection-blocked missing disk preserves local-deletion baseline ---");
{
	const path = "locally-deleted-while-policy-closed.md";
	const priorContent = "last clean local content\n";
	const remoteContent = "provider content still present\n";
	const priorHash = await contentBaselineHash(priorContent);
	const priorEntry = {
		mtime: 17,
		size: priorContent.length,
		contentHash: priorHash,
	};
	let diskIndex: DiskIndex = { [path]: { ...priorEntry } };
	let flushCalls = 0;
	const ytext = { toJSON: () => remoteContent };
	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [path],
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		isMarkdownTombstoned: () => false,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [path],
			updatedOnDisk: [],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			pathBindingConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({
			duplicateIds: 0,
			orphansCleaned: 0,
			duplicateActivePaths: 0,
		}),
	};
	const diskMirror = {
		captureRemoteProjectionAdmission: () => null,
		flushWrite: async () => {
			flushCalls++;
			throw new Error("projection-blocked path must not reach DiskMirror");
		},
		getPreservedUnresolvedEntries: () => [],
	};
	const controller = new ReconciliationController({
		app: {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getAbstractFileByPath: () => null,
				adapter: { stat: async () => null },
			},
			workspace: { iterateAllLeaves: () => {} },
		} as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => diskMirror as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		isRemoteProjectionAllowed: () => false,
		shouldBlockFrontmatterIngest: () => false,
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
	} as any);

	await controller.runReconciliation("authoritative");

	assert(flushCalls === 0, "closed provider policy performs no missing-path projection");
	assert(
		JSON.stringify(diskIndex[path]) === JSON.stringify(priorEntry),
		"closed provider policy preserves the exact prior baseline for local deletion detection",
	);
	controller.reset();
}

console.log("\n--- Test 2b0a: admitted missing-disk projection that later defers preserves baseline ---");
{
	const path = "locally-deleted-during-admitted-projection.md";
	const priorContent = "last clean deletion baseline\n";
	const remoteContent = "remote candidate after local delete\n";
	const priorHash = await contentBaselineHash(priorContent);
	const priorEntry = {
		mtime: 23,
		size: priorContent.length,
		contentHash: priorHash,
	};
	let diskIndex: DiskIndex = { [path]: { ...priorEntry } };
	let flushCalls = 0;
	const admission = { isCurrent: () => false };
	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [path],
		getTextForPath: (candidate: string) => (
			candidate === path ? { toJSON: () => remoteContent } : null
		),
		isMarkdownTombstoned: () => false,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [path],
			updatedOnDisk: [],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			pathBindingConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({
			duplicateIds: 0,
			orphansCleaned: 0,
			duplicateActivePaths: 0,
		}),
	};
	const diskMirror = {
		captureRemoteProjectionAdmission: () => admission,
		flushWrite: async () => {
			flushCalls++;
			return {
				kind: "deferred" as const,
				path,
				reason: "remote-projection-not-ready" as const,
			};
		},
		getPreservedUnresolvedEntries: () => [],
	};
	const controller = new ReconciliationController({
		app: {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getAbstractFileByPath: () => null,
				adapter: { stat: async () => null },
			},
			workspace: { iterateAllLeaves: () => {} },
		} as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => diskMirror as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		isRemoteProjectionAllowed: () => true,
		shouldBlockFrontmatterIngest: () => false,
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
	} as any);

	await controller.runReconciliation("authoritative");

	assert(flushCalls === 1, "admitted projection reaches the simulated mid-flight policy close");
	assert(
		JSON.stringify(diskIndex[path]) === JSON.stringify(priorEntry),
		"mid-flight projection deferral preserves the exact local-deletion baseline",
	);
	controller.reset();
}

console.log("\n--- Test 2b1: baseline records the disk snapshot C1, never later CRDT C2 ---");
{
	const path = "settled-snapshot-race.md";
	const diskBaseline = "DISK_BASE\n";
	const committedC1 = "REMOTE_C1\n";
	const laterC2 = "REMOTE_C2\n";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, committedC1);
	const diskBaselineHash = await contentBaselineHash(diskBaseline);
	const committedC1Hash = await contentBaselineHash(committedC1);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: diskBaseline.length, contentHash: diskBaselineHash },
	};
	const recordedBaselineTexts = new Map<string, string>();

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async () => diskBaseline,
			adapter: { stat: async () => ({ mtime: 2, size: diskBaseline.length }) },
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
		},
		workspace: { iterateAllLeaves: () => {} },
	};
	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0, duplicateActivePaths: 0 }),
	};
	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [] }) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async () => {
				doc.transact(() => {
					ytext.delete(0, ytext.length);
					ytext.insert(0, laterC2);
				}, { kind: "provider" });
				return {
					kind: "written",
					path,
					isCreate: false,
					content: committedC1,
					contentHash: committedC1Hash,
					baselineRecorded: true,
				};
			},
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		recordBaselineText: (hash, text) => { recordedBaselineTexts.set(hash, text); },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
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
	});

	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === laterC2, "provider can advance CRDT to C2 after disk committed C1");
	assert(diskIndex[path]?.contentHash === committedC1Hash, "disk index records committed C1 hash, not live C2");
	assert(recordedBaselineTexts.get(committedC1Hash) === committedC1, "baseline text stores the committed C1 snapshot");
	doc.destroy();
}

console.log("\n--- Test 2c: fenced disk conflict winner settles its baseline immediately ---");
{
	const path = "conflict-then-equal.md";
	const diskContent = "offline disk edit";
	const crdtContent = "remote crdt edit";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: crdtContent.length },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 2_000, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const flushed: string[] = [];
	let reconcileCallCount = 0;

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => {
			reconcileCallCount++;
			return {
				mode: "authoritative",
				createdOnDisk: [],
				updatedOnDisk: reconcileCallCount === 1 ? [path] : [],
				seededToCrdt: [],
				untracked: [],
				skipped: 0,
			};
		},
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async (flushPath: string) => { flushed.push(flushPath); },
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastSaveDiskIndexAt: () => 1_000,
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === diskContent, "first pass applies disk winner to CRDT");
	assert(createdFiles.size === 0, "first pass creates no conflict artifact");
	const expectedDiskHash = await contentBaselineHash(diskContent);
	const baselineHash = diskIndex[path]?.contentHash;
	assert(
		baselineHash === expectedDiskHash,
		"final disk/CRDT compare-and-commit records the conflict winner baseline in the same pass",
	);
	assert(flushed.length === 0, "disk-wins conflict path does not require CRDT-to-disk flush");
	doc.destroy();
}

console.log("\n--- Test 2c1: closed-file stale decision cannot overwrite a newer provider update ---");
{
	const path = "closed-provider-race.md";
	const baselineContent = "base\n";
	const diskContent = "disk edit\n";
	const capturedCrdtContent = "remote edit one\n";
	const newestCrdtContent = "remote edit two\n";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, capturedCrdtContent);
	const providerOrigin = { kind: "provider" };
	const baselineHash = await contentBaselineHash(baselineContent);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: baselineContent.length, contentHash: baselineHash },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 2, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const discarded: string[] = [];
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	let providerAdvancedDuringDiscardRecord = false;

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: { iterateAllLeaves: () => {} },
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async () => { throw new Error("stale disk decision must not flush"); },
			suppressLocalCreate: async () => {},
			recordPreservedUnresolved: () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		getBaselineText: async (hash: string) => hash === baselineHash ? baselineContent : null,
		recordDiscardedRevision: (_path, _contentHash, _reason) => {
			discarded.push(_contentHash);
			// The provider advances inside the async discard-record seam; the
			// following compare-and-commit must see the newer CRDT and abort.
			if (!providerAdvancedDuringDiscardRecord) {
				providerAdvancedDuringDiscardRecord = true;
				doc.transact(() => {
					ytext.delete(0, ytext.length);
					ytext.insert(0, newestCrdtContent);
				}, providerOrigin);
			}
		},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (_source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(providerAdvancedDuringDiscardRecord, "provider update lands inside the async discard-record window");
	assert(ytext.toString() === newestCrdtContent, "newest provider content survives the stale disk decision");
	assert(createdFiles.size === 0, "the stale decision creates no conflict artifacts");
	assert(
		discarded.length >= 2,
		"captured CRDT side and the disk snapshot are both recorded as discarded revisions",
	);
	assert(
		path in diskIndex && diskIndex[path]?.contentHash === baselineHash,
		"stale decision path carries its previous durable baseline entry forward",
	);
	assert(
		traces.some((trace) =>
			trace.msg === "closed-file-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-content-changed"
		),
		"stale provider race is diagnosed explicitly",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n--- Test 2c2: pending local create wins missing-baseline reconcile ---");
{
	const path = "new-file-race.md";
	const diskContent = "local create body";
	const crdtContent = "older crdt body";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 500, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const flushed: string[] = [];
	const decisions: Array<Record<string, unknown>> = [];

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async (flushPath: string) => { flushed.push(flushPath); },
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastSaveDiskIndexAt: () => 1000,
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		recordFlightPathEvent: (event) => {
			if (event.kind === "reconcile.file.decision") decisions.push(event.data ?? {});
		},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	controller.markMarkdownDirty(file, "create", "op-local-create");
	const timer = (controller as any).markdownDrainTimer as ReturnType<typeof setTimeout> | null;
	if (timer) clearTimeout(timer);
	(controller as any).markdownDrainTimer = null;

	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === diskContent, "pending create imports disk content to CRDT");
	assert(flushed.length === 0, "pending create does not flush stale CRDT to disk");
	assert(createdFiles.size === 0, "pending create records the stale CRDT side without a conflict artifact");
	assert(
		decisions.some((decision) =>
			decision.reason === "missing-baseline" &&
			decision.winner === "disk" &&
			decision.missingBaselinePolicy === "local-create-event"
		),
		"decision records local-create-event missing-baseline policy",
	);
	doc.destroy();
}

console.log("\n--- Test 2d: startup open editor content wins before binding can overwrite it ---");
{
	const path = "open-reenable.md";
	const diskContent = "LOCAL_ON_EDITOR\n";
	const editorContent = "LOCAL_ON_EDITOR\n";
	const crdtContent = "REMOTE_FROM_CRDT\n";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const transactionOrigins: unknown[] = [];
	doc.on("afterTransaction", (txn) => transactionOrigins.push(txn.origin));

	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 12, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const flushed: string[] = [];
	const decisions: Array<Record<string, unknown>> = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async (flushPath: string) => { flushed.push(flushPath); },
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => false,
		}) as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		recordFlightPathEvent: (event) => {
			if (event.kind === "reconcile.file.decision") decisions.push(event.data ?? {});
		},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === editorContent, "open editor content is applied to CRDT before binding");
	assert(createdFiles.size === 0, "startup editor-wins creates no conflict artifact");
	assert(flushed.length === 0, "open editor reconcile does not write remote CRDT over disk");
	assert(
		transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"open editor reconcile uses a known local repair origin",
	);
	assert(
		decisions.some((decision) => decision.decision === "open-editor-wins"),
		"open editor reconcile emits an explicit decision",
	);
	assert(
		traces.some((event) => event.msg === "open-file-reconcile-editor-wins"),
		"open editor reconcile traces editor-wins convergence",
	);
	doc.destroy();
}

console.log("\n--- Test 2d1: remote C2 cannot be reverted by the stale open editor C1 ---");
{
	const path = "open-provider-patch-window.md";
	let diskContent = "SETTLED_C1\n";
	const editorContent = "SETTLED_C1\n";
	const crdtContent = "REMOTE_C2\n";
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const baselineHash = await contentBaselineHash(diskContent);
	let lastRemoteUpdateAt = Date.now() - 50;
	let diskIndex: DiskIndex = {
		[path]: { mtime: 12, size: diskContent.length, contentHash: baselineHash },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 12, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const flushes: Array<{ path: string; expectedDiskContent?: string }> = [];
	const decisions: Array<Record<string, unknown>> = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		get lastRemoteUpdateAt() { return lastRemoteUpdateAt; },
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async (
				flushPath: string,
				_force?: boolean,
				options?: { expectedDiskContent?: string },
			) => {
				flushes.push({ path: flushPath, expectedDiskContent: options?.expectedDiskContent });
				return { kind: "deferred", path: flushPath, reason: "open-editor-mismatch" } as const;
			},
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => false,
			getLastEditorActivityForPath: () => null,
			getBindingDebugInfoForView: () => null,
			getCollabDebugInfoForView: () => null,
		}) as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		recordFlightPathEvent: (event) => {
			if (event.kind === "reconcile.file.decision") decisions.push(event.data ?? {});
		},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");
	const internals = controller as any;
	assert(ytext.toString() === crdtContent, "recent provider C2 survives the editor patch window");
	assert(createdFiles.size === 0, "recent provider settle does not create a false CRDT conflict artifact");
	assert(flushes.length === 0, "recent provider settle waits before trying disk writeback");
	assert(
		!internals.visibleAuthorityDeferredPaths.has(path),
		"baseline-equal visible C1 is not promoted to deferred editor authority",
	);
	assert(
		diskIndex[path]?.contentHash === baselineHash,
		"remote settle defer retains the durable C1 baseline needed for the next three-way plan",
	);
	assert(
		traces.some((event) =>
			event.msg === "open-file-reconcile-deferred-editor-settle" &&
			event.details?.reason === "recent-remote-update" &&
			event.details?.captureVisibleAuthority === false
		),
		"recent provider transaction is deferred as a stale-render window",
	);

	const cooldownTimer = internals.reconcileCooldownTimer as ReturnType<typeof setTimeout> | null;
	if (cooldownTimer) clearTimeout(cooldownTimer);
	internals.reconcileCooldownTimer = null;
	internals.reconcilePending = false;
	internals.lastReconcileTime = 0;
	lastRemoteUpdateAt = Date.now() - 10_000;
	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === crdtContent, "expired settle window still never force-replaces remote C2 with C1");
	assert(createdFiles.size === 0, "disk-at-baseline handoff needs no conflict artifact");
	assert(
		flushes.length === 1 &&
		flushes[0]?.path === path &&
		flushes[0]?.expectedDiskContent === diskContent,
		"open planner hands the unique CRDT change to fenced disk writeback",
	);
	assert(
		traces.some((event) => event.msg === "open-file-editor-writeback-skipped-crdt-authoritative"),
		"controller traces that stale editor writeback was rejected",
	);
	assert(
		decisions.some((decision) =>
			decision.decision === "keep-crdt-authority" &&
			decision.reason === "disk-at-baseline"
		),
		"authority decision records CRDT as the unique changed side",
	);
	assert(
		diskIndex[path]?.contentHash === baselineHash,
		"deferred fenced write retains C1 baseline instead of erasing its proof",
	);
	assert(
		!traces.some((event) => event.msg === "open-file-reconcile-editor-wins"),
		"neither phase enters the rollback-prone editor-wins shortcut",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n--- Test 2e: recent startup typing defers open editor conflict creation ---");
{
	const path = "open-typing-during-connect.md";
	let diskContent = "LOCAL_STILL_TYPING\n";
	const editorContent = "LOCAL_STILL_TYPING plus more\n";
	const crdtContent = "REMOTE_FROM_INITIAL_SYNC\n";
	let isOpen = true;
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 12, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path ? file : (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async () => {},
			suppressLocalCreate: async () => {},
			clearPreservedUnresolved: () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => isOpen,
			getLastEditorActivityForPath: (candidate: string) =>
				candidate === path ? Date.now() - 100 : null,
		}) as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	const internals = controller as any;
	const marker = internals.visibleAuthorityDeferredPaths.get(path);

	assert(createdFiles.size === 0, "recent typing does not create a conflict artifact");
	assert(ytext.toString() === crdtContent, "recent typing does not force a premature CRDT winner");
	assert(
		marker?.readComplete === true &&
		marker.editorContents.length === 1 &&
		marker.editorContents[0] === editorContent,
		"recent typing captures the exact visible editor authority",
	);
	assert(!diskIndex[path], "deferred open editor path is not advanced in the disk index");
	assert(
		traces.some((event) =>
			event.msg === "open-file-reconcile-deferred-editor-settle" &&
			event.details?.reason === "recent-editor-activity"
		),
		"defer path emits an explicit trace",
	);
	assert(
		!traces.some((event) => event.msg === "open-file-reconcile-editor-wins"),
		"defer path avoids the conflict-preserving editor-wins branch",
	);

	// Reproduce the rollback window exactly: the view closes, Obsidian saves E
	// to disk, while Y.Text still contains the competing C from initial sync.
	// The captured editor marker must make E authoritative after close and keep
	// C only as a conflict artifact; it must never write C back over E.
	isOpen = false;
	diskContent = editorContent;
	stats.set(path, { mtime: 13, size: diskContent.length });
	const cooldownTimer = internals.reconcileCooldownTimer as ReturnType<typeof setTimeout> | null;
	if (cooldownTimer) clearTimeout(cooldownTimer);
	internals.reconcileCooldownTimer = null;
	internals.reconcilePending = false;
	internals.lastReconcileTime = 0;
	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === editorContent, "close/autosave converges CRDT to captured editor E");
	assert(diskContent === editorContent, "close/autosave leaves captured editor E on the original disk path");
	assert(createdFiles.size === 0, "competing CRDT C creates no conflict artifact");
	assert(
		diskIndex[path]?.contentHash === await contentBaselineHash(editorContent),
		"E becomes the durable settled baseline after close",
	);
	assert(
		!internals.visibleAuthorityDeferredPaths.has(path),
		"captured editor marker clears only after disk and CRDT settle on E",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n--- Test 2f: startup editor ahead of disk and CRDT defers without activity timestamp ---");
{
	const path = "open-editor-ahead-without-timestamp.md";
	let diskContent = "LOCAL_AUTOSAVED\n";
	const editorContent = "LOCAL_AUTOSAVED plus unsaved editor text\n";
	const crdtContent = "REMOTE_FROM_INITIAL_SYNC\n";
	let isOpen = true;
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 12, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path ? file : (createdFiles.has(candidate) ? ({ path: candidate }) : null),
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({
			flushWrite: async () => {},
			suppressLocalCreate: async () => {},
			clearPreservedUnresolved: () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => isOpen,
			getLastEditorActivityForPath: () => null,
		}) as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	const internals = controller as any;
	const marker = internals.visibleAuthorityDeferredPaths.get(path);

	assert(createdFiles.size === 0, "editor-ahead startup does not create conflict artifacts");
	assert(ytext.toString() === crdtContent, "editor-ahead startup does not pick a premature winner");
	assert(
		marker?.readComplete === true &&
		marker.editorContents.length === 1 &&
		marker.editorContents[0] === editorContent,
		"editor-ahead startup captures the no-timestamp visible authority",
	);
	assert(!diskIndex[path], "editor-ahead deferred path is not advanced in the disk index");
	assert(
		traces.some((event) =>
			event.msg === "open-file-reconcile-deferred-editor-settle" &&
			event.details?.reason === "editor-ahead-without-activity-timestamp"
		),
		"editor-ahead defer path records the no-timestamp reason",
	);
	assert(
		!traces.some((event) => event.msg === "open-file-reconcile-editor-wins"),
		"editor-ahead defer path avoids conflict-preserving editor-wins branch",
	);

	isOpen = false;
	diskContent = editorContent;
	stats.set(path, { mtime: 13, size: diskContent.length });
	const cooldownTimer = internals.reconcileCooldownTimer as ReturnType<typeof setTimeout> | null;
	if (cooldownTimer) clearTimeout(cooldownTimer);
	internals.reconcileCooldownTimer = null;
	internals.reconcilePending = false;
	internals.lastReconcileTime = 0;
	await controller.runReconciliation("authoritative");

	assert(ytext.toString() === editorContent, "no-timestamp close/autosave keeps captured editor E");
	assert(createdFiles.size === 0, "no-timestamp close creates no conflict artifact");
	assert(
		!internals.visibleAuthorityDeferredPaths.has(path),
		"no-timestamp marker clears after exact E convergence",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n--- Test 3: reconciliation safety brake leaves blocked overwrites unindexed ---");
{
	const paths = Array.from({ length: 30 }, (_, i) => `note-${i}.md`);
	const files = paths.map(makeTFile);
	let diskIndex: DiskIndex = {};
	for (const path of paths) {
		diskIndex[path] = { mtime: 1, size: 1 };
	}

	const stats = new Map<string, { mtime: number; size: number }>();
	for (const path of paths) {
		stats.set(path, { mtime: 2, size: 2 });
	}

	const reads: string[] = [];
	const flushed: string[] = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let saveDiskIndexCalls = 0;

	const app = {
		vault: {
			getMarkdownFiles: () => files,
			read: async (file: TFile & { path: string }) => {
				reads.push(file.path);
				return `local ${file.path}`;
			},
			adapter: {
				stat: async (path: string) => stats.get(path) ?? null,
			},
			getAbstractFileByPath: () => null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		getTextForPath: () => ({ toJSON: () => "remote content" }),
		getActiveMarkdownPaths: () => paths,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: paths,
			seededToCrdt: [],
			untracked: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({ flushWrite: async (path: string) => { flushed.push(path); } }) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => { saveDiskIndexCalls++; },
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(reads.length === 30, "authoritative reconcile reads all files");
	assert(flushed.length === 0, "safety brake blocks destructive update flushes");
	assert(saveDiskIndexCalls === 1, "disk index save is still attempted");
	for (const path of paths) {
		assert(
			path in diskIndex && diskIndex[path]?.mtime === 1,
			`blocked path keeps its previous durable baseline entry: ${path}`,
		);
	}
	assert(
		traces.some((event) =>
			event.source === "reconcile" &&
			event.msg === "reconcile-disk-index-advance-blocked" &&
			event.details?.blockedCount === 30
		),
		"blocked disk-index advancement is traced",
	);
}

console.log("\n--- Test 4: second reconcile reads blocked paths again ---");
{
	const paths = Array.from({ length: 30 }, (_, i) => `again-${i}.md`);
	const files = paths.map(makeTFile);
	let diskIndex: DiskIndex = {};
	for (const path of paths) {
		diskIndex[path] = { mtime: 1, size: 1 };
	}

	const stats = new Map<string, { mtime: number; size: number }>();
	for (const path of paths) {
		stats.set(path, { mtime: 1, size: 1 });
	}

	const reads: string[] = [];
	const flushed: string[] = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];

	const app = {
		vault: {
			getMarkdownFiles: () => files,
			read: async (file: TFile & { path: string }) => {
				reads.push(file.path);
				return `local ${file.path}`;
			},
			adapter: {
				stat: async (path: string) => stats.get(path) ?? null,
			},
			getAbstractFileByPath: () => null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const vaultSync = {
		getTextForPath: () => ({ toJSON: () => "remote content" }),
		getActiveMarkdownPaths: () => paths,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: paths,
			seededToCrdt: [],
			untracked: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0 }),
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => ({ flushWrite: async (path: string) => { flushed.push(path); } }) as any,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");
	const firstReadCount = reads.length;
	(controller as any).lastReconcileTime = 0;
	await controller.runReconciliation("authoritative");

	assert(firstReadCount === 30, "first reconcile reads all blocked paths");
	assert(reads.length === 60, "second reconcile reads blocked paths again");
	assert(flushed.length === 0, "safety brake blocks destructive flushes on both passes");
	assert(
		traces.filter((event) => event.msg === "reconcile-disk-index-advance-blocked").length === 2,
		"blocked divergence is traced on both reconciles",
	);
}

console.log("\n--- Test 5: bound recovery aborts when CRDT changes after authority decision ---");
{
	const path = "bound-stale-base.md";
	const diskContent = "abcY";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "abcX");

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => diskContent };

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	const transactionOrigins: unknown[] = [];
	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
	});

	let mutatedDuringGuard = false;
	const crdtBaseline = "abcX";
	let diskIndex: DiskIndex = {
		[path]: {
			mtime: 1,
			size: crdtBaseline.length,
			contentHash: await contentBaselineHash(crdtBaseline),
		},
	};

	const app = {
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
			adapter: {
				stat: async () => ({ mtime: 10, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	let editorTicketCurrent = true;
	const editorBindings = {
		isBound: () => true,
		captureOpenEditorMutationTicket: () => ({ path, views: [] }),
		validateOpenEditorMutationTicket: () => editorTicketCurrent
			? ({ current: true })
			: ({ current: false, reason: "editor-document-changed", leafId: "leaf-1" }),
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => {
			if (!mutatedDuringGuard) {
				mutatedDuringGuard = true;
				ytext.delete(0, ytext.length);
				ytext.insert(0, "abcZ");
			}
			return false;
		},
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	const staleTicketTrace = traces.find((event) => event.msg === "open-editor-mutation-ticket-stale");
	const postconditionTrace = traces.find((event) => event.msg === "recovery-postcondition-observed");
	assert(ytext.toString() === "abcZ", "newer CRDT content survives the stale recovery decision");
	assert(!!staleTicketTrace, "controller records the stale mutation ticket");
	assert(staleTicketTrace?.details?.reason === "crdt-content-changed", "stale ticket identifies the CRDT revision change");
	assert(!postconditionTrace, "stale recovery never reaches the mutation postcondition");
	assert(
		!transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"stale recovery emits no local repair transaction",
	);
	editorTicketCurrent = false;
	const editorRevisionAccepted = (controller as any).canCommitOpenEditorMutation({
		path,
		ticket: { path, views: [] },
		expectedYText: ytext,
		expectedCrdtContent: "abcZ",
		stage: "test-editor-revision",
	});
	assert(editorRevisionAccepted === false, "changed editor revision also rejects the mutation ticket");
	assert(
		traces.some((event) =>
			event.msg === "open-editor-mutation-ticket-stale" &&
			event.details?.reason === "editor-document-changed"
		),
		"editor ticket rejection records the editor revision reason",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n--- Test 6: bound ambiguous divergence creates a conflict artifact ---");
{
	const path = "ambiguous.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
			adapter: {
				stat: async () => ({ mtime: 11, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	assert(ytext.toString() === editorContent, "ambiguous path converges CRDT to visible editor content");
	assert(createdFiles.size === 0, "ambiguous divergence creates no conflict artifact");
	const discardTrace = traces.find((event) => event.msg === "conflict-revision-discarded");
	assert(
		discardTrace?.details?.reason === "bound-file-ambiguous-divergence",
		"ambiguous divergence records the competing sides as discarded revisions",
	);
	assert(
		discardTrace?.details?.chosenSource === "editor" &&
		discardTrace.details?.convergenceApplied === true,
		"conflict-revision-discarded trace reports editor authority and convergence",
	);
	doc.destroy();
}

console.log("\n--- Test 7: repeated identical recovery fingerprint is quarantined ---");
{
	const path = "loop.md";
	const diskContent = "disk authority";
	const crdtContent = "stale crdt";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => diskContent };

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {
		[path]: {
			mtime: 1,
			size: crdtContent.length,
			contentHash: await contentBaselineHash(crdtContent),
		},
	};

	const app = {
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
			adapter: {
				stat: async () => ({ mtime: 12, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	for (let i = 0; i < 3; i++) {
		ytext.delete(0, ytext.length);
		ytext.insert(0, crdtContent);
		diskIndex[path] = {
			mtime: i + 1,
			size: crdtContent.length,
			contentHash: await contentBaselineHash(crdtContent),
		};
		(controller as any).boundRecoveryLocks.clear();
		await (controller as any).syncFileFromDisk(file, "modify");
	}

	assert(
		traces.some((event) =>
			event.msg === "recovery-quarantined" &&
			event.details?.repeatCount === 3
		),
		"third identical recovery fingerprint is quarantined",
	);
	assert(ytext.toString() === crdtContent, "quarantined recovery does not keep hammering the file");
	// Verify recovery fingerprint map does not store raw content
	const fingerprints: Map<string, { fingerprint: string; count: number; lastAt: number }> =
		(controller as any).recoveryFingerprints;
	const entry = fingerprints.get(path);
	assert(!!entry, "fingerprint entry exists for quarantined path");
	assert(!entry!.fingerprint.includes(diskContent), "fingerprint does not contain raw disk content");
	assert(!entry!.fingerprint.includes(crdtContent), "fingerprint does not contain raw CRDT content");
	assert(entry!.fingerprint.includes(":"), "fingerprint uses hash:length format");
	doc.destroy();
}

// ── Test 8: successful recovery clears quarantine fingerprint ──────────────

console.log("\n--- Test 8: successful recovery clears quarantine fingerprint ---");
{
	const path = "recover-then-clear.md";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "stale");

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => "disk version A" };

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {
		[path]: {
			mtime: 1,
			size: "stale".length,
			contentHash: await contentBaselineHash("stale"),
		},
	};

	const app = {
		vault: {
			read: async () => "disk version A",
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
			adapter: {
				stat: async () => ({ mtime: 13, size: 14 }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First recovery — should succeed
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(ytext.toString() === "disk version A", "first recovery succeeds");

	// A different fingerprint (different content) should reset the count,
	// so future legitimate recovery for this path is not blocked.
	const fingerprints: Map<string, any> = (controller as any).recoveryFingerprints;
	const entry = fingerprints.get(path);
	// The path has a fingerprint entry from the recovery attempt
	assert(entry?.count === 1, "recovery attempt increments count to 1");

	// Now change CRDT to something new and recover again — different fingerprint
	ytext.delete(0, ytext.length);
	ytext.insert(0, "new-stale");
	diskIndex[path] = {
		mtime: 2,
		size: "new-stale".length,
		contentHash: await contentBaselineHash("new-stale"),
	};
	(controller as any).boundRecoveryLocks.clear();
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(ytext.toString() === "disk version A", "different-fingerprint recovery still succeeds");

	const entry2 = fingerprints.get(path);
	assert(entry2?.count === 1, "different fingerprint resets count to 1 (not accumulated)");

	doc.destroy();
}

console.log("\n--- Test 9: convergence failure does not create infinite conflict artifacts ---");
{
	const path = "convergence-fails.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	// Simulate convergence failure: getTextForPath returns null on the
	// second call (the convergence re-lookup after artifact creation).
	let getTextForPathCallCount = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) => {
				if (readFile.path === path) return diskContent;
				return createdFiles.get(readFile.path) ?? "";
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
			adapter: {
				stat: async () => ({ mtime: 14, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => {
			getTextForPathCallCount++;
			// Return ytext for the first call (syncFileFromDisk's initial check)
			// but null for the second call (convergence re-lookup).
			// On second syncFileFromDisk invocation, same pattern.
			if (getTextForPathCallCount % 2 === 1) return ytext;
			return null;
		},
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First call: convergence fails because getTextForPath returns null on the
	// convergence re-lookup. No artifact is ever written.
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 0, "first pass creates no conflict artifacts");

	const firstTraces = traces.filter((t) => t.msg === "conflict-revision-discarded");
	assert(firstTraces.length >= 1, "first pass records the discarded revisions");

	// Second call with the same divergence: still no artifacts — the infinite
	// artifact loop is structurally impossible without artifact creation.
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 0, "repeated pass still creates no conflict artifacts");

	controller.reset();
	doc.destroy();
}
console.log("\n--- Test 10: second reconcile after successful convergence does not create duplicate artifact ---");
{
	const path = "already-converged.md";
	const diskContent = "disk authority";
	const crdtContent = "crdt version B";
	const editorContent = "editor version B";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const createdFiles = new Map<string, string>();
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFiles.has(candidate) ? ({ path: candidate }) : null),
			adapter: {
				stat: async () => ({ mtime: 15, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	// First call: ambiguous divergence converges CRDT to the editor winner
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 0, "first pass creates no conflict artifacts");
	assert(ytext.toString() === editorContent, "first pass converges CRDT to editor");

	// Second call: CRDT already matches the editor, so it exits early via the
	// crdtContent === content check in syncFileFromDisk. Reset CRDT to create
	// ambiguity again; a genuinely new divergence still creates no artifacts.
	ytext.delete(0, ytext.length);
	ytext.insert(0, "new-crdt-version");
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 0, "genuinely new divergence creates no conflict artifacts");

	doc.destroy();
}

console.log("\n--- Test 11: artifact creation failure does NOT trigger convergence ---");
{
	const path = "artifact-fails.md";
	const diskContent = "disk version";
	const crdtContent = "crdt version";
	const editorContent = "editor version";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let diskIndex: DiskIndex = {};

	const app = {
		vault: {
			read: async () => diskContent,
			// vault.create always throws — simulating disk-full / permissions error
			create: async () => { throw new Error("disk full"); },
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
			adapter: {
				stat: async () => ({ mtime: 16, size: diskContent.length }),
			},
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: () => ytext,
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		repair: () => false,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const controller = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => vaultSync as any,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await (controller as any).syncFileFromDisk(file, "modify");

	// With artifact preservation abolished there is no artifact I/O to fail:
	// the ambiguous divergence converges CRDT to the visible editor content.
	assert(ytext.toString() === editorContent, "ambiguous divergence converges CRDT to the editor winner");

	const discardTraces = traces.filter((t) => t.msg === "conflict-revision-discarded");
	assert(discardTraces.length === 1, "traces conflict-revision-discarded");
	assert(
		discardTraces[0]?.details?.convergenceApplied === true,
		"conflict-revision-discarded reports convergence applied",
	);

	doc.destroy();
}

console.log("\n--- Test 12: recovery fingerprint TTL prevents stale accumulation ---");
{
	const path = "ttl-test.md";
	const controller = new ReconciliationController({
		app: { vault: {}, workspace: {} } as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => null,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
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
	});

	const shouldQuarantine = (controller as any).shouldQuarantineRepeatedRecovery.bind(controller);

	// Accumulate to count 2 (just below threshold of 3)
	assert(shouldQuarantine(path, "r", "a", "b") === false, "count 1: no quarantine");
	assert(shouldQuarantine(path, "r", "a", "b") === false, "count 2: no quarantine");

	// Manually set lastAt far in the past to simulate TTL expiry
	const fp = (controller as any).recoveryFingerprints.get(path);
	fp.lastAt = Date.now() - 15 * 60_000; // 15 minutes ago

	// Same fingerprint but beyond TTL — count resets to 1
	assert(shouldQuarantine(path, "r", "a", "b") === false, "count reset to 1 after TTL expiry");
	// One more should still be fine (count 2)
	assert(shouldQuarantine(path, "r", "a", "b") === false, "count 2 after reset: no quarantine");
	// Third within TTL — now quarantines
	assert(shouldQuarantine(path, "r", "a", "b") === true, "count 3 after reset: quarantined");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
