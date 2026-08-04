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
	type ManagedLeafInputStartReservation,
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
	(manager as { unmanageRetryAttempts?: Map<string, number> })
		.unmanageRetryAttempts?.clear();

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
	let targetSelectionFence: object | null = null;
	let sourceUnloadDrain: Readonly<{
		ownerId: string;
		reservation: ManagedLeafInputStartReservation;
	}> | null = null;
	let emergencySaveBlocked = false;
	const emergencySaveFence = {
		view,
		refresh: () => emergencySaveBlocked,
		isCurrent: () => emergencySaveBlocked,
		release: () => {
			if (!emergencySaveBlocked) return false;
			emergencySaveBlocked = false;
			return true;
		},
	};
	runtime.hostGuard = {
		beginBlockingHandoff: (input: Record<string, unknown>) => {
			hostMode = { kind: "blocking-handoff", ...input };
		},
		isTargetPresentationReady: () => true,
		markTargetProven: () => true,
		markTargetLocallyPresented: () => true,
		reportHostLoadCandidate: () => true,
		reportHostLoadCompleted: () => true,
		flushOwnedSave: () => Promise.resolve(),
		cancelOwnedSave: () => {},
		cancelTerminalHostLifecycle: () => true,
		acquireEmergencySaveFence: () => {
			emergencySaveBlocked = true;
			return emergencySaveFence;
		},
		markInert: () => { hostMode = { kind: "inert-pass-through" }; },
		restoreIfCurrent: () => { hostMode = { kind: "inert-pass-through" }; },
		snapshot: () => ({
			leafId: view.leaf.id,
			view,
			hostCapability: "public-cancellable",
			hostCapabilityState: "ready",
			saveEpoch: 0,
			pendingLoadEpoch: 0,
			nativeLoadEpoch: 0,
			pendingNativeHostLoadCount: 0,
			nativeHostLoadAmbiguous: false,
			managedClearTombstoneEpoch: 0,
			managedClearTombstoneActive: false,
			clearLoadCapability: "observable",
			wrappersCurrent: true,
			loadWrappersCurrent: true,
			emergencySaveBlocked,
			mode: hostMode,
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
			pendingDeferredLoadAdmission: null,
			pendingSourceUnloadDrain: null,
		}),
	};
	runtime.cmGuard = {
		beginSourceUnloadDrain: (
			ownerId: string,
			reservation: ManagedLeafInputStartReservation,
		) => {
			if (cmInert || gateClosed || sourceUnloadDrain !== null) return false;
			sourceUnloadDrain = { ownerId, reservation };
			return true;
		},
		isSourceUnloadDrainCurrent: (
			ownerId: string,
			reservation: ManagedLeafInputStartReservation,
		) => sourceUnloadDrain?.ownerId === ownerId
			&& sourceUnloadDrain.reservation === reservation,
		prepareTargetSelectionFence: (
			ownerId: string,
			drainedReservation?: ManagedLeafInputStartReservation,
		) => {
			if (drainedReservation !== undefined) {
				if (
					sourceUnloadDrain?.ownerId !== ownerId
					|| sourceUnloadDrain.reservation !== drainedReservation
				) return null;
				sourceUnloadDrain = null;
			} else if (sourceUnloadDrain !== null) {
				return null;
			}
			gateClosed = true;
			targetSelectionFence = { ownerId };
			return targetSelectionFence;
		},
		forceTargetSelectionFenceForTerminal: (ownerId: string) => {
			sourceUnloadDrain = null;
			gateClosed = true;
			targetSelectionFence = { ownerId };
			return targetSelectionFence;
		},
		isTargetSelectionFenceCurrent: (token: object) => targetSelectionFence === token,
		transferTargetSelectionFence: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			gateClosed = true;
			return true;
		},
		releaseTargetSelectionFence: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			gateClosed = false;
			return true;
		},
		releaseTargetSelectionFenceForTeardown: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			gateClosed = false;
			return true;
		},
		refreshGate: () => {
			gateClosed = manager.getManagedSession(view as never)?.handoff !== null;
			return true;
		},
		markInert: () => {
			cmInert = true;
			gateClosed = false;
			return true;
		},
		markDetachedInertForTeardown: () => {
			cmInert = true;
			sourceUnloadDrain = null;
			targetSelectionFence = null;
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
			sourceUnloadDrain,
			targetSelectionFence,
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
	handoffRecoveryActionHost?: unknown;
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
		undefined,
		options.handoffRecoveryActionHost as never,
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
	const { manager, binding, traceRecords } = buildManagerFixture({
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
		true,
		"unprovable stale source binding remains owned behind the terminal editor boundary",
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

	const internals = manager as unknown as {
		bindings: Map<string, { path: string; cm: unknown; settleWindowMs: number }>;
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	};
	const rebound = internals.bindings.get("leaf-1");
	const terminalRuntime = internals.managedSessions.get("leaf-1");
	assertEq(rebound, binding, "unprovable replaced source binding remains owned until pane reopen");
	assertEq(oldDispatches, 0, "terminal classification never reconfigures the unproven old CM");
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
	assertEq(session?.handoff, null, "file-first replacement mints no automatic handoff");
	assertEq(
		terminalRuntime?.transitionInputFence?.state,
		"reopen-required",
		"file-first replacement retains a terminal input fence",
	);
	assertEq(
		terminalRuntime?.transitionInputFence?.targetFile,
		nextFile,
		"terminal input fence retains the exact observed B identity",
	);
	assertEq(
		terminalRuntime?.emergencySaveFence?.isCurrent(),
		true,
		"file-first replacement retains the emergency native-save fence",
	);
	manager.reconcileManagedWorkspaceViews([], "test-29-close");
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
			handoff: unknown;
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
		managedSessions: Map<string, {
			cmGuard: { snapshot(): Readonly<{ gateClosed: boolean }> } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
			transitionInputFence: {
				state: string;
				targetFile: unknown;
				targetPath: string;
			} | null;
			capturedSourceAuthority: { kind: string; reason?: string } | null;
		}>;
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
	let hostMode: { kind: string; [key: string]: unknown } = { kind: "pass-through" };
	let emergencySaveBlocked = false;
	const emergencySaveFence = {
		view,
		refresh: () => emergencySaveBlocked,
		isCurrent: () => emergencySaveBlocked,
		release: () => {
			if (!emergencySaveBlocked) return false;
			emergencySaveBlocked = false;
			return true;
		},
	};
	(managedRuntime as unknown as { hostGuard: unknown }).hostGuard = {
		beginBlockingHandoff: (input: Record<string, unknown>) => {
			hostMode = { kind: "blocking-handoff", ...input };
		},
		isTargetPresentationReady: () => true,
		markTargetProven: () => true,
		markTargetLocallyPresented: () => true,
		reportHostLoadCandidate: () => true,
		reportHostLoadCompleted: () => true,
		flushOwnedSave: () => Promise.resolve(),
		cancelOwnedSave: () => {},
		cancelTerminalHostLifecycle: () => true,
		acquireEmergencySaveFence: () => {
			emergencySaveBlocked = true;
			return emergencySaveFence;
		},
		markInert: () => { hostMode = { kind: "inert-pass-through" }; },
		restoreIfCurrent: () => true,
		snapshot: () => ({
			leafId: leaf.id,
			view,
			hostCapability: "public-cancellable",
			hostCapabilityState: "ready",
			saveEpoch: 0,
			pendingLoadEpoch: 0,
			nativeLoadEpoch: 0,
			pendingNativeHostLoadCount: 0,
			nativeHostLoadAmbiguous: false,
			managedClearTombstoneEpoch: 0,
			managedClearTombstoneActive: false,
			clearLoadCapability: "observable",
			wrappersCurrent: true,
			loadWrappersCurrent: true,
			emergencySaveBlocked,
			mode: hostMode,
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
			pendingDeferredLoadAdmission: null,
			pendingSourceUnloadDrain: null,
			terminalHostLifecycle: null,
		}),
	};
	let cmGuardInert = false;
	let cmGateClosed = false;
	let targetSelectionFence: object | null = null;
	managedRuntime.cmGuard = {
		prepareTargetSelectionFence: (ownerId: string) => {
			cmGateClosed = true;
			targetSelectionFence = { ownerId };
			return targetSelectionFence;
		},
		forceTargetSelectionFenceForTerminal: (ownerId: string) => {
			cmGateClosed = true;
			targetSelectionFence = { ownerId };
			return targetSelectionFence;
		},
		isTargetSelectionFenceCurrent: (token: object) => targetSelectionFence === token,
		transferTargetSelectionFence: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			cmGateClosed = true;
			return true;
		},
		releaseTargetSelectionFence: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			cmGateClosed = false;
			return true;
		},
		releaseTargetSelectionFenceForTeardown: (token: object) => {
			if (targetSelectionFence !== token) return false;
			targetSelectionFence = null;
			cmGateClosed = false;
			return true;
		},
		refreshGate: () => {
			cmGateClosed = true;
			return true;
		},
		markInert: () => {
			cmGuardInert = true;
			cmGateClosed = false;
			return true;
		},
		markDetachedInertForTeardown: () => {
			cmGuardInert = true;
			targetSelectionFence = null;
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
			targetSelectionFence,
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
	assertEq(admissionRequests.length, 0, `${entry}: observed file-first mismatch creates no admission`);
	const request = admissionRequests[0];
	assertEq(request?.targetFile, undefined, `${entry}: no target TFile enters an admission`);
	assertEq(request?.targetPath, undefined, `${entry}: no target path enters an admission`);
	assertEq("content" in (request ?? {}), false, `${entry}: admission carries no editor content`);
	assertEq(runtime.getBinding?.(view) ?? runtime.bindings.get(leaf.id) ?? null, null, `${entry}: binding is detached`);
	const session = runtime.getManagedSession?.(view) ?? null;
	const terminalRuntime = runtime.managedSessions.get(leaf.id);
	assertEq(session?.displayedLineage.kind, "known", `${entry}: displayed lineage remains known`);
	assertEq(session?.displayedLineage.path, sourcePath, `${entry}: displayed lineage remains A`);
	assertEq(session?.displayedLineage.file, sourceFile, `${entry}: displayed lineage keeps exact A TFile`);
	assertEq(session?.handoff, null, `${entry}: observed mismatch mints no automatic handoff`);
	assertEq(effectOrder.length, 0, `${entry}: observed mismatch runs no handoff reducer effects`);
	assertEq(sourceText.toString(), sourceContent, `${entry}: source Y.Text is unchanged`);
	assertEq(cmDocumentMutationCalls, 0, `${entry}: terminal fencing performs no CM document mutation`);
	assertEq(runtime.lastEditorDocChangeAtByPath.has(targetPath), false, `${entry}: A activity is not relabelled B`);
	assertEq(undoDestroyCalls, 1, `${entry}: source UndoManager is destroyed exactly once`);
	assertEq(authorityObservedBeforeDetach, false, `${entry}: terminal path performs no normal authority capture`);
	assertEq(capturedAuthority, null, `${entry}: terminal path never publishes source authority through the normal port`);
	assertEq(terminalRuntime?.capturedSourceAuthority?.kind, "blocked", `${entry}: detached source authority is fail-closed`);
	assertEq(terminalRuntime?.capturedSourceAuthority?.reason, "transitioning", `${entry}: detached source reports a transition`);
	assertEq(terminalRuntime?.transitionInputFence?.state, "reopen-required", `${entry}: terminal input fence is retained`);
	assertEq(terminalRuntime?.transitionInputFence?.targetFile, targetFile, `${entry}: terminal fence keeps exact B identity`);
	assertEq(terminalRuntime?.transitionInputFence?.targetPath, targetPath, `${entry}: terminal fence keeps exact B path`);
	assertEq(terminalRuntime?.cmGuard?.snapshot().gateClosed, true, `${entry}: CM input remains blocked`);
	assertEq(terminalRuntime?.emergencySaveFence?.isCurrent(), true, `${entry}: native saving remains blocked`);
	assertEq(Reflect.get(view.containerEl, "inert"), true, `${entry}: pane container remains inert`);
	manager.reconcileManagedWorkspaceViews([], `test-30-${entry}-close`);
	clearPendingHealthChecks(manager);
	sourceDoc.destroy();
}

console.log("\n--- Test 30: every observed file-first mismatch is terminal without target admission ---");
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
		emergencySaveFence: { isCurrent(): boolean } | null;
		transitionInputFence: {
			state: string;
			targetFile: unknown;
			targetPath: string;
		} | null;
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
	assertEq(
		retained?.session.handoff,
		null,
		"an exact unload receipt cannot mint a handoff without live source/CM proof",
	);
	assertEq(
		retained?.session.currentSwitchIntentSeq,
		null,
		"a rejected selected boundary mints no switch provenance",
	);
	assertEq(
		manager.getBinding(binding.view as never),
		binding,
		"the unprovable source binding remains owned until explicit pane reopen",
	);
	assertEq(
		retained?.transitionInputFence?.state,
		"reopen-required",
		"the rejected selected boundary becomes an explicit reopen terminal",
	);
	assertEq(
		retained?.transitionInputFence?.targetFile,
		targetFile,
		"the terminal fence retains the exact observed target identity",
	);
	assertEq(
		retained?.transitionInputFence?.targetPath,
		targetFile.path,
		"the terminal fence retains the exact observed target path",
	);
	assertEq(retained?.cmGuard?.snapshot().gateClosed, true, "the guarded source CM closes its input gate");
	assertEq(
		retained?.emergencySaveFence?.isCurrent(),
		true,
		"the rejected selected boundary blocks native saves",
	);
	assertEq(
		traceRecords.some((record) => (
			record.msg === "observed-file-mismatch-terminal"
			|| record.msg === "observed-file-mismatch-input-boundary-pending"
			|| record.msg === "managed-target-completion-retained"
		)),
		true,
		"the exact-receipt fallback emits a bounded terminal trace",
	);
	manager.reconcileManagedWorkspaceViews([], "test-30b-close");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 30c: a late exact host selection cannot escape an observed terminal owner ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const internals = manager as unknown as {
		beginPathHandoff: (
			view: unknown,
			targetFile: unknown,
			reason: string,
			provenance?: "observed" | "selected",
			sourceUnloadReceiptId?: string | null,
		) => boolean;
		managedSessions: Map<string, {
			emergencySaveFence: { isCurrent(): boolean } | null;
			transitionInputFence: { state: string; targetFile: unknown } | null;
		}>;
		observedFileMismatchTerminalByRuntime: WeakMap<object, unknown>;
	};
	const targetFile = { path: "Notes/observed-then-selected.md" };
	(binding.view as unknown as { file: unknown }).file = targetFile;
	assertEq(
		internals.beginPathHandoff(binding.view, targetFile, "file-open-observed"),
		false,
		"the public file-open wake rejects automatic handoff",
	);
	const observed = manager.getManagedSession(binding.view as never);
	const terminalRuntime = internals.managedSessions.get("leaf-1");
	assertEq(observed?.handoff, null, "observation alone mints no handoff or unload authority");
	assertEq(observed?.currentSwitchIntentSeq, null, "observation alone mints no switch sequence");
	assertEq(observed?.binding.kind, "bound", "unprovable source binding remains owned behind the terminal fence");
	assertEq(
		terminalRuntime?.transitionInputFence?.state,
		"reopen-required",
		"observation retains a reopen-required input fence",
	);
	assertEq(terminalRuntime?.transitionInputFence?.targetFile, targetFile, "terminal fence keeps exact B identity");
	assertEq(terminalRuntime?.emergencySaveFence?.isCurrent(), true, "terminal owner blocks native saves");
	assertEq(
		terminalRuntime === undefined
			? false
			: internals.observedFileMismatchTerminalByRuntime.has(terminalRuntime),
		true,
		"observation publishes a persistent terminal owner",
	);
	const observedGeneration = observed?.generation ?? -1;

	assertEq(
		internals.beginPathHandoff(
			binding.view,
			targetFile,
			"host-load-entry",
			"selected",
			"source-unload:observed-then-selected",
		),
		false,
		"the late exact host callback is rejected by the terminal owner",
	);
	const selected = manager.getManagedSession(binding.view as never);
	assertEq(selected?.generation, observedGeneration, "late receipt cannot advance terminal generation");
	assertEq(selected?.handoff, null, "late receipt cannot create a handoff");
	assertEq(selected?.currentSwitchIntentSeq, null, "late receipt cannot mint a switch sequence");
	manager.reconcileManagedWorkspaceViews([], "test-30c-close");
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
				import { history, undo, undoDepth } from "@codemirror/commands";
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
					let targetLoadCalls = 0;
					let setViewDataCalls = 0;
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
						onLoadFile: function onLoadFile(_file) { targetLoadCalls += 1; },
						setViewData: function setViewData(data, _clear) {
							setViewDataCalls += 1;
							hostData = data;
							this.data = data;
						},
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
					const rejectedUnload = view.onUnloadFile(fileA);
					void rejectedUnload.catch(() => undefined);
					const sourceUnloadPrefixSaveBlocked =
						manager.managedSessions.get("browser-leaf")?.emergencySaveFence?.isCurrent() === true;
					view.file = fileB;
					cm.dispatch({
						changes: { from: cm.state.doc.length, insert: "!" },
						annotations: Transaction.userEvent.of("input.type"),
					});
					await Promise.resolve();
					const session = manager.getManagedSession(view);
					const runtime = manager.managedSessions.get("browser-leaf");
					const cmSnapshot = runtime?.cmGuard?.snapshot() ?? null;
					const result = {
						initiallyBound,
						cmContent: cm.state.doc.toString(),
						yContent: ytext.toString(),
						bindingDetached: manager.getBinding(view) === null,
						lineagePath: session?.displayedLineage.kind === "known"
							? session.displayedLineage.path
							: null,
						admissionCount: admissions.length,
						handoffActive: session?.handoff !== null,
						gateClosed: cmSnapshot?.gateClosed ?? null,
						containerInert: parent.inert === true,
						transitionState: runtime?.transitionInputFence?.state ?? null,
						transitionTargetPath: runtime?.transitionInputFence?.targetPath ?? null,
						emergencySaveBlocked: runtime?.emergencySaveFence?.isCurrent() === true,
						targetLoadCalls,
						setViewDataCalls,
						sourceUnloadPrefixSaveBlocked,
					};
					manager.reconcileManagedWorkspaceViews([], "browser-observed-terminal-close");
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
						probeTargetFirstBeforePresentationProof = false,
						probePendingHostFailure = false,
						probeDeferredTargetBytes = false,
						probeMissingTarget = false,
						probeSupersededInput = false,
						probeSourceDrainOrdering = false,
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
					let ytextAMutations = 0;
					let ytextBMutations = 0;
					ytextA.observe(() => { ytextAMutations += 1; });
					ytextB.observe(() => { ytextBMutations += 1; });
						const awareness = new Awareness(doc);
						const controllerCalls = [];
						let adoptionRequests = 0;
						let recoveryPersistRequests = 0;
						let missingTargetSeeded = false;
						let releaseMissingPreInputRequest = null;
						const missingTargetSeedContents = [];
						const adoptionRequestPaths = [];
						const adoptionRequestOutcomes = [];
						const adoptionRequestFileIds = [];
						const adoptionRequestHasYText = [];
						const adoptionRequestAuthorityKinds = [];
						const transitionCmDocuments = [];
						const hostSaveSnapshots = [];
						const sourceDrainOrder = [];
						let nativeUnloadCalls = 0;
						let nativeLoadCalls = 0;
						let nativeSaveCalls = 0;
						let forcedSourceSaveCalls = 0;
						let releasePreexistingSave = null;
						const preexistingSaveGate = probeSourceDrainOrdering
							? new Promise((resolve) => { releasePreexistingSave = resolve; })
							: null;
						const samePathProposalByPermit = new Map();
						const consumedSamePathPermits = new Set();
						const targetForPath = (path) => path === pathC && contentC !== null
							? { file: fileC, ytext: ytextC, content: ytextC.toString(), fileId: "file-C", suffix: "C" }
							: { file: fileB, ytext: ytextB, content: ytextB.toString(), fileId: "file-B", suffix: "B" };
					const controller = {
						requestSamePathAdoption(request) {
							controllerCalls.push("request-same-path-adoption");
							adoptionRequestPaths.push(request.path);
							adoptionRequestFileIds.push(request.fileId);
								adoptionRequestHasYText.push(request.ytext !== null);
								adoptionRequestAuthorityKinds.push(request.editorAuthority.kind);
								adoptionRequests += 1;
								if (probeMissingTarget && !missingTargetSeeded) {
									if (adoptionRequests === 1) {
										adoptionRequestOutcomes.push("held-before-input");
										return new Promise((resolve) => {
											releaseMissingPreInputRequest = () => resolve({
												kind: "replan",
												reason: "local-input-advanced",
											});
										});
									}
									if (request.editorAuthority.kind !== "proven-single") {
										adoptionRequestOutcomes.push("seed-authority-blocked");
										return Promise.resolve({ kind: "replan", reason: "authority-blocked" });
									}
									const seedContent = request.editorAuthority.content;
									missingTargetSeedContents.push(seedContent);
									doc.transact(() => {
										if (ytextB.length > 0) ytextB.delete(0, ytextB.length);
										if (seedContent.length > 0) ytextB.insert(0, seedContent);
									}, "task9-missing-target-seed");
									missingTargetSeeded = true;
									adoptionRequestOutcomes.push("seeded-replan");
									return Promise.resolve({ kind: "seeded-replan" });
								}
								if (
									probeTargetFirstBeforePresentationProof
									|| (contentC !== null && request.path === pathB)
							) {
								adoptionRequestOutcomes.push("unresolved");
								return new Promise(() => {});
							}
							const target = targetForPath(request.path);
							const mutationPermit = Object.freeze({
								permitId: "same-path-mutation-" + target.suffix,
								kind: "same-path-adoption-mutation",
							});
							const bindPermit = Object.freeze({
								permitId: "same-path-bind-" + target.suffix,
								kind: "same-path-adoption-bind",
							});
							if (request.editorAuthority.kind !== "proven-single") {
								return Promise.resolve({ kind: "replan", reason: "authority-blocked" });
							}
							const proposal = Object.freeze({
								proposalId: "same-path-proposal-" + target.suffix,
								planId: "same-path-plan-" + target.suffix,
								authorityFreshnessHandleId: "same-path-freshness-" + target.suffix,
								request,
								adoptionId: request.adoptionId,
								path: request.path,
								file: target.file,
								baselineHash: "same-path-baseline-" + target.suffix,
								baselineRevision: 1,
								baselineText: target.content,
								diskFile: target.file,
								diskStat: Object.freeze({ ctime: 1, mtime: 1, size: target.content.length }),
								diskContent: target.content,
								diskContentHash: "same-path-disk-" + target.suffix,
								localText: target.content,
								remoteText: target.content,
								activeAuthority: Object.freeze({
									activeFileIds: Object.freeze([target.fileId]),
									activeSetEpoch: 1,
									fileId: target.fileId,
									ytext: target.ytext,
									ytextIdentity: "same-path-ytext-" + target.suffix,
									ytextMutationEpoch: 0,
									ytextContent: target.content,
								}),
								fileId: target.fileId,
								ytext: target.ytext,
								ytextIdentity: "same-path-ytext-" + target.suffix,
								ytextMutationEpoch: 0,
								providerInstance: null,
								editorAuthorityLease: request.editorAuthority.lease,
								hostCapability: request.hostCapability,
								hostSaveEpoch: request.hostSaveEpoch,
								lifecycleGeneration: 1,
								attentionGeneration: 0,
								syncScopeGeneration: 1,
								plan: Object.freeze({ kind: "already-settled", targetText: target.content }),
								mutationPermit,
								bindPermit,
							});
							samePathProposalByPermit.set(mutationPermit, proposal);
							samePathProposalByPermit.set(bindPermit, proposal);
							adoptionRequestOutcomes.push("planned");
							return Promise.resolve({ kind: "planned", proposal });
						},
						consumeSamePathAdoptionMutationPermit(permit, context) {
							const proposal = samePathProposalByPermit.get(permit);
							if (
								!proposal
								|| consumedSamePathPermits.has(permit)
								|| context.proposal !== proposal
								|| context.request !== proposal.request
								|| !manager.isSamePathAdoptionRequestCurrent(context.request)
							) return false;
							consumedSamePathPermits.add(permit);
							controllerCalls.push("consume-same-path-mutation");
							return true;
						},
						consumeSamePathAdoptionBindPermit(permit, context) {
							const proposal = samePathProposalByPermit.get(permit);
							if (
								!proposal
								|| consumedSamePathPermits.has(permit)
								|| context.proposal !== proposal
								|| context.request !== proposal.request
								|| !manager.isSamePathAdoptionBindContextCurrent(context)
							) return false;
							consumedSamePathPermits.add(permit);
							controllerCalls.push("consume-same-path-bind");
							return true;
						},
						noteSamePathAdoptionBound() {
							controllerCalls.push("note-same-path-bound");
						},
					};
					const vaultSync = {
						provider: { awareness },
							getTextForPath: (path) => path === pathA ? ytextA : path === pathB && (!probeMissingTarget || missingTargetSeeded) ? ytextB : path === pathC && contentC !== null ? ytextC : null,
							getFileId: (path) => path === pathA ? "file-A" : path === pathB && (!probeMissingTarget || missingTargetSeeded) ? "file-B" : path === pathC && contentC !== null ? "file-C" : undefined,
							getFileIdForText: (text) => text === ytextA ? "file-A" : text === ytextB && (!probeMissingTarget || missingTargetSeeded) ? "file-B" : text === ytextC && contentC !== null ? "file-C" : undefined,
						isPendingRenameTarget: () => false,
						isMarkdownTombstoned: () => false,
					};
						const managerTrace = [];
					const manager = new EditorBindingManager(
						vaultSync,
						false,
						(path) => path.endsWith(".md"),
						(_source, message, details) => {
							if (message.startsWith("source-unload-drain")) {
								managerTrace.push({ message, details });
							}
						},
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
							controller,
					);
					const parent = document.createElement("div");
					document.body.appendChild(parent);
					let cm;
					let hostData = contentA;
					let rejectPendingHostLoad = null;
					const pendingHostLoad = probePendingHostFailure
						? new Promise((_resolve, reject) => { rejectPendingHostLoad = reject; })
						: null;
					let releaseTargetBytes = null;
					const targetBytesGate = probeDeferredTargetBytes
						? new Promise((resolve) => { releaseTargetBytes = resolve; })
						: null;
					const leaf = {
						id: "task9-browser-leaf",
						workspace: {
							activeLeaf: null,
							iterateAllLeaves(callback) { callback({ view }); },
						},
					};
					const requestSave = Object.assign(function requestSave() {}, { cancel() {} });
					const view = {
						file: fileA,
						leaf,
						app: {
							workspace: {
								iterateAllLeaves(callback) { callback({ view }); },
							},
						},
						containerEl: parent,
						editor: { getValue: () => cm.state.doc.toString() },
						data: hostData,
						dirty: false,
						lastSavedData: hostData,
						getViewData: () => hostData,
						onUnloadFile: async function onUnloadFile(_file) {
							nativeUnloadCalls += 1;
							sourceDrainOrder.push("native-unload-enter");
							await this.save(true);
						},
						onLoadFile: async function onLoadFile(targetFile) {
							nativeLoadCalls += 1;
							sourceDrainOrder.push("native-load-enter");
							if (targetBytesGate !== null) await targetBytesGate;
							this.setViewData(targetFile === fileC ? contentC : contentB, true);
							if (pendingHostLoad !== null) await pendingHostLoad;
							else await Promise.resolve();
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
								nativeSaveCalls += 1;
								if (probeSourceDrainOrdering && clear !== true && preexistingSaveGate !== null) {
									sourceDrainOrder.push("prior-save-enter");
									await preexistingSaveGate;
									sourceDrainOrder.push("prior-save-settled");
									return;
								}
								this.dirty = false;
								if (clear === true) {
									forcedSourceSaveCalls += 1;
									sourceDrainOrder.push("forced-save-enter");
									hostSaveSnapshots.push({
										path: this.file?.path ?? null,
										content: hostData,
									});
									hostData = "";
								this.data = "";
								this.lastSavedData = null;
							}
							await Promise.resolve();
						},
					};
					const originalOnUnloadFile = view.onUnloadFile;
					const originalOnLoadFile = view.onLoadFile;
					const originalSetViewData = view.setViewData;
					const originalSave = view.save;
					leaf.workspace.activeLeaf = leaf;
					cm = new EditorView({
						parent,
						state: EditorState.create({
							doc: contentA,
							selection: { anchor: contentA.length },
							extensions: [
								history(),
								manager.getBaseExtension(),
									EditorView.updateListener.of((update) => {
										if (update.docChanged) {
											const content = update.state.doc.toString();
											transitionCmDocuments.push(content);
											hostData = content;
											view.data = content;
										}
								}),
							],
						}),
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
					if (probeSourceDrainOrdering) {
						const orderingSnapshot = (stage) => {
							const runtime = manager.managedSessions.get(leaf.id);
							const host = runtime?.hostGuard?.snapshot() ?? null;
							const guard = runtime?.cmGuard?.snapshot() ?? null;
							return {
								stage,
								sourceDrainOrder: [...sourceDrainOrder],
								unloadOutcome: typeof unloadOutcome === "undefined" ? "not-started" : unloadOutcome,
								nativeUnloadCalls,
								nativeSaveCalls,
								forcedSourceSaveCalls,
								managerDrainState: runtime?.sourceUnloadDrain?.state ?? null,
								managerDrainSettled: runtime?.sourceUnloadDrain?.settled ?? null,
								cmDrain: guard?.sourceUnloadDrain !== null,
								targetFence: guard?.targetSelectionFence !== null,
								hostDrain: host?.pendingSourceUnloadDrain ?? null,
								hostInFlight: host?.inFlight?.size ?? null,
								hostSaveEpoch: host?.saveEpoch ?? null,
								managerTrace,
							};
						};
						const awaitOrdering = async (promise, stage) => {
							let timeoutId = null;
							const timeout = new Promise((_resolve, reject) => {
								timeoutId = setTimeout(() => reject(new Error(
									"SOURCE_DRAIN_TIMEOUT:" + JSON.stringify(orderingSnapshot(stage)),
								)), 1000);
							});
							try {
								return await Promise.race([promise, timeout]);
							} finally {
								if (timeoutId !== null) clearTimeout(timeoutId);
							}
						};
						const priorSave = view.save(false);
						await Promise.resolve();
						const activeInput = new InputEvent("beforeinput", {
							bubbles: true,
							cancelable: true,
							inputType: "insertText",
							data: "x",
						});
						cm.contentDOM.dispatchEvent(activeInput);
						let unloadOutcome = "pending";
						const unload = view.onUnloadFile(fileA).then(
							() => { unloadOutcome = "fulfilled"; },
							() => { unloadOutcome = "rejected"; },
						);
						await Promise.resolve();
						const beforeCompletion = {
							unloadOutcome,
							nativeUnloadCalls,
							forcedSourceSaveCalls,
							cmContent: cm.state.doc.toString(),
						};
						const freshInput = new InputEvent("beforeinput", {
							bubbles: true,
							cancelable: true,
							inputType: "insertText",
							data: "y",
						});
						cm.contentDOM.dispatchEvent(freshInput);
						const afterFreshInput = {
							defaultPrevented: freshInput.defaultPrevented,
							cmContent: cm.state.doc.toString(),
							recoveryPersistRequests,
						};
						cm.dispatch(cm.state.update({
							changes: { from: cm.state.doc.length, insert: "x" },
							selection: { anchor: cm.state.doc.length + 1 },
							annotations: Transaction.userEvent.of("input.type"),
							filter: false,
						}));
						sourceDrainOrder.push("input-completed");
						await Promise.resolve();
						await Promise.resolve();
						await Promise.resolve();
						const beforePriorSaveSettlement = {
							unloadOutcome,
							nativeUnloadCalls,
							forcedSourceSaveCalls,
							cmContent: cm.state.doc.toString(),
						};
						if (releasePreexistingSave === null) throw new Error("missing preexisting save release");
						releasePreexistingSave();
						await awaitOrdering(priorSave, "prior-save-settlement");
						await awaitOrdering(unload, "source-unload-settlement");
						const afterUnload = {
							unloadOutcome,
							nativeUnloadCalls,
							forcedSourceSaveCalls,
							nativeSaveCalls,
							hostSaveSnapshots: [...hostSaveSnapshots],
						};
						view.file = fileB;
						await awaitOrdering(view.onLoadFile(fileB), "target-load-settlement");
						for (let index = 0; index < 30 && manager.getBinding(view)?.path !== pathB; index += 1) {
							await new Promise((resolve) => requestAnimationFrame(() => resolve()));
							await Promise.resolve();
						}
						const afterLoad = {
							nativeLoadCalls,
							cmContent: cm.state.doc.toString(),
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
							boundPath: manager.getBinding(view)?.path ?? null,
							recoveryPersistRequests,
						};
						const closingRuntime = manager.managedSessions.get(leaf.id);
						const closingGuard = closingRuntime?.cmGuard ?? null;
						const exactCloseCount = manager.reconcileManagedWorkspaceViews(
							[],
							"task9-source-drain-exact-close",
						);
						const cleanup = {
							exactCloseCount,
							managedRemoved: !manager.managedSessions.has(leaf.id),
							cmInert: closingGuard?.snapshot().inert ?? null,
							targetSelectionFence:
								closingGuard?.snapshot().targetSelectionFence ?? null,
							sourceUnloadDrain:
								closingGuard?.snapshot().sourceUnloadDrain ?? null,
							wrappersRestored: view.onUnloadFile === originalOnUnloadFile
								&& view.onLoadFile === originalOnLoadFile
								&& view.setViewData === originalSetViewData
								&& view.save === originalSave,
						};
						const result = {
							activeInputPrevented: activeInput.defaultPrevented,
							beforeCompletion,
							afterFreshInput,
							beforePriorSaveSettlement,
							afterUnload,
							afterLoad,
							sourceDrainOrder,
							cleanup,
						};
						cm.destroy();
						doc.destroy();
						return result;
					}
					await view.onUnloadFile(fileA);
					view.file = fileB;
					let nextEventTurnReached = false;
					const nextEventTurnTimer = probeTargetFirstBeforePresentationProof
						? setTimeout(() => { nextEventTurnReached = true; }, 0)
						: null;
					const loadPromises = [view.onLoadFile(fileB)];
					if (probeDeferredTargetBytes) {
						await Promise.resolve();
						const runtimeBeforeTarget = manager.managedSessions.get(leaf.id);
						const beforeTarget = {
							cmContent: cm.state.doc.toString(),
							gateClosed: runtimeBeforeTarget?.cmGuard?.snapshot().gateClosed ?? null,
							handoffCleared: manager.getManagedSession(view)?.handoff === null,
						};
						cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
							bubbles: true,
							cancelable: true,
							inputType: "insertText",
							data: "?",
						}));
						cm.dispatch(cm.state.update({
							changes: { from: cm.state.doc.length, insert: "?" },
							selection: { anchor: cm.state.doc.length + 1 },
							annotations: Transaction.userEvent.of("input.type"),
							filter: false,
						}));
						const whileTargetMissing = {
							cmContent: cm.state.doc.toString(),
							recoveryPersistRequests,
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
						};
						if (releaseTargetBytes === null) throw new Error("missing target-byte release");
						releaseTargetBytes();
						await loadPromises[0];
						const runtimeAfterTarget = manager.managedSessions.get(leaf.id);
						const afterTarget = {
							cmContent: cm.state.doc.toString(),
							gateClosed: runtimeAfterTarget?.cmGuard?.snapshot().gateClosed ?? null,
							handoffCleared: manager.getManagedSession(view)?.handoff === null,
						};
						cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
							bubbles: true,
							inputType: "insertText",
							data: "!",
						}));
						cm.dispatch(cm.state.update({
							changes: { from: cm.state.doc.length, insert: "!" },
							selection: { anchor: cm.state.doc.length + 1 },
							annotations: Transaction.userEvent.of("input.type"),
							filter: false,
						}));
						const result = {
							beforeTarget,
							whileTargetMissing,
							afterTarget,
							afterTargetInput: {
								cmContent: cm.state.doc.toString(),
								recoveryPersistRequests,
							},
							transitionCmDocuments,
						};
						manager.unbindAll();
						cm.destroy();
						doc.destroy();
						return result;
					}
					if (probePendingHostFailure) {
						let hostLoadSettled = false;
						const observedHostLoad = loadPromises[0].then(
							() => { hostLoadSettled = true; return "fulfilled"; },
							() => { hostLoadSettled = true; return "rejected"; },
						);
						await Promise.resolve();
						const runtimeBeforeInput = manager.managedSessions.get(leaf.id);
						const beforeInput = {
							hostLoadSettled,
							cmContent: cm.state.doc.toString(),
							viewData: view.data,
							gateClosed: runtimeBeforeInput?.cmGuard?.snapshot().gateClosed ?? null,
							handoffCleared: manager.getManagedSession(view)?.handoff === null,
						};
						cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
							bubbles: true,
							inputType: "insertText",
							data: "!",
						}));
						cm.dispatch(cm.state.update({
							changes: { from: cm.state.doc.length, insert: "!" },
							selection: { anchor: cm.state.doc.length + 1 },
							annotations: Transaction.userEvent.of("input.type"),
							filter: false,
						}));
						const afterInput = {
							cmContent: cm.state.doc.toString(),
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
						};
						if (rejectPendingHostLoad === null) throw new Error("missing pending host reject");
						rejectPendingHostLoad(new Error("late host load failure"));
						const hostOutcome = await observedHostLoad;
						await Promise.resolve();
						const runtimeAfterFailure = manager.managedSessions.get(leaf.id);
						const displayedAfterFailure = runtimeAfterFailure?.session.displayedLineage ?? null;
						const result = {
							beforeInput,
								afterInput,
								afterHostFailure: {
								hostOutcome,
								cmContent: cm.state.doc.toString(),
								gateClosed: runtimeAfterFailure?.cmGuard?.snapshot().gateClosed ?? null,
								displayedContent: displayedAfterFailure?.kind === "known"
									? displayedAfterFailure.document.toString()
									: null,
							},
							transitionCmDocuments,
							recoveryPersistRequests,
						};
						manager.unbindAll();
						cm.destroy();
						doc.destroy();
						return result;
					}
					if (probeTargetFirstBeforePresentationProof) {
						await loadPromises[0];
						const runtime = manager.managedSessions.get(leaf.id);
						const beforeInput = {
							nextEventTurnReached,
							cmContent: cm.state.doc.toString(),
							viewData: view.data,
							gateClosed: runtime?.cmGuard?.snapshot().gateClosed ?? null,
							inputGateInstalled:
								manager.getManagedSession(view)?.handoff?.inputGateInstalled ?? false,
							undoDepth: undoDepth(cm.state),
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
						};
						cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
							bubbles: true,
							inputType: "insertText",
							data: "!",
						}));
						cm.dispatch(cm.state.update({
							changes: { from: cm.state.doc.length, insert: "!" },
							selection: { anchor: cm.state.doc.length + 1 },
							annotations: Transaction.userEvent.of("input.type"),
							filter: false,
						}));
						const afterInput = {
							cmContent: cm.state.doc.toString(),
							undoDepth: undoDepth(cm.state),
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
						};
						for (let index = 0; index < 30; index += 1) {
							const current = manager.managedSessions.get(leaf.id);
							const displayed = current?.session.displayedLineage ?? null;
							if (
								current?.adoption.kind === "planning"
								&& displayed?.kind === "known"
								&& displayed.document.toString() === "local target B!"
							) break;
							await new Promise((resolve) => requestAnimationFrame(() => resolve()));
						}
						const admissionWhileInputVisible = (() => {
							const current = manager.managedSessions.get(leaf.id);
							const displayed = current?.session.displayedLineage ?? null;
							return {
								adoptionKind: current?.adoption.kind ?? null,
								displayedContent:
									displayed?.kind === "known"
										? displayed.document.toString()
										: null,
								requiredPath:
									manager.samePathAdoptionRequiredPathByLeafId.get(leaf.id) ?? null,
								bindingPath: manager.getBinding(view)?.path ?? null,
							};
						})();
						const undoApplied = undo(cm);
						const afterUndo = {
							cmContent: cm.state.doc.toString(),
							undoDepth: undoDepth(cm.state),
							ytextA: ytextA.toString(),
							ytextB: ytextB.toString(),
							ytextAMutations,
							ytextBMutations,
						};
						if (nextEventTurnTimer !== null) clearTimeout(nextEventTurnTimer);
						const result = {
							beforeInput,
							afterInput,
							admissionWhileInputVisible,
							afterUndo,
							undoApplied,
							transitionCmDocuments,
							adoptionRequestPaths,
							adoptionRequestOutcomes,
							recoveryPersistRequests,
						};
						manager.unbindAll();
						cm.destroy();
						doc.destroy();
							return result;
						}
						if (probeMissingTarget) {
							await loadPromises[0];
							for (let index = 0; index < 20 && adoptionRequests === 0; index += 1) {
								await Promise.resolve();
							}
							const firstTargetPresentation = {
								cmContent: cm.state.doc.toString(),
								viewData: view.data,
								gateClosed:
									manager.managedSessions.get(leaf.id)?.cmGuard?.snapshot().gateClosed
										?? null,
								inputGateInstalled:
									manager.getManagedSession(view)?.handoff?.inputGateInstalled ?? false,
								ytextA: ytextA.toString(),
								ytextB: ytextB.toString(),
							};
							cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
								bubbles: true,
								inputType: "insertText",
								data: "!",
							}));
							cm.dispatch(cm.state.update({
								changes: { from: cm.state.doc.length, insert: "!" },
								selection: { anchor: cm.state.doc.length + 1 },
								annotations: Transaction.userEvent.of("input.type"),
								filter: false,
							}));
							cm.contentDOM.dispatchEvent(new InputEvent("input", {
								bubbles: true,
								inputType: "insertText",
								data: "!",
							}));
							const afterInput = {
								cmContent: cm.state.doc.toString(),
								viewData: view.data,
								undoDepth: undoDepth(cm.state),
								ytextA: ytextA.toString(),
								ytextB: ytextB.toString(),
							};
							for (let index = 0; index < 60; index += 1) {
								if (
									missingTargetSeedContents.length > 0
									&& manager.getBinding(view)?.path === pathB
								) break;
								await new Promise((resolve) => requestAnimationFrame(() => resolve()));
								await Promise.resolve();
							}
							if (releaseMissingPreInputRequest === null) {
								throw new Error("missing held pre-input adoption release");
							}
							releaseMissingPreInputRequest();
							await Promise.resolve();
							const targetBinding = manager.getBinding(view);
							const result = {
								firstTargetPresentation,
								afterInput,
								cmContent: cm.state.doc.toString(),
								yContent: ytextB.toString(),
								boundPath: targetBinding?.path ?? null,
								sourceUndoDestroyed,
								controllerCalls,
								adoptionRequestPaths,
								adoptionRequestOutcomes,
								adoptionRequestFileIds,
								adoptionRequestHasYText,
								adoptionRequestAuthorityKinds,
								transitionCmDocuments,
								recoveryPersistRequests,
								handoffCleared: manager.getManagedSession(view)?.handoff === null,
								missingTargetSeedContents,
								ytextBMutations,
							};
							manager.unbindAll();
							cm.destroy();
							doc.destroy();
							return result;
						}
						await loadPromises[0];
					for (let index = 0; index < 20 && adoptionRequests === 0; index += 1) {
						await Promise.resolve();
					}
					const firstTargetPresentation = {
						cmContent: cm.state.doc.toString(),
						viewData: view.data,
						editorRevision:
							manager.editorRevisionByCm.get(cm) ?? 0,
						editorAuthorityRevision:
							manager.editorAuthorityRevisionByCm.get(cm) ?? 0,
						editorAuthorityContent:
							manager.editorAuthorityContentByCm.get(cm) ?? null,
						gateClosed:
							manager.managedSessions.get(leaf.id)?.cmGuard?.snapshot().gateClosed
								?? null,
						inputGateInstalled:
							manager.getManagedSession(view)?.handoff?.inputGateInstalled ?? false,
						ytextA: ytextA.toString(),
						ytextB: ytextB.toString(),
					};
						let inputOnB = null;
						if (probeSupersededInput) {
							cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
								bubbles: true,
								inputType: "insertText",
								data: "!",
							}));
							cm.dispatch(cm.state.update({
								changes: { from: cm.state.doc.length, insert: "!" },
								selection: { anchor: cm.state.doc.length + 1 },
								annotations: Transaction.userEvent.of("input.type"),
								filter: false,
							}));
							cm.contentDOM.dispatchEvent(new InputEvent("input", {
								bubbles: true,
								inputType: "insertText",
								data: "!",
							}));
							inputOnB = {
								cmContent: cm.state.doc.toString(),
								viewData: view.data,
								undoDepth: undoDepth(cm.state),
								ytextA: ytextA.toString(),
								ytextB: ytextB.toString(),
							};
							for (let index = 0; index < 30; index += 1) {
								const current = manager.managedSessions.get(leaf.id);
								const displayed = current?.session.displayedLineage ?? null;
								if (
									adoptionRequestPaths.filter((path) => path === pathB).length >= 2
									&& current?.adoption.kind === "planning"
									&& displayed?.kind === "known"
									&& displayed.document.toString() === "stale target B!"
								) break;
								await new Promise((resolve) => requestAnimationFrame(() => resolve()));
								await Promise.resolve();
							}
						}
						let finalPath = pathB;
					let finalYText = ytextB;
					if (contentC !== null) {
						await view.onUnloadFile(fileB);
						view.file = fileC;
						loadPromises.push(view.onLoadFile(fileC));
						finalPath = pathC;
						finalYText = ytextC;
					}
					await Promise.all(loadPromises);
					for (let index = 0; index < 30 && manager.getBinding(view)?.path !== finalPath; index += 1) {
						await new Promise((resolve) => requestAnimationFrame(() => resolve()));
						await Promise.resolve();
					}
					const targetBinding = manager.getBinding(view);
					const result = {
							firstTargetPresentation,
							inputOnB,
							cmContent: cm.state.doc.toString(),
							undoDepth: undoDepth(cm.state),
							yContent: finalYText.toString(),
						boundPath: targetBinding?.path ?? null,
						sourceUndoDestroyed,
						controllerCalls,
						adoptionRequestPaths,
						adoptionRequestOutcomes,
						adoptionRequestFileIds,
						adoptionRequestHasYText,
						adoptionRequestAuthorityKinds,
						transitionCmDocuments,
							recoveryPersistRequests,
							handoffCleared: manager.getManagedSession(view)?.handoff === null,
							hostSaveSnapshots,
					};
					manager.unbindAll();
					cm.destroy();
					doc.destroy();
					return result;
					};
					return {
						sourceDrainOrdering: await runScenario({
							suffix: "source-drain-ordering",
							contentA: "source A",
							contentB: "target B",
							probeSourceDrainOrdering: true,
						}),
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
						targetFirstBeforePresentationProof: await runScenario({
							suffix: "target-first-before-presentation-proof",
							contentA: "source A must never roll back",
							contentB: "local target B",
							probeTargetFirstBeforePresentationProof: true,
						}),
						pendingHostFailure: await runScenario({
							suffix: "pending-host-failure",
							contentA: "pending source A",
							contentB: "pending local B",
							probePendingHostFailure: true,
						}),
						deferredTargetBytes: await runScenario({
							suffix: "deferred-target-bytes",
							contentA: "deferred source A",
							contentB: "deferred target B",
							probeDeferredTargetBytes: true,
						}),
						missingTarget: await runScenario({
							suffix: "missing-target",
							contentA: "missing source A",
							contentB: "disk-only target B",
							probeMissingTarget: true,
						}),
						superseded: await runScenario({
							suffix: "superseded",
							contentA: "source before supersession",
							contentB: "stale target B",
							contentC: "current target C",
							probeSupersededInput: true,
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
			handoffActive: boolean;
			gateClosed: boolean | null;
			containerInert: boolean;
			transitionState: string | null;
			transitionTargetPath: string | null;
			emergencySaveBlocked: boolean;
			targetLoadCalls: number;
			setViewDataCalls: number;
			sourceUnloadPrefixSaveBlocked: boolean;
		};
		assertEq(result.initiallyBound, true, "real guard fixture starts with A bound");
		assertEq(result.cmContent, "source", "stale user dispatch never reaches CodeMirror");
		assertEq(result.yContent, "source", "stale user dispatch never reaches Y.Text");
		assertEq(result.bindingDetached, true, "stale user dispatch detaches the exact settled A binding");
		assertEq(result.lineagePath, "Notes/browser-A.md", "stale user dispatch preserves A lineage");
		assertEq(result.admissionCount, 0, "observed file-first mismatch requests no B admission");
		assertEq(result.handoffActive, false, "observed file-first mismatch mints no handoff");
		assertEq(result.gateClosed, true, "real CodeMirror input gate remains closed");
		assertEq(result.containerInert, true, "real pane container remains inert");
		assertEq(result.transitionState, "reopen-required", "real transition owner requires pane reopen");
		assertEq(
			result.transitionTargetPath,
			"Notes/browser-B.md",
			"real terminal owner retains exact B identity",
		);
		assertEq(result.emergencySaveBlocked, true, "real native save entry points remain blocked");
		assertEq(result.targetLoadCalls, 0, "real terminal path performs no target load");
		assertEq(result.setViewDataCalls, 0, "real terminal path performs no target apply or replay");
		assertEq(
			result.sourceUnloadPrefixSaveBlocked,
			true,
			"source-unload-not-provable prefix synchronously installs the emergency save fence",
		);

			const task9Line = child.stdout.split("\n").find((line) => line.startsWith("TASK9_RESULT="));
			type Task9InputOnB = {
				cmContent: string;
				viewData: string;
				undoDepth: number;
				ytextA: string;
				ytextB: string;
			};
			type Task9ScenarioResult = {
			firstTargetPresentation: {
				cmContent: string;
				viewData: string;
				editorRevision: number;
				editorAuthorityRevision: number;
				editorAuthorityContent: string | null;
				gateClosed: boolean | null;
				inputGateInstalled: boolean;
				ytextA: string;
				ytextB: string;
					};
				inputOnB: Task9InputOnB | null;
				cmContent: string;
				undoDepth: number;
				yContent: string;
			boundPath: string | null;
			sourceUndoDestroyed: number;
			controllerCalls: string[];
			adoptionRequestPaths: string[];
			adoptionRequestOutcomes: string[];
			adoptionRequestFileIds: Array<string | null>;
			adoptionRequestHasYText: boolean[];
			adoptionRequestAuthorityKinds: string[];
			transitionCmDocuments: string[];
				recoveryPersistRequests: number;
				handoffCleared: boolean;
				hostSaveSnapshots: Array<{
					path: string | null;
					content: string;
				}>;
			};
			type MissingTargetResult = Omit<
				Task9ScenarioResult,
				"inputOnB" | "undoDepth" | "hostSaveSnapshots"
			> & {
				afterInput: Task9InputOnB;
				missingTargetSeedContents: string[];
				ytextBMutations: number;
			};
			type SupersededScenarioResult = Omit<Task9ScenarioResult, "inputOnB"> & {
				inputOnB: Task9InputOnB;
			};
		type TargetFirstBeforePresentationProofResult = {
			beforeInput: {
				nextEventTurnReached: boolean;
				cmContent: string;
				viewData: string;
				gateClosed: boolean | null;
				inputGateInstalled: boolean;
				undoDepth: number;
				ytextA: string;
				ytextB: string;
			};
			afterInput: {
				cmContent: string;
				undoDepth: number;
				ytextA: string;
				ytextB: string;
			};
			admissionWhileInputVisible: {
				adoptionKind: string | null;
				displayedContent: string | null;
				requiredPath: string | null;
				bindingPath: string | null;
			};
			afterUndo: {
				cmContent: string;
				undoDepth: number;
				ytextA: string;
				ytextB: string;
				ytextAMutations: number;
				ytextBMutations: number;
			};
			undoApplied: boolean;
			transitionCmDocuments: string[];
			adoptionRequestPaths: string[];
			adoptionRequestOutcomes: string[];
			recoveryPersistRequests: number;
		};
		type PendingHostFailureResult = {
			beforeInput: {
				hostLoadSettled: boolean;
				cmContent: string;
				viewData: string;
				gateClosed: boolean | null;
				handoffCleared: boolean;
			};
			afterInput: {
				cmContent: string;
				ytextA: string;
				ytextB: string;
			};
			afterHostFailure: {
				hostOutcome: string;
				cmContent: string;
				gateClosed: boolean | null;
				displayedContent: string | null;
			};
			transitionCmDocuments: string[];
			recoveryPersistRequests: number;
		};
		type DeferredTargetBytesResult = {
			beforeTarget: {
				cmContent: string;
				gateClosed: boolean | null;
				handoffCleared: boolean;
			};
			whileTargetMissing: {
				cmContent: string;
				recoveryPersistRequests: number;
				ytextA: string;
				ytextB: string;
			};
			afterTarget: {
				cmContent: string;
				gateClosed: boolean | null;
				handoffCleared: boolean;
			};
			afterTargetInput: {
				cmContent: string;
				recoveryPersistRequests: number;
			};
			transitionCmDocuments: string[];
		};
		type SourceDrainOrderingResult = {
			activeInputPrevented: boolean;
			beforeCompletion: {
				unloadOutcome: string;
				nativeUnloadCalls: number;
				forcedSourceSaveCalls: number;
				cmContent: string;
			};
			afterFreshInput: {
				defaultPrevented: boolean;
				cmContent: string;
				recoveryPersistRequests: number;
			};
			beforePriorSaveSettlement: {
				unloadOutcome: string;
				nativeUnloadCalls: number;
				forcedSourceSaveCalls: number;
				cmContent: string;
			};
			afterUnload: {
				unloadOutcome: string;
				nativeUnloadCalls: number;
				forcedSourceSaveCalls: number;
				nativeSaveCalls: number;
				hostSaveSnapshots: Array<{ path: string | null; content: string }>;
			};
			afterLoad: {
				nativeLoadCalls: number;
				cmContent: string;
				ytextA: string;
				ytextB: string;
				boundPath: string | null;
				recoveryPersistRequests: number;
			};
			sourceDrainOrder: string[];
			cleanup: {
				exactCloseCount: number;
				managedRemoved: boolean;
				cmInert: boolean | null;
				targetSelectionFence: unknown;
				sourceUnloadDrain: unknown;
				wrappersRestored: boolean;
			};
		};
		const task9Scenarios = JSON.parse(
			task9Line?.slice("TASK9_RESULT=".length) ?? "null",
		) as {
			sourceDrainOrdering: SourceDrainOrderingResult;
			different: Task9ScenarioResult;
			identical: Task9ScenarioResult;
			targetFirstBeforePresentationProof: TargetFirstBeforePresentationProofResult;
			pendingHostFailure: PendingHostFailureResult;
			deferredTargetBytes: DeferredTargetBytesResult;
				missingTarget: MissingTargetResult;
				superseded: SupersededScenarioResult;
		};

		const sourceDrain = task9Scenarios.sourceDrainOrdering;
		assertEq(sourceDrain.activeInputPrevented, false, "the already-started A input remains the one drainable lane");
		assertEq(sourceDrain.beforeCompletion.unloadOutcome, "pending", "native unload waits while exact A input is unresolved");
		assertEq(sourceDrain.beforeCompletion.nativeUnloadCalls, 0, "native unload has not entered before A completion");
		assertEq(sourceDrain.beforeCompletion.forcedSourceSaveCalls, 0, "forced source save has not entered before A completion");
		assertEq(sourceDrain.beforeCompletion.cmContent, "source A", "unresolved input leaves A unchanged");
		assertEq(sourceDrain.afterFreshInput.defaultPrevented, true, "fresh input is rejected during source drain");
		assertEq(sourceDrain.afterFreshInput.cmContent, "source A", "fresh input contributes zero bytes");
		assertEq(sourceDrain.afterFreshInput.recoveryPersistRequests, 0, "fresh input is never persisted for replay");
		assertEq(sourceDrain.beforePriorSaveSettlement.cmContent, "source Ax", "the exact predecessor reaches A once");
		assertEq(sourceDrain.beforePriorSaveSettlement.unloadOutcome, "pending", "unload still waits for the preexisting save tail");
		assertEq(sourceDrain.beforePriorSaveSettlement.nativeUnloadCalls, 0, "preexisting save settles before native unload entry");
		assertEq(sourceDrain.beforePriorSaveSettlement.forcedSourceSaveCalls, 0, "preexisting save settles before the forced A+x save");
		assertEq(sourceDrain.afterUnload.unloadOutcome, "fulfilled", "exact source drain completes native unload");
		assertEq(sourceDrain.afterUnload.nativeUnloadCalls, 1, "native unload enters exactly once");
		assertEq(sourceDrain.afterUnload.forcedSourceSaveCalls, 1, "forced source save enters exactly once");
		assertEq(sourceDrain.afterUnload.nativeSaveCalls, 2, "one prior save and one forced save reach native code");
		assertEq(sourceDrain.afterUnload.hostSaveSnapshots.length, 1, "only the forced source save records a retirement snapshot");
		assertEq(sourceDrain.afterUnload.hostSaveSnapshots[0]?.content, "source Ax", "forced source save owns exact A+x bytes");
		assertEq(sourceDrain.afterLoad.nativeLoadCalls, 1, "native B load enters exactly once");
		assertEq(sourceDrain.afterLoad.cmContent, "target B", "B replaces A only through native host load");
		assertEq(sourceDrain.afterLoad.ytextA, "source Ax", "A+x remains saved on A authority");
		assertEq(sourceDrain.afterLoad.ytextB, "target B", "B authority receives no replayed A bytes");
		assertEq(sourceDrain.afterLoad.recoveryPersistRequests, 0, "ordinary drain creates no recovery persistence");
		assertEq(
			sourceDrain.sourceDrainOrder.join(","),
			"prior-save-enter,input-completed,prior-save-settled,native-unload-enter,forced-save-enter,native-load-enter",
			"source completion, prior save, forced save, and B load retain strict order",
		);
		assertEq(sourceDrain.cleanup.exactCloseCount, 1, "exact close consumes the managed pane once");
		assertEq(sourceDrain.cleanup.managedRemoved, true, "exact close releases manager ownership");
		assertEq(sourceDrain.cleanup.cmInert, true, "exact close leaves the retired CM guard inert");
		assertEq(sourceDrain.cleanup.targetSelectionFence, null, "exact close releases the target-less token");
		assertEq(sourceDrain.cleanup.sourceUnloadDrain, null, "exact close releases the source drain");
		assertEq(sourceDrain.cleanup.wrappersRestored, true, "exact close restores native host wrappers");

		const targetFirst = task9Scenarios.targetFirstBeforePresentationProof;
		assertEq(
			targetFirst.adoptionRequestOutcomes.length > 0
				&& targetFirst.adoptionRequestOutcomes.every((outcome) => outcome === "unresolved"),
			true,
			"target-first fixture keeps every background same-path admission unresolved",
		);
		assertEq(
			targetFirst.adoptionRequestPaths.length > 0
				&& targetFirst.adoptionRequestPaths.every(
					(path) => path === "Notes/task9-browser-target-first-before-presentation-proof-B.md",
				),
			true,
			"every background admission remains scoped to exact B",
		);
		assertEq(
			targetFirst.beforeInput.nextEventTurnReached,
			false,
			"awaiting B load returns before the next event turn",
		);
		assertEq(
			targetFirst.beforeInput.cmContent,
			"local target B",
			"the first statement after awaiting B load observes local B in CodeMirror",
		);
		assertEq(
			targetFirst.beforeInput.viewData,
			"local target B",
			"the first statement after awaiting B load observes local B in the host cache",
		);
		assertEq(
			[
				task9Scenarios.different.firstTargetPresentation.editorRevision,
				task9Scenarios.different.firstTargetPresentation.editorAuthorityRevision,
			].join("|"),
			"1|1",
			"local B presentation advances editor content and authority revisions together",
		);
		assertEq(
			task9Scenarios.different.firstTargetPresentation.editorAuthorityContent,
			"target B",
			"local B presentation publishes exact B as the current editor authority",
		);
		assertEq(
			targetFirst.beforeInput.gateClosed,
			false,
			"B is editable immediately after the host load promise returns",
		);
		assertEq(
			targetFirst.beforeInput.inputGateInstalled,
			false,
			"the reducer exposes no transition input gate after local B presentation",
		);
		assertEq(
			targetFirst.beforeInput.undoDepth,
			0,
			"local B presentation starts with no source-native undo history",
		);
		assertEq(
			targetFirst.afterInput.cmContent,
			"local target B!",
			"the immediate post-load input applies normally to B",
		);
		assertEq(
			targetFirst.transitionCmDocuments.filter(
				(content) => content === "local target B!",
			).length,
			1,
			"the immediate B input reaches the editor update boundary exactly once",
		);
		assertEq(
			targetFirst.admissionWhileInputVisible.adoptionKind,
			"planning",
			"background admission advances to planning while the immediate B input remains visible",
		);
		assertEq(
			targetFirst.admissionWhileInputVisible.displayedContent,
			"local target B!",
			"background admission observes the exact B successor document",
		);
		assertEq(
			targetFirst.admissionWhileInputVisible.requiredPath,
			"Notes/task9-browser-target-first-before-presentation-proof-B.md",
			"the retry hold remains scoped to exact B while its plan is unresolved",
		);
		assertEq(
			targetFirst.admissionWhileInputVisible.bindingPath,
			null,
			"unresolved admission does not publish a premature B binding",
		);
		assertEq(
			targetFirst.recoveryPersistRequests,
			0,
			"normal target-first input creates no recovery persistence request",
		);
		assertEq(
			[
				targetFirst.beforeInput.ytextA,
				targetFirst.afterInput.ytextA,
				targetFirst.afterUndo.ytextA,
			].join("|"),
			[
				"source A must never roll back",
				"source A must never roll back",
				"source A must never roll back",
			].join("|"),
			"A Y.Text remains unchanged before background admission",
		);
		assertEq(
			[
				targetFirst.beforeInput.ytextB,
				targetFirst.afterInput.ytextB,
				targetFirst.afterUndo.ytextB,
			].join("|"),
			["local target B", "local target B", "local target B"].join("|"),
			"B Y.Text remains unchanged before background admission",
		);
		assertEq(
			[
				targetFirst.afterUndo.ytextAMutations,
				targetFirst.afterUndo.ytextBMutations,
			].join("|"),
			"0|0",
			"target-first local input and undo perform no transient CRDT mutation",
		);
		assertEq(
			targetFirst.transitionCmDocuments.join("|"),
			["local target B", "local target B!", "local target B"].join("|"),
			"local B, its input, and its undo contain no rollback to source A",
		);
		assertEq(
			targetFirst.afterInput.undoDepth,
			1,
			"native undo history contains only the B user input",
		);
		assertEq(targetFirst.undoApplied, true, "native undo consumes the one B input");
		assertEq(
			targetFirst.afterUndo.cmContent,
			"local target B",
			"native undo returns only to local B, never source A",
		);
		assertEq(
			targetFirst.afterUndo.undoDepth,
			0,
			"native undo exhausts the B-only history after one step",
		);

		const pendingHostFailure = task9Scenarios.pendingHostFailure;
		assertEq(
			pendingHostFailure.beforeInput.hostLoadSettled,
			false,
			"B local authority does not wait for the host load promise",
		);
		assertEq(
			[
				pendingHostFailure.beforeInput.cmContent,
				pendingHostFailure.beforeInput.viewData,
			].join("|"),
			"pending local B|pending local B",
			"pending host load already presents exact B in editor and host cache",
		);
		assertEq(
			[
				pendingHostFailure.beforeInput.gateClosed,
				pendingHostFailure.beforeInput.handoffCleared,
			].join("|"),
			"false|true",
			"pending host load leaves B editable with no transition handoff",
		);
		assertEq(
			pendingHostFailure.afterInput.cmContent,
			"pending local B!",
			"input applies once to B while the host promise is still pending",
		);
		assertEq(
			pendingHostFailure.transitionCmDocuments.filter(
				(content) => content === "pending local B!",
			).length,
			1,
			"pending-host B input crosses the editor boundary exactly once",
		);
		assertEq(
			[
				pendingHostFailure.afterInput.ytextA,
				pendingHostFailure.afterInput.ytextB,
			].join("|"),
			"pending source A|pending local B",
			"pending-host input causes no transient A or B CRDT mutation",
		);
		assertEq(
			pendingHostFailure.afterHostFailure.hostOutcome,
			"fulfilled",
			"the locally committed host wrapper does not expose a late native rejection as target failure",
		);
		assertEq(
			[
				pendingHostFailure.afterHostFailure.cmContent,
				pendingHostFailure.afterHostFailure.displayedContent,
				pendingHostFailure.afterHostFailure.gateClosed,
			].join("|"),
			"pending local B!|pending local B!|false",
			"late host failure cannot roll B back or close its input gate",
		);
		assertEq(
			pendingHostFailure.recoveryPersistRequests,
			0,
			"pending or rejected host load creates no replay recovery intent",
		);

		const deferredTarget = task9Scenarios.deferredTargetBytes;
		assertEq(
			[
				deferredTarget.beforeTarget.cmContent,
				deferredTarget.beforeTarget.gateClosed,
				deferredTarget.beforeTarget.handoffCleared,
			].join("|"),
			"deferred source A|true|false",
			"before B bytes arrive the old surface is explicitly non-editable",
		);
		assertEq(
			[
				deferredTarget.whileTargetMissing.cmContent,
				deferredTarget.whileTargetMissing.recoveryPersistRequests,
			].join("|"),
			"deferred source A|0",
			"pre-target input is rejected without capture, replay, or visible mutation",
		);
		assertEq(
			[
				deferredTarget.whileTargetMissing.ytextA,
				deferredTarget.whileTargetMissing.ytextB,
			].join("|"),
			"deferred source A|deferred target B",
			"blocked pre-target input mutates neither source nor target CRDT",
		);
		assertEq(
			[
				deferredTarget.afterTarget.cmContent,
				deferredTarget.afterTarget.gateClosed,
				deferredTarget.afterTarget.handoffCleared,
			].join("|"),
			"deferred target B|false|true",
			"B becomes local editable authority as soon as its bytes arrive",
		);
		assertEq(
			[
				deferredTarget.afterTargetInput.cmContent,
				deferredTarget.afterTargetInput.recoveryPersistRequests,
			].join("|"),
			"deferred target B!|0",
			"the first post-target input applies normally once with no replay intent",
		);
		assertEq(
			deferredTarget.transitionCmDocuments.includes("deferred source A?"),
			false,
			"rejected pre-target input never appears and therefore cannot roll back",
		);
		assertEq(
			deferredTarget.transitionCmDocuments.filter(
				(content) => content === "deferred target B!",
			).length,
			1,
			"post-target input crosses the editor boundary exactly once",
		);

		const missingTarget = task9Scenarios.missingTarget;
			assertEq(
				[
					missingTarget.firstTargetPresentation.cmContent,
					missingTarget.firstTargetPresentation.viewData,
					missingTarget.firstTargetPresentation.gateClosed,
					missingTarget.handoffCleared,
				].join("|"),
				"disk-only target B|disk-only target B|false|true",
				"missing-sync B is still immediate stable local authority",
			);
			assertEq(
				[
					missingTarget.afterInput.cmContent,
					missingTarget.afterInput.viewData,
				].join("|"),
				"disk-only target B!|disk-only target B!",
				"input advances the missing-sync B editor and host cache exactly once",
			);
			assertEq(
				[
					missingTarget.afterInput.ytextA,
					missingTarget.afterInput.ytextB,
				].join("|"),
				"missing source A|disk-only target B",
				"the local B input mutates neither CRDT before certified seed",
			);
			assertEq(
				missingTarget.missingTargetSeedContents.join("|"),
				"disk-only target B!",
				"missing target is seeded once from the latest B successor, not stale B",
			);
			assertEq(
				missingTarget.ytextBMutations,
				1,
				"latest B successor is committed to the target CRDT in one transaction",
			);
			assertEq(
				[
					missingTarget.cmContent,
					missingTarget.yContent,
					missingTarget.boundPath,
				].join("|"),
				[
					"disk-only target B!",
					"disk-only target B!",
					"Notes/task9-browser-missing-target-B.md",
				].join("|"),
				"seed replan binds exact latest B without a visible replacement dispatch",
			);
			assertEq(
				missingTarget.adoptionRequestPaths.length >= 3
					&& missingTarget.adoptionRequestPaths.every(
						(path) => path === "Notes/task9-browser-missing-target-B.md",
					),
				true,
				"held, seed, and bind requests all remain scoped to exact B",
			);
			assertEq(
				missingTarget.adoptionRequestOutcomes.join("|"),
				"held-before-input|seeded-replan|planned",
				"stale pre-input planning is replaced by one latest-successor seed and bind",
			);
			assertEq(
				missingTarget.adoptionRequestFileIds.map((value) => value ?? "null").join("|"),
				"null|null|file-B",
				"file identity appears only after the missing target has been seeded",
			);
			assertEq(
				missingTarget.adoptionRequestHasYText.join("|"),
				"false|false|true",
				"Y.Text authority appears only on the post-seed bind request",
			);
			assertEq(
				missingTarget.adoptionRequestAuthorityKinds.every(
					(kind) => kind === "proven-single",
				),
				true,
				"every missing-target step retains single-editor B authority",
			);
			assertEq(
				missingTarget.transitionCmDocuments.join("|"),
				"disk-only target B|disk-only target B!",
				"missing-target adoption never rolls the visible editor back to A or stale B",
			);
			assertEq(
				missingTarget.recoveryPersistRequests,
				0,
				"missing-sync input and seed create no handoff replay intent",
			);

		const task9 = task9Scenarios.different;
		assertEq(
			task9.firstTargetPresentation.cmContent,
			"target B",
			"ordinary A-to-B switch presents B before sync admission settles",
		);
		assertEq(
			task9.firstTargetPresentation.viewData,
			"target B",
			"ordinary A-to-B switch publishes B to the host cache",
		);
		assertEq(
			task9.firstTargetPresentation.gateClosed,
			false,
			"ordinary local B is editable",
		);
		assertEq(
			task9.firstTargetPresentation.inputGateInstalled,
			false,
			"ordinary local B has no transition input gate",
		);
		assertEq(task9.cmContent, "target B", "ordinary B remains displayed after admission");
		assertEq(task9.yContent, "target B", "ordinary admission retains exact B Y.Text");
		assertEq(
			task9.boundPath,
			"Notes/task9-browser-different-B.md",
			"same-path admission binds exact B",
		);
		assertEq(task9.sourceUndoDestroyed, 1, "A Y.UndoManager is destroyed exactly once");
		assertEq(task9.recoveryPersistRequests, 0, "ordinary A-to-B switch creates no recovery");
		assertEq(task9.handoffCleared, true, "ordinary B admission leaves stable state");
		assertEq(
			task9.transitionCmDocuments.join("|"),
			"target B",
			"ordinary transition contains B and no rollback to A",
		);
		assertEq(
			task9.adoptionRequestPaths.join("|"),
			"Notes/task9-browser-different-B.md",
			"ordinary admission request is scoped to exact B",
		);
		assertEq(task9.adoptionRequestOutcomes.join("|"), "planned", "ordinary B admission is planned");
		assertEq(
			task9.controllerCalls.join("|"),
			[
				"request-same-path-adoption",
				"consume-same-path-mutation",
				"consume-same-path-bind",
				"note-same-path-bound",
			].join("|"),
			"same-path admission consumes mutation and bind authority in order",
		);

		const identical = task9Scenarios.identical;
		assertEq(
			identical.firstTargetPresentation.cmContent,
			"same bytes",
			"equal A/B bytes still present through the target-first boundary",
		);
		assertEq(
			identical.firstTargetPresentation.gateClosed,
			false,
			"equal-byte B is editable without waiting behind an identity gate",
		);
		assertEq(
			identical.boundPath,
			"Notes/task9-browser-identical-B.md",
			"equal bytes bind only the exact B identity",
		);
		assertEq(
			identical.adoptionRequestPaths.join("|"),
			"Notes/task9-browser-identical-B.md",
			"equal bytes request admission for exact B",
		);
		assertEq(
			identical.controllerCalls.join("|"),
			task9.controllerCalls.join("|"),
			"equal bytes use the same identity-safe same-path permit sequence",
		);
		assertEq(identical.recoveryPersistRequests, 0, "equal-byte transition creates no recovery");
		assertEq(identical.handoffCleared, true, "equal-byte B admission leaves stable state");

		const superseded = task9Scenarios.superseded;
		assertEq(
			superseded.firstTargetPresentation.cmContent,
			"stale target B",
			"superseded flow still presents B locally before C is selected",
		);
		assertEq(
			superseded.firstTargetPresentation.viewData,
			"stale target B",
			"superseded flow publishes B to the host cache before C",
		);
			assertEq(
				superseded.firstTargetPresentation.gateClosed,
			false,
				"locally presented B remains editable while its admission is unresolved",
			);
			assertEq(
				[
					superseded.inputOnB.cmContent,
					superseded.inputOnB.viewData,
					superseded.inputOnB.undoDepth,
				].join("|"),
				"stale target B!|stale target B!|1",
				"input immediately before C advances only the visible B editor and host cache",
			);
			assertEq(
				[
					superseded.inputOnB.ytextA,
					superseded.inputOnB.ytextB,
				].join("|"),
				"source before supersession|stale target B",
				"pre-C B input does not transiently mutate A or unresolved B CRDT",
			);
			assertEq(
				superseded.hostSaveSnapshots.filter(
					(snapshot) => snapshot.path === "Notes/task9-browser-superseded-B.md"
						&& snapshot.content === "stale target B!",
				).length,
				1,
				"the B successor reaches the host save boundary once before C replaces it",
			);
			assertEq(
				superseded.transitionCmDocuments.join("|"),
				["stale target B", "stale target B!", "current target C"].join("|"),
				"B input and C presentation occur once each with no rollback to A",
			);
			assertEq(superseded.cmContent, "current target C", "C remains the displayed target");
			assertEq(
				superseded.undoDepth,
				0,
				"C starts with fresh native history and cannot undo back into B",
			);
		assertEq(superseded.yContent, "current target C", "only exact C becomes bound authority");
		assertEq(
			superseded.boundPath,
			"Notes/task9-browser-superseded-C.md",
			"the unresolved B admission cannot bind across C supersession",
		);
			assertEq(
				superseded.adoptionRequestPaths.length >= 2
					&& superseded.adoptionRequestPaths.at(-1)
						=== "Notes/task9-browser-superseded-C.md"
					&& superseded.adoptionRequestPaths.slice(0, -1).every(
						(path) => path === "Notes/task9-browser-superseded-B.md",
					),
				true,
				"B and C keep distinct same-path admission identities",
			);
			assertEq(
				superseded.adoptionRequestOutcomes.length >= 2
					&& superseded.adoptionRequestOutcomes.at(-1) === "planned"
					&& superseded.adoptionRequestOutcomes.slice(0, -1).every(
						(outcome) => outcome === "unresolved",
					),
				true,
				"B admission remains unresolved while C receives a fresh plan",
			);
			assertEq(
				superseded.controllerCalls.filter(
					(call) => call === "request-same-path-adoption",
				).length,
				superseded.adoptionRequestPaths.length,
				"every B or C adoption has exactly one controller request",
			);
			assertEq(
				superseded.controllerCalls.slice(-3).join("|"),
				"consume-same-path-mutation|consume-same-path-bind|note-same-path-bound",
				"only C consumes mutation and bind authority after supersession",
		);
		assertEq(superseded.sourceUndoDestroyed, 1, "A authority detaches once across B-to-C");
		assertEq(superseded.recoveryPersistRequests, 0, "B-to-C supersession creates no recovery");
		assertEq(superseded.handoffCleared, true, "C admission leaves stable state");
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
	assertEq(session?.handoff, null, "uncertain rename mints no automatic handoff");
	assertEq(admissions.length, 0, "uncertain rename requests no target admission");
	const uncertainRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: {
				state: string;
				targetFile: unknown;
				targetPath: string;
			} | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(
		uncertainRuntime?.transitionInputFence?.state,
		"reopen-required",
		"uncertain rename retains an explicit reopen boundary",
	);
	assertEq(
		uncertainRuntime?.transitionInputFence?.targetFile,
		replacementFile,
		"uncertain rename terminal retains the exact replacement identity",
	);
	assertEq(
		uncertainRuntime?.transitionInputFence?.targetPath,
		renamedPath,
		"uncertain rename terminal retains the exact replacement path",
	);
	assertEq(
		uncertainRuntime?.emergencySaveFence?.isCurrent(),
		true,
		"uncertain rename blocks native saves until explicit reopen",
	);
	assertEq(
		manager.capturePathEditorAuthority(renamedPath).kind,
		"blocked",
		"uncertain rename keeps the path authority gate closed",
	);
	manager.reconcileManagedWorkspaceViews([], "test-40-close");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 41: public A-to-B-to-C wakes stay inside one observed terminal owner ---");
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
	const terminalRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown; targetPath: string } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	}).managedSessions.get("leaf-1");

	assertEq(manager.getBinding(binding.view as never), binding, "unprovable source binding remains owned until reopen");
	assertEq(undoDestroyCalls, 0, "unprovable A binding is never silently detached");
	assertEq(admissions.length, 0, "B and C create no target admission wakes");
	assertEq(current?.generation, generationB, "B-to-C terminal retargeting advances no handoff generation");
	assertEq(current?.handoff, null, "B-to-C terminal retargeting mints no handoff");
	assertEq(terminalRuntime?.transitionInputFence?.state, "reopen-required", "terminal fence remains reopen-required");
	assertEq(terminalRuntime?.transitionInputFence?.targetFile, fileC, "terminal owner retains only current C identity");
	assertEq(terminalRuntime?.transitionInputFence?.targetPath, fileC.path, "terminal owner retains only current C path");
	assertEq(terminalRuntime?.emergencySaveFence?.isCurrent(), true, "B-to-C keeps native saving blocked");
	assertEq(
		current?.displayedLineage.kind === "known" ? current.displayedLineage.file : null,
		binding.file,
		"B-to-C supersession retains source A displayed lineage",
	);
	manager.reconcileManagedWorkspaceViews([], "test-41-close");
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
		cancelTerminalHostLifecycle: () => true,
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
			pendingLoadEpoch: 0,
			clearLoadCapability: "observable",
			wrappersCurrent: true,
			loadWrappersCurrent: true,
			emergencySaveBlocked: false,
			mode: { kind: "pass-through" },
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
			pendingDeferredLoadAdmission: null,
			pendingSourceUnloadDrain: null,
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
	assertEq(userFence !== null, true, "user extender rejects input on same-path identity replacement");
	assertEq(manager.getBinding(binding.view as never), binding, "unprovable source binding remains owned behind terminal fences");
	assertEq(oldYTextMutations, 0, "user lane performs no old-Y.Text mutation");
	assertEq(userSession?.handoff, null, "user lane mints no automatic handoff");
	const handoffContext = (manager as unknown as {
		getCodeMirrorHandoffContext: (leafId: string) => {
			kind?: string;
			targetFile?: unknown;
		} | null;
	}).getCodeMirrorHandoffContext("leaf-1");
	assertEq(handoffContext, null, "same-path identity replacement has no usable editor authority context");
	assertEq(admissions.length, 0, "same-path replacement creates no controller admission");
	const userRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(userRuntime?.transitionInputFence?.state, "reopen-required", "user lane retains terminal input ownership");
	assertEq(userRuntime?.transitionInputFence?.targetFile, replacementFile, "user terminal owner keeps replacement identity");
	assertEq(userRuntime?.emergencySaveFence?.isCurrent(), true, "user lane retains native-save ownership");
	manager.reconcileManagedWorkspaceViews([], "test-43-user-close");
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
	assertEq(manager.getBinding(binding.view as never), binding, "provider lane retains unprovable source ownership");
	assertEq(binding.ytext.toString(), "server text", "provider lane leaves old Y.Text unchanged");
	assertEq(admissions.length, 0, "provider replacement creates no target admission");
	const providerRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(providerRuntime?.transitionInputFence?.state, "reopen-required", "provider lane retains terminal input ownership");
	assertEq(providerRuntime?.transitionInputFence?.targetFile, replacementFile, "provider terminal owner keeps replacement identity");
	assertEq(providerRuntime?.emergencySaveFence?.isCurrent(), true, "provider lane retains native-save ownership");
	manager.reconcileManagedWorkspaceViews([], "test-43-provider-close");
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
	assertEq(
		manager.getBinding(binding.view as never),
		binding,
		"awareness reentry retains the unprovable source binding behind the terminal boundary",
	);
	const awarenessRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(
		awarenessRuntime?.transitionInputFence?.state,
		"reopen-required",
		"awareness reentry closes on explicit reopen",
	);
	assertEq(
		awarenessRuntime?.transitionInputFence?.targetFile,
		fileC,
		"awareness reentry terminal retains the exact replacement identity",
	);
	assertEq(binding.ytext.toString(), "server text", "awareness reentry mutates no Y.Text");
	manager.reconcileManagedWorkspaceViews([], "test-45-awareness-close");
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
		manager.getManagedSession(binding.view as never)?.handoff,
		null,
		"publication callback mints no superseding handoff without selected provenance",
	);
	const publicationRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(
		publicationRuntime?.transitionInputFence?.state,
		"reopen-required",
		"publication callback retains a terminal input owner",
	);
	assertEq(
		publicationRuntime?.transitionInputFence?.targetFile,
		fileC,
		"publication callback terminal retains exact C identity",
	);
	assertEq(binding.ytext.toString(), "server text", "publication callback mutates no Y.Text");
	manager.reconcileManagedWorkspaceViews([], "test-45-publication-close");
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
	assertEq(
		manager.getBinding(binding.view as never),
		binding,
		"host-read reentry retains the unprovable source binding behind the terminal boundary",
	);
	const hostReadRuntime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
		}>;
	}).managedSessions.get("leaf-1");
	assertEq(
		hostReadRuntime?.transitionInputFence?.state,
		"reopen-required",
		"host-read reentry closes on explicit reopen",
	);
	assertEq(
		hostReadRuntime?.transitionInputFence?.targetFile,
		fileC,
		"host-read terminal retains the exact replacement identity",
	);
	assertEq(binding.ytext.toString(), "server text", "host-read reentry mutates no Y.Text");
	manager.reconcileManagedWorkspaceViews([], "test-45-host-read-close");
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
		beginPathHandoff: (
			view: unknown,
			targetFile: unknown,
			reason: string,
			provenance: "selected",
			sourceUnloadReceiptId: string,
		) => boolean;
		pendingAdmissionByLeafId: Map<string, unknown>;
		vaultSync: {
			getTextForPath: (path: string) => Y.Text | null;
			isMarkdownTombstoned: (path: string) => boolean;
			isPendingRenameTarget: (path: string) => boolean;
		};
	};
	const managedRuntime = internals.managedSessions.get("leaf-1");
	const guard = managedRuntime?.cmGuard ?? null;
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
	assertEq(
		internals.beginPathHandoff(
			binding.view,
			targetFile,
			`test-47-${targetKind}-selected`,
			"selected",
			`source-unload:test-47-${targetKind}`,
		),
		true,
		`${targetKind}: exact host selection establishes the tested handoff`,
	);
	(binding.view as unknown as { file: unknown }).file = targetFile;
	manager.bind(binding.view as never, "TestDevice");

	const initialEffects = traceRecords
		.filter((record) => (
			record.msg === "handoff-effect-applied"
			&& record.details?.reason === `test-47-${targetKind}-selected`
		))
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

console.log("\n--- Test 48a: an emergency host-save lease survives unmanage until explicit safe teardown ---");
{
	const { manager, binding, traceRecords } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const targetFile = { path: "Notes/emergency-save-fence-B.md" };
	const handoffApi = manager as unknown as {
		beginPathHandoff: (
			view: unknown,
			target: unknown,
			reason: string,
			provenance: "selected",
			sourceUnloadReceiptId: string,
		) => boolean;
	};
	assertEq(
		handoffApi.beginPathHandoff(
			binding.view,
			targetFile,
			"test-48a-selected",
			"selected",
			"source-unload:test-48a",
		),
		true,
		"fixture establishes an exact selected A-to-B handoff",
	);
	(binding.view as unknown as { file: unknown }).file = targetFile;
	const internals = manager as unknown as {
		managedSessions: Map<string, {
			session: ManagedLeafSession;
			cmGuard: unknown;
			hostGuard: unknown;
			emergencySaveFence: unknown;
		}>;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime) throw new Error("Expected managed runtime for emergency save-fence test");
	assertEq(runtime.session.handoff !== null, true, "fixture enters an active A-to-B handoff");
	let cmMarkInertCalls = 0;
	let cmRestoreCalls = 0;
	let hostRestoreCalls = 0;
	let emergencyRefreshCalls = 0;
	let emergencyReleaseCalls = 0;
	let emergencyReleased = false;
	runtime.cmGuard = {
		refreshGate: () => true,
		markInert: () => {
			cmMarkInertCalls += 1;
			return true;
		},
		restoreIfCurrent: () => {
			cmRestoreCalls += 1;
			return true;
		},
		snapshot: () => ({
			gateClosed: true,
			gateFailureReason: null,
			commitState: "none",
		}),
	};
	const emergencyFence = Object.freeze({
		view: binding.view,
		refresh: (): boolean => {
			emergencyRefreshCalls += 1;
			return !emergencyReleased;
		},
		isCurrent: (): boolean => !emergencyReleased,
		release: (): boolean => {
			if (emergencyReleased) return false;
			emergencyReleased = true;
			emergencyReleaseCalls += 1;
			return true;
		},
	});
	runtime.hostGuard = {
		acquireEmergencySaveFence: () => emergencyFence,
		beginBlockingHandoff: () => {},
		markInert: () => {},
		restoreIfCurrent: () => {
			hostRestoreCalls += 1;
			return true;
		},
		snapshot: () => ({
			view: binding.view,
			mode: { kind: "blocking-handoff" },
		}),
	};
	runtime.emergencySaveFence = emergencyFence;

	const unmanaged = manager.unmanageView(binding.view as never, "capability-lost-terminal");
	assertEq(unmanaged, false, "active emergency save ownership rejects ordinary unmanage");
	assertEq(emergencyRefreshCalls, 1, "ordinary unmanage revalidates the emergency wrapper identities");
	assertEq(emergencyReleaseCalls, 0, "ordinary unmanage cannot release the emergency save owner");
	assertEq(cmMarkInertCalls, 0, "ordinary unmanage cannot open the CodeMirror gate");
	assertEq(cmRestoreCalls, 0, "ordinary unmanage cannot restore CodeMirror wrappers");
	assertEq(hostRestoreCalls, 0, "ordinary unmanage cannot restore native save wrappers");
	assertEq(
		internals.managedSessions.get("leaf-1"),
		runtime,
		"ordinary unmanage retains the exact managed runtime",
	);
	assertEq(
		traceRecords.some((record) => record.msg === "managed-view-emergency-save-fence-retained"),
		true,
		"ordinary unmanage records retained emergency ownership",
	);

	assertEq(
		manager.reconcileManagedWorkspaceViews([], "test-explicit-close"),
		1,
		"exact workspace removal is an explicit safe teardown boundary",
	);
	assertEq(emergencyReleaseCalls, 1, "explicit safe teardown releases the emergency owner once");
	assertEq(cmMarkInertCalls, 1, "explicit safe teardown may inert CodeMirror after release");
	assertEq(cmRestoreCalls, 1, "explicit safe teardown restores CodeMirror wrappers after release");
	assertEq(hostRestoreCalls, 1, "explicit safe teardown restores native save wrappers after release");
	assertEq(
		internals.managedSessions.has("leaf-1"),
		false,
		"explicit safe teardown removes managed ownership",
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
	const runtime = (manager as unknown as {
		managedSessions: Map<string, {
			transitionInputFence: { state: string; targetFile: unknown } | null;
			emergencySaveFence: { isCurrent(): boolean } | null;
		}>;
	}).managedSessions.get("leaf-1");

	assertEq(
		session?.handoff,
		null,
		"wake observation never fabricates a selected A-to-B handoff",
	);
	assertEq(
		session?.currentSwitchIntentSeq ?? null,
		null,
		"bind wake observation does not claim a guarded host switch intent",
	);
	assertEq(
		runtime?.transitionInputFence?.state,
		"reopen-required",
		"unselected wake mismatch stays behind the explicit reopen boundary",
	);
	assertEq(
		runtime?.transitionInputFence?.targetFile,
		observedFile,
		"the terminal wake owner retains the exact observed target identity",
	);
	assertEq(
		runtime?.emergencySaveFence?.isCurrent(),
		true,
		"unselected wake mismatch also retains native-save ownership",
	);
	manager.reconcileManagedWorkspaceViews([], "test-51-close");
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
				samePathDispatch: Readonly<{
					batchStartDocument: object;
					nativeHistoryEpochBefore: number;
					nativeHistoryEpochAfter: number;
				}>;
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
		"host-preclear-candidate-held",
		"certified pre-clear uses the dedicated effect boundary",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 58b: unload waits for the exact active A input, then owns one target-less fence ---");
{
	const { manager, binding, traceRecords, setLiveEditorContent } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	type DrainRuntime = {
		session: ManagedLeafSession;
		sourceUnloadDrain: {
			state: string;
			reservation: ManagedLeafInputStartReservation | null;
			targetSelectionToken: object | null;
		} | null;
		cmGuard: {
			snapshot(): Readonly<{
				inert: boolean;
				sourceUnloadDrain: Readonly<{
					reservation: ManagedLeafInputStartReservation;
				}> | null;
				targetSelectionFence: object | null;
			}>;
		} | null;
	};
	const internals = manager as unknown as {
		managedSessions: Map<string, DrainRuntime>;
		editorRevisionByCm: WeakMap<object, number>;
		beginSourceUnloadDrain(
			runtime: DrainRuntime,
			sourceFile: unknown,
		): null | PromiseLike<void>;
		acceptSamePathInputCompletion(
			runtime: DrainRuntime,
			completion: Readonly<{
				reservation: ManagedLeafInputStartReservation;
				cm: object;
				startDocument: object;
				finalDocument: object;
				samePathDispatch: Readonly<{
					batchStartDocument: object;
					nativeHistoryEpochBefore: number;
					nativeHistoryEpochAfter: number;
				}>;
			}>,
		): boolean;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime?.cmGuard) throw new Error("Expected managed drain runtime");
	const source = runtime.session.displayedLineage;
	if (source.kind !== "known") throw new Error("Expected known source lineage");

	const sourceState = EditorState.create({ doc: source.document.toString() });
	const cmState = (binding.cm as unknown as { state: Record<string, unknown> }).state;
	(binding.cm as unknown as { state: Record<string, unknown> }).state = {
		...cmState,
		doc: sourceState.doc,
	};
	runtime.session = {
		...runtime.session,
		displayedLineage: {
			...source,
			document: sourceState.doc,
		},
	};
	const reserved = reserveManagedLeafInputStart(runtime.session, {
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		inputEpoch: 1,
		compositionEpoch: null,
	});
	if (!reserved.accepted || reserved.state.pendingInputStartReservation === null) {
		throw new Error("Expected exact A input reservation");
	}
	const reservation = reserved.state.pendingInputStartReservation;
	runtime.session = reserved.state;

	let drainSettled = false;
	let drainRejected = false;
	const drain = internals.beginSourceUnloadDrain(runtime, source.file);
	if (drain === null) throw new Error("Active A input must return a drain promise");
	void Promise.resolve(drain).then(
		() => { drainSettled = true; },
		() => { drainRejected = true; },
	);
	assertEq(runtime.sourceUnloadDrain?.state, "draining", "native unload owns the exact A input lane");
	assertEq(
		runtime.cmGuard.snapshot().sourceUnloadDrain?.reservation,
		reservation,
		"CodeMirror exposes only the reducer-owned predecessor reservation",
	);
	assertEq(drainSettled, false, "native unload has not entered while A input is unresolved");
	const prematureTarget = reduceManagedLeafSession(runtime.session, {
		type: "target-selected",
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		targetFile: { path: "Notes/source-drain-B.md" } as typeof source.file,
		switchIntentSeq: runtime.session.eventOrderSeq + 1,
		sourceUnloadReceiptId: "source-unload:premature",
	});
	assertEq(prematureTarget.accepted, false, "B selection cannot overtake the unresolved A input");

	const finalState = sourceState.update({
		changes: { from: sourceState.doc.length, insert: "x" },
	});
	(binding.cm as unknown as { state: Record<string, unknown> }).state = {
		...(binding.cm as unknown as { state: Record<string, unknown> }).state,
		doc: finalState.state.doc,
	};
	setLiveEditorContent(finalState.state.doc.toString());
	runtime.session = {
		...runtime.session,
		displayedLineage: {
			...source,
			document: finalState.state.doc,
			editorRevision: 1,
		},
	};
	internals.editorRevisionByCm.set(binding.cm, 1);
	const settleDrain = captureSingleMicrotask(() => {
		assertEq(
			internals.acceptSamePathInputCompletion(runtime, {
				reservation,
				cm: binding.cm,
				startDocument: sourceState.doc,
				finalDocument: finalState.state.doc,
				samePathDispatch: {
					batchStartDocument: sourceState.doc,
					nativeHistoryEpochBefore: 0,
					nativeHistoryEpochAfter: 1,
				},
			}),
			true,
			"the exact A+x successor completes the owned lane once",
		);
	});
	assertEq(drainSettled, false, "completion waits for the queued fence publication boundary");
	assertEq(runtime.sourceUnloadDrain?.state, "draining", "the source owner remains singular before publication");
	settleDrain();
	await Promise.resolve();
	await Promise.resolve();
	const drainTerminal = traceRecords.find(
		(record) => record.msg === "source-unload-drain-terminal",
	);
	const drainFenceRejected = traceRecords.find(
		(record) => record.msg === "source-unload-drain-fence-cas-rejected",
	);
	assertEq(
		drainTerminal === undefined
			? null
			: `${String(drainTerminal.details?.reason)}:${JSON.stringify(drainFenceRejected?.details ?? null)}`,
		null,
		"exact A completion never emits a source-drain terminal reason",
	);
	assertEq(drainSettled, true, "the exact A completion releases native unload");
	assertEq(drainRejected, false, "exact A completion never enters terminal recovery");
	assertEq(runtime.sourceUnloadDrain?.state, "fenced", "settled A input converts to one target-less fence");
	assertEq(
		runtime.cmGuard.snapshot().sourceUnloadDrain,
		null,
		"target-less fence consumes the CodeMirror drain owner",
	);
	assertEq(
		runtime.cmGuard.snapshot().targetSelectionFence,
		runtime.sourceUnloadDrain?.targetSelectionToken ?? null,
		"manager and CodeMirror retain the same single target-less token",
	);

	const closingGuard = runtime.cmGuard;
	assertEq(
		manager.reconcileManagedWorkspaceViews([], "test-58b-exact-close"),
		1,
		"exact workspace removal consumes the retained source owner",
	);
	assertEq(runtime.sourceUnloadDrain, null, "exact close releases the manager source-drain owner");
	assertEq(closingGuard.snapshot().targetSelectionFence, null, "exact close releases its target-less token");
	assertEq(closingGuard.snapshot().inert, true, "exact close leaves the retired CodeMirror guard inert");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 58c: ambiguous A input rejects unload and never creates replay authority ---");
{
	let recoveryPersistCalls = 0;
	let exportOffers = 0;
	let exportedContent: string | null = null;
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		handoffRecoveryActionHost: {
			chooseVerifiedExporter: async () => {
				exportOffers += 1;
				return async (content: string) => { exportedContent = content; };
			},
		},
	});
	Object.assign(binding.view, {
		data: "typing now",
		getViewData: () => binding.cm.state.doc.toString(),
	});
	type AmbiguousRuntime = {
		session: ManagedLeafSession;
		sourceUnloadDrain: {
			state: string;
			targetSelectionToken: object | null;
		} | null;
		emergencySaveFence: { isCurrent(): boolean } | null;
		cmGuard: {
			snapshot(): Readonly<{
				inert: boolean;
				gateClosed: boolean;
				targetSelectionFence: object | null;
			}>;
		} | null;
	};
	const internals = manager as unknown as {
		managedSessions: Map<string, AmbiguousRuntime>;
		beginSourceUnloadDrain(
			runtime: AmbiguousRuntime,
			sourceFile: unknown,
		): null | PromiseLike<void>;
		acceptSamePathInputRejection(
			runtime: AmbiguousRuntime,
			rejection: Readonly<{
				reservation: ManagedLeafInputStartReservation;
				cm: object;
				startDocument: object;
				finalDocument: object;
				reason: "input-result-ambiguous";
				samePathDispatch: Readonly<{
					batchStartDocument: object;
					nativeHistoryEpochBefore: number;
					nativeHistoryEpochAfter: number;
				}>;
			}>,
		): boolean;
		beginPathHandoff(
			view: unknown,
			targetFile: unknown,
			reason: string,
			provenance: "selected",
			sourceUnloadReceiptId: string,
		): boolean;
	};
	const runtime = internals.managedSessions.get("leaf-1");
	if (!runtime?.cmGuard) throw new Error("Expected managed ambiguous-input runtime");
	const source = runtime.session.displayedLineage;
	if (source.kind !== "known") throw new Error("Expected known source lineage");
	const sourceState = EditorState.create({ doc: source.document.toString() });
	const cmState = (binding.cm as unknown as { state: Record<string, unknown> }).state;
	(binding.cm as unknown as { state: Record<string, unknown> }).state = {
		...cmState,
		doc: sourceState.doc,
	};
	runtime.session = {
		...runtime.session,
		displayedLineage: {
			...source,
			document: sourceState.doc,
		},
	};
	const reserved = reserveManagedLeafInputStart(runtime.session, {
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		inputEpoch: 7,
		compositionEpoch: null,
	});
	if (!reserved.accepted || reserved.state.pendingInputStartReservation === null) {
		throw new Error("Expected ambiguous-input reservation");
	}
	const reservation = reserved.state.pendingInputStartReservation;
	runtime.session = reserved.state;
	const drain = internals.beginSourceUnloadDrain(runtime, source.file);
	if (drain === null) throw new Error("Ambiguous input must hold native unload");
	let drainOutcome = "pending";
	void Promise.resolve(drain).then(
		() => { drainOutcome = "fulfilled"; },
		() => { drainOutcome = "rejected"; },
	);
	assertEq(
		internals.acceptSamePathInputRejection(runtime, {
			reservation,
			cm: binding.cm,
			startDocument: sourceState.doc,
			finalDocument: sourceState.doc,
			reason: "input-result-ambiguous",
			samePathDispatch: {
				batchStartDocument: sourceState.doc,
				nativeHistoryEpochBefore: 0,
				nativeHistoryEpochAfter: 0,
			},
		}),
		true,
		"the reducer consumes the ambiguous predecessor exactly once",
	);
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assertEq(drainOutcome, "rejected", "ambiguous predecessor rejects native unload");
	assertEq(runtime.sourceUnloadDrain?.state, "terminal", "ambiguity retains a persistent terminal owner");
	assertEq(runtime.cmGuard.snapshot().gateClosed, true, "terminal ambiguity keeps fresh input fenced");
	assertEq(
		runtime.cmGuard.snapshot().targetSelectionFence,
		runtime.sourceUnloadDrain?.targetSelectionToken ?? null,
		"terminal ambiguity retains one manager-owned target-less token",
	);
	assertEq(runtime.emergencySaveFence?.isCurrent(), true, "terminal ambiguity blocks native saves");
	assertEq(recoveryPersistCalls, 0, "ambiguous input creates no hidden recovery persistence");
	assertEq(
		Reflect.has(internals, "orphanSamePathInputWatches"),
		false,
		"the old orphan replay registry no longer exists",
	);
	assertEq(exportOffers, 1, "terminal ambiguity offers one explicit verified export");
	assertEq(exportedContent, "typing now", "verified export receives only stable visible A bytes");
	const targetFile = { path: "Notes/ambiguous-input-B.md" };
	assertEq(
		internals.beginPathHandoff(
			binding.view,
			targetFile,
			"test-58c-ambiguous",
			"selected",
			"source-unload:ambiguous-must-not-exist",
		),
		false,
		"B selection cannot escape a rejected source-unload owner",
	);
	assertEq(runtime.session.handoff, null, "ambiguous A input mints no B handoff or replay context");

	const closingGuard = runtime.cmGuard;
	assertEq(
		manager.reconcileManagedWorkspaceViews([], "test-58c-exact-close"),
		1,
		"exact close consumes the terminal source owner",
	);
	assertEq(runtime.sourceUnloadDrain, null, "exact close releases the terminal manager owner");
	assertEq(closingGuard.snapshot().targetSelectionFence, null, "exact close releases the terminal token");
	assertEq(closingGuard.snapshot().inert, true, "exact close leaves the retired guard inert");
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

console.log("\n--- Test 60: plugin teardown releases only its exact emergency host-save owner ---");
{
	const runPluginTeardownCase = async (cmCanInert: boolean): Promise<void> => {
		const caseLabel = cmCanInert ? "settled-cm" : "blocked-cm";
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		installManagedGuardStubs: false,
	});
	let nativeRequestSaveCalls = 0;
	let nativeRunCalls = 0;
	let nativeFlushCalls = 0;
	let nativeSaveCalls = 0;
	const originalRequestSave = Object.assign(
		function requestSave(): void { nativeRequestSaveCalls += 1; },
		{
			cancel(): void {},
			run(): void { nativeRunCalls += 1; },
			flush(): void { nativeFlushCalls += 1; },
		},
	);
	const originalSave = async function save(): Promise<void> {
		nativeSaveCalls += 1;
	};
	const view = binding.view as unknown as {
		file: { path: string } | null;
		data: string;
		dirty: boolean;
		lastSavedData: string | null;
		getViewData(): string;
		onLoadFile(file: { path: string }): Promise<void>;
		onUnloadFile(file: { path: string }): Promise<void>;
		setViewData(data: string, clear: boolean): void;
		requestSave: typeof originalRequestSave;
		save: typeof originalSave;
	};
	view.data = "typing now";
	view.dirty = false;
	view.lastSavedData = "typing now";
	view.getViewData = function getViewData(): string { return this.data; };
	view.onLoadFile = async function onLoadFile(file): Promise<void> { this.file = file; };
	view.onUnloadFile = async function onUnloadFile(_file): Promise<void> {};
	view.setViewData = function setViewData(data, _clear): void { this.data = data; };
	view.requestSave = originalRequestSave;
	view.save = originalSave;

	type TeardownCmGuard = {
		refreshGate(): boolean;
		markInert(): boolean;
		restoreIfCurrent(): boolean;
		snapshot(): Record<string, unknown>;
	};
	type TeardownHostGuard = {
		acquireEmergencySaveFence(): Readonly<{
			view: unknown;
			refresh(): boolean;
			isCurrent(): boolean;
			release(): boolean;
		}>;
		beginBlockingHandoff(input: Readonly<{
			handoffGeneration: number;
			sourceLineagePath: string | null;
			targetPath: string;
		}>): void;
		markInert(): void;
		restoreIfCurrent(): void;
		snapshot(): Record<string, unknown>;
	};
	type TeardownRuntime = {
		session: ManagedLeafSession;
		hostGuard: TeardownHostGuard | null;
		emergencySaveFence: Readonly<{
			view: unknown;
			refresh(): boolean;
			isCurrent(): boolean;
			release(): boolean;
		}> | null;
		cmGuard: TeardownCmGuard | null;
	};
	type TeardownInternals = {
		vaultSync: unknown;
		managedSessions: Map<string, TeardownRuntime>;
		installManagedCmGuard(runtime: TeardownRuntime, cm: unknown): boolean;
	};
	const internals = manager as unknown as TeardownInternals;
	let cmInert = false;
	let cmMarkInertCalls = 0;
	let cmRestoreCalls = 0;
	internals.installManagedCmGuard = (runtime, cm) => {
		if (cm !== binding.cm) return false;
		runtime.cmGuard = {
			refreshGate: () => true,
			markInert: () => {
				cmMarkInertCalls += 1;
				if (!cmCanInert) return false;
				cmInert = true;
				return true;
			},
			restoreIfCurrent: () => {
				cmInert = true;
				cmRestoreCalls += 1;
				return true;
			},
			snapshot: () => ({
				view: binding.cm,
				inert: cmInert,
				gateClosed: !cmInert && runtime.session.handoff !== null,
				activeComposition: null,
				pendingHostLoadCandidate: null,
				commitState: "none",
			}),
		};
		return true;
	};
	manager.manageView(binding.view as never);
	const runtime = internals.managedSessions.get("leaf-1");
	const oldGuard = runtime?.hostGuard ?? null;
	if (!runtime || !oldGuard) throw new Error("Expected real managed guards for teardown owner test");
	let hostRestoreCalls = 0;
	const restoreOldHostGuard = oldGuard.restoreIfCurrent.bind(oldGuard);
	oldGuard.restoreIfCurrent = () => {
		hostRestoreCalls += 1;
		restoreOldHostGuard();
	};
	const targetFile = { path: `Notes/plugin-teardown-B-${caseLabel}.md` };
	view.file = targetFile;
	const selected = reduceManagedLeafSession(runtime.session, {
		type: "target-selected",
		sessionId: runtime.session.sessionId,
		expectedGeneration: runtime.session.generation,
		targetFile: targetFile as never,
		switchIntentSeq: runtime.session.eventOrderSeq + 1,
		sourceUnloadReceiptId: `source-unload:plugin-teardown:${caseLabel}`,
	});
	const detached = reduceManagedLeafSession(selected.state, {
		type: "detach-completed",
		sessionId: selected.state.sessionId,
		expectedGeneration: selected.state.generation,
		bindingEpochAfterDetach: 60,
	});
	if (!selected.accepted || !detached.accepted) {
		throw new Error("Expected an active A-to-B teardown handoff");
	}
	runtime.session = detached.state;
	oldGuard.beginBlockingHandoff({
		handoffGeneration: runtime.session.generation,
		sourceLineagePath: runtime.session.handoff?.sourceAuthorityPath ?? null,
		targetPath: targetFile.path,
	});
	const actualFence = oldGuard.acquireEmergencySaveFence();
	let emergencyReleaseCalls = 0;
	runtime.emergencySaveFence = Object.freeze({
		view: actualFence.view,
		refresh: () => actualFence.refresh(),
		isCurrent: () => actualFence.isCurrent(),
		release: () => {
			emergencyReleaseCalls += 1;
			return actualFence.release();
		},
	});

	assertEq(
		manager.unmanageView(binding.view as never, "ordinary-before-plugin-teardown"),
		false,
		"ordinary unmanage still rejects the active emergency owner",
	);
	assertEq(emergencyReleaseCalls, 0, "ordinary unmanage still releases no emergency owner");
	view.requestSave();
	view.requestSave.run();
	view.requestSave.flush();
	await view.save();
	assertEq(
		[nativeRequestSaveCalls, nativeRunCalls, nativeFlushCalls, nativeSaveCalls].join(","),
		"0,0,0,0",
		"all native save entry points remain blocked before teardown",
	);

	let replacementManager: EditorBindingManager | null = null;
	try {
		manager.revokeAsyncAuthority();
		assertEq(
			emergencyReleaseCalls,
			0,
			"async authority revocation retains the emergency owner across awaited teardown drains",
		);
		view.requestSave();
		view.requestSave.run();
		view.requestSave.flush();
		await view.save();
		assertEq(
			[nativeRequestSaveCalls, nativeRunCalls, nativeFlushCalls, nativeSaveCalls].join(","),
			"0,0,0,0",
			"native saves remain suppressed after revoke and before synchronous unbind",
		);
		manager.unbindAll();
		assertEq(emergencyReleaseCalls, 1, "plugin teardown releases the emergency owner exactly once");
		assertEq(hostRestoreCalls, 1, "plugin teardown restores the host save wrapper exactly once");
		assertEq(cmMarkInertCalls >= 1, true, "plugin teardown inerts the CodeMirror guard");
		assertEq(
			cmRestoreCalls,
			cmCanInert ? 1 : 0,
			cmCanInert
				? "plugin teardown restores a settled CodeMirror wrapper once"
				: "blocked CodeMirror teardown retains its reopen-required wrapper",
		);
		assertEq(
			internals.managedSessions.has("leaf-1"),
			!cmCanInert,
			cmCanInert
				? "plugin teardown removes the exact settled managed runtime"
				: "plugin teardown may retain the blocked CM runtime without retaining host save ownership",
		);
		assertEq(view.requestSave, originalRequestSave, "plugin teardown restores native requestSave identity");
		assertEq(view.save, originalSave, "plugin teardown restores native save identity");
		view.requestSave();
		view.requestSave.run();
		view.requestSave.flush();
		await view.save();
		assertEq(
			[nativeRequestSaveCalls, nativeRunCalls, nativeFlushCalls, nativeSaveCalls].join(","),
			"1,1,1,1",
			"restored native requestSave, run, flush, and save all delegate normally",
		);

		replacementManager = new EditorBindingManager(
			internals.vaultSync as never,
			false,
			(path) => path.endsWith(".md"),
		);
		replacementManager.manageView(binding.view as never);
		const replacementRuntime = (replacementManager as unknown as {
			managedSessions: Map<string, { hostGuard: TeardownHostGuard | null }>;
		}).managedSessions.get("leaf-1");
		assertEq(
			replacementRuntime?.hostGuard === oldGuard,
			false,
			"a new manager installs a fresh host guard instead of reusing the retired guard",
		);
	} finally {
		// RED cleanup also retires an owner left behind by a failing implementation.
		actualFence.release();
		oldGuard.markInert();
		oldGuard.restoreIfCurrent();
		replacementManager?.revokeAsyncAuthority();
		replacementManager?.unbindAll();
		if (!cmCanInert) {
			runtime.cmGuard = null;
			manager.unbindAll();
		}
		clearPendingHealthChecks(manager);
		if (replacementManager) clearPendingHealthChecks(replacementManager);
	}
	};
	await runPluginTeardownCase(true);
	await runPluginTeardownCase(false);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
