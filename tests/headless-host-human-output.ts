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
		identityFileConfigured: true,
		enableAttachmentSync: true,
	},
});
assert.match(status, /^KAOS Headless Host/m);
assert.match(status, /Runtime\s+running · PID 42/);
assert.match(status, /Device key\s+configured/);
assert.doesNotMatch(status, /secret|token/i, "human status never renders credential material");

const incompleteStatus = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/plugins/kaos",
	lock: { held: true, info: { pid: 7, processAlive: false } },
	configured: { identityFileConfigured: false, enableAttachmentSync: false },
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

const liveStatus = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/plugins/kaos",
	lock: { held: true, info: { pid: 100, processAlive: true } },
	configured: {
		host: "https://sync.example",
		vaultId: "vault-id",
		deviceName: "headless-live",
		identityFileConfigured: true,
		enableAttachmentSync: true,
	},
	live: {
		daemon: {
			alive: true,
			uptimeSeconds: 150,
			memoryRssBytes: 52428800,
		},
		connection: {
			status: "connected",
			rttMs: 35,
		},
		sync: {
			serverAppliedLocalState: true,
			reconcileInFlight: true,
			activeMarkdownPathsCount: 42,
		},
		attention: {
			totalCount: 3,
			items: [],
			providerExcludeError: null,
		},
		attachments: {
			enabled: true,
			transferStatus: null,
			pendingUploads: 2,
			pendingDownloads: 1,
		},
	},
});
assert.match(liveStatus, /Runtime\s+running · PID 100 \(uptime 2m · 50MB\)/);
assert.match(liveStatus, /Sync status\s+connected · RTT 35ms/);
assert.match(liveStatus, /Sync state\s+in-sync, reconciling, 42 tracked files/);
assert.match(liveStatus, /Attention\s+3 items needing review/);
assert.match(liveStatus, /Attachments\s+enabled · pending: ↑2 ↓1/);

const cleanLiveStatus = formatHeadlessStatus({
	vaultRoot: "/vault",
	dataFile: "/vault/data.json",
	lockFile: "/run/kaos.lock",
	pluginDir: "/vault/plugins/kaos",
	lock: { held: true, info: { pid: 101, processAlive: true } },
	configured: {
		host: "https://sync.example",
		vaultId: "vault-id",
		deviceName: "headless-clean",
	},
	live: {
		daemon: {
			alive: true,
			uptimeSeconds: 30,
		},
		connection: {
			status: "connecting",
			rttMs: null,
		},
		sync: {
			serverAppliedLocalState: false,
			reconcileInFlight: false,
		},
		attention: {
			totalCount: 0,
			items: [],
			providerExcludeError: null,
		},
		attachments: {
			enabled: true,
			transferStatus: "syncing 1/3",
			pendingUploads: 0,
			pendingDownloads: 0,
		},
	},
});
assert.match(cleanLiveStatus, /Runtime\s+running · PID 101 \(uptime 0m\)/);
assert.match(cleanLiveStatus, /Sync status\s+connecting/);
assert.match(cleanLiveStatus, /Attention\s+0 items \(clean\)/);
assert.match(cleanLiveStatus, /Attachments\s+default · syncing 1\/3/);

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
