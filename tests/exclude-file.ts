import assert from "node:assert/strict";
import {
	KAOS_EXCLUDE_FILE_PATH,
	isExcluded,
	mergeExcludePatterns,
	parseExcludePatterns,
	parseKaosExcludeFile,
} from "../src/sync/exclude";
import {
	KAOS_EXCLUDE_FILE_MAX_CHARS,
	readKaosExcludeFile,
} from "../src/runtime/excludeFile";
import { isBlobSyncable, isMarkdownSyncable } from "../src/types";

const parsed = parseKaosExcludeFile(
	"\uFEFF# Shared KAOS exclusions\r\n"
	+ " SYSTEM/SETTING/snapshot.json \r\n"
	+ "\r\n"
	+ "JOURNALS/PRIVATE/\r\n"
	+ "./JOURNALS/PRIVATE/\r\n",
);
assert.deepEqual(parsed, [
	"SYSTEM/SETTING/snapshot.json",
	"JOURNALS/PRIVATE/",
], "line parser accepts comments, BOM/CRLF, trims, normalizes, and deduplicates");

assert.deepEqual(
	parseExcludePatterns(" templates/, ./daily/, templates/ "),
	["templates/", "daily/"],
	"legacy comma-separated settings remain normalized and supported",
);

assert.deepEqual(
	mergeExcludePatterns(["legacy/", "shared/"], ["shared/", "new/"]),
	["legacy/", "shared/", "new/"],
	"legacy and shared patterns merge in stable order",
);

assert.equal(
	isExcluded("SYSTEM/SETTING/snapshot.json", parsed, ".obsidian"),
	true,
	"listed snapshot file is excluded",
);
assert.equal(
	isExcluded(KAOS_EXCLUDE_FILE_PATH, ["SYSTEM/", KAOS_EXCLUDE_FILE_PATH], ".obsidian"),
	false,
	"the shared control file remains syncable even under a broader excluded prefix",
);
assert.equal(
	isMarkdownSyncable(KAOS_EXCLUDE_FILE_PATH, ["SYSTEM/"], ".obsidian"),
	true,
	"the control file uses the core CRDT document lane without requiring R2",
);
assert.equal(
	isBlobSyncable(KAOS_EXCLUDE_FILE_PATH, ["SYSTEM/"], ".obsidian"),
	false,
	"the control file never depends on attachment sync",
);

let readCount = 0;
const presentSnapshot = await readKaosExcludeFile({
	exists: async (path) => {
		assert.equal(path, KAOS_EXCLUDE_FILE_PATH);
		return true;
	},
	read: async (path) => {
		assert.equal(path, KAOS_EXCLUDE_FILE_PATH);
		readCount++;
		return "# comment\nSYSTEM/SETTING/snapshot.json\n";
	},
});
assert.equal(readCount, 1);
assert.equal(presentSnapshot.present, true);
assert.deepEqual(presentSnapshot.patterns, ["SYSTEM/SETTING/snapshot.json"]);

const absentSnapshot = await readKaosExcludeFile({
	exists: async () => false,
	read: async () => {
		throw new Error("read must not run for an absent file");
	},
});
assert.deepEqual(absentSnapshot, { present: false, raw: null, patterns: [] });

await assert.rejects(
	readKaosExcludeFile({
		exists: async () => true,
		read: async () => "x".repeat(KAOS_EXCLUDE_FILE_MAX_CHARS + 1),
	}),
	/safety limit/,
	"oversized policy files fail closed by retaining the previous runtime policy",
);

console.log("exclude file tests passed");
