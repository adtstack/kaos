/** Paths that are always excluded, regardless of user settings. */
const GENERATED_DIRECTORY_NAMES = new Set([
	"node_modules",
	"bower_components",
	"__pycache__",
	"dist",
	"build",
	"coverage",
	"out",
	"target",
]);

const GENERATED_FILE_NAMES = new Set([
	"thumbs.db",
	"desktop.ini",
]);

const TEMPORARY_FILE_SUFFIXES = [
	".tmp",
	".temp",
	".swp",
	".swo",
	".bak",
	".orig",
	".partial",
	".crdownload",
	".download",
	".autosave",
	".map",
] as const;

function normalizePrefix(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function alwaysExcludedPrefixes(configDir: string): string[] {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	return [
		`${normalizedConfigDir}/`,
		".trash/",
	];
}

function isInsideConfigDirectory(path: string, configDir: string): boolean {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	if (!normalizedConfigDir) return false;
	return (
		path === normalizedConfigDir ||
		path.startsWith(`${normalizedConfigDir}/`) ||
		path.includes(`/${normalizedConfigDir}/`)
	);
}

function hasHiddenPathSegment(path: string): boolean {
	return path.split("/").some((segment) =>
		segment.length > 1 && segment.startsWith("."),
	);
}

function isToolOrGeneratedPath(path: string): boolean {
	const segments = path.split("/").filter(Boolean);
	const filename = segments.at(-1)?.toLowerCase() ?? "";
	if (GENERATED_FILE_NAMES.has(filename)) return true;
	if (filename.startsWith("~$") || (filename.startsWith("#") && filename.endsWith("#"))) {
		return true;
	}
	if (TEMPORARY_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix))) {
		return true;
	}
	return segments.slice(0, -1).some((segment) =>
		GENERATED_DIRECTORY_NAMES.has(segment.toLowerCase()),
	);
}

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes configuration, hidden, temporary, and generated-tool paths,
 * plus any user-configured prefixes.
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude prefixes (e.g. ["templates/", ".trash/"])
 * @param configDir - Obsidian config directory name
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(path: string, patterns: string[], configDir: string): boolean {
	const normalizedPath = normalizePrefix(path);
	// Obsidian does not index hidden paths (including a nested/sample vault's
	// config directory) as ordinary TFiles. Treating them as attachments can
	// create an unrecoverable "File already exists" download race.
	if (
		isInsideConfigDirectory(normalizedPath, configDir) ||
		hasHiddenPathSegment(normalizedPath) ||
		isToolOrGeneratedPath(normalizedPath)
	) return true;
	for (const prefix of alwaysExcludedPrefixes(configDir)) {
		if (normalizedPath.startsWith(prefix)) return true;
	}
	for (const prefix of patterns) {
		if (normalizedPath.startsWith(normalizePrefix(prefix))) return true;
	}
	return false;
}

/**
 * Parse the comma-separated excludePatterns setting into a list of
 * trimmed, non-empty prefixes.
 */
export function parseExcludePatterns(raw: string): string[] {
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
