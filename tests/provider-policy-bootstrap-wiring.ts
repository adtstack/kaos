import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

assert.match(
	main,
	/import \{\s*RemoteProjectionPolicyGate,\s*\} from "\.\/runtime\/remoteProjectionPolicyGate";/,
	"main owns the provider-generation projection gate",
);
assert.match(
	main,
	/readKaosExcludeFileFromCrdt/,
	"main reads the shared provider policy directly from converged CRDT state",
);
assert.match(
	main,
	/providerExcludeFilePatterns/,
	"main keeps a temporary provider policy overlay separate from the disk policy",
);
assert.match(
	main,
	/mergeExcludePatterns\(\s*runtimeConfig\.excludePatterns,\s*this\.excludeFilePatterns,\s*this\.providerExcludeFilePatterns,/,
	"the effective policy conservatively unions legacy, disk, and provider snapshots",
);

const diskPredicate = main.indexOf("setRemoteProjectionAdmissionPredicate");
const observersStart = main.indexOf("this.diskMirror.startMapObservers()");
assert.ok(
	diskPredicate >= 0 && observersStart > diskPredicate,
	"DiskMirror receives the closed projection gate before remote observers start",
);

const providerClose = main.indexOf("closeRemoteProjectionForProviderGeneration");
const providerPrepare = main.indexOf("prepareProviderSyncPolicy");
const connectionWiring = /prepareProviderSync: \(generation\) =>\s*this\.prepareProviderSyncPolicy/.test(main);
assert.ok(providerClose >= 0, "provider connection lifecycle closes each generation");
assert.ok(providerPrepare >= 0, "provider sync has one policy preparation boundary");
assert.ok(connectionWiring, "ConnectionController prepares policy before reconnect reconciliation");

const waitForProvider = main.indexOf("const providerSynced = await vaultSync.waitForProviderSync()");
const startupPrepare = main.indexOf("this.prepareProviderSyncPolicy", waitForProvider);
const startupReconcile = main.indexOf("await this.runReconciliation(mode)", startupPrepare);
assert.ok(
	waitForProvider >= 0 &&
		startupPrepare > waitForProvider &&
		startupReconcile > startupPrepare,
	"startup establishes provider policy after convergence and before reconciliation",
);

assert.match(
	main,
	/onReconciled: \(reason\) => \{[\s\S]*settleProviderExcludePolicyOverlay/,
	"authoritative reconciliation settles the bootstrap overlay from disk",
);

console.log("PASS provider policy bootstrap wiring");
