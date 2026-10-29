/**
 * Notice churn regression for frozen panes.
 *
 * 1. warnCmDegraded is time-floored: neither the degraded 5s idle-retry loop
 *    nor successful binds on other panes may re-show it inside the interval.
 * 2. notifyBindingEditorDivergence keeps its per-path cooldown but adds a
 *    vault-wide cap: many paused tabs must not stack one Notice per tab.
 *    Suppressed paths are summarized on the next globally-cooled emission.
 */
import { Notice } from "obsidian";
import { EditorBindingManager } from "../src/sync/editorBinding";

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

function buildManager(): {
	manager: EditorBindingManager;
	traces: Array<{ source: string; msg: string; details: unknown }>;
} {
	const traces: Array<{ source: string; msg: string; details: unknown }> = [];
	const vaultSync = {
		provider: null,
		remoteTextRevisions: null,
		getTextForPath: () => null,
		getFileId: () => null,
		getFileIdForText: () => undefined,
	};
	const manager = new EditorBindingManager(
		vaultSync as never,
		false,
		(p: string) => p.endsWith(".md"),
		(source: string, msg: string, details: unknown) => traces.push({ source, msg, details }),
	);
	return { manager, traces };
}

type NoticeInternals = {
	warnCmDegraded(leafId: string, path: string | null, source: string, attempts: number): void;
	notifyBindingEditorDivergence(path: string): void;
};

const realNow = Date.now;
let fakeNow = 1_000_000_000_000;
Date.now = () => fakeNow;

try {
	console.log("\n--- Test 1: warnCmDegraded is time-floored, not reset by other panes ---");
	{
		Notice.resetCalls();
		const { manager } = buildManager();
		const internals = manager as unknown as NoticeInternals;
		internals.warnCmDegraded("leaf-1", "Notes/a.md", "bind", 8);
		internals.warnCmDegraded("leaf-1", "Notes/a.md", "bind", 15);
		assert(Notice.calls.length === 1, "degraded resolution warns once within the floor");
		assert(
			Notice.calls[0]?.message.includes("still reconnecting") === true,
			"degraded notice keeps its message",
		);
		fakeNow += 6 * 60_000;
		internals.warnCmDegraded("leaf-1", "Notes/a.md", "bind", 30);
		assert(Notice.calls.length === 2, "a new episode after the floor may warn again");
		internals.warnCmDegraded("leaf-2", "Notes/b.md", "bind", 31);
		assert(Notice.calls.length === 2, "another pane within the floor stays silent");
	}

	console.log("\n--- Test 2: divergence per-path cooldown still applies ---");
	{
		Notice.resetCalls();
		const { manager } = buildManager();
		const internals = manager as unknown as NoticeInternals;
		internals.notifyBindingEditorDivergence("Notes/a.md");
		const firstCount = Notice.calls.length;
		assert(firstCount === 1, "first divergence path shows a notice");
		internals.notifyBindingEditorDivergence("Notes/a.md");
		assert(Notice.calls.length === 1, "same path within 60s does not re-show");
	}

	console.log("\n--- Test 3: vault-wide cap suppresses other paths and summarizes ---");
	{
		Notice.resetCalls();
		const { manager, traces } = buildManager();
		const internals = manager as unknown as NoticeInternals;
		internals.notifyBindingEditorDivergence("Notes/a.md");
		assert(Notice.calls.length === 1, "first path shows");
		internals.notifyBindingEditorDivergence("Notes/b.md");
		internals.notifyBindingEditorDivergence("Notes/c.md");
		assert(Notice.calls.length === 1, "other paths within the global cooldown are suppressed");
		assert(
			traces.some((t) => t.msg === "binding-divergence-notice-suppressed"),
			"suppression is traced",
		);
		fakeNow += 6 * 60_000;
		internals.notifyBindingEditorDivergence("Notes/d.md");
		assert(Notice.calls.length === 2, "after the global cooldown a new path shows");
		assert(
			Notice.calls[1]?.message.includes("2 other notes paused recently") === true,
			"suppressed paths are summarized in the next notice",
		);
		assert(
			Notice.calls[1]?.message.includes('"b.md"') === true,
			"suppressed note b.md name is included",
		);
		assert(
			Notice.calls[1]?.message.includes('"c.md"') === true,
			"suppressed note c.md name is included",
		);
	}

	console.log("\n--- Test 4: per-path cooldown suppresses within global window too ---");
	{
		Notice.resetCalls();
		const { manager } = buildManager();
		const internals = manager as unknown as NoticeInternals;
		internals.notifyBindingEditorDivergence("Notes/x.md");
		fakeNow += 90_000;
		internals.notifyBindingEditorDivergence("Notes/x.md");
		assert(Notice.calls.length === 1, "path cooldown (90s) passes but global cap still holds");
		fakeNow += 5 * 60_000;
		internals.notifyBindingEditorDivergence("Notes/x.md");
		assert(Notice.calls.length === 2, "path may re-show once both cooldowns have elapsed");
	}

	console.log("\n--- Test 5: classifyDivergenceOrigin recency windows for disk-modify and reconnect ---");
	{
		const { manager } = buildManager();
		const internals = manager as unknown as NoticeInternals & {
			classifyDivergenceOrigin(view: unknown, cm: unknown, path: string, ytext: unknown): string;
			lastExternalDiskMutationSequenceByPath: Map<string, number>;
			lastExternalDiskMutationAtByPath: Map<string, number>;
			vaultSync: { lastConnectedAt?: number };
		};

		// 1. External disk modify within 5000ms -> "recent-disk-modify"
		internals.lastExternalDiskMutationSequenceByPath.set("Notes/mod.md", 1);
		internals.lastExternalDiskMutationAtByPath.set("Notes/mod.md", fakeNow);
		assert(
			internals.classifyDivergenceOrigin(null, null, "Notes/mod.md", null) === "recent-disk-modify",
			"fresh external disk mutation classified as recent-disk-modify",
		);

		// After 6000ms, it falls through to "unknown"
		fakeNow += 6000;
		assert(
			internals.classifyDivergenceOrigin(null, null, "Notes/mod.md", null) === "unknown",
			"aged external disk mutation (>5s) falls back to unknown",
		);

		// 2. Reconnect within 5000ms -> "recent-reconnect"
		internals.vaultSync.lastConnectedAt = fakeNow;
		assert(
			internals.classifyDivergenceOrigin(null, null, "Notes/other.md", null) === "recent-reconnect",
			"fresh reconnect classified as recent-reconnect",
		);

		// After 6000ms, it falls through to "unknown"
		fakeNow += 6000;
		assert(
			internals.classifyDivergenceOrigin(null, null, "Notes/other.md", null) === "unknown",
			"aged reconnect (>5s) falls back to unknown",
		);
	}
} finally {
	Date.now = realNow;
}

if (failed > 0) {
	console.error(`\nnotice throttle: ${failed} FAILED, ${passed} passed`);
	process.exit(1);
}
console.log(`\nnotice throttle: ${passed} passed, 0 failed`);
