import { MarkdownView, type TFile, type WorkspaceLeaf } from "obsidian";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
} from "../../../src/runtime/engineControlPort";
import {
	SAME_PATH_ADOPTION_ALL_PATHS,
	SAME_PATH_ADOPTION_PATHS,
	SAME_PATH_ADOPTION_PHASES,
	SAME_PATH_ADOPTION_SCENARIO_ID,
	type SamePathAdoptionExternalPhase,
} from "../../contracts/same-path-adoption";
import {
	atomicallyReadmitSamePathPanesForQa,
	freezeSamePathPaneProjectionForQa,
} from "../same-path-admission-fixture";
import type { QaContext, QaScenario } from "../types";

const BASE = [
	"# Same-path adoption",
	"",
	"alpha: base",
	"middle: base",
	"omega: base",
	"",
	...Array.from({ length: 96 }, (_, index) => `stable-line-${index + 1}`),
	"",
].join("\n");

const CLEAN_REMOTE = BASE.replace("alpha: base", "alpha: remote");
const CLEAN_LOCAL_LINE_ORDINAL = 40;
const CLEAN_LOCAL_LINE = `stable-line-${CLEAN_LOCAL_LINE_ORDINAL}`;
const CLEAN_LOCAL_LINE_INDEX = 5 + CLEAN_LOCAL_LINE_ORDINAL;
const CLEAN_MERGED = CLEAN_REMOTE.replace(CLEAN_LOCAL_LINE, `${CLEAN_LOCAL_LINE}l`);
const CONFLICT_REMOTE = BASE.replace("middle: base", "middle: remote");
const CONFLICT_LOCAL = BASE.replace("middle: base", "middle: l");
const ARTIFACT_REMOTE = BASE.replace("middle: base", "middle: server");
const ARTIFACT_LOCAL = BASE.replace("middle: base", "middle: a");
const MULTI_REMOTE = BASE.replace("alpha: base", "alpha: shared-remote");
const MULTI_DISTINCT_REMOTE = MULTI_REMOTE.replace("middle: base", "middle: server-2");

type PhaseEvidence = Readonly<{
	path: string;
	diskHash: string | null;
	crdtHash: string | null;
	editorHash: string | null;
	leafCount: number;
	boundCount: number;
	adoptionKinds: readonly string[];
}>;

const evidence = new Map<SamePathAdoptionExternalPhase, PhaseEvidence>();
let restoreArtifactCreate: (() => void) | null = null;
let restoreDistinctPaneProjection: (() => void) | null = null;
let initialFileCount = 0;

function activeView(ctx: QaContext, path: string): MarkdownView {
	const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== path) {
		throw new Error(`s13e: active MarkdownView is not ${path}`);
	}
	return view;
}

function fileAt(ctx: QaContext, path: string): TFile {
	const file = ctx.app.vault.getFileByPath(path);
	if (!file) throw new Error(`s13e: missing fixture ${path}`);
	return file;
}

async function waitForSnapshot(
	ctx: QaContext,
	label: string,
	accept: (snapshot: EditorHandoffDebugSnapshot) => boolean,
	timeoutMs = 30_000,
): Promise<EditorHandoffDebugSnapshot> {
	const startedAt = Date.now();
	let last: EditorHandoffDebugSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		last = ctx.kaos.getContentFreeSnapshot();
		if (accept(last)) return last;
		await ctx.sleep(25);
	}
	throw new Error(`s13e: ${label} timed out; snapshot=${JSON.stringify(last)}`);
}

async function waitForExactPostMutationReceipt(
	ctx: QaContext,
	beforeCandidateId: string | null,
	mutationStartedAt: number,
	timeoutMs = 30_000,
): Promise<void> {
	const startedAt = Date.now();
	let candidateId: string | null = null;
	let candidateCapturedAt: number | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		if (ctx.signal.aborted) throw ctx.signal.reason;
		const receipt = ctx.kaos.getReceiptSnapshot();
		if (
			candidateId === null
			&& receipt.candidateId !== null
			&& receipt.candidateId !== beforeCandidateId
			&& receipt.capturedAt !== null
			&& receipt.capturedAt >= mutationStartedAt
		) {
			candidateId = receipt.candidateId;
			candidateCapturedAt = receipt.capturedAt;
		}
		if (
			candidateId !== null
			&& candidateCapturedAt !== null
			&& receipt.lastConfirmedCandidateId === candidateId
			&& receipt.lastConfirmedAt !== null
			&& receipt.lastConfirmedAt >= candidateCapturedAt
		) return;
		await ctx.sleep(25);
	}
	throw new Error("s13e: exact Remote fixture server receipt timed out");
}

function leavesFor(
	snapshot: EditorHandoffDebugSnapshot,
	path: string,
): readonly EditorHandoffManagedLeafDebugSnapshot[] {
	return snapshot.leaves.filter((leaf) => leaf.viewPath === path);
}

async function requireSupportedManagedView(ctx: QaContext, path: string): Promise<void> {
	await waitForSnapshot(ctx, `supported managed view ${path}`, (snapshot) =>
		leavesFor(snapshot, path).some((leaf) =>
			leaf.managed
			&& leaf.active
			&& (
				leaf.hostCapability === "public-cancellable"
				|| leaf.hostCapability === "owned-scheduler-with-unload-flush"
			)
			&& leaf.hostCapabilityState === "ready"
			&& leaf.clearLoadCapability === "observable"
		),
	);
}

async function closeFixtures(ctx: QaContext): Promise<void> {
	for (const path of SAME_PATH_ADOPTION_ALL_PATHS) {
		await ctx.closeFile(path).catch(() => undefined);
	}
}

async function resumeFixturePropagation(ctx: QaContext): Promise<void> {
	for (const path of SAME_PATH_ADOPTION_ALL_PATHS) {
		await ctx.kaos.resumeEditorPropagation(path).catch(() => false);
	}
}

async function deleteFixtureArtifacts(ctx: QaContext): Promise<void> {
	const stems = SAME_PATH_ADOPTION_ALL_PATHS.map((path) => path.replace(/\.md$/, ""));
	for (const file of ctx.app.vault.getMarkdownFiles()) {
		if (
			file.path.includes("(KAOS conflict")
			&& stems.some((stem) => file.path.startsWith(stem))
		) await ctx.deleteFile(file.path).catch(() => undefined);
	}
}

async function createConvergedFixture(ctx: QaContext, path: string): Promise<void> {
	await ctx.deleteFile(path).catch(() => undefined);
	await ctx.createFile(path, BASE);
	await ctx.waitForCrdtFile(path, 20_000);
	await ctx.waitForDiskCrdtConverge(path, 20_000);
}

async function prepareDetachedRemote(
	ctx: QaContext,
	path: string,
	remote: string,
	selection: Readonly<{
		anchor: { line: number; ch: number };
		head?: { line: number; ch: number };
	}>,
): Promise<void> {
	await closeFixtures(ctx);
	await ctx.openFile(path);
	await ctx.waitForCrdtBinding(path, 20_000);
	await requireSupportedManagedView(ctx, path);
	const view = activeView(ctx, path);
	view.editor.setSelection(selection.anchor, selection.head ?? selection.anchor);
	view.editor.scrollTo(null, 240);
	await ctx.kaos.setDiskIngestSuspended(true);
	if (!await ctx.kaos.pauseEditorPropagation(path)) {
		throw new Error(`s13e: failed to detach propagation for ${path}`);
	}
	const receiptBefore = ctx.kaos.getReceiptSnapshot();
	const remoteMutationStartedAt = Date.now();
	const forced = await ctx.kaos.__qaOnlyForceCrdtContentUnsafe(path, remote, {
		originClass: "local",
	});
	if (
		!forced.fileExisted
		|| forced.beforeHash === null
		|| forced.afterHash === null
		|| forced.afterHash === forced.beforeHash
	) {
		throw new Error(`s13e: QA CRDT fixture injection did not advance ${path}`);
	}
	// Product reload is part of the test. Prove the Remote fixture reached the
	// server first so a missing Remote after reload is a product failure rather
	// than a controller race with provider transport.
	await ctx.kaos.waitForReceiptAfter(remoteMutationStartedAt, 30_000);
	await waitForExactPostMutationReceipt(
		ctx,
		receiptBefore.candidateId,
		remoteMutationStartedAt,
	);
	const editorHash = await ctx.kaos.getEditorHash(path);
	const diskHash = await ctx.kaos.getDiskHash(path);
	const crdtHash = await ctx.kaos.getCrdtHash(path);
	if (editorHash === null || diskHash === null || crdtHash === null) {
		throw new Error(`s13e: incomplete authority setup for ${path}`);
	}
	if (editorHash !== diskHash || crdtHash === diskHash) {
		throw new Error(`s13e: Base/Local/Remote setup did not diverge for ${path}`);
	}
}

async function recordPhase(
	ctx: QaContext,
	phase: SamePathAdoptionExternalPhase,
	path: string,
): Promise<PhaseEvidence> {
	const snapshot = ctx.kaos.getContentFreeSnapshot();
	const encoded = JSON.stringify(snapshot);
	if ([BASE, CLEAN_REMOTE, CONFLICT_REMOTE, ARTIFACT_REMOTE].some((body) =>
		encoded.includes(body))) {
		throw new Error(`s13e: ${phase} exposed note content in debug evidence`);
	}
	const leaves = leavesFor(snapshot, path);
	const item = Object.freeze({
		path,
		diskHash: await ctx.kaos.getDiskHash(path),
		crdtHash: await ctx.kaos.getCrdtHash(path),
		editorHash: await ctx.kaos.getEditorHash(path),
		leafCount: leaves.length,
		boundCount: leaves.filter((leaf) => leaf.bindingPath === path).length,
		adoptionKinds: Object.freeze(leaves.map((leaf) => leaf.adoption.kind)),
	});
	evidence.set(phase, item);
	return item;
}

function installOneShotArtifactFailure(ctx: QaContext): void {
	restoreArtifactCreate?.();
	const vault = ctx.app.vault as unknown as {
		create(path: string, content: string): Promise<TFile>;
	};
	const original = vault.create;
	let armed = true;
	const restore = (): void => {
		if (vault.create === injectedCreate) vault.create = original;
		if (restoreArtifactCreate === restore) restoreArtifactCreate = null;
	};
	async function injectedCreate(path: string, content: string): Promise<TFile> {
		if (armed && path.includes("(KAOS conflict")) {
			armed = false;
			restore();
			throw new Error("qa-injected-adoption-artifact-failure");
		}
		return original.call(vault, path, content);
	}
	vault.create = injectedCreate;
	restoreArtifactCreate = restore;
}

async function assertArtifactContent(
	ctx: QaContext,
	path: string | null,
	expected: string,
): Promise<void> {
	if (!path) throw new Error("s13e: expected conflict artifact path is absent");
	const actual = await ctx.app.vault.adapter.read(path);
	if (actual !== expected) throw new Error(`s13e: conflict artifact mismatch at ${path}`);
}

async function openIdenticalPanes(ctx: QaContext, path: string): Promise<void> {
	await closeFixtures(ctx);
	await ctx.openFile(path);
	await ctx.waitForCrdtBinding(path, 20_000);
	const second = (ctx.app.workspace as unknown as {
		getLeaf(kind: "split", direction: "vertical"): WorkspaceLeaf;
	}).getLeaf("split", "vertical");
	await second.openFile(fileAt(ctx, path), { active: true });
	await waitForSnapshot(ctx, "two identical managed panes", (snapshot) =>
		leavesFor(snapshot, path).filter((leaf) => leaf.bindingPath === path).length === 2,
	);
}

function markdownViewsForPath(ctx: QaContext, path: string): MarkdownView[] {
	const views: MarkdownView[] = [];
	ctx.app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
			views.push(leaf.view);
		}
	});
	return views;
}

function atomicallyReadmitDistinctPanesForQa(ctx: QaContext, path: string): void {
	const product = (ctx.app as unknown as {
		plugins?: {
			plugins?: Record<string, {
				editorBindings?: {
					unbind(view: MarkdownView): void;
					bind(view: MarkdownView, deviceName: string): void;
				};
				settings?: { deviceName?: unknown };
			}>;
		};
	}).plugins?.plugins?.kaos;
	const manager = product?.editorBindings;
	const deviceName = product?.settings?.deviceName;
	if (!manager || typeof deviceName !== "string" || deviceName.length === 0) {
		throw new Error("s13e: atomic same-path QA readmission is unavailable");
	}
	const views = markdownViewsForPath(ctx, path);
	atomicallyReadmitSamePathPanesForQa({ manager, views, path, deviceName });
}

export const s13eSamePathAdoption: QaScenario = {
	id: SAME_PATH_ADOPTION_SCENARIO_ID,
	title: "Live-host same-path editor adoption",
	tags: ["editor", "same-path", "adoption", "reload", "conflict", "supported-host"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		evidence.clear();
		restoreArtifactCreate?.();
		restoreDistinctPaneProjection?.();
		restoreDistinctPaneProjection = null;
		await ctx.kaos.setDiskIngestSuspended(false);
		await resumeFixturePropagation(ctx);
		await closeFixtures(ctx);
		// Earlier fault-injection phases may deliberately leave Attention behind.
		// Clear only this scenario's closed fixture set before recreating it; a
		// product/user Attention entry outside these paths remains untouched.
		for (const path of SAME_PATH_ADOPTION_ALL_PATHS) {
			ctx.kaos.__qaOnlyClearMarkdownAttentionUnsafe(path);
		}
		await deleteFixtureArtifacts(ctx);
		for (const path of SAME_PATH_ADOPTION_ALL_PATHS) {
			await createConvergedFixture(ctx, path);
		}
		initialFileCount = ctx.app.vault.getFiles().length;
	},

	async run(ctx): Promise<void> {
		await prepareDetachedRemote(ctx, SAME_PATH_ADOPTION_PATHS.clean, CLEAN_REMOTE, {
			anchor: { line: CLEAN_LOCAL_LINE_INDEX, ch: CLEAN_LOCAL_LINE.length },
		});
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>(
			"clean-merge-during-planning",
		);
		await ctx.assert.fileContent(SAME_PATH_ADOPTION_PATHS.clean, CLEAN_MERGED);
		const clean = await recordPhase(
			ctx,
			"clean-merge-during-planning",
			SAME_PATH_ADOPTION_PATHS.clean,
		);
		if (
			clean.diskHash === null
			|| clean.diskHash !== clean.crdtHash
			|| clean.editorHash !== clean.diskHash
			|| clean.boundCount !== 1
		) throw new Error("s13e: clean adoption did not settle all four authorities");

		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("native-undo-local");
		await ctx.assert.fileContent(SAME_PATH_ADOPTION_PATHS.clean, CLEAN_REMOTE);
		await recordPhase(ctx, "native-undo-local", SAME_PATH_ADOPTION_PATHS.clean);

		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("native-redo-local");
		await ctx.assert.fileContent(SAME_PATH_ADOPTION_PATHS.clean, CLEAN_MERGED);
		await recordPhase(ctx, "native-redo-local", SAME_PATH_ADOPTION_PATHS.clean);

		await closeFixtures(ctx);
		await ctx.openFile(SAME_PATH_ADOPTION_PATHS.saveReload);
		await ctx.waitForCrdtBinding(SAME_PATH_ADOPTION_PATHS.saveReload, 20_000);
		await requireSupportedManagedView(ctx, SAME_PATH_ADOPTION_PATHS.saveReload);
		activeView(ctx, SAME_PATH_ADOPTION_PATHS.saveReload).editor.setCursor({
			line: 4,
			ch: "omega: base".length,
		});
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("held-save-reload");
		await ctx.assert.fileContent(
			SAME_PATH_ADOPTION_PATHS.saveReload,
			BASE.replace("omega: base", "omega: bases"),
		);
		await recordPhase(ctx, "held-save-reload", SAME_PATH_ADOPTION_PATHS.saveReload);

		await prepareDetachedRemote(ctx, SAME_PATH_ADOPTION_PATHS.conflict, CONFLICT_REMOTE, {
			anchor: { line: 3, ch: "middle: ".length },
			head: { line: 3, ch: "middle: base".length },
		});
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>(
			"overlap-conflict-evidence",
		);
		const conflictSnapshot = await waitForSnapshot(ctx, "preserved overlap conflict", (snapshot) =>
			leavesFor(snapshot, SAME_PATH_ADOPTION_PATHS.conflict).some((leaf) =>
				leaf.adoption.kind === "conflict"
				&& leaf.adoption.status === "preserved"
				&& leaf.adoption.baseRetained
				&& leaf.adoption.crdtArtifactPath !== null
				&& leaf.adoption.editorArtifactPaths.length > 0
			),
		);
		const conflictLeaf = leavesFor(conflictSnapshot, SAME_PATH_ADOPTION_PATHS.conflict)
			.find((leaf) => leaf.adoption.kind === "conflict");
		if (!conflictLeaf || conflictLeaf.adoption.kind !== "conflict") {
			throw new Error("s13e: conflict evidence disappeared");
		}
		if (activeView(ctx, SAME_PATH_ADOPTION_PATHS.conflict).editor.getValue() !== CONFLICT_LOCAL) {
			throw new Error("s13e: overlap conflict changed the editable Local primary");
		}
		await assertArtifactContent(ctx, conflictLeaf.adoption.crdtArtifactPath, CONFLICT_REMOTE);
		await assertArtifactContent(
			ctx,
			conflictLeaf.adoption.editorArtifactPaths[0] ?? null,
			CONFLICT_LOCAL,
		);
		await recordPhase(ctx, "overlap-conflict-evidence", SAME_PATH_ADOPTION_PATHS.conflict);

		await prepareDetachedRemote(
			ctx,
			SAME_PATH_ADOPTION_PATHS.artifactRetry,
			ARTIFACT_REMOTE,
			{
				anchor: { line: 3, ch: "middle: ".length },
				head: { line: 3, ch: "middle: base".length },
			},
		);
		installOneShotArtifactFailure(ctx);
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("artifact-failure");
		const failed = await waitForSnapshot(ctx, "retryable artifact failure", (snapshot) =>
			leavesFor(snapshot, SAME_PATH_ADOPTION_PATHS.artifactRetry).some((leaf) =>
				leaf.adoption.kind === "conflict"
				&& leaf.adoption.status === "preservation-failed"
				&& leaf.adoption.retryable
				&& leaf.bindingPath === null
			),
		);
		const failedSnapshot = JSON.stringify(failed);
		if (!failedSnapshot.includes("artifact-preservation-failed")) {
			throw new Error("s13e: bounded artifact failure category was not retained");
		}
		if (failedSnapshot.includes("qa-injected-adoption-artifact-failure")) {
			throw new Error("s13e: raw artifact failure text escaped into debug evidence");
		}
		await recordPhase(ctx, "artifact-failure", SAME_PATH_ADOPTION_PATHS.artifactRetry);

		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("artifact-retry");
		const retried = await waitForSnapshot(ctx, "artifact retry preservation", (snapshot) =>
			leavesFor(snapshot, SAME_PATH_ADOPTION_PATHS.artifactRetry).some((leaf) =>
				leaf.adoption.kind === "conflict"
				&& leaf.adoption.status === "preserved"
				&& leaf.adoption.crdtArtifactPath !== null
			),
		);
		const retriedLeaf = leavesFor(retried, SAME_PATH_ADOPTION_PATHS.artifactRetry)
			.find((leaf) => leaf.adoption.kind === "conflict");
		if (!retriedLeaf || retriedLeaf.adoption.kind !== "conflict") {
			throw new Error("s13e: retried conflict evidence disappeared");
		}
		await assertArtifactContent(ctx, retriedLeaf.adoption.crdtArtifactPath, ARTIFACT_REMOTE);
		await recordPhase(ctx, "artifact-retry", SAME_PATH_ADOPTION_PATHS.artifactRetry);

		await openIdenticalPanes(ctx, SAME_PATH_ADOPTION_PATHS.multiPane);
		await ctx.kaos.setDiskIngestSuspended(true);
		if (!await ctx.kaos.pauseEditorPropagation(SAME_PATH_ADOPTION_PATHS.multiPane)) {
			throw new Error("s13e: failed to detach identical multi-pane propagation");
		}
		await ctx.kaos.__qaOnlyForceCrdtContentUnsafe(
			SAME_PATH_ADOPTION_PATHS.multiPane,
			MULTI_REMOTE,
			{ originClass: "local" },
		);
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("identical-multi-pane");
		const identical = await recordPhase(
			ctx,
			"identical-multi-pane",
			SAME_PATH_ADOPTION_PATHS.multiPane,
		);
		if (identical.leafCount !== 2 || identical.boundCount !== 2) {
			throw new Error("s13e: identical panes did not share one settled authority");
		}

		await ctx.kaos.setDiskIngestSuspended(true);
		if (!await ctx.kaos.pauseEditorPropagation(SAME_PATH_ADOPTION_PATHS.multiPane)) {
			throw new Error("s13e: failed to detach distinct multi-pane propagation");
		}
		await ctx.kaos.__qaOnlyForceCrdtContentUnsafe(
			SAME_PATH_ADOPTION_PATHS.multiPane,
			MULTI_DISTINCT_REMOTE,
			{ originClass: "local" },
		);
		restoreDistinctPaneProjection = freezeSamePathPaneProjectionForQa(
			markdownViewsForPath(ctx, SAME_PATH_ADOPTION_PATHS.multiPane),
			SAME_PATH_ADOPTION_PATHS.multiPane,
		);
		try {
			await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("distinct-multi-pane");
			// Obsidian normally coalesces two open buffers for one file within its
			// native save cycle. Hold only that QA projection while the controller-
			// proven physical x/y buffers pass through the real multiple-authority
			// admission and conflict-preservation lane.
			atomicallyReadmitDistinctPanesForQa(ctx, SAME_PATH_ADOPTION_PATHS.multiPane);
			const distinctSnapshot = await waitForSnapshot(ctx, "distinct pane conflict", (snapshot) => {
				const leaves = leavesFor(snapshot, SAME_PATH_ADOPTION_PATHS.multiPane);
				return leaves.length === 2
					&& leaves.every((leaf) => leaf.bindingPath === null)
					&& leaves.some((leaf) =>
						leaf.adoption.kind === "conflict"
						&& leaf.adoption.editorArtifactPaths.length >= 2);
			});
			if (leavesFor(distinctSnapshot, SAME_PATH_ADOPTION_PATHS.multiPane)
				.some((leaf) => leaf.bindingPath !== null)) {
				throw new Error("s13e: distinct pane conflict bound a silent winner");
			}
			await recordPhase(ctx, "distinct-multi-pane", SAME_PATH_ADOPTION_PATHS.multiPane);
			await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>(
				"distinct-multi-pane-observed",
			);
		} finally {
			restoreDistinctPaneProjection?.();
			restoreDistinctPaneProjection = null;
		}

		await closeFixtures(ctx);
		await ctx.openFile(SAME_PATH_ADOPTION_PATHS.unsupportedA);
		await ctx.waitForCrdtBinding(SAME_PATH_ADOPTION_PATHS.unsupportedA, 20_000);
		await ctx.awaitExternalPhase<SamePathAdoptionExternalPhase>("unsupported-host-fallback");
		await recordPhase(ctx, "unsupported-host-fallback", SAME_PATH_ADOPTION_PATHS.unsupportedB);
	},

	async assert(ctx): Promise<void> {
		for (const phase of SAME_PATH_ADOPTION_PHASES) {
			if (!evidence.has(phase)) throw new Error(`s13e: missing evidence for ${phase}`);
		}
		if (ctx.app.vault.getFiles().length < initialFileCount) {
			throw new Error("s13e: adoption removed fixture or conflict evidence files");
		}
	},

	async cleanup(ctx): Promise<void> {
		restoreArtifactCreate?.();
		restoreDistinctPaneProjection?.();
		restoreDistinctPaneProjection = null;
		await resumeFixturePropagation(ctx);
		await ctx.kaos.setDiskIngestSuspended(false).catch(() => undefined);
		await closeFixtures(ctx);
	},
};
