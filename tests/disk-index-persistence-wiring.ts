import { readFileSync } from "node:fs";

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

const mainSource = readFileSync("src/main.ts", "utf8");

console.log("\n--- Test 1: DiskMirror write callback schedules disk-index persistence ---");
{
	const callbackStart = mainSource.indexOf("this.diskMirror.setDiskWriteCallback");
	const callbackSource = callbackStart >= 0 ? mainSource.slice(callbackStart, callbackStart + 900) : "";
	assert(callbackStart >= 0, "disk write callback is registered");
	assert(
		callbackSource.includes('this.scheduleDiskIndexSave("disk-write-baseline")'),
		"disk write callback schedules a debounced disk-index save",
	);
	assert(
		callbackSource.indexOf("this.baselineTexts[contentHash] = content") <
			callbackSource.indexOf('this.scheduleDiskIndexSave("disk-write-baseline")'),
		"baseline text is recorded before persistence is scheduled",
	);
}

console.log("\n--- Test 2: explicit save cancels pending debounced save ---");
{
	const saveStart = mainSource.indexOf("private async saveDiskIndex()");
	const saveSource = saveStart >= 0 ? mainSource.slice(saveStart, saveStart + 500) : "";
	assert(saveStart >= 0, "saveDiskIndex method exists");
	assert(
		saveSource.includes("this.clearScheduledDiskIndexSave();"),
		"saveDiskIndex clears any pending debounced save",
	);
	assert(
		mainSource.includes("const DISK_INDEX_SAVE_DEBOUNCE_MS = 500;"),
		"disk-index save debounce interval is explicitly defined",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
