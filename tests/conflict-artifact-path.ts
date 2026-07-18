import {
	buildBlobConflictArtifactCopyPath,
	buildBlobConflictArtifactPath,
	buildBlobLocalBackupArtifactPath,
	buildMarkdownConflictArtifactCopyPath,
	buildMarkdownConflictArtifactPath,
	isBaseBlobConflictArtifactPath,
	isBlobConflictArtifactPath,
	isLocalSafetyArtifactPath,
	isMarkdownConflictArtifactForOriginalPath,
	isMarkdownConflictArtifactPath,
	parseBlobConflictArtifactPath,
	parseConflictArtifactPath,
	parseMarkdownConflictArtifactPath,
} from "../src/paths/conflictArtifactPath";
import { classifySyncPath } from "../src/paths/pathCategory";
import { isBlobSyncable, isMarkdownSyncable } from "../src/types";

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
	assert(
		classifySyncPath({ path, excludePatterns: [], configDir: ".obsidian" }).kind === "excluded",
		"remote blob artifact is excluded by category classification",
	);
}

console.log("\n--- Test 11: local blob backup parses as a local-only artifact ---");
{
	const path = buildBlobLocalBackupArtifactPath(
		"assets/img.png",
		"0123456789abcdef",
		new Date("2026-06-23T14:20:40.123Z"),
	);
	assert(
		path === "assets/img (KAOS local backup 2026-06-23T14-20-40Z 0123456789abcdef).png",
		"local backup path includes timestamp and exact 16-hex operation id",
	);
	const parsed = parseBlobConflictArtifactPath(path);
	assert(parsed?.kind === "blob", "local backup parses as a blob artifact");
	assert(parsed?.source === "local", "local backup source is local");
	assert(parsed?.timestamp === "2026-06-23T14:20:40Z", "local backup timestamp is normalized");
	assert(parsed?.inferredOriginalPath === "assets/img.png", "local backup original path is inferred");
	assert(parsed?.copyIndex === null, "operation id is not exposed as a copy index");
	assert(isBlobConflictArtifactPath(path), "local backup matches the durable blob artifact predicate");
	assert(isBaseBlobConflictArtifactPath(path), "local backup matches the base blob artifact predicate");
	assert(
		!isBlobSyncable(path, [], ".obsidian"),
		"local backup is excluded from attachment synchronization",
	);
	const category = classifySyncPath({ path, excludePatterns: [], configDir: ".obsidian" });
	assert(category.kind === "excluded", "local backup is excluded by category classification");
	assert(
		category.kind === "excluded" && category.reason === "local-safety-artifact",
		"local backup exclusion has the local safety artifact reason",
	);
}

console.log("\n--- Test 12: local backup operation id is strict lowercase 16-hex ---");
{
	let shortRejected = false;
	try {
		buildBlobLocalBackupArtifactPath("assets/img.png", "0123456789abcde");
	} catch {
		shortRejected = true;
	}
	assert(shortRejected, "15-hex operation id is rejected");

	let uppercaseRejected = false;
	try {
		buildBlobLocalBackupArtifactPath("assets/img.png", "0123456789abcdeF");
	} catch {
		uppercaseRejected = true;
	}
	assert(uppercaseRejected, "uppercase operation id is rejected");
	assert(
		parseBlobConflictArtifactPath(
			"assets/img (KAOS local backup 2026-06-23T14-20-40Z 0123456789abcdeF).png",
		) === null,
		"parser rejects a non-canonical uppercase operation id",
	);
}

console.log("\n--- Test 13: local backup builder respects the filename length cap ---");
{
	const path = buildBlobLocalBackupArtifactPath(
		`assets/${"x".repeat(400)}.png`,
		"fedcba9876543210",
		new Date("2026-06-23T14:20:40.123Z"),
	);
	const filename = path.slice(path.lastIndexOf("/") + 1);
	assert(filename.length <= 255, "local backup filename is at most 255 characters");
	assert(path.endsWith(".png"), "local backup preserves the original extension");
	assert(isBlobConflictArtifactPath(path), "capped local backup remains parseable");
	assert(
		parseBlobConflictArtifactPath(path)?.originalPathConfidence === "possibly-truncated",
		"capped local backup reports possibly-truncated original identity",
	);
}

console.log("\n--- Test 14: Base document conflict artifacts preserve .base and remain local-only ---");
{
	const path = buildMarkdownConflictArtifactPath("BACKLOG/BACKLOG.base", {
		date: new Date("2026-07-17T08:00:00.000Z"),
		deviceName: "Phone",
		source: "disk",
	});
	assert(
		path === "BACKLOG/BACKLOG (KAOS conflict - disk from Phone 2026-07-17T08-00-00Z).base",
		"Base conflict builder preserves the .base extension",
	);
	assert(isMarkdownConflictArtifactPath(path), "Base conflict matches the document artifact predicate");
	assert(
		parseMarkdownConflictArtifactPath(path)?.inferredOriginalPath === "BACKLOG/BACKLOG.base",
		"Base conflict parser recovers the original Base path",
	);
	assert(
		buildMarkdownConflictArtifactCopyPath(path, 2).endsWith(") 2.base"),
		"Base conflict copy suffix is inserted before .base",
	);
	assert(!isMarkdownSyncable(path, [], ".obsidian"), "Base conflict is not re-synced as a document");
	assert(
		classifySyncPath({ path, excludePatterns: [], configDir: ".obsidian" }).kind === "excluded",
		"Base conflict category is excluded",
	);
}

console.log("\n--- Test 15: artifact-named directories make their entire subtree local-only ---");
{
	const backupDir =
		"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdef)";
	const documentChild = `${backupDir}/card.md`;
	const nestedBlobChild = `${backupDir}/assets/icon.png`;
	const remoteConflictChild =
		"archive (KAOS remote conflict 2026-07-17T08-00-01Z)/nested/board.base";
	const documentConflictChild =
		"board (KAOS conflict - disk from Phone 2026-07-17T08-00-02Z).base/nested/card.md";

	for (const path of [
		documentChild,
		nestedBlobChild,
		remoteConflictChild,
		documentConflictChild,
	]) {
		assert(isLocalSafetyArtifactPath(path), `artifact subtree is recognized: ${path}`);
		assert(
			classifySyncPath({ path, excludePatterns: [], configDir: ".obsidian" }).kind === "excluded",
			`artifact subtree is excluded by category: ${path}`,
		);
	}

	assert(!isMarkdownSyncable(documentChild, [], ".obsidian"), "document child is not re-synced");
	assert(!isBlobSyncable(nestedBlobChild, [], ".obsidian"), "blob child is not re-synced");
	assert(
		parseConflictArtifactPath(documentChild) === null,
		"a subtree child is not parsed as the artifact that named its directory",
	);
	assert(
		!isBlobConflictArtifactPath(documentChild),
		"the legacy blob artifact predicate remains basename-only",
	);
	assert(
		!isLocalSafetyArtifactPath(
			"BACKLOG (KAOS local backup 2026-07-17T08-00-00Z 0123456789abcdeF)/card.md",
		),
		"near-match directory with a non-canonical operation id is not excluded",
	);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
