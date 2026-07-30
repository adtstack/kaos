#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
	EditorHandoffReplayQaObservation,
} from "../../src/runtime/engineControlPort";
import {
	EXACT_HANDOFF_REPLAY_PATHS,
	EXACT_HANDOFF_REPLAY_SCENARIO_ID,
	type ExactHandoffReplayExternalPhase,
} from "../contracts/exact-handoff-replay";
import type { QaExternalPhaseTicket } from "../obsidian-harness/types";
import { ObsidianClient } from "./obsidian-client";

const SNAPSHOT_TIMEOUT_MS = 30_000;
const PREFLIGHT_MARKDOWN_PATH = "README.md";
type ScenarioResult = Awaited<ReturnType<ObsidianClient["runScenario"]>>;
let activeScenarioRun: Promise<ScenarioResult> | null = null;

function parseArgs(argv: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key?.startsWith("--") && value && !value.startsWith("--")) {
			parsed[key.slice(2)] = value;
			index += 1;
		}
	}
	return parsed;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function getSnapshot(client: ObsidianClient): Promise<EditorHandoffDebugSnapshot> {
	return client.evalRaw<EditorHandoffDebugSnapshot>(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug || typeof debug.getContentFreeSnapshot !== "function") {
				throw new Error("__KAOS_DEBUG__.getContentFreeSnapshot unavailable");
			}
			return debug.getContentFreeSnapshot();
		})()
	`);
}

async function waitForSnapshot(
	client: ObsidianClient,
	label: string,
	accept: (snapshot: EditorHandoffDebugSnapshot) => boolean,
	timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<EditorHandoffDebugSnapshot> {
	const startedAt = Date.now();
	let last: EditorHandoffDebugSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		last = await getSnapshot(client);
		if (accept(last)) return last;
		await delay(25);
	}
	throw new Error(
		`unsupported-host:${label}: timed out; snapshot=${JSON.stringify(last)}`,
	);
}

function requireLeaf(
	snapshot: EditorHandoffDebugSnapshot,
	predicate: (leaf: EditorHandoffManagedLeafDebugSnapshot) => boolean,
	label: string,
): EditorHandoffManagedLeafDebugSnapshot {
	const leaf = snapshot.leaves.find(predicate);
	if (!leaf) throw new Error(`unsupported-host:${label}: managed leaf unavailable`);
	return leaf;
}

async function phase<Name extends ExactHandoffReplayExternalPhase>(
	client: ObsidianClient,
	name: Name,
): Promise<QaExternalPhaseTicket<Name>> {
	const ticket = client.waitForExternalPhase(
		EXACT_HANDOFF_REPLAY_SCENARIO_ID,
		name,
		90_000,
	);
	if (!activeScenarioRun) return ticket;
	return Promise.race([
		ticket,
		activeScenarioRun.then((result): never => {
			throw new Error(
				`scenario ended before external phase ${name}: ` +
				(result.errors.join(" | ") || "unknown failure"),
			);
		}),
	]);
}

async function releaseHostLoad(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`window.__KAOS_DEBUG__?.releaseHeldHostLoad()`);
}

async function clickHeldTarget(
	client: ObsidianClient,
	phaseName: Exclude<ExactHandoffReplayExternalPhase, "native-undo" | "native-redo">,
): Promise<Readonly<{ leafId: string; before: EditorHandoffReplayQaObservation }>> {
	const paths = EXACT_HANDOFF_REPLAY_PATHS[phaseName];
	const source = await getSnapshot(client);
	const sourceLeaf = requireLeaf(
		source,
		(leaf) => leaf.viewPath === paths.a && leaf.bindingPath === paths.a,
		`${phaseName} source`,
	);
	const before = Object.freeze({ ...source.qaReplayObservation });
	await client.clickVaultFile(paths.b);
	await waitForSnapshot(client, `${phaseName} held target`, (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === paths.b
		&& snapshot.hostLoad.leafId === sourceLeaf.leafId
		&& snapshot.leaves.some((leaf) =>
			leaf.leafId === sourceLeaf.leafId
			&& leaf.viewPath === paths.b
			&& leaf.gateClosed
		),
	);
	return Object.freeze({ leafId: sourceLeaf.leafId, before });
}

async function dispatchAscii(
	client: ObsidianClient,
	leafId: string,
	key: string,
	code: string,
	windowsVirtualKeyCode: number,
): Promise<void> {
	await client.focusActiveCodeMirror();
	await client.dispatchPhysicalKey({
		key,
		code,
		text: key,
		windowsVirtualKeyCode,
	});
	await waitForSnapshot(client, `${key} input intent`, (snapshot) => {
		const leaf = snapshot.leaves.find((candidate) => candidate.leafId === leafId);
		return leaf?.intent?.originKind === "user"
			&& leaf.intent.sequenceBegan === "after-target-selected"
			&& leaf.intent.startContentHash !== leaf.intent.afterContentHash;
	});
}

function exactDelta(
	before: EditorHandoffReplayQaObservation,
	after: EditorHandoffReplayQaObservation,
): boolean {
	return after.phase === "resolved"
		&& after.planCount - before.planCount === 1
		&& after.witnessStoredCount - before.witnessStoredCount === 1
		&& after.permitConsumedCount - before.permitConsumedCount === 1
		&& after.dispatchAttemptCount - before.dispatchAttemptCount === 1
		&& after.dispatchAppliedCount - before.dispatchAppliedCount === 1
		&& after.dispatchUncertainCount === before.dispatchUncertainCount
		&& after.settlementObservationCount - before.settlementObservationCount === 1;
}

function noReplayDelta(
	before: EditorHandoffReplayQaObservation,
	after: EditorHandoffReplayQaObservation,
): boolean {
	return after.planCount === before.planCount
		&& after.witnessStoredCount === before.witnessStoredCount
		&& after.permitConsumedCount === before.permitConsumedCount
		&& after.dispatchAttemptCount === before.dispatchAttemptCount
		&& after.dispatchAppliedCount === before.dispatchAppliedCount
		&& after.dispatchUncertainCount === before.dispatchUncertainCount
		&& after.settlementObservationCount === before.settlementObservationCount;
}

type HeldTargetSettlement = Readonly<{
	leafId: string;
	targetPath: string;
	before: EditorHandoffReplayQaObservation;
}>;

function isHeldTargetHostSettled(
	snapshot: EditorHandoffDebugSnapshot,
	input: HeldTargetSettlement,
): boolean {
	const leaf = snapshot.leaves.find((candidate) => candidate.leafId === input.leafId);
	return snapshot.hostLoad?.state === "released"
		&& snapshot.hostLoad.outcome === "applied"
		&& snapshot.hostLoad.path === input.targetPath
		&& leaf?.active === true
		&& leaf.viewPath === input.targetPath
		&& leaf.displayedPath === input.targetPath
		&& leaf.bindingPath === input.targetPath
		&& !leaf.gateClosed;
}

async function waitForExactSettlement(
	client: ObsidianClient,
	label: string,
	input: HeldTargetSettlement,
	requireSelectionAndScroll = false,
): Promise<EditorHandoffDebugSnapshot> {
	return waitForSnapshot(client, label, (snapshot) => {
		const after = snapshot.qaReplayObservation;
		return exactDelta(input.before, after)
			&& isHeldTargetHostSettled(snapshot, input)
			&& (!requireSelectionAndScroll || (
				after.selectionNonEmpty
				&& after.mappedScrollAnchor !== null
				&& after.mappedScrollAnchor === after.liveScrollAnchor
			));
	});
}

async function waitForManualSettlement(
	client: ObsidianClient,
	label: string,
	input: HeldTargetSettlement,
): Promise<EditorHandoffDebugSnapshot> {
	return waitForSnapshot(client, label, (snapshot) => {
		const after = snapshot.qaReplayObservation;
		return after.phase === "needs-review"
			&& after.planCount - input.before.planCount === 1
			&& after.witnessStoredCount === input.before.witnessStoredCount
			&& after.permitConsumedCount === input.before.permitConsumedCount
			&& after.dispatchAttemptCount === input.before.dispatchAttemptCount
			&& after.dispatchAppliedCount === input.before.dispatchAppliedCount
			&& after.dispatchUncertainCount === input.before.dispatchUncertainCount
			&& isHeldTargetHostSettled(snapshot, input);
	});
}

async function waitForNoRecoveryTargetSettlement(
	client: ObsidianClient,
	label: string,
	input: Readonly<{
		leafId: string;
		targetPath: string;
		before: EditorHandoffReplayQaObservation;
	}>,
): Promise<EditorHandoffDebugSnapshot> {
	return waitForSnapshot(client, label, (snapshot) => {
		const leaf = snapshot.leaves.find((candidate) => candidate.leafId === input.leafId);
		return noReplayDelta(input.before, snapshot.qaReplayObservation)
			&& snapshot.hostLoad?.state === "released"
			&& snapshot.hostLoad.outcome === "applied"
			&& leaf?.active === true
			&& leaf.viewPath === input.targetPath
			&& leaf.displayedPath === input.targetPath
			&& leaf.bindingPath === input.targetPath
			&& leaf.presentation === "none"
			&& leaf.phase === "stable"
			&& !leaf.gateClosed
			&& leaf.intent === null;
	});
}

async function waitForAuthorityChange(
	client: ObsidianClient,
	path: string,
	previousHash: string,
): Promise<string> {
	const startedAt = Date.now();
	let last: Readonly<{ disk: string | null; crdt: string | null; editor: string | null }> | null = null;
	while (Date.now() - startedAt < SNAPSHOT_TIMEOUT_MS) {
		last = await client.evalRaw(`
			(async () => {
				const debug = window.__KAOS_DEBUG__;
				if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
				const path = ${JSON.stringify(path)};
				return {
					disk: await debug.getDiskHash(path),
					crdt: await debug.getCrdtHash(path),
					editor: await debug.getEditorHash(path),
				};
			})()
		`);
		if (
			last.disk !== null
			&& last.disk !== previousHash
			&& last.crdt === last.disk
			&& (last.editor === null || last.editor === last.disk)
		) return last.disk;
		await delay(25);
	}
	throw new Error(`unsupported-host:native history did not settle; state=${JSON.stringify(last)}`);
}

async function serviceAsciiSelectionScroll(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "exact-ascii-selection-scroll");
	await client.scrollActiveCodeMirror(560);
	await client.dragActiveCodeMirrorSelection();
	const held = await clickHeldTarget(client, "exact-ascii-selection-scroll");
	await dispatchAscii(client, held.leafId, "x", "KeyX", 88);
	await releaseHostLoad(client);
	await waitForExactSettlement(client, "ASCII exact settlement", {
		leafId: held.leafId,
		targetPath: EXACT_HANDOFF_REPLAY_PATHS["exact-ascii-selection-scroll"].b,
		before: held.before,
	}, true);
	await client.resumeExternalPhase(ticket);
}

async function serviceNativeUndo(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "native-undo");
	const path = EXACT_HANDOFF_REPLAY_PATHS["native-undo"].b;
	const before = await client.evalRaw<string>(`
		window.__KAOS_DEBUG__?.getDiskHash(${JSON.stringify(path)})
	`);
	if (!before) throw new Error("unsupported-host:native Undo baseline hash unavailable");
	await client.focusActiveCodeMirror();
	await client.dispatchNativeShortcut({
		key: "z",
		code: "KeyZ",
		windowsVirtualKeyCode: 90,
		modifiers: 4,
	});
	await waitForAuthorityChange(client, path, before);
	await client.resumeExternalPhase(ticket);
}

async function serviceNativeRedo(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "native-redo");
	const path = EXACT_HANDOFF_REPLAY_PATHS["native-redo"].b;
	const before = await client.evalRaw<string>(`
		window.__KAOS_DEBUG__?.getDiskHash(${JSON.stringify(path)})
	`);
	if (!before) throw new Error("unsupported-host:native Redo baseline hash unavailable");
	await client.focusActiveCodeMirror();
	await client.dispatchNativeShortcut({
		key: "z",
		code: "KeyZ",
		windowsVirtualKeyCode: 90,
		modifiers: 4 | 8,
	});
	await waitForAuthorityChange(client, path, before);
	await client.resumeExternalPhase(ticket);
}

async function serviceCompletedIme(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "exact-completed-ime");
	const held = await clickHeldTarget(client, "exact-completed-ime");
	await client.focusActiveCodeMirror();
	const focused = await client.getCompositionFocusState();
	if (!focused.activeElementIsCodeMirror || !focused.focusedManagedCmId) {
		throw new Error("unsupported-host:completed IME target CodeMirror is not focused");
	}
	const ownerCmId = focused.focusedManagedCmId;
	await client.setImeCompositionSequence([
		{ text: "ㅎ", selectionStart: 1, selectionEnd: 1 },
		{ text: "한", selectionStart: 1, selectionEnd: 1 },
	]);
	await waitForSnapshot(client, "completed IME final update", (snapshot) =>
		snapshot.leaves.some((leaf) =>
			leaf.leafId === held.leafId
			&& leaf.compositionActive
			&& leaf.compositionOwnerCmId === ownerCmId
			&& (leaf.activeCompositionUpdates ?? 0) >= 2
			&& (leaf.activeCompositionCapturedUpdates ?? 0) >= 2
		),
	);
	const beforeCommit = await client.getCompositionFocusState();
	if (
		!beforeCommit.compositionActive
		|| beforeCommit.compositionOwnerCmId !== ownerCmId
		|| beforeCommit.focusedManagedCmId !== ownerCmId
	) throw new Error("unsupported-host:completed IME ownership changed before commit");
	await client.commitImeText("한");
	await waitForSnapshot(client, "completed IME intent", (snapshot) => {
		const leaf = snapshot.leaves.find((candidate) => candidate.leafId === held.leafId);
		return leaf?.compositionActive === false
			&& leaf.intent?.originKind === "ime"
			&& leaf.intent.sequenceBegan === "after-target-selected"
			&& (leaf.lastComposition?.updates ?? 0) >= 2;
	});
	await releaseHostLoad(client);
	await waitForExactSettlement(client, "completed IME exact settlement", {
		leafId: held.leafId,
		targetPath: EXACT_HANDOFF_REPLAY_PATHS["exact-completed-ime"].b,
		before: held.before,
	});
	await client.resumeExternalPhase(ticket);
}

async function serviceSwitchSpanningIme(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "manual-switch-spanning-ime");
	const source = await getSnapshot(client);
	const paths = EXACT_HANDOFF_REPLAY_PATHS["manual-switch-spanning-ime"];
	const sourceLeaf = requireLeaf(
		source,
		(leaf) => leaf.viewPath === paths.a && leaf.bindingPath === paths.a,
		"switch-spanning IME source",
	);
	const before = Object.freeze({ ...source.qaReplayObservation });
	const sourceHashBefore = await client.evalRaw<string | null>(`
		window.__KAOS_DEBUG__?.getDiskHash(${JSON.stringify(paths.a)}) ?? null
	`);
	if (!sourceHashBefore) {
		throw new Error("unsupported-host:switch-spanning IME source hash unavailable");
	}
	await client.focusActiveCodeMirror();
	const initialFocus = await client.getCompositionFocusState();
	const ownerCmId = initialFocus.focusedManagedCmId;
	if (!initialFocus.activeElementIsCodeMirror || !ownerCmId) {
		throw new Error("unsupported-host:switch-spanning IME source is not focused");
	}
	await client.setImeCompositionSequence([
		{ text: "ㅎ", selectionStart: 1, selectionEnd: 1 },
		{ text: "한", selectionStart: 1, selectionEnd: 1 },
	]);
	await waitForSnapshot(client, "switch-spanning IME source update", (snapshot) =>
		snapshot.leaves.some((leaf) =>
			leaf.leafId === sourceLeaf.leafId
			&& leaf.compositionActive
			&& leaf.compositionOwnerCmId === ownerCmId
			&& (leaf.activeCompositionUpdates ?? 0) >= 2
		),
	);
	await client.clickVaultFile(paths.b);
	const held = await waitForSnapshot(client, "switch-spanning IME held target", (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === paths.b
		&& snapshot.hostLoad.leafId === sourceLeaf.leafId,
	);
	const afterClickFocus = await client.getCompositionFocusState();
	if (afterClickFocus.compositionActive) {
		if (
			afterClickFocus.compositionOwnerCmId !== ownerCmId
			|| afterClickFocus.focusedManagedCmId !== ownerCmId
			|| !afterClickFocus.activeElementIsCodeMirror
		) throw new Error("unsupported-host:switch-spanning IME lost its exact owner");
		await client.commitImeText("한");
	} else {
		const leaf = requireLeaf(
			held,
			(candidate) => candidate.leafId === sourceLeaf.leafId,
			"host-ended switch-spanning IME",
		);
		const hostEndedManual = leaf.intent?.originKind === "ime"
			&& leaf.intent.sequenceBegan === "before-handoff"
			&& (leaf.lastComposition?.updates ?? 0) >= 2;
		const samePathCompletion = leaf.intent === null
			&& leaf.generation === sourceLeaf.generation + 1
			&& leaf.presentation === "source"
			&& leaf.phase === "awaiting-host-load"
			&& leaf.gateClosed
			&& leaf.sourceUnload?.state === "settled"
			&& leaf.sourceUnload.forcedSaveObserved
			&& leaf.lastComposition?.startGeneration === sourceLeaf.generation
			&& leaf.lastComposition.endGeneration === sourceLeaf.generation
			&& leaf.lastComposition.updates >= 2
			&& !leaf.lastComposition.replayEligible;
		if (!hostEndedManual && !samePathCompletion) {
			throw new Error(
				"unsupported-host:host-ended IME is neither manual nor exact same-path completion; "
				+ `focus=${JSON.stringify(afterClickFocus)}; `
				+ `hostLoad=${JSON.stringify(held.hostLoad)}; `
				+ `leaf=${JSON.stringify(leaf)}`,
			);
		}
		if (hostEndedManual) {
			await releaseHostLoad(client);
			await waitForManualSettlement(client, "host-ended switch-spanning IME manual settlement", {
				leafId: sourceLeaf.leafId,
				targetPath: paths.b,
				before,
			});
			await client.resumeExternalPhase(ticket);
			return;
		}
		await waitForAuthorityChange(client, paths.a, sourceHashBefore);
		await releaseHostLoad(client);
		await waitForNoRecoveryTargetSettlement(
			client,
			"pre-switch IME target settlement",
			{ leafId: sourceLeaf.leafId, targetPath: paths.b, before },
		);
		await client.resumeExternalPhase(ticket);
		return;
	}
	await releaseHostLoad(client);
	await waitForManualSettlement(client, "switch-spanning IME manual settlement", {
		leafId: sourceLeaf.leafId,
		targetPath: paths.b,
		before,
	});
	await client.resumeExternalPhase(ticket);
}

async function serviceManualDifferentBase(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "manual-different-base");
	const held = await clickHeldTarget(client, "manual-different-base");
	await dispatchAscii(client, held.leafId, "d", "KeyD", 68);
	await releaseHostLoad(client);
	await waitForManualSettlement(client, "different-base manual settlement", {
		leafId: held.leafId,
		targetPath: EXACT_HANDOFF_REPLAY_PATHS["manual-different-base"].b,
		before: held.before,
	});
	await client.resumeExternalPhase(ticket);
}

async function serviceMissingYText(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "exact-missing-ytext");
	const held = await clickHeldTarget(client, "exact-missing-ytext");
	await dispatchAscii(client, held.leafId, "m", "KeyM", 77);
	await releaseHostLoad(client);
	await waitForExactSettlement(client, "missing-Y.Text exact settlement", {
		leafId: held.leafId,
		targetPath: EXACT_HANDOFF_REPLAY_PATHS["exact-missing-ytext"].b,
		before: held.before,
	});
	await client.resumeExternalPhase(ticket);
}

async function serviceHeldSameContent(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "exact-same-content-held-load");
	const held = await clickHeldTarget(client, "exact-same-content-held-load");
	await dispatchAscii(client, held.leafId, "y", "KeyY", 89);
	const gated = await getSnapshot(client);
	if (
		gated.hostLoad?.state !== "held"
		|| gated.qaReplayObservation.dispatchAttemptCount !== held.before.dispatchAttemptCount
	) throw new Error("unsupported-host:held target dispatched before target-ready");
	await releaseHostLoad(client);
	await waitForExactSettlement(client, "held same-content exact settlement", {
		leafId: held.leafId,
		targetPath: EXACT_HANDOFF_REPLAY_PATHS["exact-same-content-held-load"].b,
		before: held.before,
	});
	await client.resumeExternalPhase(ticket);
}

async function serviceSupersession(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "supersede-b-with-c");
	const paths = EXACT_HANDOFF_REPLAY_PATHS["supersede-b-with-c"];
	if (paths.c === null) throw new Error("supersession path C is unavailable");
	const held = await clickHeldTarget(client, "supersede-b-with-c");
	await dispatchAscii(client, held.leafId, "q", "KeyQ", 81);
	await client.clickVaultFile(paths.c);
	await waitForSnapshot(client, "C selected before B release", (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.leaves.some((leaf) =>
			leaf.leafId === held.leafId
			&& leaf.viewPath === paths.c
		),
	);
	await releaseHostLoad(client);
	await waitForSnapshot(client, "superseded B terminal rejection", (snapshot) =>
		snapshot.hostLoad?.state === "rejected"
		&& snapshot.hostLoad.path === paths.b
		&& snapshot.qaReplayObservation.witnessStoredCount === held.before.witnessStoredCount
		&& snapshot.qaReplayObservation.permitConsumedCount === held.before.permitConsumedCount
		&& snapshot.qaReplayObservation.dispatchAttemptCount === held.before.dispatchAttemptCount
		&& snapshot.leaves.some((leaf) =>
			leaf.leafId === held.leafId
			&& leaf.viewPath === paths.c
			&& leaf.bindingPath !== paths.b
		),
	);
	await client.resumeExternalPhase(ticket);
}

async function assertLivePreflight(client: ObsidianClient): Promise<void> {
	const initial = await getSnapshot(client);
	if (!initial.leaves.some((leaf) => leaf.managed && leaf.active)) {
		await client.clickVaultFile(PREFLIGHT_MARKDOWN_PATH);
		await waitForSnapshot(client, "managed markdown preflight", (snapshot) =>
			snapshot.leaves.some((leaf) =>
				leaf.managed
				&& leaf.active
				&& leaf.viewPath === PREFLIGHT_MARKDOWN_PATH
			),
		);
	}
	await waitForSnapshot(client, "managed host capability preflight", (snapshot) =>
		snapshot.leaves.some((leaf) =>
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

async function canonicalPath(path: string): Promise<string> {
	return realpath(resolve(path));
}

async function abortActiveRun(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`
		window.__KAOS_QA__?.run("__controller-abort__", { timeoutMs: 1 })
	`).catch(() => undefined);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const port = Number(args.port ?? 9222);
	if (!args.vault) {
		throw new Error(
			"Usage: bun run qa/controllers/exact-handoff-replay.ts " +
			"--port 9222 --vault /absolute/disposable-vault",
		);
	}
	const expectedVault = await canonicalPath(args.vault);
	const client = new ObsidianClient({
		port,
		host: "127.0.0.1",
		transport: "raw-page",
	});
	let runPromise: Promise<ScenarioResult> | null = null;

	try {
		await client.connect();
		await client.waitForQaReady(30_000);
		const liveVault = await client.evalRaw<string>(`
			(() => {
				const basePath = window.app?.vault?.adapter?.basePath;
				if (typeof basePath !== "string" || basePath.length === 0) {
					throw new Error("live adapter base path unavailable");
				}
				return basePath;
			})()
		`);
		const canonicalLiveVault = await canonicalPath(liveVault);
		if (canonicalLiveVault !== expectedVault) {
			throw new Error(
				`vault mismatch: controller=${expectedVault}, live=${canonicalLiveVault}`,
			);
		}
		// This read-only gate runs before runScenario, fixture writes, or CDP input.
		await assertLivePreflight(client);

		runPromise = client.runScenario(EXACT_HANDOFF_REPLAY_SCENARIO_ID, { timeoutMs: 360_000 });
		activeScenarioRun = runPromise;
		await serviceAsciiSelectionScroll(client);
		await serviceNativeUndo(client);
		await serviceNativeRedo(client);
		await serviceCompletedIme(client);
		await serviceSwitchSpanningIme(client);
		await serviceManualDifferentBase(client);
		await serviceMissingYText(client);
		await serviceHeldSameContent(client);
		await serviceSupersession(client);

		const result = await runPromise;
		if (!result.passed) {
			throw new Error(
				`scenario failed: ${result.errors.join(" | ") || "unknown failure"}; ` +
				`warnings=${result.warnings.join(" | ")}`,
			);
		}
		console.log(
			`PASS ${EXACT_HANDOFF_REPLAY_SCENARIO_ID} (${result.durationMs}ms): ` +
			"all nine content-free physical-input phases settled",
		);
	} catch (error) {
		if (runPromise) {
			await abortActiveRun(client);
			await runPromise.catch(() => undefined);
		}
		throw error;
	} finally {
		activeScenarioRun = null;
		await client.close();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
