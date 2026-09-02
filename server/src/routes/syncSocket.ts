import { getServerByName } from "partyserver";
import { json, withCors } from "./http";
import { fetchVaultSchemaVersion } from "./trace";
import { consumeSocketTicket } from "./deviceAuth";
import { getSocketTicketFromProtocol } from "./socketTicketProtocol";
import type { Env, FatalAuthCode } from "./types";
import { SERVER_MAX_SCHEMA_VERSION, SERVER_MIN_SCHEMA_VERSION } from "../version";
import { parseSyncClientKind } from "../clientKind";

export function parseSyncPath(pathname: string): { vaultId: string } | null {
	const directMatch = pathname.match(/^\/vault\/sync\/([^/]+)$/);
	if (!directMatch?.[1]) return null;
	return { vaultId: decodeURIComponent(directMatch[1]) };
}

function parseClientSchemaVersion(url: URL): { version: number; source: "query" | "default" } | null {
	const raw = url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema");
	if (raw === null || raw.trim() === "") return { version: SERVER_MIN_SCHEMA_VERSION, source: "default" };
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? { version: parsed, source: "query" } : null;
}

export { parseSyncClientKind };

function isWebSocketRequest(req: Request): boolean {
	return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function rejectSocket(req: Request, code: FatalAuthCode, details: Record<string, unknown> = {}): Response {
	if (!isWebSocketRequest(req)) {
		return json({ error: code, ...details }, code === "unauthorized" ? 401 : code === "update_required" ? 426 : 503);
	}
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();
	const payload = JSON.stringify({ type: "error", code, ...details });
	server.send(payload);
	server.send(`__YPS:${payload}`);
	server.close(1008, code === "unauthorized" ? "unauthorized" : code === "update_required" ? "update required" : "server unavailable");
	return new Response(null, { status: 101, webSocket: client });
}

function returnSocketResponse(req: Request, response: Response): Response {
	return isWebSocketRequest(req) ? response : withCors(response);
}

/**
 * Tickets are carried in Sec-WebSocket-Protocol, never in a request URL. The
 * provider keeps an internal placeholder query field until the WebSocket
 * constructor strips it and installs this subprotocol value.
 */
export { getSocketTicketFromProtocol } from "./socketTicketProtocol";

function logSocketRejection(vaultId: string, reason: string): void {
	console.warn(`[kaos-sync:worker] ws rejected pre-auth: ${JSON.stringify({ vaultIdHint: vaultId.slice(0, 8), reason })}`);
}

export async function handleSyncSocketRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const url = new URL(req.url);
	const ticket = getSocketTicketFromProtocol(req);
	if (!ticket) {
		logSocketRejection(vaultId, "ticket_required");
		return returnSocketResponse(req, rejectSocket(req, "unauthorized"));
	}
	const principal = await consumeSocketTicket(env, vaultId, ticket);
	if (!principal) {
		logSocketRejection(vaultId, "unauthorized");
		return returnSocketResponse(req, rejectSocket(req, "unauthorized"));
	}

	const clientSchema = parseClientSchemaVersion(url);
	const clientKind = parseSyncClientKind(url);
	if (!clientSchema) {
		return returnSocketResponse(req, rejectSocket(req, "update_required", { reason: "invalid_client_schema", clientSchemaVersion: null, roomSchemaVersion: null }));
	}
	if (clientSchema.version < SERVER_MIN_SCHEMA_VERSION || clientSchema.version > SERVER_MAX_SCHEMA_VERSION) {
		const reason = clientSchema.version < SERVER_MIN_SCHEMA_VERSION ? "client_schema_older_than_server" : "client_schema_newer_than_server";
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason, clientSchemaVersion: clientSchema.version, roomSchemaVersion: null,
			serverMinSchemaVersion: SERVER_MIN_SCHEMA_VERSION, serverMaxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
		}));
	}

	const roomSchemaVersion = await fetchVaultSchemaVersion(env, vaultId);
	if (roomSchemaVersion !== null && clientSchema.version < roomSchemaVersion) {
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "client_schema_older_than_room", clientSchemaVersion: clientSchema.version, roomSchemaVersion,
		}));
	}

	console.debug(`[kaos-sync:worker] ws connected: ${JSON.stringify({ vaultIdHint: vaultId.slice(0, 8), clientSchemaVersion: clientSchema.version, clientSchemaSource: clientSchema.source, clientKind, roomSchemaVersion, authMethod: "device-ticket", deviceIdHint: principal.deviceId.slice(0, 8), cfRay: req.headers.get("cf-ray") ?? undefined })}`);
	const headers = new Headers(req.headers);
	headers.delete("Sec-WebSocket-Protocol");
	headers.set("X-KAOS-Device-ID", principal.deviceId);
	headers.set("X-KAOS-Auth-Generation", String(principal.authGeneration));
	const forwarded = new Request(req, { headers });
	const stub = await getServerByName(env.KAOS_SYNC, vaultId);
	const response = await stub.fetch(forwarded);
	if (response.status === 101) {
		const responseHeaders = new Headers(response.headers);
		responseHeaders.set("Sec-WebSocket-Protocol", `kaos-ticket.${ticket}`);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
			webSocket: response.webSocket,
		});
	}
	return response;
}
