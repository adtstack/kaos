import { normalizePath } from "obsidian";

export type PreservedUnresolvedKind = "markdown" | "blob";

export type PreservedUnresolvedReason =
	| "remote-delete-missing-baseline"
	| "remote-delete-read-failed"
	| "remote-delete-open-editor-read-failed"
	| "remote-delete-multiple-open-editor-authorities"
	| "remote-delete-hash-read-failed"
	| "remote-delete-stat-failed"
	| "conflict-artifact-write-failed"
	| "three-way-preserve-failed"
	| "conflict-winner-flush-deferred"
	| "multiple-editor-authorities"
	| "path-collision"
	| "unknown";

export const REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS = [
	"remote-delete-missing-baseline",
	"remote-delete-read-failed",
	"remote-delete-open-editor-read-failed",
	"remote-delete-multiple-open-editor-authorities",
	"remote-delete-hash-read-failed",
	"remote-delete-stat-failed",
] as const satisfies readonly PreservedUnresolvedReason[];

export type RemoteDeletePreservedUnresolvedReason =
	typeof REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS[number];

const REMOTE_DELETE_REASON_SET = new Set<string>(
	REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS,
);

export function isRemoteDeletePreservedUnresolvedReason(
	reason: PreservedUnresolvedReason,
): reason is RemoteDeletePreservedUnresolvedReason {
	return REMOTE_DELETE_REASON_SET.has(reason);
}

export function isRemoteDeletePreservedUnresolvedEntry(
	entry: Pick<PreservedUnresolvedEntry, "kind" | "reason">,
): entry is Pick<PreservedUnresolvedEntry, "kind"> & {
	reason: RemoteDeletePreservedUnresolvedReason;
} {
	if (!isRemoteDeletePreservedUnresolvedReason(entry.reason)) return false;
	if (entry.kind === "markdown") {
		return entry.reason === "remote-delete-missing-baseline"
			|| entry.reason === "remote-delete-read-failed"
			|| entry.reason === "remote-delete-open-editor-read-failed"
			|| entry.reason === "remote-delete-multiple-open-editor-authorities";
	}
	return entry.reason === "remote-delete-missing-baseline"
		|| entry.reason === "remote-delete-hash-read-failed"
		|| entry.reason === "remote-delete-stat-failed";
}

export interface PreservedUnresolvedEntry {
	path: string;
	kind: PreservedUnresolvedKind;
	reason: PreservedUnresolvedReason;
	/**
	 * Identifies one uninterrupted occurrence of an unresolved condition.
	 * Dashboard actions use this to reject a confirmation dialog that outlived
	 * the occurrence it was opened for.
	 */
	episodeId?: string;
	firstSeenAt: number;
	lastSeenAt: number;
	localHash?: string | null;
	knownRemoteHash?: string | null;
}

export interface PreservedUnresolvedSample {
	path: string;
	ext: string | null;
	kind: PreservedUnresolvedKind;
	reason: PreservedUnresolvedReason;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface PreservedUnresolvedSummary {
	markdownCount: number;
	blobCount: number;
	totalCount: number;
	lastAt: number | null;
	reasons: Record<string, number>;
	samples: PreservedUnresolvedSample[];
}

function extensionFor(path: string): string | null {
	const name = normalizePath(path).split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : null;
}

let episodeSequence = 0;

export function createPreservedUnresolvedEpisodeId(at = Date.now()): string {
	episodeSequence = (episodeSequence + 1) % Number.MAX_SAFE_INTEGER;
	return [
		at.toString(36),
		episodeSequence.toString(36),
		Math.random().toString(36).slice(2, 12),
	].join("-");
}

export function getPreservedUnresolvedEpisodeId(
	entry: Pick<PreservedUnresolvedEntry, "kind" | "reason" | "firstSeenAt"> & {
		episodeId?: string;
	},
): string {
	if (typeof entry.episodeId === "string" && entry.episodeId.length > 0) {
		return entry.episodeId;
	}
	// Backward-compatible, stable token for plugin data written before episodeId
	// existed. It remains stable through hydration and is persisted on next save.
	return `legacy:${entry.kind}:${entry.reason}:${entry.firstSeenAt}`;
}

export function getRemoteDeleteEpisodeId(
	kind: PreservedUnresolvedKind,
	remoteDeleteFingerprint: string,
): string {
	return `remote-delete:${kind}:${remoteDeleteFingerprint}`;
}

export class PreservedUnresolvedRegistry {
	private entries = new Map<string, PreservedUnresolvedEntry>();
	readonly paths = new Set<string>();

	constructor(entries: PreservedUnresolvedEntry[] = []) {
		for (const entry of entries) {
			this.record({
				...entry,
				episodeId: getPreservedUnresolvedEpisodeId(entry),
				at: entry.lastSeenAt,
			});
			const stored = this.entries.get(normalizePath(entry.path));
			if (stored) {
				stored.firstSeenAt = entry.firstSeenAt;
				stored.lastSeenAt = entry.lastSeenAt;
			}
		}
	}

	record(
		entry: Omit<PreservedUnresolvedEntry, "path" | "firstSeenAt" | "lastSeenAt"> & {
			path: string;
			at?: number;
		},
	): void {
		const path = normalizePath(entry.path);
		const at = entry.at ?? Date.now();
		const previous = this.entries.get(path);
		const previousEpisodeId = previous
			? getPreservedUnresolvedEpisodeId(previous)
			: null;
		const continuesPreviousEpisode = previous?.kind === entry.kind
			&& previous.reason === entry.reason
			&& (!entry.episodeId || entry.episodeId === previousEpisodeId);
		this.entries.set(path, {
			path,
			kind: entry.kind,
			reason: entry.reason,
			episodeId: continuesPreviousEpisode
				? getPreservedUnresolvedEpisodeId(previous)
				: entry.episodeId || createPreservedUnresolvedEpisodeId(at),
			firstSeenAt: continuesPreviousEpisode ? previous.firstSeenAt : at,
			lastSeenAt: at,
			localHash: entry.localHash ?? previous?.localHash ?? null,
			knownRemoteHash: entry.knownRemoteHash
				?? previous?.knownRemoteHash
				?? null,
		});
		this.paths.add(path);
	}

	resolve(path: string): boolean {
		const normalized = normalizePath(path);
		this.paths.delete(normalized);
		return this.entries.delete(normalized);
	}

	has(path: string): boolean {
		return this.entries.has(normalizePath(path));
	}

	get(path: string): PreservedUnresolvedEntry | null {
		return this.entries.get(normalizePath(path)) ?? null;
	}

	clear(): void {
		this.entries.clear();
		this.paths.clear();
	}

	getEntries(): PreservedUnresolvedEntry[] {
		return Array.from(this.entries.values()).sort(
			(a, b) => b.lastSeenAt - a.lastSeenAt,
		);
	}

	getSummary(limit = 10): PreservedUnresolvedSummary {
		const entries = this.getEntries();
		const reasons: Record<string, number> = {};
		let markdownCount = 0;
		let blobCount = 0;
		let lastAt: number | null = null;
		for (const entry of entries) {
			if (entry.kind === "markdown") markdownCount++;
			else blobCount++;
			reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
			lastAt = Math.max(lastAt ?? 0, entry.lastSeenAt);
		}
		return {
			markdownCount,
			blobCount,
			totalCount: entries.length,
			lastAt,
			reasons,
			samples: entries.slice(0, limit).map((entry) => ({
				path: entry.path,
				ext: extensionFor(entry.path),
				kind: entry.kind,
				reason: entry.reason,
				firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
				lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
			})),
		};
	}
}
