import type {
	HandoffRecoveryReloadExternalPhaseName,
	QaContext,
	QaScenario,
} from "../types";
import {
	HANDOFF_RECOVERY_QA_PATHS,
	getRetainedManualRecoveryEvidence,
} from "./s13b-editor-handoff-recovery";

export const HANDOFF_RECOVERY_RELOAD_SCENARIO_ID =
	"s13c-editor-handoff-recovery-reload";

let initialFreshContextChecked = false;

export const s13cEditorHandoffRecoveryReload: QaScenario = {
	id: HANDOFF_RECOVERY_RELOAD_SCENARIO_ID,
	title: "Handoff Recovery reload hydration and manual dashboard handling",
	tags: ["editor", "handoff", "recovery", "reload", "dashboard", "manual"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		initialFreshContextChecked = false;
		const retained = getRetainedManualRecoveryEvidence();
		if (!retained) throw new Error("s13c: S13b retained evidence is unavailable");
		const qa = ctx.kaos.getHandoffRecoveryQaSnapshot();
		if (
			qa.armedFault !== null
			|| qa.heldOperationId !== null
			|| qa.putStartedCount !== 0
			|| qa.putSettledCount !== 0
		) throw new Error("s13c: product reload reused the prior QA fault context");
		const handoff = ctx.kaos.getEditorHandoffDebugSnapshot();
		if (handoff.leaves.some((leaf) => leaf.intent !== null)) {
			throw new Error("s13c: hydration dispatched a Recovery body into an editor");
		}
		initialFreshContextChecked = true;
	},

	async run(ctx): Promise<void> {
		await ctx.awaitExternalPhase<HandoffRecoveryReloadExternalPhaseName>(
			"hydrated-dashboard-review",
		);
	},

	async assert(ctx): Promise<void> {
		const retained = getRetainedManualRecoveryEvidence();
		if (!initialFreshContextChecked || !retained) {
			throw new Error("s13c: fresh hydration context was not proven");
		}
		await ctx.assert.fileHash(
			HANDOFF_RECOVERY_QA_PATHS.reloadExportPath,
			retained.afterContentHash,
		);
		const qa = ctx.kaos.getHandoffRecoveryQaSnapshot();
		if (qa.putStartedCount !== 0 || qa.putSettledCount !== 0) {
			throw new Error("s13c: dashboard handling produced an automatic Recovery put");
		}
		if (ctx.kaos.getEditorHandoffDebugSnapshot().leaves.some((leaf) =>
			leaf.intent?.state === "replay-pending"
			|| leaf.intent?.state === "replayed-awaiting-settlement"
		)) throw new Error("s13c: Slice 2 produced a replay state after reload");
		await ctx.assert.noConflictCopies();
	},

	async cleanup(ctx): Promise<void> {
		for (const path of Object.values(HANDOFF_RECOVERY_QA_PATHS).filter(
			(path) => path !== HANDOFF_RECOVERY_QA_PATHS.folderSentinel,
		)) {
			await ctx.closeFile(path).catch(() => undefined);
			await ctx.deleteFile(path).catch(() => undefined);
		}
		await ctx.deleteAdapterFile(HANDOFF_RECOVERY_QA_PATHS.folderSentinel)
			.catch(() => undefined);
		initialFreshContextChecked = false;
	},
};
