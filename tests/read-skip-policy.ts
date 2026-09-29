import { TFile } from "obsidian";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import { shouldSkipDiskRead } from "../src/runtime/reconcile/readSkipPolicy";
import { ReconciliationController } from "../src/runtime/reconciliationController";

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

console.log("\n--- Test 1: pure skip predicate ---");
{
	assert(
		shouldSkipDiskRead({ statMatchesIndex: true, baselineHash: "h", crdtHash: "h" }),
		"all three proofs hold → skip",
	);
	assert(
		!shouldSkipDiskRead({ statMatchesIndex: false, baselineHash: "h", crdtHash: "h" }),
		"stat mismatch → read",
	);
	assert(
		!shouldSkipDiskRead({ statMatchesIndex: true, baselineHash: null, crdtHash: "h" }),
		"missing baseline → read",
	);
	assert(
		!shouldSkipDiskRead({ statMatchesIndex: true, baselineHash: "h", crdtHash: null }),
		"missing CRDT text → read",
	);
	assert(
		!shouldSkipDiskRead({ statMatchesIndex: true, baselineHash: "h", crdtHash: "other" }),
		"CRDT diverged from baseline → read",
	);
}

console.log("\n--- Test 2: authoritative reconcile skips proven-equal files ---");
{
	const skipPaths = ["settled-a.md", "settled-b.md"];
	const divergedPath = "diverged.md";
	const paths = [...skipPaths, divergedPath];
	const files = paths.map(makeTFile);

	const settledContent: Record<string, string> = {
		[skipPaths[0]]: "settled body a\n",
		[skipPaths[1]]: "settled body b\n",
		[divergedPath]: "settled body c\n",
	};
	const liveCrdtContent: Record<string, string> = {
		...settledContent,
		[divergedPath]: "remote edit after settlement\n",
	};
	const diskContent: Record<string, string> = { ...settledContent };

	let diskIndex: DiskIndex = {};
	const stats = new Map<string, { mtime: number; size: number }>();
	for (const path of paths) {
		const content = settledContent[path];
		diskIndex[path] = {
			mtime: 10,
			size: content.length,
			contentHash: await contentBaselineHash(content),
		};
		stats.set(path, { mtime: 10, size: content.length });
	}

	const reads: string[] = [];
	const flushed: string[] = [];
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];

	const app = {
		vault: {
			getMarkdownFiles: () => files,
			read: async (file: TFile & { path: string }) => {
				reads.push(file.path);
				return diskContent[file.path] ?? "";
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
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => ({ toJSON: () => liveCrdtContent[candidate] }),
		getActiveMarkdownPaths: () => paths,
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [divergedPath],
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
		getDiskMirror: () => ({
			hasPendingWrite: () => false,
			getLastDiskWriteOkHash: () => null,
			flushWrite: async (flushPath: string) => {
				flushed.push(flushPath);
				const content = liveCrdtContent[flushPath];
				return {
					kind: "written" as const,
					path: flushPath,
					isCreate: false,
					content,
					contentHash: await contentBaselineHash(content),
					baselineRecorded: true,
				};
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
		trace: (_source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(
		reads.length === 1 && reads[0] === divergedPath,
		"only the CRDT-diverged file is read; proven-equal files are skipped",
	);
	assert(
		flushed.length === 1 && flushed[0] === divergedPath,
		"the diverged file is still flushed to disk",
	);
	for (const path of skipPaths) {
		assert(
			diskIndex[path]?.contentHash === await contentBaselineHash(settledContent[path]),
			`skipped file keeps its settled baseline: ${path}`,
		);
	}
	assert(
		diskIndex[divergedPath]?.contentHash === await contentBaselineHash(liveCrdtContent[divergedPath]),
		"diverged file settles on the flushed CRDT baseline",
	);
	assert(
		traces.some((trace) =>
			trace.msg === "reconcile-scan-complete" && trace.details?.unchangedCount === 2
		),
		"scan trace reports the two skipped files as unchanged",
	);
}

console.log("\n--- Test 3: no baselines (first run) reads everything ---");
{
	const paths = ["first-a.md", "first-b.md"];
	const files = paths.map(makeTFile);
	let diskIndex: DiskIndex = {};
	for (const path of paths) {
		diskIndex[path] = { mtime: 3, size: 5 };
	}
	const stats = new Map<string, { mtime: number; size: number }>(
		paths.map((path) => [path, { mtime: 3, size: 5 }]),
	);
	const reads: string[] = [];

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
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => ({ toJSON: () => `remote ${candidate}` }),
		getActiveMarkdownPaths: () => paths,
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
		getDiskMirror: () => ({ hasPendingWrite: () => false, getLastDiskWriteOkHash: () => null }) as any,
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

	await controller.runReconciliation("authoritative");

	assert(reads.length === 2, "entries without baselines are still read in full");
}

console.log("\n--- Test 4: disk stat drift defeats the skip ---");
{
	const path = "externally-edited.md";
	const file = makeTFile(path);
	const settledContent = "settled body\n";
	const liveCrdt = "settled body\n";
	let diskIndex: DiskIndex = {
		[path]: {
			mtime: 10,
			size: settledContent.length,
			contentHash: await contentBaselineHash(settledContent),
		},
	};
	const stats = new Map<string, { mtime: number; size: number }>([
		[path, { mtime: 99, size: settledContent.length + 7 }],
	]);
	const reads: string[] = [];

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (readFile: TFile & { path: string }) => {
				reads.push(readFile.path);
				return "externally edited body\n";
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
		getTextForPath: () => ({ toJSON: () => liveCrdt }),
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
		getDiskMirror: () => ({ hasPendingWrite: () => false, getLastDiskWriteOkHash: () => null }) as any,
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

	await controller.runReconciliation("authoritative");

	assert(reads.length === 1, "mtime/size drift forces a read even when CRDT matches the baseline");
}

console.log("\n--- Results ---");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
