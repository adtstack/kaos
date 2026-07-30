import * as Y from "yjs";
import { TFile } from "obsidian";
import { VaultSync } from "../src/sync/vaultSync";
import { contentBaselineHash, type DiskIndex } from "../src/sync/diskIndex";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";
import type { FlightEventInput, FlightPathEventInput } from "../src/telemetry/debug/flightEvents";

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

interface CapturedEvent {
	kind: string;
	path: string;
	opId?: string;
	fileId?: string;
	data: Record<string, unknown>;
}

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		opId: (e as { opId?: string }).opId,
		fileId: (e as { fileId?: string }).fileId,
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: (e as { path?: string }).path ?? "",
		opId: (e as { opId?: string }).opId,
		fileId: (e as { fileId?: string }).fileId,
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

function makeTFile(path: string, size: number): TFile {
	const file = new TFile() as TFile & { path: string; stat: { mtime: number; size: number } };
	file.path = path;
	file.stat = { mtime: 1, size };
	return file;
}

function makeVaultSync(onFlightPathEvent: (event: FlightPathEventInput) => void): VaultSync {
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

function buildFixture(opts: {
	oldPath: string;
	oldContent: string;
	newPath: string;
	newContent: string;
	previousDiskIndex?: DiskIndex;
}) {
	const events: CapturedEvent[] = [];
	const flushWrites: string[] = [];
	const attemptedFlushWrites: string[] = [];
	const preservedUnresolved = new Map<string, PreservedUnresolvedEntry>();
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		events.push(asPathEvent(event));
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		events.push(asAnyEvent(event));
	};
	const vaultSync = makeVaultSync(recordFlightPathEvent);
	const initialSeed = vaultSync.ensureFile(opts.oldPath, opts.oldContent, "TestDevice");
	if (initialSeed.kind !== "created") {
		throw new Error("no-event fixture failed to create its initial typed CRDT identity");
	}
	const oldFileId = vaultSync.getFileId(opts.oldPath);
	const eventBoundary = events.length;

	const newFile = makeTFile(opts.newPath, opts.newContent.length);
	const app = {
		vault: {
			getMarkdownFiles: () => [newFile],
			read: async (file: TFile & { path: string }) => {
				if (file.path !== opts.newPath) throw new Error(`unexpected read: ${file.path}`);
				return opts.newContent;
			},
			adapter: {
				stat: async (path: string) => {
					if (path !== opts.newPath) return null;
					return { mtime: 1, size: opts.newContent.length };
				},
			},
			getAbstractFileByPath: (path: string) => path === opts.newPath ? newFile : null,
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};
	const diskMirror = {
		flushWrite: async (path: string) => {
			attemptedFlushWrites.push(path);
			if (preservedUnresolved.has(path)) {
				return { kind: "blocked" as const, path, reason: "preserved-unresolved" as const };
			}
			flushWrites.push(path);
		},
		getPreservedUnresolvedEntries: () =>
			[...preservedUnresolved.values()].map((entry) => ({ ...entry })),
		isPreservedUnresolved: (path: string) => preservedUnresolved.has(path),
		recordPreservedUnresolved: (path: string) => {
			const previous = preservedUnresolved.get(path);
			preservedUnresolved.set(path, {
				path,
				kind: "markdown",
				reason: "path-collision",
				episodeId: previous?.episodeId ?? `no-event:${path}`,
				firstSeenAt: previous?.firstSeenAt ?? 1,
				lastSeenAt: (previous?.lastSeenAt ?? 0) + 1,
				localHash: previous?.localHash ?? null,
				knownRemoteHash: previous?.knownRemoteHash ?? null,
			});
		},
	};
	let diskIndex = opts.previousDiskIndex ?? {};
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
		recordFlightEvent,
		recordFlightPathEvent,
	});

	return {
		controller,
		vaultSync,
		events,
		eventBoundary,
		flushWrites,
		attemptedFlushWrites,
		preservedUnresolved,
		diskMirror,
		oldFileId,
	};
}

console.log("\n--- No-event structural reconcile: baseline continuity stays observation-only ---");
{
	const content = "# A\nsame\n";
	const baselineHash = await contentBaselineHash(content);
	const fx = buildFixture({
		oldPath: "Old/a.md",
		oldContent: content,
		newPath: "New/a.md",
		newContent: content,
		previousDiskIndex: {
			"Old/a.md": {
				mtime: 1,
				size: content.length,
				contentHash: baselineHash,
			},
		},
	});

	await fx.controller.runReconciliation("authoritative");
	const events = fx.events.slice(fx.eventBoundary);

	assert(fx.vaultSync.getTextForPath("Old/a.md") !== null, "old CRDT identity is not moved by an async scan");
	assert(fx.vaultSync.getTextForPath("New/a.md") === null, "new disk path is not assigned the old identity");
	assertEq(fx.vaultSync.getFileId("Old/a.md"), fx.oldFileId, "old path retains its original file ID");
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "rename-crdt-path-to-disk"
		).length,
		0,
		"baseline hash continuity never authorizes an automatic identity move",
	);
	assertEq(
		events.filter((event) => event.kind === "crdt.file.created" && event.path === "New/a.md").length,
		0,
		"new path is not admitted with a new identity",
	);
	assertEq(fx.flushWrites.length, 0, "old path is not recreated while the pair is unresolved");
	assert(
		fx.preservedUnresolved.has("Old/a.md") && fx.preservedUnresolved.has("New/a.md"),
		"no-event collision durably quarantines both old and new paths",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "unresolved-ambiguous-structural-change"
		).length,
		1,
		"baseline-backed candidate is surfaced as unresolved",
	);
	assertEq(fx.controller.getState().unresolvedStructuralChangeCount, 2, "both paths require explicit resolution");

	const providerFlush = await fx.diskMirror.flushWrite("Old/a.md");
	assert(
		providerFlush?.kind === "blocked" && providerFlush.reason === "preserved-unresolved",
		"a later provider flush is hard-blocked by the durable old-path marker",
	);
	assertEq(fx.flushWrites.length, 0, "blocked provider flush cannot recreate the old path");
	(fx.controller as unknown as { lastReconcileTime: number }).lastReconcileTime = 0;
	await fx.controller.runReconciliation("authoritative");
	assert(fx.vaultSync.getTextForPath("Old/a.md") !== null, "later reconcile retains the old CRDT candidate");
	assert(fx.vaultSync.getTextForPath("New/a.md") === null, "later reconcile cannot seed the quarantined new path");
	assertEq(fx.flushWrites.length, 0, "later reconcile cannot recreate either quarantined path");
	assertEq(fx.attemptedFlushWrites.length, 1, "later reconcile does not even enqueue another quarantined flush");
	assert(
		fx.preservedUnresolved.has("Old/a.md") && fx.preservedUnresolved.has("New/a.md"),
		"later reconcile retains both collision episodes",
	);
}

console.log("\n--- No-event structural reconcile: moved markdown without evidence is unresolved ---");
{
	const fx = buildFixture({
		oldPath: "Old/a.md",
		oldContent: "# A\nsame\n",
		newPath: "New/a.md",
		newContent: "# A\nsame\n",
	});

	await fx.controller.runReconciliation("authoritative");
	const events = fx.events.slice(fx.eventBoundary);

	assert(fx.vaultSync.getTextForPath("Old/a.md") !== null, "old CRDT path remains until user resolves");
	assert(fx.vaultSync.getTextForPath("New/a.md") === null, "new path is not silently bound to old fileId");
	assertEq(fx.flushWrites.length, 0, "old path was not recreated on disk");
	assertEq(
		events.filter((event) => event.kind === "crdt.file.created" && event.path === "New/a.md").length,
		0,
		"new path was not admitted as a create",
	);
	assertEq(
		events.filter((event) => event.kind === "crdt.file.renamed" && event.path === "New/a.md").length,
		0,
		"no rename event emitted without rename evidence",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "unresolved-ambiguous-structural-change" &&
			Array.isArray(event.data.oldPaths) &&
			event.data.oldPaths.includes("Old/a.md") &&
			Array.isArray(event.data.newPaths) &&
			event.data.newPaths.includes("New/a.md")
		).length,
		1,
		"reconcile decision emitted for unresolved structural change",
	);
	assertEq(fx.controller.getState().lastReconcileStats?.plannedCreates, 0, "no disk create planned");
	assertEq(fx.controller.getState().unresolvedStructuralChangeCount, 2, "old and new paths counted as unresolved");
}

console.log("\n--- No-event structural reconcile: same template daily notes are independent files ---");
{
	const fx = buildFixture({
		oldPath: "Journal/2026-06-25.md",
		oldContent: "# Daily\n\n",
		newPath: "Journal/2026-06-26.md",
		newContent: "# Daily\n\n",
	});

	await fx.controller.runReconciliation("authoritative");
	const events = fx.events.slice(fx.eventBoundary);

	assert(fx.vaultSync.getTextForPath("Journal/2026-06-25.md") !== null, "old daily note remains in CRDT");
	assert(fx.vaultSync.getTextForPath("Journal/2026-06-26.md") !== null, "new daily note is admitted separately");
	assertEq(fx.vaultSync.getFileId("Journal/2026-06-25.md"), fx.oldFileId, "old daily note keeps its file ID");
	assert(
		fx.vaultSync.getFileId("Journal/2026-06-26.md") !== fx.oldFileId,
		"new daily note gets a distinct file ID",
	);
	assert(
		fx.flushWrites.includes("Journal/2026-06-25.md"),
		"old daily note may be restored to disk, not renamed into the new date",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "rename-crdt-path-to-disk"
		).length,
		0,
		"no inferred rename decision emitted",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "unresolved-ambiguous-structural-change"
		).length,
		0,
		"no structural conflict decision emitted",
	);
	assertEq(
		events.filter((event) => event.kind === "crdt.file.created" && event.path === "Journal/2026-06-26.md").length,
		1,
		"new daily note is admitted as a create",
	);
	assertEq(fx.controller.getState().unresolvedStructuralChangeCount, 0, "no unresolved structural changes");
}

console.log("\n--- No-event structural reconcile: moved and edited markdown is unresolved ---");
{
	const fx = buildFixture({
		oldPath: "Old/a.md",
		oldContent: "# A\nold\n",
		newPath: "New/a.md",
		newContent: "# A\nnew\n",
	});

	await fx.controller.runReconciliation("authoritative");
	const events = fx.events.slice(fx.eventBoundary);

	assert(fx.vaultSync.getTextForPath("Old/a.md") !== null, "old CRDT path remains until user resolves");
	assert(fx.vaultSync.getTextForPath("New/a.md") === null, "new path is not silently seeded");
	assertEq(fx.flushWrites.length, 0, "old path was not recreated while unresolved");
	assertEq(
		events.filter((event) => event.kind === "crdt.file.created" && event.path === "New/a.md").length,
		0,
		"unresolved new path was not created in CRDT",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "unresolved-ambiguous-structural-change" &&
			event.data.reason === "content-diverged-same-basename"
		).length,
		1,
		"unresolved structural decision emitted",
	);
	assertEq(fx.controller.getState().unresolvedStructuralChangeCount, 2, "old and new paths counted as needing attention");
}

console.log(`\nno-event-structural-reconcile: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
