import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../src/settings/settingsStore";
import {
	canonicalizeSetupHost,
	normalizeSetupPairingCode,
	parseConnectionString,
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => { resolve = next; });
	return { promise, resolve };
}

function makeHarness(options: {
	settings?: Partial<VaultSyncSettings>;
	confirm?: (confirmation: SetupLinkConfirmation) => Promise<boolean>;
	pair?: (target: { host: string; vaultId: string; qrSecret: string }) => Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	pairWithCode?: (target: { host: string; vaultId: string; code: string }) => Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	runtime?: boolean;
	updateError?: Error;
} = {}) {
	let settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, ...options.settings };
	const events: string[] = [];
	const confirmations: SetupLinkConfirmation[] = [];
	const pairings: { host: string; vaultId: string; qrSecret: string }[] = [];
	const codePairings: { host: string; vaultId: string; code: string }[] = [];
	let updateCount = 0;
	let refreshCount = 0;
	let initCount = 0;
	const deps: SetupLinkControllerDeps = {
		app: { vault: { getFiles: () => [{ path: "a.md" }, { path: "notes/b.base" }, { path: "assets/image.png" }] } } as unknown as import("obsidian").App,
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
		initSync: () => { events.push("init"); initCount++; },
		pairWithSecret: async (target) => {
			events.push("pair");
			pairings.push(target);
			return options.pair ? await options.pair(target) : { status: "active", deviceId: "device-123", fingerprint: "1234567890abcdef" };
		},
		pairWithCode: async (target) => {
			events.push("pair-code");
			codePairings.push(target);
			return options.pairWithCode ? await options.pairWithCode(target) : { status: "active", deviceId: "device-code-123", fingerprint: "1234567890abcdef" };
		},
		confirmSetup: async (confirmation) => {
			events.push("confirm");
			confirmations.push(confirmation);
			return options.confirm ? await options.confirm(confirmation) : true;
		},
	};
	return {
		controller: new SetupLinkController(deps), events, confirmations, pairings, codePairings,
		get settings() { return settings; },
		mutateSettingsInPlace(next: Partial<VaultSyncSettings>) { Object.assign(settings, next); },
		counts: () => ({ updateCount, refreshCount, initCount }),
	};
}

const validLink = {
	action: "pair",
	host: "https://sync.example.com",
	vaultId: "vault_12345678",
	secret: "a".repeat(48),
};

console.log("\n--- setup hosts accept and normalize secure origins ---");
{
	assert(canonicalizeSetupHost("https://sync.example.com") === "https://sync.example.com", "canonical HTTPS origin is accepted");
	assert(canonicalizeSetupHost("https://sync.example.com/") === "https://sync.example.com", "a single trailing slash is normalized");
	assert(canonicalizeSetupHost("https://sync.example.com///") === "https://sync.example.com", "multiple trailing slashes are normalized");
	assert(canonicalizeSetupHost("sync.example.com") === "https://sync.example.com", "missing protocol is auto-prefixed with https");
	assert(canonicalizeSetupHost("sync.example.com/") === "https://sync.example.com", "missing protocol with trailing slash is normalized");
	assert(canonicalizeSetupHost("http://localhost:8787") === "http://localhost:8787", "loopback HTTP is accepted for development");
	assert(canonicalizeSetupHost("http://127.0.0.1:8787/") === "http://127.0.0.1:8787", "loopback HTTP with trailing slash is accepted");
	for (const unsafe of ["http://sync.example.com", "https://user:pass@sync.example.com", "https://sync.example.com/path", "https://sync.example.com?next=evil", "https://sync.example.com#fragment"]) {
		assert(canonicalizeSetupHost(unsafe) === null, `unsafe host is rejected: ${unsafe}`);
	}
}

console.log("\n--- pairing codes and connection strings parse resiliently ---");
{
	assert(normalizeSetupPairingCode("KAOS-ABC-DEF") === "ABCDEF", "KAOS- prefix with hyphen is stripped");
	assert(normalizeSetupPairingCode("KAOS_ABC_DEF") === "ABCDEF", "KAOS_ prefix with underscore is stripped");
	assert(normalizeSetupPairingCode("kaos-abc-def") === "ABCDEF", "lowercase KAOS- code is normalized to uppercase 6-char code");
	assert(normalizeSetupPairingCode("ABC-DEF") === "ABCDEF", "hyphenated 6-char code is normalized");
	assert(normalizeSetupPairingCode("ABCDEF") === "ABCDEF", "plain 6-char code is normalized");

	const rawCodeResult = parseConnectionString("KAOS-ABC-DEF");
	assert(rawCodeResult?.action === "pair" && rawCodeResult.code === "ABCDEF", "raw KAOS- pairing code is parsed into pair action");

	const bracketResult = parseConnectionString("<obsidian://kaos?action=claim-owner&host=https://sync.example.com/&vaultId=vault_12345678&secret=" + "a".repeat(48) + ">");
	assert(bracketResult?.action === "claim-owner" && bracketResult.host === "https://sync.example.com", "angle bracket wrapped deep link is parsed and host is sanitized");

	const mdResult = parseConnectionString("[Connect](obsidian://kaos?action=pair&host=https://sync.example.com&vaultId=vault_12345678&code=KAOS-ABC-DEF)");
	assert(mdResult?.action === "pair" && mdResult.code === "ABCDEF", "markdown wrapped deep link is parsed and code is normalized");
}

console.log("\n--- pairing links reject malformed and legacy secret inputs before confirmation ---");
{
	for (const params of [
		{ ...validLink, secret: "", code: "" },
		{ ...validLink, host: "http://sync.example.com" },
		{ ...validLink, vaultId: "short" },
		{ ...validLink, secret: "short" },
		{ ...validLink, secret: `${"a".repeat(40)}\n` },
		{ ...validLink, token: "stolen-long-lived-token" },
		{ ...validLink, ticket: "stolen-ticket" },
	]) {
		const harness = makeHarness();
		await harness.controller.handleSetupLink(params);
		assert(harness.confirmations.length === 0 && harness.pairings.length === 0, "invalid or legacy-secret link is never confirmed or paired");
		assert(harness.counts().updateCount === 0, "invalid link cannot change saved settings");
	}
}

console.log("\n--- a pairing link with trailing slash or claim-owner confirms and pairs cleanly ---");
{
	const slashHarness = makeHarness();
	await slashHarness.controller.handleSetupLink({ ...validLink, host: "https://sync.example.com/" });
	assert(slashHarness.confirmations.length === 1 && slashHarness.settings.host === "https://sync.example.com", "host with trailing slash pairs cleanly and persists clean origin");

	const claimOwnerHarness = makeHarness();
	await claimOwnerHarness.controller.handleSetupLink({ ...validLink, action: "claim-owner", host: "https://sync.example.com/" });
	assert(claimOwnerHarness.confirmations.length === 1 && claimOwnerHarness.settings.host === "https://sync.example.com", "claim-owner action pairs cleanly");

	const codeHarness = makeHarness();
	await codeHarness.controller.handleSetupLink({ action: "pair", host: "https://sync.example.com/", vaultId: "vault_12345678", code: "KAOS-ABC-DEF" });
	assert(codeHarness.confirmations.length === 1 && codeHarness.codePairings[0]?.code === "ABCDEF", "code pairing link normalizes code and pairs cleanly");
}

console.log("\n--- a pairing link confirms and pairs device cleanly ---");
{
	const harness = makeHarness();
	await harness.controller.handleSetupLink(validLink);
	assert(harness.confirmations.length === 1 && harness.confirmations[0]?.mode === "new-enrollment", "new device pairing requests explicit confirmation");
	assert(harness.confirmations[0]?.localDocumentCount === 2, "confirmation reports syncable local documents");
	assert(harness.events.join(",") === "confirm,pair,update:device-pairing-link,refresh:device-pairing-link,init", "pairing updates settings and initializes sync");
	assert(harness.pairings[0]?.qrSecret === validLink.secret, "secret is used only for pairing");
	assert(harness.settings.host === validLink.host && harness.settings.vaultId === validLink.vaultId, "only host and vault ID are saved");
	assert(!Object.prototype.hasOwnProperty.call(harness.settings, "secret") && !Object.prototype.hasOwnProperty.call(harness.settings, "token"), "no secret or bearer token is persisted");
}

console.log("\n--- cancellation and denial leave settings untouched ---");
{
	const cancelled = makeHarness({ confirm: async () => false });
	await cancelled.controller.handleSetupLink(validLink);
	assert(cancelled.pairings.length === 0 && cancelled.counts().updateCount === 0, "cancel stops before pairing");

	const denied = makeHarness({ pair: async () => { throw new Error("pairing code expired"); } });
	await denied.controller.handleSetupLink(validLink);
	assert(denied.counts().updateCount === 0 && denied.counts().refreshCount === 0 && denied.counts().initCount === 0, "rejected pairing cannot alter configuration or start sync");
}

console.log("\n--- authority replacement, concurrency, and stale confirmation are fenced ---");
{
	const replacing = makeHarness({ settings: { host: "https://old.example.com", vaultId: "old_vault_123" } });
	await replacing.controller.handleSetupLink(validLink);
	assert(replacing.confirmations[0]?.mode === "replace-target", "a different configured vault requires replacement confirmation");
	assert(replacing.settings.host === validLink.host && replacing.settings.vaultId === validLink.vaultId, "confirmed replacement updates only the target identity");

	const gate = deferred<boolean>();
	const concurrent = makeHarness({ confirm: async () => await gate.promise });
	const first = concurrent.controller.handleSetupLink(validLink);
	await Promise.resolve();
	await concurrent.controller.handleSetupLink({ ...validLink, host: "https://other.example.com" });
	assert(concurrent.confirmations.length === 1, "second pairing link is rejected while a decision is pending");
	gate.resolve(true);
	await first;
	assert(concurrent.counts().updateCount === 1, "only the first pairing can persist");

	const staleGate = deferred<boolean>();
	const stale = makeHarness({ confirm: async () => await staleGate.promise });
	const pairing = stale.controller.handleSetupLink(validLink);
	await Promise.resolve();
	stale.mutateSettingsInPlace({ vaultId: "manual_vault_change" });
	staleGate.resolve(true);
	await pairing;
	assert(stale.counts().updateCount === 0, "manual settings edit fences a stale confirmation");
}

console.log("\n--- durable persistence failure cannot refresh or connect ---");
{
	const harness = makeHarness({ updateError: new Error("disk full") });
	await harness.controller.handleSetupLink(validLink);
	assert(harness.counts().updateCount === 1 && harness.counts().refreshCount === 0 && harness.counts().initCount === 0, "failed durable save stops all follow-up work");
	assert(harness.settings.host === DEFAULT_SETTINGS.host, "failed save leaves existing settings unchanged");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
