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

function makeFixture(initialPath: string) {
	const view = Object.assign(new MarkdownView(), {
		file: { path: initialPath },
		leaf: { id: "leaf-1" },
	});
	const leaves = [{ view }];
	const boundPaths: string[] = [];
	const openedPaths: string[] = [];
	const editorBindings = {
		getBindingDebugInfoForView: () => null,
		getBindingHealthForView: () => null,
		bind: (candidateView: { file?: { path?: string } }) => {
			boundPaths.push(candidateView.file?.path ?? "missing");
		},
		unbind: () => {},
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
		isMarkdownPathSyncable: (path) => path.endsWith(".md"),
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
	});
	return { orchestrator, view, boundPaths, openedPaths };
}

console.log("\n--- Test 1: file-open revalidates after MarkdownView path adoption ---");
{
	const fixture = makeFixture("Notes/A.md");
	fixture.orchestrator.onFileOpen("Notes/B.md");
	assertEq(fixture.boundPaths.length, 0, "early file-open does not bind B through A's view");
	fixture.view.file = { path: "Notes/B.md" };
	await Promise.resolve();
	assertEq(fixture.boundPaths.join(","), "Notes/B.md", "settled callback binds the adopted B path");
	assertEq(fixture.openedPaths.join(","), "Notes/B.md", "settled bind starts B's disk observer");
}

console.log("\n--- Test 2: layout validation binds an otherwise missed open view ---");
{
	const fixture = makeFixture("Notes/layout.md");
	fixture.orchestrator.onLayoutChange();
	assertEq(fixture.boundPaths.join(","), "Notes/layout.md", "layout change validates missing bindings");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) process.exit(1);
