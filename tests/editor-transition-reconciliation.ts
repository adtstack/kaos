import { ReconciliationController } from "../src/runtime/reconciliationController";

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, message: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(
		`  FAIL  ${message}\n        expected=${String(expected)}\n        actual=${String(actual)}`,
	);
	failed++;
}

type TestController = ReconciliationController & {
	dirtyMarkdownPaths: Map<string, { reason: "create" | "modify"; notBeforeMs?: number }>;
	activeMarkdownIngests: Map<string, unknown>;
	interceptedExternalDiskMutations: Map<string, unknown>;
	pendingSupersededExternalDiskMutations: Map<string, unknown[]>;
	supersededExternalPreservationByPath: Map<string, Promise<{ kind: "preserved" }>>;
	editorTransitionSettlingPathCounts: Map<string, number>;
	markdownDrainPromise: Promise<void> | null;
	markdownDrainTimer: ReturnType<typeof setTimeout> | null;
	lifecycleGeneration: number;
	deps: {
		isMarkdownPathSyncable(path: string): boolean;
		getVaultSync(): { getTextForPath(path: string): unknown };
		trace(): void;
	};
	getPreservedUnresolvedMarkdownEntries(): unknown[];
	kickMarkdownDrain(): void;
	queueDirtyMarkdownPath(path: string, reason: "create" | "modify"): void;
	markMarkdownDirty(file: { path: string }, reason: "create" | "modify"): void;
	awaitEditorTransitionWork<T>(
		work: Promise<T>,
		deadline: number,
	): Promise<{ kind: "completed"; value: T } | { kind: "timed-out" }>;
};

function buildController(): {
	controller: TestController;
	texts: Map<string, unknown>;
} {
	const texts = new Map<string, unknown>();
	const controller = Object.create(ReconciliationController.prototype) as TestController;
	Object.assign(controller, {
		dirtyMarkdownPaths: new Map(),
		activeMarkdownIngests: new Map(),
		interceptedExternalDiskMutations: new Map(),
		pendingSupersededExternalDiskMutations: new Map(),
		supersededExternalPreservationByPath: new Map(),
		editorTransitionSettlingPathCounts: new Map(),
		markdownDrainPromise: null,
		markdownDrainTimer: null,
		lifecycleGeneration: 1,
		deps: {
			isMarkdownPathSyncable: (path: string) => path.endsWith(".md"),
			getVaultSync: () => ({ getTextForPath: (path: string) => texts.get(path) ?? null }),
			trace: () => {},
		},
		getPreservedUnresolvedMarkdownEntries: () => [],
		queueDirtyMarkdownPath(path: string, reason: "create" | "modify") {
			this.dirtyMarkdownPaths.set(path, { reason });
		},
	});
	return { controller, texts };
}

console.log("\n--- Editor transition reconciliation: recent-typing delay is bypassed only inside the gated drain ---");
{
	const path = "Notes/A.md";
	const { controller } = buildController();
	controller.dirtyMarkdownPaths.set(path, {
		reason: "modify",
		notBeforeMs: Date.now() + 3000,
	});
	let observedCount = 0;
	let observedNotBefore: number | undefined = -1;
	controller.kickMarkdownDrain = () => {
		controller.markdownDrainPromise = Promise.resolve().then(() => {
			observedCount = controller.editorTransitionSettlingPathCounts.get(path) ?? 0;
			observedNotBefore = controller.dirtyMarkdownPaths.get(path)?.notBeforeMs;
			controller.dirtyMarkdownPaths.delete(path);
		});
	};

	const settled = await controller.settleOpenExternalEditBeforeTransition(path);
	assertEq(settled, true, "A's queued disk work settles before unload");
	assertEq(observedCount, 1, "the recent-typing override is scoped to the active transition");
	assertEq(observedNotBefore, undefined, "the ordinary three-second defer is removed after input is gated");
	assertEq(
		controller.editorTransitionSettlingPathCounts.has(path),
		false,
		"the transition-only override is removed after settlement",
	);
}

console.log("\n--- Editor transition reconciliation: a missing B identity is seeded from B, never A ---");
{
	const sourcePath = "Notes/A.md";
	const targetPath = "Notes/B.md";
	const { controller, texts } = buildController();
	texts.set(sourcePath, { content: "A authority" });
	let admittedPath: string | null = null;
	let admittedReason: string | null = null;
	controller.markMarkdownDirty = (file, reason) => {
		admittedPath = file.path;
		admittedReason = reason;
		controller.dirtyMarkdownPaths.set(file.path, { reason });
	};
	controller.kickMarkdownDrain = () => {
		controller.markdownDrainPromise = Promise.resolve().then(() => {
			controller.dirtyMarkdownPaths.delete(targetPath);
			texts.set(targetPath, { content: "B disk authority" });
		});
	};

	const admitted = await controller.admitEditorTargetFromDisk({ path: targetPath } as never);
	assertEq(admitted, true, "B admission completes before target load");
	assertEq(admittedPath, targetPath, "the seed request is scoped to B's exact path");
	assertEq(admittedReason, "create", "a missing B identity uses the guarded create admission path");
	assertEq(
		(texts.get(sourcePath) as { content: string }).content,
		"A authority",
		"B admission leaves A's authority untouched",
	);
}

console.log("\n--- Editor transition reconciliation: unresolved external work fails closed ---");
{
	const path = "Notes/A.md";
	const { controller } = buildController();
	controller.interceptedExternalDiskMutations.set(path, { content: "external" });
	controller.kickMarkdownDrain = () => {
		controller.markdownDrainPromise = Promise.resolve().then(() => {
			controller.dirtyMarkdownPaths.delete(path);
			// Candidate deliberately remains unresolved, forcing another bounded pass.
		});
	};

	const settled = await controller.settleOpenExternalEditBeforeTransition(path);
	assertEq(settled, false, "the source note is not unloaded while an external candidate remains unresolved");
}

console.log("\n--- Editor transition reconciliation: awaited work obeys the settlement deadline ---");
{
	const { controller } = buildController();
	const never = new Promise<void>(() => undefined);
	const result = await controller.awaitEditorTransitionWork(never, Date.now() - 1);
	assertEq(result.kind, "timed-out", "an expired deadline cannot hang a note transition");
}

console.log(`\neditor-transition-reconciliation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
