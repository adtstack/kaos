import { obsidianRequest } from "../utils/http";
import { bytesToBase64Url, randomBase64Url } from "../utils/base64url";

const DB_NAME = "kaos-device-auth-v1";
const STORE_NAME = "identities";
const DB_VERSION = 1;
const SESSION_REFRESH_BUFFER_MS = 30_000;

export type DeviceRole = "owner" | "member";

export interface DeviceIdentity {
	deviceId: string;
	keyPair: CryptoKeyPair;
	publicKey: JsonWebKey;
}

interface StoredIdentity extends DeviceIdentity {
	key: string;
}

export interface DeviceAuthConfig {
	host: string;
	vaultId: string;
	deviceName: string;
	deviceId: string;
	persistDeviceId(deviceId: string): Promise<void>;
}

export interface DeviceSession {
	value: string;
	expiresAt: number;
	role: DeviceRole;
	deviceId: string;
}

export interface ManagedDevice {
	id: string;
	name: string;
	fingerprint: string;
	role: DeviceRole;
	status: "active" | "revoked";
	createdAt: number;
	lastSeenAt: number | null;
}

export class DeviceAuthHttpError extends Error {
	constructor(readonly status: number, message = `device auth request failed (${status})`) {
		super(message);
		this.name = "DeviceAuthHttpError";
	}
}

function identityKey(host: string, vaultId: string): string {
	return `${host.trim().replace(/\/$/, "")}\u0000${vaultId}`;
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (!globalThis.indexedDB) {
			reject(new Error("IndexedDB is unavailable; device authentication cannot safely persist an identity."));
			return;
		}
		const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Unable to open device identity database"));
	});
}

async function readIdentity(key: string): Promise<StoredIdentity | null> {
	const db = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
			request.onsuccess = () => {
				const value = request.result as unknown;
				if (!value || typeof value !== "object") return resolve(null);
				const candidate = value as Partial<StoredIdentity>;
				if (typeof candidate.key !== "string" || typeof candidate.deviceId !== "string" || !candidate.keyPair || !candidate.publicKey) return resolve(null);
				resolve(candidate as StoredIdentity);
			};
			request.onerror = () => reject(request.error ?? new Error("Unable to read device identity"));
		});
	} finally {
		db.close();
	}
}

async function writeIdentity(identity: StoredIdentity): Promise<void> {
	const db = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(identity);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error("Unable to store device identity"));
		});
	} finally {
		db.close();
	}
}

function assertValidIdentity(identity: StoredIdentity): DeviceIdentity {
	if (identity.keyPair.privateKey.type !== "private" || identity.keyPair.privateKey.extractable) {
		throw new Error("Stored device key is not a non-extractable private key");
	}
	return { deviceId: identity.deviceId, keyPair: identity.keyPair, publicKey: identity.publicKey };
}

async function getOrCreateIdentity(config: DeviceAuthConfig): Promise<DeviceIdentity> {
	const key = identityKey(config.host, config.vaultId);
	const existing = await readIdentity(key);
	if (existing) {
		const identity = assertValidIdentity(existing);
		if (config.deviceId !== identity.deviceId) await config.persistDeviceId(identity.deviceId);
		return identity;
	}
	const keyPair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign", "verify"],
	);
	const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const deviceId = config.deviceId || randomBase64Url(18);
	const identity: StoredIdentity = { key, deviceId, keyPair, publicKey };
	await writeIdentity(identity);
	if (config.deviceId !== deviceId) await config.persistDeviceId(deviceId);
	return { deviceId, keyPair, publicKey };
}

function responseError(response: { status: number; json: unknown }): DeviceAuthHttpError {
	const body = response.json as { error?: unknown } | null;
	return new DeviceAuthHttpError(response.status, typeof body?.error === "string" ? body.error : undefined);
}

function normalizeHost(host: string): string {
	let value = host.trim().replace(/\/+$/, "");
	if (!value) throw new Error("Server host is not configured");
	if (!/^https?:\/\//i.test(value)) {
		value = `https://${value}`;
	}
	return value;
}

function normalizeDevicePairingCode(input: string): string {
	let raw = input.trim().toUpperCase();
	if (raw.startsWith("KAOS-") || raw.startsWith("KAOS_") || raw.startsWith("KAOS ")) {
		raw = raw.slice(5);
	} else if (raw.startsWith("KAOS")) {
		raw = raw.slice(4);
	}
	return raw.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "");
}

function challengeMessage(input: { challengeId: string; nonce: string; vaultId: string; deviceId: string; authGeneration: number }): string {
	return `kaos-device-auth-v1|${input.challengeId}|${input.nonce}|${input.vaultId}|${input.deviceId}|${input.authGeneration}`;
}

export class DeviceAuthClient {
	private identityPromise: Promise<DeviceIdentity> | null = null;
	private session: DeviceSession | null = null;
	private sessionPromise: Promise<DeviceSession> | null = null;

	constructor(private readonly config: DeviceAuthConfig) {}

	async getIdentity(): Promise<DeviceIdentity> {
		this.identityPromise ??= getOrCreateIdentity(this.config);
		return this.identityPromise;
	}

	invalidateSession(): void {
		this.session = null;
	}

	async authorizationHeader(force = false): Promise<string> {
		const session = await this.getSession(force);
		return `Bearer ${session.value}`;
	}

	async getSession(force = false): Promise<DeviceSession> {
		if (!force && this.session && this.session.expiresAt - Date.now() > SESSION_REFRESH_BUFFER_MS) return this.session;
		if (this.sessionPromise) return this.sessionPromise;
		this.sessionPromise = this.createSession().finally(() => { this.sessionPromise = null; });
		return this.sessionPromise;
	}

	async pairWithCode(code: string): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }> {
		const identity = await this.getIdentity();
		const cleanCode = normalizeDevicePairingCode(code);
		const response = await this.post("/api/auth/pair", {
			vaultId: this.config.vaultId,
			code: cleanCode,
			device: {
				deviceId: identity.deviceId,
				deviceName: this.requiredDeviceName(),
				publicKey: identity.publicKey,
			},
		});
		if (response.status !== 200) throw responseError(response);
		const body = response.json as { status?: unknown; deviceId?: unknown; fingerprint?: unknown };
		return {
			status: "active",
			deviceId: typeof body.deviceId === "string" ? body.deviceId : identity.deviceId,
			fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : null,
		};
	}

	async pairWithSecret(qrSecret: string): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }> {
		const identity = await this.getIdentity();
		const response = await this.post("/api/auth/pair", {
			vaultId: this.config.vaultId,
			qrSecret,
			device: {
				deviceId: identity.deviceId,
				deviceName: this.requiredDeviceName(),
				publicKey: identity.publicKey,
			},
		});
		if (response.status !== 200) throw responseError(response);
		const body = response.json as { status?: unknown; deviceId?: unknown; fingerprint?: unknown };
		return {
			status: "active",
			deviceId: typeof body.deviceId === "string" ? body.deviceId : identity.deviceId,
			fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : null,
		};
	}

	async createPairingSession(ttlMs = 5 * 60_000): Promise<{ pairingId: string; qrSecret: string; code: string; expiresAt: number }> {
		const response = await this.authenticatedPost(`/vault/${encodeURIComponent(this.config.vaultId)}/devices/pair/create`, { ttlMs });
		if (response.status !== 200) throw responseError(response);
		const body = response.json as { pairingId?: unknown; qrSecret?: unknown; code?: unknown; expiresAt?: unknown };
		if (typeof body.qrSecret !== "string" || typeof body.code !== "string" || typeof body.expiresAt !== "number") {
			throw new Error("pairing session response malformed");
		}
		return {
			pairingId: String(body.pairingId),
			qrSecret: body.qrSecret,
			code: body.code,
			expiresAt: body.expiresAt,
		};
	}

	async recover(recoverySecret: string, nextRecoverySecret: string): Promise<void> {
		const identity = await this.getIdentity();
		const response = await this.post("/api/auth/recover", {
			vaultId: this.config.vaultId,
			recoverySecret,
			nextRecoverySecret,
			deviceId: identity.deviceId,
			deviceName: this.requiredDeviceName(),
			publicKey: identity.publicKey,
		});
		if (response.status !== 200) throw responseError(response);
		this.invalidateSession();
	}

	async listDevices(): Promise<ManagedDevice[]> {
		const response = await this.authenticatedGet(`/vault/${encodeURIComponent(this.config.vaultId)}/devices`);
		if (response.status !== 200) throw responseError(response);
		const body = response.json as { devices?: unknown };
		return Array.isArray(body.devices) ? body.devices.filter((value): value is ManagedDevice => {
			const item = value as Record<string, unknown>;
			return typeof item?.id === "string" && typeof item.name === "string" && typeof item.fingerprint === "string"
				&& (item.role === "owner" || item.role === "member")
				&& (item.status === "active" || item.status === "revoked")
				&& typeof item.createdAt === "number"
				&& (typeof item.lastSeenAt === "number" || item.lastSeenAt === null);
		}) : [];
	}

	async changeDeviceRole(targetDeviceId: string, role: DeviceRole): Promise<void> {
		const response = await this.authenticatedPost(`/vault/${encodeURIComponent(this.config.vaultId)}/devices/role`, { targetDeviceId, role });
		if (response.status !== 200) throw responseError(response);
		this.invalidateSession();
	}

	async revokeDevice(targetDeviceId: string): Promise<void> {
		const response = await this.authenticatedPost(`/vault/${encodeURIComponent(this.config.vaultId)}/devices/revoke`, { targetDeviceId });
		if (response.status !== 200) throw responseError(response);
		this.invalidateSession();
	}

	private async createSession(): Promise<DeviceSession> {
		const identity = await this.getIdentity();
		const challenge = await this.post("/api/auth/challenge", { vaultId: this.config.vaultId, deviceId: identity.deviceId });
		if (challenge.status !== 200) throw responseError(challenge);
		const challengeBody = challenge.json as { challengeId?: unknown; nonce?: unknown; authGeneration?: unknown };
		if (typeof challengeBody.challengeId !== "string" || typeof challengeBody.nonce !== "string" || typeof challengeBody.authGeneration !== "number") throw new Error("challenge response malformed");
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			identity.keyPair.privateKey,
			new TextEncoder().encode(challengeMessage({ challengeId: challengeBody.challengeId, nonce: challengeBody.nonce, vaultId: this.config.vaultId, deviceId: identity.deviceId, authGeneration: challengeBody.authGeneration })),
		);
		const response = await this.post("/api/auth/session", { challengeId: challengeBody.challengeId, signature: bytesToBase64Url(new Uint8Array(signature)) });
		if (response.status !== 200) throw responseError(response);
		const body = response.json as { session?: unknown; expiresAt?: unknown; role?: unknown; deviceId?: unknown };
		if (typeof body.session !== "string" || typeof body.expiresAt !== "number" || (body.role !== "owner" && body.role !== "member") || typeof body.deviceId !== "string") throw new Error("session response malformed");
		this.session = { value: body.session, expiresAt: body.expiresAt, role: body.role, deviceId: body.deviceId };
		return this.session;
	}

	private requiredDeviceName(): string {
		const value = this.config.deviceName.trim();
		if (!value) throw new Error("Device name is required before pairing");
		return value;
	}

	private async authenticatedGet(path: string) {
		return this.request(path, "GET", undefined, { Authorization: await this.authorizationHeader() });
	}

	private async authenticatedPost(path: string, body: Record<string, unknown>) {
		return this.post(path, body, { Authorization: await this.authorizationHeader() });
	}

	private async post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
		return this.request(path, "POST", body, headers);
	}

	private async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>, headers: Record<string, string> = {}) {
		return await obsidianRequest({
			url: `${normalizeHost(this.config.host)}${path}`,
			method,
			headers: body ? { "Content-Type": "application/json", ...headers } : headers,
			body: body ? JSON.stringify(body) : undefined,
		});
	}
}
