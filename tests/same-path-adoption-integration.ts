import assert from "node:assert/strict";
import {
	EditorSelection,
	EditorState,
	Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import {
	history,
	isolateHistory,
	redo,
	undo,
	undoDepth,
} from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import {
	EditorBindingManager,
	type EditorAuthorityControllerPort,
} from "../src/sync/editorBinding";
import { ORIGIN_SAME_PATH_ADOPTION } from "../src/sync/origins";
import {
	buildSamePathAdoptionChangeSet,
	planSamePathAdoption,
} from "../src/runtime/reconcile/samePathAdoptionPlanner";
import type {
	SamePathAdoptionBindContext,
	SamePathAdoptionBindPermit,
	SamePathAdoptionBindReceipt,
	SamePathAdoptionMutationContext,
	SamePathAdoptionMutationPermit,
	SamePathAdoptionProposal,
	SamePathAdoptionRequest,
} from "../src/sync/samePathAdoption";
import type { VaultSync } from "../src/sync/vaultSync";

type MutableFile = TFile & {
	path: string;
	stat: { ctime: number; mtime: number; size: number };
};

type FakeCm = EditorView & {
	state: EditorState;
	dispatched: Transaction[];
	failAdoptionDispatch: boolean;
	scrollAnchor: number;
};

interface FixtureOptions {
	base: string;
	local: string;
	remote: string;
	selection?: number;
	bindRejected?: boolean;
	providerAdvanceAfterPermit?: string;
	failAdoptionDispatch?: boolean;
	historyStart?: string;
	forceAdoption?: boolean;
	conflictResult?: "preserved" | "preservation-failed";
	deferFirstPlan?: boolean;
	identicalPeerWithStaleRequiredMarker?: boolean;
}

function makeFile(path: string, content: string): MutableFile {
	return Object.assign(new TFile(), {
		path,
		stat: { ctime: 1, mtime: 1, size: content.length },
	}) as MutableFile;
}

function isTransaction(value: Transaction | TransactionSpec): value is Transaction {
	return typeof value === "object"
		&& value !== null
		&& "startState" in value
		&& "newDoc" in value;
}

async function flushPlanningTurn(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeFixture(options: FixtureOptions) {
	const path = "Notes/live-adoption-integration.md";
	const file = makeFile(path, options.local);
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("same-path");
	ytext.insert(0, options.remote);
	const awareness = new Awareness(ydoc);
	const traces: Array<{ msg: string; details?: Record<string, unknown> }> = [];
	const origins: unknown[] = [];
	const yTransactions: Y.Transaction[] = [];
	ydoc.on("afterTransaction", (transaction: Y.Transaction) => {
		if (transaction.changed.has(ytext)) {
			origins.push(transaction.origin);
			yTransactions.push(transaction);
		}
	});

	let manager: EditorBindingManager;
	let requestCount = 0;
	let mutationConsumed = false;
	let bindConsumed = false;
	let boundReceipt: SamePathAdoptionBindReceipt | null = null;
	let firstRequest: SamePathAdoptionRequest | null = null;
	let firstProposal: SamePathAdoptionProposal | null = null;
	let releaseFirstPlanGate!: () => void;
	const firstPlanGate = new Promise<void>((resolve) => {
		releaseFirstPlanGate = resolve;
	});
	const mutationPermit = Object.freeze({
		permitId: "integration-mutation-permit",
		kind: "same-path-adoption-mutation",
	}) as SamePathAdoptionMutationPermit;
	const bindPermit = Object.freeze({
		permitId: "integration-bind-permit",
		kind: "same-path-adoption-bind",
	}) as SamePathAdoptionBindPermit;

	const port: Partial<EditorAuthorityControllerPort> = {
		requestSamePathAdoption(request) {
			requestCount += 1;
			if (requestCount > 1) return new Promise(() => {});
			firstRequest = request;
			if (options.conflictResult) {
				const status = options.conflictResult === "preserved"
					? "preserved" as const
					: "preservation-failed" as const;
				const receipt = Object.freeze({
					receiptId: "integration-conflict-receipt",
					adoptionId: request.adoptionId,
					path,
					status,
					retryable: status === "preservation-failed",
					mergeMode: "three-way" as const,
					baseHash: "integration-base-hash",
					crdtArtifactPath: "Notes/live-adoption-integration KAOS conflict - crdt.md",
					editorArtifactPath:
						"Notes/live-adoption-integration KAOS conflict - editor.md",
					editorArtifactPaths: Object.freeze([
						"Notes/live-adoption-integration KAOS conflict - editor.md",
					]),
					editorArtifacts: Object.freeze([Object.freeze({
						path: "Notes/live-adoption-integration KAOS conflict - editor.md",
						contentHash: "integration-local-hash",
						leafIds: Object.freeze([request.leafId]),
					})]),
					failureReason: status === "preservation-failed"
						? "artifact-preservation-failed"
						: null,
				});
				return Promise.resolve(status === "preserved"
					? Object.freeze({ kind: "conflict-preserved" as const, receipt })
					: Object.freeze({
						kind: "conflict-preservation-failed" as const,
						reason: "artifact-preservation-failed" as const,
						receipt,
					}));
			}
			const plan = Object.freeze(planSamePathAdoption({
				baselineText: options.base,
				localText: options.local,
				remoteText: options.remote,
			}));
			const proposal = Object.freeze({
				proposalId: "integration-proposal",
				planId: "integration-plan",
				authorityFreshnessHandleId: "integration-freshness",
				request,
				adoptionId: request.adoptionId,
				path,
				file,
				baselineHash: "integration-base-hash",
				baselineRevision: 1,
				baselineText: options.base,
				diskFile: file,
				diskStat: Object.freeze({ ctime: 1, mtime: 1, size: options.local.length }),
				diskContent: options.local,
				diskContentHash: "integration-disk-hash",
				localText: options.local,
				remoteText: options.remote,
				activeAuthority: Object.freeze({
					activeFileIds: Object.freeze(["integration-file"]),
					activeSetEpoch: 1,
					fileId: "integration-file",
					ytext,
					ytextIdentity: "integration-ytext",
					ytextMutationEpoch: 0,
					ytextContent: options.remote,
				}),
				fileId: "integration-file",
				ytext,
				ytextIdentity: "integration-ytext",
				ytextMutationEpoch: 0,
				providerInstance: null,
				editorAuthorityLease: request.editorAuthority.kind === "proven-single"
					? request.editorAuthority.lease
					: (() => { throw new Error("Expected single editor authority"); })(),
				hostCapability: request.hostCapability,
				hostSaveEpoch: request.hostSaveEpoch,
				lifecycleGeneration: 1,
				attentionGeneration: 0,
				syncScopeGeneration: 1,
				plan,
				mutationPermit,
				bindPermit,
			}) satisfies SamePathAdoptionProposal;
			firstProposal = proposal;
			const result = Object.freeze({ kind: "planned" as const, proposal });
			return options.deferFirstPlan
				? firstPlanGate.then(() => result)
				: Promise.resolve(result);
		},
		consumeSamePathAdoptionMutationPermit(
			permit: SamePathAdoptionMutationPermit,
			context: SamePathAdoptionMutationContext,
		) {
			if (
				mutationConsumed
				|| permit !== mutationPermit
				|| context.proposal !== firstProposal
				|| context.request !== firstRequest
				|| !manager.isSamePathAdoptionRequestCurrent(context.request)
			) return false;
			mutationConsumed = true;
			if (options.providerAdvanceAfterPermit) {
				ydoc.transact(() => {
					ytext.insert(ytext.length, options.providerAdvanceAfterPermit);
				}, Object.freeze({ provider: true }));
			}
			return true;
		},
		consumeSamePathAdoptionBindPermit(
			permit: SamePathAdoptionBindPermit,
			context: SamePathAdoptionBindContext,
		) {
			if (
				bindConsumed
				|| permit !== bindPermit
				|| context.proposal !== firstProposal
				|| options.bindRejected
				|| !manager.isSamePathAdoptionBindContextCurrent(context)
			) return false;
			bindConsumed = true;
			return true;
		},
		noteSamePathAdoptionBound(receipt) {
			boundReceipt = receipt;
		},
	};

	const vaultSync = {
		ydoc,
		provider: { awareness },
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getFileId: (candidate: string) =>
			candidate === path ? "integration-file" : undefined,
		getFileIdForText: (candidate: Y.Text) =>
			candidate === ytext ? "integration-file" : undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
	} as unknown as VaultSync;
	manager = new EditorBindingManager(
		vaultSync,
		false,
		(candidate) => candidate === path,
		(_source, msg, details) => traces.push({ msg, details }),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		port as EditorAuthorityControllerPort,
	);

	let state = EditorState.create({
		doc: options.historyStart ?? options.local,
		selection: EditorSelection.cursor(
			options.selection ?? (options.historyStart ?? options.local).length,
		),
		extensions: [history(), manager.getBaseExtension()],
	});
	if (options.historyStart !== undefined && options.historyStart !== options.local) {
		state = state.update({
			changes: buildSamePathAdoptionChangeSet(options.historyStart, options.local),
			selection: EditorSelection.cursor(options.selection ?? options.local.length),
			annotations: Transaction.userEvent.of("input.type"),
		}).state;
	}
	let nativeHistoryEpoch = 0;
	let selectionEpoch = 0;
	let inputEpoch = 0;
	let compositionEpoch = 0;
	let hostSaveEpoch = 0;
	let hostMode: { kind: "pass-through" | "blocking-handoff" } = {
		kind: "pass-through",
	};
	let activeComposition: { compositionEpoch: number } | null = null;
	let directStateAssignments = 0;
	let nativeHistoryAdvanceAccepted = false;
	const cm = {
		get state() { return state; },
		set state(next: EditorState) {
			directStateAssignments += 1;
			state = next;
		},
		dispatched: [] as Transaction[],
		failAdoptionDispatch: options.failAdoptionDispatch === true,
		scrollAnchor: options.selection ?? options.local.length,
		dom: { isConnected: true },
		scrollSnapshot() {
			return EditorView.scrollIntoView(this.scrollAnchor);
		},
		dispatch(input: Transaction | TransactionSpec) {
			const transaction = isTransaction(input) ? input : state.update(input);
			const adoptionProjection = transaction.docChanged
				&& transaction.annotation(Transaction.addToHistory) === false
				&& transaction.annotation(isolateHistory) === "full";
			if (adoptionProjection && this.failAdoptionDispatch) {
				throw new Error("injected adoption dispatch failure");
			}
			const previousSelection = state.selection;
			state = transaction.state;
			this.dispatched.push(transaction);
			const nativeHistoryEpochBefore = nativeHistoryEpoch;
			if (transaction.docChanged) nativeHistoryEpoch += 1;
			if (!previousSelection.eq(state.selection)) selectionEpoch += 1;
			if (transaction.docChanged) {
				this.scrollAnchor = transaction.changes.mapPos(this.scrollAnchor, -1);
			}
			(manager as unknown as { handleLiveEditorUpdate(update: unknown): void })
				.handleLiveEditorUpdate({
					view: cm,
					state,
					transactions: [transaction],
					docChanged: transaction.docChanged,
					selectionSet: !previousSelection.eq(state.selection),
					viewportChanged: false,
					geometryChanged: false,
					focusChanged: false,
				});
			if (transaction.docChanged) {
				nativeHistoryAdvanceAccepted = (
					manager as unknown as {
						acceptStableNativeHistoryAdvance?(input: Readonly<{
							cm: EditorView;
							startState: EditorState;
							finalState: EditorState;
							nativeHistoryEpochBefore: number;
							nativeHistoryEpochAfter: number;
						}>): boolean;
					}
				).acceptStableNativeHistoryAdvance?.({
					cm,
					startState: transaction.startState,
					finalState: transaction.state,
					nativeHistoryEpochBefore,
					nativeHistoryEpochAfter: nativeHistoryEpoch,
				}) ?? false;
			}
		},
	} as unknown as FakeCm;
	const view = Object.assign(new MarkdownView(), {
		file,
		leaf: { id: "integration-leaf" },
		containerEl: { contains: (candidate: unknown) => candidate === cm.dom },
		data: options.local,
		editor: { getValue: () => cm.state.doc.toString() },
		getViewData: () => cm.state.doc.toString(),
	}) as MarkdownView & {
		file: TFile;
		leaf: { id: string };
		data: string;
	};
	let workspaceViews: MarkdownView[] = [view];
	const workspace = {
		iterateAllLeaves(callback: (leaf: { view: MarkdownView }) => void) {
			for (const workspaceView of workspaceViews) callback({ view: workspaceView });
		},
	};
	Object.assign(view, {
		app: {
			workspace,
		},
	});
	let liveCm: EditorView = cm;
	const cmByView = new Map<MarkdownView, EditorView>([[view, cm]]);
	(manager as unknown as { getCmView(view: MarkdownView): EditorView | null }).getCmView =
		(candidate) => candidate === view ? liveCm : cmByView.get(candidate) ?? null;
	manager.manageView(view);
	if (options.forceAdoption) {
		(manager as unknown as {
			samePathAdoptionRequiredPathByLeafId: Map<string, string>;
		}).samePathAdoptionRequiredPathByLeafId.set(view.leaf.id, path);
	}
	const runtime = (manager as unknown as {
		managedSessions: Map<string, {
			hostGuard: unknown;
			cmGuard: unknown;
			adoption: { kind: string };
		}>;
	}).managedSessions.get(view.leaf.id);
	if (!runtime) throw new Error("Expected managed integration runtime");
	runtime.hostGuard = {
		snapshot: () => ({
			leafId: view.leaf.id,
			view,
			hostCapability: "owned-scheduler-with-unload-flush",
			hostCapabilityState: "ready",
			saveEpoch: hostSaveEpoch,
			clearLoadCapability: "observable",
			mode: hostMode,
			inFlight: new Map(),
			pendingTargetSave: false,
			pendingOwnedSave: null,
			sourceUnload: null,
		}),
		markInert: () => true,
		restoreIfCurrent: () => true,
	};
	runtime.cmGuard = {
		snapshot: () => ({
			view: cm,
			inert: false,
			gateClosed: false,
			inputEpoch,
			compositionEpoch,
			nativeHistoryEpoch,
			selectionEpoch,
			scrollEpoch: 0,
			activeComposition,
			lastComposition: null,
			gateFailureReason: null,
			commitState: "none",
			pendingHostLoadCandidate: null,
		}),
		refreshGate: () => true,
		markInert: () => true,
		restoreIfCurrent: () => true,
	};
	manager.manageView(view);

	let peerView: (MarkdownView & { file: TFile; leaf: { id: string } }) | null = null;
	let peerCm: FakeCm | null = null;
	if (options.identicalPeerWithStaleRequiredMarker) {
		let peerState = EditorState.create({
			doc: options.local,
			selection: EditorSelection.cursor(options.selection ?? options.local.length),
			extensions: [history(), manager.getBaseExtension()],
		});
		let peerNativeHistoryEpoch = 0;
		let peerSelectionEpoch = 0;
		const mutablePeerCm = {
			get state() { return peerState; },
			set state(next: EditorState) { peerState = next; },
			dispatched: [] as Transaction[],
			failAdoptionDispatch: false,
			scrollAnchor: options.selection ?? options.local.length,
			dom: { isConnected: true },
			scrollSnapshot() {
				return EditorView.scrollIntoView(this.scrollAnchor);
			},
			dispatch(input: Transaction | TransactionSpec) {
				const transaction = isTransaction(input) ? input : peerState.update(input);
				const previousSelection = peerState.selection;
				peerState = transaction.state;
				this.dispatched.push(transaction);
				if (transaction.docChanged) peerNativeHistoryEpoch += 1;
				if (!previousSelection.eq(peerState.selection)) peerSelectionEpoch += 1;
				if (transaction.docChanged) {
					this.scrollAnchor = transaction.changes.mapPos(this.scrollAnchor, -1);
				}
				(manager as unknown as { handleLiveEditorUpdate(update: unknown): void })
					.handleLiveEditorUpdate({
						view: mutablePeerCm,
						state: peerState,
						transactions: [transaction],
						docChanged: transaction.docChanged,
						selectionSet: !previousSelection.eq(peerState.selection),
						viewportChanged: false,
						geometryChanged: false,
						focusChanged: false,
					});
			},
		} as unknown as FakeCm;
		peerCm = mutablePeerCm;
		peerView = Object.assign(new MarkdownView(), {
			file,
			leaf: { id: "integration-peer" },
			containerEl: { contains: (candidate: unknown) => candidate === mutablePeerCm.dom },
			data: options.local,
			editor: { getValue: () => mutablePeerCm.state.doc.toString() },
			getViewData: () => mutablePeerCm.state.doc.toString(),
			app: { workspace },
		}) as MarkdownView & { file: TFile; leaf: { id: string } };
		workspaceViews = [view, peerView];
		cmByView.set(peerView, mutablePeerCm);
		manager.manageView(peerView);
		const peerRuntime = (manager as unknown as {
			managedSessions: Map<string, {
				hostGuard: unknown;
				cmGuard: unknown;
				adoption: { kind: string };
			}>;
		}).managedSessions.get(peerView.leaf.id);
		if (!peerRuntime) throw new Error("Expected managed peer integration runtime");
		peerRuntime.hostGuard = {
			snapshot: () => ({
				leafId: peerView?.leaf.id,
				view: peerView,
				hostCapability: "owned-scheduler-with-unload-flush",
				hostCapabilityState: "ready",
				saveEpoch: hostSaveEpoch,
				clearLoadCapability: "observable",
				mode: hostMode,
				inFlight: new Map(),
				pendingTargetSave: false,
				pendingOwnedSave: null,
				sourceUnload: null,
			}),
			markInert: () => true,
			restoreIfCurrent: () => true,
		};
		peerRuntime.cmGuard = {
			snapshot: () => ({
				view: mutablePeerCm,
				inert: false,
				gateClosed: false,
				inputEpoch: 0,
				compositionEpoch: 0,
				nativeHistoryEpoch: peerNativeHistoryEpoch,
				selectionEpoch: peerSelectionEpoch,
				scrollEpoch: 0,
				activeComposition: null,
				lastComposition: null,
				gateFailureReason: null,
				commitState: "none",
				pendingHostLoadCandidate: null,
			}),
			refreshGate: () => true,
			markInert: () => true,
			restoreIfCurrent: () => true,
		};
		manager.manageView(peerView);
		(manager as unknown as {
			samePathAdoptionRequiredPathByLeafId: Map<string, string>;
		}).samePathAdoptionRequiredPathByLeafId.set(peerView.leaf.id, path);
	}

	const start = () => {
		manager.bind(view, "integration-device");
	};
	const close = () => {
		manager.revokeAsyncAuthority();
		awareness.destroy();
		ydoc.destroy();
	};
	return {
		manager,
		view,
		cm,
		peerView,
		peerCm,
		ytext,
		origins,
		yTransactions,
		traces,
		start,
		close,
		requestCount: () => requestCount,
		mutationConsumed: () => mutationConsumed,
		bindConsumed: () => bindConsumed,
		boundReceipt: () => boundReceipt,
		adoptionState: () => runtime.adoption,
		directStateAssignments: () => directStateAssignments,
		nativeHistoryAdvanceAccepted: () => nativeHistoryAdvanceAccepted,
		releaseFirstPlan() {
			releaseFirstPlanGate();
		},
		advanceHostSaveEpoch() {
			hostSaveEpoch += 1;
		},
		setHostMode(kind: "pass-through" | "blocking-handoff") {
			hostMode = { kind };
		},
		replaceLiveCm(replacement: EditorView) {
			liveCm = replacement;
		},
		bindView(candidate: MarkdownView) {
			manager.bind(candidate, "integration-device");
		},
		bindPeerBeforePrimaryIsEnumeratedForTest() {
			if (!peerView) throw new Error("Expected an integration peer");
			const internals = manager as unknown as {
				managedSessions: Map<string, unknown>;
				advanceAuthorityEpoch(): void;
			};
			const primary = internals.managedSessions.get(view.leaf.id);
			if (!primary) throw new Error("Expected a primary integration runtime");
			internals.managedSessions.delete(view.leaf.id);
			workspaceViews = [peerView];
			try {
				manager.bind(peerView, "integration-device");
			} finally {
				internals.managedSessions.set(view.leaf.id, primary);
				workspaceViews = [view, peerView];
				internals.advanceAuthorityEpoch();
			}
		},
		setRequiredPathForLeaf(leafId: string, requiredPath: string | null) {
			const requiredPaths = (manager as unknown as {
				samePathAdoptionRequiredPathByLeafId: Map<string, string>;
			}).samePathAdoptionRequiredPathByLeafId;
			if (requiredPath === null) requiredPaths.delete(leafId);
			else requiredPaths.set(leafId, requiredPath);
		},
		requiredPathForLeaf(leafId: string) {
			return (manager as unknown as {
				samePathAdoptionRequiredPathByLeafId: Map<string, string>;
			}).samePathAdoptionRequiredPathByLeafId.get(leafId) ?? null;
		},
		bumpObservedYTextMutationRevision() {
			const revisions = (manager as unknown as {
				yTextMutationRevisionByText: WeakMap<Y.Text, number>;
			}).yTextMutationRevisionByText;
			revisions.set(ytext, (revisions.get(ytext) ?? 0) + 1);
		},
		setCompositionActive() {
			compositionEpoch += 1;
			activeComposition = { compositionEpoch };
		},
		dispatchLocal(text: string) {
			inputEpoch += 1;
			cm.dispatch(cm.state.update({
				changes: { from: cm.state.doc.length, insert: text },
				annotations: Transaction.userEvent.of("input.type"),
			}));
		},
	};
}

async function cleanOutcomeMatrix(): Promise<void> {
	const cases: Array<readonly [string, FixtureOptions, string, number, boolean]> = [
		[
			"already equal",
			{ base: "base", local: "same", remote: "same", forceAdoption: true },
			"same",
			0,
			true,
		],
		["Local only", { base: "base", local: "local", remote: "base" }, "local", 1, true],
		["Remote only", { base: "base", local: "base", remote: "remote" }, "remote", 0, true],
		[
			"clean merge",
			{
				base: "one\nkeep\nthree\n",
				local: "ONE\nkeep\nthree\n",
				remote: "one\nkeep\nTHREE\n",
			},
			"ONE\nkeep\nTHREE\n",
			1,
			true,
		],
	];
	for (const [name, options, expected, expectedYTransactions, adopted] of cases) {
		const fixture = makeFixture(options);
		fixture.start();
		await flushPlanningTurn();
		assert.equal(
			fixture.cm.state.doc.toString(),
			expected,
			`${name}: editor target traces=${JSON.stringify(fixture.traces)}`,
		);
		assert.equal(fixture.ytext.toJSON(), expected, `${name}: Y.Text target`);
		assert.ok(fixture.manager.getBinding(fixture.view), `${name}: yCollab binding published`);
		assert.equal(
			fixture.bindConsumed(),
			adopted,
			`${name}: post-mutation bind permit use matches the adoption lane`,
		);
		assert.equal(!!fixture.boundReceipt(), adopted, `${name}: adoption receipt publication`);
		assert.equal(
			fixture.origins.filter((origin) => origin === ORIGIN_SAME_PATH_ADOPTION).length,
			expectedYTransactions,
			`${name}: exact adoption Yjs transaction count`,
		);
		for (const transaction of fixture.yTransactions.filter(
			(candidate) => candidate.origin === ORIGIN_SAME_PATH_ADOPTION,
		)) {
			assert.equal(transaction.changed.size, 1, `${name}: one changed Yjs type`);
			assert.equal(transaction.changed.has(fixture.ytext), true);
		}
		assert.equal(
			fixture.directStateAssignments(),
			0,
			`${name}: adoption never replaces EditorView.state directly`,
		);
		assert.equal(
			fixture.cm.dispatched.some((transaction) =>
				transaction.docChanged
				&& transaction.annotation(Transaction.addToHistory) !== false
			),
			false,
			`${name}: projection is native-undo transparent`,
		);
		assert.ok(
			fixture.cm.state.facet(ySyncFacet),
			`${name}: the live state contains yCollab after equality`,
		);
		const receipt = fixture.boundReceipt();
		assert.ok(receipt);
		assert.equal(
			fixture.manager.isSamePathAdoptionProjectionHeld(receipt.path),
			true,
			`${name}: projection remains held until verified disk settlement`,
		);
		assert.equal(
			fixture.manager.completeSamePathAdoptionDiskSettlement(
				receipt,
				expected,
			),
			true,
			`${name}: exact settlement receipt clears adoption`,
		);
		assert.equal(
			fixture.manager.isSamePathAdoptionProjectionHeld(receipt.path),
			false,
		);
		fixture.close();
	}
}

async function identicalCompositeProjectionClearsPeerReplanMarker(): Promise<void> {
	const fixture = makeFixture({
		base: "one\nkeep\nthree\n",
		local: "ONE\nkeep\nthree\n",
		remote: "one\nkeep\nTHREE\n",
		identicalPeerWithStaleRequiredMarker: true,
	});
	assert.ok(fixture.peerView);
	assert.ok(fixture.peerCm);
	assert.equal(
		fixture.requiredPathForLeaf(fixture.peerView.leaf.id),
		"Notes/live-adoption-integration.md",
		"the fixture reproduces a stale pre-commit peer replan marker",
	);

	fixture.start();
	await flushPlanningTurn();
	await flushPlanningTurn();

	const target = "ONE\nkeep\nTHREE\n";
	assert.equal(fixture.requestCount(), 1, "one pane coordinates the exact merge");
	assert.equal(fixture.ytext.toJSON(), target);
	assert.equal(fixture.cm.state.doc.toString(), target);
	assert.equal(fixture.peerCm.state.doc.toString(), target);
	assert.ok(fixture.manager.getBinding(fixture.view), "the coordinator is bound");
	assert.ok(fixture.manager.getBinding(fixture.peerView), "the projected peer binds normally");
	assert.equal(
		fixture.requiredPathForLeaf(fixture.peerView.leaf.id),
		null,
		"the accepted composite proof supersedes the peer's stale replan marker",
	);
	fixture.close();
}

async function pathHeldCoordinatorBlocksPeerOrdinaryBind(): Promise<void> {
	const fixture = makeFixture({
		base: "same",
		local: "same",
		remote: "same",
		identicalPeerWithStaleRequiredMarker: true,
	});
	assert.ok(fixture.peerView);
	assert.ok(fixture.peerCm);
	const path = "Notes/live-adoption-integration.md";
	fixture.setRequiredPathForLeaf(fixture.peerView.leaf.id, null);
	fixture.setRequiredPathForLeaf(fixture.view.leaf.id, path);

	fixture.bindView(fixture.peerView);
	assert.equal(
		fixture.manager.getBinding(fixture.peerView),
		null,
		"a peer cannot publish ordinary binding while the path coordinator owns a replan hold",
	);

	await flushPlanningTurn();
	await flushPlanningTurn();
	assert.equal(fixture.requestCount(), 1, "the canonical pane coordinates the held path");
	assert.ok(fixture.manager.getBinding(fixture.view));
	assert.ok(fixture.manager.getBinding(fixture.peerView));
	assert.equal(fixture.requiredPathForLeaf(fixture.view.leaf.id), null);
	fixture.close();
}

async function initialMultiPaneBindingWaitsForCanonicalPane(): Promise<void> {
	const fixture = makeFixture({
		base: "same",
		local: "same",
		remote: "same",
		identicalPeerWithStaleRequiredMarker: true,
	});
	assert.ok(fixture.peerView);
	fixture.setRequiredPathForLeaf(fixture.peerView.leaf.id, null);

	fixture.bindView(fixture.peerView);
	assert.equal(
		fixture.manager.getBinding(fixture.peerView),
		null,
		"the first non-canonical pane cannot publish path authority independently",
	);

	await flushPlanningTurn();
	await flushPlanningTurn();
	assert.ok(fixture.manager.getBinding(fixture.view), "the canonical pane binds first");
	assert.ok(fixture.manager.getBinding(fixture.peerView), "the peer follows settled authority");
	assert.equal(fixture.requestCount(), 0, "already-equal panes need no merge proposal");
	fixture.close();
}

async function alreadySettledPlanAdmitsAnExactBoundPeer(): Promise<void> {
	const fixture = makeFixture({
		base: "same",
		local: "same",
		remote: "same",
		identicalPeerWithStaleRequiredMarker: true,
	});
	assert.ok(fixture.peerView);
	const path = "Notes/live-adoption-integration.md";
	fixture.setRequiredPathForLeaf(fixture.peerView.leaf.id, null);
	fixture.bindPeerBeforePrimaryIsEnumeratedForTest();
	assert.ok(fixture.manager.getBinding(fixture.peerView), "the early exact peer is bound");
	fixture.setRequiredPathForLeaf(fixture.view.leaf.id, path);
	fixture.bindView(fixture.view);
	await flushPlanningTurn();
	await flushPlanningTurn();

	assert.equal(fixture.requestCount(), 1);
	assert.ok(
		fixture.manager.getBinding(fixture.view),
		"an already-settled proof admits the remaining exact pane",
	);
	assert.ok(fixture.manager.getBinding(fixture.peerView));
	assert.equal(fixture.requiredPathForLeaf(fixture.view.leaf.id), null);
	fixture.close();
}

async function staleInputsMutateNothing(): Promise<void> {
	const provider = makeFixture({
		base: "base",
		local: "local",
		remote: "base",
		providerAdvanceAfterPermit: "+provider",
	});
	provider.start();
	await flushPlanningTurn();
	assert.equal(provider.cm.state.doc.toString(), "local");
	assert.equal(provider.ytext.toJSON(), "base+provider");
	assert.equal(!!provider.manager.getBinding(provider.view), false);
	assert.equal(provider.bindConsumed(), false);
	provider.close();

	const local = makeFixture({ base: "base", local: "local", remote: "base" });
	local.start();
	local.dispatchLocal("+newer");
	await flushPlanningTurn();
	assert.equal(local.cm.state.doc.toString(), "local+newer");
	assert.equal(local.ytext.toJSON(), "base");
	assert.equal(local.mutationConsumed(), false);
	assert.equal(!!local.manager.getBinding(local.view), false);
	local.close();
}

async function localEditDuringPlanningKeepsProjectionHeld(): Promise<void> {
	const fixture = makeFixture({
		base: "one\nkeep\nthree\n",
		local: "one\nkeep\nthree\n",
		remote: "ONE\nkeep\nthree\n",
		deferFirstPlan: true,
	});
	fixture.start();
	await Promise.resolve();
	assert.equal(fixture.requestCount(), 1, "the first adoption plan is in flight");
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(
			"Notes/live-adoption-integration.md",
		),
		true,
		"the in-flight plan holds disk projection",
	);

	fixture.dispatchLocal("l");
	assert.equal(
		fixture.nativeHistoryAdvanceAccepted(),
		true,
		"the exact stable same-CM input advances the managed session history epoch",
	);
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(
			"Notes/live-adoption-integration.md",
		),
		true,
		"a newer Local must transfer the hold synchronously to its queued replan",
	);
	assert.equal(
		fixture.ytext.toJSON(),
		"ONE\nkeep\nthree\n",
		"the proven Remote cannot be replaced during the replan handoff",
	);

	await flushPlanningTurn();
	assert.equal(fixture.requestCount(), 2, "the newer Local starts a fresh plan");
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(
			"Notes/live-adoption-integration.md",
		),
		true,
		"the replacement plan retains the same path-scoped hold",
	);
	fixture.releaseFirstPlan();
	fixture.close();
}

async function transientHostSaveCannotStrandTheRequiredReplan(): Promise<void> {
	const fixture = makeFixture({
		base: "one\nkeep\nthree\n",
		local: "one\nkeep\nthree\n",
		remote: "ONE\nkeep\nthree\n",
		deferFirstPlan: true,
	});
	fixture.start();
	await Promise.resolve();
	assert.equal(fixture.requestCount(), 1);

	fixture.setHostMode("blocking-handoff");
	fixture.dispatchLocal("l");
	await flushPlanningTurn();
	assert.equal(
		fixture.requestCount(),
		1,
		"a transient host-save boundary defers the replacement plan",
	);
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(
			"Notes/live-adoption-integration.md",
		),
		true,
		"the deferred replacement remains path-scoped and fail-closed",
	);

	fixture.setHostMode("pass-through");
	await new Promise((resolve) => setTimeout(resolve, 240));
	await flushPlanningTurn();
	assert.equal(
		fixture.requestCount(),
		2,
		"a required adoption retries after the transient host boundary settles",
	);
	assert.equal(fixture.ytext.toJSON(), "ONE\nkeep\nthree\n");
	fixture.releaseFirstPlan();
	fixture.close();
}

async function compositionNeverStartsAPlan(): Promise<void> {
	const fixture = makeFixture({
		base: "기본",
		local: "한글 입력 중",
		remote: "기본",
	});
	fixture.setCompositionActive();
	fixture.start();
	await flushPlanningTurn();
	assert.equal(fixture.requestCount(), 0);
	assert.equal(fixture.ytext.toJSON(), "기본");
	assert.equal(fixture.cm.state.doc.toString(), "한글 입력 중");
	fixture.close();
}

async function partialCommitNeverRollsBack(): Promise<void> {
	const dispatchFailure = makeFixture({
		base: "one\nkeep\nthree\n",
		local: "ONE\nkeep\nthree\n",
		remote: "one\nkeep\nTHREE\n",
		failAdoptionDispatch: true,
	});
	dispatchFailure.start();
	await flushPlanningTurn();
	assert.equal(
		dispatchFailure.ytext.toJSON(),
		"ONE\nkeep\nTHREE\n",
		"Y.Text success is retained",
	);
	assert.equal(dispatchFailure.cm.state.doc.toString(), "ONE\nkeep\nthree\n");
	assert.equal(!!dispatchFailure.manager.getBinding(dispatchFailure.view), false);
	assert.ok(
		dispatchFailure.traces.some((trace) => trace.msg === "partial-adoption-commit"),
		"partial commit is explicitly traced",
	);
	dispatchFailure.close();

	const bindFailure = makeFixture({
		base: "base",
		local: "base",
		remote: "remote",
		bindRejected: true,
	});
	bindFailure.start();
	await flushPlanningTurn();
	assert.equal(bindFailure.cm.state.doc.toString(), "remote");
	assert.equal(bindFailure.ytext.toJSON(), "remote");
	assert.equal(!!bindFailure.manager.getBinding(bindFailure.view), false);
	assert.ok(
		bindFailure.traces.some((trace) => trace.msg === "partial-adoption-commit"),
		"bind failure does not inverse-project either document",
	);
	bindFailure.close();
}

async function selectionHistoryAndMinimalProjection(): Promise<void> {
	const base = "one\nkeep\nthree\n";
	const local = "ONE\nkeep\nthree\n";
	const remote = "one\nkeep\nTHREE\n";
	const fixture = makeFixture({
		base,
		local,
		remote,
		selection: local.length,
		historyStart: base,
	});
	const beforeUndoDepth = undoDepth(fixture.cm.state);
	fixture.start();
	await flushPlanningTurn();
	assert.equal(fixture.cm.state.doc.toString(), "ONE\nkeep\nTHREE\n");
	assert.equal(fixture.cm.state.selection.main.head, "ONE\nkeep\nTHREE\n".length);
	const projection = fixture.cm.dispatched.find((transaction) => transaction.docChanged);
	assert.ok(projection);
	assert.equal(projection.annotation(Transaction.addToHistory), false);
	assert.equal(projection.annotation(isolateHistory), "full");
	assert.equal(projection.changes.empty, false);
	assert.deepEqual(
		projection.changes.toJSON(),
		buildSamePathAdoptionChangeSet(local, "ONE\nkeep\nTHREE\n").toJSON(),
		"the editor receives the exact minimal ChangeSet",
	);
	assert.equal(projection.effects.length, 1, "the mapped scroll effect is retained");
	assert.equal(fixture.cm.scrollAnchor, "ONE\nkeep\nTHREE\n".length);
	assert.equal(undoDepth(fixture.cm.state), beforeUndoDepth);
	assert.equal(beforeUndoDepth, 1, "the fixture carries one native user edit");
	assert.equal(
		undo({
			state: fixture.cm.state,
			dispatch: (transaction) => fixture.cm.dispatch(transaction),
		}),
		true,
		"native undo remains available after adoption",
	);
	assert.equal(
		fixture.cm.state.doc.toString(),
		"one\nkeep\nTHREE\n",
		"undo removes only the prior Local edit and retains the adopted Remote hunk",
	);
	assert.equal(
		redo({
			state: fixture.cm.state,
			dispatch: (transaction) => fixture.cm.dispatch(transaction),
		}),
		true,
		"native redo remains available after adoption",
	);
	assert.equal(fixture.cm.state.doc.toString(), "ONE\nkeep\nTHREE\n");
	fixture.close();
}

async function conflictReceiptPublishesWithoutBinding(): Promise<void> {
	for (const status of ["preserved", "preservation-failed"] as const) {
		const fixture = makeFixture({
			base: "base",
			local: "local",
			remote: "remote",
			conflictResult: status,
		});
		fixture.start();
		await flushPlanningTurn();
		const adoption = fixture.adoptionState();
		assert.equal(adoption.kind, "conflict", status);
		if (adoption.kind !== "conflict") continue;
		assert.equal(adoption.status, status);
		assert.equal(adoption.retryable, status === "preservation-failed");
		assert.equal(
			adoption.failureReason,
			status === "preservation-failed" ? "artifact-preservation-failed" : null,
		);
		assert.equal(
			adoption.editorArtifactPath,
			"Notes/live-adoption-integration KAOS conflict - editor.md",
		);
		assert.equal(fixture.cm.state.doc.toString(), "local");
		assert.equal(fixture.ytext.toJSON(), "remote");
		assert.equal(fixture.manager.getBinding(fixture.view), null);
		assert.equal(fixture.mutationConsumed(), false);
		assert.equal(fixture.bindConsumed(), false);
		assert.equal(fixture.manager.isSamePathAdoptionProjectionHeld(adoption.path), true);
		assert.equal(
			fixture.manager.completeSamePathAdoptionDiskSettlement(
				{
					receiptId: "wrong",
					proposalId: "wrong",
					adoptionId: adoption.adoptionId,
					path: adoption.path,
					file: fixture.view.file,
					fileId: "wrong",
					ytext: fixture.ytext,
					ytextIdentity: "wrong",
					ytextMutationEpoch: -1,
					targetText: fixture.cm.state.doc.toString(),
				},
				fixture.cm.state.doc.toString(),
			),
			false,
			"a conflict cannot be cleared through the disk settlement lane",
		);

		fixture.dispatchLocal("+newer");
		await flushPlanningTurn();
		assert.equal(
			fixture.requestCount(),
			2,
			`${status}: a newer Local invalidates the receipt and schedules a retry`,
		);
		fixture.close();
	}
}

async function compositePaneConflictPublishesToEveryPane(): Promise<void> {
	const path = "Notes/composite-live-adoption.md";
	const targetFile = makeFile(path, "disk\n");
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("composite-remote");
	ytext.insert(0, "remote\n");
	const awareness = new Awareness(ydoc);
	const cmByLeaf = new Map<string, EditorView>();
	const makePane = (leafId: string, content: string) => {
		const cm = {
			state: EditorState.create({ doc: content }),
			dom: { isConnected: true },
		} as unknown as EditorView;
		const view = Object.assign(new MarkdownView(), {
			file: targetFile,
			leaf: { id: leafId },
			containerEl: { contains: (candidate: unknown) => candidate === cm.dom },
			editor: { getValue: () => cm.state.doc.toString() },
			getViewData: () => cm.state.doc.toString(),
		}) as MarkdownView & {
			file: TFile;
			leaf: { id: string };
			getViewData(): string;
		};
		cmByLeaf.set(leafId, cm);
		return { view, cm, content };
	};
	const first = makePane("composite-a", "local-a\n");
	const second = makePane("composite-b", "local-b\n");
	const panes = [first, second];
	for (const pane of panes) {
		Object.assign(pane.view, {
			app: {
				workspace: {
					iterateAllLeaves(callback: (leaf: { view: MarkdownView }) => void) {
						for (const candidate of panes) callback({ view: candidate.view });
					},
				},
			},
		});
	}
	const requests: SamePathAdoptionRequest[] = [];
	const controllerPort: Partial<EditorAuthorityControllerPort> = {
		requestSamePathAdoption(request) {
			requests.push(request);
			const editorArtifacts = Object.freeze(request.openEditorTicket.views.map((ticket) =>
				Object.freeze({
					path: `Notes/composite ${ticket.leafId} KAOS conflict - editor.md`,
					contentHash: `hash-${ticket.leafId}`,
					leafIds: Object.freeze([ticket.leafId]),
				}),
			));
			const receipt = Object.freeze({
				receiptId: "composite-conflict-receipt",
				adoptionId: request.adoptionId,
				path,
				status: "preserved" as const,
				retryable: false,
				mergeMode: "three-way" as const,
				baseHash: "composite-base",
				crdtArtifactPath: "Notes/composite KAOS conflict - crdt.md",
				editorArtifactPath: editorArtifacts[0]?.path ?? null,
				editorArtifactPaths: Object.freeze(editorArtifacts.map((entry) => entry.path)),
				editorArtifacts,
				failureReason: null,
			});
			return Promise.resolve(Object.freeze({
				kind: "conflict-preserved" as const,
				receipt,
			}));
		},
	};
	const vaultSync = {
		ydoc,
		provider: { awareness },
		getTextForPath: (candidate: string) => candidate === path ? ytext : null,
		getFileId: (candidate: string) => candidate === path ? "composite-file" : undefined,
		getFileIdForText: (candidate: Y.Text) =>
			candidate === ytext ? "composite-file" : undefined,
		isPendingRenameTarget: () => false,
		isMarkdownTombstoned: () => false,
	} as unknown as VaultSync;
	const manager = new EditorBindingManager(
		vaultSync,
		false,
		(candidate) => candidate === path,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		controllerPort as EditorAuthorityControllerPort,
	);
	(manager as unknown as { getCmView(view: MarkdownView): EditorView }).getCmView = (view) => {
		const leafId = (view.leaf as unknown as { id: string }).id;
		return cmByLeaf.get(leafId) ?? null as never;
	};
	for (const pane of panes) manager.manageView(pane.view);
	for (const pane of panes) {
		const runtime = (manager as unknown as {
			managedSessions: Map<string, { hostGuard: unknown; cmGuard: unknown }>;
		}).managedSessions.get(pane.view.leaf.id);
		assert.ok(runtime);
		runtime.hostGuard = {
			snapshot: () => ({
				leafId: pane.view.leaf.id,
				view: pane.view,
				hostCapability: "owned-scheduler-with-unload-flush",
				hostCapabilityState: "ready",
				saveEpoch: 0,
				clearLoadCapability: "observable",
				mode: { kind: "pass-through" },
				inFlight: new Map(),
				pendingTargetSave: false,
				pendingOwnedSave: null,
				sourceUnload: null,
			}),
			markInert: () => true,
			restoreIfCurrent: () => true,
		};
		runtime.cmGuard = {
			snapshot: () => ({
				view: pane.cm,
				inert: false,
				gateClosed: false,
				inputEpoch: 0,
				compositionEpoch: 0,
				nativeHistoryEpoch: 0,
				selectionEpoch: 0,
				scrollEpoch: 0,
				activeComposition: null,
				lastComposition: null,
				gateFailureReason: null,
				commitState: "none",
				pendingHostLoadCandidate: null,
			}),
			refreshGate: () => true,
			markInert: () => true,
			restoreIfCurrent: () => true,
		};
		manager.manageView(pane.view);
	}
	manager.bind(first.view, "integration-device");
	manager.bind(second.view, "integration-device");
	await flushPlanningTurn();
	assert.equal(requests.length, 1, "one canonical pane coordinates the composite conflict");
	assert.equal(requests[0]?.openEditorTicket.views.length, 2);
	assert.equal(requests[0]?.editorAuthority.kind, "blocked");
	for (const pane of panes) {
		const runtime = (manager as unknown as {
			managedSessions: Map<string, { adoption: { kind: string; editorArtifactPath?: string } }>;
		}).managedSessions.get(pane.view.leaf.id);
		assert.equal(runtime?.adoption.kind, "conflict");
		assert.equal(
			runtime?.adoption.editorArtifactPath,
			`Notes/composite ${pane.view.leaf.id} KAOS conflict - editor.md`,
		);
		assert.equal(manager.getBinding(pane.view), null);
		assert.equal(pane.cm.state.doc.toString(), pane.content);
	}
	assert.equal(ytext.toJSON(), "remote\n");
	manager.revokeAsyncAuthority();
	awareness.destroy();
	ydoc.destroy();
}

async function lifecycleRevocationClearsPendingProjectionHold(): Promise<void> {
	const fixture = makeFixture({ base: "base", local: "local", remote: "base" });
	fixture.start();
	await flushPlanningTurn();
	const receipt = fixture.boundReceipt();
	assert.ok(receipt);
	assert.equal(fixture.manager.isSamePathAdoptionProjectionHeld(receipt.path), true);
	fixture.close();
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(receipt.path),
		false,
		"teardown synchronously revokes an owned pending settlement",
	);
}

async function stalePlanningResponseSchedulesFreshAdoption(): Promise<void> {
	const fixture = makeFixture({
		base: "base",
		local: "local",
		remote: "base",
		deferFirstPlan: true,
	});
	fixture.start();
	await Promise.resolve();
	assert.equal(fixture.requestCount(), 1);
	fixture.advanceHostSaveEpoch();
	fixture.releaseFirstPlan();
	await flushPlanningTurn();
	await flushPlanningTurn();
	assert.equal(
		fixture.requestCount(),
		2,
		"a stale async response releases the old planning state and requests a fresh plan",
	);
	assert.ok(
		fixture.traces.some((trace) => trace.msg === "same-path-adoption-refreshed"),
		"stale planning authority produces an explicit refresh",
	);
	fixture.close();
}

async function diskSettlementRejectsViewAndMutationAba(): Promise<void> {
	const viewReplacement = makeFixture({ base: "base", local: "local", remote: "base" });
	viewReplacement.start();
	await flushPlanningTurn();
	const replacementReceipt = viewReplacement.boundReceipt();
	assert.ok(replacementReceipt);
	viewReplacement.replaceLiveCm({} as EditorView);
	assert.equal(
		viewReplacement.manager.isSamePathAdoptionDiskSettlementCurrent(
			replacementReceipt,
		),
		false,
		"a replacement live CodeMirror invalidates the old settlement receipt",
	);
	viewReplacement.close();

	const sameBytesMutation = makeFixture({ base: "base", local: "local", remote: "base" });
	sameBytesMutation.start();
	await flushPlanningTurn();
	const mutationReceipt = sameBytesMutation.boundReceipt();
	assert.ok(mutationReceipt);
	sameBytesMutation.bumpObservedYTextMutationRevision();
	assert.equal(sameBytesMutation.ytext.toJSON(), mutationReceipt.targetText);
	assert.equal(
		sameBytesMutation.manager.isSamePathAdoptionDiskSettlementCurrent(
			mutationReceipt,
		),
		false,
		"same-byte Y.Text ABA is rejected by its mutation epoch",
	);
	sameBytesMutation.close();
}

async function exactRenameTransfersToAGuardedReplan(): Promise<void> {
	const fixture = makeFixture({ base: "base", local: "local", remote: "base" });
	fixture.start();
	await flushPlanningTurn();
	const receipt = fixture.boundReceipt();
	assert.ok(receipt);
	const oldPath = receipt.path;
	const newPath = "Notes/live-adoption-integration-renamed.md";
	(fixture.view.file as MutableFile).path = newPath;
	fixture.manager.updatePathsAfterRename(new Map([[oldPath, newPath]]));
	assert.equal(fixture.manager.getBinding(fixture.view), null);
	assert.equal(fixture.manager.isSamePathAdoptionProjectionHeld(oldPath), false);
	assert.equal(
		fixture.manager.isSamePathAdoptionProjectionHeld(newPath),
		true,
		"an exact rename transfers dirty ownership to the renamed guarded replan",
	);
	assert.equal(fixture.cm.state.doc.toString(), "local");
	assert.equal(fixture.ytext.toJSON(), "local");
	fixture.close();
}

await cleanOutcomeMatrix();
await identicalCompositeProjectionClearsPeerReplanMarker();
await pathHeldCoordinatorBlocksPeerOrdinaryBind();
await initialMultiPaneBindingWaitsForCanonicalPane();
await alreadySettledPlanAdmitsAnExactBoundPeer();
await staleInputsMutateNothing();
await localEditDuringPlanningKeepsProjectionHeld();
await transientHostSaveCannotStrandTheRequiredReplan();
await compositionNeverStartsAPlan();
await partialCommitNeverRollsBack();
await selectionHistoryAndMinimalProjection();
await conflictReceiptPublishesWithoutBinding();
await compositePaneConflictPublishesToEveryPane();
await lifecycleRevocationClearsPendingProjectionHold();
await stalePlanningResponseSchedulesFreshAdoption();
await diskSettlementRejectsViewAndMutationAba();
await exactRenameTransfersToAGuardedReplan();

console.log("same path adoption integration: PASS");
