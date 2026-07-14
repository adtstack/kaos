import { type App, arrayBufferToHex, MarkdownView, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import type { TraceRecord } from "../observability/traceContext";
import { getMetaPath, isFileMetaDeletedValue } from "./fileMeta";
import type { MetaChangeBatch } from "./fileMeta";
import { formatUnknown, yTextToString } from "../utils/format";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";
import { isLocalOrigin } from "./origins";
import { contentBaselineHash } from "./diskIndex";
import {
	PreservedUnresolvedRegistry,
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
	| "open-editor-mismatch"
	| "active-editor-unflushed"
	| "recent-editor-activity"
	| "crdt-changed-during-write";

export type DiskWriteResult =
	| { kind: "written"; path: string; isCreate: boolean; contentHash: string; baselineRecorded: boolean }
	| { kind: "unchanged"; path: string }
	| { kind: "deferred"; path: string; reason: DiskWriteDeferReason }
	| { kind: "blocked"; path: string; reason: "frontmatter" }
	| { kind: "failed"; path: string; error: string };

export interface DiskWriteOptions {
	/**
	 * Whether a successful write should immediately advance the persisted
	 * baseline. Conflict winners pass false so the next reconcile must first
	 * observe disk == CRDT before teaching the disk index that the state is clean.
	 */
	recordBaseline?: boolean;
}

type OpenEditorAuthority =
	| { kind: "none" }
	| { kind: "single"; content: string }
	| { kind: "multiple" }
	| { kind: "read-failed" };

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
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;

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
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}

export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/**
	 * Tracks new paths being renamed by DiskMirror in response to remote
	 * metadata changes (handleRemoteRename). Consumed by the vault rename
	 * event handler in main.ts via consumeRemoteRename(), which both reads
	 * and removes the marker in a single call (consume-on-use, matching the
	 * suppressedPaths / consumeDeleteSuppression pattern).
	 */
	private _pendingRemoteRenameNewPaths = new Set<string>();

	/**
	 * Consume the remote-rename marker for `newPath` if present.
	 * Returns true if the rename was DiskMirror-originated (passive receiver).
	 * Removes the marker atomically — safe to call from the vault rename handler.
	 *
	 * @internal Used by main.ts vault rename handler.
	 */
	consumeRemoteRename(newPath: string): boolean {
		const normalized = normalizePath(newPath);
		if (this._pendingRemoteRenameNewPaths.has(normalized)) {
			this._pendingRemoteRenameNewPaths.delete(normalized);
			return true;
		}
		return false;
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
	private _onDiskWriteCallback: ((path: string, contentHash: string, content: string) => void) | null = null;

	/**
	 * Per-path timestamp of the most recent successful `flushWrite`. Updated
	 * on every `vault.modify` and `vault.create` we issue. Read by the main
	 * vault.on("modify") handler so `disk.modify.observed` events can carry
	 * a writerGuess (kaos-write vs external) for diagnostics.
	 */
	private lastDiskWriteOkAt = new Map<string, number>();
	/** Supplied by the plugin; DiskMirror does not own sync-path policy. */
	private isMarkdownPathSyncable: (path: string) => boolean = () => true;

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
	setDiskWriteCallback(callback: (path: string, contentHash: string, content: string) => void): void {
		this._onDiskWriteCallback = callback;
	}

	setMarkdownPathSyncabilityPredicate(predicate: (path: string) => boolean): void {
		this.isMarkdownPathSyncable = predicate;
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
							// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text.toString() returns document content.
							const baselineText = this.vaultSync.idToText.get(change.fileId)?.toString() ?? null;
							void this.handleRemoteDelete(path, { baselineText });
							break;
					}
					case "revived": {
						this.scheduleWrite(normalizePath(change.path));
						break;
					}
					case "path-changed": {
						// Only rename on disk when the entry is active.
						// Tombstone path changes (e.g. from migrateSchemaToV2) must not
						// trigger a disk rename — there is no live file to rename.
						if (!change.isDeleted) {
							void this.handleRemoteRename(
								normalizePath(change.previousPath),
								normalizePath(change.nextPath),
							);
						}
						break;
					}
					case "added": {
						// New file received from remote — schedule write if active.
						if (!change.next.deletedAt && !change.next.deleted) {
							this.scheduleWrite(normalizePath(change.next.path));
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
				this.scheduleWrite(path);
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
			this.scheduleWrite(path);
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

	scheduleWrite(path: string): void {
		path = normalizePath(path);
		if (!this.isMarkdownPathSyncable(path)) {
			this.log(`scheduleWrite: skipping excluded path "${path}"`);
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
		if (!this.isMarkdownPathSyncable(path)) {
			this.log(`scheduleOpenWrite: skipping excluded path "${path}"`);
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
					if (
						this.isActivelyViewedPath(path)
						&& this.hasFocusedEditorUnflushedChanges(path, crdtContent)
					) {
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
						return this.flushWrite(path, force);
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
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path, force, options));
	}

	private async flushWriteUnlocked(
		path: string,
		force: boolean,
		options: DiskWriteOptions,
	): Promise<DiskWriteResult> {
		const normalized = normalizePath(path);

		for (let attempt = 0; attempt < 3; attempt++) {
			const ytext = this.vaultSync.getTextForPath(path);
			if (!ytext) {
				this.log(`flushWrite: no Y.Text for "${path}", skipping`);
				return { kind: "deferred", path: normalized, reason: "missing-ytext" };
			}
			const content = ytext.toJSON();
			const preflightDefer = this.getOpenWriteDeferral(path, content, force, "preflight");
			if (preflightDefer) {
				return preflightDefer;
			}

			try {
				const existing = this.app.vault.getAbstractFileByPath(normalized);
				if (existing instanceof TFile) {
					const currentContent = await this.app.vault.read(existing);
					if (this.didCrdtChangeDuringWrite(path, content, "read")) continue;
					const postReadDefer = this.getOpenWriteDeferral(path, content, force, "post-read");
					if (postReadDefer) {
						return postReadDefer;
					}
					if (currentContent === content) {
						this.log(`flushWrite: "${path}" unchanged, skipping`);
						return { kind: "unchanged", path: normalized };
					}
					if (this.shouldBlockFrontmatterWrite(path, currentContent, content)) {
						return { kind: "blocked", path: normalized, reason: "frontmatter" };
					}

					await this.suppressWrite(path, content);
					if (this.didCrdtChangeDuringWrite(path, content, "suppress")) {
						this.suppressedPaths.delete(normalized);
						continue;
					}
					const preModifyDefer = this.getOpenWriteDeferral(path, content, force, "pre-modify");
					if (preModifyDefer) {
						this.suppressedPaths.delete(normalized);
						return preModifyDefer;
					}
					await this.app.vault.modify(existing, content);
					this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
					this.lastDiskWriteOkAt.set(normalized, Date.now());
					const contentHash = await contentBaselineHash(content);
					const baselineRecorded = options.recordBaseline !== false;
					if (baselineRecorded) {
						this._onDiskWriteCallback?.(normalized, contentHash, content);
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
					return { kind: "written", path: normalized, isCreate: false, contentHash, baselineRecorded };
				} else {
					if (this.shouldBlockFrontmatterWrite(path, null, content)) {
						return { kind: "blocked", path: normalized, reason: "frontmatter" };
					}
					const dir = normalized.substring(0, normalized.lastIndexOf("/"));
					if (dir) {
						const dirExists =
							this.app.vault.getAbstractFileByPath(normalizePath(dir));
						if (!dirExists) {
							await this.app.vault.createFolder(dir);
						}
					}
					if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
						this.log(`flushWrite: "${path}" appeared during create preparation, retrying as update`);
						continue;
					}
					if (this.didCrdtChangeDuringWrite(path, content, "create-folder")) continue;
					const preCreateDefer = this.getOpenWriteDeferral(path, content, force, "pre-create");
					if (preCreateDefer) {
						return preCreateDefer;
					}
					await this.suppressWrite(path, content);
					if (this.didCrdtChangeDuringWrite(path, content, "suppress")) {
						this.suppressedPaths.delete(normalized);
						continue;
					}
					const preCreateWriteDefer = this.getOpenWriteDeferral(path, content, force, "pre-create-write");
					if (preCreateWriteDefer) {
						this.suppressedPaths.delete(normalized);
						return preCreateWriteDefer;
					}
					await this.app.vault.create(normalized, content);
					this.log(
						`flushWrite: created "${path}" on disk (${content.length} chars)`,
					);
					this.lastDiskWriteOkAt.set(normalized, Date.now());
					const contentHash = await contentBaselineHash(content);
					const baselineRecorded = options.recordBaseline !== false;
					if (baselineRecorded) {
						this._onDiskWriteCallback?.(normalized, contentHash, content);
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
					return { kind: "written", path: normalized, isCreate: true, contentHash, baselineRecorded };
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
			this.scheduleWrite(path);
		}
		return { kind: "deferred", path: normalized, reason: "crdt-changed-during-write" };
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
	): DiskWriteResult | null {
		const normalized = normalizePath(path);
		const isOpenOrViewed = this.openPaths.has(path) || this.isOpenInWorkspace(path);
		if (!isOpenOrViewed) return null;

		if (this.hasOpenEditorContentMismatch(path, content)) {
			this.log(
				`flushWrite: deferring open "${path}" ` +
				`(open editor differs from CRDT, phase=${phase})`,
			);
			if (!force) {
				this.scheduleOpenWrite(path);
			}
			return { kind: "deferred", path: normalized, reason: "open-editor-mismatch" };
		}

		if (force) return null;

		if (
			this.isActivelyViewedPath(path)
			&& this.hasFocusedEditorUnflushedChanges(path, content)
		) {
			this.log(
				`flushWrite: deferring open "${path}" ` +
				`(active editor has unflushed changes, phase=${phase})`,
			);
			this.scheduleOpenWrite(path);
			return { kind: "deferred", path: normalized, reason: "active-editor-unflushed" };
		}
		if (this.hasRecentEditorActivity(path)) {
			this.log(`flushWrite: deferring open "${path}" (recent editor activity, phase=${phase})`);
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

		const validation = validateFrontmatterTransition(previousContent, nextContent);
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

	private async handleRemoteDelete(
		path: string,
		options: { baselineText?: string | null } = {},
	): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.isMarkdownPathSyncable(normalized)) {
			this.log(`remote delete: skipping excluded path "${normalized}"`);
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
			hasBaselineText: options.baselineText !== undefined && options.baselineText !== null,
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
			data: { wasOpen, hasBaselineText: options.baselineText !== null && options.baselineText !== undefined },
		});
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
				try {
					// Remote delete decision: determine whether to delete, preserve+revive,
					// or preserve without reviving. Three-way decision avoids conflating
					// "known dirty" with "unknown baseline".
						const ytext = this.vaultSync.getTextForPath(normalized);
						const lastKnownContent =
							options.baselineText !== undefined
								? options.baselineText
								// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text.toString() returns document content.
								: ytext?.toString() ?? null;

					let decision: RemoteDeleteDecision = { kind: "apply-delete" };

					let unresolvedReason: PreservedUnresolvedReason | null = null;

					if (lastKnownContent !== null) {
						const openEditorAuthority = this.getOpenEditorAuthority(normalized);
						if (openEditorAuthority.kind === "single" && openEditorAuthority.content !== lastKnownContent) {
							// Known baseline exists, open editor differs → known dirty,
							// even if Obsidian has not autosaved it to disk yet.
							decision = {
								kind: "preserve-revive",
								diskContent: openEditorAuthority.content,
								contentSource: "editor",
							};
							this.trace?.("disk", "remote-delete-conflict-preserved", {
								path,
								normalizedPath: normalized,
								reason: "local-open-editor-modified-since-last-sync",
								editorLength: openEditorAuthority.content.length,
								crdtLength: lastKnownContent.length,
							});
							this.log(
								`handleRemoteDelete: preserved open editor content for "${path}" ` +
								`(editor ${openEditorAuthority.content.length} chars !== CRDT ${lastKnownContent.length} chars)`,
							);
						} else if (openEditorAuthority.kind === "multiple") {
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
						} else if (openEditorAuthority.kind === "read-failed") {
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

					if (decision.kind === "apply-delete") {
						this.unobserveText(normalized);
						this.openPaths.delete(normalized);
						this.pendingOpenWrites.delete(normalized);
						this.writeQueue.delete(normalized);
						this.forcedWritePaths.delete(normalized);
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
						// Unbind editor before suppressed delete so the vault `delete` event
						// (which skips unbind due to suppression) doesn't leave a stale binding.
						this.editorBindings.unbindByPath(normalized);
						// If this path was previously preserved-unresolved but now
						// we have a baseline proving it's clean, clear the marker.
						if (this.preservedUnresolved.resolve(normalized)) {
							this.onPreservedUnresolvedChanged?.();
						}
						this.suppressDelete(path);
					const deleteMode = await this.deleteLocalReplica(file);
					this.trace?.("disk", "remote-delete-applied", {
						path,
						deleteMode,
						reason: "remote-delete",
					});
					this.log(`handleRemoteDelete: deleted "${path}" from disk`);
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
						// Clear any prior unresolved marker — we now have a baseline.
						if (this.preservedUnresolved.resolve(normalized)) {
							this.onPreservedUnresolvedChanged?.();
						}
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
						try {
							this.vaultSync.ensureFile(
								normalized,
								decision.diskContent,
								this.getDeviceName(),
								{
									reviveTombstone: true,
									reviveReason: "remote-delete-local-dirty-preserved",
								},
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
							// Best-effort: if revive fails, file is still on disk,
							// tombstone remains, importUntrackedFiles can pick it up.
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

	private async handleRemoteRename(oldPath: string, newPath: string): Promise<void> {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		if (oldNormalized === newNormalized) return;
		if (!this.isMarkdownPathSyncable(oldNormalized) || !this.isMarkdownPathSyncable(newNormalized)) {
			this.log(`remote rename: skipping excluded path "${oldNormalized}" -> "${newNormalized}"`);
			return;
		}

		const wasOpen = this.openPaths.delete(oldNormalized);
		if (wasOpen) {
			this.openPaths.add(newNormalized);
		}
		this.pendingOpenWrites.delete(oldNormalized);

		const oldDebounce = this.debounceTimers.get(oldNormalized);
		if (oldDebounce) {
			clearTimeout(oldDebounce);
			this.debounceTimers.delete(oldNormalized);
		}
		const oldOpenDebounce = this.openWriteTimers.get(oldNormalized);
		if (oldOpenDebounce) {
			clearTimeout(oldOpenDebounce);
			this.openWriteTimers.delete(oldNormalized);
		}

		this.writeQueue.delete(oldNormalized);
		this.forcedWritePaths.delete(oldNormalized);
		this.unobserveText(oldNormalized);

		this.editorBindings.updatePathsAfterRename(new Map([[oldNormalized, newNormalized]]));

		const oldFile = this.app.vault.getAbstractFileByPath(oldNormalized);
		if (oldFile instanceof TFile) {
			try {
				const target = this.app.vault.getAbstractFileByPath(newNormalized);
				if (target instanceof TFile) {
					this.suppressDelete(oldNormalized);
					await this.deleteLocalReplica(oldFile);
				} else {
					const dir = newNormalized.substring(0, newNormalized.lastIndexOf("/"));
					if (dir) {
						const dirNode = this.app.vault.getAbstractFileByPath(normalizePath(dir));
						if (!dirNode) {
							await this.app.vault.createFolder(dir);
						}
					}
					// Mark this rename as remote-originated before the vault event fires,
					// so main.ts can consume the marker and skip queueRename.
					// consumeRemoteRename() in the vault handler removes the marker on use.
					// On error (rename throws), the vault event won't fire, so clean up here.
					this._pendingRemoteRenameNewPaths.add(newNormalized);
					try {
						await this.app.fileManager.renameFile(oldFile, newNormalized);
					} catch (renameErr) {
						this._pendingRemoteRenameNewPaths.delete(newNormalized);
						throw renameErr;
					}
				}
				this.log(`handleRemoteRename: "${oldNormalized}" -> "${newNormalized}"`);
			} catch (err) {
				console.error(`[kaos] handleRemoteRename failed for "${oldNormalized}" -> "${newNormalized}":`, err);
			}
		}

		if (wasOpen) {
			this.observeText(newNormalized);
			this.scheduleOpenWrite(newNormalized);
		} else {
			this.scheduleWrite(newNormalized);
		}
	}

	private async deleteLocalReplica(file: TFile): Promise<"trash" | "delete"> {
		const fileManager = (this.app as unknown as {
			fileManager?: {
				trashFile?: (file: TFile, system?: boolean) => Promise<void>;
			};
		}).fileManager;
		if (fileManager?.trashFile) {
			try {
				await fileManager.trashFile(file, true);
				return "trash";
			} catch {
				// Some adapters do not support system trash; fall back to delete.
			}
		}
		await this.app.vault.delete(file);
		return "delete";
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

	async shouldSuppressModify(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	async suppressLocalCreate(path: string, content: string): Promise<void> {
		await this.suppressWrite(path, content);
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
		this.onPreservedUnresolvedChanged?.();
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
			await Promise.all([...openPending].map((p) => this.flushWrite(p, true)));
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
			void this.flushWrite(path, true);
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
		this.suppressedPaths.clear();
		this.preservedUnresolved.clear();
		this.pathWriteLocks.clear();
		this.lastDiskWriteOkAt.clear();
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

	private hasFocusedEditorUnflushedChanges(path: string, expectedCrdtContent: string | null): boolean {
		if (expectedCrdtContent == null) return false;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path !== path) return false;
		try {
			return activeView.editor.getValue() !== expectedCrdtContent;
		} catch {
			// If the editor instance is in flux, conservatively defer one cycle.
			return true;
		}
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
		return this.getOpenMarkdownViewsForPath(path).length > 0;
	}

	private hasOpenEditorContentMismatch(path: string, expectedCrdtContent: string | null): boolean {
		if (expectedCrdtContent == null) return false;
		for (const view of this.getOpenMarkdownViewsForPath(path)) {
			try {
				if (view.editor.getValue() !== expectedCrdtContent) {
					return true;
				}
			} catch {
				// If an open editor is in flux, do not overwrite the disk under it.
				return true;
			}
		}
		return false;
	}

	private getOpenEditorAuthority(path: string): OpenEditorAuthority {
		const views = this.getOpenMarkdownViewsForPath(path);
		if (views.length === 0) return { kind: "none" };

		const contents: string[] = [];
		for (const view of views) {
			try {
				contents.push(view.editor.getValue());
			} catch {
				return { kind: "read-failed" };
			}
		}

		const distinct = [...new Set(contents)];
		if (distinct.length === 0) return { kind: "none" };
		if (distinct.length > 1) return { kind: "multiple" };
		return { kind: "single", content: distinct[0]! };
	}

	private isActivelyViewedPath(path: string): boolean {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return false;
		}
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path === path;
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizePath(path);
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

	private async suppressWrite(path: string, content: string): Promise<void> {
		// Record the exact content we wrote so vault modify/create events can
		// acknowledge our own write by observed state, not just timing.
		const fingerprint = await this.fingerprintContent(content);
		this.suppressedPaths.set(normalizePath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
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
			const content = await this.app.vault.read(file);
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
}
