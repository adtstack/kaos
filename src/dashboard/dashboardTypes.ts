import type { ReconciliationState } from "../runtime/reconciliationController";
import type { RecoveryStorageAuditReport } from "../sync/recoverySnapshotClient";
import type { DiskIndex } from "../sync/diskIndex";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";
import type {
	PreservedUnresolvedEntry,
	PreservedUnresolvedKind,
	RemoteDeletePreservedUnresolvedReason,
} from "../sync/preservedUnresolved";
import type { BlobRef } from "../types";

export type DashboardTone = "ok" | "busy" | "warn" | "error" | "muted";

export interface DashboardMetric {
	label: string;
	value: string;
	tone?: DashboardTone;
}

export interface DashboardFileHistoryAttempt {
	attemptedAt: string;
	status: "created" | "noop" | "unavailable" | "pending";
	manifestId: string | null;
	reason: string | null;
	changedCount: number | null;
	forceFull: boolean;
	pending: {
		uploadedContentCount: number;
		totalContentCount: number;
		remainingContentCount: number;
	} | null;
}

export interface DashboardRecoveryHistoryTarget {
	initialManifestId: string;
	initialFileId: string;
	autoExpandDiff: boolean;
}

export interface DashboardConflictArtifact {
	artifactPath: string;
	inferredOriginalPath: string;
	originalExists: boolean;
	originalPathConfidence: "candidate" | "possibly-truncated";
	kind: "markdown" | "blob";
	source: "disk" | "crdt" | "editor" | "remote" | "local" | null;
	deviceName: string | null;
	timestamp: string;
	copyIndex: number | null;
	artifactMtime: number | null;
	artifactSize: number | null;
	artifactIndexed: boolean;
	originalIndexed: boolean;
	blobResolution: DashboardBlobConflictResolution | null;
}

export interface DashboardBlobConflictResolution {
	kind: "remote-download-conflict";
	episodeId: string;
	expectedLocalHash: string | null;
	expectedRemoteHash: string;
	expectedRemoteRef: BlobRef | null;
	expectedRemoteSourceVersion: string | null;
	originalFile: DashboardLocalFileIdentity;
	artifactFile: DashboardLocalFileIdentity;
	keepLocalPending: boolean;
	canKeepLocal: boolean;
	canUseRemoteCopy: boolean;
	keepLocalUnavailableReason: string | null;
	useRemoteCopyUnavailableReason: string | null;
}

export interface DashboardBlobConflictResolutionTarget
	extends DashboardBlobConflictResolution {
	path: string;
	artifactPath: string;
}

export type DashboardBlobConflictResolutionChoice =
	| "keep-local"
	| "use-remote-copy";

export type DashboardBlobConflictResolutionResult =
	| { status: "pending"; message: string }
	| {
		status: "completed";
		safetyCopyPath: string | null;
		artifactRemoved: boolean;
	};

export interface DashboardAttentionItem {
	kind: "preserved-unresolved" | "structural-change" | "blocked-divergence" | "frontmatter-quarantine";
	title: string;
	path: string | null;
	detail: string;
	structuralChange: {
		oldPaths: string[];
		newPaths: string[];
		contentHashPrefix: string;
	} | null;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
	tone: DashboardTone;
	resolution: DashboardAttentionResolution | null;
}

export interface DashboardLocalFileIdentity {
	kind: "file" | "missing" | "other";
	mtime: number | null;
	size: number | null;
}

export interface DashboardRemoteDeleteResolution {
	kind: "remote-delete";
	fileKind: PreservedUnresolvedKind;
	reason: RemoteDeletePreservedUnresolvedReason;
	episodeId: string;
	remoteDeleteFingerprint: string | null;
	localFile: DashboardLocalFileIdentity;
	canKeepLocal: boolean;
	canAcceptRemoteDelete: boolean;
	keepLocalPending: boolean;
	keepLocalUnavailableReason: string | null;
	acceptRemoteDeleteUnavailableReason: string | null;
}

export interface DashboardLegacyMissingBlobResolution {
	kind: "legacy-missing-blob";
	fileKind: "blob";
	reason: "legacy-upgrade-missing-local-blob";
	episodeId: string;
	remoteRef: BlobRef | null;
	localFile: DashboardLocalFileIdentity;
	canDownloadRemote: boolean;
	canKeepLocalAbsent: boolean;
	unavailableReason: string | null;
}

export type DashboardAttentionResolution =
	| DashboardRemoteDeleteResolution
	| DashboardLegacyMissingBlobResolution;

export interface DashboardRemoteDeleteResolutionTarget
	extends DashboardRemoteDeleteResolution {
	path: string;
}

export type DashboardRemoteDeleteResolutionChoice =
	| "keep-local"
	| "accept-remote-delete";

export type DashboardRemoteDeleteResolutionResult =
	| { status: "completed" }
	| { status: "pending"; message: string };

export interface DashboardLegacyMissingBlobResolutionTarget
	extends DashboardLegacyMissingBlobResolution {
	path: string;
}

export type DashboardLegacyMissingBlobResolutionChoice =
	| "download-remote"
	| "keep-local-absent";

export type DashboardSnapshotStatus =
	| { status: "ready"; summary: DashboardSnapshotStatusSummary }
	| { status: "unavailable" | "offline" | "error"; message: string };

export interface DashboardSnapshotStatusSummary {
	snapshotCountLowerBound: number;
	listedSnapshotCount: number;
	listingLimited: boolean;
	estimatedStorageBytesLowerBound: number;
	latestSnapshotId: string | null;
	latestCreatedAt: string | null;
	pinnedCountLowerBound: number;
}

export type DashboardRecentChanges =
	| {
		status: "ready";
		manifestCount: number;
		limited: boolean;
		latestCreatedAt: string | null;
		lastAttempt: DashboardFileHistoryAttempt | null;
		changes: DashboardRecentChange[];
	}
	| {
		status: "unavailable" | "offline" | "error";
		message: string;
		lastAttempt: DashboardFileHistoryAttempt | null;
	};

export type DashboardRecoveryStorageStatus =
	| { status: "ready"; report: RecoveryStorageAuditReport }
	| { status: "unavailable" | "offline" | "error"; message: string };

export interface DashboardRecentChange {
	manifestId: string;
	snapshotKind: "file-history";
	createdAt: string;
	fileId: string;
	changeKind: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	device: string | null;
	size: number | null;
	contentHash: string | null;
	previousContentHash: string | null;
}

export interface DashboardActionState {
	syncInitialized: boolean;
	untrackedFileCount: number;
	snapshotsAvailable: boolean;
	connected: boolean;
}

export interface KaosDashboardData {
	generatedAt: string;
	settings: {
		deviceName: string;
		vaultId: string;
		attachmentSyncEnabled: boolean;
		externalEditPolicy: string;
	};
	overview: DashboardMetric[];
	snapshotStatus: DashboardSnapshotStatus;
	recoveryStorageStatus: DashboardRecoveryStorageStatus;
	recentChanges: DashboardRecentChanges;
	conflicts: DashboardConflictArtifact[];
	/**
	 * Local rollback copies created during otherwise clean blob replacement or
	 * remote deletion. These are deliberately not counted as conflicts.
	 */
	blobSafetyCopies: DashboardConflictArtifact[];
	attention: DashboardAttentionItem[];
	attentionTotalCount: number;
	actions: DashboardActionState;
}

export interface DashboardVaultSyncDebug {
	connected: boolean;
	providerSynced: boolean;
	localReady: boolean;
	pathToIdCount: number;
	activePathCount: number;
	tombstonedPathCount: number;
	pathBindingCollisionCount?: number;
	blobPathCount: number;
	serverReceipt: {
		serverAppliedLocalState: boolean | null;
		lastServerReceiptEchoAt: number | null;
		lastKnownServerReceiptEchoAt: number | null;
		candidatePersistenceHealthy: boolean;
		hasUnconfirmedCandidate: boolean;
		persistenceUnavailable: boolean;
	};
}

export interface DashboardDiskMirrorDebug {
	queuedWrites: string[];
	debounceCount: number;
	openDebounceCount: number;
	suppressedCount: number;
}

export interface DashboardBlobSyncDebug {
	pendingUploads: number;
	pendingDownloads: number;
	processingUploads: number;
	processingDownloads: number;
	permanentUploadFailures: number;
	permanentDownloadFailures: number;
	blobConflictArtifacts: number;
	/** Session count of clean-operation rollback copies, when supported. */
	blobSafetyBackups?: number;
	localOnlyBlobConflictPaths: number;
}

export interface KaosDashboardCollectorInput {
	app: import("obsidian").App;
	generatedAt: string;
	settings: KaosDashboardData["settings"];
	syncStatusLabel: string;
	connectionLabel: string;
	connectionTone: DashboardTone;
	reconciliationState: ReconciliationState;
	vaultSync: DashboardVaultSyncDebug | null;
	diskMirror: DashboardDiskMirrorDebug | null;
	blobSync: DashboardBlobSyncDebug | null;
	preservedUnresolvedEntries: PreservedUnresolvedEntry[];
	remoteDeleteResolutionState?: {
		markdownAvailable: boolean;
		blobAvailable: boolean;
		getFingerprint(kind: PreservedUnresolvedKind, path: string): string | null;
		isKeepLocalPending(
			kind: PreservedUnresolvedKind,
			path: string,
			episodeId: string,
		): boolean;
		getBlobRef(path: string): BlobRef | null;
	};
	blobConflictResolutionState?: {
		available: boolean;
		isPathSyncable(path: string): boolean;
		getBlobRef(path: string): BlobRef | null;
		getBlobSourceVersion(path: string): string | null;
		isKeepLocalPending(path: string, episodeId: string): boolean;
		isUseRemoteResumePending(path: string, episodeId: string): boolean;
	};
	frontmatterQuarantineEntries: FrontmatterQuarantineEntry[];
	diskIndex: DiskIndex;
	snapshotStatus: DashboardSnapshotStatus;
	recoveryStorageStatus: DashboardRecoveryStorageStatus;
	recentChanges: DashboardRecentChanges;
	openFileCount: number;
	snapshotsAvailable: boolean;
}
