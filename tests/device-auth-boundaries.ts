import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSocketTicketFromProtocol } from "../server/src/routes/socketTicketProtocol";
import { runHeadlessHostCli } from "../src/headless-host/cli";
import { assertSecurePrivateFile, createHeadlessDeviceIdentity, readProtectedTextFile, writeNewRecoverySecret } from "../src/headless-host/kaos/deviceIdentity";
import { SettingsStore } from "../src/settings/settingsStore";

const ticket = "a".repeat(43);

console.log("\n--- device auth boundary checks ---");

assert.equal(
	getSocketTicketFromProtocol(new Request("https://sync.example/vault/sync/vault-device-auth-1?ticket=" + ticket, { headers: { Upgrade: "websocket" } })),
	null,
	"a URL ticket is never accepted",
);
assert.equal(
	getSocketTicketFromProtocol(new Request("https://sync.example/vault/sync/vault-device-auth-1?token=legacy-value", { headers: { Upgrade: "websocket" } })),
	null,
	"a legacy URL bearer is never accepted",
);
assert.equal(
	getSocketTicketFromProtocol(new Request("https://sync.example/vault/sync/vault-device-auth-1", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `kaos-ticket.${ticket}` } })),
	ticket,
	"one subprotocol ticket is accepted",
);
assert.equal(
	getSocketTicketFromProtocol(new Request("https://sync.example/vault/sync/vault-device-auth-1", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `kaos-ticket.${ticket}, kaos-ticket.${"b".repeat(43)}` } })),
	null,
	"multiple ticket protocols are rejected",
);

const persistence = {
	saved: null as unknown,
	async loadData(): Promise<unknown> { return { token: "legacy-token-value", host: "https://sync.example" }; },
	async saveData(value: unknown): Promise<void> { this.saved = value; },
};
const settingsStore = new SettingsStore(persistence);
const loaded = await settingsStore.load();
assert.equal(loaded.legacyMigrationToken, "legacy-token-value", "legacy token is available only for the one in-memory enrollment request");
assert.equal("token" in loaded.persistedState, false, "legacy token is removed from loaded durable state");
await settingsStore.save({ token: "must-not-persist" } as never);
assert.equal("token" in (persistence.saved as Record<string, unknown>), false, "direct settings saves cannot restore a bearer token");
await assert.rejects(runHeadlessHostCli(["--token", "must-not-accept"]), /no longer supported/, "terminal --token is rejected before sync starts");
const previousLegacyEnvironment = process.env.KAOS_SYNC_TOKEN;
process.env.KAOS_SYNC_TOKEN = "must-not-accept";
try {
	await assert.rejects(runHeadlessHostCli(["--status"]), /KAOS_SYNC_TOKEN/, "terminal legacy-token environment variables are rejected before any command runs");
} finally {
	if (previousLegacyEnvironment === undefined) delete process.env.KAOS_SYNC_TOKEN;
	else process.env.KAOS_SYNC_TOKEN = previousLegacyEnvironment;
}
const cliSource = await readFile("src/headless-host/cli.ts", "utf8");
const headlessAuthSource = await readFile("src/headless-host/kaos/deviceIdentity.ts", "utf8");
assert.match(cliSource, /kind: "device-enrollment"|log\("device-enrollment"/, "enrollment emits a safe approval record");
assert.match(headlessAuthSource, /\/api\/auth\/pair/, "headless device authentication calls pair endpoint");
for (const servicePath of ["deploy/kaos-headless-host.service", "deploy/kaos-headless-host.user.service"]) {
	const service = await readFile(servicePath, "utf8");
	assert.equal(/--token(?:\b|-)|KAOS_SYNC_TOKEN|SYNC_TOKEN/.test(service), false, `${servicePath} starts the host without a shared token path`);
}

const directory = await mkdtemp(join(tmpdir(), "kaos-device-auth-"));
const identityFile = join(directory, "identity.json");
const recoveryFile = join(directory, "recovery.txt");
await createHeadlessDeviceIdentity({ identityFile, host: "https://sync.example", vaultId: "vault-device-auth-1" });
await writeNewRecoverySecret(recoveryFile);
await assertSecurePrivateFile(identityFile);
await assertSecurePrivateFile(recoveryFile);
assert.ok((await readProtectedTextFile(recoveryFile)).length >= 64, "recovery value is high entropy and readable only through the protected-file gate");

await chmod(identityFile, 0o640);
await assert.rejects(assertSecurePrivateFile(identityFile), /mode 0600/, "group-readable identity files are rejected");
await chmod(identityFile, 0o600);
const link = join(directory, "identity-link.json");
await symlink(identityFile, link);
await assert.rejects(assertSecurePrivateFile(link), /symbolic link/, "symbolic-link identity files are rejected");
const plain = join(directory, "plain.txt");
await writeFile(plain, "not an identity\n", { mode: 0o600 });
await assertSecurePrivateFile(plain);
const unsafeDirectory = join(directory, "unsafe-parent");
await mkdir(unsafeDirectory, { mode: 0o700 });
const unsafeIdentity = join(unsafeDirectory, "identity.json");
await writeFile(unsafeIdentity, "{}\n", { mode: 0o600 });
await chmod(unsafeDirectory, 0o770);
await assert.rejects(assertSecurePrivateFile(unsafeIdentity), /writable by group or others/, "identity files below unsafe parent directories are rejected");

console.log("  PASS  URL tickets and unsafe terminal identity/recovery files are rejected");
