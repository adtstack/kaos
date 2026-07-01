import * as Y from "yjs";
import { EditorBindingManager } from "../src/sync/editorBinding";
import { ORIGIN_DISK_SYNC_RECOVER_BOUND } from "../src/sync/origins";
import { PRODUCT_EVENT_KIND } from "../src/observability/productEventKinds";

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

	const providerAwareness = { provider: true };
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

console.log("\n--- Test 3: fresh binding without document edits may repair immediately ---");
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

console.log("\n--- Test 4: remote-style editor transactions do not count as user activity ---");
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

console.log("\n--- Test 5: user input transactions update recent activity ---");
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

console.log("\n--- Test 6: local repair patches are blocked during recent user typing ---");
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

console.log("\n--- Test 7: provider-origin patches are not blocked by the local repair shield ---");
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
		newDoc: { toString: () => "remote collaborator content" },
		annotation: () => undefined,
		isUserEvent: () => false,
	};

	const result = (manager as unknown as {
		filterRiskyNonUserPatch: (transaction: unknown) => unknown;
	}).filterRiskyNonUserPatch(transaction);

	assertEq(result, transaction, "provider-origin remote patch is allowed through");
	assertEq(
		(manager as unknown as { bindings: Map<string, unknown> }).bindings.has("leaf-1"),
		true,
		"binding remains attached for provider-origin updates",
	);
	clearPendingHealthChecks(manager);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
