import worker from "../server/src/index";
import type { Env } from "../server/src/routes/types";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
	if (condition) { console.log(`  PASS  ${message}`); passed++; }
	else { console.error(`  FAIL  ${message}`); failed++; }
}

const DO_TOUCHED = "Durable Object namespace accessed for an invalid route";
function trapNamespace(): Env["KAOS_CONFIG"] {
	return {
		idFromName(): never { throw new Error(DO_TOUCHED); },
		get(): never { throw new Error(DO_TOUCHED); },
	} as unknown as Env["KAOS_CONFIG"];
}
const trapSync = trapNamespace() as unknown as Env["KAOS_SYNC"];
const trapEnv = { KAOS_CONFIG: trapNamespace(), KAOS_SYNC: trapSync } as Env;

async function expectNoDo(path: string, method = "GET"): Promise<void> {
	let response: Response | null = null;
	let threw = false;
	try { response = await worker.fetch(new Request(`https://example.test${path}`, { method }), trapEnv); }
	catch { threw = true; }
	assert(!threw, `${method} ${path} does not touch a Durable Object`);
	assert(response?.status === 404, `${method} ${path} returns 404`);
}

console.log("\n--- unknown and malformed routes are rejected before any Durable Object access ---");
{
	for (const [path, method] of [
		["/wp-login.php", "GET"], ["/favicon.ico", "GET"], ["/vault/vault_12345678/unknown", "GET"],
		["/vault/vault_12345678/debug/recent", "POST"], ["/vault/vault_12345678/auth/random", "GET"],
		["/vault/vault_12345678/devices/unknown", "POST"], ["/api/not-real", "GET"],
	] as const) {
		await expectNoDo(path, method);
	}
}

console.log("\n--- recognized private routes reach Config and then enforce a device session ---");
{
	let configCalls = 0;
	let validationCalls = 0;
	const config = {
		idFromName: () => "global-config",
		get: () => ({
			fetch: async (input: RequestInfo | URL) => {
				configCalls++;
				const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
				if (path === "/__kaos/auth/validate-session") {
					validationCalls++;
					return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
				}
				if (path === "/__kaos/config") {
					return new Response(JSON.stringify({ claimed: true, vaultId: "vault_12345678" }), { status: 200 });
				}
				throw new Error(`unexpected config path ${path}`);
			},
		}),
	};
	const env = { KAOS_CONFIG: config, KAOS_SYNC: trapSync } as unknown as Env;
	const response = await worker.fetch(new Request("https://example.test/vault/vault_12345678/debug/recent", {
		headers: { Authorization: `Bearer ${"s".repeat(48)}` },
	}), env);
	assert(response.status === 401, "private route rejects an unrecognized device session");
	assert(configCalls === 2 && validationCalls === 1, "recognized route reads current state and validates its supplied session");
}

console.log("\n--- sync requires a subprotocol ticket, never a URL credential ---");
{
	let configCalls = 0;
	const config = {
		idFromName: () => "global-config",
		get: () => ({ fetch: async () => {
			configCalls++;
			return new Response(JSON.stringify({ claimed: true, vaultId: "vault_12345678" }), { status: 200 });
		} }),
	};
	const env = { KAOS_CONFIG: config, KAOS_SYNC: trapSync } as unknown as Env;
	const response = await worker.fetch(new Request("https://example.test/vault/sync/vault_12345678?ticket=old&token=old"), env);
	assert(response.status === 401, "sync URL credentials are rejected");
	assert(configCalls === 1, "recognized sync route loads state but never consumes a URL ticket");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
