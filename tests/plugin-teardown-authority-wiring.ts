import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mainSource = readFileSync("src/main.ts", "utf8");
const teardownStart = mainSource.indexOf("\tprivate async teardownSync(): Promise<void> {");
const teardownEnd = mainSource.indexOf("\n\tprivate resetLocalCache()", teardownStart);

assert.ok(teardownStart >= 0, "teardownSync method exists");
assert.ok(teardownEnd > teardownStart, "teardownSync method boundary is discoverable");

const teardownSource = mainSource.slice(teardownStart, teardownEnd);
const teardownBody = teardownSource.slice(teardownSource.indexOf("{") + 1);
const executableBody = teardownBody
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "")
	.trimStart();

console.log("\n--- Plugin teardown authority wiring ---");

assert.ok(
	executableBody.startsWith("this.reconciliationController.revokeAsyncAuthority();"),
	"teardown synchronously revokes reconciliation authority as its first executable statement",
);

const orderedOperations = [
	"this.reconciliationController.revokeAsyncAuthority();",
	'this.log("teardownSync: tearing down all sync state");',
	"await this.diskMirror.flushAllPendingWrites();",
	"await this.saveDiskIndex();",
	"this.diskMirror?.destroy();",
	"await this.attachmentOrchestrator?.destroy();",
	"this.reconciliationController.reset();",
	"this.connectionController?.stop();",
	"await this.vaultSync?.destroy();",
];

const operationOffsets = orderedOperations.map((operation) => {
	const offset = teardownBody.indexOf(operation);
	assert.ok(offset >= 0, `teardown retains ${operation}`);
	return offset;
});

for (let index = 1; index < operationOffsets.length; index++) {
	assert.ok(
		operationOffsets[index - 1]! < operationOffsets[index]!,
		`${orderedOperations[index - 1]} remains before ${orderedOperations[index]}`,
	);
}

assert.equal(
	teardownBody.split("this.reconciliationController.revokeAsyncAuthority();").length - 1,
	1,
	"teardown revokes reconciliation authority exactly once before reset cleanup",
);
assert.ok(
	operationOffsets[0]! < teardownBody.indexOf("await "),
	"authority revocation occurs before teardown's first asynchronous boundary",
);

console.log("  PASS  teardown revokes stale async work without changing cleanup ordering");
