#!/usr/bin/env node
/**
 * Guard: fail if stale compiled .js or .js.map artifacts exist under src/.
 *
 * When tsc is run against this project it emits .js files alongside .ts files.
 * JITI (used by the test runner) resolves extensionless imports and prefers
 * native .js (ESM) over .ts. The .js files use require("yjs") (CJS) which
 * loads a different Yjs instance than the test's import, causing Yjs
 * double-import and breaking all state-vector/ack comparisons silently.
 *
 * This guard prevents that failure mode from recurring.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BLOCKED_DIRS = ["src/sync", "src/settings", "src/runtime", "src/debug", "src/diagnostics"];
const offenders = [];

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return; // dir doesn't exist, skip
	}
	for (const name of entries) {
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) {
			walk(path);
		} else if (name.endsWith(".js") || name.endsWith(".js.map")) {
			offenders.push(path);
		}
	}
}

for (const dir of BLOCKED_DIRS) walk(dir);

if (offenders.length > 0) {
	console.error("FAIL: stale compiled JS artifacts found under src/.");
	console.error("These cause JITI to load .js before .ts, breaking Yjs deduplication and ack tests.");
	console.error("");
	for (const f of offenders) console.error(`  ${f}`);
	console.error("");
	console.error("Fix: delete them before running tests.");
	console.error("  find src -name '*.js' -o -name '*.js.map' | xargs rm -f");
	process.exit(1);
}

console.log("PASS: no stale compiled JS artifacts under src/");
