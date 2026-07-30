import { spawnSync } from "node:child_process";
import { EditorBindingManager } from "../src/sync/editorBinding";
import type {
	HandoffReplayNotAppliedReason,
	HandoffReplayUncertainReason,
} from "../src/sync/editorHandoffReplay";
import type { VaultSync } from "../src/sync/vaultSync";
import type {
	PublicHandoffReplayResult,
} from "./helpers/handoff-recovery-public-replay-browser";

type BrowserRedResult = Readonly<{
	hasDispatchApi: boolean;
	hasRealEditor: boolean;
	hasRealYText: boolean;
	hasRealUndoManager: boolean;
	invalidRequestReason: string | null;
	applyKind: string;
	applyReason: string | null;
	cmContent: string;
	ytextContent: string;
	undoContent: string;
	redoContent: string;
	sourceContent: string;
	secondReason: string | null;
	notAppliedBranchReasons: readonly string[];
	guardTrace: readonly unknown[];
	publicExisting: PublicHandoffReplayResult;
	publicMissing: PublicHandoffReplayResult;
	publicExactScrollEpochAdvance: PublicHandoffReplayResult;
	publicFaults: readonly Readonly<{
		expected: HandoffReplayUncertainReason;
		kind: string | null;
		reason: string | null;
		classifierError: string | null;
		traceContentFree: boolean;
	}>[];
	authorityEpochFault: Readonly<{
		kind: string | null;
		reason: string | null;
		classifierError: string | null;
		traceContentFree: boolean;
	}>;
}>;

const allNotAppliedReasons = [
	"permit-mismatch",
	"plan-mismatch",
	"plan-already-consumed",
	"record-mismatch",
	"recovery-operation-stale",
	"recovery-state-stale",
	"session-stale",
	"generation-stale",
	"target-token-stale",
	"target-file-stale",
	"binding-stale",
	"editor-stale",
	"document-stale",
	"editor-facade-stale",
	"runtime-cache-stale",
	"ytext-stale",
	"native-history-stale",
	"selection-stale",
	"scroll-stale",
	"scroll-effect-unmappable",
	"dispatch-rejected",
] satisfies readonly HandoffReplayNotAppliedReason[];

const allUncertainReasons = [
	"dispatch-threw-after-mutation",
	"post-target-identity-mismatch",
	"post-document-mismatch",
	"post-editor-facade-mismatch",
	"post-runtime-cache-mismatch",
	"post-ytext-mismatch",
	"post-native-history-mismatch",
	"post-selection-mismatch",
	"post-scroll-mismatch",
] satisfies readonly HandoffReplayUncertainReason[];

const dispatchApi = Reflect.get(
	EditorBindingManager.prototype,
	"applyExactHandoffReplay",
);
if (typeof dispatchApi !== "function") {
	throw new Error("EditorBindingManager.applyExactHandoffReplay is missing");
}
const invalidManager = new EditorBindingManager(
	Object.create(null) as VaultSync,
	false,
	() => true,
);
const invalidResult = Reflect.apply(dispatchApi, invalidManager, [{
	plan: null,
	permit: null,
	record: null,
	recoveryOperationEpoch: 0,
}]) as Readonly<{ kind: string; reason?: string }>;
if (
	invalidResult.kind !== "not-applied"
	|| invalidResult.reason !== "permit-mismatch"
) {
	throw new Error("invalid replay request must fail closed as permit-mismatch");
}

const repoRoot = new URL("..", import.meta.url).pathname;
const obsidianMockPath = new URL("./mocks/obsidian.ts", import.meta.url).pathname;
const browserEntry = String.raw`
	import { history, redo, undo } from "@codemirror/commands";
	import {
		ChangeSet,
		EditorSelection,
		EditorState,
		Transaction,
	} from "@codemirror/state";
	import { EditorView } from "@codemirror/view";
	import { Awareness } from "y-protocols/awareness";
	import { yCollab } from "y-codemirror.next";
	import * as Y from "yjs";
	import { EditorBindingManager } from "./src/sync/editorBinding";
	import { reduceManagedLeafSession } from "./src/sync/editorHandoffState";
	import {
		canonicalHandoffRecoveryJson,
		sha256HandoffRecoveryHexSync,
	} from "./src/sync/handoffRecoveryStore";
	import {
		runPublicHandoffReplay,
	} from "./tests/helpers/handoff-recovery-public-replay-browser";

	window.__KAOS_HANDOFF_RECOVERY_REPLAY_RED__ = (async () => {
		const baseContent = Array.from(
			{ length: 180 },
			(_, index) => "target B line " + String(index).padStart(3, "0"),
		).join("\\n");
		const inserted = "\\nreplayed-only-B";
		const resultContent = baseContent + inserted;
		const startContentHash = sha256HandoffRecoveryHexSync(baseContent);
		const afterContentHash = sha256HandoffRecoveryHexSync(resultContent);
		const targetPath = "Notes/replay-target-B.md";
		const targetFile = { path: targetPath };
		const ydoc = new Y.Doc();
		const sourceText = ydoc.getText("source-a");
		sourceText.insert(0, "source A must remain unchanged");
		const ytext = ydoc.getText("target-b");
		ytext.insert(0, baseContent);
		const undoManager = new Y.UndoManager(ytext);
		const awareness = new Awareness(ydoc);
		let redemption = null;
		const controller = {
			requestOpenPathAdmission() {
				return Promise.resolve({ kind: "deferred", reason: "transitioning" });
			},
			requestTargetPresentation() {
				return Promise.resolve({ kind: "deferred", reason: "authority-blocked" });
			},
			consumeTargetPresentationPermit() { return false; },
			completeTargetPresentation() {
				return Promise.resolve({ kind: "replan", reason: "authority-changed" });
			},
			seedMissingTarget() {
				return Promise.resolve({ kind: "replan", reason: "authority-changed" });
			},
			isAuthorityFreshnessCurrent() { return false; },
			consumeBindPermit() { return false; },
			redeemExactHandoffReplayDispatchPermit(permit) {
				if (redemption === null || redemption.permit !== permit) {
					return { kind: "rejected", reason: "permit-mismatch" };
				}
				const accepted = redemption;
				redemption = null;
				return {
					kind: "accepted",
					snapshot: accepted.snapshot,
					plan: accepted.plan,
					record: accepted.record,
				};
			},
		};
		const vaultSync = {
			provider: { awareness },
			getTextForPath: (path) => path === targetPath ? ytext : null,
			getFileId: (path) => path === targetPath ? "target-b-id" : undefined,
			getFileIdForText: (text) => text === ytext ? "target-b-id" : undefined,
			isPendingRenameTarget: () => false,
			isMarkdownTombstoned: () => false,
		};
		const guardTrace = [];
		const manager = new EditorBindingManager(
			vaultSync,
			false,
			(path) => path.endsWith(".md"),
			(source, message, details) => {
				if (message.startsWith("handoff-replay-")) {
					guardTrace.push({ source, message, details });
				}
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			controller,
		);
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let hostData = baseContent;
		let cm;
		const leaf = {
			id: "replay-leaf",
			workspace: {
				activeLeaf: null,
				iterateAllLeaves(callback) { callback({ view }); },
			},
		};
		const requestSave = Object.assign(function requestSave() {}, { cancel() {} });
		const view = {
			file: targetFile,
			leaf,
			containerEl: parent,
			editor: { getValue: () => cm.state.doc.toString() },
			data: hostData,
			dirty: false,
			getViewData: () => hostData,
			onLoadFile: async function onLoadFile() {},
			setViewData: function setViewData(data) {
				hostData = data;
				this.data = data;
			},
			requestSave,
			save: function save() { this.dirty = false; },
		};
		leaf.workspace.activeLeaf = leaf;
		cm = new EditorView({
			parent,
			state: EditorState.create({
				doc: baseContent,
				selection: EditorSelection.cursor(baseContent.length),
				extensions: [
					history(),
					manager.getBaseExtension(),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						hostData = update.state.doc.toString();
						view.data = hostData;
					}),
				],
			}),
		});
		const managed = manager.manageView(view);
		const runtime = manager.managedSessions.get(leaf.id);
		if (!runtime) throw new Error("managed runtime missing");
		cm.dispatch({
			effects: manager.compartment.reconfigure([
				manager.createYTextOriginCaptureExtension(ytext, targetPath, leaf.id),
				yCollab(ytext, awareness, { undoManager }),
			]),
		});
		const bindingEpoch = 2;
		const binding = {
			view,
			file: targetFile,
			path: targetPath,
			undoManager,
			ytext,
			cm,
			cmId: "replay-cm",
			fileId: "target-b-id",
			lastBoundAt: new Date().toISOString(),
			lastBoundAtMs: Date.now(),
			lastEditorChangeAtMs: Date.now(),
			lastEditorDocChangeAtMs: null,
			settleWindowMs: 0,
			authorityYtextMutationEpochAtBind: 7,
			localYtextMutationRevisionAtBind: 0,
		};
		manager.bindings.set(leaf.id, binding);
		manager.cmToLeafId.set(cm, leaf.id);
		manager.bindingEpochByLeafId.set(leaf.id, bindingEpoch);
		manager.editorRevisionByCm.set(cm, 0);
		const guardSnapshot = runtime.cmGuard.snapshot();
		const scrollAnchor = cm.scrollSnapshot().value.range.head;
		const hostReceipt = Object.freeze({
			receiptId: "host-receipt-B",
			hostLoadTokenId: "host-load-B",
			switchIntentSeq: 11,
			sessionId: managed.sessionId,
			leafId: leaf.id,
			handoffGeneration: managed.generation,
			targetPath,
			nativeHistoryEpoch: guardSnapshot.nativeHistoryEpoch,
			historyResetObserved: true,
			targetSelection: cm.state.selection,
			targetSelectionEpoch: guardSnapshot.selectionEpoch,
			targetScrollAnchor: scrollAnchor,
			targetScrollEpoch: guardSnapshot.scrollEpoch,
			effectFingerprint: "effect-B",
		});
		const token = Object.freeze({
			tokenId: "target-token-B",
			sessionId: managed.sessionId,
			authorityFreshnessHandleId: "freshness-B",
			authorityFingerprint: "authority-B",
			controllerLifecycleGeneration: 1,
			leafId: leaf.id,
			handoffGeneration: managed.generation,
			switchIntentSeq: 11,
			targetPath,
			targetFile,
			targetAuthority: Object.freeze({
				kind: "existing",
				fileId: "target-b-id",
				ytextIdentity: "ytext-B",
				ytextMutationEpoch: 7,
				bindPermitId: "bind-B",
			}),
			hostLoadTokenId: hostReceipt.hostLoadTokenId,
			hostLoadCompletedEpoch: hostReceipt.nativeHistoryEpoch,
			hostLoadReceiptId: hostReceipt.receiptId,
			nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
			targetSelectionEpoch: hostReceipt.targetSelectionEpoch,
			targetScrollEpoch: hostReceipt.targetScrollEpoch,
			certifiedBaseContent: baseContent,
			certifiedBaseHash: startContentHash,
			openEditorTicketId: "ticket-B",
		});
		const selectionAfter = EditorSelection.single(resultContent.length);
		const replayChanges = ChangeSet.of(
			[{ from: baseContent.length, insert: inserted }],
			baseContent.length,
		);
		const intent = Object.freeze({
			intentId: "intent-B",
			sessionId: managed.sessionId,
			leafId: leaf.id,
			handoffGeneration: managed.generation,
			fromPath: "Notes/source-A.md",
			fromFileId: "source-a-id",
			targetPath,
			targetFile,
			bindingEpoch: 1,
			inputEpoch: 1,
			switchIntentSeq: 11,
			inputStartSeq: 12,
			inputStartedUnderSwitchSeq: 11,
			compositionEpoch: null,
			selectionEpoch: 0,
			sequenceBegan: "after-target-selected",
			startDocument: cm.state.doc,
			startContentHash,
			changes: replayChanges,
			afterContent: resultContent,
			afterContentHash,
			selectionBefore: cm.state.selection,
			selectionAfter,
			originKind: "user",
			userEvent: "input",
			capturedAt: 1,
		});
		const presentationReceipt = Object.freeze({
			receiptId: "presentation-B",
			presentationPlanId: "presentation-plan-B",
			hostLoadCompletionReceipt: hostReceipt,
			replacementTargetReadyToken: token,
		});
		runtime.targetWorkflow = {
			sessionId: managed.sessionId,
			handoffGeneration: managed.generation,
			switchIntentSeq: 11,
			targetFile,
			targetPath,
			candidate: null,
			openEditorTicket: null,
			presentationPlan: null,
			presentationRequestInFlight: false,
			presentationPermitConsumed: true,
			presentationCommitInFlight: false,
			presentationCompletionInFlight: false,
			hostCompletionReceipt: hostReceipt,
			targetPresentationReceipt: presentationReceipt,
			targetReadyToken: token,
			openAdmissionInFlight: false,
		};
		runtime.session = Object.freeze({
			...runtime.session,
			generation: managed.generation,
			currentSwitchIntentSeq: 11,
			nativeHistoryEpoch: hostReceipt.nativeHistoryEpoch,
			completedDetachEpoch: null,
			activeRecoveries: Object.freeze([Object.freeze({
				sessionId: managed.sessionId,
				handoffGeneration: managed.generation,
				recoveryOperationEpoch: 1,
				intentState: Object.freeze({
					kind: "replay-pending",
					intentId: intent.intentId,
					recordId: "record-B",
				}),
				intent,
			})]),
			displayedLineage: Object.freeze({
				kind: "known",
				file: targetFile,
				path: targetPath,
				fileId: "target-b-id",
				cm,
				document: cm.state.doc,
				editorRevision: 0,
			}),
			binding: Object.freeze({
				kind: "bound",
				path: targetPath,
				fileId: "target-b-id",
				ytext,
			}),
			handoff: Object.freeze({
				sourceAuthorityPath: "Notes/source-A.md",
				targetPath,
				targetFile,
				bindingEpochAfterDetach: 1,
				presentation: "target-proven",
				targetReadyTokenId: token.tokenId,
				inputGateInstalled: true,
				saveGuardInstalled: false,
				recoveryOperationEpoch: 1,
				intentState: Object.freeze({
					kind: "replay-pending",
					intentId: intent.intentId,
					recordId: "record-B",
				}),
				recoveryTargetBindingRequest: Object.freeze({
					recoveryOperationEpoch: 1,
					intentId: intent.intentId,
					recordId: "record-B",
				}),
				phase: "awaiting-replay-settlement",
				pendingHostLoadCandidate: null,
			}),
		});
		runtime.cmGuard.refreshGate();
		const captured = manager.captureHandoffReplayTargetSnapshot({
			sessionId: managed.sessionId,
			expectedGeneration: managed.generation,
			recoveryOperationEpoch: 1,
			recoveryClaim: Object.freeze({
				intentId: intent.intentId,
				recordId: "record-B",
			}),
			targetReadyToken: token,
		});
		if (captured.kind !== "ready") {
			throw new Error("snapshot unavailable: " + captured.reason);
		}
		const snapshot = captured.snapshot;
		const plan = Object.freeze({
			planId: "plan-B",
			intentId: intent.intentId,
			targetReadyTokenId: token.tokenId,
			authorityFreshnessHandleId: token.authorityFreshnessHandleId,
			replayPermitId: "permit-B",
			switchIntentSeq: token.switchIntentSeq,
			kind: "exact-replay",
			expectedTargetDocument: snapshot.cmDocument,
			expectedSelectionEpoch: snapshot.selectionEpoch,
			expectedNativeHistoryEpoch: snapshot.nativeHistoryEpoch,
			expectedTargetScrollEpoch: snapshot.scrollEpoch,
			replayChanges,
			mappedSelection: selectionAfter,
			mappedScrollAnchor: replayChanges.mapPos(snapshot.scrollAnchor, -1),
		});
		const applyWitness = Object.freeze({
			planId: plan.planId,
			kind: plan.kind,
			switchIntentSeq: plan.switchIntentSeq,
			hostLoadTokenId: snapshot.hostLoadTokenId,
			targetFileId: snapshot.targetFileId,
			targetYtextIdentity: snapshot.ytextIdentity,
			targetMutationEpochAtPlan: snapshot.ytextMutationEpoch,
			nativeHistoryEpoch: snapshot.nativeHistoryEpoch,
			targetSelectionEpoch: snapshot.selectionEpoch,
			targetScrollEpoch: snapshot.scrollEpoch,
			plannedStartHash: intent.startContentHash,
			plannedResultContent: resultContent,
			plannedResultHash: intent.afterContentHash,
			serializedMappedSelection:
				canonicalHandoffRecoveryJson(selectionAfter.toJSON()),
			dispatchReceiptHash: null,
		});
		const record = Object.freeze({
			recordId: "record-B",
			intentId: intent.intentId,
			intentEnvelopeHash: "intent-envelope",
			scope: Object.freeze({
				schemaVersion: 1,
				vaultId: "vault",
				localDeviceId: "device",
			}),
			fromPath: intent.fromPath,
			targetPath,
			originKind: intent.originKind,
			sequenceBegan: intent.sequenceBegan,
			startContentHash: intent.startContentHash,
			afterContentHash: intent.afterContentHash,
			body: Object.freeze({
				startContent: baseContent,
				afterContent: resultContent,
				serializedChanges: "fixture",
				serializedSelectionBefore: "fixture",
				serializedSelectionAfter: "fixture",
				eventProof: Object.freeze({
					proofSchemaVersion: 1,
					canonicalEncodingVersion: 1,
					sessionId: managed.sessionId,
					leafId: leaf.id,
					handoffGeneration: managed.generation,
					bindingEpoch: 1,
					inputEpoch: 1,
					switchIntentSeq: 11,
					inputStartSeq: 12,
					inputStartedUnderSwitchSeq: 11,
					compositionEpoch: null,
					selectionEpoch: 0,
				}),
			}),
			applyWitness,
			checksum: "pending-checksum",
			capturedAt: 1,
			storedAt: 2,
			status: "replay-pending",
		});
		const permit = Object.freeze({
			permitId: plan.replayPermitId,
			planId: plan.planId,
			recordId: record.recordId,
			replayPendingChecksum: record.checksum,
			recoveryOperationEpoch: 1,
			expectedSnapshotFingerprint: "snapshot-B",
		});
		const notAppliedBranchReasons = [];
		const recordNotApplied = (expected, result) => {
			if (result.kind !== "not-applied" || result.reason !== expected) {
				throw new Error(
					"not-applied branch mismatch: expected " + expected
						+ ", got " + JSON.stringify(result),
				);
			}
			notAppliedBranchReasons.push(expected);
		};
		const snapshotAuthorities = manager.handoffReplayPrivateAuthorityBySnapshot;
		const expectedPrivate = snapshotAuthorities.get(snapshot);
		if (!expectedPrivate) throw new Error("private snapshot authority missing");
		const driftCases = [
			["session-stale", { sessionId: "stale-session" }],
			["generation-stale", { handoffGeneration: snapshot.handoffGeneration + 1 }],
			["recovery-operation-stale", {
				recoveryOperationEpoch: snapshot.recoveryOperationEpoch + 1,
			}],
			["target-token-stale", {
				targetReadyTokenId: snapshot.targetReadyTokenId + "-stale",
			}],
			["target-file-stale", { targetPath: targetPath + ".stale" }],
			["binding-stale", { ytextIdentity: snapshot.ytextIdentity + "-stale" }],
			["editor-stale", { editorRevision: snapshot.editorRevision + 1 }],
			["document-stale", {
				cmDocument: EditorState.create({ doc: baseContent }).doc,
			}],
			["editor-facade-stale", { editorFacadeContent: baseContent + "!" }],
			["runtime-cache-stale", { runtimeCacheContent: baseContent + "!" }],
			["ytext-stale", { ytextMutationEpoch: snapshot.ytextMutationEpoch + 1 }],
			["native-history-stale", {
				nativeHistoryEpoch: snapshot.nativeHistoryEpoch + 1,
			}],
			["selection-stale", { selection: EditorSelection.cursor(0) }],
			["scroll-stale", {
				scrollAnchor: snapshot.scrollAnchor === 0 ? 1 : 0,
			}],
		];
		for (const [expected, patch] of driftCases) {
			const actualSnapshot = Object.freeze({ ...snapshot, ...patch });
			snapshotAuthorities.set(actualSnapshot, expectedPrivate);
			const actualReason = manager.classifyHandoffReplaySnapshotDrift(
				snapshot,
				expectedPrivate,
				actualSnapshot,
			);
			if (actualReason !== expected) {
				throw new Error(
					"snapshot drift branch mismatch: expected " + expected
						+ ", got " + String(actualReason),
				);
			}
			notAppliedBranchReasons.push(expected);
		}
		const recoveryStateReason = manager.handoffReplayNotReadyReason(
			"target-not-proven",
		);
		if (recoveryStateReason !== "recovery-state-stale") {
			throw new Error("target-not-proven did not map to recovery-state-stale");
		}
		notAppliedBranchReasons.push(recoveryStateReason);

		const exercisePreDispatchReason = ({
			expected,
			requestPlan,
			acceptedPlan,
			requestRecord = record,
			acceptedRecord = record,
			acceptedSnapshot = snapshot,
			recoveryOperationEpoch = 1,
			beforeApply = () => {},
			afterApply = () => {},
		}) => {
			const requestPermit = Object.freeze({ ...permit });
			redemption = {
				permit: requestPermit,
				snapshot: acceptedSnapshot,
				plan: acceptedPlan,
				record: acceptedRecord,
			};
			beforeApply();
			let result;
			try {
				result = manager.applyExactHandoffReplay({
					plan: requestPlan,
					permit: requestPermit,
					record: requestRecord,
					recoveryOperationEpoch,
				});
			} finally {
				afterApply();
			}
			recordNotApplied(expected, result);
		};

		const requestedPlanMismatch = Object.freeze({ ...plan });
		const acceptedPlanMismatch = Object.freeze({ ...plan });
		exercisePreDispatchReason({
			expected: "plan-mismatch",
			requestPlan: requestedPlanMismatch,
			acceptedPlan: acceptedPlanMismatch,
		});
		const recordMismatchPlan = Object.freeze({ ...plan });
		exercisePreDispatchReason({
			expected: "record-mismatch",
			requestPlan: recordMismatchPlan,
			acceptedPlan: recordMismatchPlan,
			requestRecord: Object.freeze({ ...record }),
		});
		const operationPlan = Object.freeze({ ...plan });
		exercisePreDispatchReason({
			expected: "recovery-operation-stale",
			requestPlan: operationPlan,
			acceptedPlan: operationPlan,
			recoveryOperationEpoch: 2,
		});
		const unmappableSnapshot = Object.freeze({ ...snapshot });
		snapshotAuthorities.set(unmappableSnapshot, Object.freeze({
			...expectedPrivate,
			scrollSnapshot: Object.freeze({
				...expectedPrivate.scrollSnapshot,
				map: () => undefined,
			}),
		}));
		const unmappablePlan = Object.freeze({ ...plan });
		exercisePreDispatchReason({
			expected: "scroll-effect-unmappable",
			requestPlan: unmappablePlan,
			acceptedPlan: unmappablePlan,
			acceptedSnapshot: unmappableSnapshot,
		});
		const rejectedPlan = Object.freeze({ ...plan });
		exercisePreDispatchReason({
			expected: "dispatch-rejected",
			requestPlan: rejectedPlan,
			acceptedPlan: rejectedPlan,
			beforeApply: () => {
				manager.activeHandoffReplayDispatchFrame = Object.freeze({});
			},
			afterApply: () => {
				manager.activeHandoffReplayDispatchFrame = null;
			},
		});
		redemption = { permit, snapshot, plan, record };
		const applyResult = manager.applyExactHandoffReplay({
			plan,
			permit,
			record,
			recoveryOperationEpoch: 1,
		});
		const afterApply = cm.state.doc.toString();
		const awaitingSettlement = reduceManagedLeafSession(runtime.session, {
			type: "intent-state-changed",
			sessionId: managed.sessionId,
			expectedGeneration: managed.generation,
			recoveryOperationEpoch: 1,
			intentState: Object.freeze({
				kind: "replayed-awaiting-settlement",
				intentId: intent.intentId,
				recordId: record.recordId,
			}),
		});
		if (!awaitingSettlement.accepted) {
			throw new Error("replayed settlement transition rejected");
		}
		runtime.session = awaitingSettlement.state;
		manager.applyHandoffEffects(
			runtime,
			awaitingSettlement.effects,
			"fixture-replayed-awaiting-settlement",
		);
		const resolved = reduceManagedLeafSession(runtime.session, {
			type: "intent-state-changed",
			sessionId: managed.sessionId,
			expectedGeneration: managed.generation,
			recoveryOperationEpoch: 1,
			intentState: Object.freeze({
				kind: "resolved",
				intentId: intent.intentId,
				recordId: record.recordId,
			}),
		});
		if (!resolved.accepted) throw new Error("resolved transition rejected");
		runtime.session = resolved.state;
		manager.applyHandoffEffects(runtime, resolved.effects, "fixture-resolved");
		undo(cm);
		await Promise.resolve();
		const undoContent = cm.state.doc.toString();
		redo(cm);
		await Promise.resolve();
		const redoContent = cm.state.doc.toString();
		const second = manager.applyExactHandoffReplay({
			plan,
			permit,
			record,
			recoveryOperationEpoch: 1,
		});
		const supplemental = {
			hasDispatchApi: typeof manager.applyExactHandoffReplay === "function",
			hasRealEditor: cm instanceof EditorView,
			hasRealYText: ytext instanceof Y.Text,
			hasRealUndoManager: undoManager instanceof Y.UndoManager,
			invalidRequestReason:
				manager.applyExactHandoffReplay({
					plan: null,
					permit: null,
					record: null,
					recoveryOperationEpoch: 0,
				})?.reason ?? null,
			applyKind: applyResult.kind,
			applyReason: applyResult.reason ?? null,
			cmContent: afterApply,
			ytextContent: ytext.toString(),
			undoContent,
			redoContent,
			sourceContent: sourceText.toString(),
			secondReason: second.reason ?? null,
			notAppliedBranchReasons,
			guardTrace,
		};
		manager.unbindAll();
		cm.destroy();
		undoManager.destroy();
		ydoc.destroy();
		parent.remove();
		const publicExisting = await runPublicHandoffReplay(false);
		const publicMissing = await runPublicHandoffReplay(true);
		const publicExactScrollEpochAdvance = await runPublicHandoffReplay(
			false,
			"exact-scroll-epoch-advance",
		);
		const publicFaults = [];
		for (const expected of ${JSON.stringify(allUncertainReasons)}) {
			const fault = await runPublicHandoffReplay(false, expected);
			publicFaults.push({
				expected,
				kind: fault.applyKind,
				reason: fault.applyReason,
				classifierError: fault.classifierError,
				traceContentFree: fault.traceContentFree,
			});
		}
		const authorityEpochFaultResult = await runPublicHandoffReplay(
			false,
			"authority-epoch-mismatch",
		);
		return {
			...supplemental,
			publicExisting,
			publicMissing,
			publicExactScrollEpochAdvance,
			publicFaults,
			authorityEpochFault: {
				kind: authorityEpochFaultResult.applyKind,
				reason: authorityEpochFaultResult.applyReason,
				classifierError: authorityEpochFaultResult.classifierError,
				traceContentFree: authorityEpochFaultResult.traceContentFree,
			},
		};
	})();
`;

const childScript = `
	import { build } from "esbuild";
	import { chromium } from "playwright";
	const browserBundle = await build({
		stdin: {
			resolveDir: ${JSON.stringify(repoRoot)},
			loader: "ts",
			contents: ${JSON.stringify(browserEntry)},
		},
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "chrome120",
		write: false,
		plugins: [{
			name: "handoff-replay-obsidian-mock",
			setup(esbuild) {
				esbuild.onResolve(
					{ filter: /^obsidian$/ },
					() => ({ path: ${JSON.stringify(obsidianMockPath)} }),
				);
			},
		}],
	});
	let browser = null;
	for (const options of [{}, { channel: "chrome" }]) {
		try {
			browser = await chromium.launch({ ...options, headless: true });
			break;
		} catch {}
	}
	if (!browser) throw new Error("No supported Chromium could launch");
	try {
		const page = await browser.newPage();
		await page.route("https://kaos.test/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><body></body></html>",
			});
		});
		await page.goto("https://kaos.test/");
		await page.addScriptTag({ content: browserBundle.outputFiles[0]?.text ?? "" });
		const result = await page.evaluate(async () =>
			await window.__KAOS_HANDOFF_RECOVERY_REPLAY_RED__);
		console.log("HANDOFF_RECOVERY_REPLAY_RED=" + JSON.stringify(result));
	} finally {
		await browser.close();
	}
`;

const child = spawnSync(
	process.execPath,
	["--input-type=module", "--eval", childScript],
	{ cwd: repoRoot, encoding: "utf8", timeout: 90_000 },
);
if (child.status !== 0) {
	console.error(child.stderr || child.error?.message || "browser subprocess failed");
	process.exit(1);
}
const resultLine = child.stdout
	.split("\n")
	.find((line) => line.startsWith("HANDOFF_RECOVERY_REPLAY_RED="));
const result = JSON.parse(
	resultLine?.slice("HANDOFF_RECOVERY_REPLAY_RED=".length) ?? "null",
) as BrowserRedResult | null;
if (
	result === null
	|| result.hasRealEditor !== true
	|| result.hasRealYText !== true
	|| result.hasRealUndoManager !== true
	|| result.invalidRequestReason !== "permit-mismatch"
) {
	throw new Error("real CodeMirror/Yjs replay fixture did not initialize");
}
if (result.hasDispatchApi !== true) {
	throw new Error("EditorBindingManager.applyExactHandoffReplay is missing");
}
if (
	result.applyKind !== "applied"
	|| result.cmContent !== result.redoContent
	|| result.undoContent === result.redoContent
	|| result.ytextContent !== result.redoContent
	|| result.sourceContent !== "source A must remain unchanged"
	|| result.secondReason !== "plan-already-consumed"
) {
	throw new Error(
		"exact replay/undo fixture failed: " + JSON.stringify({
			applyKind: result.applyKind,
			applyReason: result.applyReason,
			cmEqualsRedo: result.cmContent === result.redoContent,
			undoDiffersFromRedo: result.undoContent !== result.redoContent,
			ytextEqualsRedo: result.ytextContent === result.redoContent,
			secondReason: result.secondReason,
			lengths: [
				result.cmContent.length,
				result.ytextContent.length,
				result.undoContent.length,
				result.redoContent.length,
			],
			guardTrace: result.guardTrace,
		}),
	);
}
const privateTracePayload = JSON.stringify(result.guardTrace);
if (
	privateTracePayload.includes("source A must remain unchanged")
	|| privateTracePayload.includes("target B line")
	|| privateTracePayload.includes("replayed-only-B")
) {
	throw new Error("handoff replay trace leaked note content");
}

function assertPublicReplay(
	publicResult: PublicHandoffReplayResult,
	seedMissingTarget: boolean,
): void {
	if (
		publicResult.seedMissingTarget !== seedMissingTarget
		|| publicResult.initialPublicBinding !== true
		|| publicResult.recoveryBindingRequested !== true
		|| publicResult.actualControllerPlan !== true
		|| publicResult.actualControllerPermit !== true
		|| publicResult.actualControllerRedemption !== true
		|| publicResult.applyKind !== "applied"
		|| publicResult.applyReason !== null
		|| publicResult.inputWasQuarantinedBeforePresentation !== true
		|| publicResult.providerAbaBeforeRecoveryBind !== !seedMissingTarget
		|| publicResult.recoveryTokenReplacedAfterPresentation !== true
		|| publicResult.recoveryTokenIssuedAfterProviderAba !== true
		|| publicResult.targetPresentationReadyNotified !== true
		|| publicResult.targetPresentationReadyBeforeBinding !== true
		|| publicResult.targetPresentationReadyNotificationCount !== 1
		|| publicResult.scrollAnchorNonNull !== true
		|| publicResult.mappedScrollAnchorExact !== true
		|| publicResult.mappedScrollEffectAnchorExact !== true
		|| publicResult.localDispatchReceiptCreated !== true
		|| publicResult.settlementSnapshotReady !== true
		|| publicResult.contentBeforeReplayUndo
			!== publicResult.contentAfterReplayRedo
		|| publicResult.contentAfterReplayUndo
			=== publicResult.contentAfterReplayRedo
		|| publicResult.sourceYtextContent
			!== publicResult.contentAfterReplayUndo
		|| publicResult.sourceYtextObserverUpdateCount !== 0
		|| publicResult.sourceYtextStructureUnchanged !== true
		|| publicResult.targetYtextContent
			!== publicResult.contentAfterReplayRedo
		|| publicResult.cmContent !== publicResult.contentAfterReplayRedo
		|| !publicResult.finalBindingPath?.endsWith("-B.md")
		|| publicResult.finalHandoffCleared !== true
		|| publicResult.classifierError !== null
		|| publicResult.traceContentFree !== true
	) {
		throw new Error(
			`public ${seedMissingTarget ? "missing" : "existing"}-B replay failed: `
				+ JSON.stringify({
					apply: [
						publicResult.applyKind,
						publicResult.applyReason,
					],
					proofs: {
						initialPublicBinding:
							publicResult.initialPublicBinding,
						recoveryBindingRequested:
							publicResult.recoveryBindingRequested,
						actualControllerPlan:
							publicResult.actualControllerPlan,
						actualControllerPermit:
							publicResult.actualControllerPermit,
						actualControllerRedemption:
							publicResult.actualControllerRedemption,
						inputWasQuarantinedBeforePresentation:
							publicResult.inputWasQuarantinedBeforePresentation,
						providerAbaBeforeRecoveryBind:
							publicResult.providerAbaBeforeRecoveryBind,
						recoveryTokenReplacedAfterPresentation:
							publicResult.recoveryTokenReplacedAfterPresentation,
						recoveryTokenIssuedAfterProviderAba:
							publicResult.recoveryTokenIssuedAfterProviderAba,
						targetPresentationReadyNotified:
							publicResult.targetPresentationReadyNotified,
						targetPresentationReadyBeforeBinding:
							publicResult.targetPresentationReadyBeforeBinding,
						targetPresentationReadyNotificationCount:
							publicResult.targetPresentationReadyNotificationCount,
						scrollAnchorNonNull:
							publicResult.scrollAnchorNonNull,
						mappedScrollAnchorExact:
							publicResult.mappedScrollAnchorExact,
						mappedScrollEffectAnchorExact:
							publicResult.mappedScrollEffectAnchorExact,
						localDispatchReceiptCreated:
							publicResult.localDispatchReceiptCreated,
						settlementSnapshotReady:
							publicResult.settlementSnapshotReady,
						sourceYtextObserverUpdateCount:
							publicResult.sourceYtextObserverUpdateCount,
						sourceYtextStructureUnchanged:
							publicResult.sourceYtextStructureUnchanged,
						finalHandoffCleared:
							publicResult.finalHandoffCleared,
					},
					lengths: {
						cm: publicResult.cmContent.length,
						target: publicResult.targetYtextContent?.length ?? null,
						source: publicResult.sourceYtextContent.length,
						beforeReplayUndo:
							publicResult.contentBeforeReplayUndo.length,
						afterReplayUndo:
							publicResult.contentAfterReplayUndo.length,
						afterReplayRedo:
							publicResult.contentAfterReplayRedo.length,
					},
					finalBindingPath: publicResult.finalBindingPath,
					classifierError: publicResult.classifierError,
					traceStages: publicResult.traceStages,
				}),
		);
	}
}

assertPublicReplay(result.publicExisting, false);
assertPublicReplay(result.publicMissing, true);
assertPublicReplay(result.publicExactScrollEpochAdvance, false);

for (const expected of allUncertainReasons) {
	const fault = result.publicFaults.find((candidate) =>
		candidate.expected === expected
	);
	if (
		fault === undefined
		|| fault.kind !== "dispatched-uncertain"
		|| fault.reason !== expected
		|| fault.classifierError === null
		|| fault.traceContentFree !== true
	) {
		throw new Error(
			`uncertain replay branch was not exercised for ${expected}: `
				+ JSON.stringify(fault ?? null),
		);
	}
}

if (
	result.authorityEpochFault.kind !== "dispatched-uncertain"
	|| result.authorityEpochFault.reason !== "post-target-identity-mismatch"
	|| result.authorityEpochFault.classifierError === null
	|| result.authorityEpochFault.traceContentFree !== true
) {
	throw new Error(
		"authority epoch ABA was not rejected after replay dispatch: "
			+ JSON.stringify(result.authorityEpochFault),
	);
}

const exercisedNotAppliedReasons = new Set<string>([
	result.invalidRequestReason ?? "",
	result.secondReason ?? "",
	...result.notAppliedBranchReasons,
]);
for (const expected of allNotAppliedReasons) {
	if (!exercisedNotAppliedReasons.has(expected)) {
		throw new Error(`not-applied replay branch was not exercised for ${expected}`);
	}
}
if (allNotAppliedReasons.length !== 21 || allUncertainReasons.length !== 9) {
	throw new Error("closed replay result vocabularies changed without branch coverage");
}

console.log(
	"handoff-recovery-replay: public actual-controller and dispatch boundary fixtures passed",
);
