// Read-only production audit helper (2026-10-05 RCA).
// Mints a device session from the oracle instance identity file and prints a
// bearer token for other audit scripts. Never prints key material.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const identityFile = process.env.KAOS_IDENTITY ?? "/tmp/kaos-audit-identity.json";
const identity = JSON.parse(readFileSync(identityFile, "utf8"));
const { host, vaultId, deviceId, privateKey } = identity;

function bytesToBase64Url(bytes) {
	return Buffer.from(bytes).toString("base64url");
}

async function post(path, body, headers = {}) {
	const res = await fetch(`${host}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => null);
	return { status: res.status, json };
}

const key = await webcrypto.subtle.importKey(
	"jwk",
	privateKey,
	{ name: "ECDSA", namedCurve: "P-256" },
	false,
	["sign"],
);

const challenge = await post("/api/auth/challenge", { vaultId, deviceId });
if (challenge.status !== 200) {
	console.error("challenge failed", challenge.status, challenge.json);
	process.exit(1);
}
const { challengeId, nonce, authGeneration } = challenge.json;
const message = `kaos-device-auth-v1|${challengeId}|${nonce}|${vaultId}|${deviceId}|${authGeneration}`;
const signature = await webcrypto.subtle.sign(
	{ name: "ECDSA", hash: "SHA-256" },
	key,
	new TextEncoder().encode(message),
);
const session = await post("/api/auth/session", {
	challengeId,
	signature: bytesToBase64Url(new Uint8Array(signature)),
});
if (session.status !== 200) {
	console.error("session failed", session.status, session.json);
	process.exit(1);
}
console.log(
	JSON.stringify({
		host,
		vaultId,
		deviceId,
		role: session.json.role,
		expiresAt: new Date(session.json.expiresAt).toISOString(),
		bearer: session.json.session,
	}),
);
