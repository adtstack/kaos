import { sha256Hex } from "../hex";
import type { StoredServerConfig } from "../config";
import {
	SERVER_MAX_SCHEMA_VERSION,
	SERVER_MIGRATION_REQUIRED,
	SERVER_MIN_PLUGIN_VERSION,
	SERVER_MIN_SCHEMA_VERSION,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_VERSION,
} from "../version";
import { json } from "./http";
import type { AuthState, AuthStateCached, Env, UpdateProvider } from "./types";
import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";
import * as QRCode from "qrcode/lib/browser";

export const CLAIM_PROOF_HEADER = "X-KAOS-Claim-Proof";
const MIN_CLAIM_SECRET_LENGTH = 32;
const MAX_CLAIM_SECRET_LENGTH = 512;
const MIN_CLAIM_TOKEN_LENGTH = 32;
const MAX_CLAIM_TOKEN_LENGTH = 512;
const MIN_CLAIM_VAULT_ID_LENGTH = 8;
const MAX_CLAIM_VAULT_ID_LENGTH = 128;

export function getHttpAuthToken(req: Request): string | null {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	const token = auth.slice("Bearer ".length).trim();
	return token || null;
}

export function getSocketAuthToken(req: Request): string | null {
	const headerToken = getHttpAuthToken(req);
	if (headerToken) return headerToken;
	return new URL(req.url).searchParams.get("token");
}

async function hashToken(token: string): Promise<string> {
	const bytes = new TextEncoder().encode(token);
	return sha256Hex(bytes);
}

function configuredClaimSecret(env: Env): string | null {
	const secret = env.KAOS_CLAIM_SECRET;
	if (
		typeof secret !== "string"
		|| secret.length < MIN_CLAIM_SECRET_LENGTH
		|| secret.length > MAX_CLAIM_SECRET_LENGTH
		|| !/^[\x21-\x7e]+$/.test(secret)
	) {
		return null;
	}
	return secret;
}

export function isClaimSecretConfigured(env: Env): boolean {
	return configuredClaimSecret(env) !== null;
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

function isValidClaimToken(value: unknown): value is string {
	return typeof value === "string"
		&& value.length >= MIN_CLAIM_TOKEN_LENGTH
		&& value.length <= MAX_CLAIM_TOKEN_LENGTH
		&& /^[\x21-\x7e]+$/.test(value);
}

function isValidClaimVaultId(value: unknown): value is string {
	return typeof value === "string"
		&& value === value.trim()
		&& value.length >= MIN_CLAIM_VAULT_ID_LENGTH
		&& value.length <= MAX_CLAIM_VAULT_ID_LENGTH
		&& !containsControlCharacter(value);
}

export interface ValidatedClaimRequest {
	host: string;
	token: string;
	tokenHash: string;
	vaultId: string;
}

export type ClaimRequestPreflightResult =
	| { ok: true; claim: ValidatedClaimRequest }
	| { ok: false; response: Response };

/**
 * Compare fixed-size SHA-256 digests so a wrong prefix does not return sooner
 * than a right prefix.  Claim proofs are bounded before hashing to avoid an
 * attacker turning this endpoint into an unbounded CPU/memory input.
 */
async function claimProofMatches(expected: string, supplied: string | null): Promise<boolean> {
	if (supplied === null || supplied.length > MAX_CLAIM_SECRET_LENGTH) return false;
	const [expectedHash, suppliedHash] = await Promise.all([
		hashToken(expected),
		hashToken(supplied),
	]);
	let difference = 0;
	for (let i = 0; i < expectedHash.length; i++) {
		difference |= expectedHash.charCodeAt(i) ^ suppliedHash.charCodeAt(i);
	}
	return difference === 0;
}

/**
 * Validate every stateless part of a first-claim request before the Worker
 * consults KAOS_CONFIG. The parsed body is returned to the second phase so the
 * request stream is consumed exactly once.
 */
export async function preflightClaimRequest(
	req: Request,
	env: Env,
): Promise<ClaimRequestPreflightResult> {
	const url = new URL(req.url);
	const claimSecret = configuredClaimSecret(env);
	if (!claimSecret) {
		return { ok: false, response: json({ error: "claim_not_configured" }, 503) };
	}

	const mediaType = req.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json") {
		return {
			ok: false,
			response: json({ error: "content_type_must_be_application_json" }, 415),
		};
	}

	// Browser requests must originate from the Worker itself. Requests without
	// Origin (for example an operator's curl invocation) still need the proof.
	const origin = req.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return { ok: false, response: json({ error: "claim_origin_forbidden" }, 403) };
	}

	if (!(await claimProofMatches(claimSecret, req.headers.get(CLAIM_PROOF_HEADER)))) {
		return { ok: false, response: json({ error: "claim_proof_invalid" }, 403) };
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return { ok: false, response: json({ error: "invalid json" }, 400) };
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, response: json({ error: "invalid json" }, 400) };
	}
	const claim = body as { token?: unknown; vaultId?: unknown };
	if (!isValidClaimToken(claim.token)) {
		return { ok: false, response: json({ error: "invalid token" }, 400) };
	}
	if (!isValidClaimVaultId(claim.vaultId)) {
		return { ok: false, response: json({ error: "invalid vaultId" }, 400) };
	}

	return {
		ok: true,
		claim: {
			host: url.origin,
			token: claim.token,
			tokenHash: await hashToken(claim.token),
			vaultId: claim.vaultId,
		},
	};
}

export function supportsBuckets(env: Env): boolean {
	return env.KAOS_BUCKET !== undefined;
}

export function canonicalRepoForSetup(env: Env): string | undefined {
	const raw = env.KAOS_CANONICAL_REPO?.trim();
	if (!raw) return undefined;
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined;
}

export async function getStoredServerConfig(env: Env): Promise<StoredServerConfig> {
	const id = env.KAOS_CONFIG.idFromName("global-config");
	const stub = env.KAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__kaos/config");
	if (!res.ok) {
		throw new Error(`config fetch failed (${res.status})`);
	}
	return await res.json();
}

// ── Config cache (issue #40 — stop per-request DO round-trips) ───────────────
//
// getStoredServerConfig() does a live Durable Object fetch every call.  In
// claim mode that fires on every Worker request.  Cache the config for a short
// TTL so a reconnect storm or scanner traffic does not each become a separate
// KAOS_CONFIG subrequest.
//
// Security note: we cache the *stored* config (tokenHash, updateProvider etc.),
// not the auth decision itself.  Token verification still runs on every request
// against the cached tokenHash — we just avoid re-fetching the hash from the DO
// on every request.
//
// The cache is invalidated after /claim and /api/update-metadata writes so that
// the operator sees the new state immediately on the next request.

const AUTH_CONFIG_CACHE_TTL_MS = 60 * 60_000; // 1 hour
const UNCLAIMED_CONFIG_CACHE_TTL_MS = 5_000; // 5 seconds (allows post-claim discovery across warm isolates)

let cachedConfig: { value: StoredServerConfig; expiresAt: number } | null = null;
let configInflight: Promise<StoredServerConfig> | null = null;

export function invalidateStoredServerConfigCache(): void {
	cachedConfig = null;
	configInflight = null;
}

export async function getStoredServerConfigCached(env: Env): Promise<StoredServerConfig> {
	const now = Date.now();
	if (cachedConfig && cachedConfig.expiresAt > now) {
		return cachedConfig.value;
	}
	if (configInflight) {
		return configInflight;
	}
	configInflight = getStoredServerConfig(env)
		.then((config) => {
			const ttl = config.claimed ? AUTH_CONFIG_CACHE_TTL_MS : UNCLAIMED_CONFIG_CACHE_TTL_MS;
			cachedConfig = { value: config, expiresAt: Date.now() + ttl };
			return config;
		})
		.finally(() => {
			configInflight = null;
		});
	return configInflight;
}

async function claimServerConfig(env: Env, tokenHash: string): Promise<boolean> {
	const id = env.KAOS_CONFIG.idFromName("global-config");
	const stub = env.KAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__kaos/claim", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ tokenHash }),
	});
	return res.ok;
}

async function setServerUpdateMetadata(env: Env, metadata: {
	updateProvider?: unknown;
	updateRepoUrl?: unknown;
	updateRepoBranch?: unknown;
}): Promise<StoredServerConfig> {
	const id = env.KAOS_CONFIG.idFromName("global-config");
	const stub = env.KAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__kaos/update-metadata", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(metadata),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`update metadata write failed (${res.status})${body ? `: ${body}` : ""}`);
	}
	const payload: { config?: StoredServerConfig } = await res.json();
	if (!payload?.config) {
		throw new Error("update metadata write failed (missing config)");
	}
	return payload.config;
}

export async function getAuthState(env: Env): Promise<AuthState> {
	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfig(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash };
	}

	return { mode: "unclaimed", claimed: false };
}

/**
 * Cached variant of getAuthState.  Uses getStoredServerConfigCached so that
 * repeated requests within AUTH_CONFIG_CACHE_TTL_MS share a single KAOS_CONFIG
 * subrequest instead of each paying a DO round-trip.  The cached AuthState
 * carries the full StoredServerConfig in claim/unclaimed modes so callers can
 * reuse it without a second fetch (e.g. /api/capabilities).
 */
export async function getAuthStateCached(env: Env): Promise<AuthStateCached> {
	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfigCached(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash, config };
	}

	return { mode: "unclaimed", claimed: false, config };
}

export async function isAuthorized(
	state: AuthState,
	token: string | null,
): Promise<boolean> {
	if (!token) return false;
	if (state.mode === "env") {
		return token === state.envToken;
	}
	if (state.mode === "claim") {
		return (await hashToken(token)) === state.tokenHash;
	}
	return false;
}

export type PreAuthRejectionReason = "unclaimed" | "server_misconfigured" | "unauthorized";

/** Typed rejection result — carries both the HTTP response and the reason for logging. */
export interface AuthRejection {
	response: Response;
	reason: PreAuthRejectionReason;
}

/**
 * Returns a typed rejection (response + reason) if the request fails pre-auth,
 * or null if the request is authorized and should proceed to the vault handler.
 * Does NOT touch any Durable Object namespace — exported for runtime testing (FU-4).
 *
 * Callers log `rejection.reason` — no duplicated decision tree.
 */
export async function rejectUnauthorizedVaultRequest(
	req: Request,
	_env: unknown,
	authState: AuthState,
	_vaultId: string,
): Promise<AuthRejection | null> {
	const token = getHttpAuthToken(req);
	if (!authState.claimed) {
		return { response: json({ error: "unclaimed" }, 503), reason: "unclaimed" };
	}
	if (authState.mode === "env" && !authState.envToken) {
		return { response: json({ error: "server_misconfigured" }, 503), reason: "server_misconfigured" };
	}
	if (!(await isAuthorized(authState, token))) {
		return { response: json({ error: "unauthorized" }, 401), reason: "unauthorized" };
	}
	return null;
}

function buildObsidianSetupUrl(host: string, token: string, vaultId?: string): string {
	const params = new URLSearchParams({
		action: "setup",
		host,
		token,
	});
	if (vaultId) {
		params.set("vaultId", vaultId);
	}
	return `obsidian://kaos?${params.toString()}`;
}

function buildMobileSetupUrl(host: string, token: string, vaultId: string): string {
	const fragment = new URLSearchParams({ host, token, vaultId }).toString();
	return `${host}/mobile-setup#${fragment}`;
}

export function getCapabilities(
	auth: AuthState,
	env: Env,
	config: StoredServerConfig | null = null,
	options: { includePrivateUpdateMetadata?: boolean } = {},
): {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	attachments: boolean;
	snapshots: boolean;
	maxBlobUploadBytes: number;
	socketTicketAuth: boolean;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	minSchemaVersion: number | null;
	maxSchemaVersion: number | null;
	migrationRequired: boolean;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
} {
	const bucketEnabled = supportsBuckets(env);
	return {
		claimed: auth.claimed,
		authMode: auth.mode,
		attachments: bucketEnabled,
		snapshots: bucketEnabled,
		maxBlobUploadBytes: MAX_BLOB_UPLOAD_BYTES,
		socketTicketAuth: true,
		serverVersion: SERVER_VERSION,
		minPluginVersion: SERVER_MIN_PLUGIN_VERSION,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
		maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
		migrationRequired: SERVER_MIGRATION_REQUIRED,
		updateProvider: options.includePrivateUpdateMetadata ? (config?.updateProvider ?? null) : null,
		updateRepoUrl: options.includePrivateUpdateMetadata ? (config?.updateRepoUrl ?? null) : null,
		updateRepoBranch: options.includePrivateUpdateMetadata ? (config?.updateRepoBranch ?? null) : null,
	};
}

export async function handleValidatedClaimRoute(
	claim: ValidatedClaimRequest,
	env: Env,
	authState: AuthState,
): Promise<Response> {
	if (authState.claimed) {
		return json({ error: "already_claimed" }, 403);
	}

	const { host, token, tokenHash, vaultId } = claim;
	const mobileSetupUrl = buildMobileSetupUrl(host, token, vaultId);
	let qrSvg: string | null = null;
	try {
		qrSvg = await QRCode.toString(mobileSetupUrl, {
			type: "svg",
			errorCorrectionLevel: "M",
			margin: 2,
			width: 240,
			color: { dark: "#08111d", light: "#ffffff" },
		});
	} catch {
		// QR is a convenience only.  Do not log the generated URL/token and
		// do not make the atomic claim depend on optional rendering.
		console.warn("[kaos-sync:worker] local QR rendering unavailable");
	}
	const claimed = await claimServerConfig(env, tokenHash);
	if (!claimed) {
		return json({ error: "already_claimed" }, 403);
	}
	// Invalidate the cached config so the next request sees the claimed state
	// immediately rather than serving a stale unclaimed response for up to TTL.
	invalidateStoredServerConfigCache();

	let claimedConfig: StoredServerConfig | null = null;
	try {
		claimedConfig = await getStoredServerConfig(env);
	} catch (err) {
		console.warn("[kaos-sync:worker] config fetch failed after claim:", err);
	}

	return json({
		ok: true,
		host,
		obsidianUrl: buildObsidianSetupUrl(host, token, vaultId),
		mobileSetupUrl,
		qrSvg,
		capabilities: getCapabilities(
			{ mode: "claim", claimed: true, tokenHash },
			env,
			claimedConfig,
			{ includePrivateUpdateMetadata: true },
		),
	});
}

export async function handleClaimRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	// Direct callers that already have auth state retain the inexpensive and
	// backwards-compatible already-claimed response. The Worker dispatcher uses
	// preflightClaimRequest() before obtaining this state.
	if (authState.claimed) {
		return json({ error: "already_claimed" }, 403);
	}
	const preflight = await preflightClaimRequest(req, env);
	if (!preflight.ok) return preflight.response;
	return await handleValidatedClaimRoute(preflight.claim, env, authState);
}

export async function handleUpdateMetadataRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const token = getHttpAuthToken(req);
	if (!authState.claimed) {
		return json({ error: "unclaimed" }, 503);
	}
	if (authState.mode === "env" && !authState.envToken) {
		return json({ error: "server_misconfigured" }, 503);
	}
	if (!(await isAuthorized(authState, token))) {
		return json({ error: "unauthorized" }, 401);
	}

	let body: {
		updateProvider?: unknown;
		updateRepoUrl?: unknown;
		updateRepoBranch?: unknown;
	} = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	let updatedConfig: StoredServerConfig;
	try {
		updatedConfig = await setServerUpdateMetadata(env, body);
	} catch (err) {
		const message = err instanceof Error ? err.message : "metadata write failed";
		const status = message.includes("(403)")
			? 403
			: message.includes("(400)")
				? 400
				: 500;
		return json({ error: message }, status);
	}
	// Invalidate cache so the next request sees the updated metadata immediately.
	invalidateStoredServerConfigCache();

	return json({
		ok: true,
		capabilities: getCapabilities(authState, env, updatedConfig, { includePrivateUpdateMetadata: true }),
	});
}
