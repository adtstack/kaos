import { MarkdownView } from "obsidian";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffReplayQaObservation,
} from "../../../src/runtime/engineControlPort";
import {
	EXACT_HANDOFF_REPLAY_ALL_PATHS,
	EXACT_HANDOFF_REPLAY_PATHS,
	EXACT_HANDOFF_REPLAY_PHASES,
	EXACT_HANDOFF_REPLAY_SCENARIO_ID,
	type ExactHandoffReplayExternalPhase,
} from "../../contracts/exact-handoff-replay";
import type { QaContext, QaScenario } from "../types";

const LONG_IDENTICAL_BASE = [
	"# Exact editor handoff replay",
	"",
	...Array.from({ length: 96 }, (_, index) => `stable-line-${index + 1}`),
	"",
].join("\n");

const DIFFERENT_TARGET_BASE = [
	"# Exact editor handoff replay",
	"",
	...Array.from({ length: 96 }, (_, index) => `different-line-${index + 1}`),
	"",
].join("\n");

type PhaseEvidence = Readonly<{
	before: EditorHandoffReplayQaObservation;
	after: EditorHandoffReplayQaObservation;
	disk: Readonly<Record<"a" | "b" | "c", string | null>>;
	crdt: Readonly<Record<"a" | "b" | "c", string | null>>;
	attentionCount: number;
	conflictArtifactCount: number;
}>;

type RiskCounts = Pick<PhaseEvidence, "attentionCount" | "conflictArtifactCount">;

const evidence = new Map<ExactHandoffReplayExternalPhase, PhaseEvidence>();
const initialHashes = new Map<string, string>();
let asciiRecoveredHash: string | null = null;
let missingTargetSuspensionPrevious: boolean | null = null;
let initialVaultFileCount = 0;
let baselineRiskCounts: RiskCounts = Object.freeze({
	attentionCount: 0,
	conflictArtifactCount: 0,
});

function captureRiskCounts(ctx: QaContext): RiskCounts {
	const statusText = Array.from(document.querySelectorAll(".status-bar-item"))
		.map((item) => item.textContent?.trim() ?? "")
		.find((text) => text.startsWith("KAOS:"));
	if (statusText === undefined) {
		throw new Error("unsupported-host:KAOS status-bar observation unavailable");
	}
	const attentionMatch = statusText.match(/\b(\d+) files? need attention\b/);
	const conflictArtifactCount = ctx.app.vault.getFiles().filter(({ path }) =>
		path.includes(" (conflict")
		|| path.includes(".conflict.")
		|| /\s\([^)]+conflicted copy[^)]*\)/.test(path)
	).length;
	return Object.freeze({
		attentionCount: attentionMatch ? Number(attentionMatch[1]) : 0,
		conflictArtifactCount,
	});
}

function assertNoRiskCounts(label: string, counts: RiskCounts): void {
	if (
		counts.attentionCount !== baselineRiskCounts.attentionCount
		|| counts.conflictArtifactCount !== baselineRiskCounts.conflictArtifactCount
	) {
		throw new Error(
			`s13d: ${label} changed risk counts ` +
			`attention=${baselineRiskCounts.attentionCount}->${counts.attentionCount}, ` +
			`conflict=${baselineRiskCounts.conflictArtifactCount}->${counts.conflictArtifactCount}`,
		);
	}
}

async function assertSupportedManagedHost(ctx: QaContext, path: string): Promise<void> {
	await waitForContentFreeSnapshot(ctx, "supported managed host", (snapshot) =>
		snapshot.leaves.some((leaf) =>
			leaf.managed
			&& leaf.active
			&& leaf.viewPath === path
			&& (
				leaf.hostCapability === "public-cancellable"
				|| leaf.hostCapability === "owned-scheduler-with-unload-flush"
			)
			&& leaf.hostCapabilityState === "ready"
			&& leaf.clearLoadCapability === "observable"
		),
	);
}

function activeView(ctx: QaContext, path: string): MarkdownView {
	const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== path) {
		throw new Error(`s13d: active MarkdownView is not ${path}`);
	}
	return view;
}

async function waitForContentFreeSnapshot(
	ctx: QaContext,
	label: string,
	accept: (snapshot: EditorHandoffDebugSnapshot) => boolean,
	timeoutMs = 20_000,
): Promise<EditorHandoffDebugSnapshot> {
	const startedAt = Date.now();
	let last: EditorHandoffDebugSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		last = ctx.kaos.getContentFreeSnapshot();
		if (accept(last)) return last;
		await ctx.sleep(25);
	}
	throw new Error(`s13d: ${label} timed out; snapshot=${JSON.stringify(last)}`);
}

async function waitForCrdtAbsent(ctx: QaContext, path: string): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 12_000) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		if (await ctx.kaos.getCrdtHash(path) === null) return;
		await ctx.sleep(25);
	}
	throw new Error(`s13d: CRDT/Y.Text remained present for ${path}`);
}

async function closeExactReplayLeaves(ctx: QaContext): Promise<void> {
	for (const path of EXACT_HANDOFF_REPLAY_ALL_PATHS) {
		await ctx.closeFile(path).catch(() => undefined);
	}
}

async function prepareFreshSource(
	ctx: QaContext,
	phase: Exclude<ExactHandoffReplayExternalPhase, "native-undo" | "native-redo">,
): Promise<EditorHandoffReplayQaObservation> {
	const paths = EXACT_HANDOFF_REPLAY_PATHS[phase];
	await closeExactReplayLeaves(ctx);
	await ctx.openFile(paths.a);
	activeView(ctx, paths.a);
	await assertSupportedManagedHost(ctx, paths.a);
	await ctx.waitForCrdtBinding(paths.a, 12_000);
	const snapshot = await waitForContentFreeSnapshot(ctx, `${phase} source binding`, (candidate) =>
		candidate.leaves.some((leaf) =>
			leaf.viewPath === paths.a
			&& leaf.bindingPath === paths.a
			&& leaf.cmId !== null
		),
	);
	ctx.kaos.holdNextHostLoad(
		paths.b,
		phase === "supersede-b-with-c" ? "clear-load" : "load-entry",
	);
	return Object.freeze({ ...snapshot.qaReplayObservation });
}

async function captureAuthority(
	ctx: QaContext,
	phase: ExactHandoffReplayExternalPhase,
): Promise<Readonly<{
	disk: Readonly<Record<"a" | "b" | "c", string | null>>;
	crdt: Readonly<Record<"a" | "b" | "c", string | null>>;
}>> {
	const paths = EXACT_HANDOFF_REPLAY_PATHS[phase];
	const [diskA, diskB, diskC, crdtA, crdtB, crdtC] = await Promise.all([
		ctx.kaos.getDiskHash(paths.a),
		ctx.kaos.getDiskHash(paths.b),
		paths.c === null ? Promise.resolve(null) : ctx.kaos.getDiskHash(paths.c),
		ctx.kaos.getCrdtHash(paths.a),
		ctx.kaos.getCrdtHash(paths.b),
		paths.c === null ? Promise.resolve(null) : ctx.kaos.getCrdtHash(paths.c),
	]);
	return Object.freeze({
		disk: Object.freeze({ a: diskA, b: diskB, c: diskC }),
		crdt: Object.freeze({ a: crdtA, b: crdtB, c: crdtC }),
	});
}

async function recordPhase(
	ctx: QaContext,
	phase: ExactHandoffReplayExternalPhase,
	before: EditorHandoffReplayQaObservation,
): Promise<PhaseEvidence> {
	const snapshot = ctx.kaos.getContentFreeSnapshot();
	const authority = await captureAuthority(ctx, phase);
	const riskCounts = captureRiskCounts(ctx);
	const item = Object.freeze({
		before: Object.freeze({ ...before }),
		after: Object.freeze({ ...snapshot.qaReplayObservation }),
		...authority,
		...riskCounts,
	});
	assertNoRiskCounts(phase, riskCounts);
	evidence.set(phase, item);
	return item;
}

function assertExactReplayDelta(phase: ExactHandoffReplayExternalPhase, item: PhaseEvidence): void {
	const { before, after } = item;
	if (
		after.phase !== "resolved"
		|| after.planCount - before.planCount !== 1
		|| after.witnessStoredCount - before.witnessStoredCount !== 1
		|| after.permitConsumedCount - before.permitConsumedCount !== 1
		|| after.dispatchAttemptCount - before.dispatchAttemptCount !== 1
		|| after.dispatchAppliedCount - before.dispatchAppliedCount !== 1
		|| after.dispatchUncertainCount !== before.dispatchUncertainCount
		|| after.settlementObservationCount - before.settlementObservationCount !== 1
	) throw new Error(`s13d: ${phase} did not settle exactly once`);
}

function assertNoDispatchDelta(phase: ExactHandoffReplayExternalPhase, item: PhaseEvidence): void {
	if (
		item.after.witnessStoredCount !== item.before.witnessStoredCount
		|| item.after.permitConsumedCount !== item.before.permitConsumedCount
		|| item.after.dispatchAttemptCount !== item.before.dispatchAttemptCount
		|| item.after.dispatchAppliedCount !== item.before.dispatchAppliedCount
		|| item.after.dispatchUncertainCount !== item.before.dispatchUncertainCount
	) throw new Error(`s13d: ${phase} dispatched despite manual/superseded classification`);
}

function assertNoRecoveryDelta(phase: ExactHandoffReplayExternalPhase, item: PhaseEvidence): void {
	if (
		item.after.planCount !== item.before.planCount
		|| item.after.witnessStoredCount !== item.before.witnessStoredCount
		|| item.after.permitConsumedCount !== item.before.permitConsumedCount
		|| item.after.dispatchAttemptCount !== item.before.dispatchAttemptCount
		|| item.after.dispatchAppliedCount !== item.before.dispatchAppliedCount
		|| item.after.dispatchUncertainCount !== item.before.dispatchUncertainCount
		|| item.after.settlementObservationCount !== item.before.settlementObservationCount
	) throw new Error(`s13d: ${phase} created recovery work after a proven same-path IME completion`);
}

function assertManualClassification(
	phase: ExactHandoffReplayExternalPhase,
	item: PhaseEvidence,
): void {
	assertNoDispatchDelta(phase, item);
	if (
		item.after.phase !== "needs-review"
		|| item.after.planCount - item.before.planCount !== 1
	) throw new Error(`s13d: ${phase} did not produce one fresh manual classification`);
}

function requireInitialHash(path: string): string {
	const hash = initialHashes.get(path);
	if (!hash) throw new Error(`s13d: missing initial hash for ${path}`);
	return hash;
}

async function assertSettledTarget(
	ctx: QaContext,
	phase: ExactHandoffReplayExternalPhase,
	item: PhaseEvidence,
): Promise<void> {
	const path = EXACT_HANDOFF_REPLAY_PATHS[phase].b;
	if (item.disk.b === null || item.disk.b !== item.crdt.b) {
		throw new Error(`s13d: ${phase} target disk/CRDT did not converge`);
	}
	const editorHash = await ctx.kaos.getEditorHash(path);
	if (editorHash !== null && editorHash !== item.disk.b) {
		throw new Error(`s13d: ${phase} target editor did not match settled authority`);
	}
}

async function assertUnchangedPair(
	phase: ExactHandoffReplayExternalPhase,
	item: PhaseEvidence,
): Promise<void> {
	const paths = EXACT_HANDOFF_REPLAY_PATHS[phase];
	if (
		item.disk.a !== requireInitialHash(paths.a)
		|| item.crdt.a !== requireInitialHash(paths.a)
		|| item.disk.b !== requireInitialHash(paths.b)
		|| item.crdt.b !== requireInitialHash(paths.b)
	) throw new Error(`s13d: ${phase} changed A/B primary authority`);
}

async function createConvergedFile(ctx: QaContext, path: string, content: string): Promise<void> {
	await ctx.createFile(path, content);
	await ctx.waitForCrdtFile(path, 12_000);
	await ctx.waitForDiskCrdtConverge(path, 12_000);
	const hash = await ctx.kaos.getDiskHash(path);
	if (!hash) throw new Error(`s13d: missing initial hash for ${path}`);
	initialHashes.set(path, hash);
}

export const s13dEditorHandoffExactReplay: QaScenario = {
	id: EXACT_HANDOFF_REPLAY_SCENARIO_ID,
	title: "Exact path-scoped editor handoff replay",
	tags: ["editor", "handoff", "replay", "ime", "undo", "supported-host"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		evidence.clear();
		initialHashes.clear();
		asciiRecoveredHash = null;
		missingTargetSuspensionPrevious = null;
		baselineRiskCounts = captureRiskCounts(ctx);
		await closeExactReplayLeaves(ctx);
		for (const path of EXACT_HANDOFF_REPLAY_ALL_PATHS) {
			await ctx.deleteFile(path).catch(() => undefined);
		}

		// Fail before provider-dependent waits on an unsupported host.
		const probe = ctx.app.vault.getMarkdownFiles().find((file) =>
			!EXACT_HANDOFF_REPLAY_ALL_PATHS.includes(file.path));
		if (!probe) throw new Error("unsupported-host:preflight-markdown-unavailable");
		await ctx.openFile(probe.path);
		activeView(ctx, probe.path);
		await assertSupportedManagedHost(ctx, probe.path);
		await ctx.closeFile(probe.path);

		await ctx.kaos.forceReconcile();
		const missingB = EXACT_HANDOFF_REPLAY_PATHS["exact-missing-ytext"].b;
		for (const phase of EXACT_HANDOFF_REPLAY_PHASES) {
			if (phase === "native-undo" || phase === "native-redo") continue;
			const paths = EXACT_HANDOFF_REPLAY_PATHS[phase];
			const aContent = LONG_IDENTICAL_BASE;
			const bContent = phase === "manual-different-base"
				? DIFFERENT_TARGET_BASE
				: LONG_IDENTICAL_BASE;
			if (!initialHashes.has(paths.a)) await createConvergedFile(ctx, paths.a, aContent);
			if (paths.b !== missingB && !initialHashes.has(paths.b)) {
				await createConvergedFile(ctx, paths.b, bContent);
			}
			if (paths.c !== null && !initialHashes.has(paths.c)) {
				await createConvergedFile(ctx, paths.c, LONG_IDENTICAL_BASE);
			}
		}

		// This one target must have no prior path/Y.Text/tombstone episode. Its
		// certified disk bytes are the same as its already-converged source.
		initialHashes.set(
			missingB,
			requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["exact-missing-ytext"].a),
		);
		await ctx.assert.fileNotExists(missingB);
		await waitForCrdtAbsent(ctx, missingB);
		initialVaultFileCount = ctx.app.vault.getFiles().length;
		ctx.kaos.getContentFreeSnapshot();
		const settledRiskCounts = captureRiskCounts(ctx);
		if (
			settledRiskCounts.attentionCount > baselineRiskCounts.attentionCount
			|| settledRiskCounts.conflictArtifactCount > baselineRiskCounts.conflictArtifactCount
		) {
			throw new Error(
				`s13d: setup increased risk counts ` +
				`attention=${baselineRiskCounts.attentionCount}->${settledRiskCounts.attentionCount}, ` +
				`conflict=${baselineRiskCounts.conflictArtifactCount}->${settledRiskCounts.conflictArtifactCount}`,
			);
		}
		baselineRiskCounts = settledRiskCounts;
	},

	async run(ctx): Promise<void> {
		const asciiBefore = await prepareFreshSource(ctx, "exact-ascii-selection-scroll");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>(
			"exact-ascii-selection-scroll",
		);
		await ctx.waitForDiskCrdtConverge(
			EXACT_HANDOFF_REPLAY_PATHS["exact-ascii-selection-scroll"].b,
			12_000,
		);
		const ascii = await recordPhase(ctx, "exact-ascii-selection-scroll", asciiBefore);
		assertExactReplayDelta("exact-ascii-selection-scroll", ascii);
		await assertSettledTarget(ctx, "exact-ascii-selection-scroll", ascii);
		if (
			!ascii.after.selectionNonEmpty
			|| ascii.after.mappedScrollAnchor === null
			|| ascii.after.liveScrollAnchor === null
			|| ascii.after.mappedScrollAnchor !== ascii.after.liveScrollAnchor
			|| ascii.disk.a !== requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["exact-ascii-selection-scroll"].a)
			|| ascii.disk.b === requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["exact-ascii-selection-scroll"].b)
		) throw new Error("s13d: ASCII selection/scroll replay postcondition is incomplete");
		asciiRecoveredHash = ascii.disk.b;

		const undoBefore = Object.freeze({ ...ctx.kaos.getContentFreeSnapshot().qaReplayObservation });
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("native-undo");
		await ctx.waitForDiskCrdtConverge(EXACT_HANDOFF_REPLAY_PATHS["native-undo"].b, 12_000);
		const undo = await recordPhase(ctx, "native-undo", undoBefore);
		if (
			undo.disk.b !== requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["native-undo"].b)
			|| undo.crdt.b !== undo.disk.b
			|| undo.after.dispatchAttemptCount !== undo.before.dispatchAttemptCount
		) throw new Error("s13d: native Undo did not remove only the recovered B input");

		const redoBefore = Object.freeze({ ...ctx.kaos.getContentFreeSnapshot().qaReplayObservation });
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("native-redo");
		await ctx.waitForDiskCrdtConverge(EXACT_HANDOFF_REPLAY_PATHS["native-redo"].b, 12_000);
		const redo = await recordPhase(ctx, "native-redo", redoBefore);
		if (
			asciiRecoveredHash === null
			|| redo.disk.b !== asciiRecoveredHash
			|| redo.crdt.b !== asciiRecoveredHash
			|| redo.after.dispatchAttemptCount !== redo.before.dispatchAttemptCount
		) throw new Error("s13d: native Redo did not restore only the recovered B input");

		const imeBefore = await prepareFreshSource(ctx, "exact-completed-ime");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("exact-completed-ime");
		await ctx.waitForDiskCrdtConverge(EXACT_HANDOFF_REPLAY_PATHS["exact-completed-ime"].b, 12_000);
		const ime = await recordPhase(ctx, "exact-completed-ime", imeBefore);
		assertExactReplayDelta("exact-completed-ime", ime);
		await assertSettledTarget(ctx, "exact-completed-ime", ime);
		if (
			ime.disk.a !== requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["exact-completed-ime"].a)
			|| ime.disk.b === requireInitialHash(EXACT_HANDOFF_REPLAY_PATHS["exact-completed-ime"].b)
		) throw new Error("s13d: completed IME replay changed the wrong authority");

		const spanningBefore = await prepareFreshSource(ctx, "manual-switch-spanning-ime");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("manual-switch-spanning-ime");
		const spanning = await recordPhase(ctx, "manual-switch-spanning-ime", spanningBefore);
		if (spanning.after.planCount - spanning.before.planCount === 1) {
			assertManualClassification("manual-switch-spanning-ime", spanning);
			await assertUnchangedPair("manual-switch-spanning-ime", spanning);
		} else {
			const spanningPaths = EXACT_HANDOFF_REPLAY_PATHS["manual-switch-spanning-ime"];
			assertNoRecoveryDelta("manual-switch-spanning-ime", spanning);
			if (
				spanning.disk.a === null
				|| spanning.disk.a === requireInitialHash(spanningPaths.a)
				|| spanning.crdt.a !== spanning.disk.a
				|| spanning.disk.b !== requireInitialHash(spanningPaths.b)
				|| spanning.crdt.b !== requireInitialHash(spanningPaths.b)
			) throw new Error("s13d: pre-switch IME completion did not settle only on A");
			await assertSettledTarget(ctx, "manual-switch-spanning-ime", spanning);
		}

		const differentBefore = await prepareFreshSource(ctx, "manual-different-base");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("manual-different-base");
		const different = await recordPhase(ctx, "manual-different-base", differentBefore);
		assertManualClassification("manual-different-base", different);
		await assertUnchangedPair("manual-different-base", different);

		const missingPaths = EXACT_HANDOFF_REPLAY_PATHS["exact-missing-ytext"];
		const suspended = await ctx.kaos.setDiskIngestSuspended(true);
		missingTargetSuspensionPrevious = suspended.previous;
		try {
			await ctx.writeAdapterFile(missingPaths.b, LONG_IDENTICAL_BASE);
			await ctx.waitForFile(missingPaths.b, 12_000);
			if (
				await ctx.kaos.getDiskHash(missingPaths.b) !== requireInitialHash(missingPaths.b)
				|| await ctx.kaos.getCrdtHash(missingPaths.b) !== null
			) throw new Error("s13d: missing-Y.Text target was ingested before replay admission");
			const missingBefore = await prepareFreshSource(ctx, "exact-missing-ytext");
			await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("exact-missing-ytext");
			await ctx.waitForDiskCrdtConverge(missingPaths.b, 12_000);
			const missing = await recordPhase(ctx, "exact-missing-ytext", missingBefore);
			assertExactReplayDelta("exact-missing-ytext", missing);
			await assertSettledTarget(ctx, "exact-missing-ytext", missing);
			if (
				missing.disk.a !== requireInitialHash(missingPaths.a)
				|| missing.disk.b === requireInitialHash(missingPaths.b)
			) throw new Error("s13d: missing-Y.Text replay did not seed B before exact input");
		} finally {
			await ctx.kaos.setDiskIngestSuspended(missingTargetSuspensionPrevious);
			missingTargetSuspensionPrevious = null;
		}

		const heldBefore = await prepareFreshSource(ctx, "exact-same-content-held-load");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>(
			"exact-same-content-held-load",
		);
		await ctx.waitForDiskCrdtConverge(
			EXACT_HANDOFF_REPLAY_PATHS["exact-same-content-held-load"].b,
			12_000,
		);
		const held = await recordPhase(ctx, "exact-same-content-held-load", heldBefore);
		assertExactReplayDelta("exact-same-content-held-load", held);
		await assertSettledTarget(ctx, "exact-same-content-held-load", held);

		const supersedeBefore = await prepareFreshSource(ctx, "supersede-b-with-c");
		await ctx.awaitExternalPhase<ExactHandoffReplayExternalPhase>("supersede-b-with-c");
		const supersede = await recordPhase(ctx, "supersede-b-with-c", supersedeBefore);
		assertNoDispatchDelta("supersede-b-with-c", supersede);
		const supersedePaths = EXACT_HANDOFF_REPLAY_PATHS["supersede-b-with-c"];
		if (
			supersede.disk.a !== requireInitialHash(supersedePaths.a)
			|| supersede.crdt.a !== requireInitialHash(supersedePaths.a)
			|| supersede.disk.b !== requireInitialHash(supersedePaths.b)
			|| supersede.crdt.b !== requireInitialHash(supersedePaths.b)
			|| supersede.disk.c !== requireInitialHash(supersedePaths.c!)
			|| supersede.crdt.c !== requireInitialHash(supersedePaths.c!)
		) throw new Error("s13d: superseded B completion mutated A/B/C authority");
	},

	async assert(ctx): Promise<void> {
		if (evidence.size !== EXACT_HANDOFF_REPLAY_PHASES.length) {
			throw new Error("s13d: incomplete nine-phase evidence");
		}
		if (ctx.app.vault.getFiles().length !== initialVaultFileCount + 1) {
			throw new Error("s13d: exact replay created an unexpected vault artifact");
		}
		await ctx.assert.noConflictCopies();
	},

	async cleanup(ctx): Promise<void> {
		if (missingTargetSuspensionPrevious !== null) {
			await ctx.kaos.setDiskIngestSuspended(missingTargetSuspensionPrevious)
				.catch(() => undefined);
			missingTargetSuspensionPrevious = null;
		}
		await closeExactReplayLeaves(ctx).catch(() => undefined);
	},
};
