import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const mainSource = readFileSync(mainPath, "utf8");

let passed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		throw err;
	}
}

console.log("\n--- Test 1: debounce constant and timer declaration exist ---");
{
	test("PRESERVED_UNRESOLVED_SAVE_DEBOUNCE_MS constant is defined", () => {
		assert(mainSource.includes("const PRESERVED_UNRESOLVED_SAVE_DEBOUNCE_MS = 500;"));
	});

	test("preservedUnresolvedSaveTimer is declared on plugin", () => {
		assert(mainSource.includes("private preservedUnresolvedSaveTimer: ReturnType<typeof setTimeout> | null = null;"));
	});
}

console.log("\n--- Test 2: scheduling and clearing helpers are wired ---");
{
	test("schedulePreservedUnresolvedSave method exists and debounces", () => {
		const start = mainSource.indexOf("schedulePreservedUnresolvedSave(): void");
		assert(start >= 0, "schedulePreservedUnresolvedSave exists");
		const body = mainSource.slice(start, start + 600);
		assert(body.includes("if (this.preservedUnresolvedSaveTimer !== null) return;"), "guards against duplicate timer");
		assert(body.includes("PRESERVED_UNRESOLVED_SAVE_DEBOUNCE_MS"), "uses debounce constant");
		assert(body.includes("this.persistPreservedUnresolvedStateDurably()"), "invokes durable persist on timer fire");
	});

	test("clearScheduledPreservedUnresolvedSave method exists", () => {
		const start = mainSource.indexOf("clearScheduledPreservedUnresolvedSave(): void");
		assert(start >= 0, "clearScheduledPreservedUnresolvedSave exists");
		const body = mainSource.slice(start, start + 300);
		assert(body.includes("clearTimeout(this.preservedUnresolvedSaveTimer)"), "clears timer");
		assert(body.includes("this.preservedUnresolvedSaveTimer = null"), "nulls timer");
	});
}

console.log("\n--- Test 3: persistPreservedUnresolvedState delegates to scheduler ---");
{
	test("persistPreservedUnresolvedState schedules instead of immediate save", () => {
		const start = mainSource.indexOf("private persistPreservedUnresolvedState(): void");
		assert(start >= 0, "persistPreservedUnresolvedState exists");
		const body = mainSource.slice(start, start + 200);
		assert(body.includes("this.schedulePreservedUnresolvedSave()"), "delegates to schedulePreservedUnresolvedSave");
		assert(!body.includes("void this.persistPreservedUnresolvedStateDurably()"), "does not immediately save");
	});
}

console.log("\n--- Test 4: durable save skips data.json rewrite when externalized ---");
{
	test("persistPreservedUnresolvedStateDurably clears scheduled timer", () => {
		const start = mainSource.indexOf("private async persistPreservedUnresolvedStateDurably(): Promise<void>");
		assert(start >= 0, "persistPreservedUnresolvedStateDurably exists");
		const body = mainSource.slice(start, start + 800);
		assert(body.includes("this.clearScheduledPreservedUnresolvedSave()"), "clears pending timer");
		assert(body.includes("this.auxStateExternalized && this.auxStateStore"), "checks externalized aux state");
		assert(
			body.includes("} else {\n\t\t\tawait this.persistPluginState();\n\t\t}"),
			"only calls persistPluginState when NOT externalized",
		);
	});
}

console.log("\n--- Test 5: teardown and room-change clean up pending timer ---");
{
	test("teardownSync clears scheduled timer before final saveDiskIndex", () => {
		const start = mainSource.indexOf("private async teardownSync(): Promise<void>");
		assert(start >= 0, "teardownSync exists");
		const body = mainSource.slice(start, start + 600);
		assert(body.includes("this.clearScheduledPreservedUnresolvedSave()"), "clears timer on teardown");
	});

	test("room reset clears scheduled timer", () => {
		const start = mainSource.indexOf('if (decision.kind === "room-change")');
		assert(start >= 0, "room-change block exists");
		const body = mainSource.slice(start, start + 400);
		assert(body.includes("this.clearScheduledPreservedUnresolvedSave()"), "clears timer on room reset");
	});
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, 0 failed`);
console.log("──────────────────────────────────────────────────");
