import { randomBase64Url } from "../utils/base64url";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";
export const MAX_ATTACHMENT_SIZE_KB = 10 * 1024;
export const MAX_TEXT_FILE_SIZE_KB = 50 * 1024;
export const MIN_ATTACHMENT_CONCURRENCY = 1;
export const MAX_ATTACHMENT_CONCURRENCY = 5;
export const EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION = 1;

export function attachmentSizeCapKB(serverMaxBlobUploadBytes?: number | null): number {
	if (
		typeof serverMaxBlobUploadBytes !== "number" ||
		!Number.isFinite(serverMaxBlobUploadBytes) ||
		serverMaxBlobUploadBytes <= 0
	) {
		return MAX_ATTACHMENT_SIZE_KB;
	}
	return Math.max(1, Math.min(MAX_ATTACHMENT_SIZE_KB, Math.floor(serverMaxBlobUploadBytes / 1024)));
}

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Pause propagation of suspicious YAML frontmatter transitions. */
	frontmatterGuardEnabled: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "closed-only" — import only for files not open in an editor (default)
	 *   "always"      — consider open files too, without overriding visible editor authority
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;
	/** Hidden marker: old "always" defaults have been migrated to the safer closed-only policy. */
	externalEditPolicySafetyMigrationVersion: number;
	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Capped at 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
	/** Show an advisory notice when another device recently typed in the same note. */
	remoteTypingGuardEnabled: boolean;
	/** Enable QA flight recorder tracing. */
	qaTraceEnabled: boolean;
	/** QA trace mode: safe/qa-safe/full/local-private. */
	qaTraceMode: "safe" | "qa-safe" | "full" | "local-private";
	/** Optional shared secret for QA-safe multi-device trace. */
	qaTraceSecret?: string;
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;
	/** Expose window.__KAOS_DEBUG__ programmatic control surface for QA. Never ship enabled. */
	qaDebugMode: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	frontmatterGuardEnabled: true,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "closed-only",
	externalEditPolicySafetyMigrationVersion: EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION,
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
	remoteTypingGuardEnabled: true,
	qaTraceEnabled: false,
	qaTraceMode: "safe",
	qaTraceSecret: "",
	updateRepoUrl: "",
	updateRepoBranch: "main",
	qaDebugMode: false,
};

export interface SettingsPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export interface SettingsLoadResult<TState extends Partial<VaultSyncSettings>> {
	settings: VaultSyncSettings;
	persistedState: TState;
	migrated: boolean;
}

/**
 * Run settings transactions strictly in invocation order.  The queue retains a
 * fulfilled tail after failures so one rejected save cannot poison later edits.
 */
export class SettingsMutationQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(transaction: () => Promise<T>): Promise<T> {
		const result = this.tail.then(transaction);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function restoreSettingsInPlace(
	settings: VaultSyncSettings,
	previous: VaultSyncSettings,
	previousKeys: Array<string | symbol>,
): void {
	const currentRecord = settings as unknown as Record<string, unknown>;
	const previousKeySet = new Set(previousKeys);
	for (const key of Reflect.ownKeys(currentRecord)) {
		if (!previousKeySet.has(key)) {
			Reflect.deleteProperty(currentRecord, key);
		}
	}
	Object.assign(settings, previous);
}

/**
 * Keep the shared settings object unchanged when durable persistence rejects.
 * Runtime services retain this object's identity, so rollback must restore it
 * in place instead of swapping in a clone.
 */
export async function persistSettingsMutation(
	settings: VaultSyncSettings,
	mutator: (settings: VaultSyncSettings) => void,
	persist: () => Promise<void>,
	rollbackPersistentState?: () => void | Promise<void>,
): Promise<void> {
	const previous = { ...settings };
	const previousKeys = Reflect.ownKeys(settings);
	try {
		mutator(settings);
		await persist();
	} catch (error) {
		restoreSettingsInPlace(settings, previous, previousKeys);
		await rollbackPersistentState?.();
		throw error;
	}
}

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPersistedState<TState extends Partial<VaultSyncSettings>>(value: unknown): TState {
	return isRecord(value) ? { ...value } as TState : {} as TState;
}

export function readVaultSyncSettings(
	data: Partial<VaultSyncSettings> | null | undefined,
): { settings: VaultSyncSettings; migrated: boolean } {
	const rawExternalEditPolicy = (data as { externalEditPolicy?: unknown } | null | undefined)?.externalEditPolicy;
	const rawExternalEditPolicySafetyMigrationVersion =
		(data as { externalEditPolicySafetyMigrationVersion?: unknown } | null | undefined)
			?.externalEditPolicySafetyMigrationVersion;
	const settings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		data as Partial<VaultSyncSettings>,
	);
	let migrated = false;
	const repairString = (key: keyof VaultSyncSettings): void => {
		if (typeof settings[key] === "string") return;
		(settings as unknown as Record<keyof VaultSyncSettings, unknown>)[key] =
			DEFAULT_SETTINGS[key];
		migrated = true;
	};
	const repairBoolean = (key: keyof VaultSyncSettings): void => {
		if (typeof settings[key] === "boolean") return;
		(settings as unknown as Record<keyof VaultSyncSettings, unknown>)[key] =
			DEFAULT_SETTINGS[key];
		migrated = true;
	};
	for (const key of [
		"host",
		"token",
		"vaultId",
		"deviceName",
		"excludePatterns",
		"qaTraceSecret",
		"updateRepoUrl",
		"updateRepoBranch",
	] as const) repairString(key);
	for (const key of [
		"debug",
		"frontmatterGuardEnabled",
		"enableAttachmentSync",
		"showRemoteCursors",
		"remoteTypingGuardEnabled",
		"qaTraceEnabled",
		"qaDebugMode",
	] as const) repairBoolean(key);
	if (
		settings.qaTraceMode !== "safe"
		&& settings.qaTraceMode !== "qa-safe"
		&& settings.qaTraceMode !== "full"
		&& settings.qaTraceMode !== "local-private"
	) {
		settings.qaTraceMode = DEFAULT_SETTINGS.qaTraceMode;
		migrated = true;
	}
	if (
		settings.externalEditPolicy !== "always"
		&& settings.externalEditPolicy !== "closed-only"
		&& settings.externalEditPolicy !== "never"
	) {
		settings.externalEditPolicy = DEFAULT_SETTINGS.externalEditPolicy;
		migrated = true;
	}
	if (
		rawExternalEditPolicy === "always" &&
		rawExternalEditPolicySafetyMigrationVersion !== EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION
	) {
		settings.externalEditPolicy = "closed-only";
		settings.externalEditPolicySafetyMigrationVersion = EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION;
		migrated = true;
	} else if (settings.externalEditPolicySafetyMigrationVersion !== EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION) {
		settings.externalEditPolicySafetyMigrationVersion = EXTERNAL_EDIT_POLICY_SAFETY_MIGRATION_VERSION;
		migrated = true;
	}
	if (typeof data?.attachmentSyncExplicitlyConfigured !== "boolean") {
		settings.attachmentSyncExplicitlyConfigured = data?.enableAttachmentSync === true;
		if (data?.enableAttachmentSync !== true) {
			settings.enableAttachmentSync = true;
		}
		migrated = true;
	}
	if (
		typeof settings.maxAttachmentSizeKB !== "number" ||
		!Number.isFinite(settings.maxAttachmentSizeKB) ||
		!Number.isInteger(settings.maxAttachmentSizeKB) ||
		settings.maxAttachmentSizeKB <= 0 ||
		settings.maxAttachmentSizeKB > attachmentSizeCapKB()
	) {
		settings.maxAttachmentSizeKB = Math.min(
			attachmentSizeCapKB(),
			Math.max(1, Math.floor(Number(settings.maxAttachmentSizeKB) || DEFAULT_SETTINGS.maxAttachmentSizeKB)),
		);
		migrated = true;
	}
	if (
		typeof settings.maxFileSizeKB !== "number"
		|| !Number.isFinite(settings.maxFileSizeKB)
		|| !Number.isInteger(settings.maxFileSizeKB)
		|| settings.maxFileSizeKB < 1
		|| settings.maxFileSizeKB > MAX_TEXT_FILE_SIZE_KB
	) {
		const numeric = typeof settings.maxFileSizeKB === "number"
			&& Number.isFinite(settings.maxFileSizeKB)
			? settings.maxFileSizeKB
			: DEFAULT_SETTINGS.maxFileSizeKB;
		settings.maxFileSizeKB = Math.min(
			MAX_TEXT_FILE_SIZE_KB,
			Math.max(1, Math.floor(numeric)),
		);
		migrated = true;
	}
	if (
		typeof settings.attachmentConcurrency !== "number"
		|| !Number.isFinite(settings.attachmentConcurrency)
		|| !Number.isInteger(settings.attachmentConcurrency)
		|| settings.attachmentConcurrency < MIN_ATTACHMENT_CONCURRENCY
		|| settings.attachmentConcurrency > MAX_ATTACHMENT_CONCURRENCY
	) {
		const numeric = typeof settings.attachmentConcurrency === "number"
			&& Number.isFinite(settings.attachmentConcurrency)
			? settings.attachmentConcurrency
			: DEFAULT_SETTINGS.attachmentConcurrency;
		settings.attachmentConcurrency = Math.min(
			MAX_ATTACHMENT_CONCURRENCY,
			Math.max(MIN_ATTACHMENT_CONCURRENCY, Math.floor(numeric)),
		);
		migrated = true;
	}
	return { settings, migrated };
}

export class SettingsStore<TState extends Partial<VaultSyncSettings>> {
	constructor(private readonly persistence: SettingsPersistence) {}

	async load(): Promise<SettingsLoadResult<TState>> {
		const persistedState = readPersistedState<TState>(await this.persistence.loadData());
		const { settings, migrated } = readVaultSyncSettings(persistedState);
		return {
			settings,
			persistedState,
			migrated,
		};
	}

	async save(state: TState): Promise<void> {
		await this.persistence.saveData({ ...state });
	}

	withSettings(state: TState, settings: VaultSyncSettings): TState {
		return {
			...state,
			...settings,
		};
	}
}
