import { getServerByName } from "partyserver";
import * as Y from "yjs";
import type { Env } from "./types";

const LOG_PREFIX = "[kaos-sync:worker]";

/**
 * Fetch a cheap room endpoint without PartyServer's getServerByName().
 *
 * getServerByName() first sends a separate /set-name/ request. PartyServer
 * initializes YServer before answering that request, so a cold read-only probe
 * can hydrate the entire CRDT document. Cheap endpoints only need a stable DO
 * id and a room-id hint for their response payload.
 */
function fetchVaultRoomCheap(
	env: Env,
	vaultId: string,
	pathname: string,
	init?: RequestInit,
): Promise<Response> {
	const id = env.KAOS_SYNC.idFromName(vaultId);
	const stub = env.KAOS_SYNC.get(id);
	const headers = new Headers(init?.headers);
	headers.set("x-partykit-room", vaultId);
	return stub.fetch(new Request(`https://internal${pathname}`, {
		...init,
		headers,
	}));
}

export async function recordVaultTrace(
	env: Env,
	vaultId: string,
	event: string,
	data: Record<string, unknown> = {},
): Promise<void> {
	try {
		await fetchVaultRoomCheap(env, vaultId, "/__kaos/trace", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ event, data }),
		});
	} catch (err) {
		console.warn(`${LOG_PREFIX} trace write failed:`, err);
	}
}

export async function fetchVaultDocument(env: Env, vaultId: string): Promise<Uint8Array> {
	const stub = await getServerByName(env.KAOS_SYNC, vaultId);
	const res = await stub.fetch("https://internal/__kaos/document");
	if (!res.ok) {
		throw new Error(`document fetch failed (${res.status})`);
	}
	return new Uint8Array(await res.arrayBuffer());
}

async function fetchVaultRoomMeta(env: Env, vaultId: string): Promise<{
	schemaVersion: number | null;
} | null> {
	const res = await fetchVaultRoomCheap(env, vaultId, "/__kaos/meta");
	if (!res.ok) {
		throw new Error(`room meta fetch failed (${res.status})`);
	}
	const payload: {
		meta?: { schemaVersion?: unknown } | null;
	} = await res.json();
	const schemaVersion = payload?.meta?.schemaVersion;
	if (schemaVersion === null) {
		return { schemaVersion: null };
	}
	if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 0) {
		return { schemaVersion };
	}
	return null;
}

export async function fetchVaultSchemaVersion(env: Env, vaultId: string): Promise<number | null> {
	try {
		const meta = await fetchVaultRoomMeta(env, vaultId);
		if (meta) {
			return meta.schemaVersion;
		}
		const update = await fetchVaultDocument(env, vaultId);
		const doc = new Y.Doc();
		try {
			Y.applyUpdate(doc, update);
			const stored = doc.getMap("sys").get("schemaVersion");
			if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
				return stored;
			}
			return null;
		} finally {
			doc.destroy();
		}
	} catch (err) {
		console.warn(`${LOG_PREFIX} schema probe failed:`, err);
		return null;
	}
}

export async function fetchVaultDebug(env: Env, vaultId: string): Promise<Response> {
	return await fetchVaultRoomCheap(env, vaultId, "/__kaos/debug");
}

/**
 * Public audit endpoint: forwards an authenticated POST body to the room's
 * durable trace/audit store (the DO persists it beyond the bounded debug
 * ring). The plugin posts discarded-revision records here — path identity is
 * already hashed client-side, so no raw vault path crosses this route.
 */
export async function handleVaultTraceRoute(
	env: Env,
	vaultId: string,
	req: Request,
	json: (body: unknown, status?: number) => Response,
): Promise<Response> {
	let body: { event?: unknown; data?: unknown } = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	if (typeof body.event !== "string" || body.event.length === 0) {
		return json({ error: "missing event" }, 400);
	}
	const data =
		typeof body.data === "object" && body.data !== null
			? (body.data as Record<string, unknown>)
			: {};
	try {
		const res = await fetchVaultRoomCheap(env, vaultId, "/__kaos/trace", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ event: body.event, data }),
		});
		return json({ ok: res.ok });
	} catch (err) {
		console.warn(`${LOG_PREFIX} vault trace write failed:`, err);
		return json({ ok: false }, 500);
	}
}
