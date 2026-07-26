import type { VaultSyncSettings } from "../settings";
import { parseExcludePatterns } from "../sync/exclude";

export interface RuntimeConfig {
	host: string;
	token: string;
	vaultId: string;
	deviceName: string;
	debug: boolean;
	frontmatterGuardEnabled: boolean;
	excludePatterns: string[];
	maxFileSizeBytes: number;
	maxFileSizeKB: number;
	enableAttachmentSync: boolean;
	attachmentSyncExplicitlyConfigured: boolean;
	maxAttachmentSizeKB: number;
	attachmentConcurrency: number;
	showRemoteCursors: boolean;
	remoteTypingGuardEnabled: boolean;
	updateRepoUrl: string;
	updateRepoBranch: string;
	vaultConfigDir: string;
}

export function buildRuntimeConfig(
	settings: VaultSyncSettings,
	vaultConfigDir: string,
): RuntimeConfig {
	return {
		host: settings.host.trim(),
		token: settings.token.trim(),
		vaultId: settings.vaultId.trim(),
		deviceName: settings.deviceName.trim(),
		debug: settings.debug,
		frontmatterGuardEnabled: settings.frontmatterGuardEnabled,
		excludePatterns: parseExcludePatterns(settings.excludePatterns),
		maxFileSizeBytes: settings.maxFileSizeKB * 1024,
		maxFileSizeKB: settings.maxFileSizeKB,
		enableAttachmentSync: settings.enableAttachmentSync,
		attachmentSyncExplicitlyConfigured: settings.attachmentSyncExplicitlyConfigured,
		maxAttachmentSizeKB: settings.maxAttachmentSizeKB,
		attachmentConcurrency: settings.attachmentConcurrency,
		showRemoteCursors: settings.showRemoteCursors,
		remoteTypingGuardEnabled: settings.remoteTypingGuardEnabled,
		updateRepoUrl: settings.updateRepoUrl.trim(),
		updateRepoBranch: settings.updateRepoBranch.trim() || "main",
		vaultConfigDir,
	};
}
