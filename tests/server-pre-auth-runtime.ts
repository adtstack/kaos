import { authorizeDeviceRequest, invalidateSessionCache } from "../server/src/routes/deviceAuth";
import { handleSyncSocketRoute } from "../server/src/routes/syncSocket";
import type { Env } from "../server/src/routes/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) { console.log(`  PASS  ${message}`); passed++; }
	else { console.error(`  FAIL  ${message}`); failed++; }
}

const VAULT_ID = "vault_12345678";
const SESSION = "s".repeat(48);

function makeEnv(options: { valid?: boolean; principalVault?: string; consumeTicket?: boolean } = {}): {
	env: Env;
	validateCalls: () => number;
	consumeCalls: () => number;
} {
	let validateCalls = 0;
	let consumeCalls = 0;
	const config = {
		idFromName: () => "global-config",
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				const url = new URL(typeof input === "string" ? input : input.toString());
				if (url.pathname === "/__kaos/auth/validate-session") {
					validateCalls++;
					if (!options.valid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
					return new Response(JSON.stringify({ principal: {
						deviceId: "device_12345678", vaultId: options.principalVault ?? VAULT_ID,
						role: "member", authGeneration: 3,
					} }), { status: 200 });
				}
				if (url.pathname === "/__kaos/auth/consume-ticket") {
					consumeCalls++;
					return new Response(JSON.stringify({ error: "unauthorized" }), { status: options.consumeTicket ? 200 : 401 });
				}
				throw new Error(`unexpected Config request: ${url.pathname}`);
			},
		}),
	};
	const syncTrap = {
		idFromName(): never { throw new Error("sync DO touched before valid ticket"); },
		get(): never { throw new Error("sync DO touched before valid ticket"); },
	} as unknown as Env["KAOS_SYNC"];
	return { env: { KAOS_CONFIG: config, KAOS_SYNC: syncTrap }, validateCalls: () => validateCalls, consumeCalls: () => consumeCalls };
}

function vaultRequest(session?: string): Request {
	return new Request(`https://example.test/vault/${VAULT_ID}/debug/recent`, {
		headers: session ? { Authorization: `Bearer ${session}` } : {},
	});
}

function syncRequest(headers: HeadersInit = {}, query = ""): Request {
	return new Request(`https://example.test/vault/sync/${VAULT_ID}${query}`, { headers });
}

console.log("\n--- HTTP authorization has no token fallback and validates every session ---");
{
	invalidateSessionCache();
	const missing = makeEnv({ valid: true });
	const noHeader = await authorizeDeviceRequest(vaultRequest(), missing.env, VAULT_ID);
	assert(!noHeader.ok && noHeader.response.status === 401, "missing bearer is rejected");
	assert(missing.validateCalls() === 0, "missing bearer does not query Config");

	invalidateSessionCache();
	const rejected = makeEnv();
	const expired = await authorizeDeviceRequest(vaultRequest(SESSION), rejected.env, VAULT_ID);
	assert(!expired.ok && expired.response.status === 401, "unknown or revoked session is rejected");
	assert(rejected.validateCalls() === 1, "supplied session is checked against Config");

	invalidateSessionCache();
	const active = makeEnv({ valid: true });
	const first = await authorizeDeviceRequest(vaultRequest(SESSION), active.env, VAULT_ID);
	const second = await authorizeDeviceRequest(vaultRequest(SESSION), active.env, VAULT_ID);
	assert(first.ok && second.ok, "active device session is accepted");
	assert(active.validateCalls() === 1, "second request hits worker isolate session cache (0 DO calls)");

	invalidateSessionCache();
	const crossVault = makeEnv({ valid: true, principalVault: "other_vault_123" });
	const wrongVault = await authorizeDeviceRequest(vaultRequest(SESSION), crossVault.env, VAULT_ID);
	assert(!wrongVault.ok && wrongVault.response.status === 401, "session for another vault is rejected");
}

console.log("\n--- socket admission rejects URL credentials before Config or sync DO access ---");
{
	const noTicket = makeEnv();
	const plain = await handleSyncSocketRoute(syncRequest(), noTicket.env, VAULT_ID);
	assert(plain.status === 401, "socket route requires a WebSocket ticket");
	assert(noTicket.consumeCalls() === 0, "missing ticket does not consume or query Config");

	const queryTicket = makeEnv();
	const query = await handleSyncSocketRoute(syncRequest({}, "?ticket=stolen-ticket&token=stolen-token"), queryTicket.env, VAULT_ID);
	assert(query.status === 401, "query ticket and token are both rejected");
	assert(queryTicket.consumeCalls() === 0, "query credentials never reach Config");

	const protocolTicket = makeEnv();
	const protocol = await handleSyncSocketRoute(syncRequest({ "Sec-WebSocket-Protocol": `kaos-ticket.${"a".repeat(40)}` }), protocolTicket.env, VAULT_ID);
	assert(protocol.status === 401, "unrecognized single-use ticket is rejected");
	assert(protocolTicket.consumeCalls() === 1, "only the protocol ticket reaches Config consumption");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
