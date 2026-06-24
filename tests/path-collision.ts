/**
 * Tests for path collision detection.
 */

import { findCanonicalPathCollisions } from "../src/paths/pathCollision";

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

console.log("\n--- Test 1: NFC and NFD-equivalent display paths produce collision ---");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const collisions = findCanonicalPathCollisions([nfc, nfd]);
	assert(collisions.length === 1, "one collision found");
	assert(collisions[0]!.displayPaths.length === 2, "collision has 2 display paths");
	assert(collisions[0]!.displayPaths.includes(nfc), "collision includes NFC path");
	assert(collisions[0]!.displayPaths.includes(nfd), "collision includes NFD path");
	assert(collisions[0]!.kind === "canonical-equivalence", "collision kind is canonical-equivalence");
}

console.log("\n--- Test 2: exact duplicate paths do not produce false collision ---");
{
	const collisions = findCanonicalPathCollisions(["notes/a.md", "notes/a.md"]);
	assert(collisions.length === 0, "exact duplicates: no collision (same display path)");
}

console.log("\n--- Test 3: different paths do not collide ---");
{
	const collisions = findCanonicalPathCollisions(["notes/a.md", "notes/b.md", "other/c.md"]);
	assert(collisions.length === 0, "different paths: no collisions");
}

console.log("\n--- Test 4: case-only variants do NOT collide (no case folding) ---");
{
	const collisions = findCanonicalPathCollisions(["notes/File.md", "notes/file.md"]);
	assert(collisions.length === 0, "case-only variants: no collision (case folding deferred)");
}

console.log("\n--- Test 5: separator variants collide ---");
{
	const collisions = findCanonicalPathCollisions(["notes\\file.md", "notes/file.md"]);
	assert(collisions.length === 1, "backslash vs forward slash: collision");
	assert(collisions[0]!.displayPaths.length === 2, "both paths in collision");
}

console.log("\n--- Test 6: leading ./ variant collides with clean path ---");
{
	const collisions = findCanonicalPathCollisions(["./notes/file.md", "notes/file.md"]);
	assert(collisions.length === 1, "leading ./ collides with clean path");
}

console.log("\n--- Test 7: multiple collisions detected independently ---");
{
	const nfc1 = "a/\u00C0.md";
	const nfd1 = "a/A\u0300.md";
	const nfc2 = "b/\u00E9.md";
	const nfd2 = "b/e\u0301.md";
	const safe = "c/normal.md";
	const collisions = findCanonicalPathCollisions([nfc1, nfd1, nfc2, nfd2, safe]);
	assert(collisions.length === 2, "two independent collisions found");
}

console.log("\n--- Test 8: empty input produces no collisions ---");
{
	assert(findCanonicalPathCollisions([]).length === 0, "empty input: no collisions");
}

console.log("\n--- Test 9: single path produces no collisions ---");
{
	assert(findCanonicalPathCollisions(["notes/a.md"]).length === 0, "single path: no collision");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
