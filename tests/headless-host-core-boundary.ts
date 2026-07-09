import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
