/**
 * BlobSyncManager — handles upload/download of non-markdown attachments
 * via content-addressed R2 blob storage.
 *
 * Architecture:
 *   - Client hashes file bytes (SHA-256) and talks to the Worker directly
 *   - The Worker proxies bytes to native R2 bindings (no presigned URLs)
 *   - CRDT maps (pathToBlob, blobMeta, blobTombstones) track which blobs belong where
 *   - Two-phase commit: CRDT is only updated AFTER successful upload
 *   - Content-addressing provides automatic dedup across the vault
 *
 * Flow:
 *   Upload: detect change → hash → check exists → PUT to Worker → set CRDT
 *   Download: CRDT observer fires → check disk → GET from Worker → write disk
 */
import {
	type App,
	TFile,
	normalizePath,
	requestUrl,
	arrayBufferToHex,
	Notice,
} from "obsidian";
import type {
	BlobDeleteCommitResult,
	CausalBlobRenameResult,
	VaultSync,
} from "./vaultSync";
import type { PendingBlobMutationBase } from "./pendingBlobIntentJournal";
import { hasValidUploadBaseSourceVersion } from "./persistedBlobQueue";
import {
	blobRefFingerprint,
	cloneBlobRef,
	createCausalBlobRef,
	getBlobRefPriorHashes,
	isBlobSyncable,
	isSha256Hex,
	MAX_BLOB_REF_PRIOR_HASHES,
	sameBlobRef,
	type BlobRef,
} from "../types";
import { ORIGIN_RESTORE, ORIGIN_SEED } from "./origins";
import {
	appendTraceParams,
	type TraceHttpContext,
	type TraceRecord,
} from "../observability/traceContext";
import {
	type BlobHashCache,
	getCachedHash,
	moveCachedHashes,
	setCachedHash,
	removeCachedHash,
} from "./blobHashCache";
import {
	PreservedUnresolvedRegistry,
	getPreservedUnresolvedEpisodeId,
	getRemoteDeleteEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
	type RemoteDeletePreservedUnresolvedReason,
} from "./preservedUnresolved";
import { LEGACY_MISSING_BLOB_ATTENTION_REASON } from "./blobSettledRefMigration";
import {
	buildBlobConflictArtifactCopyPath,
	buildBlobConflictArtifactPath,
	buildBlobLocalBackupArtifactPath,
	isBlobConflictArtifactPath,
} from "../paths/conflictArtifactPath";

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------

/**
 * Three-way decision for blob remote-delete handling.
 * Discriminated union — NOT a boolean dirty flag.
 */
export type BlobRemoteDeleteDecision =
	| { kind: "apply-delete" }
	| { kind: "preserve-unresolved" };

const DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;
const MAX_RERUN_RESETS = 5;
const RETRY_BASE_MS = 1000;
const SUPPRESS_MS = 1000;
const EXISTS_TIMEOUT_MS = 30_000;
const MIN_TRANSFER_TIMEOUT_MS = 30_000;
const MAX_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_SETUP_BUDGET_MS = 15_000;
const MIN_TRANSFER_BYTES_PER_SEC = 64 * 1024;

class BlobHttpTimeoutError extends Error {
	constructor(
		public readonly operation: string,
		public readonly timeoutMs: number,
	) {
		super(`Timeout (${timeoutMs}ms) during ${operation}`);
		this.name = "BlobHttpTimeoutError";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new BlobHttpTimeoutError(operation, ms));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

function transferTimeoutMs(sizeBytes?: number): number {
	if (!sizeBytes || sizeBytes <= 0) return MIN_TRANSFER_TIMEOUT_MS;
	const transferMs = Math.ceil(
		(sizeBytes / MIN_TRANSFER_BYTES_PER_SEC) * 1000,
	);
	return Math.min(
		MAX_TRANSFER_TIMEOUT_MS,
		Math.max(
			MIN_TRANSFER_TIMEOUT_MS,
			TRANSFER_SETUP_BUDGET_MS + transferMs,
		),
	);
}

// -------------------------------------------------------------------
// Blob HTTP client
// -------------------------------------------------------------------

interface ExistsResult {
	present: string[];
}

class BlobHttpClient {
	constructor(
		private host: string,
		private token: string,
		private vaultId: string,
		private trace?: TraceHttpContext,
	) {}

	/**
	 * Build the HTTP URL for a blob endpoint on the Worker.
	 */
	private url(endpoint: string): string {
		return appendTraceParams(
			`${this.host}/vault/${encodeURIComponent(this.vaultId)}/blobs${endpoint}`,
			this.trace,
		);
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
		};
	}

	async upload(
		hash: string,
		contentType: string,
		data: ArrayBuffer,
		timeoutMs: number,
	): Promise<void> {
		const res = await withTimeout(
			requestUrl({
				url: this.url(`/${hash}`),
				method: "PUT",
				headers: this.authHeaders(),
				body: data,
				contentType,
			}),
			timeoutMs,
			`blob upload ${hash.slice(0, 12)}…`,
		);
		if (res.status !== 204) {
			throw new Error(`blob upload failed: ${res.status} ${res.text}`);
		}
	}

	async download(hash: string, timeoutMs: number): Promise<ArrayBuffer> {
		const res = await withTimeout(
			requestUrl({
				url: this.url(`/${hash}`),
				method: "GET",
				headers: this.authHeaders(),
			}),
			timeoutMs,
			`blob download ${hash.slice(0, 12)}…`,
		);
		if (res.status !== 200) {
			throw new Error(`blob download failed: ${res.status} ${res.text}`);
		}
		return res.arrayBuffer;
	}

	async exists(hashes: string[]): Promise<string[]> {
		const res = await withTimeout(
			requestUrl({
				url: this.url("/exists"),
				method: "POST",
				contentType: "application/json",
				headers: this.authHeaders(),
				body: JSON.stringify({ hashes }),
			}),
			EXISTS_TIMEOUT_MS,
			`blob exists (${hashes.length})`,
		);
		if (res.status !== 200) {
			throw new Error(`exists failed: ${res.status} ${res.text}`);
		}
		return (res.json as ExistsResult).present;
	}
}

// -------------------------------------------------------------------
// Hashing
// -------------------------------------------------------------------

async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return arrayBufferToHex(hashBuffer);
}

/**
 * Guess MIME type from file extension.
 * Covers the common attachment types in Obsidian vaults.
 */
function guessMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const mimes: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		webp: "image/webp",
		bmp: "image/bmp",
		ico: "image/x-icon",
		pdf: "application/pdf",
		mp3: "audio/mpeg",
		wav: "audio/wav",
		ogg: "audio/ogg",
		mp4: "video/mp4",
		webm: "video/webm",
		mov: "video/quicktime",
		zip: "application/zip",
		json: "application/json",
		csv: "text/csv",
		txt: "text/plain",
		canvas: "application/json",
	};
	return mimes[ext] ?? "application/octet-stream";
}

function isAlreadyExistsError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (code === "EEXIST") return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return message.toLowerCase().includes("exists");
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}

const MAX_ACCEPTABLE_LOCAL_HASHES = MAX_BLOB_REF_PRIOR_HASHES;

function normalizeAcceptableLocalHashes(
	hashes: readonly string[] | undefined,
): string[] {
	if (!hashes || hashes.length === 0) return [];
	// A path that advances faster than the downloader for an unreasonable
	// number of refs is safer to quarantine than to retain an unbounded trust
	// set supplied through persisted/provider state.
	if (
		hashes.length > MAX_ACCEPTABLE_LOCAL_HASHES
		|| hashes.some((hash) => !isSha256Hex(hash))
	) return [];
	return Array.from(new Set(hashes));
}

// -------------------------------------------------------------------
// Queue item types
// -------------------------------------------------------------------

interface UploadItem {
	path: string;
	sizeBytes?: number;
	/** Whether expectedBaseRef (including explicit absence) is trustworthy. */
	baseRefKnown: boolean;
	/** Durable settled ref on which this local edit was based. */
	expectedBaseRef?: BlobRef;
	/** Exact CRDT item episode that owns expectedBaseRef. */
	expectedBaseSourceVersion?: string;
	/** Ref whose causal lineage the newly published content must inherit. */
	causalBaseRef?: BlobRef;
	retries: number;
	status: "pending" | "processing";
	readyAt: number;
	/** Per-path fence captured when this transfer was queued. */
	generation: number;
	/**
	 * Explicit dashboard resolution intent. Unlike an ordinary upload, this is
	 * allowed to pass the preserved-unresolved guard while the tombstone and
	 * marker remain in place. The intent is persisted with the queue so a
	 * restart cannot silently turn it into an ordinary guarded upload.
	 */
	attentionResolution?: BlobKeepLocalUploadResolution;
	needsRerun?: boolean;
	/** How many times this item has been reset via needsRerun. Capped at MAX_RERUN_RESETS. */
	rerunResets: number;
}

interface DownloadItem {
	path: string;
	hash: string;
	sizeBytes?: number;
	/** Exact target ref identity, including size and causal lineage. */
	targetRefFingerprint?: string;
	/**
	 * Exact content hashes that may safely be replaced by this remote target.
	 * These are derived only from the immediately preceding pathToBlob refs in
	 * one continuous observer lineage; an empty list keeps existing files
	 * fail-closed.
	 */
	acceptableLocalHashes?: string[];
	/** Latest target received while the current immutable attempt is running. */
	nextHash?: string;
	nextSizeBytes?: number;
	nextTargetRefFingerprint?: string;
	/** Clean local lineage carried by nextHash across an in-flight supersede. */
	nextAcceptableLocalHashes?: string[];
	retries: number;
	status: "pending" | "processing";
	readyAt: number;
	/** Per-path fence captured when this transfer was queued. */
	generation: number;
	needsRerun?: boolean;
	/** How many times this item has been reset via needsRerun. Capped at MAX_RERUN_RESETS. */
	rerunResets: number;
}

interface ExactBlobFileSnapshot {
	current: boolean;
	hash: string | null;
	data: ArrayBuffer | null;
	/** True only when the caller's synchronous commit callback accepted. */
	commitAccepted: boolean;
}

type ExactBlobFileCommit = (snapshot: {
	hash: string;
	data: ArrayBuffer;
}) => boolean;

export interface BlobKeepLocalUploadResolution {
	kind: "keep-local-remote-delete";
	expectedReason: RemoteDeletePreservedUnresolvedReason;
	/** Identifies the preserved-unresolved episode across queue persistence. */
	episodeId: string;
	/** Identifies the exact authoritative blob tombstone being resolved. */
	remoteDeleteFingerprint: string;
}

export interface BlobRemoteDeleteResolutionIdentity {
	episodeId?: string;
	remoteDeleteFingerprint?: string;
}

export type BlobSettledRefCache = Record<string, BlobRef>;

/** Exact Y.Map item episode paired with each durable disk/ref settlement. */
export type BlobSettledSourceVersionCache = Record<string, string>;

export type BlobSettlementStageKind =
	| "download"
	| "upload"
	| "equality"
	| "rename"
	| "retire";

/**
 * Durable pre-commit fence for a settlement establishment or retirement.
 *
 * A stage is written before the filesystem/CRDT linearization point.  On a
 * restart it takes precedence over an older settled ref and keeps the path in
 * Attention until exact disk/ref evidence can finalize it.
 */
interface BlobSettlementStageBase {
	stageId: string;
	sourceVersion?: string;
	stagedAt: number;
}

/**
 * A retirement fences the path itself, even when an upgraded legacy
 * tombstone cannot identify the deleted ref. Establishment stages always
 * carry the exact ref they intend to settle.
 */
export type BlobSettlementStage =
	| (BlobSettlementStageBase & {
		kind: "retire";
		ref?: BlobRef;
	})
	| (BlobSettlementStageBase & {
		kind: Exclude<BlobSettlementStageKind, "retire">;
		ref: BlobRef;
	});

export type BlobSettlementStageCache = Record<string, BlobSettlementStage>;

export interface BlobSettlementPersistence {
	stage(path: string, stage: BlobSettlementStage): Promise<void>;
	finalize(
		path: string,
		stageId: string,
		ref: BlobRef,
		sourceVersion: string,
	): Promise<void>;
	retire(path: string, stageId: string): Promise<void>;
	abort(path: string, stageId: string): Promise<void>;
}

export function moveSettledBlobRefs(
	cache: BlobSettledRefCache,
	renames: ReadonlyMap<string, string>,
): void {
	for (const [oldPath, newPath] of renames) {
		const ref = cloneBlobRef(cache[normalizePath(oldPath)]);
		delete cache[normalizePath(oldPath)];
		if (ref) cache[normalizePath(newPath)] = ref;
	}
}

/**
 * Serializable snapshot of pending queues.
 * Persisted to plugin data.json so in-flight transfers survive reloads.
 */
export interface BlobQueueSnapshot {
	uploads: {
		path: string;
		sizeBytes?: number;
		baseRefKnown?: boolean;
		expectedBaseRef?: BlobRef;
		causalBaseRef?: BlobRef;
		expectedBaseSourceVersion?: string;
		retries?: number;
		status?: "pending" | "processing";
		readyAt?: number;
		attentionResolution?: BlobKeepLocalUploadResolution;
		needsRerun?: boolean;
		rerunResets?: number;
	}[];
	downloads: {
		path: string;
		hash: string;
		sizeBytes?: number;
		targetRefFingerprint?: string;
		acceptableLocalHashes?: string[];
		retries?: number;
		status?: "pending" | "processing";
		readyAt?: number;
		needsRerun?: boolean;
		rerunResets?: number;
	}[];
}

// -------------------------------------------------------------------
// BlobSyncManager
// -------------------------------------------------------------------

export class BlobSyncManager {
	private blobClient: BlobHttpClient;

	/** Pending uploads keyed by path (deduped). */
	private uploadQueue = new Map<string, UploadItem>();
	/** Pending downloads keyed by path (deduped). */
	private downloadQueue = new Map<string, DownloadItem>();

	/** Debounce timers for upload scheduling (keyed by path). */
	private uploadDebounce = new Map<string, ReturnType<typeof setTimeout>>();

	/** Paths currently uploading. */
	private inflightUploads = new Set<string>();
	/** Paths currently downloading. */
	private inflightDownloads = new Set<string>();
	/** Promises that must settle before a manager replacement may start. */
	private activeTransferPromises = new Set<Promise<void>>();
	/** Read-only recovery checks for a download that settled just before crash. */
	private legacyMigrationVerificationPaths = new Set<string>();
	/** Observer-owned remote delete work must settle before operation tickets retire. */
	private activeRemoteDeletePromises = new Set<Promise<void>>();
	/** Tombstones observed before provider authority are reconsidered when the gate opens. */
	private deferredRemoteDeletePaths = new Set<string>();
	/** Retry timers for failed transfers. */
	private retryTimers = new Set<ReturnType<typeof setTimeout>>();
	/** True while upload drain is running. */
	private uploadDraining = false;
	/** True while download drain is running. */
	private downloadDraining = false;
	/** Blocks every upload until startup persistence/reconciliation is authoritative. */
	private uploadGateOpen = false;
	/** Blocks startup-time download execution until the local vault model is ready. */
	private downloadGateOpen = false;
	/** Authoritative disk inventory is unsafe until Obsidian workspace layout is ready. */
	private inventoryGateReady = true;

	/** One-shot path tokens that suppress only the next own Vault event. */
	private suppressedPaths = new Map<string, number>();

	/** Completed transfer counts (reset each reconcile cycle). */
	private _completedUploads = 0;
	private _completedDownloads = 0;
	/** Total transfers queued in the current batch (for N/M display). */
	private _totalUploadsThisCycle = 0;
	private _totalDownloadsThisCycle = 0;
	/** Permanent failure counters (never reset — lifetime of plugin session). */
	private _permanentUploadFailures = 0;
	private _permanentDownloadFailures = 0;
	/** Local-only conflict artifact counter (never reset — lifetime of plugin session). */
	private _blobConflictArtifacts = 0;
	private localOnlyBlobConflictPaths = new Set<string>();
	private remoteOverwriteRenameTickets = new Map<
		string,
		{ file: TFile; newPath: string; generation: number; kind: "backup" }
	>();
	/** Exact delete episode currently resolving per path. */
	private remoteDeleteInFlight = new Map<string, string>();
	/**
	 * Monotonic per-path fences. Accepting a remote delete advances the fence;
	 * queued/in-flight work must re-check its captured value immediately before
	 * publishing a blob ref or writing downloaded bytes.
	 */
	private transferGenerations = new Map<string, number>();
	/** Paths whose local delete callback is currently running. */
	private attentionAcceptInFlight = new Set<string>();
	/** Waiters used by Accept to let already-started disk writes settle first. */
	private transferSettleWaiters = new Map<string, Set<() => void>>();
	private destroyed = false;
	private remoteDeletePathsByTransaction = new WeakMap<
		import("yjs").Transaction,
		Set<string>
	>();

	/** CRDT map observer cleanup functions. */
	private observerCleanups: (() => void)[] = [];

	/**
	 * Paths where a remote-delete was received but no known hash baseline was
	 * available to verify local state. These files were preserved on disk but
	 * must NOT be auto-uploaded or have their tombstones cleared by later
	 * scan/upload/import passes.
	 *
	 * Cleared when the user explicitly modifies the file (non-suppressed vault
	 * event), deletes the file locally, or a future remote-delete arrives with
	 * a real baseline hash.
	 */
	private preservedUnresolved: PreservedUnresolvedRegistry;
	readonly preservedUnresolvedPaths: ReadonlySet<string>;

	private readonly maxConcurrency: number;
	private readonly maxSize: number;
	private readonly debug: boolean;

	/** External blob hash cache (owned by main.ts, persisted to data.json). */
	private hashCache: BlobHashCache;

	constructor(
		private app: App,
		private vaultSync: VaultSync,
		settings: {
			host: string;
			token: string;
			vaultId: string;
			maxAttachmentSizeKB: number;
			attachmentConcurrency: number;
			debug: boolean;
			trace?: TraceHttpContext;
		},
		hashCache: BlobHashCache,
		private trace?: TraceRecord,
		initialPreservedUnresolved: PreservedUnresolvedEntry[] = [],
		private onPreservedUnresolvedChanged?: () => void,
		private readonly isBlobPathSyncable: (path: string) => boolean = () => true,
		private readonly settledRefs: BlobSettledRefCache = {},
		private readonly onSettledRefsChanged?: (
			path?: string,
			ref?: BlobRef,
		) => void,
		private readonly settledSourceVersions: BlobSettledSourceVersionCache = {},
		private readonly settlementStages: BlobSettlementStageCache = {},
		private readonly settlementPersistence?: BlobSettlementPersistence,
	) {
		this.blobClient = new BlobHttpClient(
			settings.host,
			settings.token,
			settings.vaultId,
			settings.trace,
		);
		this.maxConcurrency = settings.attachmentConcurrency;
		this.maxSize = settings.maxAttachmentSizeKB * 1024;
		this.debug = settings.debug;
		this.hashCache = hashCache;
		const initialBlobEntries = initialPreservedUnresolved.filter(
			(entry) => entry.kind === "blob",
		);
		const retainedBlobEntries = initialBlobEntries.filter((entry) => {
			if (!isRemoteDeletePreservedUnresolvedEntry(entry)) return true;
			// A live ref proves the remote-delete episode ended. This also heals
			// a durable stale marker if Keep-local committed just before a crash.
			return !this.vaultSync.getBlobRef(entry.path)
				|| this.getAuthoritativeBlobDeleteFingerprint(entry.path) !== null;
		});
		this.preservedUnresolved = new PreservedUnresolvedRegistry(
			retainedBlobEntries,
		);
		this.preservedUnresolvedPaths = this.preservedUnresolved.paths;
		if (retainedBlobEntries.length !== initialBlobEntries.length) {
			queueMicrotask(() => this.onPreservedUnresolvedChanged?.());
		}
	}

	private getSettledRef(path: string): BlobRef | undefined {
		const normalized = normalizePath(path);
		if (this.settlementStages[normalized]) return undefined;
		return cloneBlobRef(this.settledRefs[normalized]);
	}

	private getSettledSourceVersion(path: string): string | undefined {
		return this.settledSourceVersions[normalizePath(path)];
	}

	private recordSettledRef(path: string, ref: BlobRef | undefined): void {
		const normalized = normalizePath(path);
		const cloned = cloneBlobRef(ref);
		const previous = this.settledRefs[normalized];
		const sourceVersion = cloned
			? this.vaultSync.getBlobSourceVersion?.(normalized)
			: undefined;
		const previousSourceVersion = this.settledSourceVersions[normalized];
		if (
			sameBlobRef(previous, cloned)
			&& previousSourceVersion === sourceVersion
		) return;
		if (cloned) {
			this.settledRefs[normalized] = cloned;
			if (sourceVersion) this.settledSourceVersions[normalized] = sourceVersion;
			else delete this.settledSourceVersions[normalized];
		} else {
			delete this.settledRefs[normalized];
			delete this.settledSourceVersions[normalized];
		}
		this.onSettledRefsChanged?.(normalized, cloned);
	}

	private async prepareSettlementStage(
		path: string,
		kind: BlobSettlementStageKind,
		ref: BlobRef | undefined,
		sourceVersionHint?: string | null,
	): Promise<BlobSettlementStage> {
		const normalized = normalizePath(path);
		const clonedRef = cloneBlobRef(ref);
		if (kind !== "retire" && !clonedRef) {
			throw new Error(`Attachment settlement ref is unavailable for "${normalized}"`);
		}
		const sourceVersion = sourceVersionHint === null
			? undefined
			: sourceVersionHint ?? this.vaultSync.getBlobSourceVersion?.(normalized);
		const current = this.settlementStages[normalized];
		if (
			current
			&& current.kind === kind
			&& sameBlobRef(current.ref, clonedRef)
			&& current.sourceVersion === sourceVersion
		) return {
			...current,
			...(current.ref ? { ref: cloneBlobRef(current.ref)! } : {}),
		} as BlobSettlementStage;
		if (current) {
			throw new Error(`Attachment settlement stage already exists for "${normalized}"`);
		}
		const stage = {
			stageId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
			kind,
			...(clonedRef ? { ref: clonedRef } : {}),
			...(sourceVersion !== undefined && { sourceVersion }),
			stagedAt: Date.now(),
		} as BlobSettlementStage;
		if (this.settlementPersistence) {
			await this.settlementPersistence.stage(normalized, stage);
		} else {
			this.settlementStages[normalized] = stage;
		}
		return stage;
	}

	private async finalizeSettlementStage(
		path: string,
		stage: BlobSettlementStage,
		ref: BlobRef,
		expectedSourceVersion?: string,
	): Promise<boolean> {
		const normalized = normalizePath(path);
		if (stage.kind === "retire") return false;
		if (!sameBlobRef(stage.ref, ref)) return false;
		if (this.settlementStages[normalized]?.stageId !== stage.stageId) return false;
		const currentRef = cloneBlobRef(this.vaultSync.getBlobRef?.(normalized));
		const sourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
		if (
			!sameBlobRef(currentRef, ref)
			|| !sourceVersion
			|| (stage.sourceVersion !== undefined
				&& stage.sourceVersion !== sourceVersion)
			|| (expectedSourceVersion !== undefined
				&& expectedSourceVersion !== sourceVersion)
		) return false;
		if (this.settlementPersistence) {
			await this.settlementPersistence.finalize(
				normalized,
				stage.stageId,
				ref,
				sourceVersion,
			);
		} else {
			if (this.settlementStages[normalized]?.stageId !== stage.stageId) return false;
			delete this.settlementStages[normalized];
			this.recordSettledRef(normalized, ref);
		}
		return true;
	}

	private async retireSettlementStage(
		path: string,
		stage: BlobSettlementStage,
	): Promise<boolean> {
		const normalized = normalizePath(path);
		if (
			stage.kind !== "retire"
			|| this.settlementStages[normalized]?.stageId !== stage.stageId
		) return false;
		if (this.settlementPersistence) {
			await this.settlementPersistence.retire(normalized, stage.stageId);
		} else {
			if (this.settlementStages[normalized]?.stageId !== stage.stageId) return false;
			this.recordSettledRef(normalized, undefined);
		}
		return true;
	}

	private async abortSettlementStage(
		path: string,
		stage: BlobSettlementStage | undefined,
	): Promise<void> {
		if (!stage) return;
		const normalized = normalizePath(path);
		if (this.settlementPersistence) {
			await this.settlementPersistence.abort(normalized, stage.stageId);
		} else if (this.settlementStages[normalized]?.stageId === stage.stageId) {
			delete this.settlementStages[normalized];
		}
	}

	// -------------------------------------------------------------------
	// CRDT observers (remote changes → download queue)
	// -------------------------------------------------------------------

	/**
	 * Start observing pathToBlob and blobTombstones for remote changes.
	 * Remote blob additions → schedule download.
	 * Remote tombstones → delete from disk.
	 */
	startObservers(): void {
		// pathToBlob observer: remote add/update → download if missing
		const blobObserver = (event: import("yjs").YMapEvent<BlobRef>) => {
			event.changes.keys.forEach((change, path) => {
				if (change.action === "add" || change.action === "update") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					if (!this.isBlobPathSyncable(path)) {
						this.dropExcludedQueuedDownload(path, "observer");
						return;
					}
					const ref = this.vaultSync.pathToBlob.get(path);
					if (!ref) return;
					const unresolved = this.preservedUnresolved.get(path);
					if (
						unresolved
						&& isRemoteDeletePreservedUnresolvedEntry(unresolved)
						&& this.preservedUnresolved.resolve(path)
					) {
						this.onPreservedUnresolvedChanged?.();
					}
					const acceptableLocalHashes = change.action !== "update"
						? []
						: event.transaction.origin === ORIGIN_RESTORE
							? getBlobRefPriorHashes(ref)
							: event.transaction.origin === this.vaultSync.provider
								? getBlobRefPriorHashes(ref)
								: [];
					this.log(
						`observer: remote blob ref for "${path}" hash=${ref.hash.slice(0, 12)}…`,
					);
					this.scheduleDownload(
						path,
						ref.hash,
						ref.size,
						acceptableLocalHashes,
					);
				}
				if (change.action === "delete") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					// A receiver's Y.Map oldValue is its own local branch, not the ref
					// observed by the deleting device. Only tombstone.deletedRef may
					// authorize destructive delete settlement.
					let transactionPaths =
						this.remoteDeletePathsByTransaction.get(event.transaction);
					if (!transactionPaths) {
						transactionPaths = new Set();
						this.remoteDeletePathsByTransaction.set(
							event.transaction,
							transactionPaths,
						);
					}
					transactionPaths.add(path);
					this.scheduleRemoteDelete(path);
				}
			});
		};
		this.vaultSync.pathToBlob.observe(blobObserver);
		this.observerCleanups.push(() =>
			this.vaultSync.pathToBlob.unobserve(blobObserver),
		);

		// blobTombstones observer: remote tombstone → delete from disk
		const tombObserver = (
			event: import("yjs").YMapEvent<import("../types").BlobTombstone>,
		) => {
			event.changes.keys.forEach((change, path) => {
				if (change.action === "add" || change.action === "update") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					const transactionPaths =
						this.remoteDeletePathsByTransaction.get(event.transaction);
					if (transactionPaths?.has(path)) return;
					this.scheduleRemoteDelete(path);
				}
			});
		};
		this.vaultSync.blobTombstones.observe(tombObserver);
		this.observerCleanups.push(() =>
			this.vaultSync.blobTombstones.unobserve(tombObserver),
		);

		this.log("Blob observers started");
	}

	private captureUploadBase(
		path: string,
		explicitKeepLocal: boolean,
	): {
		known: boolean;
		ref: BlobRef | undefined;
		causalBaseRef: BlobRef | undefined;
		sourceVersion: string | undefined;
	} {
		const normalized = normalizePath(path);
		const currentRef = cloneBlobRef(this.vaultSync.getBlobRef?.(normalized));
		if (explicitKeepLocal) {
			const deleteState = this.getAuthoritativeBlobDeleteState(normalized);
			return deleteState
				? {
					known: true,
						ref: currentRef,
						causalBaseRef: cloneBlobRef(deleteState.deletedRef),
						sourceVersion: undefined,
					}
					: { known: false, ref: undefined, causalBaseRef: undefined, sourceVersion: undefined };
		}
		if (this.vaultSync.isBlobTombstoned?.(normalized)) {
			return { known: false, ref: undefined, causalBaseRef: undefined, sourceVersion: undefined };
		}
		const settledRef = this.getSettledRef(normalized);
		const settledSourceVersion = this.getSettledSourceVersion(normalized);
		const currentSourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
		if (currentRef) {
			return sameBlobRef(currentRef, settledRef)
				&& !!settledSourceVersion
				&& settledSourceVersion === currentSourceVersion
				? {
					known: true,
					ref: currentRef,
					causalBaseRef: currentRef,
					sourceVersion: settledSourceVersion,
				}
				: { known: false, ref: undefined, causalBaseRef: undefined, sourceVersion: undefined };
		}
		return settledRef
			? { known: false, ref: undefined, causalBaseRef: undefined, sourceVersion: undefined }
			: { known: true, ref: undefined, causalBaseRef: undefined, sourceVersion: undefined };
	}

	private enqueueUpload(
		path: string,
		retries = 0,
		sizeBytes?: number,
		attentionResolution?: BlobKeepLocalUploadResolution,
	): void {
		if (!this.isBlobPathSyncable(path)) return;
		const normalized = normalizePath(path);
		const existing = this.uploadQueue.get(path);
		const activeStage = this.settlementStages[normalized];
		if (activeStage) {
			// A local edit observed after this exact upload's synchronous CRDT
			// commit must survive as a fail-closed rerun. It cannot recapture a
			// base while the pre-commit stage masks settlement authority.
			if (
				activeStage.kind === "upload"
				&& existing?.status === "processing"
			) {
				existing.needsRerun = true;
				if (sizeBytes && sizeBytes > 0) existing.sizeBytes = sizeBytes;
			}
			return;
		}
		if (this.attentionAcceptInFlight?.has(normalized)) return;
		const generation = this.currentTransferGeneration(path);
		const uploadBase = this.captureUploadBase(path, !!attentionResolution);
		if (existing) {
			existing.baseRefKnown = uploadBase.known;
			existing.expectedBaseRef = cloneBlobRef(uploadBase.ref);
			existing.causalBaseRef = cloneBlobRef(uploadBase.causalBaseRef);
			existing.expectedBaseSourceVersion = uploadBase.sourceVersion;
			if (sizeBytes && sizeBytes > 0) existing.sizeBytes = sizeBytes;
			existing.retries = Math.min(existing.retries, retries);
			existing.readyAt = 0;
			existing.generation = generation;
			if (attentionResolution) {
				existing.attentionResolution = attentionResolution;
			}
			if (existing.status === "processing") {
				existing.needsRerun = true;
			} else {
				existing.status = "pending";
			}
			return;
		}

		this.uploadQueue.set(path, {
			path,
			sizeBytes,
			baseRefKnown: uploadBase.known,
			expectedBaseRef: cloneBlobRef(uploadBase.ref),
			causalBaseRef: cloneBlobRef(uploadBase.causalBaseRef),
			expectedBaseSourceVersion: uploadBase.sourceVersion,
			retries,
			status: "pending",
			readyAt: 0,
			generation,
			attentionResolution,
			rerunResets: 0,
		});
	}

	private enqueueDownload(
		path: string,
		hash: string,
		sizeBytes?: number,
		retries = 0,
		acceptableLocalHashes: readonly string[] = [],
	): void {
		if (!this.isBlobPathSyncable(path)) return;
		const normalized = normalizePath(path);
		if (this.attentionAcceptInFlight?.has(normalized)) return;
		if (
			this.preservedUnresolved.get(normalized)?.reason
			=== LEGACY_MISSING_BLOB_ATTENTION_REASON
		) return;
		const generation = this.currentTransferGeneration(path);
		const authoritativeTarget = this.getAuthoritativeDownloadRef(path);
		const targetRefFingerprint = authoritativeTarget.ref?.hash === hash
			? blobRefFingerprint(authoritativeTarget.ref)
			: undefined;
		const existing = this.downloadQueue.get(path);
		const normalizedAcceptableLocalHashes = normalizeAcceptableLocalHashes(
			acceptableLocalHashes,
		);
		if (existing) {
			if (existing.status === "processing") {
				// Do not mutate the hash that processDownload is verifying across
				// awaits. Store the newer target for a distinct rerun attempt.
				existing.nextHash = hash;
				existing.nextSizeBytes = sizeBytes;
				existing.nextTargetRefFingerprint = targetRefFingerprint;
				existing.nextAcceptableLocalHashes = normalizedAcceptableLocalHashes;
				existing.needsRerun = true;
			} else {
				existing.hash = hash;
				existing.targetRefFingerprint = targetRefFingerprint;
				existing.acceptableLocalHashes = normalizedAcceptableLocalHashes;
				if (sizeBytes && sizeBytes > 0) existing.sizeBytes = sizeBytes;
				existing.retries = Math.min(existing.retries, retries);
				existing.readyAt = 0;
				existing.generation = generation;
				existing.status = "pending";
			}
			return;
		}

		this.downloadQueue.set(path, {
			path,
			hash,
			sizeBytes,
			targetRefFingerprint,
			acceptableLocalHashes: normalizedAcceptableLocalHashes,
			retries,
			status: "pending",
			readyAt: 0,
			generation,
			rerunResets: 0,
		});
	}

	private currentTransferGeneration(path: string): number {
		return this.transferGenerations?.get(normalizePath(path)) ?? 0;
	}

	private isTransferCurrent(path: string, generation: number): boolean {
		const normalized = normalizePath(path);
		return !this.destroyed
			&& !this.attentionAcceptInFlight?.has(normalized)
			&& this.currentTransferGeneration(normalized) === generation;
	}

	private discardUploadItem(item: UploadItem): void {
		if (this.uploadQueue.get(item.path) === item) {
			this.uploadQueue.delete(item.path);
		}
	}

	private discardDownloadItem(item: DownloadItem): void {
		if (this.downloadQueue.get(item.path) === item) {
			this.downloadQueue.delete(item.path);
		}
	}

	/**
	 * Advance the path fence and remove all queued/debounced work. Network
	 * requests already in progress cannot always be aborted by Obsidian's HTTP
	 * API, so their commit/write sites are fenced by the returned generation.
	 */
	private fenceTransfersForPath(path: string, reason: string): number {
		const normalized = normalizePath(path);
		const generation = this.currentTransferGeneration(normalized) + 1;
		if (!this.transferGenerations) {
			this.transferGenerations = new Map<string, number>();
		}
		this.transferGenerations.set(normalized, generation);

		if (this.uploadDebounce) {
			for (const [queuedPath, timer] of this.uploadDebounce) {
				if (normalizePath(queuedPath) !== normalized) continue;
				clearTimeout(timer);
				this.uploadDebounce.delete(queuedPath);
			}
		}
		if (this.uploadQueue) {
			for (const queuedPath of this.uploadQueue.keys()) {
				if (normalizePath(queuedPath) === normalized) {
					this.uploadQueue.delete(queuedPath);
				}
			}
		}
		if (this.downloadQueue) {
			for (const queuedPath of this.downloadQueue.keys()) {
				if (normalizePath(queuedPath) === normalized) {
					this.downloadQueue.delete(queuedPath);
				}
			}
		}

		this.trace?.("blob", "transfer-path-fenced", {
			path: normalized,
			generation,
			reason,
		});
		return generation;
	}

	/**
	 * Immediately retire transfer work captured before a local delete/rename
	 * intent. This performs no CRDT mutation and deliberately preserves the
	 * settled ref, which remains the causal CAS base for the intent replay.
	 */
	fenceLocalMutationIntent(path: string, reason: string): number {
		const normalized = normalizePath(path);
		const generation = this.fenceTransfersForPath(
			normalized,
			`local-intent:${reason}`,
		);
		this.suppressedPaths.delete(normalized);
		removeCachedHash(this.hashCache, normalized);
		return generation;
	}

	private hasInFlightTransferForPath(path: string): boolean {
		const normalized = normalizePath(path);
		return Array.from(this.inflightUploads ?? []).some(
			(candidate) => normalizePath(candidate) === normalized,
		) || Array.from(this.inflightDownloads ?? []).some(
			(candidate) => normalizePath(candidate) === normalized,
		);
	}

	private async waitForTransfersToSettle(path: string): Promise<void> {
		const normalized = normalizePath(path);
		while (this.hasInFlightTransferForPath(normalized)) {
			await new Promise<void>((resolve) => {
				let waiters = this.transferSettleWaiters.get(normalized);
				if (!waiters) {
					waiters = new Set();
					this.transferSettleWaiters.set(normalized, waiters);
				}
				waiters.add(resolve);
				// Avoid a lost wake-up if a transfer settled between the loop check
				// and waiter registration.
				if (!this.hasInFlightTransferForPath(normalized)) {
					waiters.delete(resolve);
					if (waiters.size === 0) {
						this.transferSettleWaiters.delete(normalized);
					}
					resolve();
				}
			});
		}
	}

	private notifyTransferSettled(path: string): void {
		const normalized = normalizePath(path);
		const waiters = this.transferSettleWaiters.get(normalized);
		if (!waiters) return;
		this.transferSettleWaiters.delete(normalized);
		for (const resolve of waiters) resolve();
	}

	// -------------------------------------------------------------------
	// Public event handlers (called from main.ts vault events)
	// -------------------------------------------------------------------

	/** Consume only the exact operation-owned H1 -> local-backup rename. */
	consumeRemoteOverwriteBackupRename(file: TFile, oldPath: string): boolean {
		const normalizedOldPath = normalizePath(oldPath);
		const ticket = this.remoteOverwriteRenameTickets.get(normalizedOldPath);
		if (!ticket) return false;
		if (
			ticket.file !== file
			|| normalizePath(file.path) !== ticket.newPath
			|| this.app.vault.getAbstractFileByPath(ticket.newPath) !== file
		) return false;
		this.remoteOverwriteRenameTickets.delete(normalizedOldPath);
		this.trace?.("blob", "remote-overwrite-backup-rename-consumed", {
			path: normalizedOldPath,
			newPath: ticket.newPath,
			generation: ticket.generation,
			kind: ticket.kind,
		});
		return true;
	}

	/**
	 * Handle a local file create/modify for a blob-syncable file.
	 * Debounces and queues upload.
	 */
	handleFileChange(file: TFile): void {
		if (!this.isBlobPathSyncable(file.path)) return;
		if (this.attentionAcceptInFlight.has(normalizePath(file.path))) return;
		if (
			this.localOnlyBlobConflictPaths.has(file.path) ||
			isBlobConflictArtifactPath(normalizePath(file.path))
		) {
			this.log(`handleFileChange: local-only blob conflict "${file.path}"`);
			return;
		}

		if (this.isSuppressed(file.path)) {
			this.log(`handleFileChange: suppressed "${file.path}"`);
			return;
		}

		// If the user explicitly modifies a preserved-unresolved file, that
		// constitutes intentional user action. Clear the guard and allow upload.
		// An already queued dashboard Keep-local resolution is the exception: its
		// marker must remain durable until the two-phase upload commit succeeds.
		const unresolvedEntry = this.preservedUnresolved.get(file.path);
		const queuedResolution = this.uploadQueue.get(file.path)
			?.attentionResolution;
		if (
			unresolvedEntry
			&& isRemoteDeletePreservedUnresolvedEntry(unresolvedEntry)
			&& queuedResolution?.kind !== "keep-local-remote-delete"
		) {
			this.trace?.("blob", "remote-delete-attention-retained", {
				path: file.path,
				reason: unresolvedEntry.reason,
			});
			this.log(
				`handleFileChange: retained remote-delete Attention for "${file.path}"`,
			);
			return;
		}
		if (
			this.preservedUnresolvedPaths.has(file.path)
			&& queuedResolution?.kind !== "keep-local-remote-delete"
		) {
			if (this.preservedUnresolved.resolve(file.path)) {
				this.onPreservedUnresolvedChanged?.();
			}
			this.trace?.("blob", "preserved-unresolved-cleared", {
				path: file.path,
				reason: "user-modify-event",
			});
			this.log(
				`handleFileChange: cleared preserved-unresolved for "${file.path}" (user modify)`,
			);
		}

		// Clear existing debounce
		const existing = this.uploadDebounce.get(file.path);
		if (existing) clearTimeout(existing);

		this.uploadDebounce.set(
			file.path,
			setTimeout(() => {
				this.uploadDebounce.delete(file.path);
				this.enqueueUpload(file.path, 0, file.stat.size);
				this.kickUploadDrain();
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * Admit a live same-path replacement observed while committing an older
	 * delete event. The suppression token belongs to the deleted TFile epoch;
	 * carrying it across the path ABA would silently discard the new winner.
	 */
	admitReplacementAfterStaleDelete(file: TFile): void {
		const normalized = normalizePath(file.path);
		if (!this.isBlobPathSyncable(normalized)) return;
		if (this.app.vault.getAbstractFileByPath(normalized) !== file) {
			this.trace?.("blob", "stale-delete-replacement-admission-skipped", {
				path: normalized,
				reason: "replacement-no-longer-current",
			});
			return;
		}

		// Cancel work captured for the deleted epoch, retire its loop-suppression
		// token, and invalidate any same-stat hash cached for that old identity.
		const generation = this.fenceTransfersForPath(
			normalized,
			"stale-delete-same-path-replacement",
		);
		const retiredSuppression = this.suppressedPaths.delete(normalized);
		removeCachedHash(this.hashCache, normalized);
		this.trace?.("blob", "stale-delete-replacement-admitted", {
			path: normalized,
			generation,
			retiredSuppression,
		});

		// handleFileChange retains the normal debounce and Attention-resolution
		// semantics, now against the replacement epoch and its fresh generation.
		this.handleFileChange(file);
	}

	/**
	 * Handle a local file delete for a blob-syncable file.
	 */
	handleFileDelete(
		path: string,
		device?: string,
		base?: PendingBlobMutationBase,
	): BlobDeleteCommitResult {
		const normalized = normalizePath(path);
		const acceptingAttentionDelete =
			this.attentionAcceptInFlight.has(normalized);
		if (!acceptingAttentionDelete) {
			this.fenceTransfersForPath(normalized, "local-file-delete");
		}
		// Cancel any pending upload
		const pendingUpload = this.uploadDebounce.get(normalized);
		if (pendingUpload) {
			clearTimeout(pendingUpload);
		}
		this.uploadDebounce.delete(normalized);
		this.uploadQueue.delete(normalized);

		if (acceptingAttentionDelete) {
			// The remote tombstone already owns CRDT authority. In particular, do
			// not tombstone a concurrent remote revival observed while trashFile()
			// is dispatching its local delete event.
			removeCachedHash(this.hashCache, normalized);
			this.recordSettledRef(normalized, undefined);
			return { kind: "already-absent" };
		}

		const settledRef = this.getSettledRef(normalized);
		const currentRef = cloneBlobRef(this.vaultSync.getBlobRef?.(normalized));
		const currentSourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
		const settledSourceVersion = this.getSettledSourceVersion(normalized);
		const mutationBase: PendingBlobMutationBase = base ?? (settledRef
			? {
				known: true,
				ref: settledRef,
				sourceVersionKnown: sameBlobRef(currentRef, settledRef)
					&& settledSourceVersion !== undefined
					&& currentSourceVersion === settledSourceVersion,
				expectedSourceVersion: sameBlobRef(currentRef, settledRef)
					&& currentSourceVersion === settledSourceVersion
					? settledSourceVersion
					: undefined,
			}
			: currentRef === undefined && !this.vaultSync.isBlobTombstoned?.(normalized)
				? { known: true, ref: undefined, sourceVersionKnown: true }
				: { known: false, ref: undefined, sourceVersionKnown: false });
		const result = this.vaultSync.deleteBlobRefIfCurrent(
			normalized,
			mutationBase,
			device,
		);
		if (result.kind === "unknown-source" || result.kind === "source-conflict") {
			removeCachedHash(this.hashCache, normalized);
			this.recordPreservedUnresolved(
				normalized,
				"local-blob-mutation-remote-conflict",
			);
			this.trace?.("blob", "local-blob-delete-causal-conflict", {
				path: normalized,
				result: result.kind,
				expectedHashPrefix: mutationBase.ref ? hashPrefix(mutationBase.ref.hash) : null,
				currentHashPrefix: result.currentRef ? hashPrefix(result.currentRef.hash) : null,
			});
			if (result.kind === "source-conflict" && result.mutationApplied === true) {
				// Our delete linearized before a synchronous observer revived the
				// source. The old disk settlement is no longer valid, but the intent
				// must stay fenced as an ambiguous committed episode.
				this.recordSettledRef(normalized, undefined);
			}
			return result;
		}

		if (this.preservedUnresolved.resolve(normalized)) {
			this.onPreservedUnresolvedChanged?.();
		}
		removeCachedHash(this.hashCache, normalized);
		this.recordSettledRef(normalized, undefined);
		return result;
	}

	/**
	 * Commit a local blob rename as an old-path tombstone plus a guarded new
	 * path ref. This makes the rename self-contained for offline receivers and
	 * fences all stale transfer work before either CRDT key changes.
	 */
	handleFileRename(
		oldPath: string,
		file: TFile,
		device?: string,
		base?: PendingBlobMutationBase,
	): CausalBlobRenameResult {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(file.path);
		this.fenceTransfersForPath(oldNormalized, "local-blob-rename-source");
		if (newNormalized !== oldNormalized) {
			this.fenceTransfersForPath(newNormalized, "local-blob-rename-target");
		}
		this.suppressedPaths.delete(oldNormalized);
		this.suppressedPaths.delete(newNormalized);

		const settledRef = this.getSettledRef(oldNormalized);
		const currentRef = cloneBlobRef(this.vaultSync.getBlobRef?.(oldNormalized));
		const currentSourceVersion = this.vaultSync.getBlobSourceVersion?.(oldNormalized);
		const settledSourceVersion = this.getSettledSourceVersion(oldNormalized);
		const mutationBase: PendingBlobMutationBase = base ?? (settledRef
			? {
				known: true,
				ref: settledRef,
				sourceVersionKnown: sameBlobRef(currentRef, settledRef)
					&& settledSourceVersion !== undefined
					&& currentSourceVersion === settledSourceVersion,
				expectedSourceVersion: sameBlobRef(currentRef, settledRef)
					&& currentSourceVersion === settledSourceVersion
					? settledSourceVersion
					: undefined,
			}
			: currentRef === undefined && !this.vaultSync.isBlobTombstoned?.(oldNormalized)
				? { known: true, ref: undefined, sourceVersionKnown: true }
				: { known: false, ref: undefined, sourceVersionKnown: false });
		const result = this.vaultSync.renameBlobRefWithTombstoneIfCurrent(
			oldNormalized,
			newNormalized,
			mutationBase,
			device,
		);
		if (result.kind === "unknown-source" || result.kind === "source-conflict") {
			removeCachedHash(this.hashCache, oldNormalized);
			removeCachedHash(this.hashCache, newNormalized);
			this.recordPreservedUnresolved(
				oldNormalized,
				"local-blob-mutation-remote-conflict",
			);
			this.recordPreservedUnresolved(
				newNormalized,
				"local-blob-mutation-remote-conflict",
			);
			this.trace?.("blob", "local-blob-rename-causal-conflict", {
				oldPath: oldNormalized,
				newPath: newNormalized,
				result: result.kind,
				expectedHashPrefix: mutationBase.ref ? hashPrefix(mutationBase.ref.hash) : null,
				currentHashPrefix: result.currentRef ? hashPrefix(result.currentRef.hash) : null,
			});
			if (result.kind === "source-conflict" && result.mutationApplied === true) {
				this.recordSettledRef(oldNormalized, undefined);
			}
			return result;
		}

		const attentionMove = this.preservedUnresolved.move(
			oldNormalized,
			newNormalized,
		);
		if (attentionMove.kind === "moved") {
			this.onPreservedUnresolvedChanged?.();
		}

		if (result.kind === "same-path") {
			removeCachedHash(this.hashCache, newNormalized);
			if (attentionMove.kind === "missing") this.handleFileChange(file);
			return result;
		}
		if (result.kind === "missing-source" || result.kind === "already-absent") {
			removeCachedHash(this.hashCache, oldNormalized);
			this.recordSettledRef(oldNormalized, undefined);
			if (attentionMove.kind === "missing") this.handleFileChange(file);
			return result;
		}
		if (result.kind === "destination-conflict") {
			removeCachedHash(this.hashCache, oldNormalized);
			this.recordSettledRef(oldNormalized, undefined);
			if (!this.preservedUnresolved.get(oldNormalized)) {
				this.recordPreservedUnresolved(oldNormalized, "path-collision");
			}
			if (!this.preservedUnresolved.get(newNormalized)) {
				this.recordPreservedUnresolved(newNormalized, "path-collision");
			}
			this.trace?.("blob", "local-blob-rename-destination-conflict", {
				oldPath: oldNormalized,
				newPath: newNormalized,
				sourceHashPrefix: hashPrefix(result.sourceRef.hash),
				destinationHashPrefix: hashPrefix(result.destinationRef.hash),
			});
			return result;
		}

		const rename = new Map([[oldNormalized, newNormalized]]);
		moveCachedHashes(this.hashCache, rename);
		moveSettledBlobRefs(this.settledRefs, rename);
		delete this.settledSourceVersions[oldNormalized];
		const destinationSourceVersion = this.vaultSync.getBlobSourceVersion?.(newNormalized);
		if (destinationSourceVersion && this.settledRefs[newNormalized]) {
			this.settledSourceVersions[newNormalized] = destinationSourceVersion;
		} else {
			delete this.settledSourceVersions[newNormalized];
		}
		this.onSettledRefsChanged?.();
		this.trace?.("blob", "local-blob-rename-committed", {
			oldPath: oldNormalized,
			newPath: newNormalized,
			hashPrefix: hashPrefix(result.ref.hash),
		});
		// A rename may coincide with an external byte edit. Re-admit the exact
		// destination against the moved settled ref unless an Attention episode
		// moved with it or collided there.
		if (attentionMove.kind === "missing") this.handleFileChange(file);
		return result;
	}

	/**
	 * Returns true if this path was preserved during a remote-delete because
	 * no hash baseline was available to verify local state.
	 */
	isPreservedUnresolved(path: string): boolean {
		return this.preservedUnresolvedPaths.has(path);
	}

	/**
	 * Clear the preserved-unresolved marker for a path.
	 * Called when a future remote-delete arrives with a real baseline hash.
	 */
	clearPreservedUnresolved(path: string): void {
		if (this.preservedUnresolved.resolve(path)) {
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("blob", "preserved-unresolved-cleared", {
				path,
				reason: "baseline-now-available",
			});
		}
	}

	/**
	 * Resume a quarantined first-upgrade download while retaining the durable
	 * device-local marker until an exact disk/ref settlement succeeds. The live
	 * ref, Attention episode, and local vacancy are checked again here so a stale
	 * Dashboard confirmation cannot admit a different remote generation.
	 */
	acceptLegacyMissingRemoteBlob(
		path: string,
		episodeId: string,
		expectedRemoteRef: BlobRef,
	): void {
		const normalized = normalizePath(path);
		const entry = this.preservedUnresolved.get(normalized);
		if (
			!entry
			|| entry.kind !== "blob"
			|| entry.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON
			|| getPreservedUnresolvedEpisodeId(entry) !== episodeId
		) {
			throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
		}
		if (!this.isBlobPathSyncable(normalized)) {
			throw new Error(`Attachment is no longer in sync scope: ${normalized}`);
		}
		if (this.app.vault.getAbstractFileByPath(normalized) !== null) {
			throw new Error(`Local attachment path is no longer absent: ${normalized}`);
		}
		const remoteRef = this.vaultSync.getBlobRef(normalized);
		if (
			!remoteRef
			|| this.vaultSync.isBlobTombstoned(normalized)
			|| !sameBlobRef(remoteRef, expectedRemoteRef)
		) {
			throw new Error(`Remote attachment changed for "${normalized}". Refresh the dashboard.`);
		}

		this.fenceTransfersForPath(normalized, "legacy-upgrade-accept-remote");
		if (!this.preservedUnresolved.resolve(normalized)) {
			throw new Error(`Attention entry is no longer active for "${normalized}".`);
		}
		this.onPreservedUnresolvedChanged?.();
		if (!this.scheduleDownload(
			normalized,
			remoteRef.hash,
			remoteRef.size,
			getBlobRefPriorHashes(remoteRef),
		)) {
			// The preconditions above make this unexpected. Restore the exact
			// episode before surfacing failure so no automatic reconcile can pass.
			this.preservedUnresolved.record({
				path: normalized,
				kind: "blob",
				reason: LEGACY_MISSING_BLOB_ATTENTION_REASON,
				episodeId,
				at: entry.lastSeenAt,
				localHash: entry.localHash,
				knownRemoteHash: entry.knownRemoteHash,
			});
			this.onPreservedUnresolvedChanged?.();
			throw new Error(`Remote attachment could not be queued: ${normalized}`);
		}
		this.trace?.("blob", "legacy-upgrade-remote-download-accepted", {
			path: normalized,
			remoteHashPrefix: hashPrefix(remoteRef.hash),
		});
	}

	private verifyLegacyMigrationPresentFile(
		path: string,
		file: TFile,
		expectedRemoteRef: BlobRef,
	): void {
		const normalized = normalizePath(path);
		if (this.legacyMigrationVerificationPaths.has(normalized)) return;
		const expectedMtime = file.stat.mtime;
		const expectedSize = file.stat.size;
		const generation = this.currentTransferGeneration(normalized);
		this.legacyMigrationVerificationPaths.add(normalized);

		const verification = (async () => {
			try {
				const data = await this.app.vault.readBinary(file);
				const hash = await hashArrayBuffer(data);
				const currentFile = this.app.vault.getAbstractFileByPath(normalized);
				const currentRef = this.vaultSync.getBlobRef(normalized);
				const entry = this.preservedUnresolved.get(normalized);
				if (
					this.destroyed
					|| this.currentTransferGeneration(normalized) !== generation
					|| currentFile !== file
					|| file.stat.mtime !== expectedMtime
					|| file.stat.size !== expectedSize
					|| data.byteLength !== expectedSize
					|| entry?.reason !== LEGACY_MISSING_BLOB_ATTENTION_REASON
					|| this.vaultSync.isBlobTombstoned(normalized)
					|| !sameBlobRef(currentRef, expectedRemoteRef)
				) return;
				if (
					hash !== expectedRemoteRef.hash
					|| data.byteLength !== expectedRemoteRef.size
				) {
					this.trace?.("blob", "legacy-upgrade-present-file-remains-quarantined", {
						path: normalized,
						localHashPrefix: hashPrefix(hash),
						remoteHashPrefix: hashPrefix(expectedRemoteRef.hash),
					});
					return;
				}
				const sourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
				if (!sourceVersion) return;
				const existingStage = this.settlementStages[normalized];
				if (existingStage?.kind === "retire") return;
				// A pre-commit upload stage intentionally has no source version.
				// After a crash it cannot be auto-finalized against a byte-identical
				// episode that may have been created by somebody else.
				if (
					existingStage
					&& existingStage.sourceVersion !== sourceVersion
				) return;
				const stage = existingStage
					&& sameBlobRef(existingStage.ref, expectedRemoteRef)
					? { ...existingStage, ref: cloneBlobRef(existingStage.ref)! }
					: await this.prepareSettlementStage(
						normalized,
						"equality",
						expectedRemoteRef,
						sourceVersion,
					);
				const finalSnapshot = await this.readAndHashExactExistingFile(
					file,
					normalized,
					{ mtime: expectedMtime, size: expectedSize },
				);
				if (
					!finalSnapshot.current
					|| finalSnapshot.hash !== expectedRemoteRef.hash
					|| !sameBlobRef(this.vaultSync.getBlobRef(normalized), expectedRemoteRef)
					|| this.vaultSync.getBlobSourceVersion?.(normalized) !== sourceVersion
					|| !await this.finalizeSettlementStage(
						normalized,
						stage,
						expectedRemoteRef,
						sourceVersion,
					)
				) return;
				if (this.preservedUnresolved.resolve(normalized)) {
					this.onPreservedUnresolvedChanged?.();
				}
				this.trace?.("blob", "legacy-upgrade-present-file-settled", {
					path: normalized,
					remoteHashPrefix: hashPrefix(expectedRemoteRef.hash),
				});
			} catch (err) {
				this.trace?.("blob", "legacy-upgrade-present-file-verify-failed", {
					path: normalized,
					error: String(err),
				});
			} finally {
				this.legacyMigrationVerificationPaths.delete(normalized);
			}
		})();
		this.activeTransferPromises.add(verification);
		void verification.then(() => {
			this.activeTransferPromises.delete(verification);
		});
	}

	recordPreservedUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		const normalized = normalizePath(path);
		this.fenceTransfersForPath(normalized, `preserved-unresolved:${reason}`);
		this.preservedUnresolved.record({
			path: normalized,
			kind: "blob",
			reason,
		});
		this.onPreservedUnresolvedChanged?.();
		this.trace?.("blob", "preserved-unresolved-recorded", {
			path: normalized,
			reason,
		});
	}

	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		return this.preservedUnresolved.getEntries();
	}

	isKeepLocalRemoteDeletePending(path: string, episodeId: string): boolean {
		const normalized = normalizePath(path);
		for (const item of this.uploadQueue.values()) {
			if (normalizePath(item.path) !== normalized) continue;
			const resolution = item.attentionResolution;
			return resolution?.kind === "keep-local-remote-delete"
				&& resolution.episodeId === episodeId;
		}
		return false;
	}

	private getAuthoritativeBlobDeleteState(
		path: string,
	): { fingerprint: string; deletedRef: BlobRef | undefined } | null {
		const normalized = normalizePath(path);
		const snapshotGetter = (
			this.vaultSync as unknown as {
				getAuthoritativeBlobDeleteSnapshot?: (
					candidate: string,
				) => { fingerprint: string; deletedRef?: BlobRef } | null;
			}
		).getAuthoritativeBlobDeleteSnapshot;
		if (typeof snapshotGetter === "function") {
			const snapshot = snapshotGetter.call(this.vaultSync, normalized);
			return snapshot
				? {
					fingerprint: snapshot.fingerprint,
					deletedRef: cloneBlobRef(snapshot.deletedRef),
				}
				: null;
		}

		// Backward-compatible fallback for focused tests and older VaultSync
		// doubles. Production VaultSync always uses the authoritative snapshot,
		// where a live ref wins over a stale tombstone.
		const tombstoned = typeof this.vaultSync.isBlobTombstoned === "function"
			? this.vaultSync.isBlobTombstoned(normalized)
			: true;
		if (!tombstoned || this.vaultSync.getBlobRef?.(normalized)) {
			return null;
		}
		return {
			fingerprint: JSON.stringify(["legacy-blob-delete", normalized]),
			deletedRef: undefined,
		};
	}

	private getAuthoritativeBlobDeleteFingerprint(path: string): string | null {
		return this.getAuthoritativeBlobDeleteState(path)?.fingerprint ?? null;
	}

	private captureBlobRemoteDeleteIdentity(
		path: string,
		entry: PreservedUnresolvedEntry,
		expected?: BlobRemoteDeleteResolutionIdentity,
	): Required<BlobRemoteDeleteResolutionIdentity> {
		const normalized = normalizePath(path);
		const episodeId = getPreservedUnresolvedEpisodeId(entry);
		if (expected?.episodeId !== undefined && expected.episodeId !== episodeId) {
			throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
		}

		const remoteDeleteFingerprint =
			this.getAuthoritativeBlobDeleteFingerprint(normalized);
		if (remoteDeleteFingerprint === null) {
			throw new Error(`Remote deletion is no longer authoritative for "${normalized}". Refresh the dashboard.`);
		}
		if (
			expected?.remoteDeleteFingerprint !== undefined
			&& expected.remoteDeleteFingerprint !== remoteDeleteFingerprint
		) {
			throw new Error(`Remote deletion changed for "${normalized}". Refresh the dashboard.`);
		}
		return { episodeId, remoteDeleteFingerprint };
	}

	keepLocalRemoteDeletedBlob(
		path: string,
		expectedReason: RemoteDeletePreservedUnresolvedReason,
		expectedIdentity?: BlobRemoteDeleteResolutionIdentity,
	): void {
		const normalized = normalizePath(path);
		const entry = this.preservedUnresolved.get(normalized);
		if (!entry) {
			throw new Error(`Attention entry is no longer active for "${normalized}".`);
		}
		if (
			entry.kind !== "blob"
			|| entry.reason !== expectedReason
			|| !isRemoteDeletePreservedUnresolvedEntry(entry)
		) {
			throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
		}
		const identity = this.captureBlobRemoteDeleteIdentity(
			normalized,
			entry,
			expectedIdentity,
		);
		if (this.isKeepLocalRemoteDeletePending(normalized, identity.episodeId)) {
			throw new Error(`Keep local upload is already pending for "${normalized}".`);
		}
		if (!this.isBlobPathSyncable(normalized)) {
			throw new Error(`Attachment is no longer in sync scope: ${normalized}`);
		}

		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			throw new Error(`Local file not found: ${normalized}`);
		}
		if (this.maxSize > 0 && file.stat.size > this.maxSize) {
			throw new Error(`Attachment exceeds the configured size limit: ${normalized}`);
		}

		// Keep both the tombstone and Attention marker until setBlobRef commits.
		// The explicit resolution intent is serialized in exportQueue(), allowing
		// only this upload to bypass the normal preserved-unresolved guard.
		this.fenceTransfersForPath(normalized, "attention-keep-local");
		this.trace?.("blob", "preserved-unresolved-keep-local-queued", {
			path: normalized,
			reason: entry.reason,
		});
		this.enqueueUpload(normalized, 0, file.stat.size, {
			kind: "keep-local-remote-delete",
			expectedReason,
			episodeId: identity.episodeId,
			remoteDeleteFingerprint: identity.remoteDeleteFingerprint,
		});
		this.kickUploadDrain();
	}

	/**
	 * Accept a remote blob deletion safely.
	 *
	 * Ordering is intentional: this method first fences and removes queued
	 * uploads/downloads, then invokes the caller-owned local deletion, and only
	 * after that promise succeeds and the file is absent does it clear the
	 * preserved-unresolved marker. Callers must perform their trash/delete inside
	 * `deleteLocalFile`; clearing the marker separately would break this order.
	 */
	async acceptRemoteDeletedBlob(
		path: string,
		expectedReason: RemoteDeletePreservedUnresolvedReason,
		deleteLocalFile: (file: TFile) => Promise<void>,
		expectedIdentity?: BlobRemoteDeleteResolutionIdentity,
		persistFencedQueue?: (snapshot: BlobQueueSnapshot) => Promise<void>,
	): Promise<void> {
		const normalized = normalizePath(path);
		const entry = this.preservedUnresolved.get(normalized);
		if (!entry) {
			throw new Error(`Attention entry is no longer active for "${normalized}".`);
		}
		if (
			entry.kind !== "blob"
			|| entry.reason !== expectedReason
			|| !isRemoteDeletePreservedUnresolvedEntry(entry)
		) {
			throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
		}
		const identity = this.captureBlobRemoteDeleteIdentity(
			normalized,
			entry,
			expectedIdentity,
		);
		const deleteState = this.getAuthoritativeBlobDeleteState(normalized);
		if (!deleteState || deleteState.fingerprint !== identity.remoteDeleteFingerprint) {
			throw new Error(`Remote deletion changed for "${normalized}". Refresh the dashboard.`);
		}

		const initialFile = this.app.vault.getAbstractFileByPath(normalized);
		if (initialFile && !(initialFile instanceof TFile)) {
			throw new Error(`Attention path is not a file: ${normalized}`);
		}

		this.attentionAcceptInFlight.add(normalized);
		const generation = this.fenceTransfersForPath(
			normalized,
			"attention-accept-remote-delete",
		);
		let retirementStage: BlobSettlementStage | undefined;
		let localDeleteStarted = false;
		let retirementCommitted = false;
		try {
			await persistFencedQueue?.(this.exportQueue());
			// A transfer that already crossed its final pre-write fence may still
			// be awaiting the filesystem. Let it finish, then delete its result.
			await this.waitForTransfersToSettle(normalized);
			if (this.currentTransferGeneration(normalized) !== generation) {
				throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
			}
			const file = this.app.vault.getAbstractFileByPath(normalized);
			if (file && !(file instanceof TFile)) {
				throw new Error(`Attention path is not a file: ${normalized}`);
			}
			const currentBeforeDelete = this.preservedUnresolved.get(normalized);
			if (
				!currentBeforeDelete
				|| currentBeforeDelete.kind !== "blob"
				|| currentBeforeDelete.reason !== expectedReason
				|| getPreservedUnresolvedEpisodeId(currentBeforeDelete)
					!== identity.episodeId
				|| this.getAuthoritativeBlobDeleteFingerprint(normalized)
					!== identity.remoteDeleteFingerprint
			) {
				throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
			}
			retirementStage = await this.prepareSettlementStage(
				normalized,
				"retire",
				cloneBlobRef(deleteState.deletedRef ?? this.settledRefs[normalized]),
				this.settledSourceVersions[normalized] ?? null,
			);
			if (
				this.currentTransferGeneration(normalized) !== generation
				|| this.getAuthoritativeBlobDeleteFingerprint(normalized)
					!== identity.remoteDeleteFingerprint
				|| this.app.vault.getAbstractFileByPath(normalized) !== file
			) {
				throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
			}
			if (file instanceof TFile) {
				// From this point a rejection may still follow a partially-applied
				// filesystem delete. Preserve the durable retire stage on every error.
				localDeleteStarted = true;
				await deleteLocalFile(file);
			}

			const remaining = this.app.vault.getAbstractFileByPath(normalized);
			if (remaining) {
				throw new Error(`Local attachment was not deleted: ${normalized}`);
			}
			if (this.currentTransferGeneration(normalized) !== generation) {
				throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
			}
			const current = this.preservedUnresolved.get(normalized);
			if (
				!current
				|| current.kind !== "blob"
				|| current.reason !== expectedReason
				|| getPreservedUnresolvedEpisodeId(current) !== identity.episodeId
				|| this.getAuthoritativeBlobDeleteFingerprint(normalized)
					!== identity.remoteDeleteFingerprint
			) {
				throw new Error(`Attention state changed for "${normalized}". Refresh the dashboard.`);
			}
			if (!await this.retireSettlementStage(normalized, retirementStage)) {
				throw new Error(`Attachment retirement could not be finalized for "${normalized}".`);
			}
			retirementCommitted = true;
			if (!this.preservedUnresolved.resolve(normalized)) {
				throw new Error(`Attention entry is no longer active for "${normalized}".`);
			}
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("blob", "preserved-unresolved-accepted-remote-delete", {
				path: normalized,
				reason: current.reason,
				generation,
			});
		} catch (err) {
			if (retirementStage && !localDeleteStarted && !retirementCommitted) {
				try {
					await this.abortSettlementStage(normalized, retirementStage);
				} catch {
					// A failed abort is fail-closed: the durable stage remains.
				}
			}
			throw err;
		} finally {
			this.attentionAcceptInFlight.delete(normalized);
		}
	}

	/**
	 * Reconcile blob files: compare disk blobs vs CRDT pathToBlob.
	 * Called during authoritative reconciliation.
	 *
	 * Returns: { uploadQueued, downloadQueued, skipped }
	 */
	reconcile(
		mode: "conservative" | "authoritative",
		excludePatterns: string[],
	): { uploadQueued: number; downloadQueued: number; skipped: number } {
		if (!this.inventoryGateReady) {
			this.trace?.("blob", "blob-inventory-layout-deferred", { mode });
			return { uploadQueued: 0, downloadQueued: 0, skipped: 0 };
		}
		let uploadQueued = 0;
		let downloadQueued = 0;
		let skipped = 0;

		// Physical presence and transfer eligibility are distinct. In particular,
		// an existing attachment that exceeds the upload limit is still present on
		// disk and must never be mistaken for a missing path that needs download.
		const diskPresentBlobPaths = new Set<string>();

		// Collect non-md, non-excluded disk files eligible for transfer work.
		const diskBlobs = new Map<string, TFile>();
		for (const file of this.app.vault.getFiles()) {
			if (
				!isBlobSyncable(
					file.path,
					excludePatterns,
					this.app.vault.configDir,
				)
			)
				continue;
			diskPresentBlobPaths.add(normalizePath(file.path));

			// Size check
			if (this.maxSize > 0 && file.stat.size > this.maxSize) continue;

			if (
				this.localOnlyBlobConflictPaths.has(file.path) ||
				isBlobConflictArtifactPath(normalizePath(file.path))
			) {
				skipped++;
				continue;
			}

			diskBlobs.set(file.path, file);
		}

		// Collect CRDT blob paths (non-tombstoned)
		const crdtBlobPaths = new Set<string>();
		this.vaultSync.pathToBlob.forEach((_ref, path) => {
			if (!this.vaultSync.isBlobTombstoned(path) && this.isBlobPathSyncable(path)) {
				crdtBlobPaths.add(path);
			} else if (!this.vaultSync.isBlobTombstoned(path)) {
				skipped++;
			}
		});

		// CRDT blobs not on disk → schedule download
		for (const path of crdtBlobPaths) {
			if (!diskPresentBlobPaths.has(normalizePath(path))) {
				const settledRef = this.getSettledRef(path);
				if (settledRef) {
					// A durable settlement proves this device previously had an exact
					// replica at the path. Its later absence may be an offline delete or
					// rename, so remote bytes cannot be recreated until the local intent
					// bootstrap has resolved that absence causally.
					skipped++;
					this.trace?.("blob", "reconcile-download-deferred-missing-settled-replica", {
						path: normalizePath(path),
						settledHashPrefix: hashPrefix(settledRef.hash),
					});
					continue;
				}
				const ref = this.vaultSync.pathToBlob.get(path);
				if (ref) {
					if (this.scheduleDownload(
						path,
						ref.hash,
						ref.size,
						getBlobRefPriorHashes(ref),
					)) {
						downloadQueued++;
					} else {
						skipped++;
					}
				}
			}
		}

		// Disk blobs not in CRDT → schedule upload (authoritative only)
		// Disk blobs IN CRDT but with different hash → schedule upload (content changed offline)
		for (const [path, file] of diskBlobs) {
			// Check tombstone
			if (this.vaultSync.isBlobTombstoned(path)) {
				if (mode === "authoritative") {
					this.scheduleRemoteDelete(path);
				}
				skipped++;
				continue;
			}

			// Skip preserved-unresolved paths: these were preserved during a
			// remote-delete with unknown baseline and must not be auto-uploaded
			// until the user explicitly modifies them.
			if (this.preservedUnresolvedPaths.has(path)) {
				const unresolved = this.preservedUnresolved.get(path);
				const remoteRef = crdtBlobPaths.has(path)
					? this.vaultSync.getBlobRef(path)
					: undefined;
				if (
					mode === "authoritative"
					&& unresolved?.reason === LEGACY_MISSING_BLOB_ATTENTION_REASON
					&& remoteRef
				) {
					this.verifyLegacyMigrationPresentFile(path, file, remoteRef);
				}
				skipped++;
				continue;
			}

			if (crdtBlobPaths.has(path)) {
				// Three-way attachment decision. A local edit may publish only while
				// the authoritative ref still equals the durable ref that last matched
				// this disk path. If remote authority also moved, download settlement
				// preserves a divergent local file as a conflict artifact instead of
				// rolling either side backward.
				if (mode === "authoritative") {
					const ref = this.vaultSync.pathToBlob.get(path);
					if (ref) {
						if (sameBlobRef(this.getSettledRef(path), ref)) {
							// Remote did not move since the last exact disk/ref settlement;
							// the upload path performs a fresh exact equality/read before it
							// either settles or publishes a causal local successor.
							this.enqueueUpload(path, 0, file.stat.size);
							uploadQueued++;
						} else if (this.scheduleDownload(
							path,
							ref.hash,
							ref.size,
							getBlobRefPriorHashes(ref),
						)) {
							downloadQueued++;
						}
					}
				}
				continue;
			}

			if (mode === "authoritative") {
				this.enqueueUpload(path, 0, file.stat.size);
				uploadQueued++;
			} else {
				skipped++;
			}
		}

		// Kick drains if anything was queued
		if (uploadQueued > 0 || downloadQueued > 0) {
			// Reset cycle counters for fresh progress tracking
			this._completedUploads = 0;
			this._completedDownloads = 0;
			this._totalUploadsThisCycle = uploadQueued;
			this._totalDownloadsThisCycle = downloadQueued;
		}
		if (uploadQueued > 0) this.kickUploadDrain();
		if (downloadQueued > 0) this.kickDownloadDrain();

		this.log(
			`reconcile: ${uploadQueued} uploads queued, ` +
				`${downloadQueued} downloads queued, ${skipped} skipped`,
		);

		return { uploadQueued, downloadQueued, skipped };
	}

	// -------------------------------------------------------------------
	// Upload drain
	// -------------------------------------------------------------------

	private kickUploadDrain(): void {
		if (!this.uploadGateOpen) return;
		if (this.uploadDraining) return;
		void this.drainUploads();
	}

	private async drainUploads(): Promise<void> {
		if (!this.uploadGateOpen) return;
		this.uploadDraining = true;
		try {
			const inFlight = new Set<Promise<void>>();
			while (true) {
				if (!this.uploadGateOpen) return;
				while (inFlight.size < this.maxConcurrency) {
					const item = this.nextPendingUpload();
					if (!item) break;
					item.status = "processing";
					this.inflightUploads.add(item.path);
					let p: Promise<void>;
					p = this.processUpload(item)
						.catch((err) => {
							console.error(
								`[kaos:blob] Unexpected upload failure for "${item.path}":`,
								err,
							);
						})
						.finally(() => {
							inFlight.delete(p);
							this.activeTransferPromises.delete(p);
							this.inflightUploads.delete(item.path);
							this.notifyTransferSettled(item.path);
						});
					inFlight.add(p);
					this.activeTransferPromises.add(p);
				}

				if (inFlight.size === 0) {
					if (this.uploadQueue.size === 0) break;
					if (!this.hasPendingUploads()) return;
					// All items are waiting for retry timers to re-kick the drain.
					return;
				}

				await Promise.race(inFlight);
			}
		} finally {
			this.uploadDraining = false;
			if (this.uploadGateOpen && this.hasPendingUploads()) {
				this.kickUploadDrain();
			}
		}
	}

	private isUploadAttemptCurrent(
		item: UploadItem,
		generation: number,
	): boolean {
		return this.uploadGateOpen
			&& this.isTransferCurrent(item.path, generation)
			&& this.uploadQueue.get(item.path) === item
			&& item.generation === generation
			&& !item.needsRerun;
	}

	private isUploadBaseCurrent(
		path: string,
		baseRefKnown: boolean,
		expectedBaseRef: BlobRef | undefined,
		causalBaseRef: BlobRef | undefined,
		expectedBaseSourceVersion: string | undefined,
		explicitKeepLocal: boolean,
		ownedStage?: BlobSettlementStage,
	): boolean {
		if (!baseRefKnown) return false;
		const normalized = normalizePath(path);
		if (
			ownedStage
			&& this.settlementStages[normalized]?.stageId !== ownedStage.stageId
		) return false;
		const currentRef = this.vaultSync.getBlobRef?.(normalized);
		if (!sameBlobRef(currentRef, expectedBaseRef)) return false;
		if (explicitKeepLocal) {
			const deleteState = this.getAuthoritativeBlobDeleteState(normalized);
			return !!deleteState
				&& sameBlobRef(deleteState.deletedRef, causalBaseRef);
		}
		if (this.vaultSync.isBlobTombstoned?.(normalized)) return false;
		const settledRef = ownedStage
			? cloneBlobRef(this.settledRefs[normalized])
			: this.getSettledRef(normalized);
		return expectedBaseRef
			? sameBlobRef(causalBaseRef, expectedBaseRef)
				&& sameBlobRef(settledRef, expectedBaseRef)
				&& !!expectedBaseSourceVersion
				&& this.getSettledSourceVersion(normalized) === expectedBaseSourceVersion
				&& this.vaultSync.getBlobSourceVersion?.(normalized) === expectedBaseSourceVersion
			: causalBaseRef === undefined
				&& settledRef === undefined;
	}

	private rejectStaleUploadAuthority(item: UploadItem, reason: string): void {
		const normalized = normalizePath(item.path);
		this.discardUploadItem(item);
		const target = this.getAuthoritativeDownloadRef(normalized);
		if (target.ref) {
			this.scheduleDownload(
				normalized,
				target.ref.hash,
				target.ref.size,
				getBlobRefPriorHashes(target.ref),
			);
		}
		this.trace?.("blob", "upload-rejected-stale-causal-base", {
			path: normalized,
			reason,
			authoritativeRefFingerprint: target.ref
				? blobRefFingerprint(target.ref)
				: "absent",
		});
	}

	private prepareUploadRerun(
		item: UploadItem,
		reason: string,
	): void {
		if (this.uploadQueue.get(item.path) !== item) return;
		const current = this.app.vault.getAbstractFileByPath(
			normalizePath(item.path),
		);
		if (!(current instanceof TFile)) {
			this.discardUploadItem(item);
			return;
		}
		item.needsRerun = false;
		item.status = "pending";
		item.retries = 0;
		item.readyAt = 0;
		item.sizeBytes = current.stat.size;
		item.generation = this.currentTransferGeneration(item.path);
		this.trace?.("blob", "upload-stale-attempt-rerun", {
			path: normalizePath(item.path),
			reason,
			generation: item.generation,
		});
		this.kickUploadDrain();
	}

	private async processUpload(item: UploadItem): Promise<void> {
		const start = Date.now();
		const generation = item.generation
			?? this.currentTransferGeneration(item.path);
		item.generation = generation;
		const attemptBaseRefKnown = item.baseRefKnown === true;
		const attemptExpectedBaseRef = cloneBlobRef(item.expectedBaseRef);
		const attemptCausalBaseRef = cloneBlobRef(item.causalBaseRef);
		const attemptExpectedBaseSourceVersion = item.expectedBaseSourceVersion;
		this.log(
			`upload: started "${item.path}" (attempt ${item.retries + 1})`,
		);
		try {
			const normalized = normalizePath(item.path);
			if (this.settlementStages[normalized]) {
				this.discardUploadItem(item);
				this.trace?.("blob", "upload-blocked-settlement-stage", {
					path: normalized,
					stageKind: this.settlementStages[normalized]?.kind,
				});
				return;
			}
			if (!this.uploadGateOpen) {
				this.prepareUploadRerun(item, "upload-gate-closed-before-start");
				return;
			}
			if (!this.isTransferCurrent(normalized, generation)) {
				this.discardUploadItem(item);
				this.trace?.("blob", "upload-cancelled-by-path-fence", {
					path: normalized,
					generation,
				});
				return;
			}
			if (!this.isBlobPathSyncable(normalized)) {
				this.uploadQueue.delete(item.path);
				this.log(`upload: skipped excluded path "${item.path}"`);
				return;
			}

			// Guard: do not upload preserved-unresolved paths or local-only
			// blob conflict artifacts. This can happen
			// if a queue snapshot was restored with a stale entry for a path
			// that was later guarded by conflict handling.
			const explicitKeepLocal = item.attentionResolution?.kind
				=== "keep-local-remote-delete";
			if (
				explicitKeepLocal
				&& !this.isKeepLocalUploadResolutionActive(item, normalized)
			) {
				this.discardUploadItem(item);
				this.trace?.("blob", "upload-skipped-stale-attention-resolution", {
					path: normalized,
					reason: "attention-episode-or-tombstone-changed",
				});
				return;
			}
			if (
				this.localOnlyBlobConflictPaths.has(normalized) ||
				this.localOnlyBlobConflictPaths.has(item.path) ||
				isBlobConflictArtifactPath(normalized) ||
				isBlobConflictArtifactPath(normalizePath(item.path)) ||
				(!explicitKeepLocal && (
					this.preservedUnresolvedPaths.has(normalized) ||
					this.preservedUnresolvedPaths.has(item.path)
				))
			) {
				this.uploadQueue.delete(item.path);
				const isLocalOnlyConflict =
					this.localOnlyBlobConflictPaths.has(normalized) ||
					this.localOnlyBlobConflictPaths.has(item.path) ||
					isBlobConflictArtifactPath(normalized) ||
					isBlobConflictArtifactPath(normalizePath(item.path));
				this.trace?.(
					"blob",
					isLocalOnlyConflict
						? "upload-skipped-local-guard"
						: "upload-skipped-preserved-unresolved",
					{
						path: normalized,
						reason: isLocalOnlyConflict
							? "local-only-conflict-artifact"
							: "preserved-unresolved",
					},
				);
				this.log(
					`upload: "${item.path}" is guarded local-only, skipping`,
				);
				return;
			}
			if (!this.isUploadBaseCurrent(
				normalized,
				attemptBaseRefKnown,
				attemptExpectedBaseRef,
				attemptCausalBaseRef,
				attemptExpectedBaseSourceVersion,
				explicitKeepLocal,
			)) {
				this.rejectStaleUploadAuthority(item, "base-changed-before-upload");
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(normalized);
			if (!(file instanceof TFile)) {
				this.uploadQueue.delete(item.path);
				this.log(`upload: "${item.path}" no longer exists, skipping`);
				removeCachedHash(this.hashCache, item.path);
				return;
			}

			// Size guard
			if (this.maxSize > 0 && file.stat.size > this.maxSize) {
				this.uploadQueue.delete(item.path);
				this.log(
					`upload: "${item.path}" too large (${file.stat.size} bytes), skipping`,
				);
				return;
			}
			const attemptStat = {
				mtime: file.stat.mtime,
				size: file.stat.size,
			};
			item.sizeBytes = attemptStat.size;

			// The cache is only a starting hint. Exact file identity and fresh bytes
			// are revalidated before any ref commit below.
			let hash = getCachedHash(this.hashCache, item.path, attemptStat);
			let data: ArrayBuffer | null = null;

			if (!hash) {
				const initialSnapshot = await this.readAndHashExactExistingFile(
					file,
					normalized,
					attemptStat,
				);
				if (
					!initialSnapshot.current
					|| !initialSnapshot.hash
					|| !initialSnapshot.data
					|| !this.isUploadAttemptCurrent(item, generation)
				) {
					if (this.isTransferCurrent(normalized, generation)) {
						this.prepareUploadRerun(item, "file-changed-during-initial-read");
					} else {
						this.discardUploadItem(item);
					}
					return;
				}
				hash = initialSnapshot.hash;
				data = initialSnapshot.data;
			}
			const attemptHash = hash;

			// Check if CRDT already has this exact hash for this path
			const existingRef = this.vaultSync.getBlobRef(item.path);
			if (!explicitKeepLocal && existingRef && existingRef.hash === attemptHash) {
				const equalitySourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
				if (!equalitySourceVersion) {
					this.rejectStaleUploadAuthority(item, "equality-source-version-unavailable");
					return;
				}
				const equalityStage = await this.prepareSettlementStage(
					normalized,
					"equality",
					existingRef,
					equalitySourceVersion,
				);
				const equalitySnapshot = await this.readAndHashExactExistingFile(
					file,
					normalized,
					attemptStat,
				);
				if (
					this.isUploadAttemptCurrent(item, generation)
					&& equalitySnapshot.current
					&& equalitySnapshot.hash === attemptHash
					&& sameBlobRef(this.vaultSync.getBlobRef(normalized), existingRef)
					&& this.vaultSync.getBlobSourceVersion?.(normalized) === equalitySourceVersion
				) {
					if (!await this.finalizeSettlementStage(
						normalized,
						equalityStage,
						existingRef,
						equalitySourceVersion,
					)) {
						// The exact ref episode changed after the stage was durable.
						// Keep the stage: clearing it would let a byte-identical
						// delete/revive episode borrow the old disk settlement.
						this.discardUploadItem(item);
						this.trace?.("blob", "upload-equality-settlement-ambiguous", {
							path: normalized,
						});
						return;
					}
					this.uploadQueue.delete(item.path);
					this.log(
						`upload: "${item.path}" unchanged (hash match), skipping`,
					);
				} else if (this.isTransferCurrent(normalized, generation)) {
					await this.abortSettlementStage(normalized, equalityStage);
					this.prepareUploadRerun(item, "file-changed-before-equality-settlement");
				} else {
					await this.abortSettlementStage(normalized, equalityStage);
					this.discardUploadItem(item);
				}
				return;
			}

			// Check if R2 already has this blob (content-addressed dedup)
			const present = await this.blobClient.exists([attemptHash]);
			if (!present.includes(attemptHash)) {
				// Need actual bytes for upload — read if we used cache
				if (!data) {
					const uploadSnapshot = await this.readAndHashExactExistingFile(
						file,
						normalized,
						attemptStat,
					);
					if (
						!uploadSnapshot.current
						|| uploadSnapshot.hash !== attemptHash
						|| !uploadSnapshot.data
						|| !this.isUploadAttemptCurrent(item, generation)
					) {
						if (this.isTransferCurrent(normalized, generation)) {
							this.prepareUploadRerun(item, "file-changed-before-upload");
						} else {
							this.discardUploadItem(item);
						}
						return;
					}
					data = uploadSnapshot.data;
				}
				if (!this.isUploadAttemptCurrent(item, generation)) {
					if (this.isTransferCurrent(normalized, generation)) {
						this.prepareUploadRerun(item, "newer-upload-admitted-before-network-write");
					} else {
						this.discardUploadItem(item);
					}
					return;
				}

				// Upload through the Worker
				const mime = guessMime(item.path);
				const uploadTimeoutMs = transferTimeoutMs(item.sizeBytes);
				await this.blobClient.upload(
					attemptHash,
					mime,
					data,
					uploadTimeoutMs,
				);

				this.log(
					`upload: "${item.path}" uploaded (${data.byteLength} bytes)`,
				);
			} else {
				this.log(
					`upload: "${item.path}" already in R2 (dedup), updating CRDT only`,
				);
			}

			// Two-phase commit: after every network await, re-read the exact original
			// TFile epoch and prove its bytes/hash/size still match this attempt.
			if (!this.uploadGateOpen) {
				this.prepareUploadRerun(item, "upload-gate-closed-before-ref-commit");
				return;
			}
			if (
				!this.isTransferCurrent(normalized, generation)
				|| (explicitKeepLocal
					&& !this.isKeepLocalUploadResolutionActive(item, normalized))
			) {
				this.discardUploadItem(item);
				this.trace?.("blob", "upload-cancelled-before-blob-ref-commit", {
					path: normalized,
					generation,
				});
				return;
			}
			if (!this.isUploadBaseCurrent(
				normalized,
					attemptBaseRefKnown,
					attemptExpectedBaseRef,
					attemptCausalBaseRef,
					attemptExpectedBaseSourceVersion,
					explicitKeepLocal,
			)) {
				this.rejectStaleUploadAuthority(item, "base-changed-before-ref-commit");
				return;
			}
			const mime = guessMime(item.path);
			const stagedUploadRef = createCausalBlobRef(
				attemptHash,
				attemptStat.size,
				attemptCausalBaseRef,
			);
			const uploadSettlementStage = await this.prepareSettlementStage(
				normalized,
				"upload",
				stagedUploadRef,
				null,
			);
			let authorityRejected = false;
			let gateClosed = false;
			let committedRef: BlobRef | undefined;
			let committedSourceVersion: string | undefined;
			const commitSnapshot = await this.readAndHashExactExistingFile(
				file,
				normalized,
				attemptStat,
				(snapshot) => {
					if (
						!this.uploadGateOpen
						|| !this.isUploadAttemptCurrent(item, generation)
						|| snapshot.hash !== attemptHash
						|| snapshot.data.byteLength !== attemptStat.size
						|| (explicitKeepLocal
							&& !this.isKeepLocalUploadResolutionActive(item, normalized))
					) {
						if (!this.uploadGateOpen) gateClosed = true;
						return false;
					}
					if (!this.isUploadBaseCurrent(
						normalized,
						attemptBaseRefKnown,
						attemptExpectedBaseRef,
						attemptCausalBaseRef,
						attemptExpectedBaseSourceVersion,
						explicitKeepLocal,
						uploadSettlementStage,
					)) {
						authorityRejected = true;
						return false;
					}

					const resolution = explicitKeepLocal
						? item.attentionResolution
						: undefined;
					const refCommit = this.vaultSync.setBlobRef(
						item.path,
						attemptHash,
						attemptStat.size,
						mime,
						undefined,
						{
							expectedCurrentRef: attemptExpectedBaseRef,
							causalBaseRef: attemptCausalBaseRef,
							expectedCurrentSourceVersion: attemptExpectedBaseSourceVersion,
						},
					) as ReturnType<VaultSync["setBlobRef"]> | undefined;
					if (refCommit === null) {
						authorityRejected = true;
						return false;
					}
					if (
						refCommit
						&& typeof refCommit === "object"
						&& "ref" in refCommit
						&& "sourceVersion" in refCommit
					) {
						committedRef = cloneBlobRef(refCommit.ref);
						committedSourceVersion = refCommit.sourceVersion;
					} else {
						// Focused legacy doubles may return a bare ref or void.
						// Production VaultSync always returns the exact ref plus its
						// newly-created item episode.
						committedRef = cloneBlobRef(refCommit as unknown as BlobRef)
							?? createCausalBlobRef(
								attemptHash,
								attemptStat.size,
								attemptCausalBaseRef,
							);
						committedSourceVersion =
							this.vaultSync.getBlobSourceVersion?.(normalized);
					}
					if (resolution?.kind === "keep-local-remote-delete") {
						// setBlobRef may synchronously notify observers. Resolve only the
						// exact Attention episode that admitted this commit; never clear a
						// replacement occurrence installed by a re-entrant observer.
						if (
							this.hasExactKeepLocalAttentionEntry(normalized, resolution)
							&& this.preservedUnresolved.resolve(normalized)
						) {
							this.onPreservedUnresolvedChanged?.();
							this.trace?.("blob", "preserved-unresolved-kept-local", {
								path: normalized,
								reason: resolution.expectedReason,
								generation,
							});
						} else {
							this.trace?.("blob", "keep-local-marker-changed-during-commit", {
								path: normalized,
								expectedEpisodeId: resolution.episodeId,
								generation,
							});
						}
						if (item.attentionResolution === resolution) {
							item.attentionResolution = undefined;
						}
					}
					return true;
				},
			);
			if (!commitSnapshot.commitAccepted) {
				await this.abortSettlementStage(normalized, uploadSettlementStage);
				if (gateClosed || !this.uploadGateOpen) {
					this.prepareUploadRerun(item, "upload-gate-closed-at-ref-commit");
					return;
				}
				if (authorityRejected) {
					this.rejectStaleUploadAuthority(item, "base-changed-at-ref-commit");
					return;
				}
				if (this.isTransferCurrent(normalized, generation)) {
					this.prepareUploadRerun(item, "file-changed-before-blob-ref-commit");
				} else {
					this.discardUploadItem(item);
				}
				return;
			}
			if (
				!committedRef
				|| !committedSourceVersion
				|| !await this.finalizeSettlementStage(
					normalized,
					uploadSettlementStage,
					committedRef,
					committedSourceVersion,
				)
			) {
				throw new Error(`Upload settlement could not be finalized for "${normalized}"`);
			}
			this._completedUploads++;
			if (item.needsRerun) {
				item.needsRerun = false;
				item.status = "pending";
				item.retries = 0;
				item.readyAt = 0;
				this.log(
					`upload: success "${item.path}" in ${Date.now() - start}ms (queued rerun)`,
				);
				this.kickUploadDrain();
			} else {
				this.uploadQueue.delete(item.path);
				this.log(
					`upload: success "${item.path}" in ${Date.now() - start}ms`,
				);
			}
		} catch (err) {
			if (!this.uploadGateOpen) {
				this.prepareUploadRerun(item, "upload-gate-closed-after-error");
				return;
			}
			if (!this.isTransferCurrent(item.path, generation)) {
				this.discardUploadItem(item);
				this.trace?.("blob", "upload-cancelled-by-path-fence", {
					path: normalizePath(item.path),
					generation,
				});
				return;
			}
			const reason = err instanceof Error ? err.message : String(err);
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(
					`upload: failed "${item.path}" in ${Date.now() - start}ms ` +
						`(attempt ${item.retries + 1}): ${reason}; retrying in ${delay}ms`,
				);
				item.retries++;
				item.status = "pending";
				item.readyAt = Date.now() + delay;
				this.scheduleRetryKick(delay, "upload");
			} else {
				if (item.needsRerun && item.rerunResets < MAX_RERUN_RESETS) {
					item.needsRerun = false;
					item.status = "pending";
					item.retries = 0;
					item.readyAt = 0;
					item.rerunResets++;
					this.log(
						`upload: "${item.path}" had pending rerun (reset ${item.rerunResets}/${MAX_RERUN_RESETS}); restarting fresh`,
					);
					this.kickUploadDrain();
					return;
				}
				this.uploadQueue.delete(item.path);
				this._permanentUploadFailures++;
				this.trace?.("blob", "upload-permanently-failed", {
					path: item.path,
					retries: item.retries,
					error: err instanceof Error ? err.message : String(err),
					totalPermanentFailures: this._permanentUploadFailures,
				});
				console.error(
					`[kaos:blob] Upload failed permanently for "${item.path}":`,
					err,
				);
			}
		}
	}

	private hasExactKeepLocalAttentionEntry(
		normalizedPath: string,
		resolution: BlobKeepLocalUploadResolution,
	): boolean {
		const entry = this.preservedUnresolved.get(normalizedPath);
		return !!entry
			&& entry.kind === "blob"
			&& entry.reason === resolution.expectedReason
			&& getPreservedUnresolvedEpisodeId(entry) === resolution.episodeId
			&& isRemoteDeletePreservedUnresolvedEntry(entry);
	}

	private isKeepLocalUploadResolutionActive(
		item: UploadItem,
		normalizedPath: string,
	): boolean {
		const resolution = item.attentionResolution;
		if (!resolution || resolution.kind !== "keep-local-remote-delete") {
			return false;
		}
		return this.hasExactKeepLocalAttentionEntry(normalizedPath, resolution)
			&& this.getAuthoritativeBlobDeleteFingerprint(normalizedPath)
				=== resolution.remoteDeleteFingerprint;
	}

	private nextPendingUpload(): UploadItem | null {
		const now = Date.now();
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return item;
		}
		return null;
	}

	private hasPendingUploads(): boolean {
		const now = Date.now();
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return true;
		}
		return false;
	}

	// -------------------------------------------------------------------
	// Download drain
	// -------------------------------------------------------------------

	private scheduleDownload(
		path: string,
		hash: string,
		sizeBytes?: number,
		acceptableLocalHashes: readonly string[] = [],
	): boolean {
		const normalized = normalizePath(path);
		if (this.settlementStages[normalized]) {
			this.downloadQueue.delete(normalized);
			this.trace?.("blob", "download-blocked-settlement-stage", {
				path: normalized,
				stageKind: this.settlementStages[normalized]?.kind,
			});
			return false;
		}
		if (
			this.preservedUnresolved.get(normalized)?.reason
			=== LEGACY_MISSING_BLOB_ATTENTION_REASON
		) {
			this.downloadQueue.delete(normalized);
			this.trace?.("blob", "download-blocked-preserved-unresolved", {
				path: normalized,
				reason: this.preservedUnresolved.get(normalized)?.reason ?? "unknown",
			});
			return false;
		}
		if (!this.isBlobPathSyncable(path)) {
			this.dropExcludedQueuedDownload(path, "schedule");
			return false;
		}
		this.enqueueDownload(path, hash, sizeBytes, 0, acceptableLocalHashes);
		this.kickDownloadDrain();
		return true;
	}

	/**
	 * Schedule high-priority downloads for paths that are needed now
	 * (e.g. attachments embedded in the currently-open note).
	 * Skips paths already on disk or already queued.
	 */
	prioritizeDownloads(paths: string[]): number {
		let queued = 0;
		for (const path of paths) {
			if (!this.isBlobPathSyncable(path)) continue;
			// Already queued
			if (this.downloadQueue.has(path)) continue;

			// Check if file exists on disk already
			const existing = this.app.vault.getAbstractFileByPath(
				normalizePath(path),
			);
			if (existing instanceof TFile) continue;

			// Look up the blob ref in the CRDT
			const ref = this.vaultSync.pathToBlob.get(path);
			if (!ref) continue;
			if (this.vaultSync.isBlobTombstoned(path)) continue;

			if (this.scheduleDownload(path, ref.hash, ref.size)) queued++;
		}

		if (queued > 0) {
			this.log(
				`prioritizeDownloads: queued ${queued} prefetch downloads`,
			);
			this.kickDownloadDrain();
		}
		return queued;
	}

	private kickDownloadDrain(): void {
		if (!this.downloadGateOpen) return;
		if (this.downloadDraining) return;
		void this.drainDownloads();
	}

	private async drainDownloads(): Promise<void> {
		if (!this.downloadGateOpen) return;
		this.downloadDraining = true;
		try {
			const inFlight = new Set<Promise<void>>();
			while (true) {
				while (
					this.downloadGateOpen
					&& inFlight.size < this.maxConcurrency
				) {
					const item = this.nextPendingDownload();
					if (!item) break;
					item.status = "processing";
					this.inflightDownloads.add(item.path);
					let p: Promise<void>;
					p = this.processDownload(item)
						.catch((err) => {
							console.error(
								`[kaos:blob] Unexpected download failure for "${item.path}":`,
								err,
							);
						})
						.finally(() => {
							inFlight.delete(p);
							this.activeTransferPromises.delete(p);
							this.inflightDownloads.delete(item.path);
							this.notifyTransferSettled(item.path);
						});
					inFlight.add(p);
					this.activeTransferPromises.add(p);
				}

				if (inFlight.size === 0) {
					if (!this.downloadGateOpen) return;
					if (this.downloadQueue.size === 0) break;
					if (!this.hasPendingDownloads()) return;
					// All items are waiting for retry timers to re-kick the drain.
					return;
				}

				await Promise.race(inFlight);
			}
		} finally {
			this.downloadDraining = false;
			if (this.downloadGateOpen && this.hasPendingDownloads()) {
				this.kickDownloadDrain();
			}
		}
	}

	private async processDownload(item: DownloadItem): Promise<void> {
		const start = Date.now();
		const generation = item.generation
			?? this.currentTransferGeneration(item.path);
		item.generation = generation;
		const attemptHash = item.hash;
		const attemptSizeBytes = item.sizeBytes;
		const acceptableLocalHashes = new Set(
			normalizeAcceptableLocalHashes(item.acceptableLocalHashes),
		);
		this.log(
			`download: started "${item.path}" (attempt ${item.retries + 1})`,
		);
		try {
			const normalized = normalizePath(item.path);
			if (this.cancelDownloadIfFenced(item, generation, "start")) {
				return;
			}
			if (this.settlementStages[normalized]) {
				this.discardDownloadItem(item);
				this.trace?.("blob", "download-blocked-settlement-stage", {
					path: normalized,
					stageKind: this.settlementStages[normalized]?.kind,
				});
				return;
			}
			if (!this.isBlobPathSyncable(normalized)) {
				this.downloadQueue.delete(item.path);
				this.log(`download: skipped excluded path "${item.path}"`);
				return;
			}

			// Check if file already exists with matching hash
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			const settledRefAtStart = this.getSettledRef(normalized);
			const settledSourceVersionAtStart =
				this.getSettledSourceVersion(normalized);
			if (!(existing instanceof TFile) && settledRefAtStart) {
				// This device previously settled an exact disk/ref pair at this path.
				// Starting a fresh create while the canonical path is now absent would
				// resurrect a delete/rename made while KAOS was inactive. This final
				// admission fence also covers pre-provider/imported queues and prefetch.
				// It intentionally runs only at attempt start: a clean existing-file
				// advance may later create a short KAOS-owned vacancy while moving H1 to
				// a visible backup, and that guarded H1 -> H2 swap remains valid.
				this.discardDownloadItem(item);
				this.trace?.("blob", "download-deferred-missing-settled-replica", {
					path: normalized,
					occupantKind: existing === null ? "missing" : "non-file",
					attemptHashPrefix: hashPrefix(attemptHash),
					settledHashPrefix: hashPrefix(settledRefAtStart.hash),
				});
				this.log(
					`download: deferred missing settled replica "${item.path}"`,
				);
				return;
			}
			let diskHashBefore: string | null = null;
			let diskStatBefore: { mtime: number; size: number } | null = null;
			let diskSnapshotWasExact = false;
			if (existing instanceof TFile) {
				// A cache/stat match is not sufficient authority for a destructive
				// overwrite decision. Read and hash the exact TFile epoch, then prove
				// that identity and stat stayed current across both awaits.
				diskStatBefore = {
					mtime: existing.stat.mtime,
					size: existing.stat.size,
				};
				const diskSnapshot = await this.readAndHashExactExistingFile(
					existing,
					item.path,
					diskStatBefore,
				);
				diskHashBefore = diskSnapshot.hash;
				diskSnapshotWasExact = diskSnapshot.current;

				if (diskSnapshot.current && diskSnapshot.hash === attemptHash) {
					if (this.deferSupersededDownload(
						item,
						attemptHash,
						"existing-match-settlement",
					)) return;
					const equalityTarget = this.getAuthoritativeDownloadRef(normalized).ref;
					const equalitySourceVersion =
						this.vaultSync.getBlobSourceVersion?.(normalized);
					if (!equalityTarget) {
						if (!this.deferSupersededDownload(
							item,
							attemptHash,
							"existing-match-target-unavailable",
						)) this.discardDownloadItem(item);
						return;
					}
					if (!equalitySourceVersion) {
						await this.prepareSettlementStage(
							normalized,
							"equality",
							equalityTarget,
							null,
						);
						this.discardDownloadItem(item);
						this.trace?.("blob", "download-source-version-unavailable", {
							path: normalized,
							stage: "existing-match",
						});
						return;
					}
					const equalityStage = await this.prepareSettlementStage(
						normalized,
						"equality",
						equalityTarget,
						equalitySourceVersion,
					);
					const finalEqualitySnapshot = await this.readAndHashExactExistingFile(
						existing,
						normalized,
						diskStatBefore,
					);
					const equalitySnapshotChanged =
						!finalEqualitySnapshot.current
						|| finalEqualitySnapshot.hash !== attemptHash
						|| !this.isDownloadAttemptAuthoritative(item, attemptHash);
					if (equalitySnapshotChanged) {
						await this.abortSettlementStage(normalized, equalityStage);
						if (!this.deferSupersededDownload(
							item,
							attemptHash,
							"existing-match-finalization-changed",
						)) {
							item.status = "pending";
							item.readyAt = 0;
							this.kickDownloadDrain();
						}
						return;
					}
					if (!await this.finalizeSettlementStage(
							normalized,
							equalityStage,
							equalityTarget,
							equalitySourceVersion,
						)) {
						// The stage is the durable ambiguity fence. Do not abort it
						// after a same-ref source episode changed.
						this.discardDownloadItem(item);
						this.trace?.("blob", "download-settlement-episode-changed", {
							path: normalized,
							stage: "existing-match",
						});
						return;
					}
					this.log(`download: "${item.path}" already matches, skipping`);
					this.trace?.("blob", "download-overwrite-decision", {
						path: item.path,
						hashPrefix: hashPrefix(attemptHash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						action: "skip-existing-match",
						sizeBytes: attemptSizeBytes ?? null,
					});
					this.discardDownloadItem(item);
					return;
				}
			}

			const downloadTimeoutMs = transferTimeoutMs(attemptSizeBytes);
			const data = await this.blobClient.download(
				attemptHash,
				downloadTimeoutMs,
			);

			// Verify hash of downloaded data
			const downloadHash = await hashArrayBuffer(data);
			if (downloadHash !== attemptHash) {
				throw new Error(
					`Hash mismatch: expected ${attemptHash.slice(0, 12)}… got ${downloadHash.slice(0, 12)}…`,
				);
			}
			if (this.deferSupersededDownload(
				item,
				attemptHash,
				"verified-response",
			)) return;
			const downloadTarget = this.getAuthoritativeDownloadRef(normalized).ref;
			const downloadSourceVersion = this.vaultSync.getBlobSourceVersion?.(normalized);
			if (!downloadTarget || downloadTarget.hash !== attemptHash) {
				if (!this.deferSupersededDownload(
					item,
					attemptHash,
					"verified-response-target-unavailable",
				)) this.discardDownloadItem(item);
				return;
			}
			if (!downloadSourceVersion) {
				await this.prepareSettlementStage(
					normalized,
					"download",
					downloadTarget,
					null,
				);
				this.discardDownloadItem(item);
				this.trace?.("blob", "download-source-version-unavailable", {
					path: normalized,
					stage: "verified-response",
				});
				return;
			}
			const downloadSettlementStage = await this.prepareSettlementStage(
				normalized,
				"download",
				downloadTarget,
				downloadSourceVersion,
			);
			if (!this.isDownloadAttemptAuthoritative(item, attemptHash)) {
				await this.abortSettlementStage(normalized, downloadSettlementStage);
				this.deferSupersededDownload(
					item,
					attemptHash,
					"after-download-settlement-stage",
				);
				return;
			}

			// A remote update may replace an existing attachment only when the exact
			// disk epoch still contains a hash from the continuously observed prior-ref
			// lineage. Unknown/add provenance and every identity/stat/hash mismatch stay
			// fail-closed and preserve both candidates below.
			if (existing instanceof TFile) {
				let overwriteResult: "applied" | "conflict" | "superseded" = "conflict";
				if (
					diskStatBefore
					&& diskSnapshotWasExact
					&& diskHashBefore !== null
					&& acceptableLocalHashes.has(diskHashBefore)
				) {
					overwriteResult = await this.replaceExistingDownloadNoClobber(
						item,
						existing,
						normalized,
						data,
						attemptHash,
						diskStatBefore,
						generation,
						acceptableLocalHashes,
						settledRefAtStart,
						settledSourceVersionAtStart,
						downloadSettlementStage,
					);
				}

				if (overwriteResult === "superseded") {
					await this.abortSettlementStage(normalized, downloadSettlementStage);
					this.deferSupersededDownload(
						item,
						attemptHash,
						"existing-no-clobber-swap-superseded",
					);
					return;
				}
				if (overwriteResult === "applied") {
					if (!await this.recordAuthoritativeDownloadSettlement(
						item,
						attemptHash,
						downloadSettlementStage,
					)) {
						throw new Error(
							`Download settlement could not be finalized for "${normalized}"`,
						);
					}
					this.trace?.("blob", "download-overwrite-decision", {
						path: item.path,
						hashPrefix: hashPrefix(attemptHash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						action: "swap-clean-prior-ref-no-clobber",
						sizeBytes: data.byteLength,
					});
					this.log(
						`download: safely advanced clean prior ref "${item.path}" ` +
							`(${data.byteLength} bytes) in ${Date.now() - start}ms`,
					);
				} else {
					await this.abortSettlementStage(normalized, downloadSettlementStage);
					if (this.deferSupersededDownload(
						item,
						attemptHash,
						"conflict-artifact-write",
					)) return;
					if (this.cancelDownloadIfFenced(
						item,
						generation,
						"conflict-artifact-write",
					)) return;
					const conflictPath = await this.writeDownloadConflictArtifact(
						normalized,
						data,
						attemptHash,
						"existing-changed-during-download",
						{ path: normalized, generation },
					);
					if (this.deferSupersededDownload(
						item,
						attemptHash,
						"after-conflict-artifact-write",
					)) return;
					this.quarantineDownloadConflict(
						normalized,
						diskHashBefore,
						attemptHash,
					);
					this.trace?.("blob", "download-conflict-quarantined", {
						path: item.path,
						conflictPath,
						hashPrefix: hashPrefix(attemptHash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						reason: "existing-changed-during-download",
						action: "preserve-local-and-remote-artifact",
						sizeBytes: data.byteLength,
					});
					this.log(
						`download: conflict artifact "${conflictPath}" for "${item.path}" ` +
							`(existing local attachment was not overwritten)`,
					);
				}
			} else {
				this.trace?.("blob", "download-overwrite-decision", {
					path: item.path,
					hashPrefix: hashPrefix(attemptHash),
					diskHashBeforePrefix: null,
					action: "create-missing",
					sizeBytes: data.byteLength,
				});
				// Ensure parent directory exists
				const dir = normalized.substring(
					0,
					normalized.lastIndexOf("/"),
				);
				if (dir) {
					if (this.cancelDownloadIfFenced(
						item,
						generation,
						"create-parent-folder",
					)) {
						await this.abortSettlementStage(normalized, downloadSettlementStage);
						return;
					}
					const dirExists = this.app.vault.getAbstractFileByPath(
						normalizePath(dir),
					);
					if (!dirExists) {
						try {
							await this.app.vault.createFolder(dir);
						} catch (err) {
							if (!isAlreadyExistsError(err)) throw err;
						}
					}
				}
				if (this.cancelDownloadIfFenced(
					item,
					generation,
					"create-missing",
				)) {
					await this.abortSettlementStage(normalized, downloadSettlementStage);
					return;
				}
				if (this.deferSupersededDownload(
					item,
					attemptHash,
					"create-missing",
				)) {
					await this.abortSettlementStage(normalized, downloadSettlementStage);
					return;
				}
				this.suppress(item.path);
				try {
					const created = await this.app.vault.createBinary(normalized, data);
					const createdSnapshot = await this.hashExactExistingFile(created, normalized);
					if (createdSnapshot.current && createdSnapshot.hash === attemptHash) {
						if (!this.isDownloadAttemptAuthoritative(item, attemptHash)) {
							const retired = await this.trashExactDownloadedReplica(
								created,
								normalized,
								attemptHash,
							);
							if (retired) {
								await this.abortSettlementStage(
									normalized,
									downloadSettlementStage,
								);
								const deferred = this.deferSupersededDownload(
									item,
									attemptHash,
									"after-created-target-settlement",
								);
								if (!deferred) {
									item.status = "pending";
									item.readyAt = 0;
									this.kickDownloadDrain();
								}
							} else {
								const authoritative =
									this.getAuthoritativeDownloadRef(normalized).ref;
								this.quarantineDownloadConflict(
									normalized,
									attemptHash,
									authoritative?.hash ?? attemptHash,
								);
								this.trace?.("blob", "superseded-created-target-trash-failed", {
									path: normalized,
									hashPrefix: hashPrefix(attemptHash),
								});
							}
							return;
						}
						this.log(
							`download: created "${item.path}" (${data.byteLength} bytes) in ${Date.now() - start}ms`,
						);
						if (!await this.recordAuthoritativeDownloadSettlement(
							item,
							attemptHash,
							downloadSettlementStage,
						)) {
							throw new Error(
								`Created download settlement could not be finalized for "${normalized}"`,
							);
						}
					} else {
						if (this.deferSupersededDownload(
							item,
							attemptHash,
							"created-target-conflict-artifact",
						)) return;
						const conflictPath = await this.writeDownloadConflictArtifact(
							normalized,
							data,
							attemptHash,
							"create-race-mismatch",
							{ path: normalized, generation },
						);
						if (this.deferSupersededDownload(
							item,
							attemptHash,
							"after-created-target-conflict-artifact",
						)) return;
						this.quarantineDownloadConflict(
							normalized,
							createdSnapshot.hash,
							attemptHash,
						);
						await this.abortSettlementStage(normalized, downloadSettlementStage);
						this.trace?.("blob", "download-conflict-quarantined", {
							path: item.path,
							conflictPath,
							hashPrefix: hashPrefix(attemptHash),
							reason: "created-target-changed-before-settlement",
							sizeBytes: data.byteLength,
						});
					}
				} catch (err) {
					if (!isAlreadyExistsError(err)) throw err;
					const resolved =
						this.app.vault.getAbstractFileByPath(normalized);
					if (!(resolved instanceof TFile)) throw err;
					const raceSnapshot = await this.hashExactExistingFile(
						resolved,
						item.path,
					);
					const diskHash = raceSnapshot.hash;

					if (raceSnapshot.current && diskHash === attemptHash) {
						if (this.deferSupersededDownload(
							item,
							attemptHash,
							"after-create-race-match",
						)) return;
						this.trace?.("blob", "download-overwrite-decision", {
							path: item.path,
							hashPrefix: hashPrefix(attemptHash),
							diskHashBeforePrefix: hashPrefix(diskHash),
							action: "skip-create-race-match",
							sizeBytes: data.byteLength,
						});
						this.log(
							`download: "${item.path}" already matches after create race, skipping ` +
								`in ${Date.now() - start}ms`,
						);
						if (!await this.recordAuthoritativeDownloadSettlement(
							item,
							attemptHash,
							downloadSettlementStage,
						)) {
							throw new Error(
								`Create-race settlement could not be finalized for "${normalized}"`,
							);
						}
					} else {
						if (this.deferSupersededDownload(
							item,
							attemptHash,
							"create-race-conflict-artifact",
						)) return;
						if (this.cancelDownloadIfFenced(
							item,
							generation,
							"create-race-conflict-artifact",
						)) return;
						const conflictPath =
							await this.writeDownloadConflictArtifact(
								normalized,
								data,
								attemptHash,
								"create-race-mismatch",
								{ path: normalized, generation },
							);
						if (this.deferSupersededDownload(
							item,
							attemptHash,
							"after-create-race-conflict-artifact",
						)) return;
						this.quarantineDownloadConflict(
							normalized,
							diskHash,
							attemptHash,
						);
						await this.abortSettlementStage(normalized, downloadSettlementStage);
						this.trace?.("blob", "download-conflict-quarantined", {
							path: item.path,
							conflictPath,
							hashPrefix: hashPrefix(attemptHash),
							diskHashBeforePrefix: hashPrefix(diskHash),
							reason: "create-race-mismatch",
							sizeBytes: data.byteLength,
						});
						this.log(
							`download: conflict artifact "${conflictPath}" after create race for "${item.path}" ` +
								`(${data.byteLength} bytes) in ${Date.now() - start}ms`,
						);
					}
				}
			}

			this._completedDownloads++;
			if (item.needsRerun) {
				this.prepareDownloadRerun(item);
				this.log(
					`download: success "${item.path}" in ${Date.now() - start}ms (queued rerun)`,
				);
				this.kickDownloadDrain();
			} else {
				this.discardDownloadItem(item);
			}
		} catch (err) {
			if (!this.isTransferCurrent(item.path, generation)) {
				this.discardDownloadItem(item);
				this.trace?.("blob", "download-cancelled-by-path-fence", {
					path: normalizePath(item.path),
					generation,
					stage: "error",
				});
				return;
			}
			const reason = err instanceof Error ? err.message : String(err);
			if (item.needsRerun && item.nextHash) {
				this.prepareDownloadRerun(item);
				this.log(
					`download: "${item.path}" target changed during failed attempt; starting latest hash`,
				);
				this.kickDownloadDrain();
				return;
			}
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(
					`download: failed "${item.path}" in ${Date.now() - start}ms ` +
						`(attempt ${item.retries + 1}): ${reason}; retrying in ${delay}ms`,
				);
				item.retries++;
				item.status = "pending";
				item.readyAt = Date.now() + delay;
				this.scheduleRetryKick(delay, "download");
			} else {
				if (item.needsRerun && item.rerunResets < MAX_RERUN_RESETS) {
					item.rerunResets++;
					this.prepareDownloadRerun(item);
					this.log(
						`download: "${item.path}" had pending rerun (reset ${item.rerunResets}/${MAX_RERUN_RESETS}); restarting fresh`,
					);
					this.kickDownloadDrain();
					return;
				}
				this.downloadQueue.delete(item.path);
				this._permanentDownloadFailures++;
				this.trace?.("blob", "download-permanently-failed", {
					path: item.path,
					retries: item.retries,
					error: err instanceof Error ? err.message : String(err),
					totalPermanentFailures: this._permanentDownloadFailures,
				});
				console.error(
					`[kaos:blob] Download failed permanently for "${item.path}":`,
					err,
				);
			}
		}
	}

	private prepareDownloadRerun(item: DownloadItem): void {
		if (item.nextHash) {
			item.hash = item.nextHash;
			item.sizeBytes = item.nextSizeBytes;
			item.targetRefFingerprint = item.nextTargetRefFingerprint;
			item.acceptableLocalHashes = normalizeAcceptableLocalHashes(
				item.nextAcceptableLocalHashes,
			);
		}
		item.nextHash = undefined;
		item.nextSizeBytes = undefined;
		item.nextTargetRefFingerprint = undefined;
		item.nextAcceptableLocalHashes = undefined;
		item.needsRerun = false;
		item.status = "pending";
		item.retries = 0;
		item.readyAt = 0;
	}

	private getAuthoritativeDownloadRef(
		path: string,
	): { available: boolean; ref: BlobRef | undefined } {
		const normalized = normalizePath(path);
		if (typeof this.vaultSync.getBlobRef === "function") {
			const ref = this.vaultSync.getBlobRef(normalized);
			return {
				available: true,
				ref: this.vaultSync.isBlobTombstoned?.(normalized)
					? undefined
					: ref,
			};
		}
		if (this.vaultSync.pathToBlob?.get) {
			const ref = this.vaultSync.pathToBlob.get(normalized);
			return {
				available: true,
				ref: this.vaultSync.isBlobTombstoned?.(normalized)
					? undefined
					: ref,
			};
		}
		// Focused legacy doubles may not expose the authoritative map. Production
		// VaultSync always does, so item rerun state remains the compatibility fence.
		return { available: false, ref: undefined };
	}

	private isDownloadAttemptAuthoritative(
		item: DownloadItem,
		attemptHash: string,
	): boolean {
		if (!this.downloadGateOpen) return false;
		const generation = item.generation
			?? this.currentTransferGeneration(item.path);
		if (!this.isTransferCurrent(item.path, generation)) return false;
		if (item.needsRerun) return false;
		if (item.nextHash && item.nextHash !== attemptHash) return false;
		const target = this.getAuthoritativeDownloadRef(item.path);
		if (!target.available) return true;
		if (target.ref?.hash !== attemptHash) return false;
		return !item.targetRefFingerprint
			|| blobRefFingerprint(target.ref) === item.targetRefFingerprint;
	}

	private isDownloadPredecessorAuthoritative(
		item: DownloadItem,
		attemptHash: string,
		localHash: string,
		settledRefAtStart: BlobRef | undefined,
		settledSourceVersionAtStart: string | undefined,
		stage: BlobSettlementStage,
	): boolean {
		if (!this.isDownloadAttemptAuthoritative(item, attemptHash)) return false;
		// Prior-hash membership alone only proves that the bytes once existed in
		// the remote lineage. It does not prove that the current disk epoch is the
		// clean replica last settled by KAOS (the user may have explicitly reverted
		// to an older hash). Require the durable settlement on the same hash before
		// moving the local file aside for a remote advance.
		const normalized = normalizePath(item.path);
		if (
			!settledRefAtStart
			|| settledRefAtStart.hash !== localHash
			|| !settledSourceVersionAtStart
			|| !sameBlobRef(this.settledRefs[normalized], settledRefAtStart)
			|| this.settledSourceVersions[normalized] !== settledSourceVersionAtStart
			|| this.settlementStages[normalized]?.stageId !== stage.stageId
		) return false;
		const target = this.getAuthoritativeDownloadRef(item.path);
		if (!target.available) {
			// Focused legacy doubles may not expose the map. Production always does.
			return item.acceptableLocalHashes?.includes(localHash) ?? false;
		}
		return !!target.ref
			&& blobRefFingerprint(target.ref) === item.targetRefFingerprint
			&& getBlobRefPriorHashes(target.ref).includes(localHash);
	}

	private async recordAuthoritativeDownloadSettlement(
		item: DownloadItem,
		attemptHash: string,
		stage: BlobSettlementStage,
	): Promise<boolean> {
		if (!this.isDownloadAttemptAuthoritative(item, attemptHash)) return false;
		const target = this.getAuthoritativeDownloadRef(item.path);
		if (target.ref?.hash === attemptHash) {
			return await this.finalizeSettlementStage(
				item.path,
				stage,
				target.ref,
				stage.sourceVersion,
			);
		}
		return false;
	}

	private deferSupersededDownload(
		item: DownloadItem,
		attemptHash: string,
		stage: string,
	): boolean {
		if (this.isDownloadAttemptAuthoritative(item, attemptHash)) return false;
		const target = this.getAuthoritativeDownloadRef(item.path);
		if (target.ref?.hash && target.ref.hash !== attemptHash) {
			if (item.nextHash !== target.ref.hash) {
				// The target ref carries its publisher-authored causal lineage. Legacy
				// refs omit it and therefore remain fail-closed.
				item.nextAcceptableLocalHashes = getBlobRefPriorHashes(target.ref);
				item.nextHash = target.ref.hash;
				item.nextSizeBytes = target.ref.size;
				item.nextTargetRefFingerprint = blobRefFingerprint(target.ref);
			}
			item.needsRerun = true;
		}
		this.trace?.("blob", "download-superseded-before-disk-write", {
			path: normalizePath(item.path),
			attemptHashPrefix: hashPrefix(attemptHash),
			authoritativeHashPrefix: hashPrefix(target.ref?.hash ?? null),
			stage,
		});
		if (item.needsRerun && item.nextHash) {
			this.prepareDownloadRerun(item);
			this.kickDownloadDrain();
		} else {
			this.discardDownloadItem(item);
		}
		return true;
	}

	private cancelDownloadIfFenced(
		item: DownloadItem,
		generation: number,
		stage: string,
	): boolean {
		if (this.isTransferCurrent(item.path, generation)) return false;
		this.discardDownloadItem(item);
		this.trace?.("blob", "download-cancelled-by-path-fence", {
			path: normalizePath(item.path),
			generation,
			stage,
		});
		return true;
	}

	private async hashExistingFile(
		file: TFile,
		path: string,
	): Promise<string | null> {
		const fileStat = { mtime: file.stat.mtime, size: file.stat.size };
		const cachedHash = getCachedHash(this.hashCache, path, fileStat);
		if (cachedHash) return cachedHash;
		try {
			const data = await this.app.vault.readBinary(file);
			const hash = await hashArrayBuffer(data);
			setCachedHash(this.hashCache, path, fileStat, hash);
			return hash;
		} catch {
			return null;
		}
	}

	private async hashExactExistingFile(
		file: TFile,
		path: string,
	): Promise<{ current: boolean; hash: string | null }> {
		const snapshot = await this.readAndHashExactExistingFile(file, path);
		return { current: snapshot.current, hash: snapshot.hash };
	}

	private async readAndHashExactExistingFile(
		file: TFile,
		path: string,
		expectedStat?: { mtime: number; size: number },
		commit?: ExactBlobFileCommit,
	): Promise<ExactBlobFileSnapshot> {
		const normalized = normalizePath(path);
		const initialStat = expectedStat ?? {
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		const identityCurrent = () =>
			file.path === normalized
			&& this.app.vault.getAbstractFileByPath(normalized) === file
			&& file.stat.mtime === initialStat.mtime
			&& file.stat.size === initialStat.size;
		if (!identityCurrent()) {
			return {
				current: false,
				hash: null,
				data: null,
				commitAccepted: false,
			};
		}
		let data: ArrayBuffer;
		let hash: string;
		try {
			data = await this.app.vault.readBinary(file);
			if (!identityCurrent()) {
				return {
					current: false,
					hash: null,
					data: null,
					commitAccepted: false,
				};
			}
			hash = await hashArrayBuffer(data);
		} catch {
			return {
				current: false,
				hash: null,
				data: null,
				commitAccepted: false,
			};
		}
		if (!identityCurrent()) {
			return { current: false, hash, data, commitAccepted: false };
		}
		setCachedHash(this.hashCache, normalized, initialStat, hash);
		if (!identityCurrent()) {
			return { current: false, hash, data, commitAccepted: false };
		}
		// The callback runs in this same turn, immediately after the final exact
		// TFile/stat/byte verification and before this async method resolves. This
		// is the linearization point for mutations such as publishing a blob ref;
		// no promise-reaction microtask can slip between validation and commit.
		const commitAccepted = commit?.({ hash, data }) ?? false;
		return { current: true, hash, data, commitAccepted };
	}

	private async trashExactDownloadedReplica(
		file: TFile,
		path: string,
		expectedHash: string,
	): Promise<boolean> {
		const normalized = normalizePath(path);
		const ownedStat = { mtime: file.stat.mtime, size: file.stat.size };
		const backupPath = await this.moveExactFileToVisibleLocalBackup(
			file,
			normalized,
			ownedStat,
			({ hash }) => hash === expectedHash,
			this.currentTransferGeneration(normalized),
			"superseded-downloaded-replica",
			// This compensates a KAOS-owned create that already crossed its last
			// pre-write fence. Retirement must wait for and permit that exact cleanup.
			true,
		);
		return backupPath !== null
			&& this.app.vault.getAbstractFileByPath(normalized) === null;
	}

	private quarantineDownloadConflict(
		path: string,
		localHash: string | null,
		remoteHash: string,
	): void {
		const normalized = normalizePath(path);
		const existing = this.preservedUnresolved.get(normalized);
		if (existing) return;
		this.fenceTransfersForPath(normalized, "preserved-unresolved:remote-download-local-conflict");
		this.preservedUnresolved.record({
			path: normalized,
			kind: "blob",
			reason: "remote-download-local-conflict",
			localHash,
			knownRemoteHash: remoteHash,
		});
		this.onPreservedUnresolvedChanged?.();
		this.trace?.("blob", "preserved-unresolved-recorded", {
			path: normalized,
			reason: "remote-download-local-conflict",
			localHashPrefix: hashPrefix(localHash),
			remoteHashPrefix: hashPrefix(remoteHash),
		});
	}

	/**
	 * Write remote blob bytes to a conflict artifact instead of overwriting the
	 * target file.
	 *
	 * Policy: blob conflict artifacts are LOCAL-ONLY safety artifacts. They are
	 * suppressed from upload so they do not sync back to the server or other
	 * devices. This is intentional — the artifact exists only to preserve remote
	 * bytes that could not safely overwrite the local file. The user can inspect,
	 * rename, or delete the artifact. If they want the remote version to sync,
	 * they should replace the original file manually.
	 *
	 * Markdown conflict artifacts (from ReconciliationController) are also
	 * local-only safety artifacts. They use a durable filename marker plus create
	 * event suppression so restarts do not seed them into CRDT as normal notes.
	 */
	private async writeDownloadConflictArtifact(
		targetPath: string,
		data: ArrayBuffer,
		expectedHash: string,
		reason: "existing-changed-during-download" | "create-race-mismatch",
		transferFence?: { path: string; generation: number },
	): Promise<string> {
		const baseConflictPath = buildBlobConflictArtifactPath(normalizePath(targetPath));
		for (let i = 0; i < 100; i++) {
			const conflictPath = buildBlobConflictArtifactCopyPath(baseConflictPath, i + 1);
			const existingArtifact = this.app.vault.getAbstractFileByPath(conflictPath);
			if (existingArtifact instanceof TFile) {
				const snapshot = await this.hashExactExistingFile(existingArtifact, conflictPath);
				if (snapshot.current && snapshot.hash === expectedHash) {
					this.localOnlyBlobConflictPaths.add(conflictPath);
					this.suppress(conflictPath);
					return conflictPath;
				}
				continue;
			}
			if (existingArtifact) continue;
			try {
				if (
					transferFence
					&& !this.isTransferCurrent(
						transferFence.path,
						transferFence.generation,
					)
				) {
					throw new Error("blob download cancelled by path fence");
				}
				this.suppress(conflictPath);
				await this.app.vault.createBinary(conflictPath, data);
				this.localOnlyBlobConflictPaths.add(conflictPath);
				const freshStat =
					await this.app.vault.adapter.stat(conflictPath);
				if (freshStat) {
					const hash = await hashArrayBuffer(data);
					setCachedHash(
						this.hashCache,
						conflictPath,
						{ mtime: freshStat.mtime, size: freshStat.size },
						hash,
					);
				}
				this._blobConflictArtifacts++;
				// Notify the user — blob conflict artifacts are local-only
				// and will NOT sync to other devices.
				try {
					new Notice(
						`KAOS: Local-only attachment conflict preserved — "${conflictPath.split("/").pop()}" (this device only)`,
						8000,
					);
				} catch {
					// Notice may fail in testing or headless environments.
				}
				return conflictPath;
			} catch (err) {
				if (isAlreadyExistsError(err)) continue;
				throw err;
			}
		}
		throw new Error(
			`could not create blob conflict artifact for ${reason}`,
		);
	}

	private nextPendingDownload(): DownloadItem | null {
		const now = Date.now();
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return item;
		}
		return null;
	}

	private hasPendingDownloads(): boolean {
		const now = Date.now();
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return true;
		}
		return false;
	}

	private nextAvailableBlobLocalBackupPath(path: string): string {
		for (let attempt = 0; attempt < 100; attempt++) {
			const random = crypto.getRandomValues(new Uint8Array(8));
			const operationId = Array.from(random, (value) =>
				value.toString(16).padStart(2, "0")
			).join("");
			const candidate = normalizePath(
				buildBlobLocalBackupArtifactPath(path, operationId),
			);
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
		throw new Error(`could not allocate local attachment safety copy for ${path}`);
	}

	private async moveExactFileToVisibleLocalBackup(
		file: TFile,
		path: string,
		expectedStat: { mtime: number; size: number },
		canCommit: (snapshot: { hash: string; data: ArrayBuffer }) => boolean,
		generation: number,
		reason: string,
		allowDuringDestroy = false,
	): Promise<string | null> {
		const normalized = normalizePath(path);
		const backupPath = this.nextAvailableBlobLocalBackupPath(normalized);
		const renameDispatch: { promise?: Promise<void> } = {};
		this.localOnlyBlobConflictPaths.add(backupPath);

		const snapshot = await this.readAndHashExactExistingFile(
			file,
			normalized,
			expectedStat,
			(exact) => {
				if (
					(this.destroyed && !allowDuringDestroy)
					|| this.currentTransferGeneration(normalized) !== generation
					|| !canCommit(exact)
				) return false;
				this.remoteOverwriteRenameTickets.set(normalized, {
					file,
					newPath: backupPath,
					generation,
					kind: "backup",
				});
				try {
					renameDispatch.promise = this.app.vault.rename(file, backupPath);
					return true;
				} catch {
					this.remoteOverwriteRenameTickets.delete(normalized);
					return false;
				}
			},
		);

		const renamePromise = renameDispatch.promise;
		if (!snapshot.commitAccepted || !renamePromise) {
			this.remoteOverwriteRenameTickets.delete(normalized);
			this.localOnlyBlobConflictPaths.delete(backupPath);
			return null;
		}
		let renameRejected = false;
		try {
			await renamePromise;
		} catch {
			renameRejected = true;
		}

		const backupOwnsFile =
			this.app.vault.getAbstractFileByPath(backupPath) === file
			&& normalizePath(file.path) === backupPath;
		if (!backupOwnsFile) {
			this.remoteOverwriteRenameTickets.delete(normalized);
			this.localOnlyBlobConflictPaths.delete(backupPath);
			return null;
		}
		if (renameRejected) {
			this.trace?.("blob", "visible-local-backup-rename-rejected-after-move", {
				path: normalized,
				backupPath,
				reason,
			});
		}
		// Keep the successful ticket until the exact Vault rename event consumes
		// it. The file itself remains permanently visible at backupPath.
		this.recordVisibleRemoteOverwriteBackup(normalized, backupPath, reason);
		return backupPath;
	}

	private async restoreRemoteOverwriteBackup(
		file: TFile,
		backupPath: string,
		targetPath: string,
	): Promise<boolean> {
		if (
			this.app.vault.getAbstractFileByPath(backupPath) !== file
			|| this.app.vault.getAbstractFileByPath(targetPath) !== null
		) return false;
		// Never rename back over the target. Some Vault adapters do not document
		// destination no-clobber semantics for rename. Copying the preserved bytes
		// with createBinary makes an intervening external create win with EEXIST,
		// while the backup remains intact in every outcome.
		let data: ArrayBuffer;
		try {
			data = await this.app.vault.readBinary(file);
		} catch {
			return false;
		}
		if (
			this.app.vault.getAbstractFileByPath(backupPath) !== file
			|| this.app.vault.getAbstractFileByPath(targetPath) !== null
		) return false;
		this.suppress(targetPath);
		try {
			const restored = await this.app.vault.createBinary(targetPath, data);
			return this.app.vault.getAbstractFileByPath(targetPath) === restored;
		} catch {
			this.suppressedPaths.delete(targetPath);
			return false;
		}
	}

	private recordVisibleRemoteOverwriteBackup(
		targetPath: string,
		backupPath: string,
		reason: string,
	): void {
		this._blobConflictArtifacts++;
		this.trace?.("blob", "remote-overwrite-local-backup-preserved", {
			path: targetPath,
			backupPath,
			reason,
		});
		try {
			new Notice(
				`KAOS: Local attachment safety copy preserved — "${backupPath.split("/").pop()}"`,
				10000,
			);
		} catch {
			// Notice may fail in testing or headless environments.
		}
	}

	private async replaceExistingDownloadNoClobber(
		item: DownloadItem,
		existing: TFile,
		normalized: string,
		data: ArrayBuffer,
		attemptHash: string,
		diskStatBefore: { mtime: number; size: number },
		generation: number,
		acceptableLocalHashes: ReadonlySet<string>,
		settledRefAtStart: BlobRef | undefined,
		settledSourceVersionAtStart: string | undefined,
		stage: BlobSettlementStage,
	): Promise<"applied" | "conflict" | "superseded"> {
		const backupPath = await this.moveExactFileToVisibleLocalBackup(
			existing,
			normalized,
			diskStatBefore,
			({ hash }) => {
				return (
					!acceptableLocalHashes.has(hash)
						? false
						: this.downloadQueue.get(item.path) === item
						&& item.generation === generation
						&& this.isDownloadPredecessorAuthoritative(
						item,
						attemptHash,
						hash,
						settledRefAtStart,
						settledSourceVersionAtStart,
						stage,
					)
				);
			},
			generation,
			"remote-existing-file-advance",
		);
		if (!backupPath) {
			return this.isDownloadAttemptAuthoritative(item, attemptHash)
				? "conflict"
				: "superseded";
		}

		if (!this.isDownloadAttemptAuthoritative(item, attemptHash)) {
			await this.restoreRemoteOverwriteBackup(
				existing,
				backupPath,
				normalized,
			);
			return "superseded";
		}
		if (this.app.vault.getAbstractFileByPath(normalized) !== null) {
			return "conflict";
		}

		this.suppress(normalized);
		let created: TFile;
		try {
			created = await this.app.vault.createBinary(normalized, data);
		} catch (err) {
			this.suppressedPaths.delete(normalized);
			if (!isAlreadyExistsError(err)) {
				this.trace?.("blob", "remote-overwrite-create-failed", {
					path: normalized,
					error: err instanceof Error ? err.message : String(err),
				});
				// A non-EEXIST adapter failure may have left the target absent. Restore
				// a no-clobber copy of the preserved predecessor before returning; the
				// backup itself is intentionally retained either way.
				if (this.app.vault.getAbstractFileByPath(normalized) === null) {
					await this.restoreRemoteOverwriteBackup(
						existing,
						backupPath,
						normalized,
					);
				}
			}
			return this.isDownloadAttemptAuthoritative(item, attemptHash)
				? "conflict"
				: "superseded";
		}

		const createdSnapshot = await this.hashExactExistingFile(created, normalized);
		const attemptStillAuthoritative =
			this.isDownloadAttemptAuthoritative(item, attemptHash);
		if (
			!createdSnapshot.current
			|| createdSnapshot.hash !== attemptHash
			|| !attemptStillAuthoritative
		) {
			if (
				createdSnapshot.current
				&& createdSnapshot.hash === attemptHash
				&& !attemptStillAuthoritative
			) {
				// Authority can be revoked after createBinary has begun but before
				// its promise settles. Retire only the exact KAOS-created target,
				// then restore the preserved predecessor without clobbering any
				// intervening local create. This cleanup remains valid during destroy.
				const retired = await this.trashExactDownloadedReplica(
					created,
					normalized,
					attemptHash,
				);
				if (retired) {
					await this.restoreRemoteOverwriteBackup(
						existing,
						backupPath,
						normalized,
					);
				}
				this.trace?.("blob", "remote-overwrite-compensated-after-authority-loss", {
					path: normalized,
					retired,
					destroyed: this.destroyed,
				});
			}
			return attemptStillAuthoritative ? "conflict" : "superseded";
		}

		return "applied";
	}

	// -------------------------------------------------------------------
	// Remote delete handler
	// -------------------------------------------------------------------

	private scheduleRemoteDelete(path: string): void {
		if (this.destroyed) return;
		const normalized = normalizePath(path);
		if (!this.downloadGateOpen) {
			this.deferredRemoteDeletePaths.add(normalized);
			this.trace?.("blob", "remote-delete-deferred-without-authority", {
				path: normalized,
			});
			return;
		}
		this.deferredRemoteDeletePaths.delete(normalized);
		let task: Promise<void>;
		task = this.handleRemoteDelete(normalized)
			.catch((err) => {
				console.error(
					`[kaos:blob] Unexpected remote delete failure for "${path}":`,
					err,
				);
			})
			.finally(() => {
				this.activeRemoteDeletePromises.delete(task);
			});
		this.activeRemoteDeletePromises.add(task);
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.downloadGateOpen) {
			this.deferredRemoteDeletePaths.add(normalized);
			return;
		}
		if (!this.isBlobPathSyncable(normalized)) {
			this.log(`handleRemoteDelete: skipping excluded path "${normalized}"`);
			return;
		}
		// The tombstone is the deleting device's self-contained authority. Never
		// use this receiver's Y.Map oldValue, which may be an independent fork.
		const deleteAuthority = this.getAuthoritativeBlobDeleteState(normalized);
		if (!deleteAuthority) return;
		const { fingerprint: deleteFingerprint, deletedRef } = deleteAuthority;
		if (this.settlementStages[normalized]) {
			this.trace?.("blob", "remote-delete-blocked-settlement-stage", {
				path: normalized,
				stageKind: this.settlementStages[normalized]?.kind,
			});
			return;
		}
		const knownHash = deletedRef?.hash ?? null;
		const deleteEpisodeId = getRemoteDeleteEpisodeId(
			"blob",
			deleteFingerprint,
		);
		if (this.isKeepLocalRemoteDeletePending(normalized, deleteEpisodeId)) {
			this.trace?.("blob", "remote-delete-duplicate-ignored", {
				path: normalized,
				reason: "same-episode-keep-local-already-pending",
			});
			return;
		}
		if (this.remoteDeleteInFlight.get(normalized) === deleteFingerprint) {
			return;
		}
		this.remoteDeleteInFlight.set(normalized, deleteFingerprint);
		const transferGeneration = this.fenceTransfersForPath(
			normalized,
			"remote-delete-observed",
		);
		await this.waitForTransfersToSettle(normalized);
		if (
			this.destroyed
			|| !this.downloadGateOpen
			|| this.currentTransferGeneration(normalized) !== transferGeneration
			|| this.getAuthoritativeBlobDeleteFingerprint(normalized)
				!== deleteFingerprint
		) {
			if (!this.destroyed && !this.downloadGateOpen) {
				this.deferredRemoteDeletePaths.add(normalized);
			}
			this.trace?.("blob", "remote-delete-resolution-stale", {
				path: normalized,
				reason: "delete-episode-changed-while-waiting-for-transfers",
			});
			if (this.remoteDeleteInFlight.get(normalized) === deleteFingerprint) {
				this.remoteDeleteInFlight.delete(normalized);
			}
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			try {
				const retirementRef = cloneBlobRef(
					deletedRef ?? this.settledRefs[normalized],
				);
				// The path itself is durable absence provenance. Legacy tombstones may
				// not identify deletedRef, but a later server snapshot rollback must
				// still never turn this observed absence into first-device bootstrap.
				const retirementStage = await this.prepareSettlementStage(
					normalized,
					"retire",
					retirementRef,
					this.settledSourceVersions[normalized] ?? null,
				);
				await this.retireSettlementStage(normalized, retirementStage);
				const marker = this.preservedUnresolved.get(normalized);
				if (
					marker
					&& isRemoteDeletePreservedUnresolvedEntry(marker)
					&& getPreservedUnresolvedEpisodeId(marker) === deleteEpisodeId
					&& this.preservedUnresolved.resolve(normalized)
				) {
					this.onPreservedUnresolvedChanged?.();
				}
			} finally {
				if (this.remoteDeleteInFlight.get(normalized) === deleteFingerprint) {
					this.remoteDeleteInFlight.delete(normalized);
				}
			}
			return;
		}
		if (file instanceof TFile) {
			try {
				// Remote delete decision: three-way typed decision avoids
				// conflating "known dirty" with "unknown baseline".
				let decision: BlobRemoteDeleteDecision = {
					kind: "apply-delete",
				};
				let unresolvedReason: PreservedUnresolvedReason | null = null;
				let localHashForMarker: string | null = null;

				if (deletedRef) {
					try {
						const fileStat =
							await this.app.vault.adapter.stat(normalized);
						if (fileStat) {
							const localSnapshot = await this.hashExactExistingFile(file, normalized);
							localHashForMarker = localSnapshot.hash;
							if (!localSnapshot.current || !localSnapshot.hash) {
								decision = { kind: "preserve-unresolved" };
								unresolvedReason = "remote-delete-hash-read-failed";
								this.trace?.("blob", "remote-delete-conflict-preserved", {
									path: normalized,
									knownHash: deletedRef.hash.slice(0, 12),
									reason: "read-or-file-identity-changed-cannot-verify",
								});
							} else {
								const settledRef = this.getSettledRef(normalized);
								const deletedRefCoversSettled = !!settledRef
									&& (
										deletedRef.hash === settledRef.hash
										|| getBlobRefPriorHashes(deletedRef).includes(settledRef.hash)
									);
								const cleanExactDeletedRef = localSnapshot.hash === deletedRef.hash;
								const cleanSettledPredecessor = !!settledRef
									&& localSnapshot.hash === settledRef.hash
									&& deletedRefCoversSettled;
								if (!cleanExactDeletedRef && !cleanSettledPredecessor) {
									decision = { kind: "preserve-unresolved" };
									unresolvedReason = "remote-delete-local-conflict";
								}
							}
						} else {
							decision = { kind: "preserve-unresolved" };
							unresolvedReason = "remote-delete-stat-failed";
						}
					} catch {
						// Stat failed — file might be locked, busy, or inaccessible.
						// We have a baseline hash but cannot verify local state.
						// Treat as unresolved to avoid deleting potentially modified data.
						decision = { kind: "preserve-unresolved" };
						unresolvedReason = "remote-delete-stat-failed";
						this.trace?.(
							"blob",
							"remote-delete-conflict-preserved",
							{
								path: normalized,
								knownHash: knownHash?.slice(0, 12) ?? null,
								reason: "stat-failed-cannot-verify",
							},
						);
						this.log(
							`handleRemoteDelete: preserved "${normalized}" (stat failed — cannot verify local state)`,
						);
					}
				} else {
					// Legacy tombstones do not prove what the deleting device saw.
					// Preserve but do NOT auto-clear tombstone. This prevents
					// phantom resurrection of legitimately deleted files when
					// hash state is transiently unavailable.
					decision = { kind: "preserve-unresolved" };
					unresolvedReason = "remote-delete-missing-baseline";
				}

				if (
					this.destroyed
					|| !this.downloadGateOpen
					|| this.currentTransferGeneration(normalized) !== transferGeneration
					|| this.getAuthoritativeBlobDeleteFingerprint(normalized) !== deleteFingerprint
				) {
					if (!this.destroyed && !this.downloadGateOpen) {
						this.deferredRemoteDeletePaths.add(normalized);
					}
					this.trace?.("blob", "remote-delete-resolution-stale", {
						path: normalized,
						reason: "delete-episode-or-transfer-generation-changed",
					});
					return;
				}

				if (decision.kind === "apply-delete") {
					const markerBeforeBackup = this.preservedUnresolved.get(normalized);
					const deleteEpisodeMatches = () =>
						!this.destroyed
							&& this.downloadGateOpen
							&& this.currentTransferGeneration(normalized)
							=== transferGeneration
						&& this.getAuthoritativeBlobDeleteFingerprint(normalized)
							=== deleteFingerprint;
					const deleteEpisodeIsCurrent = () =>
						deleteEpisodeMatches()
						&& this.app.vault.getAbstractFileByPath(normalized) === file;
					if (!deleteEpisodeMatches()) {
						this.trace?.("blob", "remote-delete-resolution-stale", {
							path: normalized,
							reason: "delete-episode-changed-before-trash",
						});
						return;
					}
					if (this.app.vault.getAbstractFileByPath(normalized) !== file) {
						this.ensureRemoteDeletePreservedMarker(
							normalized,
							deleteFingerprint,
							"remote-delete-hash-read-failed",
							knownHash,
						);
						return;
					}
					const exactCleanHash = localHashForMarker;
					if (!exactCleanHash) {
						this.ensureRemoteDeletePreservedMarker(
							normalized,
							deleteFingerprint,
							"remote-delete-hash-read-failed",
							knownHash,
						);
							return;
						}
						if (!deletedRef) return;
						const retirementStage = await this.prepareSettlementStage(
							normalized,
							"retire",
							deletedRef,
							this.settledSourceVersions[normalized] ?? null,
						);
						if (!deleteEpisodeIsCurrent()) {
							await this.abortSettlementStage(normalized, retirementStage);
							return;
						}
						const backupPath = await this.moveExactFileToVisibleLocalBackup(
						file,
						normalized,
						{ mtime: file.stat.mtime, size: file.stat.size },
						({ hash }) => hash === exactCleanHash && deleteEpisodeIsCurrent(),
						transferGeneration,
						"remote-delete-clean-replica",
					);
						if (!backupPath) {
							await this.abortSettlementStage(normalized, retirementStage);
						this.ensureRemoteDeletePreservedMarker(
							normalized,
							deleteFingerprint,
							"remote-delete-trash-failed",
							knownHash,
						);
						this.trace?.("blob", "remote-delete-backup-failed", {
							path: normalized,
						});
						return;
					}
					const pathAfterBackup = this.app.vault.getAbstractFileByPath(normalized);
					const deleteStillCurrent =
						!this.destroyed
							&& this.downloadGateOpen
							&& this.currentTransferGeneration(normalized) === transferGeneration
						&& this.getAuthoritativeBlobDeleteFingerprint(normalized) === deleteFingerprint;
					if (!deleteStillCurrent) {
						// The delete lost authority after the no-clobber move. Restore a
						// copy only if the canonical path is still absent; the visible
						// backup itself remains untouched in all outcomes.
							const restored = await this.restoreRemoteOverwriteBackup(
								file,
							backupPath,
							normalized,
							);
							if (restored) {
								await this.abortSettlementStage(normalized, retirementStage);
							}
							return;
					}
					if (pathAfterBackup !== null) {
						this.ensureRemoteDeletePreservedMarker(
							normalized,
							deleteFingerprint,
							pathAfterBackup instanceof TFile
								? "remote-delete-trash-failed"
								: "path-collision",
							knownHash,
						);
						return;
					}
					if (markerBeforeBackup) {
						const currentMarker = this.preservedUnresolved.get(normalized);
						if (
							currentMarker
							&& getPreservedUnresolvedEpisodeId(currentMarker)
								=== getPreservedUnresolvedEpisodeId(markerBeforeBackup)
							&& this.preservedUnresolved.resolve(normalized)
						) {
							this.onPreservedUnresolvedChanged?.();
						}
					}
						this.trace?.("blob", "remote-delete-applied", {
						path: normalized,
						deleteMode: "visible-local-backup",
						backupPath,
						reason: "remote-delete",
					});
						await this.retireSettlementStage(normalized, retirementStage);
					this.log(
						`handleRemoteDelete: moved "${normalized}" to visible local safety copy`,
					);
				} else {
					// preserve-unresolved: file stays, tombstone stays.
					// DO NOT auto-clear tombstone. Later reconcile/import passes
					// keep it in limbo until explicit user action or a future
					// remote event provides a new decision point.
					this.preservedUnresolved.record({
						path: normalized,
						kind: "blob",
						reason: unresolvedReason ?? "unknown",
						episodeId: getRemoteDeleteEpisodeId(
							"blob",
							deleteFingerprint,
						),
						localHash: localHashForMarker,
						knownRemoteHash: knownHash,
					});
					this.onPreservedUnresolvedChanged?.();
					this.trace?.("blob", "remote-delete-conflict-preserved", {
						path: normalized,
						knownHash: knownHash?.slice(0, 12) ?? null,
						reason: unresolvedReason ?? "unknown",
					});
					this.log(
						`handleRemoteDelete: preserved "${normalized}" (${unresolvedReason ?? "unknown"})`,
					);
				}
			} catch (err) {
				console.error(
					`[kaos:blob] handleRemoteDelete failed for "${path}":`,
					err,
				);
			} finally {
				if (this.remoteDeleteInFlight.get(normalized) === deleteFingerprint) {
					this.remoteDeleteInFlight.delete(normalized);
				}
			}
		}
	}

	private ensureRemoteDeletePreservedMarker(
		path: string,
		deleteFingerprint: string,
		reason: PreservedUnresolvedReason,
		knownRemoteHash: string | null,
	): void {
		const normalized = normalizePath(path);
		const existing = this.preservedUnresolved.get(normalized);
		const episodeId = getRemoteDeleteEpisodeId("blob", deleteFingerprint);
		if (
			existing
			&& !isRemoteDeletePreservedUnresolvedEntry(existing)
		) return;
		if (
			existing
			&& getPreservedUnresolvedEpisodeId(existing) === episodeId
			&& existing.reason === reason
		) return;
		this.preservedUnresolved.record({
			path: normalized,
			kind: "blob",
			reason,
			episodeId,
			knownRemoteHash,
		});
		this.onPreservedUnresolvedChanged?.();
	}

	private scheduleRetryKick(
		delayMs: number,
		channel: "upload" | "download",
	): void {
		const timer = setTimeout(() => {
			this.retryTimers.delete(timer);
			if (channel === "upload") this.kickUploadDrain();
			else this.kickDownloadDrain();
		}, delayMs);
		this.retryTimers.add(timer);
	}

	// -------------------------------------------------------------------
	// Suppression (prevent upload loops from own downloads)
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		const until = this.suppressedPaths.get(path);
		if (!until) return false;
		this.suppressedPaths.delete(path);
		return Date.now() < until;
	}

	/** True only while Dashboard Accept owns the exact local delete event. */
	isAcceptingRemoteDelete(path: string): boolean {
		return this.attentionAcceptInFlight.has(normalizePath(path));
	}

	/**
	 * Conservative read-only vacancy fence for startup/offline disk scans.
	 * This deliberately excludes TTL suppression and merely queued work: neither
	 * proves that KAOS currently owns a filesystem mutation for the path.
	 */
	isPathOperationInFlight(path: string): boolean {
		const normalized = normalizePath(path);
		if (this.hasInFlightTransferForPath(normalized)) return true;
		if (this.remoteDeleteInFlight.has(normalized)) return true;
		if (this.attentionAcceptInFlight.has(normalized)) return true;
		for (const item of this.uploadQueue.values()) {
			if (item.status === "processing" && normalizePath(item.path) === normalized) {
				return true;
			}
		}
		for (const item of this.downloadQueue.values()) {
			if (item.status === "processing" && normalizePath(item.path) === normalized) {
				return true;
			}
		}
		for (const [oldPath, ticket] of this.remoteOverwriteRenameTickets) {
			if (oldPath === normalized || ticket.newPath === normalized) return true;
		}
		return false;
	}

	private suppress(path: string): void {
		this.suppressedPaths.set(path, Date.now() + SUPPRESS_MS);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get pendingUploads(): number {
		return this.uploadQueue.size + this.uploadDebounce.size;
	}

	get pendingDownloads(): number {
		return this.downloadQueue.size;
	}

	/**
	 * Get a human-readable transfer status string, or null if idle.
	 * Examples: "↑2/5", "↓1/3", "↑2/5 ↓1/3"
	 */
	get transferStatus(): string | null {
		const parts: string[] = [];

		const upPending =
			this.pendingUploadCount() +
			this.uploadDebounce.size +
			this.inflightUploads.size;
		if (
			upPending > 0 ||
			this._completedUploads < this._totalUploadsThisCycle
		) {
			parts.push(
				`↑${this._completedUploads}/${this._totalUploadsThisCycle}`,
			);
		}

		const downPending =
			this.pendingDownloadCount() + this.inflightDownloads.size;
		if (
			downPending > 0 ||
			this._completedDownloads < this._totalDownloadsThisCycle
		) {
			parts.push(
				`↓${this._completedDownloads}/${this._totalDownloadsThisCycle}`,
			);
		}

		return parts.length > 0 ? parts.join(" ") : null;
	}

	private pendingUploadCount(): number {
		let count = 0;
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending") count++;
		}
		return count;
	}

	private pendingDownloadCount(): number {
		let count = 0;
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending") count++;
		}
		return count;
	}

	// -------------------------------------------------------------------
	// Queue persistence
	// -------------------------------------------------------------------

	/**
	 * Export a snapshot of pending/processing queues for persistence.
	 * Processing items are restored as pending on load.
	 */
	exportQueue(): BlobQueueSnapshot {
		const uploads: BlobQueueSnapshot["uploads"] = [];
		for (const [, item] of this.uploadQueue) {
			uploads.push({
				path: item.path,
				sizeBytes: item.sizeBytes,
				baseRefKnown: item.baseRefKnown,
				expectedBaseRef: cloneBlobRef(item.expectedBaseRef),
				causalBaseRef: cloneBlobRef(item.causalBaseRef),
				expectedBaseSourceVersion: item.expectedBaseSourceVersion,
				retries: item.retries,
				status: item.status,
				readyAt: item.readyAt,
				attentionResolution: item.attentionResolution,
				needsRerun: item.needsRerun,
				rerunResets: item.rerunResets,
			});
		}
		// Also include items in debounce (not yet in queue but pending)
		for (const [path] of this.uploadDebounce) {
			if (!this.uploadQueue.has(path)) {
				const uploadBase = this.captureUploadBase(path, false);
				uploads.push({
					path,
					baseRefKnown: uploadBase.known,
					expectedBaseRef: cloneBlobRef(uploadBase.ref),
					causalBaseRef: cloneBlobRef(uploadBase.causalBaseRef),
					expectedBaseSourceVersion: uploadBase.sourceVersion,
					retries: 0,
					status: "pending",
					readyAt: 0,
					rerunResets: 0,
				});
			}
		}

		const downloads: BlobQueueSnapshot["downloads"] = [];
		for (const [, item] of this.downloadQueue) {
			const exportingNextTarget = item.nextHash !== undefined;
			downloads.push({
				path: item.path,
				hash: item.nextHash ?? item.hash,
				sizeBytes: exportingNextTarget ? item.nextSizeBytes : item.sizeBytes,
				targetRefFingerprint: exportingNextTarget
					? item.nextTargetRefFingerprint
					: item.targetRefFingerprint,
				acceptableLocalHashes: normalizeAcceptableLocalHashes(
					exportingNextTarget
						? item.nextAcceptableLocalHashes
						: item.acceptableLocalHashes,
				),
				retries: item.retries,
				status: item.status,
				readyAt: item.readyAt,
				needsRerun: exportingNextTarget ? false : item.needsRerun,
				rerunResets: item.rerunResets,
			});
		}

		return { uploads, downloads };
	}

	/**
	 * Restore queues from a persisted snapshot.
	 * Processing items are normalized to pending.
	 */
	importQueue(snapshot: BlobQueueSnapshot): void {
		let restored = 0;
		let skipped = 0;

		if (snapshot.uploads) {
			for (const item of snapshot.uploads) {
				if (!this.isBlobPathSyncable(item.path)) {
					skipped++;
					continue;
				}
				if (!hasValidUploadBaseSourceVersion(item)) {
					// Legacy live-base entries contain only hash/ref equality. Without
					// the exact source Item version they could borrow authority across
					// an H1 -> delete -> H1 ABA episode after restart.
					skipped++;
					continue;
				}
				if (
					!this.uploadQueue.has(item.path) &&
					!this.uploadDebounce.has(item.path)
				) {
					const persistedBase = cloneBlobRef(item.expectedBaseRef);
					const persistedCausalBase = cloneBlobRef(item.causalBaseRef);
					// Preserve the persisted proof verbatim while the startup gate is
					// closed. processUpload validates it against the fully loaded current
					// ref, tombstone episode, causal base, and settled ref after opening.
					const baseRefKnown = item.baseRefKnown === true;
					this.uploadQueue.set(item.path, {
						path: item.path,
						sizeBytes: item.sizeBytes,
						baseRefKnown,
							expectedBaseRef: baseRefKnown ? persistedBase : undefined,
							causalBaseRef: baseRefKnown ? persistedCausalBase : undefined,
							expectedBaseSourceVersion: baseRefKnown
								? item.expectedBaseSourceVersion
								: undefined,
						retries: item.retries ?? 0,
						status: "pending",
						readyAt: 0,
						generation: this.currentTransferGeneration(item.path),
						attentionResolution: item.attentionResolution,
						needsRerun: item.needsRerun ?? false,
						rerunResets: item.rerunResets ?? 0,
					});
					restored++;
				}
			}
		}

		if (snapshot.downloads) {
			for (const item of snapshot.downloads) {
				if (!this.isBlobPathSyncable(item.path)) {
					skipped++;
					continue;
				}
				const canValidateRemoteRef = typeof this.vaultSync.getBlobRef === "function";
				const currentRef = canValidateRemoteRef
					? this.vaultSync.getBlobRef(item.path)
					: undefined;
				if (canValidateRemoteRef && (
					!currentRef
					|| currentRef.hash !== item.hash
				)) {
					// Persisted downloads are only hints. Never restore bytes for a
					// deleted path or for a superseded content hash.
					skipped++;
					continue;
				}
				if (!this.downloadQueue.has(item.path)) {
					const persistedAcceptableLocalHashes =
						normalizeAcceptableLocalHashes(item.acceptableLocalHashes);
					const authoritativePriorHashes = currentRef
						? new Set(getBlobRefPriorHashes(currentRef))
						: null;
					this.downloadQueue.set(item.path, {
						path: item.path,
						hash: item.hash,
						sizeBytes: item.sizeBytes,
						targetRefFingerprint: currentRef
							? blobRefFingerprint(currentRef)
							: item.targetRefFingerprint,
						acceptableLocalHashes: authoritativePriorHashes
							? persistedAcceptableLocalHashes.filter(
								(hash) => authoritativePriorHashes.has(hash),
							)
							: persistedAcceptableLocalHashes,
						retries: item.retries ?? 0,
						status: "pending",
						readyAt: 0,
						generation: this.currentTransferGeneration(item.path),
						needsRerun: item.needsRerun ?? false,
						rerunResets: item.rerunResets ?? 0,
					});
					restored++;
				}
			}
		}

		if (restored > 0) {
			this.log(`importQueue: restored ${restored} pending transfers`);
			if (this.uploadQueue.size > 0) this.kickUploadDrain();
			if (this.downloadQueue.size > 0) this.kickDownloadDrain();
		}
		if (skipped > 0) {
			this.log(`importQueue: skipped ${skipped} excluded transfers`);
		}
	}

	openDownloadGate(reason: string): void {
		if (this.downloadGateOpen) return;
		this.downloadGateOpen = true;
		this.log(`Download gate opened (${reason})`);
		const deferredDeletes = Array.from(this.deferredRemoteDeletePaths);
		this.deferredRemoteDeletePaths.clear();
		for (const path of deferredDeletes) {
			this.scheduleRemoteDelete(path);
		}
		if (this.downloadQueue.size > 0) {
			this.log(
				`Download gate: draining ${this.downloadQueue.size} queued downloads`,
			);
		}
		this.kickDownloadDrain();
	}

	setInventoryGateReady(ready: boolean, reason: string): void {
		if (this.inventoryGateReady === ready) return;
		this.inventoryGateReady = ready;
		this.trace?.("blob", ready
			? "blob-inventory-layout-ready"
			: "blob-inventory-layout-blocked", { reason });
	}

	closeDownloadGate(reason: string): void {
		if (!this.downloadGateOpen) return;
		this.downloadGateOpen = false;
		for (const path of this.remoteDeleteInFlight.keys()) {
			this.deferredRemoteDeletePaths.add(path);
		}
		this.log(`Download gate closed (${reason})`);
		this.trace?.("blob", "download-gate-closed", {
			reason,
			inflightDownloads: this.inflightDownloads.size,
			pendingDownloads: this.pendingDownloads,
		});
	}

	openUploadGate(reason: string): void {
		if (this.uploadGateOpen) return;
		this.uploadGateOpen = true;
		this.log(`Upload gate opened (${reason})`);
		if (this.uploadQueue.size > 0) {
			this.log(
				`Upload gate: revalidating ${this.uploadQueue.size} queued uploads`,
			);
		}
		// processUpload revalidates the exact current ref, settled base, tombstone,
		// Attention episode, TFile identity, and bytes after this gate opens.
		this.kickUploadDrain();
	}

	closeUploadGate(reason: string): void {
		if (!this.uploadGateOpen) return;
		this.uploadGateOpen = false;
		this.log(`Upload gate closed (${reason})`);
		this.trace?.("blob", "upload-gate-closed", {
			reason,
			inflightUploads: this.inflightUploads.size,
			pendingUploads: this.pendingUploads,
		});
	}

	private dropExcludedQueuedDownload(path: string, source: string): void {
		if (!this.downloadQueue.delete(path)) return;
		this.log(`download: dropped excluded path "${path}" (${source})`);
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	async destroy(): Promise<void> {
		this.destroyed = true;
		this.uploadGateOpen = false;
		this.downloadGateOpen = false;
		for (const cleanup of this.observerCleanups) {
			cleanup();
		}
		this.observerCleanups = [];

		for (const timer of this.uploadDebounce.values()) {
			clearTimeout(timer);
		}
		this.uploadDebounce.clear();
		for (const timer of this.retryTimers.values()) {
			clearTimeout(timer);
		}
		this.retryTimers.clear();

		this.uploadQueue.clear();
		this.downloadQueue.clear();
		await Promise.allSettled([
			...this.activeTransferPromises,
			...this.activeRemoteDeletePromises,
		]);
		this.activeTransferPromises.clear();
		this.activeRemoteDeletePromises.clear();
		this.inflightUploads.clear();
		this.inflightDownloads.clear();
		this.suppressedPaths.clear();
		this.localOnlyBlobConflictPaths.clear();
		this.remoteOverwriteRenameTickets.clear();
		this.remoteDeleteInFlight.clear();
		this.deferredRemoteDeletePaths.clear();
		this.attentionAcceptInFlight.clear();
		for (const waiters of this.transferSettleWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.transferSettleWaiters.clear();
		this.transferGenerations.clear();
		this.preservedUnresolved.clear();
		this.log("BlobSyncManager destroyed");
	}

	getDebugSnapshot(): {
		pendingUploads: number;
		pendingDownloads: number;
		processingUploads: number;
		processingDownloads: number;
		uploadDraining: boolean;
		downloadDraining: boolean;
		uploadGateOpen: boolean;
		downloadGateOpen: boolean;
		suppressedCount: number;
		permanentUploadFailures: number;
		permanentDownloadFailures: number;
		blobConflictArtifacts: number;
		localOnlyBlobConflictPaths: number;
		preservedUnresolved: ReturnType<PreservedUnresolvedRegistry["getSummary"]>;
		uploadQueue: string[];
		downloadQueue: string[];
		inflightUploads: string[];
		inflightDownloads: string[];
	} {
		return {
			pendingUploads: this.pendingUploadCount(),
			pendingDownloads: this.pendingDownloadCount(),
			processingUploads: this.inflightUploads.size,
			processingDownloads: this.inflightDownloads.size,
			uploadDraining: this.uploadDraining,
			downloadDraining: this.downloadDraining,
			uploadGateOpen: this.uploadGateOpen,
			downloadGateOpen: this.downloadGateOpen,
			suppressedCount: this.suppressedPaths.size,
			permanentUploadFailures: this._permanentUploadFailures,
			permanentDownloadFailures: this._permanentDownloadFailures,
			blobConflictArtifacts: this._blobConflictArtifacts,
			localOnlyBlobConflictPaths: this.localOnlyBlobConflictPaths.size,
			preservedUnresolved: this.preservedUnresolved.getSummary(),
			uploadQueue: Array.from(this.uploadQueue.values())
				.filter((item) => item.status === "pending")
				.map((item) => item.path),
			downloadQueue: Array.from(this.downloadQueue.values())
				.filter((item) => item.status === "pending")
				.map((item) => item.path),
			inflightUploads: Array.from(this.inflightUploads),
			inflightDownloads: Array.from(this.inflightDownloads),
		};
	}

	private log(msg: string): void {
		this.trace?.("blob", msg);
		if (this.debug) {
			console.debug(`[kaos:blob] ${msg}`);
		}
	}

	get isDownloadGateOpen(): boolean {
		return this.downloadGateOpen;
	}

	get isUploadGateOpen(): boolean {
		return this.uploadGateOpen;
	}
}
