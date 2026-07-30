import * as Y from "yjs";
import { spawnSync } from "node:child_process";
import { Annotation, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { YSyncConfig, ySyncFacet } from "y-codemirror.next";
import { MarkdownView } from "obsidian";
import {
	createEditorBindingBootSessionId,
	EditorBindingManager,
	type InterceptedExternalDiskMutation,
} from "../src/sync/editorBinding";
import { EditorWorkspaceOrchestrator } from "../src/runtime/editorWorkspaceOrchestrator";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_RESTORE,
} from "../src/sync/origins";
import { PRODUCT_EVENT_KIND } from "../src/observability/productEventKinds";
import {
	buildTypingAwareness,
	KAOS_ACTIVE_FILE_AWARENESS_FIELD,
	KAOS_TYPING_AWARENESS_FIELD,
} from "../src/sync/remoteTypingGuard";
import { isMarkdownSyncable } from "../src/types";
import { normalizeEditorText } from "../src/utils/editorTextNormalization";
import {
	reduceManagedLeafSession,
	reserveManagedLeafInputStart,
	type ManagedLeafSession,
	type PendingHostLoadCandidate,
} from "../src/sync/editorHandoffState";

let passed = 0;
let failed = 0;
let externalDiskMutationSequence = 0;

function externalDiskMutationNotice(
	path: string,
	content: string,
	mtime = Date.now(),
	metadata: Partial<Pick<
		InterceptedExternalDiskMutation,
		"ctime" | "mtime" | "size" | "sequence" | "observedAt"
	>> = {},
): InterceptedExternalDiskMutation {
	return {
		path,
		ctime: metadata.ctime ?? 1,
		mtime: metadata.mtime ?? mtime,
		size: metadata.size ?? new TextEncoder().encode(content).byteLength,
		sequence: metadata.sequence ?? ++externalDiskMutationSequence,
		observedAt: metadata.observedAt ?? Date.now(),
		content,
	};
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

function assertCandidateMatchesNotice(
	candidate: InterceptedExternalDiskMutation | undefined,
	expected: InterceptedExternalDiskMutation,
	label: string,
): void {
	assertEq(candidate !== undefined, true, `${label}: candidate exists`);
	if (!candidate) return;
	assertEq(candidate.path, expected.path, `${label}: path is exact`);
	assertEq(candidate.ctime, expected.ctime, `${label}: ctime is exact`);
	assertEq(candidate.mtime, expected.mtime, `${label}: mtime is exact`);
	assertEq(candidate.size, expected.size, `${label}: size is exact`);
	assertEq(candidate.sequence, expected.sequence, `${label}: sequence is exact`);
	assertEq(candidate.observedAt, expected.observedAt, `${label}: observedAt is exact`);
	assertEq(candidate.content, expected.content, `${label}: raw content is exact`);
	assertEq(
		normalizeEditorText(candidate.content),
		normalizeEditorText(expected.content),
		`${label}: normalized editor text is reproducible`,
	);
	assertEq(Object.isFrozen(candidate), true, `${label}: candidate is frozen`);
}

function clearPendingHealthChecks(manager: unknown): void {
	const pending = (manager as { pendingHealthChecks?: Map<string, ReturnType<typeof setTimeout>> })
		.pendingHealthChecks;
	for (const timer of pending?.values() ?? []) {
		clearTimeout(timer);
	}
	pending?.clear();

	const pendingCm = (manager as { pendingCmResolveRetries?: Map<string, ReturnType<typeof setTimeout>> })
		.pendingCmResolveRetries;
	for (const timer of pendingCm?.values() ?? []) {
		clearTimeout(timer);
	}
	pendingCm?.clear();

	const pendingPresentation = (manager as {
		pendingTargetPresentationRetries?: Map<string, ReturnType<typeof setTimeout>>;
	}).pendingTargetPresentationRetries;
	for (const timer of pendingPresentation?.values() ?? []) {
		clearTimeout(timer);
	}
	pendingPresentation?.clear();
	(manager as { targetPresentationRetryAttempts?: Map<string, number> })
		.targetPresentationRetryAttempts?.clear();

	const pendingTarget = (manager as {
		pendingTargetBindingRetries?: Map<string, ReturnType<typeof setTimeout>>;
	}).pendingTargetBindingRetries;
	for (const timer of pendingTarget?.values() ?? []) {
		clearTimeout(timer);
	}
	pendingTarget?.clear();
	(manager as { targetBindingRetryAttempts?: Map<string, number> })
		.targetBindingRetryAttempts?.clear();

	const pendingUnmanage = (manager as {
		pendingUnmanageRetries?: Map<string, ReturnType<typeof setTimeout>>;
	}).pendingUnmanageRetries;
	for (const timer of pendingUnmanage?.values() ?? []) {
		clearTimeout(timer);
	}
	pendingUnmanage?.clear();
}

function captureSingleMicrotask(action: () => void): () => void {
	const originalQueueMicrotask = globalThis.queueMicrotask;
	let captured: (() => void) | null = null;
	globalThis.queueMicrotask = (callback) => {
		if (captured) throw new Error("Expected one queued microtask");
		captured = callback;
	};
	try {
		action();
	} finally {
		globalThis.queueMicrotask = originalQueueMicrotask;
	}
	if (!captured) throw new Error("Expected a queued microtask");
	return captured;
}

function captureNodeTimerCallback(timer: unknown): () => void {
	const callback = (timer as { _onTimeout?: () => void })._onTimeout;
	if (typeof callback !== "function") throw new Error("Expected a Node timeout callback");
	return () => callback.call(timer);
}

function recordExpectedEditorYTextPatch(
	manager: unknown,
	binding: { path: string; ytext: Y.Text },
): void {
	const candidate = (manager as {
		recentEditorOriginChanges: Map<string, {
			leafId: string;
			expectedYTextOrigin: unknown;
		}>;
	}).recentEditorOriginChanges.get(binding.path);
	if (!candidate) {
		throw new Error(`Missing recent editor-origin candidate for ${binding.path}`);
	}
	(manager as {
		recordYTextPatch: (
			ytext: Y.Text,
			path: string,
			leafId: string,
			transaction: Y.Transaction,
		) => void;
	}).recordYTextPatch(
		binding.ytext,
		binding.path,
		candidate.leafId,
		{ origin: candidate.expectedYTextOrigin } as Y.Transaction,
	);
}

function installManagedBoundaryStubs(
	manager: EditorBindingManager,
	view: { leaf: { id: string } },
	cm: unknown,
): void {
	manager.manageView(view as never);
	const runtime = (manager as unknown as {
		managedSessions: Map<string, { hostGuard: unknown; cmGuard: unknown }>;
	}).managedSessions.get(view.leaf.id);
	if (!runtime) throw new Error("Expected fixture managed runtime");
	let hostMode: { kind: string; [key: string]: unknown } = { kind: "pass-through" };
	let cmInert = false;
	let gateClosed = false;
	runtime.hostGuard = {
		beginBlockingHandoff: (input: Record<string, unknown>) => {
			hostMode = { kind: "blocking-handoff", ...input };
		},
		markTargetProven: () => true,
		reportHostLoadCandidate: () => true,
		reportHostLoadCompleted: () => true,
		flushOwnedSave: () => Promise.resolve(),
		cancelOwnedSave: () => {},
		markInert: () => { hostMode = { kind: "inert-pass-through" }; },
		restoreIfCurrent: () => { hostMode = { kind: "inert-pass-through" }; },
		snapshot: () => ({
			leafId: view.leaf.id,
			view,
			hostCapability: "public-cancellable",
			hostCapabilityState: "ready",
			saveEpoch: 0,
			clearLoadCapability: "observable",
			mode: hostMode,
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
		}),
	};
	runtime.cmGuard = {
		refreshGate: () => {
			gateClosed = manager.getManagedSession(view as never)?.handoff !== null;
			return true;
		},
		markInert: () => {
			cmInert = true;
			gateClosed = false;
			return true;
		},
		restoreIfCurrent: () => {
			cmInert = true;
			gateClosed = false;
			return true;
		},
		snapshot: () => ({
			view: cm,
			inert: cmInert,
			gateClosed,
			selectionEpoch: 0,
			scrollEpoch: 0,
			gateFailureReason: null,
			commitState: "none",
			pendingHostLoadCandidate: null,
		}),
	};
	manager.manageView(view as never);
}

function buildManagerFixture(options: {
	lastEditorChangeAgeMs: number;
	lastEditorDocChangeAgeMs?: number | null;
	externalReloadGuardEnabled?: () => boolean;
	installManagedGuardStubs?: boolean;
	onOpenPathAdmissionRequested?: (request: unknown) => void;
	onExternalDiskReloadIntercepted?: (
		candidate: InterceptedExternalDiskMutation,
	) => void;
}) {
	const flightEvents: Array<{ kind: string; data?: Record<string, unknown> }> = [];
	const traceRecords: Array<{
		source: string;
		msg: string;
		details?: Record<string, unknown>;
	}> = [];
	const interceptedExternalReloads: InterceptedExternalDiskMutation[] = [];
	const path = "Notes/typing.md";
	let liveEditorContent = "typing now";
	const liveFileStat = {
		ctime: 1,
		mtime: Date.now() - 10_123,
		size: new TextEncoder().encode(liveEditorContent).byteLength,
	};
	const doc = new Y.Doc();
	const expectedText = doc.getText("expected");
	expectedText.insert(0, "server text");
	const facetText = doc.getText("facet");
	facetText.insert(0, "old server text");

	const awarenessStates = new Map<number, Record<string, unknown>>([[1, {}]]);
	const providerAwareness = {
		provider: true,
		clientID: 1,
		getStates: () => awarenessStates,
		setLocalStateField: () => {},
	};
	const vaultSync = {
		provider: { awareness: providerAwareness },
		getTextForPath: (p: string) => (p === path ? expectedText : null),
		getFileId: () => "file-1",
		getFileIdForText: (text: Y.Text) => (text === expectedText ? "file-1" : "other-file"),
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: () => null,
	};

	const cmDom = { isConnected: true };
	const cm = {
		dom: cmDom,
		hasFocus: true,
		state: {
			doc: {
				get length() { return liveEditorContent.length; },
				toString: () => liveEditorContent,
			},
			facet: () => ({
				ytext: facetText,
				awareness: { stale: true },
				undoManager: null,
			}),
		},
		dispatch: () => {},
	};

	const workspace = {
		iterateAllLeaves(callback: (leaf: { view: unknown }) => void) {
			callback({ view });
		},
	};
	const view = {
		file: { path, stat: liveFileStat },
		leaf: { id: "leaf-1" },
		app: { workspace },
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: { getValue: () => liveEditorContent },
	};

	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p) => p.endsWith(".md"),
		(source, msg, details) => traceRecords.push({ source, msg, details }),
		(event) => {
			flightEvents.push({ kind: event.kind, data: event.data });
		},
		undefined,
		undefined,
		(candidate) => {
			interceptedExternalReloads.push(candidate);
			options.onExternalDiskReloadIntercepted?.(candidate);
		},
		options.externalReloadGuardEnabled,
		options.onOpenPathAdmissionRequested,
	);
	const binding = {
		view,
		file: view.file,
		path,
		undoManager: new Y.UndoManager(expectedText),
		ytext: expectedText,
		cm,
		cmId: "cm-1",
		fileId: "file-1",
		lastBoundAt: new Date().toISOString(),
		lastBoundAtMs: Date.now() - 10_000,
		lastEditorChangeAtMs: Date.now() - options.lastEditorChangeAgeMs,
		lastEditorDocChangeAtMs:
			options.lastEditorDocChangeAgeMs == null
				? null
				: Date.now() - options.lastEditorDocChangeAgeMs,
		settleWindowMs: 0,
	};

	(manager as unknown as { bindings: Map<string, unknown> }).bindings.set("leaf-1", binding);
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(cm);
	if (options.installManagedGuardStubs !== false) {
		installManagedBoundaryStubs(manager, view, cm);
	}
	return {
		manager,
		binding,
		flightEvents,
		traceRecords,
		awarenessStates,
		interceptedExternalReloads,
		setLiveEditorContent: (content: string) => { liveEditorContent = content; },
		setLiveFileStat: (mtime: number, size: number, ctime = liveFileStat.ctime) => {
			liveFileStat.ctime = ctime;
			liveFileStat.mtime = mtime;
			liveFileStat.size = size;
		},
	};
}

function installLiveCmReplacement(manager: unknown, binding: {
	cm: { dom: { isConnected: boolean }; state: unknown };
	view: { containerEl: { contains: (node: unknown) => boolean } };
}) {
	const liveDom = { isConnected: true };
	const liveCm = {
		dom: liveDom,
		hasFocus: true,
		state: binding.cm.state,
		dispatch: () => {},
	};
	binding.cm.dom.isConnected = false;
	binding.view.containerEl = { contains: (node: unknown) => node === liveDom };
	(manager as { knownCmViews: Set<unknown> }).knownCmViews.add(liveCm);
	installManagedBoundaryStubs(
		manager as EditorBindingManager,
		binding.view as never,
		liveCm,
	);
	return liveCm;
}

console.log("\n--- Test 0: editor binding boot IDs require cryptographic uniqueness ---");
{
	let cryptoUnavailableRejected = false;
	try {
		createEditorBindingBootSessionId(null);
	} catch (error) {
		cryptoUnavailableRejected = error instanceof Error
			&& error.message === "Secure editor binding boot-session ID is unavailable";
	}
	assertEq(
		cryptoUnavailableRejected,
		true,
		"missing cryptographic randomness fails closed instead of using time or Math.random",
	);

	let boot = 0;
	const cryptoSource = {
		getRandomValues(bytes: Uint8Array): Uint8Array {
			boot += 1;
			bytes.fill(boot);
			return bytes;
		},
	};
	const firstBoot = createEditorBindingBootSessionId(cryptoSource);
	const secondBoot = createEditorBindingBootSessionId(cryptoSource);
	assertEq(firstBoot === secondBoot, false, "two secure boot sessions receive distinct IDs");
	assertEq(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firstBoot),
		true,
		"getRandomValues fallback produces a canonical random UUID",
	);
}

console.log("\n--- Test 1: recent editor activity defers unhealthy binding repair ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	let repairCalls = 0;
	let rebindCalls = 0;
	(manager as unknown as { repair: () => boolean }).repair = () => {
		repairCalls++;
		return true;
	};
	(manager as unknown as { rebind: () => void }).rebind = () => {
		rebindCalls++;
	};

	(manager as unknown as {
		maybeHealBinding: (leafId: string, binding: unknown, source: string) => void;
	}).maybeHealBinding("leaf-1", binding, "retry-health-check");

	assertEq(repairCalls, 0, "repair is not called while the editor is actively changing");
	assertEq(rebindCalls, 0, "rebind is not called while the editor is actively changing");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 2: idle editor activity allows unhealthy binding repair ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	let repairCalls = 0;
	(manager as unknown as { repair: () => boolean }).repair = () => {
		repairCalls++;
		return true;
	};

	(manager as unknown as {
		maybeHealBinding: (leafId: string, binding: unknown, source: string) => void;
	}).maybeHealBinding("leaf-1", binding, "retry-health-check");

	assertEq(repairCalls, 1, "repair still runs after the editor has been idle");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 3: bind-health repair also defers during recent typing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	let repairCalls = 0;
	let rebindCalls = 0;
	(manager as unknown as { repair: () => boolean }).repair = () => {
		repairCalls++;
		return true;
	};
	(manager as unknown as { rebind: () => void }).rebind = () => {
		rebindCalls++;
	};

	manager.bind(binding.view as never, "TestDevice");

	assertEq(repairCalls, 0, "bind-health repair is not called while the editor is actively changing");
	assertEq(rebindCalls, 0, "bind-health rebind is not called while the editor is actively changing");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 4: idle bind-health repair still runs ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	let repairCalls = 0;
	(manager as unknown as { repair: () => boolean }).repair = () => {
		repairCalls++;
		return true;
	};

	manager.bind(binding.view as never, "TestDevice");

	assertEq(repairCalls, 1, "bind-health repair still runs after the editor has been idle");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 5: fresh binding without document edits may repair immediately ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: null,
	});
	let repairCalls = 0;
	(manager as unknown as { repair: () => boolean }).repair = () => {
		repairCalls++;
		return true;
	};

	(manager as unknown as {
		maybeHealBinding: (leafId: string, binding: unknown, source: string) => void;
	}).maybeHealBinding("leaf-1", binding, "retry-health-check");

	assertEq(repairCalls, 1, "repair is not delayed by bind-time bookkeeping alone");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 6: repair target-change rebind defers during recent typing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	installLiveCmReplacement(manager, binding);
	let rebindCalls = 0;
	(manager as unknown as { rebind: () => void }).rebind = () => {
		rebindCalls++;
	};

	const repaired = manager.repair(binding.view as never, "TestDevice", "cm-changed-test");

	assertEq(repaired, true, "repair cm-change path reports handled while deferred");
	assertEq(rebindCalls, 0, "repair cm-change does not rebind while the editor is actively changing");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 7: bind cm-change rebind defers during recent typing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const before = binding.lastEditorDocChangeAtMs ?? 0;
	const liveCm = installLiveCmReplacement(manager, binding);
	let unbindCalls = 0;
	(manager as unknown as { unbind: () => void }).unbind = () => {
		unbindCalls++;
	};

	manager.bind(binding.view as never, "TestDevice");
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: liveCm,
		docChanged: true,
		transactions: [{
			docChanged: true,
			annotation: () => "input.type",
			isUserEvent: (event: string) => event === "input",
		}],
	});

	assertEq(unbindCalls, 0, "bind cm-change path does not unbind while the editor is actively changing");
	assertEq(
		typeof binding.lastEditorDocChangeAtMs === "number" && binding.lastEditorDocChangeAtMs > before,
		true,
		"deferred cm replacement still tracks continued typing on the replacement editor",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 8: direct rebind defers during recent typing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	let unbindCalls = 0;
	let bindCalls = 0;
	(manager as unknown as { unbind: () => void }).unbind = () => {
		unbindCalls++;
	};
	(manager as unknown as { bind: () => void }).bind = () => {
		bindCalls++;
	};

	manager.rebind(binding.view as never, "TestDevice", "direct-rebind-test");

	assertEq(unbindCalls, 0, "direct rebind does not unbind while the editor is actively changing");
	assertEq(bindCalls, 0, "direct rebind does not bind while the editor is actively changing");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 9: remote-style editor transactions do not count as user activity ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const before = binding.lastEditorDocChangeAtMs;

	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [{
			docChanged: true,
			annotation: () => undefined,
			isUserEvent: () => false,
		}],
	});

	assertEq(binding.lastEditorDocChangeAtMs, before, "unannotated doc change leaves user activity timestamp unchanged");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 9a: editor-origin revisions distinguish programmatic edits from provider patches ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	const thirdPartyAnnotation = Annotation.define<boolean>();
	let state = EditorState.create({
		doc: "typing now",
		extensions: [
			manager.getBaseExtension(),
			// Forces CodeMirror to recreate the final Transaction after every filter.
			EditorState.transactionExtender.of(() => ({
				annotations: thirdPartyAnnotation.of(true),
			})),
		],
	});
	const installCmState = (next: EditorState) => {
		(binding.cm as unknown as { state: EditorState }).state = next;
		state = next;
	};
	installCmState(state);
	const activityBefore = binding.lastEditorDocChangeAtMs;
	const before = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	const programmaticTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: "plugin-applied document" },
	});
	installCmState(programmaticTransaction.state);
	setLiveEditorContent("plugin-applied document");
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "plugin-applied document");
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [programmaticTransaction],
	});
	const afterProgrammatic = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		afterProgrammatic.views[0]!.editorAuthorityRevision >
			before.views[0]!.editorAuthorityRevision,
		true,
		"programmatic CodeMirror edit advances editor authority revision",
	);
	assertEq(
		afterProgrammatic.views[0]!.editorAuthorityContent,
		"plugin-applied document",
		"authority ticket retains the exact programmatic successor document",
	);
	assertEq(
		binding.lastEditorDocChangeAtMs,
		activityBefore,
		"programmatic authority still does not masquerade as user activity",
	);

	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "provider document");
	const providerTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: "provider document" },
	});
	installCmState(providerTransaction.state);
	setLiveEditorContent("provider document");
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [providerTransaction],
	});
	const afterProvider = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		afterProvider.views[0]!.editorRevision >
			afterProgrammatic.views[0]!.editorRevision,
		true,
		"provider patch still advances the general mutation fence revision",
	);
	assertEq(
		afterProvider.views[0]!.editorAuthorityRevision,
		afterProgrammatic.views[0]!.editorAuthorityRevision,
		"provider patch does not advance editor authority revision",
	);
	assertEq(
		afterProvider.views[0]!.editorAuthorityContent,
		"plugin-applied document",
		"provider patch cannot relabel its document as editor-origin authority",
	);

	const filterFalseContent = "filter-disabled plugin document";
	const filterFalseTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: filterFalseContent },
		filter: false,
	});
	installCmState(filterFalseTransaction.state);
	setLiveEditorContent(filterFalseContent);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, filterFalseContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [filterFalseTransaction],
	});
	const afterFilterFalse = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		afterFilterFalse.views[0]!.editorAuthorityRevision >
			afterProvider.views[0]!.editorAuthorityRevision,
		true,
		"filter:false editor/API edit still advances editor authority",
	);
	assertEq(
		afterFilterFalse.views[0]!.editorAuthorityContent,
		filterFalseContent,
		"filter:false provenance carries the exact successor document",
	);

	const batchedLocalContent = "local member of a batched update";
	const batchedProviderContent = "provider member after local transaction";
	const batchedLocal = state.update({
		changes: { from: 0, to: state.doc.length, insert: batchedLocalContent },
	});
	installCmState(batchedLocal.state);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, batchedProviderContent);
	const batchedProvider = state.update({
		changes: { from: 0, to: state.doc.length, insert: batchedProviderContent },
	});
	installCmState(batchedProvider.state);
	setLiveEditorContent(batchedProviderContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [batchedLocal, batchedProvider],
	});
	const afterBatch = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		afterBatch.views[0]!.editorAuthorityContent,
		batchedLocalContent,
		"a later provider transaction in one ViewUpdate cannot steal local provenance",
	);
	assertEq(
		binding.lastEditorDocChangeAtMs,
		activityBefore,
		"all activityless provenance cases leave the user timestamp unchanged",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 9b: Y.Text-first patches stay out of native editor undo history ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	const beforeContent = "typing now";
	const providerContent = "provider and external merge content";
	const state = EditorState.create({
		doc: beforeContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, beforeContent);
	const cmFirstTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: "programmatic local content" },
	});
	assertEq(
		cmFirstTransaction.annotation(Transaction.addToHistory) === false,
		false,
		"CodeMirror-first edits remain eligible for native editor undo history",
	);
	const ordinarySetTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: "ordinary plugin set" },
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(
		ordinarySetTransaction.annotation(Transaction.addToHistory) === false,
		false,
		"ordinary editor set without a disk event remains undoable",
	);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, providerContent);

	const yTextFirstTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: providerContent },
	});

	assertEq(
		yTextFirstTransaction.annotation(Transaction.addToHistory),
		false,
		"non-user Y.Text projection is undo-transparent in CodeMirror history",
	);

	const syncConfig = new YSyncConfig(binding.ytext, {});
	const batchedState = EditorState.create({
		doc: beforeContent,
		extensions: [manager.getBaseExtension(), ySyncFacet.of(syncConfig)],
	});
	(binding.cm as unknown as { state: EditorState }).state = batchedState;
	const intermediateState = batchedState.update({
		selection: { anchor: 1 },
	}).state;
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, providerContent);
	const batchedYTextFirstTransaction = intermediateState.update({
		changes: { from: 0, to: intermediateState.doc.length, insert: providerContent },
	});
	assertEq(
		batchedYTextFirstTransaction.annotation(Transaction.addToHistory),
		false,
		"Y.Text projection from an intermediate dispatch state is undo-transparent",
	);
	syncConfig.undoManager.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 10: user input transactions update recent activity ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const before = binding.lastEditorDocChangeAtMs ?? 0;

	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [{
			docChanged: true,
			annotation: () => "input.type",
			isUserEvent: (event: string) => event === "input",
		}],
	});

	assertEq(
		typeof binding.lastEditorDocChangeAtMs === "number" && binding.lastEditorDocChangeAtMs > before,
		true,
		"user input advances the recent activity timestamp",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 11: binding replacement preserves same-path editor activity ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const before = binding.lastEditorDocChangeAtMs;
	const liveCm = installLiveCmReplacement(manager, binding);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");

	const applied = (manager as unknown as {
		applyBinding: (options: unknown) => boolean;
	}).applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-2",
		leafId: "leaf-1",
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "preserve-activity-test",
	});
	const rebound = (manager as unknown as {
		bindings: Map<string, { lastEditorDocChangeAtMs: number | null }>;
	}).bindings.get("leaf-1");

	assertEq(applied, true, "same-path binding replacement succeeds");
	assertEq(rebound?.lastEditorDocChangeAtMs, before, "same-path binding replacement preserves recent document activity");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 12: direct binding refuses divergent editor content ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const liveCm = installLiveCmReplacement(manager, binding);
	let dispatchCalls = 0;
	(liveCm as { dispatch: () => void }).dispatch = () => {
		dispatchCalls++;
	};

	const applied = (manager as unknown as {
		applyBinding: (options: unknown) => boolean;
	}).applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-2",
		leafId: "leaf-1",
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "divergent-editor-test",
	});

	assertEq(applied, false, "divergent editor content blocks direct binding");
	assertEq(dispatchCalls, 0, "blocked binding does not reconfigure CodeMirror");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.get("leaf-1"),
		binding,
		"blocked binding leaves the existing binding untouched",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 13: local repair patches are blocked during recent user typing ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
		path: binding.path,
		leafId,
		at: Date.now(),
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "stale repair content");

	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "stale repair content" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result !== transaction, true, "recent local repair patch is replaced with a shield transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		false,
		"binding is detached before the stale patch can reach the editor",
	);

	await Promise.resolve();
	assertEq(binding.ytext.toString(), "typing now", "editor authority is written back to CRDT after shield");
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		true,
		"shield emits editor.authority_shield.applied",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorHealApplied),
		false,
		"shield does not masquerade as editor.heal.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 13a: provider advance in the shield microtask gap is never overwritten ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "local repair C2");
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
		path: binding.path,
		leafId,
		at: Date.now(),
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "local repair C2" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	// Deterministic microtask-gap injection: a provider update advances the same
	// Y.Text after shield activation but before its queued editor writeback.
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "provider C3");
	await Promise.resolve();

	assertEq(binding.ytext.toString(), "provider C3", "newer provider content survives the shield gap");
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"stale shield snapshot emits no applied event",
	);
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		false,
		"stale shield remains detached when current CRDT and editor differ",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 13b: same-bytes Y.Text replacement in the shield gap is never overwritten ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "local repair C2");
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
		path: binding.path,
		leafId,
		at: Date.now(),
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "local repair C2" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	const replacementDoc = new Y.Doc();
	const replacement = replacementDoc.getText("replacement");
	replacement.insert(0, "local repair C2");
	(manager as unknown as {
		vaultSync: { getTextForPath: (path: string) => Y.Text | null };
	}).vaultSync.getTextForPath = (path) => path === binding.path ? replacement : null;
	await Promise.resolve();

	assertEq(replacement.toString(), "local repair C2", "replacement Y.Text keeps its same bytes unchanged");
	assertEq(binding.ytext.toString(), "local repair C2", "retired Y.Text is not used for editor writeback");
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"Y.Text identity replacement emits no applied event",
	);
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		false,
		"identity replacement is left detached for a fresh authority review",
	);
	clearPendingHealthChecks(manager);
	replacementDoc.destroy();
}

console.log("\n--- Test 14: provider-origin patches that preserve editor content are allowed ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const providerOrigin = { provider: true };
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: providerOrigin,
		path: binding.path,
		leafId: "leaf-1",
		at: Date.now(),
	});

	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing now plus remote collaborator content" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "provider-origin remote patch is allowed when it preserves editor content");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		true,
		"binding remains attached for preserving provider-origin updates",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 15: destructive provider-origin patches are never shielded ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	const providerOrigin = { provider: true };
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: providerOrigin,
		path: binding.path,
		leafId,
		at: Date.now(),
	});

	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "destructive provider-origin patch remains a normal Yjs transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"binding remains attached for a destructive provider-origin update",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"provider-origin update never emits editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 16: provider-origin patches that erase idle open editor content are allowed ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const leafId = "leaf-1";
	const providerOrigin = { provider: true };
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: providerOrigin,
		path: binding.path,
		leafId,
		at: Date.now(),
	});

	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "idle destructive provider patch is allowed through");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"idle binding remains attached for provider-origin updates",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"idle provider patch does not emit editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 17: destructive patch without origin capture is never shielded ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "missing-origin destructive patch remains a normal Yjs transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"binding remains attached when origin capture is missing",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"missing-origin update never emits editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 18: stale local origin capture is never shielded ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
		path: binding.path,
		leafId,
		at: Date.now() - 5000,
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "stale local-origin patch remains a normal Yjs transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"binding remains attached for stale origin capture",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"stale-origin update never emits editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19: missing-origin preserving patch is allowed during recent typing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing now plus remote text" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "missing-origin preserving patch is allowed");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		true,
		"binding remains attached for missing-origin preserving patch",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a: unknown string origin is never treated as a local repair ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: "unknown-string-origin",
		path: binding.path,
		leafId,
		at: Date.now(),
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "unknown string origin remains a normal Yjs transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"binding remains attached for an unknown string origin",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"unknown string origin never emits editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a2: explicit snapshot restore is never undone by the authority shield ---");
{
	const { manager, binding, flightEvents } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const leafId = "leaf-1";
	(manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
	}).pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_RESTORE,
		path: binding.path,
		leafId,
		at: Date.now(),
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "restored snapshot" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "snapshot restore patch remains authoritative during recent typing");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		true,
		"snapshot restore does not detach the editor binding",
	);
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		false,
		"snapshot restore never emits editor.authority_shield.applied",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3: correlated external editor reload is blocked before Y.Text ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const notice = externalDiskMutationNotice(
		binding.path,
		"external disk replacement",
		1133.5,
		{ ctime: 1133.25, sequence: 1133, observedAt: 1133.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "external disk replacement" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(Array.isArray(result), true, "external reload is replaced with a cancelled transaction list");
	assertEq((result as unknown[]).length, 0, "external reload produces no CodeMirror document change");
	assertEq(binding.ytext.toString(), "typing now", "blocked reload never reaches Y.Text");
	assertEq(interceptedExternalReloads.length, 1, "external candidate is handed to conflict preservation");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"event-first interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b: exact content correlation handles mixed EOL without size false positives ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const rawExternal = "\ufeffline one\r\nline two\r\n";
	const incomingEditorText = normalizeEditorText(rawExternal);
	const exactNotice = {
		path: binding.path,
		ctime: 987.25,
		mtime: 1234.5,
		size: new TextEncoder().encode(rawExternal).byteLength,
		sequence: 41,
		observedAt: 2345.75,
		content: rawExternal,
	};
	manager.noteExternalDiskMutation(exactNotice);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => incomingEditorText },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(Array.isArray(result), true, "mixed LF/CRLF external reload is blocked by exact normalized content");
	assertEq(interceptedExternalReloads.length, 1, "candidate is delivered once");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		exactNotice,
		"mixed-EOL event-first interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b2: proven host merge waits for the CRDT reconciliation planner ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const mergedContent = "work: local\nlife: external\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1337.5, {
		ctime: 1337.25,
		sequence: 1337,
		observedAt: 1337.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const hostInternals = manager as unknown as {
		pendingExternalDiskMutationStarts: Map<string, {
			views: Map<string, { continuation: unknown }>;
		}>;
		isManagedBindingContinuationCurrent: (
			continuation: unknown,
			binding: unknown,
		) => boolean;
		resolveExternalDiskHostProjectionProof: (input: unknown) => unknown;
	};
	const hostSnapshot = hostInternals.pendingExternalDiskMutationStarts
		.get(binding.path)?.views.get("leaf-1");
	assertEq(hostSnapshot !== undefined, true, "host merge captures an exact managed snapshot");
	assertEq(
		hostSnapshot
			? hostInternals.isManagedBindingContinuationCurrent(hostSnapshot.continuation, binding)
			: false,
		true,
		"host merge managed snapshot remains current before host projection",
	);
	Object.assign(binding.view, {
		data: mergedContent,
		lastSavedData: externalContent,
	});
	assertEq(
		hostInternals.resolveExternalDiskHostProjectionProof({
			leafId: "leaf-1",
			binding,
			currentText: localContent,
			incomingText: mergedContent,
		}) !== null,
		true,
		"host merge exact snapshot authorizes the matching host projection",
	);
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: mergedContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, false, "canonical host merge is filtered before Y.Text");
	assertEq(binding.ytext.toString(), localContent, "filtered host merge leaves CRDT authority unchanged");
	assertEq(
		(binding.view as unknown as { data: string }).data,
		localContent,
		"filtered host merge restores the TextFileView cache to CRDT authority",
	);
	assertEq(interceptedExternalReloads.length, 1, "exact external candidate is handed to reconciliation");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"proven host merge interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b2a: provider projection after the disk event does not disarm the host-merge fence ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const providerContent = "work: local\nprovider: remote\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const staleHostMerge = "work: local\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	const eventTimeState = EditorState.create({
		doc: eventTimeContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = eventTimeState;
	setLiveEditorContent(eventTimeContent);
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1338.5, {
		ctime: 1338.25,
		sequence: 1338,
		observedAt: 1338.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);

	// A provider/Y.Text-first projection changes the visible document but does
	// not advance editor authority. The older host reload is still disk-derived.
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, providerContent);
	const providerTransaction = eventTimeState.update({
		changes: { from: 0, to: eventTimeState.doc.length, insert: providerContent },
	});
	(binding.cm as unknown as { state: EditorState }).state = providerTransaction.state;
	setLiveEditorContent(providerContent);
	Object.assign(binding.view, { data: providerContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [providerTransaction],
	});

	Object.assign(binding.view, {
		data: staleHostMerge,
		lastSavedData: externalContent,
	});
	const hostMergeTransaction = providerTransaction.state.update({
		changes: {
			from: 0,
			to: providerTransaction.state.doc.length,
			insert: staleHostMerge,
		},
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(
		hostMergeTransaction.docChanged,
		false,
		"provider projection cannot let a stale host merge enter CodeMirror-first",
	);
	assertEq(
		binding.ytext.toString(),
		providerContent,
		"provider-advanced CRDT remains authoritative until reconciliation",
	);
	assertEq(
		(binding.view as unknown as { data: string }).data,
		providerContent,
		"host cache is restored to the latest provider projection",
	);
	assertEq(interceptedExternalReloads.length, 1, "provider race still hands the disk candidate to reconciliation");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"provider-race host merge interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b2b: provider Y.Text-only skew cannot admit a stale host merge ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const providerContent = "work: local\nprovider: remote\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const staleHostMerge = "work: local\nlife: external\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	const state = EditorState.create({
		doc: eventTimeContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1339.5, {
		ctime: 1339.25,
		sequence: 1339,
		observedAt: 1339.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);

	// Provider authority has advanced, but y-codemirror has not projected it to
	// CM yet. The host `set` is still disk-derived and must not become CM-first.
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, providerContent);
	Object.assign(binding.view, {
		data: staleHostMerge,
		lastSavedData: externalContent,
	});
	const hostMergeTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: staleHostMerge },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(
		hostMergeTransaction.docChanged,
		false,
		"Y.Text-only provider skew still blocks the stale host merge",
	);
	assertEq(
		binding.ytext.toString(),
		providerContent,
		"provider-only CRDT advance remains authoritative",
	);
	assertEq(
		(binding.view as unknown as { data: string }).data,
		eventTimeContent,
		"host cache returns to the still-visible CM document",
	);
	assertEq(
		interceptedExternalReloads.length,
		1,
		"Y.Text-only skew hands the disk candidate to reconciliation",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"Y.Text-only provider-skew interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b3: coincident plugin set is not an external host merge ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const pluginContent = "work: local\nlife: external\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: pluginContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, true, "plugin set without host view provenance remains a normal editor edit");
	assertEq(
		transaction.annotation(Transaction.addToHistory) === false,
		false,
		"unproven plugin set remains eligible for native undo",
	);
	assertEq(interceptedExternalReloads.length, 0, "plugin set does not consume the external candidate");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b3a: host merge is held while the exact raw event read is pending ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const rawExternalContent = "work: base\r\nlife: external\r\n";
	const externalEditorContent = normalizeEditorText(rawExternalContent);
	const hostMergedContent = "work: local\nlife: external\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(
		binding.path,
		rawExternalContent,
		1340.5,
		{ ctime: 1340.25, sequence: 1340, observedAt: 1340.75 },
	);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);

	// Obsidian has already read and logically normalized the external bytes, but
	// the plugin's stable raw read has not completed yet.
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalEditorContent,
	});
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, false, "early host merge is held before raw proof completes");
	assertEq(binding.ytext.toString(), localContent, "early host merge never becomes CRDT-first");
	assertEq(
		(binding.view as unknown as { data: string }).data,
		localContent,
		"early host merge restores the TextFileView cache",
	);
	assertEq(interceptedExternalReloads.length, 0, "logical host provenance alone emits no candidate");

	manager.noteExternalDiskMutation(notice);

	assertEq(interceptedExternalReloads.length, 1, "matching stable raw notice emits one candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"early host-merge delayed raw interception",
	);
	assertEq(binding.ytext.toString(), localContent, "raw proof never rewrites CRDT authority");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b3a2: early host proof coordinates held and pending panes exactly once ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const rawExternalContent = "work: base\r\nlife: external\r\n";
	const externalEditorContent = normalizeEditorText(rawExternalContent);
	const hostMergedContent = "work: local\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	setLiveEditorContent(localContent);
	const firstState = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = firstState;
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});

	let secondLiveEditorContent = localContent;
	const secondCmDom = { isConnected: true };
	const secondState = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	const secondCm = {
		dom: secondCmDom,
		hasFocus: false,
		state: secondState,
		dispatch: () => {},
	};
	const secondView = {
		file: { path: binding.path, stat: binding.view.file.stat },
		leaf: { id: "leaf-2" },
		containerEl: { contains: (node: unknown) => node === secondCmDom },
		editor: { getValue: () => secondLiveEditorContent },
		data: localContent,
		lastSavedData: baselineContent,
	};
	const secondBinding = {
		...binding,
		view: secondView,
		file: secondView.file,
		cm: secondCm,
		cmId: "cm-2",
		undoManager: new Y.UndoManager(binding.ytext),
	};
	(manager as unknown as { bindings: Map<string, unknown> }).bindings.set(
		"leaf-2",
		secondBinding,
	);
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(secondCm);

	const notice = externalDiskMutationNotice(
		binding.path,
		rawExternalContent,
		1340.85,
		{ ctime: 1340.8, sequence: 13402, observedAt: 1340.9 },
	);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);

	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalEditorContent,
	});
	const heldFirstPane = firstState.update({
		changes: { from: 0, to: firstState.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(heldFirstPane.docChanged, false, "first pane is held while the stable raw read is pending");
	assertEq(
		(binding.view as unknown as { data: string }).data,
		localContent,
		"held first pane restores its TextFileView cache",
	);
	assertEq(interceptedExternalReloads.length, 0, "held pane emits no speculative candidate");

	manager.noteExternalDiskMutation(notice);
	assertEq(interceptedExternalReloads.length, 1, "raw proof emits one candidate for the held pane set");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"mixed held/pending panes interception",
	);

	Object.assign(secondView, {
		data: hostMergedContent,
		lastSavedData: externalEditorContent,
	});
	const blockedSecondPane = secondState.update({
		changes: { from: 0, to: secondState.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(blockedSecondPane.docChanged, false, "second pane is blocked after the raw proof arrives");
	assertEq(secondView.data, localContent, "second pane restores its TextFileView cache");
	assertEq(interceptedExternalReloads.length, 1, "second pane consumes the same candidate without duplication");
	assertEq(binding.ytext.toString(), localContent, "both host projections leave shared CRDT authority unchanged");
	assertEq(secondLiveEditorContent, localContent, "unheld pane retains its visible local document");
	assertEq(
		(manager as unknown as { pendingExternalDiskMutationStarts: Map<string, unknown> })
			.pendingExternalDiskMutationStarts.has(binding.path),
		false,
		"all pane-level start snapshots retire after both panes are handled",
	);
	secondBinding.undoManager.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b3b: pending raw proof does not swallow an ordinary plugin set ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const pluginContent = "work: plugin\nlife: base\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: pluginContent,
		lastSavedData: baselineContent,
	});
	manager.beginExternalDiskMutation(binding.path, 1341);

	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: pluginContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, true, "unchanged lastSavedData keeps plugin set normal");
	assertEq(
		transaction.annotation(Transaction.addToHistory) === false,
		false,
		"ordinary plugin set remains eligible for native undo",
	);
	assertEq(interceptedExternalReloads.length, 0, "ordinary plugin set emits no external candidate");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b4: a post-event editor successor becomes the exact host-reload preimage ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const successorContent = "work: local after event\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local after event\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	const eventTimeState = EditorState.create({
		doc: eventTimeContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = eventTimeState;
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1441.5, {
		ctime: 1441.25,
		sequence: 1441,
		observedAt: 1441.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);

	// A real editor/API successor landed after the disk event began. It must pass
	// and become the exact current preimage for the later host projection.
	const successorTransaction = eventTimeState.update({
		changes: {
			from: 0,
			to: eventTimeState.doc.length,
			insert: successorContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = successorTransaction.state;
	setLiveEditorContent(successorContent);
	Object.assign(binding.view, { data: successorContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [successorTransaction],
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, successorContent);
	assertEq(successorTransaction.docChanged, true, "post-event editor/API successor is preserved");
	assertEq(interceptedExternalReloads.length, 0, "successor itself does not consume the disk candidate");

	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const transaction = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, false, "exact host merge is blocked against the newer editor preimage");
	assertEq(binding.ytext.toString(), successorContent, "host merge leaves successor CRDT authority unchanged");
	assertEq(
		binding.cm.state.doc.toString(),
		successorContent,
		"host merge leaves the current CodeMirror successor unchanged",
	);
	assertEq(
		(binding.view as unknown as { data: string }).data,
		successorContent,
		"host merge restores the TextFileView cache to the successor",
	);
	assertEq(interceptedExternalReloads.length, 1, "exact disk candidate is delivered once after the successor");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"post-successor host merge interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b4a: successor host proof fails closed when exact authority CAS drifts ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const successorContent = "work: local after event\nlife: base\n";
	const newerSurfaceContent = "work: newer surface\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local after event\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	setLiveEditorContent(eventTimeContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	const eventTimeState = EditorState.create({
		doc: eventTimeContent,
		extensions: [manager.getBaseExtension(), ySyncFacet.of(syncConfig)],
	});
	(binding.cm as unknown as { state: EditorState }).state = eventTimeState;
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1442.5, {
		ctime: 1442.25,
		sequence: 1442,
		observedAt: 1442.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);

	const successorTransaction = eventTimeState.update({
		changes: {
			from: 0,
			to: eventTimeState.doc.length,
			insert: successorContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = successorTransaction.state;
	setLiveEditorContent(successorContent);
	Object.assign(binding.view, { data: successorContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [successorTransaction],
	});
	let editorYTextTransaction: Y.Transaction | null = null;
	binding.ytext.doc?.transact((transaction) => {
		editorYTextTransaction = transaction;
		binding.ytext.delete(0, binding.ytext.length);
		binding.ytext.insert(0, successorContent);
	}, syncConfig);
	if (!editorYTextTransaction) throw new Error("Editor Y.Text transaction was not captured");
	(manager as unknown as {
		recordYTextPatch: (
			ytext: Y.Text,
			path: string,
			leafId: string,
			transaction: Y.Transaction,
		) => void;
	}).recordYTextPatch(
		binding.ytext,
		binding.path,
		"leaf-1",
		editorYTextTransaction,
	);

	const authorityContentByCm = (manager as unknown as {
		editorAuthorityContentByCm: WeakMap<object, string>;
	}).editorAuthorityContentByCm;
	authorityContentByCm.set(binding.cm, "stale authority snapshot");
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const authorityMismatch = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(
		authorityMismatch.docChanged,
		true,
		"editor-origin Y.Text provenance cannot replace stale authority content",
	);
	assertEq(interceptedExternalReloads.length, 0, "authority mismatch leaves the disk candidate unconsumed");

	const pendingYTextPatches = (manager as unknown as {
		pendingYTextPatches: WeakMap<Y.Text, {
			origin: unknown;
			path: string;
			leafId: string;
			at: number;
			revision: number;
		}>;
	}).pendingYTextPatches;
	const currentEditorPatch = pendingYTextPatches.get(binding.ytext);
	if (!currentEditorPatch) throw new Error("Current editor Y.Text provenance was not captured");
	pendingYTextPatches.delete(binding.ytext);
	const missingCapture = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(missingCapture.docChanged, true, "missing Y.Text provenance cannot swallow an unrelated set");
	assertEq(interceptedExternalReloads.length, 0, "missing capture leaves the disk candidate unconsumed");

	pendingYTextPatches.set(binding.ytext, {
		...currentEditorPatch,
		origin: { provider: "stale-capture" },
		revision: currentEditorPatch.revision - 1,
	});
	const staleCapture = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(staleCapture.docChanged, true, "stale Y.Text revision cannot swallow an unrelated set");
	assertEq(interceptedExternalReloads.length, 0, "stale capture leaves the disk candidate unconsumed");

	authorityContentByCm.set(binding.cm, successorContent);
	Object.assign(binding.view, {
		data: successorContent,
		lastSavedData: externalContent,
	});
	const newerCmTransaction = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: newerSurfaceContent,
		},
		filter: false,
	});
	(binding.cm as unknown as { state: EditorState }).state = newerCmTransaction.state;
	setLiveEditorContent(newerSurfaceContent);
	Object.assign(binding.view, { data: hostMergedContent });
	const surfaceMismatch = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(surfaceMismatch.docChanged, true, "stale CM/view preimage cannot swallow an unrelated set");
	assertEq(interceptedExternalReloads.length, 0, "surface mismatch still leaves the disk candidate unconsumed");
	assertEq(binding.ytext.toString(), successorContent, "failed successor proofs never mutate CRDT authority");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b4b: a provider projection after the successor remains a host-reload preimage ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const successorContent = "work: local after event\nlife: base\n";
	const providerContent = "work: provider after successor\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: provider after successor\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	setLiveEditorContent(eventTimeContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	const eventTimeState = EditorState.create({
		doc: eventTimeContent,
		extensions: [manager.getBaseExtension(), ySyncFacet.of(syncConfig)],
	});
	(binding.cm as unknown as { state: EditorState }).state = eventTimeState;
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1443.5, {
		ctime: 1443.25,
		sequence: 1443,
		observedAt: 1443.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);

	const recordPatch = (transaction: Y.Transaction, leafId = "leaf-1") => {
		(manager as unknown as {
			recordYTextPatch: (
				ytext: Y.Text,
				path: string,
				leafId: string,
				transaction: Y.Transaction,
			) => void;
		}).recordYTextPatch(binding.ytext, binding.path, leafId, transaction);
	};
	const successorTransaction = eventTimeState.update({
		changes: {
			from: 0,
			to: eventTimeState.doc.length,
			insert: successorContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = successorTransaction.state;
	setLiveEditorContent(successorContent);
	Object.assign(binding.view, { data: successorContent });
	let editorYTextTransaction: Y.Transaction | null = null;
	binding.ytext.doc?.transact((transaction) => {
		editorYTextTransaction = transaction;
		binding.ytext.delete(0, binding.ytext.length);
		binding.ytext.insert(0, successorContent);
	}, syncConfig);
	if (!editorYTextTransaction) throw new Error("Editor Y.Text transaction was not captured");
	recordPatch(editorYTextTransaction);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [successorTransaction],
	});
	const afterSuccessor = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);

	const providerOrigin = { provider: "after-successor" };
	let providerYTextTransaction: Y.Transaction | null = null;
	binding.ytext.doc?.transact((transaction) => {
		providerYTextTransaction = transaction;
		binding.ytext.delete(0, binding.ytext.length);
		binding.ytext.insert(0, providerContent);
	}, providerOrigin);
	if (!providerYTextTransaction) throw new Error("Provider Y.Text transaction was not captured");
	recordPatch(providerYTextTransaction, "provider-pane");
	const providerProjection = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: providerContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = providerProjection.state;
	setLiveEditorContent(providerContent);
	Object.assign(binding.view, { data: providerContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [providerProjection],
	});
	const afterProvider = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		providerProjection.annotation(Transaction.addToHistory),
		false,
		"provider projection is classified as Y.Text-first",
	);
	assertEq(
		afterProvider.views[0]!.editorAuthorityRevision,
		afterSuccessor.views[0]!.editorAuthorityRevision,
		"provider projection does not advance editor authority revision",
	);
	assertEq(
		afterProvider.views[0]!.editorAuthorityContent,
		successorContent,
		"provider projection retains the earlier editor authority content",
	);
	const yTextInternals = manager as unknown as {
		yTextMutationRevisionByText: WeakMap<Y.Text, number>;
		pendingYTextPatches: WeakMap<Y.Text, { origin: unknown; revision: number }>;
	};
	assertEq(
		yTextInternals.yTextMutationRevisionByText.get(binding.ytext),
		2,
		"provider projection advances beyond the editor-origin Y.Text revision",
	);
	assertEq(
		yTextInternals.pendingYTextPatches.get(binding.ytext)?.origin,
		providerOrigin,
		"latest Y.Text provenance belongs to the provider transaction",
	);

	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const hostProjection = providerProjection.state.update({
		changes: {
			from: 0,
			to: providerProjection.state.doc.length,
			insert: hostMergedContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(hostProjection.docChanged, false, "exact host merge is blocked after the provider projection");
	assertEq(binding.ytext.toString(), providerContent, "provider Y.Text authority remains unchanged");
	assertEq(binding.cm.state.doc.toString(), providerContent, "CodeMirror retains the provider projection");
	assertEq(
		(binding.view as unknown as { data: string }).data,
		providerContent,
		"TextFileView cache returns to the provider projection",
	);
	assertEq(interceptedExternalReloads.length, 1, "combined race delivers the exact candidate once");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"successor-provider-host interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b4c: pre-event Y.Text provenance cannot authorize successor rebasing ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const successorContent = "work: local after event\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const unrelatedSetContent = "work: local\nlife: unrelated set\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	setLiveEditorContent(eventTimeContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	const eventTimeState = EditorState.create({
		doc: eventTimeContent,
		extensions: [manager.getBaseExtension(), ySyncFacet.of(syncConfig)],
	});
	(binding.cm as unknown as { state: EditorState }).state = eventTimeState;
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const preEventProviderOrigin = { provider: "before-event" };
	let preEventProviderTransaction: Y.Transaction | null = null;
	binding.ytext.doc?.transact((transaction) => {
		preEventProviderTransaction = transaction;
		binding.ytext.delete(0, binding.ytext.length);
		binding.ytext.insert(0, eventTimeContent);
	}, preEventProviderOrigin);
	if (!preEventProviderTransaction) {
		throw new Error("Pre-event provider Y.Text transaction was not captured");
	}
	(manager as unknown as {
		recordYTextPatch: (
			ytext: Y.Text,
			path: string,
			leafId: string,
			transaction: Y.Transaction,
		) => void;
	}).recordYTextPatch(
		binding.ytext,
		binding.path,
		"provider-pane",
		preEventProviderTransaction,
	);

	const notice = externalDiskMutationNotice(binding.path, externalContent, 1444.5, {
		ctime: 1444.25,
		sequence: 1444,
		observedAt: 1444.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const successorTransaction = eventTimeState.update({
		changes: {
			from: 0,
			to: eventTimeState.doc.length,
			insert: successorContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = successorTransaction.state;
	setLiveEditorContent(successorContent);
	Object.assign(binding.view, { data: successorContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [successorTransaction],
	});

	// The already-current provider value projects after the successor without a
	// new Y.Text transaction. Its provenance predates the disk-event snapshot.
	const staleProviderProjection = successorTransaction.state.update({
		changes: {
			from: 0,
			to: successorTransaction.state.doc.length,
			insert: eventTimeContent,
		},
	});
	(binding.cm as unknown as { state: EditorState }).state = staleProviderProjection.state;
	setLiveEditorContent(eventTimeContent);
	Object.assign(binding.view, { data: eventTimeContent });
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [staleProviderProjection],
	});
	Object.assign(binding.view, {
		data: unrelatedSetContent,
		lastSavedData: externalContent,
	});
	const unrelatedSet = staleProviderProjection.state.update({
		changes: {
			from: 0,
			to: staleProviderProjection.state.doc.length,
			insert: unrelatedSetContent,
		},
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(unrelatedSet.docChanged, true, "pre-event provider capture cannot swallow an unrelated set");
	assertEq(interceptedExternalReloads.length, 0, "pre-event capture leaves the disk candidate unconsumed");
	assertEq(binding.ytext.toString(), eventTimeContent, "stale provenance path leaves Y.Text unchanged");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c: same-size unrelated plugin edit is never a disk reload ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const diskContent = "disk state";
	const pluginContent = "plugin now";
	assertEq(
		new TextEncoder().encode(diskContent).byteLength,
		new TextEncoder().encode(pluginContent).byteLength,
		"test candidates have the same byte size",
	);
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, diskContent),
	);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => pluginContent },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "same-size editor/API transaction remains a normal editor-origin edit");
	assertEq(interceptedExternalReloads.length, 0, "unrelated plugin content is not mislabeled as external");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2: filter:false cannot bypass an exact external reload guard ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	const beforeContent = "typing now";
	const externalContent = "filter bypass external";
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, beforeContent);
	const state = EditorState.create({
		doc: beforeContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		1263.5,
		{ ctime: 1263.25, sequence: 1263, observedAt: 1263.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const beforeTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: externalContent },
		filter: false,
	});
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(externalContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();

	const afterTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		binding.ytext.toString(),
		beforeContent,
		"filter:false external reload never mutates detached CRDT authority",
	);
	assertEq(interceptedExternalReloads.length, 1, "filter bypass preserves the exact external candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"filter:false interception",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"rejected filter:false reload never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2a: filter:false cannot bypass a proven host-merged reload ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(localContent);
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1264.5, {
		ctime: 1264.25,
		sequence: 1264,
		observedAt: 1264.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const beforeTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
		filter: false,
	});
	assertEq(
		transaction.annotation(Transaction.addToHistory),
		false,
		"filter:false host merge is excluded from native editor undo history",
	);
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(hostMergedContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();

	const afterTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		binding.ytext.toString(),
		localContent,
		"filter:false host merge never replaces detached CRDT authority",
	);
	assertEq(
		interceptedExternalReloads.length,
		1,
		"filter:false host merge hands the exact disk candidate to reconciliation",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"filter:false host-merge interception",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"filter:false host merge never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2b: filter:false host merge cannot cross a provider Y.Text-only skew ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const eventTimeContent = "work: local\nlife: base\n";
	const providerContent = "work: local\nprovider: remote\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const staleHostMerge = "work: local\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, eventTimeContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	let state = EditorState.create({
		doc: eventTimeContent,
		extensions: manager.getBaseExtension(),
	});
	state = state.update({
		effects: manager.compartment.reconfigure(ySyncFacet.of(syncConfig)),
		filter: false,
	}).state;
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(eventTimeContent);
	Object.assign(binding.view, {
		data: eventTimeContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1265.5, {
		ctime: 1265.25,
		sequence: 1265,
		observedAt: 1265.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, providerContent);
	Object.assign(binding.view, {
		data: staleHostMerge,
		lastSavedData: externalContent,
	});
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: staleHostMerge },
		annotations: Transaction.userEvent.of("set"),
		filter: false,
	});
	assertEq(
		transaction.state.facet(ySyncFacet),
		undefined,
		"bypass fence detaches y-codemirror before it can mutate Y.Text",
	);
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(staleHostMerge);
	let rollbackProjection: string | null = null;
	(binding.cm as unknown as {
		dispatch: (spec: { changes?: { insert?: string } }) => void;
	}).dispatch = (spec) => {
		rollbackProjection = spec.changes?.insert ?? null;
	};
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();

	assertEq(
		binding.ytext.toString(),
		providerContent,
		"filter:false host merge never mutates provider-advanced Y.Text",
	);
	assertEq(
		rollbackProjection,
		providerContent,
		"post-update CAS projects the provider authority back into CM",
	);
	assertEq(
		interceptedExternalReloads.length,
		1,
		"filter:false skew hands the exact disk candidate to reconciliation",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"filter:false Y.Text-only provider-skew interception",
	);
	syncConfig.undoManager.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2c: skipped bypass CAS stays detached across editor/CRDT divergence ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const staleHostMerge = "work: local\nlife: external\n";
	const editorSuccessor = "work: local after bypass\nlife: base\n";
	const {
		manager,
		binding,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	let state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	state = state.update({
		effects: manager.compartment.reconfigure(ySyncFacet.of(syncConfig)),
		filter: false,
	}).state;
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(localContent);
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1266.5, {
		ctime: 1266.25,
		sequence: 1266,
		observedAt: 1266.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	Object.assign(binding.view, {
		data: staleHostMerge,
		lastSavedData: externalContent,
	});
	const bypassTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: staleHostMerge },
		annotations: Transaction.userEvent.of("set"),
		filter: false,
	});
	assertEq(
		bypassTransaction.state.facet(ySyncFacet),
		undefined,
		"bypass transaction temporarily detaches collab",
	);
	(binding.cm as unknown as { state: EditorState }).state = bypassTransaction.state;
	setLiveEditorContent(staleHostMerge);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [bypassTransaction],
	});

	// A newer editor/API successor invalidates the bypass content CAS before its
	// microtask runs. Reattachment must not replace these newer editor bytes.
	const successorTransaction = bypassTransaction.state.update({
		changes: {
			from: 0,
			to: bypassTransaction.state.doc.length,
			insert: editorSuccessor,
		},
		filter: false,
	});
	(binding.cm as unknown as { state: EditorState }).state = successorTransaction.state;
	setLiveEditorContent(editorSuccessor);
	let rollbackDispatches = 0;
	(binding.cm as unknown as {
		dispatch: (spec: TransactionSpec) => void;
	}).dispatch = (spec) => {
		rollbackDispatches++;
		const dispatchedState = successorTransaction.state.update({ ...spec, filter: false }).state;
		(binding.cm as unknown as { state: EditorState }).state = dispatchedState;
	};
	await Promise.resolve();

	assertEq(
		rollbackDispatches,
		0,
		"divergent content CAS never dispatches a binding reattachment or document correction",
	);
	assertEq(
		(binding.cm.state as EditorState).doc.toString(),
		editorSuccessor,
		"divergent rollback preserves the newer editor successor",
	);
	assertEq(
		(binding.cm.state as EditorState).facet(ySyncFacet),
		undefined,
		"divergent rollback remains detached for guarded health recovery",
	);
	assertEq(
		binding.ytext.toString(),
		localContent,
		"divergent rollback does not overwrite CRDT content",
	);
	syncConfig.undoManager.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2d: rollback projects a provider advance whose bytes equal the external candidate ---");
{
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const syncConfig = new YSyncConfig(binding.ytext, {});
	let state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	state = state.update({
		effects: manager.compartment.reconfigure(ySyncFacet.of(syncConfig)),
		filter: false,
	}).state;
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(localContent);
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1267.5, {
		ctime: 1267.25,
		sequence: 1267,
		observedAt: 1267.75,
	});
	manager.noteExternalDiskMutation(notice);
	const bypassTransaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: externalContent },
		filter: false,
	});
	assertEq(
		bypassTransaction.state.facet(ySyncFacet),
		undefined,
		"provider same-bytes test starts from a detached bypass",
	);
	(binding.cm as unknown as { state: EditorState }).state = bypassTransaction.state;
	setLiveEditorContent(externalContent);

	// A legitimate provider transaction advances Y.Text to the same logical bytes
	// as the rejected disk candidate while y-codemirror is detached.
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
	let rollbackYTextTransactions = 0;
	const observeRollback = () => { rollbackYTextTransactions++; };
	binding.ytext.observe(observeRollback);
	let correctedState: EditorState | null = null;
	(binding.cm as unknown as { dispatch: (spec: TransactionSpec) => void }).dispatch = (spec) => {
		correctedState = bypassTransaction.state.update({ ...spec, filter: false }).state;
		(binding.cm as unknown as { state: EditorState }).state = correctedState;
	};
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [bypassTransaction],
	});
	await Promise.resolve();
	binding.ytext.unobserve(observeRollback);

	assertEq(rollbackYTextTransactions, 0, "rollback never writes the current Y.Text");
	assertEq(
		binding.ytext.toString(),
		externalContent,
		"provider same-bytes authority is not replaced by captured old CRDT bytes",
	);
	assertEq(
		correctedState?.doc.toString() ?? null,
		externalContent,
		"latest Y.Text bytes are projected into CodeMirror",
	);
	assertEq(
		correctedState?.facet(ySyncFacet)?.ytext === binding.ytext,
		true,
		"equal CM and Y.Text state safely reattaches collaboration",
	);
	assertEq(interceptedExternalReloads.length, 1, "same-bytes provider race preserves one disk candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"provider same-bytes interception",
	);
	syncConfig.undoManager.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c3: a later transaction filter cannot resurrect an external reload ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	const beforeContent = "typing now";
	const externalContent = "resurrected external reload";
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, beforeContent);
	const resurrectCancelledChange = EditorState.transactionFilter.of((transaction) => {
		if (transaction.docChanged) return transaction;
		return {
			changes: {
				from: 0,
				to: transaction.startState.doc.length,
				insert: externalContent,
			},
		};
	});
	const state = EditorState.create({
		doc: beforeContent,
		// Transaction filters run in reverse extension order. The manager blocks
		// first; this deliberately hostile filter then recreates the same change.
		extensions: [resurrectCancelledChange, manager.getBaseExtension()],
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		1326.5,
		{ ctime: 1326.25, sequence: 1326, observedAt: 1326.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const beforeTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: externalContent },
	});
	assertEq(
		transaction.docChanged,
		true,
		"later transaction filter recreates the cancelled document change",
	);
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(externalContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();

	const afterTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		binding.ytext.toString(),
		beforeContent,
		"resurrected external reload never mutates detached CRDT authority",
	);
	assertEq(
		interceptedExternalReloads.length,
		1,
		"resurrected external bytes are preserved exactly once",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"later-filter interception",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"resurrected external reload never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c3a: a later filter cannot transform and resurrect a proven host merge ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local\nlife: external\n";
	const transformedContent = "work: local\nlife: external\nfilter: transformed\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const resurrectCancelledHostMerge = EditorState.transactionFilter.of((transaction) => {
		if (transaction.docChanged) return transaction;
		return {
			changes: {
				from: 0,
				to: transaction.startState.doc.length,
				insert: transformedContent,
			},
		};
	});
	const state = EditorState.create({
		doc: localContent,
		// Transaction filters run in reverse extension order. The manager proves
		// and cancels the host merge first; this filter then recreates it.
		extensions: [resurrectCancelledHostMerge, manager.getBaseExtension()],
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(localContent);
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1327.5, {
		ctime: 1327.25,
		sequence: 1327,
		observedAt: 1327.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const beforeTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(
		transaction.docChanged,
		true,
		"later transaction filter recreates a transformed host merge",
	);
	assertEq(transaction.newDoc.toString(), transformedContent, "later filter changed the blocked bytes");
	assertEq(
		transaction.annotation(Transaction.addToHistory),
		false,
		"resurrected host merge is excluded from native editor undo history",
	);
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(transformedContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();

	const afterTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	assertEq(
		binding.ytext.toString(),
		localContent,
		"transformed resurrection never replaces CRDT authority",
	);
	assertEq(
		interceptedExternalReloads.length,
		1,
		"resurrected host merge preserves the exact disk candidate once",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"later-filter host-merge interception",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"resurrected host merge never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c3b: a later filter cannot relabel a proven host merge as user input ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local\nlife: external\n";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	(manager as unknown as { maybeHealBinding: () => void }).maybeHealBinding = () => {};
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const relabelCancelledHostMerge = EditorState.transactionFilter.of((transaction) => {
		if (transaction.docChanged) return transaction;
		return {
			changes: {
				from: 0,
				to: transaction.startState.doc.length,
				insert: hostMergedContent,
			},
			annotations: Transaction.userEvent.of("input.type"),
		};
	});
	const state = EditorState.create({
		doc: localContent,
		extensions: [relabelCancelledHostMerge, manager.getBaseExtension()],
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	setLiveEditorContent(localContent);
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1328.5, {
		ctime: 1328.25,
		sequence: 1328,
		observedAt: 1328.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	const beforeTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const transaction = state.update({
		changes: { from: 0, to: state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(transaction.docChanged, true, "later filter recreates the blocked host merge");
	assertEq(transaction.isUserEvent("input"), true, "later filter relabels it as user input");
	assertEq(
		transaction.annotation(Transaction.addToHistory),
		false,
		"pipeline fence still excludes the relabeled host merge from undo",
	);
	(binding.cm as unknown as { state: EditorState }).state = transaction.state;
	setLiveEditorContent(hostMergedContent);
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: binding.cm,
		docChanged: true,
		transactions: [transaction],
	});
	await Promise.resolve();
	const afterTicket = manager.captureOpenEditorMutationTicket(
		binding.path,
		[binding.view as never],
	);

	assertEq(binding.ytext.toString(), localContent, "user relabel cannot mutate CRDT authority");
	assertEq(interceptedExternalReloads.length, 1, "user relabel preserves one exact disk candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"later-filter user-relabel interception",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"user relabel never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c3c: a cancelled no-doc pipeline releases its fence immediately ---");
{
	const baselineContent = "work: base\nlife: base\n";
	const localContent = "work: local\nlife: base\n";
	const externalContent = "work: base\nlife: external\n";
	const hostMergedContent = "work: local\nlife: external\n";
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, localContent);
	const state = EditorState.create({
		doc: localContent,
		extensions: manager.getBaseExtension(),
	});
	(binding.cm as unknown as { state: EditorState }).state = state;
	Object.assign(binding.view, {
		data: localContent,
		lastSavedData: baselineContent,
	});
	const notice = externalDiskMutationNotice(binding.path, externalContent, 1329.5, {
		ctime: 1329.25,
		sequence: 1329,
		observedAt: 1329.75,
	});
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.noteExternalDiskMutation(notice);
	Object.assign(binding.view, {
		data: hostMergedContent,
		lastSavedData: externalContent,
	});
	const blocked = state.update({
		changes: { from: 0, to: state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});
	assertEq(blocked.docChanged, false, "host merge is cancelled to a no-doc transaction");
	(binding.cm as unknown as { state: EditorState }).state = blocked.state;

	// This is a distinct synchronous dispatch after the first state.update has
	// fully returned, even though it happens before the queued microtask cleanup.
	Object.assign(binding.view, { data: hostMergedContent });
	const ordinaryPluginSet = blocked.state.update({
		changes: { from: 0, to: blocked.state.doc.length, insert: hostMergedContent },
		annotations: Transaction.userEvent.of("set"),
	});

	assertEq(ordinaryPluginSet.docChanged, true, "separate ordinary plugin dispatch is not swallowed");
	assertEq(
		ordinaryPluginSet.annotation(Transaction.addToHistory) === false,
		false,
		"released fence leaves the ordinary plugin set eligible for undo",
	);
	assertEq(interceptedExternalReloads.length, 1, "released fence does not duplicate the disk candidate");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3d: event order survives delayed exact-content proof ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const externalContent = "delayed external";
	const coarseMtime = Math.floor(Date.now() / 1000) * 1000;
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		coarseMtime,
		{ ctime: 1410.25, sequence: 1410, observedAt: 1410.75 },
	);
	setLiveFileStat(coarseMtime, notice.size ?? 0, notice.ctime ?? 0);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => externalContent },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	assertEq(result, transaction, "editor transaction may arrive while exact disk read is pending");

	setLiveEditorContent(externalContent);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);
	recordExpectedEditorYTextPatch(manager, binding);
	manager.noteExternalDiskMutation(notice);

	assertEq(binding.ytext.toString(), "typing now", "synchronous event sequence restores editor authority");
	assertEq(interceptedExternalReloads.length, 1, "delayed proof still preserves the exact external version");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"delayed editor-first proof interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a4: disk marker never blocks a Y.Text/provider patch ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const notice = externalDiskMutationNotice(binding.path, "disk candidate");
	manager.noteExternalDiskMutation(notice);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "provider state");
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "provider state" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "Y.Text-first provider patch remains normal collaboration");
	assertEq(
		interceptedExternalReloads.length,
		0,
		"provider-only patch intentionally emits zero intercepted disk candidates",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a4b: provider advance does not open a disk-reload bypass ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const notice = externalDiskMutationNotice(
		binding.path,
		"external disk replacement",
		1476.5,
		{ ctime: 1476.25, sequence: 1476, observedAt: 1476.75 },
	);
	manager.noteExternalDiskMutation(notice);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "newer provider authority");
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "external disk replacement" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(Array.isArray(result), true, "correlated editor reload is blocked during provider/editor skew");
	assertEq(binding.ytext.toString(), "newer provider authority", "provider authority remains untouched");
	assertEq(interceptedExternalReloads.length, 1, "external disk candidate is still preserved");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"event-first provider-race interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a5: late external event uses exact CAS rollback ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	let externalMtime = Date.now() - 100;
	if (externalMtime % 1000 === 0) externalMtime--;
	const notice = externalDiskMutationNotice(
		binding.path,
		"late external replacement",
		externalMtime,
		{ ctime: 1508.25, sequence: 1508, observedAt: 1508.75 },
	);
	setLiveFileStat(externalMtime, notice.size ?? 0, notice.ctime ?? 0);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "late external replacement" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	assertEq(result, transaction, "unattributed editor change waits for a matching disk event");

	setLiveEditorContent("late external replacement");
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "late external replacement");
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);
	recordExpectedEditorYTextPatch(manager, binding);
	manager.noteExternalDiskMutation(notice);

	assertEq(binding.ytext.toString(), "typing now", "exact unchanged Y.Text is restored to editor authority");
	assertEq(interceptedExternalReloads.length, 1, "late external candidate is preserved exactly once");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"late editor-first rollback interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a6: coarse-mtime plugin autosave cannot roll back or poison later edits ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const coarseMtime = Math.floor(Date.now() / 1000) * 1000;
	const notice = externalDiskMutationNotice(
		binding.path,
		"plugin now",
		coarseMtime,
		{ ctime: 1564.25, sequence: 1564, observedAt: 1564.75 },
	);
	setLiveFileStat(coarseMtime, notice.size ?? 0, notice.ctime ?? 0);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "plugin now" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	setLiveEditorContent("plugin now");
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "plugin now");
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);
	recordExpectedEditorYTextPatch(manager, binding);
	manager.noteExternalDiskMutation(notice);

	assertEq(
		binding.ytext.toString(),
		"plugin now",
		"ambiguous coarse-mtime autosave keeps the plugin editor change",
	);
	assertEq(
		interceptedExternalReloads.length,
		0,
		"proven plugin autosave intentionally emits zero intercepted disk candidates",
	);
	const nextPluginTransaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "plugin two" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const nextResult = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(nextPluginTransaction);
	assertEq(
		nextResult,
		nextPluginTransaction,
		"the autosave event does not poison the plugin's next non-user editor edit",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a7: provider advance invalidates late external rollback ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	let externalMtime = Date.now() - 100;
	if (externalMtime % 1000 === 0) externalMtime--;
	const notice = externalDiskMutationNotice(
		binding.path,
		"external candidate",
		externalMtime,
		{ ctime: 1621.25, sequence: 1621, observedAt: 1621.75 },
	);
	setLiveFileStat(externalMtime, notice.size ?? 0, notice.ctime ?? 0);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "external candidate" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	setLiveEditorContent("external candidate");
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "newer provider authority");
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);
	manager.noteExternalDiskMutation(notice);

	assertEq(
		binding.ytext.toString(),
		"newer provider authority",
		"newer provider content survives a stale late-order rollback candidate",
	);
	assertEq(interceptedExternalReloads.length, 1, "stale rollback candidate is preserved without rollback");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"late provider-race interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a7a: same-bytes provider Y.Text advance invalidates legacy rollback ---");
{
	const beforeContent = "typing now";
	const externalContent = "external candidate";
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, beforeContent);
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		1622.5,
		{ ctime: 1622.25, sequence: 1622, observedAt: 1622.75 },
	);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => externalContent },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);
	setLiveEditorContent(externalContent);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);
	recordExpectedEditorYTextPatch(manager, binding);

	// A provider transaction advances the CRDT structure but happens to finish
	// with the same logical bytes while its CM projection is still pending.
	let providerYTextEvents = 0;
	let providerTransaction: Y.Transaction | null = null;
	const providerOrigin = { provider: "same-bytes" };
	const observeProviderAdvance = () => { providerYTextEvents++; };
	binding.ytext.observe(observeProviderAdvance);
	binding.ytext.doc?.transact((transaction) => {
		providerTransaction = transaction;
		binding.ytext.delete(0, binding.ytext.length);
		binding.ytext.insert(0, externalContent);
	}, providerOrigin);
	binding.ytext.unobserve(observeProviderAdvance);
	assertEq(providerYTextEvents, 1, "same-bytes provider transaction advances Y.Text once");
	if (!providerTransaction) {
		throw new Error("Provider transaction was not captured");
	}
	(manager as unknown as {
		recordYTextPatch: (
			ytext: Y.Text,
			path: string,
			leafId: string,
			transaction: Y.Transaction,
		) => void;
	}).recordYTextPatch(
		binding.ytext,
		binding.path,
		"provider-pane",
		providerTransaction,
	);
	const revisionInternals = manager as unknown as {
		yTextMutationRevisionByText: WeakMap<Y.Text, number>;
		pendingYTextPatches: WeakMap<Y.Text, { origin: unknown }>;
	};
	assertEq(
		revisionInternals.yTextMutationRevisionByText.get(binding.ytext),
		2,
		"same-bytes provider transaction advances beyond the editor-origin revision",
	);
	assertEq(
		revisionInternals.pendingYTextPatches.get(binding.ytext)?.origin,
		providerOrigin,
		"same-bytes provider transaction replaces the legacy rollback provenance",
	);

	manager.noteExternalDiskMutation(notice);

	assertEq(
		binding.ytext.toString(),
		externalContent,
		"legacy delayed proof never overwrites newer same-bytes provider authority",
	);
	assertEq(interceptedExternalReloads.length, 1, "same-bytes provider race preserves the disk candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"legacy same-bytes provider interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a7b: multiple open-view observers count one Y.Transaction once ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const internals = manager as unknown as {
		recordYTextPatch?: (
			ytext: Y.Text,
			path: string,
			leafId: string,
			transaction: Y.Transaction,
		) => void;
		yTextMutationRevisionByText?: WeakMap<Y.Text, number>;
		pendingYTextPatches?: WeakMap<Y.Text, { origin: unknown; revision: number }>;
	};
	assertEq(
		typeof internals.recordYTextPatch,
		"function",
		"Y.Text patch recorder exposes transaction-identity deduplication",
	);
	if (internals.recordYTextPatch) {
		const firstOrigin = { provider: "first" };
		const firstTransaction = { origin: firstOrigin } as Y.Transaction;
		internals.recordYTextPatch(binding.ytext, binding.path, "leaf-1", firstTransaction);
		internals.recordYTextPatch(binding.ytext, binding.path, "leaf-2", firstTransaction);
		assertEq(
			internals.yTextMutationRevisionByText?.get(binding.ytext),
			1,
			"two observers of the same transaction advance one revision",
		);
		const secondOrigin = { provider: "second" };
		const secondTransaction = { origin: secondOrigin } as Y.Transaction;
		internals.recordYTextPatch(binding.ytext, binding.path, "leaf-1", secondTransaction);
		assertEq(
			internals.yTextMutationRevisionByText?.get(binding.ytext),
			2,
			"a distinct Y.Transaction advances the next revision",
		);
		assertEq(
			internals.pendingYTextPatches?.get(binding.ytext)?.origin,
			secondOrigin,
			"latest patch provenance follows the distinct transaction",
		);
	}
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a8: user input cannot poison or erase exact external correlation ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const notice = externalDiskMutationNotice(
		binding.path,
		"disk state",
		1669.5,
		{ ctime: 1669.25, sequence: 1669, observedAt: 1669.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const userTransaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "typing now!" },
		annotation: () => "input.type",
		isUserEvent: (event: string) => event === "input" || event === "input.type",
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(userTransaction);
	const laterProgrammaticTransaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "later programmatic change" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(laterProgrammaticTransaction);

	assertEq(result, laterProgrammaticTransaction, "post-input programmatic change is not tied to an older disk event");
	assertEq(interceptedExternalReloads.length, 0, "unrelated post-input content is not classified as external");
	const delayedExternalReload = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "disk state" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const delayedResult = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(delayedExternalReload);
	assertEq(
		Array.isArray(delayedResult),
		true,
		"user input does not erase a still-pending exact external reload marker",
	);
	assertEq(interceptedExternalReloads.length, 1, "the delayed exact external candidate is preserved");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"delayed post-user-input interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a8b: user input during delayed proof keeps both newer authority and external bytes ---");
{
	const {
		manager,
		binding,
		interceptedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "editor before external");
	setLiveEditorContent("editor before external");
	const externalContent = "external while proof pending";
	const coarseMtime = Math.floor(Date.now() / 1000) * 1000;
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		coarseMtime,
		{ ctime: 1725.25, sequence: 1725, observedAt: 1725.75 },
	);
	setLiveFileStat(coarseMtime, notice.size ?? 0, notice.ctime ?? 0);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	const externalTransaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => externalContent },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(externalTransaction);
	setLiveEditorContent(externalContent);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 1);

	const userContent = `${externalContent}\nuser successor`;
	const userTransaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => userContent },
		annotation: () => "input.type",
		isUserEvent: (event: string) => event === "input" || event === "input.type",
	};
	(manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(userTransaction);
	setLiveEditorContent(userContent);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, userContent);
	(manager as unknown as {
		editorRevisionByCm: WeakMap<object, number>;
	}).editorRevisionByCm.set(binding.cm, 2);

	manager.noteExternalDiskMutation(notice);
	assertEq(binding.ytext.toString(), userContent, "newer user authority is never rolled back");
	assertEq(interceptedExternalReloads.length, 1, "late proof still preserves the external candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"delayed proof with newer user authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a9: out-of-order exact reads cannot replace a newer marker ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const older = externalDiskMutationNotice(
		binding.path,
		"older external",
		1788.5,
		{ ctime: 1788.25, sequence: 1788, observedAt: 1788.75 },
	);
	const newer = externalDiskMutationNotice(
		binding.path,
		"newer external",
		1789.5,
		{ ctime: 1789.25, sequence: 1789, observedAt: 1789.75 },
	);
	manager.beginExternalDiskMutation(binding.path, older.sequence);
	manager.beginExternalDiskMutation(binding.path, newer.sequence);
	manager.noteExternalDiskMutation(newer);
	manager.noteExternalDiskMutation(older);

	const pending = (manager as unknown as {
		pendingExternalDiskMutations: Map<string, { content: string | null }>;
	}).pendingExternalDiskMutations.get(binding.path);
	assertEq(pending?.content, "newer external", "older async completion cannot replace the newer marker");
	assertEq(interceptedExternalReloads.length, 1, "older proven external bytes are preserved off-path");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		older,
		"out-of-order stale completion interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a10: an old async proof cannot cross close and reopen ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const notice = externalDiskMutationNotice(
		binding.path,
		"external before reopen",
		1810.5,
		{ ctime: 1810.25, sequence: 1810, observedAt: 1810.75 },
	);
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.unbind(binding.view as never);
	// Model a new binding lifetime on the same path before the old read resolves.
	(manager as unknown as { bindings: Map<string, unknown> }).bindings.set("leaf-1", binding);
	manager.noteExternalDiskMutation(notice);

	const pending = (manager as unknown as {
		pendingExternalDiskMutations: Map<string, unknown>;
	}).pendingExternalDiskMutations.get(binding.path);
	assertEq(pending, undefined, "old proof cannot arm the reopened editor binding");
	assertEq(interceptedExternalReloads.length, 1, "the exact old candidate is still preserved");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"reopened-binding stale proof interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a11: enabled guard never lets a proven pending reload reach Y.Text ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		externalReloadGuardEnabled: () => true,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const externalContent = "blocked by fixed safe guard";
	const notice = externalDiskMutationNotice(
		binding.path,
		externalContent,
		1831.5,
		{ ctime: 1831.25, sequence: 1831, observedAt: 1831.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => externalContent },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(Array.isArray(result), true, "enabled guard cancels the proven external reload");
	assertEq((result as unknown[]).length, 0, "proven external reload produces no editor patch");
	assertEq(binding.ytext.toString(), "typing now", "proven external reload never reaches Y.Text");
	assertEq(interceptedExternalReloads.length, 1, "guard preserves the rejected external candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"fixed-safe guard interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a12: interception callback failures stay isolated and diagnostic ---");
{
	let callbackAttempts = 0;
	const {
		manager,
		binding,
		interceptedExternalReloads,
		traceRecords,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		onExternalDiskReloadIntercepted: () => {
			callbackAttempts++;
			throw new Error("fixture candidate callback exploded");
		},
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const notice = externalDiskMutationNotice(
		binding.path,
		"callback failure external",
		1912.5,
		{ ctime: 1912.25, sequence: 1912, observedAt: 1912.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => notice.content },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	let exceptionEscaped = false;
	let result: unknown;
	try {
		result = (manager as unknown as {
			filterRiskyNonUserPatch: (candidate: unknown) => unknown;
		}).filterRiskyNonUserPatch(transaction);
	} catch {
		exceptionEscaped = true;
	}

	assertEq(exceptionEscaped, false, "throwing interception callback never escapes the guard path");
	assertEq(Array.isArray(result), true, "throwing callback still leaves the reload cancelled");
	assertEq((result as unknown[]).length, 0, "throwing callback still produces no editor patch");
	assertEq(binding.ytext.toString(), "typing now", "throwing callback cannot alter Y.Text authority");
	assertEq(binding.cm.state.doc.toString(), "typing now", "throwing callback cannot alter editor state");
	assertEq(callbackAttempts, 1, "throwing callback is invoked exactly once");
	assertEq(interceptedExternalReloads.length, 1, "throwing callback still receives one candidate");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"throwing callback interception",
	);
	const callbackFailureTraces = traceRecords.filter(
		(record) => record.msg.includes("callback-failed"),
	);
	assertEq(callbackFailureTraces.length, 1, "candidate callback failure emits exactly one diagnostic");
	assertEq(callbackFailureTraces[0]?.source, "editor", "callback diagnostic source is exact");
	assertEq(
		callbackFailureTraces[0]?.msg,
		"external-disk-candidate-callback-failed",
		"callback diagnostic name is exact",
	);
	assertEq(
		callbackFailureTraces[0]?.details?.path,
		notice.path,
		"callback diagnostic path is exact",
	);
	assertEq(
		callbackFailureTraces[0]?.details?.sequence,
		notice.sequence,
		"callback diagnostic sequence is exact",
	);
	assertEq(
		callbackFailureTraces[0]?.details?.error,
		"fixture candidate callback exploded",
		"callback diagnostic error is exact",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a13: multi-pane interception retains the complete notice per pane ---");
{
	const { manager, binding, interceptedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const secondCmDom = { isConnected: true };
	const secondState = {
		doc: {
			length: "typing now".length,
			toString: () => "typing now",
		},
		facet: binding.cm.state.facet,
	};
	const secondCm = {
		dom: secondCmDom,
		hasFocus: false,
		state: secondState,
		dispatch: () => {},
	};
	const secondView = {
		file: { path: binding.path, stat: binding.view.file.stat },
		leaf: { id: "leaf-2" },
		containerEl: { contains: (node: unknown) => node === secondCmDom },
		editor: { getValue: () => "typing now" },
	};
	const secondBinding = {
		...binding,
		view: secondView,
		file: secondView.file,
		cm: secondCm,
		cmId: "cm-2",
		undoManager: new Y.UndoManager(binding.ytext),
	};
	(manager as unknown as { bindings: Map<string, unknown> }).bindings.set(
		"leaf-2",
		secondBinding,
	);
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(secondCm);
	const notice = externalDiskMutationNotice(
		binding.path,
		"multi-pane external",
		1913.5,
		{ ctime: 1913.25, sequence: 1913, observedAt: 1913.75 },
	);
	manager.noteExternalDiskMutation(notice);
	const transactionFor = (startState: unknown) => ({
		docChanged: true,
		startState,
		newDoc: { toString: () => notice.content },
		annotation: () => undefined,
		isUserEvent: () => false,
	});
	const filter = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch.bind(manager);
	const firstResult = filter(transactionFor(binding.cm.state));
	const secondResult = filter(transactionFor(secondCm.state));

	assertEq(Array.isArray(firstResult), true, "first pane blocks the proven reload");
	assertEq(Array.isArray(secondResult), true, "second pane blocks the proven reload");
	assertEq(binding.ytext.toString(), "typing now", "multi-pane reload never reaches shared Y.Text");
	assertEq(interceptedExternalReloads.length, 2, "each live pane reports its interception once");
	assertCandidateMatchesNotice(
		interceptedExternalReloads[0],
		notice,
		"first multi-pane interception",
	);
	assertCandidateMatchesNotice(
		interceptedExternalReloads[1],
		notice,
		"second multi-pane interception",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19b: remote typing awareness never cancels normal or IME input ---");
{
	const { manager, binding, awarenessStates } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	let warningCalls = 0;
	(manager as unknown as {
		warnConcurrentTyping: () => void;
	}).warnConcurrentTyping = () => {
		warningCalls++;
	};
	awarenessStates.set(2, {
		[KAOS_TYPING_AWARENESS_FIELD]: buildTypingAwareness(
			binding.path,
			"Phone",
			Date.now(),
		),
	});

	for (const userEvent of ["input.type", "input.type.compose"]) {
		const transaction = {
			docChanged: true,
			startState: binding.cm.state,
			newDoc: { toString: () => "typing now!" },
			annotation: () => userEvent,
			isUserEvent: (event: string) =>
				userEvent === event || userEvent.startsWith(`${event}.`),
		};
		const result = (manager as unknown as {
			filterRiskyNonUserPatch: (transaction: unknown) => unknown;
		}).filterRiskyNonUserPatch(transaction);
		assertEq(result, transaction, `${userEvent} passes through during remote typing awareness`);
	}

	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		true,
		"remote typing awareness does not detach the editor binding",
	);
	assertEq(
		warningCalls,
		2,
		"normal and IME input both request a non-blocking advisory warning",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 20: opening a local-only conflict note never creates a CRDT file ---");
{
	const path = "Notes/plan (KAOS conflict - crdt from Laptop 2026-07-13T12-00-00Z).md";
	let ensureFileCalls = 0;
	const vaultSync = {
		provider: { awareness: { setLocalStateField: () => {} } },
		getTextForPath: () => null,
		getFileId: () => undefined,
		getFileIdForText: () => undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: () => {
			ensureFileCalls++;
			return null;
		},
	};
	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p) => isMarkdownSyncable(p, [], ".obsidian"),
	);
	const cm = {
		dom: { isConnected: true },
		state: { doc: { length: 4, toString: () => "copy" }, facet: () => null },
		dispatch: () => {},
	};
	(manager as unknown as { getCmView: () => unknown }).getCmView = () => cm;
	const view = {
		file: { path },
		leaf: { id: "conflict-leaf" },
		containerEl: { contains: () => true },
		editor: { getValue: () => "copy" },
	};

	manager.bind(view as never, "TestDevice");

	assertEq(ensureFileCalls, 0, "conflict note open is rejected before ensureFile");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("conflict-leaf"),
		false,
		"conflict note receives no collaborative editor binding",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 21: excluded Markdown is rejected by the final binding-target guard ---");
{
	const path = "Private/local.md";
	let ensureFileCalls = 0;
	const vaultSync = {
		getTextForPath: () => null,
		getFileId: () => undefined,
		getFileIdForText: () => undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: () => {
			ensureFileCalls++;
			return null;
		},
	};
	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		() => false,
	);
	const view = {
		file: { path },
		leaf: { id: "excluded-leaf" },
		editor: { getValue: () => "local" },
	};

	const target = (manager as unknown as {
		resolveBindingTarget: (view: unknown, deviceName: string, reason: string) => unknown;
	}).resolveBindingTarget(view, "TestDevice", "direct-guard-test");

	assertEq(target, null, "excluded path has no binding target");
	assertEq(ensureFileCalls, 0, "final binding-target guard blocks direct ensureFile access");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 22: pre-bind user input invalidates an open-editor mutation ticket ---");
{
	const path = "Notes/opening.md";
	const vaultSync = {
		provider: { awareness: { setLocalStateField: () => {} } },
		getTextForPath: () => null,
		getFileId: () => undefined,
		getFileIdForText: () => undefined,
	};
	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p) => p.endsWith(".md"),
	);
	const cmDom = { isConnected: true };
	let editorContent = "start";
	const cm = {
		dom: cmDom,
		hasFocus: true,
		state: {
			doc: { length: editorContent.length, toString: () => editorContent },
			facet: () => null,
		},
		dispatch: () => {},
	};
	const view = {
		file: { path },
		leaf: { id: "opening-leaf" },
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: { getValue: () => editorContent },
	};
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(cm);

	const before = manager.captureOpenEditorMutationTicket(path, [view as never]);
	editorContent = "start 한글";
	cm.state = {
		doc: { length: editorContent.length, toString: () => editorContent },
		facet: () => null,
	};
	(manager as unknown as {
		handleLiveEditorUpdate: (update: unknown) => void;
	}).handleLiveEditorUpdate({
		view: cm,
		docChanged: true,
		transactions: [{
			docChanged: true,
			annotation: () => "input.type.compose",
			isUserEvent: (name: string) => name === "input",
		}],
	});

	const stale = manager.validateOpenEditorMutationTicket(before, [view as never]);
	assertEq(stale.current, false, "first input invalidates a ticket captured before binding");
	const after = manager.captureOpenEditorMutationTicket(path, [view as never]);
	assertEq(
		manager.validateOpenEditorMutationTicket(after, [view as never]).current,
		false,
		"a fresh editor read cannot replace missing target-presentation proof",
	);
	assertEq(
		manager.getLastEditorActivityForPath(path),
		null,
		"pre-bind input is not assigned to a path before target presentation proof",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 23: binding epoch changes invalidate in-flight mutation tickets ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const ticket = manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
	(manager as unknown as { bumpBindingEpoch: (leafId: string) => number })
		.bumpBindingEpoch("leaf-1");
	const validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(validation.current, false, "a new binding epoch invalidates the previous ticket");
	assertEq(
		validation.current ? null : validation.reason,
		"binding-epoch-changed",
		"ticket reports the binding epoch change",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 24: pending replacement states resolve to the guarded binding ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const liveDom = { isConnected: true };
	const liveState = {
		doc: binding.cm.state.doc,
		facet: () => null,
	};
	const liveCm = {
		dom: liveDom,
		hasFocus: true,
		state: liveState,
		dispatch: () => {},
	};
	binding.cm.dom.isConnected = false;
	binding.view.containerEl = { contains: (node: unknown) => node === liveDom };
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(liveCm);
	(manager as unknown as { pendingReplacementCmToLeafId: WeakMap<object, string> })
		.pendingReplacementCmToLeafId.set(liveCm, "leaf-1");

	const match = (manager as unknown as {
		findBindingForState: (state: unknown) => { leafId: string } | null;
	}).findBindingForState(liveState);
	assertEq(match?.leafId, "leaf-1", "transaction state lookup includes pending replacement CM views");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 25: stale path bindings detach before user input propagates ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	binding.view.file = { path: "Notes/next.md" };
	const result = (manager as unknown as {
		fenceStaleUserBinding: (transaction: unknown) => unknown;
	}).fenceStaleUserBinding({
		docChanged: true,
		startState: binding.cm.state,
		annotation: () => "input",
		isUserEvent: (name: string) => name === "input",
	});
	assertEq(result !== null, true, "stale binding adds a same-transaction detach effect");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		false,
		"stale path binding is removed before the editor update phase",
	);
	await Promise.resolve();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 26: same-leaf CM overlap selects the focused replacement editor ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const nextPath = "Notes/next.md";
	const sharedContent = "identical note body";
	const oldDom = binding.cm.dom;
	const newDom = { isConnected: true };
	binding.view.file = { path: nextPath };
	binding.view.editor = { getValue: () => sharedContent };
	binding.view.containerEl = {
		contains: (node: unknown) => node === oldDom || node === newDom,
	};
	binding.cm.hasFocus = false;
	binding.cm.state = {
		doc: { length: sharedContent.length, toString: () => sharedContent },
		facet: () => null,
	};
	const replacementCm = {
		dom: newDom,
		hasFocus: true,
		state: {
			doc: { length: sharedContent.length, toString: () => sharedContent },
			facet: () => null,
		},
		dispatch: () => {},
	};
	const known = (manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews;
	known.add(binding.cm);
	known.add(replacementCm);

	const resolved = (manager as unknown as {
		getCmView: (view: unknown) => unknown;
	}).getCmView(binding.view);
	assertEq(resolved, replacementCm, "focused replacement CM wins over connected stale CM with identical text");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 27: indistinguishable same-leaf CM overlap waits instead of guessing ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const sharedContent = "identical note body";
	const oldDom = binding.cm.dom;
	const newDom = { isConnected: true };
	binding.view.file = { path: "Notes/next.md" };
	binding.view.editor = { getValue: () => sharedContent };
	binding.view.containerEl = {
		contains: (node: unknown) => node === oldDom || node === newDom,
	};
	binding.cm.hasFocus = false;
	binding.cm.state = {
		doc: { length: sharedContent.length, toString: () => sharedContent },
		facet: () => null,
	};
	const replacementCm = {
		dom: newDom,
		hasFocus: false,
		state: {
			doc: { length: sharedContent.length, toString: () => sharedContent },
			facet: () => null,
		},
		dispatch: () => {},
	};
	const known = (manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews;
	known.add(binding.cm);
	known.add(replacementCm);

	const resolved = (manager as unknown as {
		getCmView: (view: unknown) => unknown;
	}).getCmView(binding.view);
	assertEq(resolved, null, "ambiguous identical CM overlap defers binding until identity is clear");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 28: apply guard rejects a stale CM even when document bytes match ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const nextPath = "Notes/next.md";
	const sharedContent = "identical note body";
	const oldDom = binding.cm.dom;
	const newDom = { isConnected: true };
	binding.view.file = { path: nextPath };
	binding.view.editor = { getValue: () => sharedContent };
	binding.view.containerEl = {
		contains: (node: unknown) => node === oldDom || node === newDom,
	};
	binding.cm.hasFocus = false;
	binding.cm.state = {
		doc: { length: sharedContent.length, toString: () => sharedContent },
		facet: () => null,
	};
	const replacementCm = {
		dom: newDom,
		hasFocus: true,
		state: {
			doc: { length: sharedContent.length, toString: () => sharedContent },
			facet: () => null,
		},
		dispatch: () => {},
	};
	const nextDoc = new Y.Doc();
	const nextText = nextDoc.getText("content");
	nextText.insert(0, sharedContent);
	const known = (manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews;
	known.add(binding.cm);
	known.add(replacementCm);
	let staleDispatches = 0;
	binding.cm.dispatch = () => {
		staleDispatches++;
	};

	const applied = (manager as unknown as {
		applyBinding: (options: unknown) => boolean;
	}).applyBinding({
		action: "bind",
		deviceName: "TestDevice",
		view: binding.view,
		cm: binding.cm,
		cmId: "cm-old",
		leafId: "leaf-1",
		filePath: nextPath,
		ytext: nextText,
		fileId: "file-next",
	});

	assertEq(applied, false, "apply guard refuses the non-current CM identity");
	assertEq(staleDispatches, 1, "unsupported replacement detaches the stale CM exactly once");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.get("leaf-1"),
		undefined,
		"rejected stale apply leaves no unfenced previous binding",
	);
	nextDoc.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 29: rapid same-leaf switch gates the replacement without moving selection ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const nextPath = "Notes/long-next.md";
	const nextContent = `heading\n${"x".repeat(2200)}\nfooter`;
	const nextDoc = new Y.Doc();
	const nextText = nextDoc.getText("content");
	nextText.insert(0, nextContent);
	manager.manageView(binding.view as never);
	const oldDom = binding.cm.dom;
	const newDom = { isConnected: true };
	const scrollDOM = { scrollTop: 840 };
	let replacementState = EditorState.create({
		doc: nextContent,
		selection: { anchor: 1100, head: 1125 },
		extensions: [manager.compartment.of([])],
	});
	const replacementTransactions: Array<{
		docChanged: boolean;
		scrollIntoView: boolean;
	}> = [];
	const replacementCm = {
		dom: newDom,
		hasFocus: true,
		get state() {
			return replacementState;
		},
		dispatch(spec: TransactionSpec) {
			const transaction = replacementState.update(spec);
			replacementState = transaction.state;
			replacementTransactions.push({
				docChanged: transaction.docChanged,
				scrollIntoView: transaction.scrollIntoView,
			});
		},
		scrollDOM,
	};
	let oldDispatches = 0;
	binding.cm.dispatch = () => {
		oldDispatches++;
	};
	binding.cm.hasFocus = false;
	binding.lastBoundAtMs = Date.now();
	const nextFile = { path: nextPath };
	binding.view.file = nextFile;
	binding.view.editor = { getValue: () => nextContent };
	binding.view.containerEl = {
		contains: (node: unknown) => node === oldDom || node === newDom,
	};
	const known = (manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews;
	known.add(binding.cm);
	known.add(replacementCm);
	installManagedBoundaryStubs(manager, binding.view, replacementCm);
	const fixtureVaultSync = (manager as unknown as {
		vaultSync: {
			getTextForPath: (path: string) => Y.Text | null;
			getFileId: (path: string) => string | undefined;
			getFileIdForText: (text: Y.Text) => string | undefined;
		};
	}).vaultSync;
	fixtureVaultSync.getTextForPath = (path: string) => path === nextPath ? nextText : binding.ytext;
	fixtureVaultSync.getFileId = (path: string) => path === nextPath ? "file-next" : "file-1";
	fixtureVaultSync.getFileIdForText = (text: Y.Text) => text === nextText ? "file-next" : "file-1";

	manager.bind(binding.view as never, "TestDevice");

	const rebound = (manager as unknown as {
		bindings: Map<string, { path: string; cm: unknown; settleWindowMs: number }>;
	}).bindings.get("leaf-1");
	assertEq(rebound, undefined, "rapid switch remains detached until a presentation receipt");
	assertEq(oldDispatches, 1, "old CM is detached exactly once");
	assertEq(replacementTransactions.length, 0, "unproven replacement CM is not configured");
	assertEq(replacementState.selection.main.anchor, 1100, "selection anchor survives binding reconfigure");
	assertEq(replacementState.selection.main.head, 1125, "selection head survives binding reconfigure");
	assertEq(scrollDOM.scrollTop, 840, "binding reconfigure leaves scrollTop untouched");
	assertEq(replacementState.facet(ySyncFacet), undefined, "unproven replacement receives no Y.Text");
	const session = manager.getManagedSession(binding.view as never);
	assertEq(session?.displayedLineage.kind, "known", "rapid switch keeps a known source lineage");
	assertEq(
		session?.displayedLineage.kind === "known" ? session.displayedLineage.path : null,
		binding.path,
		"rapid switch keeps A as displayed lineage",
	);
	assertEq(session?.handoff?.targetFile, nextFile, "rapid switch keeps the exact B target identity");
	nextDoc.destroy();
	clearPendingHealthChecks(manager);
}

type MissingTargetEntry = "bind" | "repair" | "heal" | "rebind" | "stale-user" | "health";

async function exerciseMissingTargetEntry(entry: MissingTargetEntry): Promise<void> {
	const sourcePath = `Notes/task6-${entry}-A.md`;
	const targetPath = `Notes/task6-${entry}-B.md`;
	const sourceFile = { path: sourcePath, stat: { ctime: 1, mtime: 1, size: 12 } };
	const targetFile = { path: targetPath, stat: { ctime: 2, mtime: 2, size: 0 } };
	const sourceDoc = new Y.Doc();
	const sourceText = sourceDoc.getText("content");
	const sourceContent = "source bytes";
	sourceText.insert(0, sourceContent);
	const admissionRequests: Array<Record<string, unknown>> = [];
	const effectOrder: string[] = [];
	let ensureFileCalls = 0;
	let undoDestroyCalls = 0;
	let cmDocumentMutationCalls = 0;
	const awareness = { setLocalStateField: () => {} };
	const vaultSync = {
		provider: { awareness },
		getTextForPath: (path: string) => path === sourcePath ? sourceText : null,
		getFileId: (path: string) => path === sourcePath ? "source-file-id" : undefined,
		getFileIdForText: (text: Y.Text) => text === sourceText ? "source-file-id" : undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		ensureFile: () => {
			ensureFileCalls += 1;
			return null;
		},
	};
	const Manager = EditorBindingManager as unknown as new (...args: unknown[]) => EditorBindingManager;
	const manager = new Manager(
		vaultSync,
		false,
		(path: string) => path.endsWith(".md"),
		(_source: string, message: string, details?: Record<string, unknown>) => {
			if (message === "handoff-effect-applied" && typeof details?.effect === "string") {
				effectOrder.push(details.effect);
			}
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		(request: Record<string, unknown>) => admissionRequests.push(request),
	);
	let cmState = EditorState.create({
		doc: sourceContent,
		extensions: [manager.compartment.of([])],
	});
	const cmDom = { isConnected: true };
	const cm = {
		dom: cmDom,
		hasFocus: true,
		get state() { return cmState; },
		dispatch(spec: TransactionSpec) {
			const transaction = cmState.update(spec);
			if (transaction.docChanged) cmDocumentMutationCalls += 1;
			cmState = transaction.state;
		},
	};
	const requestSave = Object.assign(function requestSave() {}, {
		cancel: () => {},
	});
	let hostData = sourceContent;
	const leaf = {
		id: `leaf-${entry}`,
		workspace: {
			activeLeaf: null as unknown,
			iterateAllLeaves(callback: (candidate: { view: unknown }) => void) {
				callback({ view });
			},
		},
	};
	const view = {
		file: sourceFile,
		leaf,
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: { getValue: () => sourceContent },
		data: hostData,
		dirty: false,
		getViewData: () => hostData,
		onUnloadFile: function onUnloadFile(_file: unknown) {},
		onLoadFile: function onLoadFile(_file: unknown) {},
		setViewData: function setViewData(data: string, _clear: boolean) {
			hostData = data;
			this.data = data;
		},
		requestSave,
		save: function save() {},
	};
	leaf.workspace.activeLeaf = leaf;
	const undoManager = new Y.UndoManager(sourceText);
	undoManager.destroy = () => { undoDestroyCalls += 1; };
	const binding = {
		view,
		file: sourceFile,
		path: sourcePath,
		undoManager,
		ytext: sourceText,
		cm,
		cmId: `cm-${entry}`,
		fileId: "source-file-id",
		lastBoundAt: new Date().toISOString(),
		lastBoundAtMs: Date.now() - 10_000,
		lastEditorChangeAtMs: Date.now() - 10_000,
		lastEditorDocChangeAtMs: Date.now() - 10_000,
		settleWindowMs: 0,
	};
	const runtime = manager as unknown as {
		manageView?: (managedView: unknown) => unknown;
		getManagedSession?: (managedView: unknown) => {
			displayedLineage: { kind: string; path?: string; file?: unknown };
			generation: number;
		} | null;
		getBinding?: (managedView: unknown) => unknown;
		beginPathHandoff?: (managedView: unknown, target: unknown, reason: string) => boolean;
		bindings: Map<string, unknown>;
		knownCmViews: Set<unknown>;
		cmToLeafId: WeakMap<object, string>;
		lastUserDocChangeAtByCm: WeakMap<object, number>;
		lastEditorDocChangeAtByPath: Map<string, number>;
		pathEditorAuthorityPort?: {
			capturePathEditorAuthority: (path: string) => unknown;
		};
		fenceStaleUserBinding: (transaction: unknown) => unknown;
		maybeHealBinding: (leafId: string, candidate: unknown, source: string) => void;
		unmanageView?: (managedView: unknown, reason: string) => void;
		managedSessions: Map<string, { cmGuard: unknown }>;
	};
	runtime.bindings.set(leaf.id, binding);
	runtime.knownCmViews.add(cm);
	runtime.cmToLeafId.set(cm, leaf.id);
	runtime.lastUserDocChangeAtByCm.set(cm, Date.now());
	runtime.lastEditorDocChangeAtByPath.set(sourcePath, Date.now());

	assertEq(typeof runtime.manageView, "function", `${entry}: managed-view API exists`);
	if (typeof runtime.manageView !== "function") {
		undoManager.destroy();
		sourceDoc.destroy();
		clearPendingHealthChecks(manager);
		return;
	}
	runtime.manageView(view);
	const managedRuntime = runtime.managedSessions.get(leaf.id);
	if (!managedRuntime) throw new Error(`Expected managed runtime for ${entry}`);
	let cmGuardInert = false;
	let cmGateClosed = false;
	managedRuntime.cmGuard = {
		refreshGate: () => {
			cmGateClosed = true;
			return true;
		},
		markInert: () => {
			cmGuardInert = true;
			cmGateClosed = false;
			return true;
		},
		restoreIfCurrent: () => {
			cmGuardInert = true;
			cmGateClosed = false;
			return true;
		},
		snapshot: () => ({
			view: cm,
			inert: cmGuardInert,
			gateClosed: cmGateClosed,
			selectionEpoch: 0,
			scrollEpoch: 0,
			gateFailureReason: null,
			commitState: "none",
			pendingHostLoadCandidate: null,
		}),
	};
	let authorityObservedBeforeDetach = false;
	let capturedAuthority: { kind?: unknown; reason?: unknown } | null = null;
	const authorityPort = runtime.pathEditorAuthorityPort;
	if (authorityPort) {
		const originalCapture = authorityPort.capturePathEditorAuthority.bind(authorityPort);
		authorityPort.capturePathEditorAuthority = (path: string) => {
			if (path === sourcePath) {
				authorityObservedBeforeDetach = runtime.bindings.get(leaf.id) === binding;
			}
			const authority = originalCapture(path) as { kind?: unknown; reason?: unknown };
			if (path === sourcePath) capturedAuthority = authority;
			return authority;
		};
	}

	view.file = targetFile;
	switch (entry) {
		case "bind":
			manager.bind(view as never, "TestDevice");
			break;
		case "repair":
			manager.repair(view as never, "TestDevice", "task6-missing-target");
			break;
		case "heal":
			manager.heal(view as never, "TestDevice", "task6-missing-target");
			break;
		case "rebind":
			manager.rebind(view as never, "TestDevice", "task6-missing-target");
			break;
		case "stale-user": {
			const transaction = cmState.update({
				changes: { from: sourceContent.length, insert: "!" },
				annotations: Transaction.userEvent.of("input.type"),
			});
			runtime.fenceStaleUserBinding(transaction);
			break;
		}
		case "health":
			runtime.maybeHealBinding(leaf.id, binding, "retry-health-check");
			break;
	}
	await Promise.resolve();

	assertEq(ensureFileCalls, 0, `${entry}: no binding-layer Y.Text creation`);
	assertEq(admissionRequests.length, 1, `${entry}: one exact admission wake request`);
	const request = admissionRequests[0];
	assertEq(request?.targetFile, targetFile, `${entry}: admission keeps exact target TFile`);
	assertEq(request?.targetPath, targetPath, `${entry}: admission keeps exact target path`);
	assertEq("content" in (request ?? {}), false, `${entry}: admission carries no editor content`);
	assertEq(runtime.getBinding?.(view) ?? runtime.bindings.get(leaf.id) ?? null, null, `${entry}: binding is detached`);
	const session = runtime.getManagedSession?.(view) ?? null;
	assertEq(session?.displayedLineage.kind, "known", `${entry}: displayed lineage remains known`);
	assertEq(session?.displayedLineage.path, sourcePath, `${entry}: displayed lineage remains A`);
	assertEq(session?.displayedLineage.file, sourceFile, `${entry}: displayed lineage keeps exact A TFile`);
	assertEq(effectOrder.slice(0, 5).join("|"), [
		"cancel-pending-save",
		"block-save",
		"install-input-gate",
		"capture-authority-before-detach",
		"detach-binding",
	].join("|"), `${entry}: exact five-effect handoff prefix`);
	assertEq(sourceText.toString(), sourceContent, `${entry}: source Y.Text is unchanged`);
	assertEq(cmDocumentMutationCalls, 0, `${entry}: handoff performs no CM document mutation`);
	assertEq(runtime.lastEditorDocChangeAtByPath.has(targetPath), false, `${entry}: A activity is not relabelled B`);
	assertEq(undoDestroyCalls, 1, `${entry}: source UndoManager is destroyed exactly once`);
	assertEq(authorityObservedBeforeDetach, true, `${entry}: source authority is captured before map deletion`);
	assertEq(capturedAuthority?.kind, "blocked", `${entry}: late mismatch source authority is fail-closed`);
	assertEq(capturedAuthority?.reason, "transitioning", `${entry}: late mismatch reports a transition`);
	runtime.unmanageView?.(view, "teardown");
	clearPendingHealthChecks(manager);
	sourceDoc.destroy();
}

console.log("\n--- Test 30: every path-mismatch entry is a managed missing-target handoff ---");
for (const entry of ["bind", "repair", "heal", "rebind", "stale-user", "health"] as const) {
	await exerciseMissingTargetEntry(entry);
}

console.log("\n--- Test 30a: host load entry returns a ticket before view.file publishes the target ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		beginPathHandoff: (
			view: unknown,
			targetFile: unknown,
			reason: string,
			provenance: "selected",
			sourceUnloadReceiptId: string,
		) => boolean;
	};
	const sourceFile = binding.view.file;
	const targetFile = { path: "Notes/host-entry-target.md" };
	const accepted = runtime.beginPathHandoff(
		binding.view,
		targetFile,
		"host-load-entry",
		"selected",
		"source-unload:exact-host-entry",
	);
	const session = manager.getManagedSession(binding.view as never);

	assertEq(
		binding.view.file,
		sourceFile,
		"host callback still exposes the exact source file before native delegation",
	);
	assertEq(accepted, true, "selected host entry returns the ticket-producing handoff");
	assertEq(session?.handoff?.targetFile, targetFile, "host entry retains the exact target TFile");
	assertEq(
		session?.handoff?.sourceUnloadReceiptId,
		"source-unload:exact-host-entry",
		"host entry retains the exact source-unload receipt",
	);
	manager.unbindAll();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 30b: file-open before target CM mount retains the exact guarded source boundary ---");
{
	const { manager, binding, traceRecords } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	type TestRuntime = {
		session: ManagedLeafSession;
		hostGuard: {
			snapshot(): Record<string, unknown>;
			[key: string]: unknown;
		} | null;
		cmGuard: {
			snapshot(): Readonly<{ gateClosed: boolean }>;
		} | null;
	};
	const internals = manager as unknown as {
		managedSessions: Map<string, TestRuntime>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime?.hostGuard) throw new Error("Expected guarded source runtime");
	const sourceFile = binding.view.file;
	const sourceHostGuard = runtime.hostGuard;
	const sourceHostSnapshot = sourceHostGuard.snapshot();
	const sourceUnloadReceiptId = "source-unload:file-open-before-cm";
	runtime.hostGuard = {
		...sourceHostGuard,
		snapshot: () => ({
			...sourceHostSnapshot,
			sourceUnload: {
				receiptId: sourceUnloadReceiptId,
				unloadId: 1,
				file: sourceFile,
				path: sourceFile.path,
				state: "settled",
				forcedSaveObserved: true,
				cacheRetiredBeforeUnloadSettled: true,
			},
		}),
	};
	const targetFile = { path: "Notes/file-open-before-cm.md" };
	(binding.view as unknown as {
		file: unknown;
		editor: { getValue(): string };
	}).file = targetFile;
	(binding.view as unknown as {
		editor: { getValue(): string };
	}).editor.getValue = () => "target host facade before CM mount";

	manager.bind(binding.view as never, "TestDevice");

	const retained = internals.managedSessions.get("leaf-1") ?? null;
	assertEq(retained !== null, true, "unresolved target CM does not unmanage the guarded source runtime");
	assertEq(retained?.session.handoff?.targetFile, targetFile, "the exact observed target is retained");
	assertEq(
		retained?.session.handoff?.sourceUnloadReceiptId,
		sourceUnloadReceiptId,
		"the file-open wake inherits only the exact source-unload receipt",
	);
	assertEq(
		retained?.session.currentSwitchIntentSeq !== null,
		true,
		"the source-unload receipt mints selected-switch provenance before target CM mount",
	);
	assertEq(manager.getBinding(binding.view as never), null, "source Y.Text is detached during the retained transition");
	assertEq(retained?.cmGuard?.snapshot().gateClosed, true, "the guarded source CM closes its input gate");
	assertEq(
		traceRecords.some((record) => record.msg === "managed-transition-boundary-retained"),
		true,
		"the exact transitional fallback emits a bounded trace",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 30c: a later exact host selection promotes the same observed target ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		beginPathHandoff: (
			view: unknown,
			targetFile: unknown,
			reason: string,
			provenance?: "observed" | "selected",
			sourceUnloadReceiptId?: string | null,
		) => boolean;
	};
	const targetFile = { path: "Notes/observed-then-selected.md" };
	(binding.view as unknown as { file: unknown }).file = targetFile;
	assertEq(
		runtime.beginPathHandoff(binding.view, targetFile, "file-open-observed"),
		true,
		"the public file-open wake records the observed target",
	);
	const observed = manager.getManagedSession(binding.view as never);
	assertEq(observed?.handoff?.sourceUnloadReceiptId, null, "observation alone mints no unload authority");
	assertEq(observed?.currentSwitchIntentSeq, null, "observation alone mints no switch sequence");
	assertEq(observed?.binding.kind, "unbound", "observation completes the source detach");
	assertEq(observed?.handoff?.phase, "awaiting-host-load", "observation waits for exact host selection");
	assertEq(
		observed?.completedDetachEpoch,
		observed?.handoff?.bindingEpochAfterDetach,
		"observation retains the exact completed detach epoch",
	);
	const observedGeneration = observed?.generation ?? -1;

	assertEq(
		runtime.beginPathHandoff(
			binding.view,
			targetFile,
			"host-load-entry",
			"selected",
			"source-unload:observed-then-selected",
		),
		true,
		"the exact host callback promotes the already-observed target",
	);
	const selected = manager.getManagedSession(binding.view as never);
	assertEq(selected?.generation, observedGeneration + 1, "promotion advances the handoff generation");
	assertEq(
		selected?.handoff?.sourceUnloadReceiptId,
		"source-unload:observed-then-selected",
		"promotion retains the exact source-unload receipt",
	);
	assertEq(selected?.currentSwitchIntentSeq, 1, "promotion mints one exact switch sequence");
	assertEq(selected?.handoff?.targetFile, targetFile, "promotion retains the exact target identity");
	clearPendingHealthChecks(manager);
}

{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => unknown;
		beginPathHandoff: (view: unknown, targetFile: unknown, reason: string) => boolean;
		managedSessions: Map<string, {
			capturedSourceAuthority: {
				kind: string;
				content?: string;
				lease?: unknown;
			} | null;
		}>;
		unmanageView: (view: unknown, reason: string) => void;
	};
	runtime.manageView(binding.view);
	const targetFile = { path: "Notes/proactive-target.md" };
	runtime.beginPathHandoff(binding.view, targetFile, "host-load-entry");
	const captured = runtime.managedSessions.get("leaf-1")?.capturedSourceAuthority ?? null;
	assertEq(captured?.kind, "proven-single", "proactive source authority is captured before target state publication");
	assertEq(captured?.content, "typing now", "proactive source authority retains exact source bytes");
	assertEq(typeof captured?.lease, "object", "proactive source authority includes a nominal lease");
	runtime.unmanageView(binding.view, "teardown");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 31: handoff generation rejects same-path/same-bytes ticket ABA ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView?: (view: unknown) => unknown;
		beginPathHandoff?: (view: unknown, targetFile: unknown, reason: string) => boolean;
	};
	assertEq(typeof runtime.manageView, "function", "ticket ABA fixture has managed-view API");
	assertEq(typeof runtime.beginPathHandoff, "function", "ticket ABA fixture has handoff API");
	if (runtime.manageView && runtime.beginPathHandoff) {
		const originalFile = binding.view.file;
		runtime.manageView(binding.view);
		const ticket = manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
		const temporaryFile = { path: "Notes/temporary-B.md" };
		binding.view.file = temporaryFile;
		runtime.beginPathHandoff(binding.view, temporaryFile, "ticket-aba-B");
		binding.view.file = originalFile;
		runtime.beginPathHandoff(binding.view, originalFile, "ticket-aba-A");
		const validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
		assertEq(validation.current, false, "generation-only ABA invalidates the ticket");
		assertEq(
			validation.current ? null : validation.reason,
			"handoff-generation-changed",
			"generation-only ABA reports the handoff generation fence",
		);
	}
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 32: real EditorView rejects a stale user dispatch at the final guard ---");
{
	const repoRoot = new URL("..", import.meta.url).pathname;
	const obsidianMockPath = new URL("./mocks/obsidian.ts", import.meta.url).pathname;
	const browserEntry = String.raw`
				import * as Y from "yjs";
				import { Awareness } from "y-protocols/awareness";
				import { EditorState, Transaction } from "@codemirror/state";
				import { EditorView } from "@codemirror/view";
				import { EditorBindingManager } from "./src/sync/editorBinding";

				window.__TASK6_STALE_DISPATCH__ = (async () => {
					const pathA = "Notes/browser-A.md";
					const pathB = "Notes/browser-B.md";
					const fileA = { path: pathA };
					const fileB = { path: pathB };
					const doc = new Y.Doc();
					const ytext = doc.getText("content");
					ytext.insert(0, "source");
					const awareness = new Awareness(doc);
					const admissions = [];
					const vaultSync = {
						provider: { awareness },
						getTextForPath: (path) => path === pathA ? ytext : null,
						getFileId: (path) => path === pathA ? "file-A" : undefined,
						getFileIdForText: (text) => text === ytext ? "file-A" : undefined,
						isPendingRenameTarget: () => false,
						isMarkdownTombstoned: () => false,
					};
					const manager = new EditorBindingManager(
						vaultSync,
						false,
						(path) => path.endsWith(".md"),
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						(request) => admissions.push(request),
					);
					const parent = document.createElement("div");
					document.body.appendChild(parent);
					const leaf = {
						id: "browser-leaf",
						workspace: {
							activeLeaf: null,
							iterateAllLeaves(callback) { callback({ view }); },
						},
					};
					const requestSave = Object.assign(function requestSave() {}, { cancel() {} });
					let hostData = "source";
					let cm;
					const view = {
						file: fileA,
						leaf,
						containerEl: parent,
						editor: { getValue: () => cm.state.doc.toString() },
						data: hostData,
						dirty: false,
						getViewData: () => hostData,
						onUnloadFile: function onUnloadFile(_file) {},
						onLoadFile: function onLoadFile(_file) {},
						setViewData: function setViewData(data, _clear) { hostData = data; this.data = data; },
						requestSave,
						save: function save() {},
					};
					leaf.workspace.activeLeaf = leaf;
					cm = new EditorView({
						parent,
						state: EditorState.create({ doc: "source", extensions: [manager.getBaseExtension()] }),
					});
					manager.bindings.set("browser-leaf", {
						view,
						file: fileA,
						path: pathA,
						undoManager: new Y.UndoManager(ytext),
						ytext,
						cm,
						cmId: "browser-source-cm",
						fileId: "file-A",
						lastBoundAt: new Date().toISOString(),
						lastBoundAtMs: Date.now() - 10_000,
						lastEditorChangeAtMs: Date.now() - 10_000,
						lastEditorDocChangeAtMs: null,
						settleWindowMs: 0,
					});
					manager.bind(view, "Browser");
					const initiallyBound = manager.getBinding(view) !== null;
					view.file = fileB;
					cm.dispatch({
						changes: { from: cm.state.doc.length, insert: "!" },
						annotations: Transaction.userEvent.of("input.type"),
					});
					await Promise.resolve();
					const session = manager.getManagedSession(view);
					const result = {
						initiallyBound,
						cmContent: cm.state.doc.toString(),
						yContent: ytext.toString(),
						bindingDetached: manager.getBinding(view) === null,
						lineagePath: session?.displayedLineage.kind === "known"
							? session.displayedLineage.path
							: null,
						admissionCount: admissions.length,
					};
					manager.unbindAll();
					cm.destroy();
					doc.destroy();
					return result;
				})();

				window.__TASK9_GUARDED_PRESENTATION__ = (async () => {
					const runScenario = async ({
						suffix,
						contentA,
						contentB,
						contentC = null,
						failFirstBindFreshness = false,
						deferFirstPresentation = false,
						replanFirstCompletion = false,
					}) => {
					const pathA = "Notes/task9-browser-" + suffix + "-A.md";
					const pathB = "Notes/task9-browser-" + suffix + "-B.md";
					const pathC = "Notes/task9-browser-" + suffix + "-C.md";
					const fileA = { path: pathA };
					const fileB = { path: pathB };
					const fileC = { path: pathC };
					const doc = new Y.Doc();
					const ytextA = doc.getText("content-A");
					const ytextB = doc.getText("content-B");
					const ytextC = doc.getText("content-C");
					ytextA.insert(0, contentA);
					ytextB.insert(0, contentB);
					if (contentC !== null) ytextC.insert(0, contentC);
					const awareness = new Awareness(doc);
					const controllerCalls = [];
					const releasePresentationByPath = new Map();
					const targetTokenByPath = new Map();
					let bindFreshnessChecks = 0;
					let presentationRequests = 0;
					let presentationCompletions = 0;
					let hostLoadDispatchActive = false;
					let presentationRequestedInsideHostLoad = false;
					const presentationReadyNotifications = [];
					const targetForPath = (path) => path === pathC && contentC !== null
						? { file: fileC, ytext: ytextC, content: contentC, fileId: "file-C", suffix: "C" }
						: { file: fileB, ytext: ytextB, content: contentB, fileId: "file-B", suffix: "B" };
					const controller = {
						requestTargetPresentation(request) {
							if (hostLoadDispatchActive) {
								presentationRequestedInsideHostLoad = true;
							}
							controllerCalls.push("request-presentation");
							presentationRequests += 1;
							if (deferFirstPresentation && presentationRequests === 1) {
								return Promise.resolve({
									kind: "deferred",
									reason: "authority-blocked",
								});
							}
							return new Promise((resolve) => {
								const target = targetForPath(request.targetPath);
								releasePresentationByPath.set(request.targetPath, () => resolve({
									kind: "planned",
									plan: {
										planId: "presentation-plan-" + target.suffix,
										hostLoadTokenId: request.candidate.hostLoadTokenId,
										switchIntentSeq: request.switchIntentSeq,
										authorityFreshnessHandleId: "presentation-freshness-" + target.suffix,
										expectedNativeHistoryEpoch: request.candidate.nativeHistoryEpochBefore,
										presentationPermitId: "presentation-permit-" + target.suffix,
									},
								}));
							});
						},
						consumeTargetPresentationPermit(_permitId, context) {
							controllerCalls.push("consume-presentation");
							const target = targetForPath(context.targetPath);
							return context.targetFile === target.file
								&& context.candidate.incomingContent === target.content;
						},
						completeTargetPresentation(receipt) {
							controllerCalls.push("complete-presentation");
							presentationCompletions += 1;
							if (replanFirstCompletion && presentationCompletions === 1) {
								return Promise.resolve({
									kind: "replan",
									reason: "authority-changed",
								});
							}
							const target = targetForPath(receipt.targetPath);
							const targetToken = Object.freeze({
								tokenId: "target-ready-" + target.suffix,
								sessionId: receipt.sessionId,
								authorityFreshnessHandleId: "bind-freshness-" + target.suffix,
								authorityFingerprint: "authority-" + target.suffix,
								controllerLifecycleGeneration: 1,
								leafId: receipt.leafId,
								handoffGeneration: receipt.handoffGeneration,
								switchIntentSeq: receipt.switchIntentSeq,
								targetPath: receipt.targetPath,
								targetFile: target.file,
								targetAuthority: {
									kind: "existing",
									fileId: target.fileId,
									ytextIdentity: "ytext-" + target.suffix,
									ytextMutationEpoch: 0,
									bindPermitId: "bind-permit-" + target.suffix,
								},
								hostLoadTokenId: receipt.hostLoadTokenId,
								hostLoadCompletedEpoch: receipt.nativeHistoryEpoch,
								hostLoadReceiptId: receipt.receiptId,
								nativeHistoryEpoch: receipt.nativeHistoryEpoch,
								targetSelectionEpoch: receipt.targetSelectionEpoch,
								targetScrollEpoch: receipt.targetScrollEpoch,
								certifiedBaseContent: target.content,
								certifiedBaseHash: "hash-" + target.suffix,
								openEditorTicketId: "ticket-" + target.suffix,
							});
							targetTokenByPath.set(receipt.targetPath, targetToken);
							return Promise.resolve({
								kind: "accepted",
								receipt: {
									receiptId: "presentation-receipt-" + target.suffix,
									presentationPlanId: "presentation-plan-" + target.suffix,
									hostLoadCompletionReceipt: receipt,
									replacementTargetReadyToken: targetToken,
								},
							});
						},
						requestOpenPathAdmission(request) {
							controllerCalls.push("request-open-admission");
							const targetToken = targetTokenByPath.get(request.targetPath) ?? null;
							return Promise.resolve(
								request.presentation === "target-proven" && targetToken
									? { kind: "existing", targetReadyToken: targetToken }
									: { kind: "deferred", reason: "transitioning" },
							);
						},
						seedMissingTarget() {
							throw new Error("existing B must not enter the missing-target seed lane");
						},
						isAuthorityFreshnessCurrent(_handleId, context) {
							controllerCalls.push("check-bind-freshness");
							bindFreshnessChecks += 1;
							if (failFirstBindFreshness && bindFreshnessChecks === 1) return false;
							const targetToken = targetTokenByPath.get(context.targetFile.path) ?? null;
							return context.targetFile === targetForPath(context.targetFile.path).file
								&& context.hostLoadReceiptId === targetToken?.hostLoadReceiptId;
						},
						consumeBindPermit(_permitId, context) {
							controllerCalls.push("consume-bind");
							const target = targetForPath(context.targetFile.path);
							return context.targetFile === target.file && context.ytext === target.ytext;
						},
					};
					const vaultSync = {
						provider: { awareness },
						getTextForPath: (path) => path === pathA ? ytextA : path === pathB ? ytextB : path === pathC && contentC !== null ? ytextC : null,
						getFileId: (path) => path === pathA ? "file-A" : path === pathB ? "file-B" : path === pathC && contentC !== null ? "file-C" : undefined,
						getFileIdForText: (text) => text === ytextA ? "file-A" : text === ytextB ? "file-B" : text === ytextC && contentC !== null ? "file-C" : undefined,
						isPendingRenameTarget: () => false,
						isMarkdownTombstoned: () => false,
					};
					const manager = new EditorBindingManager(
						vaultSync,
						false,
						(path) => path.endsWith(".md"),
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						controller,
						undefined,
						undefined,
						undefined,
						undefined,
						(token) => {
							presentationReadyNotifications.push({
								path: token.targetPath,
								bindingPath: manager.getBinding(view)?.path ?? null,
								presentation:
									manager.getManagedSession(view)?.handoff?.presentation
										?? null,
							});
						},
					);
					const parent = document.createElement("div");
					document.body.appendChild(parent);
					let cm;
					let hostData = contentA;
					let originalSaveCalls = 0;
					const leaf = {
						id: "task9-browser-leaf",
						workspace: {
							activeLeaf: null,
							iterateAllLeaves(callback) { callback({ view }); },
						},
					};
					const requestSave = Object.assign(function requestSave() {
						originalSaveCalls += 1;
					}, { cancel() {} });
					const view = {
						file: fileA,
						leaf,
						containerEl: parent,
						editor: { getValue: () => cm.state.doc.toString() },
						data: hostData,
						dirty: false,
						lastSavedData: hostData,
						getViewData: () => hostData,
						onUnloadFile: async function onUnloadFile(_file) {
							await this.save(true);
						},
						onLoadFile: async function onLoadFile(targetFile) {
							hostLoadDispatchActive = true;
							try {
								this.setViewData(targetFile === fileC ? contentC : contentB, true);
							} finally {
								hostLoadDispatchActive = false;
							}
							await Promise.resolve();
						},
						setViewData: function setViewData(data, _clear) {
							hostData = data;
							this.data = data;
							this.lastSavedData = data;
							cm.dispatch({
								changes: { from: 0, to: cm.state.doc.length, insert: data },
								selection: { anchor: data.length },
								annotations: Transaction.addToHistory.of(false),
							});
						},
						requestSave,
						save: async function save(clear) {
							originalSaveCalls += 1;
							this.dirty = false;
							if (clear === true) {
								hostData = "";
								this.data = "";
								this.lastSavedData = null;
							}
							await Promise.resolve();
						},
					};
					leaf.workspace.activeLeaf = leaf;
					cm = new EditorView({
						parent,
						state: EditorState.create({ doc: contentA, extensions: [manager.getBaseExtension()] }),
					});
					let sourceUndoDestroyed = 0;
					const sourceUndo = new Y.UndoManager(ytextA);
					const originalDestroy = sourceUndo.destroy.bind(sourceUndo);
					sourceUndo.destroy = () => { sourceUndoDestroyed += 1; originalDestroy(); };
					manager.bindings.set(leaf.id, {
						view,
						file: fileA,
						path: pathA,
						undoManager: sourceUndo,
						ytext: ytextA,
						cm,
						cmId: "task9-source-cm",
						fileId: "file-A",
						lastBoundAt: new Date().toISOString(),
						lastBoundAtMs: Date.now() - 10_000,
						lastEditorChangeAtMs: Date.now() - 10_000,
						lastEditorDocChangeAtMs: null,
						settleWindowMs: 0,
					});
					manager.bind(view, "Browser");
					await view.onUnloadFile(fileA);
					view.file = fileB;
					const loadPromises = [view.onLoadFile(fileB)];
					for (let index = 0; index < 40 && !releasePresentationByPath.has(pathB); index += 1) {
						await new Promise((resolve) => requestAnimationFrame(() => resolve()));
					}
					let finalPath = pathB;
					let finalContent = contentB;
					let finalYText = ytextB;
					if (contentC !== null) {
						await loadPromises[0];
						await view.onUnloadFile(fileB);
						view.file = fileC;
						loadPromises.push(view.onLoadFile(fileC));
						finalPath = pathC;
						finalContent = contentC;
						finalYText = ytextC;
						for (let index = 0; index < 40 && !releasePresentationByPath.has(pathC); index += 1) {
							await new Promise((resolve) => requestAnimationFrame(() => resolve()));
						}
					}
					view.requestSave();
					const beforeReceipt = {
						cmContent: cm.state.doc.toString(),
						bindingDetached: manager.getBinding(view) === null,
						gateInstalled: manager.getManagedSession(view)?.handoff?.inputGateInstalled === true,
						originalSaveCalls,
						activityTransferred: manager.getLastEditorActivityForPath(finalPath) !== null,
						releaseReady: releasePresentationByPath.has(finalPath),
					};
					releasePresentationByPath.get(finalPath)?.();
					await Promise.all(loadPromises);
					for (let index = 0; index < 30 && manager.getBinding(view)?.path !== finalPath; index += 1) {
						await new Promise((resolve) => requestAnimationFrame(() => resolve()));
						await Promise.resolve();
					}
					const targetBinding = manager.getBinding(view);
					const beforeUndo = finalYText.toString();
						targetBinding?.undoManager.undo();
						await Promise.resolve();
						view.requestSave();
						await view.requestSave.flush();
						const result = {
						beforeReceipt,
						cmContent: cm.state.doc.toString(),
						yContent: finalYText.toString(),
						boundPath: targetBinding?.path ?? null,
						sourceUndoDestroyed,
						targetLoadUndoable: finalYText.toString() !== beforeUndo,
						originalSaveCalls,
						controllerCalls,
						presentationRequestedInsideHostLoad,
						presentationReadyNotifications,
						handoffCleared: manager.getManagedSession(view)?.handoff === null,
						finalContent,
					};
					manager.unbindAll();
					cm.destroy();
					doc.destroy();
					return result;
					};
					return {
						different: await runScenario({
							suffix: "different",
							contentA: "source A",
							contentB: "target B",
						}),
						identical: await runScenario({
							suffix: "identical",
							contentA: "same bytes",
							contentB: "same bytes",
						}),
						retried: await runScenario({
							suffix: "retried",
							contentA: "source before stale bind proof",
							contentB: "target after fresh bind proof",
							failFirstBindFreshness: true,
						}),
						presentationRetried: await runScenario({
							suffix: "presentation-retried",
							contentA: "source before deferred presentation",
							contentB: "target after fresh presentation proof",
							deferFirstPresentation: true,
						}),
						completionRetried: await runScenario({
							suffix: "completion-retried",
							contentA: "source before completion replan",
							contentB: "target after completion reproof",
							replanFirstCompletion: true,
						}),
						superseded: await runScenario({
							suffix: "superseded",
							contentA: "source before supersession",
							contentB: "stale target B",
							contentC: "current target C",
						}),
					};
				})();
	`;
	const childScript = `
		import { build } from "esbuild";
		import { chromium } from "playwright";
		const repoRoot = ${JSON.stringify(repoRoot)};
		const obsidianMockPath = ${JSON.stringify(obsidianMockPath)};
		const browserEntry = ${JSON.stringify(browserEntry)};
		const browserBundle = await build({
			stdin: { resolveDir: repoRoot, loader: "ts", contents: browserEntry },
			bundle: true,
			format: "iife",
			platform: "browser",
			target: "chrome120",
			write: false,
			plugins: [{
				name: "task6-obsidian-mock",
				setup(esbuild) {
					esbuild.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianMockPath }));
				},
			}],
		});
		let browser = null;
		for (const options of [{}, { channel: "chrome" }]) {
			try {
				browser = await chromium.launch({ ...options, headless: true });
				break;
			} catch {}
		}
		if (!browser) throw new Error("No supported Chromium could launch");
		try {
			const page = await browser.newPage();
			await page.setContent("<!doctype html><html><body></body></html>");
			await page.addScriptTag({ content: browserBundle.outputFiles[0]?.text ?? "" });
			const result = await page.evaluate(async () => ({
				task6: await window.__TASK6_STALE_DISPATCH__,
				task9: await window.__TASK9_GUARDED_PRESENTATION__,
			}));
			console.log("TASK6_RESULT=" + JSON.stringify(result.task6));
			console.log("TASK9_RESULT=" + JSON.stringify(result.task9));
		} finally {
			await browser.close();
		}
	`;
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", childScript],
		{ cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
	);
	if (child.status !== 0) {
		console.error(child.stderr || child.error?.message || "browser subprocess failed without stderr");
	}
	assertEq(child.status, 0, "real guard browser subprocess completes");
	if (child.status === 0) {
		const resultLine = child.stdout.split("\n").find((line) => line.startsWith("TASK6_RESULT="));
		const result = JSON.parse(resultLine?.slice("TASK6_RESULT=".length) ?? "null") as {
			initiallyBound: boolean;
			cmContent: string;
			yContent: string;
			bindingDetached: boolean;
			lineagePath: string | null;
			admissionCount: number;
		};
		assertEq(result.initiallyBound, true, "real guard fixture starts with A bound");
		assertEq(result.cmContent, "source", "stale user dispatch never reaches CodeMirror");
		assertEq(result.yContent, "source", "stale user dispatch never reaches Y.Text");
		assertEq(result.bindingDetached, true, "stale user dispatch leaves the binding detached");
		assertEq(result.lineagePath, "Notes/browser-A.md", "stale user dispatch preserves A lineage");
		assertEq(result.admissionCount, 1, "stale user dispatch requests B admission exactly once");

		const task9Line = child.stdout.split("\n").find((line) => line.startsWith("TASK9_RESULT="));
		type Task9ScenarioResult = {
			beforeReceipt: {
				cmContent: string;
				bindingDetached: boolean;
				gateInstalled: boolean;
				originalSaveCalls: number;
				activityTransferred: boolean;
				releaseReady: boolean;
			};
			cmContent: string;
			yContent: string;
			boundPath: string | null;
			sourceUndoDestroyed: number;
			targetLoadUndoable: boolean;
			originalSaveCalls: number;
			controllerCalls: string[];
			presentationRequestedInsideHostLoad: boolean;
			presentationReadyNotifications: Array<{
				path: string;
				bindingPath: string | null;
				presentation: string | null;
			}>;
			handoffCleared: boolean;
			finalContent: string;
		};
		const task9Scenarios = JSON.parse(
			task9Line?.slice("TASK9_RESULT=".length) ?? "null",
		) as {
			different: Task9ScenarioResult;
			identical: Task9ScenarioResult;
			retried: Task9ScenarioResult;
			presentationRetried: Task9ScenarioResult;
			completionRetried: Task9ScenarioResult;
			superseded: Task9ScenarioResult;
		};
		const task9 = task9Scenarios.different;
		assertEq(task9.beforeReceipt.releaseReady, true, "target presentation proof is requested for held B");
		assertEq(
			task9.presentationReadyNotifications.length,
			1,
			"target presentation readiness is published exactly once",
		);
		assertEq(
			task9.presentationReadyNotifications[0]?.path,
			"Notes/task9-browser-different-B.md",
			"presentation readiness carries the exact B path",
		);
		assertEq(
			task9.presentationReadyNotifications[0]?.bindingPath,
			null,
			"presentation readiness is published before target binding",
		);
		assertEq(
			task9.presentationReadyNotifications[0]?.presentation,
			"target-proven",
			"presentation readiness is published only after reducer proof",
		);
		assertEq(
			task9.presentationRequestedInsideHostLoad,
			false,
			"target presentation admission starts only after the exact host load dispatch returns",
		);
		assertEq(task9.beforeReceipt.cmContent, "source A", "B does not enter CodeMirror before proof");
		assertEq(task9.beforeReceipt.bindingDetached, true, "B remains unbound before proof");
		assertEq(task9.beforeReceipt.gateInstalled, true, "input gate remains installed before proof");
		assertEq(
			task9.beforeReceipt.originalSaveCalls,
			1,
			"only the forced source-retirement save runs before proof",
		);
		assertEq(task9.beforeReceipt.activityTransferred, false, "A activity is not relabelled B before proof");
		assertEq(task9.cmContent, "target B", "certified B host transaction is presented exactly once");
		assertEq(task9.yContent, "target B", "B Y.Text remains authoritative after binding");
		assertEq(task9.boundPath, "Notes/task9-browser-different-B.md", "replacement token binds exact B path");
		assertEq(task9.sourceUndoDestroyed, 1, "A Y.UndoManager is destroyed exactly once");
		assertEq(task9.targetLoadUndoable, false, "B host load is absent from the new Y undo history");
		assertEq(
			task9.originalSaveCalls,
			2,
			"ordinary save pass-through resumes only after target proof",
		);
		assertEq(task9.handoffCleared, true, "successful bind returns the managed leaf to stable state");
		assertEq(task9.controllerCalls.join("|"), [
			"request-presentation",
			"consume-presentation",
			"complete-presentation",
			"request-open-admission",
			"check-bind-freshness",
			"consume-bind",
		].join("|"), "presentation and bind permits are consumed in order");
		const identical = task9Scenarios.identical;
		assertEq(identical.beforeReceipt.cmContent, "same bytes", "equal A/B bytes still wait for identity proof");
		assertEq(identical.beforeReceipt.bindingDetached, true, "equal bytes cannot retain A's binding as B");
		assertEq(identical.boundPath, "Notes/task9-browser-identical-B.md", "equal bytes bind only the exact B token");
		assertEq(identical.handoffCleared, true, "equal-byte handoff also returns to stable state");
		assertEq(identical.controllerCalls.join("|"), task9.controllerCalls.join("|"), "equal bytes use the same one-shot permit sequence");
		const retried = task9Scenarios.retried;
		assertEq(
			retried.boundPath,
			"Notes/task9-browser-retried-B.md",
			"a stale final freshness check schedules a fresh target admission and eventually binds B",
		);
		assertEq(
			retried.controllerCalls.filter((call) => call === "request-open-admission").length,
			2,
			"stale final freshness performs exactly one fresh admission retry",
		);
		assertEq(
			retried.controllerCalls.filter((call) => call === "check-bind-freshness").length,
			2,
			"the retry rechecks freshness instead of reusing the stale decision",
		);
		assertEq(
			retried.controllerCalls.filter((call) => call === "consume-bind").length,
			1,
			"only the fresh retry consumes the one-shot bind permit",
		);
		assertEq(retried.handoffCleared, true, "successful retry closes the managed handoff");
		const presentationRetried = task9Scenarios.presentationRetried;
		assertEq(
			presentationRetried.boundPath,
			"Notes/task9-browser-presentation-retried-B.md",
			"a deferred target presentation schedules a fresh proof and eventually binds B",
		);
		assertEq(
			presentationRetried.controllerCalls.filter((call) => call === "request-presentation").length,
			2,
			"deferred presentation is retried with one fresh controller request",
		);
		assertEq(
			presentationRetried.controllerCalls.filter((call) => call === "consume-presentation").length,
			1,
			"only the fresh presentation plan consumes a one-shot permit",
		);
		assertEq(presentationRetried.handoffCleared, true, "presentation retry closes the handoff");
		const completionRetried = task9Scenarios.completionRetried;
		assertEq(
			completionRetried.boundPath,
			"Notes/task9-browser-completion-retried-B.md",
			"a transient completion replan retries the same host receipt and eventually binds B",
		);
		assertEq(
			completionRetried.controllerCalls.filter((call) => call === "consume-presentation").length,
			1,
			"completion retry never consumes a second presentation permit",
		);
		assertEq(
			completionRetried.controllerCalls.filter((call) => call === "complete-presentation").length,
			2,
			"completion retry revalidates the same completed host mutation",
		);
		assertEq(completionRetried.handoffCleared, true, "completion retry closes the handoff");
		const superseded = task9Scenarios.superseded;
		assertEq(superseded.beforeReceipt.cmContent, "source before supersession", "stale B never enters CM before C proof");
		assertEq(superseded.cmContent, "current target C", "only the current C host load is presented");
		assertEq(superseded.yContent, "current target C", "only C Y.Text becomes bound authority");
		assertEq(superseded.boundPath, "Notes/task9-browser-superseded-C.md", "B presentation cannot bind across C supersession");
		assertEq(superseded.sourceUndoDestroyed, 1, "A authority detaches once across B-to-C supersession");
		assertEq(
			superseded.beforeReceipt.originalSaveCalls,
			1,
			"only proven source A is saved while unproven B rolls its exact held receipt",
		);
		assertEq(superseded.handoffCleared, true, "C binding closes the superseded handoff");
		assertEq(
			superseded.controllerCalls.filter((call) => call === "request-presentation").length,
			2,
			"B and C each request proof without sharing a permit",
		);
		assertEq(
			superseded.controllerCalls.filter((call) => call === "consume-presentation").length,
			1,
			"only C consumes a presentation permit",
		);
	}
}

console.log("\n--- Test 33: replacement TFile makes cache rollback continuation fail closed ---");
{
	const externalContent = "external bytes with a replacement TFile";
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent(externalContent);
	(binding.view as unknown as { file: unknown }).file = {
		path: binding.path,
		stat: binding.file.stat,
	};
	let dispatches = 0;
	(binding.cm as unknown as { dispatch: (spec: TransactionSpec) => void }).dispatch = () => {
		dispatches += 1;
	};
	const runtime = manager as unknown as {
		deferExternalReloadFilterBypassRollback: (
			cm: unknown,
			bypass: {
				path: string;
				leafId: string;
				bindingEpoch: number;
				beforeContent: string;
				externalContent: string;
			},
		) => void;
	};
	const callback = captureSingleMicrotask(() => {
		runtime.deferExternalReloadFilterBypassRollback(binding.cm, {
			path: binding.path,
			leafId: "leaf-1",
			bindingEpoch: 0,
			beforeContent: "typing now",
			externalContent,
		});
	});
	callback();

	assertEq(dispatches, 0, "replacement TFile authorizes zero CM/cache mutation");
	assertEq(binding.ytext.toString(), "server text", "replacement TFile leaves Y.Text unchanged");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 34: A-to-B-to-C stale retries cannot consume C timer slots ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => unknown;
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		scheduleCmResolveRetry: (view: unknown, deviceName: string, leafId: string, source: string) => void;
		scheduleHealthCheck: (leafId: string, delayMs: number, source: string) => void;
		pendingCmResolveRetries: Map<string, unknown>;
		pendingHealthChecks: Map<string, unknown>;
		maybeHealBinding: (...args: unknown[]) => void;
	};
	const mutableView = binding.view as unknown as { file: unknown };
	const fileB = { path: "Notes/retry-B.md" };
	const fileC = { path: "Notes/retry-C.md" };
	runtime.manageView(binding.view);
	mutableView.file = fileB;
	runtime.beginPathHandoff(binding.view, fileB, "retry-B");
	runtime.scheduleCmResolveRetry(binding.view, "TestDevice", "leaf-1", "retry-B");
	const staleCmTimer = runtime.pendingCmResolveRetries.get("leaf-1");
	const runStaleCmTimer = staleCmTimer ? captureNodeTimerCallback(staleCmTimer) : null;
	assertEq(staleCmTimer !== undefined, true, "B CM retry callback is scheduled");
	if (staleCmTimer) {
		clearTimeout(staleCmTimer as ReturnType<typeof setTimeout>);
		runtime.pendingCmResolveRetries.delete("leaf-1");
	}

	mutableView.file = fileC;
	runtime.beginPathHandoff(binding.view, fileC, "retry-C");
	runtime.scheduleCmResolveRetry(binding.view, "TestDevice", "leaf-1", "retry-C");
	const currentCmTimer = runtime.pendingCmResolveRetries.get("leaf-1");
	let bindCalls = 0;
	(manager as unknown as { bind: (...args: unknown[]) => void }).bind = () => {
		bindCalls += 1;
	};
	runStaleCmTimer?.();
	assertEq(bindCalls, 0, "stale B CM retry performs no C bind mutation");
	assertEq(
		runtime.pendingCmResolveRetries.get("leaf-1"),
		currentCmTimer,
		"stale B CM retry cannot delete C's timer slot",
	);

	if (currentCmTimer) {
		clearTimeout(currentCmTimer as ReturnType<typeof setTimeout>);
		runtime.pendingCmResolveRetries.delete("leaf-1");
	}
	mutableView.file = fileB;
	runtime.beginPathHandoff(binding.view, fileB, "health-B");
	runtime.scheduleHealthCheck("leaf-1", 60_000, "health-B");
	const staleHealthTimer = runtime.pendingHealthChecks.get("leaf-1");
	const runStaleHealthTimer = staleHealthTimer ? captureNodeTimerCallback(staleHealthTimer) : null;
	assertEq(staleHealthTimer !== undefined, true, "B health callback is scheduled");
	if (staleHealthTimer) {
		clearTimeout(staleHealthTimer as ReturnType<typeof setTimeout>);
		runtime.pendingHealthChecks.delete("leaf-1");
	}
	mutableView.file = fileC;
	runtime.beginPathHandoff(binding.view, fileC, "health-C");
	runtime.scheduleHealthCheck("leaf-1", 60_000, "health-C");
	const currentHealthTimer = runtime.pendingHealthChecks.get("leaf-1");
	let healCalls = 0;
	runtime.maybeHealBinding = () => { healCalls += 1; };
	runStaleHealthTimer?.();
	assertEq(healCalls, 0, "stale B health callback performs no C repair mutation");
	assertEq(
		runtime.pendingHealthChecks.get("leaf-1"),
		currentHealthTimer,
		"stale B health callback cannot delete C's timer slot",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 35: A-to-B-to-C invalidates the provider shield continuation ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => unknown;
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		pendingYTextPatches: WeakMap<Y.Text, unknown>;
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
		applyEditorAuthorityAfterShield: (...args: unknown[]) => void;
	};
	runtime.manageView(binding.view);
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "provider-boundary-C2");
	runtime.pendingYTextPatches.set(binding.ytext, {
		origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
		path: binding.path,
		leafId: "leaf-1",
		at: Date.now(),
	});
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "provider-boundary-C2" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	let applyCalls = 0;
	runtime.applyEditorAuthorityAfterShield = () => { applyCalls += 1; };
	const callback = captureSingleMicrotask(() => {
		runtime.filterRiskyNonUserPatch(transaction);
	});

	// A provider successor and two target selections land before the old shield
	// continuation. The old callback must not enter any leaf mutation routine.
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "provider-C3");
	const mutableView = binding.view as unknown as { file: unknown };
	const fileB = { path: "Notes/shield-B.md" };
	const fileC = { path: "Notes/shield-C.md" };
	mutableView.file = fileB;
	runtime.beginPathHandoff(binding.view, fileB, "shield-B");
	mutableView.file = fileC;
	runtime.beginPathHandoff(binding.view, fileC, "shield-C");
	callback();

	assertEq(applyCalls, 0, "stale shield callback never enters editor/Y.Text apply code");
	assertEq(binding.ytext.toString(), "provider-C3", "stale shield leaves provider authority unchanged");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 36: delayed cache rollback is generation scoped across A-to-B-to-C ---");
{
	const externalContent = "external A cache";
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => unknown;
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		deferExternalReloadFilterBypassRollback: (cm: unknown, bypass: {
			path: string;
			leafId: string;
			bindingEpoch: number;
			beforeContent: string;
			externalContent: string;
		}) => void;
		bindingEpochByLeafId: Map<string, number>;
	};
	runtime.manageView(binding.view);
	setLiveEditorContent(externalContent);
	let dispatches = 0;
	(binding.cm as unknown as { dispatch: (spec: TransactionSpec) => void }).dispatch = () => {
		dispatches += 1;
	};
	const callback = captureSingleMicrotask(() => {
		runtime.deferExternalReloadFilterBypassRollback(binding.cm, {
			path: binding.path,
			leafId: "leaf-1",
			bindingEpoch: runtime.bindingEpochByLeafId.get("leaf-1") ?? 0,
			beforeContent: "typing now",
			externalContent,
		});
	});
	const mutableView = binding.view as unknown as { file: unknown };
	const fileB = { path: "Notes/cache-B.md" };
	const fileC = { path: "Notes/cache-C.md" };
	mutableView.file = fileB;
	runtime.beginPathHandoff(binding.view, fileB, "cache-B");
	mutableView.file = fileC;
	runtime.beginPathHandoff(binding.view, fileC, "cache-C");
	const dispatchesBeforeStaleCallback = dispatches;
	callback();

	assertEq(
		dispatches,
		dispatchesBeforeStaleCallback,
		"stale A cache rollback performs no C CM mutation",
	);
	assertEq(binding.ytext.toString(), "server text", "stale cache rollback performs no Y.Text mutation");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 37: open-editor tickets validate every captured identity and authority value ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => unknown;
		viewIds: WeakMap<object, string>;
		cmIds: WeakMap<object, string>;
		editorAuthorityRevisionByCm: WeakMap<object, number>;
		editorAuthorityContentByCm: WeakMap<object, string>;
	};
	runtime.manageView(binding.view);
	const capture = () => manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
	let ticket = capture();
	assertEq(
		manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]).current,
		true,
		"baseline exact ticket is current",
	);
	runtime.viewIds.set(binding.view, `${ticket.views[0]!.viewId}-replacement`);
	let validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(validation.current ? null : validation.reason, "view-id-changed", "viewId value is validated");

	ticket = capture();
	runtime.cmIds.set(binding.cm, `${ticket.views[0]!.cmId}-replacement`);
	validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(validation.current ? null : validation.reason, "cm-id-changed", "cmId value is validated");

	ticket = capture();
	runtime.editorAuthorityRevisionByCm.set(
		binding.cm,
		ticket.views[0]!.editorAuthorityRevision + 1,
	);
	validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(
		validation.current ? null : validation.reason,
		"editor-authority-revision-changed",
		"editor authority revision is validated",
	);

	ticket = capture();
	runtime.editorAuthorityContentByCm.set(binding.cm, "different editor authority bytes");
	validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(
		validation.current ? null : validation.reason,
		"editor-authority-content-changed",
		"editor authority content is validated",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 38: workspace orchestration manages before bind and keeps layout validation-only ---");
{
	const calls: string[] = [];
	const view = Object.assign(new MarkdownView(), {
		file: { path: "Notes/orchestrator.md" },
		leaf: { id: "orchestrator-leaf" },
		editor: { getValue: () => "" },
	});
	const leaf = { view };
	const fileContextSideView = Object.assign(new MarkdownView(), {
		file: view.file,
		leaf: { id: "orchestrator-outline-leaf" },
		getViewType: () => "outline",
	});
	let exposeActiveLeafThroughIteration = true;
	const bindings = {
		manageView: () => { calls.push("manage"); },
		excludeView: () => { calls.push("exclude"); },
		getBindingDebugInfoForView: () => null,
		getBindingHealthForView: () => ({ bound: false, healthy: false, settling: false, issues: [] }),
		bind: () => { calls.push("bind"); },
		auditBindings: () => { calls.push("audit"); return 0; },
		reconcileManagedWorkspaceViews: (views: readonly unknown[], reason: string) => {
			calls.push(`reconcile:${reason}:${views.length}`);
			return 0;
		},
		clearLocalCursor: () => {},
	};
	const workspace = {
		activeLeaf: leaf,
		iterateAllLeaves: (callback: (candidate: typeof leaf) => void) => {
			if (exposeActiveLeafThroughIteration) callback(leaf);
			callback({ view: fileContextSideView } as typeof leaf);
		},
		getActiveViewOfType: () => view,
	};
	const orchestrator = new EditorWorkspaceOrchestrator({
		app: { workspace } as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getEditorBindings: () => bindings as never,
		getDiskMirror: () => null,
		isMarkdownPathSyncable: (path: string) => path.endsWith(".md"),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});

	orchestrator.validateOpenBindings("behavioral-order");
	assertEq(calls.indexOf("manage") < calls.indexOf("bind"), true, "validation manages the view before bind");
	assertEq(
		calls.filter((call) => call === "manage").length,
		1,
		"file-context sidebar views are never managed as Markdown editors",
	);
	assertEq(
		calls.filter((call) => call === "bind").length,
		1,
		"file-context sidebar views never enter editor binding",
	);
	calls.length = 0;
	orchestrator.onLayoutChange();
	assertEq(calls.includes("bind"), false, "layout-change remains a validation/audit wake-up only");
	assertEq(calls.includes("audit"), true, "layout-change performs its health audit");
	assertEq(
		calls.includes("reconcile:layout-change:1"),
		true,
		"layout-change reconciles exact workspace view ownership",
	);
	exposeActiveLeafThroughIteration = false;
	calls.length = 0;
	orchestrator.onLayoutChange();
	assertEq(
		calls.includes("reconcile:layout-change:1"),
		true,
		"active leaf identity survives a transient iterateAllLeaves omission",
	);
	exposeActiveLeafThroughIteration = true;
	calls.length = 0;
	orchestrator.onActiveLeafChange(leaf as never);
	assertEq(calls.indexOf("manage") < calls.indexOf("bind"), true, "active-leaf binding manages before bind");
}

console.log("\n--- Test 38a: exact workspace view removal revokes managed ownership ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const reconcile = (manager as unknown as {
		reconcileManagedWorkspaceViews?: (
			views: readonly unknown[],
			reason: string,
		) => number;
	}).reconcileManagedWorkspaceViews;
	assertEq(typeof reconcile, "function", "manager exposes exact workspace-view reconciliation");
	if (reconcile) {
		assertEq(
			reconcile.call(manager, [binding.view], "retained-test"),
			0,
			"the exact live workspace view retains managed ownership",
		);
		assertEq(
			reconcile.call(manager, [], "closed-test"),
			1,
			"a view absent by exact identity is revoked once",
		);
		assertEq(
			manager.getManagedSession(binding.view as never),
			null,
			"closed workspace view leaves no managed session",
		);
		assertEq(manager.getBinding(binding.view as never), null, "closed view leaves no binding");
	}
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 39: exact TFile rename translates managed lineage without opening a handoff ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		manageView: (view: unknown) => { generation: number };
		vaultSync: {
			getTextForPath: (path: string) => Y.Text | null;
			getFileId: (path: string) => string | undefined;
			getFileIdForText: (text: Y.Text) => string | undefined;
		};
		recordYTextPatch: (ytext: Y.Text, path: string, leafId: string, transaction: Y.Transaction) => void;
		pendingYTextPatches: WeakMap<Y.Text, { path: string }>;
	};
	const oldPath = binding.path;
	const renamedPath = "Notes/typing-renamed.md";
	const before = runtime.manageView(binding.view);
	(binding.file as unknown as { path: string }).path = renamedPath;
	manager.bind(binding.view as never, "TestDevice");
	const transientSession = manager.getManagedSession(binding.view as never);
	assertEq(binding.path, oldPath, "generic bind cannot translate an in-place rename before batch proof");
	assertEq(
		transientSession?.displayedLineage.kind === "known"
			? transientSession.displayedLineage.path
			: null,
		oldPath,
		"transient in-place rename retains source displayed lineage",
	);
	assertEq(
		(runtime as unknown as { getCodeMirrorHandoffContext: (leafId: string) => unknown })
			.getCodeMirrorHandoffContext("leaf-1"),
		null,
		"stable CodeMirror context closes until rename proof translates the path",
	);
	runtime.vaultSync.getTextForPath = (path) => path === renamedPath ? binding.ytext : null;
	runtime.vaultSync.getFileId = (path) => path === renamedPath ? binding.fileId : undefined;
	runtime.vaultSync.getFileIdForText = (text) => text === binding.ytext ? binding.fileId : undefined;
	manager.updatePathsAfterRename(new Map([[oldPath, renamedPath]]));
	const session = manager.getManagedSession(binding.view as never);

	assertEq(binding.path, renamedPath, "exact rename updates binding metadata");
	assertEq(session?.generation, before.generation + 1, "exact rename advances managed generation once");
	assertEq(session?.handoff, null, "exact rename does not create or retain a handoff");
	assertEq(
		session?.displayedLineage.kind === "known" ? session.displayedLineage.path : null,
		renamedPath,
		"exact rename translates displayed lineage path",
	);
	assertEq(
		session?.binding.kind === "bound" ? session.binding.path : null,
		renamedPath,
		"exact rename translates managed binding path",
	);
	assertEq(
		session?.displayedLineage.kind === "known" ? session.displayedLineage.file : null,
		binding.file,
		"exact rename preserves the exact TFile identity",
	);
	assertEq(
		manager.capturePathEditorAuthority(renamedPath).kind,
		"proven-single",
		"exact rename remains eligible for path authority",
	);

	// The y-codemirror observer was installed under oldPath. A provider patch
	// after the exact rename must resolve the current proven binding path.
	runtime.recordYTextPatch(
		binding.ytext,
		oldPath,
		"leaf-1",
		{ origin: { provider: true } } as Y.Transaction,
	);
	assertEq(
		runtime.pendingYTextPatches.get(binding.ytext)?.path,
		renamedPath,
		"provider provenance follows the exact renamed path",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 40: uncertain rename identity remains quarantined ---");
{
	const admissions: Array<{
		targetFile: unknown;
		targetPath: string;
		handoffGeneration: number;
	}> = [];
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		onOpenPathAdmissionRequested: (request) => admissions.push(request as never),
	});
	const oldPath = binding.path;
	const renamedPath = "Notes/typing-uncertain.md";
	manager.manageView(binding.view as never);
	const replacementFile = { path: renamedPath };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	let undoDestroyCalls = 0;
	const originalDestroy = binding.undoManager.destroy.bind(binding.undoManager);
	(binding.undoManager as unknown as { destroy: () => void }).destroy = () => {
		undoDestroyCalls += 1;
		originalDestroy();
	};
	let oldYTextMutations = 0;
	const observeOldYText = () => { oldYTextMutations += 1; };
	binding.ytext.observe(observeOldYText);
	manager.updatePathsAfterRename(new Map([[oldPath, renamedPath]]));
	binding.ytext.unobserve(observeOldYText);
	const session = manager.getManagedSession(binding.view as never);

	assertEq(manager.getBinding(binding.view as never), null, "uncertain rename detaches old yCollab binding");
	assertEq(undoDestroyCalls, 1, "uncertain rename destroys the old UndoManager exactly once");
	assertEq(oldYTextMutations, 0, "uncertain rename performs no old-Y.Text mutation");
	assertEq(
		session?.displayedLineage.kind === "known" ? session.displayedLineage.path : null,
		oldPath,
		"unproven TFile replacement does not translate displayed lineage",
	);
	assertEq(session?.handoff?.targetFile, replacementFile, "uncertain rename retains exact target TFile");
	assertEq(session?.handoff?.targetPath, renamedPath, "uncertain rename waits on target admission");
	assertEq(admissions.length, 1, "uncertain rename requests one target admission");
	assertEq(admissions[0]?.targetFile, replacementFile, "rename admission carries exact replacement TFile");
	assertEq(
		manager.capturePathEditorAuthority(renamedPath).kind,
		"blocked",
		"uncertain rename keeps the path authority gate closed",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 41: public A-to-B-to-C wakes supersede the detached B generation ---");
{
	const admissions: Array<{
		targetFile: unknown;
		targetPath: string;
		handoffGeneration: number;
		switchIntentSeq: number | null;
	}> = [];
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		onOpenPathAdmissionRequested: (request) => admissions.push(request as never),
	});
	manager.manageView(binding.view as never);
	let undoDestroyCalls = 0;
	const originalDestroy = binding.undoManager.destroy.bind(binding.undoManager);
	(binding.undoManager as unknown as { destroy: () => void }).destroy = () => {
		undoDestroyCalls += 1;
		originalDestroy();
	};
	const fileB = { path: "Notes/public-B.md" };
	const fileC = { path: "Notes/public-C.md" };
	(binding.view as unknown as { file: unknown }).file = fileB;
	manager.bind(binding.view as never, "TestDevice");
	const generationB = manager.getManagedSession(binding.view as never)?.generation ?? -1;
	(binding.view as unknown as { file: unknown }).file = fileC;
	manager.bind(binding.view as never, "TestDevice");
	const current = manager.getManagedSession(binding.view as never);

	assertEq(manager.getBinding(binding.view as never), null, "first public wake detaches A binding");
	assertEq(undoDestroyCalls, 1, "A UndoManager is destroyed once across B-to-C supersession");
	assertEq(admissions.length, 2, "B and C each request one exact admission wake");
	assertEq(admissions[0]?.targetFile, fileB, "first wake carries exact B TFile");
	assertEq(admissions[0]?.handoffGeneration, generationB, "B wake carries the B generation");
	assertEq(admissions[1]?.targetFile, fileC, "second wake carries exact C TFile");
	assertEq(
		admissions[1]?.handoffGeneration,
		current?.generation,
		"C wake carries only the current C generation",
	);
	assertEq(
		(admissions[1]?.handoffGeneration ?? -1) > generationB,
		true,
		"C never reuses the detached B generation",
	);
	assertEq(current?.handoff?.targetFile, fileC, "managed handoff retains only C target identity");
	assertEq(
		current?.displayedLineage.kind === "known" ? current.displayedLineage.file : null,
		binding.file,
		"B-to-C supersession retains source A displayed lineage",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 42: initial no-CM session waits for target presentation after CM resolves ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	manager.unbindAll();
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.delete(binding.cm);
	const initial = manager.manageView(binding.view as never);
	assertEq(initial.displayedLineage.kind, "unknown", "initial unresolved session starts unknown");
	(manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews.add(binding.cm);
	installManagedBoundaryStubs(manager, binding.view, binding.cm);
	manager.bind(binding.view as never, "TestDevice");
	const settled = manager.getManagedSession(binding.view as never);

	assertEq(manager.getBinding(binding.view as never), null, "CM resolution alone never attaches target Y.Text");
	assertEq(settled?.displayedLineage.kind, "unknown", "resolved CM remains unknown before presentation");
	assertEq(settled?.binding.kind, "unbound", "initial session remains unbound before presentation");
	assertEq(settled?.handoff?.targetFile, binding.view.file, "resolved target waits in a closed handoff");
	manager.unbindAll();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 42a: exact stable presentation opens the initial null-context gate ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	manager.unbindAll();
	Object.assign(binding.view, {
		getViewData: () => binding.view.editor.getValue(),
	});
	const initial = manager.manageView(binding.view as never);
	assertEq(initial.displayedLineage.kind, "unknown", "late-managed initial session starts unknown");
	const runtime = (manager as unknown as {
		managedSessions: Map<string, {
			session: unknown;
			hostGuard: unknown;
			cmGuard: unknown;
		}>;
		admitStableInitialSamePathPresentation(
			runtime: unknown,
			cm: unknown,
		): void;
	}).managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected late-managed runtime");
	const hostMethod = () => {};
	runtime.hostGuard = {
		markInert: () => true,
		restoreIfCurrent: () => true,
		snapshot: () => ({
			leafId: "leaf-1",
			view: binding.view,
			originalRequestSave: hostMethod,
			originalSave: hostMethod,
			installedRequestSave: hostMethod,
			installedSave: hostMethod,
			hostCapability: "owned-scheduler-with-unload-flush",
			hostCapabilityState: "ready",
			saveEpoch: 0,
			clearLoadCapability: "observable",
			mode: { kind: "pass-through" },
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
		}),
	};
	let gateClosed = true;
	let refreshCalls = 0;
	runtime.cmGuard = {
		refreshGate: () => {
			refreshCalls += 1;
			gateClosed = false;
			return true;
		},
		markInert: () => true,
		restoreIfCurrent: () => true,
		snapshot: () => ({
			view: binding.cm,
			inert: false,
			gateClosed,
			inputEpoch: 0,
			compositionEpoch: 0,
			nativeHistoryEpoch: 0,
			selectionEpoch: 0,
			scrollEpoch: 0,
			activeComposition: null,
			lastComposition: null,
			gateFailureReason: null,
			commitState: "none",
			pendingHostLoadCandidate: null,
		}),
	};
	(manager as unknown as {
		admitStableInitialSamePathPresentation(
			runtime: unknown,
			cm: unknown,
		): void;
	}).admitStableInitialSamePathPresentation(runtime, binding.cm);
	const admitted = manager.getManagedSession(binding.view as never);

	assertEq(
		admitted?.displayedLineage.kind,
		"known",
		"exact host/editor/CM proof publishes initial same-path lineage",
	);
	assertEq(refreshCalls, 1, "initial same-path admission refreshes the CM gate once");
	assertEq(gateClosed, false, "same-path admission leaves normal editing unrestricted");
	assertEq(admitted?.handoff, null, "initial same-path admission fabricates no handoff receipt");
	manager.unbindAll();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 43: same-path TFile replacement fences user, provider, and health lanes ---");
{
	const admissions: unknown[] = [];
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		onOpenPathAdmissionRequested: (request) => admissions.push(request),
	});
	manager.manageView(binding.view as never);
	const replacementFile = { path: binding.path, stat: binding.file.stat };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	const health = (manager as unknown as {
		inspectBindingHealth: (view: unknown, candidate: unknown) => { issues: string[] };
	}).inspectBindingHealth(binding.view, binding);
	assertEq(
		health.issues.includes("file-identity-changed"),
		true,
		"health audit reports same-path TFile replacement",
	);
	let oldYTextMutations = 0;
	const observeOld = () => { oldYTextMutations += 1; };
	binding.ytext.observe(observeOld);
	const userFence = (manager as unknown as {
		fenceStaleUserBinding: (transaction: unknown) => unknown;
	}).fenceStaleUserBinding({
		docChanged: true,
		startState: binding.cm.state,
		annotation: () => "input.type",
		isUserEvent: (event: string) => event === "input",
	});
	binding.ytext.unobserve(observeOld);
	const userSession = manager.getManagedSession(binding.view as never);
	assertEq(userFence !== null, true, "user extender removes old yCollab on same-path replacement");
	assertEq(manager.getBinding(binding.view as never), null, "user lane detaches old binding");
	assertEq(oldYTextMutations, 0, "user lane performs no old-Y.Text mutation");
	assertEq(userSession?.handoff?.targetFile, replacementFile, "user handoff targets exact replacement TFile");
	const handoffContext = (manager as unknown as {
		getCodeMirrorHandoffContext: (leafId: string) => {
			kind?: string;
			targetFile?: unknown;
		} | null;
	}).getCodeMirrorHandoffContext("leaf-1");
	assertEq(handoffContext?.kind, "handoff", "Task4 final context enters the closed handoff lane");
	assertEq(handoffContext?.targetFile, replacementFile, "Task4 handoff context carries exact replacement TFile");
	assertEq(admissions.length, 1, "same-path replacement waits for controller admission");
	clearPendingHealthChecks(manager);
}
{
	const admissions: unknown[] = [];
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		onOpenPathAdmissionRequested: (request) => admissions.push(request),
	});
	manager.manageView(binding.view as never);
	const replacementFile = { path: binding.path, stat: binding.file.stat };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	const providerResult = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch({
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => "provider must not cross file identity" },
		annotation: () => undefined,
		isUserEvent: () => false,
	});
	assertEq(Array.isArray(providerResult), true, "provider patch is cancelled before old yCollab projection");
	assertEq((providerResult as unknown[]).length, 0, "provider cancellation has no doc change");
	assertEq(manager.getBinding(binding.view as never), null, "provider lane detaches old binding");
	assertEq(binding.ytext.toString(), "server text", "provider lane leaves old Y.Text unchanged");
	assertEq(admissions.length, 1, "provider replacement requests exact admission once");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 44: old external-host snapshot cannot restore a replacement TFile cache ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	Object.assign(binding.view, { data: "typing now", lastSavedData: "saved" });
	manager.beginExternalDiskMutation(binding.path, 4401);
	const internals = manager as unknown as {
		pendingExternalDiskMutationStarts: Map<string, {
			path: string;
			sequence: number;
			views: Map<string, unknown>;
		}>;
		restoreExternalDiskHostViewCache: (
			proof: unknown,
			currentText: string,
			incomingText: string,
			sequence: number,
			retire: boolean,
		) => boolean;
	};
	const start = internals.pendingExternalDiskMutationStarts.get(binding.path);
	const snapshot = start?.views.get("leaf-1");
	assertEq(snapshot !== undefined, true, "external host lane captures exact source TFile snapshot");
	const replacementFile = { path: binding.path, stat: binding.file.stat };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	Object.assign(binding.view, { data: "incoming replacement cache", lastSavedData: "external" });
	const restored = start && snapshot
		? internals.restoreExternalDiskHostViewCache({
			start,
			snapshot,
			runtimeView: binding.view,
			externalLogicalContent: "external",
		}, "typing now", "incoming replacement cache", 4401, false)
		: true;
	assertEq(restored, false, "old snapshot fails exact replacement-TFile CAS");
	assertEq(
		(binding.view as unknown as { data: string }).data,
		"incoming replacement cache",
		"stale snapshot performs no TextFileView cache assignment",
	);
	assertEq(binding.ytext.toString(), "server text", "stale snapshot performs no Y.Text mutation");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 45: applyBinding never publishes across awareness, dispatch, or host-read reentry ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	const liveCm = installLiveCmReplacement(manager, binding);
	let liveDispatches = 0;
	(liveCm as { dispatch: () => void }).dispatch = () => { liveDispatches += 1; };
	const fileC = { path: "Notes/awareness-C.md" };
	const runtime = manager as unknown as {
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		vaultSync: { provider: { awareness: { setLocalStateField: () => void } } };
		applyBinding: (options: unknown) => boolean;
	};
	runtime.vaultSync.provider.awareness.setLocalStateField = () => {
		(binding.view as unknown as { file: unknown }).file = fileC;
		runtime.beginPathHandoff(binding.view, fileC, "awareness-reentry-C");
	};
	const applied = runtime.applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-reentry-awareness",
		leafId: "leaf-1",
		file: binding.file,
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "awareness-reentry",
	});
	assertEq(applied, false, "awareness reentry invalidates binding publication");
	assertEq(liveDispatches, 0, "stale awareness lease reaches no target CM dispatch");
	assertEq(manager.getBinding(binding.view as never), null, "awareness reentry leaves old binding detached");
	assertEq(binding.ytext.toString(), "server text", "awareness reentry mutates no Y.Text");
	clearPendingHealthChecks(manager);
}
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	const liveCm = installLiveCmReplacement(manager, binding);
	const runtime = manager as unknown as {
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		vaultSync: {
			provider: {
				awareness: { setLocalStateField: (field: string, value: unknown) => void };
			};
		};
		applyBinding: (options: unknown) => boolean;
	};
	const fileC = { path: "Notes/publication-awareness-C.md" };
	runtime.vaultSync.provider.awareness.setLocalStateField = (field) => {
		if (field !== KAOS_ACTIVE_FILE_AWARENESS_FIELD) return;
		(binding.view as unknown as { file: unknown }).file = fileC;
		runtime.beginPathHandoff(binding.view, fileC, "publication-awareness-C");
	};
	const applied = runtime.applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-publication-awareness",
		leafId: "leaf-1",
		file: binding.file,
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "publication-awareness-reentry",
	});
	assertEq(applied, false, "post-publication awareness reentry invalidates the outer apply");
	assertEq(manager.getBinding(binding.view as never), null, "publication callback cannot retain stale binding");
	assertEq(
		manager.getManagedSession(binding.view as never)?.handoff?.targetFile,
		fileC,
		"publication callback leaves only the superseding C handoff",
	);
	assertEq(binding.ytext.toString(), "server text", "publication callback mutates no Y.Text");
	clearPendingHealthChecks(manager);
}
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	const liveCm = installLiveCmReplacement(manager, binding);
	let dispatches = 0;
	(liveCm as { dispatch: () => void }).dispatch = () => {
		dispatches += 1;
		if (dispatches !== 1) return;
		binding.ytext.doc?.transact(() => {
			binding.ytext.delete(0, binding.ytext.length);
			binding.ytext.insert(0, "provider successor during dispatch");
		}, { provider: "dispatch-reentry" });
	};
	const applied = (manager as unknown as { applyBinding: (options: unknown) => boolean })
		.applyBinding({
			action: "repair",
			deviceName: "TestDevice",
			view: binding.view,
			cm: liveCm,
			cmId: "cm-reentry-provider",
			leafId: "leaf-1",
			file: binding.file,
			filePath: binding.path,
			ytext: binding.ytext,
			fileId: binding.fileId,
			existing: binding,
			reason: "dispatch-provider-reentry",
		});
	assertEq(applied, false, "dispatch-time provider successor invalidates exact-content CAS");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.get("leaf-1"),
		binding,
		"dispatch-time successor never publishes the attempted CM binding",
	);
	assertEq(
		binding.ytext.toString(),
		"provider successor during dispatch",
		"dispatch-time provider authority is preserved",
	);
	assertEq(dispatches, 2, "failed publication removes the attempted collab extension once");
	clearPendingHealthChecks(manager);
}
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	const liveCm = installLiveCmReplacement(manager, binding);
	const runtime = manager as unknown as {
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		applyBinding: (options: unknown) => boolean;
	};
	let dispatched = false;
	(liveCm as { dispatch: () => void }).dispatch = () => { dispatched = true; };
	const fileC = { path: "Notes/host-read-C.md" };
	let reentered = false;
	(binding.view.editor as unknown as { getValue: () => string }).getValue = () => {
		if (dispatched && !reentered) {
			reentered = true;
			(binding.view as unknown as { file: unknown }).file = fileC;
			runtime.beginPathHandoff(binding.view, fileC, "post-dispatch-host-read-C");
		}
		return "server text";
	};
	const applied = runtime.applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-reentry-host-read",
		leafId: "leaf-1",
		file: binding.file,
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "post-dispatch-host-read-reentry",
	});
	assertEq(reentered, true, "post-dispatch host read exercises synchronous reentry");
	assertEq(applied, false, "final central continuation CAS rejects host-read reentry");
	assertEq(manager.getBinding(binding.view as never), null, "host-read reentry publishes no stale binding");
	assertEq(binding.ytext.toString(), "server text", "host-read reentry mutates no Y.Text");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 46: ticket and continuation final CAS reject callback reentry and mutable paths ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
	};
	manager.manageView(binding.view as never);
	const ticket = manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
	const fileC = { path: "Notes/ticket-final-C.md" };
	let reads = 0;
	let reentered = false;
	(binding.view.editor as unknown as { getValue: () => string }).getValue = () => {
		reads += 1;
		if (reads === 2 && !reentered) {
			reentered = true;
			(binding.view as unknown as { file: unknown }).file = fileC;
			runtime.beginPathHandoff(binding.view, fileC, "ticket-final-read-C");
		}
		return "typing now";
	};
	const validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);
	assertEq(reentered, true, "ticket's final editor read reenters the handoff state machine");
	assertEq(validation.current, false, "ticket final CAS rejects the reentered generation");
	clearPendingHealthChecks(manager);
}
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const runtime = manager as unknown as {
		captureManagedContinuation: (view: unknown) => unknown;
		isManagedContinuationCurrent: (ticket: unknown) => boolean;
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
	};
	manager.manageView(binding.view as never);
	const continuation = runtime.captureManagedContinuation(binding.view);
	const fileC = { path: "Notes/continuation-final-C.md" };
	let reentered = false;
	(binding.view.editor as unknown as { getValue: () => string }).getValue = () => {
		if (!reentered) {
			reentered = true;
			(binding.view as unknown as { file: unknown }).file = fileC;
			runtime.beginPathHandoff(binding.view, fileC, "continuation-host-read-C");
		}
		return "typing now";
	};
	assertEq(
		runtime.isManagedContinuationCurrent(continuation),
		false,
		"central continuation callback ends with a read-free stale CAS",
	);
	clearPendingHealthChecks(manager);
}
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const ticket = manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
	(binding.file as unknown as { path: string }).path = "Notes/mutable-ticket-path.md";
	assertEq(
		manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]).current,
		false,
		"mutable displayed TFile path cannot preserve an old ticket",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 47: excluded and tombstoned targets cancel all handoff authority safely ---");
for (const targetKind of ["excluded", "tombstoned"] as const) {
	const { manager, binding, traceRecords } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	let underlyingDispatches = 0;
	(binding.cm as unknown as { dispatch: (spec: TransactionSpec) => void }).dispatch = () => {
		underlyingDispatches += 1;
	};
	manager.manageView(binding.view as never);
	const internals = manager as unknown as {
		managedSessions: Map<string, {
			cmGuard: { snapshot: () => { inert: boolean; gateClosed: boolean } } | null;
		}>;
		pendingAdmissionByLeafId: Map<string, unknown>;
		vaultSync: {
			getTextForPath: (path: string) => Y.Text | null;
			isMarkdownTombstoned: (path: string) => boolean;
			isPendingRenameTarget: (path: string) => boolean;
		};
	};
	const managedRuntime = internals.managedSessions.get("leaf-1");
	let guardInert = false;
	let guardGateClosed = false;
	const guard = {
		refreshGate: () => {
			guardGateClosed = !guardInert;
			return true;
		},
		markInert: () => {
			guardInert = true;
			guardGateClosed = false;
			return true;
		},
		restoreIfCurrent: () => {
			guardInert = true;
			guardGateClosed = false;
			return true;
		},
		snapshot: () => ({
			view: binding.cm,
			inert: guardInert,
			gateClosed: guardGateClosed,
		}),
	};
	if (managedRuntime) managedRuntime.cmGuard = guard;
	let undoDestroyCalls = 0;
	const originalDestroy = binding.undoManager.destroy.bind(binding.undoManager);
	(binding.undoManager as unknown as { destroy: () => void }).destroy = () => {
		undoDestroyCalls += 1;
		originalDestroy();
	};
	const targetFile = {
		path: targetKind === "excluded" ? "Notes/not-synced.txt" : "Notes/deleted.md",
	};
	if (targetKind === "tombstoned") {
		internals.vaultSync.getTextForPath = (path) => path === binding.path ? binding.ytext : null;
		internals.vaultSync.isMarkdownTombstoned = (path) => path === targetFile.path;
		internals.vaultSync.isPendingRenameTarget = () => false;
	}
	(binding.view as unknown as { file: unknown }).file = targetFile;
	manager.bind(binding.view as never, "TestDevice");

	const initialEffects = traceRecords
		.filter((record) => record.msg === "handoff-effect-applied" && record.details?.reason === "bind")
		.map((record) => record.details?.effect);
	assertEq(initialEffects.length, 5, `${targetKind}: target selection applies five ordered effects`);
	assertEq(initialEffects[0], "cancel-pending-save", `${targetKind}: pending save cancels first`);
	assertEq(initialEffects[4], "detach-binding", `${targetKind}: binding detaches after authority capture`);
	assertEq(undoDestroyCalls, 1, `${targetKind}: old UndoManager is destroyed once`);
	assertEq(manager.getBinding(binding.view as never), null, `${targetKind}: old binding is absent`);
	assertEq(manager.getManagedSession(binding.view as never), null, `${targetKind}: managed handoff is released`);
	assertEq(
		internals.pendingAdmissionByLeafId.has("leaf-1"),
		false,
		`${targetKind}: no admission gate remains retained`,
	);
	assertEq(guard?.snapshot().inert, true, `${targetKind}: CodeMirror guard becomes inert`);
	assertEq(guard?.snapshot().gateClosed, false, `${targetKind}: inert guard leaves no closed input gate`);
	const beforePassThrough = underlyingDispatches;
	(binding.cm as unknown as { dispatch: (spec: TransactionSpec) => void }).dispatch({});
	assertEq(
		underlyingDispatches,
		beforePassThrough + 1,
		`${targetKind}: inert dispatch wrapper is pass-through`,
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 48: failed CodeMirror guard inerting retains its managed owner fail-closed ---");
{
	const { manager, binding, traceRecords } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const internals = manager as unknown as {
		managedSessions: Map<string, {
			cmGuard: unknown;
			hostGuard: unknown;
		}>;
		pendingUnmanageRetries: Map<string, ReturnType<typeof setTimeout>>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected managed runtime for inert failure test");
	let hostInertCalls = 0;
	let hostBlocked = true;
	runtime.cmGuard = {
		markInert: () => false,
		snapshot: () => ({
			gateClosed: true,
			gateFailureReason: "pending-input-not-flushable",
			commitState: "pending",
		}),
	};
	runtime.hostGuard = {
		markInert: () => {
			hostInertCalls += 1;
			hostBlocked = false;
		},
		restoreIfCurrent: () => {
			hostInertCalls += 1;
			hostBlocked = false;
		},
		beginBlockingHandoff: () => { hostBlocked = true; },
	};
	const unmanaged = manager.unmanageView(binding.view as never, "stub-inert-failure");

	assertEq(unmanaged, false, "markInert=false reports deferred invalidation");
	assertEq(
		internals.managedSessions.get("leaf-1"),
		runtime,
		"failed inerting retains the exact managed runtime owner",
	);
	assertEq(hostInertCalls, 0, "failed CM inerting retains host blocking ownership");
	assertEq(hostBlocked, true, "failed CM inerting leaves the host save block in place");
	assertEq(
		traceRecords.some((record) => record.msg === "managed-view-invalidation-deferred"),
		true,
		"failed inerting emits fail-closed recovery trace",
	);
	const retry = internals.pendingUnmanageRetries.get("leaf-1");
	assertEq(retry !== undefined, true, "failed inerting schedules one bounded recovery retry");
	runtime.cmGuard = null;
	manager.unmanageView(binding.view as never, "stub-inert-cleanup");
	assertEq(
		internals.pendingUnmanageRetries.has("leaf-1"),
		false,
		"successful invalidation clears the pending recovery timer",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 49: unmanaged equal-bytes CM never becomes target lineage by observation ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	manager.unmanageView(binding.view as never, "reset-unmanaged-reuse");
	(manager as unknown as { bindings: Map<string, unknown> }).bindings.delete("leaf-1");
	const replacementFile = { path: binding.path, stat: binding.file.stat };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	const session = manager.manageView(binding.view as never);
	installManagedBoundaryStubs(manager, binding.view, binding.cm);
	const authority = manager.capturePathEditorAuthority(binding.path);
	manager.bind(binding.view as never, "TestDevice");

	assertEq(
		session.displayedLineage.kind,
		"unknown",
		"an unbound reused CM stays unknown without target presentation proof",
	);
	assertEq(
		authority.kind === "proven-single",
		false,
		"equal bytes cannot mint target authority for an unmanaged reused CM",
	);
	assertEq(
		manager.getBinding(binding.view as never),
		null,
		"equal bytes cannot attach target Y.Text before presentation proof",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 50: unsupported managed guards fail closed before binding ---");
{
	const { manager, binding, traceRecords } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		installManagedGuardStubs: false,
	});
	manager.manageView(binding.view as never);
	manager.bind(binding.view as never, "TestDevice");

	assertEq(
		manager.getBinding(binding.view as never),
		null,
		"a binding without live host and CodeMirror guards is detached",
	);
	assertEq(
		manager.getManagedSession(binding.view as never),
		null,
		"unsupported guard installation releases the unsafe managed runtime",
	);
	assertEq(
		traceRecords.some((record) => record.msg === "managed-boundary-unsupported"),
		true,
		"unsupported binding eligibility emits a fail-closed trace",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 51: workspace wakeups never fabricate switch-intent provenance ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const observedFile = { path: "Notes/observed-B.md" };
	(binding.view as unknown as { file: unknown }).file = observedFile;
	manager.bind(binding.view as never, "TestDevice");
	const session = manager.getManagedSession(binding.view as never);

	assertEq(session?.handoff?.targetFile, observedFile, "wake observation still closes the B handoff gate");
	assertEq(
		session?.currentSwitchIntentSeq ?? null,
		null,
		"bind wake observation does not claim a guarded host switch intent",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 52: path authority enumerates every real workspace pane ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const secondView = {
		file: binding.file,
		editor: { getValue: () => binding.cm.state.doc.toString() },
	};
	(binding.view as unknown as { app: unknown }).app = {
		workspace: {
			iterateAllLeaves(callback: (leaf: { view: unknown }) => void) {
				callback({ view: binding.view });
				callback({ view: secondView });
			},
		},
	};
	manager.manageView(binding.view as never);
	const authority = manager.capturePathEditorAuthority(binding.path);

	assertEq(authority.kind, "blocked", "an unmanaged second workspace pane blocks single-pane authority");
	assertEq(
		authority.kind === "blocked" ? authority.reason : null,
		"unmanaged-view",
		"the complete workspace pane set reports unmanaged-view",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 52a: file-context sidebar views are not editor authorities ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const fileContextSideView = {
		file: binding.file,
		getViewType: () => "outgoing-link",
	};
	(binding.view as unknown as { app: unknown }).app = {
		workspace: {
			iterateAllLeaves(callback: (leaf: { view: unknown }) => void) {
				callback({ view: binding.view });
				callback({ view: fileContextSideView });
			},
		},
	};
	manager.manageView(binding.view as never);
	const authority = manager.capturePathEditorAuthority(binding.path);

	assertEq(
		authority.kind,
		"proven-single",
		"outgoing-link/outline file context cannot block the exact Markdown editor",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 53: stable same-path replacement cannot certify contradictory ticket identities ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const replacementFile = { path: binding.path, stat: binding.file.stat };
	(binding.view as unknown as { file: unknown }).file = replacementFile;
	const ticket = manager.captureOpenEditorMutationTicket(binding.path, [binding.view as never]);
	const validation = manager.validateOpenEditorMutationTicket(ticket, [binding.view as never]);

	assertEq(validation.current, false, "stable displayed A and target B identities never validate together");
	assertEq(
		validation.current ? null : validation.reason,
		"displayed-lineage-changed",
		"same-path replacement is rejected as contradictory stable lineage",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 54: stale outer cleanup cannot detach a published successor binding ---");
{
	const { manager, binding, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	setLiveEditorContent("server text");
	const liveCm = installLiveCmReplacement(manager, binding);
	(liveCm as { dispatch: () => void }).dispatch = () => {};
	const runtime = manager as unknown as {
		beginPathHandoff: (view: unknown, file: unknown, reason: string) => boolean;
		bindings: Map<string, unknown>;
		vaultSync: {
			provider: {
				awareness: { setLocalStateField: (field: string, value: unknown) => void };
			};
		};
		applyBinding: (options: unknown) => boolean;
	};
	const successorFile = { path: "Notes/published-C.md" };
	const successorDoc = new Y.Doc();
	const successorText = successorDoc.getText("successor");
	successorText.insert(0, "server text");
	let successorUndoDestroyCalls = 0;
	const successorUndo = new Y.UndoManager(successorText);
	const originalSuccessorDestroy = successorUndo.destroy.bind(successorUndo);
	successorUndo.destroy = () => {
		successorUndoDestroyCalls += 1;
		originalSuccessorDestroy();
	};
	const successorBinding = {
		...binding,
		file: successorFile,
		path: successorFile.path,
		ytext: successorText,
		undoManager: successorUndo,
		cm: liveCm,
		cmId: "cm-successor-C",
		fileId: "file-C",
	};
	runtime.vaultSync.provider.awareness.setLocalStateField = (field) => {
		if (field !== KAOS_ACTIVE_FILE_AWARENESS_FIELD) return;
		(binding.view as unknown as { file: unknown }).file = successorFile;
		runtime.beginPathHandoff(binding.view, successorFile, "publish-successor-C");
		runtime.bindings.set("leaf-1", successorBinding);
	};
	const applied = runtime.applyBinding({
		action: "repair",
		deviceName: "TestDevice",
		view: binding.view,
		cm: liveCm,
		cmId: "cm-outer-B",
		leafId: "leaf-1",
		file: binding.file,
		filePath: binding.path,
		ytext: binding.ytext,
		fileId: binding.fileId,
		existing: binding,
		reason: "outer-publication-cleanup",
	});

	assertEq(applied, false, "superseded outer publication rejects itself");
	assertEq(
		runtime.bindings.get("leaf-1"),
		successorBinding,
		"outer cleanup preserves the exact successor binding owner",
	);
	assertEq(successorUndoDestroyCalls, 0, "outer cleanup never destroys successor undo authority");
	if (runtime.bindings.get("leaf-1") === successorBinding) {
		runtime.bindings.delete("leaf-1");
		successorUndo.destroy();
	}
	clearPendingHealthChecks(manager);
	successorDoc.destroy();
}

console.log("\n--- Test 55: deferred guard teardown retries to completion ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const internals = manager as unknown as {
		managedSessions: Map<string, { cmGuard: unknown; hostGuard: unknown }>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected managed runtime for repeated teardown test");
	let markInertCalls = 0;
	let cmRestoreCalls = 0;
	let hostRestoreCalls = 0;
	runtime.cmGuard = {
		markInert: () => {
			markInertCalls += 1;
			return markInertCalls >= 3;
		},
		restoreIfCurrent: () => {
			cmRestoreCalls += 1;
			return true;
		},
		snapshot: () => ({
			view: binding.cm,
			inert: markInertCalls >= 3,
			gateClosed: markInertCalls < 3,
			gateFailureReason: markInertCalls < 3 ? "pending-input-not-flushable" : null,
			commitState: markInertCalls < 3 ? "pending" : "none",
		}),
	};
	runtime.hostGuard = {
		markInert: () => {},
		restoreIfCurrent: () => { hostRestoreCalls += 1; },
	};
	manager.unmanageView(binding.view as never, "repeated-inert");
	await new Promise((resolve) => setTimeout(resolve, 420));

	assertEq(markInertCalls >= 3, true, "deferred teardown retries beyond the first failed callback");
	assertEq(manager.getManagedSession(binding.view as never), null, "eventual gate settlement releases runtime ownership");
	assertEq(cmRestoreCalls, 1, "successful CM teardown restores its owned wrappers once");
	assertEq(hostRestoreCalls, 1, "successful host teardown restores its owned wrappers once");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 56: unload retains unresolved teardown ownership until settlement ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	manager.manageView(binding.view as never);
	const internals = manager as unknown as {
		managedSessions: Map<string, { cmGuard: unknown; hostGuard: unknown }>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected managed runtime for unload teardown test");
	let markInertCalls = 0;
	runtime.cmGuard = {
		markInert: () => {
			markInertCalls += 1;
			return markInertCalls >= 3;
		},
		restoreIfCurrent: () => true,
		snapshot: () => ({
			view: binding.cm,
			inert: markInertCalls >= 3,
			gateClosed: markInertCalls < 3,
			gateFailureReason: markInertCalls < 3 ? "pending-input-not-flushable" : null,
			commitState: markInertCalls < 3 ? "pending" : "none",
		}),
	};
	runtime.hostGuard = {
		markInert: () => {},
		restoreIfCurrent: () => {},
	};
	manager.unbindAll();
	await new Promise((resolve) => setTimeout(resolve, 420));

	assertEq(markInertCalls >= 3, true, "unload does not cancel the owned teardown retry chain");
	assertEq(manager.getManagedSession(binding.view as never), null, "unload cleanup eventually releases the runtime");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 57: settled state host load advances revision exactly once ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const internals = manager as unknown as {
		authorityEpoch: number;
		editorRevisionByCm: WeakMap<object, number>;
		samePathAdoptionTransactionSeqByCm: WeakMap<object, number>;
		advanceSettledHostStateRevision: (candidate: Readonly<{
			applicationKind: "state" | "transaction";
			cm: object;
			editorRevisionBefore: number;
		}>) => boolean;
	};
	const cm = binding.cm as object;
	internals.editorRevisionByCm.set(cm, 4);
	internals.samePathAdoptionTransactionSeqByCm.set(cm, 9);
	const stateCandidate = Object.freeze({
		applicationKind: "state" as const,
		cm,
		editorRevisionBefore: 4,
	});
	const authorityEpochBefore = internals.authorityEpoch;

	assertEq(
		internals.advanceSettledHostStateRevision(stateCandidate),
		true,
		"exact settled state load synthesizes the omitted document revision",
	);
	assertEq(internals.editorRevisionByCm.get(cm), 5, "state load advances editor revision once");
	assertEq(
		internals.samePathAdoptionTransactionSeqByCm.get(cm),
		10,
		"state load advances same-path transaction sequence once",
	);
	assertEq(internals.authorityEpoch, authorityEpochBefore + 1, "state load advances authority epoch once");

	assertEq(
		internals.advanceSettledHostStateRevision(stateCandidate),
		true,
		"already-observed expected revision is idempotently accepted",
	);
	assertEq(internals.editorRevisionByCm.get(cm), 5, "idempotent retry does not double-advance revision");
	assertEq(
		internals.samePathAdoptionTransactionSeqByCm.get(cm),
		10,
		"idempotent retry does not double-advance transaction sequence",
	);
	assertEq(internals.authorityEpoch, authorityEpochBefore + 1, "idempotent retry does not advance authority");

	internals.editorRevisionByCm.set(cm, 7);
	assertEq(
		internals.advanceSettledHostStateRevision(stateCandidate),
		false,
		"unexpected intervening revision fails closed",
	);
	assertEq(internals.editorRevisionByCm.get(cm), 7, "failed-closed drift is never overwritten");
	assertEq(
		internals.samePathAdoptionTransactionSeqByCm.get(cm),
		10,
		"failed-closed drift does not mutate transaction sequence",
	);
	assertEq(internals.authorityEpoch, authorityEpochBefore + 1, "failed-closed drift does not advance authority");

	const transactionCm = {};
	internals.editorRevisionByCm.set(transactionCm, 12);
	internals.samePathAdoptionTransactionSeqByCm.set(transactionCm, 3);
	assertEq(
		internals.advanceSettledHostStateRevision(Object.freeze({
			applicationKind: "transaction",
			cm: transactionCm,
			editorRevisionBefore: 11,
		})),
		true,
		"transaction host load relies on its normal ViewUpdate accounting",
	);
	assertEq(internals.editorRevisionByCm.get(transactionCm), 12, "transaction revision is not synthesized");
	assertEq(
		internals.samePathAdoptionTransactionSeqByCm.get(transactionCm),
		3,
		"transaction sequence is not synthesized",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 58: stable IME receipt certifies only the exact same-CM host pre-clear ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	type TestRuntime = {
		session: ManagedLeafSession;
		cmGuard: {
			snapshot(): Readonly<{
				view: unknown;
				inert: boolean;
				nativeHistoryEpoch: number;
			}>;
		} | null;
		hostGuard: {
			reportHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean;
			snapshot(): Readonly<{ sourceUnload: unknown }>;
		} | null;
	};
	const internals = manager as unknown as {
		managedSessions: Map<string, TestRuntime>;
		editorRevisionByCm: WeakMap<object, number>;
		acceptSamePathInputCompletion(
			runtime: TestRuntime,
			completion: Readonly<{
				reservation: NonNullable<ManagedLeafSession["pendingInputStartReservation"]>;
				cm: object;
				startDocument: object;
				finalDocument: object;
			}>,
		): boolean;
		acceptHostLoadCandidate(candidate: PendingHostLoadCandidate): boolean;
		applyHandoffEffects(
			runtime: TestRuntime,
			effects: readonly Readonly<{ type: string }>[],
			reason: string,
		): void;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected managed runtime for certified pre-clear test");
	const displayedAtStart = runtime.session.displayedLineage;
	if (displayedAtStart.kind !== "known") {
		throw new Error("Expected known source presentation for certified pre-clear test");
	}
	const reserved = reserveManagedLeafInputStart(runtime.session, {
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		inputEpoch: 1,
		compositionEpoch: 1,
	});
	if (!reserved.accepted || reserved.state.pendingInputStartReservation === null) {
		throw new Error("Expected exact IME reservation for certified pre-clear test");
	}
	const reservation = reserved.state.pendingInputStartReservation;
	const finalState = EditorState.create({ doc: "typing now한" });
	const cmState = (binding.cm as unknown as { state: Record<string, unknown> }).state;
	(binding.cm as unknown as { state: Record<string, unknown> }).state = {
		...cmState,
		doc: finalState.doc,
	};
	runtime.session = {
		...reserved.state,
		displayedLineage: {
			...displayedAtStart,
			document: finalState.doc,
			editorRevision: 1,
		},
	};
	internals.editorRevisionByCm.set(binding.cm, 1);
	assertEq(
		internals.acceptSamePathInputCompletion(runtime, {
			reservation,
			cm: binding.cm,
			startDocument: reservation.sourceDocumentAtStart!,
			finalDocument: finalState.doc,
		}),
		true,
		"manager accepts one exact stable same-path IME completion",
	);
	assertEq(
		runtime.session.pendingInputStartReservation,
		null,
		"stable completion consumes the reducer reservation",
	);
	assertEq(
		runtime.session.completedSamePathInput?.finalDocument,
		finalState.doc,
		"stable completion retains exact final source lineage",
	);

	const sourceFile = displayedAtStart.file;
	const targetFile = { path: "Notes/after-ime.md" } as typeof sourceFile;
	const sourceUnloadReceiptId = "source-unload:test-58";
	const selected = reduceManagedLeafSession(runtime.session, {
		type: "target-selected",
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		targetFile,
		switchIntentSeq: runtime.session.eventOrderSeq + 1,
		sourceUnloadReceiptId,
	});
	const detached = reduceManagedLeafSession(selected.state, {
		type: "detach-completed",
		sessionId: selected.state.sessionId,
		expectedGeneration: selected.state.generation,
		bindingEpochAfterDetach: 9,
	});
	assertEq(selected.accepted && detached.accepted, true, "pre-clear fixture reaches detached handoff state");
	runtime.session = detached.state;
	(binding.view as unknown as { file: unknown; data: string }).file = targetFile;
	(binding.view as unknown as { file: unknown; data: string }).data = "stale pre-IME host cache";
	const emptyState = EditorState.create({ doc: "" });
	(binding.cm as unknown as { state: Record<string, unknown> }).state = {
		...(binding.cm as unknown as { state: Record<string, unknown> }).state,
		doc: emptyState.doc,
	};
	let forcedSaveObserved = true;
	let candidateReports = 0;
	const observedNativeHistoryEpoch = runtime.session.nativeHistoryEpoch + 3;
	runtime.cmGuard = {
		snapshot: () => ({
			view: binding.cm,
			inert: false,
			nativeHistoryEpoch: observedNativeHistoryEpoch,
		}),
	};
	runtime.hostGuard = {
		reportHostLoadCandidate: () => {
			candidateReports += 1;
			return true;
		},
		snapshot: () => ({
			sourceUnload: {
				receiptId: sourceUnloadReceiptId,
				file: sourceFile,
				path: sourceFile.path,
				state: "settled",
				forcedSaveObserved,
			},
		}),
	};
	const targetState = EditorState.create({ doc: "target after IME" });
	const candidate: PendingHostLoadCandidate = {
		hostLoadTokenId: "host-load:test-58",
		hostLoadCompletedEpoch: null,
		sourceUnloadReceiptId,
		switchIntentSeq: runtime.session.currentSwitchIntentSeq!,
		sessionId: runtime.session.sessionId,
		leafId: runtime.session.leafId,
		handoffGeneration: runtime.session.generation,
		targetPathAtDispatch: targetFile.path,
		cm: binding.cm as never,
		runtimeView: binding.view as never,
		startDocument: emptyState.doc,
		targetDocument: targetState.doc,
		incomingContent: targetState.doc.toString(),
		applicationKind: "state",
		heldTransaction: null,
		heldState: targetState,
		hostSetViewDataClear: true,
		editorRevisionBefore: 1,
		nativeHistoryEpochBefore: observedNativeHistoryEpoch,
		proposedSelection: targetState.selection,
		proposedScrollAnchor: null,
		effectFingerprint: "state-effect:test-58",
		runtimeViewDataBefore: "stale pre-IME host cache",
		bindingEpoch: 9,
	};
	const appliedEffects: string[] = [];
	internals.applyHandoffEffects = (_runtime, effects, reason) => {
		appliedEffects.push(reason, ...effects.map((effect) => effect.type));
	};
	const exactPreclearState = runtime.session;
	forcedSaveObserved = false;
	assertEq(
		internals.acceptHostLoadCandidate(candidate),
		false,
		"manager rejects a pre-clear without an observed forced source save",
	);
	assertEq(runtime.session, exactPreclearState, "rejected pre-clear retains exact reducer state");
	assertEq(candidateReports, 0, "rejected pre-clear is never associated with the host guard");

	forcedSaveObserved = true;
	assertEq(
		internals.acceptHostLoadCandidate(candidate),
		true,
		"manager admits the exact same-CM pre-clear after independent runtime checks",
	);
	assertEq(candidateReports, 1, "certified pre-clear is associated exactly once");
	assertEq(
		runtime.session.nativeHistoryEpoch,
		observedNativeHistoryEpoch,
		"certified pre-clear adopts the exact monotonic guard history epoch",
	);
	assertEq(
		runtime.session.handoff?.pendingHostLoadCandidate,
		candidate,
		"certified pre-clear retains the exact held target candidate",
	);
	assertEq(runtime.session.completedSamePathInput, null, "certified pre-clear consumes its one-shot completion receipt");
	assertEq(
		appliedEffects.join(","),
		"host-preclear-candidate-held,request-target-presentation",
		"certified pre-clear uses the dedicated effect boundary",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 59: teardown starts pending owned saves before revoking editor authority ---");
{
	const { manager } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	type TeardownHostGuard = {
		flushOwnedSave(): Promise<void>;
		markInert(): void;
		snapshot(): Record<string, unknown>;
	};
	const internals = manager as unknown as {
		asyncAuthorityOpen: boolean;
		managedSessions: Map<string, { hostGuard: TeardownHostGuard | null }>;
		beginOwnedSaveDrainForTeardown?: () => Promise<void>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	const guard = runtime?.hostGuard;
	if (!guard) throw new Error("Expected managed host guard for teardown drain test");
	const originalSnapshot = guard.snapshot.bind(guard);
	guard.snapshot = () => ({
		...originalSnapshot(),
		pendingOwnedSave: {
			jobId: 59,
			sessionId: "test-59",
			generation: 1,
			file: { path: "Notes/typing.md" },
			path: "Notes/typing.md",
			displayedPath: "Notes/typing.md",
			saveEpoch: 1,
		},
	});
	let releaseSave!: () => void;
	const pendingNativeSave = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	const events: string[] = [];
	guard.flushOwnedSave = () => {
		events.push(`flush:${String(internals.asyncAuthorityOpen)}`);
		return pendingNativeSave.then(() => {
			events.push("save-settled");
		});
	};
	guard.markInert = () => {
		events.push("mark-inert");
	};

	assertEq(
		guard.snapshot().pendingOwnedSave !== null,
		true,
		"fixture has one owned save still pending before teardown",
	);
	const beginDrain = internals.beginOwnedSaveDrainForTeardown;
	assertEq(
		typeof beginDrain,
		"function",
		"binding manager exposes a synchronous teardown save-drain entry",
	);
	if (typeof beginDrain === "function") {
		const drain = beginDrain.call(manager);
		assertEq(
			events.join(","),
			"flush:true",
			"pending native save enters while its exact editor authority is still current",
		);
		manager.revokeAsyncAuthority();
		assertEq(
			events.join(","),
			"flush:true,mark-inert",
			"editor authority becomes inert only after the owned save entered",
		);
		let drainSettled = false;
		void drain.then(() => { drainSettled = true; });
		await Promise.resolve();
		assertEq(drainSettled, false, "teardown drain waits for the entered native save");
		releaseSave();
		await drain;
		assertEq(
			events.join(","),
			"flush:true,mark-inert,save-settled",
			"captured native save settles after authority revocation without cancellation",
		);
	}
	clearPendingHealthChecks(manager);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
