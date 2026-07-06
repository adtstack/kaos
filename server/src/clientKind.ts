const DEFAULT_SYNC_CLIENT_KIND = "obsidian";
const MAX_SYNC_CLIENT_KIND_LENGTH = 32;

export function parseSyncClientKind(url: URL): string {
	const raw = url.searchParams.get("clientKind") ?? url.searchParams.get("client");
	if (raw === null) return DEFAULT_SYNC_CLIENT_KIND;
	const sanitized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "_")
		.slice(0, MAX_SYNC_CLIENT_KIND_LENGTH);
	return sanitized || "unknown";
}
