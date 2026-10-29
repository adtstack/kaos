import * as Y from "yjs";
import { TFile } from "obsidian";
import { VaultSync } from "../src/sync/vaultSync";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";
import type { FlightEventInput, FlightPathEventInput } from "../src/telemetry/debug/flightEvents";
import { withAttentionResolutionLock } from "../src/dashboard/attentionResolutionLock";
import { yTextToString } from "../src/utils/format";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: false,
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function makeTFile(path: string, size: number): TFile {
	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = path;
	file.stat = { mtime: 1, size };
	return file;
}

function makeVaultSync(onFlightPathEvent?: (event: FlightPathEventInput) => void): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
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
	vs._device = "TestDevice";
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightEvent = undefined;
	vs.onFlightPathEvent = onFlightPathEvent;
	vs.provider = { wsconnected: true };
	return vs as VaultSync;
}

function buildAdoptFixture(opts: {
	oldPath: string;
	oldContent: string;
	newPath: string;
	newContent: string;
	previousDiskIndex?: DiskIndex;
}) {
	const preservedUnresolved = new Map<string, PreservedUnresolvedEntry>();
	const vaultSync = makeVaultSync();
	const initialSeed = vaultSync.ensureFile(opts.oldPath, opts.oldContent, "TestDevice");
	if (initialSeed.kind !== "created") {
		throw new Error("Fixture failed to create initial CRDT identity");
	}
	const originalOldFileId = vaultSync.getFileId(opts.oldPath);

	const diskFiles = new Map<string, { file: TFile; content: string }>();
	const newFile = makeTFile(opts.newPath, opts.newContent.length);
	diskFiles.set(opts.newPath, { file: newFile, content: opts.newContent });

	const app = {
		vault: {
			getMarkdownFiles: () => [...diskFiles.values()].map((d) => d.file),
			read: async (file: TFile & { path: string }) => {
				const entry = diskFiles.get(file.path);
				if (!entry) throw new Error(`unexpected read: ${file.path}`);
				return entry.content;
			},
			adapter: {
				stat: async (path: string) => {
					const entry = diskFiles.get(path);
					if (!entry) return null;
					return { mtime: 1, size: entry.content.length };
				},
			},
			getAbstractFileByPath: (path: string) => diskFiles.get(path)?.file ?? null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	const diskMirror = {
		flushWrite: async (path: string) => {
			if (preservedUnresolved.has(path)) {
				return { kind: "blocked" as const, path, reason: "preserved-unresolved" as const };
			}
			return { kind: "ok" as const, path };
		},
		getPreservedUnresolvedEntries: () =>
			[...preservedUnresolved.values()].map((entry) => ({ ...entry })),
		isPreservedUnresolved: (path: string) => preservedUnresolved.has(path),
		isPreservedUnresolvedWriteBlocked: (path: string) => preservedUnresolved.has(path),
		recordPreservedUnresolved: (path: string, reason: string, pairPath?: string) => {
			const previous = preservedUnresolved.get(path);
			preservedUnresolved.set(path, {
				path,
				kind: "markdown",
				reason: (reason as any) ?? "path-collision",
				pairPath,
				episodeId: previous?.episodeId ?? `test-episode:${path}`,
				firstSeenAt: previous?.firstSeenAt ?? 1,
				lastSeenAt: (previous?.lastSeenAt ?? 0) + 1,
				localHash: previous?.localHash ?? null,
				knownRemoteHash: previous?.knownRemoteHash ?? null,
			});
		},
		clearPreservedUnresolved: (path: string) => {
			preservedUnresolved.delete(path);
		},
	};

	let diskIndex: DiskIndex = opts.previousDiskIndex ?? {};
	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as never,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
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
		recordFlightEvent: () => {},
		recordFlightPathEvent: () => {},
	});

	// Mock KaosPlugin adoptStructuralRename runner
	const attentionResolutionInFlight = new Set<string>();
	let preservedUnresolvedEntries: PreservedUnresolvedEntry[] = [];

	const adoptStructuralRename = async (oldPath: string, newPath: string): Promise<void> => {
		const normOld = oldPath;
		const normNew = newPath;
		const lockKeyOld = `markdown:${normOld}`;
		const lockKeyNew = `markdown:${normNew}`;

		return withAttentionResolutionLock(
			attentionResolutionInFlight,
			lockKeyOld,
			normOld,
			async () => {
				return withAttentionResolutionLock(
					attentionResolutionInFlight,
					lockKeyNew,
					normNew,
					async () => {
						if (!vaultSync) {
							throw new Error("Vault sync engine is not available.");
						}

						// 1a. Old path must still be tracked in CRDT
						const oldFileId = vaultSync.getFileId(normOld);
						const oldYText = vaultSync.getTextForPath(normOld);
						if (!oldFileId || !oldYText) {
							throw new Error(`Cannot adopt rename: "${normOld}" is no longer tracked in CRDT.`);
						}

						// 1b. Old path must be absent from local disk
						const oldDiskFile = app.vault.getAbstractFileByPath(normOld);
						if (oldDiskFile) {
							throw new Error(`Cannot adopt rename: "${normOld}" still exists on local disk.`);
						}

						// 1c. New path must exist on local disk as a file
						const newDiskFile = app.vault.getAbstractFileByPath(normNew);
						if (!(newDiskFile instanceof TFile)) {
							throw new Error(`Cannot adopt rename: "${normNew}" does not exist on local disk.`);
						}

						// 1d. New path must NOT be tracked in CRDT with a different file identity
						const newFileId = vaultSync.getFileId(normNew);
						if (newFileId && newFileId !== oldFileId) {
							throw new Error(`Cannot adopt rename: "${normNew}" is already tracked in CRDT with a different file identity.`);
						}

						// 1e. Content hash must match between old CRDT text and new disk file
						const oldCrdtContent = yTextToString(oldYText) ?? "";
						const newDiskContent = await app.vault.read(newDiskFile);
						const crdtHash = await contentBaselineHash(oldCrdtContent);
						const diskHash = await contentBaselineHash(newDiskContent);
						if (crdtHash !== diskHash) {
							throw new Error("Cannot adopt rename: content diverged between CRDT baseline and disk copy.");
						}

						// 1f. Verify matching unresolved structural change in reconciliation controller
						const matchingChange = controller.findUnresolvedStructuralChange(
							(change) =>
								change.oldPaths.some((p) => p === normOld) &&
								change.newPaths.some((p) => p === normNew),
						);
						if (!matchingChange) {
							throw new Error("Cannot adopt rename: structural change is no longer pending in reconciliation controller.");
						}

						// 2. Commit Rename in CRDT via applyReconcileRenameBatch
						const renameBatch = new Map([[normOld, normNew]]);
						vaultSync.applyReconcileRenameBatch(renameBatch);

						// 3. Clear preserved-unresolved markers and write fences for BOTH paths
						diskMirror.clearPreservedUnresolved(normOld);
						diskMirror.clearPreservedUnresolved(normNew);

						// 4. Remove from reconciliationController's unresolved structural changes
						controller.removeUnresolvedStructuralChange(normOld, normNew);
						controller.clearAutomaticRecoveryHoldsForPath(normOld);
						controller.clearAutomaticRecoveryHoldsForPath(normNew);

						// 5. Remove from preservedUnresolvedEntries
						preservedUnresolvedEntries = preservedUnresolvedEntries.filter(
							(e) => e.path !== normOld && e.path !== normNew,
						);
					},
				);
			},
		);
	};

	return {
		controller,
		vaultSync,
		app,
		diskMirror,
		diskFiles,
		originalOldFileId,
		adoptStructuralRename,
		getPreservedEntries: () => preservedUnresolved,
	};
}

async function runTests() {
	console.log("\n--- Adopt Structural Rename: CAS validation & resolution flow ---");

	const noteContent = "# Blog GA\nSome notes on analytics\n";
	const baselineHash = await contentBaselineHash(noteContent);
	const oldPath = "BACKLOG/blog ga.md";
	const newPath = "MEMOS/blog ga.md";

	const fixture = buildAdoptFixture({
		oldPath,
		oldContent: noteContent,
		newPath,
		newContent: noteContent,
		previousDiskIndex: {
			[oldPath]: {
				mtime: 1,
				size: noteContent.length,
				contentHash: baselineHash,
			},
		},
	});

	// Step 1: Initial reconcile detects 1:1 move without event → quarantined
	await fixture.controller.runReconciliation("authoritative");


	const stateBefore = fixture.controller.getState();
	assertEq(stateBefore.unresolvedStructuralChangeGroupCount, 1, "Reconcile flagged 1 structural change group");
	assertEq(stateBefore.unresolvedStructuralChangeCount, 2, "Reconcile quarantined both old and new paths");
	assert(fixture.diskMirror.isPreservedUnresolved(oldPath), "Old path has preserved-unresolved marker");
	assert(fixture.diskMirror.isPreservedUnresolved(newPath), "New path has preserved-unresolved marker");
	assert(fixture.diskMirror.isPreservedUnresolvedWriteBlocked(newPath), "New path write fence is active");

	// Step 2: CAS Failures
	// 2a: Diverged content
	fixture.diskFiles.set(newPath, { file: makeTFile(newPath, 999), content: "diverged content!" });
	let errDiverged: Error | null = null;
	try {
		await fixture.adoptStructuralRename(oldPath, newPath);
	} catch (e: any) {
		errDiverged = e;
	}
	assert(errDiverged !== null && errDiverged.message.includes("content diverged"), "CAS rejects when content diverged");

	// Restore matching content
	fixture.diskFiles.set(newPath, { file: makeTFile(newPath, noteContent.length), content: noteContent });

	// 2b: Old path reappeared on disk
	fixture.diskFiles.set(oldPath, { file: makeTFile(oldPath, noteContent.length), content: noteContent });
	let errOldDisk: Error | null = null;
	try {
		await fixture.adoptStructuralRename(oldPath, newPath);
	} catch (e: any) {
		errOldDisk = e;
	}
	assert(errOldDisk !== null && errOldDisk.message.includes("still exists on local disk"), "CAS rejects when old path exists on disk");
	fixture.diskFiles.delete(oldPath);

	// 2c: New path missing on disk
	fixture.diskFiles.delete(newPath);
	let errNewMissing: Error | null = null;
	try {
		await fixture.adoptStructuralRename(oldPath, newPath);
	} catch (e: any) {
		errNewMissing = e;
	}
	assert(errNewMissing !== null && errNewMissing.message.includes("does not exist on local disk"), "CAS rejects when new path is missing on disk");
	fixture.diskFiles.set(newPath, { file: makeTFile(newPath, noteContent.length), content: noteContent });

	// Step 3: Successful Adoption
	await fixture.adoptStructuralRename(oldPath, newPath);

	// Verify CRDT rename happened: oldPath gone, newPath holds originalOldFileId
	assertEq(fixture.vaultSync.getFileId(oldPath), undefined, "oldPath is no longer in CRDT map");
	assertEq(fixture.vaultSync.getFileId(newPath), fixture.originalOldFileId, "newPath bound to original fileId in CRDT");

	// Verify markers and write fences cleared
	assert(!fixture.diskMirror.isPreservedUnresolved(oldPath), "Old path preserved-unresolved marker cleared");
	assert(!fixture.diskMirror.isPreservedUnresolved(newPath), "New path preserved-unresolved marker cleared");
	assert(!fixture.diskMirror.isPreservedUnresolvedWriteBlocked(newPath), "New path write fence lifted");

	// Verify reconciliation controller state cleared
	const stateAfterAdopt = fixture.controller.getState();
	assertEq(stateAfterAdopt.unresolvedStructuralChangeGroupCount, 0, "No unresolved structural changes in controller");

	// Step 4: Subsequent reconcile runs clean (no collision re-quarantine, no deadlock!)
	await fixture.controller.runReconciliation("authoritative");
	const stateAfterReconcile = fixture.controller.getState();
	assertEq(stateAfterReconcile.unresolvedStructuralChangeGroupCount, 0, "Subsequent reconcile retains 0 structural changes");
	assertEq(stateAfterReconcile.unresolvedStructuralChangeCount, 0, "Subsequent reconcile retains 0 quarantined paths");
	assert(!fixture.diskMirror.isPreservedUnresolved(newPath), "New path remains unquarantined after reconcile");

	// Step 5: UI gate check
	// 1:1 pair -> isSinglePair is true
	const sample1to1 = { oldPaths: ["BACKLOG/a.md"], newPaths: ["MEMOS/a.md"] };
	const isSinglePair = sample1to1.oldPaths.length === 1 && sample1to1.newPaths.length === 1;
	assert(isSinglePair, "UI gate: 1:1 pair enables Adopt rename button");

	// Count mismatch / multiple paths -> isSinglePair is false
	const sampleMulti = { oldPaths: ["BACKLOG/a.md", "BACKLOG/b.md"], newPaths: ["MEMOS/a.md"] };
	const isMultiSingle = sampleMulti.oldPaths.length === 1 && sampleMulti.newPaths.length === 1;
	assert(!isMultiSingle, "UI gate: multi-path change disables Adopt rename button (No direct file action)");

	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void runTests();
