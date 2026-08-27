/**
 * Source-level guard for the VaultSyncServer persisted receipt wire.
 *
 * Full y-partyserver/Cloudflare method dispatch is exercised by worker smoke
 * tests. This guard prevents live in-memory state from being acknowledged as
 * durable: baseline echoes use the coordinator's persisted vector and
 * postApply echoes are broadcast only after enqueueSave succeeds.
 */

import { readFileSync } from "node:fs";
import { VaultSyncServer } from "../server/src/server";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

const source = readFileSync("server/src/server.ts", "utf8");
const methodMatch = source.match(/handleMessage\(connection: Connection, message: WSMessage\): void \{([\s\S]*?)\n\t\}/);
const body = methodMatch?.[1] ?? "";
const onSaveStart = source.indexOf("\tasync onSave(): Promise<void> {");
const onConnectStart = source.indexOf("\tasync onConnect(connection: Connection");
const onSaveBody = onSaveStart >= 0 && onConnectStart > onSaveStart
	? source.slice(onSaveStart, onConnectStart)
	: "";
const onConnectEnd = source.indexOf("\n\thandleMessage(", onConnectStart);
const onConnectBody = onConnectStart >= 0 && onConnectEnd > onConnectStart
	? source.slice(onConnectStart, onConnectEnd)
	: "";
const broadcastStart = source.indexOf("\tprivate broadcastPersistedSvEcho(");
const broadcastEnd = source.indexOf("\n\tprivate async ensureDocumentLoaded", broadcastStart);
const broadcastBody = broadcastStart >= 0 && broadcastEnd > broadcastStart
	? source.slice(broadcastStart, broadcastEnd)
	: "";

console.log("\n--- Test 1: message handling never acknowledges volatile state ---");
assert(methodMatch !== null, "server defines handleMessage override");
assert(body.includes("super.handleMessage(connection, message);"), "parent handleMessage is called");
assert(!body.includes("trySendSvEcho"), "handleMessage sends no receipt from live memory");
assert(!body.includes("\"postApply\""), "handleMessage contains no postApply receipt");

console.log("\n--- Test 2: save success is the only postApply receipt boundary ---");
assert(onSaveBody.includes("const result = await coordinator.enqueueSave();"), "onSave awaits durable save result");
assert(onSaveBody.includes("if (result.success)"), "receipt is gated on explicit save success");
assert(onSaveBody.includes("coordinator.getLastPersistedStateVector()"), "receipt reads coordinator persisted vector");
assert(onSaveBody.includes("this.broadcastPersistedSvEcho(persistedStateVector);"), "successful save broadcasts persisted receipt");
assert(
	onSaveBody.indexOf("this.broadcastPersistedSvEcho") > onSaveBody.indexOf("if (result.success)"),
	"broadcast occurs inside the success branch",
);
assert(!onSaveBody.includes("this.document, \"postApply\""), "onSave never encodes volatile document state for receipt");

console.log("\n--- Test 3: baseline and broadcast both use persisted bytes ---");
assert(
	onConnectBody.includes("this.getPersistenceCoordinator().getLastPersistedStateVector()"),
	"connect baseline reads the persisted state vector",
);
assert(
	onConnectBody.includes("trySendSvEchoStateVector(connection, persistedStateVector, \"baseline\")"),
	"connect baseline sends persisted bytes",
);
assert(!onConnectBody.includes("this.document"), "connect baseline never encodes the live document");
assert(broadcastBody.includes("for (const connection of this.getConnections())"), "persisted receipt reaches every connection");
assert(
	broadcastBody.includes("trySendSvEchoStateVector(connection, persistedStateVector, \"postApply\")"),
	"postApply receipt sends the exact persisted vector",
);

console.log("\n--- Test 4: runtime onSave never acknowledges a failed persistence attempt ---");
{
	const broadcasts: Uint8Array[] = [];
	const fakeServer = {
		ensureDocumentLoaded: async () => undefined,
		getPersistenceCoordinator: () => ({
			enqueueSave: async () => ({
				success: false as const,
				method: "append" as const,
				error: "injected durable-storage failure",
			}),
			getLastPersistedStateVector: () => new Uint8Array([1, 2, 3]),
		}),
		broadcastPersistedSvEcho: (stateVector: Uint8Array) => {
			broadcasts.push(stateVector);
		},
		flushRecoveryDirtyMarks: async () => undefined,
		syncRoomMetaFromDocument: async () => undefined,
	};
	const originalConsoleError = console.error;
	console.error = () => undefined;
	try {
		await (VaultSyncServer.prototype as any).onSave.call(fakeServer);
	} finally {
		console.error = originalConsoleError;
	}
	assert(broadcasts.length === 0, "failed durable save sends zero postApply receipts");
}

console.log("\n--- Test 5: runtime onSave broadcasts the coordinator's persisted bytes ---");
{
	const persistedStateVector = new Uint8Array([4, 5, 6]);
	const broadcasts: Uint8Array[] = [];
	const fakeServer = {
		ensureDocumentLoaded: async () => undefined,
		getPersistenceCoordinator: () => ({
			enqueueSave: async () => ({
				success: true as const,
				method: "append" as const,
			}),
			getLastPersistedStateVector: () => persistedStateVector,
		}),
		broadcastPersistedSvEcho: (stateVector: Uint8Array) => {
			broadcasts.push(stateVector);
		},
		flushRecoveryDirtyMarks: async () => undefined,
		syncRoomMetaFromDocument: async () => undefined,
	};
	await (VaultSyncServer.prototype as any).onSave.call(fakeServer);
	assert(broadcasts.length === 1, "successful durable save emits exactly one broadcast call");
	assert(
		broadcasts[0] === persistedStateVector,
		"successful save broadcasts the coordinator-owned persisted vector, not live document state",
	);
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
