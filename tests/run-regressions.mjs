#!/usr/bin/env node
// Regression test runner. Executes each test suite in sequence, reports
// pass/fail per suite, and exits non-zero if any suite fails.
//
// IMPORTANT: Always run regressions via `npm run test:regressions` (or this
// script directly). Do NOT run individual suites with bare
// `node --import jiti/register tests/foo.ts` — the JITI_ALIAS env injected
// below (yjs deduplication, obsidian mock, partyserver mock) will be absent
// and you may see the "Yjs was already imported" warning or import failures.
//
// CLI flags:
//   --only <substring>   Run only suites whose path contains <substring>.
//                        Repeatable. May also be passed as --only=<substring>.
//                        With no --only flags, all suites run.
//                        If no suite matches, the runner exits non-zero.
//   --skip <substring>   Exclude suites whose path contains <substring>.
//                        Repeatable. May also be passed as --skip=<substring>.
//                        If no suite matches, the runner exits non-zero.
//   --list               Print every suite path the runner knows about (one
//                        per line) and exit 0 without running anything.
//                        Honors --only and --skip filters when listing.
//   --help, -h           Print this usage block and exit 0.
//
// Unknown flags or positional args cause the runner to exit non-zero with
// a clear message, so a typo like `--ony` will not silently run the full
// suite.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Force all "yjs" imports to resolve to the single root copy, preventing the
// "Yjs was already imported" constructor-check warning that fires when
// server/node_modules/yjs and node_modules/yjs are both loaded in the same
// process (triggered by tests that import from server/src/).
const ROOT_YJS = fileURLToPath(new URL("../node_modules/yjs/dist/yjs.mjs", import.meta.url));

// Redirect "obsidian" to a minimal runtime mock. The real obsidian package
// ships only TypeScript declarations (no JS), so any test that imports code
// depending on obsidian needs this alias to resolve at runtime.
const OBSIDIAN_MOCK = fileURLToPath(new URL("./mocks/obsidian.ts", import.meta.url));

// Redirect "partyserver" to a minimal runtime mock. The real partyserver
// imports from "cloudflare:workers" which is unavailable in Node.js.
// The mock's getServerByName() intentionally throws — any pre-auth code
// that calls it causes the test to fail loudly (FU-4 invariant).
const PARTYSERVER_MOCK = fileURLToPath(new URL("./mocks/partyserver.ts", import.meta.url));

const JITI_ENV = {
	...process.env,
	JITI_ALIAS: JSON.stringify({ yjs: ROOT_YJS, obsidian: OBSIDIAN_MOCK, partyserver: PARTYSERVER_MOCK }),
};

const JITI = "node --import jiti/register";
const NODE = "node";

const suites = [
	[JITI, "tests/diff-regressions.mjs"],
	[JITI, "tests/remote-typing-guard.ts"],
	[JITI, "tests/bound-recovery-regressions.mjs"],
	[JITI, "tests/editor-binding-recent-activity.ts"],
	[JITI, "tests/editor-handoff-state.ts"],
	[JITI, "tests/editor-handoff-recovery.ts"],
	[JITI, "tests/editor-handoff-exact-replay.ts"],
	[JITI, "tests/handoff-replay-controller.ts"],
	[JITI, "tests/handoff-replay-coordinator.ts"],
	[JITI, "tests/handoff-recovery-replay.ts"],
	[JITI, "tests/handoff-recovery-lifecycle.ts"],
	[JITI, "tests/handoff-recovery-boundaries.ts"],
	[JITI, "tests/text-file-view-handoff-guard.ts"],
	[NODE, "tests/codemirror-handoff-guard.mjs"],
	[JITI, "tests/path-editor-authority.ts"],
	[JITI, "tests/editor-authority-admission.ts"],
	[JITI, "tests/editor-authority-recovery-admission.ts"],
	[JITI, "tests/qa-external-phase-protocol.ts"],
	[JITI, "tests/editor-binding-health-regressions.mjs"],
	[JITI, "tests/frontmatter-guard-regressions.mjs"],
	[JITI, "tests/frontmatter-quarantine-regressions.mjs"],
	[JITI, "tests/frontmatter-guard-orchestration.ts"],
	[NODE, "tests/disk-mirror-regressions.mjs"],
	[JITI, "tests/disk-mirror-origin-classification.ts"],
	[JITI, "tests/disk-index-persistence-wiring.ts"],
	[JITI, "tests/baseline-text-store.ts"],
	[JITI, "tests/baseline-text-persistence-wiring.ts"],
	[JITI, "tests/indexed-db-baseline-text-repository.ts"],
	[JITI, "tests/indexed-db-pending-blob-intent-store.ts"],
	[JITI, "tests/pending-blob-intent-write-ahead.ts"],
	[JITI, "tests/pending-blob-intent-commit.ts"],
	[JITI, "tests/indexed-db-blob-settled-ref-store.ts"],
	[JITI, "tests/handoff-recovery-store.ts"],
	[JITI, "tests/blob-settled-ref-migration.ts"],
	[JITI, "tests/blob-legacy-upgrade-quarantine.ts"],
	[JITI, "tests/headless-baseline-text-repository.ts"],
	[NODE, "tests/headless-baseline-migration.mjs"],
	[NODE, "tests/server-pre-auth-trace.mjs"],
	[NODE, "tests/server-do-amplification.mjs"],
	[JITI, "tests/diagnostics-redaction.mjs"],
	[JITI, "tests/persistent-trace-logger.ts"],
	[JITI, "tests/typed-trace-schema.ts"],
	[JITI, "tests/trace-event-behavior.ts"],
	[JITI, "tests/reconciliation-safety-brake.ts"],
	[JITI, "tests/reconciliation-race-matrix.ts"],
	[JITI, "tests/controller-authority-quarantine.ts"],
	[JITI, "tests/no-event-reconcile-admission.ts"],
	[NODE, "tests/ensure-file-writer-alias-regressions.mjs"],
	[NODE, "tests/ensure-file-writer-allowlist.mjs"],
	[JITI, "tests/path-binding-integrity.ts"],
	[JITI, "tests/authoritative-delete-snapshot.ts"],
	[JITI, "tests/no-event-structural-planner.ts"],
	[JITI, "tests/no-event-structural-reconcile.ts"],
	[JITI, "tests/controller-recovery-orchestration.ts"],
	[JITI, "tests/controller-recovery-orchestration-amplifier.ts"],
	[JITI, "tests/blob-download-conflicts.ts"],
	[JITI, "tests/persisted-blob-queue-source-version.ts"],
	[JITI, "tests/blob-startup-intent-journal.ts"],
	[JITI, "tests/blob-persistence-scope-races.ts"],
	[JITI, "tests/blob-attention-resolution.ts"],
	[JITI, "tests/blob-conflict-resolution.ts"],
	[JITI, "tests/blob-conflict-resolution-flow.ts"],
	[JITI, "tests/markdown-remote-delete-trash-preference.ts"],
	[JITI, "tests/markdown-attention-resolution.ts"],
	[JITI, "tests/closed-file-conflict.ts"],
	[JITI, "tests/preserved-unresolved-registry.ts"],
	[NODE, "tests/markdown-ingest-regressions.mjs"],
	[JITI, "tests/closed-file-mirror.ts"],
	[JITI, "tests/folder-rename.ts"],
	[JITI, "tests/chunked-doc-store.ts"],
	[JITI, "tests/trace-store.ts"],
	[JITI, "tests/server-hardening.ts"],
	[JITI, "tests/server-claim-security.ts"],
	[JITI, "tests/settings-hardening.ts"],
	[JITI, "tests/external-edit-settings-boundary.ts"],
	[JITI, "tests/plugin-teardown-authority-wiring.ts"],
	[JITI, "tests/connection-controller-startup-sync.ts"],
	[JITI, "tests/stable-markdown-reader.ts"],
	[JITI, "tests/setup-link-controller.ts"],
	[JITI, "tests/settings-capability-refresh.ts"],
	[JITI, "tests/guided-server-update.ts"],
	[JITI, "tests/snapshot-lookup.ts"],
	[JITI, "tests/ws-ticket-auth.ts"],
	[JITI, "tests/socket-ticket-refresh.ts"],
	[JITI, "tests/headless-host-core-boundary.ts"],
	[JITI, "tests/headless-host-l1-plugin-host.ts"],
	[JITI, "tests/headless-host-vault-adapter.ts"],
	[JITI, "tests/headless-host-vault-poller.ts"],
	[JITI, "tests/headless-host-human-output.ts"],
	[NODE, "tests/headless-host-cli-config.mjs"],
	[NODE, "tests/headless-host-plugin-smoke.mjs"],
	[NODE, "tests/headless-host-oracle-deploy.mjs"],
	[NODE, "tests/headless-host-oracle-upload-prepare.mjs"],
	[NODE, "tests/headless-host-oracle-rehearsal-runner.mjs"],
	[NODE, "tests/headless-host-oracle-remote-rehearsal.mjs"],
	[NODE, "tests/headless-host-oracle-acceptance.mjs"],
	[NODE, "tests/headless-host-oracle-rehearsal-verifier.mjs"],
	[NODE, "tests/headless-host-release-workflow.mjs"],
	[NODE, "tests/headless-host-user-install.mjs"],
	[NODE, "tests/headless-host-uninstall.mjs"],
	[JITI, "tests/v2-offline-rename-regressions.mjs"],
	[JITI, "tests/sync-facts.ts"],
	[JITI, "tests/offline-handoff.ts"],
	[JITI, "tests/status-label.ts"],
	[JITI, "tests/recovery-amplifier.ts"],
	[JITI, "tests/disk-mirror-observer.ts"],
	[JITI, "tests/server-pre-auth-runtime.ts"],
	[JITI, "tests/server-route-classification-runtime.ts"],
	[JITI, "tests/server-sync-message-classifier.ts"],
	[JITI, "tests/server-sv-echo.ts"],
	[JITI, "tests/server-post-apply-wiring.ts"],
	[JITI, "tests/diagnostics-bundle.ts"],
	[JITI, "tests/ack-origins.ts"],
	[JITI, "tests/state-vector-ack.ts"],
	[JITI, "tests/sv-echo-message.ts"],
	[JITI, "tests/sv-echo-client-receiver.ts"],
	[JITI, "tests/server-ack-tracker.ts"],
	[JITI, "tests/indexed-db-candidate-store.ts"],
	[JITI, "tests/tombstone-revive.ts"],
	[JITI, "tests/flight-recorder.ts"],
	[JITI, "tests/flight-trace-privacy.ts"],
	[JITI, "tests/flight-lifecycle-local-disk-to-server-receipt.ts"],
	[JITI, "tests/server-persistence-pathology.ts"],
	[JITI, "tests/device-witness-tracker.ts"],
	[JITI, "tests/device-witness-tracker-lifecycle.ts"],
	[JITI, "tests/device-witness-qa-api.ts"],
	// Phase 2 verification gates
	[JITI, "tests/witness-schema.ts"],
	[JITI, "tests/witness-hash-normalization.ts"],
	[JITI, "tests/witness-checkpoint-isolation.ts"],
	[JITI, "tests/witness-checkpoint-rotation.ts"],
	[JITI, "tests/witness-readonly-spy.ts"],
	[JITI, "tests/witness-mobile-background.ts"],
	[JITI, "tests/witness-s11b-semantics.ts"],
	// Phase 3 verification gates
	[JITI, "tests/witness-bundle-export.ts"],
	[JITI, "tests/witness-identity-command.ts"],
	[JITI, "tests/witness-persistence-isolation.ts"],
	[JITI, "tests/witness-scenario-step.ts"],
	[NODE, "tests/run-regressions-cli.mjs"],
	// Snapshot safety tests (Phase 0 tourniquet)
	[JITI, "tests/snapshot-retention.ts"],
	[JITI, "tests/snapshot-compat.ts"],
	[JITI, "tests/snapshot-restore-disk-settlement.ts"],
	[JITI, "tests/snapshot-restore-authority.ts"],
	[JITI, "tests/recovery-snapshots.ts"],
	[NODE, "tests/snapshot-r2-runner.mjs"],
	// Autophagy: shared utilities and policy modules
	[JITI, "tests/map-with-concurrency.ts"],
	[JITI, "tests/rename-admission-wiring.ts"],
	[JITI, "tests/vault-event-commit-policy.ts"],
	// Autophagy: canonical path identity
	[JITI, "tests/canonical-path.ts"],
	[JITI, "tests/path-collision.ts"],
	[JITI, "tests/path-category.ts"],
	[JITI, "tests/exclude-file.ts"],
	[JITI, "tests/remote-projection-policy-gate.ts"],
	[JITI, "tests/provider-policy-bootstrap-wiring.ts"],
	[JITI, "tests/provider-policy-settlement-coordinator.ts"],
	[JITI, "tests/conflict-artifact-path.ts"],
	[NODE, "tests/kaos-conflict-resolver.mjs"],
	[NODE, "tests/kaos-file-history-cli.mjs"],
	[JITI, "tests/dashboard-snapshot-cache.ts"],
	[JITI, "tests/dashboard-conflict-resolution.ts"],
	[JITI, "tests/dashboard-attention-resolution.ts"],
	[JITI, "tests/dashboard-attention-lock.ts"],
	[JITI, "tests/dashboard-data.ts"],
	[JITI, "tests/dashboard-handoff-recovery.ts"],
	[JITI, "tests/recovery-history-selection.ts"],
	[JITI, "tests/text-diff.ts"],
	[JITI, "tests/open-external-edit-planner.ts"],
	[JITI, "tests/same-path-adoption-planner.ts"],
	[JITI, "tests/same-path-adoption-controller.ts"],
	[JITI, "tests/same-path-adoption-integration.ts"],
	[JITI, "tests/three-way-merge.ts"],
	// Autophagy: TraceSink dependency inversion
	[JITI, "tests/trace-sink.ts"],
	// Autophagy: QA port fencing
	[JITI, "tests/qa-port-fencing.ts"],
	[JITI, "tests/obsidian-client-page-selection.ts"],
	// Autophagy: ReconciliationController planner/executor
	[JITI, "tests/closed-file-planner.ts"],
	[JITI, "tests/open-bound-file-planner.ts"],
	// Autophagy: Baseline advancement policy
	[JITI, "tests/baseline-advancement-policy.ts"],
	// Autophagy: Safety brake policy
	[JITI, "tests/safety-brake-policy.ts"],
	// Autophagy: Fingerprint quarantine policy
	[JITI, "tests/fingerprint-quarantine-policy.ts"],
	// Autophagy: Amplification quarantine policy
	[JITI, "tests/amplification-quarantine-policy.ts"],
];

let totalPassed = 0;
let totalFailed = 0;

// -----------------------------------------------------------------------
// CLI argument parsing — fail fast on unknown args, support --only/--skip filters.
// -----------------------------------------------------------------------

function printUsage() {
	console.log("Usage: node tests/run-regressions.mjs [--only <substring>]... [--skip <substring>]... [--list] [--help]");
	console.log("");
	console.log("  --only <substring>   Run only suites whose path contains <substring>.");
	console.log("                       Repeatable. May also be passed as --only=<substring>.");
	console.log("  --skip <substring>   Exclude suites whose path contains <substring>.");
	console.log("                       Repeatable. May also be passed as --skip=<substring>.");
	console.log("  --list               Print every suite path (filtered by --only/--skip)");
	console.log("                       and exit without running anything.");
	console.log("  --help, -h           Print this usage block and exit.");
}

const argv = process.argv.slice(2);
const onlyFilters = [];
const skipFilters = [];
let listOnly = false;

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--help" || arg === "-h") {
		printUsage();
		process.exit(0);
	}
	if (arg === "--list") {
		listOnly = true;
		continue;
	}
	if (arg === "--only") {
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			console.error(`Error: --only requires a value (e.g. --only frontmatter-guard)`);
			process.exit(2);
		}
		onlyFilters.push(next);
		i += 1;
		continue;
	}
	if (arg.startsWith("--only=")) {
		const value = arg.slice("--only=".length);
		if (value.length === 0) {
			console.error(`Error: --only requires a non-empty value`);
			process.exit(2);
		}
		onlyFilters.push(value);
		continue;
	}
	if (arg === "--skip") {
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			console.error(`Error: --skip requires a value (e.g. --skip witness-scenario-step)`);
			process.exit(2);
		}
		skipFilters.push(next);
		i += 1;
		continue;
	}
	if (arg.startsWith("--skip=")) {
		const value = arg.slice("--skip=".length);
		if (value.length === 0) {
			console.error(`Error: --skip requires a non-empty value`);
			process.exit(2);
		}
		skipFilters.push(value);
		continue;
	}
	console.error(`Error: unknown argument "${arg}"`);
	console.error("");
	printUsage();
	process.exit(2);
}

const onlySelectedSuites = onlyFilters.length === 0
	? suites
	: suites.filter(([, path]) => onlyFilters.some((needle) => path.includes(needle)));

if (onlyFilters.length > 0 && onlySelectedSuites.length === 0) {
	console.error(`Error: no suite path matched --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
	console.error(`Hint: run with --list to see every known suite path.`);
	process.exit(2);
}

const skippedSuites = skipFilters.length === 0
	? []
	: onlySelectedSuites.filter(([, path]) => skipFilters.some((needle) => path.includes(needle)));

if (skipFilters.length > 0 && skippedSuites.length === 0) {
	console.error(`Error: no suite path matched --skip filter(s): ${skipFilters.map((f) => `"${f}"`).join(", ")}`);
	console.error(`Hint: run with --list to see every known suite path.`);
	process.exit(2);
}

const selectedSuites = skipFilters.length === 0
	? onlySelectedSuites
	: onlySelectedSuites.filter((suite) => !skippedSuites.includes(suite));

if (selectedSuites.length === 0) {
	console.error(`Error: all selected suites were skipped.`);
	process.exit(2);
}

if (listOnly) {
	for (const [, path] of selectedSuites) {
		console.log(path);
	}
	process.exit(0);
}

if (onlyFilters.length > 0) {
	console.log(`Running ${selectedSuites.length} of ${suites.length} suite(s) matching --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
}
if (skipFilters.length > 0) {
	console.log(`Skipping ${skippedSuites.length} suite(s) matching --skip filter(s): ${skipFilters.map((f) => `"${f}"`).join(", ")}`);
}

for (const [runner, suitePath] of selectedSuites) {
	const [cmd, ...cmdArgs] = runner.split(" ");
	const result = spawnSync(cmd, [...cmdArgs, suitePath], {
		stdio: "inherit",
		env: JITI_ENV,
	});

	if (result.status === 0) {
		totalPassed++;
	} else {
		totalFailed++;
		console.error(`\nSUITE FAILED: ${suitePath}\n`);
	}
}

console.log(`\n${"═".repeat(55)}`);
console.log(`Regression suites: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`${"═".repeat(55)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
