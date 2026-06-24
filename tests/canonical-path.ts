/**
 * Tests for canonical path identity.
 *
 * Proves: NFC/NFD equivalence, separator normalization, leading ./ stripping,
 * displayPath preservation, and canonicalKey determinism.
 */

import { canonicalizeVaultPath } from "../src/paths/canonicalPath";

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

console.log("\n--- Test 1: NFC path keeps same canonicalKey ---");
{
	const nfc = "notes/\u00C0.md"; // À (precomposed NFC)
	const result = canonicalizeVaultPath(nfc);
	assert(result.canonicalKey === nfc, "NFC input: canonicalKey matches input");
	assert(result.normalizedPath === nfc, "NFC input: normalizedPath matches input");
	assert(result.displayPath === nfc, "NFC input: displayPath preserves original");
}

console.log("\n--- Test 2: NFD-equivalent path maps to same canonicalKey ---");
{
	const nfc = "notes/\u00C0.md"; // À (precomposed)
	const nfd = "notes/A\u0300.md"; // A + combining grave (decomposed)
	const nfcResult = canonicalizeVaultPath(nfc);
	const nfdResult = canonicalizeVaultPath(nfd);
	assert(nfcResult.canonicalKey === nfdResult.canonicalKey, "NFC and NFD produce same canonicalKey");
	assert(nfdResult.displayPath === nfd, "NFD displayPath preserves original NFD input");
	assert(nfdResult.normalizedPath === nfc, "NFD normalizedPath is NFC form");
}

console.log("\n--- Test 3: backslashes normalize to forward slash ---");
{
	const result = canonicalizeVaultPath("notes\\sub\\file.md");
	assert(result.canonicalKey === "notes/sub/file.md", "backslashes become forward slashes");
	assert(result.displayPath === "notes\\sub\\file.md", "displayPath preserves backslashes");
}

console.log("\n--- Test 4: leading ./ is stripped ---");
{
	const result = canonicalizeVaultPath("./notes/file.md");
	assert(result.canonicalKey === "notes/file.md", "leading ./ stripped");
	assert(result.displayPath === "./notes/file.md", "displayPath preserves leading ./");

	const repeated = canonicalizeVaultPath("././notes/file.md");
	assert(repeated.canonicalKey === "notes/file.md", "repeated ././ stripped");
}

console.log("\n--- Test 5: leading / is stripped ---");
{
	const result = canonicalizeVaultPath("/notes/file.md");
	assert(result.canonicalKey === "notes/file.md", "leading / stripped");
}

console.log("\n--- Test 6: multiple slashes collapsed ---");
{
	const result = canonicalizeVaultPath("notes///sub//file.md");
	assert(result.canonicalKey === "notes/sub/file.md", "multiple slashes collapsed");
}

console.log("\n--- Test 7: plain path is unchanged ---");
{
	const result = canonicalizeVaultPath("notes/daily/2024-01-01.md");
	assert(result.canonicalKey === "notes/daily/2024-01-01.md", "clean path unchanged");
	assert(result.normalizedPath === "notes/daily/2024-01-01.md", "normalizedPath same");
	assert(result.displayPath === "notes/daily/2024-01-01.md", "displayPath same");
}

console.log("\n--- Test 8: two different NFC/NFD paths same canonical key ---");
{
	// e + combining acute = NFC é
	const nfd = "caf\u0065\u0301/menu.md";
	const nfc = "caf\u00E9/menu.md";
	assert(
		canonicalizeVaultPath(nfd).canonicalKey === canonicalizeVaultPath(nfc).canonicalKey,
		"café NFC/NFD equivalence",
	);
}

console.log("\n--- Test 9: case-only difference produces DIFFERENT keys ---");
{
	const lower = canonicalizeVaultPath("notes/File.md");
	const upper = canonicalizeVaultPath("notes/file.md");
	assert(lower.canonicalKey !== upper.canonicalKey, "case difference: distinct keys (no case folding)");
}

console.log("\n--- Test 10: empty string ---");
{
	const result = canonicalizeVaultPath("");
	assert(result.canonicalKey === "", "empty string produces empty key");
	assert(result.displayPath === "", "empty string displayPath is empty");
}

console.log("\n--- Test 11: rename NFC → NFD-equivalent does not produce two identities ---");
{
	const before = canonicalizeVaultPath("notes/\u00C0.md");
	const after = canonicalizeVaultPath("notes/A\u0300.md");
	assert(before.canonicalKey === after.canonicalKey, "rename between NFC/NFD forms: same identity");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
