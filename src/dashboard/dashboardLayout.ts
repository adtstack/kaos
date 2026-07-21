import type {
	DashboardMetric,
	DashboardTone,
	KaosDashboardData,
} from "./dashboardTypes";

export type KaosDashboardMode = "desktop" | "phone";

export interface KaosDashboardPlatform {
	isMobile: boolean;
	isPhone: boolean;
	isTablet: boolean;
}

export interface DashboardHealthSummary {
	label: "Healthy" | "Working" | "Needs attention";
	headline: string;
	detail: string;
	tone: Extract<DashboardTone, "ok" | "busy" | "warn" | "error">;
}

type DashboardHealthInput = Pick<
	KaosDashboardData,
	| "overview"
	| "attentionTotalCount"
	| "conflicts"
	| "snapshotStatus"
	| "recoveryStorageStatus"
	| "recentChanges"
>;

const MOBILE_OVERVIEW_LABELS = new Set([
	"Status",
	"Connection",
	"Provider synced",
	"Local ready",
	"Disk writes",
	"Blob transfers",
	"Reconciled",
	"Untracked",
	"Safety brake",
	"Server receipt",
	"Blob failures",
]);

export function resolveKaosDashboardMode(platform: KaosDashboardPlatform): KaosDashboardMode {
	if (platform.isMobile && platform.isPhone && !platform.isTablet) return "phone";
	return "desktop";
}

export function selectMobileOverviewMetrics(metrics: DashboardMetric[]): DashboardMetric[] {
	return metrics.filter((metric) =>
		MOBILE_OVERVIEW_LABELS.has(metric.label) ||
		metric.tone === "error" ||
		metric.tone === "warn" ||
		metric.tone === "busy"
	);
}

/**
 * Builds presentation copy from the dashboard snapshot without consulting or
 * mutating any runtime service. Conflict and attention counts take precedence
 * over the lower-level metric tones so the first message matches the safest
 * next action for the user.
 */
export function deriveDashboardHealth(data: DashboardHealthInput): DashboardHealthSummary {
	const errors = data.overview.filter((metric) => metric.tone === "error");
	const recoveryErrors = collectRecoveryErrors(data);
	const warnings = data.overview.filter((metric) =>
		metric.tone === "warn"
		|| (
			(metric.label === "Status" || metric.label === "Connection")
			&& metric.tone === "muted"
		)
	);
	const busy = data.overview.filter((metric) => metric.tone === "busy");

	if (data.conflicts.length > 0) {
		return {
			label: "Needs attention",
			headline: countLabel(data.conflicts.length, "conflict needs review", "conflicts need review"),
			detail: data.attentionTotalCount > 0 || errors.length > 0 || recoveryErrors.length > 0
				? "Review the conflict copies and the other flagged sync conditions below."
				: "Compare the preserved versions below and choose the copy you want to keep.",
			tone: "error",
		};
	}

	if (errors.length > 0 || recoveryErrors.length > 0) {
		if (errors.length === 0) {
			return {
				label: "Needs attention",
				headline: "Recovery needs attention",
				detail: `Review ${recoveryErrors.join(", ")} in Recovery below.`,
				tone: "error",
			};
		}
		if (recoveryErrors.length > 0) {
			return {
				label: "Needs attention",
				headline: "KAOS needs attention",
				detail: `Review ${metricList(errors)} in Advanced diagnostics and ${recoveryErrors.join(", ")} in Recovery.`,
				tone: "error",
			};
		}
		return {
			label: "Needs attention",
			headline: "Sync needs attention",
			detail: `Review ${metricList(errors)} in Advanced diagnostics.`,
			tone: "error",
		};
	}

	if (data.attentionTotalCount > 0) {
		return {
			label: "Needs attention",
			headline: countLabel(data.attentionTotalCount, "item needs review", "items need review"),
			detail: "KAOS preserved these files so you can choose the safest next step.",
			tone: "warn",
		};
	}

	if (warnings.length > 0) {
		return {
			label: "Needs attention",
			headline: "Check sync status",
			detail: `Review ${metricList(warnings)} in Advanced diagnostics.`,
			tone: "warn",
		};
	}

	if (busy.length > 0) {
		return {
			label: "Working",
			headline: "Sync is in progress",
			detail: "KAOS is processing queued changes. No action is currently required.",
			tone: "busy",
		};
	}

	return {
		label: "Healthy",
		headline: "KAOS is ready",
		detail: "No local sync issues or review items are currently reported.",
		tone: "ok",
	};
}

/**
 * Only surface active failures here. Offline and unavailable states can be an
 * expected consequence of an unconfigured server or a server that deliberately
 * does not offer recovery storage; the overview connection metric already
 * communicates offline state. A completed audit marked degraded is actionable.
 */
function collectRecoveryErrors(
	data: Pick<DashboardHealthInput, "snapshotStatus" | "recoveryStorageStatus" | "recentChanges">,
): string[] {
	const labels: string[] = [];
	if (data.snapshotStatus.status === "error") labels.push("Vault snapshots");
	if (data.recentChanges.status === "error") labels.push("File history");
	if (
		data.recoveryStorageStatus.status === "error"
		|| (
			data.recoveryStorageStatus.status === "ready"
			&& data.recoveryStorageStatus.report.status === "degraded"
		)
	) {
		labels.push("Recovery storage");
	}
	return labels;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function metricList(metrics: DashboardMetric[]): string {
	const labels = metrics.slice(0, 2).map((metric) => metric.label);
	if (metrics.length > 2) labels.push(`${metrics.length - 2} more`);
	return labels.join(", ");
}
