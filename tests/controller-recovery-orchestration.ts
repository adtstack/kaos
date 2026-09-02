/**
 * Controller-level recovery orchestration test.
 *
 * Drives a localOnly three-way divergence (editor==disk, ≠ CRDT) end-to-end
 * through ReconciliationController and asserts:
 *   - the recovery.* flight-event timeline
 *   - editor.repair.applied fires once per affected view
 *   - editor.heal.applied does NOT fire
 *   - second-pass on a converged file emits recovery.skipped (crdt-current-no-op)
 *   - bound recovery write does not round-trip as a disk.write.* event
 *   - third identical attempt is quarantined (recovery.quarantined +
 *     recovery.loop.detected) without recovery.apply.*
 *   - ORIGIN_DISK_SYNC_RECOVER_BOUND is in LOCAL_STRING_ORIGIN_SET (the
 *     guard that makes round-trip suppression work)
 *
 * Plus targeted source-grep regressions on src/sync/editorBinding.ts
 * verifying that the real EditorBindingManager emits editor.repair.applied
 * from applyBinding() (action==="repair") and editor.heal.applied from
 * heal() after applyDiffToYText.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type MarkdownDirtyReason,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import type {
	ExternalDiskMutationEditorAuthorityLineage,
	InterceptedExternalDiskMutation,
} from "../src/sync/editorBinding";
import type { EnsureFileResult } from "../src/sync/vaultSync";
import { contentBaselineHash } from "../src/sync/diskIndex";
import type {
	PreservedUnresolvedEntry,
	PreservedUnresolvedReason,
} from "../src/sync/preservedUnresolved";
import {
	FLIGHT_KIND,
	FLIGHT_TAXONOMY_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_OPEN_EXTERNAL_EDIT_MERGE,
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
} from "../src/sync/origins";

Object.defineProperty(globalThis, "__KAOS_QA_HARNESS_ENABLED__", {
	configurable: true,
	value: true,
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

function baselineHashSync(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

interface CapturedEvent {
	kind: string;
	path: string;
	data: Record<string, unknown>;
	priority: string;
	severity: string;
	source: string;
	layer: string;
}

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

interface CapturedFlushWrite {
	path: string;
	force: boolean;
	expectedDiskContent: string | undefined;
}

type FlushAuthorityPhase = "before-commit" | "after-commit";

type OpenExternalAuthorityAdvance =
	| "editor-revision"
	| "provider-ytext"
	| "pane-binding-epoch"
	| "visible-marker"
	| "candidate-object"
	| "candidate-epoch"
	| "disk-sequence"
	| "disk-stat"
	| "disk-file"
	| "disk-content"
	| "baseline-hash"
	| "baseline-revision"
	| "lifecycle-generation"
	| "open-view-set";

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path ?? "",
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

// -------------------------------------------------------------------
// Test fixture builder
// -------------------------------------------------------------------

interface Fixture {
	path: string;
	file: TFile;
	view: MarkdownView;
	views: MarkdownView[];
	doc: Y.Doc;
	ytext: Y.Text;
	captured: CapturedEvent[];
	traces: CapturedTrace[];
	repairCalls: Array<{ deviceName: string; reason: string }>;
	transactionOrigins: unknown[];
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setBound(value: boolean): void;
	setOpen(value: boolean): void;
	setRemoteProjectionAllowed(value: boolean): void;
	setDiskIngestSuspendedForQa(value: boolean): void;
	setBaselineContent(content: string): void;
	setBaselineReadHook(hook: (() => Promise<void>) | null): void;
	setEqualitySettlementReadHook(hook: (() => Promise<void>) | null): void;
	setFlushWriteBoundaryHook(hook: (() => void | Promise<void>) | null): void;
	setSelfWriteModifyHook(hook: (() => void | Promise<void>) | null): void;
	setRecentWriteFingerprintMatches(value: boolean): void;
	setRecentWriteFingerprintHook(hook: (() => void | Promise<void>) | null): void;
	advanceOpenExternalAuthority(advance: OpenExternalAuthorityAdvance): void;
	setArtifactWriteFailure(value: boolean, message?: string): void;
	pauseArtifactPreservation(): void;
	waitForArtifactPreservationStart(): Promise<void>;
	releaseArtifactPreservation(): void;
	clearDiskIndex(): void;
	getCreatedFiles(): Map<string, string>;
	getDiscardedRevisions(): Array<{ path: string; contentHash: string; reason: string }>;
	getArtifactPreservationStarts(): string[];
	getArtifactSuppressionRollbackCount(): number;
	getArtifactSuppressionResidueCount(): number;
	getCurrentDiskContent(): string;
	getDiskIndexContentHash(): string | undefined;
	getFlushWriteCalls(): CapturedFlushWrite[];
	getUndoCaptureSeparations(): string[];
	getPreservedUnresolvedCalls(): Array<{ path: string; reason: string }>;
	setPreservedUnresolvedEpisode(reason: PreservedUnresolvedReason, episodeId: string): void;
	clearPreservedUnresolvedEpisode(): void;
	setMarkdownPathSyncable(value: boolean): void;
	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[];
	getPreservedUnresolvedClearCalls(): string[];
	getConflictOperationOrder(): string[];
	getConflictMergeBaseHashes(): string[];
	getBaselineAdvanceCount(): number;
	getDiskIndexPublishCount(): number;
	getSelfWriteMarkerObservations(): Array<{
		activeLeaseCount: number;
		markerPreserved: boolean;
	}>;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
	additionalEditors?: Array<string | { readError: true }>;
	trackPreservedUnresolvedEpisodes?: boolean;
	stripBomOnVaultRead?: boolean;
}): Fixture {
	const path = initial.path;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let ticketRevision = 0;
	let bindingEpoch = 0;
	let isBound = true;
	let isOpen = true;
	let remoteProjectionAllowed = true;
	let diskIngestSuspendedForQa = false;
	let diskIngestPort: DiskIngestPort | null = null;
	const createdFiles = new Map<string, string>();
	const flushWriteCalls: CapturedFlushWrite[] = [];
	const undoCaptureSeparations: string[] = [];
	const preservedUnresolvedCalls: Array<{ path: string; reason: string }> = [];
	const preservedUnresolvedEntries = new Map<string, PreservedUnresolvedEntry>();
	const preservedUnresolvedClearCalls: string[] = [];
	let preservedUnresolvedEpisodeSequence = 0;
	let markdownAttentionGeneration = 0;
	let markdownSyncScopeGeneration = 0;
	let markdownPathSyncable = true;
	const conflictOperationOrder: string[] = [];
	const baselineTexts = new Map<string, string>();
	let baselineReadHook: (() => Promise<void>) | null = null;
	let equalitySettlementReadHook: (() => Promise<void>) | null = null;
	let flushWriteBoundaryHook: (() => void | Promise<void>) | null = null;
	let selfWriteModifyHook: (() => void | Promise<void>) | null = null;
	let recentWriteFingerprintMatches = false;
	let recentWriteFingerprintHook: (() => void | Promise<void>) | null = null;
	const selfWriteMarkerObservations: Array<{
		activeLeaseCount: number;
		markerPreserved: boolean;
	}> = [];
	let primaryReadCount = 0;
	let baselineAdvanceCount = 0;
	let diskIndexPublishCount = 0;
	const conflictMergeBaseHashes: string[] = [];
	let artifactWriteFailure = false;
	let artifactWriteFailureMessage = "artifact write failed";
	const artifactPreservationStarts: string[] = [];
	const artifactSuppressionRollbacks: string[] = [];
	const activeArtifactSuppressions = new Set<number>();
	let artifactSuppressionSequence = 0;
	let artifactPreservationGate: Promise<void> | null = null;
	let releaseArtifactPreservationGate: (() => void) | null = null;
	let artifactPreservationStarted: Promise<void> = Promise.resolve();
	let markArtifactPreservationStarted: (() => void) | null = null;
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {
		[path]: {
			mtime: 0,
			size: initial.crdt.length,
			contentHash: baselineHashSync(initial.crdt),
		},
	};
	baselineTexts.set(baselineHashSync(initial.crdt), initial.crdt);

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const file = makeTFile(path);
	(file as TFile & { stat: { ctime: number; mtime: number; size: number } }).stat = {
		ctime: 1,
		mtime: 1,
		size: initial.disk.length,
	};
	let currentFile = file;
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };
	const additionalViews = (initial.additionalEditors ?? []).map((candidate, index) => {
		const additionalView = new MarkdownView() as MarkdownView & {
			file: TFile;
			editor: { getValue(): string };
		};
		additionalView.file = file;
		additionalView.editor = {
			getValue: () => {
				if (typeof candidate !== "string") {
					throw new Error(`editor read failed for fixture pane ${index + 2}`);
				}
				return candidate;
			},
		};
		return additionalView as MarkdownView;
	});
	const views = [view as MarkdownView, ...additionalViews];

	const captured: CapturedEvent[] = [];
	const traces: CapturedTrace[] = [];
	const discardedRevisions: Array<{ path: string; contentHash: string; reason: string }> = [];
	const repairCalls: Array<{ deviceName: string; reason: string }> = [];
	const transactionOrigins: unknown[] = [];

	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
		if (txn.origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE) {
			// Model the bound editor receiving the controller-origin Y.Text patch.
			// This invalidates the pre-merge ticket and makes the post-merge ticket
			// recapture a required part of flush admission, as it is in production.
			editorContent = ytext.toString();
			ticketRevision++;
		}
	});

	// Path-scoped flight event capture (used by the controller and the
	// editorBindings stub). Mirrors what main.ts wires through
	// recordFlightPathEvent.
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		captured.push(asPathEvent(event));
	};

	// Vault-scoped capture (used by DiskMirror). Augments the same array so
	// disk.write.ok / disk.write.failed land in the timeline.
	const recordFlightEvent = (event: FlightEventInput): void => {
		captured.push(asAnyEvent(event));
	};

	// editorBindings stub. Mimics the real EditorBindingManager wiring:
	// repair() succeeds and emits an editor.repair.applied flight event
	// through the same callback the real manager uses (see src/main.ts).
	//
	// NOTE: this fixture intentionally reports an UNHEALTHY binding so the
	// localOnly recovery branch's binding-health-conditional repair fires.
	// Healthy-binding behavior (no repair on every recovery) is exercised
	// by tests/controller-recovery-orchestration-amplifier.ts.
	const editorBindings = {
		isBound: () => isBound,
		getBindingDebugInfoForView: () => ({
			leafId: "stub-leaf-1",
			storedCmId: "stub-cm-1",
			liveCmId: "stub-cm-1",
			cmMatches: false, // force unhealthy → repair is called
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: false, // force unhealthy
			awarenessMatchesProvider: true,
			yTextMatchesExpected: true,
			undoManagerMatchesFacet: true,
			facetFileId: null,
			expectedFileId: null,
		}),
		repair: (_view: MarkdownView, deviceName: string, reason: string): boolean => {
			repairCalls.push({ deviceName, reason });
			recordFlightPathEvent({
				priority: "important",
				kind: FLIGHT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path,
				data: {
					leafId: "stub-leaf-1",
					cmId: "stub-cm-1",
					reason,
					rapidSwitch: false,
				},
			});
			return true;
		},
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => null,
		captureOpenEditorMutationTicket: (
			ticketPath: string,
			ticketViews: readonly MarkdownView[],
		) => ({
			path: ticketPath,
			views: ticketViews.map((ticketView, index) => {
				let ticketEditorContent: string | null = null;
				try {
					ticketEditorContent = ticketView.editor.getValue();
				} catch {
					// An unreadable view stays represented in the mutation ticket.
				}
				return {
					view: ticketView,
					viewId: `stub-view-${index + 1}`,
					leafId: `stub-leaf-${index + 1}`,
					cm: null,
					cmId: null,
					bindingEpoch,
					editorRevision: ticketRevision,
					editorAuthorityRevision: ticketRevision,
					editorAuthorityContent: ticketEditorContent,
					editorDocument: ticketRevision,
					editorContent: ticketEditorContent,
				};
			}),
		}),
		captureExternalDiskMutationEditorAuthorityLineage: (
			lineagePath: string,
			lineageViews: readonly MarkdownView[],
		) => {
			if (lineageViews.length === 0) return null;
			const snapshots: ExternalDiskMutationEditorAuthorityLineage["views"][number][] = [];
			for (const [index, lineageView] of lineageViews.entries()) {
				if (lineageView.file?.path !== lineagePath) return null;
				let lineageEditorContent: string;
				try {
					lineageEditorContent = lineageView.editor.getValue();
				} catch {
					return null;
				}
				snapshots.push(Object.freeze({
					viewId: `stub-view-${index + 1}`,
					leafId: `stub-leaf-${index + 1}`,
					cmId: `stub-cm-${index + 1}`,
					bindingEpoch,
					editorRevision: ticketRevision,
					editorAuthorityRevision: ticketRevision,
					editorContent: lineageEditorContent,
				}));
			}
			return Object.freeze({
				path: lineagePath,
				views: Object.freeze(snapshots),
			});
		},
		validateOpenEditorMutationTicket: (
			ticket: {
				path: string;
				views: ReadonlyArray<{
					view: MarkdownView;
					leafId: string;
					bindingEpoch: number;
					editorRevision: number;
				}>;
			},
			currentViews: readonly MarkdownView[],
		) => {
			if (
				ticket.path !== path ||
				ticket.views.length !== currentViews.length ||
				ticket.views.some((snapshot, index) => snapshot.view !== currentViews[index])
			) {
				return { current: false as const, reason: "view-set-changed" as const };
			}
			const staleBinding = ticket.views.find((snapshot) => snapshot.bindingEpoch !== bindingEpoch);
			if (staleBinding) {
				return {
					current: false as const,
					reason: "binding-epoch-changed" as const,
					leafId: staleBinding.leafId,
				};
			}
			const staleRevision = ticket.views.find((snapshot) => snapshot.editorRevision !== ticketRevision);
			if (staleRevision) {
				return {
					current: false as const,
					reason: "editor-revision-changed" as const,
					leafId: staleRevision.leafId,
				};
			}
			return { current: true as const };
		},
		separateUndoCaptureForPath: (separatedPath: string) => {
			undoCaptureSeparations.push(separatedPath);
			return 1;
		},
	};

	const app = {
		vault: {
			read: async (f: TFile & { path: string }) => {
				if (f.path !== path && !createdFiles.has(f.path)) throw new Error(`unexpected read: ${f.path}`);
				if (createdFiles.has(f.path)) {
					const createdContent = createdFiles.get(f.path)!;
					return initial.stripBomOnVaultRead && createdContent.charCodeAt(0) === 0xfeff
						? createdContent.slice(1)
						: createdContent;
				}
				primaryReadCount++;
				// Equality ingestion performs one stable read followed by the final
				// updateDiskIndexForPath settlement read. This test-only gate pauses
				// exactly that second boundary read without adding a production seam.
				if (primaryReadCount === 2) await equalitySettlementReadHook?.();
				return initial.stripBomOnVaultRead && diskContent.charCodeAt(0) === 0xfeff
					? diskContent.slice(1)
					: diskContent;
			},
			create: async (createdPath: string, content: string) => {
				if (artifactWriteFailure) throw new Error(artifactWriteFailureMessage);
				if (createdFiles.has(createdPath)) throw new Error("exists");
				conflictOperationOrder.push(`artifact-create:${createdPath}`);
				createdFiles.set(createdPath, content);
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
				read: async (candidatePath: string) => {
					if (createdFiles.has(candidatePath)) return createdFiles.get(candidatePath)!;
					if (candidatePath === path) return diskContent;
					throw new Error(`unexpected adapter read: ${candidatePath}`);
				},
			},
			getAbstractFileByPath: (p: string) => (
				p === path
					? currentFile
					: (createdFiles.has(p) ? makeTFile(p) : null)
			),
			getMarkdownFiles: () => [
				currentFile,
				...Array.from(createdFiles.keys()).map(makeTFile),
			],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) {
					for (const openView of views) cb({ view: openView });
				}
			},
		},
	};

	const vaultSync = {
		connected: true,
		providerSynced: true,
		getTextForPath: (p: string) => (p === path ? ytext : null),
		getActiveMarkdownPaths: () => [path],
		reconcileVault: () => ({
			mode: "authoritative",
			createdOnDisk: [],
			updatedOnDisk: [path],
			seededToCrdt: [],
			untracked: [],
			tombstonedDiskConflicts: [],
			skipped: 0,
		}),
		runIntegrityChecks: () => ({ duplicateIds: 0, orphansCleaned: 0, duplicateActivePaths: 0 }),
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		getFileIdForText: () => "stub-file-id",
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			shouldSuppressCreate: async () => false,
			shouldSuppressModify: async () => false,
			matchesRecentWriteFingerprint: async () => {
				await recentWriteFingerprintHook?.();
				return recentWriteFingerprintMatches;
			},
			suppressLocalCreate: async (_artifactPath: string, content: string) => {
				artifactPreservationStarts.push(content);
				markArtifactPreservationStarted?.();
				markArtifactPreservationStarted = null;
				const gate = artifactPreservationGate;
				if (gate) await gate;
				const token = ++artifactSuppressionSequence;
				activeArtifactSuppressions.add(token);
				return Object.freeze({
					path: _artifactPath,
					token,
				});
			},
			rollbackLocalCreateSuppression: (handle: { path: string; token: number }) => {
				artifactSuppressionRollbacks.push(handle.path);
				return activeArtifactSuppressions.delete(handle.token);
			},
			isPreservedUnresolved: (candidatePath: string) =>
				initial.trackPreservedUnresolvedEpisodes === true &&
				preservedUnresolvedEntries.has(candidatePath),
			getPreservedUnresolvedEntries: () =>
				initial.trackPreservedUnresolvedEpisodes
					? Array.from(preservedUnresolvedEntries.values())
					: [],
			clearPreservedUnresolved: (candidatePath: string) => {
				preservedUnresolvedClearCalls.push(candidatePath);
				preservedUnresolvedEntries.delete(candidatePath);
			},
			redirectPreservedUnresolved: (oldPath: string, newPath: string) => {
				const source = preservedUnresolvedEntries.get(oldPath);
				if (!source) return { kind: "missing" as const };
				const target = preservedUnresolvedEntries.get(newPath);
				if (target) return { kind: "collision" as const, source, target };
				const moved = { ...source, path: newPath };
				preservedUnresolvedEntries.delete(oldPath);
				preservedUnresolvedEntries.set(newPath, moved);
				return { kind: "moved" as const, entry: moved };
			},
			flushWrite: async (
				flushPath: string,
				force = false,
			options: {
				expectedDiskContent?: string;
				recordBaseline?: boolean;
				isAuthorityCurrent?: (phase: FlushAuthorityPhase) => boolean;
				requireRemoteProjectionAdmission?: boolean;
				remoteProjectionAdmission?: {
					isCurrent(): boolean;
				};
			} = {},
			) => {
				if (
					options.requireRemoteProjectionAdmission === true &&
					options.remoteProjectionAdmission?.isCurrent() !== true
				) {
					return {
						kind: "deferred" as const,
						path: flushPath,
						reason: "remote-projection-not-ready" as const,
					};
				}
				flushWriteCalls.push({
					path: flushPath,
					force,
					expectedDiskContent: options.expectedDiskContent,
				});
				await flushWriteBoundaryHook?.();
				if (options.isAuthorityCurrent && !options.isAuthorityCurrent("before-commit")) {
					return {
						kind: "deferred" as const,
						path: flushPath,
						reason: "authority-stale" as const,
					};
				}
				if (
					options.expectedDiskContent !== undefined &&
					diskContent !== options.expectedDiskContent
				) {
					return {
						kind: "deferred" as const,
						path: flushPath,
						reason: "disk-changed-during-write" as const,
					};
				}
				const writtenContent = ytext.toJSON();
				diskContent = writtenContent;
				if (options.isAuthorityCurrent) {
					// Mirror the two legitimate effects of DiskMirror's own atomic write.
					// The controller lease must tolerate these only after commit while all
					// editor/Y.Text/baseline/lifecycle/candidate fences remain active.
					const mutableFile = currentFile as TFile & {
						stat: { ctime?: number; mtime: number; size: number };
					};
					mutableFile.stat = {
						...mutableFile.stat,
						mtime: mutableFile.stat.mtime + 1,
						size: writtenContent.length,
					};
					// Model production's synchronous vault.modify callback, not only the
					// controller disk-event counter. A successful KAOS write must not make
					// its own unchanged visible editor authority look like a competing edit.
					await selfWriteModifyHook?.();
					const markerBeforeSelfWrite = getVisibleAuthorityMarkerForTest(
						controller,
						flushPath,
					);
					const activeLeaseCount = getActiveOpenFlushLeaseCountForTest(
						controller,
						flushPath,
					);
					controller.markMarkdownDirty(
						currentFile,
						"modify",
						"op-kaos-self-write",
					);
					selfWriteMarkerObservations.push({
						activeLeaseCount,
						markerPreserved:
							getVisibleAuthorityMarkerForTest(controller, flushPath) ===
							markerBeforeSelfWrite,
					});
					if (!options.isAuthorityCurrent("after-commit")) {
						return {
							kind: "deferred" as const,
							path: flushPath,
							reason: "authority-stale" as const,
						};
					}
				}
				return {
					kind: "written" as const,
					path: flushPath,
					isCreate: false,
					content: writtenContent,
					contentHash: baselineHashSync(writtenContent),
					baselineRecorded: options.recordBaseline !== false,
				};
			},
			recordPreservedUnresolved: (unresolvedPath: string, reason: string) => {
				preservedUnresolvedCalls.push({ path: unresolvedPath, reason });
				conflictOperationOrder.push(`preserved-unresolved:${unresolvedPath}:${reason}`);
				if (initial.trackPreservedUnresolvedEpisodes) {
					const previous = preservedUnresolvedEntries.get(unresolvedPath);
					const continuesEpisode = previous?.reason === reason;
					const at = Date.now();
					preservedUnresolvedEntries.set(unresolvedPath, {
						path: unresolvedPath,
						kind: "markdown",
						reason: reason as PreservedUnresolvedReason,
						episodeId: continuesEpisode
							? previous.episodeId
							: `fixture-episode-${++preservedUnresolvedEpisodeSequence}`,
						firstSeenAt: continuesEpisode ? previous.firstSeenAt : at,
						lastSeenAt: at,
					});
				}
			},
			captureRemoteProjectionAdmission: () => (
				remoteProjectionAllowed
					? { isCurrent: () => remoteProjectionAllowed }
					: null
			),
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as never,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: Record<string, { mtime: number; size: number; contentHash?: string }>) => {
			diskIndexPublishCount++;
			diskIndex = next;
		},
		getBaselineText: async (hash: string) => {
			await baselineReadHook?.();
			return baselineTexts.get(hash) ?? null;
		},
		recordBaselineText: () => { baselineAdvanceCount++; },
		recordConflictMergeBase: (_artifactPath: string, hash: string) => {
			conflictMergeBaseHashes.push(hash);
		},
		isMarkdownPathSyncable: () => markdownPathSyncable,
		isRemoteProjectionAllowed: () => remoteProjectionAllowed,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details?: Record<string, unknown>) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
		isDiskIngestSuspendedForQa: () => diskIngestSuspendedForQa,
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
		recordDiscardedRevision: (path, contentHash, reason) => {
			discardedRevisions.push({ path, contentHash, reason });
		},
	});
	const generationDeps = (controller as never as {
		deps: {
			getMarkdownAttentionGeneration?: () => number;
			getMarkdownSyncScopeGeneration?: () => number;
		};
	}).deps;
	generationDeps.getMarkdownAttentionGeneration = () => markdownAttentionGeneration;
	generationDeps.getMarkdownSyncScopeGeneration = () => markdownSyncScopeGeneration;

	return {
		path,
		file,
		view,
		views,
		doc,
		ytext,
		captured,
		traces,
		repairCalls,
		transactionOrigins,
		controller,
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => {
			editorContent = c;
			ticketRevision++;
		},
		setBound: (value) => { isBound = value; },
		setOpen: (value) => { isOpen = value; },
		setRemoteProjectionAllowed: (value) => { remoteProjectionAllowed = value; },
		setDiskIngestSuspendedForQa: (value) => { diskIngestSuspendedForQa = value; },
		setBaselineContent: (c) => {
			const hash = baselineHashSync(c);
			baselineTexts.set(hash, c);
			diskIndex = {
				[path]: {
					mtime: 0,
					size: c.length,
					contentHash: hash,
				},
			};
		},
		setBaselineReadHook: (hook) => { baselineReadHook = hook; },
		setEqualitySettlementReadHook: (hook) => { equalitySettlementReadHook = hook; },
		setFlushWriteBoundaryHook: (hook) => { flushWriteBoundaryHook = hook; },
		setSelfWriteModifyHook: (hook) => { selfWriteModifyHook = hook; },
		setRecentWriteFingerprintMatches: (value) => {
			recentWriteFingerprintMatches = value;
		},
		setRecentWriteFingerprintHook: (hook) => {
			recentWriteFingerprintHook = hook;
		},
		advanceOpenExternalAuthority: (advance) => {
			if (advance === "editor-revision") {
				ticketRevision++;
				return;
			}
			if (advance === "provider-ytext") {
				doc.transact(() => {
					ytext.insert(ytext.length, "\nprovider authority advanced");
				}, { provider: "open-external-baseline-race" });
				return;
			}
			if (advance === "pane-binding-epoch") {
				bindingEpoch++;
				return;
			}
			if (advance === "visible-marker") {
				(controller as never as {
					visibleAuthorityDeferredPaths: Map<string, unknown>;
				}).visibleAuthorityDeferredPaths.set(path, {
					editorContents: [editorContent],
					readComplete: true,
					capturedDiskContent: diskContent,
					capturedCrdtContent: ytext.toString(),
					capturedDiskRevision: 0,
					capturedEditorActivity: null,
					capturedEditorTicket: null,
					capturedAt: Date.now(),
				});
				return;
			}
			if (advance === "candidate-object") {
				controller.noteInterceptedExternalDiskMutation(
					makeInterceptedCandidate(path, diskContent, 999),
				);
				clearMarkdownDrainTimer(controller);
				return;
			}
			if (advance === "candidate-epoch") {
				const internals = controller as never as {
					externalCandidateIdentityEpochs: Map<string, number>;
				};
				internals.externalCandidateIdentityEpochs.set(
					path,
					(internals.externalCandidateIdentityEpochs.get(path) ?? 0) + 1,
				);
				return;
			}
			if (advance === "disk-sequence") {
				controller.noteMarkdownDiskMutation(path);
				(controller as never as {
					queueDirtyMarkdownPath(
						candidatePath: string,
						reason: MarkdownDirtyReason,
						opId?: string,
					): void;
				}).queueDirtyMarkdownPath(
					path,
					"modify",
					`op-open-external-${advance}-replacement`,
				);
				return;
			}
			if (advance === "disk-stat") {
				const mutableFile = file as TFile & { stat: { mtime: number; size: number } };
				mutableFile.stat = {
					...mutableFile.stat,
					mtime: mutableFile.stat.mtime + 1,
				};
				return;
			}
			if (advance === "disk-file") {
				const replacement = makeTFile(path);
				(replacement as TFile & { stat: { ctime: number; mtime: number; size: number } }).stat = {
					ctime: 2,
					mtime: 1,
					size: diskContent.length,
				};
				currentFile = replacement;
				return;
			}
			if (advance === "disk-content") {
				diskContent = `${diskContent}\nnewer raw disk authority`;
				return;
			}
			if (advance === "baseline-hash") {
				diskIndex = {
					...diskIndex,
					[path]: {
						...(diskIndex[path] ?? { mtime: 0, size: diskContent.length }),
						contentHash: baselineHashSync("newer baseline authority"),
					},
				};
				return;
			}
			if (advance === "baseline-revision") {
				controller.noteDiskBaselineSettlement(path);
				return;
			}
			if (advance === "open-view-set") {
				isOpen = false;
				return;
			}
			controller.revokeAsyncAuthority();
		},
		setArtifactWriteFailure: (value, message) => {
			artifactWriteFailure = value;
			if (message !== undefined) artifactWriteFailureMessage = message;
		},
		pauseArtifactPreservation: () => {
			artifactPreservationStarted = new Promise<void>((resolve) => {
				markArtifactPreservationStarted = resolve;
			});
			artifactPreservationGate = new Promise<void>((resolve) => {
				releaseArtifactPreservationGate = resolve;
			});
		},
		waitForArtifactPreservationStart: () => artifactPreservationStarted,
		releaseArtifactPreservation: () => {
			const release = releaseArtifactPreservationGate;
			releaseArtifactPreservationGate = null;
			artifactPreservationGate = null;
			release?.();
		},
		clearDiskIndex: () => {
			diskIndex = {};
		},
		getCreatedFiles: () => createdFiles,
		getDiscardedRevisions: () => discardedRevisions,
		getArtifactPreservationStarts: () => [...artifactPreservationStarts],
		getArtifactSuppressionRollbackCount: () => artifactSuppressionRollbacks.length,
		getArtifactSuppressionResidueCount: () => activeArtifactSuppressions.size,
		getCurrentDiskContent: () => diskContent,
		getDiskIndexContentHash: () => diskIndex[path]?.contentHash,
		getFlushWriteCalls: () => [...flushWriteCalls],
		getUndoCaptureSeparations: () => [...undoCaptureSeparations],
		getPreservedUnresolvedCalls: () => [...preservedUnresolvedCalls],
		setPreservedUnresolvedEpisode: (reason, episodeId) => {
			const at = Date.now();
			preservedUnresolvedEntries.set(path, {
				path,
				kind: "markdown",
				reason,
				episodeId,
				firstSeenAt: at,
				lastSeenAt: at,
			});
			markdownAttentionGeneration++;
		},
		clearPreservedUnresolvedEpisode: () => {
			if (preservedUnresolvedEntries.delete(path)) markdownAttentionGeneration++;
		},
		setMarkdownPathSyncable: (value) => {
			if (markdownPathSyncable === value) return;
			markdownPathSyncable = value;
			markdownSyncScopeGeneration++;
		},
		getPreservedUnresolvedEntries: () => Array.from(preservedUnresolvedEntries.values()),
		getPreservedUnresolvedClearCalls: () => [...preservedUnresolvedClearCalls],
		getConflictOperationOrder: () => [...conflictOperationOrder],
		getConflictMergeBaseHashes: () => [...conflictMergeBaseHashes],
		getBaselineAdvanceCount: () => baselineAdvanceCount,
		getDiskIndexPublishCount: () => diskIndexPublishCount,
		getSelfWriteMarkerObservations: () => [...selfWriteMarkerObservations],
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
	};
}

interface UnboundIngestFixture {
	path: string;
	file: TFile;
	ytext: Y.Text;
	controller: ReconciliationController;
	diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }>;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setStableReader(reader: (path: string, reason: MarkdownDirtyReason) => Promise<StableMarkdownReadResult>): void;
	setOpen(value: boolean): void;
	setPreservedUnresolved(value: boolean, reason?: "remote-delete-missing-baseline" | "path-collision"): void;
	getPreservedClearCount(): number;
	getPreservedRedirects(): Array<{ oldPath: string; newPath: string }>;
	getPreservedPath(): string | null;
	setCrdtPath(path: string): void;
	setFilePath(path: string): void;
	ingestNow(reason?: MarkdownDirtyReason): Promise<void>;
	processDirty(path: string, reason?: MarkdownDirtyReason): Promise<void>;
}

function buildUnboundIngestFixture(initial: {
	path: string;
	disk: string;
	crdt: string;
}): UnboundIngestFixture {
	const path = initial.path;
	const file = makeTFile(path);
	let currentFilePath = path;
	let diskContent = initial.disk;
	let editorContent = initial.disk;
	let stableReader = async (_path: string, _reason: MarkdownDirtyReason): Promise<StableMarkdownReadResult> => ({
		kind: "ready",
		file,
		content: diskContent,
		stat: { mtime: 1, size: diskContent.length },
	});
	let isOpen = false;
	let preservedPath: string | null = null;
	let preservedReason: "remote-delete-missing-baseline" | "path-collision" =
		"remote-delete-missing-baseline";
	let exposePreservedEntry = false;
	let preservedClearCount = 0;
	const preservedRedirects: Array<{ oldPath: string; newPath: string }> = [];
	let crdtPath = path;
	let diskIndex: Record<string, { mtime: number; size: number; contentHash?: string }> = {};

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const app = {
		vault: {
			read: async () => diskContent,
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === currentFilePath ? file : null),
			getMarkdownFiles: () => [file],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				if (isOpen) cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: (p: string) => (p === crdtPath ? ytext : null),
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		getFileIdForText: () => "unbound-file-id",
		ensureFile: (_path: string, content: string) => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, content);
			return { kind: "created" as const, fileId: "unbound-file-id", ytext };
		},
		isPendingRenameTarget: () => false,
	};

	const diskMirror = {
		shouldSuppressCreate: async () => false,
		shouldSuppressModify: async () => false,
		isPreservedUnresolved: (candidatePath: string) => preservedPath === candidatePath,
		getPreservedUnresolvedEntries: () => preservedPath === null || !exposePreservedEntry
			? []
			: [{
				path: preservedPath,
				kind: "markdown" as const,
				reason: preservedReason,
				episodeId: "rename-window-episode",
				firstSeenAt: 1,
				lastSeenAt: 1,
			}],
		clearPreservedUnresolved: (candidatePath: string) => {
			if (preservedPath === candidatePath) {
				preservedPath = null;
				preservedClearCount++;
			}
		},
		redirectPreservedUnresolved: (oldPath: string, newPath: string) => {
			preservedRedirects.push({ oldPath, newPath });
			if (preservedPath === oldPath) {
				preservedPath = newPath;
				return {
					kind: "moved" as const,
					entry: {
						path: newPath,
						kind: "markdown" as const,
						reason: preservedReason,
						episodeId: "rename-window-episode",
						firstSeenAt: 1,
						lastSeenAt: 1,
					},
				};
			}
			if (preservedPath === newPath) {
				return {
					kind: "target-only" as const,
					entry: {
						path: newPath,
						kind: "markdown" as const,
						reason: preservedReason,
						episodeId: "rename-window-episode",
						firstSeenAt: 1,
						lastSeenAt: 1,
					},
				};
			}
			return { kind: "missing" as const };
		},
		flushWrite: async () => {},
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next: typeof diskIndex) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		readStableMarkdownFile: (p, reason) => stableReader(p, reason),
	});

	return {
		path,
		file,
		ytext,
		controller,
		get diskIndex() { return diskIndex; },
		setDiskContent: (content) => { diskContent = content; },
		setEditorContent: (content) => { editorContent = content; },
		setStableReader: (reader) => { stableReader = reader; },
		setOpen: (value) => { isOpen = value; },
		setPreservedUnresolved: (value, reason = "remote-delete-missing-baseline") => {
			preservedPath = value ? currentFilePath : null;
			preservedReason = reason;
			// Legacy fixture cases exercise the boolean compatibility surface. The
			// rename-window regression needs the full episode returned at admission.
			exposePreservedEntry = value && reason === "path-collision";
		},
		getPreservedClearCount: () => preservedClearCount,
		getPreservedRedirects: () => [...preservedRedirects],
		getPreservedPath: () => preservedPath,
		setCrdtPath: (nextPath) => { crdtPath = nextPath; },
		setFilePath: (nextPath) => {
			currentFilePath = nextPath;
			file.path = nextPath;
			view.file = file;
		},
		ingestNow: (reason: MarkdownDirtyReason = "modify") =>
			(controller as never as { syncFileFromDisk(file: TFile, reason: MarkdownDirtyReason): Promise<void> })
				.syncFileFromDisk(file, reason),
		processDirty: (dirtyPath: string, reason: MarkdownDirtyReason = "modify") =>
			(controller as never as {
				processDirtyMarkdownPath(path: string, entry: {
					reason: MarkdownDirtyReason;
					primaryOpId?: string;
					coalescedOpIds: string[];
					retryCount: number;
				}): Promise<void>;
			}).processDirtyMarkdownPath(dirtyPath, {
				reason,
				primaryOpId: "op-test",
				coalescedOpIds: ["op-test"],
				retryCount: 0,
			}),
	};
}

function clearMarkdownDrainTimer(controller: ReconciliationController): void {
	const internals = controller as never as {
		markdownDrainTimer: ReturnType<typeof setTimeout> | null;
	};
	if (internals.markdownDrainTimer) {
		clearTimeout(internals.markdownDrainTimer);
		internals.markdownDrainTimer = null;
	}
}

async function drainQueuedMarkdown(controller: ReconciliationController): Promise<void> {
	clearMarkdownDrainTimer(controller);
	await (controller as never as { drainDirtyMarkdownPaths(): Promise<void> })
		.drainDirtyMarkdownPaths();
	clearMarkdownDrainTimer(controller);
}

function makeInterceptedCandidate(
	path: string,
	content: string,
	sequence: number,
	options: {
		editorAuthorityLineage?: ExternalDiskMutationEditorAuthorityLineage;
		observedAt?: number;
	} = {},
): InterceptedExternalDiskMutation {
	return Object.freeze({
		path,
		content,
		sequence,
		observedAt: options.observedAt ?? sequence,
		ctime: sequence,
		mtime: sequence,
		size: content.length,
		editorAuthorityLineage: options.editorAuthorityLineage,
	});
}

function makeExternalEditorLineage(
	path: string,
	editorAuthorityRevision: number,
	editorRevision = editorAuthorityRevision,
	options: {
		editorContent?: string;
	} = {},
): ExternalDiskMutationEditorAuthorityLineage {
	return Object.freeze({
		path,
		views: Object.freeze([Object.freeze({
			viewId: "view-1",
			leafId: "leaf-1",
			cmId: "cm-1",
			bindingEpoch: 4,
			editorRevision,
			editorAuthorityRevision,
			editorContent: options.editorContent ?? "visible editor authority\n",
		})]),
	});
}

function captureFixtureExternalEditorLineage(
	fix: Fixture,
): ExternalDiskMutationEditorAuthorityLineage {
	const bindings = (fix.controller as never as {
		deps: {
			getEditorBindings(): {
				captureExternalDiskMutationEditorAuthorityLineage(
					path: string,
					views: readonly MarkdownView[],
				): ExternalDiskMutationEditorAuthorityLineage | null;
			};
		};
	}).deps.getEditorBindings();
	const lineage = bindings.captureExternalDiskMutationEditorAuthorityLineage(
		fix.path,
		fix.views,
	);
	if (!lineage) throw new Error("fixture failed to capture external editor lineage");
	return lineage;
}

function getInterceptedCandidates(
	controller: ReconciliationController,
): Map<string, InterceptedExternalDiskMutation> {
	return (controller as never as {
		interceptedExternalDiskMutations: Map<string, InterceptedExternalDiskMutation>;
	}).interceptedExternalDiskMutations;
}

function getPendingSupersededCandidates(
	controller: ReconciliationController,
): InterceptedExternalDiskMutation[] {
	const pending = (controller as never as {
		pendingSupersededExternalDiskMutations?: Map<
			string,
			InterceptedExternalDiskMutation[]
		>;
	}).pendingSupersededExternalDiskMutations;
	return pending ? Array.from(pending.values()).flat() : [];
}

function getOwnedSupersededFailure(
	controller: ReconciliationController,
	path: string,
): { episodeId: string } | undefined {
	return (controller as never as {
		supersededExternalPreservationFailures: Map<string, { episodeId: string }>;
	}).supersededExternalPreservationFailures.get(path);
}

function getDirtyMarkdownEntry(
	controller: ReconciliationController,
	path: string,
): {
	reason: MarkdownDirtyReason;
	primaryOpId?: string;
	coalescedOpIds: string[];
	notBeforeMs?: number;
} | undefined {
	return (controller as never as {
		dirtyMarkdownPaths: Map<string, {
			reason: MarkdownDirtyReason;
			primaryOpId?: string;
			coalescedOpIds: string[];
			notBeforeMs?: number;
		}>;
	}).dirtyMarkdownPaths.get(path);
}

function clearDirtyMarkdownEntry(
	controller: ReconciliationController,
	path: string,
): void {
	(controller as never as {
		dirtyMarkdownPaths: Map<string, unknown>;
	}).dirtyMarkdownPaths.delete(path);
}

function getMarkdownDiskRevisionForTest(
	controller: ReconciliationController,
	path: string,
): number {
	return (controller as never as {
		getMarkdownDiskRevision(candidatePath: string): number;
	}).getMarkdownDiskRevision(path);
}

function getVisibleAuthorityMarkerForTest(
	controller: ReconciliationController,
	path: string,
): unknown {
	return (controller as never as {
		visibleAuthorityDeferredPaths: Map<string, unknown>;
	}).visibleAuthorityDeferredPaths.get(path);
}

function getActiveOpenFlushLeaseCountForTest(
	controller: ReconciliationController,
	path?: string,
): number {
	const registry = (controller as never as {
		activeOpenFlushAuthorityLeases?: Map<string, Set<unknown>>;
	}).activeOpenFlushAuthorityLeases;
	if (!registry) return -1;
	if (path === undefined) {
		let total = 0;
		for (const leases of registry.values()) total += leases.size;
		return total;
	}
	return registry.get(path)?.size ?? 0;
}

function assertSettledSelfWriteLease(
	fix: Fixture,
	label: string,
): void {
	const observation = fix.getSelfWriteMarkerObservations().at(-1);
	assertEq(
		observation?.activeLeaseCount,
		1,
		`${label}: self-write event runs inside exactly one controller lease`,
	);
	assert(
		observation?.markerPreserved === true,
		`${label}: self-write preserves the exact target-valued marker`,
	);
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller),
		0,
		`${label}: successful settlement releases its active flush lease`,
	);
}

async function waitForAsyncCondition(
	condition: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

async function invokeBoundFileSyncGap(
	fix: Fixture,
	existingText: Y.Text | null = fix.ytext,
): Promise<{
	kind: string;
	settlement?: {
		content: string;
		expectedYText: Y.Text | null;
		expectedCrdtContent: string | null;
		expectedEditorTicket: unknown;
	};
	deferUntil?: number;
	reason?: string;
}> {
	return (fix.controller as never as {
		handleBoundFileSyncGap(
			file: TFile,
			content: string,
			existingText: Y.Text | null,
			openViews: MarkdownView[],
			sourceReason: "create" | "modify",
			stableStat: { mtime: number; size: number },
			shouldAbort: () => boolean,
		): Promise<{
			kind: string;
			settlement?: {
				content: string;
				expectedYText: Y.Text | null;
				expectedCrdtContent: string | null;
				expectedEditorTicket: unknown;
			};
			deferUntil?: number;
			reason?: string;
		}>;
	}).handleBoundFileSyncGap(
		fix.file,
		fix.getCurrentDiskContent(),
		existingText,
		fix.views,
		"modify",
		{ mtime: 1, size: fix.getCurrentDiskContent().length },
		() => false,
	);
}

async function invokeStartupOpenFileReconcileDivergence(
	fix: Fixture,
): Promise<boolean> {
	return (fix.controller as never as {
		handleOpenFileReconcileDivergence(
			path: string,
			diskContent: string,
			ytext: Y.Text | null,
			openViews: MarkdownView[],
			file: TFile | null,
		): Promise<boolean>;
	}).handleOpenFileReconcileDivergence(
		fix.path,
		fix.getCurrentDiskContent(),
		fix.ytext,
		fix.views,
		fix.file,
	);
}

// -------------------------------------------------------------------
// Test 0 — taxonomy + flight kinds present
// -------------------------------------------------------------------

console.log("\n--- Test 0: flight taxonomy bumped and new kinds present ---");
{
	assertEq(FLIGHT_TAXONOMY_VERSION, 11, "FLIGHT_TAXONOMY_VERSION === 11");
	assertEq(FLIGHT_KIND.recoverySkipped, "recovery.skipped", "FLIGHT_KIND.recoverySkipped");
	assertEq(FLIGHT_KIND.editorRepairApplied, "editor.repair.applied", "FLIGHT_KIND.editorRepairApplied");
	assertEq(FLIGHT_KIND.editorHealApplied, "editor.heal.applied", "FLIGHT_KIND.editorHealApplied");
	assertEq(
		FLIGHT_KIND.editorAuthorityShieldApplied,
		"editor.authority_shield.applied",
		"FLIGHT_KIND.editorAuthorityShieldApplied",
	);
}

console.log("\n--- Test 0a: async lifecycle authority can be revoked synchronously ---");
{
	const fix = buildFixture({
		path: "Notes/revoke-async-authority.md",
		disk: "disk authority\n",
		editor: "disk authority\n",
		crdt: "CRDT authority\n",
	});
	const candidate = makeInterceptedCandidate(fix.path, fix.getCurrentDiskContent(), 1);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);
	const dirtyBeforeRevocation = getDirtyMarkdownEntry(fix.controller, fix.path);
	const internals = fix.controller as never as {
		lifecycleGeneration: number;
		revokeAsyncAuthority?: () => void;
	};
	const generationBeforeRevocation = internals.lifecycleGeneration;
	const revoke = internals.revokeAsyncAuthority;
	assert(
		typeof revoke === "function",
		"controller exposes a synchronous async-authority revocation boundary",
	);
	if (typeof revoke === "function") {
		revoke.call(fix.controller);
		assertEq(
			internals.lifecycleGeneration,
			generationBeforeRevocation + 1,
			"standalone revocation advances exactly one lifecycle generation",
		);
		assert(
			getInterceptedCandidates(fix.controller).get(fix.path) === candidate,
			"standalone revocation performs no candidate cleanup",
		);
		assert(
			getDirtyMarkdownEntry(fix.controller, fix.path) === dirtyBeforeRevocation,
			"standalone revocation performs no dirty-queue cleanup",
		);
		assertEq(fix.getCreatedFiles().size, 0, "standalone revocation performs no artifact I/O");
		assertEq(fix.getFlushWriteCalls().length, 0, "standalone revocation performs no primary I/O");

		let resetRevocationCount = 0;
		internals.revokeAsyncAuthority = () => {
			resetRevocationCount++;
			revoke.call(fix.controller);
		};
		fix.controller.reset();
		assertEq(
			resetRevocationCount,
			1,
			"reset preserves standalone semantics by calling the public revocation boundary once",
		);
	} else {
		fix.controller.reset();
	}
	fix.doc.destroy();
}

console.log("\n--- Test 0b: QA suspension consumes explicit disk ingest without state changes ---");
{
	const base = "baseline authority\n";
	const external = "external disk candidate\n";
	const fix = buildFixture({
		path: "Notes/qa-suspended-ingest.md",
		disk: base,
		editor: base,
		crdt: base,
	});
	fix.setDiskContent(external);
	fix.setDiskIngestSuspendedForQa(true);

	const baselineHashBefore = fix.getDiskIndexContentHash();
	const baselineAdvanceCountBefore = fix.getBaselineAdvanceCount();
	const diskIndexPublishCountBefore = fix.getDiskIndexPublishCount();
	const transactionCountBefore = fix.transactionOrigins.length;
	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), base, "suspended explicit ingest leaves Y.Text unchanged");
	assertEq(fix.getCurrentDiskContent(), external, "suspended explicit ingest leaves disk bytes unchanged");
	assertEq(
		fix.getDiskIndexContentHash(),
		baselineHashBefore,
		"suspended explicit ingest leaves the durable baseline hash unchanged",
	);
	assertEq(
		fix.getBaselineAdvanceCount(),
		baselineAdvanceCountBefore,
		"suspended explicit ingest records no baseline text",
	);
	assertEq(
		fix.getDiskIndexPublishCount(),
		diskIndexPublishCountBefore,
		"suspended explicit ingest publishes no disk index",
	);
	assertEq(
		fix.transactionOrigins.length,
		transactionCountBefore,
		"suspended explicit ingest opens no Y.Text transaction",
	);
	assertEq(fix.getFlushWriteCalls().length, 0, "suspended explicit ingest performs no disk flush");
	const ingestState = fix.controller as never as {
		dirtyMarkdownPaths: Map<string, unknown>;
		activeMarkdownIngests: Map<string, unknown>;
	};
	assert(!ingestState.dirtyMarkdownPaths.has(fix.path), "suspended explicit ingest queues no later work");
	assert(!ingestState.activeMarkdownIngests.has(fix.path), "suspended explicit ingest starts no active ingest");

	const suspensionTraces = fix.traces.filter((trace) =>
		trace.source === "qa" && trace.msg === "disk-ingest-suspended"
	);
	assertEq(suspensionTraces.length, 1, "suspended explicit ingest emits one QA trace");
	assertEq(
		suspensionTraces[0]?.details?.path,
		fix.path,
		"QA suspension trace identifies the intercepted path",
	);
	assertEq(
		suspensionTraces[0]?.details?.reason,
		"qa-disk-ingest-suspended",
		"QA suspension trace uses the bounded suspension reason",
	);
	assertEq(
		Object.keys(suspensionTraces[0]?.details ?? {}).sort().join(","),
		"path,reason",
		"QA suspension trace carries no content, stat, or hash data",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 1 — round-trip suppression invariant: recovery origin is local
// -------------------------------------------------------------------

console.log("\n--- Test 1: ORIGIN_DISK_SYNC_RECOVER_BOUND is a local origin ---");
{
	assert(
		isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND) === true",
	);
	assert(
		isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, /* provider */ undefined),
		"isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, undefined) === true",
	);
	assert(
		LOCAL_REPAIR_ORIGINS.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"LOCAL_REPAIR_ORIGINS includes ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 2 — orchestration: localOnly recovery emits the expected sequence
// -------------------------------------------------------------------

console.log("\n--- Test 2: localOnly recovery flight-event timeline ---");
{
	const fix = buildFixture({
		path: "Notes/orch-test.md",
		disk: "DDDD",
		editor: "DDDD",
		crdt: "CCCC",
	});

	await fix.ingestDiskFileNow("modify");

	const recoveryKinds = fix.captured
		.filter((e) => e.layer === "recovery" || e.layer === "editor")
		.map((e) => e.kind);

	assert(
		recoveryKinds[0] === FLIGHT_KIND.recoveryDecision,
		"first recovery/editor event is recovery.decision",
	);
	assert(
		recoveryKinds[1] === FLIGHT_KIND.recoveryApplyStart,
		"second recovery/editor event is recovery.apply.start",
	);
	assert(
		recoveryKinds[2] === FLIGHT_KIND.recoveryApplyDone,
		"third recovery/editor event is recovery.apply.done",
	);
	assert(
		recoveryKinds[3] === FLIGHT_KIND.editorRepairApplied,
		"fourth recovery/editor event is editor.repair.applied",
	);
	assertEq(recoveryKinds.length, 4, "exactly 4 recovery/editor events");

	const decision = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assert(decision !== undefined, "recovery.decision present");
	assertEq(decision?.data.reason, "bound-file-local-only-divergence", "decision.reason");
	assertEq(decision?.data.action, "apply-diff", "decision.action");
	assertEq(decision?.data.editorEqualsDisk, true, "decision.editorEqualsDisk === true");
	assertEq(decision?.data.editorEqualsCrdt, false, "decision.editorEqualsCrdt === false");

	const applyStart = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	assertEq(applyStart?.data.origin, ORIGIN_DISK_SYNC_RECOVER_BOUND, "apply.start.origin");

	const applyDone = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	assertEq(applyDone?.data.matchesExpected, true, "apply.done.matchesExpected === true");
	assertEq(applyDone?.data.forceReplaceApplied, false, "apply.done.forceReplaceApplied === false");

	assertEq(fix.repairCalls.length, 1, "editorBindings.repair called once");
	assertEq(
		fix.repairCalls[0]?.reason,
		"bound-file-local-only-divergence",
		"editorBindings.repair reason",
	);

	const healEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorHealApplied);
	assertEq(healEvents.length, 0, "no editor.heal.applied events in localOnly recovery (primary invariant: heal() not invoked)");
	const anyHealKind = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(anyHealKind.length, 0, "no editor.heal.* event of any kind in localOnly recovery");

	assertEq(fix.ytext.toString(), "DDDD", "Y.Text postcondition matches disk");

	assert(
		fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"recovery transaction carried ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 3 — second pass on converged file emits recovery.skipped only
// -------------------------------------------------------------------

console.log("\n--- Test 3: second pass on converged file emits only recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/skip-test.md",
		disk: "SAME",
		editor: "SAME",
		crdt: "DIFF",
	});

	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;
	assert(firstPassCount > 0, "first pass produced events");

	// Clear the bound recovery lock so the lock-active bail does not fire.
	(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
		.boundRecoveryLocks.clear();

	// Now editor and disk and CRDT all agree on "SAME". Drive a second pass.
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "second-pass event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"crdt-current-no-op",
		"recovery.skipped reason is crdt-current-no-op",
	);
	assertEq(secondPassEvents[0]?.data.wasBound, true, "recovery.skipped wasBound === true");

	const healOnSecondPass = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnSecondPass.length, 0, "no editor.heal.* events across both passes");

	assertEq(fix.ytext.toString(), "SAME", "Y.Text unchanged on second pass");
}

// -------------------------------------------------------------------
// Test 4 — bound recovery lock active emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 4: recovery-lock-active bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/lock-test.md",
		disk: "X",
		editor: "X",
		crdt: "Y",
	});

	// Drive one recovery to set the lock, then drive a second one immediately.
	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;

	// Force a fresh divergence so the second pass would otherwise enter the
	// localOnly branch.
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "Y2");

	// Lock is still active (1500ms window, set by first pass). Second pass
	// should bail with recovery.skipped(reason=recovery-lock-active).
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "lock-active second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"recovery-lock-active",
		"recovery.skipped reason is recovery-lock-active",
	);
	assert(
		typeof secondPassEvents[0]?.data.lockRemainingMs === "number" &&
		(secondPassEvents[0].data.lockRemainingMs as number) > 0,
		"recovery.skipped includes lockRemainingMs > 0",
	);

	const healOnLockBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnLockBail.length, 0, "no editor.heal.* events on lock-active bail");
}

// -------------------------------------------------------------------
// Test 5 — crdtOnly idle-grace bail emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 5: crdtOnly idle-grace bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/idle-test.md",
		// editor==CRDT≠disk (crdtOnly branch precondition)
		disk: "DISK",
		editor: "CRDT",
		crdt: "CRDT",
	});

	// Override editorBindings to report recent activity (within
	// OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200ms).
	const eb = (fix.controller as unknown as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
	}).deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	eb.getLastEditorActivityForPath = () => Date.now() - 200; // 200ms ago

	try {
		await fix.ingestDiskFileNow("modify");
	} finally {
		eb.getLastEditorActivityForPath = original;
	}

	const skipped = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoverySkipped);
	assert(skipped !== undefined, "recovery.skipped emitted");
	assertEq(skipped?.data.reason, "recent-editor-activity", "reason is recent-editor-activity");
	assert(
		typeof skipped?.data.idleMs === "number" &&
		(skipped!.data.idleMs as number) >= 0 &&
		(skipped!.data.idleMs as number) < 1200,
		"recovery.skipped idleMs in (0, 1200)",
	);

	// And no recovery.decision was emitted.
	const decisionEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(decisionEvents.length, 0, "no recovery.decision in idle-grace bail");

	const healOnIdleBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnIdleBail.length, 0, "no editor.heal.* events on idle-grace bail");
}

// -------------------------------------------------------------------
// Test 5a — autosave modify ingest waits while the user is typing
// -------------------------------------------------------------------

console.log("\n--- Test 5a: autosave modify ingest waits while user is typing ---");
{
	const fix = buildFixture({
		path: "Notes/typing-autosave.md",
		// editor==disk≠CRDT (the Obsidian autosave typing shape)
		disk: "typed text",
		editor: "typed text",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
		getNextMarkdownDrainDelayMs(now?: number): number;
	};
	const eb = internals.deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	let lastEditorActivity = Date.now() - 100;
	eb.getLastEditorActivityForPath = () => lastEditorActivity;

	try {
		fix.controller.markMarkdownDirty(fix.file, "modify", "op-typing-autosave");
		clearMarkdownDrainTimer(fix.controller);

		const queued = internals.dirtyMarkdownPaths.get(fix.path);
		assert(queued !== undefined, "modify dirty entry is queued");
		assert(
			queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
			"recent typing assigns a future notBeforeMs",
		);
		assert(
			internals.getNextMarkdownDrainDelayMs(Date.now() + 500) > 1000,
			"only-deferred dirty queue sleeps until the editor idle window",
		);

		await drainQueuedMarkdown(fix.controller);
		assert(internals.dirtyMarkdownPaths.has(fix.path), "deferred modify remains queued before idle");
		assertEq(fix.ytext.toString(), "base", "deferred autosave modify does not touch CRDT while typing");

		lastEditorActivity = Date.now();
		const staleQueued = internals.dirtyMarkdownPaths.get(fix.path);
		if (staleQueued) staleQueued.notBeforeMs = Date.now() - 1;
		await drainQueuedMarkdown(fix.controller);
		const refreshed = internals.dirtyMarkdownPaths.get(fix.path);
		assert(
			refreshed?.notBeforeMs !== undefined && refreshed.notBeforeMs > Date.now(),
			"drain refreshes deferral when the user typed again after queueing",
		);
		assertEq(fix.ytext.toString(), "base", "refreshed deferral still does not touch CRDT");
	} finally {
		eb.getLastEditorActivityForPath = original;
		clearMarkdownDrainTimer(fix.controller);
	}
}

// -------------------------------------------------------------------
// Test 5b — stale autosave lag does not create an ambiguous conflict
// -------------------------------------------------------------------

console.log("\n--- Test 5b: stale autosave lag waits instead of creating conflict ---");
{
	const fix = buildFixture({
		path: "Notes/stale-autosave-lag.md",
		// editor differs from both disk and CRDT: a transient autosave-lag
		// shape while the user has continued typing after an earlier save.
		disk: "typed partial",
		editor: "typed partial plus more",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};

	fix.controller.markMarkdownDirty(fix.file, "modify", "op-stale-autosave");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	const queued = internals.dirtyMarkdownPaths.get(fix.path);
	assert(queued !== undefined, "stale autosave modify remains queued");
	assert(
		queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
		"stale autosave modify is deferred into the future",
	);
	assertEq(fix.ytext.toString(), "base", "stale autosave lag does not mutate CRDT");
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision).length,
		0,
		"stale autosave lag emits no recovery.decision",
	);
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"stale autosave lag emits no recovery.apply.start",
	);
	clearMarkdownDrainTimer(fix.controller);
}

// -------------------------------------------------------------------
// Test 5c — a known-baseline external-only edit imports cleanly
// -------------------------------------------------------------------

console.log("\n--- Test 5c: known-baseline external-only edit imports and settles explicitly ---");
{
	const base = "base\n";
	const external = "external disk edit\n";
	const fix = buildFixture({
		path: "Notes/queued-external-edit.md",
		disk: external,
		editor: base,
		crdt: base,
	});
	fix.setBaselineContent(base);

	fix.controller.markMarkdownDirty(fix.file, "modify", "op-external-edit");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), external, "external-only edit becomes Y.Text authority");
	assertEq(fix.getCurrentDiskContent(), external, "external-only edit remains the settled disk content");
	assertEq(fix.getCreatedFiles().size, 0, "external-only edit creates no conflict artifact");
	const flushes = fix.getFlushWriteCalls();
	assertEq(flushes.length, 1, "external-only edit performs one explicit disk settlement");
	assertEq(flushes[0]?.path, fix.path, "external-only settlement targets the original path");
	assertEq(flushes[0]?.force, true, "external-only settlement uses the guarded forced write lane");
	assertEq(
		flushes[0]?.expectedDiskContent,
		external,
		"external-only settlement CASes against the raw disk candidate",
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		1,
		"external-only import is one targeted open-external transaction",
	);
	assertSettledSelfWriteLease(fix, "external-only merge");
}

// -------------------------------------------------------------------
// Test 5c1a — delayed event with a stale baseline preserves an ambiguous append
// -------------------------------------------------------------------

console.log("\n--- Test 5c1a: stale baseline preserves an insertion-only external append successor ---");
{
	const staleBaseline = "# log\neditor-01\n";
	const current = `${staleBaseline}filesystem-02\neditor-03\n`;
	const external = `${current}filesystem-04\n`;
	const fix = buildFixture({
		path: "Notes/open-external-delayed-append.md",
		disk: external,
		editor: current,
		crdt: current,
	});
	fix.setBaselineContent(staleBaseline);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), current, "delayed append never replaces current Y.Text authority");
	assertEq(fix.getCurrentDiskContent(), current, "current authority settles back to disk");
	assertEq(
		fix.getCreatedFiles().size,
		0,
		"the ambiguous external append creates no conflict artifact",
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason.startsWith("open-external-")),
		true,
		"the ambiguous external append is recorded as a discarded revision",
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		"no ambiguous append reaches Y.Text",
	);
	assertSettledSelfWriteLease(fix, "delayed append conflict settlement");
}

for (const scenario of [
	{
		label: "baseline suffix deletion",
		baseline: "abc",
		current: "a",
		external: "abcd",
	},
	{
		label: "post-baseline transient deletion",
		baseline: "a",
		current: "ab",
		external: "abcd",
	},
	{
		label: "moved-line deletion",
		baseline: "A\nB\nC\n",
		current: "A\nC\n",
		external: "A\nC\nB\n",
	},
] as const) {
	console.log(`\n--- Test 5c1a0 (${scenario.label}): an ambiguous external edit never restores deleted text ---`);
	const fix = buildFixture({
		path: `Notes/open-external-deletion-${scenario.label.replaceAll(" ", "-")}.md`,
		disk: scenario.external,
		editor: scenario.current,
		crdt: scenario.current,
	});
	fix.setBaselineContent(scenario.baseline);

	await fix.ingestDiskFileNow("modify");

	assertEq(
		fix.ytext.toString(),
		scenario.current,
		`${scenario.label}: current Y.Text keeps the local deletion`,
	);
	assertEq(
		fix.getCurrentDiskContent(),
		scenario.current,
		`${scenario.label}: canonical disk settles to the current authority`,
	);
	assertEq(
		fix.getCreatedFiles().size,
		0,
		`${scenario.label}: exact external bytes create no conflict artifact`,
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason.startsWith("open-external-")),
		true,
		`${scenario.label}: exact external bytes are recorded as a discarded revision`,
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		`${scenario.label}: no speculative suffix replay reaches Y.Text`,
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1a1: authoritative scan ignores a lagging Vault.read projection ---");
{
	const staleBaseline = "# log\neditor-01\n";
	const staleHostProjection = `${staleBaseline}filesystem-02\n`;
	const current = `${staleHostProjection}editor-03\n`;
	const external = `${current}filesystem-04\n`;
	const fix = buildFixture({
		path: "Notes/open-external-lagging-vault-read.md",
		disk: external,
		editor: current,
		crdt: current,
	});
	fix.setBaselineContent(staleBaseline);
	const candidate = makeInterceptedCandidate(fix.path, external, 44);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);

	let staleVaultReadCount = 0;
	let freshDiskReadCount = 0;
	const internals = fix.controller as never as {
		deps: {
			app: { vault: { read(file: TFile): Promise<string> } };
			readFreshMarkdownFile?: (file: TFile) => Promise<string>;
		};
	};
	internals.deps.app.vault.read = async () => {
		staleVaultReadCount++;
		return staleHostProjection;
	};
	internals.deps.readFreshMarkdownFile = async (file) => {
		assert(file === fix.file, "fresh reader keeps the exact TFile identity");
		freshDiskReadCount++;
		return fix.getCurrentDiskContent();
	};

	await fix.controller.runReconciliation("authoritative");

	assert(freshDiskReadCount > 0, "authoritative reconcile uses the physical disk reader");
	assertEq(staleVaultReadCount, 0, "lagging Vault.read projection is never an authority fence");
	assertEq(fix.ytext.toString(), current, "physical external successor does not replace current authority");
	assertEq(fix.getCurrentDiskContent(), current, "current authority settles over the ambiguous successor");
	assertEq(
		fix.getCreatedFiles().size,
		0,
		"the physical external successor creates no conflict artifact",
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason.startsWith("open-external-")),
		true,
		"the physical external successor is recorded as a discarded revision",
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		"cache lag never authorizes an ambiguous append merge",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) !== candidate,
		"the exact external candidate clears only after physical disk settlement",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1a2: a delayed external append over a newer self-write fails closed ---");
{
	const baseline = "a";
	const physicalSelfWrite = "ab";
	const externalAppend = "abcd";
	const fix = buildFixture({
		path: "Notes/open-external-over-delayed-self-write.md",
		disk: physicalSelfWrite,
		editor: physicalSelfWrite,
		crdt: physicalSelfWrite,
	});
	fix.setBaselineContent(baseline);
	fix.setRecentWriteFingerprintMatches(true);

	const candidate = makeInterceptedCandidate(fix.path, externalAppend, 45, {
		editorAuthorityLineage: captureFixtureExternalEditorLineage(fix),
		observedAt: 45_000,
	});
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);

	await fix.ingestDiskFileNow("modify");

	assertEq(
		fix.ytext.toString(),
		physicalSelfWrite,
		"the newer editor/CRDT authority is never replaced by an older append candidate",
	);
	assertEq(
		fix.getCurrentDiskContent(),
		physicalSelfWrite,
		"the newer self-write remains on physical disk",
	);
	assertEq(
		fix.getCreatedFiles().size,
		0,
		"the exact external candidate creates no conflict artifact",
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.contentHash !== undefined),
		true,
		"the exact external candidate is recorded as a discarded revision",
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		"no speculative external replay reaches Y.Text",
	);
	assert(
		!getInterceptedCandidates(fix.controller).has(fix.path),
		"the exact external candidate retires only after settlement",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1a2a: distinct QuickAdd revisions fail closed during async proof ---");
{
	const physicalSelfWrite = "# log\neditor-current\n";
	const intermediateAppend = `${physicalSelfWrite}quickadd-intermediate\n`;
	const finalAppend = `${physicalSelfWrite}quickadd-final\n`;
	const fix = buildFixture({
		path: "Notes/open-external-candidate-proof-race.md",
		disk: physicalSelfWrite,
		editor: physicalSelfWrite,
		crdt: physicalSelfWrite,
	});
	fix.setBaselineContent(physicalSelfWrite);
	fix.setRecentWriteFingerprintMatches(true);
	const unchangedLineage = captureFixtureExternalEditorLineage(fix);
	const intermediate = makeInterceptedCandidate(fix.path, intermediateAppend, 46, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 46_000,
	});
	const final = makeInterceptedCandidate(fix.path, finalAppend, 47, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 46_100,
	});
	fix.controller.noteInterceptedExternalDiskMutation(intermediate);
	clearMarkdownDrainTimer(fix.controller);

	let fingerprintCallCount = 0;
	let markFirstProofStarted!: () => void;
	const firstProofStarted = new Promise<void>((resolve) => {
		markFirstProofStarted = resolve;
	});
	let releaseFirstProof!: () => void;
	const firstProofGate = new Promise<void>((resolve) => {
		releaseFirstProof = resolve;
	});
	fix.setRecentWriteFingerprintHook(async () => {
		fingerprintCallCount++;
		if (fingerprintCallCount !== 1) return;
		markFirstProofStarted();
		await firstProofGate;
	});

	const ingest = fix.ingestDiskFileNow("modify");
	await firstProofStarted;
	fix.controller.noteInterceptedExternalDiskMutation(final);
	clearMarkdownDrainTimer(fix.controller);
	releaseFirstProof();
	await ingest;

	assertEq(fingerprintCallCount, 1, "a pending distinct revision cancels speculative append replay");
	assertEq(fix.ytext.toString(), physicalSelfWrite, "unproven revisions never reach Y.Text");
	assertEq(fix.getCurrentDiskContent(), physicalSelfWrite, "unproven revisions never overwrite disk");
	assertEq(fix.getCreatedFiles().size, 0, "distinct raw revisions create no conflict artifacts");
	assertEq(
		fix.getDiscardedRevisions().filter((record) => record.reason === "superseded-external-revision").length,
		2,
		"each distinct raw revision is recorded as one discarded revision",
	);
	assert(
		!getInterceptedCandidates(fix.controller).has(fix.path),
		"the newest candidate retires only after durable discard recording",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1a2b: full reconcile cannot preempt queued append recovery ---");
{
	const physicalSelfWrite = "# log\neditor-before-full-scan\n";
	const externalAppend = `${physicalSelfWrite}quickadd-before-full-scan\n`;
	const fix = buildFixture({
		path: "Notes/open-external-full-reconcile-preemption.md",
		disk: physicalSelfWrite,
		editor: physicalSelfWrite,
		crdt: physicalSelfWrite,
	});
	fix.setBaselineContent(physicalSelfWrite);
	fix.setRecentWriteFingerprintMatches(true);
	const candidate = makeInterceptedCandidate(fix.path, externalAppend, 45, {
		editorAuthorityLineage: captureFixtureExternalEditorLineage(fix),
		observedAt: 45_000,
	});
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);

	await fix.controller.runReconciliation("authoritative");
	clearMarkdownDrainTimer(fix.controller);

	assertEq(
		fix.getCreatedFiles().size,
		0,
		"full reconcile does not preserve the recoverable append as superseded",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === candidate,
		"full reconcile retains the exact append for the path-scoped dirty lane",
	);
	assertEq(
		fix.ytext.toString(),
		physicalSelfWrite,
		"full reconcile performs no speculative append replay",
	);
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-external-append-recovery-deferred-to-dirty-ingest" &&
			trace.details?.sequence === candidate.sequence
		),
		"full reconcile records the bounded handoff to existing dirty ingest",
	);

	await fix.ingestDiskFileNow("modify");

	assertEq(
		fix.ytext.toString(),
		externalAppend,
		"the canonical dirty lane revalidates and applies the retained append",
	);
	assertEq(
		fix.getCurrentDiskContent(),
		externalAppend,
		"the canonical dirty lane settles the append to physical disk",
	);
	assertEq(
		fix.getCreatedFiles().size,
		0,
		"full-scan preemption fix creates no conflict artifact after settlement",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

for (const failClosedCase of [
	"missing-self-write-proof",
	"editor-authority-advanced",
] as const) {
	console.log(
		`\n--- Test 5c1a3 (${failClosedCase}): delayed rewrite recovery fails closed ---`,
	);
	const physicalSelfWrite = "# log\neditor-current\n";
	const externalAppend = `${physicalSelfWrite}quickadd-external\n`;
	const fix = buildFixture({
		path: `Notes/open-external-recovery-${failClosedCase}.md`,
		disk: physicalSelfWrite,
		editor: physicalSelfWrite,
		crdt: physicalSelfWrite,
	});
	fix.setBaselineContent(physicalSelfWrite);
	fix.setRecentWriteFingerprintMatches(failClosedCase !== "missing-self-write-proof");
	const candidate = makeInterceptedCandidate(fix.path, externalAppend, 46, {
		editorAuthorityLineage: captureFixtureExternalEditorLineage(fix),
		observedAt: 46_000,
	});
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);
	if (failClosedCase === "editor-authority-advanced") {
		// Preserve the same visible bytes while advancing the user-authority
		// revision. Content equality alone must never authorize replay.
		fix.setEditorContent(physicalSelfWrite);
	}

	await fix.ingestDiskFileNow("modify");

	assertEq(
		fix.ytext.toString(),
		physicalSelfWrite,
		`${failClosedCase}: unproven replay never mutates Y.Text`,
	);
	assertEq(
		fix.getCurrentDiskContent(),
		physicalSelfWrite,
		`${failClosedCase}: unproven replay never overwrites physical disk`,
	);
	assertEq(
		fix.getCreatedFiles().size,
		0,
		`${failClosedCase}: exact external bytes create no conflict artifact`,
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		true,
		`${failClosedCase}: exact external bytes are recorded as a discarded revision`,
	);
	assert(
		!fix.traces.some((trace) =>
			trace.msg === "open-external-append-recovered-over-self-write"
		),
		`${failClosedCase}: recovery trace is absent without every proof`,
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5c1b — bilateral non-overlap clean merge
// -------------------------------------------------------------------

console.log("\n--- Test 5c1b: bilateral non-overlap edit merges once and settles ---");
{
	const base = "## 업무\nbase work\n\n## 일상\nbase life\n";
	const local = "## 업무\nlocal work\n\n## 일상\nbase life\n";
	const external = "## 업무\nbase work\n\n## 일상\nexternal life\n";
	const expected = "## 업무\nlocal work\n\n## 일상\nexternal life\n";
	const fix = buildFixture({
		path: "Notes/open-external-clean-merge.md",
		disk: external,
		editor: local,
		crdt: local,
	});
	fix.setBaselineContent(base);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), expected, "non-overlapping local and external hunks merge in Y.Text");
	assertEq(fix.getCurrentDiskContent(), expected, "clean merged text settles to disk");
	assertEq(fix.getCreatedFiles().size, 0, "clean merge creates no artifact");
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		1,
		"clean merge applies as exactly one open-external Y.Text transaction",
	);
	const flushes = fix.getFlushWriteCalls();
	assertEq(flushes.length, 1, "clean merge explicitly settles disk once");
	assertEq(
		flushes[0]?.expectedDiskContent,
		external,
		"clean merge flush preserves the raw external candidate as its disk CAS",
	);
	assertSettledSelfWriteLease(fix, "bilateral clean merge");
}

console.log("\n--- Test 5c1b2: a changed editor during self-write cannot borrow marker preservation ---");
{
	const baseline = "baseline disk authority\n";
	const current = "current CRDT authority\n";
	const concurrentEditor = "concurrent editor authority\n";
	const fix = buildFixture({
		path: "Notes/open-self-write-editor-race.md",
		disk: baseline,
		editor: current,
		crdt: current,
	});
	fix.setBaselineContent(baseline);
	const candidate = makeInterceptedCandidate(fix.path, baseline, 58);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);
	fix.setSelfWriteModifyHook(() => {
		fix.setEditorContent(concurrentEditor);
	});

	await drainQueuedMarkdown(fix.controller);
	fix.setSelfWriteModifyHook(null);

	const observation = fix.getSelfWriteMarkerObservations().at(-1);
	assertEq(
		observation?.activeLeaseCount,
		1,
		"concurrent editor race is observed while the exact flush lease is active",
	);
	assert(
		observation?.markerPreserved === false,
		"changed editor authority forces a new marker instead of using the self-write exception",
	);
	assertEq(
		fix.getBaselineAdvanceCount(),
		0,
		"changed editor authority prevents baseline settlement",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === candidate,
		"changed editor authority retains the exact external candidate for a fresh plan",
	);
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller),
		0,
		"authority deferral releases its active flush lease",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1b1: editor/CRDT that already contains the external delta settles without an artifact ---");
{
	const base = "## 업무\n기본 업무\n\n## 일상\n기본 일상\n";
	const external = "## 업무\n기본 업무\n\n## 일상\n외부 일상\n";
	const alreadyMerged = "## 업무\n편집기 업무\n\n## 일상\n외부 일상\n";
	const fix = buildFixture({
		path: "Notes/open-external-already-incorporated.md",
		disk: external,
		editor: alreadyMerged,
		crdt: alreadyMerged,
	});
	fix.setBaselineContent(base);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), alreadyMerged, "already incorporated external delta remains in Y.Text");
	assertEq(fix.getCurrentDiskContent(), alreadyMerged, "already merged live authority settles to disk");
	assertEq(fix.getCreatedFiles().size, 0, "already incorporated external delta creates no artifact");
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		"already incorporated external delta needs no duplicate Y.Text transaction",
	);
	assertSettledSelfWriteLease(fix, "already incorporated external delta");
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1b3: a thrown DiskMirror flush always releases the active lease ---");
{
	const baseline = "throw boundary baseline\n";
	const current = "throw boundary current\n";
	const fix = buildFixture({
		path: "Notes/open-flush-throw-cleanup.md",
		disk: baseline,
		editor: current,
		crdt: current,
	});
	fix.setBaselineContent(baseline);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, baseline, 57),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.setFlushWriteBoundaryHook(() => {
		throw new Error("deterministic DiskMirror boundary failure");
	});
	await drainQueuedMarkdown(fix.controller);
	fix.setFlushWriteBoundaryHook(null);

	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller),
		0,
		"thrown flush releases its active authority lease in finally",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1b4: overlapping leases unregister only their own authority ---");
{
	const fix = buildFixture({
		path: "Notes/open-overlapping-flush-leases.md",
		disk: "disk\n",
		editor: "editor\n",
		crdt: "crdt\n",
	});
	const internals = fix.controller as never as {
		withActiveOpenFlushAuthorityLease(
			lease: { path: string; stage: string },
			flush: () => Promise<undefined>,
		): Promise<undefined>;
	};
	let releaseFirst: (() => void) | null = null;
	let releaseSecond: (() => void) | null = null;
	let markFirstStarted: (() => void) | null = null;
	let markSecondStarted: (() => void) | null = null;
	const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
	const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
	const first = internals.withActiveOpenFlushAuthorityLease(
		{ path: fix.path, stage: "first" },
		async () => {
			markFirstStarted?.();
			await firstGate;
			return undefined;
		},
	);
	await firstStarted;
	const second = internals.withActiveOpenFlushAuthorityLease(
		{ path: fix.path, stage: "second" },
		async () => {
			markSecondStarted?.();
			await secondGate;
			return undefined;
		},
	);
	await secondStarted;
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller, fix.path),
		2,
		"both overlapping leases are registered while their flushes are active",
	);
	releaseFirst?.();
	await first;
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller, fix.path),
		1,
		"first completion removes only its exact lease",
	);
	releaseSecond?.();
	await second;
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller, fix.path),
		0,
		"last completion removes the empty per-path registry entry",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1b5: the executing lease settles while a same-path waiter fails closed ---");
{
	const baseline = "overlap baseline\n";
	const current = "overlap current CRDT\n";
	const fix = buildFixture({
		path: "Notes/open-overlap-authority.md",
		disk: baseline,
		editor: current,
		crdt: current,
	});
	fix.setBaselineContent(baseline);
	const candidate = makeInterceptedCandidate(fix.path, baseline, 56);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);

	let boundaryCall = 0;
	let markFirstBoundaryStarted: (() => void) | null = null;
	let markSecondBoundaryStarted: (() => void) | null = null;
	let releaseFirstBoundary: (() => void) | null = null;
	let releaseSecondAfterFirstWrite: (() => void) | null = null;
	const firstBoundaryStarted = new Promise<void>((resolve) => {
		markFirstBoundaryStarted = resolve;
	});
	const secondBoundaryStarted = new Promise<void>((resolve) => {
		markSecondBoundaryStarted = resolve;
	});
	const firstBoundaryGate = new Promise<void>((resolve) => {
		releaseFirstBoundary = resolve;
	});
	const secondBoundaryGate = new Promise<void>((resolve) => {
		releaseSecondAfterFirstWrite = resolve;
	});
	fix.setFlushWriteBoundaryHook(async () => {
		boundaryCall++;
		if (boundaryCall === 1) {
			markFirstBoundaryStarted?.();
			await firstBoundaryGate;
			return;
		}
		markSecondBoundaryStarted?.();
		await secondBoundaryGate;
		// Model DiskMirror's same-path waiter acquiring its lock only after the
		// first atomic write emitted the synchronous vault.modify callback.
		while (fix.getSelfWriteMarkerObservations().length === 0) {
			await Promise.resolve();
		}
	});
	fix.setSelfWriteModifyHook(() => {
		releaseSecondAfterFirstWrite?.();
	});

	const clearAttempts: InterceptedExternalDiskMutation[] = [];
	const internals = fix.controller as never as {
		clearInterceptedExternalDiskMutation(
			captured: InterceptedExternalDiskMutation | null,
		): void;
	};
	const originalClear = internals.clearInterceptedExternalDiskMutation.bind(fix.controller);
	internals.clearInterceptedExternalDiskMutation = (captured) => {
		if (captured) clearAttempts.push(captured);
		originalClear(captured);
	};

	const first = fix.ingestDiskFileNow("modify");
	await firstBoundaryStarted;
	const second = fix.ingestDiskFileNow("modify");
	await secondBoundaryStarted;
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller, fix.path),
		2,
		"executing and waiting plans retain two independently fenced leases",
	);
	releaseFirstBoundary?.();
	await Promise.all([first, second]);

	const observations = fix.getSelfWriteMarkerObservations();
	assertEq(observations.length, 1, "only the executing first lease reaches a disk mutation");
	assertEq(
		observations[0]?.activeLeaseCount,
		2,
		"the first self-write is classified while the second lease is still registered",
	);
	assert(
		observations[0]?.markerPreserved === true,
		"one exact current lease preserves the first write's unchanged authority marker",
	);
	assertEq(fix.getBaselineAdvanceCount(), 1, "only the first settled write advances baseline text");
	assertEq(clearAttempts.length, 1, "only the first settled write retires the exact candidate");
	assert(
		clearAttempts[0] === candidate && !getInterceptedCandidates(fix.controller).has(fix.path),
		"the first settlement retires the candidate exactly once",
	);
	assert(
		fix.traces.some((trace) =>
			trace.msg === "disk-write-not-settled" &&
			trace.details?.resultReason === "authority-stale"
		),
		"the waiting second lease fails closed at its fresh DiskMirror boundary",
	);
	assertEq(
		getActiveOpenFlushLeaseCountForTest(fix.controller),
		0,
		"both overlapping leases release their registry ownership",
	);

	internals.clearInterceptedExternalDiskMutation = originalClear;
	fix.setSelfWriteModifyHook(null);
	fix.setFlushWriteBoundaryHook(null);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5c1b1 — every open-external authority change invalidates the awaited plan
// -------------------------------------------------------------------

const openExternalRaceReasons: Record<OpenExternalAuthorityAdvance, string> = {
	"editor-revision": "editor-revision-changed",
	"provider-ytext": "crdt-content-changed",
	"pane-binding-epoch": "binding-epoch-changed",
	"visible-marker": "visible-authority-marker-changed",
	"candidate-object": "external-candidate-changed",
	"candidate-epoch": "external-candidate-identity-changed",
	"disk-sequence": "disk-event-generation-changed",
	"disk-stat": "disk-stat-changed",
	"disk-file": "disk-file-identity-changed",
	"disk-content": "disk-content-changed",
	"baseline-hash": "baseline-hash-changed",
	"baseline-revision": "baseline-revision-changed",
	"lifecycle-generation": "lifecycle-generation-changed",
	"open-view-set": "view-set-changed",
};

for (const advance of Object.keys(openExternalRaceReasons) as OpenExternalAuthorityAdvance[]) {
	console.log(`\n--- Test 5c1b1 (${advance}): baseline await is authority fenced ---`);
	const base = "## Work\nbase work\n\n## Life\nbase life\n";
	const local = "## Work\nlocal work\n\n## Life\nbase life\n";
	const external = "## Work\nbase work\n\n## Life\nexternal life\n";
	const fix = buildFixture({
		path: `Notes/open-external-${advance}-race.md`,
		disk: external,
		editor: local,
		crdt: local,
	});
	fix.setBaselineContent(base);

	let releaseBaselineRead: (() => void) | null = null;
	let markBaselineReadStarted: (() => void) | null = null;
	const baselineReadStarted = new Promise<void>((resolve) => {
		markBaselineReadStarted = resolve;
	});
	const baselineReadGate = new Promise<void>((resolve) => {
		releaseBaselineRead = resolve;
	});
	fix.setBaselineReadHook(async () => {
		markBaselineReadStarted?.();
		markBaselineReadStarted = null;
		await baselineReadGate;
	});

	const ingest = fix.ingestDiskFileNow("modify");
	await baselineReadStarted;
	const diskRevisionBeforeAdvance = getMarkdownDiskRevisionForTest(fix.controller, fix.path);
	const visibleAuthorityBeforeAdvance = getVisibleAuthorityMarkerForTest(
		fix.controller,
		fix.path,
	);
	fix.advanceOpenExternalAuthority(advance);
	if (advance === "candidate-object") {
		clearMarkdownDrainTimer(fix.controller);
		clearDirtyMarkdownEntry(fix.controller, fix.path);
		assertEq(
			getDirtyMarkdownEntry(fix.controller, fix.path),
			undefined,
			`${advance}: authority advance work is cleared before testing stale replan`,
		);
	}
	const visibleAuthorityAfterAdvance = getVisibleAuthorityMarkerForTest(
		fix.controller,
		fix.path,
	);
	const expectedYText = fix.ytext.toString();
	const expectedDiskContent = fix.getCurrentDiskContent();
	releaseBaselineRead?.();
	await ingest;
	fix.setBaselineReadHook(null);

	assertEq(fix.ytext.toString(), expectedYText, `${advance}: stale plan never mutates Y.Text`);
	assertEq(
		fix.getCurrentDiskContent(),
		expectedDiskContent,
		`${advance}: stale plan leaves the latest disk bytes untouched`,
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		`${advance}: stale plan emits no open-external transaction`,
	);
	assertEq(fix.getFlushWriteCalls().length, 0, `${advance}: stale plan performs no disk flush`);
	assertEq(fix.getBaselineAdvanceCount(), 0, `${advance}: stale plan performs no baseline advance`);
	assertEq(fix.getCreatedFiles().size, 0, `${advance}: staleness creates no conflict artifact`);
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === openExternalRaceReasons[advance]
		),
		`${advance}: exact stale reason is traced`,
	);
	const requeued = getDirtyMarkdownEntry(fix.controller, fix.path);
	assert(
		requeued !== undefined && requeued.reason === "modify",
		`${advance}: concrete replacement work is queued for a fresh plan`,
	);
	if (advance === "disk-sequence") {
		assertEq(
			getMarkdownDiskRevisionForTest(fix.controller, fix.path),
			diskRevisionBeforeAdvance + 1,
			"disk-sequence: replacement modify advances the disk-event revision",
		);
		assert(
			requeued?.coalescedOpIds.includes("op-open-external-disk-sequence-replacement") === true,
			"disk-sequence: the exact replacement disk event remains the queue owner",
		);
		assertEq(
			visibleAuthorityAfterAdvance,
			visibleAuthorityBeforeAdvance,
			"disk-sequence: revision and queue advance preserve visible-authority marker identity",
		);
		assertEq(
			JSON.stringify(visibleAuthorityAfterAdvance ?? null),
			JSON.stringify(visibleAuthorityBeforeAdvance ?? null),
			"disk-sequence: revision and queue advance preserve visible-authority marker value",
		);
	}
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5c1b2: targeted external merge observer failure fails closed ---");
{
	const baselineSentinel = "PRIVATE BASELINE NOTE TEXT";
	const liveSentinel = "PRIVATE LIVE NOTE TEXT";
	const externalSentinel = "PRIVATE EXTERNAL NOTE TEXT";
	const baseline = `## Work\n${baselineSentinel}\n\n## Life\nPRIVATE BASE LIFE TEXT\n`;
	const local = `## Work\n${liveSentinel}\n\n## Life\nPRIVATE BASE LIFE TEXT\n`;
	const external = `## Work\n${baselineSentinel}\n\n## Life\n${externalSentinel}\n`;
	const merged = `## Work\n${liveSentinel}\n\n## Life\n${externalSentinel}\n`;
	const observerError = [
		"observer hook failed with private note state",
		`baseline=${baseline}`,
		`live=${local}`,
		`external=${external}`,
		`merged=${merged}`,
	].join(" | ");
	const fix = buildFixture({
		path: "Notes/open-external-observer-failure.md",
		disk: external,
		editor: local,
		crdt: local,
	});
	fix.setBaselineContent(baseline);
	const baselineBefore = fix.getDiskIndexContentHash();

	fix.ytext.observe((_event, transaction) => {
		if (transaction.origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE) {
			throw new Error(observerError);
		}
	});

	let escapedError: unknown = null;
	try {
		await fix.ingestDiskFileNow("modify");
	} catch (error) {
		escapedError = error;
	}

	assertEq(escapedError, null, "observer exception does not escape disk ingest");
	assertEq(
		JSON.stringify(fix.getUndoCaptureSeparations()),
		JSON.stringify([fix.path, fix.path]),
		"undo capture is separated before and after the targeted diff attempt",
	);
	assertEq(
		fix.ytext.toString(),
		merged,
		"already-committed targeted diff remains in Y.Text after observer failure",
	);
	assertEq(fix.getCurrentDiskContent(), external, "observer failure leaves external disk bytes untouched");
	assertEq(fix.getFlushWriteCalls().length, 0, "observer failure never flushes the primary path");
	assertEq(fix.getDiskIndexContentHash(), baselineBefore, "observer failure never advances the baseline");
	assert(
		fix.getPreservedUnresolvedCalls().some((call) =>
			call.path === fix.path && call.reason === "open-external-targeted-diff-failed"
		),
		"observer failure records the exact targeted-diff unresolved reason",
	);
	const failureTrace = fix.traces.find((trace) =>
		trace.msg === "open-external-targeted-diff-failed"
	);
	assert(failureTrace !== undefined, "observer failure emits a targeted-diff failure trace");
	assertEq(failureTrace?.details?.path, fix.path, "failure trace identifies the affected path");
	assertEq(
		failureTrace?.details?.reason,
		"open-external-targeted-diff-failed",
		"failure trace carries the typed unresolved reason",
	);
	assertEq(
		failureTrace?.details?.errorCategory,
		"exception",
		"failure trace carries only the bounded exception category",
	);
	assertEq(failureTrace?.details?.error, undefined, "failure trace omits arbitrary error text");
	assertEq(failureTrace?.details?.errorName, undefined, "failure trace omits arbitrary error names");
	assertEq(failureTrace?.details?.stack, undefined, "failure trace omits arbitrary error stacks");
	const serializedFailureTrace = JSON.stringify(failureTrace ?? {});
	for (const privateText of [
		baselineSentinel,
		liveSentinel,
		externalSentinel,
		observerError,
		baseline,
		local,
		external,
		merged,
	]) {
		assert(
			!serializedFailureTrace.includes(privateText),
			"failure trace contains no baseline, live, external, or merged note text",
		);
	}
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		1,
		"observer failure performs only the original targeted transaction",
	);
	assertEq(
		fix.transactionOrigins.length,
		1,
		"observer failure attempts no replacement or rollback transaction",
	);
}

// -------------------------------------------------------------------
// Test 5c1c — overlapping raw disk edit is discarded without an artifact
// -------------------------------------------------------------------

console.log("\n--- Test 5c1c: raw same-hunk conflict discards bytes then settles live authority ---");
{
	const baseline = "title: base\n";
	const local = "title: local\n";
	const rawExternal = "\ufefftitle: external\r\n";
	const fix = buildFixture({
		path: "Notes/open-external-raw-conflict.md",
		disk: rawExternal,
		editor: local,
		crdt: local,
	});
	fix.setBaselineContent(baseline);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), local, "same-hunk conflict leaves live Y.Text unchanged");
	assertEq(
		fix.getCreatedFiles().size,
		0,
		"same-hunk disk conflict creates no conflict artifact",
	);
	assertEq(
		fix.getDiscardedRevisions().some((record) =>
			record.reason.startsWith("open-external-") && record.contentHash.length > 0
		),
		true,
		"the raw external bytes are recorded as a discarded revision",
	);
	assertEq(fix.getCurrentDiskContent(), local, "primary disk settles to live text without conflict markers");
	assert(!fix.getCurrentDiskContent().includes("<<<<<<<"), "primary disk contains no conflict markers");
	assertEq(
		fix.getDiskIndexContentHash(),
		baselineHashSync(local),
		"disk index advances to the settled live hash",
	);
	const flushes = fix.getFlushWriteCalls();
	assertEq(flushes.length, 1, "discard recording is followed by one primary settlement");
	assertEq(
		flushes[0]?.expectedDiskContent,
		rawExternal,
		"conflict settlement CASes against the exact raw external bytes",
	);
}

console.log("\n--- Test 5c1c1: BOM-stripped Vault.read still records the intercepted raw conflict once ---");
{
	const baseline = "title: base\n";
	const local = "title: local\n";
	const stableExternal = "title: external\r\n";
	const rawExternal = `\ufeff${stableExternal}`;
	const fix = buildFixture({
		path: "Notes/open-external-bom-stripped-conflict.md",
		disk: stableExternal,
		editor: local,
		crdt: local,
	});
	fix.setBaselineContent(baseline);
	const candidate = makeInterceptedCandidate(fix.path, rawExternal, 81);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);

	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), local, "BOM-stripped stable read leaves live Y.Text unchanged");
	assertEq(fix.getCreatedFiles().size, 0, "BOM-stripped stable read creates no conflict artifact");
	assertEq(
		fix.getDiscardedRevisions().filter((record) => record.contentHash.length > 0).length >= 1,
		true,
		"the intercepted raw conflict is recorded as a discarded revision",
	);
	assertEq(fix.getCurrentDiskContent(), local, "BOM-stripped conflict settles live authority to disk");
	assertEq(
		fix.getFlushWriteCalls()[0]?.expectedDiskContent,
		stableExternal,
		"disk settlement CASes against the representation returned by Vault.read",
	);
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "settlement retires the raw candidate");
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5c2 — missing baseline preserves instead of importing
// -------------------------------------------------------------------

console.log("\n--- Test 5c2: missing baseline keeps local and records external disk candidate ---");
{
	const local = "abc";
	const external = "abcd";
	const fix = buildFixture({
		path: "Notes/missing-baseline-crdtonly.md",
		disk: external,
		editor: local,
		crdt: local,
	});
	fix.clearDiskIndex();

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), local, "missing baseline never auto-imports external content");
	assertEq(fix.getCurrentDiskContent(), local, "missing baseline never leaves the successor on the primary path");
	assertEq(fix.getCreatedFiles().size, 0, "missing baseline creates no conflict artifact");
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason.startsWith("open-external-")),
		true,
		"missing-baseline records the exact disk content as a discarded revision",
	);
	assertEq(
		fix.transactionOrigins.filter((origin) => origin === ORIGIN_OPEN_EXTERNAL_EDIT_MERGE).length,
		0,
		"missing baseline performs no open-external merge transaction",
	);
}

// -------------------------------------------------------------------
// Test 5c3 — an open view stays authoritative while binding is absent
// -------------------------------------------------------------------

console.log("\n--- Test 5c3: temporarily unbound open view cannot fall into generic disk import ---");
{
	const fix = buildFixture({
		path: "Notes/open-binding-transition.md",
		disk: "stale disk snapshot",
		editor: "visible current text",
		crdt: "visible current text",
	});
	fix.clearDiskIndex();
	fix.setBound(false);

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "visible current text", "open unbound view never imports the stale disk snapshot");
	assertEq(fix.getCreatedFiles().size, 0, "open unbound conflict creates no conflict artifact");
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason.startsWith("open-external-")),
		true,
		"the rejected disk snapshot is recorded as a discarded revision",
	);
}

// -------------------------------------------------------------------
// Test 5c4 — disagreeing panes fail closed before localOnly/crdtOnly routing
// -------------------------------------------------------------------

console.log("\n--- Test 5c4: disk/CRDT panes fail closed independent of pane order ---");
{
	const diskContent = "pane disk E1\n";
	const crdtContent = "pane CRDT E2\n";
	const baselineContent = "older durable baseline B\n";
	for (const [label, firstEditor, secondEditor] of [
		["disk-first", diskContent, crdtContent],
		["crdt-first", crdtContent, diskContent],
	] as const) {
		const fix = buildFixture({
			path: `Notes/multiple-panes-${label}.md`,
			disk: diskContent,
			editor: firstEditor,
			additionalEditors: [secondEditor],
			crdt: crdtContent,
		});
		fix.setBaselineContent(baselineContent);
		const baselineBefore = fix.getDiskIndexContentHash();

		await fix.controller.runReconciliation("authoritative");

		assertEq(fix.ytext.toString(), crdtContent, `${label}: multiple panes do not mutate Y.Text`);
		assertEq(fix.getCurrentDiskContent(), diskContent, `${label}: multiple panes do not mutate the original disk file`);
		assertEq(fix.getFlushWriteCalls().length, 0, `${label}: multiple panes never enter CRDT-to-disk flush`);
		const baselineAfter = fix.getDiskIndexContentHash();
		assert(
			baselineAfter === undefined || baselineAfter === baselineBefore,
			`${label}: unresolved pane conflict never promotes disk or CRDT to the durable baseline`,
		);
		assertEq(fix.getCreatedFiles().size, 0, `${label}: pane ambiguity creates no conflict artifact`);
		assertEq(
			fix.getPreservedUnresolvedCalls().filter((call) => call.path === fix.path).length,
			0,
			`${label}: pane ambiguity records no preserved-unresolved episode`,
		);
		assertEq(
			fix.captured.filter((event) => event.kind === FLIGHT_KIND.recoveryApplyStart).length,
			0,
			`${label}: no recovery mutation starts`,
		);
		fix.controller.reset();
		fix.doc.destroy();
	}
}

// -------------------------------------------------------------------
// Test 5c5 — a third visible candidate is preserved without choosing a winner
// -------------------------------------------------------------------

console.log("\n--- Test 5c5: distinct third pane is preserved and no replica is rewritten ---");
{
	const diskContent = "disk D\n";
	const crdtContent = "crdt C\n";
	const thirdEditorContent = "third pane E\n";
	const fix = buildFixture({
		path: "Notes/multiple-panes-third-candidate.md",
		disk: diskContent,
		editor: diskContent,
		additionalEditors: [thirdEditorContent],
		crdt: crdtContent,
	});
	fix.setBaselineContent("baseline B\n");
	const baselineBefore = fix.getDiskIndexContentHash();

	await fix.controller.runReconciliation("authoritative");

	assertEq(fix.ytext.toString(), crdtContent, "third-pane ambiguity leaves Y.Text unchanged");
	assertEq(fix.getCurrentDiskContent(), diskContent, "third-pane ambiguity leaves disk unchanged");
	assertEq(fix.getFlushWriteCalls().length, 0, "third-pane ambiguity never flushes a winner to disk");
	const baselineAfter = fix.getDiskIndexContentHash();
	assert(
		baselineAfter === undefined || baselineAfter === baselineBefore,
		"third-pane ambiguity never promotes any candidate to the durable baseline",
	);
	assertEq(fix.getCreatedFiles().size, 0, "third-pane ambiguity creates no conflict artifact");
	assertEq(
		fix.getPreservedUnresolvedCalls().filter((call) => call.path === fix.path).length,
		0,
		"third-pane ambiguity records no preserved-unresolved episode",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5c6 — an unreadable pane also fails closed
// -------------------------------------------------------------------

console.log("\n--- Test 5c6: unreadable pane cannot authorize either direction ---");
{
	const diskContent = "disk D\n";
	const crdtContent = "visible CRDT C\n";
	const fix = buildFixture({
		path: "Notes/unreadable-pane.md",
		disk: diskContent,
		editor: crdtContent,
		additionalEditors: [{ readError: true }],
		crdt: crdtContent,
	});
	fix.setBaselineContent("baseline B\n");
	const baselineBefore = fix.getDiskIndexContentHash();

	await fix.controller.runReconciliation("authoritative");

	assertEq(fix.ytext.toString(), crdtContent, "read failure leaves Y.Text unchanged");
	assertEq(fix.getCurrentDiskContent(), diskContent, "read failure leaves disk unchanged");
	assertEq(fix.getFlushWriteCalls().length, 0, "read failure never flushes either candidate");
	const baselineAfter = fix.getDiskIndexContentHash();
	assert(
		baselineAfter === undefined || baselineAfter === baselineBefore,
		"read failure never promotes either candidate to the durable baseline",
	);
	assertEq(fix.getCreatedFiles().size, 0, "read failure creates no conflict artifact");
	assertEq(
		fix.getPreservedUnresolvedCalls().filter((call) => call.path === fix.path).length,
		0,
		"read failure records no preserved-unresolved episode",
	);
	assertEq(
		fix.captured.filter((event) => event.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"read failure emits no recovery apply start",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5d — create entries do not inherit autosave modify deferral
// -------------------------------------------------------------------

console.log("\n--- Test 5d: create dirty entries bypass typing deferral ---");
{
	const fix = buildFixture({
		path: "Notes/create-after-autosave.md",
		disk: "created",
		editor: "created",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};
	const eb = internals.deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	eb.getLastEditorActivityForPath = () => Date.now() - 100;

	try {
		fix.controller.markMarkdownDirty(fix.file, "modify", "op-typing-before-create");
		fix.controller.markMarkdownDirty(fix.file, "create", "op-create");
		clearMarkdownDrainTimer(fix.controller);

		const queued = internals.dirtyMarkdownPaths.get(fix.path);
		assertEq(queued?.reason, "create", "create priority wins over pending modify");
		assertEq(queued?.notBeforeMs, undefined, "create entry is not delayed by recent typing");
	} finally {
		eb.getLastEditorActivityForPath = original;
		clearMarkdownDrainTimer(fix.controller);
	}
}

// -------------------------------------------------------------------
// Test 5e — create waits when the live editor is ahead of disk
// -------------------------------------------------------------------

console.log("\n--- Test 5e: create waits when the live editor is ahead of disk ---");
{
	const fix = buildFixture({
		path: "Notes/create-editor-ahead.md",
		// The create event captured an earlier autosave snapshot while the
		// editor already contains the user's next input composition.
		disk: "created partial",
		editor: "created partial 한글",
		crdt: "base",
	});
	const internals = fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { reason: MarkdownDirtyReason; notBeforeMs?: number }>;
	};

	fix.controller.markMarkdownDirty(fix.file, "create", "op-create-editor-ahead");
	clearMarkdownDrainTimer(fix.controller);
	await drainQueuedMarkdown(fix.controller);

	const queued = internals.dirtyMarkdownPaths.get(fix.path);
	assert(queued !== undefined, "create remains queued while the editor is ahead of disk");
	assert(
		queued?.notBeforeMs !== undefined && queued.notBeforeMs > Date.now(),
		"create is retried after the editor/disk settle window",
	);
	assertEq(fix.ytext.toString(), "base", "stale create snapshot does not overwrite CRDT");
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision).length,
		0,
		"editor-ahead create emits no recovery.decision",
	);
	assertEq(
		fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart).length,
		0,
		"editor-ahead create emits no recovery.apply.start",
	);
	clearMarkdownDrainTimer(fix.controller);
}

// -------------------------------------------------------------------
// Test 5f — dirty admission carries E across close with no baseline
// -------------------------------------------------------------------

console.log("\n--- Test 5f: dirty admission records editor E across close with no baseline ---");
{
	const editorContent = "local autosave E\n";
	const competingCrdt = "remote CRDT C\n";
	const fix = buildFixture({
		path: "Notes/dirty-admission-close.md",
		disk: editorContent,
		editor: editorContent,
		crdt: competingCrdt,
	});
	fix.clearDiskIndex();

	// The autosave event arrives while the editor is still open. Close the view
	// before the queued ingest gets a chance to run: this is the normal-operation
	// gap that a startup-only marker did not cover.
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-close-before-dirty-drain");
	clearMarkdownDrainTimer(fix.controller);
	const internals = fix.controller as never as {
		visibleAuthorityDeferredPaths: Map<string, {
			readComplete: boolean;
			editorContents: string[];
		}>;
		lastReconcileTime: number;
	};
	const admittedMarker = internals.visibleAuthorityDeferredPaths.get(fix.path);
	assert(
		admittedMarker?.readComplete === true &&
		admittedMarker.editorContents.length === 1 &&
		admittedMarker.editorContents[0] === editorContent,
		"modify admission captures the exact open editor E before close",
	);

	fix.setOpen(false);
	fix.setBound(false);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), editorContent, "closed dirty ingest keeps E instead of selecting C");
	assertEq(fix.getCurrentDiskContent(), editorContent, "closed dirty ingest leaves E on the original disk path");
	assertEq(fix.getCreatedFiles().size, 0, "competing CRDT C creates no conflict artifact");
	assertEq(
		fix.getDiscardedRevisions().some((record) => record.reason === "closed-dirty-visible-authority-disk-wins"),
		true,
		"competing CRDT C is recorded as a discarded revision",
	);
	assert(
		!internals.visibleAuthorityDeferredPaths.has(fix.path),
		"dirty-admission marker clears only after E reaches CRDT and the durable baseline",
	);

	// A subsequent authoritative pass has no mtime/last-index-save evidence and
	// must remain a no-op; the missing-baseline planner cannot put C back.
	internals.lastReconcileTime = 0;
	await fix.controller.runReconciliation("authoritative");
	assertEq(fix.ytext.toString(), editorContent, "full follow-up cannot revert settled E back to C");
	assertEq(fix.getCurrentDiskContent(), editorContent, "full follow-up keeps E on disk");
	assertEq(fix.getCreatedFiles().size, 0, "full follow-up creates no additional artifact");
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f1: closed dirty CRDT winner cannot bypass a closed projection gate ---");
{
	const disk = "older local disk baseline\n";
	const crdt = "remote CRDT winner\n";
	const fix = buildFixture({
		path: "Notes/closed-dirty-policy-crdt-winner.md",
		disk,
		editor: crdt,
		crdt,
	});
	fix.setBaselineContent(disk);
	fix.controller.markMarkdownDirty(
		fix.file,
		"modify",
		"op-closed-dirty-policy-crdt-winner",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.setOpen(false);
	fix.setBound(false);
	fix.setRemoteProjectionAllowed(false);

	await drainQueuedMarkdown(fix.controller);

	assertEq(
		fix.getCurrentDiskContent(),
		disk,
		"captured visible CRDT authority does not project while provider policy is closed",
	);
	assertEq(
		fix.getFlushWriteCalls().length,
		0,
		"closed visible-authority recovery never reaches an ungated DiskMirror write",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f2: closed dirty three-way CRDT-only branch respects projection policy ---");
{
	const baseline = "durable disk baseline\n";
	const crdt = "provider-only CRDT change\n";
	const fix = buildFixture({
		path: "Notes/closed-dirty-policy-crdt-only.md",
		disk: baseline,
		editor: baseline,
		crdt,
	});
	fix.setBaselineContent(baseline);
	fix.setOpen(false);
	fix.setBound(false);
	fix.setRemoteProjectionAllowed(false);

	await fix.ingestDiskFileNow("modify");

	assertEq(
		fix.getCurrentDiskContent(),
		baseline,
		"three-way CRDT-only recovery preserves disk while provider policy is closed",
	);
	assertEq(
		fix.getFlushWriteCalls().length,
		0,
		"three-way CRDT-only recovery never reaches an ungated DiskMirror write",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 5f4 — intercepted candidate lifecycle is monotonic and durable
// -------------------------------------------------------------------

console.log("\n--- Test 5f4a: only an exact duplicate sequence is idempotent ---");
{
	const fix = buildFixture({
		path: "Notes/intercepted-duplicate.md",
		disk: "external\n",
		editor: "base\n",
		crdt: "base\n",
	});
	const candidate = makeInterceptedCandidate(fix.path, "external\n", 7);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, "external\n", 7),
	);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, "different bytes must be ignored\n", 7),
	);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"same-sequence discarded revision",
	);

	const retained = getInterceptedCandidates(fix.controller);
	assertEq(retained.size, 1, "duplicate sequence retains one candidate");
	assert(retained.get(fix.path) === candidate, "duplicate sequence keeps the first exact candidate object");
	assertEq(fix.getCreatedFiles().size, 0, "same-sequence disagreement creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) =>
			record.reason === "superseded-external-revision"
		),
		"same-sequence bytes that disagree with the retained candidate are recorded as discarded",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b: newer same-content revision replaces metadata without an artifact ---");
{
	const content = "same external bytes\n";
	const fix = buildFixture({
		path: "Notes/intercepted-same-content.md",
		disk: content,
		editor: "base\n",
		crdt: "base\n",
	});
	const older = makeInterceptedCandidate(fix.path, content, 8);
	const newer = makeInterceptedCandidate(fix.path, content, 9);
	fix.controller.noteInterceptedExternalDiskMutation(older);
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	clearMarkdownDrainTimer(fix.controller);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	assertEq(fix.getCreatedFiles().size, 0, "same-content replacement creates no needless artifact");
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === newer,
		"same-content replacement retains the newer exact candidate object",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b1: unchanged editor lineage never suppresses a distinct disk revision ---");
{
	const olderRaw = "base\nimportant external B\n";
	const newerRaw = "base\nreplacement external C\n";
	const fix = buildFixture({
		path: "Notes/intercepted-proven-transient.md",
		disk: newerRaw,
		editor: "visible editor authority\n",
		crdt: "visible editor authority\n",
	});
	const unchangedLineage = makeExternalEditorLineage(fix.path, 7, 11);
	const older = makeInterceptedCandidate(fix.path, olderRaw, 9, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 10_000,
	});
	const newer = makeInterceptedCandidate(fix.path, newerRaw, 10, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 70_000,
	});
	fix.controller.noteInterceptedExternalDiskMutation(older);
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4b1 superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "unchanged editor authority creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"the independent older disk version is recorded as discarded",
	);
	assertEq(
		getPendingSupersededCandidates(fix.controller).length,
		0,
		"the distinct older revision retires only after durable discard recording",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === newer,
		"the newest exact disk revision remains authoritative for reconciliation",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b2: out-of-order reads preserve the older distinct revision ---");
{
	const olderRaw = "delayed intermediate\n";
	const newerRaw = "already completed final\n";
	const fix = buildFixture({
		path: "Notes/intercepted-proven-out-of-order.md",
		disk: newerRaw,
		editor: "visible editor authority\n",
		crdt: "visible editor authority\n",
	});
	const unchangedLineage = makeExternalEditorLineage(fix.path, 13, 19);
	const older = makeInterceptedCandidate(fix.path, olderRaw, 20, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 20_000,
	});
	const newer = makeInterceptedCandidate(fix.path, newerRaw, 21, {
		editorAuthorityLineage: unchangedLineage,
		observedAt: 20_090,
	});
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	fix.controller.noteInterceptedExternalDiskMutation(older);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4b2 superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "delayed older read creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"a delayed older read is recorded as discarded instead of being inferred transient",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === newer,
		"out-of-order completion cannot replace the newest exact revision",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b2a: subsequence content is not causal adoption proof ---");
{
	const beforeOlder = "title\nkeep me\n";
	const olderRaw = "title\n";
	const newerEditor = "title\nkeep me\nlocal X\n";
	const newerRaw = `${newerEditor}filesystem Y\n`;
	const fix = buildFixture({
		path: "Notes/intercepted-false-adoption.md",
		disk: newerRaw,
		editor: newerEditor,
		crdt: newerEditor,
	});
	const older = makeInterceptedCandidate(fix.path, olderRaw, 22, {
		editorAuthorityLineage: makeExternalEditorLineage(fix.path, 3, 8, {
			editorContent: beforeOlder,
		}),
	});
	const newer = makeInterceptedCandidate(fix.path, newerRaw, 23, {
		editorAuthorityLineage: makeExternalEditorLineage(fix.path, 4, 9, {
			editorContent: newerEditor,
		}),
	});
	fix.controller.noteInterceptedExternalDiskMutation(older);
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4b2a superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "false-adoption candidate creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"an external deletion is recorded as discarded when later editor input did not adopt it",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === newer,
		"the newest disk revision remains queued after preserving the false-adoption candidate",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b3: an editor-authority advance vetoes revision coalescing ---");
{
	const olderRaw = "external before editor change\n";
	const newerRaw = "external after editor change\n";
	const fix = buildFixture({
		path: "Notes/intercepted-editor-advance.md",
		disk: newerRaw,
		editor: "visible editor authority\n",
		crdt: "visible editor authority\n",
	});
	const older = makeInterceptedCandidate(fix.path, olderRaw, 30, {
		editorAuthorityLineage: makeExternalEditorLineage(fix.path, 3, 8),
		observedAt: 30_000,
	});
	const newer = makeInterceptedCandidate(fix.path, newerRaw, 31, {
		editorAuthorityLineage: makeExternalEditorLineage(fix.path, 4, 9),
		observedAt: 30_080,
	});
	fix.controller.noteInterceptedExternalDiskMutation(older);
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4b3 superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "intervening editor authority creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"intervening editor authority records the older exact disk revision as discarded",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4b4: every distinct revision fails closed across lineage and timing variants ---");
{
	const cases = [
		{
			label: "missing lineage",
			olderLineage: undefined,
			newerLineage: makeExternalEditorLineage("Notes/fail-closed-missing.md", 2, 5),
			path: "Notes/fail-closed-missing.md",
			olderObservedAt: 40_000,
			newerObservedAt: 40_050,
		},
		{
			label: "changed pane lineage",
			olderLineage: makeExternalEditorLineage("Notes/fail-closed-pane.md", 2, 5),
			newerLineage: Object.freeze({
				path: "Notes/fail-closed-pane.md",
				views: Object.freeze([Object.freeze({
					...makeExternalEditorLineage("Notes/fail-closed-pane.md", 2, 5).views[0]!,
					viewId: "replacement-view",
				})]),
			}),
			path: "Notes/fail-closed-pane.md",
			olderObservedAt: 50_000,
			newerObservedAt: 50_050,
		},
		{
			label: "expired proof window",
			olderLineage: makeExternalEditorLineage("Notes/fail-closed-window.md", 2, 5),
			newerLineage: makeExternalEditorLineage("Notes/fail-closed-window.md", 2, 5),
			path: "Notes/fail-closed-window.md",
			olderObservedAt: 60_000,
			newerObservedAt: 63_001,
		},
	] as const;

	for (const scenario of cases) {
		const olderRaw = `${scenario.label} older\n`;
		const newerRaw = `${scenario.label} newer\n`;
		const fix = buildFixture({
			path: scenario.path,
			disk: newerRaw,
			editor: "visible editor authority\n",
			crdt: "visible editor authority\n",
		});
		const older = makeInterceptedCandidate(fix.path, olderRaw, 40, {
			editorAuthorityLineage: scenario.olderLineage,
			observedAt: scenario.olderObservedAt,
		});
		const newer = makeInterceptedCandidate(fix.path, newerRaw, 41, {
			editorAuthorityLineage: scenario.newerLineage,
			observedAt: scenario.newerObservedAt,
		});
		fix.controller.noteInterceptedExternalDiskMutation(older);
		fix.controller.noteInterceptedExternalDiskMutation(newer);
		clearMarkdownDrainTimer(fix.controller);
		await waitForAsyncCondition(
			() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
			`${scenario.label} superseded discard`,
		);
		assertEq(fix.getCreatedFiles().size, 0, `${scenario.label} creates no conflict artifact`);
		assert(
			fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
			`${scenario.label} records the older exact disk revision as discarded`,
		);
		fix.controller.reset();
		fix.doc.destroy();
	}
}

console.log("\n--- Test 5f4c: newer revision durably preserves the superseded current candidate ---");
{
	const baseline = "base\n";
	const olderRaw = "older external A\r\n";
	const newerRaw = "newer external B\n";
	const fix = buildFixture({
		path: "Notes/intercepted-forward-superseded.md",
		disk: newerRaw,
		editor: baseline,
		crdt: baseline,
	});
	fix.setBaselineContent(baseline);
	const baselineBefore = fix.getDiskIndexContentHash();
	const older = makeInterceptedCandidate(fix.path, olderRaw, 11);
	const newer = makeInterceptedCandidate(fix.path, newerRaw, 12);
	fix.controller.noteInterceptedExternalDiskMutation(older);
	fix.controller.noteInterceptedExternalDiskMutation(newer);
	clearMarkdownDrainTimer(fix.controller);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4c superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "newer revision creates no conflict artifact");
	assertEq(
		fix.getDiscardedRevisions().filter((record) => record.reason === "superseded-external-revision").length,
		1,
		"newer revision records raw A exactly once as superseded",
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === newer,
		"raw B remains the retained current candidate before settlement",
	);
	assertEq(fix.ytext.toString(), baseline, "recording raw A alone does not mutate Y.Text");
	assertEq(fix.getCurrentDiskContent(), newerRaw, "recording raw A does not mutate the primary path");
	assertEq(fix.getDiskIndexContentHash(), baselineBefore, "recording raw A does not advance baseline");

	await drainQueuedMarkdown(fix.controller);
	assertEq(fix.ytext.toString(), newerRaw, "the queued current candidate settles raw B into Y.Text");
	assertEq(fix.getCurrentDiskContent(), newerRaw, "settlement keeps raw B at the primary path");
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "settled raw B retires the current candidate");
	assertEq(
		fix.getDiscardedRevisions().filter((record) => record.reason === "superseded-external-revision").length,
		1,
		"settling raw B does not duplicate the superseded raw A record",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4d: delayed older revision is preserved without changing primary authority ---");
{
	const baseline = "base\n";
	const latest = "latest external\n";
	const older = "older external\r\n";
	const fix = buildFixture({
		path: "Notes/intercepted-superseded.md",
		disk: latest,
		editor: baseline,
		crdt: baseline,
	});
	fix.setBaselineContent(baseline);
	const baselineBefore = fix.getDiskIndexContentHash();
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, latest, 12),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, older, 11),
	);
	await waitForAsyncCondition(
		() => fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"5f4d superseded discard",
	);

	assertEq(fix.getCreatedFiles().size, 0, "older distinct revision creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"older distinct revision is recorded as a superseded discard",
	);
	assertEq(fix.ytext.toString(), baseline, "superseded preservation never mutates Y.Text");
	assertEq(fix.getCurrentDiskContent(), latest, "superseded preservation never mutates primary disk");
	assertEq(fix.getDiskIndexContentHash(), baselineBefore, "superseded preservation never advances baseline");
	assertEq(
		getInterceptedCandidates(fix.controller).get(fix.path)?.sequence,
		12,
		"newer candidate remains retained for reconciliation",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4d1: superseded revision equal to the durable baseline is skipped without an artifact ---");
{
	// Regression for the 2026-08-13 checkbox incident: a stale out-of-order disk
	// read carrying the pre-edit bytes (v0) was preserved as a `(KAOS conflict -
	// disk ...)` artifact even though those exact bytes were already the durable
	// baseline. Preservation must skip revisions that hash to the disk-index
	// contentHash — an artifact for them adds zero recoverable information.
	const baseline = "base\n";
	const latest = "latest external\n";
	const fix = buildFixture({
		path: "Notes/intercepted-superseded-baseline-skip.md",
		disk: latest,
		editor: baseline,
		crdt: baseline,
	});
	fix.setBaselineContent(baseline);
	const baselineBefore = fix.getDiskIndexContentHash();
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, latest, 12),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, baseline, 11),
	);
	await waitForAsyncCondition(
		() => getPendingSupersededCandidates(fix.controller).length === 0,
		"baseline-equal superseded candidate to retire without preservation",
	);

	assertEq(fix.getCreatedFiles().size, 0, "baseline-equal revision creates no conflict artifact");
	assert(
		fix.traces.some(
			(trace) =>
				trace.msg === "superseded-external-revision-baseline-skipped" &&
				trace.details?.path === fix.path &&
				trace.details?.sequence === 11,
		),
		"baseline skip is traced with the exact candidate sequence",
	);
	assertEq(fix.ytext.toString(), baseline, "baseline skip never mutates Y.Text");
	assertEq(fix.getCurrentDiskContent(), latest, "baseline skip never mutates primary disk");
	assertEq(fix.getDiskIndexContentHash(), baselineBefore, "baseline skip never advances baseline");
	assertEq(
		getInterceptedCandidates(fix.controller).get(fix.path)?.sequence,
		12,
		"newer candidate remains retained for reconciliation",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4d2: superseded revision differing from the baseline is still preserved ---");
{
	// Fail-closed contrast for 5f4d1: only the exact durable-baseline bytes are
	// skippable. Any other distinct superseded revision must still become a
	// conflict artifact, and the skip trace must not fire.
	const baseline = "base\n";
	const latest = "latest external\n";
	const older = "older external\r\n";
	const fix = buildFixture({
		path: "Notes/intercepted-superseded-baseline-preserve.md",
		disk: latest,
		editor: baseline,
		crdt: baseline,
	});
	fix.setBaselineContent(baseline);
	const baselineBefore = fix.getDiskIndexContentHash();
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, latest, 12),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, older, 11),
	);
	await waitForAsyncCondition(
		() => getPendingSupersededCandidates(fix.controller).length === 0,
		"non-baseline superseded candidate to be durably preserved",
	);

	assertEq(fix.getCreatedFiles().size, 0, "non-baseline revision creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"non-baseline revision is recorded as a superseded discard",
	);
	assertEq(
		fix.traces.some((trace) => trace.msg === "superseded-external-revision-baseline-skipped"),
		false,
		"non-baseline revision never emits the baseline-skip trace",
	);
	assertEq(fix.ytext.toString(), baseline, "preservation never mutates Y.Text");
	assertEq(fix.getCurrentDiskContent(), latest, "preservation never mutates primary disk");
	assertEq(fix.getDiskIndexContentHash(), baselineBefore, "preservation never advances baseline");
	assertEq(
		getInterceptedCandidates(fix.controller).get(fix.path)?.sequence,
		12,
		"newer candidate remains retained for reconciliation",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4d3: missing baseline hash keeps fail-closed preservation ---");
{
	// The skip guard must be inert when the disk index has no hash for the path:
	// inability to prove redundancy is not proof of cleanliness.
	const latest = "latest external\n";
	const older = "older external\r\n";
	const fix = buildFixture({
		path: "Notes/intercepted-superseded-no-baseline.md",
		disk: latest,
		editor: "base\n",
		crdt: "base\n",
	});
	fix.clearDiskIndex();
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, latest, 12),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, older, 11),
	);
	await waitForAsyncCondition(
		() => getPendingSupersededCandidates(fix.controller).length === 0,
		"superseded candidate with missing baseline to be preserved",
	);

	assertEq(fix.getCreatedFiles().size, 0, "missing baseline creates no conflict artifact");
	assert(
		fix.getDiscardedRevisions().some((record) => record.reason === "superseded-external-revision"),
		"missing baseline still records the exact distinct bytes as discarded",
	);
	assertEq(
		fix.traces.some((trace) => trace.msg === "superseded-external-revision-baseline-skipped"),
		false,
		"missing baseline never emits the baseline-skip trace",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4e: reset, rename, and delete invalidation clear candidates ---");
{
	const fix = buildFixture({
		path: "Notes/intercepted-invalidation.md",
		disk: "external\n",
		editor: "base\n",
		crdt: "base\n",
	});
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, "external\n", 21),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.redirectPendingDirtyPath(fix.path, "Notes/intercepted-renamed.md");
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "rename invalidation clears path candidates");

	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, "external\n", 22),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.dropDirtyPath(fix.path);
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "delete/drop invalidation clears path candidate");

	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, "external\n", 23),
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "reset clears all intercepted candidates");
	fix.doc.destroy();
}

console.log("\n--- Test 5f4f: current candidate clears only after successful settlement ---");
{
	const base = "base\n";
	const external = "external\n";
	const fix = buildFixture({
		path: "Notes/intercepted-settlement.md",
		disk: external,
		editor: base,
		crdt: base,
	});
	fix.setBaselineContent(base);
	fix.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(fix.path, external, 31),
	);
	await drainQueuedMarkdown(fix.controller);

	assertEq(fix.ytext.toString(), external, "current candidate reaches Y.Text before retirement");
	assertEq(fix.getCurrentDiskContent(), external, "current candidate is durably settled on disk");
	assertEq(getInterceptedCandidates(fix.controller).size, 0, "successful settlement clears current candidate");
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5f4g: failed flush retains the current candidate ---");
{
	const baseline = "base\n";
	const external = "external\n";
	const flushFailure = buildFixture({
		path: "Notes/intercepted-flush-failure.md",
		disk: external,
		editor: baseline,
		crdt: baseline,
	});
	flushFailure.setBaselineContent(baseline);
	flushFailure.setFlushWriteBoundaryHook(() => {
		flushFailure.setDiskContent("newer disk content\n");
	});
	flushFailure.controller.noteInterceptedExternalDiskMutation(
		makeInterceptedCandidate(flushFailure.path, external, 42),
	);
	await drainQueuedMarkdown(flushFailure.controller);
	flushFailure.setFlushWriteBoundaryHook(null);
	assertEq(
		flushFailure.getFlushWriteCalls()[0]?.expectedDiskContent,
		external,
		"failed flush still used the admitted raw candidate CAS",
	);
	assertEq(
		getInterceptedCandidates(flushFailure.controller).get(flushFailure.path)?.sequence,
		42,
		"failed flush retains current candidate",
	);
	clearMarkdownDrainTimer(flushFailure.controller);
	flushFailure.controller.reset();
	flushFailure.doc.destroy();
}

console.log("\n--- Test 5g1: eventless same-TFile disk byte change rejects recovery ---");
{
	const fix = buildFixture({
		path: "Notes/fence-eventless-disk-change.md",
		disk: "disk snapshot D1",
		editor: "disk snapshot D1",
		crdt: "CRDT C",
	});
	const deps = (fix.controller as never as {
		deps: { computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null> };
	}).deps;
	deps.computeRecoveryStateHash = async () => {
		fix.setDiskContent("disk snapshot D2");
		return "disk-changed-during-recovery-hash";
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "CRDT C", "eventless newer disk bytes do not let D1 replace CRDT");
	assertEq(fix.getCurrentDiskContent(), "disk snapshot D2", "newer same-file disk bytes remain intact");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-content-changed"
		),
		"final fence diagnoses an eventless disk byte change",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"stale D1 produces no recovery transaction",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g1b: same-length disk microtask after final read rejects recovery ---");
{
	const admittedDiskContent = "disk snapshot D1";
	const newerDiskContent = "disk snapshot D2";
	const fix = buildFixture({
		path: "Notes/fence-final-read-microtask.md",
		disk: admittedDiskContent,
		editor: admittedDiskContent,
		crdt: "CRDT C",
	});
	assertEq(newerDiskContent.length, admittedDiskContent.length, "race candidates have identical size");
	const mutableFile = fix.file as TFile & {
		stat: { mtime: number; size: number };
	};
	mutableFile.stat = { mtime: 1, size: admittedDiskContent.length };
	const deps = (fix.controller as never as {
		deps: {
			app: {
				vault: {
					read(file: TFile): Promise<string>;
				};
			};
		};
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	let primaryReadCount = 0;
	deps.app.vault.read = async (file: TFile) => {
		const captured = await originalRead(file);
		if (file === fix.file && ++primaryReadCount === 2) {
			// The final vault read has already captured D1. Queue D2 before the
			// helper's await continuation, without advancing the controller's disk
			// event revision, to exercise the exact read-resolution seam.
			queueMicrotask(() => {
				fix.setDiskContent(newerDiskContent);
				mutableFile.stat = { mtime: 2, size: newerDiskContent.length };
			});
		}
		return captured;
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(primaryReadCount, 2, "race is injected by the final ticket read");
	assertEq(fix.ytext.toString(), "CRDT C", "captured D1 cannot replace CRDT after D2 wins the file epoch");
	assertEq(fix.getCurrentDiskContent(), newerDiskContent, "same-length D2 remains on disk");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-stat-changed"
		),
		"final fence diagnoses the stat epoch change without an event revision",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"post-read disk microtask produces no recovery transaction",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g1c: closed disk-only import uses the final read fence ---");
{
	const admittedDiskContent = "closed disk D1";
	const newerDiskContent = "closed disk D2";
	const fix = buildFixture({
		path: "Notes/fence-closed-disk-import.md",
		disk: admittedDiskContent,
		editor: admittedDiskContent,
		crdt: "closed CRDT C",
	});
	fix.setOpen(false);
	fix.setBound(false);
	assertEq(newerDiskContent.length, admittedDiskContent.length, "closed race candidates have identical size");
	const mutableFile = fix.file as TFile & {
		stat: { mtime: number; size: number };
	};
	mutableFile.stat = { mtime: 1, size: admittedDiskContent.length };
	const deps = (fix.controller as never as {
		deps: {
			app: {
				vault: {
					read(file: TFile): Promise<string>;
				};
			};
		};
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	let primaryReadCount = 0;
	deps.app.vault.read = async (file: TFile) => {
		const captured = await originalRead(file);
		if (file === fix.file && ++primaryReadCount === 2) {
			queueMicrotask(() => {
				fix.setDiskContent(newerDiskContent);
				mutableFile.stat = { mtime: 2, size: newerDiskContent.length };
			});
		}
		return captured;
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(primaryReadCount, 2, "closed importer performs an exact final ticket read");
	assertEq(fix.ytext.toString(), "closed CRDT C", "closed stale D1 cannot roll CRDT back");
	assertEq(fix.getCurrentDiskContent(), newerDiskContent, "closed same-length D2 remains on disk");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "closed-file-mutation-ticket-stale" &&
			trace.details?.reason === "disk-stat-changed"
		),
		"closed generic disk import is routed through the exact final fence",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g2: same-bytes TFile replacement rejects recovery ---");
{
	const diskContent = "same disk bytes";
	const fix = buildFixture({
		path: "Notes/fence-file-aba.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "CRDT C",
	});
	const internals = fix.controller as never as {
		deps: {
			app: {
				vault: {
					getAbstractFileByPath(path: string): unknown;
				};
			};
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const originalLookup = internals.deps.app.vault.getAbstractFileByPath.bind(
		internals.deps.app.vault,
	);
	let occupant: TFile = fix.file;
	internals.deps.app.vault.getAbstractFileByPath = (path: string) =>
		path === fix.path ? occupant : originalLookup(path);
	internals.deps.computeRecoveryStateHash = async () => {
		occupant = makeTFile(fix.path);
		return "same-bytes-file-replaced";
	};

	await fix.ingestDiskFileNow("modify");

	assertEq(fix.ytext.toString(), "CRDT C", "replacement TFile cannot authorize the captured snapshot");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "disk-file-identity-changed"
		),
		"final fence diagnoses same-bytes TFile ABA",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"same-bytes TFile ABA produces no CRDT mutation",
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g3: same-bytes Y.Text replacement during planner hash is rejected ---");
{
	const fix = buildFixture({
		path: "Notes/fence-ytext-hash-aba.md",
		disk: "disk D",
		editor: "disk D",
		crdt: "CRDT C",
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, "CRDT C");
	let currentText: Y.Text | null = fix.ytext;
	const vaultSync = (fix.controller as never as {
		deps: { getVaultSync(): { getTextForPath(path: string): Y.Text | null } };
	}).deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;

	queueMicrotask(() => {
		currentText = replacementText;
	});
	const outcome = await invokeBoundFileSyncGap(fix);

	assertEq(outcome.kind, "deferred", "hash-window Y.Text ABA defers the stale recovery");
	assertEq(fix.ytext.toString(), "CRDT C", "captured Y.Text remains an untouched candidate");
	assertEq(replacementText.toString(), "CRDT C", "replacement same-bytes Y.Text also remains untouched");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-text-replaced"
		),
		"final fence compares Y.Text identity, not only bytes",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g4: provider advance during recovery-state hash is preserved ---");
{
	const fix = buildFixture({
		path: "Notes/fence-provider-advance.md",
		disk: "disk D",
		editor: "disk D",
		crdt: "CRDT C1",
	});
	const providerOrigin = { provider: "advance-during-recovery-hash" };
	const deps = (fix.controller as never as {
		deps: { computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null> };
	}).deps;
	deps.computeRecoveryStateHash = async () => {
		fix.doc.transact(() => {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "CRDT C2 provider latest");
		}, providerOrigin);
		return "provider-advanced";
	};

	const outcome = await invokeBoundFileSyncGap(fix);

	assertEq(outcome.kind, "deferred", "provider advance makes the captured recovery stale");
	assertEq(fix.ytext.toString(), "CRDT C2 provider latest", "new provider content survives the D snapshot");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-content-changed"
		),
		"provider advance is diagnosed as changed CRDT content",
	);
	assert(
		!fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"stale recovery cannot transact after provider advance",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

console.log("\n--- Test 5g5: artifact await keeps all candidates on same-bytes Y.Text ABA ---");
{
	const diskContent = "disk D";
	const crdtContent = "CRDT C";
	const editorContent = "editor E";
	const fix = buildFixture({
		path: "Notes/fence-artifact-ytext-aba.md",
		disk: diskContent,
		editor: editorContent,
		crdt: crdtContent,
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, crdtContent);
	let currentText: Y.Text | null = fix.ytext;
	type MutationAttempt<T> = { kind: "committed"; value: T } | { kind: "stale" };
	const internals = fix.controller as never as {
		deps: {
			app: {
				vault: {
					create(path: string, content: string): Promise<unknown>;
				};
			};
			getVaultSync(): { getTextForPath(path: string): Y.Text | null };
		};
		getMarkdownDiskRevision(path: string): number;
		commitOpenEditorDiskMutation<T>(
			input: Record<string, unknown> & { commit: () => T },
		): Promise<MutationAttempt<T>>;
		preserveOpenBoundPlannerConflict(input: Record<string, unknown>): Promise<boolean>;
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;
	const originalCreate = internals.deps.app.vault.create.bind(internals.deps.app.vault);
	let createCalls = 0;
	internals.deps.app.vault.create = async (path: string, content: string) => {
		createCalls++;
		await originalCreate(path, content);
	};
	const expectedDiskRevision = internals.getMarkdownDiskRevision(fix.path);

	const preserved = await internals.preserveOpenBoundPlannerConflict({
		file: fix.file,
		diskContent,
		crdtContent,
		expectedYText: fix.ytext,
		targetContent: editorContent,
		commitTarget: (commit: () => boolean) => internals.commitOpenEditorDiskMutation({
			path: fix.path,
			file: fix.file,
			expectedDiskContent: diskContent,
			expectedYText: fix.ytext,
			expectedCrdtContent: crdtContent,
			ticket: null,
			expectedDiskRevision,
			expectedVisibleAuthorityMarker: null,
			stage: "test-planner-conflict",
			commit,
		}),
		reason: "test-planner-conflict",
		preserveDisk: true,
		preserveCrdt: true,
		editorViewCount: 1,
		distinctEditorContentCount: 1,
		chosenSource: "editor",
	});

	assert(preserved === true, "planner conflict records discards and commits the winner");
	assertEq(fix.ytext.toString(), editorContent, "the editor winner converges into Y.Text");
	assertEq((fix.view.editor as { getValue(): string }).getValue(), editorContent, "visible editor candidate remains exact");
	assertEq(createCalls, 0, "no conflict artifact file is created");
	assertEq(
		fix.getDiscardedRevisions().filter((record) =>
			record.reason === "test-planner-conflict" || record.reason === "test-planner-conflict-disk"
		).length,
		2,
		"CRDT and disk candidates are both recorded as discarded revisions",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g6: seed is blocked when CRDT appears during recovery hash ---");
{
	const diskContent = "disk seed D";
	const fix = buildFixture({
		path: "Notes/fence-seed-race.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "unused captured text",
	});
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	replacementText.insert(0, "provider-created CRDT");
	let currentText: Y.Text | null = null;
	let ensureFileCalls = 0;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): {
				getTextForPath(path: string): Y.Text | null;
				ensureFile(path: string, content: string, deviceName: string, options: unknown): EnsureFileResult;
			};
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => path === fix.path ? currentText : null;
	vaultSync.ensureFile = (_path, content) => {
		ensureFileCalls++;
		replacementText.delete(0, replacementText.length);
		replacementText.insert(0, content);
		return { kind: "created", fileId: "replacement-file-id", ytext: replacementText };
	};
	internals.deps.computeRecoveryStateHash = async () => {
		currentText = replacementText;
		return "crdt-appeared-before-seed";
	};

	const outcome = await invokeBoundFileSyncGap(fix, null);

	assertEq(outcome.kind, "deferred", "new CRDT authority defers the stale seed");
	assertEq(ensureFileCalls, 0, "ensureFile is never called after a null-to-Y.Text ABA");
	assertEq(replacementText.toString(), "provider-created CRDT", "provider-created CRDT remains intact");
	assert(
		fix.traces.some((trace) =>
			trace.msg === "open-editor-mutation-ticket-stale" &&
			trace.details?.reason === "crdt-text-replaced"
		),
		"seed race records the new Y.Text identity",
	);
	fix.controller.reset();
	fix.doc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g6a: successful missing-Y.Text seed settles with the exact created authority ---");
{
	const diskContent = "disk seed exact authority\n";
	const fix = buildFixture({
		path: "Notes/fence-seed-exact-settlement.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "fixture placeholder that is not the bound authority",
	});
	const seededDoc = new Y.Doc();
	const seededText = seededDoc.getText("content");
	let currentText: Y.Text | null = null;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): {
				getTextForPath(path: string): Y.Text | null;
				ensureFile(
					path: string,
					content: string,
					deviceName: string,
					options: unknown,
				): EnsureFileResult;
			};
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path) => path === fix.path ? currentText : null;
	vaultSync.ensureFile = (_path, content) => {
		seededText.insert(0, content);
		currentText = seededText;
		return { kind: "created", fileId: "seeded-file-id", ytext: seededText };
	};

	const outcome = await invokeBoundFileSyncGap(fix, null);

	assertEq(outcome.kind, "handled", "exact missing-Y.Text seed is handled");
	assert(
		outcome.settlement?.expectedYText === seededText,
		"seed settlement carries the exact Y.Text returned by ensureFile",
	);
	assertEq(
		outcome.settlement?.expectedCrdtContent,
		diskContent,
		"seed settlement carries the exact seeded CRDT content",
	);
	assertEq(
		outcome.settlement?.content,
		diskContent,
		"seed settlement carries the exact disk candidate",
	);
	fix.controller.reset();
	fix.doc.destroy();
	seededDoc.destroy();
}

type InvalidSeedPostcondition = "replan" | "blocked" | "replacement" | "content-mismatch";
for (const invalidPostcondition of [
	"replan",
	"blocked",
	"replacement",
	"content-mismatch",
] as InvalidSeedPostcondition[]) {
	console.log(
		`\n--- Test 5g6b (${invalidPostcondition}): invalid missing-Y.Text seed is replanned ---`,
	);
	const diskContent = `disk seed ${invalidPostcondition}\n`;
	const fix = buildFixture({
		path: `Notes/fence-seed-${invalidPostcondition}.md`,
		disk: diskContent,
		editor: diskContent,
		crdt: "fixture placeholder that is not the bound authority",
	});
	const candidate = makeInterceptedCandidate(fix.path, diskContent, 300);
	fix.controller.noteInterceptedExternalDiskMutation(candidate);
	clearMarkdownDrainTimer(fix.controller);
	const returnedDoc = new Y.Doc();
	const returnedText = returnedDoc.getText("content");
	const replacementDoc = new Y.Doc();
	const replacementText = replacementDoc.getText("content");
	let currentText: Y.Text | null = null;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): {
				getTextForPath(path: string): Y.Text | null;
				ensureFile(
					path: string,
					content: string,
					deviceName: string,
					options: unknown,
				): EnsureFileResult;
			};
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path) => path === fix.path ? currentText : null;
	vaultSync.ensureFile = (_path, content) => {
		if (invalidPostcondition === "replan") {
			return { kind: "replan", reason: "active-set-changed" };
		}
		if (invalidPostcondition === "blocked") {
			return { kind: "blocked", reason: "collision" };
		}
		returnedText.insert(
			0,
			invalidPostcondition === "content-mismatch" ? "wrong seeded content\n" : content,
		);
		if (invalidPostcondition === "replacement") {
			replacementText.insert(0, content);
			currentText = replacementText;
		} else {
			currentText = returnedText;
		}
		return { kind: "created", fileId: "returned-file-id", ytext: returnedText };
	};

	const outcome = await invokeBoundFileSyncGap(fix, null);

	assertEq(outcome.kind, "deferred", `${invalidPostcondition}: invalid seed requests a fresh plan`);
	assertEq(
		outcome.settlement,
		undefined,
		`${invalidPostcondition}: invalid seed exposes no settlement proof`,
	);
	assertEq(
		fix.getBaselineAdvanceCount(),
		0,
		`${invalidPostcondition}: invalid seed records no baseline`,
	);
	assert(
		getInterceptedCandidates(fix.controller).get(fix.path) === candidate,
		`${invalidPostcondition}: invalid seed retains the exact intercepted candidate`,
	);
	clearMarkdownDrainTimer(fix.controller);
	fix.controller.reset();
	fix.doc.destroy();
	returnedDoc.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Test 5g7: queued provider microtask runs after fenced recovery commit ---");
{
	const diskContent = "disk D";
	const providerContent = "provider C2 latest";
	const fix = buildFixture({
		path: "Notes/fence-provider-microtask.md",
		disk: diskContent,
		editor: diskContent,
		crdt: "CRDT C1",
	});
	const providerOrigin = { provider: "queued-after-final-y-read" };
	let armProviderAdvance = false;
	let providerAdvanceQueued = false;
	const internals = fix.controller as never as {
		deps: {
			getVaultSync(): { getTextForPath(path: string): Y.Text | null };
			computeRecoveryStateHash?: (path: string, content: string) => Promise<string | null>;
		};
	};
	const vaultSync = internals.deps.getVaultSync();
	vaultSync.getTextForPath = (path: string) => {
		if (path === fix.path && armProviderAdvance && !providerAdvanceQueued) {
			providerAdvanceQueued = true;
			queueMicrotask(() => {
				fix.doc.transact(() => {
					fix.ytext.delete(0, fix.ytext.length);
					fix.ytext.insert(0, providerContent);
				}, providerOrigin);
			});
		}
		return path === fix.path ? fix.ytext : null;
	};
	internals.deps.computeRecoveryStateHash = async () => {
		armProviderAdvance = true;
		return "queue-provider-after-final-validation";
	};

	await invokeBoundFileSyncGap(fix);
	await Promise.resolve();

	assert(providerAdvanceQueued, "provider microtask is queued by the final Y.Text lookup");
	assertEq(fix.ytext.toString(), providerContent, "provider C2 lands after D and remains the final authority");
	const recoveryIndex = fix.transactionOrigins.indexOf(ORIGIN_DISK_SYNC_RECOVER_BOUND);
	const providerIndex = fix.transactionOrigins.indexOf(providerOrigin);
	assert(
		recoveryIndex >= 0 && providerIndex > recoveryIndex,
		"CRDT mutation runs inside the fence before its Promise resolves to the queued provider microtask",
	);
	fix.controller.reset();
	fix.doc.destroy();
}

// -------------------------------------------------------------------
// Test 6 — quarantine after three identical attempts
// -------------------------------------------------------------------

console.log("\n--- Test 6: third identical recovery is quarantined ---");
{
	const fix = buildFixture({
		path: "Notes/quarantine-test.md",
		disk: "AAA",
		editor: "AAA",
		crdt: "BBB",
	});

	// Drive three attempts with identical fingerprint (same prev/next content).
	for (let i = 0; i < 3; i++) {
		// Reset CRDT to BBB so each attempt has the same prev/next pair.
		if (i > 0) {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "BBB");
		}
		fix.setBaselineContent("BBB");
		// Clear the lock so each attempt re-enters the recovery branch.
		(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
			.boundRecoveryLocks.clear();
		await fix.ingestDiskFileNow("modify");
	}

	const decisions = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyStarts = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const applyDones = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repairs = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	const quarantined = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryQuarantined);
	const loopDetected = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryLoopDetected);

	assertEq(decisions.length, 3, "three recovery.decision events (one per attempt)");
	assertEq(applyStarts.length, 2, "only the first two attempts entered apply.start");
	assertEq(applyDones.length, 2, "only the first two attempts emitted apply.done");
	assertEq(repairs.length, 2, "only the first two attempts emitted editor.repair.applied");
	assertEq(quarantined.length, 1, "exactly one recovery.quarantined event");
	assertEq(loopDetected.length, 1, "exactly one recovery.loop.detected event");

	assertEq(quarantined[0]?.data.repeatCount, 3, "quarantined.repeatCount === 3");
	assertEq(
		quarantined[0]?.data.reason,
		"bound-file-local-only-divergence",
		"quarantined.reason",
	);
	assert(
		typeof quarantined[0]?.data.signature === "string" &&
		(quarantined[0].data.signature as string).length > 0,
		"quarantined.signature is non-empty string",
	);

	assertEq(loopDetected[0]?.data.repeatCount, 3, "loop.detected.repeatCount === 3");
	assertEq(
		loopDetected[0]?.data.signature,
		quarantined[0]?.data.signature,
		"loop.detected.signature matches quarantined.signature",
	);

	// Assert the quarantine ordering on the third attempt: after the
	// recovery.decision fires, the next recovery-layer event is
	// recovery.quarantined (not apply.start).
	const recoveryLayerKinds = fix.captured
		.filter((e) => e.layer === "recovery")
		.map((e) => e.kind);
	const lastDecisionIdx = recoveryLayerKinds.lastIndexOf(FLIGHT_KIND.recoveryDecision);
	assert(lastDecisionIdx >= 0, "third recovery.decision present");
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 1],
		FLIGHT_KIND.recoveryQuarantined,
		"event after third decision is recovery.quarantined",
	);
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 2],
		FLIGHT_KIND.recoveryLoopDetected,
		"event after recovery.quarantined is recovery.loop.detected",
	);

	// Y.Text final state: third attempt was quarantined before applying any
	// diff, so the second attempt's CRDT content (BBB → AAA) is the last
	// applied state. We reset ytext to BBB before the third attempt; since
	// the third was quarantined, ytext should remain BBB.
	assertEq(
		fix.ytext.toString(),
		"BBB",
		"Y.Text remains at BBB after quarantined third attempt",
	);

	const healOnQuarantine = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnQuarantine.length, 0, "no editor.heal.* events across the three quarantine attempts");
}

// -------------------------------------------------------------------
// Test 7 — round-trip suppression: bound recovery does not emit disk.write.*
// -------------------------------------------------------------------

console.log("\n--- Test 7: bound recovery does not round-trip as disk.write ---");
{
	const fix = buildFixture({
		path: "Notes/round-trip-test.md",
		disk: "DISKDISK",
		editor: "DISKDISK",
		crdt: "CRDTCRDT",
	});

	await fix.ingestDiskFileNow("modify");

	// Wait one tick to drain any microtask-scheduled disk emission.
	await new Promise((r) => setTimeout(r, 50));

	const writeOk = fix.captured.find(
		(e) => e.kind === "disk.write.ok" && e.path === fix.path,
	);
	const writeFailed = fix.captured.find(
		(e) => e.kind === "disk.write.failed" && e.path === fix.path,
	);

	assertEq(writeOk, undefined, "no disk.write.ok for recovery write");
	assertEq(writeFailed, undefined, "no disk.write.failed for recovery write");
}

// -------------------------------------------------------------------
// Test 8 — source-grep regressions on src/sync/editorBinding.ts
// -------------------------------------------------------------------

console.log("\n--- Test 8: source-grep regressions on EditorBindingManager emit sites ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const src = readFileSync(bindingSourcePath, "utf8");

	// Constructor accepts the optional flight callback.
	assert(
		src.includes("private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void"),
		"constructor accepts optional recordFlightPathEvent callback",
	);
	assert(
		src.includes('import type { ProductFlightPathEventInput } from "../observability/traceSink"'),
		"ProductFlightPathEventInput imported from observability",
	);

	// applyBinding emits editor.repair.applied for action==="repair" only.
	const applyBindingIdx = src.indexOf(
		"private applyBinding(",
	);
	assert(applyBindingIdx > 0, "applyBinding method present");
	const applyBindingTail = src.slice(applyBindingIdx, applyBindingIdx + 4500);
	assert(
		applyBindingTail.includes("PRODUCT_EVENT_KIND.editorRepairApplied"),
		"applyBinding emits PRODUCT_EVENT_KIND.editorRepairApplied",
	);
	assert(
		applyBindingTail.includes('if (action === "repair")'),
		"applyBinding gates emission on action===\"repair\"",
	);

	// heal() emits editor.heal.applied on every successful entry that
	// resolves a binding target (not gated on the diff branch). Carries
	// diffApplied: boolean so absence of the event proves heal() was not
	// invoked.
	const healIdx = src.indexOf(
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(healIdx > 0, "heal method present");
	const healBody = src.slice(healIdx, healIdx + 2500);
	const applyDiffIdx = healBody.indexOf("applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL)");
	const healEmitIdx = healBody.indexOf("PRODUCT_EVENT_KIND.editorHealApplied");
	assert(applyDiffIdx > 0, "heal() calls applyDiffToYText with ORIGIN_EDITOR_HEALTH_HEAL");
	assert(healEmitIdx > 0, "heal() emits PRODUCT_EVENT_KIND.editorHealApplied");
	assert(
		healEmitIdx > applyDiffIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit follows applyDiffToYText",
	);
	// editor.heal.applied is NOT gated on the diff branch — the emit must
	// be after the if (diffApplied) block, not inside it. We assert this by
	// checking that the emit index is past the closing brace of the diff
	// branch. The diff branch is short (just the log + applyDiffToYText) so
	// we can detect it textually.
	assert(
		healBody.includes("const diffApplied = crdtContent !== currentContent"),
		"heal() computes diffApplied flag",
	);
	assert(
		healBody.includes("diffApplied,"),
		"heal() emit data carries diffApplied flag",
	);
	const ifBranchIdx = healBody.indexOf("if (diffApplied) {");
	assert(ifBranchIdx > 0, "heal() has if(diffApplied) block");
	// The emit must NOT be inside the if(diffApplied) block. Find the
	// closing brace of that block by walking braces.
	let depth = 0;
	let closeIdx = -1;
	for (let i = ifBranchIdx + "if (diffApplied) {".length - 1; i < healBody.length; i++) {
		const ch = healBody[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { closeIdx = i; break; }
		}
	}
	assert(closeIdx > 0, "heal() if(diffApplied) block closing brace found");
	assert(
		healEmitIdx > closeIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit is OUTSIDE if(diffApplied) block (fires on every successful entry)",
	);
}

console.log("\n--- Test 8a: main wires monotonic markdown authority generations ---");
{
	const mainSourcePath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	const src = readFileSync(mainSourcePath, "utf8");
	assert(
		src.includes("private markdownAttentionGeneration = 0"),
		"main owns a monotonic markdown Attention generation",
	);
	assert(
		src.includes("private markdownSyncScopeGeneration = 0"),
		"main owns a monotonic markdown sync-scope generation",
	);
	assert(
		src.includes("getMarkdownAttentionGeneration: () => this.markdownAttentionGeneration"),
		"controller receives the live markdown Attention generation",
	);
	assert(
		src.includes("getMarkdownSyncScopeGeneration: () => this.markdownSyncScopeGeneration"),
		"controller receives the live markdown sync-scope generation",
	);
	assert(
		src.includes("() => this.handleMarkdownAttentionStateChanged()"),
		"DiskMirror Attention changes advance generation through one callback",
	);
	assert(
		/private handleMarkdownAttentionStateChanged\(\): void \{[\s\S]{0,200}this\.markdownAttentionGeneration\+\+[\s\S]{0,200}this\.persistPreservedUnresolvedState\(\)/.test(src),
		"the Markdown Attention callback increments its generation before persistence",
	);
	assert(
		src.includes("this.updateMarkdownSyncScopeGeneration(this.runtimeConfig)"),
		"runtime settings compare the effective markdown scope on every apply",
	);
	assert(
		/private updateMarkdownSyncScopeGeneration\(runtimeConfig: RuntimeConfig\): void \{[\s\S]{0,500}this\.markdownSyncScopeGeneration\+\+[\s\S]{0,200}this\.markdownSyncScopeFingerprint = nextFingerprint/.test(src),
		"effective Markdown scope changes increment generation before publishing the fingerprint",
	);
}

// -------------------------------------------------------------------
// Test 9 — production code has no new heal() callers
// -------------------------------------------------------------------

console.log("\n--- Test 9: heal() retains zero production callers ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const bindingSrc = readFileSync(bindingSourcePath, "utf8");

	// Grep production sources outside editorBinding.ts itself for `.heal(`.
	const productionFiles = [
		"../src/main.ts",
		"../src/runtime/reconciliationController.ts",
		"../src/runtime/editorWorkspaceOrchestrator.ts",
		"../src/sync/diskMirror.ts",
	];

	for (const rel of productionFiles) {
		const url = new URL(rel, import.meta.url);
		try {
			const text = readFileSync(fileURLToPath(url), "utf8");
			// editorBindings.heal( or .heal( on something resembling a manager.
			// Allow editorBindings?.heal? in trace strings, but not as a call.
			const callMatches = text.match(/editorBindings(?:\??\s*\.\s*|\s*\.\s*)heal\s*\(/g);
			assertEq(
				callMatches,
				null,
				`no editorBindings.heal( call in ${rel.replace("../", "")}`,
			);
		} catch (err) {
			// File missing is fine for editorWorkspaceOrchestrator.ts in
			// older revisions.
			void err;
		}
	}

	// And inside editorBinding.ts itself, heal() should still call repair()
	// and not be invoked by validateOpenBindings, bind, or maybeHealBinding.
	assert(
		!bindingSrc.match(/this\.heal\s*\(/),
		"no this.heal( call inside editorBinding.ts (repair flows do not invoke heal)",
	);
}

// -------------------------------------------------------------------
// Test 10 — stable markdown ingest gates
// -------------------------------------------------------------------

console.log("\n--- Test 10: unstable stable-read does not import partial content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stable-read.md",
		disk: "partial",
		crdt: "base",
	});
	fix.setStableReader(async () => ({ kind: "unstable" }));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "unstable read leaves CRDT unchanged");
	const dirty = (fix.controller as never as {
		dirtyMarkdownPaths: Map<string, { retryCount: number }>;
	}).dirtyMarkdownPaths.get(fix.path);
	assertEq(dirty?.retryCount, 1, "unstable read requeues with retryCount=1");
	assertEq(Object.keys(fix.diskIndex).length, 0, "unstable read does not advance disk index");
	clearMarkdownDrainTimer(fix.controller);
}

console.log("\n--- Test 11: delayed stable-read imports final complete content ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stable-complete.md",
		disk: "partial",
		crdt: "base",
	});
	fix.setStableReader(async (_path, _reason) => {
		fix.setDiskContent("complete");
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 2, size: "complete".length },
		};
	});

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "complete", "stable read imports final content");
	assertEq(fix.diskIndex[fix.path]?.mtime, 2, "stable stat is used for disk index");
}

console.log("\n--- Test 12: read-time stat churn retries without CRDT mutation ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/stat-churn.md",
		disk: "partial",
		crdt: "base",
	});
	let attempts = 0;
	fix.setStableReader(async () => {
		attempts++;
		if (attempts === 1) return { kind: "unstable" };
		fix.setDiskContent("complete");
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 3, size: "complete".length },
		};
	});

	await fix.ingestNow("modify");
	assertEq(fix.ytext.toString(), "base", "first stat-churn attempt leaves CRDT unchanged");
	clearMarkdownDrainTimer(fix.controller);

	await fix.ingestNow("modify");
	assertEq(fix.ytext.toString(), "complete", "later stable attempt imports complete content");
}

console.log("\n--- Test 13: rename during active stable-read aborts old path and imports new path ---");
{
	const oldPath = "Notes/old-name.md";
	const newPath = "Notes/new-name.md";
	const fix = buildUnboundIngestFixture({
		path: oldPath,
		disk: "complete",
		crdt: "base",
	});
	let releaseStableRead!: () => void;
	const stableReadGate = new Promise<void>((resolve) => {
		releaseStableRead = resolve;
	});
	let markStableReadStarted!: () => void;
	const stableReadStarted = new Promise<void>((resolve) => {
		markStableReadStarted = resolve;
	});
	let firstStableRead = true;
	fix.setStableReader(async (path) => {
		if (firstStableRead) {
			firstStableRead = false;
			markStableReadStarted();
			await stableReadGate;
			return {
				kind: "ready",
				file: fix.file,
				content: `stale old path ${path}`,
				stat: { mtime: 1, size: 19 },
			};
		}
		return {
			kind: "ready",
			file: fix.file,
			content: "complete",
			stat: { mtime: 2, size: "complete".length },
		};
	});

	const activeIngest = fix.processDirty(oldPath, "modify");
	await stableReadStarted;
	fix.setCrdtPath(newPath);
	fix.setFilePath(newPath);
	fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(
		JSON.stringify(fix.getPreservedRedirects()),
		JSON.stringify([{ oldPath, newPath }]),
		"local rename redirect also carries DiskMirror's unresolved path ownership",
	);
	releaseStableRead();
	await activeIngest;

	assertEq(fix.ytext.toString(), "base", "old path active ingest aborts after rename redirect");
	const redirected = (fix.controller as never as {
		dirtyMarkdownPaths: Map<string, unknown>;
	}).dirtyMarkdownPaths.has(newPath);
	assert(redirected, "new path is queued after active redirect");

	await drainQueuedMarkdown(fix.controller);
	assertEq(fix.ytext.toString(), "complete", "new path dirty entry imports complete content");
}

console.log("\n--- Test 13b: rename callback moves Attention before a new-path modify can drain ---");
{
	const oldPath = "Notes/attention-before-rename.md";
	const newPath = "Notes/attention-after-rename.md";
	const fix = buildUnboundIngestFixture({
		path: oldPath,
		disk: "new-path disk event must stay quarantined",
		crdt: "competing CRDT authority",
	});
	fix.setPreservedUnresolved(true, "path-collision");
	fix.setCrdtPath(newPath);
	fix.setFilePath(newPath);

	const immediateRedirect = fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(immediateRedirect.kind, "moved", "rename callback moves the exact unresolved episode immediately");
	assertEq(fix.getPreservedPath(), newPath, "new path owns Attention before batch flush");

	// Model a modify event emitted after the vault rename callback but before
	// VaultSync's rename batch has flushed. Without the immediate redirect this
	// event enters the ordinary unguarded disk-ingest lane and replaces CRDT.
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-rename-window-modify");
	await drainQueuedMarkdown(fix.controller);

	assertEq(
		fix.ytext.toString(),
		"competing CRDT authority",
		"new-path modify cannot bypass the old unresolved episode",
	);
	assertEq(fix.getPreservedClearCount(), 0, "rename-window modify does not clear Attention");
	assertEq(fix.getPreservedPath(), newPath, "new-path quarantine remains active");

	const laterBatchRedirect = fix.controller.redirectPendingDirtyPath(oldPath, newPath);
	assertEq(laterBatchRedirect.kind, "target-only", "later batch-flush redirect is idempotent");
	clearMarkdownDrainTimer(fix.controller);
}

console.log("\n--- Test 14: preserved-unresolved quarantine is evaluated after stable read ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/quarantine-after-wait.md",
		disk: "local edit",
		crdt: "base",
	});
	fix.setPreservedUnresolved(true);
	fix.setStableReader(async () => {
		fix.setOpen(true);
		return {
			kind: "ready",
			file: fix.file,
			content: "local edit",
			stat: { mtime: 4, size: "local edit".length },
		};
	});

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "base", "open preserved-unresolved episode skips import");
	assertEq(fix.getPreservedClearCount(), 0, "open preserved-unresolved episode is not cleared");
	assertEq(Object.keys(fix.diskIndex).length, 0, "quarantined open edit does not advance disk index");
}

console.log("\n--- Test 14b: open autosave equality advances the clean baseline ---");
{
	const localContent = "local editor autosave";
	const previousContent = "previous clean baseline";
	const fix = buildUnboundIngestFixture({
		path: "Notes/open-autosave-clean.md",
		disk: localContent,
		crdt: localContent,
	});
	fix.diskIndex[fix.path] = {
		mtime: 1,
		size: previousContent.length,
		contentHash: await contentBaselineHash(previousContent),
	};
	fix.setOpen(true);
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: localContent,
		stat: { mtime: 6, size: localContent.length },
	}));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), localContent, "open autosave does not replace converged CRDT");
	assertEq(
		fix.diskIndex[fix.path]?.contentHash,
		await contentBaselineHash(localContent),
		"editor=CRDT=disk equality advances the durable local-edit baseline",
	);
	assertEq(fix.diskIndex[fix.path]?.mtime, 6, "clean autosave baseline keeps the stable save stat");
}

console.log("\n--- Test 14b2: no-ticket equality settlement rechecks exact editor content ---");
{
	const localContent = "local editor autosave";
	const previousContent = "previous clean baseline";
	const fix = buildUnboundIngestFixture({
		path: "Notes/open-autosave-editor-race.md",
		disk: localContent,
		crdt: localContent,
	});
	const previousHash = await contentBaselineHash(previousContent);
	fix.diskIndex[fix.path] = {
		mtime: 1,
		size: previousContent.length,
		contentHash: previousHash,
	};
	fix.setOpen(true);
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: localContent,
		stat: { mtime: 7, size: localContent.length },
	}));
	const deps = (fix.controller as unknown as {
		deps: { app: { vault: { read: (file: TFile) => Promise<string> } } };
	}).deps;
	const originalRead = deps.app.vault.read.bind(deps.app.vault);
	deps.app.vault.read = async (file) => {
		fix.setEditorContent("newer unsaved editor authority");
		return originalRead(file);
	};

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), localContent, "editor race does not mutate converged Y.Text");
	assertEq(
		fix.diskIndex[fix.path]?.contentHash,
		previousHash,
		"editor race prevents stale equality from advancing the durable baseline",
	);
	clearMarkdownDrainTimer(fix.controller);
}

console.log("\n--- Test 14c: autosave queued open still settles after the note closes ---");
{
	const localContent = "local edit saved before close";
	const previousContent = "older baseline";
	const fix = buildUnboundIngestFixture({
		path: "Notes/autosave-close-before-drain.md",
		disk: localContent,
		crdt: localContent,
	});
	fix.diskIndex[fix.path] = {
		mtime: 1,
		size: previousContent.length,
		contentHash: await contentBaselineHash(previousContent),
	};
	fix.setOpen(true);
	fix.controller.markMarkdownDirty(fix.file, "modify", "op-open-autosave");
	fix.setOpen(false);

	await drainQueuedMarkdown(fix.controller);

	assertEq(
		fix.diskIndex[fix.path]?.contentHash,
		await contentBaselineHash(localContent),
		"close-before-drain equality still advances B to the saved local baseline L",
	);
	assertEq(fix.ytext.toString(), localContent, "late dirty drain leaves settled local CRDT unchanged");
}

console.log("\n--- Test 15: disk ingest has one policy-free canonical safe lane ---");
{
	const fix = buildUnboundIngestFixture({
		path: "Notes/canonical-disk-ingest.md",
		disk: "local edit",
		crdt: "base",
	});
	fix.setStableReader(async () => ({
		kind: "ready",
		file: fix.file,
		content: "local edit",
		stat: { mtime: 5, size: "local edit".length },
	}));

	await fix.ingestNow("modify");

	assertEq(fix.ytext.toString(), "local edit", "ordinary disk candidate reaches canonical import");
	assertEq(fix.diskIndex[fix.path]?.mtime, 5, "canonical import records the stable stat");
	assertEq(fix.getPreservedClearCount(), 0, "canonical import does not fabricate an Attention clear");

	const controllerSource = readFileSync(
		fileURLToPath(new URL("../src/runtime/reconciliationController.ts", import.meta.url)),
		"utf8",
	);
	const orchestratorSource = readFileSync(
		fileURLToPath(new URL("../src/runtime/editorWorkspaceOrchestrator.ts", import.meta.url)),
		"utf8",
	);
	for (const retiredSymbol of [
		"decideExternalEditImport",
		"getEffectiveExternalEditPolicy",
		"closedOnlyDeferredImports",
		"maybeImportDeferredClosedOnlyPath",
		"preserveRejectedExternalEditorReload",
		"externalEditorReloadPreservationByPath",
	]) {
		assert(
			!controllerSource.includes(retiredSymbol),
			`controller no longer carries retired policy path ${retiredSymbol}`,
		);
	}
	assert(
		!orchestratorSource.includes("maybeImportDeferredClosedOnlyPath"),
		"editor close orchestration no longer triggers a policy-only deferred import",
	);
}

// -------------------------------------------------------------------
// Wrap up
// -------------------------------------------------------------------

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
