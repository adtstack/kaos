import { normalizePath } from "obsidian";

export type PreservedUnresolvedKind = "markdown" | "blob";

export type PreservedUnresolvedReason =
	| "remote-delete-missing-baseline"
	| "remote-delete-read-failed"
	| "remote-delete-open-editor-read-failed"
	| "remote-delete-multiple-open-editor-authorities"
	| "remote-delete-trash-failed"
	| "remote-delete-hash-read-failed"
	| "remote-delete-stat-failed"
	| "remote-delete-local-conflict"
	| "remote-download-local-conflict"
	| "conflict-artifact-write-failed"
	| "three-way-preserve-failed"
	| "open-external-targeted-diff-failed"
	| "external-disk-read-unavailable"
	| "conflict-winner-flush-deferred"
	| "restore-disk-settlement-failed"
	| "multiple-editor-authorities"
	| "legacy-upgrade-missing-local-blob"
	| "local-blob-mutation-remote-conflict"
	| "path-collision"
	| "unknown";

export const REMOTE_DELETE_PRESERVED_UNRESOLVED_REASONS = [
	"remote-delete-missing-baseline",
	"remote-delete-read-failed",
	"remote-delete-open-editor-read-failed",
	"remote-delete-multiple-open-editor-authorities",
	"remote-delete-trash-failed",
	"remote-delete-hash-read-failed",
	"remote-delete-stat-failed",
	"remote-delete-local-conflict",
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
			|| entry.reason === "remote-delete-multiple-open-editor-authorities"
			|| entry.reason === "remote-delete-trash-failed";
	}
	return entry.reason === "remote-delete-missing-baseline"
		|| entry.reason === "remote-delete-hash-read-failed"
		|| entry.reason === "remote-delete-stat-failed"
		|| entry.reason === "remote-delete-trash-failed"
		|| entry.reason === "remote-delete-local-conflict";
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
	/** Exact local-only candidate created for a blob download conflict. */
	artifactPath?: string | null;
	/** Exact remote BlobRef identity captured when the conflict was quarantined. */
	knownRemoteRefFingerprint?: string | null;
	/** Exact CRDT item episode captured when the conflict was quarantined. */
	knownRemoteSourceVersion?: string | null;
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

export type PreservedUnresolvedMoveResult =
	| { kind: "missing" }
	| { kind: "unchanged"; entry: PreservedUnresolvedEntry }
	| { kind: "moved"; entry: PreservedUnresolvedEntry }
	| {
		kind: "collision";
		source: PreservedUnresolvedEntry;
		target: PreservedUnresolvedEntry;
	};

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
		const previousInEpisode = continuesPreviousEpisode ? previous : undefined;
		this.entries.set(path, {
			path,
			kind: entry.kind,
			reason: entry.reason,
			episodeId: continuesPreviousEpisode
				? getPreservedUnresolvedEpisodeId(previous)
				: entry.episodeId || createPreservedUnresolvedEpisodeId(at),
			firstSeenAt: continuesPreviousEpisode ? previous.firstSeenAt : at,
			lastSeenAt: at,
			localHash: entry.localHash !== undefined
				? entry.localHash
				: previousInEpisode?.localHash ?? null,
			knownRemoteHash: entry.knownRemoteHash !== undefined
				? entry.knownRemoteHash
				: previousInEpisode?.knownRemoteHash ?? null,
			...(entry.artifactPath !== undefined || previousInEpisode?.artifactPath !== undefined
				? {
					artifactPath: entry.artifactPath !== undefined
						? entry.artifactPath
						: previousInEpisode?.artifactPath ?? null,
				}
				: {}),
			...(entry.knownRemoteRefFingerprint !== undefined
				|| previousInEpisode?.knownRemoteRefFingerprint !== undefined
				? {
					knownRemoteRefFingerprint:
						entry.knownRemoteRefFingerprint !== undefined
							? entry.knownRemoteRefFingerprint
							: previousInEpisode?.knownRemoteRefFingerprint ?? null,
				}
				: {}),
			...(entry.knownRemoteSourceVersion !== undefined
				|| previousInEpisode?.knownRemoteSourceVersion !== undefined
				? {
					knownRemoteSourceVersion:
						entry.knownRemoteSourceVersion !== undefined
							? entry.knownRemoteSourceVersion
							: previousInEpisode?.knownRemoteSourceVersion ?? null,
				}
				: {}),
		});
		this.paths.add(path);
	}

	resolve(path: string): boolean {
		const normalized = normalizePath(path);
		this.paths.delete(normalized);
		return this.entries.delete(normalized);
	}

	/**
	 * Resolve only the exact occurrence observed by the caller. A same-path
	 * replacement with a newer/manual episode is left untouched.
	 */
	resolveEpisode(path: string, expectedEpisodeId: string): boolean {
		const normalized = normalizePath(path);
		const current = this.entries.get(normalized);
		if (
			!current
			|| getPreservedUnresolvedEpisodeId(current) !== expectedEpisodeId
		) {
			return false;
		}
		this.paths.delete(normalized);
		return this.entries.delete(normalized);
	}

	has(path: string): boolean {
		return this.entries.has(normalizePath(path));
	}

	get(path: string): PreservedUnresolvedEntry | null {
		return this.entries.get(normalizePath(path)) ?? null;
	}

	/**
	 * Move one unresolved episode to a renamed path without manufacturing a new
	 * episode. If the destination already belongs to another episode, leave both
	 * entries untouched so the caller can quarantine the path collision.
	 */
	move(oldPath: string, newPath: string): PreservedUnresolvedMoveResult {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		const source = this.entries.get(oldNormalized);
		if (!source) return { kind: "missing" };
		if (oldNormalized === newNormalized) {
			return { kind: "unchanged", entry: { ...source } };
		}

		const target = this.entries.get(newNormalized);
		if (target) {
			if (
				target.kind !== source.kind ||
				getPreservedUnresolvedEpisodeId(target) !== getPreservedUnresolvedEpisodeId(source)
			) {
				return {
					kind: "collision",
					source: { ...source },
					target: { ...target },
				};
			}

			const merged: PreservedUnresolvedEntry = {
				...source,
				...target,
				path: newNormalized,
				episodeId: getPreservedUnresolvedEpisodeId(source),
				firstSeenAt: Math.min(source.firstSeenAt, target.firstSeenAt),
				lastSeenAt: Math.max(source.lastSeenAt, target.lastSeenAt),
				localHash: target.localHash ?? source.localHash ?? null,
				knownRemoteHash: target.knownRemoteHash ?? source.knownRemoteHash ?? null,
			};
			this.entries.delete(oldNormalized);
			this.paths.delete(oldNormalized);
			this.entries.set(newNormalized, merged);
			this.paths.add(newNormalized);
			return { kind: "moved", entry: { ...merged } };
		}

		const moved = { ...source, path: newNormalized };
		this.entries.delete(oldNormalized);
		this.paths.delete(oldNormalized);
		this.entries.set(newNormalized, moved);
		this.paths.add(newNormalized);
		return { kind: "moved", entry: { ...moved } };
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
