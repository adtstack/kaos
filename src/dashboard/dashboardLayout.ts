import type { DashboardMetric } from "./dashboardTypes";

export type KaosDashboardMode = "desktop" | "phone";

export interface KaosDashboardPlatform {
	isMobile: boolean;
	isPhone: boolean;
	isTablet: boolean;
}

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
