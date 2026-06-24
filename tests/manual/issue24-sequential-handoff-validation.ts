/**
 * Issue #24 Sequential Handoff Validation (manual, hits real deployment)
 *
 * DO NOT run as part of automated regression tests.
 * This script connects to a real Cloudflare Worker / Durable Object deployment.
 *
 * Tests the exact Issue #24 pathology: sequential device handoff via durable persistence.
 *   1. Device A connects, writes N files, disconnects
 *   2. Verify server persistence health + documentSummary via debug endpoint
 *   3. Device B connects alone (no Device A), verifies all files present
 *
 * Required env vars:
 *   KAOS_TEST_HOST   - Deployed server URL (e.g. https://kaos-staging.example.workers.dev)
 *   KAOS_TEST_TOKEN  - Bearer token for the server
 *
 * Optional env vars:
 *   KAOS_TEST_VAULT_ID    - Vault ID (default: auto-generated)
 *   KAOS_TEST_FILE_COUNT  - Number of files to write (default: 100)
 *
 * Example:
 *   KAOS_TEST_HOST=https://my-staging.workers.dev \
 *   KAOS_TEST_TOKEN=my-token \
 *   KAOS_TEST_FILE_COUNT=700 \
 *   node --import jiti/register tests/manual/issue24-sequential-handoff-validation.ts
 *
 * Validated: 700-file sequential handoff across real Cloudflare staging deployment.
 */

import * as Y from "yjs";
// @ts-ignore
import YSyncProvider from "y-partyserver/provider";
// @ts-ignore
import WebSocket from "ws";

const HOST = process.env.KAOS_TEST_HOST;
const TOKEN = process.env.KAOS_TEST_TOKEN;
if (!HOST || !TOKEN) {
	console.error("Required: KAOS_TEST_HOST and KAOS_TEST_TOKEN env vars.");
	process.exit(1);
}
const VAULT_ID = process.env.KAOS_TEST_VAULT_ID || "issue24-handoff-" + Date.now().toString(36);
const FILE_COUNT = parseInt(process.env.KAOS_TEST_FILE_COUNT || "100", 10);

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.log(`  FAIL  ${msg}`);
		failed++;
	}
}

function connectDevice(label: string): Promise<{
	doc: Y.Doc;
	pathToId: Y.Map<string>;
	idToText: Y.Map<Y.Text>;
	meta: Y.Map<unknown>;
	sys: Y.Map<unknown>;
	provider: YSyncProvider;
	createFile: (path: string, content: string) => string;
	readFile: (path: string) => string | null;
	getPathCount: () => number;
	disconnect: () => void;
}> {
	return new Promise((resolve, reject) => {
		const doc = new Y.Doc();
		const pathToId = doc.getMap<string>("pathToId");
		const idToText = doc.getMap<Y.Text>("idToText");
		const meta = doc.getMap<unknown>("meta");
		const sys = doc.getMap<unknown>("sys");

		const provider = new YSyncProvider(HOST, VAULT_ID, doc, {
			prefix: `/vault/sync/${encodeURIComponent(VAULT_ID)}`,
			params: { token: TOKEN, schemaVersion: "8" },
			WebSocketPolyfill: (globalThis as any).WebSocket ?? WebSocket,
			connect: true,
			maxBackoffTime: 2000,
		});

		const timeout = setTimeout(() => reject(new Error(`${label}: sync timeout`)), 15_000);

		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolve({
				doc, pathToId, idToText, meta, sys, provider,
				createFile(path: string, content: string) {
					const fileId = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
					doc.transact(() => {
						pathToId.set(path, fileId);
						const ytext = new Y.Text();
						ytext.insert(0, content);
						idToText.set(fileId, ytext);
						meta.set(fileId, { path, deleted: false, mtime: Date.now() });
					}, "disk-sync");
					return fileId;
				},
				readFile(path: string) {
					const fileId = pathToId.get(path);
					if (!fileId) return null;
					return idToText.get(fileId)?.toString() ?? null;
				},
				getPathCount() {
					return pathToId.size;
				},
				disconnect() {
					provider.destroy();
					doc.destroy();
				},
			});
		});
	});
}

async function fetchDebug(): Promise<any> {
	const res = await fetch(
		`${HOST}/vault/${encodeURIComponent(VAULT_ID)}/debug/recent`,
		{ headers: { Authorization: `Bearer ${TOKEN}` } },
	);
	return res.json();
}

function sleep(ms: number) {
	return new Promise(r => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Issue #24 Deployment Validation ===`);
console.log(`Vault: ${VAULT_ID}`);
console.log(`Files: ${FILE_COUNT}\n`);

// ── Phase 1: Device A writes files ──────────────────────────────────────────

console.log("--- Phase 1: Device A connects and writes files ---");
const deviceA = await connectDevice("Device A");

// Initialize sys
if (!deviceA.sys.get("initialized")) {
	deviceA.doc.transact(() => {
		deviceA.sys.set("initialized", true);
		deviceA.sys.set("schemaVersion", 8);
	});
}

// Create files
for (let i = 0; i < FILE_COUNT; i++) {
	const path = `test-files/file-${String(i).padStart(3, "0")}.md`;
	const content = `# File ${i}\n\nThis is test file number ${i}.\nCreated by Device A for Issue #24 validation.\n${"Lorem ipsum ".repeat(50)}\n`;
	deviceA.createFile(path, content);
}

assert(deviceA.getPathCount() === FILE_COUNT, `Device A has ${FILE_COUNT} paths (got ${deviceA.getPathCount()})`);

// Wait for save to propagate
console.log("  Waiting for server save...");
await sleep(3000);

// Disconnect Device A
deviceA.disconnect();
console.log("  Device A disconnected\n");

// ── Phase 2: Check server persistence ──────────────────────────────────────

console.log("--- Phase 2: Check server persistence health ---");
await sleep(1000);
const debug1 = await fetchDebug();

assert(debug1.documentLoaded === true, "document is loaded");
assert(debug1.persistence.status === "healthy", `persistence status is healthy (got ${debug1.persistence.status})`);
assert(debug1.persistence.pendingPersistence === false, `no pending persistence (got ${debug1.persistence.pendingPersistence})`);
assert(debug1.persistence.successfulSaveCount > 0, `successful saves > 0 (got ${debug1.persistence.successfulSaveCount})`);
assert(debug1.persistence.failedSaveCount === 0, `failed saves === 0 (got ${debug1.persistence.failedSaveCount})`);
assert(debug1.persistence.lastSaveError === null, `no save error (got ${debug1.persistence.lastSaveError})`);

console.log("\n--- Phase 2b: Check document summary ---");
const summary1 = debug1.documentSummary;
assert(summary1.activePathCount === FILE_COUNT, `activePathCount === ${FILE_COUNT} (got ${summary1.activePathCount})`);
assert(summary1.tombstonedPathCount === 0, `tombstonedPathCount === 0 (got ${summary1.tombstonedPathCount})`);
assert(summary1.activePathsWithText === FILE_COUNT, `activePathsWithText === ${FILE_COUNT} (got ${summary1.activePathsWithText})`);
assert(summary1.activePathsMissingFromPathToId === 0, `no paths missing from pathToId (got ${summary1.activePathsMissingFromPathToId})`);
assert(summary1.activePathsMissingText === 0, `no paths missing text (got ${summary1.activePathsMissingText})`);
assert(summary1.pathToIdWithoutActiveMeta === 0, `no pathToId without active meta (got ${summary1.pathToIdWithoutActiveMeta})`);
assert(summary1.schemaVersion === 8, `schemaVersion === 8 (got ${summary1.schemaVersion})`);

console.log(`\n  Server journal: ${debug1.persistence.journalEntryCount} entries, ${debug1.persistence.journalBytes} bytes`);
console.log(`  Document: ${summary1.activePathCount} active, ${summary1.pathToIdCount} pathToId, ${summary1.idToTextCount} idToText\n`);

// ── Phase 3: Device B connects alone — sequential handoff ──────────────────

console.log("--- Phase 3: Device B connects alone (sequential handoff) ---");
const deviceB = await connectDevice("Device B");

assert(deviceB.getPathCount() === FILE_COUNT, `Device B has ${FILE_COUNT} paths (got ${deviceB.getPathCount()})`);

// Spot-check content across the full range
const spotChecks = [0, 50, Math.floor(FILE_COUNT / 2), FILE_COUNT - 1];
for (const i of spotChecks) {
	const path = `test-files/file-${String(i).padStart(3, "0")}.md`;
	const content = deviceB.readFile(path);
	assert(
		content !== null && content.includes(`File ${i}`),
		`Device B has file-${String(i).padStart(3, "0")} with correct content`,
	);
}

deviceB.disconnect();
console.log("  Device B disconnected\n");

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
