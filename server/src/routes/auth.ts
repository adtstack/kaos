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
import type { AuthState, AuthStateWithConfig, Env, UpdateProvider } from "./types";
import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";
import { randomBase64Url } from "../base64url";

export const CLAIM_PROOF_HEADER = "X-KAOS-Claim-Proof";
const MIN_CLAIM_SECRET_LENGTH = 32;
const MAX_CLAIM_SECRET_LENGTH = 512;
const MIN_CLAIM_VAULT_ID_LENGTH = 8;
const MAX_CLAIM_VAULT_ID_LENGTH = 128;

export function getHttpAuthToken(req: Request): string | null {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	const token = auth.slice("Bearer ".length).trim();
	return token || null;
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

function isValidClaimVaultId(value: unknown): value is string {
	return typeof value === "string"
		&& value === value.trim()
		&& value.length >= MIN_CLAIM_VAULT_ID_LENGTH
		&& value.length <= MAX_CLAIM_VAULT_ID_LENGTH
		&& !containsControlCharacter(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

export interface ValidatedClaimRequest {
	host: string;
	vaultId: string;
	ownerDevice: {
		deviceId: string;
		deviceName: string;
		publicKey: JsonWebKey;
	} | null;
	recoverySecret: string;
	recoverySecretHash: string;
}

export type ClaimRequestPreflightResult =
	| { ok: true; claim: ValidatedClaimRequest }
	| { ok: false; response: Response };

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

	const claim = asRecord(body);
	if (!claim) {
		return { ok: false, response: json({ error: "invalid json" }, 400) };
	}
	if (!isValidClaimVaultId(claim.vaultId)) {
		return { ok: false, response: json({ error: "invalid vaultId" }, 400) };
	}

	const deviceObj = asRecord(claim.ownerDevice) ?? asRecord(claim.device);
	let ownerDevice: { deviceId: string; deviceName: string; publicKey: JsonWebKey } | null = null;
	if (deviceObj !== null && deviceObj !== undefined) {
		if (typeof deviceObj.deviceId !== "string" || deviceObj.deviceId.length < 8 || typeof deviceObj.deviceName !== "string" || !deviceObj.deviceName.trim() || !deviceObj.publicKey || typeof deviceObj.publicKey !== "object") {
			return { ok: false, response: json({ error: "invalid owner device" }, 400) };
		}
		const key = asRecord(deviceObj.publicKey);
		if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") {
			return { ok: false, response: json({ error: "invalid owner public key" }, 400) };
		}
		ownerDevice = {
			deviceId: deviceObj.deviceId,
			deviceName: deviceObj.deviceName.trim(),
			publicKey: { kty: "EC", crv: "P-256", x: key.x, y: key.y },
		};
	}

	const recoverySecret = typeof claim.recoverySecret === "string" && claim.recoverySecret.length >= 32
		? claim.recoverySecret
		: randomBase64Url(48);
	const recoverySecretHash = typeof claim.recoverySecretHash === "string" && /^[a-f0-9]{64}$/.test(claim.recoverySecretHash)
		? claim.recoverySecretHash
		: await hashToken(recoverySecret);

	return {
		ok: true,
		claim: {
			host: url.origin,
			vaultId: claim.vaultId,
			ownerDevice,
			recoverySecret,
			recoverySecretHash,
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

export function invalidateStoredServerConfigCache(): void {
	// No module-level cache
}

async function claimServerConfig(env: Env, claim: ValidatedClaimRequest): Promise<Response> {
	const id = env.KAOS_CONFIG.idFromName("global-config");
	const stub = env.KAOS_CONFIG.get(id);
	return await stub.fetch("https://internal/__kaos/claim", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			vaultId: claim.vaultId,
			device: claim.ownerDevice,
			recoverySecretHash: claim.recoverySecretHash,
		}),
	});
}

export async function getAuthState(env: Env): Promise<AuthState> {
	const config = await getStoredServerConfig(env);
	if (config.claimed) {
		return { mode: "device", claimed: true };
	}

	return { mode: "unclaimed", claimed: false };
}

/** Request-scoped state from the Config Durable Object; intentionally uncached. */
export async function getAuthStateWithConfig(env: Env): Promise<AuthStateWithConfig> {
	const config = await getStoredServerConfig(env);
	if (config.claimed) {
		return { mode: "device", claimed: true, config };
	}

	return { mode: "unclaimed", claimed: false, config };
}

export function getCapabilities(
	auth: AuthState,
	env: Env,
	config: StoredServerConfig | null = null,
	options: { includePrivateUpdateMetadata?: boolean } = {},
): {
	claimed: boolean;
	authMode: "device" | "unclaimed";
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

	const claimRes = await claimServerConfig(env, claim);
	if (!claimRes.ok) {
		const err = await claimRes.json().catch(() => ({ error: "claim_failed" }));
		return json(err, claimRes.status);
	}
	const claimBody = asRecord(await claimRes.json()) ?? {};

	let claimedConfig: StoredServerConfig | null = null;
	try {
		claimedConfig = await getStoredServerConfig(env);
	} catch (err) {
		console.warn("[kaos-sync:worker] config fetch failed after claim:", err);
	}

	return json({
		ok: true,
		host: claim.host,
		vaultId: claim.vaultId,
		ownerDeviceId: claim.ownerDevice?.deviceId ?? null,
		ownerPairing: claimBody.ownerPairing ?? null,
		recoverySecret: claim.recoverySecret,
		message: claim.ownerDevice
			? "Server claimed successfully. Primary device registered as Owner."
			: "Server claimed successfully. Connect your primary device using the Owner pairing session.",
		capabilities: getCapabilities(
			{ mode: "device", claimed: true },
			env,
			claimedConfig,
			{ includePrivateUpdateMetadata: true },
		),
	});
}

export async function handleClaimRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	if (authState.claimed) {
		return json({ error: "already_claimed" }, 403);
	}
	const preflight = await preflightClaimRequest(req, env);
	if (!preflight.ok) return preflight.response;
	return await handleValidatedClaimRoute(preflight.claim, env, authState);
}
