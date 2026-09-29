/**
 * Pure unit tests for decideSafeReconcileMode. No Obsidian, no Yjs, no disk I/O.
 *
 * The regression these tests pin: provider sync alone must NOT authorize an
 * authoritative pass while the local IndexedDB-backed replica is still
 * hydrating — a server-only CRDT that is behind this device's newest
 * operations would otherwise be projected onto disk as if it were newer
 * (the first-page-open revert).
 */
import {
	decideSafeReconcileMode,
	type SafeReconcileModeInput,
} from "../src/runtime/reconcile/safeReconcileModePolicy";

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

function input(overrides: Partial<SafeReconcileModeInput> = {}): SafeReconcileModeInput {
	return {
		providerSynced: true,
		localReady: true,
		initialized: true,
		schemaVersionKnown: true,
		...overrides,
	};
}

console.log("\n--- Test 1: provider sync without local hydration stays conservative ---");
{
	const result = decideSafeReconcileMode(input({ localReady: false }));
	assert(result === "conservative", "providerSynced + !localReady => conservative");
}

console.log("\n--- Test 2: both replicas ready is authoritative ---");
{
	const result = decideSafeReconcileMode(input());
	assert(result === "authoritative", "providerSynced + localReady => authoritative");
}

console.log("\n--- Test 3: local-only authority still works offline ---");
{
	const offlineInitialized = decideSafeReconcileMode(
		input({ providerSynced: false }),
	);
	assert(offlineInitialized === "authoritative", "!providerSynced + localReady + sentinels => authoritative");

	const offlineUninitialized = decideSafeReconcileMode(
		input({ providerSynced: false, initialized: false }),
	);
	assert(
		offlineUninitialized === "conservative",
		"!providerSynced + localReady + !initialized => conservative",
	);

	const offlineNoSchema = decideSafeReconcileMode(
		input({ providerSynced: false, schemaVersionKnown: false }),
	);
	assert(
		offlineNoSchema === "conservative",
		"!providerSynced + localReady + !schemaVersionKnown => conservative",
	);
}

console.log("\n--- Test 4: local hydration alone never grants authority without sentinels ---");
{
	const hydratedNoSentinels = decideSafeReconcileMode(
		input({ providerSynced: false, initialized: false, schemaVersionKnown: false }),
	);
	assert(
		hydratedNoSentinels === "conservative",
		"localReady but offline and uninitialized => conservative",
	);
}

console.log("\n--- Test 5: idbError-shaped state (never ready) stays conservative ---");
{
	// A device whose IndexedDB never loads stays fail-closed: additive work
	// continues, destructive projection waits for the manual override.
	const neverReady = decideSafeReconcileMode(
		input({ localReady: false, initialized: false, schemaVersionKnown: false }),
	);
	assert(neverReady === "conservative", "nothing ready => conservative");
}

console.log("\n--- Test 6: a latched idbError forces conservative even after hydration ---");
{
	// Runtime IDB errors latch AFTER `synced` may have fired, so
	// idbError + localReady is a reachable state. The policy must still be
	// fail-closed: only the manual override escapes.
	const runtimeErrorAfterSync = decideSafeReconcileMode(
		input({ idbError: true }),
	);
	assert(
		runtimeErrorAfterSync === "conservative",
		"idbError + localReady + providerSynced => conservative",
	);

	const runtimeErrorOffline = decideSafeReconcileMode(
		input({ idbError: true, providerSynced: false }),
	);
	assert(
		runtimeErrorOffline === "conservative",
		"idbError + localReady + sentinels => conservative",
	);

	// Absent/false idbError keeps the hydrated-authoritative behavior.
	const noError = decideSafeReconcileMode(input({ idbError: false }));
	assert(noError === "authoritative", "idbError false => unchanged");
	const omittedError = decideSafeReconcileMode(input());
	assert(omittedError === "authoritative", "idbError omitted => unchanged");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────\n");

if (failed > 0) {
	process.exit(1);
}
