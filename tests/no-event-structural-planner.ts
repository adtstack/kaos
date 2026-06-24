import { planNoEventStructuralRenames } from "../src/runtime/reconcile/noEventStructuralPlanner";

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

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

console.log("\n--- No-event structural planner: unique file move ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [{ path: "Old/a.md", contentHash: "h1" }],
		extraDiskPaths: [{ path: "New/a.md", contentHash: "h1" }],
	});
	assertEq(plan.renames.length, 1, "one rename planned");
	assertEq(plan.renames[0]?.oldPath, "Old/a.md", "old path captured");
	assertEq(plan.renames[0]?.newPath, "New/a.md", "new path captured");
	assertEq(plan.renames[0]?.reason, "unique-content-hash", "reason is unique-content-hash");
	assertEq(plan.unresolved.length, 0, "no unresolved changes");
}

console.log("\n--- No-event structural planner: folder move with unique hashes ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [
			{ path: "Old/a.md", contentHash: "ha" },
			{ path: "Old/b.md", contentHash: "hb" },
			{ path: "Old/c.md", contentHash: "hc" },
		],
		extraDiskPaths: [
			{ path: "New/c.md", contentHash: "hc" },
			{ path: "New/a.md", contentHash: "ha" },
			{ path: "New/b.md", contentHash: "hb" },
		],
	});
	assertEq(plan.renames.length, 3, "all folder files planned");
	assert(
		plan.renames.some((rename) => rename.oldPath === "Old/a.md" && rename.newPath === "New/a.md"),
		"a.md mapped",
	);
	assert(
		plan.renames.some((rename) => rename.oldPath === "Old/b.md" && rename.newPath === "New/b.md"),
		"b.md mapped",
	);
	assert(
		plan.renames.some((rename) => rename.oldPath === "Old/c.md" && rename.newPath === "New/c.md"),
		"c.md mapped",
	);
	assertEq(plan.unresolved.length, 0, "no unresolved changes");
}

console.log("\n--- No-event structural planner: duplicate content with unique basename ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [
			{ path: "Old/a.md", contentHash: "same" },
			{ path: "Old/b.md", contentHash: "same" },
		],
		extraDiskPaths: [
			{ path: "New/b.md", contentHash: "same" },
			{ path: "New/a.md", contentHash: "same" },
		],
	});
	assertEq(plan.renames.length, 2, "both duplicate-content files mapped by basename");
	assert(
		plan.renames.every((rename) => rename.reason === "unique-basename-with-duplicate-content"),
		"duplicate-content matches use basename reason",
	);
	assertEq(plan.unresolved.length, 0, "no unresolved changes");
}

console.log("\n--- No-event structural planner: ambiguous duplicate content ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [
			{ path: "Old/a.md", contentHash: "same" },
			{ path: "Other/a.md", contentHash: "same" },
		],
		extraDiskPaths: [
			{ path: "New/a.md", contentHash: "same" },
			{ path: "Moved/a.md", contentHash: "same" },
		],
	});
	assertEq(plan.renames.length, 0, "ambiguous duplicate content is not renamed");
	assertEq(plan.unresolved.length, 1, "ambiguous duplicate content is unresolved");
	assertEq(plan.unresolved[0]?.reason, "ambiguous-duplicate-content", "unresolved reason is ambiguity");
}

console.log("\n--- No-event structural planner: count mismatch leaves leftovers unresolved ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [
			{ path: "Old/a.md", contentHash: "same" },
			{ path: "Old/b.md", contentHash: "same" },
		],
		extraDiskPaths: [
			{ path: "New/a.md", contentHash: "same" },
		],
	});
	assertEq(plan.renames.length, 1, "safe basename match still applies");
	assertEq(plan.unresolved.length, 1, "unmatched side is unresolved");
	assertEq(plan.unresolved[0]?.reason, "count-mismatch", "unresolved reason is count mismatch");
	assertEq(plan.unresolved[0]?.oldPaths.length, 1, "one old path remains unresolved");
	assertEq(plan.unresolved[0]?.newPaths.length, 0, "no new path remains unresolved");
}

console.log("\n--- No-event structural planner: same basename with changed content is unresolved ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [
			{ path: "Old/a.md", contentHash: "old-hash" },
		],
		extraDiskPaths: [
			{ path: "New/a.md", contentHash: "new-hash" },
		],
	});
	assertEq(plan.renames.length, 0, "changed-content move is not auto-renamed");
	assertEq(plan.unresolved.length, 1, "changed-content move is unresolved");
	assertEq(plan.unresolved[0]?.reason, "content-diverged-same-basename", "unresolved reason captures content divergence");
	assertEq(plan.unresolved[0]?.oldPaths[0], "Old/a.md", "old path blocked");
	assertEq(plan.unresolved[0]?.newPaths[0], "New/a.md", "new path blocked");
}

console.log(`\nno-event-structural-planner: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
