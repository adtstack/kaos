import {
	CLAIM_PROOF_HEADER,
	handleClaimRoute,
	isClaimSecretConfigured,
} from "../server/src/routes/auth";
import { html } from "../server/src/routes/http";
import { renderMobileSetupPage, renderSetupPage } from "../server/src/setupPage";
import type { Env } from "../server/src/routes/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${message}`);
	failed++;
}

const CLAIM_SECRET = "claim-proof-0123456789abcdef-0123456789abcdef";
const VAULT_ID = "vault-test-1234";
const unclaimed = { mode: "unclaimed", claimed: false } as const;

async function sampleOwnerDevice() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
	const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return {
		deviceId: "initial-owner-device-123",
		deviceName: "Initial Owner",
		publicKey,
	};
}

const ownerDevice = await sampleOwnerDevice();

function makeConfigEnv(claimSecret: string | undefined): { env: Env; claimCalls: () => number } {
	let calls = 0;
	let storedConfig: Record<string, unknown> = {
		claimed: false,
		vaultId: null,
		authGeneration: 1,
		activeDeviceCount: 0,
		recoverySecretHash: null,
		updateProvider: null,
		updateRepoUrl: null,
		updateRepoBranch: null,
	};
	const namespace = {
		idFromName: () => "global-config",
		get: () => ({
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const pathname = new URL(request.url).pathname;
				if (pathname === "/__kaos/claim") {
					calls++;
					const body = await request.json() as { vaultId?: string; recoverySecretHash?: string };
					storedConfig = {
						...storedConfig,
						claimed: true,
						vaultId: body.vaultId ?? null,
						recoverySecretHash: body.recoverySecretHash ?? null,
					};
					return Response.json({ ok: true });
				}
				if (pathname === "/__kaos/config") return Response.json(storedConfig);
				return new Response("not found", { status: 404 });
			},
		}),
	};
	return {
		env: {
			KAOS_CLAIM_SECRET: claimSecret,
			KAOS_CONFIG: namespace as unknown as Env["KAOS_CONFIG"],
			KAOS_SYNC: {} as Env["KAOS_SYNC"],
		},
		claimCalls: () => calls,
	};
}

function claimRequest(options: {
	contentType?: string;
	origin?: string;
	proof?: string;
	body?: unknown;
} = {}): Request {
	const headers = new Headers({ "Content-Type": options.contentType ?? "application/json" });
	if (options.origin !== undefined) headers.set("Origin", options.origin);
	if (options.proof !== undefined) headers.set(CLAIM_PROOF_HEADER, options.proof);
	return new Request("https://sync.example/claim", {
		method: "POST",
		headers,
		body: JSON.stringify(options.body ?? { ownerDevice, vaultId: VAULT_ID }),
	});
}

console.log("\n--- Claim endpoint fails closed and registers owner directly ---");
{
	const missing = makeConfigEnv(undefined);
	assert((await handleClaimRoute(claimRequest({ proof: CLAIM_SECRET }), missing.env, unclaimed)).status === 503, "missing KAOS_CLAIM_SECRET rejects the claim");
	assert(missing.claimCalls() === 0, "unconfigured claim does not mutate Config DO");
	assert(!isClaimSecretConfigured(missing.env), "missing claim secret is reported as unconfigured");

	const wrongType = makeConfigEnv(CLAIM_SECRET);
	assert((await handleClaimRoute(claimRequest({ contentType: "text/plain", proof: CLAIM_SECRET }), wrongType.env, unclaimed)).status === 415, "non-JSON claim is rejected before Config DO mutation");
	assert((await handleClaimRoute(claimRequest({ origin: "https://attacker.example", proof: CLAIM_SECRET }), wrongType.env, unclaimed)).status === 403, "cross-origin browser claim is rejected");
	assert((await handleClaimRoute(claimRequest({ proof: "wrong-proof" }), wrongType.env, unclaimed)).status === 403, "wrong claim proof is rejected");
	assert((await handleClaimRoute(claimRequest({ proof: CLAIM_SECRET, body: { ownerDevice: { deviceId: "short" }, vaultId: VAULT_ID } }), wrongType.env, unclaimed)).status === 400, "malformed owner device is rejected before claim");
}

console.log("\n--- Valid claim registers first Owner device cleanly ---");
{
	const valid = makeConfigEnv(CLAIM_SECRET);
	const response = await handleClaimRoute(claimRequest({ origin: "https://sync.example", proof: CLAIM_SECRET }), valid.env, unclaimed);
	const payload = await response.json() as Record<string, unknown>;
	assert(response.status === 200, "matching same-origin claim succeeds");
	assert(valid.claimCalls() === 1, "claim performs exactly one Config DO mutation");
	assert(payload.vaultId === VAULT_ID, "claim returns the non-secret vault ID");
	assert(typeof payload.recoverySecret === "string", "claim returns the recovery secret for safe backup");
	assert(payload.capabilities && (payload.capabilities as { authMode?: string }).authMode === "device", "claimed capabilities advertise device authentication");
	assert(!JSON.stringify(payload).includes(CLAIM_SECRET), "claim response leaks no claim proof");
}

console.log("\n--- Setup HTML preserves CSP while requiring device enrollment ---");
{
	const nonce = "0123456789abcdef0123456789abcdef";
	const page = renderSetupPage({ host: "https://sync.example", claimEnabled: true, scriptNonce: nonce });
	assert(page.includes('id="claim-secret" type="password"'), "claim page asks for the deploy-time proof in a password input");
	assert(page.includes(`"${CLAIM_PROOF_HEADER}":secret.value`), "claim page sends proof only in the dedicated request header");
	assert(!page.includes("cdn.jsdelivr.net") && !page.includes("<script src="), "claim page has no external script or QR dependency");
	const response = html(page, 200, { scriptNonce: nonce });
	const csp = response.headers.get("Content-Security-Policy") ?? "";
	assert(csp.includes(`'nonce-${nonce}'`) && csp.includes("connect-src 'self'"), "claim page CSP permits only the nonce and same-origin fetches");

	const mobilePage = renderMobileSetupPage({ host: "https://sync.example", scriptNonce: nonce });
	const mobileScript = mobilePage.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
	assert(mobileScript.includes("targetHost!==location.origin"), "mobile invitation page refuses a cross-origin target");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");
if (failed > 0) process.exit(1);
