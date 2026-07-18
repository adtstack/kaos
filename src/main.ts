import { MarkdownView, Notice, Plugin, TFile, arrayBufferToHex, normalizePath, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	generateVaultId,
	type VaultSyncSettings,
} from "./settings";
import { SettingsStore } from "./settings/settingsStore";
import {
	VaultSync,
	type BlobDeleteCommitResult,
	type CausalBlobRenameResult,
	type ReconcileMode,
} from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/vaultSync";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import {
	moveSettledBlobRefs,
	type BlobQueueSnapshot,
	type BlobSettlementStage,
	type BlobSettlementStageCache,
	type BlobSettledRefCache,
	type BlobSettledSourceVersionCache,
	type BlobSyncManager,
} from "./sync/blobSync";
import {
	type ServerCapabilities,
} from "./sync/serverCapabilities";
import {
	cloneBlobRef,
	isBlobSyncable,
	isMarkdownSyncable,
	sameBlobRef,
	type BlobRef,
} from "./types";
import { planCategoryRenameAction } from "./sync/policy/renameAdmissionPolicy";
import {
	planBlobDeleteCommit,
	planMarkdownDeleteCommit,
	planRenameEventCommit,
} from "./sync/policy/vaultEventCommitPolicy";
import { classifySyncPath } from "./paths/pathCategory";
import { isCrdtDocumentPath } from "./paths/crdtDocumentPath";
import type { TraceSink, ProductFlightPathEventInput } from "./observability/traceSink";
import { NoopTraceSink } from "./observability/noopTraceSink";
import {
	type FrontmatterValidationResult,
} from "./sync/frontmatterGuard";
import {
	readPersistedFrontmatterQuarantine,
	type FrontmatterQuarantineEntry,
} from "./sync/frontmatterQuarantine";
import {
	FrontmatterGuardCoordinator,
} from "./sync/frontmatterGuardCoordinator";
import { createSocketTicketCache, isTicketEndpointUnsupported } from "./sync/socketTicket";
import {
	contentBaselineHash,
	type DiskIndex,
	moveIndexEntries,
	waitForDiskQuiet,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
	removeCachedHash,
} from "./sync/blobHashCache";
import {
	BASELINE_TEXT_STORE_VERSION,
	applyPersistedBaselineTextFields,
	collectReferencedBaselineHashes,
	pruneBaselineTextStore,
	readBaselineTextStore,
	readConflictMergeBaseStore,
	type BaselineTextRepository,
	type BaselineTextStore,
	type ConflictMergeBaseStore,
} from "./sync/baselineTextStore";
import { IndexedDbBaselineTextRepository } from "./sync/indexedDbBaselineTextRepository";
import {
	buildBlobSettledRefStoreKey,
	IndexedDbBlobSettledRefStore,
} from "./sync/indexedDbBlobSettledRefStore";
import {
	BlobAuthorityScopeGuard,
	buildBlobAuthorityScopeIdentity,
	canonicalizeBlobAuthorityScope,
	type BlobAuthorityEnsureToken,
	type BlobAuthorityScopeToken,
} from "./sync/blobAuthorityScopeGuard";
import {
	collectLegacyMissingBlobPaths,
	LEGACY_MISSING_BLOB_ATTENTION_REASON,
	scrubBlobSettlementDocumentOwnership,
	type LocalDeviceIdentityStatus,
} from "./sync/blobSettledRefMigration";
import {
	getPreservedUnresolvedEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	PreservedUnresolvedRegistry,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
} from "./sync/preservedUnresolved";
import {
	PendingBlobIntentJournal,
	migratePendingBlobIntentDocumentOwnership,
	pendingBlobIntentsOverlap,
	type PendingBlobIntent,
	type PendingBlobIntentScope,
	type PendingBlobMutationBase,
} from "./sync/pendingBlobIntentJournal";
import {
	commitPendingBlobIntentWithWriteAhead,
	type PendingBlobIntentCommitOutcome,
} from "./sync/pendingBlobIntentCommit";
import {
	buildPendingBlobIntentStoreKey,
	IndexedDbPendingBlobIntentStore,
} from "./sync/indexedDbPendingBlobIntentStore";
import {
	createPersistedBlobQueueSnapshot,
	readPersistedBlobQueueSnapshot,
	type PersistedBlobQueueSnapshot,
} from "./sync/persistedBlobQueue";
import {
	SnapshotService,
} from "./snapshots/snapshotService";
import {
	getFileHistoryStorageStatus,
	type RecoveryStorageAuditReport,
} from "./sync/recoverySnapshotClient";
import type {
	TraceEventDetails,
	TraceHttpContext,
} from "./observability/traceContext";
import {
	CapabilityUpdateService,
	readPersistedServerCapabilitiesCache,
	readPersistedUpdateManifestCache,
	type PersistedServerCapabilitiesCache,
	type PersistedUpdateManifestCache,
	type UpdateState,
} from "./runtime/capabilityUpdateService";
import {
	readPersistedGuidedServerUpdateState,
	type PersistedGuidedServerUpdateState,
} from "./runtime/guidedServerUpdate";
import {
	ConnectionController,
	type ConnectionState,
} from "./runtime/connectionController";
import {
	buildRuntimeConfig,
	type RuntimeConfig,
} from "./runtime/runtimeConfig";
import {
	ReconciliationController,
	type MarkdownDirtyReason,
	type StableMarkdownReadResult,
} from "./runtime/reconciliationController";
import { AttachmentOrchestrator } from "./runtime/attachmentOrchestrator";
import { EditorWorkspaceOrchestrator } from "./runtime/editorWorkspaceOrchestrator";
import { SetupLinkController } from "./runtime/setupLinkController";
import { TraceRuntimeController } from "./runtime/traceRuntimeController";
import { registerCommands } from "./commands";
import {
	buildKaosDashboardData,
	getDashboardAttentionTotalCount,
} from "./dashboard/dashboardData";
import { withAttentionResolutionLock } from "./dashboard/attentionResolutionLock";
import { mapWithConcurrency } from "./utils/concurrency";
import {
	KAOS_DASHBOARD_VIEW_TYPE,
	KaosDashboardView,
} from "./dashboard/KaosDashboardView";
import type {
	DashboardLegacyMissingBlobResolutionChoice,
	DashboardLegacyMissingBlobResolutionTarget,
	DashboardRemoteDeleteResolutionChoice,
	DashboardRemoteDeleteResolutionResult,
	DashboardRemoteDeleteResolutionTarget,
	DashboardLocalFileIdentity,
	KaosDashboardData,
	DashboardTone,
} from "./dashboard/dashboardTypes";
import {
	getSyncStatusLabel,
	renderConnectionState,
	renderSyncStatus,
	type SyncStatus,
} from "./status/statusBarController";
import { formatUnknown, yTextToString } from "./utils/format";
import { randomBase64Url } from "./utils/base64url";
import { ConfirmModal } from "./ui/ConfirmModal";
import { runSchemaMigrationToV2 } from "./migrations/schemaV2";
import type { TelemetryRuntimeHandle } from "./telemetry/installTelemetryRuntime";
import type { EngineControlPort, DiskIngestPort } from "./runtime/engineControlPort";
import type { BindingPropagationGate } from "./sync/editorBinding";
import { getOrCreateLocalDeviceIdentity } from "./sync/indexedDbCandidateStore";

// Build-time constant injected by esbuild.
//   production build (main.js):          define __KAOS_QA_HARNESS_ENABLED__ = false
//   QA product build (product-main.js):  define __KAOS_QA_HARNESS_ENABLED__ = true
// When false, esbuild dead-code-eliminates all blocks gated on this constant.
// The declare tells TypeScript the type; the actual value comes from the esbuild define.
declare const __KAOS_QA_HARNESS_ENABLED__: boolean;

const RECOVERY_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const CRDT_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DISK_INDEX_SAVE_DEBOUNCE_MS = 500;

type PendingBlobReplayPrecondition = {
	kind: "precondition-changed";
	disposition: "remove-intent" | "retain-intent";
	path: string;
	observedOccupant?: object;
	admitObservedFile?: boolean;
};

type PendingBlobReplayMutation = {
	kind: "mutation";
	sourcePath: string;
	result: BlobDeleteCommitResult | CausalBlobRenameResult;
};

type PendingBlobReplayApplyResult =
	| PendingBlobReplayPrecondition
	| PendingBlobReplayMutation;

type PersistedPluginState = Partial<VaultSyncSettings> & {
	_diskIndex?: DiskIndex;
	_baselineTexts?: BaselineTextStore;
	_conflictMergeBases?: ConflictMergeBaseStore;
	_baselineTextStoreVersion?: number;
	_blobHashCache?: BlobHashCache;
	/** Legacy unscoped cache; ignored because data.json may be copied cross-device. */
	_blobSettledRefs?: BlobSettledRefCache;
	_blobSettledRefsByDevice?: Record<string, BlobSettledRefCache>;
	/**
	 * Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Semantically: "the last time KAOS durably persisted its disk-index
	 * baselines to data.json." Used by decideClosedFileConflict to detect
	 * "disk file was edited while KAOS was inactive" when baselineHash is
	 * missing. This is a heuristic timestamp — it is the last save, not
	 * necessarily the last time KAOS observed the specific file.
	 * See: src/sync/closedFileConflict.ts ClosedFileConflictInput.lastDiskIndexPersistedAt
	 */
	_lastDiskIndexPersistedAt?: number;
	_blobQueue?: PersistedBlobQueueSnapshot;
	_serverCapabilitiesCache?: PersistedServerCapabilitiesCache;
	_updateManifestCache?: PersistedUpdateManifestCache;
	_guidedServerUpdate?: PersistedGuidedServerUpdateState;
	_frontmatterQuarantine?: FrontmatterQuarantineEntry[];
	_preservedUnresolved?: PreservedUnresolvedEntry[];
	_pendingBlobIntents?: PendingBlobIntent[];
};

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;
	private readonly settingsStore = new SettingsStore<PersistedPluginState>({
		loadData: () => this.loadData(),
		saveData: (data) => this.saveData(data),
	});
	private runtimeConfig: RuntimeConfig | null = null;

	private vaultSync: VaultSync | null = null;
	private connectionController: ConnectionController | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private attachmentOrchestrator: AttachmentOrchestrator | null = null;
	private editorWorkspace: EditorWorkspaceOrchestrator | null = null;
	private snapshotService: SnapshotService | null = null;
	private lastRecoveryStorageStatus: RecoveryStorageAuditReport | null = null;
	private lastRecoveryStorageStatusError: string | null = null;
	private reconciliationController!: ReconciliationController;
	private setupLinkController: SetupLinkController | null = null;
	private traceRuntime: TraceRuntimeController | null = null;
	/** Telemetry runtime handle — null until dynamically loaded. */
	private lab: TelemetryRuntimeHandle | null = null;

	// ---------------------------------------------------------------------------
	// QA harness state — only populated when __KAOS_QA_HARNESS_ENABLED__ is true.
	//
	// In production (main.js), esbuild defines __KAOS_QA_HARNESS_ENABLED__=false
	// and dead-code-eliminates every block gated on it.  This field itself is
	// declared here so TypeScript is satisfied; the constructor initialises it to
	// null (one innocent assignment), and every meaningful access lives inside a
	// gated block that disappears from main.js entirely.
	//
	// In the QA product build (product-main.js), __KAOS_QA_HARNESS_ENABLED__=true
	// and the full state object is constructed in onload() before the first
	// createReconciliationController() call.
	// ---------------------------------------------------------------------------
	private _qaState: {
		diskIngestPort: DiskIngestPort | null;
		externalEditPolicyOverride: import("./settings").ExternalEditPolicy | null;
		pausedEditorPropagationPaths: Set<string>;
		bindingReconfigureHook: ((path: string, deviceName: string, action: "pause" | "resume") => void) | null;
		controlPort: EngineControlPort;
	} | null = null;
	/** Domain-level trace sink. Routes to lab when active, noop otherwise. */
	private traceSink: TraceSink = new NoopTraceSink();
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;
	private recoverySnapshotInterval: ReturnType<typeof setInterval> | null = null;
	private crdtSnapshotInterval: ReturnType<typeof setInterval> | null = null;

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};
	/**
	 * Unix ms timestamp of the last saveDiskIndex() that completed successfully.
	 * Semantics: "last time KAOS durably persisted disk-index state."
	 * This is a global (not per-file) heuristic timestamp used only as a
	 * tie-breaker in the missing-baseline closed-file conflict path.
	 * Naming: lastDiskIndexPersistedAt, not lastPluginActiveAt — these are
	 * not the same thing, and conflating them creates false certainty.
	 */
	private lastDiskIndexPersistedAt = 0;

	/** Persisted blob hash cache: {path -> {mtime, size, hash}}. */
	private blobHashCache: BlobHashCache = {};
	/** Last exact disk/ref settlement per attachment path. */
	private blobSettledRefs: BlobSettledRefCache = {};
	/** Exact CRDT item episode paired with each settled attachment ref. */
	private blobSettledSourceVersions: BlobSettledSourceVersionCache = {};
	/** Durable pre-commit settlement/retirement fences. */
	private blobSettlementStages: BlobSettlementStageCache = {};
	private blobSettledRefStore: IndexedDbBlobSettledRefStore | null = null;
	private blobSettledRefStoreKey: string | null = null;
	private blobSettledRefPersistChain: Promise<void> = Promise.resolve();
	private blobSettledRefPersistenceHealthy = false;
	private readonly blobAuthorityScopeGuard = new BlobAuthorityScopeGuard();
	/** Exact identity+epoch authority captured when each VaultSync was constructed. */
	private readonly vaultSyncBlobAuthorityTokens = new WeakMap<
		VaultSync,
		BlobAuthorityScopeToken
	>();
	private blobAuthorityResetInProgress = false;
	/** Device-local v4 upgrade fence; paths remain blocked until explicit resolution. */
	private legacyMissingBlobPaths = new Set<string>();
	/** Corrupt authority is never auto-healed; only explicit nuclear reset unlatches it. */
	private readonly corruptBlobSettledRefStoreKeys = new Set<string>();

	/** Persisted blob queue snapshot for crash resilience. */
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	/** Local attachment deletes/renames waiting for authoritative provider state. */
	private readonly pendingBlobIntents = new PendingBlobIntentJournal();
	private readonly blobIntentSessionId = randomBase64Url(16);
	private blobIntentLocalDeviceId: string | null = null;
	private blobLocalDeviceIdentityStatus: LocalDeviceIdentityStatus = "unknown";
	private pendingBlobIntentStore: IndexedDbPendingBlobIntentStore | null = null;
	private pendingBlobIntentStoreKey: string | null = null;
	private pendingBlobIntentPersistChain: Promise<void> = Promise.resolve();
	private pendingBlobIntentPersistenceHealthy = false;
	private readonly corruptPendingBlobIntentStoreKeys = new Set<string>();
	private pendingBlobIntentReplayChain: Promise<void> = Promise.resolve();
	private readonly replayedCommittedBlobIntentIds = new Set<string>();
	/** Exact in-session destination identity for pending rename postconditions. */
	private readonly pendingBlobRenameFiles = new Map<string, TFile>();
	private preservedUnresolvedEntries: PreservedUnresolvedEntry[] = [];
	/** Canonical kind:path locks spanning the full dashboard resolution action. */
	private attentionResolutionInFlight = new Set<string>();
	/** Markdown trash events owned by Accept must not publish a second delete. */
	private attentionMarkdownDeleteInFlight = new Map<string, TFile>();
	private persistedState: PersistedPluginState = {};
	private persistWriteChain: Promise<void> = Promise.resolve();
	private diskIndexSaveTimer: ReturnType<typeof setTimeout> | null = null;

	/** Pending stability checks for newly created/dropped files. */
	private pendingStabilityChecks = new Set<string>();

	/** In-memory ring of recent high-level plugin events. */
	private eventRing: Array<{ ts: string; msg: string }> = [];

	private capabilityUpdateService: CapabilityUpdateService | null = null;
	private commandsRegistered = false;
	private idbDegradedHandled = false;
	private frontmatterGuardCoordinator!: FrontmatterGuardCoordinator;
	private frontmatterQuarantineEntries: FrontmatterQuarantineEntry[] = [];
	private baselineTexts: BaselineTextStore = {};
	private conflictMergeBases: ConflictMergeBaseStore = {};
	private baselineTextRepository: BaselineTextRepository | null = null;
	private baselineTextsExternalized = false;
	private readonly dirtyBaselineTextHashes = new Set<string>();
	private readonly baselineTextDeleteCandidates = new Set<string>();
	private baselineTextFullGcPending = false;

	/**
	 * True when startup timed out waiting for provider sync.
	 * We use this to force one authoritative reconcile on the first late
	 * provider sync event, even if connection generation did not change.
	 */
	private awaitingFirstProviderSyncAfterStartup = false;
	/** Uploads require both local Yjs persistence and a provider-synced room. */
	private blobLocalPersistenceReady = false;
	private blobProviderReady = false;
	private createReconciliationController(): ReconciliationController {
		this.reconciliationController = new ReconciliationController({
			app: this.app,
			getSettings: () => this.settings,
			getRuntimeConfig: () => this.getRuntimeConfig(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.getBlobSync(),
			getEditorBindings: () => this.editorBindings,
			getDiskIndex: () => this.diskIndex,
			setDiskIndex: (index) => this.replaceDiskIndex(index),
			getBaselineText: (contentHash) => this.getBaselineText(contentHash),
			recordBaselineText: (contentHash, text) => this.recordBaselineText(contentHash, text),
			recordConflictMergeBase: (artifactPath, baseHash) => {
				const previousHash = this.conflictMergeBases[artifactPath];
				this.conflictMergeBases[artifactPath] = baseHash;
				if (previousHash && previousHash !== baseHash) this.baselineTextDeleteCandidates.add(previousHash);
			},
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			shouldTombstoneIntrinsicMarkdownPath: (path) => this.isIntrinsicMarkdownPathExcluded(path),
			shouldTombstoneIntrinsicBlobPath: (path) => this.isIntrinsicBlobPathExcluded(path),
			shouldBlockFrontmatterIngest: (path, previousContent, nextContent, reason) =>
				this.shouldBlockFrontmatterIngest(path, previousContent, nextContent, reason),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			validateOpenEditorBindings: (reason) => this.editorWorkspace?.validateOpenBindings(reason),
			replayPendingBlobIntents: (reason) => this.replayPendingBlobIntents(reason),
			onReconciled: (reason) => this.editorWorkspace?.onReconciled(reason),
			onBlobReconciled: (mode, reconciledVaultSync) => {
				if (
					mode === "authoritative"
					&& this.isVaultSyncBoundToCurrentBlobScope(reconciledVaultSync)
					&& !this.blobAuthorityResetInProgress
					&& this.app.workspace.layoutReady
					&& reconciledVaultSync.idbError !== true
					&& this.blobLocalPersistenceReady
					&& this.blobProviderReady
					&& this.pendingBlobIntentPersistenceHealthy
					&& this.blobSettledRefPersistenceHealthy
				) {
					this.attachmentOrchestrator?.markUploadAuthorityReady(
						"authoritative-reconcile",
					);
				}
			},
			getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
			setAwaitingFirstProviderSyncAfterStartup: (value) => {
				this.awaitingFirstProviderSyncAfterStartup = value;
			},
			saveDiskIndex: () => this.saveDiskIndex(),
			refreshStatusBar: () => this.refreshStatusBar(),
			getLastSaveDiskIndexAt: () => this.lastDiskIndexPersistedAt,
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
			recordFlightEvent: (event) => this.recordFlightEvent(event as import("./telemetry/debug/flightEvents").FlightEventInput),
			recordFlightPathEvent: (event) => this.recordFlightPathEvent(event),
			readStableMarkdownFile: (path, reason) => this.readStableMarkdownFile(path, reason),
			computeRecoveryStateHash: async (_path, content) => {
				return this.lab?.computeWitnessStateHash(content) ?? null;
			},
			getEffectiveExternalEditPolicy: (runtimePolicy) => {
				if (__KAOS_QA_HARNESS_ENABLED__) {
					const override = this._qaState?.externalEditPolicyOverride;
					if (override != null) return override;
				}
				return runtimePolicy;
			},
			registerDiskIngestPort: (port) => {
				if (__KAOS_QA_HARNESS_ENABLED__ && this._qaState) {
					this._qaState.diskIngestPort = port;
				}
			},
		});
		return this.reconciliationController;
	}

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	/** MarkdownView/y-codemirror binding remains `.md`-only. */
	private isMarkdownEditorPathSyncable(path: string): boolean {
		return path.endsWith(".md") && this.isMarkdownPathSyncable(path);
	}

	private isBlobPathSyncable(path: string): boolean {
		return isBlobSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	/**
	 * Remote cleanup deliberately ignores user-configured exclusions. These are
	 * the hard system/temp/generated-path rules that KAOS can safely tombstone
	 * after a complete provider sync.
	 */
	private isIntrinsicMarkdownPathExcluded(path: string): boolean {
		return !isMarkdownSyncable(path, [], this.getRuntimeConfig().vaultConfigDir);
	}

	private isIntrinsicBlobPathExcluded(path: string): boolean {
		// A pre-upgrade room may still contain a blob ref for a normal `.base`
		// document. Keep that legacy ref dormant instead of tombstoning it during
		// the same reconcile that admits the disk file into the CRDT document lane.
		// Safety artifacts and temporary paths do not receive this exception.
		if (
			path.endsWith(".base")
			&& isMarkdownSyncable(path, [], this.getRuntimeConfig().vaultConfigDir)
		) return false;
		return !isBlobSyncable(path, [], this.getRuntimeConfig().vaultConfigDir);
	}

	private getRuntimeConfig(): RuntimeConfig {
		if (!this.runtimeConfig) {
			this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		}
		return this.runtimeConfig;
	}

	private getBlobSync(): BlobSyncManager | null {
		return this.attachmentOrchestrator?.manager ?? null;
	}

	private getBlobIntentScope(): PendingBlobIntentScope {
		const runtime = this.getRuntimeConfig();
		return canonicalizeBlobAuthorityScope({
			host: runtime.host,
			vaultId: runtime.vaultId,
			localDeviceId: this.blobIntentLocalDeviceId ?? "",
		});
	}

	private activateBlobAuthorityScope(
		reason: string,
		scope = this.getBlobIntentScope(),
		options: { force?: boolean; detachStores?: boolean } = {},
	): { scope: PendingBlobIntentScope; token: BlobAuthorityScopeToken; changed: boolean } {
		const activation = this.blobAuthorityScopeGuard.activate(scope, {
			force: options.force,
		});
		if (!activation.changed) return activation;

		// The guard advances its epoch before any authority below is touched. A
		// delayed completion from the prior scope is stale from this point onward.
		this.pendingBlobIntentPersistenceHealthy = false;
		this.blobSettledRefPersistenceHealthy = false;
		this.blobLocalPersistenceReady = false;
		this.blobProviderReady = false;
		for (const path of Object.keys(this.blobSettledRefs)) {
			delete this.blobSettledRefs[path];
		}
		for (const path of Object.keys(this.blobSettledSourceVersions)) {
			delete this.blobSettledSourceVersions[path];
		}
		for (const path of Object.keys(this.blobSettlementStages)) {
			delete this.blobSettlementStages[path];
		}
		// BlobSyncManager captures the prior object by reference. Clearing it above
		// revokes that manager; the new object belongs only to the new scope.
		this.blobSettledRefs = {};
		this.blobSettledSourceVersions = {};
		this.blobSettlementStages = {};
		this.legacyMissingBlobPaths.clear();
		this.pendingBlobRenameFiles.clear();
		this.replayedCommittedBlobIntentIds.clear();
		this.savedBlobQueue = null;
		this.attachmentOrchestrator?.hydrateSavedQueue(null);
		const blobSync = this.getBlobSync();
		for (const entry of blobSync?.getPreservedUnresolvedEntries() ?? []) {
			if (
				entry.kind === "blob"
				&& entry.reason === LEGACY_MISSING_BLOB_ATTENTION_REASON
			) blobSync?.clearPreservedUnresolved(entry.path);
		}
		this.preservedUnresolvedEntries = this.preservedUnresolvedEntries.filter((entry) =>
			entry.kind !== "blob"
			|| entry.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON
		);
		delete this.persistedState._blobQueue;
		if (options.detachStores !== false) {
			this.pendingBlobIntentStore = null;
			this.pendingBlobIntentStoreKey = null;
			this.blobSettledRefStore = null;
			this.blobSettledRefStoreKey = null;
		}
		this.attachmentOrchestrator?.resetBlobRuntimeAuthority(
			`blob-authority-scope-change:${reason}`,
		);
		this.trace("blob", "blob-authority-scope-activated", {
			reason,
			epoch: activation.token.epoch,
			configured: activation.token.identity !== null,
		});
		return activation;
	}

	private isCurrentBlobAuthority(
		token: BlobAuthorityScopeToken,
	): boolean {
		return this.blobAuthorityScopeGuard.isCurrent(token, this.getBlobIntentScope());
	}

	private isVaultSyncBoundToCurrentBlobScope(vaultSync: VaultSync): boolean {
		const token = this.vaultSyncBlobAuthorityTokens.get(vaultSync);
		return this.vaultSync === vaultSync
			&& !!token
			&& this.blobAuthorityScopeGuard.isCurrent(
				token,
				this.getBlobIntentScope(),
			);
	}

	private captureBlobRuntimeAuthority(
		vaultSync: VaultSync,
		scope: PendingBlobIntentScope,
	): BlobAuthorityScopeToken | null {
		const token = this.vaultSyncBlobAuthorityTokens.get(vaultSync);
		if (
			!token
			|| this.vaultSync !== vaultSync
			|| this.blobAuthorityResetInProgress
			|| !this.blobAuthorityScopeGuard.isCurrent(token, scope)
		) return null;
		return { ...token };
	}

	private isBlobRuntimeAuthorityCurrent(
		vaultSync: VaultSync,
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken,
	): boolean {
		const bound = this.vaultSyncBlobAuthorityTokens.get(vaultSync);
		return this.vaultSync === vaultSync
			&& !this.blobAuthorityResetInProgress
			&& !!bound
			&& bound.identity === token.identity
			&& bound.epoch === token.epoch
			&& this.blobAuthorityScopeGuard.isCurrent(token, scope);
	}

	private isCurrentPendingBlobEnsure(
		token: BlobAuthorityEnsureToken,
		scope: PendingBlobIntentScope,
		key: string,
		store: IndexedDbPendingBlobIntentStore,
	): boolean {
		return this.blobAuthorityScopeGuard.isCurrentEnsure(token, scope, key, store);
	}

	private isCurrentSettledBlobEnsure(
		token: BlobAuthorityEnsureToken,
		scope: PendingBlobIntentScope,
		key: string,
		store: IndexedDbBlobSettledRefStore,
	): boolean {
		return this.blobAuthorityScopeGuard.isCurrentEnsure(token, scope, key, store);
	}

	private async waitForStablePendingBlobIntentTail(
		token: BlobAuthorityScopeToken,
	): Promise<boolean> {
		for (;;) {
			const tail = this.pendingBlobIntentPersistChain;
			try {
				await tail;
			} catch {
				// A later write may recover the serialized lane.
			}
			if (!this.isCurrentBlobAuthority(token)) return false;
			if (tail === this.pendingBlobIntentPersistChain) return true;
		}
	}

	private async waitForStableBlobSettledRefTail(
		token: BlobAuthorityScopeToken,
	): Promise<boolean> {
		for (;;) {
			const tail = this.blobSettledRefPersistChain;
			try {
				await tail;
			} catch {
				// A later write may recover the serialized lane.
			}
			if (!this.isCurrentBlobAuthority(token)) return false;
			if (tail === this.blobSettledRefPersistChain) return true;
		}
	}

	private isCurrentPendingBlobWrite(
		token: BlobAuthorityScopeToken,
		key: string,
		store: IndexedDbPendingBlobIntentStore,
		write: Promise<void>,
		ensureToken?: BlobAuthorityEnsureToken,
	): boolean {
		const currentScope = this.getBlobIntentScope();
		return this.blobAuthorityScopeGuard.isCurrent(token, currentScope)
			&& !!currentScope.host
			&& !!currentScope.vaultId
			&& !!currentScope.localDeviceId
			&& buildPendingBlobIntentStoreKey(currentScope) === key
			&& this.pendingBlobIntentStoreKey === key
			&& this.pendingBlobIntentStore === store
			&& this.pendingBlobIntentPersistChain === write
			&& (!ensureToken
				|| this.isCurrentPendingBlobEnsure(ensureToken, currentScope, key, store));
	}

	private enqueuePendingBlobIntentSnapshot(
		scope: PendingBlobIntentScope,
		key: string,
		store: IndexedDbPendingBlobIntentStore,
		snapshot: PendingBlobIntent[],
		ensureToken?: BlobAuthorityEnsureToken,
	): Promise<void> {
		const token = ensureToken ?? this.blobAuthorityScopeGuard.capture();
		if (
			this.blobAuthorityResetInProgress
			|| !this.blobAuthorityScopeGuard.isCurrent(token, scope)
			|| this.pendingBlobIntentStoreKey !== key
			|| this.pendingBlobIntentStore !== store
		) {
			return Promise.reject(new Error(
				"Pending attachment intent store is not current for the active scope",
			));
		}

		// A queued write closes authority immediately. Only the latest current tail
		// may reopen it; an earlier success cannot overtake a later pending write.
		this.pendingBlobIntentPersistenceHealthy = false;
		const write = this.pendingBlobIntentPersistChain
			.catch(() => undefined)
			.then(() => store.save(snapshot));
		this.pendingBlobIntentPersistChain = write;
		void write.then(
			() => {
				if (!this.isCurrentPendingBlobWrite(token, key, store, write, ensureToken)) return;
				this.pendingBlobIntentPersistenceHealthy =
					!this.corruptPendingBlobIntentStoreKeys.has(key);
			},
			(err) => {
				if (!this.isCurrentPendingBlobWrite(token, key, store, write, ensureToken)) return;
				this.pendingBlobIntentPersistenceHealthy = false;
				this.log(`Failed to persist pending attachment intent: ${formatUnknown(err)}`);
				this.attachmentOrchestrator?.revokeUploadAuthority(
					"intent-journal-write-failed",
				);
			},
		);
		return write;
	}

	private async ensurePendingBlobIntentPersistence(): Promise<boolean> {
		const activation = this.activateBlobAuthorityScope(
			"ensure-pending-intent",
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		if (
			this.blobAuthorityResetInProgress
			|| !scope.host
			|| !scope.vaultId
			|| !scope.localDeviceId
		) {
			this.pendingBlobIntentPersistenceHealthy = false;
			return false;
		}
		const key = buildPendingBlobIntentStoreKey(scope);
		if (this.corruptPendingBlobIntentStoreKeys.has(key)) {
			this.pendingBlobIntentPersistenceHealthy = false;
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-corrupt-latched",
			);
			return false;
		}
		if (
			this.pendingBlobIntentStore
			&& this.pendingBlobIntentStoreKey === key
			&& this.pendingBlobIntentPersistenceHealthy
		) return true;

		// Detach before awaiting. This invalidates callbacks belonging to a failed
		// same-scope store without discarding its serialized tail.
		this.pendingBlobIntentPersistenceHealthy = false;
		this.pendingBlobIntentStore = null;
		this.pendingBlobIntentStoreKey = null;
		let store: IndexedDbPendingBlobIntentStore;
		try {
			store = new IndexedDbPendingBlobIntentStore(scope);
		} catch (err) {
			if (!this.blobAuthorityScopeGuard.isCurrent(activation.token, scope)) return false;
			this.log(`Local attachment intent journal unavailable: ${formatUnknown(err)}`);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-unavailable",
			);
			return false;
		}
		const ensureToken = this.blobAuthorityScopeGuard.beginEnsure(
			"pending",
			scope,
			key,
			store,
		);

		if (!await this.waitForStablePendingBlobIntentTail(ensureToken)) return false;
		if (!this.isCurrentPendingBlobEnsure(ensureToken, scope, key, store)) return false;
		const loadTail = this.pendingBlobIntentPersistChain;
		try {
			const loaded = await store.loadWithStatus();
			if (
				this.pendingBlobIntentPersistChain !== loadTail
				|| !this.isCurrentPendingBlobEnsure(ensureToken, scope, key, store)
			) return false;
			if (loaded.status === "corrupt") {
				this.corruptPendingBlobIntentStoreKeys.add(key);
				this.log("Local attachment intent journal is corrupt; attachment transfers remain paused");
				this.attachmentOrchestrator?.revokeUploadAuthority(
					"intent-journal-corrupt",
				);
				return false;
			}

			const inMemory = this.pendingBlobIntents.getEntries(scope);
			const merged = new Map(loaded.entries.map((entry) => [entry.id, entry]));
			for (const entry of inMemory) merged.set(entry.id, entry);
			const mergedEntries = Array.from(merged.values());
			const migratedEntries = mergedEntries.map((entry) => ({
				before: entry,
				after: migratePendingBlobIntentDocumentOwnership(entry),
			}));
			const entries = migratedEntries
				.map(({ after }) => after)
				.filter((entry): entry is PendingBlobIntent => entry !== null);
			const scrubbedDocumentIntentCount = migratedEntries.filter(
				({ before, after }) => after !== before,
			).length;
			const foreignEntries = this.pendingBlobIntents.getEntries().filter((entry) =>
				buildPendingBlobIntentStoreKey(entry.scope) !== key
			);
			this.pendingBlobIntents.hydrate([...foreignEntries, ...entries]);
			this.pendingBlobIntentStore = store;
			this.pendingBlobIntentStoreKey = key;
			if (scrubbedDocumentIntentCount > 0) {
				this.trace("blob", "pending-blob-document-intents-scrubbed", {
					count: scrubbedDocumentIntentCount,
					phase: "hydrate",
				});
			}

			if (
				loaded.status === "missing"
				|| inMemory.length > 0
				|| scrubbedDocumentIntentCount > 0
			) {
				const write = this.enqueuePendingBlobIntentSnapshot(
					scope,
					key,
					store,
					entries,
					ensureToken,
				);
				try {
					await write;
				} catch {
					if (!this.isCurrentPendingBlobEnsure(ensureToken, scope, key, store)) return false;
					if (!await this.waitForStablePendingBlobIntentTail(ensureToken)) return false;
					return this.pendingBlobIntentStore === store
						&& this.pendingBlobIntentStoreKey === key
						&& this.pendingBlobIntentPersistenceHealthy;
				}
				if (!this.isCurrentPendingBlobEnsure(ensureToken, scope, key, store)) return false;
				if (!await this.waitForStablePendingBlobIntentTail(ensureToken)) return false;
				return this.pendingBlobIntentStore === store
					&& this.pendingBlobIntentStoreKey === key
					&& this.pendingBlobIntentPersistenceHealthy;
			}

			this.pendingBlobIntentPersistenceHealthy = true;
			return true;
		} catch (err) {
			if (
				this.pendingBlobIntentPersistChain !== loadTail
				|| !this.isCurrentPendingBlobEnsure(ensureToken, scope, key, store)
			) return false;
			this.pendingBlobIntentPersistenceHealthy = false;
			this.pendingBlobIntentStore = null;
			this.pendingBlobIntentStoreKey = null;
			this.log(`Local attachment intent journal unavailable: ${formatUnknown(err)}`);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-unavailable",
			);
			return false;
		}
	}

	private enqueuePendingBlobIntentPersistence(): Promise<void> {
		const activation = this.activateBlobAuthorityScope(
			"enqueue-pending-intent",
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		const key = scope.host && scope.vaultId && scope.localDeviceId
			? buildPendingBlobIntentStoreKey(scope)
			: null;
		if (this.blobAuthorityResetInProgress) {
			return Promise.reject(new Error("Blob authority reset is in progress"));
		}
		if (key && this.corruptPendingBlobIntentStoreKeys.has(key)) {
			this.pendingBlobIntentPersistenceHealthy = false;
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-corrupt-latched",
			);
			return Promise.reject(
				new Error("Pending attachment intent store is corrupt for the active scope"),
			);
		}
		const store = key && this.pendingBlobIntentStoreKey === key
			? this.pendingBlobIntentStore
			: null;
		if (!key || !store) {
			this.pendingBlobIntentPersistenceHealthy = false;
			return Promise.reject(
				new Error("Pending attachment intent store is not initialized for the active scope"),
			);
		}

		return this.enqueuePendingBlobIntentSnapshot(
			scope,
			key,
			store,
			this.pendingBlobIntents.getEntries(scope),
		);
	}

	private persistPendingBlobIntents(): void {
		const activation = this.activateBlobAuthorityScope(
			"persist-pending-intent",
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		const token = activation.token;
		const key = scope.host && scope.vaultId && scope.localDeviceId
			? buildPendingBlobIntentStoreKey(scope)
			: null;
		if (!key || this.pendingBlobIntentStoreKey !== key || !this.pendingBlobIntentStore) {
			this.pendingBlobIntentPersistenceHealthy = false;
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-scope-not-ready",
			);
			void this.ensurePendingBlobIntentPersistence().then((ready) => {
				if (
					ready
					&& this.isCurrentBlobAuthority(token)
					&& this.pendingBlobIntentStoreKey === key
				) void this.enqueuePendingBlobIntentPersistence().catch(() => undefined);
			});
			return;
		}
		void this.enqueuePendingBlobIntentPersistence().catch(() => undefined);
	}

	private async flushPendingBlobIntentPersistence(): Promise<boolean> {
		for (;;) {
			const tail = this.pendingBlobIntentPersistChain;
			try {
				await tail;
			} catch {
				if (tail !== this.pendingBlobIntentPersistChain) continue;
				return false;
			}
			if (tail === this.pendingBlobIntentPersistChain) {
				return this.pendingBlobIntentPersistenceHealthy;
			}
		}
	}

	private isCurrentBlobSettledRefWrite(
		token: BlobAuthorityScopeToken,
		key: string,
		store: IndexedDbBlobSettledRefStore,
		write: Promise<void>,
		ensureToken?: BlobAuthorityEnsureToken,
	): boolean {
		const currentScope = this.getBlobIntentScope();
		return this.blobAuthorityScopeGuard.isCurrent(token, currentScope)
			&& !!currentScope.host
			&& !!currentScope.vaultId
			&& !!currentScope.localDeviceId
			&& buildBlobSettledRefStoreKey(currentScope) === key
			&& this.blobSettledRefStoreKey === key
			&& this.blobSettledRefStore === store
			&& this.blobSettledRefPersistChain === write
			&& (!ensureToken
				|| this.isCurrentSettledBlobEnsure(ensureToken, currentScope, key, store));
	}

	private enqueueBlobSettledRefSnapshot(
		scope: PendingBlobIntentScope,
		key: string,
		store: IndexedDbBlobSettledRefStore,
		snapshot: BlobSettledRefCache,
		sourceVersions: BlobSettledSourceVersionCache,
		stages: BlobSettlementStageCache,
		legacyMissingPaths: string[],
		ensureToken?: BlobAuthorityEnsureToken,
	): Promise<void> {
		const token = ensureToken ?? this.blobAuthorityScopeGuard.capture();
		if (
			this.blobAuthorityResetInProgress
			|| !this.blobAuthorityScopeGuard.isCurrent(token, scope)
			|| this.blobSettledRefStoreKey !== key
			|| this.blobSettledRefStore !== store
		) {
			return Promise.reject(new Error(
				"Blob settlement store is not current for the active scope",
			));
		}

		this.blobSettledRefPersistenceHealthy = false;
		const write = this.blobSettledRefPersistChain
			.catch(() => undefined)
			.then(() => store.save(snapshot, {
				legacyMissingPaths,
				sourceVersions,
				stages,
			}));
		this.blobSettledRefPersistChain = write;
		void write.then(
			() => {
				if (!this.isCurrentBlobSettledRefWrite(token, key, store, write, ensureToken)) return;
				this.blobSettledRefPersistenceHealthy =
					!this.corruptBlobSettledRefStoreKeys.has(key);
			},
			(err) => {
				if (!this.isCurrentBlobSettledRefWrite(token, key, store, write, ensureToken)) return;
				this.blobSettledRefPersistenceHealthy = false;
				this.log(`Failed to persist settled attachment refs: ${formatUnknown(err)}`);
				this.attachmentOrchestrator?.revokeUploadAuthority(
					"settled-ref-journal-write-failed",
				);
			},
		);
		return write;
	}

	private async ensureBlobSettledRefPersistence(): Promise<boolean> {
		const activation = this.activateBlobAuthorityScope(
			"ensure-settled-ref",
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		if (
			this.blobAuthorityResetInProgress
			|| !scope.host
			|| !scope.vaultId
			|| !scope.localDeviceId
		) {
			this.blobSettledRefPersistenceHealthy = false;
			return false;
		}
		const key = buildBlobSettledRefStoreKey(scope);
		if (this.corruptBlobSettledRefStoreKeys.has(key)) {
			this.blobSettledRefPersistenceHealthy = false;
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"settled-ref-journal-corrupt-latched",
			);
			return false;
		}
		if (
			this.blobSettledRefStore
			&& this.blobSettledRefStoreKey === key
			&& this.blobSettledRefPersistenceHealthy
		) return true;

		this.blobSettledRefPersistenceHealthy = false;
		this.blobSettledRefStore = null;
		this.blobSettledRefStoreKey = null;
		let store: IndexedDbBlobSettledRefStore;
		try {
			store = new IndexedDbBlobSettledRefStore(scope);
		} catch (err) {
			if (!this.blobAuthorityScopeGuard.isCurrent(activation.token, scope)) return false;
			this.log(`Local attachment settlement journal unavailable: ${formatUnknown(err)}`);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"settled-ref-journal-unavailable",
			);
			return false;
		}
		const ensureToken = this.blobAuthorityScopeGuard.beginEnsure(
			"settled",
			scope,
			key,
			store,
		);

		if (!await this.waitForStableBlobSettledRefTail(ensureToken)) return false;
		if (!this.isCurrentSettledBlobEnsure(ensureToken, scope, key, store)) return false;
		const loadTail = this.blobSettledRefPersistChain;
		try {
			const loaded = await store.loadWithStatus();
			if (
				this.blobSettledRefPersistChain !== loadTail
				|| !this.isCurrentSettledBlobEnsure(ensureToken, scope, key, store)
			) return false;
			if (loaded.status === "corrupt") {
				this.corruptBlobSettledRefStoreKeys.add(key);
				this.log("Local attachment settlement journal is corrupt; attachment transfers remain paused");
				this.attachmentOrchestrator?.revokeUploadAuthority(
					"settled-ref-journal-corrupt",
				);
				return false;
			}

			// The stable-tail check above makes the durable snapshot authoritative.
			// Never merge by key presence: an absent key is a meaningful settlement
			// retirement/stage removal and an old loaded value must not resurrect it.
			const loadedLegacyMissingPaths = loaded.migrationStatus === "initialized"
				? loaded.legacyMissingPaths
				: collectLegacyMissingBlobPaths({
					identityStatus: this.blobLocalDeviceIdentityStatus,
					hashCache: this.blobHashCache,
					isPathPresent: (path) =>
						this.app.vault.getAbstractFileByPath(path) !== null,
					isPathSyncable: (path) => this.isBlobPathSyncable(path),
				});
			const ownership = scrubBlobSettlementDocumentOwnership({
				cache: loaded.cache,
				sourceVersions: loaded.sourceVersions,
				stages: loaded.stages,
				legacyMissingPaths: loadedLegacyMissingPaths,
				isPathBlobSyncable: (path) => this.isBlobPathSyncable(path),
			});
			const nextSettledRefs = ownership.cache;
			const nextSourceVersions = ownership.sourceVersions;
			const nextStages = ownership.stages;
			const legacyMissingPaths = ownership.legacyMissingPaths;

			for (const path of Object.keys(this.blobSettledRefs)) {
				delete this.blobSettledRefs[path];
			}
			for (const path of Object.keys(this.blobSettledSourceVersions)) {
				delete this.blobSettledSourceVersions[path];
			}
			for (const path of Object.keys(this.blobSettlementStages)) {
				delete this.blobSettlementStages[path];
			}
			Object.assign(this.blobSettledRefs, nextSettledRefs);
			Object.assign(this.blobSettledSourceVersions, nextSourceVersions);
			Object.assign(this.blobSettlementStages, nextStages);
			this.legacyMissingBlobPaths = new Set([
				...legacyMissingPaths,
				...Object.entries(nextStages)
					.filter(([, stage]) => stage.kind !== "retire")
					.map(([path]) => path),
			]);
			this.blobSettledRefStore = store;
			this.blobSettledRefStoreKey = key;
			const attentionChanged = this.hydrateLegacyMissingBlobAttention();

			if (
				loaded.status === "missing"
				|| loaded.migrationStatus === "uninitialized"
				|| ownership.changed
			) {
				const write = this.enqueueBlobSettledRefSnapshot(
					scope,
					key,
					store,
					{ ...this.blobSettledRefs },
					{ ...this.blobSettledSourceVersions },
					{ ...this.blobSettlementStages },
					Array.from(this.legacyMissingBlobPaths),
					ensureToken,
				);
				try {
					await write;
				} catch {
					if (!this.isCurrentSettledBlobEnsure(ensureToken, scope, key, store)) return false;
					if (!await this.waitForStableBlobSettledRefTail(ensureToken)) return false;
					return this.blobSettledRefStore === store
						&& this.blobSettledRefStoreKey === key
						&& this.blobSettledRefPersistenceHealthy;
				}
				if (!this.isCurrentSettledBlobEnsure(ensureToken, scope, key, store)) return false;
				if (!await this.waitForStableBlobSettledRefTail(ensureToken)) return false;
				if (attentionChanged) void this.persistPluginState();
				return this.blobSettledRefStore === store
					&& this.blobSettledRefStoreKey === key
					&& this.blobSettledRefPersistenceHealthy;
			}

			this.blobSettledRefPersistenceHealthy = true;
			if (attentionChanged) void this.persistPluginState();
			return true;
		} catch (err) {
			if (
				this.blobSettledRefPersistChain !== loadTail
				|| !this.isCurrentSettledBlobEnsure(ensureToken, scope, key, store)
			) return false;
			this.blobSettledRefPersistenceHealthy = false;
			this.blobSettledRefStore = null;
			this.blobSettledRefStoreKey = null;
			this.log(`Local attachment settlement journal unavailable: ${formatUnknown(err)}`);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"settled-ref-journal-unavailable",
			);
			return false;
		}
	}

	private enqueueBlobSettledRefPersistence(): Promise<void> {
		const activation = this.activateBlobAuthorityScope(
			"enqueue-settled-ref",
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		const key = scope.host && scope.vaultId && scope.localDeviceId
			? buildBlobSettledRefStoreKey(scope)
			: null;
		if (this.blobAuthorityResetInProgress) {
			return Promise.reject(new Error("Blob authority reset is in progress"));
		}
		if (key && this.corruptBlobSettledRefStoreKeys.has(key)) {
			this.blobSettledRefPersistenceHealthy = false;
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"settled-ref-journal-corrupt-latched",
			);
			return Promise.reject(
				new Error("Blob settlement store is corrupt for the active scope"),
			);
		}
		const store = key && this.blobSettledRefStoreKey === key
			? this.blobSettledRefStore
			: null;
		if (!key || !store) {
			this.blobSettledRefPersistenceHealthy = false;
			return Promise.reject(
				new Error("Blob settlement store is not initialized for the active scope"),
			);
		}

		return this.enqueueBlobSettledRefSnapshot(
			scope,
			key,
			store,
			{ ...this.blobSettledRefs },
			{ ...this.blobSettledSourceVersions },
			{ ...this.blobSettlementStages },
			Array.from(this.legacyMissingBlobPaths),
		);
	}

	private hydrateLegacyMissingBlobAttention(): boolean {
		const markdownEntries = this.preservedUnresolvedEntries.filter(
			(entry) => entry.kind === "markdown",
		);
		const previousBlobEntries = this.preservedUnresolvedEntries.filter(
			(entry) => entry.kind === "blob",
		);
		const retainedBlobEntries = previousBlobEntries.filter((entry) =>
			entry.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON
			|| this.isBlobPathSyncable(entry.path)
		);
		const registry = new PreservedUnresolvedRegistry(
			retainedBlobEntries,
		);
		let changed = retainedBlobEntries.length !== previousBlobEntries.length;
		for (const path of this.legacyMissingBlobPaths) {
			const existing = registry.get(path);
			if (existing?.reason === LEGACY_MISSING_BLOB_ATTENTION_REASON) continue;
			registry.record({
				path,
				kind: "blob",
				reason: LEGACY_MISSING_BLOB_ATTENTION_REASON,
			});
			changed = true;
		}
		if (changed) {
			this.preservedUnresolvedEntries = [...markdownEntries, ...registry.getEntries()];
		}
		return changed;
	}

	private persistBlobSettledRefs(): void {
		const token = this.blobAuthorityScopeGuard.capture();
		const previousTail = this.blobSettledRefPersistChain;
		void this.enqueueBlobSettledRefPersistence().catch((err) => {
			if (!this.isCurrentBlobAuthority(token)) return;
			// An appended write reports its own failure only if it remains the
			// latest exact tail. This outer path is solely for early enqueue failure.
			if (this.blobSettledRefPersistChain !== previousTail) return;
			this.log(`Failed to queue settled attachment refs: ${formatUnknown(err)}`);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"settled-ref-journal-scope-not-ready",
			);
		});
	}

	private handleBlobSettledRefsChanged(
		path: string | undefined,
		ref: BlobRef | undefined,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
		token: BlobAuthorityScopeToken,
	): void {
		if (!this.isBlobRuntimeAuthorityCurrent(vaultSync, scope, token)) return;
		// A fresh exact settlement is trusted device-local authority. It is the
		// only implicit way to retire an upgrade quarantine; merely clearing the
		// data.json Attention marker is insufficient.
		if (path && ref && sameBlobRef(this.blobSettledRefs[path], ref)) {
			this.legacyMissingBlobPaths.delete(normalizePath(path));
		}
		this.persistBlobSettledRefs();
	}

	private assertBlobSettlementCallbackAuthority(
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): void {
		if (
			buildBlobAuthorityScopeIdentity(scope)
				!== this.blobAuthorityScopeGuard.currentIdentity
			|| !this.isVaultSyncBoundToCurrentBlobScope(vaultSync)
			|| this.blobAuthorityResetInProgress
		) {
			throw new Error("Attachment settlement authority changed");
		}
	}

	private async stageBlobSettlement(
		path: string,
		stage: BlobSettlementStage,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void> {
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
		const normalized = normalizePath(path);
		const current = this.blobSettlementStages[normalized];
		if (
			current
			&& (
				current.stageId !== stage.stageId
				|| current.kind !== stage.kind
				|| !sameBlobRef(current.ref, stage.ref)
				|| current.sourceVersion !== stage.sourceVersion
			)
		) {
			throw new Error(`Attachment settlement is already unresolved for "${normalized}"`);
		}
		this.blobSettlementStages[normalized] = stage.ref
			? { ...stage, ref: cloneBlobRef(stage.ref)! }
			: { ...stage };
		await this.enqueueBlobSettledRefPersistence();
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
		if (this.blobSettlementStages[normalized]?.stageId !== stage.stageId) {
			throw new Error(`Attachment settlement stage changed for "${normalized}"`);
		}
	}

	private async finalizeBlobSettlement(
		path: string,
		stageId: string,
		ref: BlobRef,
		sourceVersion: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void> {
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
		const normalized = normalizePath(path);
		const staged = this.blobSettlementStages[normalized];
		if (
			staged?.stageId !== stageId
			|| staged.kind === "retire"
			|| !sameBlobRef(staged.ref, ref)
		) {
			throw new Error(`Attachment settlement stage changed for "${normalized}"`);
		}
		if (
			staged.sourceVersion !== undefined
			&& staged.sourceVersion !== sourceVersion
		) {
			throw new Error(`Attachment settlement episode changed for "${normalized}"`);
		}
		if (
			!sameBlobRef(vaultSync.getBlobRef(normalized), ref)
			|| vaultSync.getBlobSourceVersion(normalized) !== sourceVersion
		) {
			throw new Error(`Attachment source changed before settlement for "${normalized}"`);
		}
		this.blobSettledRefs[normalized] = cloneBlobRef(ref)!;
		this.blobSettledSourceVersions[normalized] = sourceVersion;
		delete this.blobSettlementStages[normalized];
		this.legacyMissingBlobPaths.delete(normalized);
		await this.enqueueBlobSettledRefPersistence();
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
	}

	private async retireBlobSettlement(
		path: string,
		stageId: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void> {
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
		const normalized = normalizePath(path);
		const staged = this.blobSettlementStages[normalized];
		if (staged?.stageId !== stageId || staged.kind !== "retire") {
			throw new Error(`Attachment retirement stage changed for "${normalized}"`);
		}
		delete this.blobSettledRefs[normalized];
		delete this.blobSettledSourceVersions[normalized];
		// The durable retire stage is the compact absence provenance. Keep it
		// after the old settlement is removed so a server snapshot rollback or a
		// byte-identical new CRDT episode cannot be mistaken for first bootstrap.
		this.legacyMissingBlobPaths.delete(normalized);
		await this.enqueueBlobSettledRefPersistence();
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
	}

	private async abortBlobSettlementStage(
		path: string,
		stageId: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void> {
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
		const normalized = normalizePath(path);
		if (this.blobSettlementStages[normalized]?.stageId !== stageId) return;
		delete this.blobSettlementStages[normalized];
		await this.enqueueBlobSettledRefPersistence();
		this.assertBlobSettlementCallbackAuthority(scope, vaultSync);
	}

	private async setLegacyMissingBlobQuarantine(
		path: string,
		quarantined: boolean,
	): Promise<void> {
		const normalized = normalizePath(path);
		const wasQuarantined = this.legacyMissingBlobPaths.has(normalized);
		if (wasQuarantined === quarantined) return;
		if (!this.blobSettledRefPersistenceHealthy || !this.blobSettledRefStore) {
			throw new Error("Local attachment settlement journal is unavailable.");
		}
		if (quarantined) this.legacyMissingBlobPaths.add(normalized);
		else this.legacyMissingBlobPaths.delete(normalized);
		try {
			await this.enqueueBlobSettledRefPersistence();
		} catch (err) {
			if (wasQuarantined) this.legacyMissingBlobPaths.add(normalized);
			else this.legacyMissingBlobPaths.delete(normalized);
			throw err;
		}
	}

	private async clearBlobSettlementFenceForExplicitResolution(
		path: string,
		vaultSync: VaultSync,
	): Promise<void> {
		if (!this.isVaultSyncBoundToCurrentBlobScope(vaultSync)) {
			throw new Error("Attachment authority changed. Refresh the dashboard.");
		}
		const normalized = normalizePath(path);
		delete this.blobSettlementStages[normalized];
		delete this.blobSettledRefs[normalized];
		delete this.blobSettledSourceVersions[normalized];
		await this.enqueueBlobSettledRefPersistence();
		if (!this.isVaultSyncBoundToCurrentBlobScope(vaultSync)) {
			throw new Error("Attachment authority changed. Refresh the dashboard.");
		}
	}

	private async flushBlobSettledRefPersistence(): Promise<boolean> {
		for (;;) {
			const tail = this.blobSettledRefPersistChain;
			try {
				await tail;
			} catch {
				if (tail !== this.blobSettledRefPersistChain) continue;
				return false;
			}
			if (tail === this.blobSettledRefPersistChain) {
				return this.blobSettledRefPersistenceHealthy;
			}
		}
	}

	private captureBlobMutationBase(path: string): PendingBlobMutationBase {
		const normalized = normalizePath(path);
		if (this.blobSettlementStages[normalized]) {
			return {
				known: false,
				ref: undefined,
				sourceVersionKnown: false,
			};
		}
		const settledRef = cloneBlobRef(this.blobSettledRefs[normalized]);
		if (settledRef) {
			const currentRef = cloneBlobRef(this.vaultSync?.getBlobRef(normalized));
			const settledSourceVersion = this.blobSettledSourceVersions[normalized];
			const currentSourceVersion = this.vaultSync?.getBlobSourceVersion(normalized);
			return {
				known: true,
				ref: settledRef,
				sourceVersionKnown: sameBlobRef(currentRef, settledRef)
					&& settledSourceVersion !== undefined
					&& currentSourceVersion === settledSourceVersion,
				expectedSourceVersion: sameBlobRef(currentRef, settledRef)
					&& currentSourceVersion === settledSourceVersion
					? settledSourceVersion
					: undefined,
			};
		}
		if (
			this.vaultSync?.providerSynced
			&& this.blobProviderReady
			&& this.blobLocalPersistenceReady
			&& !this.vaultSync.getBlobRef(normalized)
		) {
			return {
				known: true,
				ref: undefined,
				sourceVersionKnown: true,
			};
		}
		return {
			known: false,
			ref: undefined,
			sourceVersionKnown: false,
		};
	}

	private schedulePendingBlobIntentReplay(reason: string): void {
		void this.replayPendingBlobIntents(reason).catch((err) => {
			this.log(`Pending attachment intent replay failed: ${formatUnknown(err)}`);
		});
	}

	private recordPendingBlobDelete(path: string, reason: string): void {
		const scope = this.getBlobIntentScope();
		if (!scope.host || !scope.vaultId || !scope.localDeviceId) {
			this.pendingBlobIntentPersistenceHealthy = false;
			this.getBlobSync()?.fenceLocalMutationIntent(path, reason);
			this.recordPersistedBlobUnresolved(
				path,
				"local-blob-mutation-remote-conflict",
			);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-scope-unavailable",
			);
			return;
		}
		const base = this.captureBlobMutationBase(path);
		this.getBlobSync()?.fenceLocalMutationIntent(path, reason);
		const intent = this.pendingBlobIntents.recordDelete(path, scope, base);
		this.prunePendingBlobRenameFiles();
		this.trace("blob", "local-blob-delete-intent-journaled", {
			path: intent.kind === "delete" ? intent.path : normalizePath(path),
			reason,
			pendingCount: this.pendingBlobIntents.size,
		});
		this.persistPendingBlobIntents();
		this.schedulePendingBlobIntentReplay(`record-delete:${reason}`);
	}

	private recordPendingBlobRename(
		oldPath: string,
		newPath: string,
		reason: string,
		file: TFile,
	): void {
		const scope = this.getBlobIntentScope();
		if (!scope.host || !scope.vaultId || !scope.localDeviceId) {
			this.pendingBlobIntentPersistenceHealthy = false;
			this.getBlobSync()?.fenceLocalMutationIntent(oldPath, reason);
			this.getBlobSync()?.fenceLocalMutationIntent(newPath, reason);
			this.recordPersistedBlobUnresolved(
				oldPath,
				"local-blob-mutation-remote-conflict",
			);
			this.recordPersistedBlobUnresolved(
				newPath,
				"local-blob-mutation-remote-conflict",
			);
			this.attachmentOrchestrator?.revokeUploadAuthority(
				"intent-journal-scope-unavailable",
			);
			return;
		}
		const base = this.captureBlobMutationBase(oldPath);
		this.getBlobSync()?.fenceLocalMutationIntent(oldPath, reason);
		if (normalizePath(oldPath) !== normalizePath(newPath)) {
			this.getBlobSync()?.fenceLocalMutationIntent(newPath, reason);
		}
		const normalizedOld = normalizePath(oldPath);
		const chainedIntent = this.pendingBlobIntents.getEntries(scope).find(
			(entry) => entry.kind === "rename"
				&& entry.committedAt === undefined
				&& entry.commitAttemptId === undefined
				&& entry.newPath === normalizedOld,
		);
		if (
			chainedIntent?.kind === "rename"
			&& this.pendingBlobRenameFiles.get(chainedIntent.id) !== file
		) {
			// A path-only A->B, B->C chain is not sufficient under TFile ABA.
			// Retire A and record B->C as a separate intent when the exact file
			// identity does not continue across both events.
			this.pendingBlobIntents.recordDelete(normalizedOld, scope, base);
			this.prunePendingBlobRenameFiles();
		}
		const intent = this.pendingBlobIntents.recordRename(
			oldPath,
			newPath,
			scope,
			base,
		);
		this.prunePendingBlobRenameFiles();
		if (intent) this.pendingBlobRenameFiles.set(intent.id, file);
		this.trace("blob", "local-blob-rename-intent-journaled", {
			oldPath: normalizePath(oldPath),
			newPath: normalizePath(newPath),
			reason,
			coalesced: intent === null,
			pendingCount: this.pendingBlobIntents.size,
		});
		this.persistPendingBlobIntents();
		this.schedulePendingBlobIntentReplay(`record-rename:${reason}`);
	}

	private prunePendingBlobRenameFiles(): void {
		const liveIntentIds = new Set(
			this.pendingBlobIntents.getEntries().map((entry) => entry.id),
		);
		for (const id of this.pendingBlobRenameFiles.keys()) {
			if (!liveIntentIds.has(id)) this.pendingBlobRenameFiles.delete(id);
		}
		for (const id of this.replayedCommittedBlobIntentIds) {
			if (!liveIntentIds.has(id)) this.replayedCommittedBlobIntentIds.delete(id);
		}
	}

	private invalidateBlobPathAuthority(path: string): void {
		const normalized = normalizePath(path);
		removeCachedHash(this.blobHashCache, normalized);
		delete this.blobSettledRefs[normalized];
		delete this.blobSettledSourceVersions[normalized];
	}

	private recordPersistedBlobUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		const markdownEntries = this.preservedUnresolvedEntries.filter(
			(entry) => entry.kind === "markdown",
		);
		const registry = new PreservedUnresolvedRegistry(
			this.preservedUnresolvedEntries.filter((entry) => entry.kind === "blob"),
		);
		registry.record({ path, kind: "blob", reason });
		this.preservedUnresolvedEntries = [...markdownEntries, ...registry.getEntries()];
		this.persistPreservedUnresolvedState();
	}

	private commitLocalBlobDelete(path: string, reason: string): void {
		if (!this.getRuntimeConfig().enableAttachmentSync) return;
		this.recordPendingBlobDelete(path, reason);
	}

	private commitLocalBlobRename(oldPath: string, file: TFile, reason: string): void {
		if (!this.getRuntimeConfig().enableAttachmentSync) return;
		this.recordPendingBlobRename(oldPath, file.path, reason, file);
	}

	private pendingBlobMutationBase(intent: PendingBlobIntent): PendingBlobMutationBase {
		return {
			known: intent.baseRefKnown,
			ref: intent.baseRefKnown
				? cloneBlobRef(intent.expectedSourceRef)
				: undefined,
			sourceVersionKnown: intent.sourceVersionKnown === true,
			expectedSourceVersion: intent.sourceVersionKnown
				? intent.expectedSourceVersion
				: undefined,
		};
	}

	private hasOtherUnconfirmedBlobIntentFence(
		intent: PendingBlobIntent,
		scope: PendingBlobIntentScope,
	): boolean {
		return this.pendingBlobIntents.getEntries(scope).some((candidate) => {
			if (
				candidate.id === intent.id
				|| (
					candidate.commitAttemptId === undefined
					&& candidate.committedAt === undefined
				)
			) return false;
			return pendingBlobIntentsOverlap(intent, candidate);
		});
	}

	private hasOtherPendingBlobIntentOverlap(
		intent: PendingBlobIntent,
		scope: PendingBlobIntentScope,
	): boolean {
		return this.pendingBlobIntents.getEntries(scope).some((candidate) => {
			if (candidate.id === intent.id) return false;
			return pendingBlobIntentsOverlap(intent, candidate);
		});
	}

	private pendingBlobIntentHasSettlementStage(intent: PendingBlobIntent): boolean {
		const paths = intent.kind === "delete"
			? [intent.path]
			: [intent.oldPath, intent.newPath];
		return paths.some((path) => !!this.blobSettlementStages[normalizePath(path)]);
	}

	private isPendingBlobIntentReceiptConfirmed(
		intent: PendingBlobIntent,
		vaultSync: VaultSync,
	): boolean {
		if (
			intent.committedAt === undefined
			|| vaultSync.serverAppliedLocalState !== true
			|| !this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync)
		) return false;
		if (
			intent.receiptCandidateId
			&& vaultSync.lastConfirmedReceiptCandidateId === intent.receiptCandidateId
		) return true;
		return (vaultSync.lastServerReceiptEchoAt ?? 0) > intent.committedAt;
	}

	private async prepareCommittedBlobIntentForRemoval(
		intent: PendingBlobIntent,
		vaultSync: VaultSync,
	): Promise<boolean> {
		if (!this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync)) return false;
		const sourcePath = normalizePath(
			intent.kind === "delete" ? intent.path : intent.oldPath,
		);
		const expectedRef = cloneBlobRef(intent.expectedSourceRef);
		let changed = false;
		const currentStage = this.blobSettlementStages[sourcePath];
		if (
			currentStage
			&& (
				currentStage.kind !== "retire"
				|| !sameBlobRef(currentStage.ref, expectedRef)
				|| currentStage.sourceVersion !== intent.expectedSourceVersion
			)
		) return false;
		if (!currentStage) {
			this.blobSettlementStages[sourcePath] = {
				stageId: `committed:${intent.id}`,
				kind: "retire",
				...(expectedRef ? { ref: expectedRef } : {}),
				...(intent.expectedSourceVersion
					? { sourceVersion: intent.expectedSourceVersion }
					: {}),
				stagedAt: intent.committedAt ?? Date.now(),
			};
			changed = true;
		}
		if (this.blobSettledRefs[sourcePath]) {
			delete this.blobSettledRefs[sourcePath];
			changed = true;
		}
		if (this.blobSettledSourceVersions[sourcePath]) {
			delete this.blobSettledSourceVersions[sourcePath];
			changed = true;
		}

		if (intent.kind === "rename") {
			const destinationPath = normalizePath(intent.newPath);
			const destinationRef = cloneBlobRef(vaultSync.getBlobRef(destinationPath));
			if (destinationRef) {
				const destinationSourceVersion =
					vaultSync.getBlobSourceVersion(destinationPath);
				if (!destinationSourceVersion) return false;
				const destinationSettled =
					sameBlobRef(this.blobSettledRefs[destinationPath], destinationRef)
					&& this.blobSettledSourceVersions[destinationPath]
						=== destinationSourceVersion
					&& !this.blobSettlementStages[destinationPath];
				if (!destinationSettled) {
					const existing = this.blobSettlementStages[destinationPath];
					if (!existing) {
						this.blobSettlementStages[destinationPath] = {
							stageId: `rename:${intent.id}`,
							kind: "rename",
							ref: destinationRef,
							sourceVersion: destinationSourceVersion,
							stagedAt: intent.committedAt ?? Date.now(),
						};
						changed = true;
					} else if (
						existing.kind !== "rename"
						|| !sameBlobRef(existing.ref, destinationRef)
						|| existing.sourceVersion !== destinationSourceVersion
					) {
						return false;
					}
					this.legacyMissingBlobPaths.add(destinationPath);
					const blobSync = this.getBlobSync();
					if (blobSync) {
						blobSync.recordPreservedUnresolved(
							destinationPath,
							LEGACY_MISSING_BLOB_ATTENTION_REASON,
						);
					} else {
						this.recordPersistedBlobUnresolved(
							destinationPath,
							LEGACY_MISSING_BLOB_ATTENTION_REASON,
						);
					}
					changed = true;
				}
			}
		}

		if (changed) await this.enqueueBlobSettledRefPersistence();
		return intent.kind === "delete"
			|| !vaultSync.getBlobRef(intent.newPath)
			|| (
				sameBlobRef(
					this.blobSettledRefs[normalizePath(intent.newPath)],
					vaultSync.getBlobRef(intent.newPath),
				)
				&& this.blobSettledSourceVersions[normalizePath(intent.newPath)]
					=== vaultSync.getBlobSourceVersion(intent.newPath)
				&& !this.blobSettlementStages[normalizePath(intent.newPath)]
			);
	}

	private hasPendingBlobIntentCommitPostcondition(
		intent: PendingBlobIntent,
		vaultSync: VaultSync,
	): boolean {
		const sourcePath = intent.kind === "delete" ? intent.path : intent.oldPath;
		if (vaultSync.getBlobRef(sourcePath)) return false;
		const snapshot = vaultSync.getAuthoritativeBlobDeleteSnapshot(sourcePath);
		if (intent.commitDeleteFingerprint) {
			return snapshot?.fingerprint === intent.commitDeleteFingerprint;
		}
		const expectedRef = cloneBlobRef(intent.expectedSourceRef);
		if (!expectedRef) return true;
		return !!snapshot && sameBlobRef(snapshot.deletedRef, expectedRef);
	}

	private recordCommittedBlobIntentConflict(
		intent: PendingBlobIntent,
		preferRemoteDeleteResolution: boolean,
	): void {
		const path = intent.kind === "delete" ? intent.path : intent.oldPath;
		const reason: PreservedUnresolvedReason = preferRemoteDeleteResolution
			? "remote-delete-local-conflict"
			: "local-blob-mutation-remote-conflict";
		const blobSync = this.getBlobSync();
		if (blobSync) {
			blobSync.recordPreservedUnresolved(path, reason);
		} else {
			this.recordPersistedBlobUnresolved(path, reason);
		}
	}

	private clearResolvedLocalBlobMutationConflict(intent: PendingBlobIntent): void {
		const paths = intent.kind === "delete"
			? [intent.path]
			: [intent.oldPath, intent.newPath];
		const blobSync = this.getBlobSync();
		for (const path of paths) {
			const normalized = normalizePath(path);
			const liveEntry = blobSync?.getPreservedUnresolvedEntries().find((entry) =>
				entry.kind === "blob"
				&& normalizePath(entry.path) === normalized
				&& entry.reason === "local-blob-mutation-remote-conflict"
			);
			if (liveEntry) blobSync?.clearPreservedUnresolved(normalized);
		}
		const before = this.preservedUnresolvedEntries.length;
		this.preservedUnresolvedEntries = this.preservedUnresolvedEntries.filter((entry) =>
			entry.kind !== "blob"
			|| entry.reason !== "local-blob-mutation-remote-conflict"
			|| !paths.some((path) => normalizePath(path) === normalizePath(entry.path))
		);
		if (this.preservedUnresolvedEntries.length !== before) {
			this.persistPreservedUnresolvedState();
		}
	}

	private applyPendingBlobDelete(
		intent: Extract<PendingBlobIntent, { kind: "delete" }>,
		vaultSync: VaultSync,
	): BlobDeleteCommitResult {
		const base = this.pendingBlobMutationBase(intent);
		const blobSync = this.getBlobSync();
		const result = blobSync
			? blobSync.handleFileDelete(intent.path, this.settings.deviceName, base)
			: vaultSync.deleteBlobRefIfCurrent(intent.path, base, this.settings.deviceName);
		if (!blobSync) {
			if (
				result.kind === "unknown-source"
				|| (result.kind === "source-conflict" && result.mutationApplied !== true)
			) {
				this.recordPersistedBlobUnresolved(
					intent.path,
					"local-blob-mutation-remote-conflict",
				);
			} else {
				removeCachedHash(this.blobHashCache, normalizePath(intent.path));
				const normalizedPath = normalizePath(intent.path);
				delete this.blobSettledRefs[normalizedPath];
				delete this.blobSettledSourceVersions[normalizedPath];
				if (result.kind === "source-conflict") {
					this.recordPersistedBlobUnresolved(
						intent.path,
						"local-blob-mutation-remote-conflict",
					);
				}
			}
		}
		return result;
	}

	private applyPendingBlobRename(
		intent: Extract<PendingBlobIntent, { kind: "rename" }>,
		file: TFile,
		vaultSync: VaultSync,
	): CausalBlobRenameResult {
		const base = this.pendingBlobMutationBase(intent);
		const blobSync = this.getBlobSync();
		const result = blobSync
			? blobSync.handleFileRename(
				intent.oldPath,
				file,
				this.settings.deviceName,
				base,
			)
			: vaultSync.renameBlobRefWithTombstoneIfCurrent(
				intent.oldPath,
				intent.newPath,
				base,
				this.settings.deviceName,
			);
		if (!blobSync) {
			if (
				result.kind === "unknown-source"
				|| (result.kind === "source-conflict" && result.mutationApplied !== true)
			) {
				this.recordPersistedBlobUnresolved(
					intent.oldPath,
					"local-blob-mutation-remote-conflict",
				);
				this.recordPersistedBlobUnresolved(
					intent.newPath,
					"local-blob-mutation-remote-conflict",
				);
			} else if (result.kind === "source-conflict") {
				removeCachedHash(this.blobHashCache, normalizePath(intent.oldPath));
				delete this.blobSettledRefs[normalizePath(intent.oldPath)];
				delete this.blobSettledSourceVersions[normalizePath(intent.oldPath)];
				this.recordPersistedBlobUnresolved(
					intent.oldPath,
					"local-blob-mutation-remote-conflict",
				);
				this.recordPersistedBlobUnresolved(
					intent.newPath,
					"local-blob-mutation-remote-conflict",
				);
			} else if (result.kind === "destination-conflict") {
				removeCachedHash(this.blobHashCache, normalizePath(intent.oldPath));
				delete this.blobSettledRefs[normalizePath(intent.oldPath)];
				delete this.blobSettledSourceVersions[normalizePath(intent.oldPath)];
				this.recordPersistedBlobUnresolved(intent.oldPath, "path-collision");
				this.recordPersistedBlobUnresolved(intent.newPath, "path-collision");
			} else if (result.kind === "moved") {
				const rename = new Map([[intent.oldPath, intent.newPath]]);
				moveCachedHashes(this.blobHashCache, rename);
				moveSettledBlobRefs(this.blobSettledRefs, rename);
				delete this.blobSettledSourceVersions[normalizePath(intent.oldPath)];
				const destinationSourceVersion =
					vaultSync.getBlobSourceVersion(normalizePath(intent.newPath));
				if (destinationSourceVersion && this.blobSettledRefs[normalizePath(intent.newPath)]) {
					this.blobSettledSourceVersions[normalizePath(intent.newPath)] =
						destinationSourceVersion;
				}
			} else if (result.kind === "already-absent" || result.kind === "missing-source") {
				removeCachedHash(this.blobHashCache, normalizePath(intent.oldPath));
				delete this.blobSettledRefs[normalizePath(intent.oldPath)];
				delete this.blobSettledSourceVersions[normalizePath(intent.oldPath)];
			}
		}
		return result;
	}

	private isPendingBlobMutationConflict(
		result: BlobDeleteCommitResult | CausalBlobRenameResult,
	): boolean {
		return result.kind === "unknown-source"
			|| (result.kind === "source-conflict" && result.mutationApplied === false);
	}

	/**
	 * Cross one destructive CRDT linearization point only after the exact
	 * attempted episode is durable. If the process dies after `apply()`, the
	 * persisted attempted/committed state can fence ABA replay on restart.
	 */
	private commitReadyPendingBlobIntent(
		intent: PendingBlobIntent,
		scope: PendingBlobIntentScope,
		scopeToken: BlobAuthorityScopeToken,
		vaultSync: VaultSync,
		apply: () => PendingBlobReplayApplyResult,
	): Promise<PendingBlobIntentCommitOutcome<PendingBlobReplayApplyResult>> {
		const commitAttemptId = randomBase64Url(16);
		const attemptedAt = Date.now();
		return commitPendingBlobIntentWithWriteAhead({
			markAttempted: () => this.pendingBlobIntents.markCommitAttempted(
				intent.id,
				commitAttemptId,
				attemptedAt,
				this.blobIntentSessionId,
			),
			persistAttempted: async () => {
				await this.enqueuePendingBlobIntentPersistence();
				if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) {
					throw new Error("Attachment intent authority changed after write-ahead");
				}
				if (!await this.flushPendingBlobIntentPersistence()) {
					throw new Error("Attachment intent write-ahead did not become stable");
				}
				if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) {
					throw new Error("Attachment intent authority changed while stabilizing write-ahead");
				}
				if (!await this.flushBlobSettledRefPersistence()) {
					throw new Error("Attachment settlement authority did not become stable");
				}
				if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) {
					throw new Error("Attachment intent authority changed before CAS");
				}
			},
			isAttemptCurrent: () => {
				if (
					this.blobAuthorityResetInProgress
					|| !this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)
					|| !this.getRuntimeConfig().enableAttachmentSync
					|| !vaultSync.providerSynced
					|| !this.blobProviderReady
					|| !this.blobLocalPersistenceReady
					|| !this.pendingBlobIntentPersistenceHealthy
					|| !this.blobSettledRefPersistenceHealthy
				) return false;
				const current = this.pendingBlobIntents.getEntries(scope).find(
					(candidate) => candidate.id === intent.id,
				);
					return current?.commitAttemptId === commitAttemptId
						&& current.committedAt === undefined
						&& !this.pendingBlobIntentHasSettlementStage(intent)
						&& !this.hasOtherPendingBlobIntentOverlap(intent, scope);
			},
			apply,
			isApplyCurrent: () => {
				if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return false;
				const current = this.pendingBlobIntents.getEntries(scope).find(
					(candidate) => candidate.id === intent.id,
				);
				return current?.commitAttemptId === commitAttemptId
					&& current.committedAt === undefined;
			},
			isKnownNoMutation: (result) => result.kind === "precondition-changed"
				|| this.isPendingBlobMutationConflict(result.result),
			clearAttempt: () => this.pendingBlobIntents.clearCommitAttempt(
				intent.id,
				commitAttemptId,
			),
			markCommitted: (result) => {
				if (result.kind !== "mutation") return false;
				const commitDeleteFingerprint =
					vaultSync.getAuthoritativeBlobDeleteSnapshot(result.sourcePath)?.fingerprint;
				return this.pendingBlobIntents.markCommittedFromAttempt(
					intent.id,
					commitAttemptId,
					Date.now(),
					this.blobIntentSessionId,
					vaultSync.serverReceiptCandidateId,
					commitDeleteFingerprint,
				);
			},
			// Capture the phase-two snapshot synchronously before receipt flushing
			// can yield to a settings/scope transition.
			persistFinal: () => {
				const pendingWrite = this.enqueuePendingBlobIntentPersistence();
				const settledWrite = this.enqueueBlobSettledRefPersistence();
				return Promise.all([pendingWrite, settledWrite]).then(() => undefined);
			},
			flushReceipt: async () => {
				await vaultSync.flushReceiptPersistence();
				if (vaultSync.candidatePersistenceHealthy !== true) {
					throw new Error("Server receipt candidate persistence is unavailable");
				}
			},
		});
	}

	private async finishPendingBlobIntentCommit(
		intent: PendingBlobIntent,
		outcome: PendingBlobIntentCommitOutcome<PendingBlobReplayApplyResult>,
		scopeToken: BlobAuthorityScopeToken,
		vaultSync: VaultSync,
	): Promise<"continue" | "stop"> {
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return "stop";

		if (outcome.kind === "committed") {
			if (outcome.receiptError !== undefined) {
				this.log(
					`Attachment intent receipt persistence will retry: ${formatUnknown(outcome.receiptError)}`,
				);
			}
			return "continue";
		}

		if (outcome.kind === "known-no-mutation") {
			const result = outcome.result;
			if (
				result.kind !== "precondition-changed"
				|| result.disposition === "retain-intent"
			) return "continue";
			if (
				!result.observedOccupant
				|| this.app.vault.getAbstractFileByPath(result.path) !== result.observedOccupant
			) {
				// The evidence that made this intent stale changed while its exact
				// attempted fence was being cleared. Keep the now-ready intent; a
				// later replay will evaluate the new disk episode from scratch.
				return "continue";
			}

			// The exact attempted fence was already cleared durably. Retire the
			// now-stale ready episode in a second durable snapshot; if that write
			// fails, restore the ready entry in memory so authority stays fenced.
			if (!this.pendingBlobIntents.remove(intent.id)) return "stop";
			this.pendingBlobRenameFiles.delete(intent.id);
			this.replayedCommittedBlobIntentIds.delete(intent.id);
			try {
				await this.enqueuePendingBlobIntentPersistence();
			} catch (error) {
				const current = this.pendingBlobIntents.getEntries();
				if (!current.some((candidate) => candidate.id === intent.id)) {
					this.pendingBlobIntents.hydrate([...current, intent]);
				}
				if (this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) {
					this.recordCommittedBlobIntentConflict(intent, false);
					this.log(
						`Failed to retire stale attachment intent: ${formatUnknown(error)}`,
					);
				}
				return "stop";
			}
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return "stop";
			removeCachedHash(this.blobHashCache, normalizePath(result.path));
			const occupantStillMatches =
				this.app.vault.getAbstractFileByPath(result.path) === result.observedOccupant;
			if (
				!occupantStillMatches
				&& !this.pendingBlobIntents.hasPath(result.path, intent.scope)
			) {
				// The observed replacement/recreated source disappeared while the
				// removal snapshot was in flight, before its delete event necessarily
				// reached this synchronous journal. Restore the original ready fence.
				const current = this.pendingBlobIntents.getEntries();
				if (!current.some((candidate) => candidate.id === intent.id)) {
					this.pendingBlobIntents.hydrate([...current, intent]);
				}
				try {
					await this.enqueuePendingBlobIntentPersistence();
				} catch (error) {
					this.recordCommittedBlobIntentConflict(intent, false);
					this.log(
						`Failed to restore raced attachment intent: ${formatUnknown(error)}`,
					);
				}
				return "stop";
			}
			if (
				result.admitObservedFile
				&& result.observedOccupant instanceof TFile
				&& occupantStillMatches
				&& this.isBlobPathSyncable(result.observedOccupant.path)
			) {
				this.getBlobSync()?.admitReplacementAfterStaleDelete(result.observedOccupant);
			}
			return "continue";
		}

		if (outcome.kind === "stale-after-attempt") return "stop";
		if (outcome.kind === "not-started") {
			const current = this.pendingBlobIntents.getEntries(intent.scope).find(
				(candidate) => candidate.id === intent.id,
			);
			if (current?.commitAttemptId !== undefined || current?.committedAt !== undefined) {
				this.recordCommittedBlobIntentConflict(current, false);
			}
			return "stop";
		}

		// A failed write-ahead, ambiguous apply, or failed phase-two write closes
		// authority immediately. Ambiguous/committed phases remain fenced; a
		// proven no-mutation clear may be ready but cannot replay while unhealthy.
		this.recordCommittedBlobIntentConflict(intent, false);
		this.attachmentOrchestrator?.revokeUploadAuthority(
			"blob-intent-commit-not-durable",
		);
		const error = "error" in outcome ? outcome.error : undefined;
		this.log(
			`Attachment intent commit stopped at ${outcome.kind}${
				error === undefined ? "" : `: ${formatUnknown(error)}`
			}`,
		);
		if (
			outcome.kind === "commit-persist-failed"
			&& outcome.receiptError !== undefined
		) {
			this.log(
				`Attachment intent receipt persistence also failed: ${formatUnknown(outcome.receiptError)}`,
			);
		}
		return "stop";
	}

	private shouldDiscoverInactiveBlobDeletes(reason: string): boolean {
		return reason === "reconcile-authoritative"
			|| reason.startsWith("engine-reconcile:");
	}

	private async discoverInactiveBlobDeleteIntents(
		scope: PendingBlobIntentScope,
		reason: string,
		scopeToken: BlobAuthorityScopeToken,
		vaultSync: VaultSync,
	): Promise<number> {
		if (!this.app.workspace.layoutReady) return 0;
		const blobSync = this.getBlobSync();
		let retirementAttentionChanged = false;
		for (const [rawPath, stage] of Object.entries(this.blobSettlementStages)) {
			if (stage.kind !== "retire") continue;
			const path = normalizePath(rawPath);
			const liveRevival = !!vaultSync.getBlobRef(path)
				&& !vaultSync.isBlobTombstoned(path);
			if (liveRevival && !this.legacyMissingBlobPaths.has(path)) {
				this.legacyMissingBlobPaths.add(path);
				if (blobSync) {
					blobSync.recordPreservedUnresolved(
						path,
						LEGACY_MISSING_BLOB_ATTENTION_REASON,
					);
				} else {
					this.recordPersistedBlobUnresolved(
						path,
						LEGACY_MISSING_BLOB_ATTENTION_REASON,
					);
				}
				retirementAttentionChanged = true;
			} else if (!liveRevival && this.legacyMissingBlobPaths.delete(path)) {
				const entry = blobSync?.getPreservedUnresolvedEntries().find(
					(candidate) => candidate.kind === "blob"
						&& normalizePath(candidate.path) === path
						&& candidate.reason === LEGACY_MISSING_BLOB_ATTENTION_REASON,
				);
				if (entry) blobSync?.clearPreservedUnresolved(path);
				retirementAttentionChanged = true;
			}
		}
		if (retirementAttentionChanged) {
			await this.enqueueBlobSettledRefPersistence();
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return 0;
		}
		const candidates = Object.entries(this.blobSettledRefs)
			.map(([path, ref]) => ({
				path: normalizePath(path),
				ref: cloneBlobRef(ref),
				sourceVersion: this.blobSettledSourceVersions[normalizePath(path)],
			}))
			.filter((candidate): candidate is {
				path: string;
				ref: NonNullable<typeof candidate.ref>;
				sourceVersion: string | undefined;
			} =>
				!!candidate.ref
				&& this.isBlobPathSyncable(candidate.path)
				&& !this.blobSettlementStages[candidate.path]
				&& !this.pendingBlobIntents.hasPath(candidate.path, scope)
				&& !blobSync?.isPreservedUnresolved(candidate.path)
				&& !blobSync?.isPathOperationInFlight(candidate.path)
				&& this.app.vault.getAbstractFileByPath(candidate.path) === null
			);
		if (candidates.length === 0) return 0;

		const statPath = async (path: string): Promise<"present" | "missing" | "error"> => {
			try {
				return await this.app.vault.adapter.stat(path) ? "present" : "missing";
			} catch {
				return "error";
			}
		};
		const first = await mapWithConcurrency(candidates, 8, async (candidate) => ({
			candidate,
			status: await statPath(candidate.path),
		}));
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return 0;
		const missing = first
			.filter(({ status }) => status === "missing")
			.map(({ candidate }) => candidate);
		if (missing.length === 0) return 0;
		await new Promise((resolve) => setTimeout(resolve, 75));
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return 0;
		const confirmed = await mapWithConcurrency(missing, 8, async (candidate) => ({
			candidate,
			status: await statPath(candidate.path),
		}));
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return 0;

		let recorded = 0;
		let settlementStateChanged = false;
		for (const { candidate, status } of confirmed) {
			const currentBlobSync = this.getBlobSync();
			const currentRef = cloneBlobRef(vaultSync.getBlobRef(candidate.path));
			const currentSourceVersion = vaultSync.getBlobSourceVersion(candidate.path);
			if (
				status !== "missing"
					|| this.app.vault.getAbstractFileByPath(candidate.path) !== null
					|| currentBlobSync?.isPathOperationInFlight(candidate.path)
					|| this.pendingBlobIntents.hasPath(candidate.path, scope)
					|| this.blobSettlementStages[candidate.path]
					|| !sameBlobRef(this.blobSettledRefs[candidate.path], candidate.ref)
			) continue;

			if (!currentRef || vaultSync.isBlobTombstoned(candidate.path)) {
				delete this.blobSettledRefs[candidate.path];
				delete this.blobSettledSourceVersions[candidate.path];
				settlementStateChanged = true;
				continue;
			}

			if (
				!candidate.sourceVersion
				|| candidate.sourceVersion !== currentSourceVersion
				|| !sameBlobRef(currentRef, candidate.ref)
			) {
				const stage: BlobSettlementStage = {
					stageId: randomBase64Url(16),
					kind: "retire",
					ref: cloneBlobRef(candidate.ref)!,
					...(candidate.sourceVersion
						? { sourceVersion: candidate.sourceVersion }
						: {}),
					stagedAt: Date.now(),
				};
				this.blobSettlementStages[candidate.path] = stage;
				this.legacyMissingBlobPaths.add(candidate.path);
				if (currentBlobSync) {
					currentBlobSync.recordPreservedUnresolved(
						candidate.path,
						LEGACY_MISSING_BLOB_ATTENTION_REASON,
					);
				} else {
					this.recordPersistedBlobUnresolved(
						candidate.path,
						LEGACY_MISSING_BLOB_ATTENTION_REASON,
					);
				}
				settlementStateChanged = true;
				continue;
			}
			this.pendingBlobIntents.recordDelete(
				candidate.path,
				scope,
				{
					known: true,
					ref: candidate.ref,
					sourceVersionKnown: true,
					expectedSourceVersion: candidate.sourceVersion,
				},
			);
			currentBlobSync?.fenceLocalMutationIntent(
				candidate.path,
				`inactive-delete-discovery:${reason}`,
			);
				recorded++;
		}
		if (settlementStateChanged) {
			await this.enqueueBlobSettledRefPersistence();
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return recorded;
		}
		if (recorded > 0) {
			this.trace("blob", "inactive-blob-deletes-journaled", {
				reason,
				recorded,
				candidateCount: candidates.length,
			});
			try {
				await this.enqueuePendingBlobIntentPersistence();
			} catch (err) {
				if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return recorded;
				throw err;
			}
		}
		return recorded;
	}

	/**
	 * Apply locally journaled attachment intent only after provider sync, and
	 * only when the current disk postcondition still proves the same action.
	 * The journal is durable so closing Obsidian during startup cannot lose a
	 * delete/rename and later resurrect the remote path.
	 */
	private replayPendingBlobIntents(reason: string): Promise<void> {
		const run = this.pendingBlobIntentReplayChain
			.catch(() => undefined)
			.then(() => this.replayPendingBlobIntentsOnce(reason));
		this.pendingBlobIntentReplayChain = run;
		return run;
	}

	private isCurrentBlobReplayAuthority(
		token: BlobAuthorityScopeToken,
		vaultSync: VaultSync,
	): boolean {
		return this.isCurrentBlobAuthority(token)
			&& this.isVaultSyncBoundToCurrentBlobScope(vaultSync);
	}

	private async replayPendingBlobIntentsOnce(reason: string): Promise<void> {
		if (!this.getRuntimeConfig().enableAttachmentSync) return;
		const activation = this.activateBlobAuthorityScope(
			`replay:${reason}`,
			this.getBlobIntentScope(),
		);
		const scope = activation.scope;
		const scopeToken = activation.token;
		if (!scope.host || !scope.vaultId || !scope.localDeviceId) return;
		const vaultSync = this.vaultSync;
		if (
			!vaultSync?.providerSynced
			|| !this.blobProviderReady
			|| !this.blobLocalPersistenceReady
			|| !this.blobSettledRefPersistenceHealthy
		) return;
		if (this.shouldDiscoverInactiveBlobDeletes(reason)) {
			await this.discoverInactiveBlobDeleteIntents(
				scope,
				reason,
				scopeToken,
				vaultSync,
			);
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
		}
		if (this.pendingBlobIntents.getEntries(scope).length === 0) return;

		// Recording a vault event cannot block Obsidian's synchronous event
		// dispatch. Wait for the stable local-only IndexedDB tail before applying
		// any matching CRDT mutation, so a replayed intent was durable first.
		if (!await this.flushPendingBlobIntentPersistence()) return;
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
		if (!await this.flushBlobSettledRefPersistence()) return;
		if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
		if (
			!this.getRuntimeConfig().enableAttachmentSync
			|| !vaultSync.providerSynced
			|| !this.blobProviderReady
			|| !this.blobLocalPersistenceReady
			|| !this.blobSettledRefPersistenceHealthy
		) return;

		// A prior release may have durably journaled `.base` as an attachment.
		// Remove those local intents and persist the scrub before any blob CAS in
		// this pass. The legacy remote ref remains dormant; the CRDT document lane
		// now owns the path and old blob intent must not tombstone it.
		const currentScopeIntents = this.pendingBlobIntents.getEntries(scope);
		const migratedDocumentIntents = currentScopeIntents.map((intent) => ({
			before: intent,
			after: migratePendingBlobIntentDocumentOwnership(intent),
		}));
		const ownershipChanges = migratedDocumentIntents.filter(
			({ before, after }) => after !== before,
		);
		if (ownershipChanges.length > 0) {
			const key = buildPendingBlobIntentStoreKey(scope);
			const foreignEntries = this.pendingBlobIntents.getEntries().filter((entry) =>
				buildPendingBlobIntentStoreKey(entry.scope) !== key
			);
			const migratedScopeEntries = migratedDocumentIntents
				.map(({ after }) => after)
				.filter((entry): entry is PendingBlobIntent => entry !== null);
			this.pendingBlobIntents.hydrate([...foreignEntries, ...migratedScopeEntries]);
			for (const { before } of ownershipChanges) {
				this.pendingBlobRenameFiles.delete(before.id);
			}
			try {
				await this.enqueuePendingBlobIntentPersistence();
			} catch {
				return;
			}
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
			if (!await this.flushPendingBlobIntentPersistence()) return;
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
			this.trace("blob", "pending-blob-document-intents-scrubbed", {
				count: ownershipChanges.length,
				phase: "replay",
			});
		}

		let changed = false;
		let replayed = false;
		for (const intent of this.pendingBlobIntents.getEntries(scope)) {
			// A durable attempted episode may have crossed its CRDT linearization
			// point immediately before process death. Fence it before *any* occupant,
			// receipt, removal, or CAS logic so an H1 revival cannot borrow its base.
			if (intent.commitAttemptId !== undefined) {
				this.recordCommittedBlobIntentConflict(intent, false);
				continue;
			}
			if (
				intent.committedAt === undefined
				&& this.pendingBlobIntentHasSettlementStage(intent)
			) {
				this.recordCommittedBlobIntentConflict(intent, false);
				continue;
			}
			if (
				intent.committedAt === undefined
				&& this.hasOtherUnconfirmedBlobIntentFence(intent, scope)
			) {
				// A later same-path event cannot bypass an older operation whose CAS
				// outcome is still unconfirmed. Rename episodes own both namespaces.
				this.recordCommittedBlobIntentConflict(intent, false);
				continue;
			}

			if (intent.kind === "delete") {
				const occupant = this.app.vault.getAbstractFileByPath(intent.path);
				if (occupant !== null && intent.committedAt !== undefined) {
					this.recordCommittedBlobIntentConflict(
						intent,
						this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync),
					);
					continue;
				}
				if (this.isPendingBlobIntentReceiptConfirmed(intent, vaultSync)) {
					if (!await this.prepareCommittedBlobIntentForRemoval(intent, vaultSync)) {
						this.recordCommittedBlobIntentConflict(intent, false);
						continue;
					}
					this.clearResolvedLocalBlobMutationConflict(intent);
					changed = this.pendingBlobIntents.remove(intent.id) || changed;
					continue;
				}
				if (intent.committedAt !== undefined) {
					if (this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync)) {
						this.replayedCommittedBlobIntentIds.add(intent.id);
					} else {
						this.recordCommittedBlobIntentConflict(intent, false);
					}
					continue;
				}

				const outcome = await this.commitReadyPendingBlobIntent(
					intent,
					scope,
					scopeToken,
					vaultSync,
					() => {
						// The write-ahead await creates a real race window. Re-read the
						// exact disk postcondition here, immediately before the CAS.
						const currentOccupant = this.app.vault.getAbstractFileByPath(intent.path);
						if (currentOccupant instanceof TFile) {
							return {
								kind: "precondition-changed",
								disposition: "remove-intent",
								path: intent.path,
								observedOccupant: currentOccupant,
								admitObservedFile: true,
							};
						}
						if (currentOccupant !== null) {
							this.getBlobSync()?.recordPreservedUnresolved(
								intent.path,
								"path-collision",
							);
							if (!this.getBlobSync()) {
								this.recordPersistedBlobUnresolved(intent.path, "path-collision");
							}
							return {
								kind: "precondition-changed",
								disposition: "retain-intent",
								path: intent.path,
							};
						}
						return {
							kind: "mutation",
							sourcePath: intent.path,
							result: this.applyPendingBlobDelete(intent, vaultSync),
						};
					},
				);
				if (
					await this.finishPendingBlobIntentCommit(
						intent,
						outcome,
						scopeToken,
						vaultSync,
					) === "stop"
				) return;
				// Both attempted->ready and attempted->committed final snapshots
				// include every earlier in-loop removal.
				changed = false;
				replayed = true;
				continue;
			}

			const oldOccupant = this.app.vault.getAbstractFileByPath(intent.oldPath);
			if (oldOccupant !== null && intent.committedAt !== undefined) {
				this.recordCommittedBlobIntentConflict(
					intent,
					this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync),
				);
				continue;
			}
			if (this.isPendingBlobIntentReceiptConfirmed(intent, vaultSync)) {
				if (!await this.prepareCommittedBlobIntentForRemoval(intent, vaultSync)) {
					this.recordCommittedBlobIntentConflict(intent, false);
					continue;
				}
				this.clearResolvedLocalBlobMutationConflict(intent);
				changed = this.pendingBlobIntents.remove(intent.id) || changed;
				this.pendingBlobRenameFiles.delete(intent.id);
				continue;
			}
			if (intent.committedAt !== undefined) {
				if (this.hasPendingBlobIntentCommitPostcondition(intent, vaultSync)) {
					this.replayedCommittedBlobIntentIds.add(intent.id);
				} else {
					this.recordCommittedBlobIntentConflict(intent, false);
				}
				continue;
			}

			const expectedRenameFile = this.pendingBlobRenameFiles.get(intent.id);
			const outcome = await this.commitReadyPendingBlobIntent(
				intent,
				scope,
				scopeToken,
				vaultSync,
				() => {
					const currentOldOccupant = this.app.vault.getAbstractFileByPath(intent.oldPath);
					if (currentOldOccupant !== null) {
						return {
							kind: "precondition-changed",
							disposition: "remove-intent",
							path: intent.oldPath,
							observedOccupant: currentOldOccupant,
						};
					}
					const currentNewOccupant = this.app.vault.getAbstractFileByPath(intent.newPath);
					if (
						expectedRenameFile === currentNewOccupant
						&& currentNewOccupant instanceof TFile
						&& this.isBlobPathSyncable(currentNewOccupant.path)
					) {
						return {
							kind: "mutation",
							sourcePath: intent.oldPath,
							result: this.applyPendingBlobRename(
								intent,
								currentNewOccupant,
								vaultSync,
							),
						};
					}
					// A TFile identity cannot survive restart. Tombstone only the absent
					// source; reconciliation treats any destination as a fresh upload.
					return {
						kind: "mutation",
						sourcePath: intent.oldPath,
						result: this.applyPendingBlobDelete({
							...intent,
							kind: "delete",
							path: intent.oldPath,
						}, vaultSync),
					};
				},
			);
			if (
				await this.finishPendingBlobIntentCommit(
					intent,
					outcome,
					scopeToken,
					vaultSync,
				) === "stop"
			) return;
			changed = false;
			replayed = true;
		}

		if (changed) {
			try {
				await this.enqueuePendingBlobIntentPersistence();
			} catch {
				return;
			}
		}
		if (changed || replayed) {
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
			if (!await this.flushPendingBlobIntentPersistence()) return;
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
			if (!await this.flushBlobSettledRefPersistence()) return;
			if (!this.isCurrentBlobReplayAuthority(scopeToken, vaultSync)) return;
			this.trace("blob", "pending-blob-intents-replayed", {
				reason,
				remainingCount: this.pendingBlobIntents.getEntries(scope).length,
			});
		}
	}

	private async openDashboard(): Promise<void> {
		const existing = this.findRootDashboardLeaf();
		if (existing) {
			await existing.loadIfDeferred();
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType(KAOS_DASHBOARD_VIEW_TYPE)) {
			leaf.detach();
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: KAOS_DASHBOARD_VIEW_TYPE,
			active: true,
		});
		await leaf.loadIfDeferred();
		await this.app.workspace.revealLeaf(leaf);
	}

	private findRootDashboardLeaf(): WorkspaceLeaf | null {
		let found: WorkspaceLeaf | null = null;
		this.app.workspace.iterateRootLeaves((leaf) => {
			if (found) return;
			if (leaf.getViewState().type === KAOS_DASHBOARD_VIEW_TYPE) {
				found = leaf;
			}
		});
		return found;
	}

	async onload() {
		const onloadStartedAt = Date.now();

		// Initialize QA harness state before any component construction so that
		// registerDiskIngestPort (called from createReconciliationController) and
		// BindingPropagationGate hooks can store into _qaState.
		// In production this block is dead code — esbuild eliminates it entirely.
		if (__KAOS_QA_HARNESS_ENABLED__) {
			this._qaState = {
				diskIngestPort: null,
				externalEditPolicyOverride: null,
				pausedEditorPropagationPaths: new Set(),
				bindingReconfigureHook: null,
				controlPort: {
					ingestDiskFileNow: async (path, reason = "modify") => {
						if (!this._qaState?.diskIngestPort) throw new Error("DiskIngestPort not registered (reconciliation controller not started?)");
						await this._qaState.diskIngestPort.ingestDiskFileNow(path, reason);
					},
					pauseEditorPropagation: (path) => {
						if (!this._qaState) return false;
						if (this._qaState.pausedEditorPropagationPaths.has(path)) return false;
						this._qaState.pausedEditorPropagationPaths.add(path);
						this._qaState.bindingReconfigureHook?.(path, this.settings.deviceName, "pause");
						return true;
					},
					resumeEditorPropagation: (path) => {
						if (!this._qaState) return false;
						if (!this._qaState.pausedEditorPropagationPaths.has(path)) return false;
						this._qaState.pausedEditorPropagationPaths.delete(path);
						this._qaState.bindingReconfigureHook?.(path, this.settings.deviceName, "resume");
						return true;
					},
					setExternalEditPolicyOverride: (policy) => {
						if (!this._qaState) throw new Error("QA state not initialised");
						const previous = this._qaState.externalEditPolicyOverride ?? this.getRuntimeConfig().externalEditPolicy;
						this._qaState.externalEditPolicyOverride = policy;
						return previous;
					},
				},
			};
			// Attach the accessor as an instance property so the method name
			// never appears on the class prototype in production bundles.
				const qaAccessorHost = this as VaultCrdtSyncPlugin & {
					getEngineControlPort?: () => EngineControlPort;
				};
				qaAccessorHost.getEngineControlPort = (): EngineControlPort => {
					if (!this._qaState) throw new Error("QA harness state not initialised");
					return this._qaState.controlPort;
				};
		}

		this.registerView(KAOS_DASHBOARD_VIEW_TYPE, (leaf) => new KaosDashboardView(leaf, {
			collectData: () => this.collectDashboardData(),
			getBaselineText: (contentHash) => this.getBaselineText(contentHash),
			getConflictMergeBaseHash: (artifactPath) => this.conflictMergeBases[artifactPath] ?? null,
			clearConflictMergeBase: (artifactPath) => {
				const previousHash = this.conflictMergeBases[artifactPath];
				delete this.conflictMergeBases[artifactPath];
				if (previousHash) this.baselineTextDeleteCandidates.add(previousHash);
				void this.persistPluginState();
			},
			actions: {
				reconnect: () => {
					if (!this.vaultSync) {
						new Notice("Sync not initialized");
						return;
					}
					this.connectionController?.reconnect("dashboard");
					new Notice("Reconnecting...");
				},
				forceReconcile: () => {
					const vaultSync = this.vaultSync;
					if (!vaultSync) {
						new Notice("Sync not initialized");
						return;
					}
					void this.runReconciliation(vaultSync.getSafeReconcileMode());
				},
				importUntracked: async () => {
					if (!this.vaultSync) {
						new Notice("Sync not initialized");
						return;
					}
					const count = this.reconciliationController.untrackedFileCount;
					if (count === 0) {
						new Notice("No untracked files to import.");
						return;
					}
					await this.importUntrackedFiles();
					new Notice(`Imported ${count} untracked file(s).`);
				},
				takeSnapshotNow: async () => {
					await this.snapshotService?.takeSnapshotNow();
				},
				showSnapshotList: async () => {
					await this.snapshotService?.showSnapshotList();
				},
				createFileHistoryPoint: async () => {
					await this.snapshotService?.createFileHistoryPoint();
				},
				showRecoveryHistory: async (target) => {
					await this.snapshotService?.showRecoveryHistory(target);
				},
				exportDiagnostics: () => {
					void (this.lab?.diagnosticsService as import("./telemetry/diagnostics/diagnosticsService").DiagnosticsService | undefined)?.exportDiagnostics();
				},
				exportDiagnosticsWithFilenames: () => {
					void (this.lab?.diagnosticsService as import("./telemetry/diagnostics/diagnosticsService").DiagnosticsService | undefined)?.exportDiagnosticsWithFilenames();
				},
				resolveRemoteDeleteAttention: (target, choice) =>
					this.resolveRemoteDeleteAttention(target, choice),
				resolveLegacyMissingBlobAttention: (target, choice) =>
					this.resolveLegacyMissingBlobAttention(target, choice),
			},
		}));
		this.addRibbonIcon("layout-dashboard", "Open dashboard", () => {
			void this.openDashboard();
		}).addClass("kaos-dashboard-ribbon-icon");

		this.capabilityUpdateService = new CapabilityUpdateService({
			getSettings: () => this.settings,
			pluginVersion: this.manifest.version,
			schemaVersion: SCHEMA_VERSION,
			trace: (source, msg, details) => this.trace(source, msg, details),
			log: (message) => this.log(message),
			persistPluginState: () => this.persistPluginState(),
			hasSyncRuntime: () => this.vaultSync !== null,
			isSyncConnectedAndProviderSynced: () => !!this.vaultSync?.connected && !!this.vaultSync?.providerSynced,
			refreshAttachmentSyncRuntime: (reason) => this.refreshAttachmentSyncRuntime(reason),
			triggerDailySnapshot: () => { void this.snapshotService?.triggerDailySnapshot(); },
			stopSyncRuntimeForCompatibility: () => {
				if (this.vaultSync) {
					void this.teardownSync();
				}
			},
			setStatusError: () => this.updateStatusBar("error"),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
			openExternalUrl: (url) => window.open(url, "_blank", "noopener"),
		});
		try {
			const identity = await getOrCreateLocalDeviceIdentity();
			this.blobIntentLocalDeviceId = identity.localDeviceId;
			this.blobLocalDeviceIdentityStatus = identity.status;
		} catch (err) {
			this.log(`Local attachment authority ID unavailable: ${formatUnknown(err)}`);
		}
		await this.loadSettings();
		this.applyRuntimeSettings("load-settings");
			const isFrontmatterGuardEnabled = () => this.settings.frontmatterGuardEnabled;
			this.frontmatterGuardCoordinator = new FrontmatterGuardCoordinator({
				get frontmatterGuardEnabled() { return isFrontmatterGuardEnabled(); },
				trace: (source, event, data) => this.trace(source, event, data),
				persistPluginState: () => this.persistPluginState(),
				getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
			setFrontmatterQuarantineEntries: (entries) => {
				this.frontmatterQuarantineEntries = entries;
			},
		});
		this.createReconciliationController();
		this.editorWorkspace = new EditorWorkspaceOrchestrator({
			app: this.app,
			getSettings: () => this.settings,
			getEditorBindings: () => this.editorBindings,
			getDiskMirror: () => this.diskMirror,
			isMarkdownPathSyncable: (path) => this.isMarkdownEditorPathSyncable(path),
			maybeImportDeferredClosedOnlyPath: (path, reason) =>
				this.reconciliationController.maybeImportDeferredClosedOnlyPath(path, reason),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
		});
		this.snapshotService = new SnapshotService({
			app: this.app,
			getSettings: () => this.settings,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.getBlobSync(),
			getServerSupportsSnapshots: () => this.serverSupportsSnapshots,
			log: (message) => this.log(message),
			onEditorsNeedReconcile: (reason) => this.editorWorkspace?.onReconciled(reason),
		});
		this.setupLinkController = new SetupLinkController({
			app: this.app,
			getSettings: () => this.settings,
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			hasSyncRuntime: () => this.vaultSync !== null,
			initSync: () => {
				void this.initSync();
			},
		});
		this.registerObsidianProtocolHandler("kaos", (params) => {
			void this.setupLinkController?.handleSetupLink(params);
		});

		let generatedVaultId = false;
		if (!this.settings.vaultId) {
			await this.updateSettings((settings) => {
				settings.vaultId = generateVaultId();
			}, "startup-generate-vault-id");
			generatedVaultId = true;
		}

		if (!this.settings.deviceName) {
			await this.updateSettings((settings) => {
				settings.deviceName = `device-${Date.now().toString(36)}`;
			}, "startup-generate-device-name");
		}
		await this.ensurePendingBlobIntentPersistence();
		await this.ensureBlobSettledRefPersistence();

		await this.initializeBaselineTextPersistence();

		// Install telemetry runtime when debug or qaDebugMode is enabled.
		// Dynamic load keeps telemetry code out of the product bundle on normal startup.
		if (this.settings.debug || this.settings.qaDebugMode) {
			// Load telemetry.js by reading the file and evaluating it in the current
			// module scope.  This is necessary because:
			//   - import() in Obsidian's renderer uses app://obsidian.md scheme, which
			//     cannot serve arbitrary filesystem paths outside the ASAR bundle.
			//   - require() loads the file but the sub-module's own require doesn't
			//     have Obsidian's patched require in scope, so require("obsidian") fails.
			// Evaluating with new Function() and the current require passes Obsidian's
			// patched require to the telemetry module so it can resolve "obsidian".
			const adapterWithBasePath = this.app.vault.adapter as { basePath?: unknown };
			const basePath = adapterWithBasePath.basePath;
			if (typeof basePath !== "string" || basePath.length === 0) {
				throw new Error("Cannot load telemetry runtime: vault adapter basePath is unavailable.");
			}
			const pluginDir = `${basePath}/${this.manifest.dir}`;
			const telemetryBundlePath = `${pluginDir}/telemetry.js`;
			// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules
			const fs = require("fs") as typeof import("fs");
			const telemetryCode = fs.readFileSync(telemetryBundlePath, "utf-8");
			const telemetryModule = { exports: {} as Record<string, unknown> };
			type TelemetryBundleFactory = (
				requireFn: NodeRequire,
				module: { exports: Record<string, unknown> },
				exports: Record<string, unknown>,
				filename: string,
				dirname: string,
			) => void;
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			const telemetryFn = new Function(
				"require",
				"module",
				"exports",
				"__filename",
				"__dirname",
				telemetryCode,
			) as TelemetryBundleFactory;
			telemetryFn(require, telemetryModule, telemetryModule.exports, telemetryBundlePath, pluginDir);
			const { installTelemetryRuntime } = telemetryModule.exports as typeof import("./telemetry/installTelemetryRuntime");
			this.lab = await installTelemetryRuntime({
				app: this.app,
				getSettings: () => this.settings,
				getVaultSync: () => this.vaultSync,
				getReconciliationController: () => this.reconciliationController,
				getConnectionController: () => this.connectionController,
				getEditorBindings: () => this.editorBindings,
				getTraceSink: () => this.traceSink,
				getTraceHttpContext: () => this.getTraceHttpContext(),
				getDiskMirror: () => this.diskMirror,
				getBlobSync: () => this.getBlobSync(),
				getEventRing: () => this.eventRing,
				getRecentServerTrace: () => this.traceRuntime?.getRecentServerTrace() ?? [],
				getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
				getRuntimeDiagnosticsState: () => ({
					reconciled: this.reconciliationController.getState().reconciled,
					reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
					reconcilePending: this.reconciliationController.getState().reconcilePending,
					lastReconcileStats: this.reconciliationController.getState().lastReconcileStats,
					awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
					lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
					untrackedFileCount: this.reconciliationController.untrackedFileCount,
					unresolvedStructuralChangeCount: this.reconciliationController.getState().unresolvedStructuralChangeCount,
					unresolvedStructuralChangeSample: this.reconciliationController.getState().unresolvedStructuralChangeSample,
					openFileCount: this.editorWorkspace?.openFileCount ?? 0,
				}),
				collectOpenFileTraceState: () => this.collectOpenFileTraceState(),
				sha256Hex: (text) => this.sha256Hex(text),
				getPluginVersion: () => this.manifest.version,
				isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
				registerCleanup: (cleanup) => this.register(cleanup),
				log: (msg) => this.log(msg),
			});
			// Replace noop traceSink with telemetry's FlightTraceSink
			this.traceSink = this.lab.traceSink;
		}

		// setupTraceRuntime after telemetry install so createLogger can reference this.lab
		this.setupTraceRuntime();

		this.setupFlightTrace();
		this.attachmentOrchestrator = new AttachmentOrchestrator({
			app: this.app,
			getVaultSync: () => this.vaultSync,
			getRuntimeConfig: () => this.getRuntimeConfig(),
			getServerSupportsAttachments: () => this.serverSupportsAttachments,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getBlobHashCache: () => this.blobHashCache,
			getBlobSettledRefs: () => this.blobSettledRefs,
			getBlobSettledSourceVersions: () => this.blobSettledSourceVersions,
			getBlobSettlementStages: () => this.blobSettlementStages,
			captureBlobRuntimeAuthority: (vaultSync, scope) =>
				this.captureBlobRuntimeAuthority(vaultSync, scope),
			isBlobRuntimeAuthorityCurrent: (vaultSync, scope, token) =>
				this.isBlobRuntimeAuthorityCurrent(vaultSync, scope, token),
			isUploadAuthoritySourceReady: (vaultSync, scope, token) =>
				this.isBlobRuntimeAuthorityCurrent(vaultSync, scope, token)
				&& this.app.workspace.layoutReady
				&& vaultSync.idbError !== true
				&& this.blobLocalPersistenceReady
				&& this.blobProviderReady
				&& this.pendingBlobIntentPersistenceHealthy
				&& this.blobSettledRefPersistenceHealthy,
			onBlobSettledRefsChanged: (path, ref, scope, vaultSync, token) =>
				this.handleBlobSettledRefsChanged(path, ref, scope, vaultSync, token),
			stageBlobSettlement: (path, stage, scope, vaultSync) =>
				this.stageBlobSettlement(path, stage, scope, vaultSync),
			finalizeBlobSettlement: (
				path,
				stageId,
				ref,
				sourceVersion,
				scope,
				vaultSync,
			) => this.finalizeBlobSettlement(
				path,
				stageId,
				ref,
				sourceVersion,
				scope,
				vaultSync,
			),
			retireBlobSettlement: (path, stageId, scope, vaultSync) =>
				this.retireBlobSettlement(path, stageId, scope, vaultSync),
			abortBlobSettlementStage: (path, stageId, scope, vaultSync) =>
				this.abortBlobSettlementStage(path, stageId, scope, vaultSync),
			getExcludePatterns: () => this.excludePatterns,
			getBlobQueuePersistenceScope: () => this.getBlobIntentScope(),
			persistBlobQueue: (snapshot, scope, token) =>
				this.persistBlobQueueSnapshot(snapshot, scope, token),
			clearPersistedBlobQueue: (scope, token) =>
				this.clearSavedBlobQueue(scope, token),
			getPreservedUnresolvedEntries: () => this.preservedUnresolvedEntries,
			onPreservedUnresolvedChanged: () => this.persistPreservedUnresolvedState(),
			hasPendingBlobIntentForPath: (path) =>
				this.pendingBlobIntents.hasPath(path, this.getBlobIntentScope()),
			replayPendingBlobIntents: (reason) => this.replayPendingBlobIntents(reason),
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			refreshStatusBar: () => this.refreshStatusBar(),
			log: (message) => this.log(message),
		});
		this.attachmentOrchestrator.hydrateSavedQueue(this.savedBlobQueue);
		this.savedBlobQueue = null;
		if (generatedVaultId) {
			this.log(`Generated vault ID: ${this.settings.vaultId}`);
		}

		this.addSettingTab(new VaultSyncSettingTab(this.app, this, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("disconnected");

		const finishOnload = (outcome: string): void => {
			const durationMs = Date.now() - onloadStartedAt;
			this.trace("trace", "startup-onload-complete", {
				durationMs,
				outcome,
				hostConfigured: !!this.settings.host,
				tokenConfigured: !!this.settings.token,
			});
			this.log(`Startup onload complete (${outcome}) in ${durationMs}ms`);
		};

		if (this.settings.host) {
			void this.refreshServerCapabilities("startup-background");
			void this.refreshUpdateManifest("startup-background");
			void this.syncUpdateMetadataToServer("startup-background");
		}

		if (!this.settings.host) {
			this.log("Host not configured — sync disabled");
			new Notice("Configure the server host in settings to enable sync.");
			finishOnload("missing-host");
			return;
		}

		if (!this.settings.token) {
			this.log("Token not configured — sync disabled");
			const message = this.serverAuthMode === "env"
				? "KAOS: configure the server token in settings to enable sync."
				: this.serverAuthMode === "claim" || this.serverAuthMode === "unclaimed"
						? "KAOS: claim the server in a browser, then use the KAOS setup link to fill in the token."
						: "KAOS: configure a token in settings, or claim the server in a browser first.";
			new Notice(message, 10000);
			finishOnload("missing-token");
			return;
		}

		// Parse exclude patterns and file size limit from settings
		this.applyRuntimeSettings("onload-pre-sync");

		// Warn about insecure connections to non-localhost hosts
		if (this.settings.host) {
			try {
				const url = new URL(this.settings.host);
				const h = url.hostname;
				if (url.protocol === "http:" && h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") {
						this.log("WARNING: connecting over unencrypted HTTP to a remote host — token sent in plaintext");
						new Notice(
							"Connecting over unencrypted HTTP. Your token will be sent in plaintext. Use HTTPS for production.",
							8000,
						);
					}
			} catch { /* invalid URL, will fail at connect */ }
		}

		void this.initSync().then(() => this.mountQaDebugApi());
		finishOnload("sync-started");
	}

	private async initSync(): Promise<void> {
		const initSyncStartedAt = Date.now();
		const initEntryAuthority = this.blobAuthorityScopeGuard.capture();
		let initBlobRuntimeAuthority: {
			vaultSync: VaultSync;
			scope: PendingBlobIntentScope;
			token: BlobAuthorityScopeToken;
		} | null = null;
		const isCurrentInitBlobAuthority = (): boolean => {
			const authority = initBlobRuntimeAuthority;
			return !!authority && this.isBlobRuntimeAuthorityCurrent(
				authority.vaultSync,
				authority.scope,
				authority.token,
			);
		};
		await this.attachmentOrchestrator?.destroy();
		if (!this.isCurrentBlobAuthority(initEntryAuthority)) return;
		this.blobLocalPersistenceReady = false;
		this.blobProviderReady = false;
		this.trace("trace", "startup-init-sync-start", {
			hostConfigured: !!this.settings.host,
			tokenConfigured: !!this.settings.token,
			hasCachedCapabilities: this.capabilityUpdateService?.hasCachedCapabilities ?? false,
		});
		try {
			this.idbDegradedHandled = false;
			this.applyRuntimeSettings("init-sync");
			const initPersistenceAuthority = this.blobAuthorityScopeGuard.capture();
			await this.ensurePendingBlobIntentPersistence();
			if (!this.isCurrentBlobAuthority(initPersistenceAuthority)) return;
			await this.ensureBlobSettledRefPersistence();
			if (!this.isCurrentBlobAuthority(initPersistenceAuthority)) return;
			if (this.enforceCompatibilityGuard("init-sync-preflight")) {
				return;
			}

			// 1. Create VaultSync (Y.Doc + IndexedDB + provider in parallel)
			this.vaultSync = new VaultSync(this.settings, {
				traceContext: this.getTraceHttpContext(),
				trace: (source, msg, details) => this.trace(source, msg, details),
				onFlightEvent: (event) => this.recordFlightEvent(event as import("./telemetry/debug/flightEvents").FlightEventInput),
				onFlightPathEvent: (event) => this.recordFlightPathEvent(event),
			getSocketTicket: (() => {
				// Each VaultSync instance gets its own ticket cache.  The cache
				// is discarded when VaultSync is torn down and recreated.
				const ticketCache = createSocketTicketCache();
				return async (force = false): Promise<{
					value: string;
					expiresAt: number;
					localExpiresAt: number;
					ttlMs: number;
				} | null> => {
					const socketTicketAuth =
						this.capabilityUpdateService?.capabilities?.socketTicketAuth;

					// Known old server that explicitly signals no ticket support.
					if (socketTicketAuth === false) return null;

					// Already confirmed this server does not have the ticket
					// endpoint — skip the network probe.
					if (ticketCache.isUnsupported()) return null;

					// socketTicketAuth === true  → confirmed support.
					// socketTicketAuth === undefined → capability not yet fetched
					//   (first run, empty cache, slow background poll).
					// Both: try the ticket endpoint.
					//
					// On a clean "endpoint not found" signal (404/405/501) from an
					// unknown-capability server, mark the cache unsupported and fall
					// back to ?token= for this connection.  Any other failure (auth,
					// network, 5xx) must propagate — never silently downgrade to the
					// long-lived token.
					//
					// force=true is used by VaultSync's proactive refresh timer to
					// bypass the cache and always obtain a fresh ticket.
					if (force) ticketCache.invalidate();

					try {
							return await ticketCache.get(
								this.settings.host,
								this.settings.token,
								this.settings.vaultId,
							);
					} catch (err) {
						if (
							socketTicketAuth === undefined
							&& isTicketEndpointUnsupported(err)
						) {
							// Old server confirmed: stop probing on future reconnects.
							ticketCache.markUnsupported();
								this.log("socket ticket endpoint not found; using legacy ?token= for this connection");
								return null;
							}
							// Real failure — propagate.
							this.log(`socket ticket fetch failed: ${String(err)}`);
							throw err;
					}
				};
			})(),
			});
			this.vaultSyncBlobAuthorityTokens.set(
				this.vaultSync,
				this.blobAuthorityScopeGuard.capture(),
			);
			const vaultSync = this.vaultSync;
			const blobRuntimeScope = this.getBlobIntentScope();
			const blobRuntimeToken = this.captureBlobRuntimeAuthority(
				vaultSync,
				blobRuntimeScope,
			);
			if (!blobRuntimeToken) return;
			initBlobRuntimeAuthority = {
				vaultSync,
				scope: { ...blobRuntimeScope },
				token: { ...blobRuntimeToken },
			};

			// 2. EditorBindingManager
			const bindingPropagationGate: BindingPropagationGate = {
				isPaused: (path) => {
					if (__KAOS_QA_HARNESS_ENABLED__ && this._qaState) {
						return this._qaState.pausedEditorPropagationPaths.has(path);
					}
					return false;
				},
				registerReconfigureHook: (fn) => {
					if (__KAOS_QA_HARNESS_ENABLED__ && this._qaState) {
						this._qaState.bindingReconfigureHook = fn;
					}
				},
			};
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.settings.debug,
				(path) => this.isMarkdownEditorPathSyncable(path),
				(source, msg, details) => this.trace(source, msg, details),
				(event) => this.recordFlightPathEvent(event),
				bindingPropagationGate,
				() => this.settings.remoteTypingGuardEnabled,
			);

			// 3. Global CM6 extension
			this.registerEditorExtension(
				this.editorBindings.getBaseExtension(),
			);

			// 4. DiskMirror
			this.diskMirror = new DiskMirror(
				this.app,
				this.vaultSync,
				this.editorBindings,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
				() => this.settings.frontmatterGuardEnabled,
				(path, direction, reason, validation, previousContent, nextContent) =>
					this.handleFrontmatterValidation(
						path,
						direction,
						reason,
						validation,
						previousContent,
						nextContent,
					),
				() => this.settings.deviceName,
				this.preservedUnresolvedEntries,
				() => this.persistPreservedUnresolvedState(),
			);
			this.diskMirror.setMarkdownPathSyncabilityPredicate((path) => this.isMarkdownPathSyncable(path));
			this.diskMirror.setDiskBaselineHashProvider(
				(path) => this.diskIndex[path]?.contentHash ?? null,
			);
			this.diskMirror.setDiskBaselineTextProvider(async (path) => {
				const expectedHash = this.diskIndex[path]?.contentHash?.toLowerCase() ?? null;
				if (!expectedHash) return null;
				const text = await this.getBaselineText(expectedHash);
				return this.diskIndex[path]?.contentHash?.toLowerCase() === expectedHash
					? text
					: null;
			});
			this.diskMirror.startMapObservers();
			this.diskMirror.setFlightEventHandler((event) => this.recordFlightPathEvent(event as import("./telemetry/debug/flightEvents").FlightPathEventInput));
			// Track SHA-256 baseline hash after every successful flushWrite.
			// Used by decideClosedFileConflict on startup/re-enable to determine
			// which side actually changed from the last known stable state.
			this.diskMirror.setDiskWriteCallback((path, contentHash, content) => {
				this.reconciliationController.noteDiskBaselineSettlement(path, content);
				const existing = this.diskIndex[path];
				const previousHash = existing?.contentHash;
				if (existing) {
					existing.contentHash = contentHash;
				} else {
					this.diskIndex[path] = { mtime: 0, size: 0, contentHash };
				}
				if (previousHash && previousHash !== contentHash) {
					this.baselineTextDeleteCandidates.add(previousHash);
				}
				this.recordBaselineText(contentHash, content);
				this.scheduleDiskIndexSave("disk-write-baseline");
				// Req 17.2: mark dirty after post-readback verification succeeds.
				// contentHash is baselineHash-domain — NOT published as diskHash.
				this.lab?.markWitnessDirty(path, "disk-write");
			});

			// 4b. BlobSyncManager (if attachment sync is enabled)
			this.attachmentOrchestrator?.start("startup", false);

			// 5. Status tracking
			this.connectionController = new ConnectionController({
				getVaultSync: () => this.vaultSync,
				isReconciled: () => this.reconciliationController.isReconciled,
				getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
				setAwaitingFirstProviderSyncAfterStartup: (value) => {
					this.awaitingFirstProviderSyncAfterStartup = value;
				},
				getLastReconciledGeneration: () => this.reconciliationController.lastGeneration,
				setReconnectPending: () => {
					this.reconciliationController.markPending();
				},
				isReconcileInFlight: () => this.reconciliationController.isReconcileInFlight,
				runReconnectReconciliation: (generation) => {
					void this.reconciliationController.runReconnectReconciliation(generation);
				},
				refreshServerCapabilities: (reason) => {
					void this.refreshServerCapabilities(reason);
				},
				flushOpenWrites: (reason) => {
					void this.diskMirror?.flushOpenWrites(reason);
				},
				updateOfflineStatus: () => this.updateStatusBar("offline"),
				refreshStatusBar: () => this.refreshStatusBar(),
				scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
				log: (message) => this.log(message),
				trace: (source, msg, details) => this.trace(source, msg, details),
				registerCleanup: (cleanup) => this.register(cleanup),
			});
			this.connectionController.start();

			// Wire provider flight events
			vaultSync.provider.on("status", (event: { status: string }) => {
				if (!isCurrentInitBlobAuthority()) return;
				if (event.status === "connected") {
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.connected",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: vaultSync.connectionGeneration,
						data: { wsStatus: event.status },
					});
				} else if (event.status === "disconnected") {
					this.blobProviderReady = false;
					this.attachmentOrchestrator?.revokeUploadAuthority(
						"provider-disconnected",
					);
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.disconnected",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: vaultSync.connectionGeneration,
						data: { wsStatus: event.status },
					});
				}
			});
			vaultSync.provider.on("sync", (synced: boolean) => {
				if (!isCurrentInitBlobAuthority()) return;
				if (synced) {
					const schemaError = vaultSync.checkSchemaVersion();
					if (schemaError) {
						this.blobProviderReady = false;
						this.attachmentOrchestrator?.revokeUploadAuthority(
							"provider-schema-incompatible",
						);
						vaultSync.provider.disconnect();
						new Notice(`KAOS: ${schemaError}`);
						this.updateStatusBar("error");
						return;
					}
					// Y.Map scalar conflict resolution is not numeric-max. Reassert
					// the v4 floor after the authoritative room update has merged.
					vaultSync.markCurrentSchema(this.settings.deviceName);
					// Opening uploads still waits for the authoritative reconciliation
					// callback; this flag only records that the Y.Doc source is ready.
					this.blobProviderReady = true;
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.sync.complete",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: vaultSync.connectionGeneration,
					});
				}
			});
			const statusInterval = setInterval(() => {
				if (!isCurrentInitBlobAuthority()) return;
				if (
					vaultSync.localReady
					&& !vaultSync.idbError
					&& !this.blobLocalPersistenceReady
				) {
					this.blobLocalPersistenceReady = true;
					this.log("IndexedDB became ready after the startup wait");
					if (this.blobProviderReady) {
						// The first authoritative pass may have run without local IDB.
						// Re-run once with both authority sources before opening uploads.
						void this.runReconciliation("authoritative");
					}
				}
				this.refreshStatusBar();
				this.schedulePendingBlobIntentReplay("status-tick");
				if (this.reconciliationController.isReconciled && this.editorBindings) {
					const touched = this.editorWorkspace?.auditBindings("status-tick") ?? 0;
					if (touched > 0) {
						this.log(`Binding health audit (status-tick) — touched ${touched}`);
					}
				}
				// Periodically persist blob queue if transfers are active,
				// or clear persisted queue if transfers completed
				this.attachmentOrchestrator?.handleStatusTick();
				const waitingForGuidedUpdate = this.capabilityUpdateService?.hasActiveGuidedServerUpdate() ?? false;
				if (waitingForGuidedUpdate &&
					(this.capabilityUpdateService?.shouldRefreshCapabilities() ?? false)) {
					void this.refreshServerCapabilities("guided-update-poll");
				}
			}, 3000);
			this.statusInterval = statusInterval;
			this.register(() => {
				clearInterval(statusInterval);
				if (this.statusInterval === statusInterval) this.statusInterval = null;
			});
			this.startSnapshotMaintenanceTimers();

			// 6. Vault events (gated by reconciliation state)
			this.registerVaultEvents();

			// 7. Commands
			if (!this.commandsRegistered) {
				registerCommands(this, {
					getVaultSync: () => this.vaultSync,
					getConnectionController: () => this.connectionController,
					getDiagnosticsService: () => this.lab?.diagnosticsService as import("./telemetry/diagnostics/diagnosticsService").DiagnosticsService ?? null,
					getSnapshotService: () => this.snapshotService,
					getFilesNeedingAttentionText: () => this.buildFilesNeedingAttentionText(),
					getUntrackedFileCount: () => this.reconciliationController.untrackedFileCount,
					openDashboard: () => this.openDashboard(),
					runReconciliation: (mode) => this.runReconciliation(mode),
					runSchemaMigrationToV2: () => this.runSchemaMigrationToV2(),
					importUntrackedFiles: () => this.importUntrackedFiles(),
					clearLocalServerReceiptState: () => this.clearLocalServerReceiptState(),
					resetLocalCache: () => this.resetLocalCache(),
					nuclearReset: () => this.nuclearReset(),
				});
				// Lab/QA commands are registered separately by the lab runtime.
				this.lab?.registerCommands(this);
				this.commandsRegistered = true;
			}

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index + blob hash cache
			vaultSync.onRenameBatchFlushed((renames) => {
				if (!isCurrentInitBlobAuthority()) return;
				this.editorWorkspace?.onRenameBatchFlushed(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

				// Move blob hash cache entries
				moveCachedHashes(this.blobHashCache, renames);
				moveSettledBlobRefs(this.blobSettledRefs, renames);

				// Redirect any pending dirty creates or modifies from oldPath → newPath.
				// Two race classes this handles:
				//   1. Pre-CRDT race: rename fires before create is processed →
				//      pending create at oldPath redirected to newPath (ensureFile runs there).
				//   2. Modify-then-rename race: modify queued, rename fires before drain →
				//      pending modify at oldPath redirected to newPath (syncFileFromDisk runs there).
				// Without this, both cases leave newPath with stale or missing CRDT content.
				for (const [oldPath, newPath] of renames) {
					this.reconciliationController.redirectPendingDirtyPath(oldPath, newPath);
				}

				// Defensive assertion: after rename admission policy (enforced at
				// queue time), applyRenameBatch should never contain an excluded
				// markdown destination. If one slips through, fail loudly in QA mode
				// and tombstone as a production fallback.
				for (const [, newPath] of renames) {
					if (!this.isMarkdownPathSyncable(newPath) && isCrdtDocumentPath(newPath)) {
						const msg = `[BUG] onRenameBatchFlushed: excluded markdown destination reached applyRenameBatch: "${newPath}"`;
						if (this.settings.qaDebugMode) {
							throw new Error(msg);
						}
						this.log(`${msg} — tombstoning as fallback`);
						this.traceSink.recordPath({
							kind: "rename.admission.invariant-failed",
							scope: "file",
							severity: "error",
							path: newPath,
							data: { bug: "excluded-destination-reached-applyRenameBatch" },
						});
						this.reconciliationController.dropDirtyPath(newPath);
					if (vaultSync.getFileId(newPath)) {
						vaultSync.handleDelete(newPath);
						}
					}
				}
			});

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar("loading");
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await vaultSync.waitForLocalPersistence();
			if (!isCurrentInitBlobAuthority()) return;
			if (localLoaded) this.blobLocalPersistenceReady = true;
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);
			await vaultSync.initializeServerAckTracking(this.settings, this.manifest.version, {
				localYjsPersistenceLoaded: localLoaded,
			});
			if (!isCurrentInitBlobAuthority()) return;

			// Schema version check — refuse to run if a newer plugin wrote this data
			const schemaError = vaultSync.checkSchemaVersion();
			if (schemaError) {
				// Stop ticket/connect retries as well as the socket itself. This check
				// can run before the first provider sync, so the later sync handler is
				// not guaranteed to get a chance to disconnect the provider.
				vaultSync.provider.disconnect();
				console.error(`[kaos] ${schemaError}`);
				new Notice(`KAOS: ${schemaError}`);
				this.updateStatusBar("error");
				return;
			}

			// Mark the room's current schema before allowing older clients to rejoin.
			vaultSync.markCurrentSchema(this.settings.deviceName);

			// Check for fatal auth error before waiting for provider
			if (vaultSync.fatalAuthError) {
				this.log("Fatal auth error during startup");
				if (vaultSync.fatalAuthCode === "update_required") {
					this.updateStatusBar("error");
					this.showFatalSyncNotice();
					return;
				}
				this.updateStatusBar("unauthorized");
				this.showFatalSyncNotice();
				// Still reconcile with whatever we have locally
				const mode = vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				return;
			}

			this.updateStatusBar("syncing");
			this.log("Waiting for provider sync...");
			const providerSynced = await vaultSync.waitForProviderSync();
			if (!isCurrentInitBlobAuthority()) return;
			if (providerSynced) this.blobProviderReady = true;
			this.log(`Provider: ${providerSynced ? "synced" : "timed out (offline)"}`);
			this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
			this.log(
				`Startup sync gate: awaitingFirstProviderSyncAfterStartup=${this.awaitingFirstProviderSyncAfterStartup} ` +
				`(gen=${vaultSync.connectionGeneration})`,
			);

			if (vaultSync.fatalAuthError) {
				this.updateStatusBar(vaultSync.fatalAuthCode === "update_required" ? "error" : "unauthorized");
				this.showFatalSyncNotice();
				return;
			}
			if (providerSynced) {
				const postSyncSchemaError = vaultSync.checkSchemaVersion();
				if (postSyncSchemaError) {
					vaultSync.provider.disconnect();
					new Notice(`KAOS: ${postSyncSchemaError}`);
					this.updateStatusBar("error");
					return;
				}
				vaultSync.markCurrentSchema(this.settings.deviceName);
			}

			const mode = vaultSync.getSafeReconcileMode();
			this.log(`Reconciliation mode: ${mode}`);

			await this.runReconciliation(mode);
			if (!isCurrentInitBlobAuthority()) return;
			this.reconciliationController.lastGeneration = vaultSync.connectionGeneration;
			if (providerSynced) {
				this.awaitingFirstProviderSyncAfterStartup = false;
			}

			this.refreshStatusBar();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.attachmentOrchestrator?.markStartupReady("startup-complete");
			void this.traceRuntime?.refreshServerTrace();

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced && this.serverSupportsSnapshots) {
				void this.snapshotService?.triggerDailySnapshot();
				void this.snapshotService?.triggerRecoverySnapshot();
			}
		} catch (err) {
			if (initBlobRuntimeAuthority && !isCurrentInitBlobAuthority()) return;
			console.error("[kaos] Failed to initialize sync:", err);
			new Notice(`KAOS: failed to initialize — ${formatUnknown(err)}`);
			this.updateStatusBar("error");
		}
	}

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		await this.reconciliationController.runReconciliation(mode);
	}

	private async readStableMarkdownFile(
		path: string,
		reason: MarkdownDirtyReason,
	): Promise<StableMarkdownReadResult> {
		const statPath = async (): Promise<{ mtime: number; size: number } | null> => {
			try {
				const stat = await this.app.vault.adapter.stat(path);
				return stat ? { mtime: stat.mtime, size: stat.size } : null;
			} catch {
				return null;
			}
		};
		const sameStat = (
			a: { mtime: number; size: number } | null,
			b: { mtime: number; size: number } | null,
		): boolean => !!a && !!b && a.mtime === b.mtime && a.size === b.size;

		let previous: { mtime: number; size: number } | null = null;
		let stable: { mtime: number; size: number } | null = null;
		for (let i = 0; i < 3; i++) {
			const current = await statPath();
			if (!current) return { kind: "missing" };
			if (sameStat(previous, current)) {
				stable = current;
				break;
			}
			previous = current;
			if (i < 2) {
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
		}

		if (!stable) {
			this.trace("reconcile", "markdown-stable-read-unstable", {
				path,
				reason,
				phase: "pre-read",
			});
			return { kind: "unstable" };
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { kind: "missing" };

		const beforeRead = await statPath();
		if (!sameStat(stable, beforeRead)) {
			this.trace("reconcile", "markdown-stable-read-unstable", {
				path,
				reason,
				phase: "before-read",
			});
			return { kind: "unstable" };
		}

		const content = await this.app.vault.read(file);
		const afterRead = await statPath();
		if (!afterRead) return { kind: "missing" };
		if (!sameStat(beforeRead, afterRead)) {
			this.trace("reconcile", "markdown-stable-read-unstable", {
				path,
				reason,
				phase: "after-read",
			});
			return { kind: "unstable" };
		}

		return { kind: "ready", file, content, stat: afterRead };
	}

	private async importUntrackedFiles(): Promise<void> {
		await this.reconciliationController.importUntrackedFiles();
	}

	private async clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined> {
		if (!this.vaultSync) return;
		const result = await this.vaultSync.clearLocalServerReceiptState();
		this.log(`Cleared local server-receipt state: ${result}`);
		this.scheduleTraceStateSnapshot("clear-local-server-receipt-state");
		this.refreshStatusBar();
		return result;
	}

	// -------------------------------------------------------------------
	// Vault event handlers
	// -------------------------------------------------------------------

	private newOpId(): string {
		return `op-${randomBase64Url(10)}`;
	}

	private registerVaultEvents(): void {
		// Layout change: clean up observers for closed files
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onLayoutChange();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onActiveLeafChange(leaf);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onFileOpen(file?.path ?? null);
				if (!file) return;

				// Prefetch embedded attachments for the opened note
				if (file.path.endsWith(".md") && this.getBlobSync()) {
					this.prefetchEmbeddedAttachments(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciliationController.isReconciled) {
					if (file instanceof TFile && this.isMarkdownPathSyncable(file.path)) {
						this.reconciliationController.noteMarkdownDiskMutation(file.path);
					}
					return;
				}
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					const opId = this.newOpId();
					// Writer attribution for the disk modify event.
					// suppressWindowActive: did KAOS issue a write whose
					// suppression entry is still live at this moment?
					// lastDiskWriteOkAtMs: monotonic ms timestamp of our
					// last successful flushWrite for this path (null if
					// KAOS has never written it this session).
					// writerGuess: a coarse classification combining both.
					// "kaos-write" is high-confidence; "external" is
					// "no suppression active and our last write was either
					// long ago or never"; "unknown" is the fallback when
					// the diskMirror is not yet wired (early-startup race).
						const dm = this.diskMirror;
					const suppressWindowActive = !!dm?.isSuppressed(file.path);
					const lastDiskWriteOkAtMs = dm?.getLastDiskWriteOkAt(file.path) ?? null;
					const dtSinceWrite = lastDiskWriteOkAtMs === null
						? null
						: Date.now() - lastDiskWriteOkAtMs;
					let writerGuess: "kaos-write" | "external" | "unknown";
					if (!dm) {
						writerGuess = "unknown";
					} else if (suppressWindowActive) {
						writerGuess = "kaos-write";
					} else if (dtSinceWrite !== null && dtSinceWrite < 500) {
						// Suppression entry may have expired between vault.modify
						// dispatch and our handler. If our last write was very
						// recent, attribute the modify to KAOS conservatively.
						writerGuess = "kaos-write";
					} else {
						writerGuess = "external";
					}
					this.traceSink.recordPath({
						kind: "disk.modify.observed",
						scope: "file",
						severity: "info",
						opId,
						path: file.path,
						data: {
							size: file.stat?.size ?? null,
							writerGuess,
							suppressWindowActive,
							lastDiskWriteOkAtMs,
							msSinceLastDiskWriteOk: dtSinceWrite,
						},
					});
					this.reconciliationController.markMarkdownDirty(file, "modify", opId);
				} else {
					const blobSync = this.getBlobSync();
					if (blobSync && this.isBlobPathSyncable(file.path) && !blobSync.isSuppressed(file.path)) {
						blobSync.handleFileChange(file);
					}
				}
			}),
		);

		// Rename: apply admission policy BEFORE queueing to ensure
		// applyRenameBatch never receives an excluded markdown destination.
		// Blob renames still go through the batch (blob exclusion is separate).
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (this.attachmentOrchestrator?.consumeRemoteOverwriteBackupRename(file, oldPath)) {
					this.log(
						`Consumed operation-owned attachment backup rename: "${oldPath}" -> "${file.path}"`,
					);
					return;
				}
				const configDir = this.getRuntimeConfig().vaultConfigDir;
				const oldCategory = classifySyncPath({
					path: oldPath,
					excludePatterns: this.excludePatterns,
					configDir,
				});
				const newCategory = classifySyncPath({
					path: file.path,
					excludePatterns: this.excludePatterns,
					configDir,
				});
				const currentTarget = this.app.vault.getAbstractFileByPath(file.path);
				const currentOldPath = this.app.vault.getAbstractFileByPath(oldPath);
				const renameCommit = planRenameEventCommit({
					targetMatchesEventFile: currentTarget === file,
					oldPathIsMissing: currentOldPath === null,
				});
				if (renameCommit.kind === "quarantine-path-collision") {
					if (oldCategory.kind === "markdown") {
						this.reconciliationController.noteMarkdownDiskMutation(oldPath);
						this.diskMirror?.recordPreservedUnresolved(oldPath, "path-collision");
					} else if (oldCategory.kind === "blob") {
						this.getBlobSync()?.recordPreservedUnresolved(oldPath, "path-collision");
					}
					if (newCategory.kind === "markdown") {
						this.reconciliationController.noteMarkdownDiskMutation(file.path);
						this.diskMirror?.recordPreservedUnresolved(file.path, "path-collision");
					} else if (newCategory.kind === "blob") {
						this.getBlobSync()?.recordPreservedUnresolved(file.path, "path-collision");
					}
					this.trace("reconcile", "rename-event-commit-blocked-path-collision", {
						oldPath,
						newPath: file.path,
						reason: renameCommit.reason,
						oldCategory: oldCategory.kind,
						newCategory: newCategory.kind,
						targetMatchesEventFile: currentTarget === file,
						oldPathIsMissing: currentOldPath === null,
					});
					this.log(
						`Rename event fenced (${renameCommit.reason}): ` +
						`"${oldPath}" -> "${file.path}"`,
					);
					return;
				}
				const ownershipRedirect =
					oldCategory.kind === "markdown" || newCategory.kind === "markdown"
						? this.reconciliationController.redirectPendingDirtyPath(oldPath, file.path)
						: { kind: "missing" as const };
				if (ownershipRedirect.kind === "collision") {
					this.reconciliationController.noteMarkdownDiskMutation(oldPath);
					this.reconciliationController.noteMarkdownDiskMutation(file.path);
					this.trace("reconcile", "rename-event-commit-blocked-attention-collision", {
						oldPath,
						newPath: file.path,
						sourceEpisodeId: ownershipRedirect.source.episodeId ?? null,
						targetEpisodeId: ownershipRedirect.target.episodeId ?? null,
					});
					this.log(
						`Rename admission fenced by unresolved episode collision: `
						+ `"${oldPath}" -> "${file.path}"`,
					);
					return;
				}
				if (!this.reconciliationController.isReconciled) {
					this.reconciliationController.noteMarkdownDiskMutation(oldPath);
					this.reconciliationController.noteMarkdownDiskMutation(file.path);
					if (
						oldCategory.kind === "blob"
						&& this.getRuntimeConfig().enableAttachmentSync
					) {
						if (newCategory.kind === "blob") {
							this.recordPendingBlobRename(oldPath, file.path, "pre-reconcile-rename", file);
						} else {
							this.recordPendingBlobDelete(oldPath, "pre-reconcile-rename-left-scope");
						}
					}
					return;
				}
				this.reconciliationController.noteMarkdownDiskMutation(oldPath);
				this.reconciliationController.noteMarkdownDiskMutation(file.path);
				if (this.diskMirror?.consumeRemoteRename(oldPath, file.path, file)) {
					const remoteRename = new Map([[oldPath, file.path]]);
					this.editorWorkspace?.onRenameBatchFlushed(remoteRename);
					moveIndexEntries(this.diskIndex, remoteRename);
					moveCachedHashes(this.blobHashCache, remoteRename);
					moveSettledBlobRefs(this.blobSettledRefs, remoteRename);
					this.scheduleDiskIndexSave("remote-rename");
					this.log(`Consumed remote rename event: "${oldPath}" -> "${file.path}"`);
					return;
				}

				// Classify both paths using canonical path identity.
				// Skip entirely if both are excluded.
				if (oldCategory.kind === "excluded" && newCategory.kind === "excluded") return;

				const renameOpId = this.newOpId();

				// Emit trace events for lineage via TraceSink (both sides).
				if (oldCategory.kind === "markdown" || newCategory.kind === "markdown") {
					this.traceSink.recordPath({
						kind: "rename.observed",
						scope: "file",
						severity: "info",
						opId: renameOpId,
						path: oldPath,
						data: { renameRole: "source", category: oldCategory.kind, opId: renameOpId },
					});
					this.traceSink.recordPath({
						kind: "rename.observed",
						scope: "file",
						severity: "info",
						opId: renameOpId,
						path: file.path,
						data: { renameRole: "target", category: newCategory.kind, opId: renameOpId },
					});
				}

				// Plan the action using the category-aware planner.
				const action = planCategoryRenameAction({ oldCategory, newCategory });

				// Execute the planned action.
				// All paths in actions are displayPath (original runtime paths).
				switch (action.kind) {
					case "queue-markdown-rename":
						this.vaultSync?.queueRename(action.oldPath, action.newPath);
						this.log(`Rename queued (markdown): "${oldPath}" -> "${file.path}"`);
						break;

					case "queue-blob-rename":
						this.commitLocalBlobRename(action.oldPath, file, "vault-rename-event");
						this.log(`Rename committed (blob tombstone+ref): "${oldPath}" -> "${file.path}"`);
						break;

					case "tombstone-markdown":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.vaultSync?.handleDelete(action.oldPath, this.settings.deviceName, renameOpId);
						if (newCategory.kind === "blob") {
							this.getBlobSync()?.handleFileChange(file);
						}
						this.log(`Rename admission: tombstoning markdown "${oldPath}"`);
						break;

					case "admit-markdown":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						if (oldCategory.kind === "blob") {
							this.commitLocalBlobDelete(oldPath, "blob-renamed-to-markdown");
						}
						this.reconciliationController.markMarkdownDirty(file, "create", renameOpId);
						this.log(`Rename admission: admitting markdown "${file.path}"`);
						break;

					case "admit-blob-via-event":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.getBlobSync()?.handleFileChange(file);
						this.log(`Rename admission: admitted blob "${file.path}" explicitly`);
						break;

					case "defer-blob-to-events":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.commitLocalBlobDelete(action.oldPath, "blob-rename-left-sync-scope");
						this.log(`Rename admission: tombstoned blob "${oldPath}" leaving scope`);
						break;

					case "same-identity":
						if (oldCategory.kind === "blob" && newCategory.kind === "blob") {
							this.commitLocalBlobRename(action.oldPath, file, "canonical-blob-rename");
						} else if (
							oldCategory.kind === "markdown"
							&& newCategory.kind === "markdown"
							&& action.oldPath !== action.newPath
						) {
							this.vaultSync?.queueRename(action.oldPath, action.newPath);
						}
						this.log(`Rename admission: same identity (canonical equivalent): "${oldPath}" -> "${file.path}"`);
						break;

					case "ignore":
						break;
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciliationController.isReconciled) {
					if (file instanceof TFile) {
						if (this.isMarkdownPathSyncable(file.path)) {
							this.reconciliationController.noteMarkdownDiskMutation(file.path);
							this.reconciliationController.dropDirtyPath(file.path);
						} else if (
							this.getRuntimeConfig().enableAttachmentSync
							&& this.isBlobPathSyncable(file.path)
						) {
							this.recordPendingBlobDelete(file.path, "pre-reconcile-delete");
						}
					}
					return;
				}
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					this.reconciliationController.noteMarkdownDiskMutation(file.path);
					const opId = this.newOpId();
					const currentOccupant = this.app.vault.getAbstractFileByPath(file.path);
					const deleteCommit = planMarkdownDeleteCommit(
						currentOccupant === null
							? "missing"
							: (currentOccupant instanceof TFile ? "file" : "non-file"),
					);
					const deleteSuppressionConsumed =
						this.diskMirror?.consumeDeleteSuppression(file.path) ?? false;
					if (deleteSuppressionConsumed && deleteCommit.kind === "commit-delete") {
						this.reconciliationController.dropDirtyPath(file.path);
						this.log(`Suppressed delete event for "${file.path}"`);
						this.traceSink.recordPath({
							kind: "disk.event.suppressed",
							scope: "file",
							severity: "debug",
							priority: "important",
							opId,
							path: file.path,
							data: {
								reason: "suppressed-remote-writeback",
								decision: "suppress",
							},
						});
						return;
					}
					if (deleteSuppressionConsumed) {
						this.traceSink.recordPath({
							kind: "disk.event.not_suppressed",
							scope: "file",
							severity: "warn",
							priority: "critical",
							opId,
							path: file.path,
							data: {
								reason: "delete-path-reoccupied",
								decision: "admit-live-occupant",
							},
						});
					}
					const attentionDelete = this.attentionMarkdownDeleteInFlight.get(
						normalizePath(file.path),
					);
					if (attentionDelete === file && deleteCommit.kind === "commit-delete") {
						this.reconciliationController.dropDirtyPath(file.path);
						this.attentionMarkdownDeleteInFlight.delete(normalizePath(file.path));
						this.editorWorkspace?.onMarkdownDeleted(file.path);
						this.traceSink.recordPath({
							kind: "disk.event.suppressed",
							scope: "file",
							severity: "debug",
							priority: "important",
							opId,
							path: file.path,
							data: {
								reason: "dashboard-accept-remote-delete",
								decision: "suppress",
							},
						});
						this.log(`Accepted remote delete locally: "${file.path}"`);
						return;
					}
					if (attentionDelete === file) {
						this.attentionMarkdownDeleteInFlight.delete(normalizePath(file.path));
					}
					this.traceSink.recordPath({
						kind: "disk.delete.observed",
						scope: "file",
						severity: "info",
						priority: "critical",
						opId,
						path: file.path,
					});
					this.reconciliationController.dropDirtyPath(file.path);
					if (
						deleteCommit.kind === "admit-replacement" &&
						currentOccupant instanceof TFile
					) {
						this.reconciliationController.noteMarkdownDiskMutation(file.path);
						this.reconciliationController.markMarkdownDirty(currentOccupant, "create", opId);
						this.trace("reconcile", "markdown-delete-commit-blocked-file-recreated", {
							path: file.path,
							deletedEventFileStillCurrent: currentOccupant === file,
							replacementSize: currentOccupant.stat?.size ?? null,
						});
						this.log(`Delete event fenced; admitted same-path replacement: "${file.path}"`);
						return;
					}
					if (deleteCommit.kind === "quarantine-path-collision") {
						this.editorWorkspace?.onMarkdownDeleted(file.path);
						this.diskMirror?.recordPreservedUnresolved(file.path, "path-collision");
						this.trace("reconcile", "markdown-delete-commit-blocked-path-collision", {
							path: file.path,
							occupantKind: "non-file",
						});
						this.log(`Delete event fenced; path collision quarantined: "${file.path}"`);
						return;
					}
					this.editorWorkspace?.onMarkdownDeleted(file.path);
					this.diskMirror?.clearPreservedUnresolved(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
						opId,
					);
					this.log(`Delete: "${file.path}"`);
					} else {
						if (!this.isBlobPathSyncable(file.path)) return;
						const blobSync = this.getBlobSync();
						const currentOccupant = this.app.vault.getAbstractFileByPath(file.path);
						const deleteCommit = planBlobDeleteCommit(
							currentOccupant === null
								? "missing"
								: (currentOccupant instanceof TFile ? "file" : "non-file"),
						);
						if (
							deleteCommit.kind === "admit-replacement"
							&& currentOccupant instanceof TFile
						) {
							removeCachedHash(this.blobHashCache, normalizePath(file.path));
							blobSync?.admitReplacementAfterStaleDelete(currentOccupant);
							this.persistPendingBlobIntents();
							this.log(`Blob delete event fenced; admitted same-path replacement: "${file.path}"`);
							return;
						}
						if (deleteCommit.kind === "quarantine-path-collision") {
							if (blobSync) {
								blobSync.recordPreservedUnresolved(file.path, "path-collision");
							} else {
								this.recordPersistedBlobUnresolved(file.path, "path-collision");
							}
							this.log(`Blob delete event fenced; path collision quarantined: "${file.path}"`);
							return;
						}
						if (blobSync?.isAcceptingRemoteDelete(file.path)) {
							this.log(`Accepted remote blob delete locally: "${file.path}"`);
							return;
						}
						// Path TTL suppression belongs to create/modify loop prevention. It
						// cannot prove ownership of a delete event: a user can immediately
						// delete a freshly downloaded file while the token is still live. All
						// operation-owned attachment removals use exact rename/Attention tickets,
						// so every ordinary missing-path delete must publish local intent.
						this.commitLocalBlobDelete(file.path, "vault-delete-event");
						this.log(`Delete (blob): "${file.path}"`);
					}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciliationController.isReconciled) {
					if (file instanceof TFile && this.isMarkdownPathSyncable(file.path)) {
						this.reconciliationController.dropDirtyPath(file.path);
						this.reconciliationController.noteMarkdownDiskMutation(file.path);
					}
					return;
				}
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					const createOpId = this.newOpId();
					this.traceSink.recordPath({
						kind: "disk.create.observed",
						scope: "file",
						severity: "info",
						opId: createOpId,
						path: file.path,
						data: { size: file.stat?.size ?? null },
					});
					this.reconciliationController.markMarkdownDirty(file, "create", createOpId);
				} else if (this.isBlobPathSyncable(file.path)) {
					const blobSync = this.getBlobSync();
					if (blobSync && !blobSync.isSuppressed(file.path)) {
						// For blob files, use the same stability check before uploading
						if (this.pendingStabilityChecks.has(file.path)) return;
						this.pendingStabilityChecks.add(file.path);

						void waitForDiskQuiet(this.app, file.path).then((stable) => {
							this.pendingStabilityChecks.delete(file.path);
							if (stable) {
								this.getBlobSync()?.handleFileChange(file);
							} else {
								this.log(`Create (blob): "${file.path}" unstable after timeout, skipping`);
							}
						});
					} else if (!this.serverSupportsAttachments) {
						this.attachmentOrchestrator?.notifyUnsupportedAttachmentCreate();
					}
				}
			}),
		);
	}

	// -------------------------------------------------------------------
	// Teardown + reinit (for reset commands)
	// -------------------------------------------------------------------

	/**
	 * Cleanly tear down all sync state: unbind editors, stop disk mirror,
	 * destroy provider + persistence + ydoc, reset all flags.
	 * After this, the plugin is in the same state as before initSync().
	 */
	private async teardownSync(): Promise<void> {
		this.log("teardownSync: tearing down all sync state");

		// Safe teardown ordering for disk index baseline persistence:
		//   1. Flush all pending disk writes (callbacks fire, hashes recorded in memory)
		//   2. Save disk index to data.json (hashes now current for next startup)
		//   3. Destroy sync state (nothing pending left to flush)
		if (this.diskMirror) {
			await this.diskMirror.flushAllPendingWrites();
		}
		await this.saveDiskIndex();

		this.editorBindings?.unbindAll();
		this.diskMirror?.destroy();

		await this.attachmentOrchestrator?.destroy();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		this.stopSnapshotMaintenanceTimers();
		this.reconciliationController.reset();
		this.connectionController?.stop();

		await this.vaultSync?.destroy();

		this.vaultSync = null;
		this.connectionController = null;
		this.editorBindings = null;
		this.diskMirror = null;
		this.awaitingFirstProviderSyncAfterStartup = false;
		this.blobLocalPersistenceReady = false;
		this.blobProviderReady = false;
		this.editorWorkspace?.reset();
		this.idbDegradedHandled = false;

		this.updateStatusBar("disconnected");
	}

	private resetLocalCache(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const vaultId = this.settings.vaultId;
		new ConfirmModal(
			this.app,
			"Reset local cache",
			"This will clear the local IndexedDB cache and re-sync from the server. " +
			"Your disk files and server state are not affected. Continue?",
			async () => {
				this.log("Reset cache: starting");
				new Notice("Clearing cache and syncing again...");

				await this.teardownSync();

				try {
					await VaultSync.deleteIdb(vaultId);
					this.log("Reset cache: IDB deleted");
				} catch (err) {
					console.error("[kaos] Failed to delete IDB:", err);
				}

				this.log("Reset cache: reinitializing");
				await this.initSync();
				new Notice("Cache reset complete.");
			},
		).open();
	}

	private nuclearReset(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const pathCount = this.vaultSync.getActiveMarkdownPaths().length;
		new ConfirmModal(
			this.app,
			"Nuclear reset",
			`This will wipe all CRDT state (${pathCount} files) on both this device and the server, ` +
			`clear the local cache, then re-seed everything from your current disk files. ` +
			`Other connected devices will also see the reset. This cannot be undone. Continue?`,
			async () => {
				this.blobAuthorityResetInProgress = true;
				try {
					const resetActivation = this.activateBlobAuthorityScope(
						"nuclear-reset",
						this.getBlobIntentScope(),
						{ force: true, detachStores: false },
					);
					this.log("Nuclear reset: starting");
					new Notice("Nuclear reset in progress...");

					// Clear CRDT maps only after the forced epoch has synchronously made
					// every older blob load/save/replay completion stale.
					const counts = this.vaultSync!.clearAllMaps();
					this.log(
						`Nuclear reset: cleared ${counts.pathCount} paths, ` +
						`${counts.idCount} texts, ${counts.metaCount} meta, ` +
						`${counts.blobCount} blob paths`,
					);

					await new Promise((r) => setTimeout(r, 500));
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;

					const vaultId = this.settings.vaultId;
					await this.teardownSync();
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;

					// Never replace either global tail. Wait until the exact old lanes are
					// stable, then clear their records. Their callbacks retain the previous
					// epoch and therefore cannot reopen health after this reset.
					if (!await this.waitForStablePendingBlobIntentTail(resetActivation.token)) return;
					if (!await this.waitForStableBlobSettledRefTail(resetActivation.token)) return;
					const resetScope = resetActivation.scope;
					const pendingIntentStoreKey = resetScope.host
						&& resetScope.vaultId
						&& resetScope.localDeviceId
						? buildPendingBlobIntentStoreKey(resetScope)
						: null;
					const settledRefStoreKey = resetScope.host
						&& resetScope.vaultId
						&& resetScope.localDeviceId
						? buildBlobSettledRefStoreKey(resetScope)
						: null;

					if (this.pendingBlobIntentStore) {
						await this.pendingBlobIntentStore.clear();
					} else if (pendingIntentStoreKey) {
						await new IndexedDbPendingBlobIntentStore(resetScope).clear();
					}
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;
					if (this.blobSettledRefStore) {
						await this.blobSettledRefStore.clear();
					} else if (settledRefStoreKey) {
						await new IndexedDbBlobSettledRefStore(resetScope).clear();
					}
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;

					if (pendingIntentStoreKey) {
						this.corruptPendingBlobIntentStoreKeys.delete(pendingIntentStoreKey);
					}
					if (settledRefStoreKey) {
						this.corruptBlobSettledRefStoreKeys.delete(settledRefStoreKey);
					}
					this.pendingBlobIntentStore = null;
					this.pendingBlobIntentStoreKey = null;
					this.blobSettledRefStore = null;
					this.blobSettledRefStoreKey = null;
					this.pendingBlobIntentPersistenceHealthy = false;
					this.blobSettledRefPersistenceHealthy = false;
					this.pendingBlobIntents.clear();
					this.pendingBlobRenameFiles.clear();
					this.replayedCommittedBlobIntentIds.clear();
					this.legacyMissingBlobPaths.clear();
					this.savedBlobQueue = null;
					this.preservedUnresolvedEntries = [];
					this.attachmentOrchestrator?.hydrateSavedQueue(null);
					await this.persistPluginState((state) => {
						delete state._blobSettledRefs;
						delete state._blobSettledRefsByDevice;
						delete state._blobQueue;
						delete state._pendingBlobIntents;
						delete state._preservedUnresolved;
					});
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;

					try {
						await VaultSync.deleteIdb(vaultId);
						this.log("Nuclear reset: IDB deleted");
					} catch (err) {
						console.error("[kaos] Failed to delete IDB:", err);
					}
					if (!this.isCurrentBlobAuthority(resetActivation.token)) return;
				} finally {
					this.blobAuthorityResetInProgress = false;
				}

				this.log("Nuclear reset: reinitializing (will re-seed from disk)");
				await this.initSync();
				new Notice(
					`KAOS: nuclear reset complete. ` +
					`Re-seeded ${this.vaultSync?.getActiveMarkdownPaths().length ?? 0} files from disk.`,
				);
			},
		).open();
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	private startSnapshotMaintenanceTimers(): void {
		if (!this.recoverySnapshotInterval) {
			this.recoverySnapshotInterval = setInterval(() => {
				if (!this.vaultSync?.connected || !this.vaultSync.providerSynced || !this.serverSupportsSnapshots) {
					return;
				}
				void this.snapshotService?.triggerRecoverySnapshot();
			}, RECOVERY_SNAPSHOT_INTERVAL_MS);
		}

		if (!this.crdtSnapshotInterval) {
			this.crdtSnapshotInterval = setInterval(() => {
				if (!this.vaultSync?.connected || !this.vaultSync.providerSynced || !this.serverSupportsSnapshots) {
					return;
				}
				void this.snapshotService?.triggerDailySnapshot();
			}, CRDT_SNAPSHOT_INTERVAL_MS);
		}
	}

	private stopSnapshotMaintenanceTimers(): void {
		if (this.recoverySnapshotInterval) {
			clearInterval(this.recoverySnapshotInterval);
			this.recoverySnapshotInterval = null;
		}
		if (this.crdtSnapshotInterval) {
			clearInterval(this.crdtSnapshotInterval);
			this.crdtSnapshotInterval = null;
		}
	}

	/**
	 * When a note opens, parse its embedded links (![[...]]) via Obsidian's
	 * metadata cache and prefetch any missing blob attachments from R2.
	 * This ensures images/PDFs render immediately rather than waiting for
	 * the next reconcile or CRDT observer to trigger the download.
	 */
	private prefetchEmbeddedAttachments(file: TFile): void {
		const blobSync = this.getBlobSync();
		if (!blobSync) return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.embeds) return;

		const pathsToFetch: string[] = [];

		for (const embed of cache.embeds) {
			// Resolve the link to an actual vault path.
			// getFirstLinkpathDest handles relative paths, aliases, etc.
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				embed.link,
				file.path,
			);

			if (resolved) {
				// File already exists on disk — skip
				continue;
			}

			// File doesn't exist on disk. Try to find it in the CRDT blob map.
			// The link could be just a filename (e.g. "image.png") or a path.
			// Check both the raw link text and common attachment patterns.
			const linkPath = (embed.link.split("#")[0] ?? "").split("|")[0] ?? ""; // strip anchors/aliases

			// Search pathToBlob for a matching path
			let blobPath: string | null = null;
			this.vaultSync?.pathToBlob.forEach((_ref, candidatePath) => {
				if (blobPath) return; // already found
				// Exact match
				if (candidatePath === linkPath) {
					blobPath = candidatePath;
					return;
				}
				// Filename-only match (Obsidian's default "shortest path" mode)
				const candidateFilename = candidatePath.split("/").pop();
				if (candidateFilename === linkPath) {
					blobPath = candidatePath;
				}
			});

			if (blobPath) {
				pathsToFetch.push(blobPath);
			}
		}

		if (pathsToFetch.length > 0) {
			const queued = blobSync.prioritizeDownloads(pathsToFetch);
			if (queued > 0) {
				this.log(`prefetch: queued ${queued} attachments for "${file.path}"`);
			}
		}
	}

	private shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean {
		return this.frontmatterGuardCoordinator.shouldBlockFrontmatterIngest(
			path, previousContent, nextContent, reason,
		);
	}

	private handleFrontmatterValidation(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
	): void {
		this.frontmatterGuardCoordinator.handleFrontmatterValidation(
			path, direction, reason, validation, previousContent, nextContent,
		);
	}

	/**
	 * Toggle remote cursor visibility via a CSS class on the document body.
	 * The actual cursor styles from y-codemirror.next are hidden when the
	 * class is absent; we add it when showRemoteCursors is true.
	 */
	applyCursorVisibility(): void {
		document.body.toggleClass(
			"vault-crdt-show-cursors",
			this.settings.showRemoteCursors,
		);
	}

	private refreshStatusBar(): void {
		const state = this.computeSyncStatus();
		if (state === "error" && this.vaultSync?.idbError) {
			this.handleIndexedDbDegraded("status-check");
		}
		this.updateStatusBar(state);
	}

	private computeSyncStatus(): SyncStatus {
		if (this.vaultSync?.idbError) {
			return "error";
		}
		if (
			this.settings.enableAttachmentSync
			&& !!this.settings.host
			&& (
				!this.pendingBlobIntentPersistenceHealthy
				|| !this.blobSettledRefPersistenceHealthy
			)
		) return "error";

		return this.syncStatusFromConnectionState(this.connectionController?.getState() ?? { kind: "disconnected" });
	}

	private syncStatusFromConnectionState(state: ConnectionState): SyncStatus {
		switch (state.kind) {
			case "disconnected":
				return "disconnected";
			case "loading_cache":
				return "loading";
			case "connecting":
				return "syncing";
			case "online":
				return "connected";
			case "offline":
				return "offline";
			case "auth_failed":
				return "unauthorized";
			case "server_update_required":
				return "error";
		}
	}

	getSettingsStatusSummary(): { state: SyncStatus; label: string } {
		const state = this.computeSyncStatus();
		return {
			state,
			label: getSyncStatusLabel(state).replace(/^CRDT:\s*/, ""),
		};
	}

	private async collectDashboardData(): Promise<KaosDashboardData> {
		const connection = this.getDashboardConnectionSummary();
		const status = this.getSettingsStatusSummary();
		const snapshotStatus = this.snapshotService
			? await this.snapshotService.getDashboardSnapshotStatus()
			: { status: "unavailable" as const, message: "Snapshot service not initialized." };
		const recentChanges = this.snapshotService
			? await this.snapshotService.getDashboardRecentChanges()
			: {
				status: "unavailable" as const,
				message: "File history service not initialized.",
				lastAttempt: null,
			};
		const recoveryStorageStatus = this.snapshotService
			? await this.snapshotService.getDashboardRecoveryStorageStatus()
			: { status: "unavailable" as const, message: "File history storage service not initialized." };
		const vaultSync = this.vaultSync;
		const blobSync = this.getBlobSync();
		return buildKaosDashboardData({
			app: this.app,
			generatedAt: new Date().toISOString(),
			settings: {
				deviceName: this.settings.deviceName || "unknown-device",
				vaultId: this.settings.vaultId || "unknown-vault",
				attachmentSyncEnabled: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
			syncStatusLabel: status.label,
			connectionLabel: connection.label,
			connectionTone: connection.tone,
			reconciliationState: this.reconciliationController.getState(),
			vaultSync: this.vaultSync?.getDebugSnapshot() ?? null,
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.getBlobSync()?.getDebugSnapshot() ?? null,
			preservedUnresolvedEntries: this.collectPreservedUnresolvedEntries(),
			remoteDeleteResolutionState: {
				markdownAvailable: vaultSync !== null && this.diskMirror !== null,
				blobAvailable: vaultSync !== null && blobSync !== null,
				getFingerprint: (kind, path) => kind === "markdown"
					? vaultSync?.getAuthoritativeMarkdownDeleteSnapshot(path)?.fingerprint ?? null
					: vaultSync?.getAuthoritativeBlobDeleteSnapshot(path)?.fingerprint ?? null,
				isKeepLocalPending: (kind, path, episodeId) => kind === "blob"
					&& blobSync?.isKeepLocalRemoteDeletePending(path, episodeId) === true,
				getBlobRef: (path) => cloneBlobRef(vaultSync?.getBlobRef(path)) ?? null,
			},
			frontmatterQuarantineEntries: this.frontmatterQuarantineEntries,
			diskIndex: this.diskIndex,
			snapshotStatus,
			recoveryStorageStatus,
			recentChanges,
			openFileCount: this.editorWorkspace?.openFileCount ?? 0,
			snapshotsAvailable: this.serverSupportsSnapshots,
		});
	}

	private async resolveLegacyMissingBlobAttention(
		target: DashboardLegacyMissingBlobResolutionTarget,
		choice: DashboardLegacyMissingBlobResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult> {
		const normalizedTarget: DashboardLegacyMissingBlobResolutionTarget = {
			...target,
			path: normalizePath(target.path),
		};
		return withAttentionResolutionLock(
			this.attentionResolutionInFlight,
			`blob:${normalizedTarget.path}`,
			normalizedTarget.path,
			async () => {
				this.getCurrentLegacyMissingBlobAttention(normalizedTarget);
				this.assertDashboardLocalFileIdentity(normalizedTarget);
				if (normalizedTarget.localFile.kind !== "missing") {
					throw new Error(`Local attachment path is no longer absent: ${normalizedTarget.path}`);
				}
				const vaultSync = this.vaultSync;
				const blobSync = this.getBlobSync();
				if (!vaultSync || !blobSync) {
					throw new Error("Attachment sync is not initialized.");
				}
				if (
					!vaultSync.providerSynced
					|| !this.blobProviderReady
					|| !this.blobLocalPersistenceReady
					|| !this.blobSettledRefPersistenceHealthy
				) {
					throw new Error("Attachment authority is still initializing. Try again after sync is ready.");
				}
				const currentRef = cloneBlobRef(vaultSync.getBlobRef(normalizedTarget.path));
				if (
					vaultSync.isBlobTombstoned(normalizedTarget.path)
						? normalizedTarget.remoteRef !== null
						: !sameBlobRef(currentRef, normalizedTarget.remoteRef ?? undefined)
				) {
					throw new Error(`Remote attachment changed for "${normalizedTarget.path}". Refresh the dashboard.`);
				}

				if (choice === "download-remote") {
					if (!currentRef || normalizedTarget.remoteRef === null) {
						throw new Error(`Remote attachment no longer exists: ${normalizedTarget.path}`);
					}
					await this.clearBlobSettlementFenceForExplicitResolution(
						normalizedTarget.path,
						vaultSync,
					);
					blobSync.acceptLegacyMissingRemoteBlob(
						normalizedTarget.path,
						normalizedTarget.episodeId,
						currentRef,
					);
					const queueScope = this.attachmentOrchestrator?.getQueuePersistenceScope(blobSync);
					if (!queueScope) throw new Error("Attachment queue authority scope is unavailable.");
					await this.persistBlobQueueSnapshot(blobSync.exportQueue(), queueScope);
					await this.persistPluginState();
					return { status: "completed" };
				}

				if (!currentRef) {
					await this.clearBlobSettlementFenceForExplicitResolution(
						normalizedTarget.path,
						vaultSync,
					);
					await this.setLegacyMissingBlobQuarantine(normalizedTarget.path, false);
					blobSync.clearPreservedUnresolved(normalizedTarget.path);
					await this.persistPluginState();
					return { status: "completed" };
				}
				const scope = this.getBlobIntentScope();
				if (
					!scope.host
					|| !scope.vaultId
					|| !scope.localDeviceId
					|| !this.pendingBlobIntentPersistenceHealthy
				) {
					throw new Error("Local attachment intent journal is unavailable.");
				}
				if (this.pendingBlobIntents.hasPath(normalizedTarget.path, scope)) {
					throw new Error(`Another local attachment mutation is already pending: ${normalizedTarget.path}`);
				}
				const before = this.pendingBlobIntents.getEntries();
				const expectedSourceVersion = this.vaultSync?.getBlobSourceVersion(
					normalizedTarget.path,
				);
				if (!expectedSourceVersion) {
					throw new Error("Exact attachment source episode is unavailable.");
				}
				const intent = this.pendingBlobIntents.recordDelete(
					normalizedTarget.path,
					scope,
					{
						known: true,
						ref: currentRef,
						sourceVersionKnown: true,
						expectedSourceVersion,
					},
				);
				try {
					await this.enqueuePendingBlobIntentPersistence();
				} catch (err) {
					this.pendingBlobIntents.hydrate(before);
					throw err;
				}
				// The exact delete intent is durable before the retirement fence is
				// cleared. A crash between these steps therefore cannot turn the user's
				// explicit Keep absence choice into a first-time remote download.
				await this.clearBlobSettlementFenceForExplicitResolution(
					normalizedTarget.path,
					vaultSync,
				);
				await this.replayPendingBlobIntents("legacy-upgrade-keep-local-absence");
				const committed = this.pendingBlobIntents.getEntries(scope).find(
					(candidate) => candidate.id === intent.id,
				)?.committedAt !== undefined;
				if (!committed) {
					throw new Error(
						`The exact remote attachment could not be deleted safely: ${normalizedTarget.path}`,
					);
				}
				await this.setLegacyMissingBlobQuarantine(normalizedTarget.path, false);
				blobSync.clearPreservedUnresolved(normalizedTarget.path);
				await this.persistPluginState();
				return {
					status: "pending",
					message: `Keeping local absence; the exact delete is waiting for a durable server receipt: ${normalizedTarget.path}`,
				};
			},
		);
	}

	private getCurrentLegacyMissingBlobAttention(
		target: DashboardLegacyMissingBlobResolutionTarget,
	): PreservedUnresolvedEntry {
		const current = this.collectPreservedUnresolvedEntries().find((entry) =>
			entry.kind === "blob" && normalizePath(entry.path) === target.path
		);
		if (
			!current
			|| current.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON
			|| getPreservedUnresolvedEpisodeId(current) !== target.episodeId
			|| !this.legacyMissingBlobPaths.has(target.path)
		) {
			throw new Error(`Attention state changed for "${target.path}". Refresh the dashboard.`);
		}
		return current;
	}

	private async resolveRemoteDeleteAttention(
		target: DashboardRemoteDeleteResolutionTarget,
		choice: DashboardRemoteDeleteResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult> {
		const normalizedTarget: DashboardRemoteDeleteResolutionTarget = {
			...target,
			path: normalizePath(target.path),
		};
		const lockKey = `${normalizedTarget.fileKind}:${normalizedTarget.path}`;
		return withAttentionResolutionLock(
			this.attentionResolutionInFlight,
			lockKey,
			normalizedTarget.path,
			async () => {
			this.getCurrentRemoteDeleteAttention(normalizedTarget);
			this.assertRemoteDeleteFingerprint(normalizedTarget);
			this.assertDashboardLocalFileIdentity(normalizedTarget);
			const committedBlobIntentResolution = normalizedTarget.fileKind === "blob"
				? this.captureCommittedBlobIntentResolution(normalizedTarget)
				: null;

			if (choice === "keep-local") {
				if (normalizedTarget.fileKind === "markdown") {
					await this.reconciliationController.keepLocalRemoteDeletedMarkdown(
						normalizedTarget.path,
						normalizedTarget.reason,
						{
							reason: normalizedTarget.reason,
							episodeId: normalizedTarget.episodeId,
							remoteDeleteFingerprint: normalizedTarget.remoteDeleteFingerprint ?? undefined,
							localFile: normalizedTarget.localFile,
						},
					);
					await this.persistPluginState();
					return { status: "completed" };
				}

				const blobSync = this.getBlobSync();
				if (!blobSync) throw new Error("Attachment sync is not initialized.");
				const blobQueuePersistenceScope =
					this.attachmentOrchestrator?.getQueuePersistenceScope(blobSync);
				if (!blobQueuePersistenceScope) {
					throw new Error("Attachment queue authority scope is unavailable.");
				}
				if (blobSync.isKeepLocalRemoteDeletePending(
					normalizedTarget.path,
					normalizedTarget.episodeId,
				)) {
					await this.persistBlobQueueSnapshot(
						blobSync.exportQueue(),
						blobQueuePersistenceScope,
					);
					await this.supersedeCommittedBlobIntentsForResolution(
						committedBlobIntentResolution,
						normalizedTarget,
					);
					return {
						status: "pending",
						message: `The local attachment is already being published: ${normalizedTarget.path}`,
					};
				}
				blobSync.keepLocalRemoteDeletedBlob(
					normalizedTarget.path,
					normalizedTarget.reason,
					{
						episodeId: normalizedTarget.episodeId,
						remoteDeleteFingerprint: normalizedTarget.remoteDeleteFingerprint ?? undefined,
					},
				);
				await this.persistBlobQueueSnapshot(
					blobSync.exportQueue(),
					blobQueuePersistenceScope,
				);
				const completed = !blobSync.isPreservedUnresolved(normalizedTarget.path);
				const pending = blobSync.isKeepLocalRemoteDeletePending(
					normalizedTarget.path,
					normalizedTarget.episodeId,
				);
				if (!completed && !pending) {
					throw new Error(`The local attachment could not be queued: ${normalizedTarget.path}`);
				}
				await this.supersedeCommittedBlobIntentsForResolution(
					committedBlobIntentResolution,
					normalizedTarget,
				);
				if (completed) return { status: "completed" };
				return {
					status: "pending",
					message: `Publishing local attachment; Attention will clear after upload succeeds: ${normalizedTarget.path}`,
				};
			}

			if (normalizedTarget.fileKind === "markdown") {
				const lease = await this.reconciliationController.beginAcceptRemoteDeletedMarkdown(
					normalizedTarget.path,
					normalizedTarget.reason,
					{
						reason: normalizedTarget.reason,
						episodeId: normalizedTarget.episodeId,
						remoteDeleteFingerprint: normalizedTarget.remoteDeleteFingerprint ?? undefined,
						localFile: normalizedTarget.localFile,
					},
				);
				try {
					this.getCurrentRemoteDeleteAttention(normalizedTarget);
					this.assertRemoteDeleteFingerprint(normalizedTarget);
					this.assertDashboardLocalFileIdentity(normalizedTarget);
					// The lease was fenced before its stable read, but a Base/file view
					// can open while the dashboard action is in flight. Recheck at the
					// destructive boundary so opaque view state is never trashed.
					this.reconciliationController.assertNoOpaqueOpenFileViewForRemoteDelete(
						normalizedTarget.path,
					);
					const file = this.app.vault.getAbstractFileByPath(normalizedTarget.path);
					if (file instanceof TFile) {
						this.attentionMarkdownDeleteInFlight.set(normalizedTarget.path, file);
						let trashSucceeded = false;
						try {
							await this.app.fileManager.trashFile(file);
							trashSucceeded = true;
						} finally {
							if (!trashSucceeded) {
								this.attentionMarkdownDeleteInFlight.delete(normalizedTarget.path);
							} else if (this.attentionMarkdownDeleteInFlight.get(normalizedTarget.path) === file) {
								// Obsidian normally emits delete before trashFile resolves. Keep
								// ownership briefly for adapters that dispatch the event later.
								setTimeout(() => {
									if (this.attentionMarkdownDeleteInFlight.get(normalizedTarget.path) === file) {
										this.attentionMarkdownDeleteInFlight.delete(normalizedTarget.path);
									}
								}, 1_000);
							}
						}
					}
					if (this.app.vault.getAbstractFileByPath(normalizedTarget.path)) {
						throw new Error(`Local file was not deleted: ${normalizedTarget.path}`);
					}
					await this.clearPreservedUnresolvedAttention(normalizedTarget);
					return { status: "completed" };
				} finally {
					this.reconciliationController.finishRemoteDeletedMarkdownResolution(lease);
				}
			}

			const blobSync = this.getBlobSync();
			if (!blobSync) throw new Error("Attachment sync is not initialized.");
			const blobQueuePersistenceScope =
				this.attachmentOrchestrator?.getQueuePersistenceScope(blobSync);
			if (!blobQueuePersistenceScope) {
				throw new Error("Attachment queue authority scope is unavailable.");
			}
			await blobSync.acceptRemoteDeletedBlob(
				normalizedTarget.path,
				normalizedTarget.reason,
				async (file) => {
					this.getCurrentRemoteDeleteAttention(normalizedTarget);
					this.assertRemoteDeleteFingerprint(normalizedTarget);
					this.assertDashboardLocalFileIdentity(normalizedTarget, file);
					await this.app.fileManager.trashFile(file);
				},
				{
					episodeId: normalizedTarget.episodeId,
					remoteDeleteFingerprint: normalizedTarget.remoteDeleteFingerprint ?? undefined,
				},
				async (snapshot) => {
					if (snapshot.uploads.length === 0 && snapshot.downloads.length === 0) {
						await this.clearSavedBlobQueue();
					} else {
						await this.persistBlobQueueSnapshot(
							snapshot,
							blobQueuePersistenceScope,
						);
					}
				},
			);
			const queueAfterAccept = blobSync.exportQueue();
			if (queueAfterAccept.uploads.length === 0 && queueAfterAccept.downloads.length === 0) {
				await this.clearSavedBlobQueue();
			} else {
				await this.persistBlobQueueSnapshot(
					queueAfterAccept,
					blobQueuePersistenceScope,
				);
			}
			await this.supersedeCommittedBlobIntentsForResolution(
				committedBlobIntentResolution,
				normalizedTarget,
			);
			await this.persistPluginState();
			return { status: "completed" };
			},
		);
	}

	private captureCommittedBlobIntentResolution(
		target: DashboardRemoteDeleteResolutionTarget,
	): {
		path: string;
		episodeId: string;
		remoteDeleteFingerprint: string;
		intentIds: string[];
	} | null {
		const remoteDeleteFingerprint = target.remoteDeleteFingerprint;
		if (!remoteDeleteFingerprint) return null;
		const scope = this.getBlobIntentScope();
		const normalized = normalizePath(target.path);
		const intentIds = this.pendingBlobIntents.getEntries(scope).filter((intent) =>
			intent.committedAt !== undefined
			&& normalizePath(intent.kind === "delete" ? intent.path : intent.oldPath)
				=== normalized
			&& intent.commitDeleteFingerprint === remoteDeleteFingerprint
		).map((intent) => intent.id);
		return intentIds.length > 0 ? {
			path: normalized,
			episodeId: target.episodeId,
			remoteDeleteFingerprint,
			intentIds,
		} : null;
	}

	private async supersedeCommittedBlobIntentsForResolution(
		token: {
			path: string;
			episodeId: string;
			remoteDeleteFingerprint: string;
			intentIds: string[];
		} | null,
		target: DashboardRemoteDeleteResolutionTarget,
	): Promise<void> {
		if (!token) return;
		if (
			token.path !== normalizePath(target.path)
			|| token.episodeId !== target.episodeId
			|| token.remoteDeleteFingerprint !== target.remoteDeleteFingerprint
		) {
			throw new Error(`Attention state changed for "${target.path}". Refresh the dashboard.`);
		}
		const ids = new Set(token.intentIds);
		const removable = this.pendingBlobIntents.getEntries().filter((intent) =>
			ids.has(intent.id)
			&& intent.committedAt !== undefined
			&& intent.commitDeleteFingerprint === token.remoteDeleteFingerprint
			&& normalizePath(intent.kind === "delete" ? intent.path : intent.oldPath)
				=== token.path
		);
		if (removable.length === 0) return;
		for (const intent of removable) {
			this.pendingBlobIntents.remove(intent.id);
			this.pendingBlobRenameFiles.delete(intent.id);
			this.replayedCommittedBlobIntentIds.delete(intent.id);
		}
		try {
			await this.enqueuePendingBlobIntentPersistence();
		} catch (err) {
			const current = this.pendingBlobIntents.getEntries();
			const currentIds = new Set(current.map((intent) => intent.id));
			this.pendingBlobIntents.hydrate([
				...current,
				...removable.filter((intent) => !currentIds.has(intent.id)),
			]);
			throw err;
		}
		this.trace("blob", "committed-blob-intents-superseded-by-explicit-resolution", {
			path: token.path,
			episodeId: token.episodeId,
			remoteDeleteFingerprint: token.remoteDeleteFingerprint,
			count: removable.length,
		});
	}

	private async clearPreservedUnresolvedAttention(
		target: DashboardRemoteDeleteResolutionTarget,
	): Promise<void> {
		const current = this.collectPreservedUnresolvedEntries().find((entry) =>
			normalizePath(entry.path) === target.path && entry.kind === target.fileKind
		);
		if (current) {
			this.getCurrentRemoteDeleteAttention(target);
		}
		this.assertRemoteDeleteFingerprint(target);
		if (target.fileKind === "markdown") {
			this.diskMirror?.clearPreservedUnresolved(target.path);
		} else {
			this.getBlobSync()?.clearPreservedUnresolved(target.path);
		}
		this.preservedUnresolvedEntries = this.preservedUnresolvedEntries.filter(
			(entry) => normalizePath(entry.path) !== target.path
				|| entry.kind !== target.fileKind
				|| getPreservedUnresolvedEpisodeId(entry) !== target.episodeId,
		);
		await this.persistPluginState();
		this.refreshStatusBar();
	}

	private getCurrentRemoteDeleteAttention(
		target: DashboardRemoteDeleteResolutionTarget,
	): PreservedUnresolvedEntry {
		const current = this.collectPreservedUnresolvedEntries().find((entry) =>
			normalizePath(entry.path) === target.path && entry.kind === target.fileKind
		);
		if (!current) {
			throw new Error(`Attention entry is no longer active for "${target.path}".`);
		}
		if (
			current.reason !== target.reason
			|| !isRemoteDeletePreservedUnresolvedEntry(current)
			|| getPreservedUnresolvedEpisodeId(current) !== target.episodeId
		) {
			throw new Error(`Attention state changed for "${target.path}". Refresh the dashboard.`);
		}
		return current;
	}

	private assertRemoteDeleteFingerprint(
		target: DashboardRemoteDeleteResolutionTarget,
	): void {
		const vaultSync = this.vaultSync;
		if (!vaultSync) throw new Error("Sync is not initialized.");
		if (target.remoteDeleteFingerprint === null) {
			throw new Error(`Remote deletion is no longer authoritative for "${target.path}".`);
		}
		const currentFingerprint = target.fileKind === "markdown"
			? vaultSync.getAuthoritativeMarkdownDeleteSnapshot(target.path)?.fingerprint ?? null
			: vaultSync.getAuthoritativeBlobDeleteSnapshot(target.path)?.fingerprint ?? null;
		if (currentFingerprint !== target.remoteDeleteFingerprint) {
			throw new Error(`Remote deletion changed for "${target.path}". Refresh the dashboard.`);
		}
	}

	private getDashboardLocalFileIdentity(path: string): DashboardLocalFileIdentity {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) return { kind: "missing", mtime: null, size: null };
		if (!(file instanceof TFile)) return { kind: "other", mtime: null, size: null };
		return {
			kind: "file",
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
	}

	private assertDashboardLocalFileIdentity(
		target: Pick<DashboardRemoteDeleteResolutionTarget, "path" | "localFile">,
		knownFile?: TFile,
	): void {
		const actual = knownFile
			? {
				kind: "file" as const,
				mtime: knownFile.stat.mtime,
				size: knownFile.stat.size,
			}
			: this.getDashboardLocalFileIdentity(target.path);
		if (
			actual.kind !== target.localFile.kind
			|| actual.mtime !== target.localFile.mtime
			|| actual.size !== target.localFile.size
		) {
			throw new Error(`Local file changed since the dashboard was opened: ${target.path}`);
		}
		if (actual.kind === "other") {
			throw new Error(`Attention path is not a file: ${target.path}`);
		}
	}

	private getDashboardConnectionSummary(): { label: string; tone: DashboardTone } {
		const state = this.connectionController?.getState();
		if (!state) return { label: "not initialized", tone: "muted" };
		switch (state.kind) {
			case "online":
				return { label: "online", tone: "ok" };
			case "connecting":
			case "loading_cache":
				return { label: state.kind, tone: "busy" };
			case "disconnected":
			case "offline":
				return { label: state.kind, tone: "warn" };
			case "auth_failed":
			case "server_update_required":
				return { label: state.kind, tone: "error" };
		}
	}

	private updateStatusBar(_coarseState: SyncStatus): void {
		if (!this.statusBarEl) return;
		const connectionState = this.connectionController?.getState();
		const transferStatus = this.getBlobSync()?.transferStatus;
		const attentionCount = getDashboardAttentionTotalCount({
			preservedUnresolvedEntries: this.collectPreservedUnresolvedEntries(),
			frontmatterQuarantineEntries: this.frontmatterQuarantineEntries,
			reconciliationState: this.reconciliationController.getState(),
		});
		const vaultSync = this.vaultSync;
		const serverReceipt = vaultSync ? {
			serverAppliedLocalState: vaultSync.serverAppliedLocalState,
			lastServerReceiptEchoAt: vaultSync.lastServerReceiptEchoAt,
			lastKnownServerReceiptEchoAt: vaultSync.lastKnownServerReceiptEchoAt,
			candidatePersistenceHealthy: vaultSync.candidatePersistenceHealthy,
			serverReceiptStartupValidation: vaultSync.serverReceiptStartupValidation,
		} : null;
		if (connectionState) {
			renderConnectionState(this.statusBarEl, connectionState, transferStatus, serverReceipt, attentionCount);
		} else {
			renderSyncStatus(this.statusBarEl, _coarseState, transferStatus, attentionCount);
		}
	}

	private buildFilesNeedingAttentionText(): string {
		const entries = this.collectPreservedUnresolvedEntries()
			.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
		const structural = this.reconciliationController.getState().unresolvedStructuralChangeSample;
		if (entries.length === 0 && structural.length === 0) return "No files currently need attention.";
		const preservedText = entries.map((entry) => [
			entry.path,
			`  kind: ${entry.kind}`,
			`  reason: ${entry.reason}`,
			`  first seen: ${new Date(entry.firstSeenAt).toLocaleString()}`,
			`  last seen: ${new Date(entry.lastSeenAt).toLocaleString()}`,
			isRemoteDeletePreservedUnresolvedEntry(entry)
				? "  suggested action: open the dashboard, inspect the file, then choose Keep local file or Accept remote delete."
				: "  suggested action: inspect the local file and conflict artifacts before resolving the underlying conflict.",
		].join("\n"));
		const structuralText = structural.map((entry, idx) => [
			`Structural change ${idx + 1}`,
			`  kind: markdown-structural-change`,
			`  reason: ${entry.reason}`,
			`  old paths: ${entry.oldPaths.join(", ") || "(none)"}`,
			`  new paths: ${entry.newPaths.join(", ") || "(none)"}`,
			`  content hash: ${entry.contentHashPrefix}`,
			"  suggested action: inspect the old/new paths, then manually rename or edit/save the intended file.",
		].join("\n"));
		return [...preservedText, ...structuralText].join("\n\n");
	}

	private setupTraceRuntime(): void {
		this.traceRuntime = new TraceRuntimeController({
			app: this.app,
			getSettings: () => this.settings,
			buildSnapshot: (reason, recentServerTrace) =>
				this.buildTraceStateSnapshot(reason, recentServerTrace),
			isIndexedDbRelatedError: (err) => this.isIndexedDbRelatedError(err),
			isObsidianFileMetadataRaceError: (err) => this.isObsidianFileMetadataRaceError(err),
			handleIndexedDbDegraded: (source, err) => this.handleIndexedDbDegraded(source, err),
			registerCleanup: (cleanup) => this.register(cleanup),
			createLogger: this.lab
				? (config) => this.lab!.createTraceLogger(this.app, config)
				: undefined,
		});
		this.traceRuntime.start();
	}

	private setupFlightTrace(): void {
		this.lab?.setupFlightTrace({
			getDocSchemaVersion: () => this.vaultSync?.storedSchemaVersion ?? null,
			buildCheckpoint: () => this.buildFlightCheckpoint(),
		});
		void this.refreshFlightTraceState("startup");
	}

	private getTraceHttpContext(): TraceHttpContext | undefined {
		return this.traceRuntime?.httpContext;
	}

	private trace(
		source: string,
		msg: string,
		details?: TraceEventDetails,
	): void {
		this.traceRuntime?.record(source, msg, details);
	}

	private recordFlightEvent(event: import("./telemetry/debug/flightEvents").FlightEventInput): void {
		this.lab?.recordFlightEvent(event);
	}

	private recordFlightPathEvent(event: ProductFlightPathEventInput | import("./telemetry/debug/flightEvents").FlightPathEventInput): void {
		this.lab?.recordFlightPathEvent(event);
	}

	private scheduleTraceStateSnapshot(reason: string): void {
		this.traceRuntime?.scheduleSnapshot(reason);
	}

	private async buildTraceStateSnapshot(
		reason: string,
		recentServerTrace: unknown[],
	): Promise<Record<string, unknown>> {
		return {
			generatedAt: new Date().toISOString(),
			reason,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				debug: this.settings.debug,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
			state: {
				reconciled: this.reconciliationController.getState().reconciled,
				reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
				reconcilePending: this.reconciliationController.getState().reconcilePending,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
				unresolvedStructuralChangeCount: this.reconciliationController.getState().unresolvedStructuralChangeCount,
				unresolvedStructuralChangeSample: this.reconciliationController.getState().unresolvedStructuralChangeSample,
				openFileCount: this.editorWorkspace?.openFileCount ?? 0,
			},
			sync: this.vaultSync?.getDebugSnapshot() ?? null,
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.getBlobSync()?.getDebugSnapshot() ?? null,
			openFiles: await this.collectOpenFileTraceState(),
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync?.getRecentEvents(120) ?? [],
			},
			serverTrace: recentServerTrace,
		};
	}

	private async buildFlightCheckpoint(): Promise<Record<string, unknown>> {
		const vaultSync = this.vaultSync;
		const blobSync = this.getBlobSync();
		return {
			connected: vaultSync?.connected ?? false,
			providerSynced: vaultSync?.providerSynced ?? false,
			serverReceipt: vaultSync?.serverAppliedLocalState ?? null,
			diskFileCount: this.app.vault.getFiles().filter((file) => isCrdtDocumentPath(file.path)).length,
			crdtPathCount: vaultSync?.getActiveMarkdownPaths().length ?? 0,
			missingOnDisk: 0,
			missingInCrdt: 0,
			hashMismatches: 0,
			pendingBlobUploads: blobSync?.pendingUploads ?? 0,
			pendingBlobDownloads: blobSync?.pendingDownloads ?? 0,
			reconcileInFlight: this.reconciliationController?.isReconcileInFlight ?? false,
			safetyBrakeActive: this.reconciliationController?.getState().lastReconcileStats?.safetyBrakeTriggered ?? false,
		};
	}

	private async refreshFlightTraceState(reason: string): Promise<void> {
		await this.lab?.refreshFlightTraceState(reason);
	}

	private async collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>> {
		if (!this.vaultSync) return [];

		const probes: Array<Record<string, unknown>> = [];
		const leaves: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				leaves.push(leaf.view);
			}
		});

		for (const view of leaves) {
			const file = view.file;
			if (!file) continue;

			const path = file.path;
			const editorContent = view.editor.getValue();
			const diskContent = await this.app.vault.read(file).catch(() => null);
			const crdtContent = yTextToString(this.vaultSync.getTextForPath(path));
			const binding = this.editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = this.editorBindings?.getCollabDebugInfoForView(view) ?? null;

			const [editorHash, diskHash, crdtHash] = await Promise.all([
				this.hashIfPresent(editorContent),
				this.hashIfPresent(diskContent),
				this.hashIfPresent(crdtContent),
			]);

			probes.push({
				path,
				leafId: binding?.leafId ?? ((view.leaf as unknown as { id?: string }).id ?? path),
				binding,
				collab,
				hashes: {
					editor: editorHash,
					disk: diskHash,
					crdt: crdtHash,
				},
				lengths: {
					editor: editorContent.length,
					disk: diskContent?.length ?? null,
					crdt: crdtContent?.length ?? null,
				},
				editorVsDisk: this.describeContentDiff(editorContent, diskContent),
				editorVsCrdt: this.describeContentDiff(editorContent, crdtContent),
				diskVsCrdt: this.describeContentDiff(diskContent, crdtContent),
			});
		}

		return probes;
	}

	private async hashIfPresent(text: string | null): Promise<string | null> {
		if (text == null) return null;
		return this.sha256Hex(text);
	}

	private describeContentDiff(
		left: string | null,
		right: string | null,
	): Record<string, unknown> {
		if (left == null || right == null) {
			return {
				comparable: false,
				leftLength: left?.length ?? null,
				rightLength: right?.length ?? null,
			};
		}

		const firstDiffIndex = this.findFirstDiffIndex(left, right);
		return {
			comparable: true,
			matches: firstDiffIndex === -1,
			firstDiffIndex: firstDiffIndex === -1 ? null : firstDiffIndex,
			leftLength: left.length,
			rightLength: right.length,
			leftSnippet: firstDiffIndex === -1 ? "" : left.slice(firstDiffIndex, firstDiffIndex + 160),
			rightSnippet: firstDiffIndex === -1 ? "" : right.slice(firstDiffIndex, firstDiffIndex + 160),
		};
	}

	private findFirstDiffIndex(left: string, right: string): number {
		const max = Math.min(left.length, right.length);
		for (let i = 0; i < max; i++) {
			if (left[i] !== right[i]) return i;
		}
		return left.length === right.length ? -1 : max;
	}

	onunload() {
		this.log("Unloading plugin");
		this.lab?.dispose();   // dispose stops flight trace, witness, and QA API
		const teardown = this.teardownSync().catch((err) => {
			console.error("[kaos] Failed to teardown sync runtime during unload:", err);
			this.log(`teardownSync failed during unload: ${formatUnknown(err)}`);
		});
		const traceShutdown = this.traceRuntime?.shutdown();
		if (traceShutdown) {
			void traceShutdown.catch((err) => {
				console.error("[kaos] Failed to shutdown trace runtime during unload:", err);
				this.log(`trace runtime shutdown failed during unload: ${formatUnknown(err)}`);
			});
		}
		document.body.removeClass("vault-crdt-show-cursors");
		// Remove plugin-owned debug global to prevent stale API references
		// from confusing test harnesses after plugin reload.
		const win = window as unknown as Record<string, unknown>;
		if (win.__KAOS_DEBUG__) {
			delete win.__KAOS_DEBUG__;
		}
		void teardown;
	}

	private createBaselineTextRepository(): BaselineTextRepository {
		const headlessHost = this.app as unknown as {
			baselineTextRepositoryFor?: (pluginId: string, scope: string) => BaselineTextRepository;
		};
		if (typeof headlessHost.baselineTextRepositoryFor === "function") {
			return headlessHost.baselineTextRepositoryFor(this.manifest.id, this.settings.vaultId);
		}
		return new IndexedDbBaselineTextRepository(this.settings.vaultId);
	}

	private async initializeBaselineTextPersistence(): Promise<void> {
		const legacyTexts = { ...this.baselineTexts };
		const wasExternalized = this.persistedState._baselineTextStoreVersion === BASELINE_TEXT_STORE_VERSION;
		let repository: BaselineTextRepository | null = null;
		try {
			repository = this.createBaselineTextRepository();
			// Force lazy backends to open before changing the data.json format marker.
			await repository.save({});

			const verifiedLegacyTexts: BaselineTextStore = {};
			let rejectedCount = 0;
			const verifiedEntries = await mapWithConcurrency(
				Object.entries(legacyTexts),
				8,
				async ([hash, text]) => ({ hash: hash.toLowerCase(), text, actualHash: await contentBaselineHash(text) }),
			);
			for (const { hash, text, actualHash } of verifiedEntries) {
				if (actualHash === hash) verifiedLegacyTexts[hash] = text;
				else rejectedCount++;
			}
			if (Object.keys(verifiedLegacyTexts).length > 0) {
				await repository.save(verifiedLegacyTexts);
			}

			this.baselineTexts = verifiedLegacyTexts;
			this.baselineTextRepository = repository;
			this.baselineTextsExternalized = true;
			this.dirtyBaselineTextHashes.clear();
			this.baselineTextFullGcPending = true;
			await this.persistPluginState();
			if (rejectedCount > 0) {
				this.log(`Ignored ${rejectedCount} baseline text(s) whose content did not match their SHA-256 key.`);
			}
			if (!wasExternalized && Object.keys(verifiedLegacyTexts).length > 0) {
				this.log(`Migrated ${Object.keys(verifiedLegacyTexts).length} baseline text(s) out of data.json.`);
			}
		} catch (err) {
			this.baselineTextRepository = null;
			this.baselineTexts = legacyTexts;
			// An already-migrated vault has no safe reason to re-inflate data.json.
			// Missing bodies simply disable automatic 3-way merge and preserve a conflict artifact.
			this.baselineTextsExternalized = wasExternalized && Object.keys(legacyTexts).length === 0;
			console.warn("[kaos] Baseline text storage unavailable; using safe no-base fallback:", err);
			this.log(`Baseline text storage unavailable: ${formatUnknown(err)}`);
		}
	}

	private async getBaselineText(contentHash: string): Promise<string | null> {
		const hash = contentHash.toLowerCase();
		const cached = this.baselineTexts[hash];
		if (cached !== undefined) return cached;
		const repository = this.baselineTextRepository;
		if (!repository) return null;
		try {
			const stored = (await repository.load([hash]))[hash];
			if (stored === undefined) return null;
			if (await contentBaselineHash(stored) !== hash) {
				this.log(`Ignored corrupt baseline text for hash ${hash.slice(0, 12)}.`);
				return null;
			}
			this.baselineTexts[hash] = stored;
			return stored;
		} catch (err) {
			this.log(`Failed to read baseline text ${hash.slice(0, 12)}: ${formatUnknown(err)}`);
			return null;
		}
	}

	private recordBaselineText(contentHash: string, text: string): void {
		const hash = contentHash.toLowerCase();
		this.baselineTexts[hash] = text;
		this.dirtyBaselineTextHashes.add(hash);
	}

	private replaceDiskIndex(index: DiskIndex): void {
		const nextHashes = new Set(Object.values(index).map((entry) => entry.contentHash).filter(
			(hash): hash is string => typeof hash === "string",
		));
		for (const entry of Object.values(this.diskIndex)) {
			if (entry.contentHash && !nextHashes.has(entry.contentHash)) {
				this.baselineTextDeleteCandidates.add(entry.contentHash);
			}
		}
		this.diskIndex = index;
	}

	private async flushDirtyBaselineTexts(): Promise<void> {
		const repository = this.baselineTextRepository;
		if (!repository || !this.baselineTextsExternalized || this.dirtyBaselineTextHashes.size === 0) return;
		const pending: BaselineTextStore = {};
		for (const hash of this.dirtyBaselineTextHashes) {
			const text = this.baselineTexts[hash];
			if (text !== undefined) pending[hash] = text;
		}
		if (Object.keys(pending).length === 0) {
			this.dirtyBaselineTextHashes.clear();
			return;
		}
		try {
			await repository.save(pending);
			for (const hash of Object.keys(pending)) this.dirtyBaselineTextHashes.delete(hash);
		} catch (err) {
			// Hash persistence may still proceed safely. A missing body causes no-base
			// conflict preservation rather than an automatic merge or overwrite.
			this.log(`Failed to persist baseline text bodies: ${formatUnknown(err)}`);
		}
	}

	private async runBaselineTextGc(): Promise<void> {
		const repository = this.baselineTextRepository;
		if (!repository || !this.baselineTextsExternalized) return;
		const referencedHashes = collectReferencedBaselineHashes(this.diskIndex, this.conflictMergeBases);
		try {
			if (this.baselineTextFullGcPending) {
				await repository.retain(referencedHashes);
				this.baselineTextFullGcPending = false;
				this.baselineTextDeleteCandidates.clear();
				return;
			}
			if (this.baselineTextDeleteCandidates.size === 0) return;
			const staleHashes = Array.from(this.baselineTextDeleteCandidates)
				.filter((hash) => !referencedHashes.has(hash));
			await repository.remove(staleHashes);
			this.baselineTextDeleteCandidates.clear();
		} catch (err) {
			this.log(`Failed to prune unreferenced baseline texts: ${formatUnknown(err)}`);
		}
	}

	async loadSettings() {
		const { settings, persistedState, migrated } = await this.settingsStore.load();
		const data = persistedState;
		this.persistedState = persistedState;
		this.settings = settings;
		// Prime the authority identity before reading any scope-owned state. This is
		// intentionally guard-only: the first applyRuntimeSettings() call must not
		// mistake startup hydration for a live scope transition and erase a valid
		// same-scope transfer queue that was just restored from data.json.
		this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		this.blobAuthorityScopeGuard.activate(this.getBlobIntentScope());
		// Load disk index from plugin data (stored under _diskIndex key)
		if (data && typeof data._diskIndex === "object" && data._diskIndex !== null) {
			this.diskIndex = data._diskIndex;
		}
		this.baselineTexts = readBaselineTextStore(data?._baselineTexts);
		this.conflictMergeBases = readConflictMergeBaseStore(data?._conflictMergeBases);
		this.baselineTextsExternalized =
			data?._baselineTextStoreVersion === BASELINE_TEXT_STORE_VERSION
			&& Object.keys(this.baselineTexts).length === 0;
		// Load lastDiskIndexPersistedAt for missing-baseline conflict tie-breaking
		if (data && typeof data._lastDiskIndexPersistedAt === "number" && data._lastDiskIndexPersistedAt > 0) {
			this.lastDiskIndexPersistedAt = data._lastDiskIndexPersistedAt;
		}
		// Load blob hash cache
		if (data && typeof data._blobHashCache === "object" && data._blobHashCache !== null) {
			this.blobHashCache = data._blobHashCache;
		}
		// Settled attachment refs are causal authority and therefore live only in
		// device-local IndexedDB. Ignore every legacy data.json representation.
		// data.json may be synced or restored from another device. Only execute a
		// queue created by this exact host/vault/local-device authority scope.
		this.savedBlobQueue = null;
		let scrubbedBlobQueue = false;
		if (data?._blobQueue !== undefined) {
			const queue = readPersistedBlobQueueSnapshot(
				data._blobQueue,
				this.getBlobIntentScope(),
			);
			if (queue) {
				this.savedBlobQueue = queue;
			} else {
				delete this.persistedState._blobQueue;
				scrubbedBlobQueue = true;
				this.log("Ignored a legacy, foreign-scope, or malformed attachment transfer queue");
			}
		}
		// Pending attachment mutations are device-local IndexedDB authority.
		// Never hydrate this legacy data.json field because external settings sync
		// can copy or roll it back across devices.
		if (Array.isArray(data?._preservedUnresolved)) {
			this.preservedUnresolvedEntries = data._preservedUnresolved.filter(
				(entry): entry is PreservedUnresolvedEntry => {
					if (typeof entry !== "object" || entry === null) return false;
					const candidate = entry as unknown as Record<string, unknown>;
					return typeof candidate.path === "string" &&
						(candidate.kind === "markdown" || candidate.kind === "blob") &&
						typeof candidate.reason === "string" &&
						typeof candidate.firstSeenAt === "number" &&
						typeof candidate.lastSeenAt === "number";
				},
			);
		}
		const cachedCapabilities = readPersistedServerCapabilitiesCache(data?._serverCapabilitiesCache);
		const cachedUpdateManifest = readPersistedUpdateManifestCache(data?._updateManifestCache);
		const guidedServerUpdate = readPersistedGuidedServerUpdateState(data?._guidedServerUpdate);
		this.capabilityUpdateService?.hydratePersistedCaches(
			cachedCapabilities,
			cachedUpdateManifest,
			guidedServerUpdate,
		);
		this.frontmatterQuarantineEntries = readPersistedFrontmatterQuarantine(data?._frontmatterQuarantine);
		this.refreshPersistedState();
		if (migrated || scrubbedBlobQueue) {
			await this.persistPluginState();
		}
	}

	async saveSettings(reason = "settings-save") {
		await this.persistPluginState();
		this.applyRuntimeSettings(reason);
		this.refreshStatusBar();
		void this.syncUpdateMetadataToServer(reason);
	}

	async updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason = "settings-update",
	): Promise<void> {
		mutator(this.settings);
		await this.saveSettings(reason);
	}

	private applyRuntimeSettings(reason: string): void {
		this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		this.activateBlobAuthorityScope(`runtime-settings:${reason}`);
		this.excludePatterns = this.runtimeConfig.excludePatterns;
		this.maxFileSize = this.runtimeConfig.maxFileSizeBytes;
		this.applyCursorVisibility();
		void this.refreshFlightTraceState(reason);
		this.trace("trace", "runtime-settings-applied", {
			reason,
			hostConfigured: !!this.runtimeConfig.host,
			vaultIdConfigured: !!this.runtimeConfig.vaultId,
			enableAttachmentSync: this.runtimeConfig.enableAttachmentSync,
			externalEditPolicy: this.runtimeConfig.externalEditPolicy,
			maxFileSizeKB: this.runtimeConfig.maxFileSizeKB,
			excludePatternCount: this.runtimeConfig.excludePatterns.length,
		});
	}

	get serverAuthMode(): ServerCapabilities["authMode"] | "unknown" {
		return this.capabilityUpdateService?.authMode ?? "unknown";
	}

	get serverSupportsAttachments(): boolean {
		return this.capabilityUpdateService?.supportsAttachments ?? true;
	}

	get serverSupportsSnapshots(): boolean {
		return this.capabilityUpdateService?.supportsSnapshots ?? true;
	}

	get serverMaxBlobUploadBytes(): number | null {
		return this.capabilityUpdateService?.capabilities?.maxBlobUploadBytes ?? null;
	}

	buildSetupDeepLink(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const params = new URLSearchParams({
			action: "setup",
			host,
			token,
			vaultId,
		});
		return `obsidian://kaos?${params.toString()}`;
	}

	buildMobileSetupUrl(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const hash = new URLSearchParams({
			host,
			token,
			vaultId,
		});
		return `${host}/mobile-setup#${hash.toString()}`;
	}

	buildRecoveryKitText(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		return [
			"KAOS Recovery Kit",
			`Created: ${new Date().toISOString()}`,
			"",
			`Host: ${host}`,
			`Token: ${token}`,
			`Vault ID: ${vaultId}`,
			"",
			"Keep this in a password manager. You need host + token + vault ID to recover this sync room on a new device.",
		].join("\n");
	}

	async refreshAttachmentSyncRuntime(reason = "settings-change"): Promise<void> {
		await this.attachmentOrchestrator?.refresh(reason);
	}

	private enforceCompatibilityGuard(reason: string): boolean {
		return this.capabilityUpdateService?.enforceCompatibilityGuard(reason) ?? false;
	}

	async refreshServerCapabilities(reason = "manual"): Promise<void> {
		await this.capabilityUpdateService?.refreshServerCapabilities(reason);
	}

	async refreshUpdateManifest(reason = "manual", force = false): Promise<void> {
		await this.capabilityUpdateService?.refreshUpdateManifest(reason, force);
	}

	async refreshRecoveryStorageStatus(reason = "manual"): Promise<void> {
		void reason;
		if (!this.settings.host || !this.settings.token || !this.settings.vaultId) {
			this.lastRecoveryStorageStatus = null;
			this.lastRecoveryStorageStatusError = "Sync is not configured.";
			return;
		}
		if (!this.serverSupportsSnapshots) {
			this.lastRecoveryStorageStatus = null;
			this.lastRecoveryStorageStatusError = "File history storage is unavailable on this server.";
			return;
		}
		try {
			this.lastRecoveryStorageStatus = await getFileHistoryStorageStatus(
				this.settings,
				this.getTraceHttpContext(),
			);
			this.lastRecoveryStorageStatusError = null;
		} catch (err) {
			this.lastRecoveryStorageStatus = null;
			this.lastRecoveryStorageStatusError = formatUnknown(err);
		}
	}

	getRecoveryStorageStatusState(): {
		status: RecoveryStorageAuditReport["status"] | "unknown";
		label: "Healthy" | "Repaired" | "Needs attention" | "Unknown";
		detail: string | null;
		checkedAt: string | null;
	} {
		const report = this.lastRecoveryStorageStatus;
		if (!report) {
			return {
				status: "unknown",
				label: "Unknown",
				detail: this.lastRecoveryStorageStatusError,
				checkedAt: null,
			};
		}
		if (report.status === "healthy" || report.status === "empty") {
			return {
				status: report.status,
				label: "Healthy",
				detail: `${report.manifestCountLowerBound} file history point(s) checked.`,
				checkedAt: report.checkedAt,
			};
		}
		if (report.status === "repaired") {
			const repairCount = report.repairs.filter((repair) => repair.success).length;
			return {
				status: "repaired",
				label: "Repaired",
				detail: `${repairCount} file history storage repair(s) applied.`,
				checkedAt: report.checkedAt,
			};
		}
		if (report.status === "degraded") {
			const remaining = report.issues.filter((issue) => !issue.repaired).length;
			return {
				status: "degraded",
				label: "Needs attention",
				detail: `${remaining} file history storage issue(s) need attention.`,
				checkedAt: report.checkedAt,
			};
		}
		return {
			status: "unavailable",
			label: "Unknown",
			detail: report.issues[0]?.message ?? "File history storage is unavailable.",
			checkedAt: report.checkedAt,
		};
	}

	getUpdateState(): UpdateState {
		return this.capabilityUpdateService?.getUpdateState() ?? {
			serverVersion: null,
			latestServerVersion: null,
			serverUpdateAvailable: false,
			pluginVersion: this.manifest.version,
			latestPluginVersion: null,
			pluginUpdateRecommended: false,
			migrationRequired: false,
			updateProvider: "unknown",
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			updateActionLabel: "KAOS settings",
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
			autoUpdateEligible: false,
			releaseNotesUrl: null,
			upgradeGuideUrl: null,
			guidedServerUpdateAvailable: false,
			guidedServerUpdateStatus: "idle",
			guidedServerUpdateTargetVersion: null,
			guidedServerUpdateStartedAt: null,
		};
	}

	async beginGuidedServerUpdate(): Promise<boolean> {
		return await this.capabilityUpdateService?.beginGuidedServerUpdate() ?? false;
	}

	buildServerUpdateUrl(): string | null {
		return this.capabilityUpdateService?.buildServerUpdateUrl() ?? null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		return this.capabilityUpdateService?.buildGithubUpdaterBootstrapUrl() ?? null;
	}

	private async syncUpdateMetadataToServer(reason: string): Promise<void> {
		await this.capabilityUpdateService?.syncUpdateMetadataToServer(reason);
	}

		private showFatalSyncNotice(): void {
			const code = this.vaultSync?.fatalAuthCode;
			if (code === "unclaimed") {
				new Notice(
					"This server is unclaimed. Open the server URL in a browser, then use the setup link.",
					10000,
				);
				return;
			}

			if (code === "server_misconfigured") {
				new Notice("Server misconfigured.");
				return;
			}
		if (code === "update_required") {
			const details = this.vaultSync?.fatalAuthDetails;
			const detailText =
				details && (details.roomSchemaVersion !== null || details.clientSchemaVersion !== null)
					? ` (client=${details.clientSchemaVersion ?? "unknown"}, room=${details.roomSchemaVersion ?? "unknown"})`
					: "";
			new Notice(
				`KAOS: this vault was upgraded by a newer plugin schema${detailText}. ` +
				"Update KAOS on this device to continue syncing.",
				12000,
			);
			return;
		}

			new Notice("Unauthorized. Check your token in settings.");
		}

	private async saveDiskIndex(): Promise<void> {
		this.clearScheduledDiskIndexSave();
		const persistedAt = Date.now();
		await this.persistPluginState((state) => {
			state._lastDiskIndexPersistedAt = persistedAt;
		});
		this.lastDiskIndexPersistedAt = persistedAt;
	}

	private scheduleDiskIndexSave(reason: string): void {
		if (this.diskIndexSaveTimer !== null) return;
		this.diskIndexSaveTimer = setTimeout(() => {
			this.diskIndexSaveTimer = null;
			void this.saveDiskIndex().catch((err) => {
				console.error("[kaos] Failed to persist disk index:", err);
				this.log(`saveDiskIndex failed after ${reason}: ${formatUnknown(err)}`);
			});
		}, DISK_INDEX_SAVE_DEBOUNCE_MS);
	}

	private clearScheduledDiskIndexSave(): void {
		if (this.diskIndexSaveTimer === null) return;
		clearTimeout(this.diskIndexSaveTimer);
		this.diskIndexSaveTimer = null;
	}

	private async persistBlobQueueSnapshot(
		snapshot: BlobQueueSnapshot,
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken = this.blobAuthorityScopeGuard.capture(),
	): Promise<void> {
		if (!this.blobAuthorityScopeGuard.isCurrent(token, scope)) return;
		await this.persistPluginState((state) => {
			if (!this.blobAuthorityScopeGuard.isCurrent(token, scope)) return;
			if (snapshot.uploads.length === 0 && snapshot.downloads.length === 0) {
				delete state._blobQueue;
			} else {
				state._blobQueue = createPersistedBlobQueueSnapshot(
					snapshot,
					scope,
				);
			}
		});
	}

	/**
	 * Clear the persisted blob queue once all transfers are done.
	 * Only writes if there was previously a saved queue.
	 */
	private async clearSavedBlobQueue(
		scope: PendingBlobIntentScope = this.getBlobIntentScope(),
		token: BlobAuthorityScopeToken = this.blobAuthorityScopeGuard.capture(),
	): Promise<void> {
		if (!this.blobAuthorityScopeGuard.isCurrent(token, scope)) return;
		await this.persistPluginState((state) => {
			if (!this.blobAuthorityScopeGuard.isCurrent(token, scope)) return;
			delete state._blobQueue;
		});
	}

	private refreshPersistedState(): void {
		for (const artifactPath of Object.keys(this.conflictMergeBases)) {
			if (!(this.app.vault.getAbstractFileByPath(artifactPath) instanceof TFile)) {
				const previousHash = this.conflictMergeBases[artifactPath];
				delete this.conflictMergeBases[artifactPath];
				if (previousHash) this.baselineTextDeleteCandidates.add(previousHash);
			}
		}
		this.baselineTexts = pruneBaselineTextStore(
			this.baselineTexts,
			this.diskIndex,
			this.conflictMergeBases,
		);
		for (const hash of this.dirtyBaselineTextHashes) {
			if (this.baselineTexts[hash] === undefined) this.dirtyBaselineTextHashes.delete(hash);
		}
		const nextState: PersistedPluginState = {
			...this.settingsStore.withSettings(this.persistedState, this.settings),
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
			...(this.lastDiskIndexPersistedAt > 0 && { _lastDiskIndexPersistedAt: this.lastDiskIndexPersistedAt }),
		};
		delete nextState._blobSettledRefs;
		delete nextState._blobSettledRefsByDevice;
		applyPersistedBaselineTextFields(
			nextState,
			this.baselineTexts,
			this.conflictMergeBases,
			this.baselineTextsExternalized,
		);
		const cachedCapabilities = this.capabilityUpdateService?.getPersistedServerCapabilitiesCache();
		if (cachedCapabilities) {
			nextState._serverCapabilitiesCache = cachedCapabilities;
		} else {
			delete nextState._serverCapabilitiesCache;
		}
		const cachedUpdateManifest = this.capabilityUpdateService?.getPersistedUpdateManifestCache();
		if (cachedUpdateManifest) {
			nextState._updateManifestCache = cachedUpdateManifest;
		} else {
			delete nextState._updateManifestCache;
		}
		const guidedServerUpdate = this.capabilityUpdateService?.getPersistedGuidedServerUpdateState();
		if (guidedServerUpdate) {
			nextState._guidedServerUpdate = guidedServerUpdate;
		} else {
			delete nextState._guidedServerUpdate;
		}
		if (this.frontmatterQuarantineEntries.length > 0) {
			nextState._frontmatterQuarantine = this.frontmatterQuarantineEntries;
		} else {
			delete nextState._frontmatterQuarantine;
		}
		const preserved = this.collectPreservedUnresolvedEntries();
		if (preserved.length > 0) {
			nextState._preservedUnresolved = preserved;
		} else {
			delete nextState._preservedUnresolved;
		}
		delete nextState._pendingBlobIntents;
		this.persistedState = nextState;
	}

	private collectPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		const entries = new Map<string, PreservedUnresolvedEntry>();
		const hasDiskRegistry = this.diskMirror !== null;
		const hasBlobRegistry = this.getBlobSync() !== null;
		for (const entry of this.preservedUnresolvedEntries) {
			if (entry.kind === "markdown" && hasDiskRegistry) continue;
			if (entry.kind === "blob" && hasBlobRegistry) continue;
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		for (const entry of this.diskMirror?.getPreservedUnresolvedEntries() ?? []) {
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		for (const entry of this.getBlobSync()?.getPreservedUnresolvedEntries() ?? []) {
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		this.preservedUnresolvedEntries = Array.from(entries.values());
		return this.preservedUnresolvedEntries;
	}

	private persistPreservedUnresolvedState(): void {
		void this.persistPluginState();
		this.refreshStatusBar();
	}

	private async persistPluginState(
		mutate?: (state: PersistedPluginState) => void,
	): Promise<void> {
		// Serialize all plugin data writes so settings/index/blob queue updates
		// cannot clobber each other with interleaved load/merge/save cycles.
		const write = async () => {
			this.refreshPersistedState();
			mutate?.(this.persistedState);
			await this.flushDirtyBaselineTexts();
			await this.settingsStore.save(this.persistedState);
			await this.runBaselineTextGc();
		};

		this.persistWriteChain = this.persistWriteChain
			.catch(() => undefined)
			.then(write);
		await this.persistWriteChain;
	}

	private async sha256Hex(text: string): Promise<string> {
		const data = new TextEncoder().encode(text);
		const digest = await crypto.subtle.digest("SHA-256", data);
		return arrayBufferToHex(digest);
	}

	private runSchemaMigrationToV2(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized.");
			return;
		}
		const diagnosticsService =
			this.lab?.diagnosticsService as import("./telemetry/diagnostics/diagnosticsService").DiagnosticsService | undefined;
		runSchemaMigrationToV2({
			app: this.app,
			vaultSync: this.vaultSync,
			settings: this.settings,
			diagnosticsService: diagnosticsService ?? null,
			log: (msg) => this.log(msg),
			runReconciliation: async () => {
				const mode = this.vaultSync?.getSafeReconcileMode();
				if (!mode) return;
				await this.runReconciliation(mode);
			},
		});
	}

	// -------------------------------------------------------------------
	// QA debug API surface
	// -------------------------------------------------------------------

	private mountQaDebugApi(): void {
		if (!this.settings.qaDebugMode) return;
		// window.__KAOS_DEBUG__ is the Puppeteer harness API.
		// It is NOT part of the production telemetry runtime (telemetry.js).
		// The Puppeteer harness (qa/harness/installPuppeteerRuntime.ts) mounts
		// it when loaded externally for QA scenarios.
			// In this product build, no mutation API is available — log explicitly
			// so developers know what happened instead of silently finding no API.
			this.log("qaDebugMode enabled, but window.__KAOS_DEBUG__ is not mounted by this build. Load the Puppeteer harness from qa/harness/ to get the QA debug API.");
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- QA/API are product acronyms.
			new Notice("KAOS: QA debug mode is active; QA debug API is not available in this build. See qa/harness/.", 8000);
		}

	private async exportFlightTraceForApi(privacy: "safe" | "full"): Promise<string | null> {
		void privacy;
		return null;
	}

	private log(msg: string): void {
		this.eventRing.push({ ts: new Date().toISOString(), msg });
		if (this.eventRing.length > 600) {
			this.eventRing.splice(0, this.eventRing.length - 600);
		}
		this.trace("plugin", msg);
		if (this.settings.debug) {
			console.debug(`[kaos] ${msg}`);
		}
	}

	private isIndexedDbRelatedError(err: unknown): boolean {
		if (!err) return false;
		const name =
			typeof (err as { name?: unknown })?.name === "string"
				? (err as { name: string }).name
				: "";
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = `${name} ${message}`.toLowerCase();
		return haystack.includes("quotaexceeded")
			|| haystack.includes("quota exceeded")
			|| haystack.includes("indexeddb")
			|| haystack.includes("idb");
	}

	private isObsidianFileMetadataRaceError(err: unknown): boolean {
		if (!err) return false;
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = message.toLowerCase();
		return haystack.includes("cannot index file, since it has no obsidian file metadata")
			|| (haystack.includes("failed to index file") && haystack.includes("no obsidian file metadata"));
	}

	private handleIndexedDbDegraded(source: string, err?: unknown): void {
		if (!this.vaultSync) return;
		if (err) {
			this.vaultSync.reportIndexedDbError(err, "runtime");
		}
		if (!this.vaultSync.idbError) return;
		this.blobLocalPersistenceReady = false;
		this.attachmentOrchestrator?.revokeUploadAuthority("idb-degraded");
		if (this.idbDegradedHandled) return;

		this.idbDegradedHandled = true;
		const kind = this.vaultSync.idbErrorDetails?.kind ?? "unknown";
		this.log(`IndexedDB degraded (${source}): kind=${kind}`);
		this.scheduleTraceStateSnapshot("idb-degraded");

		void this.attachmentOrchestrator?.stop("idb-degraded");

		const notice = kind === "quota_exceeded"
			? "KAOS: Device storage is full. Sync durability is degraded and attachment transfers are paused. Free up storage, then restart Obsidian."
			: "KAOS: IndexedDB persistence failed. Sync durability is degraded and attachment transfers are paused.";
		new Notice(notice, 12000);
	}
}
