import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(here, path), "utf8");
const deviceAuth = read("../server/src/routes/deviceAuth.ts");
const socket = read("../server/src/routes/syncSocket.ts");
const protocol = read("../server/src/routes/socketTicketProtocol.ts");
const index = read("../server/src/index.ts");
const syncServer = read("../server/src/server.ts");

let passed = 0;
let failed = 0;
function assert(condition, message) {
	if (condition) { console.log(`  PASS  ${message}`); passed++; }
	else { console.error(`  FAIL  ${message}`); failed++; }
}

console.log("\n--- device authorization is authoritative and has no Worker-global cache ---");
{
	assert(deviceAuth.includes('"/__kaos/auth/validate-session"'), "every private HTTP request uses Config session validation");
	assert(!/AUTH_CONFIG_CACHE|cachedConfig|getAuthStateCached/.test(deviceAuth), "device authorization has no module-level authorization cache");
	assert(deviceAuth.includes("signalVaultAuthChange") && syncServer.includes("/__kaos/auth/revoke"), "approval and revocation signal live socket closure");
}

console.log("\n--- socket credential admission is protocol-only and non-persistent ---");
{
	assert(!/recordVaultTrace\s*\(/.test(socket), "socket admission does not create a trace write per connection");
	assert(socket.includes("getSocketTicketFromProtocol(req)"), "socket route reads the ticket from WebSocket subprotocol");
	assert(!socket.includes("searchParams.get(\"ticket\")") && !socket.includes("searchParams.get(\"token\")"), "socket route never accepts URL ticket or token values");
	assert(protocol.includes("kaos-ticket.") && protocol.includes("Sec-WebSocket-Protocol"), "ticket protocol parser accepts the dedicated subprotocol only");
	assert(/console\.warn\s*\(/.test(socket), "rejected sockets retain worker-log diagnostics");
}

console.log("\n--- private vault routes apply the device gate before data handlers ---");
{
	const gate = index.indexOf("await authorizeDeviceRequest(req, env, vaultId)");
	const blobHandler = index.indexOf("handleBlobRoute(env, vaultId");
	assert(gate !== -1 && blobHandler !== -1 && gate < blobHandler, "vault data handler follows the device session gate");
	assert(index.includes('route.kind === "not-found"') && index.indexOf('route.kind === "not-found"') < index.indexOf("getAuthStateWithConfig(env)"), "unknown routes remain 404 before Config access");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
