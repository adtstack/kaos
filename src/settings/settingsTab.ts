import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { PairDeviceModal, type PairingModalOptions } from "./PairDeviceModal";
import { RecoveryKitModal } from "./RecoveryKitModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import {
	attachmentSizeCapKB,
	type VaultSyncSettings,
} from "./settingsStore";
import type { RecoveryStorageAuditReport } from "../sync/recoverySnapshotClient";
import type { ManagedDevice } from "../sync/deviceAuth";
import { randomBase64Url } from "../utils/base64url";
import { SettingsCapabilityRefreshSession } from "./settingsCapabilityRefresh";
import {
	KAOS_EXCLUDE_FILE_PATH,
	parseExcludePatterns,
} from "../sync/exclude";
import { parseConnectionString } from "../runtime/setupLinkController";

type SettingsAuthMode = "device" | "unclaimed" | "unknown";
type SettingsStatusState = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

interface SettingsUpdateState {
	serverVersion: string | null;
	latestServerVersion: string | null;
	serverUpdateAvailable: boolean;
	pluginVersion: string;
	latestPluginVersion: string | null;
	pluginUpdateRecommended: boolean;
	migrationRequired: boolean;
	updateRepoUrl: string | null;
	updateActionUrl: string | null;
	updateBootstrapUrl: string | null;
	legacyServerDetected: boolean;
	pluginCompatibilityWarning: string | null;
	autoUpdateEligible: boolean;
	releaseNotesUrl: string | null;
	upgradeGuideUrl: string | null;
	guidedServerUpdateAvailable: boolean;
	guidedServerUpdateStatus: "idle" | "waiting-for-user" | "waiting-for-deploy" | "updated" | "timed-out";
	guidedServerUpdateTargetVersion: string | null;
	guidedServerUpdateStartedAt: number | null;
}

interface SettingsRecoveryStorageState {
	status: RecoveryStorageAuditReport["status"] | "unknown";
	label: "Healthy" | "Repaired" | "Needs attention" | "Unknown";
	detail: string | null;
	checkedAt: string | null;
}

export interface VaultSyncSettingsHost {
	settings: VaultSyncSettings;
	serverAuthMode: SettingsAuthMode;
	serverSupportsAttachments: boolean;
	serverMaxBlobUploadBytes: number | null;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	refreshUpdateManifest(reason?: string, force?: boolean): Promise<void>;
	refreshRecoveryStorageStatus(reason?: string): Promise<void>;
	refreshAttachmentSyncRuntime(reason?: string): Promise<void>;
	beginGuidedServerUpdate(): Promise<boolean>;
	getSettingsStatusSummary(): { state: SettingsStatusState; label: string };
	getUpdateState(): SettingsUpdateState;
	getRecoveryStorageStatusState(): SettingsRecoveryStorageState;
	createDevicePairingSession(): Promise<PairingModalOptions>;
	pairDeviceWithSecret(target: { host: string; vaultId: string; qrSecret: string }): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	pairDeviceWithCode(target: { host: string; vaultId: string; code: string }): Promise<{ status: "active"; deviceId: string; fingerprint: string | null }>;
	claimServerAsOwner?(host: string, claimSecret: string): Promise<{ recoverySecret: string }>;
	handleSetupLink?(params: Record<string, string>): Promise<void>;
	listManagedDevices(): Promise<ManagedDevice[]>;
	changeManagedDeviceRole(deviceId: string, role: "owner" | "member"): Promise<void>;
	revokeManagedDevice(deviceId: string): Promise<void>;
	hasSyncRuntime(): boolean;
	initSync(): Promise<void> | void;
	buildRecoveryKitText(): string | null;
}

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/adtstack/kaos/tree/main/server";

/** Returns true if the host URL is unencrypted and not localhost. */
function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const h = url.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
		return true;
	} catch {
		return false;
	}
}

function shortenMiddle(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function addSectionHeading(containerEl: HTMLElement, title: string): void {
	new Setting(containerEl)
		.setName(title)
		.setHeading();
}

function addCardRow(containerEl: HTMLElement, label: string, value: string): void {
	const row = containerEl.createDiv({ cls: "kaos-settings-card-row" });
	row.createSpan({ text: label, cls: "kaos-settings-card-label" });
	row.createSpan({ text: value, cls: "kaos-settings-card-value" });
}

function addServerUpdateGuide(containerEl: HTMLElement): void {
	const guide = createDetailsSection(containerEl, "How to update this server", true);
	guide.addClass("kaos-settings-update-guide");
	const guideBody = guide.createDiv({ cls: "kaos-settings-details-body" });
	guideBody.createEl("p", {
		text: "Existing Cloudflare servers update through the generated deployment repo. This preserves the same worker, durable object bindings, and sync history.",
		cls: "kaos-settings-status-subtitle",
	});
	const steps = guideBody.createEl("ol", { cls: "kaos-settings-update-steps" });
	steps.createEl("li", {
		text: "Paste the generated deployment repo URL below; this is the repo Cloudflare created when you first deployed KAOS.",
	});
	steps.createEl("li", {
		text: "If workflows are missing, click initialize updater and commit the generated workflow in GitHub once.",
	});
	steps.createEl("li", {
		text: "When a server update is available, click update server, then run the opened GitHub workflow with action set to update.",
	});
	steps.createEl("li", {
		text: "Leave this settings tab open while Cloudflare redeploys; this plugin watches the capabilities endpoint until the new server version appears.",
	});
	steps.createEl("li", {
		text: "To roll back, open the same workflow and run it with action set to revert.",
	});
	guideBody.createEl("p", {
		text: "Do not re-click deploy to Cloudflare for an existing stateful server; that is only the first-install path.",
		cls: "kaos-settings-security-warning kaos-settings-update-warning",
	});
}

function statusClass(state: string): string {
	switch (state) {
		case "connected":
			return "is-connected";
		case "offline":
		case "loading":
		case "syncing":
			return "is-busy";
		case "error":
		case "unauthorized":
			return "is-error";
		default:
			return "is-idle";
	}
}

function createDetailsSection(containerEl: HTMLElement, title: string, open = false): HTMLDetailsElement {
	const detailsEl = containerEl.createEl("details", { cls: "kaos-settings-details" });
	detailsEl.open = open;
	detailsEl.createEl("summary", {
		text: title,
		cls: "kaos-settings-details-summary",
	});
	return detailsEl;
}

export class VaultSyncSettingTab extends PluginSettingTab {
	private readonly capabilityRefreshSession = new SettingsCapabilityRefreshSession();

	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: VaultSyncSettingsHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("kaos-settings-tab");
		const setupIncomplete = !this.host.settings.host || !this.host.settings.deviceId;
		const capabilityRefreshGeneration =
			this.capabilityRefreshSession.beginDisplay(!setupIncomplete);
		const capabilityRefreshInFlight = this.capabilityRefreshSession.isInFlight;
		const attachmentsAvailable = this.host.serverSupportsAttachments;
		const attachmentCapKB = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
		const syncStatus = this.host.getSettingsStatusSummary();

		addSectionHeading(containerEl, "KAOS");

		if (setupIncomplete) {
			const callout = containerEl.createDiv({ cls: "callout kaos-settings-setup-callout" });
			callout.setAttr("data-callout", "info");

			const calloutTitle = callout.createDiv({ cls: "callout-title" });
			calloutTitle.createSpan({ text: "Quick Setup & Pairing" });

			const calloutContent = callout.createDiv({ cls: "callout-content" });
			calloutContent.createEl("p", {
				text: "Connect this device to an existing vault using a pairing link or code, or claim a newly deployed server.",
			});

			let pasteLinkInput = "";
			new Setting(calloutContent)
				.setName("Connect with pairing link or code")
				.setDesc("Paste the connection link or 6-character pairing code copied from an owner device.")
				.addText((text) =>
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					text.setPlaceholder("obsidian://kaos?action=pair&... or KAOS-XXX-XXX")
						.onChange((val) => { pasteLinkInput = val.trim(); }),
				)
				.addButton((button) =>
					button.setButtonText("Connect")
						.setCta()
						.onClick(async () => {
							if (!pasteLinkInput) {
								new Notice("Please paste a pairing link or code.", 4000);
								return;
							}
							const params = parseConnectionString(pasteLinkInput);
							if (!params) {
								new Notice("Invalid pairing link or code format.", 6000);
								return;
							}
							if (!params.host && this.host.settings.host) {
								params.host = this.host.settings.host;
							}
							if (!params.vaultId && this.host.settings.vaultId) {
								params.vaultId = this.host.settings.vaultId;
							}
							if (!params.host || !params.vaultId || (!params.secret && !params.code && !params.invite)) {
								new Notice("Incomplete pairing details: server URL and vault ID are required.", 6000);
								return;
							}
							button.setDisabled(true);
							try {
								if (this.host.handleSetupLink) {
									await this.host.handleSetupLink(params);
								} else if (params.secret) {
									await this.host.pairDeviceWithSecret({ host: params.host, vaultId: params.vaultId, qrSecret: params.secret });
								} else if (params.code) {
									await this.host.pairDeviceWithCode({ host: params.host, vaultId: params.vaultId, code: params.code });
								}
								this.redisplayIfVisible();
							} catch (err) {
								new Notice(`Connection failed: ${err instanceof Error ? err.message : "unknown error"}`, 8000);
							} finally {
								button.setDisabled(false);
							}
						}),
				);

			let claimHostInput = this.host.settings.host || "";
			let claimSecretInput = "";
			new Setting(calloutContent)
				.setName("Claim new server as owner")
				.setDesc("Enter your server URL and deploy claim secret to register this device as the primary owner.")
				.addText((text) =>
					text.setPlaceholder("https://your-worker.workers.dev")
						.setValue(claimHostInput)
						.onChange((val) => { claimHostInput = val.trim(); }),
				)
				.addText((text) => {
					text.setPlaceholder("Deployment claim secret")
						.onChange((val) => { claimSecretInput = val.trim(); });
					text.inputEl.type = "password";
				})
				.addButton((button) =>
					button.setButtonText("Claim as owner")
						.onClick(async () => {
							const cleanHost = claimHostInput.trim().replace(/\/+$/, "");
							const cleanSecret = claimSecretInput.trim();
							if (!cleanHost || !cleanSecret) {
								new Notice("Server URL and claim secret are required.", 5000);
								return;
							}
							if (!this.host.claimServerAsOwner) {
								new Notice("Direct claim is not supported in this runtime.", 5000);
								return;
							}
							button.setDisabled(true);
							try {
								const result = await this.host.claimServerAsOwner(cleanHost, cleanSecret);
								new Notice("Server claimed! This device is registered as owner.", 6000);
								if (result.recoverySecret) {
									new RecoveryKitModal(this.app, this.host.buildRecoveryKitText() || result.recoverySecret).open();
								}
								this.redisplayIfVisible();
							} catch (err) {
								const rawMsg = err instanceof Error ? err.message : "unknown error";
								if (rawMsg.includes("already_claimed")) {
									new Notice("This server is already claimed. Connect using a pairing link/code, or reset server storage if needed.", 9000);
								} else {
									new Notice(`Claim failed: ${rawMsg}`, 8000);
								}
							} finally {
								button.setDisabled(false);
							}
						}),
				);

			new Setting(calloutContent)
				.setName("Don't have a server yet?")
				.setDesc("Deploy a free sync server on Cloudflare ($0, 15 seconds).")
				.addButton((button) =>
					button
						.setButtonText("Open Cloudflare deploy")
						.onClick(() => {
							window.open(CLOUDFLARE_DEPLOY_URL, "_blank", "noopener");
						}),
				);
		}

		if (!setupIncomplete) {
			addSectionHeading(containerEl, "Sync status");

			const card = containerEl.createDiv({ cls: "kaos-settings-status-card" });

			const statusLine = card.createDiv({ cls: "kaos-settings-status-line" });

				const titleWrap = statusLine.createDiv({ cls: "kaos-settings-status-copy" });
				titleWrap.createEl("div", {
					text: "Sync is configured",
					cls: "kaos-settings-status-title",
				});
			titleWrap.createEl("div", {
			text: "Use the actions below to create a short-lived approval request or save non-secret connection details.",
				cls: "kaos-settings-status-subtitle",
			});

			statusLine.createSpan({
				text: syncStatus.label,
				cls: `kaos-settings-status-badge ${statusClass(syncStatus.state)}`,
			});

			addCardRow(card, "Status", syncStatus.label);
			addCardRow(card, "Server", this.host.settings.host);
			addCardRow(card, "Vault", shortenMiddle(this.host.settings.vaultId || "(not set)"));
			addCardRow(card, "This device", this.host.settings.deviceName || "(unnamed)");

			const actionRow = card.createDiv({ cls: "modal-button-container kaos-settings-status-actions" });

				actionRow.createEl("button", { text: "Pair another device" }).addEventListener("click", () => {
					void this.host.createDevicePairingSession().then(
						(options) => new PairDeviceModal(this.app, options).open(),
						(err) => new Notice(`Could not create pairing session: ${err instanceof Error ? err.message : "Owner permission required"}`, 7000),
					);
				});

				actionRow.createEl("button", { text: "Backup connection details" }).addEventListener("click", () => {
					const recoveryKit = this.host.buildRecoveryKitText();
					if (!recoveryKit) {
						new Notice("Configure the server URL and vault ID before exporting connection details.", 7000);
						return;
					}
					new RecoveryKitModal(this.app, recoveryKit).open();
			});
		}

		if (!setupIncomplete) {
			const updateState = this.host.getUpdateState();
			addSectionHeading(containerEl, "Updates");

			const updateCard = containerEl.createDiv({ cls: "kaos-settings-status-card" });
			addCardRow(updateCard, "Server version", updateState.serverVersion ?? "Unknown");
			addCardRow(updateCard, "Latest server", updateState.latestServerVersion ?? "Unknown");
			addCardRow(updateCard, "Plugin version", updateState.pluginVersion);
			addCardRow(updateCard, "Latest plugin", updateState.latestPluginVersion ?? "Unknown");
			addCardRow(
				updateCard,
				"Update path",
				updateState.updateRepoUrl ?? "Not configured",
			);
			const recoveryStorageState = this.host.getRecoveryStorageStatusState();
			addCardRow(updateCard, "File history storage", recoveryStorageState.label);

			const guidedStatus = updateState.guidedServerUpdateStatus;
			const waitingForGuidedUpdate =
				guidedStatus === "waiting-for-user" || guidedStatus === "waiting-for-deploy";
			const summaryText = guidedStatus === "updated"
				? `Server update to ${updateState.guidedServerUpdateTargetVersion ?? "the target version"} completed.`
				: guidedStatus === "timed-out"
					? "KAOS is still waiting for the server update. Reopen the update action if needed."
					: waitingForGuidedUpdate
						? "Waiting for the GitHub update workflow and Cloudflare redeploy to finish."
						: updateState.serverUpdateAvailable
							? updateState.migrationRequired
								? "Plugin-first migration: sync pauses until you create and commit updater v3, then explicitly allow the server migration."
								: updateState.updateRepoUrl
									? "A guided server update is available."
									: "A server update is available. Add your deployment repo URL to enable guided updates."
							: updateState.pluginUpdateRecommended
								? "This device should update the KAOS plugin soon."
								: "Server and plugin are up to date with the latest cached manifest.";
			updateCard.createEl("p", {
				text: summaryText,
				cls: "kaos-settings-status-subtitle",
			});
			if (waitingForGuidedUpdate && updateState.guidedServerUpdateTargetVersion) {
				updateCard.createEl("p", {
					text: `Target server version: ${updateState.guidedServerUpdateTargetVersion}`,
					cls: "kaos-settings-status-subtitle",
				});
			}

			if (updateState.pluginCompatibilityWarning) {
				updateCard.createEl("p", {
					text: updateState.pluginCompatibilityWarning,
					cls: "kaos-settings-security-warning",
				});
			}
			if (updateState.legacyServerDetected) {
				updateCard.createEl("p", {
					text: "Legacy server detected. Sync will continue, but update metadata and guided server update features need a newer server.",
					cls: "kaos-settings-security-warning",
				});
			}
			if (recoveryStorageState.detail) {
				updateCard.createEl("p", {
					text: recoveryStorageState.detail,
					cls: recoveryStorageState.label === "Needs attention"
						? "kaos-settings-security-warning"
						: "kaos-settings-status-subtitle",
				});
			}

			addServerUpdateGuide(updateCard);
			new Setting(updateCard)
				.setName("Deployment repo URL")
				.setDesc("Required for guided server updates. Paste the generated repo Cloudflare created during the first deploy.")
				.addText((text) =>
					text
						.setPlaceholder("https://github.com/you/kaos-server")
						.setValue(this.host.settings.updateRepoUrl)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.updateRepoUrl = value.trim();
							}, "settings:update-repo-url");
							this.redisplayIfVisible();
						}),
				);

			new Setting(updateCard)
				.setName("Deployment default branch")
				.setDesc("Usually main; used when KAOS opens repo-local update workflow links.")
				.addText((text) =>
					text
						.setPlaceholder("Default branch (for example, main)")
						.setValue(this.host.settings.updateRepoBranch)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.updateRepoBranch = value.trim() || "main";
							}, "settings:update-repo-branch");
						}),
				);

			const updateActions = updateCard.createDiv({ cls: "modal-button-container kaos-settings-status-actions" });
			updateActions.createEl("button", { text: "Refresh update info" }).addEventListener("click", () => {
				void this.host.refreshServerCapabilities("settings-refresh");
				void this.host.refreshUpdateManifest("settings-refresh", true).then(() => this.redisplayIfVisible());
			});
			updateActions.createEl("button", { text: "Check file history storage" }).addEventListener("click", () => {
				void this.host.refreshRecoveryStorageStatus("settings-refresh").then(() => this.redisplayIfVisible());
			});
			const updateActionUrl = updateState.updateActionUrl;
			const bootstrapUrl = updateState.updateBootstrapUrl;
			if (updateState.serverUpdateAvailable && updateState.migrationRequired) {
				if (updateState.releaseNotesUrl) {
					updateActions.createEl("button", { text: "Open release notes" }).addEventListener("click", () => {
						window.open(updateState.releaseNotesUrl ?? "", "_blank", "noopener");
					});
				}
				if (updateState.upgradeGuideUrl) {
					updateActions.createEl("button", { text: "Open upgrade guide" }).addEventListener("click", () => {
						window.open(updateState.upgradeGuideUrl ?? "", "_blank", "noopener");
					});
				}
				if (bootstrapUrl) {
					updateActions.createEl("button", { text: "1. Create updater v3" }).addEventListener("click", () => {
						window.open(bootstrapUrl, "_blank", "noopener");
					});
				}
				if (updateActionUrl) {
					updateActions.createEl("button", { text: "2. After commit, run migration" }).addEventListener("click", () => {
						window.open(updateActionUrl, "_blank", "noopener");
					});
				}
			} else if (updateActionUrl && updateState.guidedServerUpdateAvailable) {
				const updateButton = updateActions.createEl("button", {
					text: `Update server to ${updateState.latestServerVersion ?? "latest"}`,
				});
				updateButton.disabled = waitingForGuidedUpdate;
				updateButton.addEventListener("click", () => {
					void this.host.beginGuidedServerUpdate().then(() => this.redisplayIfVisible());
				});
				if (waitingForGuidedUpdate || guidedStatus === "timed-out") {
					updateActions.createEl("button", { text: "Open update action again" }).addEventListener("click", () => {
						window.open(updateActionUrl, "_blank", "noopener");
					});
				}
			} else if (updateActionUrl) {
				updateActions.createEl("button", {
					text: updateState.serverUpdateAvailable ? "Open update action" : "Open update workflow",
				}).addEventListener("click", () => {
					window.open(updateActionUrl, "_blank", "noopener");
				});
			}
			if (bootstrapUrl && !updateState.migrationRequired) {
				updateActions.createEl("button", { text: "Initialize updater" }).addEventListener("click", () => {
					window.open(bootstrapUrl, "_blank", "noopener");
				});
			}
		}

		addSectionHeading(containerEl, "This device");
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown to other devices in live cursors and presence.")
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.host.settings.deviceName)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.deviceName = value.trim();
						}, "settings:device-name");
					}),
			);

		addSectionHeading(containerEl, "What syncs");
		const legacyExcludeCount = parseExcludePatterns(
			this.host.settings.excludePatterns,
		).length;
		new Setting(containerEl)
			.setName("Exclude file")
			.setDesc(
				`Edit ${KAOS_EXCLUDE_FILE_PATH}. Add one vault-relative file or folder prefix per line; `
				+ "blank lines and lines beginning with # are ignored. The file is synced to every device."
				+ (legacyExcludeCount > 0
					? ` ${legacyExcludeCount} legacy device-local pattern(s) also remain active.`
					: ""),
			);

		new Setting(containerEl)
			.setName("Max text file size in kilobytes")
			.setDesc("Text files larger than this are skipped for live document sync.")
			.addText((text) =>
				text
					.setPlaceholder("2048")
					.setValue(String(this.host.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							await this.host.updateSettings((settings) => {
								settings.maxFileSizeKB = n;
							}, "settings:max-file-size");
						}
					}),
			);

		addSectionHeading(containerEl, "Attachments");

		if (this.host.settings.host) {
			new Setting(containerEl)
				.setName("Attachment storage")
				.setDesc(
					capabilityRefreshInFlight
						? "Checking this server for object storage. This happens once when you open KAOS settings."
						: attachmentsAvailable
							? "Available on this server. The plugin can sync attachments, vault snapshots, and file history."
							: "Not available on this server. Add object storage in Cloudflare, then redeploy.",
				)
				.addButton((button) =>
					button
						.setButtonText("Refresh")
						.setDisabled(capabilityRefreshInFlight)
						.onClick(async () => {
							button.setDisabled(true);
							await this.host.refreshServerCapabilities();
							await this.host.refreshAttachmentSyncRuntime("capability-refresh");
							this.redisplayIfVisible();
						}),
				);
		}

		if (this.host.settings.host && !attachmentsAvailable && !capabilityRefreshInFlight) {
			const callout = containerEl.createDiv({ cls: "kaos-settings-attachment-callout" });
			callout.createEl("p", {
				text: "Attachments are not syncing yet.",
			});
			callout.createEl("p", {
				text: "Add object storage to enable attachment sync. It takes about a minute.",
			});
			const link = callout.createEl("a", {
				text: "Watch the 1-minute setup video",
				href: "https://youtu.be/Z7xCMEYfdFM",
			});
			link.setAttr("target", "_blank");
		}

		if (attachmentsAvailable || !this.host.settings.host) {
			new Setting(containerEl)
				.setName("Sync attachments")
				.setDesc(
					"Sync images, PDF files, and other attachments through object storage. This is enabled by default when the server supports it.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.host.settings.enableAttachmentSync)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.enableAttachmentSync = value;
								settings.attachmentSyncExplicitlyConfigured = true;
							}, "settings:attachment-toggle");
							await this.host.refreshAttachmentSyncRuntime("attachment-toggle");
							this.redisplayIfVisible();
						}),
				);
		}

		if ((attachmentsAvailable || !this.host.settings.host) && this.host.settings.enableAttachmentSync) {
			new Setting(containerEl)
				.setName("Max attachment size in kilobytes")
				.setDesc(`Attachments larger than this are skipped. Maximum ${attachmentCapKB} KB.`)
				.addText((text) =>
					text
						.setPlaceholder("10240")
						.setValue(String(this.host.settings.maxAttachmentSizeKB))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (!isNaN(n) && n > 0) {
								await this.host.updateSettings((settings) => {
									settings.maxAttachmentSizeKB = Math.min(Math.floor(n), attachmentCapKB);
								}, "settings:max-attachment-size");
							}
						}),
				);

			new Setting(containerEl)
				.setName("Parallel transfers")
				.setDesc("Default 1 favors reliability on slow or mobile networks.")
				.addSlider((slider) =>
					slider
						.setLimits(1, 5, 1)
						.setValue(this.host.settings.attachmentConcurrency)
						.setDynamicTooltip()
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.attachmentConcurrency = value;
							}, "settings:attachment-concurrency");
						}),
				);
		}

		addSectionHeading(containerEl, "Collaboration");
		new Setting(containerEl)
			.setName("Show remote cursors")
			.setDesc("Show other devices' cursors and selections while editing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showRemoteCursors)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.showRemoteCursors = value;
						}, "settings:remote-cursors");
					}),
			);

		new Setting(containerEl)
			.setName("Warn while another device is typing")
			.setDesc("Show a warning when another device recently typed in the same note. Your edits are never blocked.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.remoteTypingGuardEnabled)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.remoteTypingGuardEnabled = value;
						}, "settings:remote-typing-guard");
					}),
			);

		const manualDetails = createDetailsSection(containerEl, "Manual connection", setupIncomplete);
		const manualBody = manualDetails.createDiv({ cls: "kaos-settings-details-body" });
				if (setupIncomplete) {
					manualBody.createEl("p", {
					text: "Enter the server URL and vault ID, then open a short-lived invitation from an owner device to request approval.",
							cls: "kaos-settings-details-intro",
						});
					}

				new Setting(manualBody)
					.setName("Server URL")
					.setDesc("Your server URL. This is usually filled in automatically by the setup flow.")
					.addText((text) =>
						text
							.setPlaceholder("Paste the server URL")
							.setValue(this.host.settings.host)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.host = value.trim();
							}, "settings:host");
							this.redisplayIfVisible();
					}),
			);

			if (isInsecureRemoteHost(this.host.settings.host)) {
				manualBody.createEl("p", {
					text: "This remote connection is unencrypted. Device sessions can be exposed. Use HTTPS for production.",
					cls: "kaos-settings-security-warning",
				});
			}

			new Setting(manualBody)
				.setName("Device pairing")
				.setDesc("Connect this device to an existing vault using a 6-character pairing code generated on an owner device.");

			let manualCodeInput = "";
			new Setting(manualBody)
				.setName("Connect with pairing code")
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setDesc("Enter the 6-character code (e.g. KAOS-7X9K42) shown on your other device.")
				.addText((text) => {
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					text.setPlaceholder("KAOS-XXXXXX")
						.onChange((value) => {
							manualCodeInput = value.trim();
						});
				})
				.addButton((button) => {
					button.setButtonText("Connect")
						.setCta()
						.onClick(async () => {
							if (!manualCodeInput) {
								new Notice("Please enter a pairing code.", 4000);
								return;
							}
							const host = this.host.settings.host.trim().replace(/\/$/, "");
							const vaultId = this.host.settings.vaultId.trim();
							if (!host || !vaultId) {
								new Notice("Server URL and vault ID must be set first.", 6000);
								return;
							}
							button.setDisabled(true);
							try {
								await this.host.pairDeviceWithCode({
									host,
									vaultId,
									code: manualCodeInput,
								});
								new Notice("Device paired successfully! Starting sync…", 5000);
								if (!this.host.hasSyncRuntime()) await this.host.initSync();
								this.redisplayIfVisible();
							} catch (err) {
								new Notice(`Pairing failed: ${err instanceof Error ? err.message : "invalid or expired code"}`, 8000);
							} finally {
								button.setDisabled(false);
							}
						});
				});

			const deviceRequests = manualBody.createDiv({ cls: "kaos-settings-device-requests" });
			new Setting(manualBody)
				.setName("Manage paired devices")
				.setDesc("View active devices connected to this vault.")
				.addButton((button) => button.setButtonText("Refresh list").onClick(async () => {
					button.setDisabled(true);
					try {
						this.renderManagedDevices(deviceRequests, await this.host.listManagedDevices());
					} catch (error) {
						deviceRequests.empty();
						deviceRequests.createEl("p", { text: `Could not load devices: ${error instanceof Error ? error.message : "unknown error"}` });
					} finally {
						button.setDisabled(false);
					}
				}));

		const advancedDetails = createDetailsSection(containerEl, "Advanced", false);
		const advancedBody = advancedDetails.createDiv({ cls: "kaos-settings-details-body" });

			new Setting(advancedBody)
				.setName("Vault ID")
				.setDesc("Devices syncing the same vault must use exactly the same vault ID. Change only if you know what you are doing.")
				.addText((text) =>
					text
						.setPlaceholder("Generated automatically")
						.setValue(this.host.settings.vaultId)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.vaultId = value.trim();
							}, "settings:vault-id");
							this.redisplayIfVisible();
					}),
			);

		new Setting(advancedBody)
			.setName("Frontmatter safety guard")
			.setDesc("Pause suspicious YAML property updates before they spread. Disable only while troubleshooting valid frontmatter that is being blocked.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.frontmatterGuardEnabled)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.frontmatterGuardEnabled = value;
						}, "settings:frontmatter-guard");
					}),
			);

		new Setting(advancedBody)
			.setName("Debug logging")
			.setDesc("Enable verbose console logs for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.debug)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.debug = value;
						}, "settings:debug");
					}),
			);

			new Setting(advancedBody)
				.setName("Flight recorder")
				.setDesc("Record structured sync traces with filenames redacted by default.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.qaTraceEnabled)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.qaTraceEnabled = value;
						}, "settings:qa-trace-enabled");
					}),
			);

			new Setting(advancedBody)
				.setName("Flight recorder mode")
				.setDesc("Use safe mode by default; shared-secret mode supports multi-device runs, and local-private traces cannot be exported.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("safe", "Safe (redacted)")
						.addOption("qa-safe", "Shared-secret safe")
					.addOption("full", "Full (filenames)")
					.addOption("local-private", "Local-private (no export)")
					.setValue(this.host.settings.qaTraceMode)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.qaTraceMode = value as VaultSyncSettings["qaTraceMode"];
						}, "settings:qa-trace-mode");
					}),
			);

			new Setting(advancedBody)
				.setName("Trace shared secret")
				.setDesc("Optional secret for shared-secret trace correlation; never shared in exports.")
			.addText((text) => {
				text
					.setPlaceholder("(hidden)")
					.setValue(this.host.settings.qaTraceSecret ?? "")
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.qaTraceSecret = value.trim();
						}, "settings:qa-trace-secret");
					});
				// Hide the secret field like a password input.
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
			})
			.addButton((btn) =>
				btn
					.setButtonText("Generate")
					.setTooltip("Generate a new random secret")
					.onClick(async () => {
						const secret = randomBase64Url(24);
						await this.host.updateSettings((settings) => {
							settings.qaTraceSecret = secret;
						}, "settings:qa-trace-secret-generate");
							new Notice("Trace secret generated.", 3000);
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Copy")
					.setTooltip("Copy secret to clipboard")
					.onClick(() => {
						const secret = this.host.settings.qaTraceSecret ?? "";
						if (!secret) {
							new Notice("No secret to copy.", 3000);
							return;
						}
						navigator.clipboard.writeText(secret).then(
								() => new Notice("Trace secret copied.", 3000),
							() => new Notice("Failed to copy to clipboard.", 4000),
						);
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear")
					.setTooltip("Clear the secret")
					.onClick(async () => {
						await this.host.updateSettings((settings) => {
							settings.qaTraceSecret = "";
						}, "settings:qa-trace-secret-clear");
							new Notice("Trace secret cleared.", 3000);
					}),
			);

			advancedBody.createEl("p", {
				text: "Changing the server URL or vault ID requires reloading the plugin and approving this device again.",
				cls: "setting-item-description",
			});

		if (capabilityRefreshGeneration !== null) {
			void this.refreshCapabilitiesOnOpen(capabilityRefreshGeneration);
		}
	}

	private renderManagedDevices(containerEl: HTMLElement, devices: ManagedDevice[]): void {
		containerEl.empty();
		const active = devices.filter((device) => device.status === "active" && device.id !== this.host.settings.deviceId);
		if (active.length === 0) {
			containerEl.createEl("p", { text: "No other active devices connected to this vault." });
			return;
		}
		containerEl.createEl("p", { text: "Active devices:" });
		for (const device of active) {
			const row = containerEl.createDiv({ cls: "kaos-settings-device-request" });
			row.createEl("p", { text: `${device.name} (${device.role.toUpperCase()}) — ${device.fingerprint}` });
			const nextRole = device.role === "owner" ? "member" : "owner";
			new Setting(row)
				.setName(nextRole === "owner" ? "Make Owner" : "Make Member")
				.setDesc(nextRole === "owner"
					? "Owner devices can create pairings and revoke devices."
					: "Members can sync but cannot manage other devices.")
				.addButton((button) => button.setButtonText(nextRole === "owner" ? "Make Owner" : "Make Member").setWarning().onClick(async () => {
					if (!await this.confirmDeviceRoleChange(device, nextRole)) return;
					button.setDisabled(true);
					try {
						await this.host.changeManagedDeviceRole(device.id, nextRole);
						new Notice(`Device role changed to ${nextRole}.`);
						this.renderManagedDevices(containerEl, await this.host.listManagedDevices());
					} catch (error) {
						button.setDisabled(false);
						new Notice(`Device role change failed: ${error instanceof Error ? error.message : "unknown error"}`);
					}
				}));
			new Setting(row)
				.setName("Revoke device")
				.setDesc("Immediately terminates this device's sync access.")
				.addButton((button) => button.setButtonText("Revoke").setWarning().onClick(async () => {
					if (!await this.confirmDeviceRevocation(device)) return;
					button.setDisabled(true);
					try {
						await this.host.revokeManagedDevice(device.id);
						new Notice("Device revoked.");
						this.renderManagedDevices(containerEl, await this.host.listManagedDevices());
					} catch (error) {
						button.setDisabled(false);
						new Notice(`Device revocation failed: ${error instanceof Error ? error.message : "unknown error"}`);
					}
				}));
		}
	}

	private async confirmDeviceRevocation(device: ManagedDevice): Promise<boolean> {
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.app,
				"Revoke KAOS device",
				`Revoke ${device.name}? Its device key, sessions, and socket tickets will stop working immediately.`,
				() => resolve(true),
				"Revoke device",
				"Cancel",
				() => resolve(false),
			).open();
		});
	}

	private async confirmDeviceRejection(device: ManagedDevice): Promise<boolean> {
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.app,
				"Reject KAOS device request",
				`Reject the pending request from ${device.name}? Its public key will not be able to sync.`,
				() => resolve(true),
				"Reject request",
				"Cancel",
				() => resolve(false),
			).open();
		});
	}

	private async confirmDeviceRoleChange(device: ManagedDevice, role: "owner" | "member"): Promise<boolean> {
		return await new Promise((resolve) => {
			new ConfirmModal(
				this.app,
				role === "owner" ? "Make KAOS device an Owner" : "Make KAOS device a Member",
				role === "owner"
					? `${device.name} will be able to approve, change roles, and revoke devices. Confirm its fingerprint through a separate channel first.`
					: `${device.name} will keep sync access but lose device-management authority.`,
				() => resolve(true),
				role === "owner" ? "Make Owner" : "Make Member",
				"Cancel",
				() => resolve(false),
			).open();
		});
	}

	hide(): void {
		this.capabilityRefreshSession.endDisplay();
		super.hide();
	}

	private async refreshCapabilitiesOnOpen(generation: number): Promise<void> {
		try {
			await this.host.refreshServerCapabilities("settings-open");
		} catch (err) {
			console.warn("[kaos] Settings capability refresh failed", err);
			new Notice("Could not refresh server storage capabilities. Showing cached status.", 6000);
		} finally {
			if (this.capabilityRefreshSession.complete(generation)) {
				this.redisplayIfVisible();
			}
		}
	}

	private redisplayIfVisible(): void {
		if (this.capabilityRefreshSession.isVisible) {
			this.display();
		}
	}
}
