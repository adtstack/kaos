import * as Y from "yjs";
import { Annotation, EditorState, type TransactionSpec } from "@codemirror/state";
import { ySyncFacet } from "y-codemirror.next";
import { EditorBindingManager } from "../src/sync/editorBinding";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_RESTORE,
} from "../src/sync/origins";
import { PRODUCT_EVENT_KIND } from "../src/observability/productEventKinds";
import {
	buildTypingAwareness,
	KAOS_TYPING_AWARENESS_FIELD,
} from "../src/sync/remoteTypingGuard";
import { isMarkdownSyncable } from "../src/types";

let passed = 0;
let failed = 0;
let externalDiskMutationSequence = 0;

function externalDiskMutationNotice(
	path: string,
	content: string,
	mtime = Date.now(),
) {
	return {
		path,
		ctime: 1,
		mtime,
		size: new TextEncoder().encode(content).byteLength,
		sequence: ++externalDiskMutationSequence,
		observedAt: Date.now(),
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
}

function buildManagerFixture(options: {
	lastEditorChangeAgeMs: number;
	lastEditorDocChangeAgeMs?: number | null;
	externalReloadGuardEnabled?: () => boolean;
}) {
	const flightEvents: Array<{ kind: string; data?: Record<string, unknown> }> = [];
	const rejectedExternalReloads: Array<{ path: string; content: string }> = [];
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

	const view = {
		file: { path, stat: liveFileStat },
		leaf: { id: "leaf-1" },
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: { getValue: () => liveEditorContent },
	};

	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p) => p.endsWith(".md"),
		undefined,
		(event) => {
			flightEvents.push({ kind: event.kind, data: event.data });
		},
		undefined,
		undefined,
		(rejectedPath, content) => {
			rejectedExternalReloads.push({ path: rejectedPath, content });
		},
		options.externalReloadGuardEnabled,
	);
	const binding = {
		view,
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
	return {
		manager,
		binding,
		flightEvents,
		awarenessStates,
		rejectedExternalReloads,
		setLiveEditorContent: (content: string) => { liveEditorContent = content; },
		setLiveFileStat: (mtime: number, size: number) => {
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
	return liveCm;
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
		rejectedExternalReloads,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "external disk replacement"),
	);
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
	assertEq(rejectedExternalReloads.length, 1, "external candidate is handed to conflict preservation");
	assertEq(
		rejectedExternalReloads[0]?.content,
		"external disk replacement",
		"conflict preservation receives the exact external bytes",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3b: exact content correlation handles mixed EOL without size false positives ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const rawExternal = "line one\r\nline two\n";
	const normalizedExternal = "line one\nline two\n";
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, rawExternal),
	);
	const transaction = {
		docChanged: true,
		startState: binding.cm.state,
		newDoc: { toString: () => normalizedExternal },
		annotation: () => undefined,
		isUserEvent: () => false,
	};
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(Array.isArray(result), true, "mixed LF/CRLF external reload is blocked by exact normalized content");
	assertEq(
		rejectedExternalReloads[0]?.content,
		rawExternal,
		"conflict preservation receives the exact mixed-EOL disk representation",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c: same-size unrelated plugin edit is never a disk reload ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
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
	assertEq(rejectedExternalReloads.length, 0, "unrelated plugin content is not mislabeled as external");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c2: filter:false cannot bypass an exact external reload guard ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
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
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, externalContent),
	);
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
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
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
		"filter:false external reload is reverted by exact post-update CAS",
	);
	assertEq(rejectedExternalReloads.length, 1, "filter bypass preserves the exact external candidate");
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"rejected filter:false reload never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3c3: a later transaction filter cannot resurrect an external reload ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
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
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, externalContent),
	);
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
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, externalContent);
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
		"resurrected external reload is reverted by exact post-update CAS",
	);
	assertEq(
		rejectedExternalReloads.length,
		1,
		"resurrected external bytes are preserved exactly once",
	);
	assertEq(
		afterTicket.views[0]!.editorAuthorityRevision,
		beforeTicket.views[0]!.editorAuthorityRevision,
		"resurrected external reload never becomes editor authority",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a3d: event order survives delayed exact-content proof ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
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
	setLiveFileStat(coarseMtime, new TextEncoder().encode(externalContent).byteLength);
	const notice = externalDiskMutationNotice(binding.path, externalContent, coarseMtime);
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
	manager.noteExternalDiskMutation(notice);

	assertEq(binding.ytext.toString(), "typing now", "synchronous event sequence restores editor authority");
	assertEq(rejectedExternalReloads.length, 1, "delayed proof still preserves the exact external version");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a4: disk marker never blocks a Y.Text/provider patch ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "disk candidate"),
	);
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
	assertEq(rejectedExternalReloads.length, 0, "provider patch is not preserved as a disk conflict");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a4b: provider advance does not open a disk-reload bypass ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "external disk replacement"),
	);
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
	assertEq(rejectedExternalReloads.length, 1, "external disk candidate is still preserved");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a5: late external event uses exact CAS rollback ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
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
	setLiveFileStat(externalMtime, 25);
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
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(
			binding.path,
			"late external replacement",
			externalMtime,
		),
	);

	assertEq(binding.ytext.toString(), "typing now", "exact unchanged Y.Text is restored to editor authority");
	assertEq(rejectedExternalReloads.length, 1, "late external candidate is preserved exactly once");
	assertEq(
		rejectedExternalReloads[0]?.content,
		"late external replacement",
		"late-order preservation keeps the external candidate",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a6: coarse-mtime plugin autosave cannot roll back or poison later edits ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
		setLiveEditorContent,
		setLiveFileStat,
	} = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const coarseMtime = Math.floor(Date.now() / 1000) * 1000;
	setLiveFileStat(coarseMtime, 10);
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
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "plugin now", coarseMtime),
	);

	assertEq(
		binding.ytext.toString(),
		"plugin now",
		"ambiguous coarse-mtime autosave keeps the plugin editor change",
	);
	assertEq(rejectedExternalReloads.length, 0, "normal autosave creates no external conflict copy");
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
		rejectedExternalReloads,
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
	setLiveFileStat(externalMtime, 18);
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
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "external candidate", externalMtime),
	);

	assertEq(
		binding.ytext.toString(),
		"newer provider authority",
		"newer provider content survives a stale late-order rollback candidate",
	);
	assertEq(rejectedExternalReloads.length, 1, "stale rollback candidate is preserved without rollback");
	assertEq(
		rejectedExternalReloads[0]?.content,
		"external candidate",
		"provider advance cannot discard the proven external bytes",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a8: user input cannot poison or erase exact external correlation ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 100,
		lastEditorDocChangeAgeMs: 100,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, "disk state"),
	);
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
	assertEq(rejectedExternalReloads.length, 0, "unrelated post-input content is not classified as external");
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
	assertEq(rejectedExternalReloads.length, 1, "the delayed exact external candidate is preserved");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a8b: user input during delayed proof keeps both newer authority and external bytes ---");
{
	const {
		manager,
		binding,
		rejectedExternalReloads,
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
	setLiveFileStat(coarseMtime, new TextEncoder().encode(externalContent).byteLength);
	const notice = externalDiskMutationNotice(binding.path, externalContent, coarseMtime);
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
	assertEq(rejectedExternalReloads.length, 1, "late proof still preserves the external candidate");
	assertEq(
		rejectedExternalReloads[0]?.content,
		externalContent,
		"late preservation keeps the exact external bytes",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a9: out-of-order exact reads cannot replace a newer marker ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const older = externalDiskMutationNotice(binding.path, "older external");
	const newer = externalDiskMutationNotice(binding.path, "newer external");
	manager.beginExternalDiskMutation(binding.path, older.sequence);
	manager.beginExternalDiskMutation(binding.path, newer.sequence);
	manager.noteExternalDiskMutation(newer);
	manager.noteExternalDiskMutation(older);

	const pending = (manager as unknown as {
		pendingExternalDiskMutations: Map<string, { content: string | null }>;
	}).pendingExternalDiskMutations.get(binding.path);
	assertEq(pending?.content, "newer external", "older async completion cannot replace the newer marker");
	assertEq(rejectedExternalReloads.length, 1, "older proven external bytes are preserved off-path");
	assertEq(rejectedExternalReloads[0]?.content, "older external", "stale completion preserves its exact bytes");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a10: an old async proof cannot cross close and reopen ---");
{
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const notice = externalDiskMutationNotice(binding.path, "external before reopen");
	manager.beginExternalDiskMutation(binding.path, notice.sequence);
	manager.unbind(binding.view as never);
	// Model a new binding lifetime on the same path before the old read resolves.
	(manager as unknown as { bindings: Map<string, unknown> }).bindings.set("leaf-1", binding);
	manager.noteExternalDiskMutation(notice);

	const pending = (manager as unknown as {
		pendingExternalDiskMutations: Map<string, unknown>;
	}).pendingExternalDiskMutations.get(binding.path);
	assertEq(pending, undefined, "old proof cannot arm the reopened editor binding");
	assertEq(rejectedExternalReloads.length, 1, "the exact old candidate is still preserved");
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 19a11: always policy bypasses an already pending guard ---");
{
	let guardEnabled = true;
	const { manager, binding, rejectedExternalReloads } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
		externalReloadGuardEnabled: () => guardEnabled,
	});
	binding.ytext.delete(0, binding.ytext.length);
	binding.ytext.insert(0, "typing now");
	const externalContent = "allowed by always";
	manager.noteExternalDiskMutation(
		externalDiskMutationNotice(binding.path, externalContent),
	);
	guardEnabled = false;
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

	assertEq(result, transaction, "always policy lets the pending external reload continue");
	assertEq(rejectedExternalReloads.length, 0, "always policy creates no rejected-reload artifact");
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
		true,
		"a fresh ticket is valid after the pre-bind input",
	);
	assertEq(
		(manager.getLastEditorActivityForPath(path) ?? 0) > 0,
		true,
		"pre-bind input is carried to path activity when the view is resolved",
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
	assertEq(staleDispatches, 0, "stale CM is not reconfigured");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.get("leaf-1"),
		binding,
		"rejected stale apply leaves the previous binding untouched",
	);
	nextDoc.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 29: rapid same-leaf switch binds the replacement without moving selection ---");
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
	binding.view.file = { path: nextPath };
	binding.view.editor = { getValue: () => nextContent };
	binding.view.containerEl = {
		contains: (node: unknown) => node === oldDom || node === newDom,
	};
	const known = (manager as unknown as { knownCmViews: Set<unknown> }).knownCmViews;
	known.add(binding.cm);
	known.add(replacementCm);
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
	assertEq(rebound?.path, nextPath, "rapid switch binds the new file path");
	assertEq(rebound?.cm, replacementCm, "rapid switch binds the focused replacement CM");
	assertEq(rebound?.settleWindowMs, 1600, "rapid switch activates the extended settle window");
	assertEq(oldDispatches, 1, "old CM is detached exactly once");
	assertEq(replacementTransactions.length, 1, "replacement CM is configured exactly once");
	assertEq(replacementTransactions[0]?.docChanged, false, "binding reconfigure does not change document bytes");
	assertEq(replacementTransactions[0]?.scrollIntoView, false, "binding reconfigure does not request scrolling");
	assertEq(replacementState.selection.main.anchor, 1100, "selection anchor survives binding reconfigure");
	assertEq(replacementState.selection.main.head, 1125, "selection head survives binding reconfigure");
	assertEq(scrollDOM.scrollTop, 840, "binding reconfigure leaves scrollTop untouched");
	assertEq(replacementState.facet(ySyncFacet)?.ytext, nextText, "replacement CM receives the new file Y.Text");
	nextDoc.destroy();
	clearPendingHealthChecks(manager);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
