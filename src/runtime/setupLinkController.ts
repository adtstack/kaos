import { type App, Notice } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import { ConfirmModal } from "../ui/ConfirmModal";
import { formatUnknown } from "../utils/format";

const MAX_SETUP_HOST_LENGTH = 2_048;
const MIN_SETUP_VAULT_ID_LENGTH = 8;
const MAX_SETUP_VAULT_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 512;

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

export interface SetupLinkTarget {
	host: string;
	vaultId: string;
	secret?: string;
	code?: string;
}

export interface SetupLinkConfirmation {
	mode: "new-enrollment" | "replace-target";
	target: SetupLinkTarget;
	localDocumentCount: number;
}

export interface SetupLinkControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	isMarkdownPathSyncable(path: string): boolean;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	hasSyncRuntime(): boolean;
	initSync(): void;
	pairWithSecret(target: { host: string; vaultId: string; qrSecret: string }): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	pairWithCode?(target: { host: string; vaultId: string; code: string }): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	confirmSetup?(confirmation: SetupLinkConfirmation): Promise<boolean>;
}

/** Accept a canonical HTTP(S) origin, auto-correcting trailing slashes and missing protocols. */
export function canonicalizeSetupHost(value: string): string | null {
	let candidate = value.trim().replace(/\/+$/, "");
	if (!candidate || candidate.length > MAX_SETUP_HOST_LENGTH) return null;
	if (!/^https?:\/\//i.test(candidate)) {
		candidate = `https://${candidate}`;
	}
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.username || url.password) return null;
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) return null;
	if (url.origin === "null") return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	if (url.search || url.hash) return null;
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeSetupPairingCode(input: string): string {
	let raw = input.trim().toUpperCase();
	if (raw.startsWith("KAOS-") || raw.startsWith("KAOS_") || raw.startsWith("KAOS ")) {
		raw = raw.slice(5);
	} else if (raw.startsWith("KAOS")) {
		raw = raw.slice(4);
	}
	return raw.replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "");
}

export function parseConnectionString(rawInput: string): Record<string, string> | null {
	let text = rawInput.trim();
	if (!text) return null;

	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	if (text.startsWith("<") && text.endsWith(">")) {
		text = text.slice(1, -1).trim();
	}
	const mdMatch = text.match(/\[.*?\]\((.+?)\)/);
	if (mdMatch?.[1]) {
		text = mdMatch[1].trim();
	}

	const normalizedCode = normalizeSetupPairingCode(text);
	if (normalizedCode.length === 6 && (text.length <= 16 || /^KAOS[-_\s]?[A-Z0-9]{3}[-_\s]?[A-Z0-9]{3}$/i.test(text))) {
		return { action: "pair", code: normalizedCode };
	}

	if (text.startsWith("obsidian://") || text.startsWith("http://") || text.startsWith("https://")) {
		try {
			const url = new URL(text);
			const params: Record<string, string> = {};
			for (const [k, v] of url.searchParams.entries()) params[k] = v;
			if (url.hash) {
				const hashStr = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
				const hashParams = new URLSearchParams(hashStr);
				for (const [k, v] of hashParams.entries()) {
					if (!params[k]) params[k] = v;
				}
			}
			if (!params.action) params.action = "pair";
			if (!params.host && (url.protocol === "http:" || url.protocol === "https:")) {
				params.host = url.origin;
			}
			if (params.host) {
				params.host = params.host.replace(/\/+$/, "");
			}
			if (params.code) {
				params.code = normalizeSetupPairingCode(params.code);
			}
			return params;
		} catch {
			return null;
		}
	}

	if (text.includes("=") && (text.includes("host=") || text.includes("vaultId=") || text.includes("code=") || text.includes("secret="))) {
		try {
			const cleanQuery = text.startsWith("?") ? text.slice(1) : text;
			const qParams = new URLSearchParams(cleanQuery);
			const params: Record<string, string> = {};
			for (const [k, v] of qParams.entries()) params[k] = v;
			if (!params.action) params.action = "pair";
			if (params.host) params.host = params.host.replace(/\/+$/, "");
			if (params.code) params.code = normalizeSetupPairingCode(params.code);
			return params;
		} catch {
			return null;
		}
	}

	return null;
}

export class SetupLinkController {
	private setupInFlight = false;

	constructor(private readonly deps: SetupLinkControllerDeps) {}

	async handleSetupLink(params: Record<string, string>): Promise<void> {
		if (this.setupInFlight) {
			new Notice("Another KAOS pairing request is in progress.", 6000);
			return;
		}
		this.setupInFlight = true;
		try {
			await this.handleExclusive(params);
		} finally {
			this.setupInFlight = false;
		}
	}

	private async handleExclusive(params: Record<string, string>): Promise<void> {
		if (
			Object.prototype.hasOwnProperty.call(params, "token")
			|| Object.prototype.hasOwnProperty.call(params, "ticket")
		) {
			new Notice("Invalid KAOS link: legacy token or ticket is not supported.", 8000);
			return;
		}
		const rawHost = typeof params.host === "string" ? params.host : "";
		const host = canonicalizeSetupHost(rawHost);
		if (!host) {
			new Notice("Invalid KAOS server address.", 8000);
			return;
		}
		const rawVaultId = typeof params.vaultId === "string" ? params.vaultId : "";
		const vaultId = rawVaultId.trim();
		if (!vaultId || vaultId.length < MIN_SETUP_VAULT_ID_LENGTH || vaultId.length > MAX_SETUP_VAULT_ID_LENGTH || containsControlCharacter(rawVaultId)) {
			new Notice("Invalid KAOS vault ID.", 8000);
			return;
		}

		const rawSecret = typeof params.secret === "string" ? params.secret : typeof params.invite === "string" ? params.invite : "";
		const secret = rawSecret.trim();
		const rawCode = typeof params.code === "string" ? params.code : "";
		const code = normalizeSetupPairingCode(rawCode);

		if (!secret && !code) {
			new Notice("Invalid KAOS pairing link: secret or code is required.", 8000);
			return;
		}
		if (secret && (secret.length < 32 || secret.length > MAX_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(secret) || containsControlCharacter(rawSecret))) {
			new Notice("Invalid KAOS pairing secret.", 8000);
			return;
		}
		if (code && (code.length < 4 || code.length > 32 || !/^[A-Za-z0-9_-]+$/.test(code) || containsControlCharacter(rawCode))) {
			new Notice("Invalid KAOS pairing code.", 8000);
			return;
		}

		const initial = this.deps.getSettings();
		const initialAuthority = { host: initial.host.trim(), vaultId: initial.vaultId.trim() };
		const target: SetupLinkTarget = { host, vaultId, secret: secret || undefined, code: code || undefined };
		const configuredElsewhere = Boolean(initialAuthority.host && initialAuthority.vaultId
			&& (initialAuthority.host !== host || initialAuthority.vaultId !== vaultId));
		const confirmation: SetupLinkConfirmation = {
			mode: configuredElsewhere ? "replace-target" : "new-enrollment",
			target,
			localDocumentCount: this.countLocalDocuments(),
		};
		const confirmed = this.deps.confirmSetup
			? await this.deps.confirmSetup(confirmation)
			: await this.confirmSetup(confirmation);
		if (!confirmed) return;

		new Notice("Connecting to KAOS vault…", 5000);
		try {
			if (secret) {
				await this.deps.pairWithSecret({ host, vaultId, qrSecret: secret });
			} else if (code && this.deps.pairWithCode) {
				await this.deps.pairWithCode({ host, vaultId, code });
			}
			if (!this.settingsStillMatch(initialAuthority)) {
				new Notice("Settings changed while pairing, so KAOS did not apply this link.", 9000);
				return;
			}
			await this.deps.updateSettings((settings) => {
				settings.host = host;
				settings.vaultId = vaultId;
			}, "device-pairing-link");
			await this.deps.refreshServerCapabilities("device-pairing-link");
			new Notice("Device paired successfully! Sync is active.", 5000);
			if (!this.deps.hasSyncRuntime()) this.deps.initSync();
		} catch (error) {
			new Notice(`Device pairing failed: ${formatUnknown(error)}`, 10000);
		}
	}

	private countLocalDocuments(): number {
		const vault = this.deps.app.vault;
		return (typeof vault.getFiles === "function" ? vault.getFiles() : vault.getMarkdownFiles())
			.filter((file) => this.deps.isMarkdownPathSyncable(file.path)).length;
	}

	private settingsStillMatch(initial: { host: string; vaultId: string }): boolean {
		const current = this.deps.getSettings();
		return current.host.trim() === initial.host && current.vaultId.trim() === initial.vaultId;
	}

	private async confirmSetup(confirmation: SetupLinkConfirmation): Promise<boolean> {
		const replacing = confirmation.mode === "replace-target";
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.deps.app,
				replacing ? "Switch KAOS vault target" : "Connect to KAOS vault",
				`Connect this device to KAOS vault "${confirmation.target.vaultId}" on ${confirmation.target.host}? Continue?`,
				() => resolve(true),
				"Connect",
				"Cancel",
				() => resolve(false),
			).open();
		});
	}
}
