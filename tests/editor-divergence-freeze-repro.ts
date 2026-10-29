/**
 * Reproduction & Convergence Tests: Editor Divergence Silent Freeze / Deadlock.
 *
 * Topology under test (User Reported Incident):
 * 1. An open editor experiences transient divergence (e.g. typing Korean ahead of CRDT).
 *    CRDT has:  "✍️ 이번 주 목표\n\t•\tㅁㄴㅇㄹㄴㅇㄹㄴㅇㄹㄴㄹㄴㄹㄴㄹ\n\t•\t이제 제대"
 *    Editor has: "✍️ 이번 주 목표\n\t•\tㅁㄴㅇㄹ\n\t•\t이제 제대로 연결이 안되어서 그런거 같다"
 * 2. `resolveBindingTarget` skips binding because `currentContent !== crdtContent`.
 * 3. The editor is left UNBOUND (missing `yCollab` facet, not in `bindings`).
 * 4. Obsidian autosaves editor content to disk.
 * 5. `syncFileFromDisk` attempts automatic recovery.
 * 6. `admitAutomaticRecovery` checks `getLocalOnlyRecoveryEvidenceForView(view)`.
 *    Because the editor is UNBOUND, evidence is null.
 * 7. `localOnlyRecoveryBlockReason` returns `"initial-authority-unverified"`.
 * 8. Controller holds the file in `automaticRecoveryHolds`.
 * 9. CRDT never gets updated -> Editor never matches CRDT -> Editor can never bind.
 *    Result: Silent permanent freeze / split-brain deadlock.
 */

import { createHash } from "node:crypto";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { RemoteTextRevisionTracker } from "../src/sync/remoteTextRevisionTracker";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import { EditorBindingManager } from "../src/sync/editorBinding";
import { CompositionAwareYSyncPluginValue } from "../src/sync/compositionAwareYSync";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import { normalizeEditorText } from "../src/utils/editorTextNormalization";

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
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

function baselineHashSync(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

const CRDT_INITIAL = "✍️ 이번 주 목표\n\t•\tㅁㄴㅇㄹㄴㅇㄹㄴㅇㄹㄴㄹㄴㄹㄴㄹ\n\t•\t이제 제대";
const LOCAL_AHEAD = "✍️ 이번 주 목표\n\t•\tㅁㄴㅇㄹㄴㅇㄹㄴㅇㄹㄴㄹㄴㄹㄴㄹ\n\t•\t이제 제대로 연결이 안되어서 그런거 같다";

interface ReproFixture {
	path: string;
	ytext: Y.Text;
	manager: EditorBindingManager;
	controller: ReconciliationController;
	view: MarkdownView;
	diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }>;
	setEditorContent(c: string): void;
	setDiskContent(c: string): void;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildReproFixture(): ReproFixture {
	const path = "Tasks.md";
	let diskContent = LOCAL_AHEAD;
	let editorContent = LOCAL_AHEAD;

	const doc = new Y.Doc();
	const provider = {};
	const texts = doc.getMap<Y.Text>("idToText");
	const tracker = new RemoteTextRevisionTracker(doc, texts, () => provider, () => null);
	const ytext = new Y.Text(CRDT_INITIAL);
	texts.set("stub-file-id", ytext);

	const awarenessStates = new Map<number, Record<string, unknown>>([[1, {}]]);
	const providerAwareness = {
		provider: true,
		clientID: 1,
		getStates: () => awarenessStates,
		setLocalStateField: () => {},
	};

	const vaultSync = {
		provider: { awareness: providerAwareness },
		remoteTextRevisions: tracker,
		getRemoteTextRevisionForPath: (p: string) => (p === path ? tracker.get(ytext, "stub-file-id") : null),
		getTextForPath: (p: string) => (p === path ? ytext : null),
		getFileId: () => "stub-file-id",
		getFileIdForText: () => "stub-file-id",
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		isMarkdownTombstoned: () => false,
		ensureFile: () => null,
	};

	let diskIngestPort: DiskIngestPort | null = null;
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {
		[path]: {
			mtime: 0,
			size: CRDT_INITIAL.length,
			contentHash: baselineHashSync(CRDT_INITIAL),
		},
	};

	const cmDom = { isConnected: true };
	const cm = {
		dom: cmDom,
		hasFocus: true,
		state: {
			doc: {
				get length() { return editorContent.length; },
				toString: () => editorContent,
			},
			facet: () => ({
				ytext,
				awareness: { stale: false },
				undoManager: null,
			}),
		},
		dispatch: () => {},
	};

	const file = makeTFile(path);
	const view = Object.assign(new MarkdownView(), {
		file,
		leaf: { id: "leaf-tasks-1" },
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: {
			getValue: () => editorContent,
			setValue: (val: string) => { editorContent = val; },
		},
	}) as MarkdownView;

	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		() => true,
		() => {},
		() => {},
		undefined,
		undefined,
		() => {},
		() => false,
	);

	// Mock cm view resolution on the manager
	(manager as unknown as { getCmView: (v: MarkdownView) => unknown }).getCmView = () => cm;

	let isOpen = true;
	const app = {
		vault: {
			read: async (f: TFile & { path: string }) => {
				if (f.path !== path) throw new Error(`unexpected read: ${f.path}`);
				return diskContent;
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === path ? file : null),
			getMarkdownFiles: () => [file],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	let editorRevision = 0;
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
			clearPreservedUnresolved: () => {},
			flushWrite: async (flushPath: string) => ({
				kind: "written" as const,
				path: flushPath,
				isCreate: false,
				content: ytext.toString(),
				contentHash: baselineHashSync(ytext.toString()),
				baselineRecorded: true,
			}),
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => manager as never,
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
		computeRecoveryStateHash: async () => "fixture-hash",
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent: () => {},
		recordFlightPathEvent: () => {},
		recordDiscardedRevision: () => {},
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
	});

	return {
		path,
		ytext,
		manager,
		controller,
		view,
		diskIndex,
		setEditorContent: (c) => { editorContent = c; },
		setDiskContent: (c) => { diskContent = c; },
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
	};
}

console.log("\n--- Test 1: Immediate bind refusal preserves editor without blind overwrite ---");
{
	const fix = buildReproFixture();

	// 1. Initial bind attempt while editor is ahead of CRDT
	fix.manager.bind(fix.view, "TestDevice");

	// 2. Editor binding is refused because content diverged (not blindly applied)
	assertEq(fix.manager.isBound(fix.path), false, "editor remains unbound when content diverged from CRDT");
	assertEq(fix.ytext.toString(), CRDT_INITIAL, "CRDT is not blindly overwritten during bind");
}

console.log("\n--- Test 2: Safe Convergence Contract (Expected Safe Resolution) ---");
{
	const fix = buildReproFixture();

	// 1. Initial bind attempt while editor is ahead of CRDT
	fix.manager.bind(fix.view, "TestDevice");

	// 2. Unbound editor divergence is safely tracked, providing pane evidence
	const evidence = fix.manager.getLocalOnlyRecoveryEvidenceForView(fix.view);
	assert(evidence !== null, "diverged open view provides certified recovery evidence");
	assertEq(evidence?.localSuccessor, true, "evidence marks local successor");
	assertEq(evidence?.content, normalizeEditorText(LOCAL_AHEAD), "evidence carries current editor content");

	// 3. User typing was autosaved to disk by Obsidian (disk === editor)
	await fix.ingestDiskFileNow("modify");

	// 4. Recovery should be ADMITTED safely:
	const holds = fix.controller.getAutomaticRecoveryHolds();
	assertEq(holds.length, 0, "no automatic recovery hold when local successor is admitted");
	assertEq(fix.ytext.toString(), LOCAL_AHEAD, "CRDT safely advances to local typing when remote has not advanced");

	// 5. Post-recovery binding check (repair/status-tick) safely attaches yCollab
	assertEq(fix.manager.isBound(fix.path), true, "Editor binding is safely established after convergence");
}

console.log("\n--- Test 3: Safety Fence: Remote Advanced Concurrent Edit (Must Hold) ---");
{
	const fix = buildReproFixture();

	// 1. Initial bind attempt while editor is ahead
	fix.manager.bind(fix.view, "TestDevice");

	// 2. Simulate remote concurrent edit arriving from provider
	// Remote provider changes CRDT to include remote user's edits
	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	const remoteProviderOrigin = {};
	(fix.manager as unknown as { vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker } })
		.vaultSync.remoteTextRevisions.registerEditorOrigin(remoteProviderOrigin);
	// We simulate a remote edit by directly altering the revision tracker's remote state
	const tracker = (fix.manager as unknown as { vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker } })
		.vaultSync.remoteTextRevisions;
	// Advance text with provider origin
	doc.transact(() => {
		fix.ytext.insert(fix.ytext.length, "\n• 원격 동료의 수정");
	}, (tracker as unknown as { provider: () => unknown }).provider());

	// 3. Disk ingest runs
	await fix.ingestDiskFileNow("modify");

	// 4. Must NOT overwrite remote! Contamination gate must hold!
	const holds = fix.controller.getAutomaticRecoveryHolds();
	assert(holds.length > 0, "recovery must be blocked when remote advanced concurrently");
	assert(fix.ytext.toString().includes("원격 동료의 수정"), "CRDT must preserve remote edits");
	assert(fix.ytext.toString() !== LOCAL_AHEAD, "CRDT must NOT be overwritten by local disk");
}

console.log("\n--- Test 4: Safety Fence: Ancient Divergence (Must Fail-Closed to Hold) ---");
{
	const fix = buildReproFixture();

	// 1. Initial bind attempt
	fix.manager.bind(fix.view, "TestDevice");

	// 2. Simulate divergence being ancient (e.g. 10 minutes ago, exceeding 5 minute cap)
	const unboundViews = (fix.manager as unknown as {
		unboundDivergedViews: Map<string, { divergedAtMs: number }>;
	}).unboundDivergedViews;
	const entry = unboundViews?.get("leaf-tasks-1");
	if (entry) {
		entry.divergedAtMs = Date.now() - 600_000; // 10 minutes ago
	}

	// 3. Disk ingest runs
	await fix.ingestDiskFileNow("modify");

	// 4. Ancient tab must NOT auto-recover; must fail-closed to hold / manual resolution
	const holds = fix.controller.getAutomaticRecoveryHolds();
	assertEq(holds.length, 1, "ancient divergence fails closed to hold");
	assertEq(holds[0]?.detail, "initial-authority-unverified", "ancient divergence hold detail is initial-authority-unverified");
	assertEq(fix.ytext.toString(), CRDT_INITIAL, "CRDT untouched for ancient divergence");
}

console.log("\n--- Test 5: Stale Tab Auto-Convergence (CRDT Wins) ---");
{
	const fix = buildReproFixture();
	const V1 = "✍️ 이전 버전 1\n• 구버전 항목";
	const REMOTE_ADDED = "\n• 원격 최신 추가";

	// 1. 디스크와 에디터는 "v1", 베이스라인도 "v1"
	fix.setDiskContent(V1);
	fix.setEditorContent(V1);
	fix.diskIndex[fix.path] = {
		mtime: 0,
		size: V1.length,
		contentHash: baselineHashSync(V1),
	};

	// 2. CRDT를 provider-origin으로 "v1" + 원격 추가
	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	const tracker = (fix.manager as unknown as { vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker } })
		.vaultSync.remoteTextRevisions;
	doc.transact(() => {
		fix.ytext.delete(0, fix.ytext.length);
		fix.ytext.insert(0, V1 + REMOTE_ADDED);
	}, (tracker as unknown as { provider: () => unknown }).provider());

	// 3. Initial bind attempt: editor diverged from CRDT, so bind is refused
	fix.manager.bind(fix.view, "TestDevice");
	assertEq(fix.manager.isBound(fix.path), false, "editor remains unbound before convergence");

	// 4. Ingest disk file (modify event)
	await fix.ingestDiskFileNow("modify");

	// 5. Assert: ytext preserved ("v1" + remote), holds 0, editor content == CRDT, rebind succeeded
	const holds = fix.controller.getAutomaticRecoveryHolds();
	assertEq(holds.length, 0, "no automatic recovery hold on stale tab convergence");
	assertEq(fix.ytext.toString(), V1 + REMOTE_ADDED, "CRDT content preserved without regression");
	assertEq(fix.view.editor.getValue(), V1 + REMOTE_ADDED, "editor content refreshed to match CRDT");
	assertEq(fix.manager.isBound(fix.path), true, "editor safely re-bound after stale tab convergence");
}

console.log("\n--- Test 6: Missing Baseline Fail-Closed (Must Hold) ---");
{
	const fix = buildReproFixture();
	const V1 = "✍️ 이전 버전 1\n• 구버전 항목";
	const REMOTE_ADDED = "\n• 원격 최신 추가";

	// 1. 디스크와 에디터는 "v1", 하지만 diskIndex.contentHash 제거 (null / undefined)
	fix.setDiskContent(V1);
	fix.setEditorContent(V1);
	delete fix.diskIndex[fix.path]?.contentHash;

	// 2. CRDT를 provider-origin으로 "v1" + 원격 추가
	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	const tracker = (fix.manager as unknown as { vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker } })
		.vaultSync.remoteTextRevisions;
	doc.transact(() => {
		fix.ytext.delete(0, fix.ytext.length);
		fix.ytext.insert(0, V1 + REMOTE_ADDED);
	}, (tracker as unknown as { provider: () => unknown }).provider());

	// 3. Initial bind attempt
	fix.manager.bind(fix.view, "TestDevice");

	// 4. Ingest disk file
	await fix.ingestDiskFileNow("modify");

	// 5. Assert: holds 1, detail "unverified-local-successor", ytext untouched
	const holds = fix.controller.getAutomaticRecoveryHolds();
	assertEq(holds.length, 1, "missing baseline fails closed to hold");
	assertEq(holds[0]?.detail, "unverified-local-successor", "hold detail is unverified-local-successor");
	assertEq(fix.ytext.toString(), V1 + REMOTE_ADDED, "CRDT untouched for missing baseline");
}

console.log("\n--- Test 7: Stale Tab Typing Safety Fence (P2: User typing preserved without blind overwrite) ---");
{
	const fix = buildReproFixture();
	const V1 = "✍️ 이전 버전 1\n• 구버전 항목";
	const REMOTE_ADDED = "\n• 원격 최신 추가";
	const USER_TYPED = "\n• 방금 내가 작성한 글";

	// 1. 디스크와 베이스라인은 "v1"
	fix.setDiskContent(V1);
	fix.setEditorContent(V1);
	fix.diskIndex[fix.path] = {
		mtime: 0,
		size: V1.length,
		contentHash: baselineHashSync(V1),
	};

	// 2. CRDT를 provider-origin으로 "v1" + 원격 추가
	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	const tracker = (fix.manager as unknown as { vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker } })
		.vaultSync.remoteTextRevisions;
	doc.transact(() => {
		fix.ytext.delete(0, fix.ytext.length);
		fix.ytext.insert(0, V1 + REMOTE_ADDED);
	}, (tracker as unknown as { provider: () => unknown }).provider());

	// 3. Initial bind attempt: editor diverged from CRDT, so bind is refused
	fix.manager.bind(fix.view, "TestDevice");

	// 4. 사용자가 스테일 탭에 타이핑함 (에디터 내용 변경, 디스크는 아직 미저장)
	fix.setEditorContent(V1 + USER_TYPED);

	// 5. Ingest disk file (modify event)
	await fix.ingestDiskFileNow("modify");

	// 6. Assert: 사용자의 타이핑이 덮어쓰여지지 않고 보존되어야 함
	assertEq(fix.view.editor.getValue(), V1 + USER_TYPED, "user typing is not overwritten by CRDT projection");
	assertEq(fix.ytext.toString(), V1 + REMOTE_ADDED, "CRDT content preserved");
}

console.log("\n--- Test 8: Binding target self-heals transient local composition residue before unbinding ---");
{
	const fix = buildReproFixture();
	const INITIAL = "Initial content";
	const LOCAL_IME = "Initial content with local hangul 한글";

	// 1. Initial agreement: both editor and CRDT start at INITIAL
	fix.setEditorContent(INITIAL);
	fix.setDiskContent(INITIAL);
	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	doc.transact(() => {
		fix.ytext.delete(0, fix.ytext.length);
		fix.ytext.insert(0, INITIAL);
	});

	// Mock CM view with CompositionAwareYSyncPluginValue (agreed on INITIAL)
	const cm = (fix.manager as unknown as { getCmView: (v: MarkdownView) => any }).getCmView(fix.view);
	const plugin = new CompositionAwareYSyncPluginValue(cm as never);

	// 2. User types Hangul during composition: editor has LOCAL_IME, ytext still has INITIAL
	fix.setEditorContent(LOCAL_IME);
	fix.setDiskContent(LOCAL_IME);

	// Calling bind() on fix.view: resolveBindingTarget will probe flushCompositionResidue(cm),
	// which will push LOCAL_IME to ytext, healing the divergence and allowing clean binding!
	fix.manager.bind(fix.view, "TestDevice");
	assertEq(fix.manager.isBound(fix.path), true, "binding succeeds via self-healing composition residue flush");
	assertEq(fix.ytext.toString(), LOCAL_IME, "ytext converged to editor content");

	plugin.destroy();
}

console.log("\n--- Test 9: Binding target probe refuses to overwrite advanced CRDT when editor is stale ---");
{
	const fix = buildReproFixture();
	const V1 = "Original baseline content";
	const REMOTE_ADVANCED = "Original baseline content + remote edits from phone";

	fix.setEditorContent(V1);
	fix.setDiskContent(V1);

	const doc = (fix.ytext as unknown as { doc: Y.Doc }).doc;
	doc.transact(() => {
		fix.ytext.delete(0, fix.ytext.length);
		fix.ytext.insert(0, REMOTE_ADVANCED);
	});

	// Mock CM view with CompositionAwareYSyncPluginValue
	const cm = (fix.manager as unknown as { getCmView: (v: MarkdownView) => any }).getCmView(fix.view);
	const plugin = new CompositionAwareYSyncPluginValue(cm as never);

	// Editor has stale V1, ytext has REMOTE_ADVANCED.
	// bind() must NOT overwrite REMOTE_ADVANCED with V1!
	// flushCompositionResidue should identify plan.kind === "projection-only" and refuse to push.
	fix.manager.bind(fix.view, "TestDevice");
	assertEq(fix.ytext.toString(), REMOTE_ADVANCED, "CRDT remote advancement preserved against stale editor probe");
	assertEq(fix.manager.isBound(fix.path), false, "stale editor remains unbound to prevent split-brain");

	plugin.destroy();
}

console.log("\n--- Test 10: Production onConflict wiring (handleCompositionConflict) on a real manager ---");
{
	const fix = buildReproFixture();
	const internals = fix.manager as unknown as {
		onEditorDocChanged?: () => void;
		bindings: Map<string, unknown>;
		recoveryEvidence: WeakMap<object, { invalidate: () => void }>;
		unboundDivergedViews: Map<string, {
			view: unknown; path: string; crdtText: unknown; baseContent?: string | null;
			lastObservedEditorContent: string; remoteRevision: number; authorityRevision: number; scope: object;
		}>;
		vaultSync: { remoteTextRevisions: RemoteTextRevisionTracker };
		handleCompositionConflict: (
			leafId: string, view: MarkdownView, ytext: Y.Text, filePath: string,
			info: { base: string; editor: string; ytext: string },
		) => void;
	};
	let statusRefreshes = 0;
	internals.onEditorDocChanged = () => { statusRefreshes++; };
	const notified: string[] = [];
	const unsubscribe = fix.manager.subscribeRecoveryEvidence((p) => notified.push(p));

	// A live binding whose linear evidence chain must be invalidated.
	const fakeBinding = { path: fix.path };
	let invalidated = false;
	internals.bindings.set("leaf-tasks-1", fakeBinding);
	internals.recoveryEvidence.set(fakeBinding, { invalidate: () => { invalidated = true; } });

	const info = { base: "base text", editor: "local edit", ytext: CRDT_INITIAL };
	internals.handleCompositionConflict("leaf-tasks-1", fix.view, fix.ytext, fix.path, info);

	assert(invalidated, "conflict invalidates the bound leaf's linear recovery evidence");
	assertEq(notified.join(","), fix.path, "recovery-evidence listeners notified with the note path");
	assertEq(statusRefreshes, 1, "status bar refreshed immediately on conflict (online visibility)");

	const rev = internals.vaultSync.remoteTextRevisions.get(fix.ytext, "stub-file-id");
	const entry = internals.unboundDivergedViews.get("leaf-tasks-1");
	if (rev) {
		assert(entry !== undefined, "divergence evidence registered for the leaf");
		assert(entry?.crdtText === fix.ytext, "divergence evidence keeps the live Y.Text (not a string copy)");
		assertEq(entry?.baseContent ?? null, info.base, "divergence evidence carries the 3-way base");
		assertEq(entry?.lastObservedEditorContent ?? null, info.editor, "divergence evidence records editor content");
		assertEq(entry?.remoteRevision ?? null, rev.remoteRevision, "divergence evidence pinned to current remote revision");
		assert(entry?.view === fix.view && entry?.path === fix.path, "divergence evidence bound to the same view/path");
	} else {
		assert(entry === undefined, "no revision -> no divergence evidence (read side would reject it anyway)");
	}

	internals.bindings.delete("leaf-tasks-1");
	unsubscribe();
}

if (failed > 0) {
	console.error(`\nSuite failed: ${failed} failure(s)`);
	process.exit(1);
} else {
	console.log(`\nSuite passed: ${passed} test(s) passed`);
	process.exit(0);
}
