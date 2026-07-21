import assert from "node:assert/strict";
import {
	formatHeadlessDoctor,
	formatHeadlessStatus,
	shouldUseHumanOutput,
} from "../src/headless-host/humanOutput";

assert.equal(shouldUseHumanOutput(true, false), true, "TTY defaults to human output");
assert.equal(shouldUseHumanOutput(true, true), false, "--json overrides TTY output");
assert.equal(shouldUseHumanOutput(false, false), false, "pipes keep machine-readable JSON");
assert.equal(shouldUseHumanOutput(undefined, false), false, "unknown terminal state keeps JSON");

const status = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/.obsidian/plugins/kaos",
	lock: { held: true, info: { pid: 42, processAlive: true } },
	configured: {
		host: "https://sync.example",
		vaultId: "vault-id",
		deviceName: "headless-a",
		tokenConfigured: true,
		enableAttachmentSync: true,
	},
});
assert.match(status, /^KAOS Headless Host/m);
assert.match(status, /Runtime\s+running · PID 42/);
assert.match(status, /Token\s+configured/);
assert.doesNotMatch(status, /secret/i, "human status never renders token material");

const incompleteStatus = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/plugins/kaos",
	lock: { held: true, info: { pid: 7, processAlive: false } },
	configured: { tokenConfigured: false, enableAttachmentSync: false },
});
assert.match(incompleteStatus, /Runtime\s+stale lock · PID 7/);
assert.match(incompleteStatus, /Worker\s+not configured/);
assert.match(incompleteStatus, /Attachments\s+disabled/);

const unknownLockStatus = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/plugins/kaos",
	lock: { held: true, info: {} },
	configured: {},
});
assert.match(unknownLockStatus, /Runtime\s+lock present/);
assert.match(unknownLockStatus, /Attachments\s+default/);

const doctor = formatHeadlessDoctor({
	ok: false,
	lock: { held: false },
	checks: [
		{ name: "vault-root-readable", ok: true },
		{ name: "worker-capabilities\nforged", ok: false, detail: "HTTP 503\ntry later" },
	],
});
assert.match(doctor, /^KAOS Headless Doctor — FAIL/m);
assert.match(doctor, /PASS  vault-root-readable/);
assert.match(doctor, /FAIL  worker-capabilities forged — HTTP 503 try later/);
assert.doesNotMatch(doctor, /\nforged|503\ntry/, "control characters are flattened");

const passingDoctor = formatHeadlessDoctor({
	ok: true,
	lock: { held: false },
	checks: [{ name: "local-ready", ok: true, detail: "ready" }],
});
assert.match(passingDoctor, /^KAOS Headless Doctor — PASS/m);
assert.doesNotMatch(passingDoctor, /One or more checks failed/);

console.log("headless-host human output tests passed");
