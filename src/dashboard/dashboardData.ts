import { normalizePath, TFile } from "obsidian";
import {
	getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	type PreservedUnresolvedKind,
} from "../sync/preservedUnresolved";
import {
	parseConflictArtifactPath,
	type ParsedConflictArtifactPath,
} from "../paths/conflictArtifactPath";
import type {
	DashboardAttentionItem,
	DashboardBlobConflictResolution,
	DashboardConflictArtifact,
	DashboardLocalFileIdentity,
	DashboardMarkdownConflictResolution,
	DashboardMetric,
	DashboardStuckLocalMutationResolution,
	DashboardVaultSyncDebug,
	KaosDashboardCollectorInput,
	KaosDashboardData,
} from "./dashboardTypes";
import { blobRefFingerprint, cloneBlobRef } from "../types";

const ATTENTION_SAMPLE_LIMIT = 20;
type DashboardServerReceipt = DashboardVaultSyncDebug["serverReceipt"];

const MARKDOWN_CONFLICT_PRESERVED_REASONS = new Set<string>([
	"conflict-winner-flush-deferred",
	"conflict-artifact-write-failed",
	"three-way-preserve-failed",
	"open-external-targeted-diff-failed",
	"restore-disk-settlement-failed",
	"multiple-editor-authorities",
]);

export function buildKaosDashboardData(input: KaosDashboardCollectorInput): KaosDashboardData {
	const connected = input.vaultSync?.connected ?? false;
	return {
		generatedAt: input.generatedAt,
		settings: input.settings,
		overview: buildOverview(input),
		snapshotStatus: input.snapshotStatus,
		recoveryStorageStatus: input.recoveryStorageStatus,
		recentChanges: input.recentChanges,
		conflicts: collectDashboardConflictArtifacts(input),
		blobSafetyCopies: collectDashboardBlobSafetyCopies(input),
		attention: collectDashboardAttention(input),
		attentionTotalCount: getDashboardAttentionTotalCount(input),
		attentionAudit: input.attentionAudit ?? null,
		actions: {
			syncInitialized: input.vaultSync !== null,
			untrackedFileCount: input.reconciliationState.untrackedFileCount,
			snapshotsAvailable: input.snapshotsAvailable,
			connected,
		},
	};
}

export function collectDashboardConflictArtifacts(
	input: Pick<
		KaosDashboardCollectorInput,
		"app" | "diskIndex" | "preservedUnresolvedEntries" | "blobConflictResolutionState"
	>,
): DashboardConflictArtifact[] {
	const files = input.app.vault.getFiles();
	const artifacts: DashboardConflictArtifact[] = [];
	for (const file of files) {
		const parsed = parseConflictArtifactPath(file.path);
		// Markdown conflict-artifact preservation is abolished; only blob
		// conflicts (binary, no CRDT history) remain in the Conflicts tab.
		if (!parsed || parsed.kind !== "blob" || parsed.source === "local") continue;
		artifacts.push(buildConflictArtifact(input, file, parsed));
	}
	return sortDashboardArtifacts(artifacts);
}

/**
 * Collect visible rollback copies separately from true divergent conflicts.
 * A local backup is produced even for a clean, causally-proven remote advance
 * because Obsidian does not expose an atomic binary replace primitive.
 */
export function collectDashboardBlobSafetyCopies(
	input: Pick<KaosDashboardCollectorInput, "app" | "diskIndex">,
): DashboardConflictArtifact[] {
	const copies: DashboardConflictArtifact[] = [];
	for (const file of input.app.vault.getFiles()) {
		const parsed = parseConflictArtifactPath(file.path);
		if (parsed?.kind !== "blob" || parsed.source !== "local") continue;
		copies.push(buildConflictArtifact(input, file, parsed));
	}
	return sortDashboardArtifacts(copies);
}

function sortDashboardArtifacts<T extends DashboardConflictArtifact>(
	artifacts: T[],
): T[] {
	return artifacts.sort((left, right) => {
		const leftTime = Date.parse(left.timestamp);
		const rightTime = Date.parse(right.timestamp);
		if (leftTime !== rightTime) return rightTime - leftTime;
		return (right.artifactMtime ?? 0) - (left.artifactMtime ?? 0);
	});
}

export function collectDashboardAttention(
	input: Pick<
		KaosDashboardCollectorInput,
		| "app"
		| "preservedUnresolvedEntries"
		| "frontmatterQuarantineEntries"
		| "reconciliationState"
		| "remoteDeleteResolutionState"
		| "remoteProjectionPolicyError"
	>,
): DashboardAttentionItem[] {
	const items: DashboardAttentionItem[] = [];
	if (input.remoteProjectionPolicyError) {
		items.push({
			kind: "remote-projection-policy",
			title: "Shared exclude policy needs attention",
			path: null,
			detail:
				`${input.remoteProjectionPolicyError}. Local and editor changes remain active; ` +
				"remote projection remains paused until a valid shared policy syncs.",
			structuralChange: null,
			firstSeenAt: null,
			lastSeenAt: null,
			tone: "error",
			resolution: null,
		});
	}
	const structuralPaths = new Set(
		input.reconciliationState.unresolvedStructuralChangePaths,
	);
	const standaloneEntries = input.preservedUnresolvedEntries.filter(
		(entry) => !structuralPaths.has(entry.path),
	);
	for (const entry of standaloneEntries.slice(0, ATTENTION_SAMPLE_LIMIT)) {
		const remoteDeleteReason = isRemoteDeletePreservedUnresolvedEntry(entry)
			? entry.reason
			: null;
		const episodeId = getPreservedUnresolvedEpisodeId(entry);
		const localFile = getDashboardLocalFileIdentity(input, entry.path);
		const engineAvailable = entry.kind === "markdown"
			? input.remoteDeleteResolutionState?.markdownAvailable === true
			: input.remoteDeleteResolutionState?.blobAvailable === true;
		const remoteDeleteFingerprint = remoteDeleteReason
			? input.remoteDeleteResolutionState?.getFingerprint(entry.kind, entry.path) ?? null
			: null;
		const keepLocalPending = remoteDeleteReason !== null
			&& input.remoteDeleteResolutionState?.isKeepLocalPending(
				entry.kind,
				entry.path,
				episodeId,
			) === true;
		const commonUnavailableReason = getCommonResolutionUnavailableReason(
			entry.kind,
			engineAvailable,
			remoteDeleteFingerprint,
			localFile.kind,
		);
		const legacyMissingBlob = entry.kind === "blob"
			&& entry.reason === "legacy-upgrade-missing-local-blob";
		const legacyRemoteRef = legacyMissingBlob
			? cloneBlobRef(input.remoteDeleteResolutionState?.getBlobRef(entry.path) ?? undefined)
				?? null
			: null;
		const legacyUnavailableReason = !engineAvailable
			? "Attachment sync is not initialized."
			: localFile.kind === "other"
				? "The local path is no longer a file vacancy."
				: localFile.kind === "file"
					? "A local file now exists. Run reconcile to settle it first."
					: null;
		const stuckLocalMutation = entry.kind === "blob"
			&& entry.reason === "local-blob-mutation-remote-conflict";
		const stuckUnavailableReason = !engineAvailable
			? "Attachment sync is not initialized."
			: null;
		const stuckLocalMutationResolution: DashboardStuckLocalMutationResolution | null = stuckLocalMutation
			? {
				kind: "stuck-local-mutation",
				fileKind: "blob",
				reason: "local-blob-mutation-remote-conflict",
				episodeId,
				localFile,
				canDismiss: stuckUnavailableReason === null,
				unavailableReason: stuckUnavailableReason,
			}
			: null;
		const isMarkdownConflict = entry.kind === "markdown" && MARKDOWN_CONFLICT_PRESERVED_REASONS.has(entry.reason);
		const markdownConflictResolution: DashboardMarkdownConflictResolution | null = isMarkdownConflict
			? {
				kind: "markdown-conflict",
				fileKind: "markdown",
				reason: entry.reason,
				episodeId,
				localFile,
				canKeepLocal: engineAvailable && localFile.kind === "file",
				canUseRemote: engineAvailable,
				keepLocalUnavailableReason: !engineAvailable
					? "Sync engine is not initialized."
					: localFile.kind !== "file"
						? "Local file does not exist."
						: null,
				useRemoteUnavailableReason: !engineAvailable
					? "Sync engine is not initialized."
					: null,
				unavailableReason: !engineAvailable
					? "Sync engine is not initialized."
					: null,
			}
			: null;
		const downloadConflictArtifactAvailable = entry.reason === "remote-download-local-conflict"
			&& typeof entry.artifactPath === "string"
			&& input.app.vault.getAbstractFileByPath(normalizePath(entry.artifactPath)) instanceof TFile;
		items.push({
			kind: "preserved-unresolved",
			title: `${entry.kind} needs attention`,
			path: entry.path,
			detail: entry.reason === "remote-download-local-conflict"
				? downloadConflictArtifactAvailable
					? "Choose Keep local or Use remote copy in the Conflicts section."
					: "The preserved remote copy is missing or was moved. Restore the exact copy from trash, or review the local attachment manually."
				: entry.reason,
			structuralChange: null,
			firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
			lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
			tone: "warn",
			resolution: remoteDeleteReason ? {
				kind: "remote-delete",
				fileKind: entry.kind,
				reason: remoteDeleteReason,
				episodeId,
				remoteDeleteFingerprint,
				localFile,
				canKeepLocal: commonUnavailableReason === null
					&& localFile.kind === "file"
					&& !keepLocalPending,
				canAcceptRemoteDelete: commonUnavailableReason === null && !keepLocalPending,
				keepLocalPending,
				keepLocalUnavailableReason: keepLocalPending
					? "The local attachment is still being published."
					: commonUnavailableReason
					?? (localFile.kind === "missing" ? "The local file no longer exists." : null),
				acceptRemoteDeleteUnavailableReason: keepLocalPending
					? "Wait for the pending Keep local upload to finish."
					: commonUnavailableReason,
			} : legacyMissingBlob ? {
				kind: "legacy-missing-blob",
				fileKind: "blob",
				reason: "legacy-upgrade-missing-local-blob",
				episodeId,
				remoteRef: legacyRemoteRef,
				localFile,
				canDownloadRemote: legacyUnavailableReason === null
					&& legacyRemoteRef !== null,
				canKeepLocalAbsent: legacyUnavailableReason === null,
				unavailableReason: legacyUnavailableReason,
			} : (stuckLocalMutationResolution ?? markdownConflictResolution),
		});
	}

	input.reconciliationState.unresolvedStructuralChangeSample.forEach((change) => {
		items.push({
			kind: "structural-change",
			title: buildStructuralChangeTitle(change),
			path: null,
			detail: change.reason,
			structuralChange: {
				oldPaths: change.oldPaths,
				newPaths: change.newPaths,
				contentHashPrefix: change.contentHashPrefix,
			},
			firstSeenAt: null,
			lastSeenAt: null,
			tone: "warn",
			resolution: null,
		});
	});

	if (input.reconciliationState.blockedDivergenceCount > 0) {
		items.push({
			kind: "blocked-divergence",
			title: `${input.reconciliationState.blockedDivergenceCount} blocked divergence(s)`,
			path: null,
			detail: input.reconciliationState.blockedDivergenceSample
				.map((sample) => `${sample.ext ?? "(no ext)"} ${sample.hash}`)
				.join(", "),
			structuralChange: null,
			firstSeenAt: null,
			lastSeenAt: input.reconciliationState.lastBlockedDivergenceAt,
			tone: "error",
			resolution: null,
		});
	}

	for (const entry of input.frontmatterQuarantineEntries.slice(0, ATTENTION_SAMPLE_LIMIT)) {
		items.push({
			kind: "frontmatter-quarantine",
			title: "Frontmatter quarantine",
			path: entry.path,
			detail: `${entry.direction} · ${entry.reasons.join(", ")} · x${entry.count}`,
			structuralChange: null,
			firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
			lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
			tone: "warn",
			resolution: null,
		});
	}

	return items.sort((left, right) =>
		(Date.parse(right.lastSeenAt ?? right.firstSeenAt ?? "0") || 0)
		- (Date.parse(left.lastSeenAt ?? left.firstSeenAt ?? "0") || 0),
	);
}

function buildStructuralChangeTitle(
	change: KaosDashboardCollectorInput["reconciliationState"]["unresolvedStructuralChangeSample"][number],
): string {
	const filenames = Array.from(new Set(
		[...change.oldPaths, ...change.newPaths]
			.map((path) => path.split("/").pop() || path)
			.filter(Boolean),
	));
	return `${change.reason} · ${filenames.join(", ") || "unknown file"}`;
}

export function getDashboardAttentionTotalCount(
	input: Pick<
		KaosDashboardCollectorInput,
		| "preservedUnresolvedEntries"
		| "frontmatterQuarantineEntries"
		| "reconciliationState"
		| "remoteProjectionPolicyError"
	> & {
		attentionAudit?: KaosDashboardCollectorInput["attentionAudit"];
	},
): number {
	const structuralPaths = new Set(
		input.reconciliationState.unresolvedStructuralChangePaths,
	);
	let standaloneCount = 0;
	if (input.attentionAudit) {
		standaloneCount = input.attentionAudit.summary.activeCount;
	} else {
		const standalonePaths = new Set<string>();
		for (const entry of input.preservedUnresolvedEntries) {
			if (!structuralPaths.has(entry.path)) standalonePaths.add(entry.path);
		}
		standaloneCount = standalonePaths.size;
	}
	return standaloneCount
		+ input.frontmatterQuarantineEntries.length
		+ input.reconciliationState.unresolvedStructuralChangeGroupCount
		+ input.reconciliationState.blockedDivergenceCount
		+ (input.remoteProjectionPolicyError ? 1 : 0);
}

function getDashboardLocalFileIdentity(
	input: Pick<KaosDashboardCollectorInput, "app">,
	path: string,
): DashboardLocalFileIdentity {
	const abstractFile = input.app.vault.getAbstractFileByPath(path);
	if (abstractFile === null) {
		return { kind: "missing", mtime: null, size: null };
	}
	if (!(abstractFile instanceof TFile)) {
		return { kind: "other", mtime: null, size: null };
	}
	return {
		kind: "file",
		mtime: typeof abstractFile.stat?.mtime === "number" ? abstractFile.stat.mtime : null,
		size: typeof abstractFile.stat?.size === "number" ? abstractFile.stat.size : null,
	};
}

function getCommonResolutionUnavailableReason(
	kind: PreservedUnresolvedKind,
	engineAvailable: boolean,
	remoteDeleteFingerprint: string | null,
	localFileKind: "file" | "missing" | "other",
): string | null {
	if (!engineAvailable) {
		return kind === "markdown"
			? "Markdown sync is not initialized."
			: "Attachment sync is not initialized.";
	}
	if (remoteDeleteFingerprint === null) {
		return "The remote deletion changed or is no longer active. Refresh the dashboard.";
	}
	if (localFileKind === "other") {
		return "This path is no longer a file.";
	}
	return null;
}

function buildConflictArtifact(
	input: Pick<KaosDashboardCollectorInput, "app" | "diskIndex">
		& Partial<Pick<
			KaosDashboardCollectorInput,
			"preservedUnresolvedEntries" | "blobConflictResolutionState"
		>>,
	file: TFile,
	parsed: ParsedConflictArtifactPath,
): DashboardConflictArtifact {
	const original = input.app.vault.getAbstractFileByPath(parsed.inferredOriginalPath);
	const stat = file.stat as { mtime?: number; size?: number } | undefined;
	return {
		artifactPath: parsed.artifactPath,
		inferredOriginalPath: parsed.inferredOriginalPath,
		originalExists: original instanceof TFile,
		originalPathConfidence: parsed.originalPathConfidence,
		kind: parsed.kind,
		source: parsed.source,
		deviceName: parsed.deviceName,
		timestamp: parsed.timestamp,
		copyIndex: parsed.copyIndex,
		artifactMtime: typeof stat?.mtime === "number" ? stat.mtime : null,
		artifactSize: typeof stat?.size === "number" ? stat.size : null,
		artifactIndexed: Object.prototype.hasOwnProperty.call(input.diskIndex, parsed.artifactPath),
		originalIndexed: Object.prototype.hasOwnProperty.call(input.diskIndex, parsed.inferredOriginalPath),
		blobResolution: buildBlobConflictResolution(input, file, original, parsed),
	};
}

function buildBlobConflictResolution(
	input: Pick<KaosDashboardCollectorInput, "app">
		& Partial<Pick<
			KaosDashboardCollectorInput,
			"preservedUnresolvedEntries" | "blobConflictResolutionState"
		>>,
	artifact: TFile,
	original: ReturnType<KaosDashboardCollectorInput["app"]["vault"]["getAbstractFileByPath"]>,
	parsed: ParsedConflictArtifactPath,
): DashboardBlobConflictResolution | null {
	if (parsed.kind !== "blob" || parsed.source !== "remote") return null;
	const marker = input.preservedUnresolvedEntries?.find((entry) =>
		entry.kind === "blob"
		&& entry.reason === "remote-download-local-conflict"
		&& normalizePath(entry.path) === normalizePath(parsed.inferredOriginalPath)
	);
	if (!marker || typeof marker.knownRemoteHash !== "string") return null;

	const episodeId = getPreservedUnresolvedEpisodeId(marker);
	const state = input.blobConflictResolutionState;
	const remoteRef = cloneBlobRef(state?.getBlobRef(parsed.inferredOriginalPath) ?? undefined)
		?? null;
	const remoteSourceVersion = state?.getBlobSourceVersion(
		parsed.inferredOriginalPath,
	) ?? null;
	const originalFile = original instanceof TFile
		? { kind: "file" as const, mtime: original.stat.mtime, size: original.stat.size }
		: original === null
			? { kind: "missing" as const, mtime: null, size: null }
			: { kind: "other" as const, mtime: null, size: null };
	const artifactFile = {
		kind: "file" as const,
		mtime: artifact.stat.mtime,
		size: artifact.stat.size,
	};
	const keepLocalPending = state?.isKeepLocalPending(
		parsed.inferredOriginalPath,
		episodeId,
	) === true;
	const useRemoteResumePending = state?.isUseRemoteResumePending(
		parsed.inferredOriginalPath,
		episodeId,
	) === true;
	let commonUnavailableReason: string | null = null;
	if (parsed.originalPathConfidence === "possibly-truncated") {
		commonUnavailableReason = "The original filename was truncated; locate both files manually.";
	} else if (typeof marker.artifactPath !== "string" || marker.artifactPath.length === 0) {
		commonUnavailableReason = "This conflict episode has no exact remote-copy binding; review it manually.";
	} else if (
		normalizePath(marker.artifactPath) !== normalizePath(parsed.artifactPath)
	) {
		commonUnavailableReason = "This is an older conflict copy; use the active candidate instead.";
	} else if (state?.available !== true) {
		commonUnavailableReason = "Attachment sync authority is not ready.";
	} else if (!state.isPathSyncable(parsed.inferredOriginalPath)) {
		commonUnavailableReason = "This path is no longer eligible for attachment sync.";
	} else if (!remoteRef || remoteRef.hash !== marker.knownRemoteHash) {
		commonUnavailableReason = "The remote attachment changed; refresh after the new conflict is preserved.";
	} else if (remoteSourceVersion === null) {
		commonUnavailableReason = "The exact remote attachment episode is unavailable.";
	} else if (
		marker.knownRemoteRefFingerprint
		&& blobRefFingerprint(remoteRef) !== marker.knownRemoteRefFingerprint
	) {
		commonUnavailableReason = "The remote attachment identity changed.";
	} else if (
		marker.knownRemoteSourceVersion
		&& remoteSourceVersion !== marker.knownRemoteSourceVersion
	) {
		commonUnavailableReason = "The remote attachment episode changed.";
	}
	let keepLocalUnavailableReason = commonUnavailableReason;
	let useRemoteCopyUnavailableReason = commonUnavailableReason;
	if (commonUnavailableReason === null && keepLocalPending) {
		keepLocalUnavailableReason = "The selected local attachment is still being published.";
		useRemoteCopyUnavailableReason = "Wait for the selected local attachment to finish publishing.";
	} else if (commonUnavailableReason === null) {
		if (useRemoteResumePending) {
			keepLocalUnavailableReason = "The remote-copy choice is awaiting completion.";
		}
		if (originalFile.kind !== "file") {
			keepLocalUnavailableReason = "The current local attachment is missing or changed type.";
			if (!(originalFile.kind === "missing" && useRemoteResumePending)) {
				useRemoteCopyUnavailableReason = "The current local attachment is missing or changed type.";
			}
		}
	}

	return {
		kind: "remote-download-conflict",
		episodeId,
		// The marker hash describes the local bytes seen when quarantine began.
		// The local file may legitimately change while the conflict remains open;
		// the action re-hashes the exact Dashboard file identity under its path lock.
		expectedLocalHash: null,
		expectedRemoteHash: marker.knownRemoteHash,
		expectedRemoteRef: remoteRef,
		expectedRemoteSourceVersion: remoteSourceVersion,
		originalFile,
		artifactFile,
		keepLocalPending,
		canKeepLocal: keepLocalUnavailableReason === null,
		canUseRemoteCopy: useRemoteCopyUnavailableReason === null,
		keepLocalUnavailableReason,
		useRemoteCopyUnavailableReason,
	};
}

function buildOverview(input: KaosDashboardCollectorInput): DashboardMetric[] {
	const reconcile = input.reconciliationState;
	const vaultSync = input.vaultSync;
	const disk = input.diskMirror;
	const blob = input.blobSync;
	const serverReceipt = vaultSync?.serverReceipt;
	const metrics: DashboardMetric[] = [
		{ label: "Status", value: input.syncStatusLabel, tone: input.connectionTone },
		{ label: "Connection", value: input.connectionLabel, tone: input.connectionTone },
		{ label: "Provider synced", value: yesNo(vaultSync?.providerSynced), tone: toneForBoolean(vaultSync?.providerSynced) },
		{ label: "Local ready", value: yesNo(vaultSync?.localReady), tone: toneForBoolean(vaultSync?.localReady) },
		{ label: "Open files", value: String(input.openFileCount) },
		{ label: "Active notes", value: String(vaultSync?.activePathCount ?? 0) },
		{ label: "Tombstones", value: String(vaultSync?.tombstonedPathCount ?? 0), tone: (vaultSync?.tombstonedPathCount ?? 0) > 0 ? "muted" : undefined },
		{ label: "Attachments", value: String(vaultSync?.blobPathCount ?? 0) },
		{ label: "Disk writes", value: String((disk?.queuedWrites.length ?? 0) + (disk?.debounceCount ?? 0) + (disk?.openDebounceCount ?? 0)), tone: hasDiskWork(disk) ? "busy" : "ok" },
		{ label: "Blob transfers", value: `${blob?.pendingUploads ?? 0} up / ${blob?.pendingDownloads ?? 0} down`, tone: hasBlobWork(blob) ? "busy" : "ok" },
		{ label: "Reconciled", value: yesNo(reconcile.reconciled), tone: toneForBoolean(reconcile.reconciled) },
		{ label: "Untracked", value: String(reconcile.untrackedFileCount), tone: reconcile.untrackedFileCount > 0 ? "warn" : "ok" },
		{ label: "Safety brake", value: reconcile.lastReconcileStats?.safetyBrakeTriggered ? "active" : "clear", tone: reconcile.lastReconcileStats?.safetyBrakeTriggered ? "error" : "ok" },
		{ label: "Last reconcile", value: reconcile.lastReconcileStats?.at ?? "never", tone: reconcile.lastReconcileStats ? undefined : "muted" },
		{ label: "Server receipt", value: receiptLabel(serverReceipt), tone: receiptTone(serverReceipt) },
	];
	if ((blob?.permanentUploadFailures ?? 0) > 0 || (blob?.permanentDownloadFailures ?? 0) > 0) {
		metrics.push({
			label: "Blob failures",
			value: `${blob?.permanentUploadFailures ?? 0} up / ${blob?.permanentDownloadFailures ?? 0} down`,
			tone: "error",
		});
	}
	if ((vaultSync?.pathBindingCollisionCount ?? 0) > 0) {
		metrics.push({
			label: "Path collisions",
			value: String(vaultSync?.pathBindingCollisionCount ?? 0),
			tone: "error",
		});
	}
	return metrics;
}

function yesNo(value: boolean | undefined): string {
	if (value === undefined) return "unknown";
	return value ? "yes" : "no";
}

function toneForBoolean(value: boolean | undefined): "ok" | "warn" | "muted" {
	if (value === undefined) return "muted";
	return value ? "ok" : "warn";
}

function hasDiskWork(disk: KaosDashboardCollectorInput["diskMirror"]): boolean {
	return Boolean(disk && (disk.queuedWrites.length > 0 || disk.debounceCount > 0 || disk.openDebounceCount > 0));
}

function hasBlobWork(blob: KaosDashboardCollectorInput["blobSync"]): boolean {
	return Boolean(blob && (
		blob.pendingUploads > 0 ||
		blob.pendingDownloads > 0 ||
		blob.processingUploads > 0 ||
		blob.processingDownloads > 0
	));
}

function receiptLabel(receipt: DashboardServerReceipt | undefined): string {
	if (!receipt) return "unknown";
	if (receipt.persistenceUnavailable) return "memory only";
	if (receipt.serverAppliedLocalState === true) return "confirmed";
	if (receipt.serverAppliedLocalState === false) return "pending";
	if (receipt.hasUnconfirmedCandidate) return "candidate";
	return "idle";
}

function receiptTone(receipt: DashboardServerReceipt | undefined): "ok" | "busy" | "warn" | "muted" {
	if (!receipt) return "muted";
	if (receipt.persistenceUnavailable || !receipt.candidatePersistenceHealthy) return "warn";
	if (receipt.serverAppliedLocalState === true) return "ok";
	if (receipt.serverAppliedLocalState === false || receipt.hasUnconfirmedCandidate) return "busy";
	return "muted";
}
