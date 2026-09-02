/* eslint-disable no-control-regex */
import { getServerByName } from "partyserver";
import type { DevicePrincipal, DeviceRole, StoredServerConfig } from "../config";
import { sha256Hex } from "../hex";
import { getHttpAuthToken } from "./auth";
import { json } from "./http";
import type { Env } from "./types";

export type DeviceAuthFailure = "unclaimed" | "unauthorized" | "owner_required" | "server_misconfigured";

export type DeviceAuthResult =
	| { ok: true; principal: DevicePrincipal; session: string }
	| { ok: false; reason: DeviceAuthFailure; response: Response };

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function validVaultId(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && value.length >= 8 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

function validSecret(value: unknown): value is string {
	return typeof value === "string" && value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

function sameHash(expected: string, supplied: string): boolean {
	if (expected.length !== supplied.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
	return diff === 0;
}

async function hashSecret(secret: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(secret));
}

async function configFetch(
	env: Env,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const id = env.KAOS_CONFIG.idFromName("global-config");
	const stub = env.KAOS_CONFIG.get(id);
	return await stub.fetch(`https://internal${path}`, init);
}

async function configPost(env: Env, path: string, body: Record<string, unknown>): Promise<Response> {
	return configFetch(env, path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function currentConfig(env: Env): Promise<StoredServerConfig> {
	const response = await configFetch(env, "/__kaos/config");
	if (!response.ok) throw new Error(`config fetch failed (${response.status})`);
	return await response.json();
}

interface CachedSession {
	principal: DevicePrincipal;
	expiresAt: number;
}

const SESSION_CACHE = new Map<string, CachedSession>();
const MAX_SESSION_CACHE_ENTRIES = 5_000;

export function invalidateSessionCache(vaultId?: string): void {
	if (!vaultId) {
		SESSION_CACHE.clear();
		return;
	}
	const prefix = `${vaultId}:`;
	for (const key of SESSION_CACHE.keys()) {
		if (key.startsWith(prefix)) {
			SESSION_CACHE.delete(key);
		}
	}
}

export function getCachedSession(vaultId: string, sessionHash: string): DevicePrincipal | null {
	const key = `${vaultId}:${sessionHash}`;
	const cached = SESSION_CACHE.get(key);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		SESSION_CACHE.delete(key);
		return null;
	}
	return cached.principal;
}

export function setCachedSession(vaultId: string, sessionHash: string, principal: DevicePrincipal, expiresAt: number): void {
	if (SESSION_CACHE.size >= MAX_SESSION_CACHE_ENTRIES) {
		const firstKey = SESSION_CACHE.keys().next().value;
		if (firstKey) SESSION_CACHE.delete(firstKey);
	}
	const key = `${vaultId}:${sessionHash}`;
	SESSION_CACHE.set(key, { principal, expiresAt });
}

function proxyResponse(response: Response): Response {
	return new Response(response.body, { status: response.status, headers: response.headers });
}

/** Validate a device session with Worker in-memory caching to minimize Config DO hits. */
export async function authorizeDeviceRequest(req: Request, env: Env, vaultId: string): Promise<DeviceAuthResult> {
	const session = getHttpAuthToken(req);
	if (!session) return { ok: false, reason: "unauthorized", response: json({ error: "unauthorized" }, 401) };
	const sessionHash = await hashSecret(session);
	const cached = getCachedSession(vaultId, sessionHash);
	if (cached) {
		return {
			ok: true,
			session,
			principal: cached,
		};
	}

	let response: Response;
	try {
		response = await configPost(env, "/__kaos/auth/validate-session", { session, vaultId });
	} catch {
		return { ok: false, reason: "server_misconfigured", response: json({ error: "server_misconfigured" }, 503) };
	}
	if (!response.ok) {
		const status = response.status === 503 ? 503 : 401;
		return { ok: false, reason: status === 503 ? "unclaimed" : "unauthorized", response: json({ error: status === 503 ? "unclaimed" : "unauthorized" }, status) };
	}
	const payload = asRecord(await response.json()) ?? {};
	const principal = asRecord(payload.principal);
	const expiresAt = typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt) ? payload.expiresAt : Date.now() + 5 * 60_000;
	if (!principal || typeof principal.deviceId !== "string" || !validVaultId(principal.vaultId) || (principal.role !== "owner" && principal.role !== "member") || typeof principal.authGeneration !== "number" || principal.vaultId !== vaultId) {
		return { ok: false, reason: "unauthorized", response: json({ error: "unauthorized" }, 401) };
	}
	const validPrincipal: DevicePrincipal = {
		deviceId: principal.deviceId,
		vaultId: principal.vaultId,
		role: principal.role as DeviceRole,
		authGeneration: principal.authGeneration,
	};
	setCachedSession(vaultId, sessionHash, validPrincipal, expiresAt);
	return {
		ok: true,
		session,
		principal: validPrincipal,
	};
}

export async function requireOwner(req: Request, env: Env, vaultId: string): Promise<DeviceAuthResult> {
	const auth = await authorizeDeviceRequest(req, env, vaultId);
	if (!auth.ok) return auth;
	if (auth.principal.role !== "owner") {
		return { ok: false, reason: "owner_required", response: json({ error: "owner_required" }, 403) };
	}
	return auth;
}

/** Public device-auth routes. No shared token is accepted for normal sessions. */
export async function handlePublicDeviceAuthRoute(
	req: Request,
	env: Env,
	action: "recover" | "pair" | "challenge" | "session",
): Promise<Response> {
	let body: Record<string, unknown>;
	try { body = asRecord(await req.json()) ?? {}; } catch { return json({ error: "invalid json" }, 400); }

	if (action === "recover") {
		if (!validVaultId(body.vaultId) || !validSecret(body.recoverySecret) || !validSecret(body.nextRecoverySecret)) {
			return json({ error: "invalid recovery" }, 400);
		}
		let config: StoredServerConfig;
		try { config = await currentConfig(env); } catch { return json({ error: "server_misconfigured" }, 503); }
		if (!config.claimed || config.vaultId !== body.vaultId) return json({ error: "unclaimed" }, 503);
		const suppliedHash = await hashSecret(body.recoverySecret);
		const expectedHash = config.recoverySecretHash ?? (validSecret(env.KAOS_RECOVERY_SECRET) ? await hashSecret(env.KAOS_RECOVERY_SECRET) : null);
		if (!expectedHash || !sameHash(expectedHash, suppliedHash)) return json({ error: "recovery_invalid" }, 403);
		const response = await configPost(env, "/__kaos/auth/recover", {
			...body,
			recoverySecret: undefined,
			nextRecoverySecret: undefined,
			recoveryVerified: true,
			nextRecoverySecretHash: await hashSecret(body.nextRecoverySecret),
		});
		if (response.ok) await signalVaultAuthChange(env, body.vaultId, null);
		return proxyResponse(response);
	}

	const path = action === "pair"
		? "/__kaos/auth/pair"
		: action === "challenge"
			? "/__kaos/auth/challenge"
			: "/__kaos/auth/session";
	return proxyResponse(await configPost(env, path, body));
}

export async function issueSocketTicket(req: Request, env: Env, vaultId: string): Promise<Response> {
	const session = getHttpAuthToken(req);
	if (!session) return json({ error: "unauthorized" }, 401);
	return proxyResponse(await configPost(env, "/__kaos/auth/ticket", { session, vaultId }));
}

export async function consumeSocketTicket(env: Env, vaultId: string, ticket: string): Promise<DevicePrincipal | null> {
	try {
		const response = await configPost(env, "/__kaos/auth/consume-ticket", { ticket, vaultId });
		if (!response.ok) return null;
		const payload = asRecord(await response.json()) ?? {};
		const principal = asRecord(payload.principal);
		if (!principal || typeof principal.deviceId !== "string" || principal.vaultId !== vaultId || (principal.role !== "owner" && principal.role !== "member") || typeof principal.authGeneration !== "number") return null;
		return { deviceId: principal.deviceId, vaultId, role: principal.role as DeviceRole, authGeneration: principal.authGeneration };
	} catch {
		return null;
	}
}

export async function handleOwnerDeviceRoute(
	req: Request,
	env: Env,
	vaultId: string,
	action: "list" | "pair-create" | "role" | "revoke",
): Promise<Response> {
	const auth = await requireOwner(req, env, vaultId);
	if (!auth.ok) return auth.response;
	let body: Record<string, unknown> = {};
	if (action !== "list") {
		try { body = asRecord(await req.json()) ?? {}; } catch { return json({ error: "invalid json" }, 400); }
	}
	const path = action === "list"
		? "/__kaos/devices/list"
		: action === "pair-create"
			? "/__kaos/devices/pair/create"
			: action === "role"
				? "/__kaos/devices/role"
				: "/__kaos/devices/revoke";
	const response = await configPost(env, path, { ...body, session: auth.session, vaultId });
	if (response.ok && (action === "role" || action === "revoke")) {
		// Role changes and revocation advance the vault-wide auth generation and
		// clear all sessions/tickets. Every live socket therefore belongs to a
		// stale generation and must be disconnected.
		await signalVaultAuthChange(env, vaultId, null);
	}
	return proxyResponse(response);
}

export async function handleOwnerUpdateMetadataRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const auth = await requireOwner(req, env, vaultId);
	if (!auth.ok) return auth.response;
	let body: Record<string, unknown>;
	try { body = asRecord(await req.json()) ?? {}; } catch { return json({ error: "invalid json" }, 400); }
	return proxyResponse(await configPost(env, "/__kaos/update-metadata", body));
}

export async function signalVaultAuthChange(env: Env, vaultId: string, deviceId: string | null): Promise<void> {
	invalidateSessionCache(vaultId);
	try {
		const stub = await getServerByName(env.KAOS_SYNC, vaultId);
		await stub.fetch("https://internal/__kaos/auth/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ deviceId, closeAll: deviceId === null }),
		});
	} catch (err) {
		console.warn("[kaos-sync:worker] unable to signal socket revocation", err instanceof Error ? err.message : "unknown");
	}
}
