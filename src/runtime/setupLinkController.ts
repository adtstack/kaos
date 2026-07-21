import { type App, Notice } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import { ConfirmModal } from "../ui/ConfirmModal";
import { formatUnknown } from "../utils/format";
import { obsidianRequest } from "../utils/http";
import { parseSocketTicketResponse } from "../sync/socketTicket";

const MAX_SETUP_HOST_LENGTH = 2_048;
const MIN_SETUP_TOKEN_LENGTH = 32;
const MAX_SETUP_TOKEN_LENGTH = 512;
const MIN_SETUP_VAULT_ID_LENGTH = 8;
const MAX_SETUP_VAULT_ID_LENGTH = 128;

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

export interface SetupLinkTarget {
	host: string;
	token: string;
	vaultId: string;
}

export interface SetupLinkConfirmation {
	mode: "new-setup" | "replace-token";
	target: SetupLinkTarget;
	localDocumentCount: number;
}

export interface SetupLinkControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	isMarkdownPathSyncable(path: string): boolean;
	/** Must roll the shared settings object back if durable persistence fails. */
	updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason?: string,
	): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	hasSyncRuntime(): boolean;
	initSync(): void;
	/** Test/UI seam. The default implementation uses a fail-closed modal. */
	confirmSetup?(confirmation: SetupLinkConfirmation): Promise<boolean>;
	/** Test/network seam. The default implementation requests an authenticated socket ticket. */
	verifySetupTarget?(target: SetupLinkTarget): Promise<void>;
}

/**
 * Accept only a canonical HTTP(S) origin. Remote plaintext HTTP, credentials,
 * paths, query strings, fragments, and non-canonical spellings are rejected.
 */
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

	// This comparison also rejects paths, queries, fragments, redundant ports,
	// and alternate spellings. A single trailing slash is harmless and common.
	if (candidate !== url.origin && candidate !== `${url.origin}/`) return null;
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function verifySetupTargetWithSocketTicket(target: SetupLinkTarget): Promise<void> {
	const response = await obsidianRequest({
		url: `${target.host}/vault/${encodeURIComponent(target.vaultId)}/auth/ticket`,
		method: "POST",
		headers: { Authorization: `Bearer ${target.token}` },
	});
	if (response.status !== 200) {
		if (response.status === 404 || response.status === 405 || response.status === 501) {
			throw new Error("server does not support secure pairing verification; update the KAOS server first");
		}
		throw new Error(`server rejected the setup credentials (${response.status})`);
	}
	parseSocketTicketResponse(response.json);
}

export class SetupLinkController {
	private setupInFlight = false;

	constructor(private readonly deps: SetupLinkControllerDeps) {}

	async handleSetupLink(params: Record<string, string>): Promise<void> {
		if (this.setupInFlight) {
			new Notice("Another KAOS setup link is already being reviewed.", 6000);
			return;
		}

		this.setupInFlight = true;
		try {
			await this.handleSetupLinkExclusive(params);
		} finally {
			this.setupInFlight = false;
		}
	}

	private async handleSetupLinkExclusive(params: Record<string, string>): Promise<void> {
		if (params.action !== "setup") {
			new Notice("Invalid KAOS setup link: the setup action is missing.", 8000);
			return;
		}

		const rawHost = typeof params.host === "string" ? params.host : "";
		const host = canonicalizeSetupHost(rawHost);
		const rawToken = typeof params.token === "string" ? params.token : "";
		const token = rawToken.trim();
		const rawVaultId = typeof params.vaultId === "string" ? params.vaultId : "";
		const incomingVaultId = rawVaultId.trim();
		if (!rawHost.trim() || !token || !incomingVaultId) {
			new Notice("Invalid KAOS setup link: host, token, and vault ID are all required.", 8000);
			return;
		}
		if (!host) {
			new Notice(
				"Invalid KAOS server address. Use a canonical HTTPS origin (HTTP is allowed only for localhost).",
				9000,
			);
			return;
		}
		if (
			rawToken !== token
			|| token.length < MIN_SETUP_TOKEN_LENGTH
			|| token.length > MAX_SETUP_TOKEN_LENGTH
			|| !/^[\x21-\x7e]+$/.test(token)
			|| rawVaultId !== incomingVaultId
			|| incomingVaultId.length < MIN_SETUP_VAULT_ID_LENGTH
			|| incomingVaultId.length > MAX_SETUP_VAULT_ID_LENGTH
			|| containsControlCharacter(incomingVaultId)
		) {
			new Notice("Invalid KAOS setup link: token or vault ID is malformed.", 8000);
			return;
		}

		const initialSettings = this.deps.getSettings();
		const currentHostRaw = initialSettings.host?.trim() ?? "";
		const currentToken = initialSettings.token?.trim() ?? "";
		const currentVaultId = initialSettings.vaultId?.trim() ?? "";
		const initialAuthority = {
			host: currentHostRaw,
			token: currentToken,
			vaultId: currentVaultId,
		};
		// vaultId is generated locally at startup, so it must not by itself make a
		// fresh installation look configured. Host/token are the authority signal.
		const hasCurrentHost = currentHostRaw.length > 0;
		const hasCurrentToken = currentToken.length > 0;
		const currentHost = canonicalizeSetupHost(currentHostRaw);
		const fullyConfigured = Boolean(
			hasCurrentHost
			&& hasCurrentToken
			&& currentVaultId
			&& currentHost,
		);

		if (
			(hasCurrentHost && (!currentHost || currentHost !== host))
			|| (!fullyConfigured && hasCurrentToken && currentToken !== token)
			|| (fullyConfigured && currentVaultId !== incomingVaultId)
		) {
			new Notice(
				"This vault is already configured for a different sync target. Change the server or vault ID only from KAOS settings.",
				10000,
			);
			return;
		}

		if (fullyConfigured && currentToken === token) {
			new Notice("This vault is already linked to that KAOS server.", 6000);
			return;
		}

		const target: SetupLinkTarget = { host, token, vaultId: incomingVaultId };
		const confirmation: SetupLinkConfirmation = {
			mode: fullyConfigured ? "replace-token" : "new-setup",
			target,
			localDocumentCount: this.countLocalDocuments(),
		};
		const confirmed = this.deps.confirmSetup
			? await this.deps.confirmSetup(confirmation)
			: await this.confirmSetup(confirmation);
		if (!confirmed) {
			new Notice("Pairing cancelled. No settings were changed.", 6000);
			return;
		}

		new Notice("Verifying the KAOS server and credentials...", 6000);
		try {
			await (this.deps.verifySetupTarget ?? verifySetupTargetWithSocketTicket)(target);
		} catch (err) {
			new Notice(
				`Pairing could not be verified, so nothing was changed. ${formatUnknown(err)}`,
				10000,
			);
			return;
		}

		// A settings-screen edit can happen while the modal or network request is
		// open. Do not overwrite it with a stale setup-link decision.
		if (!this.settingsStillMatch(initialAuthority)) {
			new Notice("Settings changed while pairing, so KAOS did not apply this link.", 9000);
			return;
		}

		try {
			await this.deps.updateSettings((settings) => {
				settings.host = target.host;
				settings.token = target.token;
				settings.vaultId = target.vaultId;
			}, "setup-link");
		} catch (error) {
			new Notice(
				`Pairing could not be saved, so settings were rolled back. ${formatUnknown(error)}`,
				10000,
			);
			return;
		}
		await this.deps.refreshServerCapabilities("setup-link");
		new Notice("Server linked. Starting sync...", 6000);

		if (!this.deps.hasSyncRuntime()) {
			this.deps.initSync();
			return;
		}

		new Notice("Settings saved. Reload the plugin to reconnect with the verified server.", 8000);
	}

	private countLocalDocuments(): number {
		const vault = this.deps.app.vault;
		return (
			typeof vault.getFiles === "function"
				? vault.getFiles()
				: vault.getMarkdownFiles()
		)
			.filter((file) => this.deps.isMarkdownPathSyncable(file.path))
			.length;
	}

	private settingsStillMatch(
		initial: { host: string; token: string; vaultId: string },
	): boolean {
		const current = this.deps.getSettings();
		return (
			(current.host?.trim() ?? "") === initial.host
			&& (current.token?.trim() ?? "") === initial.token
			&& (current.vaultId?.trim() ?? "") === initial.vaultId
		);
	}

	private async confirmSetup(confirmation: SetupLinkConfirmation): Promise<boolean> {
		const replacingToken = confirmation.mode === "replace-token";
		const title = replacingToken ? "Replace KAOS sync token" : "Connect this vault to KAOS";
		const message = replacingToken
			? `This link will replace the sync token for ${confirmation.target.host}, `
				+ `vault ID ${confirmation.target.vaultId}. The new token will be verified before it is saved. Continue?`
			: `Connect ${confirmation.localDocumentCount} local syncable text document(s) to `
				+ `${confirmation.target.host}, vault ID ${confirmation.target.vaultId}? `
				+ "The server and credentials will be verified before anything is saved.";
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.deps.app,
				title,
				message,
				() => resolve(true),
				replacingToken ? "Replace verified token" : "Connect verified server",
				"Cancel",
				() => resolve(false),
			).open();
		});
	}
}
