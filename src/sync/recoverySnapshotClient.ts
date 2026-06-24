import * as Y from "yjs";
import { gunzipSync } from "fflate";
import type { VaultSyncSettings } from "../settings";
import type { FileMeta } from "../types";
import { appendTraceParams, type TraceHttpContext } from "../observability/traceContext";
import { obsidianRequest } from "../utils/http";
import { createNestedActiveMeta, decodeFileMeta, isFileMetaDeletedValue } from "./fileMeta";
import { ORIGIN_RESTORE } from "./origins";

export type RecoveryManifestKind = "full" | "delta";
export type RecoveryStorageVersion = "v2";
export type RecoveryEntryKind =
	| "created"
	| "modified"
	| "renamed"
	| "deleted"
	| "restored"
	| "unchanged"
	| "attachment-changed";

export interface RecoveryManifestEntry {
	fileId: string;
	kind: RecoveryEntryKind;
	path: string;
	oldPath?: string;
	newPath?: string;
	contentHash?: string;
	previousContentHash?: string;
	deleted?: boolean;
	size?: number;
	mtime?: number;
	device?: string;
	baseManifestId?: string;
}

export interface RecoveryManifestIndex {
	storageVersion?: RecoveryStorageVersion;
	manifestId: string;
	vaultId: string;
	kind: RecoveryManifestKind;
	createdAt: string;
	day: string;
	reason: string;
	pinned: boolean;
	baseManifestId?: string;
	baseFullManifestId?: string;
	changedCount: number;
	fullFileCount: number;
	contentHashes: string[];
	stateHash: string;
	manifestHash: string;
	crdtSchemaVersion?: number;
}

export interface RecoveryManifest extends RecoveryManifestIndex {
	schemaVersion: 1 | 2;
	entries: RecoveryManifestEntry[];
}

export interface RecoverySnapshotResult {
	status: "created" | "noop" | "unavailable";
	manifestId?: string;
	reason?: string;
	index?: RecoveryManifestIndex;
}

export interface RecoveryManifestList {
	manifests: RecoveryManifestIndex[];
	totalManifestKeys: number;
	limited: boolean;
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

export async function requestRecoverySnapshotMaybe(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
	forceFull = false,
): Promise<RecoverySnapshotResult> {
	return await serverPost(settings, "recovery-snapshots/maybe", { device, forceFull }, trace) as RecoverySnapshotResult;
}

export async function listRecoverySnapshots(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
	limit = 50,
): Promise<RecoveryManifestList> {
	return await serverGet(settings, `recovery-snapshots?limit=${encodeURIComponent(String(limit))}`, trace) as RecoveryManifestList;
}

export async function downloadRecoveryManifest(
	settings: VaultSyncSettings,
	manifestId: string,
	trace?: TraceHttpContext,
): Promise<RecoveryManifest> {
	return await serverGet(settings, `recovery-snapshots/${encodeURIComponent(manifestId)}/manifest`, trace) as RecoveryManifest;
}

export async function downloadRecoveryContent(
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
		throw new Error(`Recovery content download failed (${res.status}): ${res.text}`);
	}
	const raw = gunzipSync(new Uint8Array(res.arrayBuffer));
	const text = new TextDecoder().decode(raw);
	const actualHash = await sha256Hex(text);
	if (actualHash !== hash) {
		throw new Error(`Recovery content hash mismatch: expected ${hash}, got ${actualHash}`);
	}
	return text;
}

export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
