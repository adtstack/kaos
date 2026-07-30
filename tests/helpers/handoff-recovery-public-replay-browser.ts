import { history, redo, undo } from "@codemirror/commands";
import {
	EditorSelection,
	EditorState,
	Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { App, MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ManualHandoffRecoveryCoordinator } from "../../src/runtime/handoffRecoveryCoordinator";
import {
	ReconciliationController,
	type ReconciliationControllerDeps,
} from "../../src/runtime/reconciliationController";
import { buildRuntimeConfig } from "../../src/runtime/runtimeConfig";
import { DEFAULT_SETTINGS } from "../../src/settings/settingsStore";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type {
	HandoffReplayUncertainReason,
} from "../../src/sync/editorHandoffReplay";
import {
	HANDOFF_RECOVERY_SCHEMA_VERSION,
	hashHandoffRecoveryDispatchReceipt,
	isActiveHandoffRecoveryRecord,
} from "../../src/sync/handoffRecoveryStore";
import { IndexedDbHandoffRecoveryStore } from "../../src/sync/indexedDbHandoffRecoveryStore";
import type { VaultSync } from "../../src/sync/vaultSync";

export type PublicHandoffReplayResult = Readonly<{
	seedMissingTarget: boolean;
	initialPublicBinding: boolean;
	recoveryBindingRequested: boolean;
	actualControllerPlan: boolean;
	actualControllerPermit: boolean;
	actualControllerRedemption: boolean;
	applyKind: string | null;
	applyReason: string | null;
	cmContent: string;
	targetYtextContent: string | null;
	sourceYtextContent: string;
	sourceYtextObserverUpdateCount: number;
	sourceYtextStructureUnchanged: boolean;
	contentBeforeReplayUndo: string;
	contentAfterReplayUndo: string;
	contentAfterReplayRedo: string;
	inputWasQuarantinedBeforePresentation: boolean;
	providerAbaBeforeRecoveryBind: boolean;
	recoveryTokenReplacedAfterPresentation: boolean;
	recoveryTokenIssuedAfterProviderAba: boolean;
	targetPresentationReadyNotified: boolean;
	targetPresentationReadyBeforeBinding: boolean;
	targetPresentationReadyNotificationCount: number;
	scrollAnchorNonNull: boolean;
	mappedScrollAnchorExact: boolean;
	mappedScrollEffectAnchorExact: boolean;
	localDispatchReceiptCreated: boolean;
	settlementSnapshotReady: boolean;
	finalBindingPath: string | null;
	finalHandoffCleared: boolean;
	classifierError: string | null;
	traceContentFree: boolean;
	traceStages: readonly string[];
}>;

export type PublicHandoffReplayFault =
	| HandoffReplayUncertainReason
	| "exact-scroll-epoch-advance"
	| "authority-epoch-mismatch";

let publicFixtureSequence = 0;

function makeFile(path: string, content: string): TFile {
	const file = new TFile();
	Object.defineProperties(file, {
		path: {
			configurable: true,
			enumerable: true,
			value: path,
			writable: true,
		},
		stat: {
			configurable: true,
			enumerable: true,
			value: Object.freeze({
				ctime: 1,
				mtime: 1,
				size: content.length,
			}),
			writable: true,
		},
	});
	return file;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	turns = 240,
): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => resolve());
		});
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string"
			? error
			: "unknown public replay fixture failure";
}

type YTextItemWitness = Readonly<{
	item: object;
	left: unknown;
	right: unknown;
	deleted: unknown;
	length: unknown;
	idClient: unknown;
	idClock: unknown;
	content: unknown;
}>;

function captureYTextItemWitness(text: Y.Text): readonly YTextItemWitness[] {
	const witness: YTextItemWitness[] = [];
	let item = Reflect.get(text, "_start") as object | null;
	while (item !== null) {
		const id = Reflect.get(item, "id") as object | null;
		witness.push(Object.freeze({
			item,
			left: Reflect.get(item, "left"),
			right: Reflect.get(item, "right"),
			deleted: Reflect.get(item, "deleted"),
			length: Reflect.get(item, "length"),
			idClient: id === null ? null : Reflect.get(id, "client"),
			idClock: id === null ? null : Reflect.get(id, "clock"),
			content: Reflect.get(item, "content"),
		}));
		item = Reflect.get(item, "right") as object | null;
	}
	return Object.freeze(witness);
}

function sameYTextItemWitness(
	left: readonly YTextItemWitness[],
	right: readonly YTextItemWitness[],
): boolean {
	return left.length === right.length
		&& left.every((item, index) => {
			const other = right[index];
			return other !== undefined
				&& item.item === other.item
				&& item.left === other.left
				&& item.right === other.right
				&& item.deleted === other.deleted
				&& item.length === other.length
				&& item.idClient === other.idClient
				&& item.idClock === other.idClock
				&& item.content === other.content;
		});
}

export async function runPublicHandoffReplay(
	seedMissingTarget: boolean,
	faultReason: PublicHandoffReplayFault | null = null,
): Promise<PublicHandoffReplayResult> {
	publicFixtureSequence += 1;
	const suffix = `${seedMissingTarget ? "missing" : "existing"}-${publicFixtureSequence}`;
	const baseContent = Array.from(
		{ length: 180 },
		(_, index) => `public B line ${String(index).padStart(3, "0")}`,
	).join("\n");
	const inserted = "\npublic-replayed-only-B";
	let resultContent = baseContent + inserted;
	const sourcePath = `Notes/public-${suffix}-A.md`;
	const targetPath = `Notes/public-${suffix}-B.md`;
	const sourceFile = makeFile(sourcePath, baseContent);
	const targetFile = makeFile(targetPath, baseContent);
	const ydoc = new Y.Doc();
	const sourceYtext = ydoc.getText(`public-${suffix}-source`);
	sourceYtext.insert(0, baseContent);
	let sourceYtextObserverUpdateCount = 0;
	const sourceYtextObserver = () => {
		sourceYtextObserverUpdateCount += 1;
	};
	sourceYtext.observe(sourceYtextObserver);
	const sourceYtextStructureBefore = captureYTextItemWitness(sourceYtext);
	let targetYtext: Y.Text | null = seedMissingTarget
		? null
		: ydoc.getText(`public-${suffix}-target`);
	if (targetYtext) targetYtext.insert(0, baseContent);
	const awareness = new Awareness(ydoc);
	const activeIdsByPath = new Map<string, readonly string[]>([
		[sourcePath, Object.freeze([`file-${suffix}-A`])],
		[
			targetPath,
			seedMissingTarget
				? Object.freeze([])
				: Object.freeze([`file-${suffix}-B`]),
		],
	]);
	const textByPath = new Map<string, Y.Text>([
		[sourcePath, sourceYtext],
	]);
	if (targetYtext) textByPath.set(targetPath, targetYtext);
	const idByPath = new Map<string, string>([
		[sourcePath, `file-${suffix}-A`],
	]);
	if (targetYtext) idByPath.set(targetPath, `file-${suffix}-B`);
	const idByText = new WeakMap<Y.Text, string>();
	idByText.set(sourceYtext, `file-${suffix}-A`);
	if (targetYtext) idByText.set(targetYtext, `file-${suffix}-B`);

	const vaultSync = {
		ydoc,
		provider: { awareness },
		getActiveFileIdsForPath(path: string) {
			return activeIdsByPath.get(path) ?? [];
		},
		getTextForPath(path: string) {
			return textByPath.get(path) ?? null;
		},
		getFileId(path: string) {
			return idByPath.get(path);
		},
		getFileIdForText(text: Y.Text) {
			return idByText.get(text);
		},
		isPendingRenameTarget() {
			return false;
		},
		isMarkdownTombstoned() {
			return false;
		},
		ensureFile(
			path: string,
			content: string,
			_deviceName: string,
			options?: Readonly<{ canCreate?: () => boolean }>,
		) {
			const existing = textByPath.get(path);
			const existingId = idByPath.get(path);
			if (existing && existingId) {
				return { kind: "existing" as const, fileId: existingId, ytext: existing };
			}
			if (path !== targetPath || options?.canCreate?.() !== true) {
				return { kind: "replan" as const, reason: "active-set-changed" as const };
			}
			const fileId = `file-${suffix}-B`;
			const created = ydoc.getText(`public-${suffix}-target`);
			targetYtext = created;
			textByPath.set(path, created);
			idByPath.set(path, fileId);
			idByText.set(created, fileId);
			activeIdsByPath.set(path, Object.freeze([fileId]));
			if (created.length === 0) {
				ydoc.transact(() => created.insert(0, content), "public-seed");
			}
			return { kind: "created" as const, fileId, ytext: created };
		},
	} as unknown as VaultSync;

	let view: MarkdownView;
	let cm: EditorView;
	let manager: EditorBindingManager;
	let controller: ReconciliationController;
	let releasePresentation: (() => void) | null = null;
	let presentationReady = false;
	let targetPresentationHeldOnce = false;
	let classifierStarted = false;
	let classifierError: string | null = null;
	let recoveryBindingRequested = false;
	let actualControllerPlan = false;
	let actualControllerPermit = false;
	let actualControllerRedemption = false;
	let providerAbaBeforeRecoveryBind = false;
	let recoveryTokenReplacedAfterPresentation = false;
	let recoveryTokenIssuedAfterProviderAba = false;
	let targetPresentationReadyNotified = false;
	let targetPresentationReadyBeforeBinding = false;
	let targetPresentationReadyNotificationCount = 0;
	let scrollAnchorNonNull = false;
	let mappedScrollAnchorExact = false;
	let mappedScrollEffectAnchorExact = false;
	let localDispatchReceiptCreated = false;
	let settlementSnapshotReady = false;
	let applyKind: string | null = null;
	let applyReason: string | null = null;
	const traceStages: string[] = [];

	const app = new App();
	const settings = Object.freeze({
		...DEFAULT_SETTINGS,
		vaultId: `public-vault-${suffix}`,
		deviceName: `public-device-${suffix}`,
	});
	const runtimeConfig = Object.freeze(buildRuntimeConfig(settings, ".obsidian"));
	const diskIndex = {
		[targetPath]: {
			mtime: 1,
			size: baseContent.length,
			contentHash: `public-baseline-${suffix}`,
		},
	};
	Object.defineProperties(app, {
		vault: {
			configurable: true,
			value: {
				getAbstractFileByPath(path: string) {
					return path === sourcePath
						? sourceFile
						: path === targetPath
							? targetFile
							: null;
				},
				async read(file: TFile) {
					if (file === sourceFile || file === targetFile) return baseContent;
					throw new Error("unknown public fixture file");
				},
				adapter: {
					async stat(path: string) {
						return path === targetPath
							? { ctime: 1, mtime: 1, size: baseContent.length }
							: null;
					},
				},
			},
		},
		workspace: {
			configurable: true,
			value: {
				get activeLeaf() {
					return view ? { view } : null;
				},
				getActiveViewOfType() {
					return view ?? null;
				},
				iterateAllLeaves(callback: (leaf: Readonly<{ view: MarkdownView }>) => void) {
					if (view) callback({ view });
				},
			},
		},
	});
	const deps: ReconciliationControllerDeps = {
		app,
		getSettings: () => settings,
		getRuntimeConfig: () => runtimeConfig,
		getVaultSync: () => vaultSync,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => manager,
		getDiskIndex: () => diskIndex,
		setDiskIndex: () => {},
		isMarkdownPathSyncable: (path) =>
			path === sourcePath || path === targetPath,
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
		trace: (_source, message) => {
			if (
				message.startsWith("handoff-replay")
				|| message.includes("recovery-target-binding")
			) traceStages.push(message);
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		readStableMarkdownFile: async (path) =>
			path === sourcePath || path === targetPath
			? {
				kind: "ready" as const,
				file: path === sourcePath ? sourceFile : targetFile,
				content: baseContent,
				stat: { mtime: 1, size: baseContent.length },
			}
			: { kind: "missing" as const },
		handoffReplayLifecycleNonceFactory: () => `public-controller-${suffix}`,
	};
	controller = new ReconciliationController(deps);

	const controllerPort = {
		requestOpenPathAdmission:
			controller.requestOpenPathAdmission.bind(controller),
		requestTargetPresentation(request: Parameters<
			ReconciliationController["requestTargetPresentation"]
		>[0]) {
			const planned = controller.requestTargetPresentation(request);
			if (request.targetPath === sourcePath || targetPresentationHeldOnce) {
				return planned;
			}
			targetPresentationHeldOnce = true;
			return new Promise<Awaited<typeof planned>>((resolve, reject) => {
				void planned.then((result) => {
					presentationReady = true;
					releasePresentation = () => resolve(result);
				}, reject);
			});
		},
		consumeTargetPresentationPermit:
			controller.consumeTargetPresentationPermit.bind(controller),
		completeTargetPresentation:
			controller.completeTargetPresentation.bind(controller),
		seedMissingTarget: controller.seedMissingTarget.bind(controller),
		isAuthorityFreshnessCurrent(
			...args: Parameters<
				ReconciliationController["isAuthorityFreshnessCurrent"]
			>
		) {
			const accepted = controller.isAuthorityFreshnessCurrent(...args);
			traceStages.push(`public-authority-freshness:${String(accepted)}`);
			return accepted;
		},
		consumeBindPermit(
			...args: Parameters<ReconciliationController["consumeBindPermit"]>
		) {
			const accepted = controller.consumeBindPermit(...args);
			traceStages.push(`public-bind-permit:${String(accepted)}`);
			return accepted;
		},
		redeemExactHandoffReplayDispatchPermit(permit: Parameters<
			ReconciliationController["redeemExactHandoffReplayDispatchPermit"]
		>[0]) {
			const result =
				controller.redeemExactHandoffReplayDispatchPermit(permit);
			if (result.kind === "accepted") actualControllerRedemption = true;
			return result;
		},
	};

	const scope = Object.freeze({
		schemaVersion: HANDOFF_RECOVERY_SCHEMA_VERSION,
		vaultId: settings.vaultId,
		localDeviceId: settings.deviceName,
	});
	const store = new IndexedDbHandoffRecoveryStore(
		scope,
		indexedDB,
		`kaos-public-handoff-${suffix}-${Date.now()}`,
		() => Date.now(),
	);
	const coordinator = new ManualHandoffRecoveryCoordinator({
		store,
		isScopeCurrent: () => true,
		classifyStoredIntent: async (request, stored) => {
			classifierStarted = true;
			try {
				await waitFor(
					() =>
						manager.getManagedSession(view)?.handoff?.presentation
							=== "target-proven",
					"target-proven reducer state",
				);
				const presentationToken =
					manager.captureCurrentTargetReadyToken({
						sessionId: request.sessionId,
						expectedGeneration: request.expectedGeneration,
						targetPath,
						targetFile,
					});
				if (!seedMissingTarget) {
					const current = targetYtext;
					if (!current) throw new Error("existing target Y.Text disappeared");
					const providerOrigin = Object.freeze({ kind: "provider-public-fixture" });
					ydoc.transact(() => current.insert(current.length, "!"), providerOrigin);
					ydoc.transact(() => current.delete(current.length - 1, 1), providerOrigin);
					providerAbaBeforeRecoveryBind = current.toString() === baseContent;
				}
				recoveryBindingRequested = request.deliver({
					type: "recovery-target-binding-requested",
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
					intentId: stored.intentId,
					recordId: stored.recordId,
				});
				if (!recoveryBindingRequested) {
					throw new Error("recovery target binding reducer event was rejected");
				}
				await waitFor(
					() => manager.getBinding(view)?.path === targetPath,
					"public recovery target binding",
				);
				const token = manager.captureCurrentTargetReadyToken({
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					targetPath,
					targetFile,
				});
				if (!token) throw new Error("current recovery target token is missing");
				recoveryTokenReplacedAfterPresentation =
					token !== presentationToken;
				recoveryTokenIssuedAfterProviderAba = seedMissingTarget
					? token !== presentationToken
					: presentationToken?.targetAuthority.kind === "existing"
						&& token.targetAuthority.kind === "existing"
						&& token.targetAuthority.ytextMutationEpoch
							> presentationToken.targetAuthority.ytextMutationEpoch;
				const diagnosticCapture =
					manager.captureHandoffReplayTargetSnapshot({
						sessionId: request.sessionId,
						expectedGeneration: request.expectedGeneration,
						recoveryOperationEpoch: request.recoveryOperationEpoch,
						recoveryClaim: Object.freeze({
							intentId: stored.intentId,
							recordId: stored.recordId,
						}),
						targetReadyToken: token,
					});
				if (diagnosticCapture.kind === "ready") {
					const snapshot = diagnosticCapture.snapshot;
					scrollAnchorNonNull = snapshot.scrollAnchor !== null;
					controller.isAuthorityFreshnessCurrent(
						token.authorityFreshnessHandleId,
						Object.freeze({
							sessionId: snapshot.sessionId,
							leafId: snapshot.leafId,
							handoffGeneration:
								snapshot.handoffGeneration,
							targetReadyTokenId:
								snapshot.targetReadyTokenId,
							targetFile: snapshot.targetFile,
							hostLoadReceiptId:
								snapshot.hostLoadReceiptId,
							cm: snapshot.cm,
							editorRevision:
								snapshot.editorRevision,
							nativeHistoryEpoch:
								snapshot.nativeHistoryEpoch,
							selectionEpoch:
								snapshot.selectionEpoch,
							scrollEpoch: snapshot.scrollEpoch,
						}),
					);
				}
				const planned = await controller.requestExactHandoffReplayPlan({
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
					intent: request.intent,
					record: stored,
					targetReadyToken: token,
					compositionProof: null,
				});
				actualControllerPlan = planned.kind === "planned";
				if (planned.kind !== "planned") {
					throw new Error(`actual controller did not plan replay: ${planned.reason}`);
				}
				const diagnosticAnchor = diagnosticCapture.kind === "ready"
					? diagnosticCapture.snapshot.scrollAnchor
					: null;
				mappedScrollAnchorExact = diagnosticAnchor !== null
					&& planned.plan.mappedScrollAnchor
						=== planned.plan.replayChanges.mapPos(
							diagnosticAnchor,
							-1,
						);
				const mappedLiveScroll =
					cm.scrollSnapshot().map(planned.plan.replayChanges);
				mappedScrollEffectAnchorExact =
					mappedLiveScroll !== undefined
					&& mappedLiveScroll.value.range.head
						=== planned.plan.mappedScrollAnchor;
				const pending = await store.storeApplyWitness(
					stored.recordId,
					stored.checksum,
					planned.applyWitness,
				);
				if (
					pending.kind !== "updated"
					|| !isActiveHandoffRecoveryRecord(pending.record)
					|| pending.record.status !== "replay-pending"
				) {
					throw new Error(`apply witness did not reach replay-pending: ${pending.kind}`);
				}
				if (!request.deliver({
					type: "intent-state-changed",
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
					intentState: {
						kind: "replay-pending",
						intentId: stored.intentId,
						recordId: stored.recordId,
					},
				})) {
					throw new Error("replay-pending reducer delivery was rejected");
				}
				const permitted = controller.consumeExactHandoffReplayPermit({
					plan: planned.plan,
					record: pending.record,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
				});
				actualControllerPermit = permitted.kind === "accepted";
				if (permitted.kind !== "accepted") {
					throw new Error(`actual controller permit rejected: ${permitted.reason}`);
				}
				const replayDispatch = cm.dispatch;
				const cleanupFaults: Array<() => void> = [];
				if (faultReason !== null) {
					const faultingDispatch = function (
						this: EditorView,
						...args: Parameters<EditorView["dispatch"]>
					): void {
						Reflect.apply(replayDispatch, cm, args);
						switch (faultReason) {
							case "dispatch-threw-after-mutation":
								throw new Error("content-free injected dispatch failure");
							case "post-target-identity-mismatch": {
								const binding = manager.getBinding(view);
								if (!binding) throw new Error("fault binding disappeared");
								const originalCmId = binding.cmId;
								binding.cmId = `${originalCmId}-fault`;
								cleanupFaults.push(() => { binding.cmId = originalCmId; });
								break;
							}
							case "authority-epoch-mismatch": {
								const original = Reflect.get(manager, "authorityEpoch") as number;
								Reflect.set(manager, "authorityEpoch", original + 1);
								cleanupFaults.push(() => {
									Reflect.set(manager, "authorityEpoch", original);
								});
								break;
							}
							case "post-document-mismatch": {
								const revisions = Reflect.get(
									manager,
									"editorAuthorityRevisionByCm",
								) as WeakMap<EditorView, number>;
								const original = revisions.get(cm) ?? 0;
								revisions.set(cm, original + 1);
								cleanupFaults.push(() => { revisions.set(cm, original); });
								break;
							}
							case "post-editor-facade-mismatch":
								facadeContentOverride = baseContent;
								cleanupFaults.push(() => { facadeContentOverride = null; });
								break;
							case "post-runtime-cache-mismatch": {
								const runtimeView = view as MarkdownView & { data: string };
								const original = runtimeView.data;
								runtimeView.data = baseContent;
								cleanupFaults.push(() => { runtimeView.data = original; });
								break;
							}
							case "post-ytext-mismatch": {
								const revisions = Reflect.get(
									manager,
									"yTextMutationRevisionByText",
								) as WeakMap<Y.Text, number>;
								const currentTarget = targetYtext;
								if (!currentTarget) throw new Error("fault target disappeared");
								const original = revisions.get(currentTarget) ?? 0;
								revisions.set(currentTarget, original + 1);
								cleanupFaults.push(() => {
									revisions.set(currentTarget, original);
								});
								break;
							}
							case "post-native-history-mismatch": {
								const binding = manager.getBinding(view);
								if (!binding) throw new Error("fault binding disappeared");
								const top = binding.undoManager.undoStack.at(-1);
								if (!top) throw new Error("fault undo stack is empty");
								binding.undoManager.undoStack.push(top);
								cleanupFaults.push(() => {
									binding.undoManager.undoStack.pop();
								});
								break;
							}
							case "post-selection-mismatch": {
								const selection = cm.state.selection as EditorSelection & {
									eq(other: EditorSelection): boolean;
								};
								const original = selection.eq;
								Object.defineProperty(selection, "eq", {
									configurable: true,
									value: () => false,
								});
								cleanupFaults.push(() => {
									Object.defineProperty(selection, "eq", {
										configurable: true,
										value: original,
									});
								});
								break;
							}
						case "post-scroll-mismatch": {
								const original = cm.scrollSnapshot;
								const wrongAnchor = planned.plan.mappedScrollAnchor === 0 ? 1 : 0;
								Reflect.set(cm, "scrollSnapshot", () => {
									const snapshot = Reflect.apply(original, cm, []);
									return Object.freeze({
										...snapshot,
										value: Object.freeze({
											...snapshot.value,
											range: EditorSelection.cursor(wrongAnchor).main,
										}),
									});
								});
								cleanupFaults.push(() => { Reflect.set(cm, "scrollSnapshot", original); });
							break;
						}
						case "exact-scroll-epoch-advance":
							cm.scrollDOM.dispatchEvent(new Event("scroll"));
							break;
						default:
								break;
						}
					};
					Reflect.set(cm, "dispatch", faultingDispatch);
					cleanupFaults.push(() => { Reflect.set(cm, "dispatch", replayDispatch); });
				}
				let applied;
				try {
					applied = manager.applyExactHandoffReplay({
						plan: planned.plan,
						permit: permitted.permit,
						record: pending.record,
						recoveryOperationEpoch: request.recoveryOperationEpoch,
					});
				} finally {
					for (const cleanup of cleanupFaults.reverse()) cleanup();
				}
				applyKind = applied.kind;
				applyReason = "reason" in applied ? applied.reason : null;
				if (applied.kind !== "applied") {
					throw new Error(
						`public exact replay failed: ${applied.kind}/${applyReason ?? "none"}`,
					);
				}
				const localReceipt =
					controller.createExactHandoffReplayDispatchReceipt({
						plan: planned.plan,
						record: pending.record,
						recoveryOperationEpoch: request.recoveryOperationEpoch,
						postcondition: applied.postcondition,
						appliedAt: Date.now(),
					});
				if (localReceipt === null) {
					throw new Error("actual controller did not create a local replay receipt");
				}
				const localReceiptHash = await hashHandoffRecoveryDispatchReceipt(
					localReceipt as unknown as Readonly<
						Record<string, string | number | boolean | null>
					>,
				);
				localDispatchReceiptCreated = localReceiptHash.length === 64
					&& !JSON.stringify(localReceipt).includes(baseContent)
					&& !JSON.stringify(localReceipt).includes(resultContent);
				if (!request.deliver({
					type: "intent-state-changed",
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
					intentState: {
						kind: "replayed-awaiting-settlement",
						intentId: stored.intentId,
						recordId: stored.recordId,
					},
				})) {
					throw new Error("replayed settlement reducer delivery was rejected");
				}
				const settlementCapture =
					manager.captureHandoffReplaySettlementSnapshot({
						targetPath,
						planId: planned.plan.planId,
						mode: "live",
					});
				if (settlementCapture.kind !== "ready") {
					throw new Error(
						`actual settlement snapshot unavailable: ${settlementCapture.reason}`,
					);
				}
				settlementSnapshotReady = settlementCapture.kind === "ready"
					&& settlementCapture.snapshot.planId === planned.plan.planId
					&& settlementCapture.snapshot.cmDocument.toString()
						=== resultContent
					&& settlementCapture.snapshot.ytextContent === resultContent;
				if (!request.deliver({
					type: "intent-state-changed",
					sessionId: request.sessionId,
					expectedGeneration: request.expectedGeneration,
					recoveryOperationEpoch: request.recoveryOperationEpoch,
					intentState: {
						kind: "resolved",
						intentId: stored.intentId,
						recordId: stored.recordId,
					},
				})) {
					throw new Error("resolved reducer delivery was rejected");
				}
			} catch (error) {
				classifierError = errorMessage(error);
				throw error;
			}
			return "claimed";
		},
	});
	manager = new EditorBindingManager(
		vaultSync,
		false,
		(path) => path.endsWith(".md"),
		(_source, message, details) => {
			const scalarDetails = details
				? Object.fromEntries(
					Object.entries(details).filter(([, value]) =>
						value === null
						|| typeof value === "string"
						|| typeof value === "number"
						|| typeof value === "boolean"
					),
				)
				: {};
			traceStages.push(
				Object.keys(scalarDetails).length > 0
					? `${message}:${JSON.stringify(scalarDetails)}`
					: message,
			);
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		controllerPort,
		coordinator,
		undefined,
		undefined,
		undefined,
		(token) => {
			targetPresentationReadyNotificationCount += 1;
			targetPresentationReadyNotified = token.targetPath === targetPath
				&& token.targetFile === targetFile
				&& manager.getManagedSession(view)?.handoff?.presentation
					=== "target-proven";
			targetPresentationReadyBeforeBinding = manager.getBinding(view) === null;
		},
	);

	const parent = document.createElement("div");
	document.body.appendChild(parent);
	let hostData = "";
	let facadeContentOverride: string | null = null;
	const leaf = {
		id: `public-leaf-${suffix}`,
		workspace: {
			activeLeaf: null as unknown,
			iterateAllLeaves(callback: (leaf: Readonly<{ view: MarkdownView }>) => void) {
				callback({ view });
			},
		},
	};
	view = new MarkdownView();
	const requestSave = Object.assign(() => {}, { cancel() {} });
	Object.defineProperties(view, {
		file: {
			configurable: true,
			enumerable: true,
			value: sourceFile,
			writable: true,
		},
		leaf: {
			configurable: true,
			enumerable: true,
			value: leaf,
			writable: true,
		},
		containerEl: {
			configurable: true,
			value: parent,
		},
		editor: {
			configurable: true,
			value: {
				getValue: () => facadeContentOverride
					?? cm.state.doc.toString(),
			},
		},
		data: {
			configurable: true,
			enumerable: true,
			value: hostData,
			writable: true,
		},
		lastSavedData: {
			configurable: true,
			enumerable: true,
			value: hostData,
			writable: true,
		},
		dirty: {
			configurable: true,
			enumerable: true,
			value: false,
			writable: true,
		},
		getViewData: {
			configurable: true,
			value() {
				return hostData;
			},
		},
		onUnloadFile: {
			configurable: true,
			writable: true,
			async value(_file: TFile) {
				await Promise.resolve((this as MarkdownView & {
					save(clear: boolean): unknown;
				}).save(true));
			},
		},
		onLoadFile: {
			configurable: true,
			writable: true,
			async value(_file: TFile) {
				(this as MarkdownView & {
					setViewData(data: string, clear: boolean): void;
				}).setViewData(baseContent, true);
				await Promise.resolve();
			},
		},
		setViewData: {
			configurable: true,
			writable: true,
			value(data: string, _clear: boolean) {
				hostData = data;
				(this as MarkdownView & { data: string }).data = data;
				(this as MarkdownView & { lastSavedData: string | null }).lastSavedData = data;
				cm.dispatch({
					changes: {
						from: 0,
						to: cm.state.doc.length,
						insert: data,
					},
					selection: EditorSelection.cursor(data.length),
					scrollIntoView: true,
					annotations: Transaction.addToHistory.of(false),
				});
			},
		},
		requestSave: {
			configurable: true,
			writable: true,
			value: requestSave,
		},
		save: {
			configurable: true,
			writable: true,
			value(clear?: boolean) {
				(this as MarkdownView & { dirty: boolean }).dirty = false;
				if (clear !== true) return;
				hostData = "";
				(this as MarkdownView & { data: string }).data = "";
				(this as MarkdownView & { lastSavedData: string | null }).lastSavedData = null;
			},
		},
	});
	leaf.workspace.activeLeaf = leaf;
	cm = new EditorView({
		parent,
		state: EditorState.create({
			doc: "",
			selection: EditorSelection.cursor(0),
			extensions: [
				history(),
				manager.getBaseExtension(),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					hostData = update.state.doc.toString();
					(view as MarkdownView & { data: string }).data = hostData;
				}),
			],
		}),
	});

	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	manager.manageView(view);
	await (view as MarkdownView & {
		onLoadFile(file: TFile): Promise<void>;
	}).onLoadFile(sourceFile);
	// Mirror EditorWorkspaceOrchestrator: host presentation establishes the
	// exact same-path lineage, then a workspace bind wake performs admission.
	manager.bind(view, settings.deviceName);
	try {
		await waitFor(
			() => manager.getBinding(view)?.path === sourcePath,
			"initial public source binding",
		);
	} catch (error) {
		const session = manager.getManagedSession(view);
		const authority = manager.capturePathEditorAuthority(sourcePath);
		const managedRuntime = session
			? (Reflect.get(manager, "managedSessions") as Map<string, Readonly<{
				cmGuard: Readonly<{ snapshot(): Readonly<{
					inert: boolean;
					gateClosed: boolean;
					nativeHistoryEpoch: number;
					selectionEpoch: number;
					scrollEpoch: number;
				}> }> | null;
				targetWorkflow: Readonly<{
					targetPresentationReceipt: Readonly<{
						hostLoadCompletionReceipt: Readonly<{
							receiptId: string;
							nativeHistoryEpoch: number;
							targetSelectionEpoch: number;
							targetScrollEpoch: number;
						}>;
						replacementTargetReadyToken: Readonly<{
							tokenId: string;
							nativeHistoryEpoch: number;
							targetSelectionEpoch: number;
							targetScrollEpoch: number;
							certifiedBaseContent: string;
						}>;
					}> | null;
					targetReadyToken: Readonly<{
						tokenId: string;
						nativeHistoryEpoch: number;
						targetSelectionEpoch: number;
						targetScrollEpoch: number;
						certifiedBaseContent: string;
					}> | null;
				}> | null;
			}>>).get(session.leafId)
			: null;
		const workflow = managedRuntime?.targetWorkflow ?? null;
		const guard = managedRuntime?.cmGuard?.snapshot() ?? null;
		const receipt = workflow?.targetPresentationReceipt ?? null;
		const token = workflow?.targetReadyToken ?? null;
		throw new Error(JSON.stringify({
			error: errorMessage(error),
			bindingPath: manager.getBinding(view)?.path ?? null,
			sessionHandoff: session?.handoff?.phase ?? null,
			displayed:
				session?.displayedLineage.kind === "known"
					? session.displayedLineage.path
					: null,
			bindingState: session?.binding.kind ?? null,
			authorityKind: authority.kind,
			authorityReason: authority.kind === "blocked" ? authority.reason : null,
			bindInputs: {
				cmLength: cm.state.doc.length,
				editorLength: view.editor.getValue().length,
				dataLength: (view as MarkdownView & { data: string }).data.length,
				viewDataLength: (view as MarkdownView & {
					getViewData(): string;
				}).getViewData().length,
				ytextLength: sourceYtext.length,
				sessionNativeHistoryEpoch: session?.nativeHistoryEpoch ?? null,
				bindingEpoch: session
					? (Reflect.get(manager, "bindingEpochByLeafId") as Map<string, number>)
						.get(session.leafId) ?? 0
					: null,
				guard: guard
					? {
						inert: guard.inert,
						gateClosed: guard.gateClosed,
						nativeHistoryEpoch: guard.nativeHistoryEpoch,
						selectionEpoch: guard.selectionEpoch,
						scrollEpoch: guard.scrollEpoch,
					}
					: null,
				token: token
					? {
						tokenId: token.tokenId,
						nativeHistoryEpoch: token.nativeHistoryEpoch,
						targetSelectionEpoch: token.targetSelectionEpoch,
						targetScrollEpoch: token.targetScrollEpoch,
						certifiedLength: token.certifiedBaseContent.length,
					}
					: null,
				receipt: receipt
					? {
						replacementIsToken:
							receipt.replacementTargetReadyToken === token,
						receiptId: receipt.hostLoadCompletionReceipt.receiptId,
						nativeHistoryEpoch:
							receipt.hostLoadCompletionReceipt.nativeHistoryEpoch,
						targetSelectionEpoch:
							receipt.hostLoadCompletionReceipt.targetSelectionEpoch,
						targetScrollEpoch:
							receipt.hostLoadCompletionReceipt.targetScrollEpoch,
					}
					: null,
			},
			observer: {
				present: Reflect.get(cm as unknown as object, "observer") != null,
				forceFlush: typeof Reflect.get(
					Reflect.get(cm as unknown as object, "observer") as object,
					"forceFlush",
				),
				pendingRecords: typeof Reflect.get(
					Reflect.get(cm as unknown as object, "observer") as object,
					"pendingRecords",
				),
			},
			traceStages,
		}));
	}
	const initialPublicBinding = manager.getBinding(view)?.path === sourcePath;
	await (view as MarkdownView & {
		onUnloadFile(file: TFile): Promise<void>;
	}).onUnloadFile(sourceFile);
	(view as MarkdownView & { file: TFile }).file = targetFile;
	const loadPromise = (view as MarkdownView & {
		onLoadFile(file: TFile): Promise<void>;
	}).onLoadFile(targetFile);
	await waitFor(
		() => presentationReady && releasePresentation !== null,
		"actual controller presentation plan",
	);

	const inputInsertionAnchor = cm.scrollSnapshot().value.range.head;
	resultContent = baseContent.slice(0, inputInsertionAnchor)
		+ inserted
		+ baseContent.slice(inputInsertionAnchor);
	cm.contentDOM.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		data: inserted,
		inputType: "insertText",
	}));
	cm.dispatch({
		changes: { from: inputInsertionAnchor, insert: inserted },
		selection: EditorSelection.cursor(
			inputInsertionAnchor + inserted.length,
		),
		annotations: Transaction.userEvent.of("input.type"),
	});
	try {
		await waitFor(() => classifierStarted, "stored replay classifier");
	} catch (error) {
		const session = manager.getManagedSession(view);
		const runtime = session
			? (Reflect.get(manager, "managedSessions") as Map<string, Readonly<{
				cmGuard: Readonly<{ snapshot(): Readonly<{
					inputEpoch: number;
					gateFailureReason: string | null;
					commitState: string;
				}> }> | null;
			}>>).get(session.leafId)
			: null;
		const guard = runtime?.cmGuard?.snapshot() ?? null;
		let storeDiagnostic: Readonly<{
			status: string;
			issues: readonly string[];
			activeStatuses: readonly string[];
			terminalStatuses: readonly string[];
		}>;
		try {
			const hydration = await store.hydrateScope();
			storeDiagnostic = Object.freeze({
				status: hydration.status,
				issues: Object.freeze(hydration.issues.map((issue) => issue.kind)),
				activeStatuses: Object.freeze(
					hydration.active.map((record) => record.status),
				),
				terminalStatuses: Object.freeze(
					hydration.terminal.map((record) => record.status),
				),
			});
		} catch (hydrateError) {
			storeDiagnostic = Object.freeze({
				status: `hydrate-error:${errorMessage(hydrateError)}`,
				issues: Object.freeze([]),
				activeStatuses: Object.freeze([]),
				terminalStatuses: Object.freeze([]),
			});
		}
		throw new Error(JSON.stringify({
			error: errorMessage(error),
			handoffPhase: session?.handoff?.phase ?? null,
			intentStateKind: session?.handoff?.intentState.kind ?? null,
			activeRecoveriesCount: session?.activeRecoveries.length ?? null,
			guard: guard
				? {
					inputEpoch: guard.inputEpoch,
					gateFailureReason: guard.gateFailureReason,
					commitState: guard.commitState,
				}
				: null,
			lengths: {
				cm: cm.state.doc.length,
				sourceYtext: sourceYtext.length,
				targetYtext: targetYtext?.length ?? null,
			},
			traceStages,
			store: storeDiagnostic,
		}));
	}
	const inputWasQuarantinedBeforePresentation =
		cm.state.doc.toString() === baseContent
		&& sourceYtext.toString() === baseContent;
	const release = releasePresentation;
	if (!release) throw new Error("presentation release capability disappeared");
	release();
	await loadPromise;
	await waitFor(
		() => applyKind !== null || classifierError !== null,
		"public exact replay dispatch",
		480,
	);

	const contentBeforeReplayUndo = cm.state.doc.toString();
	undo(cm);
	await Promise.resolve();
	const contentAfterReplayUndo = cm.state.doc.toString();
	redo(cm);
	await Promise.resolve();
	const contentAfterReplayRedo = cm.state.doc.toString();
	const finalBindingPath = manager.getBinding(view)?.path ?? null;
	const finalHandoffCleared = manager.getManagedSession(view)?.handoff === null;
	const result: PublicHandoffReplayResult = Object.freeze({
		seedMissingTarget,
		initialPublicBinding,
		recoveryBindingRequested,
		actualControllerPlan,
		actualControllerPermit,
		actualControllerRedemption,
		applyKind,
		applyReason,
		cmContent: cm.state.doc.toString(),
		targetYtextContent: targetYtext?.toString() ?? null,
		sourceYtextContent: sourceYtext.toString(),
		sourceYtextObserverUpdateCount,
		sourceYtextStructureUnchanged: sameYTextItemWitness(
			sourceYtextStructureBefore,
			captureYTextItemWitness(sourceYtext),
		),
		contentBeforeReplayUndo,
		contentAfterReplayUndo,
		contentAfterReplayRedo,
		inputWasQuarantinedBeforePresentation,
		providerAbaBeforeRecoveryBind,
		recoveryTokenReplacedAfterPresentation,
		recoveryTokenIssuedAfterProviderAba,
		targetPresentationReadyNotified,
		targetPresentationReadyBeforeBinding,
		targetPresentationReadyNotificationCount,
		scrollAnchorNonNull,
		mappedScrollAnchorExact,
		mappedScrollEffectAnchorExact,
		localDispatchReceiptCreated,
		settlementSnapshotReady,
		finalBindingPath,
		finalHandoffCleared,
		classifierError,
		traceContentFree: !traceStages.join("\n").includes("public B line")
			&& !traceStages.join("\n").includes(inserted),
		traceStages: Object.freeze([...traceStages]),
	});
	sourceYtext.unobserve(sourceYtextObserver);
	manager.unbindAll();
	controller.revokeAsyncAuthority();
	cm.destroy();
	awareness.destroy();
	ydoc.destroy();
	parent.remove();
	return result;
}
