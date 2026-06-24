import * as Y from "yjs";
import { TFile } from "obsidian";
import { VaultSync } from "../src/sync/vaultSync";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { FlightEventInput, FlightPathEventInput } from "../src/telemetry/debug/flightEvents";

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
}) {
	const events: CapturedEvent[] = [];
	const flushWrites: string[] = [];
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		events.push(asPathEvent(event));
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		events.push(asAnyEvent(event));
	};
	const vaultSync = makeVaultSync(recordFlightPathEvent);
	vaultSync.ensureFile(opts.oldPath, opts.oldContent, "TestDevice");
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
			flushWrites.push(path);
		},
	};
	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror as never,
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
		recordFlightEvent,
		recordFlightPathEvent,
	});

	return { controller, vaultSync, events, eventBoundary, flushWrites, oldFileId };
}

console.log("\n--- No-event structural reconcile: moved markdown is CRDT rename ---");
{
	const fx = buildFixture({
		oldPath: "Old/a.md",
		oldContent: "# A\nsame\n",
		newPath: "New/a.md",
		newContent: "# A\nsame\n",
	});

	await fx.controller.runReconciliation("authoritative");
	const events = fx.events.slice(fx.eventBoundary);

	assert(fx.vaultSync.getTextForPath("Old/a.md") === null, "old CRDT path removed");
	assert(fx.vaultSync.getTextForPath("New/a.md") !== null, "new CRDT path exists");
	assertEq(fx.vaultSync.getTextForPath("New/a.md")?.toString(), "# A\nsame\n", "new CRDT content preserved");
	assertEq(fx.vaultSync.getFileId("New/a.md"), fx.oldFileId, "file ID preserved across inferred rename");
	assertEq(fx.flushWrites.length, 0, "old path was not recreated on disk");
	assertEq(
		events.filter((event) => event.kind === "crdt.file.created" && event.path === "New/a.md").length,
		0,
		"new path was not admitted as a create",
	);
	assertEq(
		events.filter((event) => event.kind === "crdt.file.renamed" && event.path === "New/a.md").length,
		1,
		"crdt.file.renamed emitted for new path",
	);
	assertEq(
		events.filter((event) =>
			event.kind === "reconcile.file.decision" &&
			event.data.decision === "rename-crdt-path-to-disk" &&
			event.data.oldPath === "Old/a.md" &&
			event.data.newPath === "New/a.md"
		).length,
		1,
		"reconcile decision emitted for inferred rename",
	);
	assertEq(fx.controller.getState().lastReconcileStats?.plannedCreates, 0, "no disk create planned");
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
