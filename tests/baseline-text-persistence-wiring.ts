import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mainSource = readFileSync("src/main.ts", "utf8");
const controllerSource = readFileSync("src/runtime/reconciliationController.ts", "utf8");
const dashboardSource = readFileSync("src/dashboard/KaosDashboardView.ts", "utf8");

console.log("\n--- baseline persistence wiring: crash-safe legacy migration order ---");
{
	const start = mainSource.indexOf("private async initializeBaselineTextPersistence()");
	const source = start >= 0 ? mainSource.slice(start, start + 4_500) : "";
	const saveBodies = source.indexOf("await repository.save(verifiedLegacyTexts)");
	const markExternal = source.indexOf("this.baselineTextsExternalized = true");
	const saveMarker = source.indexOf("await this.persistPluginState()");
	assert.ok(start >= 0);
	assert.ok(saveBodies >= 0 && saveBodies < markExternal);
	assert.ok(markExternal < saveMarker);
	assert.match(source, /actualHash === hash/);
	assert.match(source, /wasExternalized && Object\.keys\(legacyTexts\)\.length === 0/);
	console.log("  PASS  verified bodies are durable before data.json drops the legacy payload");
}

console.log("\n--- baseline persistence wiring: write and garbage-collection order ---");
{
	const start = mainSource.indexOf("private async persistPluginState(");
	const source = start >= 0 ? mainSource.slice(start, start + 900) : "";
	const flushBodies = source.indexOf("await this.flushDirtyBaselineTexts()");
	const saveData = source.indexOf("await this.settingsStore.save(this.persistedState)");
	const garbageCollect = source.indexOf("await this.runBaselineTextGc()");
	assert.ok(flushBodies >= 0 && flushBodies < saveData);
	assert.ok(saveData < garbageCollect);
	console.log("  PASS  bodies are written before hash metadata and garbage is removed only after metadata commits");
}

console.log("\n--- baseline persistence wiring: missing/corrupt bodies fail closed ---");
{
	assert.match(mainSource, /await contentBaselineHash\(stored\) !== hash/);
	assert.match(controllerSource, /await this\.deps\.getBaselineText\?\.\(baselineHash\) \?\? null/);
	assert.match(dashboardSource, /await this\.deps\.getBaselineText\?\.\(baseHash\) \?\? null/);
	assert.match(mainSource, /Missing bodies simply disable automatic 3-way merge and preserve a conflict artifact/);
	console.log("  PASS  consumers await verified bodies and retain the no-base conflict path");
}

console.log("\n--- baseline persistence wiring: conflict Base pins schedule metadata persistence ---");
{
	const controllerWiringStart = mainSource.indexOf("recordConflictMergeBase: (artifactPath, baseHash) => {");
	const source = controllerWiringStart >= 0
		? mainSource.slice(controllerWiringStart, controllerWiringStart + 700)
		: "";
	assert.ok(controllerWiringStart >= 0);
	assert.match(source, /this\.conflictMergeBases\[artifactPath\] = baseHash/);
	assert.match(source, /this\.scheduleDiskIndexSave\("conflict-merge-base"\)/);
	console.log("  PASS  verified conflict Base associations are queued for durable metadata storage");
}

console.log("\n--- baseline persistence wiring: disk callback uses two-phase adoption admission ---");
{
	const callbackStart = mainSource.indexOf("this.diskMirror.setDiskWriteCallback((path, contentHash, content) => {");
	const source = callbackStart >= 0 ? mainSource.slice(callbackStart, callbackStart + 4_000) : "";
	const capture = source.indexOf("captureDiskBaselineSettlementAdmission");
	const publishIndex = source.indexOf("this.diskIndex[path]");
	const publishBody = source.indexOf("this.recordBaselineText(contentHash, content)");
	const commit = source.indexOf("commitDiskBaselineSettlementAdmission(admission)");
	const schedule = source.indexOf("this.scheduleDiskIndexSave(\"disk-write-baseline\")");
	assert.ok(callbackStart >= 0);
	assert.ok(capture >= 0 && capture < publishIndex);
	assert.ok(publishIndex < publishBody && publishBody < commit);
	assert.ok(commit < schedule);
	assert.match(source, /if \(!admission\) return false/);
	assert.match(source, /if \(!this\.reconciliationController\.commitDiskBaselineSettlementAdmission\(admission\)\)/);
	console.log("  PASS  stale callbacks fail before publication and exact commits gate persistence");
}
