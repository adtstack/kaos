import { MarkdownView, type TFile } from "obsidian";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
	HandoffRecoveryQaSnapshot,
} from "../../../src/runtime/engineControlPort";
import type {
	HandoffRecoveryExternalPhaseName,
	QaContext,
	QaScenario,
} from "../types";

export const HANDOFF_RECOVERY_SCENARIO_ID = "s13b-editor-handoff-recovery";

export const HANDOFF_RECOVERY_QA_PATHS = Object.freeze({
	quotaA: "QA-handoff-recovery-quota-A.md",
	quotaB: "QA-handoff-recovery-quota-B.md",
	copyA: "QA-handoff-recovery-copy-A.md",
	copyB: "QA-handoff-recovery-copy-B.md",
	exportA: "QA-handoff-recovery-export-A.md",
	exportB: "QA-handoff-recovery-export-B.md",
	discardA: "QA-handoff-recovery-discard-A.md",
	discardB: "QA-handoff-recovery-discard-B.md",
	exportPath: "QA-scratch/Handoff Recovery Export.md",
	reloadExportPath: "QA-scratch/Handoff Recovery Reload Export.md",
	folderSentinel: "QA-scratch/.handoff-recovery-qa.md",
});

const PAIRS = Object.freeze([
	Object.freeze({
		name: "quota",
		a: HANDOFF_RECOVERY_QA_PATHS.quotaA,
		b: HANDOFF_RECOVERY_QA_PATHS.quotaB,
		aBody: "# Quota source\n\nsource-only-alpha\n",
		bBody: "# Quota target\n\ncertified-target-bravo\n",
	}),
	Object.freeze({
		name: "copy",
		a: HANDOFF_RECOVERY_QA_PATHS.copyA,
		b: HANDOFF_RECOVERY_QA_PATHS.copyB,
		aBody: "# Copy source\n\nsource-only-charlie\n",
		bBody: "# Copy target\n\ncertified-target-delta\n",
	}),
	Object.freeze({
		name: "export",
		a: HANDOFF_RECOVERY_QA_PATHS.exportA,
		b: HANDOFF_RECOVERY_QA_PATHS.exportB,
		aBody: "# Export source\n\nsource-only-echo\n",
		bBody: "# Export target\n\ncertified-target-foxtrot\n",
	}),
	Object.freeze({
		name: "discard",
		a: HANDOFF_RECOVERY_QA_PATHS.discardA,
		b: HANDOFF_RECOVERY_QA_PATHS.discardB,
		aBody: "# Discard source\n\nsource-only-golf\n",
		bBody: "# Discard target\n\ncertified-target-hotel\n",
	}),
]);

type Pair = (typeof PAIRS)[number];
type PhaseEvidence = Readonly<{
	leafId: string;
	sessionId: string;
	generation: number;
	recoveryOperationEpoch: number | null;
	intentId: string;
	intentState: string;
	startContentHash: string;
	afterContentHash: string;
	gateClosed: boolean;
	qa: HandoffRecoveryQaSnapshot;
}>;

export type RetainedManualRecoveryEvidence = Readonly<{
	intentId: string;
	fromPath: string | null;
	targetPath: string;
	afterContentHash: string;
	recoveryOperationEpoch: number | null;
}>;

const phaseEvidence = new Map<HandoffRecoveryExternalPhaseName, PhaseEvidence>();
const initialHashes = new Map<string, string>();
let initialVaultFileCount = 0;
let retainedManualRecoveryEvidence: RetainedManualRecoveryEvidence | null = null;

export function getRetainedManualRecoveryEvidence(): RetainedManualRecoveryEvidence | null {
	return retainedManualRecoveryEvidence
		? Object.freeze({ ...retainedManualRecoveryEvidence })
		: null;
}

function fileAt(ctx: QaContext, path: string): TFile {
	const file = ctx.app.vault.getFileByPath(path);
	if (!file) throw new Error(`s13b: missing fixture file ${path}`);
	return file;
}

function activeView(ctx: QaContext, path: string): MarkdownView {
	const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== path) {
		throw new Error(`s13b: active MarkdownView is not ${path}`);
	}
	return view;
}

async function assertSupportedManagedHost(ctx: QaContext, path: string): Promise<void> {
	await waitForSnapshot(ctx, "supported managed host", (snapshot) =>
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

async function assertSupportedHostPreflight(ctx: QaContext): Promise<void> {
	const probe = PAIRS[0];
	await ctx.createFile(probe.a, probe.aBody);
	// A previous interrupted run can leave the fixed QA path tombstoned. Let the
	// exact local-create event revive it before opening an editor; opening first
	// makes the editor-ahead fence correctly defer that disk import.
	await ctx.waitForCrdtFile(probe.a, 12_000);
	await ctx.waitForDiskCrdtConverge(probe.a, 12_000);
	await ctx.openFile(probe.a);
	activeView(ctx, probe.a);
	await assertSupportedManagedHost(ctx, probe.a);
	await ctx.closeFile(probe.a);
}

function leafFor(
	snapshot: EditorHandoffDebugSnapshot,
	leafId: string,
): EditorHandoffManagedLeafDebugSnapshot | null {
	return snapshot.leaves.find((leaf) => leaf.leafId === leafId) ?? null;
}

async function waitForSnapshot(
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
	throw new Error(`s13b: ${label} timed out; snapshot=${JSON.stringify(last)}`);
}

async function closeRecoveryLeaves(ctx: QaContext): Promise<void> {
	for (const pair of PAIRS) {
		await ctx.closeFile(pair.a).catch(() => undefined);
		await ctx.closeFile(pair.b).catch(() => undefined);
	}
}

async function prepareHeldPair(
	ctx: QaContext,
	pair: Pair,
): Promise<Readonly<{
	leafId: string;
	settlement: Promise<"fulfilled" | "rejected">;
}>> {
	await closeRecoveryLeaves(ctx);
	await ctx.openFile(pair.a);
	const source = activeView(ctx, pair.a);
	await assertSupportedManagedHost(ctx, pair.a);
	await ctx.waitForCrdtBinding(pair.a, 12_000);
	const leafId = (source.leaf as unknown as { id?: string }).id;
	if (!leafId) throw new Error("s13b: active leaf has no stable ID");
	ctx.kaos.holdNextHostLoad(pair.b);
	const settlement = source.leaf.openFile(fileAt(ctx, pair.b)).then(
		() => "fulfilled" as const,
		() => "rejected" as const,
	);
	await waitForSnapshot(ctx, `${pair.name} held target`, (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === pair.b
		&& snapshot.hostLoad.leafId === leafId
		&& leafFor(snapshot, leafId)?.gateClosed === true,
	);
	return Object.freeze({ leafId, settlement });
}

function capturePhase(
	ctx: QaContext,
	name: HandoffRecoveryExternalPhaseName,
	leafId: string,
): PhaseEvidence {
	const snapshot = ctx.kaos.getEditorHandoffDebugSnapshot();
	const leaf = leafFor(snapshot, leafId);
	const intent = leaf?.intent;
	const qa = ctx.kaos.getHandoffRecoveryQaSnapshot();
	const accepted = qa.lastAcceptedState;
	if (!leaf) throw new Error(`s13b: ${name} has no managed leaf evidence`);
	if (!intent && (
		!accepted
		|| (accepted.state !== "escaped" && accepted.state !== "discarded")
		|| accepted.leafId !== leaf.leafId
		|| accepted.sessionId !== leaf.sessionId
		|| accepted.generation !== leaf.generation
		|| accepted.targetPath !== leaf.bindingPath
		|| leaf.gateClosed
		|| leaf.presentation !== "none"
		|| leaf.phase !== "stable"
	)) throw new Error(`s13b: ${name} has no exact transient or settled intent receipt`);
	const encoded = JSON.stringify({ leaf, qa });
	if (/"(?:startContent|afterContent|serializedChanges|serializedSelectionBefore|serializedSelectionAfter)"|source-only|certified-target/.test(encoded)) {
		throw new Error(`s13b: ${name} debug evidence exposed Recovery content`);
	}
	const captured = Object.freeze({
		leafId: leaf.leafId,
		sessionId: leaf.sessionId,
		generation: leaf.generation,
		recoveryOperationEpoch:
			intent ? leaf.recoveryOperationEpoch : accepted!.recoveryOperationEpoch,
		intentId: intent?.intentId ?? accepted!.intentId,
		intentState: intent?.state ?? accepted!.state,
		startContentHash: intent?.startContentHash ?? accepted!.startContentHash,
		afterContentHash: intent?.afterContentHash ?? accepted!.afterContentHash,
		gateClosed: leaf.gateClosed,
		qa: Object.freeze({ ...qa }),
	});
	phaseEvidence.set(name, captured);
	return captured;
}

async function captureQuotaManualPhase(
	ctx: QaContext,
	leafId: string,
): Promise<PhaseEvidence> {
	const name = "quota-failed-retry" as const;
	const snapshot = ctx.kaos.getEditorHandoffDebugSnapshot();
	const leaf = leafFor(snapshot, leafId);
	if (leaf?.intent) return capturePhase(ctx, name, leafId);
	const rows = await ctx.kaos.getHandoffRecoveryQaManualRows();
	const matches = rows.filter((row) =>
		row.status === "needs-review"
		&& row.fromPath === HANDOFF_RECOVERY_QA_PATHS.quotaA
		&& row.targetPath === HANDOFF_RECOVERY_QA_PATHS.quotaB
	);
	const row = matches.length === 1 ? matches[0] : null;
	const qa = ctx.kaos.getHandoffRecoveryQaSnapshot();
	if (
		!leaf
		|| !row
		|| leaf.gateClosed
		|| leaf.bindingPath !== HANDOFF_RECOVERY_QA_PATHS.quotaB
		|| leaf.presentation !== "none"
		|| leaf.phase !== "stable"
		|| snapshot.qaReplayObservation.phase !== "needs-review"
	) throw new Error("s13b: quota durable manual row did not outlive its settled leaf handoff");
	const encoded = JSON.stringify({ leaf, row, qa });
	if (/"(?:startContent|afterContent|serializedChanges|serializedSelectionBefore|serializedSelectionAfter)"|source-only|certified-target/.test(encoded)) {
		throw new Error(`s13b: ${name} durable row evidence exposed Recovery content`);
	}
	const captured = Object.freeze({
		leafId: leaf.leafId,
		sessionId: leaf.sessionId,
		generation: leaf.generation,
		recoveryOperationEpoch: null,
		intentId: row.intentId,
		intentState: row.status,
		startContentHash: row.startContentHash,
		afterContentHash: row.afterContentHash,
		gateClosed: leaf.gateClosed,
		qa: Object.freeze({ ...qa }),
	});
	phaseEvidence.set(name, captured);
	return captured;
}

async function settleHostSwitch(
	ctx: QaContext,
	label: string,
	settlement: Promise<"fulfilled" | "rejected">,
): Promise<void> {
	const result = await Promise.race([
		settlement,
		ctx.sleep(2_000).then(() => "timeout" as const),
	]);
	if (result === "timeout") throw new Error(`s13b: ${label} host switch did not settle`);
}

function requirePhase(name: HandoffRecoveryExternalPhaseName): PhaseEvidence {
	const evidence = phaseEvidence.get(name);
	if (!evidence) throw new Error(`s13b: missing phase evidence ${name}`);
	return evidence;
}

export const s13bEditorHandoffRecovery: QaScenario = {
	id: HANDOFF_RECOVERY_SCENARIO_ID,
	title: "Device-local editor handoff Recovery failures and escapes",
	tags: ["editor", "handoff", "recovery", "indexeddb", "manual", "supported-host"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		phaseEvidence.clear();
		initialHashes.clear();
		retainedManualRecoveryEvidence = null;
		await closeRecoveryLeaves(ctx);
		for (const path of [
			...PAIRS.flatMap((pair) => [pair.a, pair.b]),
			HANDOFF_RECOVERY_QA_PATHS.exportPath,
			HANDOFF_RECOVERY_QA_PATHS.reloadExportPath,
		]) await ctx.deleteFile(path).catch(() => undefined);
		await ctx.deleteAdapterFile(HANDOFF_RECOVERY_QA_PATHS.folderSentinel)
			.catch(() => undefined);
		await assertSupportedHostPreflight(ctx);
		await ctx.kaos.forceReconcile();
		await ctx.writeAdapterFile(
			HANDOFF_RECOVERY_QA_PATHS.folderSentinel,
			"QA-only folder sentinel.\n",
		);
		for (const pair of PAIRS) {
			await ctx.createFile(pair.a, pair.aBody);
			await ctx.createFile(pair.b, pair.bBody);
			for (const path of [pair.a, pair.b]) {
				await ctx.waitForCrdtFile(path, 12_000);
				await ctx.waitForDiskCrdtConverge(path, 12_000);
				const hash = await ctx.kaos.getDiskHash(path);
				if (!hash) throw new Error(`s13b: missing initial hash for ${path}`);
				initialHashes.set(path, hash);
			}
		}
		initialVaultFileCount = ctx.app.vault.getFiles().length;
	},

	async run(ctx): Promise<void> {
		const quota = await prepareHeldPair(ctx, PAIRS[0]);
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("quota-failed-retry");
		const quotaEvidence = await captureQuotaManualPhase(ctx, quota.leafId);
		if (
			quotaEvidence.intentState !== "needs-review"
			|| quotaEvidence.gateClosed
			|| quotaEvidence.qa.putStartedCount < 2
			|| quotaEvidence.qa.lastCategoricalOutcome !== "put-verified"
		) throw new Error("s13b: quota Retry did not reach one manual row and release B");
		retainedManualRecoveryEvidence = Object.freeze({
			intentId: quotaEvidence.intentId,
			fromPath: PAIRS[0].a,
			targetPath: PAIRS[0].b,
			afterContentHash: quotaEvidence.afterContentHash,
			recoveryOperationEpoch: quotaEvidence.recoveryOperationEpoch,
		});
		await settleHostSwitch(ctx, "quota", quota.settlement);
		await ctx.waitForCrdtBinding(PAIRS[0].b, 12_000);

		const copy = await prepareHeldPair(ctx, PAIRS[1]);
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("hung-put-copy-failure");
		const copyFailure = capturePhase(ctx, "hung-put-copy-failure", copy.leafId);
		if (
			copyFailure.intentState !== "failed"
			|| !copyFailure.gateClosed
			|| copyFailure.qa.heldOperationId !== "copy-late-put"
			|| copyFailure.qa.lastCategoricalOutcome !== "clipboard-rejected"
		) throw new Error("s13b: rejected Copy did not retain the exact held row and gate");
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("hung-put-copy-success");
		const copySuccess = capturePhase(ctx, "hung-put-copy-success", copy.leafId);
		if (
			copySuccess.intentState !== "escaped"
			|| copySuccess.gateClosed
			|| copySuccess.qa.heldOperationId !== "copy-late-put"
			|| (copySuccess.recoveryOperationEpoch ?? -1)
				<= (copyFailure.recoveryOperationEpoch ?? -1)
		) throw new Error("s13b: successful Copy did not release only the newer operation");
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("release-copy-late-put");
		const copyReleased = capturePhase(ctx, "release-copy-late-put", copy.leafId);
		if (
			copyReleased.intentState !== "escaped"
			|| copyReleased.gateClosed
			|| copyReleased.qa.heldOperationId !== null
			|| copyReleased.recoveryOperationEpoch !== copySuccess.recoveryOperationEpoch
		) throw new Error("s13b: late Copy put re-gated or crossed its operation epoch");
		await settleHostSwitch(ctx, "copy", copy.settlement);

		const exported = await prepareHeldPair(ctx, PAIRS[2]);
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("verified-export");
		const exportEvidence = capturePhase(ctx, "verified-export", exported.leafId);
		if (
			exportEvidence.intentState !== "escaped"
			|| exportEvidence.gateClosed
			|| exportEvidence.qa.heldOperationId !== null
		) throw new Error("s13b: verified Export did not fence its late put");
		await ctx.assert.fileHash(
			HANDOFF_RECOVERY_QA_PATHS.exportPath,
			exportEvidence.afterContentHash,
		);
		await settleHostSwitch(ctx, "export", exported.settlement);

		const discarded = await prepareHeldPair(ctx, PAIRS[3]);
		await ctx.awaitExternalPhase<HandoffRecoveryExternalPhaseName>("confirmed-discard");
		const discardEvidence = capturePhase(ctx, "confirmed-discard", discarded.leafId);
		if (
			discardEvidence.intentState !== "discarded"
			|| discardEvidence.gateClosed
			|| discardEvidence.qa.heldOperationId !== null
		) throw new Error("s13b: confirmed Discard did not fence its late put");
		await settleHostSwitch(ctx, "discard", discarded.settlement);
	},

	async assert(ctx): Promise<void> {
		if (!retainedManualRecoveryEvidence) {
			throw new Error("s13b: the acknowledged manual row was not retained for reload");
		}
		for (const [path, expected] of initialHashes) {
			const [disk, crdt] = await Promise.all([
				ctx.kaos.getDiskHash(path),
				ctx.kaos.getCrdtHash(path),
			]);
			if (disk !== expected || crdt !== expected) {
				throw new Error(`s13b: Recovery mutated primary authority ${path}`);
			}
		}
		if (ctx.app.vault.getFiles().length !== initialVaultFileCount + 1) {
			throw new Error("s13b: only the explicit Recovery export may add one vault file");
		}
		if (phaseEvidence.size !== 6) throw new Error("s13b: incomplete external phase evidence");
		if (requirePhase("quota-failed-retry").intentId !== retainedManualRecoveryEvidence.intentId) {
			throw new Error("s13b: retained manual row identity changed");
		}
		await ctx.assert.fileNotExists(HANDOFF_RECOVERY_QA_PATHS.reloadExportPath);
		await ctx.assert.noConflictCopies();
	},

	async cleanup(ctx): Promise<void> {
		// Keep the one manual row and fixture paths intact for S13c's product reload.
		await closeRecoveryLeaves(ctx).catch(() => undefined);
	},
};
