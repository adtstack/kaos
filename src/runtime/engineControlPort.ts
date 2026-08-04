import type { CodeMirrorHandoffGuardSnapshot } from "../sync/codeMirrorHandoffGuard";
import type { SamePathAdoptionConflictFailureReason } from "../sync/samePathAdoption";

/**
 * EngineControlPort — type-only interface for QA harness Engine control.
 *
 * This file is type-only (no runtime code, fully erased at build time).
 * It lives in src/runtime/ so main.ts can reference it without importing from qa/.
 *
 * The concrete instance is assembled in main.ts as a private field.
 * The Puppeteer harness (qa/harness/) receives it through PluginHandle.getEngineControlPort().
 *
 * IMPORTANT: This interface must not appear in main.js or telemetry.js public
 * API surface. It is passed at runtime only through the Puppeteer harness path
 * (settings.qaDebugMode). Normal production users never receive it.
 *
 * Do not expose this through TelemetryRuntimeHost.
 * Do not mount on window. Do not ship as a product command.
 */

export type EditorHandoffHostOperationDebugSnapshot = Readonly<{
	kind: "host-load" | "native-save";
	state: "armed" | "held" | "released" | "rejected";
	path: string;
	leafId: string | null;
	sessionId: string | null;
	generation: number | null;
	invocationPath: string | null;
	outcome: "pending" | "applied" | "delegated" | "suppressed" | "rejected";
}>;

/**
 * Content-free observation of the same-path adoption lane.  IDs, epochs,
 * categorical outcomes, and artifact paths are observable; note bodies and
 * serialized editor state are deliberately excluded.
 */
export type SamePathAdoptionDebugSnapshot =
	| Readonly<{ kind: "none" }>
	| Readonly<{
		kind: "capturing" | "planning";
		adoptionId: string;
		requestId: string | null;
		path: string;
		planKind:
			| "already-settled"
			| "apply-local"
			| "apply-remote"
			| "apply-clean-merge"
			| "preserve-conflict"
			| null;
		startEditorRevision: number;
		latestEditorRevision: number;
		editorTransactionSeq: number;
		bindingEpoch: number;
		nativeHistoryEpoch: number;
		inputEpoch: number;
		compositionEpoch: number;
		activeCompositionEpoch: number | null;
		selectionEpoch: number;
		scrollEpoch: number;
		hostSaveEpoch: number;
	}>
	| Readonly<{
		kind: "awaiting-disk";
		adoptionId: string;
		proposalId: string;
		path: string;
	}>
	| Readonly<{
		kind: "conflict";
		adoptionId: string;
		path: string;
		status: "preserved" | "preservation-failed";
		retryable: boolean;
		mergeMode: "three-way" | "two-way";
		baseRetained: boolean;
		crdtArtifactPath: string | null;
		editorArtifactPaths: readonly string[];
		failureReason: SamePathAdoptionConflictFailureReason | null;
	}>;

export type EditorHandoffManagedLeafDebugSnapshot = Readonly<{
	managed: true;
	active: boolean;
	leafId: string;
	sessionId: string;
	generation: number;
	viewPath: string | null;
	displayedPath: string | null;
	bindingPath: string | null;
	cmId: string | null;
	presentation: "none" | "source" | "target-candidate" | "target-proven";
	phase: string;
	recoveryOperationEpoch: number | null;
	inputGateInstalled: boolean;
	saveGuardInstalled: boolean;
	hostCapability: "public-cancellable" | "owned-scheduler-with-unload-flush" | null;
	hostCapabilityState: "ready" | "lost" | null;
	clearLoadCapability: "observable" | "clear-load-not-observable" | null;
	hostSaveEpoch: number | null;
	readonly adoption: SamePathAdoptionDebugSnapshot;
	sourceUnload: null | Readonly<{
		receiptId: string;
		path: string;
		state: "saving" | "settled" | "rejected" | "atomic-window-expired";
		forcedSaveObserved: boolean;
		cacheRetiredBeforeUnloadSettled: boolean;
	}>;
	gateClosed: boolean;
	gateFailureReason:
		| "pending-input-not-flushable"
		| "input-intent-not-acknowledged"
		| "gate-release-failed"
		| null;
	commitState: "none" | "pending" | "committing" | "committed" | "failed";
	commitFailureReason?: CodeMirrorHandoffGuardSnapshot["commitFailureReason"];
	gateAuthorityAdvanceFailureReason?: string | null;
	inputAuthorityAdvanceFailureReason?: string | null;
	hostPostDelegationFailureReason?: string | null;
	inputEpoch: number | null;
	compositionEpoch: number | null;
	compositionActive: boolean;
	compositionOwnerCmId: string | null;
	activeCompositionUpdates: number | null;
	activeCompositionCapturedUpdates: number | null;
	lastComposition: null | Readonly<{
		compositionEpoch: number;
		startGeneration: number;
		endGeneration: number;
		updates: number;
		replayEligible: boolean;
	}>;
	intent: null | Readonly<{
		intentId: string;
		state: string;
		fromPath: string | null;
		targetPath: string;
		handoffGeneration: number;
		switchIntentSeq: number;
		inputStartSeq: number;
		inputStartedUnderSwitchSeq: number | null;
		inputEpoch: number;
		compositionEpoch: number | null;
		sequenceBegan: "before-handoff" | "after-target-selected";
		originKind: "user" | "ime" | "editor-api";
		userEvent: "input" | "delete" | "paste" | "drop" | "other";
		startContentHash: string;
		afterContentHash: string;
	}>;
	nativeHistoryEpoch: number | null;
	selectionEpoch: number | null;
	scrollEpoch: number | null;
	editorLength: number | null;
	hostDataLength: number | null;
}>;

export type EditorHandoffDebugSnapshot = Readonly<{
	hostLoad: EditorHandoffHostOperationDebugSnapshot | null;
	nativeSave: EditorHandoffHostOperationDebugSnapshot | null;
	leaves: readonly EditorHandoffManagedLeafDebugSnapshot[];
}>;

export interface EditorHandoffQaPort {
	setEditorHandoffHostApiVersionOverride(version: string | null): void;
	holdNextHostLoad(path: string, stage?: "load-entry" | "clear-load"): void;
	releaseHeldHostLoad(): void;
	holdNextNativeSave(path: string): void;
	releaseHeldNativeSave(): void;
	getEditorHandoffDebugSnapshot(): EditorHandoffDebugSnapshot;
	getContentFreeSnapshot(): EditorHandoffDebugSnapshot;
}

export interface EngineControlPort extends EditorHandoffQaPort {
	/** Trigger a deterministic disk→CRDT ingest for a single path. Bypasses the dirty queue. */
	ingestDiskFileNow(path: string, reason: "create" | "modify"): Promise<void>;
	/** Pause editor↔CRDT propagation for an open-and-bound path. Returns true if paused. */
	pauseEditorPropagation(path: string): boolean;
	/** Resume editor↔CRDT propagation for a previously paused path. Returns true if resumed. */
	resumeEditorPropagation(path: string): boolean;
	/** Suspend automatic disk ingest for deterministic QA setup. Returns the previous state. */
	setDiskIngestSuspended(suspended: boolean): boolean;
}

/**
 * Internal disk-ingest port registered by ReconciliationController during construction.
 * Stored in main.ts private state; never exposed publicly.
 */
export interface DiskIngestPort {
	ingestDiskFileNow(path: string, reason: "create" | "modify"): Promise<void>;
}
