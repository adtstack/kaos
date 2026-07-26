/**
 * Deterministic regression coverage for async reconciliation authority races.
 *
 * These cases intentionally move live state at the last possible await/fence:
 *   1. a startup disk-only snapshot becomes stale before ensureFile admission;
 *   2. a closed-file conflict opens/binds while its artifact is being written;
 *   3. a newer verified baseline callback lands while an older full reconcile
 *      is still preparing its final disk-index commit (including same-stat ABA);
 *   4. an open editor revision, binding epoch, or view set changes during the
 *      final full-reconcile settlement read.
 */

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

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
	editorBindings?: unknown;
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
		}) as never,
		getVaultSync: () => input.vaultSync as never,
		getDiskMirror: () => input.diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => input.editorBindings ?? null,
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

function clearMarkdownDrainTimer(controller: ReconciliationController): void {
	const internals = controller as never as {
		markdownDrainTimer: ReturnType<typeof setTimeout> | null;
	};
	if (internals.markdownDrainTimer) {
		clearTimeout(internals.markdownDrainTimer);
		internals.markdownDrainTimer = null;
	}
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

console.log("\n--- Race 4: full reconcile equality cannot publish after provider advance ---");
{
	const path = "open-full-settlement-race.md";
	const previousBaseline = "OLDER BASELINE\n";
	const settledC1 = "SETTLED C1\n";
	const providerC2 = "PROVIDER C2\n";
	const [previousBaselineHash, settledC1Hash] = await Promise.all([
		contentBaselineHash(previousBaseline),
		contentBaselineHash(settledC1),
	]);
	const file = makeTFile(path);
	(file as TFile & { stat: { mtime: number; size: number } }).stat = {
		mtime: 2,
		size: settledC1.length,
	};
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, settledC1);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: previousBaseline.length, contentHash: previousBaselineHash },
	};
	let baselineRecordCount = 0;
	let editorReadCount = 0;
	let providerAdvanceQueued = false;
	const providerOrigin = { provider: "full-settlement-race" };
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = {
		getValue: () => {
			editorReadCount++;
			if (editorReadCount === 3 && !providerAdvanceQueued) {
				providerAdvanceQueued = true;
				queueMicrotask(() => {
					doc.transact(() => {
						ytext.delete(0, ytext.length);
						ytext.insert(0, providerC2);
					}, providerOrigin);
				});
			}
			return settledC1;
		},
	};

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (candidate: TFile) => {
				if (candidate !== file) throw new Error("unexpected full settlement read");
				return settledC1;
			},
			adapter: { stat: async () => ({ mtime: 2, size: settledC1.length }) },
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
		},
		workspace: {
			iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) => {
				visit({ view });
			},
		},
	};
	const vaultSync = {
		connected: true,
		providerSynced: true,
		getActiveMarkdownPaths: () => [path],
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		isMarkdownTombstoned: () => false,
		getFileIdForText: () => "open-full-settlement-id",
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
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	const editorBindings = {
		isBound: () => true,
		getLastEditorActivityForPath: () => null,
		captureOpenEditorMutationTicket: (
			ticketPath: string,
			ticketViews: readonly MarkdownView[],
		) => ({
			path: ticketPath,
			views: ticketViews.map((ticketView) => ({ view: ticketView })),
		}),
		validateOpenEditorMutationTicket: (
			ticket: { path: string; views: ReadonlyArray<{ view: MarkdownView }> },
			currentViews: readonly MarkdownView[],
		) => ticket.path === path &&
			ticket.views.length === currentViews.length &&
			ticket.views.every((snapshot, index) => snapshot.view === currentViews[index])
			? { current: true as const }
			: { current: false as const, reason: "view-set-changed" as const },
	};
	const controller = new ReconciliationController({
		...baseDeps({
			app,
			vaultSync,
			editorBindings,
			diskMirror: {
				flushWrite: async () => {
					throw new Error("stale full settlement must not flush");
				},
			},
			getDiskIndex: () => diskIndex,
			setDiskIndex: (next) => { diskIndex = next; },
		}),
		recordBaselineText: () => { baselineRecordCount++; },
		trace: (_source, msg, details) => { traces.push({ msg, details }); },
	});

	await controller.runReconciliation("authoritative");
	await Promise.resolve();

	assert(providerAdvanceQueued, "provider C2 is queued after full reconcile observes C1 equality");
	assert(ytext.toString() === providerC2, "provider C2 remains the final CRDT authority");
	assert(
		diskIndex[path]?.contentHash !== settledC1Hash,
		"stale full-reconcile C1 never becomes the durable baseline",
	);
	assert(baselineRecordCount === 0, "stale full-reconcile C1 records no baseline text");
	assert(
		traces.some((trace) =>
			trace.msg === "disk-index-settlement-stale" &&
			trace.details?.reason === "crdt-authority-changed"
		),
		"full reconcile rejects the exact Y.Text content advance",
	);
	assert(controller.pending, "full reconcile requests a fresh authority plan");
	controller.reset();
	doc.destroy();
}

console.log("\n--- Race 5: full reconcile equality rechecks editor authority after its final read ---");

const fullSettlementEditorAuthorityRaces = {
	"editor-revision": "editor-revision-changed",
	"binding-epoch": "binding-epoch-changed",
	"open-view-set": "view-set-changed",
} as const;

for (const [advance, expectedReason] of Object.entries(
	fullSettlementEditorAuthorityRaces,
) as Array<[
	keyof typeof fullSettlementEditorAuthorityRaces,
	(typeof fullSettlementEditorAuthorityRaces)[keyof typeof fullSettlementEditorAuthorityRaces],
]>) {
	const path = `open-full-settlement-${advance}.md`;
	const previousBaseline = `OLDER FULL BASELINE ${advance}\n`;
	const settled = `SETTLED FULL AUTHORITY ${advance}\n`;
	const [previousBaselineHash, settledHash] = await Promise.all([
		contentBaselineHash(previousBaseline),
		contentBaselineHash(settled),
	]);
	const file = makeTFile(path);
	(file as TFile & { stat: { mtime: number; size: number } }).stat = {
		mtime: 2,
		size: settled.length,
	};
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, settled);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 1, size: previousBaseline.length, contentHash: previousBaselineHash },
	};
	let baselineRecordCount = 0;
	let settledHashPublishCount = 0;
	let editorRevision = 0;
	let bindingEpoch = 0;
	let isOpen = true;
	let primaryReadCount = 0;
	let releaseSettlementRead: (() => void) | null = null;
	let markSettlementReadStarted: (() => void) | null = null;
	const settlementReadStarted = new Promise<void>((resolve) => {
		markSettlementReadStarted = resolve;
	});
	const settlementReadGate = new Promise<void>((resolve) => {
		releaseSettlementRead = resolve;
	});
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => settled };

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (candidate: TFile) => {
				if (candidate !== file) throw new Error("unexpected full editor settlement read");
				primaryReadCount++;
				// Full reconciliation reads the scan, then the open-file refresh, then
				// updateDiskIndexForPath performs its final settlement read.
				if (primaryReadCount === 3) {
					markSettlementReadStarted?.();
					markSettlementReadStarted = null;
					await settlementReadGate;
				}
				return settled;
			},
			adapter: { stat: async () => ({ mtime: 2, size: settled.length }) },
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
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
		getFileIdForText: () => `open-full-settlement-${advance}-id`,
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
	const editorBindings = {
		isBound: () => true,
		getLastEditorActivityForPath: () => null,
		captureOpenEditorMutationTicket: (
			ticketPath: string,
			ticketViews: readonly MarkdownView[],
		) => ({
			path: ticketPath,
			views: ticketViews.map((ticketView) => ({
				view: ticketView,
				bindingEpoch,
				editorRevision,
			})),
		}),
		validateOpenEditorMutationTicket: (
			ticket: {
				path: string;
				views: ReadonlyArray<{
					view: MarkdownView;
					bindingEpoch: number;
					editorRevision: number;
				}>;
			},
			currentViews: readonly MarkdownView[],
		) => {
			if (
				ticket.path !== path ||
				ticket.views.length !== currentViews.length ||
				ticket.views.some((snapshot, index) => snapshot.view !== currentViews[index])
			) {
				return { current: false as const, reason: "view-set-changed" as const };
			}
			if (ticket.views.some((snapshot) => snapshot.bindingEpoch !== bindingEpoch)) {
				return { current: false as const, reason: "binding-epoch-changed" as const };
			}
			if (ticket.views.some((snapshot) => snapshot.editorRevision !== editorRevision)) {
				return { current: false as const, reason: "editor-revision-changed" as const };
			}
			return { current: true as const };
		},
	};
	const controller = new ReconciliationController({
		...baseDeps({
			app,
			vaultSync,
			editorBindings,
			diskMirror: {
				flushWrite: async () => {
					throw new Error("stale full editor settlement must not flush");
				},
			},
			getDiskIndex: () => diskIndex,
			setDiskIndex: (next) => {
				if (next[path]?.contentHash === settledHash) settledHashPublishCount++;
				diskIndex = next;
			},
		}),
		recordBaselineText: () => { baselineRecordCount++; },
		trace: (_source, msg, details) => { traces.push({ msg, details }); },
	});
	const candidate = Object.freeze({
		path,
		content: settled,
		sequence: 70,
		observedAt: 70,
		ctime: 70,
		mtime: 70,
		size: settled.length,
	});
	controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(controller);

	const reconcile = controller.runReconciliation("authoritative");
	await settlementReadStarted;
	if (advance === "editor-revision") {
		editorRevision++;
	} else if (advance === "binding-epoch") {
		bindingEpoch++;
	} else {
		isOpen = false;
	}
	releaseSettlementRead?.();
	await reconcile;

	assert(primaryReadCount === 3, `${advance}: full reconcile pauses at the final settlement read`);
	assert(baselineRecordCount === 0, `${advance}: full stale settlement records no baseline text`);
	assert(
		settledHashPublishCount === 0,
		`${advance}: full stale settlement never publishes the settled hash`,
	);
	assert(
		diskIndex[path]?.contentHash !== settledHash,
		`${advance}: full stale settlement cannot retain the rejected settled hash`,
	);
	const retainedCandidates = (controller as never as {
		interceptedExternalDiskMutations: Map<string, typeof candidate>;
	}).interceptedExternalDiskMutations;
	assert(
		retainedCandidates.get(path) === candidate,
		`${advance}: full stale settlement retains the exact intercepted candidate`,
	);
	assert(
		traces.some((trace) =>
			trace.msg === "disk-index-settlement-stale" &&
			trace.details?.reason === "editor-authority-changed" &&
			trace.details?.editorReason === expectedReason
		),
		`${advance}: full stale settlement traces the bounded editor reason`,
	);
	assert(controller.pending, `${advance}: full stale settlement requests a concrete follow-up plan`);
	clearMarkdownDrainTimer(controller);
	controller.reset();
	doc.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
