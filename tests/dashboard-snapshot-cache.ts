import {
	DASHBOARD_SNAPSHOT_CACHE_TTL_MS,
	DashboardSnapshotCache,
} from "../src/snapshots/dashboardSnapshotCache";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("\n--- Test 1: dashboard snapshot cache reuses values within TTL ---");
{
	let now = 1_000_000;
	let calls = 0;
	const cache = new DashboardSnapshotCache({
		ttlMs: 300_000,
		now: () => now,
	});

	const first = await cache.get("snapshot-status", async () => {
		calls++;
		return { value: calls };
	});
	now += 30_000;
	const second = await cache.get("snapshot-status", async () => {
		calls++;
		return { value: calls };
	});
	now += 270_000;
	const third = await cache.get("snapshot-status", async () => {
		calls++;
		return { value: calls };
	});

	assertEqual(first.value, 1, "first call fetches value");
	assertEqual(second.value, 1, "second call within TTL reuses cached value");
	assertEqual(third.value, 2, "call after TTL fetches a new value");
	assertEqual(calls, 2, "fetcher called once per TTL window");
}

console.log("\n--- Test 2: dashboard snapshot cache keeps keys isolated ---");
{
	let calls = 0;
	const cache = new DashboardSnapshotCache({ ttlMs: 300_000 });
	const load = async () => ++calls;

	const status = await cache.get("snapshot-status", load);
	const recent = await cache.get("recent-changes", load);
	const statusAgain = await cache.get("snapshot-status", load);

	assertEqual(status, 1, "first key fetches");
	assertEqual(recent, 2, "second key fetches independently");
	assertEqual(statusAgain, 1, "first key remains cached");
	assertEqual(calls, 2, "only distinct keys fetch within TTL");
}

console.log("\n--- Test 3: dashboard snapshot cache invalidates manually ---");
{
	let calls = 0;
	const cache = new DashboardSnapshotCache({ ttlMs: 300_000 });
	const load = async () => ++calls;

	await cache.get("snapshot-status", load);
	cache.invalidate("snapshot-status");
	const afterInvalidate = await cache.get("snapshot-status", load);

	assertEqual(afterInvalidate, 2, "invalidated key fetches again");
	assertEqual(calls, 2, "invalidate does not reuse stale value");
}

console.log("\n--- Test 4: dashboard snapshot cache does not cache failures ---");
{
	let calls = 0;
	const cache = new DashboardSnapshotCache({ ttlMs: 300_000 });

	try {
		await cache.get("snapshot-status", async () => {
			calls++;
			throw new Error("boom");
		});
		assert(false, "first failure is thrown");
	} catch {
		assert(true, "first failure is thrown");
	}

	const recovered = await cache.get("snapshot-status", async () => {
		calls++;
		return "ok";
	});

	assertEqual(recovered, "ok", "second call retries after failure");
	assertEqual(calls, 2, "failed loader result was not cached");
}

console.log("\n--- Test 5: dashboard snapshot cache default TTL is five minutes ---");
{
	assertEqual(DASHBOARD_SNAPSHOT_CACHE_TTL_MS, 5 * 60 * 1000, "default TTL is 5 minutes");
}

console.log("\n--- Test 6: dashboard snapshot cache does not repopulate after in-flight invalidation ---");
{
	let calls = 0;
	let resolvePending: ((value: string) => void) | null = null;
	const cache = new DashboardSnapshotCache({ ttlMs: 300_000 });
	const pending = cache.get("snapshot-status", async () => {
		calls++;
		return await new Promise<string>((resolve) => {
			resolvePending = resolve;
		});
	});

	await Promise.resolve();
	cache.invalidate("snapshot-status");
	resolvePending?.("stale");
	await pending;

	const afterInvalidate = await cache.get("snapshot-status", async () => {
		calls++;
		return "fresh";
	});

	assertEqual(afterInvalidate, "fresh", "in-flight stale result does not repopulate invalidated key");
	assertEqual(calls, 2, "fetcher reruns after in-flight invalidation");
}

console.log("\n--- Test 7: SnapshotService uses cache for R2-heavy dashboard reads ---");
{
	const source = readFileSync("src/snapshots/snapshotService.ts", "utf8");
	assert(source.includes("DashboardSnapshotCache"), "SnapshotService imports dashboard snapshot cache");
	assert(source.includes("dashboardSnapshotCache.get(\"snapshot-status\""), "snapshot status dashboard read is cached");
	assert(source.includes("dashboardSnapshotCache.get(`recent-changes:"), "recent changes dashboard read is cached");
	assert(source.includes("dashboardSnapshotCache.get(\"recovery-storage-status\""), "recovery storage dashboard read is cached");
	assert(source.includes("dashboardSnapshotCache.invalidate"), "snapshot mutations can invalidate dashboard cache");
}

if (failed > 0) {
	console.error(`\n${failed} dashboard snapshot cache test(s) failed.`);
	process.exit(1);
}

console.log(`\nAll ${passed} dashboard snapshot cache tests passed.`);
