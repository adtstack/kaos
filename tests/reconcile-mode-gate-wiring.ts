import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

const mainSource = readFileSync("src/main.ts", "utf8");
const vaultSyncSource = readFileSync("src/sync/vaultSync.ts", "utf8");
const controllerSource = readFileSync(
	"src/runtime/reconciliationController.ts",
	"utf8",
);
const commandsSource = readFileSync("src/commands.ts", "utf8");

console.log("\n--- Test 1: getSafeReconcileMode delegates to the pure policy ---");
{
	assert(
		vaultSyncSource.includes("decideSafeReconcileMode({"),
		"vaultSync.getSafeReconcileMode delegates to decideSafeReconcileMode",
	);
	const modeStart = vaultSyncSource.indexOf("getSafeReconcileMode(): ReconcileMode");
	const modeSource = modeStart >= 0 ? vaultSyncSource.slice(modeStart, modeStart + 500) : "";
	assert(
		modeSource.includes("localReady: this._localReady"),
		"the delegated input includes localReady",
	);
	assert(
		!modeSource.includes('if (this._providerSynced) return "authoritative";'),
		"the provider-synced short-circuit is gone",
	);
}

console.log("\n--- Test 2: controller clamps authoritative runs on unhydrated local replica ---");
{
	const runStart = controllerSource.indexOf("async runReconciliation(");
	const runSource = runStart >= 0 ? controllerSource.slice(runStart, runStart + 3500) : "";
	assert(runStart >= 0, "runReconciliation exists");
	assert(
		runSource.includes("vaultSync.localReady === false || vaultSync.idbError === true"),
		"entry gate checks localReady and latched idbError (fail-closed)",
	);
	assert(
		runSource.includes("PRODUCT_EVENT_KIND.reconcileModeDowngraded"),
		"downgrade emits its dedicated flight event kind",
	);
	assert(
		runSource.includes('"reconcile-mode-downgraded-unhydrated-local"'),
		"downgrade reason is attributable",
	);
	assert(
		runSource.includes("PRODUCT_EVENT_KIND.reconcileForcedUnhydrated"),
		"forced override emits its own flight event kind",
	);
	assert(
		runSource.includes("options?: { forceUnhydrated?: boolean }"),
		"force option is part of the signature",
	);
}

console.log("\n--- Test 3: main wires event-driven promotion and drops the provider gate ---");
{
	const tickStart = mainSource.indexOf("IndexedDB became ready after the startup wait");
	const tickSource = tickStart >= 0 ? mainSource.slice(tickStart, tickStart + 800) : "";
	assert(tickStart >= 0, "status-tick localReady branch exists");
	assert(
		tickSource.includes("vaultSync.getSafeReconcileMode()"),
		"status tick re-derives the mode",
	);
	assert(
		!tickSource.includes("if (this.blobProviderReady)"),
		"status tick no longer gates the markdown re-reconcile on blobProviderReady",
	);
	assert(
		mainSource.includes("vaultSync.onLocalPersistenceReady("),
		"main registers the local-persistence-ready promotion callback",
	);
	const promoStart = mainSource.indexOf("vaultSync.onLocalPersistenceReady(");
	const promoSource = promoStart >= 0 ? mainSource.slice(promoStart, promoStart + 400) : "";
	assert(
		promoSource.includes("this.blobLocalPersistenceReady = true"),
		"promotion callback marks blobLocalPersistenceReady to prevent redundant status-tick reconcile",
	);
}

console.log("\n--- Test 4: manual escape-hatch command exists ---");
{
	assert(
		commandsSource.includes('id: "force-reconcile-unhydrated"'),
		"force-reconcile-unhydrated command is registered",
	);
	assert(
		commandsSource.includes("{ forceUnhydrated: true }"),
		"command passes the force option",
	);
}

console.log("\n--- Test 5: apply-remote observability is wired ---");
{
	assert(
		controllerSource.includes('"open-file-crdt-authoritative-baseline-text-unknown"'),
		"open-file CRDT-authoritative path audits unknown baseline text",
	);
	assert(
		controllerSource.includes('"closed-file-crdt-authoritative-baseline-text-unknown"'),
		"closed-file CRDT-authoritative path audits unknown baseline text",
	);
	assert(
		controllerSource.includes("baselineTextKnown"),
		"flight events carry baselineTextKnown",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
