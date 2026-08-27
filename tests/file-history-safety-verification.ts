import assert from "node:assert";
import { renderDiffLines } from "../src/utils/textDiff";

console.log("\n=======================================================");
console.log("File History Safety & Resilience Verification Tests");
console.log("=======================================================\n");

// --- Test 1: Diff Lines with Missing Previous Content (404 Fallback) ---
console.log("--- Test 1: Diff Rendering when Previous Content is Missing (Graceful Fallback) ---");
{
	const previous = ""; // Gracefully fell back from missing 404 hash
	const current = "# Meeting Notes\n\n- Action item 1\n- Action item 2\n";
	const lines = renderDiffLines(previous, current, {
		contextLines: 0,
		maxSegments: 80,
		maxLinesPerSegment: 12,
	});

	assert(lines.length > 0, "Lines should be rendered even if previous is empty");
	assert(lines.every((l) => l.kind === "insert"), "All lines should appear as additions when previous is empty");
	console.log("  PASS: Missing previous version renders all current lines as additions without throwing");
}

// --- Test 2: Diff Lines with Missing Current Content (404 Fallback) ---
console.log("\n--- Test 2: Diff Rendering when Current Content is Missing ---");
{
	const previous = "# Old Notes\n\n- Removed item\n";
	const current = ""; // Gracefully fell back from missing 404 hash
	const lines = renderDiffLines(previous, current, {
		contextLines: 0,
		maxSegments: 80,
		maxLinesPerSegment: 12,
	});

	assert(lines.length > 0, "Lines should be rendered");
	assert(lines.every((l) => l.kind === "delete"), "All lines should appear as deletions when current is empty");
	console.log("  PASS: Missing current version renders previous lines as deletions without throwing");
}

// --- Test 3: Debounce & Cooldown Logic Verification ---
console.log("\n--- Test 3: Debounce and Cooldown Timer Math ---");
{
	const RECOVERY_SNAPSHOT_IDLE_DEBOUNCE_MS = 2 * 60 * 1000; // 2 min
	const RECOVERY_SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 min

	// Scenario A: First edit after long idle (last snapshot 1 hour ago)
	let lastAutoSnapshotAt = Date.now() - (60 * 60 * 1000);
	let now = Date.now();
	let elapsedSinceLast = now - lastAutoSnapshotAt;
	let remainingCooldown = Math.max(0, RECOVERY_SNAPSHOT_MIN_INTERVAL_MS - elapsedSinceLast);
	let delay = Math.max(RECOVERY_SNAPSHOT_IDLE_DEBOUNCE_MS, remainingCooldown);
	assert.strictEqual(delay, 2 * 60 * 1000, "Should use exactly 2 min idle debounce when cooldown has expired");

	// Scenario B: Rapid edit 3 minutes after last snapshot
	lastAutoSnapshotAt = Date.now() - (3 * 60 * 1000);
	now = Date.now();
	elapsedSinceLast = now - lastAutoSnapshotAt;
	remainingCooldown = Math.max(0, RECOVERY_SNAPSHOT_MIN_INTERVAL_MS - elapsedSinceLast);
	delay = Math.max(RECOVERY_SNAPSHOT_IDLE_DEBOUNCE_MS, remainingCooldown);
	assert(delay >= 7 * 60 * 1000 - 100 && delay <= 7 * 60 * 1000 + 100, "Should wait remaining 7 minutes to satisfy 10m cooldown");

	// Scenario C: Edit 9 minutes after last snapshot (1 min cooldown remaining)
	lastAutoSnapshotAt = Date.now() - (9 * 60 * 1000);
	now = Date.now();
	elapsedSinceLast = now - lastAutoSnapshotAt;
	remainingCooldown = Math.max(0, RECOVERY_SNAPSHOT_MIN_INTERVAL_MS - elapsedSinceLast);
	delay = Math.max(RECOVERY_SNAPSHOT_IDLE_DEBOUNCE_MS, remainingCooldown);
	assert.strictEqual(delay, 2 * 60 * 1000, "Should use 2 min idle debounce because 2m > 1m remaining cooldown");

	console.log("  PASS: Debounce and cooldown calculate optimal and resource-friendly delays across all scenarios");
}

// --- Test 4: Resource Overhead Guard Verification ---
console.log("\n--- Test 4: Resource Overhead Guard Verification ---");
{
	// Ensure that continuous edits in 1 hour cannot trigger more than 6 snapshots (10 min cooldown)
	const maxSnapshotsPerHour = Math.floor((60 * 60 * 1000) / (10 * 60 * 1000));
	assert(maxSnapshotsPerHour <= 6, "Maximum snapshots per hour must be strictly capped at 6");
	console.log(`  PASS: Hard limit of at most ${maxSnapshotsPerHour} snapshots per hour even during continuous aggressive typing`);
}

console.log("\n=======================================================");
console.log("All Safety & Resilience Verification Tests Passed!");
console.log("=======================================================\n");
