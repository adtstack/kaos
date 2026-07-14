import * as Y from "yjs";
import { EditorBindingManager } from "../src/sync/editorBinding";
import { ORIGIN_DISK_SYNC_RECOVER_BOUND } from "../src/sync/origins";
import { PRODUCT_EVENT_KIND } from "../src/observability/productEventKinds";
import { isMarkdownSyncable } from "../src/types";

let passed = 0;
let failed = 0;

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
}) {
	const flightEvents: Array<{ kind: string; data?: Record<string, unknown> }> = [];
	const path = "Notes/typing.md";
	const doc = new Y.Doc();
	const expectedText = doc.getText("expected");
	expectedText.insert(0, "server text");
	const facetText = doc.getText("facet");
	facetText.insert(0, "old server text");

	const providerAwareness = {
		provider: true,
		setLocalStateField: () => {},
	};
	const vaultSync = {
		provider: { awareness: providerAwareness },
		getTextForPath: (p: string) => (p === path ? expectedText : null),
		getFileId: () => "file-1",
		getFileIdForText: (text: Y.Text) => (text === expectedText ? "file-1" : "other-file"),
	};

	const cmDom = { isConnected: true };
	const cm = {
		dom: cmDom,
		hasFocus: true,
		state: {
			doc: {
				length: 10,
				toString: () => "typing now",
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
		file: { path },
		leaf: { id: "leaf-1" },
		containerEl: { contains: (node: unknown) => node === cmDom },
		editor: { getValue: () => "typing now" },
	};

	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p) => p.endsWith(".md"),
		undefined,
		(event) => {
			flightEvents.push({ kind: event.kind, data: event.data });
		},
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
	return { manager, binding, flightEvents };
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

console.log("\n--- Test 15: provider-origin patches that erase recent typing are blocked ---");
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

	assertEq(result !== transaction, true, "destructive provider-origin patch is replaced with a shield transaction");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		false,
		"binding is detached before the provider patch can erase recent typing",
	);

	await Promise.resolve();
	assertEq(binding.ytext.toString(), "typing now", "recent editor content is written back to CRDT after provider shield");
	assertEq(
		flightEvents.some((event) => event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied),
		true,
		"provider shield emits editor.authority_shield.applied",
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

console.log("\n--- Test 17: destructive patch without origin capture is blocked during recent typing ---");
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

	assertEq(result !== transaction, true, "missing-origin destructive patch is shielded during recent typing");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has(leafId),
		false,
		"binding is detached before a missing-origin patch can erase recent typing",
	);

	await Promise.resolve();
	assertEq(binding.ytext.toString(), "typing now", "editor authority is restored after missing-origin shield");
	assertEq(
		flightEvents.some((event) =>
			event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied &&
			event.data?.blockedOrigin === null
		),
		true,
		"missing-origin shield records blockedOrigin=null",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n--- Test 18: stale origin capture still falls back to recent-typing shield ---");
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

	assertEq(result !== transaction, true, "stale-origin destructive patch is shielded during recent typing");
	await Promise.resolve();
	assertEq(binding.ytext.toString(), "typing now", "editor authority is restored after stale-origin fallback shield");
	assertEq(
		flightEvents.some((event) =>
			event.kind === PRODUCT_EVENT_KIND.editorAuthorityShieldApplied &&
			event.data?.blockedOrigin === null
		),
		true,
		"stale-origin fallback records blockedOrigin=null",
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

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
