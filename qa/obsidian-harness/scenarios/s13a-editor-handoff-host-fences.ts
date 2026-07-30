import { MarkdownView } from "obsidian";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
	EditorHandoffHostOperationDebugSnapshot,
} from "../../../src/runtime/engineControlPort";
import type {
	EditorHandoffExternalPhaseName,
	QaContext,
	QaScenario,
} from "../types";

export const EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID =
	"s13a-editor-handoff-host-fences";

export const EDITOR_HANDOFF_HOST_FENCE_PATHS = Object.freeze({
	a: "QA-handoff-fences-A.md",
	b: "QA-handoff-fences-B.md",
	c: "QA-handoff-fences-C.md",
});

const SAME_CONTENT = [
	"# Editor handoff host fences",
	"",
	...Array.from({ length: 48 }, (_, index) => `stable-line-${index + 1}`),
	"",
].join("\n");

type IntentEvidence = NonNullable<EditorHandoffManagedLeafDebugSnapshot["intent"]>;
type PhaseEvidence = Readonly<{
	leafId: string;
	sessionId: string;
	generation: number;
	viewPath: string | null;
	displayedPath: string | null;
	bindingPath: string | null;
	inputEpoch: number | null;
	compositionEpoch: number | null;
	nativeHistoryEpoch: number | null;
	selectionEpoch: number | null;
	scrollEpoch: number | null;
	editorLength: number | null;
	hostDataLength: number | null;
	intent: IntentEvidence | null;
	lastComposition: EditorHandoffManagedLeafDebugSnapshot["lastComposition"];
	sourceUnload: EditorHandoffManagedLeafDebugSnapshot["sourceUnload"];
	operation: EditorHandoffHostOperationDebugSnapshot | null;
}>;

const evidence = new Map<EditorHandoffExternalPhaseName, PhaseEvidence>();
let baselineHash: string | null = null;
let compositionSourceHash: string | null = null;

function activeView(ctx: QaContext, expectedPath: string): MarkdownView {
	const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== expectedPath) {
		throw new Error(`s13a: active MarkdownView is not ${expectedPath}`);
	}
	return view;
}

async function waitForSnapshot(
	ctx: QaContext,
	label: string,
	accept: (snapshot: EditorHandoffDebugSnapshot) => boolean,
	timeoutMs = 12_000,
): Promise<EditorHandoffDebugSnapshot> {
	const startedAt = Date.now();
	let last: EditorHandoffDebugSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		last = ctx.kaos.getContentFreeSnapshot();
		if (accept(last)) return last;
		await ctx.sleep(25);
	}
	throw new Error(`s13a: ${label} timed out; snapshot=${JSON.stringify(last)}`);
}

function leafFor(
	snapshot: EditorHandoffDebugSnapshot,
	predicate: (leaf: EditorHandoffManagedLeafDebugSnapshot) => boolean,
): EditorHandoffManagedLeafDebugSnapshot | null {
	return snapshot.leaves.find(predicate) ?? null;
}

function captureEvidence(
	name: EditorHandoffExternalPhaseName,
	leaf: EditorHandoffManagedLeafDebugSnapshot,
	operation: EditorHandoffHostOperationDebugSnapshot | null,
): void {
	evidence.set(name, Object.freeze({
		leafId: leaf.leafId,
		sessionId: leaf.sessionId,
		generation: leaf.generation,
		viewPath: leaf.viewPath,
		displayedPath: leaf.displayedPath,
		bindingPath: leaf.bindingPath,
		inputEpoch: leaf.inputEpoch,
		compositionEpoch: leaf.compositionEpoch,
		nativeHistoryEpoch: leaf.nativeHistoryEpoch,
		selectionEpoch: leaf.selectionEpoch,
		scrollEpoch: leaf.scrollEpoch,
		editorLength: leaf.editorLength,
		hostDataLength: leaf.hostDataLength,
		intent: leaf.intent,
		lastComposition: leaf.lastComposition,
		sourceUnload: leaf.sourceUnload,
		operation,
	}));
}

async function teardownManagedLeaf(ctx: QaContext): Promise<void> {
	for (const path of Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS)) {
		await ctx.closeFile(path).catch(() => {});
	}
	await waitForSnapshot(
		ctx,
		"managed leaf teardown",
		(snapshot) => snapshot.leaves.every((leaf) =>
			!Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS).includes(leaf.viewPath ?? "")
			&& !Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS).includes(leaf.displayedPath ?? "")
		),
	).catch(async (error) => {
		await ctx.sleep(250);
		throw error;
	});
}

async function prepareFreshA(ctx: QaContext): Promise<EditorHandoffManagedLeafDebugSnapshot> {
	await teardownManagedLeaf(ctx);
	await ctx.openFile(EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
	const view = activeView(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
	await waitForSnapshot(ctx, "supported managed host", (candidate) =>
		candidate.leaves.some((leaf) =>
			leaf.managed
			&& leaf.active
			&& leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& (
				leaf.hostCapability === "public-cancellable"
				|| leaf.hostCapability === "owned-scheduler-with-unload-flush"
			)
			&& leaf.hostCapabilityState === "ready"
			&& leaf.clearLoadCapability === "observable"
		),
	);
	await ctx.waitForCrdtBinding(EDITOR_HANDOFF_HOST_FENCE_PATHS.a, 12_000);
	view.editor.setCursor({ line: 24, ch: 4 });
	view.editor.scrollTo(null, 320);
	await ctx.sleep(50);
	const snapshot = await waitForSnapshot(
		ctx,
		"fresh A managed leaf",
		(candidate) => candidate.leaves.some((leaf) =>
			leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& leaf.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& leaf.cmId !== null
			&& leaf.saveGuardInstalled === false
		),
	);
	const leaf = leafFor(snapshot, (candidate) =>
		candidate.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
		&& candidate.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
	if (!leaf) throw new Error("s13a: fresh A leaf vanished");
	return leaf;
}

function armHeldHostSwitch(
	ctx: QaContext,
	targetPath: string,
): Readonly<{ leafId: string }> {
	const source = activeView(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
	const leafId = (source.leaf as unknown as { id?: string }).id;
	if (!leafId) throw new Error("s13a: active leaf has no stable ID");
	ctx.kaos.holdNextHostLoad(targetPath);
	return Object.freeze({ leafId });
}

async function finishCapturedInputPhase(
	ctx: QaContext,
	name: EditorHandoffExternalPhaseName,
	leafId: string,
): Promise<void> {
	const beforeRelease = await waitForSnapshot(ctx, `${name} intent capture`, (snapshot) => {
		const leaf = leafFor(snapshot, (candidate) => candidate.leafId === leafId);
		return snapshot.hostLoad?.state === "held" && leaf?.intent !== null;
	});
	const beforeLeaf = leafFor(beforeRelease, (leaf) => leaf.leafId === leafId);
	if (!beforeLeaf) throw new Error(`s13a: ${name} leaf vanished before release`);
	captureEvidence(name, beforeLeaf, beforeRelease.hostLoad);
	ctx.kaos.releaseHeldHostLoad();
	await waitForSnapshot(ctx, `${name} host continuation settlement`, (snapshot) =>
		snapshot.hostLoad?.state === "released"
		|| snapshot.hostLoad?.state === "rejected",
	);
	await teardownManagedLeaf(ctx);
}

function requireEvidence(name: EditorHandoffExternalPhaseName): PhaseEvidence {
	const item = evidence.get(name);
	if (!item) throw new Error(`s13a: missing evidence for ${name}`);
	return item;
}

function assertIntent(
	name: EditorHandoffExternalPhaseName,
	originKind: "user" | "ime",
	sequenceBegan: "before-handoff" | "after-target-selected",
): void {
	const intent = requireEvidence(name).intent;
	if (!intent) throw new Error(`s13a: ${name} did not capture an input intent`);
	if (
		intent.originKind !== originKind
		|| intent.sequenceBegan !== sequenceBegan
		|| intent.targetPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.b
		|| intent.startContentHash === intent.afterContentHash
	) {
		throw new Error(`s13a: ${name} captured the wrong content-free intent lineage`);
	}
}

export const s13aEditorHandoffHostFences: QaScenario = {
	id: EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID,
	title: "Path-scoped editor handoff host fences",
	tags: ["editor", "handoff", "host", "ime", "rapid-switch", "supported-host"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		evidence.clear();
		baselineHash = null;
		compositionSourceHash = null;
		// The supported-host gate is local and does not require a live provider,
		// but workspace management opens only after one reconciliation settles.
		await ctx.kaos.forceReconcile();
		await teardownManagedLeaf(ctx);
		for (const path of Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS)) {
			await ctx.deleteFile(path).catch(() => {});
			await ctx.createFile(path, SAME_CONTENT);
			await ctx.waitForCrdtFile(path, 12_000);
			await ctx.waitForDiskCrdtConverge(path, 12_000);
		}
		const hashes = await Promise.all(Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS)
			.map((path) => ctx.kaos.getDiskHash(path)));
		if (!hashes[0] || hashes.some((hash) => hash !== hashes[0])) {
			throw new Error("s13a: A/B/C must begin with identical bytes");
		}
		baselineHash = hashes[0];
	},

	async run(ctx): Promise<void> {
		// 1. A native save pins A at invocation entry while the host requests B;
		//    hosts may publish B only after that source save settles.
		const saveLeaf = await prepareFreshA(ctx);
		const saveView = activeView(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
		ctx.kaos.holdNextNativeSave(EDITOR_HANDOFF_HOST_FENCE_PATHS.a);
		const saveSettlement = saveView.save().then(
			() => "fulfilled" as const,
			() => "rejected" as const,
		);
		await waitForSnapshot(ctx, "held native A save", (snapshot) =>
			snapshot.nativeSave?.state === "held"
			&& snapshot.nativeSave.invocationPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& snapshot.nativeSave.leafId === saveLeaf.leafId,
		);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("save-entered-before-switch");
		await saveSettlement;
		const saved = await waitForSnapshot(ctx, "native A save settlement", (snapshot) =>
			snapshot.nativeSave?.state === "released"
			|| snapshot.nativeSave?.state === "rejected",
		);
		const savedLeaf = leafFor(saved, (leaf) => leaf.leafId === saveLeaf.leafId);
		if (!savedLeaf) throw new Error("s13a: save leaf vanished before evidence capture");
		captureEvidence("save-entered-before-switch", savedLeaf, saved.nativeSave);
		await teardownManagedLeaf(ctx);

		// 2. Physical ASCII begins after the target was selected and is quarantined.
		await prepareFreshA(ctx);
		const asciiSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("ascii-input-after-switch-intent");
		await finishCapturedInputPhase(
			ctx,
			"ascii-input-after-switch-intent",
			asciiSwitch.leafId,
		);

		// 3. A fully completed Korean IME sequence begins after target selection.
		await prepareFreshA(ctx);
		const completedImeSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("completed-ime-after-switch-intent");
		await finishCapturedInputPhase(
			ctx,
			"completed-ime-after-switch-intent",
			completedImeSwitch.leafId,
		);

		// 4. IME starts on A; the controller performs the real explorer click to B.
		const composingLeaf = await prepareFreshA(ctx);
		ctx.kaos.holdNextHostLoad(EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("ime-and-click-while-composing");
		const composingSnapshot = await waitForSnapshot(ctx, "composition click capture", (snapshot) => {
			const leaf = leafFor(snapshot, (candidate) => candidate.leafId === composingLeaf.leafId);
			return snapshot.hostLoad?.state === "held"
				&& leaf !== null
				&& (
					leaf.intent !== null
					|| (
						leaf.lastComposition !== null
						&& leaf.lastComposition.updates >= 2
						&& leaf.lastComposition.startGeneration === composingLeaf.generation
						&& leaf.lastComposition.endGeneration === composingLeaf.generation
						&& leaf.sourceUnload?.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
						&& leaf.sourceUnload.state === "settled"
						&& leaf.sourceUnload.forcedSaveObserved
					)
				);
		});
		const composingEvidence = leafFor(
			composingSnapshot,
			(leaf) => leaf.leafId === composingLeaf.leafId,
		);
		if (!composingEvidence) throw new Error("s13a: composing leaf vanished");
		captureEvidence(
			"ime-and-click-while-composing",
			composingEvidence,
			composingSnapshot.hostLoad,
		);
		const [compositionDiskHash, compositionCrdtHash] = await Promise.all([
			ctx.kaos.getDiskHash(EDITOR_HANDOFF_HOST_FENCE_PATHS.a),
			ctx.kaos.getCrdtHash(EDITOR_HANDOFF_HOST_FENCE_PATHS.a),
		]);
		if (
			!compositionDiskHash
			|| compositionDiskHash !== compositionCrdtHash
			|| compositionDiskHash === baselineHash
		) throw new Error("s13a: source composition did not settle identically to A disk and CRDT");
		compositionSourceHash = compositionDiskHash;
		ctx.kaos.releaseHeldHostLoad();
		await waitForSnapshot(ctx, "composition host continuation", (snapshot) =>
			snapshot.hostLoad?.state === "released"
			|| snapshot.hostLoad?.state === "rejected",
		);
		await teardownManagedLeaf(ctx);

		// 5. Physical input remains quarantined for the full held host-load interval.
		await prepareFreshA(ctx);
		const heldInputSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("input-while-host-load-held");
		await finishCapturedInputPhase(
			ctx,
			"input-while-host-load-held",
			heldInputSwitch.leafId,
		);

		// 6. The controller clicks C before releasing B's exact one-shot continuation.
		const supersessionLeaf = await prepareFreshA(ctx);
		ctx.kaos.holdNextHostLoad(
			EDITOR_HANDOFF_HOST_FENCE_PATHS.b,
			"clear-load",
		);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("supersede-b-with-c");
		const superseded = await waitForSnapshot(ctx, "B host continuation rejection", (snapshot) =>
			snapshot.hostLoad?.state === "rejected"
			&& snapshot.hostLoad.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& snapshot.leaves.some((leaf) =>
				leaf.leafId === supersessionLeaf.leafId
				&& leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.c
			),
		);
		const supersededLeaf = leafFor(
			superseded,
			(leaf) => leaf.leafId === supersessionLeaf.leafId,
		);
		if (!supersededLeaf) throw new Error("s13a: superseded leaf vanished");
		captureEvidence("supersede-b-with-c", supersededLeaf, superseded.hostLoad);
		await teardownManagedLeaf(ctx);
	},

	async assert(ctx): Promise<void> {
		const save = requireEvidence("save-entered-before-switch");
		if (
			save.operation?.invocationPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			|| save.operation.outcome === "pending"
			|| save.operation.path !== EDITOR_HANDOFF_HOST_FENCE_PATHS.a
		) throw new Error("s13a: native save lost its invocation-entry A identity");

		assertIntent("ascii-input-after-switch-intent", "user", "after-target-selected");
		assertIntent("completed-ime-after-switch-intent", "ime", "after-target-selected");
		assertIntent("input-while-host-load-held", "user", "after-target-selected");

		const composing = requireEvidence("ime-and-click-while-composing");
		const pathScopedIntent = composing.intent?.originKind === "ime"
			&& composing.intent.sequenceBegan === "before-handoff"
			&& composing.intent.targetPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& (composing.lastComposition?.updates ?? 0) >= 2
			&& composing.intent.compositionEpoch === composing.lastComposition?.compositionEpoch;
		const sourceSettledBeforeTarget = composing.intent === null
			&& (composing.lastComposition?.updates ?? 0) >= 2
			&& composing.lastComposition?.startGeneration === composing.lastComposition?.endGeneration
			&& composing.lastComposition.endGeneration < composing.generation
			&& composing.lastComposition.replayEligible === false
			&& composing.sourceUnload?.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& composing.sourceUnload.state === "settled"
			&& composing.sourceUnload.forcedSaveObserved;
		if (!pathScopedIntent && !sourceSettledBeforeTarget) {
			throw new Error("s13a: composition was neither B-scoped nor settled exactly to source A");
		}

		const superseded = requireEvidence("supersede-b-with-c");
		if (
			superseded.operation?.state !== "rejected"
			|| superseded.operation.path !== EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			|| superseded.viewPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.c
			|| superseded.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
		) throw new Error("s13a: superseded B completion crossed into C");

		if (!baselineHash) throw new Error("s13a: baseline hash was not captured");
		if (!compositionSourceHash) throw new Error("s13a: source composition hash was not captured");
		for (const path of Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS)) {
			const [diskHash, crdtHash] = await Promise.all([
				ctx.kaos.getDiskHash(path),
				ctx.kaos.getCrdtHash(path),
			]);
			const expectedHash = path === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
				? compositionSourceHash
				: baselineHash;
			if (diskHash !== expectedHash || crdtHash !== expectedHash) {
				throw new Error(
					`s13a: editor input escaped its exact path authority for ${path}; `
					+ `disk=${diskHash ?? "null"};crdt=${crdtHash ?? "null"};`
					+ `expected=${expectedHash};diskEqualsCrdt=${diskHash === crdtHash};`
					+ `diskEqualsBaseline=${diskHash === baselineHash};`
					+ `diskEqualsCompositionSource=${diskHash === compositionSourceHash}`,
				);
			}
		}
		await ctx.assert.noConflictCopies();
	},

	async cleanup(ctx): Promise<void> {
		await teardownManagedLeaf(ctx).catch(() => {});
		for (const path of Object.values(EDITOR_HANDOFF_HOST_FENCE_PATHS)) {
			await ctx.deleteFile(path).catch(() => {});
		}
		evidence.clear();
		baselineHash = null;
		compositionSourceHash = null;
	},
};
