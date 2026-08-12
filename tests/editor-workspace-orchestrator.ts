import { MarkdownView } from "obsidian";
import { EditorWorkspaceOrchestrator } from "../src/runtime/editorWorkspaceOrchestrator";

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function makeFixture(
	initialPath: string,
	isSyncable: (path: string) => boolean = (path) => path.endsWith(".md"),
) {
	let leafStatePath = initialPath;
	const operationOrder: string[] = [];
	const view = Object.assign(new MarkdownView(), {
		file: { path: initialPath },
		leaf: {
			id: "leaf-1",
			getViewState: () => ({ state: { file: leafStatePath } }),
		},
	});
	const leaves = [{ view }];
	const boundPaths: string[] = [];
	const transitionTargets: string[] = [];
	const cancelledTransitions: string[] = [];
	const unbindPreserveFlags: boolean[] = [];
	const openedPaths: string[] = [];
	const editorBindings = {
		getBindingDebugInfoForView: () => null,
		getBindingHealthForView: () => null,
		bind: (candidateView: { file?: { path?: string } }) => {
			operationOrder.push(`bind:${candidateView.file?.path ?? "missing"}`);
			boundPaths.push(candidateView.file?.path ?? "missing");
		},
		unbind: (_view: MarkdownView, preserveTransition = false) => {
			unbindPreserveFlags.push(preserveTransition);
		},
		beginFileTransition: (_view: MarkdownView, targetPath: string) => {
			transitionTargets.push(targetPath);
		},
		cancelFileTransition: (_view: MarkdownView, _target?: string, reason?: string) => {
			cancelledTransitions.push(reason ?? "cancelled");
			return true;
		},
		pruneFileTransitionFences: () => {
			operationOrder.push("prune");
			return 0;
		},
		auditBindings: () => 0,
		clearLocalCursor: () => {},
	};
	const workspace = {
		iterateAllLeaves: (callback: (leaf: { view: MarkdownView }) => void) => {
			for (const leaf of leaves) callback(leaf);
		},
		getActiveViewOfType: () => view,
	};
	const orchestrator = new EditorWorkspaceOrchestrator({
		app: { workspace } as never,
		getSettings: () => ({ deviceName: "test-device" }) as never,
		getEditorBindings: () => editorBindings as never,
		getDiskMirror: () => ({
			notifyFileOpened: (path: string) => openedPaths.push(path),
			notifyFileClosed: () => {},
		}) as never,
		isMarkdownPathSyncable: isSyncable,
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});
	return {
		orchestrator,
		view,
		boundPaths,
		transitionTargets,
		cancelledTransitions,
		unbindPreserveFlags,
		openedPaths,
		operationOrder,
		setLeafStatePath: (path: string) => { leafStatePath = path; },
	};
}

console.log("\n--- Test 1: file-open revalidates after MarkdownView path adoption ---");
{
	const fixture = makeFixture("Notes/A.md");
	fixture.setLeafStatePath("Notes/B.md");
	fixture.orchestrator.onFileOpen("Notes/B.md");
	assertEq(
		fixture.transitionTargets.join(","),
		"Notes/B.md",
		"file-open fences the announced B target before view adoption",
	);
	assertEq(fixture.boundPaths.length, 0, "early file-open does not bind B through A's view");
	fixture.view.file = { path: "Notes/B.md" };
	await Promise.resolve();
	assertEq(fixture.boundPaths.join(","), "Notes/B.md", "settled callback binds the adopted B path");
	assertEq(fixture.openedPaths.join(","), "Notes/B.md", "settled bind starts B's disk observer");
}

console.log("\n--- Test 1b: embedded file-open does not fence the containing note ---");
{
	const fixture = makeFixture("Notes/outer.md");
	fixture.orchestrator.onFileOpen("Notes/embedded.md");
	assertEq(
		fixture.transitionTargets.length,
		0,
		"an embed event cannot start a transition on the outer MarkdownView",
	);
	assertEq(
		fixture.cancelledTransitions.length,
		0,
		"an embed event cannot cancel an unrelated outer-note transition",
	);
	await Promise.resolve();
}

console.log("\n--- Test 1c: an excluded source preserves its syncable target fence ---");
{
	const fixture = makeFixture(
		"Local/excluded.md",
		(path) => path === "Notes/B.md",
	);
	fixture.setLeafStatePath("Notes/B.md");
	fixture.orchestrator.onFileOpen("Notes/B.md");
	await Promise.resolve();
	assertEq(
		fixture.transitionTargets.join(","),
		"Notes/B.md",
		"the syncable target starts its transition while excluded A is visible",
	);
	assertEq(
		fixture.unbindPreserveFlags.every(Boolean),
		true,
		"excluded-source cleanup preserves the announced target transition",
	);
}

console.log("\n--- Test 2: layout validation binds an otherwise missed open view ---");
{
	const fixture = makeFixture("Notes/layout.md");
	fixture.orchestrator.onLayoutChange();
	assertEq(fixture.boundPaths.join(","), "Notes/layout.md", "layout change validates missing bindings");
	assertEq(
		fixture.operationOrder.slice(0, 2).join(","),
		"prune,bind:Notes/layout.md",
		"expired transition cleanup runs before the current-path bind attempt",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) process.exit(1);
