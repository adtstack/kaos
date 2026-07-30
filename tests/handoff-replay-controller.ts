import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indexedDB } from "fake-indexeddb";
import { App, MarkdownView } from "obsidian";
import * as Y from "yjs";
import {
	ReconciliationController,
	type ReconciliationControllerDeps,
	type ReconciliationEditorBindingsPort,
	type StableMarkdownReadResult,
} from "../src/runtime/reconciliationController";
import type {
	TargetPresentationRequest,
} from "../src/runtime/editorAuthorityAdmission";
import { buildRuntimeConfig } from "../src/runtime/runtimeConfig";
import { DEFAULT_SETTINGS } from "../src/settings/settingsStore";
import type {
	HandoffReplaySnapshotRequest,
	HandoffReplaySnapshotResult,
	OpenEditorMutationTicket,
	OpenEditorMutationViewTicket,
} from "../src/sync/editorBinding";
import type {
	HostLoadCompletionReceipt,
	HandoffReplayPlan,
	PendingHostLoadCandidate,
	TargetReadyToken,
} from "../src/sync/editorHandoffState";
import type {
	ConsumeExactHandoffReplayPermitResult,
	HandoffReplayDispatchPostcondition,
	HandoffReplayDispatchReceipt,
	HandoffReplaySettlementSnapshot,
	HandoffReplayTargetSnapshot,
} from "../src/sync/editorHandoffReplay";
import {
	hashHandoffRecoveryDispatchReceipt,
	isActiveHandoffRecoveryRecord,
	type ActiveHandoffRecoveryRecord,
} from "../src/sync/handoffRecoveryStore";
import { IndexedDbHandoffRecoveryStore } from "../src/sync/indexedDbHandoffRecoveryStore";
import type { VaultSync } from "../src/sync/vaultSync";
import {
	makeStoredReplayFixture,
	ReplayFixtureFile,
} from "./helpers/handoff-replay-fixture";

const TARGET_BASE = "private-target-body-7f3e";
const SOURCE_CONTENT = "private-source-body-a81c";

type BrowserControllerResult = Readonly<{
	acceptedPermits: number;
	snapshotRaceCount: number;
	settlementCaseCount: number;
	exercisedRejectionReasons: readonly string[];
	unreachableTypedRejectionReasons: readonly string[];
	traceCount: number;
}>;

declare global {
	interface Window {
		__KAOS_HANDOFF_REPLAY_CONTROLLER_RESULT__?: Promise<BrowserControllerResult>;
	}
}

type Assert = {
	(value: unknown, message?: string): asserts value;
	equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
	notEqual(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
};

const assert: Assert = Object.assign(
	(value: unknown, message = "assertion failed"): asserts value => {
		if (!value) throw new Error(message);
	},
	{
		equal<T>(actual: unknown, expected: T, message = "values differ"): asserts actual is T {
			if (!Object.is(actual, expected)) {
				throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
			}
		},
		notEqual(actual: unknown, expected: unknown, message = "values unexpectedly match"): void {
			if (Object.is(actual, expected)) throw new Error(message);
		},
		deepEqual(actual: unknown, expected: unknown, message = "values differ"): void {
			const actualJson = JSON.stringify(actual);
			const expectedJson = JSON.stringify(expected);
			if (actualJson !== expectedJson) {
				throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
			}
		},
	},
);

type StoredRecord = ActiveHandoffRecoveryRecord & Readonly<{ status: "stored" }>;
type ReplayPendingRecord =
	ActiveHandoffRecoveryRecord & Readonly<{ status: "replay-pending" }>;
type AwaitingSettlementRecord =
	ActiveHandoffRecoveryRecord & Readonly<{
		status: "replayed-awaiting-settlement";
	}>;
type PlannedReplay = Readonly<{
	plan: HandoffReplayPlan;
	pending: ReplayPendingRecord;
	store: IndexedDbHandoffRecoveryStore;
}>;
type StoredReplay = Readonly<{
	intent: Awaited<ReturnType<typeof makeStoredReplayFixture>>["intent"];
	record: StoredRecord;
	store: IndexedDbHandoffRecoveryStore;
}>;

type ControllerFixture = Readonly<{
	controller: ReconciliationController;
	targetFile: ReplayFixtureFile;
	ytext: Y.Text;
	token: TargetReadyToken;
	baseSnapshot: HandoffReplayTargetSnapshot;
	traces: Array<Readonly<{
		source: string;
		message: string;
		details: Readonly<Record<string, unknown>>;
	}>>;
	nonce: string;
	setSnapshot(snapshot: HandoffReplayTargetSnapshot): void;
	setSettlementSnapshot(snapshot: HandoffReplaySettlementSnapshot | null): void;
	setDiskRead(result: StableMarkdownReadResult): void;
	setCurrentToken(token: TargetReadyToken): void;
	restoreCurrentProof(): void;
	planAndStore(label: string): Promise<PlannedReplay>;
	makeStored(label: string): Promise<StoredReplay>;
	dispose(): void;
}>;

let databaseSequence = 0;

function realEditorView(state: EditorState): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({
		parent,
		state,
	});
	assert(view instanceof EditorView);
	return view;
}

function replaceEditorState(view: EditorView, state: EditorState): void {
	view.setState(state);
}

function isStoredRecord(record: ActiveHandoffRecoveryRecord): record is StoredRecord {
	return record.status === "stored";
}

function isReplayPendingRecord(
	record: ActiveHandoffRecoveryRecord,
): record is ReplayPendingRecord {
	return record.status === "replay-pending";
}

function storedRecord(record: ActiveHandoffRecoveryRecord): StoredRecord {
	if (!isStoredRecord(record)) {
		throw new Error(`Expected stored record, got ${record.status}`);
	}
	return record;
}

function replayPendingRecord(record: ActiveHandoffRecoveryRecord): ReplayPendingRecord {
	if (!isReplayPendingRecord(record)) {
		throw new Error(`Expected replay-pending record, got ${record.status}`);
	}
	return record;
}

function awaitingSettlementRecord(
	record: ActiveHandoffRecoveryRecord,
): AwaitingSettlementRecord {
	if (record.status !== "replayed-awaiting-settlement") {
		throw new Error(`Expected awaiting settlement, got ${record.status}`);
	}
	return record;
}

async function createControllerFixture(
	nonce: string,
): Promise<ControllerFixture> {
	const codecFixture = await makeStoredReplayFixture({
		startDocument: Text.of([TARGET_BASE]),
	});
	const targetFile = codecFixture.intent.targetFile;
	assert(targetFile instanceof ReplayFixtureFile);
	Object.defineProperty(targetFile, "stat", {
		configurable: true,
		value: { ctime: 1, mtime: 1, size: TARGET_BASE.length },
		writable: true,
	});
	const sourceFile = new ReplayFixtureFile("A.md");
	Object.defineProperty(sourceFile, "stat", {
		configurable: true,
		value: { ctime: 2, mtime: 2, size: 8 },
		writable: true,
	});

	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("file-b");
	ytext.insert(0, TARGET_BASE);
	const cm = realEditorView(EditorState.create({
		doc: SOURCE_CONTENT,
		selection: EditorSelection.cursor(SOURCE_CONTENT.length),
	}));
	const view = new MarkdownView(Object.create(null));
	let runtimeData = SOURCE_CONTENT;
	let currentTicket: OpenEditorMutationTicket;
	Object.defineProperties(view, {
		file: { configurable: true, value: targetFile, writable: true },
		leaf: { configurable: true, value: { id: codecFixture.intent.leafId } },
		editor: {
			configurable: true,
			value: { getValue: () => cm.state.doc.toString() },
		},
		data: {
			configurable: true,
			enumerable: true,
			get: () => runtimeData,
			set: (value: string) => { runtimeData = value; },
		},
	});

	const makeTicket = (input: Readonly<{
		displayedFile: ReplayFixtureFile;
		presentation: OpenEditorMutationViewTicket["handoffPresentation"];
		pendingHostLoadTokenId: string | null;
		editorRevision: number;
		nativeHistoryEpoch: number;
		selectionEpoch: number;
		scrollEpoch: number;
	}>): OpenEditorMutationTicket => Object.freeze({
		path: targetFile.path,
		views: Object.freeze([Object.freeze({
			bootSessionId: "binding-boot-1",
			sessionId: codecFixture.intent.sessionId,
			handoffGeneration: codecFixture.intent.handoffGeneration,
			displayedFile: input.displayedFile,
			displayedPath: input.displayedFile.path,
			targetFile,
			stableTargetIdentityProven: true,
			switchIntentSeq: codecFixture.intent.switchIntentSeq,
			nativeHistoryEpoch: input.nativeHistoryEpoch,
			selectionEpoch: input.selectionEpoch,
			scrollEpoch: input.scrollEpoch,
			handoffPresentation: input.presentation,
			handoffPhase: input.presentation === "target-proven"
				? "target-ready"
				: "awaiting-target-ready",
			intentStateKind: input.presentation === "target-proven" ? "resolved" : "none",
			pendingHostLoadTokenId: input.pendingHostLoadTokenId,
			view,
			viewId: "view-1",
			leafId: codecFixture.intent.leafId,
			cm,
			cmId: "cm-1",
			bindingEpoch: codecFixture.intent.bindingEpoch,
			editorRevision: input.editorRevision,
			editorAuthorityRevision: 0,
			editorAuthorityContent: null,
			editorDocument: cm.state.doc,
			editorContent: cm.state.doc.toString(),
		})]),
	});

	const startState = cm.state;
	const heldTransaction = startState.update({
		changes: { from: 0, to: startState.doc.length, insert: TARGET_BASE },
		selection: EditorSelection.cursor(TARGET_BASE.length),
	});
	const candidate: PendingHostLoadCandidate = Object.freeze({
		hostLoadTokenId: "host-load-1",
		hostLoadCompletedEpoch: null,
		sourceUnloadReceiptId: "source-unload:replay:1",
		switchIntentSeq: codecFixture.intent.switchIntentSeq,
		sessionId: codecFixture.intent.sessionId,
		leafId: codecFixture.intent.leafId,
		handoffGeneration: codecFixture.intent.handoffGeneration,
		targetPathAtDispatch: targetFile.path,
		cm,
		runtimeView: view,
		startDocument: startState.doc,
		targetDocument: heldTransaction.newDoc,
		incomingContent: TARGET_BASE,
		applicationKind: "transaction",
		heldTransaction,
		heldState: null,
		hostSetViewDataClear: true,
		nativeHistoryEpochBefore: 0,
		proposedSelection: heldTransaction.newSelection,
		proposedScrollAnchor: TARGET_BASE.length,
		effectFingerprint: "effect-1",
		runtimeViewDataBefore: SOURCE_CONTENT,
		bindingEpoch: codecFixture.intent.bindingEpoch,
		editorRevisionBefore: 9,
	});
	currentTicket = makeTicket({
		displayedFile: sourceFile,
		presentation: "target-candidate",
		pendingHostLoadTokenId: candidate.hostLoadTokenId,
		editorRevision: 9,
		nativeHistoryEpoch: 0,
		selectionEpoch: 0,
		scrollEpoch: 0,
	});

	const app = new App();
	Object.defineProperties(app, {
		vault: {
			value: {
				getAbstractFileByPath: (path: string) =>
					path === targetFile.path ? targetFile : null,
				read: async () => TARGET_BASE,
				adapter: {
					stat: async () => ({
						ctime: 1,
						mtime: 1,
						size: TARGET_BASE.length,
					}),
				},
			},
		},
		workspace: {
			value: {
				activeLeaf: { view },
				getActiveViewOfType: () => view,
				iterateAllLeaves: (callback: (leaf: Readonly<{ view: MarkdownView }>) => void) =>
					callback({ view }),
			},
		},
	});
	const vaultSync: VaultSync = Object.create(null);
	Object.defineProperties(vaultSync, {
		ydoc: { value: ydoc },
		getActiveFileIdsForPath: {
			value: (path: string) => path === targetFile.path ? ["file-b"] : [],
		},
		getTextForPath: {
			value: (path: string) => path === targetFile.path ? ytext : null,
		},
		getFileId: {
			value: (path: string) => path === targetFile.path ? "file-b" : undefined,
		},
		getFileIdForText: {
			value: (text: Y.Text) => text === ytext ? "file-b" : undefined,
		},
		isMarkdownTombstoned: { value: () => false },
		isPendingRenameTarget: { value: () => false },
	});
	const settings = Object.freeze({
		...DEFAULT_SETTINGS,
		vaultId: "vault-a",
		deviceName: "controller-browser",
	});
	const runtimeConfig = Object.freeze(buildRuntimeConfig(settings, ".obsidian"));
	const traces: ControllerFixture["traces"] = [];
	let currentToken: TargetReadyToken | null = null;
	let currentSnapshot: HandoffReplayTargetSnapshot | null = null;
	let currentSettlementSnapshot: HandoffReplaySettlementSnapshot | null = null;
	let currentDiskRead: StableMarkdownReadResult = Object.freeze({
		kind: "ready",
		file: targetFile,
		content: TARGET_BASE,
		stat: Object.freeze({ mtime: 1, size: TARGET_BASE.length }),
	});

	const bindingPort: ReconciliationEditorBindingsPort = {
		captureHandoffCompositionProof(intent) {
			return intent.compositionEpoch === null
				? Object.freeze({ kind: "not-ime" })
				: Object.freeze({ kind: "unavailable" });
		},
		captureCurrentTargetReadyToken(request) {
			const token = currentToken;
			return token
				&& token.sessionId === request.sessionId
				&& token.handoffGeneration === request.expectedGeneration
				&& token.targetPath === request.targetPath
				&& token.targetFile === request.targetFile
				? token
				: null;
		},
		captureHandoffReplayTargetSnapshot(
			_request: HandoffReplaySnapshotRequest,
		): HandoffReplaySnapshotResult {
			return currentSnapshot
				? Object.freeze({ kind: "ready", snapshot: currentSnapshot })
				: Object.freeze({ kind: "not-ready", reason: "binding-missing" });
		},
		captureHandoffReplaySettlementSnapshot() {
			return currentSettlementSnapshot
				? Object.freeze({
					kind: "ready" as const,
					snapshot: currentSettlementSnapshot,
				})
				: Object.freeze({
					kind: "unavailable" as const,
					reason: "binding-missing" as const,
				});
		},
		clearHandoffReplaySettlementProofs: () => {
			currentSettlementSnapshot = null;
		},
		captureOpenEditorMutationTicket: () => currentTicket,
		capturePathEditorAuthority: () => ({ kind: "blocked", reason: "read-failed" }),
		getBindingDebugInfoForView: () => null,
		getCollabDebugInfoForView: () => null,
		getLastEditorActivityForPath: () => null,
		getPendingHostLoadCandidate: () => candidate,
		isBound: () => true,
		isPathEditorAuthorityLeaseCurrent: () => false,
		rebind: () => {},
		repair: () => false,
		separateUndoCaptureForPath: () => 0,
		unbindByPath: () => {},
		validateOpenEditorMutationTicket: (ticket, openViews) =>
			ticket === currentTicket
				&& openViews.length === 1
				&& openViews[0] === view
				? { current: true }
				: { current: false, reason: "view-set-changed" },
	};
	const deps: ReconciliationControllerDeps = {
		app,
		getSettings: () => settings,
		getRuntimeConfig: () => runtimeConfig,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => bindingPort,
		getDiskIndex: () => ({
			[targetFile.path]: {
				mtime: 1,
				size: TARGET_BASE.length,
				contentHash: codecFixture.record.startContentHash,
			},
		}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: (path) => path === targetFile.path,
		isRemoteProjectionAllowed: () => true,
		getMarkdownAttentionGeneration: () => 0,
		getMarkdownSyncScopeGeneration: () => 1,
		shouldTombstoneIntrinsicMarkdownPath: () => false,
		shouldTombstoneIntrinsicBlobPath: () => false,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source, message, details = {}) => {
			traces.push(Object.freeze({ source, message, details: Object.freeze({ ...details }) }));
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		readStableMarkdownFile: async () => currentDiskRead,
		handoffReplayLifecycleNonceFactory: () => nonce,
	};
	const controller = new ReconciliationController(deps);
	const presentationRequest: TargetPresentationRequest = Object.freeze({
		requestId: "presentation-1",
		sessionId: codecFixture.intent.sessionId,
		leafId: codecFixture.intent.leafId,
		handoffGeneration: codecFixture.intent.handoffGeneration,
		switchIntentSeq: codecFixture.intent.switchIntentSeq,
		targetPath: targetFile.path,
		targetFile,
		candidate,
		openEditorTicket: currentTicket,
	});
	const plannedPresentation =
		await controller.requestTargetPresentation(presentationRequest);
	assert.equal(plannedPresentation.kind, "planned");
	assert.equal(controller.consumeTargetPresentationPermit(
		plannedPresentation.plan.presentationPermitId,
		Object.freeze({
			presentationPlanId: plannedPresentation.plan.planId,
			authorityFreshnessHandleId:
				plannedPresentation.plan.authorityFreshnessHandleId,
			sessionId: presentationRequest.sessionId,
			leafId: presentationRequest.leafId,
			handoffGeneration: presentationRequest.handoffGeneration,
			switchIntentSeq: presentationRequest.switchIntentSeq,
			targetPath: presentationRequest.targetPath,
			targetFile: presentationRequest.targetFile,
			hostLoadTokenId: candidate.hostLoadTokenId,
			candidate,
			openEditorTicket: presentationRequest.openEditorTicket,
		}),
	), true);
	replaceEditorState(cm, heldTransaction.state);
	runtimeData = TARGET_BASE;
	currentTicket = makeTicket({
		displayedFile: sourceFile,
		presentation: "target-candidate",
		pendingHostLoadTokenId: candidate.hostLoadTokenId,
		editorRevision: 10,
		nativeHistoryEpoch: 1,
		selectionEpoch: 1,
		scrollEpoch: 1,
	});
	const hostReceipt: HostLoadCompletionReceipt = Object.freeze({
		receiptId: "host-receipt-1",
		hostLoadTokenId: candidate.hostLoadTokenId,
		switchIntentSeq: candidate.switchIntentSeq,
		sessionId: candidate.sessionId,
		leafId: candidate.leafId,
		handoffGeneration: candidate.handoffGeneration,
		targetPath: targetFile.path,
		nativeHistoryEpoch: 1,
		historyResetObserved: true,
		targetSelection: candidate.proposedSelection,
		targetSelectionEpoch: 1,
		targetScrollAnchor: candidate.proposedScrollAnchor,
		targetScrollEpoch: 1,
		effectFingerprint: candidate.effectFingerprint,
	});
	const completed = await controller.completeTargetPresentation(hostReceipt);
	assert.equal(completed.kind, "accepted");
	currentToken = completed.receipt.replacementTargetReadyToken;
	assert.equal(currentToken.targetAuthority.kind, "existing");
	if (currentToken.targetAuthority.kind !== "existing") {
		throw new Error("Replay fixture requires existing B authority");
	}
	const targetAuthority = currentToken.targetAuthority;
	const baseSnapshot: HandoffReplayTargetSnapshot = Object.freeze({
		sessionId: codecFixture.intent.sessionId,
		leafId: codecFixture.intent.leafId,
		handoffGeneration: codecFixture.intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		targetReadyTokenId: currentToken.tokenId,
		hostLoadTokenId: currentToken.hostLoadTokenId,
		hostLoadReceiptId: currentToken.hostLoadReceiptId,
		targetPath: targetFile.path,
		targetFile,
		targetFileId: targetAuthority.fileId,
		cm,
		ytext,
		ytextIdentity: targetAuthority.ytextIdentity,
		ytextMutationEpoch: targetAuthority.ytextMutationEpoch,
		bindingEpoch: codecFixture.intent.bindingEpoch,
		editorRevision: currentTicket.views[0]!.editorRevision,
		nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
		selectionEpoch: hostReceipt.targetSelectionEpoch,
		scrollEpoch: hostReceipt.targetScrollEpoch,
		selection: cm.state.selection,
		scrollAnchor: hostReceipt.targetScrollAnchor,
		cmDocument: cm.state.doc,
		editorFacadeContent: TARGET_BASE,
		runtimeCacheContent: TARGET_BASE,
		ytextContent: ytext.toJSON(),
	});
	currentSnapshot = baseSnapshot;
	const authoritativeToken = currentToken;
	traces.length = 0;

	const makeStored = async (label: string) => {
		const replay = await makeStoredReplayFixture({
			startDocument: Text.of([TARGET_BASE]),
			intentOverrides: {
				intentId: `intent-${nonce}-${label}`,
				targetFile,
			},
		});
		const store = new IndexedDbHandoffRecoveryStore(
			replay.record.scope,
			indexedDB,
			`handoff-replay-controller-${++databaseSequence}`,
			() => replay.record.storedAt,
		);
		const put = await store.putIntent(replay.intent);
		assert.equal(put.kind, "stored");
		if (put.kind !== "stored" || !isActiveHandoffRecoveryRecord(put.record)) {
			throw new Error("Replay fixture failed to reread a stored row");
		}
		return Object.freeze({
			intent: replay.intent,
			record: storedRecord(put.record),
			store,
		});
	};

	const planAndStore = async (label: string): Promise<PlannedReplay> => {
		currentSnapshot = baseSnapshot;
		currentToken = authoritativeToken;
		const stored = await makeStored(label);
		const planned = await controller.requestExactHandoffReplayPlan({
			sessionId: stored.intent.sessionId,
			expectedGeneration: stored.intent.handoffGeneration,
			recoveryOperationEpoch: 1,
			intent: stored.intent,
			record: stored.record,
			targetReadyToken: authoritativeToken,
			compositionProof: null,
		});
		assert.equal(planned.kind, "planned", `${label}: exact plan is current`);
		if (planned.kind !== "planned") throw new Error(`${label}: replay was not planned`);
		const pending = await stored.store.storeApplyWitness(
			stored.record.recordId,
			stored.record.checksum,
			planned.applyWitness,
		);
		assert.equal(pending.kind, "updated", `${label}: witness is durably reread`);
		if (
			pending.kind !== "updated"
			|| !isActiveHandoffRecoveryRecord(pending.record)
		) {
			throw new Error(`${label}: witness reread failed`);
		}
		return Object.freeze({
			plan: planned.plan,
			pending: replayPendingRecord(pending.record),
			store: stored.store,
		});
	};

	return Object.freeze({
		controller,
		targetFile,
		ytext,
		token: authoritativeToken,
		baseSnapshot,
		traces,
		nonce,
		setSnapshot(snapshot) { currentSnapshot = snapshot; },
		setSettlementSnapshot(snapshot) { currentSettlementSnapshot = snapshot; },
		setDiskRead(result) { currentDiskRead = result; },
		setCurrentToken(token) { currentToken = token; },
		restoreCurrentProof() {
			currentSnapshot = baseSnapshot;
			currentToken = authoritativeToken;
		},
		planAndStore,
		makeStored,
		dispose() {
			cm.destroy();
			ydoc.destroy();
		},
	});
}

type ConsumeRejectionReason = Extract<
	ConsumeExactHandoffReplayPermitResult,
	Readonly<{ kind: "rejected" }>
>["reason"];

type PreparedSettlement = Readonly<{
	record: AwaitingSettlementRecord;
	receipt: HandoffReplayDispatchReceipt;
	snapshot: HandoffReplaySettlementSnapshot;
	resultContent: string;
}>;

async function prepareSettlement(
	fixture: ControllerFixture,
	label: string,
	dispatchReceiptHashOverride: string | null = null,
): Promise<PreparedSettlement> {
	const replay = await fixture.planAndStore(label);
	const permitted = fixture.controller.consumeExactHandoffReplayPermit({
		plan: replay.plan,
		record: replay.pending,
		recoveryOperationEpoch: 1,
	});
	assert.equal(permitted.kind, "accepted", `${label}: settlement permit accepted`);
	if (permitted.kind !== "accepted") throw new Error("settlement permit rejected");
	const redeemed = fixture.controller.redeemExactHandoffReplayDispatchPermit(
		permitted.permit,
	);
	assert.equal(redeemed.kind, "accepted", `${label}: settlement permit redeemed`);
	if (redeemed.kind !== "accepted") throw new Error("settlement permit not redeemed");
	const witness = replay.pending.applyWitness;
	assert(witness !== null, `${label}: replay witness exists`);
	const selectionEpochAfter = fixture.baseSnapshot.selectionEpoch
		+ (fixture.baseSnapshot.selection.eq(replay.plan.mappedSelection) ? 0 : 1);
	const postcondition: HandoffReplayDispatchPostcondition = Object.freeze({
		planId: replay.plan.planId,
		recordId: replay.pending.recordId,
		recoveryOperationEpoch: 1,
		targetFileId: fixture.baseSnapshot.targetFileId,
		ytextIdentity: fixture.baseSnapshot.ytextIdentity,
		ytextMutationEpoch: fixture.baseSnapshot.ytextMutationEpoch + 1,
		bindingEpoch: fixture.baseSnapshot.bindingEpoch,
		editorRevision: fixture.baseSnapshot.editorRevision + 1,
		nativeHistoryEpoch: fixture.baseSnapshot.nativeHistoryEpoch + 1,
		selectionEpoch: selectionEpochAfter,
		scrollEpoch: fixture.baseSnapshot.scrollEpoch,
		selection: replay.plan.mappedSelection,
		scrollAnchor: replay.plan.mappedScrollAnchor,
	});
	const receipt = fixture.controller.createExactHandoffReplayDispatchReceipt({
		plan: replay.plan,
		record: replay.pending,
		recoveryOperationEpoch: 1,
		postcondition,
		appliedAt: 1_700_000_000_000,
	});
	assert(receipt !== null, `${label}: content-free receipt was created`);
	const receiptHash = await hashHandoffRecoveryDispatchReceipt(receipt);
	const stored = await replay.store.storeDispatchReceipt(
		replay.pending.recordId,
		replay.pending.checksum,
		dispatchReceiptHashOverride ?? receiptHash,
	);
	assert.equal(stored.kind, "updated", `${label}: receipt hash stored`);
	if (stored.kind !== "updated" || !isActiveHandoffRecoveryRecord(stored.record)) {
		throw new Error(`${label}: awaiting row was not reread`);
	}
	const resultContent = witness.plannedResultContent;
	const snapshot: HandoffReplaySettlementSnapshot = Object.freeze({
		planId: replay.plan.planId,
		sessionId: fixture.baseSnapshot.sessionId,
		leafId: fixture.baseSnapshot.leafId,
		handoffGeneration: fixture.baseSnapshot.handoffGeneration,
		recoveryOperationEpoch: 1,
		targetReadyTokenId: fixture.baseSnapshot.targetReadyTokenId,
		hostLoadTokenId: fixture.baseSnapshot.hostLoadTokenId,
		hostLoadReceiptId: fixture.baseSnapshot.hostLoadReceiptId,
		targetPath: fixture.baseSnapshot.targetPath,
		targetFile: fixture.baseSnapshot.targetFile,
		targetFileId: fixture.baseSnapshot.targetFileId,
		cm: fixture.baseSnapshot.cm,
		ytext: fixture.baseSnapshot.ytext,
		ytextIdentity: fixture.baseSnapshot.ytextIdentity,
		ytextMutationEpoch: postcondition.ytextMutationEpoch,
		bindingEpoch: postcondition.bindingEpoch,
		editorRevision: postcondition.editorRevision,
		nativeHistoryEpoch: postcondition.nativeHistoryEpoch,
		selectionEpoch: postcondition.selectionEpoch,
		scrollEpoch: postcondition.scrollEpoch,
		selection: postcondition.selection,
		scrollAnchor: postcondition.scrollAnchor,
		cmDocument: Text.of(resultContent.split("\n")),
		editorFacadeContent: resultContent,
		runtimeCacheContent: resultContent,
		ytextContent: resultContent,
	});
	fixture.setSettlementSnapshot(snapshot);
	fixture.setDiskRead(Object.freeze({
		kind: "ready",
		file: fixture.targetFile,
		content: resultContent,
		stat: Object.freeze({ mtime: 2, size: resultContent.length }),
	}));
	return Object.freeze({
		record: awaitingSettlementRecord(stored.record),
		receipt,
		snapshot,
		resultContent,
	});
}

const allConsumeRejectionReasons = Object.freeze([
	"plan-unknown",
	"plan-consumed",
	"record-mismatch",
	"recovery-state-stale",
	"recovery-operation-stale",
	"authority-stale",
	"target-snapshot-stale",
] satisfies readonly ConsumeRejectionReason[]);

function assertRejected(
	result: ConsumeExactHandoffReplayPermitResult,
	expected: ConsumeRejectionReason,
	exercised: Set<ConsumeRejectionReason>,
	message: string,
): void {
	assert.deepEqual(result, { kind: "rejected", reason: expected }, message);
	exercised.add(expected);
}

function isBrowserControllerResult(value: unknown): value is BrowserControllerResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as Partial<BrowserControllerResult>;
	return typeof result.acceptedPermits === "number"
		&& typeof result.snapshotRaceCount === "number"
		&& typeof result.settlementCaseCount === "number"
		&& Array.isArray(result.exercisedRejectionReasons)
		&& Array.isArray(result.unreachableTypedRejectionReasons)
		&& typeof result.traceCount === "number";
}

async function runBrowserControllerSuite(): Promise<BrowserControllerResult> {
	const exercisedReasons = new Set<ConsumeRejectionReason>();
	let acceptedPermits = 0;

	console.log("\n--- Handoff replay controller: current plan and request epochs ---");
	const fixture = await createControllerFixture("boot-a");
	{
	const success = await fixture.planAndStore("success");
	const accepted = fixture.controller.consumeExactHandoffReplayPermit({
		plan: success.plan,
		record: success.pending,
		recoveryOperationEpoch: 1,
	});
	assert.equal(accepted.kind, "accepted");
	if (accepted.kind !== "accepted") throw new Error("Current replay permit was rejected");
	acceptedPermits += 1;
	assert.equal(accepted.permit.planId, success.plan.planId);
	assert.equal(accepted.permit.permitId, success.plan.replayPermitId);
	assert.deepEqual(
		fixture.controller.redeemExactHandoffReplayDispatchPermit(
			Object.freeze({ ...accepted.permit }),
		),
		{ kind: "rejected", reason: "permit-mismatch" },
		"a structural permit copy cannot redeem controller-owned dispatch authority",
	);
	const redeemed = fixture.controller.redeemExactHandoffReplayDispatchPermit(
		accepted.permit,
	);
	assert.equal(redeemed.kind, "accepted");
	if (redeemed.kind !== "accepted") {
		throw new Error("Exact dispatch permit capability was not redeemed");
	}
	assert.equal(
		redeemed.snapshot,
		fixture.baseSnapshot,
		"exact permit redemption returns the registered planning snapshot object",
	);
		assert.deepEqual(
			fixture.controller.redeemExactHandoffReplayDispatchPermit(accepted.permit),
			{ kind: "rejected", reason: "plan-already-consumed" },
			"dispatch permit redemption is delete-before-return and one-shot",
		);
		const clearRace = await fixture.makeStored("recovery-clear-plan-race");
		const inFlightPlan = fixture.controller.requestExactHandoffReplayPlan({
			sessionId: clearRace.intent.sessionId,
			expectedGeneration: clearRace.intent.handoffGeneration,
			recoveryOperationEpoch: 1,
			intent: clearRace.intent,
			record: clearRace.record,
			targetReadyToken: fixture.token,
			compositionProof: null,
		});
		fixture.controller.invalidateExactHandoffReplayForRecoveryClear();
		assert.deepEqual(
			await inFlightPlan,
			{ kind: "replan", reason: "target-authority-stale" },
			"Recovery Clear fences a plan request that was already awaiting validation",
		);
		const manualRecord = await fixture.planAndStore("manual-record-only");
		const otherRecord = await fixture.planAndStore("other-record-stays-live");
		fixture.controller.invalidateExactHandoffReplayForRecord(
			manualRecord.pending.recordId,
		);
		assert.equal(
			fixture.controller.consumeExactHandoffReplayPermit({
				plan: manualRecord.plan,
				record: manualRecord.pending,
				recoveryOperationEpoch: 1,
			}).kind,
			"rejected",
			"manual invalidation retires its own record",
		);
		assert.equal(
			fixture.controller.consumeExactHandoffReplayPermit({
				plan: otherRecord.plan,
				record: otherRecord.pending,
				recoveryOperationEpoch: 1,
			}).kind,
			"accepted",
			"manual invalidation cannot cancel another record",
		);
	assertRejected(
		fixture.controller.consumeExactHandoffReplayPermit({
			plan: success.plan,
			record: success.pending,
			recoveryOperationEpoch: 1,
		}),
		"plan-consumed",
		exercisedReasons,
		"duplicate permit consumption is permanently rejected",
	);

	const wrongEpoch = await fixture.makeStored("wrong-request-epochs");
	const requestBase = {
		sessionId: wrongEpoch.intent.sessionId,
		expectedGeneration: wrongEpoch.intent.handoffGeneration,
		recoveryOperationEpoch: 1,
		intent: wrongEpoch.intent,
		record: wrongEpoch.record,
		targetReadyToken: fixture.token,
		compositionProof: null,
	} as const;
	assert.deepEqual(
		await fixture.controller.requestExactHandoffReplayPlan({
			...requestBase,
			sessionId: "stale-session",
		}),
		{ kind: "replan", reason: "session-stale" },
		"wrong request session is rejected",
	);
	assert.deepEqual(
		await fixture.controller.requestExactHandoffReplayPlan({
			...requestBase,
			expectedGeneration: requestBase.expectedGeneration + 1,
		}),
		{ kind: "replan", reason: "generation-stale" },
		"wrong request generation is rejected",
	);
	assert.deepEqual(
		await fixture.controller.requestExactHandoffReplayPlan({
			...requestBase,
			recoveryOperationEpoch: 2,
		}),
		{ kind: "replan", reason: "target-authority-stale" },
		"wrong planning recovery-operation epoch is rejected",
	);
}

console.log("\n--- Handoff replay controller: one-field snapshot race matrix ---");
{
	const replacementFile = new ReplayFixtureFile(fixture.targetFile.path);
	const replacementCm = realEditorView(EditorState.create({ doc: TARGET_BASE }));
	const replacementDoc = new Y.Doc();
	const replacementYtext = replacementDoc.getText("replacement");
	replacementYtext.insert(0, TARGET_BASE);
	const matrix: ReadonlyArray<Readonly<{
		label: string;
		mutate(snapshot: HandoffReplayTargetSnapshot): HandoffReplayTargetSnapshot;
	}>> = [
		{ label: "session", mutate: (value) => ({ ...value, sessionId: "stale-session" }) },
		{ label: "leaf", mutate: (value) => ({ ...value, leafId: "stale-leaf" }) },
		{ label: "generation", mutate: (value) => ({ ...value, handoffGeneration: value.handoffGeneration + 1 }) },
		{ label: "recovery operation", mutate: (value) => ({ ...value, recoveryOperationEpoch: value.recoveryOperationEpoch + 1 }) },
		{ label: "target token", mutate: (value) => ({ ...value, targetReadyTokenId: `${value.targetReadyTokenId}-stale` }) },
		{ label: "host load token", mutate: (value) => ({ ...value, hostLoadTokenId: `${value.hostLoadTokenId}-stale` }) },
		{ label: "host receipt", mutate: (value) => ({ ...value, hostLoadReceiptId: `${value.hostLoadReceiptId}-stale` }) },
		{ label: "target path", mutate: (value) => ({ ...value, targetPath: "other.md" }) },
		{ label: "TFile identity", mutate: (value) => ({ ...value, targetFile: replacementFile }) },
		{ label: "target file ID", mutate: (value) => ({ ...value, targetFileId: "file-b-stale" }) },
		{ label: "CodeMirror identity", mutate: (value) => ({ ...value, cm: replacementCm }) },
		{ label: "Y.Text identity", mutate: (value) => ({ ...value, ytext: replacementYtext }) },
		{ label: "Y.Text stable ID", mutate: (value) => ({ ...value, ytextIdentity: `${value.ytextIdentity}-stale` }) },
		{ label: "Y.Text mutation epoch", mutate: (value) => ({ ...value, ytextMutationEpoch: value.ytextMutationEpoch + 1 }) },
		{ label: "binding epoch", mutate: (value) => ({ ...value, bindingEpoch: value.bindingEpoch + 1 }) },
		{ label: "editor revision", mutate: (value) => ({ ...value, editorRevision: value.editorRevision + 1 }) },
		{ label: "native history epoch", mutate: (value) => ({ ...value, nativeHistoryEpoch: value.nativeHistoryEpoch + 1 }) },
		{ label: "selection epoch", mutate: (value) => ({ ...value, selectionEpoch: value.selectionEpoch + 1 }) },
		{ label: "scroll epoch", mutate: (value) => ({ ...value, scrollEpoch: value.scrollEpoch + 1 }) },
		{ label: "selection value", mutate: (value) => ({ ...value, selection: EditorSelection.single(0) }) },
		{ label: "scroll anchor", mutate: (value) => ({ ...value, scrollAnchor: 0 }) },
		{ label: "CodeMirror Text identity", mutate: (value) => ({ ...value, cmDocument: Text.of([TARGET_BASE]) }) },
		{ label: "editor facade", mutate: (value) => ({ ...value, editorFacadeContent: "base!" }) },
		{ label: "runtime cache", mutate: (value) => ({ ...value, runtimeCacheContent: "base!" }) },
		{ label: "Y.Text content", mutate: (value) => ({ ...value, ytextContent: "base!" }) },
	];
	for (const item of matrix) {
		const replay = await fixture.planAndStore(`snapshot-${item.label}`);
		fixture.setSnapshot(Object.freeze(item.mutate(fixture.baseSnapshot)));
		const result = fixture.controller.consumeExactHandoffReplayPermit({
			plan: replay.plan,
			record: replay.pending,
			recoveryOperationEpoch: 1,
		});
		assertRejected(
			result,
			"target-snapshot-stale",
			exercisedReasons,
			`one-field snapshot race: ${item.label}`,
		);
		fixture.restoreCurrentProof();
	}
	replacementCm.destroy();
	replacementDoc.destroy();
}

console.log("\n--- Handoff replay controller: persisted proof mismatch matrix ---");
{
	const planMismatch = await fixture.planAndStore("plan-mismatch");
	const replacementPlan: HandoffReplayPlan = Object.freeze({
		...planMismatch.plan,
		replayPermitId: `${planMismatch.plan.replayPermitId}-replacement`,
	});
	assertRejected(
		fixture.controller.consumeExactHandoffReplayPermit({
			plan: replacementPlan,
			record: planMismatch.pending,
			recoveryOperationEpoch: 1,
		}),
		"record-mismatch",
		exercisedReasons,
		"one-field plan object mismatch",
	);

	const mismatchCases: ReadonlyArray<Readonly<{
		label: string;
		mutate(record: ReplayPendingRecord): ReplayPendingRecord;
	}>> = [
		{
			label: "record id",
			mutate: (record) => Object.freeze({
				...record,
				recordId: `${record.recordId}-stale`,
			}),
		},
		{
			label: "intent envelope",
			mutate: (record) => Object.freeze({
				...record,
				intentEnvelopeHash: "0".repeat(64),
			}),
		},
		{
			label: "checksum",
			mutate: (record) => Object.freeze({
				...record,
				checksum: "f".repeat(64),
			}),
		},
		{
			label: "apply witness",
			mutate: (record) => {
				assert(record.applyWitness !== null, "replay-pending record has a witness");
				return Object.freeze({
					...record,
					applyWitness: Object.freeze({
						...record.applyWitness,
						plannedResultHash: "e".repeat(64),
					}),
				});
			},
		},
	];
	for (const item of mismatchCases) {
		const replay = await fixture.planAndStore(`record-${item.label}`);
		assertRejected(
			fixture.controller.consumeExactHandoffReplayPermit({
				plan: replay.plan,
				record: item.mutate(replay.pending),
				recoveryOperationEpoch: 1,
			}),
			"record-mismatch",
			exercisedReasons,
			`one-field persisted ${item.label} mismatch`,
		);
	}
}

console.log("\n--- Handoff replay controller: supersession, operation, and authority ABA ---");
let resetReplay: PlannedReplay;
{
	const superseded = await fixture.planAndStore("target-superseded");
	fixture.setCurrentToken(Object.freeze({
		...fixture.token,
		tokenId: `${fixture.token.tokenId}-superseding`,
	}));
	assertRejected(
		fixture.controller.consumeExactHandoffReplayPermit({
			plan: superseded.plan,
			record: superseded.pending,
			recoveryOperationEpoch: 1,
		}),
		"target-snapshot-stale",
		exercisedReasons,
		"replacement target token supersedes the planned token",
	);
	fixture.restoreCurrentProof();

	const operation = await fixture.planAndStore("operation-stale");
	assertRejected(
		fixture.controller.consumeExactHandoffReplayPermit({
			plan: operation.plan,
			record: operation.pending,
			recoveryOperationEpoch: 2,
		}),
		"recovery-operation-stale",
		exercisedReasons,
		"permit consumption is fenced by recovery-operation epoch",
	);

	resetReplay = await fixture.planAndStore("reset");
	const authority = await fixture.planAndStore("authority-aba");
	fixture.ytext.doc?.transact(() => {
		fixture.ytext.delete(0, fixture.ytext.length);
		fixture.ytext.insert(0, TARGET_BASE);
	});
	assertRejected(
		fixture.controller.consumeExactHandoffReplayPermit({
			plan: authority.plan,
			record: authority.pending,
			recoveryOperationEpoch: 1,
		}),
		"authority-stale",
		exercisedReasons,
		"same-bytes Y.Text mutation invalidates authority freshness",
	);
}

console.log("\n--- Handoff replay controller: reset and reconstruction ABA ---");
fixture.controller.reset();
assertRejected(
	fixture.controller.consumeExactHandoffReplayPermit({
		plan: resetReplay.plan,
		record: resetReplay.pending,
		recoveryOperationEpoch: 1,
	}),
	"plan-consumed",
	exercisedReasons,
	"reset permanently retires a live replay plan",
);
const reconstructed = await createControllerFixture("boot-b");
const reconstructedReplay = await reconstructed.planAndStore("reconstructed");
assert.notEqual(
	reconstructedReplay.plan.planId,
	resetReplay.plan.planId,
	"new controller nonce prevents plan ID ABA at the same numeric lifecycle",
);
assert.notEqual(
	reconstructedReplay.plan.replayPermitId,
	resetReplay.plan.replayPermitId,
	"new controller nonce prevents permit ID ABA at the same numeric lifecycle",
);
assertRejected(
	reconstructed.controller.consumeExactHandoffReplayPermit({
		plan: resetReplay.plan,
		record: resetReplay.pending,
		recoveryOperationEpoch: 1,
	}),
	"plan-unknown",
	exercisedReasons,
	"a reconstructed controller cannot accept an old plan",
);

console.log("\n--- Handoff replay controller: exact settlement observation matrix ---");
const settlementFixture = await createControllerFixture("boot-settlement");
const settlement = await prepareSettlement(settlementFixture, "settled");
let settlementCaseCount = 0;
const observeLive = (
	record = settlement.record,
	receipt: HandoffReplayDispatchReceipt | null = settlement.receipt,
) => settlementFixture.controller.observeExactHandoffReplaySettlement({
	record,
	mode: "live",
	receipt,
});

assert.deepEqual(
	await observeLive(),
	{ kind: "settled" },
	"exact editor, Y.Text, receipt, and stable disk settle the replay",
);
settlementCaseCount += 1;

settlementFixture.setDiskRead(Object.freeze({
	kind: "ready",
	file: settlementFixture.targetFile,
	content: TARGET_BASE,
	stat: Object.freeze({ mtime: 1, size: TARGET_BASE.length }),
}));
assert.deepEqual(
	await observeLive(),
	{ kind: "pending", reason: "disk-not-yet-saved" },
	"certified base on disk remains pending while in-memory replay is exact",
);
settlementCaseCount += 1;
settlementFixture.setDiskRead(Object.freeze({ kind: "unstable" }));
assert.deepEqual(
	await observeLive(),
	{ kind: "pending", reason: "disk-unstable" },
	"live unstable disk read remains pending",
);
settlementCaseCount += 1;
settlementFixture.setDiskRead(Object.freeze({ kind: "missing" }));
assert.deepEqual(
	await observeLive(),
	{ kind: "uncertain", reason: "disk-missing" },
	"missing disk target is uncertain",
);
settlementCaseCount += 1;
settlementFixture.setDiskRead(Object.freeze({
	kind: "ready",
	file: settlementFixture.targetFile,
	content: "third-disk-authority",
	stat: Object.freeze({ mtime: 3, size: 20 }),
}));
assert.deepEqual(
	await observeLive(),
	{ kind: "uncertain", reason: "disk-content-mismatch" },
	"third disk content is uncertain",
);
settlementCaseCount += 1;

settlementFixture.setDiskRead(Object.freeze({
	kind: "ready",
	file: settlementFixture.targetFile,
	content: settlement.resultContent,
	stat: Object.freeze({ mtime: 2, size: settlement.resultContent.length }),
}));
const replacementCm = realEditorView(EditorState.create({ doc: settlement.resultContent }));
const replacementYdoc = new Y.Doc();
const replacementYtext = replacementYdoc.getText("replacement-settlement");
replacementYtext.insert(0, settlement.resultContent);
const replacementFile = new ReplayFixtureFile(settlement.snapshot.targetPath);
const settlementMatrix: ReadonlyArray<Readonly<{
	label: string;
	reason: string;
	mutate(snapshot: HandoffReplaySettlementSnapshot): HandoffReplaySettlementSnapshot;
}>> = [
	{ label: "target TFile", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, targetFile: replacementFile }) },
	{ label: "target file ID", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, targetFileId: `${value.targetFileId}-stale` }) },
	{ label: "CodeMirror", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, cm: replacementCm }) },
	{ label: "binding epoch", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, bindingEpoch: value.bindingEpoch + 1 }) },
	{ label: "editor revision", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, editorRevision: value.editorRevision + 1 }) },
	{ label: "Y.Text object", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, ytext: replacementYtext }) },
	{ label: "Y.Text identity", reason: "target-identity-mismatch", mutate: (value) => ({ ...value, ytextIdentity: `${value.ytextIdentity}-stale` }) },
	{ label: "Y.Text epoch", reason: "ytext-epoch-mismatch", mutate: (value) => ({ ...value, ytextMutationEpoch: value.ytextMutationEpoch + 1 }) },
	{ label: "native history", reason: "history-mismatch", mutate: (value) => ({ ...value, nativeHistoryEpoch: value.nativeHistoryEpoch + 1 }) },
	{ label: "selection epoch", reason: "selection-mismatch", mutate: (value) => ({ ...value, selectionEpoch: value.selectionEpoch + 1 }) },
	{ label: "selection value", reason: "selection-mismatch", mutate: (value) => ({ ...value, selection: EditorSelection.cursor(0) }) },
	{ label: "scroll epoch", reason: "scroll-mismatch", mutate: (value) => ({ ...value, scrollEpoch: value.scrollEpoch + 1 }) },
	{ label: "scroll anchor", reason: "scroll-mismatch", mutate: (value) => ({ ...value, scrollAnchor: value.scrollAnchor === 0 ? 1 : 0 }) },
	{ label: "editor document", reason: "editor-content-mismatch", mutate: (value) => ({ ...value, cmDocument: Text.of([`${value.cmDocument.toString()}!`]) }) },
	{ label: "editor facade", reason: "editor-content-mismatch", mutate: (value) => ({ ...value, editorFacadeContent: `${value.editorFacadeContent}!` }) },
	{ label: "runtime cache", reason: "editor-content-mismatch", mutate: (value) => ({ ...value, runtimeCacheContent: `${value.runtimeCacheContent}!` }) },
	{ label: "Y.Text content", reason: "ytext-content-mismatch", mutate: (value) => ({ ...value, ytextContent: `${value.ytextContent}!` }) },
];
for (const item of settlementMatrix) {
	settlementFixture.setSettlementSnapshot(Object.freeze(item.mutate(settlement.snapshot)));
	assert.deepEqual(
		await observeLive(),
		{ kind: "uncertain", reason: item.reason },
		`settlement one-field mismatch: ${item.label}`,
	);
	settlementCaseCount += 1;
}
replacementCm.destroy();
replacementYdoc.destroy();

settlementFixture.setSettlementSnapshot(settlement.snapshot);
const mutatedReceipt = Object.freeze({
	...settlement.receipt,
	appliedAt: settlement.receipt.appliedAt + 1,
});
assert.deepEqual(
	await observeLive(settlement.record, mutatedReceipt),
	{ kind: "uncertain", reason: "receipt-hash-mismatch" },
	"one-field receipt change cannot reuse the persisted receipt hash",
);
settlementCaseCount += 1;

for (const [key, value] of Object.entries(settlement.receipt)) {
	const replacement = value === null
		? 0
		: typeof value === "number"
			? value + 1
			: `${value}-changed`;
	const candidate = Object.freeze({
		...settlement.receipt,
		[key]: replacement,
	}) as HandoffReplayDispatchReceipt;
	assert.notEqual(
		await hashHandoffRecoveryDispatchReceipt(candidate),
		await hashHandoffRecoveryDispatchReceipt(settlement.receipt),
		`receipt hash owns scalar ${key}`,
	);
}

const wrongHashSettlement = await prepareSettlement(
	settlementFixture,
	"wrong-receipt-hash",
	"f".repeat(64),
);
assert.deepEqual(
	await settlementFixture.controller.observeExactHandoffReplaySettlement({
		record: wrongHashSettlement.record,
		mode: "live",
		receipt: wrongHashSettlement.receipt,
	}),
	{ kind: "uncertain", reason: "receipt-hash-mismatch" },
	"valid row with another receipt hash rejects the local preimage",
);
settlementCaseCount += 1;

settlementFixture.setSettlementSnapshot(settlement.snapshot);
settlementFixture.setDiskRead(Object.freeze({
	kind: "ready",
	file: settlementFixture.targetFile,
	content: settlement.resultContent,
	stat: Object.freeze({ mtime: 2, size: settlement.resultContent.length }),
}));
assert.deepEqual(
	await settlementFixture.controller.observeExactHandoffReplaySettlement({
		record: settlement.record,
		mode: "hydrated",
		receipt: null,
	}),
	{ kind: "settled" },
	"hydrated observation may use the still-live exact applied-plan marker",
);
settlementCaseCount += 1;
settlementFixture.setSettlementSnapshot(Object.freeze({
	...settlement.snapshot,
	planId: null,
}));
assert.deepEqual(
	await settlementFixture.controller.observeExactHandoffReplaySettlement({
		record: settlement.record,
		mode: "hydrated",
		receipt: null,
	}),
	{ kind: "uncertain", reason: "receipt-required" },
	"restart without ephemeral applied-plan proof remains manual",
);
settlementCaseCount += 1;
settlementFixture.setSettlementSnapshot(null);
assert.deepEqual(
	await observeLive(),
	{ kind: "uncertain", reason: "snapshot-unavailable" },
	"unavailable binding snapshot is uncertain",
);
settlementCaseCount += 1;

settlementFixture.dispose();

assert.equal(fixture.traces.length, 0, "replay planning and permit minting emit no content trace");
assert.equal(reconstructed.traces.length, 0, "reconstructed replay emits no content trace");
const traceText = JSON.stringify([...fixture.traces, ...reconstructed.traces]);
assert.equal(traceText.includes(fixture.nonce), false, "lifecycle nonce is absent from traces");
assert.equal(traceText.includes(fixture.baseSnapshot.editorFacadeContent), false, "note body is absent from traces");
assert.equal(traceText.includes(JSON.stringify(fixture.baseSnapshot.selection.toJSON())), false, "serialized selection is absent from traces");
assert.equal(
	traceText.includes(resetReplay.pending.applyWitness?.serializedMappedSelection ?? ""),
	false,
	"mapped selection serialization is absent from traces",
);
assert.equal(traceText.includes(resetReplay.pending.checksum), false, "recovery checksum is absent from traces");
assert.equal(
	traceText.includes(resetReplay.pending.applyWitness?.plannedResultContent ?? ""),
	false,
	"dispatch receipt preimage content is absent from traces",
);

const unreachableTypedReasons: readonly ConsumeRejectionReason[] = Object.freeze([
	"recovery-state-stale",
]);
assert.deepEqual(
	allConsumeRejectionReasons
		.filter((reason) => !unreachableTypedReasons.includes(reason))
		.sort(),
	[...exercisedReasons].sort(),
	"every typed and publicly reachable permit rejection reason is exercised",
);
assert.equal(
	acceptedPermits,
	1,
	"exactly one permit is accepted across success, mismatch, duplicate, reset, and ABA cases",
);

fixture.dispose();
reconstructed.dispose();
console.log("\nhandoff-replay-controller: plan, permit, and settlement matrices passed");
return Object.freeze({
	acceptedPermits,
	snapshotRaceCount: 25,
	settlementCaseCount,
	exercisedRejectionReasons: Object.freeze([...exercisedReasons].sort()),
	unreachableTypedRejectionReasons: unreachableTypedReasons,
	traceCount: fixture.traces.length + reconstructed.traces.length,
});
}

if (typeof window !== "undefined") {
	window.__KAOS_HANDOFF_REPLAY_CONTROLLER_RESULT__ = runBrowserControllerSuite();
} else {
	const repoRoot = new URL("..", import.meta.url).pathname;
	const entryPath = new URL(import.meta.url).pathname;
	const obsidianMockPath = new URL("./mocks/obsidian.ts", import.meta.url).pathname;
	const nodeProcess = process as typeof process & {
		getBuiltinModule(name: "node:child_process"): {
			spawnSync(
				command: string,
				args: readonly string[],
				options: Readonly<{
					cwd: string;
					encoding: "utf8";
					timeout: number;
				}>,
			): Readonly<{
				status: number | null;
				stdout: string;
				stderr: string;
				error?: Error;
			}>;
		};
	};
	const { spawnSync } = nodeProcess.getBuiltinModule("node:child_process");
	const childScript = `
		import { build } from "esbuild";
		import { chromium } from "playwright";
		const browserBundle = await build({
			entryPoints: [${JSON.stringify(entryPath)}],
			bundle: true,
			format: "iife",
			platform: "browser",
			target: "chrome120",
			write: false,
			define: {
				"import.meta.url": JSON.stringify("file:///handoff-replay-controller-browser.ts"),
			},
			plugins: [{
				name: "handoff-replay-controller-obsidian-mock",
				setup(esbuild) {
					esbuild.onResolve({ filter: /^obsidian$/ }, () => ({
						path: ${JSON.stringify(obsidianMockPath)},
					}));
				},
			}],
		});
		const output = browserBundle.outputFiles[0];
		if (!output) throw new Error("esbuild returned no browser output");
		let browser = null;
		const launchErrors = [];
		for (const options of [{}, { channel: "chrome" }]) {
			try {
				browser = await chromium.launch({ ...options, headless: true });
				break;
			} catch (error) {
				launchErrors.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (!browser) {
			throw new Error("No supported Chromium could launch: " + launchErrors.join(" | "));
		}
		try {
			const page = await browser.newPage();
			const pageErrors = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			page.on("console", (message) => {
				if (message.type() !== "error") console.log(message.text());
			});
			await page.route("https://kaos.test/**", async (route) => {
				await route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><html><body></body></html>",
				});
			});
			await page.goto("https://kaos.test/");
			await page.addScriptTag({ content: output.text });
			const result = await page.evaluate(async () =>
				await window.__KAOS_HANDOFF_REPLAY_CONTROLLER_RESULT__
			);
			if (pageErrors.length > 0) {
				throw new Error("Browser page errors: " + pageErrors.join(" | "));
			}
			console.log("HANDOFF_REPLAY_CONTROLLER_RESULT=" + JSON.stringify(result));
		} finally {
			await browser.close();
		}
	`;
	const child = spawnSync(
		nodeProcess.execPath,
		["--input-type=module", "--eval", childScript],
		{ cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
	);
	if (child.status !== 0) {
		throw new Error(
			child.stderr
				|| child.error?.message
				|| "handoff replay controller browser subprocess failed",
		);
	}
	const resultLine = child.stdout
		.split("\n")
		.find((line) => line.startsWith("HANDOFF_REPLAY_CONTROLLER_RESULT="));
	const result: unknown = JSON.parse(
		resultLine?.slice("HANDOFF_REPLAY_CONTROLLER_RESULT=".length) ?? "null",
	);
	assert(
		isBrowserControllerResult(result),
		"browser controller result has the expected content-free shape",
	);
	assert.equal(result.acceptedPermits, 1, "browser accepted exactly one replay permit");
	assert.equal(result.snapshotRaceCount, 25, "browser covered the full snapshot race matrix");
	assert.equal(
		result.settlementCaseCount,
		27,
		"browser covered exact settlement success, pending, and mismatch cases",
	);
	assert.deepEqual(
		result.unreachableTypedRejectionReasons,
		["recovery-state-stale"],
		"typed replay-pending input makes recovery-state-stale unreachable without a cast",
	);
	assert.equal(result.traceCount, 0, "browser captured no replay trace payload");
	console.log(child.stdout.trim());
}
