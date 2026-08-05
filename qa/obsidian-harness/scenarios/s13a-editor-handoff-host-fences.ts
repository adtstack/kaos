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
import {
	EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION,
	EDITOR_HANDOFF_HOST_FENCE_PATHS,
	EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID,
} from "../../contracts/editor-handoff-host-fence";

export {
	EDITOR_HANDOFF_HOST_FENCE_PATHS,
	EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID,
};

const SAME_CONTENT = [
	"# Editor handoff host fences",
	"",
	...Array.from({ length: 48 }, (_, index) => `stable-line-${index + 1}`),
	"",
].join("\n");

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
	gateClosed: boolean;
	compositionActive: boolean;
	intent: EditorHandoffManagedLeafDebugSnapshot["intent"];
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
		gateClosed: leaf.gateClosed,
		compositionActive: leaf.compositionActive,
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

async function finishRejectedInputPhase(
	ctx: QaContext,
	name: EditorHandoffExternalPhaseName,
	leafId: string,
	options: Readonly<{
		targetOnlyPath?: string;
		verifyAfterRelease?: () => Promise<void>;
	}> = {},
): Promise<void> {
	const beforeRelease = await waitForSnapshot(ctx, `${name} input rejection`, (snapshot) => {
		const leaf = leafFor(snapshot, (candidate) => candidate.leafId === leafId);
		return snapshot.hostLoad?.state === "held"
			&& leaf?.gateClosed === true
			&& (
				options.targetOnlyPath === undefined
				|| (
					leaf.viewPath === options.targetOnlyPath
					&& leaf.displayedPath !== options.targetOnlyPath
					&& leaf.bindingPath !== options.targetOnlyPath
				)
			)
			&& leaf.intent === null
			&& leaf.compositionActive === false
			&& leaf.editorLength !== null
			&& leaf.editorLength === leaf.hostDataLength;
	});
	const beforeLeaf = leafFor(beforeRelease, (leaf) => leaf.leafId === leafId);
	if (!beforeLeaf) throw new Error(`s13a: ${name} leaf vanished before release`);
	captureEvidence(name, beforeLeaf, beforeRelease.hostLoad);
	ctx.kaos.releaseHeldHostLoad();
	await waitForSnapshot(ctx, `${name} host continuation settlement`, (snapshot) =>
		snapshot.hostLoad?.state === "released"
		|| snapshot.hostLoad?.state === "rejected",
	);
	await options.verifyAfterRelease?.();
	await teardownManagedLeaf(ctx);
}

async function waitForExactExternalTargetAdmission(
	ctx: QaContext,
	leafId: string,
): Promise<void> {
	const expected = EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION;
	const startedAt = Date.now();
	let last: Readonly<{
		leaf: EditorHandoffManagedLeafDebugSnapshot | null;
		activeViewPath: string | null;
		activeViewLeafId: string | null;
		activeEditorLength: number | null;
		activeEditorMatches: boolean;
		activeEditorHash: string | null;
	}> | null = null;
	while (Date.now() - startedAt < 20_000) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		const snapshot = ctx.kaos.getContentFreeSnapshot();
		const leaf = leafFor(snapshot, (candidate) => candidate.leafId === leafId);
		const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
		const activeViewLeafId = view
			? ((view.leaf as unknown as { id?: string }).id ?? null)
			: null;
		const activeEditorContent = view?.editor.getValue() ?? null;
		const activeEditorHash = await ctx.kaos.getEditorHash(
			EDITOR_HANDOFF_HOST_FENCE_PATHS.b,
		);
		last = Object.freeze({
			leaf,
			activeViewPath: view?.file?.path ?? null,
			activeViewLeafId,
			activeEditorLength: activeEditorContent?.length ?? null,
			activeEditorMatches: activeEditorContent === expected.content,
			activeEditorHash,
		});
		if (
			leaf?.active === true
			&& leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& leaf.displayedPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& leaf.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& leaf.gateClosed === false
			&& leaf.saveGuardInstalled === false
			&& leaf.intent === null
			&& activeViewLeafId === leafId
			&& view?.file?.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
			&& activeEditorContent === expected.content
			&& activeEditorHash === expected.sha256
		) return;
		await ctx.sleep(25);
	}
	throw new Error(
		"s13a: released/retried host load never admitted exact external B bytes on the "
		+ `same leaf; expectedHash=${expected.sha256};last=${JSON.stringify(last)}`,
	);
}

async function waitForExactExternalTargetConvergence(ctx: QaContext): Promise<void> {
	const expectedHash = EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.sha256;
	const startedAt = Date.now();
	let last: Readonly<{ diskHash: string | null; crdtHash: string | null }> | null = null;
	while (Date.now() - startedAt < 20_000) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		const [diskHash, crdtHash] = await Promise.all([
			ctx.kaos.getDiskHash(EDITOR_HANDOFF_HOST_FENCE_PATHS.b),
			ctx.kaos.getCrdtHash(EDITOR_HANDOFF_HOST_FENCE_PATHS.b),
		]);
		last = Object.freeze({ diskHash, crdtHash });
		if (diskHash === expectedHash && crdtHash === expectedHash) return;
		await ctx.sleep(25);
	}
	throw new Error(
		"s13a: external B did not converge to the shared Node-write contract; "
		+ `expectedHash=${expectedHash};last=${JSON.stringify(last)}`,
	);
}

function requireEvidence(name: EditorHandoffExternalPhaseName): PhaseEvidence {
	const item = evidence.get(name);
	if (!item) throw new Error(`s13a: missing evidence for ${name}`);
	return item;
}

function assertRejectedInput(name: EditorHandoffExternalPhaseName): void {
	const item = requireEvidence(name);
	if (
		item.intent !== null
		|| !item.gateClosed
		|| item.compositionActive
		|| item.editorLength === null
		|| item.editorLength !== item.hostDataLength
	) {
		throw new Error(`s13a: ${name} escaped the closed pre-target input fence`);
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

		// 2. Physical ASCII begins after target selection and is rejected before
		//    CodeMirror or host data can change.
		await prepareFreshA(ctx);
		const asciiSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("ascii-input-after-switch-intent");
		await finishRejectedInputPhase(
			ctx,
			"ascii-input-after-switch-intent",
			asciiSwitch.leafId,
		);

		// 3. A Korean IME attempt begins after target selection and is rejected
		//    before a composition epoch or editor mutation can begin.
		await prepareFreshA(ctx);
		const completedImeSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("completed-ime-after-switch-intent");
		await finishRejectedInputPhase(
			ctx,
			"completed-ime-after-switch-intent",
			completedImeSwitch.leafId,
		);

		// 4. IME starts on A; the controller performs the real explorer click to B.
		const composingLeaf = await prepareFreshA(ctx);
		ctx.kaos.holdNextHostLoad(EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("ime-and-click-while-composing");
		const composingSnapshot = await waitForSnapshot(ctx, "composition click source settlement", (snapshot) => {
			const leaf = leafFor(snapshot, (candidate) => candidate.leafId === composingLeaf.leafId);
			return snapshot.hostLoad?.state === "held"
				&& leaf?.intent === null
				&& leaf.lastComposition !== null
				&& leaf.lastComposition.updates >= 2
				&& leaf.lastComposition.startGeneration === composingLeaf.generation
				&& leaf.lastComposition.endGeneration === composingLeaf.generation
				&& leaf.lastComposition.replayEligible === false
				&& leaf.sourceUnload?.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
				&& leaf.sourceUnload.state === "settled"
				&& leaf.sourceUnload.forcedSaveObserved;
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

		// 5. A real Node fs write changes B while its native load is held. Physical
		//    input remains rejected, and the exact external B revision must settle
		//    after the transition without being replayed into A or dropped.
		await prepareFreshA(ctx);
		const heldInputSwitch = armHeldHostSwitch(ctx, EDITOR_HANDOFF_HOST_FENCE_PATHS.b);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("input-while-host-load-held");
		await finishRejectedInputPhase(
			ctx,
			"input-while-host-load-held",
			heldInputSwitch.leafId,
			{
				targetOnlyPath: EDITOR_HANDOFF_HOST_FENCE_PATHS.b,
				verifyAfterRelease: () => waitForExactExternalTargetAdmission(
					ctx,
					heldInputSwitch.leafId,
				),
			},
		);
		await waitForExactExternalTargetConvergence(ctx);

		// 6. The controller performs real rapid B then C explorer clicks. Synthetic
		//    host-load suspension is intentionally excluded here because Obsidian does
		//    not support a second file switch while its first native load is paused.
		const supersessionLeaf = await prepareFreshA(ctx);
		await ctx.awaitExternalPhase<EditorHandoffExternalPhaseName>("supersede-b-with-c");
		const superseded = await waitForSnapshot(ctx, "rapid successor C selection", (snapshot) =>
			snapshot.leaves.some((leaf) =>
				leaf.leafId === supersessionLeaf.leafId
				&& leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.c
				&& leaf.displayedPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.c
				&& leaf.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.c
				&& leaf.gateClosed === false
				&& leaf.saveGuardInstalled === false
				&& leaf.hostCapabilityState === "ready"
			),
		);
		const supersededLeaf = leafFor(
			superseded,
			(leaf) => leaf.leafId === supersessionLeaf.leafId,
		);
		if (!supersededLeaf) throw new Error("s13a: superseded leaf vanished");
		captureEvidence("supersede-b-with-c", supersededLeaf, null);
		await teardownManagedLeaf(ctx);
	},

	async assert(ctx): Promise<void> {
		const save = requireEvidence("save-entered-before-switch");
		if (
			save.operation?.invocationPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			|| save.operation.outcome === "pending"
			|| save.operation.path !== EDITOR_HANDOFF_HOST_FENCE_PATHS.a
		) throw new Error("s13a: native save lost its invocation-entry A identity");

		assertRejectedInput("ascii-input-after-switch-intent");
		assertRejectedInput("completed-ime-after-switch-intent");
		assertRejectedInput("input-while-host-load-held");

		const composing = requireEvidence("ime-and-click-while-composing");
		const sourceSettledBeforeTarget = composing.intent === null
			&& (composing.lastComposition?.updates ?? 0) >= 2
			&& composing.lastComposition?.startGeneration === composing.lastComposition?.endGeneration
			&& composing.lastComposition.endGeneration < composing.generation
			&& composing.lastComposition.replayEligible === false
			&& composing.sourceUnload?.path === EDITOR_HANDOFF_HOST_FENCE_PATHS.a
			&& composing.sourceUnload.state === "settled"
			&& composing.sourceUnload.forcedSaveObserved;
		if (!sourceSettledBeforeTarget) {
			throw new Error("s13a: composition did not settle exactly to source A before B");
		}

		const superseded = requireEvidence("supersede-b-with-c");
		if (
			superseded.viewPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.c
			|| superseded.displayedPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.c
			|| superseded.bindingPath !== EDITOR_HANDOFF_HOST_FENCE_PATHS.c
			|| superseded.gateClosed
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
				: path === EDITOR_HANDOFF_HOST_FENCE_PATHS.b
					? EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.sha256
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
