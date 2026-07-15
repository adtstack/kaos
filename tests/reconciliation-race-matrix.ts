/**
 * Deterministic regression coverage for async reconciliation authority races.
 *
 * These cases intentionally move live state at the last possible await/fence:
 *   1. a startup disk-only snapshot becomes stale before ensureFile admission;
 *   2. a closed-file conflict opens/binds while its artifact is being written;
 *   3. a newer verified baseline callback lands while an older full reconcile
 *      is still preparing its final disk-index commit (including same-stat ABA).
 */

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

function baseDeps(input: {
	app: unknown;
	vaultSync: unknown;
	diskMirror: unknown;
	getDiskIndex: () => DiskIndex;
	setDiskIndex: (next: DiskIndex) => void;
}): ConstructorParameters<typeof ReconciliationController>[0] {
	return {
		app: input.app as never,
		getSettings: () => ({ deviceName: "Race Matrix" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "closed-only",
		}) as never,
		getVaultSync: () => input.vaultSync as never,
		getDiskMirror: () => input.diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: input.getDiskIndex,
		setDiskIndex: input.setDiskIndex,
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
	};
}

console.log("\n--- Race 1: stale startup disk-only snapshots never reach ensureFile ---");

for (const transition of ["save", "rename"] as const) {
	const oldPath = `startup-${transition}.md`;
	const newPath = `moved/startup-${transition}.md`;
	const scannedContent = "DISK_D\n";
	let diskContent = scannedContent;
	let currentPath = oldPath;
	const file = makeTFile(oldPath);
	let diskIndex: DiskIndex = {};
	let seedAdmissionCount = 0;
	let ensureFileCount = 0;
	let controller!: ReconciliationController;

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (candidate: TFile) => {
				if (candidate !== file) throw new Error("unexpected read");
				return diskContent;
			},
			adapter: {
				stat: async (path: string) => path === currentPath
					? { mtime: 1, size: diskContent.length }
					: null,
			},
			getAbstractFileByPath: (path: string) => path === currentPath ? file : null,
		},
		workspace: { iterateAllLeaves: () => {} },
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [],
		getTextForPath: () => null,
		isMarkdownTombstoned: () => false,
		reconcileVault: (
			diskFiles: Map<string, string>,
			_diskPresentPaths: Set<string>,
			_mode: string,
			_device: string,
			mintAdmission: ((path: string) => { opId: string; emitDecision: () => void }) | undefined,
			_isPathSyncable: (path: string) => boolean,
			canSeedSnapshot: (path: string, content: string) => boolean,
		) => {
			const captured = diskFiles.get(oldPath);
			assert(captured === scannedContent, `${transition}: reconcile holds the scanned D snapshot before admission`);

			// This is the last synchronous point before VaultSync would call
			// ensureFile. It models the vault event that invalidated the snapshot
			// while the full reconcile was in flight.
			if (transition === "save") {
				diskContent = "DISK_AFTER_SAVE\n";
				controller.noteMarkdownDiskMutation(oldPath);
			} else {
				currentPath = newPath;
				file.path = newPath;
				controller.noteMarkdownDiskMutation(oldPath);
				controller.noteMarkdownDiskMutation(newPath);
			}

			const admitted = captured !== undefined && canSeedSnapshot(oldPath, captured);
			if (admitted) {
				seedAdmissionCount++;
				const minted = mintAdmission?.(oldPath);
				minted?.emitDecision();
				ensureFileCount++;
			}
			return {
				mode: "authoritative",
				createdOnDisk: [],
				updatedOnDisk: [],
				seededToCrdt: admitted ? [oldPath] : [],
				untracked: admitted ? [] : [oldPath],
				tombstonedDiskConflicts: [],
				pathBindingConflicts: [],
				skipped: 0,
			};
		},
		runIntegrityChecks: () => ({
			duplicateIds: 0,
			orphansCleaned: 0,
			duplicateActivePaths: 0,
		}),
	};

	controller = new ReconciliationController(baseDeps({
		app,
		vaultSync,
		diskMirror: {
			flushWrite: async () => { throw new Error("stale disk-only snapshot must not flush"); },
		},
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
	}));

	await controller.runReconciliation("authoritative");
	assert(seedAdmissionCount === 0, `${transition}: stale snapshot is rejected at final seed admission`);
	assert(ensureFileCount === 0, `${transition}: ensureFile is never reached with stale D`);
	assert(controller.pending, `${transition}: a fresh authoritative follow-up is requested`);
	controller.reset();
}

console.log("\n--- Race 2: opening/binding during artifact I/O aborts closed mutation ---");
{
	const path = "closed-opens-during-artifact.md";
	const baselineContent = "BASELINE\n";
	const diskContent = "LOCAL_DISK\n";
	const crdtContent = "REMOTE_CRDT\n";
	const baselineHash = await contentBaselineHash(baselineContent);
	const file = makeTFile(path);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const artifacts = new Map<string, string>();
	let isOpen = false;
	let isBound = false;
	let flushCount = 0;
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: baselineContent.length, contentHash: baselineHash },
	};

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => crdtContent };

	const app = {
		vault: {
			getMarkdownFiles: () => [file, ...Array.from(artifacts.keys(), makeTFile)],
			read: async (candidate: TFile) => candidate.path === path
				? diskContent
				: (artifacts.get(candidate.path) ?? ""),
			create: async (artifactPath: string, content: string) => {
				artifacts.set(artifactPath, content);
				// The note transitions from closed to live while conflict preservation
				// is yielding. The following compare-and-commit must see this.
				isOpen = true;
				isBound = true;
				return makeTFile(artifactPath);
			},
			adapter: { stat: async () => ({ mtime: 2, size: diskContent.length }) },
			getAbstractFileByPath: (candidate: string) => candidate === path
				? file
				: (artifacts.has(candidate) ? makeTFile(candidate) : null),
		},
		workspace: {
			iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) visit({ view });
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [path],
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		isMarkdownTombstoned: () => false,
		getFileIdForText: () => "file-id",
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
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

	const controller = new ReconciliationController({
		...baseDeps({
			app,
			vaultSync,
			diskMirror: {
				suppressLocalCreate: async () => {},
				flushWrite: async () => {
					flushCount++;
					throw new Error("stale closed decision must not flush");
				},
				recordPreservedUnresolved: () => {},
				clearPreservedUnresolved: () => {},
			},
			getDiskIndex: () => diskIndex,
			setDiskIndex: (next) => { diskIndex = next; },
		}),
		getEditorBindings: () => ({ isBound: () => isBound }) as never,
	});

	await controller.runReconciliation("authoritative");
	assert(isOpen && isBound, "fixture transitions the path to live authority during artifact creation");
	assert(ytext.toString() === crdtContent, "stale closed disk winner cannot replace live CRDT/editor content");
	assert(flushCount === 0, "stale closed decision performs no CRDT-to-disk mutation either");
	assert(
		Array.from(artifacts.values()).includes(crdtContent),
		"the competing CRDT version is preserved before the decision is abandoned",
	);
	assert(controller.pending, "the stale closed decision requests a fresh open-aware follow-up");
	controller.reset();
	doc.destroy();
}

console.log("\n--- Race 3: newer C2 baseline callback wins older C1 final commit ---");
{
	const pathA = "baseline-aba-a.md";
	const pathB = "baseline-aba-b.md";
	const baseA = "base-A\n";
	const baseB = "base-B\n";
	const c1A = "old--A\n";
	const c1B = "old--B\n";
	const c2A = "new--A\n"; // same length/stat shape as C1: content ABA case
	const [baseAHash, baseBHash, c1AHash, c1BHash, c2AHash] = await Promise.all([
		contentBaselineHash(baseA),
		contentBaselineHash(baseB),
		contentBaselineHash(c1A),
		contentBaselineHash(c1B),
		contentBaselineHash(c2A),
	]);
	const fileA = makeTFile(pathA);
	const fileB = makeTFile(pathB);
	const docA = new Y.Doc();
	const docB = new Y.Doc();
	const textA = docA.getText("content");
	const textB = docB.getText("content");
	textA.insert(0, c1A);
	textB.insert(0, c1B);
	let diskIndex: DiskIndex = {
		[pathA]: { mtime: 1, size: baseA.length, contentHash: baseAHash },
		[pathB]: { mtime: 1, size: baseB.length, contentHash: baseBHash },
	};
	let controller!: ReconciliationController;
	const flushOrder: string[] = [];

	const app = {
		vault: {
			getMarkdownFiles: () => [fileA, fileB],
			read: async (file: TFile) => file.path === pathA ? baseA : baseB,
			adapter: {
				stat: async (path: string) => path === pathA
					? { mtime: 2, size: c1A.length }
					: { mtime: 2, size: c1B.length },
			},
			getAbstractFileByPath: (path: string) => path === pathA
				? fileA
				: (path === pathB ? fileB : null),
		},
		workspace: { iterateAllLeaves: () => {} },
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [pathA, pathB],
		getTextForPath: (path: string) => path === pathA ? textA : (path === pathB ? textB : null),
		isMarkdownTombstoned: () => false,
		getFileIdForText: (text: Y.Text) => text === textA ? "id-a" : "id-b",
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [pathA, pathB],
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
		clearPreservedUnresolved: () => {},
		flushWrite: async (path: string) => {
			flushOrder.push(path);
			if (path === pathA) {
				return {
					kind: "written" as const,
					path,
					isCreate: false,
					content: c1A,
					contentHash: c1AHash,
					baselineRecorded: true,
				};
			}

			// While the older full pass is awaiting its second write, a newer
			// verified settlement for A publishes C2 with the same apparent stat.
			controller.noteDiskBaselineSettlement(pathA);
			diskIndex = {
				...diskIndex,
				[pathA]: { mtime: 2, size: c2A.length, contentHash: c2AHash },
			};
			return {
				kind: "written" as const,
				path,
				isCreate: false,
				content: c1B,
				contentHash: c1BHash,
				baselineRecorded: true,
			};
		},
	};

	controller = new ReconciliationController(baseDeps({
		app,
		vaultSync,
		diskMirror,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
	}));

	await controller.runReconciliation("authoritative");
	assert(flushOrder.join(",") === `${pathA},${pathB}`, "C2 callback lands after the older C1 settlement");
	assert(diskIndex[pathA]?.contentHash === c2AHash, "final index preserves the newer verified C2 hash");
	assert(diskIndex[pathA]?.contentHash !== c1AHash, "older reconcile-local C1 cannot overwrite C2");
	assert(diskIndex[pathA]?.mtime === 2 && diskIndex[pathA]?.size === c2A.length, "same-stat ABA still uses revision ordering");
	assert(diskIndex[pathB]?.contentHash === c1BHash, "uncontended path still commits its reconcile-local C1 baseline");
	controller.reset();
	docA.destroy();
	docB.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
