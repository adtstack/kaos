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

const BLOB_LOCAL_BACKUP_ARTIFACT_NAME_RE =
	/^(.+) \(KAOS local backup (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z) ([0-9a-f]{16})\)(\.[^/.]+)?$/;

const BASE_BLOB_CONFLICT_ARTIFACT_NAME_RE =
	/^(?:.+ \(KAOS remote conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\)|.+ \(KAOS local backup \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z [0-9a-f]{16}\))(?:\.[^/.]+)?$/;

export type ConflictArtifactKind = "markdown" | "blob";
export type MarkdownConflictArtifactSource = "disk" | "crdt" | "editor";
export type ConflictArtifactSource = MarkdownConflictArtifactSource | "remote" | "local";
export type ConflictArtifactOriginalConfidence = "candidate" | "possibly-truncated";

export interface BuildMarkdownConflictArtifactPathOptions {
	deviceName: string;
	source?: MarkdownConflictArtifactSource;
	date?: Date;
}

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
	return BLOB_CONFLICT_ARTIFACT_NAME_RE.test(name)
		|| BLOB_LOCAL_BACKUP_ARTIFACT_NAME_RE.test(name);
}

export function isBaseBlobConflictArtifactPath(path: string): boolean {
	const name = normalizeSlashes(path).split("/").pop() ?? path;
	return BASE_BLOB_CONFLICT_ARTIFACT_NAME_RE.test(name);
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
	if (match) {
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
	const localBackup = BLOB_LOCAL_BACKUP_ARTIFACT_NAME_RE.exec(name);
	if (!localBackup) return null;
	const base = localBackup[1];
	const stamp = localBackup[2];
	if (!base || !stamp) return null;
	const ext = localBackup[4] ?? "";
	return {
		kind: "blob",
		artifactPath: normalized,
		inferredOriginalPath: `${dir}${base}${ext}`,
		originalPathConfidence: base.length >= 180 ? "possibly-truncated" : "candidate",
		source: "local",
		deviceName: null,
		timestamp: stampToIso(stamp),
		copyIndex: null,
	};
}

export function buildMarkdownConflictArtifactPath(
	path: string,
	options: BuildMarkdownConflictArtifactPathOptions,
): string {
	const { dir, name } = splitPath(path);
	const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : -1;
	const base = dot >= 0 ? name.slice(0, dot) : name;
	const ext = dot >= 0 ? name.slice(dot) : ".md";
	const device = sanitizeMarkdownConflictDeviceName(options.deviceName);
	const stamp = formatConflictArtifactStamp(options.date ?? new Date());
	const cappedBase = base.slice(0, 100);
	const sourcePart = options.source ? ` - ${options.source}` : "";
	const suffix = ` (KAOS conflict${sourcePart} from ${device} ${stamp})`;
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	const finalBase = cappedBase.length > maxBase
		? cappedBase.slice(0, maxBase)
		: cappedBase;
	return `${dir}${finalBase}${suffix}${ext}`;
}

export function buildMarkdownConflictArtifactCopyPath(basePath: string, copyIndex: number): string {
	if (!Number.isInteger(copyIndex) || copyIndex <= 1) return basePath;
	return basePath.replace(/(\.md)?$/, ` ${copyIndex}$1`);
}

export function isMarkdownConflictArtifactForOriginalPath(
	candidate: string,
	originalPath: string,
	source?: MarkdownConflictArtifactSource,
): boolean {
	const { dir, name } = splitPath(originalPath);
	const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : -1;
	const base = dot >= 0 ? name.slice(0, dot) : name;
	const ext = dot >= 0 ? name.slice(dot) : ".md";
	const cappedBase = base.slice(0, 100);
	const sourcePart = source ? ` - ${source}` : "";
	const escapedDir = escapeRegExp(dir);
	const escapedBase = escapeRegExp(cappedBase);
	const escapedSourcePart = escapeRegExp(sourcePart);
	const escapedExt = escapeRegExp(ext);
	const re = new RegExp(
		`^${escapedDir}${escapedBase} \\(KAOS conflict${escapedSourcePart} from [^/]+ ` +
		`\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\)(?: \\d+)?${escapedExt}$`,
	);
	return isMarkdownConflictArtifactPath(candidate) && re.test(candidate.replace(/\\/g, "/"));
}

export function buildBlobConflictArtifactPath(path: string, date = new Date()): string {
	const normalized = normalizeSlashes(path);
	const { dir, name } = splitPath(normalized);
	const dot = name.lastIndexOf(".");
	const stamp = formatConflictArtifactStamp(date);
	const suffix = ` (KAOS remote conflict ${stamp})`;
	const ext = dot > 0 ? name.slice(dot) : "";
	const base = dot > 0 ? name.slice(0, dot) : name;
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	const cappedBase = base.length > maxBase ? base.slice(0, maxBase) : base;
	return `${dir}${cappedBase}${suffix}${ext}`;
}

export function buildBlobConflictArtifactCopyPath(basePath: string, copyIndex: number): string {
	if (!Number.isInteger(copyIndex) || copyIndex <= 1) return basePath;
	return basePath.replace(/(\.[^/.]+)?$/, ` ${copyIndex}$1`);
}

export function buildBlobLocalBackupArtifactPath(
	path: string,
	operationId: string,
	date = new Date(),
): string {
	if (!/^[0-9a-f]{16}$/.test(operationId)) {
		throw new Error("blob local backup operationId must be 16 lowercase hex characters");
	}
	const normalized = normalizeSlashes(path);
	const { dir, name } = splitPath(normalized);
	const dot = name.lastIndexOf(".");
	const stamp = formatConflictArtifactStamp(date);
	const suffix = ` (KAOS local backup ${stamp} ${operationId})`;
	const ext = dot > 0 ? name.slice(dot) : "";
	const base = dot > 0 ? name.slice(0, dot) : name;
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	const cappedBase = base.length > maxBase ? base.slice(0, maxBase) : base;
	return `${dir}${cappedBase}${suffix}${ext}`;
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

function formatConflictArtifactStamp(date: Date): string {
	return date
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[:]/g, "-");
}

function sanitizeMarkdownConflictDeviceName(deviceName: string): string {
	return (deviceName
		.replace(/[\\/:*?"<>|]/g, "-")
		.trim() || "unknown-device").slice(0, 50);
}

function parseCopyIndex(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isMarkdownSource(value: string | undefined): value is "disk" | "crdt" | "editor" {
	return value === "disk" || value === "crdt" || value === "editor";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
