import {
	buildBlobConflictArtifactCopyPath,
	buildBlobConflictArtifactPath,
	buildMarkdownConflictArtifactCopyPath,
	buildMarkdownConflictArtifactPath,
	isBaseBlobConflictArtifactPath,
	isBlobConflictArtifactPath,
	isMarkdownConflictArtifactForOriginalPath,
	isMarkdownConflictArtifactPath,
	parseBlobConflictArtifactPath,
	parseConflictArtifactPath,
	parseMarkdownConflictArtifactPath,
} from "../src/paths/conflictArtifactPath";

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

console.log("\n--- Test 1: markdown disk conflict parses source/device/timestamp ---");
{
	const path = "notes/a (KAOS conflict - disk from device-mqqqdqip 2026-06-23T14-20-40Z).md";
	const parsed = parseMarkdownConflictArtifactPath(path);
	assert(parsed !== null, "markdown artifact parsed");
	assert(isMarkdownConflictArtifactPath(path), "markdown artifact predicate true");
	assert(parsed?.kind === "markdown", "kind markdown");
	assert(parsed?.source === "disk", "source disk");
	assert(parsed?.deviceName === "device-mqqqdqip", "device parsed");
	assert(parsed?.timestamp === "2026-06-23T14:20:40Z", "timestamp normalized");
	assert(parsed?.inferredOriginalPath === "notes/a.md", "original path inferred");
	assert(parsed?.copyIndex === null, "copy index absent");
}

console.log("\n--- Test 2: markdown crdt copy suffix parses ---");
{
	const parsed = parseConflictArtifactPath("notes/a (KAOS conflict - crdt from iPad 2026-06-23T14-20-40Z) 2.md");
	assert(parsed?.source === "crdt", "source crdt");
	assert(parsed?.copyIndex === 2, "copy index parsed");
	assert(parsed?.inferredOriginalPath === "notes/a.md", "copy original path inferred");
}

console.log("\n--- Test 3: legacy markdown conflict without side parses ---");
{
	const parsed = parseConflictArtifactPath("notes/a (KAOS conflict from Old Device 2026-05-11T12-00-00Z).md");
	assert(parsed?.kind === "markdown", "legacy kind markdown");
	assert(parsed?.source === null, "legacy source null");
	assert(parsed?.deviceName === "Old Device", "legacy device parsed");
}

console.log("\n--- Test 4: blob remote conflict parses ---");
{
	const path = "assets/img (KAOS remote conflict 2026-06-23T14-20-40Z).png";
	const parsed = parseBlobConflictArtifactPath(path);
	assert(parsed !== null, "blob artifact parsed");
	assert(isBlobConflictArtifactPath(path), "blob artifact predicate true");
	assert(parsed?.kind === "blob", "kind blob");
	assert(parsed?.source === "remote", "source remote");
	assert(parsed?.deviceName === null, "blob has no device in filename");
	assert(parsed?.inferredOriginalPath === "assets/img.png", "blob original path inferred");
}

console.log("\n--- Test 5: blob conflict copy suffix parses ---");
{
	const parsed = parseConflictArtifactPath("assets/img (KAOS remote conflict 2026-06-23T14-20-40Z) 3.png");
	assert(parsed?.kind === "blob", "copy kind blob");
	assert(parsed?.copyIndex === 3, "blob copy index parsed");
	assert(parsed?.inferredOriginalPath === "assets/img.png", "blob copy original path inferred");
}

console.log("\n--- Test 6: long markdown base is marked possibly truncated ---");
{
	const base = "x".repeat(100);
	const parsed = parseConflictArtifactPath(`notes/${base} (KAOS conflict - editor from desktop 2026-06-23T14-20-40Z).md`);
	assert(parsed?.source === "editor", "source editor");
	assert(parsed?.originalPathConfidence === "possibly-truncated", "long base confidence is possibly-truncated");
}

console.log("\n--- Test 7: normal note is not a conflict artifact ---");
{
	assert(parseConflictArtifactPath("notes/a.md") === null, "normal note returns null");
	assert(!isMarkdownConflictArtifactPath("notes/a.md"), "markdown predicate false");
	assert(!isBlobConflictArtifactPath("assets/a.png"), "blob predicate false");
}

console.log("\n--- Test 8: markdown artifact builder preserves controller filename format ---");
{
	const path = buildMarkdownConflictArtifactPath("notes/a.md", {
		date: new Date("2026-06-23T14:20:40.123Z"),
		deviceName: "Desk:/A* B?",
		source: "crdt",
	});
	assert(
		path === "notes/a (KAOS conflict - crdt from Desk--A- B- 2026-06-23T14-20-40Z).md",
		"markdown artifact path is byte-identical",
	);
	assert(
		buildMarkdownConflictArtifactCopyPath(path, 2) ===
			"notes/a (KAOS conflict - crdt from Desk--A- B- 2026-06-23T14-20-40Z) 2.md",
		"markdown copy suffix is inserted before .md",
	);
}

console.log("\n--- Test 9: markdown artifact matcher preserves source-specific dedupe boundary ---");
{
	const candidate = "notes/a (KAOS conflict - disk from desktop 2026-06-23T14-20-40Z) 3.md";
	assert(
		isMarkdownConflictArtifactForOriginalPath(candidate, "notes/a.md", "disk"),
		"source-specific matcher accepts matching copy artifact",
	);
	assert(
		!isMarkdownConflictArtifactForOriginalPath(candidate, "notes/a.md", "crdt"),
		"source-specific matcher rejects another source",
	);
	assert(
		isMarkdownConflictArtifactForOriginalPath(
			"notes/a (KAOS conflict from desktop 2026-06-23T14-20-40Z).md",
			"notes/a.md",
		),
		"legacy source-less matcher remains source-less",
	);
}

console.log("\n--- Test 10: blob artifact builder preserves blobSync filename format ---");
{
	const path = buildBlobConflictArtifactPath(
		"assets/img.png",
		new Date("2026-06-23T14:20:40.123Z"),
	);
	assert(
		path === "assets/img (KAOS remote conflict 2026-06-23T14-20-40Z).png",
		"blob artifact path is byte-identical",
	);
	assert(
		buildBlobConflictArtifactCopyPath(path, 2) ===
			"assets/img (KAOS remote conflict 2026-06-23T14-20-40Z) 2.png",
		"blob copy suffix is inserted before extension",
	);
	assert(isBaseBlobConflictArtifactPath(path), "base blob predicate accepts primary artifact path");
	assert(isBlobConflictArtifactPath(buildBlobConflictArtifactCopyPath(path, 2)), "parser blob predicate accepts copy artifact path");
	assert(
		!isBaseBlobConflictArtifactPath(buildBlobConflictArtifactCopyPath(path, 2)),
		"base blob predicate preserves blobSync copy-suffix boundary",
	);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
