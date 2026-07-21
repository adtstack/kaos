import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../src/settings/settingsStore";
import {
	canonicalizeSetupHost,
	SetupLinkController,
	type SetupLinkConfirmation,
	type SetupLinkControllerDeps,
	type SetupLinkTarget,
} from "../src/runtime/setupLinkController";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS  ${message}`);
		passed++;
	} else {
		console.error(`  FAIL  ${message}`);
		failed++;
	}
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function makeHarness(options: {
	settings?: Partial<VaultSyncSettings>;
	confirm?: (confirmation: SetupLinkConfirmation) => Promise<boolean>;
	verify?: (target: SetupLinkTarget) => Promise<void>;
	runtime?: boolean;
	useDefaultVerify?: boolean;
	updateError?: Error;
} = {}) {
	let settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, ...options.settings };
	const events: string[] = [];
	const confirmations: SetupLinkConfirmation[] = [];
	const verified: SetupLinkTarget[] = [];
	let updateCount = 0;
	let refreshCount = 0;
	let initCount = 0;
	const deps: SetupLinkControllerDeps = {
		app: {
			vault: {
				getFiles: () => [
					{ path: "a.md" },
					{ path: "notes/b.base" },
					{ path: "assets/image.png" },
				],
			},
		} as unknown as import("obsidian").App,
		getSettings: () => settings,
		isMarkdownPathSyncable: (path) => path.endsWith(".md") || path.endsWith(".base"),
		updateSettings: async (mutator, reason) => {
			events.push(`update:${reason ?? ""}`);
			updateCount++;
			const next = { ...settings };
			mutator(next);
			if (options.updateError) throw options.updateError;
			settings = next;
		},
		refreshServerCapabilities: async (reason) => {
			events.push(`refresh:${reason ?? ""}`);
			refreshCount++;
		},
		hasSyncRuntime: () => options.runtime === true,
		initSync: () => {
			events.push("init");
			initCount++;
		},
		confirmSetup: async (confirmation) => {
			events.push("confirm");
			confirmations.push(confirmation);
			return options.confirm ? await options.confirm(confirmation) : true;
		},
		verifySetupTarget: async (target) => {
			events.push("verify");
			verified.push(target);
			if (options.verify) await options.verify(target);
		},
	};
	if (options.useDefaultVerify) delete deps.verifySetupTarget;
	return {
		controller: new SetupLinkController(deps),
		events,
		confirmations,
		verified,
		get settings() { return settings; },
		mutateSettingsInPlace(next: Partial<VaultSyncSettings>) {
			Object.assign(settings, next);
		},
		counts: () => ({ updateCount, refreshCount, initCount }),
	};
}

const validLink = {
	action: "setup",
	host: "https://sync.example.com",
	token: `new-token-${"a".repeat(40)}`,
	vaultId: "vault-12345678",
};

console.log("\n--- Test 1: setup hosts are canonical, secure origins ---");
{
	assert(canonicalizeSetupHost("https://sync.example.com") === "https://sync.example.com", "canonical HTTPS origin accepted");
	assert(canonicalizeSetupHost("https://sync.example.com/") === "https://sync.example.com", "single trailing slash normalized");
	assert(canonicalizeSetupHost("http://localhost:8787") === "http://localhost:8787", "localhost HTTP accepted for development");
	assert(canonicalizeSetupHost("http://127.0.0.1:8787") === "http://127.0.0.1:8787", "IPv4 loopback HTTP accepted");
	assert(canonicalizeSetupHost("http://[::1]:8787") === "http://[::1]:8787", "IPv6 loopback HTTP accepted");
	for (const unsafe of [
		"http://sync.example.com",
		"https://user:pass@sync.example.com",
		"https://sync.example.com/path",
		"https://sync.example.com?next=evil",
		"https://sync.example.com#fragment",
		"https://SYNC.example.com",
		"https://sync.example.com:443",
	]) {
		assert(canonicalizeSetupHost(unsafe) === null, `unsafe/non-canonical host rejected: ${unsafe}`);
	}
}

console.log("\n--- Test 2: malformed links fail before confirmation or persistence ---");
{
	const malformed = [
		{ ...validLink, action: "" },
		{ ...validLink, action: "pair" },
		{ ...validLink, host: "" },
		{ ...validLink, host: "http://sync.example.com" },
		{ ...validLink, token: "" },
		{ ...validLink, token: "too-short" },
		{ ...validLink, token: `${"a".repeat(32)}\n` },
		{ ...validLink, vaultId: "" },
		{ ...validLink, vaultId: "short" },
		{ ...validLink, vaultId: `vault-${"x".repeat(130)}` },
	];
	for (const params of malformed) {
		const harness = makeHarness();
		await harness.controller.handleSetupLink(params);
		assert(harness.confirmations.length === 0, `malformed link is not confirmed: ${JSON.stringify(params)}`);
		assert(harness.counts().updateCount === 0, "malformed link does not update settings");
	}
}

console.log("\n--- Test 3: a fresh setup is confirmed and authenticated before saving ---");
{
	const harness = makeHarness({ settings: { vaultId: "locally-generated-id" } });
	await harness.controller.handleSetupLink(validLink);
	assert(harness.confirmations.length === 1, "fresh setup opens exactly one confirmation");
	assert(harness.confirmations[0]?.mode === "new-setup", "fresh setup uses new-setup confirmation copy");
	assert(harness.confirmations[0]?.localDocumentCount === 2, "confirmation reports syncable local document count");
	assert(harness.events.join(",") === "confirm,verify,update:setup-link,refresh:setup-link,init", "confirm and preflight precede persistence and startup");
	assert(harness.settings.host === validLink.host, "verified host saved canonically");
	assert(harness.settings.token === validLink.token, "verified token saved");
	assert(harness.settings.vaultId === validLink.vaultId, "verified vault ID replaces local generated ID");
}

console.log("\n--- Test 4: cancellation and failed preflight leave settings untouched ---");
{
	const cancelled = makeHarness({ confirm: async () => false });
	await cancelled.controller.handleSetupLink(validLink);
	assert(cancelled.counts().updateCount === 0 && cancelled.verified.length === 0, "cancel stops before preflight and save");

	const rejected = makeHarness({ verify: async () => { throw new Error("unauthorized"); } });
	await rejected.controller.handleSetupLink(validLink);
	assert(rejected.counts().updateCount === 0, "failed authenticated preflight does not save settings");
	assert(rejected.counts().refreshCount === 0 && rejected.counts().initCount === 0, "failed preflight does not refresh or start sync");
}

console.log("\n--- Test 5: configured vault target cannot be changed by deep link ---");
{
	const current = {
		host: "https://sync.example.com",
		token: "old-token",
		vaultId: "vault-12345678",
	};
	for (const params of [
		{ ...validLink, host: "https://attacker.example.com" },
		{ ...validLink, vaultId: "different-vault" },
	]) {
		const harness = makeHarness({ settings: current });
		await harness.controller.handleSetupLink(params);
		assert(harness.confirmations.length === 0, "different configured authority is rejected without a modal");
		assert(harness.counts().updateCount === 0, "different configured authority cannot overwrite settings");
	}
}

console.log("\n--- Test 5b: incomplete settings can be repaired without changing existing authority ---");
{
	const hostOnly = makeHarness({
		settings: { host: validLink.host, token: "", vaultId: "locally-generated-id" },
	});
	await hostOnly.controller.handleSetupLink(validLink);
	assert(hostOnly.counts().updateCount === 1, "host-only setup accepts the same verified host");
	assert(hostOnly.confirmations[0]?.mode === "new-setup", "partial setup uses the full connection confirmation");

	const wrongHost = makeHarness({
		settings: { host: "https://other.example.com", token: "", vaultId: "locally-generated-id" },
	});
	await wrongHost.controller.handleSetupLink(validLink);
	assert(wrongHost.counts().updateCount === 0, "host-only setup cannot be redirected to a different host");

	const tokenOnly = makeHarness({
		settings: { host: "", token: validLink.token, vaultId: "locally-generated-id" },
	});
	await tokenOnly.controller.handleSetupLink(validLink);
	assert(tokenOnly.counts().updateCount === 1, "token-only setup can fill in its missing host and vault ID");

	const wrongToken = makeHarness({
		settings: { host: "", token: `old-${"b".repeat(40)}`, vaultId: "locally-generated-id" },
	});
	await wrongToken.controller.handleSetupLink(validLink);
	assert(wrongToken.counts().updateCount === 0, "token-only setup requires the existing token authority to match");
}

console.log("\n--- Test 6: same-target token rotation is confirmed and verified ---");
{
	const harness = makeHarness({
		settings: {
			host: validLink.host,
			token: "old-token",
			vaultId: validLink.vaultId,
		},
		runtime: true,
	});
	await harness.controller.handleSetupLink(validLink);
	assert(harness.confirmations[0]?.mode === "replace-token", "token replacement has explicit confirmation mode");
	assert(harness.events.join(",") === "confirm,verify,update:setup-link,refresh:setup-link", "replacement verifies before save and does not restart a live runtime");
	assert(harness.settings.token === validLink.token, "verified replacement token saved");

	const identical = makeHarness({ settings: validLink });
	await identical.controller.handleSetupLink(validLink);
	assert(identical.confirmations.length === 0 && identical.counts().updateCount === 0, "identical link is a no-op");
}

console.log("\n--- Test 7: concurrent links cannot race settings authority ---");
{
	const gate = deferred<boolean>();
	const harness = makeHarness({ confirm: async () => await gate.promise });
	const first = harness.controller.handleSetupLink(validLink);
	await Promise.resolve();
	await harness.controller.handleSetupLink({ ...validLink, host: "https://other.example.com" });
	assert(harness.confirmations.length === 1, "second link is rejected while first confirmation is pending");
	gate.resolve(true);
	await first;
	assert(harness.counts().updateCount === 1, "only the first verified link can persist");
}

console.log("\n--- Test 8: settings edits during confirmation invalidate the decision ---");
{
	const gate = deferred<boolean>();
	const harness = makeHarness({ confirm: async () => await gate.promise });
	const pairing = harness.controller.handleSetupLink(validLink);
	await Promise.resolve();
	// Production updateSettings mutates the existing settings object, so the
	// controller must compare an immutable authority snapshot rather than retain
	// the object reference returned by getSettings().
	harness.mutateSettingsInPlace({ vaultId: "manually-edited-vault-id" });
	gate.resolve(true);
	await pairing;
	assert(harness.counts().updateCount === 0, "stale modal decision cannot overwrite a settings-screen edit");
}

console.log("\n--- Test 9: default preflight authenticates out-of-URL before persistence ---");
{
	const requests: Array<{
		url?: string;
		method?: string;
		headers?: Record<string, string>;
	}> = [];
	let responseStatus = 200;
	let responseJson: Record<string, unknown> = {
		ticket: "verified-ticket",
		expiresAt: Date.now() + 300_000,
		ttlMs: 300_000,
	};
	(globalThis as {
		__KAOS_TEST_REQUEST_URL__?: (request: unknown) => Promise<unknown>;
	}).__KAOS_TEST_REQUEST_URL__ = async (request) => {
		requests.push(request as typeof requests[number]);
		return { status: responseStatus, json: responseJson };
	};
	try {
		const harness = makeHarness({ useDefaultVerify: true });
		await harness.controller.handleSetupLink({
			...validLink,
			vaultId: "vault id/with spaces",
		});
		assert(requests.length === 1, "default preflight performs one authenticated request");
		assert(
			requests[0]?.url === "https://sync.example.com/vault/vault%20id%2Fwith%20spaces/auth/ticket",
			"preflight encodes vault ID into the protected ticket endpoint",
		);
		assert(requests[0]?.method === "POST", "preflight uses POST for a short-lived socket ticket");
		assert(requests[0]?.headers?.Authorization === `Bearer ${validLink.token}`, "preflight sends the token only in Authorization");
		assert(!requests[0]?.url?.includes(validLink.token), "preflight never places the long-lived token in the URL");
		assert(harness.counts().updateCount === 1, "successful default preflight permits persistence");

		responseJson = { ok: true };
		const malformed = makeHarness({ useDefaultVerify: true });
		await malformed.controller.handleSetupLink(validLink);
		assert(malformed.counts().updateCount === 0, "HTTP 200 with malformed ticket JSON cannot persist settings");

		responseStatus = 404;
		responseJson = {};
		const oldServer = makeHarness({ useDefaultVerify: true });
		await oldServer.controller.handleSetupLink(validLink);
		assert(oldServer.counts().updateCount === 0, "servers without secure ticket preflight must be updated before pairing");
	} finally {
		delete (globalThis as { __KAOS_TEST_REQUEST_URL__?: unknown }).__KAOS_TEST_REQUEST_URL__;
	}
}

console.log("\n--- Test 10: durable settings failure stops refresh and startup ---");
{
	const harness = makeHarness({ updateError: new Error("disk full") });
	await harness.controller.handleSetupLink(validLink);
	assert(harness.counts().updateCount === 1, "verified setup attempts one transactional save");
	assert(harness.counts().refreshCount === 0 && harness.counts().initCount === 0, "failed save cannot refresh capabilities or start sync");
	assert(harness.settings.host === DEFAULT_SETTINGS.host, "failed harness persistence leaves settings unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
