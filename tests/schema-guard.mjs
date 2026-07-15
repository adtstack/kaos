import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const HOST = process.env.KAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.KAOS_TEST_VAULT_ID || "kaos-schema-guard";
const ROOM_ID = `${BASE_VAULT_ID}-schema-guard`;
const CURRENT_SCHEMA_VERSION = 4;
const STALE_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION - 1;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for schema-guard test");
}

function wait(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function buildWsUrl({ includeSchema, schemaVersion }) {
	const url = new URL(`/vault/sync/${encodeURIComponent(ROOM_ID)}`, HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", TOKEN);
	if (includeSchema && schemaVersion !== undefined) {
		url.searchParams.set("schemaVersion", String(schemaVersion));
	}
	return url.toString();
}

async function safeDestroy(provider, ydoc) {
	// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library.
	const ws = provider.ws;
	if (ws && typeof ws.terminate === "function") {
		ws.terminate();
	}

	// Ensure Awareness interval is cleared (using public API).
	if (provider.awareness) {
		provider.awareness.destroy();
	}

	const capturedDuringTeardown = new Set();
	const originalSetTimeout = globalThis.setTimeout;
	const originalGlobalSetTimeout = global.setTimeout;
	const patchedSetTimeout = (fn, delay, ...args) => {
		const handle = originalSetTimeout(fn, delay, ...args);
		if (delay > 0) {
			capturedDuringTeardown.add(handle);
		}
		return handle;
	};
	globalThis.setTimeout = patchedSetTimeout;
	global.setTimeout = patchedSetTimeout;

	provider.destroy();
	if (ydoc) ydoc.destroy();

	// Give a few ticks for any post-close logic (like reconnect timers)
	await new Promise((r) => originalSetTimeout(r, 100));

	globalThis.setTimeout = originalSetTimeout;
	global.setTimeout = originalGlobalSetTimeout;

	for (const h of capturedDuringTeardown) {
		clearTimeout(h);
	}
}

async function seedRoomSchema(schemaVersion) {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(ROOM_ID)}`;

	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: syncPrefix,
		params: {
			token: TOKEN,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise((resolvePromise, rejectPromise) => {
		let done = false;
		const timeout = setTimeout(() => {
			if (done) return;
			done = true;
			rejectPromise(new Error("Timed out while seeding schema version"));
		}, 10_000);

		const finish = (err) => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					finish(new Error(`Seeding rejected by server: ${msg.code}`));
				}
			} catch {
				// Not JSON, ignore.
			}
		});

		provider.on("sync", (synced) => {
			if (!synced) return;
			const sys = ydoc.getMap("sys");
			ydoc.transact(() => {
				sys.set("initialized", true);
				sys.set("schemaVersion", schemaVersion);
			});

			// Give the provider a moment to flush the update.
			void wait(500).then(() => finish());
		});
	});

	await safeDestroy(provider, ydoc);
}

async function expectRejected(label, wsUrl) {
	await new Promise((resolvePromise, rejectPromise) => {
		const ws = new WebSocket(wsUrl);
		let sawExpectedCode = false;
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			rejectPromise(new Error(`${label}: timed out waiting for update_required`));
		}, 5_000);

		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (typeof ws.terminate === "function") ws.terminate();
			else ws.close();
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		ws.on("message", (data) => {
			const text = typeof data === "string" ? data : data.toString();
			try {
				const msg = JSON.parse(text);
				if (msg?.type === "error" && msg?.code === "update_required") {
					sawExpectedCode = true;
				}
			} catch {
				// ignore non-json
			}
		});

		ws.on("close", () => {
			if (!sawExpectedCode) {
				finish(new Error(`${label}: socket closed without update_required error`));
				return;
			}
			finish();
		});

		ws.on("error", (err) => {
			finish(err);
		});
	});
}

async function expectAllowed(schemaVersion) {
	const ydoc = new Y.Doc();
	const syncPrefix = `/vault/sync/${encodeURIComponent(ROOM_ID)}`;
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: syncPrefix,
		params: {
			token: TOKEN,
			schemaVersion: String(schemaVersion),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: true,
	});

	await new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPromise(new Error("Compatible schema client failed to sync in time"));
		}, 10_000);

		const finish = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (err) {
				rejectPromise(err);
				return;
			}
			resolvePromise(undefined);
		};

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					finish(new Error(`Compatible schema client was rejected: ${msg.code}`));
				}
			} catch {
				// Not JSON, ignore.
			}
		});

		provider.on("sync", (synced) => {
			if (synced) finish();
		});
	});

	await safeDestroy(provider, ydoc);
}

async function main() {
	try {
		console.log(`Schema guard integration room: ${ROOM_ID}`);
		await seedRoomSchema(CURRENT_SCHEMA_VERSION);
		console.log(`Seeded room with sys.schemaVersion=${CURRENT_SCHEMA_VERSION}`);

		await expectRejected("stale client schema", buildWsUrl({
			includeSchema: true,
			schemaVersion: STALE_SCHEMA_VERSION,
		}));
		console.log(`Rejected stale schemaVersion=${STALE_SCHEMA_VERSION} client as expected`);

		await expectRejected("missing schema (legacy default)", buildWsUrl({
			includeSchema: false,
		}));
		console.log("Rejected missing schema client (legacy default v1) as expected");

		await expectAllowed(CURRENT_SCHEMA_VERSION);
		console.log(`Accepted compatible schemaVersion=${CURRENT_SCHEMA_VERSION} client`);
		process.exit(0);
	} finally {
		// Teardown handled by safeDestroy inside sub-calls
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
