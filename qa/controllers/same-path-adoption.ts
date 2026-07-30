#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	EditorHandoffDebugSnapshot,
	EditorHandoffManagedLeafDebugSnapshot,
} from "../../src/runtime/engineControlPort";
import {
	SAME_PATH_ADOPTION_PATHS,
	SAME_PATH_ADOPTION_SCENARIO_ID,
	type SamePathAdoptionExternalPhase,
} from "../contracts/same-path-adoption";
import type { QaExternalPhaseTicket } from "../obsidian-harness/types";
import { ObsidianClient } from "./obsidian-client";
import { isMarkdownEditorLeafForPath } from "./workspace-leaf-selection";

const SNAPSHOT_TIMEOUT_MS = 45_000;
const OWNED_SAVE_DRAIN_TIMEOUT_MS = 10_000;
const apiVersionOverrideForUnsupportedHost = "0.0.0-qa-unsupported";
type ScenarioResult = Awaited<ReturnType<ObsidianClient["runScenario"]>>;
type PendingOwnedSaveDrainSnapshot = Readonly<{
	mode: string;
	pendingOwnedSave: boolean;
	inFlightCount: number;
	saveEpochDelta: number;
	hostCapability: string;
	dirty: boolean;
}>;
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
	throw new Error(`same-path adoption ${label} timed out; snapshot=${JSON.stringify(last)}`);
}

function leavesFor(
	snapshot: EditorHandoffDebugSnapshot,
	path: string,
): readonly EditorHandoffManagedLeafDebugSnapshot[] {
	return snapshot.leaves.filter((leaf) => leaf.viewPath === path);
}

async function phase<Name extends SamePathAdoptionExternalPhase>(
	client: ObsidianClient,
	name: Name,
): Promise<QaExternalPhaseTicket<Name>> {
	const ticket = client.waitForExternalPhase(SAME_PATH_ADOPTION_SCENARIO_ID, name, 120_000);
	if (!activeScenarioRun) return ticket;
	return Promise.race([
		ticket,
		activeScenarioRun.then((result): never => {
			throw new Error(
				`scenario ended before ${name}: ${result.errors.join(" | ") || "unknown failure"}`,
			);
		}),
	]);
}

async function reloadProduct(client: ObsidianClient): Promise<void> {
	await client.disableProductPlugin();
	await client.enableProductPlugin();
	await client.rebindKaosDebugApi();
	await client.waitForQaReady(30_000);
}

async function waitForProductStartupReady(
	client: ObsidianClient,
	timeoutMs = 60_000,
): Promise<void> {
	const startedAt = Date.now();
	let last: Readonly<Record<string, unknown>> | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		last = await client.evalRaw(`
			(() => {
				const plugin = window.app?.plugins?.plugins?.kaos;
				return {
					pluginPresent: plugin != null,
					providerSynced: plugin?.vaultSync?.providerSynced === true,
					reconciled: plugin?.reconciliationController?.isReconciled === true,
					reconcileInFlight:
						plugin?.reconciliationController?.isReconcileInFlight === true,
				};
			})()
		`);
		if (last.providerSynced === true && last.reconciled === true) return;
		await delay(25);
	}
	throw new Error(`same-path adoption startup readiness timed out; state=${JSON.stringify(last)}`);
}

async function dispatchKey(
	client: ObsidianClient,
	key: string,
	code: string,
	windowsVirtualKeyCode: number,
): Promise<void> {
	await client.focusActiveCodeMirror();
	await client.dispatchPhysicalKey({ key, code, text: key, windowsVirtualKeyCode });
}

type ActiveEditorGeometry = Readonly<{
	anchor: Readonly<{ line: number; ch: number }>;
	head: Readonly<{ line: number; ch: number }>;
	scrollTop: number;
}>;

async function readActiveEditorGeometry(
	client: ObsidianClient,
): Promise<ActiveEditorGeometry> {
	return client.evalRaw<ActiveEditorGeometry>(`
		(() => {
			const view = window.app?.workspace?.activeLeaf?.view;
			const selection = view?.editor?.listSelections?.()?.[0];
			const scroller = document.querySelector(
				".workspace-leaf.mod-active .markdown-source-view .cm-scroller"
			);
			if (!selection || !(scroller instanceof HTMLElement)) {
				throw new Error("active editor geometry unavailable");
			}
			return {
				anchor: { line: selection.anchor.line, ch: selection.anchor.ch },
				head: { line: selection.head.line, ch: selection.head.ch },
				scrollTop: scroller.scrollTop,
			};
		})()
	`);
}

function sameEditorGeometry(
	left: ActiveEditorGeometry,
	right: ActiveEditorGeometry,
): boolean {
	return left.anchor.line === right.anchor.line
		&& left.anchor.ch === right.anchor.ch
		&& left.head.line === right.head.line
		&& left.head.ch === right.head.ch
		&& left.scrollTop === right.scrollTop;
}

async function authorityHashes(
	client: ObsidianClient,
	path: string,
): Promise<Readonly<{ disk: string | null; crdt: string | null; editor: string | null }>> {
	return client.evalRaw(`
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
}

async function samePathAdoptionRetryState(
	client: ObsidianClient,
	path: string,
): Promise<Readonly<Record<string, unknown>>> {
	return client.evalRaw(`
		(() => {
			const manager = window.app?.plugins?.plugins?.kaos?.editorBindings;
			if (!manager) return { managerPresent: false };
			const sessions = [...(manager.managedSessions?.entries?.() ?? [])];
			const match = sessions.find(([, runtime]) =>
				runtime?.session?.view?.file?.path === ${JSON.stringify(path)}
			) ?? null;
			const leafId = match?.[0] ?? null;
			const runtime = match?.[1] ?? null;
			const session = runtime?.session ?? null;
			const view = session?.view ?? null;
			const file = view?.file ?? null;
			const cm = view === null ? null : manager.getCmView?.(view) ?? null;
			const host = runtime?.hostGuard?.snapshot?.() ?? null;
			const guard = runtime?.cmGuard?.snapshot?.() ?? null;
			let editorSurfaceExact = false;
			let hostSurfaceExact = false;
			try {
				editorSurfaceExact = view?.editor?.getValue?.() === cm?.state?.doc?.toString?.();
				hostSurfaceExact = view?.getViewData?.() === cm?.state?.doc?.toString?.();
			} catch {}
			let openViewCount = null;
			let ticketCaptured = false;
			let primaryTicketExact = false;
			try {
				const openViews = manager.captureOpenViewsForAdmission?.(
					${JSON.stringify(path)}
				) ?? [];
				openViewCount = openViews.length;
				const ticket = manager.captureOpenEditorMutationTicket?.(
					${JSON.stringify(path)},
					openViews,
				);
				ticketCaptured = ticket !== null && ticket !== undefined;
				const primary = ticket?.views?.find?.((candidate) => candidate.leafId === leafId);
				primaryTicketExact = primary?.cm === cm
					&& primary?.editorDocument === cm?.state?.doc
					&& primary?.editorContent === cm?.state?.doc?.toString?.();
			} catch {}
			let editorAuthorityKind = null;
			let editorAuthorityExact = false;
			try {
				const authority = manager.capturePathEditorAuthority?.(${JSON.stringify(path)});
				editorAuthorityKind = authority?.kind ?? null;
				editorAuthorityExact = authority?.kind === "proven-single"
					&& authority.content === cm?.state?.doc?.toString?.()
					&& manager.isPathEditorAuthorityLeaseCurrent?.(authority.lease) === true;
			} catch {}
			return {
				managerPresent: true,
				asyncAuthorityOpen: manager.asyncAuthorityOpen === true,
				managedSessionCount: sessions.length,
				leafFound: leafId !== null,
				requiredPathMatches: leafId !== null
					&& manager.samePathAdoptionRequiredPathByLeafId?.get?.(leafId)
						=== ${JSON.stringify(path)},
				requiredPathCount:
					manager.samePathAdoptionRequiredPathByLeafId?.size ?? null,
				refreshScheduled: leafId !== null
					&& manager.samePathAdoptionRefreshScheduled?.has?.(leafId) === true,
				retryPending: leafId !== null
					&& manager.pendingSamePathAdoptionRetries?.has?.(leafId) === true,
				retryAttempt: leafId === null
					? null
					: manager.samePathAdoptionRetryAttempts?.get?.(leafId) ?? null,
				adoptionKind: runtime?.adoption?.kind ?? null,
				bindingKind: runtime?.session?.binding?.kind ?? null,
				bindingPublished: leafId !== null
					&& manager.bindings?.has?.(leafId) === true,
				hostMode: host?.mode?.kind ?? null,
				hostSourceUnload: host?.sourceUnload !== null,
				guardInert: guard?.inert ?? null,
				guardGateClosed: guard?.gateClosed ?? null,
				compositionActive: guard?.activeComposition !== null,
				sessionNativeHistoryEpoch: session?.nativeHistoryEpoch ?? null,
				guardNativeHistoryEpoch: guard?.nativeHistoryEpoch ?? null,
				nativeHistoryEpochExact:
					session?.nativeHistoryEpoch === guard?.nativeHistoryEpoch,
				displayedDocumentExact:
					session?.displayedLineage?.document === cm?.state?.doc,
				displayedEditorRevision: session?.displayedLineage?.editorRevision ?? null,
				observedEditorRevision:
					cm === null ? null : manager.editorRevisionByCm?.get?.(cm) ?? null,
				editorSurfaceExact,
				hostSurfaceExact,
				openViewCount,
				ticketCaptured,
				primaryTicketExact,
				editorAuthorityKind,
				editorAuthorityExact,
				ytextPresent:
					manager.vaultSync?.getTextForPath?.(${JSON.stringify(path)}) != null,
				fileIdentityExact: file?.path === ${JSON.stringify(path)},
			};
		})()
	`);
}

async function waitForBoundConvergence(
	client: ObsidianClient,
	path: string,
	boundCount: number,
): Promise<void> {
	const startedAt = Date.now();
	let lastHashes: Awaited<ReturnType<typeof authorityHashes>> | null = null;
	let lastSnapshot: EditorHandoffDebugSnapshot | null = null;
	while (Date.now() - startedAt < SNAPSHOT_TIMEOUT_MS) {
		lastSnapshot = await getSnapshot(client);
		lastHashes = await authorityHashes(client, path);
		const leaves = leavesFor(lastSnapshot, path);
		if (
			leaves.filter((leaf) => leaf.bindingPath === path).length === boundCount
			&& leaves.every((leaf) => leaf.hostCapabilityState === "ready")
			&& lastHashes.disk !== null
			&& lastHashes.disk === lastHashes.crdt
			&& (lastHashes.editor === null || lastHashes.editor === lastHashes.disk)
		) return;
		await delay(25);
	}
	throw new Error(
		`same-path adoption convergence failed for ${path}; ` +
		`snapshot=${JSON.stringify(lastSnapshot)} hashes=${JSON.stringify(lastHashes)} ` +
		`retry=${JSON.stringify(await samePathAdoptionRetryState(client, path))}`,
	);
}

async function waitForAuthorityHashChange(
	client: ObsidianClient,
	path: string,
	before: string,
): Promise<void> {
	const startedAt = Date.now();
	let last: Awaited<ReturnType<typeof authorityHashes>> | null = null;
	while (Date.now() - startedAt < SNAPSHOT_TIMEOUT_MS) {
		last = await authorityHashes(client, path);
		if (
			last.disk !== null
			&& last.disk !== before
			&& last.crdt === last.disk
			&& (last.editor === null || last.editor === last.disk)
		) return;
		await delay(25);
	}
	throw new Error(`authority did not change for ${path}; last=${JSON.stringify(last)}`);
}

async function clearActiveHostDirty(client: ObsidianClient): Promise<void> {
	await client.evalRaw(`
		(() => {
			const view = window.app?.workspace?.activeLeaf?.view;
			if (!view || typeof view.getViewData !== "function") {
				throw new Error("active text-file view unavailable");
			}
			view.requestSave?.cancel?.();
			view.dirty = false;
		})()
	`);
}

async function reloadWithUnsavedPhysicalInput(
	client: ObsidianClient,
	key: string,
	code: string,
	virtualKey: number,
): Promise<void> {
	await client.disableProductPlugin();
	await dispatchKey(client, key, code, virtualKey);
	await clearActiveHostDirty(client);
	await client.enableProductPlugin();
	await client.rebindKaosDebugApi();
	await client.waitForQaReady(30_000);
}

async function serviceCleanMergeDuringPlanning(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "clean-merge-during-planning");
	await client.scrollActiveCodeMirror(520);
	const beforeReloadAuthority = await authorityHashes(
		client,
		SAME_PATH_ADOPTION_PATHS.clean,
	);
	if (
		beforeReloadAuthority.disk === null
		|| beforeReloadAuthority.editor !== beforeReloadAuthority.disk
		|| beforeReloadAuthority.crdt === null
		|| beforeReloadAuthority.crdt === beforeReloadAuthority.disk
	) throw new Error("clean adoption reload precondition lost Base/Local/Remote divergence");
	await reloadProduct(client);
	try {
		await waitForSnapshot(client, "clean adoption planning window", (snapshot) =>
			leavesFor(snapshot, SAME_PATH_ADOPTION_PATHS.clean).some((leaf) =>
				(leaf.adoption.kind === "capturing" || leaf.adoption.kind === "planning")
				&& leaf.bindingPath === null
				&& leaf.hostCapabilityState === "ready"
				&& leaf.clearLoadCapability === "observable"
			),
		);
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)} ` +
			`hashes=${JSON.stringify(await authorityHashes(client, SAME_PATH_ADOPTION_PATHS.clean))} ` +
			`retry=${JSON.stringify(await samePathAdoptionRetryState(client, SAME_PATH_ADOPTION_PATHS.clean))}`,
		);
	}
	const planningAuthority = await authorityHashes(
		client,
		SAME_PATH_ADOPTION_PATHS.clean,
	);
	if (
		planningAuthority.disk !== beforeReloadAuthority.disk
		|| planningAuthority.editor !== beforeReloadAuthority.editor
		|| planningAuthority.crdt !== beforeReloadAuthority.crdt
	) throw new Error("Remote authority changed across reload before adoption planning");
	await dispatchKey(client, "l", "KeyL", 76);
	const beforeSettlement = await readActiveEditorGeometry(client);
	if (
		beforeSettlement.anchor.line !== beforeSettlement.head.line
		|| beforeSettlement.anchor.ch !== beforeSettlement.head.ch
		|| beforeSettlement.scrollTop <= 0
	) {
		throw new Error("physical planning input did not retain a scrolled cursor");
	}
	await waitForBoundConvergence(client, SAME_PATH_ADOPTION_PATHS.clean, 1);
	const afterSettlement = await readActiveEditorGeometry(client);
	if (!sameEditorGeometry(beforeSettlement, afterSettlement)) {
		throw new Error("same-path adoption changed the post-input cursor or scroll anchor");
	}
	await client.resumeExternalPhase(ticket);
}

async function serviceNativeHistory(
	client: ObsidianClient,
	phaseName: "native-undo-local" | "native-redo-local",
	modifiers: number,
): Promise<void> {
	const ticket = await phase(client, phaseName);
	const before = await authorityHashes(client, SAME_PATH_ADOPTION_PATHS.clean);
	if (!before.disk) throw new Error(`${phaseName}: disk baseline unavailable`);
	await client.focusActiveCodeMirror();
	await client.dispatchNativeShortcut({
		key: "z",
		code: "KeyZ",
		windowsVirtualKeyCode: 90,
		modifiers,
	});
	await waitForAuthorityHashChange(client, SAME_PATH_ADOPTION_PATHS.clean, before.disk);
	await client.resumeExternalPhase(ticket);
}

async function readPendingOwnedSaveDrainSnapshot(
	client: ObsidianClient,
	path: string,
): Promise<PendingOwnedSaveDrainSnapshot> {
	return client.evalRaw<PendingOwnedSaveDrainSnapshot>(`
		(() => {
			const probe = window.__KAOS_S13E_OWNED_SAVE_PROBE__;
			if (!probe?.guard || probe.path !== ${JSON.stringify(path)}) {
				throw new Error("pending-save reload probe unavailable after disable");
			}
			const snapshot = probe.guard.snapshot();
			return {
				mode: snapshot.mode.kind,
				pendingOwnedSave: snapshot.pendingOwnedSave !== null,
				inFlightCount: snapshot.inFlight.size,
				saveEpochDelta: snapshot.saveEpoch - probe.scheduledSaveEpoch,
				hostCapability: probe.hostCapability,
				dirty: probe.view?.dirty === true,
			};
		})()
	`);
}

async function waitForPendingOwnedSaveDrain(
	client: ObsidianClient,
	path: string,
	timeoutMs = OWNED_SAVE_DRAIN_TIMEOUT_MS,
): Promise<PendingOwnedSaveDrainSnapshot> {
	const startedAt = Date.now();
	let last: PendingOwnedSaveDrainSnapshot | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		last = await readPendingOwnedSaveDrainSnapshot(client, path);
		if (last.saveEpochDelta > 3) {
			throw new Error(
				`pending owned save advanced past one drain: ${JSON.stringify(last)}`,
			);
		}
		if (
			last.mode === "inert-pass-through"
			&& !last.pendingOwnedSave
			&& last.inFlightCount === 0
			&& last.saveEpochDelta === 3
			&& !last.dirty
		) return last;
		await delay(25);
	}
	throw new Error(`pending owned save drain timed out: ${JSON.stringify(last)}`);
}

async function serviceHeldSaveReload(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "held-save-reload");
	const path = SAME_PATH_ADOPTION_PATHS.saveReload;
	await dispatchKey(client, "s", "KeyS", 83);
	const expected = await authorityHashes(client, path);
	if (expected.editor === null) throw new Error("pending-save reload editor hash unavailable");
	const scheduled = await client.evalRaw<Readonly<{
		hostCapability: "public-cancellable" | "owned-scheduler-with-unload-flush";
		saveEpoch: number;
		dirty: boolean;
	}>>(`
		(() => {
			const path = ${JSON.stringify(path)};
			const manager = window.app?.plugins?.plugins?.kaos?.editorBindings;
			const entry = [...(manager?.managedSessions?.entries?.() ?? [])].find(
				([, runtime]) => runtime?.session?.view?.file?.path === path
			);
			const runtime = entry?.[1] ?? null;
			const view = runtime?.session?.view ?? null;
			const guard = runtime?.hostGuard ?? null;
			if (!view || !guard || typeof guard.snapshot !== "function") {
				throw new Error("pending-save reload guard unavailable");
			}
			view.requestSave();
			const snapshot = guard.snapshot();
			if (
				snapshot.pendingOwnedSave?.file !== view.file
				|| snapshot.pendingOwnedSave?.path !== path
				|| snapshot.pendingOwnedSave?.displayedPath !== path
				|| snapshot.inFlight.size !== 0
				|| view.dirty !== true
			) throw new Error("disable did not begin from an exact pending owned save");
			window.__KAOS_S13E_OWNED_SAVE_PROBE__ = {
				guard,
				view,
				path,
				scheduledSaveEpoch: snapshot.saveEpoch,
				hostCapability: snapshot.hostCapability,
			};
			return {
				hostCapability: snapshot.hostCapability,
				saveEpoch: snapshot.saveEpoch,
				dirty: view.dirty === true,
			};
		})()
	`);
	await client.disableProductPlugin();
	const drained = await waitForPendingOwnedSaveDrain(client, path);
	if (
		drained.hostCapability !== scheduled.hostCapability
		|| scheduled.dirty !== true
		|| drained.mode !== "inert-pass-through"
		|| drained.pendingOwnedSave
		|| drained.inFlightCount !== 0
		|| drained.saveEpochDelta !== 3
		|| drained.dirty
	) {
		throw new Error(`pending owned save did not drain exactly once: ${JSON.stringify(drained)}`);
	}
	await client.enableProductPlugin();
	await client.rebindKaosDebugApi();
	await client.waitForQaReady(30_000);
	await waitForBoundConvergence(client, path, 1);
	const restored = await authorityHashes(client, path);
	if (
		restored.disk !== expected.editor
		|| restored.crdt !== expected.editor
		|| restored.editor !== expected.editor
	) throw new Error(`pending owned save was not durable: ${JSON.stringify(restored)}`);
	await delay(2_250);
	const afterNativeDebounceWindow = await authorityHashes(client, path);
	if (
		afterNativeDebounceWindow.disk !== restored.disk
		|| afterNativeDebounceWindow.crdt !== restored.crdt
		|| afterNativeDebounceWindow.editor !== restored.editor
	) {
		throw new Error(
			`late native save mutated the new boot session: ${JSON.stringify(afterNativeDebounceWindow)}`,
		);
	}
	await client.evalRaw(`delete window.__KAOS_S13E_OWNED_SAVE_PROBE__`);
	await client.resumeExternalPhase(ticket);
}

async function waitForConflict(
	client: ObsidianClient,
	path: string,
	status: "preserved" | "preservation-failed",
	editorArtifacts = 0,
): Promise<EditorHandoffDebugSnapshot> {
	return waitForSnapshot(client, `${status} conflict`, (snapshot) =>
		leavesFor(snapshot, path).some((leaf) =>
			leaf.adoption.kind === "conflict"
			&& leaf.adoption.status === status
			&& leaf.adoption.editorArtifactPaths.length >= editorArtifacts
			&& leaf.bindingPath === null
		),
	);
}

async function serviceOverlapConflict(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "overlap-conflict-evidence");
	await reloadWithUnsavedPhysicalInput(client, "l", "KeyL", 76);
	await waitForConflict(client, SAME_PATH_ADOPTION_PATHS.conflict, "preserved", 1);
	await client.resumeExternalPhase(ticket);
}

async function serviceArtifactFailure(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "artifact-failure");
	await reloadWithUnsavedPhysicalInput(client, "a", "KeyA", 65);
	await waitForConflict(
		client,
		SAME_PATH_ADOPTION_PATHS.artifactRetry,
		"preservation-failed",
	);
	await client.resumeExternalPhase(ticket);
}

async function serviceArtifactRetry(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "artifact-retry");
	await dispatchKey(client, "r", "KeyR", 82);
	await waitForConflict(client, SAME_PATH_ADOPTION_PATHS.artifactRetry, "preserved");
	await client.resumeExternalPhase(ticket);
}

async function serviceIdenticalMultiPane(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "identical-multi-pane");
	await reloadProduct(client);
	await waitForBoundConvergence(client, SAME_PATH_ADOPTION_PATHS.multiPane, 2);
	await client.resumeExternalPhase(ticket);
}

async function activatePane(
	client: ObsidianClient,
	path: string,
	index: number,
): Promise<void> {
	const isMarkdownEditorLeafForPathSource = isMarkdownEditorLeafForPath.toString();
	const selected = await client.evalRaw<{ count: number; leafId: string }>(`
		(() => {
			const path = ${JSON.stringify(path)};
			const isMarkdownEditorLeafForPath = (${isMarkdownEditorLeafForPathSource});
			const leaves = [];
			window.app?.workspace?.iterateAllLeaves?.((leaf) => {
				if (isMarkdownEditorLeafForPath(leaf, path)) leaves.push(leaf);
			});
			leaves.sort((a, b) => String(a.id).localeCompare(String(b.id)));
			const leaf = leaves[${index}];
			if (!leaf) throw new Error("pane unavailable: " + ${index});
			window.app.workspace.setActiveLeaf(leaf, { focus: true });
			return { count: leaves.length, leafId: String(leaf.id) };
		})()
	`);
	if (selected.count !== 2) {
		throw new Error(`expected two panes for ${path}; observed=${selected.count}`);
	}
	const startedAt = Date.now();
	while (Date.now() - startedAt < 10_000) {
		const activeLeafId = await client.evalRaw<string | null>(
			"window.app?.workspace?.activeLeaf?.id ?? null",
		);
		if (activeLeafId === selected.leafId) break;
		await delay(10);
	}
	const activeLeafId = await client.evalRaw<string | null>(
		"window.app?.workspace?.activeLeaf?.id ?? null",
	);
	if (activeLeafId !== selected.leafId) {
		throw new Error(`pane activation did not settle: expected=${selected.leafId}; observed=${activeLeafId}`);
	}
	await client.focusActiveCodeMirror();
}

async function assertDistinctMarkdownPaneLocals(
	client: ObsidianClient,
	path: string,
): Promise<void> {
	const isMarkdownEditorLeafForPathSource = isMarkdownEditorLeafForPath.toString();
	const state = await client.evalRaw<{
		count: number;
		distinct: boolean;
		surfacesExact: boolean;
		lengths: number[];
	}>(`
		(() => {
			const path = ${JSON.stringify(path)};
			const isMarkdownEditorLeafForPath = (${isMarkdownEditorLeafForPathSource});
			const leaves = [];
			window.app?.workspace?.iterateAllLeaves?.((leaf) => {
				if (isMarkdownEditorLeafForPath(leaf, path)) leaves.push(leaf);
			});
			leaves.sort((a, b) => String(a.id).localeCompare(String(b.id)));
			const values = leaves.map((leaf) => leaf.view.editor.getValue());
			return {
				count: leaves.length,
				distinct: values.length === 2 && values[0] !== values[1],
				surfacesExact: leaves.every(
					(leaf, index) => leaf.view.getViewData() === values[index]
				),
				lengths: values.map((value) => value.length),
			};
		})()
	`);
	if (state.count !== 2 || !state.distinct || !state.surfacesExact) {
		throw new Error(`distinct multi-pane fixture did not hold: ${JSON.stringify(state)}`);
	}
}

async function serviceDistinctMultiPane(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "distinct-multi-pane");
	const path = SAME_PATH_ADOPTION_PATHS.multiPane;
	await activatePane(client, path, 0);
	await dispatchKey(client, "x", "KeyX", 88);
	await clearActiveHostDirty(client);
	await activatePane(client, path, 1);
	await dispatchKey(client, "y", "KeyY", 89);
	await clearActiveHostDirty(client);
	await assertDistinctMarkdownPaneLocals(client, path);
	await client.resumeExternalPhase(ticket);
	const observedTicket = phase(client, "distinct-multi-pane-observed");
	await waitForConflict(client, path, "preserved", 2);
	await client.resumeExternalPhase(await observedTicket);
}

async function serviceUnsupportedHostFallback(client: ObsidianClient): Promise<void> {
	const ticket = await phase(client, "unsupported-host-fallback");
	const pathA = SAME_PATH_ADOPTION_PATHS.unsupportedA;
	const before = await authorityHashes(client, pathA);
	if (!before.disk) throw new Error("unsupported fallback disk baseline unavailable");
	await client.evalRaw(`
		window.__KAOS_DEBUG__?.setEditorHandoffHostApiVersionOverride(
			${JSON.stringify(apiVersionOverrideForUnsupportedHost)}
		)
	`);
	await reloadProduct(client);
	await waitForSnapshot(client, "unsupported host remains unmanaged", (snapshot) =>
		leavesFor(snapshot, pathA).length === 0,
	);
	await dispatchKey(client, "u", "KeyU", 85);
	await client.evalRaw(`window.app?.workspace?.activeLeaf?.view?.requestSave?.()`);
	const startedAt = Date.now();
	let changed = false;
	while (Date.now() - startedAt < SNAPSHOT_TIMEOUT_MS) {
		const current = await authorityHashes(client, pathA);
		if (current.disk !== null && current.disk !== before.disk) {
			changed = true;
			break;
		}
		await delay(25);
	}
	if (!changed) throw new Error("ordinary unsupported-host save did not reach disk");
	await client.clickVaultFile(SAME_PATH_ADOPTION_PATHS.unsupportedB);
	const activePath = await client.evalRaw<string | null>(
		"window.app?.workspace?.activeLeaf?.view?.file?.path ?? null",
	);
	if (activePath !== SAME_PATH_ADOPTION_PATHS.unsupportedB) {
		throw new Error(`unsupported-host navigation failed: ${activePath}`);
	}
	const health = await client.evalRaw<{ bound: boolean }>(`
		window.__KAOS_DEBUG__?.getEditorBindingHealth(
			${JSON.stringify(SAME_PATH_ADOPTION_PATHS.unsupportedB)}
		)
	`);
	if (health.bound) throw new Error("unsupported host attached a KAOS binding");
	await client.evalRaw(`
		window.__KAOS_DEBUG__?.setEditorHandoffHostApiVersionOverride(null)
	`);
	await reloadProduct(client);
	await waitForBoundConvergence(client, SAME_PATH_ADOPTION_PATHS.unsupportedB, 1);
	await client.resumeExternalPhase(ticket);
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
			"Usage: bun run qa/controllers/same-path-adoption.ts " +
			"--port 9222 --vault /absolute/disposable-vault",
		);
	}
	const expectedVault = await canonicalPath(args.vault);
	const client = new ObsidianClient({ port, host: "127.0.0.1", transport: "raw-page" });
	let runPromise: Promise<ScenarioResult> | null = null;
	try {
		await client.connect();
		await client.waitForQaReady(30_000);
		await waitForProductStartupReady(client);
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
			throw new Error(`vault mismatch: controller=${expectedVault}, live=${canonicalLiveVault}`);
		}

		runPromise = client.runScenario(SAME_PATH_ADOPTION_SCENARIO_ID, { timeoutMs: 600_000 });
		activeScenarioRun = runPromise;
		await serviceCleanMergeDuringPlanning(client);
		await serviceNativeHistory(client, "native-undo-local", 4);
		await serviceNativeHistory(client, "native-redo-local", 4 | 8);
		await serviceHeldSaveReload(client);
		await serviceOverlapConflict(client);
		await serviceArtifactFailure(client);
		await serviceArtifactRetry(client);
		await serviceIdenticalMultiPane(client);
		await serviceDistinctMultiPane(client);
		await serviceUnsupportedHostFallback(client);

		const result = await runPromise;
		if (!result.passed) {
			throw new Error(
				`scenario failed: ${result.errors.join(" | ") || "unknown failure"}; ` +
				`warnings=${result.warnings.join(" | ")}`,
			);
		}
		console.log(
			`PASS ${SAME_PATH_ADOPTION_SCENARIO_ID} (${result.durationMs}ms): ` +
			"clean adoption, native history, reload save, conflicts, multi-pane, and unsupported fallback passed",
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
