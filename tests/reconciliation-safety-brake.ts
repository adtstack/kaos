import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { contentBaselineHash, updateIndex, type DiskIndex } from "../src/sync/diskIndex";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
} from "../src/sync/origins";

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

console.log("\n--- Test 2c: conflict winner baseline waits for observed equality ---");
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
				createdFiles.has(candidate) ? ({ path: candidate }) : null,
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
	assert(diskIndex[path]?.contentHash === undefined, "conflict winner does not immediately advance baseline");

	(controller as any).lastReconcileTime = 0;
	await controller.runReconciliation("authoritative");

	const baselineHash = diskIndex[path]?.contentHash;
	assert(typeof baselineHash === "string" && baselineHash.length === 64, "second pass records baseline after disk/CRDT equality");
	assert(flushed.length === 0, "disk-wins conflict path does not require CRDT-to-disk flush");
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
				createdFiles.has(candidate) ? ({ path: candidate }) : null,
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
				createdFiles.has(candidate) ? ({ path: candidate }) : null,
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

	const artifactPath = Array.from(createdFiles.keys()).find((candidate) =>
		candidate.startsWith("open-reenable (KAOS conflict - crdt from Device ") &&
		candidate.endsWith(".md")
	);
	assert(ytext.toString() === editorContent, "open editor content is applied to CRDT before binding");
	assert(!!artifactPath, "remote CRDT content is preserved as a conflict artifact");
	assert(artifactPath ? createdFiles.get(artifactPath) === crdtContent : false, "conflict artifact contains remote CRDT content");
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

console.log("\n--- Test 2e: recent startup typing defers open editor conflict creation ---");
{
	const path = "open-typing-during-connect.md";
	const diskContent = "LOCAL_STILL_TYPING\n";
	const editorContent = "LOCAL_STILL_TYPING plus more\n";
	const crdtContent = "REMOTE_FROM_INITIAL_SYNC\n";
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
			flushWrite: async () => {},
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => false,
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

	const dirtyEntry = (controller as any).dirtyMarkdownPaths.get(path);
	const timer = (controller as any).markdownDrainTimer as ReturnType<typeof setTimeout> | null;
	if (timer) clearTimeout(timer);

	assert(createdFiles.size === 0, "recent typing does not create a conflict artifact");
	assert(ytext.toString() === crdtContent, "recent typing does not force a premature CRDT winner");
	assert(!!dirtyEntry, "recent typing queues a deferred disk ingest");
	assert(
		typeof dirtyEntry?.notBeforeMs === "number" && dirtyEntry.notBeforeMs > Date.now(),
		"deferred disk ingest waits for the editor idle window",
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
	doc.destroy();
}

console.log("\n--- Test 2f: startup editor ahead of disk and CRDT defers without activity timestamp ---");
{
	const path = "open-editor-ahead-without-timestamp.md";
	const diskContent = "LOCAL_AUTOSAVED\n";
	const editorContent = "LOCAL_AUTOSAVED plus unsaved editor text\n";
	const crdtContent = "REMOTE_FROM_INITIAL_SYNC\n";
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
			flushWrite: async () => {},
			suppressLocalCreate: async () => {},
		}) as any,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => false,
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

	const dirtyEntry = (controller as any).dirtyMarkdownPaths.get(path);
	const timer = (controller as any).markdownDrainTimer as ReturnType<typeof setTimeout> | null;
	if (timer) clearTimeout(timer);

	assert(createdFiles.size === 0, "editor-ahead startup does not create conflict artifacts");
	assert(ytext.toString() === crdtContent, "editor-ahead startup does not pick a premature winner");
	assert(!!dirtyEntry, "editor-ahead startup queues a deferred disk ingest");
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
			read: async () => diskContent,
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
			externalEditPolicy: "always",
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
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
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
			externalEditPolicy: "always",
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
			externalEditPolicy: "always",
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
			externalEditPolicy: "always",
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
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
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
			externalEditPolicy: "always",
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
			externalEditPolicy: "always",
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
			getAbstractFileByPath: (candidate: string) => createdFiles.has(candidate) ? ({ path: candidate }) : null,
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
			externalEditPolicy: "always",
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

	// This is a genuinely new divergence (different CRDT content), so a
	// new artifact should be created.
	assert(createdFiles.size === 4, "genuinely new divergence creates new CRDT and disk conflict artifacts");

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
			getAbstractFileByPath: () => null,
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
			externalEditPolicy: "always",
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
			externalEditPolicy: "always",
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
