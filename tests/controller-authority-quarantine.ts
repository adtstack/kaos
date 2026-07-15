import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import {
	getPreservedUnresolvedEpisodeId,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
} from "../src/sync/preservedUnresolved";
import { VaultSync } from "../src/sync/vaultSync";

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(
		`  FAIL  ${message}\n        expected=${String(expected)}\n        actual=${String(actual)}`,
	);
	failed++;
}

function makeTFile(path: string, content: string, mtime = 1): TFile {
	const file = new TFile() as TFile & {
		path: string;
		stat: { mtime: number; size: number };
	};
	file.path = path;
	file.stat = { mtime, size: content.length };
	return file;
}

function makeEntry(
	path: string,
	episodeId: string,
	reason: PreservedUnresolvedReason = "multiple-editor-authorities",
): PreservedUnresolvedEntry {
	return {
		path,
		kind: "markdown",
		reason,
		episodeId,
		firstSeenAt: 10,
		lastSeenAt: 20,
		localHash: null,
		knownRemoteHash: null,
	};
}

function makeVaultSync(): VaultSync {
	const vaultSync = Object.create(VaultSync.prototype) as VaultSync & Record<string, unknown>;
	vaultSync.ydoc = new Y.Doc();
	vaultSync.pathToId = vaultSync.ydoc.getMap("pathToId");
	vaultSync.idToText = vaultSync.ydoc.getMap("idToText");
	vaultSync.meta = vaultSync.ydoc.getMap("meta");
	vaultSync.sys = vaultSync.ydoc.getMap("sys");
	vaultSync.pathToBlob = vaultSync.ydoc.getMap("pathToBlob");
	vaultSync.blobMeta = vaultSync.ydoc.getMap("blobMeta");
	vaultSync.blobTombstones = vaultSync.ydoc.getMap("blobTombstones");
	vaultSync._textToFileId = new WeakMap();
	vaultSync._pathIndex = new Map();
	vaultSync._deletedPathIndex = new Set();
	vaultSync._activePathCollisions = new Map();
	vaultSync._pathIndexesDirty = true;
	vaultSync._localReady = true;
	vaultSync._providerSynced = true;
	vaultSync._connectionGeneration = 1;
	vaultSync._renameBatch = new Map();
	vaultSync._renameBatchNewToOld = new Map();
	vaultSync._renameTimer = null;
	vaultSync._onRenameBatchFlushed = null;
	vaultSync._eventRing = [];
	vaultSync._device = "QuarantineTest";
	vaultSync.debug = false;
	vaultSync.trace = undefined;
	vaultSync.onFlightEvent = undefined;
	vaultSync.onFlightPathEvent = undefined;
	vaultSync.provider = { wsconnected: true };
	return vaultSync as VaultSync;
}

function clearControllerTimers(controller: ReconciliationController): void {
	const internals = controller as unknown as {
		markdownDrainTimer: ReturnType<typeof setTimeout> | null;
		reconcileCooldownTimer: ReturnType<typeof setTimeout> | null;
	};
	if (internals.markdownDrainTimer) clearTimeout(internals.markdownDrainTimer);
	if (internals.reconcileCooldownTimer) clearTimeout(internals.reconcileCooldownTimer);
	internals.markdownDrainTimer = null;
	internals.reconcileCooldownTimer = null;
}

async function drainDirtyMarkdown(controller: ReconciliationController): Promise<void> {
	clearControllerTimers(controller);
	await (controller as unknown as { drainDirtyMarkdownPaths(): Promise<void> })
		.drainDirtyMarkdownPaths();
	clearControllerTimers(controller);
}

console.log("\n--- Controller quarantine: persisted markers block every full-reconcile lane ---");
{
	const diskOnlyPath = "Restart/disk-only.md";
	const crdtOnlyPath = "Restart/crdt-only.md";
	const divergedPath = "Restart/diverged.md";
	const diskOnlyContent = "disk-only local bytes\n";
	const crdtOnlyContent = "crdt-only remote bytes\n";
	const divergedDiskContent = "diverged disk bytes\n";
	const divergedCrdtContent = "diverged CRDT bytes\n";
	const diskContents = new Map<string, string>([
		[diskOnlyPath, diskOnlyContent],
		[divergedPath, divergedDiskContent],
	]);
	const files = new Map<string, TFile>([
		[diskOnlyPath, makeTFile(diskOnlyPath, diskOnlyContent, 11)],
		[divergedPath, makeTFile(divergedPath, divergedDiskContent, 12)],
	]);
	const artifacts = new Map<string, string>();
	const entries = new Map<string, PreservedUnresolvedEntry>([
		[diskOnlyPath, makeEntry(diskOnlyPath, "persisted-disk-only")],
		[crdtOnlyPath, makeEntry(crdtOnlyPath, "persisted-crdt-only")],
		[divergedPath, makeEntry(divergedPath, "persisted-diverged")],
	]);
	const vaultSync = makeVaultSync();
	vaultSync.ensureFile(crdtOnlyPath, crdtOnlyContent, "QuarantineTest");
	vaultSync.ensureFile(divergedPath, divergedCrdtContent, "QuarantineTest");
	let ensureCallsAfterRestart = 0;
	const originalEnsureFile = vaultSync.ensureFile.bind(vaultSync);
	vaultSync.ensureFile = ((...args: Parameters<VaultSync["ensureFile"]>) => {
		ensureCallsAfterRestart++;
		return originalEnsureFile(...args);
	}) as VaultSync["ensureFile"];

	const flushWrites: string[] = [];
	const clearCalls: string[] = [];
	const baselinePublishes: string[] = [];
	let diskIndex: DiskIndex = {};
	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [...files.values()],
				read: async (file: TFile & { path: string }) => {
					const content = diskContents.get(file.path) ?? artifacts.get(file.path);
					if (content === undefined) throw new Error(`unexpected read: ${file.path}`);
					return content;
				},
				create: async (path: string, content: string) => {
					artifacts.set(path, content);
				},
				adapter: {
					stat: async (path: string) => {
						const file = files.get(path) as (TFile & { stat?: { mtime: number; size: number } }) | undefined;
						return file?.stat ?? null;
					},
				},
				getAbstractFileByPath: (path: string) => files.get(path) ?? null,
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "QuarantineTest" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => ({
			getPreservedUnresolvedEntries: () => [...entries.values()].map((entry) => ({ ...entry })),
			isPreservedUnresolved: (path: string) => entries.has(path),
			clearPreservedUnresolved: (path: string) => {
				clearCalls.push(path);
				entries.delete(path);
			},
			recordPreservedUnresolved: () => {},
			suppressLocalCreate: async () => {},
			flushWrite: async (path: string) => {
				flushWrites.push(path);
				return { kind: "blocked", path, reason: "preserved-unresolved" };
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		recordBaselineText: (_hash, text) => { baselinePublishes.push(text); },
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

	assertEqual(ensureCallsAfterRestart, 0, "disk-only marker prevents CRDT seeding after restart");
	assertEqual(flushWrites.length, 0, "CRDT-only and diverged markers prevent disk create/replace flushes");
	assertEqual(artifacts.size, 0, "persisted quarantine does not manufacture conflict artifacts or disk files");
	assert(vaultSync.getTextForPath(diskOnlyPath) === null, "disk-only marker leaves CRDT identity absent");
	assertEqual(
		vaultSync.getTextForPath(crdtOnlyPath)?.toJSON(),
		crdtOnlyContent,
		"CRDT-only marker leaves the remote candidate unchanged",
	);
	assertEqual(
		vaultSync.getTextForPath(divergedPath)?.toJSON(),
		divergedCrdtContent,
		"diverged marker leaves CRDT content unchanged",
	);
	assertEqual(diskContents.get(divergedPath), divergedDiskContent, "diverged marker leaves disk bytes unchanged");
	assertEqual(clearCalls.length, 0, "full reconcile never clears a persisted Attention episode");
	assertEqual(baselinePublishes.length, 0, "blocked paths publish no durable content baseline");
	assert(
		![diskOnlyPath, crdtOnlyPath, divergedPath].some((path) => path in diskIndex),
		"all persisted-quarantine paths remain excluded from the disk index",
	);
	assertEqual(entries.size, 3, "all persisted Attention episodes survive full reconcile");
	controller.reset();
	vaultSync.ydoc.destroy();
}

interface DirtyFixtureOptions {
	maxFileSizeBytes?: number;
	frontmatterBlocked?: boolean;
}

function makeDirtyFixture(options: DirtyFixtureOptions = {}) {
	const path = "Dirty/attention.md";
	let diskContent = "fresh local disk bytes\n";
	const initialCrdtContent = "older CRDT bytes\n";
	const file = makeTFile(path, diskContent, 21);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initialCrdtContent);
	let entry: PreservedUnresolvedEntry | null = null;
	let diskIndex: DiskIndex = {};
	let clearCalls = 0;
	const artifacts = new Map<string, string>();
	const operationOrder: string[] = [];

	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [file],
				read: async (candidate: TFile & { path: string }) => {
					if (candidate.path === path) return diskContent;
					const artifact = artifacts.get(candidate.path);
					if (artifact === undefined) throw new Error(`unexpected read: ${candidate.path}`);
					return artifact;
				},
				create: async (artifactPath: string, content: string) => {
					operationOrder.push("artifact-create");
					artifacts.set(artifactPath, content);
				},
				adapter: {
					stat: async () => ({ mtime: 21, size: diskContent.length }),
				},
				getAbstractFileByPath: (candidate: string) => {
					if (candidate === path) return file;
					return artifacts.has(candidate) ? makeTFile(candidate, artifacts.get(candidate)!) : null;
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "DirtyFixture" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: options.maxFileSizeBytes ?? 0,
			maxFileSizeKB: 1,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => ({
			getTextForPath: (candidate: string) => candidate === path ? ytext : null,
			getFileIdForText: () => "dirty-file-id",
			isPendingRenameTarget: () => false,
			serverAckTracker: {
				withActiveOpId: (_opId: string | undefined, work: () => unknown) => work(),
			},
		}) as never,
		getDiskMirror: () => ({
			getPreservedUnresolvedEntries: () => entry ? [{ ...entry }] : [],
			isPreservedUnresolved: () => entry !== null,
			clearPreservedUnresolved: () => {
				operationOrder.push("marker-clear");
				clearCalls++;
				entry = null;
			},
			recordPreservedUnresolved: (_path: string, reason: PreservedUnresolvedReason) => {
				if (entry) entry = { ...entry, reason, lastSeenAt: entry.lastSeenAt + 1 };
			},
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			suppressLocalCreate: async () => {},
			flushWrite: async () => { throw new Error("unexpected disk flush"); },
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => {
			operationOrder.push("index-set");
			diskIndex = next;
		},
		recordBaselineText: () => { operationOrder.push("baseline-record"); },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => options.frontmatterBlocked === true,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => { operationOrder.push("index-save"); },
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	return {
		controller,
		doc,
		file,
		path,
		ytext,
		initialCrdtContent,
		get diskContent() { return diskContent; },
		setDiskContent(content: string) { diskContent = content; },
		get diskIndex() { return diskIndex; },
		get entry() { return entry; },
		setEntry(next: PreservedUnresolvedEntry | null) { entry = next; },
		get clearCalls() { return clearCalls; },
		artifacts,
		operationOrder,
	};
}

type ClosedMutationResult<T> =
	| { kind: "committed"; value: T }
	| { kind: "stale" };

interface ClosedMutationHarness {
	commitClosedFileReconcileMutation<T>(input: {
		path: string;
		file: TFile | null;
		expectedYText: Y.Text | null;
		expectedDiskContent: string;
		expectedCrdtContent: string | null;
		expectedDiskRevision: number;
		expectedPreservedUnresolvedEpisodeId?: string;
		stage: string;
		commit: () => T;
	}): Promise<ClosedMutationResult<T>>;
	noteMarkdownDiskMutation(path: string): void;
	deps: {
		app: {
			vault: {
				read(file: TFile): Promise<string>;
			};
		};
		getVaultSync(): {
			getTextForPath(path: string): Y.Text | null;
		} | null;
	};
}

console.log("\n--- Controller quarantine: only an event admitted by the exact episode may resolve it ---");
{
	const fixture = makeDirtyFixture();
	fixture.controller.markMarkdownDirty(fixture.file, "modify", "op-before-marker");
	fixture.setEntry(makeEntry(fixture.path, "episode-created-after-admission"));
	await drainDirtyMarkdown(fixture.controller);

	assertEqual(fixture.ytext.toString(), fixture.initialCrdtContent, "pre-marker dirty event cannot change CRDT");
	assertEqual(fixture.diskContent, "fresh local disk bytes\n", "pre-marker dirty event cannot change disk");
	assertEqual(Object.keys(fixture.diskIndex).length, 0, "pre-marker dirty event cannot advance the index");
	assertEqual(fixture.clearCalls, 0, "pre-marker dirty event cannot clear a later marker");
	assertEqual(fixture.artifacts.size, 0, "pre-marker dirty event cannot claim conflict-resolution authority");
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Controller quarantine: oversize and frontmatter gates retain the exact episode ---");
for (const scenario of [
	{ label: "oversized", options: { maxFileSizeBytes: 4 } },
	{ label: "frontmatter-blocked", options: { frontmatterBlocked: true } },
]) {
	const fixture = makeDirtyFixture(scenario.options);
	const marker = makeEntry(fixture.path, `episode-${scenario.label}`);
	fixture.setEntry(marker);
	fixture.controller.markMarkdownDirty(fixture.file, "modify", `op-${scenario.label}`);
	await drainDirtyMarkdown(fixture.controller);

	assertEqual(fixture.ytext.toString(), fixture.initialCrdtContent, `${scenario.label} event leaves CRDT unchanged`);
	assertEqual(Object.keys(fixture.diskIndex).length, 0, `${scenario.label} event leaves the index unchanged`);
	assertEqual(fixture.clearCalls, 0, `${scenario.label} event does not clear Attention`);
	assertEqual(
		fixture.entry ? getPreservedUnresolvedEpisodeId(fixture.entry) : null,
		marker.episodeId,
		`${scenario.label} event retains the exact episode`,
	);
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Controller quarantine: exact fresh local event clears only after preservation and baseline save ---");
{
	const fixture = makeDirtyFixture();
	fixture.setEntry(makeEntry(fixture.path, "episode-fresh-local-event"));
	fixture.controller.markMarkdownDirty(fixture.file, "modify", "op-fresh-local-event");
	await drainDirtyMarkdown(fixture.controller);

	assertEqual(fixture.ytext.toString(), fixture.diskContent, "exact-episode event converges CRDT to local bytes");
	assertEqual(fixture.diskContent, "fresh local disk bytes\n", "exact-episode event does not rewrite disk");
	assertEqual(fixture.clearCalls, 1, "exact-episode event clears Attention once");
	assert(fixture.entry === null, "resolved episode is absent only after successful settlement");
	assert(
		[...fixture.artifacts.values()].includes(fixture.initialCrdtContent),
		"losing CRDT candidate is preserved before convergence",
	);
	assertEqual(
		fixture.diskIndex[fixture.path]?.contentHash,
		await contentBaselineHash(fixture.diskContent),
		"exact local bytes become the durable baseline",
	);
	const artifactAt = fixture.operationOrder.indexOf("artifact-create");
	const baselineAt = fixture.operationOrder.indexOf("baseline-record");
	const saveAt = fixture.operationOrder.indexOf("index-save");
	const clearAt = fixture.operationOrder.indexOf("marker-clear");
	assert(
		artifactAt >= 0 && artifactAt < baselineAt && baselineAt < saveAt && saveAt < clearAt,
		"artifact -> baseline -> durable save -> marker clear order is exact",
	);
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Closed reconcile: provider microtask runs after the synchronous commit ---");
{
	const fixture = makeDirtyFixture();
	const harness = fixture.controller as unknown as ClosedMutationHarness;
	const originalGetVaultSync = harness.deps.getVaultSync;
	const order: string[] = [];
	let providerUpdateQueued = false;
	const providerContent = "newer provider bytes\n";
	harness.deps.getVaultSync = () => {
		const vaultSync = originalGetVaultSync();
		return vaultSync && {
			...vaultSync,
			getTextForPath: (path: string) => {
				const text = vaultSync.getTextForPath(path);
				if (path === fixture.path && text && !providerUpdateQueued) {
					providerUpdateQueued = true;
					queueMicrotask(() => {
						order.push("provider");
						text.doc?.transact(() => {
							text.delete(0, text.length);
							text.insert(0, providerContent);
						});
					});
				}
				return text;
			},
		};
	};

	const result = await harness.commitClosedFileReconcileMutation({
		path: fixture.path,
		file: fixture.file,
		expectedYText: fixture.ytext,
		expectedDiskContent: fixture.diskContent,
		expectedCrdtContent: fixture.initialCrdtContent,
		expectedDiskRevision: 0,
		stage: "test-provider-microtask",
		commit: () => {
			order.push("commit");
			fixture.doc.transact(() => {
				fixture.ytext.delete(0, fixture.ytext.length);
				fixture.ytext.insert(0, fixture.diskContent);
			});
		},
	});

	assertEqual(result.kind, "committed", "stable ticket invokes its commit callback");
	assertEqual(order.join(","), "commit,provider", "provider microtask cannot enter between validation and commit");
	assertEqual(fixture.ytext.toString(), providerContent, "newer provider update remains the final CRDT value");
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Closed reconcile: same-bytes Y.Text replacement occurs only after commit ---");
{
	const fixture = makeDirtyFixture();
	const harness = fixture.controller as unknown as ClosedMutationHarness;
	const originalGetVaultSync = harness.deps.getVaultSync;
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, fixture.initialCrdtContent);
	let activeText = fixture.ytext;
	let replacementQueued = false;
	let commitSawOriginal = false;
	harness.deps.getVaultSync = () => {
		const vaultSync = originalGetVaultSync();
		return vaultSync && {
			...vaultSync,
			getTextForPath: (path: string) => {
				if (path !== fixture.path) return vaultSync.getTextForPath(path);
				if (!replacementQueued) {
					replacementQueued = true;
					queueMicrotask(() => { activeText = replacementText; });
				}
				return activeText;
			},
		};
	};

	const result = await harness.commitClosedFileReconcileMutation({
		path: fixture.path,
		file: fixture.file,
		expectedYText: fixture.ytext,
		expectedDiskContent: fixture.diskContent,
		expectedCrdtContent: fixture.initialCrdtContent,
		expectedDiskRevision: 0,
		stage: "test-same-bytes-ytext-aba",
		commit: () => {
			commitSawOriginal = activeText === fixture.ytext;
			fixture.doc.transact(() => {
				fixture.ytext.delete(0, fixture.ytext.length);
				fixture.ytext.insert(0, fixture.diskContent);
			});
		},
	});

	assertEqual(result.kind, "committed", "same-bytes replacement is queued only after admission");
	assert(commitSawOriginal, "commit runs while the admitted Y.Text is still authoritative");
	assert(activeText === replacementText, "queued provider work replaces the active Y.Text after commit");
	assertEqual(
		replacementText.toString(),
		fixture.initialCrdtContent,
		"commit never overwrites the equal-value replacement Y.Text",
	);
	fixture.controller.reset();
	fixture.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Closed reconcile: same-TFile same-length disk mutation invalidates the ticket ---");
{
	const fixture = makeDirtyFixture();
	const harness = fixture.controller as unknown as ClosedMutationHarness;
	const admittedDiskContent = fixture.diskContent;
	const newerDiskContent = "fresh rival disk bytes\n";
	assertEqual(newerDiskContent.length, admittedDiskContent.length, "test disk candidates have the same length");
	let commitCalls = 0;
	harness.deps.app.vault.read = async () => {
		const captured = admittedDiskContent;
		queueMicrotask(() => {
			fixture.setDiskContent(newerDiskContent);
			(fixture.file as TFile & { stat: { mtime: number; size: number } }).stat = {
				mtime: 22,
				size: newerDiskContent.length,
			};
			harness.noteMarkdownDiskMutation(fixture.path);
		});
		return captured;
	};

	const result = await harness.commitClosedFileReconcileMutation({
		path: fixture.path,
		file: fixture.file,
		expectedYText: fixture.ytext,
		expectedDiskContent: admittedDiskContent,
		expectedCrdtContent: fixture.initialCrdtContent,
		expectedDiskRevision: 0,
		stage: "test-same-tfile-disk-aba",
		commit: () => { commitCalls++; },
	});

	assertEqual(result.kind, "stale", "same TFile with new disk generation fails the ticket");
	assertEqual(commitCalls, 0, "stale same-TFile read cannot reach the commit callback");
	assertEqual(fixture.diskContent, newerDiskContent, "newer same-length disk bytes remain untouched");
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Closed reconcile: same-bytes TFile delete/recreate ABA fails the final ticket ---");
{
	const path = "Closed/same-bytes-aba.md";
	const diskContent = "local disk winner\n";
	const crdtContent = "previous CRDT baseline\n";
	const originalFile = makeTFile(path, diskContent, 31);
	const replacementFile = makeTFile(path, diskContent, 31);
	let activeFile: TFile = originalFile;
	let originalReadCount = 0;
	const artifacts = new Map<string, string>();
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const baselineHash = await contentBaselineHash(crdtContent);
	let diskIndex: DiskIndex = {
		[path]: { mtime: 30, size: crdtContent.length, contentHash: baselineHash },
	};
	const baselinePublishes: string[] = [];
	const flushWrites: string[] = [];
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];

	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [originalFile],
				read: async (file: TFile & { path: string }) => {
					if (file.path !== path) return artifacts.get(file.path) ?? "";
					originalReadCount++;
					if (originalReadCount === 2) activeFile = replacementFile;
					return diskContent;
				},
				create: async (artifactPath: string, content: string) => { artifacts.set(artifactPath, content); },
				adapter: { stat: async () => ({ mtime: 31, size: diskContent.length }) },
				getAbstractFileByPath: (candidate: string) => {
					if (candidate === path) return activeFile;
					return artifacts.has(candidate) ? makeTFile(candidate, artifacts.get(candidate)!) : null;
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "ABA" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => ({
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
			isPendingRenameTarget: () => false,
			isMarkdownTombstoned: () => false,
		}) as never,
		getDiskMirror: () => ({
			getPreservedUnresolvedEntries: () => [],
			isPreservedUnresolved: () => false,
			recordPreservedUnresolved: () => {},
			suppressLocalCreate: async () => {},
			flushWrite: async (candidate: string) => {
				flushWrites.push(candidate);
				throw new Error("ABA must fence before a flush");
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		recordBaselineText: (_hash, text) => { baselinePublishes.push(text); },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (_source, msg, details) => { traces.push({ msg, details }); },
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	await controller.runReconciliation("authoritative");

	assert(activeFile === replacementFile, "test interleaving replaces TFile during the final disk read");
	assertEqual(ytext.toString(), crdtContent, "same bytes under a replacement TFile cannot mutate CRDT");
	assertEqual(flushWrites.length, 0, "same-bytes TFile ABA cannot reach a disk flush");
	assertEqual(baselinePublishes.length, 0, "same-bytes TFile ABA cannot publish a baseline");
	assert(!(path in diskIndex), "same-bytes TFile ABA leaves the path unindexed for re-evaluation");
	assert(
		traces.some((trace) =>
			trace.msg === "closed-file-mutation-ticket-stale" &&
			trace.details?.reason === "disk-file-identity-changed"
		),
		"closed reconcile diagnoses the exact TFile identity ABA",
	);
	controller.reset();
	doc.destroy();
}

function makeVisibleWinnerMarkerRace(winner: "disk" | "crdt") {
	const path = `Closed/visible-${winner}-marker-race.md`;
	let diskContent = "disk candidate D\n";
	const crdtContent = "CRDT candidate C\n";
	const file = makeTFile(path, diskContent, 35);
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	let entry: PreservedUnresolvedEntry | null = null;
	let clearCalls = 0;
	let flushCalls = 0;
	let admissionSawNoMarker = false;
	let markerInstalledDuringHash = false;
	let diskIndex: DiskIndex = {};
	const baselinePublishes: string[] = [];
	const artifacts = new Map<string, string>();
	const artifactFiles = new Map<string, TFile>();

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getFileIdForText: () => "visible-race-file-id",
		getActiveMarkdownPaths: () => [path],
		reconcileVault: (
			_diskFiles: Map<string, string>,
			_diskPresentPaths: Set<string>,
			_mode: string,
			_device: string,
			_mintAdmission: unknown,
			isPathAdmitted: (candidate: string) => boolean,
		) => {
			admissionSawNoMarker = entry === null && isPathAdmitted(path);
			// The controller enters the updated-on-disk lane synchronously. Install
			// Attention in the first hash await after that lane's admission check.
			queueMicrotask(() => {
				entry = makeEntry(path, `episode-visible-${winner}-hash-race`);
				markerInstalledDuringHash = true;
			});
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
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0, duplicateActivePaths: 0 }),
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
	};

	const controller = new ReconciliationController({
		app: {
			vault: {
				getMarkdownFiles: () => [file, ...artifactFiles.values()],
				read: async (candidate: TFile & { path: string }) => {
					if (candidate === file) return diskContent;
					const artifact = artifacts.get(candidate.path);
					if (artifact === undefined) throw new Error(`unexpected read: ${candidate.path}`);
					return artifact;
				},
				create: async (artifactPath: string, content: string) => {
					artifacts.set(artifactPath, content);
					const artifactFile = makeTFile(artifactPath, content, 36);
					artifactFiles.set(artifactPath, artifactFile);
					return artifactFile;
				},
				adapter: { stat: async () => ({ mtime: 35, size: diskContent.length }) },
				getAbstractFileByPath: (candidate: string) => {
					if (candidate === path) return file;
					return artifactFiles.get(candidate) ?? null;
				},
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "VisibleMarkerRace" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			getPreservedUnresolvedEntries: () => entry ? [{ ...entry }] : [],
			isPreservedUnresolved: (candidate: string) => candidate === path && entry !== null,
			clearPreservedUnresolved: () => {
				clearCalls++;
				entry = null;
			},
			recordPreservedUnresolved: (
				candidate: string,
				reason: PreservedUnresolvedReason,
			) => {
				if (candidate !== path) return;
				if (entry) {
					entry = { ...entry, reason, lastSeenAt: entry.lastSeenAt + 1 };
				} else {
					entry = makeEntry(path, `unexpected-replacement-${winner}`, reason);
				}
			},
			suppressLocalCreate: async () => {},
			flushWrite: async (candidate: string) => {
				flushCalls++;
				if (entry) {
					return { kind: "blocked", path: candidate, reason: "preserved-unresolved" } as const;
				}
				const content = ytext.toString();
				diskContent = content;
				return {
					kind: "written",
					path: candidate,
					isCreate: false,
					content,
					contentHash: await contentBaselineHash(content),
					baselineRecorded: true,
				} as const;
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		recordBaselineText: (_hash, text) => { baselinePublishes.push(text); },
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
		visibleAuthorityDeferredPaths: Map<string, {
			editorContents: string[];
			readComplete: boolean;
			capturedDiskContent: string;
			capturedCrdtContent: string;
			capturedDiskRevision: number;
			capturedEditorActivity: number | null;
			capturedAt: number;
		}>;
	};
	internals.visibleAuthorityDeferredPaths.set(path, {
		editorContents: [winner === "disk" ? diskContent : crdtContent],
		readComplete: true,
		capturedDiskContent: diskContent,
		capturedCrdtContent: crdtContent,
		capturedDiskRevision: 0,
		capturedEditorActivity: null,
		capturedAt: Date.now() - 1,
	});

	return {
		controller,
		doc,
		path,
		ytext,
		crdtContent,
		initialDiskContent: diskContent,
		get diskContent() { return diskContent; },
		get entry() { return entry; },
		get clearCalls() { return clearCalls; },
		get flushCalls() { return flushCalls; },
		get admissionSawNoMarker() { return admissionSawNoMarker; },
		get markerInstalledDuringHash() { return markerInstalledDuringHash; },
		get baselinePublishes() { return baselinePublishes; },
	};
}

console.log("\n--- Closed reconcile: hash-race marker blocks visible disk winner CRDT mutation ---");
{
	const fixture = makeVisibleWinnerMarkerRace("disk");
	await fixture.controller.runReconciliation("authoritative");

	assert(fixture.admissionSawNoMarker, "disk-winner lane is admitted before the racing episode exists");
	assert(fixture.markerInstalledDuringHash, "disk-winner episode appears during the async hash boundary");
	assertEqual(fixture.ytext.toString(), fixture.crdtContent, "racing marker blocks disk-winner CRDT replacement");
	assertEqual(fixture.diskContent, fixture.initialDiskContent, "disk-winner race leaves disk bytes unchanged");
	assertEqual(fixture.clearCalls, 0, "disk-winner planner never clears the new episode speculatively");
	assertEqual(
		fixture.entry ? getPreservedUnresolvedEpisodeId(fixture.entry) : null,
		"episode-visible-disk-hash-race",
		"disk-winner race retains the exact episode",
	);
	assertEqual(fixture.flushCalls, 0, "stale disk-winner decision never reaches disk flush");
	assertEqual(fixture.baselinePublishes.length, 0, "blocked disk winner publishes no baseline");
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Closed reconcile: hash-race marker blocks visible CRDT winner disk flush ---");
{
	const fixture = makeVisibleWinnerMarkerRace("crdt");
	await fixture.controller.runReconciliation("authoritative");

	assert(fixture.admissionSawNoMarker, "CRDT-winner lane is admitted before the racing episode exists");
	assert(fixture.markerInstalledDuringHash, "CRDT-winner episode appears during the async hash boundary");
	assertEqual(fixture.ytext.toString(), fixture.crdtContent, "CRDT-winner race leaves CRDT bytes unchanged");
	assertEqual(fixture.diskContent, fixture.initialDiskContent, "racing marker blocks the CRDT-winner disk overwrite");
	assertEqual(fixture.clearCalls, 0, "CRDT-winner planner never clears the new episode speculatively");
	assertEqual(
		fixture.entry ? getPreservedUnresolvedEpisodeId(fixture.entry) : null,
		"episode-visible-crdt-hash-race",
		"CRDT-winner blocked flush retains the exact episode",
	);
	assertEqual(fixture.flushCalls, 1, "CRDT winner reaches one marker-aware flush attempt");
	assertEqual(fixture.baselinePublishes.length, 0, "blocked CRDT winner publishes no baseline");
	fixture.controller.reset();
	fixture.doc.destroy();
}

console.log("\n--- Open reconcile: captured editor authority changing without activity is preserved, never applied ---");
{
	const path = "Open/captured-authority-changed.md";
	const diskContent = "disk candidate\n";
	const crdtContent = "CRDT candidate\n";
	const capturedEditorContent = "captured editor candidate\n";
	let liveEditorContent = "later pane candidate without activity event\n";
	const file = makeTFile(path, diskContent, 41);
	const view = Object.assign(new MarkdownView(), {
		file,
		editor: { getValue: () => liveEditorContent },
	});
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, crdtContent);
	const artifacts = new Map<string, string>();
	const markerRecords: Array<{ path: string; reason: string }> = [];
	const flushWrites: string[] = [];

	const controller = new ReconciliationController({
		app: {
			vault: {
				read: async (candidate: TFile & { path: string }) =>
					candidate.path === path ? diskContent : (artifacts.get(candidate.path) ?? ""),
				create: async (artifactPath: string, content: string) => { artifacts.set(artifactPath, content); },
				getMarkdownFiles: () => [file],
				getAbstractFileByPath: (candidate: string) => {
					if (candidate === path) return file;
					return artifacts.has(candidate) ? makeTFile(candidate, artifacts.get(candidate)!) : null;
				},
				adapter: { stat: async () => ({ mtime: 41, size: diskContent.length }) },
			},
			workspace: {
				iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => callback({ view }),
			},
		} as never,
		getSettings: () => ({ deviceName: "OpenAuthority" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => ({
			getTextForPath: (candidate: string) => candidate === path ? ytext : null,
			getFileIdForText: () => "open-file-id",
		}) as never,
		getDiskMirror: () => ({
			recordPreservedUnresolved: (candidate: string, reason: string) => {
				markerRecords.push({ path: candidate, reason });
			},
			suppressLocalCreate: async () => {},
			flushWrite: async (candidate: string) => { flushWrites.push(candidate); },
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => ({
			isBound: () => true,
			captureOpenEditorMutationTicket: () => ({ path, views: [] }),
			validateOpenEditorMutationTicket: () => ({ current: true }),
		}) as never,
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
	const internals = controller as unknown as {
		visibleAuthorityDeferredPaths: Map<string, {
			editorContents: string[];
			readComplete: boolean;
			capturedDiskContent: string;
			capturedCrdtContent: string;
			capturedDiskRevision: number;
			capturedEditorActivity: number | null;
			capturedAt: number;
		}>;
		handleBoundFileSyncGap(
			file: TFile,
			content: string,
			existingText: Y.Text,
			openViews: MarkdownView[],
			reason: "modify",
			stat: { mtime: number; size: number },
		): Promise<{ kind: string }>;
	};
	internals.visibleAuthorityDeferredPaths.set(path, {
		editorContents: [capturedEditorContent],
		readComplete: true,
		capturedDiskContent: diskContent,
		capturedCrdtContent: crdtContent,
		capturedDiskRevision: 0,
		capturedEditorActivity: null,
		capturedAt: Date.now() - 1,
	});
	// No controller activity hook is called between capture and this re-plan.
	liveEditorContent = "later pane candidate without activity event\n";
	const outcome = await internals.handleBoundFileSyncGap(
		file,
		diskContent,
		ytext,
		[view],
		"modify",
		{ mtime: 41, size: diskContent.length },
	);

	const marker = internals.visibleAuthorityDeferredPaths.get(path);
	assertEqual(outcome.kind, "handled", "changed captured authority is handled as unresolved");
	assertEqual(ytext.toString(), crdtContent, "changed pane authority cannot overwrite CRDT");
	assertEqual(flushWrites.length, 0, "changed pane authority cannot write the original disk path");
	assertEqual(diskContent, "disk candidate\n", "changed pane authority leaves original disk bytes intact");
	assert(marker?.readComplete === false, "combined captured/live editor authority is permanently ambiguous");
	assert(
		marker?.editorContents.includes(capturedEditorContent) === true &&
		marker.editorContents.includes(liveEditorContent),
		"both captured and later visible pane candidates remain represented",
	);
	assert(
		[...artifacts.values()].includes(capturedEditorContent) &&
		[...artifacts.values()].includes(liveEditorContent) &&
		[...artifacts.values()].includes(crdtContent),
		"captured, live pane, and CRDT candidates are preserved as artifacts",
	);
	assert(
		markerRecords.some((record) =>
			record.path === path && record.reason === "conflict-winner-flush-deferred"
		),
		"changed pane authority synchronously records durable quarantine",
	);
	controller.reset();
	doc.destroy();
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Controller authority quarantine: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) process.exit(1);
