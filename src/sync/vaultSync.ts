import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { normalizePath } from "obsidian";
import {
	blobRefFingerprint,
	cloneBlobRef,
	createCausalBlobRef,
	isSha256Hex,
	sameBlobRef,
	type BlobRef,
	type BlobMeta,
	type BlobTombstone,
} from "../types";
import {
	decodeFileMeta,
	getMetaPath,
	isFileMetaDeletedValue,
	ensureNestedMetaEntry,
	createNestedActiveMeta,
	buildMetaSnapshot,
	computeMetaSemanticChanges,
	computeMetaShapeStats,
	extractAffectedFileIds,
	computeIncrementalMetaChanges,
	type DecodedFileMeta,
	type MetaSemanticChange,
	type MetaChangeBatch,
	type MetaShapeStats,
} from "./fileMeta";
import { ORIGIN_SEED, isLocalOrigin } from "./origins";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext, TraceRecord } from "../observability/traceContext";
import { randomBase64Url } from "../utils/base64url";
import { formatUnknown } from "../utils/format";
import { UpdateTracker } from "./updateTracker";
import { ServerAckTracker } from "./serverAckTracker";
import { IndexedDbCandidateStore, getOrCreateLocalDeviceId, sha256Hex } from "./indexedDbCandidateStore";
import {
	createSvEchoCounters,
	handleSvEchoCustomMessage,
	type SvEchoCounters,
} from "./svEchoMessage";
import {
	evaluatePathBindingIntegrity,
	type PathBindingIntegrityInput,
	type PathBindingIntegrityResult,
} from "./pathBindingIntegrity";
import type { CandidateStore, ScopeKey, ScopeMetadata } from "./candidateStore";
import { FLIGHT_KIND } from "../telemetry/debug/flightEvents";
import type { FlightPathEventInput } from "../telemetry/debug/flightEvents";
import {
	SocketTicketHttpError,
	TICKET_REFRESH_BUFFER_MS,
	patchTicketInUrl,
	socketTicketRetryDelayMs,
} from "./socketTicket";
import type { PendingBlobMutationBase } from "./pendingBlobIntentJournal";

export interface BlobRefCommitGuard {
	/** Exact authoritative ref that must still occupy the path at commit. */
	expectedCurrentRef: BlobRef | undefined;
	/** Exact Y.Map item episode for expectedCurrentRef. */
	expectedCurrentSourceVersion?: string;
	/** Settled disk/ref authority on which the local content was based. */
	causalBaseRef: BlobRef | undefined;
}

export interface BlobRefCommitResult {
	ref: BlobRef;
	/** Exact Y.Map item episode created by this guarded commit. */
	sourceVersion: string;
}

export type BlobRenameResult =
	| { kind: "missing-source" }
	| { kind: "same-path"; ref: BlobRef }
	| { kind: "moved"; ref: BlobRef }
	| { kind: "destination-conflict"; sourceRef: BlobRef; destinationRef: BlobRef };

export type BlobDeleteCommitResult =
	| { kind: "deleted"; ref: BlobRef }
	| { kind: "already-absent" }
	| { kind: "unknown-source"; currentRef: BlobRef | undefined }
	| {
		kind: "source-conflict";
		expectedRef: BlobRef | undefined;
		currentRef: BlobRef | undefined;
		/** True when our transaction mutated before a synchronous re-entrant revival. */
		mutationApplied?: boolean;
	};

export type CausalBlobRenameResult = BlobRenameResult
	| { kind: "already-absent" }
	| { kind: "unknown-source"; currentRef: BlobRef | undefined }
	| {
		kind: "source-conflict";
		expectedRef: BlobRef | undefined;
		currentRef: BlobRef | undefined;
		mutationApplied?: boolean;
	};

type ProviderWithTerminableSocket = {
	ws?: {
		terminate?: () => void;
	};
};

interface SocketTicketValue {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

type SocketTicketRetryKind = "refresh" | "connect" | "auth";

/** Current schema version. Stored in sys.schemaVersion. */
export { SCHEMA_VERSION } from "./schema";
import { SCHEMA_VERSION } from "./schema";

/** Timeouts for the startup sequence. */
const LOCAL_PERSISTENCE_TIMEOUT_MS = 3_000;
const PROVIDER_SYNC_TIMEOUT_MS = 10_000;

/**
 * Reconnection config.
 * y-partyserver uses `2^n * 100ms` capped at `maxBackoffTime`.
 * Default is 2500ms which is aggressive for mobile. We raise it to 30s
 * and the natural jitter from network latency + varying reconnect
 * timing provides sufficient de-correlation.
 */
const MAX_BACKOFF_TIME_MS = 30_000;

/** Debounce window for batching rename events (folder renames). */
const RENAME_BATCH_MS = 50;

/** Reconciliation mode determines what operations are safe. */
export type ReconcileMode = "conservative" | "authoritative";

export type EnsureFileResult =
	| { kind: "existing"; fileId: string; ytext: Y.Text }
	| { kind: "created"; fileId: string; ytext: Y.Text }
	| { kind: "replan"; reason: "active-set-changed" }
	| { kind: "blocked"; reason: "orphan" | "collision" | "tombstone" | "policy" };

type ActivePathClassification =
	| { kind: "empty" }
	| { kind: "healthy"; fileId: string; ytext: Y.Text }
	| { kind: "orphan"; fileId: string }
	| { kind: "collision"; fileIds: readonly string[] };

interface EnsureFileOptions {
	reviveTombstone?: boolean;
	reviveReason?: string;
	opId?: string;
	/** Final caller-owned creation policy, evaluated without VaultSync mutation. */
	canCreate?: () => boolean;
}

/** Canonical metadata for one Markdown tombstone in an authoritative delete snapshot. */
export interface MarkdownRemoteDeleteTombstoneSnapshot {
	readonly fileId: string;
	readonly deletedAt: number | null;
	readonly device: string | null;
}

/**
 * A point-in-time, authoritative view of a remotely deleted Markdown path.
 *
 * `fingerprint` is deterministic for the normalized path and the complete,
 * sorted tombstone set. Callers can take a snapshot before an async operation
 * and compare it with a fresh snapshot immediately before committing a
 * destructive resolution.
 */
export interface MarkdownRemoteDeleteSnapshot {
	readonly kind: "markdown";
	readonly path: string;
	readonly tombstones: readonly MarkdownRemoteDeleteTombstoneSnapshot[];
	readonly fingerprint: string;
}

/** A point-in-time, authoritative view of a remotely deleted blob path. */
export interface BlobRemoteDeleteSnapshot {
	readonly kind: "blob";
	readonly path: string;
	readonly deletedAt: number;
	readonly device: string | null;
	readonly deletedRef: BlobRef | undefined;
	readonly fingerprint: string;
}

type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

interface FatalAuthMessage {
	code: FatalAuthCode;
	clientSchemaVersion: number | null;
	roomSchemaVersion: number | null;
	reason: string | null;
}

const FATAL_AUTH_CODES = new Set<FatalAuthCode>([
	"unauthorized",
	"server_misconfigured",
	"unclaimed",
	"update_required",
]);

function parseFatalAuthMessage(payload: string): FatalAuthMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "error") return null;
	if (typeof record.code !== "string" || !FATAL_AUTH_CODES.has(record.code as FatalAuthCode)) {
		return null;
	}
	return {
		code: record.code as FatalAuthCode,
		clientSchemaVersion:
			typeof record.clientSchemaVersion === "number" && Number.isInteger(record.clientSchemaVersion)
				? record.clientSchemaVersion
				: null,
		roomSchemaVersion:
			typeof record.roomSchemaVersion === "number" && Number.isInteger(record.roomSchemaVersion)
				? record.roomSchemaVersion
				: null,
		reason: typeof record.reason === "string" ? record.reason : null,
	};
}

type IndexedDbErrorKind =
	| "quota_exceeded"
	| "blocked"
	| "permission"
	| "unknown";

interface IndexedDbErrorDetails {
	kind: IndexedDbErrorKind;
	name: string | null;
	message: string | null;
	phase: "open" | "wait" | "runtime";
	at: string;
}

type ServerReceiptStartupValidation =
	| "not_started"
	| "validated"
	| "skipped_local_yjs_timeout"
	| "unavailable";

/**
 * Manages the vault-wide Y.Doc, the Worker sync provider, IndexedDB
 * persistence, and the shared Yjs maps.
 *
 * Schema:
 *   pathToId:        Y.Map<string>         — vault-relative path -> stable fileId (markdown)
 *   idToText:        Y.Map<Y.Text>         — fileId -> Y.Text (markdown content)
 *   meta:            Y.Map<FileMeta>       — fileId -> metadata { path, deleted?, mtime? }
 *   sys:             Y.Map<any>            — sentinel/bookkeeping { initialized, lastSync }
 *   pathToBlob:      Y.Map<BlobRef>        — vault-relative path -> { hash, size }
 *   blobMeta:        Y.Map<BlobMeta>       — sha256 hex -> { size, mime, createdAt }
 *   blobTombstones:  Y.Map<BlobTombstone>  — vault-relative path -> { deletedAt, device? }
 */
export class VaultSync {
	readonly ydoc: Y.Doc;
	readonly provider: YSyncProvider;
	readonly persistence: IndexeddbPersistence;
	readonly updateTracker: UpdateTracker;
	readonly serverAckTracker: ServerAckTracker;

	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
	readonly sys: Y.Map<unknown>;

	// Blob / attachment maps (additive — schema version stays at 1)
	readonly pathToBlob: Y.Map<BlobRef>;
	readonly blobMeta: Y.Map<BlobMeta>;
	readonly blobTombstones: Y.Map<BlobTombstone>;

	/**
	 * In-memory reverse map: Y.Text instance -> fileId.
	 * Populated when texts are created/resolved. WeakMap so GC'd
	 * Y.Text instances don't leak. Used by DiskMirror for O(1)
	 * reverse lookups instead of scanning idToText.
	 */
	private _textToFileId = new WeakMap<Y.Text, string>();
	private _pathIndex = new Map<string, string>(); // path -> fileId (active only)
	private _deletedPathIndex = new Set<string>(); // tombstoned paths
	private _activePathCollisions = new Map<string, string[]>(); // active path -> all competing fileIds
	private _pathIndexesDirty = true;

	/**
	 * Snapshot of decoded metadata used by the semantic observer.
	 * Maintained by `_metaDeepObserver` and used to compute semantic diffs.
	 */
	private _metaSnapshot = new Map<string, DecodedFileMeta>();

	/**
	 * Counts how many times the `_metaDeepObserver` fell back to a full snapshot diff
	 * because event paths were ambiguous. Should be zero in normal operation.
	 * Exposed in debug stats so operators can confirm the incremental path is taken.
	 */
	private _metaObserverFallbackCount = 0;
	private _metaSemanticListeners = new Set<(batch: MetaChangeBatch) => void>();

	/**
	 * The single shared `observeDeep` handler on the meta map.
	 *
	 * Uses incremental diffing: reads event paths to determine which fileIds
	 * changed, then decodes only those entries. Falls back to a full snapshot
	 * diff only if event paths are ambiguous.
	 *
	 * Preserves transaction origin so consumers can distinguish local from remote.
	 */
	private _metaDeepObserver = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
			const origin: unknown = events[0]?.transaction.origin;
		const isLocal = isLocalOrigin(origin, this.provider);

		let changes: MetaSemanticChange[];

		// Try incremental diff first (O(k) where k = affected entries).
		const affected = extractAffectedFileIds(events, this.meta);
		if (affected !== null) {
			changes = computeIncrementalMetaChanges(this._metaSnapshot, this.meta, affected);
		} else {
			// Fallback: full snapshot diff (O(N)). Increment counter for observability.
			this._metaObserverFallbackCount++;
			const nextSnapshot = buildMetaSnapshot(this.meta);
			changes = computeMetaSemanticChanges(this._metaSnapshot, nextSnapshot);
			this._metaSnapshot = nextSnapshot;
		}

		if (changes.length === 0) return;

		// Invalidate path indexes for structural changes only.
		for (const change of changes) {
			if (change.kind !== "mtime-changed" && change.kind !== "device-changed") {
				this._pathIndexesDirty = true;
				break;
			}
		}

		// Dispatch to all registered listeners.
		if (this._metaSemanticListeners.size > 0) {
			const batch: MetaChangeBatch = { origin, isLocal, changes };
			for (const listener of this._metaSemanticListeners) {
				listener(batch);
			}
		}
	};

	private _localReady = false;
	private _providerSynced = false;

	/**
	 * Increments each time the provider connects. Used to distinguish
	 * first connect (gen 0) from reconnects (gen > 0).
	 */
	private _connectionGeneration = 0;
	private _providerSyncWaiters = new Set<(value: boolean) => void>();

	/**
	 * True if the server sent an explicit auth error message.
	 * When set, the plugin should stop reconnecting.
	 */
	private _fatalAuthError = false;
	private _fatalAuthCode: "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required" | null = null;
	private _fatalAuthDetails: {
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	} | null = null;

	/** True if IndexedDB encountered an error (unavailable, quota, etc). */
	private _idbError = false;
	private _idbErrorDetails: IndexedDbErrorDetails | null = null;
	private _serverAckStore: CandidateStore | null = null;
	private _serverAckScope: (ScopeKey & ScopeMetadata) | null = null;
	private _serverAckPersistenceUnavailable = false;
	private _serverReceiptStartupValidation: ServerReceiptStartupValidation = "not_started";
	private readonly _svEchoCounters = createSvEchoCounters();

	/** Buffered renames for batch flush. */
	private _renameBatch: Map<string, string> = new Map(); // oldPath -> newPath
	private _renameBatchNewToOld: Map<string, string> = new Map(); // newPath -> oldPath
	private _renameTimer: ReturnType<typeof setTimeout> | null = null;
	/** Callback invoked after a rename batch is flushed. */
	private _onRenameBatchFlushed: ((renames: Map<string, string>) => void) | null = null;

	private readonly _device: string | undefined;
	private readonly debug: boolean;
	private _eventRing: Array<{ ts: string; msg: string }> = [];
	private readonly trace?: TraceRecord;
	private readonly onFlightEvent?: (event: Record<string, unknown>) => void;
	private readonly onFlightPathEvent?: (event: FlightPathEventInput) => void;

	/**
	 * Stored callback for obtaining (and force-refreshing) short-lived tickets.
	 * Kept on the instance so the proactive refresh timer can call it after
	 * the constructor's params() closure is no longer in scope.
	 */
	private _getSocketTicket: ((force?: boolean) => Promise<SocketTicketValue | null>) | null = null;

	/** Timer handle for the proactive provider URL ticket refresh. */
	private _socketTicketRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private _socketTicketRefreshFailureCount = 0;
	private _socketTicketConnectRetryFailureCount = 0;
	private _socketTicketRefreshInFlight = false;
	private _socketTicketRetryScheduled = false;
	private _socketTicketRetryKind: SocketTicketRetryKind | null = null;
	private _socketTicketRefreshPendingForOnline = false;
	private _socketTicketOnlineHandler: (() => void) | null = null;
	private _socketTicketConnectionWanted = false;
	private _socketTicketConnectionIntentEpoch = 0;
	private _socketTicketConnectInFlight: Promise<void> | null = null;
	private _socketTicketConnectInFlightIntentEpoch: number | null = null;
	private _socketTicketRequestInFlight: Promise<SocketTicketValue | null> | null = null;
	private _socketTicketRequestInFlightForce = false;
	private _socketTicketForcedRequestQueued: Promise<SocketTicketValue | null> | null = null;
	private _socketTicketRawDisconnect: (() => void) | null = null;
	private _socketAuthRecoveryInFlight = false;
	private _socketAuthRecoveryAttempted = false;
	private _socketAuthRecoveryReconnectStarted = false;
	private _socketAuthRecoveryMessage: FatalAuthMessage | null = null;
	private _socketAuthRecoveryIntentEpoch: number | null = null;
	/** Exact rejected socket whose auth-triggered raw close must be ignored once. */
	private _socketAuthRecoveryRejectedSocket: object | null = null;
	/** Dedupes connection-close and its immediately following disconnected status. */
	private _socketTicketConnectionCloseStatusPending = false;
	/** A disconnected provider is waiting for a fresh URL or a bounded connect retry. */
	private _socketTicketDisconnectRecoveryPending = false;
	/** Socket-open is not success: only sync(true) re-arms one immediate reconnect. */
	private _socketTicketReconnectAttemptedSinceSync = false;
	private _destroyed = false;

	constructor(
		settings: VaultSyncSettings,
		options?: {
			traceContext?: TraceHttpContext;
			trace?: TraceRecord;
			onFlightEvent?: (event: Record<string, unknown>) => void;
			onFlightPathEvent?: (event: FlightPathEventInput) => void;
			/**
			 * Optional callback returning a short-lived WebSocket ticket.
			 * Called once during initial connection via async params().
			 * After that, VaultSync proactively refreshes provider.url via a
			 * timer so reconnects always find a live ticket — y-partyserver's
			 * internal reconnect loop reuses provider.url directly without
			 * re-calling params().
			 *
			 * Pass force=true to bypass the ticket cache and always fetch fresh.
			 * If the callback returns null the provider falls back to ?token=.
			 */
				getSocketTicket?: (force?: boolean) => Promise<SocketTicketValue | null>;
		},
	) {
		this.debug = settings.debug;
		this._device = settings.deviceName || undefined;
		this.trace = options?.trace;
		this.onFlightEvent = options?.onFlightEvent;
		this.onFlightPathEvent = options?.onFlightPathEvent;

		this.ydoc = new Y.Doc();
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.idToText = this.ydoc.getMap<Y.Text>("idToText");
		this.meta = this.ydoc.getMap("meta");
		this.sys = this.ydoc.getMap("sys");

		this.pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
		this.blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
		this.blobTombstones = this.ydoc.getMap<BlobTombstone>("blobTombstones");

		// Single shared observeDeep handler. Computes semantic diffs and dispatches
		// to listeners. Also drives path index invalidation so we only dirty it
		// for structurally relevant changes (not mtime/device churn).
		this._metaSnapshot = buildMetaSnapshot(this.meta);
		this.meta.observeDeep(this._metaDeepObserver);

		const roomId = settings.vaultId;
		const idbName = `kaos:${settings.vaultId}`;

		this.log(`Connecting to ${settings.host} room=${roomId}`);
		this.log(`IndexedDB database: ${idbName}`);

		// Start both persistence and provider in parallel.
		this.persistence = new IndexeddbPersistence(idbName, this.ydoc);
		// Latch local authority from construction time. Waiting code is installed
		// later in plugin startup, and a fast IndexedDB can emit `synced` before
		// that waiter exists. The monotonic latch prevents that lost-event race and
		// also records a late success after the bounded startup wait timed out.
		this.persistence.on("synced", () => this.markLocalPersistenceReady());

		// Catch IndexedDB open/write failures (unavailable, quota, permissions).
		// y-indexeddb's internal _db promise rejects if IDB can't open.
		// We also listen for unhandled IDB transaction errors.
		(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
			.catch((err: unknown) => {
				this.captureIndexedDbError(err, "open");
				console.error("[kaos] IndexedDB failed to open:", err);
			});

		(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
			.then((db: IDBDatabase) => {
				db.addEventListener("error", (event) => {
					const target = event.target as { error?: unknown } | null;
					this.captureIndexedDbError(
						target?.error ?? new Error("IndexedDB runtime error"),
						"runtime",
					);
				});
			})
			.catch(() => {
				// Open failure is already captured above.
			});

		this._getSocketTicket = options?.getSocketTicket ?? null;
		const longLivedToken = settings.token;
		const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

		this.provider = new YSyncProvider(settings.host, roomId, this.ydoc, {
			prefix: syncPrefix,
			params: async () => {
				const paramsIntentEpoch = this._socketTicketConnectionIntentEpoch;
				if (
					this._destroyed
					|| this._fatalAuthError
					|| !this._socketTicketConnectionWanted
					|| this.isSocketTicketNetworkOffline()
				) {
					throw new Error("socket ticket connection cancelled");
				}
				// Build base params (schema version + optional trace context).
				const p: Record<string, string> = {
					schemaVersion: String(SCHEMA_VERSION),
				};
				if (options?.traceContext) {
					p.device = options.traceContext.deviceName;
					p.trace = options.traceContext.traceId;
					p.boot = options.traceContext.bootId;
				}
				// Prefer a short-lived ticket when available; fall back to the
				// long-lived token for servers that do not yet support tickets.
				//
				// NOTE: this callback is invoked once by YProvider.connect() on
				// initial connection.  y-partyserver's internal reconnect loop
				// (setupWS) reuses provider.url directly without re-calling
				// params().  VaultSync keeps provider.url fresh via
				// scheduleSocketTicketRefresh so reconnects always carry a live
				// ticket.  See engineering/zero-config-auth.md § "Reconnect
				// behavior" and engineering/warts-and-limits.md § "Pragmatic
				// compromises".
				const ticketResult = await this.requestSocketTicket();
				if (
					this._destroyed
					|| this._fatalAuthError
					|| !this._socketTicketConnectionWanted
					|| this._socketTicketConnectionIntentEpoch !== paramsIntentEpoch
				) {
					throw new Error("socket ticket connection cancelled");
				}
				if (ticketResult) {
					p.ticket = ticketResult.value;
					// Schedule proactive URL refresh before this ticket expires.
					this.scheduleSocketTicketRefresh(ticketResult);
				} else {
					p.token = longLivedToken;
				}
				return p;
			},
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
		});
		this.installSocketTicketProviderLifecycle();
		if (this._getSocketTicket && typeof window !== "undefined") {
			this._socketTicketOnlineHandler = () => this.resumeDeferredSocketTicketRefresh();
			window.addEventListener("online", this._socketTicketOnlineHandler);
		}

		// Wire update tracker before any Y.Doc events so timestamps are captured.
		this.updateTracker = new UpdateTracker();
		this.updateTracker.attach(
			this.ydoc,
			() => this.connected,
			this.provider,
			this.persistence,
		);
		this.serverAckTracker = new ServerAckTracker(this.trace, this.onFlightEvent);

		// A handshake can close before y-partyserver ever emits status=disconnected.
		// Observe connection-close as the complete close signal and let the status
		// listener below act as a compatibility fallback. An explicit one-turn
		// marker dedupes the disconnected status emitted for that same close.
		(this.provider as unknown as {
			on: (event: string, cb: (event: CloseEvent, provider: YSyncProvider) => void) => void;
		}).on("connection-close", (_event, provider) => {
			this.observeSocketTicketConnectionClose(
				(provider as YSyncProvider & { ws?: object | null }).ws ?? null,
			);
		});

		// Track connection generations for reconnect detection
		this.provider.on("status", (event: { status: string }) => {
			this.log(
				`Provider status=${event.status} ` +
				`(wsconnected=${this.provider.wsconnected}, synced=${this.provider.synced})`,
			);
			if (event.status === "connected") {
				this._socketTicketDisconnectRecoveryPending = false;
				if (this._socketAuthRecoveryAttempted) {
					this._socketAuthRecoveryReconnectStarted = true;
				}
				this._connectionGeneration++;
				this.log(`Connection generation: ${this._connectionGeneration}`);
			} else if (event.status === "disconnected") {
				// Best-effort: refresh provider.url before the reconnect timer fires.
				// The proactive timer (scheduleSocketTicketRefresh) is the primary
				// mechanism; this handles edge cases like laptop sleep where the
				// disconnect happens without the timer having had a chance to fire.
				this.handleSocketTicketDisconnectedStatus();
			}
		});
		this.provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			this.markSocketTicketSyncSucceeded();
		});

		const handleFatalAuthPayload = (payload: string) => {
			const msg = parseFatalAuthMessage(payload);
			if (!msg) {
				return;
			}
			if (this.tryRecoverSocketAuth(msg)) {
				return;
			}
			if (
				msg.code === "unauthorized"
				&& this._socketAuthRecoveryInFlight
				&& !this._socketAuthRecoveryReconnectStarted
			) {
				return;
			}
			this.markFatalAuth(msg);
		};

		// y-partyserver emits "__YPS:" control payloads via "custom-message".
		(this.provider as unknown as { on: (event: string, cb: (payload: string) => void) => void })
			.on("custom-message", handleFatalAuthPayload);
		(this.provider as unknown as { on: (event: string, cb: (payload: string) => void) => void })
			.on("custom-message", (payload: string) => {
				// The server emits SV echoes only from its last successfully persisted
				// state. ServerAckTracker's dominance check is still the truth gate for
				// whether that durable state contains this client's exact candidate.
				handleSvEchoCustomMessage(payload, this._svEchoCounters, (sv) => {
					this.serverAckTracker.recordServerSvEcho(sv);
				});
			});
		// Fallback for servers that still send plain text JSON frames.
		this.provider.on("message", (event: MessageEvent) => {
			if (typeof event.data === "string") {
				handleFatalAuthPayload(event.data);
			}
		});
		void this.provider.connect().catch(() => {
			// The lifecycle wrapper records the failure and schedules a bounded
			// retry. The constructor intentionally does not leak an unhandled promise.
		});
	}

	// -------------------------------------------------------------------
	// Startup gates
	// -------------------------------------------------------------------

	waitForLocalPersistence(): Promise<boolean> {
		if (this._localReady) return Promise.resolve(true);
		if (this._idbError) return Promise.resolve(false);

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.persistence.off("synced", onSynced);
				resolve(value);
			};
			const timeout = setTimeout(() => {
				this.log("IndexedDB persistence timed out — proceeding without cache");
				finish(false);
			}, LOCAL_PERSISTENCE_TIMEOUT_MS);

			const onSynced = () => {
				this.markLocalPersistenceReady();
				finish(true);
			};
			this.persistence.on("synced", onSynced);
			// Close the event-between-check-and-listener window.
			if (this._localReady) finish(true);

			// Also resolve (false) if IDB errors out after we started waiting
			(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
				.catch(() => {
					this.captureIndexedDbError(new Error("IndexedDB failed during waitForLocalPersistence"), "wait");
					this.log("IndexedDB errored during wait — proceeding without cache");
					finish(false);
				});
		});
	}

	private markLocalPersistenceReady(): void {
		if (this._localReady) return;
		this._localReady = true;
		this._pathIndexesDirty = true;
		this.log(
			`IndexedDB loaded (pathToId: ${this.pathToId.size}, ` +
			`initialized: ${this.isInitialized})`,
		);
	}

	waitForProviderSync(): Promise<boolean> {
		if (this._providerSynced) return Promise.resolve(true);
		if (this._fatalAuthError) return Promise.resolve(false);

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.provider.off("sync", check);
				this._providerSyncWaiters.delete(finish);
				resolve(value);
			};

			const timeout = setTimeout(() => {
				this.log("Provider sync timed out — entering offline mode");
				finish(false);
			}, PROVIDER_SYNC_TIMEOUT_MS);

			const check = (synced: boolean) => {
				this.log(`Provider sync event: synced=${synced} (gen=${this._connectionGeneration})`);
				if (!synced) return;
				this._providerSynced = true;
				this.log("Provider synced — room state received");
				finish(true);
			};
			this.provider.on("sync", check);
			this._providerSyncWaiters.add(finish);
			if (this._fatalAuthError) {
				finish(false);
			}
		});
	}

	async initializeServerAckTracking(
		settings: VaultSyncSettings,
		pluginVersion: string,
		options: { localYjsPersistenceLoaded: boolean },
	): Promise<void> {
		if (this._serverAckScope) return;
		try {
			const [vaultIdHash, serverHostHash, localDeviceId] = await Promise.all([
				sha256Hex(settings.vaultId),
				sha256Hex(settings.host),
				getOrCreateLocalDeviceId(),
			]);
			const scope: ScopeKey & ScopeMetadata = {
				vaultIdHash,
				serverHostHash,
				localDeviceId,
				// Phase A uses the current y-partyserver room key. Since this is
				// derived from vaultId, it does not detect server reset/reclaim by
				// itself; the manual clear command remains the escape hatch until a
				// server generation/claim ID exists.
				roomName: settings.vaultId,
				docSchemaVersion: SCHEMA_VERSION,
				pluginVersion,
				ackStoreVersion: 1,
			};
			const store = new IndexedDbCandidateStore(scope);
			this._serverAckStore = store;
			this._serverAckScope = scope;
			this.serverAckTracker.attach(
				this.ydoc,
				() => Y.encodeStateVector(this.ydoc),
				this.provider,
				this.persistence,
			);
			if (options.localYjsPersistenceLoaded) {
				await this.serverAckTracker.onStartup(store, scope);
				this._serverReceiptStartupValidation = "validated";
				this.log("Server receipt tracker initialized");
			} else {
				this._serverReceiptStartupValidation = "skipped_local_yjs_timeout";
				this.log("Server receipt startup validation skipped: local Yjs persistence timed out");
			}
		} catch (err) {
			this._serverAckPersistenceUnavailable = true;
			this._serverReceiptStartupValidation = "unavailable";
			this.log(`Server receipt tracker unavailable: ${formatUnknown(err)}`);
		}
	}

	/**
	 * Register a callback for when the provider syncs AFTER the initial
	 * startup sequence. Fires on both late first-sync and reconnections.
	 * The callback receives the connection generation number.
	 */
	onProviderSync(callback: (generation: number) => void): void {
		this.provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			this._providerSynced = true;
			this.log(`onProviderSync callback firing (gen=${this._connectionGeneration})`);
			callback(this._connectionGeneration);
		});
	}

	// -------------------------------------------------------------------
	// Sentinel
	// -------------------------------------------------------------------

	get isInitialized(): boolean {
		return this.sys.get("initialized") === true;
	}

	markInitialized(): void {
		const alreadyInitialized = this.isInitialized;
		this.sys.set("initialized", true);
		if (this.storedSchemaVersion === null) {
			this.sys.set("schemaVersion", SCHEMA_VERSION);
		}
		if (!alreadyInitialized) {
			this.sys.set("lastSync", Date.now());
			this.log("Marked Y.Doc as initialized (sentinel set)");
		}
	}

	/**
	 * Check if the persisted schema version is compatible with this code.
	 * Returns null if OK, or an error string if incompatible.
	 *
	 * Rules:
	 *   - No version stored (first run or pre-versioning): OK, we'll set it
	 *   - Version <= SCHEMA_VERSION: OK (same or older, we can read it)
	 *   - Version > SCHEMA_VERSION: INCOMPATIBLE (newer plugin wrote this)
	 */
	checkSchemaVersion(): string | null {
		const stored = this.sys.get("schemaVersion");
		if (stored === undefined || stored === null) return null; // first run
		if (typeof stored !== "number") return null; // corrupt, treat as first run
		if (stored > SCHEMA_VERSION) {
			return (
				`CRDT schema version ${stored} is newer than this plugin supports (v${SCHEMA_VERSION}). ` +
				`Update the plugin or risk data corruption.`
			);
		}
		return null; // same or older version, OK
	}

	get supportedSchemaVersion(): number {
		return SCHEMA_VERSION;
	}

	get storedSchemaVersion(): number | null {
		const stored = this.sys.get("schemaVersion");
		if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 0) {
			return null;
		}
		return stored;
	}

	/**
	 * Write the current schema marker if the room is older. Schema v4 is a
	 * safety boundary: older clients do not understand causal blob authority.
	 * Safe to call concurrently from multiple current clients.
	 */
	markCurrentSchema(device?: string): void {
		const current = this.currentSchemaVersion();
		if (current >= SCHEMA_VERSION) return;

		this.ydoc.transact(() => {
			this.sys.set("schemaVersion", SCHEMA_VERSION);
			this.sys.set("schemaUpdatedAt", Date.now());
			if (device) this.sys.set("schemaUpdatedBy", device);
		}, ORIGIN_SEED);

		this.log(`schema: marked v${SCHEMA_VERSION} (was ${current})`);
	}

	/**
	 * Compute metadata shape statistics for debug/diagnostics.
	 * Returns counts of flat vs nested entries, active vs tombstones, etc.
	 */
	getMetaShapeStats(): MetaShapeStats & { metaObserverFallbackCount: number } {
		return {
			...computeMetaShapeStats(this.meta, this.storedSchemaVersion),
			metaObserverFallbackCount: this._metaObserverFallbackCount,
		};
	}

	/**
	 * Subscribe to semantic metadata change events.
	 *
	 * The callback receives a `MetaChangeBatch` for each Yjs transaction
	 * that changes metadata. The batch includes:
	 *   - `origin`: the Yjs transaction origin
	 *   - `isLocal`: true for locally-originated changes (DiskMirror must skip these)
	 *   - `changes`: pre-classified MetaSemanticChange[] for this transaction
	 *
	 * Works correctly for both flat (v2) and nested (v3) metadata entries.
	 * Powered by `observeDeep` with incremental diffing internally.
	 *
	 * Returns an unsubscribe function.
	 */
	observeMetaChanges(callback: (batch: MetaChangeBatch) => void): () => void {
		this._metaSemanticListeners.add(callback);
		return () => { this._metaSemanticListeners.delete(callback); };
	}

	// -------------------------------------------------------------------
	// Path normalization
	// -------------------------------------------------------------------

	/** Normalize a vault-relative path for consistent CRDT keys. */
	private normPath(path: string): string {
		return normalizePath(path);
	}

	isFileMetaDeleted(meta: unknown): boolean {
		if (!meta) return false;
		return isFileMetaDeletedValue(meta);
	}

	private currentSchemaVersion(): number {
		return this.storedSchemaVersion ?? 1;
	}

	private usesV2PathModel(): boolean {
		return this.currentSchemaVersion() >= 2;
	}

	private shouldWriteLegacyPathMap(): boolean {
		return !this.usesV2PathModel();
	}

	private ensurePathIndexes(): void {
		if (!this._pathIndexesDirty) return;

		this._pathIndex.clear();
		this._deletedPathIndex.clear();
		this._activePathCollisions.clear();

		const activeByPath = new Map<string, string[]>();
		this.meta.forEach((value: unknown, fileId: string) => {
			const path = getMetaPath(value);
			if (!path) return;
			const normalizedPath = this.normPath(path);

			if (isFileMetaDeletedValue(value)) {
				if (!this._pathIndex.has(normalizedPath)) {
					this._deletedPathIndex.add(normalizedPath);
				}
				return;
			}

			const bucket = activeByPath.get(normalizedPath) ?? [];
			bucket.push(fileId);
			activeByPath.set(normalizedPath, bucket);
		});

		for (const [normalizedPath, fileIds] of activeByPath) {
			fileIds.sort();
			if (fileIds.length === 1) {
				this._pathIndex.set(normalizedPath, fileIds[0]!);
				this._deletedPathIndex.delete(normalizedPath);
				continue;
			}

			this._activePathCollisions.set(normalizedPath, fileIds);
			this._deletedPathIndex.delete(normalizedPath);
		}

		this._pathIndexesDirty = false;
	}

	private setMetaActive(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const now = Date.now();

		const entry = ensureNestedMetaEntry(this.meta, fileId, {
			shape: "flat",
			path: normalizedPath,
			mtime: now,
			...(device ? { device } : {}),
		});

		if (!entry) {
			// Should not happen since we always provide a fallback
			this.log(`setMetaActive: failed to ensure nested entry for ${fileId}`);
			return;
		}

		entry.set("path", normalizedPath);
		entry.delete("deleted");
		entry.delete("deletedAt");
		entry.set("mtime", now);

		if (device) {
			entry.set("device", device);
		} else {
			entry.delete("device");
		}
	}

	private setMetaDeleted(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const deletedAt = Date.now();

		const entry = ensureNestedMetaEntry(this.meta, fileId, {
			shape: "flat",
			path: normalizedPath,
			deletedAt,
		});

		if (!entry) {
			this.log(`setMetaDeleted: failed to ensure nested entry for ${fileId}`);
			return;
		}

		entry.set("path", normalizedPath);
		entry.set("deletedAt", deletedAt);
		entry.delete("deleted");
		entry.delete("mtime");
		entry.delete("device");
	}

	migrateSchemaToV2(device?: string): {
		from: number | null;
		to: number;
		metaUpdated: number;
		metaCreated: number;
		tombstonesConverted: number;
		loserPaths: string[];
	} {
		const from = this.storedSchemaVersion;
		let metaUpdated = 0;
		let metaCreated = 0;
		let tombstonesConverted = 0;
		const loserPaths: string[] = [];

		this.ydoc.transact(() => {
			const now = Date.now();
			const canonicalPathById = new Map<string, string>();
			const pathsById = new Map<string, string[]>();

			this.pathToId.forEach((fileId, rawPath) => {
				const path = this.normPath(rawPath);
				const list = pathsById.get(fileId);
				if (list) {
					list.push(path);
				} else {
					pathsById.set(fileId, [path]);
				}
			});

			for (const [fileId, paths] of pathsById) {
				const metaValue = this.meta.get(fileId);
				const preferred = getMetaPath(metaValue) ? this.normPath(getMetaPath(metaValue)!) : "";
				const canonical = preferred && paths.includes(preferred)
					? preferred
					: paths.slice().sort()[0]!;
				canonicalPathById.set(fileId, canonical);
				for (const path of paths) {
					if (path !== canonical) {
						loserPaths.push(path);
					}
				}
			}

			for (const [fileId, normalizedPath] of canonicalPathById) {
				const currentMeta = decodeFileMeta(this.meta.get(fileId));
				if (!currentMeta) {
					// Write flat v2 object — this is a v1→v2 migration, not a v3 upgrade.
					// The lazy v3 conversion will upgrade this entry when it is next touched.
					this.meta.set(fileId, {
						path: normalizedPath,
						deletedAt: undefined,
						deleted: undefined,
						mtime: now,
						device,
					} as unknown);
					metaCreated++;
					return;
				}

				const isDeleted = currentMeta.deleted === true || typeof currentMeta.deletedAt === "number";
				if (!isDeleted && currentMeta.path !== normalizedPath) {
					// Update path in-place on nested map; write flat if still flat.
					const existing = this.meta.get(fileId);
					if (existing instanceof Y.Map) {
						existing.set("path", normalizedPath);
					} else {
						this.meta.set(fileId, {
							...(currentMeta as object),
							path: normalizedPath,
							deleted: undefined,
							deletedAt: undefined,
							mtime: currentMeta.mtime ?? now,
							device: currentMeta.device ?? device,
						} as unknown);
					}
					metaUpdated++;
				}
			}

			this.meta.forEach((value: unknown, fileId: string) => {
				const decoded = decodeFileMeta(value);
				if (!decoded) return;
				if (decoded.deleted && decoded.deletedAt === undefined) {
					// Convert legacy deleted:true to v2 flat tombstone.
					this.meta.set(fileId, {
						path: this.normPath(decoded.path),
						deletedAt: typeof decoded.mtime === "number" ? decoded.mtime : now,
					} as unknown);
					tombstonesConverted++;
					return;
				}
				const isDel = decoded.deleted === true || typeof decoded.deletedAt === "number";
				if (isDel && (decoded.deleted !== undefined || decoded.mtime !== undefined || decoded.device !== undefined)) {
					// Strip extra fields from tombstone, keep as flat v2.
					this.meta.set(fileId, {
						path: this.normPath(decoded.path),
						deletedAt: typeof decoded.deletedAt === "number" ? decoded.deletedAt : now,
					} as unknown);
					metaUpdated++;
				}
			});

			// Explicit tombstones for dropped alias paths — write flat v2.
			const existingActivePaths = new Set<string>();
			this.meta.forEach((value: unknown) => {
				if (isFileMetaDeletedValue(value)) return;
				const path = getMetaPath(value);
				if (path) existingActivePaths.add(this.normPath(path));
			});
			for (const loserPath of loserPaths) {
				if (existingActivePaths.has(loserPath)) continue;
				const tombstoneId = this.generateFileId();
				this.meta.set(tombstoneId, { path: loserPath, deletedAt: now } as unknown);
			}

			this.sys.set("schemaVersion", 2);
			this.sys.set("migratedAt", now);
			this.sys.set("migratedBy", device ?? this._device ?? "unknown");
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.log(
			`schema migration: ${from ?? "none"} -> 2 ` +
			`(metaUpdated=${metaUpdated}, metaCreated=${metaCreated}, tombstonesConverted=${tombstonesConverted})`,
		);
		return {
			from,
			to: 2,
			metaUpdated,
			metaCreated,
			tombstonesConverted,
			loserPaths,
		};
	}

	// -------------------------------------------------------------------
	// Integrity checks
	// -------------------------------------------------------------------

	/**
	 * Run integrity checks on the CRDT maps. Call after reconciliation.
	 *
	 * Checks:
	 *   1. Two paths pointing to the same fileId → keep first, remap second
	 *   2. idToText/meta entries with no pathToId reference → orphan garbage
	 *
	 * Returns counts for logging.
	 */
	runIntegrityChecks(): { duplicateIds: number; orphansCleaned: number; duplicateActivePaths: number } {
		let duplicateIds = 0;
		let orphansCleaned = 0;

		// 1. Legacy duplicate-id repair for schema v1 only.
		// In schema v2, id->meta.path is authoritative and this clone behavior
		// is intentionally disabled.
		if (!this.usesV2PathModel()) {
			const idToPaths = new Map<string, string[]>();
			this.pathToId.forEach((fileId, path) => {
				const paths = idToPaths.get(fileId);
				if (paths) {
					paths.push(path);
				} else {
					idToPaths.set(fileId, [path]);
				}
			});

			for (const [fileId, paths] of idToPaths) {
				if (paths.length <= 1) continue;

				duplicateIds++;
				this.log(
					`integrity: fileId ${fileId} shared by ${paths.length} paths: ${paths.join(", ")}`,
				);

				const keepPath = paths[0]!;
				const sourceText = this.idToText.get(fileId);

				for (let i = 1; i < paths.length; i++) {
					const dupPath = paths[i]!;
					const newId = this.generateFileId();
					const newText = new Y.Text();

				this.ydoc.transact(() => {
					if (sourceText) {
						newText.insert(0, sourceText.toJSON());
					}
					this.pathToId.set(dupPath, newId);
					this.idToText.set(newId, newText);
					const dupMeta = createNestedActiveMeta(dupPath, Date.now(), this._device);
					this.meta.set(newId, dupMeta);
				}, ORIGIN_SEED);

					this.log(
						`integrity: gave "${dupPath}" new id=${newId} (was sharing ${fileId} with "${keepPath}")`,
					);
				}
			}
		}

		// 2. Orphan GC: find idToText/meta entries with no pathToId reference
		const referencedIds = new Set<string>();
		this.ensurePathIndexes();
		for (const fileId of this._pathIndex.values()) {
			referencedIds.add(fileId);
		}
		for (const fileIds of this._activePathCollisions.values()) {
			for (const fileId of fileIds) {
				referencedIds.add(fileId);
			}
		}

		// Also keep tombstoned IDs (they're intentionally orphaned from pathToId)
		const tombstonedIds = new Set<string>();
		this.meta.forEach((value: unknown, fileId: string) => {
			if (isFileMetaDeletedValue(value)) {
				tombstonedIds.add(fileId);
			}
		});

		// Clean orphans from idToText
		const orphanTextIds: string[] = [];
		this.idToText.forEach((_text, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanTextIds.push(fileId);
			}
		});

		// Clean orphans from meta (non-tombstoned only)
		const orphanMetaIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanMetaIds.push(fileId);
			}
		});

		const allOrphanIds = new Set([...orphanTextIds, ...orphanMetaIds]);
		if (allOrphanIds.size > 0) {
			this.ydoc.transact(() => {
				for (const fileId of allOrphanIds) {
					this.idToText.delete(fileId);
					this.meta.delete(fileId);
				}
			}, ORIGIN_SEED);

			orphansCleaned = allOrphanIds.size;
			this.log(
				`integrity: cleaned ${orphansCleaned} orphaned entries ` +
				`(${orphanTextIds.length} from idToText, ${orphanMetaIds.length} from meta)`,
			);
		}

		const duplicateActivePaths = this._activePathCollisions.size;
		if (duplicateActivePaths > 0) {
			this.log(`integrity: ${duplicateActivePaths} active path collision(s) preserved for explicit resolution`);
		}
		return { duplicateIds, orphansCleaned, duplicateActivePaths };
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	/**
	 * Determine which reconciliation mode is safe given current state.
	 *
	 * Authoritative when:
	 *   - Provider synced (we have the full server state), OR
	 *   - Local cache loaded AND sentinel says initialized AND
	 *     pathToId is non-empty (protects against partial IndexedDB persistence)
	 *
	 * Conservative otherwise.
	 */
	getSafeReconcileMode(): ReconcileMode {
		if (this._providerSynced) return "authoritative";
		// Use schemaVersion presence (set atomically with initialized) as
		// proof that IDB loaded real data. Unlike pathToId.size > 0 this
		// correctly handles legitimately-empty-but-initialized vaults.
		if (this._localReady && this.isInitialized && this.sys.get("schemaVersion") !== undefined) {
			return "authoritative";
		}
		return "conservative";
	}

	reconcileVault(
		diskFiles: Map<string, string>,
		diskPresentPaths: Set<string>,
		mode: ReconcileMode,
		device?: string,
		/**
		 * Optional admission-opId factory invoked at each authoritative-lane
		 * `seed-to-crdt` decision point BEFORE the CRDT mutation runs.
		 *
		 * ## Contract
		 *
		 * 1. **Optionality.** When the parameter is omitted, `reconcileVault`
		 *    behaves EXACTLY as it did before this hook existed: no opId,
		 *    no decision emission from inside the seed loop, and the seed
		 *    mutation runs unchanged. Callers that do not care about
		 *    decision-before-mutation ordering MUST NOT pass it.
		 *
		 * 2. **Frequency.** When supplied, the callback is invoked EXACTLY
		 *    ONCE per `seed-to-crdt` admission decision per call to
		 *    `reconcileVault`. It is NOT invoked for `skip-in-crdt`,
		 *    `tombstone-conflict`, or `untracked` classifications. It is
		 *    NOT invoked for `createdOnDisk` or `updatedOnDisk` paths
		 *    (those are post-result loops in the controller).
		 *
		 * 3. **Ordering.** Within a single seed-to-crdt branch, the seed
		 *    loop calls `mintAdmissionOpId(path)` first, then invokes the
		 *    returned `emitDecision()` thunk, then calls `ensureFile`
		 *    with `{ opId }`. The decision emission therefore precedes the
		 *    `crdt.file.created` envelope, and both events carry the same
		 *    `opId` value — the load-bearing causality property the spec
		 *    asserts in Scenario A.
		 *
		 * 4. **Side-effect surface.** The factory and `emitDecision()` are
		 *    free to read state and emit flight events. They MUST NOT
		 *    mutate any field on this `VaultSync` instance, MUST NOT call
		 *    back into `ensureFile`, and MUST NOT call back into
		 *    `reconcileVault` (recursion is undefined).
		 *
		 * 5. **Failure semantics.** If `mintAdmissionOpId(path)` throws OR
		 *    if `emitDecision()` throws, the exception propagates UP out
		 *    of `reconcileVault` synchronously. The current path's
		 *    `ensureFile` SHALL NOT run, the path SHALL NOT be appended
		 *    to `seededToCrdt`, AND any subsequent paths in `diskPresentPaths`
		 *    are NOT classified or seeded. Recovery is the caller's
		 *    responsibility — `runReconciliation` runs inside a single
		 *    `try { ... } finally { reconcileInFlight = false; ... }`
		 *    block, so a throw here will mark the reconcile as failed
		 *    rather than half-applied.
		 *
		 *    Rationale: the seed mutation and the decision emission are
		 *    paired. If the controller cannot record the decision, we
		 *    refuse to perform the mutation. Letting the mutation through
		 *    would create a `crdt.file.created` event with no preceding
		 *    `reconcile.file.decision` — exactly the silent admission the
		 *    spec was written to prevent.
		 *
		 * 6. **No new origins / suppression / UI.** The callback is a
		 *    causality-tracking hook only. It MUST NOT introduce a new
		 *    Yjs transaction origin, a new disk-event suppression rule,
		 *    or any user-visible surface.
		 */
		mintAdmissionOpId?: (path: string) => { opId: string; emitDecision: () => void },
		/** Product-owned path predicate; VaultSync itself remains policy-neutral. */
		isPathSyncable: (path: string) => boolean = () => true,
		/** Final synchronous freshness fence for a disk-only seed snapshot. */
		canSeedSnapshot: (path: string, content: string) => boolean = () => true,
		/**
		 * Provider-policy admission for CRDT-to-disk projection only.
		 *
		 * This must not be folded into `isPathSyncable`: a closed provider gate
		 * still permits local disk-only paths to seed into the CRDT.
		 */
		isRemoteProjectionAllowed: (path: string) => boolean = () => true,
	): ReconcileResult {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const createdOnDisk: string[] = [];
		const updatedOnDisk: string[] = [];
		const seededToCrdt: string[] = [];
		const untracked: string[] = [];
		const pathBindingConflicts: string[] = [];
		let skipped = 0;

		this.ensurePathIndexes();
		const crdtPaths = new Set<string>(
			[...this._pathIndex.keys()].filter((path) => isPathSyncable(path)),
		);
		const projectableCrdtPaths = new Set<string>(
			[...crdtPaths].filter((path) => isRemoteProjectionAllowed(path)),
		);
		const activePathCollisionPaths = new Set<string>(
			[...this._activePathCollisions.keys()].filter((path) => isPathSyncable(path)),
		);
		const syncableDiskFiles = new Map(
			[...diskFiles].filter(([path]) => isPathSyncable(path)),
		);
		const syncableDiskPresentPaths = new Set(
			[...diskPresentPaths].filter((path) => isPathSyncable(path)),
		);

		// CRDT files not on disk → create on disk
		// IMPORTANT: use diskPresentPaths (all known disk paths), not
		// diskFiles (only the subset whose content was read this run).
		for (const path of projectableCrdtPaths) {
			if (!syncableDiskPresentPaths.has(path)) {
				createdOnDisk.push(path);
			}
		}

		// Files present in both disk and CRDT whose content differs.
		// In authoritative mode, CRDT is source of truth and should be
		// flushed to disk so reopened clients converge reliably.
		if (mode === "authoritative") {
			for (const [path, diskContent] of syncableDiskFiles) {
				// Classify every syncable overlap even while remote projection is
				// closed. The controller's three-way planner may legitimately choose
				// disk-to-CRDT import, a clean merge, or conflict preservation. Remote
				// admission is required only after the planner chooses a physical
				// CRDT-to-disk mutation.
				if (!crdtPaths.has(path)) continue;
				const ytext = this.getTextForPath(path);
				if (!ytext) continue;
				const crdtContent = ytext.toJSON();
				if (crdtContent !== diskContent) {
					updatedOnDisk.push(path);
				}
			}
		}

		const tombstonedDiskConflicts: TombstonedDiskConflict[] = [];

		// Disk files not in CRDT
		for (const path of syncableDiskPresentPaths) {
			if (activePathCollisionPaths.has(path)) {
				this.log(`reconcile: "${path}" has duplicate active CRDT fileIds — preserving for explicit resolution`);
				pathBindingConflicts.push(path);
				skipped++;
				continue;
			}

			const classification = classifyDiskPathForReconcile(
				path,
				crdtPaths.has(path),
				this._deletedPathIndex.has(path),
				mode,
			);

			switch (classification.action) {
				case "skip-in-crdt":
					// Already in CRDT, handled above
					continue;

				case "tombstone-conflict":
					// Disk file exists at a tombstoned path — zombie prevention
					this.log(`reconcile: "${path}" exists on disk but is tombstoned in CRDT — conflict preserved`);
					tombstonedDiskConflicts.push(classification.conflict!);
					skipped++;
					continue;

				case "seed-to-crdt": {
					const content = syncableDiskFiles.get(path);
					if (content === undefined) {
						// Presence is known, but content wasn't read this pass. Skip seeding
						// to avoid accidentally creating empty/incorrect files.
						this.log(`reconcile: "${path}" present on disk but content not loaded, skipping seed`);
						continue;
					}
					if (!canSeedSnapshot(path, content)) {
						this.log(`reconcile: "${path}" seed snapshot became stale, deferring`);
						untracked.push(path);
						continue;
					}
					// Spec R2 / Option (b): when an admission-opId factory is
					// supplied, emit `reconcile.file.decision` BEFORE the CRDT
					// mutation and thread the shared opId into ensureFile so
					// the resulting `crdt.file.created` carries it.
					//
					// Failure semantics (see callback contract on this method):
					// if `mintAdmissionOpId` or `emitDecision` throws, the
					// exception propagates and the path's `ensureFile` is
					// NOT called, so we never emit a `crdt.file.created`
					// without a preceding `reconcile.file.decision`. The
					// path is also NOT appended to `seededToCrdt`.
					const minted = mintAdmissionOpId?.(path);
					minted?.emitDecision();
					const ensureResult = this.ensureFile(
						path,
						content,
						device,
						minted ? { opId: minted.opId } : undefined,
					);
					switch (ensureResult.kind) {
						case "created":
							seededToCrdt.push(path);
							continue;
						case "existing":
							continue;
						case "replan":
							untracked.push(path);
							this.log(`reconcile: "${path}" active set changed during seed, deferring`);
							continue;
						case "blocked":
							if (ensureResult.reason === "collision") {
								pathBindingConflicts.push(path);
							} else {
								untracked.push(path);
							}
							skipped++;
							this.log(
								`reconcile: "${path}" seed blocked (${ensureResult.reason}), preserving disk state`,
							);
							continue;
						default:
							assertNever(ensureResult);
					}
					continue;
				}

				case "untracked":
					untracked.push(path);
					continue;
			}
		}

		if (mode === "authoritative") {
			this.markInitialized();
		}

		this.log(
			`reconcile [${mode}]: ` +
			`${seededToCrdt.length} seeded, ` +
			`${createdOnDisk.length} need disk creation, ` +
			`${updatedOnDisk.length} need disk update, ` +
			`${untracked.length} untracked, ` +
			`${tombstonedDiskConflicts.length} tombstoned-disk conflicts, ` +
			`${pathBindingConflicts.length} path-binding conflicts`,
		);

		return {
			mode,
			createdOnDisk,
			updatedOnDisk,
			seededToCrdt,
			untracked,
			tombstonedDiskConflicts,
			pathBindingConflicts,
			skipped,
		};
	}

	// -------------------------------------------------------------------
	// File operations
	// -------------------------------------------------------------------

	private generateFileId(): string {
		return randomBase64Url(12);
	}

	private classifyActivePath(path: string): ActivePathClassification {
		const normalizedPath = this.normPath(path);
		const fileIds: string[] = [];
		const legacyFileId = this.usesV2PathModel()
			? undefined
			: this.pathToId.get(normalizedPath);
		if (legacyFileId !== undefined) {
			fileIds.push(legacyFileId);
		} else {
			this.meta.forEach((value: unknown, fileId: string) => {
				const metaPath = getMetaPath(value);
				if (
					metaPath
					&& this.normPath(metaPath) === normalizedPath
					&& !isFileMetaDeletedValue(value)
				) {
					fileIds.push(fileId);
				}
			});
		}
		fileIds.sort();

		if (fileIds.length === 0) return { kind: "empty" };
		if (fileIds.length > 1) return { kind: "collision", fileIds };

		const fileId = fileIds[0]!;
		const ytext = this.idToText.get(fileId);
		return ytext instanceof Y.Text
			? { kind: "healthy", fileId, ytext }
			: { kind: "orphan", fileId };
	}

	ensureFile(
		path: string,
		currentContent: string,
		device?: string,
		options?: EnsureFileOptions,
	): EnsureFileResult {
		path = this.normPath(path);
		const reviveTombstone = options?.reviveTombstone === true;
		const reviveReason = options?.reviveReason ?? "unknown";
		const opId = options?.opId;

		const resolveClassification = (
			classification: ActivePathClassification,
		): EnsureFileResult | null => {
			switch (classification.kind) {
				case "empty":
					return null;
				case "healthy":
					this.log(`ensureFile: "${path}" already exists (id=${classification.fileId})`);
					this._textToFileId.set(classification.ytext, classification.fileId);
					return {
						kind: "existing",
						fileId: classification.fileId,
						ytext: classification.ytext,
					};
				case "orphan":
					this.log(`ensureFile: "${path}" has orphan metadata (id=${classification.fileId})`);
					return { kind: "blocked", reason: "orphan" };
				case "collision":
					this.log(
						`ensureFile: "${path}" has active fileId collision (${classification.fileIds.length})`,
					);
					return { kind: "blocked", reason: "collision" };
			}
		};

		const s0Result = resolveClassification(this.classifyActivePath(path));
		if (s0Result) return s0Result;

		const pendingOldPath = this.getPendingRenameOldPathForTarget(path);
		if (pendingOldPath) {
			const sourceClassification = this.classifyActivePath(pendingOldPath);
			switch (sourceClassification.kind) {
				case "collision":
					this.log(
						`ensureFile: pending rename source "${pendingOldPath}" has an active fileId collision`,
					);
					return { kind: "blocked", reason: "collision" };
				case "orphan":
					this.log(
						`ensureFile: pending rename source "${pendingOldPath}" has orphan metadata`,
					);
					return { kind: "blocked", reason: "orphan" };
				case "empty":
					this.log(
						`ensureFile: pending rename source "${pendingOldPath}" is not active, replanning`,
					);
					return { kind: "replan", reason: "active-set-changed" };
				case "healthy":
					break;
			}
		}

		this.promotePendingRenameTarget(path, device);

		const s1Result = resolveClassification(this.classifyActivePath(path));
		if (s1Result) return s1Result;

		// Check tombstones — never resurrect a deleted path unless it is already
		// backed by a healthy active metadata entry handled above.
		const tombstoneIds = this.getMarkdownTombstoneIds(path);
		if (tombstoneIds.length > 0 && !reviveTombstone) {
			this.trace?.("sync", "ensureFile-tombstone-blocked", {
				path,
				tombstoneIds,
				device: device ?? null,
			});
			this.log(`ensureFile: "${path}" is tombstoned, refusing to create`);
			return { kind: "blocked", reason: "tombstone" };
		}

		if (options?.canCreate && !options.canCreate()) {
			this.log(`ensureFile: "${path}" creation policy refused admission`);
			return { kind: "blocked", reason: "policy" };
		}

		if (this.classifyActivePath(path).kind !== "empty") {
			this.log(`ensureFile: "${path}" active set changed before commit, replanning`);
			return { kind: "replan", reason: "active-set-changed" };
		}

		const fileId = this.generateFileId();
		const ytext = new Y.Text();

		this.ydoc.transact(() => {
			ytext.insert(0, currentContent);
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.set(path, fileId);
			}
			this.idToText.set(fileId, ytext);
			this.setMetaActive(fileId, path, device);
			for (const tombstoneId of tombstoneIds) {
				this.meta.delete(tombstoneId);
			}
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		if (tombstoneIds.length > 0) {
			this.trace?.("sync", "ensureFile-tombstone-revived", {
				path,
				tombstoneIds,
				device: device ?? null,
				reason: reviveReason,
			});
			this.onFlightPathEvent?.({
				priority: "critical",
				kind: FLIGHT_KIND.crdtFileRevived,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "crdt",
				path,
				opId,
				data: { reason: reviveReason },
			});
			this.log(
				`ensureFile: "${path}" revived from tombstone (${tombstoneIds.length}) due to ${reviveReason}`,
			);
		}
		this.log(`ensureFile: created "${path}" (id=${fileId})`);
		this._textToFileId.set(ytext, fileId);
		this.onFlightPathEvent?.({
			priority: "important",
			kind: FLIGHT_KIND.crdtFileCreated,
			severity: "info",
			scope: "file",
			source: "vaultSync",
			layer: "crdt",
			path,
			fileId,
			opId,
		});
		return { kind: "created", fileId, ytext };
	}

	isMarkdownTombstoned(path: string): boolean {
		return this.isPathTombstoned(path) || this.getMarkdownTombstoneIds(path).length > 0;
	}

	/**
	 * Return an authoritative Markdown delete snapshot for `path`.
	 *
	 * Unlike `isMarkdownTombstoned`, this deliberately treats any active
	 * metadata entry for the path (including a duplicate-active collision) as
	 * authoritative and returns null. This prevents a stale tombstone from
	 * authorizing deletion or replacement of a newly revived remote document.
	 */
	getAuthoritativeMarkdownDeleteSnapshot(path: string): MarkdownRemoteDeleteSnapshot | null {
		const normalizedPath = this.normPath(path);
		const tombstones: MarkdownRemoteDeleteTombstoneSnapshot[] = [];
		let hasActiveEntry = false;

		// Read the current CRDT map directly so the snapshot is independent of
		// path-index invalidation timing and covers every competing fileId.
		this.meta.forEach((value: unknown, fileId: string) => {
			const decoded = decodeFileMeta(value);
			if (!decoded || this.normPath(decoded.path) !== normalizedPath) return;

			if (!isFileMetaDeletedValue(value)) {
				hasActiveEntry = true;
				return;
			}

			tombstones.push({
				fileId,
				deletedAt: decoded.deletedAt ?? null,
				device: decoded.device ?? null,
			});
		});

		if (hasActiveEntry || tombstones.length === 0) return null;

		tombstones.sort((a, b) => {
			if (a.fileId < b.fileId) return -1;
			if (a.fileId > b.fileId) return 1;
			return 0;
		});

		const fingerprint = JSON.stringify([
			"markdown",
			normalizedPath,
			tombstones.map(({ fileId, deletedAt, device }) => [fileId, deletedAt, device]),
		]);

		return {
			kind: "markdown",
			path: normalizedPath,
			tombstones,
			fingerprint,
		};
	}

	getTextForPath(path: string): Y.Text | null {
		path = this.normPath(path);
		const fileId = this.getFileId(path);
		if (!fileId) return null;
		const text = this.idToText.get(fileId) ?? null;
		if (text) this._textToFileId.set(text, fileId);
		return text;
	}

	getFileId(path: string): string | undefined {
		path = this.normPath(path);
		if (this.usesV2PathModel()) {
			this.ensurePathIndexes();
			return this._pathIndex.get(path);
		}
		const legacy = this.pathToId.get(path);
		if (legacy) return legacy;
		this.ensurePathIndexes();
		return this._pathIndex.get(path);
	}

	getActiveFileIdsForPath(path: string): string[] {
		path = this.normPath(path);
		this.ensurePathIndexes();
		const collision = this._activePathCollisions.get(path);
		if (collision) return [...collision];
		const fileId = this._pathIndex.get(path);
		return fileId ? [fileId] : [];
	}

	getPathBindingIntegrity(input: Omit<PathBindingIntegrityInput, "activeFileIdsForPath">): PathBindingIntegrityResult {
		return evaluatePathBindingIntegrity({
			...input,
			path: this.normPath(input.path),
			activeFileIdsForPath: this.getActiveFileIdsForPath(input.path),
		});
	}

	/**
	 * O(1) reverse lookup: given a Y.Text, get its fileId.
	 * Returns undefined if the text isn't tracked (shouldn't happen
	 * for texts created via ensureFile/getTextForPath).
	 */
	getFileIdForText(ytext: Y.Text): string | undefined {
		return this._textToFileId.get(ytext);
	}

	getActiveMarkdownPaths(): string[] {
		this.ensurePathIndexes();
		return Array.from(this._pathIndex.keys());
	}

	/**
	 * Tombstone active CRDT entries that the product has classified as
	 * intrinsically unsafe to synchronize. The caller owns that policy: it must
	 * not pass user-configured exclusions here, because changing a preference
	 * must not silently delete a user's remote document.
	 *
	 * Tombstones are intentional. They remove the remote path reference and
	 * stop all replicas from materializing it, while retaining deletion history
	 * so an offline client cannot resurrect the entry.
	 */
	tombstoneIntrinsicExcludedEntries(
		shouldTombstoneMarkdownPath: (path: string) => boolean,
		shouldTombstoneBlobPath: (path: string) => boolean,
		device?: string,
	): { markdownPaths: string[]; blobPaths: string[] } {
		const markdownEntries: Array<{ fileId: string; path: string }> = [];
		this.meta.forEach((value: unknown, fileId: string) => {
			if (isFileMetaDeletedValue(value)) return;
			const rawPath = getMetaPath(value);
			if (!rawPath) return;
			const path = this.normPath(rawPath);
			if (shouldTombstoneMarkdownPath(path)) {
				markdownEntries.push({ fileId, path });
			}
		});

		const blobEntries: Array<{ path: string; deletedRef: BlobRef }> = [];
		this.pathToBlob.forEach((ref, rawPath) => {
			const path = this.normPath(rawPath);
			if (!this.isBlobTombstoned(path) && shouldTombstoneBlobPath(path)) {
				const deletedRef = cloneBlobRef(ref);
				if (deletedRef) blobEntries.push({ path, deletedRef });
			}
		});

		if (markdownEntries.length === 0 && blobEntries.length === 0) {
			return { markdownPaths: [], blobPaths: [] };
		}

		this.ydoc.transact(() => {
			for (const { fileId, path } of markdownEntries) {
				if (this.shouldWriteLegacyPathMap()) {
					this.pathToId.delete(path);
				}
				this.setMetaDeleted(fileId, path, device);
			}
			for (const { path, deletedRef } of blobEntries) {
				this.pathToBlob.delete(path);
				this.blobTombstones.set(path, {
					deletedAt: Date.now(),
					device,
					deletedRef,
				});
			}
		}, ORIGIN_SEED);

		this._pathIndexesDirty = markdownEntries.length > 0;
		const uniqueMarkdownPaths = [...new Set(markdownEntries.map(({ path }) => path))];
		this.log(
			`tombstoneIntrinsicExcludedEntries: markdown=${uniqueMarkdownPaths.length}, blobs=${blobEntries.length}`,
		);
		return { markdownPaths: uniqueMarkdownPaths, blobPaths: blobEntries.map(({ path }) => path) };
	}

	getPathBindingCollisionCount(): number {
		this.ensurePathIndexes();
		return this._activePathCollisions.size;
	}

	isPathTombstoned(path: string): boolean {
		this.ensurePathIndexes();
		return this._deletedPathIndex.has(this.normPath(path));
	}

	// -------------------------------------------------------------------
	// Blob operations
	// -------------------------------------------------------------------

	/**
	 * Record a blob reference for a vault path. Called after a successful
	 * R2 upload. Sets pathToBlob + blobMeta in a single transaction.
	 * Only sets blobMeta if the hash isn't already tracked (dedup).
	 */
	setBlobRef(
		path: string,
		hash: string,
		size: number,
		mime: string,
		device?: string,
		guard?: BlobRefCommitGuard,
	): BlobRefCommitResult | null {
		path = this.normPath(path);
		let committedRef: BlobRef | null = null;
		let committedSourceVersion: string | undefined;

		this.ydoc.transact(() => {
			const currentRef = this.pathToBlob.get(path);
			if (guard && !sameBlobRef(currentRef, guard.expectedCurrentRef)) return;
			if (
				guard?.expectedCurrentRef
				&& (
					!guard.expectedCurrentSourceVersion
					|| this.getBlobSourceVersion(path) !== guard.expectedCurrentSourceVersion
				)
			) return;
			const nextRef = createCausalBlobRef(
				hash,
				size,
				guard ? guard.causalBaseRef : currentRef,
			);
			this.pathToBlob.set(
				path,
				nextRef,
			);
			committedSourceVersion = this.getBlobSourceVersion(path);
			// Only set blobMeta if this content hash is new
			if (!this.blobMeta.has(hash)) {
				this.blobMeta.set(hash, {
					size,
					mime,
					createdAt: Date.now(),
					device,
				});
			}
			// Clear any existing tombstone for this path
			if (this.blobTombstones.has(path)) {
				this.blobTombstones.delete(path);
			}
			committedRef = cloneBlobRef(nextRef) ?? null;
		}, ORIGIN_SEED);

		if (!committedRef) {
			this.log(`setBlobRef: rejected stale authority for "${path}"`);
			return null;
		}
		if (!committedSourceVersion) {
			// The CRDT mutation already linearized. Throwing keeps the caller's
			// durable pre-commit stage intact; returning null would incorrectly
			// describe this as a safe no-mutation guard rejection.
			throw new Error(`setBlobRef: committed source episode unavailable for "${path}"`);
		}
		this.log(`setBlobRef: "${path}" hash=${hash.slice(0, 12)}… (${size} bytes)`);
		return {
			ref: committedRef,
			sourceVersion: committedSourceVersion,
		};
	}

	/**
	 * Get the blob reference for a vault path, if any.
	 */
	getBlobRef(path: string): BlobRef | undefined {
		return this.pathToBlob.get(this.normPath(path));
	}

	/**
	 * Return the exact CRDT item episode currently owning a live blob path.
	 * Y.Map replaces its Item (client, clock) on every set, even when the value
	 * returns to byte-identical H1 after a delete. This closes the hash ABA gap
	 * without treating unrelated document edits as source-authority changes.
	 *
	 * `_map` is a pinned Yjs 13.6.x structural invariant. Keep the cast isolated
	 * here and fail closed if the runtime shape ever changes.
	 */
	getBlobSourceVersion(path: string): string | undefined {
		const normalized = this.normPath(path);
		if (!this.pathToBlob.has(normalized)) return undefined;
		const item = (this.pathToBlob as unknown as {
			_map?: Map<string, { id?: { client?: unknown; clock?: unknown } }>;
		})._map?.get(normalized);
		const client = item?.id?.client;
		const clock = item?.id?.clock;
		return Number.isSafeInteger(client)
			&& typeof client === "number"
			&& client >= 0
			&& Number.isSafeInteger(clock)
			&& typeof clock === "number"
			&& clock >= 0
			? `${client}:${clock}`
			: undefined;
	}

	/**
	 * Get blob metadata for a content hash.
	 */
	getBlobMeta(hash: string): BlobMeta | undefined {
		return this.blobMeta.get(hash);
	}

	/**
	 * Tombstone-delete a blob path. Removes from pathToBlob and records
	 * a tombstone to prevent resurrection from stale disk scans.
	 * Does NOT delete the R2 blob (content-addressed = may be shared).
	 */
	deleteBlobRefIfCurrent(
		path: string,
		base: PendingBlobMutationBase,
		device?: string,
	): BlobDeleteCommitResult {
		path = this.normPath(path);
		const currentRef = cloneBlobRef(this.pathToBlob.get(path));
		if (!currentRef) return { kind: "already-absent" };
		if (!base.known) {
			return { kind: "unknown-source", currentRef };
		}
		const expectedRef = cloneBlobRef(base.ref);
		if (!base.sourceVersionKnown || !base.expectedSourceVersion) {
			return { kind: "unknown-source", currentRef };
		}
		const expectedSourceVersion = base.expectedSourceVersion;
		if (
			!sameBlobRef(currentRef, expectedRef)
			|| this.getBlobSourceVersion(path) !== expectedSourceVersion
		) {
			return {
				kind: "source-conflict",
				expectedRef,
				currentRef,
				mutationApplied: false,
			};
		}

		let mutationApplied = false;
		this.ydoc.transact(() => {
			// The equality check and mutation share one synchronous turn. Recheck
			// inside the transaction so a nested observer cannot lend this delete a
			// different source ref.
			if (
				!sameBlobRef(this.pathToBlob.get(path), expectedRef)
				|| this.getBlobSourceVersion(path) !== expectedSourceVersion
			) return;
			this.pathToBlob.delete(path);
			this.blobTombstones.set(path, {
				deletedAt: Date.now(),
				device,
				deletedRef: currentRef,
			});
			mutationApplied = true;
		}, ORIGIN_SEED);

		if (!mutationApplied || this.pathToBlob.has(path)) {
			return {
				kind: "source-conflict",
				expectedRef,
				currentRef: cloneBlobRef(this.pathToBlob.get(path)),
				mutationApplied,
			};
		}
		this.log(`deleteBlobRef: "${path}" causally tombstoned`);
		return { kind: "deleted", ref: currentRef };
	}

	deleteBlobRef(path: string, device?: string): void {
		path = this.normPath(path);

		const deletedRef = cloneBlobRef(this.pathToBlob.get(path));
		if (!deletedRef) {
			this.log(`deleteBlobRef: "${path}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			this.pathToBlob.delete(path);
			this.blobTombstones.set(path, {
				deletedAt: Date.now(),
				device,
				deletedRef,
			});
		}, ORIGIN_SEED);

		this.log(`deleteBlobRef: "${path}" tombstoned`);
	}

	/**
	 * Check if a path is blob-tombstoned (deleted).
	 */
	isBlobTombstoned(path: string): boolean {
		const normalized = this.normPath(path);
		return !this.pathToBlob.has(normalized)
			&& this.blobTombstones.has(normalized);
	}

	/**
	 * Return an authoritative blob delete snapshot for `path`.
	 *
	 * A live pathToBlob reference always wins over a stale tombstone. Invalid
	 * tombstones are not considered sufficient authority for a destructive
	 * resolution.
	 */
	getAuthoritativeBlobDeleteSnapshot(path: string): BlobRemoteDeleteSnapshot | null {
		const normalizedPath = this.normPath(path);
		if (this.pathToBlob.has(normalizedPath)) return null;

		const tombstone = this.blobTombstones.get(normalizedPath);
		if (
			!tombstone
			|| typeof tombstone.deletedAt !== "number"
			|| !Number.isFinite(tombstone.deletedAt)
		) {
			return null;
		}

		const device = typeof tombstone.device === "string" ? tombstone.device : null;
		const candidateDeletedRef = cloneBlobRef(tombstone.deletedRef);
		const deletedRef = candidateDeletedRef
			&& isSha256Hex(candidateDeletedRef.hash)
			&& Number.isFinite(candidateDeletedRef.size)
			&& candidateDeletedRef.size >= 0
			? candidateDeletedRef
			: undefined;
		const fingerprint = JSON.stringify([
			"blob",
			normalizedPath,
			tombstone.deletedAt,
			device,
			blobRefFingerprint(deletedRef),
		]);

		return {
			kind: "blob",
			path: normalizedPath,
			deletedAt: tombstone.deletedAt,
			device,
			deletedRef,
			fingerprint,
		};
	}

	/**
	 * Rename a blob with a self-contained delete episode at the old path.
	 * Receivers can therefore retire their old disk replica without relying on
	 * transaction oldValue or a separate rename event. A different live ref at
	 * the destination always wins; it is never overwritten by the source ref.
	 */
	renameBlobRefWithTombstoneIfCurrent(
		oldPath: string,
		newPath: string,
		base: PendingBlobMutationBase,
		device?: string,
	): CausalBlobRenameResult {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);
		const currentRef = cloneBlobRef(this.pathToBlob.get(oldPath));
		if (!currentRef) return { kind: "already-absent" };
		if (!base.known) {
			return { kind: "unknown-source", currentRef };
		}
		const expectedRef = cloneBlobRef(base.ref);
		if (!base.sourceVersionKnown || !base.expectedSourceVersion) {
			return { kind: "unknown-source", currentRef };
		}
		const expectedSourceVersion = base.expectedSourceVersion;
		if (
			!sameBlobRef(currentRef, expectedRef)
			|| this.getBlobSourceVersion(oldPath) !== expectedSourceVersion
		) {
			return {
				kind: "source-conflict",
				expectedRef,
				currentRef,
				mutationApplied: false,
			};
		}
		if (oldPath === newPath) return { kind: "same-path", ref: currentRef };

		const destinationRef = cloneBlobRef(this.pathToBlob.get(newPath));
		const destinationConflict = !!destinationRef
			&& !sameBlobRef(destinationRef, currentRef);
		let mutationApplied = false;
		this.ydoc.transact(() => {
			if (
				!sameBlobRef(this.pathToBlob.get(oldPath), expectedRef)
				|| this.getBlobSourceVersion(oldPath) !== expectedSourceVersion
			) return;
			this.pathToBlob.delete(oldPath);
			this.blobTombstones.set(oldPath, {
				deletedAt: Date.now(),
				device,
				deletedRef: currentRef,
			});
			if (!destinationConflict) {
				this.pathToBlob.set(newPath, currentRef);
				this.blobTombstones.delete(newPath);
			}
			mutationApplied = true;
		}, ORIGIN_SEED);

		if (!mutationApplied || this.pathToBlob.has(oldPath)) {
			return {
				kind: "source-conflict",
				expectedRef,
				currentRef: cloneBlobRef(this.pathToBlob.get(oldPath)),
				mutationApplied,
			};
		}
		return destinationConflict
			? {
				kind: "destination-conflict",
				sourceRef: currentRef,
				destinationRef,
			}
			: { kind: "moved", ref: currentRef };
	}

	renameBlobRefWithTombstone(
		oldPath: string,
		newPath: string,
		device?: string,
	): BlobRenameResult {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const ref = cloneBlobRef(this.pathToBlob.get(oldPath));
		if (!ref) return { kind: "missing-source" };
		if (oldPath === newPath) return { kind: "same-path", ref };
		const destinationRef = cloneBlobRef(this.pathToBlob.get(newPath));
		const destinationConflict = !!destinationRef
			&& !sameBlobRef(destinationRef, ref);

		this.ydoc.transact(() => {
			this.pathToBlob.delete(oldPath);
			this.blobTombstones.set(oldPath, {
				deletedAt: Date.now(),
				device,
				deletedRef: ref,
			});
			if (!destinationConflict) {
				this.pathToBlob.set(newPath, ref);
				if (this.blobTombstones.has(newPath)) {
					this.blobTombstones.delete(newPath);
				}
			}
		}, ORIGIN_SEED);

		this.log(
			destinationConflict
				? `renameBlobRef: tombstoned "${oldPath}"; preserved conflicting destination "${newPath}"`
				: `renameBlobRef: "${oldPath}" -> "${newPath}" with source tombstone`,
		);
		return destinationConflict
			? {
				kind: "destination-conflict",
				sourceRef: ref,
					destinationRef,
			}
			: { kind: "moved", ref };
	}

	// -------------------------------------------------------------------
	// Rename batching
	// -------------------------------------------------------------------

	/**
	 * Queue a rename for batched application. Multiple renames arriving
	 * within RENAME_BATCH_MS (e.g. folder rename) are collected and
	 * applied in a single ydoc.transact().
	 *
	 * Transitive chains are resolved: if A→B and B→C arrive in the same
	 * batch, they collapse to A→C.
	 */
	queueRename(oldPath: string, newPath: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const rootOldPath = this._renameBatchNewToOld.get(oldPath) ?? oldPath;
		if (rootOldPath === newPath) {
			this.deletePendingRenameByOldPath(rootOldPath);
		} else {
			this.setPendingRename(rootOldPath, newPath);
		}
		if (rootOldPath !== oldPath) {
			this.deletePendingRenameByOldPath(oldPath);
		}

		// Reset the debounce timer
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this._renameTimer = setTimeout(() => this.flushRenameBatch(), RENAME_BATCH_MS);
	}

	isPendingRenameTarget(path: string): boolean {
		path = this.normPath(path);
		return this._renameBatchNewToOld.has(path);
	}

	getPendingRenameOldPathForTarget(path: string): string | undefined {
		path = this.normPath(path);
		return this._renameBatchNewToOld.get(path);
	}

	/**
	 * Register a callback invoked after each rename batch flush.
	 * Receives the map of old→new paths that were applied.
	 */
	onRenameBatchFlushed(callback: (renames: Map<string, string>) => void): void {
		this._onRenameBatchFlushed = callback;
	}

	private flushRenameBatch(): void {
		this._renameTimer = null;
		if (this._renameBatch.size === 0) return;

		const batch = new Map(this._renameBatch);
		this.clearPendingRenames();

		this.log(`Flushing rename batch: ${batch.size} renames`);
		this.applyRenameBatch(batch, this._device);
	}

	/** Direct single rename (kept for programmatic use). */
	handleRename(oldPath: string, newPath: string, device?: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const fileId = this.getFileId(oldPath);
		if (!fileId) {
			this.log(`handleRename: "${oldPath}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.delete(oldPath);
				this.pathToId.set(newPath, fileId);
			}
			this.clearMarkdownTombstonesForPath(newPath, fileId);
			this.setMetaActive(fileId, newPath, device);
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.log(`handleRename: "${oldPath}" -> "${newPath}" (id=${fileId})`);
	}

	/**
	 * Apply rename decisions inferred by authoritative reconciliation when the
	 * original Obsidian rename event was missed. Reuses the normal rename batch
	 * executor so file IDs, metadata observers, editor bookkeeping callbacks,
	 * and disk-index/cache moves follow the same path as live rename events.
	 */
	applyReconcileRenameBatch(renames: Map<string, string>, device?: string): void {
		if (renames.size === 0) return;
		this.applyRenameBatch(renames, device ?? this._device);
	}

	private promotePendingRenameTarget(path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const pendingOldPath = this._renameBatchNewToOld.get(normalizedPath);
		if (!pendingOldPath) return;

		this.deletePendingRenameByOldPath(pendingOldPath);
		if (this._renameBatch.size === 0 && this._renameTimer) {
			clearTimeout(this._renameTimer);
			this._renameTimer = null;
		}

		const batch = new Map([[pendingOldPath, normalizedPath]]);
		this.log(`Promoting pending rename target: "${pendingOldPath}" -> "${normalizedPath}"`);
		this.applyRenameBatch(batch, device ?? this._device);
	}

	private applyRenameBatch(batch: Map<string, string>, device?: string): void {
		if (batch.size === 0) return;

		// Collect file IDs before the transaction for flight events.
		const renamedIds: Array<{ oldPath: string; newPath: string; fileId: string }> = [];

		this.ydoc.transact(() => {
			for (const [oldPath, newPath] of batch) {
				const fileId = this.getFileId(oldPath);
				if (fileId) {
					if (this.shouldWriteLegacyPathMap()) {
						this.pathToId.delete(oldPath);
						this.pathToId.set(newPath, fileId);
					}
					this.clearMarkdownTombstonesForPath(newPath, fileId);
					this.setMetaActive(fileId, newPath, device);
					this.log(`renameBatch: "${oldPath}" -> "${newPath}" (id=${fileId})`);
					renamedIds.push({ oldPath, newPath, fileId });
				}

				const blobRef = cloneBlobRef(this.pathToBlob.get(oldPath));
				if (blobRef) {
					const destinationRef = cloneBlobRef(this.pathToBlob.get(newPath));
					const destinationConflict = !!destinationRef
						&& !sameBlobRef(destinationRef, blobRef);
					this.pathToBlob.delete(oldPath);
					this.blobTombstones.set(oldPath, {
						deletedAt: Date.now(),
						device,
						deletedRef: blobRef,
					});
					if (!destinationConflict) {
						this.pathToBlob.set(newPath, blobRef);
						if (this.blobTombstones.has(newPath)) {
							this.blobTombstones.delete(newPath);
						}
					}
					this.log(
						destinationConflict
							? `renameBatch: blob source tombstoned; destination conflict preserved "${newPath}"`
							: `renameBatch: blob "${oldPath}" -> "${newPath}" with source tombstone`,
					);
				}
			}
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;

		// Emit crdt.file.renamed for each markdown file that was renamed.
		for (const { newPath, fileId } of renamedIds) {
			this.onFlightPathEvent?.({
				priority: "important",
				kind: FLIGHT_KIND.crdtFileRenamed,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "crdt",
				path: newPath,
				fileId,
				data: { batchSize: batch.size },
			});
		}

		this._onRenameBatchFlushed?.(batch);
	}

	private clearMarkdownTombstonesForPath(path: string, keepFileId?: string): number {
		const normalizedPath = this.normPath(path);
		const tombstonedIds: string[] = [];
		this.meta.forEach((value: unknown, fileId: string) => {
			const metaPath = getMetaPath(value);
			if (
				fileId !== keepFileId
				&& metaPath
				&& this.normPath(metaPath) === normalizedPath
				&& isFileMetaDeletedValue(value)
			) {
				tombstonedIds.push(fileId);
			}
		});

		for (const tombstonedId of tombstonedIds) {
			this.meta.delete(tombstonedId);
		}

		return tombstonedIds.length;
	}

	private getMarkdownTombstoneIds(path: string): string[] {
		const normalizedPath = this.normPath(path);
		const tombstonedIds: string[] = [];
		this.meta.forEach((value: unknown, fileId: string) => {
			const metaPath = getMetaPath(value);
			if (
				metaPath
				&& this.normPath(metaPath) === normalizedPath
				&& isFileMetaDeletedValue(value)
			) {
				tombstonedIds.push(fileId);
			}
		});
		return tombstonedIds;
	}

	handleDelete(path: string, device?: string, opId?: string): void {
		path = this.normPath(path);

		// Check pending rename batch for races:
		// 1. If a pending rename maps X → path (our delete target is the
		//    NEW name), cancel the rename and delete from the old path.
		// 2. If a pending rename maps path → Y (our delete target is the
		//    OLD name, rename hasn't flushed), cancel the rename and
		//    delete from path (it's still in pathToId).
		let resolvedPath = path;
		const pendingOldPath = this._renameBatchNewToOld.get(path);
		if (pendingOldPath) {
			const pendingNewPath = this._renameBatch.get(pendingOldPath) ?? path;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath,
				pendingNewPath,
				case: "rename-target",
			});
			this.log(`handleDelete: "${path}" is a pending rename target from "${pendingOldPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(pendingOldPath);
			resolvedPath = pendingOldPath;
		} else if (this._renameBatch.has(path)) {
			const pendingNewPath = this._renameBatch.get(path)!;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath: path,
				pendingNewPath,
				case: "rename-source",
			});
			this.log(`handleDelete: "${path}" has pending rename to "${pendingNewPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(path);
			resolvedPath = path;
		}

		const fileId = this.getFileId(resolvedPath);
		if (!fileId) {
			// Not a markdown file — might be a blob
			if (this.pathToBlob.has(resolvedPath)) {
				this.deleteBlobRef(resolvedPath, device);
			} else {
				this.log(`handleDelete: "${resolvedPath}" not in CRDT, ignoring`);
			}
			return;
		}

		this.ydoc.transact(() => {
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.delete(resolvedPath);
			}
			this.setMetaDeleted(fileId, resolvedPath, device);
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.trace?.("sync", "markdown-tombstoned", {
			requestedPath: path,
			resolvedPath,
			fileId,
			device: device ?? null,
		});
		this.onFlightPathEvent?.({
			priority: "critical",
			kind: FLIGHT_KIND.crdtFileTombstoned,
			severity: "info",
			scope: "file",
			source: "vaultSync",
			layer: "crdt",
			path: resolvedPath,
			fileId,
			opId,
		});

		this.log(`handleDelete: "${resolvedPath}" marked deleted (id=${fileId})`);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get localReady(): boolean {
		return this._localReady;
	}

	get providerSynced(): boolean {
		return this._providerSynced;
	}

	get connected(): boolean {
		return this.provider.wsconnected;
	}

	get connectionGeneration(): number {
		return this._connectionGeneration;
	}

	// Update-tracking getters (delegated to UpdateTracker — INV-ACK-01)
	get lastLocalUpdateAt(): number | null { return this.updateTracker.lastLocalUpdateAt; }
	get lastLocalUpdateWhileConnectedAt(): number | null { return this.updateTracker.lastLocalUpdateWhileConnectedAt; }
	get lastRemoteUpdateAt(): number | null { return this.updateTracker.lastRemoteUpdateAt; }
	get serverAppliedLocalState(): boolean | null { return this.serverAckTracker.serverAppliedLocalState; }
	get lastServerReceiptEchoAt(): number | null { return this.serverAckTracker.lastServerReceiptEchoAt; }
	get lastKnownServerReceiptEchoAt(): number | null { return this.serverAckTracker.lastKnownServerReceiptEchoAt; }
	get serverReceiptCandidateId(): string | null { return this.serverAckTracker.lastCandidateId; }
	get lastConfirmedReceiptCandidateId(): string | null { return this.serverAckTracker.lastConfirmedCandidateId; }
	get candidatePersistenceHealthy(): boolean | null {
		if (!this._serverAckScope && !this._serverAckPersistenceUnavailable) return null;
		if (this._serverAckPersistenceUnavailable) return false;
		return this.serverAckTracker.candidatePersistenceHealthy;
	}
	get candidatePersistenceFailureCount(): number {
		return this.serverAckTracker.candidatePersistenceFailureCount + (this._serverAckPersistenceUnavailable ? 1 : 0);
	}
	get hasUnconfirmedServerReceiptCandidate(): boolean { return this.serverAckTracker.hasUnconfirmedCandidate; }
	get serverReceiptCandidateCapturedAt(): number | null { return this.serverAckTracker.candidateCapturedAt; }

	async flushReceiptPersistence(): Promise<void> {
		await this.serverAckTracker.flushReceiptPersistence();
	}
	get serverReceiptStartupValidation(): ServerReceiptStartupValidation { return this._serverReceiptStartupValidation; }
	get svEchoCounters(): SvEchoCounters { return { ...this._svEchoCounters }; }

	async clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed"> {
		if (!this._serverAckStore) {
			await this.serverAckTracker.clearLocalReceiptState(false);
			return "cleared_memory_only";
		}
		const beforeFailures = this.serverAckTracker.candidatePersistenceFailureCount;
		await this.serverAckTracker.clearLocalReceiptState(true);
		if (this.serverAckTracker.candidatePersistenceFailureCount > beforeFailures) return "failed";
		return "cleared_persistent";
	}

	get fatalAuthError(): boolean {
		return this._fatalAuthError;
	}

	get fatalAuthCode(): "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required" | null {
		return this._fatalAuthCode;
	}

	get fatalAuthDetails(): {
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	} | null {
		return this._fatalAuthDetails;
	}

	get idbError(): boolean {
		return this._idbError;
	}

	get idbErrorDetails(): IndexedDbErrorDetails | null {
		return this._idbErrorDetails;
	}

	reportIndexedDbError(
		err: unknown,
		phase: IndexedDbErrorDetails["phase"] = "runtime",
	): void {
		this.captureIndexedDbError(err, phase);
	}

	/** The IndexedDB database name for this vault. */
	get idbName(): string {
		const vaultId = this.sys.get("vaultId");
		return `kaos:${typeof vaultId === "string" ? vaultId : "unknown"}`;
	}

	/**
	 * Wipe all CRDT maps (pathToId, idToText, meta, sys) in a single
	 * transaction. Collects keys first to avoid mutating during iteration.
	 * This propagates to the server via the provider (intentional for nuclear reset).
	 */
	clearAllMaps(): { pathCount: number; idCount: number; metaCount: number; blobCount: number } {
		const pathKeys = Array.from(this.pathToId.keys());
		const idKeys = Array.from(this.idToText.keys());
		const metaKeys = Array.from(this.meta.keys());
		const sysKeys = Array.from(this.sys.keys());
		const blobPathKeys = Array.from(this.pathToBlob.keys());
		const blobMetaKeys = Array.from(this.blobMeta.keys());
		const blobTombKeys = Array.from(this.blobTombstones.keys());

		this.ydoc.transact(() => {
			for (const k of pathKeys) this.pathToId.delete(k);
			for (const k of idKeys) this.idToText.delete(k);
			for (const k of metaKeys) this.meta.delete(k);
			for (const k of sysKeys) this.sys.delete(k);
			for (const k of blobPathKeys) this.pathToBlob.delete(k);
			for (const k of blobMetaKeys) this.blobMeta.delete(k);
			for (const k of blobTombKeys) this.blobTombstones.delete(k);
		}, ORIGIN_SEED);
		this._pathIndexesDirty = true;

		this.log(
			`clearAllMaps: removed ${pathKeys.length} paths, ` +
			`${idKeys.length} texts, ${metaKeys.length} meta entries, ` +
			`${blobPathKeys.length} blob paths`,
		);

		return {
			pathCount: pathKeys.length,
			idCount: idKeys.length,
			metaCount: metaKeys.length,
			blobCount: blobPathKeys.length,
		};
	}

	/**
	 * Delete the IndexedDB database for this vault.
	 * Safe to call after destroy() — uses the raw IDB deleteDatabase API.
	 */
	static deleteIdb(vaultId: string): Promise<void> {
		const name = `kaos:${vaultId}`;
		return new Promise((resolve, reject) => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error ?? new Error(`Failed to delete IndexedDB database "${name}"`));
			req.onblocked = () => {
				console.warn(`[kaos] IDB delete blocked for "${name}"`);
				// Resolve anyway — it'll be deleted when connections close
				resolve();
			};
		});
	}

	// -------------------------------------------------------------------
	// Socket ticket proactive refresh
	// -------------------------------------------------------------------

	private markFatalAuth(msg: FatalAuthMessage): void {
		const firstFatal = !this._fatalAuthError;
		this._fatalAuthError = true;
		this._fatalAuthCode = msg.code;
		this._fatalAuthDetails = {
			clientSchemaVersion: msg.clientSchemaVersion,
			roomSchemaVersion: msg.roomSchemaVersion,
			reason: msg.reason,
		};
		if (firstFatal) {
			this.log(`Fatal auth error: ${msg.code} — stopping reconnection`);
		}
		this.cancelSocketAuthRecovery(true);
		this._socketTicketRefreshPendingForOnline = false;
		this.clearSocketTicketRefreshTimer();
		this.provider.disconnect();
		this.resolvePendingProviderSyncWaiters(false);
	}

	private cancelSocketAuthRecovery(resetAttempted: boolean): void {
		this._socketAuthRecoveryInFlight = false;
		if (resetAttempted) this._socketAuthRecoveryAttempted = false;
		this._socketAuthRecoveryReconnectStarted = false;
		this._socketAuthRecoveryMessage = null;
		this._socketAuthRecoveryIntentEpoch = null;
		this._socketAuthRecoveryRejectedSocket = null;
	}

	private markSocketTicketSyncSucceeded(): void {
		// A socket-open event precedes server auth frames. Only a completed Yjs
		// sync proves the fresh ticket was accepted, re-arms one immediate recovery,
		// and resets the pre-sync connection-flap backoff.
		this._socketAuthRecoveryAttempted = false;
		this._socketAuthRecoveryInFlight = false;
		this._socketAuthRecoveryReconnectStarted = false;
		this._socketAuthRecoveryMessage = null;
		this._socketAuthRecoveryIntentEpoch = null;
		this._socketAuthRecoveryRejectedSocket = null;
		this._socketTicketReconnectAttemptedSinceSync = false;
		this._socketTicketConnectRetryFailureCount = 0;
	}

	private markFatalSocketTicketHttpAuth(err: unknown): boolean {
		if (!(err instanceof SocketTicketHttpError) || (err.status !== 401 && err.status !== 403)) {
			return false;
		}
		this.markFatalAuth({
			code: "unauthorized",
			clientSchemaVersion: null,
			roomSchemaVersion: null,
			reason: `socket ticket endpoint rejected credentials (${err.status})`,
		});
		return true;
	}

	private isCurrentSocketAuthRecovery(): boolean {
		return !!this._socketAuthRecoveryMessage
			&& !this._destroyed
			&& !this._fatalAuthError
			&& this._socketTicketConnectionWanted
			&& this._socketAuthRecoveryIntentEpoch === this._socketTicketConnectionIntentEpoch;
	}

	private runSocketAuthRecovery(): void {
		const msg = this._socketAuthRecoveryMessage;
		if (!msg || !this.isCurrentSocketAuthRecovery()) return;
		if (this.isSocketTicketNetworkOffline()) {
			this.deferSocketTicketRetryUntilOnline("auth");
			return;
		}

		void this.fetchAndPatchProviderTicket(true)
			.then(async (refreshed) => {
				if (!this.isCurrentSocketAuthRecovery()) return;
				if (!refreshed) {
					if (this.isSocketTicketNetworkOffline()) {
						this.deferSocketTicketRetryUntilOnline("auth");
						return;
					}
					this.log("Socket auth recovery unavailable: no ticket endpoint");
					this.markFatalAuth(msg);
					return;
				}
				this.log("Socket auth recovery: reconnecting with fresh ticket");
				// This fresh socket is the one immediate auth recovery attempt. A
				// handshake close before status=connected must therefore back off too.
				this._socketTicketReconnectAttemptedSinceSync = true;
				const reconnect = this.provider.connect();
				this._socketAuthRecoveryIntentEpoch = this._socketTicketConnectionIntentEpoch;
				await reconnect;
			})
			.catch((err: unknown) => {
				this.log(`Socket auth recovery failed: ${formatUnknown(err)}`);
				if (!this.isCurrentSocketAuthRecovery()) return;
				if (this.markFatalSocketTicketHttpAuth(err)) return;
				// Network and 5xx failures are transient. Keep auth recovery one-shot
				// and retry the force-refresh action with bounded backoff.
				this.scheduleSocketTicketRetry("auth");
			});
	}

	private tryRecoverSocketAuth(msg: FatalAuthMessage): boolean {
		if (
			msg.code !== "unauthorized"
			|| !this._getSocketTicket
			|| this._fatalAuthError
			|| !this._socketTicketConnectionWanted
			|| this._socketAuthRecoveryInFlight
			|| this._socketAuthRecoveryAttempted
		) {
			return false;
		}

		this._socketAuthRecoveryInFlight = true;
		this._socketAuthRecoveryAttempted = true;
		this._socketAuthRecoveryReconnectStarted = false;
		// Invalidate any params callback that was already awaiting a non-forced
		// cached ticket, without revoking the app's desired connected state.
		this._socketTicketConnectionIntentEpoch++;
		this._socketAuthRecoveryMessage = msg;
		this._socketAuthRecoveryIntentEpoch = this._socketTicketConnectionIntentEpoch;
		this.log("Socket auth rejected; refreshing ticket before marking auth fatal");
		this.clearSocketTicketRefreshTimer();
		this._socketAuthRecoveryRejectedSocket =
			(this.provider as YSyncProvider & { ws?: object | null }).ws ?? null;
		this._socketTicketRawDisconnect?.();
		this.runSocketAuthRecovery();

		return true;
	}

	/**
	 * Schedule a timer to refresh provider.url with a fresh ticket before the
	 * current one expires.  Fires at expiresAt - TICKET_REFRESH_BUFFER_MS,
	 * which is the same threshold the cache uses to decide a ticket is stale.
	 *
	 * This is the primary mechanism ensuring reconnects use a live ticket.
	 * y-partyserver's setupWS loop reads provider.url directly without
	 * re-calling the async params() callback.
	 */
	private scheduleSocketTicketRefresh(ticket: {
		value: string;
		expiresAt: number;
		localExpiresAt: number;
		ttlMs: number;
	}): void {
		if (this.shouldStopSocketTicketRefresh()) return;
		this.clearSocketTicketRefreshTimer();
		this._socketTicketRefreshFailureCount = 0;
		this._socketTicketRefreshPendingForOnline = false;
		const ttlRemaining = ticket.localExpiresAt - Date.now();
		const buffer = Math.min(TICKET_REFRESH_BUFFER_MS, Math.floor(ttlRemaining / 2));
		const msUntilRefresh = Math.max(250, ttlRemaining - buffer);
		this._socketTicketRefreshTimer = setTimeout(() => {
			this._socketTicketRefreshTimer = null;
			void this.refreshProviderTicketUrl(true);
		}, msUntilRefresh);
		this.resumeProviderAfterTicketRefreshIfNeeded();
	}

	private clearSocketTicketRefreshTimer(): void {
		if (this._socketTicketRefreshTimer !== null) {
			clearTimeout(this._socketTicketRefreshTimer);
			this._socketTicketRefreshTimer = null;
		}
		this._socketTicketRetryScheduled = false;
		this._socketTicketRetryKind = null;
	}

	private shouldStopSocketTicketRefresh(): boolean {
		return this.shouldStopVaultSyncConnection() || !this._getSocketTicket;
	}

	private shouldStopVaultSyncConnection(): boolean {
		return this._destroyed || this._fatalAuthError;
	}

	private socketTicketProviderWantsConnection(): boolean {
		// YProvider sets its own shouldConnect only *after* async params succeeds.
		// Therefore it cannot distinguish an intentional disconnect from a ticket
		// request that failed before the socket opened. This app-owned intent is
		// updated by the wrapped public connect()/disconnect() methods instead.
		return this._socketTicketConnectionWanted;
	}

	private startSocketTicketRequest(force: boolean): Promise<SocketTicketValue | null> {
		if (!this._getSocketTicket) return Promise.resolve(null);
		const request = this._getSocketTicket(force);
		this._socketTicketRequestInFlight = request;
		this._socketTicketRequestInFlightForce = force;
		void request.then(
			() => {
				if (this._socketTicketRequestInFlight === request) {
					this._socketTicketRequestInFlight = null;
					this._socketTicketRequestInFlightForce = false;
				}
			},
			() => {
				if (this._socketTicketRequestInFlight === request) {
					this._socketTicketRequestInFlight = null;
					this._socketTicketRequestInFlightForce = false;
				}
			},
		);
		return request;
	}

	private startQueuedForcedSocketTicketRequest(): Promise<SocketTicketValue | null> {
		if (
			this.shouldStopSocketTicketRefresh()
			|| !this.socketTicketProviderWantsConnection()
			|| this.isSocketTicketNetworkOffline()
		) {
			return Promise.resolve(null);
		}
		return this.startSocketTicketRequest(true);
	}

	private requestSocketTicket(force = false): Promise<SocketTicketValue | null> {
		if (!this._getSocketTicket) return Promise.resolve(null);
		const active = this._socketTicketRequestInFlight;
		if (!active) return this.startSocketTicketRequest(force);
		if (!force || this._socketTicketRequestInFlightForce) return active;
		if (this._socketTicketForcedRequestQueued) return this._socketTicketForcedRequestQueued;

		// A forced auth refresh must not inherit a possibly cached non-forced
		// result. Serialize one forced request behind it; concurrent force callers
		// share that queued request, so HTTP concurrency remains one.
		const queued = active.then(
			() => this.startQueuedForcedSocketTicketRequest(),
			() => this.startQueuedForcedSocketTicketRequest(),
		);
		this._socketTicketForcedRequestQueued = queued;
		void queued.then(
			() => {
				if (this._socketTicketForcedRequestQueued === queued) this._socketTicketForcedRequestQueued = null;
			},
			() => {
				if (this._socketTicketForcedRequestQueued === queued) this._socketTicketForcedRequestQueued = null;
			},
		);
		return queued;
	}

	private installSocketTicketProviderLifecycle(): void {
		const provider = this.provider;
		const connect = provider.connect.bind(provider);
		const disconnect = provider.disconnect.bind(provider);
		this._socketTicketRawDisconnect = disconnect;

		provider.connect = (): Promise<void> => {
			if (this._destroyed || this._fatalAuthError) return Promise.resolve();
			// An idempotent duplicate joins the current async params/connect attempt
			// without invalidating its epoch. If disconnect() revoked intent while an
			// old attempt is still settling, a new connect intent must advance the
			// epoch so that old params result cannot open the socket.
			if (
				this._socketTicketConnectInFlight
				&& this._socketTicketConnectionWanted
				&& this._socketTicketConnectInFlightIntentEpoch === this._socketTicketConnectionIntentEpoch
			) {
				return this._socketTicketConnectInFlight;
			}
			this._socketTicketConnectionIntentEpoch++;
			this._socketTicketConnectionWanted = true;
			const attemptIntentEpoch = this._socketTicketConnectionIntentEpoch;
			if (this.isSocketTicketNetworkOffline()) {
				this.deferSocketTicketRetryUntilOnline("connect");
				return Promise.resolve();
			}

			const request = connect().then(() => {
				// disconnect() may race the async params callback. If intent was
				// revoked while the ticket request was in flight, close immediately
				// and do not leave the successful params call's proactive timer alive.
				if (
					this._socketTicketConnectionIntentEpoch === attemptIntentEpoch
					&& (!this._socketTicketConnectionWanted || this.shouldStopVaultSyncConnection())
				) {
					this.clearSocketTicketRefreshTimer();
					disconnect();
				}
			}).catch((err: unknown) => {
				// A disconnect followed by an immediate reconnect can leave the old
				// async params attempt settling behind the new one. Only the attempt
				// owning the current intent may classify errors or schedule retries.
				if (this._socketTicketConnectionIntentEpoch === attemptIntentEpoch) {
					this.log(`Provider connect failed: ${formatUnknown(err)}`);
					if (!this.markFatalSocketTicketHttpAuth(err)) {
						this.scheduleSocketTicketRetry("connect");
					}
				}
				throw err;
			});
			this._socketTicketConnectInFlight = request;
			this._socketTicketConnectInFlightIntentEpoch = attemptIntentEpoch;
			void request.then(
				() => {
					if (this._socketTicketConnectInFlight === request) {
						this._socketTicketConnectInFlight = null;
						this._socketTicketConnectInFlightIntentEpoch = null;
					}
				},
				() => {
					if (this._socketTicketConnectInFlight === request) {
						this._socketTicketConnectInFlight = null;
						this._socketTicketConnectInFlightIntentEpoch = null;
					}
				},
			);
			return request;
		};
		provider.disconnect = (): void => {
			this._socketTicketConnectionIntentEpoch++;
			this._socketTicketConnectionWanted = false;
			this._socketTicketDisconnectRecoveryPending = false;
			this._socketTicketRefreshPendingForOnline = false;
			// Revoking a socket intent cancels in-flight recovery work, but it is not
			// proof that credentials succeeded. Preserve the one-shot attempted latch;
			// only sync(true) may re-arm it for a live instance.
			this.cancelSocketAuthRecovery(false);
			this.clearSocketTicketRefreshTimer();
			disconnect();
		};
	}

	private isSocketTicketNetworkOffline(): boolean {
		// Only pause when this runtime can observe the matching online event. A
		// headless runtime without an event target must keep the bounded retry path
		// instead of becoming permanently paused.
		return this._socketTicketOnlineHandler !== null
			&& typeof navigator !== "undefined"
			&& navigator.onLine === false;
	}

	private resumeDeferredSocketTicketRefresh(): void {
		if (!this._socketTicketRefreshPendingForOnline) return;
		const retryKind = this._socketTicketRetryKind ?? "refresh";
		this._socketTicketRefreshPendingForOnline = false;
		this._socketTicketRetryKind = null;
		if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return;
		this.log("Network online; resuming deferred socket ticket refresh");
		if (retryKind === "auth") {
			this.runSocketAuthRecovery();
		} else if (retryKind === "connect") {
			this.connectProviderWithTicketRetry();
		} else {
			void this.refreshProviderTicketUrl(true);
		}
	}

	private socketTicketRetryPriority(kind: SocketTicketRetryKind | null): number {
		return kind === "auth" ? 3 : kind === "connect" ? 2 : kind === "refresh" ? 1 : 0;
	}

	private strongerSocketTicketRetryKind(
		current: SocketTicketRetryKind | null,
		candidate: SocketTicketRetryKind,
	): SocketTicketRetryKind {
		return this.socketTicketRetryPriority(current) >= this.socketTicketRetryPriority(candidate)
			? current as SocketTicketRetryKind
			: candidate;
	}

	private deferSocketTicketRetryUntilOnline(kind: SocketTicketRetryKind): void {
		const effectiveKind = this.strongerSocketTicketRetryKind(this._socketTicketRetryKind, kind);
		this.clearSocketTicketRefreshTimer();
		this._socketTicketRetryKind = effectiveKind;
		this._socketTicketRefreshPendingForOnline = true;
		this.log("socket ticket request deferred while network is offline");
	}

	private scheduleSocketTicketRetry(kind: SocketTicketRetryKind): void {
		if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return;
		if (this.isSocketTicketNetworkOffline()) {
			this.deferSocketTicketRetryUntilOnline(kind);
			return;
		}
		if (this._socketTicketRetryScheduled) {
			// Connect recovery dominates a concurrent URL-only refresh. Preserve the
			// existing timer and its current backoff instead of creating a duplicate.
			this._socketTicketRetryKind = this.strongerSocketTicketRetryKind(
				this._socketTicketRetryKind,
				kind,
			);
			return;
		}

		this.clearSocketTicketRefreshTimer();
		const failureCount = kind === "connect"
			? ++this._socketTicketConnectRetryFailureCount
			: ++this._socketTicketRefreshFailureCount;
		const retryMs = socketTicketRetryDelayMs(failureCount);
		this._socketTicketRetryScheduled = true;
		this._socketTicketRetryKind = kind;
		this.log(
			`socket ticket ${kind} retry scheduled in ${retryMs}ms ` +
			`(failure ${failureCount})`,
		);
		this._socketTicketRefreshTimer = setTimeout(() => {
			this._socketTicketRefreshTimer = null;
			this._socketTicketRetryScheduled = false;
			const pendingKind = this._socketTicketRetryKind;
			this._socketTicketRetryKind = null;
			const underlyingConnectionStopped =
				(this.provider as YSyncProvider & { shouldConnect?: boolean }).shouldConnect === false;
			if (pendingKind === "auth") {
				this.runSocketAuthRecovery();
			} else if (
				pendingKind === "connect"
				|| (
					this._socketTicketConnectionWanted
					&& !this.provider.wsconnected
					&& !this.provider.wsconnecting
					&& underlyingConnectionStopped
				)
			) {
				this.connectProviderWithTicketRetry();
			} else {
				void this.refreshProviderTicketUrl(true);
			}
		}, retryMs);
	}

	private connectProviderWithTicketRetry(): void {
		if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return;
		if (this.provider.wsconnected || this.provider.wsconnecting) return;
		if (this.isSocketTicketNetworkOffline()) {
			this.deferSocketTicketRetryUntilOnline("connect");
			return;
		}
		const reconnect = this.provider.connect();
		if (this._socketAuthRecoveryInFlight) {
			this._socketAuthRecoveryIntentEpoch = this._socketTicketConnectionIntentEpoch;
		}
		void reconnect.catch(() => {
			// The lifecycle wrapper owns logging and retry scheduling.
		});
	}

	private observeSocketTicketConnectionClose(closedSocket: object | null): void {
		// y-partyserver emits connection-close and then, only for sockets that had
		// opened, status=disconnected in the same close callback. Record that pair
		// so the fallback status cannot process one close twice. Handshake failures
		// have no status event; clear the marker at the next microtask instead.
		this._socketTicketConnectionCloseStatusPending = true;
		queueMicrotask(() => {
			this._socketTicketConnectionCloseStatusPending = false;
		});
		this.handleSocketTicketConnectionClose(closedSocket);
	}

	private handleSocketTicketDisconnectedStatus(): void {
		if (this._socketTicketConnectionCloseStatusPending) {
			this._socketTicketConnectionCloseStatusPending = false;
			return;
		}
		this.handleSocketTicketConnectionClose(null);
	}

	private handleSocketTicketConnectionClose(closedSocket: object | null = null): void {
		if (
			closedSocket !== null
			&& closedSocket === this._socketAuthRecoveryRejectedSocket
		) {
			// Ignore exactly the old socket deliberately closed after unauthorized.
			// A distinct fresh handshake socket must take the bounded retry path.
			this._socketAuthRecoveryRejectedSocket = null;
			return;
		}
		if (
			!this._getSocketTicket
			|| !this._socketTicketConnectionWanted
			|| this._fatalAuthError
			// manual/fatal/destroy and our own raw pause set shouldConnect=false
			// before closing the socket. Ignore the close event they generate.
			|| (this.provider as YSyncProvider & { shouldConnect?: boolean }).shouldConnect === false
		) {
			return;
		}
		this.recoverSocketTicketAfterDisconnect();
	}

	private recoverSocketTicketAfterDisconnect(): void {
		if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return;
		this._socketTicketDisconnectRecoveryPending = true;
		// y-partyserver resets its unsuccessful reconnect counter as soon as a socket
		// opens, before Yjs sync proves the connection is usable. Pause its loop on
		// every real disconnect so open/close flapping cannot become a ~100ms loop.
		this.pauseProviderReconnectForSocketTicketRetry();

		const preSyncAuthFlap =
			this._socketAuthRecoveryInFlight && this._socketAuthRecoveryReconnectStarted;
		if (preSyncAuthFlap || this._socketTicketReconnectAttemptedSinceSync) {
			this._socketTicketDisconnectRecoveryPending = false;
			this.scheduleSocketTicketRetry("connect");
			return;
		}

		// Permit exactly one immediate refresh + reconnect after the last proven
		// sync. Every further pre-sync close uses the bounded connect counter below.
		this._socketTicketReconnectAttemptedSinceSync = true;
		if (this._socketTicketRetryScheduled || this._socketTicketConnectInFlight) {
			this._socketTicketDisconnectRecoveryPending = false;
			this.scheduleSocketTicketRetry("connect");
			return;
		}
		if (this._socketTicketRefreshInFlight) return;
		if (this.isSocketTicketNetworkOffline()) {
			this._socketTicketDisconnectRecoveryPending = false;
			this.deferSocketTicketRetryUntilOnline("connect");
			return;
		}
		void this.refreshProviderTicketUrl(true);
	}

	private pauseProviderReconnectForSocketTicketRetry(): void {
		if (!this._socketTicketDisconnectRecoveryPending) return;
		const provider = this.provider as YSyncProvider & { shouldConnect?: boolean };
		// disconnect() can emit another disconnected status. Guarding the provider's
		// own intent prevents recursively pausing an already-paused reconnect loop.
		if (provider.shouldConnect === false) return;
		this._socketTicketRawDisconnect?.();
	}

	private resumeProviderAfterTicketRefreshIfNeeded(): void {
		if (!this._socketTicketDisconnectRecoveryPending) return;
		this._socketTicketDisconnectRecoveryPending = false;
		if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return;
		// This is the one immediate reconnect allowed since the last sync(true).
		// Subsequent pre-sync disconnects are routed through connect retry backoff.
		void this.provider.connect().catch(() => {
			// The lifecycle wrapper owns logging and retry scheduling.
		});
	}

	/**
	 * Replace the ticket value in provider.url, removing any legacy ?token=.
	 * Preserves all other query params (schemaVersion, _pk, device, trace, boot).
	 */
	private patchProviderTicket(value: string): void {
		try {
			this.provider.url = patchTicketInUrl(this.provider.url, value);
			this.log("socket ticket refreshed in provider URL");
		} catch (err) {
			this.log(`patchProviderTicket: failed to update provider URL: ${formatUnknown(err)}`);
		}
	}

	private async runFetchAndPatchProviderTicket(force: boolean): Promise<boolean> {
		if (this.shouldStopSocketTicketRefresh() || !this._getSocketTicket) return false;
		if (!this.socketTicketProviderWantsConnection()) return false;
		const ticket = await this.requestSocketTicket(force);
		if (!ticket) {
			this.resumeProviderAfterTicketRefreshIfNeeded();
			return false;
		}
		// A fetch that outlives destroy() or a fatal-auth frame must not mutate
		// provider state or resurrect a refresh timer.
		if (this.shouldStopSocketTicketRefresh()) return false;
		if (!this.socketTicketProviderWantsConnection()) return false;
		this.patchProviderTicket(ticket.value);
		this.scheduleSocketTicketRefresh(ticket);
		return true;
	}

	private fetchAndPatchProviderTicket(force = false): Promise<boolean> {
		return this.runFetchAndPatchProviderTicket(force);
	}

	/**
	 * Fetch a fresh ticket (optionally bypassing the cache) and patch
	 * provider.url.  Reschedules the refresh timer on success.
	 * On transient failure, retries with bounded exponential equal jitter so
	 * the proactive refresh cycle survives intermittent network errors without
	 * turning a prolonged outage into a fixed-rate poll.
	 */
	private async refreshProviderTicketUrl(force = false): Promise<boolean> {
		if (this.shouldStopSocketTicketRefresh()) return false;
		if (this._socketTicketRefreshInFlight || this._socketTicketRetryScheduled) return false;
		// provider.disconnect() sets shouldConnect=false. Do not keep refreshing
		// credentials while a controller intentionally holds sync disconnected.
		// Ordinary network loss leaves shouldConnect=true and remains recoverable.
		if (!this.socketTicketProviderWantsConnection()) return false;
		if (this.isSocketTicketNetworkOffline()) {
			const retryKind = this._socketTicketDisconnectRecoveryPending ? "connect" : "refresh";
			this.pauseProviderReconnectForSocketTicketRetry();
			this._socketTicketDisconnectRecoveryPending = false;
			this.deferSocketTicketRetryUntilOnline(retryKind);
			return false;
		}

		this._socketTicketRefreshInFlight = true;
		try {
			const refreshed = await this.fetchAndPatchProviderTicket(force);
			if (!refreshed && this.isSocketTicketNetworkOffline()) {
				const retryKind = this._socketTicketDisconnectRecoveryPending ? "connect" : "refresh";
				this.pauseProviderReconnectForSocketTicketRetry();
				this._socketTicketDisconnectRecoveryPending = false;
				this.deferSocketTicketRetryUntilOnline(retryKind);
			}
			return refreshed;
		} catch (err) {
			this.log(`socket ticket refresh failed: ${formatUnknown(err)}`);
			if (this.shouldStopSocketTicketRefresh() || !this.socketTicketProviderWantsConnection()) return false;
			if (this.markFatalSocketTicketHttpAuth(err)) return false;
			if (this.isSocketTicketNetworkOffline()) {
				const retryKind = this._socketTicketDisconnectRecoveryPending ? "connect" : "refresh";
				this.pauseProviderReconnectForSocketTicketRetry();
				this._socketTicketDisconnectRecoveryPending = false;
				this.deferSocketTicketRetryUntilOnline(retryKind);
				return false;
			}
			// Clear any existing timer before scheduling the retry so we never
			// lose a handle and fire duplicate refreshes.  This matters when the
			// disconnected best-effort path calls here while the proactive timer
			// is already scheduled: without the clear, the proactive timer
			// handle is overwritten but the timer still fires.
			const retryKind = this._socketTicketDisconnectRecoveryPending ? "connect" : "refresh";
			this.pauseProviderReconnectForSocketTicketRetry();
			this._socketTicketDisconnectRecoveryPending = false;
			this.scheduleSocketTicketRetry(retryKind);
			return false;
		} finally {
			this._socketTicketRefreshInFlight = false;
		}
	}

	async destroy(): Promise<void> {
		this.log("Destroying VaultSync");
		this._destroyed = true;
		this._socketTicketRefreshPendingForOnline = false;
		if (this._socketTicketOnlineHandler && typeof window !== "undefined") {
			window.removeEventListener("online", this._socketTicketOnlineHandler);
			this._socketTicketOnlineHandler = null;
		}
		// Revoke connection intent before awaiting persistence so an async params
		// callback cannot open a socket after teardown has started.
		this.provider.disconnect();
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this.clearSocketTicketRefreshTimer();
		this.clearPendingRenames();
		await this.flushReceiptPersistence();

			const provider = this.provider as ProviderWithTerminableSocket;
			const ws = provider.ws;

		// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library (Node/Electron).
		// Safe because it's a targeted call on our own instance.
		if (ws && typeof ws.terminate === "function") {
			ws.terminate();
		}

		// Ensure Awareness interval is cleared (using public API).
		// This is defensive; awareness-protocol already binds to doc destroy.
		if (this.provider.awareness) {
			this.provider.awareness.destroy();
		}

		this.provider.destroy();
		await this.persistence.destroy();
		this.ydoc.destroy();
	}

	private setPendingRename(oldPath: string, newPath: string): void {
		if (oldPath === newPath) {
			this.deletePendingRenameByOldPath(oldPath);
			return;
		}

		const existingOldForTarget = this._renameBatchNewToOld.get(newPath);
		if (existingOldForTarget && existingOldForTarget !== oldPath) {
			this.deletePendingRenameByOldPath(existingOldForTarget);
		}

		const previousTarget = this._renameBatch.get(oldPath);
		if (previousTarget) {
			this._renameBatchNewToOld.delete(previousTarget);
		}

		this._renameBatch.set(oldPath, newPath);
		this._renameBatchNewToOld.set(newPath, oldPath);
	}

	private deletePendingRenameByOldPath(oldPath: string): void {
		const existingTarget = this._renameBatch.get(oldPath);
		if (!existingTarget) return;
		this._renameBatch.delete(oldPath);
		this._renameBatchNewToOld.delete(existingTarget);
	}

	private clearPendingRenames(): void {
		this._renameBatch.clear();
		this._renameBatchNewToOld.clear();
	}

	getRecentEvents(limit = 120): Array<{ ts: string; msg: string }> {
		if (limit <= 0) return [];
		return this._eventRing.slice(-limit);
	}

	getDebugSnapshot(): {
		connected: boolean;
		providerSynced: boolean;
		localReady: boolean;
		connectionGeneration: number;
		fatalAuthError: boolean;
		idbError: boolean;
		idbErrorDetails: IndexedDbErrorDetails | null;
		pathToIdCount: number;
		activePathCount: number;
		tombstonedPathCount: number;
		pathBindingCollisionCount: number;
		storedSchemaVersion: number | null;
		blobPathCount: number;
		serverReceipt: ReturnType<ServerAckTracker["getState"]> & { persistenceUnavailable: boolean };
		serverReceiptStartupValidation: ServerReceiptStartupValidation;
		svEcho: SvEchoCounters;
	} {
		this.ensurePathIndexes();
		return {
			connected: this.connected,
			providerSynced: this.providerSynced,
			localReady: this.localReady,
			connectionGeneration: this.connectionGeneration,
			fatalAuthError: this.fatalAuthError,
			idbError: this.idbError,
			idbErrorDetails: this.idbErrorDetails,
			pathToIdCount: this.pathToId.size,
			activePathCount: this._pathIndex.size,
			tombstonedPathCount: this._deletedPathIndex.size,
			pathBindingCollisionCount: this._activePathCollisions.size,
			storedSchemaVersion: this.storedSchemaVersion,
			blobPathCount: this.pathToBlob.size,
			serverReceipt: {
				...this.serverAckTracker.getState(),
				persistenceUnavailable: this._serverAckPersistenceUnavailable,
			},
			serverReceiptStartupValidation: this._serverReceiptStartupValidation,
			svEcho: this.svEchoCounters,
		};
	}

	private resolvePendingProviderSyncWaiters(value: boolean): void {
		if (this._providerSyncWaiters.size === 0) return;
		const waiters = Array.from(this._providerSyncWaiters);
		this._providerSyncWaiters.clear();
		for (const waiter of waiters) {
			try {
				waiter(value);
			} catch {
				// Ignore waiter errors; each promise handles its own lifecycle.
			}
		}
	}

	private classifyIndexedDbError(err: unknown): {
		kind: IndexedDbErrorKind;
		name: string | null;
		message: string | null;
	} {
		const name =
			typeof (err as { name?: unknown })?.name === "string"
				? (err as { name: string }).name
				: null;
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: err
					? formatUnknown(err)
					: null;

		const haystack = `${name ?? ""} ${message ?? ""}`.toLowerCase();
		if (haystack.includes("quotaexceeded") || haystack.includes("quota exceeded")) {
			return { kind: "quota_exceeded", name, message };
		}
		if (haystack.includes("blocked")) {
			return { kind: "blocked", name, message };
		}
		if (haystack.includes("security") || haystack.includes("permission") || haystack.includes("denied")) {
			return { kind: "permission", name, message };
		}
		return { kind: "unknown", name, message };
	}

	private captureIndexedDbError(err: unknown, phase: IndexedDbErrorDetails["phase"]): void {
		const classified = this.classifyIndexedDbError(err);
		this._idbError = true;
		if (
			!this._idbErrorDetails
			|| (
				this._idbErrorDetails.kind !== "quota_exceeded"
				&& classified.kind === "quota_exceeded"
			)
		) {
			this._idbErrorDetails = {
				...classified,
				phase,
				at: new Date().toISOString(),
			};
		}
		this.log(
			`IndexedDB error (${phase}): kind=${classified.kind}` +
			`${classified.name ? ` name=${classified.name}` : ""}` +
			`${classified.message ? ` msg=${classified.message}` : ""}`,
		);
	}

	private log(msg: string): void {
		this._eventRing.push({ ts: new Date().toISOString(), msg });
		if (this._eventRing.length > 600) {
			this._eventRing.splice(0, this._eventRing.length - 600);
		}
		this.trace?.("sync", msg);
		if (this.debug) {
			console.debug(`[kaos] ${msg}`);
		}
	}
}

export interface TombstonedDiskConflict {
	path: string;
	action: "preserved-local-only";
	reason: "disk-present-at-tombstoned-path";
}

export interface ReconcileResult {
	mode: ReconcileMode;
	createdOnDisk: string[];
	updatedOnDisk: string[];
	seededToCrdt: string[];
	untracked: string[];
	/**
	 * Disk files that exist at tombstoned paths.
	 * These are preserved locally but not synced.
	 * User should resolve manually or via explicit create action.
	 */
	tombstonedDiskConflicts: TombstonedDiskConflict[];
	/**
	 * Disk files whose CRDT path has multiple active fileIds.
	 * They are not seeded or flushed until the binding is explicitly resolved.
	 */
	pathBindingConflicts: string[];
	skipped: number;
}

/**
 * Pure function to classify a disk path during reconciliation.
 * Exported for testing.
 *
 * @param path - The disk file path to classify
 * @param crdtHasPath - Whether the CRDT has an active (non-deleted) entry for this path
 * @param isTombstoned - Whether the path is tombstoned in the CRDT
 * @param mode - The reconciliation mode
 * @returns The classification decision
 */
export function classifyDiskPathForReconcile(
	path: string,
	crdtHasPath: boolean,
	isTombstoned: boolean,
	mode: ReconcileMode,
): {
	action: "skip-in-crdt" | "tombstone-conflict" | "seed-to-crdt" | "untracked";
	conflict?: TombstonedDiskConflict;
} {
	// Already in CRDT — skip
	if (crdtHasPath) {
		return { action: "skip-in-crdt" };
	}

	// Tombstoned in CRDT — do NOT revive (zombie prevention)
	if (isTombstoned) {
		return {
			action: "tombstone-conflict",
			conflict: {
				path,
				action: "preserved-local-only",
				reason: "disk-present-at-tombstoned-path",
			},
		};
	}

	// Not in CRDT — seed if authoritative, otherwise untracked
	if (mode === "authoritative") {
		return { action: "seed-to-crdt" };
	}

	return { action: "untracked" };
}
