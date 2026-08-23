/**
 * Markdown conflict dashboard manual resolution + intent restoration regression suite.
 *
 * Asserts:
 *   - Manual resolution "keep-local" promotes the local disk content to CRDT,
 *     updates durable baseline, records discarded revision for previous CRDT,
 *     and clears the preserved unresolved entry.
 *   - Manual resolution "use-remote" flushes the remote CRDT content to disk,
 *     updates durable baseline, records discarded revision for previous disk,
 *     and clears the preserved unresolved entry.
 *   - Stale episode identity rejects resolution to prevent resolving replacement incidents.
 *   - PendingBlobIntentJournal.restore recovers an intent in memory on persistence rollback.
 *   - buildKaosDashboardData exposes markdown-conflict resolution for fenced markdown entries.
 */

import { createHash } from "node:crypto";
import { TFile } from "obsidian";
import * as Y from "yjs";
import { VaultSync } from "../src/sync/vaultSync";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import {
	getPreservedUnresolvedEpisodeId,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
} from "../src/sync/preservedUnresolved";
import type { FlightEventInput, FlightPathEventInput } from "../src/telemetry/debug/flightEvents";
import { PendingBlobIntentJournal } from "../src/sync/pendingBlobIntentJournal";
import { buildKaosDashboardData } from "../src/dashboard/dashboardData";
import type { KaosDashboardCollectorInput } from "../src/dashboard/dashboardTypes";
import type { DiskWriteOptions } from "../src/sync/diskMirror";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: true,
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

function baselineHashSync(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeTFile(path: string, content: string): TFile {
	const file = new TFile() as TFile & {
		path: string;
		stat: { mtime: number; size: number };
	};
	file.path = path;
	file.stat = { mtime: 21, size: content.length };
	return file;
}

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

interface ResolutionFixture {
	path: string;
	file: TFile;
	doc: Y.Doc;
	ytext: Y.Text;
	controller: ReconciliationController;
	traces: CapturedTrace[];
	discarded: Array<{ path: string; contentHash: string; reason: string }>;
	flushWriteCalls: Array<{ path: string; content: string }>;
	setDiskContent(content: string): void;
	getDiskContent(): string;
	deleteLocalFile(): void;
	setEpisode(reason: PreservedUnresolvedReason): void;
	getEpisode(): PreservedUnresolvedEntry | null;
	getDiskIndex(): DiskIndex;
	reset(): void;
}

function makeVaultSync(
	onFlightPathEvent: (event: FlightPathEventInput) => void,
): VaultSync {
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
	vs._device = "ResolutionFixture";
	vs.serverAckTracker = {
		withActiveOpId: (_opId: string | undefined, work: () => unknown) => work(),
	};
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightEvent = undefined;
	vs.onFlightPathEvent = onFlightPathEvent;
	vs.provider = { wsconnected: true };
	return vs as VaultSync;
}

function makeResolutionFixture(init: {
	crdt: string;
	disk: string;
	baseline: string | null;
}): ResolutionFixture {
	const path = "JOURNALS/manual-resolve.md";
	let diskContent = init.disk;
	let fileExists = true;
	const traces: CapturedTrace[] = [];
	const discarded: Array<{ path: string; contentHash: string; reason: string }> = [];
	const flushWriteCalls: Array<{ path: string; content: string }> = [];
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		void event;
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		void event;
	};
	const vaultSync = makeVaultSync(recordFlightPathEvent);
	const seed = vaultSync.ensureFile(path, init.crdt, "ResolutionFixture");
	if (seed.kind !== "created") {
		throw new Error("fixture failed to seed its CRDT identity");
	}
	const doc = vaultSync.ydoc;
	const ytext = vaultSync.getTextForPath(path);
	if (!ytext) throw new Error("fixture failed to locate its Y.Text");

	const file = makeTFile(path, diskContent);
	let entry: PreservedUnresolvedEntry | null = null;
	let episodeSequence = 0;
	let diskIndex: DiskIndex = init.baseline === null
		? {}
		: {
			[path]: {
				mtime: 1,
				size: init.baseline.length,
				contentHash: baselineHashSync(init.baseline),
			},
		};

	const app = {
		vault: {
			getMarkdownFiles: () => fileExists ? [file] : [],
			read: async (candidate: TFile & { path: string }) => {
				if (candidate.path === path && fileExists) return diskContent;
				throw new Error(`unexpected read: ${candidate.path}`);
			},
			adapter: {
				stat: async (candidate: string) => {
					if (candidate !== path || !fileExists) return null;
					return { mtime: 21, size: diskContent.length };
				},
			},
			getAbstractFileByPath: (candidate: string) => candidate === path && fileExists ? file : null,
		},
		workspace: { iterateAllLeaves: () => {} },
	};

	const diskMirror = {
		getPreservedUnresolvedEntries: () => entry ? [{ ...entry }] : [],
		isPreservedUnresolved: (candidate: string) => candidate === path && entry !== null,
		clearPreservedUnresolved: (candidate: string) => {
			if (candidate === path) entry = null;
		},
		recordPreservedUnresolved: () => {},
		shouldSuppressCreate: async () => false,
		shouldSuppressModify: async () => false,
		suppressLocalCreate: async () => {},
		flushWrite: async (candidate: string, _force?: boolean, options?: DiskWriteOptions) => {
			if (candidate !== path) {
				return { kind: "failed" as const, path: candidate, error: "unexpected path" };
			}
			const activeEpisodeId = entry ? getPreservedUnresolvedEpisodeId(entry) : null;
			if (entry !== null && options?.expectedPreservedUnresolvedEpisodeId !== activeEpisodeId) {
				return { kind: "blocked" as const, path: candidate, reason: "preserved-unresolved" };
			}
			if (!fileExists && options?.allowCreateIfMissing !== true) {
				return { kind: "deferred" as const, path: candidate, reason: "expected-existing-now-missing" };
			}
			const wasCreate = !fileExists;
			fileExists = true;
			const content = ytext.toString();
			flushWriteCalls.push({ path: candidate, content });
			diskContent = content;
			return {
				kind: "written" as const,
				path: candidate,
				isCreate: wasCreate,
				content,
				contentHash: baselineHashSync(content),
				baselineRecorded: true,
			};
		},
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "ResolutionFixture" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 1,
			excludePatterns: [],
		}) as never,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: DiskIndex) => { diskIndex = next; },
		recordBaselineText: () => {},
		recordDiscardedRevision: (p: string, contentHash: string, reason: string) => {
			discarded.push({ path: p, contentHash, reason });
		},
		shouldBlockFrontmatterIngest: () => false,
		onReconciled: () => {},
		onReconcileSkipped: () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		log: () => {},
		isMarkdownPathSyncable: () => true,
		isLocalSafetyArtifactPath: () => false,
		isConflictArtifactPath: () => false,
		saveDiskIndex: async () => {},
	});

	return {
		path,
		file,
		doc,
		ytext,
		controller,
		traces,
		discarded,
		flushWriteCalls,
		setDiskContent: (content: string) => { diskContent = content; },
		getDiskContent: () => diskContent,
		deleteLocalFile: () => { fileExists = false; },
		setEpisode: (reason: PreservedUnresolvedReason) => {
			episodeSequence++;
			entry = {
				path,
				kind: "markdown",
				reason,
				episodeId: `resolve-fixture-${episodeSequence}`,
				firstSeenAt: 1,
				lastSeenAt: 1,
				localHash: null,
				knownRemoteHash: null,
			};
		},
		getEpisode: () => entry ? { ...entry } : null,
		getDiskIndex: () => diskIndex,
		reset: () => {
			doc.destroy();
		},
	};
}

const BASELINE = "settled baseline bytes\n";
const REMOTE_EDITS = "baseline + unseen remote edits\n";
const LOCAL_EDITS = "baseline + local disk edits\n";

console.log("\n--- Manual Resolution: Keep Local version promotes disk to CRDT and clears fence ---");
{
	const fx = makeResolutionFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	const ep = fx.getEpisode()!;

	await fx.controller.resolveMarkdownConflictAttention(fx.path, "keep-local", {
		reason: ep.reason,
		episodeId: ep.episodeId,
	});

	assertEq(fx.ytext.toString(), LOCAL_EDITS, "Y.Text updated to match local disk edits");
	assertEq(fx.getDiskContent(), LOCAL_EDITS, "disk content preserved");
	assertEq(fx.getEpisode(), null, "preserved unresolved entry cleared");
	assertEq(
		fx.getDiskIndex()[fx.path]?.contentHash,
		baselineHashSync(LOCAL_EDITS),
		"durable baseline updated to local disk hash",
	);
	assert(
		fx.traces.some((t) => t.msg === "markdown-conflict-resolved-manual-keep-local"),
		"emitted keep-local resolution trace",
	);
	assert(
		fx.discarded.some((d) => d.reason === "manual-conflict-keep-local"),
		"recorded discarded revision audit for previous remote CRDT content",
	);
	fx.reset();
}

console.log("\n--- Manual Resolution: Use Remote copy flushes CRDT to disk and clears fence ---");
{
	const fx = makeResolutionFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	const ep = fx.getEpisode()!;

	await fx.controller.resolveMarkdownConflictAttention(fx.path, "use-remote", {
		reason: ep.reason,
		episodeId: ep.episodeId,
	});

	assertEq(fx.getDiskContent(), REMOTE_EDITS, "disk content updated to remote CRDT edits");
	assertEq(fx.ytext.toString(), REMOTE_EDITS, "Y.Text unchanged");
	assertEq(fx.getEpisode(), null, "preserved unresolved entry cleared");
	assertEq(
		fx.getDiskIndex()[fx.path]?.contentHash,
		baselineHashSync(REMOTE_EDITS),
		"durable baseline updated to remote CRDT hash",
	);
	assert(
		fx.traces.some((t) => t.msg === "markdown-conflict-resolved-manual-use-remote"),
		"emitted use-remote resolution trace",
	);
	assert(
		fx.discarded.some((d) => d.reason === "manual-conflict-use-remote"),
		"recorded discarded revision audit for previous local disk content",
	);
	fx.reset();
}

console.log("\n--- Manual Resolution: Use Remote copy recreates missing local file and clears fence ---");
{
	const fx = makeResolutionFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.deleteLocalFile();
	fx.setEpisode("conflict-winner-flush-deferred");
	const ep = fx.getEpisode()!;

	await fx.controller.resolveMarkdownConflictAttention(fx.path, "use-remote", {
		reason: ep.reason,
		episodeId: ep.episodeId,
	});

	assertEq(fx.getDiskContent(), REMOTE_EDITS, "disk content restored from remote CRDT edits");
	assertEq(fx.ytext.toString(), REMOTE_EDITS, "Y.Text unchanged");
	assertEq(fx.getEpisode(), null, "preserved unresolved entry cleared");
	assert(
		fx.traces.some((t) => t.msg === "markdown-conflict-resolved-manual-use-remote"),
		"emitted use-remote resolution trace for recreated file",
	);
	fx.reset();
}

console.log("\n--- Manual Resolution: Stale episode ID rejects resolution ---");
{
	const fx = makeResolutionFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");

	let rejected = false;
	try {
		await fx.controller.resolveMarkdownConflictAttention(fx.path, "keep-local", {
			reason: "conflict-winner-flush-deferred",
			episodeId: "stale-episode-999",
		});
	} catch {
		rejected = true;
	}

	assert(rejected, "stale episode resolution was rejected");
	assert(fx.getEpisode() !== null, "episode remains fenced");
	assertEq(fx.ytext.toString(), REMOTE_EDITS, "Y.Text unchanged on rejection");
	assertEq(fx.getDiskContent(), LOCAL_EDITS, "disk content unchanged on rejection");
	fx.reset();
}

console.log("\n--- PendingBlobIntentJournal restore enables in-memory rollback ---");
{
	const journal = new PendingBlobIntentJournal();
	const scope = { host: "example.com", vaultId: "v1", localDeviceId: "d1" };
	const intent = journal.recordDelete("attachments/photo.png", scope, { known: true });
	assertEq(journal.size, 1, "intent recorded in journal");

	journal.remove(intent.id);
	assertEq(journal.size, 0, "intent removed from journal");

	journal.restore(intent);
	assertEq(journal.size, 1, "intent restored to journal");
	assertEq(journal.getEntries()[0]?.id, intent.id, "restored intent preserves identity");
}

console.log("\n--- Dashboard data generates markdown-conflict resolution for fenced entries ---");
{
	const file = makeTFile("Notes/conflict.md", LOCAL_EDITS);
	const collectorInput: KaosDashboardCollectorInput = {
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => p === "Notes/conflict.md" ? file : null,
				getFiles: () => [file],
				getMarkdownFiles: () => [file],
			},
		} as never,
		generatedAt: new Date().toISOString(),
		settings: { deviceName: "TestDevice" } as never,
		syncStatusLabel: "Connected",
		connectionLabel: "Active",
		connectionTone: "ok",
		reconciliationState: {
			status: "idle",
			mode: "authoritative",
			inProgress: false,
			unresolvedStructuralChangePaths: [],
			unresolvedStructuralChangeSample: [],
		} as never,
		vaultSync: null,
		diskMirror: null,
		blobSync: null,
		preservedUnresolvedEntries: [
			{
				path: "Notes/conflict.md",
				kind: "markdown",
				reason: "conflict-winner-flush-deferred",
				episodeId: "ep-123",
				firstSeenAt: 1000,
				lastSeenAt: 1000,
				localHash: null,
				knownRemoteHash: null,
			},
		],
		remoteDeleteResolutionState: {
			markdownAvailable: true,
			blobAvailable: true,
			getFingerprint: () => null,
			isKeepLocalPending: () => false,
			getBlobRef: () => null,
		},
		frontmatterQuarantineEntries: [],
		diskIndex: {},
		snapshotStatus: { status: "ready", summary: {} as never },
		recoveryStorageStatus: { storageAvailable: true, databaseSize: 0 } as never,
		recentChanges: { status: "ready", items: [] } as never,
		openFileCount: 0,
		snapshotsAvailable: true,
	};

	const data = buildKaosDashboardData(collectorInput);
	assertEq(data.attention.length, 1, "attention item generated");
	const resolution = data.attention[0]?.resolution;
	assert(resolution !== null, "resolution is populated");
	assertEq(resolution?.kind, "markdown-conflict", "resolution kind is markdown-conflict");
	if (resolution?.kind === "markdown-conflict") {
		assertEq(resolution.canKeepLocal, true, "canKeepLocal is enabled");
		assertEq(resolution.canUseRemote, true, "canUseRemote is enabled");
	}
}

console.log(`\nmarkdown-conflict-dashboard-resolution: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exitCode = 1;
}
