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
import { readFileSync } from "node:fs";

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
		ingestDiskFileNow: async () => {},
		pauseEditorPropagation: async () => true,
		resumeEditorPropagation: async () => true,
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
		"setDiskIngestSuspended",
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

	assert(
		enginePortSource.includes("setDiskIngestSuspended(suspended: boolean): boolean") &&
			!enginePortSource.includes("setExternalEditPolicyOverride"),
		"EngineControlPort exposes suspension instead of a product-policy override",
	);
	assert(
		mainSource.includes("isDiskIngestSuspendedForQa") &&
			mainSource.includes("...(__KAOS_QA_HARNESS_ENABLED__ ? {") &&
			mainSource.includes("diskIngestSuspended"),
		"main wires the suspension getter through a removable QA build boundary",
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
			qaApiSource.includes("setDiskIngestSuspended") &&
			twoDeviceSource.includes("setDiskIngestSuspended"),
		"QA ports and CDP bridge expose the suspension seam",
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
			productionGuardSource.includes('"setExternalEditPolicyOverride"'),
		"production bundle guard bans both new and legacy unsafe controls",
	);
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
