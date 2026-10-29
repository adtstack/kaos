import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import WebSocket from "ws";

const HOST = "http://127.0.0.1:8787";
const VAULT_ID = `kaos-integration-${Date.now().toString(36)}`;
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");

function wait(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForWorker() {
	const deadline = Date.now() + 20_000;
	const probeUrl = `${HOST}/api/capabilities`;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(probeUrl, { method: "GET" });
			if (res.status > 0) return;
		} catch {
			// Worker not accepting connections yet.
		}
		await wait(250);
	}

	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

async function sampleOwnerDevice() {
	const crypto = globalThis.crypto ?? webcrypto;
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return {
		deviceId: `integration-owner-${Date.now().toString(36)}`,
		deviceName: "Integration Owner",
		publicKey,
		keyPair: pair,
	};
}

async function main() {
	const persistDir = mkdtempSync(resolve(tmpdir(), "kaos-wrangler-"));
	const claimSecret = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		[
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			"8787",
			"--local-protocol",
			"http",
			"--persist-to",
			persistDir,
			"--log-level",
			"error",
			"--var",
			`KAOS_CLAIM_SECRET:${claimSecret}`,
		],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			},
		},
	);
	const wranglerExit = new Promise((resolvePromise) => {
		wrangler.once("exit", resolvePromise);
	});

	let output = "";
	const providers = [];
	const docs = [];
	const capture = (chunk) => {
		output += chunk.toString();
		if (output.length > 8_000) {
			output = output.slice(-8_000);
		}
	};
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	try {
		console.log("\n--- worker integration: wait for live worker ---");
		await waitForWorker();
		console.log("  PASS  wrangler dev accepted connections");

		console.log("\n--- worker integration: pre-claim capabilities ---");
		const initialCaps = await fetch(`${HOST}/api/capabilities`).then((res) => res.json());
		assert.equal(initialCaps.claimed, false, "initial state must be unclaimed");
		console.log("  PASS  unclaimed state advertised");

		console.log("\n--- worker integration: claim hardening ---");
		const plainTextRes = await fetch(`${HOST}/claim`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
				"X-KAOS-Claim-Proof": claimSecret,
			},
			body: JSON.stringify({ vaultId: VAULT_ID }),
		});
		assert.equal(plainTextRes.status, 415, "claim must reject text/plain");

		const missingProofRes = await fetch(`${HOST}/claim`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vaultId: VAULT_ID }),
		});
		assert.equal(missingProofRes.status, 403, "claim must require proof header");

		const crossOriginRes = await fetch(`${HOST}/claim`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Origin": "https://attacker.example",
				"X-KAOS-Claim-Proof": claimSecret,
			},
			body: JSON.stringify({ vaultId: VAULT_ID }),
		});
		assert.equal(crossOriginRes.status, 403, "claim must reject cross-origin requests");
		console.log("  PASS  claim hardening passed");

		console.log("\n--- worker integration: valid claim with owner device ---");
		const owner = await sampleOwnerDevice();
		const claimRes = await fetch(`${HOST}/claim`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Origin": HOST,
				"X-KAOS-Claim-Proof": claimSecret,
			},
			body: JSON.stringify({
				vaultId: VAULT_ID,
				ownerDevice: {
					deviceId: owner.deviceId,
					deviceName: owner.deviceName,
					publicKey: owner.publicKey,
				},
			}),
		});
		assert.equal(claimRes.status, 200, `claim status ${claimRes.status}`);
		const payload = await claimRes.json();
		assert.equal(payload.ok, true, "claim response must be ok");
		assert.equal(payload.vaultId, VAULT_ID, "vaultId must match");
		assert.equal(typeof payload.recoverySecret, "string", "recoverySecret must be returned");
		assert.ok(payload.recoverySecret.length >= 32, "recoverySecret must be sufficiently long");
		assert.ok(!JSON.stringify(payload).includes(claimSecret), "claim secret must not leak");
		console.log("  PASS  server claimed and owner device registered");

		console.log("\n--- worker integration: post-claim capabilities ---");
		const claimedCaps = await fetch(`${HOST}/api/capabilities`).then((res) => res.json());
		assert.equal(claimedCaps.claimed, true, "server must be claimed");
		assert.equal(claimedCaps.authMode, "device", "authMode must be device");
		console.log("  PASS  claimed capabilities advertised");

		console.log("\n--- worker integration: double-claim rejected ---");
		const reClaimRes = await fetch(`${HOST}/claim`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Origin": HOST,
				"X-KAOS-Claim-Proof": claimSecret,
			},
			body: JSON.stringify({ vaultId: VAULT_ID }),
		});
		assert.equal(reClaimRes.status, 403, "re-claim must be rejected with 403");
		console.log("  PASS  already-claimed protection verified");

		console.log("\n--- worker integration: authenticated server file repair ---");
		const challenge = await fetch(`${HOST}/api/auth/challenge`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vaultId: VAULT_ID, deviceId: owner.deviceId }),
		}).then((res) => res.json());
		const message = `kaos-device-auth-v1|${challenge.challengeId}|${challenge.nonce}|${VAULT_ID}|${owner.deviceId}|${challenge.authGeneration}`;
		const signature = await (globalThis.crypto ?? webcrypto).subtle.sign({ name: "ECDSA", hash: "SHA-256" }, owner.keyPair.privateKey, new TextEncoder().encode(message));
		const sessionResponse = await fetch(`${HOST}/api/auth/session`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId, signature: Buffer.from(signature).toString("base64url") }),
		});
		assert.equal(sessionResponse.status, 200);
		const session = (await sessionResponse.json()).session;
		const headers = { Authorization: `Bearer ${session}` };
		const openProvider = async (doc) => {
			const ticketResponse = await fetch(`${HOST}/vault/${VAULT_ID}/auth/ticket`, { method: "POST", headers });
			assert.equal(ticketResponse.status, 200);
			const ticket = (await ticketResponse.json()).ticket;
			class TicketWebSocket extends WebSocket { constructor(url) { super(url, [`kaos-ticket.${ticket}`]); } }
			const provider = new YProvider(HOST, VAULT_ID, doc, { prefix: `/vault/sync/${VAULT_ID}`, params: { schemaVersion: "4" }, WebSocketPolyfill: TicketWebSocket, disableBc: true, connect: false });
			providers.push(provider); await provider.connect(); return provider;
		};
		const seed = new Y.Doc(); docs.push(seed);
		seed.getMap("sys").set("schemaVersion", 4);
		seed.getMap("meta").set("repair-file", new Y.Map([["path", "repair.md"]]));
		seed.getMap("idToText").set("repair-file", new Y.Text("server A"));
		const seedProvider = await openProvider(seed);
		const repairUrl = `${HOST}/vault/${VAULT_ID}/file-repair?path=repair.md`;
		let selected;
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			const response = await fetch(repairUrl, { headers });
			if (response.ok) { selected = await response.json(); if (selected.kind === "text" && selected.content === "server A") break; }
			await wait(50);
		}
		assert.equal(selected?.content, "server A");
		seedProvider.disconnect();
		const observer = new Y.Doc(); docs.push(observer); await openProvider(observer);
		const observerDeadline = Date.now() + 10000;
		while (observer.getMap("idToText").get("repair-file")?.toString() !== "server A" && Date.now() < observerDeadline) await wait(50);
		assert.equal(observer.getMap("idToText").get("repair-file")?.toString(), "server A");
		const observed = [];
		observer.on("update", () => observed.push(observer.getMap("idToText").get("repair-file")?.toString()));
		const localText = seed.getMap("idToText").get("repair-file");
		localText.delete(0, localText.length); localText.insert(0, "unsent B");
		selected = await fetch(repairUrl, { headers }).then((res) => res.json());
		assert.equal(selected.content, "server A", "HTTP read excludes unsent local edits");
		assert.equal((await fetch(repairUrl)).status, 401, "server file reads require device authorization");
		const repaired = await fetch(repairUrl, { method: "POST", headers: { ...headers, "X-KAOS-Repair-Token": selected.token }, body: Y.encodeStateAsUpdate(seed) });
		assert.equal(repaired.status, 200, `repair failed: ${repaired.status}`);
		assert.equal(repaired.headers.get("X-KAOS-File-Repair"), "1");
		Y.applyUpdate(seed, new Uint8Array(await repaired.arrayBuffer()));
		assert.equal(localText.toString(), "server A");
		await wait(100);
		assert.ok(observed.length > 0 && observed.every((value) => value === "server A"), "connected peer never sees discarded text");
		const stale = await fetch(repairUrl, { method: "POST", headers: { ...headers, "X-KAOS-Repair-Token": selected.token }, body: Y.encodeStateAsUpdate(seed) });
		assert.equal(stale.status, 409, "stale selection does not mutate the server");
		console.log("  PASS  HTTP server read, atomic persisted repair, peer broadcast and stale-selection rejection");

		console.log("\n--- worker integration: all live worker tests passed ---");
	} catch (err) {
		if (output.trim()) {
			console.error("\n[wrangler output]");
			console.error(output.trim());
		}
		throw err;
	} finally {
		for (const provider of providers) provider.destroy();
		for (const doc of docs) doc.destroy();
		if (wrangler.exitCode === null) {
			wrangler.kill("SIGTERM");
		}
		await wranglerExit;
		rmSync(persistDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
