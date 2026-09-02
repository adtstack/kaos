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

/** Accept only a canonical HTTP(S) origin. */
export function canonicalizeSetupHost(value: string): string | null {
	const candidate = value.trim();
	if (!candidate || candidate.length > MAX_SETUP_HOST_LENGTH) return null;
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
	if (candidate !== url.origin && candidate !== `${url.origin}/`) return null;
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseConnectionString(rawInput: string): Record<string, string> | null {
	const text = rawInput.trim();
	if (!text) return null;
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
			(params.action !== "pair" && params.action !== "claim-owner" && params.action !== "device-enroll")
			|| Object.prototype.hasOwnProperty.call(params, "token")
			|| Object.prototype.hasOwnProperty.call(params, "ticket")
		) {
			new Notice("Invalid KAOS link: pairing action is required.", 8000);
			return;
		}
		const rawHost = typeof params.host === "string" ? params.host : "";
		const host = canonicalizeSetupHost(rawHost);
		const rawVaultId = typeof params.vaultId === "string" ? params.vaultId : "";
		const vaultId = rawVaultId.trim();
		const rawSecret = typeof params.secret === "string" ? params.secret : typeof params.invite === "string" ? params.invite : "";
		const secret = rawSecret.trim();
		const rawCode = typeof params.code === "string" ? params.code : "";
		const code = rawCode.trim();

		if (!host || !vaultId || (!secret && !code)
			|| rawHost.trim() !== host || rawVaultId !== vaultId
			|| (rawSecret && rawSecret !== secret) || (rawCode && rawCode !== code)
			|| vaultId.length < MIN_SETUP_VAULT_ID_LENGTH || vaultId.length > MAX_SETUP_VAULT_ID_LENGTH
			|| (secret && (secret.length < 32 || secret.length > MAX_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(secret)))
			|| (code && (code.length < 4 || code.length > 32 || !/^[A-Za-z0-9_-]+$/.test(code)))
			|| containsControlCharacter(vaultId) || containsControlCharacter(secret) || containsControlCharacter(code)) {
			new Notice("Invalid KAOS pairing link.", 8000);
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
			if (rawSecret) {
				await this.deps.pairWithSecret({ host, vaultId, qrSecret: rawSecret });
			} else if (rawCode && this.deps.pairWithCode) {
				await this.deps.pairWithCode({ host, vaultId, code: rawCode });
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
