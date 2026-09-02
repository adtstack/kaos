/* eslint-disable no-control-regex */
import { base64UrlToBytes, randomBase64Url } from "./base64url";
import { sha256Hex } from "./hex";

const CLAIMED_KEY = "claimed";
const VAULT_ID_KEY = "vaultId";
const AUTH_GENERATION_KEY = "authGeneration";
const RECOVERY_SECRET_HASH_KEY = "recoverySecretHash";
const DEVICES_KEY = "authDevices";
const PAIRINGS_KEY = "authPairings";
const CHALLENGES_KEY = "authChallenges";
const SESSIONS_KEY = "authSessions";
const TICKETS_KEY = "authTickets";
const AUDIT_KEY = "authAudit";
const UPDATE_PROVIDER_KEY = "updateProvider";
const UPDATE_REPO_URL_KEY = "updateRepoUrl";
const UPDATE_REPO_BRANCH_KEY = "updateRepoBranch";

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_PAIRING_TTL_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 90_000;
const SESSION_TTL_MS = 5 * 60_000;
/** Single-use WebSocket tickets are short-lived. */
export const DEVICE_TICKET_TTL_MS = 5 * 60_000;
const MAX_DEVICES = 200;
const MAX_PAIRINGS = 50;
const MAX_AUDIT_ENTRIES = 200;
const MAX_SESSIONS = 1_000;
const MAX_TICKETS = 1_000;

type UpdateProvider = "github" | "gitlab" | "unknown";
export type DeviceRole = "owner" | "member";
export type DeviceStatus = "active" | "revoked";

export interface StoredDevice {
	id: string;
	vaultId: string;
	name: string;
	publicKey: JsonWebKey;
	fingerprint: string;
	role: DeviceRole;
	status: DeviceStatus;
	createdAt: number;
	approvedAt: number;
	revokedAt: number | null;
	lastSeenAt: number | null;
}

interface StoredPairing {
	id: string;
	secretHash: string;
	code: string;
	createdBy: string;
	createdAt: number;
	expiresAt: number;
	role?: DeviceRole;
}

interface StoredChallenge {
	id: string;
	deviceId: string;
	vaultId: string;
	nonce: string;
	authGeneration: number;
	expiresAt: number;
}

interface StoredSession {
	id: string;
	hash: string;
	deviceId: string;
	vaultId: string;
	authGeneration: number;
	expiresAt: number;
}

interface StoredTicket {
	hash: string;
	deviceId: string;
	vaultId: string;
	authGeneration: number;
	expiresAt: number;
}

interface AuditEvent {
	at: number;
	action: "claimed" | "recovery" | "pairing_created" | "device_paired" | "device_role_changed" | "device_revoked";
	actorDeviceId: string | null;
	targetDeviceId: string | null;
	fingerprint: string | null;
}

export interface StoredServerConfig {
	claimed: boolean;
	vaultId: string | null;
	authGeneration: number;
	activeDeviceCount: number;
	recoverySecretHash: string | null;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
}

export interface DevicePrincipal {
	deviceId: string;
	vaultId: string;
	role: DeviceRole;
	authGeneration: number;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function validId(value: unknown, max = 128): value is string {
	return typeof value === "string" && value.length >= 8 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

function validVaultId(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && value.length >= 8 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

function validName(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validPublicKey(value: unknown): value is JsonWebKey {
	const key = asRecord(value);
	return !!key && key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string"
		&& /^[A-Za-z0-9_-]{42,64}$/.test(key.x) && /^[A-Za-z0-9_-]{42,64}$/.test(key.y) && key.d === undefined;
}

const PAIRING_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generatePairingCode(): string {
	let code = "";
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	for (let i = 0; i < 6; i++) {
		code += PAIRING_CHARS[bytes[i] % PAIRING_CHARS.length];
	}
	return code;
}

export function normalizePairingCode(input: string): string {
	let raw = input.trim().toUpperCase();
	if (raw.startsWith("KAOS-") || raw.startsWith("KAOS_") || raw.startsWith("KAOS ")) {
		raw = raw.slice(5);
	} else if (raw.startsWith("KAOS")) {
		raw = raw.slice(4);
	}
	return raw.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "");
}

function normalizeUpdateProvider(value: unknown): UpdateProvider | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateProvider");
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "github" || raw === "gitlab" || raw === "unknown") return raw;
	throw new Error("invalid updateProvider");
}

function normalizeUpdateRepoUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoUrl");
	const raw = value.trim();
	if (!raw) return null;
	let parsed: URL;
	try { parsed = new URL(raw); } catch { throw new Error("invalid updateRepoUrl"); }
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.pathname.split("/").filter(Boolean).length < 2) throw new Error("invalid updateRepoUrl");
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeUpdateRepoBranch(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoBranch");
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) throw new Error("invalid updateRepoBranch");
	return raw;
}

function list<T>(value: unknown, guard: (entry: unknown) => entry is T): T[] {
	return Array.isArray(value) ? value.filter(guard) : [];
}

function isDevice(value: unknown): value is StoredDevice {
	const d = asRecord(value);
	return !!d && validId(d.id) && validVaultId(d.vaultId) && validName(d.name) && validPublicKey(d.publicKey)
		&& typeof d.fingerprint === "string" && (d.role === "owner" || d.role === "member")
		&& (d.status === "active" || d.status === "revoked")
		&& typeof d.createdAt === "number" && typeof d.approvedAt === "number"
		&& (typeof d.revokedAt === "number" || d.revokedAt === null) && (typeof d.lastSeenAt === "number" || d.lastSeenAt === null);
}

function isPairing(value: unknown): value is StoredPairing {
	const p = asRecord(value);
	return !!p && validId(p.id) && validHash(p.secretHash) && typeof p.code === "string" && p.code.length === 6 && validId(p.createdBy) && typeof p.createdAt === "number" && typeof p.expiresAt === "number" && (p.role === undefined || p.role === "owner" || p.role === "member");
}

function isChallenge(value: unknown): value is StoredChallenge {
	const c = asRecord(value);
	return !!c && validId(c.id) && validId(c.deviceId) && validVaultId(c.vaultId) && typeof c.nonce === "string" && typeof c.authGeneration === "number" && typeof c.expiresAt === "number";
}

function isSession(value: unknown): value is StoredSession {
	const s = asRecord(value);
	return !!s && validId(s.id) && validHash(s.hash) && validId(s.deviceId) && validVaultId(s.vaultId) && typeof s.authGeneration === "number" && typeof s.expiresAt === "number";
}

function isTicket(value: unknown): value is StoredTicket {
	const t = asRecord(value);
	return !!t && validHash(t.hash) && validId(t.deviceId) && validVaultId(t.vaultId) && typeof t.authGeneration === "number" && typeof t.expiresAt === "number";
}

function isAudit(value: unknown): value is AuditEvent {
	const e = asRecord(value);
	return !!e && typeof e.at === "number" && ["claimed", "recovery", "pairing_created", "device_paired", "device_role_changed", "device_revoked"].includes(String(e.action))
		&& (typeof e.actorDeviceId === "string" || e.actorDeviceId === null) && (typeof e.targetDeviceId === "string" || e.targetDeviceId === null)
		&& (typeof e.fingerprint === "string" || e.fingerprint === null);
}

function sameSecretHash(expected: string, supplied: string): boolean {
	if (expected.length !== supplied.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
	return diff === 0;
}

function cleanup<T extends { expiresAt: number }>(entries: T[], now: number): T[] {
	return entries.filter((entry) => entry.expiresAt > now);
}

function addAudit(events: AuditEvent[], event: AuditEvent): AuditEvent[] {
	return [...events, event].slice(-MAX_AUDIT_ENTRIES);
}

async function fingerprintForKey(key: JsonWebKey): Promise<string> {
	return (await sha256Hex(new TextEncoder().encode(`${key.kty}.${key.crv}.${key.x}.${key.y}`))).slice(0, 24);
}

async function hashOpaque(value: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(value));
}

async function deviceFromBody(value: Record<string, unknown>): Promise<{ id: string; name: string; publicKey: JsonWebKey } | null> {
	const candidate = asRecord(value.device) ?? asRecord(value.ownerDevice) ?? value;
	if (!validId(candidate.deviceId) || !validName(candidate.deviceName) || !validPublicKey(candidate.publicKey)) return null;
	const key = candidate.publicKey;
	const publicKey = { kty: "EC", crv: "P-256", x: key.x, y: key.y } satisfies JsonWebKey;
	try {
		await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	} catch {
		return null;
	}
	return {
		id: candidate.deviceId,
		name: candidate.deviceName,
		publicKey,
	};
}

function samePublicKey(left: JsonWebKey, right: JsonWebKey): boolean {
	return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}

type AuthValues = {
	claimed: boolean;
	vaultId: string;
	authGeneration: number;
	recoverySecretHash: string | null;
	devices: StoredDevice[];
	pairings: StoredPairing[];
	challenges: StoredChallenge[];
	sessions: StoredSession[];
	tickets: StoredTicket[];
	audit: AuditEvent[];
};

export class ServerConfig {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__kaos/config") return json(await this.readConfig());
		if (request.method !== "POST") return json({ error: "not found" }, 404);
		let body: Record<string, unknown>;
		try { body = asRecord(await request.json()) ?? {}; } catch { return json({ error: "invalid json" }, 400); }
		switch (url.pathname) {
			case "/__kaos/claim": return this.claim(body);
			case "/__kaos/update-metadata": return this.updateMetadata(body);
			case "/__kaos/auth/recover": return this.recover(body);
			case "/__kaos/auth/pair": return this.pair(body);
			case "/__kaos/auth/challenge": return this.challenge(body);
			case "/__kaos/auth/session": return this.session(body);
			case "/__kaos/auth/validate-session": return this.validateSession(body);
			case "/__kaos/auth/ticket": return this.issueTicket(body);
			case "/__kaos/auth/consume-ticket": return this.consumeTicket(body);
			case "/__kaos/devices/list": return this.listDevices(body);
			case "/__kaos/devices/pair/create": return this.createPairing(body);
			case "/__kaos/devices/role": return this.changeDeviceRole(body);
			case "/__kaos/devices/revoke": return this.revokeDevice(body);
			default: return json({ error: "not found" }, 404);
		}
	}

	private async claim(body: Record<string, unknown>): Promise<Response> {
		if (!validVaultId(body.vaultId) || !validHash(body.recoverySecretHash)) return json({ error: "invalid claim" }, 400);
		const ownerDevice = await deviceFromBody(body);
		const now = Date.now();
		return this.state.storage.transaction(async (txn) => {
			const map = await txn.get<unknown>([CLAIMED_KEY, VAULT_ID_KEY]);
			if (map.get(CLAIMED_KEY) === true && validVaultId(map.get(VAULT_ID_KEY))) return json({ error: "already_claimed" }, 403);
			if (ownerDevice) {
				const fingerprint = await fingerprintForKey(ownerDevice.publicKey);
				const owner: StoredDevice = {
					id: ownerDevice.id,
					vaultId: body.vaultId as string,
					name: ownerDevice.name,
					publicKey: ownerDevice.publicKey,
					fingerprint,
					role: "owner",
					status: "active",
					createdAt: now,
					approvedAt: now,
					revokedAt: null,
					lastSeenAt: now,
				};
				await txn.put({
					[CLAIMED_KEY]: true,
					[VAULT_ID_KEY]: body.vaultId,
					[RECOVERY_SECRET_HASH_KEY]: body.recoverySecretHash,
					[AUTH_GENERATION_KEY]: 1,
					[DEVICES_KEY]: [owner],
					[PAIRINGS_KEY]: [],
					[CHALLENGES_KEY]: [],
					[SESSIONS_KEY]: [],
					[TICKETS_KEY]: [],
					[AUDIT_KEY]: [{ at: now, action: "claimed", actorDeviceId: owner.id, targetDeviceId: owner.id, fingerprint } satisfies AuditEvent],
				});
				return json({ ok: true, deviceId: owner.id, fingerprint, authGeneration: 1, vaultId: body.vaultId });
			} else {
				// Initial ephemeral owner pairing session for browser/web claims
				const qrSecret = randomBase64Url(32);
				const code = generatePairingCode();
				const ownerPairing: StoredPairing = {
					id: randomBase64Url(18),
					secretHash: await hashOpaque(qrSecret),
					code,
					createdBy: "server_claim",
					createdAt: now,
					expiresAt: now + 15 * 60_000,
					role: "owner",
				};
				await txn.put({
					[CLAIMED_KEY]: true,
					[VAULT_ID_KEY]: body.vaultId,
					[RECOVERY_SECRET_HASH_KEY]: body.recoverySecretHash,
					[AUTH_GENERATION_KEY]: 1,
					[DEVICES_KEY]: [],
					[PAIRINGS_KEY]: [ownerPairing],
					[CHALLENGES_KEY]: [],
					[SESSIONS_KEY]: [],
					[TICKETS_KEY]: [],
					[AUDIT_KEY]: [{ at: now, action: "claimed", actorDeviceId: null, targetDeviceId: null, fingerprint: null } satisfies AuditEvent],
				});
				return json({
					ok: true,
					vaultId: body.vaultId,
					authGeneration: 1,
					ownerPairing: {
						pairingId: ownerPairing.id,
						qrSecret,
						code: `KAOS-${code.slice(0, 3)}-${code.slice(3)}`,
						rawCode: code,
						expiresAt: ownerPairing.expiresAt,
					},
				});
			}
		});
	}

	private async updateMetadata(body: Record<string, unknown>): Promise<Response> {
		let updateProvider: UpdateProvider | null; let updateRepoUrl: string | null; let updateRepoBranch: string | null;
		try {
			updateProvider = normalizeUpdateProvider(body.updateProvider);
			updateRepoUrl = normalizeUpdateRepoUrl(body.updateRepoUrl);
			updateRepoBranch = normalizeUpdateRepoBranch(body.updateRepoBranch);
		} catch (err) { return json({ error: err instanceof Error ? err.message : "invalid metadata" }, 400); }
		const entries: Record<string, unknown> = {};
		if (updateProvider !== null) entries[UPDATE_PROVIDER_KEY] = updateProvider;
		if (updateRepoUrl !== null) entries[UPDATE_REPO_URL_KEY] = updateRepoUrl;
		if (updateRepoBranch !== null) entries[UPDATE_REPO_BRANCH_KEY] = updateRepoBranch;
		if (Object.keys(entries).length) await this.state.storage.put(entries);
		return json({ ok: true, config: await this.readConfig() });
	}

	private async recover(body: Record<string, unknown>): Promise<Response> {
		if (body.recoveryVerified !== true || !validHash(body.nextRecoverySecretHash) || !validVaultId(body.vaultId)) return json({ error: "invalid recovery" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn);
			if (!values.claimed || values.vaultId !== body.vaultId) return json({ error: "unclaimed" }, 503);
			const candidate = await deviceFromBody(body);
			if (!candidate) return json({ error: "invalid device" }, 400);
			const now = Date.now();
			const fingerprint = await fingerprintForKey(candidate.publicKey);
			const revoked = values.devices
				.filter((device) => device.id !== candidate.id)
				.map((device) => device.status === "revoked" ? device : { ...device, status: "revoked" as const, revokedAt: now });
			const owner: StoredDevice = { id: candidate.id, vaultId: values.vaultId, name: candidate.name, publicKey: candidate.publicKey, fingerprint, role: "owner", status: "active", createdAt: now, approvedAt: now, revokedAt: null, lastSeenAt: null };
			const generation = values.authGeneration + 1;
			await txn.put({
				[DEVICES_KEY]: [...revoked, owner].slice(-MAX_DEVICES),
				[PAIRINGS_KEY]: [],
				[CHALLENGES_KEY]: [],
				[SESSIONS_KEY]: [],
				[TICKETS_KEY]: [],
				[AUTH_GENERATION_KEY]: generation,
				[RECOVERY_SECRET_HASH_KEY]: body.nextRecoverySecretHash,
				[AUDIT_KEY]: addAudit(values.audit, { at: now, action: "recovery", actorDeviceId: null, targetDeviceId: owner.id, fingerprint }),
			});
			return json({ ok: true, deviceId: owner.id, authGeneration: generation });
		});
	}

	private async createPairing(body: Record<string, unknown>): Promise<Response> {
		return this.state.storage.transaction(async (txn) => {
			const principal = await this.ownerPrincipal(txn, body);
			if (!principal) return json({ error: "owner_required" }, 403);
			const values = await this.readAuthValues(txn);
			const now = Date.now();
			const requestedTtl = typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs) ? Math.floor(body.ttlMs) : PAIRING_TTL_MS;
			const qrSecret = randomBase64Url(32);
			const code = generatePairingCode();
			const pairing: StoredPairing = {
				id: randomBase64Url(18),
				secretHash: await hashOpaque(qrSecret),
				code,
				createdBy: principal.deviceId,
				createdAt: now,
				expiresAt: now + Math.max(60_000, Math.min(MAX_PAIRING_TTL_MS, requestedTtl)),
				role: "member",
			};
			await txn.put({
				[PAIRINGS_KEY]: [...cleanup(values.pairings, now), pairing].slice(-MAX_PAIRINGS),
				[AUDIT_KEY]: addAudit(values.audit, { at: now, action: "pairing_created", actorDeviceId: principal.deviceId, targetDeviceId: null, fingerprint: null }),
			});
			return json({
				pairingId: pairing.id,
				qrSecret,
				code: `KAOS-${code.slice(0, 3)}-${code.slice(3)}`,
				rawCode: code,
				expiresAt: pairing.expiresAt,
				vaultId: principal.vaultId,
			});
		});
	}

	private async pair(body: Record<string, unknown>): Promise<Response> {
		if (!validVaultId(body.vaultId)) return json({ error: "invalid pairing request" }, 400);
		const candidate = await deviceFromBody(body);
		if (!candidate) return json({ error: "invalid device" }, 400);
		const rawSecret = typeof body.qrSecret === "string" ? body.qrSecret : null;
		const rawCode = typeof body.code === "string" ? normalizePairingCode(body.code) : null;
		if (!rawSecret && (!rawCode || rawCode.length !== 6)) {
			return json({ error: "pairing_code_or_secret_required" }, 400);
		}

		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn);
			if (!values.claimed || values.vaultId !== body.vaultId) return json({ error: "unclaimed" }, 503);
			const now = Date.now();
			const activePairings = cleanup(values.pairings, now);
			let matchedPairing: StoredPairing | null = null;
			if (rawSecret) {
				const secretHash = await hashOpaque(rawSecret);
				matchedPairing = activePairings.find((p) => sameSecretHash(p.secretHash, secretHash)) ?? null;
			} else if (rawCode) {
				matchedPairing = activePairings.find((p) => p.code === rawCode) ?? null;
			}

			if (!matchedPairing) return json({ error: "pairing_invalid_or_expired" }, 403);

			const existing = values.devices.find((device) => device.id === candidate.id);
			if (existing?.status === "active") {
				if (!samePublicKey(existing.publicKey, candidate.publicKey)) return json({ error: "active_device_key_mismatch" }, 409);
				// Consume pairing
				await txn.put({ [PAIRINGS_KEY]: activePairings.filter((p) => p !== matchedPairing) });
				return json({ ok: true, status: "active", deviceId: existing.id, fingerprint: existing.fingerprint, vaultId: values.vaultId });
			}
			if (!existing && values.devices.filter((device) => device.status === "active").length >= MAX_DEVICES) return json({ error: "device_limit_reached" }, 429);

			const activeOwners = values.devices.filter((device) => device.status === "active" && device.role === "owner");
			const assignedRole: DeviceRole = matchedPairing.role === "owner" || activeOwners.length === 0 ? "owner" : "member";
			const fingerprint = await fingerprintForKey(candidate.publicKey);
			const newDevice: StoredDevice = {
				id: candidate.id,
				vaultId: values.vaultId,
				name: candidate.name,
				publicKey: candidate.publicKey,
				fingerprint,
				role: assignedRole,
				status: "active",
				createdAt: now,
				approvedAt: now,
				revokedAt: null,
				lastSeenAt: now,
			};
			const devices = existing
				? values.devices.map((d) => d.id === candidate.id ? newDevice : d)
				: [...values.devices, newDevice];

			await txn.put({
				[DEVICES_KEY]: devices,
				[PAIRINGS_KEY]: activePairings.filter((p) => p !== matchedPairing),
				[AUDIT_KEY]: addAudit(values.audit, { at: now, action: "device_paired", actorDeviceId: matchedPairing.createdBy, targetDeviceId: newDevice.id, fingerprint }),
			});

			return json({
				ok: true,
				status: "active",
				deviceId: newDevice.id,
				role: assignedRole,
				fingerprint,
				vaultId: values.vaultId,
				authGeneration: values.authGeneration,
			});
		});
	}

	private async challenge(body: Record<string, unknown>): Promise<Response> {
		if (!validVaultId(body.vaultId) || !validId(body.deviceId)) return json({ error: "invalid challenge" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn);
			if (!values.claimed || values.vaultId !== body.vaultId) return json({ error: "unclaimed" }, 503);
			const device = values.devices.find((entry) => entry.id === body.deviceId && entry.status === "active");
			if (!device) return json({ error: "device_not_approved" }, 403);
			const now = Date.now();
			const challenge: StoredChallenge = { id: randomBase64Url(18), deviceId: device.id, vaultId: values.vaultId, nonce: randomBase64Url(32), authGeneration: values.authGeneration, expiresAt: now + CHALLENGE_TTL_MS };
			await txn.put({ [CHALLENGES_KEY]: [...cleanup(values.challenges, now), challenge].slice(-MAX_SESSIONS) });
			return json({ challengeId: challenge.id, nonce: challenge.nonce, expiresAt: challenge.expiresAt, authGeneration: challenge.authGeneration });
		});
	}

	private async session(body: Record<string, unknown>): Promise<Response> {
		if (!validId(body.challengeId) || typeof body.signature !== "string" || body.signature.length < 16 || body.signature.length > 512) return json({ error: "invalid session" }, 400);
		const challengeId = body.challengeId;
		const encodedSignature = body.signature;
		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn); const now = Date.now();
			const challenge = cleanup(values.challenges, now).find((entry) => entry.id === challengeId);
			if (!challenge || !values.claimed || challenge.authGeneration !== values.authGeneration) return json({ error: "challenge_invalid_or_expired" }, 401);
			const device = values.devices.find((entry) => entry.id === challenge.deviceId && entry.status === "active" && entry.vaultId === challenge.vaultId);
			if (!device) return json({ error: "device_not_approved" }, 403);
			let key: CryptoKey; let signature: Uint8Array;
			try {
				key = await crypto.subtle.importKey("jwk", device.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
				signature = base64UrlToBytes(encodedSignature);
			} catch { return json({ error: "invalid_signature" }, 401); }
			const message = `kaos-device-auth-v1|${challenge.id}|${challenge.nonce}|${challenge.vaultId}|${challenge.deviceId}|${challenge.authGeneration}`;
			if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new TextEncoder().encode(message)))) return json({ error: "invalid_signature" }, 401);
			const token = randomBase64Url(32);
			const session: StoredSession = { id: randomBase64Url(18), hash: await hashOpaque(token), deviceId: device.id, vaultId: device.vaultId, authGeneration: values.authGeneration, expiresAt: now + SESSION_TTL_MS };
			const devices = values.devices.map((entry) => entry.id === device.id ? { ...entry, lastSeenAt: now } : entry);
			await txn.put({ [CHALLENGES_KEY]: values.challenges.filter((entry) => entry.id !== challenge.id), [SESSIONS_KEY]: [...cleanup(values.sessions, now), session].slice(-MAX_SESSIONS), [DEVICES_KEY]: devices });
			return json({ session: token, expiresAt: session.expiresAt, deviceId: device.id, role: device.role, authGeneration: values.authGeneration });
		});
	}

	private async validateSession(body: Record<string, unknown>): Promise<Response> {
		if (typeof body.session !== "string" || body.session.length < 32 || body.session.length > 256 || !validVaultId(body.vaultId)) return json({ error: "unauthorized" }, 401);
		const session = body.session;
		const vaultId = body.vaultId;
		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn); const now = Date.now(); const hash = await hashOpaque(session);
			const storedSession = cleanup(values.sessions, now).find((entry) => sameSecretHash(entry.hash, hash));
			const device = storedSession ? values.devices.find((entry) => entry.id === storedSession.deviceId) : null;
			if (!storedSession || !device || !values.claimed || values.vaultId !== vaultId || storedSession.vaultId !== vaultId || storedSession.authGeneration !== values.authGeneration || device.status !== "active") {
				return json({ error: "unauthorized" }, 401);
			}
			const principal: DevicePrincipal = { deviceId: device.id, vaultId: device.vaultId, role: device.role, authGeneration: values.authGeneration };
			return json({ ok: true, principal, expiresAt: storedSession.expiresAt });
		});
	}

	private async issueTicket(body: Record<string, unknown>): Promise<Response> {
		if (typeof body.session !== "string" || !validVaultId(body.vaultId)) return json({ error: "unauthorized" }, 401);
		const session = body.session;
		const vaultId = body.vaultId;
		return this.state.storage.transaction(async (txn) => {
			const principal = await this.principalForSession(txn, session, vaultId);
			if (!principal) return json({ error: "unauthorized" }, 401);
			const values = await this.readAuthValues(txn); const now = Date.now(); const ticket = randomBase64Url(32);
			const stored: StoredTicket = { hash: await hashOpaque(ticket), deviceId: principal.deviceId, vaultId: principal.vaultId, authGeneration: principal.authGeneration, expiresAt: now + DEVICE_TICKET_TTL_MS };
			await txn.put({ [TICKETS_KEY]: [...cleanup(values.tickets, now), stored].slice(-MAX_TICKETS) });
			return json({ ticket, expiresAt: stored.expiresAt, ttlMs: DEVICE_TICKET_TTL_MS });
		});
	}

	private async consumeTicket(body: Record<string, unknown>): Promise<Response> {
		if (typeof body.ticket !== "string" || body.ticket.length < 32 || body.ticket.length > 256 || !validVaultId(body.vaultId)) return json({ error: "unauthorized" }, 401);
		const rawTicket = body.ticket;
		const vaultId = body.vaultId;
		return this.state.storage.transaction(async (txn) => {
			const values = await this.readAuthValues(txn); const now = Date.now(); const hash = await hashOpaque(rawTicket);
			const ticket = cleanup(values.tickets, now).find((entry) => sameSecretHash(entry.hash, hash));
			const device = ticket ? values.devices.find((entry) => entry.id === ticket.deviceId) : null;
			await txn.put({ [TICKETS_KEY]: cleanup(values.tickets, now).filter((entry) => entry !== ticket) });
			if (!ticket || !device || !values.claimed || values.vaultId !== vaultId || ticket.vaultId !== vaultId || ticket.authGeneration !== values.authGeneration || device.status !== "active") return json({ error: "unauthorized" }, 401);
			return json({ ok: true, principal: { deviceId: device.id, vaultId: device.vaultId, role: device.role, authGeneration: values.authGeneration } satisfies DevicePrincipal });
		});
	}

	private async listDevices(body: Record<string, unknown>): Promise<Response> {
		return this.state.storage.transaction(async (txn) => {
			const principal = await this.ownerPrincipal(txn, body); if (!principal) return json({ error: "owner_required" }, 403);
			const values = await this.readAuthValues(txn);
			return json({ devices: values.devices.map(({ publicKey: _publicKey, ...device }) => device), authGeneration: values.authGeneration });
		});
	}

	private async changeDeviceRole(body: Record<string, unknown>): Promise<Response> {
		if (!validId(body.targetDeviceId) || (body.role !== "owner" && body.role !== "member")) return json({ error: "invalid role change" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const principal = await this.ownerPrincipal(txn, body); if (!principal) return json({ error: "owner_required" }, 403);
			const values = await this.readAuthValues(txn); const target = values.devices.find((device) => device.id === body.targetDeviceId && device.status === "active");
			if (!target) return json({ error: "active_device_not_found" }, 404);
			const role = body.role as DeviceRole;
			if (target.role === role) return json({ ok: true, targetDeviceId: target.id, role, authGeneration: values.authGeneration });
			const owners = values.devices.filter((device) => device.status === "active" && device.role === "owner");
			if (target.role === "owner" && role === "member" && owners.length <= 1) return json({ error: "last_owner_cannot_be_demoted" }, 409);
			const now = Date.now(); const generation = values.authGeneration + 1;
			const devices = values.devices.map((device) => device.id === target.id ? { ...device, role } : device);
			await txn.put({ [DEVICES_KEY]: devices, [AUTH_GENERATION_KEY]: generation, [SESSIONS_KEY]: [], [TICKETS_KEY]: [], [CHALLENGES_KEY]: [], [AUDIT_KEY]: addAudit(values.audit, { at: now, action: "device_role_changed", actorDeviceId: principal.deviceId, targetDeviceId: target.id, fingerprint: target.fingerprint }) });
			return json({ ok: true, targetDeviceId: target.id, role, authGeneration: generation });
		});
	}

	private async revokeDevice(body: Record<string, unknown>): Promise<Response> {
		if (!validId(body.targetDeviceId)) return json({ error: "invalid device" }, 400);
		return this.state.storage.transaction(async (txn) => {
			const principal = await this.ownerPrincipal(txn, body); if (!principal) return json({ error: "owner_required" }, 403);
			const values = await this.readAuthValues(txn); const target = values.devices.find((device) => device.id === body.targetDeviceId && device.status === "active");
			if (!target) return json({ error: "active_device_not_found" }, 404);
			const owners = values.devices.filter((device) => device.status === "active" && device.role === "owner");
			if (target.role === "owner" && owners.length <= 1) return json({ error: "last_owner_cannot_be_revoked" }, 409);
			const now = Date.now(); const generation = values.authGeneration + 1;
			const devices = values.devices.map((device) => device.id === target.id ? { ...device, status: "revoked" as const, revokedAt: now } : device);
			await txn.put({ [DEVICES_KEY]: devices, [AUTH_GENERATION_KEY]: generation, [SESSIONS_KEY]: [], [TICKETS_KEY]: [], [CHALLENGES_KEY]: [], [AUDIT_KEY]: addAudit(values.audit, { at: now, action: "device_revoked", actorDeviceId: principal.deviceId, targetDeviceId: target.id, fingerprint: target.fingerprint }) });
			return json({ ok: true, targetDeviceId: target.id, authGeneration: generation });
		});
	}

	private async ownerPrincipal(txn: DurableObjectTransaction, body: Record<string, unknown>): Promise<DevicePrincipal | null> {
		if (typeof body.session !== "string" || !validVaultId(body.vaultId)) return null;
		const principal = await this.principalForSession(txn, body.session, body.vaultId);
		return principal?.role === "owner" ? principal : null;
	}

	private async principalForSession(txn: DurableObjectTransaction, rawSession: string, vaultId: string): Promise<DevicePrincipal | null> {
		const values = await this.readAuthValues(txn); const now = Date.now(); const hash = await hashOpaque(rawSession);
		const session = cleanup(values.sessions, now).find((entry) => sameSecretHash(entry.hash, hash));
		const device = session ? values.devices.find((entry) => entry.id === session.deviceId) : null;
		if (!session || !device || !values.claimed || values.vaultId !== vaultId || session.vaultId !== vaultId || session.authGeneration !== values.authGeneration || device.status !== "active") return null;
		return { deviceId: device.id, vaultId: device.vaultId, role: device.role, authGeneration: values.authGeneration };
	}

	private async readAuthValues(storage: DurableObjectStorage | DurableObjectTransaction): Promise<AuthValues> {
		const map = await storage.get<unknown>([CLAIMED_KEY, VAULT_ID_KEY, AUTH_GENERATION_KEY, RECOVERY_SECRET_HASH_KEY, DEVICES_KEY, PAIRINGS_KEY, CHALLENGES_KEY, SESSIONS_KEY, TICKETS_KEY, AUDIT_KEY]);
		const vaultId = map.get(VAULT_ID_KEY);
		const generation = map.get(AUTH_GENERATION_KEY);
		const recoverySecretHash = map.get(RECOVERY_SECRET_HASH_KEY);
		return {
			claimed: map.get(CLAIMED_KEY) === true && validVaultId(vaultId),
			vaultId: validVaultId(vaultId) ? vaultId : "",
			authGeneration: Number.isInteger(generation) ? Math.max(1, generation as number) : 1,
			recoverySecretHash: validHash(recoverySecretHash) ? recoverySecretHash : null,
			devices: list(map.get(DEVICES_KEY), isDevice),
			pairings: list(map.get(PAIRINGS_KEY), isPairing),
			challenges: list(map.get(CHALLENGES_KEY), isChallenge),
			sessions: list(map.get(SESSIONS_KEY), isSession),
			tickets: list(map.get(TICKETS_KEY), isTicket),
			audit: list(map.get(AUDIT_KEY), isAudit),
		};
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const [values, metadata] = await Promise.all([
			this.readAuthValues(this.state.storage),
			this.state.storage.get<unknown>([UPDATE_PROVIDER_KEY, UPDATE_REPO_URL_KEY, UPDATE_REPO_BRANCH_KEY]),
		]);
		const updateProvider = metadata.get(UPDATE_PROVIDER_KEY);
		const updateRepoUrl = metadata.get(UPDATE_REPO_URL_KEY);
		const updateRepoBranch = metadata.get(UPDATE_REPO_BRANCH_KEY);
		return {
			claimed: values.claimed,
			vaultId: values.claimed ? values.vaultId : null,
			authGeneration: values.authGeneration,
			activeDeviceCount: values.devices.filter((device) => device.status === "active").length,
			recoverySecretHash: values.recoverySecretHash,
			updateProvider: updateProvider === "github" || updateProvider === "gitlab" || updateProvider === "unknown" ? updateProvider : null,
			updateRepoUrl: typeof updateRepoUrl === "string" && updateRepoUrl.length > 0 ? updateRepoUrl : null,
			updateRepoBranch: typeof updateRepoBranch === "string" && updateRepoBranch.length > 0 ? updateRepoBranch : null,
		};
	}
}
