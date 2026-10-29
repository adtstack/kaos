/**
 * Manual resolution of held automatic recoveries (local vs remote split-brain).
 *
 * Topology under test (2026-10-01 W39 incident): an open editor froze with a
 * stale local copy while the room advanced. The contamination gate holds the
 * destructive disk-wins recovery forever; `resolveAutomaticRecoveryHold` is
 * the convergence path:
 *   - keep-local re-runs the local→CRDT diff with ORIGIN_MANUAL_RECOVERY_CHOICE
 *     (manual lane, admission gate bypassed by contract).
 *   - keep-remote flushes CRDT→disk with the remote-projection CAS and refreshes
 *     the frozen panes.
 * A choice bound to a replaced hold episode must expire without applying.
 *
 * `restoreFileFromServerState` is the same keep-remote mechanics without the
 * hold precondition: the per-file manual escape hatch (command palette +
 * "KAOS: Restore from server" menu) that settles a stale-tab divergence by
 * discarding the local copy after auditing it.
 */

import { createHash } from "node:crypto";
import { MarkdownView, Notice, TFile } from "obsidian";
import * as Y from "yjs";
import { RemoteTextRevisionTracker } from "../src/sync/remoteTextRevisionTracker";
import { LocalOnlyRecoveryEvidence } from "../src/sync/localOnlyRecoveryEvidence";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import {
	FLIGHT_KIND,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";

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

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & {
		path: string;
		basename: string;
		extension: string;
		parent: { path: string } | null;
	};
	file.path = path;
	file.stat = { ctime: 1, mtime: 1, size: 0 };
	const parts = path.split("/");
	const filename = parts.pop() ?? path;
	const dotIdx = filename.lastIndexOf(".");
	if (dotIdx > 0) {
		file.basename = filename.slice(0, dotIdx);
		file.extension = filename.slice(dotIdx + 1);
	} else {
		file.basename = filename;
		file.extension = "";
	}
	file.parent = parts.length > 0 ? { path: parts.join("/") } : { path: "/" };
	return file;
}

function baselineHashSync(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

interface CapturedEvent {
	kind: string;
	path: string;
	data: Record<string, unknown>;
}

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path ?? "",
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

interface Fixture {
	path: string;
	file: TFile;
	setAuditHook(hook: () => void): void;
	ytext: Y.Text;
	captured: CapturedEvent[];
	transactionOrigins: unknown[];
	setValues: string[];
	discarded: Array<{ path: string; identity: string; reason: string }>;
	validations: string[];
	flushWriteCalls: number;
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setLastEditorActivity(value: number | null): void;
	setEvidenceAvailable(value: boolean): void;
	setFlushWriteOutcome(outcome: "written" | "deferred"): void;
	setServerTextAvailable(value: boolean): void;
	setEditorReadFailure(value: boolean): void;
	holds(): ReadonlyArray<{ path: string; detail: string; episode: number }>;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
	bumpHoldEpisode(): void;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
	lastEditorActivity?: number | null;
}): Fixture {
	const path = initial.path;
	let isOpen = true;
	let evidenceAvailable = false;
	let serverTextAvailable = true;
	let editorReadFails = false;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let editorRevision = 0;
	let diskIngestPort: DiskIngestPort | null = null;
	let lastEditorActivity: number | null = initial.lastEditorActivity ?? null;
	let flushWriteOutcome: "written" | "deferred" = "written";
	let flushWriteCalls = 0;
	let auditHook = () => {};
	const setValues: string[] = [];
	const discarded: Array<{ path: string; identity: string; reason: string }> = [];
	const validations: string[] = [];
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {
		[path]: {
			mtime: 0,
			size: initial.crdt.length,
			contentHash: baselineHashSync(initial.crdt),
		},
	};

	const doc = new Y.Doc();
	const provider = {};
	const texts = doc.getMap<Y.Text>("idToText");
	const tracker = new RemoteTextRevisionTracker(doc, texts, () => provider, () => null);
	const ytext = new Y.Text(initial.crdt);
	texts.set("stub-file-id", ytext);
	const evidence = new LocalOnlyRecoveryEvidence();
	const paneIdentity = {};
	// Model the diverged-frozen topology: the pane cannot certify local lag,
	// so the evidence probe returns null and admission must fail closed.
	const certifyLocalLag = () => {
		const revision = tracker.get(ytext, "stub-file-id");
		evidence.update({ identity: paneIdentity, revision, before: null,
			editor: ytext.toString(), crdt: ytext.toString(), source: "projection", complete: true });
		evidence.update({ identity: paneIdentity, revision, before: ytext.toString(),
			editor: editorContent, crdt: ytext.toString(), source: "local", complete: true });
	};
	certifyLocalLag();

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string; setValue(value: string): void };
	};
	view.file = file;
	view.editor = {
		getValue: () => {
			if (editorReadFails) throw new Error("editor read failed");
			return editorContent;
		},
		setValue: (value: string) => {
			editorContent = value;
			editorRevision++;
			setValues.push(value);
		},
	};

	const captured: CapturedEvent[] = [];
	const transactionOrigins: unknown[] = [];
	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
	});

	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		captured.push(asPathEvent(event));
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		captured.push(asAnyEvent(event));
	};

	const extraFiles = new Map<string, TFile>();
	const createdFiles: Array<{ path: string; data: string }> = [];
	const clearedDivergences: string[] = [];

	const editorBindings = {
		isBound: () => true,
		clearUnboundDivergence: (p: string) => {
			clearedDivergences.push(p);
		},
		getLocalOnlyRecoveryEvidenceForView: () => evidenceAvailable ? evidence.get() : null,
		getBindingDebugInfoForView: () => ({
			leafId: "stub-leaf-1",
			storedCmId: "stub-cm-1",
			liveCmId: "stub-cm-1",
			cmMatches: true,
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: false,
			awarenessMatchesProvider: false,
			yTextMatchesExpected: false,
			undoManagerMatchesFacet: false,
			facetFileId: null,
			expectedFileId: null,
		}),
		repair: (): boolean => true,
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => lastEditorActivity,
		captureOpenEditorMutationTicket: (
			ticketPath: string,
			ticketViews: readonly MarkdownView[],
		) => ({
			path: ticketPath,
			views: ticketViews.map((ticketView, index) => ({
				view: ticketView,
				viewId: `stub-view-${index + 1}`,
				leafId: `stub-leaf-${index + 1}`,
				cm: null,
				cmId: null,
				bindingEpoch: 0,
				editorRevision,
				editorAuthorityRevision: editorRevision,
				editorAuthorityContent: editorContent,
				editorDocument: editorRevision,
				editorContent,
			})),
		}),
		validateOpenEditorMutationTicket: (
			ticket: {
				path: string;
				views: ReadonlyArray<{ view: MarkdownView; editorRevision: number }>;
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
			return ticket.views.some((snapshot) => snapshot.editorRevision !== editorRevision)
				? { current: false as const, reason: "editor-revision-changed" as const }
				: { current: true as const };
		},
	};

	const app = {
		vault: {
			read: async (f: TFile & { path: string }) => {
				if (f.path !== path) {
					const created = createdFiles.find((c) => c.path === f.path);
					if (created) return created.data;
					throw new Error(`unexpected read: ${f.path}`);
				}
				return diskContent;
			},
			modify: async (f: TFile & { path: string }, data: string) => {
				if (f.path === path) {
					diskContent = data;
				}
			},
			create: async (newPath: string, data: string) => {
				createdFiles.push({ path: newPath, data });
				const newFile = makeTFile(newPath);
				extraFiles.set(newPath, newFile);
				return newFile;
			},
			delete: async (f: TFile & { path: string }) => {
				extraFiles.delete(f.path);
				const idx = createdFiles.findIndex((c) => c.path === f.path);
				if (idx >= 0) createdFiles.splice(idx, 1);
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === path ? file : extraFiles.get(p) ?? null),
			getMarkdownFiles: () => [file, ...extraFiles.values()],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	const vaultSync = {
		remoteTextRevisions: tracker,
		getRemoteTextRevisionForPath: (p: string) => p === path ? tracker.get(ytext, "stub-file-id") : null,
		getTextForPath: (p: string) => (p === path && serverTextAvailable ? ytext : null),
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
			automaticRecoveryMode: "guarded",
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			hasPendingWrite: () => false,
			getLastDiskWriteOkHash: () => null,
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			isPreservedUnresolved: () => false,
			getPreservedUnresolvedEntries: () => [],
			clearPreservedUnresolved: () => {},
			flushWrite: async (flushPath: string) => {
				flushWriteCalls++;
				if (flushWriteOutcome !== "written") {
					return { kind: "deferred" as const, path: flushPath, reason: "remote-projection-not-ready" as const };
				}
				diskContent = ytext.toString();
				return {
					kind: "written" as const,
					path: flushPath,
					isCreate: false,
					content: diskContent,
					contentHash: baselineHashSync(diskContent),
					baselineRecorded: true,
				};
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
		validateOpenEditorBindings: (reason: string) => {
			validations.push(reason);
		},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		computeRecoveryStateHash: async () => "fixture-hash",
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
		recordDiscardedRevision: (discardedPath: string, identity: string, discardReason: string) => {
			discarded.push({ path: discardedPath, identity, reason: discardReason });
			auditHook();
		},
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
	});

	return {
		path,
		file,
		setAuditHook: (hook) => { auditHook = hook; },
		ytext,
		captured,
		transactionOrigins,
		setValues,
		discarded,
		validations,
		controller,
		get flushWriteCalls() { return flushWriteCalls; },
		get createdFiles() { return createdFiles; },
		get clearedDivergences() { return clearedDivergences; },
		get diskContent() { return diskContent; },
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => { editorContent = c; },
		setLastEditorActivity: (v) => { lastEditorActivity = v; },
		setEvidenceAvailable: (v) => { evidenceAvailable = v; },
		setFlushWriteOutcome: (o) => { flushWriteOutcome = o; },
		setServerTextAvailable: (v) => { serverTextAvailable = v; },
		setEditorReadFailure: (v) => { editorReadFails = v; },
		holds: () => controller.getAutomaticRecoveryHolds(),
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
		bumpHoldEpisode: () => {
			const holds = (controller as unknown as {
				automaticRecoveryHolds: Map<unknown, { episode: number }>;
			}).automaticRecoveryHolds;
			for (const entry of holds.values()) entry.episode += 100;
		},
	};
}

const IDLE_PAST = () => Date.now() - 10_000;

// -------------------------------------------------------------------
// Test 1 — diverged-frozen topology produces a hold, not a disk-wins
// -------------------------------------------------------------------

console.log("\n--- Test 1: contamination hold blocks the destructive recovery ---");
{
	const fix = buildFixture({
		path: "Notes/hold-setup.md",
		disk: "LOCAL-TEXT",
		editor: "LOCAL-TEXT",
		crdt: "REMOTE-TEXT",
		lastEditorActivity: IDLE_PAST(),
	});

	await fix.ingestDiskFileNow("modify");

	const holds = fix.holds();
	assertEq(holds.length, 1, "one automatic recovery hold registered");
	assertEq(holds[0]?.detail, "initial-authority-unverified", "hold detail is initial-authority-unverified");
	assertEq(fix.ytext.toString(), "REMOTE-TEXT", "Y.Text untouched while held");

	const blocked = fix.captured.find(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped &&
			e.data.reason === "local-only-remote-contamination",
	);
	assert(blocked !== undefined, "recovery.skipped local-only-remote-contamination emitted");
}

// -------------------------------------------------------------------
// Test 2 — keep-local applies the local text with the manual origin
// -------------------------------------------------------------------

console.log("\n--- Test 2: keep-local resolution applies local via manual lane ---");
{
	const fix = buildFixture({
		path: "Notes/keep-local.md",
		disk: "LOCAL-KEEP",
		editor: "LOCAL-KEEP",
		crdt: "REMOTE-KEEP",
		lastEditorActivity: IDLE_PAST(),
	});

	await fix.ingestDiskFileNow("modify");
	assertEq(fix.holds().length, 1, "hold present before resolution");

	const request = await fix.controller.resolveAutomaticRecoveryHold(fix.path, "keep-local");
	assertEq(request.ok, true, "resolveAutomaticRecoveryHold(keep-local) accepted");

	const before = fix.captured.length;
	await fix.ingestDiskFileNow("modify");
	const events = fix.captured.slice(before);

	assertEq(fix.ytext.toString(), "LOCAL-KEEP", "keep-local applied local text to CRDT");
	assertEq(fix.holds().length, 0, "hold cleared after keep-local");
	assert(
		fix.transactionOrigins.includes("manual-recovery-choice"),
		"apply used ORIGIN_MANUAL_RECOVERY_CHOICE",
	);
	const decision = events.find(
		(e) => e.kind === FLIGHT_KIND.recoveryDecision && e.data.reason === "manual-recovery-choice",
	);
	assert(decision !== undefined, "recovery.decision manual-recovery-choice emitted");
	assertEq((decision?.data.action ?? null), "keep-local", "decision action is keep-local");
	const applyStart = events.find(
		(e) => e.kind === FLIGHT_KIND.recoveryApplyStart &&
			e.data.origin === "manual-recovery-choice",
	);
	assert(applyStart !== undefined, "recovery.apply.start carries the manual origin");
	assert(
		Notice.calls.some((call) => call.message.includes("local version")),
		"completion notice names the kept side",
	);
}

// -------------------------------------------------------------------
// Test 3 — keep-remote flushes CRDT to disk and refreshes the panes
// -------------------------------------------------------------------

console.log("\n--- Test 3: keep-remote resolution flushes CRDT and refreshes panes ---");
{
	const fix = buildFixture({
		path: "Notes/keep-remote.md",
		disk: "LOCAL-DROP",
		editor: "LOCAL-DROP",
		crdt: "REMOTE-WIN",
		lastEditorActivity: IDLE_PAST(),
	});

	await fix.ingestDiskFileNow("modify");
	assertEq(fix.holds().length, 1, "hold present before resolution");

	const request = await fix.controller.resolveAutomaticRecoveryHold(fix.path, "keep-remote");
	assertEq(request.ok, true, "resolveAutomaticRecoveryHold(keep-remote) accepted");

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "REMOTE-WIN", "keep-remote leaves the CRDT untouched");
	assertEq(fix.holds().length, 0, "hold cleared after keep-remote");
	assertEq(fix.flushWriteCalls, 1, "one CRDT→disk flush issued");
	assertEq(fix.setValues.length, 1, "frozen pane refreshed once");
	assertEq(fix.setValues[0], "REMOTE-WIN", "pane refreshed with the remote text");
	const decision = fix.captured.find(
		(e) => e.kind === FLIGHT_KIND.recoveryDecision &&
			e.data.reason === "manual-recovery-choice" &&
			e.data.action === "keep-remote",
	);
	assert(decision !== undefined, "recovery.decision manual keep-remote emitted");
}

// -------------------------------------------------------------------
// Test 4 — keep-remote with an unsettled write keeps the choice for retry
// -------------------------------------------------------------------

console.log("\n--- Test 4: unsettled keep-remote flush retains the hold and choice ---");
{
	const fix = buildFixture({
		path: "Notes/keep-remote-deferred.md",
		disk: "LOCAL-DROP2",
		editor: "LOCAL-DROP2",
		crdt: "REMOTE-WIN2",
		lastEditorActivity: IDLE_PAST(),
	});
	fix.setFlushWriteOutcome("deferred");

	await fix.ingestDiskFileNow("modify");
	await fix.controller.resolveAutomaticRecoveryHold(fix.path, "keep-remote");
	await fix.ingestDiskFileNow("modify");

	assertEq(fix.setValues.length, 0, "pane not refreshed while write unsettled");
	assertEq(fix.holds().length, 1, "hold retained while write unsettled");

	// The retry once the projection is ready converges.
	fix.setFlushWriteOutcome("written");
	await fix.ingestDiskFileNow("modify");
	assertEq(fix.setValues.length, 1, "retry refreshes the pane");
	assertEq(fix.holds().length, 0, "retry clears the hold");
}

// -------------------------------------------------------------------
// Test 5 — guard rails: no hold / editor active / episode expiry
// -------------------------------------------------------------------

console.log("\n--- Test 5: resolution guard rails ---");
{
	const clean = buildFixture({
		path: "Notes/no-hold.md",
		disk: "SAME",
		editor: "SAME",
		crdt: "SAME",
		lastEditorActivity: IDLE_PAST(),
	});
	await clean.ingestDiskFileNow("modify");
	const noHold = await clean.controller.resolveAutomaticRecoveryHold(clean.path, "keep-local");
	assertEq(noHold.ok, false, "no-hold request rejected");
	assertEq(noHold.reason, "no-hold", "no-hold reason reported");

	const active = buildFixture({
		path: "Notes/active-typing.md",
		disk: "LOCAL-ACT",
		editor: "LOCAL-ACT",
		crdt: "REMOTE-ACT",
		lastEditorActivity: IDLE_PAST(),
	});
	await active.ingestDiskFileNow("modify");
	active.setLastEditorActivity(Date.now() - 200);
	const busy = await active.controller.resolveAutomaticRecoveryHold(active.path, "keep-local");
	assertEq(busy.ok, false, "active-typing request rejected");
	assertEq(busy.reason, "editor-active", "editor-active reason reported");

	const expired = buildFixture({
		path: "Notes/episode-expiry.md",
		disk: "LOCAL-EXP",
		editor: "LOCAL-EXP",
		crdt: "REMOTE-EXP",
		lastEditorActivity: IDLE_PAST(),
	});
	await expired.ingestDiskFileNow("modify");
	const queued = await expired.controller.resolveAutomaticRecoveryHold(expired.path, "keep-local");
	assertEq(queued.ok, true, "choice queued before episode replacement");
	expired.bumpHoldEpisode();
	await expired.ingestDiskFileNow("modify");
	assertEq(expired.ytext.toString(), "REMOTE-EXP", "expired choice never applies");
	assertEq(expired.holds().length, 1, "hold survives the expired choice");
}

// -------------------------------------------------------------------
// Test 6 — restoreFileFromServerState settles a held divergence
// -------------------------------------------------------------------

console.log("\n--- Test 6: direct restore-from-server applies the synced text end to end ---");
{
	const fix = buildFixture({
		path: "Notes/restore-held.md",
		disk: "LOCAL-RESTORE",
		editor: "LOCAL-RESTORE",
		crdt: "SERVER-RESTORE",
		lastEditorActivity: IDLE_PAST(),
	});

	await fix.ingestDiskFileNow("modify");
	assertEq(fix.holds().length, 1, "hold present before the restore");

	const result = await fix.controller.restoreFileFromServerState(fix.path);
	assertEq(result.ok, true, "restore accepted");
	assertEq(result.reason, "written", "restore reports the settled write");
	assertEq(fix.setValues.length, 1, "frozen pane refreshed");
	assertEq(fix.setValues[0], "SERVER-RESTORE", "pane refreshed with the synced text");
	assertEq(fix.flushWriteCalls, 1, "one CRDT→disk flush issued");
	assertEq(fix.holds().length, 0, "hold cleared by the restore");
	assert(
		fix.discarded.some((entry) =>
			entry.path === fix.path && entry.reason === "manual-restore-from-server"
		),
		"discarded local revision audited",
	);
	assertEq(fix.discarded.length, 1, "editor copy equal to disk audited once");
	assert(
		fix.captured.some((e) =>
			e.kind === FLIGHT_KIND.recoveryDecision &&
			e.data.reason === "manual-restore-from-server" &&
			e.data.action === "keep-remote"
		),
		"recovery.decision manual-restore-from-server emitted",
	);
	assert(
		fix.validations.includes("manual-restore-from-server"),
		"open editor bindings revalidated after the restore",
	);
	assertEq(fix.ytext.toString(), "SERVER-RESTORE", "restore never touches the CRDT");
}

// -------------------------------------------------------------------
// Test 7 — already-current short-circuit still rebinds stale panes
// -------------------------------------------------------------------

console.log("\n--- Test 7: already-current restore refreshes bindings without writing ---");
{
	const fix = buildFixture({
		path: "Notes/restore-current.md",
		disk: "SAME-TEXT",
		editor: "SAME-TEXT",
		crdt: "SAME-TEXT",
		lastEditorActivity: IDLE_PAST(),
	});

	const result = await fix.controller.restoreFileFromServerState(fix.path);
	assertEq(result.ok, true, "already-current restore accepted");
	assertEq(result.reason, "already-current", "already-current reason reported");
	assertEq(fix.setValues.length, 0, "no pane rewrite when nothing differs");
	assertEq(fix.flushWriteCalls, 0, "no disk flush when nothing differs");
	assert(
		fix.validations.includes("manual-restore-from-server"),
		"bindings revalidated for the stale-pane case",
	);
}

// -------------------------------------------------------------------
// Test 8 — restore guard rails
// -------------------------------------------------------------------

console.log("\n--- Test 8: restore guard rails ---");
{
	const fix = buildFixture({
		path: "Notes/restore-guards.md",
		disk: "LOCAL-G",
		editor: "LOCAL-G",
		crdt: "REMOTE-G",
		lastEditorActivity: IDLE_PAST(),
	});

	const missing = await fix.controller.restoreFileFromServerState("Notes/not-on-disk.md");
	assertEq(missing.ok, false, "unknown path rejected");
	assertEq(missing.reason, "file-missing", "file-missing reason reported");

	fix.setServerTextAvailable(false);
	const noServer = await fix.controller.restoreFileFromServerState(fix.path);
	assertEq(noServer.ok, false, "path without synced content rejected");
	assertEq(noServer.reason, "no-server-content", "no-server-content reason reported");
	fix.setServerTextAvailable(true);

	fix.setLastEditorActivity(Date.now() - 200);
	const busy = await fix.controller.restoreFileFromServerState(fix.path);
	assertEq(busy.ok, false, "active-typing restore rejected");
	assertEq(busy.reason, "editor-active", "editor-active reason reported");
	assertEq(fix.setValues.length, 0, "no pane rewrite while typing");
	assertEq(fix.flushWriteCalls, 0, "no disk flush while typing");
	fix.setLastEditorActivity(IDLE_PAST());

	const readFailed = buildFixture({
		path: "Notes/restore-read-failed.md",
		disk: "LOCAL-RF",
		editor: "LOCAL-RF",
		crdt: "REMOTE-RF",
		lastEditorActivity: IDLE_PAST(),
	});
	readFailed.setEditorReadFailure(true);
	const opaque = await readFailed.controller.restoreFileFromServerState(readFailed.path);
	assertEq(opaque.ok, false, "unreadable pane fails closed");
	assertEq(opaque.reason, "editor-read-failed", "editor-read-failed reason reported");
	assertEq(readFailed.setValues.length, 0, "unreadable pane never rewritten");
	assertEq(readFailed.flushWriteCalls, 0, "no disk flush under an unreadable pane");
}

// -------------------------------------------------------------------
// Test 9 — unsettled restore write reports failure with panes aligned
// -------------------------------------------------------------------

console.log("\n--- Test 9: unsettled restore reports not-ok after pane refresh ---");
{
	const fix = buildFixture({
		path: "Notes/restore-deferred.md",
		disk: "LOCAL-DEF",
		editor: "LOCAL-DEF",
		crdt: "REMOTE-DEF",
		lastEditorActivity: IDLE_PAST(),
	});
	fix.setFlushWriteOutcome("deferred");

	const result = await fix.controller.restoreFileFromServerState(fix.path);
	assertEq(result.ok, false, "deferred write reports failure");
	assertEq(result.reason, "remote-projection-not-ready", "defer reason surfaced to the caller");
	assertEq(fix.setValues.length, 1, "panes still aligned with the synced text first");
	assertEq(fix.setValues[0], "REMOTE-DEF", "pane holds the server version while disk lags");
	assert(
		fix.discarded.some((entry) => entry.reason === "manual-restore-from-server"),
		"local revision audited before the write attempt",
	);
}

console.log("\n--- HTTP repair projection refuses stale review and late editor changes ---");
{
	const fix = buildFixture({ path: "Notes/http-repair.md", disk: "disk C", editor: "editor D", crdt: "server A", lastEditorActivity: IDLE_PAST() });
	const authority = { expectedFile: fix.file, expectedDiskContent: "disk C", expectedServerContent: "server A", isCurrent: () => true };
	const changedServer = await fix.controller.restoreFileFromServerState(fix.path, { ...authority, expectedServerContent: "old server" });
	assertEq(changedServer.ok, false, "a replaced reviewed server version cannot project");
	fix.setDiskContent("new disk edit");
	const changedDisk = await fix.controller.restoreFileFromServerState(fix.path, authority);
	assertEq(changedDisk.ok, false, "a new disk edit cannot be overwritten by the repair");
	fix.setDiskContent("disk C");
	fix.setAuditHook(() => fix.setEditorContent("new editor edit"));
	const changedPane = await fix.controller.restoreFileFromServerState(fix.path, authority);
	assertEq(changedPane.ok, false, "an edit during durable audit cannot be overwritten");
	assertEq(fix.setValues.length, 0, "failed authority guards preserve the pane");
	assertEq(fix.flushWriteCalls, 0, "failed authority guards never start the disk write");
}

console.log("\n--- Test 10: resolveDivergenceKeepLocal pushes local to CRDT and disk with idle guard & CAS ---");
{
	const fix = buildFixture({
		path: "Notes/keep-local.md",
		disk: "OLD-LOCAL",
		editor: "NEW-LOCAL",
		crdt: "SYNCED-SERVER",
		lastEditorActivity: Date.now(),
	});

	const activeResult = await fix.controller.resolveDivergenceKeepLocal(fix.path, "NEW-LOCAL");
	assertEq(activeResult.ok, false, "active typing rejects resolveDivergenceKeepLocal");
	assertEq(activeResult.reason, "editor-active", "active typing reports editor-active reason");

	fix.setLastEditorActivity(IDLE_PAST());
	const result = await fix.controller.resolveDivergenceKeepLocal(fix.path, "NEW-LOCAL");
	assertEq(result.ok, true, "idle resolveDivergenceKeepLocal succeeds");
	assertEq(fix.ytext.toString(), "NEW-LOCAL", "CRDT received the local content");
	assertEq(fix.diskContent, "NEW-LOCAL", "disk file updated with local content");
	assert(
		fix.discarded.some((entry) => entry.reason === "manual-resolve-keep-local"),
		"prior server content audited to discarded revisions before overwrite",
	);
	assert(
		fix.clearedDivergences.includes(fix.path),
		"unbound divergence indicator cleared for path",
	);

	// CAS deferral guard
	const casFix = buildFixture({
		path: "Notes/keep-local-cas.md",
		disk: "OLD-LOCAL",
		editor: "NEW-LOCAL",
		crdt: "SYNCED-SERVER",
		lastEditorActivity: IDLE_PAST(),
	});
	casFix.setFlushWriteOutcome("deferred");
	const casResult = await casFix.controller.resolveDivergenceKeepLocal(casFix.path, "NEW-LOCAL");
	assertEq(casResult.ok, false, "unsettled disk write fails keep-local");
	assertEq(casResult.reason, "remote-projection-not-ready", "CAS failure surfaced to caller");
}

console.log("\n--- Test 11: resolveDivergenceKeepBoth creates conflict copy and restores original with rollback ---");
{
	const fix = buildFixture({
		path: "Notes/keep-both.md",
		disk: "LOCAL-DIFF",
		editor: "LOCAL-DIFF",
		crdt: "SYNCED-SERVER",
		lastEditorActivity: Date.now(),
	});

	const activeResult = await fix.controller.resolveDivergenceKeepBoth(fix.path, "LOCAL-DIFF");
	assertEq(activeResult.ok, false, "active typing rejects keep-both");
	assertEq(activeResult.reason, "editor-active", "active typing reports editor-active");
	assertEq(fix.createdFiles.length, 0, "no conflict copy created when editor is active");

	fix.setLastEditorActivity(IDLE_PAST());
	const result = await fix.controller.resolveDivergenceKeepBoth(fix.path, "LOCAL-DIFF");
	assertEq(result.ok, true, "idle resolveDivergenceKeepBoth succeeds");
	assert(
		typeof result.conflictPath === "string" && result.conflictPath.includes("keep-both (Local conflict"),
		`conflict copy path format valid: ${String(result.conflictPath)}`,
	);
	assert(
		fix.createdFiles.some((f) => f.path === result.conflictPath && f.data === "LOCAL-DIFF"),
		"local content safely stored in new conflict note",
	);
	assertEq(fix.setValues[0], "SYNCED-SERVER", "original note editor reset to synced server copy");

	// Rollback on restore failure
	const rollbackFix = buildFixture({
		path: "Notes/keep-both-fail.md",
		disk: "LOCAL-DIFF",
		editor: "LOCAL-DIFF",
		crdt: "SYNCED-SERVER",
		lastEditorActivity: IDLE_PAST(),
	});
	rollbackFix.setFlushWriteOutcome("deferred");
	const failResult = await rollbackFix.controller.resolveDivergenceKeepBoth(rollbackFix.path, "LOCAL-DIFF");
	assertEq(failResult.ok, false, "restore failure causes keep-both to fail");
	assertEq(rollbackFix.createdFiles.length, 0, "conflict copy cleaned up when restore fails (no duplicates on retry)");
}

console.log("\n--- Test 12: markDivergenceConverged clears evidence and revalidates binding ---");
{
	const fix = buildFixture({
		path: "Notes/converged.md",
		disk: "SAME",
		editor: "SAME",
		crdt: "SAME",
		lastEditorActivity: IDLE_PAST(),
	});

	fix.controller["automaticRecoveryHolds"].set(fix.ytext, {
		path: fix.path,
		detail: "initial-authority-unverified",
		episode: 1,
	});
	assertEq(fix.controller["automaticRecoveryHolds"].has(fix.ytext), true, "hold present before converged cleanup");

	const result = await fix.controller.markDivergenceConverged(fix.path);
	assertEq(result.ok, true, "markDivergenceConverged succeeds");
	assertEq(fix.controller["automaticRecoveryHolds"].has(fix.ytext), false, "hold cleared after converged cleanup");
	assert(
		fix.clearedDivergences.includes(fix.path),
		"stale unbound divergence evidence cleared",
	);
	assert(
		fix.validations.includes("divergence-converged"),
		"binding revalidation requested for converged note",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
