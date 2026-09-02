/**
 * Eviction persistence proof — Issue #24 RCA.
 *
 * Creates a file via Device A, waits for DO eviction (~160s),
 * then checks if Device B receives the file from durable storage.
 */
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const HOST = process.env.KAOS_TEST_HOST || "https://kaos-test.example.invalid";
const TOKEN = process.env.SYNC_TOKEN;
const VAULT_ID = process.env.KAOS_TEST_VAULT_ID || `persistence-evict-${Date.now().toString(36)}`;
const PREFIX = `/vault/sync/${encodeURIComponent(VAULT_ID)}`;
const EVICTION_WAIT_MS = 160_000; // 160s — past CF's 70-140s non-hibernateable eviction

if (!TOKEN) { throw new Error("SYNC_TOKEN required"); }

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectAndSync(label) {
	return new Promise((resolve, reject) => {
		const doc = new Y.Doc();
		const timeout = setTimeout(() => {
			prov.destroy(); doc.destroy();
			reject(new Error(`${label} timed out`));
		}, 15_000);
		const prov = new YSyncProvider(HOST, VAULT_ID, doc, {
			prefix: PREFIX,
			params: { token: TOKEN, schemaVersion: "2" },
			WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
			connect: true,
		});
		prov.on("sync", (synced) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolve({ doc, prov, pathToId: doc.getMap("pathToId"), idToText: doc.getMap("idToText"), meta: doc.getMap("meta") });
		});
	});
}

async function main() {
	console.log(`\nEviction Persistence Proof — Issue #24`);
	console.log(`Host: ${HOST}`);
	console.log(`Vault: ${VAULT_ID}`);
	console.log(`Eviction wait: ${EVICTION_WAIT_MS / 1000}s\n`);

	// ── Step 1: Device A creates a file ────────────────────────────────────
	console.log("Step 1: Device A creates eviction-test.md");
	const a = await connectAndSync("Device A");
	console.log(`  Synced. Existing paths: ${a.pathToId.size}`);

	a.doc.transact(() => {
		a.pathToId.set("eviction-test.md", "file-evict-proof");
		const t = new Y.Text();
		t.insert(0, "survives eviction?");
		a.idToText.set("file-evict-proof", t);
		a.meta.set("file-evict-proof", { path: "eviction-test.md", deleted: false });
	}, "disk-sync");
	console.log("  File created in CRDT");

	// Wait for save debounce (2s debounce + margin)
	console.log("  Waiting 8s for save debounce to fire...");
	await wait(8_000);

	// Disconnect Device A
	a.prov.destroy();
	a.doc.destroy();
	console.log("  Device A disconnected\n");

	// ── Step 2: Wait for DO eviction ───────────────────────────────────────
	console.log(`Step 2: Waiting ${EVICTION_WAIT_MS / 1000}s for DO eviction...`);
	const start = Date.now();
	const interval = setInterval(() => {
		const elapsed = Math.round((Date.now() - start) / 1000);
		process.stdout.write(`\r  ${elapsed}s / ${EVICTION_WAIT_MS / 1000}s`);
	}, 5_000);
	await wait(EVICTION_WAIT_MS);
	clearInterval(interval);
	console.log(`\r  Done waiting ${EVICTION_WAIT_MS / 1000}s\n`);

	// ── Step 3: Device B connects ──────────────────────────────────────────
	console.log("Step 3: Device B connects (should trigger cold load from storage)");
	const b = await connectAndSync("Device B");

	const fileId = b.pathToId.get("eviction-test.md");
	const ytext = fileId ? b.idToText.get(fileId) : null;
	const content = ytext?.toString() ?? null;

	console.log(`  Device B synced. Path count: ${b.pathToId.size}`);
	console.log(`  eviction-test.md: ${fileId ? `found (id=${fileId})` : "NOT FOUND"}`);
	console.log(`  content: ${content !== null ? `"${content}"` : "MISSING"}`);

	b.prov.destroy();
	b.doc.destroy();

	// ── Step 4: Check server debug/trace ───────────────────────────────────
	console.log("\nStep 4: Check server trace");
	try {
		const res = await fetch(
			`${HOST}/vault/${encodeURIComponent(VAULT_ID)}/debug/recent`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);
		if (res.ok) {
			const debug = await res.json();
			const loads = (debug?.recent || []).filter((e) => e?.event === "checkpoint-load");
			const saves = (debug?.recent || []).filter((e) => e?.event === "server.save.append_succeeded");
			const fails = (debug?.recent || []).filter((e) => e?.event === "server.save.append_failed");
			const skips = (debug?.recent || []).filter((e) => e?.event?.startsWith("server.save.skipped"));
			const updates = (debug?.recent || []).filter((e) => e?.event === "server.ydoc.update_observed");

			console.log(`  checkpoint-load events: ${loads.length}`);
			if (loads.length > 0) {
				const last = loads[loads.length - 1];
				console.log(`    latest: journalEntryCount=${last.journalEntryCount}, journalBytes=${last.journalBytes}, hasCheckpoint=${last.hasCheckpoint}`);
			}
			console.log(`  save.append_succeeded: ${saves.length}`);
			console.log(`  save.append_failed: ${fails.length}`);
			console.log(`  save.skipped: ${skips.length}`);
			console.log(`  ydoc.update_observed: ${updates.length}`);
			if (debug?.persistence) {
				console.log(`  persistence health: ${JSON.stringify(debug.persistence)}`);
			}
		}
	} catch (e) {
		console.log(`  (debug fetch failed: ${e.message})`);
	}

	// ── Verdict ────────────────────────────────────────────────────────────
	console.log(`\n${"─".repeat(55)}`);
	if (content === "survives eviction?") {
		console.log("VERDICT: PASS — File survived DO eviction. Persistence works.");
		console.log("─".repeat(55));
		process.exit(0);
	} else if (fileId && content !== "survives eviction?") {
		console.log("VERDICT: FAIL — File found but wrong content. Partial persistence.");
		console.log("─".repeat(55));
		process.exit(1);
	} else {
		console.log("VERDICT: FAIL — File missing after DO eviction. Persistence broken.");
		console.log("This confirms the Issue #24 root cause is in the server persistence path.");
		console.log("─".repeat(55));
		process.exit(1);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
