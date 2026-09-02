import { type App, Notice, type TFile } from "obsidian";
import {
	BlobSyncManager,
	type BlobQueueSnapshot,
	type BlobSettlementStage,
	type BlobSettledRefCache,
	type BlobSettlementStageCache,
	type BlobSettledSourceVersionCache,
} from "../sync/blobSync";
import type { BlobHashCache } from "../sync/blobHashCache";
import type { VaultSync } from "../sync/vaultSync";
import { isBlobSyncable, type BlobRef } from "../types";
import type { RuntimeConfig } from "./runtimeConfig";
import { formatUnknown } from "../utils/format";
import type { TraceHttpContext, TraceRecord } from "../observability/traceContext";
import type { PreservedUnresolvedEntry } from "../sync/preservedUnresolved";
import type { PendingBlobIntentScope } from "../sync/pendingBlobIntentJournal";
import type { BlobAuthorityScopeToken } from "../sync/blobAuthorityScopeGuard";

interface AttachmentOrchestratorDeps {
	app: App;
	getVaultSync(): VaultSync | null;
	getRuntimeConfig(): RuntimeConfig;
	getServerSupportsAttachments(): boolean;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getBlobHashCache(): BlobHashCache;
	getBlobSettledRefs(): BlobSettledRefCache;
	getBlobSettledSourceVersions(): BlobSettledSourceVersionCache;
	getBlobSettlementStages(): BlobSettlementStageCache;
	captureBlobRuntimeAuthority(
		vaultSync: VaultSync,
		scope: PendingBlobIntentScope,
	): BlobAuthorityScopeToken | null;
	isBlobRuntimeAuthorityCurrent(
		vaultSync: VaultSync,
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken,
	): boolean;
	isUploadAuthoritySourceReady(
		vaultSync: VaultSync,
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken,
	): boolean;
	onBlobSettledRefsChanged(
		path: string | undefined,
		ref: BlobRef | undefined,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
		token: BlobAuthorityScopeToken,
	): void;
	stageBlobSettlement(
		path: string,
		stage: BlobSettlementStage,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void>;
	finalizeBlobSettlement(
		path: string,
		stageId: string,
		ref: BlobRef,
		sourceVersion: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void>;
	retireBlobSettlement(
		path: string,
		stageId: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void>;
	abortBlobSettlementStage(
		path: string,
		stageId: string,
		scope: PendingBlobIntentScope,
		vaultSync: VaultSync,
	): Promise<void>;
	getExcludePatterns(): string[];
	getBlobQueuePersistenceScope(): PendingBlobIntentScope;
	persistBlobQueue(
		snapshot: BlobQueueSnapshot,
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken,
	): Promise<void>;
	clearPersistedBlobQueue(
		scope: PendingBlobIntentScope,
		token: BlobAuthorityScopeToken,
	): Promise<void>;
	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[];
	onPreservedUnresolvedChanged(): void;
	persistPreservedUnresolvedChanged(): Promise<void>;
	hasPendingBlobIntentForPath(path: string): boolean;
	replayPendingBlobIntents(reason: string): Promise<void>;
	trace: TraceRecord;
	scheduleTraceStateSnapshot(reason: string): void;
	refreshStatusBar(): void;
	log(message: string): void;
}

export class AttachmentOrchestrator {
	private blobSync: BlobSyncManager | null = null;
	/** Managers draining operation-owned filesystem work during stop/destroy. */
	private readonly retiringBlobSyncs = new Set<BlobSyncManager>();
	/** Full retirement tails, including queue persistence and in-flight cleanup. */
	private readonly retiringBlobSyncTasks = new Set<Promise<void>>();
	/** Exact authority scope captured when each manager instance was created. */
	private readonly blobQueuePersistenceScopes = new WeakMap<
		BlobSyncManager,
		PendingBlobIntentScope
	>();
	/** Exact identity+epoch authority captured when each manager was created. */
	private readonly blobRuntimeAuthorities = new WeakMap<
		BlobSyncManager,
		{
			scope: PendingBlobIntentScope;
			vaultSync: VaultSync;
			token: BlobAuthorityScopeToken;
		}
	>();
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	private shownAttachmentNudge = false;
	private downloadGateLayoutReady: boolean;
	private downloadGateStartupReady = false;
	private downloadAuthorityReady = false;
	private uploadAuthorityReady = false;
	/** Authoritative inventory cannot inspect the Vault safely before layout. */
	private readonly pendingAuthoritativeReconciles = new Map<BlobSyncManager, string>();
	private readonly authoritativeReconcileInFlight = new Set<BlobSyncManager>();

	constructor(private readonly deps: AttachmentOrchestratorDeps) {
		this.downloadGateLayoutReady = deps.app.workspace.layoutReady;
		deps.app.workspace.onLayoutReady(() => {
			const firstReady = !this.downloadGateLayoutReady;
			this.downloadGateLayoutReady = true;
			if (firstReady) {
				this.deps.trace("trace", "blob-download-layout-ready", {});
				this.deps.log("Blob download gate: workspace layout ready");
			}
			const blobSync = this.blobSync;
			if (blobSync && !this.isManagerAuthorityCurrent(blobSync)) {
				blobSync.closeUploadGate("workspace-layout-stale-authority");
				blobSync.closeDownloadGate("workspace-layout-stale-authority");
				return;
			}
			blobSync?.setInventoryGateReady(true, "workspace-layout-ready");
			const pendingReason = blobSync
				? this.pendingAuthoritativeReconciles.get(blobSync)
				: undefined;
			if (blobSync && pendingReason) {
				this.pendingAuthoritativeReconciles.delete(blobSync);
				this.requestInitialAuthoritativeReconcile(
					blobSync,
					`layout-ready:${pendingReason}`,
				);
			}
			this.maybeOpenUploadGate("layout-ready");
			this.maybeOpenDownloadGate("layout-ready");
		});
	}

	get manager(): BlobSyncManager | null {
		return this.blobSync;
	}

	getQueuePersistenceScope(blobSync: BlobSyncManager): PendingBlobIntentScope | null {
		const scope = this.blobQueuePersistenceScopes.get(blobSync);
		return scope ? { ...scope } : null;
	}

	private isManagerAuthorityCurrent(blobSync: BlobSyncManager): boolean {
		const authority = this.blobRuntimeAuthorities.get(blobSync);
		return !!authority
			&& this.blobSync === blobSync
			&& this.deps.isBlobRuntimeAuthorityCurrent(
				authority.vaultSync,
				authority.scope,
				authority.token,
			);
	}

	consumeRemoteOverwriteBackupRename(file: TFile, oldPath: string): boolean {
		if (this.blobSync?.consumeRemoteOverwriteBackupRename(file, oldPath)) {
			return true;
		}
		for (const retiring of this.retiringBlobSyncs) {
			if (retiring.consumeRemoteOverwriteBackupRename(file, oldPath)) {
				return true;
			}
		}
		return false;
	}

	hydrateSavedQueue(snapshot: BlobQueueSnapshot | null): void {
		this.savedBlobQueue = snapshot;
	}

	start(reason: string, runInitialReconcile: boolean): void {
		if (this.blobSync) return;
		if (this.retiringBlobSyncTasks.size > 0) {
			this.deps.log(
				`Attachment sync engine start deferred while prior manager retires (${reason})`,
			);
			return;
		}
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (!runtimeConfig.enableAttachmentSync || !this.deps.getServerSupportsAttachments()) return;
		const queuePersistenceScope = this.deps.getBlobQueuePersistenceScope();

		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;
		const authorityToken = this.deps.captureBlobRuntimeAuthority(
			vaultSync,
			queuePersistenceScope,
		);
		if (!authorityToken) {
			this.deps.log(`Attachment sync engine start blocked by stale authority (${reason})`);
			return;
		}
		if (!runtimeConfig.host || !runtimeConfig.authorizationHeader) return;
		// Authority belongs to a manager instance. A stopped/unsupported manager
		// must never lend its previously-open gate to a replacement.
		this.uploadAuthorityReady = false;
		this.downloadAuthorityReady = false;

		let blobSync!: BlobSyncManager;
		blobSync = new BlobSyncManager(
			this.deps.app,
			vaultSync,
			{
				host: runtimeConfig.host,
				getAuthorizationHeader: runtimeConfig.authorizationHeader,
				vaultId: runtimeConfig.vaultId,
				maxAttachmentSizeKB: runtimeConfig.maxAttachmentSizeKB,
				attachmentConcurrency: runtimeConfig.attachmentConcurrency,
				debug: runtimeConfig.debug,
				trace: this.deps.getTraceHttpContext(),
			},
			this.deps.getBlobHashCache(),
			this.deps.trace,
			this.deps.getPreservedUnresolvedEntries(),
			() => this.deps.onPreservedUnresolvedChanged(),
			(path) => this.isManagerAuthorityCurrent(blobSync) && isBlobSyncable(
				path,
				this.deps.getExcludePatterns(),
				this.deps.app.vault.configDir,
			) && !this.deps.hasPendingBlobIntentForPath(path),
			this.deps.getBlobSettledRefs(),
			(path, ref) => {
				if (!this.isManagerAuthorityCurrent(blobSync)) return;
				this.deps.onBlobSettledRefsChanged(
					path,
					ref,
					queuePersistenceScope,
					vaultSync,
					authorityToken,
				);
			},
			this.deps.getBlobSettledSourceVersions(),
			this.deps.getBlobSettlementStages(),
			{
				stage: (path, stage) => this.isManagerAuthorityCurrent(blobSync)
					? this.deps.stageBlobSettlement(
						path,
						stage,
						queuePersistenceScope,
						vaultSync,
					)
					: Promise.reject(new Error("Attachment manager authority changed")),
				finalize: (path, stageId, ref, sourceVersion) =>
					this.isManagerAuthorityCurrent(blobSync)
						? this.deps.finalizeBlobSettlement(
							path,
						stageId,
						ref,
						sourceVersion,
						queuePersistenceScope,
						vaultSync,
						)
						: Promise.reject(new Error("Attachment manager authority changed")),
				retire: (path, stageId) => this.isManagerAuthorityCurrent(blobSync)
					? this.deps.retireBlobSettlement(
						path,
						stageId,
						queuePersistenceScope,
						vaultSync,
					)
					: Promise.reject(new Error("Attachment manager authority changed")),
				abort: (path, stageId) => this.isManagerAuthorityCurrent(blobSync)
					? this.deps.abortBlobSettlementStage(
						path,
						stageId,
						queuePersistenceScope,
						vaultSync,
					)
					: Promise.reject(new Error("Attachment manager authority changed")),
			},
			async () => {
				if (!this.isManagerAuthorityCurrent(blobSync)) {
					throw new Error("Attachment manager authority changed");
				}
				await this.deps.persistPreservedUnresolvedChanged();
				if (!this.isManagerAuthorityCurrent(blobSync)) {
					throw new Error("Attachment manager authority changed");
				}
			},
			() => this.isManagerAuthorityCurrent(blobSync),
		);
		blobSync.setInventoryGateReady(
			this.downloadGateLayoutReady,
			this.downloadGateLayoutReady ? "workspace-already-ready" : "await-workspace-layout",
		);

		this.blobSync = blobSync;
		this.blobQueuePersistenceScopes.set(blobSync, { ...queuePersistenceScope });
		this.blobRuntimeAuthorities.set(blobSync, {
			scope: { ...queuePersistenceScope },
			vaultSync,
			token: { ...authorityToken },
		});
		blobSync.startObservers();
		this.deps.log(`Attachment sync engine started (${reason})`);

		if (this.savedBlobQueue) {
			blobSync.importQueue(this.savedBlobQueue);
			this.savedBlobQueue = null;
		}

		if (runInitialReconcile) {
			this.requestInitialAuthoritativeReconcile(blobSync, reason);
		}

		// A manager started after startup (for example after capabilities become
		// available) must reconcile before either pre-ready gate can drain it.
		this.maybeOpenUploadGate(`engine-start:${reason}`);
		this.maybeOpenDownloadGate(`engine-start:${reason}`);
	}

	private requestInitialAuthoritativeReconcile(
		blobSync: BlobSyncManager,
		reason: string,
	): void {
		if (!this.isManagerAuthorityCurrent(blobSync)) return;
		if (!this.downloadGateLayoutReady) {
			this.pendingAuthoritativeReconciles.set(blobSync, reason);
			this.deps.trace("trace", "blob-authoritative-reconcile-layout-deferred", {
				reason,
			});
			return;
		}
		if (this.authoritativeReconcileInFlight.has(blobSync)) {
			this.pendingAuthoritativeReconciles.set(blobSync, reason);
			return;
		}

		this.pendingAuthoritativeReconciles.delete(blobSync);
		this.authoritativeReconcileInFlight.add(blobSync);
		void this.runInitialAuthoritativeReconcile(blobSync, reason)
			.finally(() => {
				this.authoritativeReconcileInFlight.delete(blobSync);
				if (!this.isManagerAuthorityCurrent(blobSync)) {
					this.pendingAuthoritativeReconciles.delete(blobSync);
					return;
				}
				const pendingReason = this.pendingAuthoritativeReconciles.get(blobSync);
				if (!pendingReason) return;
				this.pendingAuthoritativeReconciles.delete(blobSync);
				this.requestInitialAuthoritativeReconcile(
					blobSync,
					`coalesced:${pendingReason}`,
				);
			});
	}

	private async runInitialAuthoritativeReconcile(
		blobSync: BlobSyncManager,
		reason: string,
	): Promise<void> {
		if (!this.isManagerAuthorityCurrent(blobSync)) return;
		if (!this.downloadGateLayoutReady) {
			this.pendingAuthoritativeReconciles.set(blobSync, reason);
			return;
		}
		try {
			// A pending local delete/rename must be durably journaled and replayed
			// before this manager is allowed to observe the stale remote path as a
			// download candidate.
			await this.deps.replayPendingBlobIntents(`engine-reconcile:${reason}`);
			if (!this.isManagerAuthorityCurrent(blobSync) || !this.downloadGateLayoutReady) return;
			const result = blobSync.reconcile("authoritative", this.deps.getExcludePatterns());
			if (!this.isManagerAuthorityCurrent(blobSync)) return;
			this.deps.log(
				`Attachment reconcile (${reason}): queued ` +
				`${result.uploadQueued} uploads, ${result.downloadQueued} downloads, ${result.skipped} skipped`,
			);
			const authority = this.blobRuntimeAuthorities.get(blobSync);
			if (
				authority
				&& this.deps.isUploadAuthoritySourceReady(
					authority.vaultSync,
					authority.scope,
					authority.token,
				)
			) {
				this.grantTransferAuthority(blobSync, `engine-reconcile:${reason}`);
			}
		} catch (err) {
			this.deps.log(`Attachment reconcile (${reason}) failed: ${formatUnknown(err)}`);
		}
	}

	async stop(reason: string): Promise<void> {
		const blobSync = this.blobSync;
		if (!blobSync) {
			await this.waitForRetiringBlobSyncs();
			return;
		}
		this.retiringBlobSyncs.add(blobSync);
		this.pendingAuthoritativeReconciles.delete(blobSync);
		this.blobSync = null;
		this.uploadAuthorityReady = false;
		this.downloadAuthorityReady = false;
		blobSync.closeUploadGate(`stop:${reason}`);
		blobSync.closeDownloadGate(`stop:${reason}`);
		await this.beginBlobSyncRetirement(blobSync);
		this.deps.log(`Attachment sync engine stopped (${reason})`);
	}

	async destroy(): Promise<void> {
		// A fire-and-forget stop (for example after IndexedDB degradation) may
		// already own the prior manager. Never let teardown/re-init overtake it.
		await this.waitForRetiringBlobSyncs();
		const blobSync = this.blobSync;
		if (blobSync) this.retiringBlobSyncs.add(blobSync);
		if (blobSync) this.pendingAuthoritativeReconciles.delete(blobSync);
		this.blobSync = null;
		blobSync?.closeUploadGate("orchestrator-destroy");
		blobSync?.closeDownloadGate("orchestrator-destroy");
		try {
			if (blobSync) {
				await this.beginBlobSyncRetirement(blobSync);
			}
		} finally {
			await this.waitForRetiringBlobSyncs();
			this.shownAttachmentNudge = false;
			this.downloadGateStartupReady = false;
			this.downloadAuthorityReady = false;
			this.uploadAuthorityReady = false;
		}
	}

	async refresh(reason = "settings-change"): Promise<void> {
		await this.waitForRetiringBlobSyncs();
		if (!this.deps.getVaultSync()) return;
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (runtimeConfig.enableAttachmentSync && this.deps.getServerSupportsAttachments()) {
			this.start(reason, true);
		} else {
			await this.stop(reason);
		}
		this.deps.refreshStatusBar();
	}

	private beginBlobSyncRetirement(blobSync: BlobSyncManager): Promise<void> {
		const snapshot = blobSync.exportQueue();
		const queuePersistenceScope = this.blobQueuePersistenceScopes.get(blobSync);
		const authority = this.blobRuntimeAuthorities.get(blobSync);
		// destroy() sets its fail-closed flag and unregisters observers before its
		// first await. Start it immediately, rather than leaving a closed-gate but
		// otherwise live manager active while data.json persistence is pending.
		const destroyPromise = blobSync.destroy();
		let retirement!: Promise<void>;
		retirement = (async () => {
			try {
				if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
					if (!queuePersistenceScope || !authority) {
						throw new Error("Attachment manager has no captured queue persistence scope");
					}
					await this.deps.persistBlobQueue(
						snapshot,
						queuePersistenceScope,
						authority.token,
					);
				}
			} finally {
				try {
					await destroyPromise;
				} finally {
					this.retiringBlobSyncs.delete(blobSync);
					this.retiringBlobSyncTasks.delete(retirement);
				}
			}
		})();
		this.retiringBlobSyncTasks.add(retirement);
		return retirement;
	}

	private async waitForRetiringBlobSyncs(): Promise<void> {
		while (this.retiringBlobSyncTasks.size > 0) {
			await Promise.allSettled(Array.from(this.retiringBlobSyncTasks));
		}
	}

	handleStatusTick(): void {
		const blobSync = this.blobSync;
		if (!blobSync) return;
		if (!this.isManagerAuthorityCurrent(blobSync)) {
			this.revokeUploadAuthority("status-tick-stale-authority");
			return;
		}
		if (blobSync.pendingUploads > 0 || blobSync.pendingDownloads > 0) {
			const queuePersistenceScope = this.blobQueuePersistenceScopes.get(blobSync);
			const authority = this.blobRuntimeAuthorities.get(blobSync);
			if (!queuePersistenceScope || !authority) {
				this.revokeUploadAuthority("queue-persistence-scope-missing");
				this.deps.log("Attachment queue persistence blocked: manager scope is missing");
				return;
			}
			void this.deps.persistBlobQueue(
				blobSync.exportQueue(),
				queuePersistenceScope,
				authority.token,
			).catch((err) => {
				this.revokeUploadAuthority("queue-persistence-failed");
				this.deps.log(`Attachment queue persistence failed: ${formatUnknown(err)}`);
			});
		} else {
			const authority = this.blobRuntimeAuthorities.get(blobSync);
			if (!authority) return;
			void this.deps.clearPersistedBlobQueue(
				authority.scope,
				authority.token,
			);
		}
	}

	markStartupReady(reason: string): void {
		const blobSync = this.blobSync;
		if (!blobSync || !this.isManagerAuthorityCurrent(blobSync)) return;
		if (this.downloadGateStartupReady) return;
		this.downloadGateStartupReady = true;
		this.deps.trace("trace", "blob-download-startup-ready", { reason });
		this.deps.log(`Blob transfer gates: startup ready (${reason})`);
		this.maybeOpenUploadGate(`startup-ready:${reason}`);
		this.maybeOpenDownloadGate(`startup-ready:${reason}`);
	}

	markUploadAuthorityReady(reason: string): void {
		const blobSync = this.blobSync;
		if (!blobSync || !this.isManagerAuthorityCurrent(blobSync)) return;
		if (!this.downloadGateLayoutReady) {
			this.uploadAuthorityReady = false;
			this.downloadAuthorityReady = false;
			this.requestInitialAuthoritativeReconcile(
				blobSync,
				`authority-ready:${reason}`,
			);
			this.deps.trace("trace", "blob-transfer-authority-layout-deferred", {
				reason,
			});
			return;
		}
		// A barrier already in progress will perform its own source-ready check
		// after replay + inventory; opening here would overtake that barrier.
		if (this.authoritativeReconcileInFlight.has(blobSync)) return;
		this.grantTransferAuthority(blobSync, reason);
	}

	private grantTransferAuthority(blobSync: BlobSyncManager, reason: string): void {
		if (!this.isManagerAuthorityCurrent(blobSync)) return;
		if (this.uploadAuthorityReady && this.downloadAuthorityReady) return;
		this.uploadAuthorityReady = true;
		this.downloadAuthorityReady = true;
		this.deps.trace("trace", "blob-upload-authority-ready", { reason });
		this.deps.log(`Blob transfer authority: ready (${reason})`);
		this.maybeOpenUploadGate(`authority-ready:${reason}`);
		this.maybeOpenDownloadGate(`authority-ready:${reason}`);
	}

	revokeUploadAuthority(reason: string): void {
		this.uploadAuthorityReady = false;
		this.downloadAuthorityReady = false;
		this.blobSync?.closeUploadGate(reason);
		this.blobSync?.closeDownloadGate(reason);
		this.deps.trace("trace", "blob-upload-authority-revoked", { reason });
	}

	resetBlobRuntimeAuthority(reason: string): void {
		// Startup readiness belongs to the exact runtime epoch. Carrying it across
		// A -> B -> A would let the replacement manager borrow the old startup gate.
		this.downloadGateStartupReady = false;
		this.revokeUploadAuthority(reason);
	}

	notifyUnsupportedAttachmentCreate(): void {
		if (this.shownAttachmentNudge) return;
		this.shownAttachmentNudge = true;
		new Notice(
			"This file won't sync yet. Attachment sync needs object storage. Open settings for setup.",
			10000,
		);
	}

	private maybeOpenDownloadGate(reason: string): void {
		const blobSync = this.blobSync;
		if (!blobSync || !this.isManagerAuthorityCurrent(blobSync)) return;
		if (blobSync.isDownloadGateOpen) return;
		if (
			!this.downloadGateLayoutReady
			|| !this.downloadGateStartupReady
			|| !this.downloadAuthorityReady
		) return;
		this.deps.trace("trace", "blob-download-gate-open", {
			reason,
			pendingDownloads: blobSync.pendingDownloads,
		});
		if (!this.isManagerAuthorityCurrent(blobSync)) return;
		blobSync.openDownloadGate(reason);
		this.deps.scheduleTraceStateSnapshot(`blob-download-gate:${reason}`);
	}

	private maybeOpenUploadGate(reason: string): void {
		const blobSync = this.blobSync;
		if (!blobSync || !this.isManagerAuthorityCurrent(blobSync)) return;
		if (blobSync.isUploadGateOpen) return;
		if (
			!this.downloadGateLayoutReady
			|| !this.downloadGateStartupReady
			|| !this.uploadAuthorityReady
		) return;
		this.deps.trace("trace", "blob-upload-gate-open", {
			reason,
			pendingUploads: blobSync.pendingUploads,
		});
		if (!this.isManagerAuthorityCurrent(blobSync)) return;
		blobSync.openUploadGate(reason);
		this.deps.scheduleTraceStateSnapshot(`blob-upload-gate:${reason}`);
	}
}
