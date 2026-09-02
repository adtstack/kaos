import { webcrypto } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, parse, resolve, join } from "node:path";
import process from "node:process";
import { bytesToBase64Url, randomBase64Url } from "../../utils/base64url";

const IDENTITY_VERSION = 1;
const SESSION_REFRESH_BUFFER_MS = 30_000;

export interface HeadlessDeviceIdentity {
	version: number;
	deviceId: string;
	host: string;
	vaultId: string;
	privateKey: JsonWebKey;
	publicKey: JsonWebKey;
}

export interface HeadlessDeviceAuthConfig {
	host: string;
	vaultId: string;
	deviceName: string;
	deviceId: string;
	identityFile: string;
	persistDeviceId(deviceId: string): Promise<void>;
}

export interface HeadlessDeviceSession {
	value: string;
	expiresAt: number;
	role: "owner" | "member";
	deviceId: string;
}

function normalizedHost(host: string): string {
	const value = host.trim().replace(/\/$/, "");
	if (!value) throw new Error("Server host is required.");
	return value;
}

function currentUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

function isAllowedOwner(uid: number): boolean {
	const own = currentUid();
	return uid === 0 || own === null || uid === own;
}

/**
 * Resolve system-level aliases such as macOS /var before checking ownership
 * and permissions. The returned canonical parent is also used for I/O so a
 * checked parent cannot be swapped through the caller's path spelling.
 */
async function secureParentDirectory(path: string): Promise<string> {
	const canonicalParent = await realpath(dirname(resolve(path)));
	let cursor = canonicalParent;
	for (;;) {
		const details = await lstat(cursor);
		if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Unsafe identity directory: ${cursor}`);
		const isStickySystemDir = (details.mode & 0o1000) !== 0 && details.uid === 0;
		if ((details.mode & 0o022) !== 0 && !isStickySystemDir) {
			throw new Error(`Identity directory must not be writable by group or others: ${cursor}`);
		}
		if (!isAllowedOwner(details.uid)) throw new Error(`Identity directory is not owned by this account: ${cursor}`);
		const parent = dirname(cursor);
		if (parent === cursor || cursor === parse(cursor).root) return canonicalParent;
		cursor = parent;
	}
}

async function protectedFilePath(path: string): Promise<string> {
	const absolute = resolve(path);
	const parent = await secureParentDirectory(absolute);
	return join(parent, basename(absolute));
}

/** Reject links, non-files, loose mode bits, and unsafe parent directories. */
export async function assertSecurePrivateFile(path: string): Promise<void> {
	const protectedPath = await protectedFilePath(path);
	const details = await lstat(protectedPath);
	if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Identity file must be a regular file, not a symbolic link: ${protectedPath}`);
	if ((details.mode & 0o077) !== 0) throw new Error(`Identity file must have mode 0600: ${protectedPath}`);
	if (!isAllowedOwner(details.uid)) throw new Error(`Identity file is not owned by this account: ${protectedPath}`);
}

export async function readProtectedTextFile(path: string): Promise<string> {
	await assertSecurePrivateFile(path);
	const value = (await readFile(await protectedFilePath(path), "utf8")).trim();
	if (!value) throw new Error("Protected file is empty.");
	return value;
}

async function writeNewProtectedFile(path: string, content: string): Promise<void> {
	const protectedPath = await protectedFilePath(path);
	let handle;
	try {
		handle = await open(protectedPath, "wx", 0o600);
		await handle.chmod(0o600);
		await handle.writeFile(content, "utf8");
	} finally {
		await handle?.close();
	}
}

function validIdentity(value: unknown): value is HeadlessDeviceIdentity {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<HeadlessDeviceIdentity>;
	return item.version === IDENTITY_VERSION
		&& typeof item.deviceId === "string" && item.deviceId.length >= 16
		&& typeof item.host === "string" && typeof item.vaultId === "string"
		&& typeof item.privateKey === "object" && item.privateKey !== null
		&& typeof item.publicKey === "object" && item.publicKey !== null;
}

export async function readHeadlessDeviceIdentity(path: string): Promise<HeadlessDeviceIdentity> {
	const text = await readProtectedTextFile(path);
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { throw new Error("Identity file is not valid JSON."); }
	if (!validIdentity(parsed)) throw new Error("Identity file is malformed.");
	return parsed;
}

export async function createHeadlessDeviceIdentity(input: {
	identityFile: string;
	host: string;
	vaultId: string;
}): Promise<HeadlessDeviceIdentity> {
	const host = normalizedHost(input.host);
	const vaultId = input.vaultId.trim();
	if (!vaultId) throw new Error("Vault ID is required.");
	const crypto = globalThis.crypto ?? webcrypto;
	const keyPair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const identity: HeadlessDeviceIdentity = {
		version: IDENTITY_VERSION,
		deviceId: randomBase64Url(18),
		host,
		vaultId,
		privateKey: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
		publicKey: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
	};
	await writeNewProtectedFile(input.identityFile, `${JSON.stringify(identity)}\n`);
	return identity;
}

export async function writeNewRecoverySecret(path: string): Promise<string> {
	const secret = randomBase64Url(48);
	await writeNewProtectedFile(path, `${secret}\n`);
	return secret;
}

function challengeMessage(input: { challengeId: string; nonce: string; vaultId: string; deviceId: string; authGeneration: number }): string {
	return `kaos-device-auth-v1|${input.challengeId}|${input.nonce}|${input.vaultId}|${input.deviceId}|${input.authGeneration}`;
}

async function postJson(host: string, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${normalizedHost(host)}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	let payload: Record<string, unknown> = {};
	try {
		const candidate: unknown = await response.json();
		if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) payload = candidate as Record<string, unknown>;
	} catch { /* Status is enough for a safe CLI error. */ }
	return { status: response.status, body: payload };
}

function errorFor(response: { status: number; body: Record<string, unknown> }): Error {
	const error = typeof response.body.error === "string" ? response.body.error : "request_failed";
	return new Error(`Device authentication request rejected (${response.status}): ${error}`);
}

export async function requestHeadlessEnrollment(input: {
	identity: HeadlessDeviceIdentity;
	deviceName: string;
	invite?: string;
	code?: string;
	qrSecret?: string;
}): Promise<{ status: "active"; fingerprint: string | null }> {
	const code = input.code || (!input.qrSecret && input.invite ? input.invite : undefined);
	const qrSecret = input.qrSecret || (input.invite && input.invite.length >= 32 ? input.invite : undefined);
	const response = await postJson(input.identity.host, "/api/auth/pair", {
		vaultId: input.identity.vaultId,
		code,
		qrSecret,
		device: {
			deviceId: input.identity.deviceId,
			deviceName: input.deviceName,
			publicKey: input.identity.publicKey,
		},
	});
	if (response.status !== 200) throw errorFor(response);
	const fingerprint = typeof response.body.fingerprint === "string" ? response.body.fingerprint : null;
	return { status: "active", fingerprint };
}

export async function requestHeadlessRecovery(input: {
	identity: HeadlessDeviceIdentity;
	deviceName: string;
	recoverySecret: string;
	nextRecoverySecret: string;
}): Promise<void> {
	const response = await postJson(input.identity.host, "/api/auth/recover", {
		vaultId: input.identity.vaultId,
		recoverySecret: input.recoverySecret,
		nextRecoverySecret: input.nextRecoverySecret,
		deviceId: input.identity.deviceId,
		deviceName: input.deviceName,
		publicKey: input.identity.publicKey,
	});
	if (response.status !== 200) throw errorFor(response);
}

/** Runtime bridge used by the real plugin only after headless boot installs it. */
export class HeadlessDeviceAuthClient {
	private identityPromise: Promise<HeadlessDeviceIdentity> | null = null;
	private session: HeadlessDeviceSession | null = null;
	private sessionPromise: Promise<HeadlessDeviceSession> | null = null;

	constructor(private readonly config: HeadlessDeviceAuthConfig) {}

	async authorizationHeader(force = false): Promise<string> {
		const session = await this.getSession(force);
		return `Bearer ${session.value}`;
	}

	invalidateSession(): void { this.session = null; }

	async getSession(force = false): Promise<HeadlessDeviceSession> {
		if (!force && this.session && this.session.expiresAt - Date.now() > SESSION_REFRESH_BUFFER_MS) return this.session;
		if (this.sessionPromise) return this.sessionPromise;
		this.sessionPromise = this.createSession().finally(() => { this.sessionPromise = null; });
		return this.sessionPromise;
	}

	private async identity(): Promise<HeadlessDeviceIdentity> {
		this.identityPromise ??= readHeadlessDeviceIdentity(this.config.identityFile);
		const identity = await this.identityPromise;
		if (identity.host !== normalizedHost(this.config.host) || identity.vaultId !== this.config.vaultId.trim()) {
			throw new Error("Identity file belongs to a different server or vault.");
		}
		if (this.config.deviceId && this.config.deviceId !== identity.deviceId) {
			throw new Error("Configured device ID does not match the protected identity file.");
		}
		if (!this.config.deviceId) await this.config.persistDeviceId(identity.deviceId);
		return identity;
	}

	private async createSession(): Promise<HeadlessDeviceSession> {
		const identity = await this.identity();
		const challenge = await postJson(identity.host, "/api/auth/challenge", {
			vaultId: identity.vaultId,
			deviceId: identity.deviceId,
		});
		if (challenge.status !== 200) throw errorFor(challenge);
		const challengeId = challenge.body.challengeId;
		const nonce = challenge.body.nonce;
		const authGeneration = challenge.body.authGeneration;
		if (typeof challengeId !== "string" || typeof nonce !== "string" || typeof authGeneration !== "number") throw new Error("Malformed device challenge.");
		const crypto = globalThis.crypto ?? webcrypto;
		const privateKey = await crypto.subtle.importKey("jwk", identity.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			privateKey,
			new TextEncoder().encode(challengeMessage({ challengeId, nonce, vaultId: identity.vaultId, deviceId: identity.deviceId, authGeneration })),
		);
		const response = await postJson(identity.host, "/api/auth/session", {
			challengeId,
			signature: bytesToBase64Url(new Uint8Array(signature)),
		});
		if (response.status !== 200) throw errorFor(response);
		const session = response.body.session;
		const expiresAt = response.body.expiresAt;
		const role = response.body.role;
		const deviceId = response.body.deviceId;
		if (typeof session !== "string" || typeof expiresAt !== "number" || (role !== "owner" && role !== "member") || typeof deviceId !== "string") throw new Error("Malformed device session.");
		this.session = { value: session, expiresAt, role, deviceId };
		return this.session;
	}
}

/** Deliberately global: main.js runs as an independently compiled plugin. */
export function installHeadlessDeviceAuthFactory(): void {
	(globalThis as unknown as Record<string, unknown>).__KAOS_HEADLESS_DEVICE_AUTH_FACTORY__ = {
		create: (config: HeadlessDeviceAuthConfig) => new HeadlessDeviceAuthClient(config),
	};
}
