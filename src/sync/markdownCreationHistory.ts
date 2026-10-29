import * as Y from "yjs";
import { canonicalizeVaultPath } from "../paths/canonicalPath";
import {
	buildMetaSnapshot, computeIncrementalMetaChanges, computeMetaSemanticChanges,
	extractAffectedFileIds,
} from "./fileMeta";
import type { FileHistoryManifestList } from "./recoverySnapshotClient";

const pathKey = (path: string): string => canonicalizeVaultPath(path).canonicalKey;

export interface MarkdownPathHistoryEntry {
	fileId: string;
	historyId: string;
}

export type MarkdownCreationHistory = Map<string, MarkdownPathHistoryEntry[]>;
export type MarkdownCreationHistoryLoader = (paths: readonly string[], authorityToken: string) => Promise<MarkdownCreationHistory>;

/** Reuse retained file history; never persist a second path-history database. */
export async function readMarkdownCreationHistory(
	paths: readonly string[] | null,
	list: (cursor?: string) => Promise<FileHistoryManifestList>,
): Promise<MarkdownCreationHistory> {
	const result: MarkdownCreationHistory = new Map(paths?.map(path => [pathKey(path), []]) ?? []);
	const cursors = new Set<string>();
	const manifests = new Set<string>();
	let total: number | undefined;
	let cursor: string | undefined;
	do {
		const page = await list(cursor);
		if (!Array.isArray(page.manifests) || typeof page.limited !== "boolean"
			|| !Number.isInteger(page.totalManifestKeys) || page.totalManifestKeys < 0) {
			throw new Error("File history returned an invalid page");
		}
		if (total !== undefined && total !== page.totalManifestKeys) throw new Error("File history changed during pagination");
		total = page.totalManifestKeys;
		for (const manifest of page.manifests) {
			if (typeof manifest.manifestId !== "string" || !manifest.manifestHash || !manifest.stateHash
				|| !Array.isArray(manifest.changedEntries) || manifests.has(manifest.manifestId)) {
				throw new Error("File history returned an invalid manifest");
			}
			manifests.add(manifest.manifestId);
			for (const entry of manifest.changedEntries) {
				if (typeof entry.fileId !== "string" || typeof entry.path !== "string") {
					throw new Error("File history returned an invalid file identity");
				}
				for (const candidate of [entry.path, entry.oldPath, entry.newPath]) {
					if (candidate === undefined) continue;
					if (typeof candidate !== "string") throw new Error("File history returned an invalid path");
					const key = pathKey(candidate);
					if (paths === null && !result.has(key)) result.set(key, []);
					const matches = result.get(key);
					if (matches && !matches.some(match => match.fileId === entry.fileId)) {
						matches.push({ fileId: entry.fileId, historyId: manifest.manifestId });
					}
				}
			}
		}
		if (!page.limited) break;
		if (!page.nextCursor || cursors.has(page.nextCursor)) {
			throw new Error("File history pagination is incomplete");
		}
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	if (manifests.size !== total) throw new Error("File history listing is incomplete");
	return result;
}

/** Read once per connection/structural epoch; new notes reuse the session index. */
export function createMarkdownCreationHistoryLoader(
	list: (cursor?: string) => Promise<FileHistoryManifestList>,
): MarkdownCreationHistoryLoader {
	let cachedToken: string | undefined;
	let cached: Promise<MarkdownCreationHistory> | undefined;
	return async (paths, token) => {
		if (!cached || cachedToken !== token) {
			cachedToken = token;
			const pending = readMarkdownCreationHistory(null, list);
			cached = pending;
			void pending.catch(() => { if (cached === pending) cached = undefined; });
		}
		const all = await cached;
		return new Map(paths.map(path => [pathKey(path), all.get(pathKey(path)) ?? []]));
	};
}

/** Session-only admission evidence. Missing/unavailable history never means new. */
export class MarkdownCreationHistoryGate {
	private snapshot;
	private revision = 0;
	private readonly checkedNew = new Map<string, string>();
	private readonly known = new Map<string, MarkdownPathHistoryEntry[]>();
	private readonly observe;

	constructor(
		private readonly meta: Y.Map<unknown>,
		private readonly load: MarkdownCreationHistoryLoader,
		private readonly generation: () => number,
		private readonly canSeedExplicitly?: (path: string) => boolean,
	) {
		this.snapshot = buildMetaSnapshot(meta);
		this.observe = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
			const affected = extractAffectedFileIds(events, meta);
			let changes;
			if (affected === null) {
				const next = buildMetaSnapshot(meta);
				changes = computeMetaSemanticChanges(this.snapshot, next);
				this.snapshot = next;
			} else {
				changes = computeIncrementalMetaChanges(this.snapshot, meta, affected);
			}
			for (const change of changes) {
				let path: string | undefined;
				if (change.kind === "path-changed") path = change.previousPath;
				if (change.kind === "removed") path = change.previous.path;
				if (change.kind === "deleted") path = change.path;
				if (path !== undefined) {
					this.remember(path, [{fileId: change.fileId, historyId: `observed:${change.fileId}:${path}`}]);
				}
				if ((change.kind !== "added" || events[0]?.transaction.local === false)
					&& change.kind !== "mtime-changed" && change.kind !== "device-changed") {
					this.revision++;
					this.checkedNew.clear();
				}
			}
		};
		meta.observeDeep(this.observe);
	}

	private token(): string { return `${this.generation()}:${this.revision}`; }

	private remember(path: string, entries: readonly MarkdownPathHistoryEntry[]): void {
		path = pathKey(path);
		const known = this.known.get(path) ?? [];
		for (const entry of entries) {
			if (!known.some(value => value.fileId === entry.fileId)) known.push({ ...entry });
		}
		if (known.length > 0) this.known.set(path, known);
	}

	async prepare(paths: readonly string[]): Promise<void> {
		const token = this.token();
		const pending = [...new Set(paths.map(pathKey))]
			.filter(path => !this.known.has(path) && this.checkedNew.get(path) !== token);
		const unchecked = pending.filter(path => {
			if (!this.canSeedExplicitly?.(path)) return true;
			this.checkedNew.set(path, token);
			return false;
		});
		if (unchecked.length === 0) return;
		const result = await this.load(unchecked, token);
		for (const path of unchecked) {
			const entries = result.get(path);
			if (!entries) throw new Error(`File history did not check ${path}`);
			this.remember(path, entries);
			if (entries.length === 0 && token === this.token()) this.checkedNew.set(path, token);
		}
	}

	entries(path: string): readonly MarkdownPathHistoryEntry[] {
		return this.known.get(pathKey(path))?.slice() ?? [];
	}

	canCreate(path: string): boolean {
		path = pathKey(path);
		return !this.known.has(path) && this.checkedNew.get(path) === this.token();
	}

	destroy(): void { this.meta.unobserveDeep(this.observe); }
}
