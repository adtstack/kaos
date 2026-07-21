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
const SYNC_TOKEN = "sync-token-0123456789abcdef-0123456789abcdef";
const VAULT_ID = "vault-test-1234";

function makeConfigEnv(claimSecret: string | undefined): {
	env: Env;
	claimCalls: () => number;
	configCalls: () => number;
} {
	let calls = 0;
	let configCalls = 0;
	let storedConfig: Record<string, unknown> = { claimed: false };
	const namespace = {
		idFromName: () => "global-config",
		get: () => ({
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				configCalls++;
				const request = new Request(input, init);
				const pathname = new URL(request.url).pathname;
				if (pathname === "/__kaos/claim") {
					calls++;
					const body = await request.json() as { tokenHash?: string };
					storedConfig = { claimed: true, tokenHash: body.tokenHash };
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (pathname === "/__kaos/config") {
					return new Response(JSON.stringify(storedConfig), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
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
		configCalls: () => configCalls,
	};
}

function claimRequest(options: {
	contentType?: string;
	origin?: string;
	proof?: string;
	includeVaultId?: boolean;
	token?: unknown;
	vaultId?: unknown;
	body?: unknown;
} = {}): Request {
	const headers = new Headers();
	headers.set("Content-Type", options.contentType ?? "application/json; charset=utf-8");
	if (options.origin !== undefined) headers.set("Origin", options.origin);
	if (options.proof !== undefined) headers.set(CLAIM_PROOF_HEADER, options.proof);
	return new Request("https://sync.example/claim", {
		method: "POST",
		headers,
		body: JSON.stringify(options.body === undefined ? {
			token: options.token === undefined ? SYNC_TOKEN : options.token,
			...(options.includeVaultId === false
				? {}
				: { vaultId: options.vaultId === undefined ? VAULT_ID : options.vaultId }),
		} : options.body),
	});
}

const unclaimed = { mode: "unclaimed", claimed: false } as const;

console.log("\n--- Claim endpoint fails closed without deployment proof configuration ---");
{
	const missing = makeConfigEnv(undefined);
	const missingResponse = await handleClaimRoute(
		claimRequest({ proof: CLAIM_SECRET }),
		missing.env,
		unclaimed,
	);
	assert(missingResponse.status === 503, "missing KAOS_CLAIM_SECRET rejects claim with 503");
	assert(missing.claimCalls() === 0, "missing claim secret never reaches the Config Durable Object claim mutation");
	assert(!isClaimSecretConfigured(missing.env), "missing claim secret is reported as unconfigured");

	const short = makeConfigEnv("too-short");
	const shortResponse = await handleClaimRoute(
		claimRequest({ proof: "too-short" }),
		short.env,
		unclaimed,
	);
	assert(shortResponse.status === 503, "claim secret shorter than 32 characters fails closed");
	assert(short.claimCalls() === 0, "short claim secret never reaches the claim mutation");

	for (const invalidSecret of [` ${CLAIM_SECRET}`, `${CLAIM_SECRET} `, `${CLAIM_SECRET}é`]) {
		const invalid = makeConfigEnv(invalidSecret);
		assert(!isClaimSecretConfigured(invalid.env), "claim secret must be visible ASCII without whitespace");
	}
}

console.log("\n--- Claim endpoint enforces JSON, same-origin browser requests, and proof header ---");
{
	const wrongType = makeConfigEnv(CLAIM_SECRET);
	const wrongTypeResponse = await handleClaimRoute(
		claimRequest({ contentType: "text/plain", proof: CLAIM_SECRET }),
		wrongType.env,
		unclaimed,
	);
	assert(wrongTypeResponse.status === 415, "preflight-free text/plain claim is rejected");
	assert(wrongType.claimCalls() === 0, "wrong Content-Type cannot mutate the claim config");

	const crossOrigin = makeConfigEnv(CLAIM_SECRET);
	const crossOriginResponse = await handleClaimRoute(
		claimRequest({ origin: "https://attacker.example", proof: CLAIM_SECRET }),
		crossOrigin.env,
		unclaimed,
	);
	assert(crossOriginResponse.status === 403, "cross-origin browser claim is rejected");
	assert(crossOrigin.claimCalls() === 0, "cross-origin claim cannot mutate the claim config");

	const missingProof = makeConfigEnv(CLAIM_SECRET);
	const missingProofResponse = await handleClaimRoute(claimRequest(), missingProof.env, unclaimed);
	assert(missingProofResponse.status === 403, "missing claim proof header is rejected");
	assert(missingProof.claimCalls() === 0, "missing proof cannot mutate the claim config");

	const nearMatch = makeConfigEnv(CLAIM_SECRET);
	const nearMatchResponse = await handleClaimRoute(
		claimRequest({ proof: `${CLAIM_SECRET.slice(0, -1)}x` }),
		nearMatch.env,
		unclaimed,
	);
	assert(nearMatchResponse.status === 403, "near-match claim proof is rejected");
	assert(nearMatch.claimCalls() === 0, "near-match proof cannot mutate the claim config");

	const missingVaultId = makeConfigEnv(CLAIM_SECRET);
	const missingVaultIdResponse = await handleClaimRoute(
		claimRequest({ proof: CLAIM_SECRET, includeVaultId: false }),
		missingVaultId.env,
		unclaimed,
	);
	assert(missingVaultIdResponse.status === 400, "claim without a vault ID is rejected before permanent lock-in");
	assert(missingVaultId.claimCalls() === 0, "missing vault ID cannot consume the one-time claim");

	for (const malformedToken of [
		`${SYNC_TOKEN} `,
		` ${SYNC_TOKEN}`,
		`${SYNC_TOKEN}\n`,
		`${SYNC_TOKEN}é`,
	]) {
		const invalidToken = makeConfigEnv(CLAIM_SECRET);
		const invalidTokenResponse = await handleClaimRoute(
			claimRequest({ proof: CLAIM_SECRET, token: malformedToken }),
			invalidToken.env,
			unclaimed,
		);
		assert(invalidTokenResponse.status === 400, "claim token must be untrimmed visible ASCII without whitespace");
		assert(invalidToken.configCalls() === 0, "malformed token performs zero Config Durable Object calls");
	}

	for (const malformedVaultId of [
		` ${VAULT_ID}`,
		`${VAULT_ID} `,
		`${VAULT_ID}\u0000`,
		`${VAULT_ID}\u007f`,
	]) {
		const invalidVault = makeConfigEnv(CLAIM_SECRET);
		const invalidVaultResponse = await handleClaimRoute(
			claimRequest({ proof: CLAIM_SECRET, vaultId: malformedVaultId }),
			invalidVault.env,
			unclaimed,
		);
		assert(invalidVaultResponse.status === 400, "claim vault ID rejects outer whitespace and control characters");
		assert(invalidVault.configCalls() === 0, "malformed vault ID performs zero Config Durable Object calls");
	}

	const nonObjectBody = makeConfigEnv(CLAIM_SECRET);
	const nonObjectResponse = await handleClaimRoute(
		claimRequest({ proof: CLAIM_SECRET, body: null }),
		nonObjectBody.env,
		unclaimed,
	);
	assert(nonObjectResponse.status === 400, "non-object claim JSON is rejected cleanly");
	assert(nonObjectBody.configCalls() === 0, "non-object claim JSON performs zero Config Durable Object calls");
}

console.log("\n--- Valid same-origin claim preserves setup flow without exposing claim proof ---");
{
	const valid = makeConfigEnv(CLAIM_SECRET);
	const response = await handleClaimRoute(
		claimRequest({ origin: "https://sync.example", proof: CLAIM_SECRET }),
		valid.env,
		unclaimed,
	);
	const responseText = await response.text();
	const payload = JSON.parse(responseText) as Record<string, unknown>;
	assert(response.status === 200, "matching same-origin claim proof succeeds");
	assert(valid.claimCalls() === 1, "valid claim performs exactly one atomic Config Durable Object claim");
	assert(typeof payload.obsidianUrl === "string" && payload.obsidianUrl.startsWith("obsidian://kaos?"), "valid claim still returns the Obsidian setup link");
	assert(typeof payload.mobileSetupUrl === "string" && payload.mobileSetupUrl.startsWith("https://sync.example/mobile-setup#"), "valid claim returns a same-origin mobile trampoline URL");
	assert(typeof payload.qrSvg === "string" && payload.qrSvg.startsWith("<svg"), "valid claim returns a locally generated QR SVG");
	assert(!responseText.includes(CLAIM_SECRET), "claim proof is not returned in the response, deep link, or QR payload");
	assert(isClaimSecretConfigured(valid.env), "valid claim secret is reported as configured");
}

console.log("\n--- Existing claimed and SYNC_TOKEN modes remain compatible ---");
{
	const noBindings = {} as Env;
	const envModeResponse = await handleClaimRoute(
		claimRequest(),
		noBindings,
		{ mode: "env", claimed: true, envToken: SYNC_TOKEN },
	);
	assert(envModeResponse.status === 403, "SYNC_TOKEN mode remains claimed without requiring KAOS_CLAIM_SECRET");

	const claimedModeResponse = await handleClaimRoute(
		claimRequest(),
		noBindings,
		{ mode: "claim", claimed: true, tokenHash: "a".repeat(64) },
	);
	assert(claimedModeResponse.status === 403, "persisted claimed mode remains locked without requiring claim proof configuration");
}

console.log("\n--- Setup HTML has no runtime CDN and is protected by CSP/security headers ---");
{
	const nonce = "0123456789abcdef0123456789abcdef";
	const page = renderSetupPage({
		host: "https://sync.example",
		claimEnabled: true,
		scriptNonce: nonce,
	});
	assert(page.includes('id="claim-secret" type="password"'), "claim page asks for the deployment proof in a password input");
	assert(page.includes(`"${CLAIM_PROOF_HEADER}": claimSecret`), "claim page sends proof only in the dedicated request header");
	assert(page.includes(`<script nonce="${nonce}">`), "claim page inline script carries the response nonce");
	assert(!page.includes("cdn.jsdelivr.net") && !page.includes("QRious"), "claim page executes no external QR/CDN script");
	assert(!page.includes("<script src="), "claim page has no external script source");
	const setupScript = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
	let setupScriptParses = true;
	try {
		new Function(setupScript);
	} catch {
		setupScriptParses = false;
	}
	assert(setupScriptParses, "claim page inline script is syntactically valid JavaScript");

	const lockedPage = renderSetupPage({ host: "https://sync.example", claimEnabled: false, scriptNonce: nonce });
	assert(lockedPage.includes('id="claim" disabled'), "claim UI is disabled when the deployment secret is unconfigured");

	const mobilePage = renderMobileSetupPage({ host: "https://sync.example", scriptNonce: nonce });
	assert(mobilePage.includes(`<script nonce="${nonce}">`), "mobile trampoline inline script carries the response nonce");
	const mobileScript = mobilePage.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
	let mobileScriptParses = true;
	try {
		new Function(mobileScript);
	} catch {
		mobileScriptParses = false;
	}
	assert(mobileScriptParses, "mobile trampoline inline script is syntactically valid JavaScript");
	assert(
		mobileScript.includes("host !== window.location.origin"),
		"mobile trampoline refuses fragments that redirect pairing to another origin",
	);

	const response = html(page, 200, { scriptNonce: nonce });
	const csp = response.headers.get("Content-Security-Policy") ?? "";
	const scriptDirective = csp.split(";").find((part) => part.trim().startsWith("script-src")) ?? "";
	assert(scriptDirective.includes(`'nonce-${nonce}'`), "HTML CSP authorizes only the generated inline-script nonce");
	assert(!scriptDirective.includes("unsafe-inline") && !scriptDirective.includes("http"), "HTML CSP script-src grants neither unsafe-inline nor remote script execution");
	assert(csp.includes("connect-src 'self'"), "HTML CSP limits fetch connections to the same origin");
	assert(response.headers.get("Referrer-Policy") === "no-referrer", "HTML response suppresses referrer leakage");
	assert(response.headers.get("X-Content-Type-Options") === "nosniff", "HTML response disables MIME sniffing");
	assert(response.headers.get("X-Frame-Options") === "DENY", "HTML response cannot be framed for clickjacking");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) process.exit(1);
