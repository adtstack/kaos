import assert from "node:assert/strict";
import { getCapabilities } from "../server/src/routes/auth";
import { getSocketTicketFromProtocol } from "../server/src/routes/socketTicketProtocol";
import type { Env } from "../server/src/routes/types";
import { SocketTicketHttpError, isTicketEndpointUnsupported, patchTicketInUrl, parseSocketTicketResponse } from "../src/sync/socketTicket";

const VAULT_ID = "ticket-vault-12345";
const ticket = "a".repeat(43);

console.log("\n--- device-bound WebSocket ticket transport ---");

assert.equal(
	getSocketTicketFromProtocol(new Request(`https://sync.example/vault/sync/${VAULT_ID}?ticket=${ticket}`, { headers: { Upgrade: "websocket" } })),
	null,
	"query-string ticket is rejected",
);
assert.equal(
	getSocketTicketFromProtocol(new Request(`https://sync.example/vault/sync/${VAULT_ID}?token=legacy-secret`, { headers: { Upgrade: "websocket" } })),
	null,
	"legacy query bearer is rejected",
);
assert.equal(
	getSocketTicketFromProtocol(new Request(`https://sync.example/vault/sync/${VAULT_ID}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `kaos-ticket.${ticket}` } })),
	ticket,
	"one syntactically valid subprotocol ticket is accepted",
);
assert.equal(
	getSocketTicketFromProtocol(new Request(`https://sync.example/vault/sync/${VAULT_ID}`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chat, kaos-ticket.${ticket}, kaos-ticket.${"b".repeat(43)}` } })),
	null,
	"ambiguous subprotocol tickets are rejected",
);

const internalUrl = patchTicketInUrl(`wss://sync.example/vault/sync/${VAULT_ID}?schemaVersion=1&token=old`, ticket);
assert.ok(internalUrl.includes("ticket=") && !internalUrl.includes("token=old"), "provider placeholder removes the legacy token before the WebSocket wrapper sends the ticket as a subprotocol");
assert.deepEqual(
	parseSocketTicketResponse({ ticket, expiresAt: Date.now() + 300_000, ttlMs: 300_000 }).value,
	ticket,
	"client accepts the server's five-minute ticket contract",
);
assert.equal(isTicketEndpointUnsupported(new SocketTicketHttpError(404)), true, "missing required ticket endpoint is a hard incompatibility");
assert.equal(isTicketEndpointUnsupported(new SocketTicketHttpError(401)), false, "session authorization failure is not downgraded to a fallback path");

const capabilities = getCapabilities(
	{ mode: "device", claimed: true },
	{ KAOS_CONFIG: {} as Env["KAOS_CONFIG"], KAOS_SYNC: {} as Env["KAOS_SYNC"] },
);
assert.equal(capabilities.authMode, "device", "capabilities expose only device authentication");
assert.equal(capabilities.socketTicketAuth, true, "device auth requires short-lived socket tickets");

console.log("  PASS  URL credentials are blocked; one-time tickets use only the WebSocket subprotocol");
