import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { ServerConfig } from "../server/src/config";
import { sha256Hex } from "../server/src/hex";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

class MemoryStorage {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined>;
	async get<T>(keys: string[]): Promise<Map<string, T>>;
	async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(key)) {
			return new Map(key.map((entry) => [entry, this.values.get(entry) as T]));
		}
		return this.values.get(key) as T | undefined;
	}

	async put(entries: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
	}

	async delete(keys: string | string[]): Promise<void> {
		for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
	}

	async transaction<T>(callback: (storage: this) => Promise<T>): Promise<T> {
		return await callback(this);
	}

	setForTest(key: string, value: unknown): void { this.values.set(key, value); }
}

const VAULT_ID = "vault-device-auth-1";
const OWNER_ID = "owner-device-123456";
const MEMBER_ID = "member-device-12345";
const RECOVERY_SECRET = "recovery-secret-0123456789abcdef";

const storage = new MemoryStorage();
const server = new ServerConfig({ storage } as unknown as DurableObjectState);

async function digest(value: string): Promise<string> {
	return await sha256Hex(new TextEncoder().encode(value));
}

async function call(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await server.fetch(new Request(`https://internal${path}`, {
		method: path === "/__kaos/config" ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: path === "/__kaos/config" ? undefined : JSON.stringify(body),
	}));
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function publicKey(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
	return { privateKey: pair.privateKey, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function sessionFor(input: { deviceId: string; privateKey: CryptoKey }): Promise<string> {
	const challenge = await call("/__kaos/auth/challenge", { vaultId: VAULT_ID, deviceId: input.deviceId });
	assert.equal(challenge.status, 200);
	const challengeId = challenge.body.challengeId as string;
	const nonce = challenge.body.nonce as string;
	const generation = challenge.body.authGeneration as number;
	const message = `kaos-device-auth-v1|${challengeId}|${nonce}|${VAULT_ID}|${input.deviceId}|${generation}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.privateKey, new TextEncoder().encode(message));
	const raw = Buffer.from(signature).toString("base64url");
	const session = await call("/__kaos/auth/session", { challengeId, signature: raw });
	assert.equal(session.status, 200);
	assert.equal(typeof session.body.session, "string");
	return session.body.session as string;
}

console.log("\n--- device auth Config Durable Object ---");
const owner = await publicKey();
const member = await publicKey();

// 1. Initial Claim registers first Owner directly
const claim = await call("/__kaos/claim", {
	vaultId: VAULT_ID,
	recoverySecretHash: await digest(RECOVERY_SECRET),
	ownerDevice: {
		deviceId: OWNER_ID,
		deviceName: "Initial Owner Device",
		publicKey: owner.publicJwk,
	},
});
assert.equal(claim.status, 200, "claim creates initial active Owner device");

// 2. Owner can authenticate immediately
let ownerSession = await sessionFor({ deviceId: OWNER_ID, privateKey: owner.privateKey });
assert.ok(ownerSession, "Owner session created");

// 3. Owner creates a pairing code & qrSecret
const pairing = await call("/__kaos/devices/pair/create", { vaultId: VAULT_ID, session: ownerSession, ttlMs: 60_000 });
assert.equal(pairing.status, 200, "Owner can create a pairing session");
const qrSecret = pairing.body.qrSecret as string;
const rawCode = pairing.body.rawCode as string;
assert.ok(qrSecret && rawCode, "Pairing returned secrets");

// 4. Candidate device pairs with QR secret
const memberPair = await call("/__kaos/auth/pair", {
	vaultId: VAULT_ID,
	qrSecret,
	device: {
		deviceId: MEMBER_ID,
		deviceName: "Mobile Member",
		publicKey: member.publicJwk,
	},
});
assert.equal(memberPair.status, 200, "pairing succeeds");
assert.equal(memberPair.body.status, "active", "paired device is immediately active");

// 5. Pairing secret cannot be reused
assert.equal((await call("/__kaos/auth/pair", {
	vaultId: VAULT_ID,
	qrSecret,
	device: {
		deviceId: "reused-device-id",
		deviceName: "Reused",
		publicKey: member.publicJwk,
	},
})).status, 403, "pairing secret is single-use");

// 6. Test Pairing with 6-digit Code
const codePairing = await call("/__kaos/devices/pair/create", { vaultId: VAULT_ID, session: ownerSession, ttlMs: 60_000 });
assert.equal(codePairing.status, 200);
const desktopMember = await publicKey();
const desktopMemberId = "desktop-member-12345";
const codePairRes = await call("/__kaos/auth/pair", {
	vaultId: VAULT_ID,
	code: codePairing.body.rawCode as string,
	device: {
		deviceId: desktopMemberId,
		deviceName: "Desktop PC",
		publicKey: desktopMember.publicJwk,
	},
});
assert.equal(codePairRes.status, 200, "pairing with code succeeds");
assert.equal(codePairRes.body.status, "active");

// 7. Security validations on public key
const badPairing = await call("/__kaos/devices/pair/create", { vaultId: VAULT_ID, session: ownerSession, ttlMs: 60_000 });
assert.equal((await call("/__kaos/auth/pair", {
	vaultId: VAULT_ID,
	code: badPairing.body.code as string,
	device: {
		deviceId: "bad-jwk-device",
		deviceName: "Bad JWK",
		publicKey: { ...member.publicJwk, d: "must-not-store-private-key" },
	},
})).status, 400, "private JWK material rejected");

// 8. Member authentication and tickets
let memberSession = await sessionFor({ deviceId: MEMBER_ID, privateKey: member.privateKey });
assert.equal((await call("/__kaos/devices/pair/create", { vaultId: VAULT_ID, session: memberSession })).status, 403, "Member cannot create pairings");

const ticket = await call("/__kaos/auth/ticket", { vaultId: VAULT_ID, session: memberSession });
assert.equal(ticket.status, 200);
assert.equal((await call("/__kaos/auth/consume-ticket", { vaultId: VAULT_ID, ticket: ticket.body.ticket })).status, 200, "ticket can be consumed once");
assert.equal((await call("/__kaos/auth/consume-ticket", { vaultId: VAULT_ID, ticket: ticket.body.ticket })).status, 401, "ticket reuse is rejected");

// 9. Role change: promote to owner
assert.equal((await call("/__kaos/devices/role", {
	vaultId: VAULT_ID, session: ownerSession, targetDeviceId: MEMBER_ID, role: "owner",
})).status, 200, "Owner can promote Member to Owner");
ownerSession = await sessionFor({ deviceId: OWNER_ID, privateKey: owner.privateKey });
memberSession = await sessionFor({ deviceId: MEMBER_ID, privateKey: member.privateKey });

// 10. Role change: demote back to member
assert.equal((await call("/__kaos/devices/role", {
	vaultId: VAULT_ID, session: ownerSession, targetDeviceId: MEMBER_ID, role: "member",
})).status, 200, "Owner can demote back to Member");
ownerSession = await sessionFor({ deviceId: OWNER_ID, privateKey: owner.privateKey });
memberSession = await sessionFor({ deviceId: MEMBER_ID, privateKey: member.privateKey });

// 11. Final owner cannot be demoted
assert.equal((await call("/__kaos/devices/role", {
	vaultId: VAULT_ID, session: ownerSession, targetDeviceId: OWNER_ID, role: "member",
})).status, 409, "final Owner cannot be demoted");

// 12. Revocation
const staleTicket = await call("/__kaos/auth/ticket", { vaultId: VAULT_ID, session: memberSession });
assert.equal((await call("/__kaos/devices/revoke", {
	vaultId: VAULT_ID, session: ownerSession, targetDeviceId: MEMBER_ID,
})).status, 200, "Owner can revoke Member");
assert.equal((await call("/__kaos/auth/validate-session", { vaultId: VAULT_ID, session: memberSession })).status, 401, "revocation invalidates active HTTP session");
assert.equal((await call("/__kaos/auth/consume-ticket", { vaultId: VAULT_ID, ticket: staleTicket.body.ticket })).status, 401, "revocation invalidates outstanding WebSocket ticket");

// 13. Recovery rotates to new Owner
const oldOwnerTicket = await call("/__kaos/auth/ticket", { vaultId: VAULT_ID, session: ownerSession });
const recoveredOwner = await publicKey();
assert.equal((await call("/__kaos/auth/recover", {
	recoveryVerified: true,
	nextRecoverySecretHash: await digest("rotated-recovery-secret-0123456789abcdef"),
	vaultId: VAULT_ID,
	deviceId: OWNER_ID,
	deviceName: "Recovered Owner",
	publicKey: recoveredOwner.publicJwk,
})).status, 200, "recovery rotates to a new Owner");
assert.equal((await call("/__kaos/auth/validate-session", { vaultId: VAULT_ID, session: ownerSession })).status, 401, "recovery invalidates all existing sessions");
assert.equal((await call("/__kaos/auth/consume-ticket", { vaultId: VAULT_ID, ticket: oldOwnerTicket.body.ticket })).status, 401, "recovery invalidates all outstanding tickets");
assert.equal(typeof await sessionFor({ deviceId: OWNER_ID, privateKey: recoveredOwner.privateKey }), "string", "recovery device can authenticate");

console.log("  PASS  instant pairing, roles, ticket single-use, revocation, recovery, and vault scope");
