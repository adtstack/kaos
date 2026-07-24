/**
 * Controller-level recovery orchestration test.
 *
 * Drives a localOnly three-way divergence (editor==disk, ≠ CRDT) end-to-end
 * through ReconciliationController and asserts:
 *   - the recovery.* flight-event timeline
 *   - editor.repair.applied fires once per affected view
 *   - editor.heal.applied does NOT fire
 *   - second-pass on a converged file emits recovery.skipped (crdt-current-no-op)
 *   - bound recovery write does not round-trip as a disk.write.* event
 *   - third identical attempt is quarantined (recovery.quarantined +
 *     recovery.loop.detected) without recovery.apply.*
 *   - ORIGIN_DISK_SYNC_RECOVER_BOUND is in LOCAL_STRING_ORIGIN_SET (the
 *     guard that makes round-trip suppression work)
 *
 * Plus targeted source-grep regressions on src/sync/editorBinding.ts
 * verifying that the real EditorBindingManager emits editor.repair.applied
 * from applyBinding() (action==="repair") and editor.heal.applied from
 * heal() after applyDiffToYText.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type MarkdownDirtyReason,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import { contentBaselineHash } from "../src/sync/diskIndex";
import {
	FLIGHT_KIND,
	FLIGHT_TAXONOMY_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
} from "../src/sync/origins";

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

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

function baselineHashSync(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

interface CapturedEvent {
	kind: string;
	path: string;
	data: Record<string, unknown>;
	priority: string;
	severity: string;
	source: string;
	layer: string;
}

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path ?? "",
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

// -------------------------------------------------------------------
// Test fixture builder
// -------------------------------------------------------------------

interface Fixture {
	path: string;
	file: TFile;
	view: MarkdownView;
	views: MarkdownView[];
	doc: Y.Doc;
	ytext: Y.Text;
	captured: CapturedEvent[];
	traces: CapturedTrace[];
	repairCalls: Array<{ deviceName: string; reason: string }>;
	transactionOrigins: unknown[];
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setBound(value: boolean): void;
	setOpen(value: boolean): void;
	setExternalEditPolicy(policy: "always" | "closed-only" | "never"): void;
	setBaselineContent(content: string): void;
	clearDiskIndex(): void;
	getCreatedFiles(): Map<string, string>;
	getCurrentDiskContent(): string;
	getDiskIndexContentHash(): string | undefined;
	getFlushWriteCalls(): string[];
	getPreservedUnresolvedCalls(): Array<{ path: string; reason: string }>;
	getConflictOperationOrder(): string[];
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
	additionalEditors?: Array<string | { readError: true }>;
}): Fixture {
	const path = initial.path;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let isBound = true;
	let isOpen = true;
	let externalEditPolicy: "always" | "closed-only" | "never" = "always";
	let diskIngestPort: DiskIngestPort | null = null;
	const createdFiles = new Map<string, string>();
	const flushWriteCalls: string[] = [];
	const preservedUnresolvedCalls: Array<{ path: string; reason: string }> = [];
	const conflictOperationOrder: string[] = [];
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {
		[path]: {
			mtime: 0,
			size: initial.crdt.length,
			contentHash: baselineHashSync(initial.crdt),
		},
	};

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };
	const additionalViews = (initial.additionalEditors ?? []).map((candidate, index) => {
		const additionalView = new MarkdownView() as MarkdownView & {
			file: TFile;
			editor: { getValue(): string };
		};
		additionalView.file = file;
		additionalView.editor = {
			getValue: () => {
				if (typeof candidate !== "string") {
					throw new Error(`editor read failed for fixture pane ${index + 2}`);
				}
				return candidate;
			},
		};
		return additionalView as MarkdownView;
	});
	const views = [view as MarkdownView, ...additionalViews];

	const captured: CapturedEvent[] = [];
	const traces: CapturedTrace[] = [];
	const repairCalls: Array<{ deviceName: string; reason: string }> = [];
	const transactionOrigins: unknown[] = [];

	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
	});

	// Path-scoped flight event capture (used by the controller and the
	// editorBindings stub). Mirrors what main.ts wires through
	// recordFlightPathEvent.
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		captured.push(asPathEvent(event));
	};

	// Vault-scoped capture (used by DiskMirror). Augments the same array so
	// disk.write.ok / disk.write.failed land in the timeline.
	const recordFlightEvent = (event: FlightEventInput): void => {
		captured.push(asAnyEvent(event));
	};

	// editorBindings stub. Mimics the real EditorBindingManager wiring:
	// repair() succeeds and emits an editor.repair.applied flight event
	// through the same callback the real manager uses (see src/main.ts).
	//
	// NOTE: this fixture intentionally reports an UNHEALTHY binding so the
	// localOnly recovery branch's binding-health-conditional repair fires.
	// Healthy-binding behavior (no repair on every recovery) is exercised
	// by tests/controller-recovery-orchestration-amplifier.ts.
	const editorBindings = {
		isBound: () => isBound,
		getBindingDebugInfoForView: () => ({
			leafId: "stub-leaf-1",
			storedCmId: "stub-cm-1",
			liveCmId: "stub-cm-1",
			cmMatches: false, // force unhealthy → repair is called
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: false, // force unhealthy
			awarenessMatchesProvider: true,
			yTextMatchesExpected: true,
			undoManagerMatchesFacet: true,
			facetFileId: null,
			expectedFileId: null,
		}),
		repair: (_view: MarkdownView, deviceName: string, reason: string): boolean => {
			repairCalls.push({ deviceName, reason });
			recordFlightPathEvent({
				priority: "important",
				kind: FLIGHT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path,
				data: {
					leafId: "stub-leaf-1",
					cmId: "stub-cm-1",
					reason,
					rapidSwitch: false,
				},
			});
			return true;
		},
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
	};

	const app = {
		vault: {
			read: async (f: TFile & { path: string }) => {
				if (f.path !== path && !createdFiles.has(f.path)) throw new Error(`unexpected read: ${f.path}`);
				if (createdFiles.has(f.path)) return createdFiles.get(f.path)!;
				return diskContent;
			},
			create: async (createdPath: string, content: string) => {
				if (createdFiles.has(createdPath)) throw new Error("exists");
				conflictOperationOrder.push(`artifact-create:${createdPath}`);
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (
				p === path
					? file
					: (createdFiles.has(p) ? makeTFile(p) : null)
			),
			getMarkdownFiles: () => [
				file,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) {
					for (const openView of views) cb({ view: openView });
				}
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (p: string) => (p === path ? ytext : null),
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
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		getFileIdForText: () => "stub-file-id",
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy,
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			suppressLocalCreate: async () => {},
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			flushWrite: async (flushPath: string) => {
				flushWriteCalls.push(flushPath);
				return { kind: "unchanged", path: flushPath };
			},
			recordPreservedUnresolved: (unresolvedPath: string, reason: string) => {
				preservedUnresolvedCalls.push({ path: unresolvedPath, reason });
				conflictOperationOrder.push(`preserved-unresolved:${unresolvedPath}:${reason}`);
			},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as never,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: Record<string, { mtime: number; size: number; contentHash?: string }>) => {
			diskIndex = next;
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
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
	});

	return {
		path,
		file,
		view,
		views,
		doc,
		ytext,
		captured,
		traces,
		repairCalls,
		transactionOrigins,
		controller,
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => { editorContent = c; },
		setBound: (value) => { isBound = value; },
		setOpen: (value) => { isOpen = value; },
		setExternalEditPolicy: (policy) => { externalEditPolicy = policy; },
		setBaselineContent: (c) => {
			diskIndex = {
				[path]: {
					mtime: 0,
					size: c.length,
					contentHash: baselineHashSync(c),
				},
			};
		},
		clearDiskIndex: () => {
			diskIndex = {};
		},
		getCreatedFiles: () => createdFiles,
		getCurrentDiskContent: () => diskContent,
		getDiskIndexContentHash: () => diskIndex[path]?.contentHash,
		getFlushWriteCalls: () => [...flushWriteCalls],
		getPreservedUnresolvedCalls: () => [...preservedUnresolvedCalls],
		getConflictOperationOrder: () => [...conflictOperationOrder],
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
	};
}

interface UnboundIngestFixture {
	path: string;
	file: TFile;
	ytext: Y.Text;
	controller: ReconciliationController;
	diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }>;
	setDiskContent(content: string): void;
	setStableReader(reader: (path: string, reason: MarkdownDirtyReason) => Promise<StableMarkdownReadResult>): void;
	setExternalEditPolicy(policy: "always" | "closed-only" | "never"): void;
	setOpen(value: boolean): void;
	setPreservedUnresolved(value: boolean, reason?: "remote-delete-missing-baseline" | "path-collision"): void;
	getPreservedClearCount(): number;
	getPreservedRedirects(): Array<{ oldPath: string; newPath: string }>;
	getPreservedPath(): string | null;
	setCrdtPath(path: string): void;
	setFilePath(path: string): void;
	ingestNow(reason?: MarkdownDirtyReason): Promise<void>;
	processDirty(path: string, reason?: MarkdownDirtyReason): Promise<void>;
}

function buildUnboundIngestFixture(initial: {
	path: string;
	disk: string;
	crdt: string;
}): UnboundIngestFixture {
	const path = initial.path;
	const file = makeTFile(path);
	let currentFilePath = path;
	let diskContent = initial.disk;
	let stableReader = async (_path: string, _reason: MarkdownDirtyReason): Promise<StableMarkdownReadResult> => ({
		kind: "ready",
		file,
		content: diskContent,
		stat: { mtime: 1, size: diskContent.length },
	});
	let externalEditPolicy: "always" | "closed-only" | "never" = "always";
	let isOpen = false;
	let preservedPath: string | null = null;
	let preservedReason: "remote-delete-missing-baseline" | "path-collision" =
		"remote-delete-missing-baseline";
	let exposePreservedEntry = false;
	let preservedClearCount = 0;
	const preservedRedirects: Array<{ oldPath: string; newPath: string }> = [];
	let crdtPath = path;
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {};

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => diskContent };

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === currentFilePath ? file : null),
			getMarkdownFiles: () => [file],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: (p: string) => (p === crdtPath ? ytext : null),
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		getFileIdForText: () => "unbound-file-id",
		ensureFile: (_path: string, content: string) => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, content);
			return ytext;
		},
		isPendingRenameTarget: () => false,
	};

	const diskMirror = {
		shouldSuppressCreate: async () => false,
		shouldSuppressModify: async () => false,
		isPreservedUnresolved: (candidatePath: string) => preservedPath === candidatePath,
		getPreservedUnresolvedEntries: () => preservedPath === null || !exposePreservedEntry
			? []
			: [{
				path: preservedPath,
				kind: "markdown" as const,
				reason: preservedReason,
				episodeId: "rename-window-episode",
				firstSeenAt: 1,
				lastSeenAt: 1,
			}],
		clearPreservedUnresolved: (candidatePath: string) => {
			if (preservedPath === candidatePath) {
				preservedPath = null;
				preservedClearCount++;
			}
		},
		redirectPreservedUnresolved: (oldPath: string, newPath: string) => {
			preservedRedirects.push({ oldPath, newPath });
			if (preservedPath === oldPath) {
				preservedPath = newPath;
				return {
					kind: "moved" as const,
					entry: {
						path: newPath,
						kind: "markdown" as const,
						reason: preservedReason,
						episodeId: "rename-window-episode",
						firstSeenAt: 1,
						lastSeenAt: 1,
					},
				};
			}
			if (preservedPath === newPath) {
				return {
					kind: "target-only" as const,
					entry: {
						path: newPath,
						kind: "markdown" as const,
						reason: preservedReason,
						episodeId: "rename-window-episode",
						firstSeenAt: 1,
						lastSeenAt: 1,
					},
				};
			}
			return { kind: "missing" as const };
		},
		flushWrite: async () => {},
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy,
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: typeof diskIndex) => { diskIndex = next; },
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
		readStableMarkdownFile: (p, reason) => stableReader(p, reason),
	});

	return {
		path,
		file,
		ytext,
		controller,
		get diskIndex() { return diskIndex; },
		setDiskContent: (content) => { diskContent = content; },
		setStableReader: (reader) => { stableReader = reader; },
		setExternalEditPolicy: (policy) => { externalEditPolicy = policy; },
		setOpen: (value) => { isOpen = value; },
		setPreservedUnresolved: (value, reason = "remote-delete-missing-baseline") => {
			preservedPath = value ? currentFilePath : null;
			preservedReason = reason;
			// Legacy fixture cases exercise the boolean compatibility surface. The
			// rename-window regression needs the full episode returned at admission.
			exposePreservedEntry = value && reason === "path-collision";
		},
		getPreservedClearCount: () => preservedClearCount,
		getPreservedRedirects: () => [...preservedRedirects],
		getPreservedPath: () => preservedPath,
		setCrdtPath: (nextPath) => { crdtPath = nextPath; },
		setFilePath: (nextPath) => {
			currentFilePath = nextPath;
			file.path = nextPath;
			view.file = file;
		},
		ingestNow: (reason: MarkdownDirtyReason = "modify") =>
			(controller as never as { syncFileFromDisk(file: TFile, reason: MarkdownDirtyReason): Promise<void> })
				.syncFileFromDisk(file, reason),
		processDirty: (dirtyPath: string, reason: MarkdownDirtyReason = "modify") =>
			(controller as never as {
				processDirtyMarkdownPath(path: string, entry: {
					reason: MarkdownDirtyReason;
					primaryOpId?: string;
					coalescedOpIds: string[];
					retryCount: number;
				}): Promise<void>;
			}).processDirtyMarkdownPath(dirtyPath, {
				reason,
				primaryOpId: "op-test",
				coalescedOpIds: ["op-test"],
				retryCount: 0,
			}),
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

async function drainQueuedMarkdown(controller: ReconciliationController): Promise<void> {
	clearMarkdownDrainTimer(controller);
	await (controller as never as { drainDirtyMarkdownPaths(): Promise<void> })
		.drainDirtyMarkdownPaths();
	clearMarkdownDrainTimer(controller);
}

async function invokeBoundFileSyncGap(
	fix: Fixture,
	existingText: Y.Text | null = fix.ytext,
): Promise<{ kind: string }> {
	return (fix.controller as never as {
		handleBoundFileSyncGap(
			file: TFile,
			content: string,
			existingText: Y.Text | null,
			openViews: MarkdownView[],
			sourceReason: "create" | "modify",
			stableStat: { mtime: number; size: number },
			shouldAbort: () => boolean,
		): Promise<{ kind: string }>;
	}).handleBoundFileSyncGap(
		fix.file,
		fix.getCurrentDiskContent(),
		existingText,
		fix.views,
		"modify",
		{ mtime: 1, size: fix.getCurrentDiskContent().length },
		() => false,
	);
}

// -------------------------------------------------------------------
// Test 0 — taxonomy + flight kinds present
// -------------------------------------------------------------------

console.log("\n--- Test 0: flight taxonomy bumped and new kinds present ---");
{
	assertEq(FLIGHT_TAXONOMY_VERSION, 11, "FLIGHT_TAXONOMY_VERSION === 11");
	assertEq(FLIGHT_KIND.recoverySkipped, "recovery.skipped", "FLIGHT_KIND.recoverySkipped");
	assertEq(FLIGHT_KIND.editorRepairApplied, "editor.repair.applied", "FLIGHT_KIND.editorRepairApplied");
	assertEq(FLIGHT_KIND.editorHealApplied, "editor.heal.applied", "FLIGHT_KIND.editorHealApplied");
	assertEq(
		FLIGHT_KIND.editorAuthorityShieldApplied,
		"editor.authority_shield.applied",
		"FLIGHT_KIND.editorAuthorityShieldApplied",
	);
}

// -------------------------------------------------------------------
// Test 1 — round-trip suppression invariant: recovery origin is local
// -------------------------------------------------------------------

console.log("\n--- Test 1: ORIGIN_DISK_SYNC_RECOVER_BOUND is a local origin ---");
{
	assert(
		isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND) === true",
	);
	assert(
		isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, /* provider */ undefined),
		"isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, undefined) === true",
	);
	assert(
		LOCAL_REPAIR_ORIGINS.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"LOCAL_REPAIR_ORIGINS includes ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 2 — orchestration: localOnly recovery emits the expected sequence
// -------------------------------------------------------------------

console.log("\n--- Test 2: localOnly recovery flight-event timeline ---");
{
	const fix = buildFixture({
		path: "Notes/orch-test.md",
		disk: "DDDD",
		editor: "DDDD",
		crdt: "CCCC",
	});

	await fix.ingestDiskFileNow("modify");

	const recoveryKinds = fix.captured
		.filter((e) => e.layer === "recovery" || e.layer === "editor")
		.map((e) => e.kind);

	assert(
		recoveryKinds[0] === FLIGHT_KIND.recoveryDecision,
		"first recovery/editor event is recovery.decision",
	);
	assert(
		recoveryKinds[1] === FLIGHT_KIND.recoveryApplyStart,
		"second recovery/editor event is recovery.apply.start",
	);
	assert(
		recoveryKinds[2] === FLIGHT_KIND.recoveryApplyDone,
		"third recovery/editor event is recovery.apply.done",
	);
	assert(
		recoveryKinds[3] === FLIGHT_KIND.editorRepairApplied,
		"fourth recovery/editor event is editor.repair.applied",
	);
	assertEq(recoveryKinds.length, 4, "exactly 4 recovery/editor events");

	const decision = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assert(decision !== undefined, "recovery.decision present");
	assertEq(decision?.data.reason, "bound-file-local-only-divergence", "decision.reason");
	assertEq(decision?.data.action, "apply-diff", "decision.action");
	assertEq(decision?.data.editorEqualsDisk, true, "decision.editorEqualsDisk === true");
	assertEq(decision?.data.editorEqualsCrdt, false, "decision.editorEqualsCrdt === false");

	const applyStart = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	assertEq(applyStart?.data.origin, ORIGIN_DISK_SYNC_RECOVER_BOUND, "apply.start.origin");

	const applyDone = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	assertEq(applyDone?.data.matchesExpected, true, "apply.done.matchesExpected === true");
	assertEq(applyDone?.data.forceReplaceApplied, false, "apply.done.forceReplaceApplied === false");

	assertEq(fix.repairCalls.length, 1, "editorBindings.repair called once");
	assertEq(
		fix.repairCalls[0]?.reason,
		"bound-file-local-only-divergence",
		"editorBindings.repair reason",
	);

	const healEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorHealApplied);
	assertEq(healEvents.length, 0, "no editor.heal.applied events in localOnly recovery (primary invariant: heal() not invoked)");
	const anyHealKind = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(anyHealKind.length, 0, "no editor.heal.* event of any kind in localOnly recovery");

	assertEq(fix.ytext.toString(), "DDDD", "Y.Text postcondition matches disk");

	assert(
		fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"recovery transaction carried ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 3 — second pass on converged file emits recovery.skipped only
// -------------------------------------------------------------------

console.log("\n--- Test 3: second pass on converged file emits only recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/skip-test.md",
		disk: "SAME",
		editor: "SAME",
		crdt: "DIFF",
	});

	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;
	assert(firstPassCount > 0, "first pass produced events");

	// Clear the bound recovery lock so the lock-active bail does not fire.
	(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
		.boundRecoveryLocks.clear();

	// Now editor and disk and CRDT all agree on "SAME". Drive a second pass.
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "second-pass event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"crdt-current-no-op",
		"recovery.skipped reason is crdt-current-no-op",
	);
	assertEq(secondPassEvents[0]?.data.wasBound, true, "recovery.skipped wasBound === true");

	const healOnSecondPass = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnSecondPass.length, 0, "no editor.heal.* events across both passes");

	assertEq(fix.ytext.toString(), "SAME", "Y.Text unchanged on second pass");
}

// -------------------------------------------------------------------
// Test 4 — bound recovery lock active emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 4: recovery-lock-active bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/lock-test.md",
		disk: "X",
		editor: "X",
		crdt: "Y",
	});

	// Drive one recovery to set the lock, then drive a second one immediately.
	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;

	// Force a fresh divergence so the second pass would otherwise enter the
	// localOnly branch.
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "Y2");

	// Lock is still active (1500ms window, set by first pass). Second pass
	// should bail with recovery.skipped(reason=recovery-lock-active).
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "lock-active second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"recovery-lock-active",
		"recovery.skipped reason is recovery-lock-active",
	);
	assert(
		typeof secondPassEvents[0]?.data.lockRemainingMs === "number" &&
		(secondPassEvents[0].data.lockRemainingMs as number) > 0,
		"recovery.skipped includes lockRemainingMs > 0",
	);

	const healOnLockBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnLockBail.length, 0, "no editor.heal.* events on lock-active bail");
}

// -------------------------------------------------------------------
// Test 5 — crdtOnly idle-grace bail emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 5: crdtOnly idle-grace bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/idle-test.md",
		// editor==CRDT≠disk (crdtOnly branch precondition)
		disk: "DISK",
		editor: "CRDT",
		crdt: "CRDT",
	});

	// Override editorBindings to report recent activity (within
	// OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200ms).
	const eb = (fix.controller as unknown as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
	}).deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	eb.getLastEditorActivityForPath = () => Date.now() - 200; // 200ms ago

	try {
		await fix.ingestDiskFileNow("modify");
	} finally {
		eb.getLastEditorActivityForPath = original;
	}

	const skipped = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoverySkipped);
	assert(skipped !== undefined, "recovery.skipped emitted");
	assertEq(skipped?.data.reason, "recent-editor-activity", "reason is recent-editor-activity");
	assert(
		typeof skipped?.data.idleMs === "number" &&
		(skipped!.data.idleMs as number) >= 0 &&
		(skipped!.data.idleMs as number) < 1200,
		"recovery.skipped idleMs in (0, 1200)",
	);

	// And no recovery.decision was emitted.
	const decisionEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(decisionEvents.length, 0, "no recovery.decision in idle-grace bail");

	const healOnIdleBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnIdleBail.length, 0, "no editor.heal.* events on idle-grace bail");
}

// -------------------------------------------------------------------
// Test 5a — autosave modify ingest waits while the user is typing
// -------------------------------------------------------------------

console.log("\n--- Test 5a: autosave modify ingest waits while user is typing ---");
{
	const fix = buildFixture({
		path: "Notes/typing-autosave.md",
		// editor==disk≠CRDT (the Obsidian autosave typing shape)
		disk: "typed text",
		editor: "typed text",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
		getNextMarkdownDrainDelayMs(now?: number): number;
	};
	const eb = internals.deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	let lastEditorActivity = Date.now() - 100;
	eb.getLastEditorActivityForPath = () => lastEditorActivity;

	try {
		fix.controller.markMarkdownDirty(fix.file, "modify", "op-typing-autosave");
		clearMarkdownDrainTimer(fix.controller);

		const queued = internals.dirtyMarkdownPaths.get(fix.path);
		assert(queued !== undefined, "modify dirty entry is queued");
		assert(
			queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
			"recent typing assigns a future notBeforeMs",
		);
		assert(
			internals.getNextMarkdownDrainDelayMs(Date.now() + 500) > 1000,
			"only-deferred dirty queue sleeps until the editor idle window",
		);

		await drainQueuedMarkdown(fix.controller);
		assert(internals.dirtyMarkdownPaths.has(fix.path), "deferred modify remains queued before idle");
		assertEq(fix.ytext.toString(), "base", "deferred autosave modify does not touch CRDT while typing");

		lastEditorActivity = Date.now();
		const staleQueued = internals.dirtyMarkdownPaths.get(fix.path);
		if (staleQueued) staleQueued.notBeforeMs = Date.now() - 1;
		await drainQueuedMarkdown(fix.controller);
		const refreshed = internals.dirtyMarkdownPaths.get(fix.path);
		assert(
			refreshed?.notBeforeMs !== undefined && refreshed.notBeforeMs > Date.now(),
			"drain refreshes deferral when the user typed again after queueing",
		);
		assertEq(fix.ytext.toString(), "base", "refreshed deferral still does not touch CRDT");
	} finally {
		eb.getLastEditorActivityForPath = original;
		clearMarkdownDrainTimer(fix.controller);
	}
}

// -------------------------------------------------------------------
// Test 5b — stale autosave lag does not create an ambiguous conflict
// -------------------------------------------------------------------

console.log("\n--- Test 5b: stale autosave lag waits instead of creating conflict ---");
{
	const fix = buildFixture({
		path: "Notes/stale-autosave-lag.md",
		// editor differs from both disk and CRDT: a transient autosave-lag
		// shape while the user has continued typing after an earlier save.
		disk: "typed partial",
		editor: "typed partial plus more",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};

	fix.controller.markMarkdownDirty(fix.file, "modify", "op-stale-autosave");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	const queued = internals.dirtyMarkdownPaths.get(fix.path);
	assert(queued !== undefined, "stale autosave modify remains queued");
	assert(
		queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
		"stale autosave modify is deferred into the future",
	);
	assertEq(fix.ytext.toString(), "base", "stale autosave lag does not mutate CRDT");
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision).length,
		0,
		"stale autosave lag emits no recovery.decision",
	);
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"stale autosave lag emits no recovery.apply.start",
	);
	clearMarkdownDrainTimer(fix.controller);
}

// -------------------------------------------------------------------
// Test 5c — a known-baseline disk edit cannot replace a visible CRDT editor
// -------------------------------------------------------------------

console.log("\n--- Test 5c: queued crdtOnly disk edit preserves visible CRDT authority ---");
{
	const fix = buildFixture({
		path: "Notes/queued-external-edit.md",
		// editor==CRDT!=disk. Even with a durable baseline proving a disk-only
		// change, importing it into an open editor would be a visible rollback.
		// Preserve the disk candidate and keep the visible side authoritative.
		disk: "external disk edit",
		editor: "base",
		crdt: "base",
	});

	fix.controller.markMarkdownDirty(fix.file, "modify", "op-external-edit");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), "base", "queued crdtOnly edit cannot replace the visible editor/CRDT side");
	const diskArtifacts = Array.from(fix.getCreatedFiles().entries()).filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - disk"),
	);
	assertEq(diskArtifacts.length, 1, "known-baseline competing disk content is preserved exactly once");
	assertEq(diskArtifacts[0]?.[1], "external disk edit", "known-baseline disk artifact keeps the exact bytes");
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"visible-authority handling never starts disk-to-CRDT recovery",
	);
}

// -------------------------------------------------------------------
// Test 5c2 — missing-baseline visible authority prevents rollback
// -------------------------------------------------------------------

console.log("\n--- Test 5c2: missing-baseline crdtOnly edit keeps visible content and preserves disk ---");
{
	const fix = buildFixture({
		path: "Notes/missing-baseline-crdtonly.md",
		// editor==CRDT!=disk: an external/automation disk edit while the note
		// is open. Missing baseline evidence is even less reason to replace the
		// visible editor; preserve the disk candidate for explicit recovery.
		disk: "external disk edit",
		editor: "visible crdt",
		crdt: "visible crdt",
	});
	fix.clearDiskIndex();

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "visible crdt", "missing-baseline crdtOnly edit cannot roll visible content back");
	const createdEntries = Array.from(fix.getCreatedFiles().entries());
	const crdtArtifacts = createdEntries.filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - crdt"),
	);
	const diskArtifacts = createdEntries.filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - disk"),
	);
	assertEq(crdtArtifacts.length, 0, "current visible CRDT side is not demoted to an artifact");
	assertEq(diskArtifacts.length, 1, "uncertain disk side is preserved exactly once");
	assertEq(diskArtifacts[0]?.[1], "external disk edit", "disk artifact contains the competing content");

	assert(
		fix.captured.every((e) => e.kind !== FLIGHT_KIND.recoveryApplyStart),
		"missing-baseline visible authority does not start a disk-to-CRDT recovery",
	);
}

// -------------------------------------------------------------------
// Test 5c3 — an open view stays authoritative while binding is absent
// -------------------------------------------------------------------

console.log("\n--- Test 5c3: temporarily unbound open view cannot fall into generic disk import ---");
{
	const fix = buildFixture({
		path: "Notes/open-binding-transition.md",
		disk: "stale disk snapshot",
		editor: "visible current text",
		crdt: "visible current text",
	});
	fix.clearDiskIndex();
	fix.setBound(false);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "visible current text", "open unbound view never imports the stale disk snapshot");
	const diskArtifacts = Array.from(fix.getCreatedFiles().entries()).filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - disk"),
	);
	assertEq(diskArtifacts.length, 1, "open unbound conflict preserves the disk side");
	assertEq(diskArtifacts[0]?.[1], "stale disk snapshot", "preserved artifact contains the rejected disk snapshot");
}

// -------------------------------------------------------------------
// Test 5c4 — disagreeing panes fail closed before localOnly/crdtOnly routing
// -------------------------------------------------------------------

console.log("\n--- Test 5c4: disk/CRDT panes fail closed independent of pane order ---");
{
	const diskContent = "pane disk E1\n";
	const crdtContent = "pane CRDT E2\n";
	const baselineContent = "older durable baseline B\n";
	for (const [label, firstEditor, secondEditor] of [
		["disk-first", diskContent, crdtContent],
		["crdt-first", crdtContent, diskContent],
	] as const) {
		const fix = buildFixture({
			path: `Notes/multiple-panes-${label}.md`,
			disk: diskContent,
			editor: firstEditor,
			additionalEditors: [secondEditor],
			crdt: crdtContent,
		});
		fix.setBaselineContent(baselineContent);
		const baselineBefore = fix.getDiskIndexContentHash();

		await fix.controller.runReconciliation("authoritative");

		assertEq(fix.ytext.toString(), crdtContent, `${label}: multiple panes do not mutate Y.Text`);
		assertEq(fix.getCurrentDiskContent(), diskContent, `${label}: multiple panes do not mutate the original disk file`);
		assertEq(fix.getFlushWriteCalls().length, 0, `${label}: multiple panes never enter CRDT-to-disk flush`);
		const baselineAfter = fix.getDiskIndexContentHash();
		assert(
			baselineAfter === undefined || baselineAfter === baselineBefore,
			`${label}: unresolved pane conflict never promotes disk or CRDT to the durable baseline`,
		);
		assert(
			Array.from(fix.getCreatedFiles().values()).includes(crdtContent),
			`${label}: the non-disk visible candidate is preserved as an artifact`,
		);
		assert(
			fix.getPreservedUnresolvedCalls().some((call) => call.path === fix.path),
			`${label}: the original path is marked preserved-unresolved`,
		);
		const conflictOrder = fix.getConflictOperationOrder();
		const firstMarkerIndex = conflictOrder.findIndex((entry) =>
			entry.startsWith(`preserved-unresolved:${fix.path}:`)
		);
		const firstArtifactIndex = conflictOrder.findIndex((entry) =>
			entry.startsWith("artifact-create:")
		);
		assert(
			firstMarkerIndex >= 0 &&
			firstArtifactIndex >= 0 &&
			firstMarkerIndex < firstArtifactIndex,
			`${label}: DiskMirror quarantine is published before the first artifact I/O`,
		);
		assertEq(
			fix.captured.filter((event) => event.kind === FLIGHT_KIND.recoveryApplyStart).length,
			0,
			`${label}: no recovery mutation starts`,
		);
		fix.controller.reset();
		fix.doc.destroy();
	}
}

// -------------------------------------------------------------------
// Test 5c5 — a third visible candidate is preserved without choosing a winner
// -------------------------------------------------------------------

console.log("\n--- Test 5c5: distinct third pane is preserved and no replica is rewritten ---");
{
	const diskContent = "disk D\n";
	const crdtContent = "crdt C\n";
	const thirdEditorContent = "third pane E\n";
	const fix = buildFixture({
		path: "Notes/multiple-panes-third-candidate.md",
		disk: diskContent,
		editor: diskContent,
		additionalEditors: [thirdEditorContent],
		crdt: crdtContent,
	});
	fix.setBaselineContent("baseline B\n");
	const baselineBefore = fix.getDiskIndexContentHash();

	await fix.controller.runReconciliation("authoritative");

	assertEq(fix.ytext.toString(), crdtContent, "third-pane ambiguity leaves Y.Text unchanged");
	assertEq(fix.getCurrentDiskContent(), diskContent, "third-pane ambiguity leaves disk unchanged");
	assertEq(fix.getFlushWriteCalls().length, 0, "third-pane ambiguity never flushes a winner to disk");
	const baselineAfter = fix.getDiskIndexContentHash();
	assert(
		baselineAfter === undefined || baselineAfter === baselineBefore,
		"third-pane ambiguity never promotes any candidate to the durable baseline",
	);
	const artifactContents = Array.from(fix.getCreatedFiles().values());
	assert(artifactContents.includes(thirdEditorContent), "distinct editor E is preserved exactly off the original path");
	assert(artifactContents.includes(crdtContent), "distinct CRDT C is preserved exactly off the original path");
	assert(
		fix.getPreservedUnresolvedCalls().some((call) => call.path === fix.path),
		"third-pane ambiguity marks the original path preserved-unresolved",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5c6 — an unreadable pane also fails closed
// -------------------------------------------------------------------

console.log("\n--- Test 5c6: unreadable pane cannot authorize either direction ---");
{
	const diskContent = "disk D\n";
	const crdtContent = "visible CRDT C\n";
	const fix = buildFixture({
		path: "Notes/unreadable-pane.md",
		disk: diskContent,
		editor: crdtContent,
		additionalEditors: [{ readError: true }],
		crdt: crdtContent,
	});
	fix.setBaselineContent("baseline B\n");
	const baselineBefore = fix.getDiskIndexContentHash();

	await fix.controller.runReconciliation("authoritative");

	assertEq(fix.ytext.toString(), crdtContent, "read failure leaves Y.Text unchanged");
	assertEq(fix.getCurrentDiskContent(), diskContent, "read failure leaves disk unchanged");
	assertEq(fix.getFlushWriteCalls().length, 0, "read failure never flushes either candidate");
	const baselineAfter = fix.getDiskIndexContentHash();
	assert(
		baselineAfter === undefined || baselineAfter === baselineBefore,
		"read failure never promotes either candidate to the durable baseline",
	);
	assert(
		Array.from(fix.getCreatedFiles().values()).includes(crdtContent),
		"readable visible candidate is preserved before fail-closed return",
	);
	assert(
		fix.getPreservedUnresolvedCalls().some((call) => call.path === fix.path),
		"read failure marks the original path preserved-unresolved",
	);
	assertEq(
		fix.captured.filter((event) => event.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"read failure emits no recovery apply start",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5d — create entries do not inherit autosave modify deferral
// -------------------------------------------------------------------

console.log("\n--- Test 5d: create dirty entries bypass typing deferral ---");
{
	const fix = buildFixture({
		path: "Notes/create-after-autosave.md",
		disk: "created",
		editor: "created",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};
	const eb = internals.deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	eb.getLastEditorActivityForPath = () => Date.now() - 100;

	try {
		fix.controller.markMarkdownDirty(fix.file, "modify", "op-typing-before-create");
		fix.controller.markMarkdownDirty(fix.file, "create", "op-create");
		clearMarkdownDrainTimer(fix.controller);

		const queued = internals.dirtyMarkdownPaths.get(fix.path);
		assertEq(queued?.reason, "create", "create priority wins over pending modify");
		assertEq(queued?.notBeforeMs, undefined, "create entry is not delayed by recent typing");
	} finally {
		eb.getLastEditorActivityForPath = original;
		clearMarkdownDrainTimer(fix.controller);
	}
}

// -------------------------------------------------------------------
// Test 5e — create waits when the live editor is ahead of disk
// -------------------------------------------------------------------

console.log("\n--- Test 5e: create waits when the live editor is ahead of disk ---");
{
	const fix = buildFixture({
		path: "Notes/create-editor-ahead.md",
		// The create event captured an earlier autosave snapshot while the
		// editor already contains the user's next input composition.
		disk: "created partial",
		editor: "created partial 한글",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};

	fix.controller.markMarkdownDirty(fix.file, "create", "op-create-editor-ahead");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	const queued = internals.dirtyMarkdownPaths.get(fix.path);
	assert(queued !== undefined, "create remains queued while the editor is ahead of disk");
	assert(
		queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
		"create is retried after the editor/disk settle window",
	);
	assertEq(fix.ytext.toString(), "base", "stale create snapshot does not overwrite CRDT");
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision).length,
		0,
		"editor-ahead create emits no recovery.decision",
	);
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"editor-ahead create emits no recovery.apply.start",
	);
	clearMarkdownDrainTimer(fix.controller);
}

// -------------------------------------------------------------------
// Test 5f — dirty admission carries E across close with no baseline
// -------------------------------------------------------------------

console.log("\n--- Test 5f: dirty admission preserves editor E across close without a baseline ---");
{
	const editorContent = "local autosave E\n";
	const competingCrdt = "remote CRDT C\n";
	const fix = buildFixture({
		path: "Notes/dirty-admission-close.md",
		disk: editorContent,
		editor: editorContent,
		crdt: competingCrdt,
	});
	fix.clearDiskIndex();
	fix.setExternalEditPolicy("closed-only");

	// The autosave event arrives while the editor is still open. Close the view
	// before the queued ingest gets a chance to run: this is the normal-operation
	// gap that a startup-only marker did not cover.
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-close-before-dirty-drain");
	clearMarkdownDrainTimer(fix.controller);
	const internals = fix.controller as never as {
		visibleAuthorityDeferredPaths: Map<string, {
			readComplete: boolean;
			editorContents: string[];
		}>;
		lastReconcileTime: number;
	};
	const admittedMarker = internals.visibleAuthorityDeferredPaths.get(fix.path);
	assert(
		admittedMarker?.readComplete === true &&
		admittedMarker.editorContents.length === 1 &&
		admittedMarker.editorContents[0] === editorContent,
		"modify admission captures the exact open editor E before close",
	);

	fix.setOpen(false);
	fix.setBound(false);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), editorContent, "closed dirty ingest keeps E instead of selecting C");
	assertEq(fix.getCurrentDiskContent(), editorContent, "closed dirty ingest leaves E on the original disk path");
	const crdtArtifacts = Array.from(fix.getCreatedFiles().entries()).filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - crdt"),
	);
	assertEq(crdtArtifacts.length, 1, "competing CRDT C is preserved exactly once");
	assertEq(crdtArtifacts[0]?.[1], competingCrdt, "CRDT artifact retains the exact competing C bytes");
	assert(
		!internals.visibleAuthorityDeferredPaths.has(fix.path),
		"dirty-admission marker clears only after E reaches CRDT and the durable baseline",
	);

	// A subsequent authoritative pass has no mtime/last-index-save evidence and
	// must remain a no-op; the missing-baseline planner cannot put C back.
	internals.lastReconcileTime = 0;
	await fix.controller.runReconciliation("authoritative");
	assertEq(fix.ytext.toString(), editorContent, "full follow-up cannot revert settled E back to C");
	assertEq(fix.getCurrentDiskContent(), editorContent, "full follow-up keeps E on disk");
	assertEq(
		Array.from(fix.getCreatedFiles().values()).filter((content) => content === competingCrdt).length,
		1,
		"full follow-up does not duplicate the preserved C artifact",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5f2 — rejected external reload keeps an exact disk conflict copy
// -------------------------------------------------------------------

console.log("\n--- Test 5f2: rejected external reload preserves the exact disk candidate ---");
{
	const editorAuthority = "open editor authority E\n";
	const externalDiskCandidate = "external script candidate D\r\n";
	const externalEditorCandidate = "external script candidate D\n";
	const fix = buildFixture({
		path: "Notes/rejected-external-reload.md",
		disk: externalDiskCandidate,
		editor: editorAuthority,
		crdt: editorAuthority,
	});

	await Promise.all([
		fix.controller.preserveRejectedExternalEditorReload(fix.path, externalEditorCandidate),
		fix.controller.preserveRejectedExternalEditorReload(fix.path, externalEditorCandidate),
	]);

	const diskArtifacts = Array.from(fix.getCreatedFiles().entries()).filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - disk"),
	);
	assertEq(diskArtifacts.length, 1, "concurrent preservation requests dedupe to one disk conflict note");
	assertEq(diskArtifacts[0]?.[1], externalDiskCandidate, "disk conflict note keeps exact CRLF disk bytes");
	assertEq(fix.ytext.toString(), editorAuthority, "preservation does not mutate open-editor CRDT authority");
	assertEq(fix.getCurrentDiskContent(), externalDiskCandidate, "preservation does not mutate the primary disk path");
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5f3 — reset cancels in-flight external-reload preservation
// -------------------------------------------------------------------

console.log("\n--- Test 5f3: reset cancels in-flight external conflict preservation ---");
{
	const editorAuthority = "open editor authority\n";
	const externalDiskCandidate = "external candidate\n";
	const fix = buildFixture({
		path: "Notes/rejected-external-reset.md",
		disk: externalDiskCandidate,
		editor: editorAuthority,
		crdt: editorAuthority,
	});
	const deps = (fix.controller as unknown as {
		deps: { app: { vault: { read: (file: TFile) => Promise<string> } } };
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	let releaseRead: (() => void) | null = null;
	let markReadStarted: (() => void) | null = null;
	const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
	const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
	deps.app.vault.read = async (file) => {
		markReadStarted?.();
		await readGate;
		return originalRead(file);
	};

	const preservation = fix.controller.preserveRejectedExternalEditorReload(
		fix.path,
		externalDiskCandidate,
	);
	await readStarted;
	fix.controller.reset();
	releaseRead?.();
	await preservation;

	assertEq(fix.getCreatedFiles().size, 0, "reset prevents stale preservation from creating an artifact");
	assertEq(
		fix.getPreservedUnresolvedCalls().length,
		0,
		"cancelled stale work does not publish a false unresolved marker",
	);
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5g — final open-file mutation fence rejects stale async snapshots
// -------------------------------------------------------------------

console.log("\n--- Test 5g1: eventless same-TFile disk byte change rejects recovery ---");
{
	const fix = buildFixture({
		path: "Notes/fence-eventless-disk-change.md",
		disk: "disk snapshot D1",
		editor: "disk snapshot D1",
		crdt: "CRDT C",
	});
	const deps = (fix.controller as never as {
		deps: { computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null> };
	}).deps;
	deps.computeRecoveryStateHash = async () => {
		fix.setDiskContent("disk snapshot D2");
		return "disk-changed-during-recovery-hash";
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "CRDT C", "eventless newer disk bytes do not let D1 replace CRDT");
	assertEq(fix.getCurrentDiskContent(), "disk snapshot D2", "newer same-file disk bytes remain intact");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-content-changed"
		),
		"final fence diagnoses an eventless disk byte change",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"stale D1 produces no recovery transaction",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g1b: same-length disk microtask after final read rejects recovery ---");
{
	const admittedDiskContent = "disk snapshot D1";
	const newerDiskContent = "disk snapshot D2";
	const fix = buildFixture({
		path: "Notes/fence-final-read-microtask.md",
		disk: admittedDiskContent,
		editor: admittedDiskContent,
		crdt: "CRDT C",
	});
	assertEq(newerDiskContent.length, admittedDiskContent.length, "race candidates have identical size");
	const mutableFile = fix.file as TFile & {
		stat: { mtime: number; size: number };
	};
	mutableFile.stat = { mtime: 1, size: admittedDiskContent.length };
	const deps = (fix.controller as never as {
		deps: {
			app: {
				vault: {
					read(file: TFile): Promise<string>;
				};
			};
		};
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	let primaryReadCount = 0;
	deps.app.vault.read = async (file: TFile) => {
		const captured = await originalRead(file);
		if (file === fix.file && ++primaryReadCount === 2) {
			// The final vault read has already captured D1. Queue D2 before the
			// helper's await continuation, without advancing the controller's disk
			// event revision, to exercise the exact read-resolution seam.
			queueMicrotask(() => {
				fix.setDiskContent(newerDiskContent);
				mutableFile.stat = { mtime: 2, size: newerDiskContent.length };
			});
		}
		return captured;
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(primaryReadCount, 2, "race is injected by the final ticket read");
	assertEq(fix.ytext.toString(), "CRDT C", "captured D1 cannot replace CRDT after D2 wins the file epoch");
	assertEq(fix.getCurrentDiskContent(), newerDiskContent, "same-length D2 remains on disk");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-stat-changed"
		),
		"final fence diagnoses the stat epoch change without an event revision",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"post-read disk microtask produces no recovery transaction",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g1c: closed disk-only import uses the final read fence ---");
{
	const admittedDiskContent = "closed disk D1";
	const newerDiskContent = "closed disk D2";
	const fix = buildFixture({
		path: "Notes/fence-closed-disk-import.md",
		disk: admittedDiskContent,
		editor: admittedDiskContent,
		crdt: "closed CRDT C",
	});
	fix.setOpen(false);
	fix.setBound(false);
	assertEq(newerDiskContent.length, admittedDiskContent.length, "closed race candidates have identical size");
	const mutableFile = fix.file as TFile & {
		stat: { mtime: number; size: number };
	};
	mutableFile.stat = { mtime: 1, size: admittedDiskContent.length };
	const deps = (fix.controller as never as {
		deps: {
			app: {
				vault: {
					read(file: TFile): Promise<string>;
				};
			};
		};
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	let primaryReadCount = 0;
	deps.app.vault.read = async (file: TFile) => {
		const captured = await originalRead(file);
		if (file === fix.file && ++primaryReadCount === 2) {
			queueMicrotask(() => {
				fix.setDiskContent(newerDiskContent);
				mutableFile.stat = { mtime: 2, size: newerDiskContent.length };
			});
		}
		return captured;
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(primaryReadCount, 2, "closed importer performs an exact final ticket read");
	assertEq(fix.ytext.toString(), "closed CRDT C", "closed stale D1 cannot roll CRDT back");
	assertEq(fix.getCurrentDiskContent(), newerDiskContent, "closed same-length D2 remains on disk");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "closed-file-mutation-ticket-stale" &&
			trace.details?.reason === "disk-stat-changed"
		),
		"closed generic disk import is routed through the exact final fence",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g2: same-bytes TFile replacement rejects recovery ---");
{
	const diskContent = "same disk bytes";
	const fix = buildFixture({
		path: "Notes/fence-file-aba.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "CRDT C",
	});
	const internals = fix.controller as never as {
		deps: {
			app: {
				vault: {
					getAbstractFileByPath(path: string): unknown;
				};
			};
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const originalLookup = internals.deps.app.vault.getAbstractFileByPath.bind(
		internals.deps.app.vault,
	);
	let occupant: TFile = fix.file;
	internals.deps.app.vault.getAbstractFileByPath = (path: string) =>
		path === fix.path ? occupant : originalLookup(path);
	internals.deps.computeRecoveryStateHash = async () => {
		occupant = makeTFile(fix.path);
		return "same-bytes-file-replaced";
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "CRDT C", "replacement TFile cannot authorize the captured snapshot");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-file-identity-changed"
		),
		"final fence diagnoses same-bytes TFile ABA",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"same-bytes TFile ABA produces no CRDT mutation",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g3: same-bytes Y.Text replacement during planner hash is rejected ---");
{
	const fix = buildFixture({
		path: "Notes/fence-ytext-hash-aba.md",
		disk: "disk D",
		editor: "disk D",
		crdt: "CRDT C",
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, "CRDT C");
	let currentText: Y.Text | null = fix.ytext;
	const vaultSync = (fix.controller as never as {
		deps: { getVaultSync(): { getTextForPath(path: string): Y.Text | null } };
	}).deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;

	queueMicrotask(() => {
		currentText = replacementText;
	});
	const outcome = await invokeBoundFileSyncGap(fix);

	assertEq(outcome.kind, "deferred", "hash-window Y.Text ABA defers the stale recovery");
	assertEq(fix.ytext.toString(), "CRDT C", "captured Y.Text remains an untouched candidate");
	assertEq(replacementText.toString(), "CRDT C", "replacement same-bytes Y.Text also remains untouched");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-text-replaced"
		),
		"final fence compares Y.Text identity, not only bytes",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g4: provider advance during recovery-state hash is preserved ---");
{
	const fix = buildFixture({
		path: "Notes/fence-provider-advance.md",
		disk: "disk D",
		editor: "disk D",
		crdt: "CRDT C1",
	});
	const providerOrigin = { provider: "advance-during-recovery-hash" };
	const deps = (fix.controller as never as {
		deps: { computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null> };
	}).deps;
	deps.computeRecoveryStateHash = async () => {
		fix.doc.transact(() => {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "CRDT C2 provider latest");
		}, providerOrigin);
		return "provider-advanced";
	};

	const outcome = await invokeBoundFileSyncGap(fix);

	assertEq(outcome.kind, "deferred", "provider advance makes the captured recovery stale");
	assertEq(fix.ytext.toString(), "CRDT C2 provider latest", "new provider content survives the D snapshot");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-content-changed"
		),
		"provider advance is diagnosed as changed CRDT content",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"stale recovery cannot transact after provider advance",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g5: artifact await keeps all candidates on same-bytes Y.Text ABA ---");
{
	const diskContent = "disk D";
	const crdtContent = "CRDT C";
	const editorContent = "editor E";
	const fix = buildFixture({
		path: "Notes/fence-artifact-ytext-aba.md",
		disk: diskContent,
		editor: editorContent,
		crdt: crdtContent,
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, crdtContent);
	let currentText: Y.Text | null = fix.ytext;
	type MutationAttempt<T> = { kind: "committed"; value: T } | { kind: "stale" };
	const internals = fix.controller as never as {
		deps: {
			app: {
				vault: {
					create(path: string, content: string): Promise<unknown>;
				};
			};
			getVaultSync(): { getTextForPath(path: string): Y.Text | null };
		};
		getMarkdownDiskRevision(path: string): number;
		commitOpenEditorDiskMutation<T>(
			input: Record<string, unknown> & { commit: () => T },
		): Promise<MutationAttempt<T>>;
		preserveOpenBoundPlannerConflict(input: Record<string, unknown>): Promise<boolean>;
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;
	const originalCreate = internals.deps.app.vault.create.bind(internals.deps.app.vault);
	let replacementPublished = false;
	internals.deps.app.vault.create = async (path: string, content: string) => {
		await originalCreate(path, content);
		if (!replacementPublished) {
			replacementPublished = true;
			currentText = replacementText;
		}
	};
	const expectedDiskRevision = internals.getMarkdownDiskRevision(fix.path);

	const preserved = await internals.preserveOpenBoundPlannerConflict({
		file: fix.file,
		diskContent,
		crdtContent,
		expectedYText: fix.ytext,
		targetContent: editorContent,
		commitTarget: (commit: () => boolean) => internals.commitOpenEditorDiskMutation({
			path: fix.path,
			file: fix.file,
			expectedDiskContent: diskContent,
			expectedYText: fix.ytext,
			expectedCrdtContent: crdtContent,
			ticket: null,
			expectedDiskRevision,
			expectedVisibleAuthorityMarker: null,
			stage: "test-artifact-ytext-aba",
			commit,
		}),
		reason: "test-artifact-ytext-aba",
		preserveDisk: true,
		preserveCrdt: true,
		editorViewCount: 1,
		distinctEditorContentCount: 1,
		chosenSource: "editor",
	});

	assert(preserved === false, "artifact-phase Y.Text replacement rejects convergence");
	assertEq(fix.ytext.toString(), crdtContent, "captured CRDT candidate is not rewritten after artifact await");
	assertEq(replacementText.toString(), crdtContent, "replacement Y.Text candidate is not rewritten either");
	assertEq((fix.view.editor as { getValue(): string }).getValue(), editorContent, "visible editor candidate remains exact");
	const artifactContents = Array.from(fix.getCreatedFiles().values());
	assert(artifactContents.includes(crdtContent), "CRDT candidate remains preserved as an artifact");
	assert(artifactContents.includes(diskContent), "disk candidate remains preserved as an artifact");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-text-replaced"
		),
		"artifact-await ABA is rejected by exact Y.Text identity",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g6: seed is blocked when CRDT appears during recovery hash ---");
{
	const diskContent = "disk seed D";
	const fix = buildFixture({
		path: "Notes/fence-seed-race.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "unused captured text",
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, "provider-created CRDT");
	let currentText: Y.Text | null = null;
	let ensureFileCalls = 0;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): {
				getTextForPath(path: string): Y.Text | null;
				ensureFile(path: string, content: string, deviceName: string, options: unknown): Y.Text;
			};
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;
	vaultSync.ensureFile = (_path, content) => {
		ensureFileCalls++;
		replacementText.delete(0, replacementText.length);
		replacementText.insert(0, content);
		return replacementText;
	};
	internals.deps.computeRecoveryStateHash = async () => {
		currentText = replacementText;
		return "crdt-appeared-before-seed";
	};

	const outcome = await invokeBoundFileSyncGap(fix, null);

	assertEq(outcome.kind, "deferred", "new CRDT authority defers the stale seed");
	assertEq(ensureFileCalls, 0, "ensureFile is never called after a null-to-Y.Text ABA");
	assertEq(replacementText.toString(), "provider-created CRDT", "provider-created CRDT remains intact");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-text-replaced"
		),
		"seed race records the new Y.Text identity",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g7: queued provider microtask runs after fenced recovery commit ---");
{
	const diskContent = "disk D";
	const providerContent = "provider C2 latest";
	const fix = buildFixture({
		path: "Notes/fence-provider-microtask.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "CRDT C1",
	});
	const providerOrigin = { provider: "queued-after-final-y-read" };
	let armProviderAdvance = false;
	let providerAdvanceQueued = false;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): { getTextForPath(path: string): Y.Text | null };
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => {
		if (path === fix.path && armProviderAdvance && !providerAdvanceQueued) {
			providerAdvanceQueued = true;
			queueMicrotask(() => {
				fix.doc.transact(() => {
					fix.ytext.delete(0, fix.ytext.length);
					fix.ytext.insert(0, providerContent);
				}, providerOrigin);
			});
		}
		return path === fix.path ? fix.ytext : null;
	};
	internals.deps.computeRecoveryStateHash = async () => {
		armProviderAdvance = true;
		return "queue-provider-after-final-validation";
	};

	await invokeBoundFileSyncGap(fix);
	await Promise.resolve();

	assert(providerAdvanceQueued, "provider microtask is queued by the final Y.Text lookup");
	assertEq(fix.ytext.toString(), providerContent, "provider C2 lands after D and remains the final authority");
	const recoveryIndex = fix.transactionOrigins.indexOf(ORIGIN_DISK_SYNC_RECOVER_BOUND);
	const providerIndex = fix.transactionOrigins.indexOf(providerOrigin);
	assert(
		recoveryIndex >= 0 && providerIndex > recoveryIndex,
		"CRDT mutation runs inside the fence before its Promise resolves to the queued provider microtask",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 6 — quarantine after three identical attempts
// -------------------------------------------------------------------

console.log("\n--- Test 6: third identical recovery is quarantined ---");
{
	const fix = buildFixture({
		path: "Notes/quarantine-test.md",
		disk: "AAA",
		editor: "AAA",
		crdt: "BBB",
	});

	// Drive three attempts with identical fingerprint (same prev/next content).
	for (let i = 0; i < 3; i++) {
		// Reset CRDT to BBB so each attempt has the same prev/next pair.
		if (i > 0) {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "BBB");
		}
		fix.setBaselineContent("BBB");
		// Clear the lock so each attempt re-enters the recovery branch.
		(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
			.boundRecoveryLocks.clear();
		await fix.ingestDiskFileNow("modify");
	}

	const decisions = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyStarts = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const applyDones = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repairs = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	const quarantined = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryQuarantined);
	const loopDetected = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryLoopDetected);

	assertEq(decisions.length, 3, "three recovery.decision events (one per attempt)");
	assertEq(applyStarts.length, 2, "only the first two attempts entered apply.start");
	assertEq(applyDones.length, 2, "only the first two attempts emitted apply.done");
	assertEq(repairs.length, 2, "only the first two attempts emitted editor.repair.applied");
	assertEq(quarantined.length, 1, "exactly one recovery.quarantined event");
	assertEq(loopDetected.length, 1, "exactly one recovery.loop.detected event");

	assertEq(quarantined[0]?.data.repeatCount, 3, "quarantined.repeatCount === 3");
	assertEq(
		quarantined[0]?.data.reason,
		"bound-file-local-only-divergence",
		"quarantined.reason",
	);
	assert(
		typeof quarantined[0]?.data.signature === "string" &&
		(quarantined[0].data.signature as string).length > 0,
		"quarantined.signature is non-empty string",
	);

	assertEq(loopDetected[0]?.data.repeatCount, 3, "loop.detected.repeatCount === 3");
	assertEq(
		loopDetected[0]?.data.signature,
		quarantined[0]?.data.signature,
		"loop.detected.signature matches quarantined.signature",
	);

	// Assert the quarantine ordering on the third attempt: after the
	// recovery.decision fires, the next recovery-layer event is
	// recovery.quarantined (not apply.start).
	const recoveryLayerKinds = fix.captured
		.filter((e) => e.layer === "recovery")
		.map((e) => e.kind);
	const lastDecisionIdx = recoveryLayerKinds.lastIndexOf(FLIGHT_KIND.recoveryDecision);
	assert(lastDecisionIdx >= 0, "third recovery.decision present");
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 1],
		FLIGHT_KIND.recoveryQuarantined,
		"event after third decision is recovery.quarantined",
	);
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 2],
		FLIGHT_KIND.recoveryLoopDetected,
		"event after recovery.quarantined is recovery.loop.detected",
	);

	// Y.Text final state: third attempt was quarantined before applying any
	// diff, so the second attempt's CRDT content (BBB → AAA) is the last
	// applied state. We reset ytext to BBB before the third attempt; since
	// the third was quarantined, ytext should remain BBB.
	assertEq(
		fix.ytext.toString(),
		"BBB",
		"Y.Text remains at BBB after quarantined third attempt",
	);

	const healOnQuarantine = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnQuarantine.length, 0, "no editor.heal.* events across the three quarantine attempts");
}

// -------------------------------------------------------------------
// Test 7 — round-trip suppression: bound recovery does not emit disk.write.*
// -------------------------------------------------------------------

console.log("\n--- Test 7: bound recovery does not round-trip as disk.write ---");
{
	const fix = buildFixture({
		path: "Notes/round-trip-test.md",
		disk: "DISKDISK",
		editor: "DISKDISK",
		crdt: "CRDTCRDT",
	});

	await fix.ingestDiskFileNow("modify");

	// Wait one tick to drain any microtask-scheduled disk emission.
	await new Promise((r) => setTimeout(r, 50));

	const writeOk = fix.captured.find(
		(e) => e.kind === "disk.write.ok" && e.path === fix.path,
	);
	const writeFailed = fix.captured.find(
		(e) => e.kind === "disk.write.failed" && e.path === fix.path,
	);

	assertEq(writeOk, undefined, "no disk.write.ok for recovery write");
	assertEq(writeFailed, undefined, "no disk.write.failed for recovery write");
}

// -------------------------------------------------------------------
// Test 8 — source-grep regressions on src/sync/editorBinding.ts
// -------------------------------------------------------------------

console.log("\n--- Test 8: source-grep regressions on EditorBindingManager emit sites ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const src = readFileSync(bindingSourcePath, "utf8");

	// Constructor accepts the optional flight callback.
	assert(
		src.includes("private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void"),
		"constructor accepts optional recordFlightPathEvent callback",
	);
	assert(
		src.includes('import type { ProductFlightPathEventInput } from "../observability/traceSink"'),
		"ProductFlightPathEventInput imported from observability",
	);

	// applyBinding emits editor.repair.applied for action==="repair" only.
	const applyBindingIdx = src.indexOf(
		"private applyBinding(",
	);
	assert(applyBindingIdx > 0, "applyBinding method present");
	const applyBindingTail = src.slice(applyBindingIdx, applyBindingIdx + 4500);
	assert(
		applyBindingTail.includes("PRODUCT_EVENT_KIND.editorRepairApplied"),
		"applyBinding emits PRODUCT_EVENT_KIND.editorRepairApplied",
	);
	assert(
		applyBindingTail.includes('if (action === "repair")'),
		"applyBinding gates emission on action===\"repair\"",
	);

	// heal() emits editor.heal.applied on every successful entry that
	// resolves a binding target (not gated on the diff branch). Carries
	// diffApplied: boolean so absence of the event proves heal() was not
	// invoked.
	const healIdx = src.indexOf(
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(healIdx > 0, "heal method present");
	const healBody = src.slice(healIdx, healIdx + 2500);
	const applyDiffIdx = healBody.indexOf("applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL)");
	const healEmitIdx = healBody.indexOf("PRODUCT_EVENT_KIND.editorHealApplied");
	assert(applyDiffIdx > 0, "heal() calls applyDiffToYText with ORIGIN_EDITOR_HEALTH_HEAL");
	assert(healEmitIdx > 0, "heal() emits PRODUCT_EVENT_KIND.editorHealApplied");
	assert(
		healEmitIdx > applyDiffIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit follows applyDiffToYText",
	);
	// editor.heal.applied is NOT gated on the diff branch — the emit must
	// be after the if (diffApplied) block, not inside it. We assert this by
	// checking that the emit index is past the closing brace of the diff
	// branch. The diff branch is short (just the log + applyDiffToYText) so
	// we can detect it textually.
	assert(
		healBody.includes("const diffApplied = crdtContent !== currentContent"),
		"heal() computes diffApplied flag",
	);
	assert(
		healBody.includes("diffApplied,"),
		"heal() emit data carries diffApplied flag",
	);
	const ifBranchIdx = healBody.indexOf("if (diffApplied) {");
	assert(ifBranchIdx > 0, "heal() has if(diffApplied) block");
	// The emit must NOT be inside the if(diffApplied) block. Find the
	// closing brace of that block by walking braces.
	let depth = 0;
	let closeIdx = -1;
	for (let i = ifBranchIdx + "if (diffApplied) {".length - 1; i < healBody.length; i++) {
		const ch = healBody[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { closeIdx = i; break; }
		}
	}
	assert(closeIdx > 0, "heal() if(diffApplied) block closing brace found");
	assert(
		healEmitIdx > closeIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit is OUTSIDE if(diffApplied) block (fires on every successful entry)",
	);
}

// -------------------------------------------------------------------
// Test 9 — production code has no new heal() callers
// -------------------------------------------------------------------

console.log("\n--- Test 9: heal() retains zero production callers ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const bindingSrc = readFileSync(bindingSourcePath, "utf8");

	// Grep production sources outside editorBinding.ts itself for `.heal(`.
	const productionFiles = [
		"../src/main.ts",
		"../src/runtime/reconciliationController.ts",
		"../src/runtime/editorWorkspaceOrchestrator.ts",
		"../src/sync/diskMirror.ts",
	];

	for (const rel of productionFiles) {
		const url = new URL(rel, import.meta.url);
		try {
			const text = readFileSync(fileURLToPath(url), "utf8");
			// editorBindings.heal( or .heal( on something resembling a manager.
			// Allow editorBindings?.heal? in trace strings, but not as a call.
			const callMatches = text.match(/editorBindings(?:\??\s*\.\s*|\s*\.\s*)heal\s*\(/g);
			assertEq(
				callMatches,
				null,
				`no editorBindings.heal( call in ${rel.replace("../", "")}`,
			);
		} catch (err) {
			// File missing is fine for editorWorkspaceOrchestrator.ts in
			// older revisions.
			void err;
		}
	}

	// And inside editorBinding.ts itself, heal() should still call repair()
	// and not be invoked by validateOpenBindings, bind, or maybeHealBinding.
	assert(
		!bindingSrc.match(/this\.heal\s*\(/),
		"no this.heal( call inside editorBinding.ts (repair flows do not invoke heal)",
	);
}

// -------------------------------------------------------------------
// Test 10 — stable markdown ingest gates
// -------------------------------------------------------------------

console.log("\n--- Test 10: unstable stable-read does not import partial content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stable-read.md",
		disk: "partial",
		crdt: "base",
	});
	fix.setStableReader(async () => ({ kind: "unstable" }));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "unstable read leaves CRDT unchanged");
	const dirty = (fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { retryCount: number }>;
	}).dirtyMarkdownPaths.get(fix.path);
	assertEq(dirty?.retryCount, 1, "unstable read requeues with retryCount=1");
	assertEq(Object.keys(fix.diskIndex).length, 0, "unstable read does not advance disk index");
	clearMarkdownDrainTimer(fix.controller);
}

console.log("\n--- Test 11: delayed stable-read imports final complete content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stable-complete.md",
		disk: "partial",
		crdt: "base",
	});
	fix.setStableReader(async (_path, _reason) => {
		fix.setDiskContent("complete");
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 2, size: "complete".length },
		};
	});

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "complete", "stable read imports final content");
	assertEq(fix.diskIndex[fix.path]?.mtime, 2, "stable stat is used for disk index");
}

console.log("\n--- Test 12: read-time stat churn retries without CRDT mutation ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stat-churn.md",
		disk: "partial",
		crdt: "base",
	});
	let attempts = 0;
	fix.setStableReader(async () => {
		attempts++;
		if (attempts === 1) return { kind: "unstable" };
		fix.setDiskContent("complete");
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 3, size: "complete".length },
		};
	});

	await fix.ingestNow("modify");
	assertEq(fix.ytext.toString(), "base", "first stat-churn attempt leaves CRDT unchanged");
	clearMarkdownDrainTimer(fix.controller);

	await fix.ingestNow("modify");
	assertEq(fix.ytext.toString(), "complete", "later stable attempt imports complete content");
}

console.log("\n--- Test 13: rename during active stable-read aborts old path and imports new path ---");
{
	const oldPath = "Notes/old-name.md";
	const newPath = "Notes/new-name.md";
	const fix = buildUnboundIngestFixture({
		path: oldPath,
		disk: "complete",
		crdt: "base",
	});
	let releaseStableRead!: () => void;
	const stableReadGate = new Promise<void>((resolve) => {
		releaseStableRead = resolve;
	});
	let markStableReadStarted!: () => void;
	const stableReadStarted = new Promise<void>((resolve) => {
		markStableReadStarted = resolve;
	});
	let firstStableRead = true;
	fix.setStableReader(async (path) => {
		if (firstStableRead) {
			firstStableRead = false;
			markStableReadStarted();
			await stableReadGate;
			return {
				kind: "ready",
				file: fix.file,
				content: `stale old path ${path}`,
				stat: { mtime: 1, size: 19 },
			};
		}
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 2, size: "complete".length },
		};
	});

	const activeIngest = fix.processDirty(oldPath, "modify");
	await stableReadStarted;
	fix.setCrdtPath(newPath);
	fix.setFilePath(newPath);
	fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(
		JSON.stringify(fix.getPreservedRedirects()),
		JSON.stringify([{ oldPath, newPath }]),
		"local rename redirect also carries DiskMirror's unresolved path ownership",
	);
	releaseStableRead();
	await activeIngest;

	assertEq(fix.ytext.toString(), "base", "old path active ingest aborts after rename redirect");
	const redirected = (fix.controller as never as {
		dirtyMarkdownPaths: Map<string, unknown>;
	}).dirtyMarkdownPaths.has(newPath);
	assert(redirected, "new path is queued after active redirect");

	await drainQueuedMarkdown(fix.controller);
	assertEq(fix.ytext.toString(), "complete", "new path dirty entry imports complete content");
}

console.log("\n--- Test 13b: rename callback moves Attention before a new-path modify can drain ---");
{
	const oldPath = "Notes/attention-before-rename.md";
	const newPath = "Notes/attention-after-rename.md";
	const fix = buildUnboundIngestFixture({
		path: oldPath,
		disk: "new-path disk event must stay quarantined",
		crdt: "competing CRDT authority",
	});
	fix.setPreservedUnresolved(true, "path-collision");
	fix.setCrdtPath(newPath);
	fix.setFilePath(newPath);

	const immediateRedirect = fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(immediateRedirect.kind, "moved", "rename callback moves the exact unresolved episode immediately");
	assertEq(fix.getPreservedPath(), newPath, "new path owns Attention before batch flush");

	// Model a modify event emitted after the vault rename callback but before
	// VaultSync's rename batch has flushed. Without the immediate redirect this
	// event enters the ordinary unguarded disk-ingest lane and replaces CRDT.
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-rename-window-modify");
	await drainQueuedMarkdown(fix.controller);

	assertEq(
		fix.ytext.toString(),
		"competing CRDT authority",
		"new-path modify cannot bypass the old unresolved episode",
	);
	assertEq(fix.getPreservedClearCount(), 0, "rename-window modify does not clear Attention");
	assertEq(fix.getPreservedPath(), newPath, "new-path quarantine remains active");

	const laterBatchRedirect = fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(laterBatchRedirect.kind, "target-only", "later batch-flush redirect is idempotent");
	clearMarkdownDrainTimer(fix.controller);
}

console.log("\n--- Test 14: policy and preserved-unresolved are evaluated after stable read ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/policy-after-wait.md",
		disk: "local edit",
		crdt: "base",
	});
	fix.setExternalEditPolicy("closed-only");
	fix.setPreservedUnresolved(true);
	fix.setStableReader(async () => {
		fix.setOpen(true);
		return {
			kind: "ready",
			file: fix.file,
			content: "local edit",
			stat: { mtime: 4, size: "local edit".length },
		};
	});

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "closed-only open-after-wait skips import");
	assertEq(fix.getPreservedClearCount(), 0, "preserved-unresolved is not cleared when policy blocks import");
	assertEq(Object.keys(fix.diskIndex).length, 0, "closed-only skip does not advance disk index");
}

console.log("\n--- Test 14b: closed-only autosave equality advances the clean baseline ---");
{
	const localContent = "local editor autosave";
	const previousContent = "previous clean baseline";
	const fix = buildUnboundIngestFixture({
		path: "Notes/open-autosave-clean.md",
		disk: localContent,
		crdt: localContent,
	});
	fix.diskIndex[fix.path] = {
		mtime: 1,
		size: previousContent.length,
		contentHash: await contentBaselineHash(previousContent),
	};
	fix.setExternalEditPolicy("closed-only");
	fix.setOpen(true);
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: localContent,
		stat: { mtime: 6, size: localContent.length },
	}));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), localContent, "closed-only autosave does not re-import or replace CRDT");
	assertEq(
		fix.diskIndex[fix.path]?.contentHash,
		await contentBaselineHash(localContent),
		"editor=CRDT=disk equality advances the durable local-edit baseline",
	);
	assertEq(fix.diskIndex[fix.path]?.mtime, 6, "clean autosave baseline keeps the stable save stat");
}

console.log("\n--- Test 14c: autosave queued open still settles after the note closes ---");
{
	const localContent = "local edit saved before close";
	const previousContent = "older baseline";
	const fix = buildUnboundIngestFixture({
		path: "Notes/autosave-close-before-drain.md",
		disk: localContent,
		crdt: localContent,
	});
	fix.diskIndex[fix.path] = {
		mtime: 1,
		size: previousContent.length,
		contentHash: await contentBaselineHash(previousContent),
	};
	fix.setExternalEditPolicy("closed-only");
	fix.setOpen(true);
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-open-autosave");
	fix.setOpen(false);

	await drainQueuedMarkdown(fix.controller);

	assertEq(
		fix.diskIndex[fix.path]?.contentHash,
		await contentBaselineHash(localContent),
		"close-before-drain equality still advances B to the saved local baseline L",
	);
	assertEq(fix.ytext.toString(), localContent, "late dirty drain leaves settled local CRDT unchanged");
}

console.log("\n--- Test 15: policy-never advances only stable stat, not content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/policy-never.md",
		disk: "local edit",
		crdt: "base",
	});
	fix.setExternalEditPolicy("never");
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: "local edit",
		stat: { mtime: 5, size: "local edit".length },
	}));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "policy-never skips CRDT import");
	assertEq(fix.diskIndex[fix.path]?.mtime, 5, "policy-never records stable stat");
	assertEq(fix.getPreservedClearCount(), 0, "policy-never does not fabricate an Attention clear");
}

// -------------------------------------------------------------------
// Wrap up
// -------------------------------------------------------------------

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
