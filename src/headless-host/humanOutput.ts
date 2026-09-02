export interface HeadlessStatusOutput {
	vaultRoot: string;
	dataFile: string;
	lockFile: string;
	pluginDir: string;
	lock: Record<string, unknown>;
	configured: Record<string, unknown>;
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
	return formatHumanRows("KAOS Headless Host", [
		["Runtime", formatLockSummary(status.lock)],
		["Vault", status.vaultRoot],
		["Data", status.dataFile],
		["Lock", status.lockFile],
		["Plugin", status.pluginDir],
		["Worker", formatConfiguredValue(status.configured.host)],
		["Vault ID", formatConfiguredValue(status.configured.vaultId)],
		["Device", formatConfiguredValue(status.configured.deviceName)],
		["Device key", status.configured.identityFileConfigured === true ? "configured" : "not configured"],
		["Attachments", formatAttachmentSetting(status.configured.enableAttachmentSync)],
	]);
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
