import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import { ChunkedDocStore } from "./chunkedDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
	createSnapshot,
	hasSnapshotForDay,
	getLatestSnapshotIndex,
	verifySnapshotExists,
	applyRetention,
	type SnapshotResult,
} from "./snapshot";
import {
	applyRecoveryRetention,
	auditRecoveryStorage,
	createIndexedRecoverySnapshot,
	decodeRecoveryFileMeta,
	type PreparedFileHistoryPendingUpload,
	type RecoveryIndexSnapshot,
	type RecoveryStateEntry,
	type RecoveryStorageAuditStatus,
	type RecoverySnapshotResult,
} from "./recoverySnapshot";
import {
	appendTraceEntry,
	listRecentTraceEntries,
	prepareTraceEntryForStorage,
	TRACE_RATE_THROTTLE_EVENT,
	TraceRateLimiter,
	type TraceEntry as StoredTraceEntry,
} from "./traceStore";
import { trySendSvEchoStateVector, type SvEchoSendResult } from "./svEcho";
import { isUpdateBearingSyncMessage } from "./syncMessageClassifier";
import { bytesToHex } from "./hex";
import { sha256Hex } from "./hex";
import {
	PersistenceCoordinator,
	type PersistenceHealth,
} from "./persistenceCoordinator";
import {
	attachConnectionClientKind,
	buildUpdateObservedTraceData,
} from "./connectionMetadata";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[kaos-sync:server]";
// Keep file-history upload continuations modest so large bootstraps do not
// create sharp R2 request bursts; pending upload state resumes the next slice.
const RECOVERY_SNAPSHOT_CONTENT_UPLOAD_LIMIT = 500;
const RECOVERY_AUTOMATIC_BOOTSTRAP_FILE_LIMIT = 1000;
const RECOVERY_INDEX_KEY = "recovery:index:v1";
const RECOVERY_DIRTY_KEY = "recovery:dirty:v1";
const RECOVERY_SNAPSHOT_PENDING_UPLOAD_KEY = "recoverySnapshotPendingUpload";

/**
 * If a journal append fails, fall back to full checkpoint rewrite after this
 * many consecutive failures. Breaks the death spiral where the same large
 * delta fails repeatedly from a stale persisted state vector.
 */
const CHECKPOINT_FALLBACK_AFTER_FAILURES = 2;

/** Legacy storage key used before ChunkedDocStore was introduced. */
const LEGACY_DOCUMENT_KEY = "document";

type ServerTraceEntry = StoredTraceEntry;

interface ServerEnv {
	KAOS_BUCKET?: R2Bucket;
}

type SvEchoCounters = {
	baselineSent: number;
	postApplySent: number;
	failed: number;
	bytesTotal: number;
	bytesMax: number;
	failureNotOpen: number;
	failureOversize: number;
	failureSendFailed: number;
};

/** Server-level persistence health extends coordinator health with load-time fields. */
type ServerPersistenceHealth = PersistenceHealth & {
	loadedStateVectorHash: string | null;
	legacyDocumentMigrated: boolean;
};

type RecoveryIndexRecord = {
	storageVersion: "index-v1";
	manifestId: string | null;
	stateHash: string | null;
	entries: RecoveryStateEntry[];
	updatedAt: string;
};

type RecoveryDirtyRecord = {
	storageVersion: "dirty-v1";
	nextSeq: number;
	entries: Array<{ fileId: string; seq: number }>;
	updatedAt: string;
};

type RecoveryIndexHealth = "unknown" | "healthy" | "rebuilding";

function isRecoveryStateEntry(value: unknown): value is RecoveryStateEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RecoveryStateEntry>;
	return typeof candidate.fileId === "string" &&
		typeof candidate.path === "string" &&
		(candidate.contentHash === undefined || typeof candidate.contentHash === "string") &&
		(candidate.deleted === undefined || typeof candidate.deleted === "boolean") &&
		(candidate.size === undefined || typeof candidate.size === "number") &&
		(candidate.mtime === undefined || typeof candidate.mtime === "number") &&
		(candidate.device === undefined || typeof candidate.device === "string");
}

function isRecoveryIndexRecord(value: unknown): value is RecoveryIndexRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RecoveryIndexRecord>;
	return candidate.storageVersion === "index-v1" &&
		(candidate.manifestId === null || typeof candidate.manifestId === "string") &&
		(candidate.stateHash === null || typeof candidate.stateHash === "string") &&
		Array.isArray(candidate.entries) &&
		candidate.entries.every(isRecoveryStateEntry) &&
		typeof candidate.updatedAt === "string";
}

function isRecoveryDirtyRecord(value: unknown): value is RecoveryDirtyRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RecoveryDirtyRecord>;
	return candidate.storageVersion === "dirty-v1" &&
		Number.isInteger(candidate.nextSeq) &&
		(candidate.nextSeq ?? 0) >= 0 &&
		Array.isArray(candidate.entries) &&
		candidate.entries.every((entry) => (
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { fileId?: unknown }).fileId === "string" &&
			Number.isInteger((entry as { seq?: unknown }).seq) &&
			((entry as { seq: number }).seq) >= 0
		)) &&
		typeof candidate.updatedAt === "string";
}

function isPreparedFileHistoryPendingUpload(value: unknown): value is PreparedFileHistoryPendingUpload {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PreparedFileHistoryPendingUpload>;
	return candidate.storageVersion === "prepared-v1" &&
		typeof candidate.manifestId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.day === "string" &&
		typeof candidate.stateHash === "string" &&
		(candidate.previousStateHash === undefined || typeof candidate.previousStateHash === "string") &&
		(candidate.reason === "automatic" ||
			candidate.reason === "manual" ||
			candidate.reason === "pre-upgrade" ||
			candidate.reason === "pre-migration" ||
			candidate.reason === "pre-bulk-operation") &&
		typeof candidate.pinned === "boolean" &&
		(candidate.triggeredBy === undefined || typeof candidate.triggeredBy === "string") &&
		(candidate.crdtSchemaVersion === undefined || typeof candidate.crdtSchemaVersion === "number") &&
		Array.isArray(candidate.changedEntries) &&
		Array.isArray(candidate.contentHashes) &&
		candidate.contentHashes.every((hash) => typeof hash === "string") &&
		Array.isArray(candidate.contentQueue) &&
		candidate.contentQueue.every((entry) => (
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { hash?: unknown }).hash === "string" &&
			typeof (entry as { content?: unknown }).content === "string"
		)) &&
		Array.isArray(candidate.persistedState) &&
		candidate.persistedState.every(isRecoveryStateEntry) &&
		Array.isArray(candidate.processedDirtyFileIds) &&
		candidate.processedDirtyFileIds.every((fileId) => typeof fileId === "string") &&
		(candidate.dirtyWatermark === undefined ||
			(Number.isInteger(candidate.dirtyWatermark) && candidate.dirtyWatermark >= 0)) &&
		typeof candidate.uploadedContentCount === "number" &&
		Number.isInteger(candidate.uploadedContentCount) &&
		candidate.uploadedContentCount >= 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export class VaultSyncServer extends YServer {
	static options = {
		hibernate: true,
	};

	private documentLoaded = false;
	private loadPromise: Promise<void> | null = null;
	private roomIdHint: string | null = null;
	private chunkedDocStore: ChunkedDocStore | null = null;
	private persistence: PersistenceCoordinator | null = null;
	private documentUpdateListenerAttached = false;
	private snapshotMaintenanceChain: Promise<void> = Promise.resolve();
	private roomMeta: RoomMeta | null = null;
	private recoveryIndexLoaded = false;
	private recoveryIndexSnapshot: RecoveryIndexSnapshot | null = null;
	private recoveryIndexHealth: RecoveryIndexHealth = "unknown";
	private recoveryDirtyLoaded = false;
	private recoveryDirtyMarks = new Map<string, number>();
	private recoveryDirtySeq = 0;
	private recoveryDirtyFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private recoveryDirtyFlushPromise: Promise<void> | null = null;
	private recoveryIndexObserversAttached = false;
	private recoveryTextObservers = new Map<string, {
		ytext: Y.Text;
		handler: (event: unknown, transaction: Y.Transaction) => void;
	}>();
	private recoveryLastFullScanReason: string | null = null;
	private recoveryLastIncrementalChangedCount: number | null = null;
	private recoveryLastBuildMs: number | null = null;
	private recoveryLastHashCount: number | null = null;
	private recoveryLastUploadMs: number | null = null;
	private recoveryLastPendingProgress: {
		uploadedContentCount: number;
		totalContentCount: number;
		remainingContentCount: number;
	} | null = null;
	private readonly traceRateLimiter = new TraceRateLimiter();
	private readonly svEchoCounters: SvEchoCounters = {
		baselineSent: 0,
		postApplySent: 0,
		failed: 0,
		bytesTotal: 0,
		bytesMax: 0,
		failureNotOpen: 0,
		failureOversize: 0,
		failureSendFailed: 0,
	};
	/** Load-time health fields not owned by PersistenceCoordinator. */
	private loadedStateVectorHash: string | null = null;
	private legacyDocumentMigrated = false;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		await this.ensureDocumentLoaded();
		// Delegate to PersistenceCoordinator — the single source of truth
		// for save orchestration, fallback, and health tracking.
		//
		// onSave() intentionally does NOT throw on persistence failure.
		// Failure is represented by coordinator health state:
		//   status === "degraded"
		//   pendingPersistence === true
		//   lastSaveError set
		// These are surfaced via /__kaos/debug endpoint.
		// Throwing here would only produce unhandled rejection noise in the
		// y-partyserver framework without aiding recovery. The coordinator
		// handles retry via immediate checkpoint fallback on the next save.
		const coordinator = this.getPersistenceCoordinator();
		const result = await coordinator.enqueueSave();
		if (result.success) {
			const persistedStateVector = coordinator.getLastPersistedStateVector();
			if (persistedStateVector) {
				this.broadcastPersistedSvEcho(persistedStateVector);
			}
		} else {
			console.error(`${LOG_PREFIX} save failed (health: degraded, pendingPersistence: true):`, result.error);
		}
		await this.flushRecoveryDirtyMarks();
		await this.syncRoomMetaFromDocument();
	}

	async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		const clientKind = attachConnectionClientKind(connection, ctx.request);
		await super.onConnect(connection, ctx);
		console.debug(JSON.stringify({
			source: "kaos-sync/server",
			event: "server.connection.open",
			roomId: this.getRoomId(),
			clientKind,
		}));
		const persistedStateVector = this.getPersistenceCoordinator().getLastPersistedStateVector();
		if (persistedStateVector) {
			this.recordSvEchoResult(
				trySendSvEchoStateVector(connection, persistedStateVector, "baseline"),
			);
		}
	}

	handleMessage(connection: Connection, message: WSMessage): void {
		const shouldTraceUpdate = isUpdateBearingSyncMessage(message);
		const svBefore = shouldTraceUpdate ? Y.encodeStateVector(this.document) : null;
		super.handleMessage(connection, message);
		if (shouldTraceUpdate) {
			const svAfter = Y.encodeStateVector(this.document);
			const docChanged = svBefore !== null && !equalBytes(svBefore, svAfter);
			// Fire-and-forget trace: do not block message processing.
			void this.recordTrace(
				"server.ydoc.update_observed",
				buildUpdateObservedTraceData(connection, message, docChanged),
			);
		}
	}

	async fetch(request: Request): Promise<Response> {
		this.captureRoomIdHint(request);

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__kaos/meta") {
			return json({
				roomId: this.getRoomId(),
				meta: await this.readRoomMetaCheap(),
			});
		}

		if (request.method === "GET" && url.pathname === "/__kaos/document") {
			await this.ensureDocumentLoaded();
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/__kaos/debug") {
			// Do NOT call ensureDocumentLoaded() here (issue #40 fix).
			// Debug polling is periodic and must not trigger a checkpoint load
			// on every poll.  documentSummary is conditionally included only if
			// the document is already in memory.
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			const coordinator = this.getPersistenceCoordinator();
			const serverHealth: ServerPersistenceHealth = {
				...coordinator.health,
				loadedStateVectorHash: this.loadedStateVectorHash,
				legacyDocumentMigrated: this.legacyDocumentMigrated,
			};
			return json({
				roomId: this.getRoomId(),
				documentLoaded: this.documentLoaded,
				recent,
				svEcho: { ...this.svEchoCounters },
				persistence: serverHealth,
				recovery: this.recoveryDebugSummary(),
				documentSummary: this.documentLoaded ? this.getDocumentSummary() : null,
			});
		}

		if (request.method === "POST" && url.pathname === "/__kaos/trace") {
			let body: { event?: string; data?: Record<string, unknown> } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (!body.event || typeof body.event !== "string") {
				return json({ error: "missing event" }, 400);
			}

			await this.recordTrace(body.event, body.data ?? {});
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/__kaos/snapshot-maybe") {
			await this.ensureDocumentLoaded();
			let body: { device?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			return json(await this.createDailySnapshotMaybe(body.device));
		}

		if (request.method === "POST" && url.pathname === "/__kaos/recovery-snapshot-maybe") {
			let body: { device?: string; forceFull?: boolean } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			try {
				await this.ensureDocumentLoaded();
				return json(await this.createRecoverySnapshotMaybe(body.device, body.forceFull === true));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				try {
					await this.recordTrace("recovery-snapshot-failed", {
						error: message,
						forceFull: body.forceFull === true,
						triggeredBy: body.device,
					});
				} catch (traceErr) {
					console.warn(`${LOG_PREFIX} recovery snapshot failure trace failed:`, traceErr);
				}
				return json({
					status: "unavailable",
					reason: `File history point failed on the sync room: ${message}`,
				} satisfies RecoverySnapshotResult);
			}
		}

		// Legacy getServerByName() call sites use this framework route to install
		// the room name. PartyServer initializes YServer before answering it, so
		// cheap read-only probes must bypass getServerByName() entirely (see
		// routes/trace.ts). Document-owning routes still delegate normally here.
		const isPartyServerInternal = url.pathname.startsWith("/cdn-cgi/partyserver/");
		const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (isPartyServerInternal && !isWebSocketUpgrade) {
			return super.fetch(request);
		}

		await this.ensureDocumentLoaded();
		return super.fetch(request);
	}

	private async ensureRecoveryIndexLoaded(): Promise<void> {
		if (this.recoveryIndexLoaded) return;
		const raw = await this.ctx.storage.get<unknown>(RECOVERY_INDEX_KEY);
		if (isRecoveryIndexRecord(raw)) {
			this.recoveryIndexSnapshot = {
				manifestId: raw.manifestId,
				stateHash: raw.stateHash,
				entries: raw.entries,
			};
			this.recoveryIndexHealth = "healthy";
		} else {
			this.recoveryIndexSnapshot = null;
			this.recoveryIndexHealth = "unknown";
		}
		this.recoveryIndexLoaded = true;
	}

	private async writeRecoveryIndexSnapshot(snapshot: RecoveryIndexSnapshot): Promise<void> {
		const record: RecoveryIndexRecord = {
			storageVersion: "index-v1",
			manifestId: snapshot.manifestId,
			stateHash: snapshot.stateHash,
			entries: snapshot.entries,
			updatedAt: new Date().toISOString(),
		};
		await this.ctx.storage.put(RECOVERY_INDEX_KEY, record);
		this.recoveryIndexSnapshot = snapshot;
		this.recoveryIndexHealth = "healthy";
		this.recoveryIndexLoaded = true;
	}

	private async ensureRecoveryDirtyLoaded(): Promise<void> {
		if (this.recoveryDirtyLoaded) return;
		const raw = await this.ctx.storage.get<unknown>(RECOVERY_DIRTY_KEY);
		if (isRecoveryDirtyRecord(raw)) {
			this.recoveryDirtyMarks = new Map(raw.entries.map((entry) => [entry.fileId, entry.seq]));
			this.recoveryDirtySeq = raw.nextSeq;
		} else {
			this.recoveryDirtyMarks = new Map();
			this.recoveryDirtySeq = 0;
		}
		this.recoveryDirtyLoaded = true;
	}

	private scheduleRecoveryDirtyFlush(): void {
		if (this.recoveryDirtyFlushTimer) return;
		this.recoveryDirtyFlushTimer = setTimeout(() => {
			this.recoveryDirtyFlushTimer = null;
			void this.flushRecoveryDirtyMarks();
		}, 1000);
	}

	private async flushRecoveryDirtyMarks(): Promise<void> {
		if (!this.recoveryDirtyLoaded) return;
		if (this.recoveryDirtyFlushPromise) {
			await this.recoveryDirtyFlushPromise;
			return;
		}
		this.recoveryDirtyFlushPromise = (async () => {
			if (this.recoveryDirtyMarks.size === 0) {
				await this.ctx.storage.delete([RECOVERY_DIRTY_KEY]);
				return;
			}
			const record: RecoveryDirtyRecord = {
				storageVersion: "dirty-v1",
				nextSeq: this.recoveryDirtySeq,
				entries: Array.from(this.recoveryDirtyMarks, ([fileId, seq]) => ({ fileId, seq })),
				updatedAt: new Date().toISOString(),
			};
			await this.ctx.storage.put(RECOVERY_DIRTY_KEY, record);
		})().finally(() => {
			this.recoveryDirtyFlushPromise = null;
		});
		await this.recoveryDirtyFlushPromise;
	}

	private markRecoveryDirtyFileIds(fileIds: Iterable<string>): void {
		if (!this.recoveryDirtyLoaded) {
			// Observers are attached only after ensureRecoveryDirtyLoaded(), but keep
			// this guard so a future call site cannot accidentally create a partial
			// in-memory dirty set before storage is read.
			return;
		}
		let changed = false;
		for (const fileId of fileIds) {
			if (!fileId) continue;
			this.recoveryDirtySeq++;
			this.recoveryDirtyMarks.set(fileId, this.recoveryDirtySeq);
			changed = true;
		}
		if (changed) this.scheduleRecoveryDirtyFlush();
	}

	private captureRecoveryDirtySnapshot(): { fileIds: string[]; watermark: number } {
		return {
			fileIds: Array.from(this.recoveryDirtyMarks.keys()).sort(),
			watermark: this.recoveryDirtySeq,
		};
	}

	private async clearProcessedRecoveryDirtyFileIds(
		fileIds: string[],
		watermark: number,
	): Promise<void> {
		for (const fileId of fileIds) {
			const seq = this.recoveryDirtyMarks.get(fileId);
			if (seq !== undefined && seq <= watermark) {
				this.recoveryDirtyMarks.delete(fileId);
			}
		}
		await this.flushRecoveryDirtyMarks();
	}

	private observeRecoveryText(fileId: string, ytext: Y.Text): void {
		const existing = this.recoveryTextObservers.get(fileId);
		if (existing?.ytext === ytext) return;
		if (existing) {
			existing.ytext.unobserve(existing.handler);
		}
		const handler = (): void => {
			this.markRecoveryDirtyFileIds([fileId]);
		};
		ytext.observe(handler);
		this.recoveryTextObservers.set(fileId, { ytext, handler });
	}

	private unobserveRecoveryText(fileId: string): void {
		const existing = this.recoveryTextObservers.get(fileId);
		if (!existing) return;
		existing.ytext.unobserve(existing.handler);
		this.recoveryTextObservers.delete(fileId);
	}

	private async attachRecoveryIndexObservers(): Promise<void> {
		if (this.recoveryIndexObserversAttached) return;
		await this.ensureRecoveryDirtyLoaded();
		const meta = this.document.getMap<unknown>("meta");
		const idToText = this.document.getMap<Y.Text>("idToText");
		const pathToId = this.document.getMap<string>("pathToId");

		meta.observeDeep((events) => {
			const affected = new Set<string>();
			for (const event of events) {
				if (event.target === meta) {
					for (const [fileId] of event.changes.keys) {
						affected.add(fileId);
					}
				} else {
					const key = event.path[0];
					if (typeof key === "string") affected.add(key);
				}
			}
			this.markRecoveryDirtyFileIds(affected);
		});

		idToText.observe((event) => {
			const affected = new Set<string>();
			for (const [fileId, change] of event.changes.keys) {
				affected.add(fileId);
				if (change.action === "delete") {
					this.unobserveRecoveryText(fileId);
					continue;
				}
				const ytext = idToText.get(fileId);
				if (ytext) this.observeRecoveryText(fileId, ytext);
			}
			this.markRecoveryDirtyFileIds(affected);
		});

		pathToId.observe((event) => {
			const affected = new Set<string>();
			for (const [path, change] of event.changes.keys) {
				const nextFileId = pathToId.get(path);
				if (typeof nextFileId === "string") affected.add(nextFileId);
				if (typeof change.oldValue === "string") affected.add(change.oldValue);
			}
			this.markRecoveryDirtyFileIds(affected);
		});

		idToText.forEach((ytext, fileId) => {
			this.observeRecoveryText(fileId, ytext);
		});

		this.recoveryIndexObserversAttached = true;
	}

	private recoveryDebugSummary(): Record<string, unknown> {
		return {
			indexHealth: this.recoveryIndexHealth,
			indexLoaded: this.recoveryIndexLoaded,
			dirtyLoaded: this.recoveryDirtyLoaded,
			dirtyCount: this.recoveryDirtyMarks.size,
			dirtySeq: this.recoveryDirtySeq,
			automaticBootstrapFileLimit: RECOVERY_AUTOMATIC_BOOTSTRAP_FILE_LIMIT,
			indexEntryCount: this.recoveryIndexSnapshot?.entries.length ?? null,
			lastFullScanReason: this.recoveryLastFullScanReason,
			lastIncrementalChangedCount: this.recoveryLastIncrementalChangedCount,
			lastBuildMs: this.recoveryLastBuildMs,
			lastHashCount: this.recoveryLastHashCount,
			lastUploadMs: this.recoveryLastUploadMs,
			pending: this.recoveryLastPendingProgress,
		};
	}

	private recordSvEchoResult(result: SvEchoSendResult): void {
		if (result.ok) {
			if (result.kind === "baseline") this.svEchoCounters.baselineSent++;
			if (result.kind === "postApply") this.svEchoCounters.postApplySent++;
			this.svEchoCounters.bytesTotal += result.bytes;
			this.svEchoCounters.bytesMax = Math.max(this.svEchoCounters.bytesMax, result.bytes);
			return;
		}
		this.svEchoCounters.failed++;
		if (result.failure === "not_open") this.svEchoCounters.failureNotOpen++;
		if (result.failure === "oversize") this.svEchoCounters.failureOversize++;
		if (result.failure === "send_failed") this.svEchoCounters.failureSendFailed++;
	}

	private broadcastPersistedSvEcho(persistedStateVector: Uint8Array): void {
		for (const connection of this.getConnections()) {
			this.recordSvEchoResult(
				trySendSvEchoStateVector(connection, persistedStateVector, "postApply"),
			);
		}
	}

	private async ensureDocumentLoaded(): Promise<void> {
		if (this.documentLoaded) {
			this.attachDocumentUpdateListener();
			await this.attachRecoveryIndexObservers();
			return;
		}
		const gate = { inFlight: this.loadPromise };
		const run = runSingleFlight(gate, async () => {
			if (this.documentLoaded) return;

			const store = this.getChunkedDocStore();
			const state = await store.loadState();

			// First, load chunked state into a temporary doc to assess its richness
			const chunkedDoc = new Y.Doc();
			if (state.checkpoint) {
				Y.applyUpdate(chunkedDoc, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(chunkedDoc, update);
			}
			const chunkedPathCount = this.countActivePathsInDoc(chunkedDoc);

			// Legacy migration: check for pre-ChunkedDocStore "document" key.
			// Migrate if legacy has real content but chunked only has sentinel state.
			// The reporter's pathological shape was: legacy=full vault, chunked=2 tiny
			// sys/init entries. We must not let tiny chunked writes block migration.
			const legacyRaw = await this.ctx.storage.get<unknown>(LEGACY_DOCUMENT_KEY);
			let legacyBytes: Uint8Array | null = null;
				if (legacyRaw !== undefined) {
					if (legacyRaw instanceof Uint8Array) {
						legacyBytes = legacyRaw;
					} else if (legacyRaw instanceof ArrayBuffer) {
						legacyBytes = new Uint8Array(legacyRaw);
					} else if (ArrayBuffer.isView(legacyRaw)) {
						const view = legacyRaw;
						legacyBytes = new Uint8Array(
							view.buffer,
							view.byteOffset,
							view.byteLength,
						);
					}
				}

			if (legacyBytes && legacyBytes.byteLength > 0) {
				const legacyDoc = new Y.Doc();
				Y.applyUpdate(legacyDoc, legacyBytes);
				const legacyPathCount = this.countActivePathsInDoc(legacyDoc);
				const chunkedHasFileState = this.hasAnyFileStateInDoc(chunkedDoc);

				// Migrate if:
				// - legacy has real files
				// - chunked has no active paths
				// - chunked has no semantic file state (tombstones, pathToId, meta)
				// This prevents resurrecting deleted files if chunked has tombstones.
				if (legacyPathCount > 0 && chunkedPathCount === 0 && !chunkedHasFileState) {
					// Merge: apply legacy first, then chunked on top (to preserve any
					// sys/schema updates that may have happened in chunked)
					Y.applyUpdate(this.document, legacyBytes);
					if (state.checkpoint) {
						Y.applyUpdate(this.document, state.checkpoint);
					}
					for (const update of state.journalUpdates) {
						Y.applyUpdate(this.document, update);
					}
					// Persist merged state into chunked format
					const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
					const checkpointSV = Y.encodeStateVector(this.document);
					await store.rewriteCheckpoint(checkpointUpdate, checkpointSV);

					// Delete legacy key after successful migration — best-effort
					// If deletion fails, the room should still load from chunked checkpoint.
					try {
						await this.ctx.storage.delete([LEGACY_DOCUMENT_KEY]);
					} catch (deleteErr) {
						await this.recordTrace("legacy-document-delete-failed", {
							errorMessage: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
							note: "migration completed, room will load from chunked checkpoint",
						});
					}

					this.getPersistenceCoordinator().setInitialStateVector(checkpointSV);
					this.legacyDocumentMigrated = true;
					this.loadedStateVectorHash = bytesToHex(checkpointSV.slice(0, 16));
					this.getPersistenceCoordinator().health.journalEntryCount = 0;
					this.getPersistenceCoordinator().health.journalBytes = 0;
					this.documentLoaded = true;
					this.attachDocumentUpdateListener();
					await this.attachRecoveryIndexObservers();
					await this.syncRoomMetaFromDocument();
					await this.recordTrace("legacy-document-migrated", {
						legacyBytes: legacyBytes.byteLength,
						legacyPathCount,
						chunkedPathCount,
						chunkedHasFileState,
						chunkedJournalEntries: state.journalStats.entryCount,
						checkpointBytes: checkpointUpdate.byteLength,
					});
					legacyDoc.destroy();
					chunkedDoc.destroy();
					return;
				}
				legacyDoc.destroy();
			}

			// Normal path: use chunked state
			// (chunkedDoc already has the state, just copy to this.document)
			if (state.checkpoint) {
				Y.applyUpdate(this.document, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(this.document, update);
			}
			chunkedDoc.destroy();

			const loadedSV = (
				state.checkpointStateVector && state.journalUpdates.length === 0
			)
				? state.checkpointStateVector.slice()
				: Y.encodeStateVector(this.document);
			this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
			this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
			this.getPersistenceCoordinator().health.journalEntryCount = state.journalStats.entryCount;
			this.getPersistenceCoordinator().health.journalBytes = state.journalStats.totalBytes;
			this.documentLoaded = true;
			this.attachDocumentUpdateListener();
			await this.attachRecoveryIndexObservers();
			await this.syncRoomMetaFromDocument();
			await this.recordTrace("checkpoint-load", {
				hasCheckpoint: state.checkpoint !== null,
				checkpointStateVectorBytes: state.checkpointStateVector?.byteLength ?? 0,
				journalEntryCount: state.journalStats.entryCount,
				journalBytes: state.journalStats.totalBytes,
				replayMode:
					state.checkpoint !== null && state.journalUpdates.length > 0
						? "checkpoint+journal"
						: state.checkpoint !== null
							? "checkpoint-only"
							: state.journalUpdates.length > 0
								? "journal-only"
								: "empty",
			});
		});
		this.loadPromise = gate.inFlight;
		try {
			await run;
		} finally {
			this.loadPromise = gate.inFlight;
		}
	}

	/** Count active (non-deleted) paths in a Y.Doc using the KAOS schema. */
	private countActivePathsInDoc(doc: Y.Doc): number {
		const meta = doc.getMap("meta");
		let count = 0;
		meta.forEach((value: unknown) => {
			if (
				typeof value === "object"
				&& value !== null
				&& "path" in value
				&& typeof (value as { path: unknown }).path === "string"
			) {
				const m = value as { deleted?: boolean; deletedAt?: number };
				const isDeleted = m.deleted === true
					|| (typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt));
				if (!isDeleted) count++;
			}
		});
		return count;
	}

	private estimateRecoveryFileCount(): number {
		const meta = this.document.getMap<unknown>("meta");
		const pathToId = this.document.getMap<string>("pathToId");
		const idToText = this.document.getMap<Y.Text>("idToText");
		let activeMetaCount = 0;
		meta.forEach((value: unknown) => {
			const decoded = decodeRecoveryFileMeta(value);
			if (!decoded || typeof decoded.path !== "string" || decoded.path.length === 0) return;
			const isDeleted = decoded.deleted === true ||
				(typeof decoded.deletedAt === "number" && Number.isFinite(decoded.deletedAt));
			if (!isDeleted) activeMetaCount++;
		});
		return Math.max(activeMetaCount, pathToId.size, idToText.size);
	}

	/** Check if doc has any semantic file state: meta entries, pathToId, or idToText. */
	private hasAnyFileStateInDoc(doc: Y.Doc): boolean {
		const meta = doc.getMap("meta");
		if (meta.size > 0) return true;
		const pathToId = doc.getMap("pathToId");
		if (pathToId.size > 0) return true;
		const idToText = doc.getMap("idToText");
		if (idToText.size > 0) return true;
		return false;
	}

	private getChunkedDocStore(): ChunkedDocStore {
		if (!this.chunkedDocStore) {
			this.chunkedDocStore = new ChunkedDocStore(this.ctx.storage);
		}
		return this.chunkedDocStore;
	}

	private getPersistenceCoordinator(): PersistenceCoordinator {
		if (!this.persistence) {
			this.persistence = new PersistenceCoordinator(
				this.document,
				this.getChunkedDocStore(),
				(event, data) => {
					void this.recordTrace(`server.${event}`, data);
				},
				{
					checkpointFallbackAfterFailures: CHECKPOINT_FALLBACK_AFTER_FAILURES,
					journalCompactMaxEntries: JOURNAL_COMPACT_MAX_ENTRIES,
					journalCompactMaxBytes: JOURNAL_COMPACT_MAX_BYTES,
				},
			);
		}
		return this.persistence;
	}

	/** Decoded document summary for deployment validation and diagnostics. */
	private getDocumentSummary(): {
		activePathCount: number;
		tombstonedPathCount: number;
		metaCount: number;
		pathToIdCount: number;
		idToTextCount: number;
		/** Active meta entries that have a corresponding pathToId + idToText entry. */
		activePathsWithText: number;
		/** Active meta entries missing from pathToId. */
		activePathsMissingFromPathToId: number;
		/** Active meta entries with pathToId but missing idToText. */
		activePathsMissingText: number;
		/** pathToId entries that have no corresponding active meta entry. */
		pathToIdWithoutActiveMeta: number;
		schemaVersion: unknown;
	} {
		const meta = this.document.getMap("meta");
		const pathToId = this.document.getMap<string>("pathToId");
		const idToText = this.document.getMap("idToText");
		const schemaVersion = this.document.getMap("sys").get("schemaVersion") ?? null;
		const usesMetaPathModel = typeof schemaVersion === "number" && schemaVersion >= 2;

		let activePathCount = 0;
		let tombstonedPathCount = 0;
		let activePathsWithText = 0;
		let activePathsMissingFromPathToId = 0;
		let activePathsMissingText = 0;

		// Walk meta to count active/tombstoned and check consistency
		const activeMetaPaths = new Set<string>();
		meta.forEach((value: unknown, fileId: string) => {
			const decoded = decodeRecoveryFileMeta(value);
			if (!decoded || typeof decoded.path !== "string") return;
			const path = decoded.path;
			const isDeleted = decoded.deleted === true
				|| (typeof decoded.deletedAt === "number" && Number.isFinite(decoded.deletedAt));
			if (isDeleted) {
				tombstonedPathCount++;
			} else {
				activePathCount++;
				activeMetaPaths.add(path);
				if (usesMetaPathModel) {
					if (idToText.has(fileId)) {
						activePathsWithText++;
					} else {
						activePathsMissingText++;
					}
				} else {
					const id = pathToId.get(path);
					if (!id) {
						activePathsMissingFromPathToId++;
					} else if (!idToText.has(id)) {
						activePathsMissingText++;
					} else {
						activePathsWithText++;
					}
				}
			}
		});

		// Count pathToId entries without active meta
		let pathToIdWithoutActiveMeta = 0;
		pathToId.forEach((_id: string, path: string) => {
			if (!activeMetaPaths.has(path)) {
				pathToIdWithoutActiveMeta++;
			}
		});

		return {
			activePathCount,
			tombstonedPathCount,
			metaCount: meta.size,
			pathToIdCount: pathToId.size,
			idToTextCount: idToText.size,
			activePathsWithText,
			activePathsMissingFromPathToId,
			activePathsMissingText,
			pathToIdWithoutActiveMeta,
			schemaVersion,
		};
	}

	private async readRoomMetaCheap(): Promise<RoomMeta | null> {
		const stored = await readRoomMeta(this.ctx.storage);
		if (stored) {
			this.roomMeta = stored;
		}
		if (this.documentLoaded) {
			const liveSchemaVersion = this.currentSchemaVersion();
			if (!this.roomMeta || this.roomMeta.schemaVersion !== liveSchemaVersion) {
				const nextMeta: RoomMeta = {
					schemaVersion: liveSchemaVersion,
					updatedAt: new Date().toISOString(),
				};
				this.roomMeta = nextMeta;
				void this.syncRoomMetaFromDocument();
			}
		}
		return this.roomMeta;
	}

	private currentSchemaVersion(): number | null {
		const stored = this.document.getMap("sys").get("schemaVersion");
		if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
			return stored;
		}
		return null;
	}

	private async syncRoomMetaFromDocument(): Promise<void> {
		const nextSchemaVersion = this.currentSchemaVersion();
		if (this.roomMeta && this.roomMeta.schemaVersion === nextSchemaVersion) {
			return;
		}
		const nextMeta: RoomMeta = {
			schemaVersion: nextSchemaVersion,
			updatedAt: new Date().toISOString(),
		};
		try {
			await writeRoomMeta(this.ctx.storage, nextMeta);
			this.roomMeta = nextMeta;
		} catch (err) {
			console.error(`${LOG_PREFIX} room meta persist failed:`, err);
		}
	}

	private async createDailySnapshotMaybe(
		triggeredBy?: string,
	): Promise<SnapshotResult> {
		const serialized = { chain: this.snapshotMaintenanceChain };
		const run = runSerialized(
			serialized,
			async () => {
				const bucket = (this.env as ServerEnv).KAOS_BUCKET;
				if (!bucket) {
					return {
						status: "unavailable",
						reason: "R2 bucket not configured",
					} satisfies SnapshotResult;
				}

				const vaultId = this.getRoomId();

				// Dedup: skip if the full encoded CRDT (including delete set) is unchanged.
				// We use fullUpdateHash because Yjs state vectors do NOT track deletions.
				// A state-vector-only check would miss delete-only changes, which is
				// catastrophic for a recovery system.
				//
				// Cost: O(doc size) to encode + hash. Acceptable at daily frequency.
				const latest = await getLatestSnapshotIndex(vaultId, bucket);
				if (latest?.fullUpdateHash) {
					const rawUpdate = Y.encodeStateAsUpdate(this.document);
					const currentHash = await sha256Hex(rawUpdate);
					if (latest.fullUpdateHash === currentHash) {
						// Before skipping: verify the pointed snapshot actually exists.
						// A poisoned latest pointer (payload never written) would
						// otherwise cause us to skip forever.
						const exists = await verifySnapshotExists(vaultId, latest, bucket);
						if (exists) {
							return {
								status: "noop",
								reason: "No changes since last snapshot (full CRDT state identical)",
							} satisfies SnapshotResult;
						}
						// Pointer is poisoned — fall through to create a new snapshot.
						// The precomputed update is still valid, pass it along.
					}
					// Hash changed — create snapshot. Pass precomputed values to avoid re-encoding.
					const index = await createSnapshot(
						this.document,
						vaultId,
						bucket,
						{
							triggeredBy,
							reason: "daily",
							pinned: false,
							precomputedRawUpdate: rawUpdate,
							precomputedFullUpdateHash: currentHash,
						},
					);

					// Retention: await so failures are observable.
					try {
						const retentionResult = await applyRetention(vaultId, bucket);
						if (retentionResult.failed > 0) {
							console.error(
								`${LOG_PREFIX} retention: ${retentionResult.failed} delete(s) failed:`,
								retentionResult.errors.slice(0, 5),
							);
						}
					} catch (err) {
						console.error(`${LOG_PREFIX} retention failed:`, err);
					}

					return {
						status: "created",
						snapshotId: index.snapshotId,
						index,
					} satisfies SnapshotResult;
				// eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy snapshots only have stateVectorHash; this path intentionally forces a fresh fullUpdateHash snapshot.
				} else if (latest?.stateVectorHash) {
					// Transitional: old snapshot has stateVectorHash but no fullUpdateHash.
					// Cannot safely skip — state vector misses deletes.
					// Fall through to create a new snapshot with fullUpdateHash.
				} else if (latest) {
					// Ancient legacy path: no hash fields at all. Day-based dedup.
					const currentDay = new Date().toISOString().slice(0, 10);
					if (await hasSnapshotForDay(vaultId, currentDay, bucket)) {
						return {
							status: "noop",
							reason: `Snapshot already taken today (${currentDay})`,
						} satisfies SnapshotResult;
					}
				}

				const index = await createSnapshot(
					this.document,
					vaultId,
					bucket,
					{ triggeredBy, reason: "daily", pinned: false },
				);

				// Retention: await so failures are observable.
				try {
					const retentionResult = await applyRetention(vaultId, bucket);
					if (retentionResult.failed > 0) {
						console.error(
							`${LOG_PREFIX} retention: ${retentionResult.failed} delete(s) failed:`,
							retentionResult.errors.slice(0, 5),
						);
					}
				} catch (err) {
					console.error(`${LOG_PREFIX} retention failed:`, err);
				}

				return {
					status: "created",
					snapshotId: index.snapshotId,
					index,
				} satisfies SnapshotResult;
			},
		);
		this.snapshotMaintenanceChain = serialized.chain;
		return await run;
	}

	private async createRecoverySnapshotMaybe(
		triggeredBy?: string,
		forceFull = false,
	): Promise<RecoverySnapshotResult> {
		const serialized = { chain: this.snapshotMaintenanceChain };
		const run = runSerialized(
			serialized,
			async () => {
				const bucket = (this.env as ServerEnv).KAOS_BUCKET;
				if (!bucket) {
					return {
						status: "unavailable",
						reason: "R2 bucket not configured",
					} satisfies RecoverySnapshotResult;
				}

				const vaultId = this.getRoomId();
				await this.ensureRecoveryIndexLoaded();
				await this.ensureRecoveryDirtyLoaded();

				const pendingRaw = await this.ctx.storage.get<unknown>(RECOVERY_SNAPSHOT_PENDING_UPLOAD_KEY);
				const pendingUpload = isPreparedFileHistoryPendingUpload(pendingRaw) ? pendingRaw : null;
				if (pendingRaw !== undefined && !pendingUpload) {
					await this.ctx.storage.delete(RECOVERY_SNAPSHOT_PENDING_UPLOAD_KEY);
				}
				let auditStatus: RecoveryStorageAuditStatus | null = null;
				if (!pendingUpload) {
					try {
						const audit = await auditRecoveryStorage(vaultId, bucket, {
							repair: true,
							contentCheckLimit: 0,
						});
						auditStatus = audit.status;
						const successfulRepairs = audit.repairs.filter((repair) => repair.success);
						if (successfulRepairs.length > 0) {
							await this.recordTrace("recovery-storage-repaired", {
								status: audit.status,
								latestManifestId: audit.latestManifestId,
								latestIndexManifestId: audit.latestIndexManifestId,
								latestStateManifestId: audit.latestStateManifestId,
								issueCount: audit.issues.length,
								repairCount: successfulRepairs.length,
								repairKinds: successfulRepairs.map((repair) => repair.kind).slice(0, 20),
							});
						}
						if (audit.status === "degraded") {
							await this.recordTrace("recovery-storage-degraded", {
								status: audit.status,
								latestManifestId: audit.latestManifestId,
								issueCount: audit.issues.length,
								unrepairedIssueKinds: audit.issues
									.filter((issue) => !issue.repaired)
									.map((issue) => issue.kind)
									.slice(0, 20),
							});
						}
					} catch (err) {
						auditStatus = "degraded";
						await this.recordTrace("recovery-storage-degraded", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}

				const dirtySnapshot = this.captureRecoveryDirtySnapshot();
				const trustCleanIndex = !forceFull &&
					!pendingUpload &&
					this.recoveryIndexHealth === "healthy" &&
					this.recoveryIndexSnapshot !== null &&
					(auditStatus === null ||
						auditStatus === "healthy" ||
						auditStatus === "repaired" ||
						auditStatus === "empty");

				if (!pendingUpload && !trustCleanIndex && !forceFull) {
					const estimatedFileCount = this.estimateRecoveryFileCount();
					if (estimatedFileCount > RECOVERY_AUTOMATIC_BOOTSTRAP_FILE_LIMIT) {
						const fullScanReason = this.recoveryIndexSnapshot
							? "automatic_full_scan_deferred_index_untrusted"
							: "automatic_full_scan_deferred_index_missing";
						this.recoveryLastFullScanReason = fullScanReason;
						this.recoveryLastIncrementalChangedCount = 0;
						this.recoveryLastBuildMs = 0;
						this.recoveryLastHashCount = 0;
						this.recoveryLastUploadMs = 0;
						this.recoveryLastPendingProgress = null;
						await this.recordTrace("recovery-snapshot-bootstrap-deferred", {
							reason: fullScanReason,
							estimatedFileCount,
							limit: RECOVERY_AUTOMATIC_BOOTSTRAP_FILE_LIMIT,
							indexHealth: this.recoveryIndexHealth,
							dirtyCount: dirtySnapshot.fileIds.length,
							auditStatus,
						});
						return {
							status: "noop",
							reason: `File history index bootstrap deferred for large vault (${estimatedFileCount} files); create a manual file history point to initialize it.`,
						} satisfies RecoverySnapshotResult;
					}
				}

				const indexed = await createIndexedRecoverySnapshot(
					this.document,
					vaultId,
					bucket,
					{
						triggeredBy,
						forceFull,
						reason: "automatic",
						pinned: false,
						contentUploadLimit: RECOVERY_SNAPSHOT_CONTENT_UPLOAD_LIMIT,
						indexSnapshot: this.recoveryIndexSnapshot,
						dirtyFileIds: dirtySnapshot.fileIds,
						trustCleanIndex,
						pendingUpload,
					},
				);
				const result = indexed.result;
				this.recoveryLastFullScanReason = indexed.fullScanReason;
				this.recoveryLastIncrementalChangedCount = indexed.metrics.changedCount;
				this.recoveryLastBuildMs = indexed.metrics.buildMs;
				this.recoveryLastHashCount = indexed.metrics.hashedFileCount;
				this.recoveryLastUploadMs = indexed.metrics.uploadMs;
				this.recoveryLastPendingProgress = result.status === "pending" && result.pending
					? result.pending
					: null;

				if (result.status === "pending" && result.pending && result.pendingUpload) {
					const prepared = indexed.preparedPendingUpload
						? {
							...indexed.preparedPendingUpload,
							dirtyWatermark: pendingUpload?.dirtyWatermark ?? dirtySnapshot.watermark,
						} satisfies PreparedFileHistoryPendingUpload
						: null;
					if (prepared) {
						await this.ctx.storage.put(RECOVERY_SNAPSHOT_PENDING_UPLOAD_KEY, prepared);
					}
					await this.recordTrace("recovery-snapshot-upload-pending", {
						manifestId: result.manifestId,
						uploadedContentCount: result.pending.uploadedContentCount,
						totalContentCount: result.pending.totalContentCount,
						remainingContentCount: result.pending.remainingContentCount,
					});
					return result;
				}
				await this.ctx.storage.delete(RECOVERY_SNAPSHOT_PENDING_UPLOAD_KEY);
				if (indexed.nextIndexSnapshot) {
					await this.writeRecoveryIndexSnapshot(indexed.nextIndexSnapshot);
				}
				const dirtyWatermark = pendingUpload?.dirtyWatermark ?? dirtySnapshot.watermark;
				if (indexed.processedDirtyFileIds.length > 0) {
					await this.clearProcessedRecoveryDirtyFileIds(indexed.processedDirtyFileIds, dirtyWatermark);
				}
				if (result.status === "created" && result.index?.kind === "file-history") {
					try {
						await applyRecoveryRetention(this.getRoomId(), bucket);
					} catch (err) {
						await this.recordTrace("recovery-retention-failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return result;
			},
		);
		this.snapshotMaintenanceChain = serialized.chain;
		return await run;
	}

	private async recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		// INV-OBS-02: per-room budget. Drop over-budget events; surface the
		// drop count via a single throttled-summary entry the next time an
		// admit succeeds. Throttle-summary entries themselves bypass the
		// rate limiter (otherwise drops could become unobservable).
		const isThrottleSummary = event === TRACE_RATE_THROTTLE_EVENT;
		if (!isThrottleSummary && !this.traceRateLimiter.admit()) {
			return;
		}

		const entry: ServerTraceEntry = prepareTraceEntryForStorage({
			...data,
			ts: new Date().toISOString(),
			event,
			roomId: this.getRoomId(),
		});

		console.debug(JSON.stringify({
			source: "kaos-sync/server",
			...entry,
		}));

		try {
			await appendTraceEntry(this.ctx.storage, entry, MAX_DEBUG_TRACE_EVENTS);
		} catch (err) {
			console.error(`${LOG_PREFIX} trace persist failed:`, err);
		}

		// Drain accumulated drops as a single bounded summary.
		if (!isThrottleSummary) {
			const dropped = this.traceRateLimiter.drainDropped();
			if (dropped > 0) {
				await this.recordTrace(TRACE_RATE_THROTTLE_EVENT, { dropped });
			}
		}
	}

	private attachDocumentUpdateListener(): void {
		if (this.documentUpdateListenerAttached) return;
		this.documentUpdateListenerAttached = true;
		this.document.on("update", (update: Uint8Array) => {
			this.getPersistenceCoordinator().recordIncrementalUpdate(update);
		});
	}

	private getRoomId(): string {
		try {
			const candidate = (this as unknown as { name?: unknown }).name;
			if (typeof candidate === "string" && candidate.length > 0) {
				return candidate;
			}
		} catch {
			// Some workerd runtimes can throw while accessing `.name` before set-name.
		}
		return this.roomIdHint ?? "unknown";
	}

	private captureRoomIdHint(request: Request): void {
		const headerRoom = request.headers.get("x-partykit-room");
		if (headerRoom && headerRoom.length > 0) {
			this.roomIdHint = headerRoom;
		}
	}
}

export default VaultSyncServer;
