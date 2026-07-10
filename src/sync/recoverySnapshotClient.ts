import * as Y from "yjs";
import { gunzipSync } from "fflate";
import type { VaultSyncSettings } from "../settings";
import type { FileMeta } from "../types";
import { appendTraceParams, type TraceHttpContext } from "../observability/traceContext";
import { obsidianRequest } from "../utils/http";
import { createNestedActiveMeta, decodeFileMeta, isFileMetaDeletedValue } from "./fileMeta";
import { ORIGIN_RESTORE } from "./origins";

export type FileHistoryManifestKind = "file-history";
export type FileHistoryStorageVersion = "v2";
export type FileHistoryEntryKind =
	| "created"
	| "modified"
	| "renamed"
	| "deleted"
	| "restored";

export interface FileHistoryEntry {
	fileId: string;
	kind: FileHistoryEntryKind;
	path: string;
	oldPath?: string;
	newPath?: string;
	contentHash?: string;
	previousContentHash?: string;
	deleted?: boolean;
	size?: number;
	mtime?: number;
	device?: string;
}

export interface FileHistoryManifestIndex {
	storageVersion: FileHistoryStorageVersion;
	manifestId: string;
	vaultId: string;
	kind: FileHistoryManifestKind;
	createdAt: string;
	day: string;
	reason: string;
	pinned: boolean;
	changedCount: number;
	contentHashes: string[];
	changedEntries: FileHistoryEntry[];
	stateHash: string;
	manifestHash: string;
	crdtSchemaVersion?: number;
}

export interface FileHistoryManifest extends FileHistoryManifestIndex {
	schemaVersion: 3;
}

export interface FileHistoryPointProgress {
	uploadedContentCount: number;
	totalContentCount: number;
	remainingContentCount: number;
}

export interface FileHistoryPointResult {
	status: "created" | "noop" | "unavailable" | "pending";
	manifestId?: string;
	reason?: string;
	index?: FileHistoryManifestIndex;
	pending?: FileHistoryPointProgress;
}

export interface FileHistoryManifestList {
	manifests: FileHistoryManifestIndex[];
	totalManifestKeys: number;
	limited: boolean;
	nextCursor: string | null;
}

export interface FileHistoryRetentionResult {
	kept: number;
	prunedManifests: number;
	contentDeleted: number;
	failed: number;
	errors: string[];
}

export type RecoveryManifestKind = FileHistoryManifestKind;
export type RecoveryStorageVersion = FileHistoryStorageVersion;
export type RecoveryEntryKind = FileHistoryEntryKind;
export type RecoveryManifestEntry = FileHistoryEntry;
export type RecoveryManifestIndex = FileHistoryManifestIndex;
export type RecoveryManifest = FileHistoryManifest;
export type RecoverySnapshotResult = FileHistoryPointResult;
export type RecoveryManifestList = FileHistoryManifestList;
export type RecoveryRetentionResult = FileHistoryRetentionResult;

export type RecoveryStorageAuditStatus = "healthy" | "repaired" | "degraded" | "empty" | "unavailable";
export type RecoveryStorageIssueSeverity = "warn" | "error";

export interface RecoveryStorageIssue {
	kind: string;
	severity: RecoveryStorageIssueSeverity;
	message: string;
	manifestId?: string;
	objectKey?: string;
	repairable: boolean;
	repaired: boolean;
}

export interface RecoveryStorageRepair {
	kind: string;
	message: string;
	manifestId?: string;
	objectKey?: string;
	success: boolean;
}

export interface RecoveryStorageAuditReport {
	status: RecoveryStorageAuditStatus;
	checkedAt: string;
	latestManifestId: string | null;
	latestIndexManifestId: string | null;
	latestStateManifestId: string | null;
	manifestCount: number;
	manifestCountLowerBound: number;
	checkedManifestCount: number;
	issues: RecoveryStorageIssue[];
	repairs: RecoveryStorageRepair[];
	contentCheckLimited: boolean;
}

export interface RestoreRecoveryVersionOptions {
	fileId: string;
	path: string;
	content: string;
	expectedCurrentHash: string | null;
	device?: string;
}

export interface RestoreRecoveryVersionResult {
	restored: boolean;
	undeletion: boolean;
	reason?: "current-hash-mismatch" | "missing-live-text";
	currentHash: string | null;
}

function baseUrl(settings: VaultSyncSettings): string {
	const host = settings.host.replace(/\/$/, "");
	return `${host}/vault/${encodeURIComponent(settings.vaultId)}`;
}

async function serverPost(
	settings: VaultSyncSettings,
	endpoint: string,
	body?: Record<string, unknown>,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(`${baseUrl(settings)}/${endpoint}`, trace);
	const res = await obsidianRequest({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${settings.token}`,
		},
		body: body ? JSON.stringify(body) : "{}",
		contentType: "application/json",
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Server ${endpoint} failed (${res.status}): ${res.text}`);
	}
	return res.json;
}

async function serverGet(
	settings: VaultSyncSettings,
	endpoint: string,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(`${baseUrl(settings)}/${endpoint}`, trace);
	const res = await obsidianRequest({
		url,
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.token}`,
		},
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Server ${endpoint} failed (${res.status}): ${res.text}`);
	}
	return res.json;
}

export async function requestFileHistoryPointMaybe(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
	forceFull = false,
): Promise<FileHistoryPointResult> {
	return await serverPost(settings, "recovery-snapshots/maybe", { device, forceFull }, trace) as FileHistoryPointResult;
}

export const requestRecoverySnapshotMaybe = requestFileHistoryPointMaybe;

export async function listFileHistoryManifests(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
	limit = 50,
	cursor?: string,
): Promise<FileHistoryManifestList> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (cursor) params.set("cursor", cursor);
	return await serverGet(settings, `recovery-snapshots?${params.toString()}`, trace) as FileHistoryManifestList;
}

export const listRecoverySnapshots = listFileHistoryManifests;

export function normalizeRecoveryStorageAuditReport(value: unknown): RecoveryStorageAuditReport {
	const raw = typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};
	const status = normalizeRecoveryStorageAuditStatus(raw.status);
	const issues = Array.isArray(raw.issues)
		? raw.issues.map(normalizeRecoveryStorageIssue)
		: [];
	const repairs = Array.isArray(raw.repairs)
		? raw.repairs.map(normalizeRecoveryStorageRepair)
		: [];
	const manifestCount = numberOr(raw.manifestCount, numberOr(raw.manifestCountLowerBound, 0));
	return {
		status,
		checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : new Date(0).toISOString(),
		latestManifestId: stringOrNull(raw.latestManifestId),
		latestIndexManifestId: stringOrNull(raw.latestIndexManifestId),
		latestStateManifestId: stringOrNull(raw.latestStateManifestId),
		manifestCount,
		manifestCountLowerBound: numberOr(raw.manifestCountLowerBound, manifestCount),
		checkedManifestCount: numberOr(raw.checkedManifestCount, 0),
		issues,
		repairs,
		contentCheckLimited: raw.contentCheckLimited === true,
	};
}

export async function getFileHistoryStorageStatus(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
): Promise<RecoveryStorageAuditReport> {
	return normalizeRecoveryStorageAuditReport(await serverGet(settings, "recovery-snapshots/status", trace));
}

export const getRecoveryStorageStatus = getFileHistoryStorageStatus;

export async function repairFileHistoryStorage(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
): Promise<RecoveryStorageAuditReport> {
	return normalizeRecoveryStorageAuditReport(await serverPost(settings, "recovery-snapshots/repair", {}, trace));
}

export const repairRecoveryStorage = repairFileHistoryStorage;

export async function cleanupFileHistoryStorage(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
): Promise<FileHistoryRetentionResult> {
	return await serverPost(settings, "recovery-snapshots/prune", {}, trace) as FileHistoryRetentionResult;
}

export async function downloadFileHistoryManifest(
	settings: VaultSyncSettings,
	manifestId: string,
	trace?: TraceHttpContext,
): Promise<FileHistoryManifest> {
	return await serverGet(settings, `recovery-snapshots/${encodeURIComponent(manifestId)}/manifest`, trace) as FileHistoryManifest;
}

export const downloadRecoveryManifest = downloadFileHistoryManifest;

export async function downloadFileHistoryContent(
	settings: VaultSyncSettings,
	hash: string,
	trace?: TraceHttpContext,
): Promise<string> {
	const url = appendTraceParams(`${baseUrl(settings)}/recovery-content/${encodeURIComponent(hash)}`, trace);
	const res = await obsidianRequest({
		url,
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.token}`,
		},
	});
	if (res.status !== 200) {
		throw new Error(`File history content download failed (${res.status}): ${res.text}`);
	}
	const raw = gunzipSync(new Uint8Array(res.arrayBuffer));
	const text = new TextDecoder().decode(raw);
	const actualHash = await sha256Hex(text);
	if (actualHash !== hash) {
		throw new Error(`File history content hash mismatch: expected ${hash}, got ${actualHash}`);
	}
	return text;
}

export const downloadRecoveryContent = downloadFileHistoryContent;

export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRecoveryStorageAuditStatus(value: unknown): RecoveryStorageAuditStatus {
	switch (value) {
		case "healthy":
		case "repaired":
		case "degraded":
		case "empty":
		case "unavailable":
			return value;
		default:
			return "unavailable";
	}
}

function normalizeRecoveryStorageIssue(value: unknown): RecoveryStorageIssue {
	const raw = typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};
	return {
		kind: typeof raw.kind === "string" ? raw.kind : "unknown",
		severity: raw.severity === "warn" ? "warn" : "error",
		message: typeof raw.message === "string" ? raw.message : "",
		manifestId: typeof raw.manifestId === "string" ? raw.manifestId : undefined,
		objectKey: typeof raw.objectKey === "string" ? raw.objectKey : undefined,
		repairable: raw.repairable === true,
		repaired: raw.repaired === true,
	};
}

function normalizeRecoveryStorageRepair(value: unknown): RecoveryStorageRepair {
	const raw = typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};
	return {
		kind: typeof raw.kind === "string" ? raw.kind : "unknown",
		message: typeof raw.message === "string" ? raw.message : "",
		manifestId: typeof raw.manifestId === "string" ? raw.manifestId : undefined,
		objectKey: typeof raw.objectKey === "string" ? raw.objectKey : undefined,
		success: raw.success === true,
	};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function normalizeVaultPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function getStoredSchemaVersion(doc: Y.Doc): number | null {
	const stored = doc.getMap("sys").get("schemaVersion");
	if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 0) return null;
	return stored;
}

function usesV2MetaPathModel(doc: Y.Doc): boolean {
	const version = getStoredSchemaVersion(doc);
	return version !== null && version >= 2;
}

function usesNestedMetaModel(doc: Y.Doc): boolean {
	const version = getStoredSchemaVersion(doc);
	return version !== null && version >= 3;
}

function collectActiveMarkdownPaths(doc: Y.Doc): Map<string, string> {
	const meta = doc.getMap<unknown>("meta");
	const pathToId = doc.getMap<string>("pathToId");
	const resolved = new Map<string, string>();

	if (usesV2MetaPathModel(doc)) {
		meta.forEach((entry, fileId) => {
			const decoded = decodeFileMeta(entry);
			if (!decoded || isFileMetaDeletedValue(entry)) return;
			const path = normalizeVaultPath(decoded.path);
			if (!path) return;
			resolved.set(path, fileId);
		});
		return resolved;
	}

	pathToId.forEach((fileId, rawPath) => {
		const path = normalizeVaultPath(rawPath);
		if (!path) return;
		const entry = meta.get(fileId);
		if (isFileMetaDeletedValue(entry)) return;
		resolved.set(path, fileId);
	});

	meta.forEach((entry, fileId) => {
		const decoded = decodeFileMeta(entry);
		if (!decoded || isFileMetaDeletedValue(entry)) return;
		const path = normalizeVaultPath(decoded.path);
		if (!path || resolved.has(path)) return;
		resolved.set(path, fileId);
	});

	return resolved;
}

export function getLiveContentForFileVersion(
	liveDoc: Y.Doc,
	fileId: string,
	path: string,
): string | null {
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const livePaths = collectActiveMarkdownPaths(liveDoc);
	const liveFileId = livePaths.get(normalizeVaultPath(path)) ?? fileId;
	const liveText = liveIdToText.get(liveFileId);
	return liveText?.toJSON() ?? null;
}

export async function getLiveHashForFileVersion(
	liveDoc: Y.Doc,
	fileId: string,
	path: string,
): Promise<string | null> {
	const content = getLiveContentForFileVersion(liveDoc, fileId, path);
	return content === null ? null : await sha256Hex(content);
}

export async function restoreRecoveryVersionToLiveDoc(
	liveDoc: Y.Doc,
	options: RestoreRecoveryVersionOptions,
): Promise<RestoreRecoveryVersionResult> {
	const path = normalizeVaultPath(options.path);
	const currentContent = getLiveContentForFileVersion(liveDoc, options.fileId, path);
	const currentHash = currentContent === null ? null : await sha256Hex(currentContent);
	if (currentHash !== options.expectedCurrentHash) {
		return {
			restored: false,
			undeletion: false,
			reason: "current-hash-mismatch",
			currentHash,
		};
	}

	const livePathToId = liveDoc.getMap<string>("pathToId");
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const liveMeta = liveDoc.getMap<unknown>("meta");
	const liveUsesV2 = usesV2MetaPathModel(liveDoc);
	const liveUsesNestedMeta = usesNestedMetaModel(liveDoc);
	const livePaths = collectActiveMarkdownPaths(liveDoc);
	const activeFileId = livePaths.get(path);
	const targetFileId = activeFileId ?? options.fileId;
	const undeletion = !activeFileId;

	liveDoc.transact(() => {
		let liveText = liveIdToText.get(targetFileId);
		if (!liveText) {
			liveText = new Y.Text();
			liveIdToText.set(targetFileId, liveText);
		}
		if (liveText.length > 0) {
			liveText.delete(0, liveText.length);
		}
		if (options.content.length > 0) {
			liveText.insert(0, options.content);
		}

		if (!liveUsesV2) {
			livePathToId.set(path, targetFileId);
		}

		const staleTombstones: string[] = [];
		liveMeta.forEach((entry, fileId) => {
			const decoded = decodeFileMeta(entry);
			if (
				fileId !== targetFileId &&
				decoded?.path === path &&
				isFileMetaDeletedValue(entry)
			) {
				staleTombstones.push(fileId);
			}
		});
		for (const staleId of staleTombstones) {
			liveMeta.delete(staleId);
		}

		liveMeta.set(
			targetFileId,
			liveUsesNestedMeta
				? createNestedActiveMeta(path, Date.now(), options.device)
				: {
					path,
					deleted: undefined,
					deletedAt: undefined,
					mtime: Date.now(),
					device: options.device,
				} satisfies FileMeta,
		);
	}, ORIGIN_RESTORE);

	return {
		restored: true,
		undeletion,
		currentHash,
	};
}
