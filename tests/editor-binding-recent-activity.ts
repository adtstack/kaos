import * as Y from "yjs";
import { Annotation, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { YSyncConfig, ySyncFacet } from "y-codemirror.next";
import {
	EditorBindingManager,
	type InterceptedExternalDiskMutation,
} from "../src/sync/editorBinding";
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
import { normalizeEditorText } from "../src/utils/editorTextNormalization";

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

function buildManagerFixture(options: {
	lastEditorChangeAgeMs: number;
	lastEditorDocChangeAgeMs?: number | null;
	externalReloadGuardEnabled?: () => boolean;
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
	Object.assign(binding.view, {
		data: mergedContent,
		lastSavedData: externalContent,
	});
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

console.log("\n--- Test 24a: external disk lineage is complete, primitive, and immutable ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	const lineage = manager.captureExternalDiskMutationEditorAuthorityLineage(
		binding.path,
		[binding.view as never],
	);
	assertEq(lineage !== null, true, "a fully resolved open editor produces lineage proof");
	assertEq(Object.isFrozen(lineage), true, "lineage envelope is immutable");
	assertEq(Object.isFrozen(lineage?.views), true, "lineage view list is immutable");
	assertEq(Object.isFrozen(lineage?.views[0]), true, "lineage view snapshot is immutable");
	assertEq(lineage?.views[0]?.leafId, "leaf-1", "lineage keeps the exact leaf identity");
	assertEq(lineage?.views[0]?.cmId, "cm-1", "lineage keeps the exact CodeMirror identity");
	assertEq(
		"view" in (lineage?.views[0] ?? {}),
		false,
		"lineage contains no live MarkdownView reference",
	);
	assertEq(
		"cm" in (lineage?.views[0] ?? {}),
		false,
		"lineage contains no live EditorView reference",
	);
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

console.log("\n--- Test 25a: stale path bindings block late non-user projections ---");
{
	const { manager, binding } = buildManagerFixture({
		lastEditorChangeAgeMs: 10_000,
		lastEditorDocChangeAgeMs: 10_000,
	});
	binding.view.file = { path: "Notes/next.md" };
	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch({
		docChanged: true,
		startState: binding.cm.state,
		annotation: () => null,
		isUserEvent: () => false,
	});
	assertEq(result !== null, true, "late non-user projection is replaced by a detach effect");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		false,
		"stale path binding is removed before a late A projection can reach B",
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
