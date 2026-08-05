/**
 * Tests for QA port fencing.
 *
 * Verifies:
 * 1. KaosDebugPort and KaosUnsafeQaPort interfaces exist and are well-typed
 * 2. The guard:qa-isolation script passes (sync/runtime don't import QA)
 * 3. Port interfaces correctly categorize safe vs unsafe operations
 */

import type { KaosDebugPort } from "../src/telemetry/debug/ports/kaosDebugPort";
import type { KaosUnsafeQaPort } from "../qa/harness/ports/kaosUnsafeQaPort";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION } from
	"../qa/contracts/editor-handoff-host-fence";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

console.log("\n--- Test 1: KaosDebugPort interface shape ---");
{
	// Type-level check: a mock implementation compiles.
	const mockDebugPort: KaosDebugPort = {
		isLocalReady: () => true,
		isProviderSynced: () => true,
		isProviderConnected: () => true,
		isReconciled: () => true,
		isReconcileInFlight: () => false,
		getConnectionState: () => "connected",
		getServerReceiptState: () => "confirmed",
		getReceiptSnapshot: () => ({ serverAppliedLocalState: true, lastServerReceiptEchoAt: 1, lastKnownServerReceiptEchoAt: 1, hasCandidateSv: false }),
		getActiveMarkdownPaths: () => [],
		getDiskMarkdownPaths: () => [],
		getEditorBindingHealth: () => ({ path: "x.md", hasCm6Extension: true, hasYjsBinding: true, isQaPaused: false, editorViewExists: true }),
		getRuntimeState: () => "foreground",
		getDiskHash: async () => null,
		getCrdtHash: async () => null,
		getEditorHash: async () => null,
		waitForIdle: async () => {},
		waitForLocalReady: async () => {},
		waitForProviderSynced: async () => {},
		waitForReconciled: async () => {},
		waitForFile: async () => {},
		waitForReceiptAfter: async () => {},
		forceReconcile: async () => {},
		forceReconnect: () => {},
		disconnectProvider: () => {},
		connectProvider: () => {},
		startFlightTrace: async () => {},
		stopFlightTrace: async () => {},
		exportFlightTrace: async () => "",
		getActiveTraceInfo: () => null,
	};

	assert(typeof mockDebugPort.isLocalReady === "function", "isLocalReady is a function");
	assert(typeof mockDebugPort.waitForIdle === "function", "waitForIdle is a function");
	assert(typeof mockDebugPort.forceReconcile === "function", "forceReconcile is a function");
	assert(typeof mockDebugPort.getDiskHash === "function", "getDiskHash is a function");
	assert(typeof mockDebugPort.getActiveTraceInfo === "function", "getActiveTraceInfo is a function");

	// Verify no unsafe methods leak into debug port.
	const debugPortKeys = Object.keys(mockDebugPort);
	assert(!debugPortKeys.some(k => k.includes("__qaOnly")), "no __qaOnly methods in debug port");
	assert(!debugPortKeys.some(k => k.includes("Scenario")), "no scenario methods in debug port");
	assert(!debugPortKeys.some(k => k.includes("Unsafe")), "no Unsafe methods in debug port");
}

console.log("\n--- Test 2: KaosUnsafeQaPort interface shape ---");
{
	const mockUnsafePort: KaosUnsafeQaPort = {
		__qaOnlyForceCrdtContentUnsafe: async () => ({ beforeHash: null, afterHash: "abc", fileExisted: false }),
		__qaOnlyClearMarkdownAttentionUnsafe: () => {},
		ingestDiskFileNow: async () => {},
		pauseEditorPropagation: async () => true,
		resumeEditorPropagation: async () => true,
		setEditorHandoffHostApiVersionOverride: () => {},
		holdNextHostLoad: () => {},
		releaseHeldHostLoad: () => {},
		holdNextNativeSave: () => {},
		releaseHeldNativeSave: () => {},
		getEditorHandoffDebugSnapshot: () => ({
			hostLoad: null,
			nativeSave: null,
			lastInterceptedExternalDiskMutation: null,
			leaves: [],
		}),
		getContentFreeSnapshot: () => ({
			hostLoad: null,
			nativeSave: null,
			lastInterceptedExternalDiskMutation: null,
			leaves: [],
		}),
		setQaNetworkHold: () => {},
		__qaOnlySetScenarioRunIdUnsafe: () => {},
		__qaOnlyAdvanceScenarioStepUnsafe: () => {},
		__qaOnlyEmitPhaseUnsafe: async () => {},
		setDiskIngestSuspended: async () => ({ previous: false }),
		witnessDeviceSettled: async () => {},
		computeWitnessStateHash: async () => "hash",
		getDeviceId: () => "device-1",
	};

	assert(typeof mockUnsafePort.__qaOnlyForceCrdtContentUnsafe === "function", "forceCrdt exists");
	assert(
		typeof mockUnsafePort.__qaOnlyClearMarkdownAttentionUnsafe === "function",
		"fixture-owned Markdown Attention cleanup exists only on the unsafe QA port",
	);
	assert(typeof mockUnsafePort.setQaNetworkHold === "function", "network hold exists");
	assert(typeof mockUnsafePort.__qaOnlySetScenarioRunIdUnsafe === "function", "scenario run id exists");
	assert(typeof mockUnsafePort.__qaOnlyAdvanceScenarioStepUnsafe === "function", "scenario step exists");
	assert(typeof mockUnsafePort.witnessDeviceSettled === "function", "witness settled exists");
	assert(
		!("setExternalEditPolicyOverride" in mockUnsafePort),
		"unsafe port exposes no product-policy override",
	);
	assert(
		typeof mockUnsafePort.setDiskIngestSuspended === "function",
		"unsafe port exposes the QA-only disk-ingest suspension",
	);

	// Verify all methods have __qaOnly or explicit unsafe/scenario naming.
	const unsafeKeys = Object.keys(mockUnsafePort);
	const safeReadKeys = ["witnessDeviceSettled", "computeWitnessStateHash", "getDeviceId", "setQaNetworkHold"];
	const explicitEngineControls = [
		"ingestDiskFileNow",
		"pauseEditorPropagation",
		"resumeEditorPropagation",
		"setEditorHandoffHostApiVersionOverride",
		"setDiskIngestSuspended",
		"holdNextHostLoad",
		"releaseHeldHostLoad",
		"holdNextNativeSave",
		"releaseHeldNativeSave",
		"getEditorHandoffDebugSnapshot",
		"getContentFreeSnapshot",
	];
	const unsafeOnlyKeys = unsafeKeys.filter(k => !safeReadKeys.includes(k));
	assert(
		unsafeOnlyKeys.every(k =>
			k.includes("__qaOnly") || k.includes("Unsafe") || explicitEngineControls.includes(k)
		),
		"all mutation methods are explicitly scoped QA controls",
	);
}

console.log("\n--- Test 3: debug port has no data-mutating methods ---");
{
	// The key contract: KaosDebugPort should not be able to mutate CRDT content,
	// control scenarios, or override policies.
	const debugMethods = [
		"isLocalReady", "isProviderSynced", "isProviderConnected", "isReconciled",
		"isReconcileInFlight", "getConnectionState", "getServerReceiptState",
		"getReceiptSnapshot", "getActiveMarkdownPaths", "getDiskMarkdownPaths",
		"getEditorBindingHealth", "getRuntimeState", "getDiskHash", "getCrdtHash",
		"getEditorHash", "waitForIdle", "waitForLocalReady", "waitForProviderSynced",
		"waitForReconciled", "waitForFile", "waitForReceiptAfter",
		"forceReconcile", "forceReconnect", "disconnectProvider", "connectProvider",
		"startFlightTrace", "stopFlightTrace", "exportFlightTrace", "getActiveTraceInfo",
	];

	const dangerousPatterns = ["forceCrdt", "forceSync", "Scenario", "networkHold", "Override"];
	for (const method of debugMethods) {
		assert(
			!dangerousPatterns.some(p => method.toLowerCase().includes(p.toLowerCase())),
			`debug port method '${method}' is not dangerous`,
		);
	}
}

console.log("\n--- Test 4: guard:qa-isolation passes ---");
{
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync("node", ["scripts/guard-qa-isolation.mjs"], { encoding: "utf8" });
	assert(result.status === 0, "guard:qa-isolation passes");
	assert(result.stdout.includes("PASS"), "output includes PASS");
}

console.log("\n--- Test 5: product policy is absent and QA suspension is build-gated ---");
{
	const read = (relativePath: string) => readFileSync(
		new URL(`../${relativePath}`, import.meta.url),
		"utf8",
	);
	const readOptional = (relativePath: string) => {
		const url = new URL(`../${relativePath}`, import.meta.url);
		return existsSync(url) ? readFileSync(url, "utf8") : "";
	};
	const enginePortSource = read("src/runtime/engineControlPort.ts");
	const mainSource = read("src/main.ts");
	const reconciliationControllerSource = read("src/runtime/reconciliationController.ts");
	const unsafePortSource = read("qa/harness/ports/kaosUnsafeQaPort.ts");
	const qaApiSource = read("qa/harness/qaDebugApi.ts");
	const twoDeviceSource = read("qa/controllers/two-device.ts");
	const s05Source = read("qa/obsidian-harness/scenarios/s05-frontmatter-safety-loop.ts");
	const s06aSource = read("qa/obsidian-harness/scenarios/s06a-issue-25-forced-recovery.ts");
	const s10dSource = read("qa/obsidian-harness/scenarios/s10d-recovery-amplifier-orchestration.ts");
	const prepareVaultSource = read("qa/scripts/prepare-vault.ts");
	const productionGuardSource = read("scripts/guard-production-bundles.mjs");
	const qaScenarioSource = read(
		"qa/obsidian-harness/scenarios/s13a-editor-handoff-host-fences.ts",
	);
	const qaControllerSource = read("qa/controllers/editor-handoff-host-fences.ts");
	const controllerClientSource = read("qa/controllers/obsidian-client.ts");
	const packageSource = read("package.json");
	const harnessMainSource = read("qa/obsidian-harness/main.ts");
	const harnessBuildSource = read("qa/obsidian-harness/esbuild.mjs");
	const harnessApiSource = read("qa/obsidian-harness/api.ts");
	const harnessTypesSource = read("qa/obsidian-harness/types.ts");
	const samePathAdoptionContractSource = readOptional(
		"qa/contracts/same-path-adoption.ts",
	);
	const samePathAdoptionScenarioSource = readOptional(
		"qa/obsidian-harness/scenarios/s13e-same-path-adoption.ts",
	);
	const samePathAdmissionFixtureSource = readOptional(
		"qa/obsidian-harness/same-path-admission-fixture.ts",
	);
	const samePathAdoptionControllerSource = readOptional(
		"qa/controllers/same-path-adoption.ts",
	);
	const livePreflightSources = [qaScenarioSource];

	assert(
		enginePortSource.includes("setDiskIngestSuspended(suspended: boolean): boolean") &&
			enginePortSource.includes(
				'holdNextHostLoad(path: string, stage?: "load-entry" | "clear-load"): void',
			) &&
			enginePortSource.includes("getEditorHandoffDebugSnapshot(): EditorHandoffDebugSnapshot") &&
			enginePortSource.includes("getContentFreeSnapshot(): EditorHandoffDebugSnapshot") &&
			enginePortSource.includes("setEditorHandoffHostApiVersionOverride(version: string | null): void") &&
			enginePortSource.includes("managed: true") &&
			enginePortSource.includes("active: boolean") &&
			enginePortSource.includes('clearLoadCapability: "observable" | "clear-load-not-observable"') &&
			enginePortSource.includes("readonly adoption: SamePathAdoptionDebugSnapshot") &&
			enginePortSource.includes(
				'commitFailureReason?: CodeMirrorHandoffGuardSnapshot["commitFailureReason"]',
			) &&
			enginePortSource.includes("hostPostDelegationFailureReason?: string | null") &&
			!enginePortSource.includes("HandoffRecoveryQa") &&
			!enginePortSource.includes("setExternalEditPolicyOverride"),
		"EngineControlPort exposes only active handoff controls without replay Recovery seams",
	);
	assert(
		livePreflightSources.every((source) =>
			!source.includes("requestSaveCancellable")
			&& !source.includes("request-save-not-cancellable")
		) && livePreflightSources.every((source) =>
			source.includes("getContentFreeSnapshot")
			&& source.includes("hostCapabilityState")
			&& source.includes("clearLoadCapability")
		),
		"live handoff preflights use managed content-free capability evidence, never requestSave.cancel",
	);
	assert(
		mainSource.includes("isDiskIngestSuspendedForQa") &&
			mainSource.includes("...(__KAOS_QA_HARNESS_ENABLED__ ? {") &&
			mainSource.includes("diskIngestSuspended") &&
			mainSource.includes("installEditorHandoffHostQaBarrier") &&
			mainSource.includes("getEditorHandoffQaDebugSnapshot") &&
			!mainSource.includes("handoffRecoveryFault") &&
			!mainSource.includes("handoffRecoveryLastAcceptedState") &&
			!mainSource.includes("clipboard-rejected"),
		"main wires active handoff QA controls without retired Recovery fault state",
	);
	assert(
		mainSource.includes(
			"type PersistedPluginState = Partial<VaultSyncSettings> & ExternalEditPolicyCompatibilityFields",
		),
		"persisted plugin state retains typed downgrade compatibility fields",
	);
	assert(
		!mainSource.includes("getEffectiveExternalEditPolicy") &&
			!mainSource.includes("externalEditPolicyOverride") &&
			!mainSource.includes("preserveRejectedExternalEditorReload") &&
			!mainSource.includes("maybeImportDeferredClosedOnlyPath"),
		"main contains no production policy branch or closed-only close hook",
	);
	assert(
		unsafePortSource.includes("setDiskIngestSuspended") &&
			unsafePortSource.includes("__qaOnlyClearMarkdownAttentionUnsafe(path: string): void") &&
			unsafePortSource.includes("setEditorHandoffHostApiVersionOverride") &&
			!unsafePortSource.includes("HandoffRecoveryQa") &&
			qaApiSource.includes("setDiskIngestSuspended") &&
			qaApiSource.includes("__qaOnlyClearMarkdownAttentionUnsafe(path: string): void") &&
			qaApiSource.includes("plugin.clearMarkdownAttentionForQa(path)") &&
			!qaApiSource.includes("HandoffRecoveryQa") &&
			qaApiSource.includes("setEditorHandoffHostApiVersionOverride") &&
			twoDeviceSource.includes("setDiskIngestSuspended"),
		"QA ports expose active fixture cleanup and suspension without Recovery replay seams",
	);
	assert(
		harnessMainSource.includes("clearMarkdownAttentionForQa: (path: string)") &&
			harnessMainSource.includes("diskMirror?.clearPreservedUnresolved(path)"),
		"QA harness wires fixture Attention cleanup directly to the QA product registry",
	);
	assert(
		harnessBuildSource.includes('"__KAOS_QA_HARNESS_ENABLED__": "true"'),
		"QA harness build explicitly enables its build-gated mutation fixtures",
	);
	assert(
		(reconciliationControllerSource.match(/isDiskIngestSuspendedForQa\?\.\(\)/g) ?? []).length >= 2,
		"QA suspension fences both explicit and automatic disk ingest",
	);
	assert(
		qaApiSource.includes("ingestDiskFileNow(") &&
			qaApiSource.includes("pauseEditorPropagation(") &&
			qaApiSource.includes("resumeEditorPropagation(") &&
			!qaApiSource.includes("__qaOnlyForceSyncFileFromDiskUnsafe") &&
			!qaApiSource.includes("__qaOnlyPauseEditorBindingPropagationUnsafe") &&
			!qaApiSource.includes("__qaOnlyResumeEditorBindingPropagationUnsafe"),
		"KaosQaDebugApi exposes only the current engine-control method names",
	);
	assert(
		qaApiSource.includes('await plugin.saveSettings("qa:trace-secret")') &&
			!qaApiSource.includes("saveData?.(p.settings)"),
		"QA trace-secret writes use the canonical settings persistence boundary",
	);
	assert(
		![unsafePortSource, qaApiSource, twoDeviceSource, s05Source, s06aSource, s10dSource]
			.some((source) => source.includes("setExternalEditPolicyOverride")),
		"QA harness and migrated scenarios contain no legacy policy override",
	);
	assert(
		prepareVaultSource.includes('externalEditPolicy: "always"') &&
			prepareVaultSource.includes("externalEditPolicySafetyMigrationVersion: 1"),
		"prepared QA vault writes only canonical downgrade compatibility fields",
	);
	assert(
		productionGuardSource.includes('"setDiskIngestSuspended"') &&
			productionGuardSource.includes('"setEditorHandoffHostApiVersionOverride"') &&
			productionGuardSource.includes('"holdNextHostLoad"') &&
			productionGuardSource.includes('"getEditorHandoffDebugSnapshot"') &&
			productionGuardSource.includes('"getContentFreeSnapshot"') &&
			productionGuardSource.includes('"qaReplayObservation"') &&
			productionGuardSource.includes('"__qaOnlyArmHandoffRecoveryFaultUnsafe"') &&
			productionGuardSource.includes('"beforePutBeforeStorage"') &&
			productionGuardSource.includes('"clipboard-rejected"') &&
			productionGuardSource.includes("QA_PRODUCT_REQUIRED") &&
			productionGuardSource.includes('"associateEditorHandoffHostQaBarrier"') &&
			productionGuardSource.includes('"recordInterceptedExternalDiskMutation"') &&
			productionGuardSource.includes('"lastInterceptedExternalDiskMutation"') &&
			productionGuardSource.includes('"setExternalEditPolicyOverride"'),
		"production bundle guard bans both new and legacy unsafe controls",
	);
	assert(
		qaScenarioSource.includes('id: EDITOR_HANDOFF_HOST_FENCES_SCENARIO_ID') &&
			qaScenarioSource.includes('"save-entered-before-switch"') &&
			qaScenarioSource.includes('"supersede-b-with-c"') &&
			qaScenarioSource.includes(
				"holdNextHostLoad(EDITOR_HANDOFF_HOST_FENCE_PATHS.b)",
			) &&
			qaControllerSource.includes("clickVaultFileIntent(PATH_B)") &&
			qaControllerSource.includes("clickVaultFileIntent(PATH_C)") &&
			!qaScenarioSource.includes("typeIntoFile(") &&
			!qaScenarioSource.includes("replaceFileContent(") &&
			!qaScenarioSource.includes("setValue("),
		"S13a uses the six-phase host protocol without renderer text mutation helpers",
	);
	const heldExternalProofSource = qaControllerSource.slice(
		qaControllerSource.indexOf("async function waitForHeldExternalTargetProof"),
		qaControllerSource.indexOf("async function serviceSaveBeforeSwitch"),
	);
	const exactExternalAdmissionSource = qaScenarioSource.slice(
		qaScenarioSource.indexOf("async function waitForExactExternalTargetAdmission"),
		qaScenarioSource.indexOf("async function waitForExactExternalTargetConvergence"),
	);
	assert(
		createHash("sha256")
			.update(EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.content, "utf8")
			.digest("hex") === EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.sha256 &&
			qaControllerSource.includes("EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.content") &&
			qaScenarioSource.includes("EDITOR_HANDOFF_HELD_EXTERNAL_TARGET_REVISION.sha256"),
		"S13a controller and scenario share one exact external B revision and SHA-256 contract",
	);
	assert(
		heldExternalProofSource.includes("snapshot.lastInterceptedExternalDiskMutation") &&
			heldExternalProofSource.includes("receipt.sequence > beforeSequence") &&
			heldExternalProofSource.includes("receipt.contentHash === expectedHash") &&
			heldExternalProofSource.includes("last.leafViewPath === PATH_B") &&
			heldExternalProofSource.includes("last.leafDisplayedPath !== PATH_B") &&
			heldExternalProofSource.includes("last.leafBindingPath !== PATH_B") &&
			!heldExternalProofSource.includes("interceptedExternalDiskMutations") &&
			!heldExternalProofSource.includes("crdtHash"),
		"S13a held-load proof requires a newer exact public receipt at the target-only seam",
	);
	assert(
		exactExternalAdmissionSource.includes("leaf.viewPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b") &&
			exactExternalAdmissionSource.includes("leaf.displayedPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b") &&
			exactExternalAdmissionSource.includes("leaf.bindingPath === EDITOR_HANDOFF_HOST_FENCE_PATHS.b") &&
			exactExternalAdmissionSource.includes("leaf.gateClosed === false") &&
			exactExternalAdmissionSource.includes("leaf.saveGuardInstalled === false") &&
			exactExternalAdmissionSource.includes("activeViewLeafId === leafId") &&
			exactExternalAdmissionSource.includes("activeEditorContent === expected.content") &&
			exactExternalAdmissionSource.includes("activeEditorHash === expected.sha256") &&
			qaScenarioSource.includes("waitForExactExternalTargetConvergence(ctx)") &&
			!qaScenarioSource.includes("heldExternalTargetHash"),
		"S13a waits through host retry for exact same-leaf B admission and fixed disk/CRDT convergence",
	);
	assert(
		controllerClientSource.includes('type: "rawKeyDown"') &&
			controllerClientSource.includes('type: "char"') &&
			controllerClientSource.includes('type: "keyUp"') &&
			controllerClientSource.includes('"Input.imeSetComposition"') &&
			controllerClientSource.includes('"Input.dispatchMouseEvent"') &&
			controllerClientSource.includes("async clickVaultFileIntent") &&
			qaControllerSource.includes("waitForExternalPhase") &&
			qaControllerSource.includes("resumeExternalPhase") &&
			qaControllerSource.includes("setImeCompositionSequence") &&
			qaControllerSource.includes("setImeComposition(") &&
			qaControllerSource.includes("waitForRejectedHeldInput") &&
			qaControllerSource.includes("leaf.intent === null") &&
			qaControllerSource.includes("(leaf.activeCompositionCapturedUpdates ?? 0) >= 1"),
		"controller proves fresh CDP key and IME rejection while retaining exact source-composition coverage",
	);
	const imeCommitSource = controllerClientSource.slice(
		controllerClientSource.indexOf("async commitImeText"),
		controllerClientSource.indexOf("/** Combine active DOM focus"),
	);
	assert(
		imeCommitSource.includes('cdp.send("Input.insertText", { text })')
			&& !imeCommitSource.includes("Input.imeSetComposition"),
		"IME commit uses one native insertText completion without opening a second composition epoch",
	);
	assert(
		packageSource.includes(
			'"qa:handoff-host-fences": "bun run qa/controllers/editor-handoff-host-fences.ts"',
		),
		"dedicated handoff host-fence controller entry point is registered",
	);
	assert(
		controllerClientSource.includes("disableProductPlugin") &&
			controllerClientSource.includes("enableProductPlugin") &&
			controllerClientSource.includes("rebindKaosDebugApi") &&
			!controllerClientSource.includes("clickHandoffRecoveryRowButton") &&
			!controllerClientSource.includes("fillVisibleHandoffRecoveryExportPath"),
		"ObsidianClient retains active reload helpers without retired Recovery UI automation",
	);
	assert(
		harnessMainSource.includes("rebindKaosDebugApi") &&
			harnessApiSource.includes("rebindKaosDebugApi") &&
			harnessTypesSource.includes("rebindKaosDebugApi(): boolean"),
		"only the harness console wrapper can remount a fresh product debug API",
	);
	const samePathAdoptionPhases = [
		"clean-merge-during-planning",
		"native-undo-local",
		"native-redo-local",
		"held-save-reload",
		"overlap-conflict-evidence",
		"artifact-failure",
		"artifact-retry",
		"identical-multi-pane",
		"distinct-multi-pane",
		"distinct-multi-pane-observed",
		"unsupported-host-fallback",
	];
	assert(
		samePathAdoptionContractSource.includes(
			'SAME_PATH_ADOPTION_SCENARIO_ID = "s13e-same-path-adoption"',
		) && samePathAdoptionPhases.every((phase) =>
			samePathAdoptionContractSource.includes(`| "${phase}"`)) &&
			samePathAdoptionContractSource.includes("SAME_PATH_ADOPTION_PATHS") &&
			!samePathAdoptionContractSource.includes('from "obsidian"'),
		"S13e owns ten evidence phases plus one closed conflict-observation ACK",
	);
	assert(
		samePathAdoptionScenarioSource.includes("getContentFreeSnapshot") &&
			samePathAdoptionScenarioSource.includes("stable-line-") &&
			samePathAdoptionScenarioSource.includes("Array.from({ length: 96 }") &&
			samePathAdoptionScenarioSource.includes("adoption.kind") &&
			samePathAdoptionScenarioSource.includes("setDiskIngestSuspended") &&
			samePathAdoptionScenarioSource.includes("pauseEditorPropagation") &&
			samePathAdoptionScenarioSource.includes("__qaOnlyForceCrdtContentUnsafe") &&
			samePathAdoptionScenarioSource.includes("__qaOnlyClearMarkdownAttentionUnsafe(path)") &&
			samePathAdoptionScenarioSource.includes("waitForReceiptAfter") &&
			samePathAdoptionPhases.every((phase) =>
				samePathAdoptionScenarioSource.includes(`"${phase}"`)) &&
			!samePathAdoptionScenarioSource.includes("typeIntoFile(") &&
			!samePathAdoptionScenarioSource.includes("replaceFileContent(") &&
			!samePathAdoptionScenarioSource.includes("setValue(") &&
			!samePathAdoptionScenarioSource.includes("openLinkText("),
		"S13e scenario observes content-free adoption evidence without renderer text mutation helpers",
	);
	assert(
		samePathAdoptionScenarioSource.includes("atomicallyReadmitDistinctPanesForQa") &&
			samePathAdmissionFixtureSource.includes("atomicallyReadmitSamePathPanesForQa") &&
			samePathAdmissionFixtureSource.includes("freezeSamePathPaneProjectionForQa") &&
			samePathAdmissionFixtureSource.includes("input.manager.unbind") &&
			samePathAdmissionFixtureSource.includes("input.manager.bind(panes[0]!") &&
			!samePathAdmissionFixtureSource.includes('from "../../../src/'),
		"S13e distinct-pane fixture atomically removes every live binding before one coordinator admission",
	);
	assert(
		samePathAdoptionControllerSource.includes("waitForExternalPhase") &&
			samePathAdoptionControllerSource.includes("resumeExternalPhase") &&
			samePathAdoptionControllerSource.includes("dispatchPhysicalKey") &&
			samePathAdoptionControllerSource.includes("readActiveEditorGeometry") &&
			samePathAdoptionControllerSource.includes("assertDistinctMarkdownPaneLocals") &&
			!samePathAdoptionControllerSource.includes("dragActiveCodeMirrorSelection") &&
			samePathAdoptionControllerSource.includes("dispatchNativeShortcut") &&
			samePathAdoptionControllerSource.includes("disableProductPlugin") &&
			samePathAdoptionControllerSource.includes("enableProductPlugin") &&
			samePathAdoptionControllerSource.includes("rebindKaosDebugApi") &&
			samePathAdoptionControllerSource.includes("apiVersion") &&
			samePathAdoptionControllerSource.includes("canonicalLiveVault !== expectedVault"),
		"S13e controller owns physical input, reload, host-version injection, and vault identity",
	);
	assert(
		samePathAdoptionControllerSource.includes("snapshot.pendingOwnedSave?.file !== view.file") &&
			samePathAdoptionControllerSource.includes("view.dirty !== true") &&
			samePathAdoptionControllerSource.includes("__KAOS_S13E_OWNED_SAVE_PROBE__") &&
			samePathAdoptionControllerSource.includes("waitForPendingOwnedSaveDrain") &&
			samePathAdoptionControllerSource.includes("pending owned save drain timed out") &&
			samePathAdoptionControllerSource.includes("pending owned save advanced past one drain") &&
			samePathAdoptionControllerSource.includes("drained.saveEpochDelta !== 3") &&
			samePathAdoptionControllerSource.includes("drained.dirty") &&
			samePathAdoptionControllerSource.includes("late native save mutated the new boot session") &&
			!samePathAdoptionControllerSource.includes("holdNextNativeSave"),
		"S13e waits through async unload settlement, proves one drain, and rejects a late native tail",
	);
	assert(
		harnessMainSource.includes("s13eSamePathAdoption") &&
			packageSource.includes(
				'"qa:same-path-adoption": "bun run qa/controllers/same-path-adoption.ts"',
			),
		"S13e is registered once with a dedicated controller entry point",
	);
	assert(
		productionGuardSource.includes('"baseRetained"') &&
			productionGuardSource.includes("QA_PRODUCT_REQUIRED"),
		"production bundle fencing covers the content-free adoption snapshot vocabulary",
	);

	const productionBundleUrl = new URL("../main.js", import.meta.url);
	const qaProductBundleUrl = new URL("../qa/obsidian-harness/product-main.js", import.meta.url);
	if (existsSync(productionBundleUrl) && existsSync(qaProductBundleUrl)) {
		const productionBundle = readFileSync(productionBundleUrl, "utf8");
		const qaProductBundle = readFileSync(qaProductBundleUrl, "utf8");
		const fencedSymbols = [
			"holdNextHostLoad",
			"releaseHeldHostLoad",
			"holdNextNativeSave",
			"releaseHeldNativeSave",
			"getEditorHandoffDebugSnapshot",
			"getContentFreeSnapshot",
			"lastInterceptedExternalDiskMutation",
			"setEditorHandoffHostApiVersionOverride",
			"baseRetained",
			"installEditorHandoffHostQaBarrier",
			"getEditorHandoffQaDebugSnapshot",
			"associateEditorHandoffHostQaBarrier",
		];
		assert(
			fencedSymbols.every((symbol) => !productionBundle.includes(symbol)),
			"production main.js erases every editor handoff QA symbol",
		);
		assert(
			fencedSymbols.every((symbol) => qaProductBundle.includes(symbol)),
			"QA product bundle retains every editor handoff barrier/control symbol",
		);
	}
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
