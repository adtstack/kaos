#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
} from "../../src/runtime/engineControlPort";
import type {
	EditorHandoffExternalPhaseName,
	QaExternalPhaseTicket,
} from "../obsidian-harness/types";
import { ObsidianClient } from "./obsidian-client";

const SCENARIO_ID = "s13a-editor-handoff-host-fences";
const PATH_A = "QA-handoff-fences-A.md";
const PATH_B = "QA-handoff-fences-B.md";
const PATH_C = "QA-handoff-fences-C.md";
const SNAPSHOT_TIMEOUT_MS = 20_000;
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

function requireLeaf(
	snapshot: EditorHandoffDebugSnapshot,
	predicate: (leaf: EditorHandoffManagedLeafDebugSnapshot) => boolean,
	label: string,
): EditorHandoffManagedLeafDebugSnapshot {
	const leaf = snapshot.leaves.find(predicate);
	if (!leaf) throw new Error(`unsupported-host:${label}: managed leaf unavailable`);
	return leaf;
}

async function getSnapshot(client: ObsidianClient): Promise<EditorHandoffDebugSnapshot> {
	return client.evalRaw<EditorHandoffDebugSnapshot>(`
		(() => {
			const debug = window.__KAOS_DEBUG__;
			if (!debug) throw new Error("__KAOS_DEBUG__ unavailable");
			return debug.getEditorHandoffDebugSnapshot();
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
	throw new Error(`unsupported-host:${label}: timed out; snapshot=${JSON.stringify(last)}`);
}

async function releaseNativeSave(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`window.__KAOS_DEBUG__?.releaseHeldNativeSave()`);
}

async function phase<Name extends EditorHandoffExternalPhaseName>(
	client: ObsidianClient,
	name: Name,
): Promise<QaExternalPhaseTicket<Name>> {
	const phaseTicket = client.waitForExternalPhase(SCENARIO_ID, name, 60_000);
	if (!activeScenarioRun) return phaseTicket;
	return Promise.race([
		phaseTicket,
		activeScenarioRun.then((result): never => {
			throw new Error(
				`scenario ended before external phase ${name}: ` +
				`${result.errors.join(" | ") || "unknown failure"}`,
			);
		}),
	]);
}

async function physicalKeyAtCurrentFocus(
	client: ObsidianClient,
	input: { key: string; code: string; text: string; windowsVirtualKeyCode: number },
): Promise<void> {
	await client.dispatchPhysicalKey(input);
}

async function readActiveEditorContent(client: ObsidianClient): Promise<string> {
	return client.evalRaw<string>(`(() => {
		const value = window.app?.workspace?.activeLeaf?.view?.editor?.getValue?.();
		if (typeof value !== "string") throw new Error("active editor content unavailable");
		return value;
	})()`);
}

async function waitForRejectedHeldInput(
	client: ObsidianClient,
	label: string,
	leafId: string,
	before: EditorHandoffManagedLeafDebugSnapshot,
	beforeContent: string,
): Promise<void> {
	await waitForSnapshot(client, label, (snapshot) => {
		const leaf = snapshot.leaves.find((candidate) => candidate.leafId === leafId);
		return snapshot.hostLoad?.state === "held"
			&& leaf?.gateClosed === true
			&& leaf.intent === null
			&& leaf.compositionActive === false
			&& leaf.inputEpoch === before.inputEpoch
			&& leaf.compositionEpoch === before.compositionEpoch
			&& leaf.editorLength === before.editorLength
			&& leaf.hostDataLength === before.hostDataLength;
	});
	const afterContent = await readActiveEditorContent(client);
	if (afterContent !== beforeContent) {
		throw new Error(
			`unsupported-host:${label}: rejected input changed visible editor bytes; `
			+ `beforeLength=${beforeContent.length};afterLength=${afterContent.length}`,
		);
	}
}

async function waitForExactSourceAuthority(
	client: ObsidianClient,
	path: string,
	expectedContent: string,
): Promise<void> {
	const startedAt = Date.now();
	let last: Readonly<{ disk: string | null; crdt: string | null }> | null = null;
	while (Date.now() - startedAt < SNAPSHOT_TIMEOUT_MS) {
		last = await client.evalRaw<Readonly<{ disk: string | null; crdt: string | null }>>(`(async () => {
			const path = ${JSON.stringify(path)};
			const file = window.app?.vault?.getAbstractFileByPath?.(path) ?? null;
			const plugin = window.app?.plugins?.plugins?.kaos ?? null;
			return {
				disk: file ? await window.app.vault.cachedRead(file) : null,
				crdt: plugin?.vaultSync?.getTextForPath?.(path)?.toJSON?.() ?? null,
			};
		})()`);
		if (last.disk === expectedContent && last.crdt === expectedContent) return;
		await delay(25);
	}
	throw new Error(
		"unsupported-host:source authority did not settle to the exact pre-target successor; "
		+ `expectedLength=${expectedContent.length};diskLength=${last?.disk?.length ?? -1};`
		+ `crdtLength=${last?.crdt?.length ?? -1}`,
	);
}

async function serviceSaveBeforeSwitch(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "save-entered-before-switch");
	const before = await waitForSnapshot(client, "native save hold", (snapshot) =>
		snapshot.nativeSave?.state === "held"
		&& snapshot.nativeSave.invocationPath === PATH_A,
	);
	const leafId = before.nativeSave?.leafId;
	if (!leafId) throw new Error("unsupported-host:native save hold has no leaf identity");

	// The source save is deliberately held, so the host may not present B until
	// that exact A save settles. Prove the physical B click itself here and wait
	// for B only after releasing the source owner below.
	await client.clickVaultFileIntent(PATH_B);
	const afterSwitchIntent = await waitForSnapshot(
		client,
		"native A save remains pinned after B switch intent",
		(snapshot) => snapshot.nativeSave?.invocationPath === PATH_A
			&& snapshot.nativeSave.path === PATH_A
			&& snapshot.nativeSave.leafId === leafId
			&& (
				snapshot.nativeSave.state === "held"
				|| (
					(snapshot.nativeSave.state === "released"
						|| snapshot.nativeSave.state === "rejected")
					&& snapshot.leaves.some((leaf) =>
						leaf.leafId === leafId && leaf.viewPath === PATH_B)
				)
			),
	);
	if (afterSwitchIntent.nativeSave?.state === "held") {
		await releaseNativeSave(client);
	}
	const settled = await waitForSnapshot(client, "native save target pin and B selection", (snapshot) =>
		(snapshot.nativeSave?.state === "released"
			|| snapshot.nativeSave?.state === "rejected")
		&& snapshot.leaves.some((leaf) => leaf.leafId === leafId && leaf.viewPath === PATH_B),
	);
	if (
		settled.nativeSave?.invocationPath !== PATH_A
		|| settled.nativeSave.path !== PATH_A
		|| settled.nativeSave.outcome === "pending"
	) throw new Error("unsupported-host:native save was not pinned to invocation-entry A");
	await client.resumeExternalPhase(ticket);
}

async function serviceAsciiAfterSwitchIntent(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "ascii-input-after-switch-intent");
	const source = requireLeaf(
		await getSnapshot(client),
		(leaf) => leaf.active && leaf.viewPath === PATH_A && leaf.bindingPath === PATH_A,
		"ASCII source A",
	);
	await client.clickVaultFileIntent(PATH_B);
	const before = await waitForSnapshot(client, `ASCII switch gate for ${source.leafId}`, (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === PATH_B
		&& snapshot.hostLoad.leafId === source.leafId
		&& snapshot.leaves.some((leaf) => leaf.leafId === source.leafId && leaf.gateClosed),
	);
	const leafId = before.hostLoad?.leafId;
	if (!leafId) throw new Error("unsupported-host:ASCII phase has no leaf identity");
	const beforeLeaf = requireLeaf(
		before,
		(leaf) => leaf.leafId === leafId,
		"ASCII held target",
	);
	const beforeContent = await readActiveEditorContent(client);
	await physicalKeyAtCurrentFocus(client, {
		key: "x",
		code: "KeyX",
		text: "x",
		windowsVirtualKeyCode: 88,
	});
	await waitForRejectedHeldInput(
		client,
		"ASCII rejected before target admission",
		leafId,
		beforeLeaf,
		beforeContent,
	);
	await client.resumeExternalPhase(ticket);
}

async function serviceCompletedImeAfterSwitchIntent(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "completed-ime-after-switch-intent");
	const source = requireLeaf(
		await getSnapshot(client),
		(leaf) => leaf.active && leaf.viewPath === PATH_A && leaf.bindingPath === PATH_A,
		"completed IME source A",
	);
	await client.clickVaultFile(PATH_B);
	const held = await waitForSnapshot(client, "completed IME switch gate", (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === PATH_B
		&& snapshot.hostLoad.leafId === source.leafId,
	);
	const leafId = held.hostLoad?.leafId;
	if (!leafId) throw new Error("unsupported-host:completed IME phase has no leaf identity");
	const beforeLeaf = requireLeaf(
		held,
		(leaf) => leaf.leafId === leafId,
		"completed IME held target",
	);
	const beforeContent = await readActiveEditorContent(client);

	const focused = await client.getCompositionFocusState();
	if (focused.activeElementIsCodeMirror || focused.compositionActive) {
		throw new Error("unsupported-host:closed pre-target CodeMirror retained input focus");
	}
	// A target-less pane is deliberately non-editable. Chromium may reject the
	// native IME command itself or deliver cancellable composition/input events;
	// both outcomes must leave every editor authority epoch and byte unchanged.
	await client.setImeComposition("ㅎ", 1, 1).catch(() => undefined);
	await client.setImeComposition("한", 1, 1).catch(() => undefined);
	await client.commitImeText("한").catch(() => undefined);
	await waitForRejectedHeldInput(
		client,
		"completed IME rejected before target admission",
		leafId,
		beforeLeaf,
		beforeContent,
	);
	await client.resumeExternalPhase(ticket);
}

async function serviceImeClickWhileComposing(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "ime-and-click-while-composing");
	await client.focusActiveCodeMirror();
	const initialFocus = await client.getCompositionFocusState();
	const ownerCmId = initialFocus.focusedManagedCmId;
	if (!initialFocus.activeElementIsCodeMirror || !ownerCmId) {
		throw new Error("unsupported-host:composition-click source CodeMirror is not focused");
	}
	const initial = await getSnapshot(client);
	const initialLeaf = requireLeaf(
		initial,
		(leaf) => leaf.cmId === ownerCmId && leaf.viewPath === PATH_A,
		"composition-click source",
	);
	const sourceBeforeComposition = await readActiveEditorContent(client);
	await client.setImeCompositionSequence([
		{ text: "ㅎ", selectionStart: 1, selectionEnd: 1 },
		{ text: "한", selectionStart: 1, selectionEnd: 1 },
	]);
	await waitForSnapshot(client, "live composition before click", (snapshot) =>
		snapshot.leaves.some((leaf) =>
			leaf.leafId === initialLeaf.leafId
			&& leaf.compositionActive
			&& leaf.compositionOwnerCmId === ownerCmId
			&& leaf.activeCompositionUpdates === 2
			&& (leaf.activeCompositionCapturedUpdates ?? 0) >= 1
			),
	);
	const sourceSuccessorBeforeTarget = await readActiveEditorContent(client);
	if (sourceSuccessorBeforeTarget === sourceBeforeComposition) {
		throw new Error("unsupported-host:composition produced no exact source successor");
	}

	await client.clickVaultFile(PATH_B);
	const afterClick = await waitForSnapshot(client, "B held during composition click", (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === PATH_B
		&& snapshot.hostLoad.leafId === initialLeaf.leafId
		&& snapshot.leaves.some((leaf) =>
			leaf.leafId === initialLeaf.leafId
			&& leaf.viewPath === PATH_B
		),
	);
	const focusAfterClick = await client.getCompositionFocusState();
	let afterLeaf = requireLeaf(
		afterClick,
		(leaf) => leaf.leafId === initialLeaf.leafId,
		"composition-click target",
	);

	if (focusAfterClick.compositionActive) {
		if (
			focusAfterClick.compositionOwnerCmId !== ownerCmId
			|| focusAfterClick.focusedManagedCmId !== ownerCmId
			|| !focusAfterClick.activeElementIsCodeMirror
		) {
			throw new Error(
				"unsupported-host:pending composition lost verified source focus after explorer click",
			);
		}
		await client.commitImeText("한");
	}
	afterLeaf = requireLeaf(
		await waitForSnapshot(client, "composition-click source settlement", (snapshot) => {
			const leaf = snapshot.leaves.find((candidate) => candidate.leafId === initialLeaf.leafId);
			return leaf?.compositionActive === false
				&& leaf.intent === null
				&& (leaf.lastComposition?.updates ?? 0) >= 2
				&& leaf.lastComposition?.startGeneration === initialLeaf.generation
				&& leaf.lastComposition.endGeneration === initialLeaf.generation
				&& leaf.lastComposition.replayEligible === false
				&& leaf.sourceUnload?.path === PATH_A
				&& leaf.sourceUnload.state === "settled"
				&& leaf.sourceUnload.forcedSaveObserved;
		}),
		(leaf) => leaf.leafId === initialLeaf.leafId,
		"composition-click source settlement",
	);
	const sourceSettledBeforeTarget = afterLeaf.intent === null
		&& (afterLeaf.lastComposition?.updates ?? 0) >= 2
		&& afterLeaf.lastComposition?.startGeneration === initialLeaf.generation
		&& afterLeaf.lastComposition.endGeneration === initialLeaf.generation
		&& afterLeaf.lastComposition.replayEligible === false
		&& afterLeaf.sourceUnload?.path === PATH_A
		&& afterLeaf.sourceUnload.state === "settled"
		&& afterLeaf.sourceUnload.forcedSaveObserved;
	if (!sourceSettledBeforeTarget) {
		throw new Error(
			"unsupported-host:composition did not settle exactly to source A before B",
		);
	}
	await waitForExactSourceAuthority(client, PATH_A, sourceSuccessorBeforeTarget);
	await client.resumeExternalPhase(ticket);
}

async function serviceInputWhileHostLoadHeld(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "input-while-host-load-held");
	const source = requireLeaf(
		await getSnapshot(client),
		(leaf) => leaf.active && leaf.viewPath === PATH_A && leaf.bindingPath === PATH_A,
		"held-input source A",
	);
	await client.clickVaultFile(PATH_B);
	const held = await waitForSnapshot(client, "input-held host load", (snapshot) =>
		snapshot.hostLoad?.state === "held"
		&& snapshot.hostLoad.path === PATH_B
		&& snapshot.hostLoad.leafId === source.leafId,
	);
	const leafId = held.hostLoad?.leafId;
	if (!leafId) throw new Error("unsupported-host:input-held phase has no leaf identity");
	const beforeLeaf = requireLeaf(
		held,
		(leaf) => leaf.leafId === leafId,
		"held-input target",
	);
	const beforeContent = await readActiveEditorContent(client);
	await physicalKeyAtCurrentFocus(client, {
		key: "y",
		code: "KeyY",
		text: "y",
		windowsVirtualKeyCode: 89,
	});
	await waitForRejectedHeldInput(
		client,
		"input rejected while host load stayed held",
		leafId,
		beforeLeaf,
		beforeContent,
	);
	await client.resumeExternalPhase(ticket);
}

async function serviceSupersession(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "supersede-b-with-c");
	const source = await getSnapshot(client);
	const sourceLeaf = requireLeaf(
		source,
		(leaf) => leaf.viewPath === PATH_A && leaf.bindingPath === PATH_A,
		"supersession source A",
	);
	await client.clickVaultFileIntent(PATH_B);
	console.log("S13a rapid switch: physical B intent delivered");
	await client.clickVaultFileIntent(PATH_C);
	console.log("S13a rapid switch: physical C intent delivered");
	await waitForSnapshot(client, "rapid successor C selected", (snapshot) =>
		snapshot.leaves.some((leaf) =>
			leaf.leafId === sourceLeaf.leafId
			&& leaf.viewPath === PATH_C
			&& leaf.displayedPath === PATH_C
			&& leaf.bindingPath === PATH_C
			&& leaf.gateClosed === false
			&& leaf.saveGuardInstalled === false
			&& leaf.hostCapabilityState === "ready"
		),
	);
	console.log("S13a rapid switch: C selected and writable");
	await client.resumeExternalPhase(ticket);
}

async function canonicalPath(path: string): Promise<string> {
	return realpath(resolve(path));
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const port = Number(args.port ?? 9222);
	if (!args.vault) {
		throw new Error(
			"Usage: bun run qa/controllers/editor-handoff-host-fences.ts " +
			"--port 9222 --vault /absolute/disposable-vault",
		);
	}
	const expectedVault = await canonicalPath(args.vault);
	const client = new ObsidianClient({
		port,
		host: "127.0.0.1",
		connectTimeoutMs: 300_000,
		transport: "raw-page",
	});
	let runPromise: ReturnType<ObsidianClient["runScenario"]> | null = null;

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

		runPromise = client.runScenario(SCENARIO_ID, { timeoutMs: 240_000 });
		activeScenarioRun = runPromise;
		await serviceSaveBeforeSwitch(client);
		await serviceAsciiAfterSwitchIntent(client);
		await serviceCompletedImeAfterSwitchIntent(client);
		await serviceImeClickWhileComposing(client);
		await serviceInputWhileHostLoadHeld(client);
		await serviceSupersession(client);

		const result = await runPromise;
		if (!result.passed) {
			throw new Error(
				`scenario failed: ${result.errors.join(" | ") || "unknown failure"}; ` +
				`warnings=${result.warnings.join(" | ")}`,
			);
		}
		console.log(
			`PASS ${SCENARIO_ID} (${result.durationMs}ms): ` +
			"scenario and trace analyzer accepted all six external phases",
		);
	} catch (error) {
		if (runPromise) {
			await client.evalRaw(`
				window.__KAOS_QA__?.run("__controller-abort__", { timeoutMs: 1 })
			`).catch(() => undefined);
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
