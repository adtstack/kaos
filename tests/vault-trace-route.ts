/**
 * Unit tests for the public audit endpoint handleVaultTraceRoute
 * (POST /vault/:id/trace). The classifier coverage lives in
 * server-route-classification-runtime.ts; these tests exercise the handler
 * itself with a stub DO namespace.
 */

import { handleVaultTraceRoute } from "../server/src/routes/trace";
import { json } from "../server/src/routes/http";
import type { Env } from "../server/src/routes/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function makeEnv(
	onDoFetch: (req: Request) => Response | Promise<Response>,
	markDoTouched: () => void = () => {},
): Env {
	return {
		KAOS_SYNC: {
			idFromName: () => {
				markDoTouched();
				return "room-id";
			},
			get: () => ({
				fetch: (req: Request) => onDoFetch(req),
			}),
		},
	} as unknown as Env;
}

console.log("\n--- Test 1: valid audit POST is forwarded to the room DO ---");
{
	let received: { url: string; body: unknown } | null = null;
	const env = makeEnv(async (req) => {
		received = { url: req.url, body: await req.json() };
		return json({ ok: true });
	});
	const res = await handleVaultTraceRoute(
		env,
		"vault-a",
		new Request("https://example.com/vault/vault-a/trace", {
			method: "POST",
			body: JSON.stringify({
				event: "revision.discarded",
				data: { records: [{ pathHash: "abc:12", contentHash: "def", reason: "superseded-external-revision", ts: "2026-08-13T00:00:00.000Z" }] },
			}),
		}),
		json,
	);
	assert(res.status === 200, "valid audit POST returns 200");
	const payload = await res.json() as { ok?: unknown };
	assert(payload.ok === true, "valid audit POST returns { ok: true }");
	assert(received?.url === "https://internal/__kaos/trace", "DO receives the internal /__kaos/trace path");
	const body = received?.body as { event?: unknown; data?: { records?: unknown } };
	assert(body.event === "revision.discarded", "DO receives the event name");
	assert(Array.isArray(body.data?.records) && (body.data?.records as unknown[]).length === 1, "DO receives the record batch");
}

console.log("\n--- Test 2: invalid JSON is rejected before touching the DO ---");
{
	let doTouched = false;
	const env = makeEnv(async () => json({ ok: true }), () => { doTouched = true; });
	const res = await handleVaultTraceRoute(
		env,
		"vault-a",
		new Request("https://example.com/vault/vault-a/trace", {
			method: "POST",
			body: "{not-json",
		}),
		json,
	);
	assert(res.status === 400, "invalid JSON returns 400");
	assert(!doTouched, "invalid JSON never touches the Durable Object");
}

console.log("\n--- Test 3: missing or empty event is rejected before touching the DO ---");
{
	let doTouched = false;
	const env = makeEnv(async () => json({ ok: true }), () => { doTouched = true; });
	for (const body of ["{}", JSON.stringify({ event: "" }), JSON.stringify({ event: 42 })]) {
		const res = await handleVaultTraceRoute(
			env,
			"vault-a",
			new Request("https://example.com/vault/vault-a/trace", {
				method: "POST",
				body,
			}),
			json,
		);
		assert(res.status === 400, `missing/empty event (${body}) returns 400`);
	}
	assert(!doTouched, "missing event never touches the Durable Object");
}

console.log("\n--- Test 4: non-object data is normalized to an empty object ---");
{
	let receivedBody: unknown = null;
	const env = makeEnv(async (req) => {
		receivedBody = await req.json();
		return json({ ok: true });
	});
	const res = await handleVaultTraceRoute(
		env,
		"vault-a",
		new Request("https://example.com/vault/vault-a/trace", {
			method: "POST",
			body: JSON.stringify({ event: "revision.discarded", data: "not-an-object" }),
		}),
		json,
	);
	assert(res.status === 200, "non-object data still returns 200");
	const body = receivedBody as { data?: unknown };
	assert(body.data !== undefined && typeof body.data === "object", "non-object data is normalized to an object");
}

console.log("\n--- Test 5: DO failure surfaces as ok:false without throwing ---");
{
	const env = makeEnv(async () => json({ ok: false }, 500));
	const res = await handleVaultTraceRoute(
		env,
		"vault-a",
		new Request("https://example.com/vault/vault-a/trace", {
			method: "POST",
			body: JSON.stringify({ event: "revision.discarded" }),
		}),
		json,
	);
	assert(res.status === 200, "DO failure returns 200 envelope (caller decides)");
	const payload = await res.json() as { ok?: unknown };
	assert(payload.ok === false, "DO failure surfaces as ok:false");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
