/**
 * Controller-level recovery orchestration test.
 *
 * Spec: .kiro/specs/controller-recovery-orchestration/requirements.md
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
	doc: Y.Doc;
	ytext: Y.Text;
	captured: CapturedEvent[];
	repairCalls: Array<{ deviceName: string; reason: string }>;
	transactionOrigins: unknown[];
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setBaselineContent(content: string): void;
	clearDiskIndex(): void;
	getCreatedFiles(): Map<string, string>;
	getCurrentDiskContent(): string;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
}): Fixture {
	const path = initial.path;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let diskIngestPort: DiskIngestPort | null = null;
	const createdFiles = new Map<string, string>();
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

	const captured: CapturedEvent[] = [];
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
	// by tests/controller-recovery-orchestration-amplifier.ts. See spec:
	// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
	const editorBindings = {
		isBound: () => true,
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
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: (p: string) => (p === path ? ytext : null),
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
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			suppressLocalCreate: async () => {},
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			flushWrite: async () => {},
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
		trace: () => {},
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
		doc,
		ytext,
		captured,
		repairCalls,
		transactionOrigins,
		controller,
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => { editorContent = c; },
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
	setPreservedUnresolved(value: boolean): void;
	getPreservedClearCount(): number;
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
	let preservedUnresolved = false;
	let preservedClearCount = 0;
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
		isPreservedUnresolved: () => preservedUnresolved,
		clearPreservedUnresolved: () => {
			if (preservedUnresolved) {
				preservedUnresolved = false;
				preservedClearCount++;
			}
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
		setPreservedUnresolved: (value) => { preservedUnresolved = value; },
		getPreservedClearCount: () => preservedClearCount,
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
// Test 5c — queued external disk edits still import when editor matches CRDT
// -------------------------------------------------------------------

console.log("\n--- Test 5c: queued crdtOnly external edit still imports ---");
{
	const fix = buildFixture({
		path: "Notes/queued-external-edit.md",
		// editor==CRDT!=disk: this is still the external-disk-edit candidate
		// and must not be blocked by the stale-autosave ambiguity guard.
		disk: "external disk edit",
		editor: "base",
		crdt: "base",
	});

	fix.controller.markMarkdownDirty(fix.file, "modify", "op-external-edit");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), "external disk edit", "queued crdtOnly edit imports disk into CRDT");
	const decision = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(
		decision?.data.reason,
		"bound-file-open-idle-disk-recovery",
		"queued crdtOnly edit keeps the open-idle recovery path",
	);
}

// -------------------------------------------------------------------
// Test 5c2 — missing-baseline crdtOnly import does not spam disk artifacts
// -------------------------------------------------------------------

console.log("\n--- Test 5c2: missing-baseline crdtOnly edit preserves CRDT once, not disk snapshots ---");
{
	const fix = buildFixture({
		path: "Notes/missing-baseline-crdtonly.md",
		// editor==CRDT!=disk: an external/automation disk edit while the note
		// is open. With no durable baseline, this used to choose CRDT and
		// preserve every growing disk autosave as a KAOS conflict artifact.
		disk: "external disk edit",
		editor: "visible crdt",
		crdt: "visible crdt",
	});
	fix.clearDiskIndex();

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "external disk edit", "missing-baseline crdtOnly edit imports disk into CRDT");
	const createdEntries = Array.from(fix.getCreatedFiles().entries());
	const crdtArtifacts = createdEntries.filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - crdt"),
	);
	const diskArtifacts = createdEntries.filter(([artifactPath]) =>
		artifactPath.includes("KAOS conflict - disk"),
	);
	assertEq(crdtArtifacts.length, 1, "CRDT side is preserved exactly once");
	assertEq(crdtArtifacts[0]?.[1], "visible crdt", "CRDT artifact contains the previous visible content");
	assertEq(diskArtifacts.length, 0, "disk autosave is not demoted to a conflict artifact");

	const needed = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(
		needed?.data.reason,
		"bound-file-open-idle-disk-recovery",
		"missing-baseline crdtOnly still follows the open-idle recovery path",
	);
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
		return attempts === 1
			? { kind: "unstable" }
			: {
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

console.log("\n--- Test 15: policy-never advances only stable stat, not content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/policy-never.md",
		disk: "local edit",
		crdt: "base",
	});
	fix.setExternalEditPolicy("never");
	fix.setPreservedUnresolved(true);
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: "local edit",
		stat: { mtime: 5, size: "local edit".length },
	}));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "policy-never skips CRDT import");
	assertEq(fix.diskIndex[fix.path]?.mtime, 5, "policy-never records stable stat");
	assertEq(fix.getPreservedClearCount(), 0, "policy-never does not clear preserved-unresolved");
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
