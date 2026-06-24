/**
 * Markdown remote-delete trash-preference parity-confirm regression.
 *
 * Spec: .kiro/specs/markdown-remote-delete-trash-preference/requirements.md
 *
 * Mirrors the blob trash-preference Tests 5/6/7 in tests/blob-download-conflicts.ts
 * but asserts on the FLIGHT channel for markdown:
 *   - markdown emits `delete.disk.applied` flight events with data.deleteMode
 *   - blob emits `remote-delete-applied` legacy trace events with details.deleteMode
 * The two surfaces are not the same channel; this test establishes parity of
 * discriminator semantics, not parity of event channel.
 *
 * Five scenarios. Each scenario constructs its OWN fresh fixture
 * (DiskMirror, captured arrays, file map, vaultSync). Cross-scenario state
 * leakage is forbidden because DiskMirror carries internal state
 * (suppression maps, preserved-unresolved registry, open-path set, debounce
 * timers, observer cleanups, write queue).
 *
 *   Scenario A: trashFile available, trash preferred, called with system === true
 *   Scenario B: trashFile missing, hard-delete fallback
 *   Scenario C: trashFile throws, trashFile attempted FIRST (system === true),
 *               hard-delete fallback, ordering trash-attempted-before-delete
 *   Scenario D: preserve-revive — no trash, no delete; ensureFile(..., reviveTombstone:true)
 *   Scenario E: preserve-unresolved — no trash, no delete, no ensureFile;
 *               path enters preservedUnresolved registry
 *
 * White-box rules:
 *   - vaultSync is a hand-rolled stub cast to `any`. Real VaultSync is not
 *     instantiated; this test does not need a Y.Doc constructor or provider
 *     plumbing. (The spec requires a real Y.Text per scenario; a stub
 *     vaultSync.getTextForPath that returns a real Y.Text suffices and is
 *     fixture realism, not semantic necessity, since options.baselineText
 *     short-circuits the Y.Text consultation in handleRemoteDelete.)
 *   - hand-rolled vault uses real `TFile` instances from the obsidian mock
 *     so `existing instanceof TFile` is true (otherwise handleRemoteDelete
 *     silently skips the entire branch).
 */

import { TFile } from "obsidian";
import * as Y from "yjs";
import { DiskMirror } from "../src/sync/diskMirror";

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

interface CapturedFlightEvent {
	kind: string;
	path?: string;
	priority?: string;
	severity?: string;
	source?: string;
	layer?: string;
	data?: Record<string, unknown>;
}

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

interface TrashCall {
	path: string;
	system?: boolean;
}

interface EnsureFileCall {
	path: string;
	content: string;
	deviceName?: string;
	options?: Record<string, unknown>;
}

interface CallOrderEntry {
	op: "trash" | "delete";
	path: string;
}

interface Fixture {
	mirror: DiskMirror;
	vaultSync: { getTextForPath: (path: string) => Y.Text | null; ensureFile: (...args: unknown[]) => Y.Text | null };
	doc: Y.Doc;
	ytext: Y.Text;
	flightEvents: CapturedFlightEvent[];
	traces: CapturedTrace[];
	trashCalls: TrashCall[];
	deleteCalls: string[];
	callOrder: CallOrderEntry[];
	ensureFileCalls: EnsureFileCall[];
	fileExists(path: string): boolean;
}

interface FixtureOptions {
	path: string;
	diskContent: string;
	/**
	 * Trash adapter shape:
	 *   "available" — fileManager.trashFile present and succeeds.
	 *   "missing"   — fileManager is undefined (no trash channel on host).
	 *   "throws"    — fileManager.trashFile present but throws on call.
	 *   "preserve"  — same as "available"; included for clarity in
	 *                 preserve-* scenarios where neither path runs.
	 */
	trashAdapter: "available" | "missing" | "throws" | "preserve";
}

function buildFixture(opts: FixtureOptions): Fixture {
	// Real TFile instance from the obsidian mock so `instanceof TFile` holds.
	const file = new TFile() as TFile & {
		path: string;
		stat: { mtime: number; size: number };
	};
	file.path = opts.path;
	file.stat = { mtime: 1, size: opts.diskContent.length };

	const files = new Map<string, TFile & { path: string; stat: { mtime: number; size: number } }>();
	files.set(opts.path, file);
	let diskContent: string | { _readThrows: true } = opts.diskContent;

	const flightEvents: CapturedFlightEvent[] = [];
	const traces: CapturedTrace[] = [];
	const trashCalls: TrashCall[] = [];
	const deleteCalls: string[] = [];
	const callOrder: CallOrderEntry[] = [];
	const ensureFileCalls: EnsureFileCall[] = [];

	// Real Y.Doc + Y.Text per fixture (Requirement 1.8 — fixture realism).
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, opts.diskContent);

	const vaultSync = {
		getTextForPath: (p: string): Y.Text | null => (p === opts.path ? ytext : null),
		ensureFile: (path: string, content: string, deviceName: string, options?: Record<string, unknown>) => {
			ensureFileCalls.push({ path, content, deviceName, options });
			return ytext;
		},
		// Properties handleRemoteDelete touches indirectly via meta-observer
		// path; not exercised by direct invocation, but provided for shape
		// compatibility.
		idToText: new Map<string, Y.Text>(),
		isFileMetaDeleted: (): boolean => false,
		provider: {},
		meta: { observe(): void {}, unobserve(): void {} },
		ydoc: { on(): void {}, off(): void {} },
	};

	const editorBindings = {
		unbindByPath: (): void => {},
		updatePathsAfterRename: (): void => {},
	};

	const fileManagerByForm = (): { trashFile?: (file: TFile, system?: boolean) => Promise<void> } | undefined => {
		switch (opts.trashAdapter) {
			case "missing":
				return undefined;
			case "available":
			case "preserve":
				return {
					trashFile: async (f: TFile, system?: boolean) => {
						trashCalls.push({ path: (f as { path: string }).path, system });
						callOrder.push({ op: "trash", path: (f as { path: string }).path });
						files.delete((f as { path: string }).path);
					},
				};
			case "throws":
				return {
					trashFile: async (f: TFile, system?: boolean) => {
						trashCalls.push({ path: (f as { path: string }).path, system });
						callOrder.push({ op: "trash", path: (f as { path: string }).path });
						throw new Error("trash not supported");
					},
				};
		}
	};

	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			read: async (f: TFile & { path: string }) => {
				if (typeof diskContent === "object" && (diskContent as { _readThrows?: boolean })._readThrows) {
					throw new Error("EBUSY: file is locked");
				}
				if (f.path !== opts.path) throw new Error(`unexpected read: ${f.path}`);
				return diskContent as string;
			},
			delete: async (f: TFile & { path: string }) => {
				deleteCalls.push(f.path);
				callOrder.push({ op: "delete", path: f.path });
				files.delete(f.path);
			},
			adapter: {
				stat: async (p: string) => files.get(p)?.stat ?? null,
			},
		},
		fileManager: fileManagerByForm(),
		workspace: {
			iterateAllLeaves: (): void => {},
		},
	};

	const mirror = new DiskMirror(
		app as never,
		vaultSync as never,
		editorBindings as never,
		false,
		(source, msg, details) => traces.push({ source, msg, details }),
		() => true,
		undefined,
		() => "TestDevice",
	);

	mirror.setFlightEventHandler((event: Record<string, unknown>) => {
		flightEvents.push({
			kind: event.kind as string,
			path: event.path as string | undefined,
			priority: event.priority as string | undefined,
			severity: event.severity as string | undefined,
			source: event.source as string | undefined,
			layer: event.layer as string | undefined,
			data: event.data as Record<string, unknown> | undefined,
		});
	});

	return {
		mirror,
		vaultSync,
		doc,
		ytext,
		flightEvents,
		traces,
		trashCalls,
		deleteCalls,
		callOrder,
		ensureFileCalls,
		fileExists: (p: string) => files.has(p),
	};
}

// -------------------------------------------------------------------
// Scenario A — trashFile available, trash preferred, system === true
// -------------------------------------------------------------------

console.log("\n--- Scenario A: markdown remote delete prefers trashFile ---");
{
	const path = "Notes/scenario-a.md";
	const baseline = "scenario-a clean baseline";
	const fix = buildFixture({ path, diskContent: baseline, trashAdapter: "available" });

	await (fix.mirror as unknown as {
		handleRemoteDelete: (p: string, opts?: { baselineText?: string | null }) => Promise<void>;
	}).handleRemoteDelete(path, { baselineText: baseline });

	assertEq(fix.trashCalls.length, 1, "markdown remote delete attempts trashFile exactly once");
	assertEq(fix.trashCalls[0]?.path, path, "trashFile called with correct path");
	assertEq(fix.trashCalls[0]?.system, true, "trashFile called with system === true");
	assertEq(fix.deleteCalls.length, 0, "markdown remote delete does not use hard delete when trash is available");

	const observedEvents = fix.flightEvents.filter((e) => e.kind === "delete.remote.observed");
	const appliedEvents = fix.flightEvents.filter((e) => e.kind === "delete.disk.applied");
	const preservedEvents = fix.flightEvents.filter((e) => e.kind === "delete.preserved");

	assertEq(observedEvents.length, 1, "exactly one delete.remote.observed event");
	assertEq(appliedEvents.length, 1, "exactly one delete.disk.applied event");
	assertEq(preservedEvents.length, 0, "no delete.preserved events in apply-delete branch");

	assertEq(appliedEvents[0]?.data?.deleteMode, "trash", "markdown remote delete reports deleteMode 'trash' on flight event");
	assertEq(appliedEvents[0]?.data?.reason, "tombstone-applied", "applied event reason is tombstone-applied");

	const observedIdx = fix.flightEvents.findIndex((e) => e.kind === "delete.remote.observed");
	const appliedIdx = fix.flightEvents.findIndex((e) => e.kind === "delete.disk.applied");
	assert(observedIdx >= 0 && appliedIdx > observedIdx, "delete.remote.observed precedes delete.disk.applied");

	assert(!fix.fileExists(path), "file no longer exists in vault after trashFile");
}

// -------------------------------------------------------------------
// Scenario B — trashFile missing, hard-delete fallback
// -------------------------------------------------------------------

console.log("\n--- Scenario B: markdown remote delete falls back when trash unavailable ---");
{
	const path = "Notes/scenario-b.md";
	const baseline = "scenario-b clean baseline";
	// Form chosen: app.fileManager === undefined (the broader "missing" form;
	// covers both "no fileManager" AND "no trashFile" since the optional chain
	// in DiskMirror.deleteLocalReplica reads `fileManager?.trashFile`).
	const fix = buildFixture({ path, diskContent: baseline, trashAdapter: "missing" });

	await (fix.mirror as unknown as {
		handleRemoteDelete: (p: string, opts?: { baselineText?: string | null }) => Promise<void>;
	}).handleRemoteDelete(path, { baselineText: baseline });

	assertEq(fix.trashCalls.length, 0, "trashFile not called when adapter missing");
	assertEq(fix.deleteCalls.length, 1, "markdown remote delete falls back to vault.delete");
	assertEq(fix.deleteCalls[0], path, "vault.delete called with correct path");

	const appliedEvents = fix.flightEvents.filter((e) => e.kind === "delete.disk.applied");
	const preservedEvents = fix.flightEvents.filter((e) => e.kind === "delete.preserved");
	assertEq(appliedEvents.length, 1, "exactly one delete.disk.applied event");
	assertEq(preservedEvents.length, 0, "no delete.preserved events on missing-trash fallback");

	assertEq(appliedEvents[0]?.data?.deleteMode, "delete", "markdown remote delete reports deleteMode 'delete' on flight event");
	assertEq(appliedEvents[0]?.data?.reason, "tombstone-applied", "applied event reason is tombstone-applied");

	assert(!fix.fileExists(path), "file no longer exists in vault after fallback delete");
}

// -------------------------------------------------------------------
// Scenario C — trashFile throws, attempted then hard-delete fallback
// -------------------------------------------------------------------

console.log("\n--- Scenario C: markdown remote delete falls back when trashFile throws ---");
{
	const path = "Notes/scenario-c.md";
	const baseline = "scenario-c clean baseline";
	// Thrown error literal: "trash not supported" (see fileManagerByForm).
	const fix = buildFixture({ path, diskContent: baseline, trashAdapter: "throws" });

	await (fix.mirror as unknown as {
		handleRemoteDelete: (p: string, opts?: { baselineText?: string | null }) => Promise<void>;
	}).handleRemoteDelete(path, { baselineText: baseline });

	assertEq(fix.trashCalls.length, 1, "markdown remote delete attempts trashFile before fallback");
	assertEq(fix.trashCalls[0]?.path, path, "trashFile attempted for scenario C path");
	assertEq(fix.trashCalls[0]?.system, true, "trashFile attempt uses system === true even when it throws");
	assertEq(fix.deleteCalls.length, 1, "vault.delete called as fallback after trashFile throw");
	assertEq(fix.deleteCalls[0], path, "fallback vault.delete called with correct path");

	// Temporal ordering: trash attempted before vault.delete.
	const trashIdx = fix.callOrder.findIndex((c) => c.op === "trash");
	const deleteIdx = fix.callOrder.findIndex((c) => c.op === "delete");
	assert(trashIdx >= 0 && deleteIdx > trashIdx, "trashFile attempted strictly before vault.delete");

	const observedEvents = fix.flightEvents.filter((e) => e.kind === "delete.remote.observed");
	const appliedEvents = fix.flightEvents.filter((e) => e.kind === "delete.disk.applied");
	const preservedEvents = fix.flightEvents.filter((e) => e.kind === "delete.preserved");
	assertEq(observedEvents.length, 1, "exactly one delete.remote.observed event");
	assertEq(appliedEvents.length, 1, "exactly one delete.disk.applied event");
	assertEq(preservedEvents.length, 0, "trash throw does not promote to delete.preserved");

	assertEq(appliedEvents[0]?.data?.deleteMode, "delete", "markdown remote delete reports deleteMode 'delete' after trash throw");
	assertEq(appliedEvents[0]?.data?.reason, "tombstone-applied", "applied event reason is tombstone-applied");

	const observedIdx = fix.flightEvents.findIndex((e) => e.kind === "delete.remote.observed");
	const appliedIdx = fix.flightEvents.findIndex((e) => e.kind === "delete.disk.applied");
	assert(observedIdx >= 0 && appliedIdx > observedIdx, "delete.remote.observed precedes delete.disk.applied even when trash throws");

	assert(!fix.fileExists(path), "file no longer exists in vault after fallback delete");
}

// -------------------------------------------------------------------
// Scenario D — preserve-revive (local dirty wins over remote delete)
// -------------------------------------------------------------------

console.log("\n--- Scenario D: preserve-revive does not invoke trash or delete; revives via ensureFile ---");
{
	const path = "Notes/scenario-d.md";
	const baselineText = "scenario-d known baseline";
	const diskContent = "scenario-d locally edited body — diverges from baseline";
	// trashAdapter: "preserve" — handleRemoteDelete should not invoke either
	// trashFile or vault.delete in this branch, but the adapter is wired so a
	// regression that incorrectly enters apply-delete is caught visibly.
	const fix = buildFixture({ path, diskContent, trashAdapter: "preserve" });

	await (fix.mirror as unknown as {
		handleRemoteDelete: (p: string, opts?: { baselineText?: string | null }) => Promise<void>;
	}).handleRemoteDelete(path, { baselineText });

	assertEq(fix.trashCalls.length, 0, "preserve-revive does not call trashFile");
	assertEq(fix.deleteCalls.length, 0, "preserve-revive does not call vault.delete");

	const appliedEvents = fix.flightEvents.filter((e) => e.kind === "delete.disk.applied");
	const preservedEvents = fix.flightEvents.filter((e) => e.kind === "delete.preserved");
	assertEq(appliedEvents.length, 0, "no delete.disk.applied event in preserve-revive branch");
	assertEq(preservedEvents.length, 1, "exactly one delete.preserved event in preserve-revive branch");

	assertEq(preservedEvents[0]?.data?.preserveKind, "preserve-revive", "preserveKind is preserve-revive");
	assertEq(preservedEvents[0]?.data?.reason, "local-dirty-wins-over-remote-delete", "preserve-revive reason matches production literal");

	// Positive proof that the tombstone revive happened.
	assertEq(fix.ensureFileCalls.length, 1, "preserve-revive revives tombstone through ensureFile");
	assertEq(fix.ensureFileCalls[0]?.path, path, "ensureFile called with correct path");
	assertEq(fix.ensureFileCalls[0]?.content, diskContent, "ensureFile content equals disk content");
	assertEq(fix.ensureFileCalls[0]?.options?.reviveTombstone, true, "preserve-revive uses reviveTombstone: true");
	assertEq(
		fix.ensureFileCalls[0]?.options?.reviveReason,
		"remote-delete-local-dirty-preserved",
		"preserve-revive uses expected reviveReason",
	);

	assert(fix.fileExists(path), "file remains in vault after preserve-revive");
}

// -------------------------------------------------------------------
// Scenario E — preserve-unresolved (no baseline available)
// -------------------------------------------------------------------

console.log("\n--- Scenario E: preserve-unresolved does not invoke trash, delete, or ensureFile ---");
{
	const path = "Notes/scenario-e.md";
	const diskContent = "scenario-e content present on disk but baseline missing";
	// Form chosen: pass baselineText: null so handleRemoteDelete enters the
	// no-baseline branch (preserve-unresolved with reason
	// "remote-delete-missing-baseline"). The read-failed alternative would
	// emit reason "remote-delete-read-failed"; we exercise only one form.
	const fix = buildFixture({ path, diskContent, trashAdapter: "preserve" });

	await (fix.mirror as unknown as {
		handleRemoteDelete: (p: string, opts?: { baselineText?: string | null }) => Promise<void>;
	}).handleRemoteDelete(path, { baselineText: null });

	assertEq(fix.trashCalls.length, 0, "preserve-unresolved does not call trashFile");
	assertEq(fix.deleteCalls.length, 0, "preserve-unresolved does not call vault.delete");
	assertEq(fix.ensureFileCalls.length, 0, "preserve-unresolved does not call ensureFile");

	const appliedEvents = fix.flightEvents.filter((e) => e.kind === "delete.disk.applied");
	const preservedEvents = fix.flightEvents.filter((e) => e.kind === "delete.preserved");
	assertEq(appliedEvents.length, 0, "no delete.disk.applied event in preserve-unresolved branch");
	assertEq(preservedEvents.length, 1, "exactly one delete.preserved event in preserve-unresolved branch");

	assertEq(preservedEvents[0]?.data?.preserveKind, "preserve-unresolved", "preserveKind is preserve-unresolved");
	assertEq(
		preservedEvents[0]?.data?.reason,
		"remote-delete-missing-baseline",
		"preserve-unresolved reason matches missing-baseline trigger",
	);

	assert(fix.mirror.isPreservedUnresolved(path), "path enters preservedUnresolved registry");
	assert(fix.fileExists(path), "file remains in vault after preserve-unresolved");
}

// -------------------------------------------------------------------
// Source-grep backup signal (optional per Requirement 7.6, labeled as backup).
// -------------------------------------------------------------------
//
// The runtime flight-event assertions above are the primary semantic proof.
// The single grep below exists only to catch a regression where the deleteMode
// field is silently dropped from the production emission while leaving the
// field name still nominally present elsewhere. Per project policy, this is a
// backup signal, NOT a primary semantic proof.

console.log("\n--- Backup: deleteMode field still passed in delete.disk.applied production emission ---");
{
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const diskMirrorPath = fileURLToPath(new URL("../src/sync/diskMirror.ts", import.meta.url));
	const src = readFileSync(diskMirrorPath, "utf8");
	const appliedIdx = src.indexOf('kind: "delete.disk.applied"');
	assert(appliedIdx > 0, "delete.disk.applied flight emission present");
	const tail = src.slice(appliedIdx, appliedIdx + 400);
	assert(tail.includes("deleteMode"), "delete.disk.applied emission still passes deleteMode in data");
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
