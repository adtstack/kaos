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

console.log("\n--- No-event structural planner: unique file move without evidence is unresolved ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [{ path: "Old/a.md", contentHash: "h1" }],
		extraDiskPaths: [{ path: "New/a.md", contentHash: "h1" }],
	});
	assertEq(plan.renames.length, 0, "no rename planned without rename evidence");
	assertEq(plan.unresolved.length, 1, "same hash and basename are unresolved");
	assertEq(plan.unresolved[0]?.reason, "ambiguous-structural-rename", "unresolved reason captures missing evidence");
}

console.log("\n--- No-event structural planner: explicit rename evidence is allowed ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [{ path: "Old/a.md", contentHash: "h1" }],
		extraDiskPaths: [{ path: "New/a.md", contentHash: "h1" }],
		renameEvidence: [{ oldPath: "Old/a.md", newPath: "New/a.md", reason: "explicit-rename" }],
	});
	assertEq(plan.renames.length, 1, "one evidence-backed rename planned");
	assertEq(plan.renames[0]?.oldPath, "Old/a.md", "old path captured");
	assertEq(plan.renames[0]?.newPath, "New/a.md", "new path captured");
	assertEq(plan.renames[0]?.reason, "explicit-rename", "reason records evidence");
	assertEq(plan.unresolved.length, 0, "no unresolved changes with explicit evidence");
}

console.log("\n--- No-event structural planner: same content with different basename is not inferred as rename ---");
{
	const plan = planNoEventStructuralRenames({
		missingCrdtPaths: [{ path: "Journal/2026-06-25.md", contentHash: "same-template" }],
		extraDiskPaths: [{ path: "Journal/2026-06-26.md", contentHash: "same-template" }],
	});
	assertEq(plan.renames.length, 0, "different basenames are not auto-renamed");
	assertEq(plan.unresolved.length, 0, "different basenames are not surfaced as structural conflicts");
}

console.log("\n--- No-event structural planner: folder move without evidence is unresolved ---");
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
	assertEq(plan.renames.length, 0, "folder move is not inferred from hashes alone");
	assertEq(plan.unresolved.length, 3, "each same-hash move is unresolved without evidence");
}

console.log("\n--- No-event structural planner: duplicate content with unique basename is unresolved ---");
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
	assertEq(plan.renames.length, 0, "duplicate-content files are not mapped by basename");
	assertEq(plan.unresolved.length, 1, "duplicate-content candidates are unresolved");
	assertEq(plan.unresolved[0]?.reason, "ambiguous-duplicate-content", "unresolved reason is duplicate ambiguity");
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
	assertEq(plan.renames.length, 0, "basename match does not apply without evidence");
	assertEq(plan.unresolved.length, 1, "unmatched side is unresolved");
	assertEq(plan.unresolved[0]?.reason, "count-mismatch", "unresolved reason is count mismatch");
	assertEq(plan.unresolved[0]?.oldPaths.length, 2, "both old paths remain unresolved");
	assertEq(plan.unresolved[0]?.newPaths.length, 1, "new path remains unresolved");
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
