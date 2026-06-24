import type { ReconciliationState } from "../runtime/reconciliationController";
import type { DiskIndex } from "../sync/diskIndex";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";
import type { PreservedUnresolvedEntry } from "../sync/preservedUnresolved";

export type DashboardTone = "ok" | "busy" | "warn" | "error" | "muted";

export interface DashboardMetric {
	label: string;
	value: string;
	tone?: DashboardTone;
}

export interface DashboardConflictArtifact {
	artifactPath: string;
	inferredOriginalPath: string;
	originalExists: boolean;
	originalPathConfidence: "candidate" | "possibly-truncated";
	kind: "markdown" | "blob";
	source: "disk" | "crdt" | "editor" | "remote" | null;
	deviceName: string | null;
	timestamp: string;
	copyIndex: number | null;
	artifactMtime: number | null;
	artifactSize: number | null;
	artifactIndexed: boolean;
	originalIndexed: boolean;
}

export interface DashboardAttentionItem {
	kind: "preserved-unresolved" | "structural-change" | "blocked-divergence" | "frontmatter-quarantine";
	title: string;
	path: string | null;
	detail: string;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
	tone: DashboardTone;
}

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
	| { status: "ready"; manifestCount: number; limited: boolean; changes: DashboardRecentChange[] }
	| { status: "unavailable" | "offline" | "error"; message: string };

export interface DashboardRecentChange {
	manifestId: string;
	snapshotKind: "full" | "delta";
	createdAt: string;
	fileId: string;
	changeKind: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	device: string | null;
	size: number | null;
	contentHash: string | null;
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
	recentChanges: DashboardRecentChanges;
	conflicts: DashboardConflictArtifact[];
	attention: DashboardAttentionItem[];
	actions: DashboardActionState;
}

export interface DashboardVaultSyncDebug {
	connected: boolean;
	providerSynced: boolean;
	localReady: boolean;
	pathToIdCount: number;
	activePathCount: number;
	tombstonedPathCount: number;
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
	frontmatterQuarantineEntries: FrontmatterQuarantineEntry[];
	diskIndex: DiskIndex;
	snapshotStatus: DashboardSnapshotStatus;
	recentChanges: DashboardRecentChanges;
	openFileCount: number;
	snapshotsAvailable: boolean;
}
