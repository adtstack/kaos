import { normalizePath, TFile, TFolder } from "obsidian";
import { contentBaselineHash } from "../sync/diskIndex";
import type {
	AttentionAuditItem,
	AttentionAuditResult,
	AttentionAuditSummary,
	PreservedUnresolvedEntry,
} from "../sync/preservedUnresolved";
import {
	getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
} from "../sync/preservedUnresolved";
import type { KaosDashboardCollectorInput } from "./dashboardTypes";

export interface AttentionAuditInput {
	vault: Pick<import("obsidian").Vault, "getAbstractFileByPath">;
	preservedUnresolvedEntries: PreservedUnresolvedEntry[];
	remoteDeleteResolutionState?: KaosDashboardCollectorInput["remoteDeleteResolutionState"];
	blobConflictResolutionState?: KaosDashboardCollectorInput["blobConflictResolutionState"];
	vaultSync?: KaosDashboardCollectorInput["vaultSync"];
	remoteProjectionPolicyError?: string | null;
}

interface LocalFileState {
	kind: "missing" | "file" | "folder" | "other";
}

function checkLocalFile(
	vault: Pick<import("obsidian").Vault, "getAbstractFileByPath">,
	path: string,
): LocalFileState {
	const normalized = normalizePath(path);
	try {
		const item = vault.getAbstractFileByPath(normalized);
		if (!item) return { kind: "missing" };
		if (item instanceof TFile) return { kind: "file" };
		if (item instanceof TFolder) return { kind: "folder" };
		return { kind: "other" };
	} catch {
		return { kind: "missing" };
	}
}

function extractBasename(path: string): string {
	const normalized = normalizePath(path);
	const segments = normalized.split("/");
	return segments[segments.length - 1] ?? normalized;
}

export function isArchivePath(path: string): boolean {
	const normalized = normalizePath(path).toLowerCase();
	return normalized.startsWith("archive/")
		|| normalized.includes("/archive/")
		|| normalized.includes("/_archive/")
		|| normalized.startsWith("_archive/");
}

export interface MarkdownRetirementSettlementInput {
	/** Current CRDT content, or null when the path is not tracked. */
	crdtContent: string | null;
	/** Durable disk-index baseline hash (SHA-256), or null when unknown. */
	baselineHash: string | null;
	/** Current on-disk content when the file exists, else null. */
	diskContent: string | null;
	/** Content hash implementation; defaults to the disk-index baseline hash. */
	hash?: (content: string) => Promise<string>;
}

export interface MarkdownRetirementSettlementDecision {
	ok: boolean;
	proof:
		| "crdt-untracked"
		| "missing-baseline"
		| "crdt-at-baseline"
		| "converged"
		| "disk-at-baseline"
		| "both-sides-moved";
}

/**
 * Settlement proof required before a markdown preserved-unresolved marker may
 * be retired. The fence exists because a divergence never settled; removing it
 * is only provably lossless when one side still equals the durable baseline
 * (the same proof the controller's fenced-conflict heal pass requires), both
 * sides converged, or the CRDT is untracked so the engine holds no divergent
 * content at all. "Both sides moved past baseline" keeps the fence.
 */
export async function classifyMarkdownRetirementSettlement(
	input: MarkdownRetirementSettlementInput,
): Promise<MarkdownRetirementSettlementDecision> {
	const { crdtContent, baselineHash, diskContent } = input;
	if (crdtContent === null) {
		return { ok: true, proof: "crdt-untracked" };
	}
	if (!baselineHash) {
		// No durable baseline to prove against: keep the fence for the
		// operator rather than guessing.
		return { ok: false, proof: "missing-baseline" };
	}
	const hash = input.hash ?? contentBaselineHash;
	const crdtHash = (await hash(crdtContent)).toLowerCase();
	if (crdtHash === baselineHash.toLowerCase()) {
		return { ok: true, proof: "crdt-at-baseline" };
	}
	if (diskContent !== null) {
		if (diskContent === crdtContent) {
			return { ok: true, proof: "converged" };
		}
		const diskHash = (await hash(diskContent)).toLowerCase();
		if (diskHash === baselineHash.toLowerCase()) {
			return { ok: true, proof: "disk-at-baseline" };
		}
	}
	return { ok: false, proof: "both-sides-moved" };
}

export function auditAttentionEntries(
	input: AttentionAuditInput,
): AttentionAuditResult {
	const items: AttentionAuditItem[] = [];
	const entries = input.preservedUnresolvedEntries;
	const byPath = new Map<string, PreservedUnresolvedEntry>();

	for (const entry of entries) {
		byPath.set(normalizePath(entry.path), entry);
	}

	// 1. Group path collisions for paired archive analysis
	const pathCollisionEntries = entries.filter((e) => e.reason === "path-collision");
	const collisionPairs = findPathCollisionPairs(pathCollisionEntries, input.vault);

	for (const entry of entries) {
		const episodeId = getPreservedUnresolvedEpisodeId(entry);
		const normalizedPath = normalizePath(entry.path);
		const localState = checkLocalFile(input.vault, entry.path);

		// Rule 1: Fenced conflict-winner-flush-deferred must NEVER be retired via audit
		if (entry.reason === "conflict-winner-flush-deferred") {
			items.push({
				entry,
				classification: "active",
				rationale: "Fenced conflict-winner-flush-deferred episode. Requires manual confirmation or reconcile heal.",
				episodeId,
			});
			continue;
		}

		// Rule 2: Path collision handling
		if (entry.reason === "path-collision") {
			const pairInfo = collisionPairs.get(normalizedPath);
			if (pairInfo) {
				if (pairInfo.status === "retirable-archive-pair") {
					items.push({
						entry,
						classification: "retirable",
						rationale: `Verified Archive move pair with "${pairInfo.pairPath}". Source absent and target settled.`,
						episodeId,
						pairPath: pairInfo.pairPath,
					});
				} else {
					items.push({
						entry,
						classification: "needs-review",
						rationale: pairInfo.reason,
						episodeId,
						pairPath: pairInfo.pairPath,
					});
				}
				continue;
			}

			// Single path collision not part of a detected pair
			if (localState.kind === "file") {
				items.push({
					entry,
					classification: "active",
					rationale: "Path collision marker on existing local file. Resolve collision manually or via reconcile.",
					episodeId,
				});
			} else if (localState.kind === "missing") {
				const engineAvailable = entry.kind === "markdown"
					? input.remoteDeleteResolutionState?.markdownAvailable === true
					: input.remoteDeleteResolutionState?.blobAvailable === true;

				if (!engineAvailable) {
					items.push({
						entry,
						classification: "needs-review",
						rationale: "Path collision file is missing locally, but remote state is unverified while offline.",
						episodeId,
					});
				} else {
					const remoteFingerprint = input.remoteDeleteResolutionState?.getFingerprint(
						entry.kind,
						entry.path,
					);
					items.push({
						entry,
						classification: "retirable",
						rationale: "Path collision file is absent locally and settled remotely.",
						episodeId,
						remoteDeleteFingerprint: remoteFingerprint,
					});
				}
			} else {
				items.push({
					entry,
					classification: "needs-review",
					rationale: `Path collision location is a ${localState.kind}. Manual inspection required.`,
					episodeId,
				});
			}
			continue;
		}

		// Rule 3: Remote delete entries
		if (isRemoteDeletePreservedUnresolvedEntry(entry)) {
			const engineAvailable = entry.kind === "markdown"
				? input.remoteDeleteResolutionState?.markdownAvailable === true
				: input.remoteDeleteResolutionState?.blobAvailable === true;
			const remoteFingerprint = input.remoteDeleteResolutionState?.getFingerprint(
				entry.kind,
				entry.path,
			) ?? null;
			const isPending = input.remoteDeleteResolutionState?.isKeepLocalPending(
				entry.kind,
				entry.path,
				episodeId,
			) === true;

			if (isPending) {
				items.push({
					entry,
					classification: "active",
					rationale: "Keep local publish operation is currently in flight.",
					episodeId,
					remoteDeleteFingerprint: remoteFingerprint,
				});
				continue;
			}

			if (localState.kind === "file") {
				items.push({
					entry,
					classification: "active",
					rationale: "Local file exists; choose Keep local version or Accept remote delete in Attention.",
					episodeId,
					remoteDeleteFingerprint: remoteFingerprint,
				});
				continue;
			}

			if (localState.kind === "missing") {
				if (!engineAvailable) {
					items.push({
						entry,
						classification: "needs-review",
						rationale: "Local file is missing, but remote delete state cannot be confirmed while offline.",
						episodeId,
						remoteDeleteFingerprint: remoteFingerprint,
					});
				} else {
					items.push({
						entry,
						classification: "retirable",
						rationale: "File is absent locally and remote deletion is confirmed.",
						episodeId,
						remoteDeleteFingerprint: remoteFingerprint,
					});
				}
				continue;
			}

			items.push({
				entry,
				classification: "needs-review",
				rationale: `Local path is currently a ${localState.kind}. Review manually.`,
				episodeId,
				remoteDeleteFingerprint: remoteFingerprint,
			});
			continue;
		}

		// Rule 4: Legacy missing blob
		if (entry.kind === "blob" && entry.reason === "legacy-upgrade-missing-local-blob") {
			const engineAvailable = input.remoteDeleteResolutionState?.blobAvailable === true;
			const remoteRef = input.remoteDeleteResolutionState?.getBlobRef(entry.path) ?? null;

			if (localState.kind === "file") {
				items.push({
					entry,
					classification: "active",
					rationale: "Local attachment now exists. Run reconcile to settle.",
					episodeId,
				});
			} else if (!engineAvailable) {
				items.push({
					entry,
					classification: "needs-review",
					rationale: "Attachment sync is not initialized; cannot check remote attachment status.",
					episodeId,
				});
			} else if (remoteRef !== null) {
				items.push({
					entry,
					classification: "active",
					rationale: "Remote copy is available for download in Attention.",
					episodeId,
				});
			} else {
				items.push({
					entry,
					classification: "retirable",
					rationale: "Attachment is absent locally and not present in remote storage.",
					episodeId,
				});
			}
			continue;
		}

		// Rule 5: Local blob mutation remote conflict
		if (entry.kind === "blob" && entry.reason === "local-blob-mutation-remote-conflict") {
			if (localState.kind === "file") {
				items.push({
					entry,
					classification: "active",
					rationale: "Attachment mutation conflict is active. Dismiss or review in Attention.",
					episodeId,
				});
			} else if (localState.kind === "missing") {
				items.push({
					entry,
					classification: "retirable",
					rationale: "Local conflicting attachment is gone; safe to retire marker.",
					episodeId,
				});
			} else {
				items.push({
					entry,
					classification: "needs-review",
					rationale: `Local path is a ${localState.kind}. Manual inspection required.`,
					episodeId,
				});
			}
			continue;
		}

		// Rule 6: Remote download local conflict
		if (entry.reason === "remote-download-local-conflict") {
			const artifactPath = typeof entry.artifactPath === "string" ? entry.artifactPath : null;
			const artifactState = artifactPath ? checkLocalFile(input.vault, artifactPath) : { kind: "missing" };

			if (artifactState.kind === "file" || localState.kind === "file") {
				items.push({
					entry,
					classification: "active",
					rationale: "Download conflict artifact or original file exists; resolve in Conflicts section.",
					episodeId,
				});
			} else {
				items.push({
					entry,
					classification: "retirable",
					rationale: "Download conflict artifact and original file are no longer present.",
					episodeId,
				});
			}
			continue;
		}

		// Default fallback for other reasons (e.g. three-way-preserve-failed, restore-disk-settlement-failed)
		if (localState.kind === "file") {
			items.push({
				entry,
				classification: "active",
				rationale: `Active ${entry.reason} condition on existing file.`,
				episodeId,
			});
		} else if (localState.kind === "missing") {
			const engineAvailable = entry.kind === "markdown"
				? input.remoteDeleteResolutionState?.markdownAvailable === true
				: input.remoteDeleteResolutionState?.blobAvailable === true;

			if (!engineAvailable) {
				items.push({
					entry,
					classification: "needs-review",
					rationale: `File missing locally, but remote state for ${entry.reason} is unverified.`,
					episodeId,
				});
			} else {
				items.push({
					entry,
					classification: "retirable",
					rationale: `Historical ${entry.reason} marker on absent file.`,
					episodeId,
				});
			}
		} else {
			items.push({
				entry,
				classification: "needs-review",
				rationale: `Unresolved path is currently a ${localState.kind}.`,
				episodeId,
			});
		}
	}

	const summary = buildSummary(items);
	return {
		timestamp: Date.now(),
		items,
		summary,
	};
}

interface CollisionPairResolution {
	status: "retirable-archive-pair" | "needs-review";
	pairPath: string;
	reason: string;
}

function findPathCollisionPairs(
	collisions: PreservedUnresolvedEntry[],
	vault: Pick<import("obsidian").Vault, "getAbstractFileByPath">,
): Map<string, CollisionPairResolution> {
	const map = new Map<string, CollisionPairResolution>();
	const byBasename = new Map<string, PreservedUnresolvedEntry[]>();

	for (const entry of collisions) {
		const base = extractBasename(entry.path);
		const list = byBasename.get(base) ?? [];
		list.push(entry);
		byBasename.set(base, list);
	}

	for (const [basename, group] of byBasename.entries()) {
		const first = group[0];
		const second = group[1];
		if (group.length === 2 && first && second) {
			const firstIsArchive = isArchivePath(first.path);
			const secondIsArchive = isArchivePath(second.path);

			if (firstIsArchive !== secondIsArchive) {
				const source = firstIsArchive ? second : first;
				const target = firstIsArchive ? first : second;

				const sourceState = checkLocalFile(vault, source.path);
				const targetState = checkLocalFile(vault, target.path);

				const normSource = normalizePath(source.path);
				const normTarget = normalizePath(target.path);

				if (sourceState.kind === "missing" && targetState.kind === "file") {
					map.set(normSource, {
						status: "retirable-archive-pair",
						pairPath: normTarget,
						reason: `Source "${source.path}" is missing and target "${target.path}" exists in Archive.`,
					});
					map.set(normTarget, {
						status: "retirable-archive-pair",
						pairPath: normSource,
						reason: `Target "${target.path}" exists in Archive and source "${source.path}" is missing.`,
					});
					continue;
				}

				map.set(normSource, {
					status: "needs-review",
					pairPath: normTarget,
					reason: `Archive move pair incomplete: source is ${sourceState.kind}, target is ${targetState.kind}.`,
				});
				map.set(normTarget, {
					status: "needs-review",
					pairPath: normSource,
					reason: `Archive move pair incomplete: source is ${sourceState.kind}, target is ${targetState.kind}.`,
				});
				continue;
			}
		}

		// If more than 2 or ambiguous pairings
		for (const entry of group) {
			const norm = normalizePath(entry.path);
			map.set(norm, {
				status: "needs-review",
				pairPath: "",
				reason: `Multiple (${group.length}) collision markers found for filename "${basename}". Manual review required.`,
			});
		}
	}

	return map;
}

function buildSummary(items: AttentionAuditItem[]): AttentionAuditSummary {
	let activeCount = 0;
	let retirableCount = 0;
	let needsReviewCount = 0;
	const byReason: Record<string, { active: number; retirable: number; needsReview: number }> = {};

	for (const item of items) {
		const reason = item.entry.reason;
		const reasonStat = byReason[reason] ?? { active: 0, retirable: 0, needsReview: 0 };

		if (item.classification === "active") {
			activeCount++;
			reasonStat.active++;
		} else if (item.classification === "retirable") {
			retirableCount++;
			reasonStat.retirable++;
		} else {
			needsReviewCount++;
			reasonStat.needsReview++;
		}

		byReason[reason] = reasonStat;
	}

	return {
		totalCount: items.length,
		activeCount,
		retirableCount,
		needsReviewCount,
		byReason,
	};
}
