import { writeFile, rename, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import type { HeadlessVaultPoller } from "../core/vaultPoller";

export interface DaemonProcessInfo {
	pid: number;
	uptimeSeconds: number;
	memoryRssBytes: number;
	alive: boolean;
	startedAt: string;
	shutdownReason?: string;
}

export interface DaemonConnectionInfo {
	status: string;
	host: string;
	vaultId: string;
	deviceName: string;
	deviceId: string;
	rttMs: number | null;
	fatalAuthCode: string | null;
}

export interface DaemonSyncInfo {
	serverAppliedLocalState: boolean;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	activeMarkdownPathsCount: number;
	crdtPathCount: number;
	reconcileInFlight: boolean;
	reconcilePending: boolean;
	schemaVersion: number | null;
}

export interface DaemonAttachmentsInfo {
	enabled: boolean;
	transferStatus: string | null;
	pendingUploads: number;
	pendingDownloads: number;
}

export interface DaemonAttentionItem {
	id?: string;
	type: string;
	kind: string;
	path: string;
	reason: string;
	firstSeenAt?: number;
	lastSeenAt?: number;
}

export interface DaemonAttentionInfo {
	totalCount: number;
	items: DaemonAttentionItem[];
	providerExcludeError: string | null;
}

export interface DaemonPollerInfo {
	intervalMs: number;
	quietMs: number;
	lastPollAt: string | null;
	trackedFilesCount: number;
}

export interface HeadlessDaemonStatus {
	version: string;
	generatedAt: string;
	vaultRoot: string;
	dataFile: string;
	statusFile: string;
	socketFile: string;
	daemon: DaemonProcessInfo;
	connection: DaemonConnectionInfo;
	sync: DaemonSyncInfo;
	attachments: DaemonAttachmentsInfo;
	attention: DaemonAttentionInfo;
	poller: DaemonPollerInfo;
}

export interface StatePublisherPluginTarget {
	manifest?: { version?: string };
	getHeadlessRuntimeSnapshot?: () => {
		connection: {
			status: string;
			rttMs: number | null;
			fatalAuthCode: string | null;
		};
		sync: {
			serverAppliedLocalState: boolean;
			lastServerReceiptEchoAt: number | null;
			lastKnownServerReceiptEchoAt: number | null;
			activeMarkdownPathsCount: number;
			crdtPathCount: number;
			reconcileInFlight: boolean;
			reconcilePending: boolean;
			schemaVersion: number | null;
		};
		attachments: {
			enabled: boolean;
			transferStatus: string | null;
			pendingUploads: number;
			pendingDownloads: number;
		};
		attention: {
			totalCount: number;
			preservedUnresolved?: Array<{
				kind: string;
				path: string;
				reason: string;
				firstSeenAt?: number;
				lastSeenAt?: number;
			}>;
			structuralChanges?: Array<{
				reason: string;
				oldPaths: string[];
				newPaths: string[];
				contentHashPrefix: string;
			}>;
			quarantine?: Array<{
				path: string;
				quarantineReason: string;
				quarantinedAt: number;
			}>;
			providerExcludeError: string | null;
		};
	};
}

export interface DaemonStatePublisherOptions {
	vaultRoot: string;
	dataFile: string;
	statusFile?: string;
	socketFile?: string;
	config: {
		host?: string;
		vaultId?: string;
		deviceName?: string;
		deviceId?: string;
	};
	plugin: StatePublisherPluginTarget;
	poller?: HeadlessVaultPoller;
	intervalMs?: number;
}

export class DaemonStatePublisher {
	public readonly statusFile: string;
	public readonly socketFile: string;
	private interval: ReturnType<typeof setInterval> | null = null;
	private startedAt: string;
	private stopped = false;

	private readonly options: DaemonStatePublisherOptions;

	constructor(options: DaemonStatePublisherOptions) {
		this.options = options;
		const dataDir = dirname(options.dataFile);
		this.statusFile = options.statusFile ?? join(dataDir, "status.json");
		this.socketFile = options.socketFile ?? join(dataDir, "daemon.sock");
		this.startedAt = new Date().toISOString();
	}

	async start(): Promise<void> {
		if (this.stopped) return;
		await mkdir(dirname(this.statusFile), { recursive: true });
		await this.publishOnce(true);
		const intervalMs = Math.max(500, this.options.intervalMs ?? 1000);
		this.interval = setInterval(() => {
			void this.publishOnce(true).catch(() => undefined);
		}, intervalMs);
	}

	async stop(reason: string = "normal"): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		await this.publishOnce(false, reason).catch(() => undefined);
	}

	collectStatus(alive = true, shutdownReason?: string): HeadlessDaemonStatus {
		const pluginSnapshot = this.options.plugin.getHeadlessRuntimeSnapshot?.();
		const mem = process.memoryUsage();
		const uptime = Math.trunc(process.uptime());

		const attentionItems: DaemonAttentionItem[] = [];
		if (pluginSnapshot?.attention?.preservedUnresolved) {
			for (const entry of pluginSnapshot.attention.preservedUnresolved) {
				attentionItems.push({
					type: "preserved-unresolved",
					kind: entry.kind,
					path: entry.path,
					reason: entry.reason,
					firstSeenAt: entry.firstSeenAt,
					lastSeenAt: entry.lastSeenAt,
				});
			}
		}
		if (pluginSnapshot?.attention?.structuralChanges) {
			for (const s of pluginSnapshot.attention.structuralChanges) {
				attentionItems.push({
					type: "structural-change",
					kind: "markdown",
					path: s.newPaths[0] ?? s.oldPaths[0] ?? "unknown",
					reason: s.reason,
				});
			}
		}
		if (pluginSnapshot?.attention?.quarantine) {
			for (const q of pluginSnapshot.attention.quarantine) {
				attentionItems.push({
					type: "quarantine",
					kind: "markdown",
					path: q.path,
					reason: q.quarantineReason,
					firstSeenAt: q.quarantinedAt,
				});
			}
		}

		return {
			version: this.options.plugin.manifest?.version ?? "unknown",
			generatedAt: new Date().toISOString(),
			vaultRoot: this.options.vaultRoot,
			dataFile: this.options.dataFile,
			statusFile: this.statusFile,
			socketFile: this.socketFile,
			daemon: {
				pid: process.pid,
				uptimeSeconds: uptime,
				memoryRssBytes: mem.rss,
				alive,
				startedAt: this.startedAt,
				shutdownReason,
			},
			connection: {
				status: pluginSnapshot?.connection?.status ?? "unknown",
				host: this.options.config.host ?? "",
				vaultId: this.options.config.vaultId ?? "",
				deviceName: this.options.config.deviceName ?? "",
				deviceId: this.options.config.deviceId ?? "",
				rttMs: pluginSnapshot?.connection?.rttMs ?? null,
				fatalAuthCode: pluginSnapshot?.connection?.fatalAuthCode ?? null,
			},
			sync: {
				serverAppliedLocalState: pluginSnapshot?.sync?.serverAppliedLocalState ?? false,
				lastServerReceiptEchoAt: pluginSnapshot?.sync?.lastServerReceiptEchoAt ?? null,
				lastKnownServerReceiptEchoAt: pluginSnapshot?.sync?.lastKnownServerReceiptEchoAt ?? null,
				activeMarkdownPathsCount: pluginSnapshot?.sync?.activeMarkdownPathsCount ?? 0,
				crdtPathCount: pluginSnapshot?.sync?.crdtPathCount ?? 0,
				reconcileInFlight: pluginSnapshot?.sync?.reconcileInFlight ?? false,
				reconcilePending: pluginSnapshot?.sync?.reconcilePending ?? false,
				schemaVersion: pluginSnapshot?.sync?.schemaVersion ?? null,
			},
			attachments: {
				enabled: pluginSnapshot?.attachments?.enabled ?? false,
				transferStatus: pluginSnapshot?.attachments?.transferStatus ?? null,
				pendingUploads: pluginSnapshot?.attachments?.pendingUploads ?? 0,
				pendingDownloads: pluginSnapshot?.attachments?.pendingDownloads ?? 0,
			},
			attention: {
				totalCount: pluginSnapshot?.attention?.totalCount ?? attentionItems.length,
				items: attentionItems,
				providerExcludeError: pluginSnapshot?.attention?.providerExcludeError ?? null,
			},
			poller: {
				intervalMs: 1000,
				quietMs: 1100,
				lastPollAt: new Date().toISOString(),
				trackedFilesCount: 0,
			},
		};
	}

	async publishOnce(alive = true, shutdownReason?: string): Promise<void> {
		const status = this.collectStatus(alive, shutdownReason);
		const tmp = `${this.statusFile}.${process.pid}.${Date.now()}.tmp`;
		const payload = JSON.stringify(status, null, 2);
		await writeFile(tmp, payload, "utf8");
		await chmod(tmp, 0o600).catch(() => undefined);
		await rename(tmp, this.statusFile);
	}
}
