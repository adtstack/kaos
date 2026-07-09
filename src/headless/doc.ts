import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import {
	decodeFileMeta,
	ensureNestedMetaEntry,
	isFileMetaDeletedValue,
} from "../sync/fileMeta";
import { ORIGIN_DISK_SYNC, ORIGIN_SEED } from "../sync/origins";
import { SCHEMA_VERSION } from "../sync/schema";
import { normalizeVaultPath } from "./path";

export const HEADLESS_CLIENT_KIND = "kaos-headless";

export interface HeadlessMarkdownEntry {
	path: string;
	fileId: string;
	text: Y.Text;
	content: string;
	mtime: number | null;
	device: string | null;
}

export interface HeadlessTombstoneEntry {
	path: string;
	fileId: string;
	deletedAt: number | null;
}

export class HeadlessVaultDoc {
	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
	readonly sys: Y.Map<unknown>;

	constructor(readonly doc: Y.Doc) {
		this.pathToId = doc.getMap<string>("pathToId");
		this.idToText = doc.getMap<Y.Text>("idToText");
		this.meta = doc.getMap("meta");
		this.sys = doc.getMap("sys");
	}

	markSchemaCurrent(deviceName: string): void {
		const current = this.schemaVersion;
		if (current >= SCHEMA_VERSION) return;
		this.doc.transact(() => {
			this.sys.set("schemaVersion", SCHEMA_VERSION);
			this.sys.set("schemaUpdatedAt", Date.now());
			this.sys.set("schemaUpdatedBy", deviceName);
		}, ORIGIN_SEED);
	}

	get schemaVersion(): number {
		const raw = this.sys.get("schemaVersion");
		return typeof raw === "number" && Number.isInteger(raw) ? raw : 1;
	}

	getActiveMarkdownEntries(): Map<string, HeadlessMarkdownEntry> {
		const active = new Map<string, HeadlessMarkdownEntry>();

		this.meta.forEach((value: unknown, fileId: string) => {
			const decoded = decodeFileMeta(value);
			if (!decoded || decoded.deleted === true || typeof decoded.deletedAt === "number") {
				return;
			}
			const text = this.idToText.get(fileId);
			if (!text) return;
			const path = normalizeVaultPath(decoded.path);
			const candidate: HeadlessMarkdownEntry = {
				path,
				fileId,
				text,
				content: text.toString(),
				mtime: decoded.mtime ?? null,
				device: decoded.device ?? null,
			};
			const previous = active.get(path);
			if (!previous || this.compareEntryWinner(candidate, previous) > 0) {
				active.set(path, candidate);
			}
		});

		// Legacy v1 fallback for rooms that have not populated meta yet.
		if (active.size === 0) {
			this.pathToId.forEach((fileId, rawPath) => {
				const text = this.idToText.get(fileId);
				if (!text) return;
				const path = normalizeVaultPath(rawPath);
				active.set(path, {
					path,
					fileId,
					text,
					content: text.toString(),
					mtime: null,
					device: null,
				});
			});
		}

		return active;
	}

	getTombstones(): Map<string, HeadlessTombstoneEntry[]> {
		const tombstones = new Map<string, HeadlessTombstoneEntry[]>();
		this.meta.forEach((value: unknown, fileId: string) => {
			const decoded = decodeFileMeta(value);
			if (!decoded || !isFileMetaDeletedValue(value)) return;
			const path = normalizeVaultPath(decoded.path);
			const list = tombstones.get(path) ?? [];
			list.push({
				path,
				fileId,
				deletedAt: decoded.deletedAt ?? decoded.mtime ?? null,
			});
			tombstones.set(path, list);
		});
		return tombstones;
	}

	getActiveEntry(path: string): HeadlessMarkdownEntry | null {
		return this.getActiveMarkdownEntries().get(normalizeVaultPath(path)) ?? null;
	}

	ensureMarkdownFile(
		path: string,
		content: string,
		deviceName: string,
		options: { reviveTombstone?: boolean } = {},
	): HeadlessMarkdownEntry | null {
		const normalized = normalizeVaultPath(path);
		const existing = this.getActiveEntry(normalized);
		if (existing) return existing;

		const tombstones = this.getTombstones().get(normalized) ?? [];
		if (tombstones.length > 0 && options.reviveTombstone !== true) {
			return null;
		}

		const fileId = `h-${randomBytes(12).toString("base64url")}`;
		const text = new Y.Text();
		this.doc.transact(() => {
			for (const tombstone of tombstones) {
				this.meta.delete(tombstone.fileId);
			}
			text.insert(0, content);
			this.idToText.set(fileId, text);
			this.setMetaActive(fileId, normalized, deviceName);
		}, ORIGIN_DISK_SYNC);

		return {
			path: normalized,
			fileId,
			text,
			content,
			mtime: Date.now(),
			device: deviceName,
		};
	}

	replaceMarkdownContent(path: string, content: string, deviceName: string): HeadlessMarkdownEntry | null {
		const normalized = normalizeVaultPath(path);
		const entry = this.getActiveEntry(normalized);
		if (!entry) return null;
		this.doc.transact(() => {
			entry.text.delete(0, entry.text.length);
			entry.text.insert(0, content);
			this.setMetaActive(entry.fileId, normalized, deviceName);
		}, ORIGIN_DISK_SYNC);
		return {
			...entry,
			content,
			mtime: Date.now(),
			device: deviceName,
		};
	}

	tombstoneMarkdown(path: string, deviceName: string): boolean {
		const normalized = normalizeVaultPath(path);
		const entry = this.getActiveEntry(normalized);
		if (!entry) return false;
		this.doc.transact(() => {
			const metaEntry = ensureNestedMetaEntry(this.meta, entry.fileId, {
				shape: "flat",
				path: normalized,
				deletedAt: Date.now(),
			});
			if (!metaEntry) return;
			metaEntry.set("path", normalized);
			metaEntry.set("deletedAt", Date.now());
			metaEntry.delete("deleted");
			metaEntry.delete("mtime");
			metaEntry.set("device", deviceName);
		}, ORIGIN_DISK_SYNC);
		return true;
	}

	private setMetaActive(fileId: string, path: string, deviceName: string): void {
		const entry = ensureNestedMetaEntry(this.meta, fileId, {
			shape: "flat",
			path,
			mtime: Date.now(),
			device: deviceName,
		});
		if (!entry) return;
		entry.set("path", path);
		entry.set("mtime", Date.now());
		entry.set("device", deviceName);
		entry.delete("deleted");
		entry.delete("deletedAt");
	}

	private compareEntryWinner(a: HeadlessMarkdownEntry, b: HeadlessMarkdownEntry): number {
		const mtimeDelta = (a.mtime ?? 0) - (b.mtime ?? 0);
		if (mtimeDelta !== 0) return mtimeDelta;
		return a.fileId.localeCompare(b.fileId);
	}
}
