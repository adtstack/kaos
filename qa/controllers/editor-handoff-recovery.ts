#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
	HandoffRecoveryQaAcceptedState,
	HandoffRecoveryQaFault,
	HandoffRecoveryQaInventory,
	HandoffRecoveryQaInventoryRow,
	HandoffRecoveryQaSnapshot,
} from "../../src/runtime/engineControlPort";
import type {
	HandoffRecoveryExternalPhaseName,
	HandoffRecoveryReloadExternalPhaseName,
	QaExternalPhaseTicket,
} from "../obsidian-harness/types";
import { ObsidianClient } from "./obsidian-client";

const LIVE_SCENARIO_ID = "s13b-editor-handoff-recovery";
const RELOAD_SCENARIO_ID = "s13c-editor-handoff-recovery-reload";
const EXPORT_PATH = "QA-scratch/Handoff Recovery Export.md";
const RELOAD_EXPORT_PATH = "QA-scratch/Handoff Recovery Reload Export.md";
const RETAINED_FROM_PATH = "QA-handoff-recovery-quota-A.md";
const RETAINED_TARGET_PATH = "QA-handoff-recovery-quota-B.md";
const SNAPSHOT_TIMEOUT_MS = 25_000;

type ScenarioResult = Awaited<ReturnType<ObsidianClient["runScenario"]>>;

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

async function getHandoffSnapshot(
	client: ObsidianClient,
): Promise<EditorHandoffDebugSnapshot> {
	return client.evalRaw<EditorHandoffDebugSnapshot>(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
			return debug.getEditorHandoffDebugSnapshot();
		})()
	`);
}

async function getRecoverySnapshot(
	client: ObsidianClient,
): Promise<HandoffRecoveryQaSnapshot> {
	return client.evalRaw<HandoffRecoveryQaSnapshot>(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
			return debug.getHandoffRecoveryQaSnapshot();
		})()
	`);
}

type RecoveryInventoryBaseline = Readonly<{
	targetRecordId: string;
	targetCoreFingerprint: string;
	targetActiveFingerprint: string;
	unrelatedActiveFingerprints: readonly string[];
	unrelatedTerminalFingerprints: readonly string[];
}>;

function recoveryInventoryRowFingerprint(row: HandoffRecoveryQaInventoryRow): string {
	return JSON.stringify([
		row.recordId,
		row.intentId,
		row.intentEnvelopeHash,
		row.fromPath,
		row.targetPath,
		row.status,
		row.disposition,
		row.startContentHash,
		row.afterContentHash,
	]);
}

function recoveryInventoryRowCoreFingerprint(row: HandoffRecoveryQaInventoryRow): string {
	return JSON.stringify([
		row.recordId,
		row.intentId,
		row.intentEnvelopeHash,
		row.fromPath,
		row.targetPath,
		row.startContentHash,
		row.afterContentHash,
	]);
}

function sortedRecoveryFingerprints(
	rows: readonly HandoffRecoveryQaInventoryRow[],
): readonly string[] {
	return rows.map(recoveryInventoryRowFingerprint).sort();
}

async function captureRecoveryInventory(
	client: ObsidianClient,
): Promise<HandoffRecoveryQaInventory> {
	const inventory = await client.evalRaw<HandoffRecoveryQaInventory>(`
		(async () => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
			return await debug.getHandoffRecoveryQaInventory();
		})()
	`);
	const encoded = JSON.stringify(inventory);
	if (
		/"(?:body|startContent|afterContent|serializedChanges|serializedSelectionBefore|serializedSelectionAfter|checksum)"/.test(encoded)
	) throw new Error("Recovery inventory exposed content or a storage checksum");
	return inventory;
}

function createRecoveryInventoryBaseline(
	inventory: HandoffRecoveryQaInventory,
): RecoveryInventoryBaseline {
	const targets = inventory.active.filter((row) =>
		row.fromPath === RETAINED_FROM_PATH
		&& row.targetPath === RETAINED_TARGET_PATH
		&& row.status === "needs-review"
	);
	if (targets.length !== 1 || !targets[0]) {
		throw new Error(`expected one retained Recovery target in inventory; observed=${targets.length}`);
	}
	const target = targets[0];
	return Object.freeze({
		targetRecordId: target.recordId,
		targetCoreFingerprint: recoveryInventoryRowCoreFingerprint(target),
		targetActiveFingerprint: recoveryInventoryRowFingerprint(target),
		unrelatedActiveFingerprints: sortedRecoveryFingerprints(
			inventory.active.filter((row) => row.recordId !== target.recordId),
		),
		unrelatedTerminalFingerprints: sortedRecoveryFingerprints(inventory.terminal),
	});
}

function assertUnrelatedRecoveryInventoryPreserved(
	label: string,
	baseline: RecoveryInventoryBaseline,
	inventory: HandoffRecoveryQaInventory,
	targetState: "active" | "resolved",
): void {
	const unrelatedActive = sortedRecoveryFingerprints(
		inventory.active.filter((row) => row.recordId !== baseline.targetRecordId),
	);
	const unrelatedTerminal = sortedRecoveryFingerprints(
		inventory.terminal.filter((row) => row.recordId !== baseline.targetRecordId),
	);
	if (
		JSON.stringify(unrelatedActive) !== JSON.stringify(baseline.unrelatedActiveFingerprints)
		|| JSON.stringify(unrelatedTerminal)
			!== JSON.stringify(baseline.unrelatedTerminalFingerprints)
	) {
		throw new Error(
			`${label}: unrelated Recovery inventory changed; ` +
			`active=${baseline.unrelatedActiveFingerprints.length}->${unrelatedActive.length}, ` +
			`terminal=${baseline.unrelatedTerminalFingerprints.length}->${unrelatedTerminal.length}`,
		);
	}
	const activeTarget = inventory.active.filter(
		(row) => row.recordId === baseline.targetRecordId,
	);
	const terminalTarget = inventory.terminal.filter(
		(row) => row.recordId === baseline.targetRecordId,
	);
	if (targetState === "active") {
		if (
			activeTarget.length !== 1
			|| terminalTarget.length !== 0
			|| recoveryInventoryRowFingerprint(activeTarget[0]!)
				!== baseline.targetActiveFingerprint
		) throw new Error(`${label}: retained Recovery target did not remain exact and active`);
		return;
	}
	if (
		activeTarget.length !== 0
		|| terminalTarget.length !== 1
		|| terminalTarget[0]!.status !== "resolved"
		|| terminalTarget[0]!.disposition !== "manual-resolution"
		|| recoveryInventoryRowCoreFingerprint(terminalTarget[0]!)
			!== baseline.targetCoreFingerprint
	) throw new Error(`${label}: retained Recovery target did not become its exact resolved receipt`);
}

function currentIntentLeaf(
	snapshot: EditorHandoffDebugSnapshot,
	predicate: (leaf: EditorHandoffManagedLeafDebugSnapshot) => boolean = () => true,
): EditorHandoffManagedLeafDebugSnapshot | null {
	return snapshot.leaves.find((leaf) => leaf.intent !== null && predicate(leaf)) ?? null;
}

function terminalLeafReleased(
	snapshot: EditorHandoffDebugSnapshot,
	leafId: string,
	targetPath: string,
	terminalState: "escaped" | "discarded",
): boolean {
	const leaf = snapshot.leaves.find((candidate) => candidate.leafId === leafId);
	if (!leaf || leaf.gateClosed) return false;
	if (leaf.intent?.state === terminalState) return true;
	return leaf.intent === null
		&& leaf.bindingPath === targetPath
		&& leaf.presentation === "none"
		&& leaf.phase === "stable";
}

function acceptedStateMatches(
	receipt: HandoffRecoveryQaAcceptedState | null,
	expected: Readonly<{
		afterSequence: number;
		leafId: string;
		intentId: string;
		targetPath: string;
		afterContentHash: string;
		afterRecoveryOperationEpoch: number;
		state: "escaped" | "discarded";
		action: "copy" | "export" | "discard";
	}>,
): receipt is HandoffRecoveryQaAcceptedState {
	return receipt !== null
		&& receipt.sequence > expected.afterSequence
		&& receipt.leafId === expected.leafId
		&& receipt.intentId === expected.intentId
		&& receipt.targetPath === expected.targetPath
		&& receipt.afterContentHash === expected.afterContentHash
		&& receipt.recoveryOperationEpoch > expected.afterRecoveryOperationEpoch
		&& receipt.state === expected.state
		&& receipt.action === expected.action;
}

async function waitForState(
	client: ObsidianClient,
	label: string,
	accept: (
		handoff: EditorHandoffDebugSnapshot,
		recovery: HandoffRecoveryQaSnapshot,
	) => boolean,
	timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<Readonly<{
	handoff: EditorHandoffDebugSnapshot;
	recovery: HandoffRecoveryQaSnapshot;
}>> {
	const startedAt = Date.now();
	let lastHandoff: EditorHandoffDebugSnapshot | null = null;
	let lastRecovery: HandoffRecoveryQaSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		[lastHandoff, lastRecovery] = await Promise.all([
			getHandoffSnapshot(client),
			getRecoverySnapshot(client),
		]);
		if (accept(lastHandoff, lastRecovery)) {
			return Object.freeze({ handoff: lastHandoff, recovery: lastRecovery });
		}
		await delay(25);
	}
	throw new Error(
		`unsupported-host:${label}: timed out; ` +
		`handoff=${JSON.stringify(lastHandoff)}; recovery=${JSON.stringify(lastRecovery)}`,
	);
}

async function armFault(
	client: ObsidianClient,
	fault: HandoffRecoveryQaFault,
): Promise<void> {
	await client.evalRaw(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
			debug.__qaOnlyArmHandoffRecoveryFaultUnsafe(${JSON.stringify(fault)});
		})()
	`);
}

async function releaseHostLoad(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`window.__KAOS_DEBUG__?.releaseHeldHostLoad()`);
}

async function releaseHeldPut(
	client: ObsidianClient,
	operationId: string,
): Promise<void> {
	await client.evalRaw(`
		window.__KAOS_DEBUG__?.__qaOnlyReleaseHeldHandoffRecoveryPutUnsafe(
			${JSON.stringify(operationId)}
		)
	`);
}

async function physicalKey(
	client: ObsidianClient,
	input: { key: string; code: string; text: string; windowsVirtualKeyCode: number },
): Promise<void> {
	await client.focusActiveCodeMirror();
	await client.dispatchPhysicalKey(input);
}

async function awaitPhase<Name extends string>(
	client: ObsidianClient,
	scenarioId: string,
	name: Name,
	run: Promise<ScenarioResult>,
): Promise<QaExternalPhaseTicket<Name>> {
	return Promise.race([
		client.waitForExternalPhase(scenarioId, name, 75_000),
		run.then((result): never => {
			throw new Error(
				`scenario ended before external phase ${name}: ` +
				`${result.errors.join(" | ") || "unknown failure"}`,
			);
		}),
	]);
}

async function resumePhase<Name extends string>(
	client: ObsidianClient,
	ticket: QaExternalPhaseTicket<Name>,
): Promise<void> {
	await client.resumeExternalPhase(ticket);
}

async function serviceQuotaFailureAndRetry(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
): Promise<string> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"quota-failed-retry",
		run,
	);
	const held = await waitForState(client, "quota host hold", (handoff) =>
		handoff.hostLoad?.state === "held" && handoff.hostLoad.path.endsWith("quota-B.md"),
	);
	const leafId = held.handoff.hostLoad?.leafId;
	if (!leafId) throw new Error("unsupported-host:quota phase has no leaf ID");
	await armFault(client, { kind: "fail-next-put", reason: "quota-exceeded" });
	await physicalKey(client, {
		key: "q",
		code: "KeyQ",
		text: "q",
		windowsVirtualKeyCode: 81,
	});
	const failed = await waitForState(client, "quota failure gate", (handoff, recovery) => {
		const leaf = handoff.leaves.find((candidate) => candidate.leafId === leafId);
		return leaf?.intent?.state === "failed"
			&& leaf.gateClosed
			&& recovery.lastCategoricalOutcome === "quota-exceeded";
	});
	const failedIntent = failed.handoff.leaves.find(
		(candidate) => candidate.leafId === leafId,
	)?.intent;
	if (
		!failedIntent
		|| failedIntent.targetPath !== "QA-handoff-recovery-quota-B.md"
		|| failedIntent.intentId.length === 0
		|| failedIntent.afterContentHash.length === 0
	) throw new Error("quota failure lost its exact content-free intent identity");
	await releaseHostLoad(client);
	await waitForState(client, "quota target presentation", (handoff) => {
		const leaf = handoff.leaves.find((candidate) => candidate.leafId === leafId);
		return (handoff.hostLoad?.state === "released" || handoff.hostLoad?.state === "rejected")
			&& leaf?.presentation === "target-proven"
			&& leaf.intent?.state === "failed";
	});
	await client.clickExactVisibleButton("Retry");
	await waitForState(client, "quota manual row", (handoff) => {
		const leaf = handoff.leaves.find((candidate) => candidate.leafId === leafId);
		const transientManual = leaf?.intent?.state === "needs-review"
			&& leaf.gateClosed === false
			&& (leaf.recoveryOperationEpoch ?? 0) >= 1;
		const settledManual = leaf?.intent === null
			&& leaf?.bindingPath === "QA-handoff-recovery-quota-B.md"
			&& leaf.presentation === "none"
			&& leaf.phase === "stable"
			&& leaf.gateClosed === false
			&& handoff.qaReplayObservation.phase === "needs-review";
		return transientManual || settledManual;
	});
	await resumePhase(client, ticket);
	return failedIntent.afterContentHash;
}

async function serviceHungCopyFailure(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
): Promise<void> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"hung-put-copy-failure",
		run,
	);
	await armFault(client, {
		kind: "hold-next-post-verify-put",
		operationId: "copy-late-put",
	});
	await physicalKey(client, {
		key: "w",
		code: "KeyW",
		text: "w",
		windowsVirtualKeyCode: 87,
	});
	const held = await waitForState(client, "copy post-verify hold", (handoff, recovery) =>
		recovery.heldOperationId === "copy-late-put"
		&& currentIntentLeaf(handoff)?.intent?.state === "persisting",
	);
	const leafId = currentIntentLeaf(held.handoff)?.leafId;
	if (!leafId) throw new Error("copy hold lost its leaf identity");
	await releaseHostLoad(client);
	await waitForState(client, "copy held target", (handoff) => {
		const leaf = handoff.leaves.find((candidate) => candidate.leafId === leafId);
		return leaf?.presentation === "target-proven" && leaf.intent?.state === "persisting";
	});
	await armFault(client, { kind: "fail-next-copy", reason: "clipboard-rejected" });
	await client.clickExactVisibleButton("Copy and continue");
	await waitForState(client, "copy rejection", (handoff, recovery) => {
		const leaf = handoff.leaves.find((candidate) => candidate.leafId === leafId);
		return leaf?.intent?.state === "failed"
			&& leaf.gateClosed
			&& recovery.heldOperationId === "copy-late-put"
			&& recovery.lastCategoricalOutcome === "clipboard-rejected";
	});
	await resumePhase(client, ticket);
}

async function serviceHungCopySuccess(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
): Promise<HandoffRecoveryQaAcceptedState> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"hung-put-copy-success",
		run,
	);
	const before = await waitForState(client, "copy retry action", (handoff, recovery) =>
		currentIntentLeaf(handoff)?.intent?.state === "failed"
		&& recovery.heldOperationId === "copy-late-put",
	);
	const leafId = currentIntentLeaf(before.handoff)?.leafId;
	const priorEpoch = currentIntentLeaf(before.handoff)?.recoveryOperationEpoch ?? -1;
	const failedIntent = currentIntentLeaf(before.handoff)?.intent;
	const priorSequence = before.recovery.lastAcceptedState?.sequence ?? 0;
	if (!leafId || !failedIntent) throw new Error("copy retry action lost its exact intent identity");
	await client.clickExactVisibleButton("Copy and continue");
	const accepted = await waitForState(client, "copy success", (handoff, recovery) => {
		return terminalLeafReleased(
			handoff,
			leafId,
			"QA-handoff-recovery-copy-B.md",
			"escaped",
		)
			&& acceptedStateMatches(recovery.lastAcceptedState, {
				afterSequence: priorSequence,
				leafId,
				intentId: failedIntent.intentId,
				targetPath: "QA-handoff-recovery-copy-B.md",
				afterContentHash: failedIntent.afterContentHash,
				afterRecoveryOperationEpoch: priorEpoch,
				state: "escaped",
				action: "copy",
			})
			&& recovery.heldOperationId === "copy-late-put"
			&& recovery.lastCategoricalOutcome === "clipboard-written";
	});
	await resumePhase(client, ticket);
	return accepted.recovery.lastAcceptedState!;
}

async function serviceReleaseCopyLatePut(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
	expectedReceipt: HandoffRecoveryQaAcceptedState,
): Promise<void> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"release-copy-late-put",
		run,
	);
	const before = await getRecoverySnapshot(client);
	await releaseHeldPut(client, "copy-late-put");
	await waitForState(client, "copy late-put fence", (handoff, recovery) =>
		recovery.heldOperationId === null
		&& recovery.putSettledCount === before.putSettledCount + 1
		&& recovery.lastAcceptedState?.sequence === expectedReceipt.sequence
		&& recovery.lastAcceptedState.intentId === expectedReceipt.intentId
		&& recovery.lastAcceptedState.recoveryOperationEpoch
			=== expectedReceipt.recoveryOperationEpoch
		&& terminalLeafReleased(
			handoff,
			expectedReceipt.leafId,
			expectedReceipt.targetPath,
			"escaped",
		),
	);
	await delay(100);
	await resumePhase(client, ticket);
}

async function serviceVerifiedExport(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
	vaultRoot: string,
): Promise<void> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"verified-export",
		run,
	);
	await armFault(client, {
		kind: "hold-next-post-verify-put",
		operationId: "export-late-put",
	});
	await physicalKey(client, {
		key: "e",
		code: "KeyE",
		text: "e",
		windowsVirtualKeyCode: 69,
	});
	const held = await waitForState(client, "export post-verify hold", (handoff, recovery) =>
		recovery.heldOperationId === "export-late-put"
		&& currentIntentLeaf(handoff)?.intent?.state === "persisting",
	);
	const heldLeaf = currentIntentLeaf(held.handoff);
	const leafId = heldLeaf?.leafId;
	const intent = heldLeaf?.intent;
	const priorEpoch = heldLeaf?.recoveryOperationEpoch ?? -1;
	const priorSequence = held.recovery.lastAcceptedState?.sequence ?? 0;
	if (!leafId || !intent) throw new Error("export hold lost its exact intent identity");
	await releaseHostLoad(client);
	await waitForState(client, "export target", (handoff) =>
		handoff.leaves.some((leaf) =>
			leaf.leafId === leafId
			&& leaf.presentation === "target-proven"
			&& leaf.intent?.state === "persisting"),
	);
	await client.clickExactVisibleButton("Export and continue");
	await client.fillVisibleHandoffRecoveryExportPath(EXPORT_PATH);
	await client.clickExactVisibleModalButton("Export");
	const escaped = await waitForState(client, "verified export escape", (handoff, recovery) =>
		terminalLeafReleased(
			handoff,
			leafId,
			"QA-handoff-recovery-export-B.md",
			"escaped",
		) && acceptedStateMatches(recovery.lastAcceptedState, {
			afterSequence: priorSequence,
			leafId,
			intentId: intent.intentId,
			targetPath: "QA-handoff-recovery-export-B.md",
			afterContentHash: intent.afterContentHash,
			afterRecoveryOperationEpoch: priorEpoch,
			state: "escaped",
			action: "export",
		}),
	);
	const acceptedReceipt = escaped.recovery.lastAcceptedState!;
	const expectedHash = acceptedReceipt.afterContentHash;
	await verifyExportFile(vaultRoot, EXPORT_PATH, expectedHash);
	await releaseHeldPut(client, "export-late-put");
	await waitForState(client, "export late-put fence", (handoff, recovery) =>
		recovery.heldOperationId === null
		&& recovery.lastAcceptedState?.sequence === acceptedReceipt.sequence
		&& recovery.lastAcceptedState.intentId === acceptedReceipt.intentId
		&& terminalLeafReleased(
			handoff,
			leafId,
			"QA-handoff-recovery-export-B.md",
			"escaped",
		),
	);
	await resumePhase(client, ticket);
}

async function serviceConfirmedDiscard(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
): Promise<void> {
	const ticket = await awaitPhase<HandoffRecoveryExternalPhaseName>(
		client,
		LIVE_SCENARIO_ID,
		"confirmed-discard",
		run,
	);
	await armFault(client, {
		kind: "hold-next-post-verify-put",
		operationId: "discard-late-put",
	});
	await physicalKey(client, {
		key: "d",
		code: "KeyD",
		text: "d",
		windowsVirtualKeyCode: 68,
	});
	const held = await waitForState(client, "discard post-verify hold", (handoff, recovery) =>
		recovery.heldOperationId === "discard-late-put"
		&& currentIntentLeaf(handoff)?.intent?.state === "persisting",
	);
	const heldLeaf = currentIntentLeaf(held.handoff);
	const leafId = heldLeaf?.leafId;
	const intent = heldLeaf?.intent;
	const priorEpoch = heldLeaf?.recoveryOperationEpoch ?? -1;
	const priorSequence = held.recovery.lastAcceptedState?.sequence ?? 0;
	if (!leafId || !intent) throw new Error("discard hold lost its exact intent identity");
	await releaseHostLoad(client);
	await waitForState(client, "discard target", (handoff) =>
		handoff.leaves.some((leaf) =>
			leaf.leafId === leafId
			&& leaf.presentation === "target-proven"
			&& leaf.intent?.state === "persisting"),
	);
	await client.clickExactVisibleButton("Discard and continue");
	await client.clickExactVisibleModalButton("Discard");
	const discarded = await waitForState(client, "confirmed discard escape", (handoff, recovery) =>
		terminalLeafReleased(
			handoff,
			leafId,
			"QA-handoff-recovery-discard-B.md",
			"discarded",
		) && acceptedStateMatches(recovery.lastAcceptedState, {
			afterSequence: priorSequence,
			leafId,
			intentId: intent.intentId,
			targetPath: "QA-handoff-recovery-discard-B.md",
			afterContentHash: intent.afterContentHash,
			afterRecoveryOperationEpoch: priorEpoch,
			state: "discarded",
			action: "discard",
		}),
	);
	const acceptedReceipt = discarded.recovery.lastAcceptedState!;
	await releaseHeldPut(client, "discard-late-put");
	await waitForState(client, "discard late-put fence", (handoff, recovery) =>
		recovery.heldOperationId === null
		&& recovery.lastAcceptedState?.sequence === acceptedReceipt.sequence
		&& recovery.lastAcceptedState.intentId === acceptedReceipt.intentId
		&& terminalLeafReleased(
			handoff,
			leafId,
			"QA-handoff-recovery-discard-B.md",
			"discarded",
		),
	);
	await resumePhase(client, ticket);
}

async function serviceReloadDashboardReview(
	client: ObsidianClient,
	run: Promise<ScenarioResult>,
	vaultRoot: string,
	retainedHash: string,
): Promise<RecoveryInventoryBaseline> {
	const ticket = await awaitPhase<HandoffRecoveryReloadExternalPhaseName>(
		client,
		RELOAD_SCENARIO_ID,
		"hydrated-dashboard-review",
		run,
	);
	const inventoryBaseline = createRecoveryInventoryBaseline(
		await captureRecoveryInventory(client),
	);
	await client.clickKaosDashboardRibbon();
	await client.waitForHandoffRecoveryRow(
		RETAINED_FROM_PATH,
		RETAINED_TARGET_PATH,
		true,
		30_000,
	);
	await client.clickHandoffRecoveryRowButton(
		RETAINED_FROM_PATH,
		RETAINED_TARGET_PATH,
		"Compare / apply manually",
	);
	await client.waitForVisibleText(
		".kaos-handoff-recovery-compare-modal",
		"Handoff recovery comparison",
	);
	await client.clickExactVisibleButton("Copy successor");
	await delay(150);
	await client.clickExactVisibleButton("Close");
	await client.waitForHandoffRecoveryRow(RETAINED_FROM_PATH, RETAINED_TARGET_PATH, true);
	assertUnrelatedRecoveryInventoryPreserved(
		"after-compare",
		inventoryBaseline,
		await captureRecoveryInventory(client),
		"active",
	);
	await client.clickHandoffRecoveryRowButton(
		RETAINED_FROM_PATH,
		RETAINED_TARGET_PATH,
		"Copy",
	);
	await delay(150);
	await client.waitForHandoffRecoveryRow(RETAINED_FROM_PATH, RETAINED_TARGET_PATH, true);
	assertUnrelatedRecoveryInventoryPreserved(
		"after-copy",
		inventoryBaseline,
		await captureRecoveryInventory(client),
		"active",
	);
	await client.clickHandoffRecoveryRowButton(
		RETAINED_FROM_PATH,
		RETAINED_TARGET_PATH,
		"Export",
	);
	await client.fillVisibleHandoffRecoveryExportPath(RELOAD_EXPORT_PATH);
	await client.clickExactVisibleModalButton("Export");
	await verifyExportFile(vaultRoot, RELOAD_EXPORT_PATH, retainedHash);
	await client.waitForHandoffRecoveryRow(RETAINED_FROM_PATH, RETAINED_TARGET_PATH, true);
	assertUnrelatedRecoveryInventoryPreserved(
		"after-export",
		inventoryBaseline,
		await captureRecoveryInventory(client),
		"active",
	);
	await client.clickHandoffRecoveryRowButton(
		RETAINED_FROM_PATH,
		RETAINED_TARGET_PATH,
		"Resolve",
	);
	await client.clickExactVisibleModalButton("Resolve");
	await client.waitForHandoffRecoveryRow(RETAINED_FROM_PATH, RETAINED_TARGET_PATH, false);
	await client.waitForVisibleText(
		".kaos-dashboard-handoff-recovery-section",
		`${inventoryBaseline.unrelatedTerminalFingerprints.length + 1} ` +
			"content-free completion receipt(s) retained.",
	);
	assertUnrelatedRecoveryInventoryPreserved(
		"after-resolve",
		inventoryBaseline,
		await captureRecoveryInventory(client),
		"resolved",
	);
	await resumePhase(client, ticket);
	return inventoryBaseline;
}

async function verifyExportFile(
	vaultRoot: string,
	relativePath: string,
	expectedHash: string,
	timeoutMs = 15_000,
): Promise<void> {
	const absolute = resolve(vaultRoot, relativePath);
	if (absolute !== vaultRoot && !absolute.startsWith(`${vaultRoot}${sep}`)) {
		throw new Error(`export escaped the verified vault root: ${relativePath}`);
	}
	const startedAt = Date.now();
	let lastObservation = "missing";
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const content = await readFile(absolute, "utf8");
			const observed = createHash("sha256").update(content).digest("hex");
			if (observed === expectedHash) return;
			lastObservation = `hash:${observed}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(50);
	}
	throw new Error(
		`export verification timed out for ${relativePath}: ${lastObservation}`,
	);
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
			"Usage: bun run qa/controllers/editor-handoff-recovery.ts " +
			"--port 9222 --vault /absolute/disposable-vault",
		);
	}
	const expectedVault = await realpath(resolve(args.vault));
	const client = new ObsidianClient({
		port,
		host: "127.0.0.1",
		transport: "raw-page",
	});
	let liveRun: Promise<ScenarioResult> | null = null;
	let reloadRun: Promise<ScenarioResult> | null = null;

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
		const canonicalLiveVault = await realpath(resolve(liveVault));
		if (canonicalLiveVault !== expectedVault) {
			throw new Error(
				`vault mismatch: controller=${expectedVault}, live=${canonicalLiveVault}`,
			);
		}

		liveRun = client.runScenario("s13b-editor-handoff-recovery", { timeoutMs: 300_000 });
		const retainedHash = await serviceQuotaFailureAndRetry(client, liveRun);
		await serviceHungCopyFailure(client, liveRun);
		const copyReceipt = await serviceHungCopySuccess(client, liveRun);
		await serviceReleaseCopyLatePut(client, liveRun, copyReceipt);
		await serviceVerifiedExport(client, liveRun, expectedVault);
		await serviceConfirmedDiscard(client, liveRun);
		const liveResult = await liveRun;
		if (!liveResult.passed) {
			throw new Error(
				`live Recovery stage failed: ${liveResult.errors.join(" | ") || "unknown failure"}; ` +
				`warnings=${liveResult.warnings.join(" | ")}`,
			);
		}

		await client.disableProductPlugin();
		await client.enableProductPlugin();
		await delay(500);
		await client.rebindKaosDebugApi();
		await client.waitForQaReady(30_000);

		reloadRun = client.runScenario("s13c-editor-handoff-recovery-reload", { timeoutMs: 180_000 });
		const inventoryBaseline = await serviceReloadDashboardReview(
			client,
			reloadRun,
			expectedVault,
			retainedHash,
		);
		const reloadResult = await reloadRun;
		if (!reloadResult.passed) {
			throw new Error(
				`reload Recovery stage failed: ${reloadResult.errors.join(" | ") || "unknown failure"}; ` +
				`warnings=${reloadResult.warnings.join(" | ")}`,
			);
		}
		await client.disableProductPlugin();
		await client.enableProductPlugin();
		await delay(500);
		await client.rebindKaosDebugApi();
		await client.waitForQaReady(30_000);
		assertUnrelatedRecoveryInventoryPreserved(
			"after-product-reload",
			inventoryBaseline,
			await captureRecoveryInventory(client),
			"resolved",
		);

		console.log(
			`PASS ${LIVE_SCENARIO_ID} (${liveResult.durationMs}ms) + ` +
			`${RELOAD_SCENARIO_ID} (${reloadResult.durationMs}ms): ` +
			"manual Recovery, late-write fences, exact unrelated-row preservation, fresh hydration, dashboard actions, and both analyzers passed",
		);
	} catch (error) {
		if (liveRun || reloadRun) await abortActiveRun(client);
		await Promise.all([
			liveRun?.catch(() => undefined),
			reloadRun?.catch(() => undefined),
		]);
		throw error;
	} finally {
		await client.close();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
