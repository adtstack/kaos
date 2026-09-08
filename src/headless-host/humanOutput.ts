import type { HeadlessDaemonStatus } from "./kaos/daemonStatePublisher";

export type HeadlessLiveStatus = Partial<{
	[K in keyof HeadlessDaemonStatus]: Partial<HeadlessDaemonStatus[K]>;
}>;

export interface HeadlessStatusOutput {
	vaultRoot: string;
	dataFile: string;
	lockFile: string;
	pluginDir: string;
	lock: Record<string, unknown>;
	configured: Record<string, unknown>;
	live?: HeadlessLiveStatus | null;
}

export interface HeadlessDoctorOutput {
	ok: boolean;
	lock: Record<string, unknown>;
	checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export function shouldUseHumanOutput(isTTY: boolean | undefined, forceJson: boolean): boolean {
	return isTTY === true && !forceJson;
}

export function formatHeadlessStatus(status: HeadlessStatusOutput): string {
	const rows: Array<[string, string]> = [];
	const live = status.live;

	let runtimeSummary = formatLockSummary(status.lock);
	if (live?.daemon?.alive === true && typeof live.daemon?.uptimeSeconds === "number") {
		const mins = Math.floor(live.daemon.uptimeSeconds / 60);
		const memMb = typeof live.daemon.memoryRssBytes === "number"
			? ` · ${Math.round(live.daemon.memoryRssBytes / (1024 * 1024))}MB`
			: "";
		runtimeSummary += ` (uptime ${mins}m${memMb})`;
	}
	rows.push(["Runtime", runtimeSummary]);

	if (live?.connection?.status) {
		let connText = String(live.connection.status);
		if (typeof live.connection.rttMs === "number") {
			connText += ` · RTT ${live.connection.rttMs}ms`;
		}
		rows.push(["Sync status", connText]);
	}

	if (live?.sync) {
		const syncParts: string[] = [];
		if (live.sync.serverAppliedLocalState === true) syncParts.push("in-sync");
		if (live.sync.reconcileInFlight === true) syncParts.push("reconciling");
		if (typeof live.sync.activeMarkdownPathsCount === "number") {
			syncParts.push(`${live.sync.activeMarkdownPathsCount} tracked files`);
		}
		if (syncParts.length > 0) {
			rows.push(["Sync state", syncParts.join(", ")]);
		}
	}

	if (live?.attention !== undefined) {
		const count = Number(live.attention.totalCount ?? 0);
		rows.push(["Attention", count > 0 ? `${count} items needing review` : "0 items (clean)"]);
	}

	rows.push(["Vault", status.vaultRoot]);
	rows.push(["Data", status.dataFile]);
	rows.push(["Lock", status.lockFile]);
	rows.push(["Plugin", status.pluginDir]);
	rows.push(["Worker", formatConfiguredValue(status.configured.host)]);
	rows.push(["Vault ID", formatConfiguredValue(status.configured.vaultId)]);
	rows.push(["Device", formatConfiguredValue(status.configured.deviceName)]);
	rows.push(["Device key", status.configured.identityFileConfigured === true ? "configured" : "not configured"]);

	let attachText = formatAttachmentSetting(status.configured.enableAttachmentSync);
	if (live?.attachments?.transferStatus) {
		attachText += ` · ${live.attachments.transferStatus}`;
	} else if (
		live?.attachments &&
		((live.attachments.pendingUploads ?? 0) > 0 || (live.attachments.pendingDownloads ?? 0) > 0)
	) {
		attachText += ` · pending: ↑${live.attachments.pendingUploads ?? 0} ↓${live.attachments.pendingDownloads ?? 0}`;
	}
	rows.push(["Attachments", attachText]);

	return formatHumanRows("KAOS Headless Host", rows);
}

export function formatHeadlessDoctor(doctor: HeadlessDoctorOutput): string {
	const lines = [
		`KAOS Headless Doctor — ${doctor.ok ? "PASS" : "FAIL"}`,
		"",
		`Runtime  ${formatLockSummary(doctor.lock)}`,
		"",
		...doctor.checks.map((check) => {
			const detail = check.detail ? ` — ${safeHumanText(check.detail)}` : "";
			return `${check.ok ? "PASS" : "FAIL"}  ${safeHumanText(check.name)}${detail}`;
		}),
	];
	if (!doctor.ok) lines.push("", "One or more checks failed. Review the FAIL entries above.");
	return lines.join("\n");
}

function formatHumanRows(title: string, rows: Array<[string, string]>): string {
	const labelWidth = rows.reduce((width, [label]) => Math.max(width, label.length), 0);
	return [
		title,
		"",
		...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${safeHumanText(value)}`),
	].join("\n");
}

function formatLockSummary(lock: Record<string, unknown>): string {
	if (lock.held !== true) return "no active lock";
	const info = typeof lock.info === "object" && lock.info !== null
		? lock.info as Record<string, unknown>
		: null;
	const pid = typeof info?.pid === "number" ? ` · PID ${info.pid}` : "";
	if (info?.processAlive === true) return `running${pid}`;
	if (info?.processAlive === false) return `stale lock${pid}`;
	return `lock present${pid}`;
}

function formatConfiguredValue(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "not configured";
}

function formatAttachmentSetting(value: unknown): string {
	if (value === true) return "enabled";
	if (value === false) return "disabled";
	return "default";
}

function safeHumanText(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || codePoint === 127 ? " " : character;
	}).join("");
}
