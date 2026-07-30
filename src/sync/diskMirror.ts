import { type App, arrayBufferToHex, MarkdownView, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import type { TraceRecord } from "../observability/traceContext";
import { getMetaPath, isFileMetaDeletedValue } from "./fileMeta";
import { formatUnknown, yTextToString } from "../utils/format";
import {
	isFrontmatterBlocked,
	validateCrdtDocumentTransition,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";
import { isLocalOrigin } from "./origins";
import { contentBaselineHash } from "./diskIndex";
import type {
	EditorAuthorityLease,
	PathEditorAuthority,
} from "./pathEditorAuthority";
import {
	PreservedUnresolvedRegistry,
	getPreservedUnresolvedEpisodeId,
	getRemoteDeleteEpisodeId,
	isRemoteDeletePreservedUnresolvedEntry,
	type PreservedUnresolvedEntry,
	type PreservedUnresolvedReason,
} from "./preservedUnresolved";
export { isLocalOrigin };

/**
 * Three-way decision for remote-delete handling.
 * Discriminated union — NOT a boolean dirty flag.
 */
export type RemoteDeleteDecision =
	| { kind: "apply-delete" }
	| { kind: "preserve-revive"; diskContent: string; contentSource?: "disk" | "editor" }
	| { kind: "preserve-unresolved" };

export type DiskWriteDeferReason =
	| "missing-ytext"
	| "path-excluded"
	| "remote-projection-not-ready"
	| "same-path-adoption-active"
	| "open-editor-mismatch"
	| "active-editor-unflushed"
	| "recent-editor-activity"
	| "disk-changed-during-write"
	| "crdt-changed-during-write"
	| "authority-stale";

export type DiskWriteAuthorityPhase = "before-commit" | "after-commit";

/**
 * Immutable authority captured when provider work is admitted.
 *
 * The closure must bind the VaultSync identity, provider generation, and the
 * gate's close epoch. A later close/open cycle therefore cannot make this
 * operation current again even when the visible CRDT state is identical.
 */
export interface RemoteProjectionAdmissionLease {
	readonly isCurrent: () => boolean;
	/**
	 * Enter the provider epoch's async filesystem commit section.
	 *
	 * When present, the policy gate will hold a later generation closed until
	 * the returned release function is called.
	 */
	readonly enterCriticalSection?: () => (() => void) | null;
}

export type DiskWriteResult =
	| {
		kind: "written";
		path: string;
		isCreate: boolean;
		content: string;
		contentHash: string;
		baselineRecorded: boolean;
	}
	| { kind: "unchanged"; path: string; content: string; contentHash: string }
	| { kind: "deferred"; path: string; reason: DiskWriteDeferReason }
	| { kind: "blocked"; path: string; reason: "frontmatter" | "preserved-unresolved" }
	| { kind: "failed"; path: string; error: string };

export type PreservedUnresolvedRedirectResult =
	| { kind: "missing" }
	| { kind: "unchanged"; entry: PreservedUnresolvedEntry }
	| { kind: "target-only"; entry: PreservedUnresolvedEntry }
	| { kind: "moved"; entry: PreservedUnresolvedEntry }
	| {
		kind: "collision";
		source: PreservedUnresolvedEntry;
		target: PreservedUnresolvedEntry;
	};

export interface DiskFileRevision {
	ctime: number;
	mtime: number;
	size: number;
}

export interface DiskWriteOptions {
	/**
	 * Exact provider-generation lease captured by the observer or reconciliation
	 * planner that admitted this CRDT-to-disk operation.
	 */
	remoteProjectionAdmission?: RemoteProjectionAdmissionLease;
	/**
	 * Marks a CRDT-to-disk write that originated from provider projection or
	 * authoritative reconciliation. Local restore/editor settlement callers do
	 * not set this flag and therefore do not depend on provider policy readiness.
	 */
	requireRemoteProjectionAdmission?: boolean;
	/**
	 * Whether a successful write should immediately advance the persisted
	 * baseline. Conflict winners pass false so the next reconcile must first
	 * observe disk == CRDT before teaching the disk index that the state is clean.
	 */
	recordBaseline?: boolean;
	/**
	 * Disk content on which the caller based its authority decision.
	 *
	 * When supplied, `flushWrite` behaves like a compare-and-swap: an existing
	 * file is changed only while it still contains this exact snapshot. A
	 * mismatch is deferred so the caller can re-read and re-plan instead of
	 * overwriting a newer local edit.
	 */
	expectedDiskContent?: string;
	/**
	 * Exact Obsidian file object against which the caller planned an existing-file
	 * write. Obsidian replaces the `TFile` object when a path is deleted and
	 * recreated, so this closes the identical-bytes ABA case that content CAS
	 * alone cannot distinguish.
	 *
	 * This is intentionally optional: ordinary provider/reconciliation writes
	 * continue to use content/baseline authority, while explicit restore flows
	 * carry the file identity captured during their safety backup.
	 */
	expectedDiskFile?: TFile;
	/**
	 * Immutable stat revision captured with `expectedDiskFile`. This closes the
	 * same-TFile ABA gap where local bytes are changed and changed back while an
	 * explicit compare-and-swap write is waiting on the per-path promise lock.
	 */
	expectedDiskRevision?: DiskFileRevision;
	/**
	 * Explicit authority to create a path that was expected to be missing.
	 * If any file appears before commit, the operation is deferred rather than
	 * repurposed into an overwrite.
	 * Use only for operations whose intent is itself a create/undelete (for
	 * example a user-confirmed snapshot restore), never as a generic retry flag.
	 */
	allowCreateIfMissing?: boolean;
	/**
	 * Optional controller-owned optimistic authority lease.
	 *
	 * DiskMirror does not interpret editor, baseline, or merge semantics. It only
	 * asks the synchronous predicate whether the caller's original decision is
	 * still admissible. A false return or throw fails closed before bytes/baseline
	 * publication. `after-commit` permits the caller to account for the stat change
	 * caused by DiskMirror's own atomic write while retaining every other fence.
	 */
	isAuthorityCurrent?: (phase: DiskWriteAuthorityPhase) => boolean;
	/**
	 * Exact controller-owned exception for the one forced flush that settles a
	 * bound same-path adoption. Ordinary queued/forced projections never receive
	 * this capability and remain held for the full adoption lifetime.
	 */
	isSamePathAdoptionSettlementCurrent?: () => boolean;
}

type ExistingFileWriteAbortReason =
	| "already-current"
	| "disk-changed"
	| "file-identity-changed"
	| "file-revision-changed"
	| "crdt-changed"
	| "remote-delete-active"
	| "preserved-unresolved"
	| "open-write-deferred"
	| "authority-stale";

class ExistingFileWriteAborted extends Error {
	constructor(readonly reason: ExistingFileWriteAbortReason) {
		super(`Existing file write aborted: ${reason}`);
		this.name = "ExistingFileWriteAborted";
	}
}

type DiskWriteEditorAuthorityState = {
	authority: PathEditorAuthority;
};

type DiskWriteRuntimeOptions = DiskWriteOptions & {
	readonly editorAuthorityState: DiskWriteEditorAuthorityState;
};

/**
 * Handles writeback from Y.Text -> disk with:
 *   - Remote-only writes (skip local yCollab/seed/disk-sync origins)
 *   - Lazy per-file Y.Text observers
 *   - Concurrency-limited write queue (prevents burst I/O on git pull)
 *   - Loop suppression via timed path suppression
 */

const DEBOUNCE_MS = 300;
const DEBOUNCE_BURST_MS = 1000;
const OPEN_FILE_IDLE_MS = 1500;
const OPEN_FILE_ACTIVE_GRACE_MS = 1200;
const SUPPRESS_MS = 500;
const RECENT_WRITE_FINGERPRINT_MS = 5000;
const RECENT_WRITE_FINGERPRINT_MAX_ENTRIES = 200;
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;
const REMOTE_CREATE_AUTHORIZATION_MS = 30_000;

function describeOrigin(origin: unknown, provider: unknown): string {
	if (origin === provider) return "provider-remote";
	if (typeof origin === "string") return origin;
	if (origin == null) return "null";
	if (typeof origin === "object") {
		const constructorName =
			(origin as { constructor?: { name?: string } }).constructor?.name;
		return constructorName || "object";
	}
	return formatUnknown(origin);
}

interface SuppressionEntry {
	kind: "write" | "delete";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
	token?: object;
}

interface RecentWriteFingerprint {
	recordedAt: number;
	expectedBytes: number;
	expectedHash: string;
	token: object;
}

export interface LocalCreateSuppressionHandle {
	readonly path: string;
	readonly token: object;
}

export interface ObservedDiskMutationRevision {
	path: string;
	ctime: number | null;
	mtime: number | null;
	size: number | null;
}

export type RecentWriteFingerprintProbe =
	| { kind: "self-write"; content: string }
	| { kind: "not-self-write"; content: string }
	| { kind: "unproven"; content: string }
	| { kind: "stale-or-unreadable" };

interface PendingRemoteRename {
	oldPath: string;
	newPath: string;
	file: TFile;
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}

/**
 * Obsidian's document read boundary removes one leading UTF-8 BOM, while the
 * adapter-backed Vault.process callback receives the raw text. Keep the atomic
 * CAS exact apart from that single host representation difference; line endings
 * and every other character remain part of the precondition.
 */
function rawContentMatchesVaultReadSnapshot(rawContent: string, snapshot: string): boolean {
	return rawContent === snapshot || (
		rawContent.charCodeAt(0) === 0xfeff && rawContent.slice(1) === snapshot
	);
}

export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/**
	 * Tracks the exact physical rename issued by DiskMirror in response to
	 * remote metadata. A destination-only token can survive a delayed/missing
	 * event and then swallow an unrelated local rename into the same path, so
	 * the source, destination, and renamed TFile epoch are all part of the key.
	 */
	private pendingRemoteRenames = new Map<string, PendingRemoteRename>();

	/**
	 * Consume the remote-rename marker only when the vault event describes the
	 * exact physical operation issued by DiskMirror.
	 * Returns true if the rename was DiskMirror-originated (passive receiver).
	 * Removes the marker atomically — safe to call from the vault rename handler.
	 *
	 * @internal Used by main.ts vault rename handler.
	 */
	consumeRemoteRename(oldPath: string, newPath: string, file: TFile): boolean {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		const pending = this.pendingRemoteRenames.get(newNormalized);
		if (
			!pending
			|| pending.oldPath !== oldNormalized
			|| pending.newPath !== newNormalized
			|| pending.file !== file
		) {
			return false;
		}
		this.pendingRemoteRenames.delete(newNormalized);
		return true;
	}

	private retirePendingRemoteRename(
		oldPath: string,
		newPath: string,
		file: TFile,
	): void {
		const newNormalized = normalizePath(newPath);
		const pending = this.pendingRemoteRenames.get(newNormalized);
		if (
			pending?.oldPath === normalizePath(oldPath)
			&& pending.newPath === newNormalized
			&& pending.file === file
		) {
			this.pendingRemoteRenames.delete(newNormalized);
		}
	}

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();

	/**
	 * Paths where a remote-delete was received but no baseline was available
	 * to verify local state. These files were preserved on disk to avoid data
	 * loss, but must NOT be auto-revived by later import/scan passes.
	 *
	 * A path is removed from this set when:
	 * - The user explicitly edits/creates the file (vault modify/create event)
	 * - The file is deleted locally by the user
	 * - A future remote-delete arrives with a real baseline
	 *
	 * This prevents `importUntrackedFiles()` or reconcile scans from
	 * accidentally resurrecting a legitimately deleted file.
	 */
	private preservedUnresolved: PreservedUnresolvedRegistry;
	readonly preservedUnresolvedPaths: ReadonlySet<string>;
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private openWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingOpenWrites = new Set<string>();
	/** True while the drain loop is running. */
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	private pathWriteLocks = new Map<string, Promise<unknown>>();
	/** Invalidates an older async delete whenever a newer delete/revival arrives. */
	private remoteDeleteGenerations = new Map<string, number>();
	/** Short-lived authority granted only by a semantic remote add/revival. */
	private remoteCreateAuthorizations = new Map<string, number>();

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();

	private mapObserverCleanups: (() => void)[] = [];

	private _flightEventHandler: ((event: Record<string, unknown>) => void) | null = null;

	/**
	 * Called after every successful `flushWrite` with the normalized path and
	 * the SHA-256 content hash of what was written.
	 *
	 * The hash is pre-computed here (where the content is in scope) to keep
	 * the caller free of crypto concerns. Use to update disk index baselines.
	 */
	private _onDiskWriteCallback:
		| ((path: string, contentHash: string, content: string) => boolean | void)
		| null = null;
	/**
	 * Supplies the durable clean-settlement hash for a path. When production
	 * configures this provider, an unplanned CRDT write may adopt the current
	 * disk snapshot only after proving it still matches that baseline.
	 */
	private diskBaselineHashProvider: ((path: string) => string | null | undefined) | null = null;
	/**
	 * Resolves the text that belongs to the durable hash above. Remote-delete
	 * cleanliness must be compared with the last verified disk settlement, not
	 * with the tombstoned Y.Text (which may already contain a newer remote edit).
	 */
	private diskBaselineTextProvider:
		| ((path: string) => Promise<string | null> | string | null)
		| null = null;

	/**
	 * Per-path timestamp of the most recent successful `flushWrite`. Updated
	 * on every `vault.modify` and `vault.create` we issue. Read by the main
	 * vault.on("modify") handler so `disk.modify.observed` events can carry
	 * a writerGuess (kaos-write vs external) for diagnostics.
	 */
	private lastDiskWriteOkAt = new Map<string, number>();
	/**
	 * Short-lived, non-consuming proof of the content KAOS most recently meant
	 * to write. The editor reload guard uses this only to disambiguate a real
	 * external write that lands inside the normal self-write suppression window.
	 */
	private recentWriteFingerprints = new Map<string, RecentWriteFingerprint>();
	/** Supplied by the plugin; DiskMirror does not own sync-path policy. */
	private isMarkdownPathSyncable: (path: string) => boolean = () => true;
	/** Separate from syncability so provider bootstrap never blocks local ingress. */
	private isRemoteProjectionAllowed: (path: string) => boolean = () => true;
	private isSamePathAdoptionProjectionHeld: (path: string) => boolean = () => false;
	private captureRemoteProjectionAdmissionProvider:
		(paths: readonly string[]) => RemoteProjectionAdmissionLease | null =
			(paths) => paths.every((path) => this.isRemoteProjectionAllowed(path))
				? { isCurrent: () => paths.every((path) => this.isRemoteProjectionAllowed(path)) }
				: null;
	/** Exact queue provenance retained across debounce and open-editor deferrals. */
	private remoteProjectionWriteAdmissions =
		new Map<string, RemoteProjectionAdmissionLease>();

	private readonly debug: boolean;

	constructor(
		private app: App,
		private vaultSync: VaultSync,
		private editorBindings: EditorBindingManager,
		debug: boolean,
		private trace?: TraceRecord,
		private frontmatterGuardEnabled: () => boolean = () => true,
		private onFrontmatterValidated?: (
			path: string,
			direction: "crdt-to-disk",
			reason: "flush-write",
			validation: FrontmatterValidationResult,
			previousContent: string | null,
			nextContent: string,
		) => void,
		private getDeviceName: () => string = () => "unknown-device",
		initialPreservedUnresolved: PreservedUnresolvedEntry[] = [],
		private onPreservedUnresolvedChanged?: () => void,
	) {
		this.debug = debug;
		this.preservedUnresolved = new PreservedUnresolvedRegistry(
			initialPreservedUnresolved.filter((entry) => entry.kind === "markdown"),
		);
		this.preservedUnresolvedPaths = this.preservedUnresolved.paths;
	}

	setFlightEventHandler(handler: (event: Record<string, unknown>) => void): void {
		this._flightEventHandler = handler;
	}

	/**
	 * Register a callback that fires after every successful `flushWrite`.
	 * The callback receives the normalized path and the SHA-256 hash of the
	 * content written (pre-computed in diskMirror to avoid redundant re-reads).
	 * Use this to update content-hash baselines in the disk index.
	 */
	setDiskWriteCallback(
		callback: (path: string, contentHash: string, content: string) => boolean | void,
	): void {
		this._onDiskWriteCallback = callback;
	}

	setDiskBaselineHashProvider(
		provider: (path: string) => string | null | undefined,
	): void {
		this.diskBaselineHashProvider = provider;
	}

	setDiskBaselineTextProvider(
		provider: (path: string) => Promise<string | null> | string | null,
	): void {
		this.diskBaselineTextProvider = provider;
	}

	setSamePathAdoptionProjectionHoldPredicate(
		predicate: (path: string) => boolean,
	): void {
		this.isSamePathAdoptionProjectionHeld = predicate;
	}

	setMarkdownPathSyncabilityPredicate(predicate: (path: string) => boolean): void {
		this.isMarkdownPathSyncable = predicate;
	}

	setRemoteProjectionAdmissionPredicate(predicate: (path: string) => boolean): void {
		this.isRemoteProjectionAllowed = predicate;
		this.captureRemoteProjectionAdmissionProvider = (paths) =>
			paths.every((path) => predicate(path))
				? { isCurrent: () => paths.every((path) => predicate(path)) }
				: null;
	}

	setRemoteProjectionAdmissionProvider(
		provider: (paths: readonly string[]) => RemoteProjectionAdmissionLease | null,
	): void {
		this.captureRemoteProjectionAdmissionProvider = provider;
	}

	captureRemoteProjectionAdmission(
		paths: readonly string[],
	): RemoteProjectionAdmissionLease | null {
		const normalizedPaths = paths.map((path) => normalizePath(path));
		try {
			return this.captureRemoteProjectionAdmissionProvider(normalizedPaths);
		} catch {
			return null;
		}
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------

	startMapObservers(): void {
		// ---------------------------------------------------------------
		// Semantic metadata observer.
		//
		// Subscribes to pre-classified MetaSemanticChange events from
		// VaultSync.observeMetaChanges(), which is powered by observeDeep
		// internally. This correctly fires for both flat (v2) object
		// replacements AND nested Y.Map field mutations (v3), where a
		// shallow meta.observe() would have silently dropped the event.
		// ---------------------------------------------------------------
		const unsubscribeMetaChanges = this.vaultSync.observeMetaChanges((batch) => {
			// Only react to remote changes. Local metadata writes (disk sync,
			// seed, restore) must not feed back into DiskMirror as remote events.
			if (batch.isLocal) return;

			for (const change of batch.changes) {
				switch (change.kind) {
					case "deleted": {
						const path = normalizePath(change.path);
						this.remoteCreateAuthorizations.delete(path);
						// Do not use the current tombstoned Y.Text as the baseline here.
						// A remote transaction may edit B and delete immediately while the
						// clean local disk still contains A. Comparing A with B would falsely
						// classify A as local-dirty and revive it, undoing both remote intents.
						void this.handleRemoteDelete(path);
						break;
					}
					case "revived": {
						const path = normalizePath(change.path);
						this.bumpRemoteDeleteGeneration(path);
						this.authorizeRemoteCreate(path);
						this.scheduleRemoteWrite(path);
						break;
					}
					case "path-changed": {
						// Only rename on disk when the entry is active.
						// Tombstone path changes (e.g. from migrateSchemaToV2) must not
						// trigger a disk rename — there is no live file to rename.
						if (!change.isDeleted) {
							void this.handleRemoteRename(
								change.fileId,
								normalizePath(change.previousPath),
								normalizePath(change.nextPath),
							);
						}
						break;
					}
					case "added": {
						// New file received from remote — schedule write if active.
						if (!change.next.deletedAt && !change.next.deleted) {
							const path = normalizePath(change.next.path);
							this.bumpRemoteDeleteGeneration(path);
							this.authorizeRemoteCreate(path);
							this.scheduleRemoteWrite(path);
						}
						break;
					}
					// mtime-changed, device-changed, removed, invalid:
					// no disk side effect needed.
				}
			}
		});
		this.mapObserverCleanups.push(unsubscribeMetaChanges);

		// ---------------------------------------------------------------
		// afterTransaction: catch remote content edits to CLOSED files.
		//
		// Per-file Y.Text observers only cover open files. When a remote
		// device edits a note that is closed locally, the Y.Text changes
		// in memory but nothing writes it to disk. This handler inspects
		// every non-local transaction for changed Y.Text instances,
		// reverse-maps them to paths, and schedules writes for any path
		// that doesn't already have a per-file observer (i.e. closed).
		// ---------------------------------------------------------------
		const afterTxnHandler = (txn: Y.Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;

			for (const [changedType] of txn.changed) {
				if (!(changedType instanceof Y.Text)) continue;

				// Reverse lookup: find the fileId that owns this Y.Text
				const fileId = this.findFileIdForText(changedType);
				if (!fileId) continue;

				// Map fileId → path via meta (pathToId is path→id, not id→path)
				const metaValue = this.vaultSync.meta.get(fileId);
				if (!metaValue || isFileMetaDeletedValue(metaValue)) continue;

				const path = getMetaPath(metaValue);
				if (!path) continue;

				// Skip if this path is already open (handled by per-file observer policy)
				if (this.openPaths.has(path)) continue;

				this.log(`afterTxn: remote content change to closed file "${path}"`);
				this.scheduleRemoteWrite(path);
			}
		};
		this.vaultSync.ydoc.on("afterTransaction", afterTxnHandler);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.ydoc.off("afterTransaction", afterTxnHandler),
		);

		this.log("Map observers started");
	}

	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */
	private findFileIdForText(ytext: Y.Text): string | null {
		// Fast path: WeakMap lookup
		const cached = this.vaultSync.getFileIdForText(ytext);
		if (cached) return cached;

		// Slow fallback: scan idToText (should rarely happen)
		for (const [fileId, text] of this.vaultSync.idToText.entries()) {
			if (text === ytext) return fileId;
		}
		return null;
	}

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileOpened", { path });
		this.openPaths.add(path);
		if (this.writeQueue.delete(path)) {
			this.forcedWritePaths.delete(path);
			this.scheduleOpenWrite(path);
		}
		const closedTimer = this.debounceTimers.get(path);
		if (closedTimer) {
			clearTimeout(closedTimer);
			this.debounceTimers.delete(path);
			this.writeQueue.delete(path);
			this.scheduleOpenWrite(path);
		}
		this.observeText(path);
	}

	notifyFileClosed(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileClosed", { path });
		this.openPaths.delete(path);
		// Flush any pending debounce for this path
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer) {
			clearTimeout(openTimer);
			this.openWriteTimers.delete(path);
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		} else if (this.pendingOpenWrites.delete(path)) {
			this.queueImmediateWrite(path, "file-closed");
		}
		this.unobserveText(path);
	}

	private observeText(path: string): void {
		if (this.textObservers.has(path)) return;

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) return;

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;
			const originLabel = describeOrigin(txn.origin, this.vaultSync.provider);
			this.log(`text observer: remote change to "${path}" (origin=${originLabel})`);
			this.scheduleRemoteWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.log(`observeText: watching "${path}" (remote-only)`);
	}

	private unobserveText(path: string): void {
		const obs = this.textObservers.get(path);
		if (obs) {
			obs.ytext.unobserve(obs.handler);
			this.textObservers.delete(path);
			this.log(`unobserveText: stopped watching "${path}"`);
		}
	}

	/** Set of currently observed paths (for external cleanup). */
	getObservedPaths(): Set<string> {
		return new Set(this.textObservers.keys());
	}

	// -------------------------------------------------------------------
	// Write scheduling (debounce + concurrency-limited queue)
	// -------------------------------------------------------------------

	private scheduleRemoteWrite(path: string): void {
		path = normalizePath(path);
		const admission = this.captureRemoteProjectionAdmission([path]);
		if (!admission) {
			this.log(`scheduleRemoteWrite: policy not ready for "${path}"`);
			return;
		}
		if (!this.isMarkdownPathSyncable(path)) {
			this.scheduleWrite(path);
			return;
		}
		this.remoteProjectionWriteAdmissions.set(path, admission);
		this.scheduleWrite(path);
	}

	scheduleWrite(path: string): void {
		path = normalizePath(path);
		if (!this.isMarkdownPathSyncable(path)) {
			this.log(`scheduleWrite: skipping excluded path "${path}"`);
			return;
		}
		if (this.isPreservedUnresolved(path)) {
			this.log(`scheduleWrite: skipping preserved-unresolved path "${path}"`);
			this.trace?.("disk", "disk-write-schedule-skipped-preserved-unresolved", { path });
			return;
		}
		if (this.openPaths.has(path) || this.isOpenInWorkspace(path)) {
			this.scheduleOpenWrite(path);
			return;
		}

		this.scheduleClosedWrite(path);
	}

	private scheduleClosedWrite(path: string): void {
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
					void this.kickDrain();
			}, delay),
		);
	}

	private scheduleOpenWrite(path: string): void {
		path = normalizePath(path);
		if (!this.isMarkdownPathSyncable(path)) {
			this.log(`scheduleOpenWrite: skipping excluded path "${path}"`);
			return;
		}
		if (this.isPreservedUnresolved(path)) {
			this.log(`scheduleOpenWrite: skipping preserved-unresolved path "${path}"`);
			this.trace?.("disk", "disk-write-schedule-skipped-preserved-unresolved", { path });
			return;
		}
		this.pendingOpenWrites.add(path);

		const existing = this.openWriteTimers.get(path);
		if (existing) clearTimeout(existing);

		this.openWriteTimers.set(
			path,
				setTimeout(() => {
					this.openWriteTimers.delete(path);
					if (!this.pendingOpenWrites.has(path)) return;

					const ytext = this.vaultSync.getTextForPath(path);
					const crdtContent = yTextToString(ytext);
					if (this.hasUnprovenScheduledEditorAuthority(path, crdtContent)) {
						this.log(`open-write: deferring "${path}" (active editor has unflushed changes)`);
						this.scheduleOpenWrite(path);
						return;
					}

				if (this.hasRecentEditorActivity(path)) {
					this.log(`open-write: deferring "${path}" (recent editor activity)`);
					this.scheduleOpenWrite(path);
					return;
				}

				this.pendingOpenWrites.delete(path);
				this.writeQueue.add(path);
				void this.kickDrain();
			}, OPEN_FILE_IDLE_MS),
		);
	}

	/** Start the drain loop if not already running. */
	private kickDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
		});
		return this.drainPromise;
	}

	/**
	 * Drain the write queue with bounded concurrency.
	 * Processes up to MAX_CONCURRENT_WRITES in parallel, then loops.
	 */
	private async drain(): Promise<void> {
		this.draining = true;

		try {
			while (this.writeQueue.size > 0) {
				// If the queue is very deep, log a warning and pause briefly
				if (this.writeQueue.size > BURST_THRESHOLD) {
					this.log(`drain: ${this.writeQueue.size} writes queued (burst), cooling down 200ms`);
					await new Promise((r) => setTimeout(r, 200));
				}

				// Take up to MAX_CONCURRENT_WRITES from the queue
				const batch: string[] = [];
				for (const path of this.writeQueue) {
					batch.push(path);
					if (batch.length >= MAX_CONCURRENT_WRITES) break;
				}
				for (const path of batch) {
					this.writeQueue.delete(path);
				}

				// Execute writes in parallel
				await Promise.all(
					batch.map((path) => {
						const force = this.forcedWritePaths.delete(path);
						const remoteProjectionAdmission =
							this.remoteProjectionWriteAdmissions.get(path);
						if (remoteProjectionAdmission) {
							this.remoteProjectionWriteAdmissions.delete(path);
						}
						return this.flushWrite(path, force, {
							requireRemoteProjectionAdmission:
								remoteProjectionAdmission !== undefined,
							remoteProjectionAdmission,
						});
					}),
				);
			}
		} finally {
			this.draining = false;
		}
	}

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	private shouldHoldSamePathAdoptionProjection(
		path: string,
		options: DiskWriteOptions,
	): boolean {
		let held = true;
		try {
			held = this.isSamePathAdoptionProjectionHeld(normalizePath(path));
		} catch {
			// A broken hold predicate fails closed.
		}
		if (!held) return false;
		try {
			return options.isSamePathAdoptionSettlementCurrent?.() !== true;
		} catch {
			return true;
		}
	}

	async flushWrite(
		path: string,
		force = false,
		options: DiskWriteOptions = {},
	): Promise<DiskWriteResult> {
		path = normalizePath(path);
		if (!this.isMarkdownPathSyncable(path)) {
			this.log(`flushWrite: skipping excluded path "${path}"`);
			return { kind: "deferred", path, reason: "path-excluded" };
		}
		if (this.shouldHoldSamePathAdoptionProjection(path, options)) {
			this.log(`flushWrite: deferring "${path}" (same-path adoption active)`);
			return { kind: "deferred", path, reason: "same-path-adoption-active" };
		}
		const remoteProjectionAdmission =
			options.remoteProjectionAdmission ??
			(options.requireRemoteProjectionAdmission === true
				? this.captureRemoteProjectionAdmission([path])
				: undefined);
		const effectiveOptions: DiskWriteRuntimeOptions = {
			...options,
			...(remoteProjectionAdmission ? { remoteProjectionAdmission } : {}),
			editorAuthorityState: {
				authority: this.capturePathEditorAuthority(path),
			},
		};
		if (
			options.requireRemoteProjectionAdmission === true &&
			(!remoteProjectionAdmission || !this.isRemoteProjectionAdmissionCurrent(
				remoteProjectionAdmission,
			))
		) {
			this.log(`flushWrite: remote projection policy not ready for "${path}"`);
			return { kind: "deferred", path, reason: "remote-projection-not-ready" };
		}
		return this.runPathWriteLocked(
			path,
			() => this.flushWriteUnlocked(path, force, effectiveOptions),
		);
	}

	private async flushWriteUnlocked(
		path: string,
		force: boolean,
		options: DiskWriteRuntimeOptions,
	): Promise<DiskWriteResult> {
		const normalized = normalizePath(path);
		if (this.isPreservedUnresolved(normalized)) {
			return this.blockPreservedUnresolvedWrite(normalized, "preflight");
		}
		if (this.shouldHoldSamePathAdoptionProjection(normalized, options)) {
			return {
				kind: "deferred",
				path: normalized,
				reason: "same-path-adoption-active",
			};
		}
		if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "preflight")) {
			return this.deferCallerAuthorityStale(path, "preflight", options);
		}
		// Keep one disk compare snapshot across CRDT retries. Otherwise a local
		// edit that lands during attempt 1 could become the accepted baseline for
		// attempt 2 and then be overwritten by the newer CRDT snapshot.
		let expectedDiskSnapshot = options.expectedDiskContent;

		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.isPreservedUnresolved(normalized)) {
				return this.blockPreservedUnresolvedWrite(normalized, `attempt-${attempt}`);
			}
			if (this.isAuthoritativeMarkdownDeleteActiveForWrite(normalized)) {
				return this.deferDiskChangedWrite(path, "remote-delete-active");
			}
			if (!this.isCallerAuthorityCurrent(path, options, "before-commit", `attempt-${attempt}`)) {
				return this.deferCallerAuthorityStale(path, `attempt-${attempt}`, options);
			}
			if (this.shouldHoldSamePathAdoptionProjection(normalized, options)) {
				return {
					kind: "deferred",
					path: normalized,
					reason: "same-path-adoption-active",
				};
			}
			const ytext = this.vaultSync.getTextForPath(path);
			if (!ytext) {
				this.log(`flushWrite: no Y.Text for "${path}", skipping`);
				return { kind: "deferred", path: normalized, reason: "missing-ytext" };
			}
			const content = ytext.toJSON();
			const preflightDefer = this.getOpenWriteDeferral(
				path,
				content,
				force,
				"preflight",
				options,
			);
			if (preflightDefer) {
				return preflightDefer;
			}

			try {
				const existing = this.app.vault.getAbstractFileByPath(normalized);
				if (options.expectedDiskFile && existing !== options.expectedDiskFile) {
					return this.deferDiskChangedWrite(path, "expected-file-identity");
				}
				if (
					options.expectedDiskRevision
					&& (!(existing instanceof TFile) || !this.isDiskRevisionCurrent(
						existing,
						options.expectedDiskRevision,
					))
				) {
					return this.deferDiskChangedWrite(path, "expected-file-revision");
				}
				if (existing) {
					// Semantic add/revival authority is create-only and one-shot. Seeing an
					// existing target satisfies/cancels that create intent; retaining it
					// could resurrect a later local deletion within the TTL window.
					this.remoteCreateAuthorizations.delete(normalized);
				}
				if (options.allowCreateIfMissing === true && existing) {
					// Explicit create/undelete authority also carries an expected-missing
					// precondition. A file that appeared since the restore/add decision is
					// new local state and must never be treated as an overwrite target.
					return this.deferDiskChangedWrite(path, "expected-missing-now-existing");
				}
				if (existing instanceof TFile) {
					const currentContent = await this.app.vault.read(existing);
					if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "post-read")) {
						return this.deferCallerAuthorityStale(path, "post-read", options);
					}
					if (this.isPreservedUnresolved(normalized)) {
						return this.blockPreservedUnresolvedWrite(normalized, "post-read");
					}
					if (!this.isExactDiskFileCurrent(normalized, existing)) {
						return this.deferDiskChangedWrite(path, "post-read-file-identity");
					}
					if (!this.isDiskRevisionCurrent(existing, options.expectedDiskRevision)) {
						return this.deferDiskChangedWrite(path, "post-read-file-revision");
					}
					if (this.didCrdtChangeDuringWrite(path, content, "read")) continue;
					const postReadDefer = this.getOpenWriteDeferral(
						path,
						content,
						force,
						"post-read",
						options,
					);
					if (postReadDefer) {
						return postReadDefer;
					}
					if (currentContent === content) {
						this.log(`flushWrite: "${path}" unchanged, skipping`);
						return this.settleUnchangedWrite(
							normalized,
							currentContent,
							options,
							existing,
							ytext,
						);
					}
					if (expectedDiskSnapshot === undefined) {
						const baselineProvider = this.diskBaselineHashProvider;
						if (baselineProvider) {
							const baselineHash = baselineProvider(normalized)?.toLowerCase() ?? null;
							if (!baselineHash) {
								return this.deferDiskChangedWrite(path, "missing-durable-baseline");
							}
							const currentDiskHash = await contentBaselineHash(currentContent);
							if (!this.isCallerAuthorityCurrent(
								path,
								options,
								"before-commit",
								"post-baseline-hash",
							)) {
								return this.deferCallerAuthorityStale(path, "post-baseline-hash", options);
							}
							if (!this.isExactDiskFileCurrent(normalized, existing)) {
								return this.deferDiskChangedWrite(path, "post-baseline-hash-file-identity");
							}
							if (this.didCrdtChangeDuringWrite(path, content, "baseline-hash")) continue;
							const postHashDefer = this.getOpenWriteDeferral(
								path,
								content,
								force,
								"post-baseline-hash",
								options,
							);
							if (postHashDefer) return postHashDefer;
							const latestBaselineHash = baselineProvider(normalized)?.toLowerCase() ?? null;
							if (latestBaselineHash !== baselineHash || currentDiskHash !== baselineHash) {
								return this.deferDiskChangedWrite(path, "durable-baseline-mismatch");
							}
						}
						expectedDiskSnapshot = currentContent;
					}
					if (currentContent !== expectedDiskSnapshot) {
						return this.deferDiskChangedWrite(path, "initial-read");
					}
					const atomicExpectedDiskSnapshot = expectedDiskSnapshot;
					if (this.shouldBlockFrontmatterWrite(path, currentContent, content)) {
						return { kind: "blocked", path: normalized, reason: "frontmatter" };
					}

					await this.suppressWrite(path, content);
					if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "post-suppress")) {
						this.suppressedPaths.delete(normalized);
						return this.deferCallerAuthorityStale(path, "post-suppress", options);
					}
					if (!this.isExactDiskFileCurrent(normalized, existing)) {
						this.suppressedPaths.delete(normalized);
						return this.deferDiskChangedWrite(path, "post-suppress-file-identity");
					}
					if (!this.isDiskRevisionCurrent(existing, options.expectedDiskRevision)) {
						this.suppressedPaths.delete(normalized);
						return this.deferDiskChangedWrite(path, "post-suppress-file-revision");
					}
					if (this.didCrdtChangeDuringWrite(path, content, "suppress")) {
						this.suppressedPaths.delete(normalized);
						continue;
					}
					const preModifyDefer = this.getOpenWriteDeferral(
						path,
						content,
						force,
						"pre-modify",
						options,
					);
					if (preModifyDefer) {
						this.suppressedPaths.delete(normalized);
						return preModifyDefer;
					}

					const atomicProcess = (
						this.app.vault as unknown as {
							process?: (
								file: TFile,
								fn: (latestContent: string) => string,
							) => Promise<string>;
						}
					).process;
					let processOpenDefer: DiskWriteResult | null = null;
					if (typeof atomicProcess === "function") {
						let committedDiskRevision: DiskFileRevision | undefined;
						try {
							await atomicProcess.call(this.app.vault, existing, (latestDiskContent) => {
								if (this.isPreservedUnresolved(normalized)) {
									throw new ExistingFileWriteAborted("preserved-unresolved");
								}
								if (!this.isExactDiskFileCurrent(normalized, existing)) {
									throw new ExistingFileWriteAborted("file-identity-changed");
								}
								if (!this.isDiskRevisionCurrent(existing, options.expectedDiskRevision)) {
									throw new ExistingFileWriteAborted("file-revision-changed");
								}
								if (latestDiskContent === content) {
									throw new ExistingFileWriteAborted("already-current");
								}
								if (!rawContentMatchesVaultReadSnapshot(latestDiskContent, atomicExpectedDiskSnapshot)) {
									throw new ExistingFileWriteAborted("disk-changed");
								}
								if (this.vaultSync.getTextForPath(path)?.toJSON() !== content) {
									throw new ExistingFileWriteAborted("crdt-changed");
								}
								if (this.isAuthoritativeMarkdownDeleteActiveForWrite(normalized)) {
									throw new ExistingFileWriteAborted("remote-delete-active");
								}
								processOpenDefer = this.getOpenWriteDeferral(
									path,
									content,
									force,
									"atomic-process",
									options,
								);
								if (processOpenDefer) {
									throw new ExistingFileWriteAborted("open-write-deferred");
								}
								if (!this.isCallerAuthorityCurrent(
									path,
									options,
									"before-commit",
									"atomic-process",
								)) {
									throw new ExistingFileWriteAborted("authority-stale");
								}
								return content;
							});
						} catch (err) {
							if (!(err instanceof ExistingFileWriteAborted)) throw err;
							this.suppressedPaths.delete(normalized);
							if (err.reason === "preserved-unresolved") {
								return this.blockPreservedUnresolvedWrite(normalized, "atomic-process");
							}
							if (err.reason === "already-current") {
								return this.settleUnchangedWrite(
									normalized,
									content,
									options,
									existing,
									ytext,
								);
							}
							if (
								err.reason === "disk-changed"
								|| err.reason === "file-identity-changed"
								|| err.reason === "file-revision-changed"
								|| err.reason === "remote-delete-active"
							) {
								return this.deferDiskChangedWrite(path, "atomic-process");
							}
							if (err.reason === "open-write-deferred" && processOpenDefer) {
								return processOpenDefer;
							}
							if (err.reason === "authority-stale") {
								return this.deferCallerAuthorityStale(path, "atomic-process", options);
							}
							continue;
						}
						if (!this.isExactDiskFileCurrent(normalized, existing)) {
							this.suppressedPaths.delete(normalized);
							return this.deferDiskChangedWrite(path, "post-atomic-process-file-identity");
						}
						if (this.isPreservedUnresolved(normalized)) {
							this.suppressedPaths.delete(normalized);
							return this.blockPreservedUnresolvedWrite(normalized, "post-atomic-process");
						}
						if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "post-atomic-process")) {
							this.suppressedPaths.delete(normalized);
							return this.deferCallerAuthorityStale(path, "post-atomic-process", options);
						}
						committedDiskRevision = this.captureDiskFileRevision(existing);
						this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
						const contentHash = await contentBaselineHash(content);
						if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "post-write-hash")) {
							this.suppressedPaths.delete(normalized);
							return this.deferCallerAuthorityStale(path, "post-write-hash", options);
						}
						if (this.isPreservedUnresolved(normalized)) {
							this.suppressedPaths.delete(normalized);
							return this.blockPreservedUnresolvedWrite(normalized, "post-write-hash");
						}
						if (!this.isExactDiskFileCurrent(normalized, existing)) {
							this.suppressedPaths.delete(normalized);
							return this.deferDiskChangedWrite(path, "post-write-hash-file-identity");
						}
						if (!(await this.isSettledDiskSnapshotCurrent(
							normalized,
							existing,
							content,
							ytext,
							"post-write-hash",
							committedDiskRevision,
						))) {
							this.suppressedPaths.delete(normalized);
							return this.deferDiskChangedWrite(path, "post-write-readback");
						}
						if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "pre-written-settlement")) {
							this.suppressedPaths.delete(normalized);
							return this.deferCallerAuthorityStale(path, "pre-written-settlement", options);
						}
						this.lastDiskWriteOkAt.set(normalized, Date.now());
						let baselineRecorded = options.recordBaseline !== false;
						if (baselineRecorded && this._onDiskWriteCallback) {
							baselineRecorded = this._onDiskWriteCallback(
								normalized,
								contentHash,
								content,
							) !== false;
						}
						this._flightEventHandler?.({
							priority: "important",
							kind: "disk.write.ok",
							severity: "info",
							scope: "file",
							source: "diskMirror",
							layer: "disk",
							path: normalized,
							data: { contentLength: content.length, isCreate: false, baselineRecorded },
						});
						return {
							kind: "written",
							path: normalized,
							isCreate: false,
							content,
							contentHash,
							baselineRecorded,
						};
					} else {
						// A final read followed by Vault.modify is still a TOCTOU window. If
						// a host cannot provide Vault.process, refusing the write is the only
						// way to preserve a concurrent local save. HeadlessVault implements
						// the same atomic contract as Obsidian.
						this.suppressedPaths.delete(normalized);
						return this.deferDiskChangedWrite(path, "atomic-process-unavailable");
					}
				} else {
					const hasExplicitCreateAuthority =
						options.allowCreateIfMissing === true ||
						this.hasRemoteCreateAuthorization(normalized);
					if (options.expectedDiskContent !== undefined) {
						// The caller planned against an existing snapshot. Its disappearance
						// is a concurrent local delete/rename, not permission to recreate it.
						return this.deferDiskChangedWrite(path, "expected-existing-now-missing");
					}
					const durableBaselineHash =
						this.diskBaselineHashProvider?.(normalized)?.toLowerCase() ?? null;
					if (durableBaselineHash && !hasExplicitCreateAuthority) {
						// A prior clean baseline proves this used to exist. Missing now means a
						// local deletion unless a semantic add/revival or explicit restore says
						// that creation is the requested operation.
						return this.deferDiskChangedWrite(path, "durable-baseline-file-missing");
					}
					if (existing) {
						return this.deferDiskChangedWrite(path, "create-target-not-a-file");
					}
					if (this.shouldBlockFrontmatterWrite(path, null, content)) {
						return { kind: "blocked", path: normalized, reason: "frontmatter" };
					}
					const dir = normalized.substring(0, normalized.lastIndexOf("/"));
					if (dir) {
						const dirExists =
							this.app.vault.getAbstractFileByPath(normalizePath(dir));
						if (!dirExists) {
							if (!this.isCallerAuthorityCurrent(
								path,
								options,
								"before-commit",
								"pre-create-folder",
							)) {
								return this.deferCallerAuthorityStale(
									path,
									"pre-create-folder",
									options,
								);
							}
							const releaseProjectionCommit =
								this.enterRemoteProjectionCriticalSection(
									options.remoteProjectionAdmission,
								);
							if (!releaseProjectionCommit) {
								return this.deferCallerAuthorityStale(
									path,
									"pre-create-folder-critical-section",
									options,
								);
							}
							try {
								await this.app.vault.createFolder(dir);
							} finally {
								releaseProjectionCommit();
							}
						}
					}
					if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "post-create-folder")) {
						return this.deferCallerAuthorityStale(path, "post-create-folder", options);
					}
					if (this.app.vault.getAbstractFileByPath(normalized)) {
						this.remoteCreateAuthorizations.delete(normalized);
						this.log(`flushWrite: "${path}" appeared during create preparation, deferring`);
						return this.deferDiskChangedWrite(path, "create-target-appeared");
					}
					if (this.didCrdtChangeDuringWrite(path, content, "create-folder")) continue;
					if (this.isPreservedUnresolved(normalized)) {
						return this.blockPreservedUnresolvedWrite(normalized, "post-create-folder");
					}
					const preCreateDefer = this.getOpenWriteDeferral(
						path,
						content,
						force,
						"pre-create",
						options,
					);
					if (preCreateDefer) {
						return preCreateDefer;
					}
					await this.suppressWrite(path, content);
					if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "post-suppress-create")) {
						this.suppressedPaths.delete(normalized);
						return this.deferCallerAuthorityStale(path, "post-suppress-create", options);
					}
					if (this.isPreservedUnresolved(normalized)) {
						this.suppressedPaths.delete(normalized);
						return this.blockPreservedUnresolvedWrite(normalized, "post-suppress-create");
					}
					if (this.didCrdtChangeDuringWrite(path, content, "suppress")) {
						this.suppressedPaths.delete(normalized);
						continue;
					}
					const preCreateWriteDefer = this.getOpenWriteDeferral(
						path,
						content,
						force,
						"pre-create-write",
						options,
					);
					if (preCreateWriteDefer) {
						this.suppressedPaths.delete(normalized);
						return preCreateWriteDefer;
					}
					if (this.isAuthoritativeMarkdownDeleteActiveForWrite(normalized)) {
						this.suppressedPaths.delete(normalized);
						return this.deferDiskChangedWrite(path, "remote-delete-before-create");
					}
					let createdFile: TFile;
					try {
						if (this.isPreservedUnresolved(normalized)) {
							this.suppressedPaths.delete(normalized);
							return this.blockPreservedUnresolvedWrite(normalized, "pre-create-commit");
						}
						if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "pre-create-commit")) {
							this.suppressedPaths.delete(normalized);
							return this.deferCallerAuthorityStale(path, "pre-create-commit", options);
						}
						const releaseProjectionCommit =
							this.enterRemoteProjectionCriticalSection(
								options.remoteProjectionAdmission,
							);
						if (!releaseProjectionCommit) {
							this.suppressedPaths.delete(normalized);
							return this.deferCallerAuthorityStale(
								path,
								"pre-create-critical-section",
								options,
							);
						}
						try {
							createdFile = await this.app.vault.create(normalized, content);
						} finally {
							releaseProjectionCommit();
						}
						// The one-shot semantic create intent is consumed by the physical
						// create itself, not by later baseline settlement. From this point on,
						// an authority/readback deferral must not leave permission that could
						// resurrect a subsequent local delete on an ordinary retry.
						this.remoteCreateAuthorizations.delete(normalized);
					} catch (createError) {
						// Vault.create is a no-clobber operation. If a local file won the
						// race after our last existence check, classify that state instead of
						// reporting an opaque failure while its create event is suppressed.
						this.suppressedPaths.delete(normalized);
						this.remoteCreateAuthorizations.delete(normalized);
						const appeared = this.app.vault.getAbstractFileByPath(normalized);
						if (appeared instanceof TFile) {
							if (options.allowCreateIfMissing === true) {
								// Explicit restore/create authority is an expected-missing CAS.
								// Any winner at this path is new local state, even when its bytes
								// happen to equal the restore snapshot.
								return this.deferDiskChangedWrite(path, "expected-missing-create-race");
							}
							try {
								const appearedContent = await this.app.vault.read(appeared);
								if (
									appearedContent === content &&
									this.vaultSync.getTextForPath(path)?.toJSON() === content
								) {
									return this.settleUnchangedWrite(
										normalized,
										content,
										options,
										appeared,
										ytext,
									);
								}
								return this.deferDiskChangedWrite(path, "create-no-clobber-race");
							} catch {
								return this.deferDiskChangedWrite(path, "create-race-read-failed");
							}
						}
						if (appeared) {
							return this.deferDiskChangedWrite(path, "create-race-target-not-file");
						}
						throw createError;
					}
					if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "post-create")) {
						this.suppressedPaths.delete(normalized);
						return this.deferCallerAuthorityStale(path, "post-create", options);
					}
					const committedDiskRevision = this.captureDiskFileRevision(createdFile);
					this.log(
						`flushWrite: created "${path}" on disk (${content.length} chars)`,
					);
					const contentHash = await contentBaselineHash(content);
					if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "post-create-hash")) {
						this.suppressedPaths.delete(normalized);
						return this.deferCallerAuthorityStale(path, "post-create-hash", options);
					}
					if (this.isPreservedUnresolved(normalized)) {
						this.suppressedPaths.delete(normalized);
						return this.blockPreservedUnresolvedWrite(normalized, "post-create-hash");
					}
					if (!(await this.isSettledDiskSnapshotCurrent(
						normalized,
						createdFile,
						content,
						ytext,
						"post-create-hash",
						committedDiskRevision,
					))) {
						this.suppressedPaths.delete(normalized);
						return this.deferDiskChangedWrite(path, "post-create-readback");
					}
					if (!this.isCallerAuthorityCurrent(path, options, "after-commit", "pre-create-settlement")) {
						this.suppressedPaths.delete(normalized);
						return this.deferCallerAuthorityStale(path, "pre-create-settlement", options);
					}
					this.lastDiskWriteOkAt.set(normalized, Date.now());
					let baselineRecorded = options.recordBaseline !== false;
					if (baselineRecorded && this._onDiskWriteCallback) {
						baselineRecorded = this._onDiskWriteCallback(
							normalized,
							contentHash,
							content,
						) !== false;
					}
					this._flightEventHandler?.({
						priority: "important",
						kind: "disk.write.ok",
						severity: "info",
						scope: "file",
						source: "diskMirror",
						layer: "disk",
						path: normalized,
						data: { contentLength: content.length, isCreate: true, baselineRecorded },
					});
					return {
						kind: "written",
						path: normalized,
						isCreate: true,
						content,
						contentHash,
						baselineRecorded,
					};
				}
			} catch (err) {
				console.error(`[kaos] flushWrite failed for "${path}":`, err);
				const error = err instanceof Error ? err.message : String(err);
				this._flightEventHandler?.({
					priority: "critical",
					kind: "disk.write.failed",
					severity: "error",
					scope: "file",
					source: "diskMirror",
					layer: "disk",
					path: normalized,
					data: { error },
				});
				return { kind: "failed", path: normalized, error };
			}
		}

		this.log(`flushWrite: deferred "${path}" (CRDT changed repeatedly during write preparation)`);
		if (!force) {
			if (options.requireRemoteProjectionAdmission === true) {
				this.scheduleRemoteWrite(path);
			} else {
				this.scheduleWrite(path);
			}
		}
		return { kind: "deferred", path: normalized, reason: "crdt-changed-during-write" };
	}

	private async settleUnchangedWrite(
		path: string,
		content: string,
		options: DiskWriteRuntimeOptions,
		expectedFile: TFile,
		expectedYText: Y.Text,
	): Promise<DiskWriteResult> {
		const normalized = normalizePath(path);
		if (this.isPreservedUnresolved(normalized)) {
			return this.blockPreservedUnresolvedWrite(normalized, "unchanged-pre-hash");
		}
		if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "unchanged-pre-hash")) {
			return this.deferCallerAuthorityStale(path, "unchanged-pre-hash", options);
		}
		if (!this.isExactDiskFileCurrent(normalized, expectedFile)) {
			return this.deferDiskChangedWrite(path, "unchanged-file-identity");
		}
		if (!this.isDiskRevisionCurrent(expectedFile, options.expectedDiskRevision)) {
			return this.deferDiskChangedWrite(path, "unchanged-file-revision");
		}
		const contentHash = await contentBaselineHash(content);
		if (!this.isCallerAuthorityCurrent(path, options, "before-commit", "unchanged-post-hash")) {
			return this.deferCallerAuthorityStale(path, "unchanged-post-hash", options);
		}
		if (this.isPreservedUnresolved(normalized)) {
			return this.blockPreservedUnresolvedWrite(normalized, "unchanged-post-hash");
		}
		if (!this.isExactDiskFileCurrent(normalized, expectedFile)) {
			return this.deferDiskChangedWrite(path, "post-unchanged-hash-file-identity");
		}
		if (!this.isDiskRevisionCurrent(expectedFile, options.expectedDiskRevision)) {
			return this.deferDiskChangedWrite(path, "post-unchanged-hash-file-revision");
		}
		const settled = await this.isSettledDiskSnapshotCurrent(
			normalized,
			expectedFile,
			content,
			expectedYText,
			"post-unchanged-hash",
			options.expectedDiskRevision,
		);
		if (!settled) {
			return this.deferDiskChangedWrite(path, "post-unchanged-readback");
		}
		if (!this.isCallerAuthorityCurrent(
			path,
			options,
			"before-commit",
			"pre-unchanged-settlement",
		)) {
			return this.deferCallerAuthorityStale(path, "pre-unchanged-settlement", options);
		}
		// isSettledDiskSnapshotCurrent itself awaits a read. Recheck synchronously
		// in its caller so a same-TFile save queued by that read cannot enter the
		// baseline callback/result boundary.
		if (!this.isDiskRevisionCurrent(expectedFile, options.expectedDiskRevision)) {
			return this.deferDiskChangedWrite(path, "post-unchanged-settlement-file-revision");
		}
		if (options.recordBaseline !== false) {
			// Observed equality is itself a clean settlement. Publishing it repairs
			// a missing/stale durable baseline so the next remote write is not
			// permanently blocked by the safety guard.
			this._onDiskWriteCallback?.(normalized, contentHash, content);
		}
		return { kind: "unchanged", path: normalized, content, contentHash };
	}

	/**
	 * Final settlement fence shared by written/create/unchanged results.
	 *
	 * Hashing yields to the event loop. A same-path edit or delete/recreate can
	 * therefore land after the atomic write/equality observation but before the
	 * baseline callback. Only the exact TFile, exact bytes, and exact Y.Text
	 * snapshot may be reported as settled.
	 */
	private async isSettledDiskSnapshotCurrent(
		path: string,
		expectedFile: TFile,
		expectedContent: string,
		expectedYText: Y.Text,
		phase: string,
		expectedRevision?: DiskFileRevision,
	): Promise<boolean> {
		const normalized = normalizePath(path);
		const reject = (reason: string, actualLength?: number): false => {
			this.trace?.("disk", "disk-write-settlement-stale", {
				path: normalized,
				phase,
				reason,
				expectedLength: expectedContent.length,
				actualLength: actualLength ?? null,
			});
			return false;
		};

		if (this.isPreservedUnresolved(normalized)) return reject("preserved-unresolved");
		if (!this.isExactDiskFileCurrent(normalized, expectedFile)) {
			return reject("file-identity-changed-before-readback");
		}
		if (!this.isDiskRevisionCurrent(expectedFile, expectedRevision)) {
			return reject("file-revision-changed-before-readback");
		}

		let actualContent: string;
		try {
			actualContent = await this.app.vault.read(expectedFile);
		} catch {
			return reject("readback-failed");
		}
		if (!this.isExactDiskFileCurrent(normalized, expectedFile)) {
			return reject("file-identity-changed-during-readback", actualContent.length);
		}
		if (!this.isDiskRevisionCurrent(expectedFile, expectedRevision)) {
			return reject("file-revision-changed-during-readback", actualContent.length);
		}
		if (actualContent !== expectedContent) {
			return reject("disk-content-changed", actualContent.length);
		}
		const currentYText = this.vaultSync.getTextForPath(normalized);
		if (currentYText !== expectedYText) return reject("ytext-identity-changed", actualContent.length);
		if (currentYText.toJSON() !== expectedContent) {
			return reject("crdt-content-changed", actualContent.length);
		}
		if (this.isPreservedUnresolved(normalized)) return reject("preserved-unresolved");
		if (!this.isDiskRevisionCurrent(expectedFile, expectedRevision)) {
			return reject("file-revision-changed-before-settlement", actualContent.length);
		}
		return true;
	}

	private isExactDiskFileCurrent(path: string, expected: TFile): boolean {
		const normalized = normalizePath(path);
		return expected.path === normalized
			&& this.app.vault.getAbstractFileByPath(normalized) === expected;
	}

	private captureDiskFileRevision(file: TFile): DiskFileRevision {
		return {
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
	}

	private isDiskRevisionCurrent(
		file: TFile,
		expected: DiskFileRevision | undefined,
	): boolean {
		if (!expected) return true;
		return file.stat.ctime === expected.ctime
			&& file.stat.mtime === expected.mtime
			&& file.stat.size === expected.size;
	}

	private deferDiskChangedWrite(path: string, phase: string): DiskWriteResult {
		const normalized = normalizePath(path);
		this.log(
			`flushWrite: deferred "${normalized}" because disk changed during write preparation ` +
			`(phase=${phase})`,
		);
		this.trace?.("disk", "disk-write-deferred-stale-snapshot", {
			path: normalized,
			phase,
			reason: "disk-changed-during-write",
		});
		return { kind: "deferred", path: normalized, reason: "disk-changed-during-write" };
	}

	private isCallerAuthorityCurrent(
		path: string,
		options: DiskWriteRuntimeOptions,
		phase: DiskWriteAuthorityPhase,
		boundary: string,
	): boolean {
		if (
			options.remoteProjectionAdmission &&
			!this.isRemoteProjectionAdmissionCurrent(options.remoteProjectionAdmission)
		) {
			this.trace?.("disk", "remote-projection-admission-stale", {
				path: normalizePath(path),
				phase,
				boundary,
			});
			return false;
		}
		const editorAuthority = options.editorAuthorityState.authority;
		if (
			editorAuthority.kind === "proven-single"
			&& !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
		) {
			this.trace?.("disk", "editor-authority-lease-stale", {
				path: normalizePath(path),
				phase,
				boundary,
			});
			return false;
		}
		if (!options.isAuthorityCurrent) return true;
		let current = false;
		try {
			current = options.isAuthorityCurrent(phase) === true;
		} catch {
			current = false;
		}
		if (!current) {
			this.trace?.("disk", "disk-write-authority-stale", {
				path: normalizePath(path),
				phase,
				boundary,
				reason: "authority-stale",
			});
		}
		return current;
	}

	private deferCallerAuthorityStale(
		path: string,
		boundary: string,
		options?: DiskWriteRuntimeOptions,
	): DiskWriteResult {
		const normalized = normalizePath(path);
		if (
			options?.remoteProjectionAdmission &&
			!this.isRemoteProjectionAdmissionCurrent(options.remoteProjectionAdmission)
		) {
			this.log(
				`flushWrite: deferred "${normalized}" because provider admission expired (${boundary})`,
			);
			return {
				kind: "deferred",
				path: normalized,
				reason: "remote-projection-not-ready",
			};
		}
		this.log(`flushWrite: deferred "${normalized}" because caller authority expired (${boundary})`);
		return { kind: "deferred", path: normalized, reason: "authority-stale" };
	}

	private isRemoteProjectionAdmissionCurrent(
		admission: RemoteProjectionAdmissionLease,
	): boolean {
		try {
			return admission.isCurrent() === true;
		} catch {
			return false;
		}
	}

	private enterRemoteProjectionCriticalSection(
		admission: RemoteProjectionAdmissionLease | undefined,
	): (() => void) | null {
		if (!admission) return () => {};
		if (!this.isRemoteProjectionAdmissionCurrent(admission)) return null;
		if (!admission.enterCriticalSection) return () => {};
		try {
			return admission.enterCriticalSection();
		} catch {
			return null;
		}
	}

	private retainRemoteProjectionAdmission(
		path: string,
		options: DiskWriteRuntimeOptions,
	): void {
		const admission = options.remoteProjectionAdmission;
		if (!admission) return;
		this.remoteProjectionWriteAdmissions.set(normalizePath(path), admission);
	}

	private blockPreservedUnresolvedWrite(path: string, phase: string): DiskWriteResult {
		const normalized = normalizePath(path);
		this.log(
			`flushWrite: blocked "${normalized}" because the path has an unresolved preserved conflict ` +
			`(phase=${phase})`,
		);
		this.trace?.("disk", "disk-write-blocked-preserved-unresolved", {
			path: normalized,
			phase,
			reason: "preserved-unresolved",
		});
		return { kind: "blocked", path: normalized, reason: "preserved-unresolved" };
	}

	private didCrdtChangeDuringWrite(
		path: string,
		plannedContent: string,
		phase: string,
	): boolean {
		const latest = this.vaultSync.getTextForPath(path)?.toJSON();
		if (latest === plannedContent) return false;
		if (latest == null) {
			this.log(`flushWrite: no Y.Text for "${path}" after ${phase}, skipping`);
			return true;
		}
		this.log(
			`flushWrite: retrying "${path}" because CRDT changed during ${phase} ` +
			`(${plannedContent.length} -> ${latest.length} chars)`,
		);
		return true;
	}

	private getOpenWriteDeferral(
		path: string,
		content: string,
		force: boolean,
		phase: string,
		options: DiskWriteRuntimeOptions,
	): DiskWriteResult | null {
		const normalized = normalizePath(path);
		let editorAuthority = options.editorAuthorityState.authority;
		if (editorAuthority.kind === "none") {
			editorAuthority = this.capturePathEditorAuthority(normalized);
			if (editorAuthority.kind !== "none") {
				options.editorAuthorityState.authority = editorAuthority;
			}
		}
		if (editorAuthority.kind === "blocked") {
			this.log(
				`flushWrite: deferring "${path}" ` +
					`(editor authority blocked: ${editorAuthority.reason}, phase=${phase})`,
			);
			if (!force) {
				this.retainRemoteProjectionAdmission(path, options);
				this.scheduleOpenWrite(path);
			}
			return { kind: "deferred", path: normalized, reason: "open-editor-mismatch" };
		}
		if (
			editorAuthority.kind === "proven-single"
			&& !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
		) {
			return this.deferCallerAuthorityStale(path, `editor-${phase}`, options);
		}
		if (
			editorAuthority.kind === "proven-single"
			&& editorAuthority.content !== content
		) {
			this.log(
				`flushWrite: deferring open "${path}" ` +
					`(open editor differs from CRDT, phase=${phase})`,
			);
			if (!force) {
				this.retainRemoteProjectionAdmission(path, options);
				this.scheduleOpenWrite(path);
			}
			return { kind: "deferred", path: normalized, reason: "open-editor-mismatch" };
		}
		const isOpenOrViewed = this.openPaths.has(path) || this.isOpenInWorkspace(path);
		if (!isOpenOrViewed) return null;

		if (force) return null;
		if (this.hasRecentEditorActivity(path)) {
			this.log(`flushWrite: deferring open "${path}" (recent editor activity, phase=${phase})`);
			this.retainRemoteProjectionAdmission(path, options);
			this.scheduleOpenWrite(path);
			return { kind: "deferred", path: normalized, reason: "recent-editor-activity" };
		}

		return null;
	}

	private shouldBlockFrontmatterWrite(
		path: string,
		previousContent: string | null,
		nextContent: string,
	): boolean {
		if (!this.frontmatterGuardEnabled()) return false;
		const validation = validateCrdtDocumentTransition(path, previousContent, nextContent);
		this.onFrontmatterValidated?.(
			path,
			"crdt-to-disk",
			"flush-write",
			validation,
			previousContent,
			nextContent,
		);
		if (!isFrontmatterBlocked(validation)) return false;

		this.log(
			`frontmatter write blocked for "${path}" ` +
			`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}

	private async resolveRemoteDeleteBaselineText(
		path: string,
		override: string | null | undefined,
	): Promise<string | null> {
		// Tests and explicit internal callers may carry the exact baseline snapshot
		// that admitted this delete. Production metadata observers deliberately do
		// not pass the current Y.Text through this escape hatch.
		if (override !== undefined) return override;

		const hashProvider = this.diskBaselineHashProvider;
		const textProvider = this.diskBaselineTextProvider;
		if (!hashProvider || !textProvider) return null;

		const normalized = normalizePath(path);
		const expectedHash = hashProvider(normalized)?.toLowerCase() ?? null;
		if (!expectedHash) return null;
		try {
			const text = await textProvider(normalized);
			if (text === null) return null;
			const actualHash = await contentBaselineHash(text);
			const latestHash = hashProvider(normalized)?.toLowerCase() ?? null;
			if (latestHash !== expectedHash || actualHash !== expectedHash) {
				this.trace?.("disk", "remote-delete-baseline-stale", {
					path: normalized,
					expectedHashPrefix: hashPrefix(expectedHash),
					latestHashPrefix: hashPrefix(latestHash),
					actualHashPrefix: hashPrefix(actualHash),
				});
				return null;
			}
			return text;
		} catch (err) {
			this.trace?.("disk", "remote-delete-baseline-read-failed", {
				path: normalized,
				error: formatUnknown(err),
			});
			return null;
		}
	}

	private async handleRemoteDelete(
		path: string,
		options: { baselineText?: string | null } = {},
		admission: RemoteProjectionAdmissionLease | null =
			this.captureRemoteProjectionAdmission([path]),
	): Promise<void> {
		const normalized = normalizePath(path);
		if (!admission || !this.isRemoteProjectionAdmissionCurrent(admission)) {
			this.log(`remote delete: policy not ready for "${normalized}"`);
			return;
		}
		if (!this.isMarkdownPathSyncable(normalized)) {
			this.log(`remote delete: skipping excluded path "${normalized}"`);
			return;
		}
		const deleteGeneration = this.bumpRemoteDeleteGeneration(normalized);
		const expectedDeleteFingerprint = this.getAuthoritativeMarkdownDeleteFingerprint(normalized);
		if (expectedDeleteFingerprint === null) {
			this.traceStaleRemoteDeleteCancellation(
				normalized,
				deleteGeneration,
				expectedDeleteFingerprint,
				"before-inspection",
			);
			return;
		}
		await this.runPathWriteLocked(normalized, () => this.handleRemoteDeleteUnlocked(
			normalized,
			options,
			deleteGeneration,
			expectedDeleteFingerprint,
			admission,
		));
	}

	private async handleRemoteDeleteUnlocked(
		path: string,
		options: { baselineText?: string | null },
		deleteGeneration: number,
		expectedDeleteFingerprint: string,
		admission: RemoteProjectionAdmissionLease,
	): Promise<void> {
		function assertNever(value: never): never {
			throw new Error(`Unhandled EnsureFileResult: ${JSON.stringify(value)}`);
		}

		const normalized = normalizePath(path);
		if (!this.isRemoteDeleteOperationCurrent(
			normalized,
			deleteGeneration,
			expectedDeleteFingerprint,
			admission,
		)) {
			this.traceStaleRemoteDeleteCancellation(
				normalized,
				deleteGeneration,
				expectedDeleteFingerprint,
				"after-path-lock",
			);
			return;
		}
		const durableBaselineText = await this.resolveRemoteDeleteBaselineText(
			normalized,
			options.baselineText,
		);
		if (!this.isRemoteDeleteOperationCurrent(
			normalized,
			deleteGeneration,
			expectedDeleteFingerprint,
			admission,
		)) {
			this.traceStaleRemoteDeleteCancellation(
				normalized,
				deleteGeneration,
				expectedDeleteFingerprint,
				"after-baseline-read",
			);
			return;
		}
		const wasOpen = this.openPaths.has(normalized);
		const wasObserved = this.textObservers.has(normalized);
		const wasSuppressed = this.isSuppressed(normalized);
		this.trace?.("disk", "remote-delete", {
			path,
			normalizedPath: normalized,
			wasOpen,
			wasObserved,
			wasSuppressed,
			hasBaselineText: durableBaselineText !== null,
		});
		// Flight: remote delete observed — emit before we know the outcome
		this._flightEventHandler?.({
			priority: "critical",
			kind: "delete.remote.observed",
			severity: "info",
			scope: "file",
			source: "diskMirror",
			layer: "disk",
			path: normalized,
			data: { wasOpen, hasBaselineText: durableBaselineText !== null },
		});
		let file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
				try {
					// Remote delete decision: determine whether to delete, preserve+revive,
					// or preserve without reviving. Three-way decision avoids conflating
					// "known dirty" with "unknown baseline".
						const lastKnownContent = durableBaselineText;

					let decision: RemoteDeleteDecision = { kind: "apply-delete" };

					let unresolvedReason: PreservedUnresolvedReason | null = null;
					let editorAuthority = this.capturePathEditorAuthority(normalized);

					if (lastKnownContent !== null) {
						if (
							editorAuthority.kind === "proven-single"
							&& editorAuthority.content !== lastKnownContent
						) {
							// Known baseline exists, open editor differs → known dirty,
							// even if Obsidian has not autosaved it to disk yet.
							decision = {
								kind: "preserve-revive",
								diskContent: editorAuthority.content,
								contentSource: "editor",
							};
							this.trace?.("disk", "remote-delete-conflict-preserved", {
								path,
								normalizedPath: normalized,
								reason: "local-open-editor-modified-since-last-sync",
								editorLength: editorAuthority.content.length,
								crdtLength: lastKnownContent.length,
							});
							this.log(
								`handleRemoteDelete: preserved open editor content for "${path}" ` +
								`(editor ${editorAuthority.content.length} chars !== CRDT ${lastKnownContent.length} chars)`,
							);
						} else if (
							editorAuthority.kind === "blocked"
							&& editorAuthority.reason === "multiple"
						) {
							decision = { kind: "preserve-unresolved" };
							unresolvedReason = "remote-delete-multiple-open-editor-authorities";
							this.trace?.("disk", "remote-delete-conflict-preserved", {
								path,
								normalizedPath: normalized,
								reason: "multiple-open-editor-authorities",
							});
							this.log(
								`handleRemoteDelete: preserved "${path}" ` +
								`(multiple open editor authorities — cannot choose safely)`,
							);
						} else if (editorAuthority.kind === "blocked") {
							decision = { kind: "preserve-unresolved" };
							unresolvedReason = "remote-delete-open-editor-read-failed";
							this.trace?.("disk", "remote-delete-conflict-preserved", {
								path,
								normalizedPath: normalized,
								reason: "open-editor-read-failed-cannot-verify",
							});
							this.log(
								`handleRemoteDelete: preserved "${path}" ` +
								`(open editor read failed — cannot verify local state)`,
							);
						} else {
							try {
								const diskContent = await this.app.vault.read(file);
								if (
									editorAuthority.kind === "proven-single"
									&& !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
								) {
									this.trace?.("disk", "remote-delete-editor-authority-stale", {
										path: normalized,
										phase: "after-initial-disk-read",
									});
									return;
								}
								if (diskContent !== lastKnownContent) {
									// Known baseline exists, local file differs → known dirty.
									// Preserve and revive: local dirty work wins over remote delete.
									decision = { kind: "preserve-revive", diskContent, contentSource: "disk" };
									this.trace?.("disk", "remote-delete-conflict-preserved", {
										path,
										normalizedPath: normalized,
										reason: "local-file-modified-since-last-sync",
										diskLength: diskContent.length,
										crdtLength: lastKnownContent.length,
									});
									this.log(
										`handleRemoteDelete: preserved locally modified "${path}" ` +
										`(disk ${diskContent.length} chars !== CRDT ${lastKnownContent.length} chars)`,
									);
								}
								// else: disk matches CRDT → clean → apply-delete stays
							} catch {
								// Read failed — file might be locked, busy, or inaccessible.
								// We have a baseline but cannot verify local state. Treat as
								// unresolved to avoid deleting potentially modified data.
								decision = { kind: "preserve-unresolved" };
								unresolvedReason = "remote-delete-read-failed";
								this.trace?.("disk", "remote-delete-conflict-preserved", {
									path,
									normalizedPath: normalized,
									reason: "read-failed-cannot-verify",
								});
								this.log(
									`handleRemoteDelete: preserved "${path}" (read failed — cannot verify local state)`,
								);
							}
						}
					} else {
						// No CRDT baseline available — cannot verify local file is
						// unmodified. Preserve the file to avoid data loss, but DO NOT
						// auto-revive the tombstone. This prevents phantom resurrection
						// of legitimately deleted files when CRDT state is transiently
						// unavailable (startup, hydration, race).
						decision = { kind: "preserve-unresolved" };
						unresolvedReason = "remote-delete-missing-baseline";
						this.trace?.("disk", "remote-delete-conflict-preserved", {
							path,
							normalizedPath: normalized,
							reason: "no-crdt-baseline-available",
						});
						this.log(
							`handleRemoteDelete: preserved "${path}" (no CRDT baseline to compare — unresolved)`,
						);
					}

					// A clean-delete decision is destructive. Re-read immediately before
					// committing it so an edit that landed during the first read is
					// preserved and revived instead of being trashed.
					if (decision.kind === "apply-delete") {
						if (!this.isRemoteDeleteOperationCurrent(
							normalized,
							deleteGeneration,
							expectedDeleteFingerprint,
							admission,
						)) {
							this.traceStaleRemoteDeleteCancellation(
								normalized,
								deleteGeneration,
								expectedDeleteFingerprint,
								"before-final-disk-read",
							);
							return;
						}
						const latestFile = this.app.vault.getAbstractFileByPath(normalized);
						if (!(latestFile instanceof TFile)) return;
						if (latestFile !== file) {
							decision = { kind: "preserve-unresolved" };
							unresolvedReason = "remote-delete-read-failed";
							this.trace?.("disk", "remote-delete-file-identity-changed", {
								path: normalized,
								phase: "before-final-read",
							});
						} else {
							try {
								const latestDiskContent = await this.app.vault.read(latestFile);
								if (
									editorAuthority.kind === "proven-single"
									&& !this.isPathEditorAuthorityLeaseCurrent(editorAuthority.lease)
								) {
									this.trace?.("disk", "remote-delete-editor-authority-stale", {
										path: normalized,
										phase: "after-final-disk-read",
									});
									return;
								}
								if (!this.isExactDiskFileCurrent(normalized, latestFile)) {
									decision = { kind: "preserve-unresolved" };
									unresolvedReason = "remote-delete-read-failed";
									this.trace?.("disk", "remote-delete-file-identity-changed", {
										path: normalized,
										phase: "after-final-read",
									});
								} else {
									if (editorAuthority.kind === "none") {
										editorAuthority = this.capturePathEditorAuthority(normalized);
									}
									const latestEditorAuthority = editorAuthority;
									if (
										latestEditorAuthority.kind === "proven-single"
										&& latestEditorAuthority.content !== lastKnownContent
									) {
										decision = {
											kind: "preserve-revive",
											diskContent: latestEditorAuthority.content,
											contentSource: "editor",
										};
									} else if (
										latestEditorAuthority.kind === "blocked"
										&& latestEditorAuthority.reason === "multiple"
									) {
										decision = { kind: "preserve-unresolved" };
										unresolvedReason = "remote-delete-multiple-open-editor-authorities";
									} else if (latestEditorAuthority.kind === "blocked") {
										decision = { kind: "preserve-unresolved" };
										unresolvedReason = "remote-delete-open-editor-read-failed";
									} else if (latestDiskContent !== lastKnownContent) {
										decision = {
											kind: "preserve-revive",
											diskContent: latestDiskContent,
											contentSource: "disk",
										};
										this.trace?.("disk", "remote-delete-conflict-preserved", {
											path: normalized,
											reason: "local-file-changed-during-delete-inspection",
											diskLength: latestDiskContent.length,
											crdtLength: lastKnownContent?.length ?? null,
										});
									}
								}
							} catch {
								decision = { kind: "preserve-unresolved" };
								unresolvedReason = "remote-delete-read-failed";
							}
						}
					}

					// Final tombstone/generation fence after every inspection await and
					// immediately before any queue clearing, Yjs revival, or disk delete.
					if (!this.isRemoteDeleteOperationCurrent(
						normalized,
						deleteGeneration,
						expectedDeleteFingerprint,
						admission,
					)) {
						this.traceStaleRemoteDeleteCancellation(
							normalized,
							deleteGeneration,
							expectedDeleteFingerprint,
							"before-commit",
						);
						return;
					}
					if (
						decision.kind !== "preserve-unresolved"
						&& !this.isRemoteDeleteEditorAuthorityCurrent(normalized, editorAuthority)
					) {
						this.trace?.("disk", "remote-delete-editor-authority-stale", {
							path: normalized,
							phase: "before-commit",
						});
						return;
					}
					if (
						decision.kind === "apply-delete"
						&& (!(file instanceof TFile) || !this.isExactDiskFileCurrent(normalized, file))
					) {
						decision = { kind: "preserve-unresolved" };
						unresolvedReason = "remote-delete-read-failed";
						this.trace?.("disk", "remote-delete-file-identity-changed", {
							path: normalized,
							phase: "immediately-before-delete",
						});
					}

					if (decision.kind === "apply-delete") {
						const fileToDelete = file;
						if (!(fileToDelete instanceof TFile)) return;
						if (!this.isRemoteDeleteEditorAuthorityCurrent(normalized, editorAuthority)) {
							return;
						}
						const markerEpisodeBeforeTrash = this.getPreservedUnresolvedEpisode(normalized);

						// A suppressed vault delete event skips the normal unbind path, so detach
						// immediately before trash. If trash fails while the file still exists,
						// restore observers/bindings below and keep the quarantine intact.
						this.unobserveText(normalized);
						this.editorBindings.unbindByPath(normalized);
						this.suppressDelete(normalized);

						let deleteMode: "trash" | "stale";
						try {
							deleteMode = await this.deleteLocalReplica(
								fileToDelete,
								(phase) => {
									if (!this.isRemoteDeleteOperationCurrent(
										normalized,
										deleteGeneration,
										expectedDeleteFingerprint,
										admission,
									)) return false;
									if (!this.isRemoteDeleteEditorAuthorityCurrent(
										normalized,
										editorAuthority,
									)) return false;
									return phase === "before"
										? this.isExactDiskFileCurrent(normalized, fileToDelete)
										: this.app.vault.getAbstractFileByPath(normalized) === null;
								},
								admission,
							);
						} catch (deleteErr) {
							this.suppressedPaths.delete(normalized);
							this.restoreFailedRemoteDeleteObservation(normalized, wasOpen, wasObserved);
							this.ensurePreservedUnresolved(
								normalized,
								"remote-delete-trash-failed",
							);
							this.trace?.("disk", "remote-delete-trash-failed", {
								path: normalized,
								error: formatUnknown(deleteErr),
							});
							this._flightEventHandler?.({
								priority: "critical",
								kind: "delete.preserved",
								severity: "warn",
								scope: "file",
								source: "diskMirror",
								layer: "disk",
								path: normalized,
								data: {
									reason: "remote-delete-trash-failed",
									preserveKind: "preserve-unresolved",
								},
							});
							this.log(
								`handleRemoteDelete: preserved "${path}" because no recoverable trash succeeded`,
							);
							return;
						}

						const deleteStillCurrent = this.isRemoteDeleteOperationCurrent(
							normalized,
							deleteGeneration,
							expectedDeleteFingerprint,
							admission,
						) && this.isRemoteDeleteEditorAuthorityCurrent(normalized, editorAuthority);
						const pathAfterTrash = this.app.vault.getAbstractFileByPath(normalized);
						if (deleteMode === "stale" || !deleteStillCurrent || pathAfterTrash !== null) {
							// Either the tombstone changed while trash was in flight or a new local
							// file won the path immediately afterwards. Never clear a marker for that
							// newer episode. A revived CRDT can safely recreate a missing path.
							if (pathAfterTrash !== null) {
								if (pathAfterTrash instanceof TFile) {
									this.restoreFailedRemoteDeleteObservation(normalized, wasOpen, wasObserved);
								}
								if (!(pathAfterTrash instanceof TFile)) {
									this.ensurePreservedUnresolved(normalized, "path-collision");
								} else if (deleteStillCurrent) {
									this.ensurePreservedUnresolved(
										normalized,
										"remote-delete-trash-failed",
									);
								}
							} else if (this.getAuthoritativeMarkdownDeleteFingerprint(normalized) === null) {
								this.scheduleRemoteWrite(normalized);
							}
							this.traceStaleRemoteDeleteCancellation(
								normalized,
								deleteGeneration,
								expectedDeleteFingerprint,
								deleteMode === "stale"
									? "trash-fallback-stale"
									: pathAfterTrash !== null
										? "path-reappeared-after-trash"
										: "after-trash",
							);
							return;
						}

						this.openPaths.delete(normalized);
						this.pendingOpenWrites.delete(normalized);
						this.writeQueue.delete(normalized);
						this.forcedWritePaths.delete(normalized);
						this.remoteProjectionWriteAdmissions.delete(normalized);
						for (const timers of [this.debounceTimers, this.openWriteTimers]) {
							const timer = timers.get(normalized);
							if (timer) clearTimeout(timer);
							timers.delete(normalized);
						}
						// Marker resolution is the final commit step: recoverable trash has
						// succeeded, the path is absent, and the exact tombstone episode remains.
						this.resolvePreservedUnresolvedEpisode(
							normalized,
							markerEpisodeBeforeTrash,
						);
						this.trace?.("disk", "remote-delete-applied", {
							path,
							deleteMode,
							reason: "remote-delete",
						});
						this.log(`handleRemoteDelete: moved "${path}" to recoverable trash`);
						this._flightEventHandler?.({
							priority: "critical",
							kind: "delete.disk.applied",
							severity: "info",
							scope: "file",
							source: "diskMirror",
							layer: "disk",
							path: normalized,
							data: { deleteMode, reason: "tombstone-applied" },
						});
					} else if (decision.kind === "preserve-revive") {
						this._flightEventHandler?.({
							priority: "critical",
							kind: "delete.preserved",
							severity: "warn",
							scope: "file",
							source: "diskMirror",
							layer: "disk",
							path: normalized,
							data: { reason: "local-dirty-wins-over-remote-delete", preserveKind: "preserve-revive" },
						});
						// Known dirty: local file intentionally differs from baseline.
						// Revive tombstone so the file re-enters sync. This is the
						// explicit policy: local dirty work wins over remote delete.
						const markerEpisodeBeforeRevive = this.getPreservedUnresolvedEpisode(normalized);
						try {
							if (!this.isExactDiskFileCurrent(normalized, file)) {
								throw new Error("disk file identity changed before dirty revival");
							}
							if (decision.contentSource !== "editor") {
								const latestDiskContent = await this.app.vault.read(file);
								if (
									!this.isExactDiskFileCurrent(normalized, file)
									|| latestDiskContent !== decision.diskContent
								) {
									throw new Error("disk authority changed before dirty revival");
								}
							}
							if (!this.isRemoteDeleteEditorAuthorityCurrent(normalized, editorAuthority)) {
								throw new Error("editor authority changed before dirty revival");
							}
							if (!this.isRemoteDeleteOperationCurrent(
								normalized,
								deleteGeneration,
								expectedDeleteFingerprint,
								admission,
							)) {
								throw new Error("remote delete episode changed before dirty revival");
							}
							const ensureResult = this.vaultSync.ensureFile(
								normalized,
								decision.diskContent,
								this.getDeviceName(),
								{
									reviveTombstone: true,
									reviveReason: "remote-delete-local-dirty-preserved",
								},
							);
							let revivedText: Y.Text;
							switch (ensureResult.kind) {
								case "created":
								case "existing":
									revivedText = ensureResult.ytext;
									break;
								case "replan":
									throw new Error("dirty revival active set changed before commit");
								case "blocked":
									throw new Error(`dirty revival blocked (${ensureResult.reason})`);
								default:
									assertNever(ensureResult);
							}
							const activeText = this.vaultSync.getTextForPath(normalized);
							const reviveSettled = activeText === revivedText
								&& yTextToString(revivedText) === decision.diskContent
								&& this.getAuthoritativeMarkdownDeleteFingerprint(normalized) === null
								&& this.remoteDeleteGenerations.get(normalized) === deleteGeneration
								&& this.isRemoteDeleteEditorAuthorityCurrent(normalized, editorAuthority);
							if (!reviveSettled) {
								throw new Error("revived Y.Text did not settle to the preserved disk authority");
							}
							// The exact active Y.Text now exposes the preserved bytes and the
							// tombstone is gone. Only now may the prior marker be resolved.
							this.resolvePreservedUnresolvedEpisode(
								normalized,
								markerEpisodeBeforeRevive,
							);
							this.trace?.("disk", "remote-delete-preserved-revived", {
								path,
								normalizedPath: normalized,
								reason: "remote-delete-local-dirty-preserved",
								contentLength: decision.diskContent.length,
							});
							this.log(
								`handleRemoteDelete: revived tombstone for "${path}" after dirty preservation`,
							);
						} catch (reviveErr) {
							// The local file remains authoritative. Keep an existing marker exactly
							// as-is, or create a generic conflict marker when this was the first
							// failed preservation attempt (including partial/mismatched revival).
							this.ensurePreservedUnresolved(
								normalized,
								"three-way-preserve-failed",
							);
							this.trace?.("disk", "remote-delete-preserved-revive-failed", {
								path,
								normalizedPath: normalized,
								error: reviveErr instanceof Error ? reviveErr.message : String(reviveErr),
							});
						}
					}
				// kind === "preserve-unresolved": file stays on disk, tombstone
				// remains in CRDT. The file is NOT auto-revived by later
				// reconcile/import passes; explicit user action or a future
				// remote event is required to resolve the limbo state.
				if (decision.kind === "preserve-unresolved") {
					this._flightEventHandler?.({
						priority: "critical",
						kind: "delete.preserved",
						severity: "warn",
						scope: "file",
						source: "diskMirror",
						layer: "disk",
						path: normalized,
						data: {
							reason: unresolvedReason ?? "preserve-unresolved",
							preserveKind: "preserve-unresolved",
						},
					});
						this.unobserveText(normalized);
						this.openPaths.delete(normalized);
						this.pendingOpenWrites.delete(normalized);
						this.writeQueue.delete(normalized);
						this.forcedWritePaths.delete(normalized);
						this.remoteProjectionWriteAdmissions.delete(normalized);
						const pending = this.debounceTimers.get(normalized);
						if (pending) {
							clearTimeout(pending);
							this.debounceTimers.delete(normalized);
						}
						const openPending = this.openWriteTimers.get(normalized);
						if (openPending) {
							clearTimeout(openPending);
							this.openWriteTimers.delete(normalized);
						}
						this.editorBindings.unbindByPath(normalized);
						this.recordPreservedUnresolved(
							normalized,
							unresolvedReason ?? "unknown",
						);
					}
			} catch (err) {
				console.error(
					`[kaos] handleRemoteDelete failed for "${path}":`,
					err,
				);
			}
		}
	}

	private async handleRemoteRename(
		fileId: string,
		oldPath: string,
		newPath: string,
		admission: RemoteProjectionAdmissionLease | null =
			this.captureRemoteProjectionAdmission([oldPath, newPath]),
	): Promise<void> {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		if (oldNormalized === newNormalized) return;
		if (!admission || !this.isRemoteProjectionAdmissionCurrent(admission)) {
			this.log(
				`remote rename: policy not ready for "${oldNormalized}" -> "${newNormalized}"`,
			);
			return;
		}
		if (!this.isMarkdownPathSyncable(oldNormalized) || !this.isMarkdownPathSyncable(newNormalized)) {
			this.log(`remote rename: skipping excluded path "${oldNormalized}" -> "${newNormalized}"`);
			return;
		}

		// A rename mutates two path namespaces. Lock both in a stable order so a
		// concurrent DiskMirror create/write for the destination cannot slip between
		// the collision check and the physical move.
		await this.runPathWritesLocked([oldNormalized, newNormalized], async () => {
			const initialSourceMarker = this.preservedUnresolved.get(oldNormalized);
			const initialTargetMarker = this.preservedUnresolved.get(newNormalized);
			const initialSourceEpisodeId = initialSourceMarker
				? getPreservedUnresolvedEpisodeId(initialSourceMarker)
				: null;
			const initialTargetEpisodeId = initialTargetMarker
				? getPreservedUnresolvedEpisodeId(initialTargetMarker)
				: null;
			const isIntentCurrent = (): boolean => {
				const currentMeta = this.vaultSync.meta.get(fileId);
				return this.isRemoteProjectionAdmissionCurrent(admission) &&
					!!currentMeta &&
					!isFileMetaDeletedValue(currentMeta) &&
					normalizePath(getMetaPath(currentMeta) ?? "") === newNormalized;
			};
			const preserveCollision = (reason: string): void => {
				// Keep both path namespaces quarantined even when one side is currently
				// absent. A later scan must not repurpose either side until the ambiguous
				// rename episode has been explicitly resolved.
				this.recordPreservedUnresolved(oldNormalized, "path-collision");
				this.recordPreservedUnresolved(newNormalized, "path-collision");
				this.trace?.("disk", "remote-rename-collision-preserved", {
					fileId,
					oldPath: oldNormalized,
					newPath: newNormalized,
					reason,
				});
			};
			const redirectPreservedMarker = (stage: string): boolean => {
				const redirect = this.redirectPreservedUnresolved(oldNormalized, newNormalized);
				if (redirect.kind === "collision") return false;
				if (redirect.kind !== "target-only") return true;

				// fileManager.renameFile emits a vault rename callback before its promise
				// settles. That callback may already have carried the exact source episode
				// to newPath, so a matching target-only result is an idempotent success.
				// Any other target-only marker appeared independently and owns the path.
				if (
					initialSourceEpisodeId !== null &&
					getPreservedUnresolvedEpisodeId(redirect.entry) === initialSourceEpisodeId
				) {
					return true;
				}
				preserveCollision(`preserved-unresolved-target-episode:${stage}`);
				return false;
			};
			if (!isIntentCurrent()) return;
			if (
				initialTargetEpisodeId !== null &&
				(
					initialSourceEpisodeId === null ||
					initialTargetEpisodeId !== initialSourceEpisodeId
				)
			) {
				preserveCollision("preserved-unresolved-target-owned-by-different-episode");
				return;
			}

			const wasOpen = this.openPaths.has(oldNormalized);
			const oldFile = this.app.vault.getAbstractFileByPath(oldNormalized);
			const target = this.app.vault.getAbstractFileByPath(newNormalized);
			if (oldFile instanceof TFile && target) {
				// Never delete either side of a rename collision. Both may contain
				// independent local work; preserve them for explicit resolution.
				preserveCollision("source-and-target-exist");
				return;
			}

			let renameSettled = false;
			let scheduleTargetWrite = false;
			let authorizeTargetCreate = false;

			if (!(oldFile instanceof TFile) && target) {
				// An already-existing target is not proof that this rename settled. It may
				// be unrelated local work. Accept it only when the exact target object and
				// bytes still match this fileId's current Y.Text after the async read.
				if (!(target instanceof TFile)) {
					preserveCollision("target-is-not-a-file");
					return;
				}
				const expectedYText = this.vaultSync.idToText.get(fileId);
				if (!expectedYText) {
					preserveCollision("missing-fileid-ytext");
					return;
				}
				const expectedContent = yTextToString(expectedYText);
				let targetContent: string;
				try {
					targetContent = await this.app.vault.read(target);
				} catch {
					preserveCollision("target-read-failed");
					return;
				}
				const finalOld = this.app.vault.getAbstractFileByPath(oldNormalized);
				const finalTarget = this.app.vault.getAbstractFileByPath(newNormalized);
				const finalYText = this.vaultSync.idToText.get(fileId);
				if (!isIntentCurrent()) return;
				if (
					finalOld instanceof TFile ||
					finalTarget !== target ||
					finalYText !== expectedYText ||
					yTextToString(finalYText) !== expectedContent ||
					targetContent !== expectedContent
				) {
					preserveCollision("existing-target-does-not-match-current-fileid");
					return;
				}
				renameSettled = true;
			}

			if (oldFile instanceof TFile) {
				try {
					const plannedSourceContent = await this.app.vault.read(oldFile);
					if (!isIntentCurrent()) return;
					const dir = newNormalized.substring(0, newNormalized.lastIndexOf("/"));
					if (dir && !this.app.vault.getAbstractFileByPath(normalizePath(dir))) {
						const releaseProjectionCommit =
							this.enterRemoteProjectionCriticalSection(admission);
						if (!releaseProjectionCommit) return;
						try {
							await this.app.vault.createFolder(dir);
						} finally {
							releaseProjectionCommit();
						}
					}
					if (!isIntentCurrent()) return;
					const finalSource = this.app.vault.getAbstractFileByPath(oldNormalized);
					const appearedTarget = this.app.vault.getAbstractFileByPath(newNormalized);
					if (!(finalSource instanceof TFile) || finalSource !== oldFile || appearedTarget) {
						preserveCollision("path-changed-before-rename-commit");
						return;
					}
					const finalSourceContent = await this.app.vault.read(finalSource);
					if (!isIntentCurrent()) return;
					if (
						this.app.vault.getAbstractFileByPath(oldNormalized) !== finalSource ||
						finalSourceContent !== plannedSourceContent ||
						this.app.vault.getAbstractFileByPath(newNormalized)
					) {
						preserveCollision("source-or-target-changed-before-rename-commit");
						return;
					}
					this.pendingRemoteRenames.set(newNormalized, {
						oldPath: oldNormalized,
						newPath: newNormalized,
						file: finalSource,
					});
					const releaseProjectionCommit =
						this.enterRemoteProjectionCriticalSection(admission);
					if (!releaseProjectionCommit) {
						this.retirePendingRemoteRename(
							oldNormalized,
							newNormalized,
							finalSource,
						);
						return;
					}
					try {
						await this.app.fileManager.renameFile(finalSource, newNormalized);
					} finally {
						releaseProjectionCommit();
					}
					// Obsidian emits the matching vault event while renameFile is in
					// flight. If it did not, retire the token now; carrying it into a
					// later user operation would be unsafe.
					this.retirePendingRemoteRename(oldNormalized, newNormalized, finalSource);
				} catch (err) {
					this.retirePendingRemoteRename(oldNormalized, newNormalized, oldFile);
					preserveCollision(
						this.app.vault.getAbstractFileByPath(newNormalized)
							? "target-appeared-during-rename"
							: "rename-preflight-or-commit-failed",
					);
					console.error(`[kaos] handleRemoteRename failed for "${oldNormalized}" -> "${newNormalized}":`, err);
					return;
				}

				const committedSource = this.app.vault.getAbstractFileByPath(oldNormalized);
				const committedTarget = this.app.vault.getAbstractFileByPath(newNormalized);
				if (committedSource !== null || committedTarget !== oldFile) {
					this.retirePendingRemoteRename(oldNormalized, newNormalized, oldFile);
					preserveCollision("rename-result-not-settled");
					return;
				}
				renameSettled = true;
				scheduleTargetWrite = true;
				if (!isIntentCurrent()) {
					// The disk move did commit, so retire all old-path work even though a
					// newer metadata intent won while fileManager was awaiting. Never recreate
					// oldPath from its stale queue.
					this.retirePendingRemoteRename(oldNormalized, newNormalized, oldFile);
					const markerRedirected = redirectPreservedMarker("stale-intent-after-commit");
					this.settleRemoteRenamePathState(oldNormalized, newNormalized, wasOpen);
					if (
						markerRedirected &&
						!this.preservedUnresolved.has(newNormalized)
					) {
						this.recordPreservedUnresolved(newNormalized, "unknown");
					}
					this.trace?.("disk", "remote-rename-intent-stale-after-disk-commit", {
						fileId,
						oldPath: oldNormalized,
						newPath: newNormalized,
					});
					return;
				}
			}

			if (!renameSettled) {
				// Neither side exists. The semantic remote rename authorizes creating the
				// destination, but only after old-path queues have been retired below.
				authorizeTargetCreate = true;
				scheduleTargetWrite = true;
			}

			if (!isIntentCurrent()) return;
			if (!redirectPreservedMarker("before-target-schedule")) {
				this.settleRemoteRenamePathState(oldNormalized, newNormalized, wasOpen);
				return;
			}
			this.settleRemoteRenamePathState(oldNormalized, newNormalized, wasOpen);
			this.log(`handleRemoteRename: "${oldNormalized}" -> "${newNormalized}"`);
			if (scheduleTargetWrite) {
				if (authorizeTargetCreate) this.authorizeRemoteCreate(newNormalized);
				this.scheduleRemoteWrite(newNormalized);
			}
		});
	}

	private settleRemoteRenamePathState(
		oldPath: string,
		newPath: string,
		wasOpen: boolean,
	): void {
		if (wasOpen) {
			this.openPaths.delete(oldPath);
			this.openPaths.add(newPath);
		}
		this.pendingOpenWrites.delete(oldPath);
		for (const timers of [this.debounceTimers, this.openWriteTimers]) {
			const timer = timers.get(oldPath);
			if (timer) clearTimeout(timer);
			timers.delete(oldPath);
		}
		this.writeQueue.delete(oldPath);
		this.forcedWritePaths.delete(oldPath);
		this.remoteProjectionWriteAdmissions.delete(oldPath);
		this.remoteCreateAuthorizations.delete(oldPath);
		this.unobserveText(oldPath);
		this.editorBindings.updatePathsAfterRename(new Map([[oldPath, newPath]]));
		if (wasOpen) this.observeText(newPath);
	}

	private getPreservedUnresolvedEpisode(path: string): string | null {
		const entry = this.preservedUnresolved.get(normalizePath(path));
		return entry ? getPreservedUnresolvedEpisodeId(entry) : null;
	}

	private resolvePreservedUnresolvedEpisode(
		path: string,
		expectedEpisodeId: string | null,
	): void {
		if (expectedEpisodeId === null) return;
		const normalized = normalizePath(path);
		const current = this.preservedUnresolved.get(normalized);
		if (!current || getPreservedUnresolvedEpisodeId(current) !== expectedEpisodeId) return;
		if (this.preservedUnresolved.resolve(normalized)) {
			this.onPreservedUnresolvedChanged?.();
		}
	}

	private ensurePreservedUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		const normalized = normalizePath(path);
		if (this.preservedUnresolved.has(normalized)) {
			this.retirePendingWritesForPreservedPath(normalized);
			return;
		}
		this.recordPreservedUnresolved(normalized, reason);
	}

	private restoreFailedRemoteDeleteObservation(
		path: string,
		wasOpen: boolean,
		wasObserved: boolean,
	): void {
		const normalized = normalizePath(path);
		if (wasOpen) this.openPaths.add(normalized);
		if (wasObserved) this.observeText(normalized);

		const bindingManager = this.editorBindings as unknown as {
			bind?: (view: MarkdownView, deviceName: string) => void;
		};
		if (!wasOpen || typeof bindingManager.bind !== "function") return;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || normalizePath(view.file?.path ?? "") !== normalized) return;
			bindingManager.bind?.(view, this.getDeviceName());
		});
	}

	private async deleteLocalReplica(
		file: TFile,
		isExactDeleteCurrent: (phase: "before" | "after") => boolean = () => true,
		admission?: RemoteProjectionAdmissionLease,
	): Promise<"trash" | "stale"> {
		const failures: string[] = [];
		const fileManager = (this.app as unknown as {
			fileManager?: {
				trashFile?: (file: TFile, system?: boolean) => Promise<void>;
			};
		}).fileManager;
		if (fileManager?.trashFile) {
			if (!isExactDeleteCurrent("before")) return "stale";
			const releaseProjectionCommit =
				this.enterRemoteProjectionCriticalSection(admission);
			if (!releaseProjectionCommit) return "stale";
			try {
				await fileManager.trashFile(file, true);
				return isExactDeleteCurrent("after") ? "trash" : "stale";
			} catch (err) {
				// A trash adapter may move the file and then fail during metadata
				// finalization. Accept an exact missing-path settlement, but never let
				// the fallback borrow a newer same-path TFile or tombstone episode.
				if (isExactDeleteCurrent("after")) return "trash";
				if (!isExactDeleteCurrent("before")) return "stale";
				failures.push(`fileManager.trashFile: ${formatUnknown(err)}`);
			} finally {
				releaseProjectionCommit();
			}
		} else {
			failures.push("fileManager.trashFile: unavailable");
		}
		const vaultTrash = (
			this.app.vault as unknown as {
				trash?: (target: TFile, system: boolean) => Promise<void>;
			}
		).trash;
		if (typeof vaultTrash === "function") {
			if (!isExactDeleteCurrent("before")) return "stale";
			const releaseProjectionCommit =
				this.enterRemoteProjectionCriticalSection(admission);
			if (!releaseProjectionCommit) return "stale";
			try {
				await vaultTrash.call(this.app.vault, file, false);
				return isExactDeleteCurrent("after") ? "trash" : "stale";
			} catch (err) {
				if (isExactDeleteCurrent("after")) return "trash";
				if (!isExactDeleteCurrent("before")) return "stale";
				failures.push(`vault.trash: ${formatUnknown(err)}`);
			} finally {
				releaseProjectionCommit();
			}
		} else {
			failures.push("vault.trash: unavailable");
		}
		throw new Error(`No recoverable trash mechanism succeeded (${failures.join("; ")})`);
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
	}

	/**
	 * Per-path timestamp of the most recent successful KAOS-issued
	 * `flushWrite`. Returns null if KAOS has never written this path in
	 * this session. Used by main.ts to label `disk.modify.observed` events
	 * with writer attribution.
	 */
	getLastDiskWriteOkAt(path: string): number | null {
		const v = this.lastDiskWriteOkAt.get(normalizePath(path));
		return v === undefined ? null : v;
	}

	/**
	 * Read the exact file revision represented by a vault event. TFile objects
	 * are mutable, so both identity and stat values are checked before and after
	 * the asynchronous read. A later write must never become proof for an older
	 * modify event.
	 */
	async readExactObservedDiskRevision(
		file: TFile,
		revision: ObservedDiskMutationRevision,
	): Promise<string | null> {
		if (!this.isObservedDiskRevisionCurrent(file, revision)) return null;
		try {
			// Vault.read is a document API and strips a UTF-8 BOM. The modify-event
			// proof needs the exact disk representation so byte-size validation and
			// conflict preservation remain lossless for BOM/mixed-EOL files.
			const content = await this.app.vault.adapter.read(file.path);
			if (!this.isObservedDiskRevisionCurrent(file, revision)) return null;
			if (
				revision.size !== null &&
				new TextEncoder().encode(content).byteLength !== revision.size
			) {
				return null;
			}
			return content;
		} catch {
			return null;
		}
	}

	/**
	 * Classify the exact observed revision against KAOS's recent intended
	 * write, while returning the same revision's content for the editor reload
	 * guard. This does not consume the reconciliation suppression entry.
	 */
	async probeRecentWriteFingerprint(
		file: TFile,
		revision: ObservedDiskMutationRevision,
	): Promise<RecentWriteFingerprintProbe> {
		const path = normalizePath(revision.path);
		const expected = this.recentWriteFingerprints.get(path);
		const expectedIsFresh =
			expected !== undefined &&
			Date.now() - expected.recordedAt <= RECENT_WRITE_FINGERPRINT_MS;
		if (expected && !expectedIsFresh) {
			this.recentWriteFingerprints.delete(path);
		}

		const content = await this.readExactObservedDiskRevision(file, revision);
		if (content === null) return { kind: "stale-or-unreadable" };
		if (!expectedIsFresh || !expected) return { kind: "unproven", content };

		const observed = await this.fingerprintContent(content);
		if (!this.isObservedDiskRevisionCurrent(file, revision)) {
			return { kind: "stale-or-unreadable" };
		}
		return observed.bytes === expected.expectedBytes &&
			observed.hash === expected.expectedHash
			? { kind: "self-write", content }
			: { kind: "not-self-write", content };
	}

	/** Backward-compatible boolean probe used by suppression diagnostics/tests. */
	async matchesRecentWriteFingerprint(file: TFile): Promise<boolean | null> {
		const revision = this.captureObservedDiskMutationRevision(file);
		const result = await this.probeRecentWriteFingerprint(file, revision);
		if (result.kind === "self-write") return true;
		if (result.kind === "not-self-write") return false;
		return null;
	}

	async shouldSuppressModify(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	async suppressLocalCreate(
		path: string,
		content: string,
	): Promise<LocalCreateSuppressionHandle> {
		return this.suppressWrite(path, content);
	}

	rollbackLocalCreateSuppression(handle: LocalCreateSuppressionHandle): boolean {
		const normalized = normalizePath(handle.path);
		let rolledBack = false;
		if (this.suppressedPaths.get(normalized)?.token === handle.token) {
			this.suppressedPaths.delete(normalized);
			rolledBack = true;
		}
		if (this.recentWriteFingerprints.get(normalized)?.token === handle.token) {
			this.recentWriteFingerprints.delete(normalized);
			rolledBack = true;
		}
		return rolledBack;
	}

	consumeDeleteSuppression(path: string): boolean {
		path = normalizePath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		this.suppressedPaths.delete(path);
		return entry.kind === "delete";
	}

	/**
	 * Returns true if this path was preserved during a remote-delete because
	 * no baseline was available to verify local state.
	 *
	 * Callers (importUntrackedFiles, reconcile scans) MUST check this before
	 * auto-reviving tombstones for local files.
	 */
	isPreservedUnresolved(path: string): boolean {
		return this.preservedUnresolvedPaths.has(normalizePath(path));
	}

	/**
	 * Clear the preserved-unresolved marker for a path. Called when evidence
	 * arrives that the user intentionally wants this file to exist:
	 * - User explicitly edits the file (vault modify event, not suppressed)
	 * - User creates a new file at this path
	 * - User deletes the file locally
	 * - A future remote-delete arrives with a real baseline
	 */
	clearPreservedUnresolved(path: string): void {
		const normalized = normalizePath(path);
		if (this.preservedUnresolved.resolve(normalized)) {
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("disk", "preserved-unresolved-cleared", {
				path: normalized,
				reason: "user-action-or-baseline-available",
			});
		}
	}

	/**
	 * Carry an unresolved episode across a path rename. A destination owned by a
	 * different episode is never overwritten; both namespaces become an explicit
	 * path collision and remain blocked from automatic writes.
	 */
	redirectPreservedUnresolved(
		oldPath: string,
		newPath: string,
	): PreservedUnresolvedRedirectResult {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		const targetBefore = this.preservedUnresolved.get(newNormalized);
		const result = this.preservedUnresolved.move(oldNormalized, newNormalized);
		if (result.kind === "missing") {
			return targetBefore
				? { kind: "target-only", entry: { ...targetBefore } }
				: { kind: "missing" };
		}
		if (result.kind === "collision") {
			this.recordPreservedUnresolved(oldNormalized, "path-collision");
			this.recordPreservedUnresolved(newNormalized, "path-collision");
			const source = this.preservedUnresolved.get(oldNormalized)!;
			const target = this.preservedUnresolved.get(newNormalized)!;
			this.trace?.("disk", "preserved-unresolved-rename-collision", {
				oldPath: oldNormalized,
				newPath: newNormalized,
				sourceEpisodeId: getPreservedUnresolvedEpisodeId(result.source),
				targetEpisodeId: getPreservedUnresolvedEpisodeId(result.target),
			});
			return {
				kind: "collision",
				source: { ...source },
				target: { ...target },
			};
		}
		if (result.kind === "unchanged") return result;

		this.retirePendingWritesForPreservedPath(oldNormalized);
		this.retirePendingWritesForPreservedPath(newNormalized);
		this.onPreservedUnresolvedChanged?.();
		this.trace?.("disk", "preserved-unresolved-redirected", {
			oldPath: oldNormalized,
			newPath: newNormalized,
			episodeId: getPreservedUnresolvedEpisodeId(result.entry),
			reason: result.entry.reason,
		});
		return result;
	}

	recordPreservedUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		const normalized = normalizePath(path);
		const remoteDeleteEntry = isRemoteDeletePreservedUnresolvedEntry({
			kind: "markdown",
			reason,
		});
		const deleteFingerprint = remoteDeleteEntry
			? this.getAuthoritativeMarkdownDeleteFingerprint(normalized)
			: undefined;
		if (remoteDeleteEntry && !deleteFingerprint) {
			// The path revived while asynchronous conflict inspection was in
			// progress; do not manufacture a stale Attention occurrence.
			return;
		}
		this.preservedUnresolved.record({
			path: normalized,
			kind: "markdown",
			reason,
			episodeId: deleteFingerprint
				? getRemoteDeleteEpisodeId("markdown", deleteFingerprint)
				: undefined,
		});
		// A queued provider write may have been admitted before reconciliation
		// discovered the ambiguity. Retire every pending form now; a batch already
		// handed to the drain loop is still stopped by flushWrite's hard guard.
		this.retirePendingWritesForPreservedPath(normalized);
		this.onPreservedUnresolvedChanged?.();
	}

	private retirePendingWritesForPreservedPath(path: string): void {
		const normalized = normalizePath(path);
		this.pendingOpenWrites.delete(normalized);
		this.writeQueue.delete(normalized);
		this.forcedWritePaths.delete(normalized);
		this.remoteProjectionWriteAdmissions.delete(normalized);
		this.remoteCreateAuthorizations.delete(normalized);
		for (const timers of [this.debounceTimers, this.openWriteTimers]) {
			const timer = timers.get(normalized);
			if (timer) clearTimeout(timer);
			timers.delete(normalized);
		}
	}

	private getAuthoritativeMarkdownDeleteFingerprint(path: string): string | null {
		const snapshotGetter = (
			this.vaultSync as unknown as {
				getAuthoritativeMarkdownDeleteSnapshot?: (
					candidate: string,
				) => { fingerprint: string } | null;
			}
		).getAuthoritativeMarkdownDeleteSnapshot;
		if (typeof snapshotGetter === "function") {
			return snapshotGetter.call(this.vaultSync, path)?.fingerprint ?? null;
		}
		const activeIds = this.vaultSync.getActiveFileIdsForPath?.(path) ?? [];
		if (activeIds.length > 0) return null;
		const deleted = typeof this.vaultSync.isPathTombstoned === "function"
			? this.vaultSync.isPathTombstoned(path)
			: typeof this.vaultSync.isMarkdownTombstoned === "function"
				? this.vaultSync.isMarkdownTombstoned(path)
				: true;
		return deleted ? JSON.stringify(["legacy-markdown-delete", path]) : null;
	}

	private bumpRemoteDeleteGeneration(path: string): number {
		const normalized = normalizePath(path);
		const next = (this.remoteDeleteGenerations.get(normalized) ?? 0) + 1;
		this.remoteDeleteGenerations.set(normalized, next);
		return next;
	}

	private authorizeRemoteCreate(path: string): void {
		this.remoteCreateAuthorizations.set(
			normalizePath(path),
			Date.now() + REMOTE_CREATE_AUTHORIZATION_MS,
		);
	}

	private hasRemoteCreateAuthorization(path: string): boolean {
		const normalized = normalizePath(path);
		const expiresAt = this.remoteCreateAuthorizations.get(normalized);
		if (expiresAt === undefined) return false;
		if (expiresAt <= Date.now()) {
			this.remoteCreateAuthorizations.delete(normalized);
			return false;
		}
		return true;
	}

	private isAuthoritativeMarkdownDeleteActiveForWrite(path: string): boolean {
		const normalized = normalizePath(path);
		const snapshotGetter = (
			this.vaultSync as unknown as {
				getAuthoritativeMarkdownDeleteSnapshot?: (
					candidate: string,
				) => { fingerprint: string } | null;
			}
		).getAuthoritativeMarkdownDeleteSnapshot;
		if (typeof snapshotGetter === "function") {
			return snapshotGetter.call(this.vaultSync, normalized) !== null;
		}
		const activeIds = this.vaultSync.getActiveFileIdsForPath?.(normalized) ?? [];
		if (activeIds.length > 0) return false;
		if (typeof this.vaultSync.isPathTombstoned === "function") {
			return this.vaultSync.isPathTombstoned(normalized);
		}
		if (typeof this.vaultSync.isMarkdownTombstoned === "function") {
			return this.vaultSync.isMarkdownTombstoned(normalized);
		}
		// Lightweight legacy harnesses may not expose deletion state. Do not
		// invent a tombstone for ordinary writes in that compatibility case.
		return false;
	}

	private isRemoteDeleteOperationCurrent(
		path: string,
		generation: number,
		expectedFingerprint: string,
		admission: RemoteProjectionAdmissionLease,
	): boolean {
		const normalized = normalizePath(path);
		return this.isRemoteProjectionAdmissionCurrent(admission)
			&& this.remoteDeleteGenerations.get(normalized) === generation
			&& this.getAuthoritativeMarkdownDeleteFingerprint(normalized) === expectedFingerprint;
	}

	private traceStaleRemoteDeleteCancellation(
		path: string,
		generation: number,
		expectedFingerprint: string | null,
		phase: string,
	): void {
		const normalized = normalizePath(path);
		const currentGeneration = this.remoteDeleteGenerations.get(normalized) ?? 0;
		const currentFingerprint = this.getAuthoritativeMarkdownDeleteFingerprint(normalized);
		this.log(
			`handleRemoteDelete: cancelled stale delete for "${normalized}" ` +
			`(phase=${phase}, generation=${generation}->${currentGeneration})`,
		);
		this.trace?.("disk", "remote-delete-cancelled-stale", {
			path: normalized,
			phase,
			generation,
			currentGeneration,
			expectedFingerprintPrefix: hashPrefix(expectedFingerprint),
			currentFingerprintPrefix: hashPrefix(currentFingerprint),
		});
	}

	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		return this.preservedUnresolved.getEntries();
	}

	async flushOpenWrites(reason: string): Promise<void> {
		const targets = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			targets.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			targets.add(path);
		}
		if (targets.size === 0) return;

		for (const path of targets) {
			const timer = this.openWriteTimers.get(path);
			if (timer) {
				clearTimeout(timer);
				this.openWriteTimers.delete(path);
			}
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, reason, true);
		}

		await this.kickDrain();
	}

	async flushOpenPath(path: string, reason: string): Promise<void> {
		path = normalizePath(path);
		const timer = this.openWriteTimers.get(path);
		const hadTimer = !!timer;
		if (timer) {
			clearTimeout(timer);
			this.openWriteTimers.delete(path);
		}
		const wasPending = this.pendingOpenWrites.delete(path);
		const wasQueued = this.writeQueue.has(path);
		if (!wasPending && !hadTimer && !wasQueued) {
			return;
		}
		this.queueImmediateWrite(path, reason, true);
		await this.kickDrain();
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get activeObserverCount(): number {
		return this.textObservers.size;
	}

	get pendingWriteCount(): number {
		return (
			this.writeQueue.size
			+ this.debounceTimers.size
			+ this.openWriteTimers.size
		);
	}

	getDebugSnapshot(): {
		observedPaths: string[];
		openPaths: string[];
		openPendingPaths: string[];
		queuedWrites: string[];
		debounceCount: number;
		openDebounceCount: number;
		suppressedCount: number;
		preservedUnresolved: ReturnType<PreservedUnresolvedRegistry["getSummary"]>;
	} {
		return {
			observedPaths: Array.from(this.textObservers.keys()),
			openPaths: Array.from(this.openPaths.keys()),
			openPendingPaths: Array.from(this.pendingOpenWrites.keys()),
			queuedWrites: Array.from(this.writeQueue.keys()),
			debounceCount: this.debounceTimers.size,
			openDebounceCount: this.openWriteTimers.size,
			suppressedCount: this.suppressedPaths.size,
			preservedUnresolved: this.preservedUnresolved.getSummary(),
		};
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	/**
	 * Flush all pending writes and await completion before teardown.
	 *
	 * Safe ordering for plugin unload:
	 *   1. flushAllPendingWrites()  ← all writes complete, callbacks fire, hashes recorded
	 *   2. caller saves disk index  ← persists content hashes to data.json
	 *   3. destroy()                ← nothing pending, safe to clear state
	 *
	 * Covers:
	 *   - writeQueue (debounced bulk writes)
	 *   - pendingOpenWrites / openWriteTimers (deferred editor writes)
	 *   - existing drain promise (if already draining)
	 */
	async flushAllPendingWrites(): Promise<void> {
		// 1. Flush all pending open-file writes immediately (cancel their timers,
		//    flush now with force=true so editor guards don't defer again).
		const openPending = new Set<string>([
			...this.pendingOpenWrites,
			...this.openWriteTimers.keys(),
		]);
		for (const timer of this.openWriteTimers.values()) {
			clearTimeout(timer);
		}
		this.openWriteTimers.clear();
		this.pendingOpenWrites.clear();
		if (openPending.size > 0) {
			await Promise.all([...openPending].map((p) => {
				const remoteProjectionAdmission =
					this.remoteProjectionWriteAdmissions.get(p);
				if (remoteProjectionAdmission) {
					this.remoteProjectionWriteAdmissions.delete(p);
				}
				return this.flushWrite(p, true, {
					requireRemoteProjectionAdmission:
						remoteProjectionAdmission !== undefined,
					remoteProjectionAdmission,
				});
			}));
		}

		// 2. Also flush anything sitting in the debounce timer queue (those
		//    haven't made it into writeQueue yet).
		const debouncePending = new Set<string>(this.debounceTimers.keys());
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const path of debouncePending) {
			this.writeQueue.add(path);
		}

		// 3. Drain the write queue. If a drain is already running, await it
		//    then do one more pass to catch any items added during this flush.
		if (this.drainPromise) {
			await this.drainPromise;
		}
		if (this.writeQueue.size > 0) {
			await this.kickDrain();
		}

		// 4. Await any outstanding per-path write locks.
		if (this.pathWriteLocks.size > 0) {
			await Promise.allSettled(this.pathWriteLocks.values());
		}
	}

	destroy(): void {
		const pendingFinalWrites = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			pendingFinalWrites.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			pendingFinalWrites.add(path);
		}
		for (const path of pendingFinalWrites) {
			const remoteProjectionAdmission =
				this.remoteProjectionWriteAdmissions.get(path);
			if (remoteProjectionAdmission) {
				this.remoteProjectionWriteAdmissions.delete(path);
			}
			void this.flushWrite(path, true, {
				requireRemoteProjectionAdmission:
					remoteProjectionAdmission !== undefined,
				remoteProjectionAdmission,
			});
		}

		for (const cleanup of this.mapObserverCleanups) {
			cleanup();
		}
		this.mapObserverCleanups = [];

		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.openWriteTimers.values()) {
			clearTimeout(timer);
		}
		this.openWriteTimers.clear();

		this.writeQueue.clear();
		this.pendingOpenWrites.clear();
		this.openPaths.clear();
		this.forcedWritePaths.clear();
		this.remoteProjectionWriteAdmissions.clear();
		this.suppressedPaths.clear();
		this.preservedUnresolved.clear();
		this.pathWriteLocks.clear();
		this.remoteDeleteGenerations.clear();
		this.remoteCreateAuthorizations.clear();
		this.lastDiskWriteOkAt.clear();
		this.recentWriteFingerprints.clear();
		this.log("DiskMirror destroyed");
	}

	private log(msg: string): void {
		this.trace?.("disk", msg);
		if (this.debug) {
			console.debug(`[kaos:disk] ${msg}`);
		}
	}

	private hasRecentEditorActivity(path: string): boolean {
		const lastEditorActivity = this.editorBindings.getLastEditorActivityForPath(path);
		if (lastEditorActivity == null) return false;
		return Date.now() - lastEditorActivity < OPEN_FILE_ACTIVE_GRACE_MS;
	}

	private capturePathEditorAuthority(path: string): PathEditorAuthority {
		try {
			return this.editorBindings.capturePathEditorAuthority(normalizePath(path));
		} catch {
			return { kind: "blocked", reason: "read-failed" };
		}
	}

	private isPathEditorAuthorityLeaseCurrent(lease: EditorAuthorityLease): boolean {
		try {
			return this.editorBindings.isPathEditorAuthorityLeaseCurrent(lease) === true;
		} catch {
			return false;
		}
	}

	private isRemoteDeleteEditorAuthorityCurrent(
		path: string,
		authority: PathEditorAuthority,
	): boolean {
		if (authority.kind === "proven-single") {
			return this.isPathEditorAuthorityLeaseCurrent(authority.lease);
		}
		if (authority.kind === "blocked") return false;
		return this.capturePathEditorAuthority(path).kind === "none";
	}

	private hasUnprovenScheduledEditorAuthority(
		path: string,
		expectedCrdtContent: string | null,
	): boolean {
		if (expectedCrdtContent == null) return false;
		const authority = this.capturePathEditorAuthority(path);
		if (authority.kind === "blocked") return true;
		if (authority.kind === "none") return false;
		return authority.content !== expectedCrdtContent
			|| !this.isPathEditorAuthorityLeaseCurrent(authority.lease);
	}

	private getOpenMarkdownViewsForPath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		const activeView = (this.app.workspace as {
			getActiveViewOfType?: <T>(type: abstract new (...args: never[]) => T) => T | null;
		}).getActiveViewOfType?.(MarkdownView) ?? null;
		if (activeView?.file?.path === path) {
			views.push(activeView);
		}
		const workspace = this.app.workspace as {
			iterateAllLeaves?: (callback: (leaf: { view?: unknown }) => void) => void;
		};
		workspace.iterateAllLeaves?.((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file?.path === path
				&& !views.includes(leaf.view)
			) {
				views.push(leaf.view);
			}
		});
		return views;
	}

	private isOpenInWorkspace(path: string): boolean {
		// Only MarkdownView has unsaved editor authority that requires the idle
		// write scheduler. Bases are file-backed opaque views: their content
		// writes enter the normal queue; the shared authority port still blocks
		// any unsafe write or destructive decision at admission.
		return this.getOpenMarkdownViewsForPath(path).length > 0;
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizePath(path);
		if (this.isPreservedUnresolved(path)) {
			this.log(`queueImmediateWrite: skipping preserved-unresolved path "${path}" (${reason})`);
			this.trace?.("disk", "disk-write-schedule-skipped-preserved-unresolved", {
				path,
				reason,
				force,
			});
			return;
		}
		if (force) {
			this.forcedWritePaths.add(path);
		}
		this.writeQueue.add(path);
		this.log(`queueImmediateWrite: "${path}" (${reason}${force ? ", forced" : ""})`);
		void this.kickDrain();
	}

	private getActiveSuppression(path: string): SuppressionEntry | null {
		path = normalizePath(path);
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) {
			return entry;
		}
		this.suppressedPaths.delete(path);
		return null;
	}

	private async suppressWrite(
		path: string,
		content: string,
	): Promise<LocalCreateSuppressionHandle> {
		// Record the exact content we wrote so vault modify/create events can
		// acknowledge our own write by observed state, not just timing.
		const fingerprint = await this.fingerprintContent(content);
		const normalized = normalizePath(path);
		const token = Object.freeze({});
		this.suppressedPaths.set(normalized, {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
			token,
		});
		const recentFingerprint: RecentWriteFingerprint = {
			recordedAt: Date.now(),
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
			token,
		};
		this.recentWriteFingerprints.delete(normalized);
		while (this.recentWriteFingerprints.size >= RECENT_WRITE_FINGERPRINT_MAX_ENTRIES) {
			const oldestPath = this.recentWriteFingerprints.keys().next().value as string | undefined;
			if (oldestPath === undefined) break;
			this.recentWriteFingerprints.delete(oldestPath);
		}
		this.recentWriteFingerprints.set(normalized, recentFingerprint);
		return Object.freeze({ path: normalized, token });
	}

	private suppressDelete(path: string): void {
		this.suppressedPaths.set(normalizePath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
		});
	}

	private async shouldSuppressWriteEvent(
		file: TFile,
		event: "modify" | "create",
	): Promise<boolean> {
		const path = normalizePath(file.path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(path);
			this.log(`suppression: "${path}" ${event} did not match pending delete`);
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				observedKind: "write",
				reason: "kind-mismatch",
			});
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.event.not_suppressed",
				severity: "warn",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path,
				data: { event, reason: "kind-mismatch", expectedKind: entry.kind },
			});
			return false;
		}

		if (
			typeof file.stat?.size === "number"
			&& typeof entry.expectedBytes === "number"
			&& file.stat.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(path);
			this.log(
				`suppression: "${path}" ${event} size mismatch ` +
				`(expected=${entry.expectedBytes}, observed=${file.stat.size})`,
			);
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				expectedBytes: entry.expectedBytes,
				observedBytes: file.stat.size,
				reason: "size-mismatch",
			});
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.event.not_suppressed",
				severity: "warn",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path,
				data: {
					event,
					reason: "size-mismatch",
					expectedBytes: entry.expectedBytes,
					observedBytes: file.stat.size,
				},
			});
			return false;
		}

		try {
			// Read back the file only when a suppression candidate exists. This
			// keeps the hot path cheap while making self-event detection causal.
			const content = await this.app.vault.adapter.read(file.path);
			const fingerprint = await this.fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				this.suppressedPaths.delete(path);
				this.log(`suppression: acknowledged "${path}" ${event}`);
				this.trace?.("disk", "suppression-acknowledged", {
					path,
					event,
					kind: entry.kind,
					expectedBytes: entry.expectedBytes,
					expectedHashPrefix: hashPrefix(entry.expectedHash),
				});
				return true;
			}
		} catch (err) {
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				reason: "read-failed",
				error: formatUnknown(err),
			});
			// If the file cannot be read here, fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		this.log(`suppression: "${path}" ${event} fingerprint mismatch`);
		this.trace?.("disk", "suppression-mismatch", {
			path,
			event,
			expectedKind: entry.kind,
			expectedBytes: entry.expectedBytes,
			expectedHashPrefix: hashPrefix(entry.expectedHash),
			reason: "fingerprint-mismatch",
		});
		this._flightEventHandler?.({
			priority: "critical",
			kind: "disk.event.not_suppressed",
			severity: "warn",
			scope: "file",
			source: "diskMirror",
			layer: "disk",
			path,
			data: {
				event,
				reason: "fingerprint-mismatch",
				expectedBytes: entry.expectedBytes,
				expectedHashPrefix: hashPrefix(entry.expectedHash),
			},
		});
		return false;
	}

	private async fingerprintContent(content: string): Promise<{ bytes: number; hash: string }> {
		const bytes = new TextEncoder().encode(content);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return {
			bytes: bytes.length,
			hash: arrayBufferToHex(digest),
		};
	}

	private captureObservedDiskMutationRevision(file: TFile): ObservedDiskMutationRevision {
		return {
			path: file.path,
			ctime:
				typeof file.stat?.ctime === "number" && Number.isFinite(file.stat.ctime)
					? file.stat.ctime
					: null,
			mtime:
				typeof file.stat?.mtime === "number" && Number.isFinite(file.stat.mtime)
					? file.stat.mtime
					: null,
			size:
				typeof file.stat?.size === "number" && Number.isFinite(file.stat.size)
					? file.stat.size
					: null,
		};
	}

	private isObservedDiskRevisionCurrent(
		file: TFile,
		revision: ObservedDiskMutationRevision,
	): boolean {
		const path = normalizePath(revision.path);
		if (normalizePath(file.path) !== path) return false;
		const getAbstractFileByPath = (
			this.app.vault as unknown as {
				getAbstractFileByPath?: (candidatePath: string) => unknown;
			}
		).getAbstractFileByPath;
		if (
			typeof getAbstractFileByPath === "function" &&
			getAbstractFileByPath.call(this.app.vault, path) !== file
		) {
			return false;
		}
		const stat = file.stat;
		if (
			revision.ctime !== null &&
			(typeof stat?.ctime !== "number" || stat.ctime !== revision.ctime)
		) {
			return false;
		}
		if (
			revision.mtime !== null &&
			(typeof stat?.mtime !== "number" || stat.mtime !== revision.mtime)
		) {
			return false;
		}
		if (
			revision.size !== null &&
			(typeof stat?.size !== "number" || stat.size !== revision.size)
		) {
			return false;
		}
		return true;
	}

	private runPathWriteLocked<T>(path: string, work: () => Promise<T>): Promise<T> {
		// All flush paths funnel through one per-path promise chain so direct
		// flushes cannot overlap with queued writes for the same file.
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<T>;
		tracked = next.finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return tracked;
	}

	private runPathWritesLocked<T>(paths: string[], work: () => Promise<T>): Promise<T> {
		const normalizedPaths = [...new Set(paths.map((path) => normalizePath(path)))].sort();
		const acquire = (index: number): Promise<T> => {
			const path = normalizedPaths[index];
			if (path === undefined) return work();
			return this.runPathWriteLocked(path, () => acquire(index + 1));
		};
		return acquire(0);
	}
}
