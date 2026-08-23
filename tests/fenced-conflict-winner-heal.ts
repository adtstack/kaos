/**
 * Fenced conflict-winner-flush-deferred heal + fresh-event discard guard.
 *
 * Production incident (2026-08-21 audit trail): a closed daily journal with a
 * conflict-winner-flush-deferred episode was fenced forever — reconcile skips
 * the path, so remote edits never flushed to disk, and a later local disk
 * event could unconditionally discard the CRDT side (reason
 * "preserved-unresolved-fresh-local-event"), deleting unseen edits globally.
 *
 * Asserts:
 *   - a fresh disk event may NOT discard a CRDT side that diverged from the
 *     durable baseline (the divergence can be unflushed remote/pre-close
 *     edits); the episode stays fenced with a named trace.
 *   - reconcile-time heal resolves the three provably lossless shapes:
 *       equal sides, CRDT-at-baseline (disk wins), disk-at-baseline
 *       (deferred CRDT-wins flush completes).
 *   - both-sides-moved and non-healable reasons keep the fence without
 *     touching either side.
 *   - with no baseline there is no divergence evidence to protect: the
 *     fresh disk event still resolves the episode (new-file behavior).
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

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

interface HealFixture {
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
	setEpisode(reason: PreservedUnresolvedReason): void;
	getEpisode(): PreservedUnresolvedEntry | null;
	getDiskIndex(): DiskIndex;
	setFlushWriteMidFlightMutator(mutator: (() => void) | null): void;
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
	vs._device = "HealFixture";
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

function makeHealFixture(init: {
	crdt: string;
	disk: string;
	baseline: string | null;
}): HealFixture {
	const path = "JOURNALS/daily.md";
	let diskContent = init.disk;
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
	const seed = vaultSync.ensureFile(path, init.crdt, "HealFixture");
	if (seed.kind !== "created") {
		throw new Error("heal fixture failed to seed its CRDT identity");
	}
	const doc = vaultSync.ydoc;
	const ytext = vaultSync.getTextForPath(path);
	if (!ytext) throw new Error("heal fixture failed to locate its Y.Text");

	const file = makeTFile(path, diskContent);
	let entry: PreservedUnresolvedEntry | null = null;
	let episodeSequence = 0;
	let flushWriteMidFlightMutator: (() => void) | null = null;
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
			getMarkdownFiles: () => [file],
			read: async (candidate: TFile & { path: string }) => {
				if (candidate.path === path) return diskContent;
				throw new Error(`unexpected read: ${candidate.path}`);
			},
			adapter: {
				stat: async (candidate: string) => {
					if (candidate !== path) return null;
					return { mtime: 21, size: diskContent.length };
				},
			},
			getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
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
			const content = ytext.toString();
			flushWriteCalls.push({ path: candidate, content });
			diskContent = content;
			flushWriteMidFlightMutator?.();
			return {
				kind: "written" as const,
				path: candidate,
				isCreate: false,
				content,
				contentHash: baselineHashSync(content),
				baselineRecorded: true,
			};
		},
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "HealFixture" }) as never,
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
			traces.push({ source: _source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
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
		setEpisode: (reason: PreservedUnresolvedReason) => {
			episodeSequence++;
			entry = {
				path,
				kind: "markdown",
				reason,
				episodeId: `heal-fixture-${episodeSequence}`,
				firstSeenAt: 1,
				lastSeenAt: 1,
				localHash: null,
				knownRemoteHash: null,
			};
		},
		getEpisode: () => entry ? { ...entry } : null,
		getDiskIndex: () => diskIndex,
		setFlushWriteMidFlightMutator: (mutator: (() => void) | null) => {
			flushWriteMidFlightMutator = mutator;
		},
		reset: () => {
			clearControllerTimers(controller);
			doc.destroy();
		},
	};
}

const BASELINE = "settled baseline bytes\n";
const REMOTE_EDITS = "baseline + unseen remote edits\n";
const LOCAL_EDITS = "baseline + local disk edits\n";

console.log("\n--- Fenced heal: fresh disk event cannot discard a CRDT side that diverged from baseline ---");
{
	const fx = makeHealFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	const episodeBefore = fx.getEpisode();
	fx.controller.markMarkdownDirty(fx.file, "modify", "op-ambiguous-disk-event");
	await drainDirtyMarkdown(fx.controller);

	assertEq(fx.ytext.toString(), REMOTE_EDITS, "diverged CRDT side survives a fresh disk event");
	assertEq(fx.getDiskContent(), LOCAL_EDITS, "disk side survives a fresh disk event");
	assert(
		fx.getEpisode() !== null &&
		getPreservedUnresolvedEpisodeId(fx.getEpisode()!) ===
			getPreservedUnresolvedEpisodeId(episodeBefore!),
		"ambiguous episode stays fenced",
	);
	assert(
		!fx.discarded.some((record) => record.reason === "preserved-unresolved-fresh-local-event"),
		"no fresh-event discard audit is emitted for the diverged CRDT side",
	);
	assert(
		fx.traces.some((trace) => trace.msg === "preserved-unresolved-local-resolution-crdt-diverged"),
		"guard deferral emits the crdt-diverged trace",
	);
	fx.reset();
}

console.log("\n--- Fenced heal: no baseline keeps the fresh disk event resolvable (new-file shape) ---");
{
	const fx = makeHealFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: null });
	fx.setEpisode("conflict-winner-flush-deferred");
	fx.controller.markMarkdownDirty(fx.file, "modify", "op-new-file-event");
	await drainDirtyMarkdown(fx.controller);

	assertEq(fx.ytext.toString(), LOCAL_EDITS, "no-baseline episode still converges to local bytes");
	assert(
		fx.discarded.some((record) => record.reason === "preserved-unresolved-fresh-local-event"),
		"no-baseline resolution still audits the losing CRDT side",
	);
	assert(fx.getEpisode() === null, "no-baseline episode resolves");
	fx.reset();
}

console.log("\n--- Fenced heal: CRDT at baseline imports the newer disk side on reconcile ---");
{
	const fx = makeHealFixture({ crdt: BASELINE, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	await fx.controller.runReconciliation("authoritative");

	assertEq(fx.ytext.toString(), LOCAL_EDITS, "stale-at-baseline CRDT converges to disk bytes");
	assert(fx.getEpisode() === null, "episode is cleared after the guarded import");
	assertEq(
		fx.getDiskIndex()[fx.path]?.contentHash,
		await contentBaselineHash(LOCAL_EDITS),
		"baseline advances to the imported disk content",
	);
	assertEq(fx.getDiskContent(), LOCAL_EDITS, "disk content is untouched by the import");
	fx.reset();
}

console.log("\n--- Fenced heal: disk at baseline completes the deferred CRDT-wins flush ---");
{
	const fx = makeHealFixture({ crdt: REMOTE_EDITS, disk: BASELINE, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	await fx.controller.runReconciliation("authoritative");

	assertEq(fx.getDiskContent(), REMOTE_EDITS, "untouched disk receives the CRDT winner");
	assert(fx.getEpisode() === null, "episode is cleared after the winner flush");
	assertEq(fx.ytext.toString(), REMOTE_EDITS, "CRDT side is unchanged by its own winning flush");
	assert(
		fx.traces.some((trace) => trace.msg === "fenced-conflict-winner-healed-flush"),
		"flush heal emits its trace marker",
	);
	fx.reset();
}

console.log("\n--- Fenced heal: already-equal sides settle and clear the fence ---");
{
	const fx = makeHealFixture({ crdt: BASELINE, disk: BASELINE, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	await fx.controller.runReconciliation("authoritative");

	assert(fx.getEpisode() === null, "equal-content episode is cleared");
	assert(
		fx.traces.some((trace) => trace.msg === "fenced-conflict-winner-healed-equal"),
		"equal heal emits its trace marker",
	);
	assertEq(fx.flushWriteCalls.length, 0, "equal heal performs no disk write");
	fx.reset();
}

console.log("\n--- Fenced heal: a CRDT advance during the winner flush is not re-fenced ---");
{
	const fx = makeHealFixture({ crdt: REMOTE_EDITS, disk: BASELINE, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	const RACING_EDIT = "racing remote edit\n";
	fx.setFlushWriteMidFlightMutator(() => {
		fx.ytext.insert(0, RACING_EDIT);
	});
	await fx.controller.runReconciliation("authoritative");

	assertEq(fx.getDiskContent(), REMOTE_EDITS, "flush commits the pre-race CRDT snapshot");
	assert(fx.getEpisode() === null, "episode clears despite the mid-flush CRDT advance");
	assertEq(
		fx.getDiskIndex()[fx.path]?.contentHash,
		baselineHashSync(REMOTE_EDITS),
		"baseline records the committed snapshot, not the live post-race text",
	);
	assertEq(fx.ytext.toString(), RACING_EDIT + REMOTE_EDITS, "racing edit survives in the CRDT");
	fx.setFlushWriteMidFlightMutator(null);
	(fx.controller as unknown as { lastReconcileTime: number }).lastReconcileTime = 0;
	await fx.controller.runReconciliation("authoritative");
	assertEq(
		fx.getDiskContent(),
		RACING_EDIT + REMOTE_EDITS,
		"racing edit reaches disk through the normal lane on the next pass",
	);
	fx.reset();
}

console.log("\n--- Fenced heal: both sides moved keeps the fence on reconcile ---");
{
	const fx = makeHealFixture({ crdt: REMOTE_EDITS, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("conflict-winner-flush-deferred");
	await fx.controller.runReconciliation("authoritative");

	assertEq(fx.ytext.toString(), REMOTE_EDITS, "reconcile does not wipe the diverged CRDT side");
	assertEq(fx.getDiskContent(), LOCAL_EDITS, "reconcile does not rewrite the diverged disk side");
	assert(fx.getEpisode() !== null, "ambiguous episode stays fenced on reconcile");
	assert(
		fx.traces.some((trace) => trace.msg === "fenced-conflict-winner-kept-ambiguous"),
		"ambiguous fence emits its trace marker",
	);
	assertEq(fx.flushWriteCalls.length, 0, "ambiguous fence performs no disk write");
	fx.reset();
}

console.log("\n--- Fenced heal: non-healable reasons are never touched ---");
{
	const fx = makeHealFixture({ crdt: BASELINE, disk: LOCAL_EDITS, baseline: BASELINE });
	fx.setEpisode("path-collision");
	await fx.controller.runReconciliation("authoritative");

	assertEq(fx.ytext.toString(), BASELINE, "path-collision episode is never healed");
	assert(fx.getEpisode() !== null, "path-collision episode remains");
	assert(
		!fx.traces.some((trace) => trace.msg.startsWith("fenced-conflict-winner-")),
		"no heal traces fire for non-healable reasons",
	);
	fx.reset();
}

console.log(`\nfenced-conflict-winner-heal: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exitCode = 1;
}
