/**
 * Local markdown conflict artifacts are safety copies, not sync documents.
 *
 * Examples:
 *   note (KAOS conflict - disk from Laptop 2026-06-23T14-20-40Z).md
 *   note (KAOS conflict - crdt from iPad 2026-06-23T14-20-40Z) 2.md
 *   note (KAOS conflict from Old Device 2026-05-11T12-00-00Z).md
 */
const MARKDOWN_CONFLICT_ARTIFACT_RE =
	/(?:^|\/)[^/]+ \(KAOS conflict(?: - (?:crdt|disk|editor))? from [^/]+ \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\)(?: \d+)?\.md$/;

const MARKDOWN_CONFLICT_ARTIFACT_NAME_RE =
	/^(.+) \(KAOS conflict(?: - (crdt|disk|editor))? from (.+) (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\)(?: (\d+))?(\.md)$/;

const BLOB_CONFLICT_ARTIFACT_NAME_RE =
	/^(.+) \(KAOS remote conflict (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\)(?: (\d+))?(\.[^/.]+)?$/;

export type ConflictArtifactKind = "markdown" | "blob";
export type ConflictArtifactSource = "disk" | "crdt" | "editor" | "remote";
export type ConflictArtifactOriginalConfidence = "candidate" | "possibly-truncated";

export interface ParsedConflictArtifactPath {
	kind: ConflictArtifactKind;
	artifactPath: string;
	inferredOriginalPath: string;
	originalPathConfidence: ConflictArtifactOriginalConfidence;
	source: ConflictArtifactSource | null;
	deviceName: string | null;
	timestamp: string;
	copyIndex: number | null;
}

export function isMarkdownConflictArtifactPath(path: string): boolean {
	return MARKDOWN_CONFLICT_ARTIFACT_RE.test(path.replace(/\\/g, "/"));
}

export function isBlobConflictArtifactPath(path: string): boolean {
	const name = normalizeSlashes(path).split("/").pop() ?? path;
	return BLOB_CONFLICT_ARTIFACT_NAME_RE.test(name);
}

export function parseConflictArtifactPath(path: string): ParsedConflictArtifactPath | null {
	return parseMarkdownConflictArtifactPath(path) ?? parseBlobConflictArtifactPath(path);
}

export function parseMarkdownConflictArtifactPath(path: string): ParsedConflictArtifactPath | null {
	const normalized = normalizeSlashes(path);
	const { dir, name } = splitPath(normalized);
	const match = MARKDOWN_CONFLICT_ARTIFACT_NAME_RE.exec(name);
	if (!match) return null;
	const base = match[1];
	const source = match[2];
	const device = match[3];
	const stamp = match[4];
	const ext = match[6];
	if (!base || !ext) return null;
	if (!device || !stamp) return null;
	return {
		kind: "markdown",
		artifactPath: normalized,
		inferredOriginalPath: `${dir}${base}${ext}`,
		originalPathConfidence: base.length >= 100 ? "possibly-truncated" : "candidate",
		source: isMarkdownSource(source) ? source : null,
		deviceName: device,
		timestamp: stampToIso(stamp),
		copyIndex: parseCopyIndex(match[5]),
	};
}

export function parseBlobConflictArtifactPath(path: string): ParsedConflictArtifactPath | null {
	const normalized = normalizeSlashes(path);
	const { dir, name } = splitPath(normalized);
	const match = BLOB_CONFLICT_ARTIFACT_NAME_RE.exec(name);
	if (!match) return null;
	const base = match[1];
	const stamp = match[2];
	if (!base || !stamp) return null;
	const ext = match[4] ?? "";
	return {
		kind: "blob",
		artifactPath: normalized,
		inferredOriginalPath: `${dir}${base}${ext}`,
		originalPathConfidence: base.length >= 180 ? "possibly-truncated" : "candidate",
		source: "remote",
		deviceName: null,
		timestamp: stampToIso(stamp),
		copyIndex: parseCopyIndex(match[3]),
	};
}

function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf("/");
	return {
		dir: slash >= 0 ? path.slice(0, slash + 1) : "",
		name: slash >= 0 ? path.slice(slash + 1) : path,
	};
}

function stampToIso(stamp: string): string {
	return stamp.replace(
		/T(\d{2})-(\d{2})-(\d{2})Z$/,
		"T$1:$2:$3Z",
	);
}

function parseCopyIndex(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isMarkdownSource(value: string | undefined): value is "disk" | "crdt" | "editor" {
	return value === "disk" || value === "crdt" || value === "editor";
}
