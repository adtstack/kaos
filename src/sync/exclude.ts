/** Paths that are always excluded, regardless of user settings. */
export const KAOS_EXCLUDE_FILE_PATH = "SYSTEM/SETTING/kaos-exclude.md";

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
	".backup",
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

/**
 * The exclude control file is ordinary vault content so KAOS can distribute
 * one shared policy to every device. It must remain syncable even when a
 * broader user prefix (for example `SYSTEM/SETTING/`) would otherwise match.
 */
export function isKaosExcludeFilePath(path: string): boolean {
	return normalizePrefix(path) === KAOS_EXCLUDE_FILE_PATH;
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
	if (isKaosExcludeFilePath(normalizedPath)) return false;
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
	return mergeExcludePatterns(raw.split(","));
}

/**
 * Parse the shared exclude control file.
 *
 * Each non-empty, non-comment line is a vault-relative path prefix. A UTF-8
 * BOM and CRLF line endings are accepted so the same file works across every
 * supported desktop/headless environment.
 */
export function parseKaosExcludeFile(raw: string): string[] {
	return mergeExcludePatterns(
		raw
			.replace(/^\uFEFF/, "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#")),
	);
}

/** Stable, normalized union used for legacy settings plus the shared file. */
export function mergeExcludePatterns(
	...groups: ReadonlyArray<readonly string[]>
): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const group of groups) {
		for (const rawPattern of group) {
			const pattern = normalizePrefix(rawPattern.trim());
			if (!pattern || seen.has(pattern)) continue;
			seen.add(pattern);
			merged.push(pattern);
		}
	}
	return merged;
}
