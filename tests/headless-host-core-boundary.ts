import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EditorState } from "../src/headless-host/codeMirrorStateShim";
import {
	historyField,
	isolateHistory,
	redoDepth,
	undoDepth,
} from "../src/headless-host/codeMirrorCommandsShim";

const CORE_DIR = "src/headless-host/core";
const forbiddenImportPatterns = [
	/\.\.\/kaos/,
	/\.\.\/\.\.\/main/,
	/\.\.\/\.\.\/runtime/,
	/\.\.\/\.\.\/settings/,
	/\.\.\/\.\.\/sync/,
	/\.\.\/\.\.\/snapshots/,
	/\.\.\/\.\.\/dashboard/,
	/\.\.\/\.\.\/telemetry/,
];

let checked = 0;

async function walk(dir: string): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(path);
			continue;
		}
		if (!entry.isFile() || !path.endsWith(".ts")) continue;
		checked++;
		const source = await readFile(path, "utf8");
		for (const pattern of forbiddenImportPatterns) {
			assert.ok(!pattern.test(source), `${path} imports KAOS/plugin-specific code via ${pattern}`);
		}
	}
}

console.log("\n--- headless host core boundary: core stays reusable ---");
await walk(CORE_DIR);
assert.ok(checked > 0, "expected at least one core file to be checked");
console.log(`  PASS  checked ${checked} core file(s)`);

console.log("\n--- headless host CodeMirror shim: editor safety extensions are available ---");
assert.equal(typeof EditorState.transactionFilter.of, "function");
assert.equal(typeof EditorState.transactionExtender.of, "function");
console.log("  PASS  transaction filters and extenders can be installed during plugin boot");

console.log("\n--- headless host CodeMirror commands shim: replay imports are boot-safe ---");
assert.equal(typeof historyField, "symbol");
assert.equal(typeof isolateHistory.of, "function");
assert.equal(undoDepth({}), 0);
assert.equal(redoDepth({}), 0);
console.log("  PASS  replay command imports stay inert without a live editor history");
