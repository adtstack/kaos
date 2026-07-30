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

let editorAuthorityLeaseCounter = 0;

function stableEditorAuthority(
	path: string,
	readContent: () => string,
	isOpen: () => boolean = () => true,
) {
	const lease = Object.freeze({
		leaseId: `reconciliation-safety:${++editorAuthorityLeaseCounter}`,
	});
	return {
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		capturePathEditorAuthority: (candidate: string) => candidate === path && isOpen()
			? { kind: "proven-single" as const, content: readContent(), lease }
			: { kind: "none" as const },
		isPathEditorAuthorityLeaseCurrent: (candidate: unknown) =>
			candidate === lease && isOpen(),
	};
}

console.log("\n--- Test 1: updateIndex removes blocked paths from the index ---");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1 },
		"clean.md": { mtime: 1, size: 1 },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 2, size: 2 }],
		["clean.md", { mtime: 2, size: 2 }],
		["new.md", { mtime: 2, size: 2 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md"] });
	assert(!("blocked.md" in next), "blocked path is unindexed, not preserved");
	assert(next["clean.md"].mtime === 2, "unblocked path advances mtime");
	assert(next["new.md"].mtime === 2, "new unblocked path is indexed");
}

console.log("\n--- Test 2: same-stat excluded paths are still unindexed ---");
{
	const index: DiskIndex = {
		"blocked.md": { mtime: 1, size: 1 },
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		["blocked.md", { mtime: 1, size: 1 }],
	]);

	const next = updateIndex(index, stats, { excludePaths: ["blocked.md"] });
	assert(!("blocked.md" in next), "same-stat blocked path is removed from index");
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

console.log("\n--- Test 2b-a: closed equal authorities retire only provisional visible-authority attention ---");
{
	async function runClosedEqualWithAttention(
		reason: "conflict-winner-flush-deferred" | "three-way-preserve-failed",
	) {
		const path = `closed-equal-${reason}.md`;
		const content = "settled editor content\n";
		const file = makeTFile(path);
		let diskIndex: DiskIndex = {};
		let activeReason: typeof reason | null = reason;
		let clearCalls = 0;
		const stats = new Map<string, { mtime: number; size: number }>([
			[path, { mtime: 7, size: content.length }],
		]);

		const controller = new ReconciliationController({
			app: {
				vault: {
					getMarkdownFiles: () => [file],
					read: async () => content,
					adapter: {
						stat: async (candidate: string) => stats.get(candidate) ?? null,
					},
					getAbstractFileByPath: () => file,
				},
				workspace: { iterateAllLeaves: () => {} },
			} as any,
			getSettings: () => ({ deviceName: "device" }) as any,
			getRuntimeConfig: () => ({
				maxFileSizeBytes: 0,
				maxFileSizeKB: 0,
				excludePatterns: [],
			}) as any,
			getVaultSync: () => ({
				connected: true,
				providerSynced: true,
				getTextForPath: (candidate: string) =>
					candidate === path ? { toJSON: () => content } : null,
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
			}) as any,
			getDiskMirror: () => ({
				isPreservedUnresolved: (candidate: string) =>
					candidate === path && activeReason !== null,
				getPreservedUnresolvedEntries: () => activeReason === null ? [] : [{
					path,
					kind: "markdown",
					reason: activeReason,
					episodeId: `episode-${reason}`,
					firstSeenAt: 1,
					lastSeenAt: 1,
					localHash: null,
					knownRemoteHash: null,
				}],
				clearPreservedUnresolved: (candidate: string) => {
					if (candidate !== path) return;
					clearCalls++;
					activeReason = null;
				},
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
			saveDiskIndex: async () => {},
			refreshStatusBar: () => {},
			trace: () => {},
			scheduleTraceStateSnapshot: () => {},
			log: () => {},
		});
		const internals = controller as unknown as {
			visibleAuthorityDeferredPaths: Map<string, unknown>;
		};
		internals.visibleAuthorityDeferredPaths.set(path, {
			editorContents: [content],
			readComplete: true,
			capturedDiskContent: content,
			capturedCrdtContent: content,
			capturedDiskRevision: 0,
			capturedEditorActivity: null,
			capturedEditorTicket: null,
			capturedAt: 1,
		});

		await controller.runReconciliation("authoritative");
		const result = {
			activeReason,
			clearCalls,
			markerPresent: internals.visibleAuthorityDeferredPaths.has(path),
			baselineHash: diskIndex[path]?.contentHash,
		};
		controller.reset();
		return result;
	}

	const provisional = await runClosedEqualWithAttention("conflict-winner-flush-deferred");
	assert(provisional.clearCalls === 1, "settled authorities clear the exact provisional warning");
	assert(provisional.activeReason === null, "provisional attention is no longer self-blocking");
	assert(!provisional.markerPresent, "settled visible-authority capture is retired");
	assert(
		typeof provisional.baselineHash === "string" && provisional.baselineHash.length === 64,
		"settled path advances its durable baseline",
	);

	const stronger = await runClosedEqualWithAttention("three-way-preserve-failed");
	assert(stronger.clearCalls === 0, "stronger preservation attention is never auto-cleared");
	assert(stronger.activeReason === "three-way-preserve-failed", "stronger attention remains visible");
	assert(stronger.markerPresent, "stronger unresolved episode retains its captured authority");
	assert(stronger.baselineHash === undefined, "stronger unresolved episode cannot advance baseline");
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
	const createdFileObjects = new Map<string, TFile>();
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
				const createdFile = makeTFile(createdPath);
				createdFileObjects.set(createdPath, createdFile);
				return createdFile;
			},
			adapter: {
				stat: async (candidate: string) => stats.get(candidate) ?? null,
			},
			getAbstractFileByPath: (candidate: string) =>
				candidate === path
					? file
					: (createdFileObjects.get(candidate) ?? null),
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
	assert(createdFiles.size === 1, "first pass preserves the losing CRDT side");
	assert(Array.from(createdFiles.values())[0] === crdtContent, "conflict artifact contains the losing CRDT content");
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
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	let providerAdvancedDuringArtifactWrite = false;

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
				if (!providerAdvancedDuringArtifactWrite && content === capturedCrdtContent) {
					providerAdvancedDuringArtifactWrite = true;
					doc.transact(() => {
						ytext.delete(0, ytext.length);
						ytext.insert(0, newestCrdtContent);
					}, providerOrigin);
				}
				return makeTFile(createdPath);
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

	assert(providerAdvancedDuringArtifactWrite, "provider update lands inside the async decision window");
	assert(ytext.toString() === newestCrdtContent, "newest provider content survives the stale disk decision");
	assert(
		Array.from(createdFiles.values()).includes(capturedCrdtContent),
		"captured CRDT side is preserved before the race",
	);
	assert(
		Array.from(createdFiles.values()).includes(diskContent),
		"disk snapshot is preserved after the stale decision is rejected",
	);
	assert(!(path in diskIndex), "stale decision path is excluded from the settled disk index");
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
				return makeTFile(createdPath);
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

	const artifactContent = Array.from(createdFiles.values())[0];
	assert(ytext.toString() === diskContent, "pending create imports disk content to CRDT");
	assert(flushed.length === 0, "pending create does not flush stale CRDT to disk");
	assert(artifactContent === crdtContent, "stale CRDT side is preserved as a conflict artifact");
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

console.log("\n--- Test 2d: startup open editor adoption is held before reconciliation ---");
{
	const path = "open-reenable.md";
	const diskContent = "LOCAL_ON_EDITOR\n";
	const editorContent = "LOCAL_ON_EDITOR\n";
	const crdtContent = "REMOTE_FROM_CRDT\n";
	const baselineContent = "SETTLED_BASE\n";
	const baselineHash = await contentBaselineHash(baselineContent);
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const transactionOrigins: unknown[] = [];
	doc.on("afterTransaction", (txn) => transactionOrigins.push(txn.origin));

	let diskIndex: DiskIndex = {
		[path]: {
			mtime: 1,
			size: baselineContent.length,
			contentHash: baselineHash,
		},
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 12, size: diskContent.length }],
	]);
	const createdFiles = new Map<string, string>();
	const flushed: string[] = [];
	const decisions: Array<Record<string, unknown>> = [];
	const traces: Array<{ source: string; msg: string; details?: Record<string, unknown> }> = [];
	let adoptionHeld = false;
	let reconcileObservedPreflight = false;

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };
	const editorAuthority = stableEditorAuthority(path, () => editorContent);

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
				return makeTFile(createdPath);
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
		reconcileVault: () => {
			reconcileObservedPreflight = adoptionHeld;
			return {
				mode: "authoritative",
				createdOnDisk: [],
				updatedOnDisk: [path],
				seededToCrdt: [],
				untracked: [],
				tombstonedDiskConflicts: [],
				skipped: 0,
			};
		},
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
			isSamePathAdoptionProjectionHeld: (candidate: string) =>
				adoptionHeld && candidate === path,
			getLastEditorActivityForPath: () => null,
			repair: () => true,
			rebind: () => {},
			...editorAuthority,
		}) as any,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {
			adoptionHeld = true;
		},
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

	assert(reconcileObservedPreflight, "open editor adoption hold is established before CRDT classification");
	assert(ytext.toString() === crdtContent, "preflight hold leaves remote CRDT authority untouched");
	assert(createdFiles.size === 0, "preflight hold leaves conflict preservation to same-path adoption");
	assert(flushed.length === 0, "preflight hold does not project remote CRDT over the local editor disk");
	assert(transactionOrigins.length === 0, "preflight hold performs no premature CRDT repair transaction");
	assert(
		diskIndex[path]?.mtime === 1
			&& diskIndex[path]?.size === baselineContent.length
			&& diskIndex[path]?.contentHash === baselineHash,
		"preflight hold preserves the exact settled baseline without advancing its stat",
	);
	assert(
		!decisions.some((decision) => decision.decision === "open-editor-wins"),
		"preflight hold never promotes unadopted editor bytes as the winner",
	);
	assert(
		!traces.some((event) => event.msg === "open-file-reconcile-editor-wins"),
		"preflight hold bypasses the legacy editor-wins fallback",
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
	const editorAuthority = stableEditorAuthority(path, () => editorContent);

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
				return makeTFile(createdPath);
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
			repair: () => true,
			rebind: () => {},
			...editorAuthority,
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
	const editorAuthority = stableEditorAuthority(path, () => editorContent, () => isOpen);

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
				return makeTFile(createdPath);
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
			repair: () => true,
			rebind: () => {},
			...editorAuthority,
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

	const crdtArtifact = Array.from(createdFiles.entries()).find(([candidate]) =>
		candidate.includes("KAOS conflict - crdt")
	);
	assert(ytext.toString() === editorContent, "close/autosave converges CRDT to captured editor E");
	assert(diskContent === editorContent, "close/autosave leaves captured editor E on the original disk path");
	assert(crdtArtifact?.[1] === crdtContent, "competing CRDT C is preserved as an artifact");
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
	const editorAuthority = stableEditorAuthority(path, () => editorContent, () => isOpen);

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
				return makeTFile(createdPath);
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
			repair: () => true,
			rebind: () => {},
			...editorAuthority,
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

	const crdtArtifact = Array.from(createdFiles.entries()).find(([candidate]) =>
		candidate.includes("KAOS conflict - crdt")
	);
	assert(ytext.toString() === editorContent, "no-timestamp close/autosave keeps captured editor E");
	assert(crdtArtifact?.[1] === crdtContent, "no-timestamp close preserves competing CRDT C");
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
		assert(!(path in diskIndex), `blocked path is unindexed: ${path}`);
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
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) =>
				readFile.path === path
					? diskContent
					: (createdFiles.get(readFile.path) ?? ""),
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
		...stableEditorAuthority(path, () => diskContent),
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
				return makeTFile(createdPath);
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
		...stableEditorAuthority(path, () => editorContent),
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

	const createdPath = Array.from(createdFiles.keys()).find((candidate) =>
		candidate.startsWith("ambiguous (KAOS conflict - crdt from Test Device ") &&
		candidate.endsWith(".md")
	);
	const diskCreatedPath = Array.from(createdFiles.keys()).find((candidate) =>
		candidate.startsWith("ambiguous (KAOS conflict - disk from Test Device ") &&
		candidate.endsWith(".md")
	);
	const neededTrace = traces.find((event) => event.msg === "conflict-artifact-needed");
	assert(ytext.toString() === editorContent, "ambiguous path converges CRDT to visible editor content after artifact creation");
	assert(!!createdPath, "ambiguous divergence creates a CRDT conflict note");
	assert(createdPath ? createdFiles.get(createdPath) === crdtContent : false, "conflict note preserves competing CRDT content");
	assert(!!diskCreatedPath, "true three-way divergence creates a disk conflict note");
	assert(diskCreatedPath ? createdFiles.get(diskCreatedPath) === diskContent : false, "disk conflict note preserves disk content");
	assert(neededTrace?.details?.conflictArtifactCreated === true, "conflict-needed trace reports artifact creation");
	assert(neededTrace?.details?.convergenceApplied === true, "conflict-needed trace reports convergence applied");
	assert(
		traces.some((event) => event.msg === "conflict-artifact-created"),
		"conflict artifact creation is traced",
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
		...stableEditorAuthority(path, () => diskContent),
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
		...stableEditorAuthority(path, () => "disk version A"),
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
				return makeTFile(createdPath);
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
		...stableEditorAuthority(path, () => editorContent),
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

	// First call: creates artifact, convergence fails because getTextForPath returns null
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 2, "first pass creates CRDT and disk conflict artifacts");

	const firstTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	assert(firstTraces.length === 1, "first pass traces conflict-artifact-needed");
	assert(firstTraces[0]?.details?.conflictArtifactCreated === true, "first pass artifact was created");
	// convergenceApplied is false because getTextForPath returned null for the convergence call
	assert(firstTraces[0]?.details?.convergenceApplied === false, "first pass convergence was not applied");

	// Second call with same divergence: dedupe prevents second artifact
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 2, "second pass does NOT create more conflict artifacts (dedupe)");

	const secondTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	assert(secondTraces.length === 2, "second pass still traces conflict-artifact-needed");
	assert(secondTraces[1]?.details?.conflictSkippedDedupe === true, "second pass reports dedupe skip");

	let restartGetTextForPathCallCount = 0;
	const restartVaultSync = {
		getTextForPath: () => {
			restartGetTextForPathCallCount++;
			if (restartGetTextForPathCallCount % 2 === 1) return ytext;
			return null;
		},
	};
	const restartedController = new ReconciliationController({
		app: app as any,
		getSettings: () => ({ deviceName: "Test Device" }) as any,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as any,
		getVaultSync: () => restartVaultSync as any,
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

	await (restartedController as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 2, "restart pass reuses existing conflict artifacts");

	const restartTrace = traces.filter((t) => t.msg === "conflict-artifact-needed").at(-1);
	assert(restartTrace?.details?.conflictSkippedDedupe === true, "restart pass reports durable artifact dedupe");
	assert(restartTrace?.details?.conflictDedupeScope === "artifact", "restart dedupe scope is artifact");
	assert(restartTrace?.details?.conflictArtifactCreated === false, "restart pass does not report a fresh artifact");

	// The deliberately stale convergence requeues a deferred dirty entry on both
	// controllers. Dispose their markdown-drain timers so this isolated suite
	// proves the retry behavior without retaining a live Node handle.
	controller.reset();
	restartedController.reset();
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
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
			read: async (readFile: TFile & { path: string }) =>
				readFile.path === path
					? diskContent
					: (createdFiles.get(readFile.path) ?? ""),
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				createdFiles.set(createdPath, content);
				return makeTFile(createdPath);
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
		...stableEditorAuthority(path, () => editorContent),
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

	// First call: artifact created, convergence succeeds
	await (controller as any).syncFileFromDisk(file, "modify");
	assert(createdFiles.size === 2, "first pass creates CRDT and disk conflict artifacts");
	assert(ytext.toString() === editorContent, "first pass converges CRDT to editor");

	// Second call: CRDT already matches disk, so it exits early via the
	// crdtContent === content check in syncFileFromDisk. No second artifact.
	// Reset CRDT to create ambiguity again and verify dedupe is cleared after convergence
	ytext.delete(0, ytext.length);
	ytext.insert(0, "new-crdt-version");
	await (controller as any).syncFileFromDisk(file, "modify");

	// This is a genuinely new CRDT divergence, while the disk candidate is
	// byte-identical to the already-preserved disk artifact. Create only the
	// new CRDT artifact and reuse the durable disk artifact.
	assert(
		createdFiles.size === 3,
		"new CRDT divergence creates one artifact and reuses the unchanged disk artifact",
	);
	assert(
		Array.from(createdFiles.values()).filter((content) => content === "new-crdt-version").length === 1,
		"new CRDT bytes are preserved exactly once",
	);

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
		...stableEditorAuthority(path, () => editorContent),
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

	// CRDT must be UNTOUCHED — still contains original content
	assert(ytext.toString() === crdtContent, "CRDT is untouched after artifact creation failure");

	const conflictTraces = traces.filter((t) => t.msg === "conflict-artifact-needed");
	assert(conflictTraces.length === 1, "traces conflict-artifact-needed");
	assert(conflictTraces[0]?.details?.conflictArtifactCreated === false, "conflictArtifactCreated is false");
	assert(conflictTraces[0]?.details?.convergenceApplied === false, "convergenceApplied is false");
	assert(conflictTraces[0]?.details?.error === "disk full", "error message is captured");

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
